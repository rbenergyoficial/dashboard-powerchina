/*
 * gen-inversores.js — confiabilidade dos inversores Sungrow -> dados/inversores.json (fonte da aba "Inversores").
 * Lê 2 planilhas do container inversores-raw: P1 (Inverter Failure Control / substituições) e
 * P2 (Registro_Falhas_Inversores / eventos do iSolarCloud). Identifica P1/P2 pelo CONTEÚDO (cabeçalhos),
 * não pelo nome. Limpa/normaliza, aplica taxonomia e PRÉ-CALCULA todas as análises (pct/cor/rótulo prontos).
 * Env: DADOS_STORAGE (conn string) · RAW_CONTAINER=inversores-raw · OUT_CONTAINER=dados · OUT_BLOB=inversores.json.
 * Modo teste local: LOCAL_DIR (pasta com os 2 xlsx) / LOCAL_OUT (arquivo de saída).
 */
const XLSX = require('xlsx');
const RAW_CONTAINER = process.env.RAW_CONTAINER || 'inversores-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'inversores.json';
const HOJE = new Date(Date.now() - 3 * 3600 * 1000); HOJE.setUTCHours(0, 0, 0, 0);

// ---------- blob I/O (espelha gen-scada.js) ----------
function streamToBuffer(readable) { return new Promise((resolve, reject) => { const chunks = []; readable.on('data', d => chunks.push(d instanceof Buffer ? d : Buffer.from(d))); readable.on('end', () => resolve(Buffer.concat(chunks))); readable.on('error', reject); }); }
async function getBlobClient() { const { BlobServiceClient } = require('@azure/storage-blob'); const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido'); return BlobServiceClient.fromConnectionString(conn); }
async function loadRawBuffers() {
  if (process.env.LOCAL_DIR) { const fs = require('fs'), path = require('path'); const dir = process.env.LOCAL_DIR;
    return fs.readdirSync(dir).filter(n => /\.xlsx$/i.test(n)).map(n => ({ name: n, buf: fs.readFileSync(path.join(dir, n)) })); }
  const svc = await getBlobClient(); const cont = svc.getContainerClient(RAW_CONTAINER); const out = [];
  for await (const b of cont.listBlobsFlat()) { if (!/\.xlsx$/i.test(b.name)) continue; out.push({ name: b.name, buf: await streamToBuffer((await cont.getBlobClient(b.name).download()).readableStreamBody) }); }
  return out;
}
async function writeOut(obj) { const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const svc = await getBlobClient(); const cont = svc.getContainerClient(OUT_CONTAINER); await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } }); return json.length;
}

