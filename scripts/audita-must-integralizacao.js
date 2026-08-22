/*
 * audita-must-integralizacao.js — SOMENTE LEITURA, NAO GRAVA BLOB NENHUM.
 *
 * ---- A PERGUNTA -------------------------------------------------------------------------------
 *
 * O `gen-must-intra.js` pede `Demat` com `intervalo=CincoMinutos` e agrega os tres slots do quarto
 * de hora por MEDIA. O ONS afere a ultrapassagem do MUST na demanda INTEGRALIZADA em 15 minutos.
 * As duas coisas so sao equivalentes se `Demat` a 5 min ja for a demanda MEDIA de cada 5 minutos:
 *
 *   se e media de intervalo -> media(5,5,5) = media de 15 min, EXATO (media de medias de
 *                              intervalos de igual duracao e a media do intervalo total)
 *   se e leitura INSTANTANEA -> a media de 3 pontos e uma AMOSTRAGEM, nao uma integralizacao,
 *                              e um transitorio de segundos pode inflar o quarto de hora inteiro
 *
 * O discriminante e direto: a propria API aceita `intervalo=QuinzeMinutos`. Se o que ela devolve
 * bater com a nossa media de tres, a agregacao esta certa. Se divergir, o blob esta publicando
 * amostragem no lugar de integralizacao — e as ultrapassagens marginais viram ruido.
 *
 * ---- POR QUE ISSO IMPORTA ---------------------------------------------------------------------
 *
 * As ultrapassagens medidas sao MARGINAIS: 100,02% a 101,42%. Numa faixa dessas, a diferenca entre
 * amostrar e integralizar decide se o parque estourou o contrato ou nao. Nao e questao de estilo.
 *
 * uso:  DIAS_ALVO=2026-08-03,2026-08-07,2026-08-11 node scripts/audita-must-integralizacao.js
 */
const https = require('https');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const PONTOS = {
  6380: { parque: 'M1', contrato: 49.11 }, 6381: { parque: 'M2', contrato: 24.55 },
  6382: { parque: 'M3', contrato: 49.11 }, 6383: { parque: 'M4', contrato: 49.11 },
  6384: { parque: 'M5', contrato: 49.11 }, 6385: { parque: 'M6', contrato: 49.11 },
  6386: { parque: 'M7', contrato: 14.73 }, 6387: { parque: 'M8', contrato: 49.11 },
  6388: { parque: 'M9', contrato: 9.82 },
};
const IDS = Object.keys(PONTOS);
const GRANDEZA = 'Demat';
const TOKEN = process.env.WAY2_TOKEN;
// os dias em que o blob publicou ultrapassagem; qualquer lista serve
const DIAS = (process.env.DIAS_ALVO || '2026-08-03,2026-08-07,2026-08-11').split(',');

const sleep = ms => new Promise(r => setTimeout(r, ms));
const r2 = v => Math.round(v * 1000) / 1000;

