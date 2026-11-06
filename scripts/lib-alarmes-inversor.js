'use strict';
/*
 * lib-alarmes-inversor.js — o bloco `p2` do inversores.json a partir da base nova de alarmes (lote inversores-alarmes-base, 06/11/2026).
 *
 * Até aqui o `p2` vinha só da planilha exportada do monitoramento, salva pela última vez em 03/08/2026 com dado até 06/2026. Agora:
 *   planilha          até o mês anterior ao início do logger (o histórico antigo, que o logger não tem);
 *   logger            do primeiro mês com dado em diante (hist/alarmes_logger_AAAA_MM.json);
 *   supervisório      só no mês que o logger não cobrir (hist/alarmes_scada_AAAA_MM.json).
 * Um mês vem de UMA fonte só: nunca soma duas.
 *
 * 🔴 AS BASES NÃO TÊM A MESMA ESCALA. A planilha conta cada alarme do monitoramento, inclusive o que dura segundos; o logger conta o episódio
 * que aparece nas amostras de 5 em 5 min. Na sobreposição de abr–jun/2026 a planilha traz de 2 a 30 vezes mais eventos em Rede, Aviso e Anomalia;
 * em isolamento as duas batem (mesmos inversores, 83–95 %). O número por mês não se compara de um lado ao outro da junção.
 * Por isso a planilha vale até jun/2026 e o logger só de jul/2026 em diante (decisão do humano, 06/11/2026), mesmo com o logger cobrindo desde abril.
 *
 * Classe do logger × classe da planilha: `CLASSE` abaixo, medida na sobreposição. A parada (`inversor_parada`) é estado, não alarme: fica fora,
 * como já ficava da planilha. Família sem par certo cai em "Outros", que não conta como falha do inversor.
 */
const ESQUEMA_LOGGER = 1, ESQUEMA_SCADA = 2, CORTE_MIN = '2026-07';
const ISO = 'Inversor · isolamento', COR = 'Inversor · corrente', ANOM = 'Inversor · anomalia', REDE = 'Rede', FV = 'Arranjo FV', AVISO = 'Aviso/Sistema', OUTROS = 'Outros';
// família do logger -> [classe da planilha, nome do modo na planilha]
const CLASSE = Object.freeze({
  isolacao_baixa: [ISO, 'Baixa resistência de isolamento do sist.'],
  corrente_reversa: [COR, 'Alarme de circulação de corrente reversa'],
  fuga_corrente: [COR, 'Corrente de fuga excessiva'],
  sobretensao_rede: [REDE], subtensao_rede: [REDE], sobrefrequencia_rede: [REDE], subfrequencia_rede: [REDE], ilhamento: [REDE], rede_anormal: [REDE], desequilibrio_rede: [REDE],
  reversa_fv: [FV], entrada_anormal: [FV], conexao_reversa: [FV], mppt_reversa: [FV],
  alarme_sistema: [AVISO],
});
const classeDaFamilia = (fam) => { const c = CLASSE[fam]; return c ? { classe: c[0], nome: c[1] || fam } : { classe: OUTROS, nome: fam }; };

const pad2 = (s) => String(Number(s)).padStart(2, '0');
// 'M2/TS2/INV19' -> 'M2/TS02/INV19': a forma da planilha, que o cruzamento com as trocas e o mapa dos inversores usam
function tagPlanilha(t) {
  const m = /^(M\d)\/TS(\d+)\/INV(\d+)$/.exec(String(t));
  return m ? m[1] + '/TS' + pad2(m[2]) + '/INV' + pad2(m[3]) : null;
}
// uma linha por inversor: o grupo do mesmo código em vários inversores vale um evento em cada um
function tagsDe(e) {
  if (!e.inv) return [tagPlanilha(e.t)].filter(Boolean);
  const out = [];
  for (const [ts, l] of Object.entries(e.inv)) for (const i of l) { const x = tagPlanilha(e.t + '/' + ts + '/INV' + i); if (x) out.push(x); }
  return out;
}
const linha = (e, t, cl) => ({ parque: t.split('/')[0], inv: t, nome: cl.nome, classe: cl.classe, tipo: '', date: new Date(e.i) });

function deLogger(j) {
  if (j.esquema !== ESQUEMA_LOGGER) throw new Error('alarmes do logger com o esquema ' + j.esquema + ' (esperado ' + ESQUEMA_LOGGER + ')');
  const out = [];
  for (const e of j.ev || []) {
    if (e.c === 'inversor_parada') continue;
    const fam = Number.isInteger(e.m) ? (j.msg || [])[e.m] : e.m;
    for (const t of tagsDe(e)) out.push(linha(e, t, classeDaFamilia(fam)));
  }
  return out;
}
// o supervisório escreve a mensagem do ponto: a classe sai pela mesma regra de texto da planilha
function deSupervisorio(j, classePorTexto) {
  if (j.esquema !== ESQUEMA_SCADA) throw new Error('alarmes do supervisório com o esquema ' + j.esquema + ' (esperado ' + ESQUEMA_SCADA + ')');
  const out = [];
  for (const e of j.ev || []) {
    if ((e.c !== 'inversor_falha' && e.c !== 'inversor_alarme') || e.est) continue;
    const nome = String((Number.isInteger(e.m) ? (j.msg || [])[e.m] : e.m) || '');
    for (const t of tagsDe(e)) out.push(linha(e, t, { classe: classePorTexto(nome), nome }));
  }
  return out;
}

