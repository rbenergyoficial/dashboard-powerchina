'use strict';
/*
 * lib-sungrow-str.js — as STRINGS e a CURVA de 5 min de cada inversor, lidas do logger Sungrow (13/10/2026, PROMOVER sg-logger-str).
 *
 * Pedido do humano (13/10/2026): a pagina PV · Sungrow so com o dado do logger. O logger registra a cada 5 min a corrente de cada
 * entrada do SG350HX ("Corrente na string N", N = 1..40 no cabecalho; o inversor tem 24 entradas, 2 por MPPT: strings 2k-1 e 2k
 * = MPPT k), a potencia CA e CC, a temperatura interna e o modo de potencia limitada.
 *
 * 🔴 A NUMERACAO E A MESMA DO SCADA, MEDIDA (13/10/2026): M5/TS3, 11 e 12/10, 22 inversores, 12.155 pares inversor-string-instante,
 *    a % de cada string contra a mediana das reais no MESMO instante de meia hora: |diferenca| mediana 1,67 pp (p90 5,35), a mesma
 *    em S1..S23 (1,5 a 1,9); deslocando 30 min, 5,3 a 5,7 pp. A diferenca que sobra e de amostragem (o SCADA e amostra instantanea).
 * 🔴 ESCALAS, medidas no mesmo arquivo: corrente da string em 0,01 A, corrente do MPPT em 0,1 A (string 13 + string 14 = MPPT7:
 *    4,41 + 3,99 = 8,4 A contra 86 = 8,6 A no mesmo instante); potencia em W; temperatura em 0,1 °C. 65535 = sem leitura (nulo).
 * 🔴 COLUNA PELO NOME: as 24 entradas do SG350HX e as grandezas da curva sao exigidas; faltando, estoura com o nome.
 *
 * Por inversor-dia sai:
 *   pk  = o instante de MAIOR potencia CA do dia e a corrente de cada entrada nele (A): a mesma observacao que a lib-strings usa
 *         no SCADA (entrada real, morta, fraca), agora a 5 min;
 *   r   = a MEDIANA do dia da razao de cada entrada contra a mediana das irmas (as entradas com mais de IRMA_A no instante), so nos
 *         instantes SEM potencia limitada e com essa mediana acima do PISO_A, em %; nr = quantos instantes. Com limitacao o
 *         rastreador sai do ponto de maxima potencia e a razao espalha (a mesma exclusao da tensao dos MPPT, lib-sungrow);
 *   g5  = a corrente de cada entrada a cada 5 min (0,1 A, inteiro), da primeira a ultima amostra gerando (> 1 kW);
 *   cv  = a curva de 5 min na mesma grade: p e pdc (0,1 kW, inteiro), t (0,1 °C) e lim (1 = potencia limitada).
 */
const STR = require('./lib-strings.js');
const STRL = STR;
const { PLACA } = require('./lib-placa.js');
const MOD_POR_STRING = 29;   // a placa do parque: strings de 29 modulos

const N_ENT = 24;            // entradas do SG350HX (12 MPPT x 2)
const PISO_A = 3;            // a mediana das irmas abaixo de 3 A e ruido de amanhecer (o mesmo piso da lib-strings no SCADA)
const P_GER_W = 1000;        // gerando: mais de 1 kW
const SENT = new Set([65535, 32767, 2147483647, 4294967295, -32768]);
const num = (s) => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const n = Number(t);
  return Number.isFinite(n) && !SENT.has(n) ? n : null; };
const col = (cab, nome, k) => { let n = -1; for (let i = 0; i < cab.length; i += 1) if (cab[i] === nome && ++n === (k || 0)) return i; return -1; };
const exige = (cab, nome, k, onde) => { const i = col(cab, nome, k); if (i < 0) throw new Error(onde + ': coluna "' + nome + '" ausente'); return i; };
const min5 = (t) => Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/* as colunas: as 24 entradas e a curva. Uma vez por CSV */
function colunas(cab, onde) {
  const s = []; for (let n = 1; n <= N_ENT; n += 1) s.push(exige(cab, 'Corrente na string ' + n, 0, onde));
  return { s, p: exige(cab, 'Potência ativa total', 0, onde), pdc: exige(cab, 'Potência CC total', 0, onde),
    t: exige(cab, 'Temperatura de ar interna', 0, onde), lim: exige(cab, 'Modo de potência limitada', 0, onde) };
}

/* linhas = as do CSV (lib-sungrow.le), de um ou mais dias. Devolve um item por dia com amostra gerando:
   { d, pk: { h, s: [24 A|null] }, md_pk, r: [24 %|null], nr: [24], g5: { h0, s: [24][...] }, cv: { h0, p, pdc, t, lim } } */
