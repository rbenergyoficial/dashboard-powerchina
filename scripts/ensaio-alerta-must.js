'use strict';
/*
 * ensaio-alerta-must.js — prova que o alerta de ultrapassagem do MUST (alerta-must.js) avisa o que deve, cala o resto,
 * e fica VERMELHO quando nao consegue avisar ou nao julgou nada.
 *
 * Casos, todos sobre serie fabricada (ou o dado real de 22/10 copiado aqui) com `agora` e `gerado_em` injetados (nada
 * depende do dado do dia). Desde o must-provisorio (22/10/2026) so se julga linha ASSENTADA: com as 9 usinas (`cheia`), 30 min
 * antes do gerado_em e com os dois quartos de hora seguintes entregues (`assenta` acrescenta os seguintes, neutros).
 *   1. um quarto de hora acima do contratado no M2 -> 1 evento, com pico, hora e chave por dia e parque;
 *   2. valor IGUAL ao contratado -> nenhum evento (estritamente acima);
 *   3. fronteira do dia: o balde das 00:00 e de ONTEM, o das 00:15 e de HOJE (rotulo = fim do intervalo);
 *   4. nulo, texto e NaN deixam a linha incompleta (fora, contada); o Complexo nao conta (soma, sem contrato proprio);
 *   5. linha sem uma usina, assentada e acima do contratado em outra, nao e julgada, e `faltas` diz o dia e a usina;
 *   6. dia fora da janela (anteontem) nao conta;
 *   7. dois intervalos no mesmo dia e parque -> UM evento com n = 2 e o maior como pico;
 *   8. forma do blob: parque sem contrato, `gerado_em` ilegivel e `ms` que nao bate com `t` estouram;
 *   9. idade: 15 e 25 min antes do gerado_em ficam de fora; 30 min exatos e julgado;
 *  10. os seguintes: sem os dois quartos de hora seguintes entregues a linha nao e julgada — a Way2 atrasada (a ultima linha
 *      3 h antes do gerado_em) e ontem congelado no provisorio depois da meia-noite;
 *  11. teto fisico (inversores x 352 kW, lib-placa): acima dele a linha inteira sai e vira implausivel; igual ou abaixo, julga;
 *  12. o dado real de 22/10 (os avisos falsos de M2, M6 e M7): a leitura das 15:30Z carrega 4 valores acima do contratado
 *      (contados aqui, fora do codigo testado) e nao gera evento — nem lida na hora, nem 1 h depois (sem o M9), nem com o
 *      M9 da revisao (M6 e M7 acima do teto); a revisao das 15:45Z tambem nao;
 *  13. main():
 *      - canal: sem MAIL_PARA, sem MAIL_DE ou sem GITHUB_TOKEN -> 1 sem chamar o alerta;
 *      - um aviso por evento com soSeNova; 'ja aberta' (dedup) -> 0;
 *      - e-mail '-' ou FALHOU, ou issue FALHOU -> 1;
 *      - janela por dia BRT: as 22:00 BRT (ja e amanha em UTC) o evento de ONTEM ainda entra, e logo depois da
 *        meia-noite BRT o de ontem entra e o de anteontem sai;
 *      - forma do blob conferida antes de julgar (ms fora do t, parque sem contrato);
 *      - janela sem linha julgada (gerador parado, ou so linha incompleta ou acima do teto) -> 1, com a ::warning:: de cada
 *        linha que saiu; resolucao diferente de 15 min derruba;
 *      - ontem completo e hoje sem o M9 com o M6 acima do contratado: verde, sem e-mail, com a ::warning:: do dia e da usina;
 *      - o dado real de 22/10 das 15:30Z -> 0, sem aviso.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./alerta-must');

const C = { M1: 49.11, M2: 24.55, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.73, M8: 49.11, M9: 9.82, Complexo: 343.76 };
const PQ = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'Complexo'];
const BASE9 = { M1: 30, M2: 15, M3: 30, M4: 30, M5: 30, M6: 30, M7: 9, M8: 30, M9: 6 };
const Q = 15 * 60000;
const cheia = (v) => Object.assign({}, BASE9, v);
const linha = (t, v) => Object.assign({ t, ms: Date.parse(t) }, v);
const linhaMs = (ms, v) => linha(new Date(ms - 3 * 3600000).toISOString().slice(0, 19) + '-03:00', v);
/* o que a fonte ja entregou depois de cada linha: os dois quartos de hora seguintes, com as 9 usinas em valor neutro */
const assenta = (serie) => {
  const tem = new Set(serie.map((l) => l.ms)), extra = [];
  for (const l of serie) for (const k of [1, 2]) { const ms = l.ms + k * Q; if (!tem.has(ms)) { tem.add(ms); extra.push(linhaMs(ms, cheia({}))); } }
  return serie.concat(extra).sort((a, b) => a.ms - b.ms);
};
/* uma linha por quarto de hora, de `de` a `ate` (HH:MM do dia), com os valores de `v` (funcao da hora ou objeto) */
const faixa = (dia, de, ate, v) => {
  const out = [];
  for (let ms = Date.parse(dia + 'T' + de + ':00-03:00'); ms <= Date.parse(dia + 'T' + ate + ':00-03:00'); ms += Q) {
    const l = linhaMs(ms, {}); Object.assign(l, typeof v === 'function' ? v(l.t.slice(11, 16)) : v); out.push(l);
  }
  return out;
};
/* gerado as 14:00 BRT do dia 18: as linhas fabricadas dos dias 16 a 18 ja estao assentadas */
const GERADO = '2026-10-18T17:00:00.000Z';
const blob = (serie, extra) => Object.assign({ resolucao_min: 15, gerado_em: GERADO, parques: PQ, contratos: Object.assign({}, C), serie }, extra);
const HOJE = '2026-10-18', ONTEM = '2026-10-17';
let n = 0;
const caso = (nome, f) => { f(); n++; console.log('ok · ' + nome); };

