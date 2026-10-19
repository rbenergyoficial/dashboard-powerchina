/*
 * ensaio-sungrow-cascata.js — a cascata da usina no dia no sg_saude.json (PROMOVER sg-perdas, 15/10/2026).
 *
 *   --produto (padrao) · depois do gerador, sobre o publicado: cada linha de `usina_dia` traz n_cc, ecc e eca, e eles sao EXATAMENTE a
 *               soma refeita aqui a partir do sg_saude_<usina>.json (inversores com o dia inteiro, p = 0, e os dois lados com ecc > 0;
 *               o kWh somado e arredondado, /1000), na mesma ordem das linhas; n_cc nunca passa de n_inv; e a maior parte dos usina-dias
 *               tem o parque inteiro (o ensaio nao passa por vacuidade: exige linhas com n_cc > 0 nas nove usinas).
 *               Plantios em memoria (cada um TEM de reprovar): um inversor somado duas vezes, o dia parcial entrando na soma,
 *               o resumo sem os campos.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const U9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
let falhas = 0;
const ok = (c, msg) => { if (c) console.log('  ✓ ' + msg); else { falhas++; console.log('  ✗ ' + msg); } };
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); como antes, toda resposta que nao e 200 reprova, o 404 tambem */
  return LD.pede(BASE + nome, { 'accept-encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + nome);
    return deJson(x.buf);
  });
}

/* a soma refeita: a mesma regra do gerador, sobre as linhas publicadas do inversor */
function refaz(linhasInv) {
  const porD = new Map();
  for (const r of linhasInv) (porD.get(r.d) || porD.set(r.d, []).get(r.d)).push(r);
  const out = new Map();
  for (const [d, R] of porD) {
    const cas = R.filter((r) => r.p === 0 && r.ecc != null && r.eca != null && r.ecc > 0);
    const s = (k) => Math.round(cas.reduce((a, r) => a + r[k], 0)) / 1000;
    out.set(d, { n_cc: cas.length, ecc: cas.length ? s('ecc') : null, eca: cas.length ? s('eca') : null });
  }
  return out;
}

/* o julgamento: devolve a lista de diferencas (vazia = bate) */
function julga(UD, INV) {
  const dif = [];
  for (const u of U9) {
    const R = refaz(INV[u] || []);
    for (const x of UD.filter((r) => r.ufv === u)) {
      if (!('n_cc' in x) || !('ecc' in x) || !('eca' in x)) { dif.push(u + ' ' + x.d + ' sem os campos'); continue; }
      const y = R.get(x.d) || { n_cc: 0, ecc: null, eca: null };
      if (x.n_cc !== y.n_cc || x.ecc !== y.ecc || x.eca !== y.eca) dif.push(u + ' ' + x.d + ' publicado ' + x.n_cc + '/' + x.ecc + '/' + x.eca + ' refeito ' + y.n_cc + '/' + y.ecc + '/' + y.eca);
      if (x.n_cc > x.n_inv) dif.push(u + ' ' + x.d + ' n_cc ' + x.n_cc + ' passa de n_inv ' + x.n_inv);
    }
  }
  return dif;
}

(async () => {
  try {
    console.log('· a cascata no sg_saude.json publicado');
    const S = await getJSON('sg_saude.json'), UD = S.usina_dia || [], INV = {};
    for (const u of U9) INV[u] = ((await getJSON('sg_saude_' + u + '.json')).serie) || [];
    const comCc = U9.filter((u) => UD.some((r) => r.ufv === u && r.n_cc > 0));
    ok(comCc.length === 9, 'as nove usinas tem usina-dia com n_cc > 0 (' + comCc.join(' ') + ')');
    const d = julga(UD, INV);
    ok(!d.length, 'n_cc, ecc e eca de ' + UD.length + ' usina-dias batem com a soma refeita dos inversores' + (d.length ? ' — difere (' + d.length + '): ' + d.slice(0, 4).join('; ') : ''));
    console.log('· plantios (cada um TEM de reprovar)');
    const alvo = UD.find((r) => r.n_cc > 0), uA = alvo && alvo.ufv;
    const dup = Object.assign({}, INV); dup[uA] = INV[uA].concat(INV[uA].filter((r) => r.d === alvo.d && r.p === 0 && r.ecc > 0).slice(0, 1));
    ok(julga(UD, dup).length > 0, 'plantio "inversor somado duas vezes" reprova');
    /* o dia parcial: um usina-dia com inversor parcial que tem os dois lados de energia (existe em quase todo mes) */
    let pu = null, pd = null;
    for (const u of U9) { const r = INV[u].find((x) => x.p === 1 && x.ecc > 0 && x.eca != null); if (r) { pu = u; pd = r.d; break; } }
    ok(!!pu, 'ha inversor-dia parcial com energia para o plantio do dia parcial' + (pu ? ' (' + pu + ' ' + pd + ')' : ''));
    if (pu) { const parc = Object.assign({}, INV); parc[pu] = INV[pu].map((r) => (r.d === pd && r.p === 1 ? Object.assign({}, r, { p: 0 }) : r));
      ok(julga(UD, parc).length > 0, 'plantio "dia parcial entrando na soma" reprova'); }
    ok(julga(UD.map((r) => { const y = Object.assign({}, r); delete y.ecc; return y; }), INV).length > 0, 'plantio "resumo sem os campos" reprova');
  } catch (e) { falhas++; console.log('  ✗ ' + (e && e.stack || e)); }
  console.log(falhas ? 'REPROVADO (' + falhas + ')' : 'APROVADO');
  process.exit(falhas ? 1 : 0);
})();
