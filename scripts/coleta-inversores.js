/*
 * coleta-inversores.js — a ponte entre a pasta de inversores substituidos e o contêiner que o
 * `gen-inversores` le. Roda na maquina do operador, no mesmo padrao do `coleta-ppc.js`.
 *
 * Substitui o fluxo pago do Power Automate que sobe as planilhas da equipe para o contêiner
 * `inversores-raw` (lote `pa-inversores` do plano de desligamento, Premium ate 09/11/2026). A pasta
 * vive no OneDrive de OUTRO locatario e ja esta sincronizada nesta maquina; a ponte do Azure nao a
 * enxerga. Entao esta maquina e a ponte.
 *
 * 🔴 O NOME NO CONTÊINER E O NOME DO ARQUIVO, CRU, SEM PASTA E SEM CARIMBO. E o que o fluxo grava
 *    (medido em 20/10/2026: 16 blobs, todos com o nome exato do arquivo, e a planilha viva com o
 *    MESMO SHA-256 do arquivo local). O `coleta-ppc` prefixa um carimbo; aqui seria um defeito: o
 *    `gen-inversores` escolhe a versao pela data do blob e reconhece rascunho pelo NOME, e cada
 *    envio com carimbo viraria um blob novo ao lado do que o fluxo deixou. Blob que ja existe e
 *    regravado com o nome que TEM no contêiner (a comparacao de nomes e em NFC, a gravacao nao).
 *
 * 🔴 SO A RAIZ DA PASTA, SO .xlsx E .xlsm, NUNCA `~$` (o bloqueio do Excel aberto). A subpasta
 *    `Old` e onde a equipe guarda o que saiu de uso; o contêiner tem as versoes velhas porque elas
 *    passaram pela raiz quando eram vigentes. O fluxo aceitava qualquer nome que CONTIVESSE ".xls";
 *    o `gen-inversores` so le `.xls[xm]`, entao o resto (o .xls antigo, que nem e ZIP) fica de fora
 *    com AVISO no log, sem pintar a rodada de vermelho: subir o que ninguem le nao ajuda ninguem.
 *
 * 🔴 A COMPARACAO E POR CONTEUDO CONTRA O CONTÊINER, NAO CONTRA UM ESTADO LOCAL. Um estado local
 *    ("ja mandei este hash") mente quando outro escritor regrava o blob — e ate o fluxo ser
 *    desligado ha dois. O SHA-256 do blob vem da METADADO `sha256` que este coletor grava; blob sem
 *    ela (os do fluxo) e baixado e medido UMA vez por etag (cache local, so de hash).
 *
 * 🔴 O ENVIO E CONDICIONAL: sobrescreve so o blob que foi comparado (If-Match no etag lido) e cria
 *    so se ninguem criou no meio (If-None-Match *). Se o fluxo gravou entre a leitura e o envio, o
 *    envio falha e a proxima rodada compara de novo. Depois do envio, o tamanho e o sha256 do blob
 *    sao relidos e conferidos. Nunca apaga nada do contêiner.
 *
 * 🔴 PLANILHA PELA METADE NAO SOBE. O arquivo tem de ser um ZIP inteiro: assinatura local no
 *    inicio, o fim do diretorio central terminando EXATAMENTE no fim do arquivo, e o diretorio
 *    central inteiro logo antes dele (um corte no meio que preserve o fim desloca o diretorio).
 *    Senao a rodada falha e tenta de novo na proxima. O `gen-inversores` pula planilha ilegivel e
 *    ficaria com a versao velha sem ninguem ver.
 *
 * ⚠️ NADA DE SEGREDO NESTE ARQUIVO, e o repositorio e publico: a pasta vem de `--pasta=` ou de
 *    `INV_PASTA`; o acesso e o token que a sessao local da nuvem emite na hora (`lib-sessao-az`,
 *    desde 28/10/2026 sem a chave da conta) e morre com o processo. O token nunca e impresso.
 *
 * uso:  node scripts/coleta-inversores.js --pasta=<pasta>            SECO (padrao): so lista
 *       node scripts/coleta-inversores.js --pasta=<pasta> --enviar   envia o que mudou
 *       env: INV_PASTA, RAW_CONTAINER (inversores-raw), INV_CONTA (rbenergydata),
 *            INV_CACHE, INV_LOG (padrao em %LOCALAPPDATA%)
 *       saida: 0 limpo; 1 com falha (pasta, raiz sem planilha, ZIP pela metade, envio recusado)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONTAINER = process.env.RAW_CONTAINER || 'inversores-raw';
const CONTA = process.env.INV_CONTA || 'rbenergydata';
const BASE = process.env.LOCALAPPDATA || process.env.TMPDIR || '.';

/* o que o gerador le: .xlsx e .xlsm; o `~$` e o arquivo de bloqueio do Excel aberto */
const entra = (nome) => /\.xls[xm]$/i.test(nome) && !/^~\$/.test(nome);
/* o que o fluxo subia e o gerador nao le (.xls antigo, .xlsb, copia .bak): fica de fora, com aviso */
const avisa = (nome) => /\.xls/i.test(nome) && !/^~\$/.test(nome) && !entra(nome);

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/* o tipo que o fluxo gravou, pela extensao (o .xlsm vai como planilha com macro) */
function tipoDe(nome) {
  if (/\.xlsm$/i.test(nome)) return 'application/vnd.ms-excel.sheet.macroEnabled.12';
  if (/\.xlsx$/i.test(nome)) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  return 'application/octet-stream';
}

