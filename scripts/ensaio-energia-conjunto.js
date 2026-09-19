/**
 * ensaio-energia-conjunto.js - a energia CC e CA da USINA no dia fecha com a soma dos INVERSORES.
 *
 *   node scripts/ensaio-energia-conjunto.js            produto publicado (blobs publicos)
 *   PERDAS_DIR=<pasta> node ...                         arquivos locais em vez do blob
 *
 * DUAS ROTAS sobre a mesma fonte: o `perdas_inv` integra cada inversor sobre os seus instantes com
 * CC e CA; o `perdas_diario` integra a usina, por instante, sobre o CONJUNTO dos inversores que tem
 * os dois lados naquele instante (regra de 19/09/2026). Se as duas concordam, nenhum instante foi
 * jogado fora por causa de um inversor que ainda nao estava na coleta — que e o defeito que a regra
 * anterior tinha (M9 em 18/09/2026: 19 de 48 instantes, 4,0 MWh contra 12,16 do contador).
 *
 * 🔴 Rodado contra o blob ANTERIOR a regra, este ensaio REPROVA: la a usina descartava o instante
 *    inteiro quando faltava um inversor, e a soma dos inversores ficava ACIMA da usina. E isso que
 *    mostra que ele mede — e por isso ele julga so os dias recalculados sob a regra nova.
 *
 * ⚠️ Quais dias sao esses: os que tem `lidos` no perdas_inv. O campo nasceu no mesmo dia da regra, e
 *    a janela de recalculo do gerador e a mesma para os dois; dia mais velho que a janela da fonte
 *    nao e recalculado e ficou com a regra antiga — e nao e julgado aqui, de proposito.
 */
'use strict';
const zlib = require('zlib');
const falhas = [];
const exige = (ok, msg) => { if (!ok) falhas.push(msg); };

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
  const [diario, inv] = await Promise.all([le('perdas_diario.json'), le('perdas_inv.json')]);
  const D = new Map((diario.serie || []).map((o) => [o.dia, o]));
  // soma dos inversores por dia e usina, so nos dias recalculados sob a regra nova
  const S = new Map(); const diasNovos = new Set();
  for (const o of inv.serie || []) {
    if (o.lidos == null) continue;
    diasNovos.add(o.dia);
    const k = o.dia + '|' + o.ufv;
    if (!S.has(k)) S.set(k, { cc: 0, ca: 0, n: 0 });
    const s = S.get(k); s.cc += o.e_cc || 0; s.ca += o.e_ca || 0; s.n++;
  }
  exige(diasNovos.size >= 3, 'poucos dias sob a regra nova para julgar: ' + diasNovos.size);

  let pares = 0, piorCC = 0, piorCA = 0, onde = '';
  for (const [k, s] of S) {
    const [dia, ufv] = k.split('|');
    const o = D.get(dia); if (!o || o[ufv + '_e_cc'] == null) continue;
    pares++;
    // tolerancia DERIVADA: cada inversor vai com 4 casas (±0,00005) e a usina com 2 (±0,005)
    const tol = 0.005 + s.n * 0.00005 + 1e-9;
    const dcc = Math.abs(o[ufv + '_e_cc'] - s.cc), dca = Math.abs(o[ufv + '_e_ca'] - s.ca);
    if (dcc > piorCC) { piorCC = dcc; onde = dia + ' ' + ufv; }
    if (dca > piorCA) piorCA = dca;
    exige(dcc <= tol, dia + ' ' + ufv + ': e_cc da usina ' + o[ufv + '_e_cc'] + ' contra ' + s.cc.toFixed(4) + ' somando ' + s.n + ' inversores (tol ' + tol.toFixed(4) + ')');
    exige(dca <= tol, dia + ' ' + ufv + ': e_ca da usina ' + o[ufv + '_e_ca'] + ' contra ' + s.ca.toFixed(4) + ' somando ' + s.n + ' inversores');
    // a cobertura dentro do dia so e publicada quando variou, e entao tem de ser menor que 100 e vir com o minimo
    const cob = o[ufv + '_cob_inst_pct'];
    if (cob != null) exige(cob < 100 && o[ufv + '_n_inv_min'] != null && o[ufv + '_n_inv_min'] < o[ufv + '_n_inv'],
      dia + ' ' + ufv + ': cob_inst_pct ' + cob + ' publicado sem variacao real (n_inv_min ' + o[ufv + '_n_inv_min'] + ' de ' + o[ufv + '_n_inv'] + ')');
  }
  exige(pares >= 20, 'julgou pouco: ' + pares + ' pares dia-usina');
  console.log('fechamento usina x soma dos inversores: ' + pares + ' pares em ' + diasNovos.size + ' dias · pior desvio CC '
    + piorCC.toFixed(4) + ' MWh (' + onde + ') · CA ' + piorCA.toFixed(4) + ' MWh');

  if (falhas.length) { falhas.slice(0, 12).forEach((f) => console.error('REPROVADO: ' + f)); if (falhas.length > 12) console.error('... e mais ' + (falhas.length - 12)); process.exit(1); }
  console.log('ensaio-energia-conjunto: passou');
})().catch((e) => { console.error('REPROVADO: ' + e.message); process.exit(1); });
