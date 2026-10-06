'use strict';
/*
 * ensaio-trafo.js — julga o gen-trafo.js com a serie de 5 min do historiador (lote trafo-ied), sem rede: um export
 * `Trafo_*.csv` de 30 min e planilhas da IED forjados, o gerador de verdade e plantios.
 *
 * FORJA (40 dias, 01/12/2025 a 09/01/2026; d = indice do dia):
 *   export de 30 min, os 40 dias: correntes, tensoes, potencias, FP e as tres temperaturas dos dois trafos; tap 8; a
 *     reativa (VolAmpr) ANTES da aparente (VolAmp) no cabecalho; temperaturas do 04T2 ZERO nos dias 0-9 (sem planilha)
 *   planilhas de 5 min dos dias 10-39 (carimbo 1 ms antes da marca; tudo variando, ruido tambem de noite; os dois trafos
 *     com correntes diferentes):
 *     201 e 202  04T1 230 kV, dias 10-24 e 25-39 · temperatura do oleo CONGELADA (o mesmo valor os 30 dias) · enrolamento
 *                vivo com um trecho constante de 2 x 150 passos ATRAVESSANDO as duas planilhas (dia 24 11:30 a dia 25 12:25)
 *                · PICO de +30 A as 12:05 do dia 20 · tap fracionario variando (interpolado)
 *     210        04T1 34,5 kV (X1 e X2)
 *     203        04T2 230 kV · oleo do CDC constante 288 passos no dia 14 (fica) e 1.000 passos a partir do dia 30 e 400 a
 *                partir do dia 35 (saem, 1.400 contados) · enrolamento constante 289 passos a partir do dia 15 (sai) · oleo
 *                constante em DOIS trechos de 200 passos separados por um BURACO de carimbo no dia 18 as 16:40 (ficam)
 *                · uma linha de rodape em texto e uma em branco
 *   variantes: tensao do 04T2 x1,01 · planilha do 04T2 com prefixo do 04T1 · corrente do 04T2 +0,1 A (perto da folga) ·
 *     mistura de trafos · planilha sem tag de trafo · sem planilha nenhuma · copia da 203 com id maior e oleo +5 ·
 *     planilha curta e divergente do 04T2 (menos de 100 instantes comuns)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');

let falhas = 0;
const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FALHA ') + msg); if (!c) falhas += 1; };
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-trafo-'));
process.on('exit', () => fs.rmSync(raiz, { recursive: true, force: true }));
const IN = path.join(raiz, 'in'), OUT = path.join(raiz, 'out');

const N = 40, D0 = Date.UTC(2025, 11, 1);
const dia = (d) => new Date(D0 + d * 864e5).toISOString().slice(0, 10);
const msDe = (d, min) => D0 + d * 864e5 + min * 60e3 + 3 * 3600e3;          // epoch do instante em BRT
const PASSO = 300000, r2 = (x) => Math.round(x * 100) / 100;
const iso = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
// as grandezas, por trafo, dia e minuto do dia: tudo varia (ruido tambem a noite), e o 04T2 difere do 04T1
const base = (d, min) => { const h = min / 60, ruido = 0.3 * Math.sin(min * 0.7 + d);
  return (h < 6 || h > 18 ? 5 : 5 + 440 * Math.sin(Math.PI * (h - 6) / 12) ** 2) + ruido; };
const PICO = { d: 20, min: 725, extra: 30 };
const I = (t, d, min) => (t === '04T1' ? base(d, min) + (d === PICO.d && min === PICO.min ? PICO.extra : 0) : 0.97 * base(d, min) + 1.3);
const V = (d, min) => 238 + 0.6 * Math.sin(min / 37 + d);
const FP = (min) => 0.95 + 0.04 * Math.sin(min / 53);
const S = (t, d, min) => Math.sqrt(3) * V(d, min) * I(t, d, min) / 1000;
const P = (t, d, min) => FP(min) * S(t, d, min);
const Q = (t, d, min) => -Math.sqrt(Math.max(0, S(t, d, min) ** 2 - P(t, d, min) ** 2));
const TEMP = { t_oleo: (i, min) => 40 + 0.05 * i + 0.2 * Math.sin(min / 29), t_oleo_cdc: (i, min) => 38 + 0.04 * i + 0.2 * Math.sin(min / 23),
  t_enrol: (i, min) => 45 + 0.06 * i + 0.2 * Math.sin(min / 31) };
// o export do 04T2 tem a temperatura deslocada de +3 (para a precedencia se ver) e ZERO nos dias sem planilha
const tempExp = (t, k, d, min) => (t === '04T2' && (d < 10 || d === 20) ? 0 : TEMP[k](I(t, d, min), min) + (t === '04T2' ? 3 : 0));

// ---- o export ----
function exporta() {
  const U = { '04T1': 'UCT1', '04T2': 'UCT2' }, R = { '04T1': 'URT1', '04T2': 'URT2' }, cols = [];
  for (const t of ['04T1', '04T2']) {
    const g = 'MRT_' + t + '_IEC_61850.';
    for (const f of ['A', 'B', 'C']) cols.push([t, 'i', g + U[t] + '.' + U[t] + '_MON_CMMXU1_A_phs' + f]);
    for (const f of ['AB', 'BC', 'CA']) cols.push([t, 'v', g + U[t] + '.' + U[t] + '_MON_VMMXU1_PPV_phs' + f]);
    cols.push([t, 'q', g + U[t] + '.' + U[t] + '_MON_CVMMXN1_VolAmpr'], [t, 's', g + U[t] + '.' + U[t] + '_MON_CVMMXN1_VolAmp'],
      [t, 'p', g + U[t] + '.' + U[t] + '_MON_CVMMXN1_Watt'], [t, 'fp', g + U[t] + '.' + U[t] + '_MON_CVMMXN1_PwrFact']);
    for (const [k, a] of [['t_oleo', 'AnIn30'], ['t_oleo_cdc', 'AnIn31'], ['t_enrol', 'AnIn32'], ['tap', 'AnIn16']]) cols.push([t, k, g + R[t] + '.' + R[t] + '_ANN_MVGGIO12_' + a + '_InstMag_f']);
  }
  const L = ['Tempo;' + cols.map((c) => c[2]).join(';')];
  for (let d = 0; d < N; d += 1) for (let min = 0; min < 1440; min += 30) {
    const ds = dia(d);
    const val = (t, k) => ({ i: I(t, d, min), v: V(d, min), q: Q(t, d, min), s: S(t, d, min), p: P(t, d, min), fp: -FP(min), tap: 8 }[k]
      ?? tempExp(t, k, d, min));
    L.push(ds.slice(8, 10) + '/' + ds.slice(5, 7) + '/' + ds.slice(0, 4) + ' ' + String(min / 60 | 0).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0')
      + ';' + cols.map(([t, k]) => val(t, k).toFixed(2)).join(';'));             // 2 casas, como o export real
  }
  fs.writeFileSync(path.join(IN, '100_Trafo_20260110_030000.csv'), '﻿' + L.join('\n') + '\n');
}
// ---- uma planilha ----
function planilha(nome, cab, dias, linhaDe, rodape) {
  const aoa = [['DataHora', ...cab]];
  for (const d of dias) for (let min = 0; min < 1440; min += 5) {
    const v = linhaDe(d, min);
    if (v === null) continue;                                               // o buraco de carimbo
    aoa.push([(msDe(d, min) - 3 * 3600e3) / 86400000 + 25569 - 1 / 86400000, ...v]);   // 1 ms ANTES da marca
  }
  if (rodape) aoa.push(['Total', ...cab.map(() => '')], []);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['grafico']]), 'Gráfico');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Interpolação');
  fs.writeFileSync(path.join(IN, nome), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}
const cab230 = (u, r) => [...['A', 'B', 'C'].map((f) => u + '_MON_CMMXU1_A_phs' + f + '_INT ()'), ...['AB', 'BC', 'CA'].map((f) => u + '_MON_VMMXU1_PPV_phs' + f + '_INT ()'),
  r + '_ANN_MVGGIO12_AnIn16_InstMag_f_INT (', r + '_ANN_MVGGIO12_AnIn30_InstMag_f_INT (', r + '_ANN_MVGGIO12_AnIn31_InstMag_f_INT (', r + '_ANN_MVGGIO12_AnIn32_InstMag_f_INT (',
  u + '_MON_CVMMXN1_VolAmpr_INT ()', u + '_MON_CVMMXN1_VolAmp_INT ()', u + '_MON_CVMMXN1_Watt_INT ()', u + '_MON_CVMMXN1_PwrFact_INT ()'];
const passo = (d, min) => (d - 10) * 288 + min / 5;                         // indice do passo de 5 min desde o dia 10
const ENROL1 = [passo(24, 690), passo(25, 745)];                            // 04T1: 150 + 150 passos, atravessa as duas planilhas
const CDC2 = [[passo(14, 0), passo(14, 1435)], [passo(30, 0), passo(30, 0) + 999], [passo(35, 0), passo(35, 0) + 399]];
const ENROL2 = [passo(15, 0), passo(15, 0) + 288];                          // 289 passos
const OLEO2 = [[passo(18, 0), passo(18, 0) + 199], [passo(18, 0) + 201, passo(18, 0) + 400]];   // o 200 que falta e o buraco
const BURACO = passo(18, 0) + 200;
const dentro = (x, [a, b]) => x >= a && x <= b;
function linha230(t, opc) {
  return (d, min) => {
    const x = passo(d, min);
    if (t === '04T2' && x === BURACO) return null;
    const i = (I(t, d, min) + (opc.mais || 0)) * (opc.vezes || 1), v = V(d, min) * (opc.tensao || 1), s = Math.sqrt(3) * v * i / 1000, p = FP(min) * s;
    const temp = (k) => {
      if (t === '04T1' && k === 't_oleo') return 53.5703125;                                      // congelado o tempo todo
      if (t === '04T1' && k === 't_enrol' && dentro(x, ENROL1)) return 61.25;
      if (t === '04T2' && k === 't_oleo_cdc' && CDC2.some((r) => dentro(x, r))) return 47.5;
      if (t === '04T2' && k === 't_enrol' && dentro(x, ENROL2)) return 52.75;
      if (t === '04T2' && k === 't_oleo' && OLEO2.some((r) => dentro(x, r))) return 61;
      if (t === '04T2' && k === 't_oleo' && d === 21 && min === 725) return 3;                       // implausivel FORA da grade
      return TEMP[k](I(t, d, min), min) + (opc.oleo && k === 't_oleo' ? opc.oleo : 0);
    };
    const vv = opc.vcurta ? (d === 20 && min < 300 ? v * 1.05 : null) : v;                    // tensao so em 60 instantes
    return [i, i, i, vv, vv, vv, 8 + (min % 60) / 240, temp('t_oleo'), temp('t_oleo_cdc'), temp('t_enrol'), -Math.sqrt(Math.max(0, s * s - p * p)), s, p, -FP(min)];
  };
}
const DIAS_A = Array.from({ length: 15 }, (_, k) => 10 + k), DIAS_B = Array.from({ length: 15 }, (_, k) => 25 + k), DIAS_P = [...DIAS_A, ...DIAS_B];

function monta(variante) {
  for (const d of [IN, OUT]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); }
  exporta();
  if (variante === 'sem') return;
  planilha('201_11.12 A 25.12.xlsx', cab230('UCT1', 'URT1'), DIAS_A, linha230('04T1', {}));
  planilha('202_26.12 A 09.01.xlsx', cab230('UCT1', 'URT1'), DIAS_B, linha230('04T1', {}));
  planilha('210_11.12 A 09.01.xlsx', [...['A', 'B', 'C'].map((f) => 'UCT1_MON_CMMXU2_A_phs' + f + '_INT ()'), ...['A', 'B', 'C'].map((f) => 'UCT1_MON_CMMXU3_A_phs' + f + '_INT ()')],
    DIAS_P, (d, min) => { const i = I('04T1', d, min); return [3.4 * i, 3.4 * i, 3.4 * i, 1.7 * i, 1.7 * i, 1.7 * i]; });
  const opc2 = variante === 'tensao' ? { tensao: 1.01 } : variante === 'perto' ? { mais: 0.06 } : variante === 'arredonda' ? { mais: 0.004 }
    : variante === 'vcurta' ? { vcurta: true } : {};
  const pre2 = variante === 'trocado' ? ['UCT1', 'URT1'] : ['UCT2', 'URT2'];
  if (variante === 'curta') {
    // so 60 instantes do dia 20, com a corrente divergente: menos de 100 instantes comuns, a planilha nao entra
    planilha('203_21.12 A 21.12.xlsx', cab230('UCT2', 'URT2'), [20], (d, min) => (min < 300 ? linha230('04T2', { mais: 50 })(d, min) : null));
  } else planilha('203_11.12 A 09.01.xlsx', cab230(...pre2), DIAS_P, linha230('04T2', opc2), true);
  if (variante === 'copias') planilha('1000_11.12 A 09.01.xlsx', cab230('UCT2', 'URT2'), DIAS_P, linha230('04T2', { oleo: 5 }));
  if (variante === 'alheia') planilha('204_11.12 A 09.01.xlsx', ['M1_TS1_INV01_P'], [20], (d, min) => [100 + min]);
  if (variante === 'mistura') planilha('205_11.12 A 09.01.xlsx', ['UCT1_MON_CMMXU1_A_phsA_INT ()', 'UCT2_MON_CMMXU1_A_phsA_INT ()'], [20], (d, min) => [5 + min, 7 + min]);
}
const roda = (gen) => { try { return { ok: true, log: execFileSync('node', [gen], { env: Object.assign({}, process.env, { LOCAL_DIR: IN, LOCAL_OUT_DIR: OUT }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, log: String(e.stdout || '') + String(e.stderr || '') }; } };
const le = (n) => { const f = path.join(OUT, n); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) : { serie: [] }; };
const arr = (x) => Number(x.toFixed(2));                                     // o valor como o export o publica
const ultimaLinha = (log) => log.split('\n').filter(Boolean).slice(-1)[0] || '';

function cenario(gen, quais) {
  const R = {}, faz = (v) => !quais || quais.includes(v);
  try {
    monta('normal');
    const r = roda(gen); R.roda = r.ok; if (!r.ok) R.erro = ultimaLinha(r.log);
    const C5 = le('trafo_5min.json'), C30 = le('trafo_30min.json'), C60 = le('trafo_60min.json'), CD = le('trafo_diario.json');
    const em = (C, d, min) => C.serie.find((x) => x.ms === msDe(d, min)) || {};
    const p5 = em(C5, PICO.d, PICO.min), m30 = em(C30, PICO.d, 720);
    const ult = msDe(N - 1, 1435), corte = ult - 29 * 86400e3;
    R.okFusao5 = C5.serie.length === 29 * 288 + 1 && (C5.serie[0] || {}).ms === corte && C5.serie.every((x) => x.ms % PASSO === 0 && x.ms >= corte)
      && C5.janela_dias === 30 && p5['04T1_i1a'] === r2(I('04T1', PICO.d, PICO.min)) && p5['04T1_i2a'] === r2(3.4 * I('04T1', PICO.d, PICO.min))
      && p5['04T2_i1a'] === r2(I('04T2', PICO.d, PICO.min));
    const s1205 = S('04T1', PICO.d, PICO.min);
    R.ok5Campos = p5['04T1_fp'] === r2(FP(PICO.min)) && p5['04T1_carga_pct'] === r2(r2(s1205) / 230 * 100) && p5['04T1_s'] === r2(s1205);
    R.okCongelado = p5['04T1_t_oleo'] === undefined && m30['04T1_t_oleo'] === arr(TEMP.t_oleo(I('04T1', PICO.d, 720), 720))
      && (C5.congelados_5min || {})['04T1|t_oleo'] === 30 * 288;
    const v5 = (t, k, d, min) => em(C5, d, min)[t + '_' + k];
    R.okFronteira = v5('04T2', 't_oleo_cdc', 14, 725) === 47.5 && v5('04T2', 't_enrol', 15, 725) === undefined && v5('04T2', 't_oleo_cdc', 31, 725) === undefined
      && (C5.congelados_5min || {})['04T2|t_oleo_cdc'] === 1400 && (C5.congelados_5min || {})['04T2|t_enrol'] === 289
      && v5('04T2', 't_oleo', 18, 605) === 61 && v5('04T1', 't_enrol', 24, 1085) === undefined && v5('04T1', 't_enrol', 23, 1085) === r2(TEMP.t_enrol(I('04T1', 23, 1085), 1085));
    const IMP = C30.temperaturas_implausiveis || {};
    R.okPrecedencia = m30['04T2_t_oleo'] === r2(TEMP.t_oleo(I('04T2', PICO.d, 720), 720)) && p5['04T2_t_oleo'] === r2(TEMP.t_oleo(I('04T2', PICO.d, PICO.min), PICO.min))
      && IMP['04T2|t_oleo'] === 481 && IMP['04T2|t_oleo_cdc'] === 480 && IMP['04T2|t_enrol'] === 480 && Object.keys(IMP).length === 3;
    R.okTap = p5['04T1_tap'] === undefined && m30['04T1_tap'] === 8;
    R.ok30 = C30.serie.length === N * 48 && C30.serie.every((x) => x.ms % 1800000 === 0) && m30['04T1_i1a'] === r2(I('04T1', PICO.d, 720));
    const m60 = em(C60, PICO.d, 720);
    R.ok60 = C60.serie.length === N * 24 && m60['04T1_i1a'] === r2((I('04T1', PICO.d, 720) + I('04T1', PICO.d, 750)) / 2);
    const dd = CD.serie.find((x) => x.dia === dia(PICO.d)) || {};
    R.okDiario = dd.n === 288 && dd['04T1_s_max'] === r2(s1205);
    const e5 = em(C30, 5, 720);
    R.okVolAmp = e5['04T1_s'] === arr(S('04T1', 5, 720)) && e5['04T1_q'] === arr(Q('04T1', 5, 720)) && m30['04T1_s'] === r2(S('04T1', PICO.d, 720));
    R.okRecusa = /203_11\.12 A 09\.01\.xlsx: 04T2 · 230 kV · \d+ instante\(s\).* · 1 linha\(s\) sem carimbo/.test(r.log) && C5.serie.every((x) => Number.isFinite(x.ms));
    const H = C5.historiador_5min || {};
    R.okHistoriador = ['04T1', '04T2'].every((t) => !!H[t] && H[t].de === iso(msDe(10, 0)) && H[t].ate === iso(msDe(39, 1435)));
    R.txt = '5 min ' + C5.serie.length + ' (esperado ' + (29 * 288 + 1) + ') · 12:05 i1a ' + p5['04T1_i1a'] + ' fp ' + p5['04T1_fp'] + ' carga ' + p5['04T1_carga_pct']
      + ' · congelados ' + JSON.stringify(C5.congelados_5min || {}).slice(0, 160) + ' · implausiveis ' + JSON.stringify(IMP);
    const falha = (v, re) => { monta(v); const x = roda(gen); return x.ok === false && re.test(x.log); };
    const DIFERE = /a planilha do historiador difere do export/;
    if (faz('tensao')) R.okTensao = falha('tensao', /04T2 v1ab: a planilha do historiador difere do export/);
    if (faz('trocado')) R.okTrocado = falha('trocado', DIFERE);
    if (faz('perto')) R.okPerto = falha('perto', DIFERE);
    if (faz('arredonda')) { monta('arredonda'); const x = roda(gen); R.okArredonda = x.ok && /guarda 04T2 i1a: planilha x export/.test(x.log); }
    if (faz('vcurta')) { monta('vcurta'); const x = roda(gen); const S5 = le('trafo_5min.json');
      R.okVCurta = x.ok && /04T2 v1ab: so \d+ instante\(s\) comuns com o export — a planilha deste trafo NAO entra/.test(x.log)
        && /guarda 04T2 i1a: planilha x export em \d+ instantes comuns/.test(x.log) && em(S5, PICO.d, PICO.min)['04T2_i1a'] === undefined; }
    if (faz('mistura')) R.okMistura = falha('mistura', /prefixo de tag nao reconhecido ou de mais de um trafo/);
    if (faz('alheia')) { monta('alheia'); const x = roda(gen); R.okIgnora = x.ok && /204_11\.12 A 09\.01\.xlsx: nao e planilha do historiador/.test(x.log); }
    if (faz('sem')) { monta('sem'); const x = roda(gen); const S5 = le('trafo_5min.json');
      R.okSem = x.ok && S5.serie.length > 0 && S5.serie.every((l) => l.ms % 1800000 === 0) && !!S5.historiador_5min && S5.historiador_5min['04T1'] === null && S5.historiador_5min['04T2'] === null; }
    if (faz('copias')) { monta('copias'); const x = roda(gen); const S5 = le('trafo_5min.json');
      R.okCopias = x.ok && em(S5, PICO.d, PICO.min)['04T2_t_oleo'] === r2(TEMP.t_oleo(I('04T2', PICO.d, PICO.min), PICO.min) + 5); }
    if (faz('curta')) { monta('curta'); const x = roda(gen); const S5 = le('trafo_5min.json'), S30 = le('trafo_30min.json');
      R.txtCurta = (x.log.match(/.*04T2.*/g) || []).slice(0, 6).join(' | ') + ' · 5min ' + em(S5, 20, 5)['04T2_i1a'] + ' · 30min ' + em(S30, 20, 0)['04T2_i1a'] + ' esperado ' + arr(I('04T2', 20, 0));
      R.okCurta = x.ok && /04T2 i1a: so \d+ instante\(s\) comuns com o export — a planilha deste trafo NAO entra/.test(x.log)
        && em(S5, 20, 5)['04T2_i1a'] === undefined && em(S30, 20, 0)['04T2_i1a'] === arr(I('04T2', 20, 0)); }
  } catch (e) { R.erro = String(e.message).split('\n')[0]; }
  return R;
}

console.log('gen-trafo com a planilha de 5 min do historiador');
const GEN = path.join(__dirname, 'gen-trafo.js');
const R = cenario(GEN);
if (R.erro) ok(false, 'o gerador estourou: ' + R.erro);
ok(R.roda, 'a rodada normal termina sem erro');
ok(R.okFusao5, 'serie de 5 min: os 30 dias do corte, todos na grade (carimbo 1 ms antes arredondado), o pico de 5 min, os dois trafos e os lados de 34,5 kV: ' + R.txt);
ok(R.ok5Campos, 'no 5 min o FP vai em modulo e a carga e % de 230 MVA');
ok(R.okCongelado, 'temperatura congelada na planilha sai como sem dado (o export de 30 min fica), e e contada');
ok(R.okFronteira, 'congelado: 288 passos ficam, 289 saem, 1.000 saem; buraco de carimbo parte o trecho; trecho entre duas planilhas sai; contagem soma os trechos');
ok(R.okPrecedencia, 'a planilha viva vence o export; os zeros do export so ficam (e so sao contados) onde nao ha planilha, 480 por canal; o implausivel da planilha fora da grade conta (481 no oleo)');
ok(R.okTap, 'o tap interpolado da planilha nao entra; o do export fica');
ok(R.ok30, 'o 30 min continua sendo a amostra no instante da grade, sem o pico de 5 min');
ok(R.ok60, 'o 60 min e a media das amostras de :00 e :30, sem os instantes de 5 min');
ok(R.okDiario, 'o pico do dia sai dos 5 min (288 instantes)');
ok(R.okVolAmp, 'potencia aparente e a VolAmp, nunca a VolAmpr que vem antes, na planilha e no export (dia sem planilha)');
ok(R.okRecusa, 'linha de rodape sem carimbo numerico e recusada e contada');
ok(R.okHistoriador, 'o meta diz de quando a quando o historiador cobre cada trafo');
ok(R.okTensao, 'tensao da planilha fora de escala estoura na guarda da tensao');
ok(R.okTrocado, 'planilha do 04T2 com o prefixo do 04T1 estoura na guarda de concordancia');
ok(R.okPerto, 'corrente 0,06 A acima do export (logo acima da folga de 0,05) estoura');
ok(R.okArredonda, 'diferenca dentro do arredondamento das 2 casas do export (0,004) entra');
ok(R.okVCurta, 'corrente conferida mas tensao com menos de 100 instantes comuns: a planilha nao entra');
ok(R.okMistura, 'planilha com tags dos dois trafos estoura com a mensagem da mistura');
ok(R.okIgnora, 'planilha com o nome do periodo mas sem tag de trafo e ignorada com aviso');
ok(R.okSem, 'sem planilha nenhuma: o 5 min sai so com a grade de 30 min e o meta diz que nao ha historiador');
ok(R.okCopias, 'duas copias da mesma planilha: vence a de id maior (a mais nova), nao a ordem alfabetica');
ok(R.okCurta, 'planilha com menos de 100 instantes comuns com o export nao entra, e o log diz' + (R.okCurta ? '' : ': ' + R.txtCurta));

console.log('\nplantios (cada um roda o normal e as variantes que importam; o plantado tem de rodar e reprovar so na regra)');
const LIB = path.join(__dirname, 'lib-trafo-ied.js');
const srcG = fs.readFileSync(GEN, 'utf8'), srcL = fs.readFileSync(LIB, 'utf8');
function aplica(trocas) {
  let G = srcG, L = srcL;
  for (const [a, de, para] of trocas) {
    const src = a === 'lib' ? L : G;
    if (src.split(de).length !== 2) return null;
    if (a === 'lib') L = L.split(de).join(para); else G = G.split(de).join(para);
  }
  const g = path.join(__dirname, '_plantio_gen_trafo.js'), l = path.join(__dirname, '_plantio_lib_trafo.js');
  fs.writeFileSync(l, L); fs.writeFileSync(g, G.split("require('./lib-trafo-ied.js')").join("require('./_plantio_lib_trafo.js')"));
  return { g, l };
}
function planta(nome, trocas, chave, quais) {
  const f = aplica(trocas);
  if (!f) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  let r2_; try { r2_ = cenario(f.g, quais || ['normal']); } finally { fs.unlinkSync(f.g); fs.unlinkSync(f.l); }
  const rodou = r2_.roda && !r2_.erro;
  ok(rodou && r2_[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (rodou ? '' : ' (o plantado nem rodou: ' + (r2_.erro || '?') + ')'));
}
function plantaErro(nome, trocas, re) {
  const f = aplica(trocas);
  if (!f) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  let r2_; try { r2_ = cenario(f.g, ['normal']); } finally { fs.unlinkSync(f.g); fs.unlinkSync(f.l); }
  ok(r2_.roda === false && re.test(r2_.erro || ''), 'plantio "' + nome + '" derruba o job na guarda: ' + String(r2_.erro || '').slice(0, 100));
}
planta('congelado nunca sai', [['lib', 'if (fim - ini > CONGELADO_PASSOS) {', 'if (false) {']], 'okCongelado');
planta('24 h exatas tratadas como congelado', [['lib', 'if (fim - ini > CONGELADO_PASSOS) {', 'if (fim - ini >= CONGELADO_PASSOS) {']], 'okFronteira');
planta('limiar de congelado em 1.000 passos', [['lib', 'const CONGELADO_PASSOS = 288;', 'const CONGELADO_PASSOS = 1000;']], 'okFronteira');
planta('buraco de carimbo nao parte o trecho', [['lib', ' && ms[j] - ms[j - 1] === PASSO', '']], 'okFronteira');
planta('contagem so do primeiro trecho', [['lib', 'tirados[k] = (tirados[k] || 0) + (fim - ini);', 'tirados[k] = tirados[k] || (fim - ini);']], 'okFronteira');
planta('congelado por planilha, antes da fusao', [
  ['gen', '    for (const l of r.linhas) { const o = ied[r.trafo].get(l.ms) || ied[r.trafo].set(l.ms, {}).get(l.ms); Object.assign(o, l.v); }',
    "    { const m1 = new Map(r.linhas.map((l) => [l.ms, Object.assign({}, l.v)])); const t1 = IED.tiraCongelados(m1, Object.keys(IED.GRANDEZAS_IED)); for (const [k, n] of Object.entries(t1)) congeladosPre[r.trafo + '|' + k] = (congeladosPre[r.trafo + '|' + k] || 0) + n; for (const [ms, v] of m1) { const o = ied[r.trafo].get(ms) || ied[r.trafo].set(ms, {}).get(ms); Object.assign(o, v); } }"],
  ['gen', "  const ied = { '04T1': new Map(), '04T2': new Map() };", "  const ied = { '04T1': new Map(), '04T2': new Map() }; const congeladosPre = {};"],
  ['gen', "    const tir = IED.tiraCongelados(ied[t], Object.keys(IED.GRANDEZAS_IED));\n    for (const [k, n] of Object.entries(tir)) congelados[t + '|' + k] = n;",
    "    for (const [k, n] of Object.entries(congeladosPre)) if (k.startsWith(t)) congelados[k] = n;"]], 'okFronteira');
planta('o export vence a planilha', [['gen', 'reg[t] = Object.assign(reg[t] || {}, o);', 'reg[t] = Object.assign({}, o, reg[t] || {});']], 'okPrecedencia');
plantaErro('carimbo truncado', [['lib', 'Math.round(((x - 25569) * 86400000 + 3 * 3600e3) / PASSO) * PASSO', 'Math.floor(((x - 25569) * 86400000 + 3 * 3600e3) / PASSO) * PASSO']], /a planilha do historiador difere do export/);
planta('VolAmp sem fronteira (planilha e export)', [['lib', "const casa = (tag, pedaco) => new RegExp(pedaco + '(?![A-Za-z0-9])').test(tag);", 'const casa = (tag, pedaco) => tag.includes(pedaco);']], 'okVolAmp');
planta('VolAmp sem fronteira so no export', [['gen', '        if (IED.casa(c, pedaco)) {', '        if (c.includes(pedaco)) {']], 'okVolAmp');
planta('30 min com os instantes de 5 min', [['gen', 'const serie30 = serie.filter((r) => r.ms % 1800000 === 0);', 'const serie30 = serie;']], 'ok30');
planta('60 min com os instantes de 5 min', [['gen', '    for (const r of serie30) {', '    for (const r of (min === 60 ? serie : serie30)) {']], 'ok60');
planta('diario so com a grade de 30 min', [['gen', '  for (const r of serie) {\n    const d = diaDe(r.ms);', '  for (const r of serie30) {\n    const d = diaDe(r.ms);']], 'okDiario');
planta('guarda so da corrente', [['gen', "for (const k of ['i1a', 'v1ab', 'p'])", "for (const k of ['i1a'])"]], 'okTensao', ['normal', 'tensao']);
planta('folga da guarda 20x maior', [['gen', 'const TOL_CONCORDA = 0.05;', 'const TOL_CONCORDA = 1;']], 'okPerto', ['normal', 'perto']);
planta('folga da guarda 1,8x maior', [['gen', 'const TOL_CONCORDA = 0.05;', 'const TOL_CONCORDA = 0.09;']], 'okPerto', ['normal', 'perto']);
// folga abaixo do arredondamento das 2 casas do export: ate a forja normal (|dif| ~0,002) derruba o job — o vermelho em producao
plantaErro('folga abaixo do arredondamento do export', [['gen', 'const TOL_CONCORDA = 0.05;', 'const TOL_CONCORDA = 0.001;']], /a planilha do historiador difere do export/);
planta('so a corrente curta barra a planilha', [['gen', 'semConferir = true; continue; }', "if (k === 'i1a') semConferir = true; continue; }"]], 'okVCurta', ['normal', 'vcurta']);
planta('implausivel contado no export cru, antes da fusao', [
  ['gen', '          if (v != null) o[chave] = v;', "          if (v != null && TEMPS.includes(chave) && v < IMPLAUSIVEL) ruins[t + '|' + chave] = (ruins[t + '|' + chave] || 0) + 1;\n          if (v != null) o[chave] = v;"],
  ['gen', '  for (const r of serie) for (const t of TRAFOS) for (const k of TEMPS) {', '  for (const r of []) for (const t of TRAFOS) for (const k of TEMPS) {']], 'okPrecedencia');
planta('implausivel contado so na grade de 30 min', [['gen', '  for (const r of serie) for (const t of TRAFOS) for (const k of TEMPS) {',
  '  for (const r of serie.filter((x) => x.ms % 1800000 === 0)) for (const t of TRAFOS) for (const k of TEMPS) {']], 'okPrecedencia');
planta('mistura de trafos aceita', [['lib', '  if (trafos.size !== 1) {', '  if (false) {']], 'okMistura', ['normal', 'mistura']);
planta('tap interpolado entra', [['lib', "  t_oleo: 'AnIn30_InstMag_f',", "  tap: 'AnIn16_InstMag_f', t_oleo: 'AnIn30_InstMag_f',"]], 'okTap');
planta('FP sem modulo no 5 min', [['gen', "          o[t + '_' + chave] = r2(chave === 'fp' ? Math.abs(v) : v);", "          o[t + '_' + chave] = r2(v);"]], 'ok5Campos');
planta('carga fora do 5 min', [['gen', "        if (o[t + '_s'] != null) o[t + '_carga_pct'] = r2((o[t + '_s'] / NOMINAL) * 100);\n      }\n      return o;\n    });\n    const bytes = await grava('trafo_5min.json'",
  "      }\n      return o;\n    });\n    const bytes = await grava('trafo_5min.json'"]], 'ok5Campos');
planta('5 min sem o corte de 30 dias', [['gen', 'const linhas = serie.filter((r) => r.ms >= corte).map((r) => {', 'const linhas = serie.filter(() => true).map((r) => {']], 'okFusao5');
// carimbo em texto aceito vira instante sem data: o job cai (Invalid time value) em vez de publicar
plantaErro('carimbo em texto aceito', [['lib', "if (!r || typeof r[0] !== 'number' || !isFinite(r[0]))", 'if (!r || r[0] == null)']], /Invalid time value|NaN/);
planta('copias em ordem alfabetica', [['gen', 'arqs.ied.sort((x, y) => idDe(x.nome) - idDe(y.nome) || (x.nome < y.nome ? -1 : 1));', 'arqs.ied.sort((x, y) => (x.nome < y.nome ? -1 : 1));']], 'okCopias', ['normal', 'copias']);
planta('planilha curta entra sem conferir', [['gen', '    if (semConferir) { ied[t] = new Map(); continue; }', '    if (false) { ied[t] = new Map(); continue; }']], 'okCurta', ['normal', 'curta']);

console.log(falhas ? '\n' + falhas + ' FALHA(S)' : '\nensaio-trafo: tudo ok');
process.exit(falhas ? 1 : 0);
