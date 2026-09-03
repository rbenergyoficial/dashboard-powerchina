// gen-scada-intake.js — a INTAKE dos containers de arquivo bruto, hoje feita pelo Power Automate.
//
// Serve DOIS containers com o mesmo codigo; quem escolhe e `RAW_CONTAINER` (+ `SP_PASTA`):
//   scada-raw        SCADA/Solarimetria, Transformadores e Perdas de PV
//   inversores-raw   Inversores (`gen-inversores`)
// ⚠️ Os dois vem do MESMO site e do MESMO locatario, entao UMA credencial destrava os dois.
//
// 🔴 POR QUE ESTE ARQUIVO EXISTE
// Os containers sao alimentados por fluxos do Power Automate que usam conectores Premium
// (SharePoint e Azure Blob). Juntos, eles sao a entrada de CINCO paginas: SCADA/Solarimetria
// (`gen-scada`, `gen-irradiancia`), Transformadores (`gen-trafo`), Perdas de PV (`gen-perdas`) e
// Inversores (`gen-inversores`).
// Sem eles, essas paginas param de receber dado novo — e param em silencio, porque os geradores
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
//   (padrao)      DADOS_STORAGE + RAW_CONTAINER=scada-raw | inversores-raw
//   LOCAL_OUT=dir grava em pasta, sem tocar em producao (ensaio)
//
// 🔴 O CONSUMIDOR DOS INVERSORES DESCARTA RASCUNHO PELO NOME (`em revisao`, `copia`, `rascunho`),
// por SUBSTRING, e escolhe a versao vigente pelo `lastModified` do BLOB. Duas consequencias que
// amarram este coletor:
//   · o carimbo e um PREPEND, entao a marca de rascunho sobrevive — um coletor que RENOMEASSE
//     faria um rascunho passar por versao boa, e o painel mostraria dado provisorio sem nada
//     ficar vermelho;
//   · a gravacao vai em ordem cronologica da FONTE, senao a versao velha pode virar a mais
//     recente do container.
// As duas estao provadas no ensaio.
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
// ⚠️ O contrato e POR CONTAINER, e nao so por nome. Sem isso um `.xlsx` de inversores casaria a
//    regra do `gen-scada` — passaria na guarda, porque o prefixo satisfaz as duas, mas ficaria
//    atribuido ao consumidor errado. Guarda que aponta o consumidor errado ensina a desconfiar da
//    guarda no dia em que ela acusar de verdade.
const CONSUMIDORES = [
  { onde: 'scada-raw', quem: 'gen-scada',       quando: /\.xlsx$/i,                 exige: /^(\d+)_/ },
  { onde: 'scada-raw', quem: 'gen-irradiancia', quando: /_?IIRR_\d{8}_\d{6}\.csv$/i, exige: /IIRR_(\d{8}_\d{6})\.csv$/i },
  { onde: 'scada-raw', quem: 'gen-irradiancia', quando: /_?IRR_GERAL_\d{8}_\d{6}\.csv$/i, exige: /IRR_GERAL_(\d{8}_\d{6})\.csv$/i },
  { onde: 'scada-raw', quem: 'gen-irradiancia', quando: /(^|_)IRR_\d{8}_\d{6}\.csv$/i, exige: /_IRR_(\d{8}_\d{6})\.csv$/i },
  { onde: 'scada-raw', quem: 'gen-trafo',       quando: /Trafo_\d{8}_\d{6}\.csv$/i,  exige: /Trafo_(\d{8})_(\d{6})\.csv$/i },
  { onde: 'scada-raw', quem: 'gen-perdas',      quando: /M\d{2}_\d{8}_\d{6}\.csv$/i, exige: /M(\d{2})_(\d{8})_\d{6}\.csv$/i },

  // 🔴 O consumidor dos inversores nao escolhe por NOME: `classifyWb` decide P1/P2 pelo CONTEUDO
  //    da planilha, e a versao vencedora e a de maior `lastModified` do blob. Entao o prefixo nao
  //    o afeta — e por isso `exige` aqui so pede que continue sendo planilha.
  // ⚠️ Mas ha uma guarda POR NOME do outro lado: `NAO_FINAL` descarta "em revisao", "rascunho",
  //    "copia", "old", "backup". Ela e teste de SUBSTRING, entao o prefixo numerico nao a quebra —
  //    e um coletor que RENOMEASSE o arquivo faria um rascunho passar por versao boa, e o painel
  //    inteiro mostraria dado provisorio sem nada ficar vermelho. O nome original vai inteiro.
  { onde: 'inversores-raw', quem: 'gen-inversores', quando: /\.xls[xm]$/i, exige: /\.xls[xm]$/i },
];

