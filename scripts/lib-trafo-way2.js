'use strict';
/*
 * lib-trafo-way2.js — o lado de 230 kV dos dois transformadores pelo MEDIDOR DE FATURAMENTO (lote fonte-trafo-way2, 19/10/2026).
 *
 * A REGRA (humano, 19/10/2026): tensao, corrente, potencia e energia vem do medidor de faturamento (coleta de 5 min); o supervisorio
 *   so no Comparativo ou no que o medidor nao tem (temperatura do oleo e do enrolamento, posicao do comutador, os dois lados de
 *   34,5 kV). Tudo INTEGRALIZADO para os outros intervalos, nunca amostrado. O export do supervisorio parou em 14/10/2026, e com ele
 *   o `trafo_*` inteiro (era todo do supervisorio).
 *
 * QUEM E QUEM: 04T1 = ponto 6196 (TR1), 04T2 = ponto 6197 (TR2). Duas rotas: o cadastro de pontos do medidor (TR1/TR2 no lado de
 *   230 kV) e a correlacao da DIFERENCA entre os dois trafos nas duas fontes (`identidade` abaixo): se os pontos estivessem trocados,
 *   a diferenca 04T1 - 04T2 do medidor andaria ao CONTRARIO da do supervisorio. Medido em 19/10/2026 sobre os dias comuns: ver o livro.
 *
 * O DADO DO MEDIDOR (hist/way2_<dia>.json, CincoMinutos): cada valor e a MEDIA do intervalo, rotulado na borda DIREITA (o de 12:05
 *   e [12:00, 12:05)). Unidades: Demat kW, Demre kVAr, TensaoA/B/C em V FASE-NEUTRO, CorrenteA/B/C em A. `qualidade` 0 = medido; o
 *   nao medido vem com valor nulo e qualidade 1 (antes de 24/09/2024 nao ha nada; de 24/09/2024 a ~21/01/2025 o trafo estava
 *   desenergizado e tudo e zero).
 *
 * O QUE SE PUBLICA, por trafo (prefixo `04T1_`/`04T2_`), em cada intervalo [T, T + passo), rotulado no INICIO (T):
 *   i1a, i1b, i1c  corrente de cada fase (A)
 *   v1a, v1b, v1c  TENSAO DE LINHA EQUIVALENTE de cada fase = fase-neutro medida x raiz(3) (kV). NAO e a tensao entre fases: o
 *                  medidor nao a mede. Com fases equilibradas as duas coincidem; a diferenca contra a do supervisorio esta no livro.
 *                  (as chaves `v1ab/v1bc/v1ca` do supervisorio saem: nome de par de fases sobre a tensao de uma fase mentiria)
 *   p, q           potencia ativa (MW) e reativa (MVAr), com o sinal do medidor: positivo = entregue a rede
 *   s, fp          S = raiz(P^2 + Q^2) e FP = |P| / S, sobre P e Q JA integralizados do intervalo (S nulo -> FP ausente)
 *   carga_pct      S / 230 MVA (ONAF2) x 100
 *   Passo de 15/30/60 min: a MEDIA dos 3/6/12 intervalos de 5 min, so com o intervalo COMPLETO (grandeza a grandeza); faltando um,
 *   a grandeza fica AUSENTE naquele intervalo (nao apurado), nunca a media do que sobrou.
 *   Dia: s_max/p_max = a maior media de 5 min; s_med/p_med = a media dos intervalos de 5 min presentes (`n` = os intervalos
 *   com P medida, o menor dos dois trafos; 288 = dia completo);
 *   carga_pct_max; deseq_max/deseq_med = (maior - menor) / media das tres correntes, por intervalo de 5 min, so com corrente media
 *   acima de 20 A (a vazio a razao e ruido; a mesma regra do supervisorio).
 *
 * O QUE CONTINUA DO SUPERVISORIO, em campo proprio e declarado (`fontes_por_campo`, `supervisorio_ate`): CAMPOS_SUP_INTERVALO e
 *   CAMPOS_SUP_DIA, lidos da copia `trafo_scada_<res>.json` (gen-trafo.js) pela MESMA chave (ms do intervalo, ou dia). As grandezas
 *   do lado de 230 kV da copia NUNCA entram (a lista e explicita, por nome).
 *
 * A composicao inteira mora aqui (o gerador so le e grava): modo (completo ou incremental pela MARCA `esquema`), dias a reler,
 *   mescla com o publicado, juncao do supervisorio, guardas e meta.
 */

