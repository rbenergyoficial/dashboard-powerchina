'use strict';
/*
 * alerta-must.js — e-mail de ultrapassagem do MUST no quarto de hora (PROMOVER pa-alerta).
 *
 * Substitui o e-mail "ALERTA MUST — Ultrapassagem de Demanda Contratada" do fluxo "Way2 MUST Intradia" do Power
 * Automate, que sai com o Premium em 09/11/2026 (decisao D2 do humano, 18/10/2026: "troca pelo quarto de hora").
 *
 * 🔴 O FLUXO NUNCA AVISOU. Medido em 18/10/2026 nas 300 ultimas execucoes (15/10 a 18/10): o passo do e-mail foi
 *    PULADO em todas. O filtro dele compara o rotulo da medicao, em hora local sem fuso, com `utcNow() - 30 min`:
 *    o rotulo fica 3 h atras e nunca entra na janela. E nos 91 dias do must_15min.json nao houve quarto de hora acima
 *    de 100% do contratado em parque nenhum. Ou seja: nada se perdeu ate hoje, e o substituto e o primeiro que avisa.
 *
 * O QUE CONTA: um intervalo de 15 min (a integralizacao contratual, a mesma que o ONS afere) em que a demanda de
 * GERACAO de um parque passa de 100% do MUST contratado daquele ponto no contrato de uso do sistema de transmissao.
 * Estritamente acima: igual ao contratado nao e ultrapassagem. O limiar vem do proprio blob (`contratos`), escrito
 * pelo gen-must-intra; o Complexo e soma, nao tem contrato proprio, e fica fora (o fluxo tambem so via ponto).
 *
 * O DIA e o do inicio do intervalo em BRT: o rotulo e o FIM do intervalo, e o balde das 00:00 pertence ao dia
 * anterior (a mesma convencao do gen-must-intra).
 *
 * DEDUP: um evento por parque por dia (`chave`), com `soSeNova` — a issue aberta e a memoria. Intervalos novos do
 * mesmo parque no mesmo dia, depois do primeiro aviso, nao geram outro e-mail. Janela: hoje e ontem (o dado de
 * ontem ainda pode chegar atrasado).
 *
 * 🔴 CANAL AUSENTE E DEFEITO: falta qualquer peca do e-mail (MAIL_PARA, MAIL_DE, AZ_MAIL_*) ou o GITHUB_TOKEN da
 *    memoria do dedup -> exit 1 antes de julgar. O destinatario e o mesmo do fluxo, e vem da variavel `MAIL_PARA_MUST`
 *    do repositorio (nunca escrito aqui: o repo e publico). Depois de julgar, cada evento tem de ter sido ENVIADO ou
 *    ja estar aberto (dedup); e-mail '-' ou FALHOU, ou issue FALHOU (sem memoria o aviso se repetiria a cada 15 min),
 *    derrubam a rodada.
 * 🔴 VACUIDADE E DEFEITO: parque M1..M9 sem contrato > 0, janela de hoje e ontem sem nenhuma linha julgada (gerador
 *    parado), ou `ms` que nao bate com o `t` da linha (convencao do gerador mudou) -> exit 1. "0 eventos" so vale com
 *    intervalos julgados.
 *
 * Env: MUST_ARQ (arquivo local, para o ensaio) · BLOB_BASE · MAIL_* e AZ_MAIL_* (lib-alerta) · AGORA_MS (ensaio)
 */
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const zlib = require('zlib');
const fs = require('fs');

const BASE = process.env.BLOB_BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const PASSO_MIN = 15;
const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const PECAS = ['MAIL_PARA', 'MAIL_DE', 'AZ_MAIL_TENANT_ID', 'AZ_MAIL_CLIENT_ID'];
const BRT_MS = 3 * 3600 * 1000;

const diaBRT = (ms) => new Date(ms - BRT_MS).toISOString().slice(0, 10);
const dm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
const hora = (t) => String(t).slice(11, 16);
const num = (v, c) => v.toFixed(c).replace('.', ',');

/** Confere a forma do blob: os 9 parques com contrato e o `ms` igual ao `t` de cada linha. Estoura no primeiro erro. */
function confere(j) {
  const C = j.contratos || {};
  const sem = PARQUES.filter((p) => !(C[p] > 0) || !(j.parques || []).includes(p));
  if (sem.length) throw new Error('must_15min.json sem contrato ou sem coluna para ' + sem.join(', '));
  for (const l of j.serie || []) {
    if (Date.parse(l.t) !== l.ms) throw new Error('must_15min.json: ms ' + l.ms + ' nao bate com t ' + l.t + ' (convencao do gerador mudou?)');
  }
}

/** Agrupa por dia (BRT, inicio do intervalo) e parque os intervalos acima do contratado, nos dias pedidos.
 *  `julgados` conta as linhas da janela: zero quer dizer que nada foi olhado. */
