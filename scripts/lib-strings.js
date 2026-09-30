'use strict';
/*
 * lib-strings.js — quais entradas de corrente do inversor sao STRINGS DE VERDADE, qual e a mais fraca, e quando uma
 * string esta MORTA ou FRACA (30/09/2026, PROMOVER strings-lote1).
 *
 * 🔴 O DEFEITO QUE ISTO CORRIGE. A dispersao entre strings e entre MPPTs descartava so a corrente EXATAMENTE zero
 *    (`x > 0`). Errava nos dois sentidos:
 *    - ENTRADA VAZIA com corrente residual entrava na conta: o MPPT 12 do M2/TS2/INV10, sem string nenhuma, le
 *      0,27 A e virava o "MPPT mais fraco, 1,8 %" (05/09/2026); no INV11 ao lado le zero exato e saia. O painel
 *      desenhava um falso alarme que alternava de um dia para o outro;
 *    - STRING MORTA de verdade, com leitura zero exata, era DESCARTADA: justamente o defeito que o painel existe para
 *      mostrar ficava invisivel.
 *
 * 🔴 A REGRA DA ENTRADA REAL FOI MEDIDA, nao escolhida (export bruto de 23/07 a 29/09/2026, 65 dias, 1.145
 *    inversores, 27.480 entradas, no pico de cada inversor, contra a mediana das irmas com mais de 1 A):
 *    - a razao MEDIANA de cada entrada cai em duas faixas, abaixo de 5 % (2.295 entradas vazias ou residuais) e acima
 *      de 40 % (as strings), e NENHUMA entre 5 e 40 %; somando as de cima por usina, fecham com a placa (M2, M4 e M8
 *      exatas; M1 −5, M3 −3, M5 −4, M6 −1, M7 −2: strings sem corrente em todo o registro);
 *    - dia a dia, 2.289 das entradas vazias NUNCA passam de 40 %; duas passaram num dia so. Quatro do M1/TS4/INV08
 *      passam em 28 dias e zeram nos outros: sao strings reais intermitentes.
 *    Logo: ENTRADA REAL = pelo menos DIAS_REAL (3) dias validos com razao >= RAZAO_REAL (40 %), contados sobre o
 *    historico ACUMULADO (o bruto guarda ~30 dias; uma string que morreu ha 40 dias continua sendo string).
 *
 * MORTA = entrada real com <= MORTA_A (0,5 A) no pico com a mediana das irmas acima do piso de leitura (3 A): criterio
 *    fisico, corrente zero com as irmas gerando. Vale o ULTIMO dia valido.
 * FRACA = a MEDIANA, nos ultimos JANELA_FRACA (30) dias validos, da razao no pico abaixo de FRACA (50 %). Aprovado pelo
 *    humano em 30/09/2026, sem norma nem contrato: medido no parque e declarado como tal. Por que assim:
 *    - a razao de UM dia e ruidosa: nuvem sobre parte do arranjo derruba strings sadias a 35–40 % num dia (29/09), e as
 *      strings de rastreador com defeito rendem conforme a HORA do pico (M8/TS1/INV07 s13: 110 % com o pico as 15:00,
 *      16 % com o pico as 10:00). Um dia so faz a string entrar e sair da lista;
 *    - a mediana de 30 dias tem um VAO medido: 13 strings entre 38 e 46 %, NENHUMA entre 46 e 51 %, e dali para cima
 *      um continuo. 50 % cai no vao.
 *    ⚠️ A primeira proposta foi 40 %, e estava errada: as strings fracas ficam em 42–46 %, logo ACIMA dele (o degrau
 *       de 5–40 % e o que separa entrada vazia de string, a regra da entrada real, nao a de fraca).
 */
const RAZAO_REAL = 0.40;
const DIAS_REAL = 3;
const MORTA_A = 0.5;
const FRACA = 0.50;
const JANELA_FRACA = 30;
const IRMA_A = 1;      // irma = entrada com mais de 1 A no instante (a mediana nao se contamina com as vazias)

const mediana = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };

/* razao de cada entrada contra a mediana das irmas, num instante. `c` = { n: corrente | null } */
function razoes(c) {
  const irm = Object.values(c).filter((x) => x != null && x > IRMA_A);
  const md = mediana(irm);
  const r = {};
  if (md) for (const [n, x] of Object.entries(c)) if (x != null) r[n] = x / md;
  return { md, r };
}

/* funde o estado acumulado com as observacoes da rodada.
   estado: [{ ufv, ts, inv, g, n, ok: [ate DIAS_REAL dias], ultimo_ok }] — so entradas que ja passaram de 40 % um dia.
   obs: [{ ufv, ts, inv, g, dia, c }] — corrente no PICO de cada inversor-dia. Dia VALIDO: mediana das irmas > piso.
   Idempotente: rodar duas vezes sobre os mesmos dias da o mesmo estado (os dias sao um CONJUNTO, nunca uma soma). */
