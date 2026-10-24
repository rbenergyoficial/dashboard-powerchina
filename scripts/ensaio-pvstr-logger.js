'use strict';
/*
 * ensaio-pvstr-logger.js — prova a curva de 30 min por inversor e a razao de cada string pelo logger Sungrow (lib-pvstr-logger.js,
 * gen-pvstr-logger.js; strings-logger, 19/10/2026).
 *
 * --lib (sem rede, ANTES de gerar):
 *   1 · meiasHoras sobre um inversor-dia forjado, com a conta refeita AQUI (media das seis leituras, fora do codigo testado): a meia
 *       hora e a MEDIA (nao a amostra de T) e o rotulo e o INICIO; uma leitura faltando anula a meia hora lida (fica no eixo, nula) e
 *       uma temperatura faltando anula so a temperatura; isolamento zero e topo misturado nulos, seis no topo dao o topo; limitacao em
 *       % da meia hora; a parada do meio do dia fica e as pontas sem geracao saem; strings: a fraca a 50 % pela lib-strings, o MPPT
 *       pela soma do par (a 75 %), o MPPT sem string real fora, o piso de 3 A; `sn` com mais de 0,5 A; a razao de cada string no
 *       pvstr_str; grades diferentes entre curva e strings estouram.
 *   2 · monta: os ultimos 7 dias, a ordem, a curva sem strings contada; contrato (sp publicado, tamanhos, grade); nomeScada; leCopia.
 *   3 · o gen-perdas pelo nome fisico da copia (o `fisico` compilado da fonte dele com a lib), e o fallback da primeira rodada.
 *   4 · o gen-pvstr-logger de ponta a ponta num processo a parte, com um mundo forjado nas nove usinas: semeia a copia do supervisorio
 *       com o blob antigo sem a marca, grava os produtos com a marca; nome antigo do logger sem a copia, usina sem curva e linha fora do
 *       contrato ABORTAM sem gravar nada.
 *   5 · plantios na lib e no gerador (uma copia mudada, o ensaio de novo): cada um reprova com a falha declarada.
 * --produto (DEPOIS de gerar; LOCAL_DIR = a saida local, LOCAL_IN_DIR = as fontes locais; sem eles, o publicado):
 *   a marca e o esquema; o contrato em toda linha; a conta refeita AQUI de toda meia hora do TS1 de cada usina contra o registro de 5
 *   min (sg_curva, sg_str); a SEGUNDA ROTA: soma das meias horas x 0,5 h + as leituras de 5 min fora delas = a energia CA do
 *   inversor-dia do sg_saude (todas as leituras do dia, outro codigo), na folga do arredondamento e das leituras fora da grade (ate
 *   1 kW cada); a copia do supervisorio sem a marca; o peso de cada arquivo.
 * uso: node scripts/ensaio-pvstr-logger.js --lib | --produto
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const STR = require('./lib-strings.js');
const LD = require('./lib-le-dados');
const { P_GER_W } = require('./lib-sungrow-str.js');
const { PLACA } = require('./lib-placa.js');

const LIB = path.join(__dirname, 'lib-pvstr-logger.js');
const GEN = path.join(__dirname, 'gen-pvstr-logger.js');
const USINAS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const MODO = process.argv.includes('--produto') ? 'produto' : 'lib';
const falhasTotal = [];
const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const r2 = (x) => Math.round(x * 100) / 100;
/* a conta refeita aqui, sem a lib: a media das seis leituras de 5 min de T a T+25 (null se faltar uma) */
const mediaAqui = (a, j, f) => { if (j < 0 || j + 6 > a.length) return null; let s = 0; for (let q = 0; q < 6; q++) { if (a[j + q] == null) return null; s += a[j + q]; } return (s / 6) * f; };

/* ============================================================ --lib ============================================================ */
/* o inversor-dia forjado: grade de 06:00 a 17:55 (144 leituras). Potencia em 0,1 kW:
   06:00 e 06:30 zero (pontas sem geracao); 07:00 rampa a 2 A nas strings (abaixo do piso); 10:00 RAMPA 100..600 (media 350 = 35 kW,
   amostra de T = 10 kW); 11:00 uma leitura de CA faltando; 12:00 uma temperatura faltando; 12:30 isolamento no topo nas seis; 13:00
   topo misturado; 13:30 um isolamento ZERO (sem leitura); 14:00 limitacao em 3 de 6; 15:00 PARADA (zero) no meio do dia; 15:30 a entrada
   7 a 0,3 A (fuga, abaixo de 0,5 A); 16:30 uma leitura da string 9 faltando; de 17:00 em diante zero.
   Strings 1..22 reais a 8 A (80 em 0,1 A), a 5 a 4 A (a fraca, 50 %); 23 e 24 vazias (fora do `s`); MPPT 3 = 5 + 6 = 12 A contra 16 */
function forjado(o) {
  o = o || {};
  const n = 144, h0 = '06:00';
  const p = [], pdc = [], t = [], lim = [], iso = [], s = {};
  for (let e = 1; e <= 22; e++) s[e] = [];
  for (let j = 0; j < n; j++) {
    const m = 360 + 5 * j, T = Math.floor(m / 30) * 30, q = (m - T) / 5;
    let pv = 2500;
    if (T < 420 || T >= 1020 || T === 900) pv = 0;
    if (T === 600) pv = 100 * (q + 1);
    if (T === 660 && q === 2) pv = null;
    p.push(pv); pdc.push(pv == null ? 300 : pv + 10);
    t.push(T === 720 && q === 4 ? null : 500 + q);
    lim.push(T === 840 ? (q < 3 ? 1 : 0) : 0);
    iso.push(T === 750 ? 20000 : T === 780 ? (q === 5 ? 20000 : 245) : T === 810 && q === 1 ? 0 : 245);
    for (let e = 1; e <= 22; e++) {
      let a = pv === 0 ? 0 : T === 420 ? 20 : 80;
      if (e === 5 && a) a = a / 2;
      if (e === 7 && T === 930) a = 3;
      s[e].push(e === 9 && T === 990 && q === 2 ? null : a);
    }
  }
  const cv = { d: o.d || '2026-10-15', inv: 'INV01', sn: 'S1', h0, p, pdc, t, lim, iso, nom: 320 };
  const st = { d: cv.d, inv: 'INV01', sn: o.snStr || 'S1', h0, reais: [], s };
  return { cv, st };
}
const REAIS22 = new Set(Array.from({ length: 22 }, (_, i) => i + 1));

