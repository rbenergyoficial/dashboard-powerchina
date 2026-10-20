'use strict';
/*
 * lib-inv-logger.js — o dado de INVERSOR das telas pela fonte do logger Sungrow (fonte-inv-logger, 19/10/2026).
 *
 * Regra do humano (19/10/2026): dado de inversor vem do logger Sungrow, coletado a cada 5 min; o supervisorio (export PV_WS_TR,
 * parado desde 14/10/2026) fica so para comparar. As telas (portal, Grafana, gen-agente-om) leem `perdas_diario.json`,
 * `perdas_inv.json`, `strings_alarme.json` e `inv_scada.json` pelo NOME do blob e do campo; esta lib monta esses quatro com os
 * produtos do logger que o gen-sungrow ja publica, e o gen-inv-logger.js so le, chama e grava.
 *
 * DE ONDE VEM CADA COISA (todas do logger, menos o que esta marcado):
 *   disponibilidade da posicao no dia ......... sg_disp_inv_dia (estado a cada 5 min, NT-MRT-2026-0057; so as meias horas com
 *                                               irradiancia de LIMIAR_SOL W/m2 ou mais no datalogger da usina, estacao_logger_30min)
 *   parados / parciais / sem leitura .......... a mesma grade, com os limiares PARADO e PARCIAL da lib-disponibilidade
 *   cobertura (n_inv) ......................... posicoes com leitura nas meias horas de sol do dia
 *   energia CC e CA (cascata, conversao) ...... sg_saude.usina_dia (n_cc inversores com o dia inteiro, potencia de 5 min x 5/60 h)
 *   energia pelo contador (e_conta) ........... sg_saude_<u> (subida do contador de vida, so o inversor-dia inteiro)
 *   por inversor .............................. sg_saude_<u>, sg_inv_dia_<u> (p_max), sg_mppt_<k> (corrente do MPPT)
 *   strings em alarme ......................... sg_str_alarme (lib-strings sobre o pico de 5 min)
 *   abaixo dos pares .......................... sg_frota_dia (energia do dia pelo contador, so o dia inteiro), a regra do
 *                                               gen-inv-scada (o ensaio compila a dele e exige o mesmo resultado)
 *   medidor de faturamento (e_med, consumo) ... cmp_diario e way2_daily (Way2), a mesma conta do gen-perdas
 *   SUPERVISORIO, so onde o Comparativo o le .. `<u>_disp_pct`, `CX_disp_pct`, os `_disp_contrato_*` e a referencia de despacho
 *                                               (`_despacho_pct`, `_n_limitados`: o setpoint so existe no export) copiados do
 *                                               `perdas_diario_scada.json` (gen-perdas); a contagem do supervisorio vai ao lado,
 *                                               com o sufixo `_scada`, para o Comparativo repontar.
 *
 * 🔴 "SEM LEITURA" NAO E "PARADO": a posicao sem leitura com sol fica em `sem_leitura`, fora dos parados e fora do n_inv. E a usina-dia
 *    sem nenhuma meia hora de sol com irradiancia (estacao sem dado) nao e apurada: os campos ficam ausentes, nunca zero.
 * 🔴 GRANDEZA FISICA SO DO DIA INTEIRO (a regra do sg_saude): energia, conversao, potencia maxima, temperatura, isolamento, strings e
 *    MPPT do inversor-dia so quando o logger viu a janela de geracao nas duas pontas (p = 0). A disponibilidade nao depende disso.
 */
const { PLACA } = require('./lib-placa.js');
const { CAPU, USINAS, LIMIAR_SOL } = require('./lib-sungrow-disp.js');
const { PARADO, PARCIAL } = require('./lib-disponibilidade.js');

