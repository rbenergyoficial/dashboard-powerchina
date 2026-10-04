'use strict';
/*
 * sobe-sungrow-raw.js — leva os zips do logger Sungrow de uma pasta local para o container `sungrow-raw`.
 *
 * A pasta `Sungrow_dados` (SharePoint da PowerChina) chega a esta maquina pelo OneDrive. Daqui para a frente quem a
 * leva ao blob e um fluxo do Power Automate; este script faz a CARGA DO HISTORICO (03/04/2026 em diante) e serve de
 * reserva se o fluxo parar.
 *
 * 🔴 O NOME DO BLOB E CONTRATO: o caminho RELATIVO a `Sungrow_dados`, igual, com as barras normais —
 *    `M05/TS01/01 A 05/27.09 A 30.09.zip`. O fluxo do Power Automate tem de gravar o MESMO nome; dois nomes para o
 *    mesmo zip fariam o gerador ler o arquivo duas vezes. O gerador nao depende da pasta para saber a posicao (a pasta
 *    nao e posicao: o M1 tem TS5 e TS6 trocados nas pastas; ele identifica cada inversor pelo contador de vida).
 * ⚠️ Entra so `M<NN>/TS<NN>/<grupo>/<arquivo>.zip`. A pasta solta `B23B0200011_<carimbo>` e despejo de log de depuracao
 *    do proprio logger, e fica fora; `desktop.ini` e qualquer outra coisa tambem.
 * ⚠️ Idempotente: o zip so sobe se o blob nao existe ou tem tamanho diferente (o lote seguinte da PowerChina pode
 *    regravar um zip com mais dias dentro, e ai o tamanho muda).
 *
 * uso: SUNGROW_DIR=<pasta Sungrow_dados> DADOS_STORAGE=<conexao> node scripts/sobe-sungrow-raw.js [--enviar]
 *      sem --enviar: so lista o que subiria
 */
const fs = require('fs');
const path = require('path');
const { BlobServiceClient } = require('@azure/storage-blob');

const DIR = process.env.SUNGROW_DIR;
const CONTAINER = process.env.RAW_CONTAINER || 'sungrow-raw';
const ENVIAR = process.argv.includes('--enviar');
const PARALELO = 4;
const NOME = /^M\d\d\/TS\d\d\/[^/]+\/[^/]+\.zip$/i;

function anda(dir, rel, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) anda(path.join(dir, e.name), r, out);
    else if (NOME.test(r)) out.push({ rel: r, abs: path.join(dir, e.name), bytes: fs.statSync(path.join(dir, e.name)).size });
  }
  return out;
}

(async () => {
  if (!DIR || !fs.existsSync(DIR)) throw new Error('SUNGROW_DIR nao definido ou inexistente');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const locais = anda(DIR, '', []);
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(CONTAINER);
  if (ENVIAR) await c.createIfNotExists();
  const no = new Map();
  if (await c.exists()) for await (const b of c.listBlobsFlat()) no.set(b.name, b.properties.contentLength);
  const sobe = locais.filter((x) => no.get(x.rel) !== x.bytes);
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  console.log('pasta: ' + locais.length + ' zips (' + mb(locais.reduce((a, x) => a + x.bytes, 0)) + ') · no container: '
    + no.size + ' · a subir: ' + sobe.length + ' (' + mb(sobe.reduce((a, x) => a + x.bytes, 0)) + ')');
  if (!ENVIAR) { sobe.slice(0, 5).forEach((x) => console.log('  ' + x.rel)); console.log('(seco) nada enviado'); return; }
  let feito = 0, bytes = 0;
  const fila = sobe.slice();
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    for (let x = fila.shift(); x; x = fila.shift()) {
      await c.getBlockBlobClient(x.rel).uploadFile(x.abs, { blobHTTPHeaders: { blobContentType: 'application/zip' } });
      feito += 1; bytes += x.bytes;
      if (feito % 50 === 0) console.log('  ' + feito + ' de ' + sobe.length + ' · ' + mb(bytes));
    }
  }));
  // conferencia: relista e exige cada zip local no container com o mesmo tamanho
  const depois = new Map();
  for await (const b of c.listBlobsFlat()) depois.set(b.name, b.properties.contentLength);
  const faltam = locais.filter((x) => depois.get(x.rel) !== x.bytes);
  console.log('enviados ' + feito + ' (' + mb(bytes) + ') · no container: ' + depois.size + ' · divergentes: ' + faltam.length);
  if (faltam.length) { faltam.slice(0, 5).forEach((x) => console.log('  🔴 ' + x.rel)); process.exit(1); }
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
