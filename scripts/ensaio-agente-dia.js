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
 *              incompleto (o último completo é o da véspera), e um dia de hoje sem leitura (não é dia fechado); no CORTE (agente-corte-cod),
 *              um mês antes da operação comercial (fora), um mês do modelo (o Complexo com o número do modelo, não o do operador; as usinas
 *              sem número), um mês do modelo SEM o número do modelo, um mês com base desconhecida no gêmeo (sem número em ninguém), um mês
 *              do operador com uma usina sem linha, um mês fechado que o modelo ainda não rodou, o mês aberto (fora), as linhas do Complexo
 *              FORA de ordem, e um segundo ano (2025) só com mês do modelo (as usinas sem número no ano); mês repetido aborta o gerador.
 *              Depois o refaz tem de
 *              concordar com o gerador folha a folha nesse mundo, e cada PLANTIO no refaz tem de discordar (o caso existe por construção).
 *   --produto  (padrão) sobre o agente_dia.json publicado (ou LOCAL_DIR=<pasta>) e as fontes públicas:
 *              · só julga se as fontes lidas são as MESMAS versões que o produto leu (campo fontes); senão diz que a fonte mudou depois
 *                do produto e não julga (três workflows gravam o resumo em horas diferentes);
 *              · o último dia fechado tirado do way2_daily por conta própria tem de ser o do produto, e mês, mês anterior e ano também;
 *              · comparação folha a folha com o refaz; conta os números não nulos comparados por bloco (nenhum bloco vazio);
 *              · a soma das usinas do PPA no PRODUTO contra o PPA do produto (folga escrita: 7 arredondamentos de 0,0005 MWh);
 *              · no corte, identidades do PRODUTO que não passam pelo refaz: nos meses do operador, a soma das 9 usinas e PPA + ML são o
 *                Complexo (folgas de 10 e 3 arredondamentos de 0,005 MWh); nos meses do modelo, o Complexo é o corte_final_gwh do gêmeo × 1000
 *                (folga: meia unidade das 2 casas de GWh, 5 MWh); nos meses do operador, o gêmeo (apurado bruto) e o executivo (reconciliado)
 *                diferem por uma folga ABSOLUTA: 5 MWh (meia unidade das 2 casas de GWh do gêmeo) + 0,005 MWh + 10 MWh de resíduo da
 *                reconciliação (medido até 4,3 MWh em 7 meses, set/26): detector de unidade e de troca grosseira; a troca de mês fica com a
 *                identidade; todos os meses do operador entram na conferência e os meses fora das identidades são listados;
 *              · FONTES_DIR (o job do workflow): as fontes que o gerador leu, sempre as mesmas versões, então o produto é sempre julgado.
 *              · os plantios rodam também aqui; sem o caso no dado do momento dizem "não se aplica agora" (o --lib garante a cobertura).
 * Sem segredo: lê só blob público.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL = process.env.LOCAL_DIR || process.env.FONTES_DIR || '';   /* no job: o produto que o gerador deste job gravou (FONTES_DIR) */
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
  /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); como antes, toda resposta que nao e 200 reprova, o 404 tambem */
  return LD.pede(BASE + nome, { 'accept-encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + nome);
    return deJson(x.buf);
  });
}
const r2 = (x) => Math.round(x * 100) / 100, r3 = (x) => Math.round(x * 1000) / 1000;

