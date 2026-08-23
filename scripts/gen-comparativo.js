/*
 * gen-comparativo.js — as TRES fontes de geracao no mesmo balde de tempo.
 *
 * == POR QUE EXISTE ==========================================================================
 *
 * O complexo e medido tres vezes, por caminhos independentes:
 *
 *   ONS    dados abertos, geracao verificada por UFV, 30 min   — o que o operador nacional apurou
 *   Way2   medidor de faturamento, EneatRec, ate 5 min         — o que sera faturado
 *   SCADA  supervisorio da usina, ate 5 min                    — o que a usina registrou
 *
 * Elas NAO batem, e a divergencia e informacao: ela denuncia tag trocada, cubiculo com RTC errado,
 * falha de coleta e defasagem de publicacao. Hoje cada uma vive num blob de formato proprio, e
 * comparar exige que alguem alinhe unidade, sentido e rotulo de tempo na mao — que e exatamente
 * onde o erro entra.
 *
 * Este gerador faz esse alinhamento UMA vez, com guarda, e publica o resultado pronto.
 *
 * == AS TRES CONVERSOES, TODAS MEDIDAS EM 23/08/2026 =========================================
 *
 *   ONS    `gv` vem em MW (potencia media do intervalo de 30 min)  ->  x 0,5  = MWh
 *   Way2   `EneatRec` vem em kWh por intervalo                     ->  / 1000 = MWh
 *   SCADA  a ORIGEM e MW; o blob intradiario JA VEM convertido     ->  x 1
 *
 * A do SCADA e a que engana, e vale escrever devagar: a planilha do supervisorio traz POTENCIA em
 * MW, amostrada de 5 em 5 minutos. Quem converte e a leitura do xlsx (`P x 5/60`), entao o que
 * chega neste gerador ja e energia. Multiplicar por 0,25 aqui — o reflexo natural de quem ve
 * -0,11 no meio da noite e reconhece potencia — dividiria o SCADA por quatro, e a pagina mostraria
 * a usina registrando um quarto do que gera.
 *
 * Prova de que ja e energia: a soma crua dos 96 slots bate com o proprio diario na razao 1,0000,
 * em tres dias conferidos.
 *
 * Fechamento das tres num mesmo dia, depois das conversoes (complexo, MWh):
 *
 *     dia          ONS      Way2     SCADA    ONS/Way2   SCADA/Way2
 *     2026-07-10  2150,2   2194,7    2178,1     97,97%      99,24%
 *     2026-07-11  1759,1   1787,6    1794,1     98,40%     100,36%
 *     2026-07-12  1358,4   1293,7    1280,9    105,00%      99,01%
 *
 * Antes de fechar assim elas divergiam de 14% a 31%, e a causa era um MAPA DE PONTO errado do meu
 * lado: tres parques (M7, M8, M9) ficavam de fora da soma do Way2. O defeito nao aparecia como
 * erro — aparecia como "o ONS mede 20% a mais que o medidor", que e uma conclusao plausivel e
 * completamente falsa. Por isso o mapa vem de UM lugar so, abaixo, e o ensaio confere o fechamento.
 *
 * == ROTULO DE TEMPO: AQUI E A BORDA ESQUERDA, E ISSO DIVERGE DO MUST DE PROPOSITO ============
 *
 * Medido no dia 20/08/2026, testando deslocamentos e escolhendo pelo erro:
 *
 *   ONS x SCADA em 30 min     desloc -1: 7,091   desloc 0: 0,577   desloc +1: 6,741  MWh
 *   SCADA x Way2 em 15 min    lendo o Way2 pela borda DIREITA, desloc 0: 0,467
 *                             lendo o Way2 pela borda ESQUERDA, o melhor e desloc -1: 0,471
 *
 * Ou seja: ONS e SCADA rotulam pelo INICIO do intervalo; a Way2 rotula pelo FIM. E o mesmo achado
 * que no MUST inverteu conclusao (dez ultrapassagens que nao existiam).
 *
 * O `must_*.json` guarda o rotulo COMO A FONTE ENTREGA — fim do intervalo — porque ali ha uma
 * fonte so e converter seria inventar convencao. Aqui ha TRES, e uma delas tem de ceder. Cede a
 * Way2, por dois motivos: duas das tres ja sao borda esquerda, e o ONS e a referencia contratual.
 * O deslocamento acontece AQUI, uma vez, e vai declarado em `rotulo_de_tempo`.
 *
 * Quem for uniformizar os blobs um dia: esta divergencia e deliberada, nao esquecimento.
 *
 * == O QUE CADA RESOLUCAO CONSEGUE TER =======================================================
 *
 *              ONS      Way2     SCADA
 *    5 min      -         X        X      o ONS publica em 30 min; nao ha o que repartir
 *   15 min      -         X        X
 *   30 min      X         X        X      a comparacao mais completa
 *   60 min      X         X        X
 *   diario      X         X        X
 *
 * A ausencia do ONS abaixo de 30 min NAO e falha de coleta, e o painel tem de dizer isso — senao
 * o leitor conclui que a fonte falhou. Por isso a coluna nem aparece no blob de 5 e 15 min
 * (esquema podado) e `fontes_ausentes` diz o motivo.
 *
 * == TUDO-OU-NADA MORA NO PAINEL, NAO AQUI ===================================================
 *
 * Energia e aditiva, entao o complexo e a soma dos nove — ao contrario da demanda do MUST, onde a
 * soma dos picos infla. Mas somar OITO parques de uma fonte contra NOVE de outra produz
 * divergencia que e de cobertura, nao de medicao.
 *
 * A guarda nao pode morar aqui porque o painel soma a SELECAO do leitor, que muda. Entao o blob
 * publica valor por parque (ausente quando falta) e o seletor aplica a regra sobre a selecao: se
 * qualquer parque selecionado faltar naquela fonte, a soma daquela fonte vira nulo.
 *
 * == ENV =====================================================================================
 *   DADOS_STORAGE  connection string do Azure (Secret)      obrigatorio fora do LOCAL_OUT
 *   WAY2_TOKEN     Pim-Auth da API Way2 (Secret)            obrigatorio
 *   DIAS           quantos dias reprocessar (default 3)
 *   FORCAR         1 = regrava mesmo sem mudanca
 *   SO             so esta resolucao (5|15|30|60, ou 0 para o diario)
 *   LOCAL_OUT      grava em arquivo local em vez do blob (ensaio, sem segredo de storage)
 */