const ESQUEMA = 'medidor-230kv-1';
const PONTOS = { '04T1': 6196, '04T2': 6197 };
const TRAFOS = ['04T1', '04T2'];
const GRANDEZA_MEDIDOR = { Demat: 'p', Demre: 'q', TensaoA: 'va', TensaoB: 'vb', TensaoC: 'vc', CorrenteA: 'ia', CorrenteB: 'ib', CorrenteC: 'ic' };
const BRUTAS = ['p', 'q', 'va', 'vb', 'vc', 'ia', 'ib', 'ic'];
const PASSO = 300000;
const R3 = Math.sqrt(3);
const HIST_INICIO = '2024-07-12';            // o primeiro arquivo do historico do medidor
const REFRESH_DIAS = 3;                      // os ultimos dias sempre relidos (a borda que ainda pode mudar)
const REBUSCA_DIAS = 7;                      // dia incompleto (n < 288) nesta janela e relido
const JANELAS = { 5: 30, 15: 90, 30: 180, 60: 365 };   // dias por passo: o teto de ~8.700 linhas do MUST e do comparativo
const CORRENTE_COM_CARGA = 20;               // A: abaixo disto o desequilibrio nao se calcula (regra do supervisorio, mantida)

// ---------- a PLACA (folha de dados do fabricante; mudou para ca do gen-trafo.js, que a importa: uma escrita so) -------------
const PLACA = {
  fabricante: 'Hitachi Energy Chongqing Transformer',
  tipo: 'trifasico, instalacao externa, imerso em oleo, nucleo envolvido',
  ligacao: 'YNyn0yn0d1',
  resfriamento: 'ONAN / ONAF1 / ONAF2',
  tensao_kv: { at: 230, mt1: 34.5, mt2: 34.5, terciario: 13.8 },
  // 🔴 TRES potencias, uma por estagio de ventilacao: um numero so de "% de carregamento" mentiria
  potencia_at_mva: { onan: 150, onaf1: 180, onaf2: 230 },
  potencia_mt_mva: { onan: 75, onaf1: 90, onaf2: 115 },
  potencia_terciario_mva: 76,
  // ⚠️ ELEVACAO sobre o ambiente, em kelvin — NAO e temperatura absoluta
  elevacao_k: { topo_oleo: 60, enrolamento_medio: 65, ponto_quente: 78 },
  ambiente_projeto_c: { maximo: 47.5, media_anual: 26, minimo: 19 },
  tap: { posicoes: 21, neutro: 11, passo_pct: 1.25 },
  perdas_kw: { vazio: 90, carga_a_230mva: 600 },
};
const NOMINAL = PLACA.potencia_at_mva.onaf2;
const ENERGIZADO_KV = PLACA.tensao_kv.at / 2;   // tensao de linha acima da metade da nominal = barramento energizado

// os campos, por NOME
const CAMPOS_INTERVALO = ['i1a', 'i1b', 'i1c', 'v1a', 'v1b', 'v1c', 'p', 'q', 's', 'fp', 'carga_pct'];
const CAMPOS_DIA = ['s_max', 's_med', 'carga_pct_max', 'p_max', 'p_med', 'deseq_max', 'deseq_med'];
const CAMPOS_SUP_INTERVALO = ['i2a', 'i2b', 'i2c', 'i3a', 'i3b', 'i3c', 'v2ab', 'v2bc', 'v2ca', 'v3ab', 'v3bc', 'v3ca',
  't_oleo', 't_oleo_cdc', 't_enrol', 'tap'];
const CAMPOS_SUP_DIA = ['t_oleo_max', 't_oleo_med', 't_oleo_cdc_max', 't_oleo_cdc_med', 't_enrol_max', 't_enrol_med'];
// o meta da copia do supervisorio que as telas leem (temperatura implausivel, rotulos, origem dos nomes das tags)
const META_SUP = ['temperaturas_implausiveis', 'piso_de_plausibilidade_c', 'congelados_5min', 'historiador_5min', 'rotulos',
  'fonte_dos_nomes', 'pontos'];

