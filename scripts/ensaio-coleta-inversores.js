// Ensaio da ponte dos inversores (coleta-inversores.js), substituto do fluxo "Inversores PWC -> Blob -> Grafana".
// So dados plantados: pastas temporarias (apagadas no fim) e um contêiner FORJADO (listagem com etag sem aspas, If-Match
// com o etag entre aspas ou '*', If-None-Match *). Verde em qualquer dia, sem rede e sem segredo.
//
// Duas rotas, as duas contra o FONTE de verdade e contra cada defeito plantado nele:
//   A · a funcao `roda` (a mesma que o principal chama), em processo: o que entra, o que se compara, o que sobe;
//   B · o SCRIPT inteiro como processo filho, com o cliente do Azure trocado pelo contêiner forjado (este mesmo arquivo
//       carregado com `-r` e ENS_COLETA_PRELOAD=1): o padrao SECO sem --enviar e o codigo de saida (0 limpo, 1 com falha,
//       1 no catch).
// Depois, cada defeito plantado no fonte (troca textual conferida: ocorre uma vez e muda o fonte) tem de derrubar algum
// caso; plantio que nem compila e defeito DESTE ensaio, nao defeito pego.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

/* ---------- o contêiner forjado (usado em processo e no filho) ---------- */
function conteiner(inicial, aoMudar) {
  const blobs = new Map(); let n = 0;
  const etag = () => '0x8DE' + String(++n).padStart(6, '0');
  const muda = () => { if (aoMudar) aoMudar(C); };
  const C = { blobs, baixados: 0, envios: [], corrompe: false,
    get n() { return n; }, set n(v) { n = v; },
    poe(nome, bytes, meta, tipo) { blobs.set(nome, { bytes: Buffer.from(bytes), etag: etag(), meta: meta || {}, tipo: tipo || 'application/octet-stream' }); },
    async *listBlobsFlat(o) { for (const [name, b] of [...blobs]) yield { name, properties: { etag: b.etag, contentLength: b.bytes.length },
      metadata: o && o.includeMetadata ? { ...b.meta } : undefined }; },
    getBlobClient(nome) { return { downloadToBuffer: async () => { const b = blobs.get(nome);
      if (!b) throw Object.assign(new Error('BlobNotFound'), { statusCode: 404 });
      C.baixados += 1; muda(); return Buffer.from(b.bytes); } }; },
    getBlockBlobClient(nome) { return {
      uploadData: async (buf, o) => { const b = blobs.get(nome); const k = (o && o.conditions) || {};
        if (k.ifNoneMatch === '*' && b) throw Object.assign(new Error('BlobAlreadyExists'), { statusCode: 409 });
        /* como o Azure: If-Match '*' casa com qualquer blob que exista; senao, o etag entre aspas */
        if (k.ifMatch !== undefined && (!b || (k.ifMatch !== '*' && k.ifMatch !== '"' + b.etag + '"'))) throw Object.assign(new Error('ConditionNotMet'), { statusCode: 412 });
        C.envios.push(nome);
        const gravado = C.corrompe ? Buffer.concat([Buffer.from(buf), Buffer.from([0])]) : Buffer.from(buf);
        blobs.set(nome, { bytes: gravado, etag: etag(), meta: { ...((o && o.metadata) || {}) }, tipo: ((o && o.blobHTTPHeaders) || {}).blobContentType });
        muda(); },
      getProperties: async () => { const b = blobs.get(nome); return { contentLength: b.bytes.length, metadata: { ...b.meta }, etag: '"' + b.etag + '"' }; } }; } };
  for (const [nome, bytes] of Object.entries(inicial || {})) C.poe(nome, bytes);
  return C;
}
const serializa = (C) => JSON.stringify({ n: C.n, baixados: C.baixados, envios: C.envios,
  blobs: [...C.blobs].map(([nome, b]) => [nome, { b64: b.bytes.toString('base64'), etag: b.etag, meta: b.meta, tipo: b.tipo }]) });
function desserializa(txt, aoMudar) {
  const s = JSON.parse(txt); const C = conteiner({}, aoMudar);
  for (const [nome, b] of s.blobs) C.blobs.set(nome, { bytes: Buffer.from(b.b64, 'base64'), etag: b.etag, meta: b.meta, tipo: b.tipo });
  C.n = s.n; C.baixados = s.baixados; C.envios = s.envios; return C;
}

