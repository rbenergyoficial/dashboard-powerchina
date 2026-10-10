'use strict';
/*
 * lib-ref-conjunto.js — a guarda de fechamento do `ref_dia_ufv`: a referencia do Complexo, somada das nove usinas, contra
 * o `gref` do arquivo do CONJUNTO, dia a dia (PROMOVER executivo-vermelho, 10/10/2026). Saiu do `gen-executivo.js` para
 * o ensaio de regra (`ensaio-ref-conjunto.js`) julgar a MESMA conta que o gerador roda, e nao uma copia dela.
 *
 * A referencia do conjunto e o SOMATORIO das parcelas das usinas (RO-AO.BR.13 5.2.2.5, medido em 17.376 patamares do
 * SAGER). Se o dia nao fecha, uma usina sumiu ou foi lida errada do nosso lado, e o campo nao sai.
 *
 * O PATAMAR COM NENHUMA OU UMA PARCELA NO CONJUNTO e o unico que se confere pela soma das usinas:
 *   - 03/10/2026 (`ref-buraco-conjunto`): 01/10 09:00 veio no conjunto com `gref` 0 e `disp` 0 e 245,6 MW gerados;
 *   - 10/10/2026: o operador revisou os dois arquivos, e o mesmo patamar voltou com `gref` 47,246 e `disp` 49,105 com os
 *     mesmos 245,6 MW gerados; as nove usinas, 317,78 MW (vizinhos 285,7 e 321,1). 47,246 e a parcela do M6 (47,25).
 * As tres condicoes, e o que cada uma segura:
 *   - o patamar NAO fecha com a soma (|gref − Σ| > FOLGA_MW): o que fecha nao se mexe nem entra no log. O das 18 h, de
 *     geracao residual com nada publicado (gref 0, Σ 0), fecha e nao e defeito de ninguem;
 *   - o conjunto declara disponivel MENOS do que gerou (`disp < ger`): um conjunto com 49 MW disponiveis nao gera 245.
 *     Com `disp` coerente, a diferenca e nossa ou de vintage, e segue derrubando;
 *   - o `gref` dele e ZERO ou a parcela de UMA usina (± FOLGA_MW): duas parcelas ou mais, ou uma diferenca de outra forma
 *     (a de 06–07/10, o conjunto de uma revisao anterior contra as usinas da nova), seguem derrubando.
 * E SO NO DIA QUE NAO FECHA como foi publicado: dia que fecha com o conjunto cru (folga FOLGA_DIA) nao troca nem conta
 * patamar nenhum — o resíduo de fim de tarde que as usinas trazem e o conjunto nao publica (gref 0, disp 0) fecha no dia e
 * nao pode parar o executivo (revisor-ensaio, 10/10/2026: com o teto contando esses, um dia correto derrubava tudo).
 * E o TETO, no dia que nao fecha: no maximo MAX_POR_DIA patamar(es). Ele NAO e medida, e o limite de risco: varridos mar/26
 * a 09/10 (10.704 patamares do conjunto, 223 dias), so 01/10 09:00 nao fecha com as nove usinas, nunca dois no mesmo dia.
 * Mais de um e um arquivo do conjunto quebrado em atacado: o corte do Complexo usa o `gref` dele, e aceitar calado
 * publicaria corte perto de zero. Ele derruba, e o humano olha.
 *
 * ⚠️ So a GUARDA usa a soma das usinas. No corte do conjunto o patamar fica com perda ZERO (max(0, gref − ger)), e nao
 *    porque nao houve: em 01/10 09:00, com `lim` > 0, a soma das usinas apuraria 36,09 MWh. Trocar o `gref` desse patamar
 *    no corte (e o `disp` dele na media) muda numero publicado e e decisao do humano.
 */
