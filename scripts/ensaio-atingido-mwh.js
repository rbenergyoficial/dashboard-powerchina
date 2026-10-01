/*
 * ensaio-atingido-mwh.js — o atingimento do mes aberto sai do MWh (PROMOVER ating-mwh).
 *
 * POR QUE EXISTE. `atingido_pct` do mes aberto dividia o GWh de 2 casas pela meta rateada em GWh de 2 casas: 5 MWh de
 * arredondamento de cada lado. Em 01/10/2026, com um dia, o M9 publicava 77,78 % contra 77,20 % exatos e o ML 75,00 %
 * contra 75,47 %. A conta passou a sair de `liquida_mwh / meta_rateada_mwh` (e o % do mes cheio de `liquida_mwh /
 * meta_mwh`), e o conjunto (`serie`) usa a linha do Complexo, a mesma entidade.
 *
 * O QUE PROVA. No blob publicado, para cada linha `parcial` de `serie_ufv` com MWh: `atingido_pct` e
 * `atingido_mes_cheio_pct` iguais a conta exata (folga 0,0051: os dois lados do r2 final); a linha do mes aberto em
 * `serie` igual a do Complexo. PLANTIOS: o valor pelo GWh numa linha em que ele difere, e um +0,05 no conjunto, reprovam.
 * Sem mes aberto, so os plantios forjados rodam (a janela de fim de mes nao reprova). Roda depois de gerar.
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome))); req.on('error', ko);
  });
}
const TOL = 0.0051;

function julga(j) {
  const f = []; let n = 0;
  const P = (j.serie_ufv || []).filter((x) => x.parcial === 1 && x.liquida_mwh != null && x.meta_rateada_mwh > 0);
  P.forEach((x) => {
    n++;
    const at = 100 * x.liquida_mwh / x.meta_rateada_mwh;
    if (Math.abs(x.atingido_pct - at) > TOL) f.push(x.ufv + ' ' + x.mes + ': atingido_pct ' + x.atingido_pct + ', exato ' + at.toFixed(3));
    if (x.meta_mwh > 0) { const ch = 100 * x.liquida_mwh / x.meta_mwh;
      if (Math.abs(x.atingido_mes_cheio_pct - ch) > TOL) f.push(x.ufv + ' ' + x.mes + ': atingido_mes_cheio_pct ' + x.atingido_mes_cheio_pct + ', exato ' + ch.toFixed(3)); }
  });
  const C = P.find((x) => x.ufv === 'Complexo'), S = C && (j.serie || []).find((x) => x.mes === C.mes);
  if (C && S && S.parcial === 1 && S.atingido_pct !== C.atingido_pct) f.push('serie ' + S.mes + ': atingido_pct ' + S.atingido_pct + ', o Complexo diz ' + C.atingido_pct);
  return { f, n, C };
}

(async () => {
  const j = await getJSON('executivo.json');
  const r = julga(j), f = r.f.slice();
  console.log('   ' + r.n + ' linhas do mes aberto julgadas' + (r.n ? '' : ' (sem mes aberto com MWh: so os plantios forjados)'));
  // PLANTIOS sobre uma copia; sem mes aberto, sobre uma linha forjada
  const base = JSON.parse(JSON.stringify(j));
  if (!r.n) {
    base.serie_ufv = [{ ufv: 'M9', mes: '2026-10', parcial: 1, liquida_gwh: 0.07, liquida_mwh: 65.74, meta_gwh: 1.79, meta_mwh: 1785.7, meta_rateada_gwh: 0.09, meta_rateada_mwh: 85.16, atingido_pct: 77.2, atingido_mes_cheio_pct: 3.68 },
      { ufv: 'Complexo', mes: '2026-10', parcial: 1, liquida_gwh: 2.46, liquida_mwh: 2460.21, meta_gwh: 57, meta_mwh: 57000, meta_rateada_gwh: 1.84, meta_rateada_mwh: 1838.71, atingido_pct: 133.8, atingido_mes_cheio_pct: 4.32 }];
    base.serie = [{ mes: '2026-10', parcial: 1, atingido_pct: 133.8 }];
    if (julga(base).f.length) f.push('o caso forjado sadio reprova: ' + julga(base).f[0]);
  }
  const P1 = JSON.parse(JSON.stringify(base));
  const alvo = (P1.serie_ufv || []).filter((x) => x.parcial === 1 && x.liquida_mwh != null && x.meta_rateada_mwh > 0)
    .find((x) => Math.abs(Math.round(10000 * x.liquida_gwh / x.meta_rateada_gwh) / 100 - 100 * x.liquida_mwh / x.meta_rateada_mwh) > TOL);
  if (alvo) { alvo.atingido_pct = Math.round(10000 * alvo.liquida_gwh / alvo.meta_rateada_gwh) / 100;
    const n1 = julga(P1).f.length; console.log('   plantio (o valor pelo GWh no ' + alvo.ufv + '): ' + n1 + ' achado(s)'); if (!n1) f.push('o valor pelo GWh nao reprova'); }
  else console.log('   plantio pelo GWh: hoje o GWh e o MWh coincidem em todas as linhas — fica o plantio do conjunto');
  const P2 = JSON.parse(JSON.stringify(base)); const s2 = (P2.serie || []).find((x) => x.parcial === 1);
  if (s2) { s2.atingido_pct = Math.round((s2.atingido_pct + 0.05) * 100) / 100; const n2 = julga(P2).f.length;
    console.log('   plantio (conjunto +0,05): ' + n2 + ' achado(s)'); if (!n2) f.push('o conjunto diferente do Complexo nao reprova'); }
  else f.push('sem linha do conjunto no mes aberto para o plantio');
  if (f.length) { f.slice(0, 20).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-atingido-mwh: TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
