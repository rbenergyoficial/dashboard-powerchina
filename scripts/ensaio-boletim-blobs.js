#!/usr/bin/env node
/* ensaio-boletim-blobs.js · o transporte do Boletim de Desempenho, sem rede: um contêiner falso no lugar do `dados`.
 * Casos: o blob em gzip chega puro (JSON legível); o opcional ausente (404 BlobNotFound) segue e o obrigatório ausente para; o 404 de
 * contêiner não é "opcional ausente"; virada do mês (o arquivo do ONS do mês corrente ainda não existe); a ordem de subida (edições,
 * depois fila, índice e estado). PLANTIOS (cada um TEM de reprovar): sem descomprimir; o ONS obrigatório; qualquer 404 vale como
 * ausente; a ordem de subida alfabética.
 *   node scripts/ensaio-boletim-blobs.js      sai 0 = aprovado */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), Module = require('module');

const ALVO = path.join(__dirname, 'boletim-blobs.js');
const FONTE = fs.readFileSync(ALVO, 'utf8');

function carrega(src) {
  const m = new Module(ALVO, null);
  m.filename = ALVO; m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src, ALVO);
  return m.exports;
}

function falso(blobs) {   // blobs: nome -> Buffer | erro
  const subidos = [];
  return {
    subidos,
    getBlobClient: (n) => ({ downloadToBuffer: async () => {
      const b = blobs[n];
      if (b instanceof Error) throw b;
      if (!b) { const e = new Error('The specified blob does not exist.'); e.statusCode = 404; e.code = 'BlobNotFound'; throw e; }
      return b;
    } }),
    gz: {},
    getBlockBlobClient: function (n) { const self = this; return {
      uploadFile: async () => { subidos.push(n); },
      uploadData: async (b, o) => { subidos.push(n); self.gz[n] = (o && o.blobHTTPHeaders && o.blobHTTPHeaders.blobContentEncoding) === 'gzip' && b[0] === 0x1f && b[1] === 0x8b; } }; },
  };
}

