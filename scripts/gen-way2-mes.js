'use strict';
/*
 * gen-way2-mes.js — energia líquida do mês (corrente e anterior) e demanda do mês por usina, direto da API da Way2
 * (PROMOVER pa-way2-mes-sombra, depois pa-way2-mes).
 *
 * Substitui o fluxo "Way2 → Azure Blob Sync" do Power Automate (10 min), que sai com o Premium em 09/11/2026. Faz as MESMAS
 * três chamadas do fluxo, com os mesmos parâmetros, e grava o corpo da resposta como veio (o fluxo também gravava o corpo cru,
 * com o BOM do começo):
 *   way2_energia_mes.json      EneatLiquida · UmDia · EsteMes   · pontos de energia das 9 usinas
 *   way2_energia_antmes.json   EneatLiquida · UmDia · MesPassado · idem
 *   way2_must.json             Demat        · UmDia · EsteMes   · pontos de MUST das 9 usinas
 * Leitores: gen-executivo (líquida do mês corrente), lib-guarda-liquida, ensaio-liquidada-produto, gen-must.
 *
 * DOIS MODOS
 *   SOMBRA=1  não grava nada: lê o blob do fluxo e compara, ponto × dia, valor e qualidade. A diferença aceita é a de um dia
 *             que ainda pode mudar entre as duas leituras (hoje e ontem, em BRT; no dia 1º, ontem é o último dia do mês
 *             anterior, e vale também para o `antmes`), e ela é NOMEADA no log.
 *             Diferença em dia fechado, ponto ausente, dia ausente ou forma diferente -> exit 1.
 *   (padrão)  grava os três blobs, depois da guarda de forma.
 *
 * 🔴 GUARDA DE FORMA, nos dois modos: a resposta tem `dados` com UM item por ponto pedido, cada um com `valores` em lista. Corpo
 *    de erro, lista vazia ou ponto faltando NUNCA vira blob (o executivo leria um mês zerado). Falhou a guarda -> exit 1 e o blob
 *    anterior fica.
 *
 * Env: WAY2_TOKEN · DADOS_STORAGE (modo padrão) · SOMBRA=1 · BLOB_BASE (leitura pública)
 */
const https = require('https');
const zlib = require('zlib');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const ENERGIA = '6368,6369,6373,6374,6375,6376,6215,6378,6219';
const MUST = '6380,6381,6382,6383,6384,6385,6386,6387,6388';
const RESTO = '&contextodasdatas=ConsiderarMesCheio&intervalo=UmDia&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
const CHAMADAS = [
  { blob: 'way2_energia_mes.json', ids: ENERGIA, q: 'ids=' + ENERGIA + '&grandezas=EneatLiquida' + RESTO + '&medicao-temporelativo=EsteMes' },
  { blob: 'way2_energia_antmes.json', ids: ENERGIA, q: 'ids=' + ENERGIA + '&grandezas=EneatLiquida' + RESTO + '&medicao-temporelativo=MesPassado' },
  { blob: 'way2_must.json', ids: MUST, q: 'ids=' + MUST + '&grandezas=Demat' + RESTO + '&medicao-temporelativo=EsteMes' },
];
const BASE = process.env.BLOB_BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const semBom = (t) => t.replace(/^﻿/, '');

/** Confere a forma; devolve o objeto ou estoura dizendo o que falta. */
function confere(texto, ids, nome) {
  let j;
  try { j = JSON.parse(semBom(texto)); } catch (e) { throw new Error(nome + ': resposta nao e JSON (' + e.message + ')'); }
  if (!j || !Array.isArray(j.dados)) throw new Error(nome + ': resposta sem a lista `dados`');
  const pedidos = ids.split(',').map(Number);
  const tem = new Set(j.dados.map((d) => d.pontoId));
  const faltam = pedidos.filter((p) => !tem.has(p));
  if (faltam.length || j.dados.length !== pedidos.length) throw new Error(nome + ': ' + j.dados.length + ' pontos, faltam ' + (faltam.join(',') || 'nenhum') + ' (esperados ' + pedidos.length + ')');
  for (const d of j.dados) if (!Array.isArray(d.valores) || !d.valores.length) throw new Error(nome + ': ponto ' + d.pontoId + ' sem valores');
  return j;
}

/** Ponto × dia -> "valor|qualidade". */
function mapa(j) {
  const m = new Map();
  for (const d of j.dados) for (const v of d.valores) m.set(d.pontoId + ' ' + String(v.data).slice(0, 10), (v.valor == null ? '-' : v.valor) + '|' + v.qualidade);
  return m;
}

