/*
 * gen-sinotico.js — o estado da SE e dos circuitos para o SINÓTICO do SIGO Dados (lote sinotico-dados, 09/11/2026).
 * Humano, 09/11/2026: espelho do supervisório com os dados reais dos medidores; "os disjuntores realmente abram quando ocorrem um trip
 * (...) na mesma lógica do alarme: quando zerar corrente, potência ativa e reativa e tem comunicação, o disjuntor abriu". Nome: Sinótico.
 *
 * MESMA LÓGICA DO ALARME, e o MESMO resultado: o estado de cada disjuntor sai dos episódios EM CURSO do alarmes_way2.json que o
 * gen-alarmes-way2 acabou de gravar nesta rodada (lib-alarme-circuito: qualidade 0 nas 8 grandezas, |P| < 0,5 kW, |Q| < 0,5 kvar,
 * corrente < 0,15 A, por 2 intervalos seguidos; tensão acima de 0,8 pu = ABERTO com a barra viva, abaixo = SEM TENSÃO). A tela do
 * Sinótico e a dos Alarmes não podem discordar. Medidas do último intervalo de cada medidor, da coleta desta rodada (way2_eletrico).
 *   disjuntor: 'fechado' | 'aberto' | 'sem_tensao' | 'sem_comunicacao'
 *   sem_comunicacao = o último intervalo do medidor não veio completo com qualidade 0, ou tem mais de 15 min: posição desconhecida.
 * Grava dados/sinotico.json (gzip). LOCAL_OUT=<arquivo> grava em disco e não sobe. Entrada: ELET_LOCAL_DIR (coleta) e o publicado.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const A = require('./lib-alarme-circuito');

const VELHO_MS = 15 * 60 * 1000;
const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
const parse = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));

// puro (ensaiado): coleta + alarmes publicados -> o objeto do Sinótico
function monta(dados, alarmes, agoraMs) {
  const serie = A.serieDosDados(dados);
  const emCurso = new Map();
  for (const e of (alarmes && alarmes.eventos) || []) if (e.fim == null) emCurso.set(e.tag, e);
  const med = {}, disj = {};
  for (const [pid, tag] of Object.entries(A.PID)) {
    const eq = A.EQ[tag], s = serie[pid];
    // a coleta traz os intervalos do dia inteiro, os futuros vazios: vale o último JÁ PASSADO e completo (qualidade 0 nas 8 grandezas)
    const passados = s ? [...s.values()].filter((x) => x.t <= agoraMs) : [];
    const ult = passados.filter((x) => x.ok).pop() || passados.pop() || null;
    const vNom = eq.n === 'trafo' ? A.V_NOM.trafo : A.V_NOM.circuito;
    const comunica = !!(ult && ult.ok && agoraMs - ult.t <= VELHO_MS + A.LIMITES.SLOT_MS);
    med[tag] = { pid: Number(pid), usina: eq.u, pai: eq.pai, t: ult ? A.isoBRT(ult.t) : null, comunica,
      p_kw: comunica ? r1(ult.P) : null, q_kvar: comunica ? r1(ult.Q) : null,
      i_a: comunica ? [r2(ult.Ia), r2(ult.Ib), r2(ult.Ic)] : null, v_kv: comunica ? r2(ult.V * Math.sqrt(3) / 1000) : null,
      v_pu: comunica ? r2(ult.V / vNom) : null, intervalo: comunica ? A.estadoSlot(ult, vNom) : null };
    const ep = emCurso.get(tag) || (emCurso.get(eq.pai) && /sem_tensao/.test(emCurso.get(eq.pai).regra) ? emCurso.get(eq.pai) : null);
    let d;
    if (ep && /_aberto$/.test(ep.regra)) d = 'aberto';
    else if (ep && /sem_tensao$/.test(ep.regra)) d = 'sem_tensao';
    else if (!comunica) d = 'sem_comunicacao';
    else d = 'fechado';
    disj[tag] = { estado: d, desde: ep ? ep.ini : null, alarme: ep ? ep.id : null };
  }
  const se = emCurso.get('SE');
  const usinas = {};
  for (const [tag, m] of Object.entries(med)) {
    if (A.EQ[tag].n !== 'circuito') continue;
    const u = usinas[m.usina] || (usinas[m.usina] = { p_kw: 0, q_kvar: 0, circuitos: 0, medidos: 0 });
    u.circuitos++;
    if (m.comunica) { u.p_kw = r1(u.p_kw + m.p_kw); u.q_kvar = r1(u.q_kvar + m.q_kvar); u.medidos++; }
  }
  const tr = ['04T1', '04T2'].map((t) => med[t]);
  return {
    gerado_em: new Date(agoraMs).toISOString(), ms: agoraMs,
    regra: { texto: 'Disjuntor aberto: comunicação boa e corrente, potência ativa e reativa zeradas por 2 intervalos de 5 min, com a barra '
      + 'energizada (tensão acima de 0,8 pu). Com a tensão abaixo de 0,8 pu, o circuito está sem tensão: a queda é da barra ou do transformador.',
      limites: A.LIMITES, mesma_do: 'alarmes_way2.json' },
    se: { sem_tensao: !!se, desde: se ? se.ini : null,
      p_kw: tr.every((m) => m.comunica) ? r1(tr[0].p_kw + tr[1].p_kw) : null, q_kvar: tr.every((m) => m.comunica) ? r1(tr[0].q_kvar + tr[1].q_kvar) : null },
    medidores: med, disjuntores: disj, usinas
  };
}

async function main() {
  const arq = process.env.LOCAL_ELET || (process.env.ELET_LOCAL_DIR && path.join(process.env.ELET_LOCAL_DIR, 'way2_eletrico.json'));
  if (!arq || !fs.existsSync(arq)) throw new Error('sem a cópia local da coleta desta rodada (ELET_LOCAL_DIR)');
  const elet = parse(fs.readFileSync(arq));
  const LD = require('./lib-le-dados');
  const alarmes = process.env.LOCAL_ALARMES ? parse(fs.readFileSync(process.env.LOCAL_ALARMES)) : await LD.json(LD.BASE + 'alarmes_way2.json');
  const out = monta(elet.dados, alarmes, Date.now());
  const n = Object.values(out.disjuntores).reduce((a, d) => (a[d.estado] = (a[d.estado] || 0) + 1, a), {});
  console.log('sinotico: ' + JSON.stringify(n) + (out.se.sem_tensao ? ' · SE sem tensão' : ''));
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 });
  if (process.env.LOCAL_OUT) { fs.writeFileSync(process.env.LOCAL_OUT, gz); console.log('gravado em disco: ' + process.env.LOCAL_OUT); return; }
  await require('./lib-conteiner').conteiner('dados').getBlockBlobClient('sinotico.json').upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=60' } });
  console.log('dados/sinotico.json gravado (' + gz.length + ' bytes)');
}

if (require.main === module) main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
module.exports = { monta, VELHO_MS };
