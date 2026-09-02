// gen-scada-intake.js — a INTAKE do `scada-raw`, hoje feita pelo Power Automate.
//
// 🔴 POR QUE ESTE ARQUIVO EXISTE
// O container `scada-raw` e alimentado pelo fluxo "SCADA SharePoint para Blob", que usa conectores
// Premium (SharePoint e Azure Blob). Ele e a entrada de QUATRO paginas: SCADA/Solarimetria
// (`gen-scada`, `gen-irradiancia`), Transformadores (`gen-trafo`) e Perdas de PV (`gen-perdas`).
// Sem ele, essas paginas param de receber dado novo — e param em silencio, porque os geradores
// continuam rodando e republicando o que ja tinham.
//
// 🔴 O CONTRATO DE NOME E CARGA, NAO ENFEITE — e foi medido nos consumidores, um a um:
//
//   gen-scada        `.xlsx`  exige  /^(\d+)_/  no basename. Ele ORDENA por esse numero, do mais
//                             antigo ao mais novo, e o ULTIMO vence. Sem prefixo, o arquivo e
//                             lido com id 0 e perde para qualquer outro.
//   gen-irradiancia  o ramo do sensor `IRR` casa  /_IRR_(\d{8}_\d{6})\.csv$/  — o UNDERSCORE
//                             antes do `IRR` so existe porque ha prefixo. Nome limpo
//                             (`IRR_2026...csv`) NAO casa e o arquivo e ignorado em silencio.
//   IIRR_ e IRR_GERAL_        casam em qualquer posicao; prefixo tolerado.
//   gen-trafo, gen-perdas     carimbo ancorado no FIM; prefixo tolerado.
//
// Ou seja: um coletor que gravasse o nome limpo quebraria duas familias sem erro nenhum. Por isso
// o prefixo continua, e por isso existe a guarda `casaConsumidor()` — ela reprova ANTES de subir.
//
// ⚠️ O prefixo tem de ser NUMERICO e MONOTONICO. O legado usa o id do item do SharePoint (5
// digitos); o carimbo `AAAAMMDDHHMMSS` e sempre maior, entao ordena depois de todo o legado por
// construcao — e continua crescendo. Trocar por qualquer coisa nao-monotonica reintroduz a
// armadilha que o proprio `gen-scada` documenta (o dia em que os ids passarem de 99999).
//
// FONTES
//   FONTE=pasta   PASTA=<caminho>   le de uma pasta local — e o modo EXERCITAVEL, e o que o
//                                   ensaio usa. A logica de nome, dedup e guarda e a mesma.
//   FONTE=graph                     le do SharePoint pelo Microsoft Graph. Precisa de
//                                   GRAPH_TENANT, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET,
//                                   SP_SITE e SP_PASTA.
//                                   🔴 ESTE RAMO AINDA NAO FOI EXERCITADO NENHUMA VEZ — nao ha
//                                   credencial. Ele esta isolado de proposito: quando a
//                                   credencial existir, so ele precisa ser provado.
//
// DESTINO
//   (padrao)      DADOS_STORAGE + RAW_CONTAINER=scada-raw
//   LOCAL_OUT=dir grava em pasta, sem tocar em producao (ensaio)
'use strict';
const fs = require('fs');
const path = require('path');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const LOCAL_OUT = process.env.LOCAL_OUT || '';
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');

// ── o contrato de nome, escrito uma vez ──────────────────────────────────────────────────────
// Cada entrada e um consumidor real do container. `exige` e a expressao que ELE usa; se o nome
// que vamos gravar nao casar nenhuma, o arquivo entraria no container para ser ignorado — e e
// isso que a guarda impede.
const CONSUMIDORES = [
  { quem: 'gen-scada',       quando: /\.xlsx$/i,                 exige: /^(\d+)_/ },
  { quem: 'gen-irradiancia', quando: /_?IIRR_\d{8}_\d{6}\.csv$/i, exige: /IIRR_(\d{8}_\d{6})\.csv$/i },
  { quem: 'gen-irradiancia', quando: /_?IRR_GERAL_\d{8}_\d{6}\.csv$/i, exige: /IRR_GERAL_(\d{8}_\d{6})\.csv$/i },
  { quem: 'gen-irradiancia', quando: /(^|_)IRR_\d{8}_\d{6}\.csv$/i, exige: /_IRR_(\d{8}_\d{6})\.csv$/i },
  { quem: 'gen-trafo',       quando: /Trafo_\d{8}_\d{6}\.csv$/i,  exige: /Trafo_(\d{8})_(\d{6})\.csv$/i },
  { quem: 'gen-perdas',      quando: /M\d{2}_\d{8}_\d{6}\.csv$/i, exige: /M(\d{2})_(\d{8})_\d{6}\.csv$/i },
];

