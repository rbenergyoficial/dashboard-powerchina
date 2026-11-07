'use strict';
/*
 * gen-alarmes-eventos.js — grava `alarmes/eventos.json` (lote alarmes-eventos, 06/11/2026). A regra é a lib-alarmes-eventos.js. Roda no way2-recent.yml, depois do
 * gen-alarmes-way2.js: lê o alarmes_way2.json da rodada e o próprio publicado.
 * Tráfego: a rodada é de 5 min. O alarmes_scada.json e o alarmes_logger.json só se baixam quando a marca deles muda (a consulta da marca não traz o corpo); a marca
 * fica no próprio arquivo, em `marcas`. Falha ao ler essas duas fontes não derruba a rodada: fica o que está publicado.
 * Grava com If-Match no ETag lido (If-None-Match na primeira vez): outra rodada no meio, desiste e a próxima refaz.
 * Env: a credencial pela lib-conteiner (o OIDC do job).
 * Análise ao vivo (analise-ao-vivo, 07/11/2026): lê também o analise_vivo.json da rodada (gravado logo antes pelo gen-analise-vivo.js; ~KB). Ilegível: fica o que
 * está publicado da análise.
 * Ensaio sem rede: LOCAL_WAY2 · LOCAL_SCADA · LOCAL_LOGGER · LOCAL_ANALISE · LOCAL_PUB · LOCAL_OUT · AGORA (ISO BRT).
 */
const fs = require('fs'), zlib = require('zlib');
const L = require('./lib-alarmes-eventos'), S = require('./lib-alarmes-scada');

const CONTAINER = 'dados', BLOB = 'alarmes/eventos.json', WAY2 = 'alarmes_way2.json', SCADA = 'alarmes_scada.json', LOGGER = 'alarmes_logger.json', ANALISE = 'analise_vivo.json';

const gunzipSe = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
const parse = (b) => JSON.parse(gunzipSe(b).toString('utf8').replace(/^﻿/, ''));
const leLocal = (f) => (f && fs.existsSync(f) ? parse(fs.readFileSync(f)) : null);
const nao404 = (e) => !(e.statusCode === 404 && (e.code === 'BlobNotFound' || (e.details && e.details.errorCode === 'BlobNotFound')));

// baixa só se a marca mudou
async function novoOuNada(nome, marcas, novas) {
  try {
    const bc = require('./lib-conteiner').conteiner(CONTAINER).getBlockBlobClient(nome);
    const et = (await bc.getProperties()).etag;
    novas[nome] = et;
    if (marcas[nome] === et) return null;
    return parse(await bc.downloadToBuffer());
  } catch (e) {
    console.log('::warning::' + nome + ' ilegível nesta rodada (' + e.message + '): fica o que está publicado');
    if (marcas[nome]) novas[nome] = marcas[nome];
    return null;
  }
}

function resumo(o, b) {
  return BLOB + ': ' + o.eventos.length + ' eventos · ' + o.resumo.abertos + ' abertos · ' + o.resumo.causa_pendente + ' com causa pendente · ' + o.resumo.liga_ponte + ' pedem a ponte · '
    + o.resumo.com_voz + ' com voz · ' + (b / 1024).toFixed(1) + ' KB gz';
}

async function main() {
  const agoraMs = process.env.AGORA ? L.msBRT(process.env.AGORA) : Date.now();
  if (process.env.LOCAL_OUT) {
    const o = L.compoe({ way2: leLocal(process.env.LOCAL_WAY2), scada: leLocal(process.env.LOCAL_SCADA), logger: leLocal(process.env.LOCAL_LOGGER), analise: leLocal(process.env.LOCAL_ANALISE), pub: leLocal(process.env.LOCAL_PUB), agoraMs });
    const txt = JSON.stringify(o);
    S.exigeSemOperador(txt, BLOB);
    fs.writeFileSync(process.env.LOCAL_OUT, txt);
    console.log('[ensaio] ' + resumo(o, zlib.gzipSync(Buffer.from(txt)).length));
    return;
  }
  const C = require('./lib-conteiner');
  if (!C.credencial()) throw new Error('sem credencial do storage (o OIDC do job)');
  const bc = C.conteiner(CONTAINER).getBlockBlobClient(BLOB);
  let pub = null, etag = null;
  try {
    etag = (await bc.getProperties()).etag;
    pub = parse(await bc.downloadToBuffer());
  } catch (e) { if (nao404(e)) throw e; }   // só a ausência é primeira vez; outra falha estoura, senão a rodada perderia o que a ponte já pediu
  const way2 = parse(await C.conteiner(CONTAINER).getBlockBlobClient(WAY2).downloadToBuffer());
  const marcas = (pub && pub.marcas) || {}, novas = {};
  const scada = await novoOuNada(SCADA, marcas, novas), logger = await novoOuNada(LOGGER, marcas, novas);
  let analise = null;
  try { analise = parse(await C.conteiner(CONTAINER).getBlockBlobClient(ANALISE).downloadToBuffer()); } catch (e) { if (nao404(e)) console.log('::warning::' + ANALISE + ' ilegível nesta rodada (' + e.message + '): fica o que está publicado'); }
  const o = { ...L.compoe({ way2, scada, logger, analise, pub, agoraMs }), marcas: novas };
  const txt = JSON.stringify(o);
  S.exigeSemOperador(txt, BLOB);
  const buf = zlib.gzipSync(Buffer.from(txt, 'utf8'));
  try {
    await bc.upload(buf, buf.length, { conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=60' } });
  } catch (e) {
    if (e.statusCode === 412 || e.statusCode === 409) { console.log(BLOB + ' foi regravado no meio: desisto, a próxima rodada refaz'); return; }
    throw e;
  }
  console.log(resumo(o, buf.length));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { novoOuNada, BLOB };
