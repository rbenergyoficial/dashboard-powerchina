// Histórico Way2 Elétrico — arquiva o dia completo (todas as grandezas) e mantém o rollup diário.
//
// Escreve dois tipos de blob no container `dados`:
//   1) hist/way2_AAAA-MM-DD.json  → snapshot 5-min do dia (mesmo formato do way2_eletrico.json ao vivo,
//                                    25 pontos × 8 grandezas). Fidelidade total p/ auditoria e visão de 2 dias.
//   2) way2_daily.json            → rollup diário rolante (1 linha/dia): energia, pico, média, FC, por trafo.
//                                    Alimenta as visões de meses e anos (leve).
//
// Modos:
//   - Cron diário (00:30 BRT): DIAS=1 → arquiva ONTEM (dia completo) e atualiza o rollup.
//   - Backfill manual (workflow_dispatch): DIAS=N → percorre N dias pra trás a partir de ontem.
//     Para cedo após PARAR_APOS_VAZIOS dias consecutivos sem dado (fim da retenção da Way2).
//
// Env (secrets/inputs):
//   DADOS_STORAGE  connection string Azure (container `dados`)   [obrigatório]
//   WAY2_TOKEN     Pim-Auth da API Way2                          [obrigatório]
//   DIAS           quantos dias pra trás processar (default 1)
//   FORCAR         '1'/'true' re-baixa dias já arquivados (default: pula os existentes)
//   PARAR_APOS_VAZIOS  early-stop no backfill (default 7)
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const HIST_PREFIX = 'hist/';
const DAILY_BLOB = 'way2_daily.json';
const OUTORGA_MW = 343.77;                       // capacidade instalada do complexo (FC)

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const IDS = [6196, 6197, 6198, 6199, 6200, 6201, 6202, 6203, 6204, 6205, 6206, 6207, 6208,
  6209, 6210, 6211, 6212, 6213, 6214, 6215, 6216, 6217, 6218, 6219, 6233];