function apiGet(query, timeout = 60000) {
  return new Promise((ok, ko) => {
    const req = https.get({ ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': TOKEN }, timeout },
      res => {
        if (res.statusCode !== 200) { res.resume(); return ko(new Error('Way2 HTTP ' + res.statusCode)); }
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => { try { ok(JSON.parse(b.replace(/^﻿/, ''))); } catch (e) { ko(e); } });
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}
const query = (dia, intervalo) => 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZA
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + dia + 'T00:00:00&medicao-datafim=' + dia + 'T23:59:59'
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

async function comRetry(q, n = 4) {
  let ult;
  for (let i = 0; i < n; i++) {
    try { return await apiGet(q); } catch (e) { ult = e; await sleep(2000 * (i + 1)); }
  }
  throw ult;
}

// serie por parque: 'HH:MM' -> MW
function porParque(resp, id) {
  const s = (resp.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRANDEZA);
  const m = new Map();
  for (const v of (s ? s.valores || [] : [])) {
    if (v.valor == null) continue;
    m.set(String(v.data).slice(11, 16), v.valor / 1000);   // a API devolve kW
  }
  return m;
}

(async () => {
  if (!TOKEN) throw new Error('WAY2_TOKEN ausente');
  console.log('AUDITORIA DE INTEGRALIZACAO — Demat nos pontos de MUST, 5 min agregado x 15 min da fonte');
  console.log('dias: ' + DIAS.join(' · ') + '\n');

  let totPares = 0, totIguais = 0, maiorDif = 0, ondeMaior = '';
  const divergentes = [];

  for (const dia of DIAS) {
    const q5 = await comRetry(query(dia, 'CincoMinutos'));
    await sleep(1200);
    const q15 = await comRetry(query(dia, 'QuinzeMinutos'));
    await sleep(1200);

    for (const id of IDS) {
      const p = PONTOS[id];
      const m5 = porParque(q5, id), m15 = porParque(q15, id);
      if (!m15.size) { console.log('  ' + dia + ' ' + p.parque + ': a fonte nao devolveu 15 min'); continue; }

      for (const [hhmm, v15] of m15) {
        const hh = hhmm.slice(0, 2), mm = +hhmm.slice(3, 5);
        const tres = [0, 5, 10].map(d => hh + ':' + String(mm + d).padStart(2, '0'))
          .map(k => m5.get(k)).filter(x => x != null);
        if (tres.length !== 3) continue;          // balde incompleto sai da comparacao
        const media = tres.reduce((a, b) => a + b, 0) / 3;
        const dif = Math.abs(media - v15);
        totPares++;
        if (dif <= 0.001) totIguais++;
        if (dif > maiorDif) { maiorDif = dif; ondeMaior = dia + ' ' + hhmm + ' ' + p.parque; }
        // so guarda o que muda a CONCLUSAO: um dos dois passa de 100% e o outro nao
        const pctM = media / p.contrato * 100, pct15 = v15 / p.contrato * 100;
        if (dif > 0.01 || (pctM > 100) !== (pct15 > 100))
          divergentes.push({ dia, hhmm, parque: p.parque, tres, media, v15, dif, pctM, pct15 });
      }
    }
    console.log('  ' + dia + ' lido');
  }

  console.log('\n=== RESULTADO ===');
  console.log('  baldes comparados          : ' + totPares);
  console.log('  identicos (<= 0,001 MW)    : ' + totIguais
    + '  (' + (totIguais / totPares * 100).toFixed(2) + '%)');
  console.log('  maior diferenca            : ' + r2(maiorDif) + ' MW  em ' + ondeMaior);

  if (!divergentes.length) {
    console.log('\n  VEREDITO: a agregacao por MEDIA dos 5 min REPRODUZ a integralizacao de 15 min');
    console.log('  da propria fonte. Logo `Demat` a 5 min E a demanda media de cada 5 minutos, e o');
    console.log('  blob publica demanda INTEGRALIZADA — nao pico instantaneo. Nada a corrigir.');
  } else {
    console.log('\n  🔴 VEREDITO: DIVERGEM em ' + divergentes.length + ' baldes. A media de tres');
    console.log('  amostras NAO reproduz a integralizacao da fonte — o blob publica AMOSTRAGEM.');
    console.log('\n  dia         hora   parque   os tres de 5 min          media    15min    dif   %media  %15min');
    divergentes.sort((a, b) => b.dif - a.dif).slice(0, 30).forEach(x =>
      console.log('  ' + x.dia + ' ' + x.hhmm + '  ' + x.parque.padEnd(4)
        + ' [' + x.tres.map(v => v.toFixed(2)).join(' ') + ']  '
        + x.media.toFixed(3).padStart(8) + x.v15.toFixed(3).padStart(9)
        + x.dif.toFixed(3).padStart(7) + x.pctM.toFixed(2).padStart(8) + x.pct15.toFixed(2).padStart(8)));
    const viram = divergentes.filter(x => (x.pctM > 100) !== (x.pct15 > 100));
    console.log('\n  baldes em que a CONCLUSAO muda (um passa de 100% e o outro nao): ' + viram.length);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