// ⚠️ a ordem importa: `IIRR_` e `IRR_GERAL_` tem de ser testados ANTES de `IRR_`, senao o terceiro
//    padrao os captura. Os tres nomes se parecem de proposito e ja custaram uma correcao ao
//    gen-irradiancia — a ordem aqui e a mesma que ele usa.
// 🔴 As extensoes que interessam saem do PROPRIO contrato, nunca de uma lista escrita ao lado.
// Foi uma lista escrita a mao (`/\.(csv|xlsx)$/`) que teria engolido a planilha de falhas dos
// inversores, que virou `.xlsm` em 20/08/2026 — sem erro, sem log, so o painel parando de receber
// versao nova. Filtrar por extensao NAO afrouxa a guarda: ela julga o NOME, e um `IRR_....csv`
// limpo continua chegando nela para ser recusado.
function extensoesDe(onde) {
  const exts = new Set();
  for (const c of CONSUMIDORES) {
    if (onde && c.onde !== onde) continue;
    for (const m of c.quando.source.matchAll(/\\\.(?:\(([^)]+)\)|([a-z]+)(\[[a-z]+\])?)/gi)) {
      if (m[1]) m[1].split('|').forEach((e) => exts.add(e.toLowerCase()));
      else if (m[3]) m[3].slice(1, -1).split('').forEach((ch) => exts.add((m[2] + ch).toLowerCase()));
      else exts.add(m[2].toLowerCase());
    }
  }
  if (!exts.size) throw new Error('nenhum consumidor declarado para o container "' + onde + '"');
  return new RegExp('\\.(' + [...exts].join('|') + ')$', 'i');
}

// `onde` e opcional para nao quebrar quem chama com um argumento so; quando vem, ele DESEMPATA —
// e e o unico jeito de dizer que um `.xlsx` de inversores nao e um `.xlsx` de SCADA.
function consumidorDe(original, onde) {
  for (const c of CONSUMIDORES) {
    if (onde && c.onde !== onde) continue;
    if (c.quando.test(original)) return c;
  }
  return null;
}

function casaConsumidor(nomeFinal, original, onde) {
  const c = consumidorDe(original, onde);
  if (!c) {
    return { ok: false, motivo: 'nenhum consumidor reconhece este nome'
      + (onde ? ' em "' + onde + '"' : '') };
  }
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
  const aceita = extensoesDe(RAW_CONTAINER);
  return fs.readdirSync(dir).filter((f) => aceita.test(f)).map((f) => {
    const p = path.join(dir, f);
    return { original: f, dt: fs.statSync(p).mtime.toISOString(), leia: () => fs.readFileSync(p) };
  });
}

// ── leitura do SharePoint por credencial de aplicativo ──────────────────────────────────────
// O stub anterior se recusava a escrever este ramo "para nao supor caminho", e estava certo. O
// caminho deixou de ser suposicao — ele foi lido do gatilho do fluxo que alimenta o container
// hoje — mas NAO mora aqui: site e pasta vem de `SP_SITE` e `SP_PASTA`, e sao dado de ambiente.
//
// 🔴 ESTE REPOSITORIO E PUBLICO. Nome de site, caminho de pasta, locatario e endereco de pessoa
//    sao know-how interno e nao entram em codigo versionado — a mesma regra do portao G14 para a
//    `description` de painel. O documento interno (fora daqui) e quem os guarda.
//
// 🔴 A origem fica no locatario do CLIENTE, nao no nosso, e isso decide a migracao: o registro de
//    aplicativo tem de existir LA, e a permissao exige consentimento de administrador de la. Nao
//    se resolve do nosso lado. Ver `SCADA_INTAKE.md`.
//
// ⚠️ RAMO AINDA NAO EXERCITADO: sem credencial ele nem e chamado. Nome, dedup e guarda ja estao
//    provados pelo modo `pasta`, entao o que precisa de prova no dia da credencial e SO a leitura.
const GRAPH_HOST = 'graph.microsoft.com';

// 🔴 Cada segmento vai por `encodeURIComponent`, e isso NAO e detalhe: o caminho real tem acento e
//    ideograma. A URL crua devolve 400, e a mensagem do Graph parece dizer que a pasta nao existe
//    — diagnostico errado, horas perdidas. Funcao propria para o ensaio poder exercita-la com um
//    caminho SINTETICO, sem que o caminho real precise existir no codigo.
function caminhoGraph(pasta) {
  return pasta.split('/').filter(Boolean).map(encodeURIComponent).join('/');
}

