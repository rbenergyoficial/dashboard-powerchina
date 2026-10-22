'use strict';
/*
 * alerta-must.js — e-mail de ultrapassagem do MUST no quarto de hora (PROMOVER pa-alerta).
 *
 * Substitui o e-mail "ALERTA MUST — Ultrapassagem de Demanda Contratada" do fluxo "Way2 MUST Intradia" do Power
 * Automate, que sai com o Premium em 09/11/2026 (decisao D2 do humano, 18/10/2026: "troca pelo quarto de hora").
 *
 * 🔴 O FLUXO NUNCA AVISOU. Medido em 18/10/2026 nas 300 ultimas execucoes (15/10 a 18/10): o passo do e-mail foi
 *    PULADO em todas. O filtro dele compara o rotulo da medicao, em hora local sem fuso, com `utcNow() - 30 min`:
 *    o rotulo fica 3 h atras e nunca entra na janela. E nos 91 dias do must_15min.json nao houve quarto de hora acima
 *    de 100% do contratado em parque nenhum. Ou seja: nada se perdeu ate hoje, e o substituto e o primeiro que avisa.
 *
 * O QUE CONTA: um intervalo de 15 min (a integralizacao contratual, a mesma que o ONS afere) em que a demanda de
 * GERACAO de um parque passa de 100% do MUST contratado daquele ponto no contrato de uso do sistema de transmissao.
 * Estritamente acima: igual ao contratado nao e ultrapassagem. O limiar vem do proprio blob (`contratos`), escrito
 * pelo gen-must-intra; o Complexo e soma, nao tem contrato proprio, e fica fora (o fluxo tambem so via ponto).
 *
 * O DIA e o do inicio do intervalo em BRT: o rotulo e o FIM do intervalo, e o balde das 00:00 pertence ao dia
 * anterior (a mesma convencao do gen-must-intra).
 *
 * 🔴 SO SE JULGA LEITURA ASSENTADA (must-provisorio, 22/10/2026). Os tres primeiros avisos (M2, M6 e M7, 22/10 12:30 BRT)
 *    eram FALSOS: a Way2 entrega os ultimos intervalos do dia como valor provisorio, com o total do conjunto certo e a divisao
 *    por usina embaralhada (o M6 com 67,44 MW no quarto de hora, 137 %), e revisou tudo 15 min depois (M6 40,7 MW, 82,9 %).
 *    Em 90 dias (8.541 quartos de hora) nenhum quarto de hora completo passou de 100 %; os 4 "acima" eram os dois incompletos
 *    de 22/10. Por isso uma linha so e julgada quando:
 *    - o quarto de hora fechou ha pelo menos MADURO_MIN do `gerado_em` (a hora da leitura na fonte, nao a do alerta) E os
 *      quartos de hora seguintes ate MADURO_MIN depois dele ja chegaram com valor (os dois seguintes). Medido em 22/10: na
 *      leitura das 12:30 BRT o provisorio ia ate 12:20 (10 a 25 min de idade); na das 12:45 o que tinha 25 min ou mais ja
 *      estava revisado. 30 min e o primeiro multiplo de 15 que cobre isso, com uma medicao so. Os seguintes, e nao so o
 *      gerado_em, porque o provisorio e "o fim do que chegou": o gerador nao rele ontem depois da meia-noite (o fim de ontem
 *      pode ter ficado congelado no provisorio) e a Way2 pode entregar com horas de atraso (a ultima linha longe do gerado_em).
 *      A regra e por linha, e nao pelo ultimo quarto de hora de cada dia, para nao deixar de julgar o 23:45 e o 00:00.
 *      ⚠️ Medido em 22/10 nos 90 dias do blob: o balde das 00:00 nunca chega (o gerador so rele o dia corrente, e a ultima
 *      rodada antes da virada ainda nao o tem), entao o 23:30 e o 23:45 de cada dia ficam sem os seguintes e nao sao julgados.
 *      E noite, com geracao zero; o defeito e do gerador e esta registrado no livro (must-provisorio);
 *    - as 9 usinas tem valor (o provisorio de 22/10 veio sem o M9). Linha assentada sem todas fica de fora, e a rodada anota
 *      ::warning:: com o dia, a contagem e as usinas que faltam: nesses quartos de hora uma ultrapassagem das outras usinas NAO
 *      e avisada por e-mail. Decisao do lote: o provisorio de 22/10 so se distinguiu do medido pela usina faltando, e em 90 dias
 *      nenhum quarto de hora passou de 100 % (o PPC segura em 99,5 %); o medidor fora e avisado pelo vigia da Way2;
 *    - nenhuma usina passa do TETO FISICO: inversores x 352 kW (SG350HX, potencia CA maxima; inversores da lib-placa). Valor
 *      acima do que a usina consegue entregar e leitura errada, nao ultrapassagem: a linha inteira sai (o embaralhamento
 *      infla uma usina e murcha outra) e vira ::warning::, sem e-mail.
 *    O aviso de uma ultrapassagem de verdade chega 30 a 45 min depois do quarto de hora, em vez de 15 a 30.
 *
 * DEDUP: um evento por parque por dia (`chave`), com `soSeNova` — a issue aberta e a memoria. Intervalos novos do
 * mesmo parque no mesmo dia, depois do primeiro aviso, nao geram outro e-mail. Janela: hoje e ontem (o dado de
 * ontem ainda pode chegar atrasado).
 *
 * 🔴 CANAL AUSENTE E DEFEITO: falta qualquer peca do e-mail (MAIL_PARA, MAIL_DE, AZ_MAIL_*) ou o GITHUB_TOKEN da
 *    memoria do dedup -> exit 1 antes de julgar. O destinatario e o mesmo do fluxo, e vem da variavel `MAIL_PARA_MUST`
 *    do repositorio (nunca escrito aqui: o repo e publico). Depois de julgar, cada evento tem de ter sido ENVIADO ou
 *    ja estar aberto (dedup); e-mail '-' ou FALHOU, ou issue FALHOU (sem memoria o aviso se repetiria a cada 15 min),
 *    derrubam a rodada.
 * 🔴 VACUIDADE E DEFEITO: parque M1..M9 sem contrato > 0 ou sem placa, `gerado_em` ilegivel, janela de hoje e ontem sem
 *    nenhuma linha julgada (gerador parado, ou o dia inteiro sem as 9 usinas), ou `ms` que nao bate com o `t` da linha
 *    (convencao do gerador mudou) -> exit 1. "0 eventos" so vale com intervalos julgados.
 *
 * Env: MUST_ARQ (arquivo local, para o ensaio) · BLOB_BASE · MAIL_* e AZ_MAIL_* (lib-alerta) · AGORA_MS (ensaio)
 */
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const { PLACA } = require('./lib-placa');
const zlib = require('zlib');
const fs = require('fs');