const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const iso = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const diaDe = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);
const msDia = (d) => Date.parse(d + 'T00:00:00Z') + 3 * 3600e3;          // 00:00 BRT do dia
const diaMais = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function dias(de, ate) { const o = []; for (let d = de; d <= ate; d = diaMais(d, 1)) o.push(d); return o; }
// o texto do medidor e local (BRT) sem fuso: 'AAAA-MM-DDTHH:MM:SS' -> epoch
function msDeNaive(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 3 * 3600e3 : null;
}

/* ---------- um arquivo-dia do historico do medidor --------------------------------------------------------------------------
   -> { mapa: Map(inicio do intervalo -> { '04T1': {p, q, va, ...}, '04T2': {...} }), est }
   🔴 o valor de 12:05 e a media de [12:00, 12:05): a chave e o INICIO (rotulo - 5 min). O dia sai do CONTEUDO: intervalo que
      comeca fora do dia pedido e contado e fica fora. Valor nulo, nao finito ou com qualidade diferente de 0 = nao medido. */
function leDia(h, dia) {
  const est = { lidos: 0, nulos: 0, qualidade: 0, fora_do_dia: 0, pontos: 0 };
  const mapa = new Map();
  if (!h || !Array.isArray(h.dados)) throw new Error('arquivo do medidor de ' + dia + ' sem a lista `dados`');
  if (h.intervalo && h.intervalo !== 'CincoMinutos') throw new Error('arquivo do medidor de ' + dia + ' com intervalo ' + h.intervalo + ' (esperado CincoMinutos)');
  const ini = msDia(dia), fim = msDia(diaMais(dia, 1));
  for (const t of TRAFOS) {
    const pid = PONTOS[t];
    for (const s of h.dados) {
      if (s.pontoId !== pid || !GRANDEZA_MEDIDOR[s.nomeGrandeza]) continue;
      est.pontos += 1;
      const k = GRANDEZA_MEDIDOR[s.nomeGrandeza];
      for (const v of s.valores || []) {
        const ms = msDeNaive(v.data);
        if (ms == null) { est.fora_do_dia += 1; continue; }
        const i0 = ms - PASSO;
        if (i0 < ini || i0 >= fim) { est.fora_do_dia += 1; continue; }
        // 🔴 so NUMERO e medida: '' e ' ' passam no isFinite e o Number() os faz 0 MW, um intervalo nao medido publicado como zero
        if (typeof v.valor !== 'number' || !isFinite(v.valor)) { est.nulos += 1; continue; }
        if (v.qualidade !== 0) { est.qualidade += 1; continue; }
        est.lidos += 1;
        const reg = mapa.get(i0) || mapa.set(i0, {}).get(i0);
        (reg[t] || (reg[t] = {}))[k] = Number(v.valor);
      }
    }
  }
  return { mapa, est };
}

/* ---------- da media bruta do intervalo aos campos publicados de um trafo --------------------------------------------------- */
function campos(m) {
  const o = {};
  if (!m) return o;
  if (m.ia != null) o.i1a = m.ia;
  if (m.ib != null) o.i1b = m.ib;
  if (m.ic != null) o.i1c = m.ic;
  if (m.va != null) o.v1a = (m.va * R3) / 1000;      // V fase-neutro -> kV de linha equivalente
  if (m.vb != null) o.v1b = (m.vb * R3) / 1000;
  if (m.vc != null) o.v1c = (m.vc * R3) / 1000;
  if (m.p != null) o.p = m.p / 1000;                 // kW -> MW
  if (m.q != null) o.q = m.q / 1000;                 // kVAr -> MVAr
  if (m.p != null && m.q != null) {
    o.s = Math.hypot(o.p, o.q);
    if (o.s > 0) o.fp = Math.abs(o.p) / o.s;
    o.carga_pct = (o.s / NOMINAL) * 100;
  }
  return o;
}
function linhaPublicada(ms, porTrafo) {
  const o = { ms, t: iso(ms) };
  for (const t of TRAFOS) {
    const c = campos(porTrafo[t]);
    for (const k of CAMPOS_INTERVALO) if (c[k] != null) o[t + '_' + k] = r2(c[k]);
  }
  return o;
}

/* ---------- integralizacao: 5 min -> passo de `min` minutos --------------------------------------------------------------
   media dos intervalos de 5 min do balde, grandeza a grandeza, so com o balde COMPLETO (min/5 valores). O balde e alinhado ao
   relogio de Brasilia (o epoch carrega +3 h, multiplo de 60 min). */
