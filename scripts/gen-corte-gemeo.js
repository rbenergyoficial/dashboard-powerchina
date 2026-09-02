/**
 * gen-corte-gemeo.js — energia impedida por GEMEO DE IRRADIANCIA.
 *
 * POR QUE EXISTE. A apuracao normal do corte e Sum max(0, (gref - ger) x 0,5) nos patamares com
 * limitacao. De set/25 a fev/26 ela nao vale: o `gref` do ONS vem ABAIXO da geracao verificada em
 * 74% a 94% dos patamares restritos (contra 10% a 23% de mar/26 em diante), o que e fisicamente
 * impossivel e zera a conta. Foram cinco meses de painel comecando em mar/26 por falta de numero.
 *
 * O METODO, em uma frase: para cada meia hora com limitacao registrada, o potencial e a geracao
 * TIPICA que o proprio complexo entregou em meias horas SEM limitacao, na MESMA faixa de
 * irradiancia, numa janela de dias em torno daquele dia. corte = Sum max(0, potencial - gerado) x 0,5.
 *
 * O QUE O DIFERENCIA do modelo reprovado de jan/fev (ver project_modelo_corte_irradiancia): aquele
 * partia de capacidade instalada, GTI e PR de projeto, e o corte, sendo a diferenca entre dois
 * numeros grandes, amplificava o vies do potencial em 4,3x. Este nao supoe NADA — aprende o que a
 * usina realmente entregava naquela semana. Por isso atravessa a rampa de COD (04/09 a 22/11/2025)
 * sem inventar corte: se em novembro ela so alcancava 280 MW com sol pleno, o potencial e 280 MW.
 *
 * O PORTAO. Toda rodada revalida o modelo contra os meses em que a apuracao do ONS presta e ABORTA
 * se o erro passar do limite. Modelo que nao se mede vira numero colado com passos extras.
 *
 * Env: DADOS_STORAGE (RW no container dados) · LOCAL_OUT p/ teste · OUT_BLOB · SEM_PORTAO=1 para
 * inspecionar uma rodada reprovada sem gravar.
 */
const rot = require('./lib-rotulos.js');
const https = require('https');

const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'corte_gemeo.json';

// Capacidade por UFV (MW). A irradiancia do conjunto e a media das 9 estacoes PONDERADA pela
// capacidade: uma estacao de 9,8 MW nao pode pesar igual a uma de 49,1 MW.
const CAP = { CEFMT1: 49.11, CEFMT2: 24.555, CEFMT3: 49.11, CEFMT4: 49.11, CEFMT5: 49.11,
              CEFMT6: 49.11, CEFMT7: 14.733, CEFMT8: 49.11, CEFMT9: 9.822 };

// PARAMETROS, escolhidos pelo ERRO MEDIDO nos seis meses de referencia valida, nao pelo gosto.
// Varredura de 10 combinacoes em 20/08/2026 (faixa 25/50 x quantil 0,5..0,9): esta ganhou nas
// tres metricas — MAE 6,7%, vies -2,3%, pior mes 13,6%. Quantil 0,6 empata em MAE com vies +2,5%.
const FAIXA = +(process.env.FAIXA || 25);        // largura da faixa de irradiancia, W/m2
const QUANT = +(process.env.QUANT || 0.5);       // quantil da geracao livre que vira potencial
const MIN_AMOSTRA = +(process.env.MIN_AMOSTRA || 8);
const JANELAS = [7, 14, 21, 35, 60, 120];        // dias, cresce ate juntar MIN_AMOSTRA
const IRR_MIN = 20;                              // abaixo disto e noite/crepusculo

// SET/25 NAO ENTRA NO POOL DE APRENDIZADO. Medido em 20/08/2026: naquele mes a geracao MEDIANA
// do conjunto em intervalos LIVRES com sol pleno (800-1000 W/m2) e 0,3 MW, enquanto nos RESTRITOS
// e 139 MW — as marcacoes estao INVERTIDAS em relacao a fisica, porque a usina estava em
// comissionamento e as horas "livres" eram justamente as horas paradas. Com a janela adaptativa
// esticando ate +-35 dias, esses intervalos entravam no pool de outubro e ensinavam ao modelo que
// "o normal com sol pleno e nao gerar": out/25 saia com 3,06 GWh em vez de 5,36.
const POOL_INI = process.env.POOL_INI || '2025-10-01';

