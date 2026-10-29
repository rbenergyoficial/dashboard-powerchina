'use strict';
/*
 * ensaio-alarme-circuito.js — a regra do circuito aberto / sem tensão (lib-alarme-circuito.js).
 *
 * Lê do contêiner `dados` (lib-le-dados: DADOS_SAS no job) o hist/way2_<dia>.json de 4 dias FIXOS e recorta as janelas aqui. Dia fixo
 * que sumiu (404) REPROVA: o ensaio não pula. O ESPERADO vem de fora da lib: o registro de campo (14T2 aberto pelo
 * SEP às 14:10:36 de 21/09/2026), a tabela de alarmes do supervisório (CUB10_2 ABERTO às 06:23:08 de 27/10/2026) e a lista de
 * circuitos de cada trafo, escrita aqui à mão.
 *   1. 21/09 13:30–15:30: o 04T2 sem tensão é PAI dos 11 circuitos dele (e só deles); instante estimado a ±60 s do campo; nenhum aberto;
 *   2. 21/09 01:00–04:00 (noite) e 01/01/2026 09:00–11:10 (corte a zero): NENHUM evento;
 *   3. 27/10 05:30–09:00: M7C1 e M9C1 abertos (barra viva), fim 08:25, instante a ±60 s do supervisório;
 *   3b. 27/10 16:40–23:40: a manobra programada da barra 4 (disjuntores de M7C1, M8C1–C3 e M9C1 abertos de 17:10:44 a 17:11:15 no
 *      supervisório, sem proteção atuada): os 5 abertos, barra viva, início 17:15 (1º slot inteiro em zero; o das 17:10–17:15 é o
 *      parcial), em curso no fim do arquivo do dia, e nenhum outro;
 *   4. 29/01/2026 00:00–05:30: 04T2 sem tensão até 03:40; M8C1 ABERTO 03:45–04:20 (o disjuntor fechou depois dos outros na
 *      reenergização) e NÃO aberto de 04:25 em diante (0,1–0,3 A, −10 kvar: rede aberta a jusante com o disjuntor fechado);
 *   5. forjados: um slot só de zero não abre episódio; buraco no meio não parte; qualidade ≠ 0 não conta; uma fase em zero não é aberto;
 *      a virada do dia: o aberto da véspera CONTINUA (mesmo id, basta 1 slot, mesmo com o 1º slot de hoje sem dado) ou FECHA (mesmo id,
 *      fim = borda esquerda do 1º slot válido); a fusão SUBSTITUI a janela recalculada (sem duplicata quando o início muda).
 * Depois PLANTA defeitos numa cópia da lib e exige que cada um reprove.
 * uso: DADOS_SAS=… node scripts/ensaio-alarme-circuito.js   (sai 1 se algo falhar)
 *      node scripts/ensaio-alarme-circuito.js --forjados   (sem rede: só os forjados da lib real, sem plantios; é o que roda no job de
 *      5 min antes do gerador. Os 4 dias reais custam ~16 MB de saída do storage: eles e os plantios rodam no ensaios.yml, a cada push)
 */
const fs = require('fs'), os = require('os'), path = require('path');
const LD = require('./lib-le-dados');

const LIB = path.join(__dirname, 'lib-alarme-circuito.js');
const TODOS = []; for (let p = 6196; p <= 6219; p++) TODOS.push(p);
const CASOS = {   // janela pela borda direita do slot, hora local
  abertura_14T2_sep: ['2026-09-21', TODOS, '13:30', '15:30'],
  noite_normal: ['2026-09-21', TODOS, '01:00', '04:00'],
  aberto_M7C1_M9C1: ['2026-10-27', [6215, 6219, 6216, 6218, 6197], '05:30', '09:00'],
  manobra_B4: ['2026-10-27', TODOS, '16:40', '23:40'],
  corte_a_zero: ['2026-01-01', TODOS, '09:00', '11:10'],
  m8c1_rede_aberta_jusante: ['2026-01-29', [6216, 6217, 6218, 6219, 6215, 6197, 6196], '00:00', '05:30'],
};

