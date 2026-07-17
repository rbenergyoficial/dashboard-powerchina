/*
 * gen-executivo.js — dados/executivo.json : a fonte do painel "Visão Executiva" (entrada p/ diretoria/investidor).
 *
 * Lê (tudo blob PÚBLICO, só a ESCRITA precisa de chave):
 *   - dados/ons_restricao_all.json         complexo, semi-hora: ts,ger,lim,disp,gref,razao,orig
 *   - dados/ons_irradiancia_YYYY_MM.json   POR UFV (CEFMT1..9 = M1..M9), semi-hora: ts,u,irr,inv,ge,gv
 *   - dados/way2_daily.json                nossa medição diária (bruta/líquida/por UFV)
 *
 * FÓRMULAS — usa a definição JÁ VALIDADA do gen-ons-consolidado.js, não inventa:
 *   referencia = Σ(gref × H)                                        [MWh]
 *   frustrada  = Σ max(0, (gref − ger) × H), SÓ onde lim > 0        [MWh]   (max(0) porque o realizado às vezes supera a referência)
 *   disp_pct   = Σdisp / n_linhas / CAP_MW × 100                    [%]
 * ⚠️ DOIS "potenciais" DIFERENTES, não misturar (erro silencioso clássico):
 *   gref = referência do ONS (usada p/ frustrada)  ≠  ge = estimada por irradiância (usada p/ PR)
 *   PR   = Σgv / Σge × 100   ← este é o Performance Ratio de verdade (o pr_pct do ons_kpis é ger/gref, outra coisa)
 *
 * ESTRATÉGIA COMERCIAL (informada pelo usuário 2026-07-17): M1/M7/M9 estão FORA do PPA. Quando o ONS pede
 * limitação, a empresa limita esses 3 a ~1 MW p/ blindar a entrega do PPA (M2,3,4,5,6,8). Quando a meta do PPA
 * do mês já foi atingida, para de limitar o ML. Por isso o corte é MUITO maior no ML — é ESCOLHA, não azar.
 * Env: DADOS_STORAGE · OUT_CONTAINER=dados · OUT_BLOB=executivo.json · LOCAL_OUT p/ teste.
 */
const https = require('https');
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'executivo.json';
const CAP_MW = 343.77;      // outorga do complexo
const H = 0.5;              // intervalo ONS = 30 min
const RECONSTRUIR = process.env.RECONSTRUIR === '1';   // reconstrução do ge: DESLIGADA por padrão (ver bloco 2c)
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const INV_POR_PARQUE = { M1: 165, M2: 88, M3: 165, M4: 165, M5: 165, M6: 165, M7: 44, M8: 165, M9: 33 };
const MES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const lbl = m => MES_ABBR[+m.slice(5, 7) - 1] + '/' + m.slice(2, 4);
const r2 = x => Math.round(x * 100) / 100;
const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };

function getJSON(url) { return new Promise((res, rej) => { https.get(url, x => { if (x.statusCode !== 200) { x.resume(); return rej(new Error(x.statusCode + ' ' + url)); }
  let s = ''; x.on('data', c => s += c); x.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej); }); }
async function writeOut(obj) { const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob'); const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER); await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  return json.length; }

(async () => {
  const restr = await getJSON(BASE + 'ons_restricao_all.json');
  const daily = await getJSON(BASE + 'way2_daily.json');

  // ---------- 1) complexo por mês, a partir do ons_restricao_all ----------
  const M = {};   // mes -> acumuladores
  for (const r of restr.consolidado) {
    const mes = String(r.ts).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const m = M[mes] || (M[mes] = { ger: 0, ref: 0, fru: 0, disp: 0, n: 0, n_disp: 0, raz: {}, ori: {}, dias: new Set(), int_restr: 0 });
    const ger = num(r.ger), gref = num(r.gref), lim = num(r.lim);
    // disp=0 é AUSÊNCIA DE PUBLICAÇÃO, não indisponibilidade. A partir de 2026-07-07 o ONS parou de
    // publicar disp na janela 20h–04h (16 dos 48 intervalos, todo dia). Em 10 meses antes disso houve
    // ZERO zeros. Contar esses zeros como "usina parada" derrubou jul/26 p/ 79,46% com a planta intacta.
    // Media sobre os intervalos DECLARADOS; disp_cobertura expõe quantos foram, p/ queda real não se esconder.
    const dsp = num(r.disp); if (dsp > 0) { m.disp += dsp; m.n_disp++; }
    m.ger += ger * H; m.ref += gref * H; m.n++; m.dias.add(String(r.ts).slice(0, 10));
    if (lim > 0) { const perda = Math.max(0, (gref - ger) * H);   // <- definição da casa
      m.fru += perda; m.int_restr++;
      if (r.razao) m.raz[r.razao] = (m.raz[r.razao] || 0) + perda;
      if (r.orig) m.ori[r.orig] = (m.ori[r.orig] || 0) + perda; }
  }

  // ---------- 2) por UFV por mês, a partir do ons_irradiancia_YYYY_MM (ge = potencial, gv = realizado) ----------
  //
  // ⚠️ BURACO NA FONTE: o ONS só passou a preencher `ge` (geração estimada) de forma confiável a partir de
  // MAR/2026. Antes disso ele vem ZERO na hora do sol (set/25: 77% dos pontos!) — o que faz o PR (gv/ge)
  // explodir p/ 6769%. Mas o `irr` (irradiância) ESTÁ presente nesses meses. Então RECONSTRUÍMOS o ge a
  // partir do irr, com um modelo ajustado nos meses SADIOS da própria planta (auto-calibrado, sem datasheet).
  //
  // MODELO (escolhido por validação cega, não por gosto): razão MEDIANA de ge/irr por FAIXA de irradiância,
  // por UFV. Capta o derating térmico/clipping (ge/irr cai ~17% no sol forte) que uma reta ignora.
  // Validado escondendo JULHO/26 do ajuste e reconstruindo-o: MAE 1.45 MW · R² 98.34% · viés −0.43%.
  // (A reta pela origem dava R² 97.55% mas viés −5%, que num acumulado mensal EMPILHA em vez de cancelar.)
  const meses = Object.keys(M).sort();
  const BANDAS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 3000];
  const banda = i => { for (let b = BANDAS.length - 2; b >= 0; b--) if (i >= BANDAS[b]) return b; return 0; };
  const util = r => String(r.inv) !== 'True' && num(r.irr) > 5;      // ponto aproveitável (irradiância válida e com sol)

  const CRU = {};   // mes -> consolidado
  for (const mes of meses) { try { CRU[mes] = (await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado; } catch (e) { } }

  // 2a) quais meses são SADIOS (ge presente em >95% dos pontos com sol) → base do ajuste
  const saude = {};
  for (const mes of Object.keys(CRU)) { const sol = CRU[mes].filter(util);
    saude[mes] = sol.length ? 1 - sol.filter(r => num(r.ge) <= 0).length / sol.length : 0; }
  const sadios = Object.keys(CRU).filter(m => saude[m] > 0.95);

  // 2b) ajusta o modelo nos meses sadios
  const RETA = {}, FAIXA = {};
  { const porU = {};
    sadios.forEach(m => CRU[m].filter(r => util(r) && num(r.ge) > 0).forEach(r => (porU[r.u] = porU[r.u] || []).push({ irr: num(r.irr), ge: num(r.ge) })));
    Object.keys(porU).forEach(u => { const P = porU[u];
      RETA[u] = P.reduce((a, p) => a + p.irr * p.ge, 0) / P.reduce((a, p) => a + p.irr * p.irr, 0);
      FAIXA[u] = {};
      for (let b = 0; b < BANDAS.length - 1; b++) { const F = P.filter(p => banda(p.irr) === b).map(p => p.ge / p.irr).sort((x, y) => x - y);
        if (F.length >= 5) FAIXA[u][b] = F[Math.floor(F.length / 2)]; }
      let ult = RETA[u]; for (let b = 0; b < BANDAS.length - 1; b++) { if (FAIXA[u][b] == null) FAIXA[u][b] = ult; else ult = FAIXA[u][b]; }
    }); }
  const estimaGe = (u, irr) => ((FAIXA[u] || {})[banda(irr)] || RETA[u] || 0) * irr;

  // 2c) agrega, reconstruindo ge onde falta
  const IRR = {};             // mes -> { porUfv, ge, gv, irr_media, rec_pct }
  const RTC_M3_ATE = "2026-07-12"; const RTC_M3_FATOR = 0.80;
  const corteDiario = [];     // a virada da estratégia PPA x ML ao longo do tempo
  for (const mes of meses) {
    const C = CRU[mes]; if (!C) continue;
    const porUfv = {}; let ge = 0, gv = 0, irrSoma = 0, irrN = 0, geRec = 0, geTot = 0;
    const porDia = {};
    for (const r of C) {
      const u = String(r.u).replace('CEFMT', 'M');          // CEFMT1..9 == M1..M9 (confirmado pela assinatura de capacidade)
      const irr = num(r.irr); let g = num(r.ge); const v = num(r.gv); let rec = false;
      // Reconstrução DESLIGADA por padrão (RECONSTRUIR=1 p/ ligar). Decisão de 2026-07-17, com motivo:
      // o modelo é bom (R² 98.3% cego), mas os meses furados têm problema MAIS FUNDO que o ge faltante —
      // ago/set-25 a planta estava em RAMP-UP (0,66/0,84 GWh/dia vs 1,8 normal; pico 300 vs 345 MW), e em
      // out/25-fev/26 o modelo não transfere (dá PR de 115% a 161%, impossível). Reconstruir ali produziria
      // "número errado com cara de certo". Fica pronto p/ tapar buraco PONTUAL de um mês novo.
      if (RECONSTRUIR && g <= 0 && util(r)) { g = estimaGe(r.u, irr); rec = true; }   // chave é CEFMTn, não Mn!
      // ---- CORREÇÃO DO M3 (RTC) ----
      // Um cubículo do M3 tinha o RTC pela metade, então ONS/SCADA liam 80% do real. O Way2 lê o
      // MEDIDOR DE FATURAMENTO e nunca foi afetado — era ele que estava certo. Fator MEDIDO contra o
      // Way2, não arbitrado: 80/80/80/79/80/80/80/80/81/80% em 10 meses (dp 0,5pp). Corrigido
      // fisicamente em 12/07/2026 e a razão saltou p/ 100% — é o próprio dado provando o fator.
      // Prova cruzada: /0,80 leva o ge/MW do M3 de 83,4 p/ 104,3, dentro da faixa dos gêmeos de
      // 49,11 MW (103,8–110,1), e o corte de 8,1% (fora da curva) p/ 13,1% (junto dos irmãos).
      const dia_ = String(r.ts).slice(0, 10);
      let vv = v;
      if (u === 'M3' && dia_ < RTC_M3_ATE) { g = g / RTC_M3_FATOR; vv = v / RTC_M3_FATOR; }
      (porUfv[u] = porUfv[u] || { ge: 0, gv: 0 }); porUfv[u].ge += g * H; porUfv[u].gv += vv * H;
      ge += g * H; gv += vv * H; geTot += g * H; if (rec) geRec += g * H;
      if (util(r)) { irrSoma += irr; irrN++; }
      const dia = dia_; const grp = PPA.includes(u) ? 'ppa' : 'ml';
      const pd = porDia[dia] || (porDia[dia] = { ppa_ge: 0, ppa_gv: 0, ml_ge: 0, ml_gv: 0 });
      pd[grp + '_ge'] += g * H; pd[grp + '_gv'] += vv * H;
    }
    IRR[mes] = { porUfv, ge, gv, irr_media: irrN ? irrSoma / irrN : 0, rec_pct: geTot > 0 ? r2(100 * geRec / geTot) : 0 };
    Object.entries(porDia).sort().forEach(([dia, x]) => corteDiario.push({ dia, mes,
      ppa_corte_pct: x.ppa_ge > 0 ? r2(100 * Math.max(0, x.ppa_ge - x.ppa_gv) / x.ppa_ge) : 0,
      ml_corte_pct: x.ml_ge > 0 ? r2(100 * Math.max(0, x.ml_ge - x.ml_gv) / x.ml_ge) : 0 }));
  }
  const modelo = { tipo: 'razão mediana ge/irr por faixa de irradiância, por UFV',
    ajustado_em: sadios.map(lbl), validacao: 'cega em jul/26: MAE 1.45 MW · R² 98.34% · viés −0.43%',
    faixas_w_m2: BANDAS.length - 1 };

  // ---------- 3) série mensal consolidada ----------
  const serie = meses.map(mes => { const m = M[mes]; const i = IRR[mes] || { ge: 0, gv: 0, irr_media: 0 };
    const w2 = daily.dias.filter(x => String(x.dia).slice(0, 7) === mes);
    return { mes, lbl: lbl(mes), dias: m.dias.size,
      // mes_ts: o Grafana só desenha eixo de tempo / sparkline sobre timestamp — "2026-07" sozinho ele lê como texto
      mes_ts: mes + '-01T00:00:00Z',
      realizado_gwh: r2(m.ger / 1000), referencia_gwh: r2(m.ref / 1000), frustrada_gwh: r2(m.fru / 1000),
      frustrada_pct: (m.ger + m.fru) > 0 ? r2(100 * m.fru / (m.ger + m.fru)) : 0,
      potencial_irr_gwh: r2(i.ge / 1000), pr_pct: i.ge > 0 ? r2(100 * i.gv / i.ge) : null,
      disp_pct: m.n_disp ? r2(m.disp / m.n_disp / CAP_MW * 100) : null,
      disp_cobertura_pct: m.n ? r2(100 * m.n_disp / m.n) : null,
      irr_media: r2(i.irr_media), ge_reconstruido_pct: i.rec_pct,
      way2_liq_gwh: r2(w2.reduce((a, x) => a + num(x.ene_liq_mwh), 0) / 1000),
      way2_gwh_dia: w2.length ? r2(w2.reduce((a, x) => a + num(x.ene_ger_mwh), 0) / w2.length / 1000) : null,
      pico_mw: w2.length ? Math.round(Math.max(...w2.map(x => num(x.pico_mw)))) : null,
      horas_restricao: r2(m.int_restr * H), intervalos_restricao: m.int_restr,
      razoes: Object.fromEntries(Object.entries(m.raz).map(([k, v]) => [k, { gwh: r2(v / 1000), pct: m.fru > 0 ? r2(100 * v / m.fru) : 0 }])),
      origens: Object.fromEntries(Object.entries(m.ori).map(([k, v]) => [k, { gwh: r2(v / 1000), pct: m.fru > 0 ? r2(100 * v / m.fru) : 0 }])) };
  });

  // ---------- 3b) CLASSIFICA a confiabilidade de cada mês — o painel só mostra o que dá p/ DEFENDER ----------
  // ramp_up      : planta ainda em comissionamento → comparar potencial × realizado não significa nada.
  //                Detectado pela NOSSA medição (Way2), independente do ONS: ago/25 0,66 e set/25 0,84 GWh/dia
  //                contra ~1,8 do regime normal; pico 300 MW contra 345.
  // pr_confiavel : o ONS preencheu 'ge' E o PR caiu em faixa fisicamente plausível (50–95%).
  //                out/25–fev/26 dão PR de 97% a 161% = impossível → não publicamos.
  { const normais = serie.map(s => s.way2_gwh_dia).filter(x => x != null).sort((a, b) => a - b);
    const medianaDia = normais.length ? normais[Math.floor(normais.length / 2)] : null;
    serie.forEach(s => {
      s.ramp_up = !!(medianaDia != null && s.way2_gwh_dia != null && s.way2_gwh_dia < 0.7 * medianaDia);
      s.ge_faltante_pct = r2(100 * (1 - (saude[s.mes] != null ? saude[s.mes] : 0)));
      s.pr_confiavel = !s.ramp_up && s.ge_faltante_pct < 5 && s.pr_pct != null && s.pr_pct >= 50 && s.pr_pct <= 95;
      if (!s.pr_confiavel) { s.pr_pct = null; s.potencial_irr_gwh = null; }   // não publica o indefensável
      s.nota = s.ramp_up ? 'Planta em ramp-up (comissionamento) — potencial e PR nao sao comparaveis'
        : (!s.pr_confiavel ? 'ONS nao preencheu a geracao estimada neste mes — PR e potencial indisponiveis' : null);
    }); }

  // ---------- 4) mês corrente + projeção + cascata + PPA×ML ----------
  const mesAtual = meses[meses.length - 1];
  const cur = serie.find(s => s.mes === mesAtual);
  const diasTotal = new Date(+mesAtual.slice(0, 4), +mesAtual.slice(5, 7), 0).getDate();
  const fator = cur.dias > 0 ? diasTotal / cur.dias : 1;
  const iCur = IRR[mesAtual] || { porUfv: {} };

  // ---- M7: geração realizada vem do WAY2, não do ONS ----
  // O ONS cadastrou o medidor do M7 como M3 circuito 2 (corrigido no ONS em 16/07/2026). Em jul/26 o
  // gv do ONS p/ o M7 é 173% do Way2 — e dava gv > ge (105%), o que zerava o corte por construção.
  // O Way2 lê o medidor de FATURAMENTO e é a verdade comercial. Validação que autoriza a troca: nos 7
  // parques de tag boa o corte por ONS e por Way2 concordam dentro de 0,2pp (41,7/41,6 · 12,6/12,7 ·
  // 15,1/15,2 · 14,6/14,6 · 15,6/15,8 · 18,3/18,4 · 48,5/48,3) — o Way2 é substituto medido, não palpite.
  // Resultado: o corte do M7 aparece em 39,0%, junto dos irmãos de ML (M1 41,6% · M9 48,3%).
  const W2_UFV = {};
  daily.dias.filter(x => String(x.dia).slice(0, 7) === mesAtual)
    .forEach(x => Object.entries(x.ufv_liq_mwh || {}).forEach(([u, v]) => { W2_UFV[u] = (W2_UFV[u] || 0) + num(v); }));
  const VIA_WAY2 = ['M7'];   // sai daqui quando o dado ONS pós-16/07 for validado
  const realizado = u => VIA_WAY2.includes(u) && W2_UFV[u] > 0 ? W2_UFV[u] : ((iCur.porUfv[u] || {}).gv || 0);

  const grupo = g => { const us = g === 'ppa' ? PPA : ML;
    const ge = us.reduce((a, u) => a + ((iCur.porUfv[u] || {}).ge || 0), 0);
    const gv = us.reduce((a, u) => a + realizado(u), 0);
    return { potencial_gwh: r2(ge / 1000), realizado_gwh: r2(gv / 1000), corte_gwh: r2(Math.max(0, ge - gv) / 1000),
      corte_pct: ge > 0 ? r2(100 * Math.max(0, ge - gv) / ge) : 0 }; };

  const potencial = cur.potencial_irr_gwh, entregue = cur.realizado_gwh, cortado = cur.frustrada_gwh;
  const outras = r2(Math.max(0, potencial - entregue - cortado));
  const mes = { mes: mesAtual, lbl: cur.lbl, dias_decorridos: cur.dias, dias_total: diasTotal,
    realizado_gwh: entregue, potencial_gwh: potencial, frustrada_gwh: cortado, frustrada_pct: cur.frustrada_pct,
    pr_pct: cur.pr_pct, disp_pct: cur.disp_pct, disp_cobertura_pct: cur.disp_cobertura_pct,
    irr_media: cur.irr_media, ge_reconstruido_pct: cur.ge_reconstruido_pct,
    horas_restricao: cur.horas_restricao, razoes: cur.razoes, origens: cur.origens,
    // PROJEÇÃO: ritmo médio diário × dias restantes. NÃO é previsão do ONS (não existe pública além de D+1).
    projecao: { realizado_gwh: r2(entregue * fator), frustrada_gwh: r2(cortado * fator),
      metodo: 'ritmo médio diário do mês corrente × dias restantes (projeção estatística simples)',
      base_dias: cur.dias, dias_total: diasTotal },
    cascata: [
      { etapa: 'Entregue', gwh: entregue, pct: potencial > 0 ? r2(100 * entregue / potencial) : 0 },
      { etapa: 'Cortado pelo ONS', gwh: cortado, pct: potencial > 0 ? r2(100 * cortado / potencial) : 0 },
      { etapa: 'Outras perdas', gwh: outras, pct: potencial > 0 ? r2(100 * outras / potencial) : 0 },
    ],
    // planos p/ o Grafana: o Infinity não resolve seletor com índice (cascata[0].pct) nem inventa
    // rótulo onde o objeto só tem número — o dado tem que nascer pronto aqui.
    pct_entregue: potencial > 0 ? r2(100 * entregue / potencial) : 0,
    pct_cortado: potencial > 0 ? r2(100 * cortado / potencial) : 0,
    pct_outras: potencial > 0 ? r2(100 * outras / potencial) : 0,
    pico_mw: cur.pico_mw,
    ppa: grupo('ppa'), ml: grupo('ml'),
    // barchart precisa de um campo string no eixo → grupo vira coluna, não chave de objeto
    grupos: [Object.assign({ grupo: 'PPA' }, grupo('ppa')), Object.assign({ grupo: 'ML' }, grupo('ml'))],
  };

  // ---------- 5) por UFV (mês corrente) ----------
  // QUARENTENA DE TAG (informado pela operação em 2026-07-17): o ONS registrava o medidor do M7 como
  // M3 circuito 2. Corrigido no ONS em 2026-07-16. Efeito visível no dado: M7 com gv/ge = 105% (geração
  // verificada MAIOR que a estimada — impossível) e M3 com ge ~20% abaixo dos gêmeos de 49,11 MW.
  // Enquanto não houver dado ONS pós-correção validado, esses dois NÃO publicam corte: 0% falso engana
  // mais que lacuna assumida. O detector é o próprio dado (gv > ge), não uma data no código.
  const porUfv = Object.keys(INV_POR_PARQUE).sort().map(u => { const x = iCur.porUfv[u] || { ge: 0, gv: 0 };
    const gv = realizado(u);
    const viaWay2 = VIA_WAY2.includes(u) && W2_UFV[u] > 0;
    const m3corr = u === 'M3' && mesAtual <= RTC_M3_ATE.slice(0, 7);
    return { ufv: u, grupo: PPA.includes(u) ? 'PPA' : 'ML', inversores: INV_POR_PARQUE[u],
      potencial_gwh: r2(x.ge / 1000), realizado_gwh: r2(gv / 1000),
      fonte_realizado: viaWay2 ? 'Way2 (medidor de faturamento)' : 'ONS (geracao verificada)',
      nota: viaWay2 ? 'Geracao realizada vem do WAY2, nao do ONS: o ONS cadastrou o medidor do M7 como M3 circuito 2 (corrigido no ONS em 16/07/2026) e publicava 173% do real, o que zerava o corte por construcao (gv > ge). O Way2 le o medidor de faturamento. Validacao: nos 7 parques de tag boa, corte por ONS e por Way2 concordam dentro de 0,2pp. Volta p/ o ONS quando o dado pos-16/07 for validado.'
        : (m3corr ? 'Potencial e realizado do ONS corrigidos pelo fator MEDIDO de 0,80: um cubiculo do M3 tinha o RTC pela metade, entao ONS/SCADA liam 80% do real (o Way2, que le o medidor de faturamento, sempre esteve certo). Fator estavel em 10 meses (dp 0,5pp) e confirmado pelo salto p/ 100% apos o reparo em 12/07/2026.' : null),
      corte_gwh: r2(Math.max(0, x.ge - gv) / 1000),
      corte_pct: x.ge > 0 ? r2(100 * Math.max(0, x.ge - gv) / x.ge) : 0 }; });

  const out = { atualizado: new Date().toISOString(), cap_mw: CAP_MW, mes_atual: mesAtual,
    // META: PENDENTE — virá da planilha do SharePoint (P50/P90/PPA). Alvos confirmados pelo usuário.
    meta: { fonte: 'PENDENTE — planilha SharePoint (P50/P90/PPA)', p50_gwh: null, p90_gwh: null, ppa_mwh: null, pr_alvo_pct: 90, disp_alvo_pct: 97 },
    estrategia: { ppa: PPA, ml: ML, regra: 'Na limitação do ONS, M1/M7/M9 (fora do PPA) são limitados a ~1 MW para blindar a entrega do PPA. Atingida a meta do PPA no mês, o ML deixa de ser limitado.' },
    // corte_diario: últimos 75 dias, NÃO só o mês corrente — no dia 5 do mês um recorte mensal
    // deixaria o gráfico praticamente vazio, e a virada de mês é justamente onde a leitura interessa.
    modelo_ge: modelo, mes, por_ufv: porUfv, serie, corte_diario: corteDiario.slice(-75) };

  const size = await writeOut(out);
  console.log('executivo.json OK · mês ' + mesAtual + ' (' + cur.dias + '/' + diasTotal + ' dias)');
  console.log('  entregue ' + entregue + ' GWh | potencial ' + potencial + ' | cortado ' + cortado + ' (' + cur.frustrada_pct + '%)');
  console.log('  PR ' + cur.pr_pct + '% | disp ' + cur.disp_pct + '% | projeção fechamento ' + mes.projecao.realizado_gwh + ' GWh');
  console.log('  corte PPA ' + mes.ppa.corte_pct + '% × ML ' + mes.ml.corte_pct + '%  <- a estratégia');
  console.log('  ' + Math.round(size / 1024) + ' KB · ' + serie.length + ' meses');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
