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
// planilha que o nome declara NÃO ser a vigente. O humano foi explícito: cópia antiga e rascunho
// não valem como fonte. Sai por NOME porque é o que o autor marca de propósito — conteúdo não diz
// "isto é rascunho".
const NAO_FINAL = /em\s*revis|revis[aã]o|(^|[^a-z])old([^a-z]|$)|antig|backup|c[oó]pia|(^|[^a-z])copy([^a-z]|$)|rascunho|^~\$/i;
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'inversores.json';
const HOJE = new Date(Date.now() - 3 * 3600 * 1000); HOJE.setUTCHours(0, 0, 0, 0);

// ---------- blob I/O (espelha gen-scada.js) ----------
function streamToBuffer(readable) { return new Promise((resolve, reject) => { const chunks = []; readable.on('data', d => chunks.push(d instanceof Buffer ? d : Buffer.from(d))); readable.on('end', () => resolve(Buffer.concat(chunks))); readable.on('error', reject); }); }
async function getBlobClient() { const { BlobServiceClient } = require('@azure/storage-blob'); const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido'); return BlobServiceClient.fromConnectionString(conn); }
async function loadRawBuffers() {
  if (process.env.LOCAL_DIR) { const fs = require('fs'), path = require('path'); const dir = process.env.LOCAL_DIR;
    return fs.readdirSync(dir).filter(n => /\.xls[xm]$/i.test(n)).map(n => ({ name: n, mod: fs.statSync(path.join(dir, n)).mtime, buf: fs.readFileSync(path.join(dir, n)) })); }
  const svc = await getBlobClient(); const cont = svc.getContainerClient(RAW_CONTAINER); const out = [];
  // a planilha de falhas virou .xlsm (macro) em 20/08/2026; filtrar so .xlsx a deixaria de fora
  for await (const b of cont.listBlobsFlat()) { if (!/\.xls[xm]$/i.test(b.name)) continue;
    out.push({ name: b.name, mod: (b.properties || {}).lastModified, buf: await streamToBuffer((await cont.getBlobClient(b.name).download()).readableStreamBody) }); }
  return out;
}
async function writeOut(obj) { const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const svc = await getBlobClient(); const cont = svc.getContainerClient(OUT_CONTAINER); await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } }); return json.length;
}

// ---------- utils ----------
const norm = s => String(s == null ? '' : s).trim();
// Inversores POR PARQUE (informado pelo usuário 2026-07-16; soma = 1155 ✓). Sem isto a comparação entre
// parques é INJUSTA: M7 tem 44 inversores e M6 tem 165 — contar troca bruta favorece o parque pequeno.
const INV_POR_PARQUE = { M1: 165, M2: 88, M3: 165, M4: 165, M5: 165, M6: 165, M7: 44, M8: 165, M9: 33 };
const normOrig = v => { const s = norm(v).toLowerCase(); if (!s) return ''; if (/reparad|repair/.test(s)) return 'Reparado'; if (/novo|new/.test(s)) return 'Novo'; return norm(v); };
function parkNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); if (!n) return null; return 'M' + (n === 10 ? 1 : n); } // M02..M10 -> M2..M9,M1 (M10=M1)
function tsNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); return n ? 'TS' + String(n).padStart(2, '0') : null; }
function invNorm(v) { const n = parseInt(norm(v).replace(/[^0-9]/g, ''), 10); return n ? 'INV' + String(n).padStart(2, '0') : null; }
function toDate(v) { if (v instanceof Date && !isNaN(v)) return v; const s = norm(v); if (!s) return null;
  const m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/); if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; const d = new Date(y, +m[2] - 1, +m[1]); return isNaN(d) ? null : d; } const d = new Date(s); return isNaN(d) ? null : d; }
const ym = d => d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : null;
function tally(arr) { const m = new Map(); for (const x of arr) { const k = (x == null || x === '') ? '(vazio)' : x; m.set(k, (m.get(k) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]); }
// 🔴 CABEÇALHO BILÍNGUE. Em 20/08/2026 a planilha passou a rotular a coluna nos dois idiomas
// dentro da MESMA célula: "DATA / DATE", "DESCRIÇÃO DA FALHA / FAILURE DESCRIPTION". A igualdade
// exata que havia aqui perdia SEIS das onze colunas — e perdia CALADA: cIdx devolve -1, o código
// lê r[-1] = undefined, e o campo sai vazio sem erro nenhum. Medido nos quatro arquivos da pasta.
// A comparação passa a ser por FATIA do cabeçalho (o que está entre as barras), sem acento, sem
// parêntese explicativo e sem interrogação — e continua sendo IGUALDADE, nunca "contém": com
// "contém", o alvo Fuses casaria em "Damaged Fuses" e a coluna de FASES viraria a de FUSÍVEIS.
const semAcento = s => norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\([^)]*\)/g, ' ').replace(/[?:]/g, ' ').toUpperCase().replace(/\s+/g, ' ').trim();
const fatias = h => String(h == null ? '' : h).split('/').map(x => semAcento(x)).filter(Boolean);
const cIdx = (H, n) => { const alvos = fatias(n); if (!alvos.length) return -1;
  return (H || []).findIndex(h => fatias(h).some(f => alvos.includes(f))); };
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
// paleta EXECUTIVA (dessaturada, report-by-exception): barra padrão = neutro; cor só na exceção
const COR = { neutral: '#525C6B', brand: '#D9A441', ok: '#43966B', crit: '#C85C60', blue: '#5C86BE', teal: '#4E9A98', warn: '#C08A45', faint: '#5F6672' };
const MES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const mesLbl = m => MES_ABBR[+m.slice(5, 7) - 1] + '/' + m.slice(2, 4);
function enrich(arr, colorFn) { const mx = Math.max(...arr.map(x => x.n), 1); arr.forEach((x, i) => { x.pct = Math.max(2, Math.round(x.n / mx * 100)); x.cor = colorFn(x, i, mx); }); }

