/*
 * gen-inversores.js — confiabilidade dos inversores Sungrow -> dados/inversores.json (fonte da aba "Inversores").
 * P1 (substituições, estoque e catálogo de códigos): o arquivo que o SIGO refaz a cada lançamento, `acervo/inversores.json`
 *    no contêiner `dados` (lote inversores-sigo, 24/11/2026). A planilha de controle (.xlsm) parou de ser preenchida na virada
 *    de 24/11; a cópia dela que ainda chega ao inversores-raw é IGNORADA de propósito.
 * P2 (alarmes): a planilha Registro_Falhas_Inversores do container inversores-raw até o corte, e a base nova dali em diante.
 * Limpa/normaliza, aplica taxonomia e PRÉ-CALCULA todas as análises (pct/cor/rótulo prontos).
 * Env: a credencial pela lib-conteiner (DADOS_STORAGE, ou o OIDC do job) · RAW_CONTAINER=inversores-raw · OUT_CONTAINER=dados · OUT_BLOB=inversores.json
 *      · SIGO_BLOB=acervo/inversores.json.
 * Modo teste local: LOCAL_DIR (pasta com a planilha P2) / LOCAL_SIGO (o arquivo do SIGO, .json ou .json.gz) / LOCAL_OUT (arquivo de saída).
 */
const XLSX = require('xlsx');
const crypto = require('crypto');
const AB = require('./lib-alarmes-inversor.js');
const rot = require('./lib-rotulos.js');   // rotulo de mes nas tres linguas (paginas EN/中文)
const RAW_CONTAINER = process.env.RAW_CONTAINER || 'inversores-raw';
// planilha que o nome declara NÃO ser a vigente. O humano foi explícito: cópia antiga e rascunho
// não valem como fonte. Sai por NOME porque é o que o autor marca de propósito — conteúdo não diz
// "isto é rascunho".
const NAO_FINAL = /em\s*revis|revis[aã]o|(^|[^a-z])old([^a-z]|$)|antig|backup|c[oó]pia|(^|[^a-z])copy([^a-z]|$)|rascunho|^~\$/i;
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'inversores.json';
const SIGO_BLOB = process.env.SIGO_BLOB || 'acervo/inversores.json';
const HOJE = new Date(Date.now() - 3 * 3600 * 1000); HOJE.setUTCHours(0, 0, 0, 0);

