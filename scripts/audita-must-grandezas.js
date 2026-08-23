/*
 * audita-must-grandezas.js — QUAL canal e geracao e qual e consumo?
 *
 * SOMENTE LEITURA. Nao grava blob, nao toca em producao.
 *
 * ══ POR QUE ISTO EXISTE ══════════════════════════════════════════════════════════════════════
 *
 * Os medidores do MUST expoem tres grandezas de demanda ativa: `Demat`, `DematDel` e `DematRec`.
 * O dashboard HTML as chama de "demanda canal Del" e "demanda canal Rec" — ou seja, ele TAMBEM
 * nao afirma a semantica, so nomeia o canal.
 *
 * 🔴 E a convencao de metrologia nao decide sozinha: "Delivered" tanto pode ser energia entregue
 * A CARGA (consumo) quanto entregue A REDE (geracao), conforme o referencial adotado no medidor.
 * Chutar aqui produziria um painel que troca geracao por consumo com o rotulo certo — o modo de
 * falhar mais caro que existe, porque parece certo.
 *
 * ══ COMO O DADO DECIDE ═══════════════════════════════════════════════════════════════════════
 *
 * Uma usina fotovoltaica tem uma assinatura que nao deixa duvida:
 *
 *   GERACAO   grande de dia (centenas de MW no conjunto), ZERO de madrugada
 *   CONSUMO   pequeno (unidades de MW), presente de madrugada, tipicamente ZERO enquanto gera
 *
 * O script mede as duas janelas por canal e imprime a razao dia/noite. O canal cuja media diurna
 * e ordens de grandeza maior e a geracao; o outro e o consumo. Nao ha empate possivel.
 *
 * Confere ainda a identidade `Demat ~= Rec - Del` (ou `Del - Rec`), que e a prova cruzada: se ela
 * fecha, os tres numeros descrevem o mesmo ponto de medicao e a leitura esta consistente.
 *
 * Env: WAY2_TOKEN (obrigatorio), DIA_ALVO (AAAA-MM-DD; default = ontem).
 */
const https = require('https');

const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const PONTOS = { 6380: 'M1', 6381: 'M2', 6382: 'M3', 6383: 'M4', 6384: 'M5',
                 6385: 'M6', 6386: 'M7', 6387: 'M8', 6388: 'M9' };
const IDS = Object.keys(PONTOS);
const GRANDEZAS = ['Demat', 'DematDel', 'DematRec'];

const ontem = () => new Date(Date.now() - 3 * 3600 * 1000 - 86400000).toISOString().slice(0, 10);

function apiGet(query, token, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': token }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('fonte HTTP ' + res.statusCode)); }
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b.replace(/^﻿/, ''))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}

