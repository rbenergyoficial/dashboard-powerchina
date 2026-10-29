'use strict';
/*
 * ensaio-gen-alarmes-way2.js — o GERADOR dos alarmes dos medidores (gen-alarmes-way2.js) em rodadas seguidas sobre coletas forjadas,
 * sem rede (lote alarmes-way2, 28/10/2026). A regra de cada slot é julgada no ensaio-alarme-circuito.js; aqui se julga o que só aparece
 * de uma rodada para a outra: a semente do publicado, a virada do dia, a troca de início de um episódio e a poda da janela.
 *   R1 27/10 21:00–23:40: o M7C1 abre às 22:00 e o M9C1 às 23:00, os dois em curso; o slot 23:40 ainda incompleto em 10 medidores
 *      → `lido_ate` 23:35;
 *   R2 28/10 00:05–10:30: o M7C1 continua até 00:20 e fecha (mesmo id); o M9C1 segue aberto (mesmo id); o M8C1 abre com o 10:05 ainda
 *      PROVISÓRIO (qualidade 2), então nasce às 10:05; o M1C3 zera de 00:05 a 00:15 (episódio de hoje que começa na borda da janela);
 *   R3 28/10 00:05–11:00: o 10:05 virou medido (o M8C1 passa a nascer às 10:00, id novo) e ele fecha às 10:40: um evento só do M8C1, sem
 *      o id velho e sem fechamento falso à 00:00; o zero do M1C3 foi corrigido para medida normal e o episódio dele some;
 *   R4 05/11 (8 dias depois): o que terminou há mais de 7 dias sai; o M9C1, aberto desde 27/10, fecha na borda do 1º slot do dia e fica.
 * Invariantes em toda rodada: fim nulo ou depois do início, ids únicos, e nenhum par do mesmo equipamento e regra sobreposto.
 * Depois PLANTA defeitos no gerador e exige que cada um reprove.
 * uso: node scripts/ensaio-gen-alarmes-way2.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), os = require('os'), path = require('path');

const GEN = path.join(__dirname, 'gen-alarmes-way2.js');
const ms = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');
const PIDS = []; for (let p = 6196; p <= 6219; p++) PIDS.push(p);
const TAG = { 6215: 'M7C1', 6216: 'M8C1', 6219: 'M9C1' };   // escrito à mão (não lido da lib)

// coleta forjada no formato cru da Way2: todos os medidores normais de `de` a `ate` (borda direita), com exceções por ponto.
// zeros[pid] = [[de, ate, qualidade?], …] (borda direita, inclusive) em que o ponto fica zerado com a barra viva
function coleta(dia, de, ate, zeros = {}) {
  const ts = [];
  for (let t = ms(dia + 'T' + de); t <= ms(dia + 'T' + ate); t += 300000) ts.push(t);
  const iso = (t) => new Date(t - 3 * 3600000).toISOString().slice(0, 19);
  const dados = [];
  for (const pid of PIDS) {
    const trafo = pid < 6198, vn = trafo ? 132800 : 19900;
    const linha = (t) => {
      const z = (zeros[pid] || []).find(([a, b]) => t >= ms(dia + 'T' + a) && t <= ms(dia + 'T' + b));
      return z ? { P: 0, Q: 0, I: 0, V: vn, q: z[2] || 0 } : { P: trafo ? 60000 : 5000, Q: 300, I: 90, V: vn, q: 0 };
    };
    const g = { Demat: 'P', Demre: 'Q', CorrenteA: 'I', CorrenteB: 'I', CorrenteC: 'I', TensaoA: 'V', TensaoB: 'V', TensaoC: 'V' };
    for (const [nome, k] of Object.entries(g)) {
      dados.push({ pontoId: pid, nomeGrandeza: nome, valores: ts.map((t) => { const l = linha(t); return { data: iso(t), valor: l[k], qualidade: l.q }; }) });
    }
  }
  return { dados };
}

function rodadas(G) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const de = (o, tag) => (o ? o.eventos.filter((e) => e.tag === tag && e.regra === 'cto_aberto') : []);
  const invariantes = (r, o) => {
    if (!o) return C(r + ': gerou arquivo', false);
    const ids = o.eventos.map((e) => e.id);
    C(r + ': ids únicos', new Set(ids).size === ids.length, ids.join(','));
    C(r + ': fim nulo ou depois do início', o.eventos.every((e) => e.fim == null || ms(e.fim) > ms(e.ini)),
      o.eventos.filter((e) => e.fim != null && ms(e.fim) <= ms(e.ini)).map((e) => e.id + '→' + e.fim).join(','));
    const sob = [];
    o.eventos.forEach((a, i) => o.eventos.slice(i + 1).forEach((b) => {
      if (a.tag === b.tag && a.regra === b.regra && ms(a.ini) < (b.fim ? ms(b.fim) : Infinity) && ms(b.ini) < (a.fim ? ms(a.fim) : Infinity)) sob.push(a.id + '×' + b.id);
    }));
    C(r + ': nada do mesmo equipamento sobreposto', !sob.length, sob.join(','));
  };

  const inc = {}; for (let p = 6198; p <= 6207; p++) inc[p] = [['23:40', '23:40', 2]];   // o 23:40 ainda chegando em 10 medidores
  const r1 = G.compoe(coleta('2026-10-27', '21:00', '23:40', { ...inc, 6215: [['22:05', '23:40']], 6219: [['23:05', '23:40']] }), null, ms('2026-10-27T23:45:00'));
  invariantes('R1', r1);
  const m7 = de(r1, 'M7C1'), m9 = de(r1, 'M9C1');
  C('R1: M7C1 aberto desde 22:00, em curso', m7.length === 1 && m7[0].ini === '2026-10-27T22:00:00' && m7[0].fim === null, JSON.stringify(m7));
  C('R1: M9C1 aberto desde 23:00, em curso', m9.length === 1 && m9[0].ini === '2026-10-27T23:00:00' && m9[0].fim === null, JSON.stringify(m9));
  C('R1: só esses dois', r1 && r1.eventos.length === 2, r1 && r1.eventos.map((e) => e.id).join(','));
  C('R1: lido até 23:35 (o 23:40 só em 14 dos 24)', r1 && r1.lido_ate === '2026-10-27T23:35:00', r1 && r1.lido_ate);
  C('R1: o dicionário dos equipamentos vai junto', r1 && r1.eq && r1.eq.M7C1 && r1.eq.M7C1.pai === '04T2', JSON.stringify(r1 && r1.eq && r1.eq.M7C1));

  const r2 = G.compoe(coleta('2026-10-28', '00:05', '10:30', { 6215: [['00:05', '00:20']], 6219: [['00:05', '10:30']],
    6216: [['10:05', '10:05', 2], ['10:10', '10:30']], 6200: [['00:05', '00:15']] }), r1, ms('2026-10-28T10:35:00'));
  invariantes('R2', r2);
  const a7 = de(r2, 'M7C1'), a9 = de(r2, 'M9C1'), a8 = de(r2, 'M8C1');
  C('R2: M7C1 continua com o mesmo id e fecha às 00:20', a7.length === 1 && m7.length && a7[0].id === m7[0].id && a7[0].fim === '2026-10-28T00:20:00', JSON.stringify(a7));
  C('R2: M9C1 continua aberto com o mesmo id', a9.length === 1 && m9.length && a9[0].id === m9[0].id && a9[0].fim === null, JSON.stringify(a9));
  C('R2: M1C3 aberto 00:00–00:15', de(r2, 'M1C3').length === 1 && de(r2, 'M1C3')[0].ini === '2026-10-28T00:00:00', JSON.stringify(de(r2, 'M1C3')));
  C('R2: M8C1 nasce às 10:05 (o 10:05 é provisório)', a8.length === 1 && a8[0].ini === '2026-10-28T10:05:00' && a8[0].fim === null, JSON.stringify(a8));

  const r3 = G.compoe(coleta('2026-10-28', '00:05', '11:00', { 6215: [['00:05', '00:20']], 6219: [['00:05', '11:00']],
    6216: [['10:05', '10:40']] }), r2, ms('2026-10-28T11:05:00'));
  invariantes('R3', r3);
  const b8 = de(r3, 'M8C1');
  C('R3: um evento só do M8C1, 10:00–10:40 (o id velho saiu, sem fechamento falso)', b8.length === 1 && b8[0].ini === '2026-10-28T10:00:00'
    && b8[0].fim === '2026-10-28T10:40:00', JSON.stringify(b8));
  C('R3: o zero corrigido do M1C3 sumiu', !(r3 ? r3.eventos : []).some((e) => e.tag === 'M1C3'), JSON.stringify(de(r3, 'M1C3')));
  C('R3: o M7C1 fechado na virada continua lá', de(r3, 'M7C1').length === 1 && de(r3, 'M7C1')[0].fim === '2026-10-28T00:20:00');

  const r4 = G.compoe(coleta('2026-11-05', '00:05', '09:00'), r3, ms('2026-11-05T09:05:00'));
  invariantes('R4', r4);
  C('R4: o que terminou há mais de 7 dias saiu', r4 && !de(r4, 'M7C1').length && !de(r4, 'M8C1').length, r4 && r4.eventos.map((e) => e.id).join(','));
  const c9 = de(r4, 'M9C1');
  C('R4: o M9C1 aberto desde 27/10 fecha na borda do 1º slot e fica', c9.length === 1 && m9.length && c9[0].id === m9[0].id
    && c9[0].fim === '2026-11-05T00:00:00', JSON.stringify(c9));

  C('coleta sem slot: nada a gravar', G.compoe({ dados: [] }, r4, ms('2026-11-06T00:01:00')) === null);
  return f;
}

const reais = rodadas(require(GEN));
if (reais.length) { console.log('🔴 o gerador reprova:'); reais.forEach((x) => console.log('  - ' + x)); process.exit(1); }
console.log('✅ gerador: as quatro rodadas passam');

const SRC = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
const PLANTIOS = [
  ['o episódio de HOJE passado como véspera', " && A.msBRT(e.ini) < janelaIni\n", '\n'],
  ['só os abertos na semente (o que fechou hoje volta como episódio novo)', '(e.fim == null || A.msBRT(e.fim) > janelaIni)', 'e.fim == null'],
  ['sem a semente do publicado', 'A.detecta(elet.dados, { abertos: semente })', 'A.detecta(elet.dados, {})'],
  ['a janela recalculada começa no 1º slot (não na borda esquerda)', 'const janelaIni = t0 - SLOT_MS;', 'const janelaIni = t0;'],
  ['a poda de 70 dias em vez de 7', 'const JANELA_DIAS = 7;', 'const JANELA_DIAS = 70;'],
  ['lido até pelo 1º medidor, não pela cobertura', ".filter(([, n]) => n >= COBERTURA_MIN)", ".filter(([, n]) => n >= 1)"],
];
const tmp = fs.mkdtempSync(path.join(__dirname, '.ensaio-gen-alarmes-'));   // ao lado: o require('./lib-…') do gerador acha a lib
let ruim = 0;
try {
  PLANTIOS.forEach(([nome, de, para], k) => {
    if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
    const arq = path.join(tmp, 'gen-' + k + '.js');
    fs.writeFileSync(arq, SRC.replace(de, para).replace(/require\('\.\/lib-/g, "require('../lib-"));
    let f; try { f = rodadas(require(arq)); } catch (e) { f = ['estourou: ' + e.message]; }
    if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0] + ')');
    else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
void os;