const https = require('https');

const CONTAINER = 'dados';
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };

// UM MAPA SO. Foi um mapa chutado que produziu a divergencia falsa de 14% a 31% descrita no
// cabecalho. Os ids vieram do gen-eneat-intradia.js, que e quem ja lia EneatRec em producao.
const PONTOS = {
  6368: 'M1', 6369: 'M2', 6373: 'M3', 6374: 'M4', 6375: 'M5',
  6376: 'M6', 6215: 'M7', 6378: 'M8', 6219: 'M9',
};
const IDS = Object.keys(PONTOS);
const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];

// A tag do ONS nao segue a numeracao por acaso: CEFMT7 chegou a apontar para o circuito 2 do M3 na
// fonte, corrigido na publicacao em 17/07/2026. O mapa e o mesmo que o gerador de irradiancia usa.
const TAG_ONS = {
  CEFMT1: 'M1', CEFMT2: 'M2', CEFMT3: 'M3', CEFMT4: 'M4', CEFMT5: 'M5',
  CEFMT6: 'M6', CEFMT7: 'M7', CEFMT8: 'M8', CEFMT9: 'M9',
};

// Nomes medidos contra a API: nome que ela nao entende devolve HTTP 400, entao errar aqui falha
// alto em vez de publicar granularidade trocada.
const INTERVALO_API = { 5: 'CincoMinutos', 15: 'QuinzeMinutos', 30: 'TrintaMinutos', 60: 'UmaHora' };
const AMOSTRAS_DIA = { 5: 288, 15: 96, 30: 48, 60: 24 };

