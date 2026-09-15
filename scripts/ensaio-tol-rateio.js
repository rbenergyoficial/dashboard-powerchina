/*
 * ensaio-tol-rateio.js — a tolerancia do par MWh x GWh no RATEIO: larga o bastante para o
 * arredondamento, apertada o bastante para ainda pegar defeito.
 *
 * POR QUE EXISTE. Afrouxar tolerancia e o jeito mais facil de apagar um alarme e chamar isso de
 * conserto. Este ensaio existe para que a folga nova tenha de PROVAR que continua reprovando o que
 * a guarda existe para achar — e que ela nao reprova o que so e arredondamento.
 *
 * DOIS LADOS:
 *   POSITIVA · sobre o blob publicado, a meta de cada entidade rateada em TODOS os dias possiveis
 *              do mes (1..dias_do_mes): zero reprovacoes. E a varredura que motivou a derivacao —
 *              com 0,006 ela reprovava em 4 dias nas cinco usinas de meta igual.
 *   NEGATIVA · quatro defeitos plantados sobre os MESMOS pares, cada um com a marca do erro que a
 *              guarda existe para pegar. Cada plantio prova a si mesmo antes de ser cobrado.
 *
 * Sem segredo nenhum: le so blob publico.
 */
const https = require('https'), zlib = require('zlib');
const { fatorRateio, tolRateio } = require('./lib-tol-unidade.js');
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

const r2 = v => Math.round(v * 100) / 100;
/* a guarda, como ela vive no gerador — uma escrita so, aqui e la */
const passa = (ratMwh, ratGwh, f) =>
  ratMwh != null && Math.abs(ratMwh / 1000 - ratGwh) <= tolRateio(f);

(async () => {
  /* ⚠️ O ENSAIO NAO PODE DEPENDER DO BLOB PARA EXISTIR. Ler a meta publicada e o que torna a
     varredura real; mas se o blob ainda nao a tiver (a primeira rodada de um mes novo, por
     exemplo), parar aqui travaria justamente a rodada que preencheria o dado. Entao ele cai num
     par FORJADO — o de M3 em set/26, o que motivou o lote, onde as duas bases diferem em 4,48 MWh —
     e diz em que modo rodou. Guarda amarrada ao estado do mundo mede o mundo, nao a ferramenta. */
  const FORJADO = [{ ufv: 'M3 (forjado)', meta_gwh: 6.55, meta_mwh: 6545.52,
    parcial: 1, dias_corridos: 15, dias_do_mes: 30 }];
  let base = [], mes = '—';
  try {
    const exec = await getJSON(BASE + 'executivo.json');
    mes = exec.mes_atual;
    base = (exec.serie_ufv || []).filter(x => x.mes === mes
      && x.meta_gwh != null && x.meta_mwh != null);
  } catch (e) {
    console.log('   ⚠️ blob indisponivel (' + e.message + ')');
  }
  if (base.length < 10) {
    console.log('   ⚠️ o blob ofereceu ' + base.length + ' entidades com meta em ' + mes
      + ' — varrendo o par FORJADO, que e onde o defeito foi medido');
    base = FORJADO;
  }
  const nDias = Number(base[0].dias_do_mes) || 30;
  const f = [];

  // ---- POSITIVA: todo dia do mes, toda entidade -------------------------------------------------
  let pior = { razao: 0 }, n = 0;
  base.forEach(x => {
    const g = Number(x.meta_gwh), m = Number(x.meta_mwh);
    for (let k = 1; k <= nDias; k++) {
      const fa = k / nDias, rg = r2(g * fa), rm = r2(m * fa);
      const dif = Math.abs(rm / 1000 - rg), tol = tolRateio(fa);
      n += 1;
      if (dif > tol) f.push(x.ufv + ' dia ' + k + ': dif ' + dif.toFixed(5) + ' > tol ' + tol.toFixed(5));
      if (dif / tol > pior.razao) pior = { razao: dif / tol, ufv: x.ufv, k, dif, tol };
    }
  });
  console.log('   POSITIVA · ' + n + ' pares (' + base.length + ' entidades x ' + nDias + ' dias)'
    + ' · pior caso ' + pior.ufv + ' dia ' + pior.k + ': ' + pior.dif.toFixed(5)
    + ' contra ' + pior.tol.toFixed(5) + ' (' + (pior.razao * 100).toFixed(0) + '% do limite)');
  /* ⚠️ A RAZAO E INFORMATIVA, e NAO um criterio. A primeira escrita deste ensaio reprovava acima de
     98% do limite — um numero que eu escolhi, calibrado em nada, e que congelaria o executivo no mes
     em que a razao subisse. Seria a mesma classe de defeito que este lote esta consertando.
     O limite e DERIVADO da definicao do arredondamento: nenhum dado futuro pode passar dele, e
     ficar perto e o que se espera de um limite justo — a 97% ele esta apertado, nao frouxo.
     O unico criterio de reprovacao aqui e `dif > tol`. */
  if (pior.razao > 1) {
    f.push('o pior caso passou do limite derivado — a cadeia de arredondamento nao e a que a '
      + 'lib descreve, e e a DERIVACAO que precisa ser refeita, nao o numero afrouxado');
  }

  // ---- NEGATIVA: o que a guarda TEM de continuar pegando -----------------------------------------
  const alvo = base.find(x => x.parcial) || base[0];
  const g = Number(alvo.meta_gwh), m = Number(alvo.meta_mwh);
  const fa = fatorRateio(alvo), rgOk = r2(g * fa), rmOk = r2(m * fa);
  if (!passa(rmOk, rgOk, fa)) {
    f.push('o par SADIO de ' + alvo.ufv + ' ja reprova — o ensaio nao pode julgar plantio nenhum');
  }
  const PLANTIOS = [
    { nome: 'fator de UM DIA errado no lado MWh', mwh: r2(m * ((fa * nDias + 1) / nDias)) },
    { nome: 'campo ausente (null)', mwh: null },
    { nome: 'escorregao de unidade (o MWh vindo em GWh)', mwh: r2(g * fa) },
    { nome: 'meia hora de geracao a mais (20 MWh)', mwh: r2(m * fa) + 20 },
  ];
  PLANTIOS.forEach(p => {
    if (p.mwh != null && Math.abs(p.mwh - rmOk) < 1e-9) {
      f.push('[' + p.nome + '] o plantio nao mudou nada — nao ha defeito plantado, e cobrar '
        + 'reprovacao aqui mediria a ferramenta contra um mundo que nao mudou');
      return;
    }
    const reprovou = !passa(p.mwh, rgOk, fa);
    console.log('   NEGATIVA · ' + (reprovou ? 'pegou   ' : 'PASSOU  ')
      + String(p.mwh).padEnd(10) + p.nome);
    if (!reprovou) f.push('[' + p.nome + '] a guarda NAO pegou — a tolerancia ficou frouxa demais');
  });

  if (f.length) {
    console.error('\nREPROVADO:');
    f.forEach(x => console.error('   🔴 ' + x));
    process.exit(1);
  }
  console.log('\nOK · a folga cobre o arredondamento em ' + n + ' pares e ainda pega os '
    + PLANTIOS.length + ' defeitos plantados.');
})();