// ---------- abas novas da planilha P1 (20/08/2026) ----------
// A REGRA MORA NA PLANILHA, não aqui. FAULT_CODES é o dicionário do manual Sungrow e DESC_MAP são
// as regras de inferência COM justificativa nomeada. Reescrevê-las dentro do gerador criaria a
// terceira cópia da mesma regra — e cópia é o que envelhece diferente do original.
// A aba é achada pelo CABEÇALHO, nunca pelo nome nem pela posição: nome de aba é rótulo humano
// e muda; o conjunto de colunas é o contrato.
function abaPorCabecalho(wb, nomes) {
  for (const sn of wb.SheetNames) { const R = rowsOf(wb.Sheets[sn]);
    for (let i = 0; i < Math.min(6, R.length); i++) if (nomes.every(x => cIdx(R[i], x) >= 0)) return { sn, R, hr: i }; }
  return null;
}
// ⚠️ CORRECTIVE ACTIONS é o que distingue a aba do dicionário da aba de falhas: as duas têm
// FAULT CODE e FAULT NAME, e sem esta terceira coluna o dicionário sairia da aba errada.
function leFaultCodes(wb) {
  const a = abaPorCabecalho(wb, ['FAULT CODE', 'FAULT NAME', 'CORRECTIVE ACTIONS']); if (!a) return null;
  const H = a.R[a.hr]; const cc = cIdx(H, 'FAULT CODE'), cn = cIdx(H, 'FAULT NAME'),
    ca = cIdx(H, 'CORRECTIVE ACTIONS'), cf = cIdx(H, 'ORIGINAL RANGE');
  const out = [];
  for (const r of a.R.slice(a.hr + 1)) { const cod = norm(r[cc]); if (!/^\d+$/.test(cod)) continue;
    out.push({ codigo: cod, nome: norm(r[cn]), acao: norm(r[ca]), faixa: cf >= 0 ? norm(r[cf]) : '' }); }
  return out.length ? { aba: a.sn, n: out.length, itens: out } : null;
}
function leDescMap(wb) {
  const a = abaPorCabecalho(wb, ['KEYWORD', 'ASSUMED FAULT CODE']); if (!a) return null;
  const H = a.R[a.hr]; const ck = cIdx(H, 'KEYWORD'), cc = cIdx(H, 'ASSUMED FAULT CODE'), cb = cIdx(H, 'BASIS');
  const out = [];
  for (const r of a.R.slice(a.hr + 1)) { const k = norm(r[ck]); if (!k) continue;
    out.push({ palavra: k, codigo: norm(r[cc]), base: cb >= 0 ? norm(r[cb]) : '' }); }
  return out.length ? { aba: a.sn, n: out.length, itens: out } : null;
}
// dois blocos LADO A LADO na mesma aba (novos à esquerda, reparados à direita). O início de cada
// bloco sai do título na linha acima do cabeçalho, não de coluna fixa.
function leEstoqueSN(wb) {
  const a = abaPorCabecalho(wb, ['NUMERO DE SERIE', 'SITUACAO']); if (!a) return null;
  const H = a.R[a.hr]; const titulo = a.R[a.hr - 1] || [];
  const inicio = [];
  titulo.forEach((v, j) => { if (/NOVO|REPARAD|CONSERT/.test(semAcento(v))) inicio.push({ j, grupo: norm(v) }); });
  if (!inicio.length) inicio.push({ j: 0, grupo: 'ESTOQUE' });
  const blocos = [];
  for (let k = 0; k < inicio.length; k++) {
    const de = inicio[k].j, ate = k + 1 < inicio.length ? inicio[k + 1].j : H.length;
    const sub = H.slice(de, ate);
    const cS = cIdx(sub, 'NUMERO DE SERIE'); if (cS < 0) continue;
    const cSit = cIdx(sub, 'SITUACAO'), cOrd = cIdx(sub, 'ORDEM'), cCod = cIdx(sub, 'CODIGO'), cSt = cIdx(sub, 'STATUS');
    const itens = [];
    for (const r of a.R.slice(a.hr + 1)) { const sn = norm(r[de + cS]); if (!sn) continue;
      itens.push({ sn, situacao: cSit >= 0 ? norm(r[de + cSit]) : '',
        ordem: cOrd >= 0 ? (parseInt(norm(r[de + cOrd]), 10) || null) : null,
        codigo: cCod >= 0 ? norm(r[de + cCod]) : (cSt >= 0 ? norm(r[de + cSt]) : '') }); }
    blocos.push({ grupo: inicio[k].grupo, n: itens.length,
      disponiveis: itens.filter(x => /DISPON/.test(semAcento(x.situacao))).length, itens });
  }
  return blocos.length ? { aba: a.sn, blocos } : null;
}

