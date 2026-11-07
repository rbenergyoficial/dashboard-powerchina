#!/usr/bin/env node
/* boletim-blobs.js · o transporte do Boletim de Desempenho no pipeline, pelo contêiner `dados`.
 *   node scripts/boletim-blobs.js baixa <pasta> leve     o que decide a rodada: estado, fila, índice, os dois arquivos do ONS, catálogo
 *   node scripts/boletim-blobs.js baixa <pasta> pesado   o que gera o boletim: executivo, PR, disponibilidade, irradiação, medição, logotipo
 *   node scripts/boletim-blobs.js sobe  <pasta>          <pasta>/saida/boletim/** para dados/boletim/**, nesta ordem: edições, enviados e
 *                                                        fatos; depois fila.json, indice.json e estado.json (quem lê a fila acha os arquivos)
 * Credencial: a do pipeline (lib-conteiner, OIDC). Na máquina, só para LER, o SAS de leitura em DADOS_SAS (nunca impresso); `sobe` com
 * ele recusa. Os blobs vêm em gzip (Content-Encoding) e o SDK não descomprime: o que começa em 1f 8b é descomprimido e gravado puro.
 * Entrada obrigatória ausente = erro (sai 1). Opcional ausente (404 BlobNotFound) segue: o estado/fila/índice da primeira rodada e os
 * arquivos do ONS (o do mês corrente não existe nos primeiros dias do mês). */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');

const LEVE = { exige: ['acervo/catalogo.json'], opcional: ['boletim/estado.json', 'boletim/fila.json', 'boletim/indice.json'] };
const PESADO = { exige: ['executivo.json', 'pr_ufv.json', 'sg_disp_dia.json', 'irr_ufv.json', 'benchmark_ne.json', 'way2_30min.json',
  'irr_plano_30min.json'], opcional: [] };   // o logotipo do cabeçalho vem do repositório (scripts/boletim/logo_intrepid_800.png)
const ULTIMOS = ['boletim/fila.json', 'boletim/indice.json', 'boletim/estado.json'];   // sobem por último, nesta ordem
const TIPO = { '.json': 'application/json', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.pdf': 'application/pdf', '.mp4': 'video/mp4' };

let CONT = null;   // o ensaio injeta um contêiner falso
function abre(modo) {
  if (CONT) return CONT;
  const temOidc = process.env.AZURE_CLIENT_ID && process.env.AZURE_TENANT_ID;
  if (!temOidc && process.env.DADOS_SAS) {
    if (modo !== 'ler') throw new Error('com o SAS de leitura só se baixa; subir é do pipeline');
    const { ContainerClient } = require('@azure/storage-blob');
    const conta = process.env.DADOS_CONTA_URL || 'https://rbenergydata.blob.core.windows.net';
    return new ContainerClient(conta + '/dados?' + String(process.env.DADOS_SAS).replace(/^\?/, ''));
  }
  return require('./lib-conteiner').conteiner('dados');
}

function meses(agora) {   // o mês corrente e o anterior, em Brasília (os arquivos do ONS que o boletim lê)
  const b = new Date(agora.getTime() - 3 * 3600e3), m = (d) => `${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const ant = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() - 1, 1));
  return [m(b), m(ant)].map((x) => `ons_restricao_${x}.json`);
}

function listas(grupo, agora) {
  if (grupo === 'leve') return { exige: LEVE.exige, opcional: [...LEVE.opcional, ...meses(agora)] };
  if (grupo === 'pesado') return PESADO;
  throw new Error('grupo desconhecido: ' + grupo + ' (leve|pesado)');
}

const ausente = (e) => !!e && e.statusCode === 404 && (e.code === 'BlobNotFound' || (e.details && e.details.errorCode === 'BlobNotFound'));
const descomprime = (b) => (b.length > 1 && b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);

async function baixa(pasta, grupo, agora) {
  const { exige, opcional } = listas(grupo, agora || new Date());
  const c = abre('ler');
  fs.mkdirSync(pasta, { recursive: true });
  for (const nome of [...exige, ...opcional]) {
    const dest = path.join(pasta, nome.replace(/\//g, '__'));
    let buf;
    try { buf = await c.getBlobClient(nome).downloadToBuffer(); }
    catch (e) {
      if (ausente(e) && opcional.includes(nome)) { console.log('sem', nome, '(opcional)'); continue; }
      throw new Error('entrada do boletim ausente ou ilegível: ' + nome + ' (' + (e.code || (e.details && e.details.errorCode) || e.statusCode || e.message) + ')');
    }
    const puro = descomprime(buf);
    if (nome.endsWith('.json')) JSON.parse(puro.toString('utf8').replace(/^﻿/, ''));   // JSON quebrado para aqui, não na rodada
    fs.writeFileSync(dest, puro);
    console.log('baixado', nome, puro.length, 'bytes' + (puro !== buf ? ' (gzip)' : ''));
  }
}

function lista(raiz) {
  const out = [];
  if (!fs.existsSync(raiz)) return out;
  for (const n of fs.readdirSync(raiz, { withFileTypes: true })) {
    const p = path.join(raiz, n.name);
    if (n.isDirectory()) out.push(...lista(p)); else out.push(p);
  }
  return out;
}

function ordem(nomes) {   // edições, enviados e fatos primeiro (em ordem estável); fila, índice e estado por último, nesta ordem
  const resto = nomes.filter((n) => !ULTIMOS.includes(n)).sort();
  return [...resto, ...ULTIMOS.filter((n) => nomes.includes(n))];
}

async function sobe(pasta) {
  const raiz = path.join(pasta, 'saida');
  const nomes = lista(path.join(raiz, 'boletim')).map((f) => path.relative(raiz, f).split(path.sep).join('/'));
  for (const nome of nomes) if (!/^boletim\/[A-Za-z0-9_./-]+$/.test(nome) || nome.includes('..')) throw new Error('nome fora de boletim/: ' + nome);
  const c = abre('gravar');
  let n = 0;
  for (const nome of ordem(nomes)) {
    const tipo = TIPO[path.extname(nome)] || 'application/octet-stream';
    await c.getBlockBlobClient(nome).uploadFile(path.join(raiz, nome), { blobHTTPHeaders: { blobContentType: tipo } });
    n += 1;
  }
  console.log('subidos', n, 'arquivo(s) para dados/boletim/');
}

if (require.main === module) {
  const [, , cmd, pasta, grupo] = process.argv;
  (cmd === 'baixa' && pasta ? baixa(pasta, grupo) : cmd === 'sobe' && pasta ? sobe(pasta) : Promise.reject(new Error('uso: baixa <pasta> leve|pesado | sobe <pasta>')))
    .catch((e) => { console.error('::error::' + e.message); process.exit(1); });
}

module.exports = { meses, listas, ausente, descomprime, ordem, baixa, sobe, LEVE, PESADO, _usaConteiner: (c) => { CONT = c; } };