/* ---------- modo PRELOAD: dentro do processo filho, troca o cliente do Azure pelo forjado ---------- */
if (process.env.ENS_COLETA_PRELOAD === '1') {
  const EST = process.env.ENS_ESTADO;
  const C = desserializa(fs.readFileSync(EST, 'utf8'), (c) => fs.writeFileSync(EST, serializa(c)));
  const carrega = Module._load;
  Module._load = function (req, ...resto) {
    if (req === '@azure/storage-blob') return { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => C }) } };
    return carrega.call(this, req, ...resto);
  };
  return;   // eslint-disable-line no-unreachable -- o modulo para aqui: no filho, este arquivo e so o preload
}

/* ---------- o ensaio ---------- */
const XLSX = require('xlsx');
const { spawnSync } = require('child_process');
const ARQ = path.join(__dirname, 'coleta-inversores.js');
const FONTE = fs.readFileSync(ARQ, 'utf8').replace(/\r\n/g, '\n');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const TEMPS = [];
const temp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-coleta-inv-')); TEMPS.push(d); return d; };

/* uma planilha de verdade (ZIP), diferente por `marca` */
const planilha = (marca) => { const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Inverter', 'Replacement Date'], [marca, '2026-10-20']]), 'Inverter Failure Control');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }); };

/* `arquivos`: nome -> bytes, ou null para criar um DIRETORIO com esse nome */
function pasta(arquivos) {
  const d = temp();
  for (const [rel, bytes] of Object.entries(arquivos)) { const p = path.join(d, rel); fs.mkdirSync(path.dirname(p), { recursive: true });
    if (bytes === null) fs.mkdirSync(p); else fs.writeFileSync(p, bytes); }
  return d;
}

/* roda o SCRIPT (o de verdade ou o plantado) como processo filho, com o contêiner forjado */
function filho(arquivo, args, C, envExtra) {
  const d = temp(); const est = path.join(d, 'estado.json'); fs.writeFileSync(est, serializa(C));
  const env = { ...process.env, ENS_COLETA_PRELOAD: '1', ENS_ESTADO: est, DADOS_STORAGE: 'forjado-sem-chave',
    INV_CACHE: path.join(d, 'cache.json'), INV_LOG: path.join(d, 'coleta.log'), ...(envExtra || {}) };
  delete env.INV_PASTA;
  const r = spawnSync(process.execPath, ['-r', __filename, arquivo].concat(args), { env, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || ''), C: desserializa(fs.readFileSync(est, 'utf8')) };
}

/* os casos, contra um modulo M e o arquivo dele. Devolve o numero de falhas. */
async function casos(M, arquivo, fala) {
  let falhas = 0;
  const diz = (nome, obtido, esperado) => { const bom = JSON.stringify(obtido) === JSON.stringify(esperado);
    if (!bom) falhas += 1;
    if (fala || !bom) console.log('  ' + (bom ? '✅' : '🔴') + ' ' + nome + ' · ' + JSON.stringify(obtido) + (bom ? '' : ' (esperado ' + JSON.stringify(esperado) + ')')); };
  const cala = () => {};
  const tenta = async (f) => { try { return await f(); } catch (e) { return { erro: String(e.message || e).slice(0, 80) }; } };
  const A = planilha('A'), B = planilha('B'), B2 = planilha('B alterada'), N = planilha('nova');
  const VIVA = 'Inverter failure and Commissioning Control automated.xlsm', P2 = 'Registro_Falhas_Inversores.xlsx';
  const XLSX_T = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', XLSM_T = 'application/vnd.ms-excel.sheet.macroEnabled.12';

  if (fala) console.log('A1 · PASTA IGUAL AO CONTÊINER: ZERO A SUBIR');
  { const C = conteiner({ [VIVA]: A, [P2]: B, 'Inverter failure and Commissioning Control (updated 2026.08.24).xlsx': A });
    const d = pasta({ [VIVA]: A, [P2]: B }); const cache = {};
    const r = await tenta(() => M.roda({ pasta: d, cont: C, enviar: false, cache, diz: cala }));
    diz('nada a subir', r.subir, []);
    diz('as duas comparadas como iguais', r.acoes, [[VIVA, 'igual'], [P2, 'igual']]);
    diz('blob sem sha256 (o do fluxo) e baixado e medido', r.baixados, 2);
    diz('o que so esta no contêiner e listado, nao mexido', [r.soNoConteiner, C.blobs.size], [['Inverter failure and Commissioning Control (updated 2026.08.24).xlsx'], 3]);
    const r2 = await tenta(() => M.roda({ pasta: d, cont: C, enviar: false, cache, diz: cala }));
    diz('rodada seguinte com o mesmo etag nao baixa de novo (cache)', [r2.subir, r2.baixados], [[], 0]);
    C.poe(P2, N);   /* outro escritor regrava o blob com outro conteudo: etag novo */
    const r3 = await tenta(() => M.roda({ pasta: d, cont: C, enviar: false, cache, diz: cala }));
    diz('blob regravado por outro: medido de novo e acusado', [r3.subir, r3.baixados], [[P2], 1]);
  }

  if (fala) console.log('\nA2 · UMA ALTERADA OU UMA NOVA: EXATAMENTE ELA');
  { const C = conteiner({ [VIVA]: A, [P2]: B });
    const r = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: A, [P2]: B2 }), cont: C, enviar: false, cache: {}, diz: cala }));
    diz('alterada: so ela, como alterada', [r.subir, r.acoes], [[P2], [[VIVA, 'igual'], [P2, 'alterado']]]);
    const r2 = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: A, [P2]: B, 'Nova planilha.xlsx': N }), cont: C, enviar: false, cache: {}, diz: cala }));
    diz('nova: so ela, como nova', [r2.subir, (r2.acoes || []).filter((x) => x[1] !== 'igual')], [['Nova planilha.xlsx'], [['Nova planilha.xlsx', 'novo']]]);
  }

  if (fala) console.log('\nA3 · O QUE NAO ENTRA');
  { const C = conteiner({ [VIVA]: A });
    const OLE = Buffer.concat([Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]), Buffer.alloc(504)]);
    const r = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: A, ['~$' + VIVA]: N, 'desktop.ini': N, 'Novos.jpeg': N, 'Old/Velha.xlsx': N, 'Pasta.xlsx': null }),
      cont: C, enviar: false, cache: {}, diz: cala }));
    diz('bloqueio do Excel, desktop.ini, nao-planilha, subpasta e DIRETORIO com nome .xlsx ficam de fora', [r.subir, r.acoes, r.falhas], [[], [[VIVA, 'igual']], 0]);
    const r1 = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: A, 'Antiga.xls': OLE }), cont: C, enviar: true, cache: {}, diz: cala }));
    diz('.xls antigo (OLE): fora, com aviso, sem pintar a rodada nem subir', [r1.acoes, r1.foraComAviso, r1.falhas, C.envios.length], [[[VIVA, 'igual']], ['Antiga.xls'], 0, 0]);
    const r2 = await tenta(() => M.roda({ pasta: pasta({ 'desktop.ini': N, 'Antiga.xls': OLE, 'Old/Velha.xlsx': N }), cont: C, enviar: false, cache: {}, diz: cala }));
    diz('raiz sem .xlsx/.xlsm: a rodada FALHA dizendo por que', /nenhuma planilha/.test((r2 && r2.erro) || ''), true);
  }

  if (fala) console.log('\nA4 · SECO NUNCA ENVIA; ENVIO GRAVA O NOME CRU, O CONTEUDO, O TIPO E O SHA256');
  { const C = conteiner({ [VIVA]: A, [P2]: B }); const cache = {};
    const d = pasta({ [VIVA]: A, [P2]: B2, 'Nova planilha.xlsm': N });
    const r0 = await tenta(() => M.roda({ pasta: d, cont: C, enviar: false, cache, diz: cala }));
    diz('SECO: lista as duas e nao chama o envio', [r0.subir, r0.enviados, C.envios.length, sha(C.blobs.get(P2).bytes) === sha(B)], [['Nova planilha.xlsm', P2], 0, 0, true]);
    const r = await tenta(() => M.roda({ pasta: d, cont: C, enviar: true, cache, diz: cala }));
    diz('ENVIO: as duas, com o nome exato', [r.enviados, r.falhas, [...C.envios].sort()], [2, 0, ['Nova planilha.xlsm', P2]]);
    diz('nenhum blob com carimbo ou pasta no nome', [...C.blobs.keys()].sort(), ['Nova planilha.xlsm', P2, VIVA].sort());
    const b = C.blobs.get(P2) || {}, m = C.blobs.get('Nova planilha.xlsm') || {};
    diz('conteudo, sha256 e tipo do .xlsx gravado', [sha(b.bytes || Buffer.alloc(0)) === sha(B2), (b.meta || {}).sha256 === sha(B2), b.tipo], [true, true, XLSX_T]);
    diz('tipo do .xlsm gravado (planilha com macro)', m.tipo, XLSM_T);
    const antes = C.baixados;
    const r2 = await tenta(() => M.roda({ pasta: d, cont: C, enviar: true, cache: {}, diz: cala }));
    diz('rodada seguinte: zero a subir; so o blob do fluxo (sem sha256) e baixado', [r2.subir, r2.enviados, C.baixados - antes], [[], 0, 1]);
    const Cx = conteiner({ [P2]: B }); Cx.corrompe = true;
    const r3 = await tenta(() => M.roda({ pasta: pasta({ [P2]: B2 }), cont: Cx, enviar: true, cache: {}, diz: cala }));
    diz('blob gravado diferente do arquivo: a conferencia pos-envio acusa', [r3.enviados, r3.falhas], [0, 1]);
  }

  if (fala) console.log('\nA5 · PLANILHA PELA METADE NAO SOBE');
  { const C = conteiner({ [VIVA]: A });
    const r = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: A.subarray(0, A.length - 40) }), cont: C, enviar: true, cache: {}, diz: cala }));
    diz('fim cortado: nao enviada, rodada vermelha, blob intacto', [r.acoes, r.enviados, r.falhas > 0, C.envios.length, sha(C.blobs.get(VIVA).bytes) === sha(A)],
      [[[VIVA, 'incompleto']], 0, true, 0, true]);
    const meio = Buffer.concat([A.subarray(0, 200), A.subarray(260)]);
    diz('corte no MEIO que preserva o fim do diretorio: incompleto', (await tenta(() => M.roda({ pasta: pasta({ [VIVA]: meio }), cont: C, enviar: false, cache: {}, diz: cala }))).acoes, [[VIVA, 'incompleto']]);
    const cauda = Buffer.concat([A, Buffer.from('lixo depois do fim')]);
    diz('bytes depois do fim do diretorio: incompleto', (await tenta(() => M.roda({ pasta: pasta({ [VIVA]: cauda }), cont: C, enviar: false, cache: {}, diz: cala }))).acoes, [[VIVA, 'incompleto']]);
    diz('o ZIP inteiro passa no teste de integridade', M.zipInteiro(A), true);
  }

  if (fala) console.log('\nA6 · O FLUXO GRAVOU NO MEIO: O ENVIO E RECUSADO');
  { const C = conteiner({ [VIVA]: A });
    const lista = C.listBlobsFlat.bind(C);
    C.listBlobsFlat = async function* (o) { for await (const x of lista(o)) yield x; C.poe(VIVA, N); };
    const r = await tenta(() => M.roda({ pasta: pasta({ [VIVA]: B2 }), cont: C, enviar: true, cache: {}, diz: cala }));
    diz('recusado, rodada vermelha, o blob do fluxo fica', [r.enviados, r.falhas, sha(C.blobs.get(VIVA).bytes) === sha(N)], [0, 1, true]);
    const C2 = conteiner({}); const lista2 = C2.listBlobsFlat.bind(C2);
    C2.listBlobsFlat = async function* (o) { for await (const x of lista2(o)) yield x; C2.poe('Nova planilha.xlsx', N); };
    const r2 = await tenta(() => M.roda({ pasta: pasta({ 'Nova planilha.xlsx': B2 }), cont: C2, enviar: true, cache: {}, diz: cala }));
    diz('criado por outro no meio: recusado, o dele fica', [r2.enviados, r2.falhas, sha(C2.blobs.get('Nova planilha.xlsx').bytes) === sha(N)], [0, 1, true]);
  }

  if (fala) console.log('\nA7 · NOME COM ACENTO: A COMPARACAO E EM NFC, A GRAVACAO VAI AO BLOB QUE EXISTE');
  { const NFC = 'Substituições de inversores.xlsx', NFD = NFC.normalize('NFD');
    const C = conteiner({ [NFC]: A });
    const r = await tenta(() => M.roda({ pasta: pasta({ [NFD]: A }), cont: C, enviar: false, cache: {}, diz: cala }));
    diz('arquivo em NFD, blob em NFC, mesmo conteudo: igual', [r.subir, r.acoes], [[], [[NFC, 'igual']]]);
    const C2 = conteiner({ [NFD]: A });
    const r2 = await tenta(() => M.roda({ pasta: pasta({ [NFC]: B2 }), cont: C2, enviar: true, cache: {}, diz: cala }));
    diz('blob em NFD, arquivo alterado em NFC: regrava o blob que existe, sem criar outro', [r2.enviados, r2.falhas, [...C2.blobs.keys()], sha(C2.blobs.get(NFD).bytes) === sha(B2)],
      [1, 0, [NFD], true]);
  }

  if (fala) console.log('\nB · O SCRIPT INTEIRO COMO PROCESSO FILHO (padrao SECO e codigo de saida)');
  { const base = () => conteiner({ [VIVA]: A, [P2]: B });
    const d = pasta({ [VIVA]: A, [P2]: B2 });
    const f1 = filho(arquivo, ['--pasta=' + d], base());
    diz('sem --enviar: SECO, lista a alterada, nao envia, sai 0', [f1.code, /SECO/.test(f1.out), /1 a subir/.test(f1.out), f1.C.envios.length, sha(f1.C.blobs.get(P2).bytes) === sha(B)],
      [0, true, true, 0, true]);
    const f2 = filho(arquivo, ['--pasta=' + d, '--enviar'], base());
    diz('com --enviar: envia so a alterada e sai 0', [f2.code, f2.C.envios, sha(f2.C.blobs.get(P2).bytes) === sha(B2)], [0, [P2], true]);
    const f3 = filho(arquivo, ['--pasta=' + pasta({ [VIVA]: A.subarray(0, A.length - 40), [P2]: B2 }), '--enviar'], base());
    diz('rodada com falha (ZIP pela metade): sai 1, e o resto ainda sobe', [f3.code, f3.C.envios], [1, [P2]]);
    const f4 = filho(arquivo, ['--pasta=' + path.join(d, 'nao-existe')], base());
    diz('pasta que nao existe (catch): sai 1 dizendo FALHOU', [f4.code, /FALHOU/.test(f4.out)], [1, true]);
    const f5 = filho(arquivo, [], base());
    diz('sem --pasta nem INV_PASTA (catch): sai 1', [f5.code, /sem --pasta/.test(f5.out)], [1, true]);
    const f6 = filho(arquivo, ['--pasta=' + pasta({ 'desktop.ini': N })], base());
    diz('raiz sem planilha (catch): sai 1 com "nenhuma planilha"', [f6.code, /nenhuma planilha/.test(f6.out)], [1, true]);
  }
  return falhas;
}

