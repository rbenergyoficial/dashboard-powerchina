// gen-render-paineis.js — renderiza os paineis da tela de Paineis do portal e os grava no blob.
//
// 🔴 POR QUE ESTE ARQUIVO EXISTE
// A tela de Paineis do portal era servida por IMAGEM COLADA no HTML como base64: 9 PNGs, 1.383 KB,
// 79% do peso do portal inteiro. Elas nao tinham carimbo nenhum e so mudavam quando alguem regerava
// a pagina a mao — envelheciam em silencio, que e o modo de falhar que esta casa mais paga.
//
// As tres alternativas foram medidas e caem:
//   iframe do /d-solo     acesso anonimo esta DESLIGADO — cada leitor pediria assento, e o plano
//                         atual tem tres;
//   painel publico        NAO suporta variavel de template, e os nove dependem de ${ufv} e ${res};
//   reconstruir no portal  e o que as outras telas fazem, mas estes nove sao mapa de calor,
//                          histograma e dispersao — trabalho de grafico, nao de hidratacao.
//
// Renderizar por job preserva o painel exato, mantem as variaveis e tira o peso do HTML. O que se
// perde continua perdido, e a tela diz: imagem nao tem tooltip, zoom nem legenda viva.
//
// ⚠️ A credencial e uma conta de servico VIEWER. Ela so le e renderiza; um token com escrita
// poderia alterar painel, e este job nao precisa disso.
//
// 🔴 NADA AQUI E ESCRITO A MAO ALEM DO ID DO PAINEL. Titulo, janela e variaveis saem da API no
// instante da renderizacao. Titulo copiado envelhece diferente do painel; janela escrita aqui
// mentiria sobre o que a imagem mostra.

'use strict';
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const BASE = process.env.GRAFANA_URL || 'https://powerchinabrasil.grafana.net';
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const PREFIXO = 'paineis/';

// 🔴 Abaixo de 1000 px o renderer IGNORA width e height e devolve 1000x500. Largura menor que isso
// sai como uma imagem que parece certa e nao e a que se pediu.
const PISO_LARGURA = 1000;

// 🔴 IMAGEM NAO TEM ZOOM, E ISSO MUDA QUAL JANELA SERVE
// No Grafana o leitor arrasta e abre o trecho que interessa. Numa imagem, a janela que foi
// renderizada e a unica que existe — entao ela deixa de ser so o padrao do dashboard e passa a ser
// decisao de composicao, como a altura do painel.
//
// Medido em 02/09/2026 no [227] (irradiancia, duas fontes, passo de 1 h) a 1100 px:
//
//   30 dias  ·  ~35 px por ciclo diario  ·  ✅ le-se cada dia, e a falta do sensor entre 07 e
//                                             23/08 aparece como a linha do SCADA sumindo
//   90 dias  ·  ~12 px por ciclo         ·  ⚠️ os dias viram espigoes e as duas fontes comecam a
//                                             se sobrepintar
//   365 dias ·   ~3 px por ciclo         ·  🔴 parede magenta: a comparacao que o painel existe
//                                             para fazer desaparece
//
// ⚠️ A METRICA OBVIA — pontos por pixel — NAO SEPARA OS CASOS, e por isso nao virou regra
// automatica. O [511] do perdas1r roda a 1,78 pontos por pixel e le-se muito bem; o [227] ja
// degrada a 2,06. O que difere e o CICLO: irradiancia oscila de 0 a 1000 todo dia, entao o que
// governa e quantos pixels cabem num ciclo — e "este sinal tem ciclo diario" nao se deduz do JSON
// do dashboard. Uma formula aqui seria uma formula que eu nao consigo defender.
//
// Entao a janela vai DECLARADA, com a razao medida ao lado, e o manifesto publica as duas (a do
// dashboard e a da imagem) para a pagina poder dizer qual esta na tela. Janela declarada que
// aparece na pagina nao apodrece em silencio; e por isso que este numero pode ser escrito e um
// numero de KPI nao pode.
//
// `arq` e o nome no blob e e o que a pagina referencia — ele NAO muda quando o titulo do painel
// muda. `larg`/`alt` seguem o lugar na grade: um painel de largura inteira e oito de meia coluna.
const ALVOS = [
  { arq: 'pr-livre-mes.png',       uid: 'perfmt1',  painel: 90,  larg: 1500, alt: 430 },
  { arq: 'mapa-pr-livre.png',      uid: 'perfmt1',  painel: 92,  larg: 1100, alt: 430 },
  { arq: 'corte-esconde.png',      uid: 'perfmt1',  painel: 91,  larg: 1100, alt: 430 },
  { arq: 'irradiancia-plano.png',  uid: 'a88bwp',   painel: 201, larg: 1100, alt: 430,
    janela: { from: 'now-30d', to: 'now', razao: 'ciclo diario: a 1 ano cada dia ocupa 3 px' } },
  { arq: 'irradiancia-fontes.png', uid: 'a88bwp',   painel: 227, larg: 1100, alt: 430,
    janela: { from: 'now-30d', to: 'now', razao: 'ciclo diario: a 1 ano as duas fontes viram uma mancha' } },
  { arq: 'cascata-energia.png',    uid: 'perdas1r', painel: 510, larg: 1100, alt: 430 },
  { arq: 'perda-conversao.png',    uid: 'perdas1r', painel: 511, larg: 1100, alt: 430 },
  { arq: 'distribuicao-pr.png',    uid: 'perfmt1',  painel: 93,  larg: 1100, alt: 430 },
  { arq: 'mapa-divergencia.png',   uid: 'cmpfont1', painel: 40,  larg: 1100, alt: 430 },
];

