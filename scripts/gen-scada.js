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

// O complexo tem 9 parques (M1..M9). "M10" e apelido do M1 (mesma usina, Mauriti-1) em
// algumas fontes do SCADA — nao e um 10o parque. Arquivo M10 e remapeado para M1, mas
// SO preenche dias que faltam (nao sobrescreve), pra proteger o baseline manual validado
// (set-fev/mar-jun batem com o ONS). Qualquer parque fora de M1..M9 (apos remap) e ignorado.
const CANON = new Set(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']);

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
  // SEM COLUNA CASADA = NAO SEI, e nao "gerou zero". Antes o laco abaixo somava P=0 em toda linha
  // e gravava 0 MWh no dia — silenciosamente. Foi assim que set/25..jun/26 entrou zerado no blob:
  // as planilhas CHEGARAM e foram lidas, mas com cabecalho diferente do esperado. Zero por falha de
  // parsing e indistinguivel de usina parada, e contamina qualquer media feita por cima.
  // Tambem protege contra planilha de outra grandeza (ex.: potencia reativa) entrar como ativa.
  if (!wattCols.length) {
    const amostra = hdr.filter(Boolean).slice(0, 6).map(String).join(' | ');
    throw new Error('nenhuma coluna de potencia ativa (CVMMXN1_Wa) na aba "' + sn
      + '". Cabecalho encontrado: ' + (amostra || '(vazio)'));
  }
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
  if (!raws.length) { console.log('Nenhuma planilha .xlsx em "' + RAW_CONTAINER + '" — nada a processar (ok).'); return; }
  const out = await loadExistingOut();
  if (!out.diario) out.diario = {};
  if (!out.intra15) out.intra15 = {};
  // Guarda anti-parcial: operadores sobem só o dia ANTERIOR (D-1) até 08:00. Um arquivo de HOJE
  // (ou futuro) é sempre parcial/em-progresso e pode vir corrompido (ex.: M5 07/13 = 775 MWh,
  // 3,5x um dia real) — nunca entra no diário/intra15. Também purga dias >= hoje que já tenham
  // vazado pro blob em runs anteriores (auto-cura). Chaves 'YYYY-MM-DD' comparam lexicograficamente.
  const hojeBRT = (() => { const x = new Date(Date.now() - 3 * 3600 * 1000); return x.getUTCFullYear() + '-' + pad2(x.getUTCMonth() + 1) + '-' + pad2(x.getUTCDate()); })();
  const ignorados = [];              // planilhas puladas por cabecalho fora do padrao
  let purgados = 0;
  for (const pk of Object.keys(out.diario)) for (const d of Object.keys(out.diario[pk])) if (d >= hojeBRT) { delete out.diario[pk][d]; purgados++; }
  for (const d of Object.keys(out.intra15)) if (d >= hojeBRT) delete out.intra15[d];
  if (purgados) console.log('Purgados', purgados, 'registros de hoje/futuro (>= ' + hojeBRT + ') do blob existente.');
  let parks = 0, days = new Set();
  for (const { name, buf } of raws) {
    const rawpk = parkFromName(name);
    if (!rawpk) { console.warn('Ignorado (sem parque):', name); continue; }
    const gapOnly = (rawpk === 'M10');           // M10 = M1: so preenche buracos, nao sobrescreve
    const pk = gapOnly ? 'M1' : rawpk;
    if (!CANON.has(pk)) { console.warn('Ignorado (parque nao-canonico, so M1..M9):', name, '->', rawpk); continue; }
    // O arquivo ruim e PULADO, nao derruba o backfill inteiro: numa carga de centenas de planilhas
    // um cabecalho fora do padrao nao pode custar as outras. Mas aparece no log e no resumo final —
    // o que nunca pode acontecer e passar despercebido virando zero.
    let diario, intra15;
    try { ({ diario, intra15 } = parseParkBuffer(buf)); }
    catch (e) { console.warn('IGNORADO (' + e.message + '):', name); ignorados.push(name); continue; }
    if (!out.diario[pk]) out.diario[pk] = {};
    let escritos = 0;
    for (const d in diario) {
      if (d >= hojeBRT) continue;                            // nunca grava hoje/futuro (parcial/corrompido)
      if (gapOnly && out.diario[pk][d] != null) continue;   // nao sobrescreve dia ja existente
      out.diario[pk][d] = +diario[d].toFixed(2); days.add(d); escritos++;
    }
    for (const d in intra15) {
      if (d >= hojeBRT) continue;
      if (!out.intra15[d]) out.intra15[d] = {};
      if (gapOnly && out.intra15[d][pk] != null) continue;
      out.intra15[d][pk] = intra15[d].map(v => +v.toFixed(3));
    }
    parks++;
    console.log('OK', name, '->', pk, (gapOnly ? '(M10->M1 so buracos)' : ''), '| dias no arquivo:', Object.keys(diario).length, '| gravados:', escritos);
  }
  // limpeza: remove parques nao-canonicos residuais do blob (ex.: M10 legado = M1)
  const removidos = [];
  for (const pk of Object.keys(out.diario)) if (!CANON.has(pk)) { delete out.diario[pk]; removidos.push(pk); }
  for (const day of Object.keys(out.intra15)) for (const pk of Object.keys(out.intra15[day])) if (!CANON.has(pk)) delete out.intra15[day][pk];
  if (removidos.length) console.log('Removidos parques nao-canonicos:', [...new Set(removidos)].join(', '));
  await writeOut(out);
  console.log(`Gravado ${OUT_BLOB}: ${parks} parques, ${days.size} dias novos/atualizados, ${Object.keys(out.intra15).length} dias no total.`);
  if (ignorados.length) {
    console.log(`
ATENCAO: ${ignorados.length} planilha(s) ignorada(s) por nao ter coluna de potencia ativa.`);
    console.log('Antes desta correcao elas virariam 0 MWh silenciosamente. Se forem de potencia');
    console.log('ativa, o cabecalho mudou e o padrao CVMMXN1_Wa precisa ser ajustado:');
    ignorados.slice(0, 20).forEach(f => console.log('  - ' + f));
    if (ignorados.length > 20) console.log('  ... e mais ' + (ignorados.length - 20));
  }
})().catch(e => { console.error(e); process.exit(1); });
