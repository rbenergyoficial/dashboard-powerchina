'use strict';
/*
 * lib-analise-vivo.js — a Análise de dados AO VIVO (lote analise-ao-vivo, 07/11/2026; pedido do humano: alertas a cada 5 min, sem IA, a partir dos
 * medidores de 5 min). Função pura: recebe o `dados` cru da Way2 do dia, o registro da mesa (ppc_restricao.json) e o publicado; devolve ACHADOS.
 * Quem lê, funde e grava é o gen-analise-vivo.js. A tela de Alarmes mostra os achados como fonte "Análise"; a voz vem pela lib-alarmes-eventos.
 *
 * Três detectores (protótipo e medição em Portal_Aurora/lotes/analise-inteligente/LEIA.md):
 *
 * D1 · LIBERADO E NÃO RECUPEROU. A mesa registra a volta à potência plena (ppc_restricao.json, evento com restr = 0 depois de restr = 1 no dia). Se
 *   a potência do Complexo (ponto 6233) ficar PLANA (faixa ≤ PLANO_MW em SLOTS slots seguidos) e NO VALOR que estava pedido antes da liberação
 *   (±NO_PEDIDO), entre ESPERA_MIN e JANELA_MIN depois dela (ou até a próxima restrição da mesa), é o controle que ficou no valor antigo.
 *   Nuvem não faz isso: com nuvem a potência oscila; no teto do parque ela fica plana, mas ACIMA do pedido antigo (06/11: 341 MW contra 330).
 *   Não vale quando o pedido antigo já estava no teto observado (nada a distinguir).
 * D4 · OCORRÊNCIA AGRUPADA. Os episódios de circuito aberto e sem tensão (a regra da lib-alarme-circuito, a mesma do alarmes_way2.json) que
 *   começam no mesmo slot viram UM achado: o trafo ou a SE sem tensão com os circuitos dele (21/09: o 04T2 e os 11 circuitos da barra), ou dois
 *   ou mais circuitos abertos juntos sem pai (27/10 06:25: M7C1 e M9C1). Circuito sozinho não vira achado: a linha da Medição já é ele.
 *   E o circuito ENERGIZADO sem geração: com o Complexo acima de COMPLEXO_MIN da plena, o circuito abaixo de FRAC_IRMAO da mediana dos irmãos
 *   da mesma usina (ou, sem irmão gerando, abaixo de FRAC_COMPLEXO da razão do Complexo) por SLOTS slots, sem estar aberto nem sem tensão
 *   (inversores do circuito parados com o disjuntor fechado).
 * D5 · MEDIDOR SEM DADO. SLOTS slots seguidos sem valor de um ponto entre 06:00 e 18:00, com o Complexo presente, contando só o slot que fechou há
 *   mais de LATENCIA_MIN (a Way2 enche o slot novo em ~15 min, medido em 15/08/2026: 10 de 25 medidores às 18:25 e 24 de 25 às 18:05). O gerador
 *   suprime o que a queda de comunicação do way2_saude (medidor_com do alarmes_way2.json) já mostra.
 *
 * Limiares (nenhum de norma; todos do próprio parque, método e números no LEIA.md do lote):
 *   PLANO_MW: P99 da faixa de 15 min (3 slots) do Complexo com a mesa pedindo restrição e a potência a ±2 % do pedido (o controle segurando),
 *             02/09 a 06/11/2026. Ver CALIBRACAO.
 *   TETO_MW:  P99 do Complexo nas meias horas SEM restrição de 02/09 a 31/10/2026 (341,1 MW): o máximo que o parque entrega.
 *   COMPLEXO_MIN, FRAC_IRMAO, FRAC_COMPLEXO: frações da própria medição (o circuito contra os irmãos no mesmo slot); em 20–26 e 28–31/10 e
 *             01–06/11, 0 achados; em 21/09 e 27/10, os eventos reais.
 * Estado (histerese): o id vem do início do episódio; a rodada refaz o dia inteiro e o mesmo episódio sai com o mesmo id, então nada se repete a
 * cada 5 min. D1 fecha quando a potência passa do pedido antigo × 1,02 em 2 slots seguidos; D4/D5 fecham no primeiro slot normal.
 *
 * Carimbo da Way2 = BORDA DIREITA do slot, hora de Brasília.
 */
const C = require('./lib-alarme-circuito');

