'use strict';
/*
 * ensaio-inversor-cru.js — os inversores que o export traz em registro CRU (lib-inversor-cru.js).
 *
 * REGRA   · o casamento pega o codigo provado e so ele: codigo fora do mapa, coluna nomeada, inversor do prefixo
 *           diferente do registro e usina trocada NAO casam; o mapa tem 22 strings, 12 correntes e 12 tensoes de
 *           MPPT, e nenhuma grandeza recebe dois codigos.
 * PRODUTO · a identidade que denunciava o buraco: medidor / soma dos contadores dos inversores. Com o M9 lido pela
 *           metade (23 de 33) ela passava de 140 %, o que e fisicamente impossivel; com os crus, cai na faixa das
 *           outras usinas (corrigidas pela cobertura) NO MESMO DIA. So o dia com o M9 COMPLETO e julgado; e as
 *           linhas por inversor do M9 TS1 INV13..22 tem de ter pico possivel e eficiencia como a dos nomeados (ver abaixo).
 * PLANTIO · o mesmo julgamento sobre um dia forjado com a razao do M9 em 141 % tem de reprovar.
 *
 *   node scripts/ensaio-inversor-cru.js            (le os blobs publicos; LOCAL_DIR=<pasta> le uma rodada local)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { casaCru, CODIGO } = require('./lib-inversor-cru.js');

const falhas = [];
const exige = (ok, msg) => { if (!ok) falhas.push(msg); };

// ── REGRA ────────────────────────────────────────────────────────────────────────────────────────────
const cru = (inv, reg, cod, usina = 'MRT09', uReg = 'MRT09') =>
  `UFV_${usina}_TS1_INV${inv}_UFV_${uReg}_Comunicacao_TS1.EMU200A_INV.INV${reg}.[MRT09-C01-WAA01GW0${reg}X${cod}]`;
const a = casaCru(cru('13', '13', 'Q50'));
exige(a && a.ts === 'TS1' && a.inv === 'INV13' && a.grandeza === 'POTÊNCIA ATIVA TOTAL', 'Q50 do INV13 nao casou a potencia ativa: ' + JSON.stringify(a));
exige(casaCru(cru('13', '13', 'Q07')) === null, 'codigo fora do mapa (Q07) casou');
exige(casaCru(cru('13', '14', 'Q50')) === null, 'registro do INV14 sob o prefixo do INV13 casou');
exige(casaCru(cru('13', '13', 'Q50', 'MRT09', 'MRT08')) === null, 'usina trocada entre prefixo e registro casou');
exige(casaCru('UFV_MRT09_TS1_INV01_MRT09 TS1 INV01 POTÊNCIA ATIVA TOTAL') === null, 'coluna nomeada casou como crua');
const vals = Object.values(CODIGO);
const conta = (re) => vals.filter((v) => re.test(v)).length;
exige(conta(/^CORRENTE STRING \d\d$/) === 22, 'o mapa nao tem 22 strings');
exige(conta(/^CORRENTE MPPT \d\d$/) === 12, 'o mapa nao tem 12 correntes de MPPT');
exige(conta(/^TENSÃO MPPT \d\d$/) === 12, 'o mapa nao tem 12 tensoes de MPPT');
exige(new Set(vals).size === vals.length, 'duas grandezas recebem o mesmo nome no mapa');
const J81 = casaCru(cru('13', '13', 'J81'));
exige(J81 && J81.grandeza === 'SETPOINT POTÊNCIA ATIVA', 'J81 tem de ser o SETPOINT (nao a potencia ativa, a primeira leitura errada)');

// ── PRODUTO ──────────────────────────────────────────────────────────────────────────────────────────
/* 🔴 SO O DIA COM O M9 COMPLETO (medidos = placa), e a faixa das outras CORRIGIDA PELA COBERTURA. A primeira versao
   julgava todo dia com "mais de 23" e reprovou 11 a 17/09 — com 28 de 33 (cinco do TS1 so entraram no export em
   18/09) o medidor fica ~33/28 acima dos contadores: era cobertura, nao leitura. E a faixa das outras vinha inflada
   pelo mesmo motivo (M7 com 39 de 44 a 113 %). Corrigir o M9 pela cobertura tambem nao serve: supoe que os ausentes
   geram como os presentes, e um ensaio nao julga extrapolacao. */
const corr = (r, u) => {
  const q = r[u + '_razao_med_conta'], n = r[u + '_n_inv'], p = r[u + '_n_placa'];
  return typeof q === 'number' && typeof n === 'number' && p > 0 ? q * n / p : null;
};
function julgaDia(r) {
  const U = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8'];
  const outras = U.map((u) => corr(r, u)).filter((v) => v != null);
  const m9 = r.M9_razao_med_conta;
  if (outras.length < 5 || typeof m9 !== 'number' || !(r.M9_n_inv > 0 && r.M9_n_inv === r.M9_n_placa)) return null;
  const lo = Math.min(...outras) - 0.03, hi = Math.max(...outras) + 0.03;
  return { ok: m9 >= lo && m9 <= hi, m9, lo, hi };
}
function le(nome) {
  if (process.env.LOCAL_DIR) return Promise.resolve(parse(fs.readFileSync(path.join(process.env.LOCAL_DIR, nome))));
  return new Promise((res, rej) => https.get('https://rbenergydata.blob.core.windows.net/dados/' + nome, { headers: { 'Accept-Encoding': 'gzip' } }, (s) => {
    if (s.statusCode !== 200) return rej(new Error(nome + ': HTTP ' + s.statusCode));
    const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => { try { res(parse(Buffer.concat(b))); } catch (e) { rej(e); } });
  }).on('error', rej));
}
function parse(buf) { return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }

(async () => {
  const D = await le('perdas_diario.json'), I = await le('perdas_inv.json');
  const dias = D.serie.filter((r) => (r.M9_n_inv || 0) > 23);
  let julgados = 0;
  for (const r of dias) {
    const j = julgaDia(r);
    if (!j) continue;
    julgados++;
    exige(j.ok, `${r.dia}: medidor/contadores do M9 ${(100 * j.m9).toFixed(1)} % fora da faixa das outras usinas `
      + `(${(100 * j.lo).toFixed(1)} a ${(100 * j.hi).toFixed(1)} %)`);
  }
  const ehCru = (r) => r.ufv === 'M9' && r.ts === 'TS1' && /^INV(1[3-9]|2[0-2])$/.test(r.inv);
  const L = I.serie.filter(ehCru);
  /* 🔴 A EFICIENCIA DO DIA NAO TEM TETO FIXO (03/10/2026). O ensaio exigia ef <= 1,02 e reprovou o M9/TS1/INV15 de 02/10
     (1,0214), dia nublado. O ef e a razao de amostras INSTANTANEAS de CA e CC, que nao sao simultaneas: passa de 100 %
     em ~1 % dos dias-inversor da frota inteira (memoria `project_eficiencia_inversor_acima_100`). Medido no perdas_inv de
     03/10: 151 de 66.507 dias de inversores de coluna NOMEADA acima de 1,02 (max 1,1449), 11 deles no proprio 02/10.
     O que um mapa errado faz e outra coisa, e e isso que se julga:
       · no DIA, o excesso tem de vir dos instantes impossiveis (CA > CC): ef - ef_imp <= 1 (nos nomeados, max 0,9911;
         no INV15 de 02/10, 0,9888);
       · na JANELA, a mediana de cada inversor cru cai na faixa das medianas dos 1.145 nomeados (0,9608 a 0,9872 em
         03/10): CA lendo o registro da CC daria 1,000 todo dia, e nenhum dia sozinho denuncia isso. */
  const efOk = (r) => r.ef >= 0.9 && r.ef - (r.ef_imp || 0) <= 1;
  const medianas = (linhas) => {
    const por = new Map();
    for (const r of linhas) if (r.e_ca > 0.1 && typeof r.ef === 'number') {
      const k = r.ufv + '/' + r.ts + '/' + r.inv; (por.get(k) || por.set(k, []).get(k)).push(r.ef); }
    return new Map([...por].map(([k, v]) => { v.sort((x, y) => x - y); return [k, v[v.length >> 1]]; }));
  };
  const fNom = [...medianas(I.serie.filter((r) => !ehCru(r))).values()];
  const faixa = { lo: Math.min(...fNom), hi: Math.max(...fNom), n: fNom.length };
  const mCru = medianas(L);
  exige(faixa.n >= 1000, `faixa da frota com ${faixa.n} inversores nomeados: pouco para julgar`);
  const medianaOk = (m) => m >= faixa.lo && m <= faixa.hi;
  for (const [k, m] of mCru) exige(medianaOk(m), `${k}: eficiencia mediana ${m} fora da faixa dos nomeados `
    + `(${faixa.lo} a ${faixa.hi})`);
  for (const r of L) {
    if (r.e_ca > 0.1) exige(efOk(r), `${r.dia} M9/TS1/${r.inv}: eficiencia ${r.ef}, ${r.ef_imp || 0} dela de instantes impossiveis`);
    if (r.p_ca_max != null) exige(r.p_ca_max <= 353.5, `${r.dia} M9/TS1/${r.inv}: pico ${r.p_ca_max} kW acima do teto`);
    if (r.str_n != null) exige(r.str_n <= 22, `${r.dia} M9/TS1/${r.inv}: ${r.str_n} strings`);
  }
  console.log(`  eficiencia: ${mCru.size} inversores crus com mediana dentro da faixa dos ${faixa.n} nomeados (${faixa.lo} a ${faixa.hi})`);
  if (!julgados) console.log('  (o produto ainda nao tem dia com o M9 completo: a parte do produto nao julgou nada — rodada anterior ao lote)');
  else console.log(`  produto: ${julgados} dia(s) com o M9 completo, medidor/contadores dentro da faixa das outras usinas · ${L.length} linhas do TS1 INV13..22`);
  // ── PLANTIO ────────────────────────────────────────────────────────────────────────────────────────
  const forjado = Object.assign({}, D.serie.find((r) => julgaDia(r)) || {}, { M9_razao_med_conta: 1.41 });
  const jf = julgaDia(forjado);
  exige(jf && !jf.ok, 'plantio: um dia com o M9 a 141 % nao reprovou — o julgamento nao mede nada');
  // o dia: o INV15 de 02/10 passa (excesso dos instantes impossiveis); 1,05 sem instante impossivel nao passa
  exige(efOk({ ef: 1.0214, ef_imp: 0.0326 }), 'plantio: o INV15 de 02/10 (1,0214, 0,0326 de instantes impossiveis) reprovou');
  exige(!efOk({ ef: 1.05, ef_imp: 0 }), 'plantio: eficiencia 1,05 sem instante impossivel passou');
  // a janela: CA lendo o registro da CC (1,000 todo dia) cai fora da faixa dos nomeados
  const espelho = medianas(L.map((r) => Object.assign({}, r, { inv: 'INV99', ef: 1 })));
  exige(espelho.size === 1 && [...espelho.values()].every((m) => !medianaOk(m)), 'plantio: um inversor com eficiencia 1,000 todo dia ficou dentro da faixa');
  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-inversor-cru: regra, produto e plantio OK');
})().catch((e) => { console.error(e); process.exit(1); });
