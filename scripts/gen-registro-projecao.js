/* gen-registro-projecao.js — guarda, dia a dia, a projecao do mes aberto que o executivo publicou (PROMOVER hist-projecao).
 *
 * O historico em `executivo.json` (`historico_projecao`) refaz o METODO com os dados de hoje. Este arquivo guarda o que
 * a manchete de fato publicou: por entidade, mes e numero de dias fechados, a projecao, a meta e a energia dos dias
 * fechados, com todas as versoes de cada chave. Roda logo depois do executivo, na mesma agenda: depende so da manchete
 * que acabou de ser gravada. A regra de mesclagem mora em lib-historico-projecao.js.
 *
 * 🔴 So o 404 significa "ainda nao existe"; qualquer outra falha ao ler estoura. O registro novo e conferido chave a
 * chave contra o antigo antes de gravar, e a gravacao e condicionada ao ETag lido (ou a nao existir), para duas rodadas
 * nao se sobreporem. Mes aberto com dias fechados e nenhuma entrada saindo e erro: a manchete mudou de forma e o
 * registro pararia de crescer calado.
 *
 * Env: DADOS_STORAGE · OUT_CONTAINER=dados. Local: LOCAL_DIR=<pasta> le executivo.json e projecao_registro.json de la
 * e grava la.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { entradasDaManchete, mesclaRegistro, confereCrescimento } = require('./lib-historico-projecao.js');

const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const REG = 'projecao_registro.json';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
const gz = (obj) => zlib.gzipSync(Buffer.from(JSON.stringify(obj), 'utf8'));

async function leitor() {
  if (process.env.LOCAL_DIR) {
    const d = process.env.LOCAL_DIR;
    return {
      le: async (nome) => { const p = path.join(d, nome); if (!fs.existsSync(p)) return { obj: null }; return { obj: deJson(fs.readFileSync(p)) }; },
      grava: async (nome, obj) => { const b = gz(obj); fs.writeFileSync(path.join(d, nome), b); return b.length; },
    };
  }
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cli = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  return {
    le: async (nome) => {
      try {
        const bc = cli.getBlockBlobClient(nome), r = await bc.download();
        const c = []; for await (const d of r.readableStreamBody) c.push(d);
        return { obj: deJson(Buffer.concat(c)), etag: r.etag };
      } catch (e) { if (e && e.statusCode === 404) return { obj: null }; throw e; }
    },
    grava: async (nome, obj, etag) => {
      const b = gz(obj);
      await cli.getBlockBlobClient(nome).upload(b, b.length, {
        conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
        blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
      return b.length;
    },
  };
}

(async () => {
  const io = await leitor();
  const ex = (await io.le('executivo.json')).obj;
  if (!ex || !Array.isArray(ex.manchete_ufv)) throw new Error('executivo.json sem manchete_ufv');
  const agora = new Date().toISOString();
  const novas = entradasDaManchete(ex.manchete_ufv, agora);
  // TODA linha de mes aberto com dias fechados tem de virar entrada: uma so que caia (sem projecao, sem meta) e a chave
  // do dia daquela entidade nao volta
  const abertas = ex.manchete_ufv.filter((m) => m.fechado === 0 && m.dias_decorridos > 0);
  const caidas = abertas.filter((m) => !novas.some((e) => e.ufv === m.ufv && e.mes === m.mes));
  if (caidas.length) throw new Error(caidas.length + ' linha(s) de mes aberto com dias fechados sem entrada (' + caidas.slice(0, 4).map((m) => m.ufv).join(', ') + '): a manchete mudou de forma');
  const lido = await io.le(REG);
  if (lido.obj && !Array.isArray(lido.obj.registro)) throw new Error(REG + ' existe sem a lista `registro`: recusado gravar por cima');
  const lista0 = lido.obj ? lido.obj.registro : [];
  if (!novas.length) { console.log('sem mes aberto com dias fechados na manchete: nada a registrar (' + lista0.length + ' entradas ficam)'); return; }
  const M = mesclaRegistro(lista0, novas);
  const f = confereCrescimento(lista0, M.lista);
  if (f.length) throw new Error('o registro novo nao contem o antigo: ' + f.slice(0, 5).join('; '));
  if (!M.novas && !M.revistas) { console.log('registro: nada novo (' + lista0.length + ' entradas; ' + novas[0].mes + ' com ' + novas[0].dias_fechados + ' dias fechados ja registrado)'); return; }
  const n = await io.grava(REG, { atualizado: agora, registro: M.lista }, lido.etag);
  console.log('registro: ' + M.lista.length + ' entradas (+' + M.novas + ' novas, ' + M.revistas + ' com versao nova) · ' + n + ' bytes gzip');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
