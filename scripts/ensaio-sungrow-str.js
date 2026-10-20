/*
 * ensaio-sungrow-str.js — prova as strings e a curva de 5 min do logger Sungrow (lib-sungrow-str.js, sg-logger-str), sem rede.
 *
 * 1 · diaStrings sobre CSV forjado no formato do logger: a escala da corrente da string (0,01 A); o pico pela potencia CA (o PRIMEIRO
 *     maximo, provado com a CA no teto); a razao mediana do dia contra as irmas SEM os instantes de potencia limitada (a limitacao
 *     cobre mais da metade dos instantes julgados e triplica a string 3: so a exclusao deixa 100 %), SEM os de mediana abaixo de 3 A
 *     e SEM a celula de limitacao vazia; a sentinela (65535) num instante livre (sai so da razao dela) e no pico (nula no pico); a
 *     entrada vazia a 0 %; a grade de 5 min da primeira a ultima amostra gerando; a curva em 0,1 kW e 0,1 °C e a limitacao 0/1; as
 *     linhas EMBARALHADAS e um carimbo FORA da grade com valores absurdos dao o mesmo dia; coluna faltando estoura com o nome; o
 *     isolamento de 5 min em kΩ com o zero e a sentinela nulos, e a nominal do dia em kW (strings-logger, 19/10/2026).
 * 2 · acumula (o que o gerador faz a cada CSV): no mesmo dia vindo de dois zips fica o de mais amostras (nas duas ordens), os
 *     campos do registro do dia, e o 5 min so com os ultimos 7 dias do numero de serie.
 * 3 · produtos com leitura e gravacao em memoria: o diario acumulado com o ms do dia em BRT; a MORTA no ultimo dia e a FRACA; a
 *     TROCA; a entrada vazia fora do 5 min e a morta dentro; o 5 min com 7 dias; o dia novo; a segunda chamada sem dado novo nao
 *     regrava; um zip PARCIAL reenviado numa rodada seguinte nao rebaixa o dia publicado (diario e 5 min); a troca descoberta
 *     DEPOIS (sem dado novo) regrava o diario e o 5 min sem as linhas do retirado; a mediana das REAIS (nao a das irmas) no alarme,
 *     num dia em que as duas diferem; o piso de classe na dispersao do dia; a janela do diario (diasStr); o historico de entradas
 *     reais acumulado; a placa do resumo pela lib-placa.
 * 4 · plantios na LIB (uma copia mudada, o ensaio inteiro de novo): cada um tem de reprovar COM a falha declarada.
 *
 * uso: node scripts/ensaio-sungrow-str.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { PLACA } = require('./lib-placa.js');

const LIB = path.join(__dirname, 'lib-sungrow-str.js');
const falhasTotal = [];

const HH = []; for (let m = 0; m < 1440; m += 5) HH.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
const perfil = (k) => { const h = k / 12; return h < 6 || h > 18 ? 0 : Math.round(300000 * Math.sin(Math.PI * (h - 6) / 12) ** 2); };   // W
const CAB = ['Horário', 'Potência ativa nominal', 'Modo de potência limitada', 'Temperatura de ar interna', 'Potência CC total', 'Potência ativa total',
  'Potência ativa total', ...Array.from({ length: 40 }, (_, k) => 'Corrente na string ' + (k + 1)), 'Impedância paralela em relação à terra'];
/* um dia: corrente de cada string = 12 A x (p / pmax) x `esc`, em 0,01 A; `f` {n: fator}; strings 23 e 24 vazias (0); 25 a 40 sentinela.
   `lim` [de, ate) com potencia limitada, em que a string 3 TRIPLICA (o rastreador fora do ponto); `limVazio` [k...] com a celula de
   limitacao VAZIA e a string 3 triplicada; `sent` [[k, n]...] a string n com 65535 no indice k; `teto` W de teto da CA; `ate` ultimo
   indice lido (zip parcial); `fora` uma linha FORA da grade (12:02:00) com CA e correntes absurdas; `embaralha` a ordem das linhas;
   isolamento 180 kΩ de dia e 20000 (topo da faixa) de noite, `isoZero` [k...] com zero e `isoSent` [k...] com 65535 */