// ⚠️ Estopim, nao formula. Ele nao decide a janela — ele obriga quem acrescentar um alvo de serie
// temporal com janela longa a OLHAR o render e declarar o que viu, em vez de herdar o padrao do
// dashboard e descobrir a parede depois de publicada. Hoje ele nao acende em nenhum dos nove.
const DIAS_SEM_OLHAR = 60;

// Um PNG de erro do renderer sai pequeno; um painel de verdade nao. O piso nao e chutado — o menor
// dos nove medido nestas larguras passa de 25 KB, e metade disso ainda deixa folga larga.
const PISO_BYTES = 12 * 1024;

function pede(caminho, token) {
  const u = new URL(caminho, BASE);
  return new Promise((ok, ko) => {
    const req = https.get({
      host: u.hostname, path: u.pathname + u.search, family: 4,
      headers: { Authorization: 'Bearer ' + token }, timeout: 180000,
    }, res => {
      const ch = [];
      res.on('data', c => ch.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return ko(new Error('HTTP ' + res.statusCode + ' em ' + u.pathname + ' · '
            + Buffer.concat(ch).toString('utf8').slice(0, 200)));
        }
        ok(Buffer.concat(ch));
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout em ' + u.pathname)));
    req.on('error', ko);
  });
}

// Achata `panels[]` e `row.panels[]`: painel dentro de row RECOLHIDA nao esta na raiz, e procurar
// so na raiz devolveria "nao existe" para um painel que existe.
function achata(ps, saida) {
  for (const p of ps || []) { saida.push(p); if (p.panels) achata(p.panels, saida); }
  return saida;
}

// A janela sai, nesta ordem: do ALVO quando ele declara a dele (e ai a razao esta escrita ao lado),
// do PAINEL quando ele fixa a sua (`timeFrom`), e do dashboard no resto.
function janela(a, p, dash) {
  if (a.janela) return { ...a.janela, origem: 'alvo' };
  if (p.timeFrom) return { from: 'now-' + p.timeFrom, to: 'now', origem: 'painel' };
  const t = dash.time || {};
  return { from: t.from || 'now-6h', to: t.to || 'now', origem: 'dashboard' };
}

// Converte `now-90d`, `now-13M`, `now-1y` em dias. Devolve null para o que nao souber ler —
// `now/M` (arredondado ao inicio do periodo) e carimbo absoluto caem aqui, e o estopim declara
// que nao julgou em vez de fingir que aprovou.
const EM_DIAS = { s: 1 / 86400, m: 1 / 1440, h: 1 / 24, d: 1, w: 7, M: 30, y: 365 };
function vaoEmDias(from, to) {
  if (to !== 'now') return null;
  const m = /^now-(\d+)([smhdwMy])$/.exec(from);
  return m ? Number(m[1]) * EM_DIAS[m[2]] : null;
}

// 🔴 So variavel CUSTOM entra na URL. O `current` de uma variavel de QUERY e o valor que estava
// salvo quando alguem gravou o dashboard — passa-lo congela um valor que existe justamente para
// ser derivado do dado a cada carga, e a imagem passaria a mentir sobre a granularidade.
function variaveis(dash) {
  const fora = [];
  const par = [];
  for (const v of (dash.templating && dash.templating.list) || []) {
    if (v.type !== 'custom') { fora.push(v.name + '(' + v.type + ')'); continue; }
    const c = v.current || {};
    const vals = Array.isArray(c.value) ? c.value : [c.value];
    for (const x of vals) {
      if (x === undefined || x === null || x === '') continue;
      par.push('var-' + encodeURIComponent(v.name) + '=' + encodeURIComponent(x));
    }
  }
  return { par, fora };
}

const kb = (lista) => (lista.reduce((s, p) => s + p.bytes, 0) / 1024).toFixed(0);

// 🔴 Os quatro tipos lidos pelo Infinity IGNORAM o seletor de tempo — o recorte deles esta no
// JSONata da consulta. Medido nesta rodada: o barchart [90] recebeu `now/M` (o mes corrente, dois
// dias) e desenhou ONZE meses; o histograma [93] recebeu o mesmo e contou as 68 observacoes da
// serie inteira.
//
// Entao publicar `now/M → now` ao lado deles faria a pagina reivindicar uma janela que a imagem
// nao tem — o mesmo defeito que a janela declarada acabou de corrigir, so que pelo outro lado.
const IGNORA_SELETOR = new Set(['barchart', 'histogram', 'xychart', 'heatmap']);
const UNIDADE = {
  m: ['minuto', 'minutos'], h: ['hora', 'horas'], d: ['dia', 'dias'],
  w: ['semana', 'semanas'], M: ['mes', 'meses'], y: ['ano', 'anos'],
};

// O rotulo e o que a PAGINA mostra ao lado da imagem, entao ele fala portugues e nao sintaxe do
// Grafana. A janela crua continua no manifesto, para quem for depurar.
function rotuloJanela(tipo, j) {
  if (IGNORA_SELETOR.has(tipo)) return 'recorte da propria consulta';
  const m = /^now-(\d+)([mhdwMy])$/.exec(j.from);
  if (j.to === 'now' && m) {
    const n = Number(m[1]);
    return 'ultim' + (n === 1 ? 'o ' : 'os ') + n + ' ' + UNIDADE[m[2]][n === 1 ? 0 : 1];
  }
  if (j.from === 'now/M' && j.to === 'now') return 'o mes corrente';
  return j.from + ' ate ' + j.to;
}

function confereImagem(buf) {
  if (buf.length < 8 || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e) return 'nao e PNG';
  if (buf.length < PISO_BYTES) {
    return 'so ' + (buf.length / 1024).toFixed(1) + ' KB, abaixo do piso de ' + (PISO_BYTES / 1024)
      + ' KB — o renderer devolve 200 com uma imagem de ERRO, que e um PNG legitimo e vazio';
  }
  return null;
}

(async () => {
  const token = process.env.GRAFANA_TOKEN;
  if (!token) throw new Error('GRAFANA_TOKEN nao definido');

  for (const a of ALVOS) {
    if (a.larg < PISO_LARGURA) {
      throw new Error(a.arq + ': largura ' + a.larg + ' abaixo do piso de ' + PISO_LARGURA
        + ' — o renderer a ignoraria e devolveria 1000x500');
    }
  }

  // Um GET por dashboard, nao um por painel: quatro dashboards servem os nove.
  const uids = [...new Set(ALVOS.map(a => a.uid))];
  const dashes = {};
  for (const uid of uids) {
    const bruto = await pede('/api/dashboards/uid/' + uid, token);
    dashes[uid] = JSON.parse(bruto.toString('utf8')).dashboard;
  }

  const feitos = [];
  const falhas = [];
  for (const a of ALVOS) {
    try {
      const dash = dashes[a.uid];
      const p = achata(dash.panels, []).find(x => x.id === a.painel);
      if (!p) throw new Error('painel ' + a.painel + ' nao existe em ' + a.uid);

      const j = janela(a, p, dash);

      // ⚠️ O estopim so acende quando a janela foi HERDADA do dashboard: alvo que declara a
      // propria ja passou pelo olho de alguem, e painel que fixa a sua sabe por que a fixou.
      if (p.type === 'timeseries' && j.origem === 'dashboard') {
        const dias = vaoEmDias(j.from, j.to);
        if (dias === null) {
          console.log('       janela ' + j.from + '→' + j.to + ' nao pode ser medida em dias; '
            + 'o estopim nao a julgou');
        } else if (dias > DIAS_SEM_OLHAR) {
          throw new Error('serie temporal herdando janela de ' + Math.round(dias) + ' dias do '
            + 'dashboard. Imagem nao tem zoom: renderize e OLHE antes de aceitar, e declare a '
            + 'janela no alvo com a razao do que voce viu');
        }
      }

      const v = variaveis(dash);
      const q = ['panelId=' + a.painel, 'width=' + a.larg, 'height=' + a.alt,
        'from=' + encodeURIComponent(j.from), 'to=' + encodeURIComponent(j.to),
        'theme=dark', 'tz=America%2FSao_Paulo'].concat(v.par).join('&');

      const t0 = Date.now();
      const buf = await pede('/render/d-solo/' + a.uid + '/x?' + q, token);
      const ms = Date.now() - t0;
      const erro = confereImagem(buf);
      if (erro) throw new Error(erro);

      feitos.push({ ...a, buf, bytes: buf.length, ms,
        titulo: p.title || '', tipo: p.type, janela: j, vars: v.par,
        janelaDash: (dash.time || {}).from + ' → ' + (dash.time || {}).to });

      // ⚠️ `console.log` do Node entende %s e %d, mas NAO entende largura nem precisao ao estilo
      // do printf: `%-24s` e `%5.0f` saem literais na tela e os valores vao empilhados no fim.
      // Foi o que aconteceu na primeira execucao — o log era o instrumento, e o instrumento
      // imprimiu a propria mascara. Alinhamento aqui e por padEnd/toFixed.
      console.log('  ' + a.arq.padEnd(24)
        + (a.uid + '[' + a.painel + ']').padEnd(16)
        + p.type.padEnd(15)
        + (buf.length / 1024).toFixed(0).padStart(4) + ' KB'
        + String(ms).padStart(7) + ' ms   '
        + (j.from + '→' + j.to).padEnd(16) + '(' + j.origem + ')');
      if (j.razao) console.log('       janela declarada · ' + j.razao);
      if (v.fora.length) {
        console.log('       variaveis deixadas para o Grafana resolver: ' + v.fora.join(' '));
      }
    } catch (e) {
      falhas.push(a.arq + ': ' + e.message);
    }
  }

  // ⚠️ Publicacao PARCIAL e pior que nenhuma: a tela mostraria alguns paineis de hoje e outros de
  // ontem, sem nada dizendo qual e qual — o defeito de duas janelas na mesma tela. Ou os nove
  // sobem, ou nenhum sobe, e o conjunto antigo continua no ar com o carimbo dele.
  if (falhas.length) {
    console.error('\nRECUSADO — ' + falhas.length + ' de ' + ALVOS.length
      + ' falharam, nada foi publicado:');
    falhas.forEach(f => console.error('  ' + f));
    process.exit(1);
  }

  const manifesto = {
    gerado: new Date().toISOString(),
    fonte: BASE,
    nota: 'Imagens renderizadas dos paineis. Nao sao interativas: cada uma traz a janela do painel '
        + 'de origem e nao obedece a nenhum seletor do portal.',
    paineis: feitos.map(p => ({
      arq: PREFIXO + p.arq, uid: p.uid, painel: p.painel, tipo: p.tipo,
      titulo: p.titulo,
      // A janela da IMAGEM e a que a pagina tem de dizer ao lado dela. `janela_dashboard` vai
      // junto para o leitor que abrir o painel ao vivo nao estranhar ver outro periodo.
      janela: p.janela.from + ' → ' + p.janela.to,
      janela_rotulo: rotuloJanela(p.tipo, p.janela),
      janela_origem: p.janela.origem,
      janela_razao: p.janela.razao || null,
      janela_dashboard: p.janelaDash,
      link: BASE + '/d/' + p.uid + '?viewPanel=' + p.painel,
      kb: Math.round(p.bytes / 1024),
    })),
  };

  if (process.env.LOCAL_OUT) {
    const fs = require('fs');
    const path = require('path');
    fs.mkdirSync(process.env.LOCAL_OUT, { recursive: true });
    feitos.forEach(p => fs.writeFileSync(path.join(process.env.LOCAL_OUT, p.arq), p.buf));
    fs.writeFileSync(path.join(process.env.LOCAL_OUT, 'manifesto.json'),
      JSON.stringify(manifesto, null, 1));
    console.log('\ngravado em ' + process.env.LOCAL_OUT + ' · ' + feitos.length
      + ' paineis · ' + kb(feitos) + ' KB');
    return;
  }

  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  for (const p of feitos) {
    await cont.getBlockBlobClient(PREFIXO + p.arq).upload(p.buf, p.buf.length, {
      blobHTTPHeaders: { blobContentType: 'image/png', blobCacheControl: 'public, max-age=1800' },
    });
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(manifesto), 'utf8'));
  await cont.getBlockBlobClient(PREFIXO + 'manifesto.json').upload(gz, gz.length, {
    blobHTTPHeaders: {
      blobContentType: 'application/json', blobContentEncoding: 'gzip',
      blobCacheControl: 'public, max-age=300',
    },
  });
  console.log('\npublicados ' + feitos.length + ' paineis · ' + kb(feitos) + ' KB no total');
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
