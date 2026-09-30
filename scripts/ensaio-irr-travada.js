/*
 * ensaio-irr-travada.js — a leitura de irradiancia travada sai da serie de 30 min E da hora (PROMOVER irr-travada).
 *
 *   --lib     · a REGRA em casos forjados: o travamento do M5 de 23/09 (0,26 W/m2 com as outras a ~1000) sai so nas meias
 *               horas com sol nas outras; CINCO estacoes travadas juntas (o 17/04 real) saem todas; a borda do limiar do
 *               contrato fica fixada (mediana das outras a 99 W/m2 fica, a 101 sai); zeros de noite, um dia limpo que
 *               varia e uma corrida de 3 ficam; um travamento em 900 W/m2 ao meio-dia sai. Plantio: a regra que nao retira
 *               nada reprova.
 *   --produto · no `irr_30min.json` publicado a mesma regra nao acha NENHUM trecho travado; e no `irr_60min.json` nenhuma
 *               HORA com meia hora retirada (declarada em `irr_ufv.leituras_travadas`) tem valor — nem da estacao, nem do
 *               conjunto: e dessa hora que o PR le. Plantio: o 0,26 reinserido num dia com sol reprova.
 *   sem argumento, as duas.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const { travadas } = require('./lib-irr-travada.js');
const { LIMIAR_IRR } = require('./lib-disponibilidade.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome)));
    req.on('error', ko);
  });
}

const k = (d, u, s) => d + '|' + u + '|' + String(s).padStart(2, '0');
const slotDe = (t) => +String(t).slice(11, 13) * 2 + (+String(t).slice(14, 16) >= 30 ? 1 : 0);   // `t` leva o -03:00: a hora e local

// ---- LIB -------------------------------------------------------------------------------------------------
const US9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
// dia limpo: sino de 06:00 (slot 12) a 18:00 (slot 36), pico ~1000, com um ruido que muda a leitura a cada meia hora
const sol = (s, u) => { if (s < 12 || s > 36) return 0; const x = Math.sin(Math.PI * (s - 12) / 24); return Math.round((1000 * x + US9.indexOf(u) * 0.37 + s * 0.11) * 100) / 100; };
const dia = (mexe) => { const L = {}; for (let s = 0; s < 48; s++) for (const u of US9) L[k('2026-09-23', u, s)] = mexe(u, s); return L; };

function casoLib(regra) {
  const f = [];
  // A · o M5 de 23/09: 0,26 de 05:00 a 11:30 (slots 10..23); sai so onde as outras ja passam do limiar
  const A = regra(dia((u, s) => (u === 'M5' && s >= 10 && s <= 23 ? 0.26 : sol(s, u))));
  if (!A.retirar.has(k('2026-09-23', 'M5', 16)) || A.retirar.has(k('2026-09-23', 'M5', 10))) f.push('lib/A: o travamento do M5 nao saiu como devia');
  if ([...A.retirar].some((x) => !x.includes('|M5|'))) f.push('lib/A: retirou estacao que nao travou');
  // B · noite em zero e dia limpo: nada sai
  const B = regra(dia((u, s) => sol(s, u)));
  if (B.retirar.size) f.push('lib/B: retirou ' + B.retirar.size + ' meias horas de um dia limpo');
  // C · corrida de 3 identicas: fica (o minimo e 4)
  const C = regra(dia((u, s) => (u === 'M3' && s >= 22 && s <= 24 ? 950 : sol(s, u))));
  if (C.retirar.size) f.push('lib/C: uma corrida de 3 foi retirada');
  // D · travada em 900 W/m2 ao meio-dia por 4 meias horas: sai
  const D = regra(dia((u, s) => (u === 'M8' && s >= 22 && s <= 25 ? 900 : sol(s, u))));
  if (D.retirar.size !== 4) f.push('lib/D: travamento em 900 W/m2 por 4 meias horas retirou ' + D.retirar.size);
  // E · CINCO estacoes em zero juntas por 4 meias horas com as outras quatro a ~700 (o 17/04): as cinco saem. A mediana
  //     tem de ser das OUTRAS: com a propria estacao dentro, a mediana cairia e os zeros ficariam
  const T5 = ['M2', 'M3', 'M5', 'M6', 'M8'];
  const E = regra(dia((u, s) => (s >= 20 && s <= 23 ? (T5.includes(u) ? 0 : 700 + US9.indexOf(u) + s * 0.1) : sol(s, u))));
  const eU = new Set([...E.retirar].map((x) => x.split('|')[1]));
  if (T5.some((u) => !eU.has(u)) || E.retirar.size !== 20) f.push('lib/E: cinco estacoes travadas juntas retiraram ' + E.retirar.size + ' de 20 (' + [...eU].join(',') + ')');
  // F · a borda do limiar do contrato: M4 travado em 3,00 por 4 meias horas com as OUTRAS todas a 99 (fica) e a 101 (sai)
  const borda = (v) => regra(dia((u, s) => (s >= 20 && s <= 23 ? (u === 'M4' ? 3 : v + US9.indexOf(u) * 0.01 + (s - 20) * 0.05) : sol(s, u))));
  const F99 = borda(LIMIAR_IRR - 0.5), F101 = borda(LIMIAR_IRR + 1);   /* as outras variam na 2a casa (senao elas mesmas pareceriam travadas): 99,50 a 99,73 (abaixo) e 101,00 a 101,23 */
  if (F99.retirar.size) f.push('lib/F: com as outras a ' + (LIMIAR_IRR - 0.5) + ' W/m2 (abaixo do limiar) retirou ' + F99.retirar.size);
  if (F101.retirar.size !== 4) f.push('lib/F: com as outras a ' + (LIMIAR_IRR + 1) + ' W/m2 (acima do limiar) retirou ' + F101.retirar.size + ' de 4');
  return f;
}

