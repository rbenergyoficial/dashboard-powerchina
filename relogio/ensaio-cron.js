// Ensaio do relogio de um temporizador so (lote relogio-um-temporizador, 09/11/2026).
//
// 🔴 O QUE ESTA SENDO PROVADO
// 1. O interpretador, sobre a agenda de 09/11/2026 CONGELADA aqui: para cada workflow, quantas vezes e EM QUE HORARIOS
//    ele toca num dia, contra uma tabela escrita a mao a partir dos crons (nao contra o proprio interpretador, que
//    provaria que ele concorda consigo mesmo). A amostra e fixa de proposito: mudar um cron num workflow nao obriga
//    ninguem a mexer neste ensaio. A agenda VIVA (agenda.json) so precisa compilar e tocar ao menos uma vez por semana.
// 2. A volta de parada: cada workflow sai uma vez, o minuto atual entra sempre, e a varredura para em 6 h.
// 3. Plantios: o interpretador com o passo ignorado, a faixa cortada, a hora deslocada e o dia da semana errado;
//    os quatro tem de reprovar.
// ⚠️ O interpretador e lido do PROPRIO src/cron.js, como ele sobe.
'use strict';
const fs = require('fs');
const path = require('path');

const FONTE = fs.readFileSync(path.join(__dirname, 'src', 'cron.js'), 'utf8');
const VIVA = JSON.parse(fs.readFileSync(path.join(__dirname, 'agenda.json'), 'utf8'));
const AGENDA = {   // agenda.json de 09/11/2026 (commit 13e98c6), congelada
  'alarmes-scada.yml': ['0 17 11 * * *', '0 41 15 * * *'],
  'boletim.yml': ['0 1 11 * * *', '0 31 11 * * *', '0 1,31 12 * * *', '0 37 20 * * *', '0 7,37 21 * * *', '0 7 22 * * *'],
  'comparativo.yml': ['0 40 13,23 * * *'], 'eneat-intradia-way2.yml': ['0 7 */6 * * *'],
  'estacao-logger.yml': ['0 47 9 * * *', '0 33 15 * * *'], 'executivo.yml': ['0 13 4,9-22 * * *'],
  'inversores.yml': ['0 22 0,12,18 * * *'], 'irradiancia-ons.yml': ['0 30 6,15,17,19,22 * * *'],
  'malha-estado.yml': ['0 4,19,34,49 * * * *'], 'must-intra.yml': ['0 7,22,37,52 * * * *'], 'must.yml': ['0 45 3 * * *'],
  'ons-consolidado.yml': ['0 17 18 * * *'], 'portal-dia.yml': ['0 10,40 3-5 * * *'], 'ppc.yml': ['0 23 * * * *'],
  'render-paineis.yml': ['0 10 0,16 * * *'], 'sager-disp.yml': ['0 47 7,13 * * *'],
  'scada.yml': ['0 30 11 * * *', '0 7 17,21 * * *'], 'sungrow.yml': ['0 52 9 * * *', '0 17 13 * * *', '0 47 15 * * *'],
  'trafo-medidor.yml': ['0 11,26,41,56 * * * *'], 'trafo.yml': ['0 38 10,15 * * *'], 'vigia.yml': ['0 7,30,53 * * * *'],
  'way2-agg.yml': ['0 8 * * * *'], 'way2-hist.yml': ['0 30 3 * * *'], 'way2-mes.yml': ['0 4,14,24,34,44,54 * * * *'],
  'way2-recent.yml': ['0 */5 * * * *']
};
const carrega = (src) => { const m = { exports: {} }; new Function('module', 'exports', 'require', src)(m, m.exports, require); return m.exports; };

