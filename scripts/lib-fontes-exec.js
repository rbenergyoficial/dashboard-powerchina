'use strict';
/*
 * lib-fontes-exec.js — as fontes diretas da Visao Executiva (lote fonte-perfil-way2, 19/10/2026): a potencia entregue pelo medidor
 * de faturamento a 5 min, integralizada na meia hora; o pico de 5 min por usina e por contrato; a irradiancia do datalogger das
 * estacoes, por dia e por mes.
 *
 * REGRA DO HUMANO (19/10/2026): tensao, corrente, potencia e energia vem do medidor de faturamento (SMF, 5 min); irradiancia do
 * datalogger; o SCADA so no Comparativo. Tudo INTEGRALIZADO para outros intervalos, nunca amostrado. O operador (ONS) continua sendo
 * a fonte do CORTE: a referencia e a verificada dele ficam na conta do impedido (gen-executivo, `pot_mw` e `ent_mw` do perfil).
 *
 * 1) A MEIA HORA DO MEDIDOR. O medidor rotula pelo FIM: o valor em T e a demanda media de (T-5, T]. O operador rotula pelo INICIO:
 *    a meia hora T e [T, T+30). Entao a meia hora T do operador sao os rotulos T+5 ... T+30 do medidor, os SEIS presentes, e a
 *    potencia dela e a media dos seis (= energia da meia hora / 0,5 h). O ultimo rotulo do arquivo do dia (D+1 00:00) fecha a meia
 *    hora 23:30 de D, nunca a 00:00 (o perfil antigo, `mi < 30 ? '00' : '30'` sobre o rotulo, deslocava a curva 5 min e punha o fim do
 *    dia na meia-noite do comeco).
 *    TUDO-OU-NADA: o circuito so tem a meia hora com as seis leituras; a usina so com todos os circuitos dela; meia hora com leitura
 *    faltando nao existe (media de cinco fingiria meia hora inteira, a mesma regra da hora cheia do `lib-horas`). O Complexo e o ponto
 *    que soma os 22 circuitos (uma medicao so), como no resto do executivo.
 * 2) O PICO DE 5 MIN. O pico do dia de uma usina e o maior valor de 5 min da SOMA dos circuitos dela no MESMO instante (so instante
 *    com todos os circuitos lidos); o de um contrato, a soma SIMULTANEA dos circuitos das usinas dele (nunca a soma dos picos, a regra
 *    do MUST). Antes a tela usava a maior media de UMA HORA do arquivo por hora.
 * 3) A IRRADIANCIA DO DATALOGGER (estacao_logger_30min.json: a meia hora [T, T+30) = media das tres medias de 10 min, rotulada pelo
 *    INICIO, por usina). A media do dia e a das meias horas com sol (acima de LIMIAR_SOL, o mesmo recorte da irradiancia do operador
 *    que ela substitui no executivo), so com o DIA COMPLETO (as 48 meias horas lidas; o datalogger registra a noite): media de meio dia
 *    nao e a do dia. Contrato e Complexo: media das usinas PONDERADA pela potencia, so com todas as usinas completas. O mes: a media das
 *    meias horas com sol dos dias completos da usina; contrato e Complexo, a media das usinas ponderada pela potencia.
 */
const { CIRC, PPA, ML } = require('./lib-horas.js');

const COMPLEXO = 6233;          // o ponto da Way2 que soma os 22 circuitos
const LEITURAS_MEIA = 6;        // seis rotulos de 5 min por meia hora
const MEIAS_DIA = 48;
const LIMIAR_SOL = 5;           // W/m2: o recorte `util` (irr > 5) da irradiancia do operador no executivo, que esta substitui
const GRUPOS = { PPA, ML };
const CAP_UFV = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };
const MED_FONTE = 'medidor_5min';   // a marca do perfil (`med_fonte`): o `med_mw` saiu desta regra
const IRR_FONTE = 'datalogger';     // a marca do executivo (`irr_fonte`)

/* leitura com valor: numero finito, ou texto numerico nao vazio. Celula vazia ('') NAO e zero (Number('') e 0) */
const valido = (x) => (typeof x === 'number' ? isFinite(x) : typeof x === 'string' && x.trim() !== '' && isFinite(+x));
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);
const BRT = 3 * 3600e3;

