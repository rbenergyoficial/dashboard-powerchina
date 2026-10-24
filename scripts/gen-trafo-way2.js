/*
 * gen-trafo-way2.js — os dois transformadores da SE Mauriti, lado de 230 kV pelo MEDIDOR DE FATURAMENTO -> dados/trafo_*.json
 *   (lote fonte-trafo-way2, 19/10/2026)
 *
 * Saidas (o MESMO nome e o MESMO contrato de campos que as telas leem, mais o passo de 15 min):
 *   trafo_5min.json (30 dias) · trafo_15min.json (90) · trafo_30min.json (180) · trafo_60min.json (365) · trafo_diario.json (desde a
 *   energizacao). Lado de 230 kV (corrente, tensao, P, Q, S, FP, carregamento, desequilibrio): medidor, 5 min, integralizado.
 *   Temperaturas, comutador e os dois lados de 34,5 kV: da copia do supervisorio (`trafo_scada_<res>.json`, gen-trafo.js), em campo
 *   proprio e declarado (`fontes_por_campo`, `supervisorio_ate`). A regra inteira (leitura, integralizacao, mescla, juncao, guardas,
 *   meta) mora na lib-trafo-way2.js; aqui so se le e se grava.
 *
 * Leitura: o historico do medidor `hist/way2_<dia>.json` (modo incremental: so os dias que a lib manda reler, pela leitura
 *   condicional da lib-le-blob, com a copia do actions/cache; modo completo: o historico inteiro, uma vez, sem copia em disco — ~830
 *   dias de ~4 MB). As saidas anteriores e a copia do supervisorio pela lib-le-dados (so o 404 e ausencia).
 *
 * Env: DADOS_STORAGE · FORCAR=1 (modo completo)
 *      LOCAL_HIST_DIR (le way2_<dia>.json de uma pasta) · LOCAL_IN_DIR (le as saidas anteriores e as copias de uma pasta)
 *      LOCAL_OUT_DIR (grava na pasta, nada publicado) · HOJE=AAAA-MM-DD (so para ensaio)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const T = require('./lib-trafo-way2.js');

const BASE = process.env.DADOS_BASE_PUB || 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = 'dados';
const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
const HOJE = process.env.HOJE || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const RES = [5, 15, 30, 60];
const nomeRes = (r) => (r === 'dia' ? 'trafo_diario.json' : 'trafo_' + r + 'min.json');
const nomeSup = (r) => (r === 'dia' ? 'trafo_scada_diario.json' : 'trafo_scada_' + r + 'min.json');

const desembrulha = (buf) => {
  if (buf == null) return null;
  const b = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  return JSON.parse(b.toString('utf8').replace(/^﻿/, ''));
};
async function leBlob(nome) {
  if (process.env.LOCAL_IN_DIR) {
    const f = path.join(process.env.LOCAL_IN_DIR, nome);
    return fs.existsSync(f) ? desembrulha(fs.readFileSync(f)) : null;
  }
  // trafo-um-escritor (23/10/2026): a copia do supervisorio muda uma vez por dia e e lida de 15 em 15 min: vai pela leitura
  // condicional da lib-le-blob (304 pela copia em disco). As saidas anteriores mudam toda rodada: leitura normal
  if (/^trafo_scada_/.test(nome)) return desembrulha(await require('./lib-le-blob.js').bytes(BASE + nome, { 'Accept-Encoding': 'gzip' }));
  return desembrulha(await require('./lib-le-dados.js').bytes(BASE + nome));
}
async function leHist(dia, completo) {
  if (process.env.LOCAL_HIST_DIR) {
    const f = path.join(process.env.LOCAL_HIST_DIR, 'way2_' + dia + '.json');
    return fs.existsSync(f) ? desembrulha(fs.readFileSync(f)) : null;
  }
  const url = BASE + 'hist/way2_' + dia + '.json';
  // 💰 no modo completo nada vai para a copia em disco (seriam ~3 GB no actions/cache); no incremental, a leitura condicional
  return desembrulha(completo ? await require('./lib-le-dados.js').bytes(url) : await require('./lib-le-blob.js').bytes(url, { 'Accept-Encoding': 'gzip' }));
}
async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  const up = await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  if (OUT_CONTAINER === 'dados') require('./lib-le-dados.js').lembra(nome, up.etag, gz);   // o ensaio de produto do mesmo job le pela copia (304)
  return gz.length;
}

(async () => {
  // ---- o que ja esta publicado, e a copia do supervisorio --------------------------------------------------------------
  const anteriores = {}, sup = {};
  for (const r of [...RES, 'dia']) { anteriores[r] = await leBlob(nomeRes(r)); sup[r] = await leBlob(nomeSup(r)); }
  // a copia do supervisorio nao existe (primeira rodada depois do lote, ou o gen-trafo falhou antes de gravar): vale o anterior.
  // SEM a marca, ele E o supervisorio (era o produto inteiro dele); COM a marca, as grandezas do supervisorio dele sao as da ultima
  // copia lida. A juncao so leva os campos DECLARADOS do supervisorio (CAMPOS_SUP_*): o lado de 230 kV dele nunca entra.
  for (const r of [...RES, 'dia']) {
    if (!sup[r] && anteriores[r] && r !== 15) { sup[r] = anteriores[r]; console.log('  ⚠️ copia do supervisorio ' + nomeSup(r) + ' ausente: uso as grandezas do supervisorio do ' + nomeRes(r) + ' anterior ('
      + (anteriores[r].esquema === T.ESQUEMA ? 'esquema do medidor: a ultima copia lida' : 'esquema do supervisorio') + ')'); }
    if (!sup[r] && r !== 15) console.log('  ⚠️ sem copia do supervisorio para ' + nomeRes(r) + ': as temperaturas ficam fora deste passo');
  }
  const m = T.modo(anteriores, FORCAR);
  const lista = T.diasALer(m, anteriores.dia, HOJE);
  console.log('  modo ' + m + ' · hoje ' + HOJE + ' · ' + lista.length + ' dia(s) a ler (' + lista[0] + ' a ' + lista[lista.length - 1] + ')');

  // ---- le o medidor, dia a dia ---------------------------------------------------------------------------------------
  const porDia = new Map(), ausentes = [], est = { lidos: 0, nulos: 0, qualidade: 0, fora_do_dia: 0 };
  const corte = (r) => T.diaMais(HOJE, -(T.JANELAS[r] + 2));
  for (const dia of lista) {
    const h = await leHist(dia, m === 'completo');
    if (!h) { ausentes.push(dia); continue; }
    const { mapa, est: e } = T.leDia(h, dia);
    for (const k of Object.keys(est)) est[k] += e[k] || 0;
    if (!mapa.size) continue;
    const o = { mapa: null, energizado: T.energizado(mapa) };
    for (const r of RES) if (dia >= corte(r)) o['r' + r] = r === 5 ? T.cinco(mapa) : T.integra(mapa, r);
    if (dia < HOJE) o.dia = T.diario(dia, mapa);
    if (dia >= T.diaMais(HOJE, -T.REFRESH_DIAS - 1)) o.mapa = mapa;   // a guarda de fisica julga os dias recentes (no completo, tambem)
    porDia.set(dia, o);
  }
  console.log('  medidor: ' + est.lidos + ' valor(es) lidos · ' + est.nulos + ' nulos · ' + est.qualidade + ' com qualidade diferente de 0 · '
    + est.fora_do_dia + ' fora do dia' + (ausentes.length ? ' · sem arquivo: ' + (ausentes.length > 8 ? ausentes.length + ' dia(s), ' + ausentes[0] + ' a ' + ausentes[ausentes.length - 1] : ausentes.join(' ')) : ''));
  if (!porDia.size) throw new Error('nenhum dia do medidor lido de ' + lista.length + ' pedido(s)');
  if (process.env.LOCAL_HIST_DIR == null) try { require('./lib-le-blob.js').resumo(); } catch (e) { /* sem lib */ }

  // ---- guardas sobre o que foi lido nesta rodada ------------------------------------------------------------------------
  const mapas = [...porDia.values()].map((o) => o.mapa).filter(Boolean);
  const fisica = T.confereFisica(mapas);
  for (const l of fisica) console.log('  ' + l);

  // ---- monta cada passo: o anterior (so campos do medidor, dias nao relidos) + o lido; depois a juncao do supervisorio ------
  const relidos = new Set(porDia.keys());
  const supAte = (r) => {
    const campos = r === 'dia' ? T.CAMPOS_SUP_DIA : T.CAMPOS_SUP_INTERVALO;
    const S = ((sup[r] && sup[r].serie) || []).filter((x) => T.TRAFOS.some((t) => campos.some((c) => x[t + '_' + c] != null)));
    return S.length ? (r === 'dia' ? S[S.length - 1].dia : T.iso(S[S.length - 1].ms)) : null;
  };
  const geradoEm = new Date().toISOString();
  let parGuarda = null;
  const saidas = [], pendentes = [];   // 🔴 nada se grava antes de todas as guardas (a da paridade e a ultima): os cinco vao juntos no fim
  let ultimoMs = null;
  const novas5 = [].concat(...[...porDia.values()].map((o) => o.r5 || []));
  for (const r of novas5) ultimoMs = ultimoMs == null || r.ms > ultimoMs ? r.ms : ultimoMs;
  const antMs = ((anteriores[5] && anteriores[5].esquema === T.ESQUEMA && anteriores[5].serie) || []).map((x) => x.ms);
  if (m === 'incremental' && antMs.length) ultimoMs = Math.max(ultimoMs || 0, antMs[antMs.length - 1]);
  if (ultimoMs == null) throw new Error('nenhum intervalo de 5 min do medidor nesta rodada');

  for (const r of RES) {
    const ant = m === 'incremental' ? anteriores[r].serie : [];
    const novas = [].concat(...[...porDia.values()].map((o) => o['r' + r] || []));
    let linhas = T.mescla(ant, novas, relidos, T.CAMPOS_INTERVALO, ['ms', 't'], (x) => T.diaDe(x.ms));
    const ini = ultimoMs - (T.JANELAS[r] - 1) * 864e5;
    linhas = linhas.filter((x) => x.ms >= Math.floor(ini / (r * 60e3)) * (r * 60e3));
    let juntas = 0;
    const semSup = r === 15 || !sup[r];
    if (!semSup) {
      const j = T.junta(linhas, (sup[r].serie || []).filter((x) => x.ms >= linhas[0].ms), T.CAMPOS_SUP_INTERVALO, 'ms', (s) => ({ ms: s.ms, t: T.iso(s.ms) }));
      linhas = j.linhas; juntas = j.juntas;
    }
    const corpo = Object.assign(T.meta({ gerado_em: geradoEm, semSup, supAte: semSup ? null : supAte(r), medAte: T.iso(ultimoMs),
      desde: null, metaSup: semSup ? (sup.dia || {}) : sup[r] }), { resolucao_min: r,
      janela_dias: new Set(linhas.map((x) => T.diaDe(x.ms))).size, janela_dias_alvo: T.JANELAS[r], serie: linhas });
    pendentes.push([nomeRes(r), corpo, nomeRes(r) + ': ' + linhas.length + ' linhas (' + linhas[0].t + ' a ' + linhas[linhas.length - 1].t + ') · ' + juntas
      + ' com o supervisorio']);
  }

  // ---- o dia ----------------------------------------------------------------------------------------------------------
  {
    const ant = m === 'incremental' ? anteriores.dia.serie : [];
    const novas = [...porDia.entries()].filter(([, o]) => o.dia).map(([, o]) => o.dia);
    let linhas = T.mescla(ant, novas, relidos, T.CAMPOS_DIA, ['dia', 'ms', 'n'], (x) => x.dia);
    // desde a energizacao: o historico comeca antes, com o trafo desenergizado (tudo zero). No incremental o comeco ja esta no anterior
    let desde = m === 'incremental' && ant.length ? ant[0].dia : null;
    if (m === 'completo') { const e = [...porDia.entries()].find(([d, o]) => o.energizado && d < HOJE); desde = e ? e[0] : null; }
    if (!desde) throw new Error('nenhum dia com o barramento de 230 kV energizado');
    linhas = linhas.filter((x) => x.dia >= desde);
    const par = T.confereParidade(linhas, sup.dia && sup.dia.serie);
    parGuarda = par;
    for (const l of par.log) console.log('  ' + l);
    const j = sup.dia ? T.junta(linhas, sup.dia.serie.filter((x) => x.dia >= desde), T.CAMPOS_SUP_DIA, 'dia', (s) => ({ dia: s.dia, ms: s.ms, n: 0 })) : { linhas, juntas: 0 };
    linhas = j.linhas;
    const incompletos = linhas.filter((x) => x.n > 0 && x.n < 288).length;
    const corpo = Object.assign(T.meta({ gerado_em: geradoEm, dia: true, semSup: !sup.dia, supAte: sup.dia ? supAte('dia') : null,
      medAte: T.iso(ultimoMs), desde, metaSup: sup.dia }), { resolucao: 'dia', paridade_supervisorio: par.out,
      dias_incompletos: incompletos, janela_dias: linhas.length, serie: linhas });
    pendentes.push([nomeRes('dia'), corpo, nomeRes('dia') + ': ' + linhas.length + ' dias (' + linhas[0].dia + ' a ' + linhas[linhas.length - 1].dia + ') · '
      + incompletos + ' com menos de 288 intervalos · ' + j.juntas + ' com o supervisorio']);
  }
  // a janela da guarda de fisica (os dias relidos com o mapa guardado) e os dias dela sem arquivo do medidor: o --produto diz o porque
  const janelaFis = [...porDia.entries()].filter(([, o]) => o.mapa).map(([d]) => d);
  const desdeFis = T.diaMais(HOJE, -T.REFRESH_DIAS - 1);
  const guardas = { fisica: Object.assign({}, fisica.veredito, { janela: janelaFis, sem_arquivo: ausentes.filter((d) => d >= desdeFis) }), paridade: { dias: parGuarda.out.dias, correlacao: parGuarda.out.correlacao, razoes: parGuarda.out.razoes } };
  for (const [nome, corpo, txt] of pendentes) { corpo.guardas = guardas; const b = await grava(nome, corpo); saidas.push(txt + ' · ' + Math.round(b / 1024) + ' KB'); }
  for (const s of saidas) console.log('  ' + s);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
