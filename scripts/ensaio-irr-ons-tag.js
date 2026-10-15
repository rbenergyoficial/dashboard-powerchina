/*
 * ensaio-irr-ons-tag.js — o M7 da irradiancia do ONS (CEFMT7) e a guarda que o confere mes a mes (PROMOVER irr-ons-m7).
 *
 *   --lib     · a REGRA em casos forjados, antes de gerar (vale em qualquer estado do mundo):
 *               o mapa tem as nove tags (CEFMT7 = M7); a chave do ONS e a do datalogger caem no MESMO slot no rotulo de borda
 *               (10:30 BRT, ts sem offset de um lado e epoch do outro); celula vazia e medida invalida ficam de fora; um mes em
 *               que o ONS do M7 segue o datalogger do M7 fica ('confere'); um mes em que segue o do M3 sai INTEIRO ('retirado')
 *               e as outras usinas ficam; um mes com menos de N_MIN pares fica ('sem_conferencia'); a madrugada abaixo do
 *               limiar NAO conta (forjada colada no M3 e em maioria: se contasse, o mes viraria 'retirado'); med_outras sai da
 *               concordancia das outras usinas; sem o datalogger o M7 sai inteiro ('sem_referencia').
 *               Plantios: a lib mutada por troca de texto; a ancora que nao casa REPROVA O ENSAIO; a mutacao que lanca
 *               excecao reprova o ensaio; cada plantio tem de cair na flag que declara.
 *   --produto · depois do gerador, sobre o publicado: o irr_ufv.json tem `ons_tag_m7` com ao menos um mes 'confere';
 *               'sem_referencia' com o datalogger legivel reprova; a conferencia REFEITA aqui da fonte crua (os ons_irradiancia
 *               de cada mes e o estacao_logger_30min.json, pelas MESMAS funcoes da lib) bate com a publicada mes a mes (uso,
 *               pares, medianas) — e o fio do gerador (slot, chave, referencia); no irr_plano_30min, a contagem de ons_w_M7 de
 *               cada mes conferido INTEIRO na janela e a mesma de leituras do M7 no ONS; mes retirado sem ons_w_M7 no plano de
 *               30 e de 60 min. Declara (nao reprova) o mes em que o M7 concorda pior que as outras usinas.
 *   --real    · diagnostico manual (fora do workflow): a regra sobre o dado publicado, so declarando.
 *   sem argumento, --lib.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const LIB = path.join(__dirname, 'lib-irr-ons-tag.js');

let falhas = 0;
const ok = (c, msg) => { if (c) console.log('  ✓ ' + msg); else { falhas++; console.log('  ✗ ' + msg); } };
const declara = (msg) => console.log('  ℹ️ ' + msg);

const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) {
    const f = path.join(BASE, nome);
    if (!fs.existsSync(f)) return Promise.reject(new Error('HTTP 404 em ' + nome));
    return Promise.resolve(deJson(fs.readFileSync(f)));
  }
  return new Promise((res, rej) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { try { res(deJson(Buffer.concat(c))); } catch (e) { rej(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome)));
    req.on('error', rej);
  });
}

/* a lib, opcionalmente mutada: carrega o texto e avalia num modulo novo. Ancora que nao casa e erro do ENSAIO. */
function carrega(troca) {
  let src = fs.readFileSync(LIB, 'utf8');
  if (troca) {
    if (src.indexOf(troca[0]) < 0) { const e = new Error('plantio sem ancora: ' + troca[0]); e.semAncora = true; throw e; }
    src = src.split(troca[0]).join(troca[1]);
  }
  const m = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', src)(m, m.exports, (p) => require(p.startsWith('.') ? path.join(__dirname, p) : p), __dirname);
  return m.exports;
}

