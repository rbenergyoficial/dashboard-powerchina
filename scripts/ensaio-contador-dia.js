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
  queda_fim_da_tarde: [1554.60],      // M2/TS3/INV03 05/09: os dois contadores descem 0,1 kWh as 18:30 e ficam
  // logger Sungrow, 5 min: o contador de vida PARA de 11:45 a 12:35 gerando 201 kW e volta com +186,5 kWh. O esperado e
  // o export do SCADA no mesmo inversor e dia (2181,9) — a outra fonte, nao o contador que a regra usa
  congelado_e_salto: [2181.90],
};
// casos que nao discriminam na ENERGIA e provam outra coisa: a queda que volta, o DETALHE (conferencia da manha abaixo);
// a queda das 18:30, que nao e troca (a queda sem volta mais comum do bruto, 29 de 43), as guardas da troca (forjados);
// o congelado e salto, a hora do teto (o plantio que deixa a leitura parada mover a hora reprova so ele)
const SO_REGRESSAO = ['queda_que_volta', 'queda_fim_da_tarde', 'congelado_e_salto'];
let discrMaior = 0, discrQueda = 0;
for (const [nome, segs] of Object.entries(ESPERADO)) {
  const c = CASOS[nome];
  const esp = segs.reduce((a, b) => a + b, 0);
  const e = energiaDoDia(c.vida, c.h, c.diaria);
  const m = maiorDoDia(c.diaria), q = depoisDaQuedaDaManha(c.diaria, c.h), sv = soVida(c);
  if (!perto(m, esp)) discrMaior++;
  if (!perto(q, esp)) discrQueda++;
  const discr = SO_REGRESSAO.includes(nome) || !perto(m, esp) || !perto(q, esp) || !perto(sv, esp);
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

console.log('\n1b · as guardas, em casos forjados sobre series reais');
// o COMPLEMENTO do diario (quem entra na coleta depois do sol) nao pode trazer o valor de ontem
const corta = (c, ate) => { const k = c.h.indexOf(ate); const nul = (s) => s.map((x, i) => (i < k ? null : x));
  return { h: c.h, vida: nul(c.vida), diaria: nul(c.diaria) }; };
for (const ate of ['11:00', '12:00', '14:30']) {
  const c = corta(CASOS.zeragem_a_tarde, ate), e = energiaDoDia(c.vida, c.h, c.diaria);
  ok(perto(e, 0.10), 'congelado no valor de ontem e entrando na coleta as ' + ate + ': ' + (e == null ? 'nulo' : +e.toFixed(2))
    + ' kWh (esperado 0,10; o diario do primeiro instante e ' + c.diaria[c.h.indexOf(ate)] + ')');
}
{ const k = H.indexOf('13:00'), v = H.map((x, i) => (i < k ? null : 879184.2 + (i > k ? 0.01 : 0))), dd = H.map((x, i) => (i < k ? null : 2174.6));
  const e = energiaDoDia(v, H, dd);
  ok(perto(e, 0.01), 'parado no valor de ontem, entrando as 13:00, contador de vida com 0,01 de ruido: '
    + (+e.toFixed(2)) + ' kWh (o diario parado nao sobe: nada entra)'); }
{ const k = H.indexOf('10:00'), k2 = H.indexOf('10:30');   // sobra pequena de ontem no diario, zera as 10:30
  const dd = H.map((x, i) => (i < k ? null : i === k ? 5 : Math.min(1000, (i - k2) * 50)));
  const v = H.map((x, i) => (i < k ? null : 879000 + Math.min(1000, Math.max(0, (i - k2) * 50))));
  const e = energiaDoDia(v, H, dd);
  ok(perto(e, 1000), 'entra as 10:00 com 5 kWh de ontem no diario, que zera as 10:30: ' + (+e.toFixed(2))
    + ' kWh (o diario nao subiu antes de cair: os 5 kWh nao entram)'); }
{ const c = CASOS.entra_a_tarde, k = c.h.indexOf('17:00');   // entra a tarde e DESARMA as 17:00: o diario zera e religa
  const dd = c.diaria.map((x, i) => (x == null || i < k ? x : Math.round((x - 524.89 + 0.5) * 100) / 100));
  const e = energiaDoDia(c.vida, c.h, dd);
  ok(perto(e, 532.30), 'entra a tarde e o diario zera as 17:00 depois de subir: ' + (+e.toFixed(2))
    + ' kWh (o desarme nao apaga a manha)'); }
{ const k = H.indexOf('14:00');   // diario que nao zerasse: 4500 de ontem + 500 da manha as 14:00
  const dd = H.map((x, i) => (i < k ? null : 5000 + Math.min(200, (i - k) * 20)));
  const v = H.map((x, i) => (i < k ? null : 879000 + Math.min(200, (i - k) * 20)));
  const e = energiaDoDia(v, H, dd);
  ok(perto(e, 200), 'diario com 5000 kWh as 14:00, acima do teto desde o sol: ' + (+e.toFixed(2)) + ' kWh (nao entra)'); }
{ const c = CASOS.entra_a_tarde, k = c.h.indexOf('18:30');   // a queda de 0,1 kWh das 18:30 nos dois contadores
  const menos = (s) => s.map((x, i) => (x == null || i < k ? x : Math.round((x - 0.1) * 100) / 100));
  const e = energiaDoDia(menos(c.vida), c.h, menos(c.diaria));
  ok(perto(e, 532.30), 'entra a tarde e os dois contadores descem 0,1 kWh as 18:30: ' + (+e.toFixed(2))
    + ' kWh (0,1 kWh nao e zeragem: o diario ainda cobre a manha)'); }
// a TROCA so com o fundo igual ao diario do mesmo instante, maior que zero e dentro do teto
{ const c = CASOS.carga_de_ontem, k = c.h.indexOf('09:00');   // o export escreve zero nos dois as 09:00 e volta
  const z = (s) => s.map((x, i) => (i === k ? 0 : x));
  const e = energiaDoDia(z(c.vida), c.h, z(c.diaria));
  ok(perto(e, 1128.60), 'zero do preenchimento nos dois contadores as 09:00: ' + (+e.toFixed(2)) + ' kWh (iguais, mas zero: nao e troca)'); }
{ const h = ['05:30', '07:30', '08:00', '09:00'];
  const e = energiaDoDia([9000, 9300, 2500, 2600], h, [0, 300, 2500, 2600]);
  ok(perto(e, 400), 'fundo igual ao diario mas 2500 kWh as 08:00, acima do teto desde o sol: ' + e + ' kWh (esperado 300 + 100)'); }
{ const c = CASOS.carga_de_ontem, k = c.h.indexOf('18:30');
  const hoje = c.diaria.map((x, i) => (i < 11 || x == null ? 0 : x));
  const dd = hoje.map((x, i) => Math.round((i >= k ? x - 0.1 : x) * 100) / 100);
  const vv = hoje.map((x, i) => Math.round((1563.80 + x - (i >= k ? 0.1 : 0)) * 100) / 100);   // trocado ontem: contador pequeno
  const e = energiaDoDia(vv, c.h, dd);
  ok(perto(e, 1128.60), 'inversor trocado ontem (contador de vida 1563,80) com a queda de 0,1 as 18:30: ' + (+e.toFixed(2))
    + ' kWh (o fundo cabe no teto, mas nao e o diario: nao e troca)'); }
{ const h = ['05:30', '08:00', '08:30', '09:00', '09:30', '10:00', '12:00'];
  const vv = [4200, 5000, 3500, 2000, 500, 30, 600], dd = [0, 800, 600, 400, 200, 30, 600];   // rampa nos dois ate o fundo
  const e = energiaDoDia(vv, h, dd);
  ok(perto(e, 800 + 30 + 570), 'troca num contador pequeno, com rampa de 3 pontos ate o fundo: ' + e
    + ' kWh (esperado 800 + 30 + 570; o ponto 500 as 09:30 cabe no teto e nao e o fundo)'); }
{ const h = ['10:00', '10:30', '11:00'];
  const e1 = energiaDoDia([5000, 5000 + 1.5 * 176, 5000 + 1.5 * 176 + 10], h), e2 = energiaDoDia([5000, 5000 + 175.9, 5000 + 185.9], h);
  ok(perto(e1, 10) && perto(e2, 185.9), 'teto de 352 kW em meia hora: salto de 1,5 x o teto rebaseia (' + (+e1.toFixed(2))
    + ' kWh), 175,9 kWh entram (' + (+e2.toFixed(2)) + ' kWh)'); }

// ---------- 2 · gen-inv-scada de ponta a ponta ----------
if (PARTE === 'tudo' || PARTE === 'inv-scada') {
  console.log('\n2 · gen-inv-scada: 26/09 sujo contra 26/09 limpo');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'contador-dia-'));
  const INVS = ['INV01', 'INV02', 'INV03', 'INV04', 'INV05', 'INV06', 'INV07'];
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
    if (i === 6) {   // INV07: entra na coleta as 14:00 (M9/TS1 de 18/09, 532,30): o diario cobre a manha
      const t = CASOS.entra_a_tarde; return { diaria: t.diaria, vida: t.vida }; }
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
  ok(d26.length === 7 && S.hist.filter((l) => l.dia === '2026-09-25').length === 7, 'historico com os 7 inversores nos dois dias');
  const esp = (inv) => (inv === 'INV06' ? 570.40 : inv === 'INV07' ? 532.30 : fimHoje(INVS.indexOf(inv)));
  ok(d26.every((l) => perto(l.kwh, esp(l.inv))), '26/09 publica a energia de HOJE: ' + d26.map((l) => l.inv + ' ' + l.kwh).join(' · '));
  ok(d26.every((l) => ['INV06', 'INV07'].includes(l.inv) || l.kwh < fim25(INVS.indexOf(l.inv))), '... e nenhum inversor com o valor de ontem');
  const t6 = S.hora.find((l) => l.dia === '2026-09-26' && l.inv === 'INV06' && new Date(l.ms - 3 * 3600e3).toISOString().slice(11, 16) === '15:30');
  ok(t6 && perto(t6.kwh, 79.48), 'no detalhe, a meia hora da troca do INV06 (15:30) tem a energia do inversor novo: '
    + (t6 ? t6.kwh : 'sem linha') + ' kWh (esperado 79,48)');
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
  const a = src.indexOf('let e_conta = 0, comConta = 0'), b = src.indexOf('if (!diario.has(a.dia))', a);
  ok(a > 0 && b > a, 'trecho do contador do conjunto achado no fonte (' + (b - a) + ' caracteres)');
  if (a > 0 && b > a) {
    const regra = new Function('d', 'a', 'energiaDoDia', src.slice(a, b) + '\nreturn { e_conta, comConta, semVida };');
    const c1 = CASOS.carga_de_ontem, c2 = CASOS.troca_tarde, c3 = CASOS.religa_tarde, c4 = CASOS.entra_a_tarde;
    const inv = new Map([['a', { serie: { e_vida: c1.vida, e_conta: c1.diaria } }], ['b', { serie: { e_vida: c2.vida, e_conta: c2.diaria } }],
      ['c', { serie: { e_vida: c3.vida, e_conta: c3.diaria } }], ['d', { serie: { e_vida: c1.h.map(() => null), e_conta: c1.diaria } }],
      ['e', { serie: { e_vida: c4.vida, e_conta: c4.diaria } }]]);
    const log = console.log, ditos = []; console.log = (m) => ditos.push(String(m));
    let r; try { r = regra({ inv, instantes: c1.h.map((h) => '2026-09-26 ' + h + ':00') }, { dia: '2026-09-26', ufv: 'MX' }, energiaDoDia); }
    finally { console.log = log; }
    ok(perto(r.e_conta, 1128.60 + 570.40 + 797.00 + 532.30) && r.comConta === 4, 'soma da energia de HOJE de cada inversor: '
      + (+r.e_conta.toFixed(3)) + ' kWh em ' + r.comConta + ' inversores (esperado 3028,30 em 4, com o que entra a tarde; o maior'
      + ' valor do dia daria ' + (2174.60 + 288.70 + 758.80 + 2174.60 + 532.30).toFixed(2) + ')');
    ok(r.semVida === 1 && ditos.some((m) => /SEM contador de vida/.test(m)), 'o inversor sem contador de vida sai da soma E e dito: '
      + (ditos[0] || '(nada dito)'));
  }
}

console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-contador-dia: tudo ok');
process.exit(falhas.length ? 1 : 0);
