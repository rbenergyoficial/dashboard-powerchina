'use strict';
/*
 * ensaio-inv-logger.js — o dado de inversor das telas pelo logger Sungrow (fonte-inv-logger, 19/10/2026): lib-inv-logger.js,
 * gen-inv-logger.js e a posicao vaga do gen-sungrow (lib-sungrow-disp.posicaoPelaVaga).
 *
 *   --lib      SEM REDE, antes de gerar (sungrow.yml). Um mundo forjado com a conta escrita a mao:
 *              1 · parado, parcial e SEM LEITURA (posicao ausente ou nula nao e parada), usina-dia sem sol nao apurada (ausente, nunca 0);
 *              2 · a copia do supervisorio so nos campos do Comparativo: `_disp_pct` do supervisorio, `_inv_parados`/`_n_inv` do logger e
 *                  os do supervisorio com o sufixo `_scada`; dia depois do fim do supervisorio sem campo dele;
 *              3 · energia CC/CA so dos n_cc, Complexo so com as nove inteiras, razao medidor/contador so com o contador inteiro;
 *              4 · por inversor: grandeza fisica so do dia inteiro, nenhum campo do supervisorio, o MPPT mais fraco;
 *              5 · abaixo dos pares: a funcao do gen-inv-scada COMPILADA da fonte dele da o mesmo que a da lib (as duas copias nao
 *                  divergem caladas), e so o dia inteiro do logger entra;
 *              6 · a disponibilidade do executivo: o mensal da lib-disponibilidade sobre o mapa do logger, Complexo pela Capu;
 *              7 · a posicao vaga no mesmo logger (posicaoPelaVaga): o caso real (M9/TS1/INV16, 15 -> 16/10/2026), duas vagas, dois
 *                  novos, o dono que continua lendo, a pasta nao lida no dia, outra pasta, o dia duplicado do dono;
 *              8 · o gen-sungrow de ponta a ponta (zips forjados, sem SCADA): o novo assume a vaga e entra na disponibilidade da posicao;
 *                  o dono que volta a ler derruba a atribuicao; duas vagas deixam o novo sem posicao;
 *              9 · plantios na lib e no gerador (SCADA de volta como fonte dos parados, sem leitura contada como parado, parado do
 *                  supervisorio contado, usina sem sol publicada como zero, fisica do dia parcial, vaga sem unicidade, vaga sem a
 *                  pasta lida, dono que continua lendo, gerador sem a vaga, gerador sem a revisao): cada um TEM de reprovar.
 *   --produto  depois do gen-inv-logger, sobre o publicado (ou BASE_DADOS=<pasta>): a marca do logger; parados, parciais, lidos e sem
 *              leitura RECONTADOS aqui do sg_disp_inv_dia (contagem propria, sem a lib) em todo dia apurado; os campos do supervisorio so
 *              nos dias da copia `_scada` e iguais a ela; nenhum campo do supervisorio no perdas_inv; strings_alarme = sg_str_alarme;
 *              ranking ordenado e com a frota inteira. Nao passa por vacuidade (exige dias e usinas julgados).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const MODO = process.argv.includes('--lib') ? 'lib' : 'produto';
const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const LIB = path.join(__dirname, 'lib-inv-logger.js'), LIBP = path.join(__dirname, '_plantio_lib_inv.js');
const LIBD = path.join(__dirname, 'lib-sungrow-disp.js'), LIBDP = path.join(__dirname, '_plantio_lib_vaga.js');
const GEN = path.join(__dirname, 'gen-sungrow.js'), GENP = path.join(__dirname, '_plantio_gen_vaga.js');
process.on('exit', () => { for (const f of [LIBP, LIBDP, GENP, path.join(__dirname, '_plantio_perdas_nome.js')]) if (fs.existsSync(f)) fs.unlinkSync(f); });
const { PLACA } = require('./lib-placa.js');
const { CAPU } = require('./lib-sungrow-disp.js');
const U9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const D1 = '2026-10-15', D2 = '2026-10-16';

/* ================================================================ --lib ======================================================= */
/* o mundo forjado. M9: 33 de placa. D1: INV02 a 80 % (parcial), INV03 a 40 % (parado), INV04 fora do blob (sem leitura), o resto 100.
   D2: INV02 nulo (sem leitura), INV03 100. M1 sem nenhuma meia hora de sol medida nos dois dias (nao apurado). M2 e M7 com 99 e 100 */
function mundo() {
  const inv = {};
  for (let k = 1; k <= 22; k++) { const p = 'M9/TS1/INV' + String(k).padStart(2, '0'); if (k !== 4) inv[p] = { d: [100, 100], m: [22, 22] }; }
  for (let k = 1; k <= 11; k++) inv['M9/TS2/INV' + String(k).padStart(2, '0')] = { d: [100, 100], m: [22, 22] };
  inv['M9/TS1/INV02'] = { d: [80, null], m: [22, 0] };
  inv['M9/TS1/INV03'] = { d: [40, 100], m: [22, 22] };
  inv['M1/TS1/INV01'] = { d: [null, null], m: [0, 0] };
  const sgDispInv = { dias: [D1, D2], inv };
  const linhaDisp = (dia) => { const r = { dia }; for (const u of U9) { r[u + '_meias_sol'] = u === 'M1' ? 0 : 22; r[u + '_disp_sol_pct'] = null; }
    r.M2_disp_sol_pct = 99; r.M7_disp_sol_pct = 100; r.M9_disp_sol_pct = 99.5; return r; };
  const sgDisp = { serie: [linhaDisp(D1), linhaDisp(D2)] };
  // a cascata: D1 as nove inteiras (n_cc = placa), D2 o M1 com um a menos
  const usina_dia = [];
  for (const d of [D1, D2]) for (const u of U9) usina_dia.push({ d, ufv: u, n_cc: d === D2 && u === 'M1' ? PLACA.M1.inversores - 1 : PLACA[u].inversores,
    ecc: u === 'M9' ? 100 : 400, eca: u === 'M9' ? 98 : 392 });
  const sgSaude = { usina_dia };
  // o contador: M9 em D1 os 33 inteiros a 1.000 kWh; em D2 o INV05 parcial (fora do contador). As outras usinas sem linha
  const saudePorUsina = { M9: { serie: [] } };
  for (const p of Object.keys(inv).filter((p) => p.startsWith('M9/')).concat(['M9/TS1/INV04'])) {
    const [, ts, iv] = p.split('/');
    for (const d of [D1, D2]) {
      const parc = d === D2 && iv === 'INV05' && ts === 'TS1';
      saudePorUsina.M9.serie.push({ d, ts, inv: iv, p: parc ? 1 : 0, e: 1000, tm: 60, iso: 500, ecc: 1020, eca: 1000, smin: 90, smax: 105, sn: 22, smo: 0, sw: 7 });
    }
  }
  const invDiaPorUsina = { M9: { serie: saudePorUsina.M9.serie.map((r) => ({ d: r.d, ts: r.ts, inv: r.inv, p_max: 330, n: 288 })) } };
  const mpptPorEtc = { M9_TS1: { serie: [{ d: D1, inv: 'INV01', i: [1, 0.95, 0.7, null, 1.02, 1, 1, 1, 1, 1, 1, null] }] } };
  // o medidor: w9 = 32,4 MWh em D1; o liquido completo do dia
  const cmp = { serie: [{ t: D1 + 'T00:00:00-03:00', w1: 390, w2: 390, w3: 390, w4: 390, w5: 390, w6: 390, w7: 390, w8: 390, w9: 32.4 },
    { t: D2 + 'T00:00:00-03:00', w9: 31.5 }] };   // D2: medidor presente e contador com um a menos (a razao NAO pode sair)
  const w2d = { dias: [{ dia: D1, completo: true, ene_ger_mwh: 3152.4, ene_liq_mwh: 3130, ufv_liq_mwh: { M9: 32.0, M1: 385 } }] };
  // a copia do supervisorio so em D1 (o export parou antes de D2)
  const scada = { serie: [{ dia: D1, M9_disp_pct: 99.5, M9_disp_contrato_pct: 99.1, M9_inv_parados: 5, M9_inv_parciais: 2, M9_n_inv: 33, M9_despacho_pct: 140,
    CX_disp_pct: 99.6, CX_disp_contrato_pct: 99.2, janela_contrato_h: 10.5, janela_h: 12.4 }] };
  return { sgDispInv, sgDisp, sgSaude, saudePorUsina, invDiaPorUsina, mpptPorEtc, cmp, w2d, scada };
}

