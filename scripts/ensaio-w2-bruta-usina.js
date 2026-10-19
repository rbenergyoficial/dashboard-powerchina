/*
 * ensaio-w2-bruta-usina.js — a bruta de 34,5 kV por usina no diário Way2 (PROMOVER w2-bruta-usina, 16/10/2026).
 *
 * POR QUE EXISTE. O diário passou a publicar `ufv_ger_mwh`: em cada registro de 5 min, a soma dos circuitos da usina, só a parte
 * positiva, integrada no dia. É o ponto de 34,5 kV da cascata de perdas por usina na página Confiabilidade e perdas. Circuito na
 * usina errada, ou consumo noturno somado como geração negativa, não quebra tela: muda a perda de uma usina para outra.
 *
 * O QUE PROVA:
 *   --lib      sobre um dia SINTÉTICO (rollupDia do arquivador), com cada circuito num valor só dele, registros noturnos negativos,
 *              um registro em que uma usina gera e outra consome e um circuito sem leitura num registro:
 *              · cada usina igual à conta refeita aqui (código próprio, sobre o mesmo sintético), ao arredondamento;
 *              · a soma das nove >= a bruta do conjunto, e maior exatamente pela parte negativa do registro misto;
 *              · plantios no julgamento (cada um TEM de reprovar): M7 e M9 trocados, o negativo somado, o campo ausente;
 *   --produto  no blob publicado:
 *              · todo dia desde DESDE (o começo do logger do fabricante, a outra ponta da cascata) tem o campo, nas nove usinas,
 *                número >= 0;
 *              · a soma das nove >= a bruta do conjunto nos dias com a medição de TODAS as usinas completa (ufv_slots = slots). Com
 *                circuito sem leitura a Way2 às vezes mantém o 6233 (revisor, 6 de 200 dias, todos à noite) e a premissa não vale;
 *              · O MAPA CIRCUITO -> USINA contra uma fonte de fora do medidor: a mediana, por usina, da bruta de 34,5 kV sobre a saída
 *                CA do logger do fabricante (dias com o parque inteiro no logger e a medição da usina completa) fica em 0,95 a 1,05.
 *                Medido em 200 dias (30/03 a 15/10/2026): mediana 0,981 (M8) a 0,999 (M1), dia a dia 0,951 a 1,044. Um circuito na
 *                usina errada desloca a razão de 1/3 ou mais (a usina de 3 circuitos ganha ou perde um; M7 e M9 têm 44 e 33
 *                inversores). Não pega: duas usinas de mesmo tamanho trocadas inteiras (M1 e M3, por exemplo);
 *              · SEGUNDA ROTA: o snapshot de 5 min do dia mais recente recontado aqui: as nove brutas iguais ao publicado, e o 6233
 *                igual à soma dos 22 nos registros em que os 22 têm leitura;
 *              · plantios contra o dia real, nas usinas que o próprio dia permite (a de maior bruta zerada; a maior e a menor
 *                trocadas); dia com as nove iguais declara o plantio não aplicável.
 * Folgas (contas): a bruta publicada é arredondada a 3 casas: |erro| <= 0,5e-3 MWh por valor. Soma das nove contra o conjunto:
 *   TOL_SOMA = (9 + 1) x 0,5e-3. Publicado contra recontado (mesma soma, os dois arredondados): TOL_RECONTA = 1e-3 + 1e-9.
 *   6233 contra a soma dos 22: erro de ponto flutuante, 1e-9 x max(1, |soma|) kW.
 * Sem segredo: lê só blob público (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const { rollupDia } = require('./gen-way2-hist.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const DESDE = '2026-04-03';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  // Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); como antes, o 404 tambem estoura, e o erro da lib propaga
  return LD.pede(BASE + nome, { 'accept-encoding': 'gzip' }).then((r) => {
    if (r.status !== 200) throw new Error('HTTP ' + r.status + ' em ' + nome);
    return deJson(r.buf);
  });
}
const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
const U9 = Object.keys(CIRC), TODOS = [].concat(...Object.values(CIRC));
const r3 = (x) => Math.round(x * 1000) / 1000;
const TOL_SOMA = (9 + 1) * 0.5e-3, TOL_RECONTA = 1e-3 + 1e-9, MAPA_MIN = 0.95, MAPA_MAX = 1.05, MAPA_DIAS = 30;

// a conta refeita por código próprio, sobre o snapshot cru: por registro, a usina é a soma dos seus circuitos; só a parte positiva
function reconta(j) {
  const m = {};
  for (const s of j.dados || []) if (s.nomeGrandeza === 'Demat') { const o = {}; for (const v of s.valores || []) if (v.valor != null) o[v.data] = v.valor; m[s.pontoId] = o; }
  const ts = new Set(); for (const p of TODOS.concat([6196, 6197])) for (const t in (m[p] || {})) ts.add(t);
  const o = {}; let fora6233 = 0, n22 = 0, nFuro = 0;
  for (const u of U9) o[u] = 0;
  for (const t of ts) {
    let s22 = 0;
    for (const u of U9) { let b = 0; for (const p of CIRC[u]) b += ((m[p] || {})[t] || 0); s22 += b; if (b > 0) o[u] += b * 5 / 60 / 1000; }
    const g = (m[6233] || {})[t]; if (g == null) continue;
    if (TODOS.every((p) => m[p] && m[p][t] != null)) { n22++; if (Math.abs(g - s22) > 1e-9 * Math.max(1, Math.abs(s22))) fora6233++; } else nFuro++;
  }
  for (const u of U9) o[u] = r3(o[u]);
  return { o, fora6233, n22, nFuro, lidos: TODOS.reduce((a, p) => a + Object.keys(m[p] || {}).length, 0) };
}

function julga(x) {
  const f = [], G = x.ufv_ger_mwh;
  if (!G) return [x.dia + ': sem ufv_ger_mwh'];
  for (const u of U9) if (typeof G[u] !== 'number' || !(G[u] >= 0)) f.push(x.dia + ' ' + u + ': bruta ' + G[u]);
  const s = U9.reduce((a, u) => a + (G[u] || 0), 0);
  const todas = x.ufv_slots && U9.every((u) => x.ufv_slots[u] === x.slots);   /* com furo de circuito a premissa nao vale (cabecalho) */
  if (todas && x.ene_ger_mwh != null && s < x.ene_ger_mwh - TOL_SOMA) f.push(x.dia + ': soma das nove ' + r3(s) + ' abaixo da bruta do conjunto ' + x.ene_ger_mwh);
  return f;
}

