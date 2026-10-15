/*
 * lib-irr-ons-tag.js — a irradiancia que o ONS publica por usina: o mapa das tags, a leitura de cada linha, a referencia do
 * datalogger e a conferencia do M7 (PROMOVER irr-ons-m7).
 *
 * POR QUE EXISTE. O `gen-irradiancia` deixava a tag CEFMT7 de fora ("nao e o M7: e o circuito 2 do M3"), herdando um defeito
 * que e da GERACAO: o registro de geracao CEFMT7 foi o circuito 2 do M3 ate 16/07/2026 (TAG_M7_OK do gen-executivo). Na
 * IRRADIANCIA o CEFMT7 e o M7: medido em 15/10/2026 contra o datalogger das estacoes (meias horas com mais de 100 W/m2),
 * a diferenca mediana do CEFMT7 para o M7 foi de 1,0 a 2,6 W/m2 em cada mes de nov/25 a out/26, e para o M3 de 43 a 121
 * W/m2; o Relatorio Geral do SAGER rotula a coluna `MTD_MAURITI_7 · CEFMT7_D_SOLAR_IRRAD.V`. Sem o M7, o Comparativo de
 * Medicoes tirava a usina inteira da soma do Complexo na irradiancia.
 * ⚠️ set/25 e out/25 NAO batem a 1-3 W/m2: o CEFMT7 fica a 55 e 64 W/m2 do datalogger do M7 (ainda o mais perto: o M3 a 167
 *    e 115). Antes da operacao comercial TODAS as tags do ONS ficam longe (o CEFMT3 a 65 W/m2 do M3 em set/25): por isso a
 *    conferencia publica `med_outras` (a concordancia das outras oito no mesmo mes) ao lado — o mes em que o M7 concorda pior
 *    que as outras e DECLARADO pelo ensaio, nao escondido. Limite absoluto de concordancia: PENDENTE-HUMANO (fonte nomeada).
 *
 * A GUARDA. A tag ja trocou de usina uma vez na geracao; entao o M7 do ONS so entra no mes em que ele bate com a irradiancia
 * do PROPRIO M7 medida no parque melhor do que com a do M3: mediana de |ONS M7 - parque M7| menor que mediana de
 * |ONS M7 - parque M3|, nas meias horas com o ONS acima do limiar do contrato (LIMIAR_IRR) e as duas leituras do parque
 * presentes. Mes que falha perde o M7 do ONS (retira, nunca substitui); mes com menos de N_MIN pares nao tem como ser
 * conferido e fica, dito no resultado. O resultado vai para o blob (`ons_tag_m7`), nao so para o log.
 * 🔴 A REFERENCIA E O DATALOGGER DAS ESTACOES (estacao_logger_30min.json), NUNCA O SCADA: o ONS publica a MEDIA da meia
 *    hora, a mesma grandeza do datalogger; o SCADA e a AMOSTRA no inicio dela. Medido no primeiro ensaio (15/10/2026):
 *    contra o SCADA o M7 e o M3 ficam a 40-120 W/m2 os dois e a guarda RETIRAVA ago/26 e out/26 por engano.
 * 🔴 A chave e o slot moram AQUI (chaveOns, indiceDatalogger), julgados em caso forjado com rotulo de borda: o gerador e o
 *    ensaio usam a mesma funcao, e o ensaio do produto refaz a conferencia e compara com a publicada (o fio do gerador).
 */
const { LIMIAR_IRR } = require('./lib-disponibilidade.js');

const ONS_TAG = { CEFMT1: 'M1', CEFMT2: 'M2', CEFMT3: 'M3', CEFMT4: 'M4', CEFMT5: 'M5',
  CEFMT6: 'M6', CEFMT7: 'M7', CEFMT8: 'M8', CEFMT9: 'M9' };
const N_MIN = 30;   // pares por mes para a conferencia valer (um dia de sol tem ~22 meias horas acima do limiar)
const BRT = 3 * 3600e3;

