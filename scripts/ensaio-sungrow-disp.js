'use strict';
/*
 * ensaio-sungrow-disp.js — a disponibilidade dos inversores pelo logger Sungrow (lib-sungrow-disp e o gancho no
 * gen-sungrow), SEM REDE. Roda no sungrow.yml ANTES de gerar. A regra vem da lib (importada, nunca copiada); os valores
 * esperados saem de aritmetica escrita aqui, caso a caso.
 *
 * 1 · lib: cada codigo da Tabela 2 (direto e pelo CSV, com o espaco que o logger poe antes do numero); coluna pelo NOME
 *     (cabecalho na ordem real e embaralhado; "Status de operacao do inversor", a coluna 31, com valores que enganam;
 *     coluna faltando estoura); carimbo fora da grade de 5 min; dois zips do mesmo dia (uniao, o novo ganha); e o calculo
 *     num cenario de dois dias e duas usinas: patamar com 3 de 6 amostras, 0x5500 com e sem codigo, 0xFFFE no inicio do
 *     historico (herda disponivel) e depois de um indisponivel, heranca que atravessa a meia-noite, patamar sem nenhuma
 *     leitura (nulo, e contado como sol sem logger), patamar sem irradiancia (fora do dia), 50 W/m² entra e 49,9 nao,
 *     nominal diferente (352 kW) e nominal ilegivel (320 kW), inversor retirado que continua lendo depois do sucessor,
 *     serie sem posicao, a regra da leitura (a do calculo local) e a janela que reinicia a heranca, Complexo pela Capu.
 *     Por POSICAO (sg_disp_inv_dia, sungrow-disp-inv): a conta a mao de cada posicao nas meias horas de sol, sem a serie sem
 *     posicao, e o blob compacto (dias x posicoes).
 * 2 · plantios na lib (uma copia mudada, os mesmos casos): cada um reprova na sua checagem.
 * 3 · o gerador de ponta a ponta (identificacao semeada no sg_ident, sem SCADA): o arquivo do proprio logger FORJADO com as
 *     tres colunas (pior caso: um firmware que as tenha) nao entra no historico; idempotencia; sem historico e com esquema
 *     velho relê os zips e publica o mesmo; sem a estacao aborta. Plantios no gerador, cada um reprovando.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const S = require('./lib-sungrow.js');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const perto = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-12;
const pct = (f) => (f == null ? null : Math.round(f * 1e5) / 1e3);        // o formato publicado: a fracao com 5 casas, em %

/* ---------- o CSV do inversor como o logger grava: as 36 primeiras colunas na ORDEM REAL (marco/2026), e as que o
   gen-sungrow exige depois. 28 = Status do dispositivo, 31 = Status de operacao do inversor, 32 = Codigo de falha ---------- */
const REAL36 = ['Horário', 'Potência ativa nominal', 'Potência reativa nominal', 'Modo de potência limitada', 'Tipo de saída',
  'Geração de energia ao longo do dia', 'Geração total', 'Tensão da linha AB', 'Tensão da linha BC', 'Tensão de linha CA',
  'Tempo de execução total conectado a rede', 'Temperatura de ar interna', 'Potência aparente total', 'Potência CC total',
  'Potência ativa total', 'Potência reativa total', 'Potência aparente total', 'Potência CC total', 'Potência ativa total',
  'Potência reativa total', 'Fator de potência total', '电网线电压AB', '电网线电压BC', '电网线电压CA', 'Corrente da fase A',
  'Corrente da fase B', 'Corrente da fase C', '新协议电网频率', 'Status do dispositivo', 'Status de operação do inversor_Xinjiang',
  'Status de operação do inversor_Ningxia', 'Status de operação do inversor', 'Código de falha', 'Impedância paralela em relação à terra',
  'Status', 'Tempo de operação diário'];
const CAB = [...REAL36, 'Eficiência do inversor', 'Estado de trabalho PID', 'Código de falha PID', 'Tensão do barramento',
  'Tensão de pólo negativo / terra', ...Array.from({ length: 12 }, (_, k) => 'Tensão MPPT' + (k + 1)), ...Array.from({ length: 12 }, (_, k) => 'Corrente MPPT' + (k + 1))];
ok(CAB[1] === 'Potência ativa nominal' && CAB[28] === 'Status do dispositivo' && CAB[31] === 'Status de operação do inversor' && CAB[32] === 'Código de falha',
  'o cabecalho sintetico tem as colunas nas posicoes reais (1, 28, 31, 32)');
const hhmm = (i) => String(Math.floor(i / 12)).padStart(2, '0') + ':' + String((i % 12) * 5).padStart(2, '0');
/* linhas: [{ t, st, cod, pn, op }]; "Status de operacao do inversor" (op) vale 0 em toda linha: lido no lugar do estado,
   todo indisponivel vira 0x0 (disponivel). Os numeros vem com o espaco que o logger poe ('  33280') */
function csv(cab, linhas, vida) {   /* vida: o contador de vida do inversor (cada numero de serie tem o seu, como na realidade) */
  const cel = (nome, r) => { if (nome === 'Horário') return r.t; if (nome === 'Status do dispositivo') return ' ' + r.st; if (nome === 'Código de falha') return ' ' + r.cod;
    if (nome === 'Potência ativa nominal') return r.pn === '' ? '' : ' ' + r.pn; if (nome === 'Status de operação do inversor') return ' ' + (r.op || 0);
    if (nome === 'Geração total') return ' ' + (vida == null ? 1000000 : vida); return ' 0'; };
  return '﻿' + cab.join(',') + '\n' + linhas.map((r) => cab.map((n) => cel(n, r)).join(',')).join('\n') + '\n';
}
// um dia: fn(i) -> null (sem amostra) ou [estado, codigo]
const dia = (d, fn, pn) => { const L = []; for (let i = 0; i < 288; i += 1) { const x = fn(i); if (x) L.push({ t: d + ' ' + hhmm(i) + ':00', st: x[0], cod: x[1], pn }); } return L; };

