'use strict';
/*
 * lib-trafo-ied.js — le as planilhas do historiador da SE (pasta IED/04T1 e IED/04T2 no SharePoint, copiadas para o
 * scada-raw como `<id>_01.01 A 05.10.xlsx`) e devolve a serie de 5 min de cada transformador.
 *
 * Medido em 06/10/2026 nas 8 planilhas (04T1 e 04T2, 230 kV e X1/X2 34,5 kV, 01/05/2025 a 05/10/2026):
 *
 * 🔴 O ARQUIVO NAO DIZ O TRAFO NO NOME (o fluxo grava `<id>_01.01 A 05.10.xlsx`). O trafo sai do PREFIXO DAS TAGS:
 *    UCT1/URT1 = 04T1, UCT2/URT2 = 04T2 — provado pelo dado: nos 8.400 instantes comuns com o export do SCADA, corrente,
 *    tensao e potencia ativa sao IGUAIS (|dif| mediana 0,003, 99 % abaixo de 0,01) com esse mapeamento. O lado sai das
 *    tags (CMMXU1/VMMXU1 = 230 kV; CMMXU2/3 e VMMXU2/3 = X1 e X2 de 34,5 kV). Mistura de trafos, ou tag desconhecida
 *    junto de tag de trafo, ESTOURA; planilha sem DataHora ou sem nenhuma tag de trafo devolve null (nao e desta pasta).
 * 🔴 O CARIMBO E NUMERO DE SERIE DO EXCEL em hora de Brasilia, e quase sempre 1 ms ANTES da marca (HH:M4:59.999): o
 *    instante e ARREDONDADO para os 5 min mais proximos.
 * 🔴 TODA TAG E "_INT": valor INTERPOLADO pelo historiador, que grava por excecao. Entre dois registros o valor e
 *    estimado; e quando o historiador para de gravar a interpolacao REPETE o ultimo registro por semanas. Medido: as
 *    correntes e tensoes estao CONGELADAS de 01/05 a ~06/10/2025 (158 dias com o mesmo valor); a temperatura do 04T1
 *    de 01/05/2025 a meados de set/2026 (505 dias); a do 04T2 ate meados de dez/2025. Nos meses vivos o maior trecho
 *    constante e de ~10 h nas correntes e ~5 h nas temperaturas. Trecho de MAIS DE 24 h com o mesmo valor e congelado
 *    e sai como SEM DADO, nunca como medicao (a 24 h fica entre os dois).
 * 🔴 O TAP NAO ENTRA: a posicao do tap e degrau inteiro e a interpolacao a desenha fracionaria (8,25, 8,15...).
 * 🔴 `CVMMXN1_VolAmp` E PREFIXO DE `CVMMXN1_VolAmpr`: a tag casa com fronteira (nada alfanumerico depois), senao a
 *    potencia aparente sai a reativa.
 */
const PASSO = 300000;                                   // 5 min, ms
const CONGELADO_PASSOS = 288;                           // mais de 24 h com o mesmo valor = congelado
const ARQ_IED = /\d\d\.\d\d A \d\d\.\d\d\.xlsx$/i;      // o nome que a pasta IED/04T1|04T2 usa (o periodo do arquivo)
const TRAFO_DO_PREFIXO = { UCT1: '04T1', URT1: '04T1', UCT2: '04T2', URT2: '04T2' };
// chave publicada -> pedaco da tag (o mesmo vocabulario do gen-trafo; sem o tap)
const GRANDEZAS_IED = {
  i1a: 'CMMXU1_A_phsA', i1b: 'CMMXU1_A_phsB', i1c: 'CMMXU1_A_phsC',
  i2a: 'CMMXU2_A_phsA', i2b: 'CMMXU2_A_phsB', i2c: 'CMMXU2_A_phsC',
  i3a: 'CMMXU3_A_phsA', i3b: 'CMMXU3_A_phsB', i3c: 'CMMXU3_A_phsC',
  v1ab: 'VMMXU1_PPV_phsAB', v1bc: 'VMMXU1_PPV_phsBC', v1ca: 'VMMXU1_PPV_phsCA',
  v2ab: 'VMMXU2_PPV_phsAB', v2bc: 'VMMXU2_PPV_phsBC', v2ca: 'VMMXU2_PPV_phsCA',
  v3ab: 'VMMXU3_PPV_phsAB', v3bc: 'VMMXU3_PPV_phsBC', v3ca: 'VMMXU3_PPV_phsCA',
  p: 'CVMMXN1_Watt', q: 'CVMMXN1_VolAmpr', s: 'CVMMXN1_VolAmp', fp: 'CVMMXN1_PwrFact',
  t_oleo: 'AnIn30_InstMag_f', t_oleo_cdc: 'AnIn31_InstMag_f', t_enrol: 'AnIn32_InstMag_f',
};
// a tag casa o pedaco com FRONTEIRA: nada alfanumerico logo depois (VolAmp nao casa VolAmpr)
const casa = (tag, pedaco) => new RegExp(pedaco + '(?![A-Za-z0-9])').test(tag);
// numero de serie do Excel (dias desde 30/12/1899, hora local de Brasilia) -> epoch ms, arredondado para 5 min
const serialParaMs = (x) => Math.round(((x - 25569) * 86400000 + 3 * 3600e3) / PASSO) * PASSO;