async function casosLib(PV, mudo) {
  const falhas = [];
  const ok = (c, m) => { if (!c) falhas.push(m); if (!mudo) console.log((c ? '  ok   ' : '  FALHA ') + m); };
  if (!mudo) console.log('1 · meiasHoras (a conta refeita aqui)');
  const { cv, st } = forjado();
  const x = PV.meiasHoras('M1', 'TS1', cv, st, REAIS22) || { hora: { h: [] }, str: { s: {}, md: [] } };
  const H = x.hora, i = (h) => H.h.indexOf(h);
  const jDe = (h) => (min(h) - min(cv.h0)) / 5;
  ok(H.h[0] === '07:00' && H.h[H.h.length - 1] === '16:30' && H.h.every((h, k) => k === 0 || min(h) - min(H.h[k - 1]) === 30),
    'janela da primeira a ultima meia hora gerando (07:00 a 16:30), grade de 30 min, rotulo no INICIO: ' + H.h[0] + ' a ' + H.h[H.h.length - 1]);
  const esperado = r2(mediaAqui(cv.p, jDe('10:00'), 0.1));
  ok(H.pca[i('10:00')] === esperado && esperado === 35 && cv.p[jDe('10:00')] * 0.1 === 10,
    'a meia hora das 10:00 e a MEDIA das seis leituras (35 kW), nao a amostra das 10:00 (10 kW): ' + H.pca[i('10:00')]);
  const todas = H.h.every((h, k) => { const e = mediaAqui(cv.p, jDe(h), 0.1); return e == null ? H.pca[k] === null : H.pca[k] === r2(e); });
  ok(todas, 'toda meia hora da CA igual a media refeita aqui (ou nula quando falta leitura)');
  ok(H.ef[i('10:00')] === r2((35 / 36) * 100), 'eficiencia pela razao das medias (CA/CC): ' + H.ef[i('10:00')]);
  ok(i('11:00') >= 0 && H.pca[i('11:00')] === null && H.pcc[i('11:00')] === null && H.t[i('11:00')] === null && H.sm[i('11:00')] === null,
    'uma leitura de CA faltando: a meia hora das 11:00 fica no eixo com tudo nulo (tudo ou nada)');
  ok(H.t[i('12:00')] === null && H.pca[i('12:00')] === 250 && H.t[i('12:30')] === r2(mediaAqui(cv.t, jDe('12:30'), 0.1)),
    'uma temperatura faltando anula so a temperatura da meia hora: ' + H.t[i('12:00')] + ' / CA ' + H.pca[i('12:00')]);
  ok(H.iso[i('12:30')] === 20000 && H.iso[i('13:00')] === null && H.iso[i('13:30')] === null && H.iso[i('14:00')] === 245,
    'isolamento: seis no topo dao o topo, topo misturado e leitura faltando dao nulo, regime 245 kΩ: ' + [H.iso[i('12:30')], H.iso[i('13:00')], H.iso[i('13:30')], H.iso[i('14:00')]].join(' '));
  ok(H.lim[i('14:00')] === 50 && H.lim[i('10:00')] === 0, 'limitacao em % da meia hora (3 de 6 = 50 %): ' + H.lim[i('14:00')]);
  ok(H.sn[i('15:30')] === 21 && H.sw[i('15:30')] === 7, 'a entrada a 0,3 A (15:30) nao conta como string com corrente (21) e e a mais fraca: ' + [H.sn[i('15:30')], H.sw[i('15:30')]].join(' '));
  { const k9 = x.str.reais.indexOf(9), k = i('16:30');
    ok(k >= 0 && x.str.s[9][k] === null && H.sm[k] === 50 && H.sw[k] === 5 && H.mw[k] === 3 && x.str.s[1][k] === 100 && k9 >= 0,
      'leitura da string 9 faltando (16:30): a razao dela sai nula e a mais fraca continua a 5, sem ela: ' + [x.str.s[9] && x.str.s[9][k], H.sm[k], H.sw[k]].join(' ')); }
  ok(i('15:00') >= 0 && H.pca[i('15:00')] === 0, 'a parada do meio do dia (15:00 a zero) fica na curva');
  ok(H.sm[i('10:00')] === 50 && H.sw[i('10:00')] === 5 && H.sn[i('10:00')] === 22, 'a string 5 a 50 % das irmas e a mais fraca; 22 com corrente: ' + [H.sm[i('10:00')], H.sw[i('10:00')], H.sn[i('10:00')]].join(' '));
  ok(H.mm[i('10:00')] === 75 && H.mw[i('10:00')] === 3, 'o MPPT 3 (strings 5 + 6 = 12 A contra 16 A) a 75 % e o mais fraco; o MPPT 12 sem string real fora: ' + [H.mm[i('10:00')], H.mw[i('10:00')]].join(' '));
  ok(H.sm[i('07:00')] === null && H.mm[i('07:00')] === 75 && H.sn[i('07:00')] === 22, 'abaixo de 3 A de mediana (07:00, strings a 2 A) a razao das strings sai nula; o MPPT (4 A) ainda e julgado; as 22 contam com corrente: ' + [H.sm[i('07:00')], H.mm[i('07:00')]].join(' '));
  ok(!('sp' in H) && H.nom === 320 && H.ns === 'S1', 'sem `sp` (o logger nao tem setpoint), com a nominal e o numero de serie');
  ok(x.str.s[5] && x.str.s[5][i('10:00')] === 50 && x.str.s[1][i('10:00')] === 100 && x.str.md[i('10:00')] === 8 && x.str.reais.length === 22,
    'pvstr_str: a razao de cada string (a 5 a 50 %, a 1 a 100 %) e a mediana em A (8)');
  let estourou = false; try { const f = forjado({ snStr: 'OUTRO' }); PV.meiasHoras('M1', 'TS1', f.cv, f.st, REAIS22); } catch (e) { estourou = /grades diferentes/.test(e.message); }
  ok(estourou, 'curva e strings de numeros de serie diferentes estouram');
  ok(PV.contrato(H).length === 0, 'a linha forjada passa no contrato: ' + PV.contrato(H).join(' | '));
  if (!mudo) console.log('2 · monta, contrato, nomes');
  const dias = Array.from({ length: 9 }, (_, k) => '2026-10-' + String(10 + k).padStart(2, '0'));
  const curva = { serie: [] }, strs = { serie: [] };
  for (const d of dias) { const f = forjado({ d }); curva.serie.push(f.cv); if (d !== '2026-10-17') strs.serie.push(f.st); }
  const ent = { entradas: Array.from({ length: 22 }, (_, k) => ({ ufv: 'M1', ts: 'TS1', inv: 'INV01', g: 's', n: k + 1, ok: ['2026-04-01', '2026-04-02', '2026-04-03'], ultimo_ok: '2026-10-01' })) };
  const M = PV.monta({ etcs: ['M1_TS1'], curva: { M1_TS1: curva }, str: { M1_TS1: strs }, entradas: ent });
  ok(M.dias.M1.length === 7 && M.dias.M1[0] === '2026-10-12' && M.hora.M1.length === 7 && M.str.M1_TS1.length === 6 && M.n.sem_str === 1,
    'monta: os ultimos 7 dias (12 a 18/10), a curva sem strings contada (1) e fora do pvstr_str: ' + M.hora.M1.length + ' / ' + M.str.M1_TS1.length + ' / ' + M.n.sem_str);
  ok(M.hora.M1.find((l) => l.d === '2026-10-17').sm.every((v) => v === null) && M.hora.M1[0].sm[i('10:00')] === 50, 'sem as strings do dia a razao fica nula; com elas, a das entradas reais do historico');
  const comSp = Object.assign({}, H, { sp: H.h.map(() => 1) }), torto = Object.assign({}, H, { t: H.t.slice(1) }), grade = Object.assign({}, H, { h: H.h.map((h, k) => (k === 3 ? '08:40' : h)) });
  ok(PV.contrato(comSp).some((m) => /sp publicado/.test(m)) && PV.contrato(torto).some((m) => /fora do tamanho/.test(m)) && PV.contrato(grade).some((m) => /grade quebrada|rotulo/.test(m)),
    'contrato: sp publicado, lista fora do tamanho e grade quebrada reprovam');
  ok(PV.nomeScada('pvstr_hora_M5.json') === 'pvstr_hora_M5_scada.json' && PV.nomeScada('pvstr_str_M5_TS3.json') === 'pvstr_str_M5_TS3_scada.json'
    && PV.nomeScada('pvstr_entradas.json') === null && PV.nomeScada('perdas_inv.json') === null && PV.nomeScada('pvstr_hora_M5_scada.json') === null,
    'nomeScada: so pvstr_hora_<u> e pvstr_str_<u>_<ts> ganham o _scada; o resto (e o proprio _scada) nao');
  const leFake = (mundo) => async (n) => { if (!(n in mundo)) throw new Error(n + ': HTTP 404'); return mundo[n]; };
  const tenta = async (f) => { try { return { r: await f() }; } catch (e) { return { e: e.message }; } };
  const c1 = await tenta(() => PV.leCopia(leFake({ 'pvstr_hora_M1_scada.json': { serie: [1] }, 'pvstr_hora_M1.json': { origem_inversor: 'logger' } }), 'pvstr_hora_M1.json'));
  const c2 = await tenta(() => PV.leCopia(leFake({ 'pvstr_hora_M1.json': { serie: [2] } }), 'pvstr_hora_M1.json'));
  const c3 = await tenta(() => PV.leCopia(leFake({ 'pvstr_hora_M1.json': { origem_inversor: 'logger' } }), 'pvstr_hora_M1.json'));
  const c4 = await tenta(() => PV.leCopia(leFake({ 'pvstr_hora_M1_scada.json': { origem_inversor: 'logger' } }), 'pvstr_hora_M1.json'));
  const c5 = await tenta(() => PV.leCopia(async () => { throw new Error('x: HTTP 500'); }, 'pvstr_hora_M1.json'));
  ok(c1.r && c1.r.serie[0] === 1 && c2.r && c2.r.serie[0] === 2 && /se perdeu/.test(c3.e || '') && /contaminada/.test(c4.e || '') && /500/.test(c5.e || ''),
    'leCopia: a copia vale; sem ela, o nome antigo sem a marca; o do logger sem copia, a copia com a marca e o HTTP 500 estouram');
  return falhas;
}

