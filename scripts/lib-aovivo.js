/* lib-aovivo.js — o INSTANTE do ultimo dado do mes, que e o que o selo "ao vivo ate" publica.
 *
 * Por que existe uma funcao para duas linhas: a regra estava escrita dentro do executivo como
 * `parcQq[0].ate` — o PRIMEIRO dia parcial do mes — e "o primeiro" so coincide com "o mais recente"
 * quando ha exatamente UM dia parcial. Nao e o caso normal:
 *
 *   · o dia de hoje e sempre parcial (k=0 no anexo do snapshot);
 *   · um dia PASSADO que voltou truncado do snapshot tambem e parcial, e o gerador anula o `ate`
 *     dele de proposito (`if (!cheio) linha.ate = null`) — medido em 31/08/2026, quando o
 *     arquivador ficou 24 h sem rodar;
 *   · e entre duas rodadas completas o remendo de 5 min deixa a linha de ONTEM marcada parcial,
 *     com a hora do ultimo dado dela.
 *
 * Com dois parciais, `[0]` pega o de TRAS: ou devolve `null` e o selo ao vivo SOME da tela, ou
 * devolve a hora de ontem. Os dois casos afirmam errado sobre o agora.
 *
 * 🔴 E a escolha e por DATA, nao por posicao no array. O array chega ordenado hoje, e crivo que
 * aponta por posicao envelhece calado — esta casa ja pagou isso em indice de serie e de painel.
 *
 * ⚠️ O filtro por `parcial` FICA: `ate` so e escrito para o dia corrente (e para o que o remendo
 * de 5 min ainda trata como corrente). Sem ele, um dia arquivado que carregue `ate` entraria na
 * disputa e o selo poderia apontar para um dia fechado.
 */

/** o `ate` do dia MAIS RECENTE que tem um; null quando nenhum tem (mes fechado, ou dia sem leitura) */
function instanteAoVivo(dias) {
  let alvo = null;
  (dias || []).forEach((x) => {
    if (!x || !x.parcial || !x.ate) return;
    if (!alvo || String(x.dia) > String(alvo.dia)) alvo = x;
  });
  return alvo ? alvo.ate : null;
}

/** a regra ANTIGA, guardada para o ensaio PROVAR que o defeito estava plantado. Nao usar. */
function instanteAoVivoAntigo(dias) {
  const parcQq = (dias || []).filter((x) => x && x.parcial);
  return parcQq.length ? (parcQq[0].ate || null) : null;
}

module.exports = { instanteAoVivo, instanteAoVivoAntigo };
