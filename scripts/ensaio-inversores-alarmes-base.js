'use strict';
/*
 * ensaio-inversores-alarmes-base.js — o `p2` do inversores.json pela base nova (lote inversores-alarmes-base, 06/11/2026), sem rede:
 * 1. a junção: a planilha só até o mês anterior ao logger; um mês vem de uma fonte só, nunca duas;
 * 2. o supervisório só entra no mês que o logger não cobre; sem os dois, o mês fica declarado;
 * 3. a classe do logger × a da planilha, a forma da tag, o grupo vale um evento por inversor, a parada não conta;
 * 4. os campos que a página, o selo e o assistente leem saem com o mesmo tipo;
 * 5. o gerador de ponta a ponta, com planilhas de mentira, e a falha da base derrubando a rodada.
 * Depois PLANTA defeitos na lib e exige que cada um reprove.
 * uso: node scripts/ensaio-inversores-alarmes-base.js   (precisa do pacote xlsx; sai 1 se algo falhar)
 */
const fs = require('fs'), path = require('path'), os = require('os'), { spawnSync } = require('child_process');
const LIB = path.join(__dirname, 'lib-alarmes-inversor.js'), SRC = fs.readFileSync(LIB, 'utf8');

const ym = (d) => (d ? d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') : null);
const tally = (a) => { const m = new Map(); for (const x of a) m.set(x, (m.get(x) || 0) + 1); return [...m.entries()].sort((p, q) => q[1] - p[1]); };
const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;
const H = { tally, ym, round, mesLbl: (m) => m, ehInversor: (c) => c.startsWith('Inversor') };
const LOG = (dias, ev, esquema = 1) => ({ esquema, dias, msg: ['isolacao_baixa', 'ilhamento', 'parado', 'reversa_fv', 'cabo_aterramento'], ev });
const SC = (dias, ev, esquema = 2) => ({ esquema, dias, msg: ['ALARME GERAL'], ev });
const E1 = { c: 'inversor_falha', t: 'M2/TS2/INV9', i: '2026-04-03T10:00:00', m: 0 };
const E2 = { c: 'inversor_falha', t: 'M8', i: '2026-04-04T10:00:00', m: 1, inv: { TS5: ['01', '02'], TS6: ['03'] } };
const PARADA = { c: 'inversor_parada', t: 'M1/TS1/INV1', i: '2026-04-05T10:00:00', m: 2 };
const E3 = { c: 'inversor_alarme', t: 'M3/TS10/INV12', i: '2026-06-01T10:00:00', m: 3 };
const E4 = { c: 'inversor_falha', t: 'M3/TS1/INV1', i: '2026-06-02T10:00:00', m: 4 };
const ESC = { c: 'inversor_falha', t: 'M4/TS1/INV2', i: '2026-05-10T10:00:00', m: 0 };
const ESC_EST = { ...ESC, est: 1 }, ESC_OUTRA = { ...ESC, c: 'trafo_ts' };
const PLAN = [['2026-03-31T12:00:00', 'Rede'], ['2026-04-02T12:00:00', 'Rede'], ['2026-05-01T12:00:00', 'Inversor · isolamento'], ['2026-07-01T12:00:00', 'Rede']]
  .map(([d, classe], k) => ({ parque: 'M1', inv: 'M1/TS01/INV' + String(k + 1).padStart(2, '0'), nome: 'x', classe, tipo: 'y', date: new Date(d) })).concat([{ parque: 'M1', inv: 'M1/TS01/INV09', nome: 'x', classe: 'Rede', tipo: '', date: null }]);

function julga(L) {
  const f = [], C = (ok, m) => { if (!ok) f.push(m); };
  const b = L.base({ corte_min: '2026-01', logger: { '2026-04': LOG(['2026-04-03', '2026-04-04'], [E1, E2, PARADA]), '2026-06': LOG(['2026-06-01', '2026-06-02'], [E3, E4]) },
    scada: { '2026-05': SC(['2026-05-10'], [ESC, ESC_EST, ESC_OUTRA]), '2026-06': SC(['2026-06-01'], [ESC]) }, ate: '2026-07', classePorTexto: () => 'Outros' });
  C(b.corte === '2026-04', 'o corte não é o 1º mês do logger');
  { const d = L.base({ logger: { '2026-06': LOG(['2026-06-01'], [E3]), '2026-07': LOG(['2026-07-01'], [{ ...E3, i: '2026-07-01T10:00:00' }]) }, ate: '2026-07', classePorTexto: () => 'x' });
    C(d.corte === '2026-07' && d.por_mes.length === 1, 'sem pedir outro corte, o logger entrou antes de jul/2026'); }
  { const j = { esquema: 1, dias: ['2026-07-01'], msg: ['falha_sistema'], ev: [{ c: 'inversor_falha', t: 'M2/TS2/INV9', i: '2026-07-01T10:00:00', m: 0 }] };
    C(L.base({ logger: { '2026-07': j }, ate: '2026-07', classePorTexto: () => 'x' }).ev[0].classe === 'Outros', 'falha_sistema saiu de Outros sem fonte'); }
  C(b.por_mes.map((x) => x.mes + ':' + x.fonte).join() === '2026-04:logger,2026-05:supervisorio,2026-06:logger', 'a fonte de cada mês errada: ' + JSON.stringify(b.por_mes));
  C(b.sem_cobertura.join() === '2026-07', 'mês sem as duas fontes não ficou declarado');
  C(b.ultimo_dia === '2026-06-02', 'último dia errado: ' + b.ultimo_dia);
  const tags = b.ev.map((e) => e.inv);
  C(tags.includes('M2/TS02/INV09') && tags.includes('M3/TS10/INV12'), 'a tag não tem a forma da planilha');
  C(['M8/TS05/INV01', 'M8/TS05/INV02', 'M8/TS06/INV03'].every((t) => tags.includes(t)), 'o grupo não vale um evento por inversor');
  C(!tags.includes('M1/TS01/INV01'), 'a parada entrou como alarme');
  C(b.ev.filter((e) => e.inv === 'M4/TS01/INV02').length === 1, 'o supervisório contou estado ou classe de outro equipamento');
  C(b.ev.length === 7, 'a base tem de ter 7 linhas: ' + b.ev.length);
  const cl = (t) => (b.ev.find((e) => e.inv === t) || {}).classe;
  C(cl('M2/TS02/INV09') === 'Inversor · isolamento', 'isolação fora da classe');
  C(cl('M8/TS05/INV01') === 'Rede', 'ilhamento fora de Rede');
  C(cl('M3/TS10/INV12') === 'Arranjo FV', 'reversa FV fora de Arranjo FV');
  C(cl('M3/TS01/INV01') === 'Outros', 'família sem par virou classe conhecida');
  C((b.ev.find((e) => e.inv === 'M2/TS02/INV09') || {}).nome === 'Baixa resistência de isolamento do sist.', 'o nome do modo não é o da planilha');
  // a junção
  const j = L.junta(PLAN, b, ym);
  C(j.planilha === 1 && j.fora.depois_do_corte === 3 && j.fora.sem_data === 1, 'a junção errou: ' + JSON.stringify(j.fora));
  C(j.ev.length === 8 && !j.ev.some((e) => e.parque === 'M1' && e.date && ym(e.date) >= '2026-04' && e.tipo === 'y'), 'a planilha contou junto com a base no mesmo mês');
  // os campos dos consumidores
  const { P2 } = L.agregaP2(j.ev, ['M1'], H);
  ['eventos', 'falha_inversor', 'rede', 'aviso', 'rede_pct', 'mtba_dias', 'inversores_distintos'].forEach((k) => C(typeof P2[k] === 'number', 'p2.' + k + ' não é número'));
  ['por_classe', 'bad_actors', 'modos_inversor', 'por_parque', 'isolamento_por_mes', 'fatos', 'parques'].forEach((k) => C(Array.isArray(P2[k]), 'p2.' + k + ' não é lista'));
  C(P2.bad_actor && typeof P2.bad_actor.inv === 'string', 'p2.bad_actor sem inversor');
  C(P2.fatos.every((x) => ['parque', 'inv', 'ts', 'classe', 'eh_inversor', 'ano', 'mes', 'mes_lbl', 'n'].every((k) => k in x)), 'a linha de fatos perdeu campo');
  C(P2.eventos === 8 && P2.fatos.reduce((a, x) => a + x.n, 0) === 8, 'fatos não fecha com eventos');
  // as guardas
  const estoura = (fn, m) => { try { fn(); f.push(m); } catch (e) { /* devia estourar */ } };
  estoura(() => L.base({ corte_min: '2026-01', logger: {}, ate: '2026-07', classePorTexto: () => 'x' }), 'sem base não derruba');
  estoura(() => L.base({ corte_min: '2026-01', logger: { '2026-04': LOG(['2026-04-03'], [E1], 2) }, ate: '2026-04', classePorTexto: () => 'x' }), 'esquema errado do logger passou');
  estoura(() => L.base({ corte_min: '2026-01', logger: { '2026-04': LOG(['2026-04-03'], [E1]) }, scada: { '2026-05': SC(['2026-05-01'], [ESC], 1) }, ate: '2026-05', classePorTexto: () => 'x' }), 'esquema errado do supervisório passou');
  C(L.tagPlanilha('SN:A123') === null, 'inversor sem posição entrou');
  return f;
}

const f0 = julga(require(LIB));
if (f0.length) { f0.forEach((x) => console.log('  🔴 ' + x)); process.exit(1); }
console.log('✅ o código real passa');

// toda família do manual tem par na tabela ou cai declarada em Outros: conferida contra a tabela do logger
{ const S = require('./lib-sungrow.js'), L = require(LIB);
  const fams = [...new Set(S.FAIXAS.map((x) => x[0]))], semPar = fams.filter((x) => L.classeDaFamilia(x).classe === 'Outros');
  const nomeDe = new Set(Object.keys(L.CLASSE));
  const errada = [...nomeDe].filter((x) => !fams.includes(x));
  if (errada.length) { console.log('  🔴 família que não existe na tabela: ' + errada.join()); process.exit(1); }
  console.log('  famílias do manual: ' + fams.length + ', em Outros: ' + semPar.length);
}

// ponta a ponta: planilhas de mentira, o gerador de verdade
{ const XLSX = require('xlsx');
  const t0 = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-inv-')), rawD = path.join(t0, 'raw'), hist = path.join(t0, 'hist'); fs.mkdirSync(rawD); fs.mkdirSync(hist);
  const wb1 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb1, XLSX.utils.aoa_to_sheet([['ITEM', 'SPV', 'TS', 'INV', 'FAILURE DESCRIPTION', 'DATE', 'Replacement Date'], [1, 'M02', 'TS02', 'INV09', 'FAN FAILURE', '10/03/2026', '11/03/2026']]), 'Controle');
  XLSX.writeFile(wb1, path.join(rawD, 'p1.xlsx'));
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet([['CAMPO', 'SUBCAMPO', 'INVERSOR', 'Horário', 'Tipo', 'Nome', 'Status'],
    ['M02', 'TS02', 'INV09', '15/03/2026', 'F', 'Queda da rede', 'Ocorre'], ['M02', 'TS02', 'INV09', '15/04/2026', 'F', 'Queda da rede', 'Ocorre'], ['M02', 'TS02', 'INV08', '15/05/2026', 'F', 'Queda da rede', 'Ocorre']]), 'M02');
  XLSX.writeFile(wb2, path.join(rawD, 'p2.xlsx'));
  const roda = (extra) => spawnSync(process.execPath, [path.join(__dirname, 'gen-inversores.js')], { encoding: 'utf8', env: { ...process.env, ALARMES_CORTE_MIN: '2026-01', LOCAL_DIR: rawD, LOCAL_OUT: path.join(t0, 'out.json'), ...extra } });
  fs.writeFileSync(path.join(hist, 'alarmes_logger_arm_2026_04.json'), JSON.stringify({ esquema: 9, dias: {} }));   // o armazém e o manifesto moram no mesmo prefixo
  fs.writeFileSync(path.join(hist, 'alarmes_logger_lidos.json'), JSON.stringify({ zips: {} }));
  fs.writeFileSync(path.join(hist, 'alarmes_logger_2026_04.json'), JSON.stringify(LOG(['2026-04-03', '2026-04-04'], [E1, E2, PARADA])));
  const r = roda({ LOCAL_HIST_DIR: hist });
  if (r.status !== 0) { console.log('  🔴 o gerador quebrou: ' + (r.stderr || r.stdout).slice(-300)); process.exit(1); }
  const o = JSON.parse(fs.readFileSync(path.join(t0, 'out.json'), 'utf8')), p = o.p2, u = o.fontes;
  const ok = p.eventos === 5 && p.rede === 4 && p.falha_inversor === 1 && u.alarmes_base_desde === '2026-04' && u.alarmes_ultimo_mes === '2026-04' && u.alarmes_ultimo_dia === '2026-04-04'
    && u.alarmes_base_meses.length >= 1 && u.alarmes_planilha_em && u.alarmes_sem_cobertura.length >= 1 && typeof p.rede_pct === 'number' && p.bad_actor.inv === 'M2/TS02/INV09';
  if (!ok) { console.log('  🔴 ponta a ponta errado: ' + JSON.stringify({ e: p.eventos, r: p.rede, f: p.falha_inversor, u })); process.exit(1); }
  fs.rmSync(hist, { recursive: true, force: true }); fs.mkdirSync(hist);
  const r2 = roda({ LOCAL_HIST_DIR: hist });
  if (r2.status === 0) { console.log('  🔴 sem a base a rodada passou em silêncio'); process.exit(1); }
  fs.rmSync(t0, { recursive: true, force: true });
  console.log('✅ o gerador de ponta a ponta: planilha até março, base de abril em diante; sem a base, a rodada falha');
}

