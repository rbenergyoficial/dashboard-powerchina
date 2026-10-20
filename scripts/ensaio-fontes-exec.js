/*
 * ensaio-fontes-exec.js — as fontes diretas da Visao Executiva (lote fonte-perfil-way2, 19/10/2026).
 *
 * REGRA DO HUMANO (19/10/2026): potencia e energia vem do medidor de faturamento (5 min), irradiancia do datalogger das estacoes; tudo
 * INTEGRALIZADO para outros intervalos, nunca amostrado. O corte continua do operador (ONS).
 *
 * O QUE PROVA:
 *   --lib      (antes de gerar, no executivo.yml; no way2-hist.yml so `--lib --pico`: o pico e o arquivador, sem travar o arquivamento) a lib-fontes-exec e o rollupDia do arquivador sobre dias FORJADOS,
 *              com o esperado contado aqui (codigo proprio, por rotulo escrito, sem a aritmetica de relogio da lib):
 *              · a meia hora T do medidor = a media dos rotulos T+5 ... T+30 (o rotulo e o FIM dos 5 min); a 23:30 leva o rotulo 24:00;
 *              · circuito com leitura faltando perde a meia hora, e a usina dele tambem; o Complexo e o ponto que soma os 22;
 *              · o pico de 5 min da usina e o maior instante com TODOS os circuitos lidos; o do contrato, a soma SIMULTANEA; a hora e o
 *                rotulo; o rotulo da meia-noite seguinte sai '24:00'; o rollupDia publica `ufv_pico_mw`/`ufv_pico_hora`/`pico_hora`;
 *              · a irradiancia do datalogger: so meia hora acima de LIMIAR_SOL, so dia COMPLETO (48 meias horas), contrato e Complexo
 *                ponderados pela potencia e tudo-ou-nada; o mes pelas meias horas dos dias completos; rotulo que nao e o inicio estoura;
 *              · PLANTIOS (cada um TEM de reprovar, e o ensaio prova que o texto plantado mudou): na lib, o rotulo lido pelo inicio (o
 *                defeito do perfil antigo), a meia hora com leitura faltando, a usina com circuito faltando, o pico com instante
 *                incompleto, a noite na media da irradiancia, o dia incompleto, o contrato pela media simples, o contrato sem
 *                tudo-ou-nada; no arquivador, o pico da usina trocado pelo do conjunto; e duas implementacoes erradas do pico (a soma dos
 *                picos das usinas e a maior media de uma hora) que o julgamento tem de recusar.
 *   --produto  (depois de gerar, no executivo.yml) sobre o perfil_dia e o executivo publicados (ou LOCAL_OUT, como o gerador grava):
 *              · a marca (`med_fonte`, `med_dias`) e o `med_mw` em toda linha;
 *              · SEGUNDA ROTA no medidor: D-2 (relido na rodada) e D-4 (REAPROVEITADO do perfil anterior) recontados aqui do arquivo de
 *                5 min, linha a linha, so a comparacao numerica contada; `med_dias.meias` = a recontagem; os dias que o operador nao
 *                publicou com `ent_mw` = `med_mw`;
 *              · o CORTE fica do operador: o `ent_mw` das linhas do operador e a verificada dele (o arquivo mensal, r2), nunca o medidor;
 *              · a irradiancia (`irr_fonte` datalogger): cada `irr` da serie diaria e cada `irr_media` mensal refeitos aqui do
 *                estacao_logger_30min;
 *              · plantios em copias do produto: o medidor deslocado uma meia hora, o medidor no lugar da verificada (e o contrario), a
 *                irradiancia de outra fonte, a marca ausente.
 *              Duas safras: o arquivo do operador ou do datalogger regravado DEPOIS do executivo e divergente vira "nao julgado" (dito);
 *              o arquivo do medidor (lido pela copia condicional, sem data de gravacao) divergente reprova (D-2 e D-4 ja estao fechados).
 *              Linha do operador sem verificada no arquivo (celula vazia) nao e julgada: vazio e ausente, nunca zero.
 *   --diario   (depois do arquivador, no way2-hist.yml) no way2_daily publicado: o ULTIMO dia tem o campo e e recontado aqui do
 *              arquivo de 5 min (os onze picos, as horas, o pico e a hora do conjunto); em todo dia com o campo, contrato <= soma dos picos das usinas e >= o maior pico de usina
 *              menos o maior consumo instantaneo do conjunto; plantios (contrato = soma dos picos; usina pela maior hora). Enquanto o
 *              historico nao foi recalculado, o ensaio DECLARA quantos dias tem o campo (modo transicao) em vez de reprovar.
 * Folgas (contas): MW publicado a 2 casas (perfil) -> 0,005 + 1e-9; a 3 casas (diario) -> 0,0005 + 1e-9; W/m2 a 2 casas -> 0,005 + 1e-9.
 *   Consumo instantaneo maximo do conjunto: 2,494 MW (400 dias, CLAUDE.md do pipeline) -> CONSUMO_MAX = 2,5.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib'), Module = require('module');
const LD = require('./lib-le-dados');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const LIB = path.join(__dirname, 'lib-fontes-exec.js'), ARQ = path.join(__dirname, 'gen-way2-hist.js');
const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML = ['M1', 'M7', 'M9'];
const CAP = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };
const U9 = Object.keys(CIRC), ENTS = U9.concat(['Complexo']);
const TOL2 = 0.005 + 1e-9, TOL3 = 0.0005 + 1e-9, CONSUMO_MAX = 2.5;
const r2 = (v) => Math.round(v * 100) / 100;
const falhas = [], declara = [];
const ok = (c, m) => { if (!c) falhas.push(m); return !!c; };

/* ── o tempo por rotulo ESCRITO (independente da lib): o rotulo i (1..288) do dia e 00:05 x i; o 288 e '<dia+1>T00:00:00' ── */
const pad = (n) => String(n).padStart(2, '0');
const diaMais = (d, k) => new Date(Date.parse(d + 'T12:00:00Z') + k * 864e5).toISOString().slice(0, 10);
const rotulo = (dia, i) => (i === 288 ? diaMais(dia, 1) + 'T00:00:00' : dia + 'T' + pad(Math.floor((5 * i) / 60)) + ':' + pad((5 * i) % 60) + ':00');
const hDe = (s) => s / 2;