function casosLib(L) {
  const R = {};
  const W = mundo();
  const C = L.classifica(W.sgDispInv);
  const c1 = C.get(D1).M9, c2 = C.get(D2).M9;
  R.okClassifica = c1.lidas === 32 && c1.parados === 1 && c1.parciais === 1 && c1.sem_leitura === 1 && c2.lidas === 31 && c2.parados === 0
    && c2.parciais === 0 && c2.sem_leitura === 2 && C.get(D1).M1.lidas === 0;
  const S = L.diario(W);
  const s1 = S.find((o) => o.dia === D1) || {}, s2 = S.find((o) => o.dia === D2) || {};
  R.okSemSol = !('M1_n_inv' in s1) && !('M1_inv_parados' in s1) && !('M1_cob_pct' in s1);
  R.okDiario = s1.M9_n_inv === 32 && s1.M9_inv_parados === 1 && s1.M9_inv_parciais === 1 && s1.M9_inv_sem_leitura === 1 && s1.M9_n_placa === 33
    && s1.M9_cob_pct === 96.97 && s2.M9_n_inv === 31 && s2.M9_inv_sem_leitura === 2 && s1.janela_h === 11
    && s1.ms === Date.parse(D1 + 'T00:00:00-03:00') && s2.ms === Date.parse(D2 + 'T00:00:00-03:00');
  const CB = L.cobertura(S);
  R.okCobertura = !!CB.M9 && CB.M9.dia === D2 && CB.M9.n_inversores === 31 && CB.M9.inversores_ausentes === 2 && CB.M9.completa === false && !CB.M1;
  R.okScada = s1.M9_disp_pct === 99.5 && s1.M9_disp_contrato_pct === 99.1 && s1.M9_despacho_pct === 140 && s1.CX_disp_pct === 99.6
    && s1.M9_inv_parados_scada === 5 && s1.M9_inv_parciais_scada === 2 && s1.M9_n_inv_scada === 33 && s1.janela_scada_h === 12.4
    && !('M9_disp_pct' in s2) && !('CX_disp_pct' in s2) && !('M9_inv_parados_scada' in s2);
  R.okEnergia = s1.M9_e_cc === 100 && s1.M9_e_ca === 98 && s1.M9_n_cc === 33 && s1.M9_perda_conv_pct === 2 && s1.Complexo_e_cc === 3300
    && s1.Complexo_e_ca === 3234 && !('Complexo_e_cc' in s2) && s2.M1_n_cc === 164
    && s1.M9_e_conta === 33 && s1.M9_n_conta === 33 && s1.M9_e_med === 32.4 && s1.M9_razao_med_conta === 0.9818
    && s2.M9_n_conta === 32 && s2.M9_e_med === 31.5 && !('M9_razao_med_conta' in s2) && s1.M9_e_liq === 32 && s1.M9_consumo_mwh === 0.4 && !('Complexo_e_conta' in s1);
  const I = L.porInversor(W, 60);
  const i1 = I.find((l) => l.dia === D1 && l.ts === 'TS1' && l.inv === 'INV01') || {}, ip = I.find((l) => l.dia === D2 && l.ts === 'TS1' && l.inv === 'INV05') || {};
  const iSem = I.find((l) => l.dia === D1 && l.ts === 'TS1' && l.inv === 'INV04') || {};
  const SO_SCADA = ['horas', 'lidos', 'gerando', 'jan_slots', 'setpoint_min', 'setpoint_ger', 'nominal', 'ef_imp'];
  R.okInv = i1.e_cc === 1.02 && i1.e_ca === 1 && i1.ef === 0.9804 && i1.p_ca_max === 330 && i1.temp_max === 60 && i1.isol_min === 500
    && i1.str_min_pct === 90 && i1.mppt_min_pct === 70 && i1.mppt_n === 10 && i1.mppt_min_n === 3 && i1.disp_pct === 100
    && ip.parcial === 1 && ip.e_cc === null && ip.ef === null && ip.temp_max === null && ip.str_min_pct === null && ip.p_ca_max === null && ip.disp_pct === 100
    && iSem.disp_pct === null && I.every((l) => SO_SCADA.every((c) => !(c in l)));
  // o executivo: Complexo = media das usinas pela Capu, no dia, e o mes = media dos dias
  const DS = require('./lib-disponibilidade.js');
  const acc = DS.mensal(L.porDiaExecutivo(W.sgDisp), { Complexo: U9, PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] });
  const esp = (CAPU.M2 * 99 + CAPU.M7 * 100 + CAPU.M9 * 99.5) / (CAPU.M2 + CAPU.M7 + CAPU.M9);
  const espML = (CAPU.M7 * 100 + CAPU.M9 * 99.5) / (CAPU.M7 + CAPU.M9);
  const m = D1.slice(0, 7);
  R.okExecutivo = !!acc['Complexo|' + m] && Math.abs(acc['Complexo|' + m].disp_pct - Math.round(esp * 100) / 100) < 1e-9 && acc['Complexo|' + m].dias === 2
    && Math.abs(acc['ML|' + m].disp_pct - Math.round(espML * 100) / 100) < 1e-9 && acc['PPA|' + m].disp_pct === 99 && !acc['M1|' + m];
  // abaixo dos pares: so o dia inteiro do logger
  const frota = { dias: [D1, D2], inv: {} };
  for (let k = 1; k <= 6; k++) frota.inv['M9/TS1/INV0' + k] = { e: [1000, k === 1 ? 500 : 1000], p: k === 2 ? '10' : k === 3 ? '0-' : '00' };
  const LP = L.linhasPares(frota);
  R.okPares = LP.length === 10 && !LP.some((l) => l.inv === 'INV02' && l.dia === D1) && !LP.some((l) => l.inv === 'INV03' && l.dia === D2)
    && (LP.find((l) => l.inv === 'INV01' && l.dia === D2) || {}).razao === 0.5;
  /* o ranking: 11 dias inteiros, seis inversores no TS1 (o INV01 a 900 kWh, os outros a 1.000) e o INV07 so em 2 dias (menos que
     MIN_DIAS: fica fora). Mediana da frota 1 (os dois do meio de [0,9 1 1 1 1 1]); afastamentos [0,1 0 0 0 0 0], mediana 0, entao a
     escala e a MEDIA, 0,1/6; desvio robusto 1,4826 x 0,016667 = 0,02471; o INV01 a (0,9 - 1)/0,02471 = -4,05 desvios */
  const dias11 = Array.from({ length: 11 }, (_, k) => '2026-09-' + String(10 + k).padStart(2, '0'));
  const fr = { dias: dias11, inv: {} };
  for (let k = 1; k <= 6; k++) fr.inv['M9/TS1/INV0' + k] = { e: dias11.map(() => (k === 1 ? 900 : 1000)), p: '0'.repeat(11) };
  fr.inv['M9/TS1/INV07'] = { e: dias11.map((d, i) => (i < 2 ? 1000 : null)), p: '00' + '-'.repeat(9) };
  const RK = L.ranking(fr, 'agora');
  const r0 = RK.ranking[0] || {};
  R.okRanking = RK.inversores.length === 6 && !RK.inversores.some((x) => x.inv === 'INV07') && r0.chave === 'M9/TS1/INV01' && r0.razao_mediana === 0.9
    && r0.razao_min === 0.9 && r0.dias === 11 && r0.desvios === -4.05 && RK.escopo.referencia.mediana === 1 && RK.escopo.referencia.fora_3_desvios === 1
    && RK.ranking.every((x, i) => !i || RK.ranking[i - 1].razao_mediana <= x.razao_mediana) && RK.escopo.de === dias11[0] && RK.escopo.ate === dias11[10];
  const al = L.alarmes({ serie: [{ ufv: 'M9', str: 3 }], resumo: [{ ufv: 'M9' }], regra: { morta: 'x' }, ate: D2 }, 'agora');
  R.okAlarme = al.serie.length === 1 && al.resumo.length === 1 && al.criterio.morta === 'x' && al.origem_inversor === 'logger' && al.ate === D2;
  return R;
}

/* a funcao do gen-inv-scada, compilada da fonte dele (a regra de quem sobe), contra a da lib, num sorteio deterministico */
function paresIguais(L) {
  const src = fs.readFileSync(path.join(__dirname, 'gen-inv-scada.js'), 'utf8').replace(/\r\n/g, '\n');
  const i = src.indexOf('function comparaComPares('), fim = src.indexOf('\n}\n', i);
  const mp = Number((src.match(/const MIN_PARES = (\d+);/) || [])[1]);
  if (i < 0 || fim < 0 || !mp) return { ok: false, txt: 'nao achei comparaComPares ou MIN_PARES no gen-inv-scada' };
  const mediana = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
  // eslint-disable-next-line no-new-func
  const scada = new Function('MIN_PARES', 'mediana', 'r2', src.slice(i, fim + 3) + '; return comparaComPares;')(mp, mediana, r2);
  let semente = 7; const rnd = () => { semente = (semente * 16807) % 2147483647; return semente / 2147483647; };
  let casos = 0, dif = 0;
  for (let t = 0; t < 200; t++) {
    const inversores = [];
    const nts = 1 + Math.floor(rnd() * 3);
    for (let s = 1; s <= nts; s++) { const n = 1 + Math.floor(rnd() * 9); for (let k = 1; k <= n; k++) inversores.push({ ts: 'TS' + s, inv: 'INV' + k, kwh: rnd() < 0.1 ? 0 : Math.round(rnd() * 3000 * 10) / 10 }); }
    const a = scada({ inversores }).map((x) => [x.ts, x.inv, x.kwh, x.razao, x.base, x.pares].join()), b = L.comparaComPares({ inversores }).map((x) => [x.ts, x.inv, x.kwh, x.razao, x.base, x.pares].join());
    casos += a.length; if (a.join('|') !== b.join('|')) dif++;
  }
  return { ok: dif === 0 && L.MIN_PARES === mp && casos > 500, txt: casos + ' inversores em 200 sorteios, ' + dif + ' sorteio(s) diferentes; MIN_PARES ' + mp + '/' + L.MIN_PARES };
}

