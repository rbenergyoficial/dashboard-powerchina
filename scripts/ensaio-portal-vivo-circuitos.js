/*
 * ensaio-portal-vivo-circuitos.js — os 22 circuitos e o retrato eletrico do portal_vivo.json (PROMOVER portal-vivo-circuitos).
 *
 * POR QUE EXISTE. A tela "Ao vivo" do portal desenha circuito a circuito (curva do dia, potencia ativa e reativa, fator de
 * potencia, tensao de linha, desequilibrio, corrente) e o 230 kV (reativa do dia) a partir do blob leve. Maneiras de o numero
 * sair errado sem nada ficar vermelho: circuito que parou ganha ZERO onde nao mediu; retrato com grandezas de instantes
 * diferentes; tensao de fase publicada como de linha; so a fase A no lugar da media; kVAr no lugar de MVAr; corrente somada;
 * desequilibrio em fracao; reativa de 230 kV com um trafo so.
 *
 * 🔴 A REFERENCIA E INDEPENDENTE. Este arquivo refaz tudo do dado BRUTO (way2_eletrico.json ou os casos forjados) com codigo
 * proprio, sem a lib: a comparacao "soma dos circuitos = curva da usina" sozinha e circular (os dois saem do mesmo Map da lib).
 * E a referencia e conferida contra valores feitos A MAO nos casos forjados, para as duas implementacoes nao errarem juntas.
 *
 * FOLGA = A DO ARREDONDAMENTO, NADA ALEM. Cada campo publicado com c casas fica a no maximo 0,5·10^-c do valor exato
 * (refeito da fonte crua, sem arredondar no caminho) — o fator de potencia de madrugada (P de -9 kW, Q de 192 kVAr) nao estoura
 * por arredondamento em cadeia. Soma de n circuitos (2 casas) contra a usina (3 casas): n·0,005 + 0,0005.
 *
 * NADA A JULGAR NAO E PASSAR: cada modo conta o que comparou e reprova com contagem zero havendo dado.
 *
 *   node scripts/ensaio-portal-vivo-circuitos.js --lib       casos forjados + defeitos plantados (ANTES de gravar o blob)
 *   node scripts/ensaio-portal-vivo-circuitos.js --produto   o portal_vivo.json publicado contra o way2_eletrico.json do
 *                                                            mesmo job, refeito aqui (DEPOIS de gravar)
 *   LOCAL_PV=arq.json LOCAL_ELET=arq.json ... --produto     o mesmo, com arquivos locais (gzip ou nao, pelos bytes 1f 8b)
 *   LIBPV=./lib/<copia>.js ... --lib                         a regra sobre outra versao da lib (ANTES: a do HEAD reprova)
 */