// ⚠️ a ordem importa: `IIRR_` e `IRR_GERAL_` tem de ser testados ANTES de `IRR_`, senao o terceiro
//    padrao os captura. Os tres nomes se parecem de proposito e ja custaram uma correcao ao
//    gen-irradiancia — a ordem aqui e a mesma que ele usa.
function consumidorDe(original) {
  for (const c of CONSUMIDORES) if (c.quando.test(original)) return c;
  return null;
}

function casaConsumidor(nomeFinal, original) {
  const c = consumidorDe(original);
  if (!c) return { ok: false, motivo: 'nenhum consumidor reconhece este nome' };
  if (!c.exige.test(nomeFinal)) {
    return { ok: false, motivo: 'o ' + c.quem + ' NAO casaria "' + nomeFinal + '"' };
  }
  return { ok: true, quem: c.quem };
}

// carimbo numerico, monotonico e sempre maior que o id do SharePoint (5 digitos)
function carimboDe(dt) {
  const d = new Date(dt);
  const p = (n, k) => String(n).padStart(k, '0');
  return p(d.getUTCFullYear(), 4) + p(d.getUTCMonth() + 1, 2) + p(d.getUTCDate(), 2)
    + p(d.getUTCHours(), 2) + p(d.getUTCMinutes(), 2) + p(d.getUTCSeconds(), 2);
}

function nomeFinal(original, dt) { return carimboDe(dt) + '_' + original; }

// ── destino ──────────────────────────────────────────────────────────────────────────────────
async function abreDestino() {
  if (LOCAL_OUT) {
    fs.mkdirSync(LOCAL_OUT, { recursive: true });
    return {
      lista: async () => fs.readdirSync(LOCAL_OUT),
      poe: async (nome, buf) => fs.writeFileSync(path.join(LOCAL_OUT, nome), buf),
    };
  }
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE ausente (ou use LOCAL_OUT para ensaio)');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(conn).getContainerClient(RAW_CONTAINER);
  return {
    lista: async () => { const o = []; for await (const b of c.listBlobsFlat()) o.push(b.name); return o; },
    poe: async (nome, buf) => { await c.getBlockBlobClient(nome).upload(buf, buf.length); },
  };
}

// ── fontes ───────────────────────────────────────────────────────────────────────────────────
async function daPasta() {
  const dir = process.env.PASTA;
  if (!dir) throw new Error('FONTE=pasta exige PASTA=<caminho>');
  return fs.readdirSync(dir).filter((f) => /\.(csv|xlsx)$/i.test(f)).map((f) => {
    const p = path.join(dir, f);
    return { original: f, dt: fs.statSync(p).mtime.toISOString(), leia: () => fs.readFileSync(p) };
  });
}