const BASE = process.env.BLOB_BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const PASSO_MIN = 15;
const MADURO_MIN = 30;
const KW_MAX_INV = 352;   // SG350HX: potencia CA maxima, 110 % dos 320 kW nominais
const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const PECAS = ['MAIL_PARA', 'MAIL_DE', 'AZ_MAIL_TENANT_ID', 'AZ_MAIL_CLIENT_ID'];
const BRT_MS = 3 * 3600 * 1000;

const diaBRT = (ms) => new Date(ms - BRT_MS).toISOString().slice(0, 10);
const dm = (d) => d.slice(8, 10) + '/' + d.slice(5, 7);
const hora = (t) => String(t).slice(11, 16);
const num = (v, c) => v.toFixed(c).replace('.', ',');

const valido = (v) => typeof v === 'number' && isFinite(v);
/** o maximo que a usina consegue entregar, em MW: inversores x 352 kW */
const tetoFisico = (p) => PLACA[p].inversores * KW_MAX_INV / 1000;

/** Confere a forma do blob: os 9 parques com contrato e placa, o `gerado_em` legivel e o `ms` igual ao `t` de cada linha.
 *  Estoura no primeiro erro. */
function confere(j) {
  const C = j.contratos || {};
  const sem = PARQUES.filter((p) => !(C[p] > 0) || !(j.parques || []).includes(p));
  if (sem.length) throw new Error('must_15min.json sem contrato ou sem coluna para ' + sem.join(', '));
  const semPlaca = PARQUES.filter((p) => !(PLACA[p] && PLACA[p].inversores > 0));
  if (semPlaca.length) throw new Error('lib-placa sem inversores para ' + semPlaca.join(', '));
  if (!isFinite(Date.parse(j.gerado_em))) throw new Error('must_15min.json com gerado_em ilegivel: ' + j.gerado_em);
  for (const l of j.serie || []) {
    if (Date.parse(l.t) !== l.ms) throw new Error('must_15min.json: ms ' + l.ms + ' nao bate com t ' + l.t + ' (convencao do gerador mudou?)');
  }
}