const H = 0.5;                 // patamar do ONS: 30 min
const FOLGA_MW = 0.03;         // por patamar: o maximo medido entre o conjunto e a soma das usinas
const FOLGA_DIA = 0.75;        // no dia: FOLGA_MW x 48 x 0,5 h = 0,72 MWh, arredondada
const MAX_POR_DIA = 1;         // limite de risco, no dia que nao fecha: o maximo visto em 223 dias

const num = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };
const r2 = (x) => Math.round(x * 100) / 100;
const slot = (ts) => { const s = String(ts); return Number(s.slice(11, 13)) * 2 + (Number(s.slice(14, 16)) >= 30 ? 1 : 0); };

/**
 * O `gref` do conjunto por dia, em MWh, com o patamar de nenhuma ou uma parcela trocado pela soma das usinas.
 * @param consolidado  linhas do arquivo do conjunto: { ts, ger, disp, gref }
 * @param refHora      dia -> usina -> { ge: [48] } · MW por patamar, como o publicado no `ref_hora`
 * @param opts         { desde: 'AAAA-MM-DD', usinas: ['M1', …], refDia: { dia: ref_mwh do Complexo } }
 * @returns {{ grefDia: Object<string, number>, absorvidos: Array, excesso: Object<string, number> }}
 *   `excesso`: dia -> quantos patamares pediriam a troca, nos dias acima do teto (neles nada e trocado).
 */
function grefConjuntoPorDia(consolidado, refHora, { desde, usinas, refDia }) {
  const cand = [], cru = {};
  for (const r of consolidado || []) {
    const dd = String(r.ts).slice(0, 10); if (desde && dd < desde) continue;
    const g = num(r.gref);
    cru[dd] = (cru[dd] || 0) + g * H;
    let troca = null;
    if (num(r.disp) < num(r.ger) && refHora[dd]) {
      const k = slot(r.ts);
      const parc = usinas.map((u) => num(((refHora[dd][u] || {}).ge || [])[k]));
      const soma = parc.reduce((a, x) => a + x, 0);
      if (Math.abs(g - soma) > FOLGA_MW && (g === 0 || parc.some((x) => Math.abs(g - x) <= FOLGA_MW))) troca = soma;
    }
    cand.push({ dd, ts: String(r.ts).slice(0, 16), g, troca });
  }
  // so o dia que NAO fecha como publicado troca ou conta patamar; dia sem Complexo nao e julgado e nao precisa de troca
  const naoFechaCru = (d) => refDia && refDia[d] != null && Math.abs(refDia[d] - cru[d]) > FOLGA_DIA;
  cand.forEach((c) => { if (c.troca != null && !naoFechaCru(c.dd)) c.troca = null; });
  const nDia = {};
  cand.forEach((c) => { if (c.troca != null) nDia[c.dd] = (nDia[c.dd] || 0) + 1; });
  const excesso = {};
  Object.keys(nDia).forEach((d) => { if (nDia[d] > MAX_POR_DIA) excesso[d] = nDia[d]; });
  const grefDia = {}, absorvidos = [];
  for (const c of cand) {
    let g = c.g;
    if (c.troca != null && !(c.dd in excesso)) { absorvidos.push({ dia: c.dd, ts: c.ts, gref: r2(c.g), soma: r2(c.troca) }); g = c.troca; }
    grefDia[c.dd] = (grefDia[c.dd] || 0) + g * H;
  }
  return { grefDia, absorvidos, excesso };
}

/** Os dias do Complexo (`[{ dia, ref_mwh }]`) que nao fecham com o `grefDia` do conjunto. Dia sem conjunto nao se julga. */
function diasQueNaoFecham(refComplexo, grefDia) {
  return (refComplexo || []).filter((x) => grefDia[x.dia] != null && Math.abs(x.ref_mwh - grefDia[x.dia]) > FOLGA_DIA)
    .map((x) => ({ dia: x.dia, ref_mwh: x.ref_mwh, gref_mwh: r2(grefDia[x.dia]) }));
}

module.exports = { grefConjuntoPorDia, diasQueNaoFecham, FOLGA_MW, FOLGA_DIA, MAX_POR_DIA, H };
