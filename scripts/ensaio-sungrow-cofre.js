/*
 * ensaio-sungrow-cofre.js — prova a leitura dos zips do logger Sungrow pelo COFRE (lib-sungrow-cofre.js e o gen-sungrow com
 * FONTE=cofre|uniao e SOMBRA=1), sem rede. Lote pa-sungrow (20/10/2026). Roda no sungrow.yml antes de gerar.
 *
 * 1 · o mapeamento (mapeia): o prefixo `Sungrow_Logger/Sungrow_dados/<ano>/` sai e o nome fica o do sungrow-raw; a versao
 *     `~AAAAMMDD-HHMMSS` mais nova vale, listada fora de ordem; o despejo de depuracao e o que nao e zip ficam ignorados e
 *     contados; pasta `M3`, zip fora da profundidade, sufixo ilegivel, zip sem a pasta do ano e o mesmo nome em dois anos sao
 *     recusados, um a um, com o motivo.
 * 2 · a comparacao (compara), lote a lote: lote igual, lote em que o sungrow-raw ficou com a versao anterior (nomeado), lote
 *     vivo (nao julgado), lote so no cofre (nomeado); e os defeitos plantados no DADO: lote faltando no cofre, um zip
 *     faltando no cofre, um zip a mais no cofre, tamanho diferente, MD5 diferente.
 * 3 · a uniao: no nome dos dois vale o cofre; o que so o sungrow-raw tem fica.
 * 4 · o gen-sungrow de ponta a ponta com o Azure forjado (preload em Module._load, que tambem conta cada download): o
 *     gerador lido do sungrow-raw e lido do cofre (com a versao ~ mais nova) da produtos IDENTICOS chave a chave; a uniao
 *     (sungrow-raw com a versao velha) tambem; no modo cofre so a versao escolhida e baixada, e nada do sungrow-raw; o zip
 *     recusado deixa a rodada vermelha; a SOMBRA fica verde com os dois iguais e vermelha com o dia faltando no cofre e com
 *     bytes diferentes no mesmo tamanho.
 * 5 · plantios na lib (versao mais antiga, versao pela ordem da listagem, ano deixado no nome, ano fixo errado, colisao de ano
 *     calada, zip fora da forma lido, sufixo ilegivel calado, dia faltando calado, tamanho nao comparado, comparacao de um
 *     sentido so, tudo vivo, uniao com o sungrow-raw ganhando) e no gerador (versao mais antiga de ponta a ponta, modo cofre
 *     lendo o sungrow-raw, recusado sem pintar a rodada): todos tem de reprovar.
 *
 * uso: node scripts/ensaio-sungrow-cofre.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const LIB = path.join(__dirname, 'lib-sungrow-cofre.js');
const GEN = path.join(__dirname, 'gen-sungrow.js');
const P = 'Sungrow_Logger/Sungrow_dados/';
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const carrega = (f) => { delete require.cache[require.resolve(f)]; return require(f); };

/* ---------------------------------------------------------------- 1 · mapeia ---------------------------------------- */
const LM = '2026-10-19T09:20:00Z';
const b = (name, size, extra) => Object.assign({ name: P + name, size, md5: null, lastModified: LM }, extra || {});
const LISTA = [
  b('2026/M02/TS01/01 A 05/19.10 A 19.10.zip', 100),
  // tres versoes do mesmo zip, a mais nova no MEIO da listagem: vale a de maior carimbo, nunca a ultima listada
  b('2026/M02/TS01/06 A 10/19.10 A 19.10.zip', 110),
  b('2026/M02/TS01/06 A 10/19.10 A 19.10.zip~20261020-062000', 130),
  b('2026/M02/TS01/06 A 10/19.10 A 19.10.zip~20261019-062000', 120),
  b('2026/M10/TS05/PID 100/19.10 A 19.10.zip', 140),
  b('2026/EM ANALESE_log_log/B23B0200011_20260930111305/debug/log_common/common_bk_1.log.zip', 5),
  b('2026/EM ANALESE_log_log/B23B0200011_20260930111305/debug/err.log', 6),
  b('2026/M03/TS08/21 A 22/A23C0400548.xlsx', 7),
  b('2026/M3/TS01/01 A 05/19.10 A 19.10.zip', 8),
  b('2026/M02/TS01/19.10 A 19.10.zip', 9),
  b('2026/M02/TS01/01 A 05/18.10 A 18.10.zip~2026-10-19', 10),
  b('M02/TS01/01 A 05/17.10 A 17.10.zip', 11),
  b('2026/M04/TS01/01 A 05/05.10 A 05.10.zip', 12),
  b('2027/M04/TS01/01 A 05/05.10 A 05.10.zip', 13),
];
const ESPERA_ZIPS = { 'M02/TS01/01 A 05/19.10 A 19.10.zip': 100, 'M02/TS01/06 A 10/19.10 A 19.10.zip': 130, 'M10/TS05/PID 100/19.10 A 19.10.zip': 140 };
const ESPERA_REC = [
  ['2026/M3/TS01/01 A 05/19.10 A 19.10.zip', /pasta de usina fora da forma M<NN>: M3/],
  ['2026/M02/TS01/19.10 A 19.10.zip', /fora da forma M<NN>\/TS<NN>\/<grupo>\/<arquivo>\.zip/],
  ['2026/M02/TS01/01 A 05/18.10 A 18.10.zip~2026-10-19', /sufixo de versao ilegivel/],
  ['M02/TS01/01 A 05/17.10 A 17.10.zip', /zip fora da pasta do ano/],
  ['2026/M04/TS01/01 A 05/05.10 A 05.10.zip', /mesmo nome mapeado em 2026 e 2027/],
  ['2027/M04/TS01/01 A 05/05.10 A 05.10.zip', /mesmo nome mapeado em 2026 e 2027/],
];
function casosMapeia(L) {
  const R = {};
  const M = L.mapeia(LISTA.slice());
  const zips = Object.fromEntries([...M.zips].map(([n, z]) => [n, z.bytes]));
  R.okNomes = igual(Object.keys(zips).sort(), Object.keys(ESPERA_ZIPS).sort());
  R.okVersao = Object.keys(ESPERA_ZIPS).every((k) => zips[k] === ESPERA_ZIPS[k])
    && (M.zips.get('M02/TS01/06 A 10/19.10 A 19.10.zip') || {}).fonte === P + '2026/M02/TS01/06 A 10/19.10 A 19.10.zip~20261020-062000'
    && ((M.zips.get('M02/TS01/06 A 10/19.10 A 19.10.zip') || {}).anteriores || []).map((x) => x.bytes).sort().join() === '110,120';
  R.okIgnorados = igual(M.ignorados, { '2026/EM ANALESE_log_log': 2, '2026/M03 (nao zip)': 1 });
  const rec = M.recusados.map((x) => [x.nome.slice(P.length), x.motivo]);
  R.okRecusados = rec.length === ESPERA_REC.length && ESPERA_REC.every(([n, re]) => rec.some(([a, m]) => a === n && re.test(m)));
  R.txt = JSON.stringify({ zips, ign: M.ignorados, rec: rec.map((x) => x[0] + ' :: ' + x[1]) });
  // a ordem da listagem nao muda a escolha (a lista ao contrario)
  const M2 = L.mapeia(LISTA.slice().reverse());
  R.okOrdem = (M2.zips.get('M02/TS01/06 A 10/19.10 A 19.10.zip') || {}).bytes === 130;
  return R;
}

