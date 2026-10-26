/**
 * ensaio-apagar-blob.js — o apagar-blob.js sobre um conteiner forjado em memoria (sem rede, sem credencial).
 *
 * Prova: a copia em backup/ existe e e igual ao original ANTES do delete; o snapshot vai para backup/ tambem; blob que nao
 * existe falha sem tocar em nada; copia que nao confere aborta SEM apagar. Plantios (o gerador mutado no temporario): sem a
 * copia, sem a conferencia byte a byte e sem a copia do snapshot, cada um reprova.
 *
 * uso: node scripts/ensaio-apagar-blob.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

let falhas = 0, casos = 0;
const ok = (c, msg) => { casos += 1; if (!c) falhas += 1; console.log((c ? '  ok    ' : '  FALHA ') + msg); return c; };

/* o conteiner forjado: blobs por nome, snapshots por nome, e o registro de cada operacao na ordem */
function forja(inicial, opc) {
  const o = opc || {};
  const blobs = new Map(Object.entries(inicial.blobs || {}).map(([k, v]) => [k, Buffer.from(v)]));
  const snaps = new Map(Object.entries(inicial.snaps || {}).map(([k, v]) => [k, Object.entries(v).map(([s, b]) => ({ s, b: Buffer.from(b) }))]));
  const ops = [];
  const cliente = (nome, snap) => ({
    async exists() { return blobs.has(nome); },
    async getProperties() { return { contentLength: blobs.get(nome).length, lastModified: 'ontem', contentType: 'application/json', contentEncoding: undefined }; },
    async downloadToBuffer() {
      if (snap) return Buffer.from((snaps.get(nome) || []).find((x) => x.s === snap).b);
      if (!blobs.has(nome)) throw new Error('404 ' + nome);
      return Buffer.from(blobs.get(nome));
    },
    async uploadData(buf) { ops.push('grava ' + nome); blobs.set(nome, o.corrompe && nome.startsWith('backup/') ? Buffer.concat([buf, Buffer.from('x')]) : Buffer.from(buf)); },
    withSnapshot(s) { return cliente(nome, s); },
    async delete(op) { ops.push('apaga ' + nome + (op && op.deleteSnapshots === 'include' ? ' +snaps' : '')); blobs.delete(nome); snaps.delete(nome); },
  });
  return {
    blobs, ops,
    getBlockBlobClient: (n) => cliente(n),
    async *listBlobsFlat({ prefix, includeSnapshots }) {
      for (const n of blobs.keys()) if (n.startsWith(prefix)) {
        yield { name: n };
        if (includeSnapshots) for (const x of snaps.get(n) || []) yield { name: n, snapshot: x.s };
      }
    },
  };
}

const GEN = path.join(__dirname, 'apagar-blob.js');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-apagar-'));
function mutante(nome, de, para) {
  const src = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
  if (src.split(de).length !== 2) throw new Error('plantio ' + nome + ': ancora achada ' + (src.split(de).length - 1) + ' vezes (atualizar a ancora; isto NAO e deteccao)');
  const f = path.join(TMP, 'mutante_' + nome + '.js');
  fs.writeFileSync(f, src.replace(de, () => para).replace("require('./lib-conteiner')", 'require(' + JSON.stringify(path.join(__dirname, 'lib-conteiner.js')) + ')'));
  return require(f);
}

const AGORA = new Date('2026-10-26T21:00:00.000Z');
const BK = 'backup/x.json.2026-10-26T21-00-00-000Z';
const calado = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

/* cada caso devolve true quando a regra se cumpriu; o mesmo caso roda contra o gerador e contra os mutantes */
const CASOS = {
  async copia_antes(G) {
    const c = forja({ blobs: { 'x.json': '{"a":1}', 'y.json': 'fica' }, snaps: { 'x.json': { '2026-10-01T00:00:00.0000000Z': '{"a":0}' } } });
    const r = await calado(() => G.apaga(c, 'x.json', AGORA));
    const iCop = c.ops.indexOf('grava ' + BK), iSnap = c.ops.findIndex((x) => x.startsWith('grava backup/x.json.snapshot-')), iDel = c.ops.indexOf('apaga x.json +snaps');
    return c.blobs.has(BK) && c.blobs.get(BK).toString() === '{"a":1}' && iSnap >= 0 && c.blobs.get(c.ops[iSnap].slice(6)).toString() === '{"a":0}'
      && iCop >= 0 && iDel > iCop && iDel > iSnap && !c.blobs.has('x.json') && c.blobs.get('y.json').toString() === 'fica' && r.snaps === 1;
  },
  async inexistente(G) {
    const c = forja({ blobs: { 'y.json': 'fica' } });
    let erro = '';
    try { await calado(() => G.apaga(c, 'x.json', AGORA)); } catch (e) { erro = e.message; }
    return /nao existe/.test(erro) && c.ops.length === 0;
  },
  async copia_torta(G) {
    const c = forja({ blobs: { 'x.json': '{"a":1}' } }, { corrompe: true });
    let erro = '';
    try { await calado(() => G.apaga(c, 'x.json', AGORA)); } catch (e) { erro = e.message; }
    return /nao confere/.test(erro) && c.blobs.has('x.json') && !c.ops.some((x) => x.startsWith('apaga'));
  },
};

(async () => {
  const G = require(GEN);
  console.log('1 · o gerador');
  ok(await CASOS.copia_antes(G), 'a copia em backup/ (e a do snapshot) existe, igual ao original, ANTES do delete; o vizinho fica');
  ok(await CASOS.inexistente(G), 'blob que nao existe falha sem gravar nem apagar nada');
  ok(await CASOS.copia_torta(G), 'copia que nao confere byte a byte aborta SEM apagar');

  console.log('2 · plantios (o gerador mutado tem de reprovar)');
  const PLANTIOS = [
    ['sem_copia', '  await copia(bc, destino);\n', '', 'copia_antes'],
    ['sem_conferencia', "    if (!volta.equals(buf)) throw new Error('a copia em ' + destino + ' nao confere com a origem. Nada foi apagado.');\n", '', 'copia_torta'],
    ['sem_snapshot', "    if (it.name !== nome || !it.snapshot) continue;\n", '    continue;\n', 'copia_antes'],
    ['sem_existe', "  if (!(await bc.exists())) throw new Error('blob nao existe: ' + nome + '. Nada foi apagado.');\n", '', 'inexistente'],
  ];
  for (const [nome, de, para, caso] of PLANTIOS) {
    let passou;
    try { passou = await CASOS[caso](mutante(nome, de, para)); } catch (e) { passou = false; }
    ok(passou === false, 'plantio "' + nome + '" reprova em ' + caso);
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(falhas ? 'ensaio-apagar-blob: ' + falhas + ' FALHA(S) em ' + casos : 'ensaio-apagar-blob: tudo certo · ' + casos + ' casos');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('FALHA: o ensaio estourou: ' + (e && e.stack ? e.stack : e)); process.exit(1); });