const ESQUEMA = 1;
const PLENA_MW = 343.77;
const CAP = Object.freeze({ M1: 49.110, M2: 24.555, M3: 49.110, M4: 49.110, M5: 49.110, M6: 49.110, M7: 14.733, M8: 49.110, M9: 9.822 });
const CIRC = Object.freeze({ M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211],
  M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] });
const PONTO_COMPLEXO = 6233;
const CALIBRACAO = Object.freeze({ de: '2026-09-08', ate: '2026-11-06', janelas_segurando: 2639, faixa_p50_mw: 0.11, faixa_p95_mw: 3.28, faixa_p99_mw: 5.74,
  metodo: 'faixa (máx − mín) de 3 slots de 5 min do Complexo, entre 08:00 e 16:00, com a mesa pedindo restrição e os 3 slots a ±2 % do pedido' });
const LIM = Object.freeze({
  SLOT_MS: 5 * 60 * 1000,
  SLOTS: 3,               // 15 min
  LATENCIA_MIN: 20,       // a Way2 enche o slot novo em ~15 min
  ESPERA_MIN: 10,         // a rampa depois da liberação (06/11: 336 MW em 12:55, 340 em 13:00, liberado às 12:57)
  JANELA_MIN: 90,         // D1 olha até 90 min depois da liberação
  PLANO_MW: 3.28,         // P95 da faixa de 15 min com o controle segurando o pedido (CALIBRACAO)
  NO_PEDIDO: 0.02,        // "no valor pedido antes" = a ±2 %, a mesma régua da CALIBRACAO
  TETO_MW: 341.1,
  COMPLEXO_MIN: 0.30,
  FRAC_IRMAO: 0.02,
  FRAC_COMPLEXO: 0.10,
  IRMAO_MIN: 0.05,        // irmãos "gerando" = mediana acima de 5 % da fatia da usina por circuito
  H_INI: '06:00', H_FIM: '18:00',
});