const D1 = '2026-09-28', D2 = '2026-09-29';
const X1 = 'A0000000001', X2 = 'A0000000002', X3 = 'A0000000003', X4 = 'A0000000004', X5 = 'A0000000005', Y1 = 'A0000000071';
const em = (i, a, b) => i >= a && i <= b;
/* X1 (M1/TS1/INV01, 320 kW). D1: patamar 20 (10:00) parado 0x8000; 21 com 3 de 6 amostras (D, 0x5500 com codigo, D);
   22: 0x8000, 0x5500 sem codigo, 0xFFFE, 0x0, 0x5500 sem codigo, 0xFFFE (3 de 6: os dois primeiros herdam o parado, os dois
   ultimos herdam o 0x0); 23 em espera 0x1400; 25 sem amostra; 23:55 falha de comunicacao 0x2500. D2: 00:00-00:25 0xFFFE
   (herda o 0x2500 de ONTEM: indisponivel) */
const P22 = [[0x8000, 0], [0x5500, 0], [0xFFFE, 0], [0x0, 0], [0x5500, 0], [0xFFFE, 0]];
const LX1 = [...dia(D1, (i) => (em(i, 120, 125) ? [0x8000, 0] : i === 126 || i === 128 ? [0x0, 0] : i === 127 ? [0x5500, 39] : em(i, 129, 131) ? null
  : em(i, 132, 137) ? P22[i - 132] : em(i, 138, 143) ? [0x1400, 0] : em(i, 150, 155) ? null : i === 287 ? [0x2500, 0] : [0x0, 0]), 3200),
  ...dia(D2, (i) => (i <= 5 ? [0xFFFE, 0] : [0x0, 0]), 3200)];
/* X2 (INV02, 352 kW): a primeira leitura do historico e 0xFFFE (herda o inicio: disponivel); 0x8100, 0x9100, 0x1200, 0x1600 e
   0x8200 nos patamares 20 a 23 e no resto; 25 sem amostra; e duas linhas FORA da grade (10:07:00 e 10:05:30) paradas */
const LX2 = [...dia(D1, (i) => (i === 0 ? [0xFFFE, 0] : em(i, 120, 125) ? [0x8100, 0] : em(i, 126, 131) ? [0x9100, 0] : em(i, 132, 137) ? [0x1200, 0]
  : em(i, 138, 143) ? [0x1600, 0] : em(i, 150, 155) ? null : [0x8200, 0]), 3520),
  { t: D1 + ' 10:07:00', st: 0x8000, cod: 0, pn: 3520 }, { t: D1 + ' 10:05:30', st: 0x8000, cod: 0, pn: 3520 },
  ...dia(D2, () => [0x0, 0], 3520)];
// X3 (INV03 ate D2, 320 kW): D1 patamar 20 parada de emergencia 0x1500; D2 CONTINUA lendo (parado 0x8000) depois do sucessor
const LX3 = [...dia(D1, (i) => (em(i, 120, 125) ? [0x1500, 0] : em(i, 150, 155) ? null : [0x0, 0]), 3200), ...dia(D2, () => [0x8000, 0], 3200)];
// X4 (o sucessor no INV03 a partir de D2): nominal ILEGIVEL (vale 320 kW)
const LX4 = dia(D2, () => [0x0, 0], '');
// X5: numero de serie SEM posicao, na pasta do M1, parado em D1
const LX5 = dia(D1, (i) => (em(i, 150, 155) ? null : [0x8000, 0]), 3200);
// Y1 (M7/TS1/INV01): D1 patamar 20 parada por chave 0x1300
const LY1 = [...dia(D1, (i) => (em(i, 120, 125) ? [0x1300, 0] : [0x0, 0]), 3200), ...dia(D2, () => [0x0, 0], 3200)];
const SERIES = { [X1]: ['M1', LX1], [X2]: ['M1', LX2], [X3]: ['M1', LX3], [X4]: ['M1', LX4], [X5]: ['M1', LX5], [Y1]: ['M7', LY1] };
const POS = { [X1]: 'M1/TS1/INV01', [X2]: 'M1/TS1/INV02', [X3]: 'M1/TS1/INV03', [X4]: 'M1/TS1/INV03', [Y1]: 'M7/TS1/INV01' };
const posNoDia = (sn, d) => (sn === X3 && d >= D2 ? null : POS[sn] || null);

/* a irradiancia, no formato do estacao_logger_30min.json. M1: D1 10:00 e 10:30 600, 11:00 50 (entra), 11:30 49,9 (nao entra),
   12:00 SEM medida, 12:30 600 (sem leitura de inversor), o resto 0; D2 12:00 700, o resto 0. M7: D1 10:00 e 10:30 600; D2 12:00 700 */
const hm = (k) => String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00');
const E1 = { [D1]: { 20: 600, 21: 600, 22: 50, 23: 49.9, 24: null, 25: 600 }, [D2]: { 24: 700 } };
const E7 = { [D1]: { 20: 600, 21: 600 }, [D2]: { 24: 700 } };
const ESTACAO = { serie: [D1, D2].flatMap((d) => Array.from({ length: 48 }, (_, k) => { const t = d + 'T' + hm(k) + ':00-03:00';
  const r = { t, ms: Date.parse(t), e7: k in E7[d] ? E7[d][k] : 0 }; const v = k in E1[d] ? E1[d][k] : 0; if (v != null) r.e1 = v; return r; })) };

