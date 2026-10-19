'use strict';
/*
 * ensaio-le-dados.js — prova a leitura do contêiner `dados` com credencial (lib-le-dados.js, PROMOVER fase2-pipeline).
 *
 * Sem rede e sem segredo: um contêiner simulado (o modo SDK) e um servidor HTTP local fazendo o papel do blob (os modos SAS e público).
 *   1. modo: DADOS_STORAGE -> sdk; DADOS_SAS -> sas; nenhum -> publico;
 *   2. SDK: lê o blob; BlobNotFound -> null; contêiner que sumiu, 403 e 409 ESTOURAM; If-None-Match -> 304; HEAD traz etag e tamanho;
 *   3. SAS: o SAS vai na query, e sem ele o servidor recusa;
 *   4. público: o aviso sai UMA vez; 404 BlobNotFound -> null; 404 de outro código (o anônimo no contêiner privado) e o 409
 *      PublicAccessNotPermitted (a conta fechada) ESTOURAM — o "não existe" falso é o que apagaria o acumulado;
 *   5. endereço fora do contêiner passa direto; json() trata gzip e BOM.
 */
const assert = require('assert');
const http = require('http');
const zlib = require('zlib');
const { Readable } = require('stream');

let n = 0;
const caso = async (nome, f) => { await f(); n++; console.log('ok · ' + nome); };

(async () => {
  const BLOBS = { 'a.json': Buffer.from('{"x":1}'), 'gz.json': zlib.gzipSync(Buffer.from('﻿{"y":2}')) };
  let ultimaQuery = '';
  const srv = http.createServer((req, res) => {
    const [p, q] = req.url.split('?'); ultimaQuery = q || '';
    if (p.startsWith('/fora/')) { res.writeHead(200, { 'content-length': 2 }); return res.end('ok'); }
    const nome = p.replace(/^\/dados\//, '');
    if (nome === 'privado.json') { res.writeHead(404, { 'x-ms-error-code': 'ResourceNotFound' }); return res.end(); }
    if (nome === 'fechado.json') { res.writeHead(409, { 'x-ms-error-code': 'PublicAccessNotPermitted' }); return res.end(); }
    if (process.env._EXIGE_SAS && !/sig=/.test(q || '')) { res.writeHead(403, { 'x-ms-error-code': 'AuthenticationFailed' }); return res.end(); }
    const b = BLOBS[nome];
    if (!b) { res.writeHead(404, { 'x-ms-error-code': 'BlobNotFound' }); return res.end(); }
    res.writeHead(200, { etag: '"e1"', 'content-length': b.length, 'last-modified': 'Sat, 17 Oct 2026 22:00:00 GMT' }); res.end(req.method === 'HEAD' ? undefined : b);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port + '/dados/';
  process.env.DADOS_BASE_PUB = base;
  delete process.env.DADOS_STORAGE; delete process.env.DADOS_SAS;
  const LD = require('./lib-le-dados');
  const log = console.log, avisos = [];
  console.log = (...a) => { if (/::warning::/.test(String(a[0]))) avisos.push(a[0]); else log(...a); };
  try {
    await caso('modo pela credencial', () => {
      assert.strictEqual(LD.modo(), 'publico');
      process.env.DADOS_SAS = 'sv=x&sig=y'; assert.strictEqual(LD.modo(), 'sas');
      process.env.DADOS_STORAGE = 'conn'; assert.strictEqual(LD.modo(), 'sdk');
      delete process.env.DADOS_STORAGE; delete process.env.DADOS_SAS;
      assert.strictEqual(LD.nomeDe(base + 'hist/way2_2026-10-17.json?t=1'), 'hist/way2_2026-10-17.json');
      assert.strictEqual(LD.nomeDe('https://ons-aws-prod-opendata.s3.amazonaws.com/x.csv'), null);
    });
    await caso('SDK: lê, BlobNotFound é null, o resto estoura, 304 e HEAD', async () => {
      const erro = (st, code) => Object.assign(new Error('falso ' + st), { statusCode: st, code });
      const pedidos = [];
      LD._usa({ getBlobClient: (nome) => ({
        download: async (o, c, opc) => { pedidos.push([nome, opc]);
          if (nome === 'some.json') throw erro(404, 'BlobNotFound');
          if (nome === 'sem-cont.json') throw erro(404, 'ContainerNotFound');
          if (nome === 'proibido.json') throw erro(403, 'AuthorizationPermissionMismatch');
          if (nome === 'conflito.json') throw erro(409, 'PublicAccessNotPermitted');
          if (opc && opc.conditions && opc.conditions.ifNoneMatch === '"e1"') throw erro(304);
          return { etag: '"e1"', lastModified: new Date('2026-10-17T22:00:00Z'), readableStreamBody: Readable.from([Buffer.from('{"z":'), Buffer.from('3}')]) }; },
        getProperties: async () => ({ etag: '"e1"', lastModified: new Date('2026-10-17T22:00:00Z'), contentLength: 6 }) }) });
      process.env.DADOS_STORAGE = 'conn';
      assert.deepStrictEqual(await LD.json(base + 'a.json'), { z: 3 });
      assert.strictEqual(await LD.bytes(base + 'some.json'), null);
      for (const nome of ['sem-cont.json', 'proibido.json', 'conflito.json']) await assert.rejects(LD.bytes(base + nome), new RegExp(nome));
      const x = await LD.pede(base + 'a.json', { 'If-None-Match': '"e1"' });
      assert.strictEqual(x.status, 304);
      const h = await LD.cabecalho(base + 'a.json');
      assert.deepStrictEqual([h.status, h.etag, h.bytes], [200, '"e1"', 6]);
      assert.ok(pedidos.some((p) => p[1] && p[1].conditions), 'o If-None-Match chegou ao SDK');
      delete process.env.DADOS_STORAGE;
    });
    await caso('SAS: vai na query; sem ele, o servidor recusa', async () => {
      process.env._EXIGE_SAS = '1';
      process.env.DADOS_SAS = '?sv=2024&sr=c&sig=abc';
      assert.deepStrictEqual(await LD.json(base + 'a.json'), { x: 1 });
      assert.ok(/sig=abc/.test(ultimaQuery));
      delete process.env.DADOS_SAS;
      await assert.rejects(LD.bytes(base + 'a.json'), /403 AuthenticationFailed/);
      delete process.env._EXIGE_SAS;
    });
    await caso('público: um aviso; só o BlobNotFound é null; o anônimo no privado e a conta fechada estouram', async () => {
      LD._zeraAviso(); avisos.length = 0;
      assert.deepStrictEqual(await LD.json(base + 'a.json'), { x: 1 });
      await LD.json(base + 'a.json');
      assert.strictEqual(avisos.length, 1, 'um aviso por processo');
      assert.strictEqual(await LD.bytes(base + 'nao-ha.json'), null);
      await assert.rejects(LD.bytes(base + 'privado.json'), /404 ResourceNotFound/);
      await assert.rejects(LD.bytes(base + 'fechado.json'), /409 PublicAccessNotPermitted/);
    });
    await caso('fora do contêiner passa direto; json trata gzip e BOM', async () => {
      process.env.DADOS_STORAGE = 'conn';   /* mesmo com credencial, o que não é do `dados` vai pelo http */
      const x = await LD.pede('http://127.0.0.1:' + srv.address().port + '/fora/x.csv');
      assert.strictEqual(x.buf.toString(), 'ok');
      delete process.env.DADOS_STORAGE;
      assert.deepStrictEqual(await LD.json(base + 'gz.json'), { y: 2 });
    });
  } finally { console.log = log; srv.close(); }
  console.log('ensaio-le-dados: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