const mesMais = (m) => { const [a, b] = m.split('-').map(Number); return b === 12 ? (a + 1) + '-01' : a + '-' + pad2(b + 1); };
const comDado = (j) => !!(j && Array.isArray(j.dias) && j.dias.length);

/* logger e scada: { 'AAAA-MM': json }. `ate` = o mês corrente. O corte é o primeiro mês com dado do logger a partir de `corte_min`. Mês sem logger vai ao supervisório; sem os dois, fica declarado. */
function base({ logger, scada, ate, classePorTexto, corte_min = CORTE_MIN }) {
  const meses = Object.keys(logger || {}).filter((m) => m >= corte_min && comDado(logger[m])).sort();
  if (!meses.length) throw new Error('base de alarmes do logger ausente: sem ela o p2 não se monta');
  const corte = meses[0], ev = [], por_mes = [], sem_cobertura = [];
  let ultimo_dia = null;
  for (let m = corte; m <= ate; m = mesMais(m)) {
    if (comDado(logger[m])) {
      ev.push(...deLogger(logger[m]));
      por_mes.push({ mes: m, fonte: 'logger', dias: logger[m].dias.length });
      const u = logger[m].dias.slice().sort().pop();
      if (!ultimo_dia || u > ultimo_dia) ultimo_dia = u;
    } else if (comDado((scada || {})[m])) {
      ev.push(...deSupervisorio(scada[m], classePorTexto));
      por_mes.push({ mes: m, fonte: 'supervisorio', dias: scada[m].dias.length });
      const u = scada[m].dias.slice().sort().pop();
      if (!ultimo_dia || u > ultimo_dia) ultimo_dia = u;
    } else sem_cobertura.push(m);
  }
  return { corte, ev, por_mes, sem_cobertura, ultimo_dia };
}

/* a junção: a planilha só até o mês anterior ao corte. Linha sem data não tem mês: sai, porque não há como provar que é anterior ao corte */
function junta(evPlanilha, b, ym) {
  const velho = [], fora = { depois_do_corte: 0, sem_data: 0 };
  for (const e of evPlanilha) {
    const m = ym(e.date);
    if (!m) fora.sem_data++;
    else if (m >= b.corte) fora.depois_do_corte++;
    else velho.push(e);
  }
  return { ev: [...velho, ...b.ev], planilha: velho.length, base: b.ev.length, fora };
}

/* os agregados do p2: a conta de sempre, a mesma para a planilha e para a base nova */
function agregaP2(ev, parques, { tally, ym, mesLbl, round, ehInversor }) {
  const evInv = ev.filter(x => ehInversor(x.classe));
  const badActors = tally(evInv.map(x => x.inv)).slice(0, 15).map(([inv, n]) => ({ inv, n, parque: inv.split('/')[0] }));
  const dts2 = ev.map(x => x.date).filter(Boolean); const per = dts2.length ? (Math.max(...dts2) - Math.min(...dts2)) / 864e5 : 0;
  const P2 = { eventos: ev.length, falha_inversor: evInv.length, rede: ev.filter(x => x.classe === 'Rede').length, aviso: ev.filter(x => x.classe.startsWith('Aviso')).length,
    parques: [...new Set(parques)].filter(Boolean), inversores_distintos: new Set(ev.map(x => x.inv)).size,
    por_classe: tally(ev.map(x => x.classe)).map(([classe, n]) => ({ classe, n })), bad_actors: badActors,
    modos_inversor: tally(evInv.map(x => x.nome)).map(([nome, n]) => ({ nome, n })),
    por_parque: [...new Set(ev.map(x => x.parque))].filter(Boolean).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).map(p => ({ parque: p, eventos: ev.filter(x => x.parque === p).length, falha_inversor: evInv.filter(x => x.parque === p).length, rede: ev.filter(x => x.parque === p && x.classe === 'Rede').length })),
    isolamento_por_mes: tally(evInv.filter(x => x.classe.includes('isolamento')).map(x => ym(x.date)).filter(Boolean)).map(([mes, n]) => ({ mes, n })).sort((a, b) => a.mes.localeCompare(b.mes)) };
  // TABELA-FATO do P2 — agregada no grão inversor×classe×mês (não as 13.579 linhas cruas!).
  // Permite os MESMOS filtros $parque/$ano do P1: no Grafana faz-se Group by + SUM(n).
  { const m = new Map();
    for (const e of ev) { const mes = ym(e.date); const k = [e.parque, e.inv, e.classe, mes].join('|');
      if (!m.has(k)) m.set(k, { parque: e.parque, inv: e.inv, ts: (e.inv || '').split('/')[1] || null, classe: e.classe,
        eh_inversor: ehInversor(e.classe) ? 'Falha do inversor' : 'Rede/aviso',
        ano: e.date ? e.date.getFullYear() : null, mes, mes_lbl: mes ? mesLbl(mes) : null, n: 0 });
      m.get(k).n++; }
    P2.fatos = [...m.values()]; }
  // ATENÇÃO SEMÂNTICA: isto é tempo médio entre ALARMES do SCADA (MTBA), NÃO entre falhas. P2 não significa queima.
  P2.mtba_dias = round(P2.inversores_distintos * per / (P2.falha_inversor || 1), 1);
  P2.rede_pct = round(100 * P2.rede / (P2.eventos || 1));
  P2.bad_actor = P2.bad_actors[0] || { inv: '—', n: 0 };
  return { P2, evInv };
}

module.exports = { CLASSE, classeDaFamilia, tagPlanilha, tagsDe, deLogger, deSupervisorio, base, junta, agregaP2, mesMais, ESQUEMA_LOGGER, ESQUEMA_SCADA };