/* ── o dado real de 22/10/2026 (must_15min.json), copiado das duas leituras: a das 15:30Z mandou os tres avisos falsos,
      a das 15:45Z e a revisao da Way2. Sem M9 nas linhas das 12:15 e 12:30 da primeira. ── */
const REAL_1530 = { gerado_em: '2026-10-22T15:30:40.464Z', linhas: [
  ['11:45', { M1: 36.944, M2: 17.797, M3: 37.625, M4: 36.507, M5: 44.456, M6: 39.716, M7: 11.396, M8: 34.736, M9: 8.419 }],
  ['12:00', { M1: 38.37, M2: 18.325, M3: 41.702, M4: 37.838, M5: 41.509, M6: 37.484, M7: 10.378, M8: 34.549, M9: 7.863 }],
  ['12:15', { M1: 46.108, M2: 22.645, M3: 43.18, M4: 28.578, M5: 26.235, M6: 59.443, M7: 12.945, M8: 27.784 }],
  ['12:30', { M1: 36.916, M2: 27.88, M3: 20.49, M4: 27.438, M5: 11.271, M6: 67.443, M7: 23.446, M8: 24.888 }],
] };
const REAL_1545 = { gerado_em: '2026-10-22T15:45:43.369Z', linhas: [
  ['11:45', { M1: 36.944, M2: 17.797, M3: 37.625, M4: 36.507, M5: 44.456, M6: 39.716, M7: 11.396, M8: 34.736, M9: 8.419 }],
  ['12:00', { M1: 38.37, M2: 18.325, M3: 41.702, M4: 37.838, M5: 41.509, M6: 37.484, M7: 10.378, M8: 34.549, M9: 7.863 }],
  ['12:15', { M1: 36.594, M2: 15.13, M3: 40.521, M4: 36.869, M5: 42.402, M6: 40.734, M7: 8.726, M8: 39.092, M9: 6.852 }],
  ['12:30', { M1: 20.358, M2: 10.769, M3: 20.726, M4: 24.665, M5: 26.026, M6: 23.335, M7: 6.411, M8: 27.618, M9: 4.873 }],
] };
const serieReal = (R) => R.linhas.map(([h, v]) => linha('2026-10-22T' + h + ':00-03:00', Object.assign({}, v)));
const DIA22 = ['2026-10-22', '2026-10-21'];
/* ontem completo e hoje sem o M9, com o M6 acima do contratado (e abaixo do teto) as 10:15 de hoje */
const SEM_M9 = () => {
  const hoje = faixa('2026-10-22', '10:00', '12:00', (h) => { const v = cheia(h === '10:15' ? { M6: 52 } : {}); delete v.M9; return v; });
  return faixa('2026-10-21', '10:00', '12:00', cheia({})).concat(hoje);
};

