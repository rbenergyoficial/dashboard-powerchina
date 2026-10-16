/**
 * gen-agente-dia.js — publica agente_dia.json: o resumo DIÁRIO que o Assistente Inteligente do portal consulta para as páginas
 * novas (pedido do humano, 16/10/2026: "quero que atualize ele para que ele saiba todas as informações do portal conforme os dados").
 *
 * Por que um blob próprio: o agente_om.json é refeito a cada 5 min com teto de 50 KB, e os dados abaixo mudam uma vez por dia.
 * Este roda no fim dos três workflows que os alimentam (way2-hist, sungrow, estacao-logger), sem horário novo.
 *
 * Blocos, por entidade (Complexo, PPA, ML, M1–M9), cada um no mês do último dia fechado, no mês anterior e no ano:
 *   historico   way2_daily.json: líquida dos dias fechados, dias com a medição completa, fator de capacidade (só dias completos),
 *               melhor dia, bruta e perda até a entrega nos mesmos dias. É a MESMA regra da página Histórico (crivo_hist.py):
 *               no Complexo, os dois trafos e os 22 circuitos; na usina, a líquida da equação de rateio do medidor e a bruta dos
 *               circuitos dela; o contrato soma as usinas.
 *   perdas      sg_saude.json (logger) + way2_daily.json: a cascata CC → CA → 34,5 kV → líquida, só nos dias em que TODOS os
 *               inversores das usinas têm o dia inteiro (n_cc = placa) e a medição está completa; as etapas em % da CC. A mesma
 *               regra do painel "Do inversor à entrega" do Histórico.
 *   codigos     sg_saude.json: inversores com código do equipamento e da rede, por 100 inversor-dias de placa, no mês e nos últimos
 *               7 dias; a família do equipamento mais frequente (familia_dia).
 *   estacao     estacao_dia.json: por estação, o último dia completo (144 registros) e a média do mês (irradiação no plano e global,
 *               temperatura, vento, chuva).
 *   ppa         executivo.json serie_ufv: folga acumulada contra a meta e meses na meta, nos meses FECHADOS do ano.
 * A placa (inversores por usina) vem do inversores.json; a potência de cada usina é a outorga (a mesma do lib-sungrow-disp).
 *
 *   node scripts/gen-agente-dia.js            grava o blob (DADOS_STORAGE)
 *   LOCAL_OUT_DIR=<pasta> node ...            grava em arquivo
 */
'use strict';
const zlib = require('zlib');

const BASE = process.env.BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const OUT_BLOB = process.env.OUT_BLOB || 'agente_dia.json';
const U9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const GRUPO = { Complexo: U9, PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
U9.forEach((u) => { GRUPO[u] = [u]; });
const ENTIDADES = ['Complexo', 'PPA', 'ML'].concat(U9);
const CAP = { M1: 49.110, M2: 24.555, M3: 49.110, M4: 49.110, M5: 49.110, M6: 49.110, M7: 14.733, M8: 49.110, M9: 9.822 };   /* outorga (MW) */
const COD = '2025-09-01';        /* operação comercial: o ano de 2025 conta daqui */
const LOG0 = '2026-04-03';       /* o logger do fabricante começa aqui */
const TETO_KB = 60;
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const r3 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 1000) / 1000);

