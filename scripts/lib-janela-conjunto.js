'use strict';
/*
 * lib-janela-conjunto.js — a janela comum entre os dois arquivos do operador, e o dia completo sem limitação (PROMOVER janela-restricao).
 *
 * 🔴 O DIA QUE SÓ O ARQUIVO POR USINA CONHECE NÃO ENTRA NA APURAÇÃO (decisão do humano, 26/10/2026). O operador publica dois arquivos
 *    em horas diferentes: o por usina (`ons_irradiancia_AAAA_MM.json`: ge, gv, irr; várias vezes por dia) e o do conjunto
 *    (`ons_restricao_all.json`: ger, gref, lim, razao; consolidado uma vez por dia, ~18:17Z). A LIMITAÇÃO só existe no do conjunto
 *    (`LIM_TS` no gen-executivo). Em 26/10/2026 o executivo das 16:46Z leu o dia 25 no por usina (ref 2.960,24 · ger 1.960,30) sem o dia
 *    existir no do conjunto: sem nenhuma meia hora em `LIM_TS`, o dia inteiro entrou como LIVRE (o corte de out/26 caiu de 27,36 para
 *    26,21 %, apareceram 734,75 MWh de "outras perdas" e o desempenho livre caiu para 94,70 %). O `ref-retem-dia` não pegou: ele compara o
 *    dia com o conjunto, e o dia nem existia no conjunto. Às 19:50Z, com o conjunto gravado, o mês voltou a 27,61 % e o dia 25 saiu com
 *    981,60 MWh cortados.
 *    A regra: o detalhe por usina só vale até o ÚLTIMO instante do arquivo do conjunto. O que passa dele fica fora de tudo o que o
 *    executivo apura com o detalhe (potencial, corte, outras, desempenho livre, ref_dia_ufv, corte por usina) e sai em
 *    `dias_sem_conjunto`, com o `desde` carregado da publicação anterior e o motivo. Volta sozinho na rodada em que o conjunto chega.
 *    A entrega medida (Way2) não muda: ela não vem do operador.
 *
 * 🔔 O DIA COMPLETO SEM NENHUMA LIMITAÇÃO É AVISADO (pedido do humano, 26/10/2026): segundo ele, em fim de semana e feriado sempre há
 *    restrição; em dia útil, acontece pontualmente. Medido no ons_restricao_all de jan/26 a 25/10/2026: 22 dias completos sem nenhuma
 *    limitação, um só em fim de semana (sábado 13/06/2026). Dia completo = as 48 meias horas no arquivo do conjunto. O aviso é do dia do
 *    evento em diante (`desde`), um por dia.
 *    Feriados com fonte nomeada (os nacionais, mais Carnaval e Corpus Christi como ponto facultativo federal; o humano não pediu os
 *    estaduais do CE):
 *      Lei 662/1949, na redação da Lei 10.607/2002: 01/01, 21/04, 01/05, 07/09, 02/11, 15/11, 25/12;
 *      Lei 6.802/1980: 12/10;
 *      Lei 14.759/2023: 20/11;
 *      ponto facultativo federal (portaria anual do Ministério da Gestão): segunda e terça de Carnaval, Corpus Christi.
 */

const MOTIVO_SEM_CONJUNTO = 'conjunto ainda nao publicado';

/** o último instante do arquivo do conjunto ('AAAA-MM-DD HH:MM:SS', o mesmo formato do por usina); '' sem linha */
function janelaComum(conjunto) {
  let max = '';
  for (const r of conjunto || []) { const t = String(r && r.ts || ''); if (/^\d{4}-\d{2}-\d{2}/.test(t) && t > max) max = t; }
  return max;
}

/** separa as linhas do detalhe por usina: dentro da janela comum, e as de fora contadas por dia */
function cortaJanela(linhas, tsMax) {
  const dentro = [], fora = new Map();
  for (const r of linhas || []) {
    const t = String(r && r.ts || '');
    if (tsMax && t > tsMax) { const d = t.slice(0, 10); fora.set(d, (fora.get(d) || 0) + 1); }
    else dentro.push(r);
  }
  return { dentro, fora };
}

/** o cortador do gerador (revisor-ensaio RE-002): corta cada leitura do detalhe e acumula os dias de fora (a mesma linha lida duas
 *  vezes, no topo e no laço do CRU, conta uma vez: o maior número de linhas por dia) */
function cortador(tsMax) {
  const fora = new Map();
  return { tsMax, fora, corta(linhas) { const c = cortaJanela(linhas, tsMax); c.fora.forEach((n, d) => fora.set(d, Math.max(fora.get(d) || 0, n))); return c.dentro; } };
}

/** o `desde` de cada dia na publicação anterior (revisor-ensaio RE-003): {} quando ela não tem a lista */
function desdeAnterior(publicado) {
  const o = {};
  ((publicado && publicado.dias_sem_conjunto) || []).forEach((x) => { if (x && x.dia && x.desde) o[x.dia] = x.desde; });
  return o;
}

