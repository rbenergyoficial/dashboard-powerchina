/*
 * gen-must.js — demanda contra o MUST contratado, por parque.
 *
 * POR QUE EXISTE. Os cards de MUST do dashboard HTML (ranking de pico, situacao por parque, picos
 * monitorados) dependem do PICO por parque, e esse numero nao existe em blob nenhum: o
 * way2_daily.json tem o pico do complexo e dos dois trafos, nao das nove usinas, e o way2_must.json
 * traz so a media DIARIA do mes corrente. O HTML nao sofre com isso porque calcula o pico ao vivo,
 * chamando a API da Way2 no navegador a cada carregamento — um painel Grafana lendo blob nao pode.
 *
 * O QUE PUBLICA (must_diario.json), por dia e por parque:
 *   ms (epoch de 00:00 BRT) · pico_mw (quarto de hora da FONTE) · hora do pico · media_mw
 *   · contratado_mw · pct_must
 *   · margem_mw · status
 * Semana, mes e ano saem DAI no JSONata do painel: 365 dias x 9 parques e um frame trivial.
 *
 * ACUMULATIVO POR CONSTRUCAO. O blob nunca e reescrito do zero: le o que existe, mistura os dias
 * novos e regrava. Se a API da Way2 so guardar 30 dias — e o way2_must.json sugere que o fluxo do
 * Power Automate so pede o mes corrente — o historico se constroi rodada a rodada, e uma rodada que
 * volte vazia NAO pode apagar o passado.
 *
 * MODO SONDA (SONDA=1): nao grava nada. Pergunta a API quantos dias ela devolve por ponto em
 * janelas cada vez mais antigas e imprime o resultado. Existe porque a profundidade do historico e
 * desconhecida e a resposta muda o desenho: com 12 meses o painel nasce completo, com 30 dias ele
 * nasce raso e enche com o tempo. Serve depois como diagnostico, quando a API mudar de
 * comportamento sem avisar.
 *
 * Env: WAY2_TOKEN [obrigatorio] · DADOS_STORAGE [obrigatorio fora da sonda] · SONDA=1 ·
 *      DIAS (quantos dias para tras processar, default 3) · FORCAR=1 (reprocessa dia ja presente) ·
 *      LOCAL_OUT (grava em arquivo em vez do blob).
 */
const https = require('https');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'must_diario.json';
const BASE_LEITURA = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

// pontoId -> parque, e o limite CONTRATADO em MW. Os pontos 6380-6388 sao os medidores dedicados
// do MUST, distintos dos 6196-6233 que o gen-way2-hist.js le para geracao. Os limites conferem com
// a outorga de cada usina e sao os mesmos configurados no "Compor Limites" do fluxo de alerta.
const PONTOS = {
  6380: { parque: 'M1', contrato: 49.11 },
  6381: { parque: 'M2', contrato: 24.55 },
  6382: { parque: 'M3', contrato: 49.11 },
  6383: { parque: 'M4', contrato: 49.11 },
  6384: { parque: 'M5', contrato: 49.11 },
  6385: { parque: 'M6', contrato: 49.11 },
  6386: { parque: 'M7', contrato: 14.73 },
  6387: { parque: 'M8', contrato: 49.11 },
  6388: { parque: 'M9', contrato: 9.82 },
};
const IDS = Object.keys(PONTOS);
const GRANDEZA = 'Demat';          // demanda ativa: e ela que o contrato de MUST limita

// FAIXAS DE STATUS, copiadas do dashboard HTML v7 (renderMustPeakRanking). O limiar de 100% tem
// fonte CONTRATUAL — e o MUST do contrato de uso do sistema de transmissao, e ultrapassa-lo e o
// que gera penalidade. Os de 95% e 98% sao faixas de AVISO da casa, sem norma por tras: existem
// para dar tempo de reagir antes da ultrapassagem, e estao aqui com esse nome para ninguem os
// confundir com limite regulatorio.
const FAIXAS = [
  { ate: 95, status: 'Normal' },
  { ate: 98, status: 'Atencao' },
  { ate: 100, status: 'Alerta' },
  { ate: Infinity, status: 'Critico' },
];
const statusDe = pct => (FAIXAS.find(f => pct <= f.ate) || FAIXAS[FAIXAS.length - 1]).status;

