/*
 * gen-trafo.js — os dois transformadores de forca da SE Mauriti -> dados/trafo_*.json
 *
 * A PERGUNTA QUE ELE RESPONDE: como estao carregados o 04T1 e o 04T2, ao longo do tempo, e com que
 * equilibrio entre fases. Sao os mesmos dois trafos da pagina de Oleo Isolante — que hoje diz a
 * saude do isolante e nao diz o esforco a que ele foi submetido.
 *
 * FONTE: `Trafo_<AAAAMMDD>_<HHMMSS>.csv` no container scada-raw, `;`, BOM, passo de 30 min.
 *
 * 🔴 O CONTAINER TEM DOIS TIPOS DE ARQUIVO Trafo, e escolher "o mais recente" ou "o maior" erra
 *   nos dois sentidos: ha UM despejo historico (7,1 MB, 365 dias, 12/08/2025 a 11/08/2026) e
 *   arquivos DIARIOS de ~27 KB que chegam todo dia as ~03:30. O historico esta congelado na data
 *   em que alguem o exportou; os diarios e que mantem a serie viva. Le-se TODOS e mescla-se por
 *   carimbo de tempo, o mais recente vencendo — igual ao gen-scada com as planilhas.
 *
 * 🔴 O DADO NAO ESTA NA COLUNA QUE O NOME SUGERE. O export repete o mesmo conjunto de tags em sete
 *   grupos (`IEC_61850`, `SE_MRT.[..].Measurements`, `MRT_Storage`) e MEDIDO em 25/08/2026 no
 *   despejo: 89 das 142 colunas estao VAZIAS — so os grupos `IEC_61850` tem dado, e as analogicas
 *   ora vem no `IEC_61850.URT1`, ora no `SE_MRT.[04T2].Measurements`. Entao a regra e a mesma do
 *   gen-inv-scada: para cada (trafo, grandeza) escolhe-se a coluna que REALMENTE tem valores.
 *   Fixar o grupo produziria um blob de campos nulos com rotulo certo.
 *
 * COMO OS PONTOS DE MEDICAO FORAM IDENTIFICADOS — pela FISICA, nunca pelo nome da tag. Uma tag
 *   `CMMXU1_A_phsA` diz "corrente do ponto 1" e nao diz se o ponto 1 e a alta ou a baixa tensao.
 *   Medido no despejo (mediana / maximo):
 *        VMMXU1 = 238 kV  -> barramento de 230 kV        VMMXU2 e VMMXU3 = 34,4 kV -> os dois
 *        CMMXU1 max 460 A -> lado de 230 kV                 enrolamentos de 34,5 kV
 *   E FECHA: raiz(3) x 238 kV x 460 A = 189,6 MVA contra VolAmp maximo de 187,5 — o que tambem
 *   estabelece que Watt/VolAmp/VolAmpr estao em MW/MVAr/MVA, e nao em W. Os dois secundarios
 *   somam 199 MVA contra 189,6 no primario, coerente com duas baixas alimentando um primario.
 *   Isso vira GUARDA la embaixo: se o layout do export mudar, o job fica vermelho em vez de
 *   publicar corrente de 34,5 kV rotulada como 230 kV.
 *
 * 🔴 O FATOR DE POTENCIA VEM COM O SINAL TROCADO em relacao a potencia. Medido: `Watt` vai a
 *   +187 MW gerando, e `PwrFact` no mesmo regime vai a -1,00, com maximo de apenas +0,51.
 *   Publicar o valor cru poria "FP -1,00" no pico de geracao, que le como pessimo sendo perfeito.
 *   Publica-se o MODULO; o sentido ja esta no sinal de `p_mw`.
 *
 * AS ANALOGICAS SAIRAM DA LISTA DE PONTOS OFICIAL DA SE — `ETX-24007-LP-HV-R1`, aba
 *   "Lista de Pontos". O CSV do supervisorio nao as identifica, e a assinatura do dado nao bastava:
 *        AnIn30 = TEMPERATURA OLEO TRANSFORMADOR (°C)
 *        AnIn31 = TEMPERATURA OLEO CDC (°C)          <- comutador sob carga, nao o tanque principal
 *        AnIn32 = TEMPERATURA ENROLAMENTO (°C)
 *        AnIn16 = POSICAO TAP (sem unidade)
 *   A mesma lista confirma, PALAVRA POR PALAVRA, a identificacao que eu havia derivado da fisica:
 *   `CMMXU1` = "CORRENTE LADO 230kV", `CMMXU2`/`CMMXU3` = "LADO 1X/2X 34,5kV", e Watt/VolAmp/
 *   VolAmpr em MW/MVA/MVAr. Duas rotas independentes no mesmo resultado.
 *
 * 🔴 ZERO EM TEMPERATURA NAO E MEDICAO — e sensor mudo. Sao transformadores em Mauriti, no Ceara;
 *   0,0 °C nunca acontece. Mantido como valor ele derruba media e mediana, e derrubaria de forma
 *   DESIGUAL entre os dois trafos: foi exatamente isso que quase me fez anunciar que o 04T1 corre
 *   20 °C mais quente que o 04T2. Vira nulo, e a contagem do descarte vai ao log e ao blob.
 *
 * ⚠️ O CARIMBO DE TEMPO E `dd/mm/aaaa HH:MM` no despejo, e os exports irmaos (IRR, IIRR) usam
 *   `aaaa-mm-dd HH:MM:SS`. O parser aceita as DUAS formas e RECUSA linha que nao case nenhuma —
 *   adivinhar aqui troca dia por mes calado nos doze primeiros dias de cada mes.
 *
 * ⚠️ DIVIDA DECLARADA: a borda do balde (se o rotulo marca o inicio ou o fim do intervalo) esta
 *   INDETERMINADA. O blob guarda o rotulo como a fonte entrega e declara isso em
 *   `rotulo_de_tempo`. Para resolver, o caminho e o mesmo do comparativo: varrer o deslocamento
 *   contra a potencia ja medida em `cmp_30min.json` e escolher pelo erro. Ate la, nenhum painel
 *   deste blob pode ser comparado instante a instante com outra fonte.
 *
 * Env: DADOS_STORAGE · RAW_CONTAINER=scada-raw · OUT_CONTAINER=dados
 *      LOCAL_DIR / LOCAL_OUT_DIR para ensaio sem segredo.
 */
