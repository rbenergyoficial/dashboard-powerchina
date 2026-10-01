/*
 * ensaio-pr-ufv.js — o PR por usina e por contrato (PROMOVER pr-entidade).
 *
 *   --lib      a REGRA, em casos forjados: energia dos circuitos (so a parte positiva, hora so com os 12 instantes de TODOS
 *              os circuitos da usina), PR e corrigido do dia, contrato so com todas as usinas, mes por soma.
 *   --produto  o pr_ufv.json publicado: a placa soma a do conjunto; cada contrato refeito das usinas (energia, denominador,
 *              PR, corrigido); cada mes refeito dos dias; o corte da usina igual ao do executivo onde ele ainda esta na
 *              janela; e a soma das nove usinas contra o 230 kV do pr.json nos dias com as MESMAS horas validas, entre
 *              1,000 e 1,010 (medido 1,0032 a 1,0047 em 23 dias: perda de transformacao, sempre positiva e pequena).
 *              PLANTIOS: usina do contrato alterada, mes alterado e corte trocado reprovam.
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome))); req.on('error', ko);
  });
}
const perto = (a, b, t) => a != null && b != null && Math.abs(a - b) <= t;

function ensaioLib() {
  const L = require('./lib-pr.js'), f = [];
  const cobra = (c, m) => { if (!c) f.push(m); };
  // um dia de 5 min para os circuitos do M2 (6201, 6202): 1000 kW e 500 kW das 06 as 17 (rotulo pelo FIM), negativo a noite
  const val = (kw) => { const v = []; for (let i = 1; i <= 288; i++) { const ms = Date.parse('2026-09-10T00:00:00Z') + i * 300000, h = new Date(ms - 60000).getUTCHours();
    v.push({ data: new Date(ms).toISOString().slice(0, 19), valor: h >= 6 && h < 18 ? kw : -20 }); } return v; };
  const hist = { dados: [{ pontoId: 6201, nomeGrandeza: 'Demat', valores: val(1000) }, { pontoId: 6202, nomeGrandeza: 'Demat', valores: val(500) }] };
  const eU = L.energiaHorasUfv(hist), e2 = eU.get('M2');
  cobra(e2 && e2.size === 24, 'energia M2: 24 horas completas, veio ' + (e2 && e2.size));
  cobra(e2 && Math.abs(e2.get('2026-09-10T10').inj_mwh - 1.5) < 1e-9 && e2.get('2026-09-10T02').inj_mwh === 0, 'energia M2: 1,5 MWh na hora de sol e 0 a noite (so a parte positiva)');
  cobra(eU.get('M1').size === 0, 'M1 sem circuitos no arquivo: nenhuma hora');
  const h2 = { dados: [hist.dados[0], { pontoId: 6202, nomeGrandeza: 'Demat', valores: val(500).filter((x, i) => i !== 130) }] };
  cobra(L.energiaHorasUfv(h2).get('M2').size === 23, 'um instante faltando num circuito tira a hora');
  const gH = new Map(); for (let h = 0; h < 24; h++) gH.set('2026-09-10T' + String(h).padStart(2, '0'), h >= 6 && h < 18 ? 0.5 : 0);
  const d = L.prDiaUfv('2026-09-10', e2, gH, 30, 3);   // E = 18 MWh, H = 6 kWh/m2, den = 180 MWh
  cobra(d.pr_pct === 10 && d.pr_corrigido_pct === null && /fora/.test(d.nota_corrigido || ''), 'dia M2: PR 18/180 = 10 %; corrigido (18+3)/180 = 11,67 % fora da faixa: ' + JSON.stringify(d));
  const d2 = L.prDiaUfv('2026-09-10', e2, gH, 0.24, 3);  // den = 1,44 MWh -> PR 1250 %: acima do teto
  cobra(d2.pr_pct === null && /acima/.test(d2.nota || ''), 'PR acima do teto fica nulo');
  const a = { dia: 'x', pr_pct: 80, inj_mwh: 80, den_mwh: 100, pr_corrigido_pct: 90, impedida_mwh: 10 }, b = { dia: 'x', pr_pct: 60, inj_mwh: 30, den_mwh: 50, pr_corrigido_pct: 80, impedida_mwh: 10 };
  const g = L.prDiaGrupo('x', [a, b]);
  cobra(g.pr_pct === 73.33 && g.pr_corrigido_pct === 86.67, 'contrato: 110/150 = 73,33 %, (110+20)/150 = 86,67 %, veio ' + g.pr_pct + '/' + g.pr_corrigido_pct);
  cobra(L.prDiaGrupo('x', [a, Object.assign({}, b, { pr_pct: null })]).pr_pct === null, 'contrato com uma usina sem PR fica nulo');
  cobra(L.prDiaGrupo('x', [a, Object.assign({}, b, { pr_corrigido_pct: null })]).pr_corrigido_pct === null, 'contrato com uma usina sem corrigido fica sem corrigido');
  const m = L.prMesesEnt([Object.assign({}, a, { dia: '2026-09-01' }), Object.assign({}, b, { dia: '2026-09-02' })]);
  cobra(m.length === 1 && m[0].pr_pct === 73.33 && m[0].dias_validos === 2, 'mes por soma, nao por media de PR (media seria 70)');
  return f;
}

function julga(U, C, X) {
  const f = [];
  const E = U.entidades || {}, usinas = Object.keys(U.placa_mwp || {});
  if (usinas.length !== 9) return ['placa com ' + usinas.length + ' usinas'];
  if (!perto(usinas.reduce((s, u) => s + U.placa_mwp[u], 0), C.p_cc_mwp, 0.001)) f.push('a placa por usina nao soma a do conjunto');
  for (const [g, mb] of Object.entries(U.grupos || {})) {
    for (const r of (E[g] || {}).dias || []) {
      const L = mb.map((u) => (E[u].dias || []).find((x) => x.dia === r.dia));
      const todos = L.every((x) => x && x.pr_pct != null);
      if (!todos) { if (r.pr_pct != null) f.push(g + ' ' + r.dia + ': PR sem todas as usinas'); continue; }
      const Es = L.reduce((s, x) => s + x.inj_mwh, 0), Ds = L.reduce((s, x) => s + x.den_mwh, 0);
      if (!perto(r.inj_mwh, Es, 0.002) || !perto(r.den_mwh, Ds, 0.002) || !perto(r.pr_pct, 100 * Es / Ds, 0.0051)) f.push(g + ' ' + r.dia + ': nao refaz das usinas (' + r.pr_pct + ' x ' + (100 * Es / Ds).toFixed(3) + ')');
      if (L.every((x) => x.pr_corrigido_pct != null)) { const Cs = L.reduce((s, x) => s + x.impedida_mwh, 0);
        if (!perto(r.pr_corrigido_pct, 100 * (Es + Cs) / Ds, 0.0051)) f.push(g + ' ' + r.dia + ': corrigido nao refaz das usinas'); }
    }
  }
  for (const [e, v] of Object.entries(E)) for (const m of v.meses || []) {
    const D = (v.dias || []).filter((x) => x.dia.slice(0, 7) === m.mes && x.pr_pct != null);
    const Es = D.reduce((s, x) => s + x.inj_mwh, 0), Ds = D.reduce((s, x) => s + x.den_mwh, 0);
    if (D.length !== m.dias_validos || (Ds > 0 && !perto(m.pr_pct, 100 * Es / Ds, 0.0051))) f.push(e + ' ' + m.mes + ': mes nao refaz dos dias (' + m.pr_pct + ')');
  }
  const corte = new Map(((X && X.corte_diario_ufv) || []).filter((x) => x.cortado_mwh != null).map((x) => [x.dia + '|' + x.ufv, +x.cortado_mwh]));
  let nCorte = 0;
  for (const u of usinas) for (const r of E[u].dias || []) { const k = r.dia + '|' + u;
    if (r.impedida_mwh != null && corte.has(k)) { nCorte++; if (!perto(r.impedida_mwh, corte.get(k), 0.0006)) f.push(u + ' ' + r.dia + ': impedida ' + r.impedida_mwh + ', o executivo diz ' + corte.get(k)); } }
  if (!nCorte) f.push('nenhum dia com o corte da usina conferido contra o executivo');
  const cd = new Map((C.dias || []).map((d) => [d.dia, d])); let nFecha = 0;
  for (const r of (E.M1 || {}).dias || []) {
    const c = cd.get(r.dia); if (!c || c.horas_validas < 22) continue;
    const L = usinas.map((u) => E[u].dias.find((x) => x.dia === r.dia));
    if (L.some((x) => !x || x.horas_validas !== c.horas_validas)) continue;
    nFecha++; const razao = L.reduce((s, x) => s + x.inj_mwh, 0) / c.inj_mwh;
    if (razao < 1.000 || razao > 1.010) f.push(r.dia + ': nove usinas / 230 kV = ' + razao.toFixed(4) + ' (esperado 1,000 a 1,010)');
  }
  if (nFecha < 5) f.push('so ' + nFecha + ' dias comparaveis com o 230 kV');
  return { f, nCorte, nFecha };
}

(async () => {
  const modo = process.argv[2];
  let f;
  if (modo === '--lib') { f = ensaioLib(); console.log('   casos forjados da energia, do dia, do contrato e do mes'); }
  else if (modo === '--produto') {
    const [U, C, X] = await Promise.all([getJSON('pr_ufv.json'), getJSON('pr.json'), getJSON('executivo.json')]);
    const r = julga(U, C, X); f = r.f;
    console.log('   ' + Object.keys(U.entidades).length + ' entidades · ' + U.entidades.M1.dias.length + ' dias · corte conferido em ' + r.nCorte + ' usina-dias · ' + r.nFecha + ' dias contra o 230 kV');
    const base = new Set(f);
    const planta = (nome, fn, espera) => { const P = JSON.parse(JSON.stringify(U)); fn(P); const nv = julga(P, C, X).f.filter((x) => !base.has(x));
      const ok = nv.some((x) => x.indexOf(espera) >= 0); console.log('   plantio (' + nome + '): ' + nv.length + ' achado(s)' + (ok ? '' : ' — NENHUM com "' + espera + '"')); if (!ok) f.push('plantio "' + nome + '" nao reprova pelo que plantou'); };
    const diaOk = U.entidades.PPA.dias.find((x) => x.pr_pct != null);
    if (diaOk) planta('energia do M3 +1 MWh', (P) => { P.entidades.M3.dias.find((x) => x.dia === diaOk.dia).inj_mwh += 1; }, 'PPA ' + diaOk.dia);
    const mOk = U.entidades.M5.meses.find((x) => x.pr_pct != null);
    planta('mes do M5 +0,1', (P) => { P.entidades.M5.meses.find((x) => x.mes === mOk.mes).pr_pct += 0.1; }, 'M5 ' + mOk.mes);
    const cOk = U.entidades.M8.dias.find((x) => x.impedida_mwh != null && X.corte_diario_ufv.some((y) => y.dia === x.dia && y.ufv === 'M8'));
    if (cOk) planta('corte do M8 trocado', (P) => { P.entidades.M8.dias.find((x) => x.dia === cOk.dia).impedida_mwh += 5; }, 'M8 ' + cOk.dia + ': impedida');
  } else { console.error('uso: --lib | --produto'); process.exit(2); }
  if (f.length) { f.slice(0, 30).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-pr-ufv ' + modo + ': TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