'use strict';
const https = require('https'), zlib = require('zlib'), fs = require('fs');
const L = require(process.env.LIBPV || './lib/portal-vivo.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const R3 = Math.sqrt(3);

// ── a REFERENCIA, refeita do bruto sem a lib ──────────────────────────────────────────────────────────────────────────
function indexa(elet) {
  const I = new Map();   // pid -> grandeza -> Map(hh:mm -> valor)
  for (const s of elet.dados || []) {
    if (!I.has(s.pontoId)) I.set(s.pontoId, new Map());
    const m = new Map();
    for (const v of s.valores || []) if (v && v.valor != null) m.set(v.data.slice(11, 16), v.valor);
    I.get(s.pontoId).set(s.nomeGrandeza, m);
  }
  return I;
}
function refRetrato(I, pid) {
  const g = n => (I.get(pid) || new Map()).get(n) || new Map();
  const hs = [...g('Demat').keys()].sort();
  if (!hs.length) return null;
  const h = hs[hs.length - 1], p = g('Demat').get(h) / 1000;
  const q = g('Demre').has(h) ? g('Demre').get(h) / 1000 : null;
  const V = ['TensaoA', 'TensaoB', 'TensaoC'].map(n => g(n).get(h)), A = ['CorrenteA', 'CorrenteB', 'CorrenteC'].map(n => g(n).get(h));
  const okV = V.every(x => x != null), okA = A.every(x => x != null);
  const mV = okV ? (V[0] + V[1] + V[2]) / 3 : null;
  return { h, p_mw: p, q_mvar: q, fp: q == null || (p === 0 && q === 0) ? null : Math.abs(p) / Math.sqrt(p * p + q * q),
    v_kv: okV ? mV * R3 / 1000 : null, v_deseq_pct: okV && mV > 0 ? 100 * Math.max(...V.map(v => Math.abs(v - mV))) / mV : null,   // tensao zero (circuito desligado): desequilibrio indefinido, nulo como na lib
    i_a: okA ? (A[0] + A[1] + A[2]) / 3 : null };
}
const CASAS = { p_mw: 3, q_mvar: 3, fp: 3, v_kv: 2, v_deseq_pct: 2, i_a: 1 };
function comparaRetrato(nome, pub, ref, f, cont) {
  if (!ref) { if (pub) f.push(nome + ': retrato publicado sem dado na fonte'); return; }
  if (!pub) { f.push(nome + ': retrato ausente (a fonte tem ' + ref.h + ')'); return; }
  if (pub.h !== ref.h) f.push(nome + ': retrato em ' + pub.h + ', a fonte mediu ate ' + ref.h);
  for (const [k, c] of Object.entries(CASAS)) {
    const a = pub[k], b = ref[k];
    if (b == null) { if (a != null) f.push(nome + ': ' + k + ' = ' + a + ' sem a grandeza na fonte nesse instante (veio de outro instante?)'); continue; }
    if (a == null) { f.push(nome + ': ' + k + ' nulo, a fonte tem ' + b.toFixed(c + 2)); continue; }
    if (Math.abs(a - b) > 0.5 * 10 ** -c + 1e-9) f.push(nome + ': ' + k + ' = ' + a + ', refeito da fonte ' + b.toFixed(c + 2));
    cont.campos++;
  }
}

// ── a conferencia: produto contra a referencia refeita do bruto ──────────────────────────────────────────────────────
function confere(pv, elet, CIRC) {
  const f = [], cont = { pontos: 0, campos: 0, soma: 0, altaq: 0 };
  const I = indexa(elet);
  const C = pv.circuitos;
  if (!Array.isArray(C) || C.length !== 22) return { f: ['circuitos: ' + (C ? C.length : 'ausente') + ' (esperava 22)'], cont };
  const ids = Object.values(CIRC).flat();
  C.forEach((c, i) => {
    const u = Object.keys(CIRC).find(x => CIRC[x].includes(c.pid));
    const nome = u + ' · C' + (CIRC[u].indexOf(c.pid) + 1);
    if (c.pid !== ids[i] || c.u !== u || c.nome !== nome) f.push('circuito fora de ordem ou com nome errado: ' + JSON.stringify([c.pid, c.u, c.nome]));
    // a curva: exatamente os instantes em que o circuito mediu potencia ativa, cada valor = Demat / 1000 em 2 casas
    const dm = (I.get(c.pid) || new Map()).get('Demat') || new Map();
    const pub = new Map(c.pts);
    for (const [h, v] of pub) {
      if (!dm.has(h)) { f.push(c.nome + ' ' + h + ': ponto publicado num instante que o circuito nao mediu (valor ' + v + ')'); continue; }
      if (Math.abs(v - dm.get(h) / 1000) > 0.005 + 1e-9) f.push(c.nome + ' ' + h + ': ' + v + ' MW, a fonte tem ' + (dm.get(h) / 1000).toFixed(4));
      cont.pontos++;
    }
    for (const h of dm.keys()) if (!pub.has(h)) f.push(c.nome + ' ' + h + ': a fonte mediu e a curva nao tem o ponto');
    comparaRetrato(c.nome, c.agora, refRetrato(I, c.pid), f, cont);
  });
  const E = pv.eletrico || {};
  comparaRetrato('TR1', E.tr1, refRetrato(I, L.TRAFOS[0]), f, cont);
  comparaRetrato('TR2', E.tr2, refRetrato(I, L.TRAFOS[1]), f, cont);
  comparaRetrato('complexo', E.complexo, refRetrato(I, L.COMPLEXO), f, cont);
  // a soma dos circuitos de cada usina, onde todos mediram, e a curva da usina: n circuitos em 2 casas + a usina em 3
  for (const [u, ps] of Object.entries(CIRC)) {
    const cu = (pv.curvas || {})[u] || [];
    const mapas = ps.map(p => new Map(C.find(c => c.pid === p).pts));
    for (const [h, v] of cu) {
      if (!mapas.every(m => m.has(h))) { f.push(u + ' ' + h + ': a usina tem ponto e um circuito dela nao'); continue; }
      const s = mapas.reduce((a, m) => a + m.get(h), 0);
      if (Math.abs(s - v) > 0.005 * ps.length + 0.0005 + 1e-9) f.push(u + ' ' + h + ': soma dos circuitos ' + s.toFixed(3) + ' contra a usina ' + v);
      cont.soma++;
    }
  }
  // a reativa de 230 kV: so onde os DOIS trafos mediram a reativa, nos instantes da curva do complexo
  const qa = (I.get(L.TRAFOS[0]) || new Map()).get('Demre') || new Map(), qb = (I.get(L.TRAFOS[1]) || new Map()).get('Demre') || new Map();
  const hc = [...((I.get(L.COMPLEXO) || new Map()).get('Demat') || new Map()).keys()].sort();
  const esp = hc.filter(h => qa.has(h) && qb.has(h));
  const aq = new Map(pv.alta_q || []);
  if (aq.size !== esp.length) f.push('alta_q com ' + aq.size + ' instantes, a fonte tem ' + esp.length + ' com os dois trafos');
  for (const h of esp) {
    if (!aq.has(h)) { f.push('alta_q sem ' + h); continue; }
    const ref = (qa.get(h) + qb.get(h)) / 1000;
    if (Math.abs(aq.get(h) - ref) > 0.0005 + 1e-9) f.push('alta_q ' + h + ': ' + aq.get(h) + ', refeito ' + ref.toFixed(4));
    cont.altaq++;
  }
  // os numeros do dia em DUAS casas (PROMOVER portal-vivo-casas): energia, FC, media e % do pico, do conjunto e de cada
  // entidade, refeitos da curva publicada (a lib soma a mesma curva, em 3 casas); folga = meia unidade da 2a casa
  const kp = (nome, c, cap, o, pctK, enLida) => {
    if (!o || !Array.isArray(c) || !c.length || !(cap > 0)) return;
    const en = c.reduce((s, [, v]) => s + v, 0) * 5 / 60, hs = c.length * 5 / 60, pk = Math.max(...c.map(x => x[1]));
    const ref = { energia_mwh: enLida != null ? enLida : en, fc_pct: 100 * en / (cap * hs), media_mw: en / hs, [pctK]: 100 * pk / cap };
    for (const [k, v] of Object.entries(ref)) {
      if (o[k] == null || Math.abs(o[k] - v) > 0.005 + 1e-6) f.push(nome + ': ' + k + ' = ' + o[k] + ', refeito ' + v.toFixed(4) + ' (duas casas)');
      cont.kpis++;
    }
  };
  cont.kpis = 0;
  kp('Complexo', pv.curva, pv.outorga_mw, pv, 'pct_outorga');
  // a potencia de cada circuito (PROMOVER portal-cap-circuito): a tabela lida no unifilar do SCADA, transcrita AQUI de novo
  // (referencia independente da lib), circuito a circuito na ordem C1..C3; e a soma de cada usina = a capacidade dela
  const CAPREF = { M1: [16.38, 19.65, 13.08], M2: [12.27, 12.285], M3: [13.097, 19.633, 16.38], M4: [13.08, 16.37, 19.66],
    M5: [19.66, 9.816, 19.634], M6: [19.639, 16.366, 13.105], M7: [14.733], M8: [13.088, 19.66, 16.362], M9: [9.822] };
  cont.cap = 0; let capTot = 0;
  for (const [u, ps] of Object.entries(CIRC)) {
    const caps = ps.map(p => (C.find(c => c.pid === p) || {}).cap_mw);
    caps.forEach((v, i) => { if (v !== (CAPREF[u] || [])[i]) f.push(u + ' · C' + (i + 1) + ': potencia instalada ' + v + ' MW, o unifilar diz ' + (CAPREF[u] || [])[i]); else cont.cap++; });
    const s = caps.reduce((a, v) => a + (v || 0), 0); capTot += s;
    if (L.CAP && Math.abs(s - L.CAP[u]) > 1e-6) f.push(u + ': os circuitos somam ' + s.toFixed(3) + ' MW, a usina tem ' + L.CAP[u]);
  }
  if (Math.abs(capTot - 343.77) > 1e-6) f.push('os 22 circuitos somam ' + capTot.toFixed(3) + ' MW, a outorga e 343,77');
  // vivo-sem-leitura: a ENERGIA de usina e contrato = a curva tudo-ou-nada publicada da entidade + nos instantes do complexo em
  // que ela falta, o que os circuitos dela leram (refeito do BRUTO, sem a lib); o FC, a media e o pico seguem a curva. Os
  // grupos transcritos AQUI de novo (referencia independente da lib).
  const lidaE = {}, ENTS = Object.assign({}, CIRC);
  for (const [g, us] of Object.entries({ PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] })) ENTS[g] = us.flatMap(u => CIRC[u]);
  for (const [e, ps] of Object.entries(ENTS)) {
    const ce = new Map((pv.curvas || {})[e] || []); let s = 0;
    for (const h of hc) { if (ce.has(h)) s += ce.get(h); else for (const p of ps) { const v = ((I.get(p) || new Map()).get('Demat') || new Map()).get(h); if (v != null) s += v / 1000; } }
    lidaE[e] = s * 5 / 60;
  }
  for (const [e, o] of Object.entries(pv.kpis || {})) kp(e, (pv.curvas || {})[e], o && o.cap_mw, o, 'pct_cap', lidaE[e]);
  return { f, cont };
}