/* 7 · a posicao vaga: H.inv forjado. M9 pasta TS1: A (INV16) le D1..D2-1, N comeca no dia seguinte; B (INV17) le todos os dias */
const dd = (de, n) => Array.from({ length: n }, (_, k) => new Date(Date.parse(de + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10));
const serie = (dias, vida0) => Object.fromEntries(dias.map((d, k) => [d, { d, vida: vida0 + k * 2000, e: 2000 }]));
function casosVaga(D) {
  const R = {};
  const base = () => ({ A: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 6), 450000) },          // ate 15/10
    B: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 9), 300000) },                                // ate 18/10
    N: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-16', 3), 1277.5) } });                           // 16 a 18/10
  const id = () => ({ A: { pos: 'M9/TS1/INV16' }, B: { pos: 'M9/TS1/INV17' } });
  const dup = (H) => (n, o, d) => D.dupContador(H[n].dias, H[o].dias, d);
  { const H = base(), V = D.posicaoPelaVaga(H, id(), dup(H));
    R.okVagaReal = !!V.atribui.N && V.atribui.N.pos === 'M9/TS1/INV16' && V.atribui.N.d === '2026-10-16' && V.atribui.N.dono === 'A' && !V.ambiguos.length; }
  { const H = base(); H.C = { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 6), 600000) };          // C (INV18) tambem parou em 15/10
    const I = id(); I.C = { pos: 'M9/TS1/INV18' }; const V = D.posicaoPelaVaga(H, I, dup(H));
    R.okDuasVagas = !V.atribui.N && V.ambiguos.length === 1 && V.ambiguos[0].sn === 'N' && V.ambiguos[0].vagas.join() === 'M9/TS1/INV16,M9/TS1/INV18'; }
  { const H = base(); H.N2 = { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-17', 2), 900) };           // dois novos para a mesma vaga
    const V = D.posicaoPelaVaga(H, id(), dup(H));
    R.okDoisNovos = !V.atribui.N && !V.atribui.N2 && V.ambiguos.length === 1 && V.ambiguos[0].pos === 'M9/TS1/INV16'; }
  { const H = base(); H.A.dias = serie(dd('2026-10-10', 9), 450000);                                       // o dono continua lendo
    const V = D.posicaoPelaVaga(H, id(), dup(H));   // nem atribuicao nem ambiguidade: nenhuma das duas posicoes e vaga
    R.okDonoLe = !Object.keys(V.atribui).length && !V.ambiguos.length; }
  { const H = base(); H.B.pasta = 'TS2';                                                                    // no dia 16 a pasta TS1 so tem o novo
    R.okPastaLida = !Object.keys(D.posicaoPelaVaga(H, id(), dup(H)).atribui).length; }
  { const H = base(); H.N.pasta = 'TS2';                                                                    // o novo noutra pasta
    R.okOutraPasta = !Object.keys(D.posicaoPelaVaga(H, id(), dup(H)).atribui).length; }
  { const H = base(); H.N.dias = serie(dd('2026-10-14', 5), 0);                                             // N em 14 e 15/10 = duplicado de A
    H.N.dias['2026-10-14'] = { ...H.A.dias['2026-10-14'] }; H.N.dias['2026-10-15'] = { ...H.A.dias['2026-10-15'] };
    H.N.dias['2026-10-16'].vida = 1277.5; H.N.dias['2026-10-17'].vida = 3277.5; H.N.dias['2026-10-18'].vida = 5277.5;
    const V = D.posicaoPelaVaga(H, id(), dup(H));
    R.okDupDono = !!V.atribui.N && V.atribui.N.d === '2026-10-16'; }
  { const H = base(); H.X = { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-08-20', 10), 100) };          // a INV17 ja teve troca: X ate 29/08,
    const I = id(); I.X = { pos: 'M9/TS1/INV17' }; H.A.dias = serie(dd('2026-10-10', 9), 450000);           // B a ocupa e le; A continua lendo
    const V = D.posicaoPelaVaga(H, I, dup(H));   // o dono da INV17 e o B (ultimo dia mais recente), nao o retirado X
    R.okDonoAtual = !Object.keys(V.atribui).length && !V.ambiguos.length; }
  { const H = base(); H.N.ufv = 'M1';                                                                      // o novo noutra usina, mesma pasta
    R.okOutraUsina = !Object.keys(D.posicaoPelaVaga(H, id(), dup(H)).atribui).length; }
  return R;
}

/* 7c · a troca pela planilha de substituicoes (sg-troca-planilha, 30/10/2026): M9 pasta TS1, A (INV16) e C (INV18) param em 15/10, B (INV17)
   segue lendo, N chega em 16/10. Duas vagas: a regra da vaga nao decide, a planilha diz que N entrou no lugar de C (INV18) */
function casosPlanilha(D) {
  const R = {};
  const base = () => ({ A: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 6), 450000) }, B: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 9), 300000) },
    C: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-10', 6), 600000) }, N: { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-16', 3), 1277.5) } });
  const id = () => ({ A: { pos: 'M9/TS1/INV16' }, B: { pos: 'M9/TS1/INV17' }, C: { pos: 'M9/TS1/INV18' } });
  const troca = (o) => [Object.assign({ pos: 'M9/TS1/INV18', d: '2026-10-16', retirado: 'C', instalado: 'N' }, o || {})];
  const dup = (H) => (n, o, d) => D.dupContador(H[n].dias, H[o].dias, d);
  const P = (H, I, T) => D.posicaoPelaPlanilha(H, I, T, dup(H));
  const nada = (V) => !Object.keys(V.atribui).length && V.recusados.length === 1 && V.recusados[0].sn === 'N';
  { const H = base(), V = P(H, id(), troca());
    R.okPlanilha = !!V.atribui.N && V.atribui.N.pos === 'M9/TS1/INV18' && V.atribui.N.d === '2026-10-16' && V.atribui.N.dono === 'C'
      && V.atribui.N.metodo === D.METODO_PLANILHA && !V.recusados.length && D.posicaoPelaVaga(H, id(), dup(H)).ambiguos.length === 1; }
  { const H = base(); R.okRetirado = nada(P(H, id(), troca({ retirado: 'A' }))); }                 // a planilha poe N na INV18 com A, que ocupa a INV16
  { const H = base(); H.N.ufv = 'M1'; R.okUsinaP = nada(P(H, id(), troca())); }
  { const H = base(); H.N.pasta = 'TS2'; R.okPastaP = nada(P(H, id(), troca())); }
  { const H = base(); H.C.dias = serie(dd('2026-10-10', 9), 600000); R.okDonoLeP = nada(P(H, id(), troca())); }
  { const H = base(); R.okAntes = nada(P(H, id(), troca({ d: '2026-10-17' }))); }                 // lido em 16/10, a planilha diz troca em 17/10
  { const H = base(); R.okDuasPos = nada(P(H, id(), [...troca(), ...troca({ pos: 'M9/TS1/INV16', retirado: 'A' })])); }
  { const H = base(); H.N2 = { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-16', 3), 900) };
    const V = P(H, id(), [...troca(), ...troca({ instalado: 'N2' })]);
    R.okDoisNaPos = !Object.keys(V.atribui).length && V.recusados.map((x) => x.sn).sort().join() === 'N,N2'; }
  { const H = base(), I = id(); I.X = { pos: 'M9/TS1/INV18' }; H.X = { ufv: 'M9', pasta: 'TS1', dias: serie(dd('2026-10-16', 3), 5000) };
    R.okOcupada = nada(P(H, I, troca())); }                                                         // outro numero de serie ja le na INV18
  { const H = base(), I = id(); I.N = { pos: 'M9/TS1/INV16' }; const V = P(H, I, troca());
    R.okJaTem = !Object.keys(V.atribui).length && !V.recusados.length; }
  // a leitura da aba: titulo antes do cabecalho, colunas pelo nome, INV3/TS08/minuscula, data serial do Excel e texto, linha sem instalado fora
  const xl = (d) => Date.parse(d + 'T00:00:00Z') / 864e5 + 25569;
  const M = [['CONTROLE DE FALHAS DE INVERSORES'], [], ['ITEM', 'SPV', 'TS', 'INV', 'CÓDIGO DE FALHA / FAULT CODE', 'DATA / DATE', 'SN', 'DATA DA SUBSTITUIÇÃO / REPLACEMENT DATE', 'MARKUP'],
    [205, 'M4', 'TS8', 'INV3', 64, xl('2026-10-27'), 'A2352739491', xl('2026-10-27'), 'a2621103121 '],
    [204, 'M4', 'TS08', 'INV05', 64, xl('2026-10-27'), 'A23B1707251', '27/10/2026', 'A2471700986'],
    [100, 'M2', 'TS1', 'INV11', 64, xl('2026-05-02'), 'A0000000001', xl('2026-05-02'), null]];
  let T = null; try { T = D.trocasDaPlanilha(M); } catch (e) { T = null; }
  R.okLeitura = !!T && JSON.stringify(T) === JSON.stringify([{ pos: 'M4/TS8/INV03', d: '2026-10-27', retirado: 'A2352739491', instalado: 'A2621103121' },
    { pos: 'M4/TS8/INV05', d: '2026-10-27', retirado: 'A23B1707251', instalado: 'A2471700986' }]);
  let estourou = false; try { D.trocasDaPlanilha(M.map((r) => r.filter((c) => c !== 'MARKUP'))); } catch (e) { estourou = true; }
  R.okSemMarkup = estourou;
  return R;
}

