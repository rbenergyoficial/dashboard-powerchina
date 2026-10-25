'use strict';
/*
 * ensaio-saidas-proprias.js — prova a SAÍDA PRÓPRIA pela cópia em disco (lib-le-dados.js, 24/10/2026).
 *
 * Sem rede e sem segredo: um contêiner simulado (download com condição, getProperties, upload) com etag por blob; a suíte roda num
 * processo filho com as variáveis do caso.
 *   1. primeira leitura de um nome do padrão: pela rede, e a cópia é guardada; a segunda vai com If-None-Match e o 304 devolve os MESMOS
 *      bytes, sem corpo pela rede;
 *   2. blob regravado (outra etag): a cópia NÃO vale, vem inteiro e a cópia é trocada — a cópia só serve com a confirmação do storage;
 *   3. o ESCREVE de verdade do gen-sungrow (extraído do arquivo e executado com um contêiner simulado) lembra a etag do upload: a leitura
 *      seguinte do mesmo nome vem pela cópia (304);
 *   4. nome fora do padrão: pedido sem condição, nada no disco; lembra() de nome fora do padrão não grava;
 *   5. 404: devolve 404 e a cópia sai; cópia corrompida (tamanho diferente da marca): ignorada, vem pela rede; o 304 a um pedido sem cópia
 *      estoura (nunca devolve "nada" a quem chama);
 *   6. o If-None-Match de quem chama, nas duas grafias, passa intacto (o 304 volta para ele); o HEAD de um nome do padrão não baixa nada;
 *   7. a poda do escritor: a cópia de nome que a rodada não leu nem lembrou sai do disco; a usada fica;
 *   8. desligada (os outros workflows): sem as duas variáveis, só com o padrão, ou só com o diretório — nenhum pedido condicional, nada
 *      contado, nenhuma pasta criada, nenhum erro;
 *   9. a fiação no sungrow.yml: os 6 passos que releem sg_* com as duas variáveis, nenhum passo com uma só, o ensaio antes do gerar e o
 *      gerar dependendo dele, e o save da pasta depois do gerar.
 * PLANTIOS na lib (cada um TEM de reprovar a suíte, com a mensagem do caso certo e sem erro de sintaxe): a cópia devolvida sem perguntar
 * ao storage; o lembra que não grava; a lib ligada só pelo padrão; e, no gen-sungrow, o lembra que não roda.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.argv[2] === '--suite') { suite(process.argv[3], process.argv[4]).catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); }); return; }

/* --so <workflow> (revisor-workflow, RW-001): o workflow roda SÓ a parte dele (a suíte da lib com o gravador dele, a fiação dele e os
   plantios dele): mexer no sungrow não barra o trafo-medidor, nem o contrário. Sem --so (o ensaios.yml), os dois */