/* o rotulo do medidor ('AAAA-MM-DDTHH:MM:SS', relogio de Brasilia, sem offset) como relogio: aritmetica em UTC sobre o relogio local */
const relogio = (rot) => Date.parse(String(rot).slice(0, 19) + 'Z');
/* a meia hora [T, T+30) que contem o intervalo (rot-5 min, rot] — chave 'AAAA-MM-DDTHH:MM' pelo INICIO, como o operador */
function chaveMeia(rot) {
  const ini = relogio(rot) - 5 * 60e3;
  return new Date(Math.floor(ini / 18e5) * 18e5).toISOString().slice(0, 16);
}

/* pontoId -> Map(rotulo -> kW) da potencia ativa, so leitura com valor */
function demat(hist) {
  const out = new Map();
  for (const s of (hist && hist.dados) || []) {
    if (s.nomeGrandeza !== 'Demat') continue;
    const m = out.get(s.pontoId) || new Map();
    for (const v of s.valores || []) if (v && valido(v.valor)) m.set(String(v.data).slice(0, 19), +v.valor);
    out.set(s.pontoId, m);
  }
  return out;
}

/* a media de cada meia hora de UM ponto, so com as seis leituras: Map(chave -> kW) */
function meiasDoPonto(m) {
  const acc = new Map();
  for (const [rot, kw] of m || []) { const k = chaveMeia(rot), a = acc.get(k) || { s: 0, n: 0 }; a.s += kw; a.n += 1; acc.set(k, a); }
  const out = new Map();
  for (const [k, a] of acc) if (a.n === LEITURAS_MEIA) out.set(k, a.s / a.n);
  return out;
}

/* A MEIA HORA DO MEDIDOR de um arquivo do dia: Map('AAAA-MM-DDTHH:MM' -> { M1..M9, Complexo }) em MW (null = sem a meia hora inteira).
   `dia` (opcional) guarda so as meias horas que comecam nele. */
function meiasHoras(hist, dia) {
  const D = demat(hist), porPonto = new Map();
  const pids = Object.values(CIRC).flat().concat([COMPLEXO]);
  for (const p of pids) porPonto.set(p, meiasDoPonto(D.get(p)));
  const chaves = new Set();
  for (const m of porPonto.values()) for (const k of m.keys()) if (!dia || k.slice(0, 10) === dia) chaves.add(k);
  const out = new Map();
  for (const k of [...chaves].sort()) {
    const o = {};
    for (const [u, ps] of Object.entries(CIRC)) o[u] = ps.every((p) => porPonto.get(p).has(k)) ? ps.reduce((a, p) => a + porPonto.get(p).get(k), 0) / 1000 : null;
    o.Complexo = porPonto.get(COMPLEXO).has(k) ? porPonto.get(COMPLEXO).get(k) / 1000 : null;
    out.set(k, o);
  }
  return out;
}

/* O PICO DE 5 MIN do dia: { M1..M9, PPA, ML, Complexo: { mw, hora } | null }. `hora` e o rotulo do medidor (o FIM dos 5 min), 'HH:MM';
   o rotulo da meia-noite seguinte sai '24:00'. So os instantes do proprio dia (00:05 ... 24:00). */
function picosDia(hist, dia) {
  const D = demat(hist);
  const ents = Object.assign({}, CIRC);
  for (const [g, us] of Object.entries(GRUPOS)) ents[g] = us.flatMap((u) => CIRC[u]);
  ents.Complexo = [COMPLEXO];
  const doDia = (rot) => { const ini = relogio(rot) - 5 * 60e3; return new Date(ini).toISOString().slice(0, 10) === dia; };
  const out = {};
  for (const [e, ps] of Object.entries(ents)) {
    const base = D.get(ps[0]); let mx = null;
    if (base && ps.every((p) => D.has(p))) {
      for (const rot of base.keys()) {
        if (dia && !doDia(rot)) continue;
        if (!ps.every((p) => D.get(p).has(rot))) continue;   // instante sem um circuito nao entra (tudo-ou-nada)
        const kw = ps.reduce((a, p) => a + D.get(p).get(rot), 0);
        if (!mx || kw > mx.kw) mx = { kw, rot };
      }
    }
    out[e] = mx ? { mw: r3(mx.kw / 1000), hora: (dia && mx.rot.slice(0, 10) !== dia) ? '24:00' : mx.rot.slice(11, 16) } : null;
  }
  return out;
}

