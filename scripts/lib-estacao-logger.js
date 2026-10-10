'use strict';
/*
 * lib-estacao-logger.js — le os arquivos do datalogger das estacoes solarimetricas (CR1000X, formato CSIXML) e faz a
 * meia hora da irradiancia no plano (10/10/2026, PROMOVER estacao-logger).
 *
 * O QUE FOI MEDIDO ANTES DE ESCREVER (3.983 arquivos de 10 min, 24/07/2025 a 10/10/2026, nove estacoes):
 *   · o campo e `Irr_Tilted_1_Avg` (W/m2, media de 10 min) e a posicao dele e a 22a em todos os arquivos — mesmo assim e lido
 *     PELO NOME do cabecalho <fields>, nunca pela posicao;
 *   · o rotulo de cada registro e o FIM dos 10 min (00:10 cobre 00:00-00:10) e o relogio e a hora local (o pico cai entre
 *     11:00 e 12:30 em todas as estacoes);
 *   · a meia hora com rotulo no INICIO T e a media dos registros rotulados T+10, T+20 e T+30, os tres presentes (tudo-ou-nada):
 *     contra a irradiancia que o ONS publica para a usina, sem deslocamento, o erro medio e 3,6 W/m2 (RMSE 11,2); deslocada
 *     meia hora para qualquer lado passa de 170 — a regra e o rotulo estao certos;
 *   · a estacao M10 e a usina Mauriti 1; o numero DayNNN do nome antigo e contador do logger (difere entre estacoes), nunca data;
 *   · o mesmo registro aparece em mais de um arquivo (nome antigo e nome por dia): junta-se pelo instante do registro.
 */

const CAMPO = 'Irr_Tilted_1_Avg';
const RE_ARQ = /(?:^|\/)CRD_M(\d+)_Data_10m_[^/]*\.dat$/;

// numero da estacao no nome do arquivo -> usina (M10 = Mauriti 1)
function usinaDoArquivo(nome) {
  if (/\/_duplicados\//.test('/' + nome)) return null;
  const m = RE_ARQ.exec(nome);
  if (!m) return null;
  const n = +m[1];
  const u = n === 10 ? 1 : n;
  return u >= 1 && u <= 9 ? u : null;
}

// CSIXML -> [[instante 'YYYY-MM-DDTHH:MM', W/m2], ...]; lanca se o arquivo nao tem o campo (tudo-ou-nada por arquivo)
function leArquivo(txt) {
  const nomes = [];
  const reF = /<field name="([^"]+)"/g;
  let m;
  while ((m = reF.exec(txt))) nomes.push(m[1]);
  const k = nomes.indexOf(CAMPO) + 1;
  if (!k) throw new Error('arquivo sem o campo ' + CAMPO);
  const reV = new RegExp('<v' + k + '>([^<]*)</v' + k + '>');
  const out = [];
  const reR = /<r time="(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::\d\d)?"[^>]*>([\s\S]*?)<\/r>/g;
  while ((m = reR.exec(txt))) {
    const v = reV.exec(m[2]);
    if (!v || v[1] === '' || /nan|inf/i.test(v[1])) continue;
    const x = Number(v[1]);
    if (Number.isFinite(x)) out.push([m[1], x]);
  }
  return out;
}

// minutos desde a epoca de um instante local 'YYYY-MM-DDTHH:MM' (aritmetica de calendario, sem fuso)
const minutos = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +s.slice(14, 16)) / 60000;
const instante = (min) => new Date(min * 60000).toISOString().slice(0, 16);

// registros de 10 min (rotulo no FIM) -> meias horas com rotulo no INICIO: media de T+10, T+20, T+30, os tres presentes
function meiasHoras(reg) {
  const g = new Map();
  for (const [t, x] of reg) {
    const ini = minutos(t) - 10;
    const T = ini - (((ini % 30) + 30) % 30);
    const o = g.get(T) || { s: 0, n: 0, ks: new Set() };
    const pos = ini - T;   // 0, 10 ou 20
    if (!o.ks.has(pos)) { o.ks.add(pos); o.s += x; o.n++; }
    g.set(T, o);
  }
  const out = new Map();
  for (const [T, o] of g) if (o.n === 3) out.set(instante(T), o.s / 3);
  return out;
}

module.exports = { CAMPO, usinaDoArquivo, leArquivo, meiasHoras, minutos, instante };
