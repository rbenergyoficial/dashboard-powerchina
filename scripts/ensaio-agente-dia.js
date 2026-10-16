/*
 * ensaio-agente-dia.js — o resumo diário do Assistente Inteligente (agente_dia.json; PROMOVER assistente-portal, 16/10/2026).
 *
 * POR QUE EXISTE. O assistente fala o número em voz alta para o operador: um número errado aqui vira uma resposta errada dita com
 * confiança. O gerador soma pela regra das páginas Histórico e Confiabilidade; este ensaio REFAZ o resumo inteiro por código próprio
 * (refaz) e compara FOLHA A FOLHA: todo número e texto publicado tem de ter a contraparte refeita, e toda contraparte o publicado.
 *
 *   --lib      sem rede, ANTES do gerador nos workflows: um mundo FORJADO com os casos que o mundo real nem sempre tem, cada um com o
 *              valor esperado escrito à mão: o último dia em 15/01 (mês anterior = dezembro do ano anterior; o ano só com janeiro; o PPA
 *              sem mês fechado no ano, sem bloquear a gravação), um dia com a medição incompleta e a maior líquida (não é o melhor dia),
 *              um inversor faltando num dia (sai da cascata), o logger que ainda não chegou no último dia (sai dos códigos e da
 *              cascata), um dia do logger sem inversor inteiro (sai dos códigos e a família dele não conta), a estação com o último dia
 *              incompleto (o último completo é o da véspera), e um dia de hoje sem leitura (não é dia fechado). Depois o refaz tem de
 *              concordar com o gerador folha a folha nesse mundo, e cada PLANTIO no refaz tem de discordar (o caso existe por construção).
 *   --produto  (padrão) sobre o agente_dia.json publicado (ou LOCAL_DIR=<pasta>) e as fontes públicas:
 *              · só julga se as fontes lidas são as MESMAS versões que o produto leu (campo fontes); senão diz que a fonte mudou depois
 *                do produto e não julga (três workflows gravam o resumo em horas diferentes);
 *              · o último dia fechado tirado do way2_daily por conta própria tem de ser o do produto, e mês, mês anterior e ano também;
 *              · comparação folha a folha com o refaz; conta os números não nulos comparados por bloco (nenhum bloco vazio);
 *              · a soma das usinas do PPA no PRODUTO contra o PPA do produto (folga escrita: 7 arredondamentos de 0,0005 MWh);
 *              · os plantios rodam também aqui; sem o caso no dado do momento dizem "não se aplica agora" (o --lib garante a cobertura).
 * Sem segredo: lê só blob público.
 */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL = process.env.LOCAL_DIR || '';
