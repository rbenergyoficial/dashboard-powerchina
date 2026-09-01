// gen-way2-eletrico.js — a ponte para a API da Way2, hoje feita pelo Power Automate.
//
// 🔴 POR QUE ESTE ARQUIVO EXISTE
// `way2_eletrico.json` e o UNICO blob que nasce fora do GitHub: quem o escreve e o fluxo do Power
// Automate "Way2 Eletrico 5min". Todo o resto do ao-vivo DERIVA dele — o `gen-way2-recent.js` o le
// e produz `way2_latest`, `kpis_dia`, `way2_recent`, `way2_saude` e `hist/way2_<dia>`. Ou seja: sem
// esse fluxo, nada novo entra no sistema.
//
// O fluxo depende da licenca Power Automate Premium (conectores HTTP e Azure Blob). Ela e trial e
// tem prazo. Este gerador tira essa dependencia: o repo JA tem o segredo `WAY2_TOKEN` e o
// `gen-must.js` ja fala com a mesma API — o que faltava era alguem escrever a coleta de 5 min.
//
// ⚠️ ELE REPRODUZ, NAO REINTERPRETA. O blob e a resposta CRUA da API (envelope `inicio`/`fim`/
// `dataInicio`/`dataFim`/`intervalo` + `dados`), e e assim que ele tem de continuar: o
// `gen-way2-recent.js` foi escrito contra essa forma. Qualquer melhoria (gzip, poda de grandeza)
// e uma mudanca SEPARADA, depois que este substituir o fluxo sem diferenca medida.
//
// Modos:
//   (padrao)          grava no blob `way2_eletrico.json`
//   LOCAL_OUT=arq     grava em arquivo, sem tocar em producao
//   COMPARAR=1        busca da API, baixa o blob que o fluxo escreveu e COMPARA — nao grava nada.
//                     E o crivo que autoriza a troca: sem ele, "parece igual" nao e igual.

'use strict';
const https = require('https');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'way2_eletrico.json';
const BASE_LEITURA = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

// Os 24 medidores (6196-6219) mais o 6233, que e o medidor do COMPLEXO. A lista e explicita e nao
// derivada: um ponto a mais ou a menos muda o que os paineis somam, e tem de doer na revisao.
const IDS = [];
for (let p = 6196; p <= 6219; p++) IDS.push(p);
IDS.push(6233);

// As oito grandezas que o blob carrega hoje. `Demat` e a potencia (o ao-vivo inteiro sai dela);
// as demais alimentam tensao, corrente e reativa dos paineis eletricos.
const GRANDEZAS = ['CorrenteA', 'CorrenteB', 'CorrenteC', 'Demat', 'Demre', 'TensaoA', 'TensaoB', 'TensaoC'];
const INTERVALO = 'CincoMinutos';

const SERIES_ESPERADAS = IDS.length * GRANDEZAS.length;   // 25 x 8 = 200

