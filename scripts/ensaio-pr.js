/**
 * ensaio-pr.js - prova a conta do PR (lib-pr.js) em casos forjados e confere o pr.json contra outras rotas.
 *
 *   node scripts/ensaio-pr.js              regra (casos forjados) + produto publicado
 *   PR_ARQ=<pr.json local> node ...        confere um arquivo local em vez do blob
 *
 * REGRA (sem rede):
 *   - o instante de 5 min rotulado 01:00 cai na hora 00 (o medidor rotula pelo FIM)
 *   - so a parte POSITIVA de TR1+TR2 entra (a madrugada consome e nao desconta)
 *   - hora com 11 instantes nao entra
 *   - PR = E / (425,677 x H); o corrigido soma a impedida, so em mes apurado e fora dos dias excluidos
 *   - dia com menos de 22 horas validas nao tem PR
 * PRODUTO (rede, blobs publicos):
 *   - o mes soma energia e irradiacao (nunca a media dos PR diarios)
 *   - nos meses apurados e com TODOS os dias corrigidos, a impedida somada e a do executivo (outra rota)
 *   - a energia injetada do dia fica ACIMA da liquida do medidor e a diferenca e pequena (consumo)
 */
'use strict';
const zlib = require('zlib');
const L = require('./lib-pr.js');
const falhas = [];
const exige = (ok, msg) => { if (!ok) falhas.push(msg); };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── REGRA ─────────────────────────────────────────────────────────────────────────────────────── */
(function regra() {
  exige(L.chaveHoraDoFim('2026-08-10T01:00:00') === '2026-08-10T00', 'rotulo 01:00 deveria cair na hora 00');
  exige(L.chaveHoraDoFim('2026-08-10T00:05:00') === '2026-08-10T00', 'rotulo 00:05 deveria cair na hora 00');
  exige(L.chaveHoraDoFim('2026-08-11T00:00:00') === '2026-08-10T23', 'rotulo 24:00 deveria cair na hora 23 do dia anterior');

  const dia = '2026-08-10';
  const slots = [];
  for (let m = 5; m <= 24 * 60; m += 5) { const t = new Date(Date.parse(dia + 'T00:00:00Z') + m * 60000).toISOString().slice(0, 19); slots.push(t); }
  const pot = t => { const h = +t.slice(11, 13) + (+t.slice(14, 16)) / 60; return h > 6 && h <= 18 ? 100000 : -250; };   /* kW por trafo */
  const mk = (pid, faltando) => ({ pontoId: pid, nomeGrandeza: 'Demat', valores: slots.map(t => ({ data: t, valor: faltando && t === dia + 'T12:05:00' ? null : pot(t) })) });
  const hist = { dados: [mk(6196), mk(6197, true)] };
  const eH = L.energiaHoras(hist);
  exige(!eH.has(dia + 'T12'), 'hora com 11 instantes deveria ficar de fora');
  const h10 = eH.get(dia + 'T10');
  exige(h10 && perto(h10.inj_mwh, 200, 1e-9), 'hora 10: 2 x 100 MW por 1 h = 200 MWh (veio ' + (h10 && h10.inj_mwh) + ')');
  const h02 = eH.get(dia + 'T02');
  exige(h02 && h02.inj_mwh === 0, 'madrugada consome e a injetada deve ser ZERO (veio ' + (h02 && h02.inj_mwh) + ')');

  const gH = new Map(); for (let h = 0; h < 24; h++) gH.set(dia + 'T' + String(h).padStart(2, '0'), h >= 6 && h < 18 ? 0.8 : 0);
  const consolidado = [];
  for (let h = 0; h < 24; h++) for (const mm of ['00', '30']) consolidado.push({ ts: dia + ' ' + String(h).padStart(2, '0') + ':' + mm + ':00', lim: h === 10 ? '150' : '', ger: h === 10 ? '150' : '0', gref: h === 10 ? '250' : '0' });
  const op = L.operadorHoras(consolidado);
  exige(perto(op.impedida.get(dia + 'T10'), 100, 1e-9), 'impedida na hora 10: (250-150) x 0,5 x 2 = 100 MWh');

  const ap = new Set(['2026-08']);
  const d = L.prDia(dia, eH, gH, op, ap);
  exige(d.horas_validas === 23, 'horas validas deveriam ser 23 (a hora 12 ficou de fora)');
  let E = 0, H = 0; for (let h = 0; h < 24; h++) { if (h === 12) continue; const k = dia + 'T' + String(h).padStart(2, '0'); E += (eH.get(k) || { inj_mwh: 0 }).inj_mwh; H += gH.get(k); }
  exige(perto(d.pr_pct, Math.round(10000 * E / (L.P_CC_MWP * H)) / 100, 0.011), 'PR recalculado ' + (100 * E / (L.P_CC_MWP * H)).toFixed(2) + ' contra ' + d.pr_pct);
  exige(perto(d.pr_corrigido_pct, Math.round(10000 * (E + 100) / (L.P_CC_MWP * H)) / 100, 0.011), 'PR corrigido deveria somar os 100 MWh impedidos');

  const semAp = L.prDia(dia, eH, gH, op, new Set());
  exige(semAp.pr_corrigido_pct == null && semAp.pr_pct != null, 'mes nao apurado: PR sim, corrigido nao');
  const excl = L.prDia('2026-03-03', new Map([...eH].map(([k, v]) => ['2026-03-03' + k.slice(10), v])), new Map([...gH].map(([k, v]) => ['2026-03-03' + k.slice(10), v])), L.operadorHoras(consolidado.map(x => Object.assign({}, x, { ts: '2026-03-03' + x.ts.slice(10) }))), new Set(['2026-03']));
  exige(excl.pr_corrigido_pct == null, 'dia excluido pelo executivo nao pode ter corrigido');
  const curto = L.prDia(dia, new Map([...eH].slice(0, 10)), gH, op, ap);
  exige(curto.pr_pct == null, 'dia com menos de 22 horas nao pode ter PR');
})();