/* 7b · a copia do supervisorio (L.copiaScada) com o transporte forjado: existe; semeia; aborta com o antigo do logger; aborta com a copia
   contaminada; nada a semear. E o gen-perdas grava os tres nomes do supervisorio com o sufixo (PUBLICA, lida da fonte dele) */
async function casosCopia(L) {
  const R = {};
  const io = (blobs) => ({ existe: async (n) => n in blobs, le: async (n) => (n in blobs ? JSON.parse(JSON.stringify(blobs[n])) : null), log: () => {} });
  const tenta = async (f) => { try { return { r: await f() }; } catch (e) { return { e: e.message }; } };
  const a = await tenta(() => L.copiaScada(io({ 'perdas_diario_scada.json': { serie: [1] }, 'perdas_diario.json': { serie: [2] } }), 'perdas_diario_scada.json', 'perdas_diario.json', true));
  const b = await tenta(() => L.copiaScada(io({ 'perdas_diario.json': { serie: [2] } }), 'perdas_diario_scada.json', 'perdas_diario.json', true));
  const c = await tenta(() => L.copiaScada(io({ 'perdas_inv.json': { origem_inversor: 'logger', serie: [3] } }), 'perdas_inv_scada.json', 'perdas_inv.json', false));
  const d = await tenta(() => L.copiaScada(io({ 'perdas_diario_scada.json': { origem_inversor: 'logger', serie: [4] } }), 'perdas_diario_scada.json', 'perdas_diario.json', true));
  const e = await tenta(() => L.copiaScada(io({}), 'strings_alarme_scada.json', 'strings_alarme.json', false));
  const f = await tenta(() => L.copiaScada(io({ 'perdas_inv_scada.json': {} }), 'perdas_inv_scada.json', 'perdas_inv.json', false));
  R.okCopia = !!a.r && a.r.semeada === false && a.r.j.serie[0] === 1 && !!b.r && b.r.semeada === true && b.r.j.serie[0] === 2
    && !!c.e && /copia do supervisorio se perdeu/.test(c.e) && !!d.e && /contaminada/.test(d.e) && !!e.r && e.r.j === null && e.r.semeada === false
    && !!f.r && f.r.semeada === false && L.SEMENTES.map((x) => x[0]).join() === 'perdas_diario_scada.json,perdas_inv_scada.json,strings_alarme_scada.json';
  return R;
}
function publicaPerdas(fonte) {
  const src = fs.readFileSync(fonte || path.join(__dirname, 'gen-perdas.js'), 'utf8').replace(/\r\n/g, '\n');
  const m = src.match(/const PUBLICA = (\{[\s\S]*?\});/);
  if (!m) return { ok: false, txt: 'sem PUBLICA no gen-perdas' };
  // eslint-disable-next-line no-new-func
  const P = new Function('return ' + m[1])();
  const usa = /async function grava\(nomeLogico, obj\) \{\n  const nome = fisico\(nomeLogico\);/.test(src) && /puxa\(base \+ fisico\(nome\)\)/.test(src);
  const ok = P['perdas_diario.json'] === 'perdas_diario_scada.json' && P['perdas_inv.json'] === 'perdas_inv_scada.json' && P['strings_alarme.json'] === 'strings_alarme_scada.json' && usa;
  return { ok, txt: JSON.stringify(P) + (usa ? '' : ' · o grava/leAnterior nao usa o nome fisico') };
}

/* 8 · o gen-sungrow de ponta a ponta, sem SCADA: zips forjados (o CSV como o logger grava) */
function crc32(b) { let c; const t = crc32.t || (crc32.t = Array.from({ length: 256 }, (x, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let x = 0xFFFFFFFF; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; }
function zip(arqs) {
  const loc = [], cen = []; let off = 0;
  for (const a of arqs) {
    const nome = Buffer.from(a.nome), dados = Buffer.from(a.dados), comp = zlib.deflateRawSync(dados);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(dados), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(nome.length, 26);
    loc.push(h, nome, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(dados), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nome); off += 30 + nome.length + comp.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(arqs.length, 8); e.writeUInt16LE(arqs.length, 10);
  e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cb, e]);
}
const REAL36 = ['Horário', 'Potência ativa nominal', 'Potência reativa nominal', 'Modo de potência limitada', 'Tipo de saída',
  'Geração de energia ao longo do dia', 'Geração total', 'Tensão da linha AB', 'Tensão da linha BC', 'Tensão de linha CA',
  'Tempo de execução total conectado a rede', 'Temperatura de ar interna', 'Potência aparente total', 'Potência CC total',
  'Potência ativa total', 'Potência reativa total', 'Potência aparente total', 'Potência CC total', 'Potência ativa total',
  'Potência reativa total', 'Fator de potência total', '电网线电压AB', '电网线电压BC', '电网线电压CA', 'Corrente da fase A',
  'Corrente da fase B', 'Corrente da fase C', '新协议电网频率', 'Status do dispositivo', 'Status de operação do inversor_Xinjiang',
  'Status de operação do inversor_Ningxia', 'Status de operação do inversor', 'Código de falha', 'Impedância paralela em relação à terra',
  'Status', 'Tempo de operação diário'];
const CAB = [...REAL36, 'Eficiência do inversor', 'Estado de trabalho PID', 'Código de falha PID', 'Tensão do barramento',
  'Tensão de pólo negativo / terra', ...Array.from({ length: 12 }, (_, k) => 'Tensão MPPT' + (k + 1)), ...Array.from({ length: 12 }, (_, k) => 'Corrente MPPT' + (k + 1)),
  ...Array.from({ length: 24 }, (_, k) => 'Corrente na string ' + (k + 1))];
const hhmm = (i) => String(Math.floor(i / 12)).padStart(2, '0') + ':' + String((i % 12) * 5).padStart(2, '0');
function csvDia(d, vida) {      /* um dia inteiro disponivel (estado 0x0), o contador de vida constante */
  const L = []; for (let i = 0; i < 288; i++) L.push(CAB.map((n) => (n === 'Horário' ? d + ' ' + hhmm(i) + ':00' : n === 'Potência ativa nominal' ? ' 3200'
    : n === 'Geração total' ? ' ' + vida : ' 0')).join(','));
  return L;
}
const csvSn = (dias, vida) => '﻿' + CAB.join(',') + '\n' + dias.flatMap((d) => csvDia(d, vida)).join('\n') + '\n';
const arq = (sn, dias, vida) => ({ nome: 'hiscsv/HIS_' + sn + '_' + dias[0].replace(/-/g, '') + '0000_' + dias[dias.length - 1].replace(/-/g, '') + '2355.csv', dados: csvSn(dias, vida) });
const T = dd('2026-10-13', 4);                  // 13 a 16/10: Z le 13 e 14, W chega em 15
const ZV = 'A0000000801', QV = 'A0000000802', RV = 'A0000000803', WV = 'A0000000809';
function cenarioVaga(gen, variante) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'invlog-'));
  const R = {};
  try {
    const RAW = path.join(raiz, 'raw'), OUT = path.join(raiz, 'out'), SC = path.join(raiz, 'sc'), pasta = path.join(RAW, 'M10', 'TS01', '01 A 05');
    for (const d of [pasta, OUT, SC]) fs.mkdirSync(d, { recursive: true });
    const zs = [arq(QV, T, 300000), arq(ZV, variante === 'dono_volta' ? T : T.slice(0, 2), 450000), arq(WV, T.slice(2), 1000)];
    zs.push(arq(RV, variante === 'duas' || variante === 'planilha' ? T.slice(0, 2) : T, 600000));
    fs.writeFileSync(path.join(pasta, 'lote.zip'), zip(zs));
    const g = (n, o) => fs.writeFileSync(path.join(OUT, n), zlib.gzipSync(JSON.stringify(o)));
    g('sg_ident.json', { esquema: 2, ident: { [ZV]: { pos: 'M1/TS1/INV01', d: T[0], metodo: 'ensaio' }, [QV]: { pos: 'M1/TS1/INV02', d: T[0], metodo: 'ensaio' },
      [RV]: { pos: 'M1/TS1/INV03', d: T[0], metodo: 'ensaio' } }, busca: {}, sem_posicao: [] });
    g('estacao_logger_30min.json', { serie: T.flatMap((d) => Array.from({ length: 48 }, (_, k) => { const t = d + 'T' + String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00') + ':00-03:00';
      return { t, ms: Date.parse(t), e1: k >= 14 && k <= 34 ? 600 : 0 }; })) });
    fs.writeFileSync(path.join(raiz, 'inv_scada_hist.json'), JSON.stringify({ serie: [] }));
    const env = Object.assign({}, process.env, { LOCAL_RAW_DIR: RAW, LOCAL_SCADA_DIR: SC, LOCAL_OUT_DIR: OUT, LOCAL_INV_SCADA: path.join(raiz, 'inv_scada_hist.json') });
    delete env.LOCAL_RAW_LISTA; delete env.REFAZER; delete env.LOCAL_PLANILHA_INV;
    if (variante === 'planilha') {   // sg-troca-planilha: duas vagas (INV01 e INV03 param em 14/10) e a planilha diz que W entrou no lugar de R (INV03)
      const XLSX = require('xlsx'), wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CONTROLE'], ['ITEM', 'SPV', 'TS', 'INV', 'SN', 'DATA DA SUBSTITUIÇÃO / REPLACEMENT DATE', 'MARKUP'],
        [1, 'M1', 'TS1', 'INV3', RV, T[2], WV]]), 'Inverter Failure Control');
      env.LOCAL_PLANILHA_INV = path.join(raiz, 'planilha.xlsx'); XLSX.writeFile(wb, env.LOCAL_PLANILHA_INV);
    }
    const le = (n) => (fs.existsSync(path.join(OUT, n)) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(OUT, n))).toString('utf8')) : null);
    const roda = () => { try { return execFileSync('node', [gen], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { R.erro = String(e.stderr || e.message).split('\n').filter(Boolean).slice(-2).join(' | '); return null; } };
    if (variante === 'revisao') {
      // 1a rodada: a vaga e atribuida; 2a: o dono volta a ler (um zip novo com Z em 15 e 16/10) e a atribuicao cai
      if (roda() == null) return R;
      const I1 = le('sg_ident.json');
      fs.writeFileSync(path.join(pasta, 'volta.zip'), zip([arq(ZV, T.slice(2), 450000)]));
      if (roda() == null) return R;
      const I2 = le('sg_ident.json');
      R.okRevisao = !!I1.ident[WV] && I1.ident[WV].pos === 'M1/TS1/INV01' && !I2.ident[WV] && I2.sem_posicao.some((x) => x.sn === WV);
      R.txt = 'antes ' + JSON.stringify(I1.ident[WV] || null) + ' depois ' + JSON.stringify(I2.ident[WV] || null);
      return R;
    }
    if (roda() == null) return R;
    const I = le('sg_ident.json'), PI = le('sg_disp_inv_dia.json') || { dias: [], inv: {} };
    const p = PI.inv[variante === 'planilha' ? 'M1/TS1/INV03' : 'M1/TS1/INV01'] || { d: [], m: [] };
    const m = T.map((d) => { const i = PI.dias.indexOf(d); return i >= 0 ? p.m[i] : null; });
    R.ident = I.ident[WV] || null; R.semPos = I.sem_posicao.map((x) => x.sn); R.m = m;
    R.txt = 'W ' + JSON.stringify(R.ident) + ' · sem posicao ' + JSON.stringify(R.semPos) + ' · meias de sol de ' + (variante === 'planilha' ? 'M1/TS1/INV03 ' : 'M1/TS1/INV01 ') + JSON.stringify(m);
    return R;
  } finally { fs.rmSync(raiz, { recursive: true, force: true }); }
}
const vagaOk = (R) => !R.erro && !!R.ident && R.ident.pos === 'M1/TS1/INV01' && R.ident.d === T[2] && R.ident.metodo === 'posicao vaga no mesmo logger'
  && !R.semPos.includes(WV) && R.m.every((x) => x === 21);