// ── casos forjados ───────────────────────────────────────────────────────────────────────────────────────────────────
// 3 instantes (fator 1,0 · 1,1 · 1,2). Fases ASSIMETRICAS (A = 1,03·m, B = m, C = 0,97·m; correntes 1,1 · 1 · 0,9): so a fase
// A ou a soma das tres nao passam. 6201 (M2 · C1) nao mede 10:05; 6198 (M1 · C1) perde a TensaoB em 10:10; 6202 (M2 · C2)
// perde a Demre em 10:10; 6203 (M3 · C1) gera NEGATIVO de madrugada (P -9 kW, Q 192 kVAr); o TR2 perde a Demre em 10:05.
const H = ['10:00', '10:05', '10:10'], DIA = '2026-10-03';
function forja() {
  const CIRC = L.mapaCircuitos();
  if (!CIRC) throw new Error('o mapa de circuitos do gen-executivo.js nao leu');
  const dados = [];
  const ponto = (pid, kw, kvar, vf, ia, falta) => {
    const g = { Demat: kw, Demre: kvar, TensaoA: vf * 1.03, TensaoB: vf, TensaoC: vf * 0.97, CorrenteA: ia * 1.1, CorrenteB: ia, CorrenteC: ia * 0.9 };
    for (const [n, v] of Object.entries(g)) dados.push({ pontoId: pid, nomeGrandeza: n,
      valores: H.map((h, i) => ({ data: `${DIA}T${h}:00`, valor: (falta && falta(n, h)) ? null : v * (1 + i / 10) })) });
  };
  let k = 0;
  for (const ps of Object.values(CIRC)) for (const p of ps) {
    k++;
    const falta = p === 6201 ? (n, h) => h === '10:05' : p === 6198 ? (n, h) => n === 'TensaoB' && h === '10:10'
      : p === 6202 ? (n, h) => n === 'Demre' && h === '10:10' : null;
    if (p === 6203) ponto(p, -9, 192, 19900, 2, null); else ponto(p, 1000 * k, 300, 19900, 40, falta);
  }
  ponto(L.TRAFOS[0], 50000, 9000, 136700, 120, null);
  ponto(L.TRAFOS[1], 50000, 9000, 136700, 120, (n, h) => n === 'Demre' && h === '10:05');
  ponto(L.COMPLEXO, 100000, 18000, 19900, 2000, null);
  return { elet: { dataInicio: DIA + 'T00:00:00', dados }, CIRC };
}
// valores feitos A MAO (10:10, fator 1,2): a referencia acima tem de concordar com eles
function aMao(pv) {
  const f = [], c = pid => pv.circuitos.find(x => x.pid === pid), q = (a, b, t, nome) => { if (a == null || Math.abs(a - b) > t) f.push('a mao · ' + nome + ': ' + a + ' (esperava ' + b + ')'); };
  const c2 = c(6199).agora;   // M1 · C2: 2000 kW, 300 kVAr, fase media 19 900 V, corrente media 40 A
  q(c2.p_mw, 2.4, 1e-9, 'M1 · C2 P'); q(c2.q_mvar, 0.36, 1e-9, 'M1 · C2 Q (MVAr)');
  q(c2.fp, Math.round(1000 * 2.4 / Math.hypot(2.4, 0.36)) / 1000, 1e-9, 'M1 · C2 FP');
  q(c2.v_kv, Math.round(100 * 19900 * 1.2 * R3 / 1000) / 100, 1e-9, 'M1 · C2 tensao de linha (media x raiz de 3)');
  q(c2.v_deseq_pct, 3, 1e-9, 'M1 · C2 desequilibrio (%)'); q(c2.i_a, 48, 1e-9, 'M1 · C2 corrente (media)');
  if (c(6198).agora.v_kv !== null) f.push('a mao · M1 · C1: tensao sem a fase B no instante tem de ser nula, veio ' + c(6198).agora.v_kv);
  if (c(6202).agora.q_mvar !== null || c(6202).agora.fp !== null) f.push('a mao · M2 · C2: sem Demre no instante, Q e FP nulos');
  const n3 = c(6203).agora;   // madrugada: P -9 x 1,2 = -10,8 kW, Q 230,4 kVAr
  q(n3.p_mw, -0.011, 1e-9, 'M3 · C1 P negativo'); q(n3.fp, Math.round(1000 * 10.8 / Math.hypot(10.8, 230.4)) / 1000, 1e-9, 'M3 · C1 FP (|P|/S, positivo)');
  if (c(6201).pts.length !== 2 || c(6201).pts.some(p => p[0] === '10:05')) f.push('a mao · M2 · C1: a curva tem de ter so 10:00 e 10:10');
  // vivo-sem-leitura: energia LIDA do M2 = (4,0 + 4,8 do C1, sem 10:05) + (5,0 + 5,5 + 6,0 do C2) MW x 5 min = 2,108 → 2,11
  // (a tudo-ou-nada, sem o 10:05 dos dois, daria 1,65)
  q(pv.kpis.M2.energia_mwh, 2.11, 1e-9, 'M2 energia lida (o C1 sem 10:05 nao tira o C2)');
  q(pv.eletrico.tr1.v_kv, Math.round(100 * 136700 * 1.2 * R3 / 1000) / 100, 1e-9, 'TR1 tensao de linha');
  q(pv.eletrico.tr1.q_mvar, 10.8, 1e-9, 'TR1 Q');
  const aq = new Map(pv.alta_q);
  if (aq.size !== 2 || aq.has('10:05')) f.push('a mao · alta_q: 2 instantes, sem 10:05 (so um trafo mediu a reativa)');
  q(aq.get('10:10'), 21.6, 1e-9, 'alta_q 10:10 (9000 + 9000) x 1,2 / 1000');
  return f;
}

