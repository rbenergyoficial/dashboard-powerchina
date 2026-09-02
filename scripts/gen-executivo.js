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
const rot = require('./lib-rotulos.js');
const https = require('https');
const zlib = require('zlib');
// rateio MUST reaproveitado do arquivador — ver nota em gen-way2-hist.js
const { rollupDia, valores: valoresW2 } = require('./gen-way2-hist.js');
// META MENSAL = INPUT DO USUÁRIO (planilha PPA do SharePoint, linha "Valor Garantido de <mês>").
// Não existe em fonte pública. Fica em JSON VERSIONADO no repo até o pipeline SharePoint→blob existir.
// ⚠️ É ENERGIA LÍQUIDA → tem que ser comparada com a líquida do Way2, nunca com a bruta do ONS.
const METAS = (() => { try { return require('../data/metas.json'); } catch (e) { return { meses: {} }; } })();
// fases operacionais oficiais (teste/performance/COD por UFV) — extraídas dos despachos ANEEL e
// dos SGIs. Usadas para separar pré-COD de pós-COD sem heurística.
const FASES = (() => { try { return require('../data/fases_operacao.json').ufvs; } catch (e) { return {}; } })();

// ---- META RECONSTRUÍDA para os meses ANTERIORES à cobertura da planilha (set–dez/2025) ----
// A planilha entrega jan/26 em diante, e só. Não é lacuna de pipeline: o COD é POR USINA (04/09 a
// 22/11/2025), e durante a entrada em operação não havia garantia contratual consolidada.
// Mas a meta é uma TAXA DIÁRIA EXATA — garantido_total/dias dá 1632,000 MWh/dia nos oito meses
// publicados, sem variação na terceira casa; por usina as taxas somam exatamente esse 1632,000.
// Então 2025 é reconstruível sem arbítrio: taxa da usina × dias em que ELA já tinha COD.
// ⚠️ Aplicar a taxa cheia ao mês inteiro criaria déficit falso: em set/25 nenhuma usina tinha COD
// antes do dia 4, e o M9 só entrou em 22/11. O rateio por COD é o que torna o número comparável.
// Marcado com `_reconstruida:1` — quem consome sabe que não veio da planilha.
(() => {
  const ks = Object.keys(METAS.meses).sort();
  if (!ks.length || !Object.keys(FASES).length) return;
  const r3 = (x) => Math.round(x * 1000) / 1000;
  const base = METAS.meses[ks[0]];
  const [y0, m0] = ks[0].split('-').map(Number);
  const dias0 = new Date(Date.UTC(y0, m0, 0)).getUTCDate();
  const TX = {}, ppaU = Object.keys(base.ppa_por_ufv || {});
  for (const [u, v] of Object.entries({ ...(base.ppa_por_ufv || {}), ...(base.ml_por_ufv || {}) })) TX[u] = v / dias0;
  const cod = {};
  for (const u of Object.keys(TX)) {
    const c = FASES[u] && FASES[u].operacao_comercial && FASES[u].operacao_comercial.cod;
    if (c) cod[u] = c;
  }
  // sem COD de TODAS as usinas o rateio seria chute — não reconstrói nada.
  if (Object.keys(cod).length !== Object.keys(TX).length) {
    console.log('  meta 2025: NÃO reconstruída (falta COD de alguma usina)');
    return;
  }
  let m = Object.values(cod).sort()[0].slice(0, 7), n = 0;
  while (m < ks[0]) {
    if (!METAS.meses[m]) {
      const [yy, mm] = m.split('-').map(Number);
      const dias = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
      const ini = m + '-01', fim = m + '-' + String(dias).padStart(2, '0');
      let tot = 0, ppa = 0; const pU = {}, mU = {};
      for (const [u, tx] of Object.entries(TX)) {
        if (cod[u] > fim) continue;
        const d0 = cod[u] > ini ? cod[u] : ini;
        const nd = Math.round((Date.parse(fim) - Date.parse(d0)) / 864e5) + 1;
        const v = tx * nd; tot += v;
        if (ppaU.includes(u)) { ppa += v; pU[u] = r3(v); } else mU[u] = r3(v);
      }
      if (tot > 0) {
        METAS.meses[m] = { garantido_total: r3(tot), garantido_ppa: r3(ppa),
          ppa_por_ufv: pU, ml_por_ufv: mU, _reconstruida: 1,
          _nota: 'taxa diária por usina × dias com COD — a planilha não cobre este mês' };
        n++;
      }
    }
    let [yy, mm] = m.split('-').map(Number); mm++; if (mm > 12) { mm = 1; yy++; }
    m = yy + '-' + String(mm).padStart(2, '0');
  }
  if (n) console.log('  meta reconstruída .. ' + n + ' meses de 2025 (taxa × dias com COD)');
})();
// Curtailment do PRÉ-COD por razão (ENE/CNF/REL/ND) na janela do art. 3º da Portaria MME 140/2026.
// CONGELADO da Rev06 da planilha de apuração, não recalculado a cada run: a planilha NÃO guarda
// nenhum valor calculado (toda célula derivada é fórmula sem cache — só o Excel produz o número ao
// abrir), então ler a fonte exigiria carregar aqui a reimplementação inteira de um método que é do
// usuário, não nosso. Congelado é rastreável e estável; ao sair a Rev07, refazer com os scripts de
// scratchpad/precod/ e trocar `_revisao`.
const PRECOD = (() => { try { return require('../data/pre_cod_razoes.json'); } catch (e) { return null; } })();
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'executivo.json';
const CAP_MW = 343.77;      // outorga do complexo
const H = 0.5;              // intervalo ONS = 30 min
const RECONSTRUIR = process.env.RECONSTRUIR === '1';   // reconstrução do ge: DESLIGADA por padrão (ver bloco 2c)
// DIAS EM QUE O ONS PUBLICOU IMPOSSIVEL: em 03/03 e 11/03 ele reporta 70% e 77% MAIS geracao do que o
// medidor de faturamento Way2 registrou. Isso infla o gerado e AFUNDA o percentual de corte.
// ESCOPO ESTREITO, de proposito: os dois dias saem do CORTE (nos dois niveis) e do denominador do
// percentual de corte — e so. `realizado_gwh`, `referencia_gwh`, `disp_pct` e a contagem de dias
// seguem cobrindo o mes inteiro, senao marco ficaria com 29 dias do lado ONS e 31 do lado Way2.
const DIAS_EXCLUIDOS = new Set(['2026-03-03', '2026-03-11']);
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
  // TAXA ÚNICA DENTRO DO ML — decisão do usuário em 16/08/2026, substitui a de 02/08.
  // O contrato fixa duas metas: a do complexo e a do PPA. A do ML é o RESTO, por aritmética
  // (`garantido_total − garantido_ppa`), e é repartida entre M1/M7/M9 proporcional à POTÊNCIA — o que
  // dá a mesma taxa por MW aos três.
  // O que isso corrige: a política anterior punha os três na taxa do PPA (137,7 MWh/MW), o que só
  // absorvia 10,15 dos 13,39 GWh. Os 3,24 restantes viravam `nao_alocado`, e o efeito colateral era o
  // ML aparecer com 90,3% de atingimento quando o contrato implica 68,5% — a sobra saía do
  // DENOMINADOR e fazia o grupo parecer melhor do que é.
  // O que NÃO se volta a fazer: a repartição da planilha (M1 na taxa do PPA e todo o resto em M7+M9)
  // punha os dois menores parques em 270,0 MWh/MW contra 137,7 dos outros — quase o dobro, e o
  // atingimento deles caía para 40% e 44% por RÉGUA, não por desempenho. Rejeitada em 02/08.
  // A régua do ML ser ~32% mais dura que a do PPA é fato estrutural do contrato; agora ele aparece
  // no GRUPO, dividido por igual, em vez de concentrado em dois parques ou escondido numa sobra.
  // `ml_por_ufv` continua no metas.json como REGISTRO DA FONTE (o que a planilha diz).
  if (mtm.ml_por_ufv || (n(mtm.garantido_total) > 0 && n(mtm.garantido_ppa) > 0)) {
    const metaMl = n(mtm.garantido_total) - n(mtm.garantido_ppa);   // o resto contratual
    const capMl = ML.reduce((a, u) => a + CAP_UFV[u], 0);           // 73,665 MW
    ML.forEach(u => { out[u] = capMl > 0 ? metaMl * CAP_UFV[u] / capMl : 0; });
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
// PR LIVRE: gv/ge contando SO as meias horas sem limitacao registrada. Responde "quanto a usina
// entrega da referencia QUANDO A DEIXAM ENTREGAR", que e o que o PR publicado nao responde — ele
// divide por um potencial que inclui o que o ONS mandou nao gerar.
//
// ⚠️ O QUE ELE NAO E: nao e o Performance Ratio da IEC (energia / (irradiancia x capacidade CC)).
// E ADERENCIA A REFERENCIA DO ONS — a mesma razao que o `pr_pct` da casa e o `calcPR` do dashboard
// HTML sempre usaram (gv/gref). Por isso ele passeia perto de 100%: o `ge` do ONS nao e o potencial
// de projeto, e um modelo que corre proximo do que a usina entrega. O PR de engenharia existe e e
// outro numero — a planilha da usina publica `实际PR` em 64% a 74%, contra alvo proprio de 82,8%.
// Confundir os dois faz um parque normal parecer excelente.
//
// GUARDA, e ela e necessaria: a serie POR USINA do ONS nao e integra (o conjunto e). Acima de 110%
// significa gv > ge, ou seja, a geracao ESTIMADA saiu abaixo da verificada — medido em ago/26 no M3
// (124%) e em jul/26 no M7 (127%). Isso e defeito do denominador, nao recorde da usina, e sai NULO.
// Amostra minima de 20 pares livres: mes muito restrito nao tem intervalo livre bastante para medir.
const PR_LIVRE_MIN = 50, PR_LIVRE_MAX = 110, PR_LIVRE_PARES = 20;
const prLivre = (gv, ge, pares) => {
  if (!(ge > 0) || !(pares >= PR_LIVRE_PARES)) return null;
  const v = Math.round(100 * gv / ge * 100) / 100;
  return (v >= PR_LIVRE_MIN && v <= PR_LIVRE_MAX) ? v : null;
};
const r2 = x => Math.round(x * 100) / 100;
// padrao numerico da casa: ponto decimal, ponto de milhar, 2 casas nas medidas
const fmt = (n, dec) => { if (n == null) return '—'; const t = Number(n).toFixed(dec == null ? 2 : dec);
  // SEPARADOR DE MILHAR: espaco estreito (U+202F), nao ponto. Com ponto nos dois papeis a mesma
  // faixa do topo exibia "343.77 MW" (ponto decimal) ao lado de "5.063 eventos" (ponto de milhar).
  // O leitor brasileiro aplica a convencao pt-BR ao segundo e le o primeiro como 343 mil. O espaco
  // estreito nao quebra linha e devolve ao ponto um significado unico em toda a pagina — inclusive
  // frente aos graficos nativos do Grafana, que usam ponto decimal e nao acompanham o Regional
  // format (bug aberto grafana/grafana#116351).
  const [i, f2] = t.split('.'); return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f2 ? '.' + f2 : ''); };
const num = v => { const x = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isNaN(x) ? 0 : x; };

