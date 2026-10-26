/**
 * apagar-blob.js — apaga UM blob do conteiner `dados`, com copia de seguranca antes (apagar-blob.yml, so por dispatch manual).
 *
 * Rede de seguranca: uma COPIA em backup/<nome>.<carimbo ISO UTC>, conferida byte a byte, e so entao o apagamento.
 * Snapshot nao serve: o Azure nao apaga blob que tem snapshot sem apagar o snapshot junto. Os snapshots que ja existem
 * tambem vao para backup/, como backup/<nome>.snapshot-<carimbo>, antes do delete que os leva. Blob que nao existe FALHA:
 * nome digitado errado nao pode sair verde.
 *
 * Env: BLOB (o nome no conteiner `dados`) · a credencial pela lib-conteiner (a chave ou o OIDC do job).
 * O ensaio-apagar-blob.js chama `apaga` com um conteiner forjado.
 */
async function apaga(cont, nome, agora) {
  const bc = cont.getBlockBlobClient(nome);
  if (!(await bc.exists())) throw new Error('blob nao existe: ' + nome + '. Nada foi apagado.');
  const p = await bc.getProperties();
  console.log('apagando', nome, p.contentLength, 'bytes, modificado em', p.lastModified);
  const copia = async (origem, destino) => {
    const buf = await origem.downloadToBuffer();
    const cp = cont.getBlockBlobClient(destino);
    await cp.uploadData(buf, { blobHTTPHeaders: { blobContentType: p.contentType, blobContentEncoding: p.contentEncoding } });
    const volta = await cp.downloadToBuffer();
    if (!volta.equals(buf)) throw new Error('a copia em ' + destino + ' nao confere com a origem. Nada foi apagado.');
    console.log('copia conferida:', destino, volta.length, 'bytes');
  };
  const destino = 'backup/' + nome + '.' + (agora || new Date()).toISOString().replace(/[:.]/g, '-');
  await copia(bc, destino);
  let snaps = 0;
  for await (const it of cont.listBlobsFlat({ prefix: nome, includeSnapshots: true })) {
    if (it.name !== nome || !it.snapshot) continue;
    await copia(bc.withSnapshot(it.snapshot), 'backup/' + nome + '.snapshot-' + it.snapshot.replace(/[:.]/g, '-'));
    snaps += 1;
  }
  console.log('snapshots copiados:', snaps);
  await bc.delete({ deleteSnapshots: 'include' });
  console.log('apagado. para voltar: copiar ' + destino + ' para ' + nome + '.');
  return { destino, snaps };
}

module.exports = { apaga };

if (require.main === module) {
  (async () => {
    const nome = process.env.BLOB || '';   // o nome exatamente como digitado: nada de trim num workflow que apaga
    if (!nome) throw new Error('BLOB vazio. Nada foi apagado.');
    await apaga(require('./lib-conteiner').conteiner('dados'), nome);   // a chave ou o OIDC do job (lib-conteiner)
  })().catch((e) => { console.error(e.message); process.exit(1); });
}