/* ---------------------------------------------------------------- 2 · compara --------------------------------------- */
const AGORA = Date.parse('2026-10-20T13:30:00Z');
const VELHO = '2026-10-19T09:20:00Z', NOVO = '2026-10-20T13:00:00Z';
// o cofre e o sungrow-raw de quatro lotes
function mundoCompara() {
  const cofre = [], raw = [];
  const zA = ['M02/TS01/01 A 05', 'M02/TS01/06 A 10', 'M10/TS05/PID 100'];
  zA.forEach((g, i) => { cofre.push(b('2026/' + g + '/18.10 A 18.10.zip', 200 + i, { lastModified: '2026-10-18T09:20:00Z', md5: 'm' + i })); raw.push({ name: g + '/18.10 A 18.10.zip', size: 200 + i, md5: 'm' + i, lastModified: '2026-10-18T09:27:00Z' }); });
  // lote B: o fluxo ficou com a primeira copia (gatilho so de criacao); o cofre tem a versao ~ mais nova
  cofre.push(b('2026/M02/TS01/01 A 05/19.10 A 19.10.zip', 300, { lastModified: VELHO }));
  cofre.push(b('2026/M02/TS01/01 A 05/19.10 A 19.10.zip~20261019-120000', 310, { lastModified: '2026-10-19T15:00:00Z' }));
  raw.push({ name: 'M02/TS01/01 A 05/19.10 A 19.10.zip', size: 300, md5: null, lastModified: '2026-10-19T09:27:00Z' });
  // lote V: vivo (o fluxo ainda nao copiou); lote C: so no cofre, antigo (o fluxo nao entregou)
  cofre.push(b('2026/M02/TS01/01 A 05/20.10 A 20.10.zip', 400, { lastModified: NOVO }));
  cofre.push(b('2026/M02/TS01/01 A 05/17.10 A 17.10.zip', 500, { lastModified: '2026-10-17T09:20:00Z' }));
  return { cofre, raw };
}
function casosCompara(L) {
  const R = {};
  const roda = (w) => L.compara(L.mapeia(w.cofre), w.raw, { agora: AGORA, vivoMin: 120 });
  const w0 = mundoCompara(); const r0 = roda(w0);
  R.okBase = r0.falhas.length === 0 && igual(r0.lotes, { julgados: 2, vivos: 1, so_cofre: 1, so_raw: 0 }) && r0.nomes_iguais === 3
    && r0.nomeadas.some((n) => /versao anterior/.test(n)) && r0.nomeadas.some((n) => /vivo/.test(n)) && r0.nomeadas.some((n) => /so no cofre/.test(n));
  R.txtBase = JSON.stringify({ lotes: r0.lotes, iguais: r0.nomes_iguais, falhas: r0.falhas, nomeadas: r0.nomeadas.length });
  // os defeitos plantados no DADO: cada um tem de dar exatamente a falha dele
  const D = {};
  { const w = mundoCompara(); w.cofre = w.cofre.filter((x) => !x.name.includes('18.10 A 18.10')); const r = roda(w);
    D.diaFaltando = r.falhas.length === 1 && /18\.10 A 18\.10\.zip": 3 zip\(s\) no sungrow-raw e nenhum no cofre/.test(r.falhas[0]); }
  { const w = mundoCompara(); w.cofre = w.cofre.filter((x) => !x.name.includes('06 A 10/18.10')); const r = roda(w);
    D.zipFaltando = r.falhas.length === 1 && /06 A 10\/18\.10 A 18\.10\.zip no sungrow-raw e nao no cofre/.test(r.falhas[0]); }
  { const w = mundoCompara(); w.cofre.push(b('2026/M02/TS02/01 A 05/18.10 A 18.10.zip', 999, { lastModified: '2026-10-18T09:20:00Z' })); const r = roda(w);
    D.zipAMais = r.falhas.length === 1 && /TS02\/01 A 05\/18\.10 A 18\.10\.zip no cofre e nao no sungrow-raw/.test(r.falhas[0]); }
  { const w = mundoCompara(); w.raw[0].size = 777; const r = roda(w);
    D.tamanho = r.falhas.length === 1 && /777 B no sungrow-raw e 200 B no cofre/.test(r.falhas[0]); }
  { const w = mundoCompara(); w.raw[1].md5 = 'outro'; const r = roda(w);
    D.md5 = r.falhas.length === 1 && /mesmo tamanho, MD5 diferente/.test(r.falhas[0]); }
  R.okDefeitos = Object.values(D).every(Boolean); R.txtDefeitos = JSON.stringify(D);
  return R;
}
function casosUniao(L) {
  const U = L.uniao([{ nome: 'a', bytes: 1 }, { nome: 'b', bytes: 2 }], [{ nome: 'b', bytes: 3 }, { nome: 'c', bytes: 4 }]);
  const m = Object.fromEntries(U.map((z) => [z.nome, z.bytes + z.origem]));
  return { okUniao: igual(m, { a: '1raw', b: '3cofre', c: '4cofre' }) };
}
function julgaLib(L) {
  const A = casosMapeia(L), B = casosCompara(L), U = casosUniao(L);
  return Object.assign({}, A, B, U);
}

console.log('1 · mapeamento do cofre para o nome do sungrow-raw');
const L0 = carrega(LIB);
const J = julgaLib(L0);
ok(J.okNomes, 'okNomes: so os zips da arvore das usinas, com o nome do sungrow-raw · ' + J.txt);
ok(J.okVersao, 'okVersao: vale a versao ~ de maior carimbo, com as anteriores guardadas');
ok(J.okOrdem, 'okOrdem: a listagem ao contrario escolhe a mesma versao');
ok(J.okIgnorados, 'okIgnorados: despejo de depuracao e o que nao e zip, contados');
ok(J.okRecusados, 'okRecusados: M3, profundidade, sufixo ilegivel, sem a pasta do ano e o mesmo nome em 2026 e 2027');
console.log('2 · comparacao lote a lote (sombra)');
ok(J.okBase, 'okBase: dois lotes julgados iguais, a versao anterior do fluxo nomeada, o lote vivo e o so no cofre nomeados, zero falha · ' + J.txtBase);
ok(J.okDefeitos, 'okDefeitos: dia faltando no cofre, zip faltando, zip a mais, tamanho e MD5 dao a falha deles · ' + J.txtDefeitos);
console.log('3 · uniao');
ok(J.okUniao, 'okUniao: no nome dos dois vale o cofre; o que so o sungrow-raw tem fica');

/* ---------------------------------------------------------------- 4 · gerador de ponta a ponta ---------------------- */
function crc32(x) { let c; const t = crc32.t || (crc32.t = Array.from({ length: 256 }, (_, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let v = 0xFFFFFFFF; for (const y of x) v = t[(v ^ y) & 255] ^ (v >>> 8); return (v ^ 0xFFFFFFFF) >>> 0; }
function zip(arqs) {
  const loc = [], cen = []; let off = 0;
  for (const a of arqs) {
    const nome = Buffer.from(a.nome), dados = Buffer.from(a.dados), comp = zlib.deflateRawSync(dados);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(dados), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(nome.length, 26);
    loc.push(h, nome, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(dados), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nome); off += 30 + nome.length + comp.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(arqs.length, 8); e.writeUInt16LE(arqs.length, 10);
  e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cb, e]);
}
// o CSV do inversor como o logger grava (o cabecalho real de 36 colunas e as grandezas que o gerador exige)
const REAL36 = ['Horário', 'Potência ativa nominal', 'Potência reativa nominal', 'Modo de potência limitada', 'Tipo de saída',
  'Geração de energia ao longo do dia', 'Geração total', 'Tensão da linha AB', 'Tensão da linha BC', 'Tensão de linha CA',
  'Tempo de execução total conectado a rede', 'Temperatura de ar interna', 'Potência aparente total', 'Potência CC total',
  'Potência ativa total', 'Potência reativa total', 'Potência aparente total', 'Potência CC total', 'Potência ativa total',
  'Potência reativa total', 'Fator de potência total', '电网线电压AB', '电网线电压BC', '电网线电压CA', 'Corrente da fase A',
  'Corrente da fase B', 'Corrente da fase C', '新协议电网频率', 'Status do dispositivo', 'Status de operação do inversor_Xinjiang',
  'Status de operação do inversor_Ningxia', 'Status de operação do inversor', 'Código de falha', 'Impedância paralela em relação à terra',
  'Status', 'Tempo de operação diário'];
const CAB = [...REAL36, 'Eficiência do inversor', 'Estado de trabalho PID', 'Código de falha PID', 'Tensão do barramento',
  'Tensão de pólo negativo / terra', ...Array.from({ length: 12 }, (_, k) => 'Tensão MPPT' + (k + 1)), ...Array.from({ length: 12 }, (_, k) => 'Corrente MPPT' + (k + 1)),
  ...Array.from({ length: 24 }, (_, k) => 'Corrente na string ' + (k + 1))];
const hhmm = (i) => String(Math.floor(i / 12)).padStart(2, '0') + ':' + String((i % 12) * 5).padStart(2, '0');
// a potencia de meio-dia sobe o contador de vida (0,1 kWh): o dia tem energia, e o dia novo muda o produto
const pot = (i) => (i >= 72 && i <= 210 ? Math.round(250000 * Math.sin(Math.PI * (i - 72) / 138)) : 0);
function csvSn(dias, vida0, f) {
  const L = []; let vida = vida0;
  for (const d of dias) for (let i = 0; i < 288; i++) { const p = Math.round(pot(i) * f); vida += p / 12 / 100;
    L.push(CAB.map((n) => (n === 'Horário' ? d + ' ' + hhmm(i) + ':00' : n === 'Potência ativa nominal' ? ' 3200' : n === 'Geração total' ? ' ' + Math.round(vida)
      : n === 'Potência ativa total' ? ' ' + p : ' 0')).join(',')); }
  return '﻿' + CAB.join(',') + '\n' + L.join('\n') + '\n';
}
const T = ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];
const SNS = [['A0000000801', 300000, 1.0], ['A0000000802', 450000, 0.95], ['A0000000803', 600000, 0.9]];
const arq = (sn, dias, v0, f) => ({ nome: 'hiscsv/HIS_' + sn + '_' + dias[0].replace(/-/g, '') + '0000_' + dias[dias.length - 1].replace(/-/g, '') + '2355.csv', dados: csvSn(dias, v0, f) });
const ZIP_VELHO = zip(SNS.map(([sn, v, f]) => arq(sn, T.slice(0, 2), v, f)));   // a primeira copia: 13 e 14/10
const ZIP_NOVO = zip(SNS.map(([sn, v, f]) => arq(sn, T, v, f)));                // a regravada: 13 a 16/10
const ZIP_12 = zip(SNS.map(([sn, v, f]) => arq(sn, ['2026-10-12'], v - 5000, f)));
const NOME = 'M10/TS01/01 A 05/13.10 A 16.10.zip', NOME12 = 'M10/TS01/01 A 05/12.10 A 12.10.zip';
const COF = P + '2026/' + NOME;

const PRELOAD = `'use strict';
const Module = require('module'); const fs = require('fs');
const F = JSON.parse(fs.readFileSync(process.env.FORJA_AZURE, 'utf8'));
const conta = (s) => fs.appendFileSync(process.env.FORJA_LOG, s + '\\n');
const fake = { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: (c) => ({
  async *listBlobsFlat(o) { conta('lista ' + c); for (const x of (F[c] || [])) if (!o || !o.prefix || x.name.startsWith(o.prefix))
    yield { name: x.name, properties: { contentLength: fs.statSync(x.file).size, lastModified: new Date(x.lastModified), contentMD5: x.md5 ? Buffer.from(x.md5, 'base64') : undefined } }; },
  getBlobClient: (n) => ({ downloadToBuffer: async () => { conta('baixa ' + c + ' ' + n); const x = (F[c] || []).find((y) => y.name === n);
    if (!x) { const e = new Error('BlobNotFound'); e.statusCode = 404; throw e; } return fs.readFileSync(x.file); } }),
  getBlockBlobClient: () => { throw new Error('o ensaio nao grava no Azure'); } }) }) } };
const orig = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === '@azure/storage-blob') return fake;
  if (process.env.LIB_COFRE && /lib-sungrow-cofre(\\.js)?$/.test(req)) return orig.call(this, process.env.LIB_COFRE, parent, isMain);
  return orig.apply(this, arguments);
};
`;
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-cofre-'));
process.on('exit', () => { if (!process.env.MANTEM) fs.rmSync(raiz, { recursive: true, force: true }); else console.log(raiz); });
const PRE = path.join(raiz, 'preload.js'); fs.writeFileSync(PRE, PRELOAD);
const ARQ = path.join(raiz, 'arq'); fs.mkdirSync(ARQ);
const guarda = (n, buf) => { const f = path.join(ARQ, n); fs.writeFileSync(f, buf); return f; };
const F_VELHO = guarda('velho.zip', ZIP_VELHO), F_NOVO = guarda('novo.zip', ZIP_NOVO), F_12 = guarda('12.zip', ZIP_12);
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('base64');
// o mesmo tamanho do NOVO com um byte trocado no meio (o par que so a conferencia byte a byte separa)
const F_TROCADO = guarda('trocado.zip', (() => { const x = Buffer.from(ZIP_NOVO); x[x.length >> 1] ^= 0xff; return x; })());

let nRoda = 0;
// roda o gerador num mundo: { raw: [...], cofre: [...] } (cada item { name, file, lastModified, md5? }); devolve log, saida e downloads
function roda(gen, mundo, env) {
  const dir = path.join(raiz, 'r' + (++nRoda)); const OUT = path.join(dir, 'out'), SC = path.join(dir, 'sc');
  fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(SC);
  const g = (n, o) => fs.writeFileSync(path.join(OUT, n), zlib.gzipSync(JSON.stringify(o)));
  g('sg_ident.json', { esquema: 2, ident: Object.fromEntries(SNS.map(([sn], i) => [sn, { pos: 'M1/TS1/INV0' + (i + 1), d: '2026-10-12', metodo: 'ensaio' }])), busca: {}, sem_posicao: [] });
  g('estacao_logger_30min.json', { serie: ['2026-10-12', ...T].flatMap((d) => Array.from({ length: 48 }, (_, k) => { const t = d + 'T' + String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00') + ':00-03:00';
    return { t, ms: Date.parse(t), e1: k >= 14 && k <= 34 ? 600 : 0 }; })) });
  fs.writeFileSync(path.join(dir, 'inv_scada_hist.json'), JSON.stringify({ serie: [] }));
  fs.writeFileSync(path.join(dir, 'azure.json'), JSON.stringify({ 'sungrow-raw': mundo.raw || [], 'backup-dados-scada': mundo.cofre || [] }));
  const LOG = path.join(dir, 'azure.log'); fs.writeFileSync(LOG, '');
  const GO = path.join(dir, 'github_output'); fs.writeFileSync(GO, '');   // a saida do passo, como no Actions
  const e = Object.assign({}, process.env, { DADOS_STORAGE: 'forjado', FORJA_AZURE: path.join(dir, 'azure.json'), FORJA_LOG: LOG,
    LOCAL_SCADA_DIR: SC, LOCAL_OUT_DIR: OUT, LOCAL_INV_SCADA: path.join(dir, 'inv_scada_hist.json'), GITHUB_OUTPUT: GO }, env || {});
  for (const k of ['LOCAL_RAW_DIR', 'LOCAL_RAW_LISTA', 'REFAZER', 'SOMBRA', 'CONFERE_BYTES', 'VIVO_MIN', 'COFRE', 'RAW']) if (!(env && k in env)) delete e[k];
  if (!(env && 'FONTE' in env)) delete e.FONTE;
  if (!(env && 'LIB_COFRE' in env)) delete e.LIB_COFRE;
  const R = { OUT, dir };
  try { R.log = execFileSync('node', ['-r', PRE, gen], { env: e, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); R.codigo = 0; }
  catch (x) { R.log = String(x.stdout || '') + String(x.stderr || ''); R.codigo = x.status == null ? -1 : x.status; }
  R.azure = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  R.gravou = /^gravou=1$/m.test(fs.readFileSync(GO, 'utf8'));
  return R;
}
const saida = (R) => Object.fromEntries(fs.readdirSync(R.OUT).sort().map((n) => [n, JSON.stringify(JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R.OUT, n))).toString('utf8')), (k, v) => (k === 'gerado_em' ? undefined : v))]));
const difs = (a, b) => { const A = saida(a), B = saida(b); const ks = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort(); return ks.filter((k) => A[k] !== B[k]); };
const lidos = (R) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(R.OUT, 'sg_lidos.json'))).toString('utf8')).zips; } catch (e) { return null; } };
const OLD = '2026-10-17T09:20:00Z';
const it = (name, file, lm, extra) => Object.assign({ name, file, lastModified: lm || OLD }, extra || {});
const MUNDO = {
  raw: { raw: [it(NOME, F_NOVO)] },
  cofre: { cofre: [it(COF, F_VELHO), it(COF + '~20261017-061500', F_NOVO, '2026-10-17T09:25:00Z', { md5: md5(F_NOVO) })] },
  raw12: { raw: [it(NOME, F_NOVO), it(NOME12, F_12)] },
  // o fluxo ficou com a primeira copia (gatilho so de criacao) e tem o 12/10 que o cofre nao tem
  uniao: { raw: [it(NOME, F_VELHO), it(NOME12, F_12)], cofre: [it(COF, F_VELHO), it(COF + '~20261017-061500', F_NOVO, '2026-10-17T09:25:00Z')] },
};
function casosGerador(gen, lib) {
  const R = {};
  const xl = lib ? { LIB_COFRE: lib } : {};
  const r = roda(gen, MUNDO.raw, Object.assign({ FONTE: 'raw' }, xl)), k = roda(gen, MUNDO.cofre, Object.assign({ FONTE: 'cofre' }, xl));
  // a referencia (o sungrow-raw) tem de rodar; o modo cofre que sai vermelho e o defeito, julgado abaixo
  R.erro = r.codigo ? 'raw ' + r.codigo + ' · ' + r.log.split('\n').filter(Boolean).slice(-2).join(' | ') : null;
  if (R.erro) return R;
  const dk = difs(r, k);
  R.okIdentico = k.codigo === 0 && dk.length === 0 && Object.keys(saida(r)).length >= 10;
  const lk = lidos(k) || {};
  R.okLidos = igual(Object.keys(lk), [NOME]) && lk[NOME] === ZIP_NOVO.length;
  R.okBaixa = k.azure.filter((x) => x.startsWith('baixa ')).join('|') === 'baixa backup-dados-scada ' + COF + '~20261017-061500'
    && !k.azure.some((x) => x.includes('sungrow-raw'));
  const r12 = roda(gen, MUNDO.raw12, Object.assign({ FONTE: 'raw' }, xl)), u = roda(gen, MUNDO.uniao, Object.assign({ FONTE: 'uniao' }, xl));
  const du = u.codigo || r12.codigo ? ['estourou'] : difs(r12, u);
  R.okUniao = du.length === 0 && /uniao: 1 do cofre · 1 so no sungrow-raw/.test(u.log)
    && u.azure.filter((x) => x.startsWith('baixa ')).sort().join('|') === ['baixa backup-dados-scada ' + COF + '~20261017-061500', 'baixa sungrow-raw ' + NOME12].sort().join('|');
  // o recusado (mesmo nome em 2026 e 2027) nao e lido e pinta a rodada; o resto e gravado
  const mRec = { cofre: MUNDO.cofre.cofre.concat([it(P + '2026/' + NOME12, F_12), it(P + '2027/' + NOME12, F_12)]) };
  const kr = roda(gen, mRec, Object.assign({ FONTE: 'cofre' }, xl));
  R.okRecusado = kr.codigo === 1 && /::error::RECUSADO .*mesmo nome mapeado em 2026 e 2027/.test(kr.log) && /zip\(s\) recusado\(s\) pelo cofre/.test(kr.log)
    && igual(Object.keys(lidos(kr) || {}), [NOME]);
  // e mesmo vermelho ele marca que GRAVOU: os passos de produto do workflow dependem disso, nao do verde do passo
  R.okGravou = kr.gravou && k.gravou && r.gravou && u.gravou;
  R.txt = 'cofre codigo ' + k.codigo + ' · difs ' + JSON.stringify(dk) + ' · lidos ' + JSON.stringify(lk) + ' · baixados ' + JSON.stringify(k.azure.filter((x) => x.startsWith('baixa ')))
    + ' · uniao ' + JSON.stringify(du) + ' · recusado codigo ' + kr.codigo + ' gravou ' + kr.gravou;
  return R;
}
function casosSombra(gen, lib) {
  const R = {};
  const xl = lib ? { LIB_COFRE: lib } : {};
  const so = (m, extra) => roda(gen, m, Object.assign({ SOMBRA: '1', CONFERE_BYTES: '5' }, xl, extra || {}));
  // os dois iguais: o sungrow-raw com a versao que o cofre escolhe (do mesmo tamanho)
  const s0 = so({ raw: [it(NOME, F_NOVO)], cofre: MUNDO.cofre.cofre });
  R.okSombraVerde = s0.codigo === 0 && /"falhas":0/.test(s0.log) && /"bytes_iguais":1/.test(s0.log) && !fs.existsSync(path.join(s0.OUT, 'sg_lidos.json'));
  // o dia faltando no cofre: o sungrow-raw tem o lote 12.10 e o cofre nao
  const s1 = so({ raw: [it(NOME, F_NOVO), it(NOME12, F_12)], cofre: MUNDO.cofre.cofre });
  R.okSombraDia = s1.codigo === 1 && /::error::lote "12\.10 A 12\.10\.zip": 1 zip\(s\) no sungrow-raw e nenhum no cofre/.test(s1.log);
  // o mesmo tamanho com outro conteudo: so a conferencia byte a byte separa
  const s2 = so({ raw: [it(NOME, F_TROCADO)], cofre: MUNDO.cofre.cofre });
  R.okSombraBytes = s2.codigo === 1 && /::error::bytes diferentes/.test(s2.log) && /"falhas":0/.test(s2.log);
  R.txt = 'verde ' + s0.codigo + ' · dia ' + s1.codigo + ' · bytes ' + s2.codigo + ' · ' + (s0.log.match(/RESUMO .*/) || [''])[0];
  return R;
}