// ---------- blob I/O (espelha gen-scada.js) ----------
function streamToBuffer(readable) { return new Promise((resolve, reject) => { const chunks = []; readable.on('data', d => chunks.push(d instanceof Buffer ? d : Buffer.from(d))); readable.on('end', () => resolve(Buffer.concat(chunks))); readable.on('error', reject); }); }
// a chave ou o OIDC do job (lib-conteiner): o bruto em inversores-raw e a saida em dados, cada um no seu conteiner
const conteiner = (nome) => require('./lib-conteiner').conteiner(nome);
async function loadRawBuffers() {
  if (process.env.LOCAL_DIR) { const fs = require('fs'), path = require('path'); const dir = process.env.LOCAL_DIR;
    return fs.readdirSync(dir).filter(n => /\.xls[xm]$/i.test(n)).map(n => ({ name: n, mod: fs.statSync(path.join(dir, n)).mtime, buf: fs.readFileSync(path.join(dir, n)) })); }
  const cont = conteiner(RAW_CONTAINER); const out = [];
  // a planilha de falhas virou .xlsm (macro) em 20/08/2026; filtrar so .xlsx a deixaria de fora
  for await (const b of cont.listBlobsFlat()) { if (!/\.xls[xm]$/i.test(b.name)) continue;
    out.push({ name: b.name, mod: (b.properties || {}).lastModified, buf: await streamToBuffer((await cont.getBlobClient(b.name).download()).readableStreamBody) }); }
  return out;
}
// o arquivo do SIGO: no contêiner `dados`, o MESMO da saída e da base de alarmes, então a credencial que o job já tem serve (gzip ou não)
async function leSigo() {
  const fs = require('fs'), zlib = require('zlib');
  const b = process.env.LOCAL_SIGO ? fs.readFileSync(process.env.LOCAL_SIGO)
    : await streamToBuffer((await conteiner(OUT_CONTAINER).getBlobClient(SIGO_BLOB).download()).readableStreamBody);
  return JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'));
}
// a base nova de alarmes (lote inversores-alarmes-base): os meses do logger e, só para o mês que ele não cobrir, o do supervisório. Falha de leitura derruba a rodada:
// cair na planilha em silêncio voltaria o selo e os números para junho sem nada ficar vermelho. LOCAL_HIST_DIR = pasta com hist/ para rodar sem rede
async function leBaseAlarmes() {
  const zlib = require('zlib'), fs = require('fs'), path = require('path');
  const agora = HOJE.toISOString().slice(0, 7), bruto = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'));
  const nomes = process.env.LOCAL_HIST_DIR ? fs.readdirSync(process.env.LOCAL_HIST_DIR).map((n) => 'hist/' + n) : null;
  const lista = async (pref) => { if (nomes) return nomes.filter((n) => n.startsWith(pref)); const o = []; for await (const b of conteiner(OUT_CONTAINER).listBlobsFlat({ prefix: pref })) o.push(b.name); return o; };
  const le = async (n) => (process.env.LOCAL_HIST_DIR ? bruto(fs.readFileSync(path.join(process.env.LOCAL_HIST_DIR, path.basename(n)))) : bruto(await streamToBuffer((await conteiner(OUT_CONTAINER).getBlobClient(n).download()).readableStreamBody)));
  const mesDe = (n) => /(\d{4})_(\d{2})\.json$/.exec(n).slice(1).join('-');
  const logger = {}, scada = {};
  // o prefixo pega também o armazém (arm) e o manifesto (lidos) do gerador do logger: só o mês publicado interessa
  const soMes = (l) => l.filter((n) => /\/alarmes_[a-z]+_\d{4}_\d{2}\.json$/.test(n));
  for (const n of soMes(await lista('hist/alarmes_logger_'))) logger[mesDe(n)] = await le(n);
  const ini = Object.keys(logger).sort()[0];
  if (!ini) throw new Error('hist/alarmes_logger_ sem nenhum mês');
  for (const n of soMes(await lista('hist/alarmes_scada_'))) { const m = mesDe(n); if (m >= ini && !logger[m]) scada[m] = await le(n); }
  return AB.base({ logger, scada, ate: agora, classePorTexto: classeP2, ...(process.env.ALARMES_CORTE_MIN ? { corte_min: process.env.ALARMES_CORTE_MIN } : {}) });
}
async function writeOut(obj) { const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const cont = conteiner(OUT_CONTAINER);   // sem createIfNotExists: o `dados` existe, e criar conteiner nao e papel do gerador
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  await escrevePortal(cont, obj);
  return json.length;
}

