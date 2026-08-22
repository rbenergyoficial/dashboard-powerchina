/*
 * gen-must-intra.js — a demanda contra o MUST DENTRO do dia, em quatro resolucoes.
 *
 * POR QUE EXISTE. O `must_diario.json` guarda o PICO de cada dia, e com ele o painel responde
 * "quanto o parque apertou o contrato" em 7 dias, mes ou ano. O que ele nao responde e a forma da
 * curva: a que horas a demanda sobe, quanto tempo fica no patamar alto, se a ultrapassagem foi um
 * transitorio de um quarto de hora ou uma tarde inteira. Para isso e preciso a serie intradiaria,
 * que o blob diario descarta por construcao.
 *
 * QUATRO BLOBS, UM POR RESOLUCAO — e cada um com a JANELA que a resolucao comporta:
 *
 *   must_5min.json    5 min ·   7 dias  ·  2.016 linhas   — a semana, no detalhe do medidor
 *   must_15min.json  15 min ·  30 dias  ·  2.880 linhas   — o mes na base CONTRATUAL
 *   must_30min.json  30 min ·  90 dias  ·  4.320 linhas   — o trimestre
 *   must_60min.json  60 min · 365 dias  ·  8.760 linhas   — o ano inteiro
 *
 * A janela cresce quando a resolucao afrouxa porque o custo e o produto das duas. Um unico blob de
 * 5 min cobrindo o ano teria 935 mil pontos: o Infinity baixa a URL INTEIRA antes de aplicar o
 * JSONata, entao quem decide o peso da pagina e o recorte do arquivo, nao a consulta.
 *
 * FORMATO LARGO, uma coluna por parque. Em formato longo (uma linha por parque e instante) o ano em
 * 1 h daria 78.840 linhas e ~3,5 MB; em largo sao 8.760 linhas e ~790 KB, porque o instante deixa
 * de ser repetido nove vezes. Os nove parques sao fixos, entao a armadilha das colunas dinamicas
 * nao se aplica aqui — as colunas podem ser declaradas.
 *
 * A BASE DE 15 MINUTOS E A CONTRATUAL. O `gen-must.js` mede o pico do dia nela, e nao no
 * instantaneo de 5 min, porque em 5 min o pico passava da propria OUTORGA do parque em 12% a 22%,
 * em 94 a 143 dias de 360 — transitorio de medicao, nao carga. Aqui as quatro resolucoes convivem
 * porque cada uma responde uma pergunta diferente, mas o 5 min segue sendo DIAGNOSTICO: divergencia
 * grande entre ele e o de 15 min num dia denuncia transitorio.
 *
 * ACUMULATIVO, como o diario: le o que existe, mistura os dias novos, PODA o que saiu da janela e
 * regrava. Uma rodada que volte vazia nao pode apagar o passado.
 *
 * Env: WAY2_TOKEN [obrigatorio] · DADOS_STORAGE [obrigatorio fora de LOCAL_OUT] ·
 *      DIAS (quantos dias para tras processar, default 2) · FORCAR=1 (reprocessa dia ja presente) ·
 *      SO (processa so uma resolucao: 5, 15, 30 ou 60) · LOCAL_OUT (prefixo de arquivo local).
 */
const https = require('https');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const BASE_LEITURA = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

// os mesmos medidores dedicados do MUST que o gen-must.js le — 6380-6388, distintos dos 6196-6233
// da geracao. Os limites conferem com a outorga de cada usina.
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
const PARQUES = IDS.map(i => PONTOS[i].parque);
const GRANDEZA = 'Demat';   // demanda ativa: e ela que o contrato de MUST limita

const RESOLUCOES = [
  { min: 5, dias: 7, blob: 'must_5min.json',
    nota: 'Detalhe do medidor. Base de DIAGNOSTICO, nao contratual: o pico instantaneo de 5 min '
      + 'passa da outorga do parque com frequencia por transitorio de medicao.' },
  { min: 15, dias: 30, blob: 'must_15min.json',
    nota: 'Base CONTRATUAL. E nesta integralizacao que o pico do dia e apurado contra o MUST.' },
  { min: 30, dias: 90, blob: 'must_30min.json',
    nota: 'Meia hora, a mesma integralizacao dos arquivos do ONS.' },
  { min: 60, dias: 365, blob: 'must_60min.json',
    nota: 'Hora cheia. E a resolucao que comporta o ano inteiro num blob que a pagina consegue '
      + 'baixar.' },
];