/* ---------- o esperado, a mao ---------- */
const P1 = 320, P2 = 352, P3 = 320, P4 = 320, P5 = 320;
const DEN = P1 + P2 + P3;
const f20 = (P2) / DEN, f21 = ((2 / 3) * P1 + P2 + P3) / DEN, f22 = ((3 / 6) * P1 + P2 + P3) / DEN, f47 = ((5 / 6) * P1 + P2 + P3) / DEN;
// 46 patamares no dia (sem o 24, sem irradiancia, e o 25, sem leitura); 42 deles com tudo disponivel
const ESP = { M1: { [D1]: { sol: (f20 + f21 + f22) / 3, h24: (f20 + f21 + f22 + f47 + 42) / 46, nsol: 3, n24: 46, sem: 1, inv: 3 },
  [D2]: { sol: 1, h24: ((P2 + P4) / (P1 + P2 + P4) + 47) / 48, nsol: 1, n24: 48, sem: 0, inv: 3 } },
M7: { [D1]: { sol: 0.5, h24: 47 / 48, nsol: 2, n24: 48, sem: 0, inv: 1 }, [D2]: { sol: 1, h24: 1, nsol: 1, n24: 48, sem: 0, inv: 1 } } };
// a regra da leitura (calculo local): X5 entra em D1 (parado) e X3 em D2 (parado), mais 320 kW no denominador
const DL = DEN + P5, lo1 = DEN / DL, DL2 = P1 + P2 + P3 + P4, lo2 = (P1 + P2 + P4) / DL2;
const ESPL = { [D1]: { sol: (P2 / DL + ((2 / 3) * P1 + P2 + P3) / DL + ((1 / 2) * P1 + P2 + P3) / DL) / 3,
  h24: (P2 / DL + ((2 / 3) * P1 + P2 + P3) / DL + ((1 / 2) * P1 + P2 + P3) / DL + ((5 / 6) * P1 + P2 + P3) / DL + 42 * lo1) / 46, inv: 4 },
[D2]: { sol: lo2, h24: ((P2 + P4) / DL2 + 47 * lo2) / 48, inv: 4 } };
/* por POSICAO (porInv, sungrow-disp-inv): so as meias horas de sol com leitura. D1 no M1 = patamares 20, 21 e 22 (o 23 tem 49,9, o 24
   nao tem irradiancia, o 25 nao tem leitura): INV01 0, 2/3 e 3/6; INV02 1, 1 e 1; INV03 (X3) 0, 1 e 1. No M7 os patamares 20 e 21:
   0 e 1. D2: um patamar (24) com tudo disponivel; o INV03 e o X4 (o X3 saiu da posicao); o X5, sem posicao, nao aparece */
const ESPI = { 'M1/TS1/INV01': { [D1]: [(0 + 2 / 3 + 1 / 2) / 3, 3], [D2]: [1, 1] }, 'M1/TS1/INV02': { [D1]: [1, 3], [D2]: [1, 1] },
  'M1/TS1/INV03': { [D1]: [2 / 3, 3], [D2]: [1, 1] }, 'M7/TS1/INV01': { [D1]: [0.5, 2], [D2]: [1, 1] } };
const CAPU1 = 49.110, CAPU7 = 14.733;
const cx = (a, b) => (CAPU1 * a + CAPU7 * b) / (CAPU1 + CAPU7);
ok(f20 < 1 && f21 < 1 && f22 < 1 && f47 < 1 && ESPL[D1].sol !== ESP.M1[D1].sol && ESPL[D2].h24 !== ESP.M1[D2].h24 && cx(0.9, 0.5) !== (0.9 + 0.5) / 2,
  'o cenario separa os casos (patamares abaixo de 1, posicao x leitura, Capu x media simples)');

