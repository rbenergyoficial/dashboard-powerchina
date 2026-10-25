'use strict';
/*
 * ensaio-le-blob.js — a leitura condicional do historico do medidor (`lib-le-blob.js`, custo-a, 17/10/2026).
 *
 * Sem rede: o `https.get` e trocado por um storage falso em memoria, que conta os pedidos e responde 200, 304 (com If-None-Match igual
 * ao etag), 404 e 500. Julga:
 *   1. endereco fora do historico passa direto, sem copia nem memoria;
 *   2. na mesma rodada o mesmo dia e pedido UMA vez;
 *   3. na rodada seguinte o pedido leva If-None-Match, o storage responde 304 e os bytes sao os da copia, identicos;
 *   4. dia que mudou vem inteiro (200) e a copia e trocada;
 *   5. 404 = null; 500 estoura com o status; falha nao fica memorizada;
 *   6. copia corrompida (tamanho diferente) nao vale: pedido sem If-None-Match;
 *   7. copia parada ha mais de 4 dias sai do disco;
 *   8. os geradores e os workflows estao ligados (fonte): hist/way2 pela lib, copia local da rodada, cache restaurado antes e guardado depois.
 * PLANTIOS (cada um TEM de reprovar): a lib sem o If-None-Match; a lib que devolve a copia mesmo com 200 novo.
 *
 * uso: node scripts/ensaio-le-blob.js [--so way2-agg | --so way2-recent]
 *   --so <workflow>  a lib (1-8b) e, no item 9, so os geradores que rodam NAQUELE workflow e o proprio .yml. Sem isso um lote
 *                    que mexe so no gen-pr congelava os agregados e o ao vivo. Sem opcao: tudo (o ensaios.yml, a cada push).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { EventEmitter } = require('events');

let falhas = 0, casos = 0;
const SO = (() => { const i = process.argv.indexOf('--so'); return i > 0 ? process.argv[i + 1] : ''; })();
const DE = { 'way2-agg': ['gen-way2-agg.js', 'way2-agg.yml'],
  'way2-recent': ['gen-way2-recent.js', 'gen-way2-eletrico.js', 'gen-dia-corrente.js', 'way2-recent.yml'],
  'trafo-medidor': ['gen-trafo-way2.js', 'trafo-medidor.yml'] };   // trafo-alvo-ensaio (24/10/2026): as copias do supervisorio pela lib
if (SO && !DE[SO]) { console.error('--so desconhecido: ' + SO + ' (' + Object.keys(DE).join(', ') + ')'); process.exit(1); }
const julga = (alvo) => !SO || DE[SO].includes(alvo);
function ok(cond, msg) { casos++; if (!cond) { falhas++; console.log('  REPROVADO · ' + msg); } else console.log('  ok · ' + msg); }

// ---- storage falso ----
const STO = new Map();   // url sem query -> { etag, buf } ; status especial: { status: 500 }
const LOG = [];
https.get = function (url, opts, cb) {
  const k = String(url).split('?')[0], h = (opts && opts.headers) || {}, x = STO.get(k);
  LOG.push({ url: k, inm: h['If-None-Match'] || null });
  const res = new EventEmitter(); res.resume = () => {}; res.headers = {};
  const req = new EventEmitter(); req.setTimeout = () => req;
  setImmediate(() => {
    if (!x) res.statusCode = 404;
    else if (x.status) res.statusCode = x.status;
    else if (h['If-None-Match'] && h['If-None-Match'] === x.etag) { res.statusCode = 304; res.headers.etag = x.etag; }
    else { res.statusCode = 200; res.headers.etag = x.etag; }
    cb(res);
    if (res.statusCode === 200) { res.emit('data', x.buf.slice(0, 5)); res.emit('data', x.buf.slice(5)); }
    res.emit('end');
  });
  return req;
};
const U = 'https://exemplo/dados/hist/way2_2026-10-15.json', U2 = 'https://exemplo/dados/hist/way2_2026-10-16.json', OUT = 'https://exemplo/dados/executivo.json';
function nova(lib) { delete require.cache[require.resolve(lib)]; return require(lib); }   /* uma "rodada" nova: memoria vazia, disco igual */

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-le-blob-'));
  process.env.CACHE_BLOB_DIR = dir;
  const LIB = path.join(__dirname, 'lib-le-blob.js');
  STO.set(U, { etag: '"0x1"', buf: Buffer.from('{"dados":[1,2,3]}') });
  STO.set(OUT, { etag: '"0x9"', buf: Buffer.from('{"x":1}') });

  console.log('1. fora do historico: direto');
  let LB = nova(LIB); LOG.length = 0;
  await LB.bytes(OUT); await LB.bytes(OUT);
  ok(LOG.length === 2 && !LOG.some((l) => l.inm) && (!fs.existsSync(path.join(dir, 'publico')) || !fs.readdirSync(path.join(dir, 'publico')).length), 'executivo.json pedido duas vezes, sem If-None-Match e sem copia');

  console.log('2. mesma rodada: o dia e pedido uma vez');
  LOG.length = 0;
  const a = await LB.bytes(U), b = await LB.bytes(U);
  ok(LOG.length === 1 && a.toString() === '{"dados":[1,2,3]}' && a === b, '1 pedido, os mesmos bytes nas duas leituras');

  console.log('3. rodada seguinte: If-None-Match, 304, bytes da copia');
  LB = nova(LIB); LOG.length = 0;
  const c = await LB.bytes(U);
  ok(LOG.length === 1 && LOG[0].inm === '"0x1"', 'o pedido leva o etag guardado');
  ok(c.toString() === '{"dados":[1,2,3]}' && LB._est.copia === 1 && LB._est.rede === 0, '304: os bytes vem da copia, nada da rede');

  console.log('4. o dia mudou: 200 e copia trocada');
  STO.set(U, { etag: '"0x2"', buf: Buffer.from('{"dados":[1,2,3,4]}') });
  LB = nova(LIB); LOG.length = 0;
  const d = await LB.bytes(U);
  ok(d.toString() === '{"dados":[1,2,3,4]}' && LB._est.rede === 1, 'veio o arquivo novo');
  LB = nova(LIB); LOG.length = 0;
  const e2 = await LB.bytes(U);
  ok(LOG[0].inm === '"0x2"' && e2.toString() === '{"dados":[1,2,3,4]}', 'a copia passou a ser a nova (etag 0x2)');

  console.log('5. 404, 500 e falha nao memorizada');
  ok((await LB.bytes(U2)) === null, '404 devolve null');
  STO.set(U2, { status: 500 });
  LB = nova(LIB);
  let msg = ''; try { await LB.bytes(U2); } catch (er) { msg = er.message; }
  ok(/^HTTP 500 /.test(msg), '500 estoura com o status (' + msg + ')');
  STO.set(U2, { etag: '"0x5"', buf: Buffer.from('{"dados":[]}') });
  let depois = null; try { depois = await LB.bytes(U2); } catch (er) { depois = null; }
  ok((depois || '').toString() === '{"dados":[]}', 'depois da falha, o pedido seguinte vai a rede (falha nao memorizada)');

  console.log('6. copia corrompida nao vale');
  const pub = path.join(dir, 'publico'), alvo = fs.readdirSync(pub).find((f) => !f.endsWith('.meta') && JSON.parse(fs.readFileSync(path.join(pub, f + '.meta'), 'utf8')).url === U);
  fs.writeFileSync(path.join(pub, alvo), 'lixo');
  LB = nova(LIB); LOG.length = 0;
  const f = await LB.bytes(U);
  ok(LOG[0].inm === null && f.toString() === '{"dados":[1,2,3,4]}', 'tamanho errado: pedido sem If-None-Match, arquivo inteiro');

  console.log('7. copia parada ha mais de 4 dias sai');
  const velho = path.join(pub, 'parado'); fs.writeFileSync(velho, 'x'); const t = new Date(Date.now() - 5 * 86400e3); fs.utimesSync(velho, t, t);
  LB = nova(LIB); await LB.bytes(U);
  ok(!fs.existsSync(velho), 'arquivo de 5 dias podado');

  console.log('8. plantios');
  /* fora do repositorio: o transporte (lib-le-dados, Fase 2) vai pelo caminho completo */
  const src = fs.readFileSync(LIB, 'utf8').replace("require('./lib-le-dados')", 'require(' + JSON.stringify(path.join(__dirname, 'lib-le-dados.js')) + ')');
  const p1 = path.join(dir, '_plantio_le_blob_1.js'), p2 = path.join(dir, '_plantio_le_blob_2.js');
  fs.writeFileSync(p1, src.replace("if (c) h['If-None-Match'] = c.etag;", ''));
  fs.writeFileSync(p2, src.replace('EST.rede++; EST.bytesRede += x.buf.length;', 'if (c) return c.buf; EST.rede++; EST.bytesRede += x.buf.length;'));
  try {
    let P = nova(p1); LOG.length = 0; await P.bytes(U); P = nova(p1); LOG.length = 0; await P.bytes(U);
    ok(LOG[0].inm === null, 'plantio "sem If-None-Match": o caso 3 reprovaria (o pedido sai sem etag)');
    STO.set(U, { etag: '"0x3"', buf: Buffer.from('{"dados":["novo"]}') });
    let Q = nova(p2); const g = await Q.bytes(U);
    ok(g.toString() !== '{"dados":["novo"]}', 'plantio "copia vence o 200": o caso 4 reprovaria (devolve o velho)');
  } finally { fs.unlinkSync(p1); fs.unlinkSync(p2); }

  console.log('8b. o dia aberto (hoje e futuro) nunca vai ao disco; a memoria guarda no maximo 8 dias');
  const UF = 'https://exemplo/dados/hist/way2_2099-01-01.json';
  STO.set(UF, { etag: '"0xF"', buf: Buffer.from('{"dados":["f"]}') });
  LB = nova(LIB); LOG.length = 0; await LB.bytes(UF); LB = nova(LIB); LOG.length = 0; await LB.bytes(UF);
  ok(LOG[0].inm === null && !fs.readdirSync(pub).some((f) => f.endsWith('.meta') && JSON.parse(fs.readFileSync(path.join(pub, f), 'utf8')).url === UF), 'dia futuro: sem copia, sem If-None-Match (o cache do GitHub nao regrava a toa)');
  LB = nova(LIB);
  for (let k = 1; k <= 10; k++) { const u = 'https://exemplo/dados/hist/way2_2026-09-' + ('0' + k).slice(-2) + '.json'; STO.set(u, { etag: '"m' + k + '"', buf: Buffer.from('{"k":' + k + '}') }); await LB.bytes(u); }
  ok(LB._memo.size === 8 && !LB._memo.has('https://exemplo/dados/hist/way2_2026-09-01.json'), 'memoria limitada a 8 dias, sai o mais antigo');

  /* trafo-alvo-ensaio (24/10/2026): o ramo das copias do supervisorio dos transformadores no ALVO (trafo-um-escritor, e57bcf0). A copia
     muda uma vez por dia e o gen-trafo-way2 a le de 15 em 15 min: na rodada seguinte, 304 pela copia em disco. O produto (trafo_5min)
     muda toda rodada e continua direto, sem copia */
  console.log('8b2. a copia do supervisorio dos transformadores: 304 na rodada seguinte; o produto, direto');
  const UT = 'https://exemplo/dados/trafo_scada_5min.json', UP = 'https://exemplo/dados/trafo_5min.json';
  STO.set(UT, { etag: '"0xT"', buf: Buffer.from('{"serie":["sup"]}') }); STO.set(UP, { etag: '"0xP"', buf: Buffer.from('{"serie":["med"]}') });
  LB = nova(LIB); LOG.length = 0; await LB.bytes(UT);
  ok(LOG.length === 1 && LOG[0].inm === null && fs.readdirSync(pub).some((f) => f.endsWith('.meta') && JSON.parse(fs.readFileSync(path.join(pub, f), 'utf8')).url === UT), 'trafo_scada_5min: primeira leitura vai a rede e guarda a copia');
  LB = nova(LIB); LOG.length = 0; const ts = await LB.bytes(UT);
  ok(LOG.length === 1 && LOG[0].inm === '"0xT"' && ts.toString() === '{"serie":["sup"]}' && LB._est.copia === 1 && LB._est.rede === 0, 'trafo_scada_5min: rodada seguinte com If-None-Match, 304, bytes da copia');
  ok(['trafo_scada_30min', 'trafo_scada_60min', 'trafo_scada_diario'].every((n) => LB.ALVO.test('https://exemplo/dados/' + n + '.json')) && !LB.ALVO.test('https://exemplo/dados/trafo_scada_15min.json'), 'o ALVO casa as quatro copias publicadas (5, 30 e 60 min e o diario) e so elas');
  LB = nova(LIB); LOG.length = 0; await LB.bytes(UP); LB = nova(LIB); LOG.length = 0; await LB.bytes(UP);
  ok(LOG.length === 1 && LOG[0].inm === null && !fs.readdirSync(pub).some((f) => f.endsWith('.meta') && JSON.parse(fs.readFileSync(path.join(pub, f), 'utf8')).url === UP), 'trafo_5min (o produto): direto, sem If-None-Match e sem copia');

  if (julga('gen-way2-agg.js')) {
  console.log('8c. o agregador: 200, 404 e 500 pela funcao de leitura de verdade');
  delete require.cache[require.resolve('./lib-le-blob')]; delete require.cache[require.resolve('./gen-way2-agg')];
  const AG = require('./gen-way2-agg');
  const UA = 'https://exemplo/dados/hist/way2_2026-08-01.json'; STO.set(UA, { etag: '"a"', buf: Buffer.from('﻿{"dados":[{"pontoId":1}]}') });
  ok(JSON.stringify(await AG.fetchBlob(UA)) === '{"dados":[{"pontoId":1}]}', '200: JSON lido (com BOM)');
  ok((await AG.fetchBlob('https://exemplo/dados/hist/way2_2026-08-02.json')) === null, '404: null, como antes');
  STO.set('https://exemplo/dados/hist/way2_2026-08-03.json', { status: 500 });
  let m5 = ''; try { await AG.fetchBlob('https://exemplo/dados/hist/way2_2026-08-03.json'); } catch (er) { m5 = er.message; }
  ok(/^HTTP 500 /.test(m5), '500: estoura, como antes');
  }

  console.log('9. ligacao nos geradores e nos workflows (fonte)' + (SO ? ' · so o ' + SO : ''));
  const L = (n) => fs.readFileSync(path.join(__dirname, n), 'utf8'), W = (n) => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', n), 'utf8');
  if (julga('gen-way2-agg.js')) ok(/if \(LB\.ALVO\.test\(url\)\) return LB\.bytes\(url\)/.test(L('gen-way2-agg.js')), 'gen-way2-agg: hist pela lib');
  if (julga('gen-executivo.js')) ok(/if \(LB\.ALVO\.test\(url\)\) return LB\.bytes\(url\)/.test(L('gen-executivo.js')), 'gen-executivo: hist pela lib');
  if (julga('gen-pr.js')) ok(/if \(LB\.ALVO\.test\(url\)( && !semCopia)?\) return LB\.bytes\(url, \{ 'Accept-Encoding': 'gzip' \}\)/.test(L('gen-pr.js')), 'gen-pr: hist pela lib');   /* fontes-logger (19/10): a migracao da irradiancia baixa o dia velho sem copia (`semCopia`) */
  if (julga('gen-dia-corrente.js')) ok(/ELET_LOCAL_DIR/.test(L('gen-dia-corrente.js')) && /LB\.ALVO\.test\(url\)/.test(L('gen-dia-corrente.js')), 'gen-dia-corrente: copia da rodada e hist pela lib');
  if (julga('gen-way2-recent.js')) ok(/LB\.bytes\(BASE_PUB \+ `hist\/way2_\$\{dd\}\.json`\)/.test(L('gen-way2-recent.js')) && /copiaL/.test(L('gen-way2-recent.js')), 'gen-way2-recent: dia fechado pela lib e o ao vivo da copia local');
  if (julga('gen-way2-eletrico.js')) ok(/fs\.writeFileSync\(path\.join\(d, 'way2_eletrico\.json'\), buf\)/.test(L('gen-way2-eletrico.js')), 'gen-way2-eletrico: grava a copia local com os bytes que subiram');
  if (julga('gen-way2-recent.js')) ok(/`way2_\$\{day\}\.json`\), buf\)/.test(L('gen-way2-recent.js')), 'gen-way2-recent: a copia do dia leva o nome e os bytes do hist que subiu');
  if (julga('gen-trafo-way2.js')) ok(/if \(\/\^trafo_scada_\/\.test\(nome\)\) return desembrulha\(await require\('\.\/lib-le-blob\.js'\)\.bytes\(BASE \+ nome/.test(L('gen-trafo-way2.js')), 'gen-trafo-way2: a copia do supervisorio pela lib (trafo-alvo-ensaio)');
  /* custo-executivo: o historico do medidor nunca entra num LE_DADOS_PROPRIOS (a lib-le-blob ja o copia, com poda, e o dia aberto nao vai ao
     disco); sem isso a entrada de cache cresceria sem fim */
  { const dir = path.join(__dirname, '..', '.github', 'workflows'), casam = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
      for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/LE_DADOS_PROPRIOS: '([^']+)'/g)) {
        const re = new RegExp(m[1]); if (['hist/way2_2026-10-24.json', 'hist/way2_2026-09-01.json'].some((n) => re.test(n))) casam.push(f);
      } }
    ok(!casam.length, 'nenhum LE_DADOS_PROPRIOS casa o historico do medidor' + (casam.length ? ' · casa em ' + casam.join(', ') : '')); }
  /* custo-executivo (24/10/2026): no executivo a copia vale para o JOB inteiro (env do job, com LE_DADOS_PROPRIOS): restaura antes do
     primeiro `node`, guarda depois do ultimo, e nenhum passo repete o CACHE_BLOB_DIR */
  if (julga('executivo.yml')) {
    const w = W('executivo.yml'), iR = w.indexOf('Restaurar a copia do historico do medidor'), iG = w.indexOf('Guardar a copia do historico do medidor');
    const iJ = w.indexOf('\n    env:'), iS = w.indexOf('\n    steps:'), iC = w.indexOf('CACHE_BLOB_DIR: ${{ github.workspace }}/.cache-blob');
    const nodes = [...w.matchAll(/run: node scripts\//g)].map((m) => m.index);
    ok(iJ > 0 && iC > iJ && iC < iS && /\n      LE_DADOS_PROPRIOS: '/.test(w.slice(iJ, iS)) && (w.match(/CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-blob/g) || []).length === 1
      && iR > iS && iR < nodes[0] && iG > nodes[nodes.length - 1], 'executivo.yml: a copia no env do job (com LE_DADOS_PROPRIOS), restaurada antes do primeiro node e guardada depois do ultimo');
  }
  /* way2-recent: 3 passos (snapshot, dia em curso e, desde o custo-executivo, o resumo do assistente com LE_DADOS_PROPRIOS) */
  for (const [wf, passos] of [['way2-recent.yml', 3], ['way2-agg.yml', 1], ['trafo-medidor.yml', 2]].filter(([w]) => julga(w))) {   /* + trafo-medidor (trafo-alvo-ensaio): o gerador e o --produto */   /* fonte-perfil-way2 (20/10): o --produto do ensaio-fontes-exec reconta o medidor pela copia */
    const w = W(wf), iR = w.indexOf('Restaurar a copia do historico do medidor'), iG = w.indexOf('Guardar a copia do historico do medidor');
    const iC = w.indexOf('CACHE_BLOB_DIR: ${{ github.workspace }}/.cache-blob');
    ok(iR > 0 && iC > iR && iG > w.lastIndexOf('CACHE_BLOB_DIR: ${{ github.workspace }}/.cache-blob') && (w.match(/CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-blob/g) || []).length === passos, wf + ': restaura ANTES do primeiro gerador, guarda DEPOIS do ultimo, ' + passos + ' passo(s) com CACHE_BLOB_DIR');
  }
  if (julga('way2-recent.yml')) ok((W('way2-recent.yml').match(/ELET_LOCAL_DIR: \$\{\{ runner\.temp \}\}\/eletrico/g) || []).length === 3, 'way2-recent: a copia local da rodada nos 3 passos (coleta, snapshot, dia em curso)');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('\n' + (falhas ? 'REPROVADO: ' + falhas + ' de ' + casos : 'APROVADO: ' + casos + ' de ' + casos));
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
