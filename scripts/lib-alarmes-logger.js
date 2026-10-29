'use strict';
/*
 * lib-alarmes-logger.js — o código de falha e o estado de cada inversor no logger Sungrow, a cada 5 min, viram EPISÓDIOS para a tela
 * "Alarmes e ocorrências" (Fase 2, 29/10/2026). Para o INVERSOR o logger é a fonte PRIORITÁRIA (decisão do humano, 28/10/2026); o
 * estado vindo do supervisório (lib-alarmes-scada) é a segunda rota, que confirma e dá a hora ao segundo. Função pura: o gerador
 * (gen-alarmes-logger.js) lista, lê e grava.
 *
 * O QUE ENTRA, por inversor e dia (CSV `HIS_<série>_…csv` do logger; coluna pelo NOME, como a lib-sungrow):
 *   código de falha  'Código de falha' ≠ 0. A família, o tipo (alarme: o inversor segue operando; falha: para e abre o relé CA) e a
 *                    origem (rede/equipamento) saem da TABELA DO FABRICANTE já transcrita na lib-sungrow (`familia`, manual do usuário
 *                    do SG350HX, seção 8.1); nas famílias por string, o número da string (532 = string 1, 536 = string 5, 571 = string 24).
 *   parada           'Status do dispositivo' indisponível sem código: 0x8000 parado, 0x1300 parada por chave, 0x1500 parada de
 *                    emergência, 0x2500 falha de comunicação (tabela de estados do inversor do registro técnico da usina). O 0x5500 (falha) vem com código de falha e o
 *                    episódio é o do código.
 * O episódio vai da primeira amostra com o valor até a primeira amostra com outro valor legível. A amostra ILEGÍVEL (vazia, sentinela,
 * 0xFFFE leitura inválida) não muda nada: falta de leitura não é fim de alarme. O que segue ativo na última amostra do dia fica sem fim
 * e COSTURA com o episódio do mesmo código que está ativo na primeira amostra do dia seguinte (o 532 retido a noite toda, 27–28/10/2026).
 * Sem o dia seguinte, segue sem fim.
 *
 * `pk`: a potência do inversor na amostra de entrada (kW). Mede o padrão do caso real de 28/10/2026 (conexão reversa da string 5 no
 * M2/TS1/INV06 e INV09, código 536, 17:55): o código entra com o inversor já sem geração e as correntes de string em 0 A, e não aparece
 * de dia. O número vai junto; a leitura é de quem analisa.
 *
 * AGRUPAMENTO: o mesmo código (mesma família e classe) em 3 inversores ou mais da mesma usina, em trecho contínuo com início a menos de
 * 10 min um do outro, vira UM grupo `inv: {TSn: ['01', …]}` (a mesma regra da lib-alarmes-scada; 27/10 17:11: código 10 nos inversores
 * do M7, M8 e M9 quando a barra 4 abriu).
 *
 * FORMATO (o da lib-alarmes-scada, para a tela ler as duas fontes do mesmo jeito): `eq` (tag → {u, n, pai}) e `msg` (CHAVES neutras: a
 * família do código ou o nome da parada; o texto de tela sai da página) no topo; cada evento {id, c, t, i, f|null, m, v: código ou estado,
 * s: string, o: origem, pk, fx: fim aproximado (dia sem leitura no meio), inv e k (grupo), str: {'TSn/nn': [strings]} (grupo de família
 * por string)}. c: inversor_falha · inversor_alarme · inversor_codigo (código fora do manual) · inversor_parada.
 * Inversor sem posição identificada (sg_ident.json) fica com a tag `SN:<série>` e a usina da pasta, fora dos grupos.
 *
 * O ARMAZÉM (interno): por mês, { esquema, dias: { 'AAAA-MM-DD': { <série>: { u, n, ev: [[cód, ini, fim|null, pk, a0]], st: [[estado,
 * ini, fim|null, a0]] } } } }, com `n` amostras lidas; no mesmo inversor-dia vindo de dois zips fica o de MAIS amostras (a regra do
 * gen-sungrow). Inversor-dia sem nenhum episódio guarda só u e n.
 */
