// Monitor ao vivo — potência ativa (Demat, 5 min) dos pontos de GERAÇÃO Way2 do Complexo Mauriti.
// Grava a resposta crua da API Way2 no blob dados/way2_monitor.json (formato {dados:[{pontoId,valores:[{data,valor}]}]}).
// Pontos: 6196/6197 (SE TR1/TR2), 6198–6219 (22 circuitos C1/C2/C3), 6233 (Somatório Geração).
// Secrets (env): DADOS_STORAGE (connection string Azure), WAY2_TOKEN (Pim-Auth da API Way2).
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const IDS = '6196,6197,6198,6199,6200,6201,6202,6203,6204,6205,6206,6207,6208,6209,6210,6211,6212,6213,6214,6215,6216,6217,6218,6219,6233';
const GRANDEZA = 'Demat';           // potência ativa medida (MW)
const INTERVALO = 'CincoMinutos';   // 5 min

// dia-calendário em BRT (UTC-3), sem depender do fuso do runner (UTC)
function diaBRT() {
  const d = new Date(Date.now() - 3 * 3600 * 1000);
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

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  if (!token) { console.error('ERRO: secret WAY2_TOKEN ausente.'); process.exit(1); }
  const day = diaBRT();
  const q = `ids=${IDS}&grandezas=${GRANDEZA}&contextodasdatas=ConsiderarDiaCheio&intervalo=${INTERVALO}` +
    `&medicao-datainicio=${day}T00:00:00&medicao-datafim=${day}T23:59:59` +
    `&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
  let j;
  for (let t = 1; t <= 5; t++) { try { j = await apiGet(q, token); break; } catch (e) { if (t === 5) throw e; await sleep(1500 * t); } }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const body = JSON.stringify(j);
  await container.getBlockBlobClient('way2_monitor.json').upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  let n = 0; (j.dados || []).forEach(it => (it.valores || []).forEach(v => { if (v.valor != null) n++; }));
  console.log(`way2_monitor.json OK · ${(j.dados || []).length} pontos · ${n} leituras (${GRANDEZA} ${INTERVALO}) · ${day}`);

  // Snapshot do blob ELÉTRICO ao vivo (way2_eletrico.json, todas as grandezas) -> hist/way2_<hoje>.json.
  // Assim o dia de HOJE fica disponível no mesmo padrão de URL do histórico (hist/way2_AAAA-MM-DD.json),
  // permitindo que os gráficos de tensão/corrente/etc. vejam qualquer dia (hoje ao vivo + passado).
  // O rollup diário definitivo (gen-way2-hist.js, 00:30 BRT) sobrescreve depois com a versão completa da API.
  try {
    const elet = container.getBlockBlobClient('way2_eletrico.json');
    if (await elet.exists()) {
      const buf = await elet.downloadToBuffer();
      await container.getBlockBlobClient(`hist/way2_${day}.json`).upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
      console.log(`snapshot hist/way2_${day}.json OK · ${(buf.length / 1048576).toFixed(1)} MB`);
    } else {
      console.log('way2_eletrico.json ainda não existe — snapshot pulado');
    }
  } catch (e) { console.error('snapshot hist falhou (não fatal):', e.message); }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
