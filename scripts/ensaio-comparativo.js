/*
 * ensaio-comparativo.js — confere o gen-comparativo SEM publicar nada.
 *
 * == POR QUE UM ENSAIO SEPARADO ==============================================================
 *
 * As tres conversoes deste gerador falham EM SILENCIO quando erram: unidade trocada desenha uma
 * curva plausivel, rotulo deslocado vira serrilha que parece ruido, e mapa de ponto errado produz
 * "o ONS mede 20% a mais que o medidor" — uma frase que soa a descoberta e e um defeito meu.
 *
 * Nenhuma dessas tres quebra o job. Por isso a verificacao nao pode ser "rodou sem erro".
 *
 * O que este arquivo mede, tudo contra dado real de producao:
 *
 *   T1  o deslocamento da Way2 (borda direita -> esquerda) faz o que promete
 *   T2  ONS e SCADA estao alinhados no mesmo instante (desloc 0 e o melhor)
 *   T3  as tres fontes fecham no diario dentro da divergencia conhecida
 *   T4  o esquema da serie e o prometido, e nada de outra resolucao vaza
 *   T5  a agregacao preserva energia (somar 15 min da o mesmo que somar 60)
 *   T6  a guarda de granularidade REPROVA um dia com baldes demais
 *
 * T6 e o que mais importa: guarda que nunca foi vista reprovando pode nunca ter funcionado. Foi
 * assim com a guarda de nulo do JSONata, que nunca disparou porque nenhuma chave faltava.
 *
 * Nao precisa de segredo nenhum: o diario de EneatRec ja e publicado como blob, entao o caminho
 * inteiro do diario roda aqui. Da Way2 intradiaria testa-se a transformacao com dado sintetico,
 * que e onde mora a logica.
 */
const G = require('./gen-comparativo.js');

const PONTO_INV = {};
Object.keys(G.PONTOS).forEach((id) => { PONTO_INV[G.PONTOS[id]] = id; });

let falhas = 0;
const ok = (n, m) => console.log('  [OK]    ' + n + (m ? '  ' + m : ''));
const nok = (n, m) => { falhas++; console.log('  [FALHA] ' + n + (m ? '  ' + m : '')); };
const soma = (o) => G.PARQUES.reduce((s, p) => s + (o && o[p] != null ? o[p] : 0), 0);

// ---- T1: o deslocamento da Way2 ---------------------------------------------------------------
// A API rotula pelo FIM. Um valor rotulado 11:15 cobre [11:00, 11:15) e tem de aparecer no blob
// em 11:00. Dado sintetico porque e a REGRA que se testa, nao a fonte.
function t1() {
  const resp = {
    dados: G.PARQUES.map((p) => ({
      pontoId: +PONTO_INV[p],
      nomeGrandeza: 'EneatRec',
      valores: [
        { data: '2026-08-20T11:15:00', valor: 1000 },   // kWh -> 1 MWh, cobre 11:00
        { data: '2026-08-20T11:30:00', valor: 2000 },   // cobre 11:15
        { data: '2026-08-21T00:00:00', valor: 3000 },   // ultimo balde do dia 20: cobre 23:45
      ],
    })),
  };
  const m = G.way2ParaMapa(resp, 15);
  const casos = [
    ['2026-08-20T11:00', 9, 'o valor rotulado 11:15 vai para 11:00'],
    ['2026-08-20T11:15', 18, 'o valor rotulado 11:30 vai para 11:15'],
    ['2026-08-20T23:45', 27, 'o balde rotulado com a data do dia SEGUINTE volta para 23:45'],
  ];
  let bom = true;
  for (const [chave, esperado, texto] of casos) {
    const v = m.get(chave);
    const s = v ? +soma(v).toFixed(6) : null;
    if (s !== esperado) { nok('T1 ' + texto, 'esperava ' + esperado + ', veio ' + s); bom = false; }
  }
  if (m.get('2026-08-20T11:15') && m.get('2026-08-20T11:30')) {
    nok('T1 nao pode existir balde em 11:30', 'o deslocamento nao aconteceu');
    bom = false;
  }
  if (bom) ok('T1 deslocamento da Way2', 'borda direita -> esquerda, inclusive na virada do dia');
}