const msBRT = C.msBRT, isoBRT = C.isoBRT;
const hhmm = (ms) => isoBRT(ms).slice(11, 16);
const med = (v) => { const s = v.slice().sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const r1 = (v) => Math.round(v * 10) / 10;

/* a potência ativa (kW) de cada ponto, pelo carimbo (borda direita): Map(ms → kW), só qualidade 0 */
function potencias(dados) {
  const out = {};
  for (const s of dados || []) {
    if (s.nomeGrandeza !== 'Demat') continue;
    const m = out[s.pontoId] || (out[s.pontoId] = new Map());
    for (const v of s.valores || []) if (v.qualidade === 0 && typeof v.valor === 'number' && isFinite(v.valor)) m.set(msBRT(v.data), v.valor);
  }
  return out;
}

/* os slots fechados há mais de LATENCIA_MIN (o dia fechado: todos) */
const fechado = (t, agoraMs, L) => agoraMs == null || t <= agoraMs - L.LATENCIA_MIN * 60e3;

// ─────────────── D1 ───────────────
function liberacoes(eventosMesa, dia) {
  const ev = (eventosMesa || []).filter((x) => x.dia === dia).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const out = []; let ant = null;
  ev.forEach((x, k) => {
    if (x.restr) { ant = x; return; }
    if (!ant) return;
    const prox = ev.slice(k + 1).find((y) => y.restr);   // a próxima restrição encerra a janela (28/10: liberado às 11:18, 270 MW às 11:20)
    out.push({ ts: x.ts, ms: msBRT(x.ts.replace(' ', 'T') + ':00'), pot_ant: ant.pot, mesa_ant: ant.ts, ate_ms: prox ? msBRT(prox.ts.replace(' ', 'T') + ':00') : Infinity });
    ant = null;
  });
  return out;
}

function d1(P, eventosMesa, dia, agoraMs, L = LIM, ocorrencias = []) {
  const tot = P[PONTO_COMPLEXO]; if (!tot) return [];
  const out = [];
  for (const lb of liberacoes(eventosMesa, dia)) {
    if (lb.pot_ant >= L.TETO_MW * 0.99) continue;
    const t0 = lb.ms + L.ESPERA_MIN * 60e3, t1 = Math.min(lb.ms + L.JANELA_MIN * 60e3, lb.ate_ms);
    /* circuito aberto ou barra sem tensão na janela explica a potência baixa e já é alarme (21/09: liberado às 14:06, o 04T2 caiu às 14:10) */
    if (ocorrencias.some((e) => msBRT(e.ini) < t1 && (e.fim ? msBRT(e.fim) : Infinity) > lb.ms)) continue;
    const sl = [...tot.entries()].filter(([t]) => t - L.SLOT_MS >= t0 && t <= t1 && fechado(t, agoraMs, L)).sort((a, b) => a[0] - b[0]);
    let ini = null, fim = null, preso = [], volta = 0;
    for (let k = 0; k + L.SLOTS <= sl.length; k++) {
      const w = sl.slice(k, k + L.SLOTS).map((x) => x[1] / 1000), mx = Math.max(...w), mn = Math.min(...w);
      const m = w.reduce((s, x) => s + x, 0) / w.length;
      if (ini == null && mx - mn <= L.PLANO_MW && Math.abs(m - lb.pot_ant) <= L.NO_PEDIDO * lb.pot_ant) { ini = sl[k][0] - L.SLOT_MS; preso = w; }
    }
    if (ini == null) continue;
    const depois = [...tot.entries()].filter(([t]) => t > ini && fechado(t, agoraMs, L)).sort((a, b) => a[0] - b[0]);
    for (const [t, v] of depois) { if (t > lb.ate_ms) { fim = lb.ate_ms; break; } if (v / 1000 > lb.pot_ant * (1 + L.NO_PEDIDO)) { if (++volta >= 2) { fim = t; break; } } else volta = 0; }
    const mw = r1(preso.reduce((s, x) => s + x, 0) / preso.length);
    out.push({ id: 'liberado_nao_recuperou:Complexo:' + lb.ts.replace(' ', 'T'), tipo: 'liberado_nao_recuperou', p: 2, tag: 'Complexo', u: 'SE',
      ini: isoBRT(ini), fim: fim == null ? null : isoBRT(fim),
      ev: { liberacao: lb.ts, pedido_antes_mw: lb.pot_ant, potencia_mw: mw, teto_mw: L.TETO_MW, deficit_mw: r1(L.TETO_MW - mw) },
      texto: 'Liberado às ' + lb.ts.slice(11, 16) + ' e a potência ficou em ' + String(mw).replace('.', ',') + ' MW, no valor pedido antes (' + String(lb.pot_ant).replace('.', ',') + ' MW)',
      fala: 'Atenção: liberado às ' + lb.ts.slice(11, 16) + ', mas a potência do complexo não voltou. Conferir o controle de potência.', voz: true });
  }
  return out;
}

// ─────────────── D4 ───────────────
function agrupados(dados, agoraMs, L = LIM) {
  const eps = C.detecta(dados).filter((e) => fechado(msBRT(e.ini) + L.SLOT_MS, agoraMs, L));
  const out = [], usado = new Set();
  const ordem = { se_sem_tensao: 0, trafo_sem_tensao: 1 };
  for (const e of eps.filter((x) => (x.filhos || []).length).sort((a, b) => (ordem[a.regra] ?? 9) - (ordem[b.regra] ?? 9))) {
    if (usado.has(e.id)) continue;   // o trafo que já está dentro da SE sem tensão
    const filhos = [];
    const junta = (id) => { const f = eps.find((x) => x.id === id); if (!f) return; usado.add(f.id); if ((f.filhos || []).length) f.filhos.forEach(junta); else filhos.push(f.tag); };
    usado.add(e.id); e.filhos.forEach(junta);
    out.push({ id: 'ocorrencia:' + e.id, tipo: 'ocorrencia_agrupada', p: 1, tag: e.tag, u: 'SE', ini: e.ini_est || e.ini, fim: e.fim || null,
      ev: { regra: e.regra, circuitos: filhos.sort(), n: filhos.length },
      texto: (e.regra === 'se_sem_tensao' ? 'Subestação' : 'Transformador ' + e.tag) + ' sem tensão: ' + filhos.length + ' circuitos (' + filhos.sort().join(', ') + ')', voz: false });
  }
  const soltos = eps.filter((x) => !usado.has(x.id) && !x.pai && x.regra === 'cto_aberto');
  const porSlot = new Map();
  for (const e of soltos) { const k = Math.round(msBRT(e.ini) / L.SLOT_MS); const g = [...porSlot.keys()].find((x) => Math.abs(x - k) <= 1); porSlot.set(g != null ? g : k, (porSlot.get(g != null ? g : k) || []).concat([e])); }
  for (const g of porSlot.values()) {
    if (g.length < 2) continue;
    const ini = g.map((x) => x.ini_est || x.ini).sort()[0], abertos = g.some((x) => !x.fim), fim = abertos ? null : g.map((x) => x.fim).sort().slice(-1)[0];
    const tags = g.map((x) => x.tag).sort();
    out.push({ id: 'ocorrencia:cto_aberto:' + tags.join('+') + ':' + ini, tipo: 'ocorrencia_agrupada', p: 2, tag: tags.length > 4 ? tags.length + ' circuitos' : tags.join(' + '), u: 'SE', ini, fim,
      ev: { regra: 'cto_aberto', circuitos: tags, n: tags.length }, texto: tags.length + ' circuitos abertos juntos (' + tags.join(', ') + ')', voz: false });
  }
  return out;
}

function semGeracao(P, dados, agoraMs, L = LIM) {
  const tot = P[PONTO_COMPLEXO]; if (!tot) return [];
  const S = C.serieDosDados(dados), out = [];
  const estado = (pid, t) => { const s = S[pid] && S[pid].get(t); return s ? C.estadoSlot(s, C.V_NOM.circuito) : null; };
  for (const [u, ps] of Object.entries(CIRC)) {
    for (const p of ps) {
      const tag = C.PID[p]; let run = [];
      const fecha = (fimMs) => {
        if (run.length >= L.SLOTS) out.push({ id: 'circuito_sem_geracao:' + tag + ':' + isoBRT(run[0] - L.SLOT_MS), tipo: 'circuito_sem_geracao', p: 3, tag, u,
          ini: isoBRT(run[0] - L.SLOT_MS), fim: fimMs == null ? null : isoBRT(fimMs), ev: { slots: run.length },
          texto: 'Circuito ' + tag + ' energizado e sem geração, com os outros gerando', fala: 'Atenção: ' + tag.replace(/^M(\d)C(\d)$/, 'Mauriti $1, circuito $2') + ' energizado e sem geração.', voz: true });
        run = [];
      };
      const ts = [...tot.keys()].sort((a, b) => a - b);
      for (const t of ts) {
        if (!fechado(t, agoraMs, L) || hhmm(t) <= L.H_INI || hhmm(t) > L.H_FIM) continue;
        const c = tot.get(t) / 1000;
        if (c < L.COMPLEXO_MIN * PLENA_MW) { if (run.length) fecha(run[run.length - 1]); continue; }
        const v = (P[p] || new Map()).get(t);
        const st = estado(p, t);
        if (v == null || st === 'aberto' || st === 'sem_tensao') { if (run.length) fecha(run[run.length - 1]); continue; }
        const irm = ps.filter((q) => q !== p).map((q) => (P[q] || new Map()).get(t)).filter((x) => x != null);
        const mi = irm.length ? med(irm) : null;
        const baixo = mi != null && mi / 1000 > L.IRMAO_MIN * CAP[u] / ps.length ? v < L.FRAC_IRMAO * mi : (v / 1000 / CAP[u]) < L.FRAC_COMPLEXO * (c / PLENA_MW);
        if (baixo) run.push(t); else if (run.length) fecha(t);
      }
      if (run.length) fecha(null);
    }
  }
  /* os circuitos da MESMA usina que param juntos (±1 slot) são um achado só */
  const g = [];
  for (const a of out.sort((x, y) => (x.ini < y.ini ? -1 : 1))) {
    const k = g.find((x) => x.u === a.u && Math.abs(msBRT(x.ini) - msBRT(a.ini)) <= L.SLOT_MS);
    if (!k) { g.push({ ...a, circ: [a.tag] }); continue; }
    k.circ.push(a.tag); if (a.fim == null || (k.fim != null && a.fim > k.fim)) k.fim = a.fim;
  }
  return g.map((a) => { const { circ, ...o } = a; if (circ.length < 2) return o;
    const tags = circ.sort();
    return { ...o, id: 'circuito_sem_geracao:' + a.u + ':' + a.ini, tag: tags.join(' + '), ev: { ...o.ev, circuitos: tags, n: tags.length },
      texto: a.u + ': ' + tags.length + ' circuitos energizados e sem geração (' + tags.join(', ') + '), com as outras usinas gerando',
      fala: 'Atenção: ' + a.u.replace(/^M(\d)$/, 'Mauriti $1') + ', ' + tags.length + ' circuitos energizados e sem geração.' }; });
}

// ─────────────── D5 ───────────────
function semDado(P, agoraMs, L = LIM) {
  const tot = P[PONTO_COMPLEXO]; if (!tot) return [];
  const ts = [...tot.keys()].sort((a, b) => a - b).filter((t) => fechado(t, agoraMs, L) && hhmm(t) > L.H_INI && hhmm(t) <= L.H_FIM);
  const out = [];
  for (const [u, ps] of Object.entries(CIRC)) for (const p of ps) {
    const tag = C.PID[p]; let run = [];
    const fecha = (fimMs) => { if (run.length >= L.SLOTS) out.push({ id: 'medidor_sem_dado:' + tag + ':' + isoBRT(run[0] - L.SLOT_MS), tipo: 'medidor_sem_dado', p: 3, tag, u, pid: p,
      ini: isoBRT(run[0] - L.SLOT_MS), fim: fimMs == null ? null : isoBRT(fimMs), ev: { slots: run.length }, texto: 'Medidor do ' + tag + ' sem dado com os outros chegando', voz: false }); run = []; };
    for (const t of ts) { if (!(P[p] && P[p].has(t))) run.push(t); else if (run.length) fecha(t); }
    if (run.length) fecha(null);
  }
  return out;
}

/* a rodada: o dia da cópia local inteiro. `medidorCom`: a queda de comunicação já publicada (suprime o D5 do mesmo ponto no mesmo intervalo) */
function analisa({ dados, mesa, dia, agoraMs = null, medidorCom = [], L = LIM }) {
  const P = potencias(dados);
  const sob = (a, b) => msBRT(a.ini) < (b.fim ? msBRT(b.fim) : Infinity) && msBRT(b.ini) < (a.fim ? msBRT(a.fim) : Infinity);
  const d5 = semDado(P, agoraMs, L).filter((a) => !(medidorCom || []).some((m) => m.pid === a.pid && sob(a, m)));
  const eps = C.detecta(dados);
  return [...d1(P, mesa, dia, agoraMs, L, eps), ...agrupados(dados, agoraMs, L), ...semGeracao(P, dados, agoraMs, L), ...d5].sort((a, b) => (a.ini < b.ini ? -1 : 1));
}

/* junta com o publicado: a rodada refaz o dia dela (sai do publicado o que começou nele); os dias anteriores ficam até JANELA_DIAS depois do fim */
function funde(publicados, novos, dia, agoraMs, janelaDias = 7) {
  const lim = agoraMs - janelaDias * 86400e3;
  const antes = (publicados || []).filter((a) => a.ini.slice(0, 10) !== dia && (a.fim == null || msBRT(a.fim) >= lim));
  const vistos = new Map((publicados || []).map((a) => [a.id, a.visto]));
  /* o que vinha aberto da véspera e continua no primeiro slot do dia é o MESMO achado: herda id, início e visto; o novo dá o fim */
  const zero = dia + 'T00:00';
  const segue = novos.filter((n) => n.ini.slice(0, 16) === zero);
  const ficam = antes.map((a) => { if (a.fim != null) return a; const n = segue.find((x) => x.tipo === a.tipo && x.tag === a.tag); if (!n) return a; n._herdado = 1; return { ...a, fim: n.fim }; });
  const novos2 = novos.filter((n) => !n._herdado).map((a) => ({ ...a, visto: vistos.get(a.id) || new Date(agoraMs).toISOString() }));
  novos.forEach((n) => { delete n._herdado; });
  return [...ficam, ...novos2].sort((a, b) => (a.ini < b.ini ? 1 : a.ini > b.ini ? -1 : a.id < b.id ? -1 : 1));
}

function guarda(achados) {
  const ids = achados.map((a) => a.id);
  if (new Set(ids).size !== ids.length) throw new Error('lib-analise-vivo: achado repetido');
  for (const a of achados) {
    if (![1, 2, 3].includes(a.p)) throw new Error('lib-analise-vivo: prioridade fora de 1–3: ' + a.id);
    if (!a.texto) throw new Error('lib-analise-vivo: achado sem texto: ' + a.id);
    if (a.voz && !a.fala) throw new Error('lib-analise-vivo: voz sem fala: ' + a.id);
  }
  return achados;
}

module.exports = { ESQUEMA, LIM, CAP, CIRC, PLENA_MW, PONTO_COMPLEXO, CALIBRACAO, potencias, liberacoes, d1, agrupados, semGeracao, semDado, analisa, funde, guarda };