const PLANTIOS = [
  ['soma as duas fontes no mês', "else if (m >= b.corte) fora.depois_do_corte++;\n    else velho.push(e);", "else velho.push(e);"],
  ['a linha sem data entra', "if (!m) fora.sem_data++;\n    else if", "if (false) {}\n    else if"],
  ['o corte volta a abril', "CORTE_MIN = '2026-07'", "CORTE_MIN = '2026-04'"],
  ['falha_sistema vira Anomalia', "  isolacao_baixa: [ISO, 'Baixa resistência de isolamento do sist.'],", "  isolacao_baixa: [ISO, 'Baixa resistência de isolamento do sist.'], falha_sistema: [ANOM],"],
  ['o corte vai um mês depois', "const corte = meses[0], ev", "const corte = meses[1] || meses[0], ev"],
  ['o supervisório manda no mês do logger', "if (comDado(logger[m])) {\n      ev.push(...deLogger(logger[m]));", "if (comDado(logger[m]) && !comDado((scada || {})[m])) {\n      ev.push(...deLogger(logger[m]));"],
  ['mês sem fonte some', "} else sem_cobertura.push(m);", "}"],
  ['a parada conta', "if (e.c === 'inversor_parada') continue;", ""],
  ['o grupo vale um', "for (const t of tagsDe(e)) out.push(linha(e, t, classeDaFamilia(fam)));", "for (const t of tagsDe(e).slice(0, 1)) out.push(linha(e, t, classeDaFamilia(fam)));"],
  ['tag sem zero', "return m ? m[1] + '/TS' + pad2(m[2]) + '/INV' + pad2(m[3]) : null;", "return m ? String(t) : null;"],
  ['o estado do supervisório conta', "|| e.est) continue;", ") continue;"],
  ['outra classe do supervisório entra', "if ((e.c !== 'inversor_falha' && e.c !== 'inversor_alarme') || e.est) continue;", "if (e.est) continue;"],
  ['ilhamento fora de Rede', "ilhamento: [REDE], ", ""],
  ['reversa FV fora', "reversa_fv: [FV], ", ""],
  ['família sem par vira Anomalia', "return c ? { classe: c[0], nome: c[1] || fam } : { classe: OUTROS, nome: fam };", "return c ? { classe: c[0], nome: c[1] || fam } : { classe: ANOM, nome: fam };"],
  ['o nome do modo muda', "isolacao_baixa: [ISO, 'Baixa resistência de isolamento do sist.'],", "isolacao_baixa: [ISO, 'isolacao'],"],
  ['esquema do logger sem guarda', "if (j.esquema !== ESQUEMA_LOGGER) throw", "if (false) throw"],
  ['esquema do supervisório sem guarda', "if (j.esquema !== ESQUEMA_SCADA) throw", "if (false) throw"],
  ['sem base não estoura', "if (!meses.length) throw", "if (false) throw"],
  ['último dia só do primeiro mês', "if (!ultimo_dia || u > ultimo_dia) ultimo_dia = u;\n    } else if", "if (!ultimo_dia) ultimo_dia = u;\n    } else if"],
];
const tmp = fs.mkdtempSync(path.join(__dirname, '.ensaio-inv-alm-'));
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
