/*
 * ensaio-irr-rotulo.js — o nome da grandeza da solarimetria nas três línguas (PROMOVER irr-rotulo).
 *
 *   --lib     · a REGRA em casos forjados: as 22 grandezas da lib ganham `grandeza_pt` (= `grandeza`), `_en` e `_zh`; uma
 *               grandeza NOVA aborta sem rotular linha nenhuma (falha fechada, nada gravado pela metade); o rótulo inglês
 *               com acento do português, o vazio e o chinês sem ideograma são recusados. Plantio: a rotulagem que copia o
 *               PT para as outras línguas e não aborta reprova.
 *   --produto · no `irr_ufv.json` publicado, TODA linha de `qualidade` tem `grandeza_pt` igual a `grandeza` e os rótulos
 *               EN/中文 da lib (a regra importada de quem sobe, nunca uma cópia); a tradução dos painéis troca o `_pt` pela
 *               irmã só com essa paridade. Plantio: uma linha com o inglês copiado do PT e outra sem o chinês reprovam.
 *   sem argumento, as duas.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const { ROTULO, rotuloBom, rotulaQualidade } = require('./lib-irr-rotulo.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`; timeout de 120 s na lib) */
  return LD.pede(BASE + nome, { 'accept-encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + nome);
    return deJson(x.buf);
  });
}

// ---- LIB -------------------------------------------------------------------------------------------------
function casoLib(rotula) {
  const f = [];
  const G = Object.keys(ROTULO);
  if (G.length !== 22) f.push('lib: ' + G.length + ' grandezas na lib, esperadas as 22 da FAIXA do gerador');
  // 1. as 22 rotuladas, ao lado do campo antigo
  const L = G.map((g, i) => ({ ufv: 'M' + (1 + i % 9), grandeza: g, veredito: 'ok' }));
  let n = 0;
  try { n = rotula(L); } catch (e) { f.push('lib: rotular as 22 abortou: ' + e.message); }
  if (n !== G.length) f.push('lib: ' + n + ' linhas rotuladas de ' + G.length);
  L.forEach((q) => {
    if (q.grandeza_pt !== q.grandeza) f.push('lib: ' + q.grandeza + ' com grandeza_pt = ' + q.grandeza_pt);
    if (!rotuloBom({ en: q.grandeza_en, zh: q.grandeza_zh })) f.push('lib: ' + q.grandeza + ' com rótulo ruim: ' + q.grandeza_en + ' / ' + q.grandeza_zh);
    if (q.grandeza_en !== (ROTULO[q.grandeza] || {}).en) f.push('lib: ' + q.grandeza + ' com inglês fora da tabela');
  });
  // 2. grandeza NOVA: aborta e não rotula linha nenhuma
  const M = [{ ufv: 'M1', grandeza: 'TENSÃO DA BATERIA' }, { ufv: 'M2', grandeza: 'GRANDEZA NOVA DO EXPORT' }];
  let abortou = false;
  try { rotula(M); } catch (e) { abortou = true; }
  if (!abortou) f.push('lib: grandeza sem rótulo NÃO abortou — sairia em português na página em inglês');
  if (M.some((q) => 'grandeza_en' in q)) f.push('lib: a grandeza nova abortou DEPOIS de rotular parte das linhas');
  // 3. o que conta como rótulo bom
  [[{ en: 'TENSÃO DA BATERIA', zh: '电池电压' }, 'inglês copiado do PT'], [{ en: '', zh: '电池电压' }, 'inglês vazio'],
    [{ en: 'BATTERY VOLTAGE', zh: 'BATTERY VOLTAGE' }, 'chinês sem ideograma'], [undefined, 'sem entrada']]
    .forEach(([r, nome]) => { if (rotuloBom(r)) f.push('lib: rótulo aceito com ' + nome); });
  if (!rotuloBom({ en: 'BATTERY VOLTAGE', zh: '电池电压' })) f.push('lib: o rótulo certo foi recusado (guarda severa demais)');
  return f;
}
// a rotulagem que nunca aborta e copia o PT: é o defeito que a regra existe para impedir
const rotulaPlantada = (L) => { (L || []).forEach((q) => { q.grandeza_pt = q.grandeza; q.grandeza_en = q.grandeza; q.grandeza_zh = q.grandeza; }); return (L || []).length; };

