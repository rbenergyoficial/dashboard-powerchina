/*
 * ensaio-sg-lim-dia.js — prova o sg_lim_dia.json (lib-sungrow-str.js, bloco 5, sg-lim-dia), sem rede.
 *
 * O arquivo diz, para o Complexo, a cada 5 min, quantos inversores estavam gerando (mais de 1 kW) e quantos deles com potencia limitada.
 * Serve para separar, no trecho em que a geracao fica abaixo do limite, a falta de recurso solar da limitacao pelo controlador.
 *
 * 1 · dois eletrocentros forjados, um dia: a soma por instante, a grade a partir do primeiro instante gerando, o inversor a 1 kW
 *     (0,1 kW x 10) fora, a 1,1 kW dentro, a celula de limitacao vazia fora, os eletrocentros com leitura (ets);
 * 2 · a segunda rodada sem dado novo: o eletrocentro pulado (sem regravar o sg_curva) entra pela curva anterior e o arquivo NAO muda;
 * 3 · o dia com menos eletrocentros nao rebaixa o publicado; o dia antigo, fora da janela de 7 dias da curva, fica; o de mais de 400
 *     dias sai;
 * 4 · plantios numa copia da lib: cada um tem de reprovar.
 *
 * uso: node scripts/ensaio-sg-lim-dia.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIB = path.join(__dirname, 'lib-sungrow-str.js');
const D = '2026-11-08';

function memoria() {
  const store = new Map();
  return { store, leAnterior: async (n) => (store.has(n) ? JSON.parse(JSON.stringify(store.get(n))) : null),
    escreve: async (n, o) => { store.set(n, JSON.parse(JSON.stringify(o))); return 1; } };
}
/* uma linha de 5 min no formato do acumula: p em 0,1 kW, lim 0/1/null */
const linha = (h0, p, lim) => ({ g5: { h0, s: Array.from({ length: 24 }, () => p.map(() => 0)) },
  cv: { h0, p, pdc: p, t: p.map(() => 400), lim, iso: p.map(() => 180), nom: 320 } });

async function prova(SS) {
  const falhas = [];
  const ok = (c, m) => { if (!c) falhas.push(m); };
  const ident = { A: { pos: 'M8/TS1/INV01' }, B: { pos: 'M8/TS1/INV02' }, C: { pos: 'M8/TS2/INV01' } };
  const mEtcs = ['M8_TS1', 'M8_TS2'];
  const vale = () => true;
  const M = memoria();
  // dia antigo e dia velho demais semeados no arquivo publicado
  M.store.set('sg_lim_dia.json', { esquema: 1, dias: { '2026-10-01': { h0: '10:00', ets: 56, g: [1100], l: [1000] }, '2025-09-01': { h0: '10:00', ets: 56, g: [5], l: [5] } } });
  const roda = (g5, pesos) => SS.produtos({ strRodada: {}, g5Rodada: g5, ident, mEtcs, vale, leAnterior: M.leAnterior, escreve: M.escreve, pesos,
    agora: 'x', dias5: 7, diasStr: 180 });
  // A: 10:00..10:20 gerando, limitado nos 3 primeiros; B: 10:05..10:20, a 1 kW (p=10, fora) em 10:05, 1,1 kW (p=11) em 10:10, limitacao vazia em 10:15
  // C (outro eletrocentro): 09:55..10:10 gerando, todos limitados
  const g5 = { A: { [D]: linha('10:00', [500, 500, 500, 500, 500], [1, 1, 1, 0, 0]) },
    B: { [D]: linha('10:05', [10, 11, 600, 600], [1, 1, null, 0]) },
    C: { [D]: linha('09:55', [700, 700, 700, 700], [1, 1, 1, 1]) } };
  const p1 = {};
  await roda(g5, p1);
  const L = (M.store.get('sg_lim_dia.json') || { dias: {} }).dias;
  const x = L[D];
  ok(p1['sg_lim_dia.json'], '1a rodada grava o sg_lim_dia');
  ok(x && x.h0 === '09:55', 'a grade comeca no primeiro instante gerando (09:55): ' + (x && x.h0));
  ok(x && x.ets === 2, 'eletrocentros com leitura no dia = 2: ' + (x && x.ets));
  // instantes 09:55 10:00 10:05 10:10 10:15 10:20
  ok(x && JSON.stringify(x.g) === JSON.stringify([1, 2, 2, 3, 1, 2]), 'gerando por instante [1,2,2,3,1,2] (1 kW fora as 10:05, 1,1 kW dentro as 10:10, limitacao vazia fora as 10:15): ' + JSON.stringify(x && x.g));
  ok(x && JSON.stringify(x.l) === JSON.stringify([1, 2, 2, 3, 0, 0]), 'limitados por instante [1,2,2,3,0,0] (as 10:10 os tres): ' + JSON.stringify(x && x.l));
  ok(L['2026-10-01'] && L['2026-10-01'].g[0] === 1100, 'o dia antigo, fora da janela de 7 dias da curva, fica');
  ok(!L['2025-09-01'], 'o dia de mais de 400 dias sai');
  // 2 · rodada sem dado novo: nada muda
  const p2 = {};
  await roda({}, p2);
  ok(!p2['sg_lim_dia.json'], 'sem dado novo o sg_lim_dia nao e regravado (o eletrocentro pulado entra pela curva anterior)');
  ok(JSON.stringify(M.store.get('sg_lim_dia.json').dias[D]) === JSON.stringify(x), 'e o dia continua igual');
  // 2b · so o TS2 traz dado novo (mais um instante, 10:15, limitado): o TS1, pulado, entra pela curva anterior e o dia fica com os dois
  await roda({ C: { [D]: linha('09:55', [700, 700, 700, 700, 700], [1, 1, 1, 1, 1]) } }, {});
  const z = M.store.get('sg_lim_dia.json').dias[D];
  ok(z.ets === 2 && JSON.stringify(z.g) === JSON.stringify([1, 2, 2, 3, 2, 2]) && JSON.stringify(z.l) === JSON.stringify([1, 2, 2, 3, 1, 0]),
    'so um eletrocentro com dado novo: o pulado entra pela curva anterior (ets 2, g [1,2,2,3,2,2], l [1,2,2,3,1,0]): ets ' + z.ets + ' g ' + JSON.stringify(z.g) + ' l ' + JSON.stringify(z.l));
  // 3 · o publicado com mais eletrocentros nao e rebaixado por uma rodada que so ve um deles
  const M2 = memoria();
  M2.store.set('sg_lim_dia.json', { esquema: 1, dias: { [D]: { h0: '10:00', ets: 56, g: [1000], l: [10] } } });
  await SS.produtos({ strRodada: {}, g5Rodada: { A: g5.A }, ident, mEtcs, vale, leAnterior: M2.leAnterior, escreve: M2.escreve, pesos: {}, agora: 'x', dias5: 7, diasStr: 180 });
  const y = M2.store.get('sg_lim_dia.json').dias[D];
  ok(y.ets === 56 && y.g[0] === 1000, 'o dia com menos eletrocentros nao rebaixa o publicado: ets ' + y.ets);
  return falhas;
}

