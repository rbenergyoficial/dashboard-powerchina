/* lib-tol-unidade.js — a tolerancia do par <grandeza>_mwh x <grandeza>_gwh, DERIVADA da cadeia de
 * arredondamento, e nao escolhida.
 *
 * POR QUE EXISTE. A guarda de fechamento das duas unidades usava 0,006 para tudo. Esse numero e o
 * do par NAO rateado — dois arredondamentos de 2 casas sobre a MESMA base. No RATEIO entra um
 * terceiro termo, e ele e o maior de todos: `meta_gwh` ja nasce arredondado a 10 MWh, entao as duas
 * bases ja diferem antes de o fator ser aplicado, e o fator propaga essa diferenca.
 *
 * A cadeia, escrita (G = a meta exata em GWh, f = o fator do rateio):
 *
 *     meta_gwh = r2(G)             ->  |meta_gwh - G|                      <= 0,005
 *     meta_mwh = r2(1000 G)        ->  |meta_mwh/1000 - G|                 <= 0,000005
 *     rat_gwh  = r2(meta_gwh x f)  ->  |rat_gwh - meta_gwh x f|            <= 0,005
 *     rat_mwh  = r2(meta_mwh x f)  ->  |rat_mwh/1000 - meta_mwh x f/1000|  <= 0,000005
 *
 *     |rat_mwh/1000 - rat_gwh| <= 0,005 + f x |meta_mwh/1000 - meta_gwh| + 0,000005
 *                              <= 0,005 x (1 + f) + poeira
 *
 * 🔴 MEDIDO ANTES DE ENTRAR, varrendo os 30 dias do mes nas 12 entidades: com 0,006 a guarda
 * reprovava em 4 dias do mes nas cinco usinas de meta igual (15, 20, 26 e 27), 1 dia no M2 e 1 no
 * M7 — e foi isso que deixou o executivo VERMELHO por 14 h em 15/09/2026, sem que nada no dado
 * estivesse errado. Com a tolerancia derivada, zero reprovacoes em 360 combinacoes, e o pior caso
 * fica a 0,94 do limite: ela e justa, nao folgada.
 *
 * ⚠️ O fator vem de `dias_corridos / dias_do_mes`, que a propria linha publica e que e EXATAMENTE o
 * fator do rateio (`gen-executivo.js`, bloco do `meta_rateada_*`). Recuperar o fator dos valores
 * rateados seria calibrar a guarda pelo suspeito — e um par errado nos dois lados passaria.
 */

/** o fator do rateio daquela linha; 1 quando o mes nao e parcial (ali rateada == cheia) */
function fatorRateio(x) {
  if (!x || !x.parcial) return 1;
  const d = Number(x.dias_corridos), n = Number(x.dias_do_mes);
  if (!(d > 0) || !(n > 0)) return 1;
  return Math.min(1, d / n);
}

/** a folga que a cadeia de arredondamento admite para o par rateado, em GWh */
function tolRateio(f) {
  const ff = (f > 0 && f <= 1) ? f : 1;
  return 0.005 * (1 + ff) + 1e-4;
}

/** o par NAO rateado: as duas escritas saem da mesma base, e um arredondamento cada */
const TOL_PAR = 0.006;

module.exports = { fatorRateio, tolRateio, TOL_PAR };
