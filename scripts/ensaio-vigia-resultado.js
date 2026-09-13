/*
 * ensaio-vigia-resultado.js — prova que o vigia enxerga o job que RODA E FALHA.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA. Até 13/09/2026 o vigia media se o workflow tinha RODADO, e só. Um
 *    job que roda no horário e falha toda vez saía do `relogio_saude.json` com
 *    `conclusao: "failure"` e `ok: 1` ao mesmo tempo — o campo estava publicado e ninguém o
 *    julgava. O `perdas.yml` ficou vermelho por dois dias, cinco execuções, sem alarme nenhum.
 *
 * A régua é a MESMA que já decide a cadência — o limite que sai do próprio cron —, aplicada a
 * outra coisa: a idade do último SUCESSO.
 *
 * O que este ensaio exige, com casos montados em memória (sem rede, sem segredo):
 *
 *   A · POSITIVA · rodando na cadência e sem sucesso além do limite → ACENDE. É o caso do
 *       `perdas.yml`, e é o único que importa acertar.
 *   B · NEGATIVA · falha ISOLADA não acende: se a última falhou mas houve sucesso recente, o
 *       job está se recuperando sozinho e alarme ali ensina a ignorar o alarme.
 *   C · NEGATIVA · execução EM ANDAMENTO não é falha. Sem isto, todo workflow pego no meio de
 *       uma rodada apareceria como defasado — medido: dois dos dezoito, no instante da medição.
 *   D · NEGATIVA · workflow SEM nenhum sucesso registrado não recebe veredito: recém-criado
 *       ainda não teve chance, e acusá-lo é alarme que nasce falso.
 *   E · as duas famílias têm CHAVE PRÓPRIA no estado: "não rodou" e "rodou e falhou" são
 *       diagnósticos diferentes, e um dedup comum engoliria o segundo em silêncio.
 *
 * uso: node ensaio-vigia-resultado.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

/* ⚠️ a regra é COMPILADA do próprio gerador, como ela sobe — não de uma cópia reescrita aqui,
   que provaria só que a cópia concorda consigo mesma. É a lição do ensaio da guarda do relógio. */
const fonte = fs.readFileSync(path.join(__dirname, 'gen-relogio-watchdog.js'), 'utf8');

function recorta(marca, ate) {
  const i = fonte.indexOf(marca);
  if (i < 0) throw new Error('nao achei no gen-relogio-watchdog.js: ' + marca);
  const j = fonte.indexOf(ate, i);
  if (j < 0) throw new Error('nao achei o fim de: ' + marca);
  return fonte.slice(i, j + ate.length);
}

const trechoSaude = recorta('const idadeOk = suc ?', 'rodando ? 1 : 0);');
const veredito = new Function('agora', 'ult', 'suc', 'limite',
  trechoSaude + '\nreturn { idadeOk: idadeOk, rodando: rodando, saudavel: saudavel };');

const MIN = 60000;
const agora = Date.parse('2026-09-13T18:00:00Z');
const run = (minAtras, conclusion, status) => ({
  created_at: new Date(agora - minAtras * MIN).toISOString(),
  conclusion: conclusion === undefined ? 'success' : conclusion,
  status: status || 'completed',
});

console.log('regra compilada do gerador: ' + trechoSaude.length + ' bytes');

console.log('');
console.log('A · POSITIVA · roda na cadência e nao tem sucesso ha dias  (o caso do perdas.yml)');
{
  const r = veredito(agora, run(7, 'failure'), run(8027), 33);
  ok(r.saudavel === 0, 'acende · ultimo sucesso ha ' + r.idadeOk + ' min contra limite de 33');
}

console.log('');
console.log('B · NEGATIVA · falha ISOLADA nao acende');
{
  const r = veredito(agora, run(7, 'failure'), run(20), 33);
  ok(r.saudavel === 1, 'nao acende · houve sucesso ha ' + r.idadeOk + ' min, dentro do limite');
}

console.log('');
console.log('C · NEGATIVA · execucao EM ANDAMENTO nao e falha');
{
  /* a última ainda não concluiu, e o último sucesso é a anterior — que já passou do limite.
     Sem a guarda de "rodando", isto acenderia em todo workflow pego no meio de uma rodada. */
  const r = veredito(agora, run(0, null, 'in_progress'), run(40), 33);
  ok(r.rodando === true, 'reconhece que esta rodando');
  ok(r.saudavel === 1, 'nao acende enquanto a execucao nao termina');
  /* e quando ela TERMINA em falha, com o mesmo sucesso velho, aí sim */
  const r2 = veredito(agora, run(0, 'failure'), run(40), 33);
  ok(r2.saudavel === 0, 'e acende assim que ela termina em falha');
}

console.log('');
console.log('D · NEGATIVA · sem NENHUM sucesso registrado, nao ha veredito');
{
  const r = veredito(agora, run(5, 'failure'), null, 33);
  ok(r.saudavel === null, 'fica sem julgamento em vez de acusar um workflow recem-criado');
}

console.log('');
console.log('E · as duas familias tem chave PROPRIA no estado');
{
  const mE = fonte.match(/const chaveEstado = [^\n]*/);
  ok(!!mE, 'o gerador tem a funcao de chave: ' + (mE ? mE[0].slice(0, 60) : '(nao achei)'));
  ok(/'cadencia:' \+ a\.wf/.test(fonte) || /chaveEstado\('cadencia'/.test(fonte), 'a cadencia tem prefixo proprio');
  ok(/chaveEstado\('resultado'/.test(fonte), 'o resultado tem prefixo proprio');
  ok(/chave: 'resultado:' \+ a\.wf/.test(fonte), 'o alerta do resultado leva chave estavel, para o dedup do canal funcionar');
  /* 🔴 e o alerta do resultado NAO pode culpar o relogio: o disparo esta funcionando, e apontar
     para o lugar errado e o que faz procurar defeito onde ele nao esta */
  ok(/ISTO NAO E PROBLEMA DO RELOGIO/.test(fonte), 'o texto do alerta diz que a causa NAO e o relogio');
}

console.log('');
if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
console.log('ensaio do vigia: passou.');
