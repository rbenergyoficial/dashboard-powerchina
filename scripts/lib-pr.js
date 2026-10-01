/**
 * lib-pr.js - Performance Ratio do conjunto no ponto de conexao (230 kV), no estilo IEC 61724.
 *
 *   PR           = E_injetada / (P_CC_placa x H_plano / 1 kW/m2)
 *   PR corrigido = (E_injetada + E_impedida) / (P_CC_placa x H_plano / 1 kW/m2)
 *
 *   E_injetada   energia que SAI para a rede no 230 kV: soma, por instante de 5 min, de TR1 + TR2, so a parte
 *                POSITIVA. O consumo da madrugada e carga da usina, nao perda de conversao, e a energia injetada
 *                do modelo de projeto tambem nao o desconta. Nao e a LIQUIDA.
 *   E_impedida   a MESMA definicao do executivo: Sum max(0, gref - ger) x 0,5 h, so nas meias horas com lim > 0,
 *                fora dos dias em que a geracao publicada pelo operador e defeituosa. E ESTIMATIVA: a referencia
 *                do operador, e so nos meses em que ela vale (antes de mar/26 ela vem quebrada e o corte do
 *                executivo sai de um modelo MENSAL, que nao se reparte por dia — ali o corrigido fica nulo).
 *   P_CC_placa   425,677 MWp (placa: modulos x Wp, conferida em tres rotas no gen-perdas).
 *   H_plano      irradiacao no plano dos modulos, media das estacoes do parque, kWh/m2.
 *
 * Por que nao "tirar as horas restritas": medido em 16/09/2026, o operador limita quase todo meio-dia e sobravam
 * so 5 a 28 % da irradiacao do mes — manha e fim de tarde, onde qualquer usina rende menos. O numero saia 10 a
 * 15 pp abaixo do garantido por efeito de amostra.
 *
 * Resolucao: HORA (a irradiacao por hora cobre ~1 ano). Rotulos, medidos: o medidor rotula pelo FIM do
 * intervalo (00:05 cobre 00:00-00:05); irradiacao e operador, pelo INICIO. Tudo vira a hora de inicio.
 */
'use strict';

const P_CC_MWP = 425.677;
const TR = [6196, 6197];
const DIAS_EXCLUIDOS = new Set(['2026-03-03', '2026-03-11']);   /* os mesmos do executivo */

const r = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const num = v => { const n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : 0; };

function chaveHoraDoFim(rotulo) {
  const ms = Date.parse(rotulo + 'Z') - 60000;
  return new Date(ms).toISOString().slice(0, 13);
}

/* energia por hora: so hora com os 12 instantes dos DOIS trafos */
function energiaHoras(hist) {
  const serie = pid => { const s = ((hist && hist.dados) || []).find(x => x.pontoId === pid && x.nomeGrandeza === 'Demat'); return (s && s.valores) || []; };
  const m = new Map();
  for (const pid of TR) for (const v of serie(pid)) { if (v.valor == null) continue; const o = m.get(v.data) || {}; o[pid] = +v.valor; m.set(v.data, o); }
  const horas = new Map();
  for (const [rot, o] of m) {
    if (o[TR[0]] == null || o[TR[1]] == null) continue;
    const kw = o[TR[0]] + o[TR[1]], k = chaveHoraDoFim(rot);
    const h = horas.get(k) || { inj_mwh: 0, n: 0 };
    h.inj_mwh += Math.max(0, kw) * 5 / 60 / 1000; h.n += 1;
    horas.set(k, h);
  }
  for (const [k, h] of horas) if (h.n < 12) horas.delete(k);
  return horas;
}

/* do operador: energia impedida por hora e quantas meias horas o dia tem publicadas */
function operadorHoras(consolidado) {
  const impedida = new Map(), linhasDia = new Map();
  for (const x of consolidado || []) {
    const dia = String(x.ts).slice(0, 10), k = dia + 'T' + String(x.ts).slice(11, 13);
    linhasDia.set(dia, (linhasDia.get(dia) || 0) + 1);
    if (num(x.lim) > 0 && !DIAS_EXCLUIDOS.has(dia)) impedida.set(k, (impedida.get(k) || 0) + Math.max(0, (num(x.gref) - num(x.ger)) * 0.5));
  }
  return { impedida, linhasDia };
}

function irradiacaoHoras(serie) {
  const m = new Map();
  for (const x of serie || []) if (x.Complexo != null && isFinite(x.Complexo)) m.set(x.t.slice(0, 13), Math.max(0, x.Complexo) / 1000);
  return m;
}