const ORIGEM = 'logger';                      // a marca do produto (o gen-perdas so semeia a copia do supervisorio sem ela)
const ESQUEMA = 4;                            // 1-3 sao os do gen-perdas (supervisorio); 4 = os campos de inversor pelo logger
const r2 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1e4) / 1e4);
const msDia = (dia) => Date.parse(dia + 'T00:00:00Z') + 3 * 3600e3;   // 00:00 BRT, o mesmo `ms` do gen-perdas
const mediana = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/* ---------------------------------------------------------------- a posicao no dia: parado, parcial, sem leitura ------------- */
/* sg_disp_inv_dia -> Map(dia -> { u: { lidas, parados, parciais, sem_leitura } }). Toda posicao da placa entra: a que nao esta no
   blob, ou esta com d nulo, e sem leitura. d em %: parado abaixo de PARADO x 100, parcial ate PARCIAL x 100 (os limiares do supervisorio) */
function classifica(dispInv) {
  const dias = (dispInv && dispInv.dias) || [];
  const out = new Map();
  dias.forEach((dia, i) => {
    const porU = {};
    for (const u of USINAS) porU[u] = { lidas: 0, parados: 0, parciais: 0, sem_leitura: 0 };
    for (const [pos, o] of Object.entries((dispInv && dispInv.inv) || {})) {
      const u = pos.split('/')[0]; if (!porU[u]) continue;
      const d = o.d ? o.d[i] : null;
      if (d == null) continue;
      porU[u].lidas += 1;
      if (d < PARADO * 100) porU[u].parados += 1; else if (d < PARCIAL * 100) porU[u].parciais += 1;
    }
    for (const u of USINAS) porU[u].sem_leitura = PLACA[u].inversores - porU[u].lidas;
    out.set(dia, porU);
  });
  return out;
}

/* ---------------------------------------------------------------- perdas_diario ---------------------------------------------- */
const CAMPOS_SCADA_U = ['_disp_pct', '_disp_contrato_pct', '_janela_contrato_h', '_disp_contrato_sem_leitura', '_despacho_pct', '_n_limitados'];
const CAMPOS_SCADA_DIA = ['CX_disp_pct', 'CX_disp_contrato_pct', 'janela_contrato_h'];
// os campos que as duas fontes publicavam com o MESMO nome: o do logger fica no nome, o do supervisorio ganha o sufixo
const RENOMEIA_SCADA_U = { _n_inv: '_n_inv_scada', _inv_parados: '_inv_parados_scada', _inv_parciais: '_inv_parciais_scada' };

/* o medidor por usina e dia (cmp_diario: w1..w9 = bruta recebida, MWh) e o liquido do way2_daily so do dia completo — a conta do gen-perdas */
function medidor(cmp, w2d) {
  const med = new Map();
  for (const l of ((cmp && cmp.serie) || [])) {
    const dia = String(l.t || '').slice(0, 10);
    const o = {};
    for (let i = 1; i <= 9; i++) if (l['w' + i] != null) o['M' + i] = l['w' + i];
    if (Object.keys(o).length) med.set(dia, o);
  }
  const liq = new Map();
  for (const l of ((w2d && w2d.dias) || [])) {
    if (!l.completo) continue;
    liq.set(l.dia, { ufv: l.ufv_liq_mwh || {}, ger: l.ene_ger_mwh, lq: l.ene_liq_mwh });
  }
  return { med, liq };
}

/* e_conta por usina e dia: a soma do `e` (kWh, subida do contador de vida) dos inversores-dia INTEIROS do sg_saude_<u> */
function contador(saudePorUsina) {
  const out = new Map();   // 'dia|u' -> { kwh, n }
  for (const [u, S] of Object.entries(saudePorUsina || {})) for (const r of ((S && S.serie) || [])) {
    if (r.p !== 0 || r.e == null) continue;
    const k = r.d + '|' + u, o = out.get(k) || out.set(k, { kwh: 0, n: 0 }).get(k);
    o.kwh += r.e; o.n += 1;
  }
  return out;
}

