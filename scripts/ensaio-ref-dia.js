/*
 * ensaio-ref-dia.js — a referencia do operador contra a verificada, crua, dia a dia (`ref_dia_ufv`).
 *
 * POR QUE EXISTE. Em 23/09/2026 o painel executivo ganhou "Referencia do operador contra a verificada": as correcoes
 * de medicao de 12/07 (M3) e 17/07 (M7) chegaram a geracao VERIFICADA que o operador publica e nao a de REFERENCIA,
 * e ha tratativa em curso. O campo existe para MOSTRAR esse defeito da fonte — entao a primeira coisa que ele tem de
 * provar e que e CRU: nada somado, trocado ou reconstruido no caminho. Tratado, ele esconderia o que existe para
 * mostrar, e a tela ficaria bonita e errada.
 *
 * TRES EXIGENCIAS, sobre o PRODUTO publicado:
 *   1 · CRU — cada usina, em dias sorteados de cada mes, bate com o arquivo mensal do operador (ge e gv x 0,5 h, e a
 *       irradiancia valida integrada). E a segunda rota: o gerador ja fecha o Complexo contra o arquivo do CONJUNTO;
 *       este ensaio fecha cada USINA contra o arquivo POR USINA.
 *   2 · AGREGADOS — Complexo = soma das nove, PPA + ML = Complexo, tudo-ou-nada, o par livre nunca acima do dia
 *       inteiro, dia excluido com o par livre nulo, as horas de limitacao iguais entre as entidades do mesmo dia.
 *   3 · PLANTIO — tres defeitos plantados numa copia sadia tem de reprovar, cada um pela exigencia certa.
 *
 * Roda DEPOIS de gerar. Sem segredo: le blob publico; `BASE_DADOS` apontando para um DIRETORIO le o executivo do
 * disco (o arquivo mensal do operador continua vindo do blob), para exercita-lo antes de publicar.
 */
