/**
 * ensaio-disp-contrato.js - a disponibilidade pela janela do CONTRATO (irradiancia > 100 W/m2).
 *
 *   node scripts/ensaio-disp-contrato.js            regra (casos forjados) + produto publicado
 *   PERDAS_DIR=<pasta> node ...                     confere arquivos locais em vez do blob
 *
 * REGRA (sem rede), sobre a lib que o gerador usa:
 *   - o limiar e ESTRITO: 100 W/m2 fica de fora, 100,1 entra
 *   - inversor que gera em toda a janela = 100 %; em metade = 50 %; so fora da janela = 0 %
 *   - instante fora da janela NAO conta a favor (gerando > janela nao passa de 100 %)
 *   - dia com janela curta demais (menos de 6 h) nao vira medida
 *   - a usina e a MEDIA SIMPLES dos inversores, como o anexo do contrato manda
 * PRODUTO (rede, blobs publicos), so onde o campo ja existe:
 *   - a janela publicada bate com a contada no irr_30min, dia a dia e usina a usina
 *   - a disponibilidade da usina bate com a recomputada de `gerando`/`jan_slots` do perdas_inv
 *   - e ela NAO e a mesma do contador: as duas convivem, e a do contrato usa uma janela mais curta
 */
'use strict';
const zlib = require('zlib');
const L = require('./lib-disponibilidade.js');
const falhas = [];
const exige = (ok, msg) => { if (!ok) falhas.push(msg); };
const perto = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── REGRA ─────────────────────────────────────────────────────────────────────────────────────── */
(function regra() {
  const dia = '2026-09-10';
  const hm = (i) => 'T' + String(6 + Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00') + ':00-03:00';
  /* 24 instantes (12 h) acima do limiar, mais um exatamente em 100 e um abaixo */
  const serie = [];
  for (let i = 0; i < 24; i++) serie.push({ t: dia + hm(i), M1: 500, M2: 500 });
  serie.push({ t: dia + 'T05:30:00-03:00', M1: 100, M2: 100 });      /* igual ao limiar: fora */
  serie.push({ t: dia + 'T18:30:00-03:00', M1: 100.1, M2: 40 });     /* acima: entra so no M1 */
  const J = L.janelaContrato(serie, ['M1', 'M2']);
  exige(J.get(dia + '|M1').size === 25, 'M1 deveria ter 25 instantes na janela (veio ' + J.get(dia + '|M1').size + ')');
  exige(J.get(dia + '|M2').size === 24, 'M2 deveria ter 24 (o limiar e ESTRITO e 40 W/m2 esta fora)');
  exige(!J.get(dia + '|M1').has('05:30'), 'irradiancia IGUAL a 100 nao pode entrar na janela');

  const R = L.dispContrato([
    { dia, ufv: 'M2', ts: 'TS1', inv: 'INV01', gerando: 24 },     /* toda a janela */
    { dia, ufv: 'M2', ts: 'TS1', inv: 'INV02', gerando: 12 },     /* metade */
    { dia, ufv: 'M2', ts: 'TS1', inv: 'INV03', gerando: 0 },      /* parado */
    { dia, ufv: 'M2', ts: 'TS1', inv: 'INV04', gerando: 30 },     /* mais que a janela: nao passa de 100 */
  ], J).get(dia);
  const m2 = R.porUfv.M2;
  exige(m2.n === 4, 'quatro inversores no dia (veio ' + m2.n + ')');
  exige(perto(m2.disp_pct, (100 + 50 + 0 + 100) / 4, 0.01), 'media simples dos inversores: esperava 62,5 % e veio ' + m2.disp_pct);
  exige(perto(m2.janela_h, 12, 0.01), 'janela de 12 h (veio ' + m2.janela_h + ')');
  exige(m2.piores.length === 2 && m2.piores[0].inv === 'TS1/INV03', 'os piores inversores deveriam ser nomeados, do pior para o melhor');
  exige(R.complexo && perto(R.complexo.disp_pct, 62.5, 0.01), 'o conjunto e a media dos inversores de todas as usinas');

  const curto = { t: dia + 'T12:00:00-03:00', M3: 900 };
  const Jc = L.janelaContrato([curto], ['M3']);
  exige(L.dispContrato([{ dia, ufv: 'M3', inv: 'INV01', gerando: 1 }], Jc).size === 0,
    'dia com janela curta demais nao pode virar medida (seria 100 % com 30 min de sol)');
})();

/* ── PRODUTO ───────────────────────────────────────────────────────────────────────────────────── */
function puxa(url) {
  const https = require('https');
  return new Promise((ok, erro) => https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
    if (res.statusCode !== 200) { erro(new Error('HTTP ' + res.statusCode + ' ' + url.split('/').pop())); res.resume(); return; }
    const p = []; res.on('data', (c) => p.push(c));
    res.on('end', () => { let b = Buffer.concat(p); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); ok(JSON.parse(b.toString('utf8'))); });
  }).on('error', erro));
}
const le = async (nome) => {
  if (process.env.PERDAS_DIR) {
    const b = require('fs').readFileSync(require('path').join(process.env.PERDAS_DIR, nome));
    return JSON.parse((b[0] === 0x1f ? zlib.gunzipSync(b) : b).toString('utf8'));
  }
  return puxa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
};

