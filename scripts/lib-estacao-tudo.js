'use strict';
/*
 * lib-estacao-tudo.js — TODAS as grandezas do datalogger das estacoes solarimetricas (CR1000X, CSIXML de 10 min), para a pagina
 * Estacao Meteorologica do portal (14/10/2026, PROMOVER estacao-tudo). A irradiancia no plano em meia hora continua na
 * lib-estacao-logger (estacao_logger_30min.json, que o PV · Sungrow usa); esta le o resto e faz o resumo do dia e o 10 min recente.
 *
 * Pedido do humano (14/10/2026): "para o painel estacao meteorologica, considerar os dados datalogger, os dados do supervisorio deve
 * entrar apenas no painel comparativo".
 *
 * 🔴 O QUE FOI MEDIDO ANTES DE ESCREVER (4.019 arquivos de 10 min, 24/07/2025 a 13/10/2026, nove estacoes): um so conjunto de 57
 *    campos em todos os arquivos (lido mesmo assim PELO NOME); o rotulo de cada registro e o FIM dos 10 min, hora local
 *    (lib-estacao-logger); e, nos valores:
 *    · vento a 75,0 m/s em ~2.760 registros, velocidade media e rajada iguais: o TETO do anemometro, leitura travada, nao vento;
 *    · albedo de 10 min ate 91 com pouca luz (razao de dois numeros pequenos): o albedo do dia e a razao das SOMAS com sol forte;
 *    · perda das celulas de sujeira de -24 a +55 %, mediana perto de zero, negativos frequentes: desvio de calibracao do par;
 *    · ponto de orvalho a 101 °C e modulo a 98 °C em leituras isoladas: impossiveis, contadas como fora da faixa.
 * As FAIXAS abaixo sao a faixa fisicamente possivel de cada grandeza no local (nao sao limiar de cor nem de alarme); a leitura fora
 * dela nao entra nas contas e e contada no dia (`fora`). Irradiancia ate 1.800 W/m2: o mesmo teto da lib-estacao-logger.
 */
const VARS = [
  // chave, campo do datalogger, faixa [min, max]
  ['poa', 'Irr_Tilted_1_Avg', [0, 1800]], ['ghi', 'Irr_Up_Avg', [0, 1800]], ['refl', 'Irr_Down_Avg', [0, 1800]],
  ['dif', 'Irr_Difuse_Avg', [0, 1800]], ['dni', 'Irr_Direct_Avg', [0, 1800]],
  ['ta', 'AmbTemp_Avg', [-10, 60]], ['tax', 'AmbTemp_Max', [-10, 60]], ['tan', 'AmbTemp_Min', [-10, 60]],
  ['ur', 'RelH_Avg', [0, 100]], ['po', 'DEW_Point_Avg', [-30, 40]],
  ['tm1', 'TempPanel1_Avg', [-10, 95]], ['tm2', 'TempPanel2_Avg', [-10, 95]], ['tm3', 'TempPanel3_Avg', [-10, 95]], ['tm4', 'TempPanel4_Avg', [-10, 95]],
  ['ws', 'WS_Avg', [0, 60]], ['wsx', 'WS_Max', [0, 70]], ['wd', 'WD_Avg', [0, 360]], ['chuva', 'Precip_Tot', [0, 60]],
  ['s1', 'Irr_Soil_Sens1_loss_Avg', [-50, 100]], ['s2', 'Irr_Soil_Sens2_loss_Avg', [-50, 100]],
  ['bat', 'batt_volt_Min', [9, 16]], ['tl', 'PTemp_Avg', [-10, 80]],
];
const K = Object.fromEntries(VARS.map((v, i) => [v[0], i]));
const TETO_VENTO = 75;        // m/s: o teto do anemometro (medido: ~2.760 registros com media e rajada exatamente iguais a 75)
const SOL_FORTE = 600;        // W/m2 no plano: temperatura de modulo e sujeira so com sol forte (o modulo aquecido, a celula em regime)
const SOL_ALB = 200;          // W/m2 global: o albedo do dia so com a global acima disto (abaixo, a razao de 10 min dispara)
const NOITE = [19 * 60, 5 * 60];   // a irradiancia acima de 20 W/m2 entre 19:00 e 05:00 e leitura de sensor, nao sol
const H = 10 / 60;            // horas de um registro

