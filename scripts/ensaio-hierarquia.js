/*
 * ensaio-hierarquia.js — a hierarquia publicada e VERDADEIRA, nao so coerente consigo mesma.
 *
 * Roda DEPOIS de gerar, sobre os blobs PUBLICOS (sem segredo nenhum, roda em qualquer maquina).
 *
 * A relacao "usina -> contrato" passou a ser publicada para os paineis pararem de carrega-la como
 * literal em onze lugares. Um mapa errado nao quebra nada na tela: ele faz o painel APAGAR a
 * entidade errada da selecao, em silencio. Por isso o ensaio nao se contenta com coerencia interna.
 *
 *   1 · `hierarquia.json` cobre exatamente as usinas que a serie publica
 *   2 · o mesmo objeto esta dentro do `executivo.json` — duas publicacoes, uma origem
 *   3 · concorda com `estrategia.ppa`/`estrategia.ml`, que e a forma antiga do mesmo fato
 *   4 · 🔴 a ENERGIA fecha: a soma das usinas de cada contrato bate com o contrato publicado, e a
 *        soma dos contratos bate com o conjunto — em TODO mes fechado
 *
 * ⚠️ A tolerancia sai da CADEIA DE ARREDONDAMENTO, nao de um numero escolhido: cada parcela vem do
 *    blob com 2 casas, entao somar N delas admite N x 0,005 GWh.
 *
 * uso: node scripts/ensaio-hierarquia.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');

const BASE = process.env.BLOB_BASE || 'https://rbenergydata.blob.core.windows.net/dados/';

/* BLOB_DIR le os mesmos nomes de um diretorio — e como se ensaia a rodada antes de ela ir ao ar */
function baixa(nome) {
  if (process.env.BLOB_DIR) {
    const p = require('path').join(process.env.BLOB_DIR, nome);
    return Promise.resolve(JSON.parse(require('fs').readFileSync(p, 'utf8')));
  }
  return new Promise((ok, mau) => {
    https.get(BASE + nome, (r) => {
      if (r.statusCode !== 200) { mau(new Error(nome + ': HTTP ' + r.statusCode)); r.resume(); return; }
      const b = [];
      r.on('data', (c) => b.push(c));
      r.on('end', () => {
        let buf = Buffer.concat(b);
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
        try { ok(JSON.parse(buf.toString('utf8'))); } catch (e) { mau(new Error(nome + ': ' + e.message)); }
      });
    }).on('error', mau);
  });
}

let mau = 0;
const falha = (m) => { mau += 1; console.log('  FALHA · ' + m); };
const ok = (m) => console.log('  ok · ' + m);

(async () => {
  const H = await baixa('hierarquia.json');
  const E = await baixa('executivo.json');

  /* 1 · cobertura */
  const usinasSerie = [...new Set((E.serie_ufv || []).map((l) => l.ufv))]
    .filter((u) => u !== H.conjunto && (H.contratos || []).indexOf(u) < 0).sort();
  const cobertas = Object.keys(H.contrato || {}).sort();
  if (usinasSerie.join(',') === cobertas.join(',')) ok('cobre as ' + cobertas.length + ' usinas da serie, sem sobra e sem falta');
  else falha('a serie tem [' + usinasSerie.join(',') + '] e o mapa cobre [' + cobertas.join(',') + ']');

  /* 2 · as duas publicacoes concordam */
  const semData = (o) => JSON.stringify({ conjunto: o.conjunto, contratos: o.contratos, contrato: o.contrato });
  if (E.hierarquia && semData(E.hierarquia) === semData(H)) ok('o `executivo.json` traz o MESMO objeto');
  else falha('as duas publicacoes divergem — mesma origem tem de dar o mesmo objeto');

  /* 3 · concorda com a forma antiga */
  const daEstrategia = {};
  ((E.estrategia || {}).ppa || []).forEach((u) => { daEstrategia[u] = 'PPA'; });
  ((E.estrategia || {}).ml || []).forEach((u) => { daEstrategia[u] = 'ML'; });
  if (JSON.stringify(daEstrategia) === JSON.stringify(H.contrato)) ok('concorda com `estrategia.ppa`/`estrategia.ml`');
  else falha('discorda da estrategia publicada: ' + JSON.stringify(daEstrategia));

  /* 4 · a ENERGIA fecha — e o que separa hierarquia verdadeira de hierarquia declarada */
  const porMes = {};
  (E.serie_ufv || []).forEach((l) => { (porMes[l.mes] = porMes[l.mes] || {})[l.ufv] = l; });
  const meses = Object.keys(porMes).sort().filter((m) => {
    const c = porMes[m][H.conjunto];
    return c && c.parcial !== 1;                       // mes em curso tem janela propria por fonte
  });
  if (!meses.length) { falha('nenhum mes fechado na serie — o ensaio passaria por vacuidade'); }
  let conf = 0, ruins = 0;
  for (const m of meses) {
    for (const ct of (H.contratos || [])) {
      const partes = Object.keys(H.contrato).filter((u) => H.contrato[u] === ct);
      const soma = partes.reduce((s, u) => s + Number((porMes[m][u] || {}).liquida_gwh || 0), 0);
      const pub = Number((porMes[m][ct] || {}).liquida_gwh || 0);
      const tol = 0.005 * (partes.length + 1);
      if (Math.abs(soma - pub) <= tol) conf += 1;
      else { ruins += 1; if (ruins <= 3) falha(m + ' · ' + ct + ': as partes somam ' + soma.toFixed(3) + ' e o contrato publica ' + pub.toFixed(3)); }
    }
    const somaCt = (H.contratos || []).reduce((s, c) => s + Number((porMes[m][c] || {}).liquida_gwh || 0), 0);
    const cx = Number((porMes[m][H.conjunto] || {}).liquida_gwh || 0);
    if (Math.abs(somaCt - cx) <= 0.005 * ((H.contratos || []).length + 1)) conf += 1;
    else { ruins += 1; if (ruins <= 3) falha(m + ' · conjunto: os contratos somam ' + somaCt.toFixed(3) + ' e o conjunto publica ' + cx.toFixed(3)); }
  }
  if (!ruins) ok('a energia fecha em ' + conf + ' pares (contrato x partes e conjunto x contratos) em ' + meses.length + ' meses fechados');

  console.log();
  if (mau) { console.error('ensaio-hierarquia: ' + mau + ' falha(s)'); process.exit(1); }
  console.log('ensaio-hierarquia: PASSOU');
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
