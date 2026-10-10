'use strict';
/*
 * ensaio-estacao-logger.js — a leitura do datalogger das estacoes e a meia hora (lib-estacao-logger.js), sem rede
 * (10/10/2026, PROMOVER estacao-logger).
 *
 * Julga a lib num arquivo CSIXML montado aqui, com os campos FORA da ordem real (o campo da irradiancia nao esta na 22a
 * posicao), um valor NAN, um registro faltando numa meia hora e o mesmo instante em dois arquivos:
 *   · o campo e lido pelo NOME;
 *   · a meia hora T e a media de T+10, T+20 e T+30 (rotulo no fim) e some quando falta um dos tres;
 *   · M10 vira a usina 1; `_duplicados/` e a tabela de 3 s ficam fora;
 * e PROVA que mede: cada um de tres defeitos plantados (rotulo no inicio, campo pela posicao 22, M10 como usina 10) tem de
 * reprovar. Plantio que passa derruba o ensaio.
 *
 *    node scripts/ensaio-estacao-logger.js
 */
const L = require('./lib-estacao-logger');

const CAMPOS = ['AmbTemp_Avg', 'RelH_Avg', 'Irr_Up_Avg', 'Irr_Tilted_1_Avg', 'Irr_Down_Avg'];   // a irradiancia no plano e a 4a
function arquivo(linhas) {
  return '<?xml version="1.0" standalone="yes"?>\n<csixml version="1.0">\n<head>\n<fields>\n'
    + CAMPOS.map((c) => '<field name="' + c + '" type="xsd:float" units="x" process="Avg"/>').join('\n')
    + '\n</fields>\n</head>\n<data>\n'
    + linhas.map(([t, irr], i) => '<r time="' + t + ':00" no="' + i + '">' + CAMPOS.map((c, k) => '<v' + (k + 1) + '>' + (c === 'Irr_Tilted_1_Avg' ? irr : (k * 11 + 7)) + '</v' + (k + 1) + '>').join('') + '</r>').join('\n')
    + '\n</data>\n</csixml>\n';
}
// 10:00 = media de 10:10, 10:20, 10:30 = 200; 10:30 perde o 10:50 (NAN) -> some; 11:00 = media de 11:10, 11:20, 11:30 = 600
const A = arquivo([['2026-10-08T10:10', 100], ['2026-10-08T10:20', 200], ['2026-10-08T10:30', 300],
  ['2026-10-08T10:40', 400], ['2026-10-08T10:50', 'NAN'], ['2026-10-08T11:00', 500],
  ['2026-10-08T11:10', 500], ['2026-10-08T11:20', 600], ['2026-10-08T11:30', 700]]);

function julga(lib) {
  const f = [];
  const ok = (c, m) => { if (!c) f.push(m); };
  let reg = [];
  try { reg = lib.leArquivo(A); } catch (e) { f.push('leArquivo estourou: ' + e.message); }
  ok(reg.length === 8, 'leArquivo: 8 registros validos (o NAN fora), veio ' + reg.length);
  ok(reg.length && reg[0][1] === 100 && reg[0][0] === '2026-10-08T10:10', 'leArquivo: o primeiro registro e 10:10 = 100 (campo pelo nome), veio ' + JSON.stringify(reg[0]));
  const mh = lib.meiasHoras(reg);
  ok(mh.get('2026-10-08T10:00') === 200, 'meia hora 10:00 = media de 10:10, 10:20, 10:30 = 200, veio ' + mh.get('2026-10-08T10:00'));
  ok(!mh.has('2026-10-08T10:30'), 'meia hora 10:30 sem o 10:50 tem de sumir (tudo-ou-nada)');
  ok(mh.get('2026-10-08T11:00') === 600, 'meia hora 11:00 = 600, veio ' + mh.get('2026-10-08T11:00'));
  // o mesmo registro repetido nao entra duas vezes na media
  const dup = lib.meiasHoras(reg.concat([['2026-10-08T10:20', 200]]));
  ok(dup.get('2026-10-08T10:00') === 200, 'registro repetido nao muda a media, veio ' + dup.get('2026-10-08T10:00'));
  ok(lib.usinaDoArquivo('Estacao_Meteorologica_Logger/2026/10 - OUTUBRO/M10/CRD_M10_Data_10m_2026-10-08.dat') === 1, 'M10 e a usina 1');
  ok(lib.usinaDoArquivo('Estacao_Meteorologica_Logger/2026/10 - OUTUBRO/M9/CRD_M09_Data_10m_Day398.dat') === 9, 'nome antigo DayNNN do M9 e a usina 9');
  ok(lib.usinaDoArquivo('Estacao_Meteorologica_Logger/_duplicados/CRD_M02_Data_10m_Day1.dat') === null, '_duplicados fica fora');
  ok(lib.usinaDoArquivo('Estacao_Meteorologica_Logger/2026/09 - SETEMBRO/M2/CRD_M02_Data_3s_Day3.dat') === null, 'a tabela de 3 s fica fora');
  let sem = null;
  try { lib.leArquivo(A.replace(/Irr_Tilted_1_Avg/g, 'Irr_X')); } catch (e) { sem = e; }
  ok(sem, 'arquivo sem o campo tem de estourar');
  return f;
}

// os tres defeitos plantados
const P = {
  'rotulo no inicio': Object.assign({}, L, { meiasHoras: (reg) => {
    const g = new Map(); for (const [t, x] of reg) { const ini = L.minutos(t); const T = ini - (ini % 30); const o = g.get(T) || []; o.push(x); g.set(T, o); }
    const out = new Map(); for (const [T, o] of g) if (o.length === 3) out.set(L.instante(T), o.reduce((a, b) => a + b, 0) / 3); return out; } }),
  'campo pela posicao 22': Object.assign({}, L, { leArquivo: (txt) => {
    const out = []; const re = /<r time="(\d{4}-\d\d-\d\dT\d\d:\d\d)[^"]*"[^>]*>([\s\S]*?)<\/r>/g; let m;
    while ((m = re.exec(txt))) { const v = /<v22>([^<]*)<\/v22>/.exec(m[2]) || /<v1>([^<]*)<\/v1>/.exec(m[2]); const x = Number(v && v[1]); if (Number.isFinite(x)) out.push([m[1], x]); } return out; } }),
  'M10 como usina 10': Object.assign({}, L, { usinaDoArquivo: (n) => { const m = /CRD_M(\d+)_Data_10m_/.exec(n); return m && !/_duplicados/.test(n) ? +m[1] : null; } }),
};

const f = julga(L);
let falhou = f.length > 0;
console.log(f.length ? f.map((x) => '  FALHA: ' + x).join('\n') : '  a lib passa (' + 11 + ' conferencias)');
for (const [nome, lib] of Object.entries(P)) {
  const fp = julga(lib);
  console.log('  plantio "' + nome + '": ' + (fp.length ? 'reprova (' + fp[0] + ')' : 'PASSOU — o ensaio nao mede este defeito'));
  if (!fp.length) falhou = true;
}
if (falhou) { console.error('ensaio-estacao-logger: REPROVADO'); process.exit(1); }
console.log('ensaio-estacao-logger: TUDO PASSOU');