// ---------------------------------------------------------------- --lib
function lib() {
  const f = [];
  const grade = []; for (let i = 0; i < 288; i++) grade.push('2026-01-01T' + String(Math.floor(i / 12)).padStart(2, '0') + ':' + String(5 * (i % 12)).padStart(2, '0') + ':00');
  /* cada circuito num valor so dele (kW): de dia 1000 + 37*indice; de noite (antes das 06:00 e depois das 18:00) -(5 + indice);
     no registro 72 (06:00) o M9 gera e o M1 consome; no registro 100 o 6216 (M8) nao tem leitura; no registro 10 (noite) um circuito
     do M1 gera 50 e outro consome 40: a usina conta +10 (o positivo e da USINA, nao do circuito: por circuito contaria 50) */
  const val = (p, i) => { const k = TODOS.indexOf(p); if (i === 72) return p === 6219 ? 500 : CIRC.M1.includes(p) ? -40 : 0; if (i === 100 && p === 6216) return null;
    if (i === 10 && p === 6198) return 50; if (i === 10 && p === 6199) return -40; if (i === 10 && p === 6200) return 0;
    return i < 72 || i >= 216 ? -(5 + k) : 1000 + 37 * k; };
  const dados = [];
  for (const p of TODOS) dados.push({ pontoId: p, nomeGrandeza: 'Demat', valores: grade.map((t, i) => ({ data: t, valor: val(p, i) })) });
  for (const p of [6196, 6197]) dados.push({ pontoId: p, nomeGrandeza: 'Demat', valores: grade.map((t) => ({ data: t, valor: 100 })) });
  dados.push({ pontoId: 6233, nomeGrandeza: 'Demat', valores: grade.map((t, i) => ({ data: t, valor: TODOS.reduce((a, p) => a + (val(p, i) || 0), 0) })) });
  const j = { dados }, x = rollupDia(j, '2026-01-01');
  if (!x.ufv_ger_mwh) return ['sintetico: rollupDia nao publica ufv_ger_mwh'];
  const esp = {}; for (const u of U9) { let a = 0; for (let i = 0; i < 288; i++) { const b = CIRC[u].reduce((s, p) => s + (val(p, i) || 0), 0); if (b > 0) a += b * 5 / 60 / 1000; } esp[u] = r3(a); }
  const G = x.ufv_ger_mwh || {};
  for (const u of U9) if (G[u] !== esp[u]) f.push('sintetico ' + u + ': ' + G[u] + ' (esperava ' + esp[u] + ')');
  const rc = reconta(j).o; for (const u of U9) if (rc[u] !== esp[u]) f.push('segunda rota no sintetico ' + u + ': ' + rc[u] + ' contra ' + esp[u]);
  /* o registro misto, contado a mao: no registro 10 o M1 entra com +10 kW (e nao 50) */
  let m1sem10 = 0; for (let i = 0; i < 288; i++) { if (i === 10) continue; const b = CIRC.M1.reduce((s2, p) => s2 + (val(p, i) || 0), 0); if (b > 0) m1sem10 += b * 5 / 60 / 1000; }
  if (G.M1 !== r3(m1sem10 + 10 * 5 / 60 / 1000)) f.push('registro misto do M1: ' + G.M1 + ' (esperava ' + r3(m1sem10 + 10 * 5 / 60 / 1000) + ', +10 kW no registro 10)');
  /* a soma das nove passa a do conjunto exatamente pela parte negativa dos registros mistos, refeita da definicao */
  let extra = 0; for (let i = 0; i < 288; i++) { let pos = 0, tot = 0; for (const u of U9) { const b = CIRC[u].reduce((s2, p) => s2 + (val(p, i) || 0), 0); tot += b; if (b > 0) pos += b; } extra += (pos - Math.max(0, tot)) * 5 / 60 / 1000; }
  const s = U9.reduce((a, u) => a + G[u], 0);
  if (Math.abs(s - x.ene_ger_mwh - extra) > TOL_SOMA) f.push('soma das nove ' + r3(s) + ' contra conjunto ' + x.ene_ger_mwh + ' + registro misto ' + r3(extra));
  f.push(...julga(x));
  const planta = (nome, fn) => { const P = JSON.parse(JSON.stringify(x)); fn(P); const nv = julga(P).concat(U9.filter((u) => P.ufv_ger_mwh && P.ufv_ger_mwh[u] !== esp[u]).map((u) => u + ' difere'));
    console.log('   plantio (' + nome + '): ' + (nv.length ? 'reprova' : 'NAO reprova')); if (!nv.length) f.push('plantio "' + nome + '" nao reprova'); };
  planta('M7 e M9 trocados', (P) => { const a = P.ufv_ger_mwh.M7; P.ufv_ger_mwh.M7 = P.ufv_ger_mwh.M9; P.ufv_ger_mwh.M9 = a; });
  planta('negativo somado', (P) => { let a = 0; for (let i = 0; i < 288; i++) a += CIRC.M3.reduce((s2, p) => s2 + (val(p, i) || 0), 0) * 5 / 60 / 1000; P.ufv_ger_mwh.M3 = r3(a); });
  planta('campo ausente', (P) => { delete P.ufv_ger_mwh; });
  console.log('   sintetico: ' + JSON.stringify(G) + ' · conjunto ' + x.ene_ger_mwh);
  return f;
}