// 🔴 ACUMULA EM BUFFER, NAO EM STRING. Alguns blobs nossos sao gravados em GZIP (o Azure serve
// exatamente os bytes gravados), e concatenar bytes comprimidos numa string produz lixo que o
// JSON.parse recusa. Foi assim que o detalhe do ONS parou de ser lido, calado, por vinte horas.
// A deteccao e pelos bytes magicos, nao pelo cabecalho: quem grava pode esquecer de declarar.
function getJSON(url) {
  return new Promise((res, rej) => {
    https.get(url, x => {
      if (x.statusCode !== 200) { x.resume(); return rej(new Error(x.statusCode + ' ' + url)); }
      const partes = [];
      x.on('data', c => partes.push(c));
      x.on('end', () => {
        try {
          let b = Buffer.concat(partes);
          if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
          // replace do BOM: os blobs que NOS escrevemos saem de JSON.stringify e nao tem, mas os
          // que vem crus da API da Way2 (hist/way2_DIA.json) comecam com ﻿ e quebram o JSON.parse.
          res(JSON.parse(b.toString('utf8').replace(/^﻿/, '')));
        } catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
}
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
  // 🔴 E NAO E SO HOJE: entre a meia-noite e o arquivador, o dia que ACABOU de terminar nao
  // esta em lugar nenhum — saiu de "hoje" e ainda nao entrou no way2_daily. Medido em
  // 31/08/2026 as 00:42: o arquivador nao rodava desde 30/08 06:22 BRT, o way2_daily parava
  // em 29/08, e a rodada seguinte do executivo APAGARIA o dia 30 (o mes do Complexo caia de
  // 60,77 para 59,31 GWh). O snapshot de 5 min de cada dia continua publicado, entao a lacuna
  // se fecha lendo os ultimos dias que faltarem, nao so o corrente.
  const DIAS_SNAP = 4;
  for (let k = 0; k < DIAS_SNAP; k++) try {
    const hojeBRT = new Date(Date.now() - 3 * 3600 * 1000 - k * 86400000).toISOString().slice(0, 10);
    if (!daily.dias.some(d => d.dia === hojeBRT)) {
      const snap = await getJSON(BASE + 'hist/way2_' + hojeBRT + '.json');
      const linha = rollupDia(snap, hojeBRT);
      if (linha.slots > 0) {
        // dia PASSADO so entra como fechado se o snapshot esta completo (288 slots de 5 min);
        // snapshot truncado publicado como dia inteiro subdeclara a geracao em silencio.
        if (k > 0) {
          const cheio = linha.slots >= 286;
          linha.parcial = cheio ? 0 : 1;
          if (!cheio) linha.ate = null;
          daily.dias.push(linha);
          console.log('dia ' + hojeBRT + ' recuperado do snapshot (' + linha.slots + ' slots, '
            + linha.ene_liq_mwh + ' MWh' + (cheio ? ', completo' : ', PARCIAL — snapshot truncado') + ')');
          continue;
        }
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
  } catch (e) { console.log('dia -' + k + ' indisponivel (' + e.message + ')'); }
  daily.dias.sort((a, b) => a.dia < b.dia ? -1 : a.dia > b.dia ? 1 : 0);

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
  const med = (a) => { const s = a.slice().sort((p, q) => p - q); if (!s.length) return null;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; };
  try {
    const em = await getJSON(BASE + 'way2_energia_mes.json');
    const L = {};                                  // dia -> { UFV: MWh }  (liquidada)
    (em.dados || []).forEach(d => { const u = PT_ENE[d.pontoId]; if (!u) return;
      (d.valores || []).forEach(v => { if (v.valor == null) return;
        (L[String(v.data).slice(0, 10)] = L[String(v.data).slice(0, 10)] || {})[u] = v.valor / 1000; }); });

    // ---- EneatRec: a SEGUNDA ROTA que julga se a liquidada do dia esta COMPLETA ----
    // A guarda antiga era `tot > 0`, e isso e meia guarda: em 30/08/2026 a liquidada do dia
    // veio -1,92 MWh (so o consumo noturno, liquidacao ainda nao rodada) e foi recusada apenas
    // por CALHAR de ser negativa. Um dia 60% liquidado, com +900 MWh, passava e substituia
    // 2.400 por 900 em SILENCIO. O EneatRec e um contador de energia publicado em ~tempo real
    // no mesmo ponto: a razao liquidada/EneatRec e a perda, e ela e estreita e estavel.
    const R = {};                                  // dia -> { UFV: MWh }  (bruta, contador)
    try {
      const ed = await getJSON(BASE + 'way2_eneat_diario.json');
      (ed.dados || []).forEach(d => { const u = PT_ENE[d.pontoId]; if (!u) return;
        (d.valores || []).forEach(v => { if (v.valor == null) return;
          (R[String(v.data).slice(0, 10)] = R[String(v.data).slice(0, 10)] || {})[u] = v.valor / 1000; }); });
    } catch (e) { console.log('way2_eneat_diario.json indisponivel — guarda da liquidada volta a olhar so o sinal'); }
    const somaU = (o) => o ? Object.values(o).reduce((a, b) => a + num(b), 0) : 0;

    // A GRANDEZA QUE SEPARA E O RESIDUO EM MWh, nao a razao. A razao liquidada/EneatRec cai
    // com a geracao do dia (o consumo auxiliar e quase fixo), entao dia de pouco sol tem
    // razao naturalmente menor — 95,97% em 16/08, contra 99,35% no dia de mais sol. Um corte
    // por razao teria de ficar frouxo para nao recusar dia bom, e frouxo demais deixa passar
    // dia meio liquidado: com corte em 50%, um dia liquidado a 60% PASSAVA (pego pelo ensaio).
    // Ja o residual `EneatRec - liquidada` e o proprio consumo auxiliar, e ele quase nao varia:
    // medido em ago/26, 11,0 a 22,4 MWh em dias de 347 a 2.916 MWh de geracao. Liquidacao
    // parcial sai em centenas ou milhares de MWh — duas familias com um fator de 50 entre elas.
    // O teto sai dos proprios dias aceitos (3x o maior residuo ja visto), nao de numero a mao.
    const pares = daily.dias.filter(x => !x.parcial && Object.keys(L[x.dia] || {}).length >= 9
        && Object.keys(R[x.dia] || {}).length >= 9 && somaU(R[x.dia]) > 100)
      .map(x => ({ rec: somaU(R[x.dia]), res: somaU(R[x.dia]) - somaU(L[x.dia]) }));
    const bons = pares.filter(q => q.res > 0 && q.res < q.rec * 0.5).map(q => q.res);
    const TETO_RES = bons.length >= 5 ? 3 * Math.max.apply(null, bons) : null;

    let n = 0; const ig = [];
    daily.dias.forEach(x => {
      const l = L[x.dia]; if (!l) return;
      if (x.parcial) { ig.push(x.dia + ' (dia em curso)'); return; }
      const us = Object.keys(l);
      if (us.length < 9) { ig.push(x.dia + ' (nao liquidado)'); return; }
      const tot = us.reduce((a, u) => a + l[u], 0);
      const rec = somaU(R[x.dia]);
      if (TETO_RES != null && rec > 100) {
        const res = rec - tot;
        if (!(res > -1 && res <= TETO_RES)) {
          ig.push(x.dia + ' (liquidacao incompleta: faltam ' + res.toFixed(0) + ' MWh de ' + rec.toFixed(0) + ')');
          return;
        }
      } else if (tot <= 0) { ig.push(x.dia + ' (nao liquidado)'); return; }
      x.ufv_liq_mwh = Object.fromEntries(us.map(u => [u, r2(l[u])]));
      x.ene_liq_mwh = r2(tot);
      x.liq_fonte = 'EneatLiquida';
      n++;
    });
    console.log('energia liquida OFICIAL (EneatLiquida) em ' + n + ' dias'
      + (TETO_RES != null ? ' · guarda: falta acima de ' + TETO_RES.toFixed(0)
         + ' MWh contra o EneatRec e dia incompleto' : ' · sem EneatRec, guarda so no sinal')
      + (ig.length ? ' · fora: ' + ig.join(', ') : ''));

    // ---- O DIA EM CURSO NA MESMA ESCALA DOS DIAS FECHADOS ----
    // O rollup integra a potencia do medidor do complexo e fica ~0,44% ACIMA da liquidada:
    // ele desconta o consumo do proprio ponto de conexao, e nao a perda ate os medidores de
    // faturamento das usinas. Medido em ago/26, a perda total (1 - liquidada/EneatRec) tem
    // mediana de 0,83% no conjunto e varia POR USINA (0,51% no M8 a 1,85% no M9) — um fator
    // unico para as nove erraria o rateio. O fator sai da mediana dos dias ja liquidados,
    // por usina, entao ele acompanha a planta sem numero escrito a mao.
    // ⚠️ NAO ha correcao de perda a aplicar no dia em curso, e isso foi MEDIDO antes de
    // escrever qualquer ajuste: o rollup por usina bate com a liquidada oficial em 0,013%
    // (29 dias de ago/26, inclinacao 1,0000 nas nove). O ajuste afim que eu tinha montado
    // aqui foi recusado pelo proprio crivo dele (`b <= 1 && a <= 0`) em 7 das 9 usinas —
    // nao havia perda para descontar. Os 0,44% que eu media vinham de eu integrar o medidor
    // do complexo (6233) em vez dos dois transformadores da SE, que e o que o rollup usa.
    // Fica registrado para ninguem reabrir isso: a diferenca era da MINHA medicao.
  } catch (e) { console.log('way2_energia_mes.json indisponivel (' + e.message + ') — segue com o rollup'); }

  // ---------- 1) complexo por mês, a partir do ons_restricao_all ----------
  const M = {};   // mes -> acumuladores
  const DIA = {}; // dia -> { ger, fru, horas_restr }  (p/ a curva com o corte pintado)
  // OS INSTANTES COM LIMITACAO REGISTRADA, compartilhados com o calculo por usina. A bandeira `lim`
  // existe SO no arquivo do conjunto (o por-usina traz ts,u,irr,inv,ge,gv e nada de limitacao): era
  // por isso que a usina somava os 1.488 intervalos do mes contra os 471 do conjunto, e dai vinha 34%
  // do desvio auditado. Os dois arquivos tem os mesmos instantes, entao o cruzamento por ts fecha.
  const LIM_TS = new Set();
  for (const r of restr.consolidado) {
    const mes = String(r.ts).slice(0, 7); if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const m = M[mes] || (M[mes] = { ger: 0, gerX: 0, ref: 0, fru: 0, disp: 0, n: 0, n_disp: 0, raz: {}, ori: {}, dias: new Set(), int_restr: 0 });
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
    // gerX = gerado no MESMO conjunto de dias em que o corte e apurado; e o denominador honesto do
    // percentual de corte. Sem ele o percentual misturaria numerador filtrado com denominador cheio.
    const excl = DIAS_EXCLUIDOS.has(_d);
    if (!excl) m.gerX += ger * H;
    if (lim > 0 && !excl) { const perda = Math.max(0, (gref - ger) * H);   // <- definição da casa
      LIM_TS.add(String(r.ts));
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
  // BENCHMARK DO NORDESTE, calculado pelo gen-benchmark-ons.js (que roda ANTES deste no workflow —
  // se rodasse depois, aqui se leria o blob da rodada anterior e o painel atrasaria um ciclo).
  // E ele que mata os tres percentuais que viviam colados no codigo.
  let BENCH = null;
  try { BENCH = await getJSON(BASE + 'benchmark_ne.json'); }
  catch (e) { console.log('benchmark_ne.json indisponivel (' + e.message + ') — os comparativos regionais saem nulos'); }

  // 🔴 O EIXO DO TEMPO NAO PODE SAIR DE UMA FONTE DE TERCEIRO. `meses` vinha so do arquivo de
  // restricao do ONS, que publica com ~1 dia de atraso. Todo dia 1o o mes corrente nao existia em
  // raiz NENHUMA — nem no filtro de Periodo, nem na serie diaria — mesmo com a nossa medicao do
  // dia inteiro ja no arquivo. Medido em 01/09/2026 as 11h: o ONS parava em 30/08 23:30, o nosso
  // snapshot de 5 min do dia 01/09 tinha 136 slots, e o Sumario nao oferecia setembro.
  //
  // ⚠️ O mes que so a NOSSA medicao conhece entra marcado com `semONS`, e todo campo derivado do
  // ONS sai NULO — nunca zero. Zero e uma medicao; ausencia nao e. Um mes com ger=0 e ref=0
  // produziria percentuais falsos na banda do topo.
  {
    // 🔴 SO PARA FRENTE. O `way2_daily` guarda 781 dias e comeca em 2024-07 — a uniao ingenua
    // ressuscitou 15 meses PRE-COD (a usina entrou em operacao a partir de 04/09/2025) e a serie
    // do painel saltou de 12 para 27 meses. Medido no ensaio, antes de qualquer publicacao.
    // ⚠️ E buraco NO MEIO nao se preenche: um mes que o ONS deveria ter e nao tem e falha DELE, e
    // tapar em silencio esconderia exatamente o que precisa aparecer.
    const ultimoONS = Object.keys(M).sort().pop() || '';
    const doW2 = [...new Set(daily.dias.map(d => String(d.dia).slice(0, 7)))]
      .filter(m => /^[0-9]{4}-[0-9]{2}$/.test(m) && !M[m] && m > ultimoONS);
    doW2.forEach(m => { M[m] = { ger: 0, gerX: 0, ref: 0, fru: 0, disp: 0, n: 0, n_disp: 0,
      raz: {}, ori: {}, dias: new Set(), int_restr: 0, semONS: true }; });
    if (doW2.length) console.log('meses so da NOSSA medicao (o ONS ainda nao publicou): '
      + doW2.join(', ') + ' — os campos do ONS saem nulos');
  }
  const meses = Object.keys(M).sort();
  const BANDAS = [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 3000];
  const banda = i => { for (let b = BANDAS.length - 2; b >= 0; b--) if (i >= BANDAS[b]) return b; return 0; };
  const util = r => String(r.inv) !== 'True' && num(r.irr) > 5;      // ponto aproveitável (irradiância válida e com sol)

  const CRU = {};   // mes -> consolidado
  // 🔴 O `catch` MUDO daqui escondeu uma quebra de producao por vinte horas. Quando o blob passou a
  // ser gravado em gzip, o JSON.parse comecou a estourar, o erro foi engolido, CRU ficou VAZIO e o
  // gerador seguiu ate morrer bem adiante com "Invalid time value" — mensagem sem relacao nenhuma
  // com a causa. Falha de leitura de FONTE agora e contada e reportada; e se NENHUM mes vier, o
  // gerador para aqui, onde o problema esta, em vez de tropecar la na frente.
  const falhas = [];
  for (const mes of meses) {
    try { CRU[mes] = (await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado; }
    catch (e) { falhas.push(mes + ': ' + String(e.message).slice(0, 60)); }
  }
  if (falhas.length) {
    console.log('  ATENCAO · ' + falhas.length + ' de ' + meses.length + ' meses do detalhe do ONS nao foram lidos:');
    falhas.slice(0, 6).forEach(x => console.log('    ' + x));
  }
  if (!Object.keys(CRU).length) {
    throw new Error('nenhum mes do detalhe do ONS foi lido (' + meses.length + ' tentados) — '
      + 'sem essa fonte o perfil e o corte por usina saem vazios');
  }

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
    let gePL = 0, gvPL = 0, parLivre = 0;        // o mesmo par, so nos intervalos SEM limitacao
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
      (porUfv[u] = porUfv[u] || { ge: 0, gv: 0, geP: 0, gvP: 0, parN: 0, parOk: 0, geL: 0, gvL: 0, gePL: 0, gvPL: 0, parLivre: 0, irrSoma: 0, irrN: 0 });
      porUfv[u].ge += g * H; porUfv[u].gv += v * H;
      // BALDE DO CORTE: so os intervalos com limitacao registrada (e ja sem os dias excluidos, que
      // nao entraram no LIM_TS). O que cai FORA dele e deficit por outro motivo — sujeira,
      // indisponibilidade, erro de modelo — e vai para `outras_gwh`, que ate aqui ficava sempre zero.
      if (LIM_TS.has(String(r.ts))) { porUfv[u].geL += g * H; porUfv[u].gvL += v * H; }
      // PAR LIVRE: o MESMO filtro do PR publicado, menos os intervalos com limitacao registrada.
      // O PR publicado divide por um potencial que inclui o que o ONS mandou nao gerar, entao
      // usina cortada aparece como usina ruim — e a casa sacrifica o Mercado Livre no corte de
      // proposito. Medido em 20/08/2026: M1 sai de 59,5% para 92,0% e M9 de 58,1% para 86,8%,
      // com o M1 passando de PIOR do parque a terceiro melhor.
      if (util(r)) { porUfv[u].parN++; porUfv[u].irrSoma += irr; porUfv[u].irrN++; if (g > 0) { porUfv[u].geP += g * H; porUfv[u].gvP += v * H; porUfv[u].parOk++;
        if (!LIM_TS.has(String(r.ts))) { porUfv[u].gePL += g * H; porUfv[u].gvPL += v * H; porUfv[u].parLivre++; } } }
      ge += g * H; gv += v * H; geTot += g * H; if (rec) geRec += g * H;
      // PR PAREADO: soma gv e ge SÓ nos intervalos em que o ONS publicou os dois. Somar o mês inteiro
      // infla o PR quando falta ge (divide por um denominador incompleto) — foi isso que deixou out/25
      // a fev/26 sem PR. Restringindo aos pares válidos, o número volta a ser comparável, e a COBERTURA
      // (quantos intervalos entraram) vai junto p/ o leitor saber sobre quanto do mês ele está olhando.
      if (util(r)) { irrSoma += irr; irrN++; parN++; if (g > 0) { geP += g * H; gvP += v * H; parOk++;
        if (!LIM_TS.has(String(r.ts))) { gePL += g * H; gvPL += v * H; parLivre++; } } }
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
      if (A && B && mes < RTC_M3_REPARO.slice(0, 7)) { A.ge += B.ge; A.gv += B.gv; A.geL += B.geL; A.gvL += B.gvL; }
      else if (A && B && mes === RTC_M3_REPARO.slice(0, 7)) {
        // mês da virada: só os dias ANTERIORES ao reparo somam
        const antes = C.filter(r => String(r.ts).slice(0, 10) < RTC_M3_REPARO && String(r.u) === 'CEFMT7');
        A.ge += antes.reduce((a, r) => a + num(r.ge) * H, 0);
        A.gv += antes.reduce((a, r) => a + num(r.gv) * H, 0);
        const antesL = antes.filter(r => LIM_TS.has(String(r.ts)));
        A.geL += antesL.reduce((a, r) => a + num(r.ge) * H, 0);
        A.gvL += antesL.reduce((a, r) => a + num(r.gv) * H, 0);
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
        // o M7 nao tem serie propria para medir a fracao limitada dele: herda a das usinas de tag boa,
        // porque a limitacao e do conjunto e atinge todas ao mesmo tempo.
        const frL = (porUfv.M1 && porUfv.M1.ge > 0) ? porUfv.M1.geL / porUfv.M1.ge : 0;
        B.geL = B.ge * frL; B.gvL = 0;
      }
    }
    IRR[mes] = { porUfv, ge, gv, geP, gvP, gePL, gvPL, parLivre, parN,
      pr_cob: parN ? r2(100 * parOk / parN) : 0,
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
    // campo derivado do ONS num mes que o ONS ainda nao publicou sai NULO, nunca zero
    const semONS = !!m.semONS; const oN = v => (semONS ? null : v);
    // exposto na serie: o painel precisa distinguir "sem publicacao" de "valor ruim"
    const w2 = daily.dias.filter(x => String(x.dia).slice(0, 7) === mes);
    return { mes, lbl: lbl(mes), sem_ons: semONS ? 1 : 0, dias: semONS ? null : m.dias.size,
      // dias do WAY2 no mes — e o divisor honesto para ratear a meta do mes corrente, porque e
      // exatamente o conjunto de dias que alimenta `way2_liq_gwh` e `ppa_liq_gwh`. Usar outra
      // contagem (a serie diaria, por exemplo, que ia so ate o dia 10 enquanto o Way2 tinha 11)
      // defasa numerador e denominador e infla o superavit do mes em curso.
      w2_dias: w2.length,
      w2_dias_completos: w2.filter(x => !x.parcial && x.completo !== false).length,
      // mes_ts: o Grafana só desenha eixo de tempo / sparkline sobre timestamp — "2026-07" sozinho ele lê como texto
      mes_ts: mes + '-01T00:00:00Z',
      realizado_gwh: oN(r2(m.ger / 1000)), referencia_gwh: oN(r2(m.ref / 1000)), frustrada_gwh: oN(r2(m.fru / 1000)),
      // gerado na MESMA janela de dias em que o corte foi apurado (sem 03/03 e 11/03). E o denominador
      // honesto do percentual: com o gerado cheio, numerador filtrado e denominador inteiro diriam
      // coisas diferentes e o percentual sairia menor do que e.
      gerado_janela_gwh: oN(r2(m.gerX / 1000)),
      frustrada_pct: semONS ? null : ((m.gerX + m.fru) > 0 ? r2(100 * m.fru / (m.gerX + m.fru)) : 0),
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
      pr_livre_pct: prLivre(i.gvPL, i.gePL, i.parLivre),
      pr_livre_cobertura_pct: i.parN > 0 ? r2(100 * (i.parLivre || 0) / i.parN) : null,
      pr_cobertura_pct: i.pr_cob == null ? null : i.pr_cob,
      disp_pct: m.n_disp ? r2(m.disp / m.n_disp / CAP_MW * 100) : null,
      disp_cobertura_pct: m.n ? r2(100 * m.n_disp / m.n) : null,
      // ⚠️ num mes que o operador ainda nao publicou, o fallback `IRR[mes] || {irr_media: 0}`
      // viraria "irradiancia media 0 W/m2" — noite permanente. Ausencia sai nula.
      irr_media: oN(r2(i.irr_media)), ge_reconstruido_pct: oN(i.rec_pct),
      // META do mês na série (planilha, jan/26→). set/25–dez/25 ficam null: o usuário não tem PPA de 2025.
      meta_gwh: (METAS.meses[mes] || {}).garantido_total != null ? r2(METAS.meses[mes].garantido_total / 1000) : null,
      meta_ppa_gwh: (METAS.meses[mes] || {}).garantido_ppa != null ? r2(METAS.meses[mes].garantido_ppa / 1000) : null,
      corte_pct_pot: i.ge > 0 ? r2(100 * (m.fru) / (i.ge)) : null,
      way2_liq_gwh: r2(w2.reduce((a, x) => a + num(x.ene_liq_mwh), 0) / 1000),
      way2_gwh_dia: w2.length ? r2(w2.reduce((a, x) => a + num(x.ene_ger_mwh), 0) / w2.length / 1000) : null,
      pico_mw: w2.length ? Math.round(Math.max(...w2.map(x => num(x.pico_mw)))) : null,
      horas_restricao: oN(r2(m.int_restr * H)), intervalos_restricao: oN(m.int_restr),
      razoes: semONS ? null : Object.fromEntries(Object.entries(m.raz).map(([k, v]) => [k, { gwh: r2(v / 1000), pct: m.fru > 0 ? r2(100 * v / m.fru) : 0 }])),
      origens: semONS ? null : Object.fromEntries(Object.entries(m.ori).map(([k, v]) => [k, { gwh: r2(v / 1000), pct: m.fru > 0 ? r2(100 * v / m.fru) : 0 }])) };
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
      // 🔴 mes que o operador ainda NAO PUBLICOU nao e mes com dado incoerente: a nota antiga
      // acusava a fonte de um erro que ela nao cometeu, e quem le vai procurar defeito onde
      // so ha atraso de publicacao.
      s.nota = s.sem_ons ? 'O operador nacional ainda nao publicou este mes. Os indicadores que dependem da referencia dele (corte, disponibilidade e desempenho) entram quando a publicacao sair, com cerca de um dia de atraso.'
        : s.ramp_up ? 'Planta em ramp-up (comissionamento) — potencial e PR nao sao comparaveis'
        : (!s.pr_confiavel ? 'A geracao estimada do ONS e inconsistente neste mes: mesmo somando SO os intervalos em que ela foi publicada, o PR sai fisicamente impossivel (out/25 216% · nov/25 133% · dez/25 188% · jan/26 180% · fev/26 98%). Nao e apenas dado faltando — o valor publicado esta errado. So a partir de mar/26 o PR fica coerente (76%).' : null);
    }); }

  // ---------- 4) mês corrente + projeção + cascata + PPA×ML ----------
  const mesAtual = meses[meses.length - 1];
  const cur = serie.find(s => s.mes === mesAtual);
  const diasTotal = new Date(+mesAtual.slice(0, 4), +mesAtual.slice(5, 7), 0).getDate();
  // ⚠️ `cur.dias` conta os dias que o ONS publicou. Num mes que so a nossa medicao conhece ele e
  // nulo, e um `fator` de 1 faria a projecao do mes inteiro valer o que ja foi entregue. O ritmo
  // sai dos dias que a NOSSA medicao tem — que e o mesmo divisor que a manchete ja usa.
  const baseDias = cur.dias > 0 ? cur.dias : (cur.w2_dias > 0 ? cur.w2_dias : 0);
  const fator = baseDias > 0 ? diasTotal / baseDias : 1;
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

  // ⚠️ num mes que o ONS ainda nao publicou, `iCur.porUfv` e vazio e a soma dava ZERO — o painel
  // da estrategia lia 'corte PPA 0% x ML 0%', que afirma que nao houve corte. Ausencia sai nula.
  const grupo = g => { const us = g === 'ppa' ? PPA : ML;
    if (cur && cur.dias == null) return { potencial_gwh: null, realizado_gwh: null, corte_gwh: null, corte_pct: null };
    const ge = us.reduce((a, u) => a + ((iCur.porUfv[u] || {}).ge || 0), 0);
    const gv = us.reduce((a, u) => a + realizado(u), 0);
    return { potencial_gwh: r2(ge / 1000), realizado_gwh: r2(gv / 1000), corte_gwh: r2(Math.max(0, ge - gv) / 1000),
      corte_pct: ge > 0 ? r2(100 * Math.max(0, ge - gv) / ge) : null }; };

  const potencial = cur.potencial_irr_gwh, entregue = cur.realizado_gwh, cortado = cur.frustrada_gwh;
  // percentual do potencial: sem potencial nao ha percentual — nulo, nunca zero
  const pctPot = v => (potencial > 0 && v != null ? r2(100 * v / potencial) : null);
  // 🔴 `null - null` e ZERO em JS (nao NaN): sem a guarda o residuo saia 0 GWh num mes sem
  // fonte, afirmando "nao houve outras perdas" onde nao se sabe nada.
  const outras = [potencial, entregue, cortado].some(v => v == null) ? null : r2(Math.max(0, potencial - entregue - cortado));
  const mes = { mes: mesAtual, lbl: cur.lbl, dias_decorridos: cur.dias != null ? cur.dias : cur.w2_dias, dias_total: diasTotal,
    realizado_gwh: entregue, potencial_gwh: potencial, frustrada_gwh: cortado, frustrada_pct: cur.frustrada_pct,
    pr_pct: cur.pr_pct, disp_pct: cur.disp_pct, disp_cobertura_pct: cur.disp_cobertura_pct,
    irr_media: cur.irr_media, ge_reconstruido_pct: cur.ge_reconstruido_pct,
    horas_restricao: cur.horas_restricao, razoes: cur.razoes, origens: cur.origens,
    // PROJEÇÃO: ritmo médio diário × dias restantes. NÃO é previsão do ONS (não existe pública além de D+1).
    // ⚠️ `null * fator` e 0 em JS: sem guarda a projecao afirmava 0 GWh onde o dado nao existe
    projecao: { realizado_gwh: entregue == null ? null : r2(entregue * fator),
      frustrada_gwh: cortado == null ? null : r2(cortado * fator),
      metodo: 'ritmo médio diário do mês corrente × dias restantes (projeção estatística simples)',
      base_dias: baseDias, dias_total: diasTotal },
    cascata: [
      { etapa: 'Entregue', gwh: entregue, pct: pctPot(entregue) },
      { etapa: 'Cortado pelo ONS', gwh: cortado, pct: pctPot(cortado) },
      { etapa: 'Outras perdas', gwh: outras, pct: pctPot(outras) },
    ],
    // planos p/ o Grafana: o Infinity não resolve seletor com índice (cascata[0].pct) nem inventa
    // rótulo onde o objeto só tem número — o dado tem que nascer pronto aqui.
    pct_entregue: pctPot(entregue),
    pct_cortado: pctPot(cortado),
    pct_outras: pctPot(outras),
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
        // geL/gvL = a mesma dupla, restrita aos intervalos com limitacao. O corte sai DALI; o que
        // sobra do deficit total vai para `outras_gwh`. Sem os dois baldes, `cortado` era o deficit
        // inteiro contra o potencial e engolia sujeira, indisponibilidade e erro de modelo.
        const linha = (ufv, ge, gv, geP, gvP, parN, parOk, liq, meta, geL, gvL) => {
          const corte = Math.max(0, (geL == null ? ge : geL) - (gvL == null ? gv : gvL));
          const pr = geP > 0 ? r2(100 * gvP / geP) : null;
          const cob = parN ? r2(100 * parOk / parN) : 0;
          const prOk = !S.ramp_up && cob >= 70 && pr != null && pr >= 50 && pr <= 95;
          // 🔴 mes sem publicacao do operador: TUDO que vem dele sai NULO, nunca zero. Sem
          //    isto o painel de energia perdida afirma que nao houve corte, quando o que nao
          //    houve foi medicao — e `IRR[m]` ausente cai no default {ge:0,gv:0}, que produz
          //    corte = max(0, 0-0) = 0 com cara de apuracao.
          // ⚠️ `liquida_gwh`, a meta e o atingido FICAM: eles saem do nosso medidor e da
          //    planilha do PPA, nao dependem do operador, e sao o que a pagina mostra no mes.
          const oN = (v) => (S.sem_ons ? null : v);
          return { ufv, mes: m, mes_ts: S.mes_ts, lbl: S.lbl,
            liquida_gwh: r2(liq / 1000), meta_gwh: meta == null ? null : r2(meta / 1000),
            atingido_pct: meta > 0 ? r2(100 * liq / meta) : null,
            potencial_gwh: oN(r2(ge / 1000)), entregue_gwh: oN(r2(gv / 1000)),
            cortado_gwh: oN(r2(corte / 1000)),
            corte_pct: oN(ge > 0 ? r2(100 * corte / ge) : null),
            outras_gwh: oN(r2(Math.max(0, (ge - gv) - corte) / 1000)),
            pr_pct: oN(prOk ? pr : null), pr_cobertura_pct: oN(cob),
            disp_pct: S.disp_pct, horas_restricao: S.horas_restricao, escopo_complexo: 1,
            nota: prOk ? null : S.nota };
        };
        // ---- as 9 usinas ----
        const linhasUfv = [];
        Object.keys(CAP_UFV).sort().forEach(u => { const x = I.porUfv[u] || { ge: 0, gv: 0, geP: 0, gvP: 0, parN: 0, parOk: 0 };
          const liq = w2.reduce((a, d) => a + num((d.ufv_liq_mwh || {})[u]), 0);
          const meta = MPU ? MPU[u] : null;          // <- mesma fonte unica do bloco acima
          // M7: o "gv" do ONS é o circuito 2 do M3 (tag trocada), e nós o zeramos — usar ele daria
          // 100% de corte. O realizado do M7 vem do Way2. O PR fica NULL: comparar líquida do Way2
          // com potencial ESTIMADO não é Performance Ratio, é mistura de bases.
          // GATE DE DATA — a tag do M7 no ONS foi corrigida em TAG_M7_OK (17/07/2026). A partir do
          // primeiro mes inteiramente posterior o dado cru vale, e manter a substituicao pelo Way2
          // vira ruido: era ela que deixava um potencial "orfao" no grupo ML, presente no grupo e
          // ausente das tres usinas. Em ago/26 valia 0,16 GWh.
          const m7Cru = m > TAG_M7_OK.slice(0, 7);
          const viaW2 = VIA_WAY2.includes(u) && liq > 0 && !m7Cru;
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
          // quando o potencial vem das irmas (usaIrma), o balde limitado tem de acompanhar a
          // substituicao — senao o corte misturaria bases: potencial estimado contra janela medida.
          const frL = x.ge > 0 ? x.geL / x.ge : 0;
          const frLv = x.gv > 0 ? x.gvL / x.gv : frL;
          const geLu = usaIrma ? gePot * frL : x.geL;
          const gvLu = usaIrma ? real * frLv : x.gvL;
          const l = linha(u, gePot, real, x.geP, x.gvP, x.parN, x.parOk, liq, meta, geLu, gvLu);
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
          linhasUfv.push(l); });

        // ---- RECONCILIACAO: soma das usinas = corte do complexo -----------------------------
        // REGRA DE NEGOCIO: PPA + ML tem de dar exatamente o corte do conjunto.
        // Ate aqui nunca dava, porque sao duas contas diferentes sobre fontes diferentes:
        //   complexo -> max(0, gref-ger) do ons_restricao_all, SO nos intervalos com lim>0
        //   usina    -> max(0, ge-gv)    do ons_irradiancia,   em TODOS os intervalos
        // O numero do complexo e o TOTAL DE CONTROLE: e o unico com contraparte externa no ONS,
        // no nivel da subestacao. As usinas sao ajustadas na proporcao do proprio corte para
        // somar esse total. O valor antes do ajuste fica em cortado_bruto_gwh, para auditoria.
        //
        // Se alguma usina esta sem corte publicado (PPA antes de mar/26, quando o ge do ONS nao
        // presta), a soma seria incompleta e o ajuste NAO e aplicado: e melhor a linha nao fechar
        // e dizer por que do que fechar distribuindo a diferenca sobre um subconjunto.
        const comCorte = linhasUfv.filter(l => l.cortado_gwh != null);
        const somaUfv = comCorte.reduce((a, l) => a + l.cortado_gwh, 0);
        const alvoCorte = S.frustrada_gwh;
        const recOk = comCorte.length === linhasUfv.length && somaUfv > 0 && alvoCorte > 0;
        const fatorRec = recOk ? alvoCorte / somaUfv : 1;
        if (recOk) {
          comCorte.forEach(l => {
            l.cortado_bruto_gwh = l.cortado_gwh;
            l.cortado_gwh = r2(l.cortado_gwh * fatorRec);
            l.corte_pct = l.potencial_gwh > 0 ? r2(100 * l.cortado_gwh / l.potencial_gwh) : null;
            l.outras_gwh = r2(Math.max(0, l.potencial_gwh - l.entregue_gwh - l.cortado_gwh)); });
          // sobra de arredondamento vai para a usina de maior corte, p/ fechar ao centavo
          const dif = r2(alvoCorte - comCorte.reduce((a, l) => a + l.cortado_gwh, 0));
          if (dif !== 0) { const maior = comCorte.slice().sort((a, b) => b.cortado_gwh - a.cortado_gwh)[0];
            maior.cortado_gwh = r2(maior.cortado_gwh + dif); }
        }
        linhasUfv.forEach(l => { l.corte_reconciliado = recOk ? 1 : 0;
          l.corte_reconc_fator = recOk ? Math.round(fatorRec * 1e6) / 1e6 : null;
          l.corte_reconc_nota = recOk
            ? 'Corte ajustado na proporcao do proprio valor para somar o total do conjunto, que e o numero aferido do ONS no nivel da subestacao. Valor bruto em cortado_bruto_gwh.'
            : 'Reconciliacao nao aplicada neste mes: ha usina sem corte publicado, a soma seria incompleta.'; });
        // GUARDA DE FECHAMENTO: e ela que impede a regressao. Sem isso estamos a um refactor de
        // repetir o bug — duas contas paralelas que voltam a divergir sem ninguem perceber.
        if (recOk) {
          const conf = comCorte.reduce((a, l) => a + l.cortado_gwh, 0);
          if (Math.abs(conf - alvoCorte) > 0.011) {
            throw new Error('FECHAMENTO QUEBROU em ' + m + ': soma das usinas ' + r2(conf)
              + ' GWh contra corte do conjunto ' + r2(alvoCorte) + ' GWh (tolerancia 0,01)');
          }
        }
        linhasUfv.forEach(l => out.push(l));
        // ---- complexo ----
        { const ge = Object.values(I.porUfv).reduce((a, x) => a + x.ge, 0);
          const gv = Object.values(I.porUfv).reduce((a, x) => a + x.gv, 0);
          const geP = Object.values(I.porUfv).reduce((a, x) => a + (x.geP || 0), 0);
          const gvP = Object.values(I.porUfv).reduce((a, x) => a + (x.gvP || 0), 0);
          const pN = Object.values(I.porUfv).reduce((a, x) => a + (x.parN || 0), 0);
          const pK = Object.values(I.porUfv).reduce((a, x) => a + (x.parOk || 0), 0);
          const liq = w2.reduce((a, d) => a + num(d.ene_liq_mwh), 0);
          const geL = Object.values(I.porUfv).reduce((a, x) => a + (x.geL || 0), 0);
          const gvL = Object.values(I.porUfv).reduce((a, x) => a + (x.gvL || 0), 0);
          const l = linha('Complexo', ge, gv, geP, gvP, pN, pK, liq, mtm ? mtm.garantido_total : null, geL, gvL);
          // no complexo o corte vem da fórmula da casa (nível da subestação), não da soma dos ge−gv
          l.cortado_gwh = S.frustrada_gwh;
          l.corte_pct = (m < '2026-03') ? S.frustrada_pct : S.corte_pct_pot;
          // 🔴 E POR ISSO `outras_gwh` TEM DE SER REFEITO. A `linha()` calculou o resto com o corte
          // CRU (geL−gvL); trocando o corte pela formula da casa sem refazer o resto, os tres termos
          // param de fechar com o potencial. Medido em 21/08/2026: sobrava 3,4% do potencial no
          // Complexo (2,2 GWh/mes) enquanto nas nove usinas e nos grupos fechava em zero — e a
          // `outras_gwh` publicada saia pela METADE do que realmente sobra (1,73 contra 5,12 GWh em
          // mar/26). O grupo ja fazia esta conta; a linha do Complexo tinha ficado para tras.
          l.outras_gwh = l.cortado_gwh == null ? null
            : r2(Math.max(0, l.potencial_gwh - l.entregue_gwh - l.cortado_gwh));
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
          const lg = linha(g, som('ge'), gvG, som('geP'), som('gvP'), som('parN'), som('parOk'), liqG, metaG, som('geL'), som('gvL'));
          lg.grupo = 1;
          // O corte do grupo e a SOMA das suas usinas ja reconciliadas — nao um ge-gv recalculado
          // sobre o agregado. Era o recalculo que fazia PPA + ML nao fechar com o Complexo, e que
          // punha no grupo ML um potencial que nao existia em M1, M7 nem M9.
          const membros = linhasUfv.filter(l => us.includes(l.ufv));
          const semCorte = membros.some(l => l.cortado_gwh == null);
          lg.cortado_gwh = semCorte ? null : r2(membros.reduce((a, l) => a + l.cortado_gwh, 0));
          lg.corte_pct = (lg.cortado_gwh != null && lg.potencial_gwh > 0)
            ? r2(100 * lg.cortado_gwh / lg.potencial_gwh) : null;
          lg.outras_gwh = lg.cortado_gwh == null ? null
            : r2(Math.max(0, lg.potencial_gwh - lg.entregue_gwh - lg.cortado_gwh));
          lg.corte_reconciliado = recOk ? 1 : 0;
          lg.corte_reconc_nota = semCorte
            ? 'Corte do grupo indisponivel: alguma usina do grupo nao tem corte publicado neste mes.'
            : 'Soma das usinas do grupo, reconciliada com o total do conjunto.';
          out.push(lg); });
      });

      // ---- REPARTICAO ESTIMADA PPA x ML ANTES DE MAR/26 --------------------------------
      // O QUE E MEDIDO E O QUE E ESTIMADO, para nao restar duvida:
      //   MEDIDO   · o corte do CONJUNTO, em todos os meses. Vem do registro do ONS na
      //              subestacao (230 kV), que NAO passa pelo rele do CUB10_1 (34,5 kV) e por
      //              isso nunca herdou o defeito de RTC. Conferido contra o Way2 de out/25 a
      //              jul/26: razao entre 98,8% e 105,3%, sem nenhum deficit de ~20%.
      //   ESTIMADO · a divisao desse total entre PPA e ML, nos meses em que o ONS nao publica
      //              corte por usina utilizavel (o `ge` do ONS e inconsistente antes de mar/26).
      //
      // METODO. A razao e a media observada nos meses de dado bom, nao um palpite. O ML absorve
      // de 33% a 38% do corte tendo 21,4% da capacidade — cerca de 1,7x o que lhe caberia por
      // potencia. Isso e a politica de despacho aparecendo no numero: sob limitacao do ONS as
      // tres usinas fora do PPA (M1, M7, M9) vao a ~1 MW para blindar a entrega contratada, e
      // so sao liberadas depois que a meta do PPA do mes e atingida.
      //
      // Substitui tambem a estimativa "piso" que o ML carregava nesses meses, que vinha da
      // comparacao de rendimento com as irmas do PPA e produzia parte maior que o todo
      // (dez/25 dava ML 2,68 GWh contra 1,66 do conjunto — aritmeticamente impossivel).
      //
      // As usinas individuais seguem sem corte nesses meses, de proposito: repartir por usina
      // exigiria uma camada a mais de suposicao sobre uma que ja e estimativa.
      // Contexto completo em RT-MRD-2026-001 Rev.00 (Reginaldo Barros, 21/07/2026).
      {
        const par = m => [out.find(x => x.ufv === 'PPA' && x.mes === m), out.find(x => x.ufv === 'ML' && x.mes === m)];
        const shares = [];
        out.filter(l => l.ufv === 'PPA' && l.cortado_gwh != null).forEach(p => {
          const [, m] = par(p.mes); if (!m || m.cortado_gwh == null) return;
          const tot = p.cortado_gwh + m.cortado_gwh;
          if (tot > 0) shares.push(m.cortado_gwh / tot); });
        if (shares.length >= 3) {
          const shML = shares.reduce((a, b) => a + b, 0) / shares.length;
          const lo = Math.min(...shares), hi = Math.max(...shares);
          const nota = 'REPARTICAO ESTIMADA. O total do conjunto neste mes e MEDIDO (registro do ONS na '
            + 'subestacao, verificado contra o medidor de faturamento Way2). A divisao entre PPA e Mercado '
            + 'Livre e ESTIMADA: ate fev/26 o ONS nao publica corte por usina utilizavel, porque as tags de '
            + 'M3 e M7 estavam comprometidas — o rele do cubiculo CUB10_1 registrava metade da corrente do '
            + 'circuito M3-C2 (RTC 300/1 contra TC fisico 600/1, reparado em 12/07/2026) e as tags da M7 '
            + 'apontavam para esse mesmo cubiculo, de modo que a M7 nao tinha geracao propria telemetrada '
            + '(corrigido em 17/07/2026). A divisao aplicada e a media observada nos meses de dado integro: '
            + 'o Mercado Livre absorve ' + Math.round(shML * 1000) / 10 + '% do corte (faixa de '
            + Math.round(lo * 1000) / 10 + '% a ' + Math.round(hi * 1000) / 10 + '% em ' + shares.length
            + ' meses), contra 21,4% da capacidade instalada. Essa desproporcao e a politica de despacho: sob '
            + 'limitacao do ONS, M1, M7 e M9 sao levadas a ~1 MW para blindar a entrega do PPA, e so sao '
            + 'liberadas apos o atingimento da meta contratada. Contexto completo em RT-MRD-2026-001 Rev.00.';
          out.filter(l => l.ufv === 'Complexo' && l.cortado_gwh != null).forEach(cx => {
            const [P, M] = par(cx.mes);
            if (!P || !M || P.cortado_gwh != null) return;          // so onde a repartição falta
            M.cortado_gwh = r2(cx.cortado_gwh * shML);
            P.cortado_gwh = r2(cx.cortado_gwh - M.cortado_gwh);
            [P, M].forEach(l => { l.corte_estimado = 1; l.corte_reconciliado = 1;
              l.corte_ml_share = Math.round(shML * 1e4) / 1e4;
              l.corte_pct = l.potencial_gwh > 0 ? r2(100 * l.cortado_gwh / l.potencial_gwh) : null;
              l.outras_gwh = null;
              l.corte_reconc_nota = nota; });
            cx.corte_reparticao_estimada = 1; });
        }
      }
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

  // ---------- 6b) PR LIVRE por entidade, sobre o serie_ufv ja pronto ----------
  // Feito aqui, e nao dentro de `linha()`, porque `linha()` e chamada com argumentos posicionais em
  // quatro lugares de formatos diferentes — esticar a assinatura para carregar mais dois baldes seria
  // trocar clareza por economia de linhas. Aqui basta reler os acumuladores do mes.
  //
  // POR QUE ESTE CAMPO EXISTE: o `pr_pct` divide por um potencial que inclui o que o ONS mandou nao
  // gerar, entao usina cortada le como usina ruim — e a casa sacrifica o Mercado Livre no corte de
  // proposito. Medido em 20/08/2026 na janela mar-ago/26: o M1 sai de 59,5% para 92,0% e passa de
  // PIOR do parque a TERCEIRO MELHOR; o M9 sai de 58,1% para 86,8%. As do PPA sobem ~15 pp, nao 33.
  {
    const somaLivre = (I, us) => us.reduce((a, u) => {
      const x = (I.porUfv || {})[u]; if (!x) return a;
      a.gv += x.gvPL || 0; a.ge += x.gePL || 0; a.pares += x.parLivre || 0; a.par += x.parN || 0; return a;
    }, { gv: 0, ge: 0, pares: 0, par: 0 });
    // grupos montados aqui a partir das constantes do topo: o `GRUPOS` do bloco 7 e local dele.
    const MEMBROS = { Complexo: Object.keys(CAP_UFV), PPA, ML };
    (out.serie_ufv || []).forEach(l => {
      const I = IRR[l.mes]; if (!I) { l.pr_livre_pct = null; l.pr_livre_cobertura_pct = null; return; }
      const us = MEMBROS[l.ufv] || [l.ufv];
      const t = somaLivre(I, us);
      l.pr_livre_pct = prLivre(t.gv, t.ge, t.pares);
      l.pr_livre_cobertura_pct = t.par > 0 ? r2(100 * t.pares / t.par) : null;
      // IRRADIANCIA MEDIA da entidade no mes, no mesmo recorte `util` do PR — e o eixo x do
      // grafico de PR x irradiancia. Para grupo e a media PONDERADA pela capacidade das usinas:
      // media simples deixaria o M9, de 9,8 MW, pesar igual ao M1, de 49,1 MW.
      { let is = 0, ip = 0;
        us.forEach(u => { const x = (I.porUfv || {})[u]; const c = CAP_UFV[u] || 0;
          if (x && x.irrN > 0 && c > 0) { is += (x.irrSoma / x.irrN) * c; ip += c; } });
        l.irr_media = ip > 0 ? r2(is / ip) : null; }
      // M7 nao tem serie propria no ONS (o registro dele e o circuito 2 do M3) — la o PR nao se
      // aplica, nem o publicado nem o livre. Mesma regra do `pr_pct`.
      if (l.pr_pct == null && l.fonte_realizado) l.pr_livre_pct = null;
      if (l.pr_livre_pct == null && t.ge > 0 && t.pares >= 20)
        l.pr_livre_nota = 'PR livre fora da faixa defensavel (50% a 110%): a geracao ESTIMADA do ONS '
          + 'para esta usina neste mes saiu incoerente com a verificada. O conjunto e integro; a '
          + 'abertura por usina nao. Sai vazio em vez de virar recorde.';
      if (l.pr_livre_pct != null) l.pr_livre_metodo = 'Realizado dividido pela referencia do ONS, '
        + 'contando SO as meias horas SEM limitacao registrada. Mede quanto a usina entrega quando a '
        + 'deixam entregar, e por isso NAO penaliza as usinas do Mercado Livre, que a casa sacrifica '
        + 'no corte de proposito. NAO e o Performance Ratio da IEC: e aderencia a referencia do ONS, '
        + 'a mesma razao do pr_pct. Cobertura em pr_livre_cobertura_pct.';
    });
  }

  // ---------- 7) CARDS, MANCHETE e CASCATA por UFV (o filtro do painel) ----------
  // Derivados DEPOIS do objeto pronto, a partir de out.serie_ufv — assim nada precisa ser movido de
  // lugar e a ordem de avaliação do literal não importa.
  // Cada estrutura ganha uma linha por usina + 'Complexo'; o painel filtra com [ufv='$ufv'].
  {
    // META RATEADA no mes corrente, para TODAS as entidades (Complexo, PPA, ML e as nove usinas).
    // O `meta_gwh` do serie_ufv e sempre do mes INTEIRO. O rateio existia so no `serie_e_media`, que
    // alimentava os dois paineis de entrega — ao unificar num painel unico com filtro por entidade a
    // fonte passa a ser esta, e sem o rateio agosto voltaria a parecer fracasso em todas as linhas.
    // CAMPO NOVO, nao substituicao: `meta_gwh` continua sendo o mes inteiro (varios paineis e o
    // acumulado dependem dele). Quem quer comparar contra o parcial usa `meta_rateada_gwh`.
    // O divisor sai de `w2_dias` — o mesmo conjunto de dias que forma a geracao, senao numerador e
    // denominador cobrem periodos diferentes.
    (() => {
      const diasDoMes = new Date(Date.UTC(+mesAtual.slice(0, 4), +mesAtual.slice(5, 7), 0)).getUTCDate();
      const CUR = out.serie.find(x => x.mes === mesAtual) || {};
      const dias = num(CUR.w2_dias) || 0;
      const fator = (dias > 0 && dias < diasDoMes) ? dias / diasDoMes : 1;
      out.serie_ufv.forEach(x => {
        const parcial = x.mes === mesAtual && fator < 1;
        x.parcial = parcial ? 1 : 0;
        x.meta_rateada_gwh = parcial ? r2(num(x.meta_gwh) * fator) : x.meta_gwh;
        x.dias_corridos = parcial ? dias : null;
        x.dias_do_mes = parcial ? diasDoMes : null;
      });

      // 🔴 O ATINGIMENTO DO MES ABERTO PASSA A USAR A META RATEADA.
      //
      // Ate 27/08/2026 `atingido_pct` dividia sempre pela meta do mes INTEIRO. Num mes em curso
      // isso compara 26 dias de geracao com 31 dias de meta, e o campo dizia 98,66% para o
      // Complexo em agosto enquanto TODOS os paineis mostravam 117,63% — eles ja rateavam por
      // conta propria. Dois numeros discordantes para a mesma coisa, e quem le o blob (ou monta um
      // painel novo a partir dele) obtinha o errado.
      //
      // ⚠️ O outro numero NAO se perde: `atingido_mes_cheio_pct` guarda "quanto da meta do mes
      //    inteiro ja foi entregue", que e uma pergunta legitima e e a que o card executivo mostra
      //    na coluna `% ja entregue`. Sao perguntas diferentes e agora tem nomes diferentes.
      const rateia = (x, liq) => {
        x.atingido_mes_cheio_pct = x.atingido_pct;
        const mr = num(x.meta_rateada_gwh);
        x.atingido_pct = (mr > 0 && liq != null) ? r2(100 * liq / mr) : x.atingido_pct;
      };
      out.serie_ufv.filter(x => x.parcial === 1)
        .forEach(x => rateia(x, num(x.liquida_gwh)));

      // o CONJUNTO tem a mesma conta, e ate agora nem publicava a meta rateada — os paineis a
      // recalculavam. Publicando-a aqui, a regra passa a existir num lugar so.
      out.serie.forEach(x => {
        const parcial = x.mes === mesAtual && fator < 1;
        x.parcial = parcial ? 1 : 0;
        x.meta_rateada_gwh = parcial ? r2(num(x.meta_gwh) * fator) : x.meta_gwh;
        if (!parcial) return;
        rateia(x, num(x.way2_liq_gwh));
        // ⚠️ `bateu` acompanha o numerador novo: num mes em curso ele passa a dizer "esta no
        //    ritmo de bater", que e a leitura util. Quem conta meses fechados filtra por `fechado`.
        x.bateu = x.atingido_pct == null ? null : (x.atingido_pct >= 100 ? 1 : 0);
      });
    })();

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
      // ESCALA FIXA E SIMETRICA EM TORNO DE 100, com amplitude minima de +-30 pp.
      // Antes era normalizada do MENOR ao MAIOR de cada linha: o pior mes desenhava sempre em 8% da
      // altura e o melhor sempre em 92%, INDEPENDENTE da distancia real entre eles. No Conjunto, meses
      // entre 100% e 125% viravam barras com 12x de diferenca — um mes perfeitamente bom parecia
      // desastre. Pior: cada linha tinha a propria escala, entao Conjunto e Mercado Livre nao eram
      // comparaveis apesar de estarem na mesma coluna.
      // Agora a banda e 100 +- S, com S = 30 ou o maior desvio, o que for maior (arredondado a 5). Com
      // os dados de hoje as tres linhas caem na mesma banda 70-130, entao ficam comparaveis entre si, e
      // a linha de 100 fica exatamente no MEIO da caixa — a leitura "esteve acima?" vira imediata.
      const desvio = Math.max(...ok.map(y => Math.abs(y - 100)));
      const S = Math.max(30, Math.ceil(desvio / 5) * 5);
      const mn = 100 - S, amp = 2 * S;
      const alt = y => Math.min(92, Math.max(8, 8 + (y - mn) / amp * 84)).toFixed(1);   // 8%..92%
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
      // 🔴 O `|| dTot` era um fallback para mes SEM linha diaria nenhuma — e virava "mes
      // inteiro decorrido" quando TODOS os dias eram parciais, que e exatamente o dia 1o de um
      // mes em curso: dCorr ia a 30, `fechado` a 1, e o mes recem-nascido entrava nos agregados
      // como fechado com um dia de energia. So cai no fallback quando nao ha dia nenhum.
      const dCorr = diasMes.length ? diasMes.filter(x => !x.parcial || x.encerrado).length : dTot;
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
      const projCorte = dCorr > 0 ? r2(cur.cortado_gwh * fatorD) : null;
      const antCorte = ant ? ant.cortado_gwh : null;

      out.cards_ufv.push(
        { mes: mSel, ufv: u, k: 'pr', label: 'Performance Ratio', v: fmt(cur.pr_pct), u: '%', sub: 'alvo 90%',
          var: vPR == null ? '' : seta(vPR) + ' pp', var_cor: corVar(vPR == null ? null : vPR >= 0, vPR),
          cor: cur.pr_pct == null ? '#8B93A1' : (cur.pr_pct >= 90 ? '#43966B' : (cur.pr_pct >= 80 ? '#C08A45' : '#C85C60')),
          spark: barras(S.map(x => x.pr_pct), '#D9A441'), spark_ini: S[0].lbl, spark_fim: cur.lbl },
        { mes: mSel, ufv: u, k: 'disp', label: 'Disponibilidade', v: fmt(cur.disp_pct), u: '%',
          // mesma razao do card de horas: a disponibilidade e publicada para o conjunto
          sub: compl ? 'medida no conjunto · alvo 97%' : 'alvo 97%',
          var: compl ? '· do conjunto' : '', var_cor: '#8B93A1',
          cor: compl ? '#8B93A1' : (cur.disp_pct >= 97 ? '#43966B' : '#C08A45'),
          spark: barras(S.map(x => x.disp_pct), compl ? '#6E7683' : '#4E9A98'),
          spark_ini: S[0].lbl, spark_fim: cur.lbl },
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
          sub: compl ? 'a limitação é registrada para o conjunto' : 'ONS · dia ' + mes.dias_decorridos + ' de ' + dTot + ' (D+1)',
          // 🔴 COR DE REFERENCIA quando a selecao NAO e o conjunto. O ONS registra a limitacao
          //    para o complexo inteiro — o numero e o mesmo em todas as entidades, e pintar de cor
          //    viva um valor que nao responde ao filtro faz o leitor concluir que o card quebrou.
          //    Cinza de referencia diz, sem texto, "este nao e da sua selecao".
          var: compl ? '· do conjunto' : '', var_cor: '#8B93A1', cor: compl ? '#8B93A1' : '#C08A45',
          spark: barras(S.map(x => x.horas_restricao), compl ? '#6E7683' : '#C08A45'),
          spark_ini: S[0].lbl, spark_fim: cur.lbl });

      // ---- manchete ----
      // base = so os dias FECHADOS (tira a energia de hoje, que e de um dia pela metade).
      // O "ja realizado" logo abaixo continua incluindo hoje — aquilo e energia entregue de fato.
      // ⚠️ SEM DIA FECHADO nao ha ritmo de onde projetar: a subtracao da zero e a tela
      // afirmaria "o mes vai fechar em 0 GWh". Nulo — o template ja mostra travessao.
      const proj = dCorr > 0 ? r2((cur.liquida_gwh - hojeCru) * fatorD) : null;
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
            // PREFIXO OBRIGATORIO. No Handlebars o HELPER ganha do campo do contexto, e os helpers
            // de um painel Business Text vazam para os outros da MESMA pagina. O painel [3] do
            // sumario1 registra `cor(u)`, que sem argumento devolve #45B8C4 — e as barras do card
            // saiam TEAL. Pior: no render d-solo funcionava, porque ali o painel vizinho nao existe.
            // Nome de campo consumido por Business Text nao pode ser palavra curta e generica.
            // `cor` sai no dado, nao no template: os cards do cabecalho pintavam PPA e Complexo
            // com o verde da casa, que e a cor do ML — a mesma entidade trocava de cor entre a
            // parte de cima e os graficos de baixo da pagina. Quem decide a cor e o mapa, e o mapa
            // mora aqui. (usuario, 16/08/2026)
            return { ufvcor: cor, spark_ating: sparkLinha(serie, cor, '#6B7482'),
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
            // AINDA COLADOS, e de proposito: os tres tem de sair da MESMA apuracao ou a comparacao
            // nao vale. O nosso ja da para calcular aqui (serie[].corte_janela_pct, publicado abaixo),
            // mas Nordeste e Abaiara dependem do arquivo do ONS com os 54 conjuntos do subsistema, que
            // ainda nao entra no pipeline. Destravar so o nosso deixaria um numero vivo ao lado de dois
            // congelados — pior que os tres congelados juntos. Os tres se destravam de uma vez no
            // gen-benchmark-ons.js.
            // CALCULADOS, finalmente, do benchmark_ne.json — e os tres pelo MESMO criterio e na MESMA
            // janela, que e o que torna a comparacao legitima. Janela: jan/26 em diante, referencia de
            // todas as analises deste painel. Percentual agregado = Σcortado / (Σgerado + Σcortado),
            // ponderado pela energia e nao media de percentuais, senao um mes pequeno pesaria igual a
            // um mes grande.
            // Mes com referencia do ONS quebrada entra pelo valor ESTIMADO (jan e fev/26; ver
            // nosso_estimado_metodo no blob), porque o bruto ali nao mede corte, mede um gref invalido.
            // JANELA mar/26 EM DIANTE, e nao jan/26: em jan e fev o `gref` do ONS vem subdeclarado e os
            // dois meses so existiam por ESTIMATIVA. Entrar com estimativa aqui puxava o agregado para
            // baixo e punha o card em 19,33% enquanto o grafico logo abaixo, do MESMO blob, mostrava 23
            // a 24% — dois numeros para a mesma coisa na mesma secao. A janela agora e a mesma dos
            // quatro graficos da secao 2, e nenhum estimado entra no card.
            // CONVENCAO `maior_zero` (val_geracaolimitada > 0), tambem igual a dos graficos.
            const CORTE_INI = '2026-03';
            // SOMENTE MESES FECHADOS, igual aos cards de meta e disponibilidade ao lado. O mes corrente
            // entra pela metade: somar agosto com 18 GWh gerados no mesmo total que julho com 55 punha
            // 74,98 GWh de energia impedida ao lado de 305,27 GWh entregues que NAO contavam agosto —
            // dois recortes diferentes na mesma linha de cards. O mes parcial continua visivel no
            // grafico mes a mes, onde barra curta se le como mes incompleto; no ACUMULADO ele nao entra.
            const BS = ((BENCH || {}).serie || [])
              .filter(x => x.fonte === 'solar' && String(x.mes) >= CORTE_INI && String(x.mes) < mesAtual);
            const agg = (pc, pg) => { let c = 0, g = 0;
              BS.forEach(x => { const v = x[pc];
                if (v != null && x[pg] != null) { c += v; g += x[pg]; } });
              return (c + g) > 0 ? { pct: r2(100 * c / (c + g)), cortado: r2(c), gerado: r2(g) } : null; };
            const aM = agg('nosso_cortado_gwh_maior_zero', 'nosso_gerado_gwh');
            const aN = agg('ne_cortado_gwh_maior_zero', 'ne_gerado_gwh');
            const aA = agg('abaiara_cortado_gwh_maior_zero', 'abaiara_gerado_gwh');
            // rotulo da janela DERIVADO dos meses que entraram, e a contagem de dias vem do proprio
            // blob (`nosso_dias`, que ja desconta 03/03 e 11/03). O texto fixo "mar a jul/26 · 151 dias"
            // ficou parado em julho enquanto agosto ja entrava nos graficos.
            const MES_LBL = m => ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out',
              'nov', 'dez'][Number(String(m).slice(5, 7)) - 1] + '/' + String(m).slice(2, 4);
            const DIAS_JAN = BS.reduce((a2, x) => a2 + (x.nosso_dias || 0), 0);
            const JANELA = BS.length
              ? (BS.length === 1 ? MES_LBL(BS[0].mes)
                : MES_LBL(BS[0].mes) + ' a ' + MES_LBL(BS[BS.length - 1].mes))
                + ' · ' + DIAS_JAN + ' dias'
              : 'sem dado';
            // razao e origem, agora CALCULADAS do benchmark (energia por codigo, nao contagem)
            const somaB = k => BS.reduce((a2, x) => a2 + (x[k] || 0), 0);
            const RZ_GWH = { ene: somaB('nosso_razao_ene_gwh'), cnf: somaB('nosso_razao_cnf_gwh'),
              rel: somaB('nosso_razao_rel_gwh'), outras: somaB('nosso_razao_outras_gwh') };
            const RZ_TOT = RZ_GWH.ene + RZ_GWH.cnf + RZ_GWH.rel + RZ_GWH.outras;
            const OR_GWH = { sis: somaB('nosso_origem_sis_gwh'), loc: somaB('nosso_origem_loc_gwh'),
              outras: somaB('nosso_origem_outras_gwh') };
            const OR_TOT = OR_GWH.sis + OR_GWH.loc + OR_GWH.outras;
            const pc = (v, t) => t > 0 ? r2(100 * v / t) : null;
            const MAURITI = aM ? aM.pct : null, NORDESTE = aN ? aN.pct : null, ABAIARA = aA ? aA.pct : null;
            // A ENERGIA, nao so o percentual. Para quem le, 21,20% e abstrato; 69,40 GWh que o ONS
            // impediu de gerar e concreto, e e o numero que a pessoa leva da reuniao. O atingimento
            // ja aparecia em GWh no card ao lado — o corte nao, e essa assimetria enfraquecia o lado
            // que mais precisa de peso. Mesma apuracao dos percentuais acima.
            const CORTADO_GWH = aM ? aM.cortado : null;
            // A MESMA apuracao, aberta: o que foi gerado, e por que o resto nao foi. Tudo da janela
            // mar-jul, para os cards nao misturarem recorte — o erro que derrubava a versao anterior
            // do painel era exatamente este: waterfall e causa vinham do acumulado pos-COD enquanto
            // o card do corte dizia mar-jul, e ninguem avisava.
            const GERADA_GWH = aM ? aM.gerado : null;   // Mauriti, conjunto, jan/26 em diante
            const RAZAO = { ene: pc(RZ_GWH.ene, RZ_TOT), cnf: pc(RZ_GWH.cnf, RZ_TOT),
              rel: pc(RZ_GWH.rel, RZ_TOT), outras: pc(RZ_GWH.outras, RZ_TOT) };
            const RAZAO_GWH = { ene: r2(RZ_GWH.ene), cnf: r2(RZ_GWH.cnf), rel: r2(RZ_GWH.rel),
              outras: r2(RZ_GWH.outras) };
            const ORIGEM = { sis: pc(OR_GWH.sis, OR_TOT), loc: pc(OR_GWH.loc, OR_TOT),
              outras: pc(OR_GWH.outras, OR_TOT) };
            const HORAS_RESTR = r2(somaB('nosso_horas_restricao'));
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
              corte_outras_razao_pct: RAZAO.outras, corte_outras_origem_pct: ORIGEM.outras,
              corte_vantagem_pp: r2(NORDESTE - MAURITI),
              corte_janela: JANELA,
              corte_fonte: 'ONS · Restrição de Geração — nível conjunto, subsistema NE; calculado a cada '
                + 'rodada pelo gen-benchmark-ons.js, convenção val_geracaolimitada > 0, meses completos, '
                + 'menos 03/03 e 11/03 (nesses dois o ONS publica mais geração do que o medidor Way2)',
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
      let accL = 0, accM = 0;          // acumulado do ANO CIVIL, reinicia em janeiro
      let vidaL = 0, vidaM = 0;        // acumulado da VIDA do ativo, corre desde set/25 sem reiniciar
      let anoCorr = null;
      out.serie.forEach(s => {
        const P = (porUfvMes.PPA || {})[s.mes], L = (porUfvMes.ML || {})[s.mes];
        // 2) PPA x ML: a compensacao entre contratos e a leitura mais delicada do ano — o conjunto
        //    so fecha acima da meta porque o excedente do PPA cobre o deficit do mercado livre.
        s.ppa_ating_pct = P ? P.atingido_pct : null;
        s.ml_ating_pct = L ? L.atingido_pct : null;
        s.ppa_liq_gwh = P ? P.liquida_gwh : null;
        s.ml_liq_gwh = L ? L.liquida_gwh : null;
        // 3) ACUMULADO correndo contra a meta: percentual mensal nao mostra se o ANO esta ganho.
        //    Sao DUAS contagens, e elas respondem perguntas diferentes:
        //    · acum_*      — do ANO CIVIL, reinicia em janeiro. Antes so era calculado para o ano
        //                    corrente, entao set-dez/25 saia null e o painel do acumulado abria
        //                    VAZIO com o filtro em 2025. Agora vale para todo ano da serie.
        //    · vida_acum_* — da VIDA do ativo, corre desde o primeiro mes sem reiniciar. E o que o
        //                    painel [14] do sumario usa: uma linha so, de set/25 ate hoje.
        //    O x do painel NAO pode ser o numero do mes: numa serie que atravessa o ano ele desce
        //    de 12 para 1 e o trend recusa a serie inteira. Por isso vai tambem `eixo_x`, contador
        //    continuo (ano - 2025) * 12 + mes, que sobe sempre e da a cada mes um rotulo estavel.
        const anoS = s.mes.slice(0, 4);
        s.eixo_x = (Number(anoS) - 2025) * 12 + Number(s.mes.slice(5, 7));
        if (s.meta_gwh != null && s.way2_liq_gwh != null) {
          if (anoS !== anoCorr) { accL = 0; accM = 0; anoCorr = anoS; }
          accL += s.way2_liq_gwh; accM += s.meta_gwh;
          vidaL += s.way2_liq_gwh; vidaM += s.meta_gwh;
          s.acum_liq_gwh = r2(accL); s.acum_meta_gwh = r2(accM);
          s.acum_ating_pct = accM > 0 ? r2(100 * accL / accM) : null;
          s.vida_acum_liq_gwh = r2(vidaL); s.vida_acum_meta_gwh = r2(vidaM);
          s.vida_acum_ating_pct = vidaM > 0 ? r2(100 * vidaL / vidaM) : null;
        } else {
          s.acum_liq_gwh = null; s.acum_meta_gwh = null; s.acum_ating_pct = null;
          s.vida_acum_liq_gwh = null; s.vida_acum_meta_gwh = null; s.vida_acum_ating_pct = null;
        }
      });
    }

    // ---------- ACUMULADO POR ENTIDADE ----------
    // O mesmo acumulado de vida que vai em `serie`, mas por linha de `serie_ufv` — sem isso o painel
    // do acumulado nao tem como obedecer ao filtro de usina/contrato: `serie` so existe no nivel
    // conjunto. Mesma regra de x: eixo_x continuo, senao o trend recusa a serie que atravessa o ano.
    {
      const acc = {};
      (out.serie_ufv || []).slice()
        .sort((a, b) => a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0)
        .forEach(x => {
          x.eixo_x = (Number(x.mes.slice(0, 4)) - 2025) * 12 + Number(x.mes.slice(5, 7));
          if (x.liquida_gwh != null && x.meta_gwh != null) {
            const k = acc[x.ufv] = acc[x.ufv] || { L: 0, M: 0 };
            k.L += x.liquida_gwh; k.M += x.meta_gwh;
            x.vida_acum_liq_gwh = r2(k.L); x.vida_acum_meta_gwh = r2(k.M);
            x.vida_acum_ating_pct = k.M > 0 ? r2(100 * k.L / k.M) : null;
          } else {
            x.vida_acum_liq_gwh = null; x.vida_acum_meta_gwh = null; x.vida_acum_ating_pct = null;
          }
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
      // A MEDIA SO OLHA MESES FECHADOS. As barras dos meses continuam todas — inclusive a do mes
      // corrente, marcada com asterisco — mas a media nao pode dividir por ele: em 12/08 o mes tinha
      // 18,41 GWh entregues contra meta de mes inteiro, e entrar nessa conta derrubava a media do PPA
      // de 36,34 para 36,45 na meta e de 7,27 para 4,01 no superavit. Media contaminada por mes pela
      // metade e pior que media nenhuma: ela vira a REGUA com que o leitor julga cada mes.
      const F = A.filter(x => x.mes < mesAtual);
      const BASE = F.length ? F : A;                 // em janeiro do ano F fica vazio; nao divide por 0
      // META DO MES CORRENTE RATEADA pelos dias transcorridos. A meta do PPA e uma TAXA POR DIA (ver
      // METAS): 37,20 GWh em agosto sao 1,20 GWh/dia. Cobrar o mes inteiro de um mes que tem 12 dias
      // corridos faz a barra parecer fracasso quando a operacao esta adiante do contrato — em 12/08 o
      // PPA tinha entregue 18,41 GWh contra 14,40 rateados, ou seja 4,01 ACIMA, e o grafico mostrava o
      // oposto. Vale so para o mes corrente; mes fechado nunca e rateado.
      // Os dias vem do DADO (a serie diaria do proprio mes), nao do relogio: assim o rateio acompanha
      // ate onde a medicao chegou, que e o que a barra representa.
      const diasDoMes = new Date(Date.UTC(+mesAtual.slice(0, 4), +mesAtual.slice(5, 7), 0)).getUTCDate();
      // O divisor sai do MESMO conjunto de dias do numerador: `w2_dias` e a contagem de dias do Way2
      // que formam `ppa_liq_gwh` e `way2_liq_gwh`. Antes eu usava a serie diaria, que ia ate o dia 10
      // enquanto o Way2 ja tinha 11 — um dia de defasagem que inflava o superavit de agosto em ~1,2 GWh.
      const CUR = (out.serie || []).find(x => x.mes === mesAtual) || {};
      const diasCorridos = num(CUR.w2_dias) || 0;
      const fatorMes = (diasCorridos > 0 && diasCorridos < diasDoMes) ? diasCorridos / diasDoMes : 1;
      const rateia = (x, k) => (x.mes === mesAtual && /^meta/.test(k))
        ? r2(num(x[k]) * fatorMes) : x[k];
      const med = k => r2(BASE.reduce((a, x) => a + num(x[k]), 0) / BASE.length);
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
      return A.map(x => Object.assign(linha(x.lbl, 0, k => rateia(x, k)), {
        mes: x.mes,
        parcial: x.mes === mesAtual && fatorMes < 1 ? 1 : 0,
        dias_corridos: x.mes === mesAtual ? diasCorridos : null,
        dias_do_mes: x.mes === mesAtual ? diasDoMes : null,
        meta_cheia_gwh: x.mes === mesAtual ? x.meta_gwh : null,
        meta_ppa_cheia_gwh: x.mes === mesAtual ? x.meta_ppa_gwh : null,
      })).concat([linha('MÉDIA', 1, med)]);
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

  // ---------- PRÉ-COD POR RAZÃO (Portaria MME 140/2026, art. 3º) ----------
  // A energia frustrada do pré-COD não é apurável pelo ONS — a Sinapse registra a ocorrência mas não
  // tem geração de referência. Estes números vêm da apuração do usuário (ver PRECOD, congelado).
  // Aqui só se repassa o que está no arquivo, com um campo derivado: `tiles`, já formatado, para o
  // card do topo não precisar de matemática no template.
  if (PRECOD) {
    const P = PRECOD.pre_cod;
    out.pre_cod_razoes = {
      revisao: PRECOD._revisao, emissao: PRECOD._emissao, congelado_em: PRECOD._congelado_em,
      // ⚠️ O NÚMERO DE TELA É A FASE PRÉ-COD, não a janela do art. 3º. A janela é recorte de norma
      // (01/01 a 25/11/2025) e carrega 69,14 GWh de energia PÓS-COD — rotular aquilo de "pré-COD"
      // sobra 53% no número. A janela fica em `janela_art3`, para auditoria, fora da tela.
      total: { gwh: P.total_gwh, mwh: P.total_mwh,
        estimado_mwh: P.estimado_mwh, sager_pre_cod_mwh: P.sager_pre_cod_mwh },
      janela_art3: PRECOD.janela_art3,
      mensal: P.mensal,
      horas: { calendario: P.horas_calendario, sinapse: P.horas_sinapse,
               sobreposicao: P.sobreposicao_h },
      // O painel tem de poder dizer a incerteza sem que ninguém a escreva à mão no HTML.
      incerteza: { banda_pct: P.banda_pct,
        desvio_mensal_pct: PRECOD.validacao.desvio_padrao_mensal_pct,
        aviso: PRECOD._aviso_validacao },
      // tiles prontos, já ordenados do maior para o menor pelo arquivo congelado.
      // `classe`/`classe_lbl` seguem no dado (auditoria e enquadramento futuro), mas o painel do
      // cabeçalho não os exibe: ali o pedido é mostrar o número, não enquadrar na Portaria.
      tiles: P.por_razao.map(z => ({
        l: z.codigo, nome: z.nome, v: z.gwh, u: 'GWh', pct: z.pct,
        classe: z.portaria,
        classe_lbl: { compensavel: 'Compensável', nao_compensavel: 'Não compensável',
                      a_classificar: 'A classificar' }[z.portaria] || z.portaria,
        // A cor vem do DADO, não do template: se o painel decidisse a cor por conta, seria valor
        // escrito à mão e sairia de sincronia na primeira mudança de classificação. E `cor` vazio
        // não falha visivelmente — o CSS fica inválido e o navegador pinta a borda com a cor
        // herdada, o que PARECE certo e não é. Foi o que aconteceu quando eu a removi sem notar.
        cor: z.portaria === 'compensavel' ? '#43966B'
           : (z.portaria === 'nao_compensavel' ? '#C85C60' : '#8B93A1'),
        t: z.nome + ' — ' + z.gwh + ' GWh (' + z.pct + '% do curtailment pré-COD); '
           + r2(z.estimado_mwh / 1000) + ' GWh estimado (04/01 a 31/08) + '
           + r2(z.sager_pre_cod_mwh / 1000) + ' GWh medido pelo SAGER nas usinas ainda em teste',
      })),
      fonte: PRECOD._fonte,
    };
    // 🔴 o rótulo do bloco de pré-COD vai nas TRÊS línguas (o código ENE/CNF/REL não muda)
    out.pre_cod_razoes.tiles.forEach((z) => rot.localiza(z, ['nome', 'classe_lbl', 'u']));
    console.log('pré-COD por razão (' + PRECOD._revisao + '): ' + P.total_gwh + ' GWh · '
      + P.por_razao.map(z => z.codigo + ' ' + z.gwh).join(' · ')
      + '  [janela art.3º = ' + PRECOD.janela_art3.total_gwh + ' GWh, fora da tela]');
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
      // 🔴 GUARDA QUE PRODUZ DATA INVALIDA NAO E GUARDA. O sentinela era '0000-00-00', e
      // `new Date('0000-00-00T12:00:00Z')` da Invalid Date — a linha seguinte estoura com
      // "Invalid time value", mensagem que nao aponta para nada. Com o perfil vazio nao ha vao a
      // completar: o certo e nao entrar no bloco, dizendo por que.
      const diasOns = [...new Set(perfil.map(x => x.dia))]
        .filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)).sort();
      const ultOns = diasOns.pop();
      const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
      const faltam = [];
      if (!ultOns) {
        console.log('  perfil do ONS vazio — nada a completar pelo Way2 (o vao D+0 fica de fora)');
      } else {
        for (let d = new Date(ultOns + 'T12:00:00Z'); ; ) {
          d = new Date(d.getTime() + 86400000);
          const s = d.toISOString().slice(0, 10);
          if (s > hoje) break; faltam.push(s);
          if (faltam.length > 60) throw new Error('vao D+0 maior que 60 dias a partir de ' + ultOns
            + ' — o detalhe do ONS parou de ser publicado');
        }
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
    // 🔴 O AGREGADO DE 1 H CHEGA COM HORAS DE ATRASO e guarda o que apurou. O agendador do
    //    GitHub entrega ~5,6 execucoes/dia de 24 declaradas, entao ele fica horas para tras; e
    //    quando apura durante uma queda de telemetria, guarda o valor ruim para sempre. O
    //    snapshot de 5 min e disparado por FORA do agendador e RELIDO a cada rodada, entao ele
    //    completa o que falta E corrige o que a fonte repos.
    //
    //    Medido em 01/09/2026: o agregado parava em 11:00 com o snapshot ja em 14:10; e as 16:55
    //    ele ainda trazia 79,8 MW na hora 15 do medidor do complexo contra 220,5 do snapshot ja
    //    corrigido. Custo de dar precedencia ao snapshot nos dias assentados: ZERO — 1.181 pares
    //    em 30 e 31/08, divergencia maxima de 0,00 MW. Sao a mesma medicao; muda quem se corrige.
    //
    // ⚠️ HORA CHEIA, e o criterio saiu da DISTRIBUICAO: nos 3 dias com snapshot, fora a hora em
    //    curso, sao 1.482 pares ponto-hora com 12 amostras, 124 com 11 e 19 com menos. Os 124 sao
    //    inteiros — as horas 0 e 23, em TODOS os 25 pontos, porque o balde comeca em :05. Um piso
    //    fixo de 11 deixaria passar a hora 16 de 01/09, que tinha 11 amostras em 18 pontos e 12
    //    nos outros: na rampa do fim de tarde a amostra que falta desloca a media, e PPA + ML
    //    davam 133,0 MWh contra 124,9 do Complexo. A contagem do ponto tem de ser a MELHOR
    //    daquela hora — assim a hora cheia se define do proprio dado, e nao de um numero escolhido.
    let parcialChave = null, parcialMin = 0;
    for (let k = 0; k < 3; k++) {
      const dSnap = new Date(Date.now() - 3 * 3600 * 1000 - k * 86400000).toISOString().slice(0, 10);
      let snap = null;
      try { snap = await getJSON(BASE + 'hist/way2_' + dSnap + '.json'); }
      catch (e) { continue; }
      const porPonto = {};                       // pontoId -> { hora -> [kW] }
      const melhor = {};                         // hora -> maior numero de amostras entre os pontos
      let maiorHora = -1;
      (snap.dados || []).forEach(s => {
        if (s.nomeGrandeza !== 'Demat') return;
        const m = porPonto[s.pontoId] = porPonto[s.pontoId] || {};
        (s.valores || []).forEach(v => {
          if (v.valor == null) return;
          const hh = +String(v.data).slice(11, 13);
          (m[hh] = m[hh] || []).push(v.valor);
          if (hh > maiorHora) maiorHora = hh;
        });
      });
      Object.values(porPonto).forEach(m => Object.entries(m).forEach(([hh, vs]) => {
        if (!(melhor[hh] >= vs.length)) melhor[hh] = vs.length;
      }));
      // hora CHEIA para aquele ponto: nem em curso, nem com slot faltando em relacao aos outros
      const cheia = (h, n) => h < maiorHora && n >= 11 && n === melhor[h];

      let posto = 0, corrigido = 0;
      Object.entries(porPonto).forEach(([pid, m]) => {
        Object.entries(m).forEach(([hh, vs]) => {
          if (!cheia(+hh, vs.length)) return;
          const chave = dSnap + 'T' + String(+hh).padStart(2, '0');
          const alvo = dem[pid] = dem[pid] || {};
          const media = vs.reduce((a, b) => a + b, 0) / vs.length;
          // ⚠️ 0,5 kW de tolerancia, nao igualdade exata: o agregado arredonda, e comparar com
          //    1e-9 contava 575 "correcoes" por rodada que eram ruido de ponto flutuante.
          if (alvo[chave] != null && Math.abs(alvo[chave] - media) < 0.5) return;
          if (alvo[chave] != null) corrigido += 1; else posto += 1;
          alvo[chave] = media;
        });
      });

      // 🔴 A GUARDA VALE PARA AS DUAS FONTES. Ela estava so no ramo que ACRESCENTA, e o agregado
      //    passava por baixo: as 15:38 ele publicava 15:00 = 79,8 MW com UMA de 12 amostras, e a
      //    curva do Sumario desenhava uma queda de 206 para 80 que nao aconteceu. Guarda que
      //    governa uma fonte so nao e guarda — e o modo de errar e o pior: a PONTA da curva mente
      //    todo dia, e mente para BAIXO, que e o que parece usina parando.
      // ⚠️ So para HOJE: em dia passado o agregado ja se assentou e a hora 23 e legitima.
      if (k === 0) {
        const chaveDe = (h) => dSnap + 'T' + String(h).padStart(2, '0');
        let porRelogio = 0, porCobertura = 0, emCurso = 0;
        // 🔴 A HORA EM CURSO leva a ENERGIA ACUMULADA nela, nao a media das amostras. A media
        //    finge hora inteira: com UMA de 12 amostras ela dizia 79,8 MW como se fosse a hora
        //    toda, e a curva desenhava uma queda de 206 para 80 que nao aconteceu.
        //    A formula GENERALIZA a da hora cheia — soma(kW) x 5/60 == media x 1 h com 12
        //    amostras —, entao hora cheia sai identica e so a hora em curso passa a existir.
        // ⚠️ So os pontos com a MELHOR contagem daquela hora entram: se um medidor esta
        //    atrasado ele perde a hora, o tudo-ou-nada zera a entidade, e nenhum agregado soma
        //    minutos diferentes de cada circuito.
        const cCurso = chaveDe(maiorHora);
        const nCurso = melhor[maiorHora] || 0;
        Object.entries(dem).forEach(([pid, alvo]) => {
          const vs = (porPonto[pid] || {})[maiorHora];
          if (vs && vs.length === nCurso && nCurso > 0) {
            // kW-equivalente: dividido por 1000 mais adiante, da MWh acumulados na hora
            alvo[cCurso] = vs.reduce((a, b) => a + b, 0) * 5 / 60;
            emCurso += 1;
            return;
          }
          if (alvo[cCurso] == null) return;
          delete alvo[cCurso];
          porRelogio += 1;
        });
        // a cobertura PARCIAL e propriedade do PONTO: sai so para ele, porque e a media DELE que
        // fica enviesada quando o medidor perde slot no meio da rampa
        Object.entries(porPonto).forEach(([pid, m]) => {
          const alvo = dem[pid];
          if (!alvo) return;
          Object.entries(m).forEach(([hh, vs]) => {
            const h = +hh;
            if (h >= maiorHora || cheia(h, vs.length)) return;
            const c = chaveDe(h);
            if (alvo[c] == null) return;
            delete alvo[c];
            porCobertura += 1;
          });
        });
        if (emCurso) { parcialChave = cCurso; parcialMin = nCurso * 5;
          console.log('hora em curso ' + maiorHora + 'h publicada como energia acumulada em '
            + emCurso + ' pontos (' + parcialMin + ' min de cobertura)'); }
        if (porRelogio + porCobertura) console.log('hora descartada: ' + porRelogio
          + ' pela hora em curso, ' + porCobertura + ' por cobertura do medidor');
      }
      if (posto || corrigido) console.log('camada horaria de ' + dSnap + ': ' + posto
        + ' pares ponto-hora completados do snapshot de 5 min, ' + corrigido
        + ' corrigidos (o agregado guardava valor apurado durante falha de coleta)');
    }


    // a hora em curso e marcada para o painel poder distingui-la sem adivinhar pelo relogio
    const chaves = new Set();
    Object.values(dem).forEach(m => Object.keys(m).forEach(k => chaves.add(k)));
    // null se NENHUM circuito reportou: assim a hora sem dado nao vira zero (que o grafico
    // desenharia como usina parada).
    // 🔴 TUDO-OU-NADA. Se QUALQUER circuito da entidade faltar naquela hora, a entidade nao tem
    //    hora — somar o que existir subdeclara em SILENCIO. Medido em 01/09/2026, com a coleta
    //    caindo no meio da hora 14: PPA + ML davam 288,42 MWh contra 206,20 do Complexo, 82 MWh
    //    de divergencia na mesma tela, que o leitor le como dado errado. Custo medido no
    //    historico: 15 de 19.354 horas-usina (0,078%), em 3 dias — exatamente as subdeclaradas.
    const soma = (pts, k) => { let t = 0;
      for (const p of pts) { const v = (dem[p] || {})[k]; if (v == null) return null; t += v; }
      return pts.length ? t : null; };
    const horas = [];
    [...chaves].sort().forEach(k => {
      const dia = k.slice(0, 10), h = +k.slice(11, 13);
      const ehParcial = (k === parcialChave);
      const poe = (u, kw) => { if (kw == null) return;
        const l = { dia, h, ufv: u, mwh: r2(kw / 1000) };
        // ⚠️ o painel NAO deduz "em curso" do relogio: quem sabe a cobertura e quem a mediu.
        if (ehParcial) { l.parcial = 1; l.min = parcialMin; }
        horas.push(l); };
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
