'use strict';
/*
 * ensaio-estacao-tudo.js — todas as grandezas do datalogger das estacoes (lib-estacao-tudo.js, PROMOVER estacao-tudo), sem rede.
 *
 * Um arquivo CSIXML montado aqui, com os campos FORA da ordem real, dois dias de registro de 10 min com a irradiancia num seno:
 *   · campo pelo NOME; campo faltando estoura com o nome;
 *   · o registro rotulado 00:00 e do dia ANTERIOR (o rotulo e o fim dos 10 min);
 *   · irradiacao do dia = soma x 1/6 h; albedo = soma da refletida / soma da global so com a global acima de 200 W/m2 (um registro de
 *     pouca luz com refletida = global nao pesa); temperatura de modulo e sujeira so com o plano acima de 600 W/m2;
 *   · vento a 75 m/s fora das contas e contado como teto; orvalho a 101 °C fora e contado como fora da faixa; NAN fora;
 *   · irradiancia acima de 20 W/m2 a noite contada; direcao predominante pela media vetorial (350° e 10° dao 0°, nao 180°);
 *   · o 10 min recente na grade de 144 por dia, so os ultimos N dias;
 * e cada defeito plantado na lib (uma copia mudada) tem de reprovar com a falha declarada.
 *
 *    node scripts/ensaio-estacao-tudo.js
 */
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, 'lib-estacao-tudo.js');

const ORDEM = ['WS_Max', 'Irr_Tilted_1_Avg', 'AmbTemp_Avg', 'AmbTemp_Max', 'AmbTemp_Min', 'RelH_Avg', 'DEW_Point_Avg', 'TempPanel1_Avg', 'TempPanel2_Avg',
  'TempPanel3_Avg', 'TempPanel4_Avg', 'Irr_Up_Avg', 'Irr_Down_Avg', 'Irr_Difuse_Avg', 'Irr_Direct_Avg', 'Precip_Tot', 'Irr_Soil_Sens1_loss_Avg',
  'Irr_Soil_Sens2_loss_Avg', 'WS_Avg', 'WD_Avg', 'batt_volt_Min', 'PTemp_Avg', 'ALBEDO_Avg'];
const sol = (min) => { const h = min / 60; return h < 6 || h > 18 ? 0 : Math.round(1000 * Math.sin(Math.PI * (h - 6) / 12) ** 2 * 10) / 10; };
/* um registro rotulado no FIM t (min do dia 10..1440); `q` muda campos */
function reg(d, fim, q) {
  const ini = fim - 10, p = sol(ini + 5);
  const v = { Irr_Tilted_1_Avg: p, Irr_Up_Avg: p * 0.9, Irr_Down_Avg: p * 0.9 * 0.25, Irr_Difuse_Avg: p * 0.1, Irr_Direct_Avg: p * 0.8,
    AmbTemp_Avg: 25, AmbTemp_Max: 26, AmbTemp_Min: 24, RelH_Avg: 60, DEW_Point_Avg: 17, TempPanel1_Avg: 25 + p * 0.03, TempPanel2_Avg: 25 + p * 0.03,
    TempPanel3_Avg: 25 + p * 0.03, TempPanel4_Avg: 25 + p * 0.03 + 2, WS_Avg: 2, WS_Max: 4, WD_Avg: ini < 720 ? 350 : 10, Precip_Tot: 0,
    Irr_Soil_Sens1_loss_Avg: p >= 600 ? 3 : 40, Irr_Soil_Sens2_loss_Avg: p >= 600 ? -2 : -40, batt_volt_Min: 13.5, PTemp_Avg: 30, ALBEDO_Avg: 0.25 };
  Object.assign(v, (q || {}));
  const h = String(Math.floor((fim % 1440) / 60)).padStart(2, '0') + ':' + String(fim % 60).padStart(2, '0');
  const dd = fim === 1440 ? new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10) : d;
  return '<r time="' + dd + 'T' + h + ':00" no="1">' + ORDEM.map((c, k) => '<v' + (k + 1) + '>' + v[c] + '</v' + (k + 1) + '>').join('') + '</r>';
}
function arquivo(linhas, sem) {
  return '<?xml version="1.0" standalone="yes"?>\n<csixml version="1.0">\n<head>\n<fields>\n'
    + ORDEM.map((c) => '<field name="' + (c === sem ? 'outro' : c) + '" type="xsd:float"/>').join('\n') + '\n</fields>\n</head>\n<data>\n' + linhas.join('\n') + '\n</data>\n</csixml>\n';
}
const D1 = '2026-10-08', D2 = '2026-10-09', D3 = '2026-10-10';
const linhas = [];
for (const d of [D1, D2, D3]) for (let fim = 10; fim <= 1440; fim += 10) {
  const q = {};
  if (d === D1 && fim === 600) Object.assign(q, { WS_Avg: 75, WS_Max: 75 });          // teto do anemometro
  if (d === D1 && fim === 610) q.DEW_Point_Avg = 101;                                    // fora da faixa
  if (d === D1 && fim === 620) q.AmbTemp_Avg = 'NAN';                                    // sem leitura
  if (d === D1 && fim === 1300) q.Irr_Tilted_1_Avg = 35;                                // 21:30: sensor a noite
  if (d === D1 && fim === 400) Object.assign(q, { Irr_Up_Avg: 150, Irr_Down_Avg: 150 }); // pouca luz com refletida = global: nao pesa no albedo
  if (d === D2 && fim === 900) q.Precip_Tot = 4.2;
  linhas.push(reg(d, fim, q));
}
const A = arquivo(linhas);