/* o caso forjado: o datalogger do M7 a ~600, o do M3 a ~800; o ONS em tres meses */
function forjado() {
  const ons = {}, dl = {};
  const poe = (d, u, s, v) => { ons[d + '|' + u + '|' + s] = v; };
  const dias = (m, n) => Array.from({ length: n }, (_, i) => m + '-' + String(i + 1).padStart(2, '0'));
  for (const d of dias('2026-08', 3)) for (let s = 20; s < 32; s++) {   // 36 pares: o ONS do M7 segue o datalogger do M7
    dl[d + '|M7|' + s] = 600 + s; dl[d + '|M3|' + s] = 800 + s; dl[d + '|M1|' + s] = 700; poe(d, 'M7', s, 601 + s); poe(d, 'M1', s, 703);
  }
  for (const d of dias('2026-08', 3)) for (let s = 2; s < 16; s++) {    // 42 madrugadas: o ONS do M7 a 50 W/m2 (abaixo do limiar),
    dl[d + '|M7|' + s] = 900; dl[d + '|M3|' + s] = 50; poe(d, 'M7', s, 50);   // colado no M3 e em MAIORIA: se contasse, o mes saia
  }
  for (const d of dias('2026-09', 3)) for (let s = 20; s < 32; s++) {   // 36 pares: o ONS do M7 segue o datalogger do M3
    dl[d + '|M7|' + s] = 600 + s; dl[d + '|M3|' + s] = 800 + s; poe(d, 'M7', s, 799 + s); poe(d, 'M1', s, 700);
  }
  for (const d of dias('2026-10', 1)) for (let s = 20; s < 30; s++) {   // 10 pares: pouco para conferir
    dl[d + '|M7|' + s] = 600 + s; dl[d + '|M3|' + s] = 800 + s; poe(d, 'M7', s, 799 + s);
  }
  return { ons, parque: (d, u, s) => (dl[d + '|' + u + '|' + s] == null ? null : dl[d + '|' + u + '|' + s]) };
}

function regra(L) {
  const F = forjado(), antes = Object.keys(F.ons).length, R = L.confereM7(F.ons, F.parque), M = Object.fromEntries(R.map((x) => [x.mes, x]));
  const m7 = (m) => Object.keys(F.ons).filter((k) => k.startsWith(m) && k.includes('|M7|')).length;
  const cO = L.chaveOns({ u: 'CEFMT7', ts: '2026-08-01 10:30:00', irr: 812.5, inv: '0' });
  const I = L.indiceDatalogger({ serie: [{ t: '2026-08-01T10:30:00-03:00', ms: Date.parse('2026-08-01T10:30:00-03:00'), e7: 810, e1: 5 }] });
  const So = { '2026-08-01|M7|21': 812.5, '2026-08-01|M1|21': 700 }, S = L.semReferencia(So);
  const nulo = (r) => L.chaveOns(Object.assign({ u: 'CEFMT7', ts: '2026-08-01 10:30:00', inv: '0' }, r)) === null;
  return {
    mapa: !!(L.ONS_TAG && L.ONS_TAG.CEFMT7 === 'M7' && Object.keys(L.ONS_TAG).length === 9),
    borda: !!(cO && cO[0] === '2026-08-01|M7|21' && cO[1] === 812.5 && I['2026-08-01|M7|21'] === 810 && I['2026-08-01|M1|21'] === 5),
    fora: nulo({ irr: null }) && nulo({ irr: '' }) && nulo({ irr: 800, inv: 'True' }) && nulo({ u: 'CEFMTX', irr: 800 }),
    ago: !!(M['2026-08'] && M['2026-08'].uso === 'confere' && M['2026-08'].pares === 36 && m7('2026-08') === 36 + 42),
    set: !!(M['2026-09'] && M['2026-09'].uso === 'retirado' && M['2026-09'].retiradas === 36 && m7('2026-09') === 0),
    out: !!(M['2026-10'] && M['2026-10'].uso === 'sem_conferencia' && m7('2026-10') === 10),
    outras: Object.keys(F.ons).filter((k) => k.includes('|M1|')).length === 72 && antes - Object.keys(F.ons).length === 36
      && !!M['2026-08'] && M['2026-08'].med_outras === 3,
    semref: S.length === 1 && S[0].uso === 'sem_referencia' && S[0].retiradas === 1 && !('2026-08-01|M7|21' in So) && ('2026-08-01|M1|21' in So),
  };
}

