'use strict';
/*
 * ensaio-way2-mes.js — prova o substituto do fluxo "Way2 → Azure Blob Sync" (gen-way2-mes.js) sem tocar na API nem no blob.
 *
 *   1. as três chamadas são as do fluxo: grandeza, período relativo e pontos de cada blob;
 *   2. guarda de forma: corpo com BOM passa; corpo de erro, `dados` ausente, ponto faltando ou ponto sem valores estouram;
 *   3. comparação ponto × dia: igual conta como igual; diferença em hoje/ontem (BRT) é "vivo"; em dia fechado reprova; dia ou
 *      ponto ausente reprova; no dia 1º, ontem é o último dia do mês anterior e é vivo também no `antmes`;
 *   4. main, modo sombra: nada é gravado; igual -> 0; dia fechado diferente -> 1;
 *   5. main, modo padrão: grava os três blobs com o corpo EXATO da resposta (BOM incluído); corpo que reprova a guarda não
 *      vira blob.
 */
const assert = require('assert');
const W = require('./gen-way2-mes');

const ENERGIA = [6368, 6369, 6373, 6374, 6375, 6376, 6215, 6378, 6219];
const MUST = [6380, 6381, 6382, 6383, 6384, 6385, 6386, 6387, 6388];
const corpo = (ids, dias, mexe) => '﻿' + JSON.stringify({ inicio: 'x', fim: 'y', intervalo: 'UmDia',
  dados: ids.map((p) => ({ pontoId: p, ultimaColeta: null, nomeGrandeza: 'G',
    valores: dias.map((d, i) => Object.assign({ data: d + 'T00:00:00', valor: 1000 * p + i, qualidade: 0 }, mexe ? mexe(p, d) : {})) })) });
const OUT = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19'];
const SET = ['2026-09-29', '2026-09-30'];
const AGORA = Date.parse('2026-10-18T14:00:00-03:00');
let n = 0;
const caso = async (nome, f) => { await f(); n++; console.log('ok · ' + nome); };

