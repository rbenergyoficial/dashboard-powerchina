// Ensaio do gen-sinotico (lote sinotico-dados, 09/11/2026). Sem rede: coleta e alarmes forjados.
// 🔴 O que esta sendo provado: o disjuntor do Sinótico é o do ALARME (episódio em curso), não um julgamento próprio; o trafo sem tensão
// leva os circuitos dele para "sem tensão"; medidor sem qualidade 0 ou parado há mais de 15 min = "sem comunicação"; os intervalos
// futuros e vazios da coleta não contam; as medidas são as do último intervalo passado e completo. Quatro plantios reprovam.
'use strict';
const fs = require('fs');
const path = require('path');
const FONTE = fs.readFileSync(path.join(__dirname, 'gen-sinotico.js'), 'utf8');
const carrega = (src) => { const m = { exports: {} }; new Function('module', 'exports', 'require', '__dirname', src)(m, m.exports, require, __dirname); return m.exports; };
const A = require('./lib-alarme-circuito');

const AG = Date.parse('2026-11-09T14:02:00-03:00');
const iso = (ms) => A.isoBRT(ms);
const G = ['Demat', 'Demre', 'CorrenteA', 'CorrenteB', 'CorrenteC', 'TensaoA', 'TensaoB', 'TensaoC'];
function serie(pid, slots) {   // slots: [ms, {P,Q,I,V}|null(sem qualidade)]
  return G.map((g) => ({ pontoId: pid, nomeGrandeza: g, valores: slots.map(([t, v]) => ({ data: iso(t),
    valor: v ? { Demat: v.P, Demre: v.Q, CorrenteA: v.I, CorrenteB: v.I, CorrenteC: v.I, TensaoA: v.V, TensaoB: v.V, TensaoC: v.V }[g] : 0,
    qualidade: v ? 0 : 2 })) }));
}
const VN = 34500 / Math.sqrt(3), VT = 230000 / Math.sqrt(3), M = 60000;
const gerando = { P: 12000, Q: -300, I: 200, V: VN }, zeroViva = { P: 0, Q: 0, I: 0.05, V: VN }, zeroMorta = { P: 0, Q: 0, I: 0, V: 0 };
function dados() {
  const d = [];
  for (const [pid, tag] of Object.entries(A.PID)) {
    const tr = A.EQ[tag].n === 'trafo', base = tr ? { P: 150000, Q: -2000, I: 380, V: VT } : gerando;
    let slots = [[AG - 7 * M, base], [AG - 2 * M, base], [AG + 3 * M, null]];          // o futuro vem vazio
    if (tag === 'M3C2') slots = [[AG - 7 * M, zeroViva], [AG - 2 * M, zeroViva]];       // o alarme diz aberto
    if (tag === 'M6C1') slots = [[AG - 7 * M, base], [AG - 2 * M, null]];              // qualidade ruim no último
    if (tag === 'M5C2') slots = [[AG - 40 * M, base]];                                   // parado há 40 min
    if (tag === 'M7C1') slots = [[AG - 7 * M, zeroMorta], [AG - 2 * M, zeroMorta]];     // filho do 04T2 sem tensão
    d.push(...serie(Number(pid), slots));
  }
  return d;
}
const ALARMES = { eventos: [
  { id: 'cto_aberto:M3C2:x', regra: 'cto_aberto', tag: 'M3C2', ini: '2026-11-09T13:50:00', fim: null },
  { id: 'trafo_sem_tensao:04T2:y', regra: 'trafo_sem_tensao', tag: '04T2', ini: '2026-11-09T13:50:00', fim: null },
  { id: 'cto_aberto:M1C1:z', regra: 'cto_aberto', tag: 'M1C1', ini: '2026-11-08T10:00:00', fim: '2026-11-08T11:00:00' }   // já fechou
] };

function confere(S, dizer) {
  let mau = 0;
  const ok = (v, m) => { if (!v) { mau++; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  try {
    const o = S.monta(dados(), ALARMES, AG), d = (t) => o.disjuntores[t].estado;
    ok(d('M3C2') === 'aberto' && o.disjuntores.M3C2.desde === '2026-11-09T13:50:00', 'circuito com alarme de abertura em curso: aberto, desde o início do alarme');
    ok(d('M1C1') === 'fechado', 'alarme que já fechou não abre o disjuntor');
    ok(d('M7C1') === 'sem_tensao' && d('04T2') === 'sem_tensao', 'trafo sem tensão leva os circuitos dele para sem tensão');
    ok(d('M1C2') === 'fechado' && d('M5C1') === 'fechado', 'circuito do outro trafo, gerando: fechado');
    ok(o.medidores.M6C1.t === iso(AG - 7 * M) && d('M6C1') === 'fechado', 'qualidade ruim no último intervalo: vale o último completo');
    ok(d('M5C2') === 'sem_comunicacao' && o.medidores.M5C2.p_kw === null, 'medidor parado há 40 min: sem comunicação, sem valor');
    ok(o.medidores.M1C2.t === iso(AG - 2 * M) && o.medidores.M1C2.p_kw === 12000, 'medidas do último intervalo passado e completo (o futuro vazio não conta)');
    ok(o.usinas.M1.p_kw === 36000 && o.usinas.M1.medidos === 3, 'total da usina = soma dos circuitos que comunicam');
  } catch (e) { ok(false, 'estourou: ' + e.message); }
  return mau;
}

console.log('ensaio do Sinótico');
const mau = confere(carrega(FONTE), true);
const PLANTIOS = {
  'ignora o alarme': ["if (ep && /_aberto$/.test(ep.regra)) d = 'aberto';", "if (false) d = 'aberto';"],
  'sem herdar o trafo sem tensão': ["|| (emCurso.get(eq.pai) && /sem_tensao/.test(emCurso.get(eq.pai).regra) ? emCurso.get(eq.pai) : null)", ''],
  'o último da lista, como o 1º rascunho': ['const ult = passados.filter((x) => x.ok).pop() || passados.pop() || null;', 'const ult = s && s.size ? [...s.values()].pop() : null;'],
  'sem conferir a idade': ['&& agoraMs - ult.t <= VELHO_MS + A.LIMITES.SLOT_MS', '']
};
let furou = 0;
for (const [nome, [de, para]] of Object.entries(PLANTIOS)) {
  if (!FONTE.includes(de)) { console.log('  [X] plantio "' + nome + '": trecho não encontrado'); furou++; continue; }
  const n = confere(carrega(FONTE.replace(de, para)), false);
  console.log((n ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n ? 'reprova' : 'PASSOU — o ensaio não o vê'));
  if (!n) furou++;
}
console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) não pego(s)` : 'APROVADO');
process.exit(mau || furou ? 1 : 0);