// ── leitura: gzip decidido pelos BYTES (1f 8b), nao pelo cabecalho ──────────────────────────────────────────────────
const decodifica = b => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(url) {
  return new Promise((ok, ko) => {
    https.get(url, { timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { ok(decodifica(Buffer.concat(c))); } catch (e) { ko(new Error('nao li ' + url + ': ' + e.message)); } });
    }).on('error', ko);
  });
}
const local = (v) => decodifica(fs.readFileSync(v));

async function main() {
  const modo = process.argv[2] || '--lib';
  const CIRC = L.mapaCircuitos();
  if (modo === '--lib') {
    const { elet } = forja();
    const pv = L.monta(elet, null);
    const { f, cont } = confere(pv, elet, CIRC);
    if (!f.length) f.push(...aMao(pv));
    if (!f.length && (cont.pontos < 60 || cont.campos < 100 || cont.soma < 1 || cont.altaq !== 2 || cont.kpis < 48 || cont.cap !== 22))
      f.push('julgou pouco: ' + JSON.stringify(cont));
    if (f.length) { console.error('REPROVADO (lib):\n  ' + f.slice(0, 20).join('\n  ')); process.exit(1); }
    console.log('lib: ' + JSON.stringify(cont) + ' · referencia refeita do bruto e valores a mao conferem');
    // defeitos plantados NO PRODUTO da lib: cada um tem de reprovar
    const plant = [
      ['zero no instante que nao mediu', p => { p.circuitos.find(x => x.pid === 6201).pts.splice(1, 0, ['10:05', 0]); }],
      ['tensao de outro instante no retrato', p => { p.circuitos.find(x => x.pid === 6198).agora.v_kv = 41.37; }],
      ['tensao de fase como linha', p => { p.circuitos.find(x => x.pid === 6199).agora.v_kv = 23.88; }],
      ['reativa em kVAr', p => { p.circuitos.find(x => x.pid === 6199).agora.q_mvar = 360; }],
      ['reativa de outro instante', p => { p.circuitos.find(x => x.pid === 6202).agora.q_mvar = 0.33; }],
      ['corrente somada', p => { p.circuitos.find(x => x.pid === 6199).agora.i_a = 144; }],
      ['desequilibrio em fracao', p => { p.circuitos.find(x => x.pid === 6199).agora.v_deseq_pct = 0.03; }],
      ['trafo sem retrato', p => { p.eletrico.tr2 = null; }],
      ['alta_q com um trafo so', p => { p.alta_q.splice(1, 0, ['10:05', 9.9]); }],
      ['alta_q vazia', p => { p.alta_q = []; }],
      ['retratos nulos', p => { p.circuitos.forEach(c => { c.agora = null; }); }],
      ['energia do dia errada na segunda casa', p => { p.energia_mwh += 0.02; }],
      ['FC de uma usina errado na segunda casa', p => { p.kpis.M2.fc_pct -= 0.02; }],
      ['energia da usina tudo-ou-nada com um circuito sem leitura (a regra de antes do vivo-sem-leitura)', p => { p.kpis.M2.energia_mwh = 1.65; }],
      ['energia do contrato tudo-ou-nada', p => { p.kpis.PPA.energia_mwh = Math.round(100 * p.curvas.PPA.reduce((a, x) => a + x[1], 0) * 5 / 60) / 100; }],
      ['potencia de dois circuitos trocada (a soma da usina fecha)', p => { const a = p.circuitos.find(x => x.pid === CIRC.M5[0]), b = p.circuitos.find(x => x.pid === CIRC.M5[1]); const z = a.cap_mw; a.cap_mw = b.cap_mw; b.cap_mw = z; }],
      ['circuito sem potencia instalada', p => { p.circuitos[0].cap_mw = null; }],
    ];
    for (const [nome, estraga] of plant) {
      const p = JSON.parse(JSON.stringify(pv)); estraga(p);
      if (!confere(p, elet, CIRC).f.length) { console.error('REPROVADO: o defeito plantado "' + nome + '" passou'); process.exit(1); }
    }
    console.log('  ' + plant.length + ' defeitos plantados, todos reprovam');
    return;
  }
  if (modo === '--produto') {
    const pv = process.env.LOCAL_PV ? local(process.env.LOCAL_PV) : await getJSON(BASE + 'portal_vivo.json?t=' + Date.now());
    const elet = process.env.LOCAL_ELET ? local(process.env.LOCAL_ELET) : await getJSON(BASE + 'way2_eletrico.json?t=' + Date.now());
    const diaF = (elet.dataInicio || '').slice(0, 10);
    const hc = [...((indexa(elet).get(L.COMPLEXO) || new Map()).get('Demat') || new Map()).keys()].sort();
    // de 00:00 a ~00:10 o coletor grava o dia novo sem leitura nenhuma e o gerador (certo) nao regrava: o produto e o de
    // ontem. Isso e "nao se aplica", nao defeito — eram tres vermelhos falsos por noite (03:00Z a 03:10Z de 04/10/2026).
    if (!hc.length) { console.log('nao se aplica: o dia ' + diaF + ' ainda nao tem leitura do complexo (o produto e o de ' + pv.dia + ')'); return; }
    if (diaF !== pv.dia || hc[hc.length - 1] !== pv.hora) {
      // no job os dois saem da mesma rodada; diferentes, a comparacao mediria a corrida e nao a lib
      console.error('REPROVADO: a fonte (' + diaF + ' ' + hc[hc.length - 1] + ') e o produto (' + pv.dia + ' ' + pv.hora + ') sao de instantes diferentes');
      process.exit(1);
    }
    const { f, cont } = confere(pv, elet, CIRC);
    if (!f.length && cont.pontos === 0) f.push('nada a julgar com o complexo medindo: ' + JSON.stringify(cont));
    if (f.length) { console.error('REPROVADO (produto ' + pv.dia + ' ' + pv.hora + '):\n  ' + f.slice(0, 20).join('\n  ')); process.exit(1); }
    console.log('produto ' + pv.dia + ' ' + pv.hora + ': ' + JSON.stringify(cont) + ' · tudo refeito do way2_eletrico.json da mesma rodada');
    return;
  }
  console.error('uso: --lib | --produto'); process.exit(2);
}
// a conferencia serve tambem ao gerador dos arquivos de cada dia (gen-portal-dia.js): ele nao grava o que nao passa nela
module.exports = { confere };
if (require.main === module) main().catch(e => { console.error(e.stack || e); process.exit(1); });
