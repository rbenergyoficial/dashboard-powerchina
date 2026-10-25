'use strict';
/*
 * lib-conteiner.js — a porta única para abrir um contêiner do storage `rbenergydata` com permissão de gravar (plano OIDC, etapa 2,
 * 25/10/2026; o plano é o Claude_Grafana/plano-oidc-geradores.md da pasta do projeto).
 *
 * Por que existe: o segredo DADOS_STORAGE é a cadeia de conexão com a CHAVE da conta. Quem a tem lê, grava e apaga todos os
 * contêineres, sem prazo, até alguém girar a chave. Ela chega a 35 workflows de um repositório público. Com OIDC o job troca o token
 * de identidade do GitHub por um token do Entra: ele vale cerca de 1 h, só sai para o `main` deste repositório e o papel no storage
 * é só `Storage Blob Data Contributor`, contêiner a contêiner. Não há segredo para vazar.
 *
 * Ordem:
 *   1. DADOS_STORAGE -> a cadeia de conexão, como sempre foi. Enquanto um workflow tiver o segredo, nada muda para ele;
 *   2. AZURE_CLIENT_ID + AZURE_TENANT_ID (as variáveis do repo, as mesmas do relogio-deploy) + o token de identidade do job
 *      (`permissions: id-token: write`) -> OIDC;
 *   3. nenhum dos dois -> ESTOURA, com o nome do que falta. Gravar sem credencial nunca vira "não gravou nada".
 *
 * 🔴 O TOKEN SE RENOVA SOZINHO. A troca é a mesma do canal de e-mail da lib-alerta (o GitHub emite o token de identidade para o
 *    audience do Entra, o Entra devolve o token de acesso), feita a cada vez que o token de acesso está a menos de 5 min de vencer.
 *    O token de identidade pode ser pedido de novo durante o job inteiro, então job de 120 min (sungrow, way2-hist) não perde o
 *    acesso no meio, o que aconteceria com a sessão de 1 h do azure/login. Por isso não há azure/login nem @azure/identity aqui:
 *    só https e o SDK que os workflows já instalam.
 *
 * Uso:   const { conteiner } = require('./lib-conteiner');
 *        const c = conteiner('dados');            // ContainerClient novo a cada chamada: quem chama guarda o seu (como a lib-le-dados)
 *        require('./lib-conteiner').credencial()  // 'chave' | 'oidc' | null
 */
const https = require('https');

const CONTA = process.env.DADOS_CONTA_URL || 'https://rbenergydata.blob.core.windows.net';
const ESCOPO = 'https://storage.azure.com/.default';
const FOLGA_MS = 5 * 60 * 1000;   // renova o token de acesso 5 min antes de vencer

const pedeJsonHttps = function (opts, corpo) {
  return new Promise((ok, ko) => {
    const r = https.request(opts, (res) => {
      const b = [];
      res.on('data', (c) => b.push(c));
      res.on('end', () => {
        const t = Buffer.concat(b).toString('utf8');
        if (res.statusCode >= 300) return ko(new Error('HTTP ' + res.statusCode + ' · ' + t.slice(0, 200)));   // o AADSTS do Entra vem aqui
        try { ok(t ? JSON.parse(t) : null); } catch (e) { ko(new Error('resposta que não é JSON de ' + opts.hostname + ': ' + t.slice(0, 80))); }
      });
    });
    r.on('error', ko);
    r.on('timeout', () => r.destroy(new Error('tempo esgotado em ' + opts.hostname)));
    if (corpo) r.write(corpo);
    r.end();
  });
};
let pedeJson = pedeJsonHttps;   // o ensaio troca pelo simulado (_usaTransporte) e julga este à parte (_pedeJsonHttps)

function credencial() {
  if (process.env.DADOS_STORAGE) return 'chave';
  if (faltaOidc().length === 0) return 'oidc';
  return null;
}
function faltaOidc() {
  return ['AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN']
    .filter((k) => !String(process.env[k] || '').trim());
}

// 1) o GitHub emite um token de identidade para o audience que o Entra espera
async function idTokenGitHub() {
  const u = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
  u.searchParams.set('audience', 'api://AzureADTokenExchange');
  const r = await pedeJson({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
    headers: { Authorization: 'Bearer ' + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN }, timeout: 30000 });
  if (!r || !r.value) throw new Error('lib-conteiner: o GitHub não devolveu o token de identidade');
  return r.value;
}

// 2) o Entra o troca por um token de acesso ao storage — sem senha, só a asserção. Implementa o `getToken` que o SDK chama.
function credencialOidc() {
  let atual = null;
  return {
    async getToken() {
      if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;
      const corpo = new URLSearchParams({
        client_id: process.env.AZURE_CLIENT_ID.trim(),
        scope: ESCOPO,
        grant_type: 'client_credentials',
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: await idTokenGitHub(),
      }).toString();
      const r = await pedeJson({ hostname: 'login.microsoftonline.com',
        path: '/' + process.env.AZURE_TENANT_ID.trim() + '/oauth2/v2.0/token', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(corpo) }, timeout: 30000 }, corpo);
      if (!r || !r.access_token || !(r.expires_in > 0)) throw new Error('lib-conteiner: o Entra não devolveu o token de acesso');
      atual = { token: r.access_token, expiresOnTimestamp: Date.now() + r.expires_in * 1000 };
      return atual;
    },
  };
}

// ⚠️ Sem cache de cliente: a credencial é lida a cada chamada, como a lib-le-dados sempre fez. Ensaio que recarrega a lib-le-dados
//    com outra DADOS_STORAGE recebe o cliente da credencial nova. Só o token do OIDC fica guardado (um por processo), para não pedir
//    um token novo a cada contêiner aberto.
let OIDC = null;
function conteiner(nome) {
  if (!nome) throw new Error('lib-conteiner: conteiner() sem nome');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = credencial();
  if (c === 'chave') return BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(nome);
  if (c === 'oidc') return new BlobServiceClient(CONTA, OIDC || (OIDC = credencialOidc())).getContainerClient(nome);
  throw new Error('lib-conteiner: sem credencial para gravar no storage. Ponha DADOS_STORAGE no passo, ou o OIDC completo (falta: '
    + faltaOidc().join(', ') + ')');
}

module.exports = { conteiner, credencial, _usaTransporte: (f) => { pedeJson = f; }, _pedeJsonHttps: pedeJsonHttps, _zera: () => { OIDC = null; } };
