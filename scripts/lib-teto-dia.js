// lib-teto-dia.js — a guarda do DIA EM CURSO no executivo.json (PROMOVER executivo-teto-fisico).
//
// 🔴 POR QUE MUDOU. A guarda antiga comparava o dia em curso com o maior dia JA REGISTRADO NO MES x 1,25. No inicio de um mes
// com dias cortados ela trava um dia de sol: em 05/10/2026 outubro so tinha 01-04 (2.456,66 / 1.478,56 / 759,49 / 828,02 MWh,
// todos com restricao), o teto deu 3.071 MWh e o dia, 3.153,88 MWh as 18:10, foi recusado a cada 5 min desde as 16:45 — e os
// passos seguintes do job (perdas, resumo do assistente, watchdog de frescor, ensaios de produto) deixaram de rodar.
//
// O TETO AGORA E FISICO: nenhuma energia do dia passa de 343,77 MW (a outorga) x as horas desde as 05:00 ate o ultimo instante
// lido. Medido nos 618 dias do historico do Ao vivo (hist/portal_vivo_DIA.json, 25/01/2025 a 04/10/2026): a primeira geracao
// acima de 1 MW nunca veio antes das 05:10, e a energia acumulada nunca passou de 78,9 % desse teto em instante nenhum (o
// maximo, 09/09/2026 e 22/09/2026). O que a guarda existe para pegar continua pego: unidade errada (kWh por MWh, x 1000) sempre,
// e o dia contado em dobro sempre que a razao real passa de 50 % (da metade da manha em diante, num dia de sol).
//
// 🔴 O "DIA NUNCA ENCOLHE" COMPARA O MESMO TRECHO (PROMOVER dia-noite-encolhe). A energia LIQUIDA nao so cresce: depois do
// pico (~17:30) o trafo consome e ela cai ate a meia-noite, 6,6 / 7,6 / 7,1 MWh em 07, 08 e 09/10/2026 (6196+6197 do
// snapshot de cada dia). A regra antiga (`novo < antes - 1`) seguia a queda enquanto o remendo rodava a cada 5 min (~0,1
// MWh por passo); depois de qualquer pausa maior que ~1 h ela recusava todo o resto do dia, porque `antes` nao andava mais.
// Em 08/10 o TR2 atrasou no snapshot (19:35 a 21:30, guarda de cobertura), o remendo parou em 19:20 (1.992,81 MWh) e dali
// ate 23:55 cada rodada disse "ENCOLHEU (1992.81 -> 1987.27)"; o dia inteiro foi 1.987,00.
//
// O publicado e a soma dos trafos ate o ultimo instante DELES (o CORTE), e o `ate` e o ultimo instante do 6233. Em 56 rodadas
// de 07 a 09/10/2026 (log "Complexo X -> Y" contra o snapshot final de cada dia) o publicado foi o snapshot final cortado 10 min
// antes do `ate` em 54 e no proprio `ate` em 2, com diferenca de no maximo 0,005 MWh: os trafos chegam ~10 min atras do 6233, e
// a Way2 nao revisou o passado. Por isso o remendo GRAVA o corte na linha (`liq_corte`, HH:MM) e a rodada seguinte rele o
// snapshot novo EXATAMENTE ate ele: qualquer defasagem passa (revisor RE-104, decidido com o humano em 10/10/2026). Linha sem
// `liq_corte` (escrita pela rodada completa do executivo, que nao o grava) cai na JANELA: o maior acumulado entre `ate` - 10 e
// `ate` + 10 min (de dia esta no fim da janela, de noite no comeco), que tolera defasagem de -15 a +10 min.
//
// Os numeros, todos MEDIDOS:
//  - DEFASAGEM_MIN = 10: a defasagem acima, so para a janela.
//  - CONSUMO_MAX_MW = 2,494. O maior consumo do complexo (6196+6197 negativo) num instante de 5 min em 400 dias de
//    hist/portal_eletrico_DIA.json (05/09/2025 a 09/10/2026): 27/03/2026 18:00. A mediana do pior instante de cada dia e 1,07.
//  - FOLGA_MWH = uma amostra de 5 min desse consumo (0,21 MWh): o que um trafo um instante a frente do outro (a guarda de
//    cobertura deixa 1) muda na soma relida, de noite.
// E tres recusas: o relido abaixo do publicado menos a folga (leitura torta: o passado perdeu energia); o valor novo abaixo
// do relido menos o consumo maximo no tempo ate o corte novo (cauda torta: sinal, escala, pico espurio); e o corte novo ANTES
// do gravado (snapshot que recuou: de noite ele subiria pelo consumo que deixou de contar, e o `ate` andaria para tras — a
// camada horaria do mesmo remendo ja recusa "RECUOU"). Linha publicada sem `ate` nem `liq_corte`: a regra antiga.

'use strict';
const OUTORGA = 343.77;      // MW
const INICIO_MIN = 5 * 60;   // 05:00: antes disso nao ha geracao (medido: a primeira, 05:10)
const DEFASAGEM_MIN = 10;    // o corte dos trafos no publicado, contra o `ate` do 6233 (medido, ver acima)
const CONSUMO_MAX_MW = 2.494;                      // o maior consumo do complexo num instante (medido, ver acima)
const FOLGA_MWH = CONSUMO_MAX_MW * 5 / 60;         // uma amostra de 5 min desse consumo

const minutos = (ate) => (ate === '00:00' || ate === '24:00') ? 1440 : (+String(ate).slice(0, 2)) * 60 + (+String(ate).slice(3, 5));
const hhmm = (m) => (m >= 1440 ? '00:00' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));

