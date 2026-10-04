'use strict';
/*
 * lib-sungrow.js — le os CSV do logger Sungrow (zips do container `sungrow-raw`) e reduz cada aparelho a um resumo por dia.
 *
 * Quatro tipos de aparelho, reconhecidos pelo CABECALHO (o nome do arquivo so diz o numero de serie ou o endereco):
 *   inversor  SG350HX, 179 colunas: energia, potencias, temperatura, isolacao, estados, falhas, MPPT e strings
 *   pid       caixa PID (tipo 8510), 9 colunas: impedancia de isolamento CA, tensao e corrente de saida, temperatura,
 *             alarme, falha, estado. Duas por eletrocentro, no logger proprio da pasta `PID 100`
 *   estacao   o proprio logger, 81 colunas: potencia e setpoint do arranjo, inversores na rede, PT100
 *   io        modulo de E/S (tipo 8405): estados digitais. Lido e descartado neste lote
 *
 * 🔴 COLUNA PELO NOME, NUNCA PELA POSICAO. O cabecalho tem nomes repetidos ("Potência ativa total" aparece duas vezes no
 *    inversor, a segunda sempre zero), entao o nome vem com a OCORRENCIA. Mudar a ordem das colunas no logger nao muda o
 *    que se le; mudar o NOME estoura com o nome que faltou.
 * 🔴 ESCALAS, medidas em 03/10/2026 contra o export do SCADA no mesmo inversor e instante (14.256 pares, razao mediana
 *    1,0000): energia em 0,1 kWh; potencia em W; temperatura em 0,1 °C; eficiencia em 0,01 %; tensao do barramento e
 *    negativo-terra em 0,1 V; potencia nominal em 0,1 kW; isolacao em kΩ; setpoint do arranjo em 0,1 kW; taxa em ‰.
 * ⚠️ LEITURA-SENTINELA: 65535, 32767, 2147483647 e 4294967295 sao "sem leitura" no registro do logger, e viram nulo.
 */
const { energiaDoDia, passosDoDia } = require('./lib-contador-dia.js');

const SENT = new Set([65535, 32767, 2147483647, 4294967295, -32768]);
const num = (s) => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const n = Number(t);
  return Number.isFinite(n) && !SENT.has(n) ? n : null; };
const med = (a) => { const v = a.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[v.length >> 1] : null; };
const r = (x, k) => (x == null ? null : Math.round(x * 10 ** k) / 10 ** k);

function le(texto) {
  const L = String(texto).replace(/^\uFEFF/, '').split(/\r?\n/);
  const cab = L[0].split(',').map((x) => x.trim());
  const linhas = [];
  for (let i = 1; i < L.length; i += 1) {
    if (!/^\d{4}-\d\d-\d\d \d\d:\d\d/.test(L[i])) continue;
    const v = L[i].split(',');
    if (v[0].slice(0, 4) < '2020') continue;                 // os CSV vazios de jan-mar vem com carimbo de 1969
    linhas.push(v);
  }
  return { cab, linhas };
}

// indice da k-esima coluna com esse nome (k a partir de 0); -1 se nao existe
const col = (cab, nome, k) => { let n = -1; for (let i = 0; i < cab.length; i += 1) if (cab[i] === nome && ++n === (k || 0)) return i; return -1; };
const exige = (cab, nome, k, onde) => { const i = col(cab, nome, k); if (i < 0) throw new Error(onde + ': coluna "' + nome + '" ausente'); return i; };

function tipo(cab) {
  if (col(cab, 'Geração total') >= 0 && col(cab, 'Tensão MPPT1') >= 0) return 'inversor';
  if (col(cab, 'Impedância de isolamento AC(kΩ)') >= 0) return 'pid';
  if (col(cab, 'Utilização da CPU') >= 0) return 'estacao';
  if (col(cab, 'Status de DI 1') >= 0) return 'io';
  return null;
}

const porDia = (linhas) => { const m = new Map(); for (const v of linhas) { const d = v[0].slice(0, 10);
  (m.get(d) || m.set(d, []).get(d)).push(v); } for (const a of m.values()) a.sort((x, y) => (x[0] < y[0] ? -1 : 1)); return m; };
const conta = (vals) => { const o = {}; for (const x of vals) if (x != null) o[x] = (o[x] || 0) + 1; return o; };
const hhmm = (v) => v[0].slice(11, 16);

