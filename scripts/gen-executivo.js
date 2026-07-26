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
// rateio MUST reaproveitado do arquivador — ver nota em gen-way2-hist.js
const { rollupDia, valores: valoresW2 } = require('./gen-way2-hist.js');
// META MENSAL = INPUT DO USUÁRIO (planilha PPA do SharePoint, linha "Valor Garantido de <mês>").
// Não existe em fonte pública. Fica em JSON VERSIONADO no repo até o pipeline SharePoint→blob existir.
// ⚠️ É ENERGIA LÍQUIDA → tem que ser comparada com a líquida do Way2, nunca com a bruta do ONS.
const METAS = (() => { try { return require('../data/metas.json'); } catch (e) { return { meses: {} }; } })();
// fases operacionais oficiais (teste/performance/COD por UFV) — extraídas dos despachos ANEEL e
// dos SGIs. Usadas para separar pré-COD de pós-COD sem heurística.
const FASES = (() => { try { return require('../data/fases_operacao.json').ufvs; } catch (e) { return {}; } })();
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'executivo.json';
const CAP_MW = 343.77;      // outorga do complexo
const H = 0.5;              // intervalo ONS = 30 min
const RECONSTRUIR = process.env.RECONSTRUIR === '1';   // reconstrução do ge: DESLIGADA por padrão (ver bloco 2c)
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const CAP_UFV = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };  // outorga por UFV (MW) — soma 343,77

// META POR USINA — FONTE ÚNICA DA VERDADE. Esta regra estava DUPLICADA (aqui e na serie_ufv), e a
// correção de 25/07/2026 só pegou numa das cópias: o painel seguiu mostrando a meta antiga do ML.
// É o mesmo tipo de erro do divisor da projeção. Agora existe um lugar só.
//
// A REGRA (informada pelo usuário): a planilha emite DUAS metas — a do complexo e a do PPA.
//   PPA  -> vem pronta por usina em `ppa_por_ufv`
//   ML   -> é O RESTO (garantido_total − garantido_ppa), rateado entre M1/M7/M9 pela ENERGIA
//           EQUIVALENTE (o P50 de cada uma, que a planilha traz para as 9). O equivalente é régua
//           melhor que a potência: já embute o fator de capacidade daquela usina naquele mês.
// Consequência que vale saber: como a meta global é menos conservadora que a do PPA, a diferença
// de critério recai TODA no ML — ele fica com meta ~98% do próprio P50 contra ~74% do PPA.
function metasPorUfv(mtm) {
  if (!mtm) return null;
  const eq = mtm.equivalente_por_ufv || {}, n = v => Number(v) || 0;
  const out = {};
  PPA.forEach(u => { out[u] = (mtm.ppa_por_ufv || {})[u] != null ? Number(mtm.ppa_por_ufv[u]) : 0; });
  const metaMl = n(mtm.garantido_total) - n(mtm.garantido_ppa);
  const eqMl = ML.reduce((a, u) => a + n(eq[u]), 0);
  ML.forEach(u => { out[u] = eqMl > 0 ? metaMl * n(eq[u]) / eqMl : 0; });
  return out;
}
// ⚠️ NOMENCLATURA: a planilha PPA do SharePoint chama as usinas de "Mauriti 2..10" — NÃO EXISTE Mauriti 1.
// "UFV Mauriti 10" É O MESMO PARQUE que o nosso M1 (CEFMT1 no ONS · M1 no Way2 e no SCADA).
// CONFIRMADO PELO USUÁRIO em 2026-07-17. Antes disso já era o que a aritmética dizia: a Energia
// Equivalente da planilha é exatamente proporcional à outorga (Mauriti7/ref = 0,3000 = 14,733/49,11 ·
// Mauriti9/ref = 0,1999 = 9,822/49,11 · M2/ref = 0,4998 = 24,555/49,11), e Mauriti 10 = 9.091 → 49,11 MW.
// Traduzir SEMPRE por aqui quando o pipeline da planilha for ligado — nunca casar nome direto.
const TAG_M7_OK = '2026-07-17';   // 1o dia em que ONS_M7 bateu o Way2 (100%). Gate validado.
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
  // replace do BOM: os blobs que NOS escrevemos saem de JSON.stringify e nao tem, mas os que vem
  // crus da API da Way2 (hist/way2_DIA.json) comecam com ﻿ e quebram o JSON.parse.
  let s = ''; x.on('data', c => s += c); x.on('end', () => { try { res(JSON.parse(s.replace(/^﻿/, ''))); } catch (e) { rej(e); } }); }).on('error', rej); }); }
