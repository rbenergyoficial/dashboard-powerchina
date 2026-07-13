// gen-way2-recent.js — pós-processamento de blob (NÃO consulta a Way2).
// A cada execução (5 min):
//   1) snapshot: copia o blob ao vivo way2_eletrico.json (escrito pelo fluxo Power Automate
//      "Way2 Eletrico 5min") para hist/way2_<hoje>.json — deixa o dia de HOJE no mesmo padrão
//      de URL do histórico (hist/way2_AAAA-MM-DD.json).
//   2) way2_recent.json: mescla os últimos N_RECENT dias (5-min, todas as grandezas) num só
//      blob, para os gráficos de série temporal mostrarem histórico CONTÍNUO que cruza a virada
//      do dia (ex.: "últimos 2 dias" = ontem + hoje juntos).
// Só usa a connection string (DADOS_STORAGE) — nenhum token Way2. Independente do fluxo PA.
const { BlobServiceClient } = require('@azure/storage-blob');

const CONTAINER = 'dados';
const LIVE_BLOB = 'way2_eletrico.json';
const N_RECENT = 2;                              // dias no blob rolante (ontem+hoje = "≤2d"; menor = download mais leve)

function diaBRT(offset = 0) {                    // dia-calendário BRT (UTC-3), independente do fuso do runner
  const d = new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}
const parseJson = (buf) => JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));

(async () => {
  const conn = process.env.DADOS_STORAGE;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const day = diaBRT();

  // 1) snapshot de hoje
  let eletJson = null;
  const live = container.getBlockBlobClient(LIVE_BLOB);
  if (await live.exists()) {
    const buf = await live.downloadToBuffer();
    await container.getBlockBlobClient(`hist/way2_${day}.json`).upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    eletJson = parseJson(buf);
    console.log(`snapshot hist/way2_${day}.json OK · ${(buf.length / 1048576).toFixed(1)} MB`);
  } else {
    console.log(`${LIVE_BLOB} não existe — snapshot pulado`);
  }

  // 2) way2_recent.json = últimos N_RECENT dias mesclados (mais antigo -> hoje)
  const dias = [];
  for (let k = N_RECENT - 1; k >= 0; k--) dias.push(diaBRT(k));
  const merged = new Map();   // "pontoId|grandeza" -> { pontoId, ultimaColeta, nomeGrandeza, valores:[] }
  let usados = 0;
  for (const dd of dias) {
    let jb = null;
    if (dd === day) { jb = eletJson; }
    else {
      const bc = container.getBlockBlobClient(`hist/way2_${dd}.json`);
      if (await bc.exists()) jb = parseJson(await bc.downloadToBuffer());
    }
    if (!jb || !jb.dados) continue;
    usados++;
    for (const s of jb.dados) {
      const key = s.pontoId + '|' + s.nomeGrandeza;
      let m = merged.get(key);
      if (!m) { m = { pontoId: s.pontoId, ultimaColeta: s.ultimaColeta, nomeGrandeza: s.nomeGrandeza, valores: [] }; merged.set(key, m); }
      m.ultimaColeta = s.ultimaColeta;
      for (const v of (s.valores || [])) m.valores.push(v);
    }
  }
  if (usados > 0) {
    const out = { inicio: dias[0], fim: day, dias_incluidos: dias, intervalo: 'CincoMinutos', dados: [...merged.values()] };
    const rb = JSON.stringify(out);
    // max-age 60s: os 13 painéis do Monitor compartilham 1 download no carregamento (em vez de
    // cada um re-baixar), e o auto-refresh (>60s) ainda pega dado novo. Blob muda a cada 5min.
    await container.getBlockBlobClient('way2_recent.json').upload(rb, Buffer.byteLength(rb), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    console.log(`way2_recent.json OK · ${usados} dias (${dias.join(', ')}) · ${(rb.length / 1048576).toFixed(1)} MB`);
  } else {
    console.log('nenhum dia disponível — way2_recent.json não gerado');
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
