/*
 * gen-ppc.js — o registro da mesa de operacao vira dado. `ppc_restricao.json`.
 *
 * A mesa anota, planilha adentro, a potencia solicitada pelo operador nacional no minuto em que
 * ela muda, com o motivo e o estado de cada usina. Ate hoje esse registro so existia dentro de um
 * arquivo, e por isso nao chegava a painel nenhum nem podia ser conferido contra o dado aberto.
 *
 * ── DE ONDE VEM ──────────────────────────────────────────────────────────────────────────────
 *   FONTE=blob   (padrao)   le o container `ppc-raw`, alimentado pelo coletor local
 *   LOCAL_DIR=<pasta>       le de uma pasta local — e o modo EXERCITAVEL, e o que o ensaio usa
 *
 * 🔴 LE TODOS OS ARQUIVOS QUE CASAM O PREFIXO, E FUNDE — nunca um nome exato.
 *    O arquivo se chama `Mauriti_Historico_PPC   <data>.xlsx`, com a data embutida e tres espacos
 *    no meio. Quando a mesa abrir um arquivo novo, o nome muda; um coletor ancorado no nome de
 *    hoje pararia em silencio, que e exatamente o que custou 19 dias de solarimetria parada
 *    (`IRR` x `IIRR` x `IRR_GERAL`). Fundir tambem preserva o passado quando o arquivo vigente
 *    passa a cobrir so o periodo novo.
 *
 * 🔴 A RODADA NOVA GANHA NA COLISAO, e isso nao e detalhe: a planilha e preenchida AO LONGO do
 *    turno. O dia corrente esta sempre incompleto, e a linha das ultimas horas costuma estar sem
 *    cenario e sem motivo. Congelar a primeira leitura de um dia repetiria o defeito do
 *    `must_diario`, em que um dia parcial virou permanente e a pagina afirmou que as nove usinas
 *    ficaram paradas o dia inteiro.
 *
 * ⚠️ O QUE ESTE BLOB NAO E: uma medicao de energia. Ele registra a ORDEM (o limite solicitado em
 *    MW) e o que a mesa aplicou — nao o que a usina gerou. Quem mede energia continua sendo o
 *    medidor de faturamento.
 */
'use strict';
const zlib = require('zlib');
const XLSX = require('xlsx');
const P = require('./lib-ppc.js');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'ppc-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const LOCAL_DIR = process.env.LOCAL_DIR || '';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const PREFIXO = /mauriti_historico_ppc/i;                 // por PREFIXO, nunca por nome exato
const JANELA_DIAS = Number(process.env.PPC_JANELA || 730);

async function puxa(url) {
  const https = require('https');
  return new Promise((ok, erro) => {
    https.get(url, (r) => {
      if (r.statusCode !== 200) { erro(new Error('HTTP ' + r.statusCode)); r.resume(); return; }
      const p = [];
      r.on('data', (c) => p.push(c));
      r.on('end', () => {
        let b = Buffer.concat(p);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        try { ok(JSON.parse(b.toString('utf8'))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); }
      });
    }).on('error', erro);
  });
}

// 🔴 SO O 404 DEVOLVE VAZIO. Falha de rede tratada como ausencia faz o gerador achar que e a
//    primeira execucao e regravar o blob so com o que a rodada leu — apagando o historico sem
//    erro visivel. E a licao que o `leBlob` do MUST e o leitor do ONS ja pagaram.
async function leAnterior(nome) {
  try {
    const j = await puxa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
    return Array.isArray(j.eventos) ? j.eventos : [];
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return [];
    throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: '
      + 'regravar sem o historico apagaria o que ja foi acumulado.');
  }
}

async function listaArquivos() {
  if (LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    return fs.readdirSync(LOCAL_DIR)
      .filter((f) => /\.xlsx$/i.test(f) && !/^~/.test(f) && PREFIXO.test(f))
      .sort()
      .map((f) => ({ nome: f, quando: fs.statSync(path.join(LOCAL_DIR, f)).mtime.toISOString(),
        leia: async () => fs.readFileSync(path.join(LOCAL_DIR, f)) }));
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('sem DADOS_STORAGE e sem LOCAL_DIR: nao ha de onde ler');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW_CONTAINER);
  const out = [];
  for await (const b of c.listBlobsFlat()) {
    if (!/\.xlsx$/i.test(b.name) || !PREFIXO.test(b.name)) continue;
    out.push({ nome: b.name, quando: (b.properties.lastModified || new Date()).toISOString(),
      leia: async () => {
        const d = await c.getBlobClient(b.name).download();
        const p = [];
        for await (const ch of d.readableStreamBody) p.push(ch);
        return Buffer.concat(p);
      } });
  }
  // o carimbo do nome e monotonico por construcao, entao a ordem alfabetica e a cronologica
  out.sort((a, b) => (a.nome < b.nome ? -1 : a.nome > b.nome ? 1 : 0));
  return out;
}

