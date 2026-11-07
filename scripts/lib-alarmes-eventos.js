'use strict';
/*
 * lib-alarmes-eventos.js — a lista curta do que aconteceu agora, para a voz e para a ponte (`alarmes/eventos.json`, lote alarmes-eventos, 06/11/2026).
 * Função pura: recebe o alarmes_way2.json, o alarmes_scada.json, o alarmes_logger.json e o publicado; quem lê e grava é o gen-alarmes-eventos.js.
 *
 * Decisões do humano (05/11/2026): a ponte liga SÓ quando a medição acusar o evento; a voz fala Crítica, Alta e Média, em duas etapas (o fato pela medição, a causa pelo
 * supervisório), e NUNCA fala evento a conferir. Baixa fica só na tela.
 *
 * Medição: a Way2 não publica estado de disjuntor; o evento dela é INFERÊNCIA, e a fala diz "a medição indica". Sem tensão na SE e no trafo = Crítica (humano, 06/11/2026);
 * circuito aberto = Alta (34,5 kV, tabela do humano); circuito sem tensão sem pai = Alta (34,5 kV, humano, 06/11/2026). Queda de medidor = Média, sem
 * ponte e sem causa a buscar.
 * Mesmo evento: o id vem do início do episódio, e o início de hoje pode andar quando o slot provisório vira medido. Por isso o evento de mesmo tipo e tag que se sobrepõe ao
 * publicado HERDA o id: a voz e a ponte não repetem.
 * Causa: a do supervisório, em até 2 slots de 5 min do início do evento (o início da medição cai num slot: 1 de folga de cada lado). Proteção vem antes de disjuntor. No
 * circuito, a usina ou o trafo dele; no trafo, ele; na SE, a SE. Sem causa com o supervisório cobrindo o dia, a pendência fecha sem causa.
 * Supervisório e logger chegam com atraso (D+1): vão agrupados por classe e minuto, na tela e sem voz; o dia vira um só `voz_resumo` (humano, 06/11/2026).
 * Análise ao vivo (analise-ao-vivo, 07/11/2026): os achados do analise_vivo.json entram com a fonte 'analise', a prioridade que o achado traz e a fala que ele
 * escreveu; só fala o achado que pede voz (o agrupado não fala: a medição já falou o trafo ou a SE). Nunca liga a ponte.
 */

const ESQUEMA = 1;
const JANELA_DIAS = 7;
const A_CONFERIR_H = 24;   // a mesma régua do supervisório (lib-alarmes-scada, EEMUA 191)
const SLOT_MS = 5 * 60 * 1000;
const CAUSA_SLOTS = 2;
const SEV_MED = Object.freeze({ se_sem_tensao: 1, trafo_sem_tensao: 1, cto_aberto: 2, cto_sem_tensao: 2 });
const SEV_NOME = Object.freeze({ 1: 'Crítica', 2: 'Alta', 3: 'Média' });
const CLASSE_FALA = Object.freeze({ se_sem_tensao: 'subestação sem tensão', trafo_sem_tensao: 'transformador sem tensão', cto_aberto: 'circuito sem corrente com a barra viva',
  cto_sem_tensao: 'circuito sem tensão', medidor_com: 'medidor sem comunicação' });

const msBRT = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');
const dia = (s) => String(s).slice(0, 10);
const porExtenso = (t) => String(t).replace(/\bM([1-9])\b/g, 'Mauriti $1');

function nomeTag(tag) {
  const m = /^M([1-9])C(\d+)$/.exec(tag);
  if (m) return { tela: 'M' + m[1] + ', circuito ' + m[2], fala: 'Mauriti ' + m[1] + ', circuito ' + m[2] };
  if (tag === 'SE') return { tela: 'subestação', fala: 'subestação' };
  return { tela: String(tag), fala: porExtenso(tag) };
}

