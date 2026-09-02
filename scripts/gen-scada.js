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

// Reparo do RTC do M3: o circuito 2 = cubiculo CUB_10.1 registrou 50% da potencia real ate o
// conserto fisico em 12/07/2026. SCADA e ONS herdaram o erro; o Way2 nao (RTC de faturamento).
// Correcao: dobrar SO essa coluna, SO antes de 12/07 — com guard (a coluna tem que estar mesmo
// em ~50% das irmas) para nao corrigir dado sadio se o cabecalho variar.
const RTC_M3 = { park: 'M3', colRe: /CUB[_ ]?10[._]1(?![0-9])/i, before: '2026-07-12', factor: 2 };

// Extrai {diario:{dia:MWh}, intra15:{dia:[96]}} de uma planilha (buffer) de um parque.
function parseParkBuffer(buf, park) {
  const wb = XLSX.read(buf, { cellDates: true });
  const sn = wb.SheetNames.find(n => /interpola/i.test(n)) || wb.SheetNames[wb.SheetNames.length - 1];
  const ws = wb.Sheets[sn];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true });
  if (!rows.length) return { diario: {}, intra15: {} };
  const hdr = rows[0];
  const wattCols = [];
  for (let i = 0; i < hdr.length; i++) if (hdr[i] && /CVMMXN1_Wa/i.test(String(hdr[i]))) wattCols.push(i);
  // POTENCIA REATIVA: coluna CVMMXN1_VolAmpr (Volt-Ampere reativo, MVAr). Vem de dois lugares —
  // inline nos arquivos novos (junto do Watt) e sozinha nos arquivos da pasta P_RE. A presenca
  // das colunas decide o papel do arquivo: tem Watt -> ativa (+reativa se houver); so VolAmpr -> P_RE.
  const varCols = [];
  for (let i = 0; i < hdr.length; i++) if (hdr[i] && /CVMMXN1_VolAmpr/i.test(String(hdr[i]))) varCols.push(i);
  // DIAGNOSTICO DA POTENCIA REATIVA: lista as colunas que NAO sao potencia ativa, para eu
  // descobrir o nome da coluna de reativa (provavelmente CVMMXN1_VAr) sem adivinhar — mesma
  // abordagem do CUB_10.1. So loga uma vez por parque, so quando pedido (DIAG_COLS=1).
  if (process.env.DIAG_COLS && park) {
    // ABAS da planilha: se a reativa estiver numa 2a aba (nao na "Interpolacao"), aparece aqui.
    console.log('DIAG_ABAS [' + park + '] abas do arquivo: ' + wb.SheetNames.join(' | '));
    // colunas que casam VAr/reativa em QUALQUER aba (nao so na lida) — pega a reativa onde estiver
    for (const aba of wb.SheetNames) {
      const h0 = (XLSX.utils.sheet_to_json(wb.Sheets[aba], { header: 1, raw: true })[0]) || [];
      const var_ = h0.filter(x => x && /VAr|reativ|reactive/i.test(String(x)));
      if (var_.length) console.log('DIAG_VAR [' + park + '] aba "' + aba + '" tem ' + var_.length
        + ' coluna(s) de reativa. Ex.: ' + var_.slice(0, 3).map(String).join(' , '));
    }
    const outras = [];
    for (let i = 1; i < hdr.length; i++) {
      if (!hdr[i] || wattCols.includes(i)) continue;
      outras.push(String(hdr[i]));
    }
    console.log('DIAG_COLS [' + park + '] ' + wattCols.length + ' colunas de potencia ativa (Watt). '
      + 'Outras ' + outras.length + ' colunas:');
    outras.slice(0, 12).forEach(h => console.log('    ' + h));
    if (outras.length > 12) console.log('    ... e mais ' + (outras.length - 12));
  }
  // SEM COLUNA CASADA = NAO SEI, e nao "gerou zero". Antes o laco abaixo somava P=0 em toda linha
  // e gravava 0 MWh no dia — silenciosamente. Foi assim que set/25..jun/26 entrou zerado no blob:
  // as planilhas CHEGARAM e foram lidas, mas com cabecalho diferente do esperado. Zero por falha de
  // parsing e indistinguivel de usina parada, e contamina qualquer media feita por cima.
  // Tambem protege contra planilha de outra grandeza (ex.: potencia reativa) entrar como ativa.
  if (!wattCols.length && !varCols.length) {
    const amostra = hdr.filter(Boolean).slice(0, 6).map(String).join(' | ');
    throw new Error('nenhuma coluna de potencia ativa (CVMMXN1_Wa) nem reativa (VolAmpr) na aba "' + sn
      + '". Cabecalho encontrado: ' + (amostra || '(vazio)'));
  }
  // qual wattCol e o circuito 2 do M3 (CUB_10.1) — so relevante quando park === M3
  const fixK = (park === RTC_M3.park) ? wattCols.findIndex(c => RTC_M3.colRe.test(String(hdr[c]))) : -1;

  const diario = {}, intra15 = {};
  // SLOT DE 5 MIN. A planilha ja e amostrada de 5 em 5 min, entao o de 15 nunca foi a resolucao
  // da fonte — era a resolucao do consumidor. O comparativo contra o medidor precisa do detalhe
  // fino, e derivar 5 a partir de 15 seria inventar um patamar que ninguem mediu.
  const intra5 = {};
  // energia por COLUNA ate 11/07 (pre-reparo) — diagnostico e guard do reparo do RTC.
  const porCol = wattCols.map((c) => ({ ate11: 0, cabeca: String(hdr[c]) }));
  // contribuicao do circuito defeituoso, por dia/slot, SO pre-reparo — usada p/ aplicar o ×2
  // depois do guard passar (nao dobro antes, senao um cabecalho errado corromperia o dado).
  const fixDay = {}, fixIntra = {}, fixIntra5 = {};
  // REATIVA: acumuladores de SOMA e CONTAGEM por slot (a reativa vira MEDIA de MVAr, nao energia
  // integrada como a ativa) e por dia (media/min/max do dia).
  const reaSum = {}, reaN = {}, reaDia = {};
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    let t = row[0];
    if (!(t instanceof Date) || isNaN(t)) continue;
    // timestamps vem com fracao de segundo (ex.: 11:44:59.998 = 11:45); arredonda p/ minuto antes de bucketizar
    t = new Date(Math.round(t.getTime() / 60000) * 60000);
    const day = t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
    const idx = Math.floor((t.getHours() * 60 + t.getMinutes()) / 15);
    if (idx < 0 || idx > 95) continue;
    const idx5 = Math.floor((t.getHours() * 60 + t.getMinutes()) / 5);
    const pre = day < RTC_M3.before;
    // ---- potencia ATIVA (energia MWh, somada) ----
    if (wattCols.length) {
      let P = 0, algum = false;
      for (let k = 0; k < wattCols.length; k++) { const v = row[wattCols[k]];
        if (v === '' || v == null || isNaN(+v)) continue;
        algum = true; const e = (+v) * 5 / 60; P += +v;
        if (pre) porCol[k].ate11 += e;
        if (k === fixK && pre) { fixDay[day] = (fixDay[day] || 0) + e;
          (fixIntra[day] = fixIntra[day] || new Array(96).fill(0))[idx] += e;
          (fixIntra5[day] = fixIntra5[day] || new Array(288).fill(0))[idx5] += e; }
      }
      if (algum) {
        const e = P * 5 / 60; // MWh nesta amostra de 5min
        if (!intra15[day]) intra15[day] = new Array(96).fill(0);
        intra15[day][idx] += e;
        if (!intra5[day]) intra5[day] = new Array(288).fill(0);
        intra5[day][idx5] += e;
        diario[day] = (diario[day] || 0) + e;
      }
    }
    // ---- potencia REATIVA (MVAr instantaneo, MEDIA) ----
    if (varCols.length) {
      let Q = 0, algum = false;
      for (const c of varCols) { const v = row[c]; if (v === '' || v == null || isNaN(+v)) continue; algum = true; Q += +v; }
      if (algum) {
        if (!reaSum[day]) { reaSum[day] = new Array(96).fill(0); reaN[day] = new Array(96).fill(0); reaDia[day] = []; }
        reaSum[day][idx] += Q; reaN[day][idx]++; reaDia[day].push(Q);
      }
    }
  }

  // ---- aplica o reparo do RTC (dobra o circuito 2), com guard ----
  let rtc = null;
  if (fixK >= 0) {
    const alvo = porCol[fixK].ate11;
    const irmas = porCol.filter((_, k) => k !== fixK).map(c => c.ate11).filter(v => v > 0).sort((a, b) => a - b);
    const medIrma = irmas.length ? irmas[Math.floor(irmas.length / 2)] : 0;
    const razao = medIrma > 0 ? alvo / medIrma : null;
    // guard: so dobra se a coluna estiver entre 35% e 70% das irmas (assinatura do RTC a 50%).
    // Fora disso, NAO mexe — protege contra cabecalho enganoso ou circuito legitimamente menor.
    const ok = razao != null && razao >= 0.35 && razao <= 0.70;
    if (ok) {
      const f = RTC_M3.factor - 1;
      for (const d in fixDay) diario[d] += f * fixDay[d];
      for (const d in fixIntra) for (let i = 0; i < 96; i++) intra15[d][i] += f * fixIntra[d][i];
      // 🔴 O reparo tem de alcancar as DUAS resolucoes. Corrigir so o de 15 min deixaria o M3
      // com metade da potencia no de 5 — e a divergencia contra o medidor apareceria como se o
      // supervisorio estivesse errado, quando o errado seria este gerador.
      for (const d in fixIntra5) for (let i = 0; i < 288; i++) intra5[d][i] += f * fixIntra5[d][i];
    }
    rtc = { col: porCol[fixK].cabeca, razao, aplicado: ok, dias: Object.keys(fixDay).length };
  }

  // ---- consolida a reativa: media MVAr por slot (soma/contagem) e resumo diario ----
  let reativa = null;
  if (varCols.length) {
    const r3 = (x) => Math.round(x * 1000) / 1000;   // MVAr com 3 casas
    const intra = {}, dia = {};
    for (const d in reaSum) {
      intra[d] = reaSum[d].map((s, i) => reaN[d][i] ? r3(s / reaN[d][i]) : null);
      const vs = reaDia[d];
      dia[d] = { media: r3(vs.reduce((a, b) => a + b, 0) / vs.length),
        min: r3(Math.min(...vs)), max: r3(Math.max(...vs)), n: vs.length };
    }
    reativa = { intra15: intra, diario: dia, circuitos: varCols.length };
  }
  return { diario, intra15, intra5, porCol, rtc, reativa };
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
    // ---- inventario do container, antes de qualquer filtro -------------------------------------
  // 🔴 Saber O QUE HA no container e diferente de saber o que o filtro aceitou. Sem isto, um
  // "nenhuma planilha encontrada" nao diz se o container esta vazio ou se o padrao nao casou —
  // e as duas hipoteses mandam procurar em lugares opostos.
  { const inv = {}; let tot = 0; const amostra = [];
    for await (const b of cont.listBlobsFlat()) {
      tot++;
      const e = (b.name.split('/').pop().match(/\.[a-z0-9]+$/i) || ['(sem)'])[0].toLowerCase();
      inv[e] = (inv[e] || 0) + 1;
      if (amostra.length < 8) amostra.push(b.name.split('/').pop().slice(0, 44));
    }
    console.log('INVENTARIO de "' + RAW_CONTAINER + '": ' + tot + ' blob(s) · '
      + Object.entries(inv).map(([e, c]) => e + ':' + c).join(' '));
    console.log('  primeiros nomes: ' + (amostra.join(' | ') || '(vazio)'));
    const iirr = [];
    for await (const b of cont.listBlobsFlat()) {
      const n = b.name.split('/').pop();
      // ⚠️ CONTENDO, nao comecando por: o blob chega como <id>_<nome> e ancorar no inicio faz a
      // investigacao confirmar a hipotese errada — foi o que aconteceu na primeira rodada.
      if (/IIRR/i.test(n) || /Trafo/i.test(n)) iirr.push(n + ' (' + Math.round((b.properties.contentLength || 0) / 1048576) + ' MB)');
    }
    console.log('  exports IIRR/Trafo: ' + (iirr.slice(0, 6).join(' | ') || 'NENHUM'));
  }
  // ---- LE TODAS, em ordem NUMERICA de id ------------------------------------------------------
  // 🔴 NAO filtrar por "a mais recente de cada nome". Tentei em 25/08/2026 e era PERIGOSO: o
  // export virou INCREMENTAL — medido, a versao mais nova de M4.xlsx tem 0,2 MB e a maior tem
  // 38,2 MB. As recentes sao a fatia do dia; as grandes sao o despejo historico. Ler so a mais
  // recente perderia o historico numa reconstrucao do zero, e a rodada passaria VERDE porque o
  // gerador mescla com o blob anterior — nada quebra, e a capacidade de reconstruir some calada.
  //
  // O que a ordem numerica conserta: o merge la embaixo e "o ultimo a escrever vence", e a ordem
  // vinha da listagem, que e LEXICOGRAFICA pelo nome. Hoje coincide porque todos os ids tem cinco
  // digitos; quando passarem de 99999, "100000_M4.xlsx" viria ANTES de "79210_M4.xlsx" e a versao
  // VELHA venceria. Ordenar pelo id numerico remove a armadilha antes de ela disparar.
  //
  // ⚠️ Custa 1,4 GB e ~8 min por rodada, e isso e o preco de poder reconstruir. Se um dia doer,
  // a saida NAO e filtrar aqui: e o container parar de acumular, do lado de quem escreve.
  const todos = [];
  for await (const b of cont.listBlobsFlat()) {
    if (!/\.xlsx$/i.test(b.name)) continue;
    const m = b.name.split('/').pop().match(/^(\d+)_/);
    todos.push({ nome: b.name, id: m ? Number(m[1]) : 0, bytes: b.properties.contentLength || 0 });
  }
  todos.sort((a, b) => a.id - b.id || (a.nome < b.nome ? -1 : 1));
  console.log('  planilhas: ' + todos.length + ' blob(s) .xlsx · '
    + Math.round(todos.reduce((a, x) => a + x.bytes, 0) / 1048576) + ' MB · lidas da mais ANTIGA para a mais NOVA');
  for (const e of todos) {
    const buf = await streamToBuffer((await cont.getBlobClient(e.nome).download()).readableStreamBody);
    out.push({ name: e.nome, buf });
  }
  return out;
}