// DIAS EXCLUIDOS, a mesma lista do gen-executivo.js e do gen-benchmark-ons.js. Em 03/03 e
// 11/03/2026 o ONS reporta 70% e 77% MAIS geracao do que o medidor de faturamento registrou —
// defeito da publicacao do CJU_CEMTD, nao do no nem da regiao. Sem isto o mes de marco sai com
// 242,5 h contra as 223,5 h que o resto do painel mostra: duas contagens para o mesmo mes na
// mesma pagina, que e pior do que a imprecisao que a exclusao corrige.
const EXCLUI_DIA = new Set((process.env.EXCLUI_DIA || '2026-03-03,2026-03-11').split(','));

// LIMITES DO PORTAO. Folga de ~1,8x sobre o erro medido: o modelo pode piorar um pouco quando um
// mes novo entra, mas se dobrar o erro alguma premissa quebrou e o numero nao pode ir ao painel.
const MAX_MAE = +(process.env.MAX_MAE || 12);
const MAX_VIES = +(process.env.MAX_VIES || 8);

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const MES_LBL = m => ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov',
  'dez'][+m.slice(5, 7) - 1] + '/' + m.slice(2, 4);
// eixo_x continuo: o numero do mes desce de 12 para 1 e o trend do Grafana recusa a serie inteira.
const EIXO_X = m => (+m.slice(0, 4) - 2025) * 12 + (+m.slice(5, 7));