/* a serie diaria. fontes: { sgDisp, sgDispInv, sgSaude, saudePorUsina, cmp, w2d, scada } (scada = perdas_diario_scada.json, opcional) */
function diario(F) {
  const cls = classifica(F.sgDispInv);
  const disp = new Map(((F.sgDisp && F.sgDisp.serie) || []).map((r) => [r.dia, r]));
  const cas = new Map(((F.sgSaude && F.sgSaude.usina_dia) || []).map((r) => [r.d + '|' + r.ufv, r]));
  const cont = contador(F.saudePorUsina);
  const { med, liq } = medidor(F.cmp, F.w2d);
  const sc = new Map(((F.scada && F.scada.serie) || []).map((r) => [r.dia, r]));
  const dias = [...new Set([...disp.keys(), ...sc.keys()])].sort();
  const serie = [];
  for (const dia of dias) {
    const o = { dia, ms: msDia(dia) };
    const D = disp.get(dia), C = cls.get(dia), S = sc.get(dia);
    const jan = [];
    let scc = 0, sca = 0, okCC = 0, scon = 0, okCon = 0, smed = 0, okMed = 0;
    for (const u of USINAS) {
      const placa = PLACA[u].inversores;
      // a cobertura e a classificacao: so na usina-dia com meia hora de sol medida (sem irradiancia nao ha o que apurar)
      if (D && D[u + '_meias_sol'] > 0 && C) {
        const c = C[u];
        o[u + '_n_inv'] = c.lidas;
        o[u + '_n_placa'] = placa;
        o[u + '_cob_pct'] = r2((c.lidas / placa) * 100);
        o[u + '_inv_parados'] = c.parados;
        o[u + '_inv_parciais'] = c.parciais;
        o[u + '_inv_sem_leitura'] = c.sem_leitura;
        jan.push(D[u + '_meias_sol'] / 2);
      }
      const K = cas.get(dia + '|' + u);
      if (K && K.n_cc > 0 && K.ecc != null && K.eca != null) {
        o[u + '_e_cc'] = r2(K.ecc); o[u + '_e_ca'] = r2(K.eca); o[u + '_n_cc'] = K.n_cc;
        if (K.ecc > 1) o[u + '_perda_conv_pct'] = r2(((K.ecc - K.eca) / K.ecc) * 100);
        if (K.n_cc === placa) { scc += K.ecc; sca += K.eca; okCC++; }
      }
      const N = cont.get(dia + '|' + u);
      if (N && N.n) {
        o[u + '_e_conta'] = r2(N.kwh / 1000); o[u + '_n_conta'] = N.n;
        if (N.n === placa) { scon += N.kwh / 1000; okCon++; }
      }
      const L = liq.get(dia), m = (med.get(dia) || {})[u];
      if (L && L.ufv[u] != null && m != null && m > 1) {
        o[u + '_e_liq'] = r2(L.ufv[u]);
        o[u + '_consumo_mwh'] = r2(m - L.ufv[u]);
        o[u + '_consumo_pct'] = r2(((m - L.ufv[u]) / m) * 100);
      }
      if (m != null) {
        o[u + '_e_med'] = r2(m); smed += m; okMed++;
        // a razao medidor / contador so com o contador do parque inteiro da usina: com inversor faltando ela mede a cobertura
        if (N && N.n === placa && N.kwh > 1000) o[u + '_razao_med_conta'] = r4(m / (N.kwh / 1000));
      }
      if (S) {
        for (const c of CAMPOS_SCADA_U) if (S[u + c] != null) o[u + c] = S[u + c];
        for (const [de, para] of Object.entries(RENOMEIA_SCADA_U)) if (S[u + de] != null) o[u + para] = S[u + de];
      }
    }
    if (jan.length) o.janela_h = r2(mediana(jan));
    // o Complexo: tudo ou nada, como no gen-perdas, e com o parque INTEIRO no logger (senao a "perda" seria cobertura)
    if (okCC === USINAS.length) {
      o.Complexo_e_cc = r2(scc); o.Complexo_e_ca = r2(sca);
      o.Complexo_perda_conv_pct = r2(((scc - sca) / scc) * 100);
    }
    if (okCon === USINAS.length) o.Complexo_e_conta = r2(scon);
    if (okMed === USINAS.length) {
      o.Complexo_e_med = r2(smed);
      const L = liq.get(dia);
      if (L && L.ger > 1) {
        o.Complexo_e_bruto = r2(L.ger); o.Complexo_e_liq = r2(L.lq);
        o.Complexo_consumo_mwh = r2(L.ger - L.lq);
        o.Complexo_consumo_pct = r2(((L.ger - L.lq) / L.ger) * 100);
      }
      if (okCon === USINAS.length && scon > 1) o.Complexo_razao_med_conta = r4(smed / scon);
    }
    if (S) {
      for (const c of CAMPOS_SCADA_DIA) if (S[c] != null) o[c] = S[c];
      if (S.janela_h != null) o.janela_scada_h = S.janela_h;
    }
    serie.push(o);
  }
  return serie;
}

