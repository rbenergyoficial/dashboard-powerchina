'use strict';
/*
 * lib-pvstr-logger.js — a curva de 30 min por inversor e a razao de cada string, pelo logger Sungrow (strings-logger, 19/10/2026).
 *
 * Decisao do humano (19/10/2026): "strings de 30 minutos deve sair todas do scada, e utilizar logger sungrow". As telas (Grafana
 * pvstr1r [521]-[525], o Mapa do portal na hora do dia) leem `pvstr_hora_<usina>.json` e `pvstr_str_<usina>_<ts>.json` pelo NOME
 * do blob e do campo; ate este lote os dois vinham do export do supervisorio (amostra INSTANTANEA a cada 30 min, parado desde
 * 14/10/2026). Esta lib os monta com o que o gen-sungrow ja publica do logger, a cada 5 min, nos ultimos 7 dias:
 *   sg_curva_<k>   p e pdc (0,1 kW), t (0,1 °C), lim (0/1), iso (kΩ) e nom (kW) de cada inversor, da meia hora da primeira a meia
 *                  hora da ultima amostra gerando (iso, nom e a grade alinhada a meia hora desde este lote, no gen-sungrow);
 *   sg_str_<k>     a corrente de cada entrada (0,1 A) na mesma grade;
 *   sg_str_entradas quais entradas sao strings de verdade (lib-strings, a regra medida em 30/09/2026).
 *
 * 🔴 A MEIA HORA E INTEGRALIZADA, NUNCA AMOSTRADA (regra do humano, 19/10/2026). A meia hora T (rotulo no INICIO, como o
 *    irr_plano_30min e o estacao_tudo_30min) e a MEDIA das seis leituras de 5 min T, T+5, ..., T+25. E a mesma conta da energia
 *    do inversor-dia do logger (potencia de 5 min x 5/60 h, `eca` do sg_saude): a soma das meias horas x 0,5 h fecha com ela.
 * 🔴 TUDO OU NADA, por grandeza: meia hora com uma das seis leituras faltando sai NULA (a media de cinco nao e a da meia hora).
 *    Medido no M5/TS3 de 12 a 18/10/2026: 3.670 de 3.671 meias horas inteiras dentro da janela tem as seis leituras.
 *    A meia hora LIDA e a que tem as seis leituras de potencia CA e CC; sem isso o instante fica no eixo com tudo nulo (a mesma
 *    regra do supervisorio: a falta nao some da tela). Temperatura, isolamento, limitacao e cada string sao tudo ou nada a parte.
 * 🔴 A JANELA DO DIA: da primeira a ultima meia hora lida GERANDO (CA ou CC acima de 1 kW na media), como no supervisorio. O
 *    registro de 5 min publicado (lib-sungrow-str, desde este lote) vai da meia hora da primeira a meia hora da ultima leitura
 *    gerando, entao a meia hora da ponta tem as seis leituras: a do amanhecer e a da PARADA do fim do dia (M9/TS1/INV16 em
 *    15/10/2026 parou as 14:50 gerando ~300 kW; com a grade so da geracao a meia hora das 14:30 sumia, 123 kWh fora da curva).
 * 🔴 STRINGS E MPPT: a corrente da meia hora de cada entrada e a media das seis; a razao (sm, mm) e a mais fraca (sw, mw) saem da
 *    lib-strings (`dispersao`, so entre as REAIS, piso de 3 A na mediana), a mesma do supervisorio e do sg_str_dia. O MPPT k do
 *    SG350HX e a soma das entradas 2k-1 e 2k (lib-sungrow-str: 4,41 + 3,99 = 8,4 A contra 8,6 A lidos no mesmo instante); MPPT real e
 *    o que tem ao menos uma string real. `sn` conta as entradas com mais de 0,5 A na media (a mesma regra do supervisorio).
 * 🔴 O QUE O LOGGER NAO TEM: o SETPOINT de despacho por inversor (`sp`). Nas 179 colunas do registro do inversor nao ha referencia
 *    de potencia; o "Valor de potencia FV ativa definida" do logger do eletrocentro e configuracao (o mesmo numero em 180 dias,
 *    04/10/2026). O campo `sp` NAO e publicado (ausencia = nao apurado; nunca zero). O que o logger tem no lugar e o MODO DE
 *    POTENCIA LIMITADA do proprio inversor: `lim` = % da meia hora com a potencia limitada (campo novo).
 * 🔴 A COPIA DO SUPERVISORIO NAO SE PERDE (o mesmo desenho do fonte-inv-logger): o gen-perdas grava a curva do supervisorio em
 *    `pvstr_hora_<u>_scada.json` e `pvstr_str_<u>_<ts>_scada.json` (`nomeScada`), que o gen-ts-setpoint le (o setpoint so existe
 *    nela). Na primeira rodada o gen-pvstr-logger SEMEIA a copia com o blob antigo, so se ele nao tiver a marca do logger
 *    (`copiaScada` da lib-inv-logger).
 */
