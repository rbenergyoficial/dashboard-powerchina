'use strict';
/*
 * gen-sager-painel.js — o Painel SAGER-ONS do portal (lote painel-sager-ons, 06/11/2026). A regra esta em `lib-sager-painel.js`.
 *
 * Le: `RelatorioGeral_MRT_Historico.xlsx` (a versao mais nova, no `backup-dados-scada`), `cmp_30min.json`, `ons_restricao_AAAA_MM.json`,
 * `ons_irradiancia_AAAA_MM.json`, `estacao_logger_30min.json` e `sg_disp_dia.json`.
 * Le tambem o proprio `sager_painel.json` da rodada anterior: dele vem o registro do que ja foi contestado (painel-sager-ons-v2).
 * Grava: `sager_painel.json` (indice por dia, resumo e conferencia) e `hist/sager_painel_AAAA_MM.json` (o mes por patamar).
 * O relatorio do mes aberto muda; os meses fechados so sao regravados se o conteudo mudou.
 *
 * Env: a credencial pela lib-conteiner · RAW=backup-dados-scada · OUT=dados · LOCAL_FILE=<xlsx> · LOCAL_DIR=<pasta com os json> · LOCAL_OUT_DIR=<pasta>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./lib-sager-painel');
const S = require('./lib-sager-disp');
const { maisNova, CAP } = require('./gen-sager-disp');

const RAW = process.env.RAW || 'backup-dados-scada', OUT = process.env.OUT || 'dados', PREFIXO = 'SAGER_ONS/Historico/', BASE = 'RelatorioGeral_MRT_Historico.xlsx';
const conteiner = (n) => require('./lib-conteiner').conteiner(n);
const CAPU = Object.fromEntries(Object.entries(CAP));
const parse = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8'));

async function lePublico(n) {
  if (process.env.LOCAL_DIR) { const p = path.join(process.env.LOCAL_DIR, n.replace(/\//g, '__')); return fs.existsSync(p) ? parse(fs.readFileSync(p)) : null; }
  try { return parse(await conteiner(OUT).getBlockBlobClient(n).downloadToBuffer()); }
  catch (e) { if (e.statusCode === 404) return null; throw e; }
}
async function leRelatorio() {
  if (process.env.LOCAL_FILE) return fs.readFileSync(process.env.LOCAL_FILE);
  const c = conteiner(RAW), nomes = [];
  for await (const b of c.listBlobsFlat({ prefix: PREFIXO + BASE })) nomes.push(b.name);
  const n = maisNova(nomes);
  if (!n) throw new Error('nenhuma versao de ' + BASE + ' em ' + RAW);
  return c.getBlobClient(n).downloadToBuffer();
}
async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome.replace(/\//g, '__')), gz); return gz.length; }
  await conteiner(OUT).getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

async function main() {
  const serie = L.leRelatorio(S.leXlsx(await leRelatorio(), 'Patamares'));
  const ms = [...new Set(serie.map((s) => s.t.slice(0, 7)))].sort();
  const F = { serie, cap: CAPU, gerado: new Date().toISOString(), ons: { restricao: [], irradiancia: [] } };
  [F.cmp, F.est, F.sg, F.anterior] = await Promise.all(['cmp_30min.json', 'estacao_logger_30min.json', 'sg_disp_dia.json', 'sager_painel.json'].map(lePublico));   // anterior: o registro da contestacao (painel-sager-ons-v2)
  if (!F.cmp) throw new Error('cmp_30min.json ausente: sem ele nao ha medidor nem supervisorio');
  for (const m of ms) {
    const a = m.replace('-', '_');
    const [r, i] = await Promise.all([lePublico('ons_restricao_' + a + '.json'), lePublico('ons_irradiancia_' + a + '.json')]);
    if (!r || !i) throw new Error('dados abertos do ONS ausentes em ' + m);
    F.ons.restricao.push(r); F.ons.irradiancia.push(i);
  }
  const o = L.compoe(F);
  let kb = 0;
  for (const m of o.meses) {
    const nome = 'hist/sager_painel_' + m.mes.replace('-', '_') + '.json', ant = await lePublico(nome);
    if (ant && JSON.stringify(ant) === JSON.stringify(m)) continue;
    kb += await escreve(nome, m);
  }
  kb += await escreve('sager_painel.json', o.indice);
  const r = o.indice.resumo;
  console.log('sager_painel.json: ' + o.indice.de + ' a ' + o.indice.ate + ' · ' + r.dias + ' dias · SAGER/medidor ' + r.s_w_pct + ' % · supervisorio/medidor ' + r.k_w_pct + ' % em ' + r.dias_scada + ' dias · ' + Math.round(kb / 1024) + ' KB gravados');
}

if (require.main === module) main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
module.exports = { main };