function diaStrings(cab, linhas, onde) {
  const c = colunas(cab, onde);
  const porDia = new Map();
  for (const v of linhas) { const d = v[0].slice(0, 10); (porDia.get(d) || porDia.set(d, []).get(d)).push(v); }
  const out = [];
  for (const [d, L0] of porDia) {
    /* 🔴 SO A GRADE DE 5 MIN (achado do revisor, 13/10/2026): o logger grava carimbo fora da grade (10:07:00, 10:05:30; o ensaio da
       disponibilidade forja os dois). Fora da grade nao entra no pico, na razao nem na curva; carimbo repetido vale o primeiro */
    const visto = new Set();
    const L = L0.filter((v) => { const t = v[0].trim(); if (Number(t.slice(14, 16)) % 5 || (t.length > 16 && t.slice(17, 19) !== '00')) return false;
      const h = t.slice(11, 16); if (visto.has(h)) return false; visto.add(h); return true; })
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const P = L.map((v) => num(v[c.p]));
    const ger = P.map((x, i) => (x != null && x > P_GER_W ? i : -1)).filter((i) => i >= 0);
    if (!ger.length) continue;
    // o pico: o PRIMEIRO instante de maior potencia CA do dia
    let ip = ger[0]; for (const i of ger) if (P[i] > P[ip]) ip = i;
    const cor = (v) => c.s.map((ci) => { const x = num(v[ci]); return x == null ? null : x / 100; });
    const sPk = cor(L[ip]).map(r2);
    const { md: mdPk } = STR.razoes(Object.fromEntries(sPk.map((x, k) => [k + 1, x])));
    // a razao de cada entrada contra as irmas, instante a instante, so com a mediana das irmas acima do piso
    const R = Array.from({ length: N_ENT }, () => []);
    const m0 = min5(L[ger[0]][0]), m1 = min5(L[ger[ger.length - 1]][0]), nG = Math.floor((m1 - m0) / 5) + 1;
    const g5 = Array.from({ length: N_ENT }, () => new Array(nG).fill(null));
    const cv = { h0: hhmm(m0), p: new Array(nG).fill(null), pdc: new Array(nG).fill(null), t: new Array(nG).fill(null), lim: new Array(nG).fill(null) };
    for (const v of L) {
      const m = min5(v[0]); if (m < m0 || m > m1) continue;
      const j = (m - m0) / 5;
      const a = cor(v);
      const { md, r } = STR.razoes(Object.fromEntries(a.map((x, k) => [k + 1, x])));
      const livre = num(v[c.lim]) === 0;            // com potencia limitada o rastreador sai do ponto de maxima potencia: a razao espalha
      if (livre && md != null && md > PISO_A) for (const [n, x] of Object.entries(r)) R[n - 1].push(x);
      a.forEach((x, k) => { g5[k][j] = x == null ? null : Math.round(x * 10); });
      const p = num(v[c.p]), pd = num(v[c.pdc]), t = num(v[c.t]), l = num(v[c.lim]);
      cv.p[j] = p == null ? null : Math.round(p / 100); cv.pdc[j] = pd == null ? null : Math.round(pd / 100);
      cv.t[j] = t; cv.lim[j] = l == null ? null : (l !== 0 ? 1 : 0);
    }
    out.push({ d, pk: { h: L[ip][0].slice(11, 16), s: sPk }, md_pk: r2(mdPk),
      r: R.map((x) => (x.length ? r1(100 * STR.mediana(x)) : null)), nr: R.map((x) => x.length),
      g5: { h0: hhmm(m0), s: g5 }, cv });
  }
  return out;
}

/* ------------------------------------------------------------------ os produtos (o gerador chama) ------------------- */
/* Pedido do humano (13/10/2026): a pagina PV · Sungrow so com o dado do logger. Por eletrocentro (k = <usina>_<TS>):
   - sg_str_dia_<k>.json  (publico, DIAS_STR dias, acumulado como o sg_mppt_<k>): por inversor-dia o PICO (instante de maior potencia
     CA, a corrente de cada uma das 24 entradas em A), a mediana das irmas no pico, e a razao MEDIANA do dia de cada entrada (%);
   - sg_str_<k>.json      (publico, DIAS_5MIN dias): a corrente de cada entrada REAL (ou com corrente no dia) a cada 5 min, 0,1 A;
   - sg_curva_<k>.json    (publico, DIAS_5MIN dias): a curva de 5 min de cada inversor (CA, CC, temperatura, limitacao);
   - sg_str_entradas.json (interno): quais entradas sao strings de verdade (lib-strings, a regra medida no SCADA em 30/09/2026,
     agora sobre o pico de 5 min do logger), acumulado;
   - sg_str_alarme.json   (publico): as strings sem corrente e as fracas (lib-strings.alarme) e as strings com corrente por usina
     contra a placa.
   Devolve { disp: Map(u/ts/inv|d -> dispersao do dia no pico) } para a saude por inversor-dia.
   🔴 A TROCA VALE PARA TODA LINHA (a mesma regra do sg_mppt_<k>): a linha so fica se o numero de serie ocupa a posicao no dia */