const S = require('./lib-sungrow.js');

const ESQUEMA = 1;
const GRUPO_N = 3, GRUPO_MIN = 10;
// estados indisponíveis sem código de falha (tabela de estados do inversor do registro técnico da usina)
const PARADAS = new Map([[0x8000, 'parado'], [0x1300, 'parada_chave'], [0x1500, 'parada_emergencia'], [0x2500, 'falha_comunicacao']]);
const INVALIDO = 0xFFFE;
const COL = { cod: 'Código de falha', st: 'Status do dispositivo', p: 'Potência ativa total' };

// inteiro legível ou null (a sentinela da lib-sungrow é ilegível)
const inteiro = (s) => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const x = Number(t); return Number.isFinite(x) ? Math.trunc(x) : null; };
const exige = (cab, nome, onde) => { const i = S.col(cab, nome); if (i < 0) throw new Error(onde + ': coluna "' + nome + '" ausente'); return i; };

/* ---------------------------------------------------------------- um CSV de inversor -> episódios por dia ---------------- */
// trechos de um valor: amostras [{t, x}] com x null = ilegível (não muda nada); `ativo(x)` diz se o valor abre episódio.
// -> [[x, ini, fim|null, iAmostraIni]]; a0 = o trecho já está ativo na primeira amostra LEGÍVEL do dia
function trechos(am, ativo) {
  const out = []; let cur = null, primeira = true;
  for (let k = 0; k < am.length; k += 1) {
    const { t, x } = am[k];
    if (x == null) continue;
    if (cur && cur.x === x) { primeira = false; continue; }
    if (cur) { cur.fim = t; out.push(cur); cur = null; }
    if (ativo(x)) cur = { x, ini: t, fim: null, k, a0: primeira };
    primeira = false;
  }
  if (cur) out.push(cur);
  return out;
}
function diaAlarmes(cab, linhas, onde) {
  const c = { cod: exige(cab, COL.cod, onde), st: exige(cab, COL.st, onde), p: exige(cab, COL.p, onde) };
  const dias = new Map();
  for (const v of linhas) {
    const m = String(v[0]).trim().match(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d)/);
    if (!m) continue;
    (dias.get(m[1]) || dias.set(m[1], []).get(m[1])).push({ t: m[2], v });
  }
  const out = [];
  for (const [d, L] of dias) {
    L.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
    const cod = L.map(({ t, v }) => { const x = S.num(v[c.cod]); return { t, x: x == null ? null : Math.trunc(x) }; });
    const st = L.map(({ t, v }) => { const x = inteiro(v[c.st]); return { t, x: x == null || x === INVALIDO ? null : x }; });
    const kw = (k) => { const x = S.num(L[k].v[c.p]); return x == null ? null : Math.round(x / 100) / 10; };
    const ev = trechos(cod, (x) => x !== 0).map((e) => [e.x, e.ini, e.fim, kw(e.k), e.a0 ? 1 : 0]);
    // a parada sem código: o 0x5500 fica de fora (o código de falha dele já é episódio)
    const pa = trechos(st, (x) => PARADAS.has(x)).map((e) => [e.x, e.ini, e.fim, e.a0 ? 1 : 0]);
    out.push({ d, n: L.length, ev, st: pa });
  }
  return out;
}

/* ---------------------------------------------------------------- o armazém ------------------------------------------------ */
// funde os inversor-dias lidos no armazém do mês: fica o de MAIS amostras. dias: [{d, n, ev, st}] · u: usina da pasta
// -> as datas que mudaram
function junta(arm, sn, u, dias) {
  const mudou = [];
  for (const x of dias) {
    const D = arm.dias[x.d] || (arm.dias[x.d] = {});
    const a = D[sn];
    if (a && a.n >= x.n) continue;
    const r = { u, n: x.n }; if (x.ev.length) r.ev = x.ev; if (x.st.length) r.st = x.st;
    D[sn] = r; mudou.push(x.d);
  }
  return mudou;
}
const armVazio = () => ({ esquema: ESQUEMA, dias: {} });