const PISO_HORAS = 22;
const PISO_LINHAS_OPERADOR = 44;
const TETO_PR = 110;            /* acima disto e sensor ou dado quebrado */
const FAIXA_CORRIGIDO = [30, 110];

/* mesesApurados: Set 'AAAA-MM' em que o corte do executivo vem da referencia do operador */
function prDia(dia, eH, gH, op, mesesApurados) {
  let E = 0, H = 0, C = 0, validas = 0;
  for (let h = 0; h < 24; h++) {
    const k = dia + 'T' + String(h).padStart(2, '0'), e = eH.get(k), g = gH.get(k);
    if (!e || g == null) continue;
    validas++; E += e.inj_mwh; H += g; C += op.impedida.get(k) || 0;
  }
  const o = { dia, horas_validas: validas, inj_mwh: r(E, 3), h_kwh_m2: r(H, 4), impedida_mwh: null, pr_pct: null, pr_corrigido_pct: null, nota: null, nota_corrigido: null };
  if (validas < PISO_HORAS) { o.nota = 'dia incompleto: ' + validas + ' de 24 horas com energia e irradiacao'; return o; }
  const pr = H > 0 ? 100 * E / (P_CC_MWP * H) : null;
  if (pr == null || pr > TETO_PR) { o.nota = 'PR acima de ' + TETO_PR + ' % ou sem irradiacao: dado inconsistente'; return o; }
  o.pr_pct = r(pr, 2);
  if (!mesesApurados.has(dia.slice(0, 7))) { o.nota_corrigido = 'referencia do operador quebrada neste mes: o corte sai de modelo mensal'; return o; }
  if (DIAS_EXCLUIDOS.has(dia)) { o.nota_corrigido = 'geracao publicada pelo operador defeituosa neste dia'; return o; }
  if ((op.linhasDia.get(dia) || 0) < PISO_LINHAS_OPERADOR) { o.nota_corrigido = 'operador ainda nao publicou o dia'; return o; }
  const pc = 100 * (E + C) / (P_CC_MWP * H);
  o.impedida_mwh = r(C, 3);
  if (pc < FAIXA_CORRIGIDO[0] || pc > FAIXA_CORRIGIDO[1]) { o.nota_corrigido = 'PR corrigido fora de ' + FAIXA_CORRIGIDO.join('-') + ' %'; return o; }
  o.pr_corrigido_pct = r(pc, 2);
  return o;
}

/* o mes soma ENERGIA e IRRADIACAO dos dias validos — nunca a media dos PR diarios */
function prMeses(dias) {
  const por = new Map();
  for (const d of dias) {
    const mes = d.dia.slice(0, 7), m = por.get(mes) || { mes, dias: 0, diasC: 0, E: 0, H: 0, EC: 0, HC: 0, C: 0 };
    if (d.pr_pct != null) { m.dias++; m.E += d.inj_mwh; m.H += d.h_kwh_m2; }
    if (d.pr_corrigido_pct != null) { m.diasC++; m.EC += d.inj_mwh; m.HC += d.h_kwh_m2; m.C += d.impedida_mwh; }
    por.set(mes, m);
  }
  return [...por.values()].sort((a, b) => a.mes < b.mes ? -1 : 1).map(m => {
    const [a, mm] = m.mes.split('-').map(Number), n = new Date(Date.UTC(a, mm, 0)).getUTCDate();
    return { mes: m.mes, dias_no_mes: n, dias_validos: m.dias, dias_corrigido: m.diasC,
      pr_pct: m.dias && m.H > 0 ? r(100 * m.E / (P_CC_MWP * m.H), 2) : null,
      pr_corrigido_pct: m.diasC && m.HC > 0 ? r(100 * (m.EC + m.C) / (P_CC_MWP * m.HC), 2) : null,
      inj_mwh: r(m.E, 1), h_kwh_m2: r(m.H, 2), impedida_mwh: m.diasC ? r(m.C, 1) : null };
  });
}

