'use strict';
/*
 * ensaio-way2-mes.js — prova o substituto do fluxo "Way2 → Azure Blob Sync" (gen-way2-mes.js) sem tocar na API nem no blob.
 *
 * As grades fabricadas têm a forma real da API com ConsiderarMesCheio: 61 dias por ponto a partir do 1º do mês pedido, com valor
 * até hoje e os dias futuros sem valor (qualidade 1).
 *   1. as três chamadas são as do fluxo, PARÂMETRO A PARÂMETRO (os mesmos oito, com os mesmos valores);
 *   2. guarda de forma e conteúdo: BOM passa; corpo de erro, HTML, ponto faltando, ponto DUPLICADO, grade toda nula e ponto com
 *      valor em menos da metade dos dias fechados estouram; no dia 1º (mês sem dia fechado) a grade nula do mês corrente passa;
 *   3. comparação ponto × dia: diferença viva é aceita; em dia fechado reprova (valor, QUALIDADE ou nulo × 0); ausência reprova;
 *   4. dias vivos pela gravação do fluxo, em BRT: às 22:30 BRT (já amanhã em UTC) ontem continua vivo; fluxo velho alarga a
 *      janela; no dia 1º a véspera cai no mês anterior;
 *   5. main em sombra: nada gravado; igual -> 0; dia fechado diferente -> 1; ontem diferente -> 0; virada do mês com o fluxo
 *      ainda no mês anterior -> 0, sem comparação;
 *   6. main padrão: grava o corpo EXATO (BOM incluído); corpo de erro e grade nula não viram blob.
 */
const assert = require('assert');
const W = require('./gen-way2-mes');

const ENERGIA = [6368, 6369, 6373, 6374, 6375, 6376, 6215, 6378, 6219];
const MUST = [6380, 6381, 6382, 6383, 6384, 6385, 6386, 6387, 6388];
const DIA = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
/* grade de 61 dias desde o 1º de `mes` (AAAA-MM); valor ate `ate` (inclusive), futuros sem valor; `mexe(p, dia)` altera */
function grade(ids, mes, ate, mexe, extra) {
  const t0 = Date.parse(mes + '-01T00:00:00Z');
  const dias = Array.from({ length: 61 }, (_, i) => iso(t0 + i * DIA));
  return Object.assign({ inicio: 'x', fim: 'y', dataInicio: mes + '-01T00:00:00', intervalo: 'UmDia',
    dados: ids.map((p) => ({ pontoId: p, ultimaColeta: null, nomeGrandeza: 'G',
      valores: dias.map((d, i) => Object.assign(d <= ate ? { data: d + 'T00:00:00', valor: 1000 * p + i, qualidade: 0 } : { data: d + 'T00:00:00', qualidade: 1 },
        mexe ? mexe(p, d) : {})) })) }, extra || {});
}
const txt = (o) => '﻿' + JSON.stringify(o);
const AGORA = Date.parse('2026-10-18T14:00:00-03:00');
const HOJE = '2026-10-18';
let n = 0;
const caso = async (nome, f) => { await f(); n++; console.log('ok · ' + nome); };