/* a cobertura do ultimo dia apurado de cada usina (o `cobertura_por_usina` da raiz, que a triagem e a tela de Ativos leem) */
function cobertura(serie) {
  const out = {};
  for (const u of USINAS) {
    const l = serie.filter((o) => o[u + '_n_inv'] != null).pop();
    if (!l) continue;
    const n = l[u + '_n_inv'], p = PLACA[u].inversores;
    out[u] = { dia: l.dia, n_inversores: n, inversores_de_placa: p, inversores_ausentes: p - n, cobertura_pct: r2((n / p) * 100),
      completa: n === p, parados: l[u + '_inv_parados'], parciais: l[u + '_inv_parciais'] };
  }
  return out;
}

/* ---------------------------------------------------------------- perdas_inv ------------------------------------------------- */
/* por inversor e dia, os ultimos `janela` dias. fontes: { saudePorUsina, invDiaPorUsina, mpptPorEtc, sgDispInv }, janela */
function porInversor(F, janela) {
  const di = (F.sgDispInv && F.sgDispInv.dias) || [];
  const ix = new Map(di.map((d, i) => [d, i]));
  const pmax = new Map();
  for (const [u, V] of Object.entries(F.invDiaPorUsina || {})) for (const x of ((V && V.serie) || [])) pmax.set(x.d + '|' + u + '|' + x.ts + '|' + x.inv, x);
  const mppt = new Map();
  for (const [k, M] of Object.entries(F.mpptPorEtc || {})) { const [u, ts] = k.split('_');
    for (const l of ((M && M.serie) || [])) mppt.set(l.d + '|' + u + '|' + ts + '|' + l.inv, l); }
  const todos = [];
  for (const [u, S] of Object.entries(F.saudePorUsina || {})) for (const r of ((S && S.serie) || [])) todos.push([u, r]);
  const dias = [...new Set(todos.map(([, r]) => r.d))].sort();
  const corte = dias.slice(-janela)[0] || '';
  const out = [];
  for (const [u, r] of todos) {
    if (r.d < corte) continue;
    const k = r.d + '|' + u + '|' + r.ts + '|' + r.inv;
    const inteiro = r.p === 0;
    const V = pmax.get(k), M = mppt.get(k);
    const l = { dia: r.d, ufv: u, ts: r.ts, inv: r.inv, parcial: r.p == null ? null : r.p };
    l.e_cc = inteiro && r.ecc != null ? r4(r.ecc / 1000) : null;
    l.e_ca = inteiro && r.eca != null ? r4(r.eca / 1000) : null;
    l.ef = inteiro && r.ecc > 0 && r.eca != null ? r4(r.eca / r.ecc) : null;
    l.p_ca_max = inteiro && V && V.p_max != null ? r2(V.p_max) : null;
    l.temp_max = inteiro && r.tm != null ? r.tm : null;
    l.isol_min = inteiro && r.iso != null ? r.iso : null;
    l.str_min_pct = inteiro && r.smin != null ? r.smin : null;
    l.str_max_pct = inteiro && r.smax != null ? r.smax : null;
    l.str_n = inteiro && r.sn != null ? r.sn : null;
    l.str_mortas = inteiro && r.smo != null ? r.smo : null;
    l.str_min_n = inteiro && r.sw != null ? r.sw : null;
    // o MPPT: a corrente de cada um contra a mediana dos irmaos no mesmo inversor (sg_mppt, a mediana do dia); o mais fraco
    const im = inteiro && M && Array.isArray(M.i) ? M.i.map((x, j) => [x, j + 1]).filter(([x]) => x != null) : [];
    if (im.length) { const [mn, j] = im.reduce((a, b) => (b[0] < a[0] ? b : a));
      l.mppt_min_pct = r2(mn * 100); l.mppt_n = im.length; l.mppt_min_n = j; }
    else { l.mppt_min_pct = null; l.mppt_n = null; l.mppt_min_n = null; }
    const i = ix.get(r.d), P = F.sgDispInv && F.sgDispInv.inv && F.sgDispInv.inv[u + '/' + r.ts + '/' + r.inv];
    l.disp_pct = i != null && P && P.d ? (P.d[i] == null ? null : r2(P.d[i])) : null;
    l.n = V && V.n != null ? V.n : null;
    out.push(l);
  }
  const ch = (l) => l.dia + '|' + l.ufv + '|' + l.ts + '|' + l.inv;
  out.sort((a, b) => (ch(a) < ch(b) ? -1 : ch(a) > ch(b) ? 1 : 0));
  return out;
}

