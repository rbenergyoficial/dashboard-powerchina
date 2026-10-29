'use strict';
/*
 * lib-alarme-circuito.js — disjuntor de circuito de 34,5 kV ABERTO e barra/trafo SEM TENSÃO, deduzidos dos medidores Way2 de 5 min
 * (Fase 1 da tela "Alarmes e ocorrências", 28/10/2026). Função pura: recebe o `dados` cru da Way2 (o mesmo do way2_eletrico.json e do
 * hist/way2_<dia>.json) e devolve EPISÓDIOS. Quem lê o blob, funde com o publicado e grava é o gerador.
 *
 * A Way2 NÃO publica estado de disjuntor: isto é INFERÊNCIA. O estado vem do supervisório (tabela de alarmes do E3, D+1); evento só
 * daqui é "a conferir", e E3 + Way2 é "confirmado" (fonte por grandeza).
 *
 * A REGRA (medição de 91 dias de hist/way2, jul/2025–out/2026):
 *   slot ABERTO  = qualidade 0 nas 7 grandezas usadas E |Q| < Q_KVAR E |P| < P_KW E máx(Ia,Ib,Ic) < I_A E V > V_PU_MIN da nominal.
 *     - com o disjuntor aberto o medidor devolve ZERO literal em P e Q e ≤ 0,09 A nas fases (ruído);
 *     - energizado, o circuito nunca teve |P| < 1 kW e |Q| < 1 kvar juntos (0 casos), e a menor corrente medida foi 0,21 A;
 *     - a TENSÃO NÃO CAI: o TP fica na barra. Ela separa barra viva (circuito aberto) de barra morta (sem tensão);
 *     - SÓ P≈0 NÃO SERVE: 910 slots energizados com P zerado (noite, corte a zero do ONS), todos com corrente e reativo do cabo.
 *   slot SEM TENSÃO = qualidade 0 E P, Q, I abaixo dos mesmos pisos E V < V_PU_MIN (barra ou trafo desenergizado).
 *   EPISÓDIO = SLOTS_MIN slots seguidos no mesmo estado: o slot da manobra é média PARCIAL (21/09: 0,83 A e 47 kvar no 14:15).
 *   O instante estimado sai do slot parcial anterior: P_parcial ÷ P_anterior × 300 s depois do início dele (21/09: ~38 s; campo 36 s).
 * O que a regra NÃO pega, de propósito: rede aberta a jusante com o disjuntor fechado (M8C1 29/01/2026, 0,1–0,3 A e −10 kvar: Q ≠ 0).
 * TC em curto ou bloco de teste dá a mesma assinatura do aberto; quem separa é o balanço trafo × soma dos circuitos de dia (fora daqui).
 *
 * Carimbo da Way2 = BORDA DIREITA do intervalo, hora local da usina (BRT, sem fuso no texto). `ini` = início do 1º slot no estado;
 * `fim` = borda direita do último slot no estado (o fechamento aconteceu dentro do slot seguinte); `fim` null = ainda no estado no
 * último slot lido.
 */

// ---- pisos (fonte: medição de 91 dias de hist/way2, jul/2025–out/2026; ver o cabeçalho) ----
const LIMITES = Object.freeze({
  P_KW: 0.5,          // |P| abaixo disto = zero (energizado nunca < 1 kW junto com |Q| < 1 kvar)
  Q_KVAR: 0.5,        // |Q| abaixo disto = zero (com P ≠ 0 nunca houve Q = 0)
  I_A: 0.15,          // máx das 3 fases: ruído do zero ≤ 0,09 A; energizado ≥ 0,21 A
  V_PU_MIN: 0.8,      // 0,8 pu: acima = barra viva (aberto), abaixo = sem tensão
  SLOTS_MIN: 2,       // slots seguidos para abrir episódio (o slot da manobra é parcial)
  SLOT_MS: 5 * 60 * 1000,
});
// tensão nominal FASE-NEUTRO do medidor (a Way2 publica TensaoA/B/C fase-neutro em V)
const V_NOM = Object.freeze({ circuito: 34500 / Math.sqrt(3), trafo: 230000 / Math.sqrt(3) });

// ---- equipamentos (ordem usina/circuito conferida pela energia do dia; a mesma do lib-horas.js) ----
const CIRC = Object.freeze({ M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208],
  M5: [6209, 6210, 6211], M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] });
const TRAFO = Object.freeze({ 6196: '04T1', 6197: '04T2' });
const DO_TRAFO = Object.freeze({ '04T1': ['M1', 'M2', 'M5', 'M6'], '04T2': ['M3', 'M4', 'M7', 'M8', 'M9'] });
const GRANDEZAS = ['Demat', 'Demre', 'CorrenteA', 'CorrenteB', 'CorrenteC', 'TensaoA', 'TensaoB', 'TensaoC'];

