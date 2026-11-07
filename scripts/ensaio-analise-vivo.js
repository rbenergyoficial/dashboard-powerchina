'use strict';
/*
 * ensaio-analise-vivo.js — a Análise de dados ao vivo (lib-analise-vivo.js e gen-analise-vivo.js; lote analise-ao-vivo, 07/11/2026).
 *
 * O ESPERADO vem de fora da lib: o registro de campo (14T2 aberto pelo SEP às 14:10:36 de 21/09/2026), a tabela do supervisório (CUB10_2 aberto às
 * 06:23:08 de 27/10/2026, M7C1 e M9C1), o registro da mesa (29/10: liberado às 09:29 com 332 MW pedidos; 06/11: liberado às 12:57) e a lista de
 * circuitos de cada trafo, escrita aqui à mão.
 *   REAIS (rede, DADOS_SAS; roda no ensaios.yml a cada push):
 *     1. 21/09: UM achado agrupado, o 04T2 sem tensão com os 11 circuitos dele, e nenhum "liberado e não recuperou" (a liberação das 14:06 caiu
 *        junto com o trip);
 *     2. 27/10: UM achado com M7C1 e M9C1 abertos juntos, início a ±5 min de 06:23;
 *     3. 29/10: "liberado e não recuperou" a partir da liberação das 09:29, potência em ~333 MW (o pedido era 332), e fim até a restrição das 10:24;
 *     4. 06/11: NADA (a potência foi a 341 MW três minutos depois da liberação das 12:57);
 *     5. 06/11 com o controle preso em 300 MW (plantado: a mesa pede 300 às 12:41 e libera às 12:57; o Complexo fica em 300 até 14:00): acusa.
 *   SEMANA (--semana, rede; manual: 11 dias × ~4 MB de saída): 20 a 26 e 28 a 31/10 sem achado nenhum, salvo a manobra da barra 4 que começou em
 *     27/10 e segue até 01:55 de 28/10.
 *   FORJADOS (sem rede; roda no job de 5 min antes do gerador): a nuvem depois da liberação não acusa; a latência (slot com menos de 20 min não
 *     conta); circuito energizado sem geração acusa, aberto não (é a Medição); dois abertos juntos viram um; D5 acusa o ponto sem dado e cala o que a
 *     queda de comunicação já mostra; a fusão: duas rodadas seguidas dão os mesmos ids (sem repetir alerta); o aberto da véspera herda o id.
 * Depois PLANTA defeitos numa cópia da lib e exige que cada um reprove.
 * uso: DADOS_SAS=… node scripts/ensaio-analise-vivo.js · node scripts/ensaio-analise-vivo.js --forjados · DADOS_SAS=… node scripts/ensaio-analise-vivo.js --semana
 */
const fs = require('fs'), os = require('os'), path = require('path');
const LIB = path.join(__dirname, 'lib-analise-vivo.js');
const ms = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');