const media = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const fmt = (v, c = 3) => v == null ? '—' : v.toFixed(c);

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) { console.error('ERRO: WAY2_TOKEN ausente.'); process.exit(1); }
  const dia = (process.env.DIA_ALVO || '').trim() || ontem();

  const q = 'ids=' + IDS.join(',') + '&grandezas=' + GRANDEZAS.join(',')
    + '&contextodasdatas=ConsiderarDiaCheio&intervalo=QuinzeMinutos'
    + '&medicao-datainicio=' + dia + 'T00:00:00&medicao-datafim=' + dia + 'T23:59:59'
    + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
  console.log('dia auditado: ' + dia + '   ·   grandezas: ' + GRANDEZAS.join(', ') + '\n');
  const j = await apiGet(q, token);

  const presentes = [...new Set((j.dados || []).map(x => x.nomeGrandeza))].sort();
  console.log('grandezas que a fonte devolveu: ' + (presentes.join(', ') || 'NENHUMA'));
  for (const g of GRANDEZAS) if (!presentes.includes(g))
    console.log('  ⚠️ ' + g + ' NAO veio — o painel nao pode oferecer este canal');
  console.log('');

  // ---- assinatura dia/noite por canal, no CONJUNTO ---------------------------------------------
  const serie = {};   // grandeza -> parque -> [{h, v}]
  for (const s of (j.dados || [])) {
    const p = PONTOS[String(s.pontoId)];
    if (!p) continue;
    (serie[s.nomeGrandeza] = serie[s.nomeGrandeza] || {})[p] =
      (s.valores || []).filter(v => v.valor != null).map(v => ({ h: +String(v.data).slice(11, 13), v: v.valor / 1000 }));
  }

  console.log('ASSINATURA DIA/NOITE — soma dos nove parques, em MW');
  console.log('  canal        media 10h-15h   media 01h-04h   maximo      razao dia/noite');
  const perfil = {};
  for (const g of GRANDEZAS) {
    const porP = serie[g] || {};
    const todas = Object.values(porP).flat();
    if (!todas.length) { console.log('  ' + g.padEnd(12) + ' sem dado'); continue; }
    const nP = Object.keys(porP).length || 1;
    const dDia = media(todas.filter(x => x.h >= 10 && x.h < 15).map(x => x.v));
    const dNoite = media(todas.filter(x => x.h >= 1 && x.h < 4).map(x => x.v));
    const mx = Math.max.apply(null, todas.map(x => x.v));
    const somaDia = dDia == null ? null : dDia * nP, somaNoite = dNoite == null ? null : dNoite * nP;
    perfil[g] = { dia: somaDia, noite: somaNoite, max: mx * nP };
    const razao = (somaDia != null && somaNoite) ? Math.abs(somaDia / somaNoite) : null;
    console.log('  ' + g.padEnd(12) + fmt(somaDia, 2).padStart(12) + fmt(somaNoite, 3).padStart(16)
      + fmt(mx * nP, 1).padStart(11) + '    ' + (razao == null ? '—' : razao.toFixed(1) + 'x'));
  }

  // ---- o VEREDITO sai da razao, nao do nome do canal --------------------------------------------
  console.log('');
  const cand = ['DematDel', 'DematRec'].filter(g => perfil[g]);
  if (cand.length === 2) {
    const [a, b] = cand;
    const ger = Math.abs(perfil[a].dia || 0) > Math.abs(perfil[b].dia || 0) ? a : b;
    const con = ger === a ? b : a;
    console.log('VEREDITO PELO DADO');
    console.log('  GERACAO  = ' + ger + '   (media diurna ' + fmt(perfil[ger].dia, 2) + ' MW)');
    console.log('  CONSUMO  = ' + con + '   (media diurna ' + fmt(perfil[con].dia, 2)
      + ' MW · noturna ' + fmt(perfil[con].noite, 3) + ' MW)');
    const fator = Math.abs((perfil[ger].dia || 0) / (perfil[con].dia || 1e-9));
    console.log('  separacao entre os dois de dia: ' + fator.toFixed(0) + 'x');
    if (fator < 5) console.log('  🔴 SEPARACAO FRACA — nao concluir; o dado nao decide sozinho aqui.');
  } else console.log('VEREDITO IMPOSSIVEL: a fonte nao devolveu os dois canais.');

  // ---- prova cruzada: a identidade fecha? -------------------------------------------------------
  console.log('\nPROVA CRUZADA — Demat contra a diferenca dos canais (por parque, MW)');
  console.log('  parque   Demat med.   Rec-Del    Del-Rec    qual fecha');
  for (const p of Object.values(PONTOS)) {
    const g = (n) => ((serie[n] || {})[p] || []);
    const mD = media(g('Demat').map(x => x.v));
    const mDel = media(g('DematDel').map(x => x.v));
    const mRec = media(g('DematRec').map(x => x.v));
    if (mD == null || mDel == null || mRec == null) { console.log('  ' + p.padEnd(9) + ' incompleto'); continue; }
    const rd = mRec - mDel, dr = mDel - mRec;
    const qual = Math.abs(mD - rd) < Math.abs(mD - dr) ? 'Rec-Del' : 'Del-Rec';
    const err = Math.min(Math.abs(mD - rd), Math.abs(mD - dr));
    console.log('  ' + p.padEnd(9) + fmt(mD, 3).padStart(10) + fmt(rd, 3).padStart(11)
      + fmt(dr, 3).padStart(11) + '    ' + qual + '  (erro ' + fmt(err, 4) + ' MW)');
  }

  // ---- ordem de grandeza do consumo, que decide se ele cabe no mesmo eixo -----------------------
  console.log('\nESCALA — o consumo cabe no eixo da geracao?');
  if (perfil.DematDel && perfil.DematRec) {
    const ger = Math.abs(perfil.DematRec.max) > Math.abs(perfil.DematDel.max) ? 'DematRec' : 'DematDel';
    const con = ger === 'DematRec' ? 'DematDel' : 'DematRec';
    console.log('  maximo geracao ' + fmt(perfil[ger].max, 1) + ' MW   ·   maximo consumo '
      + fmt(perfil[con].max, 2) + ' MW');
    console.log('  o consumo ocupa ' + (perfil[con].max / perfil[ger].max * 100).toFixed(2)
      + '% do eixo da geracao — e ' + (perfil[con].max / 343.76 * 100).toFixed(2) + '% do MUST contratado');
    console.log('  ➡ eixo compartilhado com a linha do contratado deixaria o consumo INVISIVEL.');
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