/* ------------------------------------------------------------ inversor ---------------------------------------------- */
function diaInversor(cab, linhas, onde) {
  const c = {
    vida: exige(cab, 'Geração total', 0, onde), diaria: exige(cab, 'Geração de energia ao longo do dia', 0, onde),
    p: exige(cab, 'Potência ativa total', 0, onde), pdc: exige(cab, 'Potência CC total', 0, onde),
    t: exige(cab, 'Temperatura de ar interna', 0, onde), iso: exige(cab, 'Impedância paralela em relação à terra', 0, onde),
    ef: exige(cab, 'Eficiência do inversor', 0, onde), lim: exige(cab, 'Modo de potência limitada', 0, onde),
    st: exige(cab, 'Status de operação do inversor', 0, onde), falha: exige(cab, 'Código de falha', 0, onde),
    pidSt: exige(cab, 'Estado de trabalho PID', 0, onde), pidF: exige(cab, 'Código de falha PID', 0, onde),
    vbus: exige(cab, 'Tensão do barramento', 0, onde), vneg: exige(cab, 'Tensão de pólo negativo / terra', 0, onde),
    hop: exige(cab, 'Tempo de operação diário', 0, onde), nom: exige(cab, 'Potência ativa nominal', 0, onde),
  };
  const out = [];
  for (const [d, L] of porDia(linhas)) {
    const g = (i, k) => L.map((v) => { const x = num(v[i]); return x == null ? null : x * k; });
    const inst = L.map((v) => v[0]);
    const P = g(c.p, 0.001), PDC = g(c.pdc, 0.001);
    const ger = P.map((x) => x != null && x > 1);              // gerando: mais de 1 kW
    const so = (a) => a.filter((x, i) => ger[i]);
    const iGer = ger.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    const e = energiaDoDia(g(c.vida, 0.1), inst, g(c.diaria, 0.1));
    const ef = g(c.ef, 0.01).filter((x, i) => P[i] != null && P[i] > 50);
    const vida = g(c.vida, 0.1).filter((x) => x != null);
    out.push({
      d, n: L.length,
      t0: hhmm(L[0]), t1: hhmm(L[L.length - 1]),               // primeira e ultima amostra: provam (ou nao) o dia inteiro
      e: r(e, 2),                                               // kWh, a subida do contador de vida (lib-contador-dia)
      vida: vida.length ? r(vida[vida.length - 1], 1) : null,   // contador de vida no fim do dia: identifica o inversor
      p_max: r(Math.max(...P.filter((x) => x != null), 0), 2),
      pdc_max: r(Math.max(...PDC.filter((x) => x != null), 0), 2),
      t_max: r(Math.max(...g(c.t, 0.1).filter((x) => x != null), -99), 1),
      t_med: r(med(so(g(c.t, 0.1))), 1),
      iso_min: r(Math.min(...so(g(c.iso, 1)).filter((x) => x != null && x > 0), 1e9), 0),
      ef_med: r(med(ef), 2),
      vbus_max: r(Math.max(...g(c.vbus, 0.1).filter((x) => x != null), 0), 1),
      vneg_min: r(Math.min(...g(c.vneg, 0.1).filter((x) => x != null), 0), 1),
      h_op: Math.max(...g(c.hop, 1).filter((x) => x != null), 0),
      ini: iGer.length ? hhmm(L[iGer[0]]) : null, fim: iGer.length ? hhmm(L[iGer[iGer.length - 1]]) : null,
      lim_pct: iGer.length ? r(100 * iGer.filter((i) => num(L[i][c.lim]) !== 0 && num(L[i][c.lim]) != null).length / iGer.length, 1) : null,
      nom: r(med(g(c.nom, 0.1)), 1),
      st: conta(L.map((v) => num(v[c.st]))),
      falha: conta(L.map((v) => num(v[c.falha])).filter((x) => x)),
      pid_st: conta(L.map((v) => num(v[c.pidSt]))),
      pid_falha: conta(L.map((v) => num(v[c.pidF])).filter((x) => x)),
    });
    const o = out[out.length - 1];
    if (o.iso_min === 1e9) o.iso_min = null;
    if (o.t_max === -99) o.t_max = null;
    // a potencia de 5 min (kW, uma casa), so para provar a qual TS o logger pertence; o gerador a separa do resumo
    o._p = {}; L.forEach((v, i) => { if (P[i] != null) o._p[hhmm(v)] = Math.round(P[i] * 10) / 10; });
  }
  return out;
}

/* ------------------------------------------------------------ PID -------------------------------------------------- */
const PID_COLS = { iso: 'Impedância de isolamento AC(kΩ)', v: 'Tensão de saída de potência(V)', i: 'Corrente de saída de potência(mA)',
  t: 'Temperatura interna da máquina(℃)', al: 'Estado de alarme', fa: 'Status de falha', st: 'Status' };
