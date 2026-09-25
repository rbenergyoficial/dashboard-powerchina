'use strict';
/*
 * ensaio-par-mwh.js — o par GWh × MWh do executivo, sobre o PRODUTO publicado (PROMOVER mwh-gerador, 25/09/2026).
 *
 * A regra mora em lib-par-mwh.js e roda DENTRO do gerador, antes de gravar. Este ensaio e a segunda rota: le o blob
 * que subiu (o que o portal de fato le) e aplica a mesma conferencia — pega defeito de EMISSAO, nao de conta.
 *
 * PRODUTO · o executivo publicado passa na conferencia, e publica os campos em MWh (sem eles nao julgaria nada).
 * PLANTIO · quatro defeitos, cada um tem de reprovar:
 *   1 · o corte das usinas DERIVADO do GWh (x 1000) — o defeito que o lote existe para evitar: a soma deixa de fechar
 *       com o conjunto na casa do MWh;
 *   2 · uma usina com o corte inflado em 1 MWh;
 *   3 · o resto nulo de um lado so;
 *   4 · uma razao do mes sem o campo em MWh.
 *
 *   node scripts/ensaio-par-mwh.js        (BASE_DADOS=<pasta> le uma rodada local; sem ela, o blob publico)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { conferePares } = require('./lib-par-mwh.js');

const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
function parse(buf) { return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }
function le(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(parse(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((res, rej) => https.get(BASE + nome, { headers: { 'Accept-Encoding': 'gzip' } }, (s) => {
    if (s.statusCode !== 200) return rej(new Error(nome + ': HTTP ' + s.statusCode));
    const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => { try { res(parse(Buffer.concat(b))); } catch (e) { rej(e); } });
  }).on('error', rej));
}
const copia = (o) => JSON.parse(JSON.stringify(o));

(async () => {
  const falhas = [];
  const X = await le('executivo.json');
  const S = X.serie_ufv || [];
  const comM = S.filter(x => x.cortado_mwh != null).length;
  if (!comM) falhas.push('o executivo publicado nao tem cortado_mwh em linha nenhuma — o ensaio nao julgaria nada');
  const base = conferePares(X);
  base.slice(0, 10).forEach(m => falhas.push('PRODUTO: ' + m));
  console.log('  produto: ' + S.length + ' linhas do serie_ufv, ' + comM + ' com corte em MWh · ' + (base.length ? base.length + ' achado(s)' : 'fecha'));

  // um mes reconciliado inteiro, para os plantios que dependem da soma das usinas
  const US = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
  const mesR = [...new Set(S.map(x => x.mes))].reverse().find(m => US.every(u => { const r = S.find(x => x.ufv === u && x.mes === m);
    return r && r.corte_reconciliado === 1 && r.cortado_mwh != null && r.cortado_bruto_mwh != null; }));
  if (!mesR) falhas.push('nenhum mes com as nove usinas reconciliadas — os plantios 1 e 2 nao teriam onde morder');
  const plantio = (nome, muda) => {
    const Y = copia(X); const ok = muda(Y);
    if (!ok) { falhas.push('plantio "' + nome + '" nao achou onde plantar'); return; }
    const m = conferePares(Y).length - base.length;
    if (m <= 0) falhas.push('plantio "' + nome + '" NAO reprovou — a conferencia nao mede isso');
    else console.log('  plantio "' + nome + '": reprovou (' + m + ' achado' + (m > 1 ? 's' : '') + ')');
  };
  if (mesR) {
    plantio('corte das usinas derivado do GWh', Y => { let n = 0; Y.serie_ufv.forEach(x => { if (x.mes === mesR && US.includes(x.ufv)) { x.cortado_mwh = Math.round(x.cortado_gwh * 1e5) / 100; n++; } }); return n === 9; });
    plantio('usina com o corte inflado', Y => { const x = Y.serie_ufv.find(q => q.mes === mesR && q.ufv === 'M5'); x.cortado_mwh += 1; return true; });
  }
  plantio('resto nulo de um lado so', Y => { const x = Y.serie_ufv.find(q => q.outras_mwh != null && q.outras_gwh != null); if (!x) return false; x.outras_mwh = null; return true; });
  plantio('razao do mes sem MWh', Y => { const s = Y.serie.find(q => q.razoes && q.razoes.ENE); if (!s) return false; delete s.razoes.ENE.mwh; return true; });

  if (falhas.length) { console.log(falhas.map(f => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-par-mwh: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