// MWh: o maximo que o complexo pode ter gerado do inicio do dia ate `ate` (HH:MM)
function tetoDia(ate) { return OUTORGA * Math.max(0, minutos(ate) - INICIO_MIN) / 60; }

// MWh: a energia acumulada do dia `dia` ate `ate` (HH:MM, inclusive; '00:00' e '24:00' = fim do dia), somando series de
// 5 min em kW ([{data, valor}], rotulo na borda DIREITA da Way2: o dia vai de 00:05 a 00:00 do dia seguinte). E a MESMA
// conta do `rollupDia` (soma tudo, inclusive o negativo, x 5/60/1000), cortada no instante.
function acumuladoAte(series, dia, ate) {
  const ini = dia + 'T00:00';
  const fim = (ate === '00:00' || ate === '24:00')
    ? new Date(Date.parse(dia + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) + 'T00:00'
    : dia + 'T' + ate;
  let s = 0;
  series.forEach((vs) => (vs || []).forEach((v) => {
    const t = String(v.data).slice(0, 16);
    if (v.valor != null && t > ini && t <= fim) s += v.valor;
  }));
  return s * 5 / 60 / 1000;
}

// O CORTE de uma leitura: o ultimo instante do dia (HH:MM; '00:00' = 24:00) com valor em alguma das series — ate onde a soma
// dos trafos (o `rollupDia`, o `acumuladoAte`) chega. null se nenhuma tem valor no dia.
function corteTrafos(series, dia) {
  const ini = dia + 'T00:00';
  const fim = new Date(Date.parse(dia + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10) + 'T00:00';
  let c = null;
  series.forEach((vs) => (vs || []).forEach((v) => {
    const t = String(v.data).slice(0, 16);
    if (v.valor != null && t > ini && t <= fim && (c == null || t > c)) c = t;
  }));
  return c == null ? null : c.slice(11, 16);
}

// O snapshot NOVO relido no trecho que estava publicado: { mwh, em, exato }.
//  - com `antesCorte` (a linha gravada pelo remendo): o acumulado EXATO ate ele;
//  - sem ele: o maior acumulado entre `antesAte` - 10 min e `antesAte` + 10 min, e o instante dele;
//  - sem os dois: null (a guarda cai na regra antiga).
function relidoDoPublicado(series, dia, antesAte, antesCorte) {
  if (/^\d\d:\d\d$/.test(String(antesCorte || ''))) return { mwh: acumuladoAte(series, dia, antesCorte), em: antesCorte, exato: true };
  if (!/^\d\d:\d\d$/.test(String(antesAte || ''))) return null;
  const c = minutos(antesAte);
  let r = null;
  for (let m = Math.max(5, c - DEFASAGEM_MIN); m <= Math.min(1440, c + DEFASAGEM_MIN); m += 5) {
    const v = acumuladoAte(series, dia, hhmm(m));
    if (!r || v > r.mwh) r = { mwh: v, em: hhmm(m), exato: false };
  }
  return r;
}

// null = pode gravar; texto = o motivo para nao gravar.
// `relido`: o `relidoDoPublicado` do snapshot novo. Sem ele, a regra antiga (`novo < antes - 1`).
// `corteNovo`: o `corteTrafos` do snapshot novo (ate onde `novo` soma); sem ele, a cauda vai ate `ate` + 10 min.
function guardaDia(novo, antes, ate, relido, corteNovo) {
  if (!/^\d\d:\d\d$/.test(String(ate || ''))) return 'dia em curso sem o instante lido (' + ate + ')';
  const t = tetoDia(ate);
  if (novo > t) return 'dia em curso ' + novo + ' MWh acima do teto fisico ' + t.toFixed(2) + ' MWh (343,77 MW x horas desde 05:00, ate ' + ate + ')';
  if (antes == null) return null;
  if (!relido) return novo < antes - 1 ? 'dia em curso ENCOLHEU (' + antes + ' -> ' + novo + ')' : null;
  if (relido.exato && /^\d\d:\d\d$/.test(String(corteNovo || '')) && minutos(corteNovo) < minutos(relido.em)) {
    return 'dia em curso RECUOU (corte gravado ' + relido.em + ', snapshot novo so ate ' + corteNovo + ')';
  }
  if (relido.mwh < antes - FOLGA_MWH) {
    return 'dia em curso ENCOLHEU no trecho ja publicado (publicado ' + antes + ', relido ' + relido.mwh.toFixed(2) + ' ate ' + relido.em + ')';
  }
  // a cauda: do instante relido ao corte novo, no maximo o consumo maximo
  const fimCauda = /^\d\d:\d\d$/.test(String(corteNovo || '')) ? minutos(corteNovo) : minutos(ate) + DEFASAGEM_MIN;
  const horas = Math.max(0, fimCauda - minutos(relido.em)) / 60;
  const piso = relido.mwh - FOLGA_MWH - CONSUMO_MAX_MW * horas;
  if (novo < piso) {
    return 'dia em curso caiu mais que o consumo maximo (' + relido.mwh.toFixed(2) + ' ate ' + relido.em + ' -> ' + novo + ' ate ' + (corteNovo || ate)
      + ', piso ' + piso.toFixed(2) + ': 2,494 MW x ' + horas.toFixed(2) + ' h)';
  }
  return null;
}

module.exports = { tetoDia, acumuladoAte, corteTrafos, relidoDoPublicado, guardaDia, OUTORGA, INICIO_MIN, DEFASAGEM_MIN, CONSUMO_MAX_MW, FOLGA_MWH };
