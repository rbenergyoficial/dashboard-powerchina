'use strict';
/*
 * ensaio-comparativo-trapezio.js — o SCADA do comparativo vira energia pelo TRAPEZIO entre amostras (10/10/2026).
 *
 * Sem rede. Importa as pecas do gen-comparativo (quem sobe) e julga contra a integral EXATA de potencias sinteticas:
 * numa rampa o trapezio acerta e o retangulo (o metodo anterior) erra — o ensaio prova as duas coisas, para que um
 * retorno ao retangulo reprove. Confere tambem buraco, virada de dia, a remontagem unica pela marca e a ligacao no
 * corpo principal.
 *
 * uso: node scripts/ensaio-comparativo-trapezio.js
 */
const fs = require('fs');
const path = require('path');
const C = require('./gen-comparativo');

let falhas = 0, casos = 0;
function ok(cond, msg) { casos++; if (!cond) { falhas++; console.log('  REPROVADO · ' + msg); } else console.log('  ok · ' + msg); }
const perto = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// chave 'AAAA-MM-DDTHH:MM' -> minutos desde o inicio do dia 0
const chave = (dia, min) => '2026-10-0' + dia + 'T' + String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
// amostras de potencia (MW) a cada 5 min no dia 1, das 06:00 as 18:00, por usina
function amostras(P) { const a = {}; for (let m = 360; m <= 1080; m += 5) a[m] = P(m); return a; }
// o que o supervisorio publica: retangulo de 5 min (P x 5/60) e a soma de tres em 15 min
function mapa5(PU) { const mp = new Map(); for (const [u, A] of Object.entries(PU)) for (const m of Object.keys(A)) { const k = chave(1, +m); const l = mp.get(k) || {}; l[u] = A[m] * 5 / 60; mp.set(k, l); } return mp; }
function mapa15(PU) { const mp = new Map(); for (const [u, A] of Object.entries(PU)) for (let m = 360; m + 10 <= 1080; m += 15) { if (A[m + 10] == null) continue; const k = chave(1, m); const l = mp.get(k) || {}; l[u] = (A[m] + A[m + 5] + A[m + 10]) * 5 / 60; mp.set(k, l); } return mp; }
// integral exata (MWh) de uma potencia de [t0, t1] minutos, por Simpson fino
function integral(P, t0, t1) { const n = 600, h = (t1 - t0) / n; let s = P(t0) + P(t1); for (let i = 1; i < n; i++) s += (i % 2 ? 4 : 2) * P(t0 + i * h); return s * h / 3 / 60; }

console.log('1. rampa (potencia em reta): o trapezio de 5 min e EXATO; o retangulo nao');
{ const P = (m) => 2 + 0.05 * (m - 360);
  const r = mapa5({ M1: amostras(P) }); const t = C.trapezio(r, 5);
  const k = chave(1, 600), ex = integral(P, 600, 605);
  ok(perto(t.get(k).M1, ex), 'trapezio 5 min = integral (' + t.get(k).M1.toFixed(6) + ' = ' + ex.toFixed(6) + ')');
  ok(!perto(r.get(k).M1, ex, 1e-6), 'plantio: o retangulo erra na mesma rampa (' + r.get(k).M1.toFixed(6) + ')'); }

console.log('2. rampa no balde de 15 min (so a SOMA de tres amostras): a reta entre baldes tambem e exata');
{ const P = (m) => 1 + 0.08 * (m - 360);
  const r = mapa15({ M2: amostras(P) }); const t = C.trapezio(r, 15);
  const k = chave(1, 720), ex = integral(P, 720, 735);
  ok(perto(t.get(k).M2, ex), 'trapezio 15 min = integral (' + t.get(k).M2.toFixed(6) + ' = ' + ex.toFixed(6) + ')');
  ok(!perto(r.get(k).M2, ex, 1e-6), 'plantio: o retangulo de 15 min erra (' + r.get(k).M2.toFixed(6) + ')');
  const t30 = C.agregaCompleto(t, 15, 30); const k30 = chave(1, 720);
  ok(perto(t30.get(k30).M2, integral(P, 720, 750)), 'a meia hora (soma de dois quinzes) tambem fecha com a integral'); }

