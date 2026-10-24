'use strict';
/*
 * lib-le-dados.js — leitura do contêiner `dados` COM CREDENCIAL (PROMOVER fase2-pipeline, Fase 2, 18/10/2026).
 *
 * Por que existe: o contêiner `dados` vai deixar de ser público (Fase 2: o portal pela API, o Grafana por SAS, a conta com
 * allowBlobPublicAccess=false). Até aqui 26 geradores e 50 ensaios liam `https://rbenergydata.blob.core.windows.net/dados/<nome>` sem
 * credencial, cada um com a sua função (puxa, getJSON, leBlob…). Esta lib é o transporte único: o script continua passando o MESMO
 * endereço, e ela decide como ler.
 *
 * Ordem, para endereço do contêiner `dados`:
 *   1. DADOS_STORAGE (a connection string do GitHub) -> SDK, com If-None-Match quando pedido (o 304 da leitura condicional do custo-a);
 *   2. DADOS_SAS (SAS só de leitura, para rodar na máquina; nunca escrito em arquivo) -> https com o SAS na query;
 *   3. nenhum dos dois -> o endereço público, como antes, com UM aviso no log por processo (::warning::). Depois da virada a conta
 *      responde 409 PublicAccessNotPermitted e a leitura ESTOURA — nunca vira "não existe".
 * Endereço de fora do contêiner (o S3 do ONS, a API da Way2…) passa direto, pelo https, como antes.
 *
 * 🔴 O "NÃO EXISTE" É SÓ O 404 DO PRÓPRIO BLOB (BlobNotFound). Dez geradores tratam o vazio como "primeira rodada" e regravam o
 *    acumulado do zero. Contêiner que sumiu, 403, 409, 5xx, rede ou timeout ESTOURAM: o gerador para em vez de apagar o histórico.
 *
 * Devolve os BYTES como estão gravados (gzip ou não): quem lê continua decidindo como descomprimir e interpretar.
 *
 * Uso:   const LD = require('./lib-le-dados');
 *        const x = await LD.pede(url, { 'If-None-Match': etag })  // { status: 200|304|404, etag, buf, ultimaMod, bytes }
 *        const buf = await LD.bytes(url)                          // Buffer | null (404)
 *        const j = await LD.json(url)                             // objeto | null (404); gzip e BOM tratados
 *        const h = await LD.cabecalho(url)                        // { status, etag, ultimaMod, bytes } (HEAD)
 *        LD.modo()                                                // 'sdk' | 'sas' | 'publico'
 */
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

/* A SAÍDA PRÓPRIA pela cópia em disco (24/10/2026). Medido em 24/10: o sungrow relê a cada rodada ~430 MB do que
   ele mesmo gravou (sg_*), na rodada seguinte e nos passos seguintes do mesmo job. Com LE_DADOS_PROPRIOS (regex de nomes) e CACHE_BLOB_DIR
   no passo, o GET de um nome que casa vai com If-None-Match da cópia em disco: 304 = a cópia vale (o storage confirmou que é o mesmo blob);
   200 = vem inteiro e a cópia é trocada. O escritor chama lembra(nome, etag, bytes) logo depois de gravar, com a etag que o upload
   devolveu. A cópia só é usada com a confirmação do storage: blob regravado por outro escritor muda a etag e vem pela rede. Sem as duas
   variáveis, nada muda (os outros workflows não as têm). Uma linha de resumo no fim do processo. */
const PROP = process.env.LE_DADOS_PROPRIOS && process.env.CACHE_BLOB_DIR ? new RegExp(process.env.LE_DADOS_PROPRIOS) : null;
const EP = { copia: 0, rede: 0, lembrados: 0, bytesCopia: 0, bytesRede: 0, podados: 0 };
const USADOS = new Set();   // os nomes que este processo leu da cópia, trocou ou lembrou: a poda do escritor apaga o resto
function dirP() {
  if (!PROP) return null;
  const d = path.join(process.env.CACHE_BLOB_DIR, 'proprios');
  try { fs.mkdirSync(d, { recursive: true }); return d; } catch (e) { return null; }
}
const arqP = (nome) => encodeURIComponent(nome);
function leP(d, nome) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(d, arqP(nome) + '.meta'), 'utf8'));
    const b = fs.readFileSync(path.join(d, arqP(nome)));
    if (!m.etag || m.bytes !== b.length) return null;
    USADOS.add(nome); return { etag: m.etag, buf: b };
  } catch (e) { return null; }
}
function gravaP(d, nome, etag, buf) {
  if (!d || !etag || !Buffer.isBuffer(buf)) return false;
  try {
    const f = path.join(d, arqP(nome));
    fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);   // dado primeiro, marca por último
    fs.writeFileSync(f + '.meta', JSON.stringify({ etag, bytes: buf.length, nome }));
    USADOS.add(nome); return true;
  } catch (e) { return false; }   // sem cópia: a próxima leitura vem pela rede
}
function lembra(nome, etag, buf) { if (PROP && PROP.test(nome) && gravaP(dirP(), nome, etag, buf)) EP.lembrados++; }
/* a poda (só o ESCRITOR chama, no fim, depois de gravar tudo): sai do disco a cópia de nome que esta rodada não leu nem lembrou — o nome que
   deixou de ser gravado não viaja para sempre no cache do workflow */