const STR = require('./lib-strings.js');
const { PISO_A } = require('./lib-sungrow-str.js');
const { copiaScada, ORIGEM } = require('./lib-inv-logger.js');

const ESQUEMA = 4;                 // 1-3 sao os do gen-perdas (supervisorio); 4 = a meia hora integralizada do logger
const POR_MEIA = 6;                // leituras de 5 min numa meia hora
const GER_KW = 1;                  // gerando: mais de 1 kW (o mesmo piso do supervisorio e do logger)
const VIVA_A = 0.5;                // `sn`: entrada com mais de 0,5 A conta como string com corrente (a regra do supervisorio)
const N_MPPT = 12;                 // SG350HX: 12 MPPT, entradas 2k-1 e 2k
const DIAS = 7;                    // a janela da curva (a do registro de 5 min publicado)
const ISO_TOPO = 20000;            // kΩ: o topo da faixa de medicao do isolamento do inversor (1 a 20 000 kΩ): "saiu da medicao"
const CAMPOS = ['pcc', 'pca', 'ef', 'sn', 'sm', 'mm', 'sw', 'mw', 't', 'iso', 'lim'];

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const min = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const hhmm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

/* o nome da copia do supervisorio: pvstr_hora_M5.json -> pvstr_hora_M5_scada.json; pvstr_str_M5_TS3.json -> pvstr_str_M5_TS3_scada.json.
   Qualquer outro nome devolve null (o gen-perdas so troca estes dois) */
function nomeScada(nome) {
  const m = /^(pvstr_hora_M\d+|pvstr_str_M\d+_TS\d+)\.json$/.exec(String(nome));
  return m ? m[1] + '_scada.json' : null;
}

/* os ensaios do SUPERVISORIO (perdas.yml) leem a copia pelo nome `_scada`; sem ela (antes da primeira rodada do gen-perdas novo) o
   nome antigo vale SO sem a marca do logger. `le` e o leitor do proprio ensaio, que estoura com HTTP 404 ou ENOENT na ausencia.
   Copia com a marca, ou nome antigo com a marca e sem copia, estoura: o ensaio do supervisorio julgaria o produto do logger */
async function leCopia(le, nome) {
  const novo = nomeScada(nome);
  if (!novo) throw new Error(nome + ': nome sem copia do supervisorio');
  let j = null;
  try { j = await le(novo); } catch (e) { if (!/\b404\b|ENOENT/.test(String(e && e.message))) throw e; }
  if (j) { if (j.origem_inversor) throw new Error(novo + ' traz a marca do ' + j.origem_inversor + ': a copia do supervisorio esta contaminada'); return j; }
  const a = await le(nome);
  if (a && a.origem_inversor) throw new Error(nome + ' ja e do ' + a.origem_inversor + ' e ' + novo + ' nao existe: a copia do supervisorio se perdeu');
  return a;
}

/* a media das seis leituras a partir do indice j (tudo ou nada); f escala; ok(x) aceita a leitura */
function media(a, j, f, ok) {
  if (!a || j < 0 || j + POR_MEIA > a.length) return null;
  let s = 0;
  for (let q = 0; q < POR_MEIA; q += 1) { const x = a[j + q]; if (x == null || (ok && !ok(x))) return null; s += x; }
  return (s / POR_MEIA) * f;
}

/* o isolamento da meia hora: a media das seis (zero e "sem leitura": nula). Leitura no TOPO da faixa (ISO_TOPO) e "fora da medicao":
   as seis no topo dao o topo; topo misturado com leitura de verdade (o inversor que parou no meio da meia hora passa a 20 000:
   M9/TS1/INV16, 15/10/2026 14:55) nao e uma grandeza so, e a meia hora sai nula em vez de sair 3.537 kΩ */
function isoMeia(a, j) {
  const m = media(a, j, 1, (x) => x > 0); if (m == null) return null;
  const topo = a.slice(j, j + POR_MEIA).filter((x) => x >= ISO_TOPO).length;
  return topo === 0 ? r2(m) : topo === POR_MEIA ? ISO_TOPO : null;
}

/* uma linha do sg_curva_<k> e a do sg_str_<k> do MESMO inversor-dia (mesmo numero de serie e mesma grade), as entradas reais
   (Set de numeros 1..24) -> { hora: linha do pvstr_hora, str: linha do pvstr_str } ou null (dia sem meia hora gerando).
   cv: { d, inv, sn, h0, p, pdc, t, lim, iso?, nom? }; st: { d, inv, sn, h0, s: { n: [0,1 A] } } (pode faltar: sem strings) */
function meiasHoras(u, ts, cv, st, reais) {
  if (st && (st.sn !== cv.sn || st.h0 !== cv.h0 || st.d !== cv.d || st.inv !== cv.inv)) throw new Error(u + '/' + ts + '/' + cv.inv + ' ' + cv.d + ': curva e strings de grades diferentes');
  const m0 = min(cv.h0), n = cv.p.length;
  const T0 = Math.ceil(m0 / 30) * 30;
  const R = reais || new Set();
  const RM = new Set(); for (const k of R) RM.add(Math.ceil(k / 2));
  const ents = st ? Object.keys(st.s).map(Number).sort((a, b) => a - b) : [];
  const lista = [...R].sort((a, b) => a - b);
  const linhas = [];
  for (let T = T0; T + 25 <= m0 + 5 * (n - 1); T += 30) {
    const j = (T - m0) / 5;
    const pca = media(cv.p, j, 0.1), pcc = media(cv.pdc, j, 0.1);
    const o = { h: hhmm(T), lida: pca != null && pcc != null };
    if (o.lida) {
      o.pca = r2(pca); o.pcc = r2(pcc);
      o.ef = pcc > GER_KW ? r2((pca / pcc) * 100) : null;
      o.t = r2(media(cv.t, j, 0.1));
      o.iso = isoMeia(cv.iso, j);
      o.lim = r1(media(cv.lim, j, 100));
      const cS = {};
      for (const e of ents) { const x = media(st.s[e], j, 0.1); cS[e] = x; }
      o.sn = st ? ents.filter((e) => cS[e] != null && cS[e] > VIVA_A).length : null;
      const ds = st ? STR.dispersao(cS, R, PISO_A) : null;
      o.sm = ds ? ds.min_pct : null; o.sw = ds ? ds.min_n : null; o.md = ds ? ds.med : null;
      // o MPPT k: a soma das entradas 2k-1 e 2k; entrada fora do `s` (vazia o dia inteiro) soma zero, entrada com leitura faltando anula
      const cM = {};
      if (st) for (let k = 1; k <= N_MPPT; k += 1) {
        const a = st.s[2 * k - 1] ? cS[2 * k - 1] : 0, b = st.s[2 * k] ? cS[2 * k] : 0;
        cM[k] = a == null || b == null ? null : a + b;
      }
      const dm = st ? STR.dispersao(cM, RM, PISO_A) : null;
      o.mm = dm ? dm.min_pct : null; o.mw = dm ? dm.min_n : null;
      o.rs = lista.map((e) => (ds && cS[e] != null ? r1((cS[e] / ds.med) * 100) : null));
    }
    linhas.push(o);
  }
  // a janela: da primeira a ultima meia hora lida gerando; o que fica de fora nas pontas nao entra
  const ger = linhas.map((o, i) => (o.lida && (o.pca > GER_KW || o.pcc > GER_KW) ? i : -1)).filter((i) => i >= 0);
  if (!ger.length) return null;
  const J = linhas.slice(ger[0], ger[ger.length - 1] + 1);
  const hora = { d: cv.d, ts, inv: cv.inv, ns: cv.sn, nom: cv.nom == null ? null : r2(cv.nom), h: J.map((o) => o.h) };
  for (const c of CAMPOS) hora[c] = J.map((o) => (o.lida && o[c] !== undefined ? o[c] : null));
  const str = { d: cv.d, ufv: u, ts, inv: cv.inv, ns: cv.sn, h: hora.h, md: J.map((o) => (o.lida ? o.md : null)), s: {}, reais: lista };
  lista.forEach((e, q) => { str.s[e] = J.map((o) => (o.lida ? o.rs[q] : null)); });
  return { hora, str };
}

/* os produtos de uma rodada. fontes: { etcs: ['M5_TS3', ...], curva: { k: sg_curva_<k> }, str: { k: sg_str_<k> }, entradas: sg_str_entradas }
   -> { hora: { u: [linhas] }, str: { 'u_ts': [linhas] }, n: { pares, sem_str, sem_meia }, dias: { u: [dias] } }.
   So os ultimos DIAS dias de cada usina (o registro de 5 min ja vem cortado em 7) */
function monta(fontes) {
  const REAIS = STR.indiceReais((fontes.entradas && fontes.entradas.entradas) || []);
  const hora = {}, str = {}, n = { pares: 0, sem_str: 0, sem_meia: 0 };
  for (const k of fontes.etcs) {
    const C = fontes.curva[k]; if (!C) continue;
    const [u, ts] = k.split('_');
    const S = new Map((((fontes.str[k] || {}).serie) || []).map((l) => [l.d + '|' + l.inv + '|' + l.sn, l]));
    for (const cv of (C.serie || [])) {
      const st = S.get(cv.d + '|' + cv.inv + '|' + cv.sn);
      if (!st) n.sem_str += 1;
      const R = (REAIS.get(u + '|' + ts + '|' + cv.inv + '|s') || {}).reais;
      const x = meiasHoras(u, ts, cv, st, R);
      if (!x) { n.sem_meia += 1; continue; }
      n.pares += 1;
      (hora[u] || (hora[u] = [])).push(x.hora);
      if (st) (str[u + '_' + ts] || (str[u + '_' + ts] = [])).push(x.str);
    }
  }
  const dias = {};
  const ordem = (a, b) => (a.d + a.ts + a.inv < b.d + b.ts + b.inv ? -1 : 1);
  for (const u of Object.keys(hora)) {
    const ds = [...new Set(hora[u].map((l) => l.d))].sort().slice(-DIAS);
    hora[u] = hora[u].filter((l) => ds.includes(l.d)).sort(ordem);
    dias[u] = ds;
  }
  for (const k of Object.keys(str)) { const ds = dias[k.split('_')[0]] || []; str[k] = str[k].filter((l) => ds.includes(l.d)).sort(ordem); }
  return { hora, str, n, dias };
}

/* o CONTRATO de uma linha do pvstr_hora do logger: listas do mesmo tamanho, grade de 30 min crescente, sem `sp`, faixas fisicas.
   Devolve a lista do que esta errado (vazia = ok). Teto da CA: 352 kW (110 % de 320, o teto do setpoint) com folga de leitura */
function contrato(l) {
  const mau = [];
  const id = l.d + ' ' + l.ts + '/' + l.inv;
  if (!Array.isArray(l.h) || !l.h.length) return [id + ': sem h'];
  for (const c of CAMPOS) if (!Array.isArray(l[c]) || l[c].length !== l.h.length) mau.push(id + ': ' + c + ' fora do tamanho de h');
  if ('sp' in l) mau.push(id + ': sp publicado (o logger nao tem setpoint)');
  for (let i = 1; i < l.h.length; i += 1) if (min(l.h[i]) - min(l.h[i - 1]) !== 30) { mau.push(id + ': grade quebrada em ' + l.h[i]); break; }
  if (l.h.some((h) => min(h) % 30)) mau.push(id + ': rotulo fora da meia hora');
  const fora = (c, a, b) => (l[c] || []).some((x) => x != null && (x < a || x > b));
  if (fora('pca', 0, 360) || fora('pcc', 0, 400)) mau.push(id + ': potencia fora da faixa');
  if (fora('sm', 0, 1000) || fora('mm', 0, 1000)) mau.push(id + ': razao fora da faixa');
  if (fora('lim', 0, 100)) mau.push(id + ': limitacao fora de 0-100');
  if (fora('sn', 0, 24)) mau.push(id + ': mais de 24 entradas');
  return mau;
}

const UNIDADE = 'a meia hora T (rotulo no inicio) e a MEDIA das seis leituras de 5 min de T a T+25 do logger, tudo ou nada por grandeza; '
  + 'pcc e pca em kW; ef em % (CA/CC das medias); sm e mm em % da mediana das irmas REAIS; sw e mw o NUMERO da string e do MPPT mais fracos '
  + '(MPPT k = entradas 2k-1 e 2k); sn a contagem de entradas com mais de ' + VIVA_A + ' A; t em C; iso em kOhm (' + ISO_TOPO + ' = topo da faixa nas seis leituras; topo misturado com leitura sai nulo); lim em % da meia hora com a '
  + 'potencia limitada no inversor; nom em kW; ns numero de serie. Sem sp: o setpoint de despacho por inversor nao existe no logger';

module.exports = { ESQUEMA, ORIGEM, POR_MEIA, GER_KW, VIVA_A, N_MPPT, DIAS, ISO_TOPO, CAMPOS, PISO_A, UNIDADE, nomeScada, leCopia, media, isoMeia, meiasHoras, monta, contrato, copiaScada };
