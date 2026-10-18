'use strict';
/*
 * ensaio-alerta-must.js — prova que o alerta de ultrapassagem do MUST (alerta-must.js) avisa o que deve, cala o resto,
 * e fica VERMELHO quando nao consegue avisar ou nao julgou nada.
 *
 * Casos, todos sobre serie fabricada com `agora` injetado (nada depende do dado do dia):
 *   1. um quarto de hora acima do contratado no M2 -> 1 evento, com pico, hora e chave por dia e parque;
 *   2. valor IGUAL ao contratado -> nenhum evento (estritamente acima);
 *   3. fronteira do dia: o balde das 00:00 e de ONTEM, o das 00:15 e de HOJE (rotulo = fim do intervalo);
 *   4. nulo, texto e NaN nao contam; o Complexo nao conta (soma, sem contrato proprio);
 *   5. dia fora da janela (anteontem) nao conta;
 *   6. dois intervalos no mesmo dia e parque -> UM evento com n = 2 e o maior como pico;
 *   7. forma do blob: parque sem contrato e `ms` que nao bate com `t` estouram;
 *   8. main():
 *      - canal: sem MAIL_PARA, sem MAIL_DE ou sem GITHUB_TOKEN -> 1 sem chamar o alerta;
 *      - um aviso por evento com soSeNova; 'ja aberta' (dedup) -> 0;
 *      - e-mail '-' ou FALHOU, ou issue FALHOU -> 1;
 *      - janela por dia BRT: as 22:00 BRT (ja e amanha em UTC) o evento de ONTEM ainda entra, e logo depois da
 *        meia-noite BRT o de ontem entra e o de anteontem sai;
 *      - forma do blob conferida antes de julgar (ms fora do t, parque sem contrato);
 *      - janela sem linha julgada (gerador parado) -> 1; resolucao diferente de 15 min derruba.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./alerta-must');

const C = { M1: 49.11, M2: 24.55, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.73, M8: 49.11, M9: 9.82, Complexo: 343.76 };
const PQ = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'Complexo'];
const linha = (t, v) => Object.assign({ t, ms: Date.parse(t) }, v);
const blob = (serie, extra) => Object.assign({ resolucao_min: 15, gerado_em: 'ensaio', parques: PQ, contratos: Object.assign({}, C), serie }, extra);
const HOJE = '2026-10-18', ONTEM = '2026-10-17';
let n = 0;
const caso = (nome, f) => { f(); n++; console.log('ok · ' + nome); };

caso('acima do contratado vira evento', () => {
  const ev = M.ultrapassagens(blob([linha('2026-10-18T10:15:00-03:00', { M2: 24.9, M1: 40 })]), [HOJE, ONTEM]);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].dia, ev[0].parque, ev[0].n, ev[0].pico, ev[0].t_pico], [HOJE, 'M2', 1, 24.9, '2026-10-18T10:15:00-03:00']);
  assert.strictEqual(ev.julgados, 1);
  const a = M.acaoDe(ev[0]);
  assert.strictEqual(a.chave, 'must-ultrapassagem-2026-10-18-M2');
  assert.strictEqual(a.soSeNova, true);
  assert.ok(/101,4% do contratado/.test(a.corpo) && /10:15/.test(a.corpo), a.corpo);
});
caso('igual ao contratado nao e ultrapassagem', () => {
  assert.strictEqual(M.ultrapassagens(blob([linha('2026-10-18T10:15:00-03:00', { M2: 24.55, M9: 9.82 })]), [HOJE]).length, 0);
});
caso('balde das 00:00 e de ontem, o das 00:15 e de hoje', () => {
  const ev = M.ultrapassagens(blob([linha('2026-10-18T00:00:00-03:00', { M9: 10 }), linha('2026-10-18T00:15:00-03:00', { M7: 15 })]), [HOJE, ONTEM]);
  assert.deepStrictEqual(ev.map((e) => e.dia + ' ' + e.parque), [ONTEM + ' M9', HOJE + ' M7']);
});
caso('nulo, texto, NaN e Complexo nao contam', () => {
  const ev = M.ultrapassagens(blob([linha('2026-10-18T11:00:00-03:00', { M1: null, M2: '99', M9: NaN, Complexo: 400 })]), [HOJE]);
  assert.strictEqual(ev.length, 0);
  assert.strictEqual(ev.julgados, 1);
});
caso('dia fora da janela nao conta nem e julgado', () => {
  const ev = M.ultrapassagens(blob([linha('2026-10-16T12:00:00-03:00', { M1: 60 })]), [HOJE, ONTEM]);
  assert.deepStrictEqual([ev.length, ev.julgados], [0, 0]);
});
caso('dois intervalos no mesmo dia e parque = um evento', () => {
  const ev = M.ultrapassagens(blob([linha('2026-10-18T11:00:00-03:00', { M1: 49.5 }), linha('2026-10-18T11:15:00-03:00', { M1: 50.2 })]), [HOJE]);
  assert.strictEqual(ev.length, 1);
  assert.deepStrictEqual([ev[0].n, ev[0].pico, ev[0].t_primeiro], [2, 50.2, '2026-10-18T11:00:00-03:00']);
});
caso('forma do blob: parque sem contrato e ms fora do t estouram', () => {
  const sem = blob([]); delete sem.contratos.M4;
  assert.throws(() => M.confere(sem), /M4/);
  assert.throws(() => M.confere(blob([], { parques: ['M1', 'Complexo'] })), /M2/);
  const l = linha('2026-10-18T10:00:00-03:00', {}); l.ms -= 3 * 3600 * 1000;   /* ms em "epoch BRT" */
  assert.throws(() => M.confere(blob([l])), /nao bate com t/);
  M.confere(blob([linha('2026-10-18T10:00:00-03:00', {})]));
});

(async () => {
  const tmp = path.join(os.tmpdir(), 'ensaio-alerta-must-' + process.pid + '.json');
  const AS = (h) => Date.parse('2026-10-18T' + h + ':00-03:00');
  const grava = (serie, extra) => fs.writeFileSync(tmp, JSON.stringify(blob(serie, extra)));
  const ENV = { MAIL_PARA: 'ensaio@example.invalid', MAIL_DE: 'de@example.invalid', AZ_MAIL_TENANT_ID: 't', AZ_MAIL_CLIENT_ID: 'c', GITHUB_TOKEN: 'g' };
  const guardado = {}; Object.keys(ENV).concat(['GH_TOKEN', 'MUST_ARQ']).forEach((k) => { guardado[k] = process.env[k]; });
  const poe = (sem) => { Object.keys(ENV).forEach((k) => { if (k === sem) delete process.env[k]; else process.env[k] = ENV[k]; }); delete process.env.GH_TOKEN; };
  let chamadas = [];
  const falso = (email, issue) => async (a) => { chamadas.push(a); return { email, issue: issue || 'abriu #1' }; };
  const roda = async (agora, alerta) => { chamadas = []; return M.main({ alerta: alerta || falso('enviado para x'), agora }); };
  /* as mensagens do main() sao do cenario simulado: caladas, para o '::error::' delas nao virar anotacao de erro em toda rodada do
     must-intra.yml (o veredito do ensaio e o assert, nao o texto) */
  const erroOrig = console.error, logOrig = console.log;
  console.error = () => {}; console.log = (...a) => { if (!/^alerta-must:/.test(String(a[0]))) logOrig(...a); };
  try {
    process.env.MUST_ARQ = tmp;
    grava([linha('2026-10-18T10:15:00-03:00', { M2: 24.9 }), linha('2026-10-17T12:00:00-03:00', { M9: 10.1 }), linha('2026-10-16T12:00:00-03:00', { M1: 60 })]);
    for (const k of ['MAIL_PARA', 'MAIL_DE', 'AZ_MAIL_CLIENT_ID', 'GITHUB_TOKEN']) {
      poe(k);
      assert.strictEqual(await roda(AS('14:00')), 1, 'sem ' + k);
      assert.strictEqual(chamadas.length, 0, 'sem ' + k);
    }
    poe(null);
    assert.strictEqual(await roda(AS('14:00')), 0);
    assert.deepStrictEqual(chamadas.map((a) => a.chave), ['must-ultrapassagem-2026-10-17-M9', 'must-ultrapassagem-2026-10-18-M2']);
    assert.ok(chamadas.every((a) => a.soSeNova === true));
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
    const lb = linha('2026-10-18T10:15:00-03:00', { M2: 24.9 }); lb.ms -= 3 * 3600 * 1000;
    grava([lb]);
    await assert.rejects(roda(AS('14:00')), /nao bate com t/);
    const semC = blob([linha('2026-10-18T10:15:00-03:00', { M2: 24.9 })]); delete semC.contratos.M2; fs.writeFileSync(tmp, JSON.stringify(semC));
    await assert.rejects(roda(AS('14:00')), /M2/);
    /* gerador parado: nada de hoje nem de ontem no blob */
    grava([linha('2026-10-15T12:00:00-03:00', { M1: 10 })]);
    assert.strictEqual(await roda(AS('14:00')), 1, 'janela vazia');
    grava([], { resolucao_min: 5 });
    await assert.rejects(roda(AS('14:00')), /resolucao 5 min/);
    n++; console.log('ok · main: canal incompleto, entrega falha e janela vazia ficam vermelhos; dedup e janela BRT certos');
  } finally {
    console.error = erroOrig; console.log = logOrig;
    try { fs.unlinkSync(tmp); } catch (e) { /* nada */ }
    Object.keys(guardado).forEach((k) => { if (guardado[k] === undefined) delete process.env[k]; else process.env[k] = guardado[k]; });
  }
  console.log('ensaio-alerta-must: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