// a medição: episódio de circuito, trafo e SE; a queda de medidor vem na lista à parte
function deMedicao(way2, agoraMs) {
  if (!way2) return [];
  const circ = (way2.eventos || []).map((e) => ({ id: e.id, tag: e.tag, classe: e.regra, sev: SEV_MED[e.regra] || null, i: e.ini_est || e.ini, f: e.fim || null,
    fonte: ['medicao'], pai: e.pai || null, causa_buscar: !!SEV_MED[e.regra] }));
  const med = (way2.medidor_com || []).map((e) => ({ id: e.id, tag: e.tag, classe: 'medidor_com', sev: e.p, i: e.ini, f: e.fim || null, fonte: ['medicao'], pai: null, causa_buscar: false }));
  const lim = agoraMs - A_CONFERIR_H * 3600e3;
  return [...circ, ...med].map((e) => (e.f === null && msBRT(e.i) < lim ? { ...e, a_conferir: 1 } : e));
}

// a análise ao vivo: um evento por achado, com a fala do próprio achado
/* arquivo de outro esquema é ignorado inteiro e devolve null: fica o que está publicado da análise (como na rodada sem novidade). Achado sem id, início ou
   tipo é descartado com aviso. Nenhum dos dois derruba a medição */
const ESQUEMA_ANALISE = 1;
function deAnalise(an) {
  if (!an) return null;
  if (an.esquema !== ESQUEMA_ANALISE) { console.log('::warning::analise_vivo.json com esquema ' + an.esquema + ' (esperado ' + ESQUEMA_ANALISE + '): fica o que está publicado da análise'); return null; }
  return (Array.isArray(an.achados) ? an.achados : []).filter((a) => {
    const ok = a && typeof a.id === 'string' && a.id && typeof a.ini === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(a.ini) && typeof a.tipo === 'string' && a.tipo;
    if (!ok) console.log('::warning::achado da análise sem id, início ou tipo: descartado (' + JSON.stringify(a).slice(0, 120) + ')');
    return ok;
  }).map((a) => ({ id: 'analise:' + a.id, tag: a.tag, classe: a.tipo, sev: a.p, i: a.ini, f: a.fim || null, fonte: ['analise'], pai: null,
    tx: a.texto || null, fala: a.voz ? a.fala || null : null, causa_buscar: false }));
}

// o supervisório e o logger: por classe e minuto. O que está a conferir, o estado e a Baixa não entram
function agrupa(ev, msg, fonte) {
  const m = new Map();
  for (const e of ev || []) {
    if (e.a_conferir || e.est || ![1, 2, 3].includes(e.p)) continue;
    const k = fonte + ':' + e.c + ':' + e.i.slice(0, 16), g = m.get(k);
    const tx = Number.isInteger(e.m) ? msg[e.m] : e.m;
    if (!g) m.set(k, { id: k, tag: e.t, tags: [e.t], classe: e.c, sev: e.p, i: e.i, f: e.f || null, fonte: [fonte], pai: null, n: 1, tx: tx || null, causa_buscar: false });
    else { g.n++; g.sev = Math.min(g.sev, e.p); if (!g.tags.includes(e.t)) g.tags.push(e.t); if (e.f == null) g.f = null; else if (g.f && e.f > g.f) g.f = e.f; }
  }
  return [...m.values()].map((g) => { g.tags = g.tags.slice(0, 8); return g; });
}

// a causa de um evento da medição: proteção antes de disjuntor, e a mais próxima
function acheCausa(e, scada, eqMed) {
  if (!scada) return null;
  const t0 = msBRT(e.i), lim = CAUSA_SLOTS * SLOT_MS, q = (eqMed && eqMed[e.tag]) || {}, eq = scada.eq || {}, msg = scada.msg || [];
  const serve = (x) => { const u = (eq[x.t] || {}).u;
    if (e.classe === 'se_sem_tensao') return u === 'SE';
    if (e.classe === 'trafo_sem_tensao') return x.t === e.tag;
    return u === q.u || x.t === q.pai; };
  const cand = (scada.ev || []).filter((x) => (x.c === 'protecao' || x.c === 'disjuntor') && Math.abs(msBRT(x.i) - t0) <= lim && serve(x));
  if (!cand.length) return null;
  cand.sort((a, b) => (a.c === b.c ? Math.abs(msBRT(a.i) - t0) - Math.abs(msBRT(b.i) - t0) : a.c === 'protecao' ? -1 : 1));
  const x = cand[0], tx = Number.isInteger(x.m) ? msg[x.m] : x.m;
  return { texto: x.c === 'protecao' ? 'Proteção em ' + x.t + (tx ? ': ' + tx : '') : 'Disjuntor aberto em ' + x.t, tag: x.t, classe: x.c, i: x.i, fonte: 'supervisorio' };
}

