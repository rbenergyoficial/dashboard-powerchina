// Ensaio da FUSAO do registro da mesa (lib-ppc.js · fundeCopias): so dados plantados, verde em qualquer dia.
//
// Historia: ate 03/10/2026 a fusao era por carimbo e nunca tirava nada. A mesa corrigiu 26/09 (19 linhas reescritas, uma
// com a hora digitada na coluna de potencia) e o publicado seguiu com as linhas antigas ao lado das novas; a auditoria
// contra o ONS ficou vermelha por um dia que a planilha ja tinha consertado. Cada caso abaixo reprova a fusao antiga ou
// uma fusao que apague demais (o historico que o arquivo vigente nao traz, a manha do primeiro dia de um arquivo novo).
const P = require('./lib-ppc.js');
let falhas = 0;
const diz = (nome, obtido, esperado) => { const bom = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!bom) falhas++;
  console.log('  ' + (bom ? '✅' : '🔴') + ' ' + nome + ' · ' + JSON.stringify(obtido) + (bom ? '' : ' (esperado ' + JSON.stringify(esperado) + ')')); };

/* um evento plantado: `quando` = 'AAAA-MM-DD HH:MM' */
const ev = (quando, pot) => { const dia = quando.slice(0, 10), min = Number(quando.slice(11, 13)) * 60 + Number(quando.slice(14, 16));
  return { dia, min, ts: quando, ms: P.msDe(dia, min), pot, restr: pot < P.PLENA - P.FOLGA ? 1 : 0 }; };
const ts = (F) => F.eventos.map((e) => e.ts);
const pot = (F, t) => (F.eventos.find((e) => e.ts === t) || {}).pot;

/* o publicado: 24 a 27/09, dois eventos por dia */
const pub = ['2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'].flatMap((d) => [ev(d + ' 07:00', 100), ev(d + ' 15:00', P.PLENA)]);

console.log('1 · A COPIA MAIS NOVA MANDA NOS DIAS QUE COBRE (o defeito que estava no ar)');
{ /* a mesa corrigiu 26/09: o lancamento das 07:00 era das 07:20, e o das 15:00 foi apagado */
  const copia = pub.filter((e) => e.dia !== '2026-09-26').concat([ev('2026-09-26 07:20', 100)]);
  const F = P.fundeCopias(pub, [copia]);
  diz('linha com a hora corrigida: so o carimbo novo fica', ts(F).filter((t) => t.startsWith('2026-09-26')), ['2026-09-26 07:20']);
  diz('os removidos sao listados', F.removidos, ['2026-09-26 07:00', '2026-09-26 15:00']);
  diz('os outros dias nao mudam', ts(F).filter((t) => !t.startsWith('2026-09-26')).length, 6);
  /* a potencia corrigida no mesmo carimbo: a copia ganha */
  const F2 = P.fundeCopias(pub, [pub.map((e) => (e.ts === '2026-09-25 07:00' ? ev('2026-09-25 07:00', 41) : e))]);
  diz('valor corrigido no mesmo carimbo: a copia ganha', pot(F2, '2026-09-25 07:00'), 41);
  /* um dia inteiro apagado no meio da faixa da copia sai do ar (e a auditoria acusa se o ONS restringiu) */
  const F3 = P.fundeCopias(pub, [pub.filter((e) => e.dia !== '2026-09-25')]);
  diz('dia inteiro apagado no meio da faixa sai', ts(F3).some((t) => t.startsWith('2026-09-25')), false);
}

console.log('\n2 · O QUE A COPIA NAO COBRE FICA');
{ /* o arquivo vigente passa a cobrir so de 26/09 em diante */
  const F = P.fundeCopias(pub, [[ev('2026-09-26 08:00', 90), ev('2026-09-27 07:00', 100), ev('2026-09-28 07:00', 70)]]);
  diz('dias antes do primeiro dia da copia ficam (historico)', ts(F).filter((t) => t < '2026-09-26').length, 4);
  diz('o PRIMEIRO dia da copia se funde por carimbo: a manha da copia anterior fica', ts(F).filter((t) => t.startsWith('2026-09-26')),
    ['2026-09-26 07:00', '2026-09-26 08:00', '2026-09-26 15:00']);
  diz('dentro da faixa, o que a copia nao traz sai', ts(F).filter((t) => t.startsWith('2026-09-27')), ['2026-09-27 07:00']);
  diz('dia novo entra', [F.novos, ts(F).includes('2026-09-28 07:00')], [2, true]);
  diz('copia vazia nao apaga nada', ts(P.fundeCopias(pub, [[]])).length, 8);
  diz('sem publicado anterior (404), a copia vira o registro', ts(P.fundeCopias([], [pub])).length, 8);
}

console.log('\n3 · VARIAS COPIAS: A ORDEM E A CRONOLOGICA');
{ const velha = pub.map((e) => (e.ts === '2026-09-26 07:00' ? ev('2026-09-26 07:00', 0.55) : e));
  const nova = pub.filter((e) => e.ts !== '2026-09-26 07:00').concat([ev('2026-09-26 07:20', 100)]);
  const F = P.fundeCopias(pub, [velha, nova]);
  diz('a copia velha (0,55 MW) nao sobrevive a nova', [pot(F, '2026-09-26 07:00'), pot(F, '2026-09-26 07:20')], [undefined, 100]);
  diz('saida em ordem de tempo', F.eventos.every((e, i, a) => !i || a[i - 1].ms <= e.ms), true);
}

console.log('\n' + (falhas ? '🔴 ' + falhas + ' falha(s)' : '✅ ensaio limpo'));
process.exit(falhas ? 1 : 0);
