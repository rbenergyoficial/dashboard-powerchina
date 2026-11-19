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
 * 4 · plantios na LIB (uma copia mudada, o ensaio inteiro de novo): cada um tem de reprovar COM a falha declarada; desde
 *     sg-str-somada (18/11/2026) tambem na lib-strings (a copia mudada dela, lida por uma copia da lib-sungrow-str).
 * 6 · sg-str-somada (18/11/2026): o par do MPPT com a leitura somada (uma string a zero e a par com a soma das duas) e `somada`, nao
 *     `morta`; a S9 zerada com a par a 100 % continua `morta` (o M1/TS2/INV06); a par a 150 % (abaixo de 1,6x) tambem; a zerada que
 *     nunca foi real entra so como somada e conta no resumo; a dispersao do dia tira o par somado da mais forte e das sem corrente.
 *     A mediana e a das IRMAS: o dia da secao 3 com 11 strings mortas (mediana das reais 5,4 A) nao vira somada (a S20 a 12 A e sadia).
 *
 * uso: node scripts/ensaio-sungrow-str.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
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
  for (const k of Object.keys(require.cache)) if (/_plantio_/.test(k)) delete require.cache[k];   // a copia plantada da lib-strings
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
    ok(!A2l.serie.some((a) => a.classe === 'somada'), 'e nenhuma somada nesse dia: a S20 a 12 A e 2,2x a mediana das reais (5,4 A), mas 1,0x a das irmas (sg-str-somada): '
      + A2l.serie.filter((a) => a.classe === 'somada').map((a) => 'S' + a.str).join(','));
    const dUlt = B2r.disp.get('M8/TS2/INV01|' + dC[35]) || {};
    ok(dUlt.mortas === 11 && dUlt.somadas === 0, 'e a dispersao desse dia conta as 11 sem corrente, nenhum par somado (a mediana das irmas): ' + JSON.stringify(dUlt));
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
  /* ---------- 5 · sg-str-historico (18/11/2026): a entrada sem corrente dentro da faixa e o arquivo mensal, sem janela ---------- */
  if (!mudo) console.log('5 · a entrada sem corrente dentro da faixa e o arquivo mensal');
  { const g = Array.from({ length: 24 }, (_, i) => (i === 8 || i >= 22 ? [0, 0, null] : [10, 20, 30]));   // a S9 zerada (M1/TS2/INV06), 23 e 24 sem uso
    const { s, vz } = SS.entradasPublicadas(g, new Set(Array.from({ length: 22 }, (_, i) => i + 1).filter((n) => n !== 9)));
    ok(JSON.stringify(vz) === '[9]' && s[9] && !s[23] && !s[24] && Object.keys(s).length === 22,
      'a entrada sem corrente dentro da faixa das reais vai no 5 min, em vz; 23 e 24 sem uso ficam fora: vz ' + JSON.stringify(vz) + ', ' + Object.keys(s).length + ' entradas'); }
  { const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-sgarq-'));
    try {
      const G = SS.abreGuarda(path.join(raiz, 'a')), dA = ['2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02'];
      for (const d of dA) { SS.guarda(G, 'A1', [dia1(d, { f: { 5: 0.45, 9: 0 } })]); SS.guarda(G, 'A2', [dia1(d, {})]); if (d >= '2026-09-01') SS.guarda(G, 'B2', [dia1(d, { f: { 1: 0.5 } })]); }
      SS.guarda(G, 'A1', [dia1('2026-08-31', { f: { 5: 0.45, 9: 0 }, ate: 150 })]);   // o zip parcial do mesmo dia chega depois do inteiro
      const reaisA = (u, ts, inv) => new Set(Array.from({ length: 22 }, (_, i) => i + 1).filter((n) => !(inv === 'INV01' && n === 9)));
      const vA = fazVale('2026-09-01', '2026-09-01'), MA = memoria(), arq = (GG, pesos) => SS.arquivo({ G: GG, ident, vale: vA, reaisDe: reaisA,
        leAnterior: MA.leAnterior, escreve: MA.escreve, pesos, agora: 'x', conc: 3 });
      const p1 = {}; await arq(G, p1);
      const ago = MA.store.get('hist/sg_str_M8_TS1_INV01_2026_08.json') || { serie: [] }, set = MA.store.get('hist/sg_str_M8_TS1_INV01_2026_09.json') || { serie: [] };
      const i2 = MA.store.get('hist/sg_str_M8_TS1_INV02_2026_09.json') || { serie: [] }, ix = MA.store.get('hist/sg_str_meses.json') || { meses: [] };
      const inteiro = dia1('2026-08-31', {}).cv.p.filter((v) => v != null).length;
      ok(ago.serie.map((l) => l.d).join() === '2026-08-29,2026-08-30,2026-08-31' && set.serie.map((l) => l.d).join() === '2026-09-01,2026-09-02',
        'um arquivo por inversor e mes, com todo dia lido (sem a janela de 7 dias): ' + ago.serie.length + ' + ' + set.serie.length);
      ok(ago.serie[2] && ago.serie[2].na === inteiro && ago.serie[2].s[1].filter((v) => v != null).length === dia1('2026-08-31', {}).g5.s[0].filter((v) => v != null).length && dia1('2026-08-31', { ate: 150 }).g5.s[0].filter((v) => v != null).length < ago.serie[2].s[1].filter((v) => v != null).length, 'zip parcial depois do inteiro nao rebaixa o dia guardado: ' + (ago.serie[2] || {}).na);
      const l0 = ago.serie[0] || { s: {}, vz: [] }, mx = (a) => Math.max(...(a || [0]).filter((v) => v != null));
      ok(JSON.stringify(l0.vz) === '[9]' && mx(l0.s[9]) === 0 && mx(l0.s[1]) === 120 && mx(l0.s[5]) === 54 && !l0.s[23] && l0.sn === 'A1' && l0.inv === 'INV01',
        'a linha do mes: a S9 sem corrente em vz, a corrente em 0,1 A (12 A e a fraca 5,4 A), 23 e 24 fora');
      ok(i2.serie.length === 2 && i2.serie.every((l) => l.sn === 'B2') && !(MA.store.get('hist/sg_str_M8_TS1_INV02_2026_08.json') || { serie: [] }).serie.some((l) => l.sn !== 'A2'),
        'na troca, o dia da posicao e do numero de serie que a ocupa (B2 em setembro, A2 em agosto)');
      ok(JSON.stringify(ix.meses) === '["2026-08","2026-09"]' && ix.de === '2026-08-29' && ix.ate === '2026-09-02', 'o indice dos meses com o primeiro e o ultimo dia: ' + JSON.stringify(ix));
      const p2 = {}; await arq(G, p2);
      ok(!Object.keys(p2).length, 'segunda chamada com o mesmo disco nao regrava nada: ' + Object.keys(p2).join(', '));
      const G2 = SS.abreGuarda(path.join(raiz, 'b')); SS.guarda(G2, 'A1', [dia1('2026-09-03', {})]); SS.guarda(G2, 'A1', [dia1('2026-08-31', { ate: 150 })]);
      const p3 = {}; await arq(G2, p3);
      const set3 = MA.store.get('hist/sg_str_M8_TS1_INV01_2026_09.json') || { serie: [] }, ago3 = MA.store.get('hist/sg_str_M8_TS1_INV01_2026_08.json') || { serie: [] };
      ok(set3.serie.map((l) => l.d).join() === '2026-09-01,2026-09-02,2026-09-03' && ago3.serie[2] && ago3.serie[2].na === inteiro && !p3['hist/sg_str_M8_TS1_INV01_2026_08.json']
        && (MA.store.get('hist/sg_str_meses.json') || {}).ate === '2026-09-03',
        'a rodada seguinte funde o dia novo no mes publicado; o zip parcial reenviado nao rebaixa o mes anterior, que nao e regravado');
    } finally { fs.rmSync(raiz, { recursive: true, force: true }); } }
  /* ---------- 6 · sg-str-somada (18/11/2026): o par do MPPT com a leitura somada ---------- */
  if (!mudo) console.log('6 · o par do MPPT com a leitura somada');
  { const M6 = memoria(), dS = diasDe('2026-10-01', 36), sr = {}, gr = {};
    const id6 = { D1: { pos: 'M8/TS2/INV03' }, D2: { pos: 'M8/TS2/INV04' } };
    /* D1: 30 dias normais (as 22 viram reais) e depois, nos 6 ultimos, o MPPT 1 com a soma na S1 (2,0x) e a S2 a zero, o MPPT 2 com a soma
       na S4 (1,85x) e a S3 a zero, a S11 a 1,5x com a S12 a zero (abaixo de 1,6x: e morta); e nos 3 ultimos a S9 a zero com a S10 a 100 %
       (a S9 do M1/TS2/INV06). D2: a S5 com a soma e a S6 a zero desde o primeiro dia (a S6 nunca foi real) */
    for (const [i, d] of dS.entries()) {
      SS.acumula(sr, gr, 'D1', [dia1(d, i < 30 ? {} : { f: Object.assign({ 1: 2, 2: 0, 3: 0, 4: 1.85, 11: 1.5, 12: 0 }, i >= 33 ? { 9: 0 } : {}) })], 7);
      SS.acumula(sr, gr, 'D2', [dia1(d, { f: { 5: 2, 6: 0 } })], 7);
    }
    const B6 = await SS.produtos({ strRodada: sr, g5Rodada: gr, ident: id6, mEtcs: ['M8_TS2'], vale: () => true, leAnterior: M6.leAnterior, escreve: M6.escreve, pesos: {}, agora: 'x', dias5: 7, diasStr: 180 });
    const A6 = M6.store.get('sg_str_alarme.json') || { serie: [], resumo: [], regra: {} }, S6 = A6.serie;
    const de = (inv, n) => S6.find((a) => a.inv === inv && a.str === n) || {};
    const s2 = de('INV03', 2), s3 = de('INV03', 3), s9 = de('INV03', 9), s12 = de('INV03', 12), s6 = de('INV04', 6);
    ok(s2.classe === 'somada' && s2.str_alta === 1 && s2.mppt === 1 && s2.a === 0 && s2.a_alta === 24 && s2.irmas_a === 12 && s2.pct_alta === 200 && s2.desde === dS[30] && s2.dias_fora === 6 && !s2.fora_da_apuracao,
      'par somado: a S2 a zero com a soma na S1 (2,0x) e somada, nao sem corrente: ' + JSON.stringify(s2));
    ok(s3.classe === 'somada' && s3.str_alta === 4 && s3.mppt === 2 && s3.a_alta === 22.2 && s3.pct_alta === 185, 'par somado com a soma na string PAR (S4 a 1,85x, a S3 a zero): ' + JSON.stringify(s3));
    ok(s9.classe === 'morta' && s9.desde === dS[33] && s9.str_alta == null, 'a S9 a zero com a S10 a 100 % continua sem corrente (o M1/TS2/INV06): ' + JSON.stringify(s9));
    ok(s12.classe === 'morta' && s12.str_alta == null, 'a S12 a zero com a S11 a 1,5x (abaixo de 1,6x) e sem corrente: ' + JSON.stringify(s12));
    ok(!S6.some((a) => a.inv === 'INV03' && [1, 4, 11].includes(a.str)) && S6.filter((a) => a.inv === 'INV03').length === 4, 'a entrada com a soma nao vira alarme proprio: ' + S6.filter((a) => a.inv === 'INV03').map((a) => 'S' + a.str + ' ' + a.classe).join(', '));
    ok(s6.classe === 'somada' && s6.fora_da_apuracao === 1 && s6.desde_o_inicio === 1 && s6.str_alta === 5 && !S6.some((a) => a.inv === 'INV04' && a.str !== 6),
      'a zerada que nunca foi real (a soma desde o primeiro dia) entra so como somada, fora da apuracao: ' + JSON.stringify(s6));
    const r8 = A6.resumo.find((r) => r.ufv === 'M8') || {};
    ok(r8.strings_com_corrente === 44 && r8.mppt_somada === 3, 'no resumo a zerada fora da apuracao conta como com corrente (22 + 21 + 1) e os 3 MPPT somados: ' + r8.strings_com_corrente + ', ' + r8.mppt_somada);
    ok(S6.map((a) => a.classe).join() === 'morta,morta,somada,somada,somada', 'a ordem da lista: sem corrente, somada, fraca: ' + S6.map((a) => a.classe).join());
    ok(/soma das duas/.test(A6.regra.somada || '') && /1,6/.test(A6.regra.somada || '') && /fora a leitura somada/.test(A6.regra.morta || ''), 'a regra publicada diz a classe somada e o limiar');
    const d6 = B6.disp.get('M8/TS2/INV03|' + dS[35]) || {};
    ok(d6.mortas === 2 && d6.somadas === 2 && d6.max_pct === 150 && d6.min_pct === 0 && d6.min_n === 9 && d6.n === 22,
      'dispersao do dia: o par somado fora da mais forte (150 %, nao 200 %) e das sem corrente (2: S9 e S12), 2 pares somados: ' + JSON.stringify(d6));
  }
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
    await planta('vazia no 5 min', 'if ((R && R.has(n)) || com) s[n] = a; else if (n < max) { s[n] = a; vz.push(n); }', 's[n] = a;', /^no 5 min a morta fica/);
    // sg-str-historico (18/11/2026)
    await planta('a regra antiga (some a entrada sem corrente)', 'else if (n < max) { s[n] = a; vz.push(n); }', '', /^a entrada sem corrente dentro da faixa/);
    await planta('guarda rebaixa com o parcial', 'if (a != null && a >= nAm) continue;', '', /^zip parcial depois do inteiro/);
    await planta('arquivo rebaixa com o parcial publicado', 'if (r == null && a && a.sn === e.sn && a.na != null && a.na > e.na) continue;', '', /^a rodada seguinte funde/);
    await planta('arquivo sem a troca', 'if (!vale({ d, sn, inv }, u, ts)) continue;', '', /^na troca/);
    await planta('arquivo regrava sem mudar', 'if (!mudou) return;', '', /^segunda chamada com o mesmo disco/);
    await planta('arquivo com a janela de 7 dias', 'const serie = [...tudo.keys()].sort().map((d) => tudo.get(d));', 'const serie = [...tudo.keys()].sort().slice(-1).map((d) => tudo.get(d));', /^um arquivo por inversor e mes/);
    await planta('alarme pela mediana das irmas', 'const mds = ls.map((l) => STRL.mediana([...R.reais].map((n) => l.pk[n - 1]).filter((x) => x != null)));', 'const mds = ls.map((l) => l.md);', /^mediana das REAIS/);
    await planta('regrava sem dado novo', 'if (!trocou && ant && !tirados) continue;', 'if (false) continue;', /^segunda chamada sem dado novo/);
    await planta('parcial reenviado vence no diario', 'if (a && a.sn === l.sn && a.na != null && a.na > l.na) continue;', '', /^zip parcial reenviado/);
    await planta('parcial reenviado vence no 5 min', 'if (aC && aC.sn === l.sn && lidas(aC) > lidas(l.cv)) continue;', '', /^zip parcial reenviado/);
    await planta('troca tardia sem regravar o diario', 'if (!trocou && ant && !tirados) continue;', 'if (!trocou && ant) continue;', /^troca descoberta depois/);
    await planta('troca tardia sem regravar o 5 min', 'if (!novo.length && antS && antC && !tiradosG) {', 'if (!novo.length && antS && antC) {', /^e o 5 min tambem/);
    await planta('ms em UTC', "ms: Date.parse(d + 'T03:00:00Z')", "ms: Date.parse(d + 'T00:00:00Z')", /^ms do dia em BRT/);
    await planta('dispersao sem o piso de classe', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, PISO_A, true)', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, 0, true)', /^dia escuro/);
    await planta('entradas sem o historico anterior', "STRL.fundeEntradas((entAnt && entAnt.entradas) || [], obs, PISO_A)", 'STRL.fundeEntradas([], obs, PISO_A)', /^a entrada real que so o historico/);
    await planta('placa sem dividir pela string', 'Math.round(PLACA[u].modulos / MOD_POR_STRING)', 'PLACA[u].modulos', /^M8 com 44 strings reais/);
    await planta('grade so da geracao (sem a meia hora da ponta)', 'const m0 = Math.floor(g0 / 30) * 30, m1 = Math.min(1435, Math.floor(g1 / 30) * 30 + 25),', 'const m0 = g0, m1 = g1,', /^grade de 5 min/);
    await planta('isolamento zero como leitura', 'cv.iso[j] = iso != null && iso > 0 ? iso : null;', 'cv.iso[j] = iso;', /^curva: isolamento/);
    await planta('nominal em 0,1 kW', 'cv.nom = ns.length ? r1(Math.max(...ns) / 10) : null;', 'cv.nom = ns.length ? Math.max(...ns) : null;', /^curva: isolamento/);
    await planta('curva publicada sem o isolamento', 'lim: l.cv.lim, iso: l.cv.iso, nom: l.cv.nom });', 'lim: l.cv.lim });', /^a curva publicada leva o isolamento/);
    await planta('diario sem a janela', 'sDia[k] = ks.filter((c) => c.slice(0, 10) >= corte).map((c) => tudo.get(c));', 'sDia[k] = ks.map((c) => tudo.get(c));', /^janela do diario/);
    // sg-str-somada (18/11/2026)
    await planta('alarme sem a corrente da par', ', xp: l.pk[p - 1], mi: l.md }))', ', mi: l.md }))', /^par somado: a S2/);
    await planta('somada pela mediana das reais', ', xp: l.pk[p - 1], mi: l.md }))', ', xp: l.pk[p - 1], mi: mds[i] }))', /^e nenhuma somada nesse dia/);
    await planta('a zerada nunca real fora da lista', "if (!al || (!real && al.classe !== 'somada')) continue;", 'if (!al || !real) continue;', /^a zerada que nunca foi real/);
    await planta('resumo sem a zerada fora da apuracao', 'n += som.filter((a) => a.fora_da_apuracao).length;', '', /^no resumo a zerada/);
    await planta('dispersao sem os pares do MPPT', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, PISO_A, true)', 'STRL.dispersao(c, reaisDe(u, ts, l.inv), 0.2, PISO_A)', /^dispersao do dia: o par somado/);
    await planta('somada antes da sem corrente', 'const ORD = { morta: 0, somada: 1, fraca: 2 };', 'const ORD = { morta: 0, somada: -1, fraca: 2 };', /^a ordem da lista/);
    await planta('regra sem a somada', "      somada: 'par do MPPT", "      somadaX: 'par do MPPT", /^a regra publicada/);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
  /* os plantios na LIB-STRINGS: a copia mudada dela, e uma copia da lib-sungrow-str que a le */
  const srcS = fs.readFileSync(path.join(__dirname, 'lib-strings.js'), 'utf8');
  const tmpS = path.join(__dirname, '_plantio_lib_strings.js'), tmpL = path.join(__dirname, '_plantio_lib_sungrow_str_s.js');
  const plantaStr = async (nome, de, para, espera) => {
    if (srcS.split(de).length !== 2) { falhasTotal.push('plantio ' + nome + ': trecho nao casou'); console.log('  FALHA plantio ' + nome + ': trecho nao casou'); return; }
    fs.writeFileSync(tmpS, srcS.split(de).join(para));
    fs.writeFileSync(tmpL, src.split("require('./lib-strings.js')").join("require('./_plantio_lib_strings.js')"));
    let r; try { r = await ensaio(tmpL, true); } catch (e) { r = ['estourou: ' + e.message]; }
    const certo = r.some((m) => espera.test(m));
    if (!certo) falhasTotal.push('plantio "' + nome + '" (lib-strings) nao reprovou pela falha declarada (' + r.length + ': ' + r.slice(0, 2).join(' | ').slice(0, 200) + ')');
    console.log((certo ? '  ok   ' : '  FALHA ') + 'plantio "' + nome + '" (lib-strings) reprova em: ' + (r.find((m) => espera.test(m)) || r[0] || 'nada').slice(0, 90));
  };
  try {
    if (src.split("require('./lib-strings.js')").length !== 2) falhasTotal.push('a lib-sungrow-str nao le a lib-strings por um require so');
    // controle: a copia sem mudanca passa (sem isso um plantio reprovaria so por ler a copia)
    { fs.writeFileSync(tmpS, srcS); fs.writeFileSync(tmpL, src.split("require('./lib-strings.js')").join("require('./_plantio_lib_strings.js')"));
      const r = await ensaio(tmpL, true); if (r.length) falhasTotal.push('a copia da lib-strings sem mudanca reprovou: ' + r[0]);
      console.log((r.length ? '  FALHA ' : '  ok   ') + 'a copia da lib-strings sem mudanca passa (controle dos plantios dela)'); }
    await plantaStr('par somado classificado como sem corrente', 'if (somadaEm(u.x, u.xp, u.mi)) {', 'if (false) {', /^par somado: a S2/);
    await plantaStr('limiar da somada em 1,2x', 'const SOMADA = 1.6;', 'const SOMADA = 1.2;', /^a S12 a zero com a S11 a 1,5x/);
    await plantaStr('par do MPPT errado', 'const parDe = (n) => (n % 2 ? n + 1 : n - 1);', 'const parDe = (n) => n + 1;', /^par somado/);
    await plantaStr('a zerada com a par a 100 % como somada', 'x <= MORTA_A && xp >= SOMADA * mi;', 'x <= MORTA_A && xp >= 0.9 * mi;', /^a S9 a zero com a S10 a 100 %/);
    await plantaStr('dispersao com o par somado', "if (classe && pares) for (const [n] of v) { const p = parDe(Number(n)); if (somadaEm(c[n], c[p], mi) || somadaEm(c[p], c[n], mi)) fora.add(Number(n)); }", '', /^dispersao do dia: o par somado/);
    await plantaStr('dispersao pela mediana das reais', 'const fora = new Set(), mi = razoes(c).md;', 'const fora = new Set(), mi = md;', /^e a dispersao desse dia conta as 11/);
    await plantaStr('desde da somada sem o trecho', 'while (j > 0 && somadaEm(v[j - 1].x, v[j - 1].xp, v[j - 1].mi)) j -= 1;', '', /^par somado: a S2/);
  } finally { for (const f of [tmpS, tmpL]) if (fs.existsSync(f)) fs.unlinkSync(f); }
  console.log(falhasTotal.length ? '\nREPROVADO: ' + falhasTotal.length + '\n  ' + falhasTotal.join('\n  ') : '\nAPROVADO');
  process.exit(falhasTotal.length ? 1 : 0);
})().catch((e) => { console.error('ERRO ' + e.stack); process.exit(1); });
