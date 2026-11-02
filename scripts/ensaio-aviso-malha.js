'use strict';
/*
 * ensaio-aviso-malha.js — as regras do aviso da Malha (lote aviso-malha, 01/11/2026). Sem rede e sem segredo: so `decideMalha` e
 * `decideAcervo`. Prova: o dado publicado sai num evento so com a lista; `sem` avisa como `fa`; `at` e a etapa da medicao nao; a janela
 * do Acervo (noite nao avisa); sem registro do Acervo avisa; a falha do Acervo sai so como contagem e so fecha no fim da janela; nenhum
 * texto leva conta, conteiner, arquivo, caminho, maquina ou erro (repositorio publico). Cada regra tem plantio: desligada, reprova.
 * Regex sem modificador inline: o CI roda Node 20.
 */
const assert = require('assert');
const fs = require('fs');
const AM = require('./aviso-malha');

let falhas = 0;
function caso(nome, fn) {
  try { fn(AM); console.log('  ok    ' + nome); } catch (e) { falhas++; console.log('  FALHA ' + nome + '\n        ' + e.message); }
}
const brt = (s) => Date.parse(s + '-03:00');
const MALHA = {
  etapas: { portal: { st: 'sem' } },
  frescor: [
    { id: 'trafo_15', etapa: 'pub', st: 'fa', idade_min: 540, prazo_min: 30, medida: 'conteudo', ate: '2026-11-01T12:00:00Z' },
    { id: 'trafo_30', etapa: 'pub', st: 'fa', idade_min: 540, prazo_min: 60, medida: 'conteudo', ate: '2026-11-01T12:00:00Z' },
    { id: 'ons_mes', etapa: 'ons', st: 'sem', idade_min: null, prazo_min: 60, medida: 'gravacao', ate: null },
    { id: 'medidor_dia', etapa: 'pub', st: 'at', idade_min: 30, prazo_min: 26 * 60, medida: 'gravacao', ate: null },
    { id: 'medidor_5min', etapa: 'way2', st: 'fa', idade_min: 90, prazo_min: 30, medida: 'conteudo', ate: null },
    { id: 'hora_ufv', etapa: 'pub', st: 'ok', idade_min: 5, prazo_min: 120, medida: 'conteudo', ate: '2026-11-01T22:00:00Z' },
  ],
};
const BOA = { frescor: [{ id: 'hora_ufv', etapa: 'pub', st: 'ok', idade_min: 5, prazo_min: 120, medida: 'conteudo', ate: null },
  { id: 'medidor_5min', etapa: 'way2', st: 'fa', idade_min: 90, prazo_min: 30, medida: 'conteudo', ate: null }] };
const avisa = (A) => A.filter((a) => a.soSeNova).map((a) => a.chave).sort();
const fecha = (A) => A.filter((a) => a.resolve).map((a) => a.chave).sort();
const PROIBIDO = /rbenergydata|portal-admin|blob|\.json|\\|C:|automacao_acervo|Traceback|https?:|computador|escritorio|\bPC\b/i;

const CASOS = {
  frescorUm: (M) => {
    const A = M.decideMalha(MALHA);
    assert.deepStrictEqual(avisa(A), ['frescor']);
    assert.strictEqual(A.length, 1, 'um evento so');
    const c = A[0].corpo;
    for (const id of ['trafo_15', 'trafo_30', 'ons_mes']) assert.ok(c.indexOf(id) >= 0, 'falta ' + id + ' na lista');
    for (const id of ['medidor_dia', 'medidor_5min', 'hora_ufv']) assert.ok(c.indexOf(id) < 0, id + ' nao devia estar na lista');
    assert.ok(/3 dados publicados/.test(A[0].assunto), A[0].assunto);
  },
  frescorBom: (M) => { const A = M.decideMalha(BOA); assert.deepStrictEqual(fecha(A), ['frescor']); assert.deepStrictEqual(avisa(A), []); },
  noite: (M) => assert.deepStrictEqual(avisa(M.decideAcervo({ quando: '2026-11-01T22:03:00', falhas: 0 }, brt('2026-11-02T05:00:00'))), []),
  parada: (M) => assert.deepStrictEqual(avisa(M.decideAcervo({ quando: '2026-11-01T07:03:00', falhas: 0 }, brt('2026-11-01T10:10:00'))), ['acervo:parada']),
  utc: (M) => assert.deepStrictEqual(avisa(M.decideAcervo({ quando: '2026-11-01T08:03:00', falhas: 0 }, brt('2026-11-01T10:10:00'))), []),
  falhaFechaSoNoFim: (M) => {
    assert.deepStrictEqual(fecha(M.decideAcervo({ quando: '2026-11-01T15:03:00', falhas: 0 }, brt('2026-11-01T15:20:00'))), ['acervo:parada']);
    assert.deepStrictEqual(fecha(M.decideAcervo({ quando: '2026-11-01T22:03:00', falhas: 0 }, brt('2026-11-01T22:20:00'))), ['acervo:falha', 'acervo:parada']);
  },
};

