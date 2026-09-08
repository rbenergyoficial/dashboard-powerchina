/*
 * ensaio-inv-scada-hora.js — prova o detalhe de MEIA HORA da razao contra os pares.
 *
 * A pergunta que o painel novo responde e "em que hora do dia a diferenca se abre", entao o ensaio
 * planta DOIS defeitos que sao indistinguiveis no total do dia e opostos no horario:
 *   INV07 · PARTIDA ATRASADA — nao gera ate as 09:00 e depois acompanha os pares
 *   INV08 · TETO DE POTENCIA — acompanha os pares e trava num patamar entre 10:00 e 14:00
 * Os dois perdem energia parecida no dia; so a curva de meia hora separa um do outro. Se o gerador
 * estiver certo, a razao do INV07 e baixa DE MANHA e normal a tarde, e a do INV08 e o contrario.
 *
 * E prova as guardas que a medicao exigiu:
 *   · piso — nas pontas do dia todos fazem poucos kWh e a razao entre numeros pequenos estoura;
 *     abaixo do piso a linha NAO EXISTE, em vez de existir errada;
 *   · contador ACUMULADO — a energia da meia hora e a diferenca, e degrau negativo (zeragem) nao
 *     vira energia negativa;
 *   · `ms` = hora local + 3 h, o mesmo acordo do resto do stack.
 *
 * Nao toca rede nem blob: LOCAL_DIR para a entrada, LOCAL_OUT_DIR para a saida.
 * uso: node scripts/ensaio-inv-scada-hora.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const GER = path.join(__dirname, 'gen-inv-scada.js');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-hora-'));
const ENT = path.join(raiz, 'entrada');
const SAI = path.join(raiz, 'saida');
fs.mkdirSync(ENT); fs.mkdirSync(SAI);

// ---------- o dia sintetico, meia em meia hora ----------
// 24 leituras das 06:00 as 17:30. A curva e uma sineide de sol: zero fora da janela, pico ao meio-dia.
const SLOTS = [];
for (let h = 6; h < 18; h++) for (const m of [0, 30]) SLOTS.push({ h, m });
const perfil = (i) => {
  const x = (i + 0.5) / SLOTS.length;                 // 0..1 ao longo do dia
  const v = Math.sin(Math.PI * x) ** 2 * 120;         // pico 120 kWh por meia hora
  return Math.round(v * 100) / 100;
};
const INVS = ['INV01', 'INV02', 'INV03', 'INV04', 'INV05', 'INV06', 'INV07', 'INV08'];
// INV07 so comeca as 09:00 · INV08 trava em 60 kWh entre 10:00 e 14:00
function energiaSlot(inv, i) {
  const base = perfil(i);
  const { h } = SLOTS[i];
  if (inv === 'INV07') return h < 9 ? 0 : base;
  if (inv === 'INV08') return (h >= 10 && h < 14) ? Math.min(base, 60) : base;
  return base;
}
function csv(pref, dia) {
  const cols = ['Tempo'].concat(INVS.map((i) =>
    'UFV_' + pref + '_TS1_' + i + '_' + pref + ' TS1 ' + i + ' ENERGIA DIÁRIA GERADA'));
  const acum = Object.fromEntries(INVS.map((i) => [i, 0]));
  const linhas = [];
  // a primeira leitura do dia e o contador ZERADO, as 05:30 — sem ela a primeira meia hora nao
  // teria com o que ser diferenciada
  linhas.push([dia + ' 05:30:00'].concat(INVS.map(() => '0')).join(';'));
  SLOTS.forEach((s, i) => {
    INVS.forEach((inv) => { acum[inv] += energiaSlot(inv, i); });
    const hh = String(s.h).padStart(2, '0') + ':' + String(s.m).padStart(2, '0') + ':00';
    linhas.push([dia + ' ' + hh].concat(INVS.map((inv) => String(Math.round(acum[inv] * 100) / 100))).join(';'));
  });
  return cols.join(';') + '\n' + linhas.join('\n') + '\n';
}

const DIA = '2026-09-01';
fs.writeFileSync(path.join(ENT, 'M02_20260901_120000.csv'), csv('MRT02', DIA));
fs.writeFileSync(path.join(ENT, 'M03_20260901_120000.csv'), csv('MRT03', DIA));

function roda(extra) {
  const env = Object.assign({}, process.env, { LOCAL_DIR: ENT, LOCAL_OUT_DIR: SAI, DIAS: '400' }, extra || {});
  delete env.LOCAL_OUT;
  const out = execFileSync('node', [GER], { env, encoding: 'utf8' });
  const le = (n) => { let b = fs.readFileSync(path.join(SAI, n));
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    return JSON.parse(b.toString('utf8')); };
  return { log: out, pub: le('inv_scada.json'), hora: le('inv_scada_hora.json') };
}

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const r = roda();
const S = r.hora.serie_hora;
const doInv = (inv) => S.filter((l) => l.inv === inv && l.ufv === 'M2');
const horaDe = (l) => new Date(l.ms - 3 * 3600e3).toISOString().slice(11, 16);

console.log('1 · a serie existe e tem a forma acordada');
ok(S.length > 0, 'serie_hora publicada · ' + S.length + ' linhas');
ok(['ms', 'ts', 'inv', 'kwh', 'base_kwh', 'razao', 'base', 'dia', 'ufv', 'chave'].every((k) => k in S[0]),
  'campos: ' + Object.keys(S[0]).join(' '));
ok(S.every((l) => l.chave === l.ufv + '/' + l.ts + '/' + l.inv), 'a chave e a MESMA do painel diario');
ok(r.hora.escopo.piso_kwh === 10 && r.hora.escopo.dias_cobertos === 1, 'escopo declara piso e cobertura · piso '
  + r.hora.escopo.piso_kwh + ' · ' + r.hora.escopo.dias_cobertos + ' dia(s)');

console.log('\n2 · `ms` e a hora local mais 3 h (o acordo do stack)');
const primeiro = S.slice().sort((a, b) => a.ms - b.ms)[0];
ok(primeiro.ms === Date.parse(DIA + 'T' + horaDe(primeiro) + ':00Z') + 3 * 3600e3,
  'primeiro instante ' + horaDe(primeiro) + ' BRT · ms = ' + primeiro.ms);

console.log('\n3 · o PISO corta as pontas do dia, e so elas');
const horas = [...new Set(S.map(horaDe))].sort();
ok(!horas.includes('06:00') && !horas.includes('17:30'),
  'as pontas ficaram de fora · primeira ' + horas[0] + ' · ultima ' + horas[horas.length - 1]);
ok(S.every((l) => l.base_kwh >= 10), 'nenhuma linha com mediana dos pares abaixo do piso');
ok(horas.length >= 16 && horas.length <= 22, horas.length + ' meias horas sobreviveram das 24');

console.log('\n4 · PARTIDA ATRASADA: o INV07 e baixo DE MANHA e normal a tarde');
const manha = (l) => horaDe(l) < '09:00';
const tarde = (l) => horaDe(l) >= '10:00' && horaDe(l) < '14:00';
const i7m = doInv('INV07').filter(manha).map((l) => l.razao);
const i7t = doInv('INV07').filter((l) => horaDe(l) >= '09:30').map((l) => l.razao);
ok(i7m.length > 0 && i7m.every((v) => v < 0.05), 'de manha o INV07 nao gera · razoes ' + i7m.join(' '));
ok(i7t.length > 0 && i7t.every((v) => v > 0.9), 'depois das 09:30 ele acompanha os pares · min ' + Math.min(...i7t));

console.log('\n5 · TETO DE POTENCIA: o INV08 e normal de manha e baixo NO MEIO-DIA');
const i8m = doInv('INV08').filter(manha).map((l) => l.razao);
const i8p = doInv('INV08').filter(tarde).map((l) => l.razao);
ok(i8m.length > 0 && i8m.every((v) => v > 0.9), 'de manha o INV08 acompanha · min ' + Math.min(...i8m));
ok(i8p.length > 0 && i8p.every((v) => v < 0.75), 'entre 10h e 14h ele trava no teto · max ' + Math.max(...i8p));

console.log('\n6 · 🔴 o DIA diz que os dois estao baixos e NAO diz por que — o horario diz');
const dia7 = r.pub.inversores.find((x) => x.chave === 'M2/TS1/INV07');
const dia8 = r.pub.inversores.find((x) => x.chave === 'M2/TS1/INV08');
ok(dia7 && dia8, 'os dois estao no ranking diario');
if (dia7 && dia8) {
  console.log('       razao do DIA · INV07 ' + dia7.razao_mediana + ' · INV08 ' + dia8.razao_mediana
    + '  → dois numeros baixos, a mesma conclusao para causas opostas');
  ok(dia7.razao_mediana < 0.95 && dia8.razao_mediana < 0.95, 'os dois caem abaixo dos pares no dia');
  // e a prova de que o horario separa: o CONTRASTE manha/meio-dia tem sinais opostos
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const c7 = med(doInv('INV07').filter(manha).map((l) => l.razao)) - med(doInv('INV07').filter(tarde).map((l) => l.razao));
  const c8 = med(doInv('INV08').filter(manha).map((l) => l.razao)) - med(doInv('INV08').filter(tarde).map((l) => l.razao));
  console.log('       contraste manha − meio-dia · INV07 ' + c7.toFixed(2) + ' · INV08 ' + c8.toFixed(2));
  ok(c7 < -0.5 && c8 > 0.2, 'o contraste tem SINAL OPOSTO nos dois — e o que o total do dia nao carrega');
}

console.log('\n7 · os SADIOS ficam em 1,00 e nao sujam a comparacao');
const sadios = S.filter((l) => ['INV01', 'INV02', 'INV03'].includes(l.inv)).map((l) => l.razao);
ok(sadios.every((v) => v >= 0.99 && v <= 1.01), 'razao dos sadios entre 0,99 e 1,01 · '
  + Math.min(...sadios) + ' a ' + Math.max(...sadios));

console.log('\n8 · contador que ZERA no meio do dia nao vira energia negativa');
const zerado = csv('MRT02', DIA).split('\n');
zerado[12] = zerado[12].split(';').map((c, i) => (i === 0 ? c : '0')).join(';');   // uma leitura a zero
fs.writeFileSync(path.join(ENT, 'M02_20260901_120000.csv'), zerado.join('\n'));
const r2_ = roda();
ok(r2_.hora.serie_hora.every((l) => l.kwh >= 0), 'nenhuma energia negativa · ' + r2_.hora.serie_hora.length + ' linhas');
ok(r2_.hora.serie_hora.every((l) => l.razao >= 0), 'nenhuma razao negativa');

console.log('\n9 · a janela do detalhe fino e independente da do historico');
const r3 = roda({ JANELA_HORA: '0' });
ok(r3.hora.serie_hora.length === 0 && r3.hora.escopo.dias_cobertos === 0,
  'com janela 0 o detalhe sai vazio e o diario continua · diario '
  + r3.pub.serie_top.length + ' linhas');

console.log('\n' + (falhas.length ? '🔴 ' + falhas.length + ' FALHA(S)' : '✅ tudo passou'));
fs.rmSync(raiz, { recursive: true, force: true });
process.exit(falhas.length ? 1 : 0);