/* 3 · o gen-perdas: o `fisico` compilado da propria fonte, com a lib (o nome que ele grava e le) */
function fisicoPerdas(fonte) {
  const src = fs.readFileSync(fonte || path.join(__dirname, 'gen-perdas.js'), 'utf8').replace(/\r\n/g, '\n');
  const mP = src.match(/const PUBLICA = (\{[\s\S]*?\});/), mF = src.match(/const fisico = (\(nome\) => [^\n]*);/);
  if (!mP || !mF || !/const \{ nomeScada \} = require\('\.\/lib-pvstr-logger\.js'\);/.test(src)) return { ok: false, txt: 'sem PUBLICA, fisico ou o require da lib no gen-perdas' };
  // eslint-disable-next-line no-new-func
  const fisico = new Function('nomeScada', 'const PUBLICA = ' + mP[1] + '; return ' + mF[1] + ';')(require(LIB).nomeScada);
  const usa = /async function grava\(nomeLogico, obj\) \{\n  const nome = fisico\(nomeLogico\);/.test(src) && /puxa\(base \+ fisico\(nome\)\)/.test(src)
    && /if \(!e\.naoExiste \|\| fisico\(nome\) === nome\) throw e;/.test(src);
  const casos = [['pvstr_hora_M5.json', 'pvstr_hora_M5_scada.json'], ['pvstr_str_M9_TS2.json', 'pvstr_str_M9_TS2_scada.json'], ['perdas_inv.json', 'perdas_inv_scada.json'],
    ['perdas_30min.json', 'perdas_30min.json'], ['pvstr_entradas.json', 'pvstr_entradas.json']];
  const ruins = casos.filter(([a, b]) => fisico(a) !== b);
  return { ok: !ruins.length && usa, txt: ruins.length ? 'nome errado: ' + ruins.map(([a]) => a + ' -> ' + fisico(a)).join(', ') : usa ? '5 nomes certos' : 'o grava/leAnterior/primeira rodada nao usam o fisico' };
}

/* 3b · o leAnterior do gen-perdas EXECUTADO (recortado da fonte dele, com o puxa forjado): a primeira rodada da copia do supervisorio.
   Sem a copia `_scada`, o nome antigo vale so SEM a marca do logger; com a marca, estoura (o historico do supervisorio se perdeu) */
async function primeiraRodadaPerdas(fonte) {
  const src = fs.readFileSync(fonte || path.join(__dirname, 'gen-perdas.js'), 'utf8').replace(/\r\n/g, '\n');
  const mP = src.match(/const PUBLICA = (\{[\s\S]*?\});/), mF = src.match(/const fisico = (\(nome\) => [^\n]*);/);
  const i = src.indexOf('async function leAnterior(nome) {'), j = i < 0 ? -1 : src.indexOf('\n}\n', i);
  if (!mP || !mF || i < 0 || j < 0) return { ok: false, txt: 'sem PUBLICA, fisico ou leAnterior no gen-perdas' };
  const corpo = src.slice(i, j + 2);
  const caso = async (mundo, nome) => {
    const puxa = async (url) => { const n = url.split('/').pop(); if (!(n in mundo)) { const e = new Error(url + ' -> HTTP 404'); e.naoExiste = true; throw e; } return JSON.parse(JSON.stringify(mundo[n])); };
    // eslint-disable-next-line no-new-func
    const leAnt = new Function('nomeScada', 'puxa', 'migraSetpoint', 'migraIsolZero', 'const PUBLICA = ' + mP[1] + '; const fisico = ' + mF[1] + '; const _anterior = new Map();\n'
      + corpo + '\nreturn leAnterior;')(require(LIB).nomeScada, puxa, () => {}, (x) => x);
    try { return { r: await leAnt(nome) }; } catch (e) { return { e: e.message }; }
  };
  const H = 'pvstr_hora_M1.json', C = 'pvstr_hora_M1_scada.json';
  const a = await caso({ [H]: { origem_inversor: 'logger', serie: [9] } }, H), b = await caso({ [H]: { serie: [1] } }, H);
  const c = await caso({ [C]: { serie: [2] }, [H]: { origem_inversor: 'logger', serie: [9] } }, H), d = await caso({}, H);
  const ok = /se perdeu/.test(a.e || '') && !!b.r && b.r.serie && b.r.serie[0] === 1 && !!c.r && c.r.serie && c.r.serie[0] === 2 && Array.isArray(d.r) && !d.r.length;
  return { ok, txt: 'nome antigo do logger sem copia: ' + (a.e ? 'estoura' : 'LE') + ' · sem a marca: ' + (b.r ? 'le' : b.e) + ' · com a copia: ' + (c.r && c.r.serie ? 'a copia' : c.e) + ' · sem nada: ' + (Array.isArray(d.r) ? 'primeira rodada' : d.e) };
}

/* 4 · o gerador de ponta a ponta, num processo a parte, com o mundo forjado em LOCAL_IN_DIR */
function mundo(dir, o) {
  o = o || {};
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const g = (n, j) => fs.writeFileSync(path.join(dir, n), zlib.gzipSync(JSON.stringify(j)));
  const ident = {}, entradas = [];
  for (const u of USINAS) {
    ident['SN' + u] = { pos: u + '/TS1/INV01' };
    for (let e = 1; e <= 22; e++) entradas.push({ ufv: u, ts: 'TS1', inv: 'INV01', g: 's', n: e, ok: ['2026-04-01', '2026-04-02', '2026-04-03'], ultimo_ok: '2026-10-01' });
    if (o.semCurva === u) continue;
    const C = { serie: [] }, S = { serie: [] };
    for (const d of ['2026-10-17', '2026-10-18']) {
      const f = forjado({ d }); f.cv.sn = f.st.sn = 'SN' + u;
      if (o.fora === u) f.cv.p = f.cv.p.map((v) => (v ? 4000 : v));   // 400 kW: acima do teto do inversor
      C.serie.push(f.cv); S.serie.push(f.st);
    }
    g('sg_curva_' + u + '_TS1.json', C); g('sg_str_' + u + '_TS1.json', S);
  }
  g('sg_ident.json', { ident }); g('sg_str_entradas.json', { entradas });
  // o blob antigo do supervisorio (so no M1): a semente da copia
  if (o.antigo !== false) g('pvstr_hora_M1.json', Object.assign({ usina: 'M1', esquema: 3, serie: [{ d: '2026-10-14', ts: 'TS1', inv: 'INV01', h: ['10:00'], pca: [1], sp: [352] }] }, o.antigo || {}));
  g('pvstr_str_M1_TS1.json', { usina: 'M1', ts: 'TS1', esquema: 1, serie: [{ d: '2026-10-14', ufv: 'M1', ts: 'TS1', inv: 'INV01', h: ['10:00'], md: [8], s: { 1: [100] }, reais: [1] }] });
}
function ponta(gen) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-pvstr-'));
  const IN = path.join(raiz, 'in'), OUT = path.join(raiz, 'out');
  let erro = '';
  const roda = () => { fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT); erro = '';
    try { execFileSync('node', [gen], { env: Object.assign({}, process.env, { LOCAL_IN_DIR: IN, LOCAL_OUT_DIR: OUT }), stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch (e) { erro = String(e.stderr || '') + String(e.stdout || ''); return false; } };
  const le = (n) => { const f = path.join(OUT, n); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) : null; };
  const R = {};
  try {
    mundo(IN); R.roda = roda();
    const cp = le('pvstr_hora_M1_scada.json'), cs = le('pvstr_str_M1_TS1_scada.json'), h1 = le('pvstr_hora_M1.json'), h9 = le('pvstr_hora_M9.json'), s1 = le('pvstr_str_M1_TS1.json');
    R.okSemente = !!cp && !cp.origem_inversor && cp.serie[0].sp[0] === 352 && !!cs && !le('pvstr_hora_M2_scada.json');
    R.okProduto = !!h1 && h1.origem_inversor === 'logger' && h1.esquema === 4 && h1.serie.length === 2 && !!h9 && h9.serie.length === 2
      && h1.serie[0].pca[h1.serie[0].h.indexOf('10:00')] === 35 && !!s1 && s1.origem_inversor === 'logger' && s1.serie.length === 2
      && USINAS.every((u) => !!le('pvstr_hora_' + u + '.json'));
    // cada aborto pela SUA guarda: a mensagem que ela escreve (outra queda no mesmo mundo nao vale)
    mundo(IN, { antigo: { origem_inversor: 'logger' } }); R.okSePerdeu = roda() === false && !fs.readdirSync(OUT).length && /se perdeu/.test(erro);
    mundo(IN, { semCurva: 'M7' }); R.okSemUsina = roda() === false && !fs.readdirSync(OUT).length && /M7: nenhuma curva/.test(erro);
    mundo(IN, { fora: 'M4' }); R.okContrato = roda() === false && !fs.readdirSync(OUT).length && /potencia fora da faixa/.test(erro);
  } catch (e) { R.erro = e.message; } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
  return R;
}

async function rodaLib() {
  console.log('ensaio-pvstr-logger --lib (sem rede)');
  falhasTotal.push(...await casosLib(require(LIB), false));
  console.log('3 · o gen-perdas grava a curva do supervisorio pelo nome da copia');
  const FP = fisicoPerdas();
  console.log((FP.ok ? '  ok   ' : '  FALHA ') + 'gen-perdas: fisico com a lib (' + FP.txt + ')'); if (!FP.ok) falhasTotal.push('gen-perdas fisico: ' + FP.txt);
  const PR = await primeiraRodadaPerdas();
  console.log((PR.ok ? '  ok   ' : '  FALHA ') + 'gen-perdas: o leAnterior executado na primeira rodada da copia (' + PR.txt + ')'); if (!PR.ok) falhasTotal.push('gen-perdas leAnterior: ' + PR.txt);
  console.log('4 · o gen-pvstr-logger de ponta a ponta (processo a parte, mundo forjado)');
  const P = ponta(GEN);
  const okP = (k, m) => { const c = P[k] === true; console.log((c ? '  ok   ' : '  FALHA ') + m); if (!c) falhasTotal.push(m); };
  if (P.erro) { falhasTotal.push('ponta: ' + P.erro); console.log('  FALHA ' + P.erro); }
  okP('roda', 'o gerador roda sobre o mundo forjado');
  okP('okSemente', 'semeia a copia do supervisorio com o blob antigo sem a marca (pvstr_hora e pvstr_str do M1); usina sem blob antigo nao ganha copia');
  okP('okProduto', 'grava pvstr_hora das nove usinas e o pvstr_str com a marca do logger, esquema 4, a media da meia hora');
  okP('okSePerdeu', 'nome antigo ja do logger e sem copia: aborta sem gravar nada');
  okP('okSemUsina', 'usina sem curva: aborta sem gravar nada');
  okP('okContrato', 'linha fora do contrato (CA a 400 kW): aborta sem gravar nada');

  console.log('5 · plantios (cada um roda o ensaio de novo e tem de reprovar com a falha declarada)');
  const srcL = fs.readFileSync(LIB, 'utf8'), srcG = fs.readFileSync(GEN, 'utf8'), srcP = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8');
  const TL = path.join(__dirname, '_plantio_lib_pvstr_logger.js'), TG = path.join(__dirname, '_plantio_gen_pvstr_logger.js'), TP = path.join(__dirname, '_plantio_perdas_pvstr.js');
  const planta = async (nome, alvo, de, para, espera) => {
    const [src, tmp] = alvo === 'lib' ? [srcL, TL] : alvo === 'gen' ? [srcG, TG] : [srcP, TP];
    if (src.split(de).length !== 2) { falhasTotal.push('plantio ' + nome + ': trecho nao casou'); console.log('  FALHA plantio ' + nome + ': trecho nao casou'); return; }
    let r;
    try {
      fs.writeFileSync(tmp, src.split(de).join(para));
      if (alvo === 'lib') { delete require.cache[require.resolve(tmp)]; try { r = await casosLib(require(tmp), true); } catch (e) { r = ['estourou: ' + e.message]; } }
      else if (alvo === 'gen') { const P2 = ponta(tmp); r = Object.entries(P2).filter(([k, v]) => k !== 'erro' && v !== true).map(([k]) => k); }
      else { r = (fisicoPerdas(tmp).ok ? [] : ['fisico']).concat((await primeiraRodadaPerdas(tmp)).ok ? [] : ['primeira rodada']); }
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
    const certo = r.some((m) => espera.test(m));
    if (!certo) falhasTotal.push('plantio "' + nome + '" nao reprovou pela falha declarada (' + r.slice(0, 2).join(' | ').slice(0, 160) + ')');
    console.log((certo ? '  ok   ' : '  FALHA ') + 'plantio "' + nome + '" reprova em: ' + (r.find((m) => espera.test(m)) || r[0] || 'nada').slice(0, 90));
  };
  await planta('amostra de T no lugar da media', 'lib', '  return (s / POR_MEIA) * f;\n', '  return a[j] * f;\n', /^a meia hora das 10:00 e a MEDIA/);
  await planta('media de cinco aceita', 'lib', 'const x = a[j + q]; if (x == null || (ok && !ok(x))) return null; s += x;', 'const x = a[j + q]; if (x == null || (ok && !ok(x))) continue; s += x;', /^uma leitura de CA faltando|^toda meia hora/);
  await planta('rotulo no fim da meia hora', 'lib', 'const o = { h: hhmm(T), lida:', 'const o = { h: hhmm(T + 30), lida:', /^janela da primeira/);
  await planta('topo misturado na media', 'lib', 'return topo === 0 ? r2(m) : topo === POR_MEIA ? ISO_TOPO : null;', 'return r2(m);', /^isolamento:/);
  await planta('isolamento zero como leitura', 'lib', 'const m = media(a, j, 1, (x) => x > 0); if (m == null) return null;', 'const m = media(a, j, 1); if (m == null) return null;', /^isolamento:/);
  await planta('sn sem o piso de 0,5 A', 'lib', 'const VIVA_A = 0.5;', 'const VIVA_A = 0;', /^a entrada a 0,3 A/);
  await planta('leitura de string faltando vira zero', 'lib', 'for (const e of ents) { const x = media(st.s[e], j, 0.1); cS[e] = x; }', 'for (const e of ents) { const x = media(st.s[e].map((v) => (v == null ? 0 : v)), j, 0.1); cS[e] = x; }', /^leitura da string 9/);
  await planta('razao sem o piso de 3 A', 'lib', 'const ds = st ? STR.dispersao(cS, R, PISO_A) : null;', 'const ds = st ? STR.dispersao(cS, R, 0) : null;', /^abaixo de 3 A/);
  await planta('MPPT sem somar o par', 'lib', 'cM[k] = a == null || b == null ? null : a + b;', 'cM[k] = a;', /^o MPPT 3/);
  await planta('MPPT com a entrada vazia', 'lib', 'for (const k of R) RM.add(Math.ceil(k / 2));', 'for (let k = 1; k <= 24; k++) RM.add(Math.ceil(k / 2));', /^o MPPT 3/);
  await planta('janela sem cortar as pontas', 'lib', 'const J = linhas.slice(ger[0], ger[ger.length - 1] + 1);', 'const J = linhas;', /^janela da primeira/);
  await planta('sp publicado como nulo', 'lib', 'for (const c of CAMPOS) hora[c] =', 'hora.sp = J.map(() => null); for (const c of CAMPOS) hora[c] =', /^sem `sp`/);
  await planta('limitacao em fracao', 'lib', 'o.lim = r1(media(cv.lim, j, 100));', 'o.lim = r1(media(cv.lim, j, 1));', /^limitacao em %/);
  await planta('sem os ultimos 7 dias', 'lib', 'const ds = [...new Set(hora[u].map((l) => l.d))].sort().slice(-DIAS);', 'const ds = [...new Set(hora[u].map((l) => l.d))].sort();', /^monta:/);
  await planta('leCopia aceita o logger sem copia', 'lib', "if (a && a.origem_inversor) throw new Error(nome + ' ja e do '", "if (false) throw new Error(nome + ' ja e do '", /^leCopia/);
  await planta('gerador sem semear a copia', 'gen', '  for (const [novo, j] of copias) pesos[novo + \' (semente)\'] = await escreve(novo, j);\n', '', /okSemente/);
  await planta('gerador sem as guardas', 'gen', '  if (mau.length) { console.error(', '  if (false) { console.error(', /okSemUsina|okContrato/);
  await planta('gerador grava antes de conferir a copia', 'gen', '  const copias = [];\n  for (const [novo, antigo] of sementes) { const c = await copiaScada(novo, antigo); if (c.semeada) copias.push([novo, c.j]); }\n',
    '  const copias = [];\n  for (const u of USINAS) await escreve(\'pvstr_hora_\' + u + \'.json\', { origem_inversor: \'logger\', serie: [] });\n  for (const [novo, antigo] of sementes) { const c = await copiaScada(novo, antigo); if (c.semeada) copias.push([novo, c.j]); }\n', /okSePerdeu/);
  await planta('gen-perdas de volta ao nome das telas', 'perdas', 'const fisico = (nome) => PUBLICA[nome] || nomeScada(nome) || nome;', 'const fisico = (nome) => PUBLICA[nome] || nome;', /fisico/);
  await planta('gen-perdas aceita o nome antigo do logger', 'perdas', '      if (j && j.origem_inversor) {', '      if (false && j && j.origem_inversor) {', /primeira rodada/);
  await planta('gen-perdas sem a primeira rodada da copia', 'perdas', '      if (!e.naoExiste || fisico(nome) === nome) throw e;', '      if (!e.naoExiste || !PUBLICA[nome]) throw e;', /fisico/);
}

/* ============================================================ --produto ======================================================== */
async function le(nome, dir) {
  if (dir) { const f = path.join(dir, nome); if (!fs.existsSync(f)) return null; let b = fs.readFileSync(f); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return JSON.parse(b.toString('utf8')); }
  const r = await LD.pede('https://rbenergydata.blob.core.windows.net/dados/' + nome, { 'accept-encoding': 'gzip' });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(nome + ': HTTP ' + r.status);
  let b = r.buf; if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return JSON.parse(b.toString('utf8'));
}
/* a conta refeita AQUI de toda meia hora do TS1 de uma usina, contra o registro de 5 min (sg_curva, sg_str): { ref, dif } */
function reconta(PV, H, C, S, REAIS, u) {
  let ref = 0, dif = 0;
  const mS = new Map(((S && S.serie) || []).map((l) => [l.d + '|' + l.inv + '|' + l.sn, l]));
  const mH = new Map(H.serie.map((l) => [l.d + '|' + l.ts + '|' + l.inv, l]));
  const igual = (a, b, tol) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol);
  for (const cv of ((C && C.serie) || [])) {
    const l = mH.get(cv.d + '|TS1|' + cv.inv); if (!l || l.ns !== cv.sn) continue;
    const st = mS.get(cv.d + '|' + cv.inv + '|' + cv.sn), R = (REAIS.get(u + '|TS1|' + cv.inv + '|s') || {}).reais;
    l.h.forEach((h, k) => {
      const j = (min(h) - min(cv.h0)) / 5;
      const pca = mediaAqui(cv.p, j, 0.1), pcc = mediaAqui(cv.pdc, j, 0.1), lida = pca != null && pcc != null;
      const t = lida ? mediaAqui(cv.t, j, 0.1) : null, lim = lida ? mediaAqui(cv.lim, j, 100) : null;
      let sm = null;
      if (lida && st) { const c = {}; for (const e of Object.keys(st.s)) c[e] = mediaAqui(st.s[e], j, 0.1); const d = STR.dispersao(c, R, PV.PISO_A); sm = d ? d.min_pct : null; }
      ref += 1;
      if (!igual(l.pca[k], lida ? pca : null, 0.006) || !igual(l.pcc[k], lida ? pcc : null, 0.006) || !igual(l.t[k], t, 0.006)
        || !igual(l.lim[k], lim == null ? null : Math.round(lim * 10) / 10, 0.051) || !igual(l.sm[k], sm, 0.006)) dif += 1;
    });
  }
  return { ref, dif };
}
/* a SEGUNDA ROTA: a energia CA do inversor-dia do sg_saude (todas as leituras do dia, potencia de 5 min x 5/60 h, outro codigo) =
   meias horas x 0,5 h + as leituras de 5 min publicadas fora delas + o que esta fora da grade publicada (ate 1 kW por leitura).
   Folga: o arredondamento da potencia publicada (0,1 kW: 0,05 kW x 288 leituras / 12) e o das meias horas. { n, fora, ex, resid, grade } */
function fecha(H, SA, curvas, u) {
  const out = { n: 0, fora: 0, ex: [], resid: [], grade: 0 };
  const mSA = new Map(((SA && SA.serie) || []).map((l) => [l.d + '|' + l.ts + '|' + l.inv, l]));
  for (const l of H.serie) {
    const s = mSA.get(l.d + '|' + l.ts + '|' + l.inv); if (!s || s.p !== 0 || s.eca == null) continue;
    const C2 = curvas[l.ts]; if (!C2) continue;
    const cv = (C2.serie || []).find((x) => x.d === l.d && x.inv === l.inv && x.sn === l.ns); if (!cv) continue;
    const coberto = new Set(); l.h.forEach((h, k) => { if (l.pca[k] != null) for (let q = 0; q < 6; q++) coberto.add((min(h) - min(cv.h0)) / 5 + q); });
    const resto = cv.p.reduce((a, x, j) => a + (coberto.has(j) || x == null || x <= 0 ? 0 : x * 0.1 * 5 / 60), 0);
    const meias = l.pca.reduce((a, x) => a + (x == null ? 0 : x * 0.5), 0);
    const r = s.eca - meias - resto;
    /* folga: o arredondamento da potencia publicada (0,05 kW em cada leitura de 5 min), o das meias horas (0,005 kW x 0,5 h) e o do
       proprio eca (2 casas); teto: cada leitura fora da grade publicada vale no maximo o piso de geracao do logger (P_GER_W), e cada
       leitura que FALTA dentro do registro (o logger nao gravou; a meia hora dela sai do produto, tudo-ou-nada) vale no maximo a maior
       das vizinhas. Sem isso uma leitura perdida em pleno dia (M8 TS7/INV05 23/10 07:40, ~300 kW, 25 kWh) reprovava o produto certo */
    const nL = cv.p.filter((x) => x != null).length;
    const furo = cv.p.reduce((a, x, j) => (x != null ? a : a + Math.max(0, cv.p[j - 1] || 0, cv.p[j + 1] || 0) * 0.1 * 5 / 60), 0);
    const tol = 0.05 * 5 / 60 * nL + 0.0025 * l.h.length + 0.005, teto = (288 - cv.p.length) * (P_GER_W / 1000) * 5 / 60 + furo + tol;
    out.n += 1; out.resid.push(r);
    if (r < -tol || r > teto) { out.fora += 1; if (out.ex.length < 5) out.ex.push(u + ' ' + l.d + ' ' + l.ts + '/' + l.inv + ' ' + r.toFixed(2) + ' kWh (teto ' + teto.toFixed(1) + ')'); }
    if (min(cv.h0) % 30) out.grade += 1;
  }
  return out;
}
async function rodaProduto() {
  const PV = require(LIB);
  const DIR = process.env.LOCAL_DIR || null, FONTES = process.env.LOCAL_IN_DIR || null;
  console.log('ensaio-pvstr-logger --produto · ' + (DIR ? 'saida local ' + DIR : 'o publicado') + ' · fontes ' + (FONTES ? 'locais' : 'publicadas'));
  const falha = (m) => { falhasTotal.push(m); console.log('  FALHA ' + m); };
  const ent = await le('sg_str_entradas.json', FONTES);
  const REAIS = STR.indiceReais((ent && ent.entradas) || []);
  const T = { ref: 0, dif: 0, n: 0, fora: 0, ex: [], resid: [], grade: 0 };
  let plantado = null;
  for (const u of USINAS) {
    const H = await le('pvstr_hora_' + u + '.json', DIR);
    if (!H) { falha(u + ': pvstr_hora ausente'); continue; }
    if (H.origem_inversor !== 'logger' || H.esquema !== PV.ESQUEMA) falha(u + ': sem a marca do logger ou esquema ' + H.esquema);
    const mau = H.serie.flatMap((l) => PV.contrato(l)); if (mau.length) falha(u + ': ' + mau.length + ' quebras de contrato · ' + mau.slice(0, 3).join(' | '));
    // o teto da pagina que baixa o pvstr_hora (pvstr1r e o Mapa): o mesmo 900 KB declarado no ensaio-pvstr-hora
    const bytes = zlib.gzipSync(JSON.stringify(H)).length; if (bytes > 900 * 1024) falha(u + ': ' + Math.round(bytes / 1024) + ' KB, acima do teto de 900 KB da pagina');
    const cp = await le('pvstr_hora_' + u + '_scada.json', DIR || FONTES);
    if (cp && cp.origem_inversor) falha(u + ': a copia do supervisorio traz a marca do logger');
    const curvas = {};
    for (const ts of [...new Set(H.serie.map((l) => l.ts))]) curvas[ts] = await le('sg_curva_' + u + '_' + ts + '.json', FONTES);
    const S1 = await le('sg_str_' + u + '_TS1.json', FONTES), SA = await le('sg_saude_' + u + '.json', FONTES);
    const rc = reconta(PV, H, curvas.TS1, S1, REAIS, u), fc = fecha(H, SA, curvas, u);
    T.ref += rc.ref; T.dif += rc.dif; T.n += fc.n; T.fora += fc.fora; T.ex.push(...fc.ex); T.resid.push(...fc.resid); T.grade += fc.grade;
    if (!rc.ref) falha(u + ': a conta refeita nao julgou nenhuma meia hora do TS1');
    if (!fc.n) falha(u + ': a segunda rota nao julgou nenhum inversor-dia');
    // a COBERTURA: todo inversor-dia do registro de 5 min com uma meia hora inteira gerando (conta daqui) tem de estar no produto
    { const noH = new Set(H.serie.map((l) => l.d + '|' + l.ts + '|' + l.inv + '|' + l.ns)), falta = [];
      for (const ts of Object.keys(PLACA[u].inv_por_ts)) {
        if (!(ts in curvas)) curvas[ts] = await le('sg_curva_' + u + '_' + ts + '.json', FONTES);
        for (const cv of ((curvas[ts] && curvas[ts].serie) || [])) {
          // todo dia do registro de 5 min (ele guarda os mesmos 7 dias do produto): um dia inteiro perdido tambem aparece
          const m0 = min(cv.h0); let ger = false;
          for (let T0 = Math.ceil(m0 / 30) * 30; !ger && T0 + 25 <= m0 + 5 * (cv.p.length - 1); T0 += 30) {
            const j = (T0 - m0) / 5, a = mediaAqui(cv.p, j, 0.1), b = mediaAqui(cv.pdc, j, 0.1); ger = a != null && b != null && (a > 1 || b > 1); }
          if (ger && !noH.has(cv.d + '|' + ts + '|' + cv.inv + '|' + cv.sn)) falta.push(cv.d + ' ' + ts + '/' + cv.inv);
        }
      }
      if (falta.length) falha(u + ': ' + falta.length + ' inversor-dias do registro de 5 min fora do produto · ' + falta.slice(0, 4).join(', '));
      T.cob = (T.cob || 0) + noH.size; }
    // o pvstr_str de cada eletrocentro: a marca, a grade igual a do pvstr_hora e, no TS1, a razao de cada string refeita aqui
    for (const ts of [...new Set(H.serie.map((l) => l.ts))]) {
      const P = await le('pvstr_str_' + u + '_' + ts + '.json', DIR);
      if (!P) { falha(u + '/' + ts + ': pvstr_str ausente'); continue; }
      if (P.origem_inversor !== 'logger' || P.esquema !== PV.ESQUEMA) falha(u + '/' + ts + ': pvstr_str sem a marca do logger ou esquema ' + P.esquema);
      const cs = await le('pvstr_str_' + u + '_' + ts + '_scada.json', DIR || FONTES);
      if (cs && cs.origem_inversor) falha(u + '/' + ts + ': a copia do supervisorio das strings traz a marca do logger');
      const mH = new Map(H.serie.filter((l) => l.ts === ts).map((l) => [l.d + '|' + l.inv, l]));
      for (const l of P.serie) { const h = mH.get(l.d + '|' + l.inv); T.strL = (T.strL || 0) + 1;
        if (!h || h.ns !== l.ns || JSON.stringify(h.h) !== JSON.stringify(l.h)) { T.strGrade = (T.strGrade || 0) + 1; continue; }
        if (ts !== 'TS1') continue;
        const cv = ((curvas.TS1 && curvas.TS1.serie) || []).find((c) => c.d === l.d && c.inv === l.inv && c.sn === l.ns);
        const st = ((S1 && S1.serie) || []).find((c) => c.d === l.d && c.inv === l.inv && c.sn === l.ns); if (!cv || !st) continue;
        const R = (REAIS.get(u + '|TS1|' + l.inv + '|s') || {}).reais;
        l.h.forEach((hh, k) => {
          const j = (min(hh) - min(cv.h0)) / 5, lida = mediaAqui(cv.p, j, 0.1) != null && mediaAqui(cv.pdc, j, 0.1) != null;
          const c = {}; if (lida) for (const e of Object.keys(st.s)) c[e] = mediaAqui(st.s[e], j, 0.1);
          const dd = lida ? STR.dispersao(c, R, PV.PISO_A) : null;
          T.strRef = (T.strRef || 0) + 1;
          const md = dd ? dd.med : null, ok1 = (md == null && l.md[k] == null) || (md != null && l.md[k] != null && Math.abs(md - l.md[k]) <= 0.006);
          const ok2 = l.reais.every((e) => { const v = dd && c[e] != null ? Math.round((c[e] / dd.med) * 1000) / 10 : null, w = (l.s[e] || [])[k];
            return (v == null && w == null) || (v != null && w != null && Math.abs(v - w) <= 0.051); });
          if (!ok1 || !ok2) T.strDif = (T.strDif || 0) + 1;
        });
      }
    }
    /* 🔴 OS PLANTIOS NO PRODUTO, em memoria, na primeira usina julgada: a AMOSTRA de T no lugar da media (a curva do supervisorio) e a
       energia a mais (CA x 1,05) tem de reprovar na conta refeita e na segunda rota; sem isso a guarda pode estar calada */
    if (!plantado && rc.ref && fc.n) {
      const A = JSON.parse(JSON.stringify(H)), B = JSON.parse(JSON.stringify(H));
      const mC = new Map(((curvas.TS1 && curvas.TS1.serie) || []).map((c) => [c.d + '|' + c.inv + '|' + c.sn, c]));
      for (const l of A.serie) { const c = l.ts === 'TS1' && mC.get(l.d + '|' + l.inv + '|' + l.ns); if (!c) continue;
        l.pca = l.h.map((h, k) => (l.pca[k] == null ? null : r2(c.p[(min(h) - min(c.h0)) / 5] * 0.1))); }
      for (const l of B.serie) l.pca = l.pca.map((x) => (x == null ? null : r2(x * 1.05)));
      plantado = { u, amostra: reconta(PV, A, curvas.TS1, S1, REAIS, u).dif, mais_rc: reconta(PV, B, curvas.TS1, S1, REAIS, u).dif, mais_fc: fecha(B, SA, curvas, u).fora };
    }
    console.log('  ' + u + ': ' + H.serie.length + ' inversor-dias · ' + Math.round(bytes / 1024) + ' KB' + (cp ? ' · copia do supervisorio ' + cp.serie.length : ' · sem copia'));
  }
  T.resid.sort((a, b) => a - b);
  console.log('  conta refeita (TS1 de cada usina): ' + T.ref + ' meias horas, ' + T.dif + ' diferentes');
  console.log('  segunda rota (sg_saude): ' + T.n + ' inversor-dias · resto mediano ' + (T.resid[T.resid.length >> 1] || 0).toFixed(2) + ' kWh · fora da folga ' + T.fora
    + (T.ex.length ? ' · ' + T.ex.slice(0, 5).join(' ; ') : '') + (T.grade ? ' · ' + T.grade + ' com o registro de 5 min sem a grade alinhada a meia hora (gen-sungrow antigo)' : ''));
  console.log('  cobertura: ' + (T.cob || 0) + ' inversor-dias no produto · pvstr_str: ' + (T.strL || 0) + ' linhas, ' + (T.strGrade || 0) + ' fora da grade do pvstr_hora · razao refeita (TS1): '
    + (T.strRef || 0) + ' meias horas, ' + (T.strDif || 0) + ' diferentes');
  if (T.strGrade) falha(T.strGrade + ' linhas do pvstr_str sem a mesma grade (ou numero de serie) do pvstr_hora');
  if (!T.strRef) falha('a razao por string nao foi refeita em nenhuma meia hora');
  if (T.strDif) falha(T.strDif + ' meias horas do pvstr_str diferentes da razao refeita');
  if (!T.ref) falha('a conta refeita nao julgou nenhuma meia hora');
  if (T.dif) falha(T.dif + ' meias horas diferentes da conta refeita');
  if (!T.n) falha('a segunda rota nao julgou nenhum inversor-dia');
  if (T.fora) falha(T.fora + ' inversor-dias fora da folga da segunda rota');
  if (!plantado) falha('nenhuma usina para plantar o defeito no produto');
  else {
    const okP = plantado.amostra > 0 && plantado.mais_rc > 0 && plantado.mais_fc > 0;
    console.log((okP ? '  ok   ' : '  FALHA ') + 'plantios no produto (' + plantado.u + '): amostra de T no lugar da media -> ' + plantado.amostra + ' meias horas diferentes; CA x 1,05 -> '
      + plantado.mais_rc + ' diferentes e ' + plantado.mais_fc + ' fora da segunda rota');
    if (!okP) falhasTotal.push('um plantio no produto nao reprovou');
  }
}

(async () => {
  if (MODO === 'lib') await rodaLib(); else await rodaProduto();
  console.log(falhasTotal.length ? '\nREPROVADO: ' + falhasTotal.length + '\n  ' + falhasTotal.slice(0, 30).join('\n  ') : '\nensaio-pvstr-logger (' + MODO + '): tudo ok');
  process.exit(falhasTotal.length ? 1 : 0);
})().catch((e) => { console.error('ERRO ' + e.stack); process.exit(1); });
