/*
 * ensaio-disp-retroativa.js — a disponibilidade volta para os dias que estavam no blob sem ela.
 *
 * Roda contra o DADO PUBLICADO, sem segredo nenhum: os dois blobs são públicos. É o ensaio do
 * `completaDisponibilidade`, e ele tem os dois lados:
 *
 *   POSITIVA · os dias que estão no `perdas_inv` e não têm `*_disp_pct` no `perdas_diario`
 *              PASSAM a ter, nas nove usinas, com o complexo e a janela do dia — e o valor cai
 *              na faixa que a lib já valida.
 *   NEGATIVA · 🔴 os dias que JÁ tinham disponibilidade saem **byte a byte idênticos**. É o que
 *              separa "preencher o que falta" de "recalcular o histórico": um lote que mexesse
 *              em número já publicado mudaria o que o leitor viu ontem, sem dizer.
 *
 * ⚠️ E um terceiro lado, que é o que autoriza rodar isto: a janela de cada dia é calculada DENTRO
 *    daquele dia, então alimentar a função com 49 dias em vez de 30 não pode mover nenhum valor.
 *    O ensaio prova isso comparando o resultado das duas alimentações no conjunto comum.
 *
 * uso: node scripts/ensaio-disp-retroativa.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const { disponibilidade, completaDisponibilidade } = require('./lib-disponibilidade.js');

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const US = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];

const puxa = (u) => new Promise((ok, no) => {
  https.get(u, (r) => {
    if (r.statusCode !== 200) { r.resume(); return no(new Error('HTTP ' + r.statusCode)); }
    const b = []; r.on('data', (d) => b.push(d));
    r.on('end', () => { let x = Buffer.concat(b);
      if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
      try { ok(JSON.parse(x.toString('utf8'))); } catch (e) { no(e); } });
  }).on('error', no);
});

const campos = (o) => Object.keys(o).filter((k) => /_disp_pct$|_inv_parados$|_inv_parciais$|_inv_contador_24h$|^janela_h$|^CX_disp_pct$/.test(k));

(async () => {
  const falhas = [];
  const inv = await puxa(BASE + 'perdas_inv.json');
  const dia = await puxa(BASE + 'perdas_diario.json');
  const linhasInv = (inv.serie || []).map((o) => ({ dia: o.dia, ufv: o.ufv, ts: o.ts, inv: o.inv, horas: o.horas }));
  console.log('perdas_inv: ' + linhasInv.length + ' linhas · perdas_diario: ' + (dia.serie || []).length + ' dias');

  /* ---------- 3 · a janela e POR DIA: alimentar mais dias nao move nada ---------- */
  const diasInv = [...new Set(linhasInv.map((l) => l.dia))].sort();
  const recorte = diasInv.slice(-30);
  const A = disponibilidade(linhasInv.filter((l) => recorte.indexOf(l.dia) >= 0)).porDia;
  const B = disponibilidade(linhasInv).porDia;
  let comparados = 0;
  for (const d of recorte) {
    const a = A.get(d), b = B.get(d);
    if (!a || !b) { falhas.push('dia ' + d + ' sumiu de uma das alimentacoes'); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) falhas.push('dia ' + d + ' MUDOU ao alimentar com mais dias');
    else comparados += 1;
  }
  console.log('3 · janela por dia: ' + comparados + ' dias idênticos com 30 e com ' + diasInv.length + ' dias de alimentação');

  /* ---------- 1 e 2 · o preenchimento ---------- */
  const antes = JSON.parse(JSON.stringify(dia.serie || []));
  const tinha = new Set(antes.filter((l) => l.CX_disp_pct != null).map((l) => l.dia));
  const serie = JSON.parse(JSON.stringify(dia.serie || []));
  const n = completaDisponibilidade(serie, B, US, r2);
  console.log('1 · preencheu ' + n + ' dia(s)');

  const semAntes = antes.filter((l) => l.CX_disp_pct == null).map((l) => l.dia);
  const semDepois = serie.filter((l) => l.CX_disp_pct == null).map((l) => l.dia);
  const recuperados = semAntes.filter((d) => semDepois.indexOf(d) < 0);
  const teimosos = semDepois.filter((d) => diasInv.indexOf(d) >= 0);
  console.log('    sem disponibilidade: ' + semAntes.length + ' antes → ' + semDepois.length + ' depois'
    + '  (recuperados: ' + recuperados.join(' ') + ')');
  if (teimosos.length) falhas.push('dias com contador no perdas_inv e ainda sem disponibilidade: ' + teimosos.join(' '));
  if (!recuperados.length) falhas.push('nao recuperou dia nenhum — o ensaio nao julgou nada');

  for (const d of recuperados) {
    const l = serie.find((x) => x.dia === d);
    const faltando = US.filter((u) => l[u + '_disp_pct'] == null);
    if (faltando.length) falhas.push(d + ': ' + faltando.length + ' usina(s) sem valor (' + faltando.join(',') + ')');
    if (l.janela_h == null) falhas.push(d + ': sem janela_h');
    else if (l.janela_h < 10 || l.janela_h > 14) falhas.push(d + ': janela de ' + l.janela_h + ' h fora de 10–14');
    const fora = US.filter((u) => l[u + '_disp_pct'] != null && (l[u + '_disp_pct'] < 50 || l[u + '_disp_pct'] > 100));
    if (fora.length) falhas.push(d + ': disponibilidade fora de 50–100% em ' + fora.join(','));
  }

  /* 🔴 a NEGATIVA: o que já tinha, não muda */
  let intactos = 0;
  for (const l of serie) {
    if (!tinha.has(l.dia)) continue;
    const a = antes.find((x) => x.dia === l.dia);
    const ca = campos(a).sort(), cb = campos(l).sort();
    if (JSON.stringify(ca) !== JSON.stringify(cb)) { falhas.push(l.dia + ': o conjunto de campos mudou'); continue; }
    const dif = ca.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(l[k]));
    if (dif.length) falhas.push(l.dia + ': valor MUDOU em ' + dif.slice(0, 3).join(','));
    else intactos += 1;
  }
  console.log('2 · ' + intactos + ' dia(s) que já tinham disponibilidade saíram idênticos');
  if (intactos < 30) falhas.push('julguei só ' + intactos + ' dias intactos — pouco para valer');

  /* e nenhuma outra coluna do diário foi tocada */
  for (const l of serie) {
    const a = antes.find((x) => x.dia === l.dia);
    const outras = Object.keys(a).filter((k) => campos(a).indexOf(k) < 0 && campos(l).indexOf(k) < 0);
    const dif = outras.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(l[k]));
    if (dif.length) { falhas.push(l.dia + ': mexeu fora da disponibilidade — ' + dif.slice(0, 3).join(',')); break; }
  }

  console.log('\n' + (falhas.length ? '🔴 ' + falhas.length + ' FALHA(S)\n   - ' + falhas.slice(0, 8).join('\n   - ')
    : '✅ tudo passou'));
  if (falhas.length) process.exit(1);
})().catch((e) => { console.log('🔴 ' + e.message); process.exit(1); });