const zlib = require('zlib');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const CARIMBO = /Trafo_(\d{8})_(\d{6})\.csv$/i;      // em QUALQUER posicao: o blob vem prefixado
const TRAFOS = ['04T1', '04T2'];

// As janelas saem do MESMO teto de ~8.700 linhas que dimensiona os blobs do MUST e do comparativo.
const RESOLUCOES = [{ min: 30, dias: 180 }, { min: 60, dias: 365 }];
const RES_FONTE = 30;                                 // o export e semi-horario

const num = (v) => {
  const s = String(v == null ? '' : v).trim().replace(',', '.');
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return isFinite(n) ? n : null;
};
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

// ---------- carimbo de tempo ------------------------------------------------------------------
// devolve o epoch em ms de Brasilia (UTC-3). Aceita as duas formas e so elas.
function epoch(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})[ T](\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]) + 3 * 3600e3;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 3 * 3600e3;
  return null;
}
const iso = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const diaDe = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

// ---------- quais colunas queremos -------------------------------------------------------------
// chave publicada -> pedaco que identifica a grandeza na tag, sem o grupo e sem o prefixo do trafo
const GRANDEZAS = {
  i1a: 'CMMXU1_A_phsA', i1b: 'CMMXU1_A_phsB', i1c: 'CMMXU1_A_phsC',   // 230 kV
  i2a: 'CMMXU2_A_phsA', i2b: 'CMMXU2_A_phsB', i2c: 'CMMXU2_A_phsC',   // 34,5 kV · enrolamento 1
  i3a: 'CMMXU3_A_phsA', i3b: 'CMMXU3_A_phsB', i3c: 'CMMXU3_A_phsC',   // 34,5 kV · enrolamento 2
  v1ab: 'VMMXU1_PPV_phsAB', v1bc: 'VMMXU1_PPV_phsBC', v1ca: 'VMMXU1_PPV_phsCA',
  v2ab: 'VMMXU2_PPV_phsAB', v2bc: 'VMMXU2_PPV_phsBC', v2ca: 'VMMXU2_PPV_phsCA',
  v3ab: 'VMMXU3_PPV_phsAB', v3bc: 'VMMXU3_PPV_phsBC', v3ca: 'VMMXU3_PPV_phsCA',
  p: 'CVMMXN1_Watt', q: 'CVMMXN1_VolAmpr', s: 'CVMMXN1_VolAmp', fp: 'CVMMXN1_PwrFact',
  // Nomes da LISTA DE PONTOS oficial da SE (ETX-24007-LP-HV-R1, aba "Lista de Pontos"), que e o
  // que resolveu as analogicas — o CSV do supervisorio nao as identifica.
  t_oleo: 'AnIn30_InstMag_f',       // TEMPERATURA OLEO TRANSFORMADOR · °C
  t_oleo_cdc: 'AnIn31_InstMag_f',   // TEMPERATURA OLEO CDC (comutador sob carga) · °C
  t_enrol: 'AnIn32_InstMag_f',      // TEMPERATURA ENROLAMENTO · °C
  tap: 'AnIn16_InstMag_f',          // POSICAO TAP · sem unidade
};
const TEMPS = ['t_oleo', 't_oleo_cdc', 't_enrol'];

