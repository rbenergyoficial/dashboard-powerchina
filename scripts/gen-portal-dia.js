/*
 * gen-portal-dia.js — os arquivos LEVES de cada dia fechado, para o Ao vivo do portal analisar outros periodos
 * (PROMOVER portal-dia).
 *
 * ══ POR QUE EXISTE ══════════════════════════════════════════════════════════════════════════════
 * O Ao vivo desenha do portal_vivo.json e do portal_eletrico.json, que so tem o dia de HOJE. O passado esta inteiro no
 * historico (hist/way2_AAAA-MM-DD.json, 5 min, desde 12/07/2024), mas cada dia pesa ~4 MB: pesado demais para o navegador.
 * Este gerador grava, para cada dia fechado, os mesmos dois arquivos do Ao vivo, montados pelas MESMAS libs:
 *   hist/portal_vivo_AAAA-MM-DD.json      (~10 KB no gzip)   lib/portal-vivo.js, sem a saude (que e do instante)
 *   hist/portal_eletrico_AAAA-MM-DD.json  (~85 KB no gzip)   lib/portal-eletrico.js
 * e o indice hist/portal_dias.json (os dias que existem), para o portal saber o que oferecer.
 * E o RESUMO hist/portal_resumo.json (PROMOVER portal-resumo-dias): a energia de cada dia fechado, do Complexo, do PPA, do ML e
 * de cada usina, tirada do proprio arquivo do dia. A aba Energia compara o dia escolhido com as semanas anteriores; sem o resumo
 * seriam 42 arquivos baixados a cada dia escolhido. O resumo so muda pelo arquivo do dia: dia gravado nesta rodada entra com o
 * que foi gravado, dia que o resumo ainda nao tem e lido do arquivo, dia que saiu do indice sai do resumo.
 *
 * 🔴 NADA SE GRAVA SEM PASSAR NA CONFERENCIA: cada arquivo montado e conferido contra a MESMA fonte pela referencia
 * independente dos ensaios (ensaio-portal-vivo-circuitos.js e ensaio-portal-eletrico.js). Dia que nao passa e listado e
 * fica sem arquivo — o portal diz que nao ha o dia, em vez de desenhar um dia errado.
 *
 * 🔴 O FURO DA VIRADA (bug aberto desde 15/08/2026): o snapshot hist/way2_DIA.json e regravado a cada 5 min a partir do
 * dia corrente, e a meia-noite muda de dia antes de a Way2 publicar os ultimos ~15-20 min. Todo dia do historico termina
 * com um buraco. No modo `fecha`, o dia anterior refeito pela API (LOCAL_ELET, gravado pelo gen-way2-eletrico.js com
 * DIA=ontem) substitui o snapshot SE tiver mais leituras dos 24 medidores — nunca menos.
 *
 *   MODO=precisa   escreve precisa=true|false em $GITHUB_OUTPUT: ontem ja tem os arquivos com os 24 medidores ate 24:00?
 *   MODO=fecha     ontem: fecha o furo (LOCAL_ELET) e grava os dois arquivos
 *   MODO=carga     DE..ATE (AAAA-MM-DD): grava os dois arquivos de cada dia, do historico; FORCAR=1 regrava os existentes
 * Env: DADOS_STORAGE (obrigatorio fora de LOCAL_DIR), LOCAL_DIR (le e grava numa pasta, para ensaio).
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LV = require('./lib/portal-vivo.js'), LE = require('./lib/portal-eletrico.js');
const EV = require('./ensaio-portal-vivo-circuitos.js'), EE = require('./ensaio-portal-eletrico.js');

const MEDIDORES = [6196, 6197]; for (let p = 6198; p <= 6219; p++) MEDIDORES.push(p);
const diaBRT = (off) => new Date(Date.now() - 3 * 3600e3 - off * 86400e3).toISOString().slice(0, 10);
const proxDia = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10);
const parse = (b) => JSON.parse(((b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));

// ── armazenamento: o container do Azure, ou uma pasta (LOCAL_DIR) para ensaio ───────────────────────────────────────
function armazem() {
  if (process.env.LOCAL_DIR) {
    const raiz = process.env.LOCAL_DIR, cam = (n) => path.join(raiz, n.replace(/\//g, '__'));
    return { le: async (n) => fs.existsSync(cam(n)) ? parse(fs.readFileSync(cam(n))) : null,
      grava: async (n, buf) => fs.writeFileSync(cam(n), buf),
      lista: async (pre) => fs.readdirSync(raiz).filter(f => f.startsWith(pre.replace(/\//g, '__'))).map(f => f.replace(/__/g, '/')) };
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados');
  return {
    le: async (n) => { const b = c.getBlockBlobClient(n); if (!(await b.exists())) return null; return parse(await b.downloadToBuffer()); },
    grava: async (n, buf, gz) => c.getBlockBlobClient(n).upload(buf, buf.length, { blobHTTPHeaders: Object.assign(
      { blobContentType: 'application/json', blobCacheControl: 'public, max-age=3600' }, gz ? { blobContentEncoding: 'gzip' } : {}) }),
    lista: async (pre) => { const r = []; for await (const b of c.listBlobsFlat({ prefix: pre })) r.push(b.name); return r; }
  };
}

// leituras de potencia ativa dos 24 medidores no dia (o "00:00" do dia seguinte e o 24:00 do dia)
function cobertura(elet, dia) {
  let n = 0;
  for (const s of (elet && elet.dados) || []) {
    if (s.nomeGrandeza !== 'Demat' || !MEDIDORES.includes(s.pontoId)) continue;
    for (const v of s.valores || []) {
      if (!v || v.valor == null) continue;
      const d = String(v.data).slice(0, 10), h = String(v.data).slice(11, 16);
      if (d === dia || (d === proxDia(dia) && h === '00:00')) n++;
    }
  }
  return n;
}

// monta, confere e grava os dois arquivos de um dia; devolve o resumo ou os achados
async function fazDia(A, dia, elet) {
  if (!elet || String(elet.dataInicio || '').slice(0, 10) !== dia) return { dia, erro: 'fonte ausente ou de outro dia' };
  const CIRC = LV.mapaCircuitos();
  const pv = LV.monta(elet, null), pe = LE.monta(elet, CIRC);
  if (!pv || !pe) return { dia, erro: 'dia sem leitura' };
  const a1 = EV.confere(pv, elet, CIRC).f, a2 = [];
  EE.confere(pe, elet, a2, {});
  if (a1.length || a2.length) return { dia, erro: (a1.concat(a2)).slice(0, 3).join(' | ') };
  const z = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o), 'utf8'));
  const b1 = z(pv), b2 = z(pe);
  await A.grava('hist/portal_vivo_' + dia + '.json', b1, true);
  await A.grava('hist/portal_eletrico_' + dia + '.json', b2, true);
  const fim = pe.medidores.filter(m => MEDIDORES.includes(m.pid) && m.hora === '24:00').length;
  return { dia, kb: Math.round((b1.length + b2.length) / 1024), ate: pe.hora, completos: fim, resumo: resumoDe(pv) };
}

// o resumo de um dia: a energia do dia (MWh, as duas casas do arquivo) do Complexo e de cada entidade, e quantos instantes o
// Complexo teve (o portal sabe assim que o dia tem buraco)
const ENT = ['PPA', 'ML', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
function resumoDe(pv) {
  const k = {};
  for (const e of ENT) { const x = (pv.kpis || {})[e]; k[e] = x && x.energia_mwh != null ? x.energia_mwh : null; }
  return { e: pv.energia_mwh != null ? pv.energia_mwh : null, n: pv.n || 0, k };
}

// novos: Map dia -> resumo dos dias gravados nesta rodada (o arquivo do dia mudou; o resumo antigo daquele dia nao vale mais)
async function indice(A, novos) {
  const nomes = await A.lista('hist/portal_eletrico_');
  const dias = nomes.map(n => (n.match(/portal_eletrico_(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort();
  const gerado = new Date().toISOString(), de = dias[0] || null, ate = dias[dias.length - 1] || null;
  await A.grava('hist/portal_dias.json', Buffer.from(JSON.stringify({ gerado, n: dias.length, de, ate, dias })), false);
  const ant = ((await A.le('hist/portal_resumo.json')) || {}).dias || {}, R = {}, faltam = [];
  for (const d of dias) {
    if (novos && novos.has(d)) R[d] = novos.get(d);
    else if (ant[d]) R[d] = ant[d];
    else faltam.push(d);
  }
  for (let i = 0; i < faltam.length; i += 16) {   // a primeira vez sao todos: lidos de 16 em 16
    await Promise.all(faltam.slice(i, i + 16).map(async d => { const pv = await A.le('hist/portal_vivo_' + d + '.json'); if (pv) R[d] = resumoDe(pv); }));
  }
  const o = {}; Object.keys(R).sort().forEach(d => { o[d] = R[d]; });
  await A.grava('hist/portal_resumo.json', zlib.gzipSync(Buffer.from(JSON.stringify({ gerado, n: Object.keys(o).length, de, ate, entidades: ENT, dias: o }), 'utf8')), true);
  return dias.length + ' dias; resumo com ' + Object.keys(o).length + ' (' + faltam.length + ' lidos do arquivo do dia)';
}

(async () => {
  const modo = process.env.MODO || '';
  const A = armazem();
  if (modo === 'precisa') {
    const d = diaBRT(1), pe = await A.le('hist/portal_eletrico_' + d + '.json');
    const ok = pe && pe.medidores && pe.medidores.filter(m => MEDIDORES.includes(m.pid) && m.hora === '24:00').length === MEDIDORES.length;
    console.log(d + ': ' + (ok ? 'ja fechado (os 24 medidores ate 24:00)' : 'precisa fechar'));
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'precisa=' + (ok ? 'false' : 'true') + '\n');
    return;
  }
  if (modo === 'fecha') {
    const dia = diaBRT(1);
    let H = await A.le('hist/way2_' + dia + '.json');
    const API = process.env.LOCAL_ELET && fs.existsSync(process.env.LOCAL_ELET) ? parse(fs.readFileSync(process.env.LOCAL_ELET)) : null;
    const cH = cobertura(H, dia), cA = API && String(API.dataInicio || '').slice(0, 10) === dia ? cobertura(API, dia) : -1;
    console.log(dia + ': historico ' + cH + ' leituras dos 24 medidores · API ' + (cA < 0 ? 'ausente' : cA));
    if (cA > cH) {   // o furo da virada: o dia refeito pela API tem mais — so substitui com MAIS, nunca com menos
      await A.grava('hist/way2_' + dia + '.json', Buffer.from(JSON.stringify(API), 'utf8'), false);
      console.log('  historico regravado com a API: +' + (cA - cH) + ' leituras (o fim do dia que o snapshot perdeu)');
      H = API;
    }
    const r = await fazDia(A, dia, H);
    console.log('  ' + JSON.stringify(Object.assign({}, r, { resumo: undefined })));
    console.log('indice: ' + (await indice(A, r.erro ? null : new Map([[dia, r.resumo]]))));
    if (r.erro) process.exit(1);
    return;
  }
  if (modo === 'carga') {
    const de = process.env.DE, ate = process.env.ATE || diaBRT(1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(de || '')) throw new Error('DE=AAAA-MM-DD obrigatorio');
    const forcar = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
    const ja = new Set(forcar ? [] : (await A.lista('hist/portal_eletrico_')).map(n => (n.match(/(\d{4}-\d{2}-\d{2})/) || [])[1]));
    let feitos = 0, pulados = 0; const falhas = [], novos = new Map();
    for (let d = de; d <= ate; d = proxDia(d)) {
      if (ja.has(d)) { pulados++; continue; }
      let r;
      try { r = await fazDia(A, d, await A.le('hist/way2_' + d + '.json')); } catch (e) { r = { dia: d, erro: e.message }; }
      if (r.erro) falhas.push(r); else { feitos++; novos.set(d, r.resumo); }
      if ((feitos + falhas.length) % 30 === 0) console.log('  ... ' + d + ' · ' + feitos + ' gravados, ' + falhas.length + ' sem arquivo');
    }
    console.log('carga ' + de + ' a ' + ate + ': ' + feitos + ' dia(s) gravado(s), ' + pulados + ' ja existiam, ' + falhas.length + ' sem arquivo');
    falhas.slice(0, 40).forEach(f => console.log('  sem arquivo ' + f.dia + ': ' + f.erro));
    console.log('indice: ' + (await indice(A, novos)));
    return;
  }
  console.error('MODO=precisa|fecha|carga'); process.exit(2);
})().catch(e => { console.error('ERRO: ' + e.message); process.exit(1); });