/* compila um fonte como modulo, no lugar do original (as dependencias resolvem igual) */
function compila(src, arquivo) { const m = new Module(arquivo, module); m.filename = arquivo; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, arquivo); return m.exports; }

/* cada defeito: [nome, de, para]. `de` tem de ocorrer UMA vez e a troca tem de mudar o fonte. */
const PLANTIOS = [
  ['compara so o nome, nao o conteudo', "acao: a.sha === shaR ? 'igual' : 'alterado'", "acao: 'igual'"],
  ['prefixa carimbo no nome (como o coleta-ppc)', 'const bb = cont.getBlockBlobClient(it.destino);', "const bb = cont.getBlockBlobClient('20261020120000_' + it.destino);"],
  ['deixa entrar o bloqueio do Excel', String.raw`const entra = (nome) => /\.xls[xm]$/i.test(nome) && !/^~\$/.test(nome);`, String.raw`const entra = (nome) => /\.xls[xm]$/i.test(nome);`],
  ['aceita qualquer nome com ".xls" (o .xls antigo pinta a rodada)', String.raw`const entra = (nome) => /\.xls[xm]$/i`, String.raw`const entra = (nome) => /\.xls/i`],
  ['le as subpastas tambem', 'fs.readdirSync(pasta).filter(', 'fs.readdirSync(pasta, { recursive: true }).filter('],
  ['nao confere se e arquivo (diretorio com nome .xlsx)', '.filter((n) => fs.statSync(path.join(pasta, n)).isFile())', ''],
  ['nao normaliza o nome local em NFC', "nome: n.normalize('NFC')", 'nome: n'],
  ['grava no nome local, nao no blob que existe', 'destino: r.blob });', 'destino: a.nome });'],
  ['SECO envia', 'if (!enviar) continue;', ''],
  ['envio sem condicao (sobrescreve o que o fluxo gravou no meio)', "conditions: it.etag ? { ifMatch: '\"' + it.etag + '\"' } : { ifNoneMatch: '*' },", ''],
  ['aceita ZIP pela metade', 'if (!a.inteiro) {', 'if (false) {'],
  ['ZIP: nao confere o tamanho ate o fim do arquivo', 'return i + 22 + buf.readUInt16LE(i + 20) === buf.length\n      && iniCD', 'return iniCD'],
  ['ZIP: nao confere o diretorio central', '\n      && iniCD + tamCD === i\n      && iniCD + 4 <= buf.length && buf.readUInt32LE(iniCD) === 0x02014b50;', ';'],
  ['.xlsm sem o tipo de planilha com macro', "if (/\\.xlsm$/i.test(nome)) return 'application/vnd.ms-excel.sheet.macroEnabled.12';\n", ''],
  ['nao grava o sha256 no blob', 'metadata: { sha256: it.sha },', ''],
  ['nao confere o blob depois do envio', 'if (p.contentLength !== it.bytes.length || (p.metadata || {}).sha256 !== it.sha) {', 'if (false) {'],
  ['raiz sem planilha passa em silencio', 'if (!L.length) throw new Error(', 'if (false) throw new Error('],
  ['cache de hash so pelo nome (sem o etag)', "const chave = (nome, etag) => nome + '|' + etag;", 'const chave = (nome, etag) => nome;'],
  ['o padrao e enviar (sem --enviar ja envia)', "const enviar = process.argv.includes('--enviar');", "const enviar = !process.argv.includes('--seco');"],
  ['rodada com falha sai 0', 'process.exit(r.falhas ? 1 : 0);', 'process.exit(0);'],
  ['o catch sai 0', "})().catch((e) => { diz('FALHOU: ' + e.message); registra(); process.exit(1); });", "})().catch((e) => { diz('FALHOU: ' + e.message); registra(); process.exit(0); });"],
];

