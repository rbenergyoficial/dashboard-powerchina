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
 *   must_5min.json    5 min ·  30 dias  ·  8.640 linhas   — o mes, no detalhe do medidor
 *   must_15min.json  15 min ·  90 dias  ·  8.640 linhas   — o trimestre na base CONTRATUAL
 *   must_30min.json  30 min · 180 dias  ·  8.640 linhas   — o semestre
 *   must_60min.json  60 min · 365 dias  ·  8.760 linhas   — o ano inteiro
 *
 * As quatro janelas saem do MESMO teto de linhas (~8.700, medido em 1,1 MB por arquivo), e nao de
 * um numero escolhido a esmo. Ate 22/08/2026 o de 5 min gastava 2.016 de um orcamento de 8.700:
 * cobria 7 dias quando podia cobrir 30, e era essa folga desperdicada que deixava o grafico vazio
 * quando alguem pedia um periodo maior do que a cobertura.
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
 *      DIAS (quantos dias para tras processar, default 2; o dia de HOJE entra sempre) · FORCAR=1 (reprocessa dia ja presente) ·
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
// ══ OS DOIS SENTIDOS DO MEDIDOR, medidos em 23/08/2026 ═══════════════════════════════════════
// O medidor expoe tres registros. Qual e geracao e qual e consumo NAO se decide pelo nome do
// canal — o dado decide, e sem empate, porque uma usina fotovoltaica tem assinatura inequivoca:
//
//   canal       media 10h-15h   media 01h-04h   maximo     o que e
//   DematRec         89,67 MW        0,000 MW   282,8 MW   GERACAO   (zero de madrugada)
//   DematDel          0,00 MW        0,956 MW     6,0 MW   CONSUMO   (zero enquanto gera)
//   Demat            89,67 MW        0,000 MW   282,8 MW   IDENTICO a DematRec
//
// 🔴 `Demat` NAO E A LIQUIDA NESTES MEDIDORES, ao contrario do que eu supus. No medidor de
// GERACAO (ponto 6233) ela e: vai a -0,745 MW de madrugada, medido. Aqui nao — o ensaio comparou
// as duas leituras em 2.430 pontos:
//
//     H1  Demat = geracao - consumo   ->  erro maximo 1,5000 MW
//     H2  Demat = geracao             ->  erro maximo 0,0000 MW
//
// Sao o MESMO numero. O medidor de MUST nao faz netting: ele registra os dois sentidos separados,
// e `Demat` e o sentido de injecao. Por isso a coluna `<parque>` que os paineis leem desde sempre
// JA E a geracao — publicar um `_g` ao lado seria a mesma coluna duas vezes.
//
// ⚠️ A suposicao virou GUARDA: se um dia o medidor passar a netar, o job falha em vez de rotular
// consumo de geracao em silencio. `DematRec` continua sendo buscado so para essa conferencia.
const GRANDEZAS = ['Demat', 'DematRec', 'DematDel'];
// sufixo da coluna no blob. '_v' e de VERIFICACAO: entra na montagem, e conferido e some antes de
// gravar — nao vai para o blob.
const SUFIXO = { Demat: '', DematRec: '_v', DematDel: '_c' };
// Custo de publicar o consumo: MEDIDO depois, o must_15min foi de 212 para 277 KB — +31%, e nao
// os +4% que a simulacao previu. 🔴 A simulacao usou valor CONSTANTE, e coluna constante comprime
// a quase nada; o consumo real varia balde a balde. Simulacao com valor sintetico mede a
// estrutura, nao a ENTROPIA — e e a entropia que o compressor cobra.
//
// ⚠️ E o custo que quase derrubou a recarga nao foi o de bytes, foi o de TEMPO: pedir tres
// grandezas por chamada levou o custo de ~2 s para ~7,7 s por chamada, e a carga historica
// completa passou de ~45 para ~85 min. Por isso ela e feita em fatias (`SO`).

// 🔴 CADA RESOLUCAO E PEDIDA JA INTEGRALIZADA A FONTE, com o nome que a API entende. Ate
// 22/08/2026 o gerador pedia so CincoMinutos e agregava o resto por conta propria, por borda
// ESQUERDA — e a Way2 rotula pela borda DIREITA. O balde saia deslocado 5 min do quarto de hora
// que o ONS afere, e isso produzia ultrapassagem que nao existe: nos cinco dias auditados, 10
// intervalos acima de 100% pelo balde caseiro contra ZERO pelo quarto de hora da fonte.
// Os nomes foram medidos contra a API (audita-must-intervalos.js); nome que ela nao entende
// devolve HTTP 400, entao errar aqui falha alto em vez de publicar granularidade trocada.
const INTERVALO_API = { 5: 'CincoMinutos', 15: 'QuinzeMinutos', 30: 'TrintaMinutos', 60: 'UmaHora' };
const AMOSTRAS_DIA = { 5: 288, 15: 96, 30: 48, 60: 24 };