function ensaio(libPath) {
  delete require.cache[require.resolve(libPath)];
  const T = require(libPath);
  const f = [];
  const ok = (c, m) => { if (!c) f.push(m); };
  let R = [];
  try { R = T.leTudo(A, 'a.dat'); } catch (e) { f.push('leTudo estourou: ' + e.message); return f; }
  ok(R.length === 3 * 144, 'leTudo: 432 registros, veio ' + R.length);
  const m = new Map(R.map(([t, v, fl]) => [t, [v, fl]]));
  const S = T.resumos(m), s1 = S.find((x) => x.d === D1) || {}, s2 = S.find((x) => x.d === D2) || {};
  ok(S.length === 3 && s1.n === 144 && s2.n === 144, 'dias: 3 de 144 registros (o rotulado 00:00 e do dia anterior): ' + S.map((x) => x.d + ':' + x.n).join(' '));
  let poa = 0; for (let fim = 10; fim <= 1440; fim += 10) poa += (fim === 1300 ? 35 : sol(fim - 5)) / 6;
  ok(Math.abs(s1.poa - poa / 1000) < 0.002, 'irradiacao do dia = soma x 1/6 h: ' + s1.poa + ' (esperado ' + (poa / 1000).toFixed(3) + ')');
  ok(s1.alb === 0.25, 'albedo pelas somas so com a global acima de 200 W/m2 (o registro de pouca luz fora): ' + s1.alb);
  const forte = []; for (let fim = 10; fim <= 1440; fim += 10) if (sol(fim - 5) >= 600) forte.push(sol(fim - 5));
  const tmEsp = Math.round(10 * forte.reduce((a, p) => a + 25 + p * 0.03 + 0.5, 0) / forte.length) / 10;
  ok(s1.tm_sol === tmEsp && s1.tm4 === Math.round(10 * forte.reduce((a, p) => a + 27 + p * 0.03, 0) / forte.length) / 10, 'temperatura de modulo so com sol forte: ' + s1.tm_sol + ' (esperado ' + tmEsp + ')');
  ok(s1.s1 === 3 && s1.s2 === -2, 'sujeira so com sol forte (fora dele a celula le 40 e -40): ' + s1.s1 + ' / ' + s1.s2);
  ok(s1.ws_max === 4 && s1.ws === 2 && s1.teto && s1.teto.ws === 1 && s1.teto.wsx === 1, 'vento no teto (75 m/s) fora das contas e contado: ' + JSON.stringify([s1.ws, s1.ws_max, s1.teto]));
  ok(s1.fora && s1.fora.po === 1 && s1.po === 17, 'orvalho a 101 °C fora da media e contado como fora da faixa: ' + JSON.stringify([s1.po, s1.fora]));
  ok(s1.ta === 25 && s1.n === 144, 'NAN fora da media, o registro conta: ' + s1.ta);
  ok(s1.noite === 1 && s2.noite === 0, 'irradiancia a noite contada: ' + s1.noite);
  ok(s1.wd === 0 || s1.wd === 360, 'direcao predominante pela media vetorial (350° e 10° dao 0°): ' + s1.wd);
  ok(s2.chuva === 4.2 && s2.chuva_10 === 4.2 && s1.chuva === 0, 'chuva do dia e a maior de 10 min: ' + s2.chuva);
  const rc = T.recente(m, 2);
  ok(rc.dias.join() === [D2, D3].join() && rc.v.poa.length === 288 && rc.v.chuva[0 * 144 + 89] === 4.2 && rc.v.poa[0] === 0, 'o 10 min recente: os ultimos 2 dias, 144 por dia, o registro das 15:00 de D2 no intervalo 14:50 (j = 89)');
  let est = null; try { T.leTudo(arquivo(linhas.slice(0, 3), 'WD_Avg'), 'b.dat'); } catch (e) { est = e.message; }
  ok(est && /b\.dat: campo WD_Avg ausente/.test(est), 'campo faltando estoura com o nome: ' + est);
  return f;
}

