/*
 * ensaio-irr-datalogger.js — a solarimetria das telas vem do DATALOGGER das estacoes, integralizada (lote fonte-pr-logger,
 * 19/10/2026; regra do humano: irradiancia do datalogger CR1000X, 10 min ja integralizado; o SCADA so no Comparativo).
 *
 *   --lib      · a REGRA da meia hora (lib-estacao-30min) em CSIXML forjado: campo pelo NOME (cabecalho em outra ordem le igual),
 *               rotulo pelo FIM (o registro de 00:10 e da meia hora 00:00), meia hora = media das tres medias de 10 min, as tres
 *               presentes (duas = nulo), chuva = soma, bateria = minimo, direcao = media vetorial (350 e 10 dao norte, nao 180),
 *               celulas de sujeira em decimos -> %, campo ausente estoura. PLANTIOS compilados da fonte da lib, provados plantados,
 *               cada um tem de reprovar: a meia hora pelo valor do instante :30 (amostra, nao integral), a meia hora com dois de
 *               tres registros (incompleta contada), a chuva promediada, a direcao pela media aritmetica.
 *   --produto  · sobre o publicado, depois do gen-irradiancia:
 *               1. irr_ufv, irr_30min, irr_60min e irr_plano_30min declaram `fonte_estacao` = datalogger;
 *               2. o `gti_w_<usina>` do irr_plano_30min e o `e<n>` do estacao_logger_30min (a meia hora do datalogger, outro leitor do
 *                  mesmo arquivo) no MESMO instante; PLANTIOS: o SCADA de volta (`scada_w` no lugar do `gti_w`) e o trapezio aplicado
 *                  a media tem de reprovar pela mesma conta;
 *               3. a HORA do irr_60min existe so com as DUAS meias horas do irr_30min e e a media delas (integralizada, nunca a
 *                  amostra do :00 nem a metade da hora); PLANTIO: a hora feita de uma meia hora so reprova;
 *               4. o `scada_w` (so do Comparativo) nunca aparece depois do ultimo dia do SCADA e nunca e igual ao `gti_w` em
 *                  todas as meias horas (seria o mesmo dado sob dois nomes).
 *   sem argumento, as duas.  BASE_DADOS=<pasta> le os blobs de uma pasta local.
 */
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return LD.pede(BASE + nome, { 'accept-encoding': 'gzip' })
    .catch((e) => { throw new Error('lib-le-dados: ' + String(e && e.message).replace(/^HTTP 404/, '404')); })
    .then((x) => { if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + nome); return deJson(x.buf); });
}