function seriePid(cab, linhas, onde) {
  const c = {}; for (const [k, n] of Object.entries(PID_COLS)) c[k] = exige(cab, n, 0, onde);
  return linhas.map((v) => ({ t: v[0].slice(0, 16), iso: num(v[c.iso]), v: num(v[c.v]), i: num(v[c.i]), temp: num(v[c.t]),
    al: num(v[c.al]), fa: num(v[c.fa]), st: num(v[c.st]) }));
}
function diaPid(serie) {
  const m = new Map(); for (const x of serie) { const d = x.t.slice(0, 10); (m.get(d) || m.set(d, []).get(d)).push(x); }
  const out = [];
  for (const [d, L] of m) {
    const vv = (k) => L.map((x) => x[k]).filter((x) => x != null);
    const iso = vv('iso').filter((x) => x > 0);
    /* 🔴 SEM "MINUTOS COM TENSAO" (esquema 2, 03/10/2026). A primeira versao contava toda amostra com v > 0, e a caixa
       parada le 1 a 2 V: o M1/TS5/6 somou 66.035 minutos em 90 dias com maximo de 2 V. A recuperacao de PID poe 500 Vdc
       entre string e terra (manual do usuario do SG350HX, cap. 2, p. 13-14, "por padrao"); um limiar entre os dois seria
       escolhido, nao lido. Fica a tensao MAXIMA do dia, que e medida */
    out.push({ d, n: L.length, iso_min: iso.length ? Math.min(...iso) : null, iso_med: med(iso),
      v_max: Math.max(...vv('v'), 0), i_max: Math.max(...vv('i'), 0), t_max: Math.max(...vv('temp'), -99),
      alarme: conta(L.map((x) => x.al).filter((x) => x)), falha: conta(L.map((x) => x.fa).filter((x) => x)),
      st: conta(L.map((x) => x.st)) });
    if (out[out.length - 1].t_max === -99) out[out.length - 1].t_max = null;
  }
  return out;
}

/* ------------------------------------------------------------ codigos de falha ------------------------------------- */
/* 🔴 O DICIONARIO E A TABELA DO FABRICANTE, nao uma leitura nossa: manual do usuario do SG350HX, secao 8.1 ("Codigo de
   falha / Nome da falha / Medidas corretivas"), p. 105 a 113. Duas classificacoes saem do proprio texto do manual:
   - tipo: 'alarme' quando o nome comeca com "Alarme" (o inversor pode continuar operando); senao 'falha' (o inversor
     para e desconecta o rele CA, tabela 7-2);
   - origem: 'rede' nos codigos cuja medida corretiva comeca por "o inversor e reconectado a rede depois que ela retorna
     ao estado normal" (sobre e subtensao, sobre e subfrequencia, ilhamento, rede anormal, desequilibrio); senao
     'equipamento'.
   As chaves (`fam`) sao neutras; o nome de tela sai da consulta do painel. Codigo fora da tabela: 'fora_manual'.
   ⚠️ O MANUAL SE SOBREPOE EM UM CODIGO: o 208 esta escrito por extenso em "Conexao reversa" (28, 29, 208, 212, 448-479) e
   cai dentro da faixa 200-211 de "Falha do sistema". Vale a citacao por extenso, que vem primeiro nesta lista.
   Nas familias por string, o manual da a string de cada codigo (532 = string 1) */