function ultrapassagens(j, dias) {
  const C = j.contratos || {};
  const parques = PARQUES.filter((p) => C[p] > 0);
  const ev = new Map();
  let julgados = 0;
  for (const l of j.serie || []) {
    const dia = diaBRT(l.ms - PASSO_MIN * 60000);
    if (!dias.includes(dia)) continue;
    julgados++;
    for (const p of parques) {
      const v = l[p];
      if (typeof v !== 'number' || !isFinite(v) || !(v > C[p])) continue;
      const k = dia + '|' + p;
      const e = ev.get(k) || { dia, parque: p, contrato: C[p], n: 0, pico: -Infinity, t_pico: null, t_primeiro: l.t };
      e.n++;
      if (v > e.pico) { e.pico = v; e.t_pico = l.t; }
      ev.set(k, e);
    }
  }
  const lista = [...ev.values()].sort((a, b) => (a.dia + a.parque).localeCompare(b.dia + b.parque));
  lista.julgados = julgados;
  return lista;
}

function acaoDe(e) {
  const pct = 100 * e.pico / e.contrato;
  return {
    tipo: 'must-ultrapassagem',
    chave: 'must-ultrapassagem-' + e.dia + '-' + e.parque,
    titulo: 'MUST: ' + e.parque + ' acima do contratado em ' + dm(e.dia),
    assunto: '⚠️ MUST · ' + e.parque + ' acima do contratado em ' + dm(e.dia),
    soSeNova: true,
    corpo: '<p><b>' + e.parque + '</b> passou do MUST contratado (' + num(e.contrato, 2) + ' MW) em <b>' + dm(e.dia)
      + '</b>: ' + e.n + (e.n === 1 ? ' intervalo' : ' intervalos') + ' de 15 min acima de 100%, o primeiro terminado às '
      + hora(e.t_primeiro) + '.</p><p>Pico: <b>' + num(e.pico, 3) + ' MW</b> (' + num(pct, 1) + '% do contratado), no '
      + 'intervalo terminado às ' + hora(e.t_pico) + '.</p><p>Limiar: 100% do MUST do contrato de uso do sistema de '
      + 'transmissão, apurado na integralização de 15 min. Demanda de geração no ponto de conexão, medição de '
      + 'faturamento. Novos intervalos do mesmo parque no mesmo dia não geram outro aviso.</p>',
  };
}

// Fase 2: o transporte e o da lib-le-dados. Como antes, nada aqui e "nao existe": o 404 tambem estoura (o alerta nao roda sem o
// must_15min.json), e o erro da lib (403, 409, 5xx, rede, timeout) sai com o nome do blob.
async function baixa(nome) {
  let r;
  try { r = await LD.pede(BASE + nome, { 'Accept-Encoding': 'gzip' }); } catch (e) { throw new Error(nome + ': ' + e.message); }
  if (r.status !== 200) throw new Error(nome + ': HTTP ' + r.status);
  let x = r.buf;
  if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
  return JSON.parse(x.toString('utf8'));
}

async function main({ alerta = require('./lib-alerta').alerta, agora = Number(process.env.AGORA_MS) || Date.now() } = {}) {
  const faltam = PECAS.filter((k) => !(process.env[k] || '').trim());
  if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()) faltam.push('GITHUB_TOKEN');
  if (faltam.length) {
    console.error('::error::alerta-must: sem ' + faltam.join(', ') + ' (o destinatario e a variavel MAIL_PARA_MUST do repositorio) — o aviso nao teria por onde ir');
    return 1;
  }
  const j = process.env.MUST_ARQ ? JSON.parse(fs.readFileSync(process.env.MUST_ARQ, 'utf8')) : await baixa('must_15min.json');
  if (j.resolucao_min !== PASSO_MIN) throw new Error('must_15min.json com resolucao ' + j.resolucao_min + ' min, esperado ' + PASSO_MIN);
  const dias = [diaBRT(agora), diaBRT(agora - 86400000)];
  confere(j);
  const ev = ultrapassagens(j, dias);
  console.log('alerta-must: ' + ev.length + ' evento(s) em ' + dias.join(' e ') + ' · ' + ev.julgados + ' intervalos julgados de '
    + (j.serie || []).length + ' linhas, gravado ' + j.gerado_em);
  if (!ev.julgados) { console.error('::error::alerta-must: nenhum intervalo de ' + dias.join(' ou ') + ' no blob — gerador parado?'); return 1; }
  let falhou = 0;
  for (const e of ev) {
    const out = await alerta(acaoDe(e));
    const chegou = /^enviado/.test(out.email || '') || /^ja aberta #\d/.test(out.issue || '');
    if (!chegou || /^FALHOU/.test(out.issue || '')) { falhou++; console.error('::error::alerta-must: ' + e.parque + ' ' + e.dia + ' · email: ' + out.email + ' · issue: ' + out.issue); }
  }
  return falhou ? 1 : 0;
}

module.exports = { ultrapassagens, acaoDe, diaBRT, confere, main };

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