// ---------- entrada ---------------------------------------------------------------------------
async function listaArquivos() {
  if (process.env.LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    return fs.readdirSync(process.env.LOCAL_DIR).filter((n) => CARIMBO.test(n))
      .map((n) => ({ nome: n, ler: async () => fs.readFileSync(path.join(process.env.LOCAL_DIR, n)) }));
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW_CONTAINER);
  const out = []; let total = 0;
  for await (const b of c.listBlobsFlat()) {
    total++;
    if (!CARIMBO.test(b.name)) continue;
    out.push({ nome: b.name, bytes: b.properties.contentLength || 0,
      ler: async () => c.getBlobClient(b.name).downloadToBuffer() });
  }
  // 🔴 a guarda diz o TOTAL, nao so o casado: "0 candidatos" sem denominador ja me fez concluir
  // que um arquivo nao existia quando o padrao e que estava errado.
  if (!out.length) throw new Error('nenhum Trafo_<data>_<hora>.csv em "' + RAW_CONTAINER
    + '" — 0 de ' + total + ' blob(s). A ponte SharePoint->blob esta copiando?');
  // ordena pelo CARIMBO do arquivo, nunca pelo nome inteiro: o prefixo e o id do item do
  // SharePoint, e ordenar por ele ordena por ordem de upload, que nao e ordem de conteudo.
  out.sort((a, b) => {
    const ma = a.nome.match(CARIMBO), mb = b.nome.match(CARIMBO);
    return (ma[1] + ma[2]) < (mb[1] + mb[2]) ? -1 : 1;
  });
  console.log('  container "' + RAW_CONTAINER + '": ' + total + ' blob(s) · '
    + out.length + ' arquivo(s) de trafo · '
    + Math.round(out.reduce((s, x) => s + x.bytes, 0) / 1048576) + ' MB');
  return out;
}

// ---------- um arquivo ------------------------------------------------------------------------
function leArquivo(buf, nome) {
  const txt = (buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf)
    .toString('utf8').replace(/^﻿/, '');
  const L = txt.split(/\r?\n/).filter((x) => x.length);
  if (L.length < 2) return { linhas: [], mapa: {}, recusadas: 0 };
  const cab = L[0].split(';').map((x) => x.trim());

  // candidatas por (trafo, grandeza) — QUALQUER grupo
  const cand = new Map();
  cab.forEach((c, i) => {
    for (const t of TRAFOS) {
      if (!c.includes(t)) continue;
      for (const [chave, pedaco] of Object.entries(GRANDEZAS)) {
        if (c.includes(pedaco)) {
          const k = t + '|' + chave;
          if (!cand.has(k)) cand.set(k, []);
          cand.get(k).push(i);
        }
      }
    }
  });

  const corpo = [];
  let recusadas = 0;
  for (let k = 1; k < L.length; k++) {
    const p = L[k].split(';');
    const ms = epoch(p[0]);
    if (ms == null) { recusadas++; continue; }
    corpo.push({ ms, p });
  }

  // 🔴 escolhe, para cada (trafo, grandeza), a coluna que TEM dado neste arquivo
  const mapa = {};
  for (const [k, idxs] of cand) {
    let melhor = null, melhorN = 0;
    for (const i of idxs) {
      let n = 0;
      for (const l of corpo) if (num(l.p[i]) != null) n++;
      if (n > melhorN) { melhorN = n; melhor = i; }
    }
    if (melhorN) mapa[k] = melhor;
  }
  // 🔴 NOMEIA o que faltou. "48/52" nao permite decidir nada: a serie so fica furada se o que
  // falta for coluna que importa, e um arquivo diario sem as temperaturas congela a serie de
  // temperatura no ultimo despejo — em silencio, porque as outras 48 continuam chegando.
  const esperadas = [];
  for (const t of TRAFOS) for (const k of Object.keys(GRANDEZAS)) esperadas.push(t + '|' + k);
  const faltam = esperadas.filter((k) => mapa[k] == null);
  console.log('    ' + nome.split('/').pop() + ': ' + corpo.length + ' linha(s) · '
    + Object.keys(mapa).length + '/' + esperadas.length + ' colunas com dado'
    + (faltam.length ? ' · SEM: ' + faltam.join(' ') : '')
    + (recusadas ? ' · ' + recusadas + ' linha(s) com carimbo irreconhecivel' : ''));
  return { linhas: corpo, mapa, recusadas };
}

