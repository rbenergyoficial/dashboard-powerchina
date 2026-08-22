/*
 * audita-must-alinhamento.js — SOMENTE LEITURA. Diagnostico da divergencia entre 5 min e 15 min.
 *
 * A primeira auditoria acusou 51% de baldes divergentes com diferencas ENORMES: o 15 min do M1 as
 * 13:15 saiu MENOR que os tres valores de 5 min do mesmo balde, o que e impossivel se as duas
 * series forem a mesma grandeza no mesmo ponto. Isso e assinatura de DESALINHAMENTO, nao de
 * diferenca entre amostrar e integralizar — e concluir "o blob publica amostragem" a partir
 * daquele numero teria sido errado.
 *
 * Quatro testes, do mais barato ao mais caro:
 *   1. quantas amostras cada ponto devolveu em cada intervalo, e em que ORDEM a API respondeu
 *   2. as duas series lado a lado num trecho curto, para o olho ver
 *   3. qual DESLOCAMENTO minimiza o erro (-30 a +30 min): se o minimo nao for zero, o rotulo de
 *      tempo das duas series usa bordas diferentes
 *   4. a media do DIA INTEIRO, que e imune a alinhamento: se ela bater, as series sao a mesma
 *      grandeza no mesmo ponto e o problema e so de rotulo; se nao bater, sao coisas diferentes
 */
const https = require('https');
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const PONTOS = { 6380: 'M1', 6381: 'M2', 6382: 'M3', 6383: 'M4', 6384: 'M5',
  6385: 'M6', 6386: 'M7', 6387: 'M8', 6388: 'M9' };
const IDS = Object.keys(PONTOS);
const GRANDEZA = 'Demat';
const TOKEN = process.env.WAY2_TOKEN;
const DIA = process.env.DIA_ALVO || '2026-08-07';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function apiGet(q, timeout = 60000) {
  return new Promise((ok, ko) => {
    const req = https.get({ ...API, path: API.path + '?' + q, headers: { 'Pim-Auth': TOKEN }, timeout },
      res => {
        if (res.statusCode !== 200) { res.resume(); return ko(new Error('HTTP ' + res.statusCode)); }
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => { try { ok(JSON.parse(b.replace(/^﻿/, ''))); } catch (e) { ko(e); } });
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}

const query = intervalo => 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZA
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + DIA + 'T00:00:00&medicao-datafim=' + DIA + 'T23:59:59'
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

const serie = (resp, id) => {
  const s = (resp.dados || []).find(x => String(x.pontoId) === String(id)
    && x.nomeGrandeza === GRANDEZA);
  const m = new Map();
  for (const v of (s ? s.valores || [] : []))
    if (v.valor != null) m.set(String(v.data).slice(11, 16), v.valor / 1000);
  return m;
};
const hhmm = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');

(async () => {
  if (!TOKEN) throw new Error('WAY2_TOKEN ausente');
  const q5 = await apiGet(query('CincoMinutos'));
  await sleep(1500);
  const q15 = await apiGet(query('QuinzeMinutos'));

  console.log('DIA ' + DIA + '  ·  grandeza ' + GRANDEZA + '\n');

  console.log('=== 1 · amostras por ponto, e a ordem em que a API respondeu ===');
  for (const id of IDS) {
    const a = serie(q5, id), b = serie(q15, id);
    console.log('  ponto ' + id + ' (' + PONTOS[id] + '): 5min=' + String(a.size).padStart(4)
      + ' · 15min=' + String(b.size).padStart(4)
      + (a.size === 288 && b.size === 96 ? '' : '   <- contagem fora do esperado (288 e 96)'));
  }
  console.log('\n  ordem na resposta de  5min: '
    + (q5.dados || []).map(x => x.pontoId).join(','));
  console.log('  ordem na resposta de 15min: '
    + (q15.dados || []).map(x => x.pontoId).join(','));
  const g5 = [...new Set((q5.dados || []).map(x => x.nomeGrandeza))].join(',');
  const g15 = [...new Set((q15.dados || []).map(x => x.nomeGrandeza))].join(',');
  console.log('  grandezas devolvidas: 5min=[' + g5 + ']  15min=[' + g15 + ']');

  const ID = 6380;
  const a = serie(q5, ID), b = serie(q15, ID);
  console.log('\n=== 2 · M1 (ponto ' + ID + ') das 12h as 14h, lado a lado ===');
  console.log('  balde   os tres de 5 min          media    15min da fonte');
  for (let h = 12; h < 14; h++) for (const m of [0, 15, 30, 45]) {
    const k = hhmm(h * 60 + m);
    const tres = [0, 5, 10].map(d => hhmm(h * 60 + m + d)).map(x => a.get(x));
    const med = tres.every(v => v != null) ? tres.reduce((s, v) => s + v, 0) / 3 : null;
    console.log('  ' + k + '   [' + tres.map(v => v == null ? '  ----' : v.toFixed(2).padStart(6)).join(' ')
      + ']  ' + (med == null ? '   ----' : med.toFixed(3).padStart(7))
      + '        ' + (b.has(k) ? b.get(k).toFixed(3).padStart(7) : '   ----'));
  }

  console.log('\n=== 3 · qual deslocamento minimiza o erro? ===');
  let melhor = null;
  for (let d = -2; d <= 2; d++) {
    let soma = 0, n = 0;
    for (const [k, v15] of b) {
      const base = (+k.slice(0, 2)) * 60 + (+k.slice(3, 5)) + d * 15;
      if (base < 0 || base + 10 >= 1440) continue;
      const tres = [0, 5, 10].map(x => a.get(hhmm(base + x)));
      if (!tres.every(v => v != null)) continue;
      soma += Math.abs(tres.reduce((s, v) => s + v, 0) / 3 - v15); n++;
    }
    if (!n) continue;
    const err = soma / n;
    if (!melhor || err < melhor.err) melhor = { d, err };
    console.log('  ' + String(d * 15).padStart(4) + ' min: erro medio ' + err.toFixed(4)
      + ' MW  (n=' + n + ')' + (d === 0 ? '   <- o que o gerador usa' : ''));
  }
  if (melhor) console.log('  MELHOR: ' + melhor.d * 15 + ' min, erro ' + melhor.err.toFixed(4) + ' MW');

  console.log('\n=== 4 · media do DIA INTEIRO — imune a alinhamento ===');
  console.log('  parque   media 5min   media 15min        dif');
  for (const id of IDS) {
    const x = [...serie(q5, id).values()], y = [...serie(q15, id).values()];
    if (!x.length || !y.length) continue;
    const mx = x.reduce((s, v) => s + v, 0) / x.length;
    const my = y.reduce((s, v) => s + v, 0) / y.length;
    console.log('  ' + PONTOS[id].padEnd(8) + mx.toFixed(3).padStart(9) + my.toFixed(3).padStart(13)
      + (mx - my).toFixed(3).padStart(11));
  }
  console.log('\n  Se a dif do dia inteiro for ~0, as duas series sao a MESMA grandeza no MESMO');
  console.log('  ponto, e a divergencia balde a balde e so de ROTULO DE TEMPO. Se nao for, sao');
  console.log('  coisas diferentes e a comparacao anterior nao provava nada sobre integralizacao.');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