/* CSIXML -> [[instante 'YYYY-MM-DDTHH:MM' (fim dos 10 min), [valor|null por VARS], [flag por VARS: 0 ok, 1 fora, 2 teto]], ...].
   Campo faltando estoura com o nome (o arquivo inteiro fica fora: tudo-ou-nada por arquivo). */
function leTudo(txt, onde) {
  const nomes = []; const reF = /<field name="([^"]+)"/g; let m;
  while ((m = reF.exec(txt))) nomes.push(m[1]);
  const ix = VARS.map(([k, c]) => { const i = nomes.indexOf(c); if (i < 0) throw new Error((onde || 'arquivo') + ': campo ' + c + ' ausente'); return i + 1; });
  const out = [];
  const reR = /<r time="(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::\d\d)?"[^>]*>([\s\S]*?)<\/r>/g;
  while ((m = reR.exec(txt))) {
    const vs = {}; const reV = /<v(\d+)>([^<]*)<\/v\d+>/g; let v;
    while ((v = reV.exec(m[2]))) vs[v[1]] = v[2];
    const val = [], fl = [];
    VARS.forEach(([k, c, f], j) => {
      const s = vs[ix[j]]; const x = s == null || s === '' || /nan|inf/i.test(s) ? null : Number(s);
      if (x == null || !Number.isFinite(x)) { val.push(null); fl.push(0); return; }
      if ((k === 'ws' || k === 'wsx') && x === TETO_VENTO) { val.push(null); fl.push(2); return; }
      if (x < f[0] || x > f[1]) { val.push(null); fl.push(1); return; }
      val.push(x); fl.push(0);
    });
    out.push([m[1], val, fl]);
  }
  return out;
}

const minutos = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
const instante = (min) => new Date(min * 60000).toISOString().slice(0, 16);
/* o dia de um registro e o do INICIO do intervalo (o de 00:00 cobre 23:50-00:00 do dia anterior) */
const diaDe = (t) => instante(minutos(t) - 10).slice(0, 10);
const r = (x, k) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** k) / 10 ** k);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const mediana = (a) => { if (!a.length) return null; const b = a.slice().sort((x, y) => x - y), n = b.length; return n % 2 ? b[n >> 1] : (b[n / 2 - 1] + b[n / 2]) / 2; };