const MODOS = { 'sungrow': 'gen-sungrow.js', 'trafo-medidor': 'gen-trafo-way2.js' };
const iSo = process.argv.indexOf('--so'), SO = iSo > 0 ? process.argv[iSo + 1] : null;
if (SO && !MODOS[SO]) { console.error('--so desconhecido: ' + SO + ' (' + Object.keys(MODOS).join(', ') + ')'); process.exit(2); }
const RODA = SO ? [SO] : Object.keys(MODOS);
const LIB = path.join(__dirname, 'lib-le-dados.js');
const GEN = path.join(__dirname, MODOS[RODA[0]]);
const TMPS = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-proprios-')); TMPS.push(d); return d; };
function roda(lib, gen, env) {
  const e = Object.assign({}, process.env, { DADOS_STORAGE: 'conn' }, env);
  for (const k of Object.keys(e)) if (e[k] === null) delete e[k];
  const r = spawnSync(process.execPath, [__filename, '--suite', lib, gen], { env: e, encoding: 'utf8' });
  return { cod: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
let falhas = 0;
const ok = (c, m) => { console.log((c ? '  ok · ' : '  REPROVADO · ') + m); if (!c) falhas++; };
const LIGADA = () => ({ LE_DADOS_PROPRIOS: '^sg_', CACHE_BLOB_DIR: tmp() });

try {
  console.log('modos: ' + RODA.join(', '));
  for (const m of RODA) {
    console.log('a lib de verdade, com o gravador do ' + m + ' (' + MODOS[m] + ')');
    const R = roda(LIB, path.join(__dirname, MODOS[m]), LIGADA());
    process.stdout.write(R.out.split('\n').filter(Boolean).map((l) => '    ' + l).join('\n') + '\n');
    ok(R.cod === 0, 'a suíte passa com a lib e o ' + MODOS[m] + ' de verdade');
  }
  for (const [rot, env] of [['sem as duas variáveis', { LE_DADOS_PROPRIOS: null, CACHE_BLOB_DIR: null }],
    ['só com o padrão', { LE_DADOS_PROPRIOS: '^sg_', CACHE_BLOB_DIR: null }], ['só com o diretório', { LE_DADOS_PROPRIOS: null, CACHE_BLOB_DIR: tmp() }]]) {
    const x = roda(LIB, GEN, Object.assign({ _ENSAIO_DESLIGADO: '1' }, env));
    ok(x.cod === 0 && /desligada: /.test(x.out), 'desligada ' + rot + ': nada muda (' + (x.out.trim().split('\n').pop() || '').slice(0, 110) + ')');
  }

  if (RODA.indexOf('sungrow') >= 0) {
    console.log('a fiação no sungrow.yml');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'sungrow.yml'), 'utf8').replace(/\r\n/g, '\n');
    const passos = wf.split(/\n      - name: /).slice(1).map((p) => ({ nome: p.split('\n')[0].trim(), corpo: p }));
    const ESPERADOS = ['Gerar sg_*.json', 'Ensaio · a cascata da usina no dia (produto)', 'Gerar perdas_diario, perdas_inv, strings_alarme e inv_scada pelo logger',
      'Ensaio · dado de inversor das telas pelo logger (produto)', 'Gerar pvstr_hora e pvstr_str pelo logger', 'Ensaio · strings de 30 min pelo logger (produto)'];
    const tem = (p, v) => (v === 'P' ? /\n\s+LE_DADOS_PROPRIOS: '\^sg_'/ : /\n\s+CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-sungrow/).test(p.corpo);
    const ligados = passos.filter((p) => tem(p, 'P')).map((p) => p.nome);
    ok(JSON.stringify(ligados) === JSON.stringify(ESPERADOS), 'os 6 passos que releem sg_* com o padrão, e só eles (' + ligados.length + ')');
    ok(passos.filter((p) => tem(p, 'P') && !tem(p, 'D')).length === 0, 'nenhum passo com o padrão sem o diretório');
    const iE = passos.findIndex((p) => /^Ensaio · a saida propria pela copia/.test(p.nome)), iG = passos.findIndex((p) => p.nome === 'Gerar sg_*.json');
    const iS = passos.findIndex((p) => /path: \.cache-sungrow/.test(p.corpo) && /actions\/cache\/save@(?:v4|[0-9a-f]{40})/.test(p.corpo));
    ok(iE >= 0 && iE < iG && /id: r_proprios/.test(passos[iE].corpo) && /run: node scripts\/ensaio-saidas-proprias\.js --so sungrow\n/.test(passos[iE].corpo)
      && /steps\.r_proprios\.outcome == 'success'/.test(passos[iG].corpo), 'o ensaio da saída própria (--so sungrow) roda antes do gerar, e o gerar depende dele');
    ok(iS > iG && /steps\.gen_sg\.outcome == 'success'/.test(passos[iS].corpo), 'a pasta é guardada depois do gerar, só com o gerar verde');
  }

  if (RODA.indexOf('trafo-medidor') >= 0) {
    console.log('a fiação no trafo-medidor.yml');   // o produto dos trafo_* relido pela cópia no mesmo job
    const wt = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'trafo-medidor.yml'), 'utf8').replace(/\r\n/g, '\n');
    const pt = wt.split(/\n      - name: /).slice(1).map((p) => ({ nome: p.split('\n')[0].trim(), corpo: p }));
    const PADRAO_T = "LE_DADOS_PROPRIOS: '^trafo_(5min|15min|30min|60min|diario)\\.json$'";
    const ligT = pt.filter((p) => p.corpo.indexOf(PADRAO_T) >= 0 && /\n\s+CACHE_BLOB_DIR: /.test(p.corpo)).map((p) => p.nome);
    ok(ligT.length === 2 && /^Gerar trafo_/.test(ligT[0]) && /^Ensaio · o publicado contra o medidor/.test(ligT[1])
      && !pt.some((p) => /LE_DADOS_PROPRIOS/.test(p.corpo) && !/CACHE_BLOB_DIR/.test(p.corpo)),
      'o gerar e o ensaio de produto com o padrão dos trafo_* e o diretório, e nenhum outro (' + ligT.join(' | ') + ')');
    const iE = pt.findIndex((p) => /^Ensaio · a saida propria pela copia/.test(p.nome)), iG = pt.findIndex((p) => /^Gerar trafo_/.test(p.nome));
    const semIf = pt.slice(iE, iG + 1).every((p) => !/\n\s+if: /.test(p.corpo));
    ok(iE >= 0 && iE < iG && semIf && /run: node scripts\/ensaio-saidas-proprias\.js --so trafo-medidor\n/.test(pt[iE].corpo),
      'o ensaio da saída própria (--so trafo-medidor) roda antes do gerar, e o gerar depende dele (nenhum if entre os dois: o success() padrão)');
  }

  console.log('plantios (cada um reprova com a mensagem do caso certo)');
  const planta = (nome, arq, de, para, esperado, env) => {
    const orig = arq === 'lib' ? LIB : path.join(__dirname, arq);
    const src = fs.readFileSync(orig, 'utf8').replace(/\r\n/g, '\n');
    if (src.split(de).length !== 2) { ok(false, 'plantio "' + nome + '": trecho não casou'); return; }
    const d = tmp(), p = path.join(d, path.basename(orig));
    fs.writeFileSync(p, src.split(de).join(para));
    // a lib-le-dados abre o contêiner pela lib-conteiner (require relativo): a plantada leva a irmã junto, senão quebra em vez de reprovar
    if (arq === 'lib') fs.copyFileSync(path.join(__dirname, 'lib-conteiner.js'), path.join(d, 'lib-conteiner.js'));
    const x = roda(arq === 'lib' ? p : LIB, arq === 'lib' ? GEN : p, env || LIGADA());
    const limpo = !/SyntaxError|Cannot find module/.test(x.out);
    ok(x.cod !== 0 && limpo && x.out.indexOf(esperado) >= 0, 'plantio "' + nome + '" reprova em "' + esperado + '"' + (limpo ? '' : ' (QUEBROU: ' + x.out.split('\n').find((l) => /Error/.test(l)) + ')'));
  };
  planta('a cópia sem perguntar ao storage', 'lib', "  const d = dirP(), c = d ? leP(d, nome) : null;\n",
    "  const d = dirP(), c = d ? leP(d, nome) : null;\n  if (c) { EP.copia++; return { status: 200, etag: c.etag, buf: c.buf, bytes: c.buf.length }; }\n", '1: a segunda vai com If-None-Match');
  planta('o lembra que não grava', 'lib', 'if (PROP && PROP.test(nome) && gravaP(dirP(), nome, etag, buf, um)) EP.lembrados++;', 'if (false) EP.lembrados++;',
    '3: o gravador lembrou a etag do upload');
  planta('o lembra que ignora o padrão', 'lib', 'if (PROP && PROP.test(nome) && gravaP(', 'if (PROP && gravaP(', '4: lembra de nome fora do padrão não grava');
  planta('a lib ligada só pelo padrão', 'lib', "process.env.LE_DADOS_PROPRIOS && process.env.CACHE_BLOB_DIR ?", 'process.env.LE_DADOS_PROPRIOS ?', 'FALHOU',
    { _ENSAIO_DESLIGADO: '1', LE_DADOS_PROPRIOS: '^sg_', CACHE_BLOB_DIR: null });
  if (RODA.indexOf('sungrow') >= 0) {
    planta('o gen-sungrow sem lembrar', 'gen-sungrow.js', "  if (OUT === 'dados') LD.lembra(nome, up.etag, gz);", "  if (OUT === 'nunca') LD.lembra(nome, up.etag, gz);",
      '3: o gravador lembrou a etag do upload');
    planta('o gen-sungrow lembra outra etag', 'gen-sungrow.js', 'LD.lembra(nome, up.etag, gz)', "LD.lembra(nome, '\"x\"', gz)", '3: a leitura seguinte veio pela cópia');
  }
  if (RODA.indexOf('trafo-medidor') >= 0) {
    const LT = "if (OUT_CONTAINER === 'dados') require('./lib-le-dados.js').lembra(nome, up.etag, gz);";
    planta('o gen-trafo-way2 sem lembrar', 'gen-trafo-way2.js', LT, LT.replace("'dados'", "'nunca'"), '3: o gravador lembrou a etag do upload');
    planta('o gen-trafo-way2 lembra outra etag', 'gen-trafo-way2.js', 'lembra(nome, up.etag, gz)', "lembra(nome, '\"x\"', gz)", '3: a leitura seguinte veio pela cópia');
  }
} finally {
  for (const d of TMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { } }
}
console.log('\n' + (falhas ? 'REPROVADO: ' + falhas : 'APROVADO'));
process.exit(falhas ? 1 : 0);