/* ---------- 1 · casos na lib (a mesma funcao roda com cada lib plantada) ---------- */
function casosLib(Dx) {
  const R = { txt: {} };
  const T2 = [[0x0, 0, 'D'], [0x8200, 0, 'D'], [0x8100, 0, 'D'], [0x9100, 0, 'D'], [0x1400, 0, 'D'], [0x1200, 0, 'D'], [0x1600, 0, 'D'], [0x0, 39, 'D'],
    [0x8000, 0, 'I'], [0x1300, 0, 'I'], [0x1500, 0, 'I'], [0x2500, 0, 'I'], [0x8000, 39, 'I'], [0x5500, 39, 'I'], [0x5500, 1, 'I'],
    [0x5500, 0, 'H'], [0xFFFE, 0, 'H'], [0x1234, 0, 'H'], [65535, 0, 'H']];
  const direto = T2.every(([s, c, e]) => Dx.classe(s, c) === e);
  const pc = Dx.diaDisp(S.le(csv(CAB, T2.map(([st, cod], i) => ({ t: D1 + ' ' + hhmm(i) + ':00', st, cod, pn: 3200 })))).cab,
    S.le(csv(CAB, T2.map(([st, cod], i) => ({ t: D1 + ' ' + hhmm(i) + ':00', st, cod, pn: 3200 })))).linhas, 't2');
  const cls = pc.length === 1 ? Dx.derle(pc[0].c).slice(0, T2.length).join('') : '';
  R.okTabela2 = direto && cls === T2.map((x) => x[2]).join('');
  R.txt.tabela2 = cls;
  // coluna pelo nome: o cabecalho embaralhado da o MESMO dia; coluna faltando estoura com o nome
  const leDe = (cab, L) => { const a = S.le(csv(cab, L)); return Dx.diaDisp(a.cab, a.linhas, 'x1'); };
  const emb = [CAB[0], ...CAB.slice(1).reverse()];
  R.okNome = JSON.stringify(leDe(CAB, LX1)) === JSON.stringify(leDe(emb, LX1));
  R.okSemColuna = ['Status do dispositivo', 'Código de falha', 'Potência ativa nominal'].every((n) => {
    try { leDe(CAB.filter((c) => c !== n), LX1); return false; } catch (e) { return e.message.includes(n); } });
  // carimbo fora da grade de 5 min: nao e amostra (o 10:05 segue 0x8100)
  const x2 = leDe(CAB, LX2).find((x) => x.d === D1);
  R.okGrade = !!x2 && x2.fora === 2 && Dx.derle(x2.c)[121] === 'D' && x2.n === 288 - 6;
  // dois zips do mesmo dia: a uniao, e no mesmo carimbo o novo ganha
  const HJ = Dx.histVazio();
  Dx.junta(HJ, X1, 'M1', leDe(CAB, dia(D1, (i) => (i < 144 ? [0x0, 0] : null), 3200)));
  Dx.junta(HJ, X1, 'M1', leDe(CAB, dia(D1, (i) => (i >= 144 || i === 10 ? [i === 10 ? 0x8000 : 0x0, 0] : null), 3520)));
  const j = HJ.inv[X1] && HJ.inv[X1].dias[D1], ja = j ? Dx.derle(j.c) : [];
  R.okJunta = !!j && ja.filter((x) => x === '.').length === 0 && ja[10] === 'I' && ja[9] === 'D' && ja[200] === 'D' && j.pn === 352;
  // o cenario
  const H = Dx.histVazio();
  for (const [sn, [u, L]] of Object.entries(SERIES)) Dx.junta(H, sn, u, leDe(CAB, L));
  const E = Dx.estacaoPorMeia(ESTACAO);
  const rp = Dx.calcula(H, E, { regra: 'posicao', posNoDia, meias: true });
  const rl = Dx.calcula(H, E, { regra: 'leitura', meias: true });
  const rj = Dx.calcula(H, E, { regra: 'leitura', janela: [D2, D2], meias: true });
  const lin = (r, d, u) => r.linhas.find((x) => x.d === d && x.u === u) || {};
  const meia = (r, d, u, k) => { const x = r.meias.find((m) => m.d === d && m.u === u && m.k === k); return x ? x.f : undefined; };
  const confere = (l, e) => perto(l.disp_sol, e.sol) && perto(l.disp_24h, e.h24) && l.meias_sol === e.nsol && l.meias_24h === e.n24 && l.meias_sol_sem_logger === e.sem && l.inv_logger === e.inv;
  R.okD1 = confere(lin(rp, D1, 'M1'), ESP.M1[D1]) && meia(rp, D1, 'M1', 25) === null && perto(meia(rp, D1, 'M1', 24), 1) && perto(meia(rp, D1, 'M1', 21), f21);
  R.okD2 = confere(lin(rp, D2, 'M1'), ESP.M1[D2]) && perto(meia(rp, D2, 'M1', 0), (P2 + P4) / (P1 + P2 + P4));
  R.okM7 = confere(lin(rp, D1, 'M7'), ESP.M7[D1]) && confere(lin(rp, D2, 'M7'), ESP.M7[D2]) && lin(rp, D1, 'M2').disp_sol === null && lin(rp, D1, 'M2').inv_logger === 0;
  R.txt.d1 = JSON.stringify(lin(rp, D1, 'M1')); R.txt.d2 = JSON.stringify(lin(rp, D2, 'M1'));
  const l1 = lin(rl, D1, 'M1'), l2 = lin(rl, D2, 'M1');
  R.okLeitura = perto(l1.disp_sol, ESPL[D1].sol) && perto(l1.disp_24h, ESPL[D1].h24) && l1.inv_logger === 4 && perto(l2.disp_sol, ESPL[D2].sol) && perto(l2.disp_24h, ESPL[D2].h24) && l2.inv_logger === 4;
  R.txt.leitura = JSON.stringify([l1, l2]);
  // a janela do calculo local: so D2, e a heranca reinicia nele (o 0xFFFE da meia-noite vira disponivel)
  R.okJanela = rj.linhas.every((x) => x.d === D2) && rj.linhas.length === Dx.USINAS.length && perto(meia(rj, D2, 'M1', 0), (P1 + P2 + P4) / DL2) && perto(meia(rl, D2, 'M1', 0), (P2 + P4) / DL2);
  // o produto: formato, Complexo pela Capu, usina sem dado nula
  const pr = Dx.produto(rp.linhas, 'agora'), r1 = pr.serie.find((x) => x.dia === D1) || {};
  R.okProduto = pr.serie.length === 2 && r1.ms === Date.parse(D1 + 'T00:00:00-03:00') && r1.M1_disp_sol_pct === pct(ESP.M1[D1].sol) && r1.M1_disp_24h_pct === pct(ESP.M1[D1].h24)
    && r1.M7_disp_sol_pct === pct(0.5) && r1.CX_disp_sol_pct === pct(cx(ESP.M1[D1].sol, 0.5)) && r1.CX_disp_24h_pct === pct(cx(ESP.M1[D1].h24, 47 / 48))
    && r1.CX_usinas_sol === 2 && r1.CX_usinas_24h === 2 && r1.M2_disp_sol_pct === null && r1.M2_meias_sol === 0 && r1.M1_inv_placa === 165 && r1.M7_inv_placa === 44
    && r1.M1_meias_sol === 3 && r1.M1_meias_sol_sem_logger === 1 && r1.M1_inv_logger === 3 && 'M9_disp_24h_pct' in r1;
  R.txt.produto = JSON.stringify({ M1: r1.M1_disp_sol_pct, M7: r1.M7_disp_sol_pct, CX: r1.CX_disp_sol_pct });
  // a troca de inversor (janelasTroca): normal, duplicado de um dia que nao antecipa a troca, duplicado puro, tres series
  const dd = (d0, n) => Array.from({ length: n }, (_, k) => new Date(Date.parse(d0 + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10));
  // dup: o dia do novo que repete o contador de vida e a energia do antigo (aqui, os dias listados em DUP[novo])
  const DUP = { B: { '2026-04-15': 1, '2026-07-15': 1, '2026-04-29': 1 } }, dup = (n, o, d) => !!(DUP[n] && DUP[n][d]);
  const j1 = Dx.janelasTroca({ A: dd('2026-09-25', 6), B: dd('2026-09-30', 5) }, dup);                                      // troca normal
  const j2 = Dx.janelasTroca({ A: dd('2026-04-01', 90), B: ['2026-04-15', '2026-07-15'].concat(dd('2026-09-30', 3)) }, dup);  // duplicados antes da troca
  const j3 = Dx.janelasTroca({ A: dd('2026-04-01', 60), B: ['2026-04-29'] }, dup);                                         // so duplicado
  const j4 = Dx.janelasTroca({ A: dd('2026-01-01', 10), B: dd('2026-01-10', 10), C: dd('2026-01-19', 5) }, dup);           // tres series
  const j5 = Dx.janelasTroca({ A: dd('2026-09-25', 9), B: dd('2026-09-30', 5) }, dup);                                      // o antigo segue com registro depois da troca
  R.okTrocaJan = j1.A.ini === '2026-09-25' && j1.A.fim === '2026-09-30' && j1.B.ini === '2026-09-30' && j1.B.fim === null
    && j2.A.fim === '2026-09-30' && j2.B.ini === '2026-09-30'
    && j3.A.fim === null && j3.B.ini === null
    && j4.A.fim === '2026-01-10' && j4.B.ini === '2026-01-10' && j4.B.fim === '2026-01-19' && j4.C.ini === '2026-01-19'
    && j5.A.fim === '2026-09-30' && j5.B.ini === '2026-09-30';
  R.txt.trocajan = JSON.stringify({ normal: j1, duplicado: j2.B, puro: j3.B });
  // por posicao (porInv): a conta a mao, as mesmas linhas da usina, e o blob compacto
  const ri = Dx.calcula(H, E, { regra: 'posicao', posNoDia, porInv: true }), I = ri.inv || {};
  const confI = Object.keys(ESPI).every((p) => [D1, D2].every((d) => I[p] && I[p][d] && perto(I[p][d].s / I[p][d].n, ESPI[p][d][0]) && I[p][d].n === ESPI[p][d][1]));
  const pi = Dx.produtoInv ? Dx.produtoInv(I, 'agora') : { dias: [], inv: {} }, a1 = pi.inv['M1/TS1/INV01'] || {};
  R.okInv = confI && Object.keys(I).sort().join() === Object.keys(ESPI).sort().join() && JSON.stringify(ri.linhas) === JSON.stringify(rp.linhas)
    && JSON.stringify(pi.dias) === JSON.stringify([D1, D2]) && JSON.stringify(a1.d) === JSON.stringify([pct(ESPI['M1/TS1/INV01'][D1][0]), 100]) && JSON.stringify(a1.m) === JSON.stringify([3, 1]);
  R.txt.inv = JSON.stringify(Object.fromEntries(Object.entries(pi.inv).map(([p, x]) => [p, x.d])));
  return R;
}
console.log('1 · lib-sungrow-disp');
const ATUAL = casosLib(require('./lib-sungrow-disp.js'));
const CHAVES = ['okTabela2', 'okNome', 'okSemColuna', 'okGrade', 'okJunta', 'okD1', 'okD2', 'okM7', 'okLeitura', 'okJanela', 'okProduto', 'okTrocaJan', 'okInv'];
for (const k of CHAVES) ok(ATUAL[k], k + (ATUAL.txt[k.slice(2).toLowerCase()] ? ' ' + ATUAL.txt[k.slice(2).toLowerCase()] : ''));

/* ---------- 2 · plantios na lib ---------- */
console.log('\n2 · plantios na lib (cada um roda os mesmos casos)');
const LIB = path.join(__dirname, 'lib-sungrow-disp.js'), LIBP = path.join(__dirname, '_plantio_lib_disp.js');
const srcLib = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
function plantaLib(nome, trocas, chave) {
  let s = srcLib;
  for (const [de, para] of trocas) { if (s.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou na lib'); return; } s = s.split(de).join(para); }
  try {
    fs.writeFileSync(LIBP, s); delete require.cache[require.resolve(LIBP)];
    let R; try { R = casosLib(require(LIBP)); } catch (e) { ok(false, 'plantio na lib "' + nome + '" estourou: ' + e.message); return; }
    ok(R[chave] === false, 'plantio na lib "' + nome + '" reprova em ' + chave);
  } finally { if (fs.existsSync(LIBP)) fs.unlinkSync(LIBP); delete require.cache[LIBP]; }
}
plantaLib('estado pela coluna 31 (Status de operacao do inversor)', [['st: exige(cab, COLUNAS.st, onde)', 'st: 31']], 'okD1');
plantaLib('estado pela posicao 28, sem o nome', [['st: exige(cab, COLUNAS.st, onde)', 'st: 28']], 'okNome');
plantaLib('0x5500 sem codigo contado como indisponivel', [["if (st === FALHA && cod !== 0) return 'I';", "if (st === FALHA) return 'I';"]], 'okTabela2');
plantaLib('0x5500 sem codigo contado como indisponivel (no calculo)', [["if (st === FALHA && cod !== 0) return 'I';", "if (st === FALHA) return 'I';"]], 'okD1');
plantaLib('valor sem classe vira disponivel', [["  return 'H';\n}", "  return 'D';\n}"]], 'okD1');
plantaLib('falta de leitura no patamar contada como zero', [['if (!n || !u) continue;', 'if (!u) continue;'], ['s.num[k] += (ok / n) * pn[sn];', 's.num[k] += (n ? ok / n : 0) * pn[sn];']], 'okD1');
plantaLib('amostra ausente contada como indisponivel (divide por 6)', [['s.num[k] += (ok / n) * pn[sn];', 's.num[k] += (ok / POR_MEIA) * pn[sn];']], 'okD1');
plantaLib('heranca comeca indisponivel', [["else if (ult[sn] !== false) ok += 1;", "else if (ult[sn] === true) ok += 1;"]], 'okD1');
plantaLib('heranca reiniciada a meia-noite', [['for (const d of dias) {\n    const acc = {};', 'for (const d of dias) {\n    for (const q of Object.keys(ult)) delete ult[q];\n    const acc = {};']], 'okD2');
plantaLib('patamar sem irradiancia entra no dia', [['if (g == null) continue;', 'if (g == null && f == null) continue;']], 'okD1');
plantaLib('limiar estrito (50 W/m² fora)', [['if (g >= LIMIAR_SOL) { ssol', 'if (g > LIMIAR_SOL) { ssol']], 'okD1');
plantaLib('limiar 49,9 W/m²', [['const LIMIAR_SOL = 50;', 'const LIMIAR_SOL = 49.9;']], 'okD1');
plantaLib('nominal ignorada (media simples dos inversores)', [['s.num[k] += (ok / n) * pn[sn]; s.den[k] += pn[sn];', 's.num[k] += (ok / n); s.den[k] += 1;']], 'okD1');
plantaLib('nominal ilegivel sem o padrao de 320 kW', [['pn[sn] = m || PN_PADRAO;', 'pn[sn] = m || 0;']], 'okD2');
plantaLib('troca ignorada: conta todo inversor com leitura', [["const u = regra === 'posicao' ? (pos ? pos.split('/')[0] : null) : o.ufv;", 'const u = o.ufv;']], 'okD1');
plantaLib('Complexo pela media simples das usinas', [['cx.sol[0] += CAPU[u] * l.disp_sol; cx.sol[1] += CAPU[u];', 'cx.sol[0] += l.disp_sol; cx.sol[1] += 1;']], 'okProduto');
plantaLib('no mesmo carimbo o zip velho ganha', [["if (nv[k] !== '.') v[k] = nv[k];", "if (v[k] === '.') v[k] = nv[k];"]], 'okJunta');
plantaLib('o zip novo substitui o dia inteiro', [['const a = o.dias[x.d];', 'const a = null;']], 'okJunta');
plantaLib('carimbo fora da grade conta como amostra', [["if (m[4] !== '00' || Number(m[3]) % 5) { o.fora += 1; continue; }", '']], 'okGrade');
plantaLib('janela que nao reinicia a heranca', [['.filter(naJanela).sort();', '.sort();']], 'okJanela');
plantaLib('duplicado ignorado (troca no primeiro dia do sucessor)', [['const e = x.ds.find((d) => !eDup(x.s, dono.s, d));', 'const e = x.ds[0];']], 'okTrocaJan');
plantaLib('troca so depois do ultimo dia do antigo', [['const e = x.ds.find((d) => !eDup(x.s, dono.s, d));', 'const e = x.ds.find((d) => d >= dono.ds[dono.ds.length - 1]);']], 'okTrocaJan');
plantaLib('por inversor: patamar sem sol entra', [['if (g != null && g >= LIMIAR_SOL) { const p = inv[pos]', 'if (g != null) { const p = inv[pos]']], 'okInv');
plantaLib('por inversor: amostra ausente contada como indisponivel', [['c.s += ok / n; c.n += 1;', 'c.s += ok / POR_MEIA; c.n += 1;']], 'okInv');
plantaLib('por inversor: inversor sem posicao entra pela pasta', [['if (opc.porInv && pos && n) {', 'if (opc.porInv && n) { const pos = opc.posNoDia(sn, d) || o.ufv + "/TS1/INV" + sn.slice(-2), u = pos.split("/")[0];']], 'okInv');
plantaLib('duplicado puro passa a valer', [["if (!e) { J[x.s] = { ini: null, fim: null }; continue; }", "if (!e) { J[x.s] = { ini: x.ds[0], fim: null }; continue; }"]], 'okTrocaJan');

/* ---------- 3 · o gerador de ponta a ponta ---------- */
console.log('\n3 · gen-sungrow de ponta a ponta (sem rede)');
function crc32(b) { let c; const t = crc32.t || (crc32.t = Array.from({ length: 256 }, (x, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let x = 0xFFFFFFFF; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; }
function zip(arqs) {                                     // zip minimo, metodo 8 (deflate), como o do logger
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
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sgdisp-'));
const GENP = path.join(__dirname, '_plantio_disp.js');
process.on('exit', () => { fs.rmSync(raiz, { recursive: true, force: true }); for (const f of [GENP, LIBP]) if (fs.existsSync(f)) fs.unlinkSync(f); });
const RAW = path.join(raiz, 'raw'), SC = path.join(raiz, 'scada'), OUT = path.join(raiz, 'out');
for (const d of [RAW, SC, OUT]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(raiz, 'inv_scada.json'), JSON.stringify({ serie: [] }));
/* o arquivo do PROPRIO logger (serial B), FORJADO com as tres colunas do estado, parado o dia inteiro: se entrar como
   inversor, o historico ganha uma serie B e a regra da leitura conta um inversor parado a mais */
const LOG_CAB = ['Horário', 'Utilização da CPU', 'Potência ativa total', 'Valor da amostra PT 1', 'Valor da amostra PT 2', 'Quantidade de inversores',
  'Número de dispositivos conectados à rede', 'Máx. potência ativa nominal total', 'Status do dispositivo', 'Código de falha', 'Potência ativa nominal'];
const logCsv = '﻿' + LOG_CAB.join(',') + '\n' + [D1, D2].flatMap((d) => Array.from({ length: 288 }, (_, i) => [d + ' ' + hhmm(i) + ':00', 10, 0, 300, 310, 5, 5, 0, 0x8000, 0, 3200].join(','))).join('\n') + '\n';
const zipM1 = path.join(RAW, 'M10', 'TS01', '01 A 05');
fs.mkdirSync(zipM1, { recursive: true }); fs.mkdirSync(path.join(RAW, 'M07', 'TS01', '01 A 05'), { recursive: true });
const VIDA = (sn) => 1000000 + Number(sn.slice(-3)) * 1000;
const arq = (sn, L, v) => ({ nome: 'hiscsv/HIS_' + sn + '_202609280000_202609292355.csv', dados: csv(CAB, L, v == null ? VIDA(sn) : v) });
/* X6: ARQUIVO DUPLICADO do X1 em D1 (as mesmas linhas e o MESMO contador de vida) com outro numero de serie, identificado na
   posicao do X1: nao antecipa a troca, o X1 segue valendo nos dois dias (M1/TS4 em 15/04 e 15/07/2026, M6/TS6 em 29/04/2026) */
const X6 = 'A0000000006', LX6 = LX1.filter((r) => r.t.startsWith(D1));
fs.writeFileSync(path.join(zipM1, '28.09 A 29.09.zip'), zip([arq(X1, LX1), arq(X2, LX2), arq(X3, LX3), arq(X4, LX4), arq(X5, LX5), arq(X6, LX6, VIDA(X1)),
  { nome: 'hiscsv/HIS_B0000000001_202609280000_202609292355.csv', dados: logCsv }]));
fs.writeFileSync(path.join(RAW, 'M07', 'TS01', '01 A 05', '28.09 A 29.09.zip'), zip([arq(Y1, LY1)]));
const IDENT = { esquema: 2, ident: Object.assign(Object.fromEntries(Object.entries(POS).map(([sn, pos]) => [sn, { pos, d: sn === X4 ? D2 : D1, metodo: 'ensaio' }])),
  { [X6]: { pos: 'M1/TS1/INV01', d: D2, metodo: 'ensaio' } }), busca: {}, sem_posicao: [] };
const grava = (n, o) => fs.writeFileSync(path.join(OUT, n), zlib.gzipSync(JSON.stringify(o)));
// arquivo que falta le como null (um plantio pode deixar de grava-lo: reprova pela checagem, nao por excecao do ensaio)
const le = (n) => (fs.existsSync(path.join(OUT, n)) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(OUT, n))).toString('utf8')) : null);
const semGerado = (n) => JSON.stringify(le(n), (k, v) => (k === 'gerado_em' ? undefined : v));
const apaga = (n) => { if (fs.existsSync(path.join(OUT, n))) fs.unlinkSync(path.join(OUT, n)); };
function roda(gen) {
  const env = Object.assign({}, process.env, { LOCAL_RAW_DIR: RAW, LOCAL_SCADA_DIR: SC, LOCAL_OUT_DIR: OUT, LOCAL_INV_SCADA: path.join(raiz, 'inv_scada.json') });
  delete env.LOCAL_RAW_LISTA; delete env.REFAZER;
  try { return { log: execFileSync('node', [gen], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { erro: String(e.stderr || '') + String(e.stdout || '') }; }
}
function cenarioGen(gen) {
  const R = { txt: {} };
  try { cenarioGen1(gen, R); } catch (e) { R.erro = 'ensaio: ' + e.message; }
  return R;
}
function cenarioGen1(gen, R) {
  for (const n of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, n));
  grava('sg_ident.json', IDENT); grava('estacao_logger_30min.json', ESTACAO);
  // 1 · primeira rodada
  const r1 = roda(gen);
  if (r1.erro) { R.erro = r1.erro.split('\n').filter(Boolean).slice(-2).join(' | '); return; }
  const P = le('sg_disp_dia.json') || { serie: [] }, H = le('sg_disp_hist.json') || { inv: {} };
  const linha = (d) => P.serie.find((x) => x.dia === d) || {};
  const conf = (r, u, e) => r[u + '_disp_sol_pct'] === pct(e.sol) && r[u + '_disp_24h_pct'] === pct(e.h24) && r[u + '_meias_sol'] === e.nsol && r[u + '_meias_sol_sem_logger'] === e.sem && r[u + '_inv_logger'] === e.inv;
  R.okGen = P.esquema === 1 && P.serie.length === 2 && conf(linha(D1), 'M1', ESP.M1[D1]) && conf(linha(D2), 'M1', ESP.M1[D2]) && conf(linha(D1), 'M7', ESP.M7[D1])
    && linha(D1).CX_disp_sol_pct === pct(cx(ESP.M1[D1].sol, 0.5)) && linha(D1).M2_disp_sol_pct === null && linha(D1).M5_inv_logger === 0;
  R.txt.gen = JSON.stringify({ M1: [linha(D1).M1_disp_sol_pct, linha(D1).M1_disp_24h_pct, linha(D2).M1_disp_24h_pct], inv: [linha(D1).M1_inv_logger, linha(D2).M1_inv_logger] });
  const PI = le('sg_disp_inv_dia.json') || { dias: [], inv: {} }, gi = (p, d) => { const x = PI.inv[p], i = PI.dias.indexOf(d); return x && i >= 0 ? [x.d[i], x.m[i]] : null; };
  R.okInvGen = PI.esquema === 1 && JSON.stringify(PI.dias) === JSON.stringify([D1, D2]) && Object.keys(PI.inv).sort().join() === Object.keys(ESPI).sort().join()
    && Object.keys(ESPI).every((p) => [D1, D2].every((d) => { const v = gi(p, d); return v && v[0] === pct(ESPI[p][d][0]) && v[1] === ESPI[p][d][1]; }));
  R.txt.invgen = JSON.stringify(PI.inv['M1/TS1/INV01'] || null);
  R.okSoInversor = JSON.stringify(Object.keys(H.inv).sort()) === JSON.stringify([X1, X2, X3, X4, X5, X6, Y1].sort()) && H.esquema === 1;
  R.txt.soinversor = Object.keys(H.inv).sort().join(' ');
  const antesP = semGerado('sg_disp_dia.json'), antesH = semGerado('sg_disp_hist.json');
  // 2 · nada novo: le zero zips e publica o mesmo
  const r2 = roda(gen);
  R.okIdem = !r2.erro && /novos ou mudados: 0/.test(r2.log) && semGerado('sg_disp_dia.json') === antesP && semGerado('sg_disp_hist.json') === antesH;
  // 3 · sem o historico da disponibilidade (404): relê TODOS os zips e publica o mesmo; e com o esquema velho, idem
  apaga('sg_disp_hist.json');
  const r3 = roda(gen);
  const ok3 = !r3.erro && /sem sg_disp_hist: todos/.test(r3.log) && semGerado('sg_disp_dia.json') === antesP && semGerado('sg_disp_hist.json') === antesH;
  grava('sg_disp_hist.json', { esquema: 0, inv: {} });
  const r3b = roda(gen);
  R.okRecarga = ok3 && !r3b.erro && /relendo todos os zips/.test(r3b.log) && semGerado('sg_disp_dia.json') === antesP && semGerado('sg_disp_hist.json') === antesH;
  // 4 · sem a irradiancia publicada: aborta (nao publica dia vazio)
  apaga('estacao_logger_30min.json');
  const r4 = roda(gen);
  R.okSemEstacao = !!r4.erro && /estacao_logger_30min\.json ausente/.test(r4.erro);
  grava('estacao_logger_30min.json', ESTACAO);
}
const GEN = path.join(__dirname, 'gen-sungrow.js');
const srcGen = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
const G = cenarioGen(GEN);
if (G.erro) ok(false, 'o gerador estourou: ' + G.erro);
const CG = ['okGen', 'okInvGen', 'okSoInversor', 'okIdem', 'okRecarga', 'okSemEstacao'];
for (const k of CG) ok(G[k], k + (G.txt[k.slice(2).toLowerCase()] ? ' ' + G.txt[k.slice(2).toLowerCase()] : ''));

console.log('\n4 · plantios no gerador (cada um roda o cenario inteiro)');
function planta(nome, de, para, chave) {
  if (srcGen.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou no gerador'); return; }
  try {
    fs.writeFileSync(GENP, srcGen.split(de).join(para));
    const R = cenarioGen(GENP);
    ok(!R.erro && R[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (R.erro ? ' (estourou: ' + R.erro.slice(0, 120) + ')' : ''));
  } finally { if (fs.existsSync(GENP)) fs.unlinkSync(GENP); }
}
planta('arquivo do logger contado como inversor', "if (t === 'inversor') { const dd = D.diaDisp(", "if (t === 'inversor' || t === 'estacao') { const dd = D.diaDisp(", 'okSoInversor');
planta('arquivo duplicado antecipa a troca (contador de vida ignorado)', 'return !!(a && b && a.vida != null', 'return false && !!(a && b && a.vida != null', 'okGen');
planta('publicado pela regra da leitura (todos com leitura)', "{ regra: 'posicao', posNoDia, porInv: true }", "{ regra: 'leitura', posNoDia, porInv: true }", 'okGen');
planta('sem historico nao relê os zips', 'const novos = releDisp ? raw : raw.filter(', 'const novos = raw.filter(', 'okRecarga');
planta('blob por inversor nao gravado', "pesos['sg_disp_inv_dia.json'] = await escreve('sg_disp_inv_dia.json', dInv);", '', 'okInvGen');
planta('historico da disponibilidade nao gravado', "pesos['sg_disp_hist.json'] = await escreve('sg_disp_hist.json', DH);", '', 'okIdem');
planta('estacao ausente calada', "if (!estLog || !Array.isArray(estLog.serie) || !estLog.serie.length) throw", 'if (false) throw', 'okSemEstacao');

console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio da disponibilidade pelo logger: tudo ok');
process.exit(falhas.length ? 1 : 0);