// ---- PRODUTO ---------------------------------------------------------------------------------------------
function varre(serie, us) {
  const L = {};
  for (const x of serie || []) { const d = String(x.t).slice(0, 10), s = slotDe(x.t); for (const u of us) if (x[u] != null && isFinite(x[u])) L[k(d, u, s)] = x[u]; }
  return travadas(L);
}

async function produto() {
  const f = [];
  const [j30, j60, iu] = await Promise.all([getJSON('irr_30min.json'), getJSON('irr_60min.json'), getJSON('irr_ufv.json')]);
  const us = (j30.ufvs || []).filter((u) => u !== 'Complexo');
  if (us.length < 2) f.push('produto: irr_30min sem a lista de estacoes (ufvs)');
  const S = j30.serie || [];
  if (!S.length) f.push('produto: irr_30min sem serie — nada a julgar');
  const r = varre(S, us);
  console.log('   produto 30 min: ' + S.length + ' meias horas · ' + r.trechos.length + ' trecho(s) travado(s)'
    + r.trechos.slice(0, 5).map((t) => ' · ' + t.dia + ' ' + t.ufv + ' ' + t.valor + ' x' + t.n).join(''));
  if (r.trechos.length) f.push('produto: ' + r.trechos.length + ' trecho(s) travado(s) ainda na serie de 30 min publicada');
  // a HORA: nenhuma hora com meia hora retirada tem valor, na estacao e no conjunto
  const T = iu.leituras_travadas;
  if (!Array.isArray(T)) f.push('produto: irr_ufv.json sem `leituras_travadas` — o gerador nao declara o que retirou');
  const H = new Map((j60.serie || []).map((x) => [String(x.t).slice(0, 13), x]));
  let horas = 0;
  for (const t of T || []) {
    for (let h = t.ini; h <= t.fim + 1e-9; h += 0.5) {
      const kh = t.dia + 'T' + String(Math.floor(h)).padStart(2, '0'), x = H.get(kh);
      if (!x) continue;
      horas++;
      if (x[t.ufv] != null) f.push('produto 60 min: ' + kh + ' ' + t.ufv + ' = ' + x[t.ufv] + ' com meia hora retirada');
      if (x.Complexo != null) f.push('produto 60 min: ' + kh + ' Complexo = ' + x.Complexo + ' com meia hora retirada');
    }
  }
  console.log('   produto 60 min: ' + horas + ' hora(s) com meia hora retirada dentro da janela, todas sem valor? ' + (f.every((x) => !/60 min/.test(x)) ? 'sim' : 'NAO'));
  // PLANTIO: o 0,26 do M5 reinserido de 08:00 a 11:30 no dia mais recente em que as outras estao com sol a manha toda
  const dias = [...new Set(S.map((x) => String(x.t).slice(0, 10)))].sort().reverse();
  const md = (x) => { const v = us.filter((u) => u !== 'M5').map((u) => x[u]).filter((y) => y != null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  const alvo = dias.find((d) => { const m = S.filter((x) => String(x.t).slice(0, 10) === d && slotDe(x.t) >= 16 && slotDe(x.t) <= 23); return m.length === 8 && m.every((x) => md(x) > LIMIAR_IRR); });
  if (!alvo) { f.push('produto: nenhum dia da janela com sol a manha toda para o plantio'); return f; }
  const P = JSON.parse(JSON.stringify(S));
  P.forEach((x) => { if (String(x.t).slice(0, 10) === alvo && slotDe(x.t) >= 16 && slotDe(x.t) <= 23) x.M5 = 0.26; });
  const rp = varre(P, us);
  const achou = rp.trechos.some((t) => t.ufv === 'M5' && t.dia === alvo);
  console.log('   plantio (0,26 no M5 de ' + alvo + ', 08:00-11:30): ' + (achou ? 'achado' : 'NAO achado'));
  if (!achou) f.push('produto: o plantio do M5 travado NAO reprova');
  return f;
}

(async () => {
  const so = process.argv.includes('--lib') ? 'lib' : process.argv.includes('--produto') ? 'produto' : 'ambos';
  const f = [];
  if (so !== 'produto') {
    const L = casoLib(travadas);
    console.log('   lib: ' + (L.length ? L.length + ' achado(s)' : '6 casos (M5 de 23/09, dia limpo, corrida de 3, 900 W/m2, cinco juntas, borda do limiar)'));
    f.push(...L);
    const P = casoLib(() => ({ retirar: new Set(), trechos: [] }));   // PLANTIO: a regra que nao retira nada
    console.log('   plantio (regra que nao retira): ' + P.length + ' achado(s)');
    if (!P.length) f.push('lib: a regra que nao retira nada PASSA — o ensaio nao mede nada');
  }
  if (so !== 'lib') f.push(...await produto());
  if (f.length) { f.slice(0, 20).forEach((x) => console.error('REPROVADO: ' + x)); if (f.length > 20) console.error('REPROVADO: mais ' + (f.length - 20)); process.exit(1); }
  console.log('ensaio-irr-travada' + (so === 'ambos' ? '' : ' --' + so) + ': TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