(async () => {
  const log = console.log;
  console.log = (...a) => { if (/^ok · |^ensaio-way2-mes/.test(String(a[0]))) log(...a); };
  try {
    await caso('as três chamadas do fluxo, parâmetro a parâmetro', () => {
      const comum = { contextodasdatas: 'ConsiderarMesCheio', intervalo: 'UmDia', aplicarhorariodeverao: 'false', separardadoscomcpsemcp: 'false', 'medicao-hasvalue': 'false' };
      const esperado = {
        'way2_energia_mes.json': Object.assign({ ids: ENERGIA.join(','), grandezas: 'EneatLiquida', 'medicao-temporelativo': 'EsteMes' }, comum),
        'way2_energia_antmes.json': Object.assign({ ids: ENERGIA.join(','), grandezas: 'EneatLiquida', 'medicao-temporelativo': 'MesPassado' }, comum),
        'way2_must.json': Object.assign({ ids: MUST.join(','), grandezas: 'Demat', 'medicao-temporelativo': 'EsteMes' }, comum),
      };
      assert.deepStrictEqual(W.CHAMADAS.map((c) => c.blob), Object.keys(esperado));
      for (const c of W.CHAMADAS) {
        const q = new URLSearchParams(c.q), obj = {};
        for (const [k, v] of q) { assert.ok(!(k in obj), c.blob + ': parametro repetido ' + k); obj[k] = v; }
        assert.deepStrictEqual(obj, esperado[c.blob], c.blob);
        assert.strictEqual(c.ids, esperado[c.blob].ids);
      }
    });
    await caso('guarda de forma e de conteúdo', () => {
      const E = ENERGIA.join(',');
      W.confere(txt(grade(ENERGIA, '2026-10', HOJE)), E, 'x', HOJE);
      assert.throws(() => W.confere('{"message":"Unauthorized"}', E, 'x', HOJE), /sem a lista/);
      assert.throws(() => W.confere('<html>erro</html>', E, 'x', HOJE), /nao e JSON/);
      const menos = grade(ENERGIA, '2026-10', HOJE); menos.dados.shift();
      assert.throws(() => W.confere(JSON.stringify(menos), E, 'x', HOJE), /faltam 6368/);
      const dup = grade(ENERGIA, '2026-10', HOJE); dup.dados.push(Object.assign({}, dup.dados[0]));
      assert.throws(() => W.confere(JSON.stringify(dup), E, 'x', HOJE), /10 pontos/);
      const nula = grade(ENERGIA, '2026-10', '2026-09-30');   /* nenhum dia de outubro com valor */
      assert.throws(() => W.confere(JSON.stringify(nula), E, 'x', HOJE), /valor em so 0 de 17 dias fechados/);
      const meia = grade(ENERGIA, '2026-10', HOJE, (p, d) => (p === 6215 && d < '2026-10-10' ? { valor: undefined } : {}));
      assert.throws(() => W.confere(JSON.stringify(meia), E, 'x', HOJE), /6215 com valor em so 8 de 17/);
      const umFuro = grade(ENERGIA, '2026-10', HOJE, (p, d) => (p === 6215 && d === '2026-10-05' ? { valor: undefined } : {}));
      W.confere(JSON.stringify(umFuro), E, 'x', HOJE);
      W.confere(JSON.stringify(grade(ENERGIA, '2026-11', '2026-10-31')), E, 'x', '2026-11-01');   /* dia 1º: nada fechado */
    });
    await caso('comparação ponto × dia', () => {
      const E = ENERGIA.join(','), ok = (o) => W.confere(JSON.stringify(o), E, 'x', HOJE), base = grade(ENERGIA, '2026-10', HOJE);
      const vivos = ['2026-10-17', '2026-10-18'];
      let r = W.compara(ok(base), ok(grade(ENERGIA, '2026-10', HOJE)), vivos);
      assert.deepStrictEqual([r.iguais, r.vivos.length, r.fechados.length, r.ausentes.length], [549, 0, 0, 0]);
      r = W.compara(ok(grade(ENERGIA, '2026-10', HOJE, (p, d) => (d === HOJE ? { valor: 1 } : {}))), ok(base), vivos);
      assert.deepStrictEqual([r.vivos.length, r.fechados.length], [9, 0]);
      r = W.compara(ok(grade(ENERGIA, '2026-10', HOJE, (p, d) => (d === '2026-10-16' && p === 6215 ? { valor: 1 } : {}))), ok(base), vivos);
      assert.deepStrictEqual([r.vivos.length, r.fechados.length], [0, 1]);
      r = W.compara(ok(grade(ENERGIA, '2026-10', HOJE, (p, d) => (d === '2026-10-16' && p === 6215 ? { qualidade: 2 } : {}))), ok(base), vivos);
      assert.strictEqual(r.fechados.length, 1, 'so a qualidade mudou');
      const zero = grade(ENERGIA, '2026-10', HOJE, (p, d) => (d === '2026-10-16' && p === 6215 ? { valor: 0 } : {}));
      const nulo = grade(ENERGIA, '2026-10', HOJE, (p, d) => (d === '2026-10-16' && p === 6215 ? { valor: null } : {}));
      r = W.compara(ok(zero), ok(nulo), vivos);
      assert.strictEqual(r.fechados.length, 1, 'nulo nao e zero');
      const curta = grade(ENERGIA, '2026-10', HOJE); curta.dados.forEach((d) => d.valores.pop());
      r = W.compara(ok(curta), ok(base), vivos);
      assert.strictEqual(r.ausentes.length, 9);
    });
    await caso('dias vivos pela gravação do fluxo, em BRT', () => {
      const fl = Date.parse('2026-10-18T10:00:03Z');
      assert.deepStrictEqual(W.diasVivos(fl, AGORA), ['2026-10-17', '2026-10-18']);
      assert.deepStrictEqual(W.diasVivos(fl, Date.parse('2026-10-18T22:30:00-03:00')), ['2026-10-17', '2026-10-18'], '22:30 BRT ja e dia 19 em UTC');
      assert.deepStrictEqual(W.diasVivos(Date.parse('2026-10-15T12:00:00Z'), AGORA), ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18']);
      assert.deepStrictEqual(W.diasVivos(Date.parse('2026-11-01T06:00:00Z'), Date.parse('2026-11-01T10:00:00-03:00')), ['2026-10-31', '2026-11-01']);
      assert.deepStrictEqual(W.diasVivos(NaN, AGORA), ['2026-10-17', '2026-10-18']);
    });
    const FLUXO_LM = 'Sun, 18 Oct 2026 16:50:03 GMT';
    const api = (mes, ate, mexe) => async (q) => txt(grade(/ids=638/.test(q) ? MUST : ENERGIA, /MesPassado/.test(q) ? (mes === '2026-10' ? '2026-09' : '2026-10') : mes, ate, mexe));
    const le = (mes, ate, mexe, lm) => async (nome) => ({ texto: txt(grade(/must/.test(nome) ? MUST : ENERGIA, /antmes/.test(nome) ? (mes === '2026-10' ? '2026-09' : '2026-10') : mes, ate, mexe)), modificado: lm || FLUXO_LM });
    await caso('main em sombra', async () => {
      const gravados = [], grava = async (nome) => gravados.push(nome);
      const roda = (a, l, agora) => W.main({ api: a, le: l, grava, agora: agora || AGORA, sombra: true });
      assert.strictEqual(await roda(api('2026-10', HOJE), le('2026-10', HOJE)), 0);
      assert.strictEqual(await roda(api('2026-10', HOJE, (p, d) => (d === '2026-10-16' ? { valor: 5 } : {})), le('2026-10', HOJE)), 1, 'dia fechado');
      assert.strictEqual(await roda(api('2026-10', HOJE, (p, d) => (d === '2026-10-17' ? { valor: 5 } : {})), le('2026-10', HOJE)), 0, 'ontem e vivo');
      assert.strictEqual(await roda(api('2026-10', HOJE), le('2026-10', HOJE, (p, d) => (d === '2026-09-29' ? { valor: 5 } : {}))), 1, 'antmes fechado');
      /* virada: 01/11 00:04 BRT, a leitura nova ja e novembro e o fluxo (gravou 31/10 23:59 BRT) ainda outubro */
      const virada = Date.parse('2026-11-01T00:04:00-03:00');
      assert.strictEqual(await roda(api('2026-11', '2026-10-31'), le('2026-10', '2026-10-31', null, 'Sun, 01 Nov 2026 02:59:59 GMT'), virada), 0, 'virada do mes');
      assert.strictEqual(gravados.length, 0);
    });
    await caso('main padrão: corpo exato; erro e grade nula não viram blob', async () => {
      const gravados = [], grava = async (nome, texto) => gravados.push([nome, texto]);
      assert.strictEqual(await W.main({ api: api('2026-10', HOJE), le: le('2026-10', HOJE), grava, agora: AGORA, sombra: false }), 0);
      assert.deepStrictEqual(gravados.map((g) => g[0]), ['way2_energia_mes.json', 'way2_energia_antmes.json', 'way2_must.json']);
      assert.strictEqual(gravados[0][1], txt(grade(ENERGIA, '2026-10', HOJE)));
      assert.strictEqual(gravados[0][1].charCodeAt(0), 0xFEFF);
      gravados.length = 0;
      await assert.rejects(W.main({ api: async () => '{"message":"erro"}', le: le('2026-10', HOJE), grava, agora: AGORA, sombra: false }), /sem a lista/);
      await assert.rejects(W.main({ api: api('2026-10', '2026-09-30'), le: le('2026-10', HOJE), grava, agora: AGORA, sombra: false }), /dias fechados/);
      assert.strictEqual(gravados.length, 0);
    });
  } finally { console.log = log; }
  console.log('ensaio-way2-mes: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