console.log('4 · gen-sungrow de ponta a ponta com o Azure forjado');
const G = casosGerador(GEN);
ok(!G.erro && G.okIdentico, 'okIdentico: o gerador lido do sungrow-raw e do cofre (versao ~ mais nova) da produtos identicos chave a chave · ' + (G.erro || G.txt));
ok(!G.erro && G.okLidos, 'okLidos: o manifesto guarda o nome do sungrow-raw com o tamanho da versao escolhida');
ok(!G.erro && G.okBaixa, 'okBaixa: no modo cofre so a versao escolhida e baixada, e nada do sungrow-raw');
ok(!G.erro && G.okUniao, 'okUniao: a uniao (sungrow-raw com a versao velha e o 12/10 so nele) da o mesmo que o sungrow-raw certo');
ok(!G.erro && G.okRecusado, 'okRecusado: o mesmo nome em 2026 e 2027 nao e lido, o resto e gravado e a rodada sai vermelha');
ok(!G.erro && G.okGravou, 'okGravou: a saida do passo diz gravou=1 nos quatro modos, inclusive no vermelho do recusado');
const S = casosSombra(GEN);
ok(S.okSombraVerde, 'okSombraVerde: SOMBRA=1 com os dois iguais fica verde, confere os bytes e nao grava produto · ' + S.txt);
ok(S.okSombraDia, 'okSombraDia: o dia faltando no cofre deixa a sombra vermelha com o lote nomeado');
ok(S.okSombraBytes, 'okSombraBytes: o mesmo tamanho com outro conteudo deixa a sombra vermelha pela conferencia byte a byte');