async function casos(B) {
  const falhas = [];
  const ok = (c, msg) => { if (!c) falhas.push(msg); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bol-blobs-'));
  const log = console.log; console.log = () => {};   // o log do transporte não polui o veredito
  try {
    const agora = new Date('2026-12-01T10:30:00Z');   // 01/12 07:30 em Brasília: o ONS de dezembro ainda não existe
    const gz = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
    const leve = { 'acervo/catalogo.json': gz({ documentos: [] }), 'boletim/estado.json': gz({ semeado: 'x', desde: '2026-11-06', feitos: [] }),
      'ons_restricao_2026_11.json': gz({ consolidado: [] }) };
    // 1. gzip chega puro; 2. opcional ausente segue (fila, índice e o ONS de dezembro)
    B._usaConteiner(falso(leve));
    let erro = null;
    try { await B.baixa(path.join(tmp, 'a'), 'leve', agora); } catch (e) { erro = e; }
    ok(!erro, 'virada do mês: sem o arquivo do ONS do mês corrente, a baixa leve segue' + (erro ? ' (' + erro.message + ')' : ''));
    let est = null;
    try { est = JSON.parse(fs.readFileSync(path.join(tmp, 'a', 'boletim__estado.json'), 'utf8')); } catch (e) { }
    ok(est && est.desde === '2026-11-06', 'o blob em gzip é gravado como JSON puro');
    ok(!fs.existsSync(path.join(tmp, 'a', 'ons_restricao_2026_12.json')), 'o opcional ausente não vira arquivo');
    // 2b. as curvas da página são derivadas: no blob corrompidas (gzip quebrado, JSON quebrado, esquema outro) valem como ausentes;
    //     o estado corrompido continua parando
    for (const [rot, b] of [['gzip quebrado', Buffer.from([0x1f, 0x8b, 1, 2, 3])], ['JSON quebrado', Buffer.from('{"esq')], ['esquema outro', gz({ esquema: 2 })]]) {
      B._usaConteiner(falso(Object.assign({}, leve, { 'boletim/curvas.json': b })));
      erro = null;
      try { await B.baixa(path.join(tmp, 'cv' + rot.replace(/ /g, '')), 'leve', agora); } catch (e) { erro = e; }
      ok(!erro && !fs.existsSync(path.join(tmp, 'cv' + rot.replace(/ /g, ''), 'boletim__curvas.json')) && fs.existsSync(path.join(tmp, 'cv' + rot.replace(/ /g, ''), 'boletim__estado.json')),
        'curvas.json corrompido no blob (' + rot + '): vale como ausente e o resto desce' + (erro ? ' (' + erro.message + ')' : ''));
    }
    B._usaConteiner(falso(Object.assign({}, leve, { 'boletim/estado.json': Buffer.from('{"esq') })));
    erro = null;
    try { await B.baixa(path.join(tmp, 'ce'), 'leve', agora); } catch (e) { erro = e; }
    ok(erro && /estado/.test(erro.message), 'o estado corrompido continua parando a baixa');
    // 3. obrigatório ausente para
    B._usaConteiner(falso({ 'boletim/estado.json': gz({}) }));
    erro = null;
    try { await B.baixa(path.join(tmp, 'b'), 'leve', agora); } catch (e) { erro = e; }
    ok(erro && /catalogo/.test(erro.message), 'o catálogo ausente para a baixa');
    // 4. 404 de contêiner (ou 403) não é opcional ausente
    const cont = new Error('container'); cont.statusCode = 404; cont.code = 'ContainerNotFound';
    B._usaConteiner(falso(Object.assign({}, leve, { 'boletim/fila.json': cont })));
    erro = null;
    try { await B.baixa(path.join(tmp, 'c'), 'leve', agora); } catch (e) { erro = e; }
    ok(erro && /fila/.test(erro.message), 'o 404 de contêiner para a baixa (não é "opcional ausente")');
    // 5. ordem de subida
    const ordem = B.ordem(['boletim/estado.json', 'boletim/fila.json', 'boletim/indice.json', 'boletim/diario/2026-11-07/diario_claro.html',
      'boletim/enviados/2026-11-08/EN/diario_claro_en.pdf', 'boletim/fatos/recorde-2026-11-07.mp4']);
    ok(ordem.slice(-3).join(',') === 'boletim/fila.json,boletim/indice.json,boletim/estado.json' && ordem[0].startsWith('boletim/diario/'),
      'a subida põe edições, enviados e fatos antes de fila, índice e estado: ' + ordem.join(' '));
    const sai = path.join(tmp, 's', 'saida', 'boletim');
    for (const n of ['estado.json', 'fila.json', 'indice.json', 'diario/2026-11-07/diario_claro.html', 'fatos/x.mp4', 'curvas.json']) {
      fs.mkdirSync(path.dirname(path.join(sai, n)), { recursive: true }); fs.writeFileSync(path.join(sai, n), '{}');
    }
    const f = falso({}); B._usaConteiner(f);
    await B.sobe(path.join(tmp, 's'));
    ok(f.subidos.slice(-3).join(',') === 'boletim/fila.json,boletim/indice.json,boletim/estado.json' && f.subidos.length === 6,
      'a subida de verdade segue a ordem: ' + f.subidos.join(' '));
    ok(f.gz['boletim/curvas.json'] === true, 'as curvas da página sobem em gzip, com o Content-Encoding (a API repassa)');
  } finally { console.log = log; fs.rmSync(tmp, { recursive: true, force: true }); }
  return falhas;
}

const PLANTIOS = [
  ['sem descomprimir', "b.length > 1 && b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b", 'b'],
  ['o ONS obrigatório', "opcional: [...LEVE.opcional, ...meses(agora)] };", "opcional: LEVE.opcional, exige: [...LEVE.exige, ...meses(agora)] };"],
  ['qualquer 404 vale como ausente', "e.statusCode === 404 && (e.code === 'BlobNotFound' || (e.details && e.details.errorCode === 'BlobNotFound'))", 'e.statusCode === 404'],
  ['curvas.json corrompido no blob', "if (DERIVADOS.includes(nome)) { console.log(", "if (false) { console.log("],
  ['as curvas sobem sem gzip', "const GZIP = ['boletim/curvas.json'];", 'const GZIP = [];'],
  ['a ordem de subida alfabética', "return [...resto, ...ULTIMOS.filter((n) => nomes.includes(n))];", 'return nomes.slice().sort();'],
];

(async () => {
  let ruim = false;
  const f0 = await casos(carrega(FONTE));
  f0.forEach((f) => console.log('  FALHOU ·', f));
  console.log('código real:', f0.length ? 'REPROVADO (' + f0.length + ')' : 'APROVADO');
  ruim = f0.length > 0;
  for (const [nome, de, para] of PLANTIOS) {
    if (FONTE.split(de).length !== 2) { console.log('  PLANTIO SEM ÂNCORA:', nome); ruim = true; continue; }
    let f;
    try { f = await casos(carrega(FONTE.replace(de, para))); } catch (e) { f = ['quebrou: ' + e.message]; }
    console.log('  plantio "' + nome + '": ' + (f.length ? 'reprovado, como devia (' + f[0] + ')' : 'PASSOU — o ensaio não pega'));
    ruim = ruim || !f.length;
  }
  console.log('ensaio do transporte do boletim:', ruim ? 'REPROVADO' : 'APROVADO');
  process.exit(ruim ? 1 : 0);
})();