const r = (v, d = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
const sleep = ms => new Promise(x => setTimeout(x, ms));

// dia-calendario em BRT (UTC-3), independente do fuso do runner (que roda em UTC)
function diaBRT(offset = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

function apiGet(query, token, timeout = 90000) {
  return new Promise((ok, ko) => {
    const req = https.get({ ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': token }, timeout }, res => {
      if (res.statusCode !== 200) { res.resume(); return ko(new Error('Way2 HTTP ' + res.statusCode)); }
      let buf = ''; res.on('data', c => buf += c);
      res.on('end', () => { try { ok(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}

function query(ini, fim, intervalo) {
  return 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZA + '&contextodasdatas=ConsiderarDiaCheio'
    + '&intervalo=' + intervalo + '&medicao-datainicio=' + ini + '&medicao-datafim=' + fim
    + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
}

// 🔴 O 429 PRECISA DE ESPERA LONGA, nao de mais uma tentativa rapida. Medido em 22/08/2026 na
// recarga de 366 dias: com duas chamadas por dia o volume dobrou e a Way2 passou a devolver
// HTTP 429 em seis dias espalhados. O backoff de 2/4/6 s nao alcanca uma janela de limite —
// aqueles dias falharam e ficaram com o dado ANTIGO, sem erro visivel no fim do job, que
// terminou 'success'.
//
// Agora o 429 dorme progressivamente mais (15/30/60/120 s) e ganha tentativas extras. Um dia
// perdido numa recarga de alinhamento e um dia que continua publicando o numero errado.
async function comRetry(q, token, tentativas = 5) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try { return await apiGet(q, token); }
    catch (e) {
      ultimo = e;
      const limite = /429/.test(e.message || '');
      await sleep(limite ? Math.min(120000, 15000 * 2 ** i) : 2000 * (i + 1));
    }
  }
  throw ultimo;
}

// ---------------- SONDA ----------------
// Pergunta janelas cada vez mais antigas e conta quantos dias voltaram COM valor. Usa intervalo
// UmDia de proposito: e a consulta mais barata que ainda responde "existe dado aqui?".
async function sonda(token) {
  const hoje = diaBRT(0);
  const janelas = [0, 1, 2, 3, 6, 11, 17, 23].map(m => {
    const d = new Date(hoje + 'T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() - m);
    const ini = d.toISOString().slice(0, 8) + '01';
    const f = new Date(ini + 'T12:00:00Z'); f.setUTCMonth(f.getUTCMonth() + 1); f.setUTCDate(0);
    return { rotulo: ini.slice(0, 7), ini, fim: f.toISOString().slice(0, 10) };
  });
  console.log('SONDA · quantos dias COM VALOR a API devolve, por janela e por ponto');
  console.log('janela  | ' + Object.values(PONTOS).map(p => p.parque.padStart(5)).join(' ') + '  | total');
  for (const j of janelas) {
    let linha = [], tot = 0;
    try {
      const resp = await comRetry(query(j.ini + 'T00:00:00', j.fim + 'T23:59:59', 'UmDia'), token);
      for (const id of IDS) {
        const s = (resp.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRANDEZA);
        const n = s ? (s.valores || []).filter(v => v.valor != null).length : 0;
        linha.push(String(n).padStart(5)); tot += n;
      }
      console.log(j.rotulo + ' | ' + linha.join(' ') + '  | ' + tot);
    } catch (e) {
      console.log(j.rotulo + ' | ERRO: ' + e.message.slice(0, 60));
    }
    await sleep(800);
  }
  console.log('\nLeitura: coluna zerada = a API nao guarda aquele mes para aquele ponto.');
  console.log('Se so o mes corrente voltar cheio, o must_diario.json tem de ser ACUMULATIVO — e ele e.');
}

// ---------------- dia a dia ----------------
// Pico e media do dia por parque. O horario do pico vai junto: sem ele o card de "picos
// monitorados" nao tem o que mostrar, e e a informacao que a operacao usa para achar a causa.
//
// 🔴 A BASE E 15 MINUTOS, NAO 5. Demanda no setor eletrico se apura por INTEGRALIZACAO de 15
// minutos, e o proprio dashboard v7 abre com "15 min" no seletor. Medido em 21/08/2026 com a base
// de 5 min: o pico instantaneo passava da OUTORGA do parque em 12% a 22%, em 94 a 143 dias de 360
// — um parque de 49,11 MW marcando 55,7 MW. Nao e ultrapassagem de MUST, e transitorio de medicao
// que a integralizacao de 15 min dissolve. Publicar aquilo pintaria 29% dos dias de "Critico".
//
// O de 5 min fica publicado ao lado (`pico5_mw`), como diagnostico: se um dia os dois divergirem
// muito, e sinal de transitorio, nao de carga.
// 🔴 O QUARTO DE HORA VEM PRONTO DA FONTE, nao e mais agregado aqui. Ate 22/08/2026 este arquivo
// pedia so CincoMinutos e montava o balde de 15 min por borda ESQUERDA — e a Way2 rotula pela
// borda DIREITA (o valor em T cobre (T-15, T]). O balde saia deslocado 5 minutos do quarto de hora
// que o ONS afere, e o efeito nao era sutil: nos cinco dias auditados, 10 intervalos acima de 100%
// pelo balde caseiro contra ZERO pelo quarto de hora da fonte — nove dia-parque de falso positivo.
//
// Agora sao duas chamadas por dia: CincoMinutos para o diagnostico de transitorio (`pico5_mw`) e
// QuinzeMinutos para o numero contratual.
const INTERVALO_CONTRATUAL = 'QuinzeMinutos';
const INTERVALO_DIAGNOSTICO = 'CincoMinutos';
const AMOSTRAS_DIA = { QuinzeMinutos: 96, CincoMinutos: 288 };

// O COMPLEXO NAO E A SOMA DOS PICOS. Cada parque atinge o seu em um horario diferente, entao
// somar os nove picos produz um numero maior do que qualquer medidor ja leu. O pico do conjunto e
// o maior valor da SOMA INSTANTANEA — a demanda simultanea — e por isso ele so pode ser calculado
// aqui, onde a serie de 5 min ainda existe. Foi por nao ter esse numero que a matriz dia x parque
// saiu sem coluna de total.
//
// GUARDA DE TUDO-OU-NADA no slot: se um dos nove pontos nao tem valor naquele instante, o slot
// inteiro fica de fora. Somar oito e chamar de complexo subdeclara a demanda simultanea, e o erro
// seria maior justamente nas horas de pico, quando um ponto falha.
const CONTRATO_CX = Object.values(PONTOS).reduce((a, p) => a + p.contrato, 0);
function serieComplexo(resp) {
  const porInstante = new Map();
  for (const id of IDS) {
    const s = (resp.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRANDEZA);
    for (const v of (s ? s.valores || [] : [])) {
      if (v.valor == null) continue;
      const o = porInstante.get(v.data) || { soma: 0, n: 0 };
      o.soma += v.valor / 1000; o.n++; porInstante.set(v.data, o);
    }
  }
  const completos = [...porInstante.entries()].filter(([, o]) => o.n === IDS.length);
  return completos.map(([data, o]) => ({ data, valor: o.soma * 1000 }));  // de volta a kW
}

// devolve { pico, hora } da serie de um ponto, ja na resolucao que a fonte entregou
function picoDe(resp, id) {
  const s = (resp.dados || []).find(x => String(x.pontoId) === String(id)
    && x.nomeGrandeza === GRANDEZA);
  const vs = (s ? s.valores || [] : []).filter(v => v.valor != null);
  if (!vs.length) return null;
  let pico = -Infinity, hora = null, soma = 0;
  for (const v of vs) {
    const mw = v.valor / 1000; soma += mw;      // a API devolve kW; o contrato e em MW
    if (mw > pico) { pico = mw; hora = String(v.data).slice(11, 16); }
  }
  return { pico, hora, media: soma / vs.length, n: vs.length };
}

function doDia(resp15, resp5, dia) {
  const out = [];
  for (const id of IDS) {
    const p = PONTOS[id];
    const q = picoDe(resp15, id);
    if (!q) continue;
    const d5 = picoDe(resp5, id);
    const pico = q.pico, hora = q.hora;
    const pico5 = d5 ? d5.pico : null, hora5 = d5 ? d5.hora : null;
    const soma = q.media * q.n;
    const vs = { length: q.n };
    const pct = p.contrato > 0 ? 100 * pico / p.contrato : null;
    out.push({
      dia, parque: p.parque,
      pico_mw: r(pico, 3), pico_hora: hora,              // 15 min — a base contratual
      pico5_mw: r(pico5, 3), pico5_hora: hora5,          // 5 min — diagnostico de transitorio
      media_mw: r(soma / vs.length, 3),
      contratado_mw: p.contrato, pct_must: r(pct, 2),
      margem_mw: r(p.contrato - pico, 3),
      status: pct == null ? null : statusDe(pct),
      slots: vs.length,   // intervalos de 15 min com valor no dia (96 num dia fechado)
    });
  }
  // o conjunto entra como uma "usina" a mais, com o mesmo formato das nove — assim todo painel
  // que ja filtra por parque ganha o Complexo de graca
  // 🔴 O EPOCH DO DIA VAI JUNTO, para o painel poder recortar pelo seletor de tempo do dashboard.
  // Sem ele o ranking e as tabelas ficavam presos a uma janela propria, derivada do seletor de
  // Periodo, enquanto a curva obedecia ao seletor de tempo — e os dois mostravam numeros diferentes
  // para o mesmo parque sem nada na tela explicando por que (medido em 22/08/2026: M2 a 101,4% no
  // ranking de 90 dias contra 90,5% na curva de 24 h).
  //
  // Nao da para derivar isso no painel: o JSONata Go parseia `$toMillis('2026-08-22')` como 00:00
  // UTC — correto, mas UTC — e IGNORA o offset em '2026-08-22T00:00:00-03:00', devolvendo tambem
  // 00:00 UTC. Corrigir no painel exigiria somar 3 h a mao, que e numero de fuso escrito no painel.
  const cx = serieComplexo(resp15);
  const cx5 = serieComplexo(resp5);
  if (cx.length) {
    let pico5 = -Infinity, hora5 = null;
    for (const v of cx5) { const mw = v.valor / 1000;
      if (mw > pico5) { pico5 = mw; hora5 = String(v.data).slice(11, 16); } }
    if (pico5 === -Infinity) { pico5 = null; hora5 = null; }
    let pico = -Infinity, hora = null, soma = 0;
    for (const v of cx) { const mw = v.valor / 1000; soma += mw;
      if (mw > pico) { pico = mw; hora = String(v.data).slice(11, 16); } }
    const pct = 100 * pico / CONTRATO_CX;
    out.push({ dia, parque: 'Complexo',
      pico_mw: r(pico, 3), pico_hora: hora,
      pico5_mw: r(pico5, 3), pico5_hora: hora5,
      media_mw: r(soma / cx.length, 3),
      contratado_mw: r(CONTRATO_CX, 2), pct_must: r(pct, 2),
      margem_mw: r(CONTRATO_CX - pico, 3),
      status: statusDe(pct), slots: cx.length });
  }
  return out;
}

// 🔴 A DIFERENCA ENTRE "NAO EXISTE" E "NAO DEU PARA LER" E O HISTORICO INTEIRO. Antes, qualquer
// falha — 500 da rede, gzip corrompido, JSON truncado — devolvia `null`, o gerador tratava como
// primeira execucao e regravava o blob so com os dias desta rodada. Com DIAS=2 isso apagaria 365.
//
// O risco cresceu quando o blob passou a ser gravado comprimido: virou mais um ponto onde a
// leitura pode falhar. Agora so o 404 devolve "vazio"; o resto ESTOURA, o job fica vermelho e o
// blob antigo continua no ar — que e o comportamento certo.
async function leBlob(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' } }, res => {
      if (res.statusCode === 404) { res.resume(); return ok(null); }
      if (res.statusCode !== 200) { res.resume(); return ko(new Error('HTTP ' + res.statusCode + ' ao ler ' + url)); }
      const cru = /gzip/i.test(res.headers['content-encoding'] || '')
        ? res.pipe(require('zlib').createGunzip()) : res;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('error', e => ko(new Error('descompressao falhou em ' + url + ': ' + e.message)));
      cru.on('end', () => {
        try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); }
        catch (e) { ko(new Error('JSON invalido em ' + url + ': ' + e.message)); }
      });
    }).on('error', e => ko(new Error('rede falhou em ' + url + ': ' + e.message)));
  });
}

async function grava(obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
// 🔴 O BLOB VAI COMPRIMIDO. Medido em 23/08/2026: o Azure Blob NAO comprime sozinho — ele serve
// exatamente os bytes gravados, e o `must_15min.json` saia com 1.281 KB na rede mesmo com o
// cliente pedindo gzip. O download levava de 3,6 a 8,8 segundos, e era o maior custo de cada
// troca de filtro na pagina.
//
// Gravando JA comprimido, com o header `Content-Encoding: gzip`, o mesmo arquivo vai a 209 KB —
// 84% menos. Navegador e datasource descomprimem sozinhos; nenhum consumidor precisa saber.
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  await cont.createIfNotExists();
  const gz = require('zlib').gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  await cont.getBlockBlobClient(OUT_BLOB).upload(gz, gz.length,
    { blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip',
      blobCacheControl: 'public, max-age=900' } });
  return gz.length;
}

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) { console.error('ERRO: WAY2_TOKEN ausente.'); process.exit(1); }

  if (/^(1|true|sim)$/i.test(process.env.SONDA || '')) { await sonda(token); return; }

  const DIAS = Math.max(1, parseInt(process.env.DIAS || '3', 10) || 3);
  const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');

  const antigo = (await leBlob(BASE_LEITURA + OUT_BLOB)) || {};
  const mapa = new Map();
  for (const l of (antigo.serie || [])) mapa.set(l.dia + '|' + l.parque, l);
  const antes = mapa.size;

  let dias = 0, novos = 0, vazios = 0;
  // COMECA EM off=0: o dia de hoje entra PARCIAL e cresce a cada rodada. Sem ele o pico "de hoje"
  // so apareceria depois da meia-noite, e a pagina nunca mostraria o que esta acontecendo agora.
  for (let off = 0; off <= DIAS; off++) {
    const dia = diaBRT(off);
    const hoje = off === 0;
    // o dia corrente nunca conta como "ja presente": o que esta la esta incompleto
    if (!hoje && !FORCAR && [...mapa.keys()].some(k => k.startsWith(dia + '|'))) continue;
    // DUAS chamadas por dia: o quarto de hora contratual vem pronto da fonte, e o de 5 min fica
    // ao lado so como diagnostico de transitorio
    let resp15, resp5;
    try {
      resp15 = await comRetry(query(dia + 'T00:00:00', dia + 'T23:59:59', INTERVALO_CONTRATUAL), token);
      await sleep(600);
      resp5 = await comRetry(query(dia + 'T00:00:00', dia + 'T23:59:59', INTERVALO_DIAGNOSTICO), token);
    } catch (e) { console.log('  ' + dia + '  ERRO ' + e.message.slice(0, 50)); continue; }
    // GUARDA DE GRANULARIDADE: um dia fechado tem de vir com o numero de amostras da resolucao
    // pedida. Se a API entender o intervalo de outro jeito, isso falha alto em vez de publicar
    // um pico apurado na granularidade errada.
    if (!hoje) for (const [nome, resp] of [[INTERVALO_CONTRATUAL, resp15], [INTERVALO_DIAGNOSTICO, resp5]]) {
      const s0 = (resp.dados || []).find(x => (x.valores || []).length);
      const n = s0 ? s0.valores.length : 0;
      if (n && n !== AMOSTRAS_DIA[nome])
        throw new Error(dia + ' em ' + nome + ' voltou com ' + n + ' amostras, esperado '
          + AMOSTRAS_DIA[nome] + ' — a fonte mudou a granularidade');
    }
    const linhas = doDia(resp15, resp5, dia);
    dias++;
    if (!linhas.length) { vazios++; console.log('  ' + dia + '  sem valor em nenhum ponto'); continue; }
    // 00:00 no horario de Brasilia. O dia INTEIRO vai de `ms` a `ms + 86.400.000`, e e assim que
    // o painel decide se ele toca a janela selecionada.
    const ms = Date.parse(dia + 'T03:00:00Z');
    for (const l of linhas) { l.ms = ms; if (hoje) l.parcial = true;
      mapa.set(l.dia + '|' + l.parque, l); novos++; }
    const pior = linhas.slice().sort((a, b) => b.pct_must - a.pct_must)[0];
    console.log('  ' + dia + '  ' + linhas.length + ' parques  ·  pior: ' + pior.parque + ' '
      + pior.pico_mw + ' MW (' + pior.pct_must + '% do MUST, ' + pior.status + ') as ' + pior.pico_hora);
    await sleep(600);
  }

  const serie = [...mapa.values()].sort((a, b) => a.dia === b.dia ? a.parque.localeCompare(b.parque) : (a.dia < b.dia ? -1 : 1));
  // GUARDA ANTI-REGRESSAO: rodada que nao acrescentou nada NAO regrava. Sem isto, uma janela em que
  // a API responde vazia produziria um blob identico com data nova — ruido que esconde o momento em
  // que a coleta parou de funcionar.
  // linha antiga sem `ms` recebe o dela agora: o campo nasceu depois de 366 dias ja gravados, e o
  // recorte por janela trataria como ausente tudo o que veio antes
  let remendo = 0;
  for (const l of serie) if (l.ms == null) { l.ms = Date.parse(l.dia + 'T03:00:00Z'); remendo++; }
  if (remendo) console.log('  ms retroativo em ' + remendo + ' linhas antigas');
  const temHoje = serie.some(l => l.dia === diaBRT(0));
  if (serie.length === antes && !temHoje && !remendo && !FORCAR) {
    console.log('\nnada novo (' + antes + ' linhas ja presentes) — blob NAO regravado');
    return;
  }
  const dias_distintos = new Set(serie.map(x => x.dia)).size;
  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'Way2 PIM, pontos 6380-6388 (medidores dedicados do MUST), grandeza Demat, 5 min. '
      + 'A API devolve kW; aqui vai em MW.',
    metodo: 'Pico do dia por parque em INTEGRALIZACAO DE 15 MINUTOS (media dos slots de 5 min no '
      + 'quarto de hora), com o horario do balde. pct_must = pico / contratado x 100 · '
      + 'margem = contratado - pico. O pico instantaneo de 5 min vai ao lado em pico5_mw, so como '
      + 'diagnostico: medido em 21/08/2026, ele passa da OUTORGA do parque em 12% a 22% num terco '
      + 'dos dias, o que e transitorio de medicao e nao carga — usa-lo como base pintaria 29% dos '
      + 'dias de Critico.',
    faixas: 'Status pelas faixas do dashboard HTML v7: ate 95% Normal, ate 98% Atencao, ate 100% '
      + 'Alerta, acima de 100% Critico. O 100% e CONTRATUAL (MUST do contrato de uso do sistema de '
      + 'transmissao); 95% e 98% sao faixas de aviso da casa, sem norma por tras.',
    contratos: Object.assign(Object.fromEntries(Object.values(PONTOS).map(p => [p.parque, p.contrato])),
      { Complexo: r(CONTRATO_CX, 2) }),
    dias: dias_distintos, linhas: serie.length, serie,
  };
  const t = await grava(out);
  console.log('\n' + OUT_BLOB + ' OK · ' + Math.round(t / 1024) + ' KB · ' + dias_distintos
    + ' dias · ' + serie.length + ' linhas (+' + novos + ' nesta rodada, ' + dias + ' dias lidos, '
    + vazios + ' vazios)');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