/* ---- forjados no formato cru da Way2: linhas [hh:mm, P kW, Q kvar, I A, V fase-neutro] ---- */
const VIVA = 19900;
function forja(pid, linhas, dia = '2026-10-28') {
  const g = { Demat: 1, Demre: 2, CorrenteA: 3, CorrenteB: 3, CorrenteC: 3, TensaoA: 4, TensaoB: 4, TensaoC: 4 };
  return Object.entries(g).map(([nome, k]) => ({ pontoId: pid, nomeGrandeza: nome, valores: linhas.map((l) => ({ data: dia + 'T' + l[0] + ':00', valor: l[k], qualidade: 0 })) }));
}
const horas = (de, ate) => { const o = []; for (let m = +de.slice(0, 2) * 60 + +de.slice(3); m <= +ate.slice(0, 2) * 60 + +ate.slice(3); m += 5) o.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0')); return o; };
/* um dia inteiro: Complexo com potência p(h) em MW, cada circuito na sua fatia, salvo os ajustes */
function dia(pFn, ajuste = {}, d = '2026-10-28', de = '06:00', ate = '18:00') {
  const CIRC = require(LIB).CIRC, CAP = require(LIB).CAP, H = horas(de, ate), out = [];
  out.push(...forja(6233, H.map((h) => [h, pFn(h) * 1000, 100, 500, 79000]), d));
  for (const [u, ps] of Object.entries(CIRC)) ps.forEach((p) => {
    out.push(...forja(p, H.map((h) => { const base = pFn(h) * 1000 * CAP[u] / 343.77 / ps.length; const a = ajuste[p] && ajuste[p](h); return a || [h, base, 300, 90, VIVA]; }).filter(Boolean), d));
  });
  return out;
}
const ent = (h, a, b) => h >= a && h <= b;

/* o gerador de verdade, como processo, sem rede (LOCAL_*): a mesa sem `eventos` não vira mesa vazia (revisão RW-002) */
const { spawnSync } = require('child_process');
function rodaGen(GEN, elet, mesa, agora) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-gen-analise-')), w = (n, o) => { const f = path.join(d, n); fs.writeFileSync(f, JSON.stringify(o)); return f; };
  try {
    const env = { ...process.env, LOCAL_ELET: w('elet.json', elet), LOCAL_MESA: w('mesa.json', mesa), LOCAL_OUT: path.join(d, 'out.json'), AGORA: agora };
    ['LOCAL_PUB', 'LOCAL_WAY2', 'ELET_LOCAL_DIR'].forEach((k) => delete env[k]);
    const r = spawnSync(process.execPath, [GEN], { env, encoding: 'utf8' });
    const out = fs.existsSync(env.LOCAL_OUT) ? JSON.parse(fs.readFileSync(env.LOCAL_OUT, 'utf8')) : null;
    return { cod: r.status, txt: (r.stdout || '') + (r.stderr || ''), out };
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
}
function casosGerador(GEN) {
  const f = [], C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const zeroVivo = (h) => (ent(h, '10:00', '11:00') ? [h, 0.2, 60, 0.6, VIVA] : null);
  const elet = { dados: dia((h) => (h < '12:41' ? 330 : ent(h, '12:41', '14:00') ? 300 : 341), { 6209: zeroVivo }) };
  const boa = { eventos: [{ dia: '2026-10-28', ts: '2026-10-28 12:41', pot: 300, restr: 1 }, { dia: '2026-10-28', ts: '2026-10-28 12:57', pot: 343.77, restr: 0 }] };
  const ok = rodaGen(GEN, elet, boa, '2026-10-28T16:00:00');
  C('gerador com a mesa boa: sai 0, com o D1 e o circuito sem geração', ok.cod === 0 && ok.out && ok.out.mesa_ok === true && ok.out.achados.some((a) => a.tipo === 'liberado_nao_recuperou') && ok.out.achados.some((a) => a.tipo === 'circuito_sem_geracao'), ok.cod + ' ' + ok.txt.slice(-200));
  const ruim = rodaGen(GEN, elet, { gerado_em: 'x', dias: [] }, '2026-10-28T16:00:00');
  C('gerador com a mesa SEM `eventos`: sai 1 com ::error::', ruim.cod === 1 && /::error::/.test(ruim.txt), ruim.cod + ' ' + ruim.txt.slice(-200));
  C('gerador com a mesa SEM `eventos`: grava os outros detectores, sem o D1 e com mesa_ok falso', ruim.out && ruim.out.mesa_ok === false && ruim.out.erros.length === 1
    && !ruim.out.achados.some((a) => a.tipo === 'liberado_nao_recuperou') && ruim.out.achados.some((a) => a.tipo === 'circuito_sem_geracao'), JSON.stringify(ruim.out && ruim.out.achados.map((a) => a.tipo)));
  const G = require(GEN);
  let estourou = false; try { G.eventosDaMesa({ dias: [] }); } catch (e) { estourou = true; }
  C('a mesa sem `eventos` estoura (não vira lista vazia)', estourou);
  C('falha passageira × erro: 503 e ETIMEDOUT passageiros, 403 e formato não', G.passageira({ statusCode: 503 }) && G.passageira({ code: 'ETIMEDOUT' }) && !G.passageira({ statusCode: 403 }) && !G.passageira(new Error('sem a lista `eventos`')));
  /* a leitura do registro falhou nesta rodada: o que fazer */
  const AG = ms('2026-10-28T12:00:00'), g = [{ dia: '2026-10-28', ts: '2026-10-28 08:00', pot: 300, restr: 1 }], T503 = { statusCode: 503, message: 'Service Unavailable' };
  const f1 = G.mesaNaFalha(T503, { guardada: g, lida: AG - 3600e3, falhasAntes: 3, agoraMs: AG });
  C('mesa: passageira com o guardado lido há 1 h usa o guardado, sem erro', f1.mesa === g && !f1.erro && f1.aviso, JSON.stringify(f1));
  const f2 = G.mesaNaFalha(T503, { guardada: null, lida: null, falhasAntes: 0, agoraMs: AG });
  C('mesa: a PRIMEIRA passageira sem registro do dia (virada do dia) é tolerada: aviso, sem erro, sem o D1', f2.mesa === null && !f2.erro && f2.aviso && f2.falhas === 1, JSON.stringify(f2));
  const f3 = G.mesaNaFalha(T503, { guardada: null, lida: null, falhasAntes: 1, agoraMs: AG });
  C('mesa: a segunda passageira seguida sem registro é erro', f3.mesa === null && !!f3.erro && f3.falhas === 2, JSON.stringify(f3));
  const f4 = G.mesaNaFalha(T503, { guardada: g, lida: AG - 4 * 3600e3, falhasAntes: 40, agoraMs: AG });
  C('mesa: o guardado lido há mais de 3 h é erro', f4.mesa === null && !!f4.erro, JSON.stringify(f4));
  const f5 = G.mesaNaFalha({ statusCode: 403, message: 'Forbidden' }, { guardada: g, lida: AG - 60e3, falhasAntes: 0, agoraMs: AG });
  C('mesa: erro que não é passageiro é erro, mesmo com o guardado recente', f5.mesa === null && !!f5.erro, JSON.stringify(f5));
  C('mesa: a linha de erro diz que o ao vivo segue e só o "liberado e não recuperou" está desligado', /^::error::/.test(G.linhaErro('x')) && /liberado e não recuperou" está DESLIGADO/.test(G.linhaErro('x')) && /seguem gravando/.test(G.linhaErro('x')));
  return f;
}

function casosForjados(A) {
  const f = [], C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const mesa = [{ dia: '2026-10-28', ts: '2026-10-28 12:41', pot: 300, restr: 1 }, { dia: '2026-10-28', ts: '2026-10-28 12:57', pot: 343.77, restr: 0 }];
  // 1. preso em 300 depois da liberação
  const preso = dia((h) => (h < '12:41' ? 330 : ent(h, '12:41', '14:00') ? 300 : 341));
  const a1 = A.analisa({ dados: preso, mesa, dia: '2026-10-28' }).filter((a) => a.tipo === 'liberado_nao_recuperou');
  C('D1: controle preso no pedido antigo acusa', a1.length === 1 && a1[0].p === 2 && a1[0].voz === true, JSON.stringify(a1.map((a) => a.ini)));
  C('D1: o fim é quando a potência passa do pedido antigo', a1.length === 1 && a1[0].fim && a1[0].fim.slice(11, 16) >= '14:00' && a1[0].fim.slice(11, 16) <= '14:15', a1[0] && a1[0].fim);
  // 2. recuperou
  const ok = dia((h) => (h < '12:41' ? 330 : ent(h, '12:41', '12:57') ? 300 : 341));
  C('D1: recuperou ao teto, nada', !A.analisa({ dados: ok, mesa, dia: '2026-10-28' }).some((a) => a.tipo === 'liberado_nao_recuperou'));
  // 3. nuvem: oscila em volta de 300
  const nuvem = dia((h) => (h < '12:41' ? 330 : ent(h, '12:41', '12:57') ? 300 : 300 + (+h.slice(3) % 10 === 0 ? 25 : -25)));
  C('D1: nuvem (potência oscilando) não acusa', !A.analisa({ dados: nuvem, mesa, dia: '2026-10-28' }).some((a) => a.tipo === 'liberado_nao_recuperou'));
  // 4. latência: às 13:20 o preso começou há pouco; com o "agora" às 13:20, só slots até 13:00 contam → ainda não
  C('D1: slot com menos de 20 min não conta', !A.analisa({ dados: preso, mesa, dia: '2026-10-28', agoraMs: ms('2026-10-28T13:20:00') }).some((a) => a.tipo === 'liberado_nao_recuperou'));
  C('D1: com o "agora" às 14:00, já acusa', A.analisa({ dados: preso, mesa, dia: '2026-10-28', agoraMs: ms('2026-10-28T14:00:00') }).some((a) => a.tipo === 'liberado_nao_recuperou'));
  // 5. circuito energizado sem geração (P≈0 com I e Q) e aberto (zero literal com a barra viva)
  const zeroVivo = (h) => (ent(h, '10:00', '11:00') ? [h, 0.2, 60, 0.6, VIVA] : null);
  const aberto = (h) => (ent(h, '10:00', '11:00') ? [h, 0, 0, 0.02, VIVA] : null);
  const sg = A.analisa({ dados: dia(() => 300, { 6209: zeroVivo }), mesa: [], dia: '2026-10-28' }).filter((a) => a.tipo === 'circuito_sem_geracao');
  C('D4: circuito energizado sem geração acusa (M5C1, usina M5)', sg.length === 1 && sg[0].tag === 'M5C1' && sg[0].u === 'M5' && sg[0].ini.slice(11, 16) === '09:55', JSON.stringify(sg.map((a) => a.tag + ' ' + a.u + ' ' + a.ini)));
  // a SE sem tensão: os dois trafos e os 22 circuitos zerados com a tensão a zero → UM achado (a SE), não três
  const mortoT = (h) => (ent(h, '10:00', '11:00') ? [h, 0, 0, 0.01, 50] : null);
  const ajSE = {}; Object.values(A.CIRC).forEach((ps) => ps.forEach((q) => { ajSE[q] = mortoT; }));
  const dSE = dia(() => 300, ajSE).concat(forja(6196, horas('06:00', '18:00').map((h) => (ent(h, '10:00', '11:00') ? [h, 0, 0, 0.01, 50] : [h, 150000, 900, 400, 132000]))),
    forja(6197, horas('06:00', '18:00').map((h) => (ent(h, '10:00', '11:00') ? [h, 0, 0, 0.01, 50] : [h, 150000, 900, 400, 132000]))));
  const aSE = A.analisa({ dados: dSE, mesa: [], dia: '2026-10-28' }).filter((a) => a.tipo === 'ocorrencia_agrupada');
  C('D4: a SE sem tensão é UM achado com os 22 circuitos (o trafo não sai à parte)', aSE.length === 1 && aSE[0].tag === 'SE' && aSE[0].ev.n === 22 && aSE[0].p === 1, JSON.stringify(aSE.map((a) => a.tag + ':' + a.ev.n)));
  // a ocorrência explica a potência baixa depois da liberação: com dois circuitos abertos às 12:45 e a potência em 300, nada de D1
  const comOc = dia((h) => (h < '12:41' ? 330 : ent(h, '12:41', '14:00') ? 300 : 341), { 6215: (h) => (ent(h, '12:45', '13:30') ? [h, 0, 0, 0.02, VIVA] : null), 6219: (h) => (ent(h, '12:45', '13:30') ? [h, 0, 0, 0.02, VIVA] : null) });
  C('D1: com circuito aberto na janela, a ocorrência explica (nada de D1)', !A.analisa({ dados: comOc, mesa, dia: '2026-10-28' }).some((a) => a.tipo === 'liberado_nao_recuperou'));
  const ab = A.analisa({ dados: dia(() => 300, { 6209: aberto }), mesa: [], dia: '2026-10-28' });
  C('D4: circuito ABERTO sozinho não é achado (a linha da Medição já é ele)', !ab.length, JSON.stringify(ab.map((a) => a.tipo + ' ' + a.tag)));
  const ab2 = A.analisa({ dados: dia(() => 300, { 6215: aberto, 6219: aberto }), mesa: [], dia: '2026-10-28' }).filter((a) => a.tipo === 'ocorrencia_agrupada');
  C('D4: dois abertos juntos viram UM achado', ab2.length === 1 && ab2[0].ev.n === 2 && ab2[0].voz === false, JSON.stringify(ab2.map((a) => a.tag)));
  const m1 = A.analisa({ dados: dia(() => 300, { 6198: zeroVivo, 6199: zeroVivo, 6200: zeroVivo }), mesa: [], dia: '2026-10-28' }).filter((a) => a.tipo === 'circuito_sem_geracao');
  C('D4: a usina inteira sem geração é UM achado com os 3 circuitos', m1.length === 1 && m1[0].ev.n === 3, JSON.stringify(m1.map((a) => a.tag)));
  C('D4: com o Complexo abaixo de 30 % da plena (noite, corte), nada', !A.analisa({ dados: dia(() => 50, { 6209: zeroVivo }), mesa: [], dia: '2026-10-28' }).length);
  // 6. D5: ponto sem dado de 10:00 a 10:30; a queda já publicada cala
  const sem = (h) => (ent(h, '10:00', '10:30') ? undefined : null);
  const d5d = dia(() => 300, {}).map((s) => (s.pontoId === 6210 ? { ...s, valores: s.valores.filter((v) => !ent(v.data.slice(11, 16), '10:00', '10:30')) } : s));
  void sem;
  const d5 = A.analisa({ dados: d5d, mesa: [], dia: '2026-10-28' }).filter((a) => a.tipo === 'medidor_sem_dado');
  C('D5: ponto sem dado por 7 slots acusa (M5C2)', d5.length === 1 && d5[0].tag === 'M5C2' && d5[0].ev.slots === 7, JSON.stringify(d5.map((a) => a.tag + ' ' + a.ev.slots)));
  const d5c = A.analisa({ dados: d5d, mesa: [], dia: '2026-10-28', medidorCom: [{ pid: 6210, ini: '2026-10-28T09:58:00', fim: '2026-10-28T10:40:00' }] }).filter((a) => a.tipo === 'medidor_sem_dado');
  C('D5: a queda de comunicação já publicada cala o mesmo ponto', !d5c.length);
  C('D5: o slot com menos de 20 min não conta (às 10:25 só 10:00 e 10:05 fecharam)', !A.analisa({ dados: d5d, mesa: [], dia: '2026-10-28', agoraMs: ms('2026-10-28T10:25:00') }).some((a) => a.tipo === 'medidor_sem_dado'));
  // 7. a fusão: duas rodadas seguidas, os mesmos ids; o aberto da véspera herda o id
  const r1 = A.analisa({ dados: preso, mesa, dia: '2026-10-28' }), p1 = A.funde([], r1, '2026-10-28', ms('2026-10-28T15:00:00'));
  const p2 = A.funde(p1, A.analisa({ dados: preso, mesa, dia: '2026-10-28' }), '2026-10-28', ms('2026-10-28T15:05:00'));
  C('fusão: a rodada seguinte dá os mesmos ids e o mesmo "visto" (o alerta não se repete)', JSON.stringify(p1.map((a) => a.id + a.visto)) === JSON.stringify(p2.map((a) => a.id + a.visto)), p2.length + ' × ' + p1.length);
  const vesp = [{ id: 'ocorrencia:cto_aberto:M7C1+M9C1:2026-10-27T17:15:00', tipo: 'ocorrencia_agrupada', tag: 'M7C1 + M9C1', ini: '2026-10-27T17:15:00', fim: null, p: 2, texto: 'x', visto: 'v0' }];
  const hoje = [{ id: 'ocorrencia:cto_aberto:M7C1+M9C1:2026-10-28T00:00:00', tipo: 'ocorrencia_agrupada', tag: 'M7C1 + M9C1', ini: '2026-10-28T00:00:00', fim: '2026-10-28T01:55:00', p: 2, texto: 'x' }];
  const fv = A.funde(vesp, hoje, '2026-10-28', ms('2026-10-28T08:00:00'));
  C('fusão: o aberto da véspera que segue à 00:00 é o mesmo achado (id, início e visto da véspera; fim de hoje)', fv.length === 1 && fv[0].id === vesp[0].id && fv[0].fim === '2026-10-28T01:55:00' && fv[0].visto === 'v0', JSON.stringify(fv.map((a) => a.id)));
  /* o gerador: duas rodadas seguidas sobre a mesma coleta, com a mesa do dia guardada e a queda publicada do alarmes_way2 */
  const G = require('./gen-analise-vivo');
  const elet = { dados: preso };
  const md = G.mesaDoDia([{ dia: '2026-10-27', ts: '2026-10-27 18:00', pot: 0, restr: 0 }].concat(mesa), '2026-10-28');
  C('gerador: a mesa do dia leva o último evento da véspera e os do dia', md.length === 3 && md[0].dia === '2026-10-27', JSON.stringify(md.map((x) => x.ts)));
  C('gerador: o dia sai do primeiro carimbo da coleta', G.diaDaColeta(elet) === '2026-10-28', G.diaDaColeta(elet));
  const o1 = G.compoe({ elet, mesa: md, way2: { medidor_com: [] }, pub: null, agoraMs: ms('2026-10-28T15:00:00'), marcaMesa: 'e1' });
  const o2 = G.compoe({ elet, mesa: md, way2: { medidor_com: [] }, pub: o1, agoraMs: ms('2026-10-28T15:05:00'), marcaMesa: 'e1' });
  C('gerador: duas rodadas, os mesmos achados e o mesmo visto', o1 && o2 && JSON.stringify(o1.achados.map((a) => a.id + a.visto)) === JSON.stringify(o2.achados.map((a) => a.id + a.visto)) && o1.achados.length === 1, o1 && o1.achados.length);
  C('gerador: o arquivo traz limiares, calibração, marca da mesa e resumo', o1 && o1.limiares && o1.calibracao && o1.marcas.mesa === 'e1' && o1.resumo.abertos === 0 && o1.fonte === 'analise');
  try { A.guarda([{ id: 'x', p: 5, texto: 't' }]); C('guarda: prioridade fora de 1–3 estoura', false); } catch (e) { /* ok */ }
  try { A.guarda([{ id: 'x', p: 2, texto: 't', voz: true }]); C('guarda: voz sem fala estoura', false); } catch (e) { /* ok */ }
  return f;
}

/* ---- reais ---- */
/* os dias fixos são dias fechados (o arquivo não muda). ENSAIO_DIAS_DIR é SÓ para rodar na máquina: o dia lido uma vez fica numa pasta local. O
   workflow não usa: o dado do medidor não vai para o cache do repositório público, e no ensaios.yml os 4 dias vêm da rede a cada execução */
async function carrega(dias) {
  const LD = require('./lib-le-dados'), D = {}, zlib = require('zlib'), DIR = process.env.ENSAIO_DIAS_DIR;
  let rede = 0, disco = 0;
  for (const d of dias) {
    const arq = DIR && path.join(DIR, 'way2_' + d + '.json.gz');
    let j = null;
    if (arq && fs.existsSync(arq)) { try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(arq)).toString('utf8')); disco++; } catch (e) { j = null; } }
    if (!j) {
      j = await LD.json(LD.BASE + 'hist/way2_' + d + '.json'); rede++;
      if (arq && j && Array.isArray(j.dados)) { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(arq, zlib.gzipSync(Buffer.from(JSON.stringify(j)))); }
    }
    if (!j || !Array.isArray(j.dados)) throw new Error('o arquivo do medidor de ' + d + ' não existe mais (dia fixo do ensaio): reprova');
    D[d] = j.dados;
  }
  console.log('dias fixos: ' + disco + ' do disco, ' + rede + ' da rede');
  const m = await LD.json(LD.BASE + 'ppc_restricao.json');
  if (!m || !Array.isArray(m.eventos)) throw new Error('o registro da mesa não foi lido: reprova');
  return { D, mesa: m.eventos };
}
const D04T2 = ['M3C1', 'M3C2', 'M3C3', 'M4C1', 'M4C2', 'M4C3', 'M7C1', 'M8C1', 'M8C2', 'M8C3', 'M9C1'];