// ---------- guardas de identidade --------------------------------------------------------------
// Confirmam, do proprio dado, que o ponto 1 e a ALTA e que as unidades sao kV/A/MVA. Se o export
// trocar de layout, o job fica VERMELHO em vez de publicar corrente de 34,5 kV chamada de 230 kV.
function confereFisica(serie) {
  for (const t of TRAFOS) {
    const cheias = serie.filter((r) => r[t] && r[t].s != null && r[t].i1a != null && r[t].v1ab != null);
    if (cheias.length < 100) throw new Error('trafo ' + t + ': so ' + cheias.length
      + ' instante(s) com S, I1 e V1 — nao da para conferir a identificacao dos pontos');
    // decil superior de carga: e onde a relacao vale, porque a vazio S e dominado por reativo
    const ord = cheias.slice().sort((a, b) => b[t].s - a[t].s).slice(0, Math.floor(cheias.length / 10));
    const erros = [], fps = [];
    for (const r of ord) {
      const o = r[t];
      const v = media([o.v1ab, o.v1bc, o.v1ca].filter((x) => x != null));
      const i = media([o.i1a, o.i1b, o.i1c].filter((x) => x != null));
      if (v == null || i == null || !o.s) continue;
      erros.push(Math.abs(Math.sqrt(3) * v * i / 1000 - o.s) / o.s);
      if (o.fp != null) fps.push(Math.abs(o.fp));
    }
    const err = media(erros);
    const fp = media(fps);
    console.log('  guarda ' + t + ': raiz(3)xV1xI1 contra S no decil de maior carga -> erro medio '
      + (err * 100).toFixed(1) + '% · |FP| medio ' + (fp == null ? '-' : fp.toFixed(3)));
    if (!(err < 0.12)) throw new Error('trafo ' + t + ': raiz(3)xV1xI1 diverge de S em '
      + (err * 100).toFixed(1) + '% no decil de maior carga. O ponto de medicao 1 deixou de ser a '
      + 'alta tensao, ou a unidade mudou — NAO publicar rotulo de 230 kV sobre isso.');
    if (fp != null && !(fp > 0.85)) throw new Error('trafo ' + t + ': |FP| medio de ' + fp.toFixed(3)
      + ' no decil de maior carga. Sob carga alta o fator de potencia tem de estar perto de 1; '
      + 'abaixo disso a coluna nao e cos(fi) e nao pode ser publicada como tal.');

    // TEMPERATURA: a grandeza foi confirmada pela operacao, entao a faixa vira guarda. Ela nao
    // diz qual sensor e qual — diz que continua sendo temperatura. Se a escala do transdutor
    // mudar (4-20 mA reescalado, por exemplo), o job fica vermelho em vez de publicar "1.480
    // graus" com rotulo certo.
    for (const k of TEMPS) {
      const vs = serie.map((r) => (r[t] || {})[k]).filter((x) => x != null);
      if (!vs.length) { console.log('  guarda ' + t + ' ' + k + ': sem dado'); continue; }
      const mx = Math.max(...vs), mn = Math.min(...vs);
      // 🔴 histograma da PONTA BAIXA. O filtro de zero exato nao basta: leituras de 0,04 °C
      // passam e sao tao impossiveis quanto o zero. Em vez de inventar um piso, mede-se onde o
      // dado se separa — se ha um vao entre o amontoado do sensor mudo e o dado de verdade,
      // qualquer piso dentro do vao e defensavel, e o numero sai da medicao.
      const faixas = [0, 2, 5, 10, 15, 20, 25];
      const h = faixas.map((f, n) => {
        const ate = faixas[n + 1] == null ? Infinity : faixas[n + 1];
        return f + '-' + (ate === Infinity ? '+' : ate) + ':' + vs.filter((v) => v >= f && v < ate).length;
      });
      console.log('  guarda ' + t + ' ' + k + ': ' + mn.toFixed(2) + ' a ' + mx.toFixed(1)
        + ' °C · mediana ' + media(vs).toFixed(1) + ' · ponta baixa ' + h.join(' '));
      if (mx > 130 || mn < -10) throw new Error('trafo ' + t + ' ' + k + ': faixa de ' + mn.toFixed(1)
        + ' a ' + mx.toFixed(1) + ' fora do que uma temperatura de transformador pode ser. '
        + 'A escala do transdutor mudou — nao publicar como °C.');
    }
  }
}

