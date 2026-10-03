// Ensaio de LOGICA da guarda da EneatLiquida (lib-guarda-liquida.js): so dados plantados, verde em qualquer dia do mes.
// O estado do produto publicado e julgado a parte, no ensaio-liquidada-produto.js (depois do gerador).
//
// Historia: a guarda antiga era `tot > 0` e aceitou dia 60 % liquidado. A guarda por residuo (EneatRec - liquidada) tinha
// tres defeitos, achados na revisao do ensaio em 03/10/2026: (1) o dia julgado entrava no proprio teto e se aceitava
// (60 % liquidado levava o teto a 1,2 do contador); (2) "3 x o maior" era catraca; (3) no comeco do mes o teto ficava nulo
// e a guarda caia em silencio no sinal. Cada caso abaixo reprova a lib que tiver de volta um desses defeitos.
//
// Os casos chamam GL.julgaDias, a MESMA funcao que o gen-executivo usa: o ensaio julga a composicao do gerador.
const GL = require('./lib-guarda-liquida.js');
let falhas = 0;
const diz = (nome, obtido, esperado) => { const bom = JSON.stringify(obtido) === JSON.stringify(esperado);
  if (!bom) falhas++;
  console.log('  ' + (bom ? '✅' : '🔴') + ' ' + nome + ' · ' + JSON.stringify(obtido) + (bom ? '' : ' (esperado ' + JSON.stringify(esperado) + ')')); };

/* um dia plantado: 9 usinas que somam `tot`, contador `rec` */
const UFV = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const dia = (d, rec, tot, parcial) => ({ dia: d, parcial: !!parcial, rec, liq: Object.fromEntries(UFV.map((u) => [u, tot / 9])) });
const completo = (d, rec, res) => dia(d, rec, rec - res);
const decisao = (J, d) => J.decisoes.find((x) => x.dia === d);
const h = '2026-10-10';
/* a janela do mes anterior: 20 dias de consumo auxiliar entre 12 e 18 MWh (a familia medida em ago/26: 11 a 22 MWh) */
const setembro = Array.from({ length: 20 }, (_, i) => ({ dia: '2026-09-' + String(i + 5).padStart(2, '0'), res_mwh: 12 + (i % 7), rec_mwh: 2000 }));

console.log('1 · O DIA JULGADO NAO ENTRA NO PROPRIO TETO (o defeito que estava no ar)');
{ /* mes com 6 dias completos e um dia 60 % liquidado: na composicao do gerador ele tem de ser RECUSADO */
  const mes = ['01', '02', '03', '04', '05', '06'].map((d, i) => completo('2026-10-' + d, 2400, 14 + i)).concat([dia('2026-10-07', 2400, 2400 * 0.6)]);
  const J = GL.julgaDias(mes, [], h);
  diz('dia 60 % liquidado, janela so do mes (6 completos)', decisao(J, '2026-10-07').aceito, false);
  diz('os 6 completos sao aceitos', J.decisoes.filter((x) => x.dia < '2026-10-07').every((x) => x.aceito), true);
  [0.80, 0.51, 0.95].forEach((f) => {
    const J2 = GL.julgaDias(mes.slice(0, 6).concat([dia('2026-10-07', 2400, 2400 * f)]), setembro, h);
    diz('dia ' + Math.round(f * 100) + ' % liquidado, janela cheia', decisao(J2, '2026-10-07').aceito, false);
  });
  /* e o dia meio liquidado nao vai para a janela */
  diz('o recusado nao entra na janela', J.aceitosComTeto.some((x) => x.dia === '2026-10-07'), false);
  /* a liquidacao ATRASADA (varios dias seguidos meio liquidados, comum no comeco do mes): com o proprio dia na conta, ele
     e o voto que desempata a mediana para o lado dos parciais e se aceita; sem ele, os completos decidem */
  const atraso = [completo('2026-10-01', 2400, 14), completo('2026-10-02', 2400, 15), completo('2026-10-03', 2400, 16),
    dia('2026-10-04', 2400, 2400 * 0.6), dia('2026-10-05', 2400, 2400 * 0.596), dia('2026-10-06', 2400, 2400 * 0.592)];
  const Ja = GL.julgaDias(atraso, [], h);
  diz('liquidacao atrasada: os 3 dias a ~60 % sao recusados', Ja.decisoes.filter((x) => x.dia >= '2026-10-04').map((x) => x.aceito), [false, false, false]);
}

