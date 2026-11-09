/*
 * faxina-cache.js — apaga do cache do Actions as entradas SUPERADAS (lote faxina-cache, 09/11/2026).
 *
 * 💰 POR QUE. O cache do repositório tem teto de 10 GB; acima disso o GitHub despeja entradas, e as cópias que poupam saída de dados
 * do storage (way2-agg, trafo-medidor, executivo) somem. Em 09/11 havia 10,69 GB em 117 entradas, quase tudo entrada que ninguém
 * mais restaura: o restore-keys pega sempre a MAIS NOVA de cada família, e cada execução que muda a cópia grava uma entrada nova
 * (o sungrow-scada, ~180 MB por execução). A faxina manual de 09/11 (OK do humano) baixou para 2,72 GB.
 *
 * REGRA. Família = a chave sem o último segmento (`<familia>-<hash ou run_id>`), por ref. Fica a mais nova (created_at) de cada
 * família; sai o resto, desde que não tenha sido usado nas últimas 2 h (uma execução em curso pode estar no meio do restore).
 * Cache é cópia regenerável: o pior caso de apagar demais é uma execução baixar de novo.
 *   plano(lista, agoraMs) -> { fica, sai }        (puro, ensaiado)
 *   node scripts/faxina-cache.js [--seco]          (GITHUB_TOKEN com actions: write, GITHUB_REPOSITORY)
 */
'use strict';
const https = require('https');

const FOLGA_MS = 2 * 3600e3;
const familia = (c) => String(c.key).replace(/-[^-]*$/, '') + ' @ ' + c.ref;

function plano(lista, agoraMs) {
  const fam = new Map();
  for (const c of lista) { const k = familia(c); if (!fam.has(k)) fam.set(k, []); fam.get(k).push(c); }
  const fica = [], sai = [];
  for (const cs of fam.values()) {
    cs.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    fica.push(cs[0]);
    for (const c of cs.slice(1)) (agoraMs - Date.parse(c.last_accessed_at) > FOLGA_MS ? sai : fica).push(c);
  }
  return { fica, sai };
}

function api(metodo, caminho) {
  return new Promise((ok, erro) => {
    const req = https.request({ hostname: 'api.github.com', path: '/repos/' + process.env.GITHUB_REPOSITORY + caminho, method: metodo, timeout: 60000,
      headers: { Authorization: 'Bearer ' + process.env.GITHUB_TOKEN, Accept: 'application/vnd.github+json', 'User-Agent': 'faxina-cache' } }, (r) => {
      const p = []; r.on('data', (c) => p.push(c));
      r.on('end', () => { const t = Buffer.concat(p).toString('utf8'); if (r.statusCode >= 300) erro(new Error('HTTP ' + r.statusCode + ' ' + caminho + ': ' + t.slice(0, 160))); else ok(t ? JSON.parse(t) : null); });
    });
    req.on('error', erro); req.on('timeout', () => req.destroy(new Error('timeout'))); req.end();
  });
}

async function main() {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPOSITORY) throw new Error('faltam GITHUB_TOKEN e GITHUB_REPOSITORY');
  const lista = [];
  for (let p = 1; p <= 20; p++) {
    const r = await api('GET', '/actions/caches?per_page=100&page=' + p);
    lista.push(...r.actions_caches);
    if (r.actions_caches.length < 100) break;
  }
  const { fica, sai } = plano(lista, Date.now());
  const gb = (xs) => (xs.reduce((a, c) => a + c.size_in_bytes, 0) / 1e9).toFixed(2);
  console.log(`cache: ${lista.length} entradas, ${gb(lista)} GB · ficam ${fica.length} (${gb(fica)} GB) · saem ${sai.length} (${gb(sai)} GB)`);
  if (process.argv.includes('--seco')) return;
  let n = 0;
  for (const c of sai) {
    try { await api('DELETE', '/actions/caches/' + c.id); n++; } catch (e) { console.log('::warning::nao apaguei ' + c.key + ': ' + e.message); }
  }
  console.log(`apagadas ${n} de ${sai.length}`);
}

if (require.main === module) main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
module.exports = { plano, familia, FOLGA_MS };
