'use strict';
/*
 * lib-scada-db.js — le o historico de 5 min do BANCO do supervisorio (17/10/2026).
 *
 * Origem: a VM da usina extrai todo dia o banco do SCADA (Elipse E3, SQL Server), so leitura, para
 * `Automacoes_PWC\SCADA_DB\saida\AAAA-MM\<banco>_AAAA-MM-DD.zip`, e o backup do PC sobe a pasta para o contenedor
 * privado `backup-dados-scada`, prefixo `SCADA_DB/saida/`. A chave de envio so CRIA: arquivo que mudou sobe ao lado
 * como `<nome>~AAAAMMDD-HHMMSS`, e vale o mais novo.
 *
 * Daqui so interessa o banco `MRT` (subestacao): um CSV por cubiculo de 34,5 kV (`MRT_CUBx_y.csv`), separador `;`,
 * ponto decimal, primeira coluna `inicio_5min` (hora local de Brasilia, rotulo no INICIO do intervalo), 288 linhas.
 * A potencia ativa do circuito e `..._LD0_CVMMXN1_Watt` (MW) e a reativa `..._LD0_CVMMXN1_VolAmpr` (MVAr).
 *
 * 🔴 O VALOR E A MEDIA NO TEMPO dentro dos 5 min, nao a leitura pontual da planilha antiga. Entao a energia do
 *    intervalo e a media vezes a duracao, exata, e o trapezio do Comparativo NAO se aplica a estes dias.
 *
 * Circuito -> usina pelo unifilar de 05/10/2026. Os cubiculos que sobram (1_x, 8_1, 16_x, 9_2, 30_11) sao reserva,
 * servico auxiliar ou banco de capacitor e nao entram.
 * Soma TUDO-OU-NADA por intervalo: faltando um circuito da usina, o intervalo da usina fica sem valor. Somar so os
 * que vieram publicaria a usina com um terco a menos, parecendo corte.
 */
const { entradas } = require('./lib-zip.js');

const CIRCUITOS = {
  M1: ['2_1', '3_1', '5_1'],
  M2: ['6_1', '7_1'],
  M3: ['9_1', '10_1', '11_1'],
  M4: ['13_1', '14_1', '15_1'],
  M5: ['2_2', '3_2', '4_2'],
  M6: ['6_2', '7_2', '8_2'],
  M7: ['10_2'],
  M8: ['11_2', '12_2', '14_2'],
  M9: ['15_2'],
};
const PREFIXO = 'SCADA_DB/saida/';
// 🔴 So vale o zip da extracao que faz a media da RETA entre registros (`metodo.txt`, 17/10/2026). A versao anterior
//    segurava o ultimo registro, e na subida da manha e na descida da tarde o E3 passa 15-20 min sem registro: medido contra
//    o medidor de faturamento (out/25-fev/26), -1.341 MWh as 05-06 h e +1.215 MWh as 16-17 h. Zip sem a marca e ignorado.
const METODOS_ACEITOS = ['media_da_reta_entre_registros_v3'];   // v3 (17/10, sessao das coletas): registro fora da qualidade boa do OPC interrompe a reta; nenhum ZIP v2 chegou a ser gerado
const RE_NOME = /^SCADA_DB\/saida\/\d{4}-\d{2}\/MRT_(\d{4}-\d{2}-\d{2})\.zip(?:~(\d{8}-\d{6}))?$/;
const N5 = 288;

// O zip mais novo de cada dia: o nome sem sufixo e a primeira versao; as seguintes levam ~AAAAMMDD-HHMMSS.
function escolhe(nomes) {
  const por = new Map();
  for (const n of nomes) {
    const m = RE_NOME.exec(n);
    if (!m) continue;
    const k = m[2] || '';
    const a = por.get(m[1]);
    if (!a || k > a.k) por.set(m[1], { nome: n, k });
  }
  return new Map([...por].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([d, v]) => [d, v.nome]));
}

