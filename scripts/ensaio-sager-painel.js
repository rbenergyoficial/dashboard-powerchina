'use strict';
/*
 * ensaio-sager-painel.js — sem rede. Monta um Relatorio Geral sintetico pelo caminho do lib-sager-disp (celulas e comentarios) e confere o que a lib publica,
 * refazendo as contas por outro caminho. Depois, cada plantio reescreve a lib e TEM de reprovar.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const L0 = path.join(__dirname, 'lib-sager-painel.js');
const CAP = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.109, M7: 14.733, M8: 49.11, M9: 9.822 };
const US = Object.keys(CAP);
const ORD = ['M3', 'M1', 'M2', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];   // a ordem do relatorio, de proposito fora da ordem das usinas
function nomeCol(n) { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; }
const ROT = (u) => (u === 'M3' ? 'MTD_MAURITI 3' : 'MTD_MAURITI_' + u[1]);

function folha(dias) {
  const cel = new Map(), com = new Map(), C = (c, r, v, o = {}) => cel.set(nomeCol(c) + r, { v, amarela: !!o.a, vermelha: !!o.v });
  const G = 9, H = 10;
  C(1, H, 'Data'); C(2, H, 'Patamar');
  ['Geração Verificada (MWh/h)', 'Geração Limitada (MWh/h)', 'Disponibilidade (MWh/h)', 'Geração de Referência (MWh/h)', 'Geração de Referência Final (MWh/h)', 'Razão Restrição', 'Origem Restrição'].forEach((n, i) => C(3 + i, H, n));
  C(3, G, 'Dados Verificados'); C(10, G, 'Participação na Geração de Referência por Usina'); C(19, G, 'Dados Irradiância (W/m²)'); C(28, G, 'Geração Verificada por Usina (MWh/h)'); C(37, G, 'Disponibilidade por Usina (MWh/h)');
  ORD.forEach((u, k) => { C(10 + k, H, ROT(u)); C(19 + k, H, ROT(u) + ' CEFMT' + u[1] + '_D_SOLAR_IRRAD.V'); C(28 + k, H, ROT(u)); C(37 + k, H, ROT(u)); });
  let r = H + 1;
  for (const d of dias) for (let i = 0; i < 48; i++, r++) {
    const [a, m, dd] = d.split('-'), h = String(Math.floor(i / 2)).padStart(2, '0'), mi = i % 2 ? '30' : '00', sol = i >= 12 && i < 36, lim = sol && i === 20;
    C(1, r, dd + '/' + m + '/' + a); C(2, r, h + ':' + mi + ' - ' + h + ':' + (i % 2 ? '59' : '29'));
    let tot = 0;
    ORD.forEach((u, k) => {
      const gv = sol ? +(CAP[u] * 0.5).toFixed(3) : 0; tot += gv;
      C(28 + k, r, gv); C(19 + k, r, sol ? 800 : 0);
      if (lim) C(10 + k, r, +(CAP[u] * 0.6).toFixed(3));
      if (u === 'M2') { C(37 + k, r, 24.555, { a: 1 }); com.set(nomeCol(37 + k) + r, 'Valor no SAGER: 0,000 MW. Valor proposto pelo agente: 24,555 MW'); }
      else C(37 + k, r, CAP[u]);
    });
    const dx = Object.values(CAP).reduce((a2, b) => a2 + b, 0);
    C(3, r, +tot.toFixed(3)); C(4, r, lim ? 100 : null); C(5, r, +dx.toFixed(3)); C(6, r, lim ? 250 : sol ? 200 : 0);
    C(7, r, lim ? +Object.values(CAP).reduce((a2, b) => a2 + b * 0.6, 0).toFixed(3) : null); C(8, r, lim ? 'ENE' : ''); C(9, r, lim ? 'SIS' : '');
  }
  return { cel, com };
}
const montaFontes = (D, dias) => {
  const srie = [], rest = [], irr = [], est = [];
  for (const d of dias) for (let i = 0; i < 48; i++) {
    const h = String(Math.floor(i / 2)).padStart(2, '0'), mi = i % 2 ? '30' : '00', t = d + 'T' + h + ':' + mi, sol = i >= 12 && i < 36, x = { t: t + ':00-03:00' }, e = { t: t + ':00-03:00' };
    US.forEach((u, k) => { const n = k + 1, v = sol ? CAP[u] * 0.25 : 0; x['w' + n] = +(v * 1.01).toFixed(4); if (d !== dias[1]) x['s' + n] = +v.toFixed(4); e['e' + n] = sol ? 800 : 0; irr.push({ ts: d + ' ' + h + ':' + mi + ':00', u: 'CEFMT' + n, irr: sol ? 800 : 0, ge: sol ? +(CAP[u] * 0.5).toFixed(3) : 0, gv: sol ? +(CAP[u] * 0.5).toFixed(3) : 0 }); });
    srie.push(x); est.push(e);
    rest.push({ ts: d + ' ' + h + ':' + mi + ':00', ger: 0, lim: i === 20 ? '100' : '', disp: 300, gref: sol ? 200 : 0, razao: i === 20 ? 'ENE' : '' });
  }
  return { cmp: { serie: srie }, est: { serie: est }, sg: { serie: dias.map((d) => ({ dia: d, ...Object.fromEntries(US.map((u) => [u + '_disp_24h_pct', 100])) })) }, ons: { restricao: [{ consolidado: rest }], irradiancia: [{ consolidado: irr }] }, cap: CAP, gerado: 'x' };
};

function roda(L) {
  const dias = ['2026-10-01', '2026-10-02', '2026-11-01'], falhas = [], C = (ok, m) => { if (!ok) falhas.push(m); };
  const serie = L.leRelatorio(folha(dias));
  C(serie.length === 144, 'nao leu os 144 patamares');
  C(serie[20].p[1] === 0 && serie[20].prop[1] === 24.555, 'a disponibilidade da M2 nao veio como publicada, com a proposta a parte');
  C(serie[20].s[2] === +(CAP.M3 * 0.5).toFixed(3), 'a coluna da M3 veio trocada');
  C(serie[20].gfin != null && serie[20].lim === 100 && serie[20].raz === 'ENE', 'conjunto mal lido');
  const o = L.compoe({ ...montaFontes(null, dias), serie });
  C(o.meses.length === 2 && o.meses[0].mes === '2026-10' && o.meses[0].t.length === 96, 'meses mal separados');
  const I = o.indice;
  C(I.dias.join() === dias.join() && I.ate === '2026-11-01', 'dias');
  const e = (u, i) => I.u[u].s[i], sE = US.reduce((a, u) => a + CAP[u] * 0.5 * 24 * 0.5, 0);   // 24 patamares com sol, por dia
  C(Math.abs(US.reduce((a, u) => a + e(u, 0), 0) - sE) < 0.05, 'energia SAGER do dia');
  C(US.every((u) => Math.abs(e(u, 0) - CAP[u] * 0.5 * 12) < 0.02), 'energia por usina fora do lugar');
  C(I.u.M1.k[1] === null && I.u.M1.k[0] != null, 'dia sem supervisorio nao ficou nulo');
  C(I.resumo.dias_scada === 2, 'dias inteiros do supervisorio');
  const W = US.reduce((a, u) => a + CAP[u] * 0.25 * 1.01 * 2 * 24 * 0.5, 0);
  C(Math.abs(I.resumo.s_w_pct - sE / W * 100) < 0.02, 'SAGER/medidor: ' + I.resumo.s_w_pct);
  C(I.u.M2.zeros[0] === 48 && I.u.M1.zeros[0] === 0, 'zeros');
  C(Math.abs(I.u.M2.prop[0] - 24.555 * 24) < 0.01, 'proposta menos publicada');
  const impEsp = Object.values(CAP).reduce((a, b) => a + b * 0.6, 0) / 2 - Object.values(CAP).reduce((a, b) => a + b * 0.5, 0) / 2;
  C(Math.abs(I.c.ene[0] - impEsp) < 0.02 && I.c.cnf[0] === 0, 'energia impedida: ' + I.c.ene[0] + ' x ' + impEsp);
  const cf = (id) => I.conferencia.find((x) => x.id === id);
  C(cf('gfin_soma').dif === 0 && cf('gfin_soma').n === 3, 'referencia final x participacoes');
  C(cf('disp_soma_prop').dif === 0 && cf('disp_soma').dif === 144, 'disponibilidade do conjunto');
  C(cf('irr_est').dif === 0, 'irradiancia x estacao');
  C(I.u.M1.real[0] === 49.11, 'real pelo sg_disp_dia');
  /* painel-sager-ons-v2: contestacao pendente x corrigida, o registro da rodada anterior e o conjunto dos dados abertos */
  C(I.u.M2.pend_n[0] === 48 && I.u.M2.corr_n[0] === 0 && I.u.M1.pend_n[0] === 0 && I.u.M1.corr_n[0] === 0, 'contestadas pendentes: ' + I.u.M2.pend_n[0]);
  C(Math.abs(I.u.M2.dpr[0] - 24.555) < 0.001 && I.u.M2.disp[0] === 0, 'disponibilidade com a proposta');
  C(Math.abs(I.u.M2.base[0] - I.u.M2.prop[0]) < 0.01, 'sem rodada anterior a base e o pendente');
  const sc = L.leRelatorio(folha(dias)); sc.forEach((s) => { if (s.t.slice(0, 10) === dias[0]) s.p[1] = 24.555; });   // o ONS republicou a M2 no 1º dia (p segue M1..M9)
  const ant = { dias: [dias[0]], u: { M2: { base: [I.u.M2.prop[0]] } } };
  const fc = montaFontes(null, dias); fc.ons.restricao[0].consolidado.forEach((x) => { if (x.ts.slice(0, 10) === dias[0]) x.disp = +Object.values(CAP).reduce((a2, b) => a2 + b, 0).toFixed(3); });
  const I2 = L.compoe({ ...fc, serie: sc, anterior: ant }).indice;
  C(I2.u.M2.pend_n[0] === 0 && I2.u.M2.corr_n[0] === 48 && I2.u.M2.prop[0] === 0, 'republicado nao virou corrigido: ' + I2.u.M2.pend_n[0] + '/' + I2.u.M2.corr_n[0]);
  C(Math.abs(I2.u.M2.base[0] - I.u.M2.prop[0]) < 0.01 && I2.u.M2.base[1] === I2.u.M2.prop[1], 'o registro esqueceu o contestado: ' + I2.u.M2.base[0]);
  C(I2.c.ab_n[0] === 24 && I2.c.ab_pub[0] === 24 && I2.c.ab_pro[0] === 24 && I2.c.cx_pro[0] === 48, 'conjunto dos dados abertos: ' + [I2.c.ab_n[0], I2.c.ab_pub[0], I2.c.ab_pro[0], I2.c.cx_pro[0]]);
  C(I.c.ab_pro[0] === 0 && I.c.ab_n[0] === 24, 'aberto diferente nao foi acusado');
  const I3 = L.compoe({ ...fc, serie: L.leRelatorio(folha(dias)) }).indice;   // M2 ainda pendente e o conjunto aberto com a proposta
  C(I3.c.ab_pro[0] === 24 && I3.c.ab_pub[0] === 24 && I3.u.M2.pend_n[0] === 48, 'aberto com a proposta nao foi visto: ' + [I3.c.ab_pro[0], I3.c.ab_pub[0]]);
  const mal = folha(dias); mal.cel.delete('A11'); mal.cel.delete('B11');
  let e1 = 0; try { L.leRelatorio(folha(['2026-10-01']).cel ? (() => { const f = folha(['2026-10-01']); f.cel.delete('A58'); return f; })() : mal); } catch (x) { e1 = 1; }
  C(e1, 'dia partido nao estourou');
  const ruim = L.leRelatorio(folha(dias)); ruim[20].p[0] = 60;
  let e2 = 0; try { L.compoe({ ...montaFontes(null, dias), serie: ruim }); } catch (x) { e2 = 1; }
  C(e2, 'disponibilidade acima da capacidade nao estourou');
  const r2 = L.leRelatorio(folha(dias)); r2[20].gv = 1;
  let e3 = 0; try { L.compoe({ ...montaFontes(null, dias), serie: r2 }); } catch (x) { e3 = 1; }
  C(e3, 'conjunto que nao fecha nao estourou');
  return falhas;
}

