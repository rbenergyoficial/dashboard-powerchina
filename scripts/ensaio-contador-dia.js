/*
 * ensaio-contador-dia.js — prova a energia do dia de cada inversor (lib-contador-dia.js).
 *
 * A energia do dia e a SUBIDA do contador de vida (`ENERGIA TOTAL GERADA`), somada degrau a degrau. O contador diario
 * guarda o valor de ontem ate o inversor acordar (26/09/2026: o dia saiu com a energia de 25/09 na frota inteira),
 * zera de novo no religamento, zera a tarde, e e trocado junto com o inversor.
 *
 * 1 · a regra contra NOVE series REAIS do export (ensaio-contador-dia.casos.json), uma por modo de falhar achado no
 *     bruto de 30/08 a 29/09. O esperado de cada uma e a soma dos SEGMENTOS DO CONTADOR DIARIO lidos na serie — o
 *     outro registro do inversor, nao o que a regra usa. Cada caso tambem reprova pelo menos uma das regras
 *     descartadas (o maior valor do diario; o maior valor dele depois da ultima queda da manha): caso em que todas
 *     acertam nao prova nada. Mais os casos forjados: inversor morto o dia todo, sem leitura, carimbo so com a hora.
 * 2 · o gen-inv-scada de ponta a ponta: o dia 26/09 SUJO (zero preenchido antes da primeira leitura, valor de ontem no
 *     diario, um inversor trocado a tarde) contra o mesmo dia LIMPO. A energia e a de hoje, e o detalhe de meia hora
 *     e IDENTICO ao do dia limpo (nem linha a mais na madrugada, nem manha perdida).
 * 3 · o gen-perdas: o trecho do fonte que soma o contador do conjunto e EXECUTADO sobre inversores forjados.
 *
 * Nao toca rede nem blob. uso: node scripts/ensaio-contador-dia.js [inv-scada|perdas]  (sem argumento, tudo)
 * 🔴 Folga 0,005 kWh: os contadores tem duas casas, e a soma de diferencas de numeros de duas casas so erra no
 *    ponto flutuante (1e-9); meia unidade da segunda casa e o maior erro honesto.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { energiaDoDia, passosDoDia } = require('./lib-contador-dia.js');

const PARTE = process.argv[2] || 'tudo';
const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const perto = (a, b) => a != null && b != null && Math.abs(a - b) <= 0.005;
const CASOS = JSON.parse(fs.readFileSync(path.join(__dirname, 'ensaio-contador-dia.casos.json'), 'utf8'));

// as regras DESCARTADAS, para provar que cada caso discrimina
const maiorDoDia = (v) => { const x = v.filter((y) => y != null); return x.length ? Math.max(...x) : null; };
const depoisDaQuedaDaManha = (v, h) => { let k = 0, a = null;
  v.forEach((x, i) => { if (x == null) return; if (a != null && x < a && h[i] < '12:00') k = i; a = x; });
  return maiorDoDia(v.slice(k)); };
const soVida = (c) => { const p = passosDoDia(c.vida, c.h); return p ? p.reduce((a, x) => a + x.e, 0) : null; };   // sem o diario

console.log('1 · a regra, nas series reais');
// esperado = segmentos do contador DIARIO, lidos na serie de cada caso
const ESPERADO = {
  carga_de_ontem: [1128.60],          // M8/TS3/INV01 26/09: valor de ontem (2174,60) ate 03:30, zera 05:30, fecha 1128,60
  zeragem_a_tarde: [0.10],            // M1/TS5/INV14 26/09: congelado em 2034,9 desde 25/09, zera 16:00, fecha 0,10
  queda_que_volta: [2029.00],         // M5/TS1/INV03 21/09: o export afunda as 07:30 e o contador volta
  religa_manha: [96.30, 710.20],      // M4/TS3/INV03 18/09: desarma 08:30, religa 10:30
  religa_tarde: [758.80, 38.20],      // M8/TS1/INV05 17/09: desarma 15:00, religa
  troca_tarde: [281.70, 288.70],      // M3/TS2/INV20 18/09: o velho para 11:30, o novo gera a partir de 15:30
  troca_fim_do_dia: [495.70, 6.00],   // M5/TS7/INV03 31/08: o novo entra as 17:00
  troca_manha: [358.11, 1563.80],     // M6/TS6/INV05 17/09: o novo entra as 09:30
  entra_a_tarde: [532.30],            // M9/TS1/INV05 18/09: a coleta comeca as 14:00
};
let discrMaior = 0, discrQueda = 0;
for (const [nome, segs] of Object.entries(ESPERADO)) {
  const c = CASOS[nome];
  const esp = segs.reduce((a, b) => a + b, 0);
  const e = energiaDoDia(c.vida, c.h, c.diaria);
  const m = maiorDoDia(c.diaria), q = depoisDaQuedaDaManha(c.diaria, c.h), sv = soVida(c);
  if (!perto(m, esp)) discrMaior++;
  if (!perto(q, esp)) discrQueda++;
  // a queda que volta nao discrimina na energia (o contador volta), e sim no DETALHE: ver a conferencia da manha abaixo
  const discr = nome === 'queda_que_volta' || !perto(m, esp) || !perto(q, esp) || !perto(sv, esp);
  ok(perto(e, esp) && discr, nome.padEnd(17) + c.onde + ': ' + (e == null ? 'nulo' : +e.toFixed(3))
    + ' kWh, esperado ' + segs.join(' + ') + ' · descartadas: maior ' + m + ', depois da queda ' + q
    + ', so o de vida ' + (sv == null ? '-' : +sv.toFixed(2)));
}
ok(discrMaior >= 5 && discrQueda >= 5, 'as duas regras descartadas erram em varios casos (maior ' + discrMaior
  + ', depois da queda ' + discrQueda + ' de ' + Object.keys(ESPERADO).length + ')');
{ const c = CASOS.queda_que_volta, p = passosDoDia(c.vida, c.h);
  const manha = p.filter((x) => c.h[x.i] >= '05:30' && c.h[x.i] <= '07:00').reduce((a, x) => a + x.e, 0);
  const k = c.h.indexOf('07:30');   // a regra da ultima queda da manha comecava o dia ali e perdia a manha do eletrocentro
  ok(manha > 5 && c.diaria[k] < c.diaria[k - 1], 'a queda que volta (07:30) nao apaga a manha do detalhe: ' + manha.toFixed(2)
    + ' kWh entre 05:30 e 07:00'); }
{ const c = CASOS.carga_de_ontem, p = passosDoDia(c.vida, c.h).filter((x) => x.e > 0);
  ok(p.length > 0 && c.h[p[0].i] === '05:30', 'o primeiro degrau POSITIVO do dia e o do sol (' + (p.length ? c.h[p[0].i] : '-')
    + '); a madrugada so tem degrau zero'); }
const H = CASOS.carga_de_ontem.h;
const morto = H.map(() => 879184.2), mortoD = H.map(() => 2174.6);
ok(energiaDoDia(morto, H, mortoD) === 0, 'inversor que nao acorda (os dois contadores parados no valor de ontem): 0, nao o de ontem');
ok(energiaDoDia(H.map(() => null), H) === null && energiaDoDia([], []) === null && energiaDoDia(H.map(() => 0), H) === null,
  'sem leitura, ou so o zero do preenchimento: nulo');
{ const c = CASOS.carga_de_ontem;
  const comData = c.h.map((h) => '2026-09-26 ' + h + ':00'), soHora = c.h.map((h) => h + ':00');
  ok(perto(energiaDoDia(c.vida, comData, c.diaria), 1128.60) && perto(energiaDoDia(c.vida, soHora, c.diaria), 1128.60),
    'o carimbo vale com data ou so com a hora (HH:MM:SS)'); }
{ const c = CASOS.carga_de_ontem, v = c.vida.map((x, i) => (c.h[i] === '00:30' ? 0 : x));
  ok(perto(energiaDoDia(v, c.h, c.diaria), 1128.60), 'zero preenchido antes da primeira leitura nao vira energia'); }

// ---------- 2 · gen-inv-scada de ponta a ponta ----------
if (PARTE === 'tudo' || PARTE === 'inv-scada') {
  console.log('\n2 · gen-inv-scada: 26/09 sujo contra 26/09 limpo');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'contador-dia-'));
  const INVS = ['INV01', 'INV02', 'INV03', 'INV04', 'INV05', 'INV06'];
  const base = CASOS.carga_de_ontem;
  const fim25 = (i) => 2000 + 10 * i;
  const vida0 = (i) => 800000 + 1000 * i;
  // perfil de hoje: o diario real de 26/09 depois da zeragem, escalado por inversor
  const hoje = (i) => base.diaria.map((x, k) => (k < 11 || x == null ? 0 : Math.round(x * (1 + i / 100) * 100) / 100));
  const fimHoje = (i) => Math.max(...hoje(i));
  const r2 = (x) => Math.round(x * 100) / 100;
  function dia25(i) { const d = base.h.map((h, k) => (k < 11 ? 0 : r2(fim25(i) * Math.min(1, (k - 10) / 25))));
    return { diaria: d, vida: d.map((x) => r2(vida0(i) + x)) }; }
  function dia26(i, sujo) {
    if (i === 5) {   // INV06: a troca real de 18/09 (velho 281,70 + novo 288,70)
      const t = CASOS.troca_tarde; return { diaria: t.diaria, vida: t.vida }; }
    const d = hoje(i), v = d.map((x) => r2(vida0(i) + fim25(i) + x));
    if (!sujo) return { diaria: d, vida: v };
    // valor de ontem e rampa do export no diario, com o zero preenchido as 00:30 antes dele (degrau falso de ~2000 kWh)
    const ds = base.diaria.map((x, k) => (k === 1 ? 0 : k < 8 ? fim25(i) : k < 11 ? x : d[k]));
    const vs = v.map((x, k) => (k === 1 ? 0 : x));                                    // zero preenchido as 00:30
    return { diaria: ds, vida: vs };
  }
  function csv(dia, serie) {
    const cols = ['Tempo'];
    for (const iv of INVS) for (const g of ['ENERGIA DIÁRIA GERADA', 'ENERGIA TOTAL GERADA']) cols.push('UFV_MRT02_TS1_' + iv + '_MRT02 TS1 ' + iv + ' ' + g);
    const s = INVS.map((iv, i) => serie(i));
    const cel = (x) => (x == null ? '' : String(x).replace('.', ','));
    return cols.join(';') + '\n' + base.h.map((h, k) => [dia + ' ' + h + ':00']
      .concat(...s.map((o) => [cel(o.diaria[k]), cel(o.vida[k])])).join(';')).join('\n') + '\n';
  }
  function roda(sujo) {
    const ent = path.join(raiz, sujo ? 'sujo' : 'limpo'), sai = path.join(raiz, (sujo ? 'sujo' : 'limpo') + '_out');
    fs.mkdirSync(ent); fs.mkdirSync(sai);
    fs.writeFileSync(path.join(ent, 'M02_20260926_034000.csv'), csv('2026-09-25', dia25));
    fs.writeFileSync(path.join(ent, 'M02_20260927_034000.csv'), csv('2026-09-26', (i) => dia26(i, sujo)));
    const env = Object.assign({}, process.env, { LOCAL_DIR: ent, LOCAL_OUT_DIR: sai, DIAS: '400' });
    delete env.LOCAL_OUT;
    execFileSync('node', [path.join(__dirname, 'gen-inv-scada.js')], { env, encoding: 'utf8' });
    const le = (n) => { let b = fs.readFileSync(path.join(sai, n)); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
      return JSON.parse(b.toString('utf8')); };
    return { hist: le('inv_scada_hist.json').serie, hora: le('inv_scada_hora.json').serie_hora };
  }
  const S = roda(true), L = roda(false);
  const d26 = S.hist.filter((l) => l.dia === '2026-09-26');
  ok(d26.length === 6 && S.hist.filter((l) => l.dia === '2026-09-25').length === 6, 'historico com os 6 inversores nos dois dias');
  const esp = (inv) => (inv === 'INV06' ? 570.40 : fimHoje(INVS.indexOf(inv)));
  ok(d26.every((l) => perto(l.kwh, esp(l.inv))), '26/09 publica a energia de HOJE: ' + d26.map((l) => l.inv + ' ' + l.kwh).join(' · '));
  ok(d26.every((l) => l.inv === 'INV06' || l.kwh < fim25(INVS.indexOf(l.inv))), '... e nenhum inversor com o valor de ontem');
  const chave = (l) => l.dia + '|' + l.ms + '|' + l.inv + '|' + l.kwh + '|' + l.razao;
  const hs = S.hora.filter((l) => l.dia === '2026-09-26').map(chave).sort(), hl = L.hora.filter((l) => l.dia === '2026-09-26').map(chave).sort();
  const hh = (k) => new Date(Number(k.split('|')[1]) - 3 * 3600e3).toISOString().slice(11, 16);
  ok(hs.length > 0 && hs.length === hl.length && hs.every((k, i) => k === hl[i]),
    'detalhe de meia hora do dia sujo IDENTICO ao do limpo: ' + hs.length + ' linhas, ' + (hs.length ? hh(hs.slice().sort((a, b) => hh(a) < hh(b) ? -1 : 1)[0]) : '-')
    + ' a primeira (limpo: ' + hl.length + ')');
  fs.rmSync(raiz, { recursive: true, force: true });
}

// ---------- 3 · gen-perdas: o trecho do fonte, executado ----------
if (PARTE === 'tudo' || PARTE === 'perdas') {
  console.log('\n3 · gen-perdas: o contador do conjunto');
  const src = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = src.indexOf('let e_conta = 0, comConta = 0;'), b = src.indexOf('if (!diario.has(a.dia))', a);
  ok(a > 0 && b > a, 'trecho do contador do conjunto achado no fonte (' + (b - a) + ' caracteres)');
  if (a > 0 && b > a) {
    const regra = new Function('d', 'energiaDoDia', src.slice(a, b) + '\nreturn { e_conta, comConta };');
    const c1 = CASOS.carga_de_ontem, c2 = CASOS.troca_tarde, c3 = CASOS.religa_tarde;
    const inv = new Map([['a', { serie: { e_vida: c1.vida, e_conta: c1.diaria } }], ['b', { serie: { e_vida: c2.vida, e_conta: c2.diaria } }],
      ['c', { serie: { e_vida: c3.vida, e_conta: c3.diaria } }], ['d', { serie: { e_vida: c1.h.map(() => null), e_conta: c1.diaria } }]]);
    const r = regra({ inv, instantes: c1.h.map((h) => '2026-09-26 ' + h + ':00') }, energiaDoDia);
    ok(perto(r.e_conta, 1128.60 + 570.40 + 797.00) && r.comConta === 3, 'soma da energia de HOJE de cada inversor: '
      + (+r.e_conta.toFixed(3)) + ' kWh em ' + r.comConta + ' inversores (esperado 2496,00 em 3; o maior valor do dia daria '
      + (2174.60 + 288.70 + 758.80 + 2174.60).toFixed(2) + ')');
  }
}

console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-contador-dia: tudo ok');
process.exit(falhas.length ? 1 : 0);