/* um arquivo do medidor forjado: valor(pid, i) -> kW ou null; 25 pontos */
function forja(dia, valor) {
  const pids = [6196, 6197].concat(Object.values(CIRC).flat(), [6233]);
  return { dataInicio: dia + 'T00:00:00', dados: pids.map((p) => ({ pontoId: p, nomeGrandeza: 'Demat',
    valores: Array.from({ length: 288 }, (_, k) => ({ data: rotulo(dia, k + 1), valor: valor(p, k + 1) })) })) };
}
/* SEGUNDA ROTA, a meia hora s de um ponto: os rotulos 6s+1 ... 6s+6, todos presentes */
function meiaRef(mapa, dia, s) {
  let t = 0;
  for (let i = 6 * s + 1; i <= 6 * s + 6; i++) { const v = mapa.get(rotulo(dia, i)); if (v == null) return null; t += v; }
  return t / 6;
}
function mapas(hist) {
  const m = new Map();
  for (const x of (hist && hist.dados) || []) if (x.nomeGrandeza === 'Demat') { const o = new Map(); for (const v of x.valores || []) if (v.valor != null && v.valor !== '' && isFinite(+v.valor)) o.set(String(v.data).slice(0, 19), +v.valor); m.set(x.pontoId, o); }
  return m;
}
function meiaEnt(M, dia, s, e) {
  const ps = e === 'Complexo' ? [6233] : CIRC[e];
  let t = 0; for (const p of ps) { const v = meiaRef(M.get(p) || new Map(), dia, s); if (v == null) return null; t += v; }
  return t / 1000;
}
/* SEGUNDA ROTA, o pico: o maior rotulo com todos os circuitos da entidade */
function picoRef(M, dia, ps) {
  let mx = null;
  for (let i = 1; i <= 288; i++) { const r = rotulo(dia, i); let t = 0, todos = true;
    for (const p of ps) { const v = (M.get(p) || new Map()).get(r); if (v == null) { todos = false; break; } t += v; }
    if (todos && (!mx || t > mx.kw)) mx = { kw: t, hora: i === 288 ? '24:00' : r.slice(11, 16) }; }
  return mx ? { mw: mx.kw / 1000, hora: mx.hora } : null;
}
const psDe = (e) => (e === 'Complexo' ? [6233] : e === 'PPA' ? PPA.flatMap((u) => CIRC[u]) : e === 'ML' ? ML.flatMap((u) => CIRC[u]) : CIRC[e]);

/* a lib (ou o arquivador) compilada do texto, com uma troca plantada; o require interno dela continua resolvendo no repositorio */
function compila(arq, de, para, extra) {
  let src = fs.readFileSync(arq, 'utf8').replace(/\r\n/g, '\n');
  if (de != null) { if (src.split(de).length !== 2) throw new Error('plantio: o trecho nao casa uma vez em ' + path.basename(arq) + ': ' + de.slice(0, 80)); src = src.replace(de, para); }
  if (extra) src = extra(src);
  const m = new Module(arq, module); m.filename = arq; m.paths = Module._nodeModulePaths(path.dirname(arq));
  m._compile(src, arq);
  return m.exports;
}

/* ═════════════════════════════ --lib ═════════════════════════════ */
const D1 = '2026-01-10';
/* dia A: cada circuito vale i x (pid - 6190) kW no rotulo i; o 6233 e a soma dos 22; o 6201 sem o rotulo 10 (M2 perde a meia hora 1);
   o 6198 com +10000 kW no rotulo 100 e o 6199 sem o 100 (instante incompleto do M1); o M2 com +3000 kW no 120 nos dois circuitos e o
   M3 com +3000 kW no 130 nos tres (picos do PPA em instantes diferentes); o 6233 com +50000 kW no 200 (16:40), um instante que NENHUMA
   usina e nenhum contrato tem como pico (o pico do conjunto tem hora propria). As usinas lineares (M4..M9) tem o pico no 288 = '24:00'. */
function valorA(p, i) {
  if (p === 6201 && i === 10) return null;
  if (p === 6199 && i === 100) return null;
  const base = (q) => i * (q - 6190) + (q === 6198 && i === 100 ? 10000 : 0) + ((q === 6201 || q === 6202) && i === 120 ? 3000 : 0)
    + ((q === 6203 || q === 6204 || q === 6205) && i === 130 ? 3000 : 0);
  if (p === 6233) { let t = 0; for (const q of Object.values(CIRC).flat()) { if ((q === 6201 && i === 10) || (q === 6199 && i === 100)) continue; t += base(q); } return t + (i === 200 ? 50000 : 0); }
  if (p === 6196 || p === 6197) return i;
  return base(p);
}
/* o datalogger forjado: 10 e 11/01/2026 e 01/02/2026; e<n> = 100 x n (+10 no dia 2) de 06:00 a 17:30 (24 meias horas), 3 W/m2 nas outras
   (abaixo do limiar) e 5,0 exato as 05:30 (nao entra: o limiar e estrito); no dia 2 o M5 sem 10 meias horas da noite (dia incompleto);
   em fev/26 o M5 so tem o dia incompleto (o mes do M5 nao existe, e o do PPA e do Complexo tambem nao: tudo-ou-nada no mes) */