/* ---------------------------------------------------------------- abaixo dos pares (inv_scada) -------------------------------- */
/* a MESMA regra do gen-inv-scada (comparaComPares e os agregados), sobre a energia do dia do logger. O ensaio compila a funcao do
   gen-inv-scada e exige o mesmo resultado sobre a mesma entrada: as duas copias nao divergem caladas */
const MIN_PARES = 5, MIN_DIAS = 10, TOP_SERIE = 20;
function comparaComPares(reg) {
  const porTS = {};
  for (const x of reg.inversores) (porTS[x.ts] = porTS[x.ts] || []).push(x.kwh);
  const medUsina = mediana(reg.inversores.map((x) => x.kwh).filter((v) => v > 0));
  const out = [];
  for (const x of reg.inversores) {
    const pares = (porTS[x.ts] || []).filter((v) => v > 0);
    const usouTS = pares.length >= MIN_PARES;
    const base = usouTS ? mediana(pares) : medUsina;
    out.push({ ts: x.ts, inv: x.inv, kwh: r2(x.kwh), razao: base > 0 ? r2(x.kwh / base) : null, base: usouTS ? 'ts' : 'usina', pares: pares.length });
  }
  return out;
}
/* sg_frota_dia -> as linhas (dia, ufv, ts, inv, kwh, razao, base): so o inversor-dia INTEIRO (p = '0') com energia lida */
function linhasPares(frota) {
  const dias = (frota && frota.dias) || [];
  const serie = [];
  dias.forEach((dia, i) => {
    const porU = {};
    for (const [pos, o] of Object.entries((frota && frota.inv) || {})) {
      if (!o.p || o.p[i] !== '0' || !o.e || o.e[i] == null) continue;
      const [u, ts, inv] = pos.split('/');
      (porU[u] || (porU[u] = [])).push({ ts, inv, kwh: o.e[i] });
    }
    for (const [u, L] of Object.entries(porU)) for (const x of comparaComPares({ inversores: L }))
      serie.push({ dia, ms: msDia(dia), ufv: u, ts: x.ts, inv: x.inv, kwh: x.kwh, razao: x.razao, base: x.base });
  });
  return serie;
}
function ranking(frota, agora) {
  const full = linhasPares(frota);
  const diasFull = [...new Set(full.map((l) => l.dia))].sort();
  const porInv = new Map();
  for (const s of full) {
    const k = s.ufv + '|' + s.ts + '|' + s.inv;
    const o = porInv.get(k) || porInv.set(k, { ufv: s.ufv, ts: s.ts, inv: s.inv, r: [], kwh: 0, dias: 0, de: s.dia, ate: s.dia }).get(k);
    if (s.razao != null) o.r.push(s.razao);
    o.kwh += s.kwh || 0; o.dias++;
    if (s.dia < o.de) o.de = s.dia;
    if (s.dia > o.ate) o.ate = s.dia;
  }
  const inversores = [...porInv.values()]
    .filter((o) => o.r.length >= Math.min(MIN_DIAS, diasFull.length))
    .map((o) => ({ ufv: o.ufv, ts: o.ts, inv: o.inv, chave: o.ufv + '/' + o.ts + '/' + o.inv, dias: o.dias,
      razao_mediana: r2(mediana(o.r)), razao_min: r2(Math.min(...o.r)), kwh_janela: r2(o.kwh), de: o.de, ate: o.ate }));
  const meds = inversores.map((x) => x.razao_mediana).filter((x) => x != null);
  const refM = mediana(meds);
  const desv = meds.map((x) => Math.abs(x - refM));
  const mad = mediana(desv);
  const escala = mad > 0 ? mad : desv.reduce((a, b) => a + b, 0) / (desv.length || 1);
  const refS = 1.4826 * escala;
  const refTipo = mad > 0 ? 'mediana dos afastamentos' : (refS > 0 ? 'média dos afastamentos (a frota está uniforme demais para a mediana)' : 'frota idêntica — não há desvio a medir');
  inversores.forEach((x) => { x.desvios = refS > 0 ? r2((x.razao_mediana - refM) / refS) : null; });
  inversores.sort((a, b) => a.razao_mediana - b.razao_mediana || (a.chave < b.chave ? -1 : 1));
  const top = new Set(inversores.slice(0, TOP_SERIE).map((x) => x.ufv + '|' + x.ts + '|' + x.inv));
  const serie_top = full.filter((l) => top.has(l.ufv + '|' + l.ts + '|' + l.inv)).map((l) => ({ ...l, chave: l.ufv + '/' + l.ts + '/' + l.inv }));
  const escopo = {
    pergunta: 'Qual inversor rende abaixo dos pares do mesmo transformador, antes de falhar.',
    fonte: 'registrador de dados do fabricante (logger), coleta a cada 5 min',
    grandeza: 'energia do dia pelo contador de energia total do inversor (a subida do contador no dia), so o dia que o registrador viu inteiro',
    par: 'mediana dos inversores do mesmo TS no mesmo dia; TS com menos de ' + MIN_PARES + ' reportando cai para a mediana da usina',
    dias_cobertos: diasFull.length, de: diasFull[0] || null, ate: diasFull[diasFull.length - 1] || null,
    inversores: inversores.length, linhas: full.length,
    referencia: { mediana: r2(refM), desvio_robusto: r2(refS), escala: refTipo, fora_3_desvios: inversores.filter((x) => x.desvios != null && x.desvios < -3).length },
    serie_top_de: TOP_SERIE,
  };
  return { atualizado: diasFull[diasFull.length - 1] || null, gerado_em: agora, origem_inversor: ORIGEM, esquema: ESQUEMA, escopo,
    ranking: inversores.slice(0, 60), inversores, serie_top };
}