// O blob de 5 minutos e SEPARADO e limitado. Enfiar o detalhe fino no scada_comparativo.json
// triplicaria um arquivo que ja levava ~10 s para baixar, e penalizaria toda pagina que so quer o
// diario. A janela cobre com folga a do comparativo de 5 min (30 dias).
const BLOB_5MIN = process.env.OUT_BLOB_5MIN || 'scada_5min.json';

// O caminho do arquivo de 5 min no modo de ensaio sai do MESMO diretorio do principal.
// Nao usar expressao regular aqui e deliberado: a versao anterior recortava o nome com
// `[^/]*$` e, num caminho Windows com barra invertida, casava a string INTEIRA — o arquivo
// ia parar no diretorio corrente em vez do de destino, calado.
function caminho5(principal) {
  const path = require('path');
  return path.join(path.dirname(principal), BLOB_5MIN);
}
const JANELA_5MIN = Math.max(1, parseInt(process.env.JANELA_5MIN || '40', 10) || 40);

// 🔴 O BLOB PASSOU A SER GRAVADO COMPRIMIDO, entao a leitura tem de saber descomprimir. Um blob
// gravado em gzip e lido como texto vira JSON invalido — e o `catch` que devolvia estrutura vazia
// transformaria isso em "primeira execucao", regravando 597 dias com os poucos desta rodada.
// Por isso o gunzip vem antes do parse, e a deteccao e pelos dois bytes magicos do gzip.
function descomprime(buf) {
  if (buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b) return require('zlib').gunzipSync(buf);
  return buf;
}