function textos(e) {
  const n = nomeTag(e.tag), c = CLASSE_FALA[e.classe] || 'ocorrência', h = e.i.slice(11, 16);
  if (e.fonte[0] === 'analise') return { tela: 'A análise indica: ' + (e.tx || c) + ', às ' + h, fala: e.fala || '' };
  if (e.fonte[0] === 'medicao') return { tela: 'A medição indica ' + c + ': ' + n.tela + ', às ' + h, fala: 'A medição indica ' + c + ', ' + n.fala + ', às ' + h };
  const q = (e.n > 1 ? e.n + ' ocorrências' : 'Ocorrência') + ' de prioridade ' + (SEV_NOME[e.sev] || '').toLowerCase(), tx = e.tx ? ': ' + e.tx : '';
  return { tela: q + ' em ' + n.tela + ', às ' + h + tx, fala: q + ' em ' + n.fala + ', às ' + h };
}

function vozDe(e) {
  if (e.fonte[0] === 'analise') return !e.a_conferir && e.fala && [1, 2, 3].includes(e.sev) && !e.f ? { etapa: 1, chave: e.id + ':1', fala: e.fala } : null;
  if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' || ![1, 2, 3].includes(e.sev)) return null;
  const etapa = e.causa ? 2 : 1, t = textos(e);
  return { etapa, chave: e.id + ':' + etapa, fala: etapa === 2 ? t.fala + '. Causa: ' + porExtenso(e.causa.texto) : t.fala };
}

// o resumo único do dia coberto pelo supervisório: conta as ocorrências de supervisório e logger, nunca as a conferir
function vozResumo(eventos, d) {
  if (!d) return null;
  const c = { 1: 0, 2: 0, 3: 0 };
  for (const e of eventos.filter((x) => x.fonte[0] !== 'analise')) if (e.fonte[0] !== 'medicao' && !e.a_conferir && dia(e.i) === d && c[e.sev] !== undefined) c[e.sev] += e.n || 1;
  const nome = [[c[1], 'ocorrência crítica', 'ocorrências críticas'], [c[2], 'ocorrência alta', 'ocorrências altas'], [c[3], 'ocorrência média', 'ocorrências médias']].filter((x) => x[0]).map((x) => x[0] + ' ' + (x[0] === 1 ? x[1] : x[2]));
  if (!nome.length) return null;
  return { chave: 'resumo:' + d, dia: d, criticas: c[1], altas: c[2], medias: c[3], fala: 'Resumo do dia ' + d.slice(8, 10) + ' do ' + d.slice(5, 7) + ': ' + nome.join(', ') + '. Detalhes na tela de alarmes.' };
}

function ligaPonte(e, agoraMs) {
  return e.fonte[0] === 'medicao' && e.causa_pendente === true && !e.a_conferir && !e.pai && !!SEV_MED[e.classe] && e.sev <= 2 && agoraMs - msBRT(e.i) < A_CONFERIR_H * 3600e3;
}

// o evento de mesmo tipo e tag que se sobrepõe ao publicado é o mesmo evento
function mesmo(a, b) {
  if (a.classe !== b.classe || a.tag !== b.tag) return false;
  const fa = a.f ? msBRT(a.f) : Infinity, fb = b.f ? msBRT(b.f) : Infinity;
  return msBRT(a.i) <= fb && msBRT(b.i) <= fa;
}