/* ── O DIA EM MEIAS HORAS (24/09/2026) ────────────────────────────────────────────────────────────────────────────
 * O PR por hora ingenuo (energia da hora / irradiacao da hora) sai 87 % de manha e 54 % a tarde no mesmo dia: a
 * irradiacao da estacao e AMOSTRA INSTANTANEA em T, nao a media de [T, T+30). Medido em 15 dias contra o medidor de
 * 5 min, meias horas sem limitacao: janela [T,T+30) erra 20,5 MW; centrada [T-15,T+15), 7,2 MW; TRAPEZIO das amostras
 * T e T+30 contra a energia de [T,T+30), 9,8 MW, com manha e tarde simetricas (71,4 e 69,1 %). Fica o trapezio porque
 * poe as tres grandezas na MESMA meia hora em que o operador publica a limitacao — sem isso o corrigido somaria a
 * impedida de uma janela a energia de outra.
 * O dia soma as mesmas amostras: Sum trapezio = Sum amostras x 0,5 h, que e a irradiacao do dia do prDia.
 * Piso: a razao so existe com irradiancia de pelo menos 100 W/m2, o limiar do anexo do contrato (o mesmo da janela
 * da disponibilidade). Abaixo dele o amanhecer e o fim da tarde dividem numeros pequenos e a razao nao significa nada. */
const PISO_IRR_MEIA = 100;   /* W/m2 */
const chaveMeiaDoFim = rotulo => { const ms = Date.parse(rotulo + 'Z') - 60000; return new Date(Math.floor(ms / 18e5) * 18e5).toISOString().slice(0, 16); };
const meiaSeguinte = k => new Date(Date.parse(k + ':00Z') + 18e5).toISOString().slice(0, 16);

/* energia por meia hora [T,T+30): so meia hora com os 6 instantes dos DOIS trafos */
function energiaMeias(hist) {
  const serie = pid => { const s = ((hist && hist.dados) || []).find(x => x.pontoId === pid && x.nomeGrandeza === 'Demat'); return (s && s.valores) || []; };
  const m = new Map();
  for (const pid of TR) for (const v of serie(pid)) { if (v.valor == null) continue; const o = m.get(v.data) || {}; o[pid] = +v.valor; m.set(v.data, o); }
  const meias = new Map();
  for (const [rot, o] of m) {
    if (o[TR[0]] == null || o[TR[1]] == null) continue;
    const k = chaveMeiaDoFim(rot), h = meias.get(k) || { inj_mwh: 0, n: 0 };
    h.inj_mwh += Math.max(0, o[TR[0]] + o[TR[1]]) * 5 / 60 / 1000; h.n += 1;
    meias.set(k, h);
  }
  for (const [k, h] of meias) if (h.n < 6) meias.delete(k);
  return meias;
}

/* amostras instantaneas da media das estacoes, por instante 'AAAA-MM-DDTHH:MM' (hora local) */
function amostrasIrr(serie, col) {
  const m = new Map();
  for (const x of serie || []) { const v = x[col]; if (v != null && isFinite(v)) m.set(String(x.t).slice(0, 16), Math.max(0, v)); }
  return m;
}

function impedidaMeias(consolidado) {
  const m = new Map();
  for (const x of consolidado || []) {
    const k = String(x.ts).slice(0, 16).replace(' ', 'T'), dia = k.slice(0, 10);
    if (num(x.lim) > 0 && !DIAS_EXCLUIDOS.has(dia)) m.set(k, (m.get(k) || 0) + Math.max(0, (num(x.gref) - num(x.ger)) * 0.5));
  }
  return m;
}

/* diaRow: a linha do prDia do mesmo dia. O corrigido so existe na meia hora quando existe no DIA — o dia ja decidiu se
   o mes e apurado, se o dia e excluido e se o operador publicou o dia inteiro; a meia hora nao reabre essas perguntas. */
function prMeias(dia, eM, sM, impM, diaRow) {
  const inj = [], imp = [], pr = [], prc = [], irr = [];
  let acima = 0, acimaC = 0;
  const comC = !!(diaRow && diaRow.pr_corrigido_pct != null);
  for (let i = 0; i < 48; i++) {
    const k = dia + 'T' + String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
    const e = eM.get(k), s0 = sM.get(k), s1 = sM.get(meiaSeguinte(k));
    const w = s0 != null && s1 != null ? (s0 + s1) / 2 : null, c = comC ? (impM.get(k) || 0) : null;
    inj.push(e ? r(e.inj_mwh, 3) : null); irr.push(w == null ? null : r(w, 1));   /* irradiacao da meia hora = irr / 2000 kWh/m2 */
    imp.push(c == null ? null : r(c, 3));
    const vale = e && w != null && w >= PISO_IRR_MEIA, den = P_CC_MWP * w / 2000;
    const p = vale ? 100 * e.inj_mwh / den : null, pc = vale && comC ? 100 * (e.inj_mwh + c) / den : null;
    /* o mesmo teto do dia: acima de 110 % a meia hora sai VAZIA e e CONTADA (nuvem passando entre duas amostras
       instantaneas faz isso; a tela diz quantas sairam em vez de desenhar um pico que nao e rendimento) */
    if (p != null && p > TETO_PR) acima++; if (pc != null && pc > TETO_PR) acimaC++;
    pr.push(p == null || p > TETO_PR ? null : r(p, 1)); prc.push(pc == null || pc > TETO_PR ? null : r(pc, 1));
  }
  const o = { dia, inj, irr, imp: comC ? imp : null, pr, prc: comC ? prc : null };
  if (acima) o.acima_teto = acima; if (acimaC) o.acima_teto_corrigido = acimaC;
  return o;
}