// ---------- análise ----------
function analyze(wb1, wb2) {
  // P1
  // a aba de falhas sai do CONTEÚDO, não de SheetNames[0]: a planilha ganhou quatro abas em
  // 20/08/2026 e a ordem delas não é contrato nosso.
  const abaP1 = (() => { for (const sn of wb1.SheetNames) { const R = rowsOf(wb1.Sheets[sn]);
      for (let i = 0; i < Math.min(10, R.length); i++) if (cIdx(R[i], 'ITEM') >= 0 && cIdx(R[i], 'SPV') >= 0) return R; }
    return rowsOf(wb1.Sheets[wb1.SheetNames[0]]); })();
  const R1 = abaP1;
  // estoque de sobressalentes: caixa "Spare Parts WareHouse" no topo — rótulos New/Repair (ou Novo/Reparado) + valor na linha seguinte
  let estoque = null;
  for (let i = 0; i < Math.min(6, R1.length); i++) { const row = R1[i].map(x => norm(x).toLowerCase());
    // 🔴 "REPARADOS" virou "REPAROS" na planilha de 20/08 e /^(repair|reparad)/ deixou de casar:
    // o campo saiu NULO, o painel abriu "No data" e a cobertura de estoque foi calculada só com os
    // novos — 1,48 mês em vez de ~2,8. Raspar rótulo escrito por humano quebra assim, calado.
    const iN = row.findIndex(x => /^(new|novo)/.test(x)); const iR = row.findIndex(x => /^(repair|repar)/.test(x));
    const iF = row.findIndex(x => /^spare\s*fuse|fus[ií]ve/.test(x));
    if (iN >= 0 || iR >= 0) { const nx = R1[i + 1] || []; const num = v => { const n = parseInt(norm(v).replace(/[^0-9-]/g, ''), 10); return isNaN(n) ? null : n; };
      estoque = { novo: iN >= 0 ? num(nx[iN]) : null, reparado: iR >= 0 ? num(nx[iR]) : null, fusivel: iF >= 0 ? num(nx[iF]) : null };
      break; } }
  // 🔴 QUANDO A ABA ESTRUTURADA EXISTE, ELA MANDA. A própria planilha declara, na instrução do
  // topo: "TODO o painel Spare Parts (C4:E4) é CALCULADO — todo cadastro é feito na aba
  // ESTOQUE_SN". Ler a caixa é ler o resultado; ler a aba é ler a origem, e ela tem número de
  // série e situação em vez de um rótulo que alguém pode reescrever.
  // ⚠️ O FUSÍVEL continua vindo da caixa: ele não tem cadastro por série na aba.
  const esSN = leEstoqueSN(wb1);
  if (esSN) {
    const acha = (re) => (esSN.blocos.find((b) => re.test(semAcento(b.grupo))) || {}).disponiveis;
    const nv = acha(/NOVO/), rp = acha(/REPARAD|REPARO|CONSERT/);
    estoque = estoque || { novo: null, reparado: null, fusivel: null };
    if (nv != null) estoque.novo = nv;
    if (rp != null) estoque.reparado = rp;
    estoque.origem = 'aba ESTOQUE_SN (disponíveis)';
  } else if (estoque) estoque.origem = 'caixa Spare Parts no topo da planilha';
  let hr = R1.findIndex(r => cIdx(r, 'FAILURE DESCRIPTION') >= 0 || cIdx(r, 'ITEM') >= 0); if (hr < 0) hr = 5;
  const cIdxAny = (H, ...ns) => { for (const n of ns) { const i = cIdx(H, n); if (i >= 0) return i; } return -1; };
  // cabeçalhos aceitam EN (atual) e PT (versões antigas) — a planilha já mudou de idioma uma vez
  const H1 = R1[hr]; const c = { item: cIdx(H1, 'ITEM'), spv: cIdx(H1, 'SPV'), ts: cIdx(H1, 'TS'), inv: cIdx(H1, 'INV'), desc: cIdx(H1, 'FAILURE DESCRIPTION'), date: cIdx(H1, 'DATE'),
    sub: cIdxAny(H1, 'Replacement Date', 'Data substituição', 'Data de substituição'),
    fid: cIdxAny(H1, 'FAILURE ID', 'FAULT CODE', 'Código de falha'), fus: cIdxAny(H1, 'Damaged Fuses', 'Fusíveis danificados'), fase: cIdxAny(H1, 'Phases/Fuses', 'Fases/fusíveis'),
    // colunas que a planilha ganhou em 20/08/2026: o código passou a ser REGISTRADO em vez de
    // deduzido da descrição, e vem acompanhado de onde ele saiu e do nome oficial da falha.
    codOrig: cIdxAny(H1, 'Code Source', 'Origem do código'), codNome: cIdxAny(H1, 'Fault Name', 'Nome da falha'),
    comis: cIdxAny(H1, 'Commissioned', 'Comissionado'),
    orig: (() => { const o = cIdxAny(H1, 'New or Repaired', 'Novo/Reparado', 'Novo ou Reparado', 'Origem', 'Tipo de substituição', 'New/Repair'); return o >= 0 ? o : H1.findIndex(h => /reparad|repair/i.test(norm(h))); })() };
  // 🔴 GUARDA QUE FALHA ALTO. Coluna não encontrada vira -1 e o campo sai vazio sem erro: foi
  // exatamente assim que a troca de cabeçalho apagaria data, descrição, código, fusíveis e fases
  // sem nada ficar vermelho. Job vermelho com o cabeçalho impresso custa uma correção; blob
  // publicado pela metade custa a confiança na página.
  { const OBRIG = { item: 'ITEM', spv: 'SPV', ts: 'TS', inv: 'INV', desc: 'descrição da falha', date: 'data' };
    const faltam = Object.keys(OBRIG).filter(k => c[k] < 0);
    if (faltam.length) throw new Error('P1: coluna obrigatória não encontrada -> ' + faltam.map(k => OBRIG[k]).join(', ')
      + ' · cabeçalho lido: ' + (H1 || []).map(norm).filter(Boolean).join(' | '));
    for (const [k, r] of [['sub', 'data de substituição'], ['fid', 'código de falha'], ['fus', 'fusíveis danificados'], ['fase', 'fases']])
      if (c[k] < 0) console.log('  ATENÇÃO · coluna opcional ausente: ' + r + ' (o campo sai vazio)'); }
  const p1 = R1.slice(hr + 1).filter(r => norm(r[c.item]) !== '').map(r => { const { modo, termico } = modoP1(r[c.desc]); const date = toDate(r[c.date]); const fut = date && date > HOJE;
    const fidRaw = norm(r[c.fid]); const codigos = (fidRaw && fidRaw !== '-') ? fidRaw.split(/[,;\/]/).map(s => s.trim()).filter(s => /^\d+$/.test(s)) : [];
    const fusRaw = norm(r[c.fus]); const fusAval = fusRaw !== ''; const dig = fusRaw.replace(/[^0-9]/g, ''); const fusDan = fusAval && !/n[ãa]o/i.test(fusRaw) && +dig > 0;
    const fases = norm(r[c.fase]) ? norm(r[c.fase]).split(/[\/,;]/).map(s => s.trim().toUpperCase()).filter(Boolean) : [];
    return { parque: parkNorm(r[c.spv]), ts: tsNorm(r[c.ts]), inv: invNorm(r[c.inv]), modo, termico, date: (date && !fut) ? date : null, sub: toDate(r[c.sub]),
      codigos, fusAval, fusDan, fusQtd: fusDan ? (+dig || 0) : 0, fases, orig: c.orig >= 0 ? normOrig(r[c.orig]) : '',
      codOrig: c.codOrig >= 0 ? norm(r[c.codOrig]) : '', codNome: c.codNome >= 0 ? norm(r[c.codNome]) : '',
      comis: c.comis >= 0 ? norm(r[c.comis]) : '' }; });
  const p1Term = p1.filter(x => x.termico).length;
  const leads = p1.filter(x => x.date && x.sub && x.sub >= x.date && (x.sub - x.date) / 864e5 < 500).map(x => (x.sub - x.date) / 864e5).sort((a, b) => a - b);
  const P1 = { total: p1.length, termico: p1Term, termico_pct: round(100 * p1Term / (p1.length || 1)), com_data: p1.filter(x => x.date).length, com_troca: p1.filter(x => x.sub).length,
    por_modo: tally(p1.map(x => x.modo)).map(([modo, n]) => ({ modo, n, termico: p1.find(y => y.modo === modo).termico })),
    por_parque: tally(p1.map(x => x.parque).filter(Boolean)).map(([parque, n]) => ({ parque, n })).sort((a, b) => a.parque.localeCompare(b.parque, undefined, { numeric: true })),
    por_mes: tally(p1.map(x => ym(x.date)).filter(Boolean)).map(([mes, n]) => ({ mes, n })).sort((a, b) => a.mes.localeCompare(b.mes)),
    lead_time: leads.length ? { n: leads.length, mediana: Math.round(leads[Math.floor(leads.length / 2)]), media: round(leads.reduce((a, b) => a + b, 0) / leads.length), max: Math.round(leads[leads.length - 1]) } : null };
  // FAILURE ID (código nativo do inversor) — Pareto; multi-código ("10, 36") conta cada um
  // O NOME do código vem do dicionário da planilha, não de tabela escrita aqui: 512 códigos do
  // manual Sungrow, e uma cópia nossa ficaria desatualizada na primeira revisão do manual.
  const DIC = leFaultCodes(wb1);
  const nomeDe = new Map((DIC ? DIC.itens : []).map(x => [x.codigo, x.nome]));
  P1.por_codigo = tally(p1.flatMap(x => x.codigos)).slice(0, 12)
    .map(([codigo, n]) => ({ codigo, n, nome: nomeDe.get(codigo) || '' }));
  // ⚠️ Registrado × inferido é ressalva, não enfeite: código deduzido da descrição não tem o
  // mesmo peso do que veio do próprio inversor, e a página precisa poder dizer isso.
  if (c.codOrig >= 0) P1.por_origem_codigo = tally(p1.map(x => x.codOrig).filter(Boolean)).map(([origem, n]) => ({ origem, n }));
  if (c.comis >= 0) P1.comissionamento = tally(p1.map(x => x.comis).filter(Boolean)).map(([estado, n]) => ({ estado, n }));
  P1.com_codigo = p1.filter(x => x.codigos.length).length;
  // Fusíveis (colunas novas — enchem com o tempo): quantos avaliados, quantos danificaram, fases afetadas
  const fusAv = p1.filter(x => x.fusAval);
  P1.fusiveis = { avaliados: fusAv.length, com_dano: fusAv.filter(x => x.fusDan).length, sem_dano: fusAv.filter(x => !x.fusDan).length,
    fusiveis_total: p1.reduce((a, x) => a + x.fusQtd, 0), por_fase: tally(p1.flatMap(x => x.fases)).map(([fase, n]) => ({ fase, n })) };   // dinâmico: A/B/C ou L1/L2/L3
  // Origem do inversor de reposição (novo × reparado) — só se a coluna existir na planilha
  if (c.orig >= 0) P1.por_origem = tally(p1.map(x => x.orig).filter(Boolean)).map(([origem, n]) => ({ origem, n }));
  // Reposição: falha (DATE) → troca (Replacement Date). Maioria é no MESMO DIA = excelência operacional.
  const comAmbas = p1.filter(x => x.date && x.sub && x.sub >= x.date);
  const diasRep = comAmbas.map(x => Math.round((x.sub - x.date) / 864e5)).filter(d => d >= 0 && d < 500);
  const mesmoDia = diasRep.filter(d => d === 0).length;
  P1.reposicao = { com_ambas: comAmbas.length, mesmo_dia: mesmoDia, pct_mesmo_dia: round(100 * mesmoDia / (diasRep.length || 1)),
    max_dias: diasRep.length ? Math.max(...diasRep) : null, media_dias: diasRep.length ? round(diasRep.reduce((a, b) => a + b, 0) / diasRep.length, 2) : null };
  // MTBF da FROTA pelas falhas REAIS (P1) — NÃO pelos alarmes do SCADA (P2 não significa queima).
  const dts1 = p1.map(x => x.date).filter(Boolean);
  const perDias = dts1.length ? (HOJE - Math.min(...dts1)) / 864e5 : 0;
  P1.mtbf_anos = round(1155 * perDias / (P1.total || 1) / 365, 2);
  P1.janela_dias = Math.round(perDias);
  // Ritmo de consumo de sobressalentes — vira o LIMIAR do alerta de estoque (nada de chute):
  // quantos inversores a planta queima por mês, e quantos meses o estoque atual cobre.
  P1.consumo_mensal = perDias > 0 ? round(P1.total / (perDias / 30.44), 2) : null;
  // ⚠️ Campo nulo aqui não é neutro: ele entra como ZERO no total e encolhe a cobertura sem
  // dizer nada. Avisar no log é o que transforma "No data" num painel em algo rastreável.
  if (estoque) for (const k of ['novo', 'reparado', 'fusivel'])
    if (estoque[k] == null) console.log('  ATENÇÃO · estoque.' + k + ' ficou NULO — o painel abrirá "No data" e o total o conta como zero');
  if (estoque && P1.consumo_mensal) { estoque.total = (estoque.novo || 0) + (estoque.reparado || 0);
    estoque.cobertura_meses = round(estoque.total / P1.consumo_mensal, 2);
    estoque.cobertura_novos_meses = round((estoque.novo || 0) / P1.consumo_mensal, 2); }
  // taxa NORMALIZADA por parque — a comparação honesta (contagem bruta favorece parque pequeno)
  P1.por_parque.forEach(p => { p.inversores = INV_POR_PARQUE[p.parque] || null;
    p.taxa_100 = p.inversores ? round(100 * p.n / p.inversores, 2) : null; });
  // pior parque PELA TAXA (não pela contagem), com número p/ o Stat nativo mapear (M6 -> 6 -> "M6")
  const bp0 = P1.por_parque.slice().sort((a, b) => (b.taxa_100 || 0) - (a.taxa_100 || 0))[0] || { parque: '-', n: 0 };
  P1.pior_parque = { parque: bp0.parque, num: parseInt(String(bp0.parque).replace(/\D/g, ''), 10) || 0, n: bp0.n, taxa_100: bp0.taxa_100 };
  P1.melhor_parque = (P1.por_parque.filter(p => p.taxa_100 != null).slice().sort((a, b) => a.taxa_100 - b.taxa_100)[0]) || null;
  // TABELA-FATO: 1 linha por substituição. É o que permite FILTRAR/AGREGAR no Grafana (variáveis + Group by),
  // em vez de só exibir agregado pronto. 154 linhas = irrisório no JSON.
  const iso = d => d ? new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10) : null;
  P1.fatos = p1.map(x => ({
    parque: x.parque, ts: x.ts, inv: x.inv,
    local: (x.parque && x.ts && x.inv) ? x.parque + '/' + x.ts + '/' + x.inv : null,
    modo: x.modo, termico: x.termico ? 'Térmico' : 'Não térmico',
    data: iso(x.date), ano: x.date ? x.date.getFullYear() : null, mes: x.date ? ym(x.date) : null,
    mes_lbl: x.date ? mesLbl(ym(x.date)) : null,
    codigo: x.codigos.length ? x.codigos.join(', ') : '(sem código)',
    fusiveis: x.fusQtd, origem: x.orig || '(não informado)',
    troca: iso(x.sub), dias_reposicao: (x.date && x.sub && x.sub >= x.date) ? Math.round((x.sub - x.date) / 864e5) : null,
    // truque p/ taxa normalizada FILTRÁVEL: SOMAR peso_100 por parque == trocas × 100 ÷ inversores.
    // Assim o Grafana calcula a taxa com um único "sum" no Group by, e ela respeita os filtros.
    peso_100: (x.parque && INV_POR_PARQUE[x.parque]) ? round(100 / INV_POR_PARQUE[x.parque], 6) : null,
    inversores_parque: (x.parque && INV_POR_PARQUE[x.parque]) || null,
    // 1º dia do mês como timestamp — permite o SPARKLINE (tendência) atrás do número no Stat
    mes_ts: x.date ? new Date(Date.UTC(x.date.getFullYear(), x.date.getMonth(), 1)).toISOString() : null,
  }));
  // fato explodido por CÓDIGO (multi-código "10, 36" vira 2 linhas) — p/ Pareto de código filtrável
  P1.fatos_codigo = p1.flatMap(x => x.codigos.map(c => ({ parque: x.parque, ano: x.date ? x.date.getFullYear() : null, modo: x.modo, codigo: c })));

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
  // TABELA-FATO do P2 — agregada no grão inversor×classe×mês (não as 13.579 linhas cruas!).
  // Permite os MESMOS filtros $parque/$ano do P1: no Grafana faz-se Group by + SUM(n).
  { const m = new Map();
    for (const e of ev) { const mes = ym(e.date); const k = [e.parque, e.inv, e.classe, mes].join('|');
      if (!m.has(k)) m.set(k, { parque: e.parque, inv: e.inv, ts: (e.inv || '').split('/')[1] || null, classe: e.classe,
        eh_inversor: ehInversor(e.classe) ? 'Falha do inversor' : 'Rede/aviso',
        ano: e.date ? e.date.getFullYear() : null, mes, mes_lbl: mes ? mesLbl(mes) : null, n: 0 });
      m.get(k).n++; }
    P2.fatos = [...m.values()]; }
  // ATENÇÃO SEMÂNTICA: isto é tempo médio entre ALARMES do SCADA (MTBA), NÃO entre falhas. P2 não significa queima.
  P2.mtba_dias = round(P2.inversores_distintos * per / (P2.falha_inversor || 1), 1);
  P2.rede_pct = round(100 * P2.rede / (P2.eventos || 1));
  P2.bad_actor = P2.bad_actors[0] || { inv: '—', n: 0 };

  // cruzado
  const p2ByInv = new Map(); for (const e of evInv) p2ByInv.set(e.inv, (p2ByInv.get(e.inv) || 0) + 1);
  const p1Loc = p1.filter(x => x.parque && x.ts && x.inv); const hit = p1Loc.filter(x => p2ByInv.has(x.parque + '/' + x.ts + '/' + x.inv));
  const cruzado = { p1_com_localizacao: p1Loc.length, join_cobertura: p1Loc.length ? round(100 * hit.length / p1Loc.length) : 0,
    exemplos: hit.map(x => ({ inv: x.parque + '/' + x.ts + '/' + x.inv, modo_troca: x.modo, falhas_p2: p2ByInv.get(x.parque + '/' + x.ts + '/' + x.inv) })).sort((a, b) => b.falhas_p2 - a.falhas_p2).slice(0, 10) };

  // enriquecimento p/ render (pct + cor + rótulo)
  enrich(P1.por_modo, x => x.termico ? COR.crit : COR.neutral); P1.por_modo.forEach(x => { if (x.termico) x.modo = '🔥 ' + x.modo; });
  enrich(P1.por_parque, x => x.parque === 'M6' ? COR.crit : (x.parque === 'M9' ? COR.ok : COR.neutral));
  enrich(P1.por_mes, (x, i, mx) => x.n === mx ? COR.brand : COR.neutral); P1.por_mes.forEach(x => x.lbl = mesLbl(x.mes));
  enrich(P2.bad_actors, x => x.inv.startsWith('M1/TS07') ? COR.crit : (x.inv.startsWith('M3/TS04') ? COR.brand : COR.neutral));
  enrich(P2.isolamento_por_mes, x => x.n >= 300 ? COR.crit : COR.neutral); P2.isolamento_por_mes.forEach(x => x.lbl = mesLbl(x.mes));
  { const tot = P2.por_classe.reduce((a, x) => a + x.n, 0) || 1; const cm = { 'Rede': COR.blue, 'Aviso/Sistema': COR.faint, 'Arranjo FV': COR.teal, 'Inversor · anomalia': COR.brand, 'Inversor · isolamento': COR.warn, 'Inversor · corrente': COR.crit };
    P2.por_classe.forEach(x => { x.pct = Math.round(x.n / tot * 100); x.cor = cm[x.classe] || COR.neutral; }); }
  cruzado.exemplos.forEach(x => { x.cor = /estufado|carboni|superaque|ventoinha/i.test(x.modo_troca) ? COR.crit : (/anomalia/i.test(x.modo_troca) ? COR.brand : COR.faint); });
  // kpiTiles (legado do ticker HTML). P1 = trocas REAIS · P2 = ALARMES (não é queima) — linguagem separada de propósito.
  const kpiTiles = [
    { k: 'Trocas registradas', v: String(P1.total), u: '', c: 'P1 · desde ' + ((P1.por_mes[0] || {}).lbl || '?'), cor: COR.brand },
    { k: 'Falhas térmicas', v: String(P1.termico_pct), u: '%', c: P1.termico + ' de ' + P1.total + ' 🔥', cor: COR.crit },
    { k: 'Pior parque', v: P1.pior_parque.parque, u: '', c: P1.pior_parque.n + ' trocas', cor: COR.warn },
    { k: 'Reposição no mesmo dia', v: String(P1.reposicao.pct_mesmo_dia), u: '%', c: P1.reposicao.mesmo_dia + ' de ' + P1.reposicao.com_ambas + ' · máx ' + P1.reposicao.max_dias + 'd', cor: COR.ok },
    { k: 'MTBF frota', v: String(P1.mtbf_anos), u: 'anos', c: 'falhas reais (P1) · 1155 inv', cor: COR.blue },
    { k: 'Alarmes = rede', v: String(P2.rede_pct), u: '%', c: 'não é defeito', cor: COR.faint },
  ];
  // 🔴 O BLOB É ANÔNIMO. `inversores.json` responde HTTP 200 sem autenticação nenhuma — é assim
  // que a datasource do Grafana o lê, do navegador do leitor. Então tudo o que entra aqui é
  // PÚBLICO, e vale a mesma regra da description de painel: publica-se o NÚMERO, não o acervo.
  //
  //   - o DICIONÁRIO do fabricante não sai: são 512 procedimentos do manual Sungrow, material
  //     autoral de terceiro. O nome curto da falha continua indo, embutido nos 12 códigos do
  //     Pareto — rótulo factual é o que a página precisa ler, e é o que ela mostra;
  //   - as REGRAS DE INFERÊNCIA não saem: são método interno. A página precisa da ressalva
  //     "reportado × inferido", e ela já está em `por_origem_codigo`;
  //   - o ESTOQUE sai em CONTAGEM: o painel mostra nível de estoque, nunca número de série.
  //
  // De cada aba fica a contagem, que serve de prova de que ela foi lida — sem isso, aba que
  // parasse de chegar viraria silêncio em vez de sinal.
  //
  // ⚠️ A aba Dash não entra, a pedido: são KPIs já calculados na planilha, e número derivado que
  // chega pronto passa a divergir do que a página calcula sem ninguém perceber.
  const dm = leDescMap(wb1);
  const es = esSN;                                   // já lida lá em cima, junto com o estoque
  const dicionario = { fault_codes_lidos: DIC ? DIC.n : 0, desc_map_lidas: dm ? dm.n : 0 };
  const estoqueSN = es ? { aba: es.aba, blocos: es.blocos.map(b => ({ grupo: b.grupo, n: b.n, disponiveis: b.disponiveis })) } : null;

  const saida = { atualizado: new Date(HOJE.getTime()).toISOString().slice(0, 10), kpiTiles,
    escopo: { inversores_planta: 1155, inversores_por_parque: INV_POR_PARQUE, modelo: 'Sungrow SG350HX', p1_registros: P1.total, p2_parques: P2.parques, p2_eventos: P2.eventos, estoque }, p1: P1, p2: P2, cruzado,
    dicionario, estoque_sn: estoqueSN };

  // ---- guarda de exposição ------------------------------------------------------------------
  // 🔴 "Lembrar de não publicar" não é mecanismo. Esta guarda monta a lista do que é sensível a
  // partir da PRÓPRIA planilha — número de série, chamado, RNC e os procedimentos do manual — e
  // ABORTA a rodada se qualquer um chegar à saída. Sem ela, bastaria alguém acrescentar um campo
  // para o vazamento voltar em silêncio, e o blob é lido sem autenticação por quem tiver a URL.
  {
    const proibidos = new Set();
    const iSN = cIdx(H1, 'SN'), iCh = cIdxAny(H1, 'CHAMADO', 'Ticket'), iRn = cIdxAny(H1, 'RNC PWC', 'RNC');
    for (const i of [iSN, iCh, iRn]) { if (i < 0) continue;
      for (const r of R1.slice(hr + 1)) { const v = norm(r[i]); if (v.length >= 5) proibidos.add(v); } }
    for (const x of (DIC ? DIC.itens : [])) if (x.acao && x.acao.length >= 40) proibidos.add(x.acao);
    const txt = JSON.stringify(saida);
    // ⚠️ valor só de dígitos precisa de fronteira: um chamado de 6 dígitos casaria dentro de um
    // epoch e abortaria a rodada por engano — guarda que dá alarme falso é guarda que se desliga.
    const vazou = [...proibidos].filter(v => (/^[0-9]+$/.test(v)
      ? new RegExp('(^|[^0-9])' + v + '([^0-9]|$)').test(txt) : txt.includes(v)));
    if (vazou.length) throw new Error('EXPOSIÇÃO: ' + vazou.length + ' valor(es) sensível(is) chegaram ao blob PÚBLICO'
      + ' — ex.: "' + String(vazou[0]).slice(0, 40) + '". Corrigir a projeção antes de publicar.');
    console.log('  guarda de exposição: ' + proibidos.size + ' valores sensíveis conferidos, nenhum na saída');
  }
  return saida;
}