caso('acima do contratado vira evento', () => {
  const ev = M.ultrapassagens(blob(assenta([linha('2026-10-18T10:15:00-03:00', cheia({ M2: 24.9, M1: 40 }))])), [HOJE, ONTEM]);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].dia, ev[0].parque, ev[0].n, ev[0].pico, ev[0].t_pico], [HOJE, 'M2', 1, 24.9, '2026-10-18T10:15:00-03:00']);
  assert.strictEqual(ev.julgados, 1);
  const a = M.acaoDe(ev[0]);
  assert.strictEqual(a.chave, 'must-ultrapassagem-2026-10-18-M2');
  assert.strictEqual(a.soSeNova, true);
  assert.ok(/101,4% do contratado/.test(a.corpo) && /10:15/.test(a.corpo), a.corpo);
});
caso('igual ao contratado nao e ultrapassagem', () => {
  const ev = M.ultrapassagens(blob(assenta([linha('2026-10-18T10:15:00-03:00', cheia({ M2: 24.55, M9: 9.82 }))])), [HOJE]);
  assert.deepStrictEqual([ev.length, ev.julgados], [0, 1]);
});
caso('balde das 00:00 e de ontem, o das 00:15 e de hoje', () => {
  const ev = M.ultrapassagens(blob(assenta([linha('2026-10-18T00:00:00-03:00', cheia({ M9: 10 })), linha('2026-10-18T00:15:00-03:00', cheia({ M7: 15 }))])), [HOJE, ONTEM]);
  assert.deepStrictEqual(ev.map((e) => e.dia + ' ' + e.parque), [ONTEM + ' M9', HOJE + ' M7']);
});
caso('nulo, texto e NaN deixam a linha incompleta; Complexo nao conta', () => {
  const ev = M.ultrapassagens(blob(assenta([
    linha('2026-10-18T11:00:00-03:00', cheia({ M1: null, M2: 30 })),
    linha('2026-10-18T11:15:00-03:00', cheia({ M2: '99', M3: 60 })),
    linha('2026-10-18T11:30:00-03:00', cheia({ M9: NaN, M2: 30 })),
    linha('2026-10-18T11:45:00-03:00', cheia({ Complexo: 400 })),
  ])), [HOJE]);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.incompletas, ev.implausiveis.length], [0, 1, 3, 0]);
  assert.deepStrictEqual(ev.faltas, { [HOJE]: { n: 3, parques: ['M1', 'M2', 'M9'] } });
});
caso('linha sem uma usina nao e julgada, mesmo assentada e acima do contratado em outra', () => {
  const ev = M.ultrapassagens(blob(SEM_M9(), { gerado_em: '2026-10-22T16:00:00.000Z' }), DIA22);
  /* hoje: 10:00 a 11:30 assentadas (7) e sem o M9; 11:45 e 12:00 sem os seguintes. Ontem: 10:00 a 11:30 julgadas (7) */
  assert.deepStrictEqual([ev.length, ev.julgados, ev.incompletas], [0, 7, 7]);
  assert.deepStrictEqual(ev.faltas, { '2026-10-22': { n: 7, parques: ['M9'] } });
});
caso('dia fora da janela nao conta nem e julgado', () => {
  const ev = M.ultrapassagens(blob(assenta([linha('2026-10-16T12:00:00-03:00', cheia({ M1: 50 }))])), [HOJE, ONTEM]);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.recentes, ev.incompletas], [0, 0, 0, 0]);
});
caso('dois intervalos no mesmo dia e parque = um evento', () => {
  const ev = M.ultrapassagens(blob(assenta([linha('2026-10-18T11:00:00-03:00', cheia({ M1: 49.5 })), linha('2026-10-18T11:15:00-03:00', cheia({ M1: 50.2 }))])), [HOJE]);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].n, ev[0].pico, ev[0].t_primeiro], [2, 50.2, '2026-10-18T11:00:00-03:00']);
});
caso('forma do blob: parque sem contrato, gerado_em ilegivel e ms fora do t estouram', () => {
  const sem = blob([]); delete sem.contratos.M4;
  assert.throws(() => M.confere(sem), /M4/);
  assert.throws(() => M.confere(blob([], { parques: ['M1', 'Complexo'] })), /M2/);
  assert.throws(() => M.confere(blob([], { gerado_em: 'ensaio' })), /gerado_em ilegivel/);
  assert.throws(() => M.confere(blob([], { gerado_em: undefined })), /gerado_em ilegivel/);
  const l = linha('2026-10-18T10:00:00-03:00', cheia({})); l.ms -= 3 * 3600 * 1000;   /* ms em "epoch BRT" */
  assert.throws(() => M.confere(blob([l])), /nao bate com t/);
  M.confere(blob([linha('2026-10-18T10:00:00-03:00', cheia({}))]));
});
caso('idade: 15 e 25 min antes do gerado_em ficam de fora; 30 min exatos e julgado', () => {
  assert.strictEqual(M.MADURO_MIN, 30);
  /* lida as 12:30 BRT: 12:00 com 30 min e os seguintes (12:15 e 12:30) entregues */
  let ev = M.ultrapassagens(blob([
    linha('2026-10-18T12:00:00-03:00', cheia({ M2: 25 })),
    linha('2026-10-18T12:15:00-03:00', cheia({ M6: 52 })),
    linha('2026-10-18T12:30:00-03:00', cheia({ M7: 15 })),
  ], { gerado_em: '2026-10-18T15:30:00.000Z' }), [HOJE]);
  assert.deepStrictEqual(ev.map((e) => e.parque), ['M2']);
  assert.deepStrictEqual([ev.julgados, ev.recentes, ev.incompletas], [1, 2, 0]);
  /* lida as 12:40 BRT com 12:30 e 12:45 entregues: o 12:15 tem os seguintes, mas so 25 min (o provisorio de 22/10 ia ate 25) */
  ev = M.ultrapassagens(blob(faixa('2026-10-18', '12:00', '12:45', (h) => cheia(h === '12:00' ? { M2: 25 } : h === '12:15' ? { M6: 52 } : {})),
    { gerado_em: '2026-10-18T15:40:00.000Z' }), [HOJE]);
  assert.deepStrictEqual(ev.map((e) => e.parque), ['M2']);
  assert.deepStrictEqual([ev.julgados, ev.recentes], [1, 3]);
});
caso('os seguintes: Way2 atrasada e ontem congelado nao sao julgados no fim', () => {
  /* a Way2 entregou ate 13:00 e o gerador leu as 16:00: 12:45 e 13:00 nao tem os seguintes, o resto e julgado */
  let ev = M.ultrapassagens(blob(faixa('2026-10-22', '11:00', '13:00', (h) => cheia(h >= '12:45' ? { M6: 55 } : {})),
    { gerado_em: '2026-10-22T19:00:00.000Z' }), DIA22);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.recentes], [0, 7, 2]);
  /* ontem lido pela ultima vez as 17:00 (16:45 e 17:00 provisorios), hoje da meia-noite as 00:30, lido as 00:45 */
  const ontem = faixa('2026-10-21', '06:00', '17:00', (h) => cheia(h >= '16:45' ? { M6: 55 } : {}));
  ev = M.ultrapassagens(blob(ontem.concat(faixa('2026-10-22', '00:15', '00:30', cheia({}))), { gerado_em: '2026-10-22T03:45:00.000Z' }), DIA22);
  assert.deepStrictEqual([ev.length, ev.recentes], [0, 4]);
  assert.strictEqual(ev.julgados, ontem.length - 2);
  /* e o balde das 00:00 de ontem e julgado quando 00:15 e 00:30 de hoje ja chegaram (nenhum buraco na virada) */
  ev = M.ultrapassagens(blob(faixa('2026-10-21', '23:30', '23:45', cheia({}))
    .concat([linha('2026-10-22T00:00:00-03:00', cheia({ M2: 25 }))], faixa('2026-10-22', '00:15', '00:30', cheia({}))),
  { gerado_em: '2026-10-22T03:45:00.000Z' }), DIA22);
  assert.deepStrictEqual(ev.map((e) => e.dia + ' ' + e.parque), ['2026-10-21 M2']);
});
caso('teto fisico: inversores x 352 kW; acima dele a linha inteira sai, igual a ele julga', () => {
  /* conta de fora: 165, 88, 44 e 33 inversores (a placa das usinas) x 352 kW */
  assert.deepStrictEqual(['M6', 'M2', 'M7', 'M9'].map((p) => M.tetoFisico(p).toFixed(3)), ['58.080', '30.976', '15.488', '11.616']);
  const ev = M.ultrapassagens(blob(assenta([
    linha('2026-10-18T10:00:00-03:00', cheia({ M6: 58 })),                     /* acima do contratado, abaixo do teto: evento */
    linha('2026-10-18T10:15:00-03:00', cheia({ M6: 58.1, M2: 26 })),           /* M6 acima do teto: a linha sai, o M2 dela tambem */
    linha('2026-10-18T10:30:00-03:00', cheia({ M6: M.tetoFisico('M6') })),     /* igual ao teto: julgado */
  ])), [HOJE]);
  assert.deepStrictEqual(ev.map((e) => e.parque + ' ' + e.n + ' ' + e.pico.toFixed(2)), ['M6 2 58.08']);
  assert.strictEqual(ev.julgados, 2);
  assert.deepStrictEqual(ev.implausiveis.map((x) => x.parque + ' ' + x.valor + ' ' + x.t.slice(11, 16)), ['M6 58.1 10:15']);
});
caso('o dado real de 22/10 nao gera aviso, em nenhuma das leituras', () => {
  /* a prova de que o caso carrega o defeito, contada FORA do codigo testado: 4 valores acima do contratado na leitura das 15:30Z */
  const acima = []; REAL_1530.linhas.forEach(([h, v]) => Object.keys(v).forEach((p) => { if (v[p] > C[p]) acima.push(p + ' ' + h); }));
  assert.deepStrictEqual(acima.sort(), ['M2 12:30', 'M6 12:15', 'M6 12:30', 'M7 12:30']);
  /* lida na hora: 12:15 e 12:30 sao recentes */
  let ev = M.ultrapassagens(blob(serieReal(REAL_1530), { gerado_em: REAL_1530.gerado_em }), DIA22);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.recentes, ev.incompletas], [0, 2, 2, 0]);
  /* a mesma leitura 1 h depois, com 12:45 e 13:00 ja entregues: as duas assentadas, mas sem o M9 */
  const depois = faixa('2026-10-22', '12:45', '13:00', cheia({}));
  ev = M.ultrapassagens(blob(serieReal(REAL_1530).concat(depois), { gerado_em: '2026-10-22T16:30:40.464Z' }), DIA22);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.incompletas], [0, 2, 2]);
  assert.deepStrictEqual(ev.faltas, { '2026-10-22': { n: 2, parques: ['M9'] } });
  /* e com o M9 da revisao nas duas: o M6 passa do teto fisico (59,443 e 67,443 > 58,08), o M7 tambem as 12:30
     (23,446 > 15,488), e as linhas saem; o M2 das 12:30 (27,88, abaixo dos 30,976 dele) sai junto com a linha */
  const comM9 = serieReal(REAL_1530); comM9[2].M9 = 6.852; comM9[3].M9 = 4.873;
  ev = M.ultrapassagens(blob(comM9.concat(depois), { gerado_em: '2026-10-22T16:30:40.464Z' }), DIA22);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.incompletas], [0, 2, 0]);
  assert.deepStrictEqual(ev.implausiveis.map((x) => x.parque + ' ' + x.t.slice(11, 16)), ['M6 12:15', 'M6 12:30', 'M7 12:30']);
  /* a revisao das 15:45Z: tudo abaixo; 12:15 ainda sem o 12:45 entregue, 12:30 recente */
  ev = M.ultrapassagens(blob(serieReal(REAL_1545), { gerado_em: REAL_1545.gerado_em }), DIA22);
  assert.deepStrictEqual([ev.length, ev.julgados, ev.recentes, ev.incompletas], [0, 2, 2, 0]);
});