function leIed(XLSX, buf, nome) {
  const wb = XLSX.read(buf, { dense: true, cellDates: false, cellText: false, cellHTML: false, cellStyles: false });
  let rows = null;
  for (const n of wb.SheetNames) {
    const r = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, raw: true });
    if (r.length && String((r[0] || [])[0] || '').trim() === 'DataHora') { rows = r; break; }
  }
  if (!rows) return null;                               // nao e planilha do historiador: quem chama registra e segue
  const cab = rows[0].map((c) => String(c == null ? '' : c).trim());
  const prefixos = new Set(cab.slice(1).filter(Boolean).map((c) => c.split('_')[0]));
  const trafos = new Set([...prefixos].map((p) => TRAFO_DO_PREFIXO[p] || '?' + p));
  if (![...trafos].some((t) => !t.startsWith('?'))) return null;   // nenhuma tag de trafo: outra planilha
  if (trafos.size !== 1) {
    throw new Error(nome + ': prefixo de tag nao reconhecido ou de mais de um trafo (' + [...prefixos].join(', ') + ')');
  }
  const trafo = [...trafos][0];
  const col = {};
  for (const [k, p] of Object.entries(GRANDEZAS_IED)) {
    const i = cab.findIndex((c, j) => j > 0 && casa(c, p));
    if (i > 0) col[k] = i;
  }
  const lado = col.i1a ? '230' : col.i2a ? '34,5' : null;
  if (!lado) throw new Error(nome + ': sem corrente de 230 kV nem de 34,5 kV no cabecalho');
  const linhas = [];
  let recusadas = 0;
  for (let n = 1; n < rows.length; n += 1) {
    const r = rows[n];
    if (!r || typeof r[0] !== 'number' || !isFinite(r[0])) { if (r && r.length) recusadas += 1; continue; }
    const v = {};
    for (const [k, i] of Object.entries(col)) { const x = r[i]; if (typeof x === 'number' && isFinite(x)) v[k] = x; }
    linhas.push({ ms: serialParaMs(r[0]), v });
  }
  return { trafo, lado, colunas: Object.keys(col), linhas, recusadas };
}

/* tira os trechos CONGELADOS de uma serie de 5 min: Map ms -> { chave: valor }. Para cada chave, um trecho de instantes
   CONSECUTIVOS (passo de 5 min) com o MESMO valor, mais longo que CONGELADO_PASSOS, sai inteiro. Devolve a contagem
   de instantes tirados por chave */
function tiraCongelados(serie, chaves) {
  const ms = [...serie.keys()].sort((a, b) => a - b);
  const tirados = {};
  for (const k of chaves) {
    let ini = 0;
    const fecha = (fim) => {                                // [ini, fim) e um trecho de valor igual
      if (fim - ini > CONGELADO_PASSOS) {
        for (let j = ini; j < fim; j += 1) delete serie.get(ms[j])[k];
        tirados[k] = (tirados[k] || 0) + (fim - ini);
      }
    };
    for (let j = 1; j <= ms.length; j += 1) {
      const a = serie.get(ms[j - 1])[k], b = j < ms.length ? serie.get(ms[j])[k] : undefined;
      const continua = j < ms.length && b !== undefined && a !== undefined && b === a && ms[j] - ms[j - 1] === PASSO;
      if (!continua) { fecha(j); ini = j; }
    }
  }
  return tirados;
}

module.exports = { PASSO, CONGELADO_PASSOS, ARQ_IED, GRANDEZAS_IED, TRAFO_DO_PREFIXO, casa, serialParaMs, leIed, tiraCongelados };