const U9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const MEMBROS = { Complexo: U9, PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
U9.forEach((u) => { MEMBROS[u] = [u]; });
const ENTS = ['Complexo', 'PPA', 'ML'].concat(U9);
const POT = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };   /* outorga, MW */
const TOL_PPA = 7 * 0.0005;   /* a liquida do PPA e a de cada uma das 6 usinas sao r3 de somas: 6 + 1 arredondamentos de 0,0005 MWh */
let falhas = 0;
const ok = (c, m) => { if (c) console.log('  ✓ ' + m); else { falhas++; console.log('  ✗ ' + m); } };
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function get(nome, local) {
  if (local) return Promise.resolve(deJson(fs.readFileSync(path.join(local, nome))));
  return new Promise((res, rej) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 180000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { res(deJson(Buffer.concat(c))); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 180 s: ' + nome))); req.on('error', rej);
  });
}
const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------------------------------------------------------------- a segunda rota: o resumo refeito sem o codigo do gerador */
function refaz(W, S, I, ED, X, P) {
  P = P || {};
  const placa = (I.escopo || {}).inversores_por_parque || {};
  const porDia = new Map(W.dias.map((x) => [x.dia, x]));
  const sg = new Map((S.usina_dia || []).map((r) => [r.ufv + '|' + r.d, r]));
  const fech = W.dias.filter((x) => x.slots > 0).map((x) => x.dia).sort();
  const ultimo = fech[fech.length - 1];
  const mes = ultimo.slice(0, 7), ano = mes.slice(0, 4), mm = +mes.slice(5, 7);
  const mesAnt = P.viradaJan ? ano + '-' + String(mm === 1 ? 12 : mm - 1).padStart(2, '0') : (mm === 1 ? +ano - 1 : ano) + '-' + String(mm === 1 ? 12 : mm - 1).padStart(2, '0');
  const ini7 = new Date(Date.parse(ultimo + 'T12:00:00Z') - 6 * 86400e3).toISOString().slice(0, 10);
  const ok0 = (d) => d >= '2025-09-01' && d <= ultimo;
  const jan = { mes: fech.filter((d) => ok0(d) && d.slice(0, 7) === mes), mes_anterior: fech.filter((d) => ok0(d) && d.slice(0, 7) === mesAnt),
    ano: fech.filter((d) => ok0(d) && d.slice(0, 4) === ano), ultimos_7: fech.filter((d) => d >= ini7 && d <= ultimo) };
  const memb = (e) => (P.trocaML && e === 'ML' ? ['M1', 'M9', 'M9'] : MEMBROS[e]);
  const dia = (e, d) => {
    const w = porDia.get(d); if (!w || !(w.slots > 0)) return null;
    const us = memb(e);
    if (e === 'Complexo') return { l: w.ene_liq_mwh, b: w.ene_ger_mwh > 0 ? w.ene_ger_mwh : null, c: P.melhorIncompleto ? true : !!w.completo };
    if (!w.ufv_liq_mwh || us.some((u) => w.ufv_liq_mwh[u] == null)) return null;
    const l = us.reduce((a, u) => a + w.ufv_liq_mwh[u], 0);
    let b = null; if (w.ufv_ger_mwh && us.every((u) => w.ufv_ger_mwh[u] != null)) { b = us.reduce((a, u) => a + w.ufv_ger_mwh[u], 0); if (!(b > 0)) b = null; }
    return { l, b, c: P.melhorIncompleto ? true : !!(w.ufv_completo && w.ufv_completo[e]) };
  };
  const out = { ultimo_dia_fechado: ultimo, mes, mes_anterior: mesAnt, ano, historico: {}, perdas: {}, codigos: {}, estacao: {} };
  ENTS.forEach((e) => {
    const pot = memb(e).reduce((a, u) => a + POT[u], 0);
    out.historico[e] = {}; out.perdas[e] = {}; out.codigos[e] = {};
    ['mes', 'mes_anterior', 'ano'].forEach((j) => {
      const A = jan[j].map((d) => [d, dia(e, d)]).filter((x) => x[1] && x[1].l != null);
      const C = A.filter((x) => x[1].c), B = A.filter((x) => x[1].b != null);
      const soma = (L, f) => L.reduce((a, x) => a + f(x), 0);
      const best = C.reduce((a, x) => (!a || x[1].l > a[1] ? [x[0], x[1].l] : a), null);
      const sb = soma(B, (x) => x[1].b), slb = soma(B, (x) => x[1].l);
      out.historico[e][j] = { dias: A.length, liq_mwh: r3(soma(A, (x) => x[1].l)), dias_completos: C.length,
        fc_pct: C.length ? r2(100 * soma(C, (x) => x[1].l) / (pot * 24 * C.length)) : null, melhor: best ? { dia: best[0], mwh: r3(best[1]) } : null,
        bruta_mwh: B.length ? r3(sb) : null, liq_mesmos_dias_mwh: B.length ? r3(slb) : null, dias_bruta: B.length, perda_entrega_pct: B.length ? r2(100 * (sb - slb) / sb) : null };
      const Q = A.filter((x) => x[0] >= '2026-04-03' && x[1].b != null && x[1].c && memb(e).every((u) => {
        const r = sg.get(u + '|' + x[0]); return r && placa[u] && (P.diaParcial ? r.n_cc > 0 : r.n_cc === placa[u]) && r.ecc != null && r.eca != null; }));
      if (!Q.length) out.perdas[e][j] = { dias: 0 };
      else {
        const cc = soma(Q, (x) => memb(e).reduce((s, u) => s + sg.get(u + '|' + x[0]).ecc, 0)), ca = soma(Q, (x) => memb(e).reduce((s, u) => s + sg.get(u + '|' + x[0]).eca, 0));
        const g = soma(Q, (x) => x[1].b), l = soma(Q, (x) => x[1].l), pc = (a, b) => r2(100 * (a - b) / cc);
        out.perdas[e][j] = { dias: Q.length, cc_mwh: r3(cc), ca_mwh: r3(ca), bruta_mwh: r3(g), liq_mwh: r3(l), inv_pct: pc(cc, ca), mt_pct: pc(ca, g), ent_pct: pc(g, l), tot_pct: pc(cc, l), perda_mwh: r3(cc - l) };
      }
    });
    ['mes', 'ultimos_7'].forEach((j) => {
      const D = new Set(jan[j]); let eq = 0, rd = 0, den = 0, nd = 0; const fam = new Map(), entra = new Set();
      memb(e).forEach((u) => {
        const R = (S.usina_dia || []).filter((r) => r.ufv === u && D.has(r.d) && (P.codigosSemLogger || (r.n_inv > 0 && r.n_equip != null && r.n_rede != null)));
        nd = Math.max(nd, R.length); R.forEach((r) => { eq += r.n_equip || 0; rd += r.n_rede || 0; den += placa[u] || 0; entra.add(u + '|' + r.d); });
      });
      (S.familia_dia || []).forEach((r) => { if (entra.has(r.ufv + '|' + r.d) && r.origem === 'equipamento' && r.n_inv != null) fam.set(r.fam, (fam.get(r.fam) || 0) + r.n_inv); });
      const top = [...fam.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0];
      out.codigos[e][j] = { dias: nd, equip: eq, rede: rd, por100_equip: den ? r2(100 * eq / den) : null, por100_rede: den ? r2(100 * rd / den) : null, familia_top: top ? { fam: top[0], inv_dias: top[1] } : null };
    });
  });
  U9.forEach((u) => {
    const L = (ED.serie || []).filter((r) => r.u === u);
    const cheio = (r) => (P.estacaoIncompleta ? r.n > 0 : r.n === 144);
    const ud = L.filter((r) => cheio(r) && r.poa != null).sort((a, b) => (a.d < b.d ? 1 : -1))[0];
    const Mc = L.filter((r) => (P.estacaoForaDoMes || r.d.slice(0, 7) === mes) && cheio(r));
    const vals = (k) => Mc.map((r) => r[k]).filter((x) => x != null);
    const med = (k) => { const v = vals(k); return v.length ? r2(v.reduce((a, x) => a + x, 0) / v.length) : null; };
    const mx = (k) => { const v = vals(k); return v.length ? Math.max.apply(null, v) : null; };
    const sm = (k) => { const v = vals(k); return v.length ? r2(v.reduce((a, x) => a + x, 0)) : null; };
    out.estacao[u] = { ultimo_dia: ud ? { dia: ud.d, poa: ud.poa, ghi: ud.ghi, ta: ud.ta, ta_max: ud.ta_max, ws: ud.ws, ws_max: ud.ws_max, chuva: ud.chuva } : null,
      mes: { mes, dias_completos: Mc.length, poa: med('poa'), ghi: med('ghi'), ta: med('ta'), ta_max: mx('ta_max'), ws: med('ws'), ws_max: mx('ws_max'), chuva: sm('chuva') } };
  });
  const L = (X.serie_ufv || []).filter((r) => r.ufv === 'PPA' && r.mes.slice(0, 4) === ano && r.mes < mes && !r.parcial && r.liquida_gwh != null && r.meta_gwh != null)
    .sort((a, b) => (a.mes < b.mes ? -1 : 1));
  out.ppa = { ano, meses_fechados: L.length, meses_na_meta: L.filter((r) => r.liquida_gwh >= r.meta_gwh).length,
    folga_gwh: L.length ? r3(L.reduce((a, r) => a + r.liquida_gwh - r.meta_gwh, 0)) : null, de: L.length ? L[0].mes : null, ate: L.length ? L[L.length - 1].mes : null };
  return out;
}