function csv(d, o) {
  o = o || {};
  const L = [];
  HH.forEach((h, k) => {
    if (o.ate != null && k > o.ate) return;
    const p = o.teto ? Math.min(perfil(k), o.teto) : perfil(k), fr = perfil(k) / 300000;
    const lim = o.lim && k >= o.lim[0] && k < o.lim[1], vazio = (o.limVazio || []).includes(k);
    const s = [];
    for (let n = 1; n <= 40; n += 1) {
      if (n > 24) { s.push(65535); continue; }
      if (n >= 23) { s.push(0); continue; }
      let a = 1200 * fr * (o.esc == null ? 1 : o.esc) * ((o.f || {})[n] == null ? 1 : o.f[n]);
      if ((lim || vazio) && n === 3) a *= 3;
      if ((o.sent || []).some((q) => q[0] === k && q[1] === n)) { s.push(65535); continue; }
      s.push(Math.round(a));
    }
    const iso = (o.isoZero || []).includes(k) ? 0 : (o.isoSent || []).includes(k) ? 65535 : perfil(k) > 0 ? 180 : 20000;
    L.push([d + ' ' + h + ':00', 3200, vazio ? '' : lim ? 1 : 0, 450 + Math.round(fr * 100), Math.round(p * 1.015), p, 0, ...s, iso].join(', '));
  });
  if (o.fora) L.push([d + ' 12:02:00', 3200, 0, 999, 999999, 999999, 0, ...Array.from({ length: 40 }, () => 9999), 9].join(', '));
  if (o.embaralha) L.sort((a, b) => ((a.charCodeAt(15) * 7 + a.charCodeAt(12)) % 11) - ((b.charCodeAt(15) * 7 + b.charCodeAt(12)) % 11) || (a < b ? 1 : -1));
  return CAB.join(',') + '\n' + L.join('\n') + '\n';
}
const leCsv = (t) => { const L = t.split('\n'); return { cab: L[0].split(',').map((x) => x.trim()), linhas: L.slice(1).filter((l) => /^\d{4}/.test(l)).map((l) => l.split(',')) }; };
const diasDe = (de, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(de + 'T00:00:00Z') + i * 864e5).toISOString().slice(0, 10));
const memoria = () => { const store = new Map();
  return { store, leAnterior: async (n) => (store.has(n) ? JSON.parse(JSON.stringify(store.get(n))) : null),
    escreve: async (n, o) => { store.set(n, JSON.parse(JSON.stringify(o))); return 1; } }; };