/* ── PRODUTO ───────────────────────────────────────────────────────────────────────────────────── */
function puxa(url) {
  const https = require('https');
  return new Promise((ok, erro) => https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, res => {
    if (res.statusCode !== 200) { erro(new Error('HTTP ' + res.statusCode + ' ' + url)); res.resume(); return; }
    const p = []; res.on('data', c => p.push(c)); res.on('end', () => { let b = Buffer.concat(p); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); ok(JSON.parse(b.toString('utf8'))); });
  }).on('error', erro));
}

(async () => {
  const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
  let pr;
  if (process.env.PR_ARQ) pr = JSON.parse(zlib.gunzipSync(require('fs').readFileSync(process.env.PR_ARQ)).toString('utf8'));
  else { try { pr = await puxa(BASE + 'pr.json'); } catch (e) { if (/HTTP 404/.test(e.message)) { console.log('pr.json ainda nao publicado: so a regra foi julgada'); return fim(); } throw e; } }
  const [gem, daily] = await Promise.all([puxa(BASE + 'corte_gemeo.json'), puxa(BASE + 'way2_daily.json')]);

  const recalc = L.prMeses(pr.dias);
  exige(JSON.stringify(recalc) === JSON.stringify(pr.meses), 'os meses publicados nao saem dos dias publicados');

  let comparados = 0;
  for (const m of pr.meses) {
    const g = (gem.serie || []).find(x => x.mes === m.mes);
    if (!g || g.base !== 'apurado' || m.dias_corrigido !== m.dias_no_mes || g.corte_ons_gwh == null) continue;
    comparados++;
    exige(perto(m.impedida_mwh / 1000, g.corte_ons_gwh, 0.02), m.mes + ': impedida ' + (m.impedida_mwh / 1000).toFixed(2) + ' GWh contra ' + g.corte_ons_gwh + ' do executivo');
  }
  exige(comparados >= 1, 'nenhum mes completo para comparar a impedida - a conferencia nao julgou nada');

  const liq = new Map((daily.dias || []).map(d => [d.dia, d.ene_liq_mwh]));
  let dcomp = 0;
  for (const d of pr.dias) {
    if (d.pr_pct == null || d.horas_validas < 24 || !liq.has(d.dia)) continue;
    dcomp++;
    const l = liq.get(d.dia);
    exige(d.inj_mwh >= l - 0.5, d.dia + ': injetada ' + d.inj_mwh + ' abaixo da liquida ' + l);
    exige(d.inj_mwh - l <= Math.max(25, 0.03 * l), d.dia + ': injetada ' + d.inj_mwh + ' longe demais da liquida ' + l + ' (o consumo e ~12 MWh/dia)');
  }
  exige(dcomp >= 30, 'so ' + dcomp + ' dias comparados com a liquida');
  console.log('produto: ' + pr.dias.length + ' dias, ' + pr.meses.length + ' meses · impedida conferida em ' + comparados + ' meses · injetada x liquida em ' + dcomp + ' dias');
  fim();
})().catch(e => { console.error('REPROVADO: ' + e.message); process.exit(1); });

function fim() {
  if (falhas.length) { falhas.forEach(f => console.error('REPROVADO: ' + f)); process.exit(1); }
  console.log('ensaio-pr: passou');
}
