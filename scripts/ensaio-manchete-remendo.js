/*
 * ensaio-manchete-remendo.js — o remendo de 5 min move a manchete INTEIRA, e coerente.
 *
 * POR QUE EXISTE. `liq_gwh`, `atingido`, `liq_proj`, `falta_gwh` e os ritmos sao um retrato de uma
 * rodada: avancar um sozinho cria divergencia nova — o defeito que o remendo veio consertar, com o
 * sinal trocado. Este ensaio cobra que eles andem JUNTOS, e que o que nao deve andar fique parado.
 *
 * 🔴 A ASSERCAO QUE IMPORTA E A DA PROJECAO. `liq_proj` parte dos dias FECHADOS, entao a energia de
 * hoje crescendo NAO pode move-la. Se mover, o remendo esta somando o dia em curso na base da
 * projecao — e o card anunciaria o fechamento do mes subindo a cada cinco minutos.
 *
 * Roda sobre a manchete PUBLICADA, com a energia de hoje forjada: o blob da a forma real das linhas
 * (12 entidades, os campos que existem), e o forjado da o controle sobre o que muda.
 *
 * Sem segredo nenhum: le so blob publico.
 */
const zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial (BASE_DADOS de outro endereco passa direto)
const { remendaManchete, parse, fmt } = require('./lib-manchete.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

/* o gzip pelos bytes: a lib devolve o que esta gravado, sem o cabecalho content-encoding */
function getJSON(url) {
  return LD.pede(url, { 'accept-encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + url);
    const b = x.buf[0] === 0x1f && x.buf[1] === 0x8b ? zlib.gunzipSync(x.buf) : x.buf;
    return JSON.parse(b.toString('utf8'));
  });
}

const clone = o => JSON.parse(JSON.stringify(o));
const PARADOS = ['dias_decorridos', 'dias_total', 'dias_restantes', 'meta_gwh', 'lbl', 'escopo',
  'spark_liq', 'spark_meta', 'spark_n'];

(async () => {
  const exec = await getJSON(BASE + 'executivo.json');
  const mes = exec.mes_atual;
  /* A JANELA DE FIM DE MES (30/09/2026): do por do sol do ultimo dia ate o mes seguinte ganhar linha, o blob publicado tem o
     mes atual FECHADO e nenhuma linha aberta. O ensaio reprovava "nada a julgar", e como ele roda ANTES de gerar, o
     executivo parava de gerar — e o blob so ganha mes aberto quando o executivo gera: um impasse que atravessaria a
     rodada da madrugada. O que se julga aqui e a REGRA do remendo sobre a forma real das linhas; entao, nessa janela, as
     linhas do mes atual (com as ancoras que ja trazem) sao reabertas numa COPIA e o ensaio diz em que modo rodou. */
  const mesAtualFechado = (exec.manchete_ufv || []).filter(x => x.mes === mes);
  if (!(exec.manchete_ufv || []).some(x => x.mes === mes && x.fechado === 0) && mesAtualFechado.length && mesAtualFechado.every(x => x.fechado === 1)) {
    exec.manchete_ufv = exec.manchete_ufv.map(x => (x.mes === mes ? Object.assign({}, x, { fechado: 0 }) : x));
    console.log('   ⚠️ ' + mes + ' esta FECHADO no blob e nao ha mes aberto (fim de mes): as ' + mesAtualFechado.length + ' linhas dele reabertas numa copia');
  }
  const orig = (exec.manchete_ufv || []).filter(x => x.mes === mes && x.fechado === 0);
  const fechadas = (exec.manchete_ufv || []).filter(x => x.fechado === 1);
  const f = [];
  if (!orig.length) {
    console.error('REPROVADO: o blob nao tem manchete de mes em curso — nada a julgar');
    process.exit(1);
  }
  let temAncora = orig.filter(x => x.liq_fechada_gwh != null).length;
  console.log('   manchete de ' + mes + ': ' + orig.length + ' entidades · '
    + temAncora + ' com a ancora `liq_fechada_gwh`');

  /* 🔴 SEM ANCORA O ENSAIO PASSARIA JULGANDO NADA. Enquanto a rodada completa com o executivo novo
     nao publicar `liq_fechada_gwh`, todas as linhas caem no ramo "so a hora" e as asserções de
     ENERGIA — que sao o que este ensaio existe para fazer — nao rodam. Passar ali seria o "tudo
     passou" sobre zero pontos que esta casa ja pagou. Entao a ancora e FORJADA com a mesma conta
     que o executivo publica (`liq - hoje`), e o ensaio diz em que modo rodou. */
  if (temAncora === 0) {
    orig.forEach(m => {
      const liq = parse(m.liq_gwh), hoje = parse(m.hoje_gwh);
      if (liq == null || hoje == null) return;
      m.liq_fechada_gwh = (Math.round((liq - hoje) * 100) / 100).toFixed(2);
    });
    temAncora = orig.filter(x => x.liq_fechada_gwh != null).length;
    console.log('   ⚠️ nenhuma linha publicada traz a ancora ainda (o executivo novo nao rodou) —'
      + ' forjada em ' + temAncora + ', com a mesma conta que ele publica');
  }
  if (temAncora === 0) {
    console.error('REPROVADO: sem ancora nem forjavel, o caminho da ENERGIA nao seria julgado');
    process.exit(1);
  }

  // energia de hoje FORJADA: meia hora a mais que a publicada, por entidade
  const hojePub = {}, gwh = {};
  orig.forEach(m => { hojePub[m.ufv] = parse(m.hoje_gwh) || 0; gwh[m.ufv] = hojePub[m.ufv] + 0.25; });

  const linhas = clone(exec.manchete_ufv.map(m => {
    const o = orig.find(x => x.ufv === m.ufv && x.mes === m.mes);
    return o || m;   // leva a ancora forjada, quando foi o caso
  }));
  /* 🔴 O "ANTES" DO "entregou mais" E O REMENDO COM A ENERGIA DE HOJE PUBLICADA, sobre a MESMA ancora — e nao a linha
     publicada (PROMOVER executivo-vermelho, 10/10/2026). A linha publicada sai do remendo de producao, que soma os dias da
     serie (`mwhMesPorUfv`); este ensaio forja pelo caminho da ancora. Com a rodada completa parada um dia, a ancora fica um
     dia atras da serie, o forjado perde esse dia e "o que falta" SOBE contra o publicado: reprovou 9 entidades de 10/10
     04:13Z em diante, ANTES do gerador, que era o unico que trazia a ancora de volta. Dois forjados pela mesma regra so
     diferem pelos 0,25 GWh a mais: o que a assercao quer julgar. */
  const cru = clone(linhas);   // as linhas antes de qualquer remendo, para o caso forjado do 3b
  const antesRef = clone(linhas);
  remendaManchete(antesRef, { mes, diaNum: 28, ate: '14:05', gwhPorUfv: hojePub });
  const ref = {}; antesRef.forEach(m => { ref[m.ufv + '|' + m.mes] = m; });
  const c = remendaManchete(linhas, { mes, diaNum: 28, ate: '14:05', gwhPorUfv: gwh });
  console.log('   remendo: ' + c.quando + ' com a hora, ' + c.energia + ' com a energia'
    + (c.semAncora ? ', ' + c.semAncora + ' sem ancora' : ''));
  if (c.quando !== orig.length) f.push('a hora nao alcancou as ' + orig.length + ' entidades: ' + c.quando);
  /* e a guarda que faltava: o caminho da ENERGIA tem de ter sido percorrido */
  if (c.energia !== temAncora) {
    f.push('a energia entrou em ' + c.energia + ' linhas, e ' + temAncora + ' tinham ancora — '
      + 'sem isso as asserções abaixo passariam por vacuidade');
  }

  const novo = {}; linhas.forEach(m => { novo[m.ufv + '|' + m.mes] = m; });
  let nFalta = 0;   // entidades em que o "entregou mais" julgou alguma coisa (so as que ainda nao bateram a meta)
  orig.forEach(a => {
    const b = novo[a.ufv + '|' + a.mes], id = a.ufv + ' ' + a.mes;
    if (b.dia_hoje !== 28 || b.ao_vivo !== 1 || b.ao_vivo_ate !== '14:05') {
      f.push(id + ': os campos de QUANDO nao entraram');
    }
    if (a.liq_fechada_gwh == null) {   // sem ancora: SO a hora podia mudar
      const mudou = Object.keys(a).filter(k => a[k] !== b[k]
        && !['dia_hoje', 'ao_vivo', 'ao_vivo_ate'].includes(k));
      if (mudou.length) f.push(id + ': sem ancora, mas mexeu em ' + mudou);
      return;
    }
    const base = parse(a.liq_fechada_gwh), meta = parse(a.meta_gwh);
    // 1) a energia anda, e fecha com a ancora
    if (Math.abs(parse(b.hoje_gwh) - gwh[a.ufv]) > 0.011) f.push(id + ': hoje_gwh nao seguiu');
    if (Math.abs(parse(b.liq_gwh) - (base + gwh[a.ufv])) > 0.011) {
      f.push(id + ': liq_gwh nao e liq_fechada + hoje');
    }
    // 2) 🔴 a PROJECAO nao pode andar: ela parte dos dias fechados
    if (a.liq_proj !== b.liq_proj) {
      f.push(id + ': liq_proj MOVEU com a energia de hoje (' + a.liq_proj + ' -> ' + b.liq_proj
        + ') — o dia em curso entrou na base da projecao');
    }
    // 3) os derivados andam JUNTOS com a energia
    if (meta > 0) {
      // 🔴 A conta sai da ANCORA, e nao do `liq_gwh` publicado. A ancora vai com 4 casas justamente
      // para o remendo refazer a energia a partir dela; `liq_gwh` vai com 2, e recompor o percentual
      // por ele injeta um erro que ESCALA COM 1/meta — ate 0,29 pp no parque de menor contrato
      // contra 0,01 no Complexo. Nenhuma folga FIXA limita isso: 0,02 era frouxa demais em cima e
      // apertada demais embaixo, e reprovava SEIS entidades com a conta certa.
      // Medido em 15/09/2026 nas doze: pela ancora o desvio e ZERO; pelo `liq_gwh`, ate 0,1005.
      // ⚠️ A folga e de MEIO CENTAVO porque os dois lados sao arredondados a 2 casas: ou caem no
      // mesmo centavo, ou diferem por pelo menos 0,01. Ela nao admite deriva — so o ulp.
      const at = Math.round(100 * (base + gwh[a.ufv]) / meta * 100) / 100;
      if (Math.abs(parse(b.atingido) - at) > 0.005) {
        f.push(id + ': atingido nao acompanhou a energia (' + parse(b.atingido) + ' contra ' + at + ')');
      }
      const falta = meta - parse(b.liq_gwh);
      const esp = falta > 0 ? falta : 0;
      if (Math.abs(parse(b.falta_gwh) - esp) > 0.02) f.push(id + ': falta_gwh nao acompanhou');
      const r = ref[a.ufv + '|' + a.mes];
      if (falta > 0 && parse(r.falta_gwh) != null) {
        nFalta++;
        if (!(parse(b.falta_gwh) < parse(r.falta_gwh))) {
          f.push(id + ': entregou mais e o que falta nao diminuiu (' + r.falta_gwh + ' -> ' + b.falta_gwh + ')');
        }
      }
    }
    // 4) o que NAO e do dia fica parado
    PARADOS.forEach(k => {
      if (k in a && a[k] !== b[k]) f.push(id + ': ' + k + ' mudou, e nao devia');
    });
  });

  /* 3b) o "entregou mais" JULGA ALGUMA COISA em qualquer mes: ele so roda onde ainda falta energia, e num fim de mes com as
     12 entidades acima da meta julgaria zero e o ensaio diria OK (revisor-ensaio, 10/10/2026). Uma linha forjada com a
     meta 10 GWh acima do entregue passa pelos dois remendos, e o que falta tem de cair os 0,25 GWh a mais (folga de dois
     arredondamentos de 2 casas). */
  const alvoF = cru.find(m => m.mes === mes && m.fechado === 0 && m.liq_fechada_gwh != null && parse(m.liq_gwh) != null);
  if (!alvoF) f.push('nenhuma linha com ancora para o caso forjado do "entregou mais"');
  else {
    const forja = (gwhPorUfv) => {
      const L = clone(cru), m = L.find(x => x.ufv === alvoF.ufv && x.mes === mes && x.fechado === 0);
      m.meta_gwh = fmt(parse(m.liq_gwh) + 10);
      if (m.meta_mwh != null) m.meta_mwh = Math.round((parse(m.liq_gwh) + 10) * 100000) / 100;
      remendaManchete(L, { mes, diaNum: 28, ate: '14:05', gwhPorUfv });
      return parse(m.falta_gwh);
    };
    const f0 = forja(hojePub), f1 = forja(gwh);
    if (!(f0 > 0) || !(f1 < f0) || Math.abs((f0 - f1) - 0.25) > 0.011) {
      f.push(alvoF.ufv + ' forjado com a meta acima: entregou 0,25 GWh a mais e o que falta foi de ' + f0 + ' a ' + f1);
    }
  }
  console.log('   entregou mais: julgado em ' + nFalta + ' entidade(s) com falta > 0, e na linha forjada com a meta acima ('
    + (alvoF ? alvoF.ufv : '—') + ')');

  // 5) meses FECHADOS intactos
  const fech2 = {}; linhas.forEach(m => { if (m.fechado === 1) fech2[m.ufv + '|' + m.mes] = m; });
  fechadas.forEach(a => {
    const b = fech2[a.ufv + '|' + a.mes];
    if (JSON.stringify(a) !== JSON.stringify(b)) f.push(a.ufv + ' ' + a.mes + ': mes FECHADO mudou');
  });
  console.log('   meses fechados conferidos: ' + fechadas.length);

  // 6) IDEMPOTENTE: aplicar de novo, com a mesma energia, nao move mais nada
  const outra = clone(linhas);
  remendaManchete(outra, { mes, diaNum: 28, ate: '14:05', gwhPorUfv: gwh });
  if (JSON.stringify(outra) !== JSON.stringify(linhas)) {
    f.push('o remendo NAO e idempotente — rodando ~288 vezes por dia, o erro acumularia');
  }

  // 7) e ele PROVA que reprova: uma linha em que a energia nao entrou tem de acusar
  const quebrado = clone(linhas);
  const alvo = quebrado.find(m => m.mes === mes && m.fechado === 0 && m.liq_fechada_gwh != null);
  if (alvo) {
    const antes = alvo.liq_gwh;
    alvo.liq_gwh = alvo.liq_fechada_gwh;   // defeito: liq sem o dia em curso
    if (alvo.liq_gwh === antes) {
      f.push('o defeito plantado nao mudou nada — nao ha o que a guarda pegue');
    } else if (Math.abs(parse(alvo.liq_gwh) - (parse(alvo.liq_fechada_gwh) + parse(alvo.hoje_gwh))) <= 0.011) {
      f.push('a guarda de "liq = liq_fechada + hoje" NAO pega a linha quebrada');
    }
  }

  if (f.length) {
    console.error('\nREPROVADO:');
    f.slice(0, 20).forEach(x => console.error('   🔴 ' + x));
    process.exit(1);
  }
  console.log('\nOK · a hora e a energia andam juntas, a projecao fica parada, o mes fechado nao'
    + ' e tocado, e o remendo e idempotente.');
})();
