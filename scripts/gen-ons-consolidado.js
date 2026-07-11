/*
 * gen-ons-consolidado.js — junta os arquivos mensais do ONS num único _all.json (histórico completo).
 *
 * Lê ons_restricao_YYYY_MM.json e ons_irradiancia_YYYY_MM.json (blob público, sem chave)
 * de Set/2025 até o mês atual, concatena os `consolidado`, deduplica, ordena, e grava:
 *   - dados/ons_restricao_all.json    (1 linha por ts; campos ts,ger,lim,disp,gref,razao,orig,dsc)
 *   - dados/ons_irradiancia_all.json  (1 linha por ts+u; enxugado: ts,u,irr,ge,gv)
 *
 * Uso no GitHub Actions: env DADOS_STORAGE (connection string) grava no blob.
 * Teste local: env LOCAL_OUT_DIR=<pasta> grava os arquivos localmente em vez do blob.
 */
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const START_Y = 2025, START_M = 9; // Set/2025 = entrada em operação

function months() {
  const now = new Date();
  const ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1;
  const out = [];
  let y = START_Y, m = START_M;
  while (y < ny || (y === ny && m <= nm)) {
    out.push(y + '_' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function fetchJson(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  let t = await r.text();
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

function num(v) { const n = +v; return isNaN(n) ? 0 : n; }

async function upload(name, json) {
  if (process.env.LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(process.env.LOCAL_OUT_DIR, name), json);
    return;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE não definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  const bc = cont.getBlockBlobClient(name);
  await bc.upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

// Consolida uma fonte. slim = função opcional que enxuga/normaliza cada linha.
async function consolidate({ prefix, out, dedup, slim, sortKey }) {
  const rows = [], seen = new Set(), okMonths = [];
  for (const ym of months()) {
    const d = await fetchJson(BASE + prefix + ym + '.json');
    if (!d || !Array.isArray(d.consolidado)) continue;
    okMonths.push(ym);
    for (const r of d.consolidado) {
      const k = dedup(r);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(slim ? slim(r) : r);
    }
  }
  if (!rows.length) { console.warn(out, '— nenhum dado, pulado.'); return; }
  rows.sort(sortKey);
  const obj = {
    fonte: prefix.replace(/_$/, ''),
    periodo: okMonths[0] + ' a ' + okMonths[okMonths.length - 1],
    consolidado: rows
  };
  const json = JSON.stringify(obj);
  await upload(out, json);
  console.log(`${out}: ${rows.length} linhas, ${okMonths.length} meses (${okMonths[0]}..${okMonths[okMonths.length - 1]}), ${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB`);
}

(async () => {
  // Restrição: 1 linha por ts (nível complexo)
  await consolidate({
    prefix: 'ons_restricao_',
    out: 'ons_restricao_all.json',
    dedup: r => r.ts,
    sortKey: (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
  });
  // Irradiância: 1 linha por ts+u (por UFV); enxuga (tira inv, arredonda) p/ reduzir tamanho
  await consolidate({
    prefix: 'ons_irradiancia_',
    out: 'ons_irradiancia_all.json',
    dedup: r => r.ts + '|' + r.u,
    slim: r => ({ ts: r.ts, u: r.u, irr: Math.round(num(r.irr)), ge: +num(r.ge).toFixed(3), gv: +num(r.gv).toFixed(3) }),
    sortKey: (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.u < b.u ? -1 : a.u > b.u ? 1 : 0))
  });
})().catch(e => { console.error(e); process.exit(1); });