// esperado escrito à mão (não lido da lib)
const DO_04T2 = ['M3C1', 'M3C2', 'M3C3', 'M4C1', 'M4C2', 'M4C3', 'M7C1', 'M8C1', 'M8C2', 'M8C3', 'M9C1'];
const CAMPO_14T2 = Date.parse('2026-09-21T14:10:36-03:00');
const E3_CUB10_2 = Date.parse('2026-10-27T06:23:08-03:00');
const ms = (s) => Date.parse(String(s).slice(0, 19) + '-03:00');

async function carrega() {
  const dias = {}, fx = {};
  for (const [nome, [dia, pontos, de, ate]] of Object.entries(CASOS)) {
    if (!dias[dia]) {
      const j = await LD.json(LD.BASE + 'hist/way2_' + dia + '.json');
      if (!j || !Array.isArray(j.dados)) throw new Error('o arquivo do medidor de ' + dia + ' não existe mais (dia fixo do ensaio): reprova');
      dias[dia] = j.dados;
    }
    fx[nome] = dias[dia].filter((s) => pontos.includes(s.pontoId)).map((s) => ({ pontoId: s.pontoId, nomeGrandeza: s.nomeGrandeza,
      valores: (s.valores || []).filter((v) => v.data.slice(0, 10) === dia && v.data.slice(11, 16) >= de && v.data.slice(11, 16) <= ate) }));
    const n = fx[nome].reduce((a, s) => a + s.valores.length, 0);
    if (n < 100) throw new Error('recorte ' + nome + ' com só ' + n + ' valores: o dia fixo mudou de forma');
  }
  return fx;
}

// forjados no formato cru da Way2
function forja(pid, linhas, dia = '2026-10-28') {   // linhas: [hh:mm, P, Q, I, V(fase-neutro), qualidade?]
  const g = { Demat: 1, Demre: 2, CorrenteA: 3, CorrenteB: 3, CorrenteC: 3, TensaoA: 4, TensaoB: 4, TensaoC: 4 };
  return Object.entries(g).map(([nome, k]) => ({ pontoId: pid, nomeGrandeza: nome,
    valores: linhas.map((l) => ({ data: dia + 'T' + l[0] + ':00', valor: l[k], qualidade: l[5] || 0 })) }));
}
const VIVA = 19900, CHEIO = [5000, 300, 90], ZERO = [0, 0, 0];