// ── o SharePoint de verdade, LIDO do fluxo em 02/09/2026 ────────────────────────────────────
// O stub anterior se recusava a escrever este ramo "para nao supor caminho". O caminho deixou de
// ser suposicao: foi lido do gatilho do fluxo "SCADA SharePoint para Blob", que e quem alimenta o
// container hoje.
//
//   site       https://powerchinabr.sharepoint.com/sites/POWERCHINA
//   biblioteca Documentos
//   pasta      /Documentos Compartilhados/1.OPERACAO E MANUTENCAO - O&M - .../11 - Dados_Scada_PWC
//   conexao    francisco.barros@powerchina.com.br
//
// 🔴 O TENANT E O DA POWERCHINA (`powerchinabr`), NAO O NOSSO — e isso decide tudo: o registro de
//    aplicativo tem de existir LA, e a permissao exige consentimento de administrador do tenant
//    deles. Nao se resolve do nosso lado. Ver `SCADA_INTAKE.md`.
//
// ⚠️ RAMO AINDA NAO EXERCITADO: sem credencial ele nem e chamado. Nome, dedup e guarda ja estao
//    provados pelo modo `pasta`, entao o que precisa de prova no dia da credencial e SO a leitura.
const GRAPH_HOST = 'graph.microsoft.com';
const SP_SITE_PADRAO = 'powerchinabr.sharepoint.com:/sites/POWERCHINA';
const SP_PASTA_PADRAO = '/Documentos Compartilhados/1.OPERAÇÃO E MANUTENÇÃO - O&M - 運作與維護'
  + '/01 - OPERAÇÃO - 运行记录/11 - Dados_Scada_PWC';

function graphGet(caminho, token, bruto) {
  const https = require('https');
  return new Promise((ok, ko) => {
    const req = https.get({ host: GRAPH_HOST, path: '/v1.0' + caminho, family: 4,
      headers: { Authorization: 'Bearer ' + token }, timeout: 120000 }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(ch);
        if (res.statusCode >= 300) {
          return ko(new Error('Graph HTTP ' + res.statusCode + ' em ' + caminho + ' · '
            + buf.toString('utf8').slice(0, 240)));
        }
        ok(bruto ? buf : JSON.parse(buf.toString('utf8')));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout no Graph em ' + caminho)));
    req.on('error', ko);
  });
}

function tokenGraph() {
  const https = require('https');
  const corpo = new URLSearchParams({
    client_id: process.env.GRAPH_CLIENT_ID,
    client_secret: process.env.GRAPH_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  }).toString();
  return new Promise((ok, ko) => {
    const r = https.request({ host: 'login.microsoftonline.com', family: 4,
      path: '/' + process.env.GRAPH_TENANT + '/oauth2/v2.0/token', method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(corpo) } }, (res) => {
      const ch = [];
      res.on('data', (c) => ch.push(c));
      res.on('end', () => {
        const t = Buffer.concat(ch).toString('utf8');
        if (res.statusCode !== 200) {
          return ko(new Error('token HTTP ' + res.statusCode + ' · ' + t.slice(0, 240)));
        }
        ok(JSON.parse(t).access_token);
      });
    });
    r.on('error', ko);
    r.write(corpo);
    r.end();
  });
}