function integra(mapa, min) {
  const L = min * 60e3, n = min / 5;
  const baldes = new Map();
  for (const [ms, reg] of mapa) {
    const b = Math.floor(ms / L) * L;
    (baldes.get(b) || baldes.set(b, []).get(b)).push(reg);
  }
  const out = [];
  for (const b of [...baldes.keys()].sort((x, y) => x - y)) {
    const regs = baldes.get(b), porTrafo = {};
    for (const t of TRAFOS) {
      const m = {};
      for (const k of BRUTAS) {
        const vs = regs.map((r) => (r[t] || {})[k]).filter((x) => x != null);
        if (vs.length === n) m[k] = media(vs);
      }
      porTrafo[t] = m;
    }
    const linha = linhaPublicada(b, porTrafo);
    if (Object.keys(linha).length > 2) out.push(linha);
  }
  return out;
}
const cinco = (mapa) => [...mapa.keys()].sort((x, y) => x - y).map((ms) => linhaPublicada(ms, mapa.get(ms)))
  .filter((l) => Object.keys(l).length > 2);

/* ---------- o dia --------------------------------------------------------------------------------------------------------- */
function diario(dia, mapa) {
  const o = { dia, ms: msDia(dia), n: 0 };
  let n = null;
  for (const t of TRAFOS) {
    const S = [], P = [], des = [];
    let nt = 0;
    for (const reg of mapa.values()) {
      const c = campos(reg[t]);
      if (c.p != null) nt += 1;
      if (c.s != null) S.push(c.s);
      if (c.p != null) P.push(c.p);
      if (c.i1a != null && c.i1b != null && c.i1c != null) {
        const f = [c.i1a, c.i1b, c.i1c], m = media(f);
        if (m > CORRENTE_COM_CARGA) des.push(((Math.max(...f) - Math.min(...f)) / m) * 100);
      }
    }
    n = n == null ? nt : Math.min(n, nt);   // `n` = intervalos de 5 min com P medida nos DOIS trafos (o menor): dia completo = 288
    if (S.length) { o[t + '_s_max'] = r2(Math.max(...S)); o[t + '_s_med'] = r2(media(S)); o[t + '_carga_pct_max'] = r2((Math.max(...S) / NOMINAL) * 100); }
    if (P.length) { o[t + '_p_max'] = r2(Math.max(...P)); o[t + '_p_med'] = r2(media(P)); }
    if (des.length) { o[t + '_deseq_max'] = r2(Math.max(...des)); o[t + '_deseq_med'] = r2(media(des)); }
  }
  o.n = n;
  return o;
}
/* o barramento ficou energizado no dia? Metade do dia ou mais (144 intervalos) com a tensao de linha de um dos trafos acima da
   metade da nominal. Um intervalo so nao basta: medido em 19/10/2026, em dias isolados entre out/2024 e jan/2025 (08/10, 10/10 e 06/12/2024,
   17/01/2025) o medidor registra 2 a 11 intervalos com tensao e o resto do dia em zero; a energizacao e 21/01/2025 (04T2) e 24/01/2025
   (04T1). */
const ENERGIZADO_MIN_INTERVALOS = 144;
function energizado(mapa) {
  for (const t of TRAFOS) {
    let n = 0;
    for (const reg of mapa.values()) {
      const v = (reg[t] || {}).va;
      if (v != null && (v * R3) / 1000 > ENERGIZADO_KV) n += 1;
    }
    if (n >= ENERGIZADO_MIN_INTERVALOS) return true;
  }
  return false;
}

/* ---------- o modo e os dias a reler --------------------------------------------------------------------------------------
   COMPLETO quando QUALQUER saida anterior nao tem a marca (primeira vez, esquema do supervisorio, ou FORCAR): relê o historico
   inteiro. INCREMENTAL: os ultimos REFRESH_DIAS dias antes do ultimo publicado ate hoje, e os dias incompletos (n < 288) dos
   ultimos REBUSCA_DIAS. Migracao pela MARCA, nunca pela magnitude. */