const real = roda(require(L0));
if (real.length) { console.error('🔴 o codigo real reprovou:\n  ' + real.join('\n  ')); process.exit(1); }
console.log('✅ o codigo real passa');
const PL = [
  ['M3 na coluna da M1', "U.s.push(r3(s.s[i]));", "U.s.push(r3(s.s[(i + 1) % 9]));"],
  ['proposta no lugar da publicada', "U.disp.push(r3(s.p[i]));", "U.disp.push(r3(s.prop[i] != null ? s.prop[i] : s.p[i]));"],
  ['energia sem o meio', "U.w.push(w == null ? null : r3(w * 2));", "U.w.push(w == null ? null : r3(w));"],
  ['dia partido conta', "(I.every((i) => U[k][i] != null) ? ", "(true ? "],
  ['impedida pela referencia', "imp[k] += Math.max(0, c.gfin[i] - c.gv[i]) / 2;", "imp[k] += Math.max(0, c.gref[i] - c.gv[i]) / 2;"],
  ['zero conta nulo', "X.zeros.push(I.filter((i) => U.disp[i] === 0).length);", "X.zeros.push(I.filter((i) => !U.disp[i] && U.disp[i] !== 0).length);"],
  ['dia partido passa no relatorio', "if (n !== 48) throw", "if (false) throw"],
  ['guarda da capacidade cala', "if (v != null && v > cap[US[i]] * 1.02) throw", "if (false) throw"],
  ['guarda do conjunto cala', "if (g.dif) throw", "if (false) throw"],
  ['estacao errada', "r3(num(e['e' + n]))", "r3(num(e['e' + ((n % 9) + 1)]) * 0.5)"],
  ['corrigida conta como pendente', "U.prop[i] - (U.disp[i] || 0) > 0.1).length", "U.prop[i] - (U.disp[i] || 0) > -1e9).length"],
  ['registro esquece a rodada anterior', "return +Math.max(X.prop[i], a == null ? 0 : a).toFixed(2);", "return +X.prop[i].toFixed(2);"],
  ['aberto contra a soma publicada', "Math.abs(c.o_disp[i] - sPro(i)) <= 0.35", "Math.abs(c.o_disp[i] - US.reduce((a, u) => a + (m.u[u].disp[i] || 0), 0)) <= 0.35"],
];
const fonte = fs.readFileSync(L0, 'utf8'), dir = fs.mkdtempSync(path.join(__dirname, '.pl-'));
let ruins = 0;
try {
  for (const n of ['lib-sager-disp.js', 'lib-zip.js']) fs.copyFileSync(path.join(__dirname, n), path.join(dir, n));
  PL.forEach(([nome, de, para], i) => {
    if (fonte.split(de).length !== 2) { console.error('🔴 PLANTIO INVALIDO: ' + nome); ruins++; return; }
    const p = path.join(dir, 'p' + i + '.js'); fs.writeFileSync(p, fonte.replace(de, para));
    let r; try { r = roda(require(p)); } catch (e) { r = [e.message]; }
    if (!r.length) { console.error('🔴 PLANTIO PASSOU: ' + nome); ruins++; } else console.log('  ✅ reprovado: ' + nome + ' (' + r[0].slice(0, 70) + ')');
  });
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
if (ruins) { console.error('🔴 ensaio falhou: ' + ruins); process.exit(1); }
console.log('✅ ensaio limpo: ' + PL.length + ' plantios reprovados');