// As janelas saem do MESMO teto de linhas do MUST: ~8.700 por blob. Aqui cada linha carrega ate 27
// colunas em vez de 9, entao o arquivo cru e ~3x mais pesado — mas vai comprimido, e a pagina baixa
// um de cada vez.
const RESOLUCOES = [
  {
    min: 5, dias: 30, blob: 'cmp_5min.json',
    nota: 'Detalhe do medidor e do supervisorio. O ONS nao publica nesta resolucao.',
  },
  {
    min: 15, dias: 90, blob: 'cmp_15min.json',
    nota: 'Quarto de hora. O ONS nao publica nesta resolucao.',
  },
  {
    min: 30, dias: 180, blob: 'cmp_30min.json',
    nota: 'Meia hora. E a resolucao nativa do ONS, entao a comparacao mais fiel das tres fontes.',
  },
  {
    min: 60, dias: 365, blob: 'cmp_60min.json',
    nota: 'Hora cheia. E a resolucao que comporta o ano inteiro num arquivo que a pagina baixa.',
  },
  {
    min: 0, dias: 9999, blob: 'cmp_diario.json',
    nota: 'Um valor por dia, desde o inicio da operacao. E onde a divergencia estrutural entre as '
      + 'fontes aparece sem o ruido do intradiario.',
  },
];

const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const sleep = (ms) => new Promise((x) => setTimeout(x, ms));

function diaBRT(off = 0) {
  const d = new Date(Date.now() - 3 * 3600 * 1000 - off * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}

// ---- leitura de blob: so o 404 e "vazio"; o resto ESTOURA --------------------------------------
// Mesma guarda do gen-must-intra, e pela mesma razao: devolver null para qualquer falha faz o
// gerador se achar na primeira execucao e regravar o blob so com os dias desta rodada.
function leBlob(nome) {
  return new Promise((ok, ko) => {
    https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' } }, (res) => {
      if (res.statusCode === 404) { res.resume(); return ok(null); }
      if (res.statusCode !== 200) {
        res.resume();
        return ko(new Error('HTTP ' + res.statusCode + ' ao ler ' + nome));
      }
      const cru = /gzip/i.test(res.headers['content-encoding'] || '')
        ? res.pipe(require('zlib').createGunzip())
        : res;
      const c = [];
      cru.on('data', (d) => c.push(d));
      cru.on('error', (e) => ko(new Error('descompressao falhou em ' + nome + ': ' + e.message)));
      cru.on('end', () => {
        try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); }
        catch (e) { ko(new Error('JSON invalido em ' + nome + ': ' + e.message)); }
      });
    }).on('error', (e) => ko(new Error('rede falhou em ' + nome + ': ' + e.message)));
  });
}

// O BLOB VAI COMPRIMIDO. O Azure serve exatamente os bytes gravados — nao comprime sozinho — e foi
// o download que virou o maior custo da pagina do MUST antes desta mudanca.
async function grava(nome, obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    require('fs').writeFileSync(process.env.LOCAL_OUT + nome, json);
    return json.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  await cont.createIfNotExists();
  const gz = require('zlib').gzipSync(Buffer.from(json, 'utf8'), { level: 9 });
  await cont.getBlockBlobClient(nome).upload(gz, gz.length, {
    blobHTTPHeaders: {
      blobContentType: 'application/json',
      blobContentEncoding: 'gzip',
      blobCacheControl: 'public, max-age=' + (nome === 'cmp_diario.json' ? 3600 : 300),
    },
  });
  return gz.length;
}