/** a lista publicada: um item por dia fora da janela, com o `desde` da publicação anterior (ou o agora) */
function diasSemConjunto(fora, desdeAntes, agoraIso, tsMax) {
  return [...fora.keys()].sort().map((dia) => ({ dia, desde: (desdeAntes && desdeAntes[dia]) || agoraIso, motivo: MOTIVO_SEM_CONJUNTO,
    linhas_por_usina: fora.get(dia), conjunto_ate: tsMax || null }));
}

/* ── o calendário ─────────────────────────────────────────────────────────────────────────────────────────────────────── */
/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher, calendário gregoriano), em 'AAAA-MM-DD' */
function pascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
    l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mes = Math.floor((h + l - 7 * m + 114) / 31),
    dia = ((h + l - 7 * m + 114) % 31) + 1;
  return ano + '-' + String(mes).padStart(2, '0') + '-' + String(dia).padStart(2, '0');
}
const somaDias = (iso, n) => { const t = Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) + n * 864e5; return new Date(t).toISOString().slice(0, 10); };

/** os feriados do ano: { 'AAAA-MM-DD': 'nome · fonte' } */
function feriados(ano) {
  const F = {}, p = (md, n) => { F[ano + '-' + md] = n; };
  p('01-01', 'Confraternização Universal · Lei 662/1949'); p('04-21', 'Tiradentes · Lei 662/1949'); p('05-01', 'Dia do Trabalho · Lei 662/1949');
  p('09-07', 'Independência · Lei 662/1949'); p('10-12', 'Nossa Senhora Aparecida · Lei 6.802/1980'); p('11-02', 'Finados · Lei 662/1949');
  p('11-15', 'Proclamação da República · Lei 662/1949'); p('11-20', 'Dia Nacional de Zumbi e da Consciência Negra · Lei 14.759/2023');
  p('12-25', 'Natal · Lei 662/1949');
  const P = pascoa(ano);
  F[somaDias(P, -48)] = 'Carnaval (segunda) · ponto facultativo federal'; F[somaDias(P, -47)] = 'Carnaval (terça) · ponto facultativo federal';
  F[somaDias(P, 60)] = 'Corpus Christi · ponto facultativo federal';
  return F;
}

/** o tipo do dia: 'feriado' (com o nome), 'fim_de_semana' ou 'util' */
function tipoDoDia(dia) {
  const F = feriados(+dia.slice(0, 4));
  if (F[dia]) return { tipo: 'feriado', nome: F[dia] };
  const sem = new Date(Date.UTC(+dia.slice(0, 4), +dia.slice(5, 7) - 1, +dia.slice(8, 10))).getUTCDay();
  return sem === 0 || sem === 6 ? { tipo: 'fim_de_semana', nome: sem === 0 ? 'domingo' : 'sábado' } : { tipo: 'util', nome: 'dia útil' };
}

/** os dias COMPLETOS do arquivo do conjunto (as 48 meias horas) sem nenhuma meia hora com limitação, a partir de `desde` */
function diasSemRestricao(conjunto, opts) {
  const desde = (opts && opts.desde) || '', D = new Map();
  for (const r of conjunto || []) {
    const t = String(r && r.ts || ''), dia = t.slice(0, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(dia) || (desde && dia < desde)) continue;
    const o = D.get(dia) || { ts: new Set(), lim: 0 };
    o.ts.add(t.slice(11, 16)); if (Number(r.lim) > 0) o.lim++;
    D.set(dia, o);
  }
  return [...D.entries()].filter(([, o]) => o.ts.size === 48 && o.lim === 0).map(([dia]) => Object.assign({ dia }, tipoDoDia(dia)))
    .sort((a, b) => (a.dia < b.dia ? -1 : 1));
}

/** o aviso de um dia, no formato da lib-alerta (o título fixo por dia faz o dedup pela issue aberta) */
function avisoDoDia(x) {
  const raro = x.tipo !== 'util', dataBR = x.dia.slice(8, 10) + '/' + x.dia.slice(5, 7) + '/' + x.dia.slice(0, 4);
  const quando = x.tipo === 'feriado' ? 'feriado (' + x.nome + ')' : x.tipo === 'fim_de_semana' ? x.nome : 'dia útil';
  return { tipo: 'dia-sem-restricao', chave: 'dia-sem-restricao-' + x.dia, soSeNova: true,
    titulo: 'Dia completo sem restrição do operador · ' + dataBR,
    assunto: (raro ? '⚠️ ' : 'ℹ️ ') + 'Mauriti · ' + dataBR + ' sem nenhuma restrição do operador (' + quando + ')',
    corpo: '<b>O arquivo de restrição do conjunto trouxe ' + dataBR + ' completo (48 meias horas) sem nenhum intervalo com limitação.</b><br><br>'
      + 'Tipo do dia: <b>' + quando + '</b>.<br>'
      + (raro ? '<b>Incomum: em fim de semana e feriado costuma haver restrição. Conferir com a mesa e com o ONS.</b>'
        : 'Em dia útil isso acontece de forma pontual. Conferir.') + '<br><br>'
      + '<i>(Alerta automático · executivo Mauriti · regra janela-restricao)</i>' };
}

module.exports = { MOTIVO_SEM_CONJUNTO, janelaComum, cortaJanela, cortador, desdeAnterior, diasSemConjunto, pascoa, feriados, tipoDoDia, diasSemRestricao, avisoDoDia };