function copia(de, para) {
  const src = fs.readFileSync(LIB, 'utf8');
  if (!src.includes(de)) throw new Error('plantio sem ancora: ' + de.slice(0, 60));
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limdia-')), 'lib-sungrow-str.js');
  for (const dep of fs.readdirSync(__dirname).filter((n) => n.startsWith('lib-') && n !== 'lib-sungrow-str.js')) fs.copyFileSync(path.join(__dirname, dep), path.join(path.dirname(f), dep));
  fs.writeFileSync(f, src.replace(de, para));
  return require(f);
}

(async () => {
  const f0 = await prova(require(LIB));
  f0.forEach((m) => console.log('  FALHOU · ' + m));
  console.log((f0.length ? 'REPROVADO' : 'ok') + ' · sg_lim_dia: soma, grade, cobertura, janela');
  const PL = [
    ['a limitacao conta mesmo sem gerar', "if (p == null || p * 100 <= P_GER_W || l.lim[i] == null) return;", "if (p == null || l.lim[i] == null) return;"],
    ['o limiar de 1 kW em W errado (0,1 kW tratado como kW)', 'p * 100 <= P_GER_W', 'p * 1000 <= P_GER_W'],
    ['o eletrocentro pulado nao entra', '{ somaLim(k, vC); continue; }', '{ continue; }'],
    ['o dia com menos eletrocentros rebaixa o publicado', 'if (velho && velho.ets > novoDia.ets) continue;', ''],
    ['o dia antigo nao e cortado', 'if (d < corteL) { delete LD[d]; mudouL = true; }', 'if (false) { }'],
  ];
  let ruins = 0;
  for (const [nome, de, para] of PL) {
    let f;
    try { f = await prova(copia(de, para)); } catch (e) { if (/sem ancora/.test(e.message)) { console.log('  plantio "' + nome + '": SEM ANCORA na lib'); ruins += 1; continue; } f = ['erro ' + e.message]; }
    if (f.length) console.log('  plantio "' + nome + '": reprovado (' + f.length + ' falha(s): ' + f[0].slice(0, 90) + '), como devia');
    else { console.log('  plantio "' + nome + '": PASSOU (o ensaio nao o ve)'); ruins += 1; }
  }
  if (f0.length || ruins) { console.log('REPROVADO'); process.exit(1); }
  console.log('APROVADO');
})().catch((e) => { console.error(e); process.exit(1); });