/* ---------------------------------------------------------------- folha a folha */
const FORA = new Set(['gerado', 'legenda', 'fontes']);
function folhas(o, p, out) {
  out = out || new Map();
  if (o === null || typeof o !== 'object') { out.set(p, o); return out; }
  Object.keys(o).forEach((k) => { if (!p && FORA.has(k)) return; folhas(o[k], p ? p + '.' + k : k, out); });
  return out;
}
function julga(A, Rf) {
  const fa = folhas(A), fr = folhas(Rf), dif = [], cont = {};
  new Set([...fa.keys(), ...fr.keys()]).forEach((k) => {
    if (!fa.has(k)) { dif.push(k + ': o produto nao publica'); return; }
    if (!fr.has(k)) { dif.push(k + ': sem contraparte refeita'); return; }
    const a = fa.get(k), b = fr.get(k);
    const igual = (typeof a === 'number' && typeof b === 'number') ? Math.abs(a - b) <= 1e-9 : a === b;
    if (!igual) dif.push(k + ': publicado ' + a + ', refeito ' + b);
    else if (typeof a === 'number') { const bl = k.split('.')[0]; cont[bl] = (cont[bl] || 0) + 1; }
  });
  return { dif, cont };
}
const PLANTIOS = [['diaParcial', 'dia com inversor faltando entrando na cascata'], ['trocaML', 'M7 trocado por M9 no ML'], ['melhorIncompleto', 'o melhor dia pegando dia de medicao incompleta'],
  ['estacaoIncompleta', 'a estacao lendo dia incompleto'], ['estacaoForaDoMes', 'a media da estacao tirada fora do mes'], ['viradaJan', 'o mes anterior de janeiro no mesmo ano'],
  ['codigosSemLogger', 'os codigos contando o dia que o logger nao trouxe']];

