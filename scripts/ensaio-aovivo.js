/*
 * ensaio-aovivo.js — o selo "ao vivo ate" aponta para o instante MAIS RECENTE do mes.
 *
 * POR QUE EXISTE. `manchete_ufv.ao_vivo_ate` saia de `parcQq[0].ate` — o PRIMEIRO dia parcial do
 * mes. "O primeiro" so e "o mais recente" quando ha exatamente UM parcial, e esse nao e o estado
 * normal: o dia de hoje e sempre parcial, e um dia PASSADO pode ser parcial de duas maneiras —
 * voltou truncado do snapshot (e ai o gerador anula o `ate` dele de proposito) ou o remendo de
 * 5 min o deixou marcado com a hora do ultimo dado dele.
 *
 * Com dois parciais, `[0]` pega o de TRAS: ou o selo some da tela (ate nulo) ou ele publica a hora
 * de ONTEM. Os dois afirmam errado sobre o agora, e nenhum fica vermelho.
 *
 * 🔴 ELE JULGA A REGRA, NAO O BLOB DO DIA. A alternativa — conferir `ao_vivo_ate` contra a serie no
 * arquivo publicado — reprovaria o tempo todo por um defeito que NAO e este: entre duas rodadas
 * completas do executivo (p90 de 10 h entre elas) o remendo de 5 min refresca a serie e nao a
 * manchete, entao as duas sao de vintagens diferentes por construcao. Guarda amarrada ao estado do
 * mundo mede o mundo, e nao a ferramenta.
 *
 * E ele prova que REPROVA: a regra ANTIGA e exercitada nos mesmos casos e o ensaio exige que ela
 * ERRE. Se ela acertar, o caso nao esta plantado e o ensaio reprova a si mesmo.
 *
 * Sem segredo nenhum: casos forjados, mais uma conferencia opcional contra o blob publico.
 */
const https = require('https'), zlib = require('zlib');
const { instanteAoVivo, instanteAoVivoAntigo } = require('./lib-aovivo.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

function getJSON(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

const D = (dia, parcial, ate) => ({ dia, parcial, ate });

/* Cada caso diz o que o mundo tem, o que a regra deve devolver, e se a regra ANTIGA tinha de errar
   ali. `plantado: true` e o que transforma "passou" em prova — sem isso o ensaio mede a ferramenta
   contra um mundo que nao mudou. */
const CASOS = [
  { nome: 'hoje sozinho — o caso feliz, e o unico em que a regra antiga acertava',
    dias: [D('2026-09-13', 0, null), D('2026-09-14', 0, null), D('2026-09-15', 1, '09:40')],
    esp: '09:40', plantado: false },

  { nome: 'dia passado TRUNCADO antes de hoje (31/08): o `ate` dele e nulo por desenho',
    dias: [D('2026-08-29', 1, null), D('2026-08-30', 0, null), D('2026-08-31', 1, '11:25')],
    esp: '11:25', plantado: true },

  { nome: 'ontem ainda marcado pelo remendo de 5 min, com a hora dele',
    dias: [D('2026-09-14', 1, '23:50'), D('2026-09-15', 1, '09:40')],
    esp: '09:40', plantado: true },

  { nome: 'as MESMAS linhas fora de ordem — a escolha e por DATA, nao por posicao',
    dias: [D('2026-09-15', 1, '09:40'), D('2026-09-14', 1, '23:50')],
    esp: '09:40', plantado: false },

  { nome: 'mes FECHADO: nenhum parcial, e o selo nao inventa hora',
    dias: [D('2026-08-30', 0, null), D('2026-08-31', 0, null)],
    esp: null, plantado: false },

  { nome: 'so um dia truncado, sem linha de hoje: nada a publicar',
    dias: [D('2026-09-14', 1, null)],
    esp: null, plantado: false },

  { nome: 'dia encerrado (pos por do sol) continua valendo — o selo e a hora do ultimo dado',
    dias: [D('2026-09-15', 1, '17:55')],
    esp: '17:55', plantado: false },

  { nome: 'lista vazia',
    dias: [], esp: null, plantado: false },
];

(async () => {
  const f = [];
  let provaDePlantio = 0;

  CASOS.forEach((c) => {
    const novo = instanteAoVivo(c.dias);
    const velho = instanteAoVivoAntigo(c.dias);
    if (novo !== c.esp) {
      f.push('[' + c.nome + '] a regra devolveu ' + JSON.stringify(novo)
        + ', esperava ' + JSON.stringify(c.esp));
    }
    if (c.plantado) {
      if (velho === c.esp) {
        f.push('[' + c.nome + '] a regra ANTIGA tambem acerta — o defeito NAO esta plantado '
          + 'neste caso, e "passou" aqui nao mede nada');
      } else {
        provaDePlantio += 1;
      }
    }
    console.log('   ' + (novo === c.esp ? 'ok  ' : 'FALHOU ') + JSON.stringify(novo).padEnd(9)
      + (c.plantado ? '(a antiga dava ' + JSON.stringify(velho) + ') ' : '')
      + c.nome);
  });

  if (provaDePlantio < 2) {
    f.push('menos de dois casos provaram o defeito plantado (' + provaDePlantio
      + ') — o ensaio precisa VER a regra antiga errar para significar alguma coisa');
  }

  /* ---- conferencia contra o blob publico: falsificavel, e sem depender da manchete -------------
     Se o mes em curso tem linha de HOJE com `ate`, a regra tem de escolher a de hoje. Isto julga a
     regra contra a SERIE (as duas frescas), e nao contra a manchete, que e de outra vintagem. */
  try {
    const exec = await getJSON(BASE + 'executivo.json');
    const mes = exec.mes_atual;
    const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    const dias = (exec.serie_dia_ufv || [])
      .filter(x => x.ufv === 'Complexo' && String(x.dia).slice(0, 7) === mes && x.liq_mwh != null);
    const linhaHoje = dias.find(x => x.dia === hoje && x.ate);
    const esc = instanteAoVivo(dias);
    const nParc = dias.filter(x => x.parcial).length;
    console.log('\n   blob publico · ' + mes + ' · ' + dias.length + ' dias, ' + nParc
      + ' parcial(is) · a regra escolhe ' + JSON.stringify(esc)
      + (linhaHoje ? ' · hoje tem ' + linhaHoje.ate : ' · sem linha de hoje com hora'));
    if (linhaHoje && esc !== linhaHoje.ate) {
      f.push('no blob publico a regra escolheu ' + JSON.stringify(esc)
        + ' havendo linha de HOJE com ' + linhaHoje.ate);
    }
    if (nParc < 2) {
      console.log('   ⚠️ o blob tem menos de dois dias parciais agora: a conferencia ao vivo passa,'
        + ' e o caso que motivou o lote esta nos forjados.');
    }
  } catch (e) {
    console.log('\n   ⚠️ blob publico indisponivel (' + e.message + ') — so os casos forjados valem.');
  }

  if (f.length) {
    console.error('\nREPROVADO:');
    f.forEach(x => console.error('   🔴 ' + x));
    process.exit(1);
  }
  console.log('\nOK · ' + CASOS.length + ' casos, ' + provaDePlantio
    + ' deles vendo a regra antiga errar.');
})();
