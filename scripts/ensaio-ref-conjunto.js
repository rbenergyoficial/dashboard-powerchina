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
 * E A CORRECAO DO CORTE (PROMOVER ref-parcela-corte, 11/10/2026): o patamar absorvido entra no corte pela soma das usinas,
 * com a disponibilidade dele fora da media; o ensaio confere a troca, o corte de 36,09 MWh do 01/10 real e a idempotencia.
 *
 * E A FIACAO: a lib so vale se o gerador a chama, e a correcao so vale ANTES do corte. O ensaio le o `gen-executivo.js` e exige o require, as duas chamadas, a
 * referencia do Complexo passada a lib e o erro do excesso — e prova que a conferencia acusa o gerador sem o erro.
 *
 * --produto (depois de gerar): a lista publicada (`ref_conjunto_pela_soma`) se sustenta sozinha, bate com a marca por dia da
 * `serie_diaria`, e o corte mensal do executivo bate com o nosso corte do `benchmark_ne` quando os dois aplicaram a mesma
 * lista (folga 0,02 GWh, a do ensaio-pr para a mesma comparacao; a diferenca de safra entre o CSV do operador e o consolidado
 * medida em 11/10 chega a 0,0093 GWh). Listas de rodadas diferentes: diz que nao julgou. Prova reprovar tres defeitos forjados.
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

/* A CORRECAO DO CORTE (PROMOVER ref-parcela-corte, 11/10/2026): o detalhe por usina vira a mesma referencia que o gerador
   monta, a troca entra SO no patamar absorvido (gref = soma, disp nao publicada, marca), o corte do patamar passa a ser o
   da soma, e rodar a guarda de novo sobre o conjunto corrigido nao acha mais nada. */
function julgaCorrecao(lib) {
  const e = [];
  const C = diaLimpo(); CASOS.find((c) => c.nome.startsWith('01/10 09:00 real')).muda(C);
  const cru = { '2026-10': [] };
  for (let k = 0; k < 48; k++) USINAS.forEach((u) => cru['2026-10'].push({ ts: DIA + ' ' + hh(k) + ':00', u: u.replace('M', 'CEFMT'), ge: C.refHora[DIA][u].ge[k] }));
  const { refHora, refDia } = lib.refPorUsina(cru, { desde: '2026-03-01', usinas: USINAS });
  if (USINAS.some((u) => JSON.stringify(refHora[DIA][u].ge) !== JSON.stringify(C.refHora[DIA][u].ge))) e.push('refPorUsina: o MW por patamar nao e o do detalhe');
  const esperado = r2(USINAS.reduce((a, u) => a + C.refHora[DIA][u].ge.reduce((s, x) => s + x, 0), 0) * 0.5);
  if (Math.abs((refDia[DIA] || 0) - esperado) > 0.011) e.push('refPorUsina: o dia do Complexo ' + refDia[DIA] + ' contra ' + esperado);
  const cru8 = { '2026-10': cru['2026-10'].filter((r) => r.u !== 'CEFMT9') };
  if (lib.refPorUsina(cru8, { desde: '2026-03-01', usinas: USINAS }).refDia[DIA] != null) e.push('refPorUsina: dia com oito usinas saiu no Complexo');
  const antes = JSON.parse(JSON.stringify(C.cons));
  const { absorvidos } = lib.grefConjuntoPorDia(C.cons, refHora, { desde: '2026-03-01', usinas: USINAS, refDia });
  const n = lib.corrigeConjunto(C.cons, absorvidos);
  if (n !== 1) e.push('corrigeConjunto trocou ' + n + ' linha(s), esperava 1');
  const p = C.cons[18];
  if (Math.abs(Number(p.gref) - 317.78) > 0.011) e.push('o patamar de 09:00 ficou com gref ' + p.gref + ', esperava a soma 317,78');
  if (Number(p.disp) !== 0) e.push('o patamar de 09:00 ficou com disp ' + p.disp + ', esperava 0 (nao publicada)');
  if (p._ref_pela_soma !== 1) e.push('o patamar de 09:00 nao saiu marcado');
  const corte = Math.max(0, (Number(p.gref) - Number(p.ger)) * 0.5);
  if (Math.abs(corte - 36.09) > 0.011) e.push('o corte do patamar ficou ' + corte.toFixed(3) + ' MWh, esperava 36,09');
  const fora = C.cons.filter((r, i) => i !== 18 && JSON.stringify(r) !== JSON.stringify(antes[i])).length;
  if (fora) e.push(fora + ' linha(s) fora do patamar mudaram');
  const de2 = lib.grefConjuntoPorDia(C.cons, refHora, { desde: '2026-03-01', usinas: USINAS, refDia });
  if (de2.absorvidos.length || lib.diasQueNaoFecham([{ dia: DIA, ref_mwh: refDia[DIA] }], de2.grefDia).length) e.push('a guarda sobre o conjunto corrigido ainda acha o que trocar ou nao fecha');
  if (lib.corrigeConjunto(C.cons, []) !== 0) e.push('corrigeConjunto sem absorvidos trocou linha');
  return e;
}
/* A LISTA PUBLICADA (PROMOVER ref-parcela-corte): o `gen-pr` e o `gen-benchmark-ons` aplicam o que o executivo publicou, e so
   onde o cru ainda traz o defeito. Lista velha (o operador republicou certo), patamar coerente e ts fora da lista nao trocam. */