function casos(A, FX) {
  const f = [];
  const C = (nome, ok, det) => { if (!ok) f.push(nome + (det ? ' · ' + det : '')); };
  const det = (nome, op) => A.detecta(FX[nome], op);

  if (FX) {   // os dias reais (fora no --forjados)
  // 1 · 21/09
  const e1 = det('abertura_14T2_sep');
  const tr = e1.filter((e) => e.regra === 'trafo_sem_tensao');
  C('21/09: um trafo sem tensão, o 04T2', tr.length === 1 && tr[0].tag === '04T2', JSON.stringify(tr.map((e) => e.tag)));
  const filhos = tr.length ? tr[0].filhos.map((id) => e1.find((e) => e.id === id).tag).sort() : [];
  C('21/09: filhos = os 11 circuitos do 04T2', JSON.stringify(filhos) === JSON.stringify([...DO_04T2].sort()), filhos.join(','));
  C('21/09: nenhum circuito do 04T1 nem aberto', !e1.some((e) => e.regra === 'cto_aberto' || (e.regra.startsWith('cto') && !DO_04T2.includes(e.tag))));
  C('21/09: instante estimado a ±60 s do campo', tr.length && tr[0].ini_est && Math.abs(ms(tr[0].ini_est) - CAMPO_14T2) <= 60000, tr.length && tr[0].ini_est);
  C('21/09: o trafo volta (fim preenchido)', tr.length && tr[0].fim !== null);

  // 2 · noite e corte
  C('noite 21/09: nenhum evento', det('noite_normal').length === 0, det('noite_normal').map((e) => e.regra + ':' + e.tag).join(','));
  C('corte 01/01: nenhum evento', det('corte_a_zero').length === 0, det('corte_a_zero').map((e) => e.regra + ':' + e.tag).join(','));

  // 3 · 27/10
  const e3 = det('aberto_M7C1_M9C1');
  for (const tag of ['M7C1', 'M9C1']) {
    const e = e3.find((x) => x.regra === 'cto_aberto' && x.tag === tag);
    C('27/10: ' + tag + ' aberto', !!e);
    if (!e) continue;
    C('27/10: ' + tag + ' fim 08:25', e.fim === '2026-10-27T08:25:00', e.fim);
    C('27/10: ' + tag + ' instante a ±60 s do supervisório', e.ini_est && Math.abs(ms(e.ini_est) - E3_CUB10_2) <= 60000, e.ini_est);
    C('27/10: ' + tag + ' barra viva (~34,5 kV)', e.ev && e.ev.v_kv > 30 && e.ev.v_kv < 38, e.ev && e.ev.v_kv);
  }
  C('27/10: só esses dois', e3.length === 2, e3.map((e) => e.regra + ':' + e.tag).join(','));

  // 3b · 27/10 à tarde: a manobra programada da barra 4
  const eb = det('manobra_B4');
  const B4 = ['M7C1', 'M8C1', 'M8C2', 'M8C3', 'M9C1'];
  C('27/10 tarde: os 5 da barra 4 abertos, e só eles', JSON.stringify(eb.filter((e) => e.regra === 'cto_aberto').map((e) => e.tag).sort()) === JSON.stringify(B4)
    && eb.length === 5, eb.map((e) => e.regra + ':' + e.tag).join(','));
  C('27/10 tarde: início 17:15 e em curso no fim do arquivo', eb.length === 5 && eb.every((e) => e.ini === '2026-10-27T17:15:00' && e.fim === null),
    eb.map((e) => e.tag + ' ' + e.ini + '→' + e.fim).join(','));
  C('27/10 tarde: barra viva', eb.every((e) => e.ev && e.ev.v_kv > 30 && e.ev.v_kv < 38), eb.map((e) => e.ev && e.ev.v_kv).join(','));

  // 4 · 29/01
  const e4 = det('m8c1_rede_aberta_jusante');
  const ab = e4.filter((e) => e.regra === 'cto_aberto' && e.tag === 'M8C1');
  C('29/01: M8C1 aberto uma vez, 03:45–04:20', ab.length === 1 && ab[0].ini === '2026-01-29T03:45:00' && ab[0].fim === '2026-01-29T04:20:00',
    ab.map((e) => e.ini + '→' + e.fim).join(','));
  C('29/01: nada de M8C1 depois das 04:25 (rede aberta a jusante)', !e4.some((e) => e.tag === 'M8C1' && ms(e.ini) >= ms('2026-01-29T04:20:00')));
  C('29/01: 04T2 sem tensão até 03:40', e4.some((e) => e.regra === 'trafo_sem_tensao' && e.tag === '04T2' && e.fim === '2026-01-29T03:40:00'));
  }

  // 5 · forjados
  const um = A.detecta(forja(6215, [['10:00', ...CHEIO, VIVA], ['10:05', ...ZERO, VIVA], ['10:10', ...CHEIO, VIVA], ['10:15', ...CHEIO, VIVA]]));
  C('forjado: um slot só de zero não abre episódio', um.length === 0, um.map((e) => e.ini).join(','));
  const buraco = A.detecta(forja(6215, [['10:00', ...CHEIO, VIVA], ['10:05', ...ZERO, VIVA], ['10:10', ...ZERO, VIVA], ['10:15', ...ZERO, VIVA, 1],
    ['10:20', ...ZERO, VIVA], ['10:25', ...CHEIO, VIVA]]));
  C('forjado: buraco no meio não parte o episódio', buraco.length === 1 && buraco[0].fim === '2026-10-28T10:20:00' && buraco[0].slots === 3,
    buraco.map((e) => e.ini + '→' + e.fim + '/' + e.slots).join(','));
  const umaFase = (s) => (s.nomeGrandeza === 'CorrenteB' || s.nomeGrandeza === 'CorrenteC'
    ? { ...s, valores: s.valores.map((v) => (v.valor === 0 ? { ...v, valor: 0.6 } : v)) } : s);   // Ia fica em 0, Ib e Ic a 0,6 A
  const fase = A.detecta(forja(6215, [['10:00', ...CHEIO, VIVA], ['10:05', 0.1, 0.2, 0, VIVA], ['10:10', 0.1, 0.2, 0, VIVA], ['10:15', ...CHEIO, VIVA]]).map(umaFase));
  C('forjado: uma fase em zero e as outras com 0,6 A não é aberto', fase.length === 0, fase.map((e) => e.regra + ' ' + e.ini).join(','));
  const prov = A.detecta(forja(6215, [['10:00', ...CHEIO, VIVA], ['10:05', ...ZERO, VIVA, 2], ['10:10', ...ZERO, VIVA, 2], ['10:15', ...ZERO, VIVA, 2]]));
  C('forjado: qualidade 2 (provisório) não conta', prov.length === 0);
  const fim = A.detecta(forja(6215, [['10:00', ...CHEIO, VIVA], ['10:05', ...ZERO, VIVA], ['10:10', ...ZERO, VIVA]]));
  C('forjado: ainda aberto no último slot → fim null', fim.length === 1 && fim[0].fim === null);

  // a virada do dia: o publicado traz o M7C1 aberto desde 23:40 de ontem, sem fim
  const aberto = { id: 'cto_aberto:M7C1:2026-10-27T23:40:00', regra: 'cto_aberto', tag: 'M7C1', ini: '2026-10-27T23:40:00', fim: null, slots: 4 };
  const virada = (linhas) => A.detecta(forja(6215, linhas), { abertos: [aberto] });
  const cont = virada([['00:05', ...ZERO, VIVA], ['00:10', ...ZERO, VIVA], ['00:15', ...CHEIO, VIVA]]);
  C('virada: continua com o mesmo id e ini', cont.length === 1 && cont[0].id === aberto.id && cont[0].ini === aberto.ini
    && cont[0].fim === '2026-10-28T00:10:00' && cont[0].slots === 2, JSON.stringify(cont[0] || null));
  const fechou = virada([['00:05', ...CHEIO, VIVA], ['00:10', ...CHEIO, VIVA]]);
  C('virada: fecha no 1º slot de hoje (mesmo id, fim 00:00)', fechou.length === 1 && fechou[0].id === aberto.id && fechou[0].fim === '2026-10-28T00:00:00',
    JSON.stringify(fechou));
  const umSlot = virada([['00:05', ...ZERO, VIVA], ['00:10', ...CHEIO, VIVA]]);
  C('virada: a continuação basta com 1 slot', umSlot.length === 1 && umSlot[0].id === aberto.id && umSlot[0].fim === '2026-10-28T00:05:00', JSON.stringify(umSlot));
  const furo = virada([['00:05', ...ZERO, VIVA, 2], ['00:10', ...ZERO, VIVA], ['00:15', ...CHEIO, VIVA]]);
  C('virada: 1º slot de hoje sem dado, continua pelo 1º válido', furo.length === 1 && furo[0].id === aberto.id && furo[0].fim === '2026-10-28T00:10:00',
    JSON.stringify(furo));
  const nada = virada([['00:05', ...ZERO, VIVA, 2]]);
  C('virada: sem slot válido hoje, não decide (nada sai)', nada.length === 0, JSON.stringify(nada));

  // a fusão: os anteriores ficam, a janela recalculada substitui, a publicação poda o que terminou antes
  const pub = [{ id: 'a', ini: '2026-10-20T10:00:00', fim: '2026-10-20T11:00:00', v: 1 }, { id: 'b', ini: '2026-10-27T10:00:00', fim: '2026-10-27T11:00:00', v: 1 },
    { id: 'c', ini: '2026-10-19T10:00:00', fim: null, v: 1 }, { id: 'x:10:10', ini: '2026-10-28T10:10:00', fim: null, v: 1 }];
  const fu = A.funde(pub, [{ id: 'x:10:05', ini: '2026-10-28T10:05:00', fim: null, v: 2 }], ms('2026-10-21T00:00:00'), ms('2026-10-28T00:00:00'));
  C('funde: o início que mudou não deixa duplicata; poda o que terminou antes da janela; o aberto fica',
    JSON.stringify(fu.map((e) => e.id + '/' + e.v)) === JSON.stringify(['c/1', 'b/1', 'x:10:05/2']), JSON.stringify(fu.map((e) => e.id + '/' + e.v)));
  return f;
}