/** Agrupa por dia (BRT, inicio do intervalo) e parque os intervalos acima do contratado, nos dias pedidos, so nas linhas
 *  assentadas (ver o cabecalho). `julgados` conta as linhas julgadas: zero quer dizer que nada foi olhado. As linhas da janela
 *  que ficaram de fora saem contadas: `recentes` (fecharam ha menos de MADURO_MIN do gerado_em, ou sem os quartos de hora
 *  seguintes entregues), `incompletas` (sem as 9
 *  usinas; `faltas` diz, por dia, quantas e quais usinas faltaram) e `implausiveis` (alguma usina acima do teto fisico; a lista
 *  traz linha, usina, valor e teto). */
function ultrapassagens(j, dias) {
  const C = j.contratos || {};
  const parques = PARQUES.filter((p) => C[p] > 0);
  const limite = Date.parse(j.gerado_em) - MADURO_MIN * 60000;
  /* os instantes que chegaram com valor de alguma usina: o quarto de hora so assenta com os seguintes entregues */
  const comValor = new Set((j.serie || []).filter((l) => PARQUES.some((p) => valido(l[p]))).map((l) => l.ms));
  const seguintes = (ms) => { for (let m = PASSO_MIN; m <= MADURO_MIN; m += PASSO_MIN) if (!comValor.has(ms + m * 60000)) return false; return true; };
  const ev = new Map();
  let julgados = 0, recentes = 0, incompletas = 0;
  const implausiveis = [], faltas = {};
  for (const l of j.serie || []) {
    const dia = diaBRT(l.ms - PASSO_MIN * 60000);
    if (!dias.includes(dia)) continue;
    if (!(l.ms <= limite) || !seguintes(l.ms)) { recentes++; continue; }
    const faltam = PARQUES.filter((p) => !valido(l[p]));
    if (faltam.length) {
      incompletas++;
      const f = faltas[dia] || (faltas[dia] = { n: 0, parques: [] });
      f.n++; faltam.forEach((p) => { if (!f.parques.includes(p)) f.parques.push(p); });
      continue;
    }
    const fora = PARQUES.filter((p) => l[p] > tetoFisico(p));
    if (fora.length) { fora.forEach((p) => implausiveis.push({ t: l.t, parque: p, valor: l[p], teto: tetoFisico(p) })); continue; }
    julgados++;
    for (const p of parques) {
      const v = l[p];
      if (!(v > C[p])) continue;
      const k = dia + '|' + p;
      const e = ev.get(k) || { dia, parque: p, contrato: C[p], n: 0, pico: -Infinity, t_pico: null, t_primeiro: l.t };
      e.n++;
      if (v > e.pico) { e.pico = v; e.t_pico = l.t; }
      ev.set(k, e);
    }
  }
  const lista = [...ev.values()].sort((a, b) => (a.dia + a.parque).localeCompare(b.dia + b.parque));
  Object.keys(faltas).forEach((d) => faltas[d].parques.sort());
  Object.assign(lista, { julgados, recentes, incompletas, implausiveis, faltas });
  return lista;
}

function acaoDe(e) {
  const pct = 100 * e.pico / e.contrato;
  return {
    tipo: 'must-ultrapassagem',
    chave: 'must-ultrapassagem-' + e.dia + '-' + e.parque,
    titulo: 'MUST: ' + e.parque + ' acima do contratado em ' + dm(e.dia),
    assunto: '⚠️ MUST · ' + e.parque + ' acima do contratado em ' + dm(e.dia),
    soSeNova: true,
    corpo: '<p><b>' + e.parque + '</b> passou do MUST contratado (' + num(e.contrato, 2) + ' MW) em <b>' + dm(e.dia)
      + '</b>: ' + e.n + (e.n === 1 ? ' intervalo' : ' intervalos') + ' de 15 min acima de 100%, o primeiro terminado às '
      + hora(e.t_primeiro) + '.</p><p>Pico: <b>' + num(e.pico, 3) + ' MW</b> (' + num(pct, 1) + '% do contratado), no '
      + 'intervalo terminado às ' + hora(e.t_pico) + '.</p><p>Limiar: 100% do MUST do contrato de uso do sistema de '
      + 'transmissão, apurado na integralização de 15 min. Demanda de geração no ponto de conexão, medição de '
      + 'faturamento. Novos intervalos do mesmo parque no mesmo dia não geram outro aviso.</p>',
  };
}

