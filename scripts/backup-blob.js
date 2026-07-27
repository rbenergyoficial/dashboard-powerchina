/*
 * backup-blob.js — copia um blob para backup/<nome>.<carimbo>.json ANTES de alguém reescrevê-lo.
 *
 * POR QUE EXISTE: o pipeline não tem backup, versionamento nem dry-run. `subirJson` sobrescreve o
 * blob inteiro, e a listagem do container está bloqueada — não há como conferir se o soft-delete do
 * Storage está ligado. Descobri isso ao planejar o backfill de 573 dias do `way2_daily.json`
 * (27/07/2026): reescrever 10 meses de dado publicado sem rede de segurança não é aceitável.
 *
 * NÃO É PARA RODAR SOZINHO. É um passo ANTES do gerador, no mesmo workflow, para que o backup e a
 * reescrita aconteçam na mesma execução — backup de ontem não protege a reescrita de hoje.
 *
 * IDEMPOTENTE por dia: o carimbo é a data BRT, então N execuções no mesmo dia mantêm UM backup (o
 * primeiro do dia é sobrescrito pelos seguintes). Isso é de propósito — o que interessa é ter o
 * estado de antes de mexer, não um histórico de cada tentativa.
 *
 * Uso:  BLOBS="way2_daily.json,outro.json" node scripts/backup-blob.js
 *       (sem BLOBS, faz way2_daily.json)
 */
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = 'dados';
const PREFIXO = 'backup/';

async function baixar(container, nome) {
  const bc = container.getBlockBlobClient(nome);
  if (!(await bc.exists())) return null;
  const dl = await bc.download();
  const partes = [];
  for await (const ch of dl.readableStreamBody) partes.push(ch);
  return Buffer.concat(partes);
}

(async () => {
  const conn = process.env.DADOS_STORAGE;
  if (!conn) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }
  const nomes = (process.env.BLOBS || 'way2_daily.json').split(',').map(s => s.trim()).filter(Boolean);
  const carimbo = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);   // data BRT
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  for (const nome of nomes) {
    const buf = await baixar(container, nome);
    if (!buf) { console.log(`  ${nome}: NAO EXISTE — nada a copiar`); continue; }
    // confere que é JSON válido antes de guardar: backup de arquivo corrompido é pior que nenhum,
    // porque dá a falsa sensação de ter para onde voltar.
    let n = null;
    try { const j = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
      n = Array.isArray(j.dias) ? j.dias.length : null; }
    catch (e) { console.error(`ERRO: ${nome} nao e JSON valido (${e.message}) — ABORTANDO`); process.exit(1); }

    const alvo = `${PREFIXO}${nome.replace(/\.json$/, '')}.${carimbo}.json`;
    await container.getBlockBlobClient(alvo).upload(buf, buf.length,
      { blobHTTPHeaders: { blobContentType: 'application/json' } });
    console.log(`  ${nome} -> ${alvo}  (${Math.round(buf.length / 1024)} KB`
      + (n !== null ? `, ${n} dias` : '') + ')');
  }
  console.log('backup OK');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
