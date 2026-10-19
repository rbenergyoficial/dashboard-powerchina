'use strict';
/*
 * lib-estacao-30min.js — a SOLARIMETRIA do datalogger das estacoes (CR1000X, CSIXML de 10 min) em meia hora, para todas as grandezas
 * que a pagina de Solarimetria, a Visao Executiva e o PR leem (19/10/2026, lote fonte-pr-logger).
 *
 * Regra do humano (19/10/2026): a irradiancia vem do datalogger das estacoes (10 min ja integralizado = media do intervalo); o SCADA
 * (export PV_WS_TR, amostra instantanea a cada 30 min, parado desde 14/10) fica so para o Comparativo de Medicoes.
 *
 * A MEIA HORA (rotulo no INICIO T) sai dos registros de 10 min rotulados T+10, T+20 e T+30 (o datalogger rotula o FIM), os TRES
 * presentes e com valor naquela grandeza (tudo-ou-nada por grandeza): a mesma regra da lib-estacao-logger, que faz a irradiancia no
 * plano do `estacao_logger_30min.json`. Agregacao, pela natureza do campo do datalogger:
 *   media   os campos `_Avg` (media de 10 min): a meia hora e a MEDIA das tres medias, que e a media do intervalo inteiro. Nada de
 *           trapezio: o trapezio T/T+30 so vale para AMOSTRA instantanea (o SCADA), e aplicado a uma media desloca a curva 15 min;
 *   soma    `Precip_Tot` (mm acumulados em 10 min): a meia hora e a SOMA dos tres;
 *   min     `batt_volt_Min` (minimo de 10 min): a meia hora e o MENOR dos tres;
 *   vetor   `WD_Avg` (direcao, graus, 0 = norte): media VETORIAL ponderada pela velocidade `WS_Avg` (a media aritmetica de 350 e 10
 *           daria 180); sem velocidade nos tres, a media dos vetores unitarios.
 *
 * O valor vai CRU (so NaN, vazio e infinito viram nulo): a faixa fisica de cada grandeza e aplicada por quem le (gen-irradiancia,
 * com a faixa dela, que separa o agregado limpo do bruto e conta o que escapou).
 *
 * ESCALA (medido em 19/10/2026, M2, 10/10/2026, hora a hora contra o export do SCADA): as celulas de sujeira (`Irr_Soil_Sens*_Avg`
 * e `_loss_Avg`) vem do datalogger em DECIMOS de ponto percentual — 983 e 17,2 onde o SCADA publica 98,3 e 1,72. O campo publicado
 * da solarimetria segue a unidade que as telas ja leem (%): ESCALA 0,1. As outras grandezas tem a mesma unidade nas duas fontes.
 */
const LOG = require('./lib-estacao-logger');