/* ---------------------------------------------------------------- composição ----------------------------------------------- */
const diaMais = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const iso = (d, hm) => d + 'T' + hm + ':00';
const ms = (s) => Date.parse(s + '-03:00');

// os episódios de UMA série ao longo dos dias, costurados na virada. dias: {d: rec} -> [{tipo:'cod'|'st', x, i, f, pk}]
function costura(porDia) {
  const ds = Object.keys(porDia).sort();
  const out = [], abertos = new Map();   // 'cod|x' -> episódio sem fim do dia anterior
  for (const d of ds) {
    const r = porDia[d], vindo = new Map(), usados = new Set();
    const usa = (tipo, x, ini, fim, a0, pk) => {
      const k = tipo + '|' + x, ant = abertos.get(k);
      let e;
      if (a0 && ant && ant.d === diaMais(d, -1)) { e = ant.e; e.f = fim == null ? null : iso(d, fim); usados.add(k); }
      else { e = { tipo, x, i: iso(d, ini), f: fim == null ? null : iso(d, fim), pk }; out.push(e); }
      if (fim == null) vindo.set(k, { d, e });
    };
    for (const [x, ini, fim, pk, a0] of r.ev || []) usa('cod', x, ini, fim, a0, pk);
    for (const [x, ini, fim, a0] of r.st || []) usa('st', x, ini, fim, a0, null);
    // o que estava ativo no fim do último dia lido e não está no começo deste terminou na virada: fim = 00:00 deste dia. Com dia SEM
    // leitura no meio, o fim é desconhecido dentro do vão: o mesmo 00:00, marcado `fx` (fim aproximado)
    for (const [k, ant] of abertos) if (!usados.has(k)) { ant.e.f = iso(d, '00:00'); if (ant.d !== diaMais(d, -1)) ant.e.fx = 1; }
    abertos.clear(); for (const [k, v] of vindo) abertos.set(k, v);
  }
  return out;
}

function classeDe(tipo, x) {
  if (tipo === 'st') return { c: 'inversor_parada', m: PARADAS.get(x) };
  const f = S.familia(x);
  return { c: f.tipo === 'alarme' ? 'inversor_alarme' : f.tipo === 'falha' ? 'inversor_falha' : 'inversor_codigo', m: f.fam, s: f.string, o: f.origem };
}

// arms: armazéns de meses consecutivos (o anterior à janela entra para costurar a virada); ident: {série: {pos}}
// -> o objeto publicado da janela [de, ate]
function compoe(arms, ident, de, ate, { gerado = null } = {}) {
  const porSn = new Map(), diasCom = new Set();
  for (const a of arms) for (const [d, D] of Object.entries(a.dias || {})) {
    if (d >= de && d <= ate && Object.keys(D).length) diasCom.add(d);
    for (const [sn, r] of Object.entries(D)) { const o = porSn.get(sn) || porSn.set(sn, { u: r.u, dias: {} }).get(sn); o.dias[d] = r; o.u = r.u || o.u; }
  }
  const iniJ = de + 'T00:00:00', fimJ = ate + 'T23:59:59';
  const eps = [], eq = {};
  for (const [sn, o] of porSn) {
    const pos = ident && ident[sn] && ident[sn].pos;
    const tag = pos || 'SN:' + sn, u = pos ? pos.split('/')[0] : o.u;
    for (const e of costura(o.dias)) {
      if ((e.f || fimJ) < iniJ || e.i > fimJ) continue;
      const k = classeDe(e.tipo, e.x);
      eq[tag] = { u, n: 'inversor', pai: pos ? pos.split('/').slice(0, 2).join('/') : u };
      eps.push({ ...k, t: tag, u, pos: !!pos, i: e.i, f: e.f, v: e.x, pk: e.pk, fx: e.fx });
    }
  }
  // grupos: classe + usina + chave, trecho contínuo, só inversor com posição
  const grupos = [], dentro = new Set(), cur = new Map();
  for (const e of eps.filter((x) => x.pos).sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : 0))) {
    const ch = e.c + '|' + e.u + '|' + e.m;
    let g = cur.get(ch);
    if (!g || ms(e.i) > g.ult + GRUPO_MIN * 60000) { g = { e0: e, mem: [], ult: 0 }; cur.set(ch, g); grupos.push(g); }
    g.mem.push(e); g.ult = ms(e.i);
  }
  const lista = [];
  for (const g of grupos) {
    if (new Set(g.mem.map((e) => e.t)).size < GRUPO_N) continue;
    const inv = {}, str = {};
    for (const e of g.mem) {
      const [, ts, iv] = e.t.split('/'); (inv[ts] = inv[ts] || []).includes(iv.slice(3)) || inv[ts].push(iv.slice(3)); dentro.add(e);
      if (e.s != null) { const k = ts + '/' + iv.slice(3); (str[k] = str[k] || []).includes(e.s) || str[k].push(e.s); }
    }
    Object.values(inv).forEach((l) => l.sort());
    const f = g.mem.some((e) => !e.f) ? null : g.mem.reduce((a, e) => (e.f > a ? e.f : a), g.mem[0].f);
    const e0 = g.e0;
    eq[e0.u] = { u: e0.u, n: 'usina', pai: 'Complexo' };
    lista.push({ c: e0.c, t: e0.u, i: g.mem[0].i, f, m: e0.m, o: e0.o, k: g.mem.length, inv, str: Object.keys(str).length ? str : undefined,
      v: [...new Set(g.mem.map((e) => e.v))].length === 1 ? e0.v : undefined });
  }
  for (const e of eps) if (!dentro.has(e)) lista.push(e);
  const msg = [], mi = new Map();
  const idx = (m) => { if (!mi.has(m)) { mi.set(m, msg.length); msg.push(m); } return mi.get(m); };
  const ev = lista.sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).map((e) => {
    const o = { id: e.c + ':' + e.t + ':' + e.i + ':' + e.m + (e.v != null ? ':' + e.v : ''), c: e.c, t: e.t, i: e.i, f: e.f, m: idx(e.m) };
    if (e.v != null) o.v = e.v; if (e.s != null) o.s = e.s; if (e.o) o.o = e.o; if (e.pk != null) o.pk = e.pk; if (e.fx) o.fx = 1;
    if (e.inv) { o.inv = e.inv; o.k = e.k; } if (e.str) o.str = e.str;
    return o;
  });
  for (const t of Object.keys(eq)) if (!ev.some((e) => e.t === t)) delete eq[t];
  const sem = [...porSn.keys()].filter((sn) => !(ident && ident[sn] && ident[sn].pos)).sort();
  return { esquema: ESQUEMA, fonte: 'logger', gerado, janela: { de, ate }, dias: [...diasCom].sort(), eq, msg, ev, sem_posicao: sem };
}

/* ---------------------------------------------------------------- o zip ----------------------------------------------------- */
// '28.10 A 28.10.zip' (coleta diária) ou '27.09 A 30.09 rec.zip' -> [ini, fim] em AAAA-MM-DD; o ano vem de fora (pasta do cofre). A
// faixa que vira o ano (28.12 A 03.01) põe o início no ano anterior. Nome fora da forma -> null (o gerador conta e não lê)
function faixaDoZip(nome, ano) {
  const m = nome.split('/').pop().match(/^(\d\d)\.(\d\d) A (\d\d)\.(\d\d)\b/);
  if (!m) return null;
  const fim = ano + '-' + m[4] + '-' + m[3];
  const ini = (m[2] > m[4] ? ano - 1 : ano) + '-' + m[2] + '-' + m[1];
  return [ini, fim];
}

module.exports = { ESQUEMA, PARADAS, COL, trechos, diaAlarmes, junta, armVazio, costura, classeDe, compoe, faixaDoZip, diaMais };