function modo(anteriores, forcar) {
  if (forcar) return 'completo';
  for (const k of ['5', '15', '30', '60', 'dia']) if (!anteriores[k] || anteriores[k].esquema !== ESQUEMA) return 'completo';
  return 'incremental';
}
function diasALer(m, anteriorDia, hoje) {
  if (m === 'completo') return dias(HIST_INICIO, hoje);
  const S = (anteriorDia && anteriorDia.serie) || [];
  const ult = S.length ? S[S.length - 1].dia : diaMais(hoje, -REFRESH_DIAS);
  const set = new Set(dias(diaMais(ult < hoje ? ult : hoje, -REFRESH_DIAS), hoje));
  const desde = diaMais(hoje, -REBUSCA_DIAS);
  for (const r of S) if (r.dia >= desde && r.n < 288) set.add(r.dia);
  return [...set].sort();
}

/* ---------- mescla com o publicado: so os campos do MEDIDOR do anterior ficam, e so nos dias que nao foram relidos -------- */
function soMedidor(linha, camposPorTrafo, chaves) {
  const o = {};
  for (const k of chaves) if (linha[k] != null) o[k] = linha[k];
  for (const t of TRAFOS) for (const c of camposPorTrafo) if (linha[t + '_' + c] != null) o[t + '_' + c] = linha[t + '_' + c];
  return o;
}
function mescla(anteriorSerie, novas, relidos, camposPorTrafo, chaves, chaveDia) {
  const fica = (anteriorSerie || []).filter((r) => !relidos.has(chaveDia(r))).map((r) => soMedidor(r, camposPorTrafo, chaves))
    .filter((r) => Object.keys(r).length > chaves.length);
  const k0 = chaves[0];
  const por = new Map(fica.map((r) => [r[k0], r]));
  for (const r of novas) por.set(r[k0], r);           // a rodada nova GANHA
  return [...por.values()].sort((a, b) => (a[k0] < b[k0] ? -1 : a[k0] > b[k0] ? 1 : 0));
}

/* ---------- juncao do supervisorio pela MESMA chave; linha so do supervisorio tambem entra (a temperatura nao some) -------- */
function junta(linhas, sup, camposPorTrafo, chave, criaLinha) {
  const por = new Map(linhas.map((r) => [r[chave], r]));
  let juntas = 0;
  for (const s of (sup || [])) {
    const add = {};
    for (const t of TRAFOS) for (const c of camposPorTrafo) if (s[t + '_' + c] != null) add[t + '_' + c] = s[t + '_' + c];
    if (!Object.keys(add).length) continue;
    let r = por.get(s[chave]);
    if (!r) { r = criaLinha(s); por.set(s[chave], r); }
    Object.assign(r, add); juntas += 1;
  }
  const out = [...por.values()].sort((a, b) => (a[chave] < b[chave] ? -1 : a[chave] > b[chave] ? 1 : 0));
  return { linhas: out, juntas };
}

/* ---------- guardas (abortam sem gravar) ------------------------------------------------------------------------------------
   confereFisica: sobre os intervalos de 5 min LIDOS nesta rodada, no decil de maior S (S > 10 MVA): raiz(3) x V x I contra S
   (pega kW x W, a raiz(3) esquecida, corrente de outro ponto) e |FP| > 0,85; e a tensao de linha mediana com o barramento
   energizado entre 85 % e 115 % da nominal. Menos de 100 intervalos com carga: NAO julga, e diz (o ensaio de produto confere
   que julgou alguma coisa). */
