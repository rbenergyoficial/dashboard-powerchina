/*
 * lib-selo.js — o selo de frescor passa a poder ficar VERMELHO SOZINHO.
 *
 * ── 🔴 O DEFEITO QUE ISTO FECHA (medido em 13/09/2026) ───────────────────────────────────────
 *
 * O humano abriu o Monitor às 09:49 e o gauge mostrava o dado das 07:30 — duas horas atrás. E o
 * selo do cabeçalho, ao lado, dizia **"Way2 9 min · Medidores 24/24" em VERDE**.
 *
 * O selo não estava atrasado: ele estava CONGELADO. O `9` é um literal gravado dentro do blob, e
 * quem o calcula é o gerador. Quando o gerador para, o número para com ele — **o selo mede a
 * idade do dado no instante em que o arquivo foi escrito, e esse instante também parou**. Um selo
 * assim nunca fica vermelho por gerador parado, que é exatamente o caso em que ele mais importa.
 *
 * É a família que este pipeline já nomeou duas vezes: "fresco sobre dado velho é o modo de falhar
 * mais caro — nada fica vermelho e o leitor confia".
 *
 * ── A CORREÇÃO ──────────────────────────────────────────────────────────────────────────────
 *
 * O blob passa a publicar, ao lado do que já publicava, o que o PAINEL precisa para refazer a
 * conta contra o relógio de QUEM LÊ:
 *
 *   ms   o instante ÂNCORA em epoch — o último dado de verdade, não a hora da gravação
 *   ok   até quantos MINUTOS de idade o selo é verde
 *   alt  até quantos minutos é âmbar; acima disso, vermelho
 *   un   'min' | 'h' | 'd' — quando presente, o valor na tela É a idade nessa unidade;
 *        quando ausente, o `v` publicado fica (é uma data) e só a COR se refaz
 *   cs   as três cores, nesta ordem: verde, âmbar, vermelho
 *
 * 🔴 AS CORES VÊM DAQUI, E NÃO DO PAINEL. Elas já vivem no gerador; se o painel as escrevesse
 *    também, seriam duas escritas da mesma paleta — o defeito que esta casa mais pagou. O painel
 *    recebe as três e escolhe; ele não sabe qual é qual até ler.
 *
 * ⚠️ O QUE ISTO NÃO RESOLVE, declarado: a conta passa a depender do relógio da máquina de quem
 *    lê. Relógio adiantado mostra o selo mais velho do que é; atrasado, mais novo. É uma troca
 *    deliberada — um relógio errado é raro e visível, e um selo congelado é frequente e invisível.
 *
 * ⚠️ E o campo `c` ANTIGO continua sendo publicado, com o valor de sempre. Ele é o que a tela
 *    mostra se o painel for velho, se o JS não rodar ou se `ms` faltar: a mudança é ADITIVA, e
 *    nada que já lê o blob quebra.
 */
'use strict';

/* as mesmas três do selo desde sempre — uma escrita só, e é esta */
const VERDE = '#2FBF71';
const AMBAR = '#FF8A3D';
const VERMELHO = '#E5484D';

/**
 * Os campos que fazem o selo se refazer no navegador.
 * @param {number} ms     epoch do instante âncora (o último dado)
 * @param {number} okMin  idade, em minutos, até onde é verde
 * @param {number} altMin idade, em minutos, até onde é âmbar
 * @param {string} [un]   'min' | 'h' | 'd' — só quando o VALOR do selo é a própria idade
 */
function frescor(ms, okMin, altMin, un) {
  if (!isFinite(ms) || !isFinite(okMin) || !isFinite(altMin)) return {};
  const o = { ms: Math.round(ms), ok: Math.round(okMin), alt: Math.round(altMin),
    cs: [VERDE, AMBAR, VERMELHO].join(',') };
  if (un) o.un = un;
  return o;
}

/* a cor de AGORA, para o gerador continuar publicando `c` como sempre publicou */
function corDe(ms, okMin, altMin, agora) {
  const min = ((agora == null ? Date.now() : agora) - ms) / 60000;
  return min <= okMin ? VERDE : min <= altMin ? AMBAR : VERMELHO;
}

const HORA = 60;
const DIA = 1440;

module.exports = { VERDE, AMBAR, VERMELHO, HORA, DIA, frescor, corDe };
