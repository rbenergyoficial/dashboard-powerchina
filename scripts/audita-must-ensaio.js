/*
 * audita-must-ensaio.js — confere os blobs que os geradores acabaram de produzir EM MODO LOCAL,
 * antes de qualquer coisa ir para producao.
 *
 * O workflow roda `gen-must.js` e `gen-must-intra.js` com LOCAL_OUT apontando para um diretorio
 * temporario do runner. Nada e gravado no Azure. Este script le os arquivos resultantes e responde
 * as tres perguntas que decidem se a correcao pode subir:
 *
 *   1. O rotulo de tempo e o FIM do intervalo? (o primeiro balde do dia tem de ser 00:passo, e o
 *      ultimo tem de ser 00:00 do dia seguinte)
 *   2. A granularidade e a prometida? (o espacamento entre baldes consecutivos tem de ser o passo)
 *   3. Sobrou alguma ultrapassagem? Nos dias auditados a resposta correta e ZERO — se ainda
 *      aparecer alguma, o alinhamento nao foi corrigido.
 */
const fs = require('fs');
const DIR = process.env.ENSAIO_DIR || '/tmp/ensaio/';
const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const ARQS = [['must_5min.json', 5], ['must_15min.json', 15],
  ['must_30min.json', 30], ['must_60min.json', 60]];

const le = n => { try { return JSON.parse(fs.readFileSync(DIR + n, 'utf8')); } catch (e) { return null; } };
const hm = ms => new Date(ms + 3 * 3600000).toISOString().slice(11, 16);

let falhou = false;
const erro = m => { falhou = true; console.log('  🔴 ' + m); };

console.log('ENSAIO — blobs gerados em modo local, nada publicado\n');

// ---- os quatro intradiarios --------------------------------------------------------------------
for (const [nome, passo] of ARQS) {
  const b = le(nome);
  if (!b) { console.log('  ' + nome.padEnd(17) + ' ausente (resolucao nao processada nesta rodada)'); continue; }
  const s = b.serie || [];
  console.log('  ' + nome.padEnd(17) + String(s.length).padStart(6) + ' linhas · '
    + b.dias + ' dias · resolucao declarada ' + b.resolucao_min + ' min');
  if (!s.length) { erro(nome + ' sem serie'); continue; }

  // 1 · espacamento entre baldes consecutivos
  const passos = new Map();
  for (let i = 1; i < s.length; i++) {
    const d = (s[i].ms - s[i - 1].ms) / 60000;
    passos.set(d, (passos.get(d) || 0) + 1);
  }
  const dom = [...passos.entries()].sort((a, b2) => b2[1] - a[1])[0];
  const fora = [...passos.entries()].filter(([d]) => d !== passo)
    .sort((a, b2) => b2[1] - a[1]).slice(0, 3);
  console.log('      espacamento dominante: ' + dom[0] + ' min em ' + dom[1] + ' pares'
    + (fora.length ? '  · outros: ' + fora.map(([d, n]) => d + 'min x' + n).join(', ') : ''));
  if (dom[0] !== passo) erro(nome + ' tem espacamento dominante de ' + dom[0]
    + ' min, mas se declara ' + passo + ' min');

  // 2 · o rotulo e o FIM do intervalo: o primeiro balde de um dia cheio cai em 00:passo
  const porDia = new Map();
  for (const l of s) {
    const d = new Date(l.ms - passo * 60000 + 3 * 3600000).toISOString().slice(0, 10);
    if (!porDia.has(d)) porDia.set(d, []);
    porDia.get(d).push(l);
  }
  const cheios = [...porDia.entries()].filter(([, v]) => v.length === 1440 / passo);
  if (cheios.length) {
    const [d0, v0] = cheios[Math.floor(cheios.length / 2)];
    const pri = hm(v0[0].ms), ult = hm(v0[v0.length - 1].ms);
    const esperado = String(Math.floor(passo / 60)).padStart(2, '0') + ':'
      + String(passo % 60).padStart(2, '0');
    console.log('      dia cheio ' + d0 + ': primeiro ' + pri + ' · ultimo ' + ult
      + '  (esperado ' + esperado + ' e 00:00)');
    if (pri !== esperado || ult !== '00:00')
      erro(nome + ' nao rotula pelo FIM do intervalo: ' + pri + '..' + ult);
  } else console.log('      (nenhum dia cheio nesta janela para conferir o rotulo)');
}

// ---- o diario -----------------------------------------------------------------------------------
const d = le('must_diario.json');
if (!d) console.log('\n  must_diario.json ausente');
else {
  const s = d.serie || [];
  console.log('\n  must_diario.json  ' + s.length + ' linhas');
  const semSlots = s.filter(l => l.slots != null && l.slots > 96 && !l.parcial);
  if (semSlots.length) erro('ha ' + semSlots.length + ' linhas com mais de 96 intervalos num dia '
    + 'fechado — o pico ainda esta sendo apurado na granularidade de 5 min');
  const ex = s.filter(l => !l.parcial).slice(-3);
  ex.forEach(l => console.log('      ' + l.dia + ' ' + String(l.parque).padEnd(9)
    + 'pico ' + String(l.pico_mw).padStart(8) + ' as ' + l.pico_hora
    + ' · ' + String(l.slots).padStart(3) + ' intervalos'));
}

// ---- a pergunta que originou tudo ---------------------------------------------------------------
console.log('\n=== ultrapassagens que sobraram ===');
const alvo = (process.env.DIAS_ALVO || '2026-06-13,2026-06-16,2026-08-03,2026-08-07,2026-08-11').split(',');
for (const [nome, passo] of ARQS) {
  const b = le(nome);
  if (!b) continue;
  const c = b.contratos || {};
  const casos = [];
  for (const l of (b.serie || [])) {
    const dia = new Date(l.ms - passo * 60000 + 3 * 3600000).toISOString().slice(0, 10);
    if (!alvo.includes(dia)) continue;
    for (const p of PARQUES) {
      if (l[p] == null || !c[p]) continue;
      const pct = l[p] / c[p] * 100;
      if (pct > 100) casos.push(dia + ' ' + hm(l.ms) + ' ' + p + ' ' + pct.toFixed(2) + '%');
    }
  }
  console.log('  ' + nome.padEnd(17) + casos.length + ' intervalo(s) acima de 100% nos dias auditados');
  casos.slice(0, 12).forEach(x => console.log('      ' + x));
  if (nome === 'must_15min.json' && casos.length) {
    erro('a base CONTRATUAL ainda acusa ultrapassagem nos dias auditados — na fonte sao ZERO, '
      + 'entao o alinhamento nao foi corrigido');
  }
}

console.log('\n' + (falhou ? '🔴 ENSAIO REPROVADO — nao publicar' : '✅ ENSAIO APROVADO'));
process.exit(falhou ? 1 : 0);
