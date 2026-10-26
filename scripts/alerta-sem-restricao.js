'use strict';
/*
 * alerta-sem-restricao.js — aviso do dia COMPLETO sem nenhuma limitação do operador (PROMOVER janela-restricao, 26/10/2026).
 *
 * Pedido do humano: "em fim de semana e feriado sempre há restrição; em dia útil acontece de forma pontual". Quando o arquivo de
 * restrição do conjunto traz um dia completo (as 48 meias horas) sem nenhum intervalo com limitação, sai um aviso pela lib-alerta
 * (e-mail da Central de Alertas e a issue, que é o registro e o dedup): fim de semana e feriado como incomum ("conferir com a mesa e o
 * ONS"), dia útil como pontual ("conferir"). A regra (o dia completo, o calendário e o texto) mora na lib-janela-conjunto.
 *
 * O aviso vale do dia do lote em diante (DESDE), nunca retroativo, e só para os dias dos últimos RECENTE_D. Um por dia: o título fixo
 * por dia e o `soSeNova` fazem a issue aberta ser a memória, então a rodada de hora em hora não repete o aviso. O e-mail que não sai
 * (ou o arquivo que não se lê) pinta o passo de VERMELHO; o passo é o último antes dos caches e não barra nada (revisor-workflow).
 *
 * Env: DADOS_SAS (leitura do `dados`); GH_TOKEN (a issue); AZ_MAIL_TENANT_ID, AZ_MAIL_CLIENT_ID, MAIL_DE, MAIL_PARA e o OIDC do job (o
 * e-mail). AGORA_DIA (só ensaio) troca o dia de hoje.
 */
const zlib = require('zlib');
const JC = require('./lib-janela-conjunto.js');

const DESDE = '2026-10-26';   // o dia do lote: o aviso nunca é retroativo
const RECENTE_D = 3;          // só os dias dos últimos 3 (o consolidado fecha D-1): a issue fechada de um dia velho não reenvia o e-mail
const URL = 'https://rbenergydata.blob.core.windows.net/dados/ons_restricao_all.json';

async function leConjunto() {
  const LD = require('./lib-le-dados');
  const x = await LD.pede(URL);
  if (x.status !== 200) throw new Error(x.status + ' ons_restricao_all.json');
  let b = x.buf; if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return JSON.parse(b.toString('utf8').replace(/^﻿/, ''));
}

// 🔴 ENTREGUE é o E-MAIL que saiu (a issue é o registro e o dedup, não avisa ninguém: lib-alerta). Ou a issue do dia já aberta, que
//    quer dizer que o dia já foi tratado numa rodada anterior. E-mail que falha ou canal incompleto pinta o passo de vermelho UMA vez
//    (na rodada seguinte a issue aberta o dá por tratado): o defeito aparece, e o aviso não repete de hora em hora.
const entregou = (r) => /^enviado/.test(String((r || {}).email)) || /^ja aberta/.test(String((r || {}).issue));
// o log é público (repo aberto): o destinatário do e-mail não vai para ele
const semDestino = (r) => Object.fromEntries(Object.entries(r || {}).map(([k, v]) => [k, String(v).replace(/^enviado para .*/, 'enviado')]));
const hojeBRT = () => process.env.AGORA_DIA || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const menosDias = (iso, n) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) - n * 864e5).toISOString().slice(0, 10);

async function main({ alerta = require('./lib-alerta').alerta, le = leConjunto, hoje = hojeBRT() } = {}) {
  const restr = await le();
  const desde = [DESDE, menosDias(hoje, RECENTE_D)].sort().pop();
  const dias = JC.diasSemRestricao(restr.consolidado, { desde });
  if (!dias.length) { console.log('alerta-sem-restricao: nenhum dia completo sem limitacao desde ' + desde); return { dias, avisos: [], falhas: [] }; }
  const avisos = [], falhas = [];
  for (const x of dias) {
    const a = JC.avisoDoDia(x), r = semDestino(await alerta(a));
    avisos.push({ dia: x.dia, tipo: x.tipo, canais: r });
    console.log('alerta-sem-restricao: ' + x.dia + ' (' + x.tipo + (x.tipo === 'feriado' ? ': ' + x.nome : '') + ') · ' + JSON.stringify(r));
    if (!entregou(r)) falhas.push(x.dia + ' ' + JSON.stringify(r));
  }
  return { dias, avisos, falhas };
}

module.exports = { main, DESDE, RECENTE_D, entregou };
if (require.main === module) main().then((r) => {
  if (r.falhas.length) { console.log('::error::alerta-sem-restricao: o e-mail nao saiu para ' + r.falhas.join(' · ')); process.exit(1); }
}, (e) => { console.log('::error::alerta-sem-restricao: ' + e.message); process.exit(1); });