function parseJson(buf) {
  let t = descomprime(buf).toString('utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
}

async function leBlobOpcional(nome) {
  try {
    const svc = await getBlobClient();
    const bc = svc.getContainerClient(OUT_CONTAINER).getBlobClient(nome);
    if (!(await bc.exists())) return null;
    return parseJson(await streamToBuffer((await bc.download()).readableStreamBody));
  } catch (e) { return null; }
}

async function loadExistingOut() {
  const vazio = { diario: {}, intra15: {}, intra5: {} };
  if (process.env.LOCAL_OUT) {
    const fs = require('fs');
    let base = vazio;
    if (fs.existsSync(process.env.LOCAL_OUT)) {
      try { base = parseJson(fs.readFileSync(process.env.LOCAL_OUT)); } catch (e) {}
    }
    const p5 = caminho5(process.env.LOCAL_OUT);
    if (fs.existsSync(p5)) {
      try { base.intra5 = (parseJson(fs.readFileSync(p5)) || {}).intra5 || {}; } catch (e) {}
    }
    return base;
  }
  const base = (await leBlobOpcional(OUT_BLOB)) || vazio;
  // O detalhe de 5 min mora noutro arquivo, entao tem de ser recarregado — senao a gravacao
  // seguinte publicaria so os dias desta rodada e apagaria a janela inteira em silencio.
  const cinco = await leBlobOpcional(BLOB_5MIN);
  base.intra5 = (cinco && cinco.intra5) || {};
  return base;
}

// 🔴 O AZURE NAO COMPRIME SOZINHO — ele serve exatamente os bytes gravados. Medido em 23/08/2026:
// o scada_comparativo.json saia com 6.501 KB na rede e levava ~10 s, mesmo com o cliente pedindo
// gzip. Gravando ja comprimido, com o header Content-Encoding, navegador e datasource descomprimem
// sozinhos e nenhum consumidor precisa mudar.
async function gravaUm(cont, nome, obj, segundos) {
  const json = JSON.stringify(obj);
  const gz = require('zlib').gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  await cont.getBlockBlobClient(nome).upload(gz, gz.length, {
    blobHTTPHeaders: {
      blobContentType: 'application/json',
      blobContentEncoding: 'gzip',
      blobCacheControl: 'public, max-age=' + segundos,
    },
  });
  return { cru: Buffer.byteLength(json), gz: gz.length };
}

// portal_scada.json — o resumo LEVE da tela de SCADA do portal Aurora.
//
// 🔴 `scada_comparativo.json` sai com 1.201 KB, e a tela do portal so mostra COBERTURA e ATRASO:
// quantos dias cada usina tem, ate quando, e quanto a planilha esta atras de hoje. Baixar 1,2 MB
// para contar chaves e desperdicio — e sao justamente os numeros que envelhecem todo dia (a tela
// dizia "606 dias" e "29/08" com o arquivo ja em 608 e 31/08).
//
// ⚠️ A RAZAO contra o medidor NAO entra aqui, e a ausencia e deliberada. Ela e uma caracteristica
// medida sobre 291 dias, nao um numero diario, e calcula-la exigiria este gerador ler tambem o
// dado do medidor. Ela continua na tela como achado datado, com a janela declarada.
function resumoPortal(obj) {
  const por = {};
  let ultimo = '', total = 0;
  for (const [ufv, dias] of Object.entries(obj.diario || {})) {
    const ds = Object.keys(dias).sort();
    if (!ds.length) continue;
    por[ufv] = { dias: ds.length, primeiro: ds[0], ultimo: ds[ds.length - 1] };
    if (ds[ds.length - 1] > ultimo) ultimo = ds[ds.length - 1];
    total = Math.max(total, ds.length);
  }
  const n = Object.keys(por).length;
  if (!n) return null;
  // O atraso e contado em dias de calendario ate HOJE em BRT — o runner corre em UTC.
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  const atraso = Math.round((new Date(hoje + 'T12:00:00Z') - new Date(ultimo + 'T12:00:00Z')) / 86400000);
  // A usina com MENOS dias e o que limita a comparacao — e o numero que a tela precisa dizer.
  const menor = Object.entries(por).sort((a, b) => a[1].dias - b[1].dias)[0];
  return { gerado: new Date().toISOString(), estacoes: n, dias_max: total, ultimo_dia: ultimo,
    atraso_dias: atraso, menor_cobertura: { ufv: menor[0], dias: menor[1].dias }, por_ufv: por };
}

// Separa o detalhe de 5 min do resto e poda a janela dele. A poda e por data e nao por contagem:
// a contagem nao muda quando um dia e reprocessado, e a janela ficaria crescendo calada.
function separa5min(obj) {
  const { intra5, ...resto } = obj;
  const dias = Object.keys(intra5 || {}).sort();
  const mantidos = dias.slice(-JANELA_5MIN);
  const podado = {};
  for (const d of mantidos) podado[d] = intra5[d];
  return { resto, cinco: podado, descartados: dias.length - mantidos.length };
}

async function writeOut(obj) {
  const { resto, cinco, descartados } = separa5min(obj);
  const dias5 = Object.keys(cinco).length;
  const meta5 = {
    gerado: new Date().toISOString(),
    resolucao_min: 5,
    unidade: 'MWh por intervalo de 5 minutos',
    origem: 'Potencia ativa em MW amostrada de 5 em 5 minutos no supervisorio da usina; a energia '
      + 'do intervalo e a potencia multiplicada pela duracao. O arquivo ja traz energia.',
    janela_dias: JANELA_5MIN,
    intra5: cinco,
  };
  if (process.env.LOCAL_OUT) {
    const fs = require('fs');
    fs.writeFileSync(process.env.LOCAL_OUT, JSON.stringify(resto));
    fs.writeFileSync(caminho5(process.env.LOCAL_OUT), JSON.stringify(meta5));
    console.log('Gravado local: ' + BLOB_5MIN + ' com ' + dias5 + ' dias'
      + (descartados ? ' (' + descartados + ' fora da janela)' : ''));
    return;
  }
  const svc = await getBlobClient();
  const cont = svc.getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  const a = await gravaUm(cont, OUT_BLOB, resto, 3600);
  const b = await gravaUm(cont, BLOB_5MIN, meta5, 3600);
  const rp = resumoPortal(resto);
  if (rp) {
    const c = await gravaUm(cont, 'portal_scada.json', rp, 3600);
    console.log(`portal_scada.json OK · ${rp.estacoes} estacoes · ate ${rp.ultimo_dia} `
      + `(${rp.atraso_dias} dias atras) · ${(c.gz / 1024).toFixed(1)} KB`);
  } else {
    console.log('portal_scada.json NAO gerado — nenhuma usina com dia no diario');
  }
  console.log('Gravado ' + OUT_BLOB + ': ' + Math.round(a.cru / 1024) + ' KB -> '
    + Math.round(a.gz / 1024) + ' KB comprimido ('
    + Math.round((1 - a.gz / a.cru) * 100) + '% menos na rede).');
  console.log('Gravado ' + BLOB_5MIN + ': ' + dias5 + ' dias · ' + Math.round(b.cru / 1024)
    + ' KB -> ' + Math.round(b.gz / 1024) + ' KB comprimido'
    + (descartados ? ' · ' + descartados + ' dia(s) fora da janela de ' + JANELA_5MIN : '') + '.');
}

(async () => {
  const raws = await loadRawBuffers();
  if (!raws.length) { console.log('Nenhuma planilha .xlsx em "' + RAW_CONTAINER + '" — nada a processar (ok).'); return; }
  const out = await loadExistingOut();
  if (!out.diario) out.diario = {};
  if (!out.intra15) out.intra15 = {};
  if (!out.intra5) out.intra5 = {};
  // estruturas PARALELAS de potencia reativa (MVAr medio) — mesma forma da ativa
  if (!out.diario_reativa) out.diario_reativa = {};
  if (!out.intra15_reativa) out.intra15_reativa = {};
  // Guarda anti-parcial: operadores sobem só o dia ANTERIOR (D-1) até 08:00. Um arquivo de HOJE
  // (ou futuro) é sempre parcial/em-progresso e pode vir corrompido (ex.: M5 07/13 = 775 MWh,
  // 3,5x um dia real) — nunca entra no diário/intra15. Também purga dias >= hoje que já tenham
  // vazado pro blob em runs anteriores (auto-cura). Chaves 'YYYY-MM-DD' comparam lexicograficamente.
  const hojeBRT = (() => { const x = new Date(Date.now() - 3 * 3600 * 1000); return x.getUTCFullYear() + '-' + pad2(x.getUTCMonth() + 1) + '-' + pad2(x.getUTCDate()); })();
  const ignorados = [];              // planilhas puladas por cabecalho fora do padrao
  let rtcAplicados = 0;              // arquivos do M3 em que o reparo do RTC foi aplicado
  let purgados = 0;
  for (const pk of Object.keys(out.diario)) for (const d of Object.keys(out.diario[pk])) if (d >= hojeBRT) { delete out.diario[pk][d]; purgados++; }
  for (const d of Object.keys(out.intra15)) if (d >= hojeBRT) delete out.intra15[d];
  for (const d of Object.keys(out.intra5)) if (d >= hojeBRT) delete out.intra5[d];
  // mesma purga anti-parcial na reativa
  for (const pk of Object.keys(out.diario_reativa)) for (const d of Object.keys(out.diario_reativa[pk])) if (d >= hojeBRT) delete out.diario_reativa[pk][d];
  for (const d of Object.keys(out.intra15_reativa)) if (d >= hojeBRT) delete out.intra15_reativa[d];
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
    let diario, intra15, intra5, porCol, rtc, reativa;
    try { ({ diario, intra15, intra5, porCol, rtc, reativa } = parseParkBuffer(buf, pk)); }
    catch (e) { console.warn('IGNORADO (' + e.message + '):', name); ignorados.push(name); continue; }
    const temAtiva = Object.keys(diario).length > 0;
    // REPARO DO RTC DO M3 (circuito 2 = CUB_10.1, 50% ate 11/07). Loga o que fez, com o guard.
    if (rtc) {
      if (rtc.aplicado) { rtcAplicados++;
        console.log('RTC M3 [' + name + '] circuito 2 dobrado ate 11/07 · col=' + rtc.col
          + ' · era ' + (rtc.razao * 100).toFixed(0) + '% das irmas · ' + rtc.dias + ' dias'); }
      else console.warn('RTC M3 [' + name + '] NAO aplicado (guard): col=' + rtc.col
        + ' estava em ' + (rtc.razao == null ? '?' : (rtc.razao * 100).toFixed(0) + '%')
        + ' das irmas — fora de 35-70%, nao dobrei para nao corromper.');
    } else if (pk === 'M3' && temAtiva) {   // so avisa em arquivo de ATIVA do M3 (P_RE nao tem CUB)
      console.warn('RTC M3 [' + name + '] coluna CUB_10.1 NAO encontrada neste arquivo.');
    }
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
      if (intra5[d]) {
        if (!out.intra5[d]) out.intra5[d] = {};
        out.intra5[d][pk] = intra5[d].map(v => +v.toFixed(3));
      }
    }
    // ---- grava a REATIVA (do arquivo P_RE OU inline dos arquivos novos) ----
    let reaEscritos = 0;
    if (reativa) {
      if (!out.diario_reativa[pk]) out.diario_reativa[pk] = {};
      for (const d in reativa.diario) {
        if (d >= hojeBRT) continue;
        if (gapOnly && out.diario_reativa[pk][d] != null) continue;
        out.diario_reativa[pk][d] = reativa.diario[d]; reaEscritos++;
      }
      for (const d in reativa.intra15) {
        if (d >= hojeBRT) continue;
        if (!out.intra15_reativa[d]) out.intra15_reativa[d] = {};
        if (gapOnly && out.intra15_reativa[d][pk] != null) continue;
        out.intra15_reativa[d][pk] = reativa.intra15[d];
      }
    }
    parks++;
    console.log('OK', name, '->', pk, (gapOnly ? '(M10->M1 so buracos)' : ''),
      '| ativa:', escritos, 'dias', reativa ? ('| reativa: ' + reaEscritos + ' dias') : '');
  }
  // limpeza: remove parques nao-canonicos residuais do blob (ex.: M10 legado = M1)
  const removidos = [];
  for (const pk of Object.keys(out.diario)) if (!CANON.has(pk)) { delete out.diario[pk]; removidos.push(pk); }
  for (const day of Object.keys(out.intra15)) for (const pk of Object.keys(out.intra15[day])) if (!CANON.has(pk)) delete out.intra15[day][pk];
  for (const day of Object.keys(out.intra5)) for (const pk of Object.keys(out.intra5[day])) if (!CANON.has(pk)) delete out.intra5[day][pk];
  if (removidos.length) console.log('Removidos parques nao-canonicos:', [...new Set(removidos)].join(', '));
  await writeOut(out);
  console.log(`Gravado ${OUT_BLOB}: ${parks} parques, ${days.size} dias novos/atualizados, ${Object.keys(out.intra15).length} dias no total.`);
  if (rtcAplicados) console.log(`Reparo RTC do M3 aplicado em ${rtcAplicados} arquivo(s) (circuito 2 dobrado ate 11/07).`);
  if (ignorados.length) {
    console.log(`
ATENCAO: ${ignorados.length} planilha(s) ignorada(s) por nao ter coluna de potencia ativa.`);
    console.log('Antes desta correcao elas virariam 0 MWh silenciosamente. Se forem de potencia');
    console.log('ativa, o cabecalho mudou e o padrao CVMMXN1_Wa precisa ser ajustado:');
    ignorados.slice(0, 20).forEach(f => console.log('  - ' + f));
    if (ignorados.length > 20) console.log('  ... e mais ' + (ignorados.length - 20));
  }
})().catch(e => { console.error(e); process.exit(1); });