// horarios UTC por dia, escritos a mao a partir da agenda de 09/11/2026 ('hh:mm')
const h = (hs, ms) => hs.flatMap((x) => ms.map((y) => String(x).padStart(2, '0') + ':' + String(y).padStart(2, '0')));
const TODA_HORA = [...Array(24).keys()];
const ESPERADO = {
  'alarmes-scada.yml': ['11:17', '15:41'],
  'boletim.yml': ['11:01', '11:31', '12:01', '12:31', '20:37', '21:07', '21:37', '22:07'],
  'comparativo.yml': ['13:40', '23:40'],
  'eneat-intradia-way2.yml': ['00:07', '06:07', '12:07', '18:07'],
  'estacao-logger.yml': ['09:47', '15:33'],
  'executivo.yml': h([4, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22], [13]),
  'inversores.yml': ['00:22', '12:22', '18:22'],
  'irradiancia-ons.yml': ['06:30', '15:30', '17:30', '19:30', '22:30'],
  'malha-estado.yml': h(TODA_HORA, [4, 19, 34, 49]),
  'must-intra.yml': h(TODA_HORA, [7, 22, 37, 52]),
  'must.yml': ['03:45'],
  'ons-consolidado.yml': ['18:17'],
  'portal-dia.yml': ['03:10', '03:40', '04:10', '04:40', '05:10', '05:40'],
  'ppc.yml': h(TODA_HORA, [23]),
  'render-paineis.yml': ['00:10', '16:10'],
  'sager-disp.yml': ['07:47', '13:47'],
  'scada.yml': ['11:30', '17:07', '21:07'],
  'sungrow.yml': ['09:52', '13:17', '15:47'],
  'trafo-medidor.yml': h(TODA_HORA, [11, 26, 41, 56]),
  'trafo.yml': ['10:38', '15:38'],
  'vigia.yml': h(TODA_HORA, [7, 30, 53]),
  'way2-agg.yml': h(TODA_HORA, [8]),
  'way2-hist.yml': ['03:30'],
  'way2-mes.yml': h(TODA_HORA, [4, 14, 24, 34, 44, 54]),
  'way2-recent.yml': h(TODA_HORA, [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55])
};

