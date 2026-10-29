'use strict';
/*
 * ensaio-gen-alarmes-scada.js — QUAIS MESES o gen-alarmes-scada.js refaz (29/10/2026), sem rede (LOCAL_DIR e LOCAL_OUT_DIR numa pasta
 * temporária, CSV forjados).
 *
 * Três meses forjados (jan, fev e mar/2026). 1ª rodada: nada publicado, os três se fazem. 2ª rodada sem arquivo novo: só os meses da
 * janela de 7 dias (fev e mar), e jan não. 3ª rodada com um dia NOVO em janeiro (20/01, CUB15_2 ABERTO às 10:00; o FECHADO está no
 * arquivo de 10/02, que já existia): jan é refeito (incompleto), fev em cadeia (os abertos no fim de jan mudaram) e mar só pela janela
 * (os abertos no fim de fev não mudaram: a cadeia para); jan passa a ter o dia 20; o disjuntor aberto em 20/01 fecha em fev, às 09:00 de
 * 10/02. O ATRASO (AGORA fixa o relógio): sem o arquivo de ontem antes de 12:30 BRT é aviso e sai 0; depois, erro e sai 1, com a janela
 * gravada antes. Depois PLANTA defeitos numa cópia do gerador e exige que cada um reprove.
 * uso: node scripts/ensaio-gen-alarmes-scada.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');
const GEN = path.join(__dirname, 'gen-alarmes-scada.js');

const COLS = ['E3TimeStamp', 'InTime', 'OutTime', 'EventTimeDbl', 'Acked', 'ActiveSource', 'ConditionActive', 'Severity', 'EventType',
  'ConditionName', 'FormattedValue', 'CurrentValue', 'Quality', 'Area', 'Source', 'AlarmSourceName', 'FullAlarmSourceName', 'Message', 'ActorID'];
const SEM = '1899-12-30 00:00:00.000';
const L = (dia, hh, val, area, msg) => {
  const t = dia + ' ' + hh + '.000';
  const o = { E3TimeStamp: t, InTime: t, OutTime: SEM, EventTimeDbl: '0', Acked: '0', ActiveSource: '1', ConditionActive: '1', Severity: '0',
    EventType: 'Event', ConditionName: 'DJ', FormattedValue: val, CurrentValue: '0', Quality: 'Good', Area: area, Source: '', AlarmSourceName: '',
    FullAlarmSourceName: area + '.DJ', Message: msg, ActorID: '' };
  return COLS.map((c) => o[c]).join(';');
};
const grava = (dir, dia, linhas) => {
  const f = path.join(dir, dia.slice(0, 7), 'alarms_' + dia + '.csv.gz');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, zlib.gzipSync(Buffer.from(COLS.join(';') + '\r\n' + linhas.join('\r\n') + '\r\n')));
};
const CUB = ['GRL.SE_MRT.[CUB15-2]', 'CUB15_2- DJ - ESTADO'];
const CUB1 = ['GRL.SE_MRT.[CUB1-1]', 'CUB1_1- DJ - ESTADO'];

// AGORA padrão: 06/03 13:00 BRT, ontem = 05/03 = o último dia com arquivo (sem atraso)
function roda(gen, entra, sai, agora = '2026-03-06T13:00:00-03:00', sai1 = false) {
  const env = { ...process.env, LOCAL_DIR: entra, LOCAL_OUT_DIR: sai, AGORA: agora }; delete env.BACKFILL; delete env.ATE;
  const r = spawnSync(process.execPath, [gen], { env, encoding: 'utf8' });
  if (r.status !== (sai1 ? 1 : 0)) throw new Error('o gerador saiu ' + r.status + ' (esperado ' + (sai1 ? 1 : 0) + '): ' + ((r.stderr || '') + r.stdout).slice(-300));
  return r.stdout;
}
const le = (sai, m) => { const f = path.join(sai, 'hist', 'alarmes_scada_' + m.replace('-', '_') + '.json'); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) : null; };
const linhaMeses = (log) => (log.match(/^meses refeitos: (.*)$/m) || [])[1] || '';

function casos(gen) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-gen-alarmes-scada-'));
  try {
    const entra = path.join(tmp, 'entra'), sai = path.join(tmp, 'sai');
    fs.mkdirSync(sai, { recursive: true });
    grava(entra, '2026-01-15', [L('2026-01-15', '08:00:00', 'ABERTO', ...CUB1), L('2026-01-15', '08:30:00', 'FECHADO', ...CUB1)]);
    grava(entra, '2026-02-10', [L('2026-02-10', '09:00:00', 'FECHADO', ...CUB)]);
    grava(entra, '2026-03-05', [L('2026-03-05', '11:00:00', 'ABERTO', ...CUB1), L('2026-03-05', '11:10:00', 'FECHADO', ...CUB1)]);
    // os dias de 21/01 a 04/03 com arquivo (só o cabeçalho): o dado real é diário, e a semente só atravessa a virada do mês quando os
    // dois lados se encostam (com buraco, o fim do que estava aberto é desconhecido). O 20/01 chega só na 3ª rodada.
    for (let d = '2026-01-21'; d < '2026-03-05'; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10)) if (d !== '2026-02-10') grava(entra, d, []);
    const l1 = linhaMeses(roda(gen, entra, sai));
    C('1ª rodada: os três meses se fazem', /2026-01 \(incompleto\)/.test(l1) && /2026-02 \(cadeia\)/.test(l1) && /2026-03 \(cadeia\)/.test(l1), l1);
    const l2 = linhaMeses(roda(gen, entra, sai));
    C('2ª rodada sem arquivo novo: só a janela (fev e mar), jan não', l2 === '2026-02 (janela), 2026-03 (janela)', l2);
    grava(entra, '2026-01-20', [L('2026-01-20', '10:00:00', 'ABERTO', ...CUB)]);
    const l3 = linhaMeses(roda(gen, entra, sai));
    C('3ª rodada com dia novo em jan: jan incompleto, fev em cadeia, a cadeia para e mar vem só pela janela', l3 === '2026-01 (incompleto), 2026-02 (cadeia), 2026-03 (janela)', l3);
    const jan = le(sai, '2026-01'), fev = le(sai, '2026-02');
    C('jan passa a ter o dia 20', jan && jan.dias[0] === '2026-01-15' && jan.dias.includes('2026-01-20'), jan && JSON.stringify(jan.dias));
    const dj = fev && fev.ev.find((e) => e.c === 'disjuntor' && e.t === 'CUB15_2');
    C('o disjuntor aberto em 20/01 fecha em fev, 10/02 09:00', dj && dj.i === '2026-01-20T10:00:00' && dj.f === '2026-02-10T09:00:00', JSON.stringify(dj));
    // o atraso: ontem (07/03) sem arquivo
    const janela = () => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sai, 'alarmes_scada.json')))).gerado;
    const g0 = janela();
    const l4 = roda(gen, entra, sai, '2026-03-08T10:00:00-03:00');
    C('atraso antes de 12:30 BRT: aviso, sai 0', /::warning::.*2026-03-05.*2026-03-07/.test(l4) && !/::error::/.test(l4), l4.slice(-200));
    const g1 = janela();
    const l5 = roda(gen, entra, sai, '2026-03-08T13:00:00-03:00', true);
    C('atraso depois de 12:30 BRT: erro, sai 1, com a janela gravada antes', /::error::.*2026-03-05/.test(l5) && janela() !== g1 && g1 !== g0, l5.slice(-200));
    // BURACO: um mês antigo (jun/2025) com um disjuntor que nunca fecha, e nada entre ele e jan/2026. A janela de hoje não pode trazê-lo
    // (29/10/2026: mar/2025 refeito na mesma rodada punha 16.730 eventos na janela de out/2026), e o mês seguinte ao buraco não o herda.
    const entra2 = path.join(tmp, 'entra2'), sai2 = path.join(tmp, 'sai2');
    fs.mkdirSync(sai2, { recursive: true });
    grava(entra2, '2025-06-10', [L('2025-06-10', '10:00:00', 'ABERTO', ...CUB1)]);
    for (let d = '2026-02-27'; d <= '2026-03-05'; d = new Date(Date.parse(d + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10)) grava(entra2, d, []);
    roda(gen, entra2, sai2);
    const j2 = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(sai2, 'alarmes_scada.json'))));
    const fev2 = le(sai2, '2026-02');
    C('buraco: a janela de hoje sem o aberto de jun/2025, e o mês depois do buraco não o herda',
      !j2.ev.some((e) => e.i < '2026-01-01') && fev2 && !fev2.ev.some((e) => e.i < '2026-01-01'), JSON.stringify(j2.ev.map((e) => e.t + ' ' + e.i)));
  } catch (e) { f.push('estourou: ' + e.message); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  return f;
}

const base = casos(GEN);
if (base.length) { console.log('🔴 o gerador real reprova:'); base.forEach((x) => console.log('  - ' + x)); process.exit(1); }
console.log('✅ gerador real: todos os casos passam');
const SRC = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
const PLANTIOS = [
  ['só a janela (sem o mês incompleto)', 'if (!p || comArq.some((d) => !(p.dias || []).includes(d))) { primeiro = m; break; }', ''],
  ['sem a cadeia', "cadeia ? 'cadeia' :", "false ? 'cadeia' :"],
  ['a semente pelo publicado mesmo com o anterior refeito', 'if (feitoAnt !== prevMes(m)) anterior =', 'anterior ='],
  ['a cadeia não para', 'cadeia = abertosNoFim(o) !== abertosNoFim(await pub(m));', 'cadeia = true;'],
  ['a janela com todo mês refeito', 'if (m >= de.slice(0, 7) && m <= ate.slice(0, 7)) feitos.push(o);', 'feitos.push(o);'],
  ['o atraso sai verde', "if (atraso) { console.log('::error::'", "if (false) { console.log('::error::'"],
  ['o atraso sai antes de gravar a janela', "const kb = await escreve('alarmes_scada.json', j);", "if (atraso) process.exit(1); const kb = await escreve('alarmes_scada.json', j);"],
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-gen-alarmes-scada-p-'));
let ruim = 0;
try {
  for (const lib of ['lib-alarmes-scada.js', 'lib-scada-db.js', 'lib-zip.js']) fs.copyFileSync(path.join(__dirname, lib), path.join(tmp, lib));
  PLANTIOS.forEach(([nome, de, para], k) => {
    if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
    const arq = path.join(tmp, 'gen-' + k + '.js');
    fs.writeFileSync(arq, SRC.replace(de, para));
    const f = casos(arq);
    if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 160) + ')');
    else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
  });
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