/* ── a suíte (processo filho) ── */
async function suite(lib, gen) {
  const assert = require('assert');
  const zlib = require('zlib');
  const LD = require(lib);
  const B = {}, PED = [], HEADS = [];
  const poe = (nome, buf, etag) => { B[nome] = { buf: Buffer.isBuffer(buf) ? buf : Buffer.from(buf), etag }; };
  const erro = (st, code) => Object.assign(new Error('falso ' + st), { statusCode: st, code });
  let n = 0;
  const cont = { getBlobClient: (nome) => ({
    download: async (o, c, opc) => {
      const inm = opc && opc.conditions && opc.conditions.ifNoneMatch; PED.push([nome, inm || null]);
      if (nome === 'sg_sempre304.json') throw erro(304);
      const b = B[nome]; if (!b) throw erro(404, 'BlobNotFound');
      if (inm && inm === b.etag) throw erro(304);
      return { etag: b.etag, lastModified: new Date('2026-10-24T12:00:00Z'), readableStreamBody: (async function* () { yield b.buf; })() };
    },
    getProperties: async () => { HEADS.push(nome); const b = B[nome]; if (!b) throw erro(404, 'BlobNotFound'); return { etag: b.etag, contentLength: b.buf.length }; },
  }), getBlockBlobClient: (nome) => ({ upload: async (buf) => { const etag = '"u' + (++n) + '"'; poe(nome, Buffer.from(buf), etag); return { etag }; } }) };
  LD._usa(cont);
  const url = (nm) => LD.BASE + nm;
  const pede = (nm, h) => LD.pede(url(nm), h);

  if (process.env._ENSAIO_DESLIGADO) {
    poe('sg_a.json', '{"a":1}', '"e1"');
    await pede('sg_a.json'); await pede('sg_a.json'); LD.lembra('sg_a.json', '"e1"', Buffer.from('{"a":1}')); LD.podaProprios();
    assert.ok(PED.every((p) => p[1] === null), 'desligada: nenhum pedido condicional');
    assert.strictEqual(LD._est.copia + LD._est.rede + LD._est.lembrados + LD._est.podados, 0, 'desligada: nada contado');
    if (process.env.CACHE_BLOB_DIR) assert.ok(!fs.existsSync(path.join(process.env.CACHE_BLOB_DIR, 'proprios')), 'desligada: nenhuma pasta criada');
    console.log('desligada: ' + PED.length + ' pedidos sem condição, nada contado, nenhuma pasta'); return;
  }
  const dir = path.join(process.env.CACHE_BLOB_DIR, 'proprios');
  const meta = (nm) => path.join(dir, encodeURIComponent(nm) + '.meta');
  // 1
  poe('sg_a.json', '{"a":1}', '"e1"');
  let x = await pede('sg_a.json');
  assert.strictEqual(x.buf.toString(), '{"a":1}'); assert.strictEqual(PED[PED.length - 1][1], null, '1: a primeira vai sem condição');
  assert.ok(fs.existsSync(meta('sg_a.json')), '1: a cópia foi guardada');
  x = await pede('sg_a.json');
  assert.strictEqual(PED[PED.length - 1][1], '"e1"', '1: a segunda vai com If-None-Match'); assert.strictEqual(x.status, 200, '1: quem chama recebe 200');
  assert.strictEqual(x.buf.toString(), '{"a":1}', '1: os bytes da cópia'); assert.strictEqual(LD._est.copia, 1, '1: contada como cópia');
  // lote11-custo: o 304 do SDK não traz a data de gravação, e os ensaios que julgam a safra do arquivo leem por ela
  assert.ok(x.ultimaMod && Date.parse(x.ultimaMod) === Date.parse('2026-10-24T12:00:00Z'), '1: a cópia devolve a data de gravação do blob');
  console.log('1. primeira pela rede, segunda pela cópia (304) com os mesmos bytes');
  // 2
  poe('sg_a.json', '{"a":2}', '"e2"');
  x = await pede('sg_a.json'); assert.strictEqual(x.buf.toString(), '{"a":2}', '2: o blob regravado vem novo');
  x = await pede('sg_a.json'); assert.strictEqual(PED[PED.length - 1][1], '"e2"', '2: a cópia nova tem a etag da resposta'); assert.strictEqual(x.buf.toString(), '{"a":2}');
  console.log('2. blob regravado: a cópia antiga não vale, a nova é guardada com a etag da resposta');
  // 3: o GRAVADOR de verdade do workflow (o escreve do gen-sungrow ou o grava do gen-trafo-way2), extraído do arquivo e executado
  const gsrc = fs.readFileSync(gen, 'utf8').replace(/\r\n/g, '\n');
  const ehTrafo = /gen-trafo-way2\.js$/.test(gen);
  const assinatura = ehTrafo ? 'async function grava(nome, obj) {' : 'async function escreve(nome, obj) {';
  const i0 = gsrc.indexOf(assinatura), i1 = gsrc.indexOf('\n}\n', i0);
  assert.ok(i0 > 0 && i1 > i0, '3: o gravador foi achado em ' + path.basename(gen));
  const corpo = gsrc.slice(i0, i1 + 2) + '\nreturn ' + (ehTrafo ? 'grava' : 'escreve') + ';';
  const falsoRequire = (m) => (m === '@azure/storage-blob' ? { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => cont }) } } : m === './lib-le-dados.js' ? LD : require(m));
  const grava = ehTrafo
    ? new Function('zlib', 'fs', 'path', 'require', 'OUT_CONTAINER', 'process', corpo)(zlib, fs, path, falsoRequire, 'dados', { env: { DADOS_STORAGE: 'conn' } })
    : new Function('zlib', 'fs', 'path', 'svc', 'OUT', 'LD', 'process', corpo)(zlib, fs, path, () => ({ getContainerClient: () => cont }), 'dados', LD, { env: {} });
  const l0 = LD._est.lembrados, c0 = LD._est.copia;
  await grava('sg_b.json', { b: 1 });
  assert.strictEqual(LD._est.lembrados, l0 + 1, '3: o gravador lembrou a etag do upload');
  x = await pede('sg_b.json');
  assert.strictEqual(LD._est.copia, c0 + 1, '3: a leitura seguinte veio pela cópia'); assert.deepStrictEqual(JSON.parse(zlib.gunzipSync(x.buf)), { b: 1 });
  console.log('3. o gravador do ' + path.basename(gen) + ' lembra a etag do upload; a leitura seguinte vem pela cópia');
  // 4
  poe('executivo.json', '{"e":1}', '"x1"'); await pede('executivo.json'); await pede('executivo.json');
  assert.ok(PED.filter((p) => p[0] === 'executivo.json').every((p) => p[1] === null), '4: fora do padrão, sem condição');
  const l1 = LD._est.lembrados; LD.lembra('executivo.json', '"x1"', Buffer.from('{}'));
  assert.ok(!fs.existsSync(meta('executivo.json')) && LD._est.lembrados === l1, '4: lembra de nome fora do padrão não grava');
  console.log('4. nome fora do padrão: sem condição, sem cópia, e o lembra não grava');
  // 5
  delete B['sg_b.json']; x = await pede('sg_b.json');
  assert.strictEqual(x.status, 404); assert.ok(!fs.existsSync(meta('sg_b.json')), '5: a cópia do 404 sai');
  fs.writeFileSync(path.join(dir, encodeURIComponent('sg_a.json')), 'xx'); const r0 = LD._est.rede; x = await pede('sg_a.json');
  assert.strictEqual(LD._est.rede, r0 + 1, '5: cópia corrompida vem pela rede'); assert.strictEqual(x.buf.toString(), '{"a":2}');
  await assert.rejects(() => pede('sg_sempre304.json'), /304 sem copia/, '5: o 304 sem cópia estoura');
  console.log('5. 404 tira a cópia; cópia corrompida é ignorada; 304 sem cópia estoura');
  // 6
  x = await LD.pede(url('sg_a.json'), { 'If-None-Match': '"e2"' }); assert.strictEqual(x.status, 304, '6: o If-None-Match de quem chama passa intacto');
  x = await LD.pede(url('sg_a.json'), { 'if-none-match': '"e2"' }); assert.strictEqual(x.status, 304, '6: o if-none-match de quem chama passa intacto');
  const d0 = PED.length; x = await LD.cabecalho(url('sg_a.json'));
  assert.strictEqual(PED.length, d0, '6: o HEAD não baixa'); assert.strictEqual(HEADS[HEADS.length - 1], 'sg_a.json');
  console.log('6. o If-None-Match de quem chama, nas duas grafias, volta 304; o HEAD não baixa');
  // 7
  fs.writeFileSync(path.join(dir, encodeURIComponent('sg_velho.json')), 'v'); fs.writeFileSync(meta('sg_velho.json'), JSON.stringify({ etag: '"v"', bytes: 1 }));
  LD.podaProprios();
  assert.ok(!fs.existsSync(meta('sg_velho.json')) && fs.existsSync(meta('sg_a.json')), '7: a poda tira o não usado e deixa o usado');
  console.log('7. a poda tira a cópia que a rodada não usou');
  console.log('suíte: ' + LD.resumoProprios());
}