console.log('\n2 · COMECO DE MES: a janela guardada decide o primeiro dia');
{ const J = GL.julgaDias([completo('2026-10-01', 2400, 16), dia('2026-10-02', 2400, 2400 * 0.6)], setembro, '2026-10-02');
  diz('01/10 completo aceito com teto (nao pelo sinal)', [decisao(J, '2026-10-01').aceito, decisao(J, '2026-10-01').so_sinal], [true, false]);
  diz('02/10 a 60 % recusado', decisao(J, '2026-10-02').aceito, false);
  const Jv = GL.julgaDias([completo('2026-10-01', 2400, 16)], [], '2026-10-02');
  diz('janela vazia: aceito SO PELO SINAL (e a decisao diz)', [decisao(Jv, '2026-10-01').aceito, decisao(Jv, '2026-10-01').so_sinal], [true, true]);
  diz('aceito pelo sinal NAO vai para a janela', Jv.aceitosComTeto.length, 0);
}

console.log('\n3 · SEM CATRACA: um dia aceito perto do teto nao afrouxa a guarda');
{ let jan = setembro.slice();
  const t0 = GL.teto([], jan, h, null).teto;
  for (let k = 0; k < 4; k++) {   /* quatro rodadas, cada uma aceitando um dia a 99 % do teto */
    const t = GL.teto([], jan, h, null).teto;
    jan = GL.atualiza(jan, [{ dia: '2026-10-0' + (k + 1), res: 0.99 * t, rec: 3000 }], h);
  }
  const t4 = GL.teto([], jan, h, null).teto;
  /* limite DERIVADO: com n = 20 originais e k = 4 valores somados acima de todos, a mediana dos 24 e a media do 12o e
     do 13o originais, que nao passa do (n/2 + k)-esimo = 14o. Logo t4 <= FATOR x o 14o original */
  const o = setembro.map((g) => g.res_mwh).sort((p, q) => p - q);
  diz('teto depois de 4 dias aceitos no limite: <= FATOR x 14o residuo original (' + (GL.FATOR * o[13]) + ' MWh)', t4 <= GL.FATOR * o[13] + 1e-9, true);
  diz('e o teto inicial nao era maior que isso', t0 <= GL.FATOR * o[13] + 1e-9, true);
}

console.log('\n4 · A PENEIRA DO MES E A JANELA');
{ const pares = [{ dia: '2026-10-01', rec: 2400, res: 16 }, { dia: '2026-10-02', rec: 2400, res: 960 }, { dia: '2026-10-03', rec: 2400, res: 1300 }];
  diz('candidato do mes: residuo de dia quase nada liquidado (> 0,5 do contador) nao entra', GL.candidatosDoMes(pares).map((q) => q.dia), ['2026-10-01', '2026-10-02']);
  diz('a mediana nao se move por UM dia parcial que passou na peneira', GL.teto(pares, setembro, h, '2026-10-01').mediana, 15);
  const velho = [{ dia: '2026-07-01', res_mwh: 15, rec_mwh: 2000 }];
  diz('guardado de 101 dias atras nao conta', GL.teto([], velho.concat(setembro.slice(0, 3)), h, null).guardados, 3);
  const mesmo = [{ dia: '2026-10-01', res_mwh: 900, rec_mwh: 2400 }];
  diz('guardado do mesmo dia que o mes traz e ignorado (o mes manda)', GL.teto([pares[0]], mesmo.concat(setembro), h, null).dias, 21);
  diz('residuo de dia meio liquidado guardado por engano nao entra', GL.teto([], [{ dia: '2026-09-30', res_mwh: 1500, rec_mwh: 2400 }].concat(setembro), h, null).guardados, 20);
  diz('formato: lista de {dia, res_mwh, rec_mwh} vale', GL.formatoValido(setembro), true);
  diz('formato: residuos ausente ou objeto estranho nao vale (quem le nao regrava)', [GL.formatoValido(undefined), GL.formatoValido({ a: 1 }), GL.formatoValido([{ dia: 1 }])], [false, false, false]);
  const at = GL.atualiza(setembro.concat(velho), [{ dia: '2026-10-01', res: 16.004, rec: 2400 }], h);
  diz('atualiza: tira o velho, poe o aceito, em ordem', [at.length, at[at.length - 1].dia, at.some((g) => g.dia === '2026-07-01')], [21, '2026-10-01', false]);
}

