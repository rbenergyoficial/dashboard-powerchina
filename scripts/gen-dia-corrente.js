/* gen-dia-corrente.js — mantem a LINHA DO DIA EM CURSO fresca no executivo.json.
 *
 * Por que existe: o executivo declara 15 execucoes/dia no cron e o agendador do GitHub
 * entrega 5,6 (medido em 45 execucoes: mediana 91 min entre elas, p90 615 min). O snapshot
 * de 5 min da Way2, por outro lado, e disparado por fora e chega a cada 5 minutos exatos.
 * Entao o dado existe quase ao vivo e so nao chegava a tela.
 *
 * O que faz: le o snapshot de hoje, aplica o MESMO rollup do arquivador (rollupDia, que ja
 * desconta o consumo — a equacao da casa) e regrava SO as linhas de hoje de `serie_dia_ufv`.
 * Custa uma leitura e uma escrita; roda dentro do job de 5 minutos.
 *
 * 🔴 CONCORRENCIA: o executivo reescreve o blob inteiro a cada ~2 h. Sem controle, um patch
 * montado sobre uma leitura velha desfaria essa reescrita e o estrago duraria ate a proxima
 * (horas). A gravacao vai com `If-Match` no ETag lido: se o blob mudou no meio, o Azure
 * recusa com 412, este job desiste e a proxima rodada (5 min) refaz sobre o estado novo.
 *
 * Env: DADOS_STORAGE · BASE (url publica) · LOCAL_OUT p/ ensaio sem gravar.
 */
const https = require('https');
const zlib = require('zlib');
const { BlobServiceClient } = require('@azure/storage-blob');
const { rollupDia, valores: valoresW2 } = require('./gen-way2-hist.js');

const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const BLOB = process.env.OUT_BLOB || 'executivo.json';
const BASE = process.env.BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const UFVS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);

function baixa(url) {
  return new Promise((ok, err) => https.get(url, { family: 4 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return err(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
    const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => {
      let x = Buffer.concat(b);
      if (x[0] === 0x1f && x[1] === 0x8b) { try { x = zlib.gunzipSync(x); } catch (e) { return err(e); } }
      try { ok(JSON.parse(x.toString('utf8').replace(/^﻿/, ''))); } catch (e) { err(e); }
    });
  }).on('error', err));
}

(async () => {
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  let snap;
  try { snap = await baixa(BASE + 'hist/way2_' + hoje + '.json'); }
  catch (e) { console.log('snapshot de ' + hoje + ' indisponivel (' + e.message + ') — nada a fazer'); return; }

  const linha = rollupDia(snap, hoje);
  if (!(linha.slots > 0)) { console.log('snapshot de ' + hoje + ' sem slots — nada a fazer'); return; }
  const g = valoresW2(snap, 6233, 'Demat').filter((v) => v.valor != null);
  linha.ate = g.length ? String(g[g.length - 1].data).slice(11, 16) : null;
  if (!linha.ate) { console.log('snapshot sem instante util — nada a fazer'); return; }

  const n1 = valoresW2(snap, 6196, 'Demat').filter((v) => v.valor != null).length;
  const n2 = valoresW2(snap, 6197, 'Demat').filter((v) => v.valor != null).length;
  if (Math.abs(n1 - n2) > 1) {
    console.log('trafos com cobertura diferente (TR1 ' + n1 + ', TR2 ' + n2 + ') — a soma sairia curta, abortando');
    return;
  }

  // por entidade, a MESMA regra do executivo: grupo e a soma dos membros, o conjunto vem
  // do rollup dos dois transformadores (nao da soma das nove, que e outra grandeza).
  const uf = linha.ufv_liq_mwh || {};
  const soma = (us) => us.reduce((a, u) => a + num(uf[u]), 0);
  const val = { Complexo: num(linha.ene_liq_mwh), PPA: soma(PPA), ML: soma(ML) };
  UFVS.forEach((u) => { val[u] = num(uf[u]); });

  const conn = process.env.DADOS_STORAGE;
  if (!conn && !process.env.LOCAL_OUT) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }

  if (process.env.LOCAL_OUT) {
    console.log('[ensaio] ' + hoje + ' ate ' + linha.ate + ' · ' + linha.slots + ' slots');
    Object.entries(val).forEach(([u, v]) => console.log('   ' + u.padEnd(9) + r2(v) + ' MWh'));
    require('fs').writeFileSync(process.env.LOCAL_OUT, JSON.stringify({ dia: hoje, ate: linha.ate, val }, null, 1));
    return;
  }

  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const bc = cont.getBlockBlobClient(BLOB);
  const props = await bc.getProperties();
  const etag = props.etag;
  const buf = await bc.downloadToBuffer();
  let bytes = buf;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const j = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));

  const alvo = (j.serie_dia_ufv || []).filter((x) => x.dia === hoje);
  if (!alvo.length) { console.log('o executivo ainda nao tem linha para ' + hoje + ' — nada a patchar'); return; }

  let n = 0, antes = null;
  alvo.forEach((x) => {
    if (!(x.ufv in val)) return;
    if (x.ufv === 'Complexo') antes = x.liq_mwh;
    x.liq_mwh = r2(val[x.ufv]);
    x.parcial = 1;
    x.ate = linha.ate;
    x.liq_fonte = 'snapshot 5 min';
    n += 1;
  });
  if (n !== 12) { console.log('esperava 12 entidades no dia, patchei ' + n + ' — abortando'); process.exit(1); }

  // guarda: o dia em curso nunca pode passar do maior dia ja registrado no mes, e nunca
  // pode ENCOLHER dentro do mesmo dia (o snapshot so cresce). Qualquer um dos dois e sinal
  // de leitura torta, e publicar seria pior que ficar com o valor de antes.
  const mes = hoje.slice(0, 7);
  const outros = (j.serie_dia_ufv || [])
    .filter((x) => x.ufv === 'Complexo' && x.dia.slice(0, 7) === mes && x.dia !== hoje && x.liq_mwh != null)
    .map((x) => x.liq_mwh);
  const teto = outros.length ? Math.max.apply(null, outros) * 1.25 : Infinity;
  const novo = r2(val.Complexo);
  if (novo > teto) { console.log('dia em curso ' + novo + ' MWh acima do teto ' + Math.round(teto) + ' — abortando'); process.exit(1); }
  if (antes != null && novo < antes - 1) { console.log('dia em curso ENCOLHEU (' + antes + ' -> ' + novo + ') — abortando'); process.exit(1); }

  const saida = zlib.gzipSync(Buffer.from(JSON.stringify(j), 'utf8'));
  try {
    await bc.upload(saida, saida.length, {
      conditions: { ifMatch: etag },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip',
        blobCacheControl: 'public, max-age=60' },
    });
  } catch (e) {
    if (e.statusCode === 412) { console.log('o executivo foi reescrito no meio — desisto, a proxima rodada refaz'); return; }
    throw e;
  }
  console.log('dia ' + hoje + ' ate ' + linha.ate + ' · Complexo ' + (antes == null ? '—' : antes)
    + ' -> ' + novo + ' MWh (' + linha.slots + ' slots)');
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