/* ---------------------------------------------------------------- 5 · plantios -------------------------------------- */
console.log('5 · plantios');
const srcLib = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
const srcGen = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
function mutante(src, trocas, nome) {
  let s = src;
  for (const [de, para] of trocas) { if (s.split(de).length !== 2) return null; s = s.split(de).join(para); }
  if (s === src) return null;
  const f = path.join(raiz, 'mut_' + nome.replace(/[^a-z0-9]+/gi, '_') + '.js'); fs.writeFileSync(f, s); return f;
}
// na LIB: julga com os casos 1-3 (e, quando dito, de ponta a ponta com o gerador original lendo a lib mudada)
function plantaLib(nome, trocas, chave, ponta) {
  const f = mutante(srcLib, trocas, nome);
  if (!f) { ok(false, 'plantio "' + nome + '": trecho nao casou'); return; }
  let r;
  try { r = ponta ? Object.assign(ponta === 'sombra' ? casosSombra(GEN, f) : casosGerador(GEN, f)) : julgaLib(carrega(f)); }
  catch (e) { ok(false, 'plantio "' + nome + '" estourou: ' + e.message); return; }
  ok(!r.erro && r[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (r.erro ? ' (estourou: ' + r.erro + ')' : ''));
}
plantaLib('zip ~ mais antigo escolhido', [['(x.versao > m.versao ? x : m)', '(x.versao < m.versao ? x : m)']], 'okVersao');
plantaLib('zip ~ mais antigo escolhido (de ponta a ponta)', [['(x.versao > m.versao ? x : m)', '(x.versao < m.versao ? x : m)']], 'okIdentico', 'gerador');
plantaLib('versao pela ordem da listagem', [['const maior = vs.reduce((m, x) => (x.versao > m.versao ? x : m));', 'const maior = vs[vs.length - 1];']], 'okOrdem');
plantaLib('prefixo do ano deixado no nome', [['const [, ano, resto] = a;', 'const [, ano] = a; const resto = rel;']], 'okNomes');
plantaLib('prefixo do ano deixado no nome (sombra)', [['const [, ano, resto] = a;', 'const [, ano] = a; const resto = rel;']], 'okSombraVerde', 'sombra');
plantaLib('prefixo do ano fixo errado', [['const ANO = /^(\\d{4})\\/(.+)$/;', 'const ANO = /^(2025)\\/(.+)$/;']], 'okNomes');
plantaLib('prefixo do ano fixo errado (de ponta a ponta)', [['const ANO = /^(\\d{4})\\/(.+)$/;', 'const ANO = /^(2025)\\/(.+)$/;']], 'okIdentico', 'gerador');
plantaLib('colisao de ano calada', [['if (anos.length > 1) {', 'if (false) {']], 'okRecusados');
plantaLib('zip fora da forma lido', [["if (!NOME_RAW.test(nome)) { recusados.push", "if (false) { recusados.push"]], 'okRecusados');
plantaLib('sufixo ilegivel calado', [["if (!v) { recusados.push({ nome: b.name, motivo: 'sufixo de versao ilegivel (esperado ~AAAAMMDD-HHMMSS)' }); continue; }", 'if (!v) continue;']], 'okRecusados');
plantaLib('pasta M3 calada', [["if (!/^M\\d\\d$/.test(topo)) { recusados.push", "if (!/^M\\d+$/.test(topo)) { recusados.push"]], 'okRecusados');
plantaLib('dia faltando no cofre calado', [["if (!o.cofre.size) { L.so_raw++; falhas.push(", "if (!o.cofre.size) { L.so_raw++; nomeadas.push("]], 'okDefeitos');
plantaLib('dia faltando no cofre calado (sombra)', [["if (!o.cofre.size) { L.so_raw++; falhas.push(", "if (!o.cofre.size) { L.so_raw++; nomeadas.push("]], 'okSombraDia', 'sombra');
plantaLib('tamanho nao comparado', [['if (z.bytes === b.size) {', 'if (true) {']], 'okDefeitos');
plantaLib('comparacao de um sentido so', [["for (const n of o.cofre.keys()) if (!o.raw.has(n)) falhas.push(", "for (const n of []) if (!o.raw.has(n)) falhas.push("]], 'okDefeitos');
plantaLib('tudo vivo (a sombra que se cala)', [['if (agora - novo < vivoMs) {', 'if (true) {']], 'okDefeitos');
plantaLib('versao anterior do fluxo vira falha', [['if (z.anteriores.some((x) => x.bytes === b.size)) {', 'if (false) {']], 'okBase');
plantaLib('uniao com o sungrow-raw ganhando', [["for (const z of deCofre) m.set(z.nome, Object.assign({ origem: 'cofre' }, z));",
  "for (const z of deCofre) if (!m.has(z.nome)) m.set(z.nome, Object.assign({ origem: 'cofre' }, z));"]], 'okUniao');
// no GERADOR: a copia mudada fica em scripts/ (os require relativos) e sai no finally
function plantaGen(nome, trocas, julga) {
  let s = srcGen;
  for (const [de, para] of trocas) { if (s.split(de).length !== 2) { ok(false, 'plantio "' + nome + '": trecho nao casou'); return; } s = s.split(de).join(para); }
  const g = path.join(__dirname, '_plantio_sungrow_cofre.js');
  fs.writeFileSync(g, s);
  let v;
  try { v = julga(g); } catch (e) { v = 'estourou: ' + e.message; } finally { fs.unlinkSync(g); }
  ok(v === false, 'plantio no gerador "' + nome + '" reprova' + (v !== false && v !== true ? ' (' + v + ')' : ''));
}
plantaGen('modo cofre lendo o sungrow-raw', [["if (FONTE === 'raw') return listaRawAzure();", 'return listaRawAzure();']],
  (g) => { const r = casosGerador(g); return r.erro ? 'estourou: ' + r.erro : r.okIdentico && r.okBaixa; });
plantaGen('recusado sem pintar a rodada', [["if (recusadosCofre) { console.log('::error::' + recusadosCofre + ' zip(s) recusado(s) pelo cofre nao foram lidos (acima)'); process.exitCode = 1; }", '']],
  (g) => { const r = casosGerador(g); return r.erro ? 'estourou: ' + r.erro : r.okRecusado; });
plantaGen('gravou calado', [["  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'gravou=1\\n');\n", '']],
  (g) => { const r = casosGerador(g); return r.erro ? 'estourou: ' + r.erro : r.okGravou; });
plantaGen('sombra sem a conferencia byte a byte', [['if (x.equals(y)) bIg++;', 'if (true) bIg++;']],
  (g) => casosSombra(g).okSombraBytes);
plantaGen('uniao sem o cofre', [['const U = C.uniao(await listaRawAzure(), deCofre);', 'const U = C.uniao(await listaRawAzure(), []);']],
  (g) => { const r = casosGerador(g); return r.erro ? 'estourou: ' + r.erro : r.okUniao; });

console.log(falhas.length ? '\nREPROVADO: ' + falhas.length + ' falha(s)' : '\nAPROVADO');
process.exit(falhas.length ? 1 : 0);
