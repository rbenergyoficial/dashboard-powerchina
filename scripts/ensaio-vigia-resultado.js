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
const rod = (L, agora, entradas, estado, agenda) => L.rodada({ agora, agoraIso: iso(agora), agenda: agenda || AGENDA.concat(['a.yml', 'b.yml']),
  entradas, estado: estado || {}, tolerancia: 2.5, margem: 20 });
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
};
function julga(L) {
  return Object.entries(CASOS).map(([nome, fn]) => { let ok; try { ok = fn(L) === true; } catch (e) { ok = false; } return [nome, ok]; });
}
const R1 = julga(compila(LIB_SRC));
R1.forEach(([n, o]) => console.log('  ' + (o ? 'ok  ' : '🔴  ') + n));
R1.filter(([, o]) => !o).forEach(([n]) => f.push('a regra errou: ' + n));
if (R1.length !== 27) f.push('julgou ' + R1.length + ' caso(s), esperava 27');

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
const mk = (x) => ({ id: 1, created_at: iso(x.m), status: x.st || 'completed', conclusion: x.c === undefined ? 'success' : x.c, event: 'schedule' });
const SAI = { alertas: [], estado: null, saude: null };
process.on('exit', (code) => { require('fs').writeSync(1, '\\nSECO ' + JSON.stringify(Object.assign(SAI, { code })) + '\\n'); });
const https = { get(opts, cb) {
  const m = /\\/workflows\\/([^/]+)\\/runs\\?(.*)$/.exec(opts.path); const wf = m[1], q = m[2];
  const w = C.wf[wf] || C.padrao;
  const res = new (require('events'))(); res.statusCode = 200;
  let corpo;
  if (w.erro) res.statusCode = w.erro;
  else if (/status=success/.test(q)) corpo = { workflow_runs: w.filtrado ? [mk(w.filtrado)] : [] };
  else { const pp = Number((/per_page=(\\d+)/.exec(q) || [])[1] || 30); corpo = { workflow_runs: w.lista.map(mk).slice(0, pp) }; }
  setImmediate(() => { cb(res); res.emit('data', Buffer.from(JSON.stringify(corpo || {}))); res.emit('end'); });
  const req = new (require('events'))(); return req; } };
const blob = { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: () => ({ createIfNotExists: async () => {}, getBlockBlobClient: (n) => ({
  exists: async () => n === 'relogio_watchdog.json' && C.estado !== null,
  downloadToBuffer: async () => { if (C.estadoErro) throw new Error(C.estadoErro); return Buffer.from(JSON.stringify(C.estado)); },
  upload: async (b) => { if (n === 'relogio_watchdog.json') SAI.estado = JSON.parse(b); else SAI.saude = JSON.parse(b); } }) }) }) } };
Module._load = function (req) {
  if (req === 'https') return https;
  if (req === '@azure/storage-blob') return blob;
  if (/lib-alerta(\\.js)?$/.test(req)) return { alerta: async (a) => { SAI.alertas.push({ chave: a.chave, fecha: !!a.resolve, tipo: a.tipo }); } };
  return orig.apply(this, arguments);
};`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-vigia-'));
fs.writeFileSync(path.join(TMP, 'stub.js'), STUB);
function montaVigia(nome, gerSrc) {
  const d = path.join(TMP, nome); fs.mkdirSync(path.join(d, 'scripts'), { recursive: true }); fs.mkdirSync(path.join(d, 'relogio'), { recursive: true });
  fs.writeFileSync(path.join(d, 'scripts', 'gen-relogio-watchdog.js'), gerSrc);
  fs.writeFileSync(path.join(d, 'scripts', 'lib-vigia.js'), LIB_SRC);
  fs.copyFileSync(path.join(__dirname, '..', 'relogio', 'agenda.json'), path.join(d, 'relogio', 'agenda.json'));
  return path.join(d, 'scripts', 'gen-relogio-watchdog.js');
}
function seco(gerPath, cen) {
  const env = Object.assign({}, process.env, { SECO_CENARIO: JSON.stringify(cen), GH_TOKEN: 'forjado', DADOS_STORAGE: 'forjado' });
  ['GITHUB_TOKEN', 'PA_ALERT_WEBHOOK', 'AZ_MAIL_TENANT_ID', 'AZ_MAIL_CLIENT_ID', 'MAIL_DE', 'MAIL_PARA', 'ACTIONS_ID_TOKEN_REQUEST_URL'].forEach((k) => delete env[k]);
  const r = cp.spawnSync(process.execPath, ['-r', path.join(TMP, 'stub.js'), gerPath], { env, encoding: 'utf8', timeout: 60000 });
  const m = /\nSECO (.*)\n/.exec(r.stdout || '');
  return m ? JSON.parse(m[1]) : { code: r.status, alertas: null, estado: null, erro: (r.stderr || '').slice(-300) };
}
const OK = { lista: [{ m: 1 }], filtrado: { m: 1 } };      // todo workflow que o cenario nao nomeia: em dia, com sucesso
const sem = (o) => o.alertas && o.alertas.length === 0;
const CENARIOS = [
  ['08/10 23:43: rodada nova com o alarme aberto nao fecha nada', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 0, st: 'in_progress', c: null }, { m: 30, c: 'failure' }], filtrado: { m: 2940 } } } },
    (o) => o.code === 0 && sem(o) && o.estado && o.estado['resultado:' + EX] === A0],
  ['08/10 23:53: a rodada falhou, nada abre de novo e a data fica', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 1, c: 'failure' }], filtrado: { m: 2940 } } } },
    (o) => o.code === 0 && sem(o) && o.estado['resultado:' + EX] === A0],
  ['10/10 21:30: o sucesso fecha uma vez', { padrao: OK, estado: { ['resultado:' + EX]: A0 },
    wf: { [EX]: { lista: [{ m: 18 }], filtrado: { m: 18 } } } },
    (o) => o.code === 0 && o.alertas.length === 1 && o.alertas[0].chave === 'resultado:' + EX && o.alertas[0].fecha && !o.estado['resultado:' + EX]],
  ['07/10: a filtrada de 22 dias nao acende com o sucesso de 9 h na lista', { padrao: OK, estado: {},
    wf: { [EX]: { lista: [{ m: 10, c: 'failure' }, { m: 70, c: 'failure' }, { m: 617 }], filtrado: { m: 31680 } } } },
    (o) => o.code === 0 && sem(o) && Object.keys(o.estado).length === 0],
  ['o estado nao se le: job vermelho, nada avisado, nada gravado', { padrao: OK, estado: { ['resultado:' + EX]: A0 }, estadoErro: 'Server busy 503',
    wf: { [EX]: { lista: [{ m: 18 }], filtrado: { m: 18 } } } },
    (o) => o.code !== 0 && (o.alertas || []).length === 0 && o.estado === null],
  ['o workflow que saiu da agenda fecha as duas familias e sai do estado', { padrao: OK, estado: { 'resultado:saiu.yml': A0, 'cadencia:saiu.yml': A0 }, wf: {} },
    (o) => o.code === 0 && o.alertas.length === 2 && o.alertas.every((a) => a.fecha && a.tipo === 'relogio_fora_da_agenda') && Object.keys(o.estado).length === 0],
  ['GitHub 502 para o executivo: os dois alarmes dele ficam', { padrao: OK, estado: { ['resultado:' + EX]: A0, ['cadencia:' + EX]: A0 },
    wf: { [EX]: { erro: 502 } } },
    (o) => o.code === 0 && sem(o) && o.estado['resultado:' + EX] === A0 && o.estado['cadencia:' + EX] === A0],
  ['a rodada presa na fila alem do limite acende', { padrao: OK, estado: {},
    wf: { [EX]: { lista: [{ m: 930, st: 'queued', c: null }, { m: 1000, c: 'failure' }], filtrado: { m: 3000 } } } },
    (o) => o.code === 0 && o.alertas.some((a) => a.chave === 'resultado:' + EX && !a.fecha)],
];
function cenarios(gerPath) { return CENARIOS.map(([nome, cen, exige]) => { const o = seco(gerPath, cen); let ok; try { ok = exige(o); } catch (e) { ok = false; } return [nome, ok, o]; }); }
const R3 = cenarios(montaVigia('atual', GER_SRC));
R3.forEach(([n, o, s]) => console.log('  ' + (o ? 'ok  ' : '🔴  ') + 'vigia · ' + n + (o ? '' : '  ' + JSON.stringify(s).slice(0, 300))));
R3.filter(([, o]) => !o).forEach(([n]) => f.push('o vigia errou: ' + n));

const troca = (de, para) => { const n = GER_SRC.split(de).length - 1; return n === 1 ? GER_SRC.replace(de, para) : null; };
let HEAD = null;
try { HEAD = cp.execSync('git show HEAD~0:scripts/gen-relogio-watchdog.js', { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { /* fora do git */ }
const CONTRA = [
  ['o estado montado a mao', troca('JSON.stringify(R.estado)', 'JSON.stringify({})')],
  ['a lista das execucoes jogada fora', troca('lista: r.workflow_runs || []', 'lista: []')],
  ['o erro de leitura do estado engolido', troca("if (await bc.exists()) estado = JSON.parse((await bc.downloadToBuffer()).toString('utf8'));",
    "try { if (await bc.exists()) estado = JSON.parse((await bc.downloadToBuffer()).toString('utf8')); } catch (e) { console.error('estado: ' + e.message); }")],
  ['quem saiu da agenda esquecido', troca('for (const w of sairam) {', 'for (const w of []) {')],
  ['o fechamento de antes (fecha o que nao esta quebrado)', troca('for (const w of voltaramQ) {',
    "for (const w of Object.keys(estado).filter((k) => k.indexOf('resultado:') === 0).map((k) => k.slice(10)).filter((w) => !quebrados.some((a) => a.wf === w))) {")],
];
// o vigia de ANTES deste lote so entra se ainda nao tiver a lib (depois do commit, o HEAD ja e este)
if (HEAD && !/lib-vigia\.js/.test(HEAD)) CONTRA.push(['o vigia de antes deste lote', HEAD]);
for (const [nome, src] of CONTRA) {
  if (!src) { f.push('contraprova "' + nome + '": o trecho nao foi achado no vigia'); continue; }
  const caidos = cenarios(montaVigia('q' + CONTRA.indexOf(CONTRA.find((c) => c[0] === nome)), src)).filter(([, o]) => !o).map(([n]) => n);
  console.log('  contraprova "' + nome + '": reprova ' + caidos.length + ' cenario(s)');
  if (!caidos.length) f.push('contraprova "' + nome + '": o vigia quebrado passou em todos os cenarios');
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* limpeza */ }

console.log('');
if (f.length) { console.log('🔴 ENSAIO REPROVOU:'); f.forEach((x) => console.log('   ' + x)); process.exit(1); }
console.log('ensaio do vigia: ' + R1.length + ' casos, ' + PLANTIOS.length + ' plantios, ' + R3.length + ' cenarios do vigia de verdade e '
  + CONTRA.length + ' contraprovas · passou.');