function podaProprios() {
  const d = dirP(); if (!d) return 0;
  for (const f of fs.readdirSync(d)) {
    const nome = decodeURIComponent(f.replace(/\.(meta|tmp)$/, ''));
    if (!USADOS.has(nome)) { try { fs.unlinkSync(path.join(d, f)); if (/\.meta$/.test(f)) EP.podados++; } catch (e) { } }
  }
  return EP.podados;
}
function resumoProprios() {
  const mb = (b) => (b / 1048576).toFixed(1);
  return 'saidas proprias (' + process.env.LE_DADOS_PROPRIOS + '): ' + EP.copia + ' da copia (' + mb(EP.bytesCopia) + ' MB) · ' + EP.rede
    + ' da rede (' + mb(EP.bytesRede) + ' MB) · ' + EP.lembrados + ' lembradas ao gravar' + (EP.podados ? ' · ' + EP.podados + ' podadas' : '');
}
if (PROP) process.on('exit', () => { if (EP.copia || EP.rede || EP.lembrados) console.log('  ' + resumoProprios()); });

const BASE = process.env.DADOS_BASE_PUB || 'https://rbenergydata.blob.core.windows.net/dados/';
const CONTEINER = 'dados';
let CONT = null, avisou = false;

function nomeDe(url) {
  const u = String(url || '').split('?')[0];
  if (!u.startsWith(BASE)) return null;
  const n = u.slice(BASE.length);
  return n ? decodeURIComponent(n) : null;
}
function modo() {
  if (process.env.DADOS_STORAGE) return 'sdk';
  if (process.env.DADOS_SAS) return 'sas';
  return 'publico';
}
function conteiner() {
  if (CONT) return CONT;
  const { BlobServiceClient } = require('@azure/storage-blob');
  CONT = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(CONTEINER);
  return CONT;
}
function avisaPublico(url) {
  if (avisou) return;
  avisou = true;
  console.log('::warning::lib-le-dados: leitura PUBLICA de `dados` (sem DADOS_STORAGE nem DADOS_SAS), a partir de ' + String(url).split('?')[0]
    + ' — depois da virada da Fase 2 isto estoura; ponha DADOS_STORAGE no passo');
}

/* o transporte https/http (o http só para o servidor local do ensaio) */
function pedeHttp(url, metodo, headers) {
  const mod = url.startsWith('http:') ? http : https;
  return new Promise((ok, erro) => {
    const opc = { method: metodo, family: 4, headers: headers || {} };
    const resp = (r) => {
      const meta = { etag: r.headers.etag, ultimaMod: r.headers['last-modified'], bytes: +r.headers['content-length'] || null };
      if (r.statusCode === 304) { r.resume(); return ok(Object.assign({ status: 304 }, meta)); }
      if (r.statusCode === 404) {
        r.resume();
        /* 404 de contêiner que não existe (ou do pedido anônimo a contêiner privado) não é "o blob não existe" */
        const cod = String(r.headers['x-ms-error-code'] || '');
        if (cod && cod !== 'BlobNotFound') return erro(new Error('HTTP 404 ' + cod + ' ' + url.split('?')[0]));
        return ok(Object.assign({ status: 404 }, meta));
      }
      if (r.statusCode !== 200) { r.resume(); return erro(new Error('HTTP ' + r.statusCode + (r.headers['x-ms-error-code'] ? ' ' + r.headers['x-ms-error-code'] : '') + ' ' + url.split('?')[0])); }
      if (metodo === 'HEAD') { r.resume(); return ok(Object.assign({ status: 200 }, meta)); }
      const p = []; r.on('data', (c) => p.push(c)); r.on('error', erro);
      r.on('end', () => { const buf = Buffer.concat(p); ok(Object.assign({ status: 200, buf }, meta, { bytes: buf.length })); });
    };
    /* GET pelo `get` (o mesmo de antes: os ensaios que simulam o storage trocam o https.get); HEAD pelo `request` */
    const req = metodo === 'GET' ? mod.get(url, opc, resp) : mod.request(url, opc, resp);
    req.on('error', erro);
    req.setTimeout(120000, () => req.destroy(new Error('timeout ' + url.split('?')[0])));
    if (metodo !== 'GET') req.end();
  });
}