const r = (v, d = 3) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
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
const query = (ini, fim) => 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZA
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=CincoMinutos'
  + '&medicao-datainicio=' + ini + '&medicao-datafim=' + fim
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

async function comRetry(q, token, tentativas = 3) {
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try { return await apiGet(q, token); }
    catch (e) { ultimo = e; await sleep(2000 * (i + 1)); }
  }
  throw ultimo;
}

// Agrega os slots de 5 min em baldes de `min`, pela borda ESQUERDA — a mesma convencao do
// gen-way2-agg.js e do gen-must.js. A string de tempo e manipulada direto (naive-local BRT):
// passar por Date arriscaria deslocar 3 h, que foi o defeito que essa convencao existe para evitar.
function porBalde(resp, dia, min) {
  const linhas = new Map();   // 'HH:MM' -> { M1: mw, ... }
  const acum = new Map();     // 'HH:MM|parque' -> { soma, n }
  for (const id of IDS) {
    const parque = PONTOS[id].parque;
    const s = (resp.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRANDEZA);
    for (const v of (s ? s.valores || [] : [])) {
      if (v.valor == null) continue;
      const hh = String(v.data).slice(11, 13), mm = +String(v.data).slice(14, 16);
      const chave = hh + ':' + String(Math.floor(mm / min) * min).padStart(2, '0');
      const k = chave + '|' + parque;
      const o = acum.get(k) || { soma: 0, n: 0 };
      o.soma += v.valor / 1000;   // a API devolve kW; o contrato e em MW
      o.n++; acum.set(k, o);
    }
  }
  for (const [k, o] of acum) {
    const [chave, parque] = k.split('|');
    const l = linhas.get(chave) || { t: dia + 'T' + chave + ':00-03:00' };
    l[parque] = r(o.soma / o.n);
    linhas.set(chave, l);
  }
  // O COMPLEXO E A SOMA SIMULTANEA, calculada balde a balde — nao a soma dos picos de cada parque,
  // que aconteceriam em horarios diferentes e dariam um numero que nenhum medidor leu.
  // GUARDA DE TUDO-OU-NADA: balde sem os nove parques fica sem Complexo. Somar oito subdeclara a
  // demanda simultanea, e o erro seria maior justamente na hora do pico.
  for (const l of linhas.values()) {
    const vs = PARQUES.map(p => l[p]).filter(v => v != null);
    if (vs.length === PARQUES.length) l.Complexo = r(vs.reduce((a, b) => a + b, 0));
  }
  return [...linhas.values()].sort((a, b) => a.t < b.t ? -1 : 1);
}

async function leBlob(url) {
  return new Promise(ok => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' } }, res => {
      if (res.statusCode !== 200) { res.resume(); return ok(null); }
      const cru = /gzip/i.test(res.headers['content-encoding'] || '')
        ? res.pipe(require('zlib').createGunzip()) : res;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ok(null); } });
    }).on('error', () => ok(null));
  });
}