/* ---------------------------------------------------------------- strings_alarme -------------------------------------------- */
/* o sg_str_alarme no contrato do strings_alarme (serie e resumo com os mesmos campos: a mesma lib-strings dos dois lados) */
function alarmes(sgStr, agora) {
  if (!sgStr || !Array.isArray(sgStr.serie) || !Array.isArray(sgStr.resumo)) throw new Error('sg_str_alarme sem serie ou sem resumo');
  return { gerado_em: agora, origem_inversor: ORIGEM, esquema: 2, fonte: sgStr.fonte || 'logger Sungrow, 5 min', ate: sgStr.ate || null,
    criterio: sgStr.regra || {}, resumo: sgStr.resumo, serie: sgStr.serie };
}

/* ---------------------------------------------------------------- disponibilidade para o executivo ------------------------- */
/* sg_disp_dia -> o mapa por dia que a lib-disponibilidade.mensal le: porUfv[u] = { disp_pct, n }, com n = a capacidade instalada
   (Capu, MW) como PESO dos grupos (o Complexo do logger e a media das usinas ponderada pela Capu, Tabela 3 da NT); janela_min =
   as meias horas de sol do dia (so serve para o mensal saber que o dia foi apurado) */
function porDiaExecutivo(sgDisp) {
  const porDia = new Map();
  for (const r of ((sgDisp && sgDisp.serie) || [])) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.dia || ''))) continue;
    const porUfv = {};
    let meias = 0;
    for (const u of USINAS) {
      const v = r[u + '_disp_sol_pct'];
      if (v != null && r[u + '_meias_sol'] > 0) { porUfv[u] = { disp_pct: v, n: CAPU[u] }; meias = Math.max(meias, r[u + '_meias_sol']); }
    }
    if (Object.keys(porUfv).length) porDia.set(r.dia, { janela_min: meias * 30, porUfv });
  }
  return porDia;
}