/* ---------------------------------------------------------------- --lib: o mundo forjado */
function forja() {
  const PL = { M1: 165, M2: 88, M3: 165, M4: 165, M5: 165, M6: 165, M7: 44, M8: 165, M9: 33 };
  const dias = []; for (let t = Date.parse('2026-11-25T12:00:00Z'); t <= Date.parse('2027-01-16T12:00:00Z'); t += 86400e3) dias.push(new Date(t).toISOString().slice(0, 10));
  const W = { atualizado: 'forjado', dias: [] }, S = { gerado_em: 'forjado', usina_dia: [], familia_dia: [] }, ED = { gerado_em: 'forjado', serie: [] };
  dias.forEach((d, k) => {
    if (d === '2027-01-16') { W.dias.push({ dia: d, slots: 0, completo: false, ene_liq_mwh: 0, ene_ger_mwh: 0 }); return; }   /* hoje: sem leitura */
    const ul = {}, ug = {}, uc = { PPA: true, ML: true };
    U9.forEach((u, i) => { ul[u] = 100 + 10 * i + k; ug[u] = ul[u] + 1 + 0.1 * i; uc[u] = true; });
    if (d === '2027-01-14') { ul.M3 = 999; ug.M3 = 1000; uc.M3 = false; uc.PPA = false; }   /* a maior liquida do M3, com a medicao incompleta */
    let el = 0, eg = 0; U9.forEach((u) => { el += ul[u]; eg += ug[u]; });
    W.dias.push({ dia: d, slots: 288, completo: d !== '2027-01-13', ene_liq_mwh: el + (d === '2027-01-13' ? 5000 : 0), ene_ger_mwh: eg + (d === '2027-01-13' ? 5100 : 0), ufv_liq_mwh: ul, ufv_ger_mwh: ug, ufv_completo: uc });
    U9.forEach((u, i) => {
      if (d === '2027-01-15' && u === 'M7') return;   /* o logger do M7 ainda nao chegou no ultimo dia */
      const vazio = d === '2027-01-12' && u === 'M1';   /* o dia do logger sem inversor inteiro */
      S.usina_dia.push({ d, ufv: u, n_inv: vazio ? 0 : PL[u], n_cc: vazio ? 0 : (d === '2027-01-05' && u === 'M5' ? PL[u] - 1 : PL[u]), ecc: ul[u] * 1.04, eca: ul[u] * 1.02, n_equip: vazio ? 0 : 1, n_rede: vazio ? 0 : 2 });
      ED.serie.push({ u, d, n: d === '2027-01-15' && u === 'M2' ? 100 : 144, poa: d === '2027-01-15' && u === 'M2' ? 50 : 8 + 0.1 * i, ghi: 7, ta: 28, ta_max: 35, ws: 2, ws_max: 8, chuva: 0.5 });
    });
  });
  S.familia_dia.push({ d: '2027-01-12', ufv: 'M1', fam: 'reversa_fv', origem: 'equipamento', n_inv: 50 });   /* no dia que nao conta */
  S.familia_dia.push({ d: '2027-01-11', ufv: 'M1', fam: 'isolacao_baixa', origem: 'equipamento', n_inv: 1 });
  S.familia_dia.push({ d: '2027-01-10', ufv: 'M2', fam: 'entrada_anormal', origem: 'equipamento', n_inv: 3 });
  const X = { atualizado: 'forjado', serie_ufv: [{ ufv: 'PPA', mes: '2026-11', liquida_gwh: 30, meta_gwh: 28 }, { ufv: 'PPA', mes: '2026-12', liquida_gwh: 29, meta_gwh: 30 }, { ufv: 'PPA', mes: '2027-01', liquida_gwh: 14, meta_gwh: 30, parcial: 1 }] };
  const I = { atualizado: 'forjado', escopo: { inversores_por_parque: PL } };
  return { W, S, I, ED, X };
}
function lib() {
  const G = require('./gen-agente-dia.js');
  const F = forja(), R = G.monta(F.W, F.S, F.I, F.ED, F.X);
  const esperado = [
    ['ultimo dia fechado (hoje sem leitura nao conta)', R.ultimo_dia_fechado, '2027-01-15'], ['mes', R.mes, '2027-01'], ['mes anterior de janeiro = dezembro do ano anterior', R.mes_anterior, '2026-12'], ['ano', R.ano, '2027'],
    ['M3: o melhor dia pula o dia de medicao incompleta', R.historico.M3.mes.melhor.dia, '2027-01-15'], ['M3: dias completos no mes', R.historico.M3.mes.dias_completos, 14],
    ['Complexo: o melhor dia e o 14 (completo)', R.historico.Complexo.mes.melhor.dia, '2027-01-14'], ['Complexo: dias completos (o 13 incompleto)', R.historico.Complexo.mes.dias_completos, 14],
    ['Complexo: dias fechados no mes', R.historico.Complexo.mes.dias, 15], ['M3: o ano so com janeiro', R.historico.M3.ano.dias, 15], ['M3: dezembro inteiro', R.historico.M3.mes_anterior.dias, 31],
    ['M5: o dia com inversor faltando sai da cascata', R.perdas.M5.mes.dias, 14], ['M7: o ultimo dia sem logger sai da cascata', R.perdas.M7.mes.dias, 14],
    ['Complexo: a cascata sem o 05 (M5), o 12 (M1 sem inversor inteiro), o 13 (medicao) e o 15 (M7)', R.perdas.Complexo.mes.dias, 11], ['M1: o dia sem inversor inteiro sai da cascata', R.perdas.M1.mes.dias, 14],
    ['M7: os ultimos 7 dias sem o ultimo (logger ausente)', R.codigos.M7.ultimos_7.dias, 6], ['M1: o dia do logger sem inversor inteiro nao conta', R.codigos.M1.mes.dias, 14],
    ['M1: a familia do dia que nao conta nao entra', R.codigos.M1.mes.familia_top && R.codigos.M1.mes.familia_top.fam, 'isolacao_baixa'],
    ['M2: o ultimo dia completo da estacao e a vespera', R.estacao.M2.ultimo_dia && R.estacao.M2.ultimo_dia.dia, '2027-01-14'], ['M2: dias completos da estacao no mes', R.estacao.M2.mes.dias_completos, 14],
    ['M2: poa do mes so com os dias completos', R.estacao.M2.mes.poa, 8.1], ['PPA em janeiro: nenhum mes fechado no ano', R.ppa.meses_fechados, 0], ['PPA em janeiro: folga nula', R.ppa.folga_gwh, null],
    ['a guarda nao bloqueia o janeiro sem mes fechado', G.guarda(R).mau.join(' | '), ''],
  ];
  const ruins = esperado.filter((x) => x[1] !== x[2]);
  ok(!ruins.length, esperado.length + ' casos forjados com o valor escrito a mao' + (ruins.length ? ' — ' + ruins.map((x) => x[0] + ': ' + x[1] + ' (esperava ' + x[2] + ')').join('; ') : ''));
  const j = julga(R, refaz(F.W, F.S, F.I, F.ED, F.X));
  ok(!j.dif.length, 'o refaz concorda com o gerador folha a folha no mundo forjado (' + Object.values(j.cont).reduce((a, x) => a + x, 0) + ' numeros)' + (j.dif.length ? ' — ' + j.dif.slice(0, 4).join('; ') : ''));
  console.log('· plantios no mundo forjado (o caso existe por construcao: cada um TEM de reprovar)');
  PLANTIOS.forEach((p) => { const o = {}; o[p[0]] = true; const n = julga(R, refaz(F.W, F.S, F.I, F.ED, F.X, o)).dif.length; ok(n > 0, 'plantio "' + p[1] + '" reprova (' + n + ')'); });
}

