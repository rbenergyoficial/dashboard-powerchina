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
// A REGRA, desde 2026-08-02: A FONTE EMITE AS NOVE. O usuário corrigiu a planilha e ela passou a
// trazer também as colunas "UFV Mauriti 7 / 10 / 9" na linha Valor Garantido. Então aqui não se
// deriva nada — LÊ-SE:
//   PPA -> `ppa_por_ufv`      ML -> `ml_por_ufv`
// Derivar um número que a fonte já entrega é inventar, e foi exatamente o erro corrigido em 25/07 na
// outra ponta. A regra que a planilha aplica (decifrada e conferida nos 7 meses): M1 leva a taxa do
// PPA — 137,73 MWh/MW, idêntico ao M8, que tem a mesma potência — e M7+M9 dividem o resto
// proporcional à POTÊNCIA (3977,43 ÷ 2651,62 = 1,50 = 14,733 ÷ 9,822 MW).
// Difere do rateio que se fazia aqui (pela Energia Equivalente): a SOMA é a mesma, mas o M1 ficava
// com 8929,48 em vez de 6763,70 e M7/M9 com um terço a menos. Agregados (Complexo/PPA/ML) não mudam;
// os cards POR USINA mudam.
// O ramo de rateio fica para meses gravados antes da correção — sem ele, um mês sem `ml_por_ufv`
// sairia com meta ZERO no ML e o painel mostraria atingimento infinito sem avisar.
// M7 E M9 NA MESMA TAXA — decisão do usuário em 02/08/2026, depois de ver o efeito.
// A planilha põe M1 na taxa do PPA e joga TODO o resto em M7 e M9. Como a meta global é menos
// conservadora que a do PPA, isso dá aos dois menores parques 269,97 MWh/MW contra 137,72 de todos os
// outros — quase o dobro. O atingimento deles caía para 40% e 44% não por desempenho, mas por régua.
// Agora os três do ML usam a MESMA taxa por MW do PPA (garantido_ppa ÷ capacidade_ppa do mês, que já
// varia com os dias). A diferença que sobra vira `nao_alocado`, EXPOSTA — é pergunta para quem emite
// a meta, não número para enterrar nos dois parques menores.
// `ml_por_ufv` continua no metas.json como REGISTRO DA FONTE (o que a planilha diz); a política de
// alocação mora aqui, no gerador. Por isso M1 sai de lá e M7/M9 saem da taxa.
function metasPorUfv(mtm) {
  if (!mtm) return null;
  const n = v => Number(v) || 0;
  const out = {};
  PPA.forEach(u => { out[u] = (mtm.ppa_por_ufv || {})[u] != null ? Number(mtm.ppa_por_ufv[u]) : 0; });
  if (mtm.ml_por_ufv) {
    const capPpa = PPA.reduce((a, u) => a + CAP_UFV[u], 0);      // 270,105 MW
    const taxa = n(mtm.garantido_ppa) / capPpa;                   // MWh/MW naquele mês
    out.M1 = n(mtm.ml_por_ufv.M1);                                // da planilha
    out.M7 = taxa * CAP_UFV.M7;
    out.M9 = taxa * CAP_UFV.M9;
    return out;
  }
  // fallback p/ meses gravados antes de a planilha emitir o ML: o resto rateado pelo equivalente.
  // Sem ele um mês sem `ml_por_ufv` sairia com meta ZERO e o painel mostraria atingimento infinito.
  const eq = mtm.equivalente_por_ufv || {};
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
      // BENCHMARK REGIONAL, mes a mes: o corte do subsistema Nordeste INTEIRO na mesma janela e pelo
      // mesmo criterio (campo de limitacao preenchido, inclusive zero). Vem junto na linha do mes
      // para o grafico sair de UMA query — duas series em frames separados exigiriam um join, e o
      // painel de serie temporal do Grafana nao junta bem frames de origens diferentes.
      // APURADO POR NOS sobre o mesmo arquivo do ONS, os 54 conjuntos fotovoltaicos do subsistema
      // (scratchpad/regiao_ne.js). E constante porque a janela e fechada: mar-jul/2026. Estender
      // exigiria baixar ~9 MB por mes do S3 do ONS a cada rodada — caro para um cron de hora em hora,
      // e o valor de meses passados nao muda.
      // REAPURADO EM 02/08/2026 com JULHO COMPLETO. A apuracao anterior era de 28/07 e julho entrou
      // com 26 dias de 31 — o painel anunciava "mar-jul" mostrando um julho pela metade.
      ne_curtail_pct: ({ '2026-03': 22.07, '2026-04': 26.34, '2026-05': 31.71,
        '2026-06': 24.39, '2026-07': 28.72 })[mes] ?? null,
      // O NOSSO corte AUDITADO, do mesmo arquivo e da mesma apuracao dos outros dois. NAO e o
      // `frustrada_pct` calculado acima: aquele inclui 03/03 e 11/03, dois dias em que o ONS publica
      // 70% e 77% MAIS geracao do que o medidor Way2 registrou (fisicamente impossivel), o que infla
      // o gerado e AFUNDA o percentual de corte — em marco a diferenca e 22,07% contra 23,57%.
      // Comparar um numero nosso contaminado contra um benchmark limpo nao valeria nada, entao os
      // graficos de comparacao usam ESTE campo nas tres series.
      mauriti_curtail_pct: ({ '2026-03': 23.57, '2026-04': 23.53, '2026-05': 23.15,
        '2026-06': 14.06, '2026-07': 21.32 })[mes] ?? null,
      // BENCHMARK DE PAR DIRETO: o Conj. Abaiara 230 kV (Milagres I a V) esta na MESMA malha, e por
      // isso e a comparacao que o investidor pede depois da regional — "e o vizinho, sofreu igual?".
      // Apurado do mesmo arquivo do ONS e pela MESMA formula usada aqui para o Mauriti,
      // frustrada/(gerada+frustrada); com formulas diferentes a comparacao nao valeria nada.
      // Fonte: relatorio comparativo de 28/07/2026, scratchpad/analise.js.
      // ATENCAO jan e fev: a serie de REFERENCIA do ONS para o Mauriti so fica sadia a partir de
      // marco (razao referencia/gerado abaixo de 1,00 antes disso), entao o corte do Mauriti nesses
      // dois meses sai SUBESTIMADO — 5,01% e 5,36% contra 17,64% e 8,62% de Abaiara. Nao e vantagem
      // nossa, e defeito de dado. O painel comeca a comparacao em marco.
      // REAPURADO em 02/08/2026 junto com os outros dois. Mudou em TODOS os meses, nao so em julho:
      // o ONS revisa dados publicados, e a serie de Abaiara mexeu ate em marco (24,25 -> 24,20).
      abaiara_curtail_pct: ({ '2026-01': 17.64, '2026-02': 8.62, '2026-03': 24.20, '2026-04': 24.15,
        '2026-05': 23.05, '2026-06': 18.11, '2026-07': 17.20 })[mes] ?? null,
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

    // ---- meta por usina: LIDA da planilha, as nove ----
    // Histórico das regras, porque os números mudaram duas vezes e alguém vai comparar com um print
    // antigo: até 25/07/2026 a meta do ML era derivada da taxa do PPA sobre a potência (sobravam
    // 3,25 GWh em `nao_alocado`); de 25/07 a 02/08 era o RESTO rateado pela Energia Equivalente; desde
    // 02/08 a planilha emite as três e o gerador só lê. Detalhe da regra no topo do arquivo.
    if (mt) {
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
      ml_fonte: mt.ml_por_ufv
        ? 'M1 vem da planilha (linha "Valor Garantido", coluna UFV Mauriti 10). M7 e M9 usam a MESMA '
          + 'TAXA POR MW do PPA — ' + r2(mt.garantido_ppa / PPA.reduce((a, u) => a + CAP_UFV[u], 0))
          + ' MWh/MW neste mes — por decisao do usuario em 02/08/2026. A planilha jogava todo o resto '
          + 'nos dois, o que lhes dava quase o DOBRO da taxa das outras sete e derrubava o atingimento '
          + 'deles por regua, nao por desempenho.'
        : 'DERIVADA (mes anterior a correcao da planilha): o resto entre a meta do complexo ('
          + r2(mt.garantido_total / 1000) + ' GWh) e a do PPA (' + r2(mt.garantido_ppa / 1000)
          + ' GWh), rateado entre M1/M7/M9 pela Energia Equivalente.',
      por_ufv: metaUfv,
      nao_alocado_gwh: r2(naoAlocado / 1000),
      nao_alocado_nota: 'O que a meta do complexo tem a MAIS do que a soma das nove usinas na taxa do '
        + 'PPA. Nao e erro nem sobra para enterrar em ninguem: e a diferenca de criterio entre a meta '
        + 'global e a do PPA, e fica EXPOSTA porque e pergunta para quem emite a meta.',
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
          var_cor: col(cur.var_corte_pp == null ? null : cur.var_corte_pp <= 0, cur.var_corte_pp), cor: '#8B7FD4',
          spark: path(S.map(s => s.corte_pct_pot), '#8B7FD4'), spark_ini: ini, spark_fim: fim },
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
      // os dois grupos entram na serie diaria como se fossem usinas — ver o bloco que os soma abaixo
      const GRUPOS = { PPA, ML };
      const metaGrupo = (g, dias, MPU) => MPU ? r2(GRUPOS[g].reduce((a, u) => a + num(MPU[u]), 0) / dias) : null;
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
          // PPA e ML sao GRUPOS, e ate aqui so existiam no mensal (`serie_ufv`). Sem eles, escolher
          // "PPA" com um mes no filtro do Sumario nao tinha serie diaria e o grafico caia de volta
          // para o mensal. Somo os membros no proprio dia.
          //   energia e meta SOMAM;
          //   irradiancia e media PONDERADA POR POTENCIA — media simples daria a M7 (8,1 MW) o mesmo
          //   peso da M4 (55 MW) e o numero nao representaria o grupo.
          // Somo o valor CRU de cada membro e arredondo uma vez so: somar 6 valores ja arredondados
          // acumula ate 0,03 MWh/dia, que em 151 dias vira ~4,5 MWh de divergencia contra o mensal.
          Object.entries(GRUPOS).forEach(([g, membros]) => {
            const vG = r2(membros.reduce((a, u) => a + num((x.ufv_liq_mwh || {})[u]), 0));
            const [feG, hoG] = parte(vG);
            let sIrr = 0, sCap = 0;
            membros.forEach(u => {
              const i = med((irrDiaU[d] || {})[u]);
              if (i != null) { sIrr += i * CAP_UFV[u]; sCap += CAP_UFV[u]; }
            });
            out.push({ mes: m, dia: d, dia_num: dnum, ufv: g, liq_mwh: vG,
              liq_fechada_mwh: feG, liq_hoje_mwh: hoG,
              irr: sCap > 0 ? r2(sIrr / sCap) : null,
              meta_dia_mwh: metaGrupo(g, dias, MPUd), parcial: pc, encerrado: enc, ate });
          });
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
          // os grupos tambem reservam o lugar no eixo, senao o mes deles terminaria antes do das usinas
          Object.keys(GRUPOS).forEach(g => out.push({ mes: m, dia: d, dia_num: dn, ufv: g,
            liq_mwh: null, liq_fechada_mwh: null, liq_hoje_mwh: null, irr: null,
            meta_dia_mwh: metaGrupo(g, dias, MPUd), parcial: 0, ate: null }));
        }
        // NAO inserir ponto fracionario aqui para "dar folga" no eixo: a largura da barra no
        // Grafana vem do MENOR intervalo entre pontos do eixo, entao um ponto em `dias + 0.5`
        // encolhe TODAS as barras pela metade (e ainda faz o eixo mostrar o tick 31 em junho).
        // A folga do eixo e resolvida no painel por SEGUNDA QUERY + `configFromData` (nao por
        // variavel do Grafana, que nao interpola em campo numerico) — ver
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

    // SPARKLINE EM LINHA, para o sumario executivo. Diferente do `barras()` acima, que e HTML e
    // serve ao card operacional: aqui vai SVG com a REFERENCIA DE 100% desenhada, porque a pergunta
    // do investidor nao e "quanto" e sim "esteve acima da meta o tempo todo?". A linha cruzando (ou
    // nao) o tracejado responde isso antes de qualquer numero ser lido.
    // O ultimo ponto ganha marcador cheio — e o periodo corrente, na cor de acento; o resto da
    // linha fica na cor de apoio, conforme a especificacao de stat tile.
    // SPARKLINE do sumario executivo, em HTML — NAO em SVG.
    // Aprendido na marra: o sanitizador do dynamictext REMOVE <svg>. O unico sparkline que funciona
    // no projeto (painel [956]) sempre foi HTML de divs; eu escrevi SVG por parecer mais fino e o
    // card saiu com um vao no lugar do grafico. Barra fina em div passa, e faz o mesmo trabalho.
    // A LINHA DE 100% e um div posicionado: e ela que da sentido ao desenho, porque a pergunta nao
    // e "quanto" e sim "esteve acima da meta o tempo todo?". A ultima barra vai na cor de acento.
    const sparkLinha = (vals, cor, corApoio) => {
      const v = vals.map(x => (x == null ? null : Number(x)));
      const ok = v.filter(x => x != null);
      if (ok.length < 2) return '';
      // a escala inclui SEMPRE o 100, senao a referencia sai do quadro quando todos os meses batem
      const mn = Math.min(...ok, 100), mx = Math.max(...ok, 100), amp = (mx - mn) || 1;
      const alt = y => (8 + (y - mn) / amp * 84).toFixed(1);      // 8%..92% da caixa
      const y100 = (100 - Number(alt(100))).toFixed(1);           // topo, em % (CSS cresce p/ baixo)
      const ult = v.length - 1;
      const barras = v.map((y, i) => y == null
        ? '<div style="flex:1;min-width:2px"></div>'
        : '<div style="flex:1;min-width:2px;display:flex;align-items:flex-end">'
          + '<div style="width:100%;height:' + alt(y) + '%;border-radius:2px 2px 0 0;background:'
          + (i === ult ? cor : corApoio) + '"></div></div>').join('');
      return '<div style="position:relative;height:38px;display:flex;align-items:flex-end;gap:3px">'
        + barras
        + '<div style="position:absolute;left:0;right:0;top:' + y100 + '%;height:1px;'
        + 'background:#4A5261"></div>'
        + '</div>';
    };

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
      // PPA e ML sao GRUPOS. Desde 04/08/2026 eles TAMBEM tem linha propria em serie_dia_ufv (para o
      // filtro do Sumario descer ao dia), mas aqui continuo somando os MEMBROS de proposito: e o
      // mesmo numero, e nao passa a depender de uma linha derivada. Cuidado ao mexer — somar membros
      // E a linha do grupo contaria a energia duas vezes (a primeira versao disso fez o PPA saltar
      // de 124,68 para 126,21).
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
          cor: '#8B7FD4', spark: barras(S.map(x => x.corte_pct), '#8B7FD4'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'proj', label: 'Projeção de corte', v: fmt(projCorte), u: 'GWh',
          sub: ant ? ant.lbl + ' fechou em ' + fmt(antCorte) + ' GWh' : 'no fechamento do mês',
          var: '', var_cor: '#8B93A1', cor: '#8B7FD4',
          spark: barras(S.map(x => x.cortado_gwh), '#8B7FD4'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
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
        // DIA DO CALENDARIO do dia em curso. `dias_decorridos` conta dias FECHADOS e por isso fica
        // um atras da data — 28 fechados quando o calendario ja marca 29. O numero esta certo para
        // o que mede (e o divisor da projecao), mas o card rotulava "DIA 28 DE 31", que se le como
        // "hoje e dia 28" e parece defeito de dado. Com os dois campos o texto pode dizer a data E
        // quantos dias entram na projecao, sem escolher entre estar correto e ser compreensivel.
        // Nulo quando nao ha dia em curso (mes fechado) — o template testa com {{#if}}.
        dia_hoje: parc.length ? parc[parc.length - 1].dia_num : null,
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
        // SO MESES FECHADOS: incluir um mes pela metade compara realizado parcial (dia 17) contra
        // meta do mes inteiro e derruba o acumulado artificialmente (dava 97% quando o real e 111%).
        //
        // O TESTE E `fechado`, NAO "e o mes corrente". Usar o mes corrente como atalho funciona 30
        // dias e quebra no 31o: em 01/08, `mesAtual` ainda era 2026-07 (nao havia dado de agosto) e
        // julho — que ja tinha fechado com 31 de 31 dias — ficava de fora do acumulado. O ano
        // "perdia" um mes inteiro justamente no dia em que ele deveria entrar.
        const A = S.filter(x => x.mes.slice(0, 4) === ano && (x.mes !== mesAtual || fechado));
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
          // ---- ATINGIMENTO SOBRE META INDEPENDENTE ----
          // Em fev, mar e abr/2026 a meta gravada e EXATAMENTE a energia realizada (diferenca
          // 0,000 GWh nos tres). Nesses meses bater a meta e aritmetico, nao desempenho, e o 100,00%
          // que aparece nao mede nada. Num documento que vai a investidor isso e pior do que um
          // numero ruim: tres 100,00% seguidos derrubam a credibilidade da peca inteira quando
          // alguem repara.
          // Entao publica-se TAMBEM o atingimento calculado so onde a meta e independente do
          // realizado. No Complexo da 105,63% contra os 102,57% do total — o numero honesto e o
          // MAIOR, o que torna a escolha facil. O total continua publicado ao lado, identificado.
          // ---- TREND + DELTA: o contrato de stat tile pede label, valor, DELTA e TENDENCIA ----
          // So valor e rotulo deixa o card parecendo um numero solto. A trajetoria contra a linha
          // de 100% responde "esteve sempre acima?" antes de qualquer leitura, e o delta diz para
          // onde vai. Ambos derivados do que ja existe — nenhuma fonte nova.
          ...(() => {
            const cor = { Complexo: '#E0B84A', PPA: '#7FA8E8', ML: '#5FBF8E' }[u] || '#98A2B3';
            const serie = temMeta.map(x => x.atingido_pct);
            const n = serie.length;
            const d = (n >= 2 && serie[n - 1] != null && serie[n - 2] != null)
              ? r2(serie[n - 1] - serie[n - 2]) : null;
            return { spark_ating: sparkLinha(serie, cor, '#6B7482'),
              delta_pp: d, delta_txt: d == null ? null : (d >= 0 ? '+' : '') + fmt(d) + ' pp',
              ult_pct: n ? serie[n - 1] : null,
              ult_lbl: temMeta.length ? temMeta[temMeta.length - 1].lbl : null };
          })(),
          ...(() => {
            const F = temMeta.filter(x => x.liquida_gwh != null
              && Math.abs(x.liquida_gwh - x.meta_gwh) > 0.005);
            const mF = F.reduce((a, x) => a + x.meta_gwh, 0);
            const lF = F.reduce((a, x) => a + x.liquida_gwh, 0);
            return { meses_meta_firme: F.length,
              meses_meta_igual: temMeta.length - F.length,
              lbl_meta_firme: F.map(x => x.lbl).join(', ') || null,
              liquida_firme_gwh: F.length ? r2(lF) : null,
              meta_firme_gwh: F.length ? r2(mF) : null,
              atingido_firme_pct: mF > 0 ? r2(100 * lF / mF) : null };
          })(),
          // ---- KPIs DE CONJUNTO PARA A ABERTURA DO SUMARIO ----
          // Por que aqui e so no Complexo: disponibilidade e corte NAO existem por usina. O ONS
          // publica os dois para o conjunto, e a serie por usina e sabidamente defeituosa em M3 e M7.
          // Repetir o valor do conjunto em cada linha de usina convidaria a leitura errada.
          //
          // Por que existem: o painel de abertura desenhava esses numeros CHUMBADOS no HTML do card.
          // Um numero escrito a mao dentro de um template nao tem fonte, nao tem janela e nao
          // acompanha o dado — e o pior lugar possivel para um valor que vai a investidor. Sobem
          // para ca, onde qualquer painel pode ler o MESMO valor.
          //
          // A JANELA DELES NAO E A DO ACUMULADO, e isso precisa ficar visivel no painel: o
          // acumulado e jan-jul, mas o corte so vale de MARCO em diante — antes disso a serie de
          // referencia do ONS para o Mauriti sai baixa e o corte apareceria subestimado (5,01% em
          // janeiro), o que daria uma vantagem falsa contra o Nordeste. Mesma razao pela qual os
          // graficos comparativos comecam em marco.
          ...(u !== 'Complexo' ? {} : (() => {
            const D = out.serie.filter(x => x.mes.slice(0, 4) === ano
              && (x.mes !== mesAtual || fechado) && x.disp_pct != null);
            // MARCA as linhas que entraram na conta. O painel de Disponibilidade precisa filtrar
            // pelo MESMO criterio, senao ele faz media de um conjunto e exibe um rotulo de outro —
            // foi o que aconteceu em 03/08: agosto entrou na serie com DOIS dias, a media do card
            // subiu para 99,50% e o texto ao lado continuou dizendo "7 meses fechados".
            // Marcar aqui, e nao repetir a regra no painel, garante que os dois nunca divirjam.
            out.serie.forEach(x => { if (x.fechado == null) x.fechado = 0; });
            D.forEach(x => { x.fechado = 1; });
            // Constantes auditadas (scratchpad/analise.js e regiao_ne.js), apuradas no NIVEL
            // CONJUNTO do arquivo do ONS — nao pela soma das usinas, que carrega o defeito de M3/M7.
            // Mesma formula nos tres: frus/(ger+frus), so onde val_geracaolimitada vem PREENCHIDO.
            // REAPURADO EM 02/08/2026 COM JULHO COMPLETO. A apuracao de 28/07 tinha julho com 26 dias
            // de 31, e o painel anunciava "mar-jul" mostrando um julho pela metade: Mauriti caiu de
            // 21,78 para 21,20, Abaiara de 22,04 para 21,32 e o Nordeste de 26,82 para 26,80 — a
            // vantagem contra a regiao SUBIU de 5,04 para 5,60 pp.
            // 03/03 e 11/03 seguem FORA dos tres, pela mesma razao de sempre: o ONS publica neles
            // mais geracao do que o medidor Way2 mediu, e uma usina nao entrega mais do que o proprio
            // medidor de fronteira registrou. Excluir de um so e comparar janelas diferentes.
            const MAURITI = 21.20, NORDESTE = 26.80, ABAIARA = 21.32;
            // A ENERGIA, nao so o percentual. Para quem le, 21,20% e abstrato; 69,40 GWh que o ONS
            // impediu de gerar e concreto, e e o numero que a pessoa leva da reuniao. O atingimento
            // ja aparecia em GWh no card ao lado — o corte nao, e essa assimetria enfraquecia o lado
            // que mais precisa de peso. Mesma apuracao dos percentuais acima.
            const CORTADO_GWH = 69.40;
            // A MESMA apuracao, aberta: o que foi gerado, e por que o resto nao foi. Tudo da janela
            // mar-jul, para os cards nao misturarem recorte — o erro que derrubava a versao anterior
            // do painel era exatamente este: waterfall e causa vinham do acumulado pos-COD enquanto
            // o card do corte dizia mar-jul, e ninguem avisava.
            const GERADA_GWH = 258.87;              // Mauriti, conjunto, mar-jul
            const RAZAO = { ene: 94.63, cnf: 3.99, rel: 1.37 };   // % da energia frustrada
            const RAZAO_GWH = { ene: 65.67, cnf: 2.77, rel: 0.95 };
            const ORIGEM = { sis: 96.41, loc: 3.59 };             // sistemico x local
            const HORAS_RESTR = 1056;
            return {
              disp_ytd_pct: D.length ? r2(D.reduce((a, x) => a + x.disp_pct, 0) / D.length) : null,
              disp_meses: D.length, disp_alvo_pct: 97,
              corte_conj_pct: MAURITI, corte_ne_pct: NORDESTE, corte_abaiara_pct: ABAIARA,
              corte_gwh: CORTADO_GWH, corte_gerada_gwh: GERADA_GWH,
              corte_possivel_gwh: r2(GERADA_GWH + CORTADO_GWH),
              corte_horas: HORAS_RESTR,
              corte_ene_pct: RAZAO.ene, corte_cnf_pct: RAZAO.cnf, corte_rel_pct: RAZAO.rel,
              corte_ene_gwh: RAZAO_GWH.ene, corte_cnf_gwh: RAZAO_GWH.cnf, corte_rel_gwh: RAZAO_GWH.rel,
              corte_sis_pct: ORIGEM.sis, corte_loc_pct: ORIGEM.loc,
              corte_vantagem_pp: r2(NORDESTE - MAURITI),
              corte_janela: 'mar a jul/26 · 151 dias',
              corte_fonte: 'ONS · Restrição de Geração — conjunto, 54 conjuntos FV do subsistema NE; '
                + 'apurado em 02/08/2026, meses completos, menos 03/03 e 11/03 (dado do ONS impossível)',
            };
          })()),
          nota: 'Acumulado de ' + ano + ' — SOMENTE MESES FECHADOS. O mes corrente (' + cur.lbl + ', dia ' + dCorr + ' de ' + dTot + ') fica de fora: compara-lo pela metade contra a meta do mes inteiro derrubaria o acumulado artificialmente.' }); } }

      // ---- cascata ----
      const pot = cur.potencial_gwh;
      out.cascata_ufv.push(
        { mes: mSel, ufv: u, etapa: 'Entregue', gwh: cur.entregue_gwh, pct: pot > 0 ? r2(100 * cur.entregue_gwh / pot) : 0 },
        { mes: mSel, ufv: u, etapa: 'Cortado pelo ONS', gwh: cur.cortado_gwh, pct: pot > 0 ? r2(100 * cur.cortado_gwh / pot) : 0 },
        { mes: mSel, ufv: u, etapa: 'Outras perdas', gwh: cur.outras_gwh, pct: pot > 0 ? r2(100 * cur.outras_gwh / pot) : 0 });
    }); });

    // lista de meses p/ o seletor do painel (mais novo primeiro)
    // ---------- CAMPOS DE GRAFICO DO SUMARIO EXECUTIVO ----------
    // Tres series que o gestor pediu e que so existiam espalhadas. Vao para dentro de `serie`, na
    // linha do mes, e nao em arrays proprios: cada grafico sai de UMA query. Duas series em frames
    // separados exigiriam join, e o painel de tempo do Grafana nao junta bem frames de origens
    // diferentes — foi o que me custou uma rodada inteira no benchmark do Nordeste.
    {
      const porUfvMes = {};
      (out.serie_ufv || []).forEach(x => { (porUfvMes[x.ufv] = porUfvMes[x.ufv] || {})[x.mes] = x; });
      let accL = 0, accM = 0;
      const anoAtual = mesAtual.slice(0, 4);
      out.serie.forEach(s => {
        const P = (porUfvMes.PPA || {})[s.mes], L = (porUfvMes.ML || {})[s.mes];
        // 2) PPA x ML: a compensacao entre contratos e a leitura mais delicada do ano — o conjunto
        //    so fecha acima da meta porque o excedente do PPA cobre o deficit do mercado livre.
        s.ppa_ating_pct = P ? P.atingido_pct : null;
        s.ml_ating_pct = L ? L.atingido_pct : null;
        s.ppa_liq_gwh = P ? P.liquida_gwh : null;
        s.ml_liq_gwh = L ? L.liquida_gwh : null;
        // 3) ACUMULADO correndo contra a meta: percentual mensal nao mostra se o ANO esta ganho.
        //    Reinicia a cada ano — somar 2025 com 2026 misturaria comissionamento com operacao.
        if (s.mes.slice(0, 4) === anoAtual && s.meta_gwh != null && s.way2_liq_gwh != null) {
          accL += s.way2_liq_gwh; accM += s.meta_gwh;
          s.acum_liq_gwh = r2(accL); s.acum_meta_gwh = r2(accM);
          s.acum_ating_pct = accM > 0 ? r2(100 * accL / accM) : null;
        } else { s.acum_liq_gwh = null; s.acum_meta_gwh = null; s.acum_ating_pct = null; }
      });
    }

    // ---- SÉRIE + MÉDIA, só para os dois gráficos de entrega mês a mês ----
    // Eles ganham uma 8ª barra à direita com a MÉDIA do período. Sem ela o leitor compara cada mês
    // com o vizinho e não com o normal do ativo — e um mês fraco parece pior do que é (jun/26 é o
    // exemplo: a meta de 48,96 GWh parece baixa até se ver que a média entregue é 52,39).
    // POR QUE UM ARRAY PRÓPRIO, e não uma linha extra em `serie`: `serie` é lida por mais de dez
    // painéis; enfiar uma linha "MÉDIA" nela contaminaria todos, e o acumulado do ano passaria a
    // somar a média junto com os meses. Duplicar 8 linhas custa nada perto desse risco.
    // FICA AQUI, e não lá em cima junto do resto: `ppa_liq_gwh` só é gravado no bloco de PPA×ML
    // logo acima. Montar antes dava a coluna do PPA inteira em `undefined` — e em silêncio.
    out.serie_e_media = (() => {
      const anoAtual = mesAtual.slice(0, 4);
      const A = out.serie.filter(x => x.mes.slice(0, 4) === anoAtual && x.meta_gwh != null);
      if (!A.length) return [];
      const CAMPOS = ['way2_liq_gwh', 'meta_gwh', 'ppa_liq_gwh', 'meta_ppa_gwh'];
      const med = k => r2(A.reduce((a, x) => a + num(x[k]), 0) / A.length);
      // ---- as tres parcelas do EMPILHADO ----
      // Empilhar entregue COM meta seria falso: elas nao somam nada — sao a mesma energia contra
      // duas reguas. O que soma de verdade e a meta MAIS o que passou dela. Entao a barra vira
      //     base + acima      quando entregou mais que a meta   (total = entregue)
      //     base + abaixo     quando entregou menos             (total = meta)
      // com base = min(entregue, meta). Nos dois casos o topo colorido e a NOTICIA, e a altura da
      // barra e sempre o maior dos dois — nunca uma soma inventada.
      // O ramo `abaixo` nunca acendeu em 2026; existe para o primeiro mes ruim nao sair mudo.
      const parcelas = (liq, meta) => ({
        base_gwh: r2(Math.min(num(liq), num(meta))),
        acima_gwh: r2(Math.max(0, num(liq) - num(meta))),
        abaixo_gwh: r2(Math.max(0, num(meta) - num(liq))),
      });
      const pref = (o, p) => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));
      // ATINGIMENTO por mes. Entra no grafico como serie OCULTA na visualizacao e VISIVEL no
      // tooltip: o barchart rotula cada barra com o proprio valor plotado, entao nao ha como
      // estampar "%" numa barra que esta em GWh — mas o tooltip aceita a serie extra sem
      // desequilibrar o empilhamento, que precisa continuar somando energia.
      const pc = (l, m) => (num(m) > 0 ? r2(100 * num(l) / num(m)) : null);
      const linha = (rot, media, src) => Object.assign({ lbl: rot, media },
        Object.fromEntries(CAMPOS.map(k => [k, src(k)])),
        pref(parcelas(src('ppa_liq_gwh'), src('meta_ppa_gwh')), 'ppa_'),
        pref(parcelas(src('way2_liq_gwh'), src('meta_gwh')), 'cx_'),
        { ppa_ating_pct: pc(src('ppa_liq_gwh'), src('meta_ppa_gwh')),
          cx_ating_pct: pc(src('way2_liq_gwh'), src('meta_gwh')) });
      return A.map(x => linha(x.lbl, 0, k => x[k])).concat([linha('MÉDIA', 1, med)]);
    })();

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
        const at2 = m2.atingido_n == null ? null : num(m2.atingido_n);
        // A ORDEM IMPORTA, e estava errada: `fechado` vinha primeiro e engolia o veredito. Julho
        // fechou com 107,21% da meta e o selo dizia só "REALIZADO" — a palavra some com a boa
        // notícia justamente quando ela virou definitiva. Atingimento decide ANTES: bater a meta é
        // fato, e num mês fechado é fato encerrado.
        // PREENCHIDO = META ATINGIDA (não é "mês fechado"): é o único estado que merece destaque
        // sólido. Todo o resto fica em contorno.
        if (at2 != null && at2 >= 100) {
          m2.proj_fundo = '#43966B'; m2.proj_texto_cor = '#0F1113'; m2.proj_rotulo = 'META BATIDA';
        } else if (m2.fechado) {
          // fechado e não bateu: também é fato, não previsão. "NÃO BATE" falaria no futuro de um
          // mês que já acabou.
          m2.proj_fundo = '#342327'; m2.proj_texto_cor = '#E8A0A2'; m2.proj_rotulo = 'META NÃO BATIDA';
        } else if (pj2 == null) {
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
          // META BATIDA vem ANTES da regua de projecao, e nao e um quarto tom dela: quando o
          // ENTREGUE ja passou a meta, nao ha o que projetar — o mes esta ganho, faltando dias ou
          // nao. Dizer "BATE" nesse caso subnotifica o proprio resultado (o PPA em jul/26 estava em
          // 109% da meta e a tarja falava no futuro do indicativo).
          // O chip fica PREENCHIDO — contorno = projetado, preenchido = realizado.
          const at = num(m.atingido_n);
          const batida = m.atingido_n != null && at >= 100;
          // MES FECHADO nao admite linguagem de projecao: "NAO BATE" fala no futuro de um mes que
          // ja acabou. Fechado sem bater vira META NAO BATIDA, que e o fato.
          const faixa = batida ? 'batida' : (m.fechado ? 'nao_fech'
            : (pv >= 100 + erroBT ? 'bate' : (pv >= 100 - erroBT ? 'limite' : 'nao')));
          C['ctr_' + k + '_rot'] = { batida: 'META BATIDA', nao_fech: 'META NÃO BATIDA',
            bate: 'BATE', limite: 'NO LIMITE', nao: 'NÃO BATE' }[faixa];
          C['ctr_' + k + '_cor'] = { batida: '#0F1113', nao_fech: '#E8A0A2',
            bate: '#7FC49C', limite: '#F7D9A6', nao: '#E8A0A2' }[faixa];
          C['ctr_' + k + '_fundo'] = { batida: '#43966B', nao_fech: '#342327',
            bate: '#1D2D29', limite: '#3C301C', nao: '#342327' }[faixa];
          // sem `ctr_<g>_fechado`: os tres grupos sao do MESMO mes, entao o `fechado` da linha ja
          // responde por todos. Campo duplicado e mais uma coisa para sair de sincronia.
          C['ctr_' + k + '_batida'] = batida ? 1 : 0;
          // sobra JA REALIZADA (entregue - meta). Nao confundir com `_gwh`, que e projecao - meta.
          C['ctr_' + k + '_sobra'] = fmt(r2(num(m.liq_gwh) - num(m.meta_gwh)));
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
      // outorga repetida aqui de proposito: o Sumario Executivo monta o cabecalho a partir DESTE
      // bloco, e buscar `cap_mw` na raiz exigiria uma segunda query — que no dynamictext faz
      // aparecer o seletor de frame no rodape do painel (§4 da nota do plugin). Um campo duplicado
      // custa menos que um dropdown numa peca de apresentacao.
      cap_mw: out.cap_mw,
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

  // CAPACIDADE INSTALADA em cada ponto do perfil. Parece desperdício gravar uma constante 14 mil
  // vezes, mas resolve DOIS problemas com um mecanismo só, e sem variável nova no Grafana:
  //  1) É A LINHA DE REFERÊNCIA. Sem ela não se lê restrição nos dias que vêm do Way2, que não têm
  //     a linha de POTENCIAL do ONS: o eixo se ajustava à própria curva e um platô de 80 MW
  //     preenchia o gráfico inteiro, parecendo dia cheio. (25/07/2026 foi exatamente isso.)
  //  2) ANCORA O EIXO. Série constante em 343,77 força o eixo a chegar lá — então TODOS os dias
  //     passam a ter a MESMA escala. Antes era 200 MW num dia e 300 no outro, e comparar dois dias
  //     a olho não valia.
  // POR QUE NO DADO e não como `max`/threshold no painel: o painel é por $ufv e a capacidade muda
  // com a seleção; campo numérico de fieldConfig não interpola variável do Grafana. Vindo do dado
  // já filtrado, o valor certo aparece sozinho para cada usina.
  const CAPACIDADE = (u) => u === 'Complexo'
    ? r2(Object.values(CAP_UFV).reduce((a, b) => a + b, 0))
    : (CAP_UFV[u] != null ? CAP_UFV[u] : null);

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
        pot_mw: ruim ? null : r2(o.ge), ent_mw: r2(o.gv), cap_mw: CAPACIDADE(ufv) });
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

    // ---- OS DIAS QUE O ONS AINDA NÃO PUBLICOU, pelo Way2 ----
    // O perfil vinha 100% do ONS, que publica D+1/D+2 — então o dia de hoje e o de ontem não
    // existiam no seletor, e quem abria o painel via anteontem como "o mais recente". O Way2 é D+0
    // (snapshot de 5 min) e cobre esse vão.
    // O QUE VEM: a potência ENTREGUE, agregada em 30 min para casar com o passo do ONS.
    // O QUE NÃO VEM: irradiância e potencial — os dois só existem no ONS. Ficam null, e o gráfico
    // abre buraco em vez de fingir dado. Cada ponto leva `fonte`, para o painel poder rotular.
    {
      const ultOns = [...new Set(perfil.map(x => x.dia))].sort().pop() || '0000-00-00';
      const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const faltam = [];
      for (let d = new Date(ultOns + 'T12:00:00Z'); ; ) {
        d = new Date(d.getTime() + 86400000);
        const s = d.toISOString().slice(0, 10);
        if (s > hoje) break; faltam.push(s);
      }
      let novos = 0;
      for (const dia of faltam) {
        try {
          const snap = await getJSON(BASE + 'hist/way2_' + dia + '.json');
          const arr = snap.dados || [];
          const val = (pid) => { const s = arr.find(x => x.pontoId === pid && x.nomeGrandeza === 'Demat');
            const m = {}; (s ? s.valores : []).forEach(v => { if (v.valor != null) m[String(v.data).slice(11, 16)] = v.valor; });
            return m; };
          const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205],
            M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214],
            M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
          const mapa = { 6233: val(6233) };   // 6233 = medidor do COMPLEXO
          Object.values(CIRC).flat().forEach(p => { mapa[p] = val(p); });
          // MÉDIA POR PONTO, e só depois a soma. Somar leituras e dividir pela contagem total
          // erraria sempre que um circuito faltasse um slot: o divisor mudava e o resultado escorria.
          // Cada ponto vira a sua própria média na janela; depois somam-se as médias.
          const medias = {};   // '15:30' -> pontoId -> MW médios na meia hora
          for (const pid in mapa) for (const hm in mapa[pid]) {
            const [hh, mi] = hm.split(':').map(Number);
            const ch = String(hh).padStart(2, '0') + ':' + (mi < 30 ? '00' : '30');
            ((medias[ch] = medias[ch] || {})[pid] = medias[ch][pid] || []).push(mapa[pid][hm]);
          }
          const mediaDe = (o, pid) => { const a = o[pid];
            return a && a.length ? a.reduce((x, y) => x + y, 0) / a.length / 1000 : null; };
          Object.keys(medias).sort().forEach(chave => {
            const [hh, mm] = chave.split(':').map(Number), o = medias[chave];
            const põe = (ufv, mw) => { if (mw == null) return;
              perfil.push({ dia, h: hh + mm / 60, ufv, irr: null,
                pot_mw: null, pot_est_mw: null, ent_mw: r2(mw), cap_mw: CAPACIDADE(ufv),
                fonte: 'way2' }); };
            // o Complexo vem do PRÓPRIO medidor, não da soma dos 22 circuitos: uma medição só,
            // sem acumular o erro de 22. (Conferido: as duas dão o mesmo, 0,00% de diferença.)
            põe('Complexo', mediaDe(o, 6233));
            Object.keys(CIRC).forEach(u => {
              let s = 0, achou = false;
              CIRC[u].forEach(p => { const v = mediaDe(o, p); if (v != null) { s += v; achou = true; } });
              põe(u, achou ? s : null);
            });
          });
          novos++;
        } catch (e) { /* snapshot do dia nao existe: segue */ }
      }
      if (novos) console.log('  perfil estendido pelo Way2 em ' + novos + ' dia(s) apos o ONS ('
        + faltam.join(', ') + ') — sem irradiancia/potencial, que so o ONS tem');
    }

    const dias = [...new Set(perfil.map(x => x.dia))].sort();
    const tam = await writeOut({ gerado_em: new Date().toISOString(), dias, perfil }, 'perfil_dia.json');
    console.log('perfil_dia.json OK · ' + dias.length + ' dias · ' + perfil.length + ' pontos · ' + Math.round(tam / 1024) + ' KB');
    // alimenta o seletor de dia SEM baixar o perfil (1 MB). Objetos, nao strings cruas: a variavel
    // do Infinity le COLUNA de tabela. Mais novo primeiro -> o padrao do seletor e o dia recente.
    out.perfil_dias = dias.slice().reverse().map(d => ({ dia: d }));
  }

  // ---------- irradiância estimada por satélite, SÓ onde o ONS ainda não publicou ----------
  // O PROBLEMA: a irradiância do gráfico diário vem do ONS, que publica em D+1/D+2. Os dois últimos
  // dias ficam sem a linha âmbar justamente quando alguém pergunta "a geração caiu por causa do
  // sol ou por causa nossa?".
  //
  // O QUE FOI MEDIDO ANTES DE ESCREVER ISTO (61 dias de sobreposição, 25/05 a 24/07):
  //   irr_ONS ~ 1,5154 x irr_OpenMeteo - 132,8   ->  R² 0,73 · erro médio 14% · pior dia 71%
  //   pelo índice de claridade (Kt = recebida / topo da atmosfera)  ->  R² 0,75 · erro médio 14%
  //   ORDENAÇÃO dos dias: Spearman 0,887 · mesma faixa sol/médio/nuvem em 82% dos dias
  // CONCLUSÃO: o satélite acerta QUAL dia foi de sol, não QUANTO. O ONS mede o plano do módulo com
  // piranômetro; a Open-Meteo modela o plano horizontal. Não são a mesma grandeza e nenhum fator
  // fixo as reconcilia — a razão crua varia de 0,74 a 1,48 nos mesmos 61 dias.
  //
  // POR ISSO: campo SEPARADO (`irr_sat`), preenchido SÓ nos dias sem `irr` do ONS, e o painel o
  // desenha como ESTIMATIVA (ponto vazado, sem linha). Quando o ONS publica, `irr` aparece e o
  // `irr_sat` daquele dia deixa de ser emitido — a troca é automática, sem nada a mexer.
  // O erro do ajuste vai junto (`irr_sat_erro_pct`), para o painel poder declará-lo.
  // O ajuste é REFEITO a cada execução sobre os dias sobrepostos, então acompanha a estação.
  try {
    const OM = 'https://api.open-meteo.com/v1/forecast?latitude=-7.38&longitude=-38.77'
      + '&hourly=shortwave_radiation,terrestrial_radiation&past_days=92&forecast_days=1'
      + '&timezone=America/Fortaleza';
    const om = await getJSON(OM);
    const ts = om.hourly.time, sw = om.hourly.shortwave_radiation, tr = om.hourly.terrestrial_radiation;
    const pd = {};                                   // dia -> soma de recebida e do topo, com sol
    ts.forEach((t, i) => { if (sw[i] == null || sw[i] <= 5 || !tr[i]) return;
      const d = t.slice(0, 10); (pd[d] = pd[d] || { sw: 0, tr: 0, n: 0 });
      pd[d].sw += sw[i]; pd[d].tr += tr[i]; pd[d].n++; });

    // calibra Kt do satélite -> irr/topo do ONS nos dias em que os dois existem
    const cx = out.serie_dia_ufv.filter(x => x.ufv === 'Complexo');
    const par = [];
    cx.forEach(x => { const o = pd[x.dia];
      if (o && x.irr != null && x.irr > 0) par.push({ kt: o.sw / o.tr, y: x.irr / (o.tr / o.n) }); });
    if (par.length >= 20) {
      const n = par.length;
      const sx = par.reduce((a, p) => a + p.kt, 0), sy = par.reduce((a, p) => a + p.y, 0);
      const sxy = par.reduce((a, p) => a + p.kt * p.y, 0), sxx = par.reduce((a, p) => a + p.kt * p.kt, 0);
      const b = (n * sxy - sx * sy) / (n * sxx - sx * sx), a = (sy - b * sx) / n;
      const err = par.reduce((s, p) => s + Math.abs((a + b * p.kt) / p.y - 1), 0) / n * 100;
      const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      let posto = 0;
      cx.forEach(x => {
        if (x.irr != null || x.dia > hoje) return;    // já tem o ONS, ou é dia futuro
        const o = pd[x.dia]; if (!o) return;
        const est = (a + b * (o.sw / o.tr)) * (o.tr / o.n);
        if (!(est > 0)) return;
        x.irr_sat = r2(est); posto++;
      });
      out.irr_sat_erro_pct = r2(err);
      out.irr_sat_ajuste = { n_dias: n, a: r2(a), b: r2(b), dias_estimados: posto };
      console.log('  irr_sat: ' + posto + ' dia(s) estimado(s) por satélite · ajuste sobre ' + n
        + ' dias sobrepostos · erro médio ' + r2(err) + '%');
    } else {
      console.log('  irr_sat: só ' + par.length + ' dias sobrepostos (<20), estimativa NÃO publicada');
    }
  } catch (e) { console.log('  irr_sat: Open-Meteo indisponível (' + e.message + ') — segue sem estimativa'); }

  // limite direito do eixo do grafico diario, POR MES. A barra e centrada no dia: com o eixo
  // terminando no ultimo dia, metade dela fica de fora. Meia casa a mais resolve — mas tem que
  // vir como `max` do eixo, nao como ponto no dado (ponto fracionario encolhe as barras).
  // QUEM CONSOME (conferido em 26/07/2026, porque este comentario dizia "variavel $maxdia" e me
  // levou a caçar uma variavel que nunca existiu): o painel [977] tem um SEGUNDO target
  //   root_selector: meses_eixo[mes='$mes']   coluna: max_dia
  // e a transformacao `configFromData` aplica esse valor como `max` do campo "Dia":
  //   { applyTo: byName "Dia", configRefId: 'B', mappings: [{ fieldName:'max_dia', handlerKey:'max' }] }
  // NAO e variavel do Grafana — variavel nao interpola em campo numerico de fieldConfig. Se um dia
  // este bloco sair, o eixo volta a terminar no ultimo dia e a ultima barra perde metade.
  {
    out.meses_eixo = meses.map(m => ({ mes: m,
      max_dia: new Date(+m.slice(0, 4), +m.slice(5, 7), 0).getDate() + 0.5 }));
  }

  // ---------- HORA A HORA POR USINA ----------
  // O filtro do Sumario desce ano -> mes -> dia; faltava a ultima descida, dia -> 24 horas.
  // O dado existe em way2_1h.json (potencia media horaria, ~90 dias), mas em 19,5 MB e organizado
  // por MEDIDOR (25 pontos x 8 grandezas). Ler isso a cada carga de painel e inviavel, entao saio
  // daqui com um blob compacto ja somado por usina.
  //
  // Energia da hora = potencia media da hora x 1 h. Demat vem em kW, entao /1000 da MW, que na
  // janela de uma hora e o proprio MWh.
  //
  // Somo os CIRCUITOS de cada usina — a mesma tabela que o perfil de 30 min ja usa. O Complexo vem
  // do medidor PROPRIO (6233), nao da soma dos 22 circuitos: uma medicao so nao acumula o erro de
  // 22 medidores. PPA e ML somam os circuitos dos membros.
  //
  // ATENCAO: e energia BRUTA no circuito — nao desconta perda de transformacao. Em 15/07 o M3 da
  // 181,0 MWh aqui contra 179,4 MWh da liquidada do Way2 (0,9%). Quem consumir tem de dizer isso.
  try {
    const H = await getJSON(BASE + 'way2_1h.json');
    const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205],
      M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214],
      M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
    const dem = {};                                  // pontoId -> { 'AAAA-MM-DDTHH' -> kW }
    (H.dados || []).forEach(s => {
      if (s.nomeGrandeza !== 'Demat') return;
      const m = dem[s.pontoId] = dem[s.pontoId] || {};
      (s.valores || []).forEach(v => { if (v.valor != null) m[String(v.data).slice(0, 13)] = v.valor; });
    });
    const chaves = new Set();
    Object.values(dem).forEach(m => Object.keys(m).forEach(k => chaves.add(k)));
    // null se NENHUM circuito reportou: assim a hora sem dado nao vira zero (que o grafico
    // desenharia como usina parada).
    const soma = (pts, k) => { let t = null;
      pts.forEach(p => { const v = (dem[p] || {})[k]; if (v != null) t = (t || 0) + v; });
      return t; };
    const horas = [];
    [...chaves].sort().forEach(k => {
      const dia = k.slice(0, 10), h = +k.slice(11, 13);
      const poe = (u, kw) => { if (kw == null) return; horas.push({ dia, h, ufv: u, mwh: r2(kw / 1000) }); };
      Object.entries(CIRC).forEach(([u, ps]) => poe(u, soma(ps, k)));
      poe('PPA', soma(PPA.flatMap(u => CIRC[u]), k));
      poe('ML', soma(ML.flatMap(u => CIRC[u]), k));
      poe('Complexo', soma([6233], k));
    });
    const diasH = [...new Set(horas.map(x => x.dia))].sort();
    const tamH = await writeOut({
      gerado_em: new Date().toISOString(),
      fonte: 'Way2 · Demat (potência ativa) média horária por circuito, integrada em 1 h. Energia BRUTA no circuito: não desconta perda de transformação — fica ~0,9% acima da líquida.',
      inicio: diasH[0] || null, fim: diasH[diasH.length - 1] || null, dias: diasH, horas,
    }, 'hora_ufv.json');
    console.log('hora_ufv.json OK · ' + diasH.length + ' dias (' + diasH[0] + ' a ' + diasH[diasH.length - 1] + ') · '
      + horas.length + ' linhas · ' + Math.round(tamH / 1024) + ' KB');
  } catch (e) { console.warn('hora_ufv.json falhou (' + e.message + ') — segue sem a camada horária'); }

  const size = await writeOut(out);
  console.log('executivo.json OK · mês ' + mesAtual + ' (' + cur.dias + '/' + diasTotal + ' dias)');
  console.log('  entregue ' + entregue + ' GWh | potencial ' + potencial + ' | cortado ' + cortado + ' (' + cur.frustrada_pct + '%)');
  console.log('  PR ' + cur.pr_pct + '% | disp ' + cur.disp_pct + '% | projeção fechamento ' + mes.projecao.realizado_gwh + ' GWh');
  console.log('  corte PPA ' + mes.ppa.corte_pct + '% × ML ' + mes.ml.corte_pct + '%  <- a estratégia');
  console.log('  ' + Math.round(size / 1024) + ' KB · ' + serie.length + ' meses');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
