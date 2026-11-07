'use strict';
/*
 * ensaio-alarmes-eventos.js — a lista para a voz e para a ponte (lote alarmes-eventos, 06/11/2026), sem rede, com medição, supervisório e logger forjados:
 * 1. a ponte liga só com evento da medição, Crítica ou Alta, sem pai, com causa pendente e nas primeiras 24 h;
 * 2. a voz fala Crítica, Alta e Média em duas etapas, nunca a conferir, nunca o filho, nunca a Baixa;
 * 3. o mesmo evento, mesmo com o início andando, não repete nem a fala nem o pedido da ponte;
 * 4. a causa pelo supervisório, proteção antes de disjuntor; sem causa com o dia coberto, a pendência fecha;
 * 5. supervisório e logger agrupados, sem voz por evento e com um só resumo do dia; sem novidade deles, fica o publicado;
 * 6. nenhum texto público com nome interno.
 * Depois PLANTA defeitos na lib e exige que cada um reprove.
 * uso: node scripts/ensaio-alarmes-eventos.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), path = require('path');

const AG = '2026-11-06T10:00:00';
const ms = (s) => Date.parse(s + '-03:00');
const EQ = { '04T2': { u: 'SE', n: 'trafo', pai: 'SE' }, M7C1: { u: 'M7', n: 'circuito', pai: '04T2' }, M9C1: { u: 'M9', n: 'circuito', pai: '04T2' }, M3C1: { u: 'M3', n: 'circuito', pai: '04T2' } };
const W = (ev, med = []) => ({ lido_ate: AG, eq: EQ, eventos: ev, medidor_com: med });
const C1 = { id: 'cto_aberto:M7C1:2026-11-06T09:20:00', regra: 'cto_aberto', tag: 'M7C1', ini: '2026-11-06T09:20:00', fim: null };
const T1 = { id: 'trafo_sem_tensao:04T2:2026-11-06T09:30:00', regra: 'trafo_sem_tensao', tag: '04T2', ini: '2026-11-06T09:30:00', fim: '2026-11-06T09:50:00' };
const FILHO = { id: 'cto_sem_tensao:M3C1:2026-11-06T09:30:00', regra: 'cto_sem_tensao', tag: 'M3C1', ini: '2026-11-06T09:30:00', fim: '2026-11-06T09:50:00', pai: T1.id };
const VELHO = { id: 'cto_aberto:M9C1:2026-11-03T09:00:00', regra: 'cto_aberto', tag: 'M9C1', ini: '2026-11-03T09:00:00', fim: null };
const SEMSEV = { id: 'cto_sem_tensao:M9C1:2026-11-06T08:00:00', regra: 'cto_sem_tensao', tag: 'M9C1', ini: '2026-11-06T08:00:00', fim: '2026-11-06T08:30:00' };
const MED = { id: 'med:6197:2026-11-06T09:00:00', c: 'medidor_com', p: 3, pid: 6197, tag: '04T2', ini: '2026-11-06T09:00:00', fim: '2026-11-06T09:20:00' };
const SC = (ev) => ({ janela: { de: '2026-10-30', ate: '2026-11-05' }, msg: ['PICKUP 51R', 'DJ - ESTADO', 'TR2-FALTA VCA'], eq: { '04T2': { u: 'SE' }, CUB10_2: { u: 'M7', pai: '04T2' }, CUB15_2: { u: 'M9', pai: '04T2' }, '52-1': { u: 'SE' } }, ev });
const PROT = { c: 'protecao', t: '04T2', i: '2026-11-06T09:21:30', f: '2026-11-06T09:21:30', m: 0, p: 2 };
const DJ = { c: 'disjuntor', t: 'CUB10_2', i: '2026-11-06T09:21:00', f: null, m: 1 };
const LONGE = { c: 'protecao', t: '04T2', i: '2026-11-06T09:45:00', f: '2026-11-06T09:45:00', m: 0, p: 2 };
const A1 = { c: 'sa_cc_ca', t: '04T2', i: '2026-11-05T07:16:17', f: '2026-11-05T07:16:17', m: 2, p: 2 };
const A2 = { c: 'sa_cc_ca', t: '52-1', i: '2026-11-05T07:16:40', f: '2026-11-05T07:16:45', m: 2, p: 2 };
const CONF = { c: 'sa_cc_ca', t: '52-1', i: '2026-11-05T01:00:00', f: null, m: 2, p: 2, a_conferir: 1 };
const BAIXA = { c: 'tcu_alarme', t: 'M1', i: '2026-11-05T02:00:00', f: '2026-11-05T02:10:00', m: 2, p: 4 };
const EST = { c: 'se_auxiliar', t: '52-1', i: '2026-11-05T03:00:00', f: null, m: 2, est: 1 };
const LG = { msg: ['Inversor parado'], ev: [{ c: 'inversor_parada', t: 'M3', i: '2026-11-05T09:00:00', f: '2026-11-05T09:30:00', m: 0, p: 3 }] };

function julga(L) {
  const F = [];
  const C = (ok, m) => { if (!ok) F.push(m); };
  const ag = ms(AG);
  const r1 = L.compoe({ way2: W([C1, T1, FILHO, VELHO, SEMSEV], [MED]), agoraMs: ag });
  const e1 = (id) => r1.eventos.find((e) => e.id === id) || {};
  C(e1(C1.id).liga_ponte === true && e1(C1.id).sev === 2 && e1(C1.id).causa_pendente === true, 'circuito aberto da medição não pede a ponte');
  C(e1(T1.id).liga_ponte === true && e1(T1.id).sev === 1, 'trafo sem tensão não é Crítica com ponte');
  C(e1(FILHO.id).liga_ponte === false && e1(FILHO.id).voz === null, 'o filho fala ou pede a ponte');
  C(e1(VELHO.id).estado === 'a_conferir' && e1(VELHO.id).voz === null && e1(VELHO.id).liga_ponte === false, 'evento a conferir fala ou pede a ponte');
  C(e1(SEMSEV.id).sev === 2 && !!e1(SEMSEV.id).voz, 'o circuito sem tensão sem pai não veio como Alta, com voz');
  C(e1(MED.id).sev === 3 && !!e1(MED.id).voz && e1(MED.id).liga_ponte === false && e1(MED.id).causa_pendente === false, 'queda de medidor: Média com voz e sem ponte');
  C(e1(C1.id).voz && e1(C1.id).voz.etapa === 1 && /A medição indica/.test(e1(C1.id).voz.fala) && /Mauriti 7/.test(e1(C1.id).voz.fala) && !/\bM7\b/.test(e1(C1.id).voz.fala), 'a fala do fato: inferência e por extenso');
  C(/M7, circuito 1/.test(e1(C1.id).texto), 'o texto da tela sem o circuito');
  C(!!e1(C1.id).ponte_pedida, 'o pedido da ponte sem a hora');

  // o mesmo evento, com o início andando: o id herdado não repete fala nem ponte
  const C1b = { ...C1, id: 'cto_aberto:M7C1:2026-11-06T09:25:00', ini: '2026-11-06T09:25:00' };
  const r2 = L.compoe({ way2: W([C1b, T1, FILHO, VELHO, SEMSEV], [MED]), pub: r1, agoraMs: ag + 300000 });
  const n = r2.eventos.filter((e) => e.classe === 'cto_aberto' && e.tag === 'M7C1');
  C(n.length === 1 && n[0].id === C1.id && n[0].voz.chave === C1.id + ':1' && n[0].visto === e1(C1.id).visto && n[0].ponte_pedida === e1(C1.id).ponte_pedida, 'o mesmo evento repetiu com id novo');
  const fim = L.compoe({ way2: W([{ ...C1, fim: '2026-11-06T09:40:00' }, { ...C1, id: 'cto_aberto:M7C1:2026-11-06T09:55:00', ini: '2026-11-06T09:55:00' }]), pub: r1, agoraMs: ag + 600000 });
  C(fim.eventos.filter((e) => e.tag === 'M7C1').length === 2, 'outro episódio do mesmo circuito sumiu');

  const passou = L.compoe({ way2: W([{ ...C1, id: 'cto_aberto:M7C1:2026-11-06T09:55:00', ini: '2026-11-06T09:55:00' }]), pub: L.compoe({ way2: W([{ ...C1, fim: '2026-11-06T09:40:00' }]), agoraMs: ag }), agoraMs: ag + 300000 });
  C(passou.eventos.some((e) => e.id === 'cto_aberto:M7C1:2026-11-06T09:55:00'), 'episódio sem sobreposição herdou o id');

  // cada condição da ponte e da voz, sozinha
  const ok = { id: 'x', classe: 'cto_aberto', sev: 2, i: '2026-11-06T09:00:00', f: null, fonte: ['medicao'], pai: null, causa_pendente: true };
  C(L.ligaPonte(ok, ag) === true, 'o caso certo não pede a ponte');
  [[{ a_conferir: 1 }, 'a conferir'], [{ fonte: ['supervisorio'] }, 'sem evento da medição'], [{ sev: 3 }, 'Média'], [{ classe: 'medidor_com', sev: 2 }, 'queda de medidor'], [{ pai: 'p' }, 'filho'],
    [{ i: '2026-11-05T09:00:00' }, 'depois de 24 h'], [{ causa_pendente: false }, 'sem causa pendente']].forEach(([m, n]) => C(L.ligaPonte({ ...ok, ...m }, ag) === false, 'ponte: ' + n));
  C(!!L.vozDe({ ...ok }), 'o caso certo não fala');
  [[{ sev: 4 }, 'Baixa'], [{ pai: 'p' }, 'filho'], [{ a_conferir: 1 }, 'a conferir'], [{ sev: null }, 'sem prioridade']].forEach(([m, n]) => C(L.vozDe({ ...ok, ...m }) === null, 'voz: ' + n));

  // a causa: proteção antes de disjuntor; longe, não; a fala de etapa 2; a ponte desliga
  const r3 = L.compoe({ way2: W([C1]), scada: { ...SC([DJ, PROT]) }, pub: r1, agoraMs: ag + 600000 });
  const c3 = r3.eventos.find((e) => e.id === C1.id);
  C(c3.causa && c3.causa.classe === 'protecao' && c3.causa_pendente === false && c3.liga_ponte === false, 'a causa não veio pela proteção');
  C(c3.voz.etapa === 2 && c3.voz.chave === C1.id + ':2' && /Causa: Proteção em 04T2/.test(c3.voz.fala), 'a fala da causa');
  const r4 = L.compoe({ way2: W([C1]), scada: { ...SC([DJ]) }, agoraMs: ag });
  C((r4.eventos.find((e) => e.id === C1.id).causa || {}).classe === 'disjuntor', 'sem proteção, a causa é o disjuntor');
  const r5 = L.compoe({ way2: W([C1]), scada: SC([LONGE]), agoraMs: ag });
  C(r5.eventos.find((e) => e.id === C1.id).causa === null, 'causa fora da janela de 2 slots');
  const r6 = L.compoe({ way2: W([C1]), scada: { ...SC([]), janela: { de: '2026-10-31', ate: '2026-11-06' } }, agoraMs: ag });
  const c6 = r6.eventos.find((e) => e.id === C1.id);
  C(c6.causa_pendente === false && c6.causa === null && c6.liga_ponte === false, 'com o dia coberto e sem causa, a pendência fecha');
  const r7 = L.compoe({ way2: W([C1]), pub: r3, agoraMs: ag + 900000 });
  C(r7.eventos.find((e) => e.id === C1.id).causa !== null, 'rodada sem o supervisório perdeu a causa');

  // a cobertura com hora: o arquivo parcial só fecha o que veio antes dele
  { const pc = { ...C1, id: 'cto_aberto:M7C1:2026-11-06T09:00:00', ini: '2026-11-06T09:00:00', fim: null };
    const rc = (ate) => L.compoe({ way2: W([pc]), scada: { janela: { ate }, ev: [], msg: [] }, agoraMs: ag }).eventos[0];
    C(rc('2026-11-06T08:00:00').causa_pendente === true, 'a cobertura parcial fechou evento posterior a ela');
    C(rc('2026-11-06T10:00:00').causa_pendente === false, 'a cobertura com hora não fechou o evento anterior a ela');
    C(rc('2026-11-06').causa_pendente === false, 'o dia fechado sem hora não cobriu o evento'); }
  // supervisório e logger
  const r8 = L.compoe({ way2: W([]), scada: SC([A1, A2, CONF, BAIXA, EST]), logger: LG, agoraMs: ag });
  const sup = r8.eventos.filter((e) => e.fonte[0] === 'supervisorio');
  C(sup.length === 1 && sup[0].n === 2 && sup[0].voz === null && sup[0].liga_ponte === false, 'supervisório: agrupa por classe e minuto, sem voz por evento, sem ponte');
  C(!r8.eventos.some((e) => /a_conferir/.test(e.estado)) && !r8.eventos.some((e) => e.classe === 'tcu_alarme') && r8.resumo.liga_ponte === 0, 'a conferir, Baixa ou estado entraram');
  const lg = r8.eventos.find((e) => e.fonte[0] === 'logger');
  C(lg && lg.sev === 3 && lg.voz === null && /M3/.test(lg.texto), 'o logger: Média, sem voz por evento');
  { const vr = L.vozResumo(r8.eventos, A1.i.slice(0, 10));
    C(vr && vr.chave === 'resumo:' + A1.i.slice(0, 10) && vr.criticas + vr.altas + vr.medias >= 2 && !/a conferir/i.test(vr.fala), 'o resumo do dia não conta as ocorrências');
    C(L.vozResumo([{ fonte: ['supervisorio'], a_conferir: 1, i: A1.i, sev: 1, n: 3 }], A1.i.slice(0, 10)) === null, 'o resumo contou evento a conferir');
    C(L.vozResumo([{ fonte: ['medicao'], i: A1.i, sev: 1 }], A1.i.slice(0, 10)) === null, 'o resumo contou evento da medição, que já foi falado'); }
  C(r8.resumo.causa_pendente === 0, 'supervisório ou logger com causa pendente');
  const r9 = L.compoe({ way2: W([]), pub: r8, agoraMs: ag + 300000 });
  C(r9.eventos.length === r8.eventos.length && r9.eventos.some((e) => e.fonte[0] === 'logger'), 'rodada sem novidade perdeu supervisório ou logger');
  const r10 = L.compoe({ way2: W([]), pub: r8, agoraMs: ag + 9 * 86400e3 });
  C(r10.eventos.length === 0, 'não poda o que passou da janela');

  // a análise ao vivo (analise-ao-vivo, 07/11/2026): fala só o achado que pede voz, nunca liga a ponte, não entra no resumo, segue na rodada sem novidade
  { const AN = { esquema: 1, achados: [
      { id: 'liberado_nao_recuperou:Complexo:2026-11-06T12:57', tipo: 'liberado_nao_recuperou', p: 2, tag: 'Complexo', ini: '2026-11-06T13:10:00', fim: null,
        texto: 'Liberado às 12:57 e a potência ficou em 300 MW, no valor pedido antes (300 MW)', fala: 'Atenção: liberado às 12:57, mas a potência do complexo não voltou.', voz: true },
      { id: 'ocorrencia:trafo_sem_tensao:04T2:x', tipo: 'ocorrencia_agrupada', p: 1, tag: '04T2', ini: '2026-11-06T09:00:00', fim: null, texto: 'Transformador 04T2 sem tensão: 11 circuitos', voz: false },
      { id: 'circuito_sem_geracao:M5C1:x', tipo: 'circuito_sem_geracao', p: 3, tag: 'M5C1', ini: '2026-11-06T08:00:00', fim: '2026-11-06T08:30:00', texto: 'Circuito M5C1 energizado e sem geração', fala: 'Atenção: Mauriti 5, circuito 1.', voz: true }] };
    const ra = L.compoe({ way2: W([]), analise: AN, agoraMs: ag }), ea = ra.eventos.filter((e) => e.fonte[0] === 'analise');
    const lib = ea.find((e) => e.classe === 'liberado_nao_recuperou'), agr = ea.find((e) => e.classe === 'ocorrencia_agrupada'), fec = ea.find((e) => e.classe === 'circuito_sem_geracao');
    C(ea.length === 3, 'a análise não entrou inteira: ' + ea.length);
    C(lib && lib.voz && lib.voz.fala === AN.achados[0].fala && lib.sev === 2 && /A análise indica/.test(lib.texto), 'o achado com voz não fala o texto dele');
    C(agr && !agr.voz, 'o agrupado falou (a medição já fala o trafo)');
    C(fec && !fec.voz, 'o achado encerrado falou');
    C(ea.every((e) => !e.liga_ponte), 'a análise ligou a ponte');
    C(L.vozResumo(ea, '2026-11-06') === null, 'o resumo do dia contou a análise');
    /* RW-006: achado sem id, início ou tipo sai com aviso; esquema diferente ignora a análise; a medição segue nos dois casos */
    const ruim = { esquema: 1, achados: AN.achados.concat([{ id: 'sem-ini', tipo: 'circuito_sem_geracao', p: 3, tag: 'M1C1' }, { ini: '2026-11-06T08:00:00', tipo: 'x', p: 3 }, null]) };
    const rr = L.compoe({ way2: W([C1]), analise: ruim, agoraMs: ag });
    C(rr.eventos.filter((e) => e.fonte[0] === 'analise').length === 3 && rr.eventos.some((e) => e.fonte[0] === 'medicao'), 'o achado sem id, início ou tipo entrou, ou derrubou a medição');
    const re = L.compoe({ way2: W([C1]), analise: { ...AN, esquema: 2 }, agoraMs: ag });
    C(!re.eventos.some((e) => e.fonte[0] === 'analise') && re.eventos.some((e) => e.fonte[0] === 'medicao'), 'o esquema diferente da análise entrou, ou derrubou a medição');
    const rp = L.compoe({ way2: W([C1]), analise: { ...AN, esquema: 2 }, pub: ra, agoraMs: ag + 300000 }), lp = rp.eventos.find((e) => e.id === lib.id);
    C(lp && lp.visto === lib.visto && lp.voz && lp.voz.chave === lib.voz.chave && rp.eventos.some((e) => e.fonte[0] === 'medicao'), 'o esquema diferente apagou a análise já publicada');
    const rb = L.compoe({ way2: W([]), pub: ra, agoraMs: ag + 300000 }), lb = rb.eventos.find((e) => e.id === lib.id);
    C(lb && lb.visto === lib.visto && lb.voz && lb.voz.chave === lib.voz.chave, 'a rodada sem novidade da análise perdeu o achado ou mudou a chave da fala'); }

  // texto público
  const txt = JSON.stringify(r3) + JSON.stringify(r8);
  C(!/\.json|\.js\b|blob|cn_|_Ind\d|DADOS_|ELET_/.test(txt.replace(/"id":"[^"]*"/g, '')), 'nome interno em texto');
  // as guardas
  ['voz', 'ponte', 'fonte', 'sev'].forEach((q) => {
    const e = { id: 'x', fonte: [q === 'fonte' ? 'logger' : 'medicao'], sev: q === 'sev' ? 4 : 1, a_conferir: q === 'voz' || q === 'ponte' ? 1 : 0, voz: q === 'ponte' || q === 'fonte' ? null : { chave: 'x:1' }, liga_ponte: q === 'ponte' || q === 'fonte' };
    let pegou = false; try { L.guarda([e]); } catch (_) { pegou = true; }
    C(pegou, 'a guarda não barrou: ' + q);
  });
  let dup = false; try { L.guarda([{ id: 'a', fonte: ['medicao'], sev: 1, voz: { chave: 'k' } }, { id: 'b', fonte: ['medicao'], sev: 1, voz: { chave: 'k' } }]); } catch (_) { dup = true; }
  C(dup, 'a guarda não barrou a mesma fala duas vezes');
  return F;
}

const LIB = path.join(__dirname, 'lib-alarmes-eventos.js');
const SRC = fs.readFileSync(LIB, 'utf8');
const f0 = julga(require(LIB));
if (f0.length) { f0.forEach((m) => console.log('🔴 ' + m)); process.exit(1); }
console.log('✅ o código real passa');

const PLANTIOS = [
  ['voz em a conferir', "if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' || ![1, 2, 3].includes(e.sev)) return null;", "if (e.pai || e.fonte[0] !== 'medicao' || ![1, 2, 3].includes(e.sev)) return null;"],
  ['a guarda da voz cala', "if (e.a_conferir && e.voz) throw", "if (false) throw"],
  ['ponte a conferir', "e.causa_pendente === true && !e.a_conferir && !e.pai", "e.causa_pendente === true && !e.pai"],
  ['ponte sem evento da medição', "return e.fonte[0] === 'medicao' && e.causa_pendente === true", "return e.causa_pendente === true"],
  ['a causa pendente do supervisório', "causa: null, causa_pendente: false }; });", "causa: null, causa_pendente: true }; });"],
  ['a guarda da ponte cala', "if (e.liga_ponte && e.fonte[0] !== 'medicao') throw", "if (false) throw"],
  ['ponte com Média', "&& e.sev <= 2 && agoraMs", "&& e.sev <= 3 && agoraMs"],
  ['ponte na queda de medidor', "!e.pai && !!SEV_MED[e.classe] && e.sev <= 2", "!e.pai && e.sev <= 2"],
  ['ponte no filho', "!e.a_conferir && !e.pai && !!SEV_MED", "!e.a_conferir && !!SEV_MED"],
  ['ponte depois de 24 h', "agoraMs - msBRT(e.i) < A_CONFERIR_H * 3600e3", "true"],
  ['repetição: id novo', "id: a ? a.id : e.id, visto:", "id: e.id, visto:"],
  ['repetição: sem sobreposição', "return msBRT(a.i) <= fb && msBRT(b.i) <= fa;", "return a.i === b.i;"],
  ['outro episódio herda o id', "return msBRT(a.i) <= fb && msBRT(b.i) <= fa;", "return true;"],
  ['o visto anda', "visto: a ? a.visto : new Date(agoraMs).toISOString(), ...(a && a.ponte_pedida", "visto: new Date(agoraMs).toISOString(), ...(a && a.ponte_pedida"],
  ['a guarda da fala repetida cala', "if (new Set(ch).size !== ch.length) throw", "if (false) throw"],
  ['voz em Baixa', "if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' || ![1, 2, 3].includes(e.sev)) return null;", "if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' || !e.sev) return null;"],
  ['voz no filho', "if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' ||", "if (e.a_conferir || e.fonte[0] !== 'medicao' ||"],
  ['a cobertura parcial fecha o evento posterior', "(cob.length > 10 ? o.i <= cob : dia(o.i) <= cob)", "dia(o.i) <= dia(cob)"],
  ['o circuito sem pai perde a Alta', "cto_aberto: 2, cto_sem_tensao: 2 });", "cto_aberto: 2 });"],
  ['o sem tensão perde a Crítica', "trafo_sem_tensao: 1, cto_aberto: 2", "trafo_sem_tensao: 2, cto_aberto: 2"],
  ['disjuntor antes da proteção', "a.c === 'protecao' ? -1 : 1", "a.c === 'protecao' ? 1 : -1"],
  ['causa sem janela', "Math.abs(msBRT(x.i) - t0) <= lim && serve(x)", "serve(x)"],
  ['a pendência nunca fecha', "&& !(cob && (cob.length > 10 ? o.i <= cob : dia(o.i) <= cob))", ''],
  ['a rodada perde a causa', "|| (a && a.causa) || null", "|| null"],
  ['a ponte segue com a causa achada', "o.causa_pendente = o.causa_buscar && !c &&", "o.causa_pendente = o.causa_buscar &&"],
  ['a fala sem a inferência', "fala: 'A medição indica ' + c", "fala: c"],
  ['a fala com a sigla', "fala: 'Mauriti ' + m[1] + ', circuito '", "fala: 'M' + m[1] + ', circuito '"],
  ['a conferir entra no supervisório', "if (e.a_conferir || e.est || ![1, 2, 3].includes(e.p)) continue;", "if (e.est || ![1, 2, 3].includes(e.p)) continue;"],
  ['Baixa entra no supervisório', "if (e.a_conferir || e.est || ![1, 2, 3].includes(e.p)) continue;", "if (e.a_conferir || e.est) continue;"],
  ['estado entra no supervisório', "if (e.a_conferir || e.est || ![1, 2, 3].includes(e.p)) continue;", "if (e.a_conferir || (e.p && ![1, 2, 3].includes(e.p))) continue;"],
  ['não agrupa', "const k = fonte + ':' + e.c + ':' + e.i.slice(0, 16), g", "const k = fonte + ':' + e.c + ':' + e.i, g"],
  ['voz por evento volta no supervisório', "if (e.a_conferir || e.pai || e.fonte[0] !== 'medicao' || ![1, 2, 3]", "if (e.a_conferir || e.pai || ![1, 2, 3]"],
  ['o resumo conta a conferir', "if (e.fonte[0] !== 'medicao' && !e.a_conferir && dia(e.i) === d", "if (e.fonte[0] !== 'medicao' && dia(e.i) === d"],
  ['o resumo conta a medição', "if (e.fonte[0] !== 'medicao' && !e.a_conferir && dia(e.i) === d", "if (!e.a_conferir && dia(e.i) === d"],
  ['a rodada apaga o supervisório', "antes.filter((e) => e.fonte[0] === f)", "[]"],
  ['a medição a conferir não marca', "(e.f === null && msBRT(e.i) < lim ? { ...e, a_conferir: 1 } : e)", 'e'],
  ['não poda', "(e.f ? msBRT(e.f) : Infinity) >= lim)", 'true)'],
  ['a análise fala o agrupado', "!e.a_conferir && e.fala && [1, 2, 3].includes(e.sev) && !e.f ?", "!e.a_conferir && [1, 2, 3].includes(e.sev) && !e.f ?"],
  ['a análise fala o encerrado', "&& !e.f ? { etapa: 1", "? { etapa: 1"],
  ['o resumo conta a análise', "eventos.filter((x) => x.fonte[0] !== 'analise')", 'eventos'],
  ['a análise some na rodada sem novidade', "...deFora('analise', analise ? deAnalise(analise) : null)]", ']'],
  ['a análise de outro esquema entra', "if (an.esquema !== ESQUEMA_ANALISE) {", "if (false) {"],
  ['o esquema diferente apaga o publicado', "fica o que está publicado da análise'); return null; }", "fica o que está publicado da análise'); return []; }"],
  ['o achado sem id, início ou tipo entra', "    return ok;\n  }).map((a) => ({ id: 'analise:' + a.id,", "    return true;\n  }).map((a) => ({ id: 'analise:' + a.id,"],
];
const tmp = fs.mkdtempSync(path.join(__dirname, '.ensaio-alarmes-eventos-'));
let ruim = 0;
try {
  PLANTIOS.forEach(([nome, de, para], k) => {
    if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
    const arq = path.join(tmp, 'lib-' + k + '.js');
    fs.writeFileSync(arq, SRC.replace(de, para));
    let f; try { f = julga(require(arq)); } catch (e) { f = ['estourou: ' + e.message]; }
    if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 90) + ')');
    else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