function confere(C, dizer) {
  let mau = 0;
  const ok = (c, m) => { if (!c) { mau += 1; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  let rs;
  try { rs = C.regras(AGENDA); } catch (e) { ok(false, 'a agenda compila: ' + e.message); return mau; }
  ok(Object.keys(AGENDA).sort().join() === Object.keys(ESPERADO).sort().join(), 'a tabela do ensaio cobre exatamente os workflows da agenda');
  // 7 dias inteiros, de domingo a sabado, minuto a minuto
  const D0 = Date.UTC(2026, 10, 8), MIN = 60000;
  for (const r of rs) {
    const quer = (ESPERADO[r.wf] || []).slice().sort();
    let iguais = true, n = 0;
    for (let d = 0; d < 7; d++) {
      const tem = [];
      for (let t = D0 + d * 1440 * MIN; t < D0 + (d + 1) * 1440 * MIN; t += MIN) {
        const x = new Date(t);
        if (r.testes.some((f) => f(x))) tem.push(x.toISOString().slice(11, 16));
      }
      n += tem.length;
      if (tem.join() !== quer.join()) iguais = false;
    }
    ok(iguais, `${r.wf}: ${quer.length} por dia nos horarios da tabela (7 dias, ${n} disparos)`);
  }
  // volta de parada
  const M = Date.UTC(2026, 10, 10, 9, 13, 0);   // 06:13 BRT, minuto do executivo e de nada mais alem do way2/must/...
  const nomes = (p) => p.workflows.slice().sort().join();
  const noMinuto = (t) => rs.filter((r) => r.testes.some((f) => f(new Date(t)))).map((r) => r.wf).sort().join();
  ok(nomes(C.plano(rs, M - MIN, M + 4000)) === noMinuto(M), 'normal: o minuto atual, segundos depois, dispara o que toca nele');
  ok(nomes(C.plano(rs, NaN, M)) === noMinuto(M), 'sem ultimo registrado: so o minuto atual');
  ok(nomes(C.plano(rs, M - MIN, M - 300)) === noMinuto(M), 'disparo 300 ms antes da virada: e o minuto que vira');
  ok(nomes(C.plano(rs, M, M)) === noMinuto(M), 'ultimo igual ao atual: o atual entra mesmo assim');
  const p2 = C.plano(rs, M - 120 * MIN, M);
  ok(p2.workflows.length === new Set(p2.workflows).size, 'parada de 2 h: cada workflow sai uma vez');
  ok(p2.workflows.includes('sager-disp.yml') && !p2.workflows.includes('must.yml'), 'parada de 2 h: pega o das 07:47 (sager), nao o das 03:45 (must)');
  const p10 = C.plano(rs, M - 600 * MIN, M);
  ok(p10.de === new Date(M - 360 * MIN).toISOString(), 'parada de 10 h: a varredura para em 6 h');
  ok(!p10.workflows.includes('inversores.yml') && p10.workflows.includes('must.yml'), 'parada de 10 h: fora o das 00:22 (inversores), dentro o das 03:45 (must)');
  // recusa na carga
  const recusa = (e) => { try { C.compila(e); return false; } catch (_) { return true; } };
  ok(recusa('0 7 * * 1') && recusa('30 7 * * * *') && recusa('0 7 * 1 * 1') && recusa('0 61 * * * *'), 'recusa 5 campos, segundo != 0, dia + dia da semana e minuto 61');
  ok(C.compila('0 0 0 * * 0')(new Date(Date.UTC(2026, 10, 8))) && !C.compila('0 0 0 * * 1')(new Date(Date.UTC(2026, 10, 8))), 'dia da semana: 08/11/2026 e domingo (0)');
  return mau;
}

console.log('ensaio do relogio de um temporizador');
let mau = confere(carrega(FONTE), true);
// a agenda viva: compila e cada workflow toca ao menos uma vez em 7 dias
try {
  const C = carrega(FONTE), rs = C.regras(VIVA), D0 = Date.UTC(2026, 10, 8);
  const mudos = rs.filter((r) => { for (let t = D0; t < D0 + 7 * 86400000; t += 60000) if (r.testes.some((f) => f(new Date(t)))) return false; return true; });
  if (mudos.length) { mau += 1; console.log('  [X] agenda viva: nunca tocam: ' + mudos.map((r) => r.wf).join(', ')); }
  else console.log(`  ok  agenda viva: ${rs.length} workflows compilam e tocam`);
} catch (e) { mau += 1; console.log('  [X] agenda viva nao compila: ' + e.message); }

const PLANTIOS = {
  'passo ignorado': ['const passo = m[2] ? Number(m[2]) : 1;', 'const passo = 1;'],
  'faixa sem o fim': ['for (let v = a; v <= b; v += passo)', 'for (let v = a; v < b; v += passo)'],
  'hora deslocada': ['c[2].has(d.getUTCHours())', 'c[2].has((d.getUTCHours() + 1) % 24)'],
  'dia da semana errado': ['c[5].has(d.getUTCDay())', 'c[5].has((d.getUTCDay() + 1) % 7)'],
  'minuto atual fora': ['if (de > agora) de = agora;', 'if (de > agora) de = agora + MIN;'],
  'sem teto de 6 h': ['if (de < agora - TETO_ATRASO_MS) de = agora - TETO_ATRASO_MS;', ''],
  'sem folga de disparo adiantado': ['const agora = Math.floor((agoraMs + ADIANTO_MS) / MIN) * MIN;', 'const agora = Math.floor(agoraMs / MIN) * MIN;']
};
let furou = 0;
for (const [nome, [de, para]] of Object.entries(PLANTIOS)) {
  if (!FONTE.includes(de)) { console.log('  [X] plantio "' + nome + '": trecho nao encontrado no src/cron.js'); furou += 1; continue; }
  const n = confere(carrega(FONTE.replace(de, para)), false);
  console.log((n > 0 ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n > 0 ? 'reprova (' + n + ' falha)' : 'PASSOU — o ensaio nao o ve'));
  if (n === 0) furou += 1;
}
console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) nao pego(s)` : 'APROVADO');
process.exit(mau || furou ? 1 : 0);