function lib() {
  console.log('· a regra em casos forjados');
  const r = regra(carrega());
  ok(r.mapa, 'o mapa tem as nove tags e o CEFMT7 e o M7');
  ok(r.borda, 'a borda das 10:30 BRT cai no slot 21 no ONS (ts sem offset) e no datalogger (epoch)');
  ok(r.fora, 'celula vazia (null e \'\'), medida invalida e tag fora do mapa ficam de fora');
  ok(r.ago, 'mes em que o ONS do M7 segue o datalogger do M7: fica, com 36 pares (42 madrugadas abaixo do limiar nao contam)');
  ok(r.set, 'mes em que o ONS do M7 segue o datalogger do M3: o M7 sai inteiro (36 chaves)');
  ok(r.out, 'mes com menos pares que o minimo: fica, marcado sem conferencia');
  ok(r.outras, 'as outras usinas ficam intactas e med_outras sai da concordancia delas (3 W/m2)');
  ok(r.semref, 'sem o datalogger: o M7 sai inteiro, as outras ficam, uso sem_referencia');
  console.log('· plantios (cada um TEM de reprovar, na flag que declara)');
  const P = [
    ['sem o CEFMT7 no mapa', ["CEFMT7: 'M7', ", ''], 'mapa'],
    ['comparacao invertida', ["m7 < m3 ? 'confere'", "m7 > m3 ? 'confere'"], 'ago'],
    ['N_MIN ignorado', ["n < N_MIN ? 'sem_conferencia'", "false ? 'sem_conferencia'"], 'out'],
    ['limiar ignorado no M7', ["if (v == null || !(v > LIMIAR_IRR)) continue;\n    const a = parque(d, 'M7'", "if (v == null) continue;\n    const a = parque(d, 'M7'"], 'ago'],
    ['slot do datalogger pelo fim da meia hora', ['new Date(r.ms - BRT)', 'new Date(r.ms - BRT + 1800e3)'], 'borda'],
    ['celula vazia vira zero', ["if (r.irr == null || r.irr === '') return null;", ''], 'fora'],
    ['sem_referencia deixa o M7', ['fora.forEach((k) => { delete ons[k]; });', ''], 'semref'],
  ];
  for (const [nome, troca, flag] of P) {
    let x;
    try { x = regra(carrega(troca)); }
    catch (e) {
      if (e.semAncora) ok(false, 'plantio "' + nome + '": a ancora nao casa na lib (o plantio nao existe mais)');
      else ok(false, 'plantio "' + nome + '": a lib mutada lancou excecao (' + e.message + '), nao reprovou pela regra');
      continue;
    }
    const caidas = Object.keys(x).filter((k) => !x[k]);
    ok(x[flag] === false, 'plantio "' + nome + '" reprova em ' + flag + (caidas.length ? ' (cairam: ' + caidas.join(', ') + ')' : ' (nada caiu)'));
  }
}

/* a fonte crua, pelas funcoes da lib: o ONS do mes (so o 404 e "mes sem arquivo") */
async function onsMes(L, m) {
  let o; try { o = await getJSON('ons_irradiancia_' + m.replace('-', '_') + '.json'); }
  catch (e) { if (/HTTP 404/.test(e.message)) return null; throw e; }
  const ons = {}; for (const r of o.consolidado || []) { const c = L.chaveOns(r); if (c) ons[c[0]] = c[1]; }
  return ons;
}
const mesBRT = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 7);