/* ── O PR POR ENTIDADE (01/10/2026, PROMOVER pr-entidade) ─────────────────────────────────────────────────────────────
 * O mesmo PR, por usina e por contrato. Diferencas declaradas contra o do conjunto:
 *   energia      a dos CIRCUITOS de 34,5 kV de cada usina (lib-horas CIRC), por instante de 5 min, so a parte POSITIVA,
 *                hora so com os 12 instantes de TODOS os circuitos da usina. E energia antes da transformacao: a soma
 *                das nove fica 0,32 a 0,47 % acima da do 230 kV (medido em 23 dias de ago-set/26) — o PR de uma usina
 *                nao se compara 1:1 com o do conjunto.
 *   irradiacao   a da estacao da propria usina (coluna Mx do irr_60min).
 *   placa        potencia CC da usina (lib-placa, cc_kwp).
 *   impedida     o corte DIARIO reconciliado por usina do executivo (`corte_diario_ufv.cortado_mwh`): a mesma energia que
 *                o executivo atribui a cada usina, e que fecha com o corte do contrato.
 * Cada linha leva `den_mwh` = placa x irradiacao: contrato e mes saem de soma da energia / soma do denominador, nunca de
 * media de PR. O contrato so tem dia quando TODAS as usinas dele tem (senao o PR do contrato seria o de uma parte). */
const { CIRC: CIRC_UFV, PPA: UFV_PPA, ML: UFV_ML } = require('./lib-horas.js');
const GRUPOS = { PPA: UFV_PPA, ML: UFV_ML };

function energiaHorasUfv(hist) {
  const porPonto = new Map();
  for (const s of (hist && hist.dados) || []) {
    if (s.nomeGrandeza !== 'Demat') continue;
    const m = new Map();
    for (const v of s.valores || []) if (v.valor != null) m.set(v.data, +v.valor);
    porPonto.set(s.pontoId, m);
  }
  const out = new Map();
  for (const [u, pts] of Object.entries(CIRC_UFV)) {
    const horas = new Map(), base = porPonto.get(pts[0]);
    if (!base || pts.some((p) => !porPonto.has(p))) { out.set(u, horas); continue; }
    for (const rot of base.keys()) {
      if (pts.some((p) => !porPonto.get(p).has(rot))) continue;
      const kw = pts.reduce((a, p) => a + Math.max(0, porPonto.get(p).get(rot)), 0), k = chaveHoraDoFim(rot);
      const h = horas.get(k) || { inj_mwh: 0, n: 0 };
      h.inj_mwh += kw * 5 / 60 / 1000; h.n += 1; horas.set(k, h);
    }
    for (const [k, h] of horas) if (h.n < 12) horas.delete(k);
    out.set(u, horas);
  }
  return out;
}

function irradiacaoHorasUfv(serie) {
  const out = new Map(Object.keys(CIRC_UFV).map((u) => [u, new Map()]));
  for (const x of serie || []) for (const u of Object.keys(CIRC_UFV)) {
    const v = x[u]; if (v != null && isFinite(v)) out.get(u).set(x.t.slice(0, 13), Math.max(0, v) / 1000);
  }
  return out;
}

