/*
 * coleta-ppc.js — a ponte entre a planilha da mesa e o pipeline. Roda na maquina do operador.
 *
 * A planilha vive num OneDrive corporativo que NAO e o mesmo locatario do resto da infraestrutura.
 * A decisao do humano em 12/09/2026 foi usar so recursos proprios: nada de credencial do outro
 * locatario, nada de fluxo no Power Automate — cuja licenca, alias, vence em 15/09/2026 e levaria
 * junto qualquer coisa construida sobre ela.
 *
 * Sobra o caminho mais simples e inteiramente nosso: a pasta ja esta sincronizada nesta maquina,
 * entao esta maquina e a ponte. O arquivo sobe CRU para o container, e quem interpreta e o
 * gerador — o coletor nao le uma celula sequer.
 *
 * ⚠️ O CUSTO, DECLARADO: isto depende desta maquina estar ligada. Nao ha como cruzar os dois
 *    locatarios sem ela sem uma credencial que decidimos nao pedir. Se a maquina ficar dias fora,
 *    o blob para de receber versao nova — e quem denuncia isso e a idade do dado na propria
 *    auditoria, nao este script.
 *
 * 🔴 CASA POR PREFIXO, NUNCA POR NOME EXATO. O arquivo se chama `Mauriti_Historico_PPC   <data>`,
 *    com a data embutida e tres espacos no meio, e a mesa troca esse nome sem avisar — trocou no
 *    dia em que este coletor foi escrito, entre uma medicao e a seguinte. Um coletor ancorado no
 *    nome de ontem pararia em SILENCIO, que foi o que custou 19 dias de solarimetria parada.
 *
 * 🔴 O CARIMBO E UM PREPEND NUMERICO E MONOTONICO (`AAAAMMDDHHMMSS_`), o mesmo contrato do
 *    `gen-scada-intake`. Renomear o arquivo em vez de prefixar apagaria a marca que a mesa
 *    escreve no nome, e o consumidor nao tem como recuperar o que o coletor jogou fora.
 *
 * ⚠️ NADA DE SEGREDO NESTE ARQUIVO, e o repositorio e publico: a pasta vem de `PPC_PASTA` e a
 *    conexao de `DADOS_STORAGE`, as duas do ambiente. Caminho de rede, nome de locatario e chave
 *    nao entram em codigo versionado.
 *
 * uso:  PPC_PASTA=<pasta> DADOS_STORAGE=<conexao> node scripts/coleta-ppc.js
 *       SECO=1  ->  diz o que faria, sem enviar
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PASTA = process.env.PPC_PASTA || '';
const CONTAINER = process.env.RAW_CONTAINER || 'ppc-raw';
const PREFIXO = /mauriti_historico_ppc/i;
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');
const ESTADO = process.env.PPC_ESTADO
  || path.join(process.env.LOCALAPPDATA || process.env.TMPDIR || '.', 'coleta-ppc-estado.json');

const carimbo = (d) => d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0')
  + String(d.getHours()).padStart(2, '0') + String(d.getMinutes()).padStart(2, '0') + String(d.getSeconds()).padStart(2, '0');

(async () => {
  if (!PASTA) throw new Error('sem PPC_PASTA: nao ha de onde ler. Sem valor embutido de proposito.');
  if (!fs.existsSync(PASTA)) throw new Error('a pasta nao existe ou nao esta sincronizada: ' + PASTA);

  const arqs = fs.readdirSync(PASTA)
    .filter((f) => /\.xlsx$/i.test(f) && !/^~\$/.test(f) && PREFIXO.test(f))   // `~$` e o bloqueio do Excel aberto
    .map((f) => ({ f, p: path.join(PASTA, f), st: fs.statSync(path.join(PASTA, f)) }))
    .sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);

  if (!arqs.length) throw new Error('nenhum arquivo casando o prefixo em ' + PASTA
    + '. Enviar nada seria pior que falhar: o gerador continuaria com a versao velha achando que esta fresca.');

  let estado = {};
  try { estado = JSON.parse(fs.readFileSync(ESTADO, 'utf8')); } catch (e) { estado = {}; }

  let enviados = 0;
  for (const a of arqs) {
    const bytes = fs.readFileSync(a.p);
    const hash = crypto.createHash('sha256').update(bytes).digest('hex');
    /* o estado e por CONTEUDO, nao por data: o OneDrive toca o mtime ao sincronizar sem que uma
       celula mude, e reenviar por isso encheria o container de versoes identicas */
    if (estado[a.f] === hash) { console.log('  = ' + a.f + ' (sem mudanca)'); continue; }

    const nome = carimbo(new Date()) + '_' + a.f.replace(/\s+/g, ' ');
    console.log('  + ' + a.f + ' -> ' + nome + '  (' + Math.round(bytes.length / 1024) + ' KB)');
    if (SECO) { enviados += 1; continue; }

    if (!process.env.DADOS_STORAGE) throw new Error('sem DADOS_STORAGE: nao ha para onde enviar');
    const { BlobServiceClient } = require('@azure/storage-blob');
    const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(CONTAINER);
    await c.createIfNotExists();
    await c.getBlockBlobClient(nome).upload(bytes, bytes.length, { blobHTTPHeaders: {
      blobContentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });

    /* o estado so muda DEPOIS do envio dar certo — senao uma falha de rede marcaria como enviado
       o que nunca subiu, e a proxima rodada pularia o arquivo para sempre */
    estado[a.f] = hash;
    fs.writeFileSync(ESTADO, JSON.stringify(estado, null, 1));
    enviados += 1;
  }

  console.log(enviados ? (enviados + ' arquivo(s) ' + (SECO ? 'seriam enviados' : 'enviados') + ' para ' + CONTAINER)
    : 'nada mudou desde a ultima passada.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