function casosReais(A, R) {
  const f = [], C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const md = (d) => R.mesa.filter((x) => x.dia <= d).slice(-200);
  const a21 = A.analisa({ dados: R.D['2026-09-21'], mesa: md('2026-09-21'), dia: '2026-09-21' });
  const g21 = a21.filter((a) => a.tipo === 'ocorrencia_agrupada');
  C('21/09: um achado, o 04T2 com os 11 circuitos dele', g21.length === 1 && g21[0].tag === '04T2' && JSON.stringify(g21[0].ev.circuitos) === JSON.stringify(D04T2), JSON.stringify(g21.map((a) => a.tag + ':' + (a.ev.circuitos || []).length)));
  C('21/09: início a ±5 min do campo (14:10:36)', g21.length === 1 && Math.abs(ms(g21[0].ini) - ms('2026-09-21T14:10:36')) <= 300e3, g21[0] && g21[0].ini);
  C('21/09: nenhum "liberado e não recuperou" (o trip explica)', !a21.some((a) => a.tipo === 'liberado_nao_recuperou'));
  C('21/09: nada além do agrupado', a21.length === 1, JSON.stringify(a21.map((a) => a.tipo + ' ' + a.tag)));
  const a27 = A.analisa({ dados: R.D['2026-10-27'], mesa: md('2026-10-27'), dia: '2026-10-27' }).filter((a) => a.ini.slice(11, 16) < '12:00');
  C('27/10 manhã: um achado com M7C1 e M9C1, a ±5 min de 06:23:08', a27.length === 1 && a27[0].tag === 'M7C1 + M9C1' && Math.abs(ms(a27[0].ini) - ms('2026-10-27T06:23:08')) <= 300e3, JSON.stringify(a27.map((a) => a.tag + ' ' + a.ini)));
  const a29 = A.analisa({ dados: R.D['2026-10-29'], mesa: md('2026-10-29'), dia: '2026-10-29' }).filter((a) => a.tipo === 'liberado_nao_recuperou');
  C('29/10: liberado às 09:29 e não recuperou, em ~333 MW', a29.length === 1 && a29[0].ev.liberacao === '2026-10-29 09:29' && Math.abs(a29[0].ev.potencia_mw - 333) <= 2, JSON.stringify(a29.map((a) => a.ev)));
  C('29/10: o achado fecha até a restrição seguinte da mesa (10:24)', a29.length === 1 && a29[0].fim && a29[0].fim <= '2026-10-29T10:25:00', a29[0] && a29[0].fim);
  const a06 = A.analisa({ dados: R.D['2026-11-06'], mesa: md('2026-11-06'), dia: '2026-11-06' });
  C('06/11: nada (a potência foi ao teto depois da liberação das 12:57)', !a06.length, JSON.stringify(a06.map((a) => a.tipo + ' ' + a.ini)));
  /* plantado: o controle preso em 300 MW depois da liberação das 12:57 */
  const pl = R.D['2026-11-06'].map((s) => (s.pontoId === 6233 && s.nomeGrandeza === 'Demat' ? { ...s, valores: s.valores.map((v) => (ent(v.data.slice(11, 16), '12:45', '14:00') ? { ...v, valor: 300000 + (v.data.slice(15, 16) === '5' ? 150 : -150) } : v)) } : s));
  const mp = md('2026-11-06').map((x) => (x.ts === '2026-11-06 12:41' ? { ...x, pot: 300 } : x));
  const ap = A.analisa({ dados: pl, mesa: mp, dia: '2026-11-06' }).filter((a) => a.tipo === 'liberado_nao_recuperou');
  C('06/11 plantado (controle preso em 300 MW): acusa', ap.length === 1 && Math.abs(ap[0].ev.potencia_mw - 300) <= 1, JSON.stringify(ap.map((a) => a.ev)));
  return f;
}

