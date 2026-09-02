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

// `arq` e o nome no blob e e o que a pagina referencia — ele NAO muda quando o titulo do painel
// muda. `larg`/`alt` seguem o lugar na grade: um painel de largura inteira e oito de meia coluna.
const ALVOS = [
  { arq: 'pr-livre-mes.png',       uid: 'perfmt1',  painel: 90,  larg: 1500, alt: 430 },
  { arq: 'mapa-pr-livre.png',      uid: 'perfmt1',  painel: 92,  larg: 1100, alt: 430 },
  { arq: 'corte-esconde.png',      uid: 'perfmt1',  painel: 91,  larg: 1100, alt: 430 },
  { arq: 'irradiancia-plano.png',  uid: 'a88bwp',   painel: 201, larg: 1100, alt: 430 },
  { arq: 'irradiancia-fontes.png', uid: 'a88bwp',   painel: 227, larg: 1100, alt: 430 },
  { arq: 'cascata-energia.png',    uid: 'perdas1r', painel: 510, larg: 1100, alt: 430 },
  { arq: 'perda-conversao.png',    uid: 'perdas1r', painel: 511, larg: 1100, alt: 430 },
  { arq: 'distribuicao-pr.png',    uid: 'perfmt1',  painel: 93,  larg: 1100, alt: 430 },
  { arq: 'mapa-divergencia.png',   uid: 'cmpfont1', painel: 40,  larg: 1100, alt: 430 },
];

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

// A janela sai do PAINEL quando ele fixa a dele (`timeFrom`), e do dashboard quando nao fixa.
// Escrever a janela aqui faria a legenda do portal prometer um periodo e a imagem mostrar outro.
function janela(p, dash) {
  if (p.timeFrom) return { from: 'now-' + p.timeFrom, to: 'now', origem: 'painel' };
  const t = dash.time || {};
  return { from: t.from || 'now-6h', to: t.to || 'now', origem: 'dashboard' };
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

      const j = janela(p, dash);
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
        titulo: p.title || '', tipo: p.type, janela: j, vars: v.par });
      console.log('  %-24s %s[%d] %-14s %5.0f KB %6d ms  janela %s→%s (%s)',
        a.arq, a.uid, a.painel, p.type, buf.length / 1024, ms, j.from, j.to, j.origem);
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
    console.error('\nRECUSADO — %d de %d falharam, nada foi publicado:', falhas.length, ALVOS.length);
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
      titulo: p.titulo, janela: p.janela.from + ' → ' + p.janela.to,
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
    console.log('\ngravado em %s · %d paineis · %.0f KB',
      process.env.LOCAL_OUT, feitos.length, feitos.reduce((s, p) => s + p.bytes, 0) / 1024);
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
  console.log('\npublicados %d paineis · %.0f KB no total',
    feitos.length, feitos.reduce((s, p) => s + p.bytes, 0) / 1024);
})().catch(e => { console.error('FALHOU:', e.message); process.exit(1); });