async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(LOCAL_OUT_DIR, nome), gz);
    return gz.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await c.createIfNotExists();
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

(async () => {
  const arqs = await listaArquivos();
  if (!arqs.length) throw new Error('nenhum arquivo casando o prefixo em ' + (LOCAL_DIR || RAW_CONTAINER)
    + '. Publicar vazio apagaria o registro — abortando.');

  // funde na ordem cronologica: o arquivo mais novo ganha na colisao de carimbo
  const porTs = new Map();
  const defeitos = [];
  let lidos = 0;
  for (const a of arqs) {
    const buf = await a.leia();
    const { ev, def, vazias } = P.leEventos(XLSX, buf);
    lidos += 1;
    console.log('  ' + a.nome + ': ' + ev.length + ' eventos · ' + def.length + ' defeito(s) · ' + vazias + ' linha(s) vazia(s)');
    for (const e of ev) porTs.set(e.ts, e);
    for (const d of def) defeitos.push(Object.assign({ arquivo: a.nome }, d));
  }

  // e com o que ja estava publicado: o historico nao mora so no arquivo vigente
  const antes = await leAnterior('ppc_restricao.json');
  const m = new Map();
  for (const e of antes) m.set(e.ts, e);
  let novos = 0;
  for (const [ts, e] of porTs) { if (!m.has(ts)) novos += 1; m.set(ts, e); }

  let eventos = [...m.values()].sort((a, b) => a.ms - b.ms);
  const dias = [...new Set(eventos.map((e) => e.dia || String(e.ts).slice(0, 10)))].sort();
  const corte = dias.slice(-JANELA_DIAS)[0];
  eventos = eventos.filter((e) => (e.dia || String(e.ts).slice(0, 10)) >= corte);

  // o resumo por dia, que e o que o painel le para nao baixar a serie inteira
  const porDia = new Map();
  for (const e of eventos) {
    const d = e.dia || String(e.ts).slice(0, 10);
    if (!porDia.has(d)) porDia.set(d, { dia: d, eventos: 0, restritos: 0, primeiro: null, ultimo: null,
      pot_min: null, cods: new Set(), tecnicos: new Set() });
    const x = porDia.get(d);
    x.eventos += 1;
    if (e.restr) {
      x.restritos += 1;
      if (x.pot_min == null || e.pot < x.pot_min) x.pot_min = e.pot;
      if (e.motivo_cod) x.cods.add(e.motivo_cod);
    }
    if (!x.primeiro) x.primeiro = String(e.ts).slice(11);
    x.ultimo = String(e.ts).slice(11);
    if (e.tecnico) x.tecnicos.add(e.tecnico);
  }
  const resumo = [...porDia.values()].map((x) => ({ dia: x.dia, eventos: x.eventos, restritos: x.restritos,
    primeiro: x.primeiro, ultimo: x.ultimo, pot_min: x.pot_min == null ? null : Math.round(x.pot_min * 100) / 100,
    motivo_cods: [...x.cods].sort(), tecnicos: [...x.tecnicos].sort() }));

  const out = {
    fonte: 'registro da mesa de operacao do controlador de potencia do complexo',
    grandeza: 'potencia solicitada pelo operador nacional, em MW, no instante em que muda',
    gerado_em: new Date().toISOString(),
    plena_mw: P.PLENA,
    janela_dias: JANELA_DIAS,
    dias_cobertos: resumo.length,
    arquivos_lidos: lidos,
    eventos,
    dias: resumo,
    defeitos,
  };

  const n = await grava('ppc_restricao.json', out);
  console.log('ppc_restricao.json: ' + eventos.length + ' eventos (' + novos + ' novos) · '
    + resumo.length + ' dias · ' + defeitos.length + ' defeito(s) · ' + Math.round(n / 1024) + ' KB gzipado');
  if (resumo.length) console.log('  de ' + resumo[0].dia + ' a ' + resumo[resumo.length - 1].dia);
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