function forjaDL() {
  const serie = [];
  for (const [k, dia] of [[0, '2026-01-10'], [1, '2026-01-11'], [1, '2026-02-01']]) for (let s = 0; s < 48; s++) {
    const ms = Date.parse(dia + 'T00:00:00-03:00') + s * 18e5, r = { t: '', ms };
    for (let n = 1; n <= 9; n++) { if (k === 1 && n === 5 && s < 10) continue; r['e' + n] = s >= 12 && s <= 35 ? 100 * n + 10 * k : s === 11 ? 5 : 3; }
    serie.push(r);
  }
  return { rotulo_de_tempo: 'inicio do intervalo, horario de Brasilia', serie };
}
/* os julgamentos da lib (funcoes, para os plantios passarem por elas): cada mensagem leva o PREFIXO da regra, e cada plantio exige o seu */
function julgaMeia(FE) {
  const f = [];
  const hA = forja(D1, valorA), M = mapas(hA);
  const MH = FE.meiasHoras(hA, D1);
  if (MH.size !== 48) f.push('[meia] a lib devolveu ' + MH.size + ' meias horas no dia forjado (48 esperadas)');
  for (let s = 0; s < 48; s++) {
    const k = D1 + 'T' + pad(Math.floor(s / 2)) + ':' + (s % 2 ? '30' : '00'), o = MH.get(k) || {};
    for (const e of ENTS) { const esp = meiaEnt(M, D1, s, e), v = o[e];
      if ((esp == null) !== (v == null) || (esp != null && Math.abs(esp - v) > 1e-9)) { f.push('[meia] ' + k + ' ' + e + ': lib ' + v + ', esperado ' + esp); break; } }
  }
  // leitura vazia nao e zero: o 6215 (M7) com valor '' no rotulo 50 perde a meia hora 08:00
  const hV = forja(D1, (p, i) => (p === 6215 && i === 50 ? '' : valorA(p, i)));
  if ((FE.meiasHoras(hV, D1).get(D1 + 'T04:00') || {}).M7 != null) f.push('[meia] leitura vazia do medidor contou como zero (M7 04:00)');
  return f;
}
function julgaPico(FE, rollup) {
  const f = [];
  const hA = forja(D1, valorA), M = mapas(hA);
  const P = FE.picosDia(hA, D1);
  for (const e of U9.concat(['PPA', 'ML', 'Complexo'])) { const esp = picoRef(M, D1, psDe(e)), v = P[e];
    if (!v || !esp || Math.abs(v.mw - Math.round(esp.mw * 1000) / 1000) > TOL3 || v.hora !== esp.hora) f.push('[pico] ' + e + ': lib ' + JSON.stringify(v) + ', esperado ' + JSON.stringify(esp)); }
  if (!P.Complexo || P.Complexo.hora !== '16:40') f.push('[pico] o do conjunto nao saiu no instante proprio dele, 16:40 (' + (P.Complexo && P.Complexo.hora) + ')');
  if (!P.M4 || P.M4.hora !== '24:00') f.push('[pico] o rotulo da meia-noite seguinte nao saiu 24:00 (M4: ' + (P.M4 && P.M4.hora) + ')');
  if (P.M1 && P.M1.hora === '08:20') f.push('[pico] o do M1 caiu no instante sem o circuito 6199 (08:20)');
  const somaPicos = PPA.reduce((a, u) => a + P[u].mw, 0);
  if (P.PPA && Math.abs(P.PPA.mw - somaPicos) < 1) f.push('[pico] o do PPA saiu igual a soma dos picos das usinas (' + P.PPA.mw + ')');
  // o arquivador publica os mesmos picos, e a hora do conjunto e a dele
  if (rollup) { const R = rollup(hA, D1);
    for (const e of U9.concat(['PPA', 'ML'])) if (!R.ufv_pico_mw || R.ufv_pico_mw[e] !== (P[e] && P[e].mw) || R.ufv_pico_hora[e] !== (P[e] && P[e].hora)) { f.push('[arquivador] ' + e + ' ' + JSON.stringify(R.ufv_pico_mw && R.ufv_pico_mw[e]) + ' x lib ' + JSON.stringify(P[e])); break; }
    const pc = picoRef(M, D1, [6233]);
    if (R.pico_hora !== pc.hora) f.push('[arquivador] pico_hora ' + R.pico_hora + ' (o do 6233 e ' + pc.hora + ')'); }
  return f;
}
function julgaIrrLib(FE) {
  const f = [];
  try { FE.irrIndice({ rotulo_de_tempo: 'fim do intervalo', serie: [] }); f.push('[irr] o datalogger rotulado pelo fim nao estourou'); } catch (e) { /* certo */ }
  const I = FE.irrIndice(forjaDL());
  for (let n = 1; n <= 9; n++) { const v = FE.irrDia(I, '2026-01-10', 'M' + n); if (v == null || Math.abs(v - 100 * n) > TOL2) f.push('[irr] dia 1 M' + n + ': ' + v + ' (esperado ' + 100 * n + ')'); }
  const pond = (us, k) => us.reduce((a, u) => a + (100 * +u.slice(1) + 10 * k) * CAP[u], 0) / us.reduce((a, u) => a + CAP[u], 0);
  const casos = [['PPA', '2026-01-10', pond(PPA, 0)], ['ML', '2026-01-10', pond(ML, 0)], ['Complexo', '2026-01-10', pond(U9, 0)],
    ['M5', '2026-01-11', null], ['PPA', '2026-01-11', null], ['Complexo', '2026-01-11', null], ['ML', '2026-01-11', pond(ML, 1)]];
  for (const [e, d, esp] of casos) { const v = FE.irrDia(I, d, e);
    if ((esp == null) !== (v == null) || (esp != null && Math.abs(v - esp) > TOL2)) f.push('[irr] ' + d + ' ' + e + ': ' + v + ' (esperado ' + esp + ')'); }
  // o mes: o M5 so com o dia 1; o M1 com os dois (24 + 24 meias horas: (100 + 110) / 2); o PPA ponderado pelas medias mensais
  const mesU = (u) => (u === 'M5' ? 100 * 5 : (100 * +u.slice(1) * 24 + (100 * +u.slice(1) + 10) * 24) / 48);
  for (const [e, esp] of [['M5', mesU('M5')], ['M1', mesU('M1')], ['PPA', PPA.reduce((a, u) => a + mesU(u) * CAP[u], 0) / PPA.reduce((a, u) => a + CAP[u], 0)]]) {
    const v = FE.irrMes(I, '2026-01', e); if (v == null || Math.abs(v - esp) > TOL2) f.push('[irr] mes ' + e + ': ' + v + ' (esperado ' + esp + ')'); }
  // fev/26: o M5 sem dia completo -> o mes do M5, do PPA e do Complexo nao existem; o ML existe
  for (const [e, nulo] of [['M5', true], ['PPA', true], ['Complexo', true], ['ML', false]]) {
    const v = FE.irrMes(I, '2026-02', e); if ((v == null) !== nulo) f.push('[irr] mes 2026-02 ' + e + ': ' + v + (nulo ? ' (esperado nulo: o M5 sem dia completo)' : ' (esperado valor)')); }
  // leitura vazia nao e meia hora lida: o e1 '' numa meia hora deixa o dia do M1 incompleto
  const DLv = forjaDL(); DLv.serie[0].e1 = '';
  if (FE.irrDia(FE.irrIndice(DLv), '2026-01-10', 'M1') != null) f.push('[irr] leitura vazia do datalogger contou como meia hora lida');
  return f;
}
const julgaLib = (FE, rollup) => julgaMeia(FE).concat(julgaPico(FE, rollup), julgaIrrLib(FE));
const PICO_SO = process.argv.includes('--pico');   // o way2-hist: so o pico e o arquivador (as regras do executivo nao travam o arquivamento)
function lib() {
  const FE = require(LIB), { rollupDia } = require(ARQ);
  const f = PICO_SO ? julgaPico(FE, rollupDia) : julgaLib(FE, rollupDia);
  f.forEach((x) => falhas.push('lib: ' + x));
  console.log('  ' + (PICO_SO ? 'o pico de 5 min e o arquivador' : 'lib-fontes-exec e rollupDia') + ' sobre os dias forjados: ' + (f.length ? f.length + ' falha(s)' : 'certos'));
  // plantios na lib: [nome, de, para, prefixo da mensagem que TEM de aparecer, so no modo completo]
  const PL = [
    ['o rotulo lido pelo inicio (o perfil antigo)', 'const ini = relogio(rot) - 5 * 60e3;\n  return new Date(Math.floor(ini / 18e5)', 'const ini = relogio(rot);\n  return new Date(Math.floor(ini / 18e5)', '[meia]', 1],
    ['a meia hora com leitura faltando', 'if (a.n === LEITURAS_MEIA) out.set', 'if (a.n >= 1) out.set', '[meia]', 1],
    ['a usina com circuito faltando', 'o[u] = ps.every((p) => porPonto.get(p).has(k)) ? ps.reduce((a, p) => a + porPonto.get(p).get(k), 0) / 1000 : null;',
      'o[u] = ps.some((p) => porPonto.get(p).has(k)) ? ps.reduce((a, p) => a + (porPonto.get(p).get(k) || 0), 0) / 1000 : null;', '[meia]', 1],
    ['a leitura vazia do medidor como zero', "if (v && valido(v.valor)) m.set", "if (v && v.valor != null) m.set", '[meia] leitura vazia', 1],
    ['o pico com instante incompleto (o circuito que falta conta zero)',
      "if (!ps.every((p) => D.get(p).has(rot))) continue;   // instante sem um circuito nao entra (tudo-ou-nada)\n        const kw = ps.reduce((a, p) => a + D.get(p).get(rot), 0);",
      "const kw = ps.reduce((a, p) => a + (D.get(p).get(rot) || 0), 0);", '[pico]', 0],
    ['a noite na media da irradiancia', 'if (+v > LIMIAR_SOL) { a.s += +v; a.n += 1; }', 'if (+v >= 0) { a.s += +v; a.n += 1; }', '[irr]', 1],
    ['o dia incompleto na irradiancia', 'const completo = (a) => !!a && a.meias >= MEIAS_DIA;', 'const completo = (a) => !!a && a.meias >= 1;', '[irr]', 1],
    ['o contrato pela media simples', 'if (v == null) return null; s += v * CAP_UFV[u]; c += CAP_UFV[u]; }\n  return c > 0 ? r2(s / c) : null;\n}\n/* a media do mes da usina',
      'if (v == null) return null; s += v; c += 1; }\n  return c > 0 ? r2(s / c) : null;\n}\n/* a media do mes da usina', '[irr]', 1],
    ['o contrato sem tudo-ou-nada no dia', 'if (v == null) return null; s += v * CAP_UFV[u]; c += CAP_UFV[u]; }\n  return c > 0 ? r2(s / c) : null;\n}\n/* a media do mes da usina',
      'if (v == null) continue; s += v * CAP_UFV[u]; c += CAP_UFV[u]; }\n  return c > 0 ? r2(s / c) : null;\n}\n/* a media do mes da usina', '[irr]', 1],
    ['o contrato sem tudo-ou-nada no mes', 'const m = irrMesUsina(I, mes, u); if (m.v == null) return null;', 'const m = irrMesUsina(I, mes, u); if (m.v == null) continue;', '[irr] mes 2026-02', 1],
    ['a leitura vazia do datalogger como meia hora lida', "const v = r['e' + n]; if (!valido(v)) continue;", "const v = r['e' + n]; if (v == null) continue;", '[irr] leitura vazia', 1],
  ];
  const src = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
  for (const [nome, de, para, pre, soCompleto] of PL) {
    if (PICO_SO && soCompleto) continue;
    if (src.split(de).length !== 2) { falhas.push('plantio "' + nome + '": o trecho nao casa uma vez na lib (a lib mudou: refazer o plantio)'); continue; }
    const X = compila(LIB, de, para);
    const fx = (PICO_SO ? julgaPico(X, null) : julgaLib(X, null)).filter((m) => m.startsWith(pre));
    ok(fx.length > 0, 'plantio "' + nome + '" NAO reprovou pela regra dele (' + pre + ')');
    console.log('  plantio · ' + nome + ': ' + (fx.length ? 'reprova (' + fx[0].slice(0, 90) + ')' : 'NAO reprova'));
  }
  // plantios no arquivador: o pico da usina trocado pelo do conjunto; a hora do conjunto tirada de outra entidade
  for (const [nome, de, para] of [['o arquivador com o pico do conjunto nas usinas', 'ufv_pico_mw[e] = PK[e] ? PK[e].mw : null;', 'ufv_pico_mw[e] = PK.Complexo ? PK.Complexo.mw : null;'],
    ['o arquivador com a hora do conjunto tirada do ML', 'pico_hora: PK.Complexo ? PK.Complexo.hora : null,', 'pico_hora: PK.ML ? PK.ML.hora : null,']]) {
    const s2 = fs.readFileSync(ARQ, 'utf8').replace(/\r\n/g, '\n');
    if (s2.split(de).length !== 2) { falhas.push('plantio "' + nome + '": o trecho nao casa uma vez no arquivador'); continue; }
    const X = compila(ARQ, de, para); const fx = julgaPico(require(LIB), X.rollupDia).filter((m) => m.startsWith('[arquivador]'));
    ok(fx.length > 0, 'plantio "' + nome + '" NAO reprovou');
    console.log('  plantio · ' + nome + ': ' + (fx.length ? 'reprova (' + fx[0].slice(0, 80) + ')' : 'NAO reprova'));
  }
  // implementacoes erradas do pico, que o julgamento tem de recusar
  const FE0 = require(LIB);
  const somaDosPicos = Object.assign({}, FE0, { picosDia: (h, d) => { const P = FE0.picosDia(h, d);
    for (const [g, us] of [['PPA', PPA], ['ML', ML]]) P[g] = { mw: Math.round(us.reduce((a, u) => a + P[u].mw, 0) * 1000) / 1000, hora: P[us[0]].hora }; return P; } });
  const maiorHora = Object.assign({}, FE0, { picosDia: (h, d) => { const M = mapas(h), P = {};
    for (const e of U9.concat(['PPA', 'ML', 'Complexo'])) { let mx = null;
      for (let hh = 0; hh < 24; hh++) { let t = 0, n = 0, todos = true;
        for (let i = 12 * hh + 1; i <= 12 * hh + 12; i++) { let s = 0; for (const p of psDe(e)) { const v = M.get(p).get(rotulo(d, i)); if (v == null) { todos = false; break; } s += v; } if (!todos) break; t += s; n++; }
        if (todos && n === 12 && (!mx || t / 12 > mx.kw)) mx = { kw: t / 12, hora: pad(hh) + ':00' }; }
      P[e] = mx ? { mw: Math.round(mx.kw) / 1000, hora: mx.hora } : null; } return P; } });
  for (const [nome, X, pre] of [['o contrato pela soma dos picos das usinas', somaDosPicos, '[pico] PPA'], ['o pico pela maior media de uma hora', maiorHora, '[pico]']]) {
    const fx = julgaPico(X, null).filter((m) => m.startsWith(pre)); ok(fx.length > 0, 'implementacao errada "' + nome + '" NAO reprovou');
    console.log('  plantio · ' + nome + ': ' + (fx.length ? 'reprova (' + fx[0].slice(0, 80) + ')' : 'NAO reprova')); }
  if (PICO_SO) return;
  // o gerador usa a lib (o produto prova o resto): a meia hora antiga saiu e o mapa e conferido contra a lib
  const gen = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8').replace(/\r\n/g, '\n');
  ok(!gen.includes("(mi < 30 ? '00' : '30')"), 'o gen-executivo ainda tem a meia hora pelo rotulo do medidor (mi < 30)');
  ok(gen.includes('FE.meiasHoras(hist, dia)') && gen.includes('FE.irrIndice(') && gen.includes('irrDiaDL(d, u)'), 'o gen-executivo nao chama a lib-fontes-exec nos tres lugares');
}