function julgaLista(lib) {
  const e = [];
  const LISTA = [{ ts: '2026-10-01 09:00', gref_publicado: 47.25, soma_usinas: 317.78 }];
  const real = () => { const C = diaLimpo(); CASOS.find((c) => c.nome.startsWith('01/10 09:00 real')).muda(C); return C; };
  let C = real(); const antes = JSON.parse(JSON.stringify(C.cons));
  const n = lib.aplicaLista(C.cons, LISTA);
  if (n !== 1 || Math.abs(Number(C.cons[18].gref) - 317.78) > 0.011 || Number(C.cons[18].disp) !== 0 || C.cons[18]._ref_pela_soma !== 1)
    e.push('aplicaLista: a lista certa nao trocou o patamar de 09:00 como o executivo (' + n + ' troca(s), gref ' + C.cons[18].gref + ')');
  if (C.cons.some((r, i) => i !== 18 && JSON.stringify(r) !== JSON.stringify(antes[i]))) e.push('aplicaLista: mexeu fora do patamar');
  C = diaLimpo();   // o operador republicou certo: o patamar ja e a soma, com disp cheia
  if (lib.aplicaLista(C.cons, LISTA) !== 0) e.push('aplicaLista: a lista velha trocou um patamar que o cru ja traz certo');
  C = real();
  if (lib.aplicaLista(C.cons, [{ ts: '2026-10-01 10:00', gref_publicado: 1, soma_usinas: 999 }]) !== 0) e.push('aplicaLista: trocou um patamar coerente (disp acima do gerado)');
  if (lib.aplicaLista(C.cons, []) !== 0 || lib.aplicaLista(C.cons, undefined) !== 0) e.push('aplicaLista: sem lista trocou linha');
  // a linha do CSV do operador vem em texto: a mesma regra tem de valer
  const m = lib.mapaDaLista(LISTA);
  if (lib.somaDaLista(m, { ts: '2026-10-01 09:00:00', gref: '47.246', ger: '245.594', disp: '49.105' }) !== 317.78) e.push('somaDaLista: nao leu a linha em texto do CSV');
  return e;
}
const RL_ = julgaLista(compila(src));
RL_.forEach((x) => f.push('a lista errou: ' + x));
console.log('   lista publicada: ' + (RL_.length ? RL_.length + ' erro(s)' : 'troca so onde o cru ainda traz o defeito; lista velha, patamar coerente e ts fora nao trocam'));
const RC_ = julgaCorrecao(compila(src));
RC_.forEach((x) => f.push('a correcao errou: ' + x));
console.log('   correcao do conjunto: ' + (RC_.length ? RC_.length + ' erro(s)' : 'referencia por usina, troca so no patamar absorvido, corte 36,09 MWh, idempotente'));

const PLANTIOS = [
  ['a correcao nao troca o gref', 'r.gref = String(a.soma); ', ''],
  ['a correcao nao tira a disp', "r.disp = '0'; ", ''],
  ['a correcao nao marca a linha', 'r._ref_pela_soma = 1; ', ''],
  ['o Complexo sem o tudo-ou-nada', 'if (usinas.every((u) => s[u] != null)) refDia[d]', 'refDia[d]'],
  ['a lista sem conferir o cru', 'if (!(num(r.disp) < num(r.ger)) || Math.abs(num(r.gref) - s) <= FOLGA_MW) return null;', ''],
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
  const lm = compila(mut);
  const erros = julga(lm).filter((x) => !x.ok).map((x) => x.nome).concat(julgaCorrecao(lm), julgaLista(lm));
  console.log('   plantio "' + nome + '": ' + erros.length + ' caso(s) fora do esperado' + (erros.length ? ' (' + erros.join('; ') + ')' : ''));
  if (!erros.length) f.push('plantio "' + nome + '" passou em todos os casos — o ensaio nao o pega');
}