/* o transporte pelo SDK */
async function pedeSdk(nome, metodo, headers) {
  const bc = conteiner().getBlobClient(nome);
  const inm = headers && (headers['If-None-Match'] || headers['if-none-match']);
  try {
    if (metodo === 'HEAD') {
      const p = await bc.getProperties();
      return { status: 200, etag: p.etag, ultimaMod: p.lastModified ? new Date(p.lastModified).toUTCString() : null, bytes: p.contentLength };
    }
    const r = await bc.download(0, undefined, inm ? { conditions: { ifNoneMatch: inm } } : {});
    const p = [];
    for await (const c of r.readableStreamBody) p.push(c);
    const buf = Buffer.concat(p);
    return { status: 200, etag: r.etag, ultimaMod: r.lastModified ? new Date(r.lastModified).toUTCString() : null, buf, bytes: buf.length };
  } catch (e) {
    const st = e && e.statusCode, cod = (e && (e.code || (e.details && e.details.errorCode))) || '';
    if (st === 304) return { status: 304, etag: inm };
    if (st === 404 && (cod === 'BlobNotFound' || !cod)) return { status: 404 };
    throw new Error('SDK ' + (st || '') + ' ' + cod + ' dados/' + nome + (e && e.message ? ' · ' + String(e.message).split('\n')[0] : ''));
  }
}

function pede(url, headers, metodo) {
  metodo = metodo || 'GET';
  const nome = nomeDe(url);
  if (!nome) return pedeHttp(url, metodo, headers);
  if (PROP && metodo === 'GET' && PROP.test(nome) && !(headers && (headers['If-None-Match'] || headers['if-none-match']))) return pedeProprio(url, nome, headers);
  return pedeDados(url, nome, headers, metodo);
}
/* a saída própria: o GET condicional pela cópia; quem chama recebe o mesmo de sempre (200 com os bytes, ou 404) */
async function pedeProprio(url, nome, headers) {
  const d = dirP(), c = d ? leP(d, nome) : null;
  const x = await pedeDados(url, nome, c ? Object.assign({}, headers || {}, { 'If-None-Match': c.etag }) : headers, 'GET');
  if (x.status === 304 && c) { EP.copia++; EP.bytesCopia += c.buf.length; return { status: 200, etag: c.etag, ultimaMod: x.ultimaMod || null, buf: c.buf, bytes: c.buf.length }; }
  if (x.status === 304) throw new Error('HTTP 304 sem copia dados/' + nome);   // não acontece: o 304 só vem com a etag da cópia
  if (x.status === 200) { EP.rede++; EP.bytesRede += x.buf.length; gravaP(d, nome, x.etag, x.buf); }
  if (x.status === 404 && d) { try { fs.unlinkSync(path.join(d, arqP(nome) + '.meta')); } catch (e) { } }
  return x;
}
function pedeDados(url, nome, headers, metodo) {
  const m = modo();
  if (m === 'sdk') return pedeSdk(nome, metodo, headers);
  if (m === 'sas') {
    const sas = String(process.env.DADOS_SAS).replace(/^\?/, '');
    const base = url.split('?')[0];
    return pedeHttp(base + '?' + sas, metodo, headers);
  }
  avisaPublico(url);
  return pedeHttp(url, metodo, headers);
}
async function bytes(url, headers) { const x = await pede(url, headers); return x.status === 404 ? null : x.buf; }
async function json(url) {
  const b = await bytes(url);
  if (!b) return null;
  const t = (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, '');
  return JSON.parse(t);
}
function cabecalho(url) { return pede(url, null, 'HEAD'); }

module.exports = { pede, bytes, json, cabecalho, modo, nomeDe, BASE, lembra, podaProprios, resumoProprios, _est: EP, _usa: (c) => { CONT = c; }, _zeraAviso: () => { avisou = false; } };
