/*
 * gen-ons-consolidado.js — junta os arquivos mensais do ONS num único _all.json (histórico completo).
 *
 * Lê ons_restricao_YYYY_MM.json e ons_irradiancia_YYYY_MM.json (blob público, sem chave)
 * de Set/2025 até o mês atual, concatena os `consolidado`, deduplica, ordena, e grava:
 *   - dados/ons_restricao_all.json    (1 linha por ts; campos ts,ger,lim,disp,gref,razao,orig,dsc)
 *   - dados/ons_irradiancia_all.json  (1 linha por ts+u; enxugado: ts,u,irr,ge,gv)
 *
 * Uso no GitHub Actions: env DADOS_STORAGE (connection string) grava no blob.
 * Teste local: env LOCAL_OUT_DIR=<pasta> grava os arquivos localmente em vez do blob.
 */
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const START_Y = 2025, START_M = 9; // Set/2025 = entrada em operação

function months() {
  const now = new Date();
  const ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1;
  const out = [];
  let y = START_Y, m = START_M;
  while (y < ny || (y === ny && m <= nm)) {
    out.push(y + '_' + String(m).padStart(2, '0'));
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

async function fetchJson(url) {
  const r = await fetch(url + '?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) return null;
  let t = await r.text();
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  try { return JSON.parse(t); } catch (e) { return null; }
}

function num(v) { const n = +v; return isNaN(n) ? 0 : n; }

async function upload(name, json) {
  if (process.env.LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(process.env.LOCAL_OUT_DIR, name), json);
    return;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE não definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  const bc = cont.getBlockBlobClient(name);
  await bc.upload(json, Buffer.byteLength(json), { blobHTTPHeaders: { blobContentType: 'application/json' } });
}

// Consolida uma fonte. slim = função opcional que enxuga/normaliza cada linha.
async function consolidate({ prefix, out, dedup, slim, sortKey }) {
  const rows = [], seen = new Set(), okMonths = [];
  for (const ym of months()) {
    const d = await fetchJson(BASE + prefix + ym + '.json');
    if (!d || !Array.isArray(d.consolidado)) continue;
    okMonths.push(ym);
    for (const r of d.consolidado) {
      const k = dedup(r);
      if (seen.has(k)) continue;
      seen.add(k);
      rows.push(slim ? slim(r) : r);
    }
  }
  if (!rows.length) { console.warn(out, '— nenhum dado, pulado.'); return []; }
  rows.sort(sortKey);
  const obj = {
    fonte: prefix.replace(/_$/, ''),
    periodo: okMonths[0] + ' a ' + okMonths[okMonths.length - 1],
    consolidado: rows
  };
  const json = JSON.stringify(obj);
  await upload(out, json);
  console.log(`${out}: ${rows.length} linhas, ${okMonths.length} meses (${okMonths[0]}..${okMonths[okMonths.length - 1]}), ${(Buffer.byteLength(json) / 1048576).toFixed(2)} MB`);
  return rows;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ons_kpis.json — KPIs pré-calculados do complexo (faixa do cabeçalho).
 *
 * POR QUE: o cabeçalho do Grafana (10 páginas) precisa desses números. Ler o
 * ons_restricao_all.json (~14 mil linhas) em cada painel derrubaria o backend
 * (foi a causa do "No data"). Este arquivo tem < 1 KB e é o mesmo dado.
 *
 * FÓRMULAS (idênticas às do index.html · renderONSKpis) — intervalos de 30 min,
 * potência em MW → energia = MW × 0,5 h:
 *   gerados    = Σ(ger  × 0,5) / 1000                                    [GWh]
 *   referencia = Σ(gref × 0,5) / 1000                                    [GWh]
 *   frustrados = Σ max(0, (gref − ger) × 0,5) / 1000, só onde lim > 0    [GWh]
 *   restricoes = nº de intervalos com lim > 0
 *   duracao_h  = restricoes × 0,5
 *   pr         = gerados / referencia × 100                              [%]
 *   razoes     = frustrada rateada por cod_razaorestricao (ENE/CNF/REL)
 *   origens    = idem por cod_origemrestricao (SIS/LOC)
 * ──────────────────────────────────────────────────────────────────────────── */
const CAP_MW = 343.77;   // outorga do complexo
const H = 0.5;           // duração do intervalo ONS (30 min)

async function gerarKpis(rows) {
  if (!rows.length) { console.warn('ons_kpis.json — sem dados, pulado.'); return; }
  const ger = r => num(r.ger != null ? r.ger : r.val_geracao);
  const lim = r => num(r.lim != null ? r.lim : r.val_geracaolimitada);
  const gref = r => num(r.gref != null ? r.gref : r.val_geracaoreferencia);
  const disp = r => num(r.disp != null ? r.disp : r.val_disponibilidade);
  const cod = (v) => String(v || '').trim().toUpperCase() || 'N/D';

  let mwhGer = 0, mwhRef = 0, mwhFru = 0, somaDisp = 0, nRest = 0, ultimo = '';
  const razoes = {}, origens = {};
  const bump = (mapa, chave, mwh) => {
    const o = mapa[chave] || (mapa[chave] = { gwh: 0, intervalos: 0, pct: 0 });
    o.gwh += mwh; o.intervalos++;
  };

  for (const r of rows) {
    mwhGer += ger(r) * H;
    mwhRef += gref(r) * H;
    somaDisp += disp(r);
    if (r.ts > ultimo) ultimo = r.ts;
    if (lim(r) > 0) {
      nRest++;
      const perda = Math.max(0, (gref(r) - ger(r)) * H);   // MWh perdidos no intervalo
      mwhFru += perda;
      bump(razoes, cod(r.razao != null ? r.razao : r.cod_razaorestricao), perda);
      bump(origens, cod(r.orig != null ? r.orig : r.cod_origemrestricao), perda);
    }
  }
  // MWh → GWh e fatia % de cada razão/origem sobre a energia frustrada total
  const fmt = (mapa) => {
    for (const k of Object.keys(mapa)) {
      mapa[k].gwh = +(mapa[k].gwh / 1000).toFixed(2);
      mapa[k].pct = mwhFru > 0 ? +(mapa[k].gwh * 1000 / mwhFru * 100).toFixed(1) : 0;
    }
    return mapa;
  };

  const kpis = {
    atualizado: new Date().toISOString(),
    ultimo_dado: ultimo,
    intervalos: rows.length,
    outorga_mw: CAP_MW,
    gerados_gwh: +(mwhGer / 1000).toFixed(1),
    referencia_gwh: +(mwhRef / 1000).toFixed(1),
    frustrados_gwh: +(mwhFru / 1000).toFixed(1),
    restricoes: nRest,
    duracao_h: +(nRest * H).toFixed(0),
    pr_pct: mwhRef > 0 ? +(mwhGer / mwhRef * 100).toFixed(1) : 0,
    disponibilidade_pct: +(somaDisp / rows.length / CAP_MW * 100).toFixed(1),
    razoes: fmt(razoes),
    origens: fmt(origens),
  };

  // tiles[] pré-formatados (PT-BR) p/ a faixa de KPIs do cabeçalho (card Business Text).
  // g='e' KPIs de energia · g='r' restrição POR TIPO (ENE/CNF/REL, % da energia frustrada).
  // ponto decimal + ponto de milhar; 2 casas nas MEDIDAS (MW/GWh/%), inteiro nas CONTAGENS (padrão do usuário 2026-07-16)
  const fmtDot = (n, dec) => { const s = Number(n || 0).toFixed(dec); const [i, f] = s.split('.'); const im = i.replace(/\B(?=(\d{3})+(?!\d))/g, '.'); return f ? im + '.' + f : im; };
  const rz = (k) => kpis.razoes[k] || { pct: 0, gwh: 0 };
  kpis.tiles = [
    { l: 'Outorga', v: fmtDot(kpis.outorga_mw, 2), u: 'MW', g: 'e', t: 'Capacidade outorgada do complexo' },
    { l: 'Gerado', v: fmtDot(kpis.gerados_gwh, 2), u: 'GWh', g: 'e', t: 'Energia verificada ONS no período' },
    { l: 'Frustrado', v: fmtDot(kpis.frustrados_gwh, 2), u: 'GWh', g: 'e', t: 'Energia perdida por restrição ONS' },
    // "4.808" sozinho era ambíguo: em pt-BR o ponto lê-se como decimal, e o número aparecia sem
    // unidade ao lado de outros com MW/GWh/h. Agora diz o que conta.
    { l: 'Restrições', v: fmtDot(kpis.restricoes, 0), u: 'eventos', g: 'e', t: 'Intervalos de 30 min com limite ativo' },
    { l: 'Duração', v: fmtDot(kpis.duracao_h, 0), u: 'h', g: 'e', t: 'Horas totais sob restrição' },
    // ENE/CNF/REL são os códigos do ONS, e sozinhos não dizem nada a quem lê o painel — a
    // explicação estava só no tooltip, e executivo não passa o mouse. O rótulo passa a trazer o
    // significado; a sigla fica entre parênteses para quem cruza com o relatório do ONS.
    // NOMES OFICIAIS DAS RAZOES (03/08/2026). O arquivo do ONS publica so o codigo e a descricao do
    // evento; o significado das siglas veio da documentacao do ONS. A leitura anterior era inferida
    // do campo `dsc_restricao` e estava errada num ponto importante: eu tinha concluido que "CNF e
    // REL nao se distinguem, leia os dois somados" porque as descricoes se pareciam. Elas se parecem,
    // mas as razoes sao distintas:
    //   ENE -> Razao Energetica: controle de frequencia no SIN (geracao demais, frequencia sobe)
    //   CNF -> Confiabilidade Eletrica: corte por LIMITACOES OPERATIVAS da rede
    //   REL -> Restricao Eletrica: INDISPONIBILIDADE EXTERNA (equipamento de terceiro fora)
    // O que continua valendo: nenhuma das tres aponta para a operacao do ativo, e o que separa
    // sistemico de local e a coluna de ORIGEM (SIS x LOC), nao o codigo de razao.
    { l: 'Razão Energética (ENE)', v: fmtDot(rz('ENE').pct, 2), u: '%', g: 'r', sep: 1, t: fmtDot(rz('ENE').gwh, 2) + ' GWh — controle de frequência no SIN: há geração demais no sistema e a frequência sobe, então o corte é para equilibrar carga. O ONS registra invariavelmente "Controle de frequência do SIN"' },
    { l: 'Confiabilidade Elétrica (CNF)', v: fmtDot(rz('CNF').pct, 2), u: '%', g: 'r', t: fmtDot(rz('CNF').gwh, 2) + ' GWh — corte motivado por limitações operativas da rede: carregamento de linha ou transformador, limite de fluxo entre subsistemas' },
    { l: 'Restrição Elétrica (REL)', v: fmtDot(rz('REL').pct, 2), u: '%', g: 'r', t: fmtDot(rz('REL').gwh, 2) + ' GWh — indisponibilidade externa: um equipamento de terceiro fora de operação limita o escoamento' },
  ];

  // ---- PRÉ-COD: entra como TILE, não como HTML colado no cabeçalho ----
  // Os KPIs acima vêm do ONS, que só publica a partir do COD — a fase de comissionamento fica de
  // fora deles. O item do pré-COD existia no cabeçalho com os números ESCRITOS À MÃO no HTML, e já
  // apodreceu uma vez: dizia 304,22 GWh, virou 301,32 quando o backfill do somaPos corrigiu a
  // líquida, e o cabeçalho seguiu mostrando o valor velho. Agora é dado — gerado vem do
  // executivo.json, cortado e horas vêm do arquivo congelado da apuração.
  // `pc:1` marca o tile para o template desenhá-lo diferente; flag como 1/'' porque no Handlebars
  // a string "false" é TRUTHY.
  try {
    const PC = require('../data/pre_cod_razoes.json');
    const exec = await fetchJson(BASE + 'executivo.json');
    const ger = exec && exec.totais_vida && exec.totais_vida.pre_cod_gwh;
    if (ger && PC && PC.pre_cod) {
      const cor = PC.pre_cod.total_gwh, hs = PC.pre_cod.horas_sinapse;
      // Horas levam 1 casa e passam de mil: com ponto de milhar sairia "1.201.6", ilegível — os dois
      // pontos significam coisas diferentes no mesmo número. Medida com decimal acima de mil vai SEM
      // separador de milhar. (O `fmtDot` segue certo onde é contagem inteira: "5.102 eventos".)
      const fmtH = (n) => Number(n || 0).toFixed(1);
      kpis.pre_cod = { gerado_gwh: ger, cortado_gwh: cor, horas: hs, revisao: PC._revisao };
      kpis.tiles.push({ l: 'Pré-COD · comissionamento', v: fmtDot(ger, 2), u: 'GWh', g: 'p', pc: 1,
        v2: fmtDot(cor, 2), u2: 'GWh', h: fmtH(hs),
        t: 'COMISSIONAMENTO (pré-COD), 21/jan a 21/nov/2025 — antes da operação comercial. '
         + 'GERADO ' + fmtDot(ger, 2) + ' GWh: energia líquida medida pelo Way2 (medidor de faturamento). '
         + 'CORTADO ' + fmtDot(cor, 2) + ' GWh: é ESTIMATIVA, faixa de ±15% — a Sinapse registra a ocorrência '
         + 'mas não traz geração de referência, então a energia frustrada é reconstruída pela irradiância medida '
         + 'e pela capacidade em teste (apuração ' + PC._revisao + ', ' + PC._emissao + '). '
         + 'As ' + fmtH(hs) + ' h de restrição vêm da Sinapse (Iqony). '
         + 'Os KPIs à esquerda são do ONS, que só publica a partir do COD, e por isso NÃO incluem nada disto. '
         + 'O detalhe mês a mês está na seção DESDE O INÍCIO.' });
      console.log('  PRÉ-COD .......... ' + fmtDot(ger, 2) + ' GWh gerado · ' + fmtDot(cor, 2)
        + ' GWh cortado (est. ±15%) · ' + fmtH(hs) + ' h');
    } else {
      console.log('  pré-COD: tile OMITIDO (executivo.json sem totais_vida, ou data/pre_cod_razoes.json ausente)');
    }
  } catch (e) {
    // Um cabeçalho sem o item do pré-COD é melhor que um cabeçalho quebrado.
    console.log('  pré-COD: tile OMITIDO — ' + e.message);
  }

  const json = JSON.stringify(kpis, null, 1);
  await upload('ons_kpis.json', json);
  console.log('\nons_kpis.json (' + Buffer.byteLength(json) + ' B) — dado até ' + ultimo);
  console.log('  OUTORGA .......... ' + kpis.outorga_mw + ' MW');
  console.log('  GERADOS .......... ' + kpis.gerados_gwh + ' GWh');
  console.log('  REFERÊNCIA ....... ' + kpis.referencia_gwh + ' GWh');
  console.log('  FRUSTRADOS ....... ' + kpis.frustrados_gwh + ' GWh');
  console.log('  RESTRIÇÕES ONS ... ' + kpis.restricoes.toLocaleString('pt-BR'));
  console.log('  DURAÇÃO .......... ' + kpis.duracao_h.toLocaleString('pt-BR') + ' h');
  console.log('  PR ............... ' + kpis.pr_pct + ' %');
  console.log('  DISPONIBILIDADE .. ' + kpis.disponibilidade_pct + ' %');
  console.log('  RAZÕES ...........',
    Object.entries(kpis.razoes).map(([k, v]) => k + ' ' + v.pct + '% (' + v.gwh + ' GWh)').join(' · '));
  console.log('  ORIGENS ..........',
    Object.entries(kpis.origens).map(([k, v]) => k + ' ' + v.pct + '% (' + v.gwh + ' GWh)').join(' · '));
}

(async () => {
  // ANTES de consolidar, repara mês cujo blob ficou com dia faltando. O fluxo que grava os blobs
  // mensais só toca no mês corrente e para às 23:00 UTC do último dia — antes de o ONS publicar
  // esse dia. Sem isto, o último dia de CADA mês se perde para sempre (jun/26 e jul/26 perderam).
  // Consolidar dados furados só espalharia o furo, então o reparo vem primeiro.
  console.log('Reparo de meses incompletos:');
  try {
    const { repararMeses } = require('./repara-ons-mes.js');
    await repararMeses(fetchJson, upload, BASE, months());
  } catch (e) {
    console.warn('  reparo falhou (' + e.message + ') — segue com os blobs como estão');
  }
  console.log('');

  // Restrição: 1 linha por ts (nível complexo)
  const restr = await consolidate({
    prefix: 'ons_restricao_',
    out: 'ons_restricao_all.json',
    dedup: r => r.ts,
    sortKey: (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0)
  });
  // KPIs do cabeçalho (arquivo leve, derivado das MESMAS linhas)
  await gerarKpis(restr);
  // Irradiância: 1 linha por ts+u (por UFV); enxuga (tira inv, arredonda) p/ reduzir tamanho
  await consolidate({
    prefix: 'ons_irradiancia_',
    out: 'ons_irradiancia_all.json',
    dedup: r => r.ts + '|' + r.u,
    slim: r => ({ ts: r.ts, u: r.u, irr: Math.round(num(r.irr)), ge: +num(r.ge).toFixed(3), gv: +num(r.gv).toFixed(3) }),
    sortKey: (a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : (a.u < b.u ? -1 : a.u > b.u ? 1 : 0))
  });
})().catch(e => { console.error(e); process.exit(1); });