/* a FIACAO no gerador: sem ela o ensaio julgaria uma lib que ninguem chama */
const FIOS = ["require('./lib-ref-conjunto.js')", 'RC.grefConjuntoPorDia(', 'refDia:', 'RC.diasQueNaoFecham(',
  'if (Object.keys(excesso).length) throw', 'RC.refPorUsina(', 'RC.corrigeConjunto(', 'CRU_LIDO[mes] ||',
  'if (r._ref_pela_soma) dd.ref_soma++', 'ref_pela_soma: d.ref_soma',
  // a guarda de baixo NAO pode achar o que trocar: se achar, o topo nao corrigiu (revisor-ensaio, RE-019)
  'if (absorvidos.length) throw',
  // so o 404 e ausencia no topo (RE-020)
  "if (!/^404 /.test(String(e.message))) throw"];
/* e a ORDEM: a correcao tem de vir antes do corte do conjunto (secao 1), senao ela so mexe no que ja foi apurado */
const SECAO1 = '// ---------- 1) complexo por m';
const fiacao = (s) => FIOS.filter((x) => !s.includes(x))
  .concat(s.indexOf('RC.corrigeConjunto(') > -1 && s.indexOf(SECAO1) > -1 && s.indexOf('RC.corrigeConjunto(') > s.indexOf(SECAO1)
    ? ['a correcao depois do corte (secao 1)'] : [])
  .concat(s.indexOf(SECAO1) < 0 ? ['o marco da secao 1 sumiu do gerador'] : []);
const gen = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8').replace(/\r\n/g, '\n');
const faltam = fiacao(gen);
if (faltam.length) f.push('o gen-executivo.js nao traz: ' + faltam.join(' · '));
const semErro = gen.replace('if (Object.keys(excesso).length) throw', 'if (false) throw');
if (semErro === gen || !fiacao(semErro).length) f.push('a conferencia da fiacao nao acusa o gerador sem o erro do excesso');
const semBaixo = gen.replace('if (absorvidos.length) throw', 'if (false) throw');
if (semBaixo === gen || !fiacao(semBaixo).length) f.push('a conferencia da fiacao nao acusa a guarda de baixo sem o erro');
console.log('   a guarda de baixo sem o erro: ' + (fiacao(semBaixo).length ? 'acusada' : 'NAO acusada'));
const tarde = gen.replace('RC.corrigeConjunto(', 'RC.semCorrecao(') + '\nRC.corrigeConjunto(';
if (tarde === gen || !fiacao(tarde).includes('a correcao depois do corte (secao 1)')) f.push('a conferencia da fiacao nao acusa a correcao depois do corte');
console.log('   fiacao no gen-executivo: ' + (FIOS.length - faltam.length) + ' de ' + FIOS.length + ', na ordem · o gerador sem o erro do excesso: '
  + (fiacao(semErro).length ? 'acusado' : 'NAO acusado') + ' · a correcao depois do corte: '
  + (fiacao(tarde).includes('a correcao depois do corte (secao 1)') ? 'acusada' : 'NAO acusada'));

/* e a fiacao da LISTA nos outros dois que leem o conjunto (PROMOVER ref-parcela-corte): a troca antes da conta que ela muda */
const le = (n) => fs.readFileSync(path.join(__dirname, n), 'utf8').replace(/\r\n/g, '\n');
const OUTROS = [
  { arq: 'gen-pr.js', fio: 'aplicaLista(ons.consolidado, exe && exe.ref_conjunto_pela_soma)', antes: 'L.impedidaMeias(ons.consolidado)' },
  { arq: 'gen-benchmark-ons.js', fio: 'RC.somaDaLista(LISTA,', antes: 'const perda = Math.max(0, (gref - ger) * H);',
    tambem: "RC.mapaDaLista((await getJSON(BASE_LEITURA + 'executivo.json')).ref_conjunto_pela_soma)" },
];
const fio2 = (s, o) => {
  const e = [], i = s.indexOf(o.fio), j = s.indexOf(o.antes);
  if (i < 0) e.push(o.arq + ' nao aplica a lista');
  if (j < 0) e.push(o.arq + ': o marco "' + o.antes.slice(0, 30) + '" sumiu');
  if (i >= 0 && j >= 0 && i > j) e.push(o.arq + ' aplica a lista DEPOIS da conta');
  if (o.tambem && !s.includes(o.tambem)) e.push(o.arq + ' nao le a lista do executivo');
  return e;
};
for (const o of OUTROS) {
  const s = le(o.arq), e = fio2(s, o);
  e.forEach((x) => f.push('fiacao: ' + x));
  const sem = s.replace(o.fio, 'semLista(');
  if (sem === s || !fio2(sem, o).length) f.push('fiacao: a conferencia nao acusa o ' + o.arq + ' sem a lista');
  console.log('   fiacao da lista no ' + o.arq + ': ' + (e.length ? e.join('; ') : 'ok, antes da conta') + ' · sem a lista: '
    + (fio2(sem, o).length ? 'acusado' : 'NAO acusado'));
}