// Fase 2: o transporte e o da lib-le-dados. Como antes, nada aqui e "nao existe": o 404 tambem estoura (o alerta nao roda sem o
// must_15min.json), e o erro da lib (403, 409, 5xx, rede, timeout) sai com o nome do blob.
async function baixa(nome) {
  let r;
  try { r = await LD.pede(BASE + nome, { 'Accept-Encoding': 'gzip' }); } catch (e) { throw new Error(nome + ': ' + e.message); }
  if (r.status !== 200) throw new Error(nome + ': HTTP ' + r.status);
  let x = r.buf;
  if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
  return JSON.parse(x.toString('utf8'));
}

async function main({ alerta = require('./lib-alerta').alerta, agora = Number(process.env.AGORA_MS) || Date.now() } = {}) {
  const faltam = PECAS.filter((k) => !(process.env[k] || '').trim());
  if (!(process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '').trim()) faltam.push('GITHUB_TOKEN');
  if (faltam.length) {
    console.error('::error::alerta-must: sem ' + faltam.join(', ') + ' (o destinatario e a variavel MAIL_PARA_MUST do repositorio) — o aviso nao teria por onde ir');
    return 1;
  }
  const j = process.env.MUST_ARQ ? JSON.parse(fs.readFileSync(process.env.MUST_ARQ, 'utf8')) : await baixa('must_15min.json');
  if (j.resolucao_min !== PASSO_MIN) throw new Error('must_15min.json com resolucao ' + j.resolucao_min + ' min, esperado ' + PASSO_MIN);
  const dias = [diaBRT(agora), diaBRT(agora - 86400000)];
  confere(j);
  const ev = ultrapassagens(j, dias);
  console.log('alerta-must: ' + ev.length + ' evento(s) em ' + dias.join(' e ') + ' · ' + ev.julgados + ' intervalos julgados de '
    + (j.serie || []).length + ' linhas, gravado ' + j.gerado_em + ' · fora do julgamento: ' + ev.recentes + ' recentes, '
    + ev.incompletas + ' sem as 9 usinas, ' + ev.implausiveis.length + ' valor(es) acima do teto fisico');
  for (const [d, f] of Object.entries(ev.faltas)) {
    console.error('::warning::alerta-must: ' + f.n + ' quarto(s) de hora assentado(s) de ' + dm(d) + ' sem ' + f.parques.join(', ')
      + ' ficaram fora do julgamento — ultrapassagem das outras usinas nesses intervalos nao e avisada');
  }
  for (const x of ev.implausiveis) {
    console.error('::warning::alerta-must: ' + x.parque + ' com ' + num(x.valor, 2) + ' MW no quarto de hora terminado em ' + x.t
      + ', acima do teto fisico de ' + num(x.teto, 2) + ' MW — leitura errada da fonte, linha fora do julgamento');
  }
  if (!ev.julgados) {
    console.error('::error::alerta-must: nenhum intervalo julgado em ' + dias.join(' ou ') + ' (' + ev.recentes + ' recentes, '
      + ev.incompletas + ' sem as 9 usinas, ' + ev.implausiveis.length + ' acima do teto) — gerador parado ou medidor fora?');
    return 1;
  }
  let falhou = 0;
  for (const e of ev) {
    const out = await alerta(acaoDe(e));
    const chegou = /^enviado/.test(out.email || '') || /^ja aberta #\d/.test(out.issue || '');
    if (!chegou || /^FALHOU/.test(out.issue || '')) { falhou++; console.error('::error::alerta-must: ' + e.parque + ' ' + e.dia + ' · email: ' + out.email + ' · issue: ' + out.issue); }
  }
  return falhou ? 1 : 0;
}

module.exports = { ultrapassagens, acaoDe, diaBRT, confere, main, tetoFisico, MADURO_MIN };

if (require.main === module) main().then((c) => process.exit(c)).catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