// ---------------------------------------------------------------- --produto
async function produto() {
  const f = [];
  const D = (await getJSON('way2_daily.json')).dias || [];
  const alvo = D.filter((x) => x.dia >= DESDE);
  if (!alvo.length) return ['diario sem dia desde ' + DESDE];
  const sem = alvo.filter((x) => !x.ufv_ger_mwh);
  if (sem.length) f.push(sem.length + ' de ' + alvo.length + ' dias desde ' + DESDE + ' sem ufv_ger_mwh (' + sem.slice(0, 3).map((x) => x.dia).join(', ') + '…): recalculo do historico truncado ou nao rodado');
  for (const x of D.filter((y) => y.ufv_ger_mwh)) f.push(...julga(x));
  const ult = D[D.length - 1];
  const { o: rc, fora6233, n22, nFuro, lidos } = reconta(await getJSON('hist/way2_' + ult.dia + '.json'));
  if (!lidos) f.push(ult.dia + ': snapshot sem leitura nos circuitos — a recontagem nao julgou nada');
  if (!n22) f.push(ult.dia + ': nenhum registro com os 22 circuitos e o 6233 — a comparacao do 6233 nao julgou nada');
  if (fora6233) f.push(ult.dia + ': 6233 diferente da soma dos 22 em ' + fora6233 + ' de ' + n22 + ' registros com os 22 lidos');
  if (ult.ufv_ger_mwh) for (const u of U9) if (Math.abs(rc[u] - ult.ufv_ger_mwh[u]) > TOL_RECONTA) f.push(ult.dia + ' ' + u + ': publicado ' + ult.ufv_ger_mwh[u] + ', recontado ' + rc[u]);
  const com = D.filter((x) => x.ufv_ger_mwh);
  const semTodas = com.filter((x) => !(x.ufv_slots && U9.every((u) => x.ufv_slots[u] === x.slots))).length;
  console.log('   ' + com.length + ' de ' + D.length + ' dias com a bruta por usina (desde ' + (com[0] && com[0].dia) + ') · soma >= conjunto julgada em ' + (com.length - semTodas) + ' (os ' + semTodas + ' com furo de circuito ficam declarados)');
  console.log('   ' + ult.dia + ': publicado ' + JSON.stringify(ult.ufv_ger_mwh) + ' · recontado ' + JSON.stringify(rc) + ' · 6233 = soma dos 22 em ' + (n22 - fora6233) + ' de ' + n22 + ' registros (' + nFuro + ' com circuito sem leitura, nao julgados)');
  // o mapa circuito -> usina contra a saida CA do logger do fabricante
  const SG = (await getJSON('sg_saude.json')).usina_dia || [], PL = ((await getJSON('inversores.json')).escopo || {}).inversores_por_parque || {};
  const W = {}; com.forEach((x) => { W[x.dia] = x; });
  for (const u of U9) {
    const r = SG.filter((y) => y.ufv === u && W[y.d] && PL[u] && y.n_cc === PL[u] && y.eca > 0 && W[y.d].ufv_completo && W[y.d].ufv_completo[u]).map((y) => W[y.d].ufv_ger_mwh[u] / y.eca).sort((a, b) => a - b);
    if (r.length < MAPA_DIAS) { f.push(u + ': so ' + r.length + ' dias com o logger e o medidor completos para julgar o mapa (minimo ' + MAPA_DIAS + ')'); continue; }
    const md = r[Math.floor((r.length - 1) / 2)];
    if (!(md >= MAPA_MIN && md <= MAPA_MAX)) f.push(u + ': bruta de 34,5 kV / saida CA do logger, mediana ' + md.toFixed(4) + ' em ' + r.length + ' dias, fora de ' + MAPA_MIN + ' a ' + MAPA_MAX + ': circuito na usina errada?');
    console.log('   mapa ' + u + ': mediana bruta/CA ' + md.toFixed(4) + ' em ' + r.length + ' dias');
  }
  if (ult.ufv_ger_mwh) {   // plantios contra o dia real, nas usinas que o proprio dia permite
    const G = ult.ufv_ger_mwh, ord = U9.slice().sort((a, b) => G[b] - G[a]), hi = ord[0], lo = ord[ord.length - 1];
    if (G[hi] - G[lo] <= TOL_RECONTA) console.log('   plantios contra o dia real: NAO APLICAVEIS (as nove com a mesma bruta, ' + G[hi] + ' MWh)');
    else {
      const P = JSON.parse(JSON.stringify(ult)); P.ufv_ger_mwh[hi] = G[lo]; P.ufv_ger_mwh[lo] = G[hi];
      const ok1 = U9.some((u) => Math.abs(rc[u] - P.ufv_ger_mwh[u]) > TOL_RECONTA);
      const Q = JSON.parse(JSON.stringify(ult)); Q.ufv_ger_mwh[hi] = 0; Q.ufv_slots = Object.assign({}, Q.ufv_slots); U9.forEach((u) => { Q.ufv_slots[u] = Q.slots; });
      const ok2 = G[hi] > TOL_SOMA ? julga(Q).length > 0 : (console.log('   plantio (zerado): NAO APLICAVEL (maior bruta ' + G[hi] + ' MWh <= folga)'), true);
      console.log('   plantio (' + hi + ' e ' + lo + ' trocados contra a recontagem): ' + (ok1 ? 'reprova' : 'NAO reprova') + ' · plantio (' + hi + ' zerado, soma abaixo do conjunto): ' + (ok2 ? 'reprova' : 'NAO reprova'));
      if (!ok1 || !ok2) f.push('plantio contra o dia real nao reprova');
    }
  }
  return f;
}

(async () => {
  const modo = process.argv.includes('--lib') ? 'lib' : 'produto';
  const f = modo === 'lib' ? lib() : await produto();
  if (f.length) { f.slice(0, 30).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-w2-bruta-usina (' + modo + '): TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