(async () => {
  const [diario, inv, irr] = await Promise.all([le('perdas_diario.json'), le('perdas_inv.json'), puxa('https://rbenergydata.blob.core.windows.net/dados/irr_30min.json')]);
  const S = diario.serie || [];
  const comCampo = S.filter((o) => o.CX_disp_contrato_pct != null);
  if (!comCampo.length) {
    console.log('nenhum dia com disponibilidade pela janela do contrato ainda: so a regra foi julgada '
      + '(o campo nasce na primeira rodada que ler a curva)');
    return fim();
  }
  const us = (irr.ufvs || []).filter((u) => u !== 'Complexo');
  const J = L.janelaContrato(irr.serie, us);
  const R = L.dispContrato((inv.serie || []).map((o) => ({ dia: o.dia, ufv: o.ufv, ts: o.ts, inv: o.inv, gerando: o.gerando })), J);

  let dias = 0, pares = 0;
  for (const o of comCampo) {
    const C = R.get(o.dia);
    if (!C) { falhas.push(o.dia + ': o dia tem o campo publicado e nao se recompoe do perdas_inv'); continue; }
    dias++;
    exige(perto(o.CX_disp_contrato_pct, C.complexo.disp_pct, 0.02),
      o.dia + ': conjunto publicado ' + o.CX_disp_contrato_pct + ' contra ' + C.complexo.disp_pct + ' recomposto');
    exige(o.janela_contrato_h > 8 && o.janela_contrato_h < 14, o.dia + ': janela do contrato de ' + o.janela_contrato_h + ' h, fora de 8 a 14 h');
    for (const u of us) {
      if (o[u + '_disp_contrato_pct'] == null) continue;
      pares++;
      exige(perto(o[u + '_disp_contrato_pct'], C.porUfv[u].disp_pct, 0.02),
        o.dia + ' ' + u + ': ' + o[u + '_disp_contrato_pct'] + ' contra ' + C.porUfv[u].disp_pct);
      exige(o[u + '_disp_contrato_pct'] >= 50 && o[u + '_disp_contrato_pct'] <= 100,
        o.dia + ' ' + u + ': disponibilidade de ' + o[u + '_disp_contrato_pct'] + ' % fora de 50 a 100');
      exige(o[u + '_janela_contrato_h'] > 8 && o[u + '_janela_contrato_h'] < 14, o.dia + ' ' + u + ': janela fora de 8 a 14 h');
    }
    /* 🔴 a janela do contrato e MAIS CURTA que a do contador — e se nao for, uma das duas nao e o
       que se pensa (foi essa diferenca que reprovou a primeira versao, feita com o contador) */
    if (o.janela_h != null) exige(o.janela_contrato_h < o.janela_h,
      o.dia + ': janela do contrato ' + o.janela_contrato_h + ' h nao e menor que a do contador ' + o.janela_h + ' h');
  }
  exige(dias >= 1 && pares >= 3, 'julgou pouco: ' + dias + ' dias e ' + pares + ' pares usina-dia');
  console.log('produto: ' + dias + ' dia(s) e ' + pares + ' par(es) usina-dia conferidos contra o perdas_inv e o irr_30min');
  fim();
})().catch((e) => { console.error('REPROVADO: ' + e.message); process.exit(1); });

function fim() {
  if (falhas.length) { falhas.forEach((f) => console.error('REPROVADO: ' + f)); process.exit(1); }
  console.log('ensaio-disp-contrato: passou');
}