async function doGraph() {
  const falta = ['GRAPH_TENANT', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET']
    .filter((k) => !process.env[k]);
  if (falta.length) throw new Error('FONTE=graph exige: ' + falta.join(', '));

  const site = process.env.SP_SITE || SP_SITE_PADRAO;
  const pasta = process.env.SP_PASTA || SP_PASTA_PADRAO;

  const token = await tokenGraph();
  const s = await graphGet('/sites/' + site, token);
  console.log('  site: ' + (s.displayName || s.name));

  // 🔴 Cada segmento vai por `encodeURIComponent`. A pasta tem acento E ideograma; montar a URL
  //    por concatenacao crua devolve 400, e a mensagem do Graph parece dizer que a pasta nao
  //    existe — que e o diagnostico errado.
  const rel = pasta.split('/').filter(Boolean).map(encodeURIComponent).join('/');

  const itens = [];
  let url = '/sites/' + s.id + '/drive/root:/' + rel + ':/children?$top=200';
  while (url) {
    const p = await graphGet(url, token);
    for (const it of p.value || []) if (it.file) itens.push(it);
    // ⚠️ Paginacao obrigatoria: a pasta acumula um arquivo por dia por parque. Sem seguir o
    //    `@odata.nextLink` a coleta para na primeira pagina — em silencio, com cara de sucesso.
    url = p['@odata.nextLink'] ? p['@odata.nextLink'].replace(/^https:\/\/[^/]+\/v1\.0/, '') : null;
  }
  console.log('  ' + itens.length + ' arquivo(s) na pasta');
  if (!itens.length) {
    throw new Error('a pasta respondeu VAZIA. Ou o caminho mudou, ou a permissao alcanca o site e '
      + 'nao a pasta — nos dois casos, publicar nada seria pior que falhar aqui');
  }

  return itens.map((it) => ({
    original: it.name,
    dt: it.lastModifiedDateTime,
    // Leitura preguicosa: quem decide o que baixar e a deduplicacao, depois de comparar com o que
    // ja esta no container. Baixar tudo a cada rodada traria a biblioteca inteira.
    leia: () => graphGet('/sites/' + s.id + '/drive/items/' + it.id + '/content', token, true),
  }));
}

// ── principal ────────────────────────────────────────────────────────────────────────────────
// ⚠️ so roda quando chamado direto: o ensaio importa este arquivo para exercitar as guardas uma a
//    uma, e sem isto o `require` dispararia a coleta inteira.
module.exports = { nomeFinal, carimboDe, casaConsumidor, consumidorDe, CONSUMIDORES };
if (require.main !== module) return;

(async () => {
  const fonte = (process.env.FONTE || 'pasta').toLowerCase();
  const arquivos = fonte === 'graph' ? await doGraph() : await daPasta();
  const destino = await abreDestino();
  const existentes = await destino.lista();

  // 🔴 O PREFIXO NOVO TEM DE SER MAIOR QUE TODOS. O `gen-scada` le do menor id para o maior e o
  //    ultimo vence; um prefixo menor que o legado faria o arquivo NOVO perder para o VELHO.
  let maiorExistente = 0;
  for (const n of existentes) {
    const m = n.split('/').pop().match(/^(\d+)_/);
    if (m) maiorExistente = Math.max(maiorExistente, Number(m[1]));
  }

  const jaTem = new Set(existentes.map((n) => n.split('/').pop()));
  const relatorio = { subiu: 0, repetido: 0, recusado: 0 };
  const falhas = [];

  for (const a of arquivos) {
    const nome = nomeFinal(a.original, a.dt);

    // guarda 1 · o consumidor casaria este nome?
    const c = casaConsumidor(nome, a.original);
    if (!c.ok) { falhas.push(a.original + ': ' + c.motivo); relatorio.recusado += 1; continue; }

    // guarda 2 · idempotencia PRIMEIRO: o mesmo arquivo com o mesmo carimbo ja esta la, e isso
    // nao e violacao nenhuma — e a segunda passada.
    // 🔴 A ORDEM DAS DUAS GUARDAS E A CORRECAO. Com a monotonicidade antes, a segunda passada
    //    RECUSAVA tudo: o arquivo ja gravado passa a ser o "maior existente", e o mesmo carimbo
    //    deixa de ser estritamente maior que ele proprio. O ensaio pegou — sem exercitar a
    //    segunda passada, isto so apareceria na segunda rodada em producao.
    if (jaTem.has(nome)) { relatorio.repetido += 1; continue; }

    // guarda 3 · o prefixo e maior que todo o legado?
    const pref = Number(nome.match(/^(\d+)_/)[1]);
    if (!(pref > maiorExistente)) {
      falhas.push(a.original + ': prefixo ' + pref + ' nao e maior que o maior existente ('
        + maiorExistente + ') — o gen-scada leria o novo ANTES do velho');
      relatorio.recusado += 1; continue;
    }

    if (!SECO) await destino.poe(nome, a.leia());
    jaTem.add(nome);
    relatorio.subiu += 1;
    console.log('  ' + (SECO ? '(seco) ' : '') + nome + '   <- ' + a.original + '   [' + c.quem + ']');
  }

  console.log('\n  ' + arquivos.length + ' na fonte · ' + relatorio.subiu + ' novos · '
    + relatorio.repetido + ' ja estavam · ' + relatorio.recusado + ' recusados');
  if (falhas.length) {
    console.error('RECUSADOS:'); falhas.forEach((f) => console.error('  ' + f));
    process.exit(1);   // 🔴 fail-closed: arquivo que nao casa consumidor seria ignorado em silencio
  }
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });

