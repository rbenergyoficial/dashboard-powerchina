/*
 * ensaio-ppc-rdo.js — o PPC pelo RDO do SIGO (gen-ppc-rdo.js), sem rede: casos montados.
 *   1. a liberação vale a potência plena e LIVRE; a ordem e a alteração valem o limite, com o código do motivo; a herdada entra às 00:00;
 *   2. o resumo por dia é o da lib (lib-ppc.resumoDias), o mesmo da planilha;
 *   3. o comparativo: "bate" com a planilha igual (até 5 min e 0,5 MW); "diverge" com a ordem que a planilha não tem e o valor trocado,
 *      listando os dois lados; "so_rdo" sem o dia na planilha; a herdada fica fora;
 *   4. o arquivo do Gestão sem nome de pessoa chega sem técnico, e o evento não inventa cenário nem turno.
 *   5. o dia que só a planilha tem (a partir do primeiro dia do RDO) é "so_planilha" e quebra a contagem; o dia anterior ao RDO fica fora.
 * --planta <nome> troca a regra por uma errada e o ensaio TEM de reprovar: liberacao-restrita (no evento), sem-tolerancia e
 *   so-dias-do-rdo (no código do gerador, numa cópia ao lado apagada no fim; o nome casa com scripts/_plantio_* do .gitignore).
 */
'use strict';
const P = require('./lib-ppc.js');
const PLANTA = (process.argv.indexOf('--planta') >= 0 && process.argv[process.argv.indexOf('--planta') + 1]) || '';
/* plantios NO CÓDIGO: "sem-tolerancia" troca a tolerância de 5 min por zero; "so-dias-do-rdo" volta a percorrer só os dias do RDO */
const NO_CODIGO = {
  'sem-tolerancia': ['const TOL_MIN = 5,', 'const TOL_MIN = 0,'],
  'so-dias-do-rdo': ['...[...Pl.keys()].filter((d) => d >= ini)', ''],
};
if (PLANTA && PLANTA !== 'liberacao-restrita' && !NO_CODIGO[PLANTA]) throw new Error('plantio desconhecido: ' + PLANTA);
const G = (() => {
  if (!NO_CODIGO[PLANTA]) return require('./gen-ppc-rdo.js');
  const [de, para] = NO_CODIGO[PLANTA];
  const fs = require('fs'), path = require('path'), src = fs.readFileSync(path.join(__dirname, 'gen-ppc-rdo.js'), 'utf8');
  if (src.split(de).length !== 2) throw new Error('plantio sem âncora: ' + de);
  const tmp = path.join(__dirname, '_plantio_gen-ppc-rdo.js');
  fs.writeFileSync(tmp, src.replace(de, para));
  try { return require(tmp); } finally { fs.unlinkSync(tmp); }
})();
let falhas = 0, n = 0;
const ok = (c, nome) => { n++; if (!c) { falhas++; console.log('  FALHA: ' + nome); } else console.log('  ok: ' + nome); };

const R = { versao: 1, dias: [
  { dia: '2026-11-01', herdada: null, ordens: [
    { h: '06:33', tipo: 'ordem', mw: 171, mot: 'ENE_FREQ', motivo: 'Energético · controle de frequência', origem: 'coleta', conf: 'mesa' },
    { h: '06:41', tipo: 'alt', mw: 177, mot: 'ENE_FREQ', origem: 'coleta', conf: 'sistema', sp: { M1: 25.3, M2: 12.65 } },
    { h: '07:36', tipo: 'alt', mw: 157, mot: 'ENE_FREQ', origem: 'coleta', conf: 'mesa' },
    { h: '15:50', tipo: 'lib', mw: 343.77, origem: 'coleta', conf: null }] },
  { dia: '2026-11-02', herdada: { mw: 200, mot: 'ENE_FREQ', motivo: 'Energético · controle de frequência' }, ordens: [
    { h: '09:00', tipo: 'alt', mw: 150, mot: 'ENE_FREQ', origem: 'mesa', conf: null }, { h: '12:00', tipo: 'lib', mw: 343.77, origem: 'mesa' }] },
  { dia: '2026-11-03', herdada: null, ordens: [{ h: '10:00', tipo: 'ordem', mw: 120, mot: 'FLUXO', origem: 'coleta' }, { h: '11:00', tipo: 'lib', mw: 343.77 }] }] };