function casosSemana(A, R) {
  const f = [];
  for (const [d, dados] of Object.entries(R.D)) {
    const a = A.analisa({ dados, mesa: R.mesa.filter((x) => x.dia <= d).slice(-200), dia: d }).filter((x) => !(d === '2026-10-28' && x.tipo === 'ocorrencia_agrupada' && x.ini === '2026-10-28T00:00:00'));
    if (a.length) f.push(d + ': ' + a.map((x) => x.tipo + ' ' + x.tag + ' ' + x.ini.slice(11, 16)).join(', '));
  }
  return f;
}

(async () => {
  const A = require(LIB);
  const GEN = path.join(__dirname, 'gen-analise-vivo.js');
  const ff = casosForjados(A).concat(casosGerador(GEN));
  if (ff.length) { console.log('🔴 a lib real reprova nos forjados:'); ff.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  if (process.argv.includes('--forjados')) { console.log('✅ lib real: os forjados passam (os dias reais e os plantios rodam no ensaios.yml)'); return; }
  if (process.argv.includes('--semana')) {
    const dias = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31']
      .filter((d) => d !== '2026-10-29');   // 29/10 é o achado verdadeiro, provado nos reais
    const f = casosSemana(A, await carrega(dias));
    if (f.length) { console.log('🔴 achado em dia sem evento:'); f.forEach((x) => console.log('  - ' + x)); process.exit(1); }
    console.log('✅ ' + dias.length + ' dias sem evento: nenhum achado'); return;
  }
  const R = await carrega(['2026-09-21', '2026-10-27', '2026-10-29', '2026-11-06']);
  const fr = casosReais(A, R);
  if (fr.length) { console.log('🔴 a lib real reprova nos dias reais:'); fr.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('✅ lib real: forjados e dias reais passam');

  const SRC = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n').replace("require('./lib-alarme-circuito')", 'require(' + JSON.stringify(path.join(__dirname, 'lib-alarme-circuito.js')) + ')');
  const PLANTIOS = [
    ['D1 sem a exigência de potência plana (a nuvem vira achado)', 'if (ini == null && mx - mn <= L.PLANO_MW && Math.abs(m - lb.pot_ant) <= L.NO_PEDIDO * lb.pot_ant)', 'if (ini == null && m <= lb.pot_ant * 1.01)'],
    ['D1 sem o "no valor pedido antes"', '&& Math.abs(m - lb.pot_ant) <= L.NO_PEDIDO * lb.pot_ant)', ')'],
    ['D1 sem a ocorrência que explica (21/09 vira achado)', 'if (ocorrencias.some((e) => msBRT(e.ini) < t1 && (e.fim ? msBRT(e.fim) : Infinity) > lb.ms)) continue;', ''],
    ['D1 sem o corte na restrição seguinte', 'const t0 = lb.ms + L.ESPERA_MIN * 60e3, t1 = Math.min(lb.ms + L.JANELA_MIN * 60e3, lb.ate_ms);', 'const t0 = lb.ms + L.ESPERA_MIN * 60e3, t1 = lb.ms + L.JANELA_MIN * 60e3; lb.ate_ms = Infinity;'],
    ['sem a latência da Way2', 'agoraMs == null || t <= agoraMs - L.LATENCIA_MIN * 60e3', 'true'],
    ['D4: o aberto conta como sem geração', "if (v == null || st === 'aberto' || st === 'sem_tensao')", 'if (v == null)'],
    ['D4: circuito sozinho aberto vira achado', 'if (g.length < 2) continue;', ''],
    ['D4: o trafo dentro da SE sai à parte', 'if (usado.has(e.id)) continue;', ''],
    ['D4: sem o piso do Complexo (a noite acusa)', 'if (c < L.COMPLEXO_MIN * PLENA_MW)', 'if (c < 0)'],
    ['D5 não cala a queda já publicada', ".filter((a) => !(medidorCom || []).some((m) => m.pid === a.pid && sob(a, m)))", ''],
    ['fusão: a véspera aberta não herda o id', "if (!n) return a; n._herdado = 1;", 'if (true) return a;'],
    ['circuitos do M4 e do M5 trocados', 'M4: [6206, 6207, 6208], M5: [6209, 6210, 6211],', 'M4: [6209, 6210, 6211], M5: [6206, 6207, 6208],'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-analise-'));
  let ruim = 0;
  try {
    PLANTIOS.forEach(([nome, de, para], k) => {
      if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
      const arq = path.join(tmp, 'lib-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para));
      let f; try { const P = require(arq); f = casosForjados(P).concat(casosReais(P, R)); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0] + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  /* o gerador: a mesa sem `eventos` não pode virar mesa vazia, e o erro tem de sair com código 1 */
  const GSRC = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
  const PLANT_GEN = [
    ['gerador: a mesa sem `eventos` vira lista vazia', "if (!j || !Array.isArray(j.eventos)) throw new Error(MESA + ' sem a lista `eventos`: formato inesperado, o D1 não roda');", "if (!j || !Array.isArray(j.eventos)) return [];"],
    ['gerador: o erro da mesa não muda o código de saída', "if (erros.length) { erros.forEach((m) => console.log(linhaErro(m))); process.exitCode = 1; }\n    return;", "return;"],
    ['gerador: a falha passageira sem registro guardado é tolerada sempre', "if (!guardada && falhasAntes === 0) return", "if (!guardada) return"],
    ['gerador: o registro guardado vale para sempre', "if (guardada && lida != null && agoraMs - lida <= MESA_MAX_H * 3600e3) return", "if (guardada) return"],
    ['gerador: o erro não passageiro usa o guardado', "if (!passageira(e)) return { mesa: null, erro:", "if (!passageira(e) && !guardada) return { mesa: null, erro:"],
    ['gerador: sem mesa, o arquivo diz que a mesa está boa', "mesa_ok: !!mesa,", "mesa_ok: true,"],
    ['gerador: o erro da mesa some do arquivo', "mesa_falhas: mesaFalhas, erros, achados,", "mesa_falhas: mesaFalhas, erros: [], achados,"],
  ];
  const tmpG = fs.mkdtempSync(path.join(__dirname, '.ensaio-gen-analise-'));
  try {
    PLANT_GEN.forEach(([nome, de, para], k) => {
      if (!GSRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
      const arq = path.join(tmpG, 'gen-' + k + '.js');
      fs.writeFileSync(arq, GSRC.replace(de, para).replace(/require\('\.\/(lib-[a-z-]+)'\)/g, (m, n) => 'require(' + JSON.stringify(path.join(__dirname, n + '.js')) + ')'));
      let f; try { f = casosGerador(arq); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0] + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(tmpG, { recursive: true, force: true }); }
  if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
  console.log('✅ ensaio limpo: ' + (PLANTIOS.length + PLANT_GEN.length) + ' plantios reprovados');
})().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
