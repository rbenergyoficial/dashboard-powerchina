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
const FONTE = fs.readFileSync(ALVO, 'utf8').replace(/\r\n/g, '\n');   // CRLF na árvore do Windows, LF no runner: o plantio de várias linhas casa nos dois

function carrega(src) {
  const m = new Module(ALVO, null);
  m.filename = ALVO; m.paths = Module._nodeModulePaths(__dirname);
  m._compile(src, ALVO);
  return m.exports;
}

function falso(blobs) {   // blobs: nome -> Buffer | erro
  const subidos = [], pedidos = [];
  return {
    subidos, pedidos,
    getBlobClient: (n) => ({ downloadToBuffer: async () => {
      pedidos.push(n);
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
    // 6. a tarde (boletim-1730): a medição de 5 min do `dados` e as ordens da Iqony do contêiner do Gestão; sem as ordens, PARA
    const iq = { versao: 1, campos: ['dia', 'h', 'tipo', 'mw', 'raz', 'mot', 'origem_ons', 'destino', 'conf', 'corr'], eventos: [['2026-11-07', '06:41', 'limite', 210, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', null, null]] };
    B._usaConteiner(falso({ 'way2_recent.json': gz({ dados: [] }) }));
    B._usaGestao(falso({ 'restricao_iqony.json': Buffer.from(JSON.stringify(iq)) }));
    erro = null;
    try { await B.baixa(path.join(tmp, 't'), 'tarde', agora); } catch (e) { erro = e; }
    let iql = null;
    try { iql = JSON.parse(fs.readFileSync(path.join(tmp, 't', 'gestao__restricao_iqony.json'), 'utf8')); } catch (e) { }
    ok(!erro && iql && iql.eventos.length === 1 && fs.existsSync(path.join(tmp, 't', 'way2_recent.json')),
      'a tarde baixa a medição de 5 min e as ordens da Iqony' + (erro ? ' (' + erro.message + ')' : ''));
    for (const [rot, gb] of [['ausentes', {}], ['fora da forma', { 'restricao_iqony.json': Buffer.from(JSON.stringify({ versao: 2, eventos: [] })) }]]) {
      const dados = falso({ 'way2_recent.json': gz({ dados: [] }) });
      B._usaConteiner(dados);
      B._usaGestao(falso(gb));
      erro = null;
      try { await B.baixa(path.join(tmp, 't' + rot.replace(/ /g, '')), 'tarde', agora); } catch (e) { erro = e; }
      ok(erro && /Iqony/.test(erro.message), 'as ordens da Iqony ' + rot + ' param a baixa da tarde (o limite não se inventa)');
      ok(!dados.pedidos.includes('way2_recent.json'), 'as ordens da Iqony ' + rot + ': a medição de 5 min (7,25 MB) nem é pedida (pedidos: ' + dados.pedidos.join(' ') + ')');
    }
    // 7. o diário (boletim-ons-pendente): o pesado baixa as ordens da Iqony como OPCIONAIS; ausentes ou fora da forma, o pesado segue sem elas
    const pes = {}; for (const n of B.PESADO.exige) pes[n] = gz({ ok: 1 });
    B._usaConteiner(falso(pes));
    B._usaGestao(falso({ 'restricao_iqony.json': Buffer.from(JSON.stringify(iq)) }));
    erro = null;
    try { await B.baixa(path.join(tmp, 'p'), 'pesado', agora); } catch (e) { erro = e; }
    ok(!erro && fs.existsSync(path.join(tmp, 'p', 'gestao__restricao_iqony.json')) && fs.existsSync(path.join(tmp, 'p', 'executivo.json')),
      'o pesado baixa as ordens da Iqony junto (o dia que o ONS não publicou sai pelas ordens)' + (erro ? ' (' + erro.message + ')' : ''));
    for (const [rot, gb] of [['ausentes', {}], ['fora da forma', { 'restricao_iqony.json': Buffer.from(JSON.stringify({ versao: 2, eventos: [] })) }]]) {
      B._usaConteiner(falso(pes));
      B._usaGestao(falso(gb));
      erro = null;
      const dir = path.join(tmp, 'p' + rot.replace(/ /g, ''));
      try { await B.baixa(dir, 'pesado', agora); } catch (e) { erro = e; }
      ok(!erro && fs.existsSync(path.join(dir, 'executivo.json')) && !fs.existsSync(path.join(dir, 'gestao__restricao_iqony.json')),
        'as ordens da Iqony ' + rot + ' não param o pesado e não viram arquivo' + (erro ? ' (' + erro.message + ')' : ''));
      ok(!fs.existsSync(path.join(dir, 'gestao__restricao_iqony.erro')), 'as ordens da Iqony ' + rot + ' são "sem o registro", não erro de leitura');
    }
    // RW-002: 403, rede e contêiner inexistente NÃO são ausência: o pesado segue, mas deixa a marca de erro (a rodada sai vermelha no fim)
    const e403 = new Error('forbidden'); e403.statusCode = 403; e403.code = 'AuthorizationPermissionMismatch';
    const erede = new Error('socket hang up'); erede.code = 'ECONNRESET';
    const econt = new Error('container'); econt.statusCode = 404; econt.code = 'ContainerNotFound';
    for (const [rot, ex] of [['403', e403], ['rede', erede], ['contêiner inexistente', econt]]) {
      B._usaConteiner(falso(pes));
      B._usaGestao(falso({ 'restricao_iqony.json': ex }));
      erro = null;
      const dir = path.join(tmp, 'pe' + rot.replace(/ /g, ''));
      try { await B.baixa(dir, 'pesado', agora); } catch (e) { erro = e; }
      ok(!erro && fs.existsSync(path.join(dir, 'executivo.json')) && fs.existsSync(path.join(dir, 'gestao__restricao_iqony.erro')),
        'as ordens da Iqony com ' + rot + ': o pesado segue e deixa a marca de erro (não vale como ausente)' + (erro ? ' (' + erro.message + ')' : ''));
    }
    // RE-015 (7b): o pesado tomou 403 e a tarde, na mesma execução, leu as ordens: a marca de erro some (nada de vermelho falso)
    {
      const dir = path.join(tmp, 'p7b');
      B._usaConteiner(falso(pes)); B._usaGestao(falso({ 'restricao_iqony.json': e403 }));
      try { await B.baixa(dir, 'pesado', agora); } catch (e) { }
      const marcou = fs.existsSync(path.join(dir, 'gestao__restricao_iqony.erro'));
      B._usaConteiner(falso({ 'way2_recent.json': gz({ dados: [] }) })); B._usaGestao(falso({ 'restricao_iqony.json': Buffer.from(JSON.stringify(iq)) }));
      erro = null;
      try { await B.baixa(dir, 'tarde', agora); } catch (e) { erro = e; }
      ok(marcou && !erro && !fs.existsSync(path.join(dir, 'gestao__restricao_iqony.erro')) && fs.existsSync(path.join(dir, 'gestao__restricao_iqony.json')),
        'o 403 do pesado deixa a marca e a leitura que dá certo depois (a tarde) a apaga' + (erro ? ' (' + erro.message + ')' : ''));
    }
    // RE-015 (7c): gzip quebrado das ordens = fora da forma (aviso, sem marca e sem arquivo), como o JSON quebrado
    {
      const dir = path.join(tmp, 'p7c');
      B._usaConteiner(falso(pes)); B._usaGestao(falso({ 'restricao_iqony.json': Buffer.from([0x1f, 0x8b, 1, 2, 3]) }));
      erro = null;
      try { await B.baixa(dir, 'pesado', agora); } catch (e) { erro = e; }
      ok(!erro && !fs.existsSync(path.join(dir, 'gestao__restricao_iqony.erro')) && !fs.existsSync(path.join(dir, 'gestao__restricao_iqony.json')),
        'as ordens da Iqony com gzip quebrado: fora da forma, aviso sem marca de erro' + (erro ? ' (' + erro.message + ')' : ''));
    }
    B._usaGestao(null);
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
  ['a tarde sem as ordens da Iqony', "  if (grupo === 'tarde') await baixaIqony(pasta);", ''],
  ['a medição desce antes das ordens', "  if (grupo === 'tarde') await baixaIqony(pasta);\n  for (const nome of [...exige, ...opcional]) {\n    const dest = path.join(pasta, nome.replace(/\\//g, '__'));\n    let buf;\n    try { buf = await c.getBlobClient(nome).downloadToBuffer(); }\n    catch (e) {\n      if (ausente(e) && opcional.includes(nome)) { console.log('sem', nome, '(opcional)'); continue; }\n      throw new Error('entrada do boletim ausente ou ilegível: ' + nome + ' (' + (e.code || (e.details && e.details.errorCode) || e.statusCode || e.message) + ')');\n    }\n    let puro;\n    try {\n      puro = descomprime(buf);\n      if (nome.endsWith('.json')) {\n        const o = JSON.parse(puro.toString('utf8').replace(/^\\uFEFF/, ''));   // JSON quebrado para aqui, não na rodada\n        if (DERIVADOS.includes(nome) && (!o || o.esquema !== 1)) throw new Error('esquema ' + (o && o.esquema));\n      }\n    } catch (e) {\n      if (DERIVADOS.includes(nome)) { console.log('::warning::' + nome + ' ilegível (' + e.message.slice(0, 120) + '): a rodada refaz do zero'); continue; }\n      throw new Error('entrada do boletim ilegível: ' + nome + ' (' + e.message.slice(0, 120) + ')');\n    }\n    fs.writeFileSync(dest, puro);\n    console.log('baixado', nome, puro.length, 'bytes' + (puro !== buf ? ' (gzip)' : ''));\n  }",
   "  for (const nome of [...exige, ...opcional]) {\n    const dest = path.join(pasta, nome.replace(/\\//g, '__'));\n    let buf;\n    try { buf = await c.getBlobClient(nome).downloadToBuffer(); }\n    catch (e) {\n      if (ausente(e) && opcional.includes(nome)) { console.log('sem', nome, '(opcional)'); continue; }\n      throw new Error('entrada do boletim ausente ou ilegível: ' + nome + ' (' + (e.code || (e.details && e.details.errorCode) || e.statusCode || e.message) + ')');\n    }\n    let puro;\n    try {\n      puro = descomprime(buf);\n      if (nome.endsWith('.json')) {\n        const o = JSON.parse(puro.toString('utf8').replace(/^\\uFEFF/, ''));   // JSON quebrado para aqui, não na rodada\n        if (DERIVADOS.includes(nome) && (!o || o.esquema !== 1)) throw new Error('esquema ' + (o && o.esquema));\n      }\n    } catch (e) {\n      if (DERIVADOS.includes(nome)) { console.log('::warning::' + nome + ' ilegível (' + e.message.slice(0, 120) + '): a rodada refaz do zero'); continue; }\n      throw new Error('entrada do boletim ilegível: ' + nome + ' (' + e.message.slice(0, 120) + ')');\n    }\n    fs.writeFileSync(dest, puro);\n    console.log('baixado', nome, puro.length, 'bytes' + (puro !== buf ? ' (gzip)' : ''));\n  }\n  if (grupo === 'tarde') await baixaIqony(pasta);"],
  ['as ordens fora da forma passam', "if (!o || o.versao !== 1 || !Array.isArray(o.eventos) || !Array.isArray(o.campos)) throw", "if (false) throw"],
  // boletim-ons-pendente
  ['o pesado não baixa as ordens da Iqony', "    try { await baixaIqony(pasta); }", "    try { }"],
  ['as ordens ausentes param o pesado', "      if (e.ausente || e.forma) console.log('::warning::'", "      if (e.ausente || e.forma) throw e; else if (false) console.log('::warning::'"],
  ['qualquer falha das ordens vale como ausente', "      if (e.ausente || e.forma) console.log('::warning::'", "      if (true) console.log('::warning::'"],
  ['a leitura que dá certo não apaga a marca', "  fs.rmSync(path.join(pasta, GESTAO.erro), { force: true });", ""],
  ['o gzip quebrado das ordens vira erro de leitura', "  try { puro = descomprime(buf); } catch (e) { throw Object.assign(", "  puro = descomprime(buf); if (0) { throw Object.assign("],
  ['o 404 de contêiner vale como ausente', "{ ausente: ausente(e) }", "{ ausente: e.statusCode === 404 }"],
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