// chave publicada (o nome do campo do gen-irradiancia), campo do datalogger, agregacao, casas, grandeza do gen-irradiancia
const CAMPOS = [
  ['gti', 'Irr_Tilted_1_Avg', 'media', 1, 'IRRADIAÇÃO INCLINADA'],
  ['dif', 'Irr_Difuse_Avg', 'media', 1, 'IRRADIAÇÃO DIFUSA'],
  ['dni', 'Irr_Direct_Avg', 'media', 1, 'IRRADIAÇÃO DIRETA'],
  ['alb_cima', 'Irr_Up_Avg', 'media', 1, 'IRRADIAÇÃO ALBEDO DE CIMA'],
  ['alb_baixo', 'Irr_Down_Avg', 'media', 1, 'IRRADIAÇÃO ALBEDO DE BAIXO'],
  ['albedo', 'ALBEDO_Avg', 'media', 3, 'TAXA DE ALBEDO'],
  ['t_mod1', 'TempPanel1_Avg', 'media', 2, 'TEMPERATURA MÓDULO 1'],
  ['t_mod2', 'TempPanel2_Avg', 'media', 2, 'TEMPERATURA MÓDULO 2'],
  ['t_mod3', 'TempPanel3_Avg', 'media', 2, 'TEMPERATURA MÓDULO 3'],
  ['t_mod4', 'TempPanel4_Avg', 'media', 2, 'TEMPERATURA MÓDULO 4'],
  ['t_amb', 'AmbTemp_Avg', 'media', 2, 'TEMPERATURA AMBIENTE'],
  ['t_int', 'PTemp_Avg', 'media', 2, 'TEMPERATURA INTERNA'],
  ['umid', 'RelH_Avg', 'media', 2, 'UMIDADE RELATIVA DO AR'],
  ['t_orvalho', 'DEW_Point_Avg', 'media', 2, 'PONTO DE CONDENSAÇÃO'],
  ['vento', 'WS_Avg', 'media', 2, 'VELOCIDADE VENTO'],
  ['vento_dir', 'WD_Avg', 'vetor', 1, 'DIREÇÃO VENTO'],
  ['chuva', 'Precip_Tot', 'soma', 2, 'PRECIPITAÇÃO'],
  ['suj1', 'Irr_Soil_Sens1_Avg', 'media', 2, 'SENSOR DE SUJEIRA 1'],
  ['suj2', 'Irr_Soil_Sens2_Avg', 'media', 2, 'SENSOR DE SUJEIRA 2'],
  ['perda_suj1', 'Irr_Soil_Sens1_loss_Avg', 'media', 2, 'TAXA DE PERDA POR SUJEIRA 1'],
  ['perda_suj2', 'Irr_Soil_Sens2_loss_Avg', 'media', 2, 'TAXA DE PERDA POR SUJEIRA 2'],
  ['bateria', 'batt_volt_Min', 'min', 2, 'TENSÃO DA BATERIA'],
];
const ESCALA = { suj1: 0.1, suj2: 0.1, perda_suj1: 0.1, perda_suj2: 0.1 };
const CHAVES = CAMPOS.map((c) => c[0]);
const GRANDEZA = Object.fromEntries(CAMPOS.map((c) => [c[0], c[4]]));
const DEC = Object.fromEntries(CAMPOS.map((c) => [c[0], c[3]]));
const AGREGA = Object.fromEntries(CAMPOS.map((c) => [c[0], c[2]]));

/* CSIXML -> [[instante do FIM 'YYYY-MM-DDTHH:MM', {chave: valor|null}], ...]. Campo faltando estoura com o nome (tudo-ou-nada por
   arquivo: um arquivo sem um campo nao entra pela metade). O campo e lido PELO NOME do cabecalho, nunca pela posicao. */
function le10(txt, onde) {
  const nomes = []; const reF = /<field name="([^"]+)"/g; let m;
  while ((m = reF.exec(txt))) nomes.push(m[1]);
  const ix = CAMPOS.map(([k, c]) => { const i = nomes.indexOf(c); if (i < 0) throw new Error((onde || 'arquivo') + ': campo ' + c + ' ausente'); return i + 1; });
  if (nomes.indexOf('WS_Avg') < 0) throw new Error((onde || 'arquivo') + ': campo WS_Avg ausente');
  const iWs = nomes.indexOf('WS_Avg') + 1;
  const out = [];
  const reR = /<r time="(\d{4}-\d\d-\d\dT\d\d:\d\d)(?::\d\d)?"[^>]*>([\s\S]*?)<\/r>/g;
  while ((m = reR.exec(txt))) {
    const vs = {}; const reV = /<v(\d+)>([^<]*)<\/v\d+>/g; let v;
    while ((v = reV.exec(m[2]))) vs[v[1]] = v[2];
    const o = {};
    const num = (s) => (s == null || s === '' || /nan|inf/i.test(s) ? null : (Number.isFinite(Number(s)) ? Number(s) : null));
    CAMPOS.forEach(([k], j) => { o[k] = num(vs[ix[j]]); });
    o._ws = num(vs[iWs]);   // o peso da media vetorial da direcao
    out.push([m[1], o]);
  }
  return out;
}

// o arredondamento e o do estacao_logger_30min (toFixed), para a irradiancia no plano sair igual nos dois produtos
const rd = (x, k) => (x == null || !Number.isFinite(x) ? null : +x.toFixed(k));

/* registros de 10 min de UMA estacao (iteravel de [instante do FIM, {chave: valor}], o primeiro visto de cada instante ja escolhido
   por quem chama) -> Map(inicio da meia hora 'YYYY-MM-DDTHH:MM' -> {chave: valor|null}), so as meias horas com ao menos uma
   grandeza. Por grandeza: os tres registros (posicoes 0, 10 e 20 min) presentes e com valor; senao nulo. */
