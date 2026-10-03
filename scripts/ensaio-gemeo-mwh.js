'use strict';
/*
 * ensaio-gemeo-mwh.js — o `corte_mwh` do corte por gemeo de irradiancia, sobre o PRODUTO publicado (26/09/2026).
 *
 * O campo nasceu no lote mwh-gerador (25/09/2026) e nao tinha ensaio nenhum: o ensaio-par-mwh.js le so o
 * executivo.json. Achado RE-005 do revisor de ensaio.
 *
 * PRODUTO · toda linha com corte em GWh traz o corte em MWh; o par fecha em TOL_PAR (dois arredondamentos de 2
 *           casas da mesma energia crua); e a familia nao tem a resolucao do GWh x 1000 (regra `resolucao` da
 *           lib-par-mwh.js, a mesma do executivo — nao uma copia).
 * PLANTIO · cada defeito reprova com a mensagem dele: (1) MWh derivado do GWh x 1000; (2) uma linha sem MWh;
 *           (3) uma linha com 20 MWh a mais (0,02 GWh, acima do TOL_PAR).
 * Roda DEPOIS do gerador do gemeo (ons-consolidado.yml): julga o que subiu.
 *
 *   node scripts/ensaio-gemeo-mwh.js      (BASE_DADOS=<pasta> le uma rodada local; sem ela, o blob publico)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { TOL_PAR } = require('./lib-tol-unidade.js');
const { resolucao } = require('./lib-par-mwh.js');

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

function confere(G) {
  const mau = [];
  const L = (G.serie || []).filter((s) => s.corte_gwh != null);
  if (!L.length) { mau.push('VACUO: nenhuma linha com corte_gwh no corte_gemeo.json'); return mau; }
  L.forEach((s) => {
    if (s.corte_mwh == null) mau.push(s.mes + ': sem corte_mwh (corte_gwh=' + s.corte_gwh + ')');
    else if (Math.abs(s.corte_mwh / 1000 - s.corte_gwh) > TOL_PAR) mau.push(s.mes + ': par ' + s.corte_mwh + ' MWh contra ' + s.corte_gwh + ' GWh');
  });
  resolucao(L.map((s) => s.corte_mwh), 'corte_gemeo corte_mwh', mau);
  return mau;
}

(async () => {
  const falhas = [];
  const G = await le('corte_gemeo.json');
  const base = confere(G);
  base.forEach((m) => falhas.push('PRODUTO: ' + m));
  const n = (G.serie || []).filter((s) => s.corte_mwh != null).length;
  console.log('  produto: ' + (G.serie || []).length + ' meses, ' + n + ' com corte em MWh · ' + (base.length ? base.length + ' achado(s)' : 'fecha'));

  const plantio = (nome, muda, esperado) => {
    const Y = copia(G);
    if (!muda(Y)) { falhas.push('plantio "' + nome + '" nao achou onde plantar'); return; }
    if (JSON.stringify(Y) === JSON.stringify(G)) { falhas.push('plantio "' + nome + '" nao mudou nada — nao foi plantado'); return; }
    const novos = confere(Y).filter((m) => !base.includes(m));
    if (!novos.length) falhas.push('plantio "' + nome + '" NAO reprovou');
    else if (!novos.some((m) => esperado.test(m))) falhas.push('plantio "' + nome + '" reprovou pelo motivo errado: ' + novos[0]);
    else console.log('  plantio "' + nome + '": reprovou · ' + novos.find((m) => esperado.test(m)).slice(0, 90));
  };
  plantio('MWh derivado do GWh x 1000', (Y) => { let k = 0; Y.serie.forEach((s) => { if (s.corte_gwh != null) { s.corte_mwh = Math.round(s.corte_gwh * 1e5) / 100; k++; } }); return k >= 10; },
    /resolucao do GWh x 1000/);
  plantio('linha sem corte_mwh', (Y) => { const s = Y.serie.find((q) => q.corte_mwh != null); if (!s) return false; delete s.corte_mwh; return true; },
    /sem corte_mwh/);
  plantio('linha com 20 MWh a mais', (Y) => { const s = Y.serie.find((q) => q.corte_mwh != null); if (!s) return false; s.corte_mwh += 20; return true; },
    /par /);

  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-gemeo-mwh: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