async function produtos({ strRodada, g5Rodada, ident, mEtcs, vale, leAnterior, escreve, pesos, agora, dias5, diasStr }) {
  const DIAS_5MIN = dias5, DIAS_STR = diasStr;
  const novoD = {}, novoG = {};
  const poe = (o, k, l) => (o[k] || (o[k] = [])).push(l);
  for (const [sn, dias] of Object.entries(strRodada)) { const a = ident[sn]; if (!a) continue;
    const [u, ts, inv] = a.pos.split('/'), k = u + '_' + ts;
    for (const [d, x] of Object.entries(dias)) poe(novoD, k, { d, ms: Date.parse(d + 'T03:00:00Z'), inv, sn, na: x.nAm, h: x.h, md: x.md, pk: x.pk, r: x.r, nr: x.nr }); }
  for (const [sn, dias] of Object.entries(g5Rodada)) { const a = ident[sn]; if (!a) continue;
    const [u, ts, inv] = a.pos.split('/'), k = u + '_' + ts;
    for (const [d, x] of Object.entries(dias)) poe(novoG, k, { d, inv, sn, g5: x.g5, cv: x.cv }); }
  const corteDe = (ult, n) => (ult ? new Date(Date.parse(ult + 'T00:00:00Z') - (n - 1) * 864e5).toISOString().slice(0, 10) : '');
  /* 1 · o arquivo DIARIO, acumulado */
  const sDia = {};
  let nD = 0;
  for (const k of mEtcs) {
    const [u, tsx] = k.split('_');
    const novo = (novoD[k] || []).filter((l) => vale(l, u, tsx));
    const ant = await leAnterior('sg_str_dia_' + k + '.json');
    const antV = ((ant && ant.serie) || []).filter((l) => vale(l, u, tsx));
    const tirados = ((ant && ant.serie) || []).length - antV.length;
    const tudo = new Map(antV.map((l) => [l.d + '|' + l.inv, l]));
    // 🔴 ENTRE RODADAS TAMBEM fica o de mais amostras (achado do revisor, 13/10/2026): um zip parcial do mesmo dia reenviado depois
    //    nao rebaixa o dia inteiro ja publicado. Linha antiga sem `na` perde para a nova
    let trocou = 0;
    for (const l of novo) { const a = tudo.get(l.d + '|' + l.inv); if (a && a.sn === l.sn && a.na != null && a.na > l.na) continue; tudo.set(l.d + '|' + l.inv, l); trocou += 1; }
    const ks = [...tudo.keys()].sort();
    const corte = corteDe(ks.length ? ks[ks.length - 1].slice(0, 10) : '', DIAS_STR);
    sDia[k] = ks.filter((c) => c.slice(0, 10) >= corte).map((c) => tudo.get(c));
    if (!trocou && ant && !tirados) continue;
    pesos['sg_str_dia_' + k + '.json'] = await escreve('sg_str_dia_' + k + '.json', { gerado_em: agora, usina: u, ts: tsx, esquema: 1, janela_dias: DIAS_STR,
      unidade: 'h hora do pico (maior potencia CA do dia); pk corrente de cada entrada 1..24 no pico, A; md mediana das entradas com mais de 1 A no pico, A;'
        + ' r razao mediana do dia de cada entrada contra a mediana das irmas (entradas com mais de 1 A), so instantes sem potencia limitada e com essa'
        + ' mediana acima de 3 A, %; nr instantes julgados; na amostras com potencia lida no dia (no mesmo dia, fica a linha de mais amostras); sn numero de serie; ms epoch do dia (BRT)', serie: sDia[k] });
    nD += 1;
  }
  /* 2 · as entradas REAIS (lib-strings, acumulado) e a dispersao do dia no pico */
  const obs = [];
  for (const [k, L] of Object.entries(sDia)) { const [u, ts] = k.split('_');
    for (const l of L) obs.push({ ufv: u, ts, inv: l.inv, g: 's', dia: l.d, c: Object.fromEntries(l.pk.map((x, i) => [i + 1, x])) }); }
  const entAnt = await leAnterior('sg_str_entradas.json');
  const ENT = STRL.fundeEntradas((entAnt && entAnt.entradas) || [], obs, PISO_A);
  const REAIS = STRL.indiceReais(ENT);
  const reaisDe = (u, ts, inv) => (REAIS.get(u + '|' + ts + '|' + inv + '|s') || {}).reais;
  const disp = new Map();
  const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10), r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  for (const [k, L] of Object.entries(sDia)) { const [u, ts] = k.split('_');
    for (const l of L) { const c = Object.fromEntries(l.pk.map((x, i) => [i + 1, x]));
      const ds = STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, PISO_A);
      if (ds) disp.set(u + '/' + ts + '/' + l.inv + '|' + l.d, ds); } }
  /* 3 · os ALARMES: por string real, sobre os dias do arquivo diario (morta no ultimo dia valido; fraca pela mediana dos ultimos
     30 dias validos), com o pico de cada inversor-dia, como no SCADA */
  const ALARMES = [];
  let ate = '';
  for (const [k, L] of Object.entries(sDia)) { const [u, ts] = k.split('_');
    const porInv = {}; for (const l of L) { poe(porInv, l.inv, l); if (l.d > ate) ate = l.d; }
    for (const [inv, ls] of Object.entries(porInv)) {
      const R = REAIS.get(u + '|' + ts + '|' + inv + '|s'); if (!R) continue;
      ls.sort((a, b) => (a.d < b.d ? -1 : 1));
      const mds = ls.map((l) => STRL.mediana([...R.reais].map((n) => l.pk[n - 1]).filter((x) => x != null)));
      for (const n of [...R.reais].sort((a, b) => a - b)) {
        const al = STRL.alarme(ls.map((l, i) => ({ dia: l.d, x: l.pk[n - 1], md: mds[i] })), PISO_A);
        if (!al) continue;
        const i = ls.findIndex((l) => l.d === al.dia);
        ALARMES.push({ ufv: u, ts, inv, str: n, ...al, a: r2(ls[i].pk[n - 1]), med_a: r2(mds[i]), ultimo_com_corrente: R.ultimo_ok[n] || null });
      }
    }
  }
  ALARMES.sort((a, b) => (a.classe !== b.classe ? (a.classe === 'morta' ? -1 : 1) : a.pct - b.pct || (a.ufv + a.ts + a.inv < b.ufv + b.ts + b.inv ? -1 : 1) || a.str - b.str));
  const resumo = Object.keys(PLACA).sort().map((u) => { let n = 0;
    for (const [kk, v] of REAIS) if (kk.startsWith(u + '|') && kk.endsWith('|s')) n += v.reais.size;
    const placa = Math.round(PLACA[u].modulos / MOD_POR_STRING);
    return { ufv: u, strings_com_corrente: n, placa, sem_corrente_no_registro: placa - n }; });
  pesos['sg_str_entradas.json'] = await escreve('sg_str_entradas.json', { gerado_em: agora, esquema: 1, entradas: ENT });
  pesos['sg_str_alarme.json'] = await escreve('sg_str_alarme.json', { gerado_em: agora, esquema: 1, fonte: 'logger Sungrow, 5 min', ate,
    regra: { morta: 'string real com ate ' + STRL.MORTA_A + ' A no pico do inversor no ULTIMO dia valido, com a mediana das strings reais acima de ' + PISO_A + ' A',
      fraca: 'mediana, nos ultimos ' + STRL.JANELA_FRACA + ' dias validos, da corrente da string no pico abaixo de ' + Math.round(STRL.FRACA * 100) + ' % da mediana das reais',
      real: 'entrada com ao menos ' + STRL.DIAS_REAL + ' dias validos a ' + Math.round(STRL.RAZAO_REAL * 100) + ' % ou mais da mediana no pico (historico acumulado)',
      pico: 'o instante de maior potencia CA do inversor no dia, no registro de 5 min' },
    resumo, serie: ALARMES });
  /* 4 · os de 5 MIN: so os ultimos DIAS_5MIN dias. Strings: so as entradas reais ou com corrente no dia (a vazia nao pesa) */
  let nG = 0;
  for (const k of mEtcs) {
    const [u, tsx] = k.split('_');
    const novo = (novoG[k] || []).filter((l) => vale(l, u, tsx));
    const antS = await leAnterior('sg_str_' + k + '.json'), antC = await leAnterior('sg_curva_' + k + '.json');
    const vS = ((antS && antS.serie) || []).filter((l) => vale(l, u, tsx)), vC = ((antC && antC.serie) || []).filter((l) => vale(l, u, tsx));
    const tiradosG = ((antS && antS.serie) || []).length - vS.length + ((antC && antC.serie) || []).length - vC.length;
    if (!novo.length && antS && antC && !tiradosG) continue;
    const tS = new Map(vS.map((l) => [l.d + '|' + l.inv, l]));
    const tC = new Map(vC.map((l) => [l.d + '|' + l.inv, l]));
    const lidas = (l) => (l && l.p ? l.p.filter((x) => x != null).length : -1);
    for (const l of novo) {
      const aC = tC.get(l.d + '|' + l.inv); if (aC && aC.sn === l.sn && lidas(aC) > lidas(l.cv)) continue;   // a de mais amostras, tambem entre rodadas
      const R = reaisDe(u, tsx, l.inv) || new Set();
      const s = {}; l.g5.s.forEach((a, i) => { if (R.has(i + 1) || a.some((x) => x != null && x > 0)) s[i + 1] = a; });
      tS.set(l.d + '|' + l.inv, { d: l.d, inv: l.inv, sn: l.sn, h0: l.g5.h0, reais: [...R].sort((a, b) => a - b), s });
      tC.set(l.d + '|' + l.inv, { d: l.d, inv: l.inv, sn: l.sn, h0: l.cv.h0, p: l.cv.p, pdc: l.cv.pdc, t: l.cv.t, lim: l.cv.lim });
    }
    const dias = [...new Set([...tS.keys(), ...tC.keys()].map((c) => c.slice(0, 10)))].sort().slice(-DIAS_5MIN);
    const fica = (m) => [...m.keys()].filter((c) => dias.includes(c.slice(0, 10))).sort().map((c) => m.get(c));
    pesos['sg_str_' + k + '.json'] = await escreve('sg_str_' + k + '.json', { gerado_em: agora, usina: u, ts: tsx, esquema: 1, janela_dias: DIAS_5MIN,
      unidade: 's corrente de cada entrada a cada 5 min a partir de h0, 0,1 A (inteiro); so as entradas reais ou com corrente no dia; reais as'
        + ' entradas que sao string (lib-strings); sn numero de serie', serie: fica(tS) });
    pesos['sg_curva_' + k + '.json'] = await escreve('sg_curva_' + k + '.json', { gerado_em: agora, usina: u, ts: tsx, esquema: 1, janela_dias: DIAS_5MIN,
      unidade: 'a cada 5 min a partir de h0: p potencia CA e pdc potencia CC, 0,1 kW (inteiro); t temperatura interna, 0,1 °C; lim 1 = potencia'
        + ' limitada; sn numero de serie', serie: fica(tC) });
    nG += 1;
  }
  console.log('  strings do logger: ' + nD + ' diario(s) e ' + nG + ' de 5 min gravado(s) · entradas reais por usina contra a placa: '
    + resumo.map((x) => x.ufv + ' ' + x.strings_com_corrente + '/' + x.placa).join(', ') + ' · alarmes: '
    + ALARMES.filter((a) => a.classe === 'morta').length + ' sem corrente, ' + ALARMES.filter((a) => a.classe === 'fraca').length + ' fracas (ate ' + ate + ')');
  return { disp };
}

/* o gerador chama, para cada CSV de inversor lido: guarda o pico e a razao de todo dia (strRodada[sn]) e o 5 min so dos ultimos `dias5`
   dias do numero de serie (g5Rodada[sn], cortado DURANTE a leitura: guardar o 5 min de seis meses e cortar depois estoura a memoria).
   No mesmo dia vindo de dois zips, fica o de mais amostras com potencia lida */
function acumula(strRodada, g5Rodada, sn, itens, dias5) {
  const sr = strRodada[sn] || (strRodada[sn] = {}), gr = g5Rodada[sn] || (g5Rodada[sn] = {});
  for (const x of itens) {
    const nAm = x.cv.p.filter((v) => v != null).length;
    if (sr[x.d] && sr[x.d].nAm >= nAm) continue;
    sr[x.d] = { nAm, h: x.pk.h, md: x.md_pk, pk: x.pk.s, r: x.r, nr: Math.max(...x.nr) };
    gr[x.d] = { g5: x.g5, cv: x.cv };
  }
  const ds = Object.keys(gr).sort(); for (const d of ds.slice(0, Math.max(0, ds.length - dias5))) delete gr[d];
}

module.exports = { N_ENT, PISO_A, P_GER_W, colunas, diaStrings, acumula, produtos };
