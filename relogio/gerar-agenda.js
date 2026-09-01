// Gera `agenda.json` a partir dos PROPRIOS workflows, e confere que ela nao divergiu.
//
// 🔴 POR QUE A AGENDA E GERADA, E NAO ESCRITA
// O relogio toca no horario que a tabela dele diz. Se alguem mudar um cron num workflow e esquecer
// a tabela, o relogio continua tocando no horario ANTIGO — e nada quebra, nada fica vazio, o job
// so passa a rodar na hora errada. E o modo de falhar mais caro desta casa: silencioso e plausivel.
//
//   node gerar-agenda.js             regrava agenda.json
//   node gerar-agenda.js --conferir  nao grava; sai 1 se divergir (e o passo do CI)
//
// ⚠️ O cron do GitHub tem 5 campos; o NCRONTAB do Azure tem 6 — o primeiro e o SEGUNDO. Os dois
// correm em UTC, entao a conversao e so prefixar '0 ' e nao ha fuso a acertar. Errar isso desloca
// tudo em uma unidade e o horario sai plausivel, que e pior do que sair quebrado.

'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const SAIDA = path.join(__dirname, 'agenda.json');

// ⚠️ Workflows que NAO entram no relogio, com o motivo. Lista explicita: um workflow novo entra
// por padrao, e e melhor disparar de mais (o job tem guarda propria) do que esquecer um.
const FORA = {
  'azure-static-web-apps-kind-water-035b3230f.yml': 'dispara no push, nao no relogio'
};

function agrupa(crons) {
  // NCRONTAB aceita lista de HORAS ('13,23'), nao lista de expressoes. Entao crons que so diferem
  // na hora viram um temporizador so; os demais viram varios.
  const por = new Map();
  for (const c of crons) {
    const [m, h, ...resto] = c.trim().split(/\s+/);
    const k = m + '|' + resto.join(' ');
    if (!por.has(k)) por.set(k, []);
    por.get(k).push(h);
  }
  return [...por.entries()].map(([k, hs]) => {
    const [m, resto] = k.split('|');
    const horas = [...new Set(hs)].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return `0 ${m} ${horas.join(',')} ${resto}`;
  });
}

function monta() {
  const fora = [];
  const agenda = {};
  for (const f of fs.readdirSync(DIR).sort()) {
    if (!f.endsWith('.yml')) continue;
    const t = fs.readFileSync(path.join(DIR, f), 'utf8');
    const crons = [...t.matchAll(/cron:\s*'([^']+)'/g)].map(m => m[1]);
    if (!crons.length) continue;
    if (FORA[f]) { fora.push(f); continue; }
    // 🔴 Sem `workflow_dispatch` o relogio NAO consegue disparar — a API recusa com 422. Falhar
    // aqui, na geracao, e barato; descobrir no horario e uma rodada perdida sem explicacao.
    if (!/workflow_dispatch/.test(t)) {
      console.error(`RECUSADO: ${f} tem cron mas nao tem workflow_dispatch — o relogio nao alcanca`);
      process.exit(1);
    }
    agenda[f] = agrupa(crons);
  }
  return { agenda, fora };
}

const { agenda, fora } = monta();
const json = JSON.stringify(agenda, null, 1) + '\n';
const n = Object.values(agenda).reduce((s, v) => s + v.length, 0);

if (process.argv.includes('--conferir')) {
  const atual = fs.existsSync(SAIDA) ? fs.readFileSync(SAIDA, 'utf8') : '';
  if (atual !== json) {
    console.error('DIVERGENTE: agenda.json nao corresponde aos crons dos workflows.');
    console.error('Rode `node relogio/gerar-agenda.js` e publique o resultado.\n');
    const a = JSON.parse(atual || '{}');
    for (const k of new Set([...Object.keys(a), ...Object.keys(agenda)])) {
      const x = JSON.stringify(a[k]), y = JSON.stringify(agenda[k]);
      if (x !== y) console.error(`  ${k}\n    agenda: ${x}\n    workflow: ${y}`);
    }
    process.exit(1);
  }
  console.log(`agenda conferida · ${Object.keys(agenda).length} workflows · ${n} temporizadores`);
  if (fora.length) console.log('fora de proposito: ' + fora.join(', '));
  process.exit(0);
}

fs.writeFileSync(SAIDA, json);
console.log(`agenda.json gravada · ${Object.keys(agenda).length} workflows · ${n} temporizadores`);
for (const [k, v] of Object.entries(agenda)) console.log('  %s  %s', k.padEnd(26), v.join('  +  '));
if (fora.length) console.log('fora de proposito: ' + fora.join(', '));
