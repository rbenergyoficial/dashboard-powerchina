'use strict';
/*
 * lib-sessao-az.js — o contêiner das pontes que rodam NA MÁQUINA (coleta-inversores.js, coleta-ppc.js), aberto com o token que a
 * sessão local do az emite para o storage, no lugar da cadeia de conexão com a chave da conta (lote coleta-sem-chave, 28/10/2026).
 *
 * Por que existe: as duas pontes pediam ao az a cadeia de conexão (`storage account show-connection-string`), e ela leva a CHAVE da
 * conta. Em 28/10 eram o último uso da chave medido no storage (~120 operações por dia, de hora em hora das 06:00 às 19:00). O token
 * vale ~1 h, só serve ao storage e o papel da conta no storage é `Storage Blob Data Contributor` só em `inversores-raw` e `ppc-raw`.
 *
 * Ordem:
 *   1. DADOS_STORAGE -> a cadeia de conexão, como sempre foi. É por ela que os ensaios forjam o contêiner;
 *   2. senão, o token da sessão local do az (`az account get-access-token --resource https://storage.azure.com/`).
 *   Sem nenhum dos dois, ESTOURA dizendo qual falhou. Nunca volta para a chave por conta própria.
 *
 * ⚠️ A SAÍDA DO az NÃO ENTRA EM LOG NENHUM, nem em caso de erro: é nela que o token viaja. O que se imprime é SE deu certo e o motivo
 *    da falha do comando, nunca o que ele devolveu.
 * 🔴 O TOKEN SE RENOVA SOZINHO a menos de 5 min do fim (`expires_on`, em segundos desde 1970, que o az devolve desde a 2.54). O
 *    `expiresOn` é a hora LOCAL sem fuso e não serve: sem `expires_on` a resposta é recusada.
 *
 * Uso:   const { conteinerLocal, credencial } = require('./lib-sessao-az');
 *        const c = conteinerLocal('ppc-raw', 'rbenergydata');   // ContainerClient
 *        credencial()                                             // 'chave' | 'sessao-az'
 */
const CONTA_PADRAO = 'rbenergydata';
const RECURSO = 'https://storage.azure.com/';
const FOLGA_MS = 5 * 60 * 1000;

/* executa o az e devolve o texto da saída. No Windows o az é um `.cmd`, que o Node não executa direto desde a correção de segurança
   do 18; chamar o interpretador de comandos COMO PROGRAMA mantém cada argumento separado (mesma regra do coleta-ppc.js). */
function azPadrao(args) {
  const { execFileSync } = require('child_process');
  const o = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60000 };
  return process.platform === 'win32' ? execFileSync('cmd.exe', ['/c', 'az'].concat(args), o) : execFileSync('az', args, o);
}
let az = azPadrao;   // o ensaio troca pelo simulado (_usaAz)

function credencialAz() {
  let atual = null;
  return {
    async getToken() {
      if (atual && atual.expiresOnTimestamp - Date.now() > FOLGA_MS) return atual;
      let txt;
      try {
        txt = az(['account', 'get-access-token', '--resource', RECURSO, '-o', 'json']);
      } catch (e) {
        throw new Error('lib-sessao-az: a sessão local do az não emitiu o token do storage ('
          + String(e.message).replace(/\s+/g, ' ').slice(0, 120) + '). Rode `az login` na máquina.');
      }
      /* ⚠️ o erro do JSON.parse cita um trecho do texto (Node 20+): a mensagem dele não sai daqui */
      let r = null;
      try { r = JSON.parse(txt); } catch (e) { r = null; }
      const vence = Number(r && r.expires_on) * 1000;
      if (!r || typeof r.accessToken !== 'string' || !r.accessToken || !(vence > Date.now())) {
        throw new Error('lib-sessao-az: o az devolveu uma resposta que não é JSON, sem token ou sem expires_on válido');
      }
      atual = { token: r.accessToken, expiresOnTimestamp: vence };
      return atual;
    },
  };
}

function credencial() {
  return process.env.DADOS_STORAGE ? 'chave' : 'sessao-az';
}

/* um token por processo: a ponte de PPC abre o contêiner a cada arquivo */
let SESSAO = null;
function conteinerLocal(nome, conta) {
  if (!nome) throw new Error('lib-sessao-az: conteinerLocal() sem nome');
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (credencial() === 'chave') return BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(nome);
  const url = 'https://' + (conta || CONTA_PADRAO) + '.blob.core.windows.net';
  return new BlobServiceClient(url, SESSAO || (SESSAO = credencialAz())).getContainerClient(nome);
}

module.exports = { conteinerLocal, credencial, _usaAz: (f) => { az = f; SESSAO = null; }, _credencialAz: credencialAz };