caso('dado publicado: um evento so, com fa e sem na lista; at e a medicao fora', CASOS.frescorUm);
caso('dado publicado: tudo no prazo (a medicao e de outro vigia) fecha', CASOS.frescorBom);
caso('estado da malha sem a lista estoura (nunca vira "tudo bem")', (M) => assert.throws(() => M.decideMalha({ etapas: {} })));
caso('Acervo parado na janela avisa (ultima ha 3 h)', CASOS.parada);
caso('Acervo de noite NAO avisa (22:03 -> 05:00)', CASOS.noite);
caso('Acervo de manha, antes da primeira rodada passar do prazo, NAO avisa (07:10)', (M) =>
  assert.deepStrictEqual(avisa(M.decideAcervo({ quando: '2026-11-01T22:03:00', falhas: 0 }, brt('2026-11-02T07:10:00'))), []));
caso('Acervo sem a rodada das 06h passa a avisar as 08:20', (M) =>
  assert.deepStrictEqual(avisa(M.decideAcervo({ quando: '2026-11-01T22:03:00', falhas: 0 }, brt('2026-11-02T08:20:00'))), ['acervo:parada']));
caso('Acervo sem registro (404) na janela avisa', (M) => assert.deepStrictEqual(avisa(M.decideAcervo(null, brt('2026-11-01T10:00:00'))), ['acervo:parada']));
caso('a hora do Acervo e de Brasilia (08:03 ha 2 h 07 nao avisa)', CASOS.utc);
caso('Acervo: a falha so fecha no fim da janela; a parada fecha na hora', CASOS.falhaFechaSoNoFim);
caso('Acervo com conjunto falhando avisa so a contagem', (M) => {
  const f = M.decideAcervo({ quando: '2026-11-01T10:03:00', falhas: 2, resumo: { fusiveis: 'FALHOU: C:\\x\\y.xlsx' } }, brt('2026-11-01T10:20:00')).find((a) => a.soSeNova);
  assert.ok(f && f.chave === 'acervo:falha', 'sem aviso de falha');
  assert.ok(/2 conjuntos/.test(f.assunto), f.assunto);
  assert.ok(!/fusiveis|xlsx|FALHOU/.test(f.corpo + f.assunto), 'nome de conjunto, arquivo ou erro no texto');
});
caso('texto publico: nenhum aviso leva conta, conteiner, arquivo, caminho, maquina ou erro', (M) => {
  const todos = [].concat(M.decideMalha(MALHA), M.decideMalha(BOA),
    M.decideAcervo({ quando: '2026-11-01T07:03:00', falhas: 3, resumo: { x: 'FALHOU: rbenergydata/portal-admin' } }, brt('2026-11-01T12:00:00')),
    M.decideAcervo(null, brt('2026-11-01T12:00:00')));
  for (const a of todos) {
    const t = a.titulo + ' ' + a.assunto + ' ' + a.corpo;
    const m = t.match(PROIBIDO) || t.match(/FALHOU/);
    assert.ok(!m, a.chave + ': ' + (m && m[0]));
  }
});
caso('chave e titulo estaveis (o dedup): o mesmo evento em horas e listas diferentes', (M) => {
  const a1 = M.decideMalha(MALHA)[0], a2 = M.decideMalha({ frescor: [MALHA.frescor[0]] })[0];
  assert.strictEqual(a1.chave + a1.titulo, a2.chave + a2.titulo);
  const b1 = M.decideAcervo({ quando: '2026-11-01T07:03:00', falhas: 0 }, brt('2026-11-01T10:10:00')).find((a) => a.soSeNova);
  const b2 = M.decideAcervo({ quando: '2026-11-01T07:03:00', falhas: 0 }, brt('2026-11-01T15:40:00')).find((a) => a.soSeNova);
  assert.strictEqual(b1.chave + b1.titulo, b2.chave + b2.titulo);
});