/* ZIP inteiro: assinatura de arquivo local no inicio; o fim do diretorio central (EOCD) nos ultimos
   64 KB + 22 bytes terminando no fim do arquivo (o comentario tem no maximo 65535 bytes); e o
   diretorio central (offset + tamanho declarados no EOCD) acabando onde o EOCD comeca */
function zipInteiro(buf) {
  if (!buf || buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return false;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const tamCD = buf.readUInt32LE(i + 12), iniCD = buf.readUInt32LE(i + 16);
    return i + 22 + buf.readUInt16LE(i + 20) === buf.length
      && iniCD + tamCD === i
      && iniCD + 4 <= buf.length && buf.readUInt32LE(iniCD) === 0x02014b50;
  }
  return false;
}

/* os arquivos da RAIZ da pasta, com o conteudo e o hash; e os nomes que ficam de fora com aviso */
function locais(pasta) {
  const nomes = fs.readdirSync(pasta).filter((n) => fs.statSync(path.join(pasta, n)).isFile());
  const L = nomes.filter((n) => entra(n)).sort()
    .map((n) => { const bytes = fs.readFileSync(path.join(pasta, n));
      return { nome: n.normalize('NFC'), bytes, sha: sha256(bytes), inteiro: zipInteiro(bytes) }; });
  return { L, foraComAviso: nomes.filter((n) => avisa(n)).sort() };
}