const mediana = (xs) => { const s = xs.slice().sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const slotDe = (hh, mm) => +hh * 2 + (+mm >= 30 ? 1 : 0);

/** uma linha do `consolidado` do ONS -> [chave `dia|ufv|slot`, W/m2] ou null. `ts` e o inicio da meia hora, horario de Brasilia,
 *  sem offset ('2026-08-01 10:30:00'). Fica fora: tag fora do mapa, medida que o proprio ONS marcou invalida, celula vazia. */
function chaveOns(r) {
  const u = ONS_TAG[r && r.u]; if (!u) return null;
  if (String(r.inv) === 'True') return null;              // o proprio ONS marcou a medida invalida
  if (r.irr == null || r.irr === '') return null;          // celula vazia nao e zero
  const v = Number(r.irr); if (!isFinite(v)) return null;
  const ts = String(r.ts);
  return [ts.slice(0, 10) + '|' + u + '|' + slotDe(ts.slice(11, 13), ts.slice(14, 16)), v];
}

/** o estacao_logger_30min.json -> { 'dia|Mn|slot': W/m2 }. Dia e slot saem do EPOCH `ms` (inicio da meia hora) em BRT. */
function indiceDatalogger(DL) {
  const I = {};
  for (const r of (DL && DL.serie) || []) {
    if (!isFinite(r.ms)) continue;
    const t = new Date(r.ms - BRT).toISOString(), d = t.slice(0, 10), s = slotDe(t.slice(11, 13), t.slice(14, 16));
    for (let n = 1; n <= 9; n++) if (r['e' + n] != null && isFinite(r['e' + n])) I[d + '|M' + n + '|' + s] = r['e' + n];
  }
  return I;
}

/**
 * @param {Object<string, number>} ons  chave `dia|ufv|slot` (slot numerico 0..47) -> W/m2 do ONS; e ALTERADO: o M7 do mes
 *   reprovado sai
 * @param {(dia: string, ufv: string, slot: number) => (number|null)} parque  a irradiancia no plano do DATALOGGER da estacao
 *   na meia hora (media de [T, T+30), rotulo no inicio)
 * @returns {Array<{mes, pares, med_m7, med_m3, med_outras, uso:'confere'|'retirado'|'sem_conferencia', retiradas}>}
 *   med_outras = a mediana de |ONS - parque| das OUTRAS oito usinas no mesmo mes (cada uma contra o proprio datalogger)
 */
function confereM7(ons, parque) {
  const porMes = new Map(), outras = new Map();
  for (const [k, v] of Object.entries(ons)) {
    const [d, u, s] = k.split('|'), m = d.slice(0, 7);
    if (u !== 'M7') {
      if (v == null || !(v > LIMIAR_IRR)) continue;
      const a = parque(d, u, +s); if (a == null || !isFinite(a)) continue;
      if (!outras.has(m)) outras.set(m, []); outras.get(m).push(Math.abs(v - a)); continue;
    }
    if (!porMes.has(m)) porMes.set(m, { chaves: [], d7: [], d3: [] });
    const o = porMes.get(m); o.chaves.push(k);
    if (v == null || !(v > LIMIAR_IRR)) continue;
    const a = parque(d, 'M7', +s), b = parque(d, 'M3', +s);
    if (a == null || b == null || !isFinite(a) || !isFinite(b)) continue;
    o.d7.push(Math.abs(v - a)); o.d3.push(Math.abs(v - b));
  }
  const out = [];
  for (const [mes, o] of [...porMes].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const m7 = mediana(o.d7), m3 = mediana(o.d3), n = o.d7.length;
    const uso = n < N_MIN ? 'sem_conferencia' : m7 < m3 ? 'confere' : 'retirado';
    if (uso === 'retirado') o.chaves.forEach((k) => { delete ons[k]; });
    out.push({ mes, pares: n, med_m7: r1(m7), med_m3: r1(m3), med_outras: r1(mediana(outras.get(mes) || [])), uso,
      retiradas: uso === 'retirado' ? o.chaves.length : 0 });
  }
  return out;
}

/** sem o arquivo do datalogger (HTTP 404) nao ha com o que conferir: o M7 do ONS sai INTEIRO, dito como 'sem_referencia' */
function semReferencia(ons) {
  const fora = Object.keys(ons).filter((k) => k.split('|')[1] === 'M7');
  fora.forEach((k) => { delete ons[k]; });
  return [{ mes: null, pares: 0, med_m7: null, med_m3: null, med_outras: null, uso: 'sem_referencia', retiradas: fora.length }];
}

module.exports = { ONS_TAG, N_MIN, chaveOns, indiceDatalogger, confereM7, semReferencia };