function num(s) {
  if (s == null || s === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

// Um CSV de cubiculo -> { P: [288], Q: [288] } (MW e MVAr medios; null = sem leitura boa no intervalo).
// Linha de outro dia, hora fora da grade de 5 min ou intervalo repetido ESTOURA: e arquivo que nao e o que se pensa.
function leCubiculo(txt, dia, cub, rotulo) {
  const linhas = txt.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l !== '');
  const cab = (linhas[0] || '').split(';');
  if (cab[0] !== 'inicio_5min') throw new Error(rotulo + ': primeira coluna "' + cab[0] + '", esperado inicio_5min');
  const sufP = 'CUB' + cub + '_LD0_CVMMXN1_Watt', sufQ = 'CUB' + cub + '_LD0_CVMMXN1_VolAmpr';
  const iP = cab.findIndex((c) => c.endsWith(sufP));
  const iQ = cab.findIndex((c) => c.endsWith(sufQ));
  if (iP < 0) throw new Error(rotulo + ': sem a coluna ' + sufP);
  const P = new Array(N5).fill(null), Q = new Array(N5).fill(null);
  const visto = new Set();
  for (let r = 1; r < linhas.length; r++) {
    const c = linhas[r].split(';');
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(c[0]);
    if (!m || m[1] !== dia) throw new Error(rotulo + ': linha ' + (r + 1) + ' com instante "' + c[0] + '" fora do dia ' + dia);
    const min = (+m[2]) * 60 + (+m[3]);
    if (min % 5) throw new Error(rotulo + ': instante ' + c[0] + ' fora da grade de 5 min');
    const i = min / 5;
    if (visto.has(i)) throw new Error(rotulo + ': instante ' + c[0] + ' repetido');
    visto.add(i);
    P[i] = num(c[iP]);
    if (iQ >= 0) Q[i] = num(c[iQ]);
  }
  return { P, Q };
}

// Um zip MRT -> { circ: { '2_1': {P, Q} }, faltam: ['8_2', ...] } (so os circuitos das usinas).
function leZip(buf, dia, rotulo) {
  const r = rotulo || ('MRT_' + dia + '.zip');
  const ent = new Map(entradas(buf, r).map((e) => [e.nome.split('/').pop(), e.dados]));
  const m = ent.get('metodo.txt');
  const metodo = m ? m.toString('utf8').replace(/^﻿/, '').trim() : null;
  if (!METODOS_ACEITOS.includes(metodo)) return { circ: {}, faltam: [], metodo, aceito: false };
  const circ = {}, faltam = [];
  for (const cs of Object.values(CIRCUITOS)) {
    for (const cub of cs) {
      const d = ent.get('MRT_CUB' + cub + '.csv');
      if (!d) { faltam.push(cub); continue; }
      circ[cub] = leCubiculo(d.toString('utf8'), dia, cub, r + '/MRT_CUB' + cub + '.csv');
    }
  }
  return { circ, faltam, metodo, aceito: true };
}

// Reparo do RTC do M3, o mesmo da planilha: o CUB10.1 registrou METADE da potencia ate 12/07/2026. A guarda olha a
// energia do circuito contra a mediana das irmas em TODOS os dias anteriores ao reparo que vieram nesta leitura:
// so dobra se estiver entre 35 % e 70 % (medido 17/10/2026 no banco: 0,66 antes; 1,31 depois, o circuito e maior).
// Devolve { razao, aplicado, dias } e, aplicado, dobra o P do CUB10.1 nesses dias (o Q nao: a reativa nao foi
// conferida contra o medidor).
const RTC_M3 = { cub: '10_1', irmas: ['9_1', '11_1'], antes: '2026-07-12', fator: 2, min: 0.35, max: 0.70 };
function reparaRtc(porDia) {
  const soma = (a) => a.reduce((s, v) => s + (v == null ? 0 : v), 0);
  let alvo = 0;
  const irmas = RTC_M3.irmas.map(() => 0);
  const dias = [];
  for (const [d, z] of porDia) {
    if (d >= RTC_M3.antes) continue;
    const c = z.circ;
    if (!c[RTC_M3.cub] || RTC_M3.irmas.some((i) => !c[i])) continue;
    dias.push(d);
    alvo += soma(c[RTC_M3.cub].P);
    RTC_M3.irmas.forEach((i, k) => { irmas[k] += soma(c[i].P); });
  }
  if (!dias.length) return { razao: null, aplicado: false, dias: 0 };
  const s = irmas.slice().sort((a, b) => a - b);
  const med = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  const razao = med > 0 ? alvo / med : null;
  const aplicado = razao != null && razao >= RTC_M3.min && razao <= RTC_M3.max;
  if (aplicado) {
    for (const d of dias) {
      const c = porDia.get(d).circ[RTC_M3.cub];
      c.P = c.P.map((v) => (v == null ? null : v * RTC_M3.fator));
    }
  }
  return { razao, aplicado, dias: dias.length };
}

// Um dia (circuitos ja reparados) -> por usina:
//   e5 [288] MWh por intervalo (media x 5/60), q5 [288] MVAr medio somado, completo = os 288 intervalos com todos os
//   circuitos da usina. null onde falta qualquer circuito.
function usinasDoDia(circ) {
  const out = {};
  for (const [pk, cs] of Object.entries(CIRCUITOS)) {
    if (cs.some((c) => !circ[c])) continue;
    const e5 = new Array(N5).fill(null), q5 = new Array(N5).fill(null);
    let n = 0;
    for (let i = 0; i < N5; i++) {
      let p = 0, q = 0, okP = true, okQ = true;
      for (const c of cs) {
        const v = circ[c].P[i], w = circ[c].Q[i];
        if (v == null) okP = false; else p += v;
        if (w == null) okQ = false; else q += w;
      }
      if (okP) { e5[i] = p * 5 / 60; n++; }
      if (okQ) q5[i] = q;
    }
    if (n) out[pk] = { e5, q5, completo: n === N5, intervalos: n };
  }
  return out;
}

// 5 min -> 15 min. Energia soma, e so com os TRES intervalos presentes; a reativa e a media dos tres.
function para15(e5, q5) {
  const e15 = new Array(96).fill(null), q15 = new Array(96).fill(null);
  for (let j = 0; j < 96; j++) {
    const e = e5.slice(j * 3, j * 3 + 3), q = q5.slice(j * 3, j * 3 + 3);
    if (e.every((v) => v != null)) e15[j] = e[0] + e[1] + e[2];
    if (q.every((v) => v != null)) q15[j] = (q[0] + q[1] + q[2]) / 3;
  }
  return { e15, q15 };
}

module.exports = { CIRCUITOS, PREFIXO, METODOS_ACEITOS, RE_NOME, N5, RTC_M3, escolhe, leCubiculo, leZip, reparaRtc, usinasDoDia, para15 };