// ---- T2: ONS e SCADA no mesmo instante --------------------------------------------------------
// Se as duas nao estivessem alinhadas, o painel desenharia divergencia que e de rotulo. O criterio
// e comparativo: o deslocamento zero tem de ser MELHOR que os vizinhos, com folga.
async function t2(ons30, scada, dia) {
  const sc15 = G.scadaParaMapa(scada, dia, 'intra15', 15);
  const sc30 = G.agrega(sc15, 30);
  const erros = {};
  for (const off of [-1, 0, 1]) {
    let e = 0; let n = 0;
    for (const [k, v] of ons30) {
      if (k.slice(0, 10) !== dia) continue;
      const ms = Date.parse(k + ':00-03:00') + off * 30 * 60000;
      const kk = new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 16);
      const s = sc30.get(kk);
      if (!s) continue;
      e += Math.abs(soma(v) - soma(s)); n++;
    }
    erros[off] = n ? e / n : Infinity;
  }
  const txt = [-1, 0, 1].map((o) => o + ': ' + erros[o].toFixed(3)).join('  ');
  if (erros[0] < erros[-1] * 0.2 && erros[0] < erros[1] * 0.2) {
    ok('T2 ONS e SCADA alinhados', 'erro medio por desloc — ' + txt + ' MWh');
  } else {
    nok('T2 ONS e SCADA alinhados', 'o desloc 0 nao vence com folga — ' + txt);
  }
}

// ---- T3: as tres fecham no diario -------------------------------------------------------------
// A divergencia real e de poucos por cento. Fora de +-10% nao e divergencia de medicao: e
// conversao errada ou parque faltando na soma — que foi exatamente o defeito do mapa de ponto.
function t3(ons30, scada, w2dia, dias) {
  const onsD = G.agregaDia(ons30);
  const scD = G.scadaDiarioParaMapa(scada, dias[0]);
  let bom = true;
  console.log('        dia           ONS      Way2     SCADA   ONS/Way2  SCADA/Way2');
  for (const d of dias) {
    const o = soma(onsD.get(d)); const w = soma(w2dia.get(d)); const s = soma(scD.get(d));
    if (!w) { nok('T3 ' + d, 'Way2 sem dado — ela e o arbitro'); bom = false; continue; }
    const ro = o / w * 100; const rs = s / w * 100;
    console.log('        ' + d + '  ' + o.toFixed(1).padStart(8) + w.toFixed(1).padStart(10)
      + s.toFixed(1).padStart(10) + (ro.toFixed(2) + '%').padStart(10) + (rs.toFixed(2) + '%').padStart(11));
    if (ro < 90 || ro > 110) { nok('T3 ONS x Way2 em ' + d, ro.toFixed(1) + '% fora de 90-110'); bom = false; }
    if (rs < 90 || rs > 110) { nok('T3 SCADA x Way2 em ' + d, rs.toFixed(1) + '% fora de 90-110'); bom = false; }
  }
  if (bom) ok('T3 as tres fontes fecham', 'divergencia dentro de +-10%, que e medicao e nao conversao');
}

// ---- T4: esquema da serie ---------------------------------------------------------------------
function t4(ons30, scada, w2dia, dia) {
  // 30 min: as tres presentes
  const sc30 = G.agrega(G.scadaParaMapa(scada, dia, 'intra15', 15), 30);
  const s30 = G.montaSerie({ way2: new Map(), scada: sc30, ons: ons30 }, false);
  const chaves = new Set();
  s30.forEach((l) => Object.keys(l).forEach((k) => chaves.add(k)));
  const esperadas = new Set(['t', 'ms']);
  ['o', 's'].forEach((p) => G.PARQUES.forEach((q) => esperadas.add(p + q.slice(1))));
  const sobra = [...chaves].filter((k) => !esperadas.has(k));
  if (sobra.length) nok('T4 esquema de 30 min', 'chaves inesperadas: ' + sobra.join(', '));
  else ok('T4 esquema de 30 min', chaves.size + ' chaves, todas previstas');

  // diario: o instante tem de ser meia-noite de Brasilia, nao de UTC
  const sd = G.montaSerie({ way2: w2dia }, true);
  const l0 = sd[0];
  if (!l0 || !/T00:00:00-03:00$/.test(l0.t)) {
    nok('T4 instante do diario', 'esperava meia-noite BRT, veio ' + (l0 && l0.t));
  } else if (new Date(l0.ms).toISOString().slice(11, 16) !== '03:00') {
    nok('T4 instante do diario', 'o epoch nao corresponde a 00:00 BRT');
  } else {
    ok('T4 instante do diario', l0.t + ' -> epoch em ' + new Date(l0.ms).toISOString());
  }

  // uma fonte ausente nao pode deixar coluna nenhuma para tras
  const s5 = G.montaSerie({ way2: w2dia }, true);
  const c5 = new Set(); s5.forEach((l) => Object.keys(l).forEach((k) => c5.add(k)));
  const vazou = [...c5].filter((k) => k[0] === 'o' || k[0] === 's');
  if (vazou.length) nok('T4 fonte ausente', 'vazou coluna de outra fonte: ' + vazou.join(', '));
  else ok('T4 fonte ausente', 'sem Way2-only nao aparece coluna de ONS nem de SCADA');
}

