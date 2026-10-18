'use strict';
/*
 * lib-le-blob.js — leitura de blob PUBLICO com leitura condicional e copia em disco (custo-a, 17/10/2026).
 *
 * Por que existe: o trafego de SAIDA do storage e a fatura do Azure (set/26 R$ 893, quase tudo Bandwidth). Medido em 14–17/10/2026
 * pelo diagnostico de leituras: ~26 GB/dia sao o proprio pipeline no GitHub relendo blobs, e a maior parte e `hist/way2_<dia>.json`
 * (~4 MB cada) relido por geradores de 5 em 5 min e de hora em hora — o mesmo dia fechado, que nao muda, baixado de novo a cada rodada,
 * e o mesmo dia lido varias vezes na MESMA rodada (o agregador lia os mesmos 4 dias uma vez por resolucao).
 *
 * O que faz, so para os arquivos do historico do medidor (`/hist/way2_`); qualquer outro endereco passa direto, como antes:
 *   · na mesma rodada, o mesmo arquivo e baixado UMA vez (memoria);
 *   · com CACHE_BLOB_DIR (a copia que o actions/cache traz da execucao anterior), o pedido vai com If-None-Match: o storage responde
 *     304 sem corpo quando o arquivo nao mudou, e a copia vale. Arquivo que mudou vem inteiro (200) e a copia e trocada.
 * Copia ilegivel ou sem etag = pedido normal. Copia nao usada ha mais de 4 dias sai do disco (o cache nao cresce sem fim).
 *
 * Devolve os BYTES do corpo como vieram (gzip ou nao): quem le continua decidindo como descomprimir e interpretar. 404 devolve null.
 * Erro de rede, timeout ou status diferente de 200/304/404 estoura como antes (com o status na mensagem: "HTTP 500 ...").
 *
 * Uso:   const LB = require('./lib-le-blob');   const buf = await LB.bytes(url, { 'Accept-Encoding': 'gzip' });
 *        LB.resumo()   // uma linha no log: da memoria, da copia (304), da rede (200)
 */
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALVO = /\/hist\/way2_\d{4}-\d{2}-\d{2}\.json(\?|$)/;
const MEMO = new Map();
const EST = { memoria: 0, copia: 0, rede: 0, bytesRede: 0, bytesPoupados: 0, direto: 0 };
const VIDA_MS = 4 * 86400e3;
const MAX_MEMO = 8;   // dias na memoria de uma rodada (o agregador relia 4 dias por resolucao; na carga completa sao 91, e nao cabem)
// O dia BRT corrente (e qualquer futuro) muda a cada 5 min: copia dele nunca daria 304 e so faria o cache do GitHub regravar a cada
// execucao (e despejar os caches dos outros workflows). Ele vai na memoria da rodada, nunca no disco.
function diaAberto(url) { const m = /way2_(\d{4}-\d{2}-\d{2})\.json/.exec(url); return !!m && m[1] >= new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10); }
let podou = false;

function dir() {
  const r = process.env.CACHE_BLOB_DIR;
  if (!r) return null;
  const d = path.join(r, 'publico');
  try { fs.mkdirSync(d, { recursive: true }); } catch (e) { return null; }
  if (!podou) { podou = true; poda(d); }
  return d;
}
function poda(d) {
  const agora = Date.now();
  for (const f of fs.readdirSync(d)) {
    try { const p = path.join(d, f); if (agora - fs.statSync(p).mtimeMs > VIDA_MS) fs.unlinkSync(p); } catch (e) { /* proxima rodada */ }
  }
}
const chave = (url) => url.split('?')[0];
const nomeArq = (url) => crypto.createHash('sha1').update(chave(url)).digest('hex');

function leCopia(d, url) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(d, nomeArq(url) + '.meta'), 'utf8'));
    const buf = fs.readFileSync(path.join(d, nomeArq(url)));
    if (!meta.etag || meta.bytes !== buf.length) return null;
    const agora = new Date(); fs.utimesSync(path.join(d, nomeArq(url)), agora, agora); fs.utimesSync(path.join(d, nomeArq(url) + '.meta'), agora, agora);
    return { etag: meta.etag, buf };
  } catch (e) { return null; }
}
function gravaCopia(d, url, etag, buf) {
  if (!etag) return;
  try {
    const f = path.join(d, nomeArq(url));
    fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);   // dado primeiro, meta por ultimo
    fs.writeFileSync(f + '.meta', JSON.stringify({ etag, bytes: buf.length, url: chave(url) }));
  } catch (e) { /* sem copia: a proxima rodada baixa */ }
}

function pede(url, headers) {
  return new Promise((ok, erro) => {
    const req = https.get(url, { family: 4, headers }, (r) => {
      if (r.statusCode === 404 || r.statusCode === 304) { r.resume(); return ok({ status: r.statusCode, etag: r.headers.etag }); }
      if (r.statusCode !== 200) { r.resume(); return erro(new Error('HTTP ' + r.statusCode + ' ' + chave(url))); }
      const p = []; r.on('data', (c) => p.push(c)); r.on('error', erro);
      r.on('end', () => ok({ status: 200, etag: r.headers.etag, buf: Buffer.concat(p) }));
    });
    req.on('error', erro);
    req.setTimeout(120000, () => req.destroy(new Error('timeout ' + chave(url))));
  });
}

// bytes(url, headers) -> Promise<Buffer|null>
function bytes(url, headers) {
  const h = Object.assign({}, headers || {});
  if (!ALVO.test(url)) { EST.direto++; return pede(url, h).then((x) => (x.status === 404 ? null : x.buf)); }
  const k = chave(url);
  if (MEMO.has(k)) { EST.memoria++; return MEMO.get(k).then((b) => { if (b) EST.bytesPoupados += b.length; return b; }); }
  const p = (async () => {
    const d = diaAberto(url) ? null : dir(), c = d ? leCopia(d, url) : null;
    if (c) h['If-None-Match'] = c.etag;
    const x = await pede(url, h);
    if (x.status === 404) return null;
    if (x.status === 304) {
      if (!c) throw new Error('HTTP 304 sem copia ' + k);   // nao acontece: o 304 so vem com If-None-Match
      EST.copia++; EST.bytesPoupados += c.buf.length; return c.buf;
    }
    EST.rede++; EST.bytesRede += x.buf.length;
    if (d) gravaCopia(d, url, x.etag, x.buf);
    return x.buf;
  })();
  MEMO.set(k, p);
  if (MEMO.size > MAX_MEMO) MEMO.delete(MEMO.keys().next().value);   // sai o mais antigo
  p.catch(() => MEMO.delete(k));   // falha nao fica memorizada
  return p;
}

function resumo() {
  const mb = (b) => (b / 1048576).toFixed(1);
  const t = 'historico do medidor: ' + EST.rede + ' da rede (' + mb(EST.bytesRede) + ' MB) · ' + EST.copia + ' da copia (304) · '
    + EST.memoria + ' da memoria · ' + mb(EST.bytesPoupados) + ' MB poupados' + (process.env.CACHE_BLOB_DIR ? '' : ' · sem CACHE_BLOB_DIR');
  console.log('  ' + t);
  return Object.assign({}, EST);
}

module.exports = { bytes, resumo, ALVO, diaAberto, _memo: MEMO, _est: EST };
