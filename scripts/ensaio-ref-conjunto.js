'use strict';
/*
 * ensaio-ref-conjunto.js — a guarda de fechamento do `ref_dia_ufv` (`lib-ref-conjunto.js`) em casos FORJADOS, antes de
 * gerar (PROMOVER executivo-vermelho, 10/10/2026). Sem rede e sem blob: julga a REGRA, vale em qualquer estado do mundo.
 *
 * POR QUE EXISTE. A guarda foi afrouxada duas vezes pelo mesmo patamar (01/10 09:00: o conjunto sem nenhuma parcela em
 * 03/10, com a parcela do M6 so em 10/10). Cada afrouxamento passa em todo ensaio de produto, porque o dado do dia so tem
 * aquele patamar. Este ensaio prova que o que ela ainda deve pegar continua reprovando: duas parcelas, `disp` coerente,
 * o atacado acima do teto, a usina duplicada ou ausente do nosso lado e o conjunto de outra revisao; e que o certo passa,
 * inclusive o amanhecer, quando a soma das usinas e quase a parcela de uma so.
 *
 * E PROVA QUE REPROVA: compila a lib com os defeitos de PLANTIOS (cada troca conferida: achada uma vez e o texto mudou) e
 * exige que cada um faca pelo menos um caso sair do esperado.
 *
 * E A FIACAO: a lib so vale se o gerador a chama. O ensaio le o `gen-executivo.js` e exige o require, as duas chamadas, a
 * referencia do Complexo passada a lib e o erro do excesso — e prova que a conferencia acusa o gerador sem o erro.
 */
const fs = require('fs'), path = require('path');
const FONTE = path.join(__dirname, 'lib-ref-conjunto.js');
const USINAS = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8', 'M1', 'M7', 'M9'];
const DIA = '2026-10-01';
// parcelas reais de 01/10 09:00 (MW): somam 317,78; o conjunto publicou 47,246 (a do M6) com disp 49,105 e 245,594 gerados
const P0900 = { M1: 46.78, M2: 23.88, M3: 39.78, M4: 47.11, M5: 46.62, M6: 47.25, M7: 11.77, M8: 48.69, M9: 5.9 };
const CAP = { M1: 50, M2: 25, M3: 42, M4: 50, M5: 50, M6: 50, M7: 13, M8: 50, M9: 8 };

const hh = (k) => String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00');
const r2 = (x) => Math.round(x * 100) / 100;
/* um dia limpo: sol das 06:00 as 17:30, as parcelas reais as 09:00; o conjunto e a soma, com disp cheia de dia e a geracao
   residual das 18:00 as 19:30 com nada publicado (gref 0, disp 0, ger > 0, as usinas 0) — o caso que ja fecha */
function diaLimpo() {
  const refHora = { [DIA]: {} }, cons = [];
  USINAS.forEach((u) => { refHora[DIA][u] = { ge: new Array(48).fill(0) }; });
  for (let k = 0; k < 48; k++) {
    const sol = k >= 12 && k <= 35 ? Math.sin(Math.PI * (k - 11) / 25) : 0;
    USINAS.forEach((u) => { refHora[DIA][u].ge[k] = k === 18 ? P0900[u] : r2(CAP[u] * 0.95 * sol); });
    const soma = USINAS.reduce((a, u) => a + refHora[DIA][u].ge[k], 0);
    const noite = k >= 36 && k <= 39;
    cons.push({ ts: DIA + ' ' + hh(k) + ':00', gref: String(r2(soma)), disp: sol > 0 ? '343.482' : '0', ger: String(noite ? 0.1 : r2(soma * 0.8)) });
  }
  return { refHora, cons };
}
const linha = (C, k) => C.cons[k];
/* o amanhecer: as 06:00 so o M5 tem parcela, o conjunto (legitimo) e ela, e a disp ainda nao foi publicada (0 < ger) —
   as duas primeiras condicoes acendem, e e o fechamento com a soma que segura o patamar fora da troca */
function amanhecer(C) { USINAS.forEach((u) => { C.refHora[DIA][u].ge[12] = u === 'M5' ? 4.2 : 0; });
  Object.assign(linha(C, 12), { gref: '4.2', disp: '0', ger: '3.1' }); }

const CASOS = [
  { nome: 'dia limpo, com a geracao residual das 18 h', espera: 'passa', absorve: 0, muda: () => {} },
  { nome: 'o amanhecer: a soma e a parcela de uma usina so, e o conjunto e ela', espera: 'passa', absorve: 0, muda: amanhecer },
  { nome: 'residuo de fim de tarde nas usinas (M9 0,05 MW as 18:00 e 18:30), nada no conjunto, o dia fecha', espera: 'passa',
    absorve: 0, muda: (C) => { C.refHora[DIA].M9.ge[36] = 0.05; C.refHora[DIA].M9.ge[37] = 0.05; } },
  { nome: '01/10 09:00 real: o conjunto com a parcela do M6 so, disp 49,105', espera: 'passa', absorve: 1,
    muda: (C) => Object.assign(linha(C, 18), { gref: '47.246', disp: '49.105', ger: '245.594' }) },
  { nome: 'nenhuma parcela (gref e disp zerados, 03/10)', espera: 'passa', absorve: 1,
    muda: (C) => Object.assign(linha(C, 18), { gref: '0', disp: '0', ger: '245.594' }) },
  { nome: 'duas parcelas (M6 + M4)', espera: 'reprova',
    muda: (C) => Object.assign(linha(C, 18), { gref: String(47.25 + 47.11), disp: '49.105', ger: '245.594' }) },
  { nome: 'uma parcela com disp coerente (o conjunto nao se contradiz)', espera: 'reprova',
    muda: (C) => Object.assign(linha(C, 18), { gref: '47.246', disp: '343.482', ger: '245.594' }) },
  { nome: 'atacado: dois patamares do dia com uma parcela', espera: 'reprova',
    muda: (C) => { Object.assign(linha(C, 18), { gref: '47.246', disp: '49.105', ger: '245.594' });
      Object.assign(linha(C, 20), { gref: String(C.refHora[DIA].M8.ge[20]), disp: '49.105', ger: '250' }); } },
  { nome: 'usina DUPLICADA do nosso lado as 09:00', espera: 'reprova', muda: (C) => { C.refHora[DIA].M6.ge[18] *= 2; } },
  { nome: 'usina AUSENTE do nosso lado as 09:00', espera: 'reprova', muda: (C) => { C.refHora[DIA].M6.ge[18] = null; } },
  { nome: 'o conjunto de outra revisao: o dia inteiro a um quarto', espera: 'reprova',
    muda: (C) => C.cons.forEach((r) => { r.gref = String(r2(Number(r.gref) / 4)); }) },
];