// ---- LIB -------------------------------------------------------------------------------------------------
function compila(troca) {
  const src = fs.readFileSync(path.join(__dirname, 'lib-estacao-30min.js'), 'utf8').replace(/\r\n/g, '\n');
  let mut = src;
  if (troca) { mut = src.split(troca[0]).join(troca[1]); if (mut === src) throw new Error('plantio nao plantado: "' + troca[0].slice(0, 60) + '" nao esta na lib'); }
  const m = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', mut)(m, m.exports, (q) => require(q.startsWith('.') ? path.join(__dirname, q) : q), __dirname);
  return m.exports;
}
// CSIXML forjado: os campos na ordem dada, um registro por [instante do fim, {campo: valor}]
function csixml(campos, regs) {
  return '<csixml><head><fields>' + campos.map((c) => '<field name="' + c + '" type="xsd:float"/>').join('') + '</fields></head><data>'
    + regs.map(([t, v]) => '<r time="' + t + ':00">' + campos.map((c, i) => '<v' + (i + 1) + '>' + (v[c] == null ? 'NAN' : v[c]) + '</v' + (i + 1) + '>').join('') + '</r>').join('')
    + '</data></csixml>';
}
function casosLib(S) {
  const f = [];
  const x = (c, m) => { if (!c) f.push(m); };
  const campos = S.CAMPOS.map((c) => c[1]).concat(['WS_Avg']);
  const base = (i) => Object.fromEntries(campos.map((c) => [c, 10 + i]));
  // 10:10, 10:20, 10:30 (a meia hora 10:00) e 10:40, 10:50 (a 10:30 so com dois)
  const v = [
    ['2026-10-16T10:10', Object.assign(base(0), { Irr_Tilted_1_Avg: 600, Precip_Tot: 0.2, batt_volt_Min: 13.1, WD_Avg: 350, WS_Avg: 2, Irr_Soil_Sens1_loss_Avg: 17 })],
    ['2026-10-16T10:20', Object.assign(base(1), { Irr_Tilted_1_Avg: 700, Precip_Tot: 0.4, batt_volt_Min: 12.9, WD_Avg: 10, WS_Avg: 2, Irr_Soil_Sens1_loss_Avg: 18 })],
    ['2026-10-16T10:30', Object.assign(base(2), { Irr_Tilted_1_Avg: 950, Precip_Tot: 0, batt_volt_Min: 13.3, WD_Avg: 0, WS_Avg: 2, Irr_Soil_Sens1_loss_Avg: 16 })],
    ['2026-10-16T10:40', Object.assign(base(3), { Irr_Tilted_1_Avg: 800 })],
    ['2026-10-16T10:50', Object.assign(base(4), { Irr_Tilted_1_Avg: 820 })],
  ];
  const ler = (cs) => S.le10(csixml(cs, v), 'forjado');
  const m = S.meias(ler(campos));
  const a = m.get('2026-10-16T10:00') || {};
  x(a.gti === 750, 'meia hora 10:00: media de 600, 700 e 950 = 750 (veio ' + a.gti + ') — o instante 10:30 sozinho daria 950');
  x(!m.has('2026-10-16T10:30') || m.get('2026-10-16T10:30').gti == null, 'meia hora 10:30 com dois de tres registros saiu com valor (' + (m.get('2026-10-16T10:30') || {}).gti + ')');
  x(a.chuva === 0.6, 'chuva da meia hora: soma 0,2 + 0,4 + 0 = 0,6 mm (veio ' + a.chuva + ')');
  x(a.bateria === 12.9, 'bateria da meia hora: o minimo dos tres minimos = 12,9 V (veio ' + a.bateria + ')');
  x(a.vento_dir != null && (a.vento_dir < 1 || a.vento_dir > 359), 'direcao de 350, 10 e 0 graus: media vetorial perto de 0 (veio ' + a.vento_dir + ') — a aritmetica daria 120');
  x(a.perda_suj1 === 1.7, 'perda de sujeira: decimos -> %, media de 17, 18 e 16 = 1,7 % (veio ' + a.perda_suj1 + ')');
  x(a.t_amb === 11, 'temperatura: media de 10, 11 e 12 = 11 (veio ' + a.t_amb + ')');
  const inv = S.meias(ler(campos.slice().reverse())).get('2026-10-16T10:00') || {};
  x(inv.gti === 750 && inv.chuva === 0.6, 'cabecalho em outra ordem leu outro campo (campo pela posicao, nao pelo nome)');
  let estourou = false; try { ler(campos.filter((c) => c !== 'ALBEDO_Avg')); } catch (e) { estourou = /ALBEDO_Avg/.test(e.message); }
  x(estourou, 'arquivo sem o campo ALBEDO_Avg nao estourou com o nome do campo');
  // rotulo pelo fim: o registro de 00:10 do dia 17 e da meia hora 00:00 do dia 17; o de 00:00 do dia 17 e da 23:30 do dia 16
  const vira = S.meias(S.le10(csixml(campos, [['2026-10-16T23:40', base(0)], ['2026-10-16T23:50', base(0)], ['2026-10-17T00:00', base(0)]]), 'virada'));
  x(vira.has('2026-10-16T23:30') && vira.get('2026-10-16T23:30').gti === 10, 'a meia hora 23:30 (registros 23:40, 23:50 e 00:00 do dia seguinte) nao saiu');
  // o produto colunar e as linhas: a grade comeca no primeiro instante e a estacao so tem linha entre o primeiro e o ultimo dado dela
  const col = S.colunar(new Map([[1, m], [2, new Map([['2026-10-16T11:00', { gti: 5 }]])]]));
  x(col.inicio === '2026-10-16T10:00' && col.n === 3 && col.estacoes.M2.gti[2] === 5 && col.estacoes.M1.gti[0] === 750, 'produto colunar fora da grade');
  const ln = S.linhas(Object.assign({ esquema: 1 }, col));
  x(ln.filter((l) => l.ufv === 'M2').length === 1 && ln.find((l) => l.ufv === 'M1').ts === '2026-10-16 10:00:00', 'linhas por estacao fora do intervalo com dado');
  return f;
}
function lib() {
  const f = casosLib(require('./lib-estacao-30min'));
  const PLANTIOS = [
    ['a meia hora pelo valor do instante :30 (amostra)', ['} else x = (v[0] + v[1] + v[2]) / 3;', '} else x = v[2];']],
    ['a meia hora com dois de tres registros (incompleta contada)', ['if (v.some((x) => x == null)) { res[k] = null; continue; }', 'if (v.every((x) => x == null)) { res[k] = null; continue; } for (let i = 0; i < 3; i++) if (v[i] == null) v[i] = v.find((y) => y != null);']],
    ['a chuva promediada', ["if (AGREGA[k] === 'soma') x = v[0] + v[1] + v[2];", "if (AGREGA[k] === 'soma') x = (v[0] + v[1] + v[2]) / 3;"]],
    ['a direcao pela media aritmetica', ["else if (AGREGA[k] === 'vetor') {", "else if (AGREGA[k] === 'vetor-desligado') {"]],
  ];
  for (const [nome, troca] of PLANTIOS) {
    let r;
    try { r = casosLib(compila(troca)); } catch (e) { f.push('plantio "' + nome + '": ' + e.message); continue; }
    if (!r.length) f.push('plantio "' + nome + '" nao reprovou nenhum caso');
    console.log('   plantio (' + nome + '): ' + r.length + ' caso(s) reprovado(s)');
  }
  return f;
}