/**
 * Compara a leitura nova com o blob do fluxo. `vivos` = dias (AAAA-MM-DD) que ainda podem mudar entre duas leituras.
 * Devolve { iguais, vivos: [...], fechados: [...], ausentes: [...] } — `fechados` e `ausentes` reprovam.
 */
function compara(novo, fluxo, vivos) {
  const a = mapa(novo), b = mapa(fluxo);
  const out = { iguais: 0, vivos: [], fechados: [], ausentes: [] };
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (!a.has(k) || !b.has(k)) { out.ausentes.push(k + (a.has(k) ? ' (so na nova)' : ' (so no fluxo)')); continue; }
    if (a.get(k) === b.get(k)) { out.iguais++; continue; }
    (vivos.includes(k.split(' ')[1]) ? out.vivos : out.fechados).push(k + ': nova ' + a.get(k) + ' · fluxo ' + b.get(k));
  }
  return out;
}

function diaBRT(ms) { return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 10); }

function apiTexto(q, token, timeout = 60000) {
  return new Promise((ok, ko) => {
    const r = https.get({ ...API, path: API.path + '?' + q, headers: { 'Pim-Auth': token }, timeout }, (res) => {
      const b = []; res.on('data', (c) => b.push(c));
      res.on('end', () => (res.statusCode === 200 ? ok(Buffer.concat(b).toString('utf8')) : ko(new Error('Way2 HTTP ' + res.statusCode))));
    });
    r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); r.on('error', ko);
  });
}
async function apiComRetry(q, token) {
  for (let t = 1; ; t++) {
    try { return await apiTexto(q, token); } catch (e) {
      if (t >= 4) throw e;
      await sleep(/429/.test(e.message) ? 15000 * t : 2000 * t);
    }
  }
}

function lePublico(nome) {
  return new Promise((ok, ko) => {
    https.get(BASE + nome + '?t=' + Date.now(), { headers: { 'Accept-Encoding': 'gzip' } }, (r) => {
      const b = []; r.on('data', (c) => b.push(c));
      r.on('end', () => {
        if (r.statusCode !== 200) return ko(new Error(nome + ': HTTP ' + r.statusCode));
        let x = Buffer.concat(b); if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
        ok({ texto: x.toString('utf8'), modificado: r.headers['last-modified'] });
      });
    }).on('error', ko);
  });
}

async function main({ api = apiComRetry, le = lePublico, grava, agora = Date.now(), sombra = process.env.SOMBRA === '1' } = {}) {
  const token = (process.env.WAY2_TOKEN || '').trim();
  if (!token && api === apiComRetry) throw new Error('WAY2_TOKEN ausente');
  const vivos = [diaBRT(agora), diaBRT(agora - 86400000)];
  let reprovou = 0;
  for (const c of CHAMADAS) {
    const texto = await api(c.q, token);
    const j = confere(texto, c.ids, c.blob);
    const dias = new Set(j.dados.flatMap((d) => d.valores.filter((v) => v.valor != null).map((v) => String(v.data).slice(0, 10))));
    if (sombra) {
      const f = await le(c.blob);
      const r = compara(j, confere(f.texto, c.ids, c.blob + ' (fluxo)'), vivos);
      const ruim = r.fechados.length + r.ausentes.length;
      console.log((ruim ? '✗ ' : '✓ ') + c.blob + ': ' + r.iguais + ' ponto×dia iguais · ' + r.vivos.length + ' em dia vivo (' + vivos.join(', ')
        + ') · ' + r.fechados.length + ' em dia fechado · ' + r.ausentes.length + ' ausentes · fluxo gravou ' + f.modificado);
      r.vivos.slice(0, 6).forEach((x) => console.log('    vivo   ' + x));
      r.fechados.concat(r.ausentes).slice(0, 12).forEach((x) => console.log('    ::error::' + c.blob + ' ' + x));
      if (ruim) reprovou++;
    } else {
      await grava(c.blob, texto);
      console.log('✓ ' + c.blob + ': ' + j.dados.length + ' pontos, ' + dias.size + ' dias com valor, ' + Buffer.byteLength(texto) + ' B');
    }
  }
  return reprovou ? 1 : 0;
}

async function gravaBlob(nome, texto) {
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE ausente');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados').getBlockBlobClient(nome);
  await c.upload(texto, Buffer.byteLength(texto), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

module.exports = { CHAMADAS, confere, compara, mapa, diaBRT, main };

if (require.main === module) {
  main({ grava: gravaBlob }).then((c) => process.exit(c)).catch((e) => { console.error('::error::gen-way2-mes: ' + e.message); process.exit(1); });
}