/* ── PRODUTO (--produto, depois de gerar) ───────────────────────────────────────────────────────────────────────────── */
const PRODUTO = process.argv.includes('--produto');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const TOL_MES_GWH = 0.02;   // a do ensaio-pr para a mesma comparacao (impedida x corte apurado, em GWh)
function pega(nome) {
  const https = require('https'), zlib = require('zlib');
  return new Promise((ok, ko) => https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return ko(new Error(nome + ': HTTP ' + r.statusCode)); }
    const ch = []; r.on('data', (d) => ch.push(d));
    r.on('end', () => { try { let b = Buffer.concat(ch); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); ok(JSON.parse(b.toString('utf8'))); } catch (e) { ko(e); } });
  }).on('error', ko));
}
/* julga um par (executivo, benchmark); devolve { erros, julgado, comparados } — usado no par real e nos forjados */
function julgaProduto(E, B, lib) {
  const e = [];
  const L = E.ref_conjunto_pela_soma;
  if (!Array.isArray(L)) return { erros: ['executivo sem ref_conjunto_pela_soma'], julgado: false, comparados: 0 };
  const porDia = {};
  for (const x of L) {
    const v = [x.gref_publicado, x.disp_publicada, x.ger, x.soma_usinas];
    if (!x.ts || !v.every(Number.isFinite)) { e.push('lista: item incompleto ' + JSON.stringify(x)); continue; }
    if (!(x.disp_publicada < x.ger)) e.push('lista: ' + x.ts + ' com disp ' + x.disp_publicada + ' >= ger ' + x.ger + ' (o conjunto nao se contradiz)');
    if (Math.abs(x.soma_usinas - x.gref_publicado) <= lib.FOLGA_MW) e.push('lista: ' + x.ts + ' ja fecha com a soma (' + x.gref_publicado + ' x ' + x.soma_usinas + ')');
    else if (!(x.gref_publicado === 0 || x.soma_usinas >= x.gref_publicado + lib.FOLGA_MW)) e.push('lista: ' + x.ts + ' com o gref ACIMA da soma — nao e parcela que falta');
    const d = String(x.ts).slice(0, 10); porDia[d] = (porDia[d] || 0) + 1;
  }
  Object.entries(porDia).forEach(([d, n]) => { if (n > lib.MAX_POR_DIA) e.push('lista: ' + n + ' patamares em ' + d + ', acima do teto ' + lib.MAX_POR_DIA); });
  for (const s of E.serie_diaria || []) {
    if (s.ref_pela_soma == null) { e.push('serie_diaria ' + s.dia + ' sem ref_pela_soma'); continue; }
    if (s.ref_pela_soma !== (porDia[s.dia] || 0)) e.push('serie_diaria ' + s.dia + ': ref_pela_soma ' + s.ref_pela_soma + ' contra ' + (porDia[s.dia] || 0) + ' na lista');
  }
  /* NAO JULGADO so na rodada de atraso: o benchmark roda antes do executivo e leu a lista da rodada anterior (`lida` diferente
     da do executivo). Com a lista LIDA igual, cada ts tem de ter sido aplicado, ou declarado sem defeito no CSV (o operador
     republicou certo; o mes dele fica fora da comparacao, dito no log). Lido e nao aplicado nem declarado e o benchmark que
     deixou de aplicar a troca: reprova (revisor-ensaio, RE-026) — senao o "nao julgado" esconderia isso para sempre. */
  const lida = B.ref_conjunto_pela_soma_lida, ap = B.ref_conjunto_pela_soma_aplicada, semDef = B.ref_conjunto_pela_soma_sem_defeito || [];
  const doExec = L.map((x) => String(x.ts)).sort();
  if (!Array.isArray(lida) || !Array.isArray(ap)) return { erros: e, julgado: false, comparados: 0, motivo: 'benchmark sem as listas lida e aplicada' };
  if (JSON.stringify(lida.slice().sort()) !== JSON.stringify(doExec)) return { erros: e, julgado: false, comparados: 0, motivo: 'o benchmark leu a lista de outra rodada (lida ' + lida.length + ', executivo ' + doExec.length + ')' };
  /* o "sem defeito" so vale com PROVA (revisor-ensaio, RE-032): a linha do CSV que o benchmark publicou para o ts tem de NAO
     trazer o defeito pela regra da lib (somaDaLista nula) e de ser DIFERENTE da que o executivo viu (gref, disp ou ger). Sem a
     linha, ou com a mesma linha, e o benchmark que deixou de aplicar com outro nome: reprova. */
  const mapa = lib.mapaDaLista(L), semDefOk = new Set();
  for (const x of semDef) {
    const it = L.find((y) => String(y.ts) === String(x && x.ts));
    if (!x || typeof x !== 'object' || !it || ![x.gref, x.disp, x.ger].every(Number.isFinite)) { e.push('sem_defeito sem a linha do CSV: ' + JSON.stringify(x)); continue; }
    if (lib.somaDaLista(mapa, { ts: x.ts, gref: x.gref, disp: x.disp, ger: x.ger }) != null) { e.push('sem_defeito: ' + x.ts + ' — a linha do CSV ainda traz o defeito'); continue; }
    const igual = Math.abs(x.gref - it.gref_publicado) <= 0.0005 && Math.abs(x.disp - it.disp_publicada) <= 0.0005 && Math.abs(x.ger - it.ger) <= 0.0005;
    if (igual) { e.push('sem_defeito: ' + x.ts + ' — a linha do CSV e a mesma que o executivo viu'); continue; }
    // e REPUBLICADO CERTO e o conjunto trazendo a soma das usinas (RE-036): a disp lida da coluna errada (>= ger) deixaria a
    // linha "sem defeito" e "diferente" com o gref ainda a parcela de uma usina so
    if (Math.abs(x.gref - it.soma_usinas) > lib.FOLGA_MW) { e.push('sem_defeito: ' + x.ts + ' — o gref do CSV (' + x.gref + ') ainda longe da soma das usinas (' + it.soma_usinas + ')'); continue; }
    semDefOk.add(String(x.ts));
  }
  const bm = new Map((B.serie || []).filter((x) => x.fonte === 'solar').map((x) => [x.mes, x]));
  const foraMes = new Set(), avisos = [];
  for (const ts of doExec) {
    const mes = ts.slice(0, 7);
    if (ap.includes(ts)) continue;
    if (semDefOk.has(ts)) { foraMes.add(mes); avisos.push(ts + ' sem defeito no CSV (o operador republicou: gref ' + (semDef.find((x) => String(x.ts) === ts) || {}).gref + ')'); continue; }
    if (semDef.some((x) => String(x && x.ts) === ts)) continue;   // ja reprovado acima
    if (!bm.has(mes)) { foraMes.add(mes); avisos.push(ts + ' em mes que o benchmark nao leu'); continue; }
    e.push('o benchmark leu a lista e nao aplicou ' + ts + ' (nem o declarou sem defeito no CSV)');
  }
  /* SO MES FECHADO no mes a mes: o benchmark le o CSV do operador direto e o executivo o consolidado; no mes ABERTO um tem um
     dia a mais que o outro quase sempre (medido em 11/10: 8,46 x 7,14 GWh, o 10/10 so no CSV). E o DIA de cada patamar da
     lista, que e onde a troca aparece: o mesmo dia fechado nos dois, folga de dois arredondamentos (o MWh a 2 casas do
     executivo e o GWh a 2 casas do benchmark, 0,005 GWh cada). */
  /* e o mes fechado so com a MESMA cobertura nas duas series por dia (revisor-ensaio, RE-031): na virada, o mes que acabou de
     fechar tem no CSV um dia que o consolidado ainda nao tem. Ultimo dia do mes igual nas duas (ou o mes fora das duas janelas
     diarias, ja antigo), compara; diferente, diz "safra" e nao compara. */
  const mesAberto = (E.mes || {}).mes;
  const ultimo = (lista, campo, mes) => { let u = null; for (const d of lista || []) if (String(d.dia).slice(0, 7) === mes && d[campo] != null && (!u || d.dia > u)) u = d.dia; return u; };
  const bmDiaSolar = (B.serie_dia || []).filter((d) => d.fonte === 'solar');
  let comparados = 0; const mesesComparados = [];
  for (const s of E.serie || []) {
    const b = bm.get(s.mes);
    if (foraMes.has(s.mes) || s.mes === mesAberto) continue;
    const uE = ultimo(E.serie_diaria, 'cortado_mwh', s.mes), uB = ultimo(bmDiaSolar, 'nosso_cortado_gwh', s.mes);
    if (uE && uB && uE !== uB) { avisos.push(s.mes + ': safra diferente (executivo ate ' + uE + ', benchmark ate ' + uB + ')'); continue; }
    if (!b || s.mes < '2026-03' || b.nosso_ref_suspeita || s.frustrada_mwh == null || b.nosso_cortado_gwh_maior_zero == null) continue;
    comparados++; mesesComparados.push(s.mes);
    const dif = s.frustrada_mwh / 1000 - b.nosso_cortado_gwh_maior_zero;
    if (Math.abs(dif) > TOL_MES_GWH) e.push(s.mes + ': corte do executivo ' + (s.frustrada_mwh / 1000).toFixed(3) + ' GWh contra o do benchmark '
      + b.nosso_cortado_gwh_maior_zero + ' (dif ' + dif.toFixed(4) + ', folga ' + TOL_MES_GWH + ')');
  }
  const TOL_DIA_GWH = 0.01;
  const exDia = new Map((E.serie_diaria || []).map((d) => [d.dia, d])), bmDia = new Map((B.serie_dia || []).filter((d) => d.fonte === 'solar').map((d) => [d.dia, d]));
  let dias = 0;
  for (const ts of doExec) {
    const dia = ts.slice(0, 10), x = exDia.get(dia), b = bmDia.get(dia);
    if (semDefOk.has(ts) || !x || !b || x.cortado_mwh == null || b.nosso_cortado_gwh == null) continue;
    dias++;
    const dif = x.cortado_mwh / 1000 - b.nosso_cortado_gwh;
    if (Math.abs(dif) > TOL_DIA_GWH) e.push(dia + ': corte do dia no executivo ' + (x.cortado_mwh / 1000).toFixed(3) + ' GWh contra o do benchmark '
      + b.nosso_cortado_gwh + ' (dif ' + dif.toFixed(4) + ', folga ' + TOL_DIA_GWH + ')');
  }
  if (doExec.length && !dias && !(avisos.length)) avisos.push('nenhum dia da lista nas duas series por dia (janela de 90 dias)');
  if (!comparados) e.push('nenhum mes comparado entre executivo e benchmark — a conferencia nao julgou nada');
  return { erros: e, julgado: true, comparados, mesesComparados, dias, avisos };
}
const clone = (o) => JSON.parse(JSON.stringify(o));
async function produto() {
  const lib = compila(src);
  const [E, B] = await Promise.all([pega('executivo.json'), pega('benchmark_ne.json')]);
  suite(E, B, lib, 'produto');
  /* e o ENSAIO INTEIRO no estado da VIRADA DO MES (revisor-ensaio, RE-035): o mes aberto do executivo um mes adiante, o mes
     que acabou de fechar com a safra de hoje. O par real, os controles e os plantios tem de se comportar igual nele — um plantio
     que escolhesse o mes tirado da comparacao "passaria" e pintaria o job de vermelho todo dia 1. */
  const prox = (m) => { const d = new Date(Date.parse(m + '-01T00:00:00Z')); d.setUTCMonth(d.getUTCMonth() + 1); return d.toISOString().slice(0, 7); };
  if ((E.mes || {}).mes) { const Ev = clone(E); Ev.mes = Object.assign({}, Ev.mes, { mes: prox(E.mes.mes) }); suite(Ev, B, lib, 'virada'); }
}
function suite(E, B, lib, rot) {
  const r = julgaProduto(E, B, lib);
  r.erros.forEach((x) => f.push(rot + ': ' + x));
  console.log('   ' + rot + ': lista com ' + (E.ref_conjunto_pela_soma || []).length + ' patamar(es) · ' + (r.julgado
    ? r.comparados + ' mes(es) fechado(s) e ' + r.dias + ' dia(s) da lista comparados com o benchmark' : 'executivo x benchmark NAO JULGADO (' + r.motivo + ')'));
  (r.avisos || []).forEach((x) => console.log('   ⚠️ ' + x + ' — fica fora da comparacao'));
  // o mes do plantio mensal e um que a comparacao do par real JULGOU (nunca o tirado por safra): o ultimo comparado
  const mesJulgado = (r.mesesComparados || []).slice(-1)[0];
  // os defeitos plantados sobre o par: cada um tem de reprovar
  const forjados = [
    ['a marca do dia sem a troca', (e2) => { const s = (e2.serie_diaria || []).find((x) => x.dia === (String(((e2.ref_conjunto_pela_soma || [])[0] || {}).ts || '').slice(0, 10)))
      || (e2.serie_diaria || [])[0]; if (s) s.ref_pela_soma = (s.ref_pela_soma || 0) + 1; }],
    ['a lista com um patamar que ja fecha', (e2) => { e2.ref_conjunto_pela_soma = (e2.ref_conjunto_pela_soma || []).concat([{ ts: '2026-10-06 13:30', gref_publicado: 283.958, disp_publicada: 270.101, ger: 278.641, soma_usinas: 283.95 }]); }],
    ['o benchmark diz sem defeito com a mesma linha', (e2, b2) => { const L2 = e2.ref_conjunto_pela_soma || [];
      b2.ref_conjunto_pela_soma_lida = L2.map((x) => String(x.ts)); b2.ref_conjunto_pela_soma_aplicada = [];
      b2.ref_conjunto_pela_soma_sem_defeito = L2.map((x) => ({ ts: String(x.ts), gref: x.gref_publicado, disp: x.disp_publicada, ger: x.ger })); }],
    ['o benchmark diz sem defeito com a disp da coluna errada', (e2, b2) => { const L2 = e2.ref_conjunto_pela_soma || [];
      b2.ref_conjunto_pela_soma_lida = L2.map((x) => String(x.ts)); b2.ref_conjunto_pela_soma_aplicada = [];
      b2.ref_conjunto_pela_soma_sem_defeito = L2.map((x) => ({ ts: String(x.ts), gref: x.gref_publicado, disp: x.ger + 5.139, ger: x.ger })); }],
    ['o benchmark diz sem defeito sem a linha', (e2, b2) => { const L2 = e2.ref_conjunto_pela_soma || [];
      b2.ref_conjunto_pela_soma_lida = L2.map((x) => String(x.ts)); b2.ref_conjunto_pela_soma_aplicada = [];
      b2.ref_conjunto_pela_soma_sem_defeito = L2.map((x) => String(x.ts)); }],
    ['o benchmark leu a lista e nao aplicou', (e2, b2) => { b2.ref_conjunto_pela_soma_lida = (e2.ref_conjunto_pela_soma || []).map((x) => String(x.ts));
      b2.ref_conjunto_pela_soma_aplicada = []; b2.ref_conjunto_pela_soma_sem_defeito = []; }],
    ['o benchmark sem a troca no dia', (e2, b2) => { b2.ref_conjunto_pela_soma_aplicada = (e2.ref_conjunto_pela_soma || []).map((x) => String(x.ts));
      b2.ref_conjunto_pela_soma_lida = b2.ref_conjunto_pela_soma_aplicada.slice(); b2.ref_conjunto_pela_soma_sem_defeito = [];
      const dia = String(b2.ref_conjunto_pela_soma_lida[0] || '').slice(0, 10);
      const x = (e2.serie_diaria || []).find((d) => d.dia === dia), b = (b2.serie_dia || []).find((d) => d.fonte === 'solar' && d.dia === dia);
      if (x && b) b.nosso_cortado_gwh = Math.round((x.cortado_mwh / 1000 - 0.03609) * 100) / 100; }],
    ['o benchmark fora do executivo num mes fechado', (e2, b2) => { b2.ref_conjunto_pela_soma_aplicada = (e2.ref_conjunto_pela_soma || []).map((x) => String(x.ts));
      b2.ref_conjunto_pela_soma_lida = b2.ref_conjunto_pela_soma_aplicada.slice(); b2.ref_conjunto_pela_soma_sem_defeito = [];
      const m = (e2.serie || []).find((s) => s.mes === mesJulgado);
      const b = m && (b2.serie || []).find((x) => x.fonte === 'solar' && x.mes === m.mes); if (b) b.nosso_cortado_gwh_maior_zero = Math.round((m.frustrada_mwh / 1000 - 0.03609) * 100) / 100; }],
  ];
  // e os dois estados LEGITIMOS nao podem reprovar: a rodada de atraso (lida de outra rodada) e o patamar republicado certo
  if ((E.ref_conjunto_pela_soma || []).length) {
    const e3 = clone(E), b3 = clone(B); b3.ref_conjunto_pela_soma_lida = []; b3.ref_conjunto_pela_soma_aplicada = [];
    const r3 = julgaProduto(e3, b3, lib);
    console.log('   ' + rot + ' · controle "rodada de atraso": ' + (!r3.julgado && !r3.erros.length ? 'nao julgado, sem reprovar' : 'ERRADO'));
    if (r3.julgado || r3.erros.length) f.push(rot + ': a rodada de atraso foi julgada ou reprovada');
    const e4 = clone(E), b4 = clone(B), L4 = E.ref_conjunto_pela_soma || [], ts4 = L4.map((x) => String(x.ts));
    b4.ref_conjunto_pela_soma_lida = ts4; b4.ref_conjunto_pela_soma_aplicada = [];
    // a linha REPUBLICADA: o gref ja e a soma das usinas e a disp e a do conjunto inteiro
    b4.ref_conjunto_pela_soma_sem_defeito = L4.map((x) => ({ ts: String(x.ts), gref: x.soma_usinas, disp: 343.482, ger: x.ger }));
    const r4 = julgaProduto(e4, b4, lib);
    console.log('   ' + rot + ' · controle "o operador republicou certo": ' + (!r4.erros.length && (r4.avisos || []).length ? 'aviso, sem reprovar' : 'ERRADO ' + r4.erros.join('; ')));
    if (r4.erros.length || !(r4.avisos || []).length) f.push(rot + ': o patamar republicado certo reprovou ou passou calado');
  }
  // a VIRADA DO MES (revisor-ensaio, RE-031): o mes que acabou de fechar, com um dia a mais so no benchmark (o CSV a frente do
  // consolidado) e o corte dele 1 GWh maior por isso, nao pode reprovar: diz "safra" e nao compara
  { const e5 = clone(E), b5 = clone(B);
    const ultMes = ((e5.serie || []).filter((s) => s.frustrada_mwh != null && s.mes >= '2026-03').slice(-1)[0] || {}).mes;
    const uE = (e5.serie_diaria || []).filter((d) => String(d.dia).slice(0, 7) === ultMes).map((d) => d.dia).sort().pop();
    if (ultMes && uE) {
      const prox = new Date(Date.parse(ultMes + '-01T00:00:00Z')); prox.setUTCMonth(prox.getUTCMonth() + 1);
      e5.mes = Object.assign({}, e5.mes, { mes: prox.toISOString().slice(0, 7) });
      // um dia a mais so no benchmark; no ultimo dia do mes, um dia a menos so no executivo — a mesma safra diferente
      const dMais = new Date(Date.parse(uE + 'T00:00:00Z') + 86400e3).toISOString().slice(0, 10);
      if (dMais.slice(0, 7) === ultMes) (b5.serie_dia || (b5.serie_dia = [])).push({ dia: dMais, fonte: 'solar', nosso_cortado_gwh: 1 });
      else e5.serie_diaria = (e5.serie_diaria || []).filter((d) => d.dia !== uE);
      // isolado da lista (os dois lados sem ela): o controle julga so a regra da safra, em qualquer estado do benchmark
      e5.ref_conjunto_pela_soma = []; (e5.serie_diaria || []).forEach((d) => { d.ref_pela_soma = 0; });
      b5.ref_conjunto_pela_soma_lida = []; b5.ref_conjunto_pela_soma_aplicada = []; b5.ref_conjunto_pela_soma_sem_defeito = [];
      const bmm = (b5.serie || []).find((x) => x.fonte === 'solar' && x.mes === ultMes); if (bmm) bmm.nosso_cortado_gwh_maior_zero += 1;
      const r5 = julgaProduto(e5, b5, lib);
      const safra = (r5.avisos || []).some((x) => x.startsWith(ultMes + ': safra'));
      console.log('   ' + rot + ' · controle "a virada do mes": ' + (!r5.erros.length && safra ? 'safra, sem reprovar' : 'ERRADO ' + r5.erros.join('; ')));
      if (r5.erros.length || !safra) f.push(rot + ': a virada do mes reprovou ou nao disse safra');
    }
  }
  for (const [nome, muda] of forjados) {
    const e2 = clone(E), b2 = clone(B); muda(e2, b2);
    const rr = julgaProduto(e2, b2, lib);
    console.log('   ' + rot + ' · plantio "' + nome + '": ' + (rr.erros.length ? 'reprovou (' + rr.erros[0].slice(0, 90) + ')' : 'PASSOU'));
    if (!rr.erros.length) f.push(rot + ': o plantio "' + nome + '" passou — o ensaio nao o pega');
  }
}
function fim() {
  if (f.length) { console.error('\nREPROVADO:'); f.forEach((x) => console.error('   🔴 ' + x)); process.exit(1); }
  console.log('\nensaio-ref-conjunto' + (PRODUTO ? ' --produto' : '') + ': ' + R.length + ' casos e ' + PLANTIOS.length + ' plantios · TUDO PASSOU');
}
if (PRODUTO) produto().then(fim, (e) => { console.error('ensaio-ref-conjunto --produto: ' + e.message); process.exit(1); });
else fim();