// ⚠️ Balde a balde nao: no pico do sino o retangulo acerta por simetria (os dois lados se compensam) e um criterio
//    "todo balde" reprovaria o certo. Julga-se o erro somado e o pior erro do dia.
console.log('3. curva de sino (dia de sol): o trapezio erra menos que o retangulo no dia e no pior balde de 30 min');
{ const P = (m) => Math.max(0, 40 * Math.sin(Math.PI * (m - 360) / 720));
  const r = mapa15({ M3: amostras(P) }); const t = C.agregaCompleto(C.trapezio(r, 15), 15, 30), q = C.agrega(r, 30);
  let et = 0, eq = 0, mt = 0, mq = 0, total = 0;
  for (const [k, l] of t) { const m = (+k.slice(11, 13)) * 60 + (+k.slice(14, 16)); if (m + 30 > 1080) continue; total++;
    const ex = integral(P, m, m + 30); const a = Math.abs(l.M3 - ex), b = Math.abs(q.get(k).M3 - ex);
    et += a; eq += b; mt = Math.max(mt, a); mq = Math.max(mq, b); }
  ok(total > 20 && et < eq / 3, 'erro somado: trapezio ' + et.toFixed(4) + ' contra retangulo ' + eq.toFixed(4) + ' MWh (' + total + ' baldes)');
  ok(mt < mq / 3, 'pior balde: trapezio ' + mt.toFixed(4) + ' contra retangulo ' + mq.toFixed(4) + ' MWh'); }

console.log('4. sem o balde seguinte o balde fica de fora; usina sem o seguinte sai so ela');
{ const r = new Map([[chave(1, 600), { M1: 1, M2: 2 }], [chave(1, 615), { M1: 3 }]]);
  const t = C.trapezio(r, 15);
  ok(t.has(chave(1, 600)) && t.get(chave(1, 600)).M1 === 1 + (3 - 1) / 6 && !('M2' in t.get(chave(1, 600))), 'M1 calculada, M2 ausente (sem seguinte)');
  ok(!t.has(chave(1, 615)), 'ultimo balde da serie ausente, nunca retangulo'); }

console.log('4b. meia hora com um quarto de hora faltando nao sai pela metade');
{ const r = new Map([[chave(1, 600), { M1: 1, M2: 1 }], [chave(1, 615), { M1: 1, M2: 1 }], [chave(1, 630), { M1: 1 }]]);
  const t = C.trapezio(r, 15);
  ok(t.has(chave(1, 615)) && !('M2' in t.get(chave(1, 615))), 'plantio feito: M2 sem o quarto das 10:15 depois do trapezio');
  const a = C.agregaCompleto(t, 15, 30);
  ok(a.has(chave(1, 600)) && perto(a.get(chave(1, 600)).M1, 2) && !('M2' in a.get(chave(1, 600))), 'M1 com os dois quartos sai; M2 com um so fica de fora');
  ok(perto(C.agrega(t, 30).get(chave(1, 600)).M2, 1), 'plantio: a soma simples publicaria M2 pela metade'); }

console.log('5. o balde das 23:55 usa a amostra das 00:00 do dia seguinte');
{ const r = new Map([[chave(1, 1435), { M9: 0.6 }], [chave(2, 0), { M9: 0.0 }]]);
  const t = C.trapezio(r, 5);
  ok(t.has(chave(1, 1435)) && perto(t.get(chave(1, 1435)).M9, 0.3), '23:55 = (0,6 + 0,0) / 2'); }

console.log('6. remontagem unica: sem a marca a resolucao e refeita inteira; com a marca, nao; o diario nunca');
{ const r30 = { min: 30, dias: 180 }, r0 = { min: 0, dias: 9999 };
  ok(C.precisaMigrar(null, r30) === true, 'blob ausente: remonta');
  ok(C.precisaMigrar({ serie: [] }, r30) === true, 'blob sem marca (retangulo no ar): remonta');
  ok(C.precisaMigrar({ scada_integracao: C.SCADA_INTEGRACAO }, r30) === false, 'blob com a marca: rodada curta');
  ok(C.precisaMigrar({ serie: [] }, r0) === false, 'diario: nao remonta (total do dia do supervisorio)'); }

console.log('7. o corpo do gerador usa o trapezio nas quatro resolucoes e grava a marca');
{ const src = fs.readFileSync(path.join(__dirname, 'gen-comparativo.js'), 'utf8').replace(/\r\n/g, '\n');
  const corpo = src.slice(src.indexOf("if (require.main !== module) return;"));
  ok(/res\.min === 5 && scada5\) mScada = trapezio\(/.test(corpo), '5 min pelo trapezio');
  ok(/res\.min === 15 && scada\) mScada = trapezio\(/.test(corpo), '15 min pelo trapezio');
  ok(/res\.min > 15 && scada\) mScada = agregaCompleto\(trapezio\(/.test(corpo), '30 e 60 min pela soma COMPLETA de trapezios de 15');
  ok(/scada_integracao: diario \? 'total_do_dia' : SCADA_INTEGRACAO/.test(corpo), 'marca gravada no blob');
  ok(/const de = migra \? diaBRT\(res\.dias - 1\) : deDia/.test(corpo), 'sem marca, a janela e a da resolucao'); }

console.log('\n' + (falhas ? 'REPROVADO: ' + falhas + ' de ' + casos : 'APROVADO: ' + casos + ' de ' + casos));
process.exit(falhas ? 1 : 0);