function getJSON(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' } }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '')
        ? r.pipe(require('zlib').createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

async function grava(obj) {
  rot.localizaTudo(obj, ['lbl']);
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=900' } });
  return json.length;
}

const quant = (a, q) => {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y), i = (b.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? b[lo] : b[lo] + (b[hi] - b[lo]) * (i - lo);
};
const dnum = d => Math.floor(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5);
const num = s => (s === '' || s == null) ? null : Number(s);

(async () => {
  const [irrRaw, restRaw] = await Promise.all([
    getJSON(BASE + 'ons_irradiancia_all.json'),
    getJSON(BASE + 'ons_restricao_all.json'),
  ]);
  // A APURACAO DO ONS entra aqui, e nao so no portao: o painel precisa das duas colunas no MESMO
  // arquivo. Infinity devolve um frame por target, e barchart aceita um frame so — juntar no
  // JSONata do painel exigiria ler dois blobs, que e onde nasce serie sumindo entre um mes e outro.
  // Verdade = `nosso_cortado_gwh_maior_zero` com `nosso_ref_suspeita = 0`, os meses em que a
  // referencia do ONS nao esta quebrada.
  let bench = null;
  try { bench = await getJSON(BASE + 'benchmark_ne.json'); }
  catch (e) { console.log('benchmark_ne.json indisponivel (' + e.message + ')'); }
  const verdade = {};
  for (const x of ((bench || {}).serie || [])) {
    if (x.fonte === 'solar' && !x.nosso_ref_suspeita && x.nosso_cortado_gwh_maior_zero != null)
      verdade[x.mes] = x.nosso_cortado_gwh_maior_zero;
  }

  // irradiancia do conjunto, ponderada pela capacidade
  const IRR = {};
  for (const r of (irrRaw.consolidado || [])) {
    const c = CAP[r.u]; if (!c || r.irr == null || !isFinite(r.irr)) continue;
    const o = IRR[r.ts] || (IRR[r.ts] = { s: 0, p: 0, n: 0 });
    o.s += r.irr * c; o.p += c; o.n++;
  }

  const T = [];
  for (const r of (restRaw.consolidado || [])) {
    if (EXCLUI_DIA.has(r.ts.slice(0, 10))) continue;
    const i = IRR[r.ts], lim = num(r.lim);
    T.push({ ts: r.ts, mes: r.ts.slice(0, 7), d: dnum(r.ts), ger: num(r.ger),
      irr: i ? i.s / i.p : null, restrito: (lim != null && lim > 0) ? 1 : 0 });
  }
  for (const t of T) t.f = t.irr == null ? null : Math.floor(t.irr / FAIXA);

  const LIVRE = {};
  for (const t of T) {
    if (t.restrito || t.irr == null || t.irr <= IRR_MIN || t.ger == null) continue;
    if (t.ts.slice(0, 10) < POOL_INI) continue;
    (LIVRE[t.f] || (LIVRE[t.f] = [])).push(t);
  }

  function potencial(t) {
    for (const J of JANELAS) {
      const c = [];
      // faixa propria primeiro; as vizinhas so completam quando a propria nao junta amostra
      for (const df of [0, -1, 1]) for (const x of (LIVRE[t.f + df] || []))
        if (Math.abs(x.d - t.d) <= J) c.push(x.ger);
      if (c.length >= MIN_AMOSTRA) return { p: quant(c, QUANT), n: c.length, j: J };
    }
    const c = [];
    for (const df of [0, -1, 1]) for (const x of (LIVRE[t.f + df] || [])) c.push(x.ger);
    return { p: quant(c, QUANT), n: c.length, j: null };
  }

  const M = {};
  for (const t of T) {
    if (!t.restrito || t.irr == null || t.ger == null) continue;
    const o = M[t.mes] || (M[t.mes] = { gwh: 0, n: 0, js: [], ns: [] });
    const { p, n, j } = potencial(t);
    o.n++; o.js.push(j == null ? 999 : j); o.ns.push(n);
    if (p != null) o.gwh += Math.max(0, p - t.ger) * 0.5 / 1000;
  }
  // geracao do mes inteiro, para o percentual
  const GER = {};
  for (const t of T) if (t.ger != null) GER[t.mes] = (GER[t.mes] || 0) + t.ger * 0.5 / 1000;

  const serie = Object.keys(M).sort().map(mes => {
    const o = M[mes];
    const jm = quant(o.js, 0.5), am = quant(o.ns, 0.5);
    // CONFIANCA pela largura da janela que o modelo precisou e pelo tamanho da amostra. Mes muito
    // restrito tem pouco intervalo livre para aprender, e isso tem de aparecer no dado, nao ficar
    // escondido atras de um numero de duas casas.
    const conf = mes < POOL_INI.slice(0, 7) ? 'baixa'
      : (jm <= 14 && am >= 10) ? 'alta' : (jm <= 35) ? 'media' : 'baixa';
    // COLUNAS PROPRIAS, presentes em toda linha mesmo vazias: coluna que aparece e some faz o
    // Grafana perder a serie entre um mes e outro. Um calculado NUNCA ocupa a coluna do apurado.
    const ons = verdade[mes] != null ? verdade[mes] : null;
    return { mes, lbl: MES_LBL(mes), eixo_x: EIXO_X(mes),
      corte_gwh: r2(o.gwh), gerado_gwh: r2(GER[mes]),
      corte_pct: r2(100 * o.gwh / (o.gwh + GER[mes])),
      corte_ons_gwh: ons,
      corte_calculado_gwh: (ons == null && conf !== 'baixa') ? r2(o.gwh) : null,
      corte_calculado_fraco_gwh: (ons == null && conf === 'baixa') ? r2(o.gwh) : null,
      corte_final_gwh: ons != null ? ons : r2(o.gwh),
      base: ons != null ? 'apurado' : 'calculado',
      horas_restricao: r2(o.n * 0.5), intervalos: o.n,
      janela_mediana_dias: jm, amostra_mediana: Math.round(am), confianca: conf };
  });

  // ---- PORTAO: revalida contra os meses em que a apuracao do ONS presta -------------------------
  const pares = serie.filter(s => verdade[s.mes] != null)
    .map(s => ({ mes: s.mes, ons: verdade[s.mes], modelo: s.corte_gwh,
                 erro_pct: r2(100 * (s.corte_gwh - verdade[s.mes]) / verdade[s.mes]) }));
  const mae = pares.length ? r2(pares.reduce((a, p) => a + Math.abs(p.erro_pct), 0) / pares.length) : null;
  const vies = pares.length ? r2(pares.reduce((a, p) => a + p.erro_pct, 0) / pares.length) : null;
  const pior = pares.length ? r2(Math.max(...pares.map(p => Math.abs(p.erro_pct)))) : null;
  const validacao = { meses: pares.length, mae_pct: mae, vies_pct: vies, pior_mes_pct: pior,
    limite_mae_pct: MAX_MAE, limite_vies_pct: MAX_VIES, pares };

  console.log('VALIDACAO em ' + pares.length + ' meses de referencia valida:');
  pares.forEach(p => console.log('  ' + p.mes + '  ONS ' + String(p.ons).padStart(6)
    + '  modelo ' + String(p.modelo).padStart(6) + '  ' + (p.erro_pct > 0 ? '+' : '') + p.erro_pct + '%'));
  console.log('  MAE ' + mae + '%  vies ' + vies + '%  pior ' + pior + '%');

  if (pares.length < 4) throw new Error('validacao impossivel: so ' + pares.length
    + ' mes(es) de referencia valida no benchmark. Nao gravo modelo que nao pude medir.');
  if (mae > MAX_MAE || Math.abs(vies) > MAX_VIES) {
    const msg = 'PORTAO REPROVOU: MAE ' + mae + '% (limite ' + MAX_MAE + ') · vies ' + vies
      + '% (limite +-' + MAX_VIES + '). O blob NAO foi atualizado.';
    if (!process.env.SEM_PORTAO) throw new Error(msg);
    console.log('AVISO (SEM_PORTAO=1): ' + msg);
  }

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'ONS Dados Abertos — irradiancia por UFV (restricao_coff_fotovoltaica_detail_tm) e '
      + 'geracao verificada/limitacao no nivel CONJUNTO (restricao_coff_fotovoltaica_tm), semi-hora. '
      + 'A base de geracao confere com o medidor de faturamento: ONS/Way2 fica em +-1% em 9 dos 12 meses.',
    metodo: 'GEMEO DE IRRADIANCIA, auto-calibrado no proprio ativo. Para cada meia hora com '
      + 'limitacao registrada, o potencial e o quantil ' + QUANT + ' da geracao que o COMPLEXO '
      + 'entregou em meias horas SEM limitacao, na mesma faixa de ' + FAIXA + ' W/m2, numa janela '
      + 'que cresce de +-7 ate +-120 dias ate juntar ' + MIN_AMOSTRA + ' amostras. '
      + 'corte = Sum max(0, potencial - gerado) x 0,5 h. Nao supoe capacidade instalada nem PR de '
      + 'projeto: aprende o que a usina entregava naquela semana, e por isso atravessa a rampa de COD.',
    ressalva: 'set/2025 fica fora do pool de aprendizado: naquele mes a geracao mediana em '
      + 'intervalos LIVRES com sol pleno e 0,3 MW contra 139 MW nos RESTRITOS — a usina estava em '
      + 'comissionamento e as horas livres eram as horas paradas. O corte de set/25 e calculado com '
      + 'potencial aprendido de out/25 em diante, entao supoe que a frota de setembro entregava como '
      + 'a de outubro, e ela nao entregava (melhor dia 1.978 contra 2.540 MWh). Tende a ficar ALTO.',
    parametros: { faixa_w_m2: FAIXA, quantil: QUANT, min_amostra: MIN_AMOSTRA,
      dias_excluidos: [...EXCLUI_DIA],
      janelas_dias: JANELAS, irr_min_w_m2: IRR_MIN, pool_inicio: POOL_INI },
    validacao, serie,
  };
  const t = await grava(out);
  console.log('\n' + OUT_BLOB + ' OK · ' + Math.round(t / 1024) + ' KB · ' + serie.length + ' meses');
  serie.forEach(s => console.log('  ' + s.mes + '  ' + String(s.corte_gwh).padStart(6) + ' GWh  '
    + String(s.corte_pct).padStart(5) + '%  ' + String(s.horas_restricao).padStart(6) + ' h  confianca '
    + s.confianca + '  (janela +-' + s.janela_mediana_dias + 'd, amostra ' + s.amostra_mediana + ')'));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