// 🔴 O `/content` do Graph responde 302, NAO 200. Ele redireciona para uma URL de download de
//    curta duracao em OUTRO host. A primeira versao tratava 3xx como erro e o ensaio parou em
//    `Graph HTTP 302` com corpo VAZIO — uma mensagem que nao diz o que fazer.
//
// ⚠️ E o Authorization NAO acompanha o redirecionamento. A URL de destino ja vem
//    pre-autenticada, e mandar o bearer para outro host e vazar credencial para fora do Graph.
//
// ⚠️ O limite de saltos existe para o caso patologico: sem ele, um ciclo de redirecionamento
//    vira recursao infinita em vez de erro.
function graphGet(caminho, token, bruto, saltos) {
  const https = require('https');
  saltos = saltos === undefined ? 5 : saltos;
  return new Promise((ok, ko) => {
    const abs = /^https?:\/\//.test(caminho);
    // ⚠️ URL do WHATWG, nao `url.parse`: o Node marca o segundo como obsoleto e avisa que ele
    //    tem implicacoes de seguranca. `search` tem de entrar no caminho — a URL do 302 leva a
    //    autorizacao na query, e sem ela o download volta 403.
    const u = abs ? new URL(caminho) : null;
    const alvo = abs ? { host: u.host, path: u.pathname + u.search }
      : { host: GRAPH_HOST, path: '/v1.0' + caminho };
    const req = https.get({ host: alvo.host, path: alvo.path, family: 4,
      // sem token no salto: o destino do 302 e pre-autenticado
      headers: abs ? {} : { Authorization: 'Bearer ' + token }, timeout: 120000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();                       // descarta o corpo do redirecionamento
        if (!saltos) return ko(new Error('redirecionamento demais em ' + caminho));
        return graphGet(res.headers.location, token, bruto, saltos - 1).then(ok, ko);
      }
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
  // ⚠️ `SP_SITE` e `SP_PASTA` sao OBRIGATORIOS, sem valor embutido. Um default aqui seria dado
  //    interno em repositorio publico — e, pior, faria o ramo "funcionar" apontando para um lugar
  //    que ninguem declarou.
  const falta = ['GRAPH_TENANT', 'GRAPH_CLIENT_ID', 'GRAPH_CLIENT_SECRET', 'SP_SITE', 'SP_PASTA']
    .filter((k) => !process.env[k]);
  if (falta.length) throw new Error('FONTE=graph exige: ' + falta.join(', '));

  const site = process.env.SP_SITE;
  const pasta = process.env.SP_PASTA;

  const token = await tokenGraph();
  const s = await graphGet('/sites/' + site, token);
  console.log('  site: ' + (s.displayName || s.name));

  const rel = caminhoGraph(pasta);

  const itens = [];
  const aceita = extensoesDe(RAW_CONTAINER);
  let url = '/sites/' + s.id + '/drive/root:/' + rel + ':/children?$top=200';
  while (url) {
    const p = await graphGet(url, token);
    for (const it of p.value || []) if (it.file && aceita.test(it.name)) itens.push(it);
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
module.exports = { nomeFinal, carimboDe, casaConsumidor, consumidorDe, caminhoGraph, extensoesDe, CONSUMIDORES };
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

  // 🔴 A ORDEM DE GRAVACAO E CARGA, por causa do `gen-inversores`: ele escolhe a planilha vigente
  //    pelo `lastModified` do BLOB, que e o instante do UPLOAD — nao o do arquivo na origem.
  //    Subindo na ordem em que a API listou, a versao mais antiga pode virar a mais recente do
  //    container, e o painel passa a mostrar dado velho sem nada ficar vermelho. Gravando em
  //    ordem cronologica da FONTE, o blob herda a cronologia de quem salvou o arquivo.
  //
  // ⚠️ NAO e a guarda 3 que exige isto, ao contrario do que a intuicao diz: `maiorExistente` e
  //    calculado UMA vez, do que ja estava no container, e nao cresce dentro do laco. Entao um
  //    arquivo antigo que chegue depois de um recente na MESMA rodada nao e recusado. Fica dito
  //    porque a leitura errada e plausivel, e quem a assumisse mexeria na guarda por engano.
  arquivos.sort((a, b) => Date.parse(a.dt) - Date.parse(b.dt));

  const jaTem = new Set(existentes.map((n) => n.split('/').pop()));
  const relatorio = { subiu: 0, repetido: 0, recusado: 0 };
  const falhas = [];

  for (const a of arquivos) {
    const nome = nomeFinal(a.original, a.dt);

    // guarda 1 · o consumidor casaria este nome?
    // O container de destino e quem diz QUAL contrato vale — `.xlsx` existe nos dois.
    const c = casaConsumidor(nome, a.original, RAW_CONTAINER);
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

    // 🔴 `await a.leia()` — o await tem de estar nos DOIS. No modo `pasta` o `leia()` devolve
    //    Buffer sincrono e a falta do await passava despercebida; no modo `graph` ele devolve
    //    PROMESSA, e o destino recebia a promessa no lugar dos bytes. Medido no primeiro ensaio
    //    do ramo Graph: `The "data" argument must be of type string or an instance of Buffer
    //    ... Received an instance of Promise`. `await` sobre Buffer nao custa nada, entao a
    //    forma correta serve aos dois modos.
    if (!SECO) await destino.poe(nome, await a.leia());
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