/* o resumo de UM dia de uma estacao, a partir dos registros do dia: [[t, val, fl], ...] */
function resumoDia(d, regs) {
  const col = (k) => regs.map((x) => x[1][K[k]]);
  const ok = (k) => col(k).filter((x) => x != null);
  const soma = (k) => { const v = ok(k); return v.length ? v.reduce((s, x) => s + x * H, 0) / 1000 : null; };   // kWh/m2
  const poa = col('poa'), ghi = col('ghi'), refl = col('refl');
  let sg = 0, sr = 0; regs.forEach((x, i) => { if (ghi[i] != null && refl[i] != null && ghi[i] >= SOL_ALB) { sg += ghi[i]; sr += refl[i]; } });
  const forte = regs.map((x, i) => poa[i] != null && poa[i] >= SOL_FORTE);
  const tmS = ['tm1', 'tm2', 'tm3', 'tm4'].map((k) => media(col(k).filter((x, i) => x != null && forte[i])));
  const tmAll = []; regs.forEach((x, i) => { if (!forte[i]) return; const v = ['tm1', 'tm2', 'tm3', 'tm4'].map((k) => x[1][K[k]]).filter((y) => y != null); if (v.length) tmAll.push(media(v)); });
  const dta = []; regs.forEach((x, i) => { if (!forte[i] || x[1][K.ta] == null) return; const v = ['tm1', 'tm2', 'tm3', 'tm4'].map((k) => x[1][K[k]]).filter((y) => y != null); if (v.length) dta.push(media(v) - x[1][K.ta]); });
  // a direcao predominante: a media VETORIAL ponderada pela velocidade (0 = norte, sentido horario)
  let vx = 0, vy = 0; regs.forEach((x) => { const s = x[1][K.ws], a = x[1][K.wd]; if (s != null && a != null) { vx += s * Math.sin(a * Math.PI / 180); vy += s * Math.cos(a * Math.PI / 180); } });
  const wd = vx || vy ? (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360 : null;
  const noite = regs.filter((x) => { const mi = (minutos(x[0]) - 10) % 1440; const p = x[1][K.poa]; return p != null && p > 20 && (mi >= NOITE[0] || mi < NOITE[1]); }).length;
  const fora = {}, teto = {}; regs.forEach((x) => x[2].forEach((f, j) => { if (f === 1) fora[VARS[j][0]] = (fora[VARS[j][0]] || 0) + 1; if (f === 2) teto[VARS[j][0]] = (teto[VARS[j][0]] || 0) + 1; }));
  const chv = ok('chuva');
  const o = { d, n: regs.length, n_poa: ok('poa').length,
    poa: r(soma('poa'), 3), ghi: r(soma('ghi'), 3), dif: r(soma('dif'), 3), dni: r(soma('dni'), 3), refl: r(soma('refl'), 3),
    poa_max: r(ok('poa').length ? Math.max(...ok('poa')) : null, 0), alb: sg ? r(sr / sg, 3) : null,
    ta: r(media(ok('ta')), 1), ta_max: r(ok('tax').length ? Math.max(...ok('tax')) : null, 1), ta_min: r(ok('tan').length ? Math.min(...ok('tan')) : null, 1),
    ur: r(media(ok('ur')), 1), ur_min: r(ok('ur').length ? Math.min(...ok('ur')) : null, 1), po: r(media(ok('po')), 1),
    tm_sol: r(media(tmAll), 1), tm1: r(tmS[0], 1), tm2: r(tmS[1], 1), tm3: r(tmS[2], 1), tm4: r(tmS[3], 1), dt_sol: r(media(dta), 1),
    tm_max: r(Math.max(...['tm1', 'tm2', 'tm3', 'tm4'].map((k) => ok(k)).flat().concat([-99])), 1),
    ws: r(media(ok('ws')), 2), ws_max: r(ok('wsx').length ? Math.max(...ok('wsx')) : null, 2), wd: r(wd, 0),
    chuva: chv.length ? r(chv.reduce((s, x) => s + x, 0), 1) : null, chuva_10: chv.length ? r(Math.max(...chv), 1) : null,
    s1: r(mediana(col('s1').filter((x, i) => x != null && forte[i])), 1), s2: r(mediana(col('s2').filter((x, i) => x != null && forte[i])), 1),
    bat: r(ok('bat').length ? Math.min(...ok('bat')) : null, 2), tl_max: r(ok('tl').length ? Math.max(...ok('tl')) : null, 1),
    noite };
  if (o.tm_max === -99) o.tm_max = null;
  if (Object.keys(fora).length) o.fora = fora;
  if (Object.keys(teto).length) o.teto = teto;
  return o;
}

/* os registros de uma estacao (Map instante -> [val, fl]) -> o resumo de cada dia */
function resumos(m) {
  const porDia = new Map();
  for (const [t, x] of m) { const d = diaDe(t); (porDia.get(d) || porDia.set(d, []).get(d)).push([t, x[0], x[1]]); }
  return [...porDia.keys()].sort().map((d) => resumoDia(d, porDia.get(d).sort((a, b) => (a[0] < b[0] ? -1 : 1))));
}

/* o 10 min dos ultimos `nDias` dias de uma estacao, numa grade de 144 por dia (rotulo no FIM: o 1o do dia e 00:10) */
const DEC = { poa: 0, ghi: 0, refl: 0, dif: 0, dni: 0, ta: 1, tax: 1, tan: 1, ur: 0, po: 1, tm1: 1, tm2: 1, tm3: 1, tm4: 1, ws: 2, wsx: 2, wd: 0, chuva: 1, s1: 1, s2: 1, bat: 2, tl: 1 };
function recente(m, nDias) {
  const dias = [...new Set([...m.keys()].map(diaDe))].sort().slice(-nDias);
  const v = Object.fromEntries(VARS.map(([k]) => [k, new Array(dias.length * 144).fill(null)]));
  const di = new Map(dias.map((d, i) => [d, i]));
  for (const [t, x] of m) {
    const i = di.get(diaDe(t)); if (i == null) continue;
    const j = Math.round(((minutos(t) - 10) % 1440) / 10); if (j < 0 || j > 143) continue;
    VARS.forEach(([k], q) => { v[k][i * 144 + j] = r(x[0][q], DEC[k]); });
  }
  return { dias, v };
}

module.exports = { VARS, K, TETO_VENTO, SOL_FORTE, SOL_ALB, leTudo, resumoDia, resumos, recente, diaDe, minutos };