console.log('\n4b · AS OUTRAS PARTES DA DECISAO');
{ const base = setembro.slice(0, 6).map((g) => completo(g.dia.replace('2026-09', '2026-10'), 2000, g.res_mwh));
  const J = GL.julgaDias(base.concat([dia('2026-10-21', 2000, 4000), Object.assign(completo('2026-10-22', 2000, 15), { parcial: true }), dia('2026-10-23', 50, 40)]), [], h);
  diz('liquidada de 2x o contador (liquidacao duplicada) e recusada', decisao(J, '2026-10-21').aceito, false);
  diz('dia em curso, mesmo com residuo dentro do teto, nao e publicado como fechado', [decisao(J, '2026-10-22').aceito, decisao(J, '2026-10-22').motivo], [false, 'dia em curso']);
  /* contador ausente (rec <= 100 MWh): o dia nao entra na mediana. 6 completos (14 a 19 MWh) dao teto 3 x 16,5 = 49,5;
     quatro dias sem contador (rec 90, liquidada 50: 'residuo' 40) puxariam a mediana para 18,5 e o teto para 55,5, e um dia
     com residuo de 50 MWh passaria */
  const semContador = [14, 15, 16, 17, 18, 19].map((r, i) => completo('2026-10-1' + i, 2400, r))
    .concat(['24', '25', '26', '27'].map((d) => dia('2026-10-' + d, 90, 50))).concat([completo('2026-10-28', 2400, 50)]);
  diz('dias sem contador nao entram na mediana: o dia com residuo de 50 MWh e recusado', decisao(GL.julgaDias(semContador, [], h), '2026-10-28').aceito, false);
  diz('guardado com data FUTURA nao conta', GL.teto([], [{ dia: '2026-12-01', res_mwh: 15, rec_mwh: 2000 }].concat(setembro.slice(0, 3)), h, null).guardados, 3);
}

console.log('\n5 · OS CASOS QUE MOTIVARAM A GUARDA');
{ const J = GL.julgaDias(setembro.slice(0, 6).map((g) => completo(g.dia.replace('2026-09', '2026-10'), 2000, g.res_mwh))
    .concat([dia('2026-10-29', 1800, -1.92)]), [], h);
  diz('30/08/2026: liquidada de -1,92 MWh (so o consumo noturno) e recusada', decisao(J, '2026-10-29').aceito, false);
  const Js = GL.julgaDias([dia('2026-10-01', 1800, 900)], [], h);
  diz('sem teto, um dia 50 % liquidado PASSA pelo sinal: e por isso que a janela importa', [decisao(Js, '2026-10-01').aceito, decisao(Js, '2026-10-01').so_sinal], [true, true]);
}

console.log('\n' + (falhas ? '🔴 ' + falhas + ' falha(s)' : '✅ ensaio limpo'));
process.exit(falhas ? 1 : 0);
