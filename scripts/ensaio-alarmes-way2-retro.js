'use strict';
/*
 * ensaio-alarmes-way2-retro.js — o RETROATIVO dos alarmes dos medidores (gen-alarmes-way2.js com HIST_DE / HIST_ATE; lote
 * alarmes-way2-retro, 22/11/2026), sem rede. A regra de cada slot é julgada no ensaio-alarme-circuito.js e a rodada de 5 min no
 * ensaio-gen-alarmes-way2.js; aqui se julga o que só existe no retroativo: a janela pedida, o dia que falta, a virada de mês, a borda
 * com o que a rodada de 5 min já gravou, a recusa do sobreposto e o registro do fim.
 *
 * Dias forjados (formato cru da Way2), de 29/09 a 04/10/2026, pedidos de 29/09 a 03/10:
 *   29/09  M7C1 aberto 21:30–22:00;
 *   30/09  M9C1 abre às 23:00 e vira o mês aberto;
 *   01/10  M9C1 fecha às 00:20 (mesmo id: fica no arquivo de SETEMBRO, com fim em outubro); M8C1 abre às 22:00;
 *   02/10  SEM ARQUIVO: o M8C1 segue aberto, a semente não cai;
 *   03/10  M8C1 aberto o dia todo (em curso no fim da janela); M1C3 aberto 21:30–22:00;
 *   04/10  FORA da janela: o M8C1 fecharia às 00:20 e o M2C1 abriria às 21:30. Nada disso pode aparecer.
 * Cenários: A (do zero) · B (o mês já publicado tem o M8C1 FECHADO pela rodada de 5 min, outro episódio e uma queda de medidor: nada
 * se perde e nada reabre) · C (2ª vez sobre o resultado: nada regravado) · D (o publicado tem episódio do mesmo equipamento sobreposto,
 * com outro id: nada é gravado) · E (a janela: teto, datas tortas, dia em curso) · F (dia sem intervalo) · G (a fusão da rodada de
 * 5 min continua reabrindo: a guarda é só do retroativo). Depois o `main` de verdade, por processo, numa pasta local (M1 a M5).
 * Por fim PLANTA defeitos numa cópia do gerador e exige que cada um reprove.
 * uso: node scripts/ensaio-alarmes-way2-retro.js   (sai 1 se algo falhar)
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const { spawnSync } = require('child_process');

const GEN = path.join(__dirname, 'gen-alarmes-way2.js');
const ms = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');
const PIDS = []; for (let p = 6196; p <= 6219; p++) PIDS.push(p);
const JANELAS = [['00:05', '01:00'], ['21:00', '23:40']];   // o dia forjado tem só a madrugada e a noite: basta para a virada
const AGORA = '2026-11-22T10:00:00', MES9 = 'hist/alarmes_way2_2026_09.json', MES10 = 'hist/alarmes_way2_2026_10.json';
const clone = (o) => JSON.parse(JSON.stringify(o));

// coleta forjada: todos os medidores normais nas JANELAS do dia; zeros[pid] = [[de, ate], …] (borda direita, inclusive) com o ponto
// zerado e a barra viva
function coleta(dia, zeros = {}) {
  const ts = [];
  for (const [de, ate] of JANELAS) for (let t = ms(dia + 'T' + de); t <= ms(dia + 'T' + ate); t += 300000) ts.push(t);
  const iso = (t) => new Date(t - 3 * 3600000).toISOString().slice(0, 19);
  const dados = [];
  for (const pid of PIDS) {
    const trafo = pid < 6198, vn = trafo ? 132800 : 19900;
    const linha = (t) => ((zeros[pid] || []).some(([a, b]) => t >= ms(dia + 'T' + a) && t <= ms(dia + 'T' + b))
      ? { P: 0, Q: 0, I: 0, V: vn } : { P: trafo ? 60000 : 5000, Q: 300, I: 90, V: vn });
    const g = { Demat: 'P', Demre: 'Q', CorrenteA: 'I', CorrenteB: 'I', CorrenteC: 'I', TensaoA: 'V', TensaoB: 'V', TensaoC: 'V' };
    for (const [nome, k] of Object.entries(g)) dados.push({ pontoId: pid, nomeGrandeza: nome, valores: ts.map((t) => ({ data: iso(t), valor: linha(t)[k], qualidade: 0 })) });
  }
  return { dados };
}
const DIAS = {
  '2026-09-29': coleta('2026-09-29', { 6215: [['21:35', '22:00']] }),
  '2026-09-30': coleta('2026-09-30', { 6219: [['23:05', '23:40']] }),
  '2026-10-01': coleta('2026-10-01', { 6219: [['00:05', '00:20']], 6216: [['22:05', '23:40']] }),
  '2026-10-03': coleta('2026-10-03', { 6216: [['00:05', '23:40']], 6200: [['21:35', '22:00']] }),
  '2026-10-04': coleta('2026-10-04', { 6216: [['00:05', '00:20']], 6201: [['21:35', '22:00']] }),
};
const ID = { m7: 'cto_aberto:M7C1:2026-09-29T21:30:00', m9: 'cto_aberto:M9C1:2026-09-30T23:00:00', m8: 'cto_aberto:M8C1:2026-10-01T22:00:00', m1: 'cto_aberto:M1C3:2026-10-03T21:30:00' };
// o que a rodada de 5 min teria deixado em outubro: o M8C1 já FECHADO (ela viu o dia 04), um episódio de outro equipamento e uma queda de medidor
const VIVO10 = () => ({ esquema: 1, fonte: 'medidores', mes: '2026-10', gerado: '2026-10-04T00:30:00', eq: {},
  eventos: [{ id: ID.m8, regra: 'cto_aberto', tag: 'M8C1', ini: '2026-10-01T22:00:00', fim: '2026-10-04T00:20:00', slots: 4 },
    { id: 'cto_aberto:M3C2:2026-10-02T10:00:00', regra: 'cto_aberto', tag: 'M3C2', ini: '2026-10-02T10:00:00', fim: '2026-10-02T11:00:00', slots: 12 }],
  medidor_com: [{ id: 'med:6196:2026-10-02T08:00:00', c: 'medidor_com', p: 3, pid: 6196, tag: '04T1', ini: '2026-10-02T08:00:00', fim: '2026-10-02T09:00:00' }] });
const SOBRE10 = () => ({ esquema: 1, fonte: 'medidores', mes: '2026-10', gerado: 'x', eq: {},
  eventos: [{ id: 'cto_aberto:M8C1:2026-10-01T21:00:00', regra: 'cto_aberto', tag: 'M8C1', ini: '2026-10-01T21:00:00', fim: null, slots: 3 }], medidor_com: [] });

// o storage de mentira: os dias e os meses na memória, com cópia a cada leitura e gravação
function io(dias, meses) {
  const gravados = [];
  return { gravados, meses, agoraMs: ms(AGORA), log: () => {},
    leDia: async (d) => (dias[d] ? dias[d] : null),
    leMes: async (n) => (meses[n] ? clone(meses[n]) : null),
    gravaMes: async (n, o) => { meses[n] = clone(o); gravados.push(n); } };
}

async function cenarios(G) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det !== undefined ? ' · ' + (typeof det === 'string' ? det : JSON.stringify(det)).slice(0, 260) : '')); };
  const ev = (o, id) => ((o && o.eventos) || []).find((e) => e.id === id);
  const ids = (o) => ((o && o.eventos) || []).map((e) => e.id);
  const roda = async (dias, meses, de = '2026-09-29', ate = '2026-10-03') => { const x = io(dias, meses); return { x, r: await G.refazHist(de, ate, x) }; };

  // A · do zero
  const A = await roda(DIAS, {});
  const s9 = A.x.meses[MES9], s10 = A.x.meses[MES10];
  C('A: grava setembro e outubro, do mais antigo ao mais novo, e só eles', A.x.gravados.join() === MES9 + ',' + MES10 && Object.keys(A.x.meses).length === 2, A.x.gravados);
  C('A: setembro tem o M7C1 e o M9C1, e só', ids(s9).sort().join() === [ID.m7, ID.m9].sort().join(), ids(s9));
  C('A: o M7C1 de 29/09 é 21:30–22:00', ev(s9, ID.m7) && ev(s9, ID.m7).fim === '2026-09-29T22:00:00', ev(s9, ID.m7));
  C('A: o M9C1 que virou o mês fica em setembro com fim em outubro (mesmo id)', ev(s9, ID.m9) && ev(s9, ID.m9).fim === '2026-10-01T00:20:00', ev(s9, ID.m9));
  C('A: outubro tem o M8C1 e o M1C3, e só (nada do dia 04)', ids(s10).sort().join() === [ID.m1, ID.m8].sort().join(), ids(s10));
  C('A: o M8C1 atravessa o dia sem arquivo com o mesmo id e segue em curso', ev(s10, ID.m8) && ev(s10, ID.m8).fim === null, ev(s10, ID.m8));
  C('A: o M1C3 de 03/10 é 21:30–22:00', ev(s10, ID.m1) && ev(s10, ID.m1).fim === '2026-10-03T22:00:00', ev(s10, ID.m1));
  C('A: nenhuma queda de medidor inventada', s9 && s10 && s9.medidor_com.length === 0 && s10.medidor_com.length === 0);
  C('A: o mês leva a hora da rodada, não a do dia forjado', s9 && s9.gerado === AGORA && s10 && s10.gerado === AGORA, [s9 && s9.gerado, s10 && s10.gerado]);
  C('A: o mês leva o dicionário dos equipamentos e o esquema', s10 && s10.esquema === 1 && s10.mes === '2026-10' && s10.eq && s10.eq.M8C1 && s10.eq.M8C1.pai === '04T2');
  C('A: registro · 5 dias pedidos, 4 lidos, último 03/10', A.r.dias === 5 && A.r.lidos === 4 && A.r.ultimo_lido === '2026-10-03', A.r);
  C('A: registro · o dia sem arquivo é o 02/10', A.r.sem_arquivo.join() === '2026-10-02' && A.r.sem_intervalo.length === 0, A.r.sem_arquivo);
  C('A: registro · em curso no fim é só o M8C1, ausente do publicado e em curso no gravado', A.r.em_curso_no_fim.length === 1 && A.r.em_curso_no_fim[0].id === ID.m8
    && A.r.em_curso_no_fim[0].publicado_antes === 'ausente' && A.r.em_curso_no_fim[0].fica === 'em curso', A.r.em_curso_no_fim);
  C('A: registro · 4 episódios, nenhum sobreposto, 2 meses gravados', A.r.eventos === 4 && A.r.sobrepostos.length === 0 && A.r.meses_gravados.length === 2, A.r);

  // B · o mês já publicado pela rodada de 5 min
  const B = await roda(DIAS, { [MES10]: VIVO10() });
  const b10 = B.x.meses[MES10];
  C('B: o M8C1 que o publicado fechou NÃO é reaberto', ev(b10, ID.m8) && ev(b10, ID.m8).fim === '2026-10-04T00:20:00', ev(b10, ID.m8));
  C('B: o episódio de outro equipamento que estava no mês fica', !!ev(b10, 'cto_aberto:M3C2:2026-10-02T10:00:00'), ids(b10));
  C('B: a queda de medidor que estava no mês fica', b10 && b10.medidor_com.length === 1 && b10.medidor_com[0].id === 'med:6196:2026-10-02T08:00:00', b10 && b10.medidor_com);
  C('B: o M1C3 novo entra', !!ev(b10, ID.m1), ids(b10));
  C('B: registro · o M8C1 aparece como fechado no publicado e fica fechado', B.r.em_curso_no_fim.length === 1 && B.r.em_curso_no_fim[0].publicado_antes === 'fechado em 2026-10-04T00:20:00'
    && B.r.em_curso_no_fim[0].fica === 'fechado em 2026-10-04T00:20:00', B.r.em_curso_no_fim);

  // C · de novo sobre o resultado de A: nada muda, nada é regravado
  const antes = JSON.stringify(A.x.meses);
  const Cc = await roda(DIAS, clone(A.x.meses));
  C('C: 2ª vez não regrava mês nenhum', Cc.x.gravados.length === 0 && Cc.r.meses_gravados.length === 0 && JSON.stringify(Cc.x.meses) === antes, Cc.x.gravados);
  C('C: 2ª vez · o M8C1 em curso já estava em curso no publicado', Cc.r.em_curso_no_fim.length === 1 && Cc.r.em_curso_no_fim[0].publicado_antes === 'em curso', Cc.r.em_curso_no_fim);

  // D · o publicado tem o mesmo equipamento sobreposto com outro id: nada é gravado, nem o mês que conferia
  const D = await roda(DIAS, { [MES10]: SOBRE10() });
  C('D: o par sobreposto é nomeado', D.r.sobrepostos.length === 1 && D.r.sobrepostos[0].slice().sort().join() === ['cto_aberto:M8C1:2026-10-01T21:00:00', ID.m8].sort().join(), D.r.sobrepostos);
  C('D: com sobreposição NADA é gravado (nem setembro)', D.x.gravados.length === 0 && D.r.meses_gravados.length === 0 && !D.x.meses[MES9], D.x.gravados);
  C('sobrepostos: encostado não é sobreposto; equipamento ou regra diferente também não', G.sobrepostos([
    { id: 'a', regra: 'cto_aberto', tag: 'M1C1', ini: '2026-01-01T10:00:00', fim: '2026-01-01T11:00:00' }, { id: 'b', regra: 'cto_aberto', tag: 'M1C1', ini: '2026-01-01T11:00:00', fim: null },
    { id: 'c', regra: 'cto_aberto', tag: 'M1C2', ini: '2026-01-01T10:30:00', fim: null }, { id: 'd', regra: 'cto_sem_tensao', tag: 'M1C1', ini: '2026-01-01T10:30:00', fim: null }]).length === 0);
  C('sobrepostos: aberto sem fim pega tudo o que vem depois no mesmo equipamento', G.sobrepostos([
    { id: 'a', regra: 'cto_aberto', tag: 'M1C1', ini: '2026-01-01T10:00:00', fim: null }, { id: 'b', regra: 'cto_aberto', tag: 'M1C1', ini: '2026-03-01T11:00:00', fim: '2026-03-01T12:00:00' }]).length === 1);

  // E · a janela
  const J = (...a) => { try { return G.janelaRetro(...a); } catch (e) { return 'ERRO ' + e.message; } };
  const HOJE = '2026-11-22';
  C('E: o teto é 31/10/2026', G.RETRO_TETO === '2026-10-31', G.RETRO_TETO);
  C('E: sem HIST_ATE a janela para no teto (não em ontem)', J('2024-07-02', undefined, true, HOJE).ate === '2026-10-31' && J('2024-07-02', '', false, HOJE).ate === '2026-10-31', J('2024-07-02', undefined, true, HOJE));
  C('E: gravando no storage, HIST_ATE depois do teto é recusado', /passa de 2026-10-31/.test(J('2024-07-02', '2026-11-01', true, HOJE)), J('2024-07-02', '2026-11-01', true, HOJE));
  C('E: o teto exato passa', J('2024-07-02', '2026-10-31', true, HOJE).ate === '2026-10-31');
  C('E: em pasta local o teto não barra (comparar com o mês vivo)', J('2026-11-01', '2026-11-05', false, HOJE).ate === '2026-11-05', J('2026-11-01', '2026-11-05', false, HOJE));
  C('E: dia em curso ou futuro é recusado, também em pasta local', /não é dia fechado/.test(J('2026-11-01', HOJE, false, HOJE)) && /não é dia fechado/.test(J('2026-11-01', '2026-12-01', false, HOJE)));
  C('E: HIST_DE depois de HIST_ATE é recusado', /depois de HIST_ATE/.test(J('2026-10-05', '2026-10-01', true, HOJE)));
  C('E: data torta é recusada', ['02/07/2024', '2026-13-01', '2026-02-30', '2026-2-3', '', undefined].every((d) => /não é uma data/.test(J(d, '2026-10-31', true, HOJE)))
    && /não é uma data/.test(J('2024-07-02', '31/10/2026', true, HOJE)));
  C('E: os dias da janela, com as duas pontas', G.diasEntre('2026-02-27', '2026-03-01').join() === '2026-02-27,2026-02-28,2026-03-01' && G.diasEntre('2026-10-31', '2026-10-31').length === 1);

  // F · dia sem intervalo (arquivo existe, `dados` vazio): não é lido nem derruba a semente
  const F = await roda({ '2026-10-10': coleta('2026-10-10', { 6215: [['23:05', '23:40']] }), '2026-10-11': { dados: [] }, '2026-10-12': coleta('2026-10-12'), '2026-10-13': { erro: 'sem dados' } },
    {}, '2026-10-10', '2026-10-13');
  const f7 = ev(F.x.meses[MES10], 'cto_aberto:M7C1:2026-10-10T23:00:00');
  C('F: dia sem intervalo não conta como lido', F.r.lidos === 2 && F.r.sem_intervalo.join() === '2026-10-11', F.r);
  C('F: arquivo sem `dados` conta como sem arquivo', F.r.sem_arquivo.join() === '2026-10-13', F.r.sem_arquivo);
  C('F: o aberto atravessa o dia sem intervalo e fecha na borda do 1º slot seguinte', f7 && f7.fim === '2026-10-12T00:00:00' && F.r.em_curso_no_fim.length === 0, f7);

  // G · a guarda de não reabrir é só do retroativo: a fusão da rodada de 5 min segue valendo o mais novo
  const pubG = { eventos: [{ id: 'a', ini: '2026-11-01T10:00:00', fim: '2026-11-01T12:00:00' }], medidor_com: [] };
  const novG = { gerado: 'x', eq: {}, eventos: [{ id: 'a', ini: '2026-11-01T10:00:00', fim: null }], medidor_com: [] };
  C('G: sem a opção, o id repetido vale o mais novo (rodada de 5 min)', G.fundeMes(pubG, novG, '2026-11').eventos[0].fim === null);
  C('G: com a opção, o fechado não reabre; o fim novo ainda corrige o velho', G.fundeMes(pubG, novG, '2026-11', { naoReabre: true }).eventos[0].fim === '2026-11-01T12:00:00'
    && G.fundeMes(pubG, { ...novG, eventos: [{ id: 'a', ini: '2026-11-01T10:00:00', fim: '2026-11-01T13:00:00' }] }, '2026-11', { naoReabre: true }).eventos[0].fim === '2026-11-01T13:00:00');
  return f;
}

// ---- o `main` de verdade, por processo, com os dias numa pasta (metade em gzip, metade em texto)
function preparaDias(dir) {
  fs.mkdirSync(dir, { recursive: true });
  Object.keys(DIAS).forEach((d, i) => { const b = Buffer.from(JSON.stringify(DIAS[d])); fs.writeFileSync(path.join(dir, 'way2_' + d + '.json'), i % 2 ? b : zlib.gzipSync(b)); });
}
function chama(gen, extra) {
  // a base do storage aponta para uma porta fechada desta máquina: plantio que escape para a leitura falha aqui, sem sair para a rede
  const env = { ...process.env, AGORA, DADOS_BASE_PUB: 'http://127.0.0.1:9/dados/', DADOS_CONTA_URL: 'http://127.0.0.1:9', ...extra };
  for (const k of ['DADOS_STORAGE', 'DADOS_SAS', 'AZURE_CLIENT_ID', 'AZURE_TENANT_ID', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'GITHUB_STEP_SUMMARY',
    'LOCAL_OUT', 'LOCAL_PUB', 'LOCAL_ELET', 'ELET_LOCAL_DIR', 'LOCAL_SAUDE', 'SEMEIA_LOCAL', 'HIST_DE', 'HIST_ATE', 'LOCAL_WAY2_DIR', 'LOCAL_HIST_DIR']) if (!(k in extra)) delete env[k];
  const r = spawnSync(process.execPath, [gen], { env, encoding: 'utf8' });
  return { status: r.status, saida: (r.stdout || '') + (r.stderr || '') };
}
const arvore = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((x) => String(x).replace(/\\/g, '/')).filter((x) => fs.statSync(path.join(d, x)).isFile()).sort() : []);
const leGz = (f) => JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
function viaMain(gen, tmp) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det !== undefined ? ' · ' + (typeof det === 'string' ? det : JSON.stringify(det)).slice(0, 260) : '')); };
  const dias = path.join(tmp, 'dias'); if (!fs.existsSync(dias)) preparaDias(dias);
  const sai = (n) => fs.mkdtempSync(path.join(tmp, n + '-'));

  // M1 · a janela pedida, em pasta local
  const o1 = sai('m1'), r1 = chama(gen, { HIST_DE: '2026-09-29', HIST_ATE: '2026-10-03', LOCAL_WAY2_DIR: dias, LOCAL_HIST_DIR: o1 });
  C('M1: sai 0', r1.status === 0, r1.saida.slice(-300));
  C('M1: grava os dois meses e o registro, e mais nada (o alarmes_way2.json não é tocado)', arvore(o1).join() === [MES9, MES10, 'retro_way2_resumo.json'].join(), arvore(o1));
  let res = null; try { res = JSON.parse(fs.readFileSync(path.join(o1, 'retro_way2_resumo.json'), 'utf8')); } catch (e) { /* julgado abaixo */ }
  C('M1: o registro traz a janela, os dias e o que ficou em curso', res && res.de === '2026-09-29' && res.ate === '2026-10-03' && res.dias === 5 && res.lidos === 4
    && res.sem_arquivo.join() === '2026-10-02' && res.em_curso_no_fim.length === 1 && res.em_curso_no_fim[0].tag === 'M8C1', res);
  let m10 = null; try { m10 = leGz(path.join(o1, MES10)); } catch (e) { /* julgado abaixo */ }
  C('M1: outubro não tem nada do dia 04 (fora da janela)', m10 && m10.eventos.length === 2 && !m10.eventos.some((e) => e.tag === 'M2C1') && m10.eventos.find((e) => e.tag === 'M8C1').fim === null, m10 && m10.eventos);
  C('M1: o log diz os dias, o dia sem arquivo e avisa o que fica em curso', /5 dia\(s\) pedido\(s\) · 4 lido\(s\) · 1 sem arquivo/.test(r1.saida) && /dias sem arquivo: 2026-10-02/.test(r1.saida)
    && /::warning::cto_aberto M8C1 desde 2026-10-01T22:00:00 fica EM CURSO/.test(r1.saida), r1.saida.slice(-500));

  // M2 · sem HIST_ATE: vai até o teto, nem um dia a mais
  const o2 = sai('m2'), r2 = chama(gen, { HIST_DE: '2026-09-29', LOCAL_WAY2_DIR: dias, LOCAL_HIST_DIR: o2 });
  let res2 = null; try { res2 = JSON.parse(fs.readFileSync(path.join(o2, 'retro_way2_resumo.json'), 'utf8')); } catch (e) { /* julgado abaixo */ }
  C('M2: sem HIST_ATE a janela vai de 29/09 a 31/10 (33 dias) e novembro não nasce', r2.status === 0 && res2 && res2.ate === '2026-10-31' && res2.dias === 33 && res2.lidos === 5
    && !arvore(o2).some((n) => /2026_11/.test(n)), res2 || r2.saida.slice(-300));

  // M3 · pasta local de dias sem pasta local de saída: recusa (nunca grava no storage o que leu de uma pasta)
  const r3 = chama(gen, { HIST_DE: '2026-09-29', HIST_ATE: '2026-10-03', LOCAL_WAY2_DIR: dias });
  C('M3: LOCAL_WAY2_DIR sem LOCAL_HIST_DIR é recusado', r3.status === 1 && /LOCAL_WAY2_DIR sem LOCAL_HIST_DIR/.test(r3.saida), r3.saida.slice(-300));

  // M4 · gravação de verdade: o teto barra antes de qualquer leitura; dentro do teto, sem credencial, para (não cai na leitura pública)
  const r4 = chama(gen, { HIST_DE: '2024-07-02', HIST_ATE: '2026-11-05' });
  C('M4: no storage, HIST_ATE em novembro é recusado antes de ler', r4.status === 1 && /passa de 2026-10-31/.test(r4.saida) && !/sem o histórico do medidor/.test(r4.saida), r4.saida.slice(-300));
  const r4b = chama(gen, { HIST_DE: '2026-10-30', HIST_ATE: '2026-10-31' });
  C('M4: no storage, sem credencial, para antes de ler', r4b.status === 1 && /sem credencial do storage/.test(r4b.saida) && !/sem o histórico do medidor/.test(r4b.saida), r4b.saida.slice(-300));

  // M5 · o publicado tem sobreposição: sai 1, o mês fica como estava e o outro mês não nasce
  const o5 = sai('m5'), f10 = path.join(o5, MES10);
  fs.mkdirSync(path.dirname(f10), { recursive: true }); fs.writeFileSync(f10, zlib.gzipSync(Buffer.from(JSON.stringify(SOBRE10()))));
  const b5 = fs.readFileSync(f10), r5 = chama(gen, { HIST_DE: '2026-09-29', HIST_ATE: '2026-10-03', LOCAL_WAY2_DIR: dias, LOCAL_HIST_DIR: o5 });
  C('M5: com sobreposição sai 1 e nomeia o par', r5.status === 1 && /SOBREPOSTO: /.test(r5.saida) && /nada gravado/.test(r5.saida), r5.saida.slice(-300));
  C('M5: o mês publicado fica byte a byte e setembro não nasce', b5.equals(fs.readFileSync(f10)) && !arvore(o5).includes(MES9), arvore(o5));
  return f;
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(__dirname, '.ensaio-way2-retro-'));   // ao lado: o require('./lib-…') da cópia acha a lib
  let ruim = 0;
  try {
    const reais = (await cenarios(require(GEN))).concat(viaMain(GEN, tmp));
    if (reais.length) { console.log('🔴 o retroativo reprova:'); reais.forEach((x) => console.log('  - ' + x)); process.exitCode = 1; return; }
    console.log('✅ retroativo: os cenários A a G e o main (M1 a M5) passam');

    const SRC = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
    // [nome, de, para, 'main' = o defeito só aparece rodando o processo]
    const PLANTIOS = [
      ['HIST_ATE ignorado: vai até ontem', "janelaRetro(process.env.HIST_DE, process.env.HIST_ATE, !histDir,", "janelaRetro(process.env.HIST_DE, somaDia(A.isoBRT(agoraMs).slice(0, 10), -1), !histDir,", 'main'],
      ['sem HIST_ATE vai até ontem, não até o teto', "ate = ate || RETRO_TETO;", "ate = ate || somaDia(hoje, -1);"],
      ['o teto não vale na gravação de verdade', "if (noStorage && ate > RETRO_TETO)", "if (false && ate > RETRO_TETO)"],
      ['o teto em novembro', "const RETRO_TETO = '2026-10-31';", "const RETRO_TETO = '2026-11-30';"],
      ['dia em curso aceito na janela', "if (ate >= hoje) throw", "if (false) throw"],
      ['dia sem arquivo derruba a semente', "{ semArquivo.push(dia); log(", "{ semArquivo.push(dia); pub = null; log("],
      ['cada dia sem a semente do anterior', "compoe(j, pub, A.msBRT(dia + 'T23:59:00'))", "compoe(j, null, A.msBRT(dia + 'T23:59:00'))"],
      ['o retroativo reabre o que o publicado fechou', "if (naoReabre && a && a.fim != null && e.fim == null) continue;", ""],
      ['o mês publicado é descartado (some a queda de medidor)', "c.obj = fundeMes(c.obj, o, m, { naoReabre: true });", "c.obj = fundeMes(c.obj === c.antes ? null : c.obj, o, m, { naoReabre: true });"],
      ['o sobreposto é gravado', "if (sobre.length) return r;", ""],
      ['a sobreposição não é procurada', "const sobre = sobrepostos(tudo);", "const sobre = [];"],
      ['regrava mês que não mudou', "if (!c.obj || corpo(c.antes) === corpo(c.obj)) continue;", "if (!c.obj) continue;"],
      ['o mês sai com a hora do dia forjado', "c.obj.gerado = A.isoBRT(io.agoraMs);", ""],
      ['o dia sem arquivo some do registro', "{ semArquivo.push(dia); log(", "{ log("],
      ['dia sem intervalo conta como lido', "if (!o) { semSlot.push(dia); continue; }", "if (!o) { lidos++; continue; }"],
      ['o registro perde o que ficou em curso', ".filter((e) => e.fim == null).map((e) => {", ".filter((e) => e.fim === undefined).map((e) => {"],
      ['o registro diz ausente o que o publicado tinha fechado', "publicado_antes: !a ? 'ausente'", "publicado_antes: true ? 'ausente'"],
      ['dia de pasta local gravável no storage', "if (diasDir && !histDir) throw new Error(", "if (false) throw new Error(", 'main'],
      ['o sobreposto sai 0', "if (r.sobrepostos.length) throw new Error(", "if (false) throw new Error(", 'main'],
      ['sem credencial segue para a leitura', "if (!histDir && !require('./lib-conteiner').credencial()) throw new Error(", "if (false) throw new Error(", 'main'],
    ];
    for (let k = 0; k < PLANTIOS.length; k++) {
      const [nome, de, para, onde] = PLANTIOS[k];
      if (SRC.split(de).length !== 2) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado ou repetido): ' + nome); ruim++; continue; }
      const arq = path.join(tmp, 'gen-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para).replace(/require\('\.\/lib-/g, "require('../lib-"));
      let f; try { f = await cenarios(require(arq)); if (!f.length && onde === 'main') f = viaMain(arq, tmp); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0].slice(0, 150) + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    }
    if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exitCode = 1; return; }
    console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
})().catch((e) => { console.error('🔴 ' + (e && e.stack || e)); process.exit(1); });