// ---------- saida -------------------------------------------------------------------------------
async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(process.env.LOCAL_OUT_DIR, nome), gz);
    return gz.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await c.createIfNotExists();
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

// ---------- principal ---------------------------------------------------------------------------
(async () => {
  const arqs = await listaArquivos();

  // mescla por carimbo de tempo; o arquivo mais NOVO vence, porque vem depois na ordem
  const porMs = new Map();
  let recusadasTotal = 0;
  const zeros = {};                      // (trafo|grandeza) -> quantas leituras de 0 °C foram descartadas
  for (const a of arqs) {
    const { linhas, mapa, recusadas } = leArquivo(await a.ler(), a.nome);
    recusadasTotal += recusadas;
    for (const l of linhas) {
      const reg = porMs.get(l.ms) || { ms: l.ms };
      for (const t of TRAFOS) {
        const o = reg[t] || {};
        for (const chave of Object.keys(GRANDEZAS)) {
          const j = mapa[t + '|' + chave];
          if (j == null) continue;
          let v = num(l.p[j]);
          // 🔴 ZERO EM TEMPERATURA NAO E MEDICAO. O transformador fica em Mauriti, no Ceara:
          // 0,0 °C e sensor mudo, nao dia frio. Mantido como valor, ele derruba media e mediana
          // — e derrubaria de forma DESIGUAL entre os dois trafos, fabricando uma diferenca de
          // temperatura que ninguem mediu. Vira nulo e e CONTADO, para a perda aparecer no blob
          // em vez de sumir.
          if (v === 0 && TEMPS.includes(chave)) { zeros[t + '|' + chave] = (zeros[t + '|' + chave] || 0) + 1; v = null; }
          if (v != null) o[chave] = v;
        }
        if (Object.keys(o).length) reg[t] = o;
      }
      porMs.set(l.ms, reg);
    }
  }
  const serie = [...porMs.values()].sort((a, b) => a.ms - b.ms);
  if (!serie.length) throw new Error('nenhuma linha aproveitada de ' + arqs.length + ' arquivo(s)');
  for (const [k, n] of Object.entries(zeros)) console.log('  descartado: ' + k + ' -> ' + n
    + ' leitura(s) de 0 °C (' + ((n / serie.length) * 100).toFixed(1) + '% da serie) — sensor mudo, nao medicao');
  console.log('  serie mesclada: ' + serie.length + ' instante(s) · '
    + iso(serie[0].ms) + ' a ' + iso(serie[serie.length - 1].ms)
    + (recusadasTotal ? ' · ' + recusadasTotal + ' linha(s) recusadas por carimbo' : ''));

  confereFisica(serie);

  // ---- arquivos por resolucao ----------------------------------------------------------------
  const ultimo = serie[serie.length - 1].ms;
  const meta = {
    gerado_em: new Date().toISOString(),
    trafos: TRAFOS,
    // ⚠️ ver a nota no cabecalho: a borda do balde nao foi determinada.
    rotulo_de_tempo: 'como a fonte entrega — borda do intervalo INDETERMINADA',
    unidades: { i: 'A', v: 'kV', p: 'MW', q: 'MVAr', s: 'MVA',
      fp: 'modulo de cos(fi), 0..1', t_oleo: '°C', t_oleo_cdc: '°C', t_enrol: '°C', tap: 'degrau' },
    pontos: { 1: 'lado 230 kV', 2: 'lado 1X 34,5 kV', 3: 'lado 2X 34,5 kV' },
    rotulos: { t_oleo: 'temperatura do óleo do transformador',
      t_oleo_cdc: 'temperatura do óleo do comutador sob carga',
      t_enrol: 'temperatura do enrolamento', tap: 'posição do tap' },
    fonte_dos_nomes: 'lista de pontos da subestação',
    // leituras de 0 °C descartadas por grandeza e por trafo — sensor mudo, nao dia frio
    temperaturas_descartadas: zeros,
  };
  const saidas = [];
  for (const { min, dias } of RESOLUCOES) {
    if (min < RES_FONTE) continue;                    // passo mais fino que a fonte nao se inventa
    const corte = ultimo - (dias - 1) * 86400e3;
    const baldes = new Map();
    for (const r of serie) {
      if (r.ms < corte) continue;
      const b = Math.floor(r.ms / (min * 60e3)) * (min * 60e3);
      if (!baldes.has(b)) baldes.set(b, []);
      baldes.get(b).push(r);
    }
    const linhas = [...baldes.entries()].sort((a, b) => a[0] - b[0]).map(([b, rs]) => {
      const o = { ms: b, t: iso(b) };
      for (const t of TRAFOS) {
        for (const chave of Object.keys(GRANDEZAS)) {
          const vs = rs.map((r) => (r[t] || {})[chave]).filter((x) => x != null);
          if (!vs.length) continue;
          // FP vai em MODULO: a fonte o entrega negativo exportando (ver o cabecalho)
          o[t + '_' + chave] = r2(chave === 'fp' ? media(vs.map(Math.abs)) : media(vs));
        }
      }
      return o;
    });
    const nome = 'trafo_' + min + 'min.json';
    const bytes = await grava(nome, { ...meta, resolucao_min: min,
      janela_dias: new Set(linhas.map((l) => diaDe(l.ms))).size, janela_dias_alvo: dias, serie: linhas });
    saidas.push(nome + ': ' + linhas.length + ' linhas · ' + Math.round(bytes / 1024) + ' KB');
  }

  // ---- diario: a serie inteira, com pico e media ---------------------------------------------
  const porDia = new Map();
  for (const r of serie) {
    const d = diaDe(r.ms);
    if (!porDia.has(d)) porDia.set(d, []);
    porDia.get(d).push(r);
  }
  const diario = [...porDia.entries()].sort().map(([d, rs]) => {
    const o = { dia: d, ms: Date.parse(d + 'T00:00:00Z') + 3 * 3600e3, n: rs.length };
    for (const t of TRAFOS) {
      const s = rs.map((r) => (r[t] || {}).s).filter((x) => x != null);
      const p = rs.map((r) => (r[t] || {}).p).filter((x) => x != null);
      if (s.length) { o[t + '_s_max'] = r2(Math.max(...s)); o[t + '_s_med'] = r2(media(s)); }
      if (p.length) { o[t + '_p_max'] = r2(Math.max(...p)); o[t + '_p_med'] = r2(media(p)); }
      // desequilibrio de corrente no lado de 230 kV: (max-min)/media entre as tres fases, em %
      const des = [];
      for (const r of rs) {
        const f = [(r[t] || {}).i1a, (r[t] || {}).i1b, (r[t] || {}).i1c].filter((x) => x != null);
        if (f.length !== 3) continue;
        const m = media(f);
        if (m > 20) des.push(((Math.max(...f) - Math.min(...f)) / m) * 100);   // a vazio nao diz nada
      }
      if (des.length) { o[t + '_deseq_max'] = r2(Math.max(...des)); o[t + '_deseq_med'] = r2(media(des)); }
      // temperatura: o PICO do dia e o que interessa a vida do isolante, e e o que cruza com a
      // pagina de Oleo — a media esconde justamente a hora quente.
      for (const k of TEMPS) {
        const vs = rs.map((r) => (r[t] || {})[k]).filter((x) => x != null);
        if (!vs.length) continue;
        o[t + '_' + k + '_max'] = r2(Math.max(...vs));
        o[t + '_' + k + '_med'] = r2(media(vs));
      }
    }
    return o;
  });
  const bd = await grava('trafo_diario.json', { ...meta, resolucao: 'dia',
    janela_dias: diario.length, serie: diario });
  saidas.push('trafo_diario.json: ' + diario.length + ' dias · ' + Math.round(bd / 1024) + ' KB');

  for (const s of saidas) console.log('  ' + s);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
