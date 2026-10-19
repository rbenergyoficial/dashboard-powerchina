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

module.exports = { pede, bytes, json, cabecalho, modo, nomeDe, BASE, _usa: (c) => { CONT = c; }, _zeraAviso: () => { avisou = false; } };
