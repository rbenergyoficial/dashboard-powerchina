// Reprocessa energia intradiária Way2 (grandeza EneatRec, 15 min) dos últimos N dias
// e grava no blob dados/. EneatRec é publicado em ~tempo real e em 15 min — a
// EneatLiqGeracao (liquidada) só fica pronta 1-2 dias depois, deixando "ontem" vazio.
// Mesmo nome de blob do fluxo Power Automate: way2_eneat_intradia_QuinzeMinutos_<AAAA-MM-DD>.json
// Secrets (env): DADOS_STORAGE (connection string Azure), WAY2_TOKEN (Pim-Auth da API Way2).
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const IDS = '6368,6369,6373,6374,6375,6376,6215,6378,6219'; // Mauriti 1..9 (energia)
const GRANDEZA = 'EneatRec';
const DIAS = Math.max(1, parseInt(process.env.DIAS || '5', 10)); // últimos N dias (inclui hoje)

// Dia-calendário em BRT (UTC-3), sem depender do fuso do runner (UTC).
function diaBRT(offset) {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
  d.setUTCDate(d.getUTCDate() - offset);
  return d.toISOString().slice(0, 10);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function buscarDia(day, token) {
  return new Promise((resolve, reject) => {
    const q = `ids=${IDS}&grandezas=${GRANDEZA}&contextodasdatas=ConsiderarDiaCheio&intervalo=QuinzeMinutos` +
      `&medicao-datainicio=${day}T00:00:00&medicao-datafim=${day}T23:59:59` +
      `&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
    const req = https.get({ ...API, path: `${API.path}?${q}`, headers: { 'Pim-Auth': token }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Way2 HTTP ' + res.statusCode)); }
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout 30s')));
    req.on('error', reject);
  });
}

// Retry com backoff — a API Way2 pode dar timeout/5xx em chamadas rápidas seguidas.
async function buscarComRetry(day, token, tentativas = 3) {
  for (let t = 1; t <= tentativas; t++) {
    try { return await buscarDia(day, token); }
    catch (e) { if (t === tentativas) throw e; await sleep(1200 * t); }
  }
}

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  if (!token) { console.error('ERRO: secret WAY2_TOKEN ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  let erros = 0;
  for (let k = 0; k < DIAS; k++) {
    const day = diaBRT(k);
    try {
      const j = await buscarComRetry(day, token);
      let cnt = 0;
      (j.dados || []).forEach(it => (it.valores || []).forEach(v => { if (v.valor != null && v.valor > 0) cnt++; }));
      if (!cnt) { console.log(`[${day}] ainda sem valores — pulando`); continue; }
      const body = JSON.stringify(j);
      const blob = container.getBlockBlobClient(`way2_eneat_intradia_QuinzeMinutos_${day}.json`);
      await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
      console.log(`[${day}] OK — ${cnt} valores 15min (${GRANDEZA}), ${(body.length / 1024).toFixed(0)} KB enviados ao blob`);
    } catch (e) { erros++; console.error(`[${day}] falhou: ${e.message}`); }
    await sleep(250); // pausa entre dias — evita timeout/limite da API Way2
  }
  console.log(`=== FIM: ${erros} dia(s) com erro ===`);
  if (erros) process.exit(1);
})();
