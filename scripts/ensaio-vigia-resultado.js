/*
 * ensaio-vigia-resultado.js — prova que o vigia enxerga o job que RODA E FALHA, e que ele nao se desmente.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA DESDE 13/09/2026. O vigia media se o workflow tinha RODADO, e so. Um job que roda no
 *    horario e falha toda vez saia do `relogio_saude.json` com `conclusao: "failure"` e `ok: 1` ao mesmo tempo. O
 *    `perdas.yml` ficou vermelho por dois dias, cinco execucoes, sem alarme nenhum.
 *
 * 🔴 E O QUE ELE GUARDA DESDE 11/10/2026 (PROMOVER vigia-desmente). De 06 a 10/10 o `executivo.yml` ficou sem sucesso e o
 *    vigia mandou doze e-mails alternando 🔴 e ✅: a execucao em andamento contava como saudavel e FECHAVA o alarme (#337
 *    fechada as 23:43:42Z de 08/10 pela run comecada as 23:43:25Z, que falhou), e a consulta filtrada do GitHub devolvia
 *    um sucesso de 14 e 22 dias com o real a 9 h. A regra mora em `lib-vigia.js`.
 *
 * TRES PARTES, sem rede e sem segredo:
 *   1 · A REGRA: casos nomeados sobre a lib (cada um protegido: excecao vira afirmacao falsa com o nome do caso).
 *   2 · OS PLANTIOS: cada defeito plantado na lib tem de reprovar os casos que ele DEVE reprovar, nao um qualquer.
 *   3 · O VIGIA DE VERDADE: o `gen-relogio-watchdog.js` roda num processo a parte com o GitHub, o alerta e o blob
 *       FORJADOS, em cenarios reais (08/10 23:43, 07/10, o estado ilegivel, o workflow que saiu da agenda…), e o ensaio
 *       conta os alertas e le o estado gravado. Contraprovas: o vigia de antes deste lote e vigias quebrados de proposito,
 *       que tem de reprovar algum cenario. Isto substitui a conferencia por texto, que deixava o defeito renascer no
 *       proprio vigia (revisor-ensaio, 11/10/2026).
 *
 * uso: node ensaio-vigia-resultado.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const f = [];
// --rapido (vigia.yml, 3 vezes por hora): casos, plantios e os cenarios do vigia de verdade, sem as contraprovas — elas provam
// o ENSAIO, que so muda no push, e rodam inteiras no ensaios.yml (~300 processos)
const RAPIDO = process.argv.includes('--rapido');
const LIB_SRC = fs.readFileSync(path.join(__dirname, 'lib-vigia.js'), 'utf8').replace(/\r\n/g, '\n');
const GER_SRC = fs.readFileSync(path.join(__dirname, 'gen-relogio-watchdog.js'), 'utf8').replace(/\r\n/g, '\n');
const AGENDA = Object.keys(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'relogio', 'agenda.json'), 'utf8')));
function compila(src) { const m = { exports: {} }; new Function('module', 'exports', 'require', src)(m, m.exports, require); return m.exports; }

/* ================================ 1 · A REGRA ================================ */
const MIN = 60000, T0 = Date.parse('2026-10-08T23:43:33Z'), LIM = 920;      // executivo: 360 × 2,5 + 20
const iso = (t) => new Date(t).toISOString();
const run = (agora, minAtras, conclusion, status) => ({ created_at: iso(agora - minAtras * MIN),
  conclusion: conclusion === undefined ? 'success' : conclusion, status: status || 'completed', event: 'schedule' });
const ent = (wf, lista, filtrado, extra) => Object.assign({ wf, gap: 360, lista, filtrado: filtrado || null }, extra || {});
const rod = (L, agora, entradas, estado, agenda, frescor) => L.rodada({ agora, agoraIso: iso(agora), agenda: agenda || AGENDA.concat(['a.yml', 'b.yml']),
  entradas, estado: estado || {}, tolerancia: 2.5, margem: 20, frescor: frescor || [] });
const SUC0610 = { created_at: '2026-10-06T22:13:00Z', conclusion: 'success', status: 'completed' };
const EX = 'executivo.yml', A0 = '2026-10-07T12:53:00Z';