const https = require('https'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const BLOB = 'https://rbenergydata.blob.core.windows.net/dados/';
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML = ['M1', 'M7', 'M9'], NOVE = PPA.concat(ML);
const GRUPOS = { Complexo: NOVE, PPA, ML };
const INVALIDO = x => String(x) === 'True' || String(x) === '1';   // as duas grafias do arquivo (CSV ate jul, Parquet desde ago)
// o inicio da serie sai do PROPRIO gerador — escrito de novo aqui, as duas copias divergiriam na primeira edicao
const REF_DESDE = (function () {
  const m = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8').match(/const REF_DESDE = '(\d{4}-\d{2}-\d{2})'/);
  if (!m) { console.error('✗ nao achei REF_DESDE no gen-executivo.js'); process.exit(1); }
  return m[1];
})();

function baixa(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 180000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}
const leExec = () => /^https?:/i.test(BASE) ? baixa(BASE + 'executivo.json')
  : Promise.resolve(JSON.parse(fs.readFileSync(path.join(BASE, 'executivo.json'), 'utf8')));

/* 1 · CRU — devolve a lista de divergencias contra o arquivo mensal por usina */
function julgaCru(R, cru, dias) {
  const ruins = []; let n = 0;
  for (const dia of dias) {
    const esp = {};
    for (const r of cru[dia.slice(0, 7)] || []) {
      if (String(r.ts).slice(0, 10) !== dia) continue;
      const u = String(r.u).replace('CEFMT', 'M'), e = esp[u] || (esp[u] = { ref: 0, ger: 0, irr: 0 });
      e.ref += (+r.ge || 0) * 0.5; e.ger += (+r.gv || 0) * 0.5;
      if (!INVALIDO(r.inv)) e.irr += (+r.irr || 0) * 0.5 / 1000;
    }
    for (const u of NOVE) {
      const x = R.find(y => y.dia === dia && y.ufv === u), e = esp[u];
      if (!x || !e) { ruins.push(dia + ' ' + u + ': ' + (x ? 'nao esta no arquivo do operador' : 'nao esta no produto')); continue; }
      n++;
      for (const [k, v] of [['ref_mwh', e.ref], ['ger_mwh', e.ger], ['irr_kwh_m2', e.irr]])
        if (Math.abs(x[k] - v) > 0.011) ruins.push(dia + ' ' + u + ' ' + k + ': produto ' + x[k] + ' · operador ' + v.toFixed(3));
    }
  }
  return { ruins, n };
}

/* 2 · AGREGADOS */
function julgaAgregados(R) {
  const ruins = [], porDia = {};
  R.forEach(x => { (porDia[x.dia] = porDia[x.dia] || {})[x.ufv] = x; });
  for (const dia of Object.keys(porDia).sort()) {
    const d = porDia[dia];
    if (dia < REF_DESDE) ruins.push(dia + ': antes de ' + REF_DESDE);
    const lim = new Set(Object.values(d).map(x => x.lim_h));
    if (lim.size > 1) ruins.push(dia + ': horas de limitacao diferentes entre entidades (' + [...lim] + ')');
    for (const x of Object.values(d)) {
      if (x.excluido && (x.ref_livre_mwh != null || x.ger_livre_mwh != null)) ruins.push(dia + ' ' + x.ufv + ': dia excluido com o par livre preenchido');
      if (!x.excluido && x.ref_livre_mwh != null && (x.ref_livre_mwh > x.ref_mwh + 0.011 || x.ger_livre_mwh > x.ger_mwh + 0.011))
        ruins.push(dia + ' ' + x.ufv + ': o par livre acima do dia inteiro');
    }
    for (const [g, L] of Object.entries(GRUPOS)) {
      const todas = L.every(u => d[u]);
      if (!todas) { if (d[g]) ruins.push(dia + ' ' + g + ': publicado com usina faltando (tudo-ou-nada)'); continue; }
      if (!d[g]) { ruins.push(dia + ' ' + g + ': as usinas estao e o agregado nao'); continue; }
      for (const k of ['ref_mwh', 'ger_mwh', 'ref_livre_mwh', 'ger_livre_mwh']) {
        if (d[g][k] == null) continue;
        const s = L.reduce((a, u) => a + d[u][k], 0), tol = 0.005 * (L.length + 1) + 0.001;   // cada parcela arredondada a 2 casas
        if (Math.abs(d[g][k] - s) > tol) ruins.push(dia + ' ' + g + ' ' + k + ': ' + d[g][k] + ' contra a soma das usinas ' + s.toFixed(2));
      }
      const mi = L.reduce((a, u) => a + d[u].irr_kwh_m2, 0) / L.length;
      if (Math.abs(d[g].irr_kwh_m2 - mi) > 0.011) ruins.push(dia + ' ' + g + ': irradiancia ' + d[g].irr_kwh_m2 + ' contra a media ' + mi.toFixed(3));
    }
    if (d.PPA && d.ML && d.Complexo && Math.abs(d.PPA.ref_mwh + d.ML.ref_mwh - d.Complexo.ref_mwh) > 0.021)
      ruins.push(dia + ': PPA + ML nao fecha com o Complexo na referencia');
  }
  return ruins;
}

(async () => {
  const J = await leExec();
  const R = J.ref_dia_ufv;
  if (!Array.isArray(R) || !R.length) { console.error('✗ o produto nao publica ref_dia_ufv'); process.exit(1); }
  const meses = [...new Set(R.map(x => x.mes))].sort();
  const cru = {};
  for (const m of meses) cru[m] = (await baixa(BLOB + 'ons_irradiancia_' + m.replace('-', '_') + '.json')).consolidado;
  // dias sorteados SEM acaso: o primeiro, o do meio e o ultimo de cada mes, mais os das duas correcoes e os vizinhos
  const todos = [...new Set(R.map(x => x.dia))].sort();
  const dias = new Set(['2026-07-11', '2026-07-12', '2026-07-16', '2026-07-17'].filter(d => todos.includes(d)));
  meses.forEach(m => { const L = todos.filter(d => d.startsWith(m)); [L[0], L[L.length >> 1], L[L.length - 1]].forEach(d => d && dias.add(d)); });
  const D = [...dias].sort();

  let falhas = 0;
  const c = julgaCru(R, cru, D);
  console.log('1 · CRU: %d usina-dias de %d dias contra o arquivo mensal do operador', c.n, D.length);
  c.ruins.slice(0, 12).forEach(x => console.error('  ✗ ' + x)); falhas += c.ruins.length;
  if (c.n < 9 * D.length) { console.error('  ✗ conferiu %d de %d usina-dias — faltou dado para julgar', c.n, 9 * D.length); falhas++; }
  const a = julgaAgregados(R);
  console.log('2 · AGREGADOS: %d linhas, %d dias, de %s a %s', R.length, todos.length, todos[0], todos[todos.length - 1]);
  a.slice(0, 12).forEach(x => console.error('  ✗ ' + x)); falhas += a.length;

  // 3 · PLANTIO — cada defeito tem de reprovar pela exigencia CERTA, numa copia sadia
  const copia = () => JSON.parse(JSON.stringify(R));
  const planta = [
    ['o M7 somado ao M3 antes do reparo (o campo deixaria de ser cru)', 'cru', P => {
      P.filter(x => x.ufv === 'M3' && x.dia < '2026-07-12').forEach(x => { const m7 = P.find(y => y.ufv === 'M7' && y.dia === x.dia); if (m7) x.ref_mwh = +(x.ref_mwh + m7.ref_mwh).toFixed(2); }); }],
    ['o Complexo publicado sem uma usina num dia', 'agr', P => { const i = P.findIndex(x => x.ufv === 'M9' && x.dia === D[0]); P.splice(i, 1); }],
    ['o par livre acima do dia inteiro', 'agr', P => { const x = P.find(y => y.ufv === 'M5' && y.dia === D[1] && y.ref_livre_mwh != null); x.ref_livre_mwh = x.ref_mwh + 5; }],
  ];
  for (const [nome, qual, f] of planta) {
    const P = copia(); f(P);
    if (JSON.stringify(P) === JSON.stringify(R)) { console.error('  ✗ plantio "%s" nao alterou nada — nao prova nada', nome); falhas++; continue; }
    const r = qual === 'cru' ? julgaCru(P, cru, D).ruins : julgaAgregados(P);
    if (r.length) console.log('3 · PLANTIO: "%s" reprovado (%s)', nome, r[0]);
    else { console.error('  ✗ o plantio "%s" passou — a exigencia nao julga', nome); falhas++; }
  }
  if (falhas) { console.error('✗ %d falha(s)', falhas); process.exit(1); }
  console.log('✓ ref_dia_ufv: cru, fechado e com as guardas provadas');
})().catch(e => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