const TOL_FISICA = 0.05;
function confereFisica(mapas) {
  const log = [], veredito = {};
  for (const t of TRAFOS) {
    const cheias = [], vs = [];
    for (const mapa of mapas) for (const reg of mapa.values()) {
      const c = campos(reg[t]);
      if (c.v1a != null && c.v1a > ENERGIZADO_KV) vs.push(media([c.v1a, c.v1b, c.v1c].filter((x) => x != null)));
      if (c.s != null && c.s > 10 && c.i1a != null && c.v1a != null) cheias.push(c);
    }
    vs.sort((a, b) => a - b);
    const vmed = vs.length ? vs[vs.length >> 1] : null;
    if (vmed != null && !(vmed > 0.85 * PLACA.tensao_kv.at && vmed < 1.15 * PLACA.tensao_kv.at)) {
      throw new Error('trafo ' + t + ': tensao de linha mediana de ' + vmed.toFixed(1) + ' kV com o barramento energizado — fora de 85-115 % '
        + 'de ' + PLACA.tensao_kv.at + ' kV. A unidade ou a conversao fase-neutro -> linha mudou: NAO publicar.');
    }
    if (cheias.length < 100) {
      // trafo desligado (manutencao, SEP) ou sem arquivo na janela: nao e defeito, e o veredito diz o porque, com a contagem
      veredito[t] = { julgada: false, intervalos: cheias.length, motivo: 'sem carga na janela: ' + cheias.length + ' intervalo(s) de 5 min com S acima de 10 MVA, de 100 exigidos' };
      log.push('guarda ' + t + ': ' + veredito[t].motivo + ' — fisica NAO julgada'); continue;
    }
    const ord = cheias.sort((a, b) => b.s - a.s).slice(0, Math.max(10, Math.floor(cheias.length / 10)));
    const erros = ord.map((c) => Math.abs((R3 * media([c.v1a, c.v1b, c.v1c].filter((x) => x != null)) * media([c.i1a, c.i1b, c.i1c].filter((x) => x != null))) / 1000 - c.s) / c.s);
    erros.sort((a, b) => a - b);
    const err = erros[erros.length >> 1];
    const fps = ord.map((c) => c.fp).filter((x) => x != null).sort((a, b) => a - b);
    const fp = fps.length ? fps[fps.length >> 1] : null;
    log.push('guarda ' + t + ': raiz(3)xVxI contra S no decil de maior carga (' + ord.length + ' intervalos) -> erro mediano '
      + (err * 100).toFixed(2) + '% · |FP| mediano ' + (fp == null ? '-' : fp.toFixed(3)) + ' · V de linha mediana ' + (vmed == null ? '-' : vmed.toFixed(2)) + ' kV');
    if (!(err < TOL_FISICA)) throw new Error('trafo ' + t + ': raiz(3)xVxI diverge de S em ' + (err * 100).toFixed(1)
      + '% no decil de maior carga. Unidade ou grandeza do medidor mudou: NAO publicar.');
    if (fp != null && !(fp > 0.85)) throw new Error('trafo ' + t + ': |FP| mediano ' + fp.toFixed(3) + ' sob carga alta: a coluna nao e cos(fi).');
    veredito[t] = { julgada: true, intervalos: ord.length, erro_mediano_pct: Number((err * 100).toFixed(3)), fp_mediano: fp == null ? null : Number(fp.toFixed(3)) };
  }
  log.veredito = veredito;   // o array do log continua sendo o que o gerador imprime; o veredito vai ao meta
  return log;
}
/* identidade e paridade contra a copia do supervisorio, nos dias comuns (p_med > 20 MW nos dois): a razao mediana do pico e da
   media de P de cada trafo (medido 0,98 a 1,005 em 10/10/2026; aborta fora de 0,90-1,10, mais de 4x o maior desvio medido), e a
   correlacao entre as DIFERENCAS 04T1 - 04T2 das duas fontes (pontos trocados = correlacao negativa). Menos de 30 dias comuns:
   nao julga, e diz. */
function confereParidade(diarioMed, diarioSup) {
  const sup = new Map((diarioSup || []).map((r) => [r.dia, r]));
  const log = [], rz = {}, dM = [], dS = [];
  for (const r of diarioMed) {
    const s = sup.get(r.dia); if (!s) continue;
    let todos = true;
    for (const t of TRAFOS) {
      for (const k of ['p_max', 'p_med', 's_max']) {
        const a = r[t + '_' + k], b = s[t + '_' + k];
        if (a == null || b == null || !(s[t + '_p_med'] > 20) || !(r[t + '_p_med'] > 20)) { todos = false; continue; }
        (rz[t + '_' + k] || (rz[t + '_' + k] = [])).push(a / b);
      }
    }
    if (todos && r['04T1_p_med'] != null && s['04T1_p_med'] != null) { dM.push(r['04T1_p_med'] - r['04T2_p_med']); dS.push(s['04T1_p_med'] - s['04T2_p_med']); }
  }
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const out = { razoes: {}, dias: 0, correlacao: null };
  for (const [k, a] of Object.entries(rz)) { out.razoes[k] = Number(med(a).toFixed(4)); out.dias = Math.max(out.dias, a.length); }
  if (dM.length >= 30) {
    const mx = media(dM), my = media(dS);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < dM.length; i++) { sxy += (dM[i] - mx) * (dS[i] - my); sxx += (dM[i] - mx) ** 2; syy += (dS[i] - my) ** 2; }
    out.correlacao = sxx && syy ? Number((sxy / Math.sqrt(sxx * syy)).toFixed(3)) : null;
  }
  if (out.dias < 30) { log.push('paridade contra o supervisorio: so ' + out.dias + ' dia(s) comuns — NAO julgada'); return { log, out }; }
  log.push('paridade contra o supervisorio em ' + out.dias + ' dias comuns: ' + Object.entries(out.razoes).map(([k, v]) => k + ' ' + v).join(' · ')
    + ' · correlacao das diferencas 04T1-04T2 ' + out.correlacao);
  for (const [k, v] of Object.entries(out.razoes)) if (!(v > 0.9 && v < 1.1)) throw new Error('paridade ' + k + ': razao mediana medidor/supervisorio ' + v + ' fora de 0,90-1,10. Unidade ou ponto trocado: NAO publicar.');
  if (out.correlacao != null && !(out.correlacao > 0.3)) throw new Error('identidade: a diferenca 04T1-04T2 do medidor nao acompanha a do supervisorio (correlacao ' + out.correlacao + '). Pontos 6196/6197 trocados: NAO publicar.');
  return { log, out };
}

