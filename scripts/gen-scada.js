/*
 * gen-scada.js — transforma as planilhas cruas do SCADA (PowerChina) em scada_comparativo.json
 *
 * Fluxo: SharePoint PWC --(Power Automate)--> Azure Blob container "scada-raw" (M1.xlsx..M09.xlsx)
 *        --(este script no GitHub Actions, cron diario)--> Azure Blob dados/scada_comparativo.json
 *
 * Cada planilha = 1 parque (M1..M9), aba "Interpolacao":
 *   col 0 = DataHora ; colunas <CUBx_y>_LD0_CVMMXN1_Watt = potencia ativa por circuito (MW)
 * Energia por amostra de 5min = P(MW) * 5/60 (MWh). Agrega em slots de 15min (96/dia) e no diario.
 *
 * Idempotente: carrega o JSON existente no blob e faz merge por (parque, dia) — reprocessar nao duplica.
 *
 * Env:
 *   DADOS_STORAGE  = connection string da storage (Secret) — obrigatorio no modo blob
 *   RAW_CONTAINER  = container das planilhas cruas (default: scada-raw)
 *   OUT_CONTAINER  = container de saida (default: dados)
 *   OUT_BLOB       = nome do blob de saida (default: scada_comparativo.json)
 *   LOCAL_DIR      = (teste) pasta local com os .xlsx; se setado, ignora o blob de entrada
 *   LOCAL_OUT      = (teste) grava o JSON nesse caminho local em vez do blob
 */
const XLSX = require('xlsx');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'scada_comparativo.json';

function parkFromName(fn) {
  const base = String(fn).split(/[\\/]/).pop();     // ignora caminho 2026/007.jul_26/01/ -> M03.xlsx
  const m = base.match(/M0*(\d+)/i);
  return m ? 'M' + parseInt(m[1], 10) : null;
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }

// Extrai {diario:{dia:MWh}, intra15:{dia:[96]}} de uma planilha (buffer) de um parque.
function parseParkBuffer(buf) {
  const wb = XLSX.read(buf, { cellDates: true });
  const sn = wb.SheetNames.find(n => /interpola/i.test(n)) || wb.SheetNames[wb.SheetNames.length - 1];
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (!rows.length) return { diario: {}, intra15: {} };
  const hdr = rows[0];
  const wattCols = [];
  for (let i = 0; i < hdr.length; i++) if (hdr[i] && /CVMMXN1_Wa/i.test(String(hdr[i]))) wattCols.push(i);
  const diario = {}, intra15 = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    let t = row[0];
    if (!(t instanceof Date) || isNaN(t)) continue;
    // timestamps vem com fracao de segundo (ex.: 11:44:59.998 = 11:45); arredonda p/ minuto antes de bucketizar
    t = new Date(Math.round(t.getTime() / 60000) * 60000);
    let P = 0;
    for (const c of wattCols) { const v = row[c]; if (v !== '' && v != null && !isNaN(+v)) P += +v; }
    const e = P * 5 / 60; // MWh nesta amostra de 5min
    const day = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
    const idx = Math.floor((t.getHours() * 60 + t.getMinutes()) / 15);
    if (idx < 0 || idx > 95) continue;
    if (!intra15[day]) intra15[day] = new Array(96).fill(0);
    intra15[day][idx] += e;
    diario[day] = (diario[day] || 0) + e;
  }
  return { diario, intra15 };
}

// ---- IO helpers (blob) ----
async function getBlobClient() {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  return BlobServiceClient.fromConnectionString(conn);
}
async function streamToBuffer(readable) {
  const chunks = [];
  for await (const ch of readable) chunks.push(ch instanceof Buffer ? ch : Buffer.from(ch));
  return Buffer.concat(chunks);
}

async function loadRawBuffers() {
  // Modo teste local
  if (process.env.LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    const dir = process.env.LOCAL_DIR;
    const files = fs.readdirSync(dir).filter(f => /\.xlsx$/i.test(f) && !/^~/.test(f));
    return files.map(f => ({ name: f, buf: fs.readFileSync(path.join(dir, f)) }));
  }
  const svc = await getBlobClient();
  const cont = svc.getContainerClient(RAW_CONTAINER);
  const out = [];
  for await (const b of cont.listBlobsFlat()) {
    if (!/\.xlsx$/i.test(b.name)) continue;
    const buf = await streamToBuffer((await cont.getBlobClient(b.name).download()).readableStreamBody);
    out.push({ name: b.name, buf });
  }
  return out;
}

async function loadExistingOut() {
  if (process.env.LOCAL_OUT) {
    const fs = require('fs');
    if (fs.existsSync(process.env.LOCAL_OUT)) {
      try { let t = fs.readFileSync(process.env.LOCAL_OUT, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return JSON.parse(t); } catch (e) {}
    }
    return { diario: {}, intra15: {} };
  }
  try {
    const svc = await getBlobClient();
    const bc = svc.getContainerClient(OUT_CONTAINER).getBlobClient(OUT_BLOB);
    if (!(await bc.exists())) return { diario: {}, intra15: {} };
    let t = (await streamToBuffer((await bc.download()).readableStreamBody)).toString('utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch (e) { return { diario: {}, intra15: {} }; }
}

async function writeOut(obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return; }
  const svc = await getBlobClient();
  const cont = svc.getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  const bc = cont.getBlockBlobClient(OUT_BLOB);
  await bc.upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

(async () => {
  const raws = await loadRawBuffers();
  if (!raws.length) { console.error('Nenhuma planilha .xlsx encontrada'); process.exit(1); }
  const out = await loadExistingOut();
  if (!out.diario) out.diario = {};
  if (!out.intra15) out.intra15 = {};
  let parks = 0, days = new Set();
  for (const { name, buf } of raws) {
    const pk = parkFromName(name);
    if (!pk) { console.warn('Ignorado (sem parque):', name); continue; }
    const { diario, intra15 } = parseParkBuffer(buf);
    if (!out.diario[pk]) out.diario[pk] = {};
    for (const d in diario) { out.diario[pk][d] = +diario[d].toFixed(2); days.add(d); }
    for (const d in intra15) {
      if (!out.intra15[d]) out.intra15[d] = {};
      out.intra15[d][pk] = intra15[d].map(v => +v.toFixed(3));
    }
    parks++;
    console.log('OK', name, '->', pk, '| dias:', Object.keys(diario).length);
  }
  await writeOut(out);
  console.log(`Gravado ${OUT_BLOB}: ${parks} parques, ${days.size} dias novos/atualizados, ${Object.keys(out.intra15).length} dias no total.`);
})().catch(e => { console.error(e); process.exit(1); });