async function ensaio(libPath, mudo) {
  const falhas = [];
  const ok = (c, m) => { if (!c) falhas.push(m); if (!mudo) console.log((c ? '  ok   ' : '  FALHA ') + m); };
  delete require.cache[require.resolve(libPath)];
  const SS = require(libPath);
  const dia1 = (d, o, nome) => { const t = leCsv(csv(d, o)); return SS.diaStrings(t.cab, t.linhas, nome || 'x.csv')[0]; };
  /* ---------- 1 · diaStrings ---------- */
  if (!mudo) console.log('1 · diaStrings');
  const OA = { f: { 5: 0.45 }, lim: [110, 180], sent: [[185, 7]], limVazio: [190], isoZero: [150], isoSent: [151] };
  const { cab, linhas } = leCsv(csv('2026-09-29', OA));
  const D = SS.diaStrings(cab, linhas, 'a.csv'), x = D[0] || { pk: { s: [] }, r: [], nr: [], g5: { s: [[]] }, cv: { p: [], lim: [] } };
  ok(D.length === 1 && x.d === '2026-09-29', 'um dia com geracao');
  ok(x.pk.h === '12:00' && x.pk.s[0] === 12 && x.pk.s[4] === 5.4 && x.pk.s[2] === 36 && x.pk.s[22] === 0, 'pico as 12:00, string 1 a 12 A (0,01 A), a fraca a 5,4 A, a string 3 limitada a 36 A (o pico nao exclui a limitacao, como no SCADA), a vazia a 0: ' + x.pk.h + ' ' + x.pk.s.slice(0, 5).join(' '));
  ok(x.md_pk === 12, 'mediana das irmas no pico 12 A: ' + x.md_pk);
  const julg = HH.map((h, k) => k).filter((k) => !(k >= 110 && k < 180) && k !== 190 && Math.round(1200 * perfil(k) / 300000) / 100 > 3);
  const julgLim = HH.map((h, k) => k).filter((k) => Math.round(1200 * perfil(k) / 300000) / 100 > 3 && ((k >= 110 && k < 180) || k === 190));
  ok(julgLim.length > julg.length, 'o forjado: a limitacao cobre mais da metade dos instantes acima do piso (' + julgLim.length + ' x ' + julg.length + ')');
  ok(x.r[0] === 100 && x.r[4] === 45 && x.r[2] === 100 && x.r[22] === 0, 'razao do dia: 100 %, a fraca 45 %, a string 3 (triplicada so na limitacao) 100 %, a vazia 0 %: ' + [x.r[0], x.r[4], x.r[2], x.r[22]].join(' '));
  ok(x.nr[0] === julg.length && x.nr[6] === julg.length - 1, 'instantes julgados: sem a limitacao, sem a celula vazia e sem os de mediana abaixo de 3 A (' + x.nr[0] + ', esperado ' + julg.length + '); a string 7 perde so o instante da sentinela (' + x.nr[6] + ')');
  // a grade vai da MEIA HORA da primeira a meia hora da ultima amostra gerando (strings-logger): k0 no :00/:30 anterior, k1 no :25/:55
  const ger = HH.map((h, k) => k).filter((k) => perfil(k) > 1000), k0 = Math.floor(ger[0] / 6) * 6, k1 = Math.floor(ger[ger.length - 1] / 6) * 6 + 5;
  ok(ger[0] % 6 !== 0 && x.g5.h0 === HH[k0] && x.cv.h0 === HH[k0] && x.cv.p.length === k1 - k0 + 1 && x.g5.s[0].length === k1 - k0 + 1 && x.cv.p[0] != null && x.cv.p[0] <= 10,
    'grade de 5 min da meia hora da primeira a meia hora da ultima amostra gerando (a primeira gerando as ' + HH[ger[0]] + '): ' + x.g5.h0 + ', ' + x.cv.p.length + ' instantes');
  ok(x.g5.s[0][144 - k0] === 120 && x.g5.s[6][185 - k0] === null && x.g5.s[22][144 - k0] === 0, 'corrente de 5 min em 0,1 A, a sentinela nula, a vazia zero');
  ok(x.cv.p[144 - k0] === 3000 && x.cv.pdc[144 - k0] === 3045 && x.cv.t[144 - k0] === 550 && x.cv.lim[140 - k0] === 1 && x.cv.lim[100 - k0] === 0 && x.cv.lim[190 - k0] === null,
    'curva: CA e CC em 0,1 kW, temperatura em 0,1 °C, limitacao 0/1 e a celula vazia nula');
  ok(x.cv.iso && x.cv.iso.length === x.cv.p.length && x.cv.iso[144 - k0] === 180 && x.cv.iso[150 - k0] === null && x.cv.iso[151 - k0] === null && x.cv.nom === 320,
    'curva: isolamento em kΩ na mesma grade, o zero e a sentinela nulos, a nominal do dia em kW (3200 x 0,1): ' + [x.cv.iso && x.cv.iso[144 - k0], x.cv.iso && x.cv.iso[150 - k0], x.cv.nom].join(' '));
  { const y = dia1('2026-09-29', { sent: [[144, 7]] }); ok(y.pk.h === '12:00' && y.pk.s[6] === null && y.pk.s[5] === 12, 'sentinela no pico: nula no pico'); }
  { const y = dia1('2026-09-29', Object.assign({ embaralha: true, fora: true }, OA));
    ok(JSON.stringify(y) === JSON.stringify(x), 'linhas embaralhadas e um carimbo fora da grade (12:02, absurdo) dao o mesmo dia'); }
  { const y = dia1('2026-09-30', { teto: 280000 }), kT = HH.findIndex((h, k) => perfil(k) >= 280000);
    ok(y.pk.h === HH[kT] && y.pk.s[0] === Math.round(1200 * perfil(kT) / 300000) / 100, 'pico com a CA no teto: o primeiro instante do teto (' + HH[kT] + '): ' + y.pk.h); }
  let estourou = false;
  try { const c2 = cab.map((c) => (c === 'Corrente na string 17' ? 'outra' : c)); SS.diaStrings(c2, linhas, 'b.csv'); } catch (e) { estourou = /b\.csv: coluna "Corrente na string 17" ausente/.test(e.message); }
  ok(estourou, 'coluna de string faltando estoura com o nome');
  /* ---------- 2 · acumula ---------- */
  if (!mudo) console.log('2 · acumula');
  { const inteiro = dia1('2026-09-29', { f: { 5: 0.45 } }), parcial = dia1('2026-09-29', { f: { 5: 0.45 }, ate: 150 });
    for (const [nome, ordem] of [['inteiro e depois parcial', [inteiro, parcial]], ['parcial e depois inteiro', [parcial, inteiro]]]) {
      const sr = {}, gr = {}; for (const y of ordem) SS.acumula(sr, gr, 'S1', [y], 7);
      const a = sr.S1['2026-09-29'];
      ok(a.nAm === inteiro.cv.p.length && a.h === inteiro.pk.h && a.md === inteiro.md_pk && JSON.stringify(a.pk) === JSON.stringify(inteiro.pk.s)
        && JSON.stringify(a.r) === JSON.stringify(inteiro.r) && a.nr === Math.max(...inteiro.nr) && gr.S1['2026-09-29'].cv === inteiro.cv,
        'mesmo dia de dois zips (' + nome + '): fica o de mais amostras, com pico, mediana, razao e curva dele: ' + a.nAm); }
    const sr = {}, gr = {}; for (const d of diasDe('2026-09-01', 10)) SS.acumula(sr, gr, 'S1', [dia1(d, {})], 7);
    ok(Object.keys(sr.S1).length === 10 && Object.keys(gr.S1).sort().join() === diasDe('2026-09-04', 7).join(), 'o 5 min guarda so os ultimos 7 dias do numero de serie; o diario guarda todos'); }
  /* ---------- 3 · produtos ---------- */
  if (!mudo) console.log('3 · produtos');
  const dias = diasDe('2026-08-21', 40);
  const ULT = dias[dias.length - 1], TROCA = dias[20];
  const ident = { A1: { pos: 'M8/TS1/INV01' }, A2: { pos: 'M8/TS1/INV02' }, B2: { pos: 'M8/TS1/INV02' }, C1: { pos: 'M8/TS2/INV01' } };
  const fazVale = (iniB2, fimA2, fimB2) => { const pos = (sn, d) => (sn === 'A2' ? (d < fimA2 ? 'M8/TS1/INV02' : null) : sn === 'B2' ? (d >= iniB2 && (!fimB2 || d <= fimB2) ? 'M8/TS1/INV02' : null)
    : sn === 'C1' ? 'M8/TS2/INV01' : 'M8/TS1/INV01'); return (l, u, ts) => pos(l.sn, l.d) === u + '/' + ts + '/' + l.inv; };
  const vale = fazVale(TROCA, TROCA);
  const strRodada = { B2: {} }, g5Rodada = { B2: {} };   // o B2 PRIMEIRO: sem o filtro da troca, a linha do A2 (depois) ganharia
  // INV01 (A1): S9 normal ate o penultimo dia e ZERO no ultimo (morta); S5 a 45 % todos os dias (fraca). INV02: A2 ate a troca, B2 depois;
  // o A2 (retirado) continua mandando linha depois da troca com S1 a 10 % (a linha dele nao pode valer)
  for (const d of dias) {
    SS.acumula(strRodada, g5Rodada, 'A1', [dia1(d, { f: { 5: 0.45, 9: d === ULT ? 0 : 1 } })], 7);
    SS.acumula(strRodada, g5Rodada, 'A2', [dia1(d, { f: { 1: d >= TROCA ? 0.1 : 1 } })], 7);
    if (d >= TROCA) SS.acumula(strRodada, g5Rodada, 'B2', [dia1(d, {})], 7);
  }
  const M = memoria(), { store } = M;
  const mEtcs = ['M8_TS1', 'M8_TS2'];
  const roda = async (sr, gr, vl, pesos, extra) => SS.produtos(Object.assign({ strRodada: sr, g5Rodada: gr, ident, mEtcs, vale: vl, leAnterior: M.leAnterior, escreve: M.escreve, pesos, agora: 'x', dias5: 7, diasStr: 180 }, extra || {}));
  const B = await roda(strRodada, g5Rodada, vale, {});
  const SD = (store.get('sg_str_dia_M8_TS1.json') || { serie: [] }).serie, AL = store.get('sg_str_alarme.json') || { serie: [], resumo: [] };
  ok(SD.length === 40 + 40 && SD.every((l) => vale(l, 'M8', 'TS1')), 'diario: 40 dias de INV01 e 40 de INV02 (A2 antes da troca, B2 depois), nenhuma linha fora da troca: ' + SD.length);
  ok(SD.every((l) => l.ms === Date.parse(l.d + 'T03:00:00Z')) && SD.length > 0, 'ms do dia em BRT (00:00 de Brasilia) em toda linha');
  ok(store.has('sg_str_dia_M8_TS2.json') && store.get('sg_str_dia_M8_TS2.json').serie.length === 0, 'eletrocentro sem dado tem arquivo vazio');
  const mo = AL.serie.find((a) => a.inv === 'INV01' && a.str === 9), fr = AL.serie.find((a) => a.inv === 'INV01' && a.str === 5);
  ok(mo && mo.classe === 'morta' && mo.dia === ULT && mo.desde === ULT && mo.a === 0 && mo.med_a === 12, 'S9 do INV01 sem corrente no ultimo dia: ' + JSON.stringify(mo || null));
  ok(fr && fr.classe === 'fraca' && fr.pct === 45 && fr.n_janela === 30, 'S5 do INV01 fraca, mediana de 30 dias a 45 %: ' + JSON.stringify(fr || null));
  ok(AL.serie.length === 2 && !AL.serie.some((a) => a.inv === 'INV02'), 'nenhum alarme no INV02 (a linha do retirado depois da troca nao vale): ' + AL.serie.length);
  ok(AL.serie[0] === mo, 'a sem corrente antes da fraca');
  const rM8 = AL.resumo.find((r) => r.ufv === 'M8') || {};
  ok(rM8.strings_com_corrente === 44 && rM8.placa === Math.round(PLACA.M8.modulos / 29) && rM8.sem_corrente_no_registro === rM8.placa - 44,
    'M8 com 44 strings reais (22 por inversor; a vazia nao conta) contra a placa da lib-placa: ' + rM8.strings_com_corrente + '/' + rM8.placa);
  const S5 = (store.get('sg_str_M8_TS1.json') || { serie: [] }).serie, C5 = (store.get('sg_curva_M8_TS1.json') || { serie: [] }).serie;
  const s5u = S5.find((l) => l.inv === 'INV01' && l.d === ULT) || { s: {} };
  ok(new Set(S5.map((l) => l.d)).size === 7 && S5.length === 14 && C5.length === 14, '5 min: so os ultimos 7 dias, um por inversor: ' + S5.length + ' / ' + C5.length);
  ok(s5u.s[9] && s5u.s[9].every((v) => v === 0) && !s5u.s[23] && !s5u.s[24] && Object.keys(s5u.s).length === 22, 'no 5 min a morta fica (zeros) e as vazias saem: ' + Object.keys(s5u.s).length + ' entradas');
  ok(S5.filter((l) => l.inv === 'INV02').every((l) => l.sn === 'B2'), 'no 5 min do INV02 so o inversor novo');
  ok(C5.length > 0 && C5.every((l) => Array.isArray(l.iso) && l.iso.length === l.p.length && l.nom === 320), 'a curva publicada leva o isolamento de 5 min e a nominal do dia (strings-logger)');
  const ds = B.disp.get('M8/TS1/INV01|' + ULT);
  ok(ds && ds.min_pct === 0 && ds.mortas === 1 && ds.n === 22 && ds.min_n === 9, 'dispersao do ultimo dia do INV01 para a saude: a mais fraca a 0 % (S9), 1 sem corrente: ' + JSON.stringify(ds || null));
  let pesos = {};
  await roda({}, {}, vale, pesos);
  ok(!pesos['sg_str_dia_M8_TS1.json'] && !pesos['sg_str_M8_TS1.json'] && !pesos['sg_curva_M8_TS1.json'], 'segunda chamada sem dado novo nao regrava os arquivos por eletrocentro');
  ok((store.get('sg_str_alarme.json') || { serie: [] }).serie.length === 2, 'e a lista de alarmes refeita do acumulado e a mesma');
  // um dia NOVO: o 5 min continua com 7 dias (o mais velho sai) e o diario ganha o dia
  const NOVO = diasDe(ULT, 2)[1];
  { const sr = {}, gr = {}; SS.acumula(sr, gr, 'A1', [dia1(NOVO, { f: { 5: 0.45, 9: 0 } })], 7); await roda(sr, gr, vale, {}); }
  const S6 = store.get('sg_str_M8_TS1.json').serie, dS6 = [...new Set(S6.map((l) => l.d))].sort();
  ok(dS6.length === 7 && dS6[6] === NOVO && dS6[0] === dias[dias.length - 6], 'dia novo: o 5 min fica com 7 dias, o mais velho sai: ' + dS6[0] + ' a ' + dS6[6]);
  ok(store.get('sg_str_dia_M8_TS1.json').serie.length === 81, 'e o diario acumula o dia novo: ' + store.get('sg_str_dia_M8_TS1.json').serie.length);
  // um zip PARCIAL do ULT reenviado numa rodada seguinte: o dia inteiro publicado fica (diario e 5 min)
  { const antes = store.get('sg_str_dia_M8_TS1.json').serie.find((l) => l.d === ULT && l.inv === 'INV01');
    const sr = {}, gr = {}; SS.acumula(sr, gr, 'A1', [dia1(ULT, { f: { 5: 0.45, 9: 1 }, ate: 140 })], 7); await roda(sr, gr, vale, {});
    const dep = store.get('sg_str_dia_M8_TS1.json').serie.find((l) => l.d === ULT && l.inv === 'INV01');
    const cv = store.get('sg_curva_M8_TS1.json').serie.find((l) => l.d === ULT && l.inv === 'INV01');
    ok(dep && antes && dep.na === antes.na && dep.pk[8] === 0 && cv.p.length === antes.na && (store.get('sg_str_alarme.json').serie.find((a) => a.str === 9) || {}).classe === 'morta',
      'zip parcial reenviado depois nao rebaixa o dia publicado (diario, curva e o alarme): ' + (dep && dep.na) + ' amostras'); }
  // a TROCA descoberta depois, sem dado novo: o A2 so ate dias[15] (16 a 19 sem dono) -> o diario e regravado sem as 5 linhas
  pesos = {};
  await roda({}, {}, fazVale(TROCA, dias[15]), pesos);
  ok(pesos['sg_str_dia_M8_TS1.json'] && store.get('sg_str_dia_M8_TS1.json').serie.filter((l) => l.inv === 'INV02').length === 35, 'troca descoberta depois: o diario e regravado sem as linhas do retirado: '
    + store.get('sg_str_dia_M8_TS1.json').serie.filter((l) => l.inv === 'INV02').length);
  // e o B2 deixa de valer depois de dias[36] (o eletrocentro sem dono no fim): o 5 min e regravado sem os 3 dias dele
  pesos = {};
  await roda({}, {}, fazVale(TROCA, dias[15], dias[36]), pesos);
  const S7 = store.get('sg_str_M8_TS1.json').serie.filter((l) => l.inv === 'INV02'), C7 = store.get('sg_curva_M8_TS1.json').serie.filter((l) => l.inv === 'INV02');
  ok(pesos['sg_str_M8_TS1.json'] && S7.length === 3 && C7.length === 3 && S7.every((l) => l.d <= dias[36]), 'e o 5 min tambem, sem dado novo: ' + S7.length + ' / ' + C7.length);
  /* a mediana das REAIS no alarme, num dia em que ela difere da mediana das irmas: C1 (M8/TS2/INV01) com S5 a 45 % sempre e, no ultimo
     dia, S9 a S19 zerados -> reais [0 x 11, 5,4, 12 x 10]: mediana 5,4 A; irmas (> 1 A): 12 A. Um dia ESCURO (12 A x 0,2 = 2,4 A,
     abaixo do piso de classe) com a S9 zerada: a dispersao do dia existe e nao conta a S9 como sem corrente. E uma entrada real que so
     o historico anterior conhece (a 24, vazia no diario) */
  { const M2 = memoria(); const sr = {}, gr = {}, dC = diasDe('2026-09-01', 36);
    for (const d of dC) SS.acumula(sr, gr, 'C1', [dia1(d, d === dC[35] ? { f: Object.assign({ 5: 0.45 }, ...[9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19].map((n) => ({ [n]: 0 }))) }
      : d === dC[10] ? { f: { 5: 0.45, 9: 0 }, esc: 0.2 } : { f: { 5: 0.45 } })], 7);
    const B2r = await SS.produtos({ strRodada: sr, g5Rodada: gr, ident, mEtcs, vale, leAnterior: M2.leAnterior, escreve: M2.escreve, pesos: {}, agora: 'x', dias5: 7, diasStr: 180 });
    const A2l = M2.store.get('sg_str_alarme.json'), m9 = A2l.serie.find((a) => a.str === 9) || {};
    ok(A2l.serie.filter((a) => a.classe === 'morta').length === 11 && m9.med_a === 5.4 && m9.a === 0, 'mediana das REAIS no alarme (5,4 A, nao a das irmas 12 A): ' + m9.med_a);
    const dEsc = B2r.disp.get('M8/TS2/INV01|' + dC[10]);
    ok(dEsc && dEsc.min_pct === 0 && dEsc.mortas === 0, 'dia escuro (mediana 2,4 A): dispersao com a S9 a 0 % mas sem sem corrente (piso de classe): ' + JSON.stringify(dEsc || null));
  }
  // uma entrada real que so o historico ANTERIOR conhece (a 24, vazia em todo o diario): continua real no resumo e no 5 min
  { const M4 = memoria(); const sr = {}, gr = {}; for (const d of diasDe('2026-09-01', 5)) SS.acumula(sr, gr, 'C1', [dia1(d, {})], 7);
    M4.store.set('sg_str_entradas.json', { entradas: [{ ufv: 'M8', ts: 'TS2', inv: 'INV01', g: 's', n: 24, ok: ['2026-03-01', '2026-03-02', '2026-03-03'], ultimo_ok: '2026-03-03' }] });
    await SS.produtos({ strRodada: sr, g5Rodada: gr, ident, mEtcs, vale, leAnterior: M4.leAnterior, escreve: M4.escreve, pesos: {}, agora: 'x', dias5: 7, diasStr: 180 });
    const rC = M4.store.get('sg_str_alarme.json').resumo.find((r) => r.ufv === 'M8'), s5C = M4.store.get('sg_str_M8_TS2.json').serie[0] || { s: {}, reais: [] };
    ok(rC.strings_com_corrente === 23 && s5C.s[24] && s5C.reais.includes(24), 'a entrada real que so o historico anterior conhece continua real (23 no resumo, no 5 min): ' + rC.strings_com_corrente); }
  // a janela do diario: diasStr = 10 sobre os 40 dias -> os ultimos 10 por inversor
  { const M3 = memoria(); const sr = {}, gr = {}; for (const d of dias) SS.acumula(sr, gr, 'A1', [dia1(d, {})], 7);
    await SS.produtos({ strRodada: sr, g5Rodada: gr, ident, mEtcs, vale, leAnterior: M3.leAnterior, escreve: M3.escreve, pesos: {}, agora: 'x', dias5: 7, diasStr: 10 });
    const L = M3.store.get('sg_str_dia_M8_TS1.json');
    ok(L.serie.length === 10 && L.serie[0].d === dias[30] && L.janela_dias === 10, 'janela do diario: os ultimos 10 dias (' + L.serie.length + ', a partir de ' + (L.serie[0] || {}).d + ')'); }
  return falhas;
}