/* ═════════════════════════════ leitura ═════════════════════════════ */
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
async function pega(nome) {
  if (!/^https?:/.test(BASE)) { const f = path.join(BASE, nome); return fs.existsSync(f) ? { j: deJson(fs.readFileSync(f)), mod: fs.statSync(f).mtime.toISOString() } : null; }
  // 💰 o arquivo do medidor pela leitura condicional (lib-le-blob): no job, com CACHE_BLOB_DIR, a copia que o gerador acabou de usar vale
  //    (304 sem corpo) — o ensaio nao baixa de novo ~8 MB por rodada
  const LB = require('./lib-le-blob');
  if (/^https?:/.test(BASE) && LB.ALVO.test(BASE + nome)) { const b = await LB.bytes(BASE + nome, { 'accept-encoding': 'gzip' }); return b == null ? null : { j: deJson(b), mod: null }; }
  const r = await LD.pede(BASE + nome, { 'accept-encoding': 'gzip' });
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error('HTTP ' + r.status + ' em ' + nome);
  return { j: deJson(r.buf), mod: r.ultimaMod ? new Date(r.ultimaMod).toISOString() : null };
}
/* o produto: LOCAL_OUT (o arquivo do gerador e os irmaos <base>.<nome>) ou o blob */
async function produto(nome) {
  const lo = process.env.LOCAL_OUT;
  if (lo) { const f = nome === 'executivo.json' ? lo : lo.replace(/\.json$/, '') + '.' + nome; return deJson(fs.readFileSync(f)); }
  const x = await pega(nome); if (!x) throw new Error(nome + ' nao existe'); return x.j;
}