async function writeOut(obj, nome) { const json = JSON.stringify(obj);
  const alvo = nome || OUT_BLOB;
  if (process.env.LOCAL_OUT) {                       // 2o blob vira <LOCAL_OUT sem .json>.<nome>
    const f = nome ? process.env.LOCAL_OUT.replace(/\.json$/, '') + '.' + nome : process.env.LOCAL_OUT;
    require('fs').writeFileSync(f, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob'); const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER); await cont.createIfNotExists();
  await cont.getBlockBlobClient(alvo).upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  return json.length; }

(async () => {
  const restr = await getJSON(BASE + 'ons_restricao_all.json');
  const daily = await getJSON(BASE + 'way2_daily.json');

  // ---------- dia corrente, quase ao vivo ----------
  // O way2_daily so fecha o dia DEPOIS que ele acaba (o arquivador roda 00:30), entao a serie
  // diaria morria em ontem. O snapshot 5-min de hoje ja existe desde a meia-noite e e reescrito
  // a cada ~5 min — da p/ montar a barra de hoje com o MESMO rollup do arquivador.
  // A linha vai marcada com `parcial`: ela e curta por definicao (metade do dia = metade da
  // barra) e sem a marca alguem le queda de geracao onde so ha meio-dia decorrido.
  try {
    const hojeBRT = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
    if (!daily.dias.some(d => d.dia === hojeBRT)) {
      const snap = await getJSON(BASE + 'hist/way2_' + hojeBRT + '.json');
      const linha = rollupDia(snap, hojeBRT);
      if (linha.slots > 0) {
        linha.parcial = 1;
        // DIA ENCERRADO PARA GERAÇÃO: depois do pôr do sol o dia nao rende mais nada — o que vem
        // ate a meia-noite e so consumo do trafo (~0,5 MW). Enquanto o dia era tratado como
        // "pela metade" ate 23:59, a projecao ficava presa em "dia 24 de 31" as 18h, ignorando um
        // dia de geracao que JA aconteceu. Critério pelo DADO, nao por hora fixa (o pôr do sol
        // muda ao longo do ano): 6 slots seguidos com |potencia| < 1% da instalada, depois do meio-dia.
        const g = valoresW2(snap, 6233, 'Demat').filter(v => v.valor != null);
        const u6 = g.slice(-6);
        linha.encerrado = (u6.length === 6 && g.length > 144
          && u6.every(v => Math.abs(v.valor / 1000) < 0.01 * 343.77)) ? 1 : 0;
        // ultimo slot COM valor: e o que o painel mostra como "dado ate". Os slots futuros do dia
        // ja vem criados com qualidade:1 e sem `valor`, entao contar slots nao serve.
        linha.ate = g.length ? String(g[g.length - 1].data).slice(11, 16) : null;
        daily.dias.push(linha);
        console.log('dia corrente ' + hojeBRT + ' anexado (parcial, ate ' + linha.ate + ', ' + linha.slots
          + ' slots, ' + linha.ene_liq_mwh + ' MWh'
          + (linha.encerrado ? ' · GERACAO ENCERRADA: conta como dia decorrido' : '') + ')');
      }
    }
  } catch (e) { console.log('dia corrente indisponivel (' + e.message + ') — serie fica ate ontem'); }

  // ---------- ENERGIA LIQUIDA OFICIAL: ler, nao calcular ----------
  // O rollup do way2_daily INTEGRA POTENCIA (Demat, 5 min) — e uma aproximacao. A Way2 publica a
  // energia LIQUIDADA por UFV na grandeza `EneatLiquida` (pontos de energia, um por usina), e essa e
  // a mesma que a planilha da PowerChina usa: batimento EXATO em jul/26, delta 0,00 nas 9 usinas e
  // 39.607,78 contra 39.607,77 MWh no total (dias 01-24).
  // REGRA (definida com o usuario em 25/07/2026): dia ja liquidado -> LE o valor, sem conta nenhuma.
  // O dia corrente ainda nao tem liquidada (a Way2 fecha 1-2 dias depois) e continua vindo do
  // snapshot 5-min, ja com as perdas descontadas (ver `soma` vs `somaPos` em gen-way2-hist.js).
  // LIMITE: `way2_energia_mes.json` cobre apenas o MES CORRENTE. Os meses fechados da serie
  // historica continuam com o rollup, ~0,7% acima — pendente estender a busca da EneatLiquida.
  const PT_ENE = { 6368: 'M1', 6369: 'M2', 6373: 'M3', 6374: 'M4', 6375: 'M5',
                   6376: 'M6', 6215: 'M7', 6378: 'M8', 6219: 'M9' };
  try {
    const em = await getJSON(BASE + 'way2_energia_mes.json');
    const L = {};                                  // dia -> { UFV: MWh }
    (em.dados || []).forEach(d => { const u = PT_ENE[d.pontoId]; if (!u) return;
      (d.valores || []).forEach(v => { if (v.valor == null) return;
        (L[String(v.data).slice(0, 10)] = L[String(v.data).slice(0, 10)] || {})[u] = v.valor / 1000; }); });
    let n = 0, ig = [];
    daily.dias.forEach(x => {
      const l = L[x.dia]; if (!l) return;
      if (x.parcial) { ig.push(x.dia + ' (dia em curso)'); return; }
      // exige as 9 usinas e total positivo: dia meio-liquidado daria numero menor que o real
      const us = Object.keys(l);
      const tot = us.reduce((a, u) => a + l[u], 0);
      if (us.length < 9 || tot <= 0) { ig.push(x.dia + ' (nao liquidado)'); return; }
      x.ufv_liq_mwh = Object.fromEntries(us.map(u => [u, r2(l[u])]));
      x.ene_liq_mwh = r2(tot);
      x.liq_fonte = 'EneatLiquida';
      n++;
    });
    console.log('energia liquida OFICIAL (EneatLiquida) em ' + n + ' dias'
      + (ig.length ? ' · fora: ' + ig.join(', ') : ''));
  } catch (e) { console.log('way2_energia_mes.json indisponivel (' + e.message + ') — segue com o rollup'); }

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
    // ⚠️ O DIA CORRENTE É PARCIAL (chega meia jornada) — se ele entrar no divisor, puxa a média diária
    // para baixo e a projeção SUBESTIMA. Em 25/07/2026 isso dava 31/25=1,240 aqui contra 31/24=1,292
    // na manchete: a mesma usina aparecia com 80,0% em um painel e 83,1% no outro. A manchete
    // (`serie_dia_ufv`, ~linha 697) já fazia certo; a correção não tinha sido propagada para cá.
    // REGRA: projetar pelo ritmo dos dias COMPLETOS; o realizado continua incluindo hoje.
    const cheios = w2Mes.filter(x => !x.parcial);
    const somaUC = us => cheios.reduce((a, x) => a + us.reduce((b, u) => b + num((x.ufv_liq_mwh || {})[u]), 0), 0);
    const liqC = cheios.reduce((a, x) => a + num(x.ene_liq_mwh), 0);
    const liqPpaC = somaUC(PPA);
    const dW = w2Mes.length, dWc = cheios.length || dW;
    const fatorW = dWc > 0 ? diasTotal / dWc : 1;
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
      // CORRIGIDO em 25/07/2026, informado pelo usuário: a planilha emite DUAS metas — a do
      // complexo e a do PPA. Logo a meta do ML não é derivada de taxa nenhuma, ela É O RESTO:
      //     meta_ML = garantido_total − garantido_ppa
      // O método anterior (taxa do PPA × potência de cada uma) deixava 3,25 GWh sem dono, e esse
      // "não alocado" era só o sintoma de estar inventando uma meta que a fonte já determinava.
      const mpu = metasPorUfv(mt);                 // <- fonte unica (ver topo do arquivo)
      metaUfv = {}; Object.keys(mpu).forEach(u => { metaUfv[u] = r2(mpu[u]); });
      // agora fecha: sobra só arredondamento
      naoAlocado = r2(mt.garantido_total - Object.values(metaUfv).reduce((a, b) => a + b, 0));
    }
    // realizado LÍQUIDO por usina (Way2) — a única base comparável com a meta, que também é líquida
    const liqUfv = {}, liqUfvC = {}; Object.keys(CAP_UFV).forEach(u => {
      liqUfv[u] = w2Mes.reduce((a, x) => a + num((x.ufv_liq_mwh || {})[u]), 0);
      liqUfvC[u] = cheios.reduce((a, x) => a + num((x.ufv_liq_mwh || {})[u]), 0); });

    mes.dias_restantes = Math.max(0, diasTotal - cur.dias);
    mes.liquida = { total_gwh: r2(liq / 1000), ppa_gwh: r2(liqPpa / 1000), ml_gwh: r2(liqMl / 1000),
      dias: dW, dias_completos: dWc, ultimo_dia: dW ? w2Mes[dW - 1].dia : null,
      projecao_total_gwh: r2(liqC * fatorW / 1000), projecao_ppa_gwh: r2(liqPpaC * fatorW / 1000),
      por_ufv: Object.fromEntries(Object.keys(liqUfv).map(u => [u, r2(liqUfv[u] / 1000)])) };
    mes.meta = mt ? {
      fonte: 'Planilha PPA (SharePoint), linha "Valor Garantido de ' + cur.lbl + '" — energia LIQUIDA',
      garantido_gwh: r2(mt.garantido_total / 1000), ppa_gwh: r2(mt.garantido_ppa / 1000),
      ml_gwh: r2(ML.reduce((a, u) => a + metaUfv[u], 0) / 1000),
      ml_fonte: 'O RESTO: meta do complexo (' + r2(mt.garantido_total / 1000) + ' GWh) menos a do PPA ('
        + r2(mt.garantido_ppa / 1000) + ' GWh). A planilha emite so essas duas; a do ML e o que sobra, '
        + 'rateado entre M1/M7/M9 pela Energia Equivalente (P50) de cada uma.',
      por_ufv: metaUfv,
      nao_alocado_gwh: r2(naoAlocado / 1000),
      nao_alocado_nota: 'Zero por construcao: PPA + ML fecham a meta do complexo. Ate 25/07/2026 aqui '
        + 'sobravam 3,25 GWh, porque a meta do ML era inventada por uma taxa em vez de sair do resto.',
      // dureza relativa: a diferenca de criterio entre a meta global e a do PPA recai TODA no ML
      ml_pct_p50: (() => { const eq = mt.equivalente_por_ufv || {};
        const e = ML.reduce((a, u) => a + num(eq[u]), 0);
        return e > 0 ? r2(100 * (mt.garantido_total - mt.garantido_ppa) / e) : null; })(),
      ppa_pct_p50: (() => { const eq = mt.equivalente_por_ufv || {};
        const e = PPA.reduce((a, u) => a + num(eq[u]), 0);
        return e > 0 ? r2(100 * mt.garantido_ppa / e) : null; })(),
      atingido_pct: pct(liq, mt.garantido_total), atingido_ppa_pct: pct(liqPpa, mt.garantido_ppa),
      projecao_pct: pct(liqC * fatorW, mt.garantido_total), projecao_ppa_pct: pct(liqPpaC * fatorW, mt.garantido_ppa),
      sobra_projetada_gwh: r2((liqC * fatorW - mt.garantido_total) / 1000),
      vai_bater: liqC * fatorW >= mt.garantido_total ? 1 : 0,
      // geometria da BARRA DE PROGRESSO DA META (a manchete é 100% líquida: mesma grandeza da meta).
      // Escala vai até 120% ou até a projeção, o que for maior, p/ a marca dos 100% nunca sair da barra.
      barra: (() => { const at = pct(liq, mt.garantido_total) || 0, pj = pct(liqC * fatorW, mt.garantido_total) || 0;
        const esc = Math.max(120, Math.ceil(pj / 10) * 10);
        return { escala_pct: esc, realizado_w: r2(at / esc * 100),
          projecao_w: r2(Math.max(0, pj - at) / esc * 100), marca100_w: r2(100 / esc * 100) }; })(),
    } : { fonte: 'PENDENTE — planilha do SharePoint', garantido_gwh: null, atingido_pct: null };

    // meta × realizado POR USINA — array (barchart precisa de campo string no eixo)
    mes.meta_ufv = mt ? Object.keys(CAP_UFV).sort().map(u => {
      // projeta pelos dias COMPLETOS (liqUfvC), não pelo realizado que inclui hoje parcial
      const met = metaUfv[u] / 1000, rea = liqUfv[u] / 1000, proj = liqUfvC[u] / 1000 * fatorW;
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
        const MPU = metasPorUfv(mtm);
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
          const meta = MPU ? MPU[u] : null;          // <- mesma fonte unica do bloco acima
          // M7: o "gv" do ONS é o circuito 2 do M3 (tag trocada), e nós o zeramos — usar ele daria
          // 100% de corte. O realizado do M7 vem do Way2. O PR fica NULL: comparar líquida do Way2
          // com potencial ESTIMADO não é Performance Ratio, é mistura de bases.
          const viaW2 = VIA_WAY2.includes(u) && liq > 0;
          // POTENCIAL DO M7 — não sai do ONS. Eu usava a mediana do `ge` dos parques de tag boa, mas o
          // `ge` do ONS é inconsistente antes de mar/26 (o mesmo motivo de o PR não existir lá). Isso
          // subestimava o potencial e ZERAVA o corte de set/25 a jan/26 — falso: o rendimento específico
          // do M7 (MWh/MW) acompanha o ML em todos esses meses, bem abaixo do PPA.
          // Referência nova: as USINAS DO PPA MEDIDAS pelo Way2, no mesmo mês, sob o mesmo céu.
          // É Way2 contra Way2 — não depende de nenhum número do ONS.
          // ⚠️ É PISO: o PPA também leva corte (8% a 19%), então o corte real do M7 é MAIOR que este.
          // Vale para os TRÊS parques de Mercado Livre, não só o M7: o `ge` quebrado antes de mar/26
          // zerava o corte de M1 e M9 também, o que é falso — o rendimento deles despenca em relação
          // ao PPA nesses meses. Onde o `ge` é confiável (mar/26 em diante) seguimos usando o ONS,
          // que mede a irradiância do próprio parque e é melhor que qualquer referência de irmã.
          const geRuim = m < '2026-03';
          const usaIrma = (viaW2 || (ML.includes(u) && geRuim));
          let gePot = x.ge, real = viaW2 ? liq : x.gv;
          if (usaIrma) {
            const rend = PPA.map(p => { const w = w2.reduce((a, dd) => a + num((dd.ufv_liq_mwh || {})[p]), 0);
              return w > 0 ? w / CAP_UFV[p] : null; }).filter(v => v != null).sort((a, b) => a - b);
            if (rend.length) { gePot = rend[Math.floor(rend.length / 2)] * CAP_UFV[u]; real = liq; }
          }
          const l = linha(u, gePot, real, x.geP, x.gvP, x.parN, x.parOk, liq, meta);
          // PPA nos meses de ge ruim: o cálculo dá 0,0% para as seis usinas — FALSO (o complexo cortou
          // 5,86% em out/25). E aqui não dá para estimar como no ML: as usinas do PPA SÃO a referência,
          // usá-las contra si mesmas seria circular. Fica VAZIO, com a nota dizendo por quê.
          if (geRuim && PPA.includes(u)) { l.cortado_gwh = null; l.corte_pct = null; l.outras_gwh = null;
            l.nota = 'Corte por usina indisponivel neste mes: depende da geracao estimada do ONS, inconsistente antes de mar/26 — o calculo dava 0,0% para as seis usinas do PPA, o que e falso (o complexo cortou neste mes). Nas usinas do ML foi possivel estimar pelas irmas do PPA; para o proprio PPA a referencia seria circular.'; }
          if (usaIrma) { l.potencial_piso = 1;
            l.potencial_fonte = 'mediana do rendimento (MWh/MW) das usinas do PPA, medido pelo Way2 no mesmo mês';
            // VIES MEDIDO contra o gabarito de mar-jul/26 (onde o ge do ONS presta): o metodo SUBESTIMA
            // o corte em ~10 pp (M1 -11,8 · M9 -8,8). Logo o corte real do ML e MAIOR que o publicado.
            l.vies_pp = -10; l.vies_nota = 'piso: validado contra os meses de dado bom, este metodo subestima o corte em ~10 pontos percentuais'; }
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
          l.cortado_gwh = S.frustrada_gwh;
          l.corte_pct = (m < '2026-03') ? S.frustrada_pct : S.corte_pct_pot;
          if (m < '2026-03') l.corte_base = 'cortado / (gerado + cortado) — nao usa a geracao estimada do ONS, que e inconsistente antes de mar/26';
          out.push(l); }
        // ---- grupos PPA e ML como se fossem "usinas" ----
        // O PPA é o compromisso contratual e o ML é quem absorve o corte: as duas perguntas mais
        // frequentes do painel. Entrando na mesma lista, viram opção no seletor de usina e alimentam
        // a gauge de referência sem query especial.
        [['PPA', PPA], ['ML', ML]].forEach(([g, us]) => {
          const som = k => us.reduce((a, u) => a + ((I.porUfv[u] || {})[k] || 0), 0);
          const liqG = us.reduce((a, u) => a + w2.reduce((b, d) => b + num((d.ufv_liq_mwh || {})[u]), 0), 0);
          const metaG = MPU ? us.reduce((a, u) => a + MPU[u], 0) : null;   // <- fonte unica
          // M7 entra pelo Way2 (o gv do ONS dele é o c2 do M3)
          const gvG = us.reduce((a, u) => a + (VIA_WAY2.includes(u)
            ? w2.reduce((b, d) => b + num((d.ufv_liq_mwh || {})[u]), 0)
            : ((I.porUfv[u] || {}).gv || 0)), 0);
          const lg = linha(g, som('ge'), gvG, som('geP'), som('gvP'), som('parN'), som('parOk'), liqG, metaG);
          lg.grupo = 1;
          out.push(lg); });
      });
      return out; })(),
    // TODOS OS MESES, não só o corrente: o painel filtra por [ufv e mes], e o mês vem do seletor de
    // tempo do Grafana. Publicando só o mês atual, escolher "mês anterior" trocava o RÓTULO mas não os
    // dados — o gráfico dizia jun/26 mostrando julho. Cada linha carrega `mes` p/ o filtro casar.
    // `dia_num` (1..31) alimenta o eixo numérico do painel Trend; `dia_ts` saiu (ninguém mais usa e
    // multiplicar por 11 meses só engordava o blob).
    serie_dia_ufv: (() => {
      const out = [];
      const med = a => a && a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
      const capPpa = PPA.reduce((a, u) => a + CAP_UFV[u], 0);
      meses.forEach(m => {
        // irradiância do mês, por dia e por usina
        const irrDiaU = {}, irrDiaC = {};
        (CRU[m] || []).forEach(r => { if (!util(r)) return;
          const d = String(r.ts).slice(0, 10), u = String(r.u).replace('CEFMT', 'M');
          ((irrDiaU[d] = irrDiaU[d] || {})[u] = irrDiaU[d][u] || []).push(num(r.irr));
          (irrDiaC[d] = irrDiaC[d] || []).push(num(r.irr)); });
        // meta DAQUELE mês (não a do mês corrente) dividida pelos dias DAQUELE mês
        const mtm = METAS.meses[m] || null;
        const dias = new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
        const MPUd = metasPorUfv(mtm);                    // <- fonte unica
        const metaDia = u => MPUd ? r2(MPUd[u] / dias) : null;
        daily.dias.filter(x => String(x.dia).slice(0, 7) === m).forEach(x => {
          const d = x.dia, dnum = +d.slice(8, 10);
          // `parcial` viaja em cada linha: o painel pinta a barra de hoje diferente e a projecao
          // desconta esse dia do divisor. `ate` = hora do ultimo dado (so no dia corrente).
          // `enc`: a geração do dia já terminou (pôr do sol). O dia segue `parcial` porque a
          // liquidada da Way2 ainda não saiu e vai substituir o valor — mas para a PROJEÇÃO ele já
          // é um dia decorrido, e no gráfico já pinta como barra fechada.
          const pc = x.parcial ? 1 : 0, enc = x.encerrado ? 1 : 0, ate = x.ate || null;
          // `liq_mwh` continua sendo a energia do dia, qualquer dia — é o que as somas usam.
          // Além dela, a MESMA energia sai repartida em dois campos COMPLEMENTARES (um sempre null):
          //   liq_fechada_mwh = dias que já acabaram · liq_hoje_mwh = o dia em curso
          // Assim o gráfico desenha duas SÉRIES vindas do MESMO frame: a barra de hoje ganha cor
          // própria sem virar um frame de ponto único (o que fazia o trend esticá-la, parecendo 6
          // dias de largura, e foi por isso que a barra parcial tinha sido removida antes).
          // barra translúcida SÓ enquanto o dia ainda pode render: depois do pôr do sol ela fecha.
          const parte = (v) => (pc && !enc) ? [null, v] : [v, null];
          Object.keys(CAP_UFV).sort().forEach(u => {
            const v = r2(num((x.ufv_liq_mwh || {})[u])), [fe, ho] = parte(v);
            out.push({ mes: m, dia: d, dia_num: dnum, ufv: u, liq_mwh: v,
              liq_fechada_mwh: fe, liq_hoje_mwh: ho,
              irr: med((irrDiaU[d] || {})[u]) == null ? null : r2(med(irrDiaU[d][u])),
              meta_dia_mwh: metaDia(u), parcial: pc, encerrado: enc, ate }); });
          const vC = r2(num(x.ene_liq_mwh)), [feC, hoC] = parte(vC);
          out.push({ mes: m, dia: d, dia_num: dnum, ufv: 'Complexo', liq_mwh: vC,
            liq_fechada_mwh: feC, liq_hoje_mwh: hoC,
            irr: med(irrDiaC[d]) == null ? null : r2(med(irrDiaC[d])),
            meta_dia_mwh: mtm ? r2(mtm.garantido_total / dias) : null, parcial: pc, encerrado: enc, ate });
        });
        // COMPLETA O MÊS com os dias que ainda não têm dado (liq null). O eixo do gráfico passa a
        // sair do DADO: junho vai até 30, julho até 31, fevereiro até 28. Antes o eixo era fixo em
        // 31,5 (para a última barra não sair cortada) e junho ganhava um dia 31 que não existe.
        // Dia sem dado vira ponto nulo — não desenha barra, só reserva o lugar no eixo.
        const jaTem = new Set(out.filter(x => x.mes === m && x.ufv === 'Complexo').map(x => x.dia_num));
        for (let dn = 1; dn <= dias; dn++) {
          if (jaTem.has(dn)) continue;
          const d = m + '-' + String(dn).padStart(2, '0');
          Object.keys(CAP_UFV).sort().forEach(u => out.push({ mes: m, dia: d, dia_num: dn, ufv: u,
            liq_mwh: null, liq_fechada_mwh: null, liq_hoje_mwh: null,
            irr: null, meta_dia_mwh: metaDia(u), parcial: 0, ate: null }));
          out.push({ mes: m, dia: d, dia_num: dn, ufv: 'Complexo', liq_mwh: null,
            liq_fechada_mwh: null, liq_hoje_mwh: null, irr: null,
            meta_dia_mwh: mtm ? r2(mtm.garantido_total / dias) : null, parcial: 0, ate: null });
        }
        // NAO inserir ponto fracionario aqui para "dar folga" no eixo: a largura da barra no
        // Grafana vem do MENOR intervalo entre pontos do eixo, entao um ponto em `dias + 0.5`
        // encolhe TODAS as barras pela metade (e ainda faz o eixo mostrar o tick 31 em junho).
        // A folga do eixo e resolvida no painel, com `max` vindo da variavel $maxdia — ver
        // out.meses_eixo logo abaixo.
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
    const UFVS = ['Complexo', 'PPA', 'ML'].concat(Object.keys(CAP_UFV).sort());
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

    out.cards_ufv = []; out.manchete_ufv = []; out.cascata_ufv = []; out.ytd_ufv = [];

    // MÊS × USINA. Antes só o mês corrente era montado, então escolher "mês anterior" no painel
    // trocava o rótulo e não os números. Agora o seletor escolhe as duas dimensões.
    meses.forEach(mSel => { UFVS.forEach(u => {
      const S = SU.filter(x => x.ufv === u);                 // 11 meses dessa usina
      const iCur = S.findIndex(x => x.mes === mSel);
      if (iCur < 0) return;
      const cur = S[iCur], ant = S[iCur - 1];
      // dias do mês selecionado e quantos já têm dado. Em mês FECHADO os dois se igualam, o fator vira
      // 1 e a "projeção" passa a ser o próprio realizado — que é o número certo para um mês passado.
      const dTot = new Date(+mSel.slice(0, 4), +mSel.slice(5, 7), 0).getDate();
      // SÓ DIAS COMPLETOS. O dia corrente entra na serie (a barra cresce ao longo do dia) mas fica
      // FORA da projecao: contá-lo como dia inteiro somaria 1 ao divisor sem somar a energia
      // correspondente ao numerador, e a projecao despencaria toda manha, recuperando a noite.
      // `liq_mwh != null` filtra os dias que so existem para completar o eixo do grafico: contar
      // linhas ja nao diz quantos dias passaram, porque o mes agora vem preenchido ate o fim.
      const diasMes = out.serie_dia_ufv.filter(x => x.mes === mSel && x.ufv === 'Complexo' && x.liq_mwh != null);
      // "aberto" = ainda pode gerar hoje. Depois do pôr do sol o dia entra na conta: a geração dele
      // já aconteceu e deixá-lo fora fazia a projeção anunciar "dia 24 de 31" às 18h.
      const parc = diasMes.filter(x => x.parcial && !x.encerrado);
      const dCorr = diasMes.filter(x => !x.parcial || x.encerrado).length || dTot;
      const fatorD = dCorr > 0 ? dTot / dCorr : 1;
      const fechado = dCorr >= dTot ? 1 : 0;
      // energia de hoje, ainda incompleta — some no "ja realizado", nao na base da projecao
      // PPA e ML sao GRUPOS: nao existem como linha em serie_dia_ufv (que so tem as 9 usinas e o
      // Complexo), entao filtrar por ufv=u daria 0 e a energia parcial vazaria para a base da
      // projecao — foi o que aconteceu na primeira versao (PPA saltou 124,68 -> 126,21).
      const membros = u === 'PPA' ? PPA : u === 'ML' ? ML : [u];
      // duas versões de propósito: a CRUA entra na conta da projeção, a arredondada é a que se exibe.
      // Arredondar antes de projetar custava até 0,6 pp nas usinas pequenas (M7 tem 0,99 GWh no mês:
      // 2 casas ali são ~0,5% da base), e era o que sobrava de divergência contra `mes.meta_ufv`.
      // só desconta o dia que AINDA está rendendo. Encerrado já conta como dia cheio na projeção.
      const hojeCru = out.serie_dia_ufv.filter(x => x.mes === mSel && x.parcial && !x.encerrado
        && membros.includes(x.ufv)).reduce((a, x) => a + num(x.liq_mwh), 0) / 1000;
      const hojeGwh = r2(hojeCru);
      // o "dado até HH:MM" vale mesmo com o dia encerrado — é a hora do último dado, não um selo de
      // "ainda crescendo". Sem isso o painel perdia a marca de atualidade depois do pôr do sol.
      const parcQq = diasMes.filter(x => x.parcial);
      const hojeAte = parcQq.length ? parcQq[0].ate : null;
      const d = (a, b) => (a == null || b == null) ? null : r2(a - b);
      const vPR = ant ? d(cur.pr_pct, ant.pr_pct) : null;
      const vCorte = ant ? d(cur.corte_pct, ant.corte_pct) : null;
      const compl = u !== 'Complexo';                        // disp/horas são do complexo nas usinas
      const projCorte = r2(cur.cortado_gwh * fatorD);
      const antCorte = ant ? ant.cortado_gwh : null;

      out.cards_ufv.push(
        { mes: mSel, ufv: u, k: 'pr', label: 'Performance Ratio', v: fmt(cur.pr_pct), u: '%', sub: 'alvo 90%',
          var: vPR == null ? '' : seta(vPR) + ' pp', var_cor: corVar(vPR == null ? null : vPR >= 0, vPR),
          cor: cur.pr_pct == null ? '#8B93A1' : (cur.pr_pct >= 90 ? '#43966B' : (cur.pr_pct >= 80 ? '#C08A45' : '#C85C60')),
          spark: barras(S.map(x => x.pr_pct), '#D9A441'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'disp', label: 'Disponibilidade', v: fmt(cur.disp_pct), u: '%',
          sub: compl ? 'só existe no complexo' : 'alvo 97%',
          var: compl ? '· complexo' : '', var_cor: '#8B93A1',
          cor: cur.disp_pct >= 97 ? '#43966B' : '#C08A45',
          spark: barras(S.map(x => x.disp_pct), '#4E9A98'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'corte', label: 'Curtailment', v: fmt(cur.corte_pct), u: '%',
          sub: fmt(cur.cortado_gwh) + ' GWh jogados fora',
          var: vCorte == null ? '' : seta(vCorte) + ' pp', var_cor: corVar(vCorte == null ? null : vCorte <= 0, vCorte),
          cor: '#C85C60', spark: barras(S.map(x => x.corte_pct), '#C85C60'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'proj', label: 'Projeção de corte', v: fmt(projCorte), u: 'GWh',
          sub: ant ? ant.lbl + ' fechou em ' + fmt(antCorte) + ' GWh' : 'no fechamento do mês',
          var: '', var_cor: '#8B93A1', cor: '#5C86BE',
          spark: barras(S.map(x => x.cortado_gwh), '#5C86BE'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'horas', label: 'Horas em restrição', v: fmt(cur.horas_restricao), u: 'h',
          // dias do ONS (`mes.dias_decorridos`), NAO do Way2 (`dCorr`): este valor vem do ONS, que
          // publica D+1/D+2. Usar dCorr faria o rotulo dizer "dia 25" com dado de 24 dias.
          sub: compl ? 'só existe no complexo' : 'ONS · dia ' + mes.dias_decorridos + ' de ' + dTot + ' (D+1)',
          var: compl ? '· complexo' : '', var_cor: '#8B93A1', cor: '#C08A45',
          spark: barras(S.map(x => x.horas_restricao), '#C08A45'), spark_ini: S[0].lbl, spark_fim: cur.lbl });

      // ---- manchete ----
      // base = so os dias FECHADOS (tira a energia de hoje, que e de um dia pela metade).
      // O "ja realizado" logo abaixo continua incluindo hoje — aquilo e energia entregue de fato.
      const proj = r2((cur.liquida_gwh - hojeCru) * fatorD);
      const at = cur.meta_gwh > 0 ? r2(100 * cur.liquida_gwh / cur.meta_gwh) : null;
      const pj = cur.meta_gwh > 0 ? r2(100 * proj / cur.meta_gwh) : null;
      const esc = Math.max(120, Math.ceil((pj || 0) / 10) * 10);
      out.manchete_ufv.push({ mes: mSel, fechado, ufv: u, lbl: cur.lbl, dias_decorridos: dCorr, dias_total: dTot,
        dias_restantes: Math.max(0, dTot - dCorr),
        ao_vivo: hojeAte ? 1 : 0, ao_vivo_ate: hojeAte, hoje_gwh: fmt(hojeGwh),
        liq_gwh: fmt(cur.liquida_gwh), liq_proj: fmt(proj), meta_gwh: fmt(cur.meta_gwh),
        atingido: fmt(at), proj_pct: fmt(pj),
        // SPARKLINE DA MANCHETE: os meses ATÉ o selecionado (não o histórico inteiro — num mês
        // passado a curva não pode mostrar o futuro dele). Vai desenhada ATRÁS do número no card,
        // que é justamente o que o `stat` nativo não faz: ele divide o cartão em número|curva.
        spark_liq: barras(S.slice(0, iCur + 1).map(x => x.liquida_gwh), '#43966B'),
        spark_meta: barras(S.slice(0, iCur + 1).map(x => x.meta_gwh), '#8B93A1'),
        spark_n: S.slice(0, iCur + 1).filter(x => x.liquida_gwh != null).length,
        // O QUE PRECISA ACONTECER — a pergunta que um card executivo tem que responder e nenhum
        // dos números acima responde: "de quanto por dia eu preciso, e é mais ou menos do que
        // venho fazendo?". Tudo derivado, sem fonte nova.
        falta_gwh: (() => { const f = cur.meta_gwh - cur.liquida_gwh; return f > 0 ? fmt(r2(f)) : '0.00'; })(),
        ritmo_nec: (() => { const f = cur.meta_gwh - cur.liquida_gwh, d = Math.max(0, dTot - dCorr);
          return (f > 0 && d > 0) ? fmt(r2(f / d)) : null; })(),
        ritmo_atual: dCorr > 0 ? fmt(r2(cur.liquida_gwh / dCorr)) : null,
        // acelerar ou desacelerar: quantos % o ritmo precisa mudar
        ritmo_delta_pct: (() => { const f = cur.meta_gwh - cur.liquida_gwh, d = Math.max(0, dTot - dCorr);
          if (!(f > 0 && d > 0 && dCorr > 0 && cur.liquida_gwh > 0)) return null;
          return fmt(r2(100 * ((f / d) / (cur.liquida_gwh / dCorr) - 1))); })(),
        // versoes NUMERICAS: a gauge precisa de numero, o texto da manchete precisa de string formatada
        atingido_n: at, proj_pct_n: pj,
        realizado_w: at == null ? 0 : r2(at / esc * 100),
        projecao_w: pj == null ? 0 : r2(Math.max(0, pj - at) / esc * 100),
        marca100_w: r2(100 / esc * 100),
        // ESCOPO ADAPTATIVO: o cabeçalho do painel já mostra OUTORGA 343,77 MW, então repetir a
        // potência aqui quando o filtro é "Complexo" é ruído. Mas o campo não pode sair: ele é a
        // única indicação de QUAL filtro está ativo, e para uma usina a potência é informação nova.
        // Então ele se adapta em vez de desaparecer — nunca repete, e sempre informa.
        escopo: u === 'Complexo' ? 'Complexo · 9 UFVs'
          : (u === 'PPA' ? 'Grupo PPA · 6 UFVs · ' + fmt(r2(PPA.reduce((a, x) => a + CAP_UFV[x], 0))) + ' MW'
          : (u === 'ML' ? 'Mercado Livre · 3 UFVs · ' + fmt(r2(ML.reduce((a, x) => a + CAP_UFV[x], 0))) + ' MW'
          : u + ' · ' + fmt(CAP_UFV[u]) + ' MW · ' + (INV_POR_PARQUE[u] || '?') + ' inversores')) });

      if (mSel === mesAtual) {   // YTD e ANUAL: monta uma vez so
      // ---- ACUMULADO DO ANO (YTD) ----
      // Investidor pensa em ano, não em mês. Só o ano corrente (2026): 2025 tem os meses de
      // comissionamento e de dado quebrado, misturar os dois períodos num acumulado seria enganoso.
      // O mês corrente entra PARCIAL (o ano não acabou) — dito no rótulo.
      { const ano = mesAtual.slice(0, 4);
        // SO MESES FECHADOS: incluir o mes corrente compara realizado parcial (dia 17) contra meta
        // do mes inteiro e derruba o acumulado artificialmente (dava 97% quando o real e 111%).
        const A = S.filter(x => x.mes.slice(0, 4) === ano && x.mes !== mesAtual);
        const somaN = (k) => A.reduce((a, x) => a + (x[k] == null ? 0 : x[k]), 0);
        const temMeta = A.filter(x => x.meta_gwh != null);
        const metaAcum = temMeta.reduce((a, x) => a + x.meta_gwh, 0);
        const liqAcum = somaN('liquida_gwh');
        // meses com corte publicado (os antigos do PPA são null) — a cobertura vai junto
        const comCorte = A.filter(x => x.cortado_gwh != null);
        out.ytd_ufv.push({ ufv: u, ano,
          meses: A.length, primeiro: A[0] ? A[0].lbl : null, ultimo: A[A.length - 1] ? A[A.length - 1].lbl : null,
          liquida_gwh: r2(liqAcum), meta_gwh: temMeta.length ? r2(metaAcum) : null,
          atingido_pct: metaAcum > 0 ? r2(100 * liqAcum / metaAcum) : null,
          meses_com_meta: temMeta.length,
          bateram: temMeta.filter(x => x.atingido_pct != null && x.atingido_pct >= 100).length,
          cortado_gwh: comCorte.length ? r2(comCorte.reduce((a, x) => a + x.cortado_gwh, 0)) : null,
          meses_com_corte: comCorte.length,
          nota: 'Acumulado de ' + ano + ' — SOMENTE MESES FECHADOS. O mes corrente (' + cur.lbl + ', dia ' + dCorr + ' de ' + dTot + ') fica de fora: compara-lo pela metade contra a meta do mes inteiro derrubaria o acumulado artificialmente.' }); } }

      // ---- cascata ----
      const pot = cur.potencial_gwh;
      out.cascata_ufv.push(
        { mes: mSel, ufv: u, etapa: 'Entregue', gwh: cur.entregue_gwh, pct: pot > 0 ? r2(100 * cur.entregue_gwh / pot) : 0 },
        { mes: mSel, ufv: u, etapa: 'Cortado pelo ONS', gwh: cur.cortado_gwh, pct: pot > 0 ? r2(100 * cur.cortado_gwh / pot) : 0 },
        { mes: mSel, ufv: u, etapa: 'Outras perdas', gwh: cur.outras_gwh, pct: pot > 0 ? r2(100 * cur.outras_gwh / pot) : 0 });
    }); });

    // lista de meses p/ o seletor do painel (mais novo primeiro)
    out.meses_opcoes = meses.slice().reverse().map(m => ({ mes: m, lbl: lbl(m), atual: m === mesAtual ? 1 : 0 }));

    // ---------- CONFIANÇA DA PROJEÇÃO ----------
    // Backtest do nosso próprio método: para cada mês FECHADO, reconstrói o que a projeção teria dito
    // em cada dia (acumulado até o dia ÷ dias × dias do mês) e compara com o fechamento real.
    // Responde "a partir de que dia esse número pode ser levado a sério?" — sem isso a projeção
    // aparece com a mesma cara no dia 3 e no dia 28, quando no dia 3 ela é ruído.
    // set/25 fica FORA: era comissionamento (ramp-up), não representa a operação.
    { const SD = out.serie_dia_ufv.filter(x => x.ufv === 'Complexo' && x.liq_mwh != null);
      const diasNo = m => new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate();
      const rampUp = new Set(serie.filter(s => s.ramp_up).map(s => s.mes));
      const fechados = meses.filter(m => !rampUp.has(m) && SD.filter(x => x.mes === m).length >= diasNo(m));
      const erroNoDia = D => fechados.map(m => {
        const d = SD.filter(x => x.mes === m).sort((a, b) => a.dia_num - b.dia_num);
        if (d.length < D) return null;
        const ac = d.slice(0, D).reduce((a, x) => a + x.liq_mwh, 0);
        const real = d.reduce((a, x) => a + x.liq_mwh, 0);
        return real > 0 ? 100 * ((ac / D * diasNo(m)) - real) / real : null;
      }).filter(e => e != null);

      out.acerto_projecao = [];
      for (let D = 3; D <= 28; D++) { const e = erroNoDia(D); if (e.length < 3) continue;
        out.acerto_projecao.push({ dia: D, n_meses: e.length,
          erro_abs_pp: r2(e.reduce((a, b) => a + Math.abs(b), 0) / e.length),
          vies_pp: r2(e.reduce((a, b) => a + b, 0) / e.length),
          pior_pp: r2(Math.max(...e.map(Math.abs))),
          dentro5: e.filter(x => Math.abs(x) <= 5).length }); }

      // o que vale HOJE (dia decorrido do mês corrente), p/ o card ao lado da projeção
      const dHoje = SD.filter(x => x.mes === mesAtual).length;
      const h = out.acerto_projecao.find(x => x.dia === dHoje)
        || out.acerto_projecao[out.acerto_projecao.length - 1] || null;
      out.confianca_projecao = h ? {
        dia: dHoje, erro_pp: h.erro_abs_pp, vies_pp: h.vies_pp, n_meses: h.n_meses,
        dentro5: h.dentro5, acertos: h.dentro5 + ' de ' + h.n_meses,
        nivel: h.erro_abs_pp <= 3 ? 'alta' : (h.erro_abs_pp <= 6 ? 'média' : 'baixa'),
        cor: h.erro_abs_pp <= 3 ? '#43966B' : (h.erro_abs_pp <= 6 ? '#C08A45' : '#C85C60'),
        texto: '±' + fmt(h.erro_abs_pp) + ' pp',
        nota: 'Backtest em ' + h.n_meses + ' meses fechados: no dia ' + dHoje + ' a projeção errou em média ' + fmt(h.erro_abs_pp) + ' pontos percentuais, e ' + h.dentro5 + ' dos ' + h.n_meses + ' meses ficaram dentro de 5 pp.',
      } : null;

      // Carimba a confiança DENTRO de manchete_ufv: o painel dynamictext trata cada query como um
      // quadro separado, então campos vindos de uma 2ª query não existem no contexto do template.
      // Em mês FECHADO não há projeção a confiar — o selo vira "mês fechado", neutro.
      const cf = out.confianca_projecao;
      out.manchete_ufv.forEach(m2 => {
        if (m2.fechado) { m2.cf_nivel = 'mês fechado'; m2.cf_texto = 'realizado'; m2.cf_cor = '#5F6672'; m2.cf_acertos = ''; }
        else if (cf) { m2.cf_nivel = cf.nivel; m2.cf_texto = cf.texto; m2.cf_cor = cf.cor; m2.cf_acertos = cf.acertos; }
        else { m2.cf_nivel = ''; m2.cf_texto = ''; m2.cf_cor = '#5F6672'; m2.cf_acertos = ''; }

        // ---- COR DO SELO DA PROJEÇÃO ----
        // Verde fixo mentia: anunciava "PROJEÇÃO 99,57% DA META" em verde de meta batida.
        // A régua NÃO é o 100% seco, é o 100% ± o erro do próprio método (backtest). Com projeção
        // 99,57% e erro ±1,72 pp a meta continua ALCANÇÁVEL — pintar de vermelho seria tão errado
        // quanto pintar de verde. Três faixas:
        //   >= 100 + erro  -> verde    (bate com margem)
        //   dentro de ±erro -> âmbar   (no limite: a incerteza cobre os 100%)
        //   <  100 - erro  -> vermelho (não bate)
        // Fundos em HEX SÓLIDO, não rgba: rgba compõe com o fundo do card e o mesmo selo sai
        // diferente em painel de fundo diferente (§1 do design system).
        const pj2 = m2.proj_pct_n, erro = cf ? num(cf.erro_pp) : 0;
        if (m2.fechado || pj2 == null) {
          m2.proj_fundo = '#1F2228'; m2.proj_texto_cor = '#8B93A1'; m2.proj_rotulo = 'REALIZADO';
        } else if (pj2 >= 100 + erro) {
          m2.proj_fundo = '#1D2D29'; m2.proj_texto_cor = '#7FC49C'; m2.proj_rotulo = 'ACIMA DA META';
        } else if (pj2 >= 100 - erro) {
          m2.proj_fundo = '#3C301C'; m2.proj_texto_cor = '#F7D9A6'; m2.proj_rotulo = 'NO LIMITE DA META';
        } else {
          m2.proj_fundo = '#342327'; m2.proj_texto_cor = '#E8A0A2'; m2.proj_rotulo = 'ABAIXO DA META';
        }
        // faixa da projeção: é o que responde "ainda dá?" melhor que qualquer cor
        m2.proj_faixa = (m2.fechado || pj2 == null || !erro) ? ''
          : fmt(r2(pj2 - erro)) + '–' + fmt(r2(pj2 + erro)) + '%';
      });

      // ---- FAIXA DE CONTRATO (só na linha do Complexo) ----
      // O card do Complexo esconde a informação que decide: ele e a MEDIA de duas situacoes
      // opostas. Em jul/26 o PPA projeta 115,4% (+5,74 GWh acima do contratado) e o ML 55,5%
      // (−5,96 GWh); a sobra de um quase anula o deficit do outro, e o Complexo aparece "quase
      // batendo" por COMPENSACAO, nao por equilibrio. Quem le so o Complexo conclui "falta pouco";
      // a leitura certa e "o contrato esta garantido e o ML nao tem como recuperar".
      // Os dois grupos entram na linha do Complexo porque o painel filtra UMA entidade por vez.
      const porMes = {};
      out.manchete_ufv.forEach(m2 => { (porMes[m2.mes] = porMes[m2.mes] || {})[m2.ufv] = m2; });
      // o erro do backtest e a regua das 3 faixas; vive em `confianca_projecao`, nao neste escopo
      const erroBT = cf ? num(cf.erro_pp) : 0;
      out.manchete_ufv.filter(m2 => m2.ufv === 'Complexo').forEach(C => {
        const P = (porMes[C.mes] || {}).PPA, L = (porMes[C.mes] || {}).ML;
        if (!P || !L) { C.ctr = 0; return; }
        const d = (m) => { const p = num(m.liq_proj) - num(m.meta_gwh);
          return (p >= 0 ? '+' : '') + fmt(r2(p)); };
        C.ctr = 1;
        // a linha do Complexo carrega a linha do PPA e a do ML nas MESMAS metricas, para o card
        // virar uma matriz (grupo x metrica) em vez de comprimir tudo numa faixa de rodape.
        [['ppa', P], ['ml', L]].forEach(([k, m]) => {
          C['ctr_' + k + '_liq'] = m.liq_gwh;
          C['ctr_' + k + '_proj'] = m.liq_proj;
          C['ctr_' + k + '_meta'] = m.meta_gwh;
          C['ctr_' + k + '_ating'] = m.atingido;          // % da meta JÁ realizado
          C['ctr_' + k + '_pct'] = m.proj_pct;            // % da meta PROJETADO no fechamento
          C['ctr_' + k + '_gwh'] = d(m);                       // sobra (+) ou deficit (-)
          C['ctr_' + k + '_ritmo'] = m.ritmo_nec;
          // VEREDITO CURTO por grupo, na MESMA regua de 3 faixas do selo do complexo (100% ± erro
          // do backtest). O selo antigo dizia so "NO LIMITE DA META", falando do complexo e
          // escondendo que os grupos estao em situacoes OPOSTAS: o PPA bate com folga e o ML nao
          // bate de jeito nenhum. Tres chips resolvem — cada grupo com seu proprio veredito.
          const pv = num(m.proj_pct_n);
          const faixa = pv >= 100 + erroBT ? 'bate' : (pv >= 100 - erroBT ? 'limite' : 'nao');
          C['ctr_' + k + '_rot'] = { bate: 'BATE', limite: 'NO LIMITE', nao: 'NÃO BATE' }[faixa];
          C['ctr_' + k + '_cor'] = { bate: '#7FC49C', limite: '#F7D9A6', nao: '#E8A0A2' }[faixa];
          C['ctr_' + k + '_fundo'] = { bate: '#1D2D29', limite: '#3C301C', nao: '#342327' }[faixa];
        });
        // o veredito em palavras: e o que a diretoria le primeiro
        C.ctr_texto = num(P.proj_pct_n) >= 100 ? 'contrato PPA seguro' : 'contrato PPA em risco';
        // rotulo curto do complexo, sem o "DA META" que se repetiria nos tres chips
        C.ctr_cpx_rot = String(C.proj_rotulo || '').replace(' DA META', '');
      });
    }
  }

  // ---------- VIDA INTEIRA DA USINA: pré-COD × pós-COD ----------
  // O painel mostrava só o pós-COD (o ONS começa em 04/09/2025), escondendo os ~304 GWh que o
  // complexo gerou em teste e performance. Mas o Way2 mede desde 23/01/2025 — a energia SEMPRE
  // existiu, só não estava publicada aqui.
  //
  // Estrutura SEPARADA de propósito: não toco em `serie`/`meses`, que dirigem projeção, backtest e
  // metas (todos dependem de existir meta PPA, que só começa em jan/26). Aqui é a série longa,
  // com a fase de cada mês e o corte pré/pós COD.
  //
  // O COD é POR USINA (M2/M4/M7 em 04/09, M3/M5/M6/M8 em 05/09, M1 em 10/09, M9 só em 22/11).
  // Cada UFV é classificada contra o SEU próprio COD — não contra uma data única do complexo.
  {
    const codDe = u => (FASES[u] && FASES[u].operacao_comercial && FASES[u].operacao_comercial.cod) || null;
    const faseNoDia = (u, dia) => {
      const f = FASES[u]; if (!f) return null;
      const cod = f.operacao_comercial.cod;
      if (cod && dia >= cod) return 'comercial';
      if (f.performance && f.performance.inicio && dia >= f.performance.inicio) return 'performance';
      if (f.teste && f.teste.inicio && dia >= f.teste.inicio) return 'teste';
      return 'pre-teste';
    };
    const UF = Object.keys(CAP_UFV).sort();
    const porMes = {};          // mes -> { pre, pos, fases:{}, ufv:{} }
    const tot = { pre: 0, pos: 0, por_fase: {}, dias_pre: new Set(), dias_pos: new Set() };

    for (const d of daily.dias) {
      const dia = String(d.dia); if (dia < '2025-01-01') continue;
      const mes = dia.slice(0, 7);
      const m = porMes[mes] || (porMes[mes] = { mes, pre: 0, pos: 0, fases: {}, ufv: {} });
      for (const u of UF) {
        const v = num((d.ufv_liq_mwh || {})[u]); if (!(v > 0)) continue;
        const cod = codDe(u), ehPre = cod && dia < cod;
        const fase = faseNoDia(u, dia) || 'indefinida';
        m.ufv[u] = (m.ufv[u] || 0) + v;
        m.fases[fase] = (m.fases[fase] || 0) + v;
        tot.por_fase[fase] = (tot.por_fase[fase] || 0) + v;
        if (ehPre) { m.pre += v; tot.pre += v; tot.dias_pre.add(dia); }
        else { m.pos += v; tot.pos += v; tot.dias_pos.add(dia); }
      }
    }

    out.serie_vida = Object.keys(porMes).sort().map(mes => {
      const m = porMes[mes];
      // fase PREDOMINANTE do mês (a que gerou mais energia) — o mês da virada é misto
      const domin = Object.keys(m.fases).sort((a, b) => m.fases[b] - m.fases[a])[0] || null;
      const misto = Object.keys(m.fases).length > 1;
      const S = serie.find(x => x.mes === mes) || null;   // dado do ONS, se existir p/ este mês
      return { mes, lbl: lbl(mes),
        total_gwh: r2((m.pre + m.pos) / 1000),
        pre_cod_gwh: r2(m.pre / 1000), pos_cod_gwh: r2(m.pos / 1000),
        fase: domin, fase_mista: misto ? 1 : 0,
        // o ONS (e portanto corte/irradiância) só existe no pós-COD; deixo explícito em vez de zerar
        tem_ons: S ? 1 : 0,
        cortado_gwh: S ? S.frustrada_gwh : null,
        horas_restricao: S ? S.horas_restricao : null };
    });

    out.totais_vida = {
      pre_cod_gwh: r2(tot.pre / 1000), pos_cod_gwh: r2(tot.pos / 1000),
      total_gwh: r2((tot.pre + tot.pos) / 1000),
      pre_pct: (tot.pre + tot.pos) > 0 ? r2(100 * tot.pre / (tot.pre + tot.pos)) : null,
      dias_pre: tot.dias_pre.size, dias_pos: tot.dias_pos.size,
      por_fase_gwh: Object.fromEntries(Object.entries(tot.por_fase).map(([k, v]) => [k, r2(v / 1000)])),
      primeiro_dia: out.serie_vida.length ? out.serie_vida[0].mes : null,
      // datas oficiais, para o painel rotular sem chumbar nada no HTML
      teste_ini: '2025-01-21', performance_ini: '2025-07-09',
      cod_primeiro: '2025-09-04', cod_ultimo: '2025-11-22',
      fonte: 'energia líquida medida pelo Way2 (medidor de faturamento); fases dos despachos ANEEL e SGIs',
    };
    console.log('vida da usina: ' + out.serie_vida.length + ' meses · pré-COD ' + out.totais_vida.pre_cod_gwh
      + ' GWh (' + out.totais_vida.pre_pct + '%) · pós-COD ' + out.totais_vida.pos_cod_gwh + ' GWh');
  }

  // ---------- perfil intradiário (blob PRÓPRIO) ----------
  // 48 slots × 10 séries × 45 dias nao cabe no executivo.json sem dobrar o arquivo que TODOS os
  // paineis baixam. Blob separado: so quem abre o perfil paga o download.
  // O ONS entrega irr/ge/gv de 30 em 30 min POR USINA — a area entre `ge` (potencial) e `gv`
  // (entregue) e a energia cortada naquela meia hora. E o que distingue nuvem de curtailment:
  // na nuvem as duas curvas caem juntas; no corte o `gv` despenca com o `ge` intacto.
  {
    const perfil = [];
    const diasJan = 30;
    const corte = new Date(Date.now() - 3 * 3600 * 1000 - diasJan * 86400000).toISOString().slice(0, 10);
    const porDia = {};   // dia -> hhmm -> ufv -> {irr,ge,gv}
    for (const m of Object.keys(CRU)) {
      for (const r of (CRU[m] || [])) {
        const dia = String(r.ts).slice(0, 10); if (dia < corte) continue;
        const hhmm = String(r.ts).slice(11, 16); if (!/^\d\d:\d\d$/.test(hhmm)) continue;
        const u = String(r.u).replace('CEFMT', 'M');
        ((porDia[dia] = porDia[dia] || {})[hhmm] = porDia[dia][hhmm] || {})[u] = {
          irr: num(r.irr), ge: num(r.ge), gv: num(r.gv) };
      }
    }
    const emp = (dia, hhmm, ufv, o) => {
      // so os campos que o painel desenha: `hhmm` sai (redundante com `h`, que o eixo formata como
      // hora) e `corte_mw` sai (e a area entre as duas curvas, o grafico ja mostra). 21 mil pontos
      // multiplicam qualquer byte a mais.
      const [hh, mm] = hhmm.split(':').map(Number);
      // INVARIANTE: o potencial NUNCA pode ser menor que o entregue — a usina nao entrega o que
      // nao podia gerar. Quando isso acontece, o `ge` do ONS esta furado e nao ha corte nenhum.
      // Ex. real 16/07 09:30: 8 das 9 usinas com ge=0, soma 7,3 MW contra 92,8 MW entregues.
      // Somando cru, o potencial despencava a zero em pleno meio-dia de sol.
      // Nesses slots o potencial vira NULL e a linha abre um buraco (spanNulls off): a leitura
      // honesta e "aqui nao se sabe", nao "aqui nao havia potencial".
      // `ge <= 0` sozinho NAO e defeito: de madrugada o potencial e zero mesmo. O defeito e a
      // CONTRADICAO — entregar mais do que se podia gerar.
      const ruim = o.ge == null || (o.gv > 0 && o.ge < o.gv);
      perfil.push({ dia, h: hh + mm / 60, ufv,
        irr: o.irr > 0 ? Math.round(o.irr) : null,
        pot_mw: ruim ? null : r2(o.ge), ent_mw: r2(o.gv) });
    };
    for (const dia of Object.keys(porDia).sort()) {
      for (const hhmm of Object.keys(porDia[dia]).sort()) {
        const S = porDia[dia][hhmm];
        let ge = 0, gv = 0, irrS = 0, irrN = 0;
        for (const u of Object.keys(S)) { emp(dia, hhmm, u, S[u]);
          ge += S[u].ge; gv += S[u].gv; if (S[u].irr > 0) { irrS += S[u].irr; irrN++; } }
        emp(dia, hhmm, 'Complexo', { ge, gv, irr: irrN ? irrS / irrN : 0 });
      }
    }
    // ---- reconstrucao do potencial nos buracos do ONS ----
    // A saida de um painel e praticamente LINEAR na irradiancia, entao pot = k x irr. O k sai dos
    // proprios slots bons DAQUELE dia e DAQUELA usina (mesmo ceu, mesma sujeira, mesma temperatura),
    // por mediana — imune aos outliers que criaram o problema. Medido nos slots bons: erro mediano
    // 1,9%, p90 7,5%. Nos 91 buracos diurnos a irradiancia EXISTE em todos, entao ha insumo.
    // Vai em campo SEPARADO (`pot_est_mw`): estimativa nunca se mistura com medicao no mesmo campo.
    // Se o dia tem poucos slots bons, cai para o k mediano dos ultimos 30 dias daquela usina.
    {
      const kGlobal = {};                                    // ufv -> k de referencia
      const porUfvDia = {};                                  // ufv|dia -> k
      const razoes = {};
      perfil.forEach(x => { if (x.irr > 50 && x.pot_mw > 0) {
        (razoes[x.ufv + '|' + x.dia] = razoes[x.ufv + '|' + x.dia] || []).push(x.pot_mw / x.irr);
        (kGlobal[x.ufv] = kGlobal[x.ufv] || []).push(x.pot_mw / x.irr); } });
      const mediana = a => { if (!a || !a.length) return null;
        const s = a.slice().sort((p, q) => p - q); return s[Math.floor(s.length / 2)]; };
      Object.keys(razoes).forEach(k => { if (razoes[k].length >= 10) porUfvDia[k] = mediana(razoes[k]); });
      Object.keys(kGlobal).forEach(u => { kGlobal[u] = mediana(kGlobal[u]); });
      // k LOCAL no tempo, nao do dia inteiro: de manha o painel esta frio e rende mais por W/m2,
      // entao um k medio do dia subestima justamente nos buracos da manha — e o piso (potencial
      // nunca abaixo do entregue) disparava, fazendo o grafico AFIRMAR corte zero naquela meia
      // hora. Janela de +-2h, caindo para o dia e depois para o global quando falta vizinho.
      const bons = {};
      perfil.forEach(x => { if (x.irr > 50 && x.pot_mw > 0)
        (bons[x.ufv + '|' + x.dia] = bons[x.ufv + '|' + x.dia] || []).push(x); });
      const kLocal = (x) => {
        const viz = (bons[x.ufv + '|' + x.dia] || []).filter(b => Math.abs(b.h - x.h) <= 2);
        if (viz.length >= 4) return mediana(viz.map(b => b.pot_mw / b.irr));
        return porUfvDia[x.ufv + '|' + x.dia] != null ? porUfvDia[x.ufv + '|' + x.dia] : kGlobal[x.ufv];
      };
      let est = 0, piso = 0;
      perfil.forEach(x => {
        x.pot_est_mw = null;
        if (x.pot_mw != null || !(x.irr > 50)) return;        // so buraco diurno
        const k = kLocal(x); if (k == null) return;
        const bruto = k * x.irr, ent = num(x.ent_mw);
        // Estimativa ABAIXO do entregue nao carrega informacao: "potencial = entregue" AFIRMA corte
        // zero naquela meia hora, e isso seria uma conclusao inventada. Nesses slots o buraco FICA.
        // O holdout (1,8% mediano) mede o metodo em dado BOM — nao valida os buracos, porque a
        // falta nao e aleatoria: ela acontece onde o ONS degradou, e ali a propria irradiancia vem
        // de um subconjunto de usinas, enxergando menos sol que o complexo.
        if (bruto <= ent) { piso++; return; }
        x.pot_est_mw = r2(bruto);
        est++; });
      console.log('  potencial reconstruido em ' + est + ' slots (k local +-2h) · piso acionado em ' + piso);
    }

    const dias = [...new Set(perfil.map(x => x.dia))].sort();
    const tam = await writeOut({ gerado_em: new Date().toISOString(), dias, perfil }, 'perfil_dia.json');
    console.log('perfil_dia.json OK · ' + dias.length + ' dias · ' + perfil.length + ' pontos · ' + Math.round(tam / 1024) + ' KB');
    // alimenta o seletor de dia SEM baixar o perfil (1 MB). Objetos, nao strings cruas: a variavel
    // do Infinity le COLUNA de tabela. Mais novo primeiro -> o padrao do seletor e o dia recente.
    out.perfil_dias = dias.slice().reverse().map(d => ({ dia: d }));
  }

  // limite direito do eixo do grafico diario, POR MES. A barra e centrada no dia: com o eixo
  // terminando no ultimo dia, metade dela fica de fora. Meia casa a mais resolve — mas tem que
  // vir como `max` do eixo, nao como ponto no dado (ponto fracionario encolhe as barras).
  // A variavel $maxdia le daqui e o override do painel usa o valor.
  {
    out.meses_eixo = meses.map(m => ({ mes: m,
      max_dia: new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate() + 0.5 }));
  }

  const size = await writeOut(out);
  console.log('executivo.json OK · mês ' + mesAtual + ' (' + cur.dias + '/' + diasTotal + ' dias)');
  console.log('  entregue ' + entregue + ' GWh | potencial ' + potencial + ' | cortado ' + cortado + ' (' + cur.frustrada_pct + '%)');
  console.log('  PR ' + cur.pr_pct + '% | disp ' + cur.disp_pct + '% | projeção fechamento ' + mes.projecao.realizado_gwh + ' GWh');
  console.log('  corte PPA ' + mes.ppa.corte_pct + '% × ML ' + mes.ml.corte_pct + '%  <- a estratégia');
  console.log('  ' + Math.round(size / 1024) + ' KB · ' + serie.length + ' meses');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
