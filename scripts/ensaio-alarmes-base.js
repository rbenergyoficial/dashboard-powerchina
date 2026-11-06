'use strict';
/*
 * ensaio-alarmes-base.js — a base nova dos alarmes do supervisório (lote alarmes-base, 05/11/2026), sem rede, em CSV forjados no formato do cofre:
 * 1. o aberto órfão: a entrada seguinte do mesmo ponto encerra a anterior (`fx`), a saída real vale se chegar depois, o regravado no reinício não
 *    encerra, e o órfão herdado do mês anterior também fecha;
 * 2. as classes novas e o que continua em `se_auxiliar` e em `outro`;
 * 3. a prioridade da tabela aprovada pelo humano, o estado fora da contagem e o disjuntor, que só é alarme com proteção junto;
 * 4. intermitente só com 3 ativações em 60 s; `a_conferir` separado dos ativos, refeito a cada corte;
 * 5. reconhecimento, operador e código do ponto; `System` não é operador;
 * 6. os aliases contra a árvore e o TCU da STI na numeração da NCU;
 * 7. o reinício que o critério antigo não via (29/01/2025: reentrada em massa com 2 classes), sem confundir com surto real (22/07/2026 15:27);
 * 8. caso real: os trips de 27/10 e 21/09 ficam no ensaio-alarmes-scada, que lê o cofre.
 * Depois PLANTA defeitos na lib e exige que cada um reprove.
 * uso: node scripts/ensaio-alarmes-base.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), path = require('path');

const LIB = path.join(__dirname, 'lib-alarmes-scada.js');
const SEM = '1899-12-30 00:00:00.000';
const CAB = 'E3TimeStamp;InTime;OutTime;EventTimeDbl;Acked;ActiveSource;ConditionActive;Severity;EventType;ConditionName;FormattedValue;CurrentValue;Quality;Area;Source;AlarmSourceName;FullAlarmSourceName;Message;ActorID';
// uma linha do CSV. ts = quando o banco gravou (padrão: o próprio instante)
function L(o) {
  const c = o.ativo === 0 ? 0 : 1, ini = o.ini + '.000', sai = o.sai ? o.sai + '.000' : SEM, ts = (o.ts || (c ? o.ini : (o.sai || o.ini))) + '.000', p = o.p || 'P1';
  return [ts, ini, sai, '0', o.ack || 0, '-1', c, 0, o.et || 'Condition', o.cn || 'KKS-' + p, o.v || 'ATUADO', '-1', 'Boa (192)', o.area || 'GRL.UFV.MRT05.TS1', 'src', p, o.fp || 'X.' + p, o.msg, o.ator || ''].join(';');
}
const csv = (linhas) => CAB + '\n' + linhas.map(L).join('\n') + '\n';
const DIA = '2026-10-10';
const h = (x, d = DIA) => d + ' ' + x;

function julga(A) {
  const f = [], C = (n, ok, det) => { if (!ok) f.push(n + (det !== undefined ? ' · ' + det : '')); };
  const compoe = (l, op = {}, d = DIA) => A.compoe([{ dia: d, txt: csv(l) }], d, d, op);
  const achaM = (o, m) => o.ev.filter((e) => o.msg[e.m] === m);
  const M = 'MRT05 TS1 ALARME TEMPERATURA TRAFO AUX', T = 'ALARME TEMPERATURA TRAFO AUX';

  // 1 · órfão
  let o = compoe([{ ini: h('10:00:00'), msg: M }, { ini: h('10:30:00'), msg: M }, { ini: h('10:30:00'), ativo: 0, sai: h('10:40:00'), msg: M }]);
  let e = achaM(o, T);
  C('órfão: são dois episódios', e.length === 2, e.length);
  C('órfão: a entrada seguinte encerra a anterior com fim inferido', e[0] && e[0].f === '2026-10-10T10:30:00' && e[0].fx === 1, JSON.stringify(e[0]));
  C('órfão: o que teve saída real fica sem `fx`', e[1] && e[1].f === '2026-10-10T10:40:00' && !e[1].fx, JSON.stringify(e[1]));
  o = compoe([{ ini: h('10:00:00'), msg: M }, { ini: h('10:30:00'), msg: M }, { ini: h('10:00:00'), ativo: 0, sai: h('10:10:00'), ts: h('10:35:00'), msg: M }]);
  e = achaM(o, T);
  C('órfão: a saída real que chega depois vale e tira o `fx`', e[0] && e[0].f === '2026-10-10T10:10:00' && !e[0].fx, JSON.stringify(e[0]));
  C('órfão: o último segue aberto', e[1] && e[1].f === null, JSON.stringify(e[1]));
  const outro = compoe([{ ini: h('10:00:00'), msg: M, p: 'P1' }, { ini: h('10:30:00'), msg: 'MRT05 TS2 ALARME TEMPERATURA TRAFO AUX', p: 'P2', area: 'GRL.UFV.MRT05.TS2' }]);
  C('órfão: ponto diferente não encerra', achaM(outro, T).every((x) => x.f === null), JSON.stringify(achaM(outro, T)));
  const rs = [...A.linhasCsv(csv([{ ini: h('10:00:00'), msg: M }, { ini: h('11:00:00'), msg: M }]))]; rs[1]._ri = 1;
  const er = A.episodios(rs);
  C('órfão: o regravado no reinício não encerra', er.filter((x) => x.i === '2026-10-10T10:00:00')[0].f === null, JSON.stringify(er.map((x) => x.f)));
  const ant = { dias: ['2026-10-09'], eq: { 'M5/TS1': { u: 'M5', n: 'eletrocentro', pai: 'M5' } }, msg: [T],
    ev: [{ id: 'eletrocentro:M5/TS1:2026-10-09T08:00:00:' + T, c: 'eletrocentro', t: 'M5/TS1', i: '2026-10-09T08:00:00', f: null, m: 0, p: 4 }] };
  o = compoe([{ ini: h('09:00:00'), msg: M }], { anterior: ant });
  e = o.ev.find((x) => x.i === '2026-10-09T08:00:00');
  C('órfão: o herdado do mês anterior fecha na entrada seguinte', e && e.f === '2026-10-10T09:00:00' && e.fx === 1, JSON.stringify(e));
  o = compoe([{ ini: h('09:00:00'), msg: 'MRT05 TS1 FALHA SPD1', cn: 'Z' }], { anterior: ant });
  e = o.ev.find((x) => x.i === '2026-10-09T08:00:00');
  C('órfão: o herdado sem entrada seguinte segue aberto', e && e.f === null, JSON.stringify(e));

  // 2 · classes
  const SE = 'GRL.SE_MRT.[X]', TS = 'GRL.UFV.MRT05.TS1';
  [[SE, 'FALHA GOOSE', 'falha_ied'], [SE, 'FALHA SINCRONISMO GPS', 'falha_ied'], [SE, 'SUPERVISÃO DE BOBINA ANORMAL', 'falha_ied'], [SE, 'FALHA CANAL B', 'falha_ied'],
    [SE, 'RET1 - TENSAO CA ANORMAL', 'sa_cc_ca'], [SE, 'QCA-E1 - FALTA TENSÃO NA BARRA', 'sa_cc_ca'], [SE, 'DJ 14T2 - FALTA CC ABERTURA 1', 'sa_cc_ca'], [SE, 'TR2-FALTA VCA', 'sa_cc_ca'],
    [SE, 'GMG - DJ Q1 DISPARADO', 'se_auxiliar'], [SE, 'SC TERRA - ESTADO', 'se_auxiliar'], [SE, 'TRIP GERAL', 'protecao'],
    [TS, 'MRT05 TS1 EMU01 TR01 RELÉ BUCHHOLZ TRIP', 'trafo_ts'], [TS, 'MRT05 TS1 TR01 TEMPERATURA ÓLEO ALARME', 'trafo_ts'], [TS, 'MRT05 TS1 DISJUNTOR GERAL TRIP', 'trafo_ts'],
    [TS, 'MRT05 TS1 RL01 50N-2', 'rele_ts'], [TS, 'MRT05 TS1 RL01 TRIP GERAL', 'rele_ts'], [TS, 'MRT05 TS1 PID1 ALARME HARDWARE', 'pid'],
    [TS, 'MRT05 TS1 STATUS SEC 1', 'outro'], [TS, 'MRT05 TS1 EMU01 ENTRADA DIGITAL 14', 'outro'], [TS, 'MRT05 TS1 ALARME TEMPERATURA TRAFO AUX', 'eletrocentro']]
    .forEach(([a, m, c]) => C('classe de "' + m + '"', A.classe(a, m) === c, A.classe(a, m)));
  o = compoe([{ ini: h('10:00:00'), msg: 'QCA-E1 - SEL COMANDO MANUAL LOCAL', et: 'Event', area: SE }]);
  C('classe: registro de estado do resto da SE segue fora da lista', o.ev.length === 0 && o.estados.length === 1, JSON.stringify(o.ev.map((x) => o.msg[x.m])));

  // 3 · prioridade
  const P = (cl, m, n) => A.prioridade(cl, m, n || 'x');
  [['trafo_ts', 'EMU01 TR01 RELÉ BUCHHOLZ TRIP', 1], ['trafo_ts', 'TR01 TEMPERATURA ÓLEO TRIP', 1], ['trafo_ts', 'TRIP DE GÁS', 1], ['trafo_ts', 'TR01 RELÉ BUCHHOLZ ALARME', 2],
    ['trafo_ts', 'TR01 TEMPERATURA ÓLEO ALARME', 2], ['trafo_ts', 'DISJUNTOR GERAL TRIP', 2], ['trafo_ts', 'DISJUNTOR GERAL NORMAL', 0], ['protecao', 'TRIP GERAL', 1, 'trafo'],
    ['protecao', 'SEP ATUADO', 1, 'se'], ['protecao', 'PICKUP 87T FASE A', 2, 'trafo'], ['protecao', 'TRIP GERAL', 2, 'cubiculo'], ['protecao', 'CUB4.1-TRIP MCB TPI.TE11', 2, 'se'], ['sa_cc_ca', 'RET1 - TENSAO CA ANORMAL', 2], ['falha_ied', 'FALHA GOOSE', 2],
    ['inversor_falha', 'PARADO POR FALHA', 3], ['comunicacao', 'WS FALHA COMUNICAÇÃO', 3], ['ncu', 'GATEWAY 1 FALHA DE COMUNICAÇÃO', 3], ['ncu', 'FALHA COMUNICAÇÃO ANEMÔMETRO', 4],
    ['tcu_alarme', 'BATERIA BAIXA', 4], ['tcu_alarme', 'PARADA DE EMERGÊNCIA', 3], ['eletrocentro', 'STATUS PORTA RMU ROOM', 0], ['se_auxiliar', 'CUBICULO - EM LOCAL', 0], ['eletrocentro', 'RMU CONTROLE REMOTO', 0],
    ['eletrocentro', 'DETECTOR DE FUMAÇA RMU ROOM', 2], ['eletrocentro', 'FALHA SPD1', 4]].forEach(([cl, m, p, n]) => C('prioridade de "' + m + '"', P(cl, m, n) === p, P(cl, m, n)));
  const dj = (t, v) => ({ ini: h(t), msg: 'CUB10_2- DJ - ESTADO', area: 'GRL.SE_MRT.[CUB10-2]', fp: 'SE_MRT.CUB10_2.DJ', v, et: 'Event', cn: 'DJ' });
  o = compoe([dj('08:00:00', 'ABERTO'), dj('09:00:00', 'FECHADO')]);
  C('disjuntor sem proteção é posição: `est`, sem `p`', o.ev.length === 1 && o.ev[0].est === 1 && !o.ev[0].p, JSON.stringify(o.ev[0]));
  o = compoe([{ ini: h('07:59:59'), msg: 'CUB10_2- TRIP GERAL', area: 'GRL.SE_MRT.[CUB10-2]', fp: 'SE_MRT.CUB10_2.T', cn: 'T' }, dj('08:00:00', 'ABERTO'), dj('09:00:00', 'FECHADO')]);
  e = o.ev.find((x) => x.c === 'disjuntor');
  C('disjuntor com proteção leva a prioridade dela', e && e.p === 2 && !e.est && e.fi && e.fi.length === 1, JSON.stringify(e));

  // 4 · intermitente e a conferir
  const rep = (hs) => hs.flatMap((t) => [{ ini: h(t), msg: M }, { ini: h(t), ativo: 0, sai: h(t), msg: M }]);
  o = compoe(rep(['10:00:00', '10:00:20', '10:00:59', '12:00:00']));
  e = achaM(o, T);
  C('intermitente: 3 ativações em 60 s', e.filter((x) => x.in === 1).length === 3 && !e[3].in, JSON.stringify(e.map((x) => x.in)));
  o = compoe(rep(['10:00:00', '10:00:31', '10:01:01']));
  C('intermitente: 3 em 61 s não é', achaM(o, T).every((x) => !x.in), JSON.stringify(achaM(o, T).map((x) => x.in)));
  o = compoe(rep(['08:00:00', '12:00:00', '16:00:00']));
  C('intermitente: fugaz repetido no dia não entra', achaM(o, T).every((x) => !x.in));
  const ev = [{ c: 'eletrocentro', i: '2026-10-08T10:00:00', f: null }, { c: 'eletrocentro', i: '2026-10-10T10:00:00', f: null }, { c: 'disjuntor', i: '2026-09-01T10:00:00', f: null },
    { c: 'eletrocentro', i: '2026-09-01T10:00:00', f: '2026-09-02T10:00:00' }];
  A.marcaAConferir(ev, '2026-10-10T23:59:59');
  C('a conferir: sem fim há mais de 24 h', ev[0].a_conferir === 1, JSON.stringify(ev[0]));
  C('a conferir: há menos de 24 h é ativo', !ev[1].a_conferir, JSON.stringify(ev[1]));
  C('a conferir: disjuntor aberto é real', !ev[2].a_conferir, JSON.stringify(ev[2]));
  C('a conferir: o que tem fim não entra', !ev[3].a_conferir, JSON.stringify(ev[3]));
  const pai = [{ c: 'disjuntor', i: '2026-10-08T10:00:00', f: null, p: 1, fi: [{ c: 'protecao', i: '2026-10-08T10:00:00', f: null, p: 1 }] }];
  A.marcaAConferir(pai, '2026-10-10T23:59:59');
  C('a conferir: vale para o filho (a voz lê a marca em qualquer nível), sem mudar a prioridade', pai[0].fi[0].a_conferir === 1 && pai[0].fi[0].p === 1 && pai[0].p === 1, JSON.stringify(pai));
  o = compoe([{ ini: h('10:00:00'), msg: M }]);
  const r0 = A.recorta([o], DIA, '2026-10-12');
  C('a conferir: o corte refaz a marca, porque ela anda com o tempo', !o.ev[0].a_conferir && r0.ev[0].a_conferir === 1, JSON.stringify(r0.ev[0]));

  // 5 · reconhecimento, operador, código do ponto
  o = compoe([{ ini: h('10:00:00'), msg: M, cn: 'KKS1' }, { ini: h('10:00:00'), ativo: 1, ack: 1, ts: h('10:01:00'), ator: 'MRT\\fulano', msg: M, cn: 'KKS1' }]);
  C('reconhecido, sem o login no evento', o.ev[0].ak === 1 && !('op' in o.ev[0]) && !('_op' in o.ev[0]) && o.ev[0].cn === 'KKS1', JSON.stringify(o.ev[0]));
  C('o login vai só para o op_adm', o.op_adm.ev[o.ev[0].id] === 'MRT\\fulano', JSON.stringify(o.op_adm));
  C('nenhum JSON do blob de equipe leva o login', !/fulano/.test(JSON.stringify(o)) && !/fulano/.test(JSON.stringify(A.recorta([o], DIA, DIA))), 'blob');
  o = compoe([{ ini: h('10:00:00'), msg: M, ack: 1, ator: 'System' }]);
  C('`System` não é operador', o.ev[0].ak === 1 && !Object.keys(o.op_adm.ev).length, JSON.stringify(o.op_adm));
  o = compoe([{ ini: h('10:00:00'), msg: 'DJ 14T2 - COMANDO ABRIR', et: 'Command', area: SE, ator: 'MRT\\fulano' }]);
  C('quem comandou vai só para o op_adm', o.estados.length === 1 && o.estados[0].length === 4 && (o.op_adm.estados[o.estados[0].slice(0, 3).join('|')] || []).join() === 'MRT\\fulano', JSON.stringify([o.estados, o.op_adm]));
  o = compoe([{ ini: h('10:00:00'), ativo: 0, sai: h('10:00:00'), ack: 1, msg: 'DJ 14T2 - COMANDO FECHAR', et: 'Command', area: SE, ator: 'MRT\\fulano' }]);
  C('o comando chega só com ConditionActive 0: não entra na lista, e quem comandou fica no op_adm', o.estados.length === 0 && Object.values(o.op_adm.estados).flat().join() === 'MRT\\fulano', JSON.stringify(o.op_adm));
  let barrou = false; try { A.exigeSemOperador(JSON.stringify({ msg: ['MRT\\fulano'] }), 'x'); } catch (x) { barrou = true; }
  C('a guarda recusa blob de equipe com login', barrou);
  let passou = true; try { A.exigeSemOperador(JSON.stringify({ msg: ['MRT05 TS1 X'] }), 'x'); } catch (x) { passou = false; }
  C('a guarda não barra o nome da usina', passou);

  // 6 · árvore
  C('alias: o cubículo de entrada do trafo', A.equipamento({ Area: 'GRL.SE_MRT.[52-TE32]', Message: 'X', FullAlarmSourceName: '' }).no === 'SE|CUB-12.1');
  C('alias: 24 tags ou mais, todas no ramo da SE', Object.keys(A.ALIAS_SE).length >= 24 && Object.values(A.ALIAS_SE).every((v) => v.startsWith('SE|')));
  C('STI: TCU da NCU02 na numeração da NCU', A.tcuNaNcu('M1/TS4/NCU02/TCU091') === 'TCU 1' && A.tcuNaNcu('M3/TS8/NCU02/TCU121') === 'TCU 57' && A.tcuNaNcu('M3/TS3/NCU02/TCU058') === 'TCU 1');
  C('STI: NCU01 e Trina ficam como estão', A.tcuNaNcu('M1/TS4/NCU01/TCU013') === null && A.tcuNaNcu('M6/TS1/NCU02/TCU091') === null);
  o = compoe([{ ini: h('10:00:00'), msg: 'SEC SC.TE11 (DS) - FALHA', area: 'GRL.SE_MRT.[SC-TE11DS]', fp: 'SE_MRT.[SC-TE11DS].A', cn: 'K' }]);
  const r1 = A.recorta([o], DIA, DIA);
  C('alias: `no` chega ao dicionário e passa pelo recorte', o.eq['SC-TE11DS'] && o.eq['SC-TE11DS'].no === 'SE|CUB-4.1|DS' && r1.eq['SC-TE11DS'].no === 'SE|CUB-4.1|DS', JSON.stringify(r1.eq));

  const LG = require('./lib-alarmes-logger.js');
  C('logger: parado é Média, alarme é Baixa', LG.prioridade('inversor_falha') === 3 && LG.prioridade('inversor_parada') === 3 && LG.prioridade('inversor_alarme') === 4 && LG.prioridade('inversor_codigo') === 4);

  // 7 · reinício: pontos que entram sem ter saído, mesmo sem diversidade de classes; surto de pontos novos (22/07/2026 15:27) não é reinício
  const pts = (t0) => { const l = []; for (let k = 0; k < A.REINICIO_TODAS; k++) l.push({ ini: h(t0 + ':' + String(k % 60).padStart(2, '0')), msg: 'MRT05 TS1 INV01 RODANDO ' + k, p: 'I' + k, fp: 'X.I' + k }); return l; };
  o = compoe([...pts('09:00'), { ini: h('10:00:00'), msg: M }, ...pts('15:27'), { ini: h('15:27:10'), msg: M }]);
  e = achaM(o, T);
  C('reinício: reentrada em massa, mesmo sem classes', (o.reinicio || []).includes('2026-10-10T15:27'), JSON.stringify(o.reinicio));
  C('reinício: o regravado não duplica nem encerra o aberto', e.length === 1 && e[0].f === null, JSON.stringify(e));
  const TRIP = { ini: h('15:27:20'), msg: 'TRIP GERAL', area: 'GRL.SE_MRT.[04T2]', fp: 'SE_MRT.04T2.T', cn: 'T' };
  o = compoe([...pts('09:00'), ...pts('15:27'), TRIP]);
  e = o.ev.find((x) => o.msg[x.m] === 'TRIP GERAL');
  C('reinício: proteção nova no minuto do reinício não leva `ri`', (o.reinicio || []).length === 1 && e && !e.ri, JSON.stringify(e));
  o = compoe([...pts('09:00'), TRIP, { ...TRIP, ini: h('15:27:20'), ativo: 0, sai: h('15:27:21') }, { ...TRIP, ini: h('09:30:00') }, ...pts('15:27'), TRIP]);
  e = o.ev.find((x) => o.msg[x.m] === 'TRIP GERAL' && x.i === '2026-10-10T15:27:20');
  C('reinício: a proteção que já estava no ar, essa sim, leva `ri`', !e || e.ri === 1 || e.f, JSON.stringify(e));
  o = compoe(pts('15:27'));
  C('reinício: surto de entradas novas não é reinício', !(o.reinicio || []).length, JSON.stringify(o.reinicio));
  return f;
}

const reais = julga(require(LIB));
if (reais.length) { console.log('🔴 a lib reprova:'); reais.forEach((x) => console.log('  - ' + x)); process.exit(1); }
console.log('✅ a base nova passa nos casos forjados');

const SRC = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
const PLANTIOS = [
  ['a entrada seguinte não encerra', "if (r.ConditionActive === '1' && !r._ri) for (const a of l) if (!a.f && a.i < ini) { a.f = ini; a.fx = 1; }", ''],
  ['o regravado no reinício encerra', "if (r.ConditionActive === '1' && !r._ri) for", "if (r.ConditionActive === '1') for"],
  ['a saída real não tira o `fx`', "e.f = iso(r.OutTime) || iso(r.E3TimeStamp); delete e.fx; }", "e.f = iso(r.OutTime) || iso(r.E3TimeStamp); }"],
  ['encerra sem marcar `fx`', "{ a.f = ini; a.fx = 1; }", "{ a.f = ini; }"],
  ['o herdado não fecha', "if (prox && prox > o.i) { n.f = prox; n.fx = 1; }", ''],
  ['chave com o instante de volta (cada entrada é um ponto)', "const l = abertoDe.get(ponto) || abertoDe.set(ponto, []).get(ponto);", "const l = [];"],
  ['Buchholz sem Crítica', "/BUCHHOLZ TRIP|.LEO TRIP|TRIP DE G.S/.test(m) ? 1 : 2", "2"],
  ['trip de cubículo como Crítica', "n !== 'cubiculo' && !/MCB/.test(m) && /\\bSEP\\b|TRIP|ATUA/.test(m) ? 1 : 2", "!/MCB/.test(m) && /\\bSEP\\b|TRIP|ATUA/.test(m) ? 1 : 2"],
  ['MCB como Crítica', "n !== 'cubiculo' && !/MCB/.test(m) && ", "n !== 'cubiculo' && "],
  ['estado conta como alarme', "if (ESTADO_RE.test(m)) return 0;", ''],
  ['disjuntor sempre alarme', "p0 = e.cl === 'disjuntor' ? 0 : prioridade(e.cl, e.m, e.eq.n)", "p0 = e.cl === 'disjuntor' ? 2 : prioridade(e.cl, e.m, e.eq.n)"],
  ['intermitente em 120 s', 'const INTERM_N = 3, INTERM_S = 60;', 'const INTERM_N = 3, INTERM_S = 120;'],
  ['fugaz repetido volta', 'const INTERM_N = 3, INTERM_S = 60;', 'const INTERM_N = 3, INTERM_S = 86400;'],
  ['a conferir com 1 h', 'const A_CONFERIR_H = 24;', 'const A_CONFERIR_H = 1;'],
  ['disjuntor a conferir', "if (e.f === null && e.c !== 'disjuntor' && e.i < lim)", "if (e.f === null && e.i < lim)"],
  ['o recorte não refaz a marca', "const ev = marcaAConferir([...porId.values()].map(({ e, o }) => re(e, o)).sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.t < b.t ? -1 : 1)), fimJ);", "const ev = [...porId.values()].map(({ e, o }) => re(e, o)).sort((a, b) => (a.i < b.i ? -1 : a.i > b.i ? 1 : a.t < b.t ? -1 : 1));"],
  ['falha de IED volta ao se_auxiliar', "/GOOSE|GPS|FALHA CANAL|BOBINA|FALHA INTERNA|FALHA COMUNICA|PSD-FALHA/.test(m)", "false"],
  ['CC e CA voltam ao se_auxiliar', "|FALTA TENS.O/.test(m)) return 'sa_cc_ca'", "|XXXX/.test(m) && false) return 'sa_cc_ca'"],
  ['o trafo volta para outro', "if (/\\bTR# |BUCHHOLZ|DE G.S\\b|DISJUNTOR GERAL/.test(m)) return 'trafo_ts';", ''],
  ['registro de estado das classes novas na lista', "(r.EventType === 'Event' && DA_SE.has(cl))", "(r.EventType === 'Event' && cl === 'se_auxiliar')"],
  ['op de volta no evento', "if (e.op) o._op = e.op;", "if (e.op) o.op = e.op;"],
  ['o login do comando se perde', "if (operador(r)) { const l = estOp[k] || (estOp[k] = []); if (!l.includes(operador(r))) l.push(operador(r)); }   // só no op_adm\n        if (r.ConditionActive === '0') continue;", "if (r.ConditionActive === '0') continue;\n        if (operador(r)) { const l = estOp[k] || (estOp[k] = []); if (!l.includes(operador(r))) l.push(operador(r)); }"],
  ['op_adm enumerável', "{ value: op, enumerable: false }", "{ value: op, enumerable: true }"],
  ['a guarda não barra', "if (/MRT\\\\/.test(txt)) throw", "if (false) throw"],
  ['a conferir só no topo', "(e.fi || []).forEach(marca); };", "};"],
  ['System como operador', "(r.ActorID && r.ActorID !== 'System' ? r.ActorID : null)", "(r.ActorID || null)"],
  ['sem o nó no dicionário', "if (e.no) o.no = e.no;", ''],
  ['TCU sem desconto da NCU01', "(Number(x[2]) - NCU1_STI[x[1]])", "Number(x[2])"],
  ['o reinício só pelo critério antigo', "x.n >= REINICIO_TODAS && x.re / x.n >= REINICIO_RE", "false"],
  ['proteção nova engolida no reinício', "else if (clk !== 'protecao' || r._re) r._ri = 1;", "else r._ri = 1;"],
  ['surto real vira reinício', "x.n >= REINICIO_TODAS && x.re / x.n >= REINICIO_RE", "x.n >= REINICIO_TODAS"],
];
const tmp = fs.mkdtempSync(path.join(__dirname, '.ensaio-alarmes-base-'));   // ao lado: o require('./lib-…') da lib acha as outras
let ruim = 0;
try {
  PLANTIOS.forEach(([nome, de, para], k) => {
    if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
    const arq = path.join(tmp, 'lib-' + k + '.js');
    fs.writeFileSync(arq, SRC.replace(de, para).replace(/require\('\.\/lib-/g, "require('../lib-"));
    let f; try { f = julga(require(arq)); } catch (e) { f = ['estourou: ' + e.message]; }
    if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 110) + ')');
    else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