// ---- PRODUTO ---------------------------------------------------------------------------------------------
async function produto() {
  const f = [];
  const [iu, j30, j60, p30, lg] = await Promise.all(['irr_ufv.json', 'irr_30min.json', 'irr_60min.json', 'irr_plano_30min.json', 'estacao_logger_30min.json'].map(getJSON));
  // 1 · a marca da fonte
  for (const [nome, b] of [['irr_ufv', iu], ['irr_30min', j30], ['irr_60min', j60], ['irr_plano_30min', p30]])
    if (b.fonte_estacao !== 'datalogger') f.push(nome + ': fonte_estacao "' + b.fonte_estacao + '" (esperado datalogger)');
  // 2 · gti_w = a meia hora do datalogger no mesmo instante (fora as meias horas retiradas por leitura travada)
  const E = new Map((lg.serie || []).map((x) => [String(x.t).slice(0, 16), x]));
  const trav = new Set();
  for (const t of iu.leituras_travadas || []) for (let h = t.ini; h <= t.fim + 1e-9; h += 0.5) trav.add(t.dia + 'T' + String(Math.floor(h)).padStart(2, '0') + ':' + (h % 1 ? '30' : '00') + '|' + t.ufv);
  const US = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
  const seg = (k) => new Date(Date.parse(k + ':00Z') + 18e5).toISOString().slice(0, 16);
  const P = new Map((p30.serie || []).map((x) => [String(x.t).slice(0, 16), x]));
  const confere = (val) => { let n = 0, d = 0; const ex = [];
    for (const [k, x] of P) { const e = E.get(k); if (!e) continue;
      for (const u of US) { const g = val(x, u, k), r = e['e' + u.slice(1)]; if (r == null || trav.has(k + '|' + u)) continue; if (g == null && x['gti_w_' + u] == null) continue;
        n++; if (g == null || Math.abs(g - r) > 0.1001) { d++; if (ex.length < 3) ex.push(k + ' ' + u + ' ' + g + ' x ' + r); } } }
    return { n, d, ex }; };
  const r = confere((x, u) => x['gti_w_' + u]);
  if (r.n < 1000) f.push('produto: so ' + r.n + ' meias horas do gti_w conferidas contra o datalogger');
  if (r.d) f.push('produto: ' + r.d + ' de ' + r.n + ' meias horas do gti_w fora da meia hora do datalogger (' + r.ex.join('; ') + ')');
  const pS = confere((x, u) => x['scada_w_' + u]);   // plantio: o SCADA de volta no gti_w
  const comScada = [...P.values()].filter((x) => US.some((u) => x['scada_w_' + u] != null)).length;
  if (comScada && !(pS.d > 0.5 * pS.n)) f.push('plantio (SCADA de volta como fonte da tela): so ' + pS.d + ' de ' + pS.n + ' diferentes — a conferencia nao pega');
  const pT = confere((x, u, k) => { const a = x['gti_w_' + u], b = P.get(seg(k)) && P.get(seg(k))['gti_w_' + u]; return a == null || b == null ? null : (a + b) / 2; });
  if (!(pT.d > 0.2 * pT.n)) f.push('plantio (trapezio aplicado a media): so ' + pT.d + ' de ' + pT.n + ' diferentes — a conferencia nao pega');
  console.log('   gti_w x datalogger: ' + r.n + ' meias horas, ' + r.d + ' diferentes · plantio SCADA de volta: '
    + (comScada ? pS.d + ' de ' + pS.n : 'sem scada_w nesta janela, nao plantado') + ' · plantio trapezio: ' + pT.d + ' de ' + pT.n);
  // 3 · a hora integralizada: so com as duas meias horas, e a media delas
  const M30 = new Map((j30.serie || []).map((x) => [String(x.t).slice(0, 16), x]));
  const UH = (j60.ufvs || []).filter(Boolean);
  const julgaHora = (serie60, m30) => { let n = 0, d = 0; const ex = [];
    for (const x of serie60) { const k = String(x.t).slice(0, 13), a = m30.get(k + ':00'), b = m30.get(k + ':30');
      if (!a && !b) continue;
      for (const u of UH) { const va = a && a[u], vb = b && b[u];
        if (va == null || vb == null) { if (x[u] != null) { d++; n++; if (ex.length < 3) ex.push(k + ' ' + u + ' com uma meia hora so = ' + x[u]); } continue; }
        n++; if (x[u] == null || Math.abs(x[u] - (va + vb) / 2) > 0.011) { d++; if (ex.length < 3) ex.push(k + ' ' + u + ' ' + x[u] + ' x ' + ((va + vb) / 2)); } } }
    return { n, d, ex }; };
  const S60 = j60.serie || [];
  const h = julgaHora(S60, M30);
  if (h.n < 1000) f.push('produto: so ' + h.n + ' horas do irr_60min conferidas');
  if (h.d) f.push('produto: ' + h.d + ' hora(s) do irr_60min nao integralizadas das duas meias horas (' + h.ex.join('; ') + ')');
  // PLANTIO: a hora de uma meia hora so. Numa copia, uma hora com as duas meias horas perde a de :30 e a hora fica com o valor
  // da de :00 (o que o gerador faria se aceitasse a metade da hora): tem de reprovar. Forjado sobre o dado real, sempre aplicavel.
  const alvo = S60.find((x) => { const k = String(x.t).slice(0, 13), a = M30.get(k + ':00'), b = M30.get(k + ':30');
    return a && b && UH.length && a[UH[0]] > 100 && b[UH[0]] != null && x[UH[0]] != null; });
  if (!alvo) f.push('plantio (hora de uma meia hora so): nenhuma hora com sol e as duas meias horas para plantar');
  else {
    const k = String(alvo.t).slice(0, 13), u = UH[0], m30p = new Map(M30);
    m30p.set(k + ':30', Object.assign({}, M30.get(k + ':30'), { [u]: null }));
    const plant = S60.map((x) => (x === alvo ? Object.assign({}, x, { [u]: M30.get(k + ':00')[u] }) : x));
    const hp = julgaHora(plant, m30p);
    if (hp.d <= h.d) f.push('plantio (hora feita de uma meia hora so): nao reprovou');
    console.log('   hora integralizada: ' + h.n + ' horas, ' + h.d + ' fora · plantio de uma meia hora so (' + k + ' ' + u + '): ' + (hp.d - h.d) + ' achado(s)');
  }
  // 4 · o scada_w: so ate o ultimo dia do SCADA e nao o mesmo dado do gti_w
  let iguais = 0, pares = 0;
  for (const x of P.values()) for (const u of US) if (x['scada_w_' + u] != null && x['gti_w_' + u] != null) { pares++; if (x['scada_w_' + u] === x['gti_w_' + u]) iguais++; }
  if (pares && iguais === pares) f.push('produto: scada_w igual ao gti_w em todas as ' + pares + ' meias horas (o mesmo dado sob dois nomes)');
  console.log('   scada_w (Comparativo): ' + comScada + ' linha(s) · ' + pares + ' pares com o gti_w, ' + iguais + ' iguais');
  return f;
}

(async () => {
  const modo = process.argv[2] || 'tudo';
  const f = [];
  if (modo === '--lib' || modo === 'tudo') { f.push(...lib()); console.log('   lib: casos forjados da meia hora do datalogger'); }
  if (modo === '--produto' || modo === 'tudo') f.push(...await produto());
  if (f.length) { f.slice(0, 30).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-irr-datalogger ' + modo + ': TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