/* ---------------------------------------------------------------- a segunda rota: o resumo refeito sem o codigo do gerador */
function refaz(W, S, I, ED, X, P, G) {
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
  /* o corte desde a operacao comercial: o mes fechado da Visao Executiva; no Complexo o modelo quando o gemeo diz 'calculado'; nas usinas e
     contratos esse mes fica nulo; mes sem linha no gemeo, nulo em todos */
  const gm = new Map(((G && G.serie) || []).filter((s) => s.base === 'calculado' || s.base === 'apurado').map((s) => [s.mes, s]));
  const fechadas = (X.serie_ufv || []).filter((r) => (P.corteMesAberto || !r.parcial) && (P.cortePreCOD || r.mes >= '2025-09'));
  const mesesC = [...new Set(fechadas.filter((r) => r.ufv === 'Complexo').map((r) => r.mes))].sort();
  const cm = mesesC.map((m) => {
    const g = gm.get(m), mod = g ? g.base === 'calculado' : false, o = { mes: m, fonte: g ? (mod ? 'modelo' : 'operador') : null, confianca: mod ? (g.confianca || null) : null };
    ENTS.forEach((e) => {
      const lin = fechadas.find((r) => r.ufv === e && r.mes === m), opv = lin && lin.cortado_mwh != null ? r2(lin.cortado_mwh) : null;
      if (!g) o[e] = null;
      else if (e === 'Complexo') o[e] = mod && !P.corteOperadorNoModelo ? (g.corte_mwh == null ? null : r2(g.corte_mwh)) : opv;
      else o[e] = mod && !P.corteUsinaNoModelo ? null : opv;
    });
    return o;
  });
  const soma = (ms) => {
    const pe = {};
    ENTS.forEach((e) => { const v = ms.filter((x) => x[e] != null); pe[e] = { mwh: v.length ? r2(v.reduce((a, x) => a + x[e], 0)) : null, de: v.length ? v[0].mes : null,
      ate: v.length ? v[v.length - 1].mes : null, meses: v.length, meses_modelo: v.filter((x) => x.fonte === 'modelo').length, meses_sem_numero: ms.length - v.length }; });
    return { de: ms.length ? ms[0].mes : null, ate: ms.length ? ms[ms.length - 1].mes : null, meses: ms.length, por_entidade: pe };
  };
  const anosC = [...new Set(mesesC.map((m) => m.slice(0, 4)))];
  out.corte = { meses: cm, desde_cod: soma(cm), por_ano: {} };
  anosC.forEach((a) => { out.corte.por_ano[a] = soma(cm.filter((x) => x.mes.slice(0, 4) === a)); });
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
  ['codigosSemLogger', 'os codigos contando o dia que o logger nao trouxe'], ['corteOperadorNoModelo', 'o corte do Complexo com o numero do operador no mes do modelo'],
  ['corteUsinaNoModelo', 'a usina com o numero do operador no mes do modelo'], ['cortePreCOD', 'o corte contando mes antes da operacao comercial'],
  ['corteMesAberto', 'o corte contando o mes aberto']];

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
  /* o corte: 2025-08 antes da operacao comercial; 2026-10 mes do MODELO (o operador diz 100 no Complexo, o modelo 1234,5); 2026-11 do
     operador; 2026-12 fechado e sem linha no gemeo; 2027-01 aberto. Cada usina com 10 + i no mes, o PPA e o ML com a soma das deles */
  /* 2025-09 do modelo (500; 2025 so com ele: as usinas sem numero no ano), 2025-10 com base DESCONHECIDA no gemeo (sem numero em
     ninguem), 2026-09 do modelo SEM o numero do modelo (o Complexo fica nulo, nunca o do operador), 2026-11 do operador com o M9 SEM linha.
     As linhas do Complexo entram FORA de ordem (a lista de meses tem de sair ordenada) */
  ['2026-11', '2025-08', '2026-10', '2025-10', '2026-12', '2025-09', '2026-09', '2027-01'].forEach((m) => {
    const par = m === '2027-01' ? 1 : 0, cx = m === '2026-10' ? 100 : 90, uv = {};
    U9.forEach((u, i) => { uv[u] = 10 + i; });
    const linha = (ufv, v) => { const o = X.serie_ufv.find((r) => r.ufv === ufv && r.mes === m); if (o) o.cortado_mwh = v; else X.serie_ufv.push({ ufv, mes: m, cortado_mwh: v, parcial: par }); };
    linha('Complexo', cx); U9.forEach((u) => { if (!(m === '2026-11' && u === 'M9')) linha(u, uv[u]); });
    linha('PPA', ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'].reduce((a, u) => a + uv[u], 0)); linha('ML', ['M1', 'M7', 'M9'].reduce((a, u) => a + uv[u], 0));
  });
  const G = { gerado_em: 'forjado', serie: [{ mes: '2025-08', base: 'calculado', corte_mwh: 7, confianca: 'baixa' }, { mes: '2025-09', base: 'calculado', corte_mwh: 500, confianca: 'baixa' },
    { mes: '2025-10', base: 'outra', corte_mwh: 600 }, { mes: '2026-09', base: 'calculado', corte_mwh: null, confianca: 'baixa' },
    { mes: '2026-10', base: 'calculado', corte_mwh: 1234.5, confianca: 'media' }, { mes: '2026-11', base: 'apurado', corte_mwh: 95, confianca: 'alta' }, { mes: '2027-01', base: 'apurado', corte_mwh: 3 }] };
  const I = { atualizado: 'forjado', escopo: { inversores_por_parque: PL } };
  return { W, S, I, ED, X, G };
}
function lib() {
  const G = require('./gen-agente-dia.js');
  const F = forja(), R = G.monta(F.W, F.S, F.I, F.ED, F.X, F.G);
  const C = R.corte || { meses: [], desde_cod: { por_entidade: {} }, por_ano: {} }, cm = (m) => C.meses.find((x) => x.mes === m) || {};
  const ce = (b, e) => (b && b.por_entidade && b.por_entidade[e]) || {};
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
    ['corte: os meses fechados desde a operacao, em ordem (sem 2025-08 e sem o aberto)', C.meses.map((x) => x.mes).join(','), '2025-09,2025-10,2026-09,2026-10,2026-11,2026-12'],
    ['corte: base desconhecida no gemeo: sem fonte', cm('2025-10').fonte, null], ['corte: base desconhecida: o Complexo sem numero (nem o 600 do gemeo nem o 90 do operador)', cm('2025-10').Complexo, null],
    ['corte: base desconhecida: a usina sem numero', cm('2025-10').M3, null],
    ['corte: mes do modelo sem o numero do modelo: o Complexo nulo, nao o operador (90)', cm('2026-09').Complexo, null], ['corte: e a fonte continua modelo', cm('2026-09').fonte, 'modelo'],
    ['corte: usina sem linha no mes do operador fica nula, nao zero', cm('2026-11').M9, null], ['corte: o ML e a linha publicada do contrato (10+16+18)', cm('2026-11').ML, 44],
    ['corte: 2025 so com o mes do modelo: Complexo 500', ce(C.por_ano['2025'], 'Complexo').mwh, 500], ['corte: 2025: o M3 sem numero no ano (nulo, nao zero)', ce(C.por_ano['2025'], 'M3').mwh, null],
    ['corte: 2025: o M3 com 2 meses sem numero', ce(C.por_ano['2025'], 'M3').meses_sem_numero, 2], ['corte: 2025: os meses do ano', C.por_ano['2025'] && C.por_ano['2025'].meses, 2],
    ['corte: 2026: o M9 sem numero no ano', ce(C.por_ano['2026'], 'M9').mwh, null], ['corte: 2026: o M9 com 4 meses sem numero', ce(C.por_ano['2026'], 'M9').meses_sem_numero, 4],
    ['corte: 2026: o M3 so o mes do operador', ce(C.por_ano['2026'], 'M3').mwh, 12],
    ['corte: no mes do modelo o Complexo e o modelo (1234,5), nao o operador (100)', cm('2026-10').Complexo, 1234.5], ['corte: o mes do modelo diz a fonte', cm('2026-10').fonte, 'modelo'],
    ['corte: a confianca do modelo', cm('2026-10').confianca, 'media'], ['corte: no mes do modelo a usina fica sem numero', cm('2026-10').M3, null], ['corte: e o PPA tambem', cm('2026-10').PPA, null],
    ['corte: no mes do operador o Complexo e o do operador (90), nao o do gemeo (95)', cm('2026-11').Complexo, 90], ['corte: no mes do operador o M3 e 12', cm('2026-11').M3, 12],
    ['corte: o PPA no mes do operador (11+12+13+14+15+17)', cm('2026-11').PPA, 82], ['corte: o mes que o modelo nao rodou fica sem numero no Complexo', cm('2026-12').Complexo, null],
    ['corte: desde a operacao, o Complexo soma o modelo e o operador (500 + 1234,5 + 90)', ce(C.desde_cod, 'Complexo').mwh, 1824.5], ['corte: com 2 meses do modelo', ce(C.desde_cod, 'Complexo').meses_modelo, 2],
    ['corte: e 3 meses sem numero (base desconhecida, modelo sem numero, sem gemeo)', ce(C.desde_cod, 'Complexo').meses_sem_numero, 3], ['corte: o M3 desde a operacao so o mes do operador', ce(C.desde_cod, 'M3').mwh, 12],
    ['corte: o M3 comeca no mes do operador', ce(C.desde_cod, 'M3').de, '2026-11'], ['corte: o M3 com 5 meses sem numero', ce(C.desde_cod, 'M3').meses_sem_numero, 5],
    ['corte: 2025 e 2026 no por_ano (2027 so tem o mes aberto)', Object.keys(C.por_ano).join(','), '2025,2026'],
  ];
  const rep = (f) => { try { f(); return 'nao abortou'; } catch (e) { return /repetido/.test(e.message) ? 'abortou' : 'abortou por outro motivo: ' + e.message; } };
  const F2 = forja(); F2.X.serie_ufv.push({ ufv: 'M3', mes: '2026-11', cortado_mwh: 99, parcial: 0 });
  const F3 = forja(); F3.G.serie.push({ mes: '2026-10', base: 'apurado', corte_mwh: 1 });
  esperado.push(['corte: mes repetido na serie_ufv aborta o gerador', rep(() => G.monta(F2.W, F2.S, F2.I, F2.ED, F2.X, F2.G)), 'abortou'],
    ['corte: mes repetido no gemeo aborta o gerador', rep(() => G.monta(F3.W, F3.S, F3.I, F3.ED, F3.X, F3.G)), 'abortou']);
  const ruins = esperado.filter((x) => x[1] !== x[2]);
  ok(!ruins.length, esperado.length + ' casos forjados com o valor escrito a mao' + (ruins.length ? ' — ' + ruins.map((x) => x[0] + ': ' + x[1] + ' (esperava ' + x[2] + ')').join('; ') : ''));
  const j = julga(R, refaz(F.W, F.S, F.I, F.ED, F.X, {}, F.G));
  ok(!j.dif.length, 'o refaz concorda com o gerador folha a folha no mundo forjado (' + Object.values(j.cont).reduce((a, x) => a + x, 0) + ' numeros)' + (j.dif.length ? ' — ' + j.dif.slice(0, 4).join('; ') : ''));
  console.log('· plantios no mundo forjado (o caso existe por construcao: cada um TEM de reprovar)');
  PLANTIOS.forEach((p) => { const o = {}; o[p[0]] = true; const n = julga(R, refaz(F.W, F.S, F.I, F.ED, F.X, o, F.G)).dif.length; ok(n > 0, 'plantio "' + p[1] + '" reprova (' + n + ')'); });
}

