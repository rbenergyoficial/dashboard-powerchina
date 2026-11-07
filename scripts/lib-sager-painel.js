'use strict';
/*
 * lib-sager-painel.js — o Painel SAGER-ONS: junta, por patamar de 30 min e por usina, o Relatorio Geral do SAGER, os dados abertos do ONS,
 * o medidor de faturamento (Way2) e o supervisorio (lote painel-sager-ons, 06/11/2026).
 *
 * Regra do humano (22/10/2026): todo dado novo do SAGER e analisado por inteiro. Por isso `conferencia` passa todos os campos do relatorio.
 * Regras de leitura:
 *   · colunas sempre pelo NOME do cabecalho: a ordem das usinas no relatorio e M3, M1, M2, M4...
 *   · a disponibilidade por usina e a PUBLICADA (lib-sager-disp), nunca a proposta, que fica em `prop`;
 *   · o conjunto so tem limitacao, referencia e referencia final; a participacao por usina reparte a referencia final;
 *   · SAGER em MWh/h = MW; Way2 e SCADA chegam do cmp_30min.json em MWh por 30 min e viram MW (× 2);
 *   · dia inteiro de uma fonte = os 48 patamares; dia partido nao entra em conta de energia daquela fonte;
 *   · energia impedida = soma de max(0, referencia final − verificada) × 0,5 nos patamares com limitacao.
 * O arquivo diz o que mede; nenhum limite de aceitacao sai daqui: as tolerancias de `conferencia` sao arredondamento das fontes.
 */
const { extrai, usinaDe, USINAS } = require('./lib-sager-disp');

const US = USINAS.map((n) => 'M' + n);
const ESQUEMA = 1, TOL = 0.05;
const r3 = (v) => (v == null ? null : +v.toFixed(3));
const num = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
function col(ref) { const m = /^([A-Z]+)(\d+)$/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return { c: n, r: +m[2] }; }
function nomeCol(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }

/* o Relatorio Geral inteiro: o conjunto e cada grupo por usina; estoura se faltar coluna, patamar repetido ou dia partido */
function leRelatorio(x) {
  const base = extrai(x), { cel } = x;
  let rCab = null;
  for (const [ref, c] of cel) { const p = col(ref); if (p.c === 1 && /^data$/i.test(String(c.v || '').trim())) { rCab = p.r; break; } }
  const cab = [...cel].map(([ref, c]) => ({ ...col(ref), v: String(c.v || '').replace(/\s+/g, ' ').trim() }));
  const grupos = cab.filter((p) => p.r === rCab - 1 && p.v).sort((a, b) => a.c - b.c);
  const faixa = (rx) => { const i = grupos.findIndex((g) => rx.test(g.v)); if (i < 0) throw new Error('grupo ausente: ' + rx); return [grupos[i].c, i + 1 < grupos.length ? grupos[i + 1].c - 1 : 1e9]; };
  const mapa = (f) => { const m = {}; for (const p of cab) if (p.r === rCab && p.c >= f[0] && p.c <= f[1]) { const u = usinaDe(p.v); if (u) m['M' + u] = p.c; } return m; };
  const cR = mapa(faixa(/^participa/i)), cI = mapa(faixa(/^dados irradi/i));
  for (const u of US) if (!cR[u] || !cI[u]) throw new Error('sem a coluna de participacao ou irradiancia de ' + u);
  const acha = (rx) => { const p = cab.find((q) => q.r === rCab && rx.test(q.v)); if (!p) throw new Error('coluna ausente: ' + rx); return p.c; };
  const C = { gv: acha(/^gera[cç][aã]o verificada \(/i), lim: acha(/^gera[cç][aã]o limitada/i), gref: acha(/^gera[cç][aã]o de refer[eê]ncia \(/i), gfin: acha(/^gera[cç][aã]o de refer[eê]ncia final/i), raz: acha(/^raz[aã]o/i), ori: acha(/^origem/i) };
  const serie = base.serie.map((o, i) => {
    const r = rCab + 1 + i, v = (c) => { const k = cel.get(nomeCol(c) + r); return k ? k.v : null; };
    return { t: o.t, gv: num(v(C.gv)), lim: num(v(C.lim)), disp: o.cx, gref: num(v(C.gref)), gfin: num(v(C.gfin)), raz: String(v(C.raz) || ''), ori: String(v(C.ori) || ''),
      s: o.g, p: o.p, prop: o.c, ins: o.i, ref: US.map((u) => num(v(cR[u]))), irr: US.map((u) => num(v(cI[u]))) };
  });
  const dias = {};
  serie.forEach((s) => { const d = s.t.slice(0, 10); dias[d] = (dias[d] || 0) + 1; });
  for (const [d, n] of Object.entries(dias)) if (n !== 48) throw new Error(d + ': ' + n + ' patamares (o dia do SAGER tem 48)');
  return serie;
}

/* cada fonte como Map por instante local 'AAAA-MM-DDTHH:MM' */
function indiceCmp(cmp) { const m = new Map(); for (const x of (cmp && cmp.serie) || []) m.set(String(x.t).slice(0, 16), x); return m; }
function indiceOns(listas) {
  const R = new Map(), U = new Map();
  for (const j of listas.restricao) for (const x of (j && j.consolidado) || []) R.set(String(x.ts).slice(0, 16).replace(' ', 'T'), x);
  for (const j of listas.irradiancia) for (const x of (j && j.consolidado) || []) U.set(String(x.ts).slice(0, 16).replace(' ', 'T') + '|M' + String(x.u).slice(-1), x);
  return { R, U };
}
function indiceEstacao(j) { const m = new Map(); for (const x of (j && j.serie) || []) m.set(String(x.t).slice(0, 16), x); return m; }

const vazioU = () => ({ s: [], o: [], w: [], k: [], ref: [], ge: [], irr: [], irr_o: [], irr_e: [], disp: [], prop: [], ins: [] });
/* um mes: arrays alinhados com `t` */
function mesDe(serie, mes, F) {
  const L = serie.filter((s) => s.t.slice(0, 7) === mes);
  const o = { esquema: ESQUEMA, mes, t: L.map((s) => s.t), c: { gv: [], lim: [], disp: [], gref: [], gfin: [], o_gv: [], o_lim: [], o_disp: [], o_gref: [] }, raz: [], ori: [], o_raz: [], u: {} };
  US.forEach((u) => { o.u[u] = vazioU(); });
  for (const s of L) {
    const q = F.ons.R.get(s.t) || {}, x = F.cmp.get(s.t) || {}, e = F.est.get(s.t) || {};
    for (const k of ['gv', 'lim', 'disp', 'gref', 'gfin']) o.c[k].push(r3(s[k]));
    o.c.o_gv.push(r3(num(q.ger))); o.c.o_lim.push(r3(num(q.lim))); o.c.o_disp.push(r3(num(q.disp))); o.c.o_gref.push(r3(num(q.gref)));
    o.raz.push(s.raz); o.ori.push(s.ori); o.o_raz.push(String(q.razao || ''));
    US.forEach((u, i) => {
      const n = i + 1, U = o.u[u], d = F.ons.U.get(s.t + '|' + u) || {};
      U.s.push(r3(s.s[i])); U.ref.push(r3(s.ref[i])); U.irr.push(r3(s.irr[i])); U.disp.push(r3(s.p[i])); U.prop.push(r3(s.prop[i])); U.ins.push(s.ins[i]);
      U.o.push(r3(num(d.gv))); U.ge.push(r3(num(d.ge))); U.irr_o.push(r3(num(d.irr))); U.irr_e.push(r3(num(e['e' + n])));
      const w = x['w' + n], k = x['s' + n];
      U.w.push(w == null ? null : r3(w * 2)); U.k.push(k == null ? null : r3(k * 2));
    });
  }
  return o;
}

/* por dia: o que a pagina pinta sem baixar os meses. `real` = disponibilidade pelo estado dos inversores (sg_disp_dia), em MW medios */
function diario(meses, sgDisp, cap) {
  const D = { dias: [], c: { gv: [], gfin: [], gref: [], lim_n: [], ene: [], cnf: [], outra: [], ab_n: [], ab_pub: [], ab_pro: [], cx_pro: [] }, u: {} };
  US.forEach((u) => { D.u[u] = { s: [], o: [], w: [], k: [], disp: [], real: [], prop: [], zeros: [], dpr: [], pend_n: [], corr_n: [] }; });
  const sg = new Map(((sgDisp && sgDisp.serie) || []).map((x) => [x.dia, x]));
  for (const m of meses) {
    const grupo = new Map();
    m.t.forEach((t, i) => { const d = t.slice(0, 10); if (!grupo.has(d)) grupo.set(d, []); grupo.get(d).push(i); });
    for (const [d, I] of grupo) {
      D.dias.push(d);
      const c = m.c, soma = (k) => +I.reduce((a, i) => a + (c[k][i] || 0) / 2, 0).toFixed(2);
      D.c.gv.push(soma('gv')); D.c.gfin.push(soma('gfin')); D.c.gref.push(soma('gref')); D.c.lim_n.push(I.filter((i) => c.lim[i]).length);
      const imp = { ENE: 0, CNF: 0, outra: 0 };
      for (const i of I) if (c.lim[i] && c.gfin[i] != null && c.gv[i] != null) { const k = m.raz[i] in imp ? m.raz[i] : 'outra'; imp[k] += Math.max(0, c.gfin[i] - c.gv[i]) / 2; }
      D.c.ene.push(+imp.ENE.toFixed(2)); D.c.cnf.push(+imp.CNF.toFixed(2)); D.c.outra.push(+imp.outra.toFixed(2));
      /* painel-sager-ons-v2: o conjunto dos dados abertos contra o conjunto publicado e contra a soma com a proposta, nas meias horas com geracao */
      const sPro = (i) => US.reduce((a, u) => a + ((m.u[u].prop[i] != null ? m.u[u].prop[i] : m.u[u].disp[i]) || 0), 0);
      const Ig = I.filter((i) => c.gv[i] > 0 && c.o_disp[i] != null && c.disp[i] != null);
      D.c.ab_n.push(Ig.length);
      D.c.ab_pub.push(Ig.filter((i) => Math.abs(c.o_disp[i] - c.disp[i]) <= 0.35).length);
      D.c.ab_pro.push(Ig.filter((i) => Math.abs(c.o_disp[i] - sPro(i)) <= 0.35).length);
      D.c.cx_pro.push(I.filter((i) => c.disp[i] != null && Math.abs(c.disp[i] - sPro(i)) <= 0.35).length);
      for (const u of US) {
        const U = m.u[u], X = D.u[u], e = (k) => (I.every((i) => U[k][i] != null) ? +I.reduce((a, i) => a + U[k][i] / 2, 0).toFixed(3) : null);
        X.s.push(e('s')); X.o.push(e('o')); X.w.push(e('w')); X.k.push(e('k'));
        X.disp.push(+(I.reduce((a, i) => a + (U.disp[i] || 0), 0) / I.length).toFixed(3));
        const pct = (sg.get(d) || {})[u + '_disp_24h_pct'];
        X.real.push(pct == null ? null : +(pct / 100 * cap[u]).toFixed(3));
        X.prop.push(+I.reduce((a, i) => a + (U.prop[i] != null ? Math.max(0, U.prop[i] - (U.disp[i] || 0)) / 2 : 0), 0).toFixed(2));
        X.zeros.push(I.filter((i) => U.disp[i] === 0).length);
        /* painel-sager-ons-v2: a celula contestada esta pendente enquanto a publicada fica mais de 0,1 MW abaixo da proposta; igual ou acima, corrigida */
        X.dpr.push(+(I.reduce((a, i) => a + ((U.prop[i] != null ? U.prop[i] : U.disp[i]) || 0), 0) / I.length).toFixed(3));
        X.pend_n.push(I.filter((i) => U.prop[i] != null && U.prop[i] - (U.disp[i] || 0) > 0.1).length);
        X.corr_n.push(I.filter((i) => U.prop[i] != null && U.prop[i] - (U.disp[i] || 0) <= 0.1).length);
      }
    }
  }
  return D;
}

/* todos os campos do relatorio contra as outras fontes, em todo o historico */
function conferencia(meses) {
  const R = [];
  const conta = (it) => { let n = 0, m = 0, x = 0; for (const [a, b, tol] of it) { if (a == null || b == null) continue; n++; const d = Math.abs(a - b); if (d > tol) m++; if (d > x) x = d; } return { n, dif: m, max: +x.toFixed(3) }; };
  const porU = (fa, fb, tol) => function* () { for (const m of meses) for (const u of US) for (let i = 0; i < m.t.length; i++) yield [m.u[u][fa][i], m.u[u][fb][i], tol]; };
  const porC = (fa, fb, tol) => function* () { for (const m of meses) for (let i = 0; i < m.t.length; i++) yield [fa(m, i), fb(m, i), tol]; };
  const add = (id, campo, contra, un, g) => R.push({ id, campo, contra, un, ...conta(g()) });
  add('gv_usina_ons', 'Geração verificada por usina', 'Dados abertos do ONS', 'MW', porU('s', 'o', TOL));
  add('gv_usina_smf', 'Geração verificada por usina', 'Medidor de faturamento, acima de 2 MW', 'MW', porU('s', 'w', 2));
  add('gv_usina_scada', 'Geração verificada por usina', 'Supervisório, acima de 2 MW', 'MW', porU('s', 'k', 2));
  add('gv_conj_soma', 'Geração verificada do conjunto', 'Soma das nove usinas', 'MW', porC((m, i) => m.c.gv[i], (m, i) => US.reduce((a, u) => a + (m.u[u].s[i] || 0), 0), 0.11));
  add('lim_ons', 'Geração limitada', 'Dados abertos do ONS', 'MW', porC((m, i) => m.c.lim[i], (m, i) => m.c.o_lim[i], TOL));
  add('disp_ons', 'Disponibilidade do conjunto', 'Dados abertos do ONS', 'MW', porC((m, i) => m.c.disp[i], (m, i) => m.c.o_disp[i], TOL));
  add('disp_soma', 'Disponibilidade do conjunto', 'Soma das nove usinas publicadas', 'MW', porC((m, i) => m.c.disp[i], (m, i) => US.reduce((a, u) => a + (m.u[u].disp[i] || 0), 0), 0.35));
  add('disp_soma_prop', 'Disponibilidade do conjunto', 'Soma com a proposta do agente', 'MW', porC((m, i) => m.c.disp[i], (m, i) => US.reduce((a, u) => a + ((m.u[u].prop[i] != null ? m.u[u].prop[i] : m.u[u].disp[i]) || 0), 0), 0.35));
  add('irr_ons', 'Irradiância por usina', 'Dados abertos do ONS', 'W/m²', porU('irr', 'irr_o', 0.5));
  add('irr_est', 'Irradiância por usina', 'Estação da usina, acima de 50 W/m²', 'W/m²', porU('irr', 'irr_e', 50));
  add('gref_ons', 'Geração de referência', 'Dados abertos do ONS', 'MW', porC((m, i) => m.c.gref[i], (m, i) => m.c.o_gref[i], TOL));
  add('gfin_soma', 'Referência final', 'Soma das participações por usina', 'MW', porC((m, i) => (US.some((u) => m.u[u].ref[i] != null) ? US.reduce((a, u) => a + (m.u[u].ref[i] || 0), 0) : null), (m, i) => m.c.gfin[i], 0.1));
  let raz = 0, nr = 0;
  for (const m of meses) m.t.forEach((t, i) => { nr++; if ((m.raz[i] || '') !== (m.o_raz[i] || '')) raz++; });
  R.push({ id: 'raz_ons', campo: 'Razão da restrição', contra: 'Dados abertos do ONS', un: '', n: nr, dif: raz, max: null });
  return R;
}

/* a soma do Complexo por fonte, com a regra de dia inteiro: o que a pagina diz e o ensaio refaz por outro caminho */
function resumo(D) {
  const soma = (k, I) => I.reduce((a, i) => a + US.reduce((b, u) => b + (D.u[u][k][i] || 0), 0), 0);
  const todos = D.dias.map((_, i) => i), comK = todos.filter((i) => US.every((u) => D.u[u].k[i] != null));
  return { dias: D.dias.length, dias_scada: comK.length, s_w_pct: +(soma('s', todos) / soma('w', todos) * 100).toFixed(2), k_w_pct: comK.length ? +(soma('k', comK) / soma('w', comK) * 100).toFixed(2) : null };
}

function guarda(serie, D, C, cap) {
  for (const s of serie) s.p.forEach((v, i) => { if (v != null && v > cap[US[i]] * 1.02) throw new Error(s.t + ': disponibilidade de ' + US[i] + ' acima de 102 % da capacidade (' + v + ')'); });
  const g = C.find((x) => x.id === 'gv_conj_soma');
  if (g.dif) throw new Error('a geracao do conjunto nao fecha com a soma das usinas em ' + g.dif + ' patamares');
  const fr = C.find((x) => x.id === 'gfin_soma');
  if (fr.dif) throw new Error('a referencia final nao fecha com as participacoes em ' + fr.dif + ' patamares');
  if (!D.dias.length) throw new Error('nenhum dia');
}

/* painel-sager-ons-v2: o registro da contestacao. `base` = o maior pendente ja visto naquele dia e usina (MW·h), lido da rodada anterior;
   quando o ONS republica e a publicada alcanca a proposta, o pendente cai e a base fica: corrigido = base − pendente. Sem rodada anterior, base = pendente */
function registro(D, ant) {
  const pos = new Map(((ant && ant.dias) || []).map((d, i) => [d, i]));
  for (const u of US) {
    const X = D.u[u], A = ant && ant.u && ant.u[u] && (ant.u[u].base || ant.u[u].prop);
    X.base = D.dias.map((d, i) => { const j = pos.get(d), a = A && j != null ? A[j] : null; return +Math.max(X.prop[i], a == null ? 0 : a).toFixed(2); });
  }
}

/* tudo junto. F = { serie (leRelatorio), cmp, ons:{restricao,irradiancia}, est, sg, cap, gerado, anterior (o indice da rodada anterior, ou nulo) } */
function compoe(F) {
  const idx = { cmp: indiceCmp(F.cmp), ons: indiceOns(F.ons), est: indiceEstacao(F.est) };
  const ms = [...new Set(F.serie.map((s) => s.t.slice(0, 7)))].sort();
  const meses = ms.map((m) => mesDe(F.serie, m, idx));
  const D = diario(meses, F.sg, F.cap), C = conferencia(meses);
  registro(D, F.anterior);
  guarda(F.serie, D, C, F.cap);
  return { indice: { esquema: ESQUEMA, gerado: F.gerado, de: D.dias[0], ate: D.dias[D.dias.length - 1], meses: ms, usinas: US, ...D, resumo: resumo(D), conferencia: C }, meses };
}

module.exports = { ESQUEMA, US, leRelatorio, mesDe, diario, conferencia, resumo, registro, compoe, indiceCmp, indiceOns, indiceEstacao };
