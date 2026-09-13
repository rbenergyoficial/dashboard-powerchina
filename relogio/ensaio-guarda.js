// Ensaio da guarda anti-empilhamento do relogio.
//
// 🔴 O QUE ESTA SENDO PROVADO
// A guarda existe para nao disparar em cima de uma execucao que ainda esta rodando. Ela tem DOIS
// modos de errar, e um deles ja aconteceu por 26 dias sem ninguem ver:
//
//   frouxa demais  → dispara em cima do que esta rodando e empilha fila;
//   rigida demais  → um registro MORTO do GitHub (queued, zero jobs, intocado ha semanas, que o
//                    proprio GitHub recusa cancelar com 409) e lido como "esta rodando", e o
//                    workflow cai do relogio para o agendador do GitHub. Calado.
//
// O segundo foi medido em 02/09/2026 no `way2-agg.yml`: run de 07/08 presa em `queued`, e o
// relogio pulando o disparo de hora em hora desde entao.
//
// ⚠️ A funcao e compilada do PROPRIO `src/index.js`, como ela sobe — nao de uma copia reescrita
//    aqui, que provaria que a copia concorda com ela mesma.
'use strict';
const fs = require('fs');
const path = require('path');

let mau = 0;
const ok = (c, m) => { if (!c) { mau += 1; console.log('  [X] ' + m); } else console.log('  ok  ' + m); };

const fonte = fs.readFileSync(path.join(__dirname, 'src', 'index.js'), 'utf8');
const mTeto = /const TETO_VIVO_MS = [^;]+;/.exec(fonte);
const mParada = /const PARADA_MS = [^;]+;/.exec(fonte);
const mMorto = /const registroParado = \([\s\S]*?\n\};/.exec(fonte);
const mFn = /async function jaRodando\(wf, log\) \{[\s\S]*?\n\}/.exec(fonte);
if (!mTeto || !mParada || !mMorto || !mFn) throw new Error('nao achei TETO_VIVO_MS, PARADA_MS, registroParado ou jaRodando em src/index.js');
const PARADA_MIN = Number(/([0-9]+) \* 60 \* 1000/.exec(mParada[0])[1]);

// `gh` injetado: devolve o que o ensaio mandar, sem rede.
function monta(respostas) {
  return new Function('gh', mTeto[0] + '\n' + mParada[0] + '\n' + mMorto[0] + '\n' + mFn[0] + '\nreturn jaRodando;')(
    async (caminho) => {
      const st = /status=(\w+)/.exec(caminho)[1];
      return { workflow_runs: respostas[st] || [] };
    });
}

const agora = Date.now();
const emMin = (m) => new Date(agora - m * 60000).toISOString();
const registros = [];
const log = { warn: (m) => registros.push(m), info: () => {} };

(async () => {
  console.log('teto lido do fonte: ' + mTeto[0]);

  console.log('\n1 · execucao DE VERDADE em andamento bloqueia');
  registros.length = 0;
  ok(await monta({ in_progress: [{ created_at: emMin(2) }] })('x.yml', log) === true,
    'in_progress de 2 min: bloqueia');
  ok(await monta({ queued: [{ created_at: emMin(1) }] })('x.yml', log) === true,
    'queued de 1 min: bloqueia');
  ok(await monta({ queued: [{ created_at: emMin(119) }] })('x.yml', log) === true,
    'queued de 119 min ainda bloqueia (o maior timeout do repo e 120)');
  ok(registros.length === 0, 'nada foi chamado de zumbi');

  console.log('\n2 · o ZUMBI nao bloqueia — e e DITO');
  registros.length = 0;
  const zumbi = { queued: [{ created_at: emMin(26 * 24 * 60) }] };   // o caso real: 26 dias
  ok(await monta(zumbi)('way2-agg.yml', log) === false,
    'queued de 26 dias: NAO bloqueia');
  ok(registros.length === 1 && /presa\(s\) ha mais de 6 h/.test(registros[0]),
    'o zumbi aparece no log: ' + (registros[0] || '(nada)').slice(0, 72));

  console.log('\n3 · zumbi AO LADO de execucao viva: a viva manda');
  registros.length = 0;
  ok(await monta({ queued: [{ created_at: emMin(26 * 24 * 60) }, { created_at: emMin(3) }] })('x.yml', log) === true,
    'um zumbi e uma viva: bloqueia (a viva e que decide)');
  ok(registros.length === 1, 'e o zumbi continua sendo dito');

  console.log('\n4 · nada rodando');
  ok(await monta({})('x.yml', log) === false, 'sem execucao nenhuma: nao bloqueia');

  console.log('\n5 · a borda do teto');
  ok(await monta({ queued: [{ created_at: emMin(6 * 60 - 1) }] })('x.yml', log) === true,
    '5 h 59 min: ainda e considerada viva');
  ok(await monta({ queued: [{ created_at: emMin(6 * 60 + 1) }] })('x.yml', log) === false,
    '6 h 01 min: ja e zumbi');

  // ── 6 · o REGISTRO PARADO, que e o caso de 13/09/2026 ─────────────────────────────────────
  // Ele nasce e nunca se mexe: `updated_at` igual a `created_at`. Numa execucao de verdade esse
  // campo avanca em 4 s (medido com disparo real). O teto de 6 h nao o pega, e foi por isso que
  // o ao-vivo ficou cego por seis horas.
  const parado = (min) => ({ created_at: emMin(min), updated_at: emMin(min) });
  const andando = (min) => ({ created_at: emMin(min), updated_at: emMin(min - 1) });

  console.log('\n6 · registro criado e NUNCA iniciado');
  registros.length = 0;
  ok(await monta({ queued: [parado(240)] })('way2-recent.yml', log) === false,
    'queued de 4 h, updated = created: NAO bloqueia (o caso de 13/09)');
  ok(registros.length === 1 && /nunca iniciada/.test(registros[0]),
    'e ele e dito, com o motivo: ' + (registros[0] || '(nada)').slice(0, 78));

  registros.length = 0;
  ok(await monta({ queued: [andando(240)] })('x.yml', log) === true,
    'queued de 4 h que JA se mexeu: bloqueia — este pode estar vivo');
  ok(registros.length === 0, 'e ninguem o chama de morto');

  console.log('\n7 · a margem, e a borda dela');
  ok(await monta({ queued: [parado(1)] })('x.yml', log) === true,
    'parado ha 1 min: ainda bloqueia (a execucao acabou de nascer)');
  ok(await monta({ queued: [parado(PARADA_MIN + 1)] })('x.yml', log) === false,
    'parado ha ' + (PARADA_MIN + 1) + ' min: ja nao bloqueia');
  ok(await monta({ queued: [parado(240), { created_at: emMin(3), updated_at: emMin(2) }] })('x.yml', log) === true,
    'um parado e uma viva: a VIVA manda');

  // 🔴 a margem nao e escolhida: e a menor cadencia da agenda, para um registro parado custar no
  //    maximo UM ciclo do workflow mais rapido. Se alguem puser um cron mais curto, isto reprova.
  const agenda = JSON.parse(fs.readFileSync(path.join(__dirname, 'agenda.json'), 'utf8'));
  const menor = Math.min(...[].concat(...Object.values(agenda)).map((c) => {
    const m = /^0 \*\/(\d+) /.exec(c); return m ? Number(m[1]) : 60;
  }));
  ok(PARADA_MIN <= menor,
    'a margem (' + PARADA_MIN + ' min) nao passa da menor cadencia da agenda (' + menor + ' min)');

  console.log('\n' + (mau ? mau + ' FALHA(S)' : 'tudo passou'));
  process.exit(mau ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