const f0 = ensaio(LIB);
console.log(f0.length ? f0.map((x) => '  FALHA ' + x).join('\n') : '  a lib passa');
let falhou = f0.length > 0;
const src = fs.readFileSync(LIB, 'utf8'), tmp = path.join(__dirname, '_plantio_lib_estacao_tudo.js');
const planta = (nome, de, para, espera) => {
  if (src.split(de).length !== 2) { console.log('  FALHA plantio ' + nome + ': trecho nao casou'); falhou = true; return; }
  fs.writeFileSync(tmp, src.split(de).join(para));
  let r; try { r = ensaio(tmp); } catch (e) { r = ['estourou: ' + e.message]; }
  const certo = r.some((x) => espera.test(x));
  console.log((certo ? '  ok   ' : '  FALHA ') + 'plantio "' + nome + '" reprova em: ' + (r.find((x) => espera.test(x)) || r[0] || 'nada').slice(0, 90));
  if (!certo) falhou = true;
};
try {
  planta('dia pelo rotulo (sem os 10 min)', 'const diaDe = (t) => instante(minutos(t) - 10).slice(0, 10);', 'const diaDe = (t) => t.slice(0, 10);', /^dias: 3 de 144/);
  planta('albedo sem o filtro de sol', 'if (ghi[i] != null && refl[i] != null && ghi[i] >= SOL_ALB)', 'if (ghi[i] != null && refl[i] != null)', /^albedo pelas somas/);
  planta('modulo sem sol forte', "const tmS = ['tm1', 'tm2', 'tm3', 'tm4'].map((k) => media(col(k).filter((x, i) => x != null && forte[i])));", "const tmS = ['tm1', 'tm2', 'tm3', 'tm4'].map((k) => media(col(k).filter((x) => x != null)));", /^temperatura de modulo/);
  planta('sujeira sem sol forte', "s1: r(mediana(col('s1').filter((x, i) => x != null && forte[i])), 1)", "s1: r(mediana(col('s1').filter((x) => x != null)), 1)", /^sujeira so com sol forte/);
  planta('teto do vento como leitura', "if ((k === 'ws' || k === 'wsx') && x === TETO_VENTO) { val.push(null); fl.push(2); return; }", '', /^vento no teto/);
  planta('sem a faixa fisica', 'if (x < f[0] || x > f[1]) { val.push(null); fl.push(1); return; }', '', /^orvalho a 101/);
  planta('direcao pela media simples', 'const wd = vx || vy ? (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360 : null;', "const wd = media(ok('wd'));", /^direcao predominante/);
  planta('noite sem o horario', 'return p != null && p > 20 && (mi >= NOITE[0] || mi < NOITE[1]);', 'return p != null && p > 20;', /^irradiancia a noite/);
  planta('irradiacao sem o 1/6 h', 'v.reduce((s, x) => s + x * H, 0) / 1000', 'v.reduce((s, x) => s + x, 0) / 1000', /^irradiacao do dia/);
  planta('campo pela posicao', "const ix = VARS.map(([k, c]) => { const i = nomes.indexOf(c); if (i < 0) throw new Error((onde || 'arquivo') + ': campo ' + c + ' ausente'); return i + 1; });",
    "const ix = VARS.map((x, j) => j + 1);", /./);
} finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
if (falhou) { console.error('ensaio-estacao-tudo: REPROVADO'); process.exit(1); }
console.log('ensaio-estacao-tudo: TUDO PASSOU');