// dicionário de equipamentos (vai no topo do blob como `eq`; cada evento leva só o tag)
const EQ = (() => {
  const eq = {}, pid = {};
  for (const [tr, usinas] of Object.entries(DO_TRAFO)) {
    eq[tr] = { u: 'SE', n: 'trafo', pai: 'SE' };
    for (const u of usinas) CIRC[u].forEach((p, i) => { const tag = u + 'C' + (i + 1); eq[tag] = { u, n: 'circuito', pai: tr }; pid[p] = tag; });
  }
  for (const [p, tr] of Object.entries(TRAFO)) pid[p] = tr;
  eq.SE = { u: 'SE', n: 'subestacao', pai: null };
  return { eq: Object.freeze(eq), pid: Object.freeze(pid) };
})();

const msBRT = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');
const isoBRT = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19);

// `dados` cru da Way2 → { pid: Map(ms → {P,Q,Ia,Ib,Ic,V,ok}) }. P em kW, Q em kvar, I em A, V = média das 3 fases (V).
function serieDosDados(dados) {
  const por = {};
  for (const s of dados || []) {
    if (!EQ.pid[s.pontoId] || !GRANDEZAS.includes(s.nomeGrandeza)) continue;
    const m = por[s.pontoId] || (por[s.pontoId] = new Map());
    for (const v of s.valores || []) {
      const t = msBRT(v.data); if (!isFinite(t)) continue;
      const r = m.get(t) || { t, n: 0, ruim: false };
      if (v.qualidade !== 0 || typeof v.valor !== 'number' || !isFinite(v.valor)) r.ruim = true;
      else { r[s.nomeGrandeza] = v.valor; r.n++; }
      m.set(t, r);
    }
  }
  const out = {};
  for (const [p, m] of Object.entries(por)) {
    out[p] = new Map([...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, r]) => {
      const ok = !r.ruim && r.n === GRANDEZAS.length;
      return [t, ok ? { t, ok, P: r.Demat, Q: r.Demre, Ia: r.CorrenteA, Ib: r.CorrenteB, Ic: r.CorrenteC,
        V: (r.TensaoA + r.TensaoB + r.TensaoC) / 3 } : { t, ok: false }];
    }));
  }
  return out;
}

// estado de UM slot: 'aberto' | 'sem_tensao' | 'normal' | null (sem dado completo: não confirma nem fecha episódio)
function estadoSlot(s, vNom, L = LIMITES) {
  if (!s || !s.ok) return null;
  const zero = Math.abs(s.P) < L.P_KW && Math.abs(s.Q) < L.Q_KVAR && Math.max(s.Ia, s.Ib, s.Ic) < L.I_A;
  if (!zero) return 'normal';
  return s.V > L.V_PU_MIN * vNom ? 'aberto' : 'sem_tensao';
}

const r1 = (v) => Math.round(v * 10) / 10, r2 = (v) => Math.round(v * 100) / 100;
function evid(s) { return s && s.ok ? { p_kw: r1(s.P), q_kvar: r1(s.Q), i_a: [r2(s.Ia), r2(s.Ib), r2(s.Ic)], v_kv: r2(s.V * Math.sqrt(3) / 1000) } : null; }

// episódios de um medidor. `abertos`: eventos do publicado ainda sem fim ({id, regra, tag, ini, slots}) — o que vinha aberto na
// virada da janela (meia-noite). Com o 1º slot VÁLIDO de hoje (estado não nulo) no MESMO estado, o episódio continua com o mesmo id e
// ini e basta 1 slot (já foi confirmado antes); em OUTRO estado, ele fecha com o mesmo id e fim = borda esquerda desse slot. Sem
// nenhum slot válido hoje, não se decide nada (fica aberto no publicado). Um slot sem dado no meio não fecha nem confirma; o
// episódio fecha no 1º slot em outro estado.
function episodios(pid, serie, { abertos = [], L = LIMITES } = {}) {
  const tag = EQ.pid[pid], nivel = EQ.eq[tag].n, vNom = nivel === 'trafo' ? V_NOM.trafo : V_NOM.circuito;
  const pre = nivel === 'trafo' ? 'trafo_' : 'cto_';
  const slots = [...serie.values()];
  const estados = slots.map((s) => estadoSlot(s, vNom, L));
  const k0 = estados.findIndex((st) => st !== null);             // 1º slot válido de hoje
  const ev = []; let cur = null, run = [], continua = null;
  for (const a of abertos.filter((x) => x.tag === tag)) {
    if (k0 < 0) continue;
    if (a.regra === pre + estados[k0]) continua = a;
    else { const { pai, filhos, ...resto } = a; ev.push({ ...resto, fim: isoBRT(slots[k0].t - L.SLOT_MS) }); }   // pai/filhos se refazem
  }
  const fecha = (fimMs) => {
    const cont = continua && run[0] === slots[k0] && continua.regra === pre + cur ? continua : null;
    if (cur && run.length >= (cont ? 1 : L.SLOTS_MIN)) {
      const regra = pre + cur;
      const ini = cont ? cont.ini : isoBRT(run[0].t - L.SLOT_MS);
      const e = { id: cont ? cont.id : regra + ':' + tag + ':' + ini, regra, tag, ini, fim: fimMs == null ? null : isoBRT(fimMs),
        slots: run.length, ev: evid(run[Math.floor(run.length / 2)]) };   // slots no estado DENTRO desta janela: a semente volta a cada
      // rodada do dia, e somar o da semente contaria o mesmo slot de novo; a duração sai de ini e fim
      // instante estimado pela fração de energia do slot parcial anterior (só na abertura vista aqui)
      const k = slots.indexOf(run[0]), par = slots[k - 1], ant = slots[k - 2];
      if (!cont && par && ant && par.ok && ant.ok && ant.P > 50 && par.P >= 0 && par.P < ant.P) {
        e.ini_est = isoBRT(par.t - L.SLOT_MS + Math.round((par.P / ant.P) * L.SLOT_MS));
        e.ev.antes = { p_kw: r1(ant.P), i_a: r2(Math.max(ant.Ia, ant.Ib, ant.Ic)) };
      }
      ev.push(e);
    }
    cur = null; run = [];
  };
  for (let k = 0; k < slots.length; k++) {
    const s = slots[k], st = estados[k];
    if (st === null) continue;                        // buraco: nem confirma nem fecha
    if (st === 'normal') { if (cur) fecha(run[run.length - 1].t); continue; }
    if (st !== cur) { if (cur) fecha(run[run.length - 1].t); cur = st; }
    run.push(s);
  }
  if (cur) fecha(null);                               // ainda no estado no último slot lido
  return ev;
}