const ev = G.eventosDoRdo(R);
if (PLANTA === 'liberacao-restrita') ev.forEach((e) => { if (e.motivo_cod === 'LIVRE') e.restr = 1; });
const e1 = ev.filter((e) => e.dia === '2026-11-01');
ok(e1.length === 4 && e1[3].pot === P.PLENA && e1[3].restr === 0 && e1[3].motivo_cod === 'LIVRE', 'a liberação vale a potência plena, sem restrição, LIVRE');
ok(e1[0].pot === 171 && e1[0].restr === 1 && e1[0].motivo_cod === 'ENE_FREQ' && e1[0].ts === '2026-11-01 06:33' && e1[0].ms === P.msDe('2026-11-01', 393), 'a ordem vale o limite, com o código, a hora e o instante');
ok(e1[1].ufvs.M1 && e1[1].ufvs.M1.sp === 25.3 && e1[1].conf === 'sistema' && e1[1].origem === 'coleta', 'o setpoint por usina, a origem e a conferência vão no evento');
ok(e1.every((e) => e.cenario === '' && e.turno === '' && e.tecnico === ''), 'cenário, turno e técnico ficam vazios: não se inventam');
const e2 = ev.filter((e) => e.dia === '2026-11-02');
ok(e2[0].min === 0 && e2[0].herdada === 1 && e2[0].pot === 200 && e2[0].restr === 1, 'a herdada do RDO anterior entra às 00:00, marcada');

const dias = P.resumoDias(ev), d1 = dias.find((d) => d.dia === '2026-11-01');
ok(d1.eventos === 4 && d1.restritos === 3 && d1.pot_min === 157 && d1.horas_restricao === Math.round(((950 - 393) / 60) * 100) / 100 && d1.restricao_aberta === 0,
  'o resumo do dia: 4 eventos, 3 restritos, mínimo 157, horas do degrau de 06:33 a 15:50');

const pl = [
  { dia: '2026-11-01', ts: '2026-11-01 06:34', min: 394, pot: 171, restr: 1 }, { dia: '2026-11-01', ts: '2026-11-01 07:36', min: 456, pot: 177, restr: 1 },
  { dia: '2026-11-01', ts: '2026-11-01 15:50', min: 950, pot: 343.77, restr: 0 },
  { dia: '2026-11-02', ts: '2026-11-02 09:02', min: 542, pot: 150.3, restr: 1 }, { dia: '2026-11-02', ts: '2026-11-02 12:00', min: 720, pot: 343.77, restr: 0 },
  { dia: '2026-10-31', ts: '2026-10-31 10:00', min: 600, pot: 200, restr: 1 },   // antes do primeiro dia do RDO: fora
  { dia: '2026-11-04', ts: '2026-11-04 08:10', min: 490, pot: 180, restr: 1 }];   // o RDO não tem o dia: so_planilha
const C = G.compara(ev, pl);
const c1 = C.find((d) => d.dia === '2026-11-01'), c2 = C.find((d) => d.dia === '2026-11-02'), c3 = C.find((d) => d.dia === '2026-11-03');
ok(c1 && c1.veredito === 'diverge' && JSON.stringify(c1.so_rdo) === JSON.stringify(['06:41 177', '07:36 157']) && JSON.stringify(c1.so_planilha) === JSON.stringify(['07:36 177']),
  'diverge: a ordem que a planilha não tem e o valor trocado, os dois lados listados');
ok(c2 && c2.veredito === 'bate' && c2.rdo === 2, 'bate: a planilha a até 5 min e 0,5 MW; a herdada fica fora da comparação');
ok(c3 && c3.veredito === 'so_rdo' && c3.planilha === 0, 'so_rdo: o dia que a planilha não tem');
const c4 = C.find((d) => d.dia === '2026-11-04');
ok(c4 && c4.veredito === 'so_planilha' && c4.rdo === 0 && JSON.stringify(c4.so_planilha) === JSON.stringify(['08:10 180']) && C[C.length - 1] === c4,
  'so_planilha: o dia que o RDO não tem entra, por último, e quebra a contagem');
ok(!C.some((d) => d.dia === '2026-10-31') && C.length === 4, 'o dia anterior ao primeiro do RDO fica fora; 4 dias no comparativo');

console.log(falhas ? `REPROVADO · ${falhas} de ${n}` + (PLANTA ? ' (plantio ' + PLANTA + ', como devia)' : '') : `APROVADO · ${n} conferências ok` + (PLANTA ? ' — PLANTIO ' + PLANTA + ' PASSOU: o ensaio não pega' : ''));
process.exitCode = PLANTA ? (falhas ? 0 : 1) : (falhas ? 1 : 0);