// dia-calendario em BRT (UTC-3), independente do fuso do runner (que roda em UTC)
function diaBRT(offset = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function query(dia) {
  return 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZAS.join(',')
    + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + INTERVALO
    + '&medicao-datainicio=' + dia + 'T00:00:00&medicao-datafim=' + dia + 'T23:59:59'
    + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
}

// 🔴 O 429 pede ESPERA LONGA, nao mais uma tentativa rapida — a licao ja paga pelo gen-must.js na
// recarga de 366 dias. Um backoff curto nao alcanca a janela de limite: a chamada falha, o dado
// ANTIGO fica no ar e nada denuncia.
function apiGet(q, token, timeout = 90000) {
  return new Promise((ok, ko) => {
    const req = https.get({ ...API, path: API.path + '?' + q, headers: { 'Pim-Auth': token }, timeout }, res => {
      if (res.statusCode !== 200) { res.resume(); return ko(Object.assign(new Error('Way2 HTTP ' + res.statusCode), { status: res.statusCode })); }
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { ok(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}

async function buscaComEspera(q, token) {
  const esperas = [0, 15000, 60000, 180000];
  let ultimo;
  for (let i = 0; i < esperas.length; i++) {
    if (esperas[i]) await new Promise(r => setTimeout(r, esperas[i]));
    try { return await apiGet(q, token); }
    catch (e) {
      ultimo = e;
      if (e.status && e.status !== 429 && e.status < 500) throw e;   // 4xx que nao e limite nao melhora esperando
    }
  }
  throw ultimo;
}

function leBlob(nome) {
  const zlib = require('zlib');
  return new Promise((ok, ko) => {
    https.get(BASE_LEITURA + nome, { headers: { 'accept-encoding': 'gzip' } }, res => {
      if (res.statusCode === 404) return ok(null);
      if (res.statusCode !== 200) return ko(new Error(nome + ' HTTP ' + res.statusCode));
      const ch = []; res.on('data', c => ch.push(c));
      res.on('end', () => {
        try {
          let b = Buffer.concat(ch);
          // 🔴 gzip se reconhece pelos BYTES MAGICOS, nao pelo cabecalho: o Azure serve os bytes
          // gravados, e um blob comprimido lido como texto vira JSON invalido.
          if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
          if (/gzip/i.test(res.headers['content-encoding'] || '') && b[0] === 0x1f) b = zlib.gunzipSync(b);
          ok(JSON.parse(b.toString('utf8').replace(/^﻿/, '')));
        } catch (e) { ko(e); }
      });
    }).on('error', ko);
  });
}

// A guarda que impede publicar coleta pela metade. Serie faltando nao e "medidor parado": e coleta
// incompleta, e no painel as duas sao indistinguiveis — zero e uma medicao, ausencia nao e.
function confere(resp) {
  const erros = [];
  if (!resp || !Array.isArray(resp.dados)) erros.push('resposta sem `dados`');
  else {
    const n = resp.dados.length;
    if (n !== SERIES_ESPERADAS) erros.push(`series ${n}, esperava ${SERIES_ESPERADAS}`);
    const pts = new Set(resp.dados.map(s => s.pontoId));
    const faltam = IDS.filter(p => !pts.has(p));
    if (faltam.length) erros.push('pontos ausentes: ' + faltam.join(','));
    const gs = new Set(resp.dados.map(s => s.nomeGrandeza));
    const gf = GRANDEZAS.filter(g => !gs.has(g));
    if (gf.length) erros.push('grandezas ausentes: ' + gf.join(','));
  }
  for (const k of ['inicio', 'fim', 'dataInicio', 'dataFim', 'intervalo']) {
    if (!resp || resp[k] == null) erros.push('envelope sem `' + k + '`');
  }
  return erros;
}

// Quantos instantes distintos com valor a resposta traz, por ponto — a medida de "o quanto veio".
function cobertura(resp) {
  const por = new Map();
  for (const s of resp.dados || []) {
    if (s.nomeGrandeza !== 'Demat') continue;
    por.set(s.pontoId, (s.valores || []).filter(v => v && v.valor != null).length);
  }
  return por;
}

async function grava(json) {
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const buf = Buffer.from(json, 'utf8');
  await container.getBlockBlobClient(OUT_BLOB).upload(buf, buf.length, {
    blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' }
  });
  return buf.length;
}

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) throw new Error('WAY2_TOKEN nao definido');
  const dia = process.env.DIA || diaBRT(0);

  const t0 = Date.now();
  const resp = await buscaComEspera(query(dia), token);
  const ms = Date.now() - t0;

  const erros = confere(resp);
  if (erros.length) { console.error('RECUSADO:\n  ' + erros.join('\n  ')); process.exit(1); }

  const cob = cobertura(resp);
  const vs = [...cob.values()];
  console.log('dia %s · %d series · %d ms', dia, resp.dados.length, ms);
  console.log('cobertura Demat: min %d · max %d · pontos %d', Math.min(...vs), Math.max(...vs), cob.size);

  // ── COMPARAR: o crivo que autoriza a troca ────────────────────────────────
  if (/^(1|true|sim)$/i.test(process.env.COMPARAR || '')) {
    const vivo = await leBlob(OUT_BLOB);
    if (!vivo) { console.error('o blob do fluxo nao existe — nada a comparar'); process.exit(1); }
    const cv = cobertura(vivo);
    // 🔴 O crivo NAO e igualdade, e a DIRECAO da diferenca. As duas leituras acontecem em
    // instantes distintos, e um ponto que estava atrasado quando o fluxo escreveu aparece com
    // MAIS amostras quando o gerador le depois — o gerador a frente e o lado seguro. O que
    // reprova e ele ficar ATRAS: ai perderia dado que o fluxo ja tinha, e a troca custaria
    // medicao.
    const linhas = [];
    let piorAtraso = 0, piorAvanco = 0;
    for (const p of IDS) {
      const a = cv.get(p) ?? -1, b = cob.get(p) ?? -1;
      if (a !== b) linhas.push(`  ponto ${p}: fluxo ${a} · gerador ${b}` + (b > a ? '  (a frente)' : '  <- ATRAS'));
      piorAtraso = Math.max(piorAtraso, a - b);
      piorAvanco = Math.max(piorAvanco, b - a);
    }
    const mesmaForma = JSON.stringify(Object.keys(vivo).sort()) === JSON.stringify(Object.keys(resp).sort());
    console.log('\n=== COMPARACAO com o blob do fluxo ===');
    console.log('envelope com as mesmas chaves:', mesmaForma ? 'sim' : 'NAO');
    console.log('series: fluxo %d · gerador %d', (vivo.dados || []).length, resp.dados.length);
    console.log('intervalo: fluxo %s · gerador %s', vivo.intervalo, resp.intervalo);
    console.log('pontos com cobertura diferente: %d', linhas.length);
    console.log('  gerador a frente em ate %d amostras · atras em ate %d', Math.max(0, piorAvanco), Math.max(0, piorAtraso));
    if (linhas.length) console.log(linhas.slice(0, 8).join('\n'));
    // ⚠️ 1 amostra de atraso e tolerada: um balde de 5 min pode fechar entre as duas leituras.
    const ok = mesmaForma && (vivo.dados || []).length === resp.dados.length && piorAtraso <= 1;
    console.log('\nVEREDITO:', ok ? 'o gerador REPRODUZ o fluxo' : 'DIVERGENTE — nao trocar ainda');
    process.exit(ok ? 0 : 1);
  }

  const json = JSON.stringify(resp);
  const n = await grava(json);
  console.log('gravado %s · %d KB', process.env.LOCAL_OUT || OUT_BLOB, Math.round(n / 1024));
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