/* ═════════════════════════════ --produto ═════════════════════════════ */
function julgaPerfil(P, hists, ons) {
  const f = [];
  if (P.med_fonte !== 'medidor_5min' || !P.med_dias) { f.push('perfil sem a marca med_fonte/med_dias'); return { f, n: 0 }; }
  const semCampo = P.perfil.filter((x) => !('med_mw' in x)).length;
  if (semCampo) f.push(semCampo + ' linha(s) do perfil sem med_mw');
  const idx = new Map(P.perfil.map((x) => [x.dia + '|' + x.h + '|' + x.ufv, x]));
  // `n` conta so a comparacao NUMERICA (os dois lados com valor): nulo com nulo nao julga nada. Por dia, o numero de meias horas com as
  // dez entidades recontadas tem de ser o `med_dias[dia].meias` publicado e cobrir pelo menos 40 das 48 (a cobertura real dos dias)
  let n = 0;
  for (const [dia, h] of hists) {
    const M = mapas(h); let cheias = 0, nDia = 0;
    for (let s = 0; s < 48; s++) { let todas = true;
      for (const e of ENTS) {
        const esp = meiaEnt(M, dia, s, e), x = idx.get(dia + '|' + hDe(s) + '|' + e), v = x ? x.med_mw : undefined;
        if (esp == null) todas = false;
        if (esp == null && v == null) continue;
        if (esp == null || v == null || Math.abs(v - esp) > TOL2) { f.push('med_mw ' + dia + ' ' + hDe(s) + 'h ' + e + ': publicado ' + v + ', recontado ' + (esp == null ? null : esp.toFixed(3))); if (f.length > 6) return { f, n }; continue; }
        n++; nDia++;
      }
      if (todas) cheias++; }
    const md = P.med_dias[dia] || {};
    if (md.meias !== cheias) f.push('med_dias ' + dia + ': publicado ' + md.meias + ' meias horas, recontadas ' + cheias);
    if (cheias < 40 || nDia < 40 * ENTS.length) f.push('o medidor de ' + dia + ' recontado tem so ' + cheias + ' meias horas inteiras (' + nDia + ' valores): formato do arquivo mudou?');
  }
  // o dia so do medidor (o operador nao publicou): ent_mw = med_mw
  for (const x of P.perfil) if (x.fonte === 'way2' && x.ent_mw !== x.med_mw) { f.push('dia so do medidor ' + x.dia + ' ' + x.h + 'h ' + x.ufv + ': ent_mw ' + x.ent_mw + ' x med_mw ' + x.med_mw); break; }
  // o corte fica do operador: ent_mw das linhas dele = a verificada do arquivo mensal
  let nOns = 0, difOns = 0, exOns = '';
  if (ons) for (const x of P.perfil) {
    if (x.fonte || !U9.includes(x.ufv) || x.ent_mw == null) continue;
    const g = ons.get(x.dia + '|' + x.h + '|' + x.ufv); if (g == null) continue;
    nOns++; if (Math.abs(x.ent_mw - r2(g)) > TOL2) { difOns++; if (!exOns) exOns = x.dia + ' ' + x.h + 'h ' + x.ufv + ' ent_mw ' + x.ent_mw + ' x verificada ' + r2(g); }
  }
  return { f, n, nOns, difOns, exOns };
}
/* SEGUNDA ROTA da irradiancia: o datalogger por codigo proprio */
function irrRef(DL) {
  const D = new Map();   // dia -> u -> { s, n, meias }
  for (const r of DL.serie) { const d = new Date(r.ms - 3 * 3600e3).toISOString().slice(0, 10); const o = D.get(d) || {};
    for (const u of U9) { const v = r['e' + u.slice(1)]; if (typeof v !== 'number' || !isFinite(v)) continue; const a = o[u] || (o[u] = { s: 0, n: 0, meias: 0 }); a.meias++; if (v > 5) { a.s += v; a.n++; } }
    D.set(d, o); }
  const mem = (e) => (e === 'Complexo' ? U9 : e === 'PPA' ? PPA : e === 'ML' ? ML : [e]);
  const diaU = (d, u) => { const a = (D.get(d) || {})[u]; return a && a.meias >= 48 && a.n > 0 ? a.s / a.n : null; };
  const dia = (d, e) => { const us = mem(e); if (us.length === 1) return diaU(d, us[0]); let s = 0, c = 0; for (const u of us) { const v = diaU(d, u); if (v == null) return null; s += v * CAP[u]; c += CAP[u]; } return s / c; };
  const mesU = (m, u) => { let s = 0, n = 0; for (const [d, o] of D) if (d.slice(0, 7) === m && o[u] && o[u].meias >= 48) { s += o[u].s; n += o[u].n; } return n ? s / n : null; };
  const mes = (m, e) => { let s = 0, c = 0; for (const u of mem(e)) { const v = mesU(m, u); if (v == null) return null; s += v * CAP[u]; c += CAP[u]; } return s / c; };
  return { dia, mes };
}
function julgaIrr(E, R) {
  const f = []; let n = 0;
  if (E.irr_fonte !== 'datalogger') { f.push('executivo sem irr_fonte datalogger (' + E.irr_fonte + ')'); return { f, n }; }
  // o publicado (2 casas) contra o refeito SEM arredondar: folga = meia casa (TOL2); so a comparacao numerica conta
  const cmp = (o, esp, onde) => {
    if ((esp == null) !== (o == null) || (esp != null && Math.abs(o - esp) > TOL2)) { f.push(onde + ': publicado ' + o + ', refeito ' + esp); return false; } if (esp != null) n++; return true; };
  for (const x of E.serie_dia_ufv || []) { if (x.liq_mwh == null && x.irr == null) continue; if (!cmp(x.irr, R.dia(x.dia, x.ufv), 'irr ' + x.dia + ' ' + x.ufv) && f.length > 6) break; }
  for (const x of E.serie_ufv || []) if (!cmp(x.irr_media, R.mes(x.mes, x.ufv), 'irr_media ' + x.mes + ' ' + x.ufv) && f.length > 12) break;
  for (const x of E.serie || []) if (!cmp(x.irr_media, R.mes(x.mes, 'Complexo'), 'serie irr_media ' + x.mes) && f.length > 14) break;
  return { f, n };
}
async function prod() {
  const P = await produto('perfil_dia.json'), E = await produto('executivo.json');
  const geradoP = P.gerado_em, geradoE = E.gerado_em;
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  // D-2 e RELIDO na rodada; D-4 e o primeiro dia REAPROVEITADO do perfil publicado anterior (o modo normal da acumulacao). Os dois ainda
  // estao na copia em disco do job (lib-le-blob): 304 sem corpo
  const dias = [diaMais(hoje, -2), diaMais(hoje, -4)].filter((d) => P.med_dias && P.med_dias[d] && P.med_dias[d].lido === 1);
  const hists = [];
  for (const d of dias) { const x = await pega('hist/way2_' + d + '.json'); if (!x) { declara.push('sem o arquivo do medidor de ' + d); continue; }
    if (x.mod && geradoP && x.mod > geradoP) declara.push('o arquivo do medidor de ' + d + ' foi regravado depois do perfil (' + x.mod + ')');
    hists.push([d, x.j]); }
  ok(hists.length === 2, 'a segunda rota precisa de D-2 (relido) e D-4 (reaproveitado): julgou ' + hists.map((h) => h[0]).join(', '));
  // a verificada do operador, por usina e meia hora, do arquivo mensal dos dias julgados (e de todo o perfil)
  const ons = new Map(); let onsMod = null;
  for (const m of [...new Set(P.perfil.map((x) => x.dia.slice(0, 7)))]) {
    const x = await pega('ons_irradiancia_' + m.replace('-', '_') + '.json'); if (!x) continue; if (x.mod && (!onsMod || x.mod > onsMod)) onsMod = x.mod;
    for (const r of x.j.consolidado || []) { const ts = String(r.ts), d = ts.slice(0, 10), h = +ts.slice(11, 13) + (+ts.slice(14, 16) >= 30 ? 0.5 : 0);
      if (r.gv == null || String(r.gv).trim() === '') continue;   // celula vazia do operador e AUSENTE, nao zero
      const v = parseFloat(String(r.gv).replace(',', '.')); if (isFinite(v)) ons.set(d + '|' + h + '|' + String(r.u).replace('CEFMT', 'M'), v); }
  }
  const J = julgaPerfil(P, hists, ons);
  J.f.forEach((x) => falhas.push('perfil: ' + x));
  ok(J.n >= 480 * hists.length, 'perfil: so ' + J.n + ' linhas julgadas na segunda rota');
  if (J.difOns) { if (onsMod && geradoP && onsMod > geradoP) declara.push('verificada: ' + J.difOns + ' de ' + J.nOns + ' linhas divergem e o arquivo do operador foi regravado depois do perfil — nao julgado (' + J.exOns + ')');
    else falhas.push('o ent_mw (a verificada do operador, termo do corte) diverge do arquivo do operador em ' + J.difOns + ' de ' + J.nOns + ' linhas: ' + J.exOns); }
  ok(J.nOns > 0, 'nenhuma linha do operador julgada contra a verificada');
  console.log('  perfil: segunda rota no medidor em ' + hists.map((h) => h[0]).join(', ') + ' (' + J.n + ' linhas) · verificada do operador em ' + J.nOns + ' linhas' + (J.difOns ? ' (' + J.difOns + ' divergem)' : ''));
  // a irradiancia
  const DLx = await pega('estacao_logger_30min.json'); ok(!!DLx, 'sem o estacao_logger_30min para refazer a irradiancia');
  if (DLx) { const R = irrRef(DLx.j), I = julgaIrr(E, R);
    if (I.f.length) { if (DLx.mod && geradoE && DLx.mod > geradoE) declara.push('irradiancia: ' + I.f.length + ' divergencia(s) e o datalogger foi regravado depois do executivo — nao julgado (' + I.f[0] + ')');
      else I.f.forEach((x) => falhas.push('irradiancia: ' + x)); }
    ok(I.n > 100, 'irradiancia: so ' + I.n + ' valores julgados');
    console.log('  irradiancia: ' + I.n + ' valores do executivo refeitos do datalogger' + (I.f.length ? ' · ' + I.f.length + ' divergencia(s)' : ''));
    // plantios no produto
    const copia = (o) => JSON.parse(JSON.stringify(o));
    const pl = [];
    { const Q = copia(P), ix = new Map(Q.perfil.map((x) => [x.dia + '|' + x.h + '|' + x.ufv, x])); let m = 0;
      for (const x of Q.perfil) { const y = ix.get(x.dia + '|' + (x.h + 0.5) + '|' + x.ufv); if (y && x.med_mw !== y.med_mw) { x.med_mw = y.med_mw; m++; } }
      pl.push(['o medidor deslocado uma meia hora', m, julgaPerfil(Q, hists, ons).f.length > 0]); }
    { const Q = copia(P); let m = 0; for (const x of Q.perfil) if (!x.fonte && x.ent_mw != null && x.med_mw !== x.ent_mw) { x.med_mw = x.ent_mw; m++; }
      pl.push(['a verificada do operador no lugar do medidor', m, julgaPerfil(Q, hists, ons).f.length > 0]); }
    { const Q = copia(P); let m = 0; for (const x of Q.perfil) if (!x.fonte && x.med_mw != null && x.med_mw !== x.ent_mw) { x.ent_mw = x.med_mw; m++; }
      const j = julgaPerfil(Q, hists, ons); pl.push(['o medidor no lugar da verificada (o corte trocado)', m, j.difOns > 0]); }
    { const Q = copia(P); delete Q.med_fonte; pl.push(['o perfil sem a marca', 1, julgaPerfil(Q, hists, ons).f.length > 0]); }
    { const F = copia(E); let m = 0; for (const x of F.serie_dia_ufv) if (x.irr != null) { x.irr = r2(x.irr + 10); m++; }
      pl.push(['a irradiancia de outra fonte (10 W/m2 acima)', m, julgaIrr(F, R).f.length > 0]); }
    { const F = copia(E); delete F.irr_fonte; pl.push(['o executivo sem a marca da irradiancia', 1, julgaIrr(F, R).f.length > 0]); }
    for (const [nome, m, rep] of pl) { ok(m > 0, 'plantio "' + nome + '" nao mudou nada no produto'); ok(rep, 'plantio "' + nome + '" NAO reprovou');
      console.log('  plantio · ' + nome + ' (' + m + ' valores): ' + (rep ? 'reprova' : 'NAO reprova')); }
  }
}

