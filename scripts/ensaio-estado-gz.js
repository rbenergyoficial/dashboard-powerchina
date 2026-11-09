// Ensaio da cópia compactada da saída anterior (lib-estado-gz, lote custo-way2agg-estado, 09/11/2026). Sem rede: um contêiner falso.
//
// 🔴 O QUE ESTA SENDO PROVADO
// A cópia só vale quando é da MESMA versão da saída. Os modos de errar: usar a cópia de outra versão (outro escritor regravou a
// saída, ou a cópia ficou para trás) e devolver dado velho calado; ou usar uma cópia corrompida. Em todos eles o certo é baixar a
// saída inteira, como antes do lote. E a fiação no gen-way2-agg: lê pela lib e grava a cópia com a etag que o upload devolveu.
// ⚠️ A lib é lida do PROPRIO scripts/lib-estado-gz.js, como ela sobe.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FONTE = fs.readFileSync(path.join(__dirname, 'lib-estado-gz.js'), 'utf8');
const carrega = (src) => { const m = { exports: {} }; new Function('module', 'exports', 'require', src)(m, m.exports, require); return m.exports; };

function conteiner() {
  const b = new Map(); let n = 0;
  const c = {
    baixado: 0,
    getBlockBlobClient: (nome) => ({
      getProperties: async () => { const x = b.get(nome); if (!x) throw Object.assign(new Error('404'), { statusCode: 404 }); return { etag: '"' + x.etag + '"', metadata: x.metadata || {} }; },
      downloadToBuffer: async () => { const x = b.get(nome); if (!x) throw Object.assign(new Error('404'), { statusCode: 404 }); c.baixado += x.buf.length; return Buffer.from(x.buf); },
      upload: async (body, len, opc) => { const e = '0x' + (++n).toString(16); b.set(nome, { buf: Buffer.from(body), etag: e, metadata: (opc && opc.metadata) || {} }); return { etag: '"' + e + '"' }; }
    }),
    _b: b
  };
  return c;
}

async function confere(EG, dizer) {
  let mau = 0;
  const ok = (c, m) => { if (!c) { mau += 1; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  const N = 'way2_1h.json';
  const corpo = JSON.stringify({ dados: Array.from({ length: 3000 }, (_, i) => ({ pontoId: i, valores: [{ data: '2026-11-09T10:00:00', valor: i * 1.5 }] })) });
  try {
    let c = conteiner();
    ok((await EG.le(c, N)) === null, 'sem saída: null (o gerador faz a carga completa, como antes)');
    let up = await c.getBlockBlobClient(N).upload(corpo, corpo.length, {});
    c.baixado = 0;
    let b = await EG.le(c, N);
    ok(b && b.toString() === corpo && c.baixado === corpo.length, 'saída sem cópia: baixa inteira');
    await EG.grava(c, N, corpo, up.etag);
    c.baixado = 0; b = await EG.le(c, N);
    ok(b && b.toString() === corpo, 'com a cópia da mesma versão: o conteúdo é o da saída');
    ok(c.baixado > 0 && c.baixado < corpo.length / 5, `com a cópia: baixa a compactada (${c.baixado} de ${corpo.length} bytes)`);
    const outro = corpo.replace('"valor":0', '"valor":99');
    await c.getBlockBlobClient(N).upload(outro, outro.length, {});   // outro escritor regrava a saída; a cópia fica para trás
    c.baixado = 0; b = await EG.le(c, N);
    ok(b && b.toString() === outro && c.baixado === outro.length, 'saída regravada por outro: ignora a cópia velha e baixa inteira');
    up = await c.getBlockBlobClient(N).upload(corpo, corpo.length, {});
    await EG.grava(c, N, corpo, up.etag);
    const gz = c._b.get(EG.PREFIXO + N + '.gz'); gz.buf = Buffer.from('lixo que nao e gzip');
    c.baixado = 0; b = await EG.le(c, N);
    ok(b && b.toString() === corpo && c.baixado >= corpo.length, 'cópia corrompida: baixa a saída inteira');
    await EG.grava(c, N, corpo, up.etag);
    c._b.get(EG.PREFIXO + N + '.gz').buf = zlib.gzipSync(Buffer.from(corpo.slice(0, 1000)));   // gzip válido, conteúdo truncado
    c.baixado = 0; b = await EG.le(c, N);
    ok(b && b.toString() === corpo, 'cópia truncada (tamanho não bate): baixa a saída inteira');
  } catch (e) { ok(false, 'estourou: ' + e.message); }
  return mau;
}

(async () => {
  console.log('ensaio da cópia compactada da saída anterior');
  let mau = await confere(carrega(FONTE), true);
  const G = fs.readFileSync(path.join(__dirname, 'gen-way2-agg.js'), 'utf8');
  const fio = [/existente = parseJson\(\s*b\s*\)/.test(G) && /const b = await EG\.le\(container, r\.blob\)/.test(G),
    /const up = await bc\.upload\(body/.test(G) && /EG\.grava\(container, r\.blob, body, up\.etag\)/.test(G),
    !/downloadToBuffer\(\)\)/.test(G.split('for (const r of resolucoes)')[1] || '')];
  if (fio.every(Boolean)) console.log('  ok  gen-way2-agg: lê pela lib, grava a cópia com a etag do upload, sem download inteiro direto');
  else { mau += 1; console.log('  [X] gen-way2-agg: fiação ' + JSON.stringify(fio)); }
  const PLANTIOS = {
    'cópia de qualquer versão': ["if (atual && limpa((ep.metadata || {}).etagsaida) === atual) {", 'if (true) {'],
    'sem conferir o tamanho': ['if (buf.length === Number((ep.metadata || {}).bytes)) {', 'if (true) {'],
    'cópia corrompida estoura': ['} catch (e) { /* sem cópia ou cópia ilegível: vai inteira */ }', '} finally { }'],
    'grava sem a etag': ["metadata: { etagsaida: limpa(etagSaida), bytes: String(buf.length) }", "metadata: { etagsaida: '', bytes: String(buf.length) }"]
  };
  let furou = 0;
  for (const [nome, [de, para]] of Object.entries(PLANTIOS)) {
    if (!FONTE.includes(de)) { console.log('  [X] plantio "' + nome + '": trecho não encontrado'); furou++; continue; }
    const n = await confere(carrega(FONTE.replace(de, para)), false);
    console.log((n > 0 ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n > 0 ? 'reprova (' + n + ' falha)' : 'PASSOU — o ensaio não o vê'));
    if (!n) furou++;
  }
  console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) não pego(s)` : 'APROVADO');
  process.exit(mau || furou ? 1 : 0);
})();