const GRANDEZAS = ['Demat', 'Demre', 'TensaoA', 'TensaoB', 'TensaoC', 'CorrenteA', 'CorrenteB', 'CorrenteC'];
const INTERVALO = 'CincoMinutos';                // 5 min → 288 slots/dia

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// dia-calendário em BRT (UTC-3), independente do fuso do runner (UTC)
function diaBRT(offsetDias = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 - offsetDias * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function apiGet(query, token, timeout = 60000) {
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

function baseQuery(day, grandezas) {
  return `ids=${IDS.join(',')}&grandezas=${grandezas.join(',')}&contextodasdatas=ConsiderarDiaCheio` +
    `&intervalo=${INTERVALO}&medicao-datainicio=${day}T00:00:00&medicao-datafim=${day}T23:59:59` +
    `&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
}

async function getComRetry(query, token) {
  for (let t = 1; t <= 5; t++) {
    try { return await apiGet(query, token); }
    catch (e) { if (t === 5) throw e; await sleep(1500 * t); }
  }
}

// Busca o dia com TODAS as grandezas. Caminho rápido: 1 chamada com a lista completa.
// Fallback seguro: se a resposta vier com menos de 8 grandezas, refaz uma por uma e mescla.
async function buscarDia(day, token) {
  let j = await getComRetry(baseQuery(day, GRANDEZAS), token);
  const grs = new Set((j.dados || []).map(s => s.nomeGrandeza));
  if (grs.size < GRANDEZAS.length) {
    const merged = { ...j, dados: [] };
    for (const g of GRANDEZAS) {
      const jg = await getComRetry(baseQuery(day, [g]), token);
      merged.dados.push(...(jg.dados || []));
      await sleep(300);
    }
    j = merged;
  }
  return j;
}

function contaLeituras(j) {
  let n = 0; (j.dados || []).forEach(s => (s.valores || []).forEach(v => { if (v.valor != null) n++; }));
  return n;
}

// --------- rollup diário (a partir do snapshot 5-min) ----------
function valores(j, pid, g) {
  const s = (j.dados || []).find(x => x.pontoId === pid && x.nomeGrandeza === g);
  return (s && s.valores) || [];
}
const somaPos = (vs) => vs.reduce((a, v) => a + (v.valor > 0 ? v.valor : 0), 0);
// soma TUDO, inclusive negativo. Num medidor de fluxo o sinal é informação: negativo = consumindo.
const soma = (vs) => vs.reduce((a, v) => a + (v.valor != null ? v.valor : 0), 0);
const maxVal = (vs) => vs.reduce((m, v) => (v.valor != null && v.valor > m ? v.valor : m), 0);
const nNaoNulo = (vs) => vs.filter(v => v.valor != null).length;
const r = (x, d = 2) => Math.round(x * 10 ** d) / 10 ** d;

// valor Demat vem em kW → MW = /1000 ; energia MWh = Σ(kW)·(5/60 h)/1000
function rollupDia(j, day) {
  const g6233 = valores(j, 6233, 'Demat');       // somatório geração
  const g6196 = valores(j, 6196, 'Demat');       // TR1
  const g6197 = valores(j, 6197, 'Demat');       // TR2
  const nn = nNaoNulo(g6233);
  const horas = nn * 5 / 60;
  // BRUTA: fica com somaPos. É a referência de GERAÇÃO (alimenta PR e potencial) e o consumo
  // noturno do trafo não é "geração negativa" — somá-lo aqui distorceria o PR.
  const eneGer = somaPos(g6233) * 5 / 60 / 1000;
  // LÍQUIDA: soma COMPLETA, com os slots negativos. À noite o transformador CONSOME da rede
  // (magnetização + auxiliares): ~0,26 MW por trafo, ~12 MWh/dia no complexo. Descartar isso com
  // somaPos inflava a líquida em 0,72% — e era exatamente o desvio contra a planilha da PowerChina,
  // que usa a EneatLiquida da própria Way2. Medido em 25/07/2026: 40,914 GWh publicados contra
  // 40,623 corretos em jul/26 (dias 01–25).
  const eneTr1 = soma(g6196) * 5 / 60 / 1000;
  const eneTr2 = soma(g6197) * 5 / 60 / 1000;

  // energia LÍQUIDA por UFV — equação MUST (rateio): por slot,
  // UFV_liq = (bruta_UFV / bruta_total) × líquida_total(6196+6197); integra no dia.
  const UFV_CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
  const ALL_CIRC = [6198, 6199, 6200, 6201, 6202, 6203, 6204, 6205, 6206, 6207, 6208, 6209, 6210, 6211, 6212, 6213, 6214, 6215, 6216, 6217, 6218, 6219];
  const smap = {};   // pontoId -> { data: valor }
  for (const pid of ALL_CIRC.concat([6196, 6197])) { const m = {}; for (const v of valores(j, pid, 'Demat')) if (v.valor != null) m[v.data] = v.valor; smap[pid] = m; }
  // os slots dos TRAFOS entram no conjunto: à noite os circuitos ficam em zero e, se o tset saísse
  // só deles, os slots de consumo do trafo não existiriam para ninguém.
  const tset = new Set(); for (const pid of ALL_CIRC.concat([6196, 6197])) for (const t in smap[pid]) tset.add(t);
  const ufvLiq = {}, brutaDiaU = {}; for (const u in UFV_CIRC) { ufvLiq[u] = 0; brutaDiaU[u] = 0; }
  let noturno = 0;                       // consumo dos slots SEM geração (negativo)
  for (const t of tset) {
    let brutaTot = 0; for (const pid of ALL_CIRC) brutaTot += (smap[pid][t] || 0);
    const liqTot = (smap[6196][t] || 0) + (smap[6197][t] || 0);
    // sem geração no slot não há proporção para ratear: junta num balde e distribui no fim.
    if (brutaTot <= 0) { noturno += liqTot * 5 / 60 / 1000; continue; }
    for (const u in UFV_CIRC) { let bu = 0; for (const pid of UFV_CIRC[u]) bu += (smap[pid][t] || 0);
      brutaDiaU[u] += bu; ufvLiq[u] += bu / brutaTot * liqTot * 5 / 60 / 1000; }
  }
  // rateia o consumo noturno proporcionalmente à energia BRUTA do dia de cada UFV. Mantém a soma
  // das 9 igual ao total (eneTr1+eneTr2) sem inventar critério de alocação.
  const brDia = Object.values(brutaDiaU).reduce((a, b) => a + b, 0);
  if (brDia > 0 && noturno !== 0) for (const u in ufvLiq) ufvLiq[u] += noturno * brutaDiaU[u] / brDia;
  const ufv_liq_mwh = {}; for (const u in ufvLiq) ufv_liq_mwh[u] = r(ufvLiq[u], 3);

  return {
    dia: day,
    ene_ger_mwh: r(eneGer, 3),
    ene_liq_mwh: r(eneTr1 + eneTr2, 3),
    tr1_ene_mwh: r(eneTr1, 3),
    tr2_ene_mwh: r(eneTr2, 3),
    ufv_liq_mwh,                                   // energia líquida por UFV (rateio MUST) — p/ PPA×ML
    pico_mw: r(maxVal(g6233) / 1000, 3),
    tr1_pico_mw: r(maxVal(g6196) / 1000, 3),
    tr2_pico_mw: r(maxVal(g6197) / 1000, 3),
    media_mw: r(horas > 0 ? eneGer / horas : 0, 3),
    fc_pct: r(horas > 0 ? eneGer / (OUTORGA_MW * horas) * 100 : 0, 2),
    slots: nn,
    completo: nn >= 280,                          // ~24h de dados
  };
}

// --------- blob helpers ----------
async function baixarJson(container, nome) {
  const blob = container.getBlockBlobClient(nome);
  if (!(await blob.exists())) return null;
  const buf = await blob.downloadToBuffer();
  return JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));
}
async function subirJson(container, nome, obj) {
  const body = JSON.stringify(obj);
  await container.getBlockBlobClient(nome).upload(body, Buffer.byteLength(body),
    { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

// rollupDia é a UNICA fonte da verdade do rateio MUST (bruta -> liquida por UFV). O painel
// executivo importa ela p/ montar a barra do dia corrente sem duplicar a equacao: se o rateio
// mudar, muda nos dois lugares de uma vez. Por isso a IIFE abaixo so roda quando este arquivo
// e o ponto de entrada — importado, ele apenas exporta.
module.exports = { rollupDia, valores };
if (require.main !== module) return;

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  if (!token) { console.error('ERRO: secret WAY2_TOKEN ausente.'); process.exit(1); }
  const DIAS = Math.max(1, parseInt(process.env.DIAS || '1', 10) || 1);
  const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
  const PARAR = Math.max(1, parseInt(process.env.PARAR_APOS_VAZIOS || '7', 10) || 7);

  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  // rollup existente → mapa por dia (preserva o histórico já consolidado)
  const daily = (await baixarJson(container, DAILY_BLOB)) || { atualizado: null, dias: [] };
  const mapa = new Map((daily.dias || []).map(x => [x.dia, x]));

  let arquivados = 0, jaExistiam = 0, vazios = 0, vaziosSeguidos = 0;
  for (let i = 1; i <= DIAS; i++) {
    const day = diaBRT(i);                         // i=1 → ontem
    const histNome = `${HIST_PREFIX}way2_${day}.json`;
    const histBlob = container.getBlockBlobClient(histNome);

    // idempotência: dia já arquivado e não forçado — recomputa o rollup a partir do hist
    // (sem gastar API Way2), garantindo que campos novos do rollup entrem nos dias antigos.
    if (!FORCAR && await histBlob.exists()) {
      jaExistiam++;
      const j = await baixarJson(container, histNome);
      if (j) mapa.set(day, rollupDia(j, day));
      vaziosSeguidos = 0;
      continue;
    }

    let j;
    try { j = await buscarDia(day, token); }
    catch (e) { console.error(`  ${day}: falha na API (${e.message}) — pulando`); continue; }

    const n = contaLeituras(j);
    if (n === 0) {
      vazios++; vaziosSeguidos++;
      console.log(`  ${day}: sem dados (vazio ${vaziosSeguidos}/${PARAR})`);
      if (vaziosSeguidos >= PARAR) { console.log(`  parando: ${PARAR} dias vazios seguidos (fim da retenção).`); break; }
      continue;
    }
    vaziosSeguidos = 0;
    await subirJson(container, histNome, j);
    mapa.set(day, rollupDia(j, day));
    arquivados++;
    console.log(`  ${day}: arquivado · ${n} leituras`);
    await sleep(400);
  }

  // reescreve o rollup diário ordenado
  const dias = [...mapa.values()].sort((a, b) => a.dia.localeCompare(b.dia));
  await subirJson(container, DAILY_BLOB, { atualizado: new Date().toISOString(), dias });

  console.log(`OK · arquivados ${arquivados} · já existiam ${jaExistiam} · vazios ${vazios} · rollup: ${dias.length} dias`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
