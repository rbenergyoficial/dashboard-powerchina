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
 * 17/10/2026 (ref-teto-2, decisao do humano): o arquivo de 15/10 trouxe DOIS patamares zerados (09:00 e 13:00, gref 0 e disp 0 com
 * ~340 MW gerados; soma das usinas 320,19 e 322,66), sem restricao. O teto passou a 2; tres no mesmo dia seguem derrubando.
 * Acima do teto e um arquivo do conjunto quebrado em atacado: o corte do Complexo usa o `gref` dele, e aceitar calado
 * publicaria corte perto de zero. Ele derruba, e o humano olha.
 *
 * E O CORTE (PROMOVER ref-parcela-corte, 11/10/2026, decisao do humano): o patamar absorvido entra no corte do conjunto
 * pela soma das usinas, e a `disp` dele sai da media como nao publicada (`corrigeConjunto`). O gerador roda a guarda e a
 * correcao logo depois de ler o conjunto, ANTES de apurar o corte; mais adiante a guarda roda de novo e o patamar ja fecha.
 */
const H = 0.5;                 // patamar do ONS: 30 min
const FOLGA_MW = 0.03;         // por patamar: o maximo medido entre o conjunto e a soma das usinas
const FOLGA_DIA = 0.75;        // no dia: FOLGA_MW x 48 x 0,5 h = 0,72 MWh, arredondada
const MAX_POR_DIA = 2;         // limite de risco, no dia que nao fecha (PROMOVER ref-teto-2, 17/10/2026, decisao do humano: 15/10 trouxe dois)

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

/**
 * A referencia das usinas a partir do detalhe do ONS (`ons_irradiancia_AAAA_MM`), na MESMA forma que o gerador monta mais
 * adiante: `refHora` dia -> usina -> { ge: [48] } com o MW do patamar a 2 casas, e `refDia` dia -> MWh do Complexo, so nos
 * dias com as nove usinas (tudo-ou-nada, como o `ref_dia_ufv`). Cru: sem a soma M3+M7 de antes do reparo, sem reconstrucao.
 * Existe para a correcao do corte rodar ANTES da secao 1 do gerador (PROMOVER ref-parcela-corte, 11/10/2026).
 */
function refPorUsina(cruPorMes, { desde, usinas }) {
  const refHora = {}, soma = {};
  for (const C of Object.values(cruPorMes || {})) for (const r of C || []) {
    const dd = String(r.ts).slice(0, 10); if (desde && dd < desde) continue;
    const u = String(r.u).replace('CEFMT', 'M'); if (!usinas.includes(u)) continue;
    const k = slot(r.ts); if (!(k >= 0 && k < 48)) continue;
    const hd = refHora[dd] || (refHora[dd] = {});
    const hu = hd[u] || (hd[u] = { ge: new Array(48).fill(null) });
    hu.ge[k] = r2(num(r.ge));
    const sd = soma[dd] || (soma[dd] = {});
    sd[u] = (sd[u] || 0) + num(r.ge) * H;
  }
  const refDia = {};
  Object.entries(soma).forEach(([d, s]) => { if (usinas.every((u) => s[u] != null)) refDia[d] = r2(usinas.reduce((a, u) => a + s[u], 0)); });
  return { refHora, refDia };
}

/**
 * Aplica no arquivo do CONJUNTO, no lugar, a troca que a guarda aceitou (PROMOVER ref-parcela-corte, 11/10/2026): no patamar
 * absorvido o `gref` passa a ser a soma das usinas, e a `disp` vira 0 — AUSENCIA de publicacao, a mesma leitura que o
 * gerador ja da ao 0 —, porque o detalhe por usina nao traz disponibilidade para somar, e o 49 MW do conjunto e de uma usina
 * so. A linha leva `_ref_pela_soma: 1`, que o gerador conta no dia. Devolve quantas linhas trocou.
 * Por que no corte e nao so na guarda: o corte do conjunto e max(0, gref − ger) nos patamares limitados, e com a parcela do
 * M6 no lugar da soma o de 01/10 09:00 dava ZERO; pela soma, 36,09 MWh (decisao do humano em 11/10/2026).
 */
function corrigeConjunto(consolidado, absorvidos) {
  const porTs = new Map((absorvidos || []).map((a) => [a.ts, a]));
  let n = 0;
  for (const r of consolidado || []) {
    const a = porTs.get(String(r.ts).slice(0, 16)); if (!a) continue;
    r.gref = String(a.soma); r.disp = '0'; r._ref_pela_soma = 1; n++;
  }
  return n;
}

/**
 * A LISTA PUBLICADA pelo executivo (`ref_conjunto_pela_soma`: [{ ts, gref_publicado, soma_usinas }]) para quem le o conjunto
 * por OUTRA via e tem de apurar o mesmo corte: o `gen-pr` (impedida do PR corrigido) e o `gen-benchmark-ons` (o nosso corte
 * no comparativo regional, de onde o `corte_gemeo` tira o apurado do painel). Uma decisao so, a do executivo; quem a aplica
 * troca SO onde o cru ainda traz o defeito (`disp < ger` e o `gref` longe da soma), entao a lista velha de um patamar que o
 * operador ja republicou certo nao troca nada.
 */
