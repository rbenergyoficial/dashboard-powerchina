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
 *    · queda SEM VOLTA cujo fundo e IGUAL ao diario do mesmo instante e inversor TROCADO: o contador novo comeca em
 *      zero, e o fundo (a energia do inversor novo desde que ligou) entra no dia se couber no teto desde o sol. Qualquer
 *      outra queda sem volta (a rampa que o export desenha ate o fundo; a queda de 0,1 kWh as 18:30 de um contador
 *      grande, 29 vezes no bruto) so rebaseia;
 *    · subida acima do teto (CAP_KW x horas desde o aceito) e o aceito que era preenchimento (zero antes do primeiro
 *      valor real): rebaseia sem somar.
 *    Inversor que so entra na coleta depois do sol (M9/TS1, 18/09, a partir das 14:00) nao tem a manha no contador de
 *    vida; ali entra o contador DIARIO do primeiro instante, se ele for de hoje: ate o teto desde o sol, e subindo antes
 *    da primeira queda (o valor de ontem fica parado ate zerar).
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
// ARRED: os contadores vem com duas casas; a diferenca de duas leituras erra ate 2 x 0,005 kWh
const ARRED = 0.01;
// teto de energia entre duas leituras: o SG350HX nao passa de 352 kW. Medido no bruto de 30/08 a 29/09, o maior degrau
// aceito em 1,47 milhao foi 345,4 kW medios (M7/TS1/INV08, 10/09 11:00): o teto nao corta medicao.
const tetoDesde = (h0, h1) => CAP_KW * Math.max(h1 - h0, MEIA_HORA) + ARRED;

// os degraus de energia do dia pelo contador de vida: [{ i, e }] (i = indice do instante), ou null sem leitura positiva.
// `diaria` (alinhada) e o que reconhece a TROCA: nos 14 casos do bruto o fundo da descida do contador de vida e igual ao
// diario do mesmo instante (o inversor novo comeca os dois juntos). Sem `diaria`, queda sem volta so rebaseia.
function passosDoDia(vida, instantes, diaria) {
  const pts = [];
  for (let i = 0; i < vida.length; i++) if (valido(vida[i])) pts.push(i);
  if (!pts.some((i) => vida[i] > 0)) return null;
  const passos = [];
  let acc = null, hAcc = null;
  for (let n = 0; n < pts.length; n++) {
    const i = pts[n], v = vida[i], h = horas(instantes[i]);
    if (acc == null) { acc = v; hAcc = h; continue; }
    if (v < acc) {
      // inversor TROCADO: o contador de vida cai ate o DIARIO do mesmo instante (o novo comeca os dois juntos, desde
      // zero) e cabe no teto desde o sol. Vem ANTES da volta: um inversor trocado ontem tem contador pequeno, e o novo
      // pode passar de um ponto da rampa no mesmo dia. O zero do preenchimento (os dois em 0) nao e troca.
      const d = diaria ? diaria[i] : null;
      if (v > 0 && valido(d) && Math.abs(d - v) <= ARRED && v <= tetoDesde(SOL_H, h)) {
        passos.push({ i, e: v }); acc = v; hAcc = h; continue;
      }
      let volta = false;
      for (let m = n + 1; m < pts.length; m++) if (vida[pts[m]] >= acc) { volta = true; break; }
      if (volta) continue;                                         // preenchimento: o contador volta
      acc = v; hAcc = h; continue;   // sem volta e sem ser troca (rampa ate o fundo, 0,1 kWh as 18:30): so rebaseia
    }
    const d = v - acc;
    if (d > tetoDesde(hAcc, h)) { acc = v; hAcc = h; continue; }   // salto impossivel: o aceito era preenchimento
    passos.push({ i, e: d });   // degrau ZERO entra: inversor parado com os pares gerando e informacao do detalhe
    acc = v; hAcc = h;
  }
  return passos;
}

// energia do dia (kWh). `diaria` (alinhada) reconhece a troca e cobre o inversor que entrou na coleta depois do sol.
function energiaDoDia(vida, instantes, diaria) {
  const passos = passosDoDia(vida, instantes, diaria);
  if (passos == null) return null;
  let e = 0;
  for (const p of passos) e += p.e;
  if (diaria && e > 0) {
    let i0 = -1;
    for (let i = 0; i < vida.length; i++) if (valido(vida[i])) { i0 = i; break; }
    const h0 = horas(instantes[i0]), d0 = diaria[i0];
    // 🔴 o diario do primeiro instante so e de HOJE se cabe no teto desde o sol (um diario que nao zerasse traria ontem
    //    junto) e SOBE antes da primeira queda. Parado no valor de ontem ate zerar, a subida antes da queda e zero e nada
    //    entra, por menor que seja a subida do contador de vida; de hoje, ele sobe com o sol, e um desarme depois nao
    //    apaga a manha. Cada condicao tem o seu caso no ensaio-contador-dia.
    if (valido(d0) && d0 > 0 && d0 <= tetoDesde(SOL_H, h0)) {
      let dMax = d0, ant = d0;
      for (let i = i0 + 1; i < diaria.length; i++) {
        if (!valido(diaria[i])) continue;
        if (diaria[i] < ant - ARRED) break;                      // primeira queda: zeragem ou desarme
        ant = diaria[i]; if (diaria[i] > dMax) dMax = diaria[i];
      }
      if (dMax - d0 > ARRED) e += d0;
    }
  }
  return e;
}

module.exports = { passosDoDia, energiaDoDia, CAP_KW, SOL_H, ARRED };