/* ---------- o meta comum ---------------------------------------------------------------------------------------------------- */
function meta(o) {
  const m = {
    gerado_em: o.gerado_em,
    esquema: ESQUEMA,
    trafos: TRAFOS,
    rotulo_de_tempo: 'início do intervalo; no lado de 230 kV cada valor é a média do intervalo, integralizada dos valores de 5 minutos do medidor de faturamento',
    passo: '5 min: a média do intervalo, como o medidor a registra; 15, 30 e 60 min: a média dos intervalos de 5 min, só com o intervalo completo; '
      + 'dia: máximo e média dos intervalos de 5 min do dia',
    energia_derivada: 'p × passo é a energia do intervalo no lado de 230 kV (o valor é média, não amostra)',
    fonte_230kv: 'medidor de faturamento do lado de 230 kV de cada transformador, coleta de 5 min',
    medidores: PONTOS,
    tensao_230kv: 'v1a, v1b e v1c são a tensão de linha equivalente de cada fase: a tensão fase-neutro medida × √3. Não é a tensão entre fases, que o medidor não mede',
    unidades: { i: 'A', v: 'kV', p: 'MW', q: 'MVAr', s: 'MVA', fp: 'modulo de cos(fi), 0..1, |P| / S', t_oleo: '°C', t_oleo_cdc: '°C', t_enrol: '°C', tap: 'degrau' },
    fontes_por_campo: {
      medidor: o.dia ? CAMPOS_DIA : CAMPOS_INTERVALO,
      supervisorio: o.semSup ? [] : (o.dia ? CAMPOS_SUP_DIA : CAMPOS_SUP_INTERVALO),
    },
    supervisorio_nota: o.semSup ? 'sem grandezas do supervisório neste passo'
      : 'temperaturas, posição do comutador e os dois lados de 34,5 kV vêm do supervisório da subestação, que o medidor não mede: '
        + 'amostra no instante (30 e 60 min) ou valor de 5 min do historiador; param quando a exportação do supervisório para',
    supervisorio_ate: o.supAte || null,
    medidor_ate: o.medAte || null,
    medicao_desde: o.desde || null,
    placa: PLACA,
    carga_pct_referencia: 'ONAF2 (' + NOMINAL + ' MVA); os estágios ONAN e ONAF1 estão em placa.potencia_at_mva',
    desequilibrio: '(maior − menor) ÷ média das três correntes, por intervalo de 5 min, só com corrente média acima de ' + CORRENTE_COM_CARGA + ' A',
  };
  for (const k of META_SUP) if (o.metaSup && o.metaSup[k] !== undefined) m[k] = o.metaSup[k];
  return m;
}

module.exports = {
  ESQUEMA, PONTOS, TRAFOS, PLACA, NOMINAL, ENERGIZADO_KV, HIST_INICIO, REFRESH_DIAS, REBUSCA_DIAS, JANELAS, PASSO,
  CAMPOS_INTERVALO, CAMPOS_DIA, CAMPOS_SUP_INTERVALO, CAMPOS_SUP_DIA, META_SUP, CORRENTE_COM_CARGA, TOL_FISICA,
  leDia, campos, linhaPublicada, integra, cinco, diario, energizado, modo, diasALer, soMedidor, mescla, junta,
  confereFisica, confereParidade, meta, iso, diaDe, msDia, diaMais, dias, msDeNaive, r2,
};