(async () => {
  if (process.argv.includes('--forjados')) {
    const f = casos(require(LIB), null);
    if (f.length) { console.log('🔴 a lib real reprova nos forjados:'); f.forEach((x) => console.log('  - ' + x)); process.exit(1); }
    console.log('✅ lib real: os forjados passam (os dias reais e os plantios rodam no ensaios.yml)'); return;
  }
  const FX = await carrega();
  const reais = casos(require(LIB), FX);
  if (reais.length) { console.log('🔴 a lib real reprova:'); reais.forEach((x) => console.log('  - ' + x)); process.exit(1); }
  console.log('✅ lib real: todos os casos passam');

  const SRC = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
  const PLANTIOS = [
    ['regra só por P≈0 (acusa a noite e o corte)', 'const zero = Math.abs(s.P) < L.P_KW && Math.abs(s.Q) < L.Q_KVAR && Math.max(s.Ia, s.Ib, s.Ic) < L.I_A;', 'const zero = Math.abs(s.P) < L.P_KW;'],
    ['1 slot em vez de 2', 'SLOTS_MIN: 2,', 'SLOTS_MIN: 1,'],
    ['sem a tensão (barra morta vira aberto)', "return s.V > L.V_PU_MIN * vNom ? 'aberto' : 'sem_tensao';", "return 'aberto';"],
    ['buraco fecha o episódio', 'if (st === null) continue;', 'if (st === null) { if (cur) fecha(run[run.length - 1].t); continue; }'],
    ['ignora a qualidade', 'if (v.qualidade !== 0 || ', 'if ('],
    ['não continua o aberto da véspera', 'if (a.regra === pre + estados[k0]) continua = a;', 'if (false) continua = a;'],
    ['o aberto que fecha na virada fica aberto', 'ev.push({ ...resto, fim: isoBRT(slots[k0].t - L.SLOT_MS) });', 'void resto;'],
    ['a continuação exige 2 slots', 'run.length >= (cont ? 1 : L.SLOTS_MIN)', 'run.length >= L.SLOTS_MIN'],
    ['o 1º slot de hoje mesmo sem dado', 'const k0 = estados.findIndex((st) => st !== null);', 'const k0 = slots.length ? 0 : -1;'],
    ['a fusão só por id (duplicata)', 'if (msBRT(e.ini) < janelaIniMs) m.set(e.id, e);', 'm.set(e.id, e);'],
    ['circuitos do M4 e do M5 trocados', 'M4: [6206, 6207, 6208],\n  M5: [6209, 6210, 6211],', 'M4: [6209, 6210, 6211],\n  M5: [6206, 6207, 6208],'],
    ['mínima das fases no lugar da máxima', 'Math.max(s.Ia, s.Ib, s.Ic) < L.I_A', 'Math.min(s.Ia, s.Ib, s.Ic) < L.I_A'],
    ['instante pelo fim do slot parcial', 'par.t - L.SLOT_MS + Math.round((par.P / ant.P) * L.SLOT_MS)', 'par.t'],
  ];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-alarme-'));
  let ruim = 0;
  try {
    PLANTIOS.forEach(([nome, de, para], k) => {
      if (!SRC.includes(de)) { console.log('🔴 PLANTIO INVÁLIDO (trecho não achado): ' + nome); ruim++; return; }
      const arq = path.join(tmp, 'lib-' + k + '.js');
      fs.writeFileSync(arq, SRC.replace(de, para));
      let f; try { f = casos(require(arq), FX); } catch (e) { f = ['estourou: ' + e.message]; }
      if (f.length) console.log('  ✅ reprovado: ' + nome + ' (' + f[0] + ')');
      else { console.log('  🔴 PASSOU SEM SER PEGO: ' + nome); ruim++; }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  if (ruim) { console.log('🔴 ensaio falhou: ' + ruim + ' plantio(s)'); process.exit(1); }
  console.log('✅ ensaio limpo: ' + PLANTIOS.length + ' plantios reprovados');
})().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