// ---- T5: a agregacao preserva energia ---------------------------------------------------------
// Somar quatro baldes de 15 min tem de dar o mesmo que o balde de 60. Se a agregacao usasse media
// em vez de soma — o reflexo de quem pensa em potencia — a energia sumiria por um fator 4.
function t5(scada, dia) {
  const s15 = G.scadaParaMapa(scada, dia, 'intra15', 15);
  const total15 = [...s15.entries()].filter(([k]) => k.slice(0, 10) === dia)
    .reduce((s, [, v]) => s + soma(v), 0);
  const s60 = G.agrega(s15, 60);
  const total60 = [...s60.entries()].filter(([k]) => k.slice(0, 10) === dia)
    .reduce((s, [, v]) => s + soma(v), 0);
  const dif = Math.abs(total15 - total60);
  if (dif < 0.01) ok('T5 agregacao preserva energia', total15.toFixed(2) + ' MWh em 15 e em 60 min');
  else nok('T5 agregacao preserva energia', '15 min: ' + total15.toFixed(2) + ' · 60 min: ' + total60.toFixed(2));
}

// ---- T6: a guarda de granularidade REPROVA ----------------------------------------------------
// Guarda que nunca foi vista reprovando pode nunca ter funcionado.
function t6() {
  const AMOSTRAS = G.AMOSTRAS_DIA;
  const serie = [];
  // um dia com 100 baldes num blob que promete 96
  for (let i = 0; i < 100; i++) serie.push({ t: '2026-08-01T00:00:00-03:00', ms: i });
  const porDia = {}; serie.forEach((l) => { const d = l.t.slice(0, 10); porDia[d] = (porDia[d] || 0) + 1; });
  const ruins = Object.keys(porDia).filter((d) => d < '2026-08-23' && porDia[d] > AMOSTRAS[15]);
  if (ruins.length === 1 && porDia[ruins[0]] === 100) {
    ok('T6 guarda de granularidade', 'reprova 100 baldes num blob de 96 — a regra dispara mesmo');
  } else {
    nok('T6 guarda de granularidade', 'NAO reprovou: ' + JSON.stringify(porDia));
  }
}

(async () => {
  console.log('=== ensaio do comparativo · nada e publicado ===\n');
  const DIAS = ['2026-07-10', '2026-07-11', '2026-07-12'];
  const DIA = DIAS[0];

  t1();
  t6();

  console.log('\n  lendo dado real de producao...');
  const scada = await G.leBlob('scada_comparativo.json');
  if (!scada) { nok('leitura', 'scada_comparativo.json ausente'); process.exit(1); }
  const ons30 = await G.lerONS(DIA);
  const w2 = await G.leBlob('way2_eneat_diario.json');
  if (!w2) { nok('leitura', 'way2_eneat_diario.json ausente'); process.exit(1); }
  const w2dia = G.way2DiarioParaMapa(w2);
  console.log('    SCADA ' + Object.keys(scada.intra15 || {}).length + ' dias · '
    + 'ONS ' + ons30.size + ' instantes · Way2 ' + w2dia.size + ' dias\n');

  await t2(ons30, scada, DIA);
  t5(scada, DIA);
  t4(ons30, scada, w2dia, DIA);
  t3(ons30, scada, w2dia, DIAS);

  console.log('\n=== ' + (falhas ? falhas + ' FALHA(S)' : 'TUDO PASSOU') + ' ===');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
