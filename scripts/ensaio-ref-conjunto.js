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
/* A RETENCAO DO DIA QUE NAO FECHA (PROMOVER ref-retem-dia): sai o dia INTEIRO (as nove usinas e os agregados), os outros
   ficam, o `desde` da publicacao anterior e carregado, e o vencimento cai logo depois de LIMITE_RETIDO_H e nao antes. */
function julgaRetencao(lib) {
  const e = [];
  const ENT = USINAS.concat(['Complexo', 'PPA', 'ML']);
  const linhas = ['2026-10-01', '2026-10-02'].flatMap((d) => ENT.map((u) => ({ dia: d, ufv: u, ref_mwh: 1 })));
  const ruins = [{ dia: '2026-10-01', ref_mwh: 2579.45, gref_mwh: 617.96 }];
  const antes = '2026-10-10T12:00:00.000Z', agora = '2026-10-11T00:00:00.000Z';
  const r1 = lib.retemDias(linhas, ruins, {}, agora);
  if (r1.linhas.some((x) => x.dia === '2026-10-01')) e.push('retemDias: ficou linha do dia retido (' + r1.linhas.filter((x) => x.dia === '2026-10-01').map((x) => x.ufv).join(',') + ')');
  if (r1.linhas.filter((x) => x.dia === '2026-10-02').length !== ENT.length) e.push('retemDias: mexeu no dia que fecha');
  if (r1.retidos.length !== 1 || r1.retidos[0].desde !== agora) e.push('retemDias: o dia novo nao saiu retido desde agora');
  const r2 = lib.retemDias(linhas, ruins, { '2026-10-01': antes }, agora);
  if (r2.retidos[0].desde !== antes) e.push('retemDias: nao carregou o desde da publicacao anterior');
  const t0 = Date.parse(antes), H = 3600e3, L = lib.LIMITE_RETIDO_H;
  // preso por baixo no pior caso derivado (a rodada das 16:13Z so fecha na das 19:13Z do dia seguinte: 27 h) — RE-044
  if (!(L >= 27 && L < 48)) e.push('o limite da retencao saiu da cadencia das fontes (' + L + ' h)');
  if (lib.retidosVencidos([{ dia: 'x', desde: antes }], t0 + (L - 0.5) * H).length) e.push('retidosVencidos: venceu antes do limite');
  if (lib.retidosVencidos([{ dia: 'x', desde: antes }], t0 + (L + 0.5) * H).length !== 1) e.push('retidosVencidos: nao venceu depois do limite');
  if (lib.retidosVencidos([{ dia: 'x', desde: 'lixo' }], t0).length !== 1) e.push('retidosVencidos: um desde ilegivel nao venceu (a retencao calaria)');
  /* a SEGUNDA ROTA do dia retido (RE-042), com os dois arquivos do operador forjados: as nove usinas somam 100 MWh no dia e o
     conjunto 25 (a revisao velha). O legitimo passa; o defeito nosso, o gref de outro lugar, o dia que fecha, o dia ainda no
     ref_hora, a usina faltando no arquivo e o retido sem segunda rota reprovam. */
  const D = '2026-10-01', agoraMs = Date.parse(agora);
  const cruU = () => ({ '2026-10': USINAS.map((u) => ({ ts: D + ' 12:00:00', u: u.replace('M', 'CEFMT'), ge: 200 / 9 })) });
  const conj = (g) => [{ ts: D + ' 12:00:00', gref: g, ger: 40, disp: 343.5 }];
  const base = () => ({ ref_dia_ufv: [{ dia: '2026-10-02', ufv: 'Complexo', ref_mwh: 1 }], ref_dias_retidos: [{ dia: D, ref_mwh: 100, gref_mwh: 25, desde: agora }],
    serie_diaria: [{ dia: D, ref_retido: 1 }, { dia: '2026-10-02', ref_retido: 0 }] });
  const fontes = (o) => Object.assign({ cruUsina: cruU(), conjunto: conj(50), refHoraDias: new Set(['2026-10-02']) }, o || {});
  const CASOS_R = [
    ['retencao legitima (os dois arquivos do operador discordam)', base(), fontes(), false],
    ['a referencia retida nao e a soma das usinas (defeito nosso)', Object.assign(base(), { ref_dias_retidos: [{ dia: D, ref_mwh: 150, gref_mwh: 25, desde: agora }] }), fontes(), true],
    ['o gref retido nao e o do arquivo do conjunto', Object.assign(base(), { ref_dias_retidos: [{ dia: D, ref_mwh: 100, gref_mwh: 30, desde: agora }] }), fontes(), true],
    ['os dois arquivos fecham (nada a reter)', Object.assign(base(), { ref_dias_retidos: [{ dia: D, ref_mwh: 100, gref_mwh: 100, desde: agora }] }), fontes({ conjunto: conj(200) }), true],
    ['o dia retido ainda no ref_hora', base(), fontes({ refHoraDias: new Set([D]) }), true],
    ['o dia retido ainda no ref_dia_ufv', Object.assign(base(), { ref_dia_ufv: [{ dia: D, ufv: 'Complexo', ref_mwh: 100 }] }), fontes(), true],
    ['a usina faltando no arquivo do operador', base(), fontes({ cruUsina: { '2026-10': cruU()['2026-10'].filter((r) => r.u !== 'CEFMT9') } }), true],
    ['retido sem a segunda rota', base(), null, true],
    // RE-047: o arquivo do conjunto regravado depois do executivo (a retencao se resolvendo) — o gref nao bate, e NAO reprova
    ['duas safras (o conjunto gravado depois do executivo)', base(), fontes({ conjunto: conj(4888.3), safraNova: ['ons_restricao_all.json'] }), false],
    // RE-052: data ilegivel nao e safra nova — reprova; RE-053: o ref_hora se confere mesmo com a safra nova
    ['sem a data do arquivo para julgar a safra', base(), fontes({ semData: ['ons_restricao_all.json (last-modified)'] }), true],
    ['duas safras e o dia retido ainda no ref_hora', base(), fontes({ conjunto: conj(4888.3), safraNova: ['ons_restricao_all.json'], refHoraDias: new Set([D]) }), true],
    // RE-048: a marca na serie_diaria
    ['a marca ausente no dia retido', Object.assign(base(), { serie_diaria: [{ dia: D, ref_retido: 0 }, { dia: '2026-10-02', ref_retido: 0 }] }), fontes(), true],
    ['a marca num dia que nao esta retido', Object.assign(base(), { serie_diaria: [{ dia: D, ref_retido: 1 }, { dia: '2026-10-02', ref_retido: 1 }] }), fontes(), true],
    ['a serie_diaria sem o campo da marca', Object.assign(base(), { serie_diaria: [{ dia: D }, { dia: '2026-10-02' }] }), fontes(), true],
  ];
  for (const [nome, E5, F5, reprova] of CASOS_R) {
    const r = julgaRetidos(E5, agoraMs, lib, F5);
    if (reprova !== (r.erros.length > 0)) e.push('segunda rota: "' + nome + '" ' + (reprova ? 'passou' : 'reprovou (' + r.erros.join('; ') + ')'));
  }
  return e;
}
const RT_ = julgaRetencao(compila(src));
RT_.forEach((x) => f.push('a retencao errou: ' + x));
console.log('   retencao do dia: ' + (RT_.length ? RT_.length + ' erro(s)' : 'sai o dia inteiro, o desde e carregado, vence logo depois de ' + compila(src).LIMITE_RETIDO_H + ' h'));
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
  ['a retencao so do Complexo', 'linhas: (refDiaUfv || []).filter((x) => !fora.has(x.dia))', "linhas: (refDiaUfv || []).filter((x) => !(fora.has(x.dia) && x.ufv === 'Complexo'))"],
  ['a retencao sem carregar o desde', 'desde: (desdeAntes || {})[x.dia] || agoraIso', 'desde: agoraIso'],
  ['a retencao com o limite frouxo', 'const LIMITE_RETIDO_H = 27;', 'const LIMITE_RETIDO_H = 1e9;'],
  ['a retencao com o limite abaixo do pior caso', 'const LIMITE_RETIDO_H = 27;', 'const LIMITE_RETIDO_H = 24;'],
  ['o desde ilegivel nao vence', '!(Date.parse(x.desde) > 0) || ', ''],
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
  const erros = julga(lm).filter((x) => !x.ok).map((x) => x.nome).concat(julgaCorrecao(lm), julgaLista(lm), julgaRetencao(lm));
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
  "if (!/^404 /.test(String(e.message))) throw",
  // o dia que nao fecha e retido, sai do ref_hora tambem, e a lista sai publicada (PROMOVER ref-retem-dia)
  'RC.retemDias(', 'ref_dias_retidos: refRetidos', 'if (diasRetidos.has(dia)) continue;',
  // e o dia retido marcado na serie_diaria (RE-045)
  'DIA[x.dia].ref_retido = 1', 'ref_retido: d.ref_retido ? 1 : 0'];
/* e a ORDEM: a correcao tem de vir antes do corte do conjunto (secao 1), senao ela so mexe no que ja foi apurado */
const SECAO1 = '// ---------- 1) complexo por m';
const VELHO = "throw new Error('ref_dia_ufv: a referencia do Complexo, somada das usinas, nao fecha";   // o throw que parava tudo
const fiacao = (s) => FIOS.filter((x) => !s.includes(x)).concat(s.includes(VELHO) ? ['o throw antigo do dia que nao fecha voltou'] : [])
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
const comVelho = gen + '\n' + VELHO + "')";
if (!fiacao(comVelho).includes('o throw antigo do dia que nao fecha voltou')) f.push('a conferencia da fiacao nao acusa o throw antigo de volta');
console.log('   o throw antigo do dia que nao fecha de volta: ' + (fiacao(comVelho).includes('o throw antigo do dia que nao fecha voltou') ? 'acusado' : 'NAO acusado'));
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
/* a mesma leitura, devolvendo tambem o last-modified (a safra do arquivo, para a segunda rota do dia retido) */
function pegaData(nome) {
  const https = require('https'), zlib = require('zlib');
  return new Promise((ok, ko) => https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return ko(new Error(nome + ': HTTP ' + r.statusCode)); }
    const ch = []; r.on('data', (d) => ch.push(d));
    r.on('end', () => { try { let b = Buffer.concat(ch); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
      ok({ j: JSON.parse(b.toString('utf8')), mod: r.headers['last-modified'] }); } catch (e) { ko(e); } });
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
  // o mes com dia RETIDO (PROMOVER ref-retem-dia): o corte do executivo nele sai do conjunto na revisao velha e o benchmark le
  // o CSV na nova — os dois divergem por definicao enquanto a retencao durar; quem vigia o dia retido e o julgaRetidos
  (E.ref_dias_retidos || []).forEach((x) => { const m = String(x.dia).slice(0, 7);
    if (!foraMes.has(m)) { foraMes.add(m); avisos.push(m + ': mes com dia retido (' + x.dia + '), fora da comparacao mensal'); } });
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
/* a RETENCAO no produto (PROMOVER ref-retem-dia): o campo existe, o dia retido nao tem linha no ref_dia_ufv, retido alem de
   LIMITE_RETIDO_H reprova — e a SEGUNDA ROTA (revisor-ensaio, RE-042): a retencao so e legitima quando o descompasso e entre os
   dois arquivos do OPERADOR. A soma das nove usinas do arquivo POR USINA tem de ser a referencia que o executivo calculou (senao
   o defeito e NOSSO: usina lida em dobro, faltando, trocada), o gref tem de ser o do arquivo do CONJUNTO, e os dois tem de
   discordar entre si; e o dia nao pode estar no ref_hora. `fontes` = { cruUsina: {mes: linhas}, conjunto: linhas, refHoraDias:
   Set } — no produto, os arquivos publicados (baixados so quando ha dia retido); na regra, forjados. */
function julgaRetidos(E, agoraMs, lib, fontes) {
  const e = [], R = E.ref_dias_retidos, av = [];
  if (!Array.isArray(R)) return { erros: ['executivo sem ref_dias_retidos'], avisos: [] };
  const comLinha = new Set((E.ref_dia_ufv || []).map((x) => x.dia));
  R.forEach((x) => { if (comLinha.has(x.dia)) e.push('ref_dias_retidos: ' + x.dia + ' retido mas ainda no ref_dia_ufv'); });
  lib.retidosVencidos(R, agoraMs).forEach((x) => e.push('ref_dias_retidos: ' + x.dia + ' retido desde ' + x.desde + ', alem de ' + lib.LIMITE_RETIDO_H
    + ' h — os arquivos por usina e do conjunto nao voltaram a fechar (ref ' + x.ref_mwh + ' x conjunto ' + x.gref_mwh + ' MWh)'));
  // a MARCA do dia retido na serie_diaria (RE-048): 1 em cada dia retido que esta na janela, 0 em todos os outros, sempre presente
  const retidos = new Set(R.map((x) => x.dia));
  for (const d of E.serie_diaria || []) {
    if (d.ref_retido == null) { e.push('serie_diaria ' + d.dia + ' sem a marca ref_retido'); break; }
    if (d.ref_retido !== (retidos.has(d.dia) ? 1 : 0)) e.push('serie_diaria ' + d.dia + ': ref_retido ' + d.ref_retido + (retidos.has(d.dia) ? ' num dia retido' : ' num dia que nao esta retido'));
  }
  if (R.length && !fontes) e.push('ref_dias_retidos: dia retido sem a segunda rota (os arquivos do operador nao foram lidos)');
  /* a SAFRA da segunda rota (RE-047): os arquivos do operador sao lidos minutos depois do gerador, e o estado retido e
     justamente aquele em que o operador os regrava. Arquivo gravado depois do executivo montado (menos 15 min, a regra do
     ensaio-disp-declarada): a segunda rota diz que NAO JULGOU e nao reprova; o vencimento de 27 h continua valendo. */
  // o ref_hora e produto NOSSO, gravado na mesma rodada: o dia retido fora dele se confere sempre, com ou sem safra (RE-053)
  if (fontes && fontes.refHoraDias) R.forEach((x) => { if (fontes.refHoraDias.has(x.dia)) e.push('ref_dias_retidos: ' + x.dia + ': retido mas ainda no ref_hora'); });
  // data ILEGIVEL nao e safra nova: sem ela nao ha como julgar, e calar a segunda rota em toda rodada esconderia o defeito
  // nosso por 27 h (RE-052)
  if (R.length && fontes && (fontes.semData || []).length) e.push('ref_dias_retidos: sem a data para julgar a safra (' + fontes.semData.join(', ') + ')');
  let rodou = false;
  if (R.length && fontes && (fontes.safraNova || []).length) {
    av.push('segunda rota NAO JULGADA (duas safras: ' + fontes.safraNova.join(', ') + ' gravado(s) depois do executivo) — a proxima rodada julga');
    fontes = null;
  }
  if (fontes && R.length) rodou = true;
  for (const x of fontes ? R : []) {
    const por = {}, id = 'ref_dias_retidos: ' + x.dia;
    for (const r of fontes.cruUsina[String(x.dia).slice(0, 7)] || []) {
      if (String(r.ts).slice(0, 10) !== x.dia) continue;
      const u = String(r.u).replace('CEFMT', 'M'); if (!USINAS.includes(u)) continue;
      por[u] = (por[u] || 0) + (Number(r.ge) || 0) * 0.5;
    }
    const faltam = USINAS.filter((u) => por[u] == null);
    if (faltam.length) { e.push(id + ': o arquivo por usina do operador nao tem ' + faltam.join(',') + ' no dia'); continue; }
    const somaU = USINAS.reduce((s2, u) => s2 + por[u], 0);
    let grefCru = 0, nCru = 0;
    for (const r of fontes.conjunto || []) if (String(r.ts).slice(0, 10) === x.dia) { grefCru += (Number(r.gref) || 0) * 0.5; nCru++; }
    if (Math.abs(somaU - x.ref_mwh) > 0.011) e.push(id + ': a referencia retida (' + x.ref_mwh + ') nao e a soma das usinas do arquivo do operador ('
      + somaU.toFixed(2) + ') — o defeito e NOSSO, nao do operador');
    if (!nCru) e.push(id + ': o arquivo do conjunto nao tem o dia');
    else if (Math.abs(grefCru - x.gref_mwh) > 0.011) e.push(id + ': o gref retido (' + x.gref_mwh + ') nao e o do arquivo do conjunto (' + grefCru.toFixed(2) + ')');
    if (Math.abs(somaU - grefCru) <= lib.FOLGA_DIA) e.push(id + ': os dois arquivos do operador FECHAM (' + somaU.toFixed(2) + ' x ' + grefCru.toFixed(2) + ') — nao ha o que reter');
  }
  return { erros: e, rodou, avisos: R.map((x) => x.dia + ' retido desde ' + x.desde + ' (' + x.ref_mwh + ' x ' + x.gref_mwh + ')').concat(av) };
}
async function produto() {
  const lib = compila(src);
  const [E, B] = await Promise.all([pega('executivo.json'), pega('benchmark_ne.json')]);
  { const R = E.ref_dias_retidos || [];
    let fontes = null;
    if (R.length) {   // a segunda rota so custa download quando ha dia retido
      const meses = [...new Set(R.map((x) => String(x.dia).slice(0, 7)))];
      const cruUsina = {}, safraNova = [], semData = [];
      const montado = Date.parse(E.atualizado || '') || 0;
      if (!montado) semData.push('executivo.atualizado');
      const novo = (nome, mod) => { const t = Date.parse(mod || '');
        if (!(t > 0)) semData.push(nome + ' (last-modified)'); else if (montado && t > montado - 15 * 60000) safraNova.push(nome); };
      for (const m of meses) { const n = 'ons_irradiancia_' + m.replace('-', '_') + '.json', x = await pegaData(n); cruUsina[m] = x.j.consolidado; novo(n, x.mod); }
      const [O, Hr] = await Promise.all([pegaData('ons_restricao_all.json'), pega('ref_hora.json')]);
      novo('ons_restricao_all.json', O.mod);
      fontes = { cruUsina, conjunto: O.j.consolidado, refHoraDias: new Set((Hr.dias || []).map((d) => d.dia)), safraNova, semData };
    }
    const rr = julgaRetidos(E, Date.now(), lib, fontes);
    rr.erros.forEach((x) => f.push('retencao: ' + x));
    console.log('   retencao: ' + R.length + ' dia(s) retido(s)' + (rr.rodou ? ', conferido(s) contra os dois arquivos do operador' : ''));
    rr.avisos.forEach((x) => console.log('   ⚠️ ' + x));
  }
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
  /* A BASE dos plantios e controles: o par real com as listas CONSISTENTES (o benchmark leu e aplicou a lista do executivo, o
     dia da lista igual nos dois) e, com a lista real VAZIA, um patamar sintetico num dia presente nas duas series. Sem isso,
     com a lista vazia (o operador republicou certo, ou a fase de uma retencao) os plantios de lista nao teriam o que plantar,
     "passariam" e o ensaio reprovaria um estado legitimo. A base tem de estar LIMPA: plantio que reprova sobre base suja nao
     prova nada. */
  const E0 = clone(E), B0 = clone(B);
  if (!(E0.ref_conjunto_pela_soma || []).length) {
    const bDias = new Set((B0.serie_dia || []).filter((d) => d.fonte === 'solar' && d.nosso_cortado_gwh != null).map((d) => d.dia));
    const d = (E0.serie_diaria || []).filter((x) => x.cortado_mwh != null && bDias.has(x.dia)).map((x) => x.dia).sort().pop();
    if (d) {
      E0.ref_conjunto_pela_soma = [{ ts: d + ' 12:00', gref_publicado: 10, disp_publicada: 5, ger: 20, soma_usinas: 100 }];
      (E0.serie_diaria || []).forEach((x) => { if (x.dia === d) x.ref_pela_soma = (x.ref_pela_soma || 0) + 1; });
    }
  }
  const tsE0 = (E0.ref_conjunto_pela_soma || []).map((x) => String(x.ts));
  B0.ref_conjunto_pela_soma_lida = tsE0.slice(); B0.ref_conjunto_pela_soma_aplicada = tsE0.slice(); B0.ref_conjunto_pela_soma_sem_defeito = [];
  tsE0.forEach((ts) => { const dia = ts.slice(0, 10), x = (E0.serie_diaria || []).find((y) => y.dia === dia),
    b = (B0.serie_dia || []).find((y) => y.fonte === 'solar' && y.dia === dia); if (x && b && x.cortado_mwh != null) b.nosso_cortado_gwh = Math.round(x.cortado_mwh / 10) / 100; });
  const r0 = julgaProduto(E0, B0, lib);
  if (!tsE0.length) f.push(rot + ': sem dia comum as duas series para montar a base dos plantios');
  if (r0.erros.length) f.push(rot + ': a base dos plantios nao esta limpa (' + r0.erros[0] + ')');
  console.log('   ' + rot + ' · base dos plantios: ' + ((E.ref_conjunto_pela_soma || []).length ? 'a lista real' : 'patamar sintetico em ' + (tsE0[0] || '—'))
    + ', ' + (r0.erros.length ? 'SUJA' : 'limpa'));
  // o mes do plantio mensal e um que a comparacao da base JULGOU (nunca o tirado por safra): o ultimo comparado
  const mesJulgado = (r0.mesesComparados || []).slice(-1)[0];
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
  if ((E0.ref_conjunto_pela_soma || []).length) {
    const e3 = clone(E0), b3 = clone(B0); b3.ref_conjunto_pela_soma_lida = []; b3.ref_conjunto_pela_soma_aplicada = [];
    const r3 = julgaProduto(e3, b3, lib);
    console.log('   ' + rot + ' · controle "rodada de atraso": ' + (!r3.julgado && !r3.erros.length ? 'nao julgado, sem reprovar' : 'ERRADO'));
    if (r3.julgado || r3.erros.length) f.push(rot + ': a rodada de atraso foi julgada ou reprovada');
    const e4 = clone(E0), b4 = clone(B0), L4 = E0.ref_conjunto_pela_soma || [], ts4 = L4.map((x) => String(x.ts));
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
      // isolado da lista (os dois lados sem ela) e da retencao: o controle julga so a regra da safra, em qualquer estado
      e5.ref_conjunto_pela_soma = []; e5.ref_dias_retidos = []; (e5.serie_diaria || []).forEach((d) => { d.ref_pela_soma = 0; });
      b5.ref_conjunto_pela_soma_lida = []; b5.ref_conjunto_pela_soma_aplicada = []; b5.ref_conjunto_pela_soma_sem_defeito = [];
      const bmm = (b5.serie || []).find((x) => x.fonte === 'solar' && x.mes === ultMes); if (bmm) bmm.nosso_cortado_gwh_maior_zero += 1;
      const r5 = julgaProduto(e5, b5, lib);
      const safra = (r5.avisos || []).some((x) => x.startsWith(ultMes + ': safra'));
      console.log('   ' + rot + ' · controle "a virada do mes": ' + (!r5.erros.length && safra ? 'safra, sem reprovar' : 'ERRADO ' + r5.erros.join('; ')));
      if (r5.erros.length || !safra) f.push(rot + ': a virada do mes reprovou ou nao disse safra');
    }
  }
  for (const [nome, muda] of forjados) {
    const e2 = clone(E0), b2 = clone(B0); muda(e2, b2);
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