/* ---------------------------------------------------------------- --produto */
async function produto() {
  const A = await get('agente_dia.json', LOCAL);
  const FD = process.env.FONTES_DIR || '';
  if (FD) console.log('· as fontes que o gerador deste job leu (' + FD + ')');
  const [W, S, I, ED, X, G] = await Promise.all(['way2_daily.json', 'sg_saude.json', 'inversores.json', 'estacao_dia.json', 'executivo.json', 'corte_gemeo.json'].map((n) => get(n, FD)));
  console.log('· agente_dia.json de ' + A.gerado + ' · ultimo dia fechado ' + A.ultimo_dia_fechado);
  const lidas = { way2_daily: W.atualizado || null, sg_saude: S.gerado_em || null, estacao_dia: ED.gerado_em || null, executivo: X.atualizado || null, inversores: I.atualizado || null,
    corte_gemeo: G.gerado_em || null };
  const mudou = Object.keys(lidas).filter((k) => !A.fontes || A.fontes[k] !== lidas[k]);
  if (mudou.length) {
    console.log('  ⚠️ NAO JULGADO: a fonte mudou depois do produto (' + mudou.map((k) => k + ' ' + (A.fontes && A.fontes[k]) + ' -> ' + lidas[k]).join('; ') + '); a proxima rodada julga');
    return;
  }
  const ult = W.dias.filter((x) => x.slots > 0).map((x) => x.dia).sort().pop();
  ok(ult === A.ultimo_dia_fechado, 'o ultimo dia fechado tirado do medidor por conta propria e o do produto (' + ult + ')');
  const Rf = refaz(W, S, I, ED, X, {}, G), j = julga(A, Rf);
  ok(!j.dif.length, 'o produto inteiro bate folha a folha com o refeito' + (j.dif.length ? ' — difere (' + j.dif.length + '): ' + j.dif.slice(0, 5).join('; ') : ''));
  const vazios = ['historico', 'perdas', 'codigos', 'estacao', 'corte'].filter((b) => !(j.cont[b] > 0));
  ok(!vazios.length, 'numeros nao nulos comparados por bloco: ' + JSON.stringify(j.cont) + (vazios.length ? ' — bloco vazio: ' + vazios.join(' ') : ''));
  const soma = MEMBROS.PPA.reduce((a, u) => a + A.historico[u].mes.liq_mwh, 0);
  ok(Math.abs(soma - A.historico.PPA.mes.liq_mwh) <= TOL_PPA + 1e-9, 'no produto, a soma das 6 usinas do PPA e a liquida do contrato no mes (' + r3(soma) + ' x ' + A.historico.PPA.mes.liq_mwh + ' MWh; folga ' + TOL_PPA + ')');
  console.log('· plantios no dado do momento (sem o caso no periodo: nao se aplica agora; o --lib cobre por construcao)');
  const gm = new Map((G.serie || []).map((s) => [s.mes, s]));
  const opM = A.corte.meses.filter((m) => m.fonte === 'operador' && gm.get(m.mes) && gm.get(m.mes).corte_final_gwh != null);
  /* o executivo publica o corte RECONCILIADO (rateio da auditoria de 09/08/2026) e o gemeo le o apurado bruto do operador. O erro e
     ABSOLUTO (revisor, RE-006): 5 MWh de arredondamento do corte_final_gwh (2 casas de GWh) + 0,005 MWh do executivo + o residuo da
     reconciliacao, medido ate 4,3 MWh em 7 meses (set/26: 21459,26 x 21,45 GWh = 9,26 MWh), com folga de 10 MWh. E detector de unidade
     e de troca grosseira (nao encolhe em mes pequeno); a troca de mes e pega pela identidade da soma das usinas, abaixo.
     TODOS os meses do operador do produto entram (nenhum descartado em silencio) */
  const FOLGA_GEMEO = 5 + 0.005 + 10;
  const nOp = A.corte.meses.filter((m) => m.fonte === 'operador').length;
  const longe = opM.filter((m) => Math.abs(m.Complexo - 1000 * gm.get(m.mes).corte_final_gwh) > FOLGA_GEMEO + 1e-9);
  ok(opM.length > 0 && opM.length === nOp && !longe.length, 'no produto, o corte do Complexo nos ' + opM.length + ' de ' + nOp + ' meses do operador e o corte_final_gwh do gemeo x 1000 (folga ' + FOLGA_GEMEO.toFixed(3) + ' MWh)'
    + (longe.length ? ' — difere: ' + longe.map((m) => m.mes + ' ' + m.Complexo + ' x ' + gm.get(m.mes).corte_final_gwh).join('; ') : ''));
  /* identidades do PRODUTO que nao passam pelo refaz (revisor, RE-005): nos meses do operador, soma das 9 = Complexo e PPA + ML = Complexo
     (cada numero com 2 casas: 10 e 3 arredondamentos de 0,005 MWh); nos meses do modelo, Complexo = corte_final_gwh x 1000 (meia unidade das
     2 casas de GWh = 5 MWh, mais 0,005 MWh) */
  const U9P = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
  const opsT = A.corte.meses.filter((m) => m.fonte === 'operador');
  const falta = (m) => ['Complexo'].concat(U9P, ['PPA', 'ML']).filter((e) => m[e] == null);
  const ops = opsT.filter((m) => !falta(m).length), fora = opsT.filter((m) => falta(m).length);
  const fu = ops.filter((m) => Math.abs(U9P.reduce((a, u) => a + m[u], 0) - m.Complexo) > 10 * 0.005 + 1e-9 || Math.abs(m.PPA + m.ML - m.Complexo) > 3 * 0.005 + 1e-9);
  ok(ops.length > 0 && !fu.length, 'no produto, nos ' + ops.length + ' de ' + opsT.length + ' meses do operador, a soma das 9 usinas e PPA + ML sao o Complexo'
    + (fora.length ? ' (fora, sem numero: ' + fora.map((m) => m.mes + ' ' + falta(m).join('/')).join('; ') + ')' : '') + (fu.length ? ' — difere: ' + fu.map((m) => m.mes).join(' ') : ''));
  const modsT = A.corte.meses.filter((m) => m.fonte === 'modelo' && m.Complexo != null);
  const mods = modsT.filter((m) => gm.get(m.mes) && gm.get(m.mes).corte_final_gwh != null);
  const fm = mods.filter((m) => Math.abs(m.Complexo - 1000 * gm.get(m.mes).corte_final_gwh) > 5 + 0.005 + 1e-9);
  /* os 6 meses do modelo (set/25 a fev/26) sao fechados para sempre: a conferencia nunca pode passar vazia */
  ok(mods.length > 0 && mods.length === modsT.length && !fm.length, 'no produto, nos ' + mods.length + ' de ' + modsT.length + ' meses do modelo o Complexo e o corte_final_gwh do gemeo x 1000 (folga 5 MWh)'
    + (fm.length ? ' — difere: ' + fm.map((m) => m.mes + ' ' + m.Complexo + ' x ' + gm.get(m.mes).corte_final_gwh).join('; ') : ''));
  PLANTIOS.forEach((p) => { const o = {}; o[p[0]] = true; const n = julga(A, refaz(W, S, I, ED, X, o, G)).dif.length; console.log('  ' + (n ? '✓' : '·') + ' plantio "' + p[1] + '": ' + (n ? 'reprova (' + n + ')' : 'nao se aplica agora')); });
  const B = JSON.parse(JSON.stringify(A)); delete B.perdas.Complexo;
  ok(julga(B, Rf).dif.length > 0, 'plantio "bloco de perdas sem o Complexo" reprova');
}

(async () => {
  try { if (process.argv.includes('--lib')) lib(); else await produto(); } catch (e) { falhas++; console.log('  ✗ ' + (e && e.stack || e)); }
  console.log(falhas ? 'REPROVADO (' + falhas + ')' : 'APROVADO');
  process.exit(falhas ? 1 : 0);
})();