// ---- PRODUTO ---------------------------------------------------------------------------------------------
function julgaProduto(Q) {
  const f = [];
  if (!Array.isArray(Q) || !Q.length) return ['produto: irr_ufv.json sem `qualidade` — nada a julgar'];
  Q.forEach((q) => {
    const id = q.ufv + ' · ' + q.grandeza;
    if (q.grandeza_pt !== q.grandeza) f.push('produto: ' + id + ' com grandeza_pt = ' + JSON.stringify(q.grandeza_pt));
    const r = ROTULO[q.grandeza];
    if (!r) { f.push('produto: ' + id + ' sem entrada na lib (o gerador deveria ter abortado)'); return; }
    if (q.grandeza_en !== r.en) f.push('produto: ' + id + ' grandeza_en = ' + JSON.stringify(q.grandeza_en) + ' (lib: ' + r.en + ')');
    if (q.grandeza_zh !== r.zh) f.push('produto: ' + id + ' grandeza_zh = ' + JSON.stringify(q.grandeza_zh) + ' (lib: ' + r.zh + ')');
  });
  return f;
}
async function produto() {
  const iu = await getJSON('irr_ufv.json');
  const Q = iu.qualidade;
  const f = julgaProduto(Q);
  const gs = new Set((Q || []).map((q) => q.grandeza));
  console.log('   produto: ' + (Q || []).length + ' linhas de qualidade · ' + gs.size + ' grandezas · gerado_em ' + iu.gerado_em
    + ' · ' + (f.length ? f.length + ' achado(s)' : 'todas com as três línguas'));
  // PLANTIO sobre o dado real: o inglês copiado do PT numa linha, o chinês apagado noutra
  if (Array.isArray(Q) && Q.length >= 2) {
    const P1 = JSON.parse(JSON.stringify(Q)); P1[0].grandeza_en = P1[0].grandeza;
    const P2 = JSON.parse(JSON.stringify(Q)); delete P2[P2.length - 1].grandeza_zh;
    const a1 = julgaProduto(P1).length - f.length, a2 = julgaProduto(P2).length - f.length;
    console.log('   plantio: inglês copiado do PT → ' + a1 + ' achado(s) novo(s) · chinês ausente → ' + a2);
    if (a1 < 1) f.push('produto: o plantio do inglês copiado do PT NÃO reprova');
    if (a2 < 1) f.push('produto: o plantio do chinês ausente NÃO reprova');
  }
  return f;
}

(async () => {
  const so = process.argv.includes('--lib') ? 'lib' : process.argv.includes('--produto') ? 'produto' : 'ambos';
  const f = [];
  if (so !== 'produto') {
    const L = casoLib(rotulaQualidade);
    console.log('   lib: ' + (L.length ? L.length + ' achado(s)' : 'as 22 grandezas, a grandeza nova que aborta e os rótulos recusados'));
    f.push(...L);
    const P = casoLib(rotulaPlantada);
    console.log('   plantio (rotulagem que copia o PT e não aborta): ' + P.length + ' achado(s)');
    if (!P.length) f.push('lib: a rotulagem plantada PASSA — o ensaio não mede nada');
  }
  if (so !== 'lib') f.push(...await produto());
  if (f.length) { console.log('REPROVADO · ' + f.length); f.slice(0, 30).forEach((x) => console.log('  ✗ ' + x)); process.exit(1); }
  console.log('OK · o nome da grandeza nas três línguas (' + so + ')');
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