async function produto() {
  console.log('· o produto publicado');
  const L = carrega(), U = await getJSON('irr_ufv.json'), T = U.ons_tag_m7;
  ok(Array.isArray(T) && T.length > 0, 'irr_ufv.json tem ons_tag_m7 (' + (T ? T.length : 0) + ' meses)');
  if (!Array.isArray(T) || !T.length) return;
  let DL = null; try { DL = await getJSON('estacao_logger_30min.json'); } catch (e) { declara('datalogger ilegivel aqui (' + e.message + ')'); }
  if (T.some((x) => x.uso === 'sem_referencia')) { ok(!DL, 'sem_referencia publicado so quando o datalogger nao existe (aqui ' + (DL ? 'ele foi lido' : 'tambem nao') + ')'); return; }
  ok(T.some((x) => x.uso === 'confere'), 'ao menos um mes confere (' + T.filter((x) => x.uso === 'confere').length + ')');
  const hojeMes = mesBRT(Date.now());
  const ons = {}, lidos = [];
  for (const x of T) { const o = await onsMes(L, x.mes); if (o) { Object.assign(ons, o); lidos.push(x.mes); } }
  ok(lidos.length === T.length, 'todo mes da conferencia publicada tem o arquivo do ONS (' + lidos.length + ' de ' + T.length + ')');
  const brutos = {}; Object.keys(ons).forEach((k) => { if (k.includes('|M7|')) { const m = k.slice(0, 7); brutos[m] = (brutos[m] || 0) + 1; } });
  // a conferencia refeita da fonte crua, pelas mesmas funcoes da lib, so com o MESMO datalogger que o gerador usou
  if (DL && DL.gerado_em === U.ons_tag_m7_ref) {
    const I = L.indiceDatalogger(DL), R = L.confereM7(ons, (d, u, s) => (I[d + '|' + u + '|' + s] == null ? null : I[d + '|' + u + '|' + s]));
    const RM = Object.fromEntries(R.map((x) => [x.mes, x]));
    const fechados = T.filter((x) => x.mes < hojeMes);   // o mes corrente cresce entre a leitura do gerador e a daqui
    const dif = fechados.filter((x) => { const y = RM[x.mes]; return !y || y.uso !== x.uso || y.pares !== x.pares || y.med_m7 !== x.med_m7 || y.med_m3 !== x.med_m3; });
    ok(fechados.length > 0 && !dif.length, 'a conferencia refeita da fonte crua bate com a publicada nos ' + fechados.length + ' meses fechados'
      + (dif.length ? ' — difere: ' + dif.slice(0, 4).map((x) => x.mes + ' publicado ' + x.uso + '/' + x.pares + '/' + x.med_m7 + ' refeito '
        + (RM[x.mes] ? RM[x.mes].uso + '/' + RM[x.mes].pares + '/' + RM[x.mes].med_m7 : '∅')).join('; ') : ''));
  } else declara('o datalogger mudou depois do gerador (' + (DL && DL.gerado_em) + ' x ' + U.ons_tag_m7_ref + '): a conferencia nao e refeita nesta rodada');
  // o plano de 30 min: mes conferido INTEIRO na janela tem ons_w_M7 em toda leitura do M7 no ONS; mes retirado, nenhuma
  const P30 = await getJSON('irr_plano_30min.json'); let P60 = null;
  try { P60 = await getJSON('irr_plano_60min.json'); } catch (e) { if (!/HTTP 404/.test(e.message)) throw e; }
  const conta = (J) => { const c = {}; ((J && J.serie) || []).forEach((l) => { if (l.ons_w_M7 != null) { const m = mesBRT(l.ms); c[m] = (c[m] || 0) + 1; } }); return c; };
  const ini30 = P30.serie && P30.serie.length ? new Date(P30.serie[0].ms - 3 * 3600e3).toISOString().slice(0, 10) : '9999';
  const c30 = conta(P30), c60 = conta(P60);
  const inteiros = T.filter((x) => x.uso === 'confere' && x.mes < hojeMes && x.mes + '-01' >= ini30 && lidos.includes(x.mes));
  ok(inteiros.length > 0, 'ha mes conferido inteiro na janela do irr_plano_30min (' + inteiros.map((x) => x.mes).join(', ') + ')');
  const errados = inteiros.filter((x) => c30[x.mes] !== brutos[x.mes]);
  ok(inteiros.length > 0 && !errados.length, 'em cada um, as meias horas com ons_w_M7 publicadas = as leituras do M7 no ONS'
    + (errados.length ? ' — difere: ' + errados.map((x) => x.mes + ' ' + (c30[x.mes] || 0) + ' x ' + brutos[x.mes]).join(', ') : ''));
  const ret = T.filter((x) => x.uso === 'retirado');
  ok(ret.every((x) => !c30[x.mes] && !c60[x.mes]), 'mes retirado sem ons_w_M7 no plano de 30 e de 60 min' + (ret.length ? ' (' + ret.map((x) => x.mes).join(', ') + ')' : ' (nenhum retirado)'));
  T.filter((x) => x.med_outras != null && x.med_m7 != null && x.med_m7 > x.med_outras)
    .forEach((x) => declara(x.mes + ': o M7 concorda pior que as outras usinas (' + x.med_m7 + ' x ' + x.med_outras + ' W/m2)'));
}

async function real() {
  console.log('· diagnostico: a regra sobre o dado publicado (so declara)');
  const L = carrega(), DL = await getJSON('estacao_logger_30min.json'), I = L.indiceDatalogger(DL);
  const meses = [...new Set(Object.keys(I).map((k) => k.slice(0, 7)))].sort(), ons = {};
  for (const m of meses) { const o = await onsMes(L, m); if (o) Object.assign(ons, o); }
  L.confereM7(ons, (d, u, s) => (I[d + '|' + u + '|' + s] == null ? null : I[d + '|' + u + '|' + s]))
    .forEach((x) => console.log('    ' + x.mes + ' · ' + x.uso + ' · ' + x.pares + ' pares · M7 ' + x.med_m7 + ' x M3 ' + x.med_m3 + ' · outras ' + x.med_outras + ' W/m2'));
}

(async () => {
  const a = process.argv.slice(2);
  try {
    if (!a.length || a.includes('--lib')) lib();
    if (a.includes('--produto')) await produto();
    if (a.includes('--real')) await real();
  } catch (e) { falhas++; console.log('  ✗ ' + (e && e.stack || e)); }
  console.log(falhas ? 'REPROVADO (' + falhas + ')' : 'APROVADO');
  process.exit(falhas ? 1 : 0);
})();