/* ═════════════════════════════ --diario ═════════════════════════════ */
function julgaDiario(W, hist, diaH) {
  const f = []; let n = 0;
  const com = W.dias.filter((x) => x.ufv_pico_mw);
  for (const x of com) {
    const p = x.ufv_pico_mw; n++;
    for (const [g, us] of [['PPA', PPA], ['ML', ML]]) {
      if (p[g] == null || us.some((u) => p[u] == null)) continue;
      const soma = us.reduce((a, u) => a + p[u], 0), mx = Math.max(...us.map((u) => p[u]));
      if (p[g] > soma + TOL3 * (us.length + 1)) f.push(x.dia + ' ' + g + ': pico ' + p[g] + ' acima da soma dos picos ' + soma.toFixed(3));
      if (p[g] < mx - CONSUMO_MAX) f.push(x.dia + ' ' + g + ': pico ' + p[g] + ' abaixo do maior pico de usina ' + mx + ' menos o consumo maximo');
    }
    if (x.pico_mw != null && p.PPA != null && p.ML != null && x.pico_mw < Math.max(p.PPA, p.ML) - CONSUMO_MAX) f.push(x.dia + ': pico do conjunto ' + x.pico_mw + ' abaixo do pico de um contrato');
    if (f.length > 8) break;
  }
  if (hist) { const x = W.dias.find((d) => d.dia === diaH), M = mapas(hist);
    if (!x || !x.ufv_pico_mw) f.push('o dia ' + diaH + ' sem ufv_pico_mw');
    else { for (const e of U9.concat(['PPA', 'ML'])) { const esp = picoRef(M, diaH, psDe(e));
        if (!esp || x.ufv_pico_mw[e] == null || Math.abs(x.ufv_pico_mw[e] - esp.mw) > TOL3 || x.ufv_pico_hora[e] !== esp.hora) f.push(diaH + ' ' + e + ': publicado ' + x.ufv_pico_mw[e] + ' ' + x.ufv_pico_hora[e] + ', recontado ' + JSON.stringify(esp)); }
      const pc = picoRef(M, diaH, [6233]);
      if (!pc || x.pico_hora !== pc.hora || Math.abs(x.pico_mw - pc.mw) > TOL3) f.push(diaH + ' Complexo: publicado ' + x.pico_mw + ' ' + x.pico_hora + ', recontado ' + JSON.stringify(pc)); } }
  return { f, n, com: com.length };
}
async function diario() {
  const W = await produto('way2_daily.json');
  // o ULTIMO dia do arquivo (o que o arquivador acabou de gravar) TEM de ter o campo: julgar o ultimo dia COM o campo deixaria passar a
  // rodada que manteve a linha velha
  const ult = W.dias.map((x) => x.dia).sort().pop(), xu = W.dias.find((x) => x.dia === ult) || {};
  ok(!!xu.ufv_pico_mw, 'o ultimo dia do way2_daily (' + ult + ') nao tem ufv_pico_mw (o arquivador novo nao gravou)');
  if (!xu.ufv_pico_mw) return;
  const hx = await pega('hist/way2_' + ult + '.json'); ok(!!hx, 'sem o arquivo do medidor de ' + ult);
  const J = julgaDiario(W, hx && hx.j, ult);
  J.f.forEach((x) => falhas.push('diario: ' + x));
  const desde = W.dias.filter((x) => x.dia >= '2025-09-01').length;
  if (J.com < desde) declara.push('MODO TRANSICAO: ' + J.com + ' de ' + desde + ' dias desde set/25 com o pico de 5 min por usina (o historico ainda nao foi recalculado pelo arquivador)');
  console.log('  diario: ' + J.n + ' dias julgados · ' + ult + ' recontado do arquivo de 5 min');
  const copia = (o) => JSON.parse(JSON.stringify(o));
  const pl = [];
  { const Q = copia(W), x = Q.dias.find((d) => d.dia === ult); const ant = x.pico_hora; x.pico_hora = x.ufv_pico_hora.ML === ant ? '03:00' : x.ufv_pico_hora.ML;
    pl.push(['a hora do conjunto tirada de outra entidade', ant !== x.pico_hora, julgaDiario(Q, hx.j, ult).f.some((m) => /Complexo/.test(m))]); }
  { const Q = copia(W), x = Q.dias.find((d) => d.dia === ult); const ant = x.ufv_pico_mw.PPA; x.ufv_pico_mw.PPA = Math.round(PPA.reduce((a, u) => a + x.ufv_pico_mw[u], 0) * 1000) / 1000;
    pl.push(['o contrato pela soma dos picos', ant !== x.ufv_pico_mw.PPA, julgaDiario(Q, hx.j, ult).f.length > 0]); }
  { const Q = copia(W), x = Q.dias.find((d) => d.dia === ult), M = mapas(hx.j); let mx = -Infinity;
    for (let hh = 0; hh < 24; hh++) { let t = 0, n = 0; for (let i = 12 * hh + 1; i <= 12 * hh + 12; i++) { let s = 0, todos = true; for (const p of CIRC.M1) { const v = M.get(p).get(rotulo(ult, i)); if (v == null) { todos = false; break; } s += v; } if (todos) { t += s; n++; } } if (n === 12) mx = Math.max(mx, t / 12000); }
    const ant = x.ufv_pico_mw.M1; x.ufv_pico_mw.M1 = Math.round(mx * 1000) / 1000;
    pl.push(['a usina pela maior media de uma hora', ant !== x.ufv_pico_mw.M1, julgaDiario(Q, hx.j, ult).f.length > 0]); }
  for (const [nome, mudou, rep] of pl) { ok(mudou, 'plantio "' + nome + '" nao mudou nada'); ok(rep, 'plantio "' + nome + '" NAO reprovou');
    console.log('  plantio · ' + nome + ': ' + (rep ? 'reprova' : 'NAO reprova')); }
}

(async () => {
  const modo = process.argv.includes('--produto') ? 'produto' : process.argv.includes('--diario') ? 'diario' : 'lib';
  console.log('ensaio-fontes-exec · modo ' + modo);
  if (modo === 'lib') lib(); else if (modo === 'produto') await prod(); else await diario();
  declara.forEach((x) => console.log('  ⚠️ ' + x));
  if (falhas.length) { console.error('✗ ' + falhas.length + ' falha(s):'); falhas.slice(0, 40).forEach((x) => console.error('   ' + x)); process.exit(1); }
  console.log('✓ ensaio-fontes-exec (' + modo + ') aprovado');
})().catch((e) => { console.error('✗ ensaio-fontes-exec: ' + (e && e.stack || e)); process.exit(1); });