(async () => {
  const f = await ensaio(LIB, false);
  falhasTotal.push(...f);
  console.log('4 · plantios na lib (cada um roda o ensaio inteiro e tem de reprovar com a falha declarada)');
  const src = fs.readFileSync(LIB, 'utf8');
  const tmp = path.join(__dirname, '_plantio_lib_sungrow_str.js');
  const planta = async (nome, de, para, espera) => {
    if (src.split(de).length !== 2) { falhasTotal.push('plantio ' + nome + ': trecho nao casou'); console.log('  FALHA plantio ' + nome + ': trecho nao casou'); return; }
    fs.writeFileSync(tmp, src.split(de).join(para));
    let r; try { r = await ensaio(tmp, true); } catch (e) { r = ['estourou: ' + e.message]; }
    const certo = r.some((m) => espera.test(m));
    if (!certo) falhasTotal.push('plantio "' + nome + '" nao reprovou pela falha declarada (' + r.length + ': ' + r.slice(0, 2).join(' | ').slice(0, 200) + ')');
    console.log((certo ? '  ok   ' : '  FALHA ') + 'plantio "' + nome + '" reprova em: ' + (r.find((m) => espera.test(m)) || r[0] || 'nada').slice(0, 90));
  };
  try {
    await planta('escala da string em 0,1 A', 'return x == null ? null : x / 100; });', 'return x == null ? null : x / 10; });', /^pico as 12:00/);
    await planta('pico pelo ultimo maximo', 'for (const i of ger) if (P[i] > P[ip]) ip = i;', 'for (const i of ger) if (P[i] >= P[ip]) ip = i;', /^pico com a CA no teto/);
    await planta('razao com a limitacao', 'const livre = num(v[c.lim]) === 0;', 'const livre = true;', /^razao do dia/);
    await planta('celula de limitacao vazia como livre', 'const livre = num(v[c.lim]) === 0;', 'const livre = !num(v[c.lim]);', /^instantes julgados/);
    await planta('razao sem o piso de 3 A', 'if (livre && md != null && md > PISO_A)', 'if (livre && md != null && md > 0)', /^instantes julgados/);
    await planta('sem o filtro da grade', "if (Number(t.slice(14, 16)) % 5 || (t.length > 16 && t.slice(17, 19) !== '00')) return false;", '', /^linhas embaralhadas/);
    await planta('sem ordenar', "      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));\n", ';\n', /^linhas embaralhadas|Invalid array length/);
    await planta('acumula: fica o de menos amostras', 'if (sr[x.d] && sr[x.d].nAm >= nAm) continue;', 'if (sr[x.d] && sr[x.d].nAm <= nAm) continue;', /^mesmo dia de dois zips/);
    await planta('acumula: pico no lugar da razao', 'pk: x.pk.s, r: x.r, nr:', 'pk: x.r, r: x.r, nr:', /^mesmo dia de dois zips/);
    await planta('acumula: 5 min cortado em 1 dia', 'ds.slice(0, Math.max(0, ds.length - dias5))', 'ds.slice(0, Math.max(0, ds.length - 1))', /^o 5 min guarda so os ultimos 7/);
    await planta('troca ignorada no diario', "const novo = (novoD[k] || []).filter((l) => vale(l, u, tsx));", "const novo = (novoD[k] || []);", /^diario: 40 dias/);
    await planta('5 min sem o corte de dias', '.sort().slice(-DIAS_5MIN);', '.sort();', /^dia novo: o 5 min/);
    await planta('vazia no 5 min', 'if (R.has(i + 1) || a.some((x) => x != null && x > 0)) s[i + 1] = a;', 's[i + 1] = a;', /^no 5 min a morta fica/);
    await planta('alarme pela mediana das irmas', 'const mds = ls.map((l) => STRL.mediana([...R.reais].map((n) => l.pk[n - 1]).filter((x) => x != null)));', 'const mds = ls.map((l) => l.md);', /^mediana das REAIS/);
    await planta('regrava sem dado novo', 'if (!trocou && ant && !tirados) continue;', 'if (false) continue;', /^segunda chamada sem dado novo/);
    await planta('parcial reenviado vence no diario', 'if (a && a.sn === l.sn && a.na != null && a.na > l.na) continue;', '', /^zip parcial reenviado/);
    await planta('parcial reenviado vence no 5 min', 'if (aC && aC.sn === l.sn && lidas(aC) > lidas(l.cv)) continue;', '', /^zip parcial reenviado/);
    await planta('troca tardia sem regravar o diario', 'if (!trocou && ant && !tirados) continue;', 'if (!trocou && ant) continue;', /^troca descoberta depois/);
    await planta('troca tardia sem regravar o 5 min', 'if (!novo.length && antS && antC && !tiradosG) continue;', 'if (!novo.length && antS && antC) continue;', /^e o 5 min tambem/);
    await planta('ms em UTC', "ms: Date.parse(d + 'T03:00:00Z')", "ms: Date.parse(d + 'T00:00:00Z')", /^ms do dia em BRT/);
    await planta('dispersao sem o piso de classe', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, PISO_A)', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, 0)', /^dia escuro/);
    await planta('entradas sem o historico anterior', "STRL.fundeEntradas((entAnt && entAnt.entradas) || [], obs, PISO_A)", 'STRL.fundeEntradas([], obs, PISO_A)', /^a entrada real que so o historico/);
    await planta('placa sem dividir pela string', 'Math.round(PLACA[u].modulos / MOD_POR_STRING)', 'PLACA[u].modulos', /^M8 com 44 strings reais/);
    await planta('grade so da geracao (sem a meia hora da ponta)', 'const m0 = Math.floor(g0 / 30) * 30, m1 = Math.min(1435, Math.floor(g1 / 30) * 30 + 25),', 'const m0 = g0, m1 = g1,', /^grade de 5 min/);
    await planta('isolamento zero como leitura', 'cv.iso[j] = iso != null && iso > 0 ? iso : null;', 'cv.iso[j] = iso;', /^curva: isolamento/);
    await planta('nominal em 0,1 kW', 'cv.nom = ns.length ? r1(Math.max(...ns) / 10) : null;', 'cv.nom = ns.length ? Math.max(...ns) : null;', /^curva: isolamento/);
    await planta('curva publicada sem o isolamento', 'lim: l.cv.lim, iso: l.cv.iso, nom: l.cv.nom });', 'lim: l.cv.lim });', /^a curva publicada leva o isolamento/);
    await planta('diario sem a janela', 'sDia[k] = ks.filter((c) => c.slice(0, 10) >= corte).map((c) => tudo.get(c));', 'sDia[k] = ks.map((c) => tudo.get(c));', /^janela do diario/);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  console.log(falhasTotal.length ? '\nREPROVADO: ' + falhasTotal.length + '\n  ' + falhasTotal.join('\n  ') : '\nAPROVADO');
  process.exit(falhasTotal.length ? 1 : 0);
})().catch((e) => { console.error('ERRO ' + e.stack); process.exit(1); });
