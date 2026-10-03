/**
 * lib-guarda-liquida.js - a guarda que decide se a energia LIQUIDADA de um dia (EneatLiquida) esta completa.
 * Uma escrita so: o gen-executivo.js decide com ela e os ensaios a julgam.
 *
 * A grandeza que separa e o RESIDUO `EneatRec - liquidada` em MWh: e o consumo auxiliar do dia, quase fixo (medido em
 * ago/26: 11,0 a 22,4 MWh em dias de 347 a 2.916 MWh). Liquidacao parcial deixa residuo de centenas ou milhares.
 *
 * REGRA (03/10/2026, depois da revisao do ensaio):
 *   teto do dia D = 3 x MEDIANA dos residuos da janela, SEM o dia D, com no minimo MIN_DIAS valores.
 * Por que mudou (antes: 3 x o MAIOR residuo do mes, com o proprio dia dentro):
 *   · o proprio dia entrava na conta: um dia 60 % liquidado tem residuo de 0,4 do contador, passava na peneira (< 0,5)
 *     e levava o teto a 1,2 do contador, aceitando-se a si mesmo. Defeito NO AR desde a criacao da guarda; o ensaio antigo
 *     calculava o teto sem o dia plantado e nunca o viu;
 *   · "3 x o maior" e uma catraca: um dia aceito perto do teto triplica o teto seguinte. A MEDIANA nao se move por um dia;
 *   · a janela era so o MES (o `way2_energia_mes.json` chega de fora, pelo Power Automate, e so tem o mes): no comeco de
 *     todo mes havia menos de 5 dias, o teto ficava nulo e a guarda voltava em silencio ao sinal. Agora os residuos dos dias
 *     ACEITOS COM TETO sao guardados (`guarda_liquida.json`) e relidos: janela de JANELA_DIAS dias.
 */
'use strict';
const JANELA_DIAS = 60;
const MIN_DIAS = 5;
const FATOR = 3;

const mediana = (a) => { const s = a.slice().sort((p, q) => p - q); if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };

/* candidatos do mes: residuo positivo e abaixo de metade do contador (dia quase nada liquidado nao entra) */
function candidatosDoMes(pares) {
  return pares.filter((q) => q.res > 0 && q.res < q.rec * 0.5);
}
/* formato do blob guardado: lista de { dia, res_mwh, rec_mwh }; outra coisa e ilegivel (quem le nao pode regravar) */
function formatoValido(guardados) {
  return Array.isArray(guardados) && guardados.every((g) => g && typeof g.dia === 'string' && typeof g.res_mwh === 'number' && typeof g.rec_mwh === 'number');
}
/* os guardados que valem: dentro da janela e FORA dos dias que o mes corrente ja traz (o do mes manda) */
function guardadosValidos(guardados, diasDoMes, hojeISO) {
  const corte = new Date(new Date(hojeISO + 'T12:00:00Z').getTime() - JANELA_DIAS * 864e5).toISOString().slice(0, 10);
  const doMes = new Set(diasDoMes);
  return (guardados || []).filter((g) => g && g.dia >= corte && g.dia <= hojeISO && !doMes.has(g.dia) && g.res_mwh > 0 && g.res_mwh < g.rec_mwh * 0.5);
}
/* o teto para JULGAR o dia `diaJulgado`: a janela inteira MENOS esse dia */
function teto(pares, guardados, hojeISO, diaJulgado) {
  const mes = candidatosDoMes(pares).filter((q) => q.dia !== diaJulgado);
  const ant = guardadosValidos(guardados, pares.map((q) => q.dia), hojeISO).filter((g) => g.dia !== diaJulgado);
  const vals = mes.map((q) => q.res).concat(ant.map((g) => g.res_mwh));
  const md = vals.length >= MIN_DIAS ? mediana(vals) : null;
  return { teto: md == null ? null : FATOR * md, mediana: md, dias: vals.length, do_mes: mes.length, guardados: ant.length };
}
/* a decisao: com teto, o residuo tem de ficar entre -1 MWh e o teto; sem teto, so o sinal (a guarda antiga, declarada) */
function aceita(liqTot, rec, t) {
  if (t != null && rec > 100) { const res = rec - liqTot; return res > -1 && res <= t; }
  return liqTot > 0;
}
/* o que se guarda para a proxima rodada: SO os dias aceitos COM teto (aceito pelo sinal ninguem julgou), somados aos
   guardados validos */
function atualiza(guardados, aceitosComTeto, hojeISO) {
  const ant = guardadosValidos(guardados, aceitosComTeto.map((a) => a.dia), hojeISO);
  return ant.concat(aceitosComTeto.map((a) => ({ dia: a.dia, res_mwh: Math.round(a.res * 100) / 100, rec_mwh: Math.round(a.rec * 100) / 100 })))
    .sort((a, b) => (a.dia < b.dia ? -1 : 1));
}
/* a decisao do gerador, inteira: cada dia com liquidada das 9 usinas e julgado contra o teto da janela SEM ele.
   `dias` = [{ dia, parcial, liq: {UFV: MWh}, rec: MWh }]. Devolve a decisao de cada dia e os aceitos COM teto (os unicos
   que vao para a janela). Os ensaios chamam ESTA funcao, entao julgam a composicao que o gerador usa. */
function julgaDias(dias, guardados, hojeISO) {
  const pares = dias.filter((x) => !x.parcial && Object.keys(x.liq || {}).length >= 9 && x.rec > 100)
    .map((x) => ({ dia: x.dia, rec: x.rec, res: x.rec - Object.values(x.liq).reduce((a, b) => a + b, 0) }));
  const decisoes = [], aceitosComTeto = [];
  dias.forEach((x) => {
    if (!x.liq) return;
    if (x.parcial) { decisoes.push({ dia: x.dia, aceito: false, motivo: 'dia em curso' }); return; }
    const us = Object.keys(x.liq);
    if (us.length < 9) { decisoes.push({ dia: x.dia, aceito: false, motivo: 'nao liquidado' }); return; }
    const tot = us.reduce((a, u) => a + x.liq[u], 0);
    const T = teto(pares, guardados, hojeISO, x.dia);
    const ok = aceita(tot, x.rec, T.teto);
    const comTeto = T.teto != null && x.rec > 100;
    decisoes.push({ dia: x.dia, aceito: ok, tot, rec: x.rec, teto: T.teto, janela: T.dias, so_sinal: !comTeto,
      motivo: ok ? (comTeto ? 'residuo dentro do teto' : 'so pelo sinal') : (comTeto ? 'liquidacao incompleta' : 'nao liquidado') });
    if (ok && comTeto) aceitosComTeto.push({ dia: x.dia, res: x.rec - tot, rec: x.rec });
  });
  return { decisoes, aceitosComTeto };
}
module.exports = { JANELA_DIAS, MIN_DIAS, FATOR, mediana, candidatosDoMes, formatoValido, guardadosValidos, teto, aceita, atualiza, julgaDias };
