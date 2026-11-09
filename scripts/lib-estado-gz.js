/*
 * lib-estado-gz.js — a saída anterior de um gerador, lida por uma cópia COMPACTADA (lote custo-way2agg-estado, 09/11/2026).
 *
 * 💰 POR QUE
 * O gen-way2-agg, a cada hora, baixava inteiros os três agregados que ele mesmo gravou na hora anterior (way2_15min 8,7 MB,
 * way2_30min 13,3 MB, way2_1h 20 MB): ~42 MB por execução, ~1 GB/dia de saída intercontinental (os runners ficam fora do
 * Brasil), ~R$ 24/mês só disso (auditoria de custo de 09/11/2026). O JSON compacta ~10x.
 *
 * COMO
 * grava(cont, nome, body, etagSaida): logo depois de gravar a saída, grava `estado-gerador/<nome>.gz` com o MESMO conteúdo em
 *   gzip e, nos metadados, a etag que o upload da saída devolveu.
 * le(cont, nome): devolve o Buffer da saída atual. Pede as propriedades da saída (HEAD, sem corpo) e a cópia compactada; usa a
 *   cópia SÓ se a etag gravada nela for a etag ATUAL da saída. Qualquer outro caso (sem cópia, cópia de outra versão, outro
 *   escritor regravou a saída, gzip corrompido) baixa a saída inteira, como antes. Devolve null se a saída não existe.
 * O que o gerador publica NÃO muda: a saída continua a mesma, no mesmo lugar, com os mesmos cabeçalhos.
 */
'use strict';
const zlib = require('zlib');

const PREFIXO = 'estado-gerador/';
const limpa = (e) => String(e || '').replace(/"/g, '');
const EST = { copia: 0, inteira: 0, bytesCopia: 0, bytesInteira: 0 };

async function le(cont, nome) {
  const bc = cont.getBlockBlobClient(nome);
  let props;
  try { props = await bc.getProperties(); } catch (e) { if (e && e.statusCode === 404) return null; throw e; }
  const atual = limpa(props.etag);
  try {
    const ec = cont.getBlockBlobClient(PREFIXO + nome + '.gz');
    const ep = await ec.getProperties();
    if (atual && limpa((ep.metadata || {}).etagsaida) === atual) {
      const gz = await ec.downloadToBuffer();
      const buf = zlib.gunzipSync(gz);
      if (buf.length === Number((ep.metadata || {}).bytes)) {
        EST.copia++; EST.bytesCopia += gz.length;
        return buf;
      }
    }
  } catch (e) { /* sem cópia ou cópia ilegível: vai inteira */ }
  const buf = await bc.downloadToBuffer();
  EST.inteira++; EST.bytesInteira += buf.length;
  return buf;
}

async function grava(cont, nome, body, etagSaida) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  const gz = zlib.gzipSync(buf, { level: 9 });
  await cont.getBlockBlobClient(PREFIXO + nome + '.gz').upload(gz, gz.length, {
    blobHTTPHeaders: { blobContentType: 'application/gzip' },
    metadata: { etagsaida: limpa(etagSaida), bytes: String(buf.length) }
  });
  return gz.length;
}

function resumo() {
  const mb = (b) => (b / 1048576).toFixed(1);
  return 'estado compactado: ' + EST.copia + ' pela copia (' + mb(EST.bytesCopia) + ' MB) · ' + EST.inteira + ' inteira(s) ('
    + mb(EST.bytesInteira) + ' MB)';
}

module.exports = { le, grava, resumo, PREFIXO, EST };
