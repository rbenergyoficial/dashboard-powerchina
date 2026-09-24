/*
 * ensaio-inv-scada-dia.js — o historico da razao contra os pares esta rotulado pelo dia do CONTEUDO.
 *
 * POR QUE EXISTE. Ate 24/09/2026 o `gen-inv-scada.js` rotulava cada dia pelo NOME do arquivo, que e a
 * data do EXPORT e cobre o dia anterior: todo o historico saia com um dia de atraso, e nada acusava —
 * o numero era plausivel, so estava no dia errado. O `gen-perdas.js` sempre rotulou pelo conteudo.
 *
 * A PROVA NAO E A DATA DO ARQUIVO, E A ASSINATURA DO DIA. Cada dia tem um padrao proprio entre os
 * inversores (paradas, strings fracas, sombra), que nao se repete no vizinho. Para cada dia do
 * historico, a energia de cada inversor tem de se correlacionar MAIS com o `perdas_inv` do MESMO dia
 * (rotulado pelo conteudo) do que com o de ontem ou o de amanha.
 *   · dia DECIDIDO = o melhor deslocamento vence o segundo por pelo menos MARGEM; empate nao julga
 *     (dias de ceu parecido tem energia parecida);
 *   · pelo menos FRACAO_MIN dos dias decididos tem de escolher o deslocamento ZERO. Nao TODOS: num dia
 *     nublado a energia integrada em amostras de 30 min se afasta do contador inversor a inversor
 *     (23/09/2026: 0,94 a 1,09 contra 0,99 a 1,00 no dia limpo anterior), e um vizinho de ceu limpo
 *     pode vencer a assinatura do proprio dia; e um dia com a referencia contaminada (12/08, carimbo
 *     sem registro no M4) tambem. O defeito que este ensaio pega e SISTEMATICO — o historico inteiro
 *     deslocado —, e ai a fracao cai a quase zero. Os dias fora vao listados, como informacao;
 *   · e tem de haver pelo menos MIN_DECIDIDOS dias decididos — senao o ensaio passaria sem julgar.
 * Rodado contra o historico de antes da correcao, ele reprova (o melhor era −1 em 55 de 60 dias).
 *
 * Roda DEPOIS de gerar. `LOCAL_DIR` le o historico de uma rodada local; o `perdas_inv` vem sempre do ar.
 */
'use strict';
const https = require('https'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const MARGEM = 0.02, MIN_DECIDIDOS = 10, MIN_PARES = 500, FRACAO_MIN = 0.9;

const baixa = (nome) => new Promise((ok, ko) => {
  https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 180000 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return ko(new Error(nome + ': HTTP ' + r.statusCode)); }
    const s = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
    const c = []; s.on('data', (d) => c.push(d));
    s.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
  }).on('error', ko);
});
const leHist = () => {
  if (!process.env.LOCAL_DIR) return baixa('inv_scada_hist.json');
  let b = fs.readFileSync(path.join(process.env.LOCAL_DIR, 'inv_scada_hist.json'));
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return Promise.resolve(JSON.parse(b.toString('utf8')));
};
const desloca = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
function correl(a, b) {
  const n = a.length, ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : null;
}

/* A REGRA, numa escrita so: o ensaio e o plantio chamam a mesma funcao */
function julga(hist, perdas) {
  const pm = new Map(perdas.map((x) => [x.dia + '|' + x.ufv + '|' + x.ts + '|' + x.inv, x.e_ca]));
  const dias = [...new Set(hist.map((x) => x.dia))].sort();
  const porDia = new Map();
  for (const x of hist) (porDia.get(x.dia) || porDia.set(x.dia, []).get(x.dia)).push(x);
  let decididos = 0, empates = 0, semPar = 0;
  const errados = [];
  for (const d of dias) {
    const r = [];
    for (const s of [-1, 0, 1]) {
      const a = [], b = [];
      for (const x of porDia.get(d)) {
        const p = pm.get(desloca(d, s) + '|' + x.ufv + '|' + x.ts + '|' + x.inv);
        if (p != null && x.kwh != null) { a.push(x.kwh); b.push(p); }
      }
      if (a.length >= MIN_PARES) { const c = correl(a, b); if (c != null) r.push([s, c]); }
    }
    if (r.length < 2) { semPar++; continue; }
    r.sort((x, y) => y[1] - x[1]);
    if (r[0][1] - r[1][1] < MARGEM) { empates++; continue; }
    decididos++;
    if (r[0][0] !== 0) errados.push(d + ' casa com o dia ' + (r[0][0] > 0 ? '+' : '') + r[0][0] + ' (' + r.map(([s, c]) => s + ':' + c.toFixed(3)).join(' ') + ')');
  }
  return { dias: dias.length, decididos, empates, semPar, errados };
}

(async () => {
  const [h, p] = await Promise.all([leHist(), baixa('perdas_inv.json')]);
  const hist = h.serie || [], perdas = p.serie || [];
  let mau = 0;
  const R = julga(hist, perdas);
  console.log('historico: %d dias · decididos %d · empates %d · sem par no perdas_inv %d · esquema %s',
    R.dias, R.decididos, R.empates, R.semPar, h.esquema == null ? '(sem marca)' : h.esquema);
  const fr = (X) => (X.decididos ? (X.decididos - X.errados.length) / X.decididos : 0);
  if (R.decididos < MIN_DECIDIDOS) { mau++; console.log('  ✗ so %d dia(s) decidido(s) — o ensaio nao julgou o bastante', R.decididos); }
  if (fr(R) < FRACAO_MIN) { mau++; console.log('  ✗ so %s%% dos dias decididos casam com o proprio dia (minimo %d%%)', (100 * fr(R)).toFixed(1), 100 * FRACAO_MIN); }
  else console.log('  ok  %s%% dos dias decididos casam com o proprio dia (minimo %d%%)', (100 * fr(R)).toFixed(1), 100 * FRACAO_MIN);
  R.errados.forEach((e) => console.log('      informativo · ' + e));

  // PLANTIO: o historico com o rotulo do NOME (um dia adiante) — o defeito que este ensaio existe para pegar
  const plantado = hist.map((x) => ({ ...x, dia: desloca(x.dia, 1) }));
  const P = julga(plantado, perdas);
  if (P.decididos >= MIN_DECIDIDOS && fr(P) < FRACAO_MIN) console.log('  ok  o historico com o rotulo do NOME reprova: %s%% dos dias casam', (100 * fr(P)).toFixed(1));
  else { mau++; console.log('  ✗ o plantio do rotulo pelo nome PASSOU — a regra nao julga'); }

  if (mau) { console.error('✗ ensaio-inv-scada-dia reprovou'); process.exit(1); }
  console.log('✓ o historico da razao contra os pares esta no dia do conteudo');
})().catch((e) => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