function fundeEntradas(estado, obs, piso) {
  const m = new Map();
  const k = (o, n) => o.ufv + '|' + o.ts + '|' + o.inv + '|' + o.g + '|' + n;
  for (const e of estado || []) m.set(k(e, e.n), { ...e, ok: (e.ok || []).slice() });
  for (const o of obs) {
    const { md, r } = razoes(o.c);
    if (!md || md <= piso) continue;
    for (const [n, x] of Object.entries(r)) {
      if (x < RAZAO_REAL) continue;
      const kk = k(o, n);
      const e = m.get(kk) || { ufv: o.ufv, ts: o.ts, inv: o.inv, g: o.g, n: Number(n), ok: [], ultimo_ok: null };
      if (!e.ok.includes(o.dia)) { e.ok.push(o.dia); e.ok.sort(); if (e.ok.length > DIAS_REAL) e.ok = e.ok.slice(0, DIAS_REAL); }
      if (!e.ultimo_ok || o.dia > e.ultimo_ok) e.ultimo_ok = o.dia;
      m.set(kk, e);
    }
  }
  return [...m.values()].sort((a, b) => (k(a, a.n) < k(b, b.n) ? -1 : 1));
}

/* Map(ufv|ts|inv|g -> { reais: Set(n), ultimo_ok: {n: dia} }) a partir do estado fundido */
function indiceReais(estado) {
  const I = new Map();
  for (const e of estado) {
    if ((e.ok || []).length < DIAS_REAL) continue;
    const kk = e.ufv + '|' + e.ts + '|' + e.inv + '|' + e.g;
    if (!I.has(kk)) I.set(kk, { reais: new Set(), ultimo_ok: {} });
    I.get(kk).reais.add(Number(e.n));
    I.get(kk).ultimo_ok[e.n] = e.ultimo_ok;
  }
  return I;
}

/* dispersao SO entre as entradas reais, com o zero DENTRO (string morta e 0 %, nao ausencia).
   Devolve { n, med, min_pct, max_pct, min_n, mortas } ou null (menos de 3 lidas, ou mediana <= piso).
   `mortas` so e contada com a mediana acima de `pisoClasse` (o piso de leitura). */
function dispersao(c, reais, piso, pisoClasse) {
  if (!reais || !reais.size) return null;
  const v = [];
  for (const n of reais) { const x = c[n]; if (x != null) v.push([n, x]); }
  if (v.length < 3) return null;
  const md = mediana(v.map((p) => p[1]));
  if (!(md > piso)) return null;
  let min = v[0];
  for (const p of v) if (p[1] < min[1] || (p[1] === min[1] && p[0] < min[0])) min = p;
  const mx = Math.max(...v.map((p) => p[1]));
  let mortas = 0;
  if (md > (pisoClasse == null ? piso : pisoClasse)) for (const [, x] of v) if (x <= MORTA_A) mortas++;
  const r2 = (x) => Math.round(x * 100) / 100;
  return { n: v.length, med: r2(md), min_pct: r2((min[1] / md) * 100), max_pct: r2((mx / md) * 100),
    min_n: Number(min[0]), mortas };
}

/* o ALARME de uma string real, a partir dos dias em ordem: dias = [{ dia, x, md }] (corrente da string e mediana das
   reais, no pico). So contam dias VALIDOS (md > piso e x lido). Devolve null (normal) ou
   { classe, pct, pct_dia, dia, desde, dias_fora, n_janela }:
   - morta: o ultimo dia valido com x <= MORTA_A; `desde` = inicio do trecho final morto;
   - fraca: a mediana dos ultimos JANELA_FRACA dias validos abaixo de FRACA; `desde` = primeiro dia do trecho final em
     que essa mediana (calculada dia a dia, sobre a janela que termina nele) ficou abaixo de FRACA. */
function alarme(dias, piso) {
  const v = dias.filter((d) => d.x != null && d.md > piso).map((d) => ({ ...d, r: d.x / d.md }));
  if (!v.length) return null;
  const u = v[v.length - 1];
  const r1 = (x) => Math.round(x * 1000) / 10;
  if (u.x <= MORTA_A) {
    let j = v.length - 1;
    while (j > 0 && v[j - 1].x <= MORTA_A) j -= 1;
    return { classe: 'morta', pct: r1(u.r), pct_dia: r1(u.r), dia: u.dia, desde: v[j].dia, dias_fora: v.length - j, n_janela: 1,
      ...(j === 0 ? { desde_o_inicio: 1 } : {}) };
  }
  const medJ = (i) => mediana(v.slice(Math.max(0, i - JANELA_FRACA + 1), i + 1).map((d) => d.r));
  const m = medJ(v.length - 1);
  if (!(m < FRACA)) return null;
  let j = v.length - 1;
  while (j > 0 && medJ(j - 1) < FRACA) j -= 1;
  // `desde_o_inicio`: o trecho comeca no primeiro dia lido — a string ja estava assim ANTES da janela, e `desde` e so
  // o limite do que se leu (a tela diz "pelo menos desde")
  return { classe: 'fraca', pct: r1(m), pct_dia: r1(u.r), dia: u.dia, desde: v[j].dia, dias_fora: v.length - j,
    n_janela: Math.min(JANELA_FRACA, v.length), ...(j === 0 ? { desde_o_inicio: 1 } : {}) };
}

module.exports = { RAZAO_REAL, DIAS_REAL, MORTA_A, FRACA, JANELA_FRACA, IRMA_A, mediana, razoes, fundeEntradas,
  indiceReais, dispersao, alarme };