function julga(lib) {
  const res = [];
  for (const c of CASOS) {
    const C = diaLimpo(); c.muda(C);
    const refComplexo = [{ dia: DIA, ref_mwh: r2(USINAS.reduce((a, u) => a + C.refHora[DIA][u].ge.reduce((s, x) => s + (Number(x) || 0), 0), 0) * 0.5) }];
    const { grefDia, absorvidos, excesso } = lib.grefConjuntoPorDia(C.cons, C.refHora,
      { desde: '2026-03-01', usinas: USINAS, refDia: { [DIA]: refComplexo[0].ref_mwh } });
    const reprova = Object.keys(excesso).length > 0 || lib.diasQueNaoFecham(refComplexo, grefDia).length > 0;
    const ok = c.espera === (reprova ? 'reprova' : 'passa') && (c.absorve == null || c.absorve === absorvidos.length);
    res.push({ nome: c.nome, ok, reprova, absorvidos: absorvidos.length, espera: c.espera });
  }
  return res;
}

function compila(src) {
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
}

const f = [];
const src = fs.readFileSync(FONTE, 'utf8').replace(/\r\n/g, '\n');
const R = julga(compila(src));
R.forEach((x) => console.log('   ' + (x.ok ? 'ok ' : '🔴 ') + x.nome + ' -> ' + (x.reprova ? 'reprova' : 'passa')
  + ' (' + x.absorvidos + ' absorvido(s))'));
R.filter((x) => !x.ok).forEach((x) => f.push('a regra errou: ' + x.nome + ' (esperado ' + x.espera + ')'));
if (R.length !== CASOS.length || R.length < 10) f.push('julgou ' + R.length + ' caso(s), esperava ' + CASOS.length);

const PLANTIOS = [
  ['sem a condicao da parcela', '(g === 0 || parc.some((x) => Math.abs(g - x) <= FOLGA_MW))', 'true'],
  ['sem a condicao disp < ger', 'num(r.disp) < num(r.ger) && refHora[dd]', 'refHora[dd]'],
  ['sem o teto por dia', 'const MAX_POR_DIA = 1;', 'const MAX_POR_DIA = 1e9;'],
  ['a regra de 03/10 (so nenhuma parcela)', '(g === 0 || parc.some((x) => Math.abs(g - x) <= FOLGA_MW))', 'g === 0'],
  ['sem a condicao de fechamento', 'Math.abs(g - soma) > FOLGA_MW && (g === 0', '(g === 0'],
  ['troca e conta tambem no dia que fecha cru', 'if (c.troca != null && !naoFechaCru(c.dd)) c.troca = null;', ''],
];
for (const [nome, de, para] of PLANTIOS) {
  const n = src.split(de).length - 1;
  if (n !== 1) { f.push('plantio "' + nome + '": o trecho aparece ' + n + ' vez(es) na lib — o plantio nao foi feito'); continue; }
  const mut = src.replace(de, para);
  if (mut === src) { f.push('plantio "' + nome + '": o texto nao mudou'); continue; }
  const erros = julga(compila(mut)).filter((x) => !x.ok).map((x) => x.nome);
  console.log('   plantio "' + nome + '": ' + erros.length + ' caso(s) fora do esperado' + (erros.length ? ' (' + erros.join('; ') + ')' : ''));
  if (!erros.length) f.push('plantio "' + nome + '" passou em todos os casos — o ensaio nao o pega');
}

/* a FIACAO no gerador: sem ela o ensaio julgaria uma lib que ninguem chama */
const FIOS = ["require('./lib-ref-conjunto.js')", 'RC.grefConjuntoPorDia(', 'refDia:', 'RC.diasQueNaoFecham(',
  'if (Object.keys(excesso).length) throw'];
const fiacao = (s) => FIOS.filter((x) => !s.includes(x));
const gen = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8').replace(/\r\n/g, '\n');
const faltam = fiacao(gen);
if (faltam.length) f.push('o gen-executivo.js nao traz: ' + faltam.join(' · '));
const semErro = gen.replace('if (Object.keys(excesso).length) throw', 'if (false) throw');
if (semErro === gen || !fiacao(semErro).length) f.push('a conferencia da fiacao nao acusa o gerador sem o erro do excesso');
console.log('   fiacao no gen-executivo: ' + (FIOS.length - faltam.length) + ' de ' + FIOS.length + ' · o gerador sem o erro do excesso: '
  + (fiacao(semErro).length ? 'acusado' : 'NAO acusado'));

if (f.length) { console.error('\nREPROVADO:'); f.forEach((x) => console.error('   🔴 ' + x)); process.exit(1); }
console.log('\nensaio-ref-conjunto: ' + R.length + ' casos e ' + PLANTIOS.length + ' plantios · TUDO PASSOU');
