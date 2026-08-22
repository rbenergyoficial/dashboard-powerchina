/*
 * audita-must-ultrapassagens.js — SOMENTE LEITURA. Quais ultrapassagens sobrevivem ao alinhamento
 * correto do quarto de hora?
 *
 * ---- O QUE JA FICOU PROVADO -------------------------------------------------------------------
 *
 * 1. O gerador agrega por MEDIA, nao por maximo — a integralizacao em si esta certa.
 * 2. A media do DIA INTEIRO bate exatamente entre a serie de 5 min e a de 15 min da fonte (dif
 *    0,000 MW nos nove parques): sao a MESMA grandeza no MESMO ponto.
 * 3. 🔴 O ROTULO DE TEMPO DA WAY2 E BORDA DIREITA. Medido com precisao de 0,003 MW: o valor de
 *    15 min rotulado T e a media dos valores de 5 min rotulados T-10, T-5 e T. Ou seja, o balde
 *    TERMINA no rotulo.
 *
 * O `gen-must-intra.js` agrega por borda ESQUERDA (balde T = valores T, T+5, T+10), entao o quarto
 * de hora que ele publica esta DESLOCADO 5 MINUTOS do que a fonte — e o ONS — considera.
 *
 * ---- POR QUE ISSO DECIDE A LEITURA ------------------------------------------------------------
 *
 * As ultrapassagens medidas sao marginais (100,02% a 101,42%). Uma janela deslocada de 5 min pega
 * um slot a mais da rampa e um a menos do vale, ou o contrario. Numa faixa dessas isso inverte a
 * conclusao — e a conclusao aqui e contratual.
 *
 * Este job lista as ultrapassagens nas duas convencoes e diz quais sao artefato de alinhamento.
 *
 * uso:  DIAS_ALVO=2026-06-13,2026-06-16,2026-08-03,2026-08-07,2026-08-11 node ...
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
const DIAS = (process.env.DIAS_ALVO
  || '2026-06-13,2026-06-16,2026-08-03,2026-08-07,2026-08-11').split(',');
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
const query = (dia, intervalo) => 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZA
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + dia + 'T00:00:00&medicao-datafim=' + dia + 'T23:59:59'
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
async function comRetry(q, n = 4) {
  let u; for (let i = 0; i < n; i++) { try { return await apiGet(q); } catch (e) { u = e; await sleep(2000 * (i + 1)); } }
  throw u;
}
const serie = (resp, id) => {
  const s = (resp.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRANDEZA);
  const m = new Map();
  for (const v of (s ? s.valores || [] : []))
    if (v.valor != null) m.set(String(v.data).slice(11, 16), v.valor / 1000);
  return m;
};
const hhmm = t => String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0');

(async () => {
  if (!TOKEN) throw new Error('WAY2_TOKEN ausente');
  console.log('ULTRAPASSAGENS DO MUST — convencao do gerador (borda esquerda) x quarto de hora da fonte');
  console.log('dias: ' + DIAS.join(' · ') + '\n');

  const publicadas = [], oficiais = [];
  for (const dia of DIAS) {
    const q5 = await comRetry(query(dia, 'CincoMinutos'));
    await sleep(1200);
    const q15 = await comRetry(query(dia, 'QuinzeMinutos'));
    await sleep(1200);

    for (const id of IDS) {
      const p = PONTOS[id];
      const a = serie(q5, id), b = serie(q15, id);

      // (A) o que o gerador publica hoje: balde de borda ESQUERDA
      for (let t = 0; t + 10 < 1440; t += 15) {
        const tres = [0, 5, 10].map(d => a.get(hhmm(t + d)));
        if (!tres.every(v => v != null)) continue;
        const mw = tres.reduce((s, v) => s + v, 0) / 3;
        const pct = mw / p.contrato * 100;
        if (pct > 100) publicadas.push({ dia, hora: hhmm(t), parque: p.parque, mw, pct });
      }
      // (B) o quarto de hora que a FONTE calcula, que e o do ONS
      for (const [k, mw] of b) {
        const pct = mw / p.contrato * 100;
        if (pct > 100) oficiais.push({ dia, hora: k, parque: p.parque, mw, pct });
      }
    }
    console.log('  ' + dia + ' lido');
  }

  const chave = x => x.dia + ' ' + x.parque;
  const setPub = new Set(publicadas.map(chave)), setOfi = new Set(oficiais.map(chave));

  console.log('\n=== (A) o que o painel mostra hoje — balde de borda esquerda ===');
  publicadas.sort((x, y) => y.pct - x.pct).forEach(x => console.log('  ' + x.dia + ' ' + x.hora
    + '  ' + x.parque.padEnd(4) + x.mw.toFixed(2).padStart(7) + ' MW  ' + x.pct.toFixed(2) + '%'));
  if (!publicadas.length) console.log('  (nenhuma)');

  console.log('\n=== (B) o quarto de hora da FONTE — a base que o ONS afere ===');
  oficiais.sort((x, y) => y.pct - x.pct).forEach(x => console.log('  ' + x.dia + ' ' + x.hora
    + '  ' + x.parque.padEnd(4) + x.mw.toFixed(2).padStart(7) + ' MW  ' + x.pct.toFixed(2) + '%'));
  if (!oficiais.length) console.log('  (nenhuma)');

  console.log('\n=== VEREDITO ===');
  console.log('  intervalos acima de 100% pelo balde do gerador : ' + publicadas.length);
  console.log('  intervalos acima de 100% pelo quarto de hora   : ' + oficiais.length);
  const soPub = [...setPub].filter(k => !setOfi.has(k));
  const soOfi = [...setOfi].filter(k => !setPub.has(k));
  console.log('\n  dia-parque que o painel acusa e a fonte NAO confirma (FALSO POSITIVO):');
  console.log(soPub.length ? soPub.map(k => '    ' + k).join('\n') : '    nenhum');
  console.log('\n  dia-parque que a fonte acusa e o painel NAO mostra (FALSO NEGATIVO):');
  console.log(soOfi.length ? soOfi.map(k => '    ' + k).join('\n') : '    nenhum');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