// todos os medidores; o trafo sem tensão vira PAI dos circuitos dele que ficaram sem tensão no mesmo intervalo, e os dois trafos sem
// tensão juntos viram o pai "se_sem_tensao" (perda da LT e os dois 14T abertos não se separam só com a Way2).
function detecta(dados, opts = {}) {
  const S = serieDosDados(dados), todos = [];
  for (const [p, serie] of Object.entries(S)) todos.push(...episodios(Number(p), serie, opts));
  const sobrepoe = (a, b) => msBRT(a.ini) < (b.fim ? msBRT(b.fim) : Infinity) && msBRT(b.ini) < (a.fim ? msBRT(a.fim) : Infinity);
  const trafos = todos.filter((e) => e.regra === 'trafo_sem_tensao');
  for (const t of trafos) {
    t.filhos = todos.filter((e) => e.regra === 'cto_sem_tensao' && EQ.eq[e.tag].pai === t.tag && sobrepoe(e, t)).map((e) => e.id);
    t.filhos.forEach((id) => { todos.find((e) => e.id === id).pai = t.id; });
  }
  const t1 = trafos.filter((e) => e.tag === '04T1'), t2 = trafos.filter((e) => e.tag === '04T2');
  for (const a of t1) for (const b of t2) {
    if (!sobrepoe(a, b) || a.pai || b.pai) continue;
    const ini = msBRT(a.ini) > msBRT(b.ini) ? a.ini : b.ini;
    const fim = a.fim && b.fim ? (msBRT(a.fim) < msBRT(b.fim) ? a.fim : b.fim) : (a.fim || b.fim || null);
    const se = { id: 'se_sem_tensao:SE:' + ini, regra: 'se_sem_tensao', tag: 'SE', ini, fim, filhos: [a.id, b.id] };
    a.pai = b.pai = se.id; todos.push(se);
  }
  return todos.sort((a, b) => msBRT(a.ini) - msBRT(b.ini) || (a.id < b.id ? -1 : 1));
}

// junta o publicado e a rodada nova. A rodada recalcula a janela inteira (o dia de hoje), então ela SUBSTITUI a janela: sai do
// publicado todo evento com ini ≥ janelaIniMs (um episódio que mudou de início quando um slot provisório virou medido não pode deixar a
// versão velha para trás); os anteriores ficam, e os continuados/fechados na virada são trocados pelo mesmo id. Depois a janela de
// publicação poda o que terminou antes de desdeMs (o que está aberto nunca sai).
function funde(publicados, novos, desdeMs, janelaIniMs) {
  if (!isFinite(janelaIniMs)) throw new Error('lib-alarme-circuito: funde() sem o início da janela recalculada');
  const m = new Map();
  for (const e of publicados || []) if (msBRT(e.ini) < janelaIniMs) m.set(e.id, e);
  for (const e of novos || []) m.set(e.id, e);
  return [...m.values()].filter((e) => (e.fim ? msBRT(e.fim) : Infinity) >= desdeMs)
    .sort((a, b) => msBRT(a.ini) - msBRT(b.ini) || (a.id < b.id ? -1 : 1));
}

module.exports = { LIMITES, V_NOM, EQ: EQ.eq, PID: EQ.pid, serieDosDados, estadoSlot, episodios, detecta, funde, msBRT, isoBRT };
