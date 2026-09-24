/**
 * ensaio-pr.js - prova a conta do PR (lib-pr.js) em casos forjados e confere o pr.json contra outras rotas.
 *
 *   node scripts/ensaio-pr.js              regra (casos forjados) + produto publicado
 *   PR_ARQ=<pr.json local> node ...        confere um arquivo local em vez do blob
 *   PR_HORA_ARQ=<pr_hora.json local>       idem para a meia hora
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
 * MEIA HORA (pr_hora.json, 24/09/2026):
 *   - REGRA: o instante rotulado 10:30 cai na meia hora 10:00; a irradiacao e o TRAPEZIO de T e T+30; abaixo de
 *     100 W/m2 nao ha PR; acima de 110 % a meia hora sai vazia e contada; o corrigido so no dia que tem corrigido
 *   - PRODUTO: a soma das meias horas fecha com o dia; cada PR sai da energia e da irradiacao publicadas ao lado; e
 *     MANHA e TARDE ficam simetricas nas meias horas sem limitacao - e isso que a janela errada quebra (87 x 54 %)
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

  /* -- a meia hora -- */
  exige(L.chaveMeiaDoFim('2026-08-10T10:05:00') === '2026-08-10T10:00', 'rotulo 10:05 deveria cair na meia hora 10:00');
  exige(L.chaveMeiaDoFim('2026-08-10T10:30:00') === '2026-08-10T10:00', 'rotulo 10:30 deveria cair na meia hora 10:00 (o medidor rotula pelo fim)');
  exige(L.chaveMeiaDoFim('2026-08-10T10:35:00') === '2026-08-10T10:30', 'rotulo 10:35 deveria cair na meia hora 10:30');
  const eM = L.energiaMeias(hist);
  exige(!eM.has(dia + 'T12:00'), 'meia hora com 5 instantes deveria ficar de fora');
  exige(eM.get(dia + 'T10:00') && perto(eM.get(dia + 'T10:00').inj_mwh, 100, 1e-9), 'meia hora 10:00: 2 x 100 MW por 0,5 h = 100 MWh');
  /* amostras: 0 ate 05:30, 800 de 06:00 a 17:30, 60 as 18:00 (abaixo do piso), 0 depois */
  const sM = new Map();
  for (let i = 0; i < 49; i++) { const ms = Date.parse(dia + 'T00:00:00Z') + i * 18e5, k = new Date(ms).toISOString().slice(0, 16), hh = i / 2;
    sM.set(k, hh >= 6 && hh < 18 ? 800 : hh === 18 ? 60 : 0); }
  const impM = L.impedidaMeias(consolidado);
  exige(perto(impM.get(dia + 'T10:00'), 50, 1e-9) && perto(impM.get(dia + 'T10:30'), 50, 1e-9), 'impedida por meia hora: (250-150) x 0,5 = 50 MWh em cada');
  const m = L.prMeias(dia, eM, sM, impM, d);
  exige(m.irr[11] === 400, 'meia hora 05:30: trapezio de 0 e 800 = 400 W/m2 (veio ' + m.irr[11] + ') - a amostra em T daria 0');
  exige(m.irr[20] === 800 && perto(m.pr[20], 100 * 100 / (L.P_CC_MWP * 0.4), 0.051), 'meia hora 10:00: PR = 100 / (425,677 x 0,4) (veio ' + m.pr[20] + ')');
  exige(m.prc != null && perto(m.prc[20], 100 * 150 / (L.P_CC_MWP * 0.4), 0.051), 'corrigido das 10:00 soma os 50 MWh impedidos (veio ' + (m.prc && m.prc[20]) + ')');
  exige(m.irr[35] === 430, '17:30: trapezio de 800 e 60 = 430 W/m2 (veio ' + m.irr[35] + ')');
  exige(m.irr[36] === 30 && m.pr[36] === null, '18:00 com 30 W/m2 (abaixo de 100) nao pode ter PR');
  const semC = L.prMeias(dia, eM, sM, impM, semAp);
  exige(semC.prc === null && semC.imp === null && semC.pr[20] != null, 'dia sem corrigido: a meia hora nao reabre a pergunta');
  const muito = new Map(eM); muito.set(dia + 'T08:00', { inj_mwh: 500, n: 6 });
  const mt = L.prMeias(dia, muito, sM, impM, d);
  exige(mt.pr[16] === null && mt.acima_teto >= 1, 'PR acima de 110 % sai vazio e contado');
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

  /* -- a meia hora publicada -- */
  let ph = null;
  if (process.env.PR_HORA_ARQ) ph = JSON.parse(zlib.gunzipSync(require('fs').readFileSync(process.env.PR_HORA_ARQ)).toString('utf8'));
  else { try { ph = await puxa(BASE + 'pr_hora.json'); } catch (e) { if (!/HTTP 404/.test(e.message)) throw e; } }
  if (!ph) { console.log('pr_hora.json ainda nao publicado: a meia hora so foi julgada na regra'); return fim(); }
  const ons = await puxa(BASE + 'ons_restricao_all.json');
  const lim = new Set((ons.consolidado || []).filter(x => parseFloat(String(x.lim || '').replace(',', '.')) > 0).map(x => String(x.ts).slice(0, 16).replace(' ', 'T')));
  const porDia = new Map(pr.dias.map(d => [d.dia, d]));
  let fech = 0, conf = 0; const lado = { manha: [0, 0], tarde: [0, 0] };
  for (const m of ph.dias) {
    exige(m.inj.length === 48 && m.irr.length === 48 && m.pr.length === 48, m.dia + ': vetor sem 48 meias horas');
    const d = porDia.get(m.dia);
    exige(!!m.prc === !!(d && d.pr_corrigido_pct != null), m.dia + ': corrigido na meia hora sem corrigido no dia (ou o contrario)');
    if (d && d.horas_validas === 24 && !m.inj.some(x => x == null) && !m.irr.some(x => x == null)) {
      fech++;
      const E = m.inj.reduce((a, x) => a + x, 0), Hm = m.irr.reduce((a, x) => a + x, 0) / 2000;
      exige(perto(E, d.inj_mwh, 0.001 * d.inj_mwh + 0.03), m.dia + ': energia das meias horas ' + E.toFixed(3) + ' contra ' + d.inj_mwh + ' do dia');
      exige(perto(Hm, d.h_kwh_m2, 0.001 * d.h_kwh_m2 + 0.003), m.dia + ': irradiacao das meias horas ' + Hm.toFixed(4) + ' contra ' + d.h_kwh_m2 + ' do dia');
    }
    for (let i = 0; i < 48; i++) {
      const w = m.irr[i], e = m.inj[i];
      if (m.pr[i] == null) continue;
      conf++;
      exige(w >= ph.criterios.piso_irr_w_m2, m.dia + ' ' + i + ': PR abaixo do piso de irradiancia');
      /* o publicado vem arredondado: a tolerancia sai das casas (inj 3, irr 1, pr 1) */
      const p = 100 * e / (ph.p_cc_mwp * w / 2000), tol = 0.051 + p * (0.0005 / Math.max(e, 0.001) + 0.05 / w);
      exige(perto(m.pr[i], p, tol), m.dia + ' ' + i + ': PR ' + m.pr[i] + ' nao sai de ' + e + ' MWh e ' + w + ' W/m2 (' + p.toFixed(2) + ')');
      const k = m.dia + 'T' + String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00');
      const lad = i >= 13 && i <= 17 ? 'manha' : i >= 30 && i <= 34 ? 'tarde' : null;   /* 06:30-08:30 e 15:00-17:00 */
      if (lad && !lim.has(k)) { lado[lad][0] += e; lado[lad][1] += ph.p_cc_mwp * w / 2000; }
    }
  }
  /* 5 e o piso contra a VACUIDADE: a primeira rodada preenche so os 60 dias mais recentes, e 07-23/08 nao tem estacao */
  exige(fech >= 5, 'so ' + fech + ' dias fechados com o dia - a conferencia nao julgou o bastante');
  const prL = k => 100 * lado[k][0] / lado[k][1];
  exige(lado.manha[1] > 0 && lado.tarde[1] > 0 && Math.abs(prL('manha') - prL('tarde')) < 8,
    'manha ' + prL('manha').toFixed(1) + ' % contra tarde ' + prL('tarde').toFixed(1) + ' % nas meias horas livres - a janela da irradiancia desalinhou');
  console.log('meia hora: ' + ph.dias.length + ' dias · ' + fech + ' fechados com o dia · ' + conf + ' PR refeitos · manha ' + prL('manha').toFixed(1) + ' % x tarde ' + prL('tarde').toFixed(1) + ' %');
  fim();
})().catch(e => { console.error('REPROVADO: ' + e.message); process.exit(1); });

function fim() {
  if (falhas.length) { falhas.forEach(f => console.error('REPROVADO: ' + f)); process.exit(1); }
  console.log('ensaio-pr: passou');
}