(async () => {
  const log = console.log;
  console.log = (...a) => { if (/^ok · |^ensaio-way2-mes/.test(String(a[0]))) log(...a); };
  try {
    await caso('as três chamadas do fluxo', () => {
      const c = Object.fromEntries(W.CHAMADAS.map((x) => [x.blob, x.q]));
      assert.ok(/grandezas=EneatLiquida/.test(c['way2_energia_mes.json']) && /temporelativo=EsteMes/.test(c['way2_energia_mes.json']));
      assert.ok(/grandezas=EneatLiquida/.test(c['way2_energia_antmes.json']) && /temporelativo=MesPassado/.test(c['way2_energia_antmes.json']));
      assert.ok(/grandezas=Demat&/.test(c['way2_must.json']) && /temporelativo=EsteMes/.test(c['way2_must.json']));
      assert.ok(/ids=6368,6369,6373,6374,6375,6376,6215,6378,6219&/.test(c['way2_energia_mes.json']));
      assert.ok(/ids=6380,6381,6382,6383,6384,6385,6386,6387,6388&/.test(c['way2_must.json']));
      W.CHAMADAS.forEach((x) => assert.ok(/intervalo=UmDia/.test(x.q) && /contextodasdatas=ConsiderarMesCheio/.test(x.q), x.blob));
    });
    await caso('guarda de forma', () => {
      W.confere(corpo(ENERGIA, OUT), ENERGIA.join(','), 'x');
      assert.throws(() => W.confere('{"message":"Unauthorized"}', ENERGIA.join(','), 'x'), /sem a lista/);
      assert.throws(() => W.confere('<html>erro</html>', ENERGIA.join(','), 'x'), /nao e JSON/);
      assert.throws(() => W.confere(corpo(ENERGIA.slice(1), OUT), ENERGIA.join(','), 'x'), /faltam 6368/);
      const vazio = JSON.parse(corpo(ENERGIA, OUT).slice(1)); vazio.dados[3].valores = [];
      assert.throws(() => W.confere(JSON.stringify(vazio), ENERGIA.join(','), 'x'), /sem valores/);
    });
    await caso('comparação ponto × dia', () => {
      const ok = (t) => W.confere(t, ENERGIA.join(','), 'x');
      const vivos = ['2026-10-18', '2026-10-17'];
      let r = W.compara(ok(corpo(ENERGIA, OUT)), ok(corpo(ENERGIA, OUT)), vivos);
      assert.deepStrictEqual([r.iguais, r.vivos.length, r.fechados.length, r.ausentes.length], [36, 0, 0, 0]);
      r = W.compara(ok(corpo(ENERGIA, OUT, (p, d) => (d === '2026-10-18' ? { valor: 1 } : {}))), ok(corpo(ENERGIA, OUT)), vivos);
      assert.deepStrictEqual([r.vivos.length, r.fechados.length], [9, 0]);
      r = W.compara(ok(corpo(ENERGIA, OUT, (p, d) => (d === '2026-10-16' && p === 6215 ? { valor: 1 } : {}))), ok(corpo(ENERGIA, OUT)), vivos);
      assert.deepStrictEqual([r.vivos.length, r.fechados.length], [0, 1]);
      r = W.compara(ok(corpo(ENERGIA, OUT.slice(0, 3))), ok(corpo(ENERGIA, OUT)), vivos);
      assert.strictEqual(r.ausentes.length, 9);
      /* no dia 1º, ontem e o ultimo dia do mes anterior: vivo tambem no antmes; o penultimo e fechado */
      r = W.compara(ok(corpo(ENERGIA, SET, () => ({ valor: 2 }))), ok(corpo(ENERGIA, SET)), ['2026-10-01', '2026-09-30']);
      assert.deepStrictEqual([r.vivos.length, r.fechados.length], [9, 9]);
    });
    const api = (mexe) => async (q) => corpo(/ids=638/.test(q) ? MUST : ENERGIA, /MesPassado/.test(q) ? SET : OUT, mexe);
    const le = (mexe) => async (nome) => ({ texto: corpo(/must/.test(nome) ? MUST : ENERGIA, /antmes/.test(nome) ? SET : OUT, mexe), modificado: 'x' });
    await caso('modo sombra: nada gravado; igual passa, dia fechado diferente reprova', async () => {
      const gravados = [];
      const grava = async (nome) => gravados.push(nome);
      assert.strictEqual(await W.main({ api: api(), le: le(), grava, agora: AGORA, sombra: true }), 0);
      assert.strictEqual(await W.main({ api: api((p, d) => (d === '2026-10-18' ? { valor: 5 } : {})), le: le(), grava, agora: AGORA, sombra: true }), 0, 'hoje e vivo');
      assert.strictEqual(await W.main({ api: api((p, d) => (d === '2026-10-16' ? { valor: 5 } : {})), le: le(), grava, agora: AGORA, sombra: true }), 1);
      assert.strictEqual(await W.main({ api: api(), le: le((p, d) => (d === '2026-09-30' ? { valor: 5 } : {})), grava, agora: AGORA, sombra: true }), 1);
      const DIA1 = Date.parse('2026-10-01T10:00:00-03:00');
      assert.strictEqual(await W.main({ api: api(), le: le((p, d) => (d === '2026-09-30' ? { valor: 5 } : {})), grava, agora: DIA1, sombra: true }), 0, 'dia 1: ontem e vivo no antmes');
      assert.strictEqual(gravados.length, 0);
    });
    await caso('modo padrão: grava o corpo exato; corpo ruim não vira blob', async () => {
      const gravados = [];
      const grava = async (nome, texto) => gravados.push([nome, texto]);
      assert.strictEqual(await W.main({ api: api(), le: le(), grava, agora: AGORA, sombra: false }), 0);
      assert.deepStrictEqual(gravados.map((g) => g[0]), ['way2_energia_mes.json', 'way2_energia_antmes.json', 'way2_must.json']);
      assert.strictEqual(gravados[0][1], corpo(ENERGIA, OUT));
      assert.strictEqual(gravados[0][1].charCodeAt(0), 0xFEFF);
      gravados.length = 0;
      await assert.rejects(W.main({ api: async () => '{"message":"erro"}', le: le(), grava, agora: AGORA, sombra: false }), /sem a lista/);
      assert.strictEqual(gravados.length, 0);
    });
  } finally { console.log = log; }
  console.log('ensaio-way2-mes: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
