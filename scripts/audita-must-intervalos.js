/*
 * audita-must-intervalos.js — SOMENTE LEITURA. Que nomes de intervalo a API da Way2 aceita?
 *
 * A correcao do alinhamento passa a pedir cada resolucao JA INTEGRALIZADA a fonte, em vez de
 * agregar os 5 min por conta propria. Para isso e preciso saber o nome exato de cada intervalo —
 * e confirmar que o que volta e mesmo o que se pediu, contando as amostras do dia:
 *
 *      5 min -> 288 · 15 min -> 96 · 30 min -> 48 · 60 min -> 24
 *
 * Um nome que a API nao entende pode devolver 200 com OUTRA granularidade em vez de erro, e ai o
 * blob sairia com o rotulo de uma resolucao e o conteudo de outra. A contagem e o que separa.
 */
const https = require('https');
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const ID = 6380;                 // um ponto basta para descobrir o vocabulario
const GRANDEZA = 'Demat';
const TOKEN = process.env.WAY2_TOKEN;
const DIA = process.env.DIA_ALVO || '2026-08-07';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// candidatos: os tres ja usados no pipeline mais as variantes plausiveis para 30 min e 1 h
const CANDIDATOS = [
  ['CincoMinutos', 288], ['QuinzeMinutos', 96],
  ['TrintaMinutos', 48], ['MeiaHora', 48],
  ['UmaHora', 24], ['SessentaMinutos', 24], ['Hora', 24], ['UmHora', 24],
];

function apiGet(q, timeout = 45000) {
  return new Promise((ok, ko) => {
    const req = https.get({ ...API, path: API.path + '?' + q, headers: { 'Pim-Auth': TOKEN }, timeout },
      res => {
        let b = ''; res.on('data', c => b += c);
        res.on('end', () => {
          if (res.statusCode !== 200) return ko(new Error('HTTP ' + res.statusCode + ' ' + b.slice(0, 120)));
          try { ok(JSON.parse(b.replace(/^﻿/, ''))); } catch (e) { ko(e); }
        });
      });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}
const query = intervalo => 'ids=' + ID + '&grandezas=' + GRANDEZA
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + DIA + 'T00:00:00&medicao-datafim=' + DIA + 'T23:59:59'
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

(async () => {
  if (!TOKEN) throw new Error('WAY2_TOKEN ausente');
  console.log('Vocabulario de intervalo da API Way2 — ponto ' + ID + ', ' + GRANDEZA + ', ' + DIA + '\n');
  console.log('  nome                esperado  recebido  1o rotulo  ultimo rotulo   veredito');
  const bons = {};
  for (const [nome, esperado] of CANDIDATOS) {
    let j;
    try { j = await apiGet(query(nome)); }
    catch (e) { console.log('  ' + nome.padEnd(20) + String(esperado).padStart(8) + '     ERRO   ' + e.message.slice(0, 40)); await sleep(900); continue; }
    const s = (j.dados || []).find(x => String(x.pontoId) === String(ID) && x.nomeGrandeza === GRANDEZA);
    const vs = (s ? s.valores || [] : []);
    const n = vs.length;
    const t0 = n ? String(vs[0].data).slice(11, 16) : '--:--';
    const tn = n ? String(vs[n - 1].data).slice(11, 16) : '--:--';
    const ok = n === esperado;
    if (ok) bons[esperado] = nome;
    console.log('  ' + nome.padEnd(20) + String(esperado).padStart(8) + String(n).padStart(10)
      + '     ' + t0 + '      ' + tn + '        ' + (ok ? 'SERVE' : 'nao serve'));
    await sleep(900);
  }
  console.log('\n=== nomes a usar ===');
  for (const [n, nome] of Object.entries(bons))
    console.log('  ' + String(1440 / n).padStart(3) + ' min -> ' + nome);
  const faltam = [288, 96, 48, 24].filter(x => !bons[x]);
  if (faltam.length) {
    console.log('\n  🔴 SEM NOME para: ' + faltam.map(x => (1440 / x) + ' min').join(', '));
    console.log('  Nessas resolucoes a agregacao caseira continua necessaria — e ai ela tem de');
    console.log('  usar BORDA DIREITA, que e a convencao provada da fonte.');
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