const CASOS = {
  'A': (L) => L.veredito(T0, run(T0, 7, 'failure'), run(T0, 8027), 33).saudavel === 0,
  'B': (L) => L.veredito(T0, run(T0, 7, 'failure'), run(T0, 20), 33).saudavel === 1,
  'B-borda': (L) => L.veredito(T0, run(T0, 7, 'failure'), run(T0, 33), 33).saudavel === 1,
  'B-borda+1': (L) => L.veredito(T0, run(T0, 7, 'failure'), run(T0, 34), 33).saudavel === 0,
  'C-recente': (L) => { const v = L.veredito(T0, run(T0, 0, null, 'in_progress'), run(T0, 20), 33); return v.saudavel === 1 && v.rodando === true; },
  'C-velho': (L) => { const v = L.veredito(T0, run(T0, 0, null, 'in_progress'), run(T0, 40), 33); return v.saudavel === null && v.pendente === 1; },
  'C-fila': (L) => { const v = L.veredito(T0, run(T0, 2, null, 'queued'), run(T0, 40), 33); return v.saudavel === null && v.pendente === 1; },
  'C-presa': (L) => { const v = L.veredito(T0, run(T0, 34, null, 'queued'), run(T0, 40), 33); return v.saudavel === 0 && v.pendente === 0; },
  'C-falha': (L) => L.veredito(T0, run(T0, 0, 'failure'), run(T0, 40), 33).saudavel === 0,
  'D': (L) => { const v = L.veredito(T0, run(T0, 5, 'failure'), null, 33); return v.saudavel === null && v.pendente === 0; },
  // 08/10 23:43 real: alarme aberto, rodada nova comecando, ultimo sucesso de 06/10
  'F-23:43': (L) => { const R = rod(L, T0, [ent(EX, [{ created_at: '2026-10-08T23:43:25Z', conclusion: null, status: 'in_progress' }], SUC0610)], { ['resultado:' + EX]: A0 });
    return R.voltaramQ.length === 0 && R.novosQ.length === 0; },
  'F-data': (L) => { const R = rod(L, T0, [ent(EX, [{ created_at: '2026-10-08T23:43:25Z', conclusion: null, status: 'in_progress' }], SUC0610)], { ['resultado:' + EX]: A0 });
    return R.estado['resultado:' + EX] === A0; },
  'F-23:53': (L) => { const t = Date.parse('2026-10-08T23:53:21Z');
    const R = rod(L, t, [ent(EX, [{ created_at: '2026-10-08T23:43:25Z', conclusion: 'failure', status: 'completed' }], SUC0610)], { ['resultado:' + EX]: A0 });
    return R.novosQ.length === 0 && R.voltaramQ.length === 0 && R.quebrados.length === 1; },
  'F-data-quebrado': (L) => { const t = Date.parse('2026-10-08T23:53:21Z');
    const R = rod(L, t, [ent(EX, [{ created_at: '2026-10-08T23:43:25Z', conclusion: 'failure', status: 'completed' }], SUC0610)], { ['resultado:' + EX]: A0 });
    return R.estado['resultado:' + EX] === A0; },
  'F-21:30': (L) => { const t = Date.parse('2026-10-10T21:30:21Z'); const s = { created_at: '2026-10-10T21:11:50Z', conclusion: 'success', status: 'completed' };
    const R = rod(L, t, [ent(EX, [s], s)], { ['resultado:' + EX]: A0 });
    return R.voltaramQ.join() === EX && !R.estado['resultado:' + EX]; },
  // 07/10 real: a filtrada devolve 22 dias; a lista tem o sucesso de 06/10 22:13
  'G': (L) => { const t = Date.parse('2026-10-07T08:30:00Z');
    const R = rod(L, t, [ent(EX, [run(t, 10, 'failure'), run(t, 70, 'failure'), SUC0610], { created_at: '2026-09-15T07:13:00Z', conclusion: 'success' })]);
    return R.quebrados.length === 0 && R.novosQ.length === 0 && R.linhas[0].idade_sucesso_min === 617; },
  'H': (L) => { const filt = { created_at: '2026-10-01T00:00:00Z', conclusion: 'success' };
    return L.ultimoSucesso(Array.from({ length: 100 }, (_, i) => run(T0, 5 + i * 5, 'failure')), filt) === filt; },
  'H-nulo': (L) => L.ultimoSucesso([run(T0, 3, 'failure'), run(T0, 9, 'cancelled')], null) === null,
  'H-corrida': (L) => { const s = L.ultimoSucesso([run(T0, 1, null, 'in_progress'), run(T0, 200, 'success')], run(T0, 1, 'success'));
    return !!s && s.created_at === run(T0, 1).created_at; },
  'I-fecha-so-saudavel': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 1, null, 'in_progress')], run(T0, 2000)), ent('b.yml', [run(T0, 1)], run(T0, 1))],
    { 'resultado:a.yml': 'x', 'resultado:b.yml': 'y' }); return R.voltaramQ.join() === 'b.yml' && R.estado['resultado:a.yml'] === 'x'; },
  'I-naolido-res': (L) => { const R = rod(L, T0, [ent('a.yml', null, null, { erro: 'GitHub HTTP 502' })], { 'resultado:a.yml': 'x' });
    return R.voltaramQ.length === 0 && R.estado['resultado:a.yml'] === 'x'; },
  'I-naolido-cad': (L) => { const R = rod(L, T0, [ent('a.yml', null, null, { erro: 'GitHub HTTP 502' }), ent('b.yml', null, null, { gap: null })],
    { 'cadencia:a.yml': 'x', 'cadencia:b.yml': 'y' }); return R.voltaram.length === 0 && R.estado['cadencia:a.yml'] === 'x' && R.estado['cadencia:b.yml'] === 'y'; },
  'I-cad-normaliza': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 5)], run(T0, 5))], { 'cadencia:a.yml': 'x' });
    return R.voltaram.join() === 'a.yml' && !R.estado['cadencia:a.yml']; },
  'I-abre': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 1000, 'failure')], run(T0, 3000))]);
    return R.novos.length === 1 && R.novosQ.length === 1 && R.estado['cadencia:a.yml'] === iso(T0) && R.estado['resultado:a.yml'] === iso(T0); },
  'I-saiu': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 1)], run(T0, 1))], { 'resultado:saiu.yml': 'x', 'cadencia:saiu.yml': 'y' }, ['a.yml']);
    return R.sairam.join() === 'saiu.yml' && R.voltaram.length === 0 && R.voltaramQ.length === 0 && Object.keys(R.estado).length === 0; },
  'I-ordem': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 300, 'success'), run(T0, 2, 'failure')], run(T0, 300))]);
    return R.linhas[0].idade_min === 2 && R.linhas[0].conclusao === 'failure'; },
  // a sequencia real de 08 e 09/10 do executivo, rodada a rodada, com o alarme ja aberto
  'J': (L) => { const seq = [['2026-10-08T23:30:22Z', 'failure'], ['2026-10-08T23:43:33Z', null], ['2026-10-08T23:53:21Z', 'failure'],
      ['2026-10-09T17:07:21Z', 'failure'], ['2026-10-09T17:13:09Z', null], ['2026-10-09T17:30:22Z', 'failure']];
    let est = { ['resultado:' + EX]: A0 }, n = 0;
    for (const [i, c] of seq) { const t = Date.parse(i);
      const R = rod(L, t, [ent(EX, [{ created_at: iso(t - 10000), conclusion: c, status: c ? 'completed' : 'in_progress' }], SUC0610)], est);
      n += R.novosQ.length + R.voltaramQ.length; est = R.estado; }
    return n === 0 && est['resultado:' + EX] === A0; },
  // ---- vigia-desmente-2 (2a passada do revisor) ----
  'C-presa-borda': (L) => { const v = L.veredito(T0, run(T0, 33, null, 'queued'), run(T0, 40), 33); return v.pendente === 1 && v.saudavel === null; },
  'I-cad-dedup': (L) => rod(L, T0, [ent('a.yml', [run(T0, 1000)], run(T0, 1000))], { 'cadencia:a.yml': 'x' }).novos.length === 0,
  'I-cad-data': (L) => rod(L, T0, [ent('a.yml', [run(T0, 1000)], run(T0, 1000))], { 'cadencia:a.yml': 'x' }).estado['cadencia:a.yml'] === 'x',
  'I-cad-vazia': (L) => { const R = rod(L, T0, [ent('a.yml', [], null)], { 'cadencia:a.yml': 'x' });
    return R.voltaram.length === 0 && R.estado['cadencia:a.yml'] === 'x'; },
  'I-cad-borda': (L) => rod(L, T0, [ent('a.yml', [run(T0, 920)], run(T0, 920))]).linhas[0].ok === 1
    && rod(L, T0, [ent('a.yml', [run(T0, 921)], run(T0, 921))]).linhas[0].ok === 0,
  'I-linhas': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 1, null, 'in_progress')], run(T0, 2000)),
      ent('b.yml', [run(T0, 5, 'failure')], run(T0, 2000)), ent(EX, [run(T0, 930, null, 'queued')], run(T0, 3000))]);
    const l = (w) => R.linhas.find((x) => x.wf === w);
    return l('a.yml').saudavel === null && l('a.yml').pendente === 1 && l('a.yml').ok === 1
      && l('b.yml').saudavel === 0 && l('b.yml').pendente === 0 && l(EX).saudavel === 0 && l(EX).ok === 0; },
  'I-saude': (L) => { const R = rod(L, T0, [ent('a.yml', [run(T0, 1000, 'failure')], run(T0, 3000)), ent('b.yml', [run(T0, 5)], run(T0, 5))]);
    return R.saude.atrasados === 1 && R.saude.sem_sucesso === 1 && R.saude.estado_legivel === 1 && R.saude.workflows.length === 2
      && R.saude.workflows[0].wf === 'a.yml'; },
  // estado ilegivel com um workflow quebrado E um atrasado: nenhuma das cinco listas, nada a gravar, o aviso pedido
  'E-ilegivel': (L) => { const R = L.rodada({ agora: T0, agoraIso: iso(T0), agenda: AGENDA,
      entradas: [ent(EX, [run(T0, 5, 'failure')], run(T0, 3000)), ent('a.yml', [run(T0, 1000)], run(T0, 1000))],
      estado: {}, tolerancia: 2.5, margem: 20, estadoLegivel: false });
    return ['novos', 'voltaram', 'novosQ', 'voltaramQ', 'sairam'].every((k) => R[k].length === 0) && R.estado === null
      && R.avisoEstado === 'abre' && R.saude.estado_legivel === 0 && R.saude.sem_sucesso === 2 && R.saude.atrasados === 1; },
  'E-legivel': (L) => L.rodada({ agora: T0, agoraIso: iso(T0), agenda: AGENDA, entradas: [], estado: {}, tolerancia: 2.5, margem: 20,
    estadoLegivel: true }).avisoEstado === 'fecha',
  'E-valido': (L) => L.estadoValido({}) && L.estadoValido({ 'resultado:a.yml': 'x', 'cadencia:b.yml': 'y' })
    && !L.estadoValido(null) && !L.estadoValido([]) && !L.estadoValido(3) && !L.estadoValido('x') && !L.estadoValido({ 'resultado:a.yml': 5 })
    && !L.estadoValido({ outra: 'x' }),
  // o "Re-run" guarda o created_at da rodada original: o resultado vale pelo inicio da tentativa, a CADENCIA pela criacao
  'R-rerun': (L) => { const ok = Object.assign(run(T0, 3000), { run_started_at: iso(T0 - 5 * MIN), run_attempt: 2 });
    const andando = Object.assign(run(T0, 3000, null, 'in_progress'), { run_started_at: iso(T0 - 2 * MIN), run_attempt: 2 });
    const R = rod(L, T0, [ent('a.yml', [ok], ok)]);
    return L.veredito(T0, ok, L.ultimoSucesso([ok], null), LIM).saudavel === 1
      && L.veredito(T0, andando, run(T0, 2000), LIM).pendente === 1
      && R.linhas[0].saudavel === 1 && R.linhas[0].ok === 0 && R.novos.length === 1; },
  // o re-run de uma rodada antiga com o relogio FUNCIONANDO: a ultima (pelo inicio) e o re-run, a cadencia e a agendada de 10 min
  'R-rerun-cad': (L) => { const ag = run(T0, 10); const rr = Object.assign(run(T0, 3000), { run_started_at: iso(T0 - 4 * MIN), run_attempt: 2 });
    const R = rod(L, T0, [ent('a.yml', [ag, rr], rr)]);
    return R.linhas[0].idade_min === 10 && R.linhas[0].ok === 1 && R.novos.length === 0 && R.linhas[0].saudavel === 1; },
  // ---- vigia-frescor: o DADO, pela ancora que so a rodada completa grava ----
  'F1-velho-abre': (L) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], {}, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 1000 * MIN }]);
    return R.novosF.length === 1 && R.estado['frescor:executivo.json'] === iso(T0) && R.saude.dado_velho === 1 && R.saude.frescor[0].fresco === 0 && R.saude.frescor[0].limite_min === 920; },
  'F2-ja-aberto': (L) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], { 'frescor:executivo.json': 'x' }, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 1000 * MIN }]);
    return R.novosF.length === 0 && R.estado['frescor:executivo.json'] === 'x'; },
  'F3-volta': (L) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], { 'frescor:executivo.json': 'x' }, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 10 * MIN }]);
    return R.voltaramF.join() === 'executivo.json' && !R.estado['frescor:executivo.json'] && R.saude.frescor[0].fresco === 1; },
  'F4-nao-lido': (L) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], { 'frescor:executivo.json': 'x' }, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, erro: 'HTTP 503' }]);
    return R.voltaramF.length === 0 && R.novosF.length === 0 && R.estado['frescor:executivo.json'] === 'x'; },
  'F5-borda': (L) => { const fr = (m) => rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], {}, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - m * MIN }]);
    return fr(920).novosF.length === 0 && fr(921).novosF.length === 1; },
  'F6-ilegivel': (L) => { const R = L.rodada({ agora: T0, agoraIso: iso(T0), agenda: AGENDA, entradas: [ent(EX, [run(T0, 5)], run(T0, 5))], estado: {}, tolerancia: 2.5, margem: 20,
      estadoLegivel: false, frescor: [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 1000 * MIN }] });
    return R.novosF.length === 0 && R.voltaramF.length === 0 && R.estado === null && R.saude.dado_velho === 1; },
  'F7-sem-cadencia': (L) => { const R = rod(L, T0, [], { 'frescor:executivo.json': 'x' }, null, [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 10 * MIN }]);
    return R.voltaramF.length === 0 && R.estado['frescor:executivo.json'] === 'x'; },
  'E-valido-frescor': (L) => L.estadoValido({ 'frescor:executivo.json': 'x', 'resultado:a.yml': 'y' }),
  // o blob LIDO sem ancora valida: contrato quebrado, abre com o motivo e a saude nao diz "fresco" por omissao
  'F8-contrato': (L) => [null, NaN].every((anc) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], {}, null,
      [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: anc }]);
    return R.novosF.length === 1 && !!R.novosF[0].motivo && R.saude.dado_velho === 1 && R.saude.frescor[0].fresco === null
      && R.saude.frescor[0].motivo === (anc === null ? 'atualizado ausente no blob' : 'atualizado no blob nao e data'); }),
  // o blob que saiu da lista FRESCOR com o alarme aberto: fecha e sai do estado
  'F9-saiu-da-lista': (L) => { const R = rod(L, T0, [ent(EX, [run(T0, 5)], run(T0, 5))], { 'frescor:portal_vivo.json': 'x' }, null,
      [{ blob: 'executivo.json', campo: 'atualizado', wf: EX, ancoraMs: T0 - 10 * MIN }]);
    return R.sairamF.join() === 'portal_vivo.json' && !('frescor:portal_vivo.json' in R.estado); },
};
function julga(L) {
  return Object.entries(CASOS).map(([nome, fn]) => { let ok; try { ok = fn(L) === true; } catch (e) { ok = false; } return [nome, ok]; });
}
const R1 = julga(compila(LIB_SRC));
R1.forEach(([n, o]) => console.log('  ' + (o ? 'ok  ' : '🔴  ') + n));
R1.filter(([, o]) => !o).forEach(([n]) => f.push('a regra errou: ' + n));
if (R1.length !== 49) f.push("julgou " + R1.length + " caso(s), esperava 49");

/* ================================ 2 · OS PLANTIOS ================================ */
const PLANTIOS = [
  ['em andamento conta como saudavel (a regra de antes)', 'if (rodando && idadeUlt <= limite) return { idadeOk, rodando, saudavel: null, pendente: 1 };',
    'if (rodando) return { idadeOk, rodando, saudavel: 1, pendente: 0 };', ['F-23:43', 'J']],
  ['pendente sem prazo', 'if (rodando && idadeUlt <= limite)', 'if (rodando)', ['C-presa']],
  ['em andamento so in_progress', "const rodando = ult.conclusion === null || ult.status !== 'completed';", "const rodando = ult.status === 'in_progress';", ['C-fila']],
  ['so a consulta filtrada', 'for (const r of [...(runs || []), ...(filtrado ? [filtrado] : [])]) {', 'for (const r of [...(filtrado ? [filtrado] : [])]) {', ['G']],
  ['o primeiro sucesso achado', 'if (!melhor || ms(r) > ms(melhor)) melhor = r;', 'if (!melhor) melhor = r;', ['H-corrida']],
  ['limite exclusivo', 'if (idadeOk <= limite) return', 'if (idadeOk < limite) return', ['B-borda']],
  ['fecha o que nao esta quebrado (a regra de antes)', "const voltaramQ = chaves('resultado:').filter((w) => naAgenda.has(w) && tem(saudaveis, w));",
    "const voltaramQ = chaves('resultado:').filter((w) => !tem(quebrados, w));", ['F-23:43', 'I-naolido-res']],
  ['esquece o alarme pendente', "chaves('resultado:').filter((w) => naAgenda.has(w) && !tem(quebrados, w) && !tem(saudaveis, w)).forEach", '[].forEach', ['F-data', 'I-fecha-so-saudavel']],
  ['cadencia fecha o nao lido', "naAgenda.has(w) && tem(lidos, w) && !tem(atrasados, w)", "naAgenda.has(w) && !tem(atrasados, w)", ['I-naolido-cad']],
  ['ignora quem saiu da agenda', '.filter((w) => !naAgenda.has(w))', '.filter(() => false)', ['I-saiu']],
  ['quebrado perde a data de abertura', "quebrados.forEach((a) => { const k = 'resultado:' + a.wf; st[k] = estado[k] || agoraIso; });",
    "quebrados.forEach((a) => { const k = 'resultado:' + a.wf; st[k] = agoraIso; });", ['F-data-quebrado']],
  ['a ultima e a primeira da lista, sem ordenar', '.sort((a, b) => ms(b) - ms(a));', ';', ['I-ordem']],
  ['prazo do pendente exclusivo', 'if (rodando && idadeUlt <= limite)', 'if (rodando && idadeUlt < limite)', ['C-presa-borda']],
  ['cadencia reabre a cada rodada', "const novos = atrasados.filter((a) => !estado['cadencia:' + a.wf]);", 'const novos = atrasados;', ['I-cad-dedup']],
  ['lista vazia conta como lida', "if (!ult) { indecididos.push(e.wf + ' (sem execucao registrada)'); continue; }\n    lidos.push(e.wf);",
    "lidos.push(e.wf);\n    if (!ult) { indecididos.push(e.wf + ' (sem execucao registrada)'); continue; }", ['I-cad-vazia']],
  ['cadencia perde a data de abertura', "atrasados.forEach((a) => { const k = 'cadencia:' + a.wf; st[k] = estado[k] || agoraIso; });",
    "atrasados.forEach((a) => { const k = 'cadencia:' + a.wf; st[k] = agoraIso; });", ['I-cad-data']],
  ['cadencia com limite exclusivo', 'const ok = idade <= limite;', 'const ok = idade < limite;', ['I-cad-borda']],
  ['a saude diz saudavel sempre', 'saudavel: v.saudavel, pendente: v.pendente });', 'saudavel: 1, pendente: v.pendente });', ['I-linhas']],
  ['a saude diz ok sempre (o perdas.yml de 13/09)', 'conclusao: ult.conclusion, ok: ok ? 1 : 0,', 'conclusao: ult.conclusion, ok: 1,', ['I-linhas']],
  ['a saude sem as contagens', 'sem_sucesso: quebrados.length,', 'sem_sucesso: 0,', ['I-saude']],
  ['o instante e o created_at (re-run conta como velho)', 'const ms = (r) => Date.parse(r.run_started_at || r.created_at);', 'const ms = (r) => Date.parse(r.created_at);', ['R-rerun']],
  ['estado ilegivel decide alarmes assim mesmo', 'if (!estadoLegivel) return Object.assign(', 'if (false) return Object.assign(', ['E-ilegivel']],
  ['o aviso de estado nunca fecha', "const avisoEstado = estadoLegivel ? 'fecha' : 'abre';", "const avisoEstado = estadoLegivel ? null : 'abre';", ['E-legivel']],
  ['a cadencia avisada com o estado ilegivel', 'const nada = { novos: [],', 'const nada = { novos: atrasados,', ['E-ilegivel']],
  ['a cadencia pelo inicio da tentativa (o re-run esconde o relogio parado)', 'const idade = Math.max(0, Math.round((agora - cri(criada)) / 60000));',
    'const idade = Math.max(0, Math.round((agora - ms(ult)) / 60000));', ['R-rerun']],
  ['a cadencia pela ultima iniciada (o re-run com o relogio ok da 🟠 falso)', 'const criada = runs.reduce((a, r) => (cri(r) > cri(a) ? r : a), runs[0]);', 'const criada = ult;', ['R-rerun-cad']],
  ['o contrato quebrado vira nao lido', 'if (fr.ancoraMs == null || !Number.isFinite(fr.ancoraMs)) {', 'if (fr.ancoraMs == null || !Number.isFinite(fr.ancoraMs)) { indecididos.push(fr.blob); continue;', ['F8-contrato']],
  ['o blob fora da lista fica no estado', "const sairamF = chaves('frescor:').filter((b) => !naLista.has(b));", 'const sairamF = [];', ['F9-saiu-da-lista']],
  ['o frescor nunca abre', "const novosF = velhos.filter((v) => !estado['frescor:' + v.blob]);", 'const novosF = [];', ['F1-velho-abre']],
  ['o frescor reabre a cada rodada', "const novosF = velhos.filter((v) => !estado['frescor:' + v.blob]);", 'const novosF = velhos;', ['F2-ja-aberto']],
  ['o frescor nunca fecha', "const voltaramF = chaves('frescor:').filter((b) => temB(frescos, b));", 'const voltaramF = [];', ['F3-volta']],
  ['o frescor nao lido esquecido', "chaves('frescor:').filter((b) => naLista.has(b) && !temB(frescos, b) && !temB(velhos, b)).forEach", '[].forEach', ['F4-nao-lido', 'F7-sem-cadencia']],
  ['o frescor com limite exclusivo', 'const fresco = idade <= limite;', 'const fresco = idade < limite;', ['F5-borda']],
  ['o frescor perde a data de abertura', "velhos.forEach((v) => { const k = 'frescor:' + v.blob; st[k] = estado[k] || agoraIso; });", "velhos.forEach((v) => { const k = 'frescor:' + v.blob; st[k] = agoraIso; });", ['F2-ja-aberto']],
  ['o estado nao aceita a familia do frescor', '/^(cadencia|resultado|frescor):.+/', '/^(cadencia|resultado):.+/', ['E-valido-frescor']],
  ['estado sem validacao', "return !!x && typeof x === 'object' && !Array.isArray(x)", "return true || (!!x && typeof x === 'object' && !Array.isArray(x))", ['E-valido']],
];
for (const [nome, de, para, devem] of PLANTIOS) {
  const n = LIB_SRC.split(de).length - 1;
  if (n !== 1) { f.push('plantio "' + nome + '": o trecho aparece ' + n + ' vez(es) na lib'); continue; }
  const mut = LIB_SRC.replace(de, para);
  if (mut === LIB_SRC) { f.push('plantio "' + nome + '": o texto nao mudou'); continue; }
  let caidos;
  try { caidos = julga(compila(mut)).filter(([, o]) => !o).map(([n2]) => n2); } catch (e) { caidos = ['(a lib plantada nem compila: ' + e.message + ')']; }
  const faltou = devem.filter((d) => !caidos.includes(d));
  console.log('  plantio "' + nome + '": reprova ' + (caidos.join(', ') || 'nada'));
  if (faltou.length) f.push('plantio "' + nome + '" nao reprovou o que devia: ' + faltou.join(', '));
}

/* ================================ 3 · O VIGIA DE VERDADE ================================ */
/* o preload que forja o GitHub, o alerta e o blob; o cenario chega por variavel de ambiente */
const STUB = `
const Module = require('module'), orig = Module._load;
const C = JSON.parse(process.env.SECO_CENARIO), agora = Date.now();
const iso = (m) => new Date(agora - m * 60000).toISOString();
const mk = (x) => Object.assign({ id: 1, created_at: iso(x.m), status: x.st || 'completed', conclusion: x.c === undefined ? 'success' : x.c, event: 'schedule' },
  x.rs != null ? { run_started_at: iso(x.rs), run_attempt: 2 } : {});
const SAI = { alertas: [], gravouEstado: false, estado: null, estadoCru: null, saude: null };
process.on('exit', (code) => { require('fs').writeSync(1, '\\nSECO ' + JSON.stringify(Object.assign(SAI, { code: process.exitCode || code })) + '\\n'); });
const https = { get(opts, cb) {
  const m = /\\/workflows\\/([^/]+)\\/runs\\?(.*)$/.exec(opts.path); const wf = m[1], q = m[2];
  const w = C.wf[wf] || C.padrao;
  const res = new (require('events'))(); res.statusCode = 200;
  let corpo;
  if (w.erro) res.statusCode = w.erro;
  else if (/status=success/.test(q)) corpo = { workflow_runs: w.filtrado ? [mk(w.filtrado)] : [] };
  else { const pp = Number((/per_page=(\\d+)/.exec(q) || [])[1] || 30); corpo = { workflow_runs: w.lista.map(mk).slice(0, pp) }; }
  setImmediate(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(corpo || {}))); res.emit('end'); });
  return new (require('events'))(); } };
const falha = () => { if (C.storageErro) throw new Error(C.storageErro); };
const blob = { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => ({ createIfNotExists: async () => {}, getBlockBlobClient: (n) => ({
  exists: async () => { falha(); if (C.blobs && n in C.blobs) return true; return n === 'relogio_watchdog.json' && (C.estado !== null || C.estadoCru != null); },
  downloadToBuffer: async () => { falha();
    if (C.blobs && n in C.blobs) { const v = C.blobs[n]; if (v === 'lixo') return Buffer.from('nao e json');
      const o = typeof v === 'object' ? v : { m: v };
      const corpo = Buffer.from(JSON.stringify(o.semCampo ? { mes: {} } : { atualizado: iso(o.m), mes: {} }));
      return o.gzip === false ? corpo : require('zlib').gzipSync(corpo); }
    if (C.estadoErro) throw new Error(C.estadoErro);
    return Buffer.from(C.estadoCru != null ? C.estadoCru : JSON.stringify(C.estado)); },
  upload: async (b) => { falha();
    if (n === 'relogio_watchdog.json') { if (C.gravaEstadoErro) throw new Error(C.gravaEstadoErro); SAI.gravouEstado = true; SAI.estadoCru = String(b); SAI.estado = JSON.parse(b); }
    else SAI.saude = JSON.parse(b); } }) }) }) } };
Module._load = function (req) {
  if (req === 'https') return https;
  if (req === '@azure/storage-blob') return blob;
  if (/lib-alerta(\\.js)?$/.test(req)) return { alerta: async (a) => {
    SAI.alertas.push({ chave: a.chave, fecha: !!a.resolve, tipo: a.tipo, soSeNova: !!a.soSeNova });
    return C.alertaResposta || (C.alertaFalha ? { issue: 'FALHOU: 401', webhook: '-', email: 'FALHOU: sem OIDC' } : { issue: 'abriu #1', webhook: '-', email: '-' }); } };
  return orig.apply(this, arguments);
};`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-vigia-'));
fs.writeFileSync(path.join(TMP, 'stub.js'), STUB);
let nVig = 0;
function montaVigia(gerSrc) {
  const d = path.join(TMP, 'v' + (nVig++)); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(d, 'relogio'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'gen-relogio-watchdog.js'), gerSrc);
  fs.writeFileSync(path.join(d, 'scripts', 'lib-vigia.js'), LIB_SRC);
  // o gerador abre o storage pela lib-conteiner (require relativo, plano OIDC etapa 4): vai junto, e o SDK que ela pede e o forjado do stub
  fs.copyFileSync(path.join(__dirname, 'lib-conteiner.js'), path.join(d, 'scripts', 'lib-conteiner.js'));
  fs.copyFileSync(path.join(__dirname, '..', 'relogio', 'agenda.json'), path.join(d, 'relogio', 'agenda.json'));
  return path.join(d, 'scripts', 'gen-relogio-watchdog.js');
}
function seco(gerPath, cen) {
  const env = Object.assign({}, process.env, { SECO_CENARIO: JSON.stringify(cen), GH_TOKEN: 'forjado', DADOS_STORAGE: 'forjado' });
  ['GITHUB_TOKEN', 'PA_ALERT_WEBHOOK', 'AZ_MAIL_TENANT_ID', 'AZ_MAIL_CLIENT_ID', 'MAIL_DE', 'MAIL_PARA', 'ACTIONS_ID_TOKEN_REQUEST_URL',
    'AZURE_CLIENT_ID', 'AZURE_TENANT_ID'].forEach((k) => delete env[k]);
  // sem credencial nenhuma (o passo perdeu o OIDC): no Actions ('actions') ou na maquina ('local'); o resto dos cenarios, com a chave forjada
  if (cen.semCredencial) { delete env.DADOS_STORAGE; if (cen.semCredencial === 'actions') env.GITHUB_ACTIONS = 'true'; else delete env.GITHUB_ACTIONS; }
  const r = cp.spawnSync(process.execPath, ['-r', path.join(TMP, 'stub.js'), gerPath], { env, encoding: 'utf8', timeout: 60000 });
  const m = /\nSECO (.*)\n/.exec(r.stdout || '');
  return m ? JSON.parse(m[1]) : { code: r.status, alertas: null, estado: null, erro: (r.stderr || '').slice(-300) };
}
const OK = { lista: [{ m: 1 }], filtrado: { m: 1 } };      // todo workflow que o cenario nao nomeia: em dia, com sucesso
/* o pedido de FECHAR o aviso de estado sai em toda rodada legivel (a lib-alerta nao aciona canal sem issue aberta):
   ele nao conta como alerta "de verdade" nos cenarios */
const reais = (o) => o.alertas.filter((a) => !(a.chave === 'vigia:estado' && a.fecha));
const fechouAviso = (o) => o.alertas.some((a) => a.chave === 'vigia:estado' && a.fecha);
const sem = (o) => o.alertas && reais(o).length === 0;
const lin = (o, w) => ((o.saude || {}).workflows || []).find((x) => x.wf === w) || {};
const so = (o, chave, fecha, tipo) => { const r = reais(o); return r.length === 1 && r[0].chave === chave && r[0].fecha === fecha && (!tipo || r[0].tipo === tipo); };
const aviso = (o) => so(o, 'vigia:estado', false, 'vigia_estado_ilegivel') && reais(o)[0].soSeNova === true;
const QUEBRADO = { lista: [{ m: 5, c: 'failure' }], filtrado: { m: 3000 } };
const PARADO = { lista: [{ m: 1000 }], filtrado: { m: 1000 } };
const CEGO = (o) => aviso(o) && !o.gravouEstado && !fechouAviso(o);
/* [chave curta, descricao, cenario, exige] */
const CENARIOS = [
  ['23:43', '08/10 23:43: rodada nova com o alarme aberto nao fecha nada; a saude diz pendente', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 0, st: 'in_progress', c: null }, { m: 30, c: 'failure' }], filtrado: { m: 2940 } } } },
    (o) => o.code === 0 && sem(o) && o.estado && o.estado['resultado:' + EX] === A0
      && lin(o, EX).pendente === 1 && lin(o, EX).saudavel === null && o.saude.estado_legivel === 1 && fechouAviso(o)],
  ['23:53', '08/10 23:53: a rodada falhou, nada abre de novo, a data fica e a saude diz sem sucesso', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 1, c: 'failure' }], filtrado: { m: 2940 } } } },
    (o) => o.code === 0 && sem(o) && o.estado['resultado:' + EX] === A0 && lin(o, EX).saudavel === 0 && o.saude.sem_sucesso === 1],
  ['21:30', '10/10 21:30: o sucesso fecha uma vez', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 18 }], filtrado: { m: 18 } } } },
    (o) => o.code === 0 && so(o, 'resultado:' + EX, true) && !o.estado['resultado:' + EX] && lin(o, EX).saudavel === 1],
  ['07/10', '07/10: a filtrada de 22 dias nao acende com o sucesso de 9 h na lista', { padrao: OK, estado: {},
    wf: { [EX]: { lista: [{ m: 10, c: 'failure' }, { m: 70, c: 'failure' }, { m: 617 }], filtrado: { m: 31680 } } } },
    (o) => o.code === 0 && sem(o) && Object.keys(o.estado).length === 0 && lin(o, EX).saudavel === 1],
  ['ilegivel', 'o estado nao se le: so o aviso (dedup pela issue), nada de workflow, nada gravado no estado, a saude sai marcada',
    { padrao: OK, estado: { ['resultado:' + EX]: A0 }, estadoErro: 'Unexpected token in JSON', wf: { [EX]: QUEBRADO, 'ppc.yml': QUEBRADO, 'way2-agg.yml': PARADO } },
    (o) => o.code === 0 && CEGO(o) && o.saude && o.saude.estado_legivel === 0 && lin(o, EX).saudavel === 0 && o.saude.sem_sucesso >= 2],
  ['estado-null', 'o estado gravado como null e ilegivel, e nao e regravado', { padrao: OK, estado: null, estadoCru: 'null', wf: { [EX]: QUEBRADO } },
    (o) => o.code === 0 && CEGO(o) && o.saude.estado_legivel === 0],
  ['estado-lista', 'o estado gravado como lista e ilegivel (antes passava como vazio e reabria tudo)', { padrao: OK, estado: null, estadoCru: '[]', wf: { [EX]: QUEBRADO } },
    (o) => o.code === 0 && CEGO(o) && o.saude.estado_legivel === 0],
  ['sem-canal', 'o estado nao se le e o aviso nao chega a canal nenhum: so ai o job fica vermelho',
    { padrao: OK, estado: {}, estadoErro: 'Unexpected token in JSON', alertaFalha: true, wf: {} },
    (o) => o.code !== 0 && aviso(o)],
  ['sem-canal-0', 'o aviso volta "ja aberta #0" (a consulta de issues falhou e alguem tratou como dedup): nao conta como entregue',
    { padrao: OK, estado: {}, estadoErro: 'Unexpected token in JSON', alertaResposta: { issue: 'ja aberta #0', webhook: '-', email: '-' }, wf: {} },
    (o) => o.code !== 0 && aviso(o)],
  ['rerun-com-relogio', 'o re-run de uma rodada antiga com o relogio em dia: nenhum 🟠, a cadencia pela agendada de 10 min', { padrao: OK, estado: {},
    wf: { [EX]: { lista: [{ m: 10 }, { m: 3000, rs: 4 }], filtrado: { m: 3000, rs: 4 } } } },
    (o) => o.code === 0 && sem(o) && lin(o, EX).ok === 1 && lin(o, EX).idade_min === 10],
  ['conteiner', 'o storage inteiro fora (403): o aviso sai mesmo assim', { padrao: OK, estado: {}, storageErro: 'HTTP 403 AuthorizationFailure', wf: { [EX]: QUEBRADO } },
    (o) => o.code === 0 && CEGO(o) && o.saude === null],
  ['sem-credencial', 'no Actions sem credencial do storage (o passo perdeu o OIDC): o aviso sai, nada se le nem se grava',
    { padrao: OK, estado: {}, semCredencial: 'actions', wf: {} },
    (o) => o.code === 0 && aviso(o) && !o.gravouEstado && o.saude === null],
  ['sem-credencial-local', 'na maquina sem credencial: roda sem estado e sem aviso, como sempre', { padrao: OK, estado: {}, semCredencial: 'local', wf: {} },
    (o) => o.code === 0 && sem(o) && !o.gravouEstado && o.saude === null],
  ['grava-falha', 'o estado se le e nao se grava: os alarmes da rodada saem e o aviso tambem', { padrao: OK, estado: {}, gravaEstadoErro: 'HTTP 503',
    wf: { [EX]: QUEBRADO } },
    (o) => o.code === 0 && reais(o).length === 2 && reais(o).some((a) => a.chave === 'resultado:' + EX && !a.fecha)
      && reais(o).some((a) => a.chave === 'vigia:estado' && !a.fecha && a.soSeNova) && o.saude.estado_legivel === 1],
  ['saiu', 'o workflow que saiu da agenda fecha as duas familias e sai do estado', { padrao: OK, estado: { 'resultado:saiu.yml': A0, 'cadencia:saiu.yml': A0 }, wf: {} },
    (o) => o.code === 0 && reais(o).length === 2 && reais(o).every((a) => a.fecha && a.tipo === 'relogio_fora_da_agenda') && Object.keys(o.estado).length === 0],
  ['502', 'GitHub 502 para o executivo: os dois alarmes dele ficam', { padrao: OK, estado: { ['resultado:' + EX]: A0, ['cadencia:' + EX]: A0 },
    wf: { [EX]: { erro: 502 } } },
    (o) => o.code === 0 && sem(o) && o.estado['resultado:' + EX] === A0 && o.estado['cadencia:' + EX] === A0],
  ['presa', 'a rodada presa na fila alem do limite: acende o resultado E a cadencia, cada um com a sua chave', { padrao: OK, estado: {},
    wf: { [EX]: { lista: [{ m: 930, st: 'queued', c: null }, { m: 1000, c: 'failure' }], filtrado: { m: 3000 } } } },
    (o) => o.code === 0 && reais(o).length === 2 && reais(o).some((a) => a.chave === 'resultado:' + EX && !a.fecha && a.tipo === 'relogio_sem_sucesso')
      && reais(o).some((a) => a.chave === 'cadencia:' + EX && !a.fecha && a.tipo === 'relogio_atrasado') && lin(o, EX).saudavel === 0 && lin(o, EX).ok === 0],
  ['parou', 'o relogio parou para o executivo: abre a cadencia com a chave dela', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: PARADO } },
    (o) => o.code === 0 && so(o, 'cadencia:' + EX, false, 'relogio_atrasado') && o.saude.atrasados === 1 && lin(o, EX).ok === 0],
  ['parou-de-novo', 'a cadencia ja aberta e ainda atrasada: nenhum aviso e as datas ficam', { padrao: OK, estado: { ['resultado:' + EX]: A0, ['cadencia:' + EX]: A0 },
    wf: { [EX]: PARADO } },
    (o) => o.code === 0 && sem(o) && o.estado['cadencia:' + EX] === A0 && o.estado['resultado:' + EX] === A0],
  ['voltou', 'o executivo voltou a rodar: a cadencia fecha uma vez', { padrao: OK, estado: { ['cadencia:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 3 }], filtrado: { m: 3 } } } },
    (o) => o.code === 0 && so(o, 'cadencia:' + EX, true, 'relogio_normalizado') && !o.estado['cadencia:' + EX]],
  ['frescor-parado', 'o executivo verde e sem rodada completa ha 1000 min: abre o frescor, com a chave dele', { padrao: OK, estado: {}, blobs: { 'executivo.json': 1000 }, wf: {} },
    (o) => o.code === 0 && so(o, 'frescor:executivo.json', false, 'relogio_dado_velho') && o.saude.dado_velho === 1
      && o.saude.frescor[0].fresco === 0 && !!o.estado['frescor:executivo.json']],
  ['frescor-ja-aberto', 'o frescor ja aberto e o dado ainda velho: nenhum aviso, a data fica', { padrao: OK, estado: { 'frescor:executivo.json': A0 }, blobs: { 'executivo.json': 1000 }, wf: {} },
    (o) => o.code === 0 && sem(o) && o.estado['frescor:executivo.json'] === A0],
  ['frescor-voltou', 'a rodada completa voltou: o frescor fecha uma vez', { padrao: OK, estado: { 'frescor:executivo.json': A0 }, blobs: { 'executivo.json': 10 }, wf: {} },
    (o) => o.code === 0 && so(o, 'frescor:executivo.json', true, 'relogio_dado_fresco') && !o.estado['frescor:executivo.json'] && o.saude.frescor[0].fresco === 1],
  ['frescor-ilegivel', 'o executivo.json nao se le: nada abre nem fecha, o alarme fica', { padrao: OK, estado: { 'frescor:executivo.json': A0 }, blobs: { 'executivo.json': 'lixo' }, wf: {} },
    (o) => o.code === 0 && sem(o) && o.estado['frescor:executivo.json'] === A0],
  ['frescor-sem-campo', 'o executivo.json lido SEM o atualizado: contrato quebrado, abre o frescor com o motivo', { padrao: OK, estado: {}, blobs: { 'executivo.json': { semCampo: true } }, wf: {} },
    (o) => o.code === 0 && so(o, 'frescor:executivo.json', false, 'relogio_dado_velho') && o.saude.dado_velho === 1 && o.saude.frescor[0].fresco === null],
  ['frescor-sem-gzip', 'o executivo.json gravado SEM gzip e parado: o frescor abre do mesmo jeito', { padrao: OK, estado: {}, blobs: { 'executivo.json': { m: 1000, gzip: false } }, wf: {} },
    (o) => o.code === 0 && so(o, 'frescor:executivo.json', false, 'relogio_dado_velho')],
  ['frescor-saiu', 'o blob que saiu da lista do frescor: o alarme dele fecha com aviso proprio e sai do estado', { padrao: OK, estado: { 'frescor:portal_vivo.json': A0 }, blobs: { 'executivo.json': 10 }, wf: {} },
    (o) => o.code === 0 && so(o, 'frescor:portal_vivo.json', true, 'relogio_frescor_fora_da_lista') && !('frescor:portal_vivo.json' in o.estado)],
  ['rerun', 'um Re-run de rodada antiga deu certo agora: o resultado fecha, e a cadencia (ninguem criou execucao) acende', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 3000, rs: 4 }], filtrado: { m: 3000, rs: 4 } } } },
    (o) => o.code === 0 && reais(o).length === 2 && reais(o).some((a) => a.chave === 'resultado:' + EX && a.fecha)
      && reais(o).some((a) => a.chave === 'cadencia:' + EX && !a.fecha && a.tipo === 'relogio_atrasado')],
];
function cenarios(gerPath) {
  return CENARIOS.map(([k, , cen, exige]) => { const o = seco(gerPath, cen); let ok; try { ok = exige(o) === true; } catch (e) { ok = false; } return [k, ok, o]; });
}
const R3 = cenarios(montaVigia(GER_SRC));
R3.forEach(([k, o, s], i) => console.log('  ' + (o ? 'ok  ' : '🔴  ') + 'vigia · ' + CENARIOS[i][1] + (o ? '' : '  ' + JSON.stringify(s).slice(0, 300))));
R3.filter(([, o]) => !o).forEach(([k]) => f.push('o vigia errou: ' + k));

const troca = (de, para) => { const n = GER_SRC.split(de).length - 1; return n === 1 ? GER_SRC.replace(de, para) : null; };
let HEAD = null;
try { HEAD = cp.execSync('git show HEAD:scripts/gen-relogio-watchdog.js', { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* fora do git */ }
/* [nome, vigia quebrado, cenarios que ele TEM de reprovar] */
const CONTRA = [
  ['o estado montado a mao', troca('JSON.stringify(R.estado)', 'JSON.stringify({})'), ['23:43', 'parou-de-novo']],
  ['a lista das execucoes jogada fora', troca('lista: r.workflow_runs || []', 'lista: []'), ['21:30', 'voltou']],
  ['o estado ilegivel tratado como vazio', troca('catch (e) { estadoLegivel = false; estado = {};', 'catch (e) { estado = {};'), ['ilegivel']],
  ['o estado sem validacao', troca('if (!VIG.estadoValido(lido)) throw', 'if (false) throw'), ['estado-null', 'estado-lista']],
  ['sem credencial calado no Actions', troca("  } else if (process.env.GITHUB_ACTIONS === 'true') {", "  } else if (false) {"), ['sem-credencial']],
  ['o estado nulo gravado por cima', troca('if (cont && R.estado) {', 'if (cont) {'), ['ilegivel', 'estado-null']],
  ['o aviso de estado desligado', troca("if (R.avisoEstado === 'abre' || falhasStorage.length) {", 'if (false) {'), ['ilegivel', 'conteiner', 'grava-falha']],
  ['o aviso de estado sem dedup', troca('soSeNova: true,', 'soSeNova: false,'), ['ilegivel']],
  ['o aviso de estado nunca fecha', troca("} else {\n    await alerta({\n      tipo: 'vigia_estado_legivel'", "} else if (false) {\n    await alerta({\n      tipo: 'vigia_estado_legivel'"), ['23:43']],
  ['o upload da saude sem try', troca("} catch (e) { falhasStorage.push('gravar ' + SAUDE + ': ' + e.message); }", '} catch (e) { throw e; }'), ['conteiner']],
  ['o vermelho que nao liga para o canal', troca('if (!chegou) {', 'if (false) {'), ['sem-canal']],
  ['qualquer resposta conta como entregue', troca('const chegou = !!r && (', 'const chegou = !!r && (true || '), ['sem-canal', 'sem-canal-0']],
  ['quem saiu da agenda esquecido', troca('for (const w of sairam) {', 'for (const w of []) {'), ['saiu']],
  ['o fechamento de antes (fecha o que nao esta quebrado)', troca('for (const w of voltaramQ) {',
    "for (const w of Object.keys(estado).filter((k) => k.indexOf('resultado:') === 0).map((k) => k.slice(10)).filter((w) => !quebrados.some((a) => a.wf === w))) {"), ['23:43']],
  ['o relogio parado sem aviso', troca('for (const a of novos) {', 'for (const a of []) {'), ['parou', 'presa', 'rerun']],
  ['a cadencia que nunca fecha', troca('for (const w of voltaram) {', 'for (const w of []) {'), ['voltou']],
  ['a cadencia com a chave do resultado', troca("chave: 'cadencia:' + a.wf,", "chave: 'resultado:' + a.wf,"), ['parou', 'presa']],
  ['o frescor sem aviso', troca('for (const v of novosF) {', 'for (const v of []) {'), ['frescor-parado']],
  ['o frescor que nunca fecha', troca('for (const b of voltaramF) {', 'for (const b of []) {'), ['frescor-voltou']],
  ['a ancora lida do campo errado', troca("campo: 'atualizado', wf: 'executivo.yml'", "campo: 'gerado_em', wf: 'executivo.yml'"), ['frescor-parado']],
  ['a leitura que falha conta como fresca', troca('} catch (e) { frescor.push({ ...fr, erro: e.message }); }', '} catch (e) { frescor.push({ ...fr, ancoraMs: Date.now() }); }'), ['frescor-ilegivel']],
  ['o gzip descomprimido sempre', troca('let buf = await bc.downloadToBuffer(); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = require(\'zlib\').gunzipSync(buf);', 'let buf = require(\'zlib\').gunzipSync(await bc.downloadToBuffer());'), ['frescor-sem-gzip']],
  ['o blob fora da lista esquecido', troca('for (const b of sairamF) {', 'for (const b of []) {'), ['frescor-saiu']],
  ['a saude publicada vazia', troca('const b = JSON.stringify(R.saude);', 'const b = JSON.stringify({});'), ['23:43', '23:53']],
];
// o vigia do HEAD so entra se for de antes do conserto do estado (depois do commit, o HEAD ja e este)
if (HEAD && !/estadoValido/.test(HEAD)) CONTRA.push(['o vigia no ar antes deste lote', HEAD, ['ilegivel', 'estado-lista', 'conteiner']]);
if (RAPIDO) console.log('  contraprovas: puladas (--rapido); rodam no ensaios.yml, a cada push em scripts/');
for (const [nome, src, devem] of (RAPIDO ? [] : CONTRA)) {
  if (!src) { f.push('contraprova "' + nome + '": o trecho nao foi achado no vigia'); continue; }
  const caidos = cenarios(montaVigia(src)).filter(([, o]) => !o).map(([k]) => k);
  const faltou = devem.filter((d) => !caidos.includes(d));
  console.log('  contraprova "' + nome + '": reprova ' + (caidos.join(', ') || 'nada'));
  if (faltou.length) f.push('contraprova "' + nome + '" nao reprovou o que devia: ' + faltou.join(', '));
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* limpeza */ }

console.log('');
if (f.length) { console.log('🔴 ENSAIO REPROVOU:'); f.forEach((x) => console.log('   ' + x)); process.exit(1); }
console.log('ensaio do vigia: ' + R1.length + ' casos, ' + PLANTIOS.length + ' plantios, ' + R3.length + ' cenarios do vigia de verdade e '
  + (RAPIDO ? 'as contraprovas no push' : CONTRA.length + ' contraprovas') + ' · passou.');