(async () => {
  const raws = await loadRawBuffers();
  if (!raws.length) { console.log('Nenhuma planilha .xlsx/.xlsm em "' + RAW_CONTAINER + '" — nada a processar.'); return; }
  // se o container acumular versões (nome do arquivo tem data), fica sempre com a MAIS RECENTE de cada tipo
  let wb1, wb2, m1 = -1, m2 = -1, escolhido1 = null, escolhido2 = null;
  // 🔴 ARQUIVO ILEGIVEL NAO DERRUBA A RODADA. O fluxo do Power Automate aceita agora qualquer
  // nome que CONTENHA ".xls" — mais largo que o "termina com .xlsx" de antes, de proposito, para
  // o .xlsm de 5 abas passar. O preco e que um arquivo que nao seja planilha pode aparecer aqui,
  // e XLSX.read estoura nele. Pular com aviso e o certo: se o que falhou for o P1 de verdade, a
  // guarda logo abaixo ("faltou P1") ainda derruba o job — o que se perde e so o falso positivo.
  for (const { name, buf, mod } of raws) {
    let wb; try { wb = XLSX.read(buf, { cellDates: true, type: 'buffer' }); }
    catch (e) { console.log('  ATENCAO · nao consegui ler como planilha, pulando: ' + name + ' (' + e.message.slice(0, 60) + ')'); continue; }
    const cls = classifyWb(wb);
    const t = mod ? new Date(mod).getTime() : 0;
    // 🔴 O CONTAINER ACUMULA. O nome do blob é o nome do arquivo, então cada versão que a equipe
    // salva vira um arquivo novo aqui — hoje são quatro P1, o mais antigo de 15/07. Escolher "o
    // mais recente por data de modificação" está certo para VERSÃO, e errado para RASCUNHO: uma
    // planilha marcada "Em revisao" que seja tocada passa a ganhar de todas, e o painel inteiro
    // passa a mostrar dado provisório sem nada ficar vermelho.
    if (NAO_FINAL.test(name)) { console.log('ignorado (marcado como não final):', name); continue; }
    if (cls === 'P1') { if (t >= m1) { wb1 = wb; m1 = t; escolhido1 = name; } }
    else if (cls === 'P2') { if (t >= m2) { wb2 = wb; m2 = t; escolhido2 = name; } }
    else console.log('ignorado (não é P1 nem P2):', name); }
  console.log('P1 <- ' + (escolhido1 || '(nenhum)') + '   [o mais recente de ' + raws.length + ' arquivo(s) no container]');
  console.log('P2 <- ' + (escolhido2 || '(nenhum)'));
  if (!wb1 || !wb2) throw new Error('faltou ' + (!wb1 ? 'P1 (Failure Control)' : '') + (!wb2 ? ' P2 (Registro Falhas)' : '') + ' no container');
  const out = analyze(wb1, wb2);
  const size = await writeOut(out);
  const d = out.dicionario || {}; const e = out.estoque_sn;
  console.log('inversores.json OK · P1=' + out.p1.total + ' trocas (' + out.p1.termico_pct + '% térmico) · P2=' + out.p2.eventos + ' eventos / ' + out.p2.parques.join(',') + ' · bad-actor ' + ((out.p2.bad_actors[0] || {}).inv) + ' · ' + round(size / 1024) + ' KB');
  console.log('  abas extras LIDAS · dicionário: ' + (d.fault_codes_lidos || 'AUSENTE') + ' códigos'
    + ' · regras de inferência: ' + (d.desc_map_lidas || 'AUSENTE')
    + ' · estoque: ' + (e ? e.blocos.map(b => b.grupo + ' ' + b.disponiveis + '/' + b.n).join(' · ') : 'AUSENTE'));
  console.log('  publicado: contagens. Fora do blob por ser público: procedimentos do manual, '
    + 'regras de inferência e números de série.');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