function mapaDaLista(lista) {
  return new Map((lista || []).filter((x) => x && x.ts != null && Number.isFinite(Number(x.soma_usinas)))
    .map((x) => [String(x.ts).slice(0, 16), Number(x.soma_usinas)]));
}
/** a soma das usinas para esta linha do conjunto ({ ts, gref, ger, disp }), se ela esta na lista e o cru ainda traz o defeito */
function somaDaLista(mapa, r) {
  const s = mapa.get(String(r.ts).slice(0, 16));
  if (s == null) return null;
  if (!(num(r.disp) < num(r.ger)) || Math.abs(num(r.gref) - s) <= FOLGA_MW) return null;
  return s;
}
/** aplica a lista publicada nas linhas do conjunto, no lugar, pela mesma troca do executivo. Devolve quantas trocou. */
function aplicaLista(consolidado, lista) {
  const m = mapaDaLista(lista), abs = [];
  for (const r of consolidado || []) { const s = somaDaLista(m, r); if (s != null) abs.push({ ts: String(r.ts).slice(0, 16), soma: s }); }
  return corrigeConjunto(consolidado, abs);
}

/*
 * O DIA QUE NAO FECHA E RETIDO, E NAO PARA O EXECUTIVO (PROMOVER ref-retem-dia, 11/10/2026, decisao do humano). De 06/10 23:00Z
 * a 07/10 18:13Z o operador republicou 01–05/10 inteiros e os dois arquivos chegaram em horas diferentes: o por usina (5
 * vezes por dia) ja trazia a revisao nova, o do conjunto (consolidado 1 vez por dia) a velha; a guarda viu certo e derrubou o
 * executivo inteiro por ~19 h — manchete, dias fechados e o resto congelados por causa de um campo de referencia.
 * Agora o dia que nao fecha sai do `ref_dia_ufv` (todas as linhas: as nove usinas e os agregados) e do `ref_hora`, e vai para
 * `ref_dias_retidos` com a hora em que comecou a ser retido (`desde`, carregada da publicacao anterior). O resto do executivo
 * grava. O teto (atacado) segue parando: ali o corte do conjunto estaria errado.
 * E a retencao NAO se cala: dia retido ha mais de LIMITE_RETIDO_H e o ensaio de produto reprova. 27 h = o pior caso da
 * cadencia das duas fontes (o mensal do conjunto e escrito as 16:00Z, o consolidado roda as 18:17Z, o executivo de hora em
 * hora: uma revisao que chega logo depois das 16:00Z so entra no consolidado do dia seguinte, ~26,3 h depois); a fase A
 * medida durou 19 h.
 * A MARGEM sobre o pior caso e de minutos: um dia retido na rodada das 16:13Z so fecha na das 19:13Z do dia seguinte, e so
 * se o consolidado das 18:17Z rodou antes. Se o consolidado atrasa ou falha, a retencao vence e o ensaio fica vermelho — e
 * esse e o sinal certo: o descompasso entre os dois arquivos do operador deixou de ser so de cadencia.
 * E a retencao nao esconde defeito NOSSO: o ensaio de produto confere cada dia retido contra os dois arquivos crus do
 * operador (a soma das nove usinas do arquivo por usina tem de ser a referencia que o executivo calculou, o gref tem de ser o
 * do arquivo do conjunto, e os dois tem de discordar entre si); fora disso o defeito e nosso e reprova na hora.
 */
const LIMITE_RETIDO_H = 27;
/** tira do `ref_dia_ufv` os dias que nao fecham; devolve as linhas que ficam e a lista de retidos com o `desde` carregado */
function retemDias(refDiaUfv, ruins, desdeAntes, agoraIso) {
  const fora = new Set((ruins || []).map((x) => x.dia));
  const retidos = (ruins || []).map((x) => ({ dia: x.dia, ref_mwh: x.ref_mwh, gref_mwh: x.gref_mwh, desde: (desdeAntes || {})[x.dia] || agoraIso }));
  return { linhas: (refDiaUfv || []).filter((x) => !fora.has(x.dia)), retidos, fora };
}
/** os retidos ha mais de LIMITE_RETIDO_H horas no instante `agoraMs` */
function retidosVencidos(retidos, agoraMs) {
  return (retidos || []).filter((x) => !(Date.parse(x.desde) > 0) || (agoraMs - Date.parse(x.desde)) / 3600e3 > LIMITE_RETIDO_H);
}

/** Os dias do Complexo (`[{ dia, ref_mwh }]`) que nao fecham com o `grefDia` do conjunto. Dia sem conjunto nao se julga. */
function diasQueNaoFecham(refComplexo, grefDia) {
  return (refComplexo || []).filter((x) => grefDia[x.dia] != null && Math.abs(x.ref_mwh - grefDia[x.dia]) > FOLGA_DIA)
    .map((x) => ({ dia: x.dia, ref_mwh: x.ref_mwh, gref_mwh: r2(grefDia[x.dia]) }));
}

module.exports = { grefConjuntoPorDia, diasQueNaoFecham, refPorUsina, corrigeConjunto, mapaDaLista, somaDaLista, aplicaLista,
  retemDias, retidosVencidos, LIMITE_RETIDO_H, FOLGA_MW, FOLGA_DIA, MAX_POR_DIA, H };