const FAIXAS = [
  ['sobretensao_rede', 'falha', 'rede', [[2, 3], [14, 15]]],
  ['subtensao_rede', 'falha', 'rede', [[4, 5]]],
  ['sobrefrequencia_rede', 'falha', 'rede', [[8, 8]]],
  ['subfrequencia_rede', 'falha', 'rede', [[9, 9]]],
  ['ilhamento', 'falha', 'rede', [[10, 10]]],
  ['fuga_corrente', 'falha', 'equipamento', [[12, 12]]],
  ['rede_anormal', 'falha', 'rede', [[13, 13]]],
  ['desequilibrio_rede', 'falha', 'rede', [[17, 17]]],
  ['conexao_reversa', 'falha', 'equipamento', [[28, 29], [208, 208], [212, 212], [448, 479]]],
  ['reversa_fv', 'alarme', 'equipamento', [[532, 547], [564, 579]], (c) => (c <= 547 ? c - 531 : c - 547)],
  ['entrada_anormal', 'alarme', 'equipamento', [[548, 563], [580, 595]], (c) => (c <= 563 ? c - 547 : c - 563)],
  ['temperatura_alta', 'falha', 'equipamento', [[37, 37]]],
  ['temperatura_baixa', 'falha', 'equipamento', [[43, 43]]],
  ['isolacao_baixa', 'falha', 'equipamento', [[39, 39]]],
  ['cabo_aterramento', 'falha', 'equipamento', [[106, 106]]],
  ['arco_eletrico', 'falha', 'equipamento', [[88, 88]]],
  ['medidor_reverso', 'alarme', 'equipamento', [[84, 84]]],
  ['medidor_comunicacao', 'alarme', 'equipamento', [[514, 514]]],
  ['conflito_rede', 'falha', 'equipamento', [[323, 323]]],
  ['comunicacao_paralela', 'alarme', 'equipamento', [[75, 75]]],
  ['falha_sistema', 'falha', 'equipamento', [[7, 7], [11, 11], [16, 16], [19, 25], [30, 34], [36, 36], [38, 38], [40, 42], [44, 50],
    [52, 58], [60, 69], [85, 85], [87, 87], [92, 93], [100, 105], [107, 114], [116, 124], [200, 211], [248, 255], [300, 322],
    [324, 328], [401, 412], [600, 603], [605, 605], [608, 608], [612, 612], [616, 616], [620, 620], [622, 624], [800, 800],
    [802, 802], [804, 804], [807, 807], [1096, 1122]]],
  ['alarme_sistema', 'alarme', 'equipamento', [[59, 59], [70, 74], [76, 83], [89, 89], [216, 218], [220, 232], [432, 434],
    [500, 513], [515, 518], [635, 638], [900, 901], [910, 911], [996, 996]]],
  ['mppt_reversa', 'falha', 'equipamento', [[264, 283]]],
  ['boost_sobretensao_alarme', 'alarme', 'equipamento', [[332, 363]]],
  ['boost_sobretensao', 'falha', 'equipamento', [[364, 395]]],
  ['corrente_reversa', 'falha', 'equipamento', [[1548, 1579]]],
  ['aterramento_fv', 'falha', 'equipamento', [[1632, 1655]]],
  ['hardware_sistema', 'falha', 'equipamento', [[1616, 1616]]],
];
function familia(cod) {
  const c = Number(cod);
  for (const [fam, tipo, origem, fx, str] of FAIXAS) {
    if (fx.some(([a, b]) => c >= a && c <= b)) return { fam, tipo, origem, ...(str ? { string: str(c) } : {}) };
  }
  return { fam: 'fora_manual', tipo: null, origem: null };
}

/* ------------------------------------------------------------ estacao ---------------------------------------------- */
function diaEstacao(cab, linhas, onde) {
  const o = (nome, k) => col(cab, nome, k || 0);
  const c = { p: o('Potência ativa total'), sp: o('Valor de potência FV ativa definida'), taxa: o('Taxa de potência ativa'),
    rede: o('Número de dispositivos conectados à rede'), qtd: o('Quantidade de inversores'), pt1: o('Valor da amostra PT 1'),
    pt2: o('Valor da amostra PT 2'), nom: o('Máx. potência ativa nominal total') };
  if (c.pt1 < 0) throw new Error(onde + ': estacao sem PT100');
  const out = [];
  for (const [d, L] of porDia(linhas)) {
    const g = (i, k) => (i < 0 ? [] : L.map((v) => { const x = num(v[i]); return x == null ? null : x * k; }).filter((x) => x != null));
    const P = g(c.p, 0.001);
    /* 🔴 A ENERGIA DO LOGGER NAO SERVE para dizer a qual TS ele pertence: o contador dele e a soma dos inversores ON-LINE
       (cai a noite quando eles desligam, e fica zerado de madrugada), e os TS de uma usina geram quase igual (M1: TS5 e
       TS6 a 0,4 %). Quem prova e a POTENCIA de 5 min: o logger registra a soma dos inversores que le, no mesmo carimbo */
    const pp = {}; L.forEach((v) => { const x = num(v[c.p]); if (x != null) pp[hhmm(v)] = Math.round(x / 100) / 10; });
    out.push({ d, n: L.length, _p: pp, p_max: r(Math.max(...P, 0), 1), qtd: Math.max(...g(c.qtd, 1), 0),
      rede_min: g(c.rede, 1).length ? Math.min(...L.filter((v, i) => (num(v[c.p]) || 0) > 1000).map((v) => num(v[c.rede])).filter((x) => x != null), 999) : null,
      sp_min: g(c.sp, 0.1).length ? r(Math.min(...g(c.sp, 0.1)), 1) : null, taxa_min: g(c.taxa, 0.1).length ? r(Math.min(...g(c.taxa, 0.1)), 1) : null,
      pt1_max: r(Math.max(...g(c.pt1, 1), -99), 1), pt2_max: r(Math.max(...g(c.pt2, 1), -99), 1),
      nom: r(med(g(c.nom, 1)), 1) });
    const x = out[out.length - 1];
    if (x.rede_min === 999) x.rede_min = null;
    for (const k of ['pt1_max', 'pt2_max']) if (x[k] === -99) x[k] = null;
  }
  return out;
}

module.exports = { le, tipo, col, num, diaInversor, seriePid, diaPid, diaEstacao, PID_COLS, energiaDoDia, passosDoDia, FAIXAS, familia };