async function grava(nome, obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    require('fs').writeFileSync(process.env.LOCAL_OUT + nome, json); return json.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(nome).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  return json.length;
}

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) { console.error('ERRO: WAY2_TOKEN ausente.'); process.exit(1); }
  const DIAS = Math.max(1, parseInt(process.env.DIAS || '2', 10) || 2);
  const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
  const SO = process.env.SO ? parseInt(process.env.SO, 10) : null;
  const alvos = SO ? RESOLUCOES.filter(x => x.min === SO) : RESOLUCOES;
  if (!alvos.length) throw new Error('SO=' + SO + ' nao e uma das resolucoes: 5, 15, 30, 60');

  // le os quatro blobs de uma vez e indexa por instante — assim um dia buscado na API alimenta as
  // quatro resolucoes de uma chamada so, em vez de quatro
  const estado = new Map();
  for (const res of alvos) {
    const antigo = await leBlob(BASE_LEITURA + res.blob);
    const m = new Map();
    for (const l of ((antigo || {}).serie || [])) m.set(l.t, l);
    estado.set(res.min, { mapa: m, antes: m.size });
  }

  // o dia mais antigo que QUALQUER alvo ainda quer; os outros podam depois
  const maxDias = Math.max(...alvos.map(x => x.dias));
  const limite = Math.min(DIAS, maxDias);
  let buscados = 0, vazios = 0;

  for (let off = 1; off <= limite; off++) {
    const dia = diaBRT(off);
    // so busca se ALGUM alvo precisa deste dia: dentro da janela dele e ainda ausente
    const precisa = alvos.filter(res => off <= res.dias
      && (FORCAR || ![...estado.get(res.min).mapa.keys()].some(t => t.startsWith(dia))));
    if (!precisa.length) continue;

    let resp;
    try { resp = await comRetry(query(dia + 'T00:00:00', dia + 'T23:59:59'), token); }
    catch (e) { console.log('  ' + dia + '  ERRO ' + e.message.slice(0, 50)); continue; }
    buscados++;

    let algum = 0;
    for (const res of precisa) {
      const linhas = porBalde(resp, dia, res.min);
      const st = estado.get(res.min);
      for (const l of linhas) st.mapa.set(l.t, l);
      algum += linhas.length;
    }
    if (!algum) { vazios++; console.log('  ' + dia + '  sem valor em nenhum ponto'); continue; }
    if (off % 20 === 0 || off <= 3)
      console.log('  ' + dia + '  ' + precisa.map(x => x.min + 'min:' + porBalde(resp, dia, x.min).length).join(' · '));
    await sleep(600);
  }

  console.log('\ndias buscados na API: ' + buscados + (vazios ? ' (' + vazios + ' vazios)' : ''));
  for (const res of alvos) {
    const st = estado.get(res.min);
    // PODA o que saiu da janela: sem isto o blob de 5 min cresceria para o ano inteiro e a pagina
    // passaria a baixar 25 MB para desenhar uma semana
    const corte = diaBRT(res.dias);
    const serie = [...st.mapa.values()].filter(l => l.t.slice(0, 10) >= corte)
      .sort((a, b) => a.t < b.t ? -1 : 1);

    // GUARDA ANTI-REGRESSAO: rodada que nao mudou nada NAO regrava. Sem isto, uma janela em que a
    // API responde vazia produz um blob identico com data nova — ruido que esconde o momento em
    // que a coleta parou de funcionar.
    if (serie.length === st.antes && !FORCAR) {
      console.log('  ' + res.blob.padEnd(17) + ' nada novo (' + st.antes + ' linhas) — NAO regravado');
      continue;
    }
    const dias = new Set(serie.map(l => l.t.slice(0, 10)));
    const out = {
      gerado_em: new Date().toISOString(),
      resolucao_min: res.min, janela_dias: res.dias,
      fonte: 'Way2 PIM, pontos 6380-6388 (medidores dedicados do MUST), grandeza Demat, coletada '
        + 'em 5 min e agregada por MEDIA no balde, pela borda esquerda. A API devolve kW; aqui vai '
        + 'em MW.',
      metodo: res.nota + ' Janela de ' + res.dias + ' dias: a resolucao e a janela sao um produto, '
        + 'e o Infinity baixa a URL inteira antes de aplicar o JSONata — quem decide o peso da '
        + 'pagina e o recorte do arquivo.',
      limiar: 'Acima de 100% do contratado e ultrapassagem do MUST do contrato de uso do sistema '
        + 'de transmissao, que e o que gera penalidade. As faixas de 95% (Atencao) e 98% (Alerta) '
        + 'sao avisos da casa, herdados do dashboard v7 — NAO sao limite regulatorio.',
      parques: [...PARQUES, 'Complexo'],
      contratos: Object.assign(Object.fromEntries(IDS.map(i => [PONTOS[i].parque, PONTOS[i].contrato])),
        { Complexo: r(Object.values(PONTOS).reduce((a, p) => a + p.contrato, 0), 2) }),
      dias: dias.size, linhas: serie.length,
      serie,
    };
    const t = await grava(res.blob, out);
    console.log('  ' + res.blob.padEnd(17) + ' ' + String(serie.length).padStart(6) + ' linhas · '
      + String(dias.size).padStart(3) + ' dias · ' + Math.round(t / 1024) + ' KB'
      + (st.antes ? '  (+' + (serie.length - st.antes) + ')' : ''));
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