/* ---------------------------------------------------------------- a copia do supervisorio ------------------------------------ */
/* as copias que o gen-perdas e o gen-inv-scada passam a gravar com outro nome: [novo, antigo]. Na primeira rodada a copia nao existe e
   e SEMEADA com o blob antigo, so se ele nao tiver a marca do logger; com a marca e sem a copia, aborta (o historico do supervisorio se
   perdeu, quem decide e o humano); copia que ja traz a marca do logger (contaminada) tambem aborta */
const SEMENTES = [['perdas_diario_scada.json', 'perdas_diario.json'], ['perdas_inv_scada.json', 'perdas_inv.json'], ['strings_alarme_scada.json', 'strings_alarme.json']];
/* io: { existe(nome) -> bool, le(nome) -> objeto | null (so o 404 e null), log }. conteudo = false: so a existencia importa (o
   perdas_inv_scada tem ~3 MB: baixa-lo todo dia so para saber que existe e custo de saida). Devolve { j, semeada } */
async function copiaScada(io, novo, antigo, conteudo) {
  if (!conteudo && await io.existe(novo)) return { j: null, semeada: false };
  const ja = conteudo ? await io.le(novo) : null;
  if (ja && ja.origem_inversor) throw new Error(novo + ' traz a marca do ' + ja.origem_inversor + ': a copia do supervisorio esta contaminada. Nada gravado');
  if (ja) return { j: ja, semeada: false };
  const a = await io.le(antigo);
  if (!a) { if (io.log) io.log('  ⚠️ sem ' + novo + ' e sem ' + antigo + ': nenhuma copia do supervisorio para o Comparativo'); return { j: null, semeada: false }; }
  if (a.origem_inversor === ORIGEM) throw new Error(antigo + ' ja e do logger e ' + novo + ' nao existe: a copia do supervisorio se perdeu. Nada gravado');
  return { j: a, semeada: true };
}

/* o ultimo dia que a disponibilidade do logger JULGOU (alguma usina com meia hora de sol medida). A coleta da madrugada cria a
   linha do dia corrente e a do dia anterior antes de a estacao chegar, com meias_sol 0 em todas as usinas: essas linhas nao contam
   (20/10/2026: a trava comparava com a ultima linha e derrubou o sungrow.yml). */
function ultimoDiaJulgado(sgDisp) {
  const js = ((sgDisp && sgDisp.serie) || []).filter((o) => USINAS.some((u) => o[u + '_meias_sol'] > 0));
  return js.length ? js[js.length - 1].dia : null;
}

const METODO_DIARIO = 'Dado de inversor do registrador de dados do fabricante (logger), coletado a cada 5 min. Disponibilidade da '
  + 'posicao: estado de cada inversor a cada 5 min, so as meias horas com irradiancia no plano de ' + LIMIAR_SOL + ' W/m2 ou mais na '
  + 'estacao da usina; parado abaixo de ' + (PARADO * 100) + ' %, parcial ate ' + (PARCIAL * 100) + ' %; posicao sem leitura com sol '
  + 'fica em sem_leitura e nao conta como parada. Energia CC e CA: soma dos inversores com o dia inteiro (n_cc), potencia de 5 min. '
  + 'Medidor e consumo: medidor de faturamento.';

module.exports = { SEMENTES, copiaScada, ORIGEM, ESQUEMA, MIN_PARES, MIN_DIAS, TOP_SERIE, CAMPOS_SCADA_U, CAMPOS_SCADA_DIA, RENOMEIA_SCADA_U, METODO_DIARIO,
  classifica, medidor, contador, diario, cobertura, ultimoDiaJulgado, porInversor, comparaComPares, linhasPares, ranking, alarmes, porDiaExecutivo, msDia };
