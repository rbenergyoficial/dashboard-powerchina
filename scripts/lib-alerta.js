// lib-alerta.js — para onde vai um alerta dos vigias.
//
// 🔴 POR QUE ELE EXISTE
// Hoje todo alerta sai por um POST no webhook do fluxo "Central de Alertas · Mauriti", que vira
// e-mail e WhatsApp. Esse webhook e um gatilho HTTP do Power Automate — conector Premium, mesma
// licenca com prazo que ja tirou a coleta e o disparo de la. Quando ela cair, os vigias continuam
// medindo certo e **ninguem fica sabendo**: a falha some do radar sem nada quebrar.
//
// ⚠️ ESTE MODULO NAO SUBSTITUI O WEBHOOK — ele ACRESCENTA um segundo destino. A ordem e a mesma
// que funcionou na coleta da Way2: o caminho novo entra ao lado, e prova que funciona antes de o
// antigo sair. Alerta e justamente o que nao se pode migrar no escuro.
//
// DESTINOS
//   webhook   PA_ALERT_WEBHOOK — o de hoje. Sai quando a licenca cair.
//   issue     uma ISSUE no proprio repositorio. Nao custa nada, nao precisa de segredo novo (o
//             GITHUB_TOKEN do Actions basta), tem historico, e o GitHub avisa por e-mail quem
//             acompanha o repositorio. E o dedup fica natural: uma issue ABERTA por evento; o
//             alerta de normalizacao a FECHA.
//
// ⚠️ A issue exige `issues: write` nas permissoes do workflow. Sem isso ela falha com 403 — e o
//    modulo REGISTRA a falha em vez de engoli-la: um canal de alerta que falha calado e pior que
//    nao ter canal.
'use strict';
const https = require('https');

const REPO = process.env.GH_REPO || 'rbenergyoficial/dashboard-powerchina';
const GH = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const WEBHOOK = (process.env.PA_ALERT_WEBHOOK || '').trim();
const ROTULO = process.env.ALERTA_ROTULO || 'alerta-automatico';

function pedeGh(caminho, metodo, corpo) {
  return new Promise((ok, ko) => {
    const d = corpo ? JSON.stringify(corpo) : null;
    const r = https.request({ host: 'api.github.com', path: '/repos/' + REPO + caminho,
      method: metodo, family: 4,
      headers: { 'User-Agent': 'alerta-mauriti', Authorization: 'Bearer ' + GH,
        Accept: 'application/vnd.github+json',
        ...(d ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {}) } },
    (x) => { const b = []; x.on('data', (c) => b.push(c));
      x.on('end', () => { const t = Buffer.concat(b).toString();
        if (x.statusCode >= 300) return ko(new Error('GitHub HTTP ' + x.statusCode + ': ' + t.slice(0, 160)));
        ok(t ? JSON.parse(t) : null); }); });
    r.on('error', ko); if (d) r.write(d); r.end();
  });
}

function postWebhook(url, obj) {
  return new Promise((ok, ko) => {
    const u = new URL(url); const body = JSON.stringify(obj);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000 }, (res) => { res.resume();
      res.on('end', () => (res.statusCode < 300 ? ok(res.statusCode)
        : ko(new Error('webhook HTTP ' + res.statusCode)))); });
    r.on('error', ko); r.on('timeout', () => { r.destroy(new Error('webhook timeout')); });
    r.write(body); r.end();
  });
}

// html simples -> texto, para o corpo da issue ficar legivel
// ⚠️ nao e um sanitizador nem finge ser: o corpo vem dos nossos proprios vigias, nao de fora.
function texto(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|li|ul|div)>/gi, '\n')
    .replace(/<li>/gi, '- ').replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// 🔴 A CHAVE e o que faz o dedup funcionar: o mesmo evento tem de produzir o MESMO titulo, sempre.
//    Titulo que carrega numero variavel (idade, quantidade) abriria uma issue nova a cada rodada —
//    e vigia que abre issue a cada 5 min ensina a ignorar a issue.
function tituloDe(acao) {
  return '[' + (acao.chave || acao.tipo || 'alerta') + '] ' + (acao.titulo || acao.tipo || 'alerta');
}

async function achaAberta(titulo) {
  const q = encodeURIComponent('repo:' + REPO + ' is:issue is:open label:' + ROTULO);
  const r = await pedeGh('/issues?state=open&labels=' + encodeURIComponent(ROTULO) + '&per_page=100', 'GET');
  return (r || []).find((i) => i.title === titulo) || null;
}

/**
 * Envia o alerta para todos os destinos configurados.
 * @param acao   { tipo, assunto, corpo, chave?, titulo?, resolve? }
 *               `chave`   identifica o EVENTO (o que dedup usa). Sem ela, usa `tipo`.
 *               `resolve` quando true, FECHA a issue aberta daquele evento em vez de abrir.
 * @returns { webhook, issue }  o que cada destino respondeu ('-' = nao configurado)
 */
async function alerta(acao) {
  const out = { webhook: '-', issue: '-' };

  if (WEBHOOK) {
    try { out.webhook = 'HTTP ' + (await postWebhook(WEBHOOK, acao)); }
    catch (e) { out.webhook = 'FALHOU: ' + e.message; }
  }

  if (GH) {
    const titulo = tituloDe(acao);
    try {
      const aberta = await achaAberta(titulo);
      const corpo = texto(acao.corpo) + '\n\n---\n`' + JSON.stringify(
        Object.fromEntries(Object.entries(acao).filter(([k]) => !['corpo', 'assunto'].includes(k)))
      ) + '`';
      if (acao.resolve) {
        if (!aberta) out.issue = 'nada aberto para fechar';
        else {
          await pedeGh('/issues/' + aberta.number + '/comments', 'POST', { body: corpo });
          await pedeGh('/issues/' + aberta.number, 'PATCH', { state: 'closed' });
          out.issue = 'fechou #' + aberta.number;
        }
      } else if (aberta) {
        // ⚠️ evento que continua: COMENTA, nao abre outra. O dedup dos vigias ja limita a
        //    frequencia; isto e a segunda rede, do lado do canal.
        await pedeGh('/issues/' + aberta.number + '/comments', 'POST', { body: corpo });
        out.issue = 'comentou #' + aberta.number;
      } else {
        const i = await pedeGh('/issues', 'POST',
          { title: titulo, body: corpo, labels: [ROTULO] });
        out.issue = 'abriu #' + i.number;
      }
    } catch (e) { out.issue = 'FALHOU: ' + e.message; }
  }

  // 🔴 REGISTRA sempre, inclusive a falha. Canal de alerta que falha calado e pior que canal
  //    nenhum: some o alerta E some a noticia de que ele sumiu.
  console.log('  alerta [' + (acao.chave || acao.tipo) + '] · webhook: ' + out.webhook
    + ' · issue: ' + out.issue);
  return out;
}

module.exports = { alerta, texto, tituloDe };