function guarda(eventos) {
  for (const e of eventos) {
    if (e.a_conferir && e.voz) throw new Error('voz em evento a conferir: ' + e.id);
    if (e.a_conferir && e.liga_ponte) throw new Error('ponte em evento a conferir: ' + e.id);
    if (e.liga_ponte && e.fonte[0] !== 'medicao') throw new Error('ponte sem evento da medição: ' + e.id);
    if (e.voz && ![1, 2, 3].includes(e.sev)) throw new Error('voz fora de Crítica, Alta e Média: ' + e.id);
  }
  const ch = eventos.filter((e) => e.voz).map((e) => e.voz.chave);
  if (new Set(ch).size !== ch.length) throw new Error('a mesma fala duas vezes');
  return eventos;
}

/* scada e logger nulos = sem novidade nesta rodada: fica o que o publicado já tem deles */
function compoe({ way2, scada = null, logger = null, analise = null, pub = null, agoraMs }) {
  const antes = (pub && pub.eventos) || [];
  const deFora = (f, novo) => (novo ? novo : antes.filter((e) => e.fonte[0] === f));
  const cob = scada && scada.janela ? scada.janela.ate : (pub && pub.causa_coberta_ate) || null;
  const vistos = new Set();
  const med = deMedicao(way2, agoraMs).map((e) => {
    const a = antes.find((x) => x.fonte[0] === 'medicao' && !vistos.has(x.id) && mesmo(x, e));
    if (a) vistos.add(a.id);
    const o = { ...e, id: a ? a.id : e.id, visto: a ? a.visto : new Date(agoraMs).toISOString(), ...(a && a.ponte_pedida ? { ponte_pedida: a.ponte_pedida } : {}) };
    const c = o.causa_buscar ? (acheCausa(o, scada, way2 && way2.eq) || (a && a.causa) || null) : null;
    o.causa = c;
    o.causa_pendente = o.causa_buscar && !c && !(cob && (cob.length > 10 ? o.i <= cob : dia(o.i) <= cob));   // com hora, o arquivo parcial só cobre o que veio antes dele
    delete o.causa_buscar;
    return o;
  });
  const fora = [...deFora('supervisorio', scada ? agrupa(scada.ev, scada.msg || [], 'supervisorio') : null), ...deFora('logger', logger ? agrupa(logger.ev, logger.msg || [], 'logger') : null),
    ...deFora('analise', analise ? deAnalise(analise) : null)]
    .map((e) => { const { causa_buscar, ...o } = e; const a = antes.find((x) => x.id === e.id);
      return { ...o, visto: a ? a.visto : (o.visto || new Date(agoraMs).toISOString()), causa: null, causa_pendente: false }; });
  const lim = agoraMs - JANELA_DIAS * 86400e3;
  const eventos = guarda([...med, ...fora].filter((e) => (e.f ? msBRT(e.f) : Infinity) >= lim).map((e) => {
    const t = textos(e), o = { ...e, estado: e.a_conferir ? 'a_conferir' : e.f ? 'encerrado' : 'aberto', texto: t.tela, causa: e.causa || null };
    o.voz = vozDe(o);
    o.liga_ponte = ligaPonte(o, agoraMs);
    if (o.liga_ponte && !o.ponte_pedida) o.ponte_pedida = new Date(agoraMs).toISOString();
    return o;
  }).sort((a, b) => (a.i > b.i ? -1 : a.i < b.i ? 1 : a.id < b.id ? -1 : 1)));
  return {
    esquema: ESQUEMA, gerado: new Date(agoraMs).toISOString(), lido_ate: way2 ? way2.lido_ate || null : (pub && pub.lido_ate) || null, causa_coberta_ate: cob, eventos, voz_resumo: vozResumo(eventos, cob),
    resumo: { abertos: eventos.filter((e) => e.estado === 'aberto').length, causa_pendente: eventos.filter((e) => e.causa_pendente).length,
      liga_ponte: eventos.filter((e) => e.liga_ponte).length, com_voz: eventos.filter((e) => e.voz).length },
  };
}

module.exports = { ESQUEMA, JANELA_DIAS, A_CONFERIR_H, SEV_MED, CAUSA_SLOTS, deMedicao, deAnalise, agrupa, acheCausa, vozDe, vozResumo, ligaPonte, mesmo, guarda, compoe, msBRT };