/* ---------------------------------------------------------------- --produto */
async function produto() {
  const A = await get('agente_dia.json', LOCAL);
  const [W, S, I, ED, X] = await Promise.all(['way2_daily.json', 'sg_saude.json', 'inversores.json', 'estacao_dia.json', 'executivo.json'].map((n) => get(n)));
  console.log('· agente_dia.json de ' + A.gerado + ' · ultimo dia fechado ' + A.ultimo_dia_fechado);
  const lidas = { way2_daily: W.atualizado || null, sg_saude: S.gerado_em || null, estacao_dia: ED.gerado_em || null, executivo: X.atualizado || null, inversores: I.atualizado || null };
  const mudou = Object.keys(lidas).filter((k) => !A.fontes || A.fontes[k] !== lidas[k]);
  if (mudou.length) {
    console.log('  ⚠️ NAO JULGADO: a fonte mudou depois do produto (' + mudou.map((k) => k + ' ' + (A.fontes && A.fontes[k]) + ' -> ' + lidas[k]).join('; ') + '); a proxima rodada julga');
    return;
  }
  const ult = W.dias.filter((x) => x.slots > 0).map((x) => x.dia).sort().pop();
  ok(ult === A.ultimo_dia_fechado, 'o ultimo dia fechado tirado do medidor por conta propria e o do produto (' + ult + ')');
  const Rf = refaz(W, S, I, ED, X), j = julga(A, Rf);
  ok(!j.dif.length, 'o produto inteiro bate folha a folha com o refeito' + (j.dif.length ? ' — difere (' + j.dif.length + '): ' + j.dif.slice(0, 5).join('; ') : ''));
  const vazios = ['historico', 'perdas', 'codigos', 'estacao'].filter((b) => !(j.cont[b] > 0));
  ok(!vazios.length, 'numeros nao nulos comparados por bloco: ' + JSON.stringify(j.cont) + (vazios.length ? ' — bloco vazio: ' + vazios.join(' ') : ''));
  const soma = MEMBROS.PPA.reduce((a, u) => a + A.historico[u].mes.liq_mwh, 0);
  ok(Math.abs(soma - A.historico.PPA.mes.liq_mwh) <= TOL_PPA + 1e-9, 'no produto, a soma das 6 usinas do PPA e a liquida do contrato no mes (' + r3(soma) + ' x ' + A.historico.PPA.mes.liq_mwh + ' MWh; folga ' + TOL_PPA + ')');
  console.log('· plantios no dado do momento (sem o caso no periodo: nao se aplica agora; o --lib cobre por construcao)');
  PLANTIOS.forEach((p) => { const o = {}; o[p[0]] = true; const n = julga(A, refaz(W, S, I, ED, X, o)).dif.length; console.log('  ' + (n ? '✓' : '·') + ' plantio "' + p[1] + '": ' + (n ? 'reprova (' + n + ')' : 'nao se aplica agora')); });
  const B = JSON.parse(JSON.stringify(A)); delete B.perdas.Complexo;
  ok(julga(B, Rf).dif.length > 0, 'plantio "bloco de perdas sem o Complexo" reprova');
}

(async () => {
  try { if (process.argv.includes('--lib')) lib(); else await produto(); } catch (e) { falhas++; console.log('  ✗ ' + (e && e.stack || e)); }
  console.log(falhas ? 'REPROVADO (' + falhas + ')' : 'APROVADO');
  process.exit(falhas ? 1 : 0);
})();