// ---------- utils ----------
const norm = s => String(s == null ? '' : s).trim();
function parkNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); if (!n) return null; return 'M' + (n === 10 ? 1 : n); } // M02..M10 -> M2..M9,M1 (M10=M1)
function tsNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); return n ? 'TS' + String(n).padStart(2, '0') : null; }
function invNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); return n ? 'INV' + String(n).padStart(2, '0') : null; }
function toDate(v) { if (v instanceof Date && !isNaN(v)) return v; const s = norm(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const d = new Date(y, +m[2] - 1, +m[1]); return isNaN(d) ? null : d; } const d = new Date(s); return isNaN(d) ? null : d; }
const ym = d => d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : null;
function tally(arr) { const m = new Map(); for (const x of arr) { const k = (x == null || x === '') ? '(vazio)' : x; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }
const cIdx = (H, n) => (H || []).findIndex(h => norm(h).toLowerCase() === n.toLowerCase());
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const rowsOf = ws => XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

// ---------- classificação P1 x P2 pelo conteúdo ----------
function classifyWb(wb) {
  for (const sn of wb.SheetNames) { const R = rowsOf(wb.Sheets[sn]);
    for (const row of R.slice(0, 8)) { const H = row.map(x => norm(x).toUpperCase());
      if (H.includes('CAMPO') && H.includes('SUBCAMPO') && (H.includes('STATUS') || H.includes('NOME'))) return 'P2';
      if (H.includes('FAILURE DESCRIPTION') || (H.includes('ITEM') && (H.includes('SPV') || H.includes('INV')))) return 'P1'; } }
  return null;
}

// ---------- taxonomia ----------
function modoP1(desc) { const d = norm(desc).toUpperCase();
  if (!d) return { modo: '(sem descrição)', termico: false };
  if (d.includes('CARBONI')) return { modo: 'Carbonizado', termico: true };
  if (d.includes('INFLATED') || d.includes('ESTUFAD')) return { modo: 'Capacitor/módulo estufado', termico: true };
  if (d.includes('OVERHEAT') || d.includes('SUPERAQUEC')) return { modo: 'Superaquecimento', termico: true };
  if (d.includes('FAN') || d.includes('EXHAUST') || d.includes('VENTOINHA') || d.includes('EXAUST')) return { modo: 'Ventoinhas/exaustão', termico: true };
  if (d.includes('MPPT')) return { modo: 'Falha MPPT', termico: false };
  if (d.includes('POWER BOARD') || d.includes('PLACA DE POT')) return { modo: 'Placa de potência', termico: false };
  if (d.includes('COMMUNIC') || d.includes('COMUNIC')) return { modo: 'Comunicação', termico: false };
  if (d.includes('VOLTAGE READING') || d.includes('LEITURA')) return { modo: 'Leitura de tensão', termico: false };
  if (d.includes('ANOMALY') || d.includes('ANOMAL')) return { modo: 'Anomalia de operação', termico: false };
  if (d.includes('INTERNAL')) return { modo: 'Sistema/módulo interno', termico: false };
  return { modo: 'Outros', termico: false };
}
function classeP2(nome) { const n = norm(nome).toLowerCase();
  if (n.includes('isolamento')) return 'Inversor · isolamento';
  if (n.includes('corrente reversa') || n.includes('circulação de corrente') || n.includes('fuga')) return 'Inversor · corrente';
  if (n.includes('anomalia de operação') || n.includes('operação do sistema')) return 'Inversor · anomalia';
  if (n.includes('subtens') || n.includes('sobretens') || n.includes('queda da rede') || n.includes('rede')) return 'Rede';
  if (n.includes('arranjo fv') || n.includes('conexão reversa')) return 'Arranjo FV';
  if (n.includes('alarme do sistema')) return 'Aviso/Sistema';
  return 'Outros';
}
const ehInversor = c => c.startsWith('Inversor');
const COR = { amber: '#F5A623', amberHi: '#FFB020', ok: '#2FBF71', warn: '#FF8A3D', crit: '#E5484D', blue: '#4C9AFF', teal: '#35C2C1', faint: '#5F6672' };
const MES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesLbl = m => MES_ABBR[+m.slice(5, 7) - 1] + '/' + m.slice(2, 4);
function enrich(arr, colorFn) { const mx = Math.max(...arr.map(x => x.n), 1); arr.forEach((x, i) => { x.pct = Math.max(2, Math.round(x.n / mx * 100)); x.cor = colorFn(x, i, mx); }); }

// ---------- análise ----------
function analyze(wb1, wb2) {
  // P1
  const S1 = wb1.Sheets[wb1.SheetNames[0]]; const R1 = rowsOf(S1);
  let hr = R1.findIndex(r => cIdx(r, 'FAILURE DESCRIPTION') >= 0 || cIdx(r, 'ITEM') >= 0); if (hr < 0) hr = 5;
  const H1 = R1[hr]; const c = { item: cIdx(H1, 'ITEM'), spv: cIdx(H1, 'SPV'), ts: cIdx(H1, 'TS'), inv: cIdx(H1, 'INV'), desc: cIdx(H1, 'FAILURE DESCRIPTION'), date: cIdx(H1, 'DATE'), sub: cIdx(H1, 'Data substituição') };
  const p1 = R1.slice(hr + 1).filter(r => norm(r[c.item]) !== '').map(r => { const { modo, termico } = modoP1(r[c.desc]); const date = toDate(r[c.date]); const fut = date && date > HOJE;
    return { parque: parkNorm(r[c.spv]), ts: tsNorm(r[c.ts]), inv: invNorm(r[c.inv]), modo, termico, date: (date && !fut) ? date : null, sub: toDate(r[c.sub]) }; });
  const p1Term = p1.filter(x => x.termico).length;
  const leads = p1.filter(x => x.date && x.sub && x.sub >= x.date && (x.sub - x.date) / 864e5 < 500).map(x => (x.sub - x.date) / 864e5).sort((a, b) => a - b);
  const P1 = { total: p1.length, termico: p1Term, termico_pct: round(100 * p1Term / (p1.length || 1)), com_data: p1.filter(x => x.date).length, com_troca: p1.filter(x => x.sub).length,
    por_modo: tally(p1.map(x => x.modo)).map(([modo, n]) => ({ modo, n, termico: p1.find(y => y.modo === modo).termico })),
    por_parque: tally(p1.map(x => x.parque).filter(Boolean)).map(([parque, n]) => ({ parque, n })).sort((a, b) => a.parque.localeCompare(b.parque, undefined, { numeric: true })),
    por_mes: tally(p1.map(x => ym(x.date)).filter(Boolean)).map(([mes, n]) => ({ mes, n })).sort((a, b) => a.mes.localeCompare(b.mes)),
    lead_time: leads.length ? { n: leads.length, mediana: Math.round(leads[Math.floor(leads.length / 2)]), media: round(leads.reduce((a, b) => a + b, 0) / leads.length), max: Math.round(leads[leads.length - 1]) } : null };

  // P2
  let ev = []; const parques = [];
  for (const sn of wb2.SheetNames) { const R = rowsOf(wb2.Sheets[sn]); const H = R[0]; const g = { campo: cIdx(H, 'CAMPO'), sub: cIdx(H, 'SUBCAMPO'), inv: cIdx(H, 'INVERSOR'), hor: cIdx(H, 'Horário'), tipo: cIdx(H, 'Tipo'), nome: cIdx(H, 'Nome'), st: cIdx(H, 'Status') };
    if (g.campo < 0) continue; const oc = R.slice(1).filter(r => norm(r[g.campo]) !== '' && norm(r[g.st]) === 'Ocorre'); parques.push(parkNorm(sn));
    for (const r of oc) ev.push({ parque: parkNorm(r[g.campo]), inv: [r[g.campo], r[g.sub], r[g.inv]].map((x, i) => [parkNorm, tsNorm, invNorm][i](x)).join('/'), nome: norm(r[g.nome]), classe: classeP2(r[g.nome]), tipo: norm(r[g.tipo]), date: toDate(r[g.hor]) }); }
  const evInv = ev.filter(x => ehInversor(x.classe));
  const badActors = tally(evInv.map(x => x.inv)).slice(0, 15).map(([inv, n]) => ({ inv, n, parque: inv.split('/')[0] }));
  const dts2 = ev.map(x => x.date).filter(Boolean); const per = dts2.length ? (Math.max(...dts2) - Math.min(...dts2)) / 864e5 : 0;
  const P2 = { eventos: ev.length, falha_inversor: evInv.length, rede: ev.filter(x => x.classe === 'Rede').length, aviso: ev.filter(x => x.classe.startsWith('Aviso')).length,
    parques: [...new Set(parques)].filter(Boolean), inversores_distintos: new Set(ev.map(x => x.inv)).size,
    por_classe: tally(ev.map(x => x.classe)).map(([classe, n]) => ({ classe, n })), bad_actors: badActors,
    modos_inversor: tally(evInv.map(x => x.nome)).map(([nome, n]) => ({ nome, n })),
    por_parque: [...new Set(ev.map(x => x.parque))].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(p => ({ parque: p, eventos: ev.filter(x => x.parque === p).length, falha_inversor: evInv.filter(x => x.parque === p).length, rede: ev.filter(x => x.parque === p && x.classe === 'Rede').length })),
    isolamento_por_mes: tally(evInv.filter(x => x.classe.includes('isolamento')).map(x => ym(x.date)).filter(Boolean)).map(([mes, n]) => ({ mes, n })).sort((a, b) => a.mes.localeCompare(b.mes)) };
  const mtbf = round(P2.inversores_distintos * per / (P2.falha_inversor || 1), 1);

  // cruzado
  const p2ByInv = new Map(); for (const e of evInv) p2ByInv.set(e.inv, (p2ByInv.get(e.inv) || 0) + 1);
  const p1Loc = p1.filter(x => x.parque && x.ts && x.inv); const hit = p1Loc.filter(x => p2ByInv.has(x.parque + '/' + x.ts + '/' + x.inv));
  const cruzado = { p1_com_localizacao: p1Loc.length, join_cobertura: p1Loc.length ? round(100 * hit.length / p1Loc.length) : 0,
    exemplos: hit.map(x => ({ inv: x.parque + '/' + x.ts + '/' + x.inv, modo_troca: x.modo, falhas_p2: p2ByInv.get(x.parque + '/' + x.ts + '/' + x.inv) })).sort((a, b) => b.falhas_p2 - a.falhas_p2).slice(0, 10) };

  // enriquecimento p/ render (pct + cor + rótulo)
  enrich(P1.por_modo, x => x.termico ? (x.n >= 20 ? COR.crit : COR.warn) : COR.amber); P1.por_modo.forEach(x => { if (x.termico) x.modo = '🔥 ' + x.modo; });
  enrich(P1.por_parque, x => x.parque === 'M6' ? COR.crit : (x.parque === 'M9' ? COR.ok : COR.amber));
  enrich(P1.por_mes, (x, i, mx) => x.n === mx ? COR.amberHi : COR.amber); P1.por_mes.forEach(x => x.lbl = mesLbl(x.mes));
  enrich(P2.bad_actors, x => x.inv.startsWith('M1/TS07') ? COR.crit : (x.inv.startsWith('M3/TS04') ? COR.warn : COR.amber));
  enrich(P2.isolamento_por_mes, x => x.n >= 300 ? COR.crit : (x.n >= 100 ? COR.warn : COR.amber)); P2.isolamento_por_mes.forEach(x => x.lbl = mesLbl(x.mes));
  { const tot = P2.por_classe.reduce((a, x) => a + x.n, 0) || 1; const cm = { 'Rede': COR.blue, 'Aviso/Sistema': COR.faint, 'Arranjo FV': COR.teal, 'Inversor · anomalia': COR.amber, 'Inversor · isolamento': COR.warn, 'Inversor · corrente': COR.crit };
    P2.por_classe.forEach(x => { x.pct = Math.round(x.n / tot * 100); x.cor = cm[x.classe] || COR.amber; }); }
  cruzado.exemplos.forEach(x => { x.cor = /estufado|carboni|superaque|ventoinha/i.test(x.modo_troca) ? COR.crit : (/anomalia/i.test(x.modo_troca) ? COR.amber : COR.faint); });
  const bp = P1.por_parque.slice().sort((a, b) => b.n - a.n)[0] || { parque: '-', n: 0 };
  const kpiTiles = [
    { k: 'Trocas registradas', v: String(P1.total), u: '', c: 'P1 · desde ' + ((P1.por_mes[0] || {}).lbl || '?'), cor: COR.amber },
    { k: 'Falhas térmicas', v: String(P1.termico_pct), u: '%', c: P1.termico + ' de ' + P1.total + ' 🔥', cor: COR.crit },
    { k: 'Pior parque', v: bp.parque, u: '', c: bp.n + ' trocas', cor: COR.warn },
    { k: 'Bad-actor', v: String((badActors[0] || {}).n || 0), u: 'falhas', c: (badActors[0] || {}).inv || '—', cor: COR.crit },
    { k: 'MTBF frota', v: String(mtbf), u: 'dias', c: 'piloto · ' + P2.parques.length + ' parques', cor: COR.blue },
    { k: 'Eventos = rede', v: String(round(100 * P2.rede / (P2.eventos || 1))), u: '%', c: 'não é defeito', cor: COR.faint },
  ];
  return { atualizado: new Date(HOJE.getTime()).toISOString().slice(0, 10), kpiTiles,
    escopo: { inversores_planta: 1155, modelo: 'Sungrow SG350HX', p1_registros: P1.total, p2_parques: P2.parques, p2_eventos: P2.eventos }, p1: P1, p2: P2, cruzado };
}

(async () => {
  const raws = await loadRawBuffers();
  if (!raws.length) { console.log('Nenhuma planilha .xlsx em "' + RAW_CONTAINER + '" — nada a processar.'); return; }
  let wb1, wb2;
  for (const { name, buf } of raws) { const wb = XLSX.read(buf, { cellDates: true, type: 'buffer' }); const cls = classifyWb(wb);
    if (cls === 'P1') wb1 = wb; else if (cls === 'P2') wb2 = wb; else console.log('ignorado (não é P1 nem P2):', name); }
  if (!wb1 || !wb2) throw new Error('faltou ' + (!wb1 ? 'P1 (Failure Control)' : '') + (!wb2 ? ' P2 (Registro Falhas)' : '') + ' no container');
  const out = analyze(wb1, wb2);
  const size = await writeOut(out);
  console.log('inversores.json OK · P1=' + out.p1.total + ' trocas (' + out.p1.termico_pct + '% térmico) · P2=' + out.p2.eventos + ' eventos / ' + out.p2.parques.join(',') + ' · bad-actor ' + ((out.p2.bad_actors[0] || {}).inv) + ' · ' + round(size / 1024) + ' KB');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