// portal_ativos.json — o mesmo conteudo SEM os fatos brutos, para o portal Aurora.
//
// 🔴 `inversores.json` sai com 1.306 KB NA REDE, sem compressao, e tres telas do portal o leem.
// O peso esta quase todo em tres listas de eventos linha a linha (`p2/fatos` com 7.943, `p1/fatos`
// com 172, `fatos_codigo` com 168) e no dicionario de codigos — nada disso e desenhado: as telas
// mostram os AGREGADOS que este mesmo arquivo ja traz prontos.
//
// Medido: 1.434 KB crus caem para 11 KB, e 3 KB gravado em gzip. O navegador descomprime sozinho.
//
// ⚠️ Ele nao recalcula nada. Se um numero do portal divergir do painel do Grafana, o defeito esta
// na PODA — nunca na conta, porque conta aqui nao ha.
async function escrevePortal(cont, obj) {
  const PODAR = { p1: ['fatos', 'fatos_codigo'], p2: ['fatos'] };
  const leve = JSON.parse(JSON.stringify(obj));
  delete leve.dicionario;
  for (const [ramo, chaves] of Object.entries(PODAR)) {
    if (!leve[ramo]) continue;
    for (const k of chaves) delete leve[ramo][k];
  }
  // A guarda que impede a poda de virar perda: os agregados que as telas leem tem de sobreviver.
  const exigidos = [['p1', 'total'], ['p1', 'por_modo'], ['p1', 'por_parque'], ['p1', 'por_mes'],
    ['p2', 'eventos'], ['p2', 'por_classe'], ['p2', 'bad_actors'], ['p2', 'por_parque'],
    ['escopo', 'inversores_por_parque']];
  const faltam = exigidos.filter(([a, b]) => leve[a] == null || leve[a][b] == null);
  if (faltam.length) { console.log('portal_ativos.json NAO gerado — a poda levou ' + faltam.map(x => x.join('.')).join(', ')); return; }
  const gz = require('zlib').gzipSync(Buffer.from(JSON.stringify(leve), 'utf8'));
  await cont.getBlockBlobClient('portal_ativos.json').upload(gz, gz.length, {
    blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  console.log(`portal_ativos.json OK · ${(gz.length / 1024).toFixed(1)} KB (de ${(JSON.stringify(obj).length / 1024).toFixed(0)} KB crus)`);
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

// ---------- P1 · o arquivo do SIGO (lote inversores-sigo, 24/11/2026) ----------
// A REGRA continua morando FORA daqui: o catálogo de códigos (manual Sungrow) e as regras de inferência vêm no próprio arquivo do
// SIGO, que os herdou da planilha na carga. Reescrevê-los no gerador criaria uma terceira cópia, e cópia é o que envelhece diferente.
const USINAS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const FASES = ['L1', 'L2', 'L3'];
const ITEM_INI_SALDO = 166;   // o saldo de fusíveis desconta o consumo da troca nº 166 em diante: o mesmo critério do SIGO
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const diaLocal = (v) => { if (v == null || v === '') return null; if (!RE_DIA.test(String(v))) return null;
  const [y, mo, d] = String(v).split('-').map(Number); const x = new Date(y, mo - 1, d);
  return (x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d) ? x : null; };
const inteiro = (v) => typeof v === 'number' && Number.isInteger(v);
const shaBase = (B) => { const s = Object.assign({}, B); delete s.meta; return crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16); };

// 🔴 O ARQUIVO SÓ ENTRA INTEIRO E COERENTE. Cada conferência que não fecha DERRUBA a rodada e o blob publicado fica como está:
// painel parado num dia conhecido custa uma correção; painel com troca a menos, saldo errado ou arquivo pela metade custa a
// confiança na página, e nada ficaria vermelho. Não há volta silenciosa para a planilha: ela parou e mostraria um estado velho.
function confereSigo(doc) {
  const erro = (m) => { throw new Error('arquivo do SIGO recusado: ' + m); };
  if (!doc || typeof doc !== 'object' || !doc.BASE || !doc.META) erro('sem BASE e META');
  const B = doc.BASE, M = doc.META, L = M.linhas || {};
  if (!/^SIGO\b/.test(String(M.origem || ''))) erro('a origem não é o SIGO ("' + String(M.origem).slice(0, 60) + '"); o arquivo ainda é o da planilha');
  if (shaBase(B) !== M.sha256_16) erro('o conteúdo não bate com a impressão digital do próprio arquivo (' + shaBase(B) + ' × ' + M.sha256_16 + ')');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(String(M.modificadoEm || ''))) erro('sem a hora do último lançamento');
  const S = B.substituicoes;
  if (!Array.isArray(S) || !S.length) erro('sem trocas');
  if (S.length !== L.substituicoes) erro(S.length + ' trocas no arquivo × ' + L.substituicoes + ' declaradas');
  const vistos = new Set();
  for (const s of S) {
    const id = 'troca nº ' + s.item + ': ';
    if (!inteiro(s.item) || s.item < 1) erro('número de troca inválido (' + JSON.stringify(s.item) + ')');
    if (vistos.has(s.item)) erro('número de troca repetido (' + s.item + ')');
    vistos.add(s.item);
    if (!USINAS.includes(s.parque)) erro(id + 'usina fora do conjunto (' + s.parque + ')');
    if (!/^TS\d{1,2}$/.test(String(s.ts)) || !/^INV\d{1,2}$/.test(String(s.inv))) erro(id + 'posição ilegível (' + s.ts + ' · ' + s.inv + ')');
    for (const k of ['data', 'dataSubstituicao']) if (s[k] != null && !diaLocal(s[k])) erro(id + k + ' não é dia (' + s[k] + ')');
    const f = s.fusiveisDanificados;
    if (!inteiro(f) || f < 0 || f > 3) erro(id + 'fusíveis fora de 0 a 3 (' + JSON.stringify(f) + ')');
    if (f > 0) { const fa = String(s.fases || '').split('/').map((x) => x.trim());
      if (fa.length !== f || new Set(fa).size !== f || !fa.every((x) => FASES.includes(x))) erro(id + 'as fases (' + s.fases + ') não batem com ' + f + ' fusível(is)'); }
    else if (![0, null, ''].includes(s.fases == null ? null : s.fases)) erro(id + 'fases (' + s.fases + ') sem fusível');
    if (s.origem != null && !['New', 'Repaired'].includes(s.origem)) erro(id + 'tipo do inversor instalado ilegível (' + s.origem + ')');
  }
  if (!Array.isArray(B.codigos) || B.codigos.length !== L.codigos) erro('catálogo de códigos incompleto');
  if (!Array.isArray(B.inferencia) || B.inferencia.length !== L.inferencia) erro('regras de inferência incompletas');
  const E = B.estoqueSerie || {}, R = B.resumoAlmoxarifado || {};
  if (!Array.isArray(E.novos) || E.novos.length !== L.estoqueNovos || !Array.isArray(E.reparados) || E.reparados.length !== L.estoqueReparados) erro('estoque por série incompleto');
  const disp = (l) => l.filter((x) => x.situacao === 'DISPONIVEL').length;
  if (R.novos !== disp(E.novos) || R.reparados !== disp(E.reparados)) erro('o resumo do estoque (' + R.novos + ' novos, ' + R.reparados + ' reparados) não bate com a lista por série');
  if (!Array.isArray(B.fusiveisMov)) erro('sem os movimentos de fusível');
  for (const x of B.fusiveisMov) if (!diaLocal(x.data) || !inteiro(x.qtd) || x.qtd === 0) erro('movimento de fusível ilegível (' + JSON.stringify(x).slice(0, 80) + ')');
  const saldo = B.fusiveisMov.reduce((a, x) => a + x.qtd, 0) - S.filter((s) => s.item >= ITEM_INI_SALDO).reduce((a, s) => a + s.fusiveisDanificados, 0);
  if (!inteiro(R.fusiveis) || saldo !== R.fusiveis) erro('saldo de fusíveis ' + R.fusiveis + ' × ' + saldo + ' refeito dos movimentos e das trocas do nº ' + ITEM_INI_SALDO + ' em diante');
  return { trocas: S.length, saldo, modificadoEm: M.modificadoEm, sha: M.sha256_16 };
}

// o arquivo do SIGO na forma das linhas que a análise sempre usou. Só traduz: nenhuma conta mora aqui.
function p1DoSigo(doc) {
  const B = doc.BASE;
  const p1 = B.substituicoes.map((s) => {
    const { modo, termico } = modoP1(s.descricaoFalha);
    const date = diaLocal(s.data); const fut = date && date > HOJE;
    const codigos = s.codigo == null ? [] : String(s.codigo).split(/[,;\/]/).map((x) => x.trim()).filter((x) => /^\d+$/.test(x));
    const fusQtd = s.fusiveisDanificados || 0;
    return { parque: s.parque, ts: tsNorm(s.ts), inv: invNorm(s.inv), modo, termico, date: (date && !fut) ? date : null, sub: diaLocal(s.dataSubstituicao),
      codigos, fusAval: s.fusiveisDanificados != null, fusDan: fusQtd > 0, fusQtd,
      // só as fases do fusível danificado: a planilha anotava "0" na coluna das trocas sem fusível, e o "0" entrava como uma fase
      fases: fusQtd > 0 ? String(s.fases).split('/').map((x) => x.trim().toUpperCase()).filter(Boolean) : [],
      orig: normOrig(s.origem), codOrig: norm(s.origemCodigo), codNome: norm(s.nomeFalha), comis: norm(s.comissionado) };
  });
  const R = B.resumoAlmoxarifado, E = B.estoqueSerie;
  const estoque = { novo: R.novos, reparado: R.reparados, fusivel: R.fusiveis, origem: 'estoque por número de série (disponíveis)' };
  const bloco = (grupo, l) => ({ grupo, n: l.length, disponiveis: l.filter((x) => x.situacao === 'DISPONIVEL').length });
  const estoqueSN = { blocos: [bloco('INVERSORES NOVOS', E.novos), bloco('INVERSORES REPARADOS', E.reparados)] };
  const nomeDe = new Map(B.codigos.map((x) => [String(x.codigo), norm(x.nome)]));
  // o que nunca pode chegar ao blob: número de série (retirado, instalado e de estoque), chamado, RNC e os procedimentos do manual
  const proibidos = new Set();
  for (const s of B.substituicoes) for (const k of ['sn', 'markup', 'chamado', 'rnc']) { const v = norm(s[k]); if (v.length >= 5) proibidos.add(v); }
  for (const x of [].concat(E.novos, E.reparados)) { const v = norm(x.serie); if (v.length >= 5) proibidos.add(v); }
  for (const x of B.codigos) { const v = norm(x.acaoCorretiva); if (v.length >= 40) proibidos.add(v); }
  return { p1, estoque, estoqueSN, nomeDe, nCodigos: B.codigos.length, nInferencia: B.inferencia.length, proibidos };
}

// ---------- análise ----------
function analyze(sigo, wb2, base) {
  // P1 · as trocas, o estoque e o catálogo saem do arquivo do SIGO, já conferido (confereSigo) por quem chama
  const F1 = p1DoSigo(sigo);
  const p1 = F1.p1, estoque = F1.estoque;

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
  const nomeDe = F1.nomeDe;
  P1.por_codigo = tally(p1.flatMap(x => x.codigos)).slice(0, 12)
    .map(([codigo, n]) => ({ codigo, n, nome: nomeDe.get(codigo) || '' }));
  // ⚠️ Registrado × inferido é ressalva, não enfeite: código deduzido da descrição não tem o
  // mesmo peso do que veio do próprio inversor, e a página precisa poder dizer isso.
  P1.por_origem_codigo = tally(p1.map(x => x.codOrig).filter(Boolean)).map(([origem, n]) => ({ origem, n }));
  P1.comissionamento = tally(p1.map(x => x.comis).filter(Boolean)).map(([estado, n]) => ({ estado, n }));
  P1.com_codigo = p1.filter(x => x.codigos.length).length;
  // Fusíveis (colunas novas — enchem com o tempo): quantos avaliados, quantos danificaram, fases afetadas
  const fusAv = p1.filter(x => x.fusAval);
  P1.fusiveis = { avaliados: fusAv.length, com_dano: fusAv.filter(x => x.fusDan).length, sem_dano: fusAv.filter(x => !x.fusDan).length,
    fusiveis_total: p1.reduce((a, x) => a + x.fusQtd, 0), por_fase: tally(p1.flatMap(x => x.fases)).map(([fase, n]) => ({ fase, n })) };   // dinâmico: A/B/C ou L1/L2/L3
  // Origem do inversor de reposição (novo × reparado)
  P1.por_origem = tally(p1.map(x => x.orig).filter(Boolean)).map(([origem, n]) => ({ origem, n }));
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
  // inversores-alarmes-base (06/11/2026): a planilha fica até o mês anterior ao logger; dali em diante, a base nova. A conta é a mesma (lib-alarmes-inversor)
  const J2 = AB.junta(ev, base, ym);
  console.log('P2: planilha até antes de ' + base.corte + ' · ' + J2.planilha + ' linhas · base nova ' + J2.base + ' · fora: ' + J2.fora.depois_do_corte + ' depois do corte, ' + J2.fora.sem_data + ' sem data');
  const { P2, evInv } = AB.agregaP2(J2.ev, parques, { tally, ym, mesLbl, round, ehInversor });

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
  // o painel de confiabilidade em ingles lia `lbl` sem irma e mostrava o mes em portugues
  rot.localizaTudo(P1.por_mes, ['lbl']); rot.localizaTudo(P2.isolamento_por_mes, ['lbl']);
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
  // Do catálogo e das regras fica a contagem, que serve de prova de que vieram no arquivo — sem isso, parte que
  // parasse de chegar viraria silêncio em vez de sinal.
  const dicionario = { fault_codes_lidos: F1.nCodigos, desc_map_lidas: F1.nInferencia };
  const estoqueSN = F1.estoqueSN;

  const saida = { atualizado: new Date(HOJE.getTime()).toISOString().slice(0, 10), kpiTiles,
    escopo: { inversores_planta: 1155, inversores_por_parque: INV_POR_PARQUE, modelo: 'Sungrow SG350HX', p1_registros: P1.total, p2_parques: P2.parques, p2_eventos: P2.eventos, estoque }, p1: P1, p2: P2, cruzado,
    dicionario, estoque_sn: estoqueSN };

  // ---- guarda de exposição ------------------------------------------------------------------
  // 🔴 "Lembrar de não publicar" não é mecanismo. Esta guarda monta a lista do que é sensível a
  // partir do PRÓPRIO arquivo de origem — número de série, chamado, RNC e os procedimentos do manual — e
  // ABORTA a rodada se qualquer um chegar à saída. Sem ela, bastaria alguém acrescentar um campo
  // para o vazamento voltar em silêncio.
  {
    const proibidos = F1.proibidos;
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

async function main() {
  // 1. o arquivo do SIGO, conferido ANTES de qualquer outra leitura: recusado, a rodada para aqui e o blob publicado fica
  const sigo = await leSigo();
  const ok = confereSigo(sigo);
  console.log('P1 <- SIGO · ' + ok.trocas + ' trocas · último lançamento ' + ok.modificadoEm + ' · saldo de fusíveis ' + ok.saldo + ' · ' + ok.sha);
  const raws = await loadRawBuffers();
  // 2. a planilha de alarmes (P2): a mais recente; a planilha de controle de falhas (P1) que ainda chega ao contêiner é ignorada
  let wb2, m2 = -1, escolhido2 = null, p1Ignorados = 0;
  // 🔴 ARQUIVO ILEGIVEL NAO DERRUBA A RODADA. O fluxo do Power Automate aceita qualquer nome que
  // CONTENHA ".xls". O preco e que um arquivo que nao seja planilha pode aparecer aqui, e XLSX.read
  // estoura nele. Pular com aviso e o certo: se o que falhou for o P2 de verdade, a guarda logo
  // abaixo ("faltou P2") ainda derruba o job — o que se perde e so o falso positivo.
  for (const { name, buf, mod } of raws) {
    let wb; try { wb = XLSX.read(buf, { cellDates: true, type: 'buffer' }); }
    catch (e) { console.log('  ATENCAO · nao consegui ler como planilha, pulando: ' + name + ' (' + e.message.slice(0, 60) + ')'); continue; }
    const cls = classifyWb(wb);
    const t = mod ? new Date(mod).getTime() : 0;
    // 🔴 O CONTAINER ACUMULA. O nome do blob é o nome do arquivo, então cada versão que a equipe
    // salva vira um arquivo novo aqui. Escolher "o mais recente por data de modificação" está certo
    // para VERSÃO, e errado para RASCUNHO: uma planilha marcada "Em revisao" que seja tocada passa a
    // ganhar de todas, e o painel inteiro passa a mostrar dado provisório sem nada ficar vermelho.
    if (NAO_FINAL.test(name)) { console.log('ignorado (marcado como não final):', name); continue; }
    if (cls === 'P1') p1Ignorados++;
    else if (cls === 'P2') { if (t >= m2) { wb2 = wb; m2 = t; escolhido2 = name; } }
    else console.log('ignorado (não é P1 nem P2):', name); }
  console.log('P2 <- ' + (escolhido2 || '(nenhum)') + '   [' + raws.length + ' arquivo(s) no container; ' + p1Ignorados + ' planilha(s) de falhas ignorada(s): a fonte das trocas é o SIGO]');
  if (!wb2) throw new Error('faltou P2 (Registro Falhas) no container');
  const base = await leBaseAlarmes();
  const out = analyze(sigo, wb2, base);
  // Frescor da FONTE, para o selo do cabecalho (gen-fontes-saude) e a malha (gen-malha-estado): o último lançamento
  // (troca, correção, exclusão ou entrada de estoque) no SIGO e ate onde o dado de alarmes chega. Um registro parado nao e
  // registro velho — por isso a hora do registro vai SEPARADA da data da última troca. O nome do campo continua o de antes
  // porque o selo e a malha o leem; o valor passa a ser a hora do último lançamento (BRT no arquivo do SIGO).
  out.fontes = {
    substituicoes_planilha_em: new Date(sigo.META.modificadoEm + '-03:00').toISOString(),
    alarmes_planilha_em: m2 > 0 ? new Date(m2).toISOString() : null,
    substituicoes_ultima: out.p1.fatos.map(x => x.data).filter(Boolean).sort().pop() || null,
    alarmes_ultimo_mes: out.p2.fatos.map(x => x.mes).filter(Boolean).sort().pop() || null,
    alarmes_ultimo_dia: base.ultimo_dia,
    alarmes_base_desde: base.corte,
    alarmes_base_meses: base.por_mes,
    alarmes_sem_cobertura: base.sem_cobertura,
  };
  const size = await writeOut(out);
  const d = out.dicionario || {}; const e = out.estoque_sn;
  console.log('inversores.json OK · P1=' + out.p1.total + ' trocas (' + out.p1.termico_pct + '% térmico) · P2=' + out.p2.eventos + ' eventos / ' + out.p2.parques.join(',') + ' · bad-actor ' + ((out.p2.bad_actors[0] || {}).inv) + ' · ' + round(size / 1024) + ' KB');
  console.log('  partes do SIGO LIDAS · dicionário: ' + d.fault_codes_lidos + ' códigos'
    + ' · regras de inferência: ' + d.desc_map_lidas
    + ' · estoque: ' + e.blocos.map(b => b.grupo + ' ' + b.disponiveis + '/' + b.n).join(' · ') + ' · fusíveis ' + out.escopo.estoque.fusivel);
  console.log('  publicado: contagens. Fora do blob: procedimentos do manual, regras de inferência e números de série.');
}

module.exports = { confereSigo, p1DoSigo, analyze, shaBase, ITEM_INI_SALDO };
if (require.main === module) main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });

