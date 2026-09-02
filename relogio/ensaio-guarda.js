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
const mFn = /async function jaRodando\(wf, log\) \{[\s\S]*?\n\}/.exec(fonte);
if (!mTeto || !mFn) throw new Error('nao achei TETO_VIVO_MS ou jaRodando em src/index.js');

// `gh` injetado: devolve o que o ensaio mandar, sem rede.
function monta(respostas) {
  return new Function('gh', mTeto[0] + '\n' + mFn[0] + '\nreturn jaRodando;')(
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

  console.log('\n' + (mau ? mau + ' FALHA(S)' : 'tudo passou'));
  process.exit(mau ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