const RESOLUCOES = [
  { min: 5, dias: 30, blob: 'must_5min.json',
    nota: 'Detalhe do medidor. Base de DIAGNOSTICO, nao contratual: o pico instantaneo de 5 min '
      + 'passa da outorga do parque com frequencia por transitorio de medicao.' },
  { min: 15, dias: 90, blob: 'must_15min.json',
    nota: 'Base CONTRATUAL. E nesta integralizacao que o pico do dia e apurado contra o MUST.' },
  { min: 30, dias: 180, blob: 'must_30min.json',
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
const query = (ini, fim, intervalo) => 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZAS.join(',')
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=' + intervalo
  + '&medicao-datainicio=' + ini + '&medicao-datafim=' + fim
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

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

// Converte o que a fonte JA ENTREGOU integralizado no formato largo do blob. Nao agrega nada:
// a agregacao caseira era a origem do defeito de alinhamento.
//
// 🔴 O ROTULO DE TEMPO E O FIM DO INTERVALO. Medido em 22/08/2026 contra a API: pedindo um dia,
// a serie de 5 min vai de `DIA 00:05` a `DIA+1 00:00`, a de 15 min de `DIA 00:15` a `DIA+1 00:00`,
// e a de 1 h de `DIA 01:00` a `DIA+1 00:00`. Ou seja, o valor rotulado T cobre (T-passo, T], e o
// ULTIMO balde de cada dia carrega a data do dia SEGUINTE.
//
// Isso e o que o ONS afere, e por isso o rotulo vai para o blob COMO A FONTE ENTREGA — converter
// para borda esquerda seria reintroduzir uma convencao caseira entre a medicao e o painel.
function montaLinhas(resp) {
  const linhas = new Map();   // instante ISO -> { t, ms, M1..M9, M1_g.., M1_c.., Complexo* }
  for (const g of GRANDEZAS) {
    const suf = SUFIXO[g];
    for (const id of IDS) {
      const parque = PONTOS[id].parque;
      const s = (resp.dados || []).find(x => String(x.pontoId) === String(id)
        && x.nomeGrandeza === g);
      for (const v of (s ? s.valores || [] : [])) {
        if (v.valor == null) continue;
        // a API devolve 'AAAA-MM-DDTHH:MM:SS' em hora local de Brasilia, sem offset
        const iso = String(v.data).slice(0, 19);
        const l = linhas.get(iso) || { t: iso + '-03:00', ms: Date.parse(iso + '-03:00') };
        l[parque + suf] = r(v.valor / 1000);   // a API devolve kW; o contrato e em MW
        linhas.set(iso, l);
      }
    }
  }
  // O COMPLEXO E A SOMA SIMULTANEA, balde a balde — nao a soma dos picos de cada parque, que
  // aconteceriam em horarios diferentes e dariam um numero que nenhum medidor leu.
  // GUARDA DE TUDO-OU-NADA: balde sem os nove parques fica sem Complexo. Somar oito subdeclara a
  // demanda simultanea, e o erro seria maior justamente na hora do pico.
  //
  // ⚠️ A guarda vale POR GRANDEZA, e nao uma vez so: um medidor pode entregar a liquida e falhar
  // no canal de consumo. Somar oito consumos e chamar de Complexo repetiria o mesmo defeito num
  // campo diferente — e ali ele seria ainda mais dificil de notar, porque o consumo e pequeno.
  for (const l of linhas.values()) {
    for (const suf of Object.values(SUFIXO)) {
      const vs = PARQUES.map(p => l[p + suf]).filter(v => v != null);
      if (vs.length === PARQUES.length) l['Complexo' + suf] = r(vs.reduce((a, b) => a + b, 0));
    }
  }
  // 🔴 A GUARDA QUE SUBSTITUI A SUPOSICAO: `Demat` tem de continuar sendo exatamente a geracao.
  // Medido em 2.430 pontos com erro 0,0000 — entao qualquer divergencia aqui e mudanca de
  // comportamento da fonte, nao ruido, e publicar por cima disso significaria rotular consumo de
  // geracao sem que nada acusasse.
  for (const l of linhas.values()) {
    for (const p of PARQUES) {
      const a = l[p], b = l[p + '_v'];
      if (a == null || b == null) continue;
      if (Math.abs(a - b) > 0.001)
        throw new Error('em ' + l.t + ' o parque ' + p + ' tem Demat=' + a + ' e DematRec=' + b
          + ' — a fonte deixou de tratar Demat como o sentido de injecao, e a coluna `<parque>`'
          + ' que os paineis leem como geracao passaria a significar outra coisa');
    }
  }
  // a coluna de verificacao nao vai para o blob
  for (const l of linhas.values()) for (const p of PARQUES.concat(['Complexo'])) delete l[p + '_v'];
  return [...linhas.values()].sort((a, b) => a.ms - b.ms);
}

// O dia D cobre (D 00:00, D+1 00:00] — o mesmo recorte que a fonte usa. Comparar por EPOCH, e nao
// por prefixo de texto, e o que impede apagar o balde 00:00 que pertence ao dia anterior.
const faixaDoDia = dia => ({
  de: Date.parse(dia + 'T00:00:00-03:00'),
  ate: Date.parse(dia + 'T00:00:00-03:00') + 86400000,
});

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

async function grava(nome, obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    require('fs').writeFileSync(process.env.LOCAL_OUT + nome, json); return json.length;
  }
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
  await cont.getBlockBlobClient(nome).upload(gz, gz.length,
    { blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip',
      blobCacheControl: 'public, max-age=300' } });
  return gz.length;
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
    const chaves = [...m.keys()].sort();
    estado.set(res.min, { mapa: m, antes: m.size,
      ultimoAntes: chaves.length ? chaves[chaves.length - 1] : '' });
  }

  // o dia mais antigo que QUALQUER alvo ainda quer; os outros podam depois
  const maxDias = Math.max(...alvos.map(x => x.dias));
  const limite = Math.min(DIAS, maxDias);
  let buscados = 0, vazios = 0;

  // 🔴 COMECA EM off=0, O DIA DE HOJE. Ate 22/08/2026 o loop comecava em 1 e o dia corrente nunca
  // era coletado: o blob terminava sempre na meia-noite passada, e quem pedisse "ultimas 24 horas"
  // via um painel vazio. O dia de hoje e PARCIAL por natureza e por isso e sempre reprocessado —
  // ele cresce a cada rodada, preenchendo conforme as leituras chegam.
  // Uma chamada por (dia, resolucao). Ate 22/08/2026 era uma chamada por dia servindo as quatro,
  // porque a agregacao era caseira; com cada resolucao vindo pronta da fonte, cada uma tem de ser
  // pedida. Custa mais chamadas por dia e MENOS no total da carga historica, porque cada resolucao
  // so busca os dias da janela dela: 30 + 90 + 180 + 365 = 665, contra 365 x 4 se todas fossem ao
  // ano inteiro.
  for (let off = 0; off <= limite; off++) {
    const dia = diaBRT(off);
    const hoje = off === 0;
    const { de, ate } = faixaDoDia(dia);
    // so busca se o alvo precisa deste dia: dentro da janela dele e ainda ausente. O dia corrente
    // nunca conta como "ja presente", porque o que esta la esta incompleto.
    const precisa = alvos.filter(res => off <= res.dias
      && (hoje || FORCAR
        || ![...estado.get(res.min).mapa.values()].some(l => l.ms > de && l.ms <= ate)));
    if (!precisa.length) continue;

    const conta = [];
    let algum = 0;
    for (const res of precisa) {
      let resp;
      try {
        resp = await comRetry(query(dia + 'T00:00:00', dia + 'T23:59:59',
          INTERVALO_API[res.min]), token);
      } catch (e) {
        console.log('  ' + dia + ' ' + res.min + 'min  ERRO ' + e.message.slice(0, 50));
        continue;
      }
      buscados++;
      const linhas = montaLinhas(resp);
      // GUARDA DE GRANULARIDADE: um dia fechado tem de vir com o numero de amostras da resolucao
      // pedida. Se a API entender o intervalo de outro jeito, isso aparece aqui em vez de virar
      // um blob com o rotulo de uma resolucao e o conteudo de outra.
      if (!hoje && linhas.length && linhas.length !== AMOSTRAS_DIA[res.min])
        throw new Error(dia + ' em ' + res.min + 'min voltou com ' + linhas.length
          + ' amostras, esperado ' + AMOSTRAS_DIA[res.min]
          + ' — a fonte mudou a granularidade e o blob nao pode ser gravado assim');
      const st = estado.get(res.min);
      // o dia corrente e sempre reprocessado; a exclusao e por EPOCH, para nao apagar o balde
      // 00:00 que pertence ao dia ANTERIOR
      if (hoje) for (const [k, l] of [...st.mapa.entries()])
        if (l.ms > de && l.ms <= ate) st.mapa.delete(k);
      for (const l of linhas) st.mapa.set(l.t, l);
      algum += linhas.length;
      conta.push(res.min + 'min:' + linhas.length);
      await sleep(600);
    }
    if (!algum) { vazios++; console.log('  ' + dia + '  sem valor em nenhum ponto'); continue; }
    if (off % 20 === 0 || off <= 3) console.log('  ' + dia + '  ' + conta.join(' · '));
  }

  console.log('\ndias buscados na API: ' + buscados + (vazios ? ' (' + vazios + ' vazios)' : ''));
  for (const res of alvos) {
    const st = estado.get(res.min);
    // PODA o que saiu da janela: sem isto o blob de 5 min cresceria para o ano inteiro e a pagina
    // passaria a baixar 25 MB para desenhar uma semana
    // por EPOCH, pela mesma razao da exclusao do dia corrente: o balde 00:00 pertence ao dia
    // anterior, e cortar por prefixo de texto o classificaria no dia errado
    const corte = faixaDoDia(diaBRT(res.dias)).de;
    // 🔴 COLUNA REMOVIDA DO GERADOR FICA PENDURADA EM LINHA ANTIGA. O blob e acumulativo: linha
    // que a rodada nao reprocessa mantem as chaves que tinha. Em 23/08/2026 uma versao
    // intermediaria publicou `<parque>_g`, e as linhas daquele dia ficaram com a coluna mesmo
    // depois de o gerador parar de produzi-la — a mesma forma do `Totalizador` que assombrou o
    // painel de saude: campo que o gerador nao entrega mais e que o painel continua achando.
    //
    // Podar na gravacao faz o ESQUEMA do blob ser sempre o do gerador de hoje, sem depender de
    // uma recarga com FORCAR para limpar o passado.
    const permitido = new Set(['t', 'ms']);
    for (const e of PARQUES.concat(['Complexo']))
      for (const suf of Object.values(SUFIXO)) if (suf !== '_v') permitido.add(e + suf);
    let podadas = 0;
    for (const l of st.mapa.values())
      for (const k of Object.keys(l)) if (!permitido.has(k)) { delete l[k]; podadas++; }
    if (podadas) console.log('  ' + res.blob + ': ' + podadas + ' chaves de esquema antigo podadas');
    const serie = [...st.mapa.values()].filter(l => l.ms > corte).sort((a, b) => a.ms - b.ms);

    // GUARDA ANTI-REGRESSAO: rodada que nao mudou nada NAO regrava. Sem isto, uma janela em que a
    // API responde vazia produz um blob identico com data nova — ruido que esconde o momento em
    // que a coleta parou de funcionar.
    const ultimo = serie.length ? serie[serie.length - 1].t : '';
    // ⚠️ PODAR NAO MUDA CONTAGEM NEM ULTIMO INSTANTE, entao a guarda calaria a gravacao e o
    // esquema antigo sobreviveria — exatamente o que aconteceu com o remendo retroativo do `ms`.
    // Uma limpeza que a guarda engole e uma limpeza que nunca acontece.
    if (serie.length === st.antes && ultimo === st.ultimoAntes && !FORCAR && !podadas) {
      console.log('  ' + res.blob.padEnd(17) + ' nada novo (' + st.antes + ' linhas) — NAO regravado');
      continue;
    }
    // o balde 00:00 pertence ao dia ANTERIOR (o rotulo e o fim do intervalo), entao a contagem
    // de dias desconta um passo antes de olhar a data
    const dias = new Set(serie.map(l => new Date(l.ms - res.min * 60000).toISOString().slice(0, 10)));
    const out = {
      gerado_em: new Date().toISOString(),
      resolucao_min: res.min, janela_dias: res.dias,
      fonte: 'Way2 PIM, pontos 6380-6388 (medidores dedicados do MUST), pedida a API JA '
        + 'INTEGRALIZADA na resolucao deste arquivo (' + INTERVALO_API[res.min] + '). A API '
        + 'devolve kW; aqui vai em MW.',
      colunas: '<parque> = demanda de GERACAO (o sentido que o contrato de MUST limita). '
        + '<parque>_c = demanda de CONSUMO dos servicos auxiliares, que nao tem contrato. '
        + 'O medidor nao neta: registra os dois sentidos separados, e por isso <parque> nunca '
        + 'e negativo. Os dois so se sobrepoem no nascer e no por do sol, quando a transicao cabe '
        + 'dentro do intervalo de medicao.',
      rotulo_de_tempo: 'O instante e o FIM do intervalo: o valor em T cobre (T menos '
        + res.min + ' min, T]. E a convencao da fonte e do ONS, e o ultimo balde de cada dia '
        + 'carrega a data do dia seguinte (00:00).',
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
      + String(dias.size).padStart(3) + ' dias · ' + Math.round(t / 1024) + ' KB comprimido ('
      + Math.round(JSON.stringify(out).length / 1024) + ' KB cru)'
      + (st.antes ? '  (+' + (serie.length - st.antes) + ')' : ''));
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