/* cortado: MWh impedidos da usina no dia (null = nao apurado) */
function prDiaUfv(dia, eH, gH, pccMwp, cortado) {
  let E = 0, H = 0, validas = 0;
  for (let h = 0; h < 24; h++) {
    const k = dia + 'T' + String(h).padStart(2, '0'), e = eH.get(k), g = gH.get(k);
    if (!e || g == null) continue;
    validas++; E += e.inj_mwh; H += g;
  }
  const den = pccMwp * H;
  const o = { dia, horas_validas: validas, inj_mwh: r(E, 3), den_mwh: r(den, 3), impedida_mwh: null, pr_pct: null, pr_corrigido_pct: null, nota: null, nota_corrigido: null };
  if (validas < PISO_HORAS) { o.nota = 'dia incompleto: ' + validas + ' de 24 horas com energia e irradiacao'; return o; }
  const pr = den > 0 ? 100 * E / den : null;
  if (pr == null || pr > TETO_PR) { o.nota = 'PR acima de ' + TETO_PR + ' % ou sem irradiacao: dado inconsistente'; return o; }
  o.pr_pct = r(pr, 2);
  if (cortado == null) { o.nota_corrigido = 'corte da usina nao apurado neste dia'; return o; }
  if (DIAS_EXCLUIDOS.has(dia)) { o.nota_corrigido = 'geracao publicada pelo operador defeituosa neste dia'; return o; }
  const pc = 100 * (E + cortado) / den;
  o.impedida_mwh = r(cortado, 3);
  if (pc < FAIXA_CORRIGIDO[0] || pc > FAIXA_CORRIGIDO[1]) { o.nota_corrigido = 'PR corrigido fora de ' + FAIXA_CORRIGIDO.join('-') + ' %'; return o; }
  o.pr_corrigido_pct = r(pc, 2);
  return o;
}

/* o contrato no dia: so com todas as usinas validas; o corrigido, so com todas corrigidas */
function prDiaGrupo(dia, linhas) {
  const o = { dia, inj_mwh: null, den_mwh: null, impedida_mwh: null, pr_pct: null, pr_corrigido_pct: null, nota: null, nota_corrigido: null };
  const sem = linhas.filter((x) => !x || x.pr_pct == null).length;
  if (sem) { o.nota = 'usina sem PR no dia: ' + sem + ' de ' + linhas.length; return o; }
  const E = linhas.reduce((a, x) => a + x.inj_mwh, 0), D = linhas.reduce((a, x) => a + x.den_mwh, 0);
  Object.assign(o, { inj_mwh: r(E, 3), den_mwh: r(D, 3), pr_pct: D > 0 ? r(100 * E / D, 2) : null });
  if (linhas.some((x) => x.pr_corrigido_pct == null)) { o.nota_corrigido = 'usina sem PR corrigido no dia'; return o; }
  const C = linhas.reduce((a, x) => a + x.impedida_mwh, 0);
  Object.assign(o, { impedida_mwh: r(C, 3), pr_corrigido_pct: D > 0 ? r(100 * (E + C) / D, 2) : null });
  return o;
}

/* o mes da entidade: soma energia e denominador dos dias validos */
function prMesesEnt(dias) {
  const por = new Map();
  for (const d of dias) {
    const mes = d.dia.slice(0, 7), m = por.get(mes) || { mes, dias: 0, diasC: 0, E: 0, D: 0, EC: 0, DC: 0, C: 0 };
    if (d.pr_pct != null) { m.dias++; m.E += d.inj_mwh; m.D += d.den_mwh; }
    if (d.pr_corrigido_pct != null) { m.diasC++; m.EC += d.inj_mwh; m.DC += d.den_mwh; m.C += d.impedida_mwh; }
    por.set(mes, m);
  }
  return [...por.values()].sort((a, b) => a.mes < b.mes ? -1 : 1).map((m) => {
    const [a, mm] = m.mes.split('-').map(Number);
    return { mes: m.mes, dias_no_mes: new Date(Date.UTC(a, mm, 0)).getUTCDate(), dias_validos: m.dias, dias_corrigido: m.diasC,
      pr_pct: m.dias && m.D > 0 ? r(100 * m.E / m.D, 2) : null,
      pr_corrigido_pct: m.diasC && m.DC > 0 ? r(100 * (m.EC + m.C) / m.DC, 2) : null,
      inj_mwh: r(m.E, 1), den_mwh: r(m.D, 1), impedida_mwh: m.diasC ? r(m.C, 1) : null };
  });
}

module.exports = { P_CC_MWP, DIAS_EXCLUIDOS, chaveHoraDoFim, energiaHoras, operadorHoras, irradiacaoHoras, prDia, prMeses, PISO_HORAS, PISO_LINHAS_OPERADOR, TETO_PR, FAIXA_CORRIGIDO,
  PISO_IRR_MEIA, chaveMeiaDoFim, energiaMeias, amostrasIrr, impedidaMeias, prMeias,
  CIRC_UFV, GRUPOS, energiaHorasUfv, irradiacaoHorasUfv, prDiaUfv, prDiaGrupo, prMesesEnt };
