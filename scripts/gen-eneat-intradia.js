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

function apiGet(query, token, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ ...API, path: `${API.path}?${query}`, headers: { 'Pim-Auth': token }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Way2 HTTP ' + res.statusCode)); }
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

function buscarDia(day, token) {
  const q = `ids=${IDS}&grandezas=${GRANDEZA}&contextodasdatas=ConsiderarDiaCheio&intervalo=QuinzeMinutos` +
    `&medicao-datainicio=${day}T00:00:00&medicao-datafim=${day}T23:59:59` +
    `&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
  return apiGet(q, token);
}

// Retry com backoff — a API Way2 pode dar timeout/5xx em chamadas rápidas seguidas.
async function buscarComRetry(day, token, tentativas = 5) {
  for (let t = 1; t <= tentativas; t++) {
    try { return await buscarDia(day, token); }
    catch (e) { if (t === tentativas) throw e; await sleep(1500 * t); } // backoff 1.5s,3s,4.5s,6s
  }
}

// Agregado DIÁRIO EneatRec (bruta) desde o início de Mauriti → 1 blob p/ o comparativo 7d+ usar bruta.
// (não afeta o blob diário way2_energia_mes, que é EneatLiquida e alimenta PPA/KPIs.)
async function gerarDiario(container, token) {
  const ini = '2025-09-04', fim = diaBRT(0);
  const q = `ids=${IDS}&grandezas=${GRANDEZA}&contextodasdatas=ConsiderarDiaCheio&intervalo=UmDia` +
    `&medicao-datainicio=${ini}T00:00:00&medicao-datafim=${fim}T23:59:59` +
    `&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
  let j;
  for (let t = 1; t <= 5; t++) { try { j = await apiGet(q, token, 90000); break; } catch (e) { if (t === 5) throw e; await sleep(2000 * t); } }
  const body = JSON.stringify(j);
  await container.getBlockBlobClient('way2_eneat_diario.json').upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  let n = 0; (j.dados || []).forEach(it => (it.valores || []).forEach(v => { if (v.valor > 0) n++; }));
  console.log(`[diário] way2_eneat_diario.json OK — ${n} valores diários (${GRANDEZA}), ${(body.length / 1024).toFixed(0)} KB`);
}

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  if (!token) { console.error('ERRO: secret WAY2_TOKEN ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  async function processar(day) {
    try {
      const j = await buscarComRetry(day, token);
      let cnt = 0;
      (j.dados || []).forEach(it => (it.valores || []).forEach(v => { if (v.valor != null && v.valor > 0) cnt++; }));
      if (!cnt) { console.log(`[${day}] sem valores — pulando`); return true; }
      const body = JSON.stringify(j);
      const blob = container.getBlockBlobClient(`way2_eneat_intradia_QuinzeMinutos_${day}.json`);
      await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
      console.log(`[${day}] OK — ${cnt} valores 15min (${GRANDEZA}), ${(body.length / 1024).toFixed(0)} KB`);
      return true;
    } catch (e) { console.error(`[${day}] falhou: ${e.message}`); return false; }
  }

  const falhas = [];
  for (let k = 0; k < DIAS; k++) {
    const day = diaBRT(k);
    if (!(await processar(day))) falhas.push(day);
    await sleep(400); // pausa entre dias — evita limite de taxa da API Way2
  }
  // 2ª passada nos que falharam (a API costuma responder na segunda rodada)
  let resto = [];
  if (falhas.length) {
    console.log(`Repassando ${falhas.length} dia(s) que falharam...`);
    for (const day of falhas) { await sleep(800); if (!(await processar(day))) resto.push(day); }
  }
  console.log(`=== FIM 15min: ${DIAS - resto.length}/${DIAS} dias OK` + (resto.length ? ` · ainda com erro: ${resto.join(', ')}` : '') + ` ===`);
  // Agregado diário (bruta) p/ o comparativo 7d+
  try { await gerarDiario(container, token); } catch (e) { console.error('diário falhou: ' + e.message); }
  // Só falha o job se MUITOS dias (>15%) ficarem de fora — poucas falhas transientes são
  // preenchidas pelo agendamento diário (últimos 5 dias) nas próximas execuções.
  if (resto.length > Math.max(3, DIAS * 0.15)) process.exit(1);
})();