/* ── A IRRADIANCIA DO DATALOGGER ─────────────────────────────────────────────────────────────────────────────────────────── */
/* o estacao_logger_30min.json -> Map(dia -> { M1..M9: { s, n, meias } }): `meias` = meias horas lidas no dia, `s`/`n` = soma e numero das
   meias horas com sol (acima de LIMIAR_SOL). Dia e meia hora saem do EPOCH `ms` (inicio da meia hora) em horario de Brasilia. */
function irrIndice(DL) {
  if (!DL || !Array.isArray(DL.serie)) throw new Error('estacao_logger_30min sem `serie`: formato mudou?');
  if (!/^inicio/.test(String(DL.rotulo_de_tempo || ''))) throw new Error('estacao_logger_30min com rotulo de tempo "' + DL.rotulo_de_tempo + '": a regra le o INICIO da meia hora');
  const I = new Map();
  for (const r of DL.serie) {
    if (!isFinite(r.ms)) continue;
    const dia = new Date(r.ms - BRT).toISOString().slice(0, 10);
    const o = I.get(dia) || {};
    for (let n = 1; n <= 9; n++) {
      const v = r['e' + n]; if (!valido(v)) continue;
      const u = 'M' + n, a = o[u] || (o[u] = { s: 0, n: 0, meias: 0 });
      a.meias += 1;
      if (+v > LIMIAR_SOL) { a.s += +v; a.n += 1; }
    }
    I.set(dia, o);
  }
  return I;
}
const membros = (e) => (e === 'Complexo' ? Object.keys(CAP_UFV) : (GRUPOS[e] || [e]));
const completo = (a) => !!a && a.meias >= MEIAS_DIA;
/* a media do dia da usina (W/m2), ou null sem o dia completo ou sem sol */
function irrDiaUsina(I, dia, u) { const a = (I.get(dia) || {})[u]; return completo(a) && a.n > 0 ? a.s / a.n : null; }
/* a media do dia da entidade: usina; contrato e Complexo ponderados pela potencia, tudo-ou-nada */
function irrDia(I, dia, e) {
  const us = membros(e);
  if (us.length === 1) return r2(irrDiaUsina(I, dia, us[0]));
  let s = 0, c = 0;
  for (const u of us) { const v = irrDiaUsina(I, dia, u); if (v == null) return null; s += v * CAP_UFV[u]; c += CAP_UFV[u]; }
  return c > 0 ? r2(s / c) : null;
}
/* a media do mes da usina: as meias horas com sol dos dias completos; { v, dias } */
function irrMesUsina(I, mes, u) {
  let s = 0, n = 0, dias = 0;
  for (const [dia, o] of I) { if (dia.slice(0, 7) !== mes) continue; const a = o[u]; if (!completo(a)) continue; s += a.s; n += a.n; dias += 1; }
  return { v: n > 0 ? s / n : null, dias };
}
/* a media do mes da entidade; contrato e Complexo: media das usinas ponderada pela potencia, so com todas as usinas medidas no mes */
function irrMes(I, mes, e) {
  const us = membros(e);
  let s = 0, c = 0;
  for (const u of us) { const m = irrMesUsina(I, mes, u); if (m.v == null) return null; s += m.v * CAP_UFV[u]; c += CAP_UFV[u]; }
  return c > 0 ? r2(s / c) : null;
}

module.exports = { CIRC, PPA, ML, GRUPOS, COMPLEXO, CAP_UFV, LEITURAS_MEIA, MEIAS_DIA, LIMIAR_SOL, MED_FONTE, IRR_FONTE,
  chaveMeia, demat, meiasDoPonto, meiasHoras, picosDia, irrIndice, irrDiaUsina, irrDia, irrMesUsina, irrMes, r2, r3 };