// ---- Way2 --------------------------------------------------------------------------------------
function apiGet(query, token, timeout = 90000) {
  return new Promise((ok, ko) => {
    const req = https.get(
      { ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': token }, timeout },
      (res) => {
        if (res.statusCode !== 200) { res.resume(); return ko(new Error('Way2 HTTP ' + res.statusCode)); }
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          try { ok(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { ko(e); }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', ko);
  });
}

// O 429 pede espera LONGA, nao mais uma tentativa rapida — licao da recarga de 366 dias do MUST,
// em que o backoff curto deixou seis dias com o dado antigo e o job terminou verde.
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

const query = (ini, fim, intervalo) => 'ids=' + IDS.join(',') + '&grandezas=EneatRec'
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + ini + '&medicao-datafim=' + fim
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

// A CARGA INICIAL NAO CABE NUMA CHAMADA SO. Em 5 min sao 2.592 valores por dia (288 x 9 pontos);
// os 30 dias da janela dariam 78 mil numa requisicao. A experiencia da recarga do MUST foi que
// pedido grande demais volta em timeout — e timeout, depois do retry, vira "a fonte nao trouxe
// nada", que e indistinguivel de fonte fora do ar.
//
// O bloco e dimensionado por ORCAMENTO DE VALORES, nao por um numero de dias escolhido a esmo:
// cada requisicao pede no maximo ~30 mil valores, entao a resolucao fina pede blocos curtos e a
// grossa pede blocos longos, sem que ninguem precise ajustar tabela.
const ORCAMENTO_VALORES = 30000;

function diasPorBloco(passoMin) {
  const porDia = (1440 / passoMin) * IDS.length;
  return Math.max(1, Math.floor(ORCAMENTO_VALORES / porDia));
}

function somaDias(dia, n) {
  const d = new Date(dia + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Busca a janela inteira em blocos e junta os mapas. Junta SOMANDO, nao sobrescrevendo: se dois
// blocos se tocarem numa borda, sobrescrever perderia um parque e somar duplicaria — entao os
// blocos sao disjuntos por construcao e a juncao apenas preenche.
async function buscaEmBlocos(de, ate, intervalo, passoMin, token, diario) {
  const passo = diario ? 60 : passoMin;
  const bloco = diario ? 3650 : diasPorBloco(passo);
  const junto = new Map();
  let ini = de;
  let n = 0;
  while (ini <= ate) {
    const fim = somaDias(ini, bloco - 1) > ate ? ate : somaDias(ini, bloco - 1);
    const resp = await comRetry(query(ini + 'T00:00:00', fim + 'T23:59:59', intervalo), token);
    const m = diario ? way2DiarioParaMapa(resp) : way2ParaMapa(resp, passoMin);
    for (const [k, v] of m) {
      const alvo = junto.get(k) || {};
      for (const q of PARQUES) if (v[q] != null) alvo[q] = v[q];
      junto.set(k, alvo);
    }
    n++;
    ini = somaDias(fim, 1);
  }
  if (n > 1) console.log('    Way2: ' + n + ' blocos de ate ' + bloco + ' dias');
  return junto;
}

// chave de balde em hora de Brasilia, sem depender do fuso do runner (que roda em UTC)
function chaveBRT(ms) {
  return new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16);
}

/*
 * Way2 -> mapa { 'AAAA-MM-DDTHH:MM' : { M1..M9 } }, ja em MWh e ja na BORDA ESQUERDA.
 *
 * O DESLOCAMENTO E O CORACAO DESTA FUNCAO. A API rotula pelo FIM: o valor em T cobre (T-passo, T].
 * Subtrair um passo poe a Way2 no mesmo instante que o ONS e o SCADA usam. Sem isso a curva sai um
 * balde adiantada, e a divergencia contra as outras duas vira uma serrilha que ninguem le como erro
 * de rotulo — parece ruido de medicao.
 */
function way2ParaMapa(resp, passoMin) {
  const m = new Map();
  for (const id of IDS) {
    const parque = PONTOS[id];
    const s = (resp.dados || []).find(
      (x) => String(x.pontoId) === String(id) && x.nomeGrandeza === 'EneatRec',
    );
    for (const v of (s ? s.valores || [] : [])) {
      if (v.valor == null) continue;
      const fim = Date.parse(String(v.data).slice(0, 19) + '-03:00');
      if (!isFinite(fim)) continue;
      const chave = chaveBRT(fim - passoMin * 60000);
      const l = m.get(chave) || {};
      l[parque] = (l[parque] || 0) + v.valor / 1000; // kWh -> MWh
      m.set(chave, l);
    }
  }
  return m;
}

function way2DiarioParaMapa(resp) {
  const m = new Map();
  for (const id of IDS) {
    const parque = PONTOS[id];
    const s = (resp.dados || []).find(
      (x) => String(x.pontoId) === String(id) && x.nomeGrandeza === 'EneatRec',
    );
    for (const v of (s ? s.valores || [] : [])) {
      if (v.valor == null) continue;
      const dia = String(v.data).slice(0, 10);
      const l = m.get(dia) || {};
      l[parque] = (l[parque] || 0) + v.valor / 1000;
      m.set(dia, l);
    }
  }
  return m;
}

// ---- ONS ---------------------------------------------------------------------------------------
// A geracao verificada POR UFV so existe nos blobs mensais de irradiancia; o consolidado de
// restricao e nivel conjunto e nao serve para o comparativo por usina.
async function lerONS(deDia) {
  const m = new Map(); // 'AAAA-MM-DDTHH:MM' (borda esquerda, passo 30) -> { M1..M9 }
  const meses = new Set();
  const ini = new Date(deDia + 'T12:00:00Z');
  const fim = new Date();
  for (const d = new Date(ini); d <= fim; d.setUTCMonth(d.getUTCMonth() + 1)) {
    meses.add(d.getUTCFullYear() + '_' + String(d.getUTCMonth() + 1).padStart(2, '0'));
  }
  meses.add(fim.getUTCFullYear() + '_' + String(fim.getUTCMonth() + 1).padStart(2, '0'));
  let lidos = 0;
  for (const mo of [...meses].sort()) {
    let j;
    try { j = await leBlob('ons_irradiancia_' + mo + '.json'); }
    catch (e) { console.log('    ONS ' + mo + ': ' + e.message); continue; }
    if (!j || !Array.isArray(j.consolidado)) continue;
    lidos++;
    for (const rec of j.consolidado) {
      const p = TAG_ONS[rec.u];
      if (!p) continue;
      const chave = String(rec.ts).replace(' ', 'T').slice(0, 16);
      if (chave.slice(0, 10) < deDia) continue;
      const l = m.get(chave) || {};
      l[p] = (l[p] || 0) + (parseFloat(rec.gv) || 0) * 0.5; // MW medio em 30 min -> MWh
      m.set(chave, l);
    }
  }
  console.log('    ONS: ' + lidos + ' blobs mensais lidos · ' + m.size + ' instantes de 30 min');
  return m;
}

// ---- SCADA -------------------------------------------------------------------------------------
// A ORIGEM E MW: a planilha do supervisorio traz potencia amostrada de 5 em 5 min. A conversao para
// energia (P x 5/60) acontece na leitura do xlsx, entao o que chega aqui ja e MWh por intervalo.
// Converter de novo dividiria o SCADA por quatro.
function scadaParaMapa(sc, deDia, campoIntra, passoMin) {
  const m = new Map();
  const dias = Object.keys(sc[campoIntra] || {}).filter((d) => d >= deDia).sort();
  const n = 1440 / passoMin;
  for (const d of dias) {
    const dd = sc[campoIntra][d];
    for (const p of PARQUES) {
      const arr = dd[p];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length && i < n; i++) {
        if (arr[i] == null) continue;
        const t = i * passoMin;
        const chave = d + 'T' + String(Math.floor(t / 60)).padStart(2, '0')
          + ':' + String(t % 60).padStart(2, '0');
        const l = m.get(chave) || {};
        l[p] = (l[p] || 0) + arr[i];
        m.set(chave, l);
      }
    }
  }
  return m;
}

function scadaDiarioParaMapa(sc, deDia) {
  const m = new Map();
  for (const p of PARQUES) {
    const dd = (sc.diario || {})[p] || {};
    for (const d of Object.keys(dd)) {
      if (d < deDia || dd[d] == null) continue;
      const l = m.get(d) || {};
      l[p] = (l[p] || 0) + dd[d];
      m.set(d, l);
    }
  }
  return m;
}

// ---- agregacao de um passo fino para um passo maior --------------------------------------------
// Energia e aditiva, entao agregar e somar. Vale para o ONS (30 -> 60) e para o SCADA (15 -> 30/60).
function agrega(mapa, passoDestinoMin) {
  const out = new Map();
  for (const [chave, l] of mapa) {
    const d = chave.slice(0, 10);
    const hm = chave.slice(11, 16);
    const t = (+hm.slice(0, 2)) * 60 + (+hm.slice(3, 5));
    const b = Math.floor(t / passoDestinoMin) * passoDestinoMin;
    const k = d + 'T' + String(Math.floor(b / 60)).padStart(2, '0')
      + ':' + String(b % 60).padStart(2, '0');
    const o = out.get(k) || {};
    for (const p of PARQUES) if (l[p] != null) o[p] = (o[p] || 0) + l[p];
    out.set(k, o);
  }
  return out;
}

function agregaDia(mapa) {
  const out = new Map();
  for (const [chave, l] of mapa) {
    const d = chave.slice(0, 10);
    const o = out.get(d) || {};
    for (const p of PARQUES) if (l[p] != null) o[p] = (o[p] || 0) + l[p];
    out.set(d, o);
  }
  return out;
}

// ---- montagem da linha larga -------------------------------------------------------------------
// Prefixos curtos porque a chave se repete uma vez por linha: `o` ONS, `w` Way2, `s` SCADA.
const PREFIXO = { ons: 'o', way2: 'w', scada: 's' };
const NOME_FONTE = {
  ons: 'ONS · dados abertos',
  way2: 'Way2 · medidores de faturamento',
  scada: 'SCADA · supervisorio da usina',
};
const GRANDEZA_FONTE = {
  ons: 'geracao verificada',
  way2: 'energia ativa recebida',
  scada: 'energia ativa gerada',
};

function montaSerie(mapas, diario) {
  const chaves = new Set();
  for (const k of Object.keys(mapas)) for (const c of mapas[k].keys()) chaves.add(c);
  const serie = [];
  for (const c of [...chaves].sort()) {
    const iso = diario ? c + 'T00:00:00-03:00' : c + ':00-03:00';
    const l = { t: iso, ms: Date.parse(iso) };
    let algum = false;
    for (const fonte of Object.keys(mapas)) {
      const v = mapas[fonte].get(c);
      if (!v) continue;
      for (const p of PARQUES) {
        if (v[p] == null) continue;
        l[PREFIXO[fonte] + p.slice(1)] = r2(v[p]);
        algum = true;
      }
    }
    if (algum) serie.push(l);
  }
  return serie;
}

// Exporta as pecas puras para o ensaio poder exercita-las sem o segredo da API. O corpo principal
// so roda quando o arquivo e executado, nunca quando e importado.
module.exports = {
  PONTOS, PARQUES, TAG_ONS, PREFIXO, AMOSTRAS_DIA, RESOLUCOES,
  leBlob, lerONS, way2ParaMapa, way2DiarioParaMapa, diasPorBloco, somaDias,
  scadaParaMapa, scadaDiarioParaMapa, agrega, agregaDia, montaSerie, chaveBRT,
};

if (require.main !== module) return;

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) { console.error('ERRO: WAY2_TOKEN ausente.'); process.exit(1); }
  // 🔴 SETE DIAS, NAO TRES. Medido no ensaio de 23/08/2026: com janela de 3 dias o SCADA vinha
  // com ZERO baldes em todas as resolucoes — ele chega com ~3 dias de atraso (a planilha depende
  // da carga no SharePoint), entao a janela curta nunca o alcanca. O merge e por chave, entao uma
  // rodada mais larga simplesmente completa as linhas que ja existem quando a fonte lenta chega.
  const DIAS = Math.max(1, parseInt(process.env.DIAS || '7', 10) || 7);
  const FORCAR = /^(1|true|sim)$/i.test(process.env.FORCAR || '');
  const SO = process.env.SO != null && process.env.SO !== '' ? parseInt(process.env.SO, 10) : null;
  const alvos = SO != null ? RESOLUCOES.filter((x) => x.min === SO) : RESOLUCOES;
  if (!alvos.length) { console.error('ERRO: SO=' + SO + ' nao e uma resolucao conhecida.'); process.exit(1); }

  const hoje = diaBRT(0);
  const deDia = diaBRT(DIAS - 1);
  console.log('=== comparativo · reprocessando de ' + deDia + ' a ' + hoje + ' ===');

  console.log('  lendo fontes de apoio...');
  let scada = null;
  try { scada = await leBlob('scada_comparativo.json'); }
  catch (e) { console.log('    SCADA 15 min: ' + e.message); }
  let scada5 = null;
  try { scada5 = await leBlob('scada_5min.json'); }
  catch (e) { console.log('    SCADA 5 min: ' + e.message); }
  const onsFino = await lerONS(deDia);

  for (const res of alvos) {
    const diario = res.min === 0;
    const rotulo = diario ? 'diario' : res.min + ' min';
    console.log('\n  --- ' + res.blob + ' (' + rotulo + ') ---');

    // --- Way2 ---------------------------------------------------------------------------------
    const mWay2 = await buscaEmBlocos(
      deDia, hoje, diario ? 'UmDia' : INTERVALO_API[res.min], res.min, token, diario,
    );
    console.log('    Way2:  ' + mWay2.size + ' baldes');

    // --- SCADA --------------------------------------------------------------------------------
    let mScada = new Map();
    if (diario && scada) mScada = scadaDiarioParaMapa(scada, deDia);
    else if (res.min === 5 && scada5) mScada = scadaParaMapa(scada5, deDia, 'intra5', 5);
    else if (res.min === 15 && scada) mScada = scadaParaMapa(scada, deDia, 'intra15', 15);
    else if (res.min > 15 && scada) mScada = agrega(scadaParaMapa(scada, deDia, 'intra15', 15), res.min);
    console.log('    SCADA: ' + mScada.size + ' baldes'
      + (res.min === 5 && !scada5 ? '  (o blob de 5 min ainda nao existe)' : ''));

    // --- ONS ----------------------------------------------------------------------------------
    // Abaixo de 30 min o ONS nao entra. Repartir a meia hora em dois ou seis pedacos iguais
    // desenharia um patamar que a fonte nunca mediu, e ele apareceria como uma curva plausivel —
    // que e o pior modo de errar. Ausencia declarada e melhor que interpolacao disfarcada.
    let mOns = new Map();
    if (diario) mOns = agregaDia(onsFino);
    else if (res.min === 30) mOns = onsFino;
    else if (res.min === 60) mOns = agrega(onsFino, 60);
    console.log('    ONS:   ' + mOns.size + ' baldes'
      + (res.min && res.min < 30 ? '  (a fonte nao publica nesta resolucao)' : ''));

    const fontes = { way2: mWay2, scada: mScada, ons: mOns };
    const presentes = Object.keys(fontes).filter((f) => fontes[f].size > 0);
    if (!presentes.includes('way2')) {
      throw new Error(res.blob + ': a Way2 nao trouxe nada. Ela e o arbitro das tres — sem ela o '
        + 'arquivo nao presta, e publicar so as outras duas esconderia a falha.');
    }
    const mapas = {};
    presentes.forEach((f) => { mapas[f] = fontes[f]; });

    const novas = montaSerie(mapas, diario);
    console.log('    montadas ' + novas.length + ' linhas de ' + presentes.length
      + ' fontes (' + presentes.join(', ') + ')');

    // --- merge com o que ja esta no ar ---------------------------------------------------------
    let antigo = null;
    try { antigo = await leBlob(res.blob); }
    catch (e) { throw new Error('nao consegui ler ' + res.blob + ': ' + e.message); }
    const porChave = new Map();
    for (const l of ((antigo && antigo.serie) || [])) porChave.set(l.t, l);
    const antes = porChave.size;
    const ultimoAntes = antes ? [...porChave.keys()].sort().pop() : null;
    for (const l of novas) porChave.set(l.t, l);

    // --- poda pela janela ----------------------------------------------------------------------
    if (!diario) {
      const corte = Date.now() - res.dias * 86400000;
      for (const [k, l] of porChave) if (l.ms < corte) porChave.delete(k);
    }

    const serie = [...porChave.values()].sort((a, b) => a.ms - b.ms);

    // --- poda de esquema -----------------------------------------------------------------------
    // Se um dia o blob de 5 min ganhou coluna de ONS por engano, ela some aqui em vez de ficar
    // pintando zero na tela.
    const permitido = new Set(['t', 'ms']);
    for (const f of presentes) for (const p of PARQUES) permitido.add(PREFIXO[f] + p.slice(1));
    let podadas = 0;
    for (const l of serie) {
      for (const k of Object.keys(l)) if (!permitido.has(k)) { delete l[k]; podadas++; }
    }
    if (podadas) console.log('    ' + podadas + ' chaves de esquema antigo podadas');

    const ultimo = serie.length ? serie[serie.length - 1].t : null;

    // A guarda olha contagem E ultimo instante — a contagem sozinha nao muda quando o dia corrente
    // cresce dentro do mesmo dia, e o dado mais recente nunca subiria. E `podadas` entra porque
    // uma limpeza que a guarda engole e uma limpeza que nunca acontece.
    if (serie.length === antes && ultimo === ultimoAntes && !podadas && !FORCAR) {
      console.log('    sem mudanca — nao regrava (versao a toa e ruido)');
      continue;
    }
    if (antes && serie.length < antes * 0.9 && !FORCAR) {
      throw new Error(res.blob + ': a serie encolheria de ' + antes + ' para ' + serie.length
        + ' linhas. Se e proposital, FORCAR=1.');
    }

    // --- guarda de granularidade ---------------------------------------------------------------
    // Um dia fechado nao pode ter MAIS baldes do que a resolucao comporta. Sem isto, publicar uma
    // resolucao com o conteudo de outra passaria calado — e o painel diria "15 min" mostrando 5.
    if (!diario && serie.length) {
      const porDia = {};
      for (const l of serie) {
        const d = l.t.slice(0, 10);
        porDia[d] = (porDia[d] || 0) + 1;
      }
      const ruins = Object.keys(porDia).filter((d) => d < hoje && porDia[d] > AMOSTRAS_DIA[res.min]);
      if (ruins.length) {
        throw new Error(res.blob + ': ' + ruins.length + ' dia(s) com MAIS baldes do que a '
          + 'resolucao comporta (ex.: ' + ruins[0] + ' com ' + porDia[ruins[0]] + ' de '
          + AMOSTRAS_DIA[res.min] + '). Isso e granularidade trocada, nao dado faltando.');
      }
    }

    const obj = {
      gerado: new Date().toISOString(),
      resolucao_min: diario ? null : res.min,
      granularidade: rotulo,
      janela_dias: diario ? null : res.dias,
      nota: res.nota,
      unidade: 'MWh por intervalo',
      fontes: presentes.map((f) => ({
        chave: PREFIXO[f], nome: NOME_FONTE[f], grandeza: GRANDEZA_FONTE[f],
      })),
      fontes_ausentes: ['ons', 'way2', 'scada'].filter((f) => !presentes.includes(f)).map((f) => ({
        chave: PREFIXO[f],
        nome: NOME_FONTE[f],
        motivo: f === 'ons' && res.min && res.min < 30
          ? 'O ONS publica em 30 minutos; abaixo disso nao ha medicao para repartir.'
          : 'Sem dado disponivel nesta janela.',
      })),
      colunas: 'o<N> = ONS, w<N> = Way2, s<N> = SCADA, com N de 1 a 9 (a usina). Coluna ausente '
        + 'significa que aquela fonte nao tem valor naquele instante.',
      rotulo_de_tempo: 'O instante e o INICIO do intervalo: o valor em T cobre de T a T mais '
        + (diario ? '1 dia' : res.min + ' min') + '. O operador nacional e o supervisorio ja '
        + 'rotulam assim; a serie do medidor rotula pelo fim e foi deslocada um intervalo na '
        + 'geracao deste arquivo.',
      complexo: 'Nao ha coluna de complexo: energia e aditiva e a soma das usinas selecionadas e '
        + 'feita na leitura. Somar usinas que uma fonte nao tem produziria divergencia de '
        + 'cobertura disfarcada de divergencia de medicao.',
      serie,
    };

    const bytes = await grava(res.blob, obj);
    console.log('    gravado: ' + serie.length + ' linhas · ' + Math.round(bytes / 1024) + ' KB'
      + (process.env.LOCAL_OUT ? ' (local, sem compressao)' : ' comprimido'));
  }
  console.log('\n=== FIM ===');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
