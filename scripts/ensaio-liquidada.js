// Ensaio da guarda da EneatLiquida: prova que ela reprova liquidacao INCOMPLETA.
// Roda sem segredo nenhum — le os blobs publicos.
//
// A guarda antiga era `tot > 0`. Ela recusou o dia 30/08/2026 apenas porque a liquidacao
// parcial daquele dia CALHOU de ser negativa (-1,92 MWh, so o consumo noturno). Um dia
// 60% liquidado, com total positivo, passava e substituia o valor certo em silencio.
const https = require('https'), zlib = require('zlib');
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const PT = { 6368: 'M1', 6369: 'M2', 6373: 'M3', 6374: 'M4', 6375: 'M5',
             6376: 'M6', 6215: 'M7', 6378: 'M8', 6219: 'M9' };
// o teto sai dos dias aceitos, como no gen-executivo.js: 3x o maior residuo observado

const pega = (u) => new Promise((s, f) => https.get(u, { family: 4 }, (r) => {
  const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => {
    let x = Buffer.concat(b); if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
    const t = x.toString('utf8').replace(/^﻿/, '');
    if (t[0] !== '{' && t[0] !== '[') return f(new Error('HTTP ' + r.statusCode));
    try { s(JSON.parse(t)); } catch (e) { f(e); } }); }).on('error', f));

const porDia = (j) => { const o = {};
  (j.dados || []).forEach((d) => { const u = PT[d.pontoId]; if (!u) return;
    (d.valores || []).forEach((v) => { if (v.valor == null) return;
      (o[String(v.data).slice(0, 10)] = o[String(v.data).slice(0, 10)] || {})[u] = v.valor / 1000; }); });
  return o; };
const soma = (o) => o ? Object.values(o).reduce((a, b) => a + b, 0) : 0;

const antiga = (liq) => soma(liq) > 0;
let TETO_RES = null;
const nova = (liq, rec) => { const r = soma(rec);
  if (!(r > 100) || TETO_RES == null) return soma(liq) > 0;
  const res = r - soma(liq); return res > -1 && res <= TETO_RES; };

(async () => {
  const L = porDia(await pega(BASE + 'way2_energia_mes.json'));
  const R = porDia(await pega(BASE + 'way2_eneat_diario.json'));
  const dias = Object.keys(L).filter((d) => Object.keys(L[d]).length === 9
    && Object.keys(R[d] || {}).length === 9 && soma(R[d]) > 100).sort();
  const bons0 = dias.map((d) => soma(R[d]) - soma(L[d]))
    .filter((v, i) => v > 0 && v < soma(R[dias[i]]) * 0.5);
  TETO_RES = bons0.length >= 5 ? 3 * Math.max.apply(null, bons0) : null;
  console.log('teto do residuo, derivado dos dias aceitos: ' + TETO_RES.toFixed(1)
    + ' MWh (3x o maior de ' + bons0.length + ' dias)');
  console.log('');
  let falhas = 0;
  const diz = (nome, ok, esperado) => { const bom = ok === esperado;
    if (!bom) falhas++;
    console.log('  ' + (bom ? '✅' : '🔴') + ' ' + nome + ' · aceita=' + ok + ' (esperado ' + esperado + ')'); };

  console.log('1 · DIAS REAIS — todo dia com liquidacao completa tem de passar');
  let bons = 0, maus = 0;
  dias.forEach((d) => { const raz = soma(L[d]) / soma(R[d]);
    const esp = raz > 0.5;                       // as duas familias medidas: >95% ou ~0%
    if (nova(L[d], R[d]) === esp) (esp ? bons++ : maus++); else { falhas++;
      console.log('  🔴 ' + d + ' razao ' + (raz * 100).toFixed(1) + '%'); } });
  console.log('  ✅ ' + bons + ' dias completos aceitos · ' + maus + ' incompletos recusados'
    + ' (de ' + dias.length + ')');

  const cheio = dias.filter((d) => soma(L[d]) / soma(R[d]) > 0.9).pop();
  console.log('\n2 · O CASO QUE A GUARDA ANTIGA DEIXAVA PASSAR (base: ' + cheio + ')');
  [0.60, 0.30, 0.05].forEach((f) => {
    const parc = Object.fromEntries(Object.entries(L[cheio]).map(([u, v]) => [u, v * f]));
    console.log('  liquidado a ' + (f * 100) + '% — ' + soma(parc).toFixed(0) + ' MWh de '
      + soma(L[cheio]).toFixed(0));
    diz('    guarda ANTIGA (tot > 0)', antiga(parc), true);      // passava: e o defeito
    diz('    guarda NOVA  (vs EneatRec)', nova(parc, R[cheio]), false);
  });

  console.log('\n3 · O DIA 30/08/2026, que motivou a correcao');
  const d30 = '2026-08-30';
  if (L[d30] && R[d30]) {
    console.log('  liquidada ' + soma(L[d30]).toFixed(2) + ' MWh · EneatRec ' + soma(R[d30]).toFixed(2)
      + ' MWh · razao ' + (soma(L[d30]) / soma(R[d30]) * 100).toFixed(1) + '%');
    diz('  guarda NOVA', nova(L[d30], R[d30]), false);
  } else console.log('  (fora da janela do blob)');

  console.log('\n' + (falhas ? '🔴 ' + falhas + ' falha(s)' : '✅ ensaio limpo'));
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.log('ERRO ' + e.message); process.exit(1); });
