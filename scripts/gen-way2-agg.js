/*
 * gen-way2-agg.js — blobs Way2 elétrico agregados por resolução (15/30/60 min) para o
 * SELETOR DE INTERVALO do Monitor (Grafana). Blob-only: NUNCA consulta a API Way2.
 *
 * Fonte: hist/way2_AAAA-MM-DD.json (5min fiel, 200 séries, imutável para dias fechados).
 * Saída: way2_15min.json (30 dias), way2_30min.json e way2_1h.json (90 dias) — mesmo shape
 *   de dados[] do way2_recent.json, então o MESMO JSONata do Grafana funciona só trocando a URL.
 *
 * Agregação = MÉDIA dos valores não-nulos por bucket, por série (pontoId|nomeGrandeza). Média,
 *   não soma: grandezas instantâneas (Demat/Demre em kW, tensão, corrente) — a média mantém a
 *   MESMA unidade do 5min, preservando o ÷1000 / ×1.732 que o frontend já faz.
 *
 * Estratégia (auto-acumulação incremental, evita reler 90 blobs/run):
 *   - Sem o blob de saída, ou FORCAR=1, ou blob velho demais p/ remendar: FULL — lê a janela
 *     inteira do hist e monta do zero (streaming, 1 arquivo por vez → memória limitada).
 *   - Com blob válido: INCREMENTAL — baixa a saída atual, reprocessa do último dia presente no
 *     blob (ou REFRESH_DIAS atrás, o que for mais antigo) até hoje, faz merge por bucket e corta
 *     o que saiu da janela. Janela ADAPTATIVA: se o job pulou dias, reprocessa o intervalo todo
 *     (sem buracos); se o blob ficou velho demais, cai p/ FULL.
 *
 * Timestamp naive-local (BRT) preservado: a bucketização manipula a STRING "YYYY-MM-DDTHH:MM:SS"
 *   diretamente (sem Date/UTC) — zero risco de deslocar 3h. Bucket = borda esquerda. O slot 24:00
 *   vem estampado como next-day T00:00:00 e cai naturalmente no bucket 00:00 do dia seguinte; por
 *   isso lemos sempre 1 dia extra na borda esquerda (p/ o bucket 00:00 do dia mais antigo somar certo).
 *
 * Env: DADOS_STORAGE (obrigatório, RW no container dados). FORCAR (1|true|sim = full rebuild).
 *   REFRESH_DIAS (default 3, mínimo 2). RESOLUCOES (csv de nomes de blob p/ limitar; default os 3).
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const BLOB_BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const RESOLUCOES = [
  { blob: 'way2_15min.json', bucketMin: 15, janelaDias: 30, intervalo: 'QuinzeMinutos' },
  { blob: 'way2_30min.json', bucketMin: 30, janelaDias: 90, intervalo: 'TrintaMinutos' },
  { blob: 'way2_1h.json',    bucketMin: 60, janelaDias: 90, intervalo: 'UmaHora' },
];
const _rd = parseInt(process.env.REFRESH_DIAS || '3', 10);
const REFRESH_DIAS = Number.isFinite(_rd) ? Math.max(2, _rd) : 3;   // guarda NaN
const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
const DEC = 3;
const FETCH_TIMEOUT = 60000;

// ---- datas (strings 'YYYY-MM-DD', aritmética em UTC p/ não depender do fuso do runner) ----
function diaBRT(offset = 0) {                        // dia-calendário BRT (UTC-3). 0=hoje.
  return new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400000).toISOString().slice(0, 10);
}
const msDia = (d) => Date.parse(d + 'T00:00:00Z');
const diaMais = (d, delta) => new Date(msDia(d) + delta * 86400000).toISOString().slice(0, 10);
function rangeDias(fromDia, toDia) {                 // lista inclusiva, crescente
  const out = []; for (let t = msDia(fromDia), e = msDia(toDia); t <= e; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const round = (x, d = DEC) => { const p = Math.pow(10, d); return Math.round(x * p) / p; };
const parseJson = (buf) => JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
const diaDe = (bucketISO) => bucketISO.slice(0, 10);

// Bucket = borda esquerda, manipulando a string naive (SEM Date → sem deslocamento de fuso).
function bucketKey(data, bucketMin) {
  const dpart = data.slice(0, 10);
  const tot = (+data.slice(11, 13)) * 60 + (+data.slice(14, 16));
  const b = Math.floor(tot / bucketMin) * bucketMin;
  const bh = String(Math.floor(b / 60)).padStart(2, '0');
  const bm = String(b % 60).padStart(2, '0');
  return `${dpart}T${bh}:${bm}:00`;
}

// GET público de um blob (hist imutável → cache ok). Resolve null em 404; timeout + error handler.
function fetchBlob(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' ' + url)); }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('end', () => { try { resolve(parseJson(Buffer.concat(chunks))); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT, () => req.destroy(new Error('timeout ' + url)));
  });
}

// Acumula {soma,contagem} de UM arquivo-dia no acumulador (acc: serieKey -> Map(bucketISO->{s,n})).
// Processar vários dias no MESMO acc garante que o bucket 00:00 (que cruza a fronteira de arquivos)
// some certo. meta guarda pontoId/nomeGrandeza por chave.
function acumularFile(acc, meta, j, bucketMin) {
  if (!j || !Array.isArray(j.dados)) return;
  for (const s of j.dados) {
    const key = s.pontoId + '|' + s.nomeGrandeza;
    if (!meta.has(key)) meta.set(key, { pontoId: s.pontoId, nomeGrandeza: s.nomeGrandeza });
    let bm = acc.get(key); if (!bm) { bm = new Map(); acc.set(key, bm); }
    for (const v of (s.valores || [])) {
      if (v == null || v.valor == null) continue;
      const bk = bucketKey(v.data, bucketMin);
      let a = bm.get(bk); if (!a) { a = { s: 0, n: 0 }; bm.set(bk, a); }
      a.s += v.valor; a.n++;
    }
  }
}
// (compat de teste) acumula uma lista de arquivos.
function acumular(files, bucketMin) {
  const acc = new Map(), meta = new Map();
  for (const j of files) acumularFile(acc, meta, j, bucketMin);
  return { acc, meta };
}

// acc -> série -> Map(bucketISO -> médiaArredondada), opcionalmente só buckets de dias >= minDia.
function mediasPorSerie(acc, minDia) {
  const out = new Map();
  for (const [key, bm] of acc) {
    const m = new Map();
    for (const [bk, a] of bm) { if (minDia && diaDe(bk) < minDia) continue; m.set(bk, round(a.s / a.n)); }
    out.set(key, m);
  }
  return out;
}

// Monta o objeto-blob final; corta dias < cutoffDia e séries que ficam vazias.
function montarBlob(mapaSeries, meta, intervalo, cutoffDia) {
  const dados = [];
  let gmin = null, gmax = null;
  for (const [key, m] of mapaSeries) {
    const bks = [...m.keys()].filter(bk => diaDe(bk) >= cutoffDia).sort();
    if (!bks.length) continue;
    const valores = bks.map(bk => ({ data: bk, valor: m.get(bk) }));
    const md = meta.get(key) || { pontoId: +key.split('|')[0], nomeGrandeza: key.split('|')[1] };
    dados.push({ pontoId: md.pontoId, ultimaColeta: bks[bks.length - 1], nomeGrandeza: md.nomeGrandeza, valores });
    if (gmin === null || bks[0] < gmin) gmin = bks[0];
    if (gmax === null || bks[bks.length - 1] > gmax) gmax = bks[bks.length - 1];
  }
  return { inicio: (gmin || '').slice(0, 10), fim: (gmax || '').slice(0, 10), intervalo, dados };
}

// último dia com dado no blob existente (max sobre as séries).
function maxDiaBlob(existente) {
  let mx = null;
  for (const s of (existente.dados || [])) {
    const vs = s.valores; if (vs && vs.length) { const d = diaDe(vs[vs.length - 1].data); if (mx === null || d > mx) mx = d; }
  }
  return mx;
}

async function main() {
  const conn = process.env.DADOS_STORAGE;
  if (!conn) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  const alvo = (process.env.RESOLUCOES || '').trim();
  let resolucoes = RESOLUCOES;
  if (alvo) {
    const set = alvo.split(',').map(s => s.trim());
    resolucoes = RESOLUCOES.filter(r => set.includes(r.blob));
    if (!resolucoes.length) { console.error('ERRO: RESOLUCOES não casou nenhum blob. Válidos: ' + RESOLUCOES.map(r => r.blob).join(', ')); process.exit(1); }
  }

  const hoje = diaBRT(0);
  // acumula uma lista de dias (streaming: baixa, acumula e descarta 1 arquivo por vez → memória limitada).
  async function acumularDias(dias, bucketMin) {
    const acc = new Map(), meta = new Map();
    let lidos = 0;
    for (const d of dias) { const j = await fetchBlob(BLOB_BASE + 'hist/way2_' + d + '.json'); if (j) { acumularFile(acc, meta, j, bucketMin); lidos++; } }
    return { acc, meta, lidos };
  }

  for (const r of resolucoes) {
    const bc = container.getBlockBlobClient(r.blob);
    const cutoffDia = diaBRT(r.janelaDias - 1);   // dia mais antigo a manter na janela
    let existente = null;
    if (!FORCAR) { try { if (await bc.exists()) existente = parseJson(await bc.downloadToBuffer()); } catch (e) { existente = null; } }

    const ultima = existente ? maxDiaBlob(existente) : null;
    const podeIncremental = !!ultima && ultima >= cutoffDia;   // blob válido e dentro da janela

    let mapaSeries, meta;
    if (!podeIncremental) {
      // FULL: lê [cutoffDia-1 .. hoje] (1 dia extra p/ o bucket 00:00 do dia mais antigo), filtra >= cutoff.
      const { acc, meta: mt, lidos } = await acumularDias(rangeDias(diaMais(cutoffDia, -1), hoje), r.bucketMin);
      mapaSeries = mediasPorSerie(acc, cutoffDia); meta = mt;
      console.log(`[${r.blob}] FULL: ${lidos} dias hist lidos (${existente ? 'blob velho/refeito' : 'sem blob'}).`);
    } else {
      // INCREMENTAL adaptativo: reprocessa do min(REFRESH_DIAS atrás, último dia do blob) até hoje.
      const refreshFromDia = ultima < diaBRT(REFRESH_DIAS - 1) ? ultima : diaBRT(REFRESH_DIAS - 1);
      const { acc, meta: mt, lidos } = await acumularDias(rangeDias(diaMais(refreshFromDia, -1), hoje), r.bucketMin);
      const fresh = mediasPorSerie(acc, refreshFromDia); meta = mt;
      // base = buckets do blob existente dentro da janela; depois sobrescreve os dias reprocessados.
      mapaSeries = new Map();
      for (const s of (existente.dados || [])) {
        const key = s.pontoId + '|' + s.nomeGrandeza;
        if (!meta.has(key)) meta.set(key, { pontoId: s.pontoId, nomeGrandeza: s.nomeGrandeza });
        const m = new Map();
        for (const v of (s.valores || [])) if (diaDe(v.data) >= cutoffDia) m.set(v.data, v.valor);
        mapaSeries.set(key, m);
      }
      for (const [key, fm] of fresh) { let m = mapaSeries.get(key); if (!m) { m = new Map(); mapaSeries.set(key, m); } for (const [bk, val] of fm) m.set(bk, val); }
      console.log(`[${r.blob}] INCREMENTAL: reprocessou ${refreshFromDia}..${hoje} (${lidos} hist; blob ia até ${ultima}).`);
    }

    const obj = montarBlob(mapaSeries, meta, r.intervalo, cutoffDia);
    const body = JSON.stringify(obj);
    await bc.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'no-cache' } });
    const nVals = obj.dados.reduce((a, s) => a + s.valores.length, 0);
    console.log(`[${r.blob}] OK · ${obj.dados.length} séries · ${nVals} pts · ${obj.inicio}..${obj.fim} · ${(body.length / 1e6).toFixed(2)}MB`);
  }
}

module.exports = { bucketKey, acumular, acumularFile, mediasPorSerie, montarBlob, maxDiaBlob, diaBRT, diaMais, rangeDias };
if (require.main === module) main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