const semAspas = (e) => String(e || '').replace(/"/g, '');

/* a chave do cache de hash e o nome COM o etag: o blob regravado por outro escritor muda de etag e
   e medido de novo (por nome so, o hash velho diria "igual" a um conteudo que ja nao esta la) */
const chave = (nome, etag) => nome + '|' + etag;

/* o que esta no contêiner: nome em NFC -> nome gravado, etag (sem aspas) e o sha256 da metadado */
async function remotos(cont) {
  const m = new Map();
  for await (const b of cont.listBlobsFlat({ includeMetadata: true })) {
    m.set(b.name.normalize('NFC'), { blob: b.name, etag: semAspas(b.properties.etag), sha: (b.metadata || {}).sha256 || null });
  }
  return m;
}

/* o plano: o que subiria e por que. Nao escreve nada no contêiner. */
async function planeja({ pasta, cont, cache }) {
  const { L, foraComAviso } = locais(pasta);
  if (!L.length) throw new Error('nenhuma planilha (.xlsx ou .xlsm) na raiz de ' + pasta
    + '. Enviar nada seria pior que falhar: o gerador continuaria com a versao velha achando que esta fresca.');
  const R = await remotos(cont);
  let baixados = 0;
  const itens = [];
  for (const a of L) {
    const r = R.get(a.nome);
    if (!a.inteiro) { itens.push({ ...a, acao: 'incompleto', etag: r ? r.etag : null, destino: r ? r.blob : a.nome }); continue; }
    if (!r) { itens.push({ ...a, acao: 'novo', etag: null, shaR: null, destino: a.nome }); continue; }
    let shaR = r.sha || cache[chave(a.nome, r.etag)] || null;
    if (!shaR) {
      shaR = sha256(await cont.getBlobClient(r.blob).downloadToBuffer());
      baixados += 1;
    }
    cache[chave(a.nome, r.etag)] = shaR;
    itens.push({ ...a, acao: a.sha === shaR ? 'igual' : 'alterado', etag: r.etag, shaR, destino: r.blob });
  }
  const nomesL = new Set(L.map((a) => a.nome));
  /* o cache so guarda o etag vigente de cada blob: etag que mudou nao volta */
  const vivos = new Set([...R].map(([n, r]) => chave(n, r.etag)));
  for (const k of Object.keys(cache)) if (!vivos.has(k)) delete cache[k];
  return { itens, baixados, foraComAviso, soNoConteiner: [...R.keys()].filter((n) => !nomesL.has(n)).sort() };
}

/* sobe UM item com o nome do destino, condicionado ao etag comparado, e confere o que ficou */
async function envia(cont, it) {
  const bb = cont.getBlockBlobClient(it.destino);
  await bb.uploadData(it.bytes, {
    blobHTTPHeaders: { blobContentType: tipoDe(it.nome) },
    metadata: { sha256: it.sha },
    conditions: it.etag ? { ifMatch: '"' + it.etag + '"' } : { ifNoneMatch: '*' },
  });
  const p = await bb.getProperties();
  if (p.contentLength !== it.bytes.length || (p.metadata || {}).sha256 !== it.sha) {
    throw new Error('o blob gravado nao confere com o arquivo (tamanho ou sha256)');
  }
}

/* uma rodada inteira. enviar=false (SECO) nunca chama o envio. Devolve o resumo; `falhas` > 0 = vermelho. */
async function roda({ pasta, cont, enviar, cache, diz }) {
  const say = diz || ((s) => console.log(s));
  const P = await planeja({ pasta, cont, cache });
  let falhas = 0, enviados = 0;
  const subir = P.itens.filter((i) => i.acao === 'novo' || i.acao === 'alterado');
  for (const n of P.foraComAviso) say('  ? ' + n + ' fica de fora: nao e .xlsx nem .xlsm, e o gerador nao o le');
  for (const i of P.itens) {
    const kb = Math.round(i.bytes.length / 1024) + ' KB';
    if (i.acao === 'igual') { say('  = ' + i.nome + ' (igual ao contêiner, ' + kb + ')'); continue; }
    if (i.acao === 'incompleto') { falhas += 1; say('  ! ' + i.nome + ' NAO e um ZIP inteiro (salvando ou sincronizando?): nao sobe, ' + kb); continue; }
    say('  + ' + i.nome + ' (' + i.acao + ', ' + kb + (i.shaR ? ', contêiner ' + i.shaR.slice(0, 12) : '') + ' -> local ' + i.sha.slice(0, 12) + ')');
    if (!enviar) continue;
    try { await envia(cont, i); enviados += 1; say('    enviado: ' + i.destino); }
    catch (e) { falhas += 1; say('    FALHOU o envio de ' + i.nome + ': ' + String(e.message || e).replace(/\s+/g, ' ').slice(0, 160)); }
  }
  if (P.soNoConteiner.length) say('  (so no contêiner, nao se mexe: ' + P.soNoConteiner.length + ' blob(s))');
  say((enviar ? 'ENVIO' : 'SECO') + ' · ' + P.itens.length + ' planilha(s) na raiz · ' + subir.length + ' a subir'
    + (enviar ? ' · ' + enviados + ' enviada(s)' : ' (nada enviado)') + ' · ' + P.baixados + ' blob(s) baixado(s) para medir'
    + (P.foraComAviso.length ? ' · ' + P.foraComAviso.length + ' fora com aviso' : '')
    + (falhas ? ' · ' + falhas + ' FALHA(S)' : ''));
  return { subir: subir.map((i) => i.nome), acoes: P.itens.map((i) => [i.nome, i.acao]), enviados, falhas, baixados: P.baixados,
    soNoConteiner: P.soNoConteiner, foraComAviso: P.foraComAviso };
}

module.exports = { entra, avisa, tipoDe, zipInteiro, locais, planeja, envia, roda, CONTAINER };

if (require.main === module) {
  const arg = (k) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : null; };
  const enviar = process.argv.includes('--enviar');
  const pasta = arg('pasta') || process.env.INV_PASTA || '';
  const ARQ_CACHE = process.env.INV_CACHE || path.join(BASE, 'coleta-inversores-cache.json');
  const ARQ_LOG = process.env.INV_LOG || path.join(BASE, 'coleta-inversores.log');
  const linhas = [];
  const diz = (s) => { console.log(s); linhas.push(s); };
  const registra = () => { try { fs.appendFileSync(ARQ_LOG, '[' + new Date().toISOString() + '] ' + linhas.join('\n  ') + '\n'); } catch (e) { /* log e conveniencia */ } };
  (async () => {
    if (!pasta) throw new Error('sem --pasta= nem INV_PASTA: nao ha de onde ler. Sem valor embutido de proposito.');
    if (!fs.existsSync(pasta)) throw new Error('a pasta nao existe ou nao esta sincronizada: ' + pasta);
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(ARQ_CACHE, 'utf8')); } catch (e) { cache = {}; }
    const cont = require('./lib-sessao-az').conteinerLocal(CONTAINER, CONTA);
    diz((enviar ? 'ENVIO' : 'SECO (nada sobe; --enviar para enviar)') + ' · ' + pasta + ' -> ' + CONTAINER);
    const r = await roda({ pasta, cont, enviar, cache, diz });
    try { fs.writeFileSync(ARQ_CACHE, JSON.stringify(cache, null, 1)); } catch (e) { /* o cache so poupa download */ }
    registra();
    process.exit(r.falhas ? 1 : 0);
  })().catch((e) => { diz('FALHOU: ' + e.message); registra(); process.exit(1); });
}