(async () => {
  const tmp = path.join(os.tmpdir(), 'ensaio-alerta-must-' + process.pid + '.json');
  const AS = (h) => Date.parse('2026-10-18T' + h + ':00-03:00');
  const grava = (serie, extra) => fs.writeFileSync(tmp, JSON.stringify(blob(serie, extra)));
  const ENV = { MAIL_PARA: 'ensaio@example.invalid', MAIL_DE: 'de@example.invalid', AZ_MAIL_TENANT_ID: 't', AZ_MAIL_CLIENT_ID: 'c', GITHUB_TOKEN: 'g' };
  const guardado = {}; Object.keys(ENV).concat(['GH_TOKEN', 'MUST_ARQ']).forEach((k) => { guardado[k] = process.env[k]; });
  const poe = (sem) => { Object.keys(ENV).forEach((k) => { if (k === sem) delete process.env[k]; else process.env[k] = ENV[k]; }); delete process.env.GH_TOKEN; };
  let chamadas = [], anot = [];
  const falso = (email, issue) => async (a) => { chamadas.push(a); return { email, issue: issue || 'abriu #1' }; };
  const roda = async (agora, alerta) => { chamadas = []; anot = []; return M.main({ alerta: alerta || falso('enviado para x'), agora }); };
  /* as mensagens do main() sao do cenario simulado: GUARDADAS (o ensaio confere as ::warning::) e nao impressas, para o
     '::error::' e o '::warning::' delas nao virarem anotacao em toda rodada do must-intra.yml */
  const erroOrig = console.error, logOrig = console.log;
  console.error = (...a) => { anot.push(a.join(' ')); }; console.log = (...a) => { if (!/^alerta-must:/.test(String(a[0]))) logOrig(...a); };
  try {
    process.env.MUST_ARQ = tmp;
    grava(assenta([linha('2026-10-18T10:15:00-03:00', cheia({ M2: 24.9 })), linha('2026-10-17T12:00:00-03:00', cheia({ M9: 10.1 })), linha('2026-10-16T12:00:00-03:00', cheia({ M1: 50 }))]));
    for (const k of ['MAIL_PARA', 'MAIL_DE', 'AZ_MAIL_CLIENT_ID', 'GITHUB_TOKEN']) {
      poe(k);
      assert.strictEqual(await roda(AS('14:00')), 1, 'sem ' + k);
      assert.strictEqual(chamadas.length, 0, 'sem ' + k);
    }
    poe(null);
    assert.strictEqual(await roda(AS('14:00')), 0);
    assert.deepStrictEqual(chamadas.map((a) => a.chave), ['must-ultrapassagem-2026-10-17-M9', 'must-ultrapassagem-2026-10-18-M2']);
    assert.ok(chamadas.every((a) => a.soSeNova === true));
    assert.deepStrictEqual(anot, [], 'rodada limpa sem anotacao');
    assert.strictEqual(await roda(AS('14:00'), falso('-', 'ja aberta #7')), 0, 'dedup');
    assert.strictEqual(await roda(AS('14:00'), falso('-')), 1, 'e-mail nao configurado');
    assert.strictEqual(await roda(AS('14:00'), falso('FALHOU: 403')), 1, 'e-mail falhou');
    assert.strictEqual(await roda(AS('14:00'), falso('enviado para x', 'FALHOU: GitHub HTTP 403')), 1, 'issue falhou');
    /* 22:00 BRT = 01:00 UTC do dia 19: a janela e do dia BRT, e o evento de ontem (17) ainda entra */
    assert.strictEqual(await roda(AS('22:00')), 0);
    assert.deepStrictEqual(chamadas.map((a) => a.chave), ['must-ultrapassagem-2026-10-17-M9', 'must-ultrapassagem-2026-10-18-M2']);
    /* 00:10 BRT do dia 19: hoje = 19 e ontem = 18; o 17 sai */
    assert.strictEqual(await roda(Date.parse('2026-10-19T00:10:00-03:00')), 0);
    assert.deepStrictEqual(chamadas.map((a) => a.chave), ['must-ultrapassagem-2026-10-18-M2']);
    /* o main confere a forma antes de julgar: ms em "epoch BRT" e parque sem contrato derrubam a rodada */
    const lb = linha('2026-10-18T10:15:00-03:00', cheia({ M2: 24.9 })); lb.ms -= 3 * 3600 * 1000;
    grava([lb]);
    await assert.rejects(roda(AS('14:00')), /nao bate com t/);
    const semC = blob([linha('2026-10-18T10:15:00-03:00', cheia({ M2: 24.9 }))]); delete semC.contratos.M2; fs.writeFileSync(tmp, JSON.stringify(semC));
    await assert.rejects(roda(AS('14:00')), /M2/);
    /* gerador parado: nada de hoje nem de ontem no blob */
    grava(assenta([linha('2026-10-15T12:00:00-03:00', cheia({ M1: 10 }))]));
    assert.strictEqual(await roda(AS('14:00')), 1, 'janela vazia');
    /* a janela so com linha incompleta ou acima do teto tambem nao julgou nada: vermelho, sem aviso, com as duas anotacoes */
    const sem9 = cheia({ M6: 52 }); delete sem9.M9;
    grava(assenta([linha('2026-10-18T10:00:00-03:00', sem9), linha('2026-10-18T10:15:00-03:00', cheia({ M6: 60 }))]));
    assert.strictEqual(await roda(AS('14:00')), 1, 'nada julgado');
    assert.strictEqual(chamadas.length, 0, 'nada julgado');
    assert.ok(anot.some((a) => /^::warning::alerta-must: 1 quarto\(s\) de hora assentado\(s\) de 18\/10 sem M9 /.test(a)), anot.join('\n'));
    assert.ok(anot.some((a) => /^::warning::alerta-must: M6 com 60,00 MW .*teto fisico de 58,08 MW/.test(a)), anot.join('\n'));
    assert.ok(anot.some((a) => /^::error::alerta-must: nenhum intervalo julgado/.test(a)), anot.join('\n'));
    grava([], { resolucao_min: 5 });
    await assert.rejects(roda(AS('14:00')), /resolucao 5 min/);
    /* ontem completo, hoje sem o M9 e o M6 acima do contratado: verde (ontem julgado), sem e-mail, com a anotacao do dia */
    fs.writeFileSync(tmp, JSON.stringify(blob(SEM_M9(), { gerado_em: '2026-10-22T16:00:00.000Z' })));
    assert.strictEqual(await roda(Date.parse('2026-10-22T13:01:00-03:00')), 0, 'hoje sem o M9');
    assert.strictEqual(chamadas.length, 0, 'hoje sem o M9');
    const avisos = anot.filter((a) => /^::warning::/.test(a));
    assert.strictEqual(avisos.length, 1, anot.join('\n'));
    assert.ok(/^::warning::alerta-must: 7 quarto\(s\) de hora assentado\(s\) de 22\/10 sem M9 ficaram fora do julgamento/.test(avisos[0]), avisos[0]);
    /* o dado real das 15:30Z de 22/10, como o must-intra o leu as 12:31 BRT: verde, sem aviso e sem anotacao */
    fs.writeFileSync(tmp, JSON.stringify(blob(serieReal(REAL_1530), { gerado_em: REAL_1530.gerado_em })));
    assert.strictEqual(await roda(Date.parse('2026-10-22T12:31:00-03:00')), 0, 'real 22/10');
    assert.strictEqual(chamadas.length, 0, 'real 22/10');
    assert.deepStrictEqual(anot, [], 'real 22/10');
    n++; console.log('ok · main: canal incompleto, entrega falha e janela sem julgamento ficam vermelhos; dedup, janela BRT, anotacoes e 22/10 certos');
  } finally {
    console.error = erroOrig; console.log = logOrig;
    try { fs.unlinkSync(tmp); } catch (e) { /* nada */ }
    Object.keys(guardado).forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
  }
  console.log('ensaio-alerta-must: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