(async () => {
  let falhas = 0;
  try {
    console.log('O FONTE DE VERDADE');
    falhas += await casos(compila(FONTE, ARQ), ARQ, true);
    console.log('\nDEFEITOS PLANTADOS (cada um tem de derrubar algum caso)');
    for (const [nome, de, para] of PLANTIOS) {
      const n = FONTE.split(de).length - 1;
      if (n !== 1) { falhas += 1; console.log('  🔴 plantio "' + nome + '": o trecho ocorre ' + n + ' vez(es) no fonte (esperado 1)'); continue; }
      const src = FONTE.replace(de, para);
      if (src === FONTE) { falhas += 1; console.log('  🔴 plantio "' + nome + '": a troca nao mudou o fonte'); continue; }
      /* o plantado vai para um arquivo proprio (o filho o executa) e compila em processo */
      const arq = path.join(temp(), 'coleta-inversores.js'); fs.writeFileSync(arq, src);
      let M;
      try { M = compila(src, ARQ); } catch (e) { falhas += 1; console.log('  🔴 plantio "' + nome + '" NAO COMPILA (defeito do ensaio): ' + e.message.slice(0, 80)); continue; }
      const k = await casos(M, arq, false);
      if (k > 0) console.log('  ✅ reprovado: ' + nome + ' (' + k + ' caso(s))');
      else { falhas += 1; console.log('  🔴 PASSOU sem ser pego: ' + nome); }
    }
  } finally {
    for (const d of TEMPS) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* nada a fazer */ } }
  }
  const sobrou = TEMPS.filter((d) => fs.existsSync(d)).length;
  if (sobrou) { falhas += 1; console.log('🔴 ' + sobrou + ' diretorio(s) temporario(s) nao apagado(s)'); }
  console.log('\n' + (falhas ? '🔴 ' + falhas + ' falha(s)' : '✅ ensaio limpo') + ' · ' + TEMPS.length + ' diretorio(s) temporario(s) apagado(s)');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