function meias(regs) {
  const g = new Map();
  for (const [t, o] of regs) {
    const ini = LOG.minutos(t) - 10;
    const T = ini - (((ini % 30) + 30) % 30);
    const pos = (ini - T) / 10;   // 0, 1 ou 2
    const a = g.get(T) || { r: [null, null, null] };
    if (!a.r[pos]) a.r[pos] = o;   // o primeiro visto fica (o mesmo criterio de quem junta os arquivos)
    g.set(T, a);
  }
  const out = new Map();
  for (const [T, a] of g) {
    const res = {}; let algum = false;
    for (const k of CHAVES) {
      const v = a.r.map((o) => (o ? o[k] : null));
      if (v.some((x) => x == null)) { res[k] = null; continue; }
      let x;
      if (AGREGA[k] === 'soma') x = v[0] + v[1] + v[2];
      else if (AGREGA[k] === 'min') x = Math.min(v[0], v[1], v[2]);
      else if (AGREGA[k] === 'vetor') {
        const w = a.r.map((o) => (o && o._ws != null && o._ws > 0 ? o._ws : 0)), sw = w[0] + w[1] + w[2];
        const pw = sw > 0 ? w : [1, 1, 1];
        let vx = 0, vy = 0; v.forEach((ang, i) => { vx += pw[i] * Math.sin(ang * Math.PI / 180); vy += pw[i] * Math.cos(ang * Math.PI / 180); });
        x = vx || vy ? (Math.atan2(vx, vy) * 180 / Math.PI + 360) % 360 : null;
      } else x = (v[0] + v[1] + v[2]) / 3;
      if (x != null && ESCALA[k]) x *= ESCALA[k];
      res[k] = rd(x, DEC[k]);
      if (res[k] != null) algum = true;
    }
    if (algum) out.set(LOG.instante(T), res);
  }
  return out;
}

/* as meias horas de cada estacao -> o produto colunar `estacao_tudo_30min.json`: uma grade unica de meia hora (do primeiro ao ultimo
   instante visto em qualquer estacao), e por estacao e grandeza um vetor alinhado a ela (nulo onde nao ha meia hora inteira). */
function colunar(porEstacao) {
  let ini = null, fim = null;
  for (const mh of porEstacao.values()) for (const t of mh.keys()) { if (!ini || t < ini) ini = t; if (!fim || t > fim) fim = t; }
  if (!ini) return { inicio: null, n: 0, estacoes: {} };
  const m0 = LOG.minutos(ini), n = (LOG.minutos(fim) - m0) / 30 + 1;
  const estacoes = {};
  for (const [u, mh] of [...porEstacao].sort((a, b) => a[0] - b[0])) {
    const col = Object.fromEntries(CHAVES.map((k) => [k, new Array(n).fill(null)]));
    for (const [t, o] of mh) { const i = (LOG.minutos(t) - m0) / 30; for (const k of CHAVES) col[k][i] = o[k]; }
    estacoes['M' + u] = col;
  }
  return { inicio: ini, n, estacoes };
}

/* o produto colunar -> linhas por estacao e instante: [{ ts: 'YYYY-MM-DD HH:MM:00' (inicio), ufv: 'Mn', v: {chave: valor} }], so as
   meias horas que a estacao tem dentro do seu primeiro e ultimo instante com dado (antes de a estacao reportar nao ha linha) */
function linhas(prod) {
  const out = [];
  if (!prod || !prod.inicio) return out;
  const m0 = LOG.minutos(prod.inicio);
  for (const [u, col] of Object.entries(prod.estacoes || {})) {
    let a = -1, b = -1;
    for (let i = 0; i < prod.n; i++) if (CHAVES.some((k) => col[k] && col[k][i] != null)) { if (a < 0) a = i; b = i; }
    for (let i = a; a >= 0 && i <= b; i++) {
      const v = {}; for (const k of CHAVES) v[k] = col[k] ? col[k][i] : null;
      out.push({ ts: LOG.instante(m0 + 30 * i).replace('T', ' ') + ':00', ufv: u, v });
    }
  }
  return out;
}

module.exports = { CAMPOS, CHAVES, GRANDEZA, AGREGA, ESCALA, le10, meias, colunar, linhas };
