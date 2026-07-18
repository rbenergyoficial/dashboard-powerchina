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
// META MENSAL = INPUT DO USUÁRIO (planilha PPA do SharePoint, linha "Valor Garantido de <mês>").
// Não existe em fonte pública. Fica em JSON VERSIONADO no repo até o pipeline SharePoint→blob existir.
// ⚠️ É ENERGIA LÍQUIDA → tem que ser comparada com a líquida do Way2, nunca com a bruta do ONS.
const METAS = (() => { try { return require('../data/metas.json'); } catch (e) { return { meses: {} }; } })();
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'executivo.json';
const CAP_MW = 343.77;      // outorga do complexo
const H = 0.5;              // intervalo ONS = 30 min
const RECONSTRUIR = process.env.RECONSTRUIR === '1';   // reconstrução do ge: DESLIGADA por padrão (ver bloco 2c)
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const CAP_UFV = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };  // outorga por UFV (MW) — soma 343,77
// ⚠️ NOMENCLATURA: a planilha PPA do SharePoint chama as usinas de "Mauriti 2..10" — NÃO EXISTE Mauriti 1.
// "UFV Mauriti 10" É O MESMO PARQUE que o nosso M1 (CEFMT1 no ONS · M1 no Way2 e no SCADA).
// CONFIRMADO PELO USUÁRIO em 2026-07-17. Antes disso já era o que a aritmética dizia: a Energia
// Equivalente da planilha é exatamente proporcional à outorga (Mauriti7/ref = 0,3000 = 14,733/49,11 ·
// Mauriti9/ref = 0,1999 = 9,822/49,11 · M2/ref = 0,4998 = 24,555/49,11), e Mauriti 10 = 9.091 → 49,11 MW.
// Traduzir SEMPRE por aqui quando o pipeline da planilha for ligado — nunca casar nome direto.
const ALIAS_PLANILHA = { 'Mauriti 10': 'M1', 'M10': 'M1', 'UFV Mauriti 10': 'M1' };
const daPlanilha = nome => ALIAS_PLANILHA[String(nome).trim()] || String(nome).trim().replace(/^(UFV\s+)?Mauriti\s+/i, 'M');
const INV_POR_PARQUE = { M1: 165, M2: 88, M3: 165, M4: 165, M5: 165, M6: 165, M7: 44, M8: 165, M9: 33 };
const MES_ABBR = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const lbl = m => MES_ABBR[+m.slice(5, 7) - 1] + '/' + m.slice(2, 4);
const r2 = x => Math.round(x * 100) / 100;
// padrao numerico da casa: ponto decimal, ponto de milhar, 2 casas nas medidas
const fmt = (n, dec) => { if (n == null) return '—'; const t = Number(n).toFixed(dec == null ? 2 : dec);
  const [i, f2] = t.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (f2 ? '.' + f2 : ''); };
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
  const DIA = {}; // dia -> { ger, fru, horas_restr }  (p/ a curva com o corte pintado)
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
    // série DIÁRIA do complexo — mesma fonte e mesma fórmula da cascata, p/ os números não brigarem
    const _d = String(r.ts).slice(0, 10);
    const dd = DIA[_d] || (DIA[_d] = { dia: _d, ger: 0, fru: 0, horas_restr: 0 });
    dd.ger += ger * H;
    if (lim > 0) { const perda = Math.max(0, (gref - ger) * H);   // <- definição da casa
      dd.fru += perda; dd.horas_restr += H;
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
  const RTC_M3_REPARO = "2026-07-12";   // reparo do RTC do c2 -> a estrutura do ONS vira nesta data
  const corteDiario = [];     // a virada da estratégia PPA x ML ao longo do tempo
  for (const mes of meses) {
    const C = CRU[mes]; if (!C) continue;
    const porUfv = {}; let ge = 0, gv = 0, irrSoma = 0, irrN = 0, geRec = 0, geTot = 0;
    let geP = 0, gvP = 0, parN = 0, parOk = 0;   // PR pareado + cobertura
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
      const dia_ = String(r.ts).slice(0, 10);
      (porUfv[u] = porUfv[u] || { ge: 0, gv: 0, geP: 0, gvP: 0, parN: 0, parOk: 0 });
      porUfv[u].ge += g * H; porUfv[u].gv += v * H;
      if (util(r)) { porUfv[u].parN++; if (g > 0) { porUfv[u].geP += g * H; porUfv[u].gvP += v * H; porUfv[u].parOk++; } }
      ge += g * H; gv += v * H; geTot += g * H; if (rec) geRec += g * H;
      // PR PAREADO: soma gv e ge SÓ nos intervalos em que o ONS publicou os dois. Somar o mês inteiro
      // infla o PR quando falta ge (divide por um denominador incompleto) — foi isso que deixou out/25
      // a fev/26 sem PR. Restringindo aos pares válidos, o número volta a ser comparável, e a COBERTURA
      // (quantos intervalos entraram) vai junto p/ o leitor saber sobre quanto do mês ele está olhando.
      if (util(r)) { irrSoma += irr; irrN++; parN++; if (g > 0) { geP += g * H; gvP += v * H; parOk++; } }
      // O registro "M7" do ONS é o circuito 2 do M3 — logo pertence ao PPA, não ao ML. Antes do reparo
      // do RTC ele carrega metade do c2 e completa o M3; a partir do reparo o ONS_M3 já vem inteiro e
      // esse registro vira duplicata, então sai da conta. Sem isso o gráfico diário rouba do PPA e
      // entrega ao ML — justamente os dois grupos que a estratégia compara.
      let grp = PPA.includes(u) ? 'ppa' : 'ml';
      let pula = false;
      if (u === 'M7') { if (dia_ < RTC_M3_REPARO) grp = 'ppa'; else pula = true; }
      if (!pula) {
        const pd = porDia[dia_] || (porDia[dia_] = { ppa_ge: 0, ppa_gv: 0, ml_ge: 0, ml_gv: 0 });
        pd[grp + '_ge'] += g * H; pd[grp + '_gv'] += v * H;
      }
    }
    // ---- M3 × M7: desfaz a mistura de tag do ONS (estrutura descoberta com o usuário, 2026-07-17) ----
    // O registro "M7" do ONS NUNCA foi o M7 — é o CIRCUITO 2 do M3. E o RTC do c2 lia metade. Logo:
    //     ONS_M3 = c1 + c3 + ½·c2   (= 80% do M3 real)      ONS_M7 = ½·c2   (= 20% do M3 real)
    //     ONS_M3 + ONS_M7 = M3 inteiro  ← identidade EXATA: o que faltava no M3 era a metade perdida do c2
    // Validada em 10 meses contra o Way2 (medidor de faturamento, correto):
    //     97,7 · 100,2 · 99,6 · 98,7 · 99,9 · 100,4 · 99,4 · 100,0 · 100,9 · 100,1 %
    // Em 12/07/2026 o RTC foi reparado e a estrutura VIROU: ONS_M3 passou a 100% (correto sozinho) e
    // ONS_M7 dobrou p/ 40% do M3 (o c2 cheio) — virou DUPLICATA. Somar depois disso conta o c2 duas vezes.
    // Por isso a regra é por DATA, não um fator: antes = soma, depois = M3 sozinho.
    // O ge segue a mesma regra: o usuário confirmou que ele nasce de cálculo com origem no SCADA
    // (não no Way2), então herda os dois defeitos. Prova: ge/MW do M3 em jul sai de 83,4 (sozinho)
    // p/ 104,9 (somado), dentro da faixa dos gêmeos de 49,11 MW (103,8–110,1).
    { const A = porUfv.M3, B = porUfv.M7;
      if (A && B && mes < RTC_M3_REPARO.slice(0, 7)) { A.ge += B.ge; A.gv += B.gv; }
      else if (A && B && mes === RTC_M3_REPARO.slice(0, 7)) {
        // mês da virada: só os dias ANTERIORES ao reparo somam
        const antes = C.filter(r => String(r.ts).slice(0, 10) < RTC_M3_REPARO && String(r.u) === 'CEFMT7');
        A.ge += antes.reduce((a, r) => a + num(r.ge) * H, 0);
        A.gv += antes.reduce((a, r) => a + num(r.gv) * H, 0);
      }
      // O registro M7 do ONS é o c2 em QUALQUER época — antes e depois do reparo. Logo o M7 não tem
      // NEM realizado NEM potencial no ONS. Realizado vem do Way2. Potencial é ESTIMADO: mediana do
      // ge/MW dos parques de tag boa × 14,733 MW (a irradiância é a mesma no complexo inteiro, então
      // o potencial específico escala com a capacidade). É estimativa — vai marcada como tal no painel.
      if (B) {
        const CAPS = { M1: 49.11, M2: 24.555, M4: 49.11, M5: 49.11, M6: 49.11, M8: 49.11 };
        const bons = Object.keys(CAPS).map(k => porUfv[k] && porUfv[k].ge > 0 ? porUfv[k].ge / CAPS[k] : null)
          .filter(x => x != null).sort((a, b) => a - b);
        B.ge = bons.length ? bons[Math.floor(bons.length / 2)] * 14.733 : 0;
        B.ge_estimado = true; B.gv = 0;
      }
    }
    IRR[mes] = { porUfv, ge, gv, geP, gvP, pr_cob: parN ? r2(100 * parOk / parN) : 0,
      irr_media: irrN ? irrSoma / irrN : 0, rec_pct: geTot > 0 ? r2(100 * geRec / geTot) : 0 };
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
      potencial_irr_gwh: r2(i.ge / 1000), pr_pct: i.geP > 0 ? r2(100 * i.gvP / i.geP) : null,
      pr_cobertura_pct: i.pr_cob == null ? null : i.pr_cob,
      disp_pct: m.n_disp ? r2(m.disp / m.n_disp / CAP_MW * 100) : null,
      disp_cobertura_pct: m.n ? r2(100 * m.n_disp / m.n) : null,
      irr_media: r2(i.irr_media), ge_reconstruido_pct: i.rec_pct,
      // META do mês na série (planilha, jan/26→). set/25–dez/25 ficam null: o usuário não tem PPA de 2025.
      meta_gwh: (METAS.meses[mes] || {}).garantido_total != null ? r2(METAS.meses[mes].garantido_total / 1000) : null,
      meta_ppa_gwh: (METAS.meses[mes] || {}).garantido_ppa != null ? r2(METAS.meses[mes].garantido_ppa / 1000) : null,
      corte_pct_pot: i.ge > 0 ? r2(100 * (m.fru) / (i.ge)) : null,
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
  // variacao vs MES ANTERIOR (o percentChange do Grafana compara com o 1o ponto da serie, o que muda
  // a regua de card p/ card conforme os nulls). Calculado aqui, explicito e igual p/ todos.
  serie.forEach((s, i) => { const p = serie[i - 1];
    const d = (a, b) => (a == null || b == null || b === 0) ? null : r2(a - b);
    if (p) { s.var_pr_pp = d(s.pr_pct, p.pr_pct); s.var_disp_pp = d(s.disp_pct, p.disp_pct);
      s.var_corte_pp = d(s.corte_pct_pot, p.corte_pct_pot); s.var_horas = d(s.horas_restricao, p.horas_restricao); } });
  serie.forEach(s => { s.atingido_pct = (s.meta_gwh > 0 && s.way2_liq_gwh != null) ? r2(100 * s.way2_liq_gwh / s.meta_gwh) : null;
    s.bateu = s.atingido_pct == null ? null : (s.atingido_pct >= 100 ? 1 : 0); });
  { const normais = serie.map(s => s.way2_gwh_dia).filter(x => x != null).sort((a, b) => a - b);
    const medianaDia = normais.length ? normais[Math.floor(normais.length / 2)] : null;
    serie.forEach(s => {
      s.ramp_up = !!(medianaDia != null && s.way2_gwh_dia != null && s.way2_gwh_dia < 0.7 * medianaDia);
      s.ge_faltante_pct = r2(100 * (1 - (saude[s.mes] != null ? saude[s.mes] : 0)));
      // Com o PR PAREADO, o criterio deixa de ser "o mes tem ge quase completo" e passa a ser
    // "a amostra pareada e representativa": >= 70% dos intervalos com sol. Assim out/25 em diante
    // volta a ter PR, com a cobertura declarada no card p/ o leitor pesar o numero.
    s.pr_confiavel = !s.ramp_up && s.pr_cobertura_pct >= 70 && s.pr_pct != null && s.pr_pct >= 50 && s.pr_pct <= 95;
      if (!s.pr_confiavel) { s.pr_pct = null; s.potencial_irr_gwh = null; }   // não publica o indefensável
      s.nota = s.ramp_up ? 'Planta em ramp-up (comissionamento) — potencial e PR nao sao comparaveis'
        : (!s.pr_confiavel ? 'A geracao estimada do ONS e inconsistente neste mes: mesmo somando SO os intervalos em que ela foi publicada, o PR sai fisicamente impossivel (out/25 216% · nov/25 133% · dez/25 188% · jan/26 180% · fev/26 98%). Nao e apenas dado faltando — o valor publicado esta errado. So a partir de mar/26 o PR fica coerente (76%).' : null);
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
    outras_gwh: outras,
    pico_mw: cur.pico_mw,
    ppa: grupo('ppa'), ml: grupo('ml'),
    // barchart precisa de um campo string no eixo → grupo vira coluna, não chave de objeto
    grupos: [Object.assign({ grupo: 'PPA' }, grupo('ppa')), Object.assign({ grupo: 'ML' }, grupo('ml'))],
  };

  // ---------- 4b) META × REALIZADO (tudo em energia LÍQUIDA do Way2) ----------
  // O Valor Garantido da planilha é LÍQUIDO ("Energia Total de rede"), então o realizado tem que ser a
  // líquida do Way2 (medidor de faturamento) — a mesma base que já sustenta o PPA. Comparar contra a
  // geração bruta do ONS daria um crédito de ~1% que não existe: é o erro de denominador de sempre.
  let metaUfv = null, naoAlocado = null, mt = null;
  { const w2Mes = daily.dias.filter(x => String(x.dia).slice(0, 7) === mesAtual);
    const somaU = us => w2Mes.reduce((a, x) => a + us.reduce((b, u) => b + num((x.ufv_liq_mwh || {})[u]), 0), 0);
    const liq = w2Mes.reduce((a, x) => a + num(x.ene_liq_mwh), 0);
    const liqPpa = somaU(PPA), liqMl = somaU(ML);
    // dias do Way2 ≠ dias do ONS (o Way2 é D+0, o ONS é D+1/D+2) → a projeção usa o ritmo do PRÓPRIO Way2
    const dW = w2Mes.length, fatorW = dW > 0 ? diasTotal / dW : 1;
    mt = METAS.meses[mesAtual] || null;
    const pct = (r, m) => m > 0 ? r2(100 * r / m) : null;

    // ---- meta das usinas FORA do PPA: DERIVADA, porque a fonte não emite ----
    // A planilha só traz meta p/ o PPA e o total global. Regra (definida com o usuário 2026-07-17):
    // aplicar a TAXA DO PPA (garantido_ppa ÷ capacidade_ppa = 137,73 MWh/MW) sobre a potência de M1/M7/M9.
    // É a generalização da regra que o próprio usuário usou p/ o M10 ("mesma potência → mesma meta"):
    // o que ela diz de fato é "mesma taxa por MW", e assim ela também alcança M7/M9, que não têm par de
    // potência no PPA. Resultado: as 9 usinas na MESMA régua (74,4% do próprio P50).
    // POR QUE NÃO ratear (global − PPA − M10) entre M7/M9, como estava: o global é ~7% menos conservador
    // que o PPA (79,5% vs 74,4% do equivalente) e o rateio despejava essa diferença inteira nos dois
    // menores parques → meta 145,9% do próprio P50, INATINGÍVEL por construção, com ou sem curtailment.
    // A diferença vira `nao_alocado`, EXPOSTA: é pergunta p/ quem emite a meta, não número p/ enterrar.
    if (mt) {
      const capPpa = PPA.reduce((a, u) => a + CAP_UFV[u], 0);
      const taxa = capPpa > 0 ? mt.garantido_ppa / capPpa : 0;     // MWh por MW instalado
      metaUfv = {}; PPA.forEach(u => { metaUfv[u] = r2((mt.ppa_por_ufv || {})[u] || taxa * CAP_UFV[u]); });
      ML.forEach(u => { metaUfv[u] = r2(taxa * CAP_UFV[u]); });
      naoAlocado = r2(mt.garantido_total - mt.garantido_ppa - ML.reduce((a, u) => a + metaUfv[u], 0));
    }
    // realizado LÍQUIDO por usina (Way2) — a única base comparável com a meta, que também é líquida
    const liqUfv = {}; Object.keys(CAP_UFV).forEach(u => {
      liqUfv[u] = w2Mes.reduce((a, x) => a + num((x.ufv_liq_mwh || {})[u]), 0); });

    mes.dias_restantes = Math.max(0, diasTotal - cur.dias);
    mes.liquida = { total_gwh: r2(liq / 1000), ppa_gwh: r2(liqPpa / 1000), ml_gwh: r2(liqMl / 1000),
      dias: dW, ultimo_dia: dW ? w2Mes[dW - 1].dia : null,
      projecao_total_gwh: r2(liq * fatorW / 1000), projecao_ppa_gwh: r2(liqPpa * fatorW / 1000),
      por_ufv: Object.fromEntries(Object.keys(liqUfv).map(u => [u, r2(liqUfv[u] / 1000)])) };
    mes.meta = mt ? {
      fonte: 'Planilha PPA (SharePoint), linha "Valor Garantido de ' + cur.lbl + '" — energia LIQUIDA',
      garantido_gwh: r2(mt.garantido_total / 1000), ppa_gwh: r2(mt.garantido_ppa / 1000),
      ml_gwh: r2(ML.reduce((a, u) => a + metaUfv[u], 0) / 1000),
      ml_fonte: 'DERIVADA — a planilha nao emite meta p/ M1/M7/M9. Taxa do PPA (' + r2(mt.garantido_ppa / PPA.reduce((a, u) => a + CAP_UFV[u], 0)) + ' MWh/MW) x potencia de cada uma.',
      por_ufv: metaUfv,
      nao_alocado_gwh: r2(naoAlocado / 1000),
      nao_alocado_nota: 'Diferenca entre a meta GLOBAL e a soma das 9 usinas na regua do PPA. O global e ~7% menos conservador que o PPA (79,5% vs 74,4% da energia equivalente). Fica EXPOSTA de proposito: e pergunta p/ quem emite a meta. Enterrar no M7/M9 (rateio do resto) dava a eles meta 145,9% do proprio P50 — inatingivel por construcao.',
      atingido_pct: pct(liq, mt.garantido_total), atingido_ppa_pct: pct(liqPpa, mt.garantido_ppa),
      projecao_pct: pct(liq * fatorW, mt.garantido_total), projecao_ppa_pct: pct(liqPpa * fatorW, mt.garantido_ppa),
      sobra_projetada_gwh: r2((liq * fatorW - mt.garantido_total) / 1000),
      vai_bater: liq * fatorW >= mt.garantido_total ? 1 : 0,
      // geometria da BARRA DE PROGRESSO DA META (a manchete é 100% líquida: mesma grandeza da meta).
      // Escala vai até 120% ou até a projeção, o que for maior, p/ a marca dos 100% nunca sair da barra.
      barra: (() => { const at = pct(liq, mt.garantido_total) || 0, pj = pct(liq * fatorW, mt.garantido_total) || 0;
        const esc = Math.max(120, Math.ceil(pj / 10) * 10);
        return { escala_pct: esc, realizado_w: r2(at / esc * 100),
          projecao_w: r2(Math.max(0, pj - at) / esc * 100), marca100_w: r2(100 / esc * 100) }; })(),
    } : { fonte: 'PENDENTE — planilha do SharePoint', garantido_gwh: null, atingido_pct: null };

    // meta × realizado POR USINA — array (barchart precisa de campo string no eixo)
    mes.meta_ufv = mt ? Object.keys(CAP_UFV).sort().map(u => {
      const met = metaUfv[u] / 1000, rea = liqUfv[u] / 1000, proj = rea * fatorW;
      return { ufv: u, grupo: PPA.includes(u) ? 'PPA' : 'ML',
        meta_gwh: r2(met), realizado_gwh: r2(rea), projecao_gwh: r2(proj),
        atingido_pct: met > 0 ? r2(100 * rea / met) : null,
        projecao_pct: met > 0 ? r2(100 * proj / met) : null,
        meta_derivada: !PPA.includes(u) }; }) : [];
  }

  // ---------- 5) por UFV (mês corrente) ----------
  // QUARENTENA DE TAG (informado pela operação em 2026-07-17): o ONS registrava o medidor do M7 como
  // M3 circuito 2. Corrigido no ONS em 2026-07-16. Efeito visível no dado: M7 com gv/ge = 105% (geração
  // verificada MAIOR que a estimada — impossível) e M3 com ge ~20% abaixo dos gêmeos de 49,11 MW.
  // Enquanto não houver dado ONS pós-correção validado, esses dois NÃO publicam corte: 0% falso engana
  // mais que lacuna assumida. O detector é o próprio dado (gv > ge), não uma data no código.
  const porUfv = Object.keys(INV_POR_PARQUE).sort().map(u => { const x = iCur.porUfv[u] || { ge: 0, gv: 0 };
    const gv = realizado(u);
    const viaWay2 = VIA_WAY2.includes(u) && W2_UFV[u] > 0;
    const m3corr = u === 'M3' && mesAtual <= RTC_M3_REPARO.slice(0, 7);
    return { ufv: u, grupo: PPA.includes(u) ? 'PPA' : 'ML', inversores: INV_POR_PARQUE[u],
      potencial_gwh: r2(x.ge / 1000), realizado_gwh: r2(gv / 1000),
      potencial_estimado: !!x.ge_estimado,
      fonte_realizado: viaWay2 ? 'Way2 (medidor de faturamento)' : 'ONS (geracao verificada)',
      nota: viaWay2 ? 'O registro "M7" do ONS NAO e o M7 — e o CIRCUITO 2 do M3 (tag trocada; corrigida no ONS em 16/07/2026). Logo o M7 nao tem nem geracao nem potencial no ONS. REALIZADO vem do Way2 (medidor de faturamento). POTENCIAL e ESTIMADO: mediana do ge/MW dos parques de tag boa x 14,733 MW (a irradiancia e a mesma no complexo, o potencial especifico escala com a capacidade). Volta p/ o ONS quando o dado pos-16/07 for validado.'
        : (m3corr ? 'Estrutura real do ONS ate 12/07/2026: ONS_M3 = c1 + c3 + metade do c2 (o RTC do c2 lia 50%) e o registro "M7" = a outra metade do c2. Por isso ONS_M3 + ONS_M7 = M3 inteiro — identidade validada em 10 meses contra o Way2 (97,7 a 100,9%). O motor SOMA os dois ate a data do reparo do RTC; a partir de 12/07 o ONS_M3 ja vem inteiro sozinho e somar contaria o c2 duas vezes.' : null),
      corte_gwh: r2(Math.max(0, x.ge - gv) / 1000),
      corte_pct: x.ge > 0 ? r2(100 * Math.max(0, x.ge - gv) / x.ge) : 0 }; });

  const out = { atualizado: new Date().toISOString(), cap_mw: CAP_MW, mes_atual: mesAtual,
    // META: PENDENTE — virá da planilha do SharePoint (P50/P90/PPA). Alvos confirmados pelo usuário.
    meta: { fonte: 'PENDENTE — planilha SharePoint (P50/P90/PPA)', p50_gwh: null, p90_gwh: null, ppa_mwh: null, pr_alvo_pct: 90, disp_alvo_pct: 97 },
    estrategia: { ppa: PPA, ml: ML, regra: 'Na limitação do ONS, M1/M7/M9 (fora do PPA) são limitados a ~1 MW para blindar a entrega do PPA. Atingida a meta do PPA no mês, o ML deixa de ser limitado.' },
    // corte_diario: últimos 75 dias, NÃO só o mês corrente — no dia 5 do mês um recorte mensal
    // deixaria o gráfico praticamente vazio, e a virada de mês é justamente onde a leitura interessa.
    // ---- CARDS (faixa minimalist): o motor calcula TUDO, o template só apresenta ----
    // Inclui o traçado SVG da sparkline pronto — Handlebars não faz conta, então quem normaliza é aqui.
    // A variação é vs MÊS ANTERIOR e só aparece nas métricas de TAXA: o mês corrente está pela metade
    // (dia 16 de 31), então comparar horas/GWh absolutos com um mês inteiro enganaria.
    cards: (() => {
      // Sparkline em DIVS, não em SVG: o sanitizador do painel dynamictext descarta <svg>.
      // Só flexbox passa — então a curva vira uma fileira de barrinhas com altura proporcional.
      const S = serie;
      // Mês SEM dado vira barra-fantasma em vez de sumir: antes eu filtrava os nulls e o card do PR
      // aparecia com 5 barras contra 11 dos outros — parecia card quebrado, quando na verdade o ONS
      // não preenchia a geração estimada antes de mar/26. Agora a LACUNA é visível, que é o honesto.
      const path = (vals, cor) => { const v = vals.filter(x => x != null);
        if (v.length < 2) return '';
        const mn = Math.min(...v), mx = Math.max(...v), amp = (mx - mn) || 1;
        const ult = vals.length - 1;
        return vals.map((y, i) => {
          if (y == null) return '<div style="flex:1;background:#2A2E35;height:9%;border-radius:1px"></div>';
          const h = 12 + (y - mn) / amp * 88;                                // 12%..100% (o menor ainda aparece)
          const op = i === ult ? 1 : 0.42;                                   // o mês corrente em destaque
          return '<div style="flex:1;background:' + cor + ';opacity:' + op + ';height:' + h.toFixed(0) + '%;border-radius:1px"></div>'; }).join(''); };
      const LIMIAR = 0.5;   // pp — abaixo disso é ruído, não tendência
      const ini = S[0].lbl, fim = S[S.length - 1].lbl;
      const col = (bom, delta) => (bom == null || Math.abs(delta || 0) < LIMIAR) ? '#8B93A1' : (bom ? '#43966B' : '#C85C60');
      return [
        { k: 'pr', label: 'Performance Ratio', v: fmt(cur.pr_pct), u: '%', sub: 'alvo 90%',
          var: cur.var_pr_pp == null ? '' : (cur.var_pr_pp > 0 ? '▲' : '▼') + ' ' + fmt(Math.abs(cur.var_pr_pp)) + ' pp',
          var_cor: col(cur.var_pr_pp == null ? null : cur.var_pr_pp >= 0, cur.var_pr_pp), cor: cur.pr_pct >= 90 ? '#43966B' : (cur.pr_pct >= 80 ? '#C08A45' : '#C85C60'),
          spark: path(S.map(s => s.pr_pct), '#D9A441'), spark_ini: ini, spark_fim: fim },
        { k: 'disp', label: 'Disponibilidade', v: fmt(cur.disp_pct), u: '%', sub: 'alvo 97%',
          var: cur.var_disp_pp == null ? '' : (cur.var_disp_pp > 0 ? '▲' : '▼') + ' ' + fmt(Math.abs(cur.var_disp_pp)) + ' pp',
          var_cor: col(cur.var_disp_pp == null ? null : cur.var_disp_pp >= 0, cur.var_disp_pp), cor: cur.disp_pct >= 97 ? '#43966B' : '#C08A45',
          spark: path(S.map(s => s.disp_pct), '#4E9A98'), spark_ini: ini, spark_fim: fim },
        { k: 'corte', label: 'Curtailment', v: fmt(mes.pct_cortado), u: '%', sub: fmt(mes.frustrada_gwh) + ' GWh jogados fora',
          var: cur.var_corte_pp == null ? '' : (cur.var_corte_pp > 0 ? '▲' : '▼') + ' ' + fmt(Math.abs(cur.var_corte_pp)) + ' pp',
          var_cor: col(cur.var_corte_pp == null ? null : cur.var_corte_pp <= 0, cur.var_corte_pp), cor: '#C85C60',
          spark: path(S.map(s => s.corte_pct_pot), '#C85C60'), spark_ini: ini, spark_fim: fim },
        { k: 'proj', label: 'Projeção de corte', v: fmt(mes.projecao.frustrada_gwh), u: 'GWh', sub: (function () { const ant = S[S.length - 2]; return ant ? '' + lbl(ant.mes) + ' fechou em ' + fmt(ant.frustrada_gwh) + ' GWh' : 'no fechamento do mes'; })(),
          var: '', var_cor: '#8B93A1', cor: '#5C86BE',
          spark: path(S.map(s => s.frustrada_gwh), '#5C86BE'), spark_ini: ini, spark_fim: fim },
        { k: 'horas', label: 'Horas em restrição', v: fmt(cur.horas_restricao), u: 'h', sub: 'mês parcial · dia ' + cur.dias + ' de ' + diasTotal,
          var: '', var_cor: '#8B93A1', cor: '#C08A45',
          spark: path(S.map(s => s.horas_restricao), '#C08A45'), spark_ini: ini, spark_fim: fim },
      ]; })(),
    modelo_ge: modelo, mes, por_ufv: porUfv, serie, corte_diario: corteDiario.slice(-75),
    // A CURVA COM O CORTE PINTADO: entregue + cortado empilhados, dia a dia. Mesma fonte/formula da
    // cascata (nivel do complexo, ons_restricao_all) -> os dois nunca divergem. 90 dias.
    // ---- MÊS CORRENTE dia a dia, por UFV e do complexo ----
    // Energia LÍQUIDA (Way2) + IRRADIÂNCIA média do dia + a meta diária. A irradiância é o que explica
    // a variação: dia fraco com irradiância baixa é nuvem; dia fraco com irradiância ALTA é corte ou
    // problema de equipamento. Sem ela, o gráfico mostra o "quanto" mas esconde o "por quê".
    // Inclui a linha ufv='Complexo' no MESMO array p/ o seletor do painel trocar sem query nova.
    // ================= TUDO POR UFV (o filtro do painel) =================
    // Um registro por (usina × mês), com 'Complexo' na MESMA lista — assim cada painel filtra com
    // [ufv='$ufv'] sem precisar de query diferente por seleção.
    // ⚠️ disp_pct e horas_restricao NÃO existem por usina: o ONS publica os dois para o conjunto
    // Mauriti inteiro. Nas linhas de usina eles vêm do complexo, marcados com escopo_complexo=1 —
    // o card mostra "· complexo" em vez de fingir que o número é da usina escolhida.
    serie_ufv: (() => {
      const out = [];
      const w2Mes = m => daily.dias.filter(x => String(x.dia).slice(0, 7) === m);
      meses.forEach(m => {
        const S = serie.find(x => x.mes === m); if (!S) return;
        const I = IRR[m] || { porUfv: {} };
        const w2 = w2Mes(m);
        const mtm = METAS.meses[m] || null;
        const capPpa = PPA.reduce((a, u) => a + CAP_UFV[u], 0);
        const taxa = mtm && capPpa > 0 ? mtm.garantido_ppa / capPpa : 0;
        const linha = (ufv, ge, gv, geP, gvP, parN, parOk, liq, meta) => {
          const corte = Math.max(0, ge - gv);
          const pr = geP > 0 ? r2(100 * gvP / geP) : null;
          const cob = parN ? r2(100 * parOk / parN) : 0;
          const prOk = !S.ramp_up && cob >= 70 && pr != null && pr >= 50 && pr <= 95;
          return { ufv, mes: m, mes_ts: S.mes_ts, lbl: S.lbl,
            liquida_gwh: r2(liq / 1000), meta_gwh: meta == null ? null : r2(meta / 1000),
            atingido_pct: meta > 0 ? r2(100 * liq / meta) : null,
            potencial_gwh: r2(ge / 1000), entregue_gwh: r2(gv / 1000), cortado_gwh: r2(corte / 1000),
            corte_pct: ge > 0 ? r2(100 * corte / ge) : null,
            outras_gwh: r2(Math.max(0, ge - gv - corte) / 1000),
            pr_pct: prOk ? pr : null, pr_cobertura_pct: cob,
            disp_pct: S.disp_pct, horas_restricao: S.horas_restricao, escopo_complexo: 1,
            nota: prOk ? null : S.nota };
        };
        // ---- as 9 usinas ----
        Object.keys(CAP_UFV).sort().forEach(u => { const x = I.porUfv[u] || { ge: 0, gv: 0, geP: 0, gvP: 0, parN: 0, parOk: 0 };
          const liq = w2.reduce((a, d) => a + num((d.ufv_liq_mwh || {})[u]), 0);
          const meta = mtm ? ((mtm.ppa_por_ufv || {})[u] != null ? mtm.ppa_por_ufv[u] : taxa * CAP_UFV[u]) : null;
          // M7: o "gv" do ONS é o circuito 2 do M3 (tag trocada), e nós o zeramos — usar ele daria
          // 100% de corte. O realizado do M7 vem do Way2. O PR fica NULL: comparar líquida do Way2
          // com potencial ESTIMADO não é Performance Ratio, é mistura de bases.
          const viaW2 = VIA_WAY2.includes(u) && liq > 0;
          const l = linha(u, x.ge, viaW2 ? liq : x.gv, x.geP, x.gvP, x.parN, x.parOk, liq, meta);
          if (viaW2) { l.pr_pct = null; l.fonte_realizado = 'Way2 (medidor de faturamento)';
            l.nota = 'O registro "M7" do ONS e o circuito 2 do M3 — o M7 nao tem geracao nem potencial proprios na fonte. Realizado vem do Way2; potencial e ESTIMADO pela mediana do ge/MW dos parques de tag boa. PR nao se aplica.'; }
          out.push(l); });
        // ---- complexo ----
        { const ge = Object.values(I.porUfv).reduce((a, x) => a + x.ge, 0);
          const gv = Object.values(I.porUfv).reduce((a, x) => a + x.gv, 0);
          const geP = Object.values(I.porUfv).reduce((a, x) => a + (x.geP || 0), 0);
          const gvP = Object.values(I.porUfv).reduce((a, x) => a + (x.gvP || 0), 0);
          const pN = Object.values(I.porUfv).reduce((a, x) => a + (x.parN || 0), 0);
          const pK = Object.values(I.porUfv).reduce((a, x) => a + (x.parOk || 0), 0);
          const liq = w2.reduce((a, d) => a + num(d.ene_liq_mwh), 0);
          const l = linha('Complexo', ge, gv, geP, gvP, pN, pK, liq, mtm ? mtm.garantido_total : null);
          // no complexo o corte vem da fórmula da casa (nível da subestação), não da soma dos ge−gv
          l.cortado_gwh = S.frustrada_gwh; l.corte_pct = S.corte_pct_pot;
          out.push(l); }
      });
      return out; })(),
    serie_dia_ufv: (() => {
      const out = [];
      const cruMes = CRU[mesAtual] || [];
      const irrDiaU = {}, irrDiaC = {};       // {dia: {u: [irr]}} e {dia: [irr]}
      cruMes.forEach(r => { if (!util(r)) return;
        const d = String(r.ts).slice(0, 10), u = String(r.u).replace('CEFMT', 'M');
        ((irrDiaU[d] = irrDiaU[d] || {})[u] = irrDiaU[d][u] || []).push(num(r.irr));
        (irrDiaC[d] = irrDiaC[d] || []).push(num(r.irr)); });
      const med = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      const metaU = metaUfv || {};
      daily.dias.filter(x => String(x.dia).slice(0, 7) === mesAtual).forEach(x => {
        const d = x.dia;
        const ts = d + 'T12:00:00-03:00';
        Object.keys(CAP_UFV).sort().forEach(u => out.push({ dia: d, dia_ts: ts, ufv: u,
          liq_mwh: r2(num((x.ufv_liq_mwh || {})[u])),
          irr: med((irrDiaU[d] || {})[u]) == null ? null : r2(med(irrDiaU[d][u])),
          meta_dia_mwh: metaU[u] ? r2(metaU[u] / diasTotal) : null }));
        out.push({ dia: d, dia_ts: ts, ufv: 'Complexo', liq_mwh: r2(num(x.ene_liq_mwh)),
          irr: med(irrDiaC[d]) == null ? null : r2(med(irrDiaC[d])),
          meta_dia_mwh: mt ? r2(mt.garantido_total / diasTotal) : null });
      });
      return out; })(),
    serie_diaria: Object.values(DIA).sort((a, b) => a.dia < b.dia ? -1 : 1).slice(-90).map(d => ({
      dia: d.dia, entregue_mwh: r2(d.ger), cortado_mwh: r2(d.fru),
      potencial_mwh: r2(d.ger + d.fru), horas_restricao: r2(d.horas_restr),
      corte_pct: (d.ger + d.fru) > 0 ? r2(100 * d.fru / (d.ger + d.fru)) : 0 })) };

  // ---------- 7) CARDS, MANCHETE e CASCATA por UFV (o filtro do painel) ----------
  // Derivados DEPOIS do objeto pronto, a partir de out.serie_ufv — assim nada precisa ser movido de
  // lugar e a ordem de avaliação do literal não importa.
  // Cada estrutura ganha uma linha por usina + 'Complexo'; o painel filtra com [ufv='$ufv'].
  {
    const SU = out.serie_ufv;
    const UFVS = ['Complexo'].concat(Object.keys(CAP_UFV).sort());
    const dTot = mes.dias_total, dCorr = mes.dias_decorridos;
    const fatorD = dCorr > 0 ? dTot / dCorr : 1;
    const LIMIAR = 0.5;
    const corVar = (bom, delta) => (bom == null || Math.abs(delta || 0) < LIMIAR) ? '#8B93A1' : (bom ? '#43966B' : '#C85C60');
    const seta = v => (v > 0 ? '▲' : '▼') + ' ' + fmt(Math.abs(v));
    const barras = (vals, cor) => { const v = vals.filter(x => x != null);
      if (v.length < 2) return '';
      const mn = Math.min(...v), mx = Math.max(...v), amp = (mx - mn) || 1, ult = vals.length - 1;
      return vals.map((y, i) => y == null
        ? '<div style="flex:1;background:#2A2E35;height:9%;border-radius:1px"></div>'
        : '<div style="flex:1;background:' + cor + ';opacity:' + (i === ult ? 1 : 0.42) + ';height:'
          + (12 + (y - mn) / amp * 88).toFixed(0) + '%;border-radius:1px"></div>').join(''); };

    out.cards_ufv = []; out.manchete_ufv = []; out.cascata_ufv = [];

    UFVS.forEach(u => {
      const S = SU.filter(x => x.ufv === u);                 // 11 meses dessa usina
      const cur = S[S.length - 1], ant = S[S.length - 2];
      if (!cur) return;
      const d = (a, b) => (a == null || b == null) ? null : r2(a - b);
      const vPR = ant ? d(cur.pr_pct, ant.pr_pct) : null;
      const vCorte = ant ? d(cur.corte_pct, ant.corte_pct) : null;
      const compl = u !== 'Complexo';                        // disp/horas são do complexo nas usinas
      const projCorte = r2(cur.cortado_gwh * fatorD);
      const antCorte = ant ? ant.cortado_gwh : null;

      out.cards_ufv.push(
        { ufv: u, k: 'pr', label: 'Performance Ratio', v: fmt(cur.pr_pct), u: '%', sub: 'alvo 90%',
          var: vPR == null ? '' : seta(vPR) + ' pp', var_cor: corVar(vPR == null ? null : vPR >= 0, vPR),
          cor: cur.pr_pct == null ? '#8B93A1' : (cur.pr_pct >= 90 ? '#43966B' : (cur.pr_pct >= 80 ? '#C08A45' : '#C85C60')),
          spark: barras(S.map(x => x.pr_pct), '#D9A441'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { ufv: u, k: 'disp', label: 'Disponibilidade', v: fmt(cur.disp_pct), u: '%',
          sub: compl ? 'só existe no complexo' : 'alvo 97%',
          var: compl ? '· complexo' : '', var_cor: '#8B93A1',
          cor: cur.disp_pct >= 97 ? '#43966B' : '#C08A45',
          spark: barras(S.map(x => x.disp_pct), '#4E9A98'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { ufv: u, k: 'corte', label: 'Curtailment', v: fmt(cur.corte_pct), u: '%',
          sub: fmt(cur.cortado_gwh) + ' GWh jogados fora',
          var: vCorte == null ? '' : seta(vCorte) + ' pp', var_cor: corVar(vCorte == null ? null : vCorte <= 0, vCorte),
          cor: '#C85C60', spark: barras(S.map(x => x.corte_pct), '#C85C60'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { ufv: u, k: 'proj', label: 'Projeção de corte', v: fmt(projCorte), u: 'GWh',
          sub: ant ? ant.lbl + ' fechou em ' + fmt(antCorte) + ' GWh' : 'no fechamento do mês',
          var: '', var_cor: '#8B93A1', cor: '#5C86BE',
          spark: barras(S.map(x => x.cortado_gwh), '#5C86BE'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { ufv: u, k: 'horas', label: 'Horas em restrição', v: fmt(cur.horas_restricao), u: 'h',
          sub: compl ? 'só existe no complexo' : 'mês parcial · dia ' + dCorr + ' de ' + dTot,
          var: compl ? '· complexo' : '', var_cor: '#8B93A1', cor: '#C08A45',
          spark: barras(S.map(x => x.horas_restricao), '#C08A45'), spark_ini: S[0].lbl, spark_fim: cur.lbl });

      // ---- manchete ----
      const proj = r2(cur.liquida_gwh * fatorD);
      const at = cur.meta_gwh > 0 ? r2(100 * cur.liquida_gwh / cur.meta_gwh) : null;
      const pj = cur.meta_gwh > 0 ? r2(100 * proj / cur.meta_gwh) : null;
      const esc = Math.max(120, Math.ceil((pj || 0) / 10) * 10);
      out.manchete_ufv.push({ ufv: u, lbl: cur.lbl, dias_decorridos: dCorr, dias_total: dTot,
        dias_restantes: Math.max(0, dTot - dCorr),
        liq_gwh: fmt(cur.liquida_gwh), liq_proj: fmt(proj), meta_gwh: fmt(cur.meta_gwh),
        atingido: fmt(at), proj_pct: fmt(pj),
        // versoes NUMERICAS: a gauge precisa de numero, o texto da manchete precisa de string formatada
        atingido_n: at, proj_pct_n: pj,
        realizado_w: at == null ? 0 : r2(at / esc * 100),
        projecao_w: pj == null ? 0 : r2(Math.max(0, pj - at) / esc * 100),
        marca100_w: r2(100 / esc * 100),
        escopo: u === 'Complexo' ? 'Complexo · 343,77 MW · 9 UFVs' : u + ' · ' + fmt(CAP_UFV[u]) + ' MW' });

      // ---- cascata ----
      const pot = cur.potencial_gwh;
      out.cascata_ufv.push(
        { ufv: u, etapa: 'Entregue', gwh: cur.entregue_gwh, pct: pot > 0 ? r2(100 * cur.entregue_gwh / pot) : 0 },
        { ufv: u, etapa: 'Cortado pelo ONS', gwh: cur.cortado_gwh, pct: pot > 0 ? r2(100 * cur.cortado_gwh / pot) : 0 },
        { ufv: u, etapa: 'Outras perdas', gwh: cur.outras_gwh, pct: pot > 0 ? r2(100 * cur.outras_gwh / pot) : 0 });
    });
  }

  const size = await writeOut(out);
  console.log('executivo.json OK · mês ' + mesAtual + ' (' + cur.dias + '/' + diasTotal + ' dias)');
  console.log('  entregue ' + entregue + ' GWh | potencial ' + potencial + ' | cortado ' + cortado + ' (' + cur.frustrada_pct + '%)');
  console.log('  PR ' + cur.pr_pct + '% | disp ' + cur.disp_pct + '% | projeção fechamento ' + mes.projecao.realizado_gwh + ' GWh');
  console.log('  corte PPA ' + mes.ppa.corte_pct + '% × ML ' + mes.ml.corte_pct + '%  <- a estratégia');
  console.log('  ' + Math.round(size / 1024) + ' KB · ' + serie.length + ' meses');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