CASOS.novos = (M) => {
  const a = M.decideMalha(MALHA)[0];
  assert.deepStrictEqual(a.ids, ['trafo_15', 'trafo_30', 'ons_mes']);
  const corpoIssue = 'texto\n---\n`{"tipo":"malha_frescor","chave":"frescor","soSeNova":true,"ids":["trafo_15"]}`';
  const coment = 'mais\n---\n`{"tipo":"malha_frescor","ids":["trafo_15","trafo_30"]}`';
  const avisados = M.idsDoTexto([corpoIssue, coment]);
  assert.deepStrictEqual(avisados, ['trafo_15', 'trafo_30'], 'vale o ULTIMO ids');
  const b = M.marcaNovos(a, avisados);
  assert.strictEqual(b.soSeNova, false, 'dado novo (ons_mes) tem de avisar de novo');
  assert.ok(/novo: ons_mes$/.test(b.assunto), b.assunto);
  assert.strictEqual(M.marcaNovos(a, ['trafo_15', 'trafo_30', 'ons_mes', 'x']).soSeNova, true, 'nada novo: nao repete');
  assert.strictEqual(M.marcaNovos(a, null).soSeNova, true, 'sem evento aberto: abre normal');
};
caso('dado novo na lista avisa de novo; a mesma lista (ou menor) nao; vale o ultimo ids da issue', CASOS.novos);

/* plantios: a regra desligada tem de reprovar o caso que a prova */
function plantio(nome, de, para, prova) {
  const src = fs.readFileSync(require.resolve('./aviso-malha'), 'utf8');
  const n = src.split(de).length - 1;
  if (n !== 1) { falhas++; console.log('  FALHA plantio "' + nome + '": ancora casou ' + n + ' vezes'); return; }
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src.replace(de, para))(m, m.exports, require);
  let reprovou = false;
  try { prova(m.exports); } catch (e) { reprovou = true; }
  if (reprovou) console.log('  ok    plantio reprovado: ' + nome);
  else { falhas++; console.log('  FALHA plantio NAO reprovado: ' + nome); }
}
plantio('sem a janela, a noite avisa', 'const naJanela = m >= ACERVO_JANELA[0] && m <= ACERVO_JANELA[1];', 'const naJanela = true;', CASOS.noite);
plantio('sem (ausente) ignorado', "(f.st === 'fa' || f.st === 'sem')", "(f.st === 'fa')", CASOS.frescorUm);
plantio('a medicao (way2) entrando no aviso', 'ETAPA_DE_OUTRO.indexOf(f.etapa) < 0', 'true', CASOS.frescorUm);
plantio('o atrasado (at) avisando', "(f.st === 'fa' || f.st === 'sem')", "(f.st !== 'ok')", CASOS.frescorUm);
plantio('a hora do Acervo lida como UTC', "+ '-03:00') : NaN;", "+ 'Z') : NaN;", CASOS.utc);
plantio('dado novo calado pelo evento aberto', 'if (!novos.length) return a;', 'return a;', CASOS.novos);
plantio('o primeiro ids no lugar do ultimo', 'try { ult = JSON.parse(m[1]); }', 'try { ult = ult || JSON.parse(m[1]); }', CASOS.novos);
plantio('a falha fechando a qualquer hora', '&& m >= ACERVO_FECHA[0] && m <= ACERVO_FECHA[1]) A.push', ') A.push', CASOS.falhaFechaSoNoFim);

console.log(falhas ? '\nensaio-aviso-malha: ' + falhas + ' FALHA(S)' : '\nensaio-aviso-malha: tudo certo');
process.exit(falhas ? 1 : 0);
