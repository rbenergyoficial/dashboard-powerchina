'use strict';
/*
 * lib-contador-dia.js — a energia do dia de cada inversor, pelos contadores do proprio inversor.
 *
 * 🔴 O CONTADOR DIARIO NAO SERVE SOZINHO (03/10/2026). `ENERGIA DIÁRIA GERADA` nao zera a meia-noite: guarda o valor
 *    de ONTEM ate o inversor acordar, e o export preenche a madrugada a partir dali. Bruto do M8/TS3/INV01 de 26/09:
 *    2174,60 (o total de 25/09) das 01:00 as 03:30, rampa ate 0,32 as 05:30, fechou em 1128,60. O maior valor do dia
 *    devolvia a energia de ontem: em 26/09, 588 de 594 inversores conferidos contra o logger Sungrow, e o contador do
 *    conjunto no `perdas_diario` saiu igual ao de 25/09 em todas as usinas. Ele tambem zera de novo quando o inversor
 *    desarma e religa, e a zeragem pode vir a tarde (M1/TS5/INV14, 26/09: congelado em 2034,9 desde 25/09, zerou as
 *    16:00 e fechou em 0,1). Nenhuma regra de "onde comeca o dia" acerta os tres.
 *
 * A REGRA: o dia e a SUBIDA do contador de vida (`ENERGIA TOTAL GERADA`), que nao zera, somada degrau a degrau contra a
 *    ultima leitura ACEITA:
 *    · queda que VOLTA (alguma leitura posterior chega ao aceito) e preenchimento do export: pula;
 *    · queda SEM VOLTA e inversor TROCADO: o contador novo comeca em zero. O fundo da descida (a ultima leitura antes de
 *      voltar a subir) e a energia do inversor novo desde que ligou, e entra no dia se couber no teto desde o sol; os
 *      pontos ANTES do fundo sao a rampa que o export desenha ate ele, e nao entram;
 *    · subida acima do teto (CAP_KW x horas desde o aceito) e o aceito que era preenchimento (zero antes do primeiro
 *      valor real): rebaseia sem somar.
 *    Inversor que so entra na coleta depois do sol (M9/TS1, 18/09, a partir das 14:00) nao tem a manha no contador de
 *    vida; ali entra o contador DIARIO do primeiro instante, se ele for de hoje: ate o teto desde o sol, e acompanhando
 *    a subida do contador de vida dali em diante.
 *
 * MEDIDO no bruto de 30/08 a 29/09 (33.427 inversor-dias, as duas leituras do mesmo inversor):
 *    · a subida do contador de vida e o maior valor depois da zeragem do contador diario concordam a 1 % em 33.412;
 *    · os 15 restantes sao troca de inversor (4), desarme e religamento (4), zeragem a tarde (1), entrada na coleta a
 *      tarde (5) e um inversor cujos dois contadores divergem 2 % o dia inteiro (M2/TS2/INV03 em 31/08), cada um
 *      conferido na serie (ver o ensaio). A referencia de fora, o logger Sungrow, nao cobre esses dias.
 */
const CAP_KW = 352;        // teto do SG350HX: 110 % de 320 kW
const SOL_H = 5;           // 05:00 — antes do primeiro sol (primeira amostra acima de 1 kW: p05 05:30 no logger)
const MEIA_HORA = 0.5;

// 'AAAA-MM-DD HH:MM:SS' ou 'HH:MM[:SS]' -> horas decimais
const horas = (t) => { const m = String(t == null ? '' : t).match(/(\d{2}):(\d{2})(?::\d{2})?\s*$/); return m ? Number(m[1]) + Number(m[2]) / 60 : NaN; };
const valido = (v) => typeof v === 'number' && Number.isFinite(v);
const tetoDesde = (h0, h1) => CAP_KW * Math.max(h1 - h0, MEIA_HORA) * 1.02 + 0.01;

// os degraus de energia do dia pelo contador de vida: [{ i, e }] (i = indice do instante), ou null sem leitura positiva
function passosDoDia(vida, instantes) {
  const pts = [];
  for (let i = 0; i < vida.length; i++) if (valido(vida[i])) pts.push(i);
  if (!pts.some((i) => vida[i] > 0)) return null;
  const passos = [];
  let acc = null, hAcc = null;
  for (let n = 0; n < pts.length; n++) {
    const i = pts[n], v = vida[i], h = horas(instantes[i]);
    if (acc == null) { acc = v; hAcc = h; continue; }
    if (v < acc) {
      let volta = false;
      for (let m = n + 1; m < pts.length; m++) if (vida[pts[m]] >= acc) { volta = true; break; }
      if (volta) continue;                                         // preenchimento: o contador volta
      const desce = n + 1 < pts.length && vida[pts[n + 1]] < v;    // ainda na rampa ate o fundo
      if (!desce && h > SOL_H && v <= tetoDesde(SOL_H, h)) passos.push({ i, e: v });   // contador novo desde zero
      acc = v; hAcc = h; continue;
    }
    const d = v - acc;
    if (d > tetoDesde(hAcc, h)) { acc = v; hAcc = h; continue; }   // salto impossivel: o aceito era preenchimento
    passos.push({ i, e: d });   // degrau ZERO entra: inversor parado com os pares gerando e informacao do detalhe
    acc = v; hAcc = h;
  }
  return passos;
}

// energia do dia (kWh). `diaria` (opcional, alinhada) cobre o inversor que entrou na coleta depois do sol.
function energiaDoDia(vida, instantes, diaria) {
  const passos = passosDoDia(vida, instantes);
  if (passos == null) return null;
  let e = 0;
  for (const p of passos) e += p.e;
  if (diaria && e > 0) {
    let i0 = -1;
    for (let i = 0; i < vida.length; i++) if (valido(vida[i])) { i0 = i; break; }
    const h0 = horas(instantes[i0]), d0 = diaria[i0];
    if (h0 >= SOL_H + 1 && valido(d0) && d0 > 0 && d0 <= tetoDesde(SOL_H, h0)) {
      let dMax = d0;
      for (let i = i0; i < diaria.length; i++) if (valido(diaria[i]) && diaria[i] > dMax) dMax = diaria[i];
      if (Math.abs((dMax - d0) - e) <= Math.max(1, 0.02 * e)) e += d0;   // o diario e de hoje: acompanha o de vida
    }
  }
  return e;
}

module.exports = { passosDoDia, energiaDoDia, CAP_KW, SOL_H };