const vagaDuasOk = (R) => !R.erro && !R.ident && R.semPos.includes(WV) && R.m[2] === 0 && R.m[3] === 0;
const planilhaOk = (R) => !R.erro && !!R.ident && R.ident.pos === 'M1/TS1/INV03' && R.ident.d === T[2] && R.ident.metodo === 'planilha de substituicoes'
  && !R.semPos.includes(WV) && R.m[2] === 21 && R.m[3] === 21;

function planta(fonte, destino, nome, trocas, julga) {
  let s = fs.readFileSync(fonte, 'utf8').replace(/\r\n/g, '\n');
  for (const [de, para] of trocas) { if (s.split(de).length !== 2) { ok(false, 'plantio "' + nome + '": trecho nao casou'); return; } s = s.split(de).join(para); }
  try { fs.writeFileSync(destino, s); delete require.cache[require.resolve(destino)]; ok(julga(destino) === false, 'plantio "' + nome + '" reprova'); }
  catch (e) { ok(false, 'plantio "' + nome + '" estourou: ' + e.message); }
  finally { if (fs.existsSync(destino)) fs.unlinkSync(destino); delete require.cache[destino]; }
}

/* 20/10/2026: o diario termina no ultimo dia classificado; um dia sem sol no MEIO fica */
function caudaOk(L) {
  const U = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
  const disp = (dia, m) => { const o = { dia }; for (const u of U) o[u + '_meias_sol'] = m; return o; };
  const dias0 = ['2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
  const inv = {}; for (const u of U) inv[u + '/TS1/INV01'] = { d: [100, 100, 100, null, null] };
  let s; try { s = L.diario({ sgDisp: { serie: [disp(dias0[0], 23), disp(dias0[1], 0), disp(dias0[2], 23), disp(dias0[3], 0), disp(dias0[4], 0)] }, sgDispInv: { dias: dias0, inv } }); }
  catch (e) { return false; }
  const dias = s.map((o) => o.dia);
  return dias[dias.length - 1] === '2026-10-18' && dias.includes('2026-10-17') && !dias.includes('2026-10-19');
}

/* 20/10/2026: a coleta da madrugada cria as linhas de D-1 e D sem sol (meias_sol 0) antes de a estacao chegar */
function ultimoJulgadoOk(L) {
  const z = (dia, m) => { const o = { dia }; for (const u of ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']) o[u + '_meias_sol'] = m; return o; };
  const a = L.ultimoDiaJulgado({ serie: [z('2026-10-17', 23), z('2026-10-18', 23), z('2026-10-19', 0), z('2026-10-20', 0)] });
  const b = L.ultimoDiaJulgado({ serie: [z('2026-10-19', 0)] });
  const s = z('2026-10-19', 0); s.M5_meias_sol = 4;
  const c = L.ultimoDiaJulgado({ serie: [z('2026-10-18', 23), s, z('2026-10-20', 0)] });
  return a === '2026-10-18' && b === null && c === '2026-10-19';
}

async function lib() {
  console.log('1-6 · lib-inv-logger (mundo forjado, sem rede)');
  const L = require('./lib-inv-logger.js');
  const R = casosLib(L);
  const CH = ['okClassifica', 'okSemSol', 'okDiario', 'okCobertura', 'okScada', 'okEnergia', 'okInv', 'okExecutivo', 'okPares', 'okRanking', 'okAlarme'];
  for (const k of CH) ok(R[k], k);
  ok(caudaOk(L), 'okCauda: o diario termina no ultimo dia classificado (as linhas da coleta sem sol, so com o medidor, nao ficam no fim)');
  ok(ultimoJulgadoOk(L), 'okUltimoJulgado: o ultimo dia da disponibilidade e o ultimo com sol medido (linhas da coleta sem sol nao contam)');
  const P = paresIguais(L); ok(P.ok, 'okParesGenInvScada: a funcao do gen-inv-scada e a da lib dao o mesmo · ' + P.txt);
  console.log('7 · posicao vaga no mesmo logger (lib-sungrow-disp)');
  const V = casosVaga(require('./lib-sungrow-disp.js'));
  const CV = ['okVagaReal', 'okDuasVagas', 'okDoisNovos', 'okDonoLe', 'okDonoAtual', 'okPastaLida', 'okOutraPasta', 'okOutraUsina', 'okDupDono'];
  for (const k of CV) ok(V[k], k);
  console.log('7c · a troca pela planilha de substituicoes (lib-sungrow-disp)');
  const PL = casosPlanilha(require('./lib-sungrow-disp.js'));
  const CP = ['okPlanilha', 'okRetirado', 'okUsinaP', 'okPastaP', 'okDonoLeP', 'okAntes', 'okDuasPos', 'okDoisNaPos', 'okOcupada', 'okJaTem', 'okLeitura', 'okSemMarkup'];
  for (const k of CP) ok(PL[k], k);
  console.log('7b · a copia do supervisorio e o nome que o gen-perdas grava');
  ok((await casosCopia(L)).okCopia, 'okCopia: existe, semeia, aborta com o antigo do logger, aborta com a copia contaminada, nada a semear');
  const PP = publicaPerdas(); ok(PP.ok, 'okPublica: o gen-perdas grava o supervisorio com o sufixo _scada · ' + PP.txt);
  console.log('8 · gen-sungrow de ponta a ponta (sem SCADA)');
  const G1 = cenarioVaga(GEN, 'base'), G2 = cenarioVaga(GEN, 'duas'), G3 = cenarioVaga(GEN, 'revisao');
  ok(vagaOk(G1), 'o novo assume a vaga e entra na disponibilidade da posicao · ' + (G1.erro || G1.txt));
  ok(vagaDuasOk(G2), 'duas vagas no mesmo logger: o novo fica sem posicao · ' + (G2.erro || G2.txt));
  ok(!G3.erro && G3.okRevisao, 'o dono volta a ler: a atribuicao cai · ' + (G3.erro || G3.txt));
  const G4 = cenarioVaga(GEN, 'planilha');
  ok(planilhaOk(G4), 'duas vagas e a planilha de substituicoes: o novo vai para a posicao do retirado · ' + (G4.erro || G4.txt));
  console.log('9 · plantios');
  const libCasos = (k) => (f) => casosLib(require(f))[k];
  planta(LIB, LIBP, 'SCADA de volta como fonte dos parados (o nome do logger com o valor do supervisorio)',
    [["for (const [de, para] of Object.entries(RENOMEIA_SCADA_U)) if (S[u + de] != null) o[u + para] = S[u + de];",
      "for (const [de] of Object.entries(RENOMEIA_SCADA_U)) if (S[u + de] != null) o[u + de] = S[u + de];"]], libCasos('okScada'));
  planta(LIB, LIBP, 'parado do supervisorio contado (o dia com copia toma os parados dela)',
    [["o[u + '_inv_parados'] = c.parados;", "o[u + '_inv_parados'] = S && S[u + '_inv_parados'] != null ? S[u + '_inv_parados'] : c.parados;"]], libCasos('okDiario'));
  planta(LIB, LIBP, 'inversor do logger ausente contado como parado', [['      if (d == null) continue;\n      porU[u].lidas += 1;',
    '      porU[u].lidas += 1;\n      if (d == null) { porU[u].parados += 1; continue; }']], libCasos('okClassifica'));
  planta(LIB, LIBP, 'cauda sem classificacao no fim do diario', [["while (serie.length && !USINAS.some((u) => serie[serie.length - 1][u + '_n_inv'] != null)) serie.pop();", '']], (f) => caudaOk(require(f)));
  planta(LIB, LIBP, 'ultimo dia da disponibilidade pela ultima linha (com as linhas sem sol da coleta)',
    [["const js = ((sgDisp && sgDisp.serie) || []).filter((o) => USINAS.some((u) => o[u + '_meias_sol'] > 0));", "const js = ((sgDisp && sgDisp.serie) || []);"]], (f) => ultimoJulgadoOk(require(f)));
  planta(LIB, LIBP, 'usina-dia sem sol publicada como zero', [["if (D && D[u + '_meias_sol'] > 0 && C) {", 'if (C) {']], libCasos('okSemSol'));
  planta(LIB, LIBP, 'grandeza fisica do dia parcial', [['const inteiro = r.p === 0;', 'const inteiro = true;']], libCasos('okInv'));
  planta(LIB, LIBP, 'Complexo com usina incompleta', [['if (K.n_cc === placa) { scc', 'if (true) { scc']], libCasos('okEnergia'));
  planta(LIB, LIBP, 'razao medidor/contador com o contador incompleto', [['if (N && N.n === placa && N.kwh > 1000)', 'if (N && N.kwh > 1000)']], libCasos('okEnergia'));
  planta(LIB, LIBP, 'ms em UTC (00:00 Z, nao BRT)', [["const msDia = (dia) => Date.parse(dia + 'T00:00:00Z') + 3 * 3600e3;", "const msDia = (dia) => Date.parse(dia + 'T00:00:00Z');"]], libCasos('okDiario'));
  planta(LIB, LIBP, 'cobertura do primeiro dia apurado', [["const l = serie.filter((o) => o[u + '_n_inv'] != null).pop();", "const l = serie.filter((o) => o[u + '_n_inv'] != null)[0];"]], libCasos('okCobertura'));
  planta(LIB, LIBP, 'dia parcial nos pares', [["if (!o.p || o.p[i] !== '0' || !o.e || o.e[i] == null) continue;", "if (!o.e || o.e[i] == null) continue;"]], libCasos('okPares'));
  planta(LIB, LIBP, 'pares sem a queda para a usina', [['const usouTS = pares.length >= MIN_PARES;\n    const base = usouTS ? mediana(pares) : medUsina;\n    out.push({ ts: x.ts, inv: x.inv, kwh: r2(x.kwh), razao',
    'const usouTS = true;\n    const base = usouTS ? mediana(pares) : medUsina;\n    out.push({ ts: x.ts, inv: x.inv, kwh: r2(x.kwh), razao']], (f) => paresIguais(require(f)).ok);
  planta(LIB, LIBP, 'ranking sem o minimo de dias', [['.filter((o) => o.r.length >= Math.min(MIN_DIAS, diasFull.length))', '.filter(() => true)']], libCasos('okRanking'));
  planta(LIB, LIBP, 'ranking em ordem decrescente', [['inversores.sort((a, b) => a.razao_mediana - b.razao_mediana ||', 'inversores.sort((a, b) => b.razao_mediana - a.razao_mediana ||']], libCasos('okRanking'));
  planta(LIB, LIBP, 'desvio pela mediana mesmo com ela zerada', [['const escala = mad > 0 ? mad : desv.reduce((a, b) => a + b, 0) / (desv.length || 1);', 'const escala = mad;']], libCasos('okRanking'));
  planta(LIB, LIBP, 'executivo pelo numero de inversores', [['porUfv[u] = { disp_pct: v, n: CAPU[u] };', 'porUfv[u] = { disp_pct: v, n: PLACA[u].inversores };']], libCasos('okExecutivo'));
  const copiaCasos = async (f) => (await casosCopia(require(f))).okCopia;
  await plantaAsync(LIB, LIBP, 'semente sem a guarda da marca do logger', [["if (a.origem_inversor === ORIGEM) throw new Error(antigo + ' ja e do logger", "if (false) throw new Error(antigo + ' ja e do logger"]], copiaCasos);
  await plantaAsync(LIB, LIBP, 'copia contaminada aceita', [["if (ja && ja.origem_inversor) throw", "if (false) throw"]], copiaCasos);
  planta(path.join(__dirname, 'gen-perdas.js'), path.join(__dirname, '_plantio_perdas_nome.js'), 'gen-perdas de volta aos nomes das telas',
    [["'perdas_diario.json': 'perdas_diario_scada.json'", "'perdas_diario.json': 'perdas_diario.json'"]], (f) => publicaPerdas(f).ok);
  planta(path.join(__dirname, 'gen-perdas.js'), path.join(__dirname, '_plantio_perdas_nome.js'), 'gen-perdas grava pelo nome logico',
    [['  const nome = fisico(nomeLogico);   // perdas_diario', '  const nome = nomeLogico;   // perdas_diario']], (f) => publicaPerdas(f).ok);
  const vagaCasos = (k) => (f) => casosVaga(require(f))[k];
  planta(LIBD, LIBDP, 'vaga sem unicidade (a primeira vaga)', [['if (vs.length > 1) { ambiguos.push({ sn, vagas: vs.map((v) => v.pos).sort() }); continue; }', '']], vagaCasos('okDuasVagas'));
  planta(LIBD, LIBDP, 'vaga sem conferir a pasta lida no dia', [['if (!lePasta(v.ufv, v.pasta, own, v.dono)) continue;', '']], vagaCasos('okPastaLida'));
  planta(LIBD, LIBDP, 'dono que continua lendo deixa vaga', [['if (!own || !(v.fim < own)) continue;', 'if (!own) continue;']], vagaCasos('okDonoLe'));
  planta(LIBD, LIBDP, 'vaga de outra pasta', [['if (v.ufv !== o.ufv || v.pasta !== o.pasta) continue;', 'if (v.ufv !== o.ufv) continue;']], vagaCasos('okOutraPasta'));
  planta(LIBD, LIBDP, 'vaga de outra usina', [['if (v.ufv !== o.ufv || v.pasta !== o.pasta) continue;', 'if (v.pasta !== o.pasta) continue;']], vagaCasos('okOutraUsina'));
  planta(LIBD, LIBDP, 'dono = o numero de serie mais antigo da posicao', [["return a !== b ? (a < b ? 1 : -1) : (x < y ? -1 : 1); })[0];", "return a !== b ? (a < b ? -1 : 1) : (x < y ? -1 : 1); })[0];"]], vagaCasos('okDonoAtual'));
  // no gerador o plantio tem de reprovar PELO DEFEITO (o gerador rodou, sem erro), nunca por ter quebrado
  planta(GEN, GENP, 'gerador sem a vaga', [['for (const [sn, a] of Object.entries(V.atribui)) { ident[sn] = a;', 'for (const [sn, a] of Object.entries({})) { ident[sn] = a;']],
    (f) => { const R = cenarioVaga(f, 'base'); return R.erro ? 'estourou: ' + R.erro : !(!R.ident && R.semPos.includes(WV)); });
  const plCasos = (k) => (f) => casosPlanilha(require(f))[k];
  planta(LIBD, LIBDP, 'planilha sem conferir quem ocupa a posicao', [['if (!dono || !I[dono] || I[dono].pos !== t.pos || !inv[dono])', 'if (!dono || !I[dono] || !inv[dono])']], plCasos('okRetirado'));
  planta(LIBD, LIBDP, 'planilha sem conferir a usina', [['if (o.ufv !== u) {', 'if (false) {']], plCasos('okUsinaP'));
  planta(LIBD, LIBDP, 'planilha com o retirado ainda lendo', [['if (!own || !(fim < own)) {', 'if (!own) {']], plCasos('okDonoLeP'));
  planta(LIBD, LIBDP, 'planilha antes da data da troca', [['if (own < t.d) {', 'if (false) {']], plCasos('okAntes'));
  planta(LIBD, LIBDP, 'planilha sem conferir a posicao ocupada', [['const outro = Object.keys(I).find(', 'const outro = [].find(']], plCasos('okOcupada'));
  planta(LIBD, LIBDP, 'planilha com dois instalados na mesma posicao', [['if (sns.length > 1) { for (const sn of sns) recusados', 'if (false) { for (const sn of sns) recusados']], plCasos('okDoisNaPos'));
  planta(LIBD, LIBDP, 'planilha com o INV sem o zero', [["return m ? 'INV' + m[1].padStart(2, '0') : null;", "return m ? 'INV' + m[1] : null;"]], plCasos('okLeitura'));
  planta(GEN, GENP, 'gerador sem a planilha', [['for (const [sn, a] of Object.entries(R.atribui)) { ident[sn] = a;', 'for (const [sn, a] of Object.entries({})) { ident[sn] = a;']],
    (f) => planilhaOk(cenarioVaga(f, 'planilha')));
  planta(GEN, GENP, 'gerador sem a revisao da vaga', [["if (!H.inv[sn] || !dono || Object.keys(dono.dias).some((d) => d >= a.d)) {", 'if (false) {']],
    (f) => { const R = cenarioVaga(f, 'revisao'); return R.erro ? 'estourou: ' + R.erro : R.okRevisao; });
}
async function plantaAsync(fonte, destino, nome, trocas, julga) {
  let s = fs.readFileSync(fonte, 'utf8').replace(/\r\n/g, '\n');
  for (const [de, para] of trocas) { if (s.split(de).length !== 2) { ok(false, 'plantio "' + nome + '": trecho nao casou'); return; } s = s.split(de).join(para); }
  try { fs.writeFileSync(destino, s); delete require.cache[require.resolve(destino)]; ok((await julga(destino)) === false, 'plantio "' + nome + '" reprova'); }
  catch (e) { ok(false, 'plantio "' + nome + '" estourou: ' + e.message); }
  finally { if (fs.existsSync(destino)) fs.unlinkSync(destino); delete require.cache[destino]; }
}

/* ================================================================ --produto =================================================== */
/* o julgamento do produto, PURO (sem rede): devolve { nome: [ok, texto] }. Os plantios em memoria passam pela mesma funcao.
   Os pisos saem da placa (lib-placa) e das janelas publicadas, nunca de numero escolhido */
function julgaProduto(X) {
  const L = require('./lib-inv-logger.js');
  const { PD, PI, SA, IS, SDI, SD, SF, SSA, SC } = X;
  const R = {};
  const PLACA_TOTAL = U9.reduce((a, u) => a + PLACA[u].inversores, 0);
  for (const [n, j] of [['perdas_diario', PD], ['perdas_inv', PI], ['strings_alarme', SA], ['inv_scada', IS]]) R['marca_' + n] = [!!j && j.origem_inversor === 'logger', n + ' com a marca do logger'];
  R.marca_copia = [!!SC && !SC.origem_inversor, 'perdas_diario_scada sem a marca do logger (copia do supervisorio nao contaminada)'];
  const porDia = new Map(((PD && PD.serie) || []).map((o) => [o.dia, o]));
  // apurado = a usina-dia com meia hora de sol medida no sg_disp_dia: o campo existe SE E SO SE ha sol (nunca zero sem sol, nunca sumido com sol)
  // 20/10/2026 (okCauda): a cauda do sg_disp_dia sem sol (D-1 e D antes de a estacao chegar) nao vira linha do diario
  const ultPD = ((PD && PD.serie) || []).length ? PD.serie[PD.serie.length - 1].dia : '';
  let presenca = 0, cauda = 0; const difPres = [];
  for (const r of ((SD && SD.serie) || [])) { const o = porDia.get(r.dia);
    if (!o && r.dia > ultPD && !U9.some((u) => r[u + '_meias_sol'] > 0)) { cauda++; continue; }
    if (!o) { difPres.push(r.dia + ' sem linha'); continue; }
    for (const u of U9) { const tem = o[u + '_n_inv'] != null, sol = r[u + '_meias_sol'] > 0; presenca++; if (tem !== sol) difPres.push(r.dia + ' ' + u + (tem ? ' publicado sem sol' : ' com sol e sem campo')); } }
  R.presenca = [presenca === 9 * (((SD && SD.serie) || []).length - cauda) && presenca > 0 && cauda <= 2 && !difPres.length, 'n_inv presente se e so se ha sol no dia: ' + presenca + ' usina-dias, ' + cauda + ' dia(s) de cauda sem sol fora do diario, ' + difPres.length + ' fora ' + difPres.slice(0, 3).join(' · ')];
  // a recontagem PROPRIA (sem a lib): por posicao com leitura, < 50 parado, < 90 parcial; e o ms = 00:00 BRT
  let julg = 0; const dif = [];
  ((SDI && SDI.dias) || []).forEach((dia, i) => {
    const o = porDia.get(dia); if (!o) return;
    for (const u of U9) {
      if (o[u + '_n_inv'] == null) continue;
      let lid = 0, par = 0, pc = 0;
      for (const [pos, x] of Object.entries(SDI.inv)) { if (!pos.startsWith(u + '/')) continue; const v = x.d[i]; if (v == null) continue; lid++; if (v < 50) par++; else if (v < 90) pc++; }
      julg++;
      if (o[u + '_n_inv'] !== lid || o[u + '_inv_parados'] !== par || o[u + '_inv_parciais'] !== pc || o[u + '_inv_sem_leitura'] !== PLACA[u].inversores - lid)
        dif.push(dia + ' ' + u + ' publicado ' + [o[u + '_n_inv'], o[u + '_inv_parados'], o[u + '_inv_parciais'], o[u + '_inv_sem_leitura']] + ' recontado ' + [lid, par, pc, PLACA[u].inversores - lid]);
    }
  });
  const msErr = ((PD && PD.serie) || []).filter((o) => o.ms !== Date.parse(o.dia + 'T00:00:00-03:00')).length;
  const apur = ((SD && SD.serie) || []).reduce((a, r) => a + U9.filter((u) => r[u + '_meias_sol'] > 0).length, 0);
  R.recontagem = [julg > 0 && julg === apur && !dif.length && !msErr, 'parados, parciais, lidos e sem leitura recontados do sg_disp_inv_dia: ' + julg + ' de ' + apur
    + ' usina-dias apuradas, ' + dif.length + ' diferentes, ' + msErr + ' ms fora de 00:00 BRT ' + dif.slice(0, 3).join(' · ')];
  // a cobertura da raiz: o ultimo dia apurado de cada usina
  const cobErr = U9.filter((u) => { const l = ((PD && PD.serie) || []).filter((o) => o[u + '_n_inv'] != null).pop(); const c = PD && PD.cobertura_por_usina && PD.cobertura_por_usina[u];
    return !l || !c || c.dia !== l.dia || c.n_inversores !== l[u + '_n_inv'] || c.inversores_ausentes !== PLACA[u].inversores - l[u + '_n_inv']; });
  R.cobertura = [!cobErr.length, 'cobertura_por_usina = o ultimo dia apurado de cada usina' + (cobErr.length ? ' · erradas: ' + cobErr.join(',') : '')];
  // os campos do supervisorio: TODO valor da copia nos campos do Comparativo chega ao diario, igual, e nada fora dos dias dela
  const scd = new Map(((SC && SC.serie) || []).map((o) => [o.dia, o]));
  let nCopia = 0, difCopia = 0, foraCopia = 0;
  const pares = [...U9.flatMap((u) => L.CAMPOS_SCADA_U.map((c) => [u + c, u + c])), ...U9.flatMap((u) => Object.entries(L.RENOMEIA_SCADA_U).map(([de, para]) => [u + de, u + para])),
    ...L.CAMPOS_SCADA_DIA.map((c) => [c, c]), ['janela_h', 'janela_scada_h']];
  for (const [dia, sd] of scd) { const o = porDia.get(dia) || {}; for (const [de, para] of pares) { if (sd[de] == null) continue; nCopia++; if (o[para] !== sd[de]) difCopia++; } }
  for (const o of ((PD && PD.serie) || [])) { if (scd.has(o.dia)) continue; for (const [, para] of pares) if (o[para] != null) foraCopia++; }
  R.copia = [!!SC && nCopia > 0 && !foraCopia && !difCopia, 'campos do supervisorio: ' + nCopia + ' valores da copia, ' + difCopia + ' diferentes ou faltando, ' + foraCopia + ' fora dos dias dela'];
  const SO = ['horas', 'lidos', 'gerando', 'jan_slots', 'setpoint_min', 'setpoint_ger', 'nominal', 'ef_imp'];
  const posInv = new Set(((PI && PI.serie) || []).map((l) => l.ufv + '/' + l.ts + '/' + l.inv)), diasInv = new Set(((PI && PI.serie) || []).map((l) => l.dia));
  R.inv = [!!PI && posInv.size === PLACA_TOTAL && diasInv.size === PI.janela_dias && PI.dias_cobertos === diasInv.size && !PI.serie.some((l) => SO.some((c) => c in l)),
    'perdas_inv: ' + posInv.size + ' de ' + PLACA_TOTAL + ' posicoes, ' + diasInv.size + ' de ' + (PI ? PI.janela_dias : '-') + ' dias, sem campo do supervisorio'];
  R.alarme = [!!SA && !!SSA && JSON.stringify(SA.serie) === JSON.stringify(SSA.serie) && JSON.stringify(SA.resumo) === JSON.stringify(SSA.resumo), 'strings_alarme = sg_str_alarme (' + (SA ? SA.serie.length : 0) + ' strings)'];
  // o ranking: a frota que tem dias inteiros suficientes no sg_frota_dia (contagem propria) e a ordem
  const nDias = (SF && SF.dias || []).length;
  const esperados = Object.values((SF && SF.inv) || {}).filter((o) => (o.p || '').split('').filter((c, i) => c === '0' && o.e[i] != null).length >= Math.min(L.MIN_DIAS, nDias)).length;
  const rk = (IS && IS.ranking) || [];
  R.ranking = [rk.length > 0 && rk.every((x, i) => !i || rk[i - 1].razao_mediana <= x.razao_mediana) && !!IS && IS.inversores.length === esperados,
    'ranking ordenado e com a frota que tem dias inteiros: ' + (IS ? IS.inversores.length : 0) + ' de ' + esperados + ' esperados'];
  return R;
}

async function produto() {
  const LD = require('./lib-le-dados');
  const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
  const parse = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
  const le = async (n) => { if (!/^https?:/.test(BASE)) { const f = path.join(BASE, n); return fs.existsSync(f) ? parse(fs.readFileSync(f)) : null; }
    const x = await LD.pede(BASE + n, { 'accept-encoding': 'gzip' }); if (x.status === 404) return null; if (x.status !== 200) throw new Error(n + ': HTTP ' + x.status); return parse(x.buf); };
  const [PD, PI, SA, IS, SDI, SD, SF, SSA, SC] = await Promise.all(['perdas_diario.json', 'perdas_inv.json', 'strings_alarme.json', 'inv_scada.json',
    'sg_disp_inv_dia.json', 'sg_disp_dia.json', 'sg_frota_dia.json', 'sg_str_alarme.json', 'perdas_diario_scada.json'].map(le));
  const X = { PD, PI, SA, IS, SDI, SD, SF, SSA, SC };
  console.log('produto · ' + (/^https?:/.test(BASE) ? 'blob publicado' : 'pasta ' + BASE));
  const R = julgaProduto(X);
  for (const [, [c, m]] of Object.entries(R)) ok(c, m);
  if (!PD || !PD.serie || !SDI || !SD) return;
  console.log('plantios em memoria (cada um TEM de reprovar)');
  const copia = (o) => JSON.parse(JSON.stringify(o));
  const ultimo = (pd) => pd.serie.filter((o) => U9.some((u) => o[u + '_n_inv'] != null)).pop();
  // os dias em que as duas contagens de parados DIFEREM: so neles o plantio "copiar o supervisorio" se distingue do certo
  const difSc = PD.serie.filter((o) => U9.some((u) => o[u + '_inv_parados_scada'] != null && o[u + '_n_inv'] != null && o[u + '_inv_parados_scada'] !== o[u + '_inv_parados']));
  ok(difSc.length > 0, 'ha dia em que os parados do supervisorio e do logger diferem (' + difSc.length + '): o plantio da copia julga alguma coisa');
  const casos = [
    ['inversor do logger ausente contado como parado', 'recontagem', (Y) => { const o = ultimo(Y.PD); o.M1_inv_parados += 1; o.M1_inv_sem_leitura -= 1; o.M1_n_inv += 1; }],
    ['parados do supervisorio no lugar do logger', 'recontagem', (Y) => { for (const o of Y.PD.serie) for (const u of U9) if (o[u + '_inv_parados_scada'] != null && o[u + '_n_inv'] != null) o[u + '_inv_parados'] = o[u + '_inv_parados_scada']; }],
    ['usina-dia sem sol publicada como zero', 'presenca', (Y) => { const r = Y.SD.serie.find((x) => U9.some((u) => !(x[u + '_meias_sol'] > 0)));
      if (!r) { Y.SD.serie[0].M1_meias_sol = 0; return; } const u = U9.find((v) => !(r[v + '_meias_sol'] > 0)); const o = Y.PD.serie.find((x) => x.dia === r.dia); if (o) { o[u + '_n_inv'] = 0; o[u + '_inv_parados'] = 0; } }],
    ['dia com sol cortado do fim do diario (a cauda que sai e so a sem sol)', 'presenca', (Y) => { Y.PD.serie.pop(); }],
    ['SCADA de volta como fonte da disponibilidade depois do export', 'copia', (Y) => { ultimo(Y.PD).M5_disp_pct = 99.9; }],
    ['copia do supervisorio contaminada pelo logger', 'marca_copia', (Y) => { Y.SC.origem_inversor = 'logger'; }],
    ['campo do supervisorio no perdas_inv', 'inv', (Y) => { Y.PI.serie[0].horas = 720; }],
    ['string a mais no strings_alarme', 'alarme', (Y) => { Y.SA.serie = Y.SA.serie.concat([{ ufv: 'M1', ts: 'TS1', inv: 'INV01', str: 99, classe: 'morta' }]); }],
    ['inversor com poucos dias no ranking', 'ranking', (Y) => { Y.IS.inversores = Y.IS.inversores.concat([{ chave: 'M1/TS1/INV99', razao_mediana: 1 }]); }],
  ];
  for (const [nome, chave, muda] of casos) { const Y = copia(X); muda(Y); ok(julgaProduto(Y)[chave][0] === false, 'plantio "' + nome + '" reprova em ' + chave); }
}

(async () => {
  if (MODO === 'lib') await lib(); else await produto();
  console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-inv-logger (' + MODO + '): tudo ok');
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