function puxa(url) {
  const https = require('https');
  return new Promise((ok, erro) => {
    const req = https.get(url, { headers: { 'Accept-Encoding': 'gzip' }, timeout: 180000 }, (res) => {
      if (res.statusCode !== 200) { erro(new Error('HTTP ' + res.statusCode + ' ' + url.split('/').pop())); res.resume(); return; }
      const p = []; res.on('data', (c) => p.push(c));
      res.on('end', () => { let b = Buffer.concat(p); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        try { ok(JSON.parse(b.toString('utf8').replace(/^﻿/, ''))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 180 s: ' + url.split('/').pop()))); req.on('error', erro);
  });
}

const LEGENDA = {
  unidades: 'Energia em MWh, potência em MW, irradiação em kWh/m² por dia, temperatura em °C, vento em m/s, chuva em mm, percentuais em %.',
  janelas: 'mes = o mês do último dia que o medidor fechou (até ontem); mes_anterior = o mês antes dele; ano = o ano desse dia, desde 01/01 '
    + '(em 2025, desde a operação comercial de 01/09). ultimos_7 = os 7 dias até o último fechado.',
  historico: 'liq_mwh: energia líquida entregue nos dias fechados. dias_completos: dias com todos os registros de 5 min. fc_pct: fator de '
    + 'capacidade (líquida sobre a potência instalada vezes 24 h), só nos dias completos. melhor: o dia completo de maior líquida. '
    + 'perda_entrega_pct: (bruta − líquida) / bruta nos mesmos dias; na usina, a líquida é a da equação de rateio do medidor, então a '
    + 'perda da usina é a do conjunto repartida pela equação, não uma medida própria dela.',
  perdas: 'A perda desde a energia CC que entrou nos inversores até a líquida, em % da CC: inv_pct no inversor (CC para CA, logger do '
    + 'fabricante), mt_pct na média tensão (do inversor aos circuitos de 34,5 kV do medidor), ent_pct até a entrega; tot_pct a soma. Só '
    + 'os dias em que todos os inversores têm o dia inteiro no logger e a medição está completa (dias). O logger começa em 03/04/2026.',
  codigos: 'Inversores que registraram código de falha ou alarme no dia, pelo logger do fabricante: equip = origem no equipamento, rede = '
    + 'origem na rede (volta sozinho). por100 = por 100 inversor-dias de placa. Só entra o usina-dia que o logger já trouxe (algum inversor '
    + 'com o dia inteiro e as contagens publicadas). familia_top = a família de código do equipamento com mais inversor-dias na janela.',
  estacao: 'Por estação solarimétrica (a estação de cada usina): ultimo_dia = o último dia com os 144 registros de 10 min; mes = média dos '
    + 'dias completos do mês (poa = irradiação no plano, ghi = global, kWh/m² por dia; ta = temperatura média, ta_max a máxima; '
    + 'ws = vento médio, ws_max a rajada; chuva = soma), tudo sobre os mesmos dias completos.',
  ppa: 'O contrato de PPA com a MBRF (M2, M3, M4, M5, M6, M8): folga_gwh = soma de (líquida − meta) nos meses FECHADOS do ano; '
    + 'meses_na_meta de meses_fechados. Em janeiro ainda não há mês fechado no ano: meses_fechados = 0 e folga_gwh nula.',
  fontes: 'A versão de cada arquivo de origem lida (data de geração): o ensaio só julga o resumo contra as mesmas versões.',
};

function datas(W) {
  const fech = W.dias.filter((x) => x.slots > 0).map((x) => x.dia).sort();
  const ult = fech[fech.length - 1];
  const mes = ult.slice(0, 7);
  const a = +mes.slice(0, 4), m = +mes.slice(5, 7);
  const mesAnt = (m === 1 ? a - 1 : a) + '-' + String(m === 1 ? 12 : m - 1).padStart(2, '0');
  const ini7 = new Date(Date.parse(ult + 'T12:00:00Z') - 6 * 86400e3).toISOString().slice(0, 10);
  const doMes = (mm) => fech.filter((d) => d.slice(0, 7) === mm && d >= COD && d <= ult);
  return { ult, mes, mesAnt, ano: mes.slice(0, 4), J: { mes: doMes(mes), mes_anterior: doMes(mesAnt), ano: fech.filter((d) => d.slice(0, 4) === mes.slice(0, 4) && d >= COD && d <= ult),
    ultimos_7: fech.filter((d) => d >= ini7 && d <= ult) } };
}

/* o dia da entidade no medidor: líquida, bruta e medição completa (a regra da página Histórico) */
function diaMedidor(WD, e, d) {
  const w = WD[d]; if (!w || !(w.slots > 0)) return null;
  const us = GRUPO[e];
  let l, b;
  if (e === 'Complexo') { l = w.ene_liq_mwh; b = w.ene_ger_mwh > 0 ? w.ene_ger_mwh : null; }
  else {
    if (!w.ufv_liq_mwh) return null;
    l = 0; for (const u of us) { const v = w.ufv_liq_mwh[u]; if (v == null) return null; l += v; }
    b = 0; if (!w.ufv_ger_mwh) b = null; else for (const u of us) { const v = w.ufv_ger_mwh[u]; if (v == null) { b = null; break; } b += v; }
    if (b != null && !(b > 0)) b = null;
  }
  const comp = e === 'Complexo' ? !!w.completo : !!(w.ufv_completo && w.ufv_completo[e]);
  return { l, b, comp };
}

function historico(WD, e, dias) {
  const cap = GRUPO[e].reduce((a, u) => a + CAP[u], 0);
  let l = 0, n = 0, lc = 0, nc = 0, b = 0, lb = 0, nb = 0, melhor = null;
  for (const d of dias) {
    const x = diaMedidor(WD, e, d); if (!x || x.l == null) continue;
    l += x.l; n++;
    if (x.comp) { lc += x.l; nc++; if (!melhor || x.l > melhor.mwh) melhor = { dia: d, mwh: r3(x.l) }; }
    if (x.b != null) { b += x.b; lb += x.l; nb++; }
  }
  return { dias: n, liq_mwh: r3(l), dias_completos: nc, fc_pct: nc ? r2(100 * lc / (cap * 24 * nc)) : null, melhor,
    bruta_mwh: nb ? r3(b) : null, liq_mesmos_dias_mwh: nb ? r3(lb) : null, dias_bruta: nb, perda_entrega_pct: nb ? r2(100 * (b - lb) / b) : null };
}

function perdas(WD, SG, PL, e, dias) {
  const us = GRUPO[e];
  let cc = 0, ca = 0, g = 0, l = 0, n = 0;
  for (const d of dias) {
    if (d < LOG0) continue;
    const x = diaMedidor(WD, e, d); if (!x || x.l == null || x.b == null || !x.comp) continue;
    let c1 = 0, c2 = 0, ok = true;
    for (const u of us) { const r = SG[u + '|' + d]; if (!r || !PL[u] || r.n_cc !== PL[u] || r.ecc == null || r.eca == null) { ok = false; break; } c1 += r.ecc; c2 += r.eca; }
    if (!ok) continue;
    cc += c1; ca += c2; g += x.b; l += x.l; n++;
  }
  if (!n) return { dias: 0 };
  const p = (a, b2) => r2(100 * (a - b2) / cc);
  return { dias: n, cc_mwh: r3(cc), ca_mwh: r3(ca), bruta_mwh: r3(g), liq_mwh: r3(l), inv_pct: p(cc, ca), mt_pct: p(ca, g), ent_pct: p(g, l), tot_pct: p(cc, l), perda_mwh: r3(cc - l) };
}

function codigos(S, PL, e, dias) {
  const us = GRUPO[e], D = new Set(dias);
  let eq = 0, rd = 0, den = 0, nd = 0; const fam = {};
  const conta = new Set();   /* o usina-dia que o logger ja trouxe: algum inversor com o dia inteiro e as duas contagens publicadas */
  for (const u of us) {
    const rows = (S.usina_dia || []).filter((r) => r.ufv === u && D.has(r.d) && r.n_inv > 0 && r.n_equip != null && r.n_rede != null);
    rows.forEach((r) => { eq += r.n_equip; rd += r.n_rede; den += PL[u] || 0; conta.add(u + '|' + r.d); });
    nd = Math.max(nd, rows.length);
  }
  (S.familia_dia || []).forEach((r) => { if (conta.has(r.ufv + '|' + r.d) && r.origem === 'equipamento' && r.n_inv != null) fam[r.fam] = (fam[r.fam] || 0) + r.n_inv; });
  const top = Object.keys(fam).sort((a, b) => fam[b] - fam[a] || (a < b ? -1 : 1))[0];
  return { dias: nd, equip: eq, rede: rd, por100_equip: den ? r2(100 * eq / den) : null, por100_rede: den ? r2(100 * rd / den) : null, familia_top: top ? { fam: top, inv_dias: fam[top] } : null };
}

function estacao(ED, u, mes) {
  const L = (ED.serie || []).filter((r) => r.u === u);
  const comp = L.filter((r) => r.n === 144 && r.poa != null).sort((a, b) => (a.d < b.d ? -1 : 1));
  const ud = comp[comp.length - 1];
  const Mc = L.filter((r) => r.d.slice(0, 7) === mes && r.n === 144);
  const media = (A, k) => { const v = A.map((r) => r[k]).filter((x) => x != null); return v.length ? r2(v.reduce((a, x) => a + x, 0) / v.length) : null; };
  const maxi = (A, k) => { const v = A.map((r) => r[k]).filter((x) => x != null); return v.length ? Math.max.apply(null, v) : null; };
  const soma = (A, k) => { const v = A.map((r) => r[k]).filter((x) => x != null); return v.length ? r2(v.reduce((a, x) => a + x, 0)) : null; };
  return {
    ultimo_dia: ud ? { dia: ud.d, poa: ud.poa, ghi: ud.ghi, ta: ud.ta, ta_max: ud.ta_max, ws: ud.ws, ws_max: ud.ws_max, chuva: ud.chuva } : null,
    mes: { mes, dias_completos: Mc.length, poa: media(Mc, 'poa'), ghi: media(Mc, 'ghi'), ta: media(Mc, 'ta'), ta_max: maxi(Mc, 'ta_max'), ws: media(Mc, 'ws'), ws_max: maxi(Mc, 'ws_max'), chuva: soma(Mc, 'chuva') },
  };
}

function ppa(X, ano, mesAberto) {
  const L = (X.serie_ufv || []).filter((r) => r.ufv === 'PPA' && r.mes.slice(0, 4) === ano && !r.parcial && r.mes < mesAberto && r.liquida_gwh != null && r.meta_gwh != null)
    .sort((a, b) => (a.mes < b.mes ? -1 : 1));
  let f = 0; L.forEach((r) => { f += r.liquida_gwh - r.meta_gwh; });
  return { ano, meses_fechados: L.length, meses_na_meta: L.filter((r) => r.liquida_gwh >= r.meta_gwh).length, folga_gwh: L.length ? r3(f) : null,
    de: L.length ? L[0].mes : null, ate: L.length ? L[L.length - 1].mes : null };
}

function monta(W, S, I, ED, X) {
  const WD = {}; W.dias.forEach((x) => { WD[x.dia] = x; });
  const SG = {}; (S.usina_dia || []).forEach((r) => { SG[r.ufv + '|' + r.d] = r; });
  const PL = (I.escopo || {}).inversores_por_parque || {};
  const T = datas(W);
  const R = { gerado: new Date().toISOString(), fontes: { way2_daily: W.atualizado || null, sg_saude: S.gerado_em || null, estacao_dia: ED.gerado_em || null,
      executivo: X.atualizado || null, inversores: I.atualizado || null },
    ultimo_dia_fechado: T.ult, mes: T.mes, mes_anterior: T.mesAnt, ano: T.ano, legenda: LEGENDA,
    historico: {}, perdas: {}, codigos: {}, estacao: {}, ppa: ppa(X, T.ano, T.mes) };   /* o mes do ultimo dia fechado ainda esta aberto */
  ENTIDADES.forEach((e) => {
    R.historico[e] = { mes: historico(WD, e, T.J.mes), mes_anterior: historico(WD, e, T.J.mes_anterior), ano: historico(WD, e, T.J.ano) };
    R.perdas[e] = { mes: perdas(WD, SG, PL, e, T.J.mes), mes_anterior: perdas(WD, SG, PL, e, T.J.mes_anterior), ano: perdas(WD, SG, PL, e, T.J.ano) };
    R.codigos[e] = { mes: codigos(S, PL, e, T.J.mes), ultimos_7: codigos(S, PL, e, T.J.ultimos_7) };
  });
  U9.forEach((u) => { R.estacao[u] = estacao(ED, u, T.mes); });
  return R;
}

function guarda(R) {
  /* so ausencia ESTRUTURAL bloqueia (revisor de ensaio, 16/10/2026): o dia zero e legitimo — o logger que ainda nao chegou no dia 02,
     o janeiro sem mes fechado do PPA, o ano sem dia com os 1.155 inversores inteiros. O Complexo sem dia fechado no mes e o medidor parado. */
  const mau = [];
  ['historico', 'perdas', 'codigos'].forEach((b) => ENTIDADES.forEach((e) => { if (!R[b] || !R[b][e]) mau.push(b + ' sem a entidade ' + e); }));
  U9.forEach((u) => { if (!R.estacao || !R.estacao[u]) mau.push('estacao sem a usina ' + u); });
  if (!R.ppa || R.ppa.meses_fechados == null) mau.push('ppa sem o bloco');
  if (R.historico && R.historico.Complexo && !(R.historico.Complexo.mes.dias > 0)) mau.push('o Complexo sem dia fechado no mes: o medidor parou?');
  const kb = Buffer.byteLength(JSON.stringify(R)) / 1024;
  if (kb > TETO_KB) mau.push('tamanho ' + kb.toFixed(1) + ' KB acima do teto de ' + TETO_KB);
  return { mau, kb };
}

async function grava(R) {
  const corpo = Buffer.from(JSON.stringify(R));
  if (LOCAL_OUT_DIR) { require('fs').writeFileSync(require('path').join(LOCAL_OUT_DIR, OUT_BLOB), corpo); return; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados');
  await c.getBlockBlobClient(OUT_BLOB).upload(corpo, corpo.length, { blobHTTPHeaders: { blobContentType: 'application/json; charset=utf-8', blobCacheControl: 'public, max-age=300' } });
}

async function main() {
  const [W, S, I, ED, X] = await Promise.all(['way2_daily.json', 'sg_saude.json', 'inversores.json', 'estacao_dia.json', 'executivo.json'].map((n) => puxa(BASE + n)));
  const R = monta(W, S, I, ED, X);
  const { mau, kb } = guarda(R);
  if (mau.length) { console.error('agente_dia: NAO gravado\n  ' + mau.join('\n  ')); process.exit(1); }
  await grava(R);
  console.log('agente_dia: ' + kb.toFixed(1) + ' KB · ultimo dia ' + R.ultimo_dia_fechado + ' · mes ' + R.mes + ' · Complexo: liquida ' + R.historico.Complexo.mes.liq_mwh
    + ' MWh, perda do inversor a entrega ' + R.perdas.Complexo.mes.tot_pct + ' %');
}

module.exports = { monta, guarda, historico, perdas, codigos, estacao, ppa, diaMedidor, GRUPO, ENTIDADES, CAP, LOG0, COD };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
