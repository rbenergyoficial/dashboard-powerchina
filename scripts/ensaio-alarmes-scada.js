'use strict';
/*
 * ensaio-alarmes-scada.js — o normalizador da tabela de alarmes do supervisório (lib-alarmes-scada.js), 28/10/2026.
 *
 * 1. O dia REAL de 27/10/2026, lido do cofre (backup-dados-scada, credencial da lib-conteiner; ALARMES_DIR=<pasta> lê de uma pasta):
 *    CUB10_2 e CUB15_2 ABERTOS às 06:23:08 com as proteções do mesmo cubículo como filhos; as paradas dos 44 inversores do M7 como UM
 *    grupo dentro do CUB10_2; nada da operação normal do inversor nem do 'FALHA' gêmeo; redução de potência e falha de comunicação de
 *    TCU só nos resumos; nada de estado de operação de TCU; nenhum id repetido. Dia fixo que sumiu REPROVA, não pula.
 * 2. Linhas FORJADAS à mão (a sequência registrada em campo em 21/09/2026, resumida): proteção do 04T2 → 14T2 ABERTO →
 *    cubículos ABERTOS (um com INVÁLIDO no meio) → 52.TE32 ABERTO → FECHADOS → 14T2 FECHADO, tudo num pai só; linhas que o filtro tira
 *    (inversor, retrocesso de TCU, permissão de comando); a falha de comunicação de TCU como resumo; a rajada do logger do PPC como dois
 *    trechos; a mesma condição de duas origens no mesmo segundo como um evento só.
 * 1b. Os dias REAIS de 27 e 28/10/2026 juntos (255 mil linhas; peça revisada pela sessão do Portal em 29/10): sem estouro de pilha; a SC1 do
 *    CUB11_2 e do CUB15_2 no próprio cubículo (o E3 grava a Area do CUB10_2 nelas); a reemissão de 28/10 19:46 (InTime de meses atrás)
 *    não abre disjuntor nem estado; registro de estado e comando da SE no resumo `estados`, fora da lista; o GMG "em carga" 07:20–07:54;
 *    o CUB14_2 03:41:57–03:45:29; parada de emergência de vários TCU como grupo, no topo; o REINÍCIO do supervisório de 28/10 19:46
 *    (os alarmes ativos regravados com o InTime do reinício) detectado, cada episódio dele marcado `ri`, fora dos grupos, sem duplicar o
 *    alarme que já estava aberto; o trafo auxiliar na classe do eletrocentro.
 * 3. A semente: disjuntor ABERTO na publicação anterior fecha com o FECHADO de hoje; alarme ainda sem fim segue, e fecha quando a linha de
 *    saída chega. 4. A versão regravada mais nova vence; nome desconhecido estoura. 5. O recorte de 7 dias refaz os dicionários.
 * Depois PLANTA defeitos numa cópia da lib e exige que cada um reprove.
 * uso: node scripts/ensaio-alarmes-scada.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const LIB = path.join(__dirname, 'lib-alarmes-scada.js');
const DIA_REAL = '2026-10-27', DIA_REAL2 = '2026-10-28';

async function leReal(dia) {
  if (process.env.ALARMES_DIR) {
    const f = path.join(process.env.ALARMES_DIR, dia.slice(0, 7), 'alarms_' + dia + '.csv.gz');
    if (!fs.existsSync(f)) throw new Error('o dia fixo ' + dia + ' não está em ' + process.env.ALARMES_DIR + ': reprova');
    return zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');
  }
  const RAW = process.env.RAW || 'backup-dados-scada';
  const c = require('./lib-conteiner').conteiner(RAW);
  const itens = new Map();
  for await (const b of c.listBlobsFlat({ prefix: 'SCADA_DB/bruto/alarmes/' + dia.slice(0, 7) + '/' })) itens.set(b.name, b);
  const nome = require(LIB).escolheVersoes([...itens.keys()]).get(dia);
  if (!nome) throw new Error('o dia fixo ' + dia + ' não está no cofre: reprova');
  // a cópia em disco entre rodadas (lib-cache-blob, CACHE_BLOB_DIR) numa subpasta PRÓPRIA: a poda do gerador não a alcança, e o ensaio não poda
  const cache = require('./lib-cache-blob').abre(RAW, process.env.CACHE_BLOB_DIR ? path.join(process.env.CACHE_BLOB_DIR, 'ensaio') : '');
  return zlib.gunzipSync(await cache.baixa(c, itens.get(nome))).toString('utf8');
}

// ---- forjados (19 colunas do arquivo da coleta) ----
const COLS = ['E3TimeStamp', 'InTime', 'OutTime', 'EventTimeDbl', 'Acked', 'ActiveSource', 'ConditionActive', 'Severity', 'EventType',
  'ConditionName', 'FormattedValue', 'CurrentValue', 'Quality', 'Area', 'Source', 'AlarmSourceName', 'FullAlarmSourceName', 'Message', 'ActorID'];
const SEM = '1899-12-30 00:00:00.000';
const q = (v) => (/[;"\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
function L(dia, hh, { ini = hh, out = null, ativo = 1, cond = 'C', val = 'ATUADO', area, src, msg, sev = '0' }) {
  const t = (h) => dia + ' ' + h + '.000';
  const o = { E3TimeStamp: t(hh), InTime: t(ini), OutTime: out ? t(out) : SEM, EventTimeDbl: '0', Acked: '0', ActiveSource: '1', ConditionActive: String(ativo),
    Severity: sev, EventType: 'Condition', ConditionName: cond, FormattedValue: val, CurrentValue: '0', Quality: 'Good', Area: area, Source: '', AlarmSourceName: '',
    FullAlarmSourceName: src || area + '.' + cond, Message: msg, ActorID: '' };
  return COLS.map((c) => q(o[c])).join(';');
}
const csv = (linhas) => COLS.join(';') + '\r\n' + linhas.join('\r\n') + '\r\n';
const D = '2026-09-21';
const CASCATA = csv([
  L(D, '14:10:36', { cond: 'UPPT2_PDIF', area: 'GRL.SE_MRT.[04T2]', msg: 'ATUAÇÃO PROTEÇÕES INTRÍNSECAS + DIFERENCIAL' }),
  L(D, '14:10:37', { ini: '14:10:36', out: '14:10:36', ativo: 0, cond: 'UPPT2_PDIF', val: 'DESATUADO', area: 'GRL.SE_MRT.[04T2]', msg: 'ATUAÇÃO PROTEÇÕES INTRÍNSECAS + DIFERENCIAL' }),
  L(D, '14:10:36', { cond: 'SEP_A', area: 'GRL.SE_MRT.[04T2]', src: 'SE_MRT.[04T2].A.SEP', msg: 'TRIP SEP PP (Sistema Axia)' }),
  L(D, '14:10:36', { cond: 'SEP_B', area: 'GRL.SE_MRT.[04T2]', src: 'SE_MRT.[04T2].B.SEP', msg: 'TRIP SEP PP (Sistema Axia)' }),   // 2ª origem
  L(D, '14:10:37', { cond: 'DJ', val: 'ABERTO', area: 'GRL.SE_MRT.[14T2]', msg: 'DJ 14T2 - ESTADO' }),
  L(D, '14:10:37', { cond: 'DJP', area: 'GRL.SE_MRT.[14T2]', msg: 'DJ 14T2 - PERMISSÃO FECHAMENTO' }),
  L(D, '14:36:18', { cond: 'DJ', val: 'INVÁLIDO', area: 'GRL.SE_MRT.[CUB15-1]', msg: 'CUB15_1- DJ - ESTADO' }),
  L(D, '14:36:18', { cond: 'DJ', val: 'ABERTO', area: 'GRL.SE_MRT.[CUB15-1]', msg: 'CUB15_1- DJ - ESTADO' }),
  L(D, '14:36:20', { cond: 'DJ', val: 'INVÁLIDO', area: 'GRL.SE_MRT.[CUB15-1]', msg: 'CUB15_1- DJ - ESTADO' }),
  L(D, '14:38:38', { cond: 'DJ', val: 'ABERTO', area: 'GRL.SE_MRT.[CUB10-2]', msg: 'CUB10_2- DJ - ESTADO' }),
  L(D, '14:39:18', { cond: 'DJ', val: 'ABERTO', area: 'GRL.SE_MRT.[52-TE32]', msg: 'DJ 52.TE32 - ESTADO' }),
  L(D, '14:48:29', { cond: 'DJ', val: 'FECHADO', area: 'GRL.SE_MRT.[14T2]', msg: 'DJ 14T2 - ESTADO' }),
  L(D, '14:48:48', { cond: 'DJ', val: 'FECHADO', area: 'GRL.SE_MRT.[52-TE32]', msg: 'DJ 52.TE32 - ESTADO' }),
  L(D, '14:50:59', { cond: 'DJ', val: 'FECHADO', area: 'GRL.SE_MRT.[CUB15-1]', msg: 'CUB15_1- DJ - ESTADO' }),
  L(D, '14:51:18', { cond: 'DJ', val: 'FECHADO', area: 'GRL.SE_MRT.[CUB10-2]', msg: 'CUB10_2- DJ - ESTADO' }),
  // o que o filtro tira: operação normal do inversor, o 'FALHA' gêmeo do PARADO POR FALHA, estado de operação do TCU
  L(D, '10:00:00', { cond: 'X', area: 'GRL.UFV.MRT05.TS1.INV01', msg: 'MRT05 TS1 INV01 FALHA' }),
  L(D, '10:00:00', { cond: 'RO', area: 'GRL.UFV.MRT05.TS1.INV01', msg: 'MRT05 TS1 INV01 RODANDO' }),
  L(D, '10:00:00', { cond: 'R', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU001', msg: 'MRT05 TS1 TCU001 INDICADOR DE RETROCESSO' }),
  // inversor: parada isolada (fica como evento), grupo de 3 no M3 no distúrbio (vai para dentro do 14T2), redução de potência (resumo)
  L(D, '10:30:00', { cond: 'PF', area: 'GRL.UFV.MRT05.TS2.INV03', msg: 'MRT05 TS2 INV03 PARADO POR FALHA' }),
  L(D, '10:40:00', { ini: '10:30:00', out: '10:40:00', ativo: 0, cond: 'PF', val: 'NORMAL', area: 'GRL.UFV.MRT05.TS2.INV03', msg: 'MRT05 TS2 INV03 PARADO POR FALHA' }),
  L(D, '14:10:40', { cond: 'PF', area: 'GRL.UFV.MRT03.TS1.INV01', msg: 'MRT03 TS1 INV01 PARADO POR FALHA' }),
  L(D, '14:10:41', { cond: 'PF', area: 'GRL.UFV.MRT03.TS1.INV02', msg: 'MRT03 TS1 INV02 PARADO POR FALHA' }),
  L(D, '14:10:42', { cond: 'PF', area: 'GRL.UFV.MRT03.TS2.INV07', msg: 'MRT03 TS2 INV07 PARADO POR FALHA' }),
  L(D, '15:00:00', { cond: 'RP', area: 'GRL.UFV.MRT05.TS2.INV03', msg: 'MRT05 TS2 INV03 REDUÇÃO DE POTÊNCIA' }),
  L(D, '15:15:00', { ini: '15:00:00', out: '15:15:00', ativo: 0, cond: 'RP', val: 'NAO ATUADO', area: 'GRL.UFV.MRT05.TS2.INV03', msg: 'MRT05 TS2 INV03 REDUÇÃO DE POTÊNCIA' }),
  // parada de emergência de 3 TCU do M3 durante a abertura do 14T2: grupo próprio, NO TOPO (o TCU tem bateria; a abertura não o explica)
  L(D, '14:20:00', { cond: 'PE', area: 'GRL.UFV.MRT03.TS1.NCU01.TCU010', msg: 'MRT03 TS1 TCU010 PARADA DE EMERGÊNCIA' }),
  L(D, '14:21:00', { cond: 'PE', area: 'GRL.UFV.MRT03.TS1.NCU01.TCU011', msg: 'MRT03 TS1 TCU011 PARADA DE EMERGÊNCIA' }),
  L(D, '14:22:00', { cond: 'PE', area: 'GRL.UFV.MRT03.TS2.NCU01.TCU040', msg: 'MRT03 TS2 TCU040 PARADA DE EMERGÊNCIA' }),
  // alarme de TCU (fica) e falha de comunicação de TCU (vira resumo: 2 entradas, 10 + 20 min)
  L(D, '11:00:00', { cond: 'B', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU007', msg: 'MRT05 TS1 TCU007 NÍVEL CRÍTICO DA BATERIA' }),
  L(D, '12:00:00', { cond: 'CO', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU009', msg: 'MRT05 TS1 TCU009 FALHA DE COMUNICAÇÃO' }),
  L(D, '12:10:00', { ini: '12:00:00', out: '12:10:00', ativo: 0, cond: 'CO', val: 'NORMAL', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU009', msg: 'MRT05 TS1 TCU009 FALHA DE COMUNICAÇÃO' }),
  L(D, '13:00:00', { cond: 'CO', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU009', msg: 'MRT05 TS1 TCU009 FALHA DE COMUNICAÇÃO' }),
  L(D, '13:20:00', { ini: '13:00:00', out: '13:20:00', ativo: 0, cond: 'CO', val: 'NORMAL', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU009', msg: 'MRT05 TS1 TCU009 FALHA DE COMUNICAÇÃO' }),
  // rajada do logger do PPC no M8: 3 falhas em 10 min (um trecho) e 1 falha 40 min depois (outro trecho)
  L(D, '17:50:00', { cond: 'L1', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS1' }),
  L(D, '17:52:00', { ini: '17:50:00', out: '17:52:00', ativo: 0, cond: 'L1', val: 'NORMAL', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS1' }),
  L(D, '17:55:00', { cond: 'L1', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS1' }),
  L(D, '17:58:00', { ini: '17:55:00', out: '17:58:00', ativo: 0, cond: 'L1', val: 'NORMAL', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS1' }),
  L(D, '17:59:00', { cond: 'L3', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS3' }),
  L(D, '18:01:00', { ini: '17:59:00', out: '18:01:00', ativo: 0, cond: 'L3', val: 'NORMAL', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS3' }),
  L(D, '18:41:00', { cond: 'L3', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS3' }),
  L(D, '18:45:00', { ini: '18:41:00', out: '18:45:00', ativo: 0, cond: 'L3', val: 'NORMAL', area: 'GRL.UFV.MRT.PPC.MRT08', msg: 'MRT08 COMUNICAÇÃO LOGGER TS3' }),
]);

function casos(A, REAL, REAL2) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const txt = (o, e) => o.msg[e.m];
  const ids = (o) => { const s = []; const anda = (e) => { s.push(e.id); (e.fi || []).forEach(anda); }; o.ev.forEach(anda); return s; };

  // 1 · o dia real
  const r = A.compoe([{ dia: DIA_REAL, txt: REAL }], DIA_REAL, DIA_REAL, { gerado: 'ensaio' });
  for (const cub of ['CUB10_2', 'CUB15_2']) {
    const e = r.ev.find((x) => x.c === 'disjuntor' && x.t === cub && x.i === DIA_REAL + 'T06:23:08');
    C('27/10: ' + cub + ' ABERTO às 06:23:08', !!e);
    const pr = e ? (e.fi || []).filter((x) => x.c === 'protecao') : [];
    if (e) C('27/10: ' + cub + ' leva as proteções do cubículo como filhos', pr.length >= 1 && pr.every((x) => x.t === cub),
      JSON.stringify((e.fi || []).map((x) => x.t + '/' + x.c)));
  }
  const textos = r.msg.join('|');
  C('27/10: nada da operação normal do inversor nem do FALHA gêmeo', !/RODANDO|DISPATCH RUN|CONECTADO À REDE|INICIANDO|EM ESPERA/.test(textos) && !r.msg.includes('FALHA'));
  // o M7 tem 2 eletrocentros de 22 inversores (placa): a parada das 06:23 é UM grupo com os 44, dentro do CUB10_2
  const c10 = r.ev.find((x) => x.c === 'disjuntor' && x.t === 'CUB10_2' && x.i === DIA_REAL + 'T06:23:08');
  const g7 = c10 && (c10.fi || []).find((x) => x.c === 'inversor_falha' && x.t === 'M7');
  C('27/10: as paradas do M7 às 06:23 são um grupo dentro do CUB10_2, com os 44 inversores', g7 && g7.inv && g7.inv.TS1.length === 22 && g7.inv.TS2.length === 22,
    JSON.stringify(g7 && g7.inv && Object.fromEntries(Object.entries(g7.inv).map(([k, v]) => [k, v.length]))));
  C('27/10: redução de potência só no resumo', !/REDU..O DE POT/.test(textos) && r.inv_red.length > 100, r.inv_red.length + ' resumos');
  C('27/10: nada de estado de operação de TCU', !/RETROCESSO|LIMITE (SUPERIOR|INFERIOR) DE SW|POSIÇÃO SEGURA|SISTEMA OK|PARTIDA PERMITIDA/.test(textos));
  C('27/10: falha de comunicação de TCU só no resumo', !/FALHA DE COMUNICA/.test(r.ev.filter((e) => e.c === 'tcu_alarme').map((e) => txt(r, e)).join('|')) && r.tcu_com.length > 100,
    r.tcu_com.length + ' resumos');
  const iR = ids(r); C('27/10: nenhum id repetido', new Set(iR).size === iR.length, iR.length - new Set(iR).size + ' repetidos');

  // 1b · os dois dias reais juntos
  const r2 = A.compoe([{ dia: DIA_REAL, txt: REAL }, { dia: DIA_REAL2, txt: REAL2 }], DIA_REAL, DIA_REAL2, { gerado: 'ensaio' });
  const djs = r2.ev.filter((e) => e.c === 'disjuntor');
  const sc1 = (cub) => djs.filter((e) => e.t === cub && txt(r2, e) === 'SC1 - ESTADO' && e.i.startsWith(DIA_REAL + 'T17:1')).map((e) => e.i.slice(11) + '→' + e.f);
  C('27–28/10: SC1 do CUB11_2 no próprio cubículo', JSON.stringify(sc1('CUB11_2')) === JSON.stringify(['17:11:57→2026-10-28T01:53:40']), JSON.stringify(sc1('CUB11_2')));
  C('27–28/10: SC1 do CUB15_2 no próprio cubículo', JSON.stringify(sc1('CUB15_2')) === JSON.stringify(['17:12:19→2026-10-28T01:54:40']), JSON.stringify(sc1('CUB15_2')));
  C('27–28/10: o CUB10_2 tem uma SC1 só', sc1('CUB10_2').length === 1, JSON.stringify(sc1('CUB10_2')));
  const semFim = djs.filter((e) => e.f === null);
  C('27–28/10: nenhum disjuntor aberto até agora (a reemissão das 19:46 não abre nada)', semFim.length === 0, JSON.stringify(semFim.map((e) => e.t + ' ' + e.i)));
  C('27–28/10: a reemissão é contada em retx', r2.retx.some((x) => x[0] === DIA_REAL2 && x[1] > 9000), JSON.stringify(r2.retx));
  const aux = r2.ev.filter((e) => e.c === 'se_auxiliar');
  C('27–28/10: registro de estado da SE fora da lista (≤ 5 alarmes de serviço auxiliar, nada de chave de terra nem local)',
    aux.length <= 5 && !/TERRA|EM LOCAL/.test(aux.map((e) => txt(r2, e)).join('|')), aux.length + ' ' + JSON.stringify(aux.slice(0, 5).map((e) => txt(r2, e))));
  C('27–28/10: a comutação de tap no resumo de estados', r2.estados.some((x) => x[1] === '04T1' && /COMUTA..O DE TAP/.test(x[2]) && x[3] >= 1), JSON.stringify(r2.estados.slice(0, 3)));
  const gmg = djs.filter((e) => e.t === 'GMG');
  C('27–28/10: GMG em carga 07:20:20–07:54:34 (normalmente aberto)', gmg.length === 1 && gmg[0].i === DIA_REAL2 + 'T07:20:20' && gmg[0].f === DIA_REAL2 + 'T07:54:34' && gmg[0].v === 'FECHADO',
    JSON.stringify(gmg));
  C('27–28/10: CUB14_2 aberto 03:41:57–03:45:29', djs.some((e) => e.t === 'CUB14_2' && e.i === DIA_REAL2 + 'T03:41:57' && e.f === DIA_REAL2 + 'T03:45:29'));
  const gt = r2.ev.filter((e) => e.c === 'tcu_alarme' && e.tcu);
  C('27–28/10: alarmes simultâneos de TCU em grupo', gt.length >= 5 && gt.every((e) => e.k >= 3 && /\(grupo\)$/.test(txt(r2, e))), gt.length + ' grupos');
  C('28/10: o reinício das 19:46 detectado (e só ele)', JSON.stringify(r2.reinicio) === JSON.stringify([DIA_REAL2 + 'T19:46']), JSON.stringify(r2.reinicio));
  const todos = []; const achata = (e) => { todos.push(e); (e.fi || []).forEach(achata); }; r2.ev.forEach(achata);
  const em1946 = todos.filter((e) => e.i.startsWith(DIA_REAL2 + 'T19:46'));
  C('28/10: nada começa às 19:46 sem a marca do reinício', em1946.length > 200 && em1946.every((e) => e.ri === 1),
    em1946.filter((e) => !e.ri).slice(0, 5).map((e) => e.c + ' ' + e.t + ' ' + txt(r2, e)).join(' | ') + ' · ' + em1946.length);
  const ta = em1946.filter((e) => /TEMPERATURA TRAFO AUX/.test(txt(r2, e)));
  C('28/10: o alarme de temperatura do trafo auxiliar dos 56 eletrocentros, marcado e na classe do eletrocentro', ta.length === 56 && ta.every((e) => e.ri && e.c === 'eletrocentro'),
    ta.length + ' ' + JSON.stringify([...new Set(ta.map((e) => e.c))]));
  const porCh = new Map(); for (const e of todos) if (!e.ri) { const k = e.t + '|' + txt(r2, e); (porCh.get(k) || porCh.set(k, []).get(k)).push(e); }
  const dup = em1946.filter((e) => (porCh.get(e.t + '|' + txt(r2, e)) || []).some((x) => x.i < e.i && (!x.f || x.f >= e.i)));
  C('28/10: o regravado no reinício não duplica o alarme já aberto', dup.length === 0, dup.slice(0, 3).map((e) => e.t + ' ' + txt(r2, e)).join(' | '));
  const iR2 = ids(r2); C('27–28/10: nenhum id repetido', new Set(iR2).size === iR2.length, iR2.length - new Set(iR2).size + ' repetidos');

  // 2 · forjados
  const o = A.compoe([{ dia: D, txt: CASCATA }], D, D, { gerado: 'ensaio' });
  const dj = o.ev.filter((e) => e.c === 'disjuntor');
  C('cascata: um pai só no topo, o 14T2', dj.length === 1 && dj[0].t === '14T2' && dj[0].i === D + 'T14:10:37' && dj[0].f === D + 'T14:48:29',
    JSON.stringify(dj.map((e) => e.t + ' ' + e.i + '→' + e.f)));
  const fi = dj.length ? dj[0].fi || [] : [];
  C('cascata: filhos = proteção do 04T2 + CUB15_1 + CUB10_2 + 52-TE32 + o grupo de paradas do M3', JSON.stringify(fi.map((x) => x.c + ':' + x.t).sort())
    === JSON.stringify(['disjuntor:52-TE32', 'disjuntor:CUB10_2', 'disjuntor:CUB15_1', 'inversor_falha:M3', 'protecao:04T2', 'protecao:04T2'].sort()), JSON.stringify(fi.map((x) => x.c + ':' + x.t)));
  const g3 = fi.find((x) => x.t === 'M3');
  C('grupo de paradas: 3 inversores de 2 eletrocentros', g3 && JSON.stringify(g3.inv) === JSON.stringify({ TS1: ['01', '02'], TS2: ['07'] }), JSON.stringify(g3));
  const iso1 = o.ev.find((e) => e.c === 'inversor_falha' && e.t === 'M5/TS2/INV03');
  C('parada isolada: evento próprio no topo, com fim', iso1 && iso1.i === D + 'T10:30:00' && iso1.f === D + 'T10:40:00' && o.msg[iso1.m] === 'PARADO POR FALHA', JSON.stringify(iso1));
  C('redução de potência: resumo [dia, tag, 1, 15 min]', JSON.stringify(o.inv_red) === JSON.stringify([[D, 'M5/TS2/INV03', 1, 15]]), JSON.stringify(o.inv_red));
  const c15 = fi.find((x) => x.t === 'CUB15_1');
  C('cascata: INVÁLIDO no meio não abre episódio novo (conta como evidência)', c15 && c15.k === 1 && c15.f === D + 'T14:50:59', JSON.stringify(c15));
  const sep = fi.filter((x) => x.c === 'protecao' && txt(o, x) === 'TRIP SEP PP (Sistema Axia)');
  C('duas origens no mesmo segundo = um evento', sep.length === 1 && sep[0].k === 2, JSON.stringify(sep));
  const tx = o.msg.join('|');
  C('filtro: fora RODANDO, o FALHA gêmeo, retrocesso e permissão', !/RODANDO|RETROCESSO|PERMISS/.test(tx) && !o.msg.includes('FALHA'), tx);
  C('alarme de TCU fica na lista', o.ev.some((e) => e.c === 'tcu_alarme' && e.t === 'M5/TS1/NCU01/TCU007'));
  const gT = o.ev.find((e) => e.c === 'tcu_alarme' && e.t === 'M3');
  C('grupo de TCU no topo, fora do 14T2', gT && JSON.stringify(gT.tcu) === JSON.stringify({ 'TS1/NCU01': ['010', '011'], 'TS2/NCU01': ['040'] })
    && o.msg[gT.m] === 'PARADA DE EMERGÊNCIA (grupo)', JSON.stringify(gT));
  C('falha de comunicação de TCU: resumo [dia, tag, 2 entradas, 30 min]', JSON.stringify(o.tcu_com) === JSON.stringify([[D, 'M5/TS1/NCU01/TCU009', 2, 30]]), JSON.stringify(o.tcu_com));
  const raj = o.ev.filter((e) => e.c === 'comunicacao' && e.t === 'M8');
  C('rajada do logger: dois trechos com resumo por eletrocentro', raj.length === 2 && JSON.stringify(raj[0].ts) === JSON.stringify({ TS1: [2, 5], TS3: [1, 2] })
    && raj[0].f === D + 'T18:01:00' && JSON.stringify(raj[1].ts) === JSON.stringify({ TS3: [1, 4] }), JSON.stringify(raj));
  const iO = ids(o); C('forjado: nenhum id repetido', new Set(iO).size === iO.length);

  // 3 · semente
  const D2 = '2026-10-28';
  const ant = { ev: [{ id: 'disjuntor:CUB15_2:2026-10-20T08:00:00:DJ - ESTADO', c: 'disjuntor', t: 'CUB15_2', i: '2026-10-20T08:00:00', f: null, m: 0, v: 'ABERTO' },
    { id: 'tcu_alarme:M5/TS1/NCU01/TCU007:2026-10-25T09:00:00:EIXO BLOQUEADO', c: 'tcu_alarme', t: 'M5/TS1/NCU01/TCU007', i: '2026-10-25T09:00:00', f: null, m: 1 },
    { id: 'ncu:M5/TS1/NCU01:2026-10-26T09:00:00:VENTO ALTO', c: 'ncu', t: 'M5/TS1/NCU01', i: '2026-10-26T09:00:00', f: null, m: 2 }],
  msg: ['DJ - ESTADO', 'EIXO BLOQUEADO', 'VENTO ALTO'], dias: ['2026-10-27'],
  eq: { CUB15_2: { u: 'M9', n: 'cubiculo', pai: '04T2' }, 'M5/TS1/NCU01/TCU007': { u: 'M5', n: 'tcu', pai: 'M5/TS1/NCU01' }, 'M5/TS1/NCU01': { u: 'M5', n: 'ncu', pai: 'M5/TS1' } } };
  const hoje = csv([L(D2, '07:00:00', { cond: 'DJ', val: 'FECHADO', area: 'GRL.SE_MRT.[CUB15-2]', msg: 'CUB15_2- DJ - ESTADO' }),
    L(D2, '07:30:00', { ini: '2026-10-25 09:00:00'.slice(11), out: '07:30:00', ativo: 0, cond: 'EB', val: 'NORMAL', area: 'GRL.UFV.MRT05.TS1.NCU01.TCU007', msg: 'MRT05 TS1 TCU007 EIXO BLOQUEADO' })
      .replace(D2 + ' 09:00:00.000', '2026-10-25 09:00:00.000')]);
  const s = A.compoe([{ dia: D2, txt: hoje }], D2, D2, { gerado: 'ensaio', anterior: ant });
  const fechou = s.ev.find((e) => e.c === 'disjuntor' && e.t === 'CUB15_2');
  C('semente: o ABERTO de 20/10 fecha com o FECHADO de hoje', fechou && fechou.i === '2026-10-20T08:00:00' && fechou.f === D2 + 'T07:00:00', JSON.stringify(fechou));
  const eixo = s.ev.filter((e) => e.t === 'M5/TS1/NCU01/TCU007');
  C('semente: o alarme sem fim fecha quando a saída chega (mesmo id, um só)', eixo.length === 1 && eixo[0].f === D2 + 'T07:30:00' && s.msg[eixo[0].m] === 'EIXO BLOQUEADO', JSON.stringify(eixo));
  const vento = s.ev.find((e) => e.t === 'M5/TS1/NCU01');
  C('semente: o alarme sem fim e sem saída segue aberto, com o texto certo', vento && vento.f === null && s.msg[vento.m] === 'VENTO ALTO' && s.eq['M5/TS1/NCU01'], JSON.stringify(vento));
  // com BURACO entre a publicação anterior e o 1º dia lido (o último dia dela é 20/10, a leitura começa em 28/10) nada atravessa: o
  // fim do que estava aberto é desconhecido (29/10/2026: abr/2025–set/2026 ainda fora do cofre punham mar/2025 aberto em out/2026)
  const sb = A.compoe([{ dia: D2, txt: hoje }], D2, D2, { gerado: 'ensaio', anterior: { ...ant, dias: ['2026-10-20'] } });
  C('semente: com buraco antes do 1º dia lido, nada do anterior atravessa', !sb.ev.some((e) => e.t === 'M5/TS1/NCU01' || (e.c === 'disjuntor' && e.t === 'CUB15_2')),
    JSON.stringify(sb.ev.map((e) => e.c + ':' + e.t + ' ' + e.i)));

  // 4 · versões
  const P = 'SCADA_DB/bruto/alarmes/2026-10/alarms_';
  const v = A.escolheVersoes([P + '2026-10-27.csv.gz', P + '2026-10-27.csv.gz~20261029-061000', P + '2026-10-27.csv.gz~20261028-060500', P + '2026-10-26.csv.gz', 'SCADA_DB/bruto/alarmes/logs/x.log']);
  C('versões: a regravada mais nova vence', v.get('2026-10-27') === P + '2026-10-27.csv.gz~20261029-061000' && v.get('2026-10-26') === P + '2026-10-26.csv.gz' && v.size === 2,
    JSON.stringify([...v]));
  let estourou = false; try { A.escolheVersoes([P + '2026-10-27.csv.gz.tmp']); } catch (e) { estourou = true; }
  C('versões: nome desconhecido estoura', estourou);

  // 5 · recorte
  const j = A.recorta([o, s], '2026-09-21', '2026-10-28', { gerado: 'ensaio' });
  const jj = j.ev.find((e) => e.t === 'M5/TS1/NCU01');
  C('recorte: refaz o dicionário de textos', jj && j.msg[jj.m] === 'VENTO ALTO' && j.ev.some((e) => e.t === '14T2' && j.msg[e.m] === 'DJ 14T2 - ESTADO'), JSON.stringify(jj));
  const k = A.recorta([o, s], D2, D2, { gerado: 'ensaio' });
  C('recorte: a janela corta o que terminou antes e o resumo de outro dia', !k.ev.some((e) => e.t === '14T2') && k.tcu_com.length === 0 && k.ev.some((e) => e.t === 'M5/TS1/NCU01'));
  return f;
}

(async () => {
  const REAL = await leReal(DIA_REAL), REAL2 = await leReal(DIA_REAL2);
  const reais = casos(require(LIB), REAL, REAL2);
  if (reais.length) { console.log('🔴 a lib real reprova:'); reais.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('✅ lib real: todos os casos passam');
  const SRC = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
  const PLANTIOS = [
    ['a operação normal do inversor entra', "    return null;   // operação normal", "    return 'inversor_alarme';   // operação normal"],
    ['o FALHA gêmeo entra', "if (/PARADO POR FALHA|BOT.O DE PARADA/.test(m))", "if (/FALHA|BOT.O DE PARADA/.test(m))"],
    ['as paradas simultâneas não agrupam', 'const GRUPO_INV_N = 3,', 'const GRUPO_INV_N = 1e9,'],
    ['o grupo não vai para o disjuntor', 'if (alvo) alvo.fi.push(g); else fora.push(g);', 'fora.push(g);'],
    ['a redução de potência vai à lista', "!['tcu_com', 'logger_ppc', 'inversor_reducao'].includes(e.cl)", "!['tcu_com', 'logger_ppc'].includes(e.cl)"],
    ['o estado de operação do TCU entra', 'if (FORA_TCU.test(m)) return null;', ''],
    ['INVÁLIDO abre episódio novo', "if (anormal.test(v)) {", "if (!normal.test(v)) {"],
    ['sem agrupamento da SE', 'const dentro = agrupaSe(eps);', 'const dentro = new Set();'],
    ['a versão mais velha vence', 'if (!atual || v > atual.v)', 'if (!atual || v < atual.v)'],
    ['sem semente do anterior', 'const eps0 = episodios(rows, semente);', 'const eps0 = episodios(rows, []);'],
    ['a rajada do logger sem resumo', 'const logger = agrupaLogger(eps);', "const logger = eps.filter((e) => e.cl === 'logger_ppc').map((e) => ({ ...e, cl: 'comunicacao' }));"],
    ['duas origens viram dois eventos', 'if (x) { x.k = (x.k || 1) + (o.k || 1); continue; }', 'if (x && false) { continue; }'],
    ['dois dias pelo espalhamento (estoura a pilha)', 'for (const r of linhasCsv(txt)) {', 'const _l = linhasCsv(txt); rows.push(..._l); for (const r of []) {'],
    ['o cubículo pela Area', 'const tag = CUB_DO_PONTO(r) || x[1]', 'const tag = x[1]'],
    ['a reemissão vira evento', 'if (!transicao(r, dia)) { n++; continue; }', 'if (false) { n++; continue; }'],
    ['registro de estado e comando na lista', 'if (SO_ESTADO(r, cl)) {', 'if (false) {'],
    ['o GMG como disjuntor normalmente fechado', 'NORMAL_ABERTO.has(eq.tag) ?', 'false ?'],
    ['alarmes de TCU sem grupo', "const doTcu = (e) => e.cl === 'tcu_alarme';", 'const doTcu = (e) => false;'],
    ['o grupo de TCU vai para o disjuntor', 'if (g.tcu) { fora.push(g); continue; }', ''],
    ['sem detecção do reinício', 'const REINICIO_N = 300,', 'const REINICIO_N = 1e9,'],
    ['o regravado no reinício duplica', "const eps = eps0.filter((e) => !e.ri ||", "const eps = eps0.filter((e) => true ||"],
    ['o regravado no reinício entra nos grupos', 'eps.filter((x) => !x.ri && (x.cl in TEXTO_GRUPO', 'eps.filter((x) => (x.cl in TEXTO_GRUPO'],
    ['o trafo auxiliar fora do eletrocentro', '|COMANDO|TRAFO AUX/', '|COMANDO/'],
    ['a semente atravessa o buraco', 'const antAbertos = anterior && encosta ?', 'const antAbertos = anterior ?'],
    ['o recorte não refaz os textos', 'const n = { ...e, m: idx(o.msg[e.m]) };', 'const n = { ...e }; idx(o.msg[e.m]);'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-alarmes-scada-'));
  let ruim = 0;
  try {
    for (const lib of ['lib-scada-db.js', 'lib-zip.js']) fs.copyFileSync(path.join(__dirname, lib), path.join(tmp, lib));   // dependências da lib
    PLANTIOS.forEach(([nome, de, para], k) => {
      if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
      const arq = path.join(tmp, 'lib-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para));
      let f; try { f = casos(require(arq), REAL, REAL2); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 160) + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
  console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
})().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
