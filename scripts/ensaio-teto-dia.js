/*
 * ensaio-teto-dia.js — a guarda do dia em curso do executivo.json (lib-teto-dia.js, PROMOVER executivo-teto-fisico).
 *
 * POR QUE EXISTE. A guarda antiga (maior dia do mes x 1,25) recusou um dia de sol no inicio de um mes com dias cortados
 * (05/10/2026: 3.153,88 MWh contra o teto de 3.071) e derrubou o job de 5 min por horas. A nova e fisica (343,77 MW x horas
 * desde 05:00). Este ensaio prova as DUAS coisas: o caso real que travou passa, e cada defeito que a guarda existe para pegar
 * continua reprovando. Sem rede: os numeros reais estao escritos aqui, com a fonte.
 *
 *   node scripts/ensaio-teto-dia.js
 *   LIBTETO=./<copia>.js node scripts/ensaio-teto-dia.js     a regra sobre outra versao da lib (o defeito plantado tem de reprovar)
 */
'use strict';
const { tetoDia, guardaDia } = require(process.env.LIBTETO || './lib-teto-dia.js');   // LIBTETO=./<copia>.js: a regra sobre outra versao (plantio)

const f = [];
const passa = (nome, novo, antes, ate) => { const m = guardaDia(novo, antes, ate); if (m) f.push('devia PASSAR · ' + nome + ': ' + m); };
const barra = (nome, novo, antes, ate) => { if (!guardaDia(novo, antes, ate)) f.push('devia REPROVAR · ' + nome + ' (' + novo + ' MWh ate ' + ate + ', teto ' + tetoDia(ate).toFixed(2) + ')'); };

// o teto, a mao: 343,77 x 13 h 10 min = 4.526,30 MWh as 18:10; zero ate 05:00; 343,77 x 19 h = 6.531,63 as 24:00
const q = (a, b, nome) => { if (Math.abs(a - b) > 1e-6) f.push('teto ' + nome + ': ' + a + ' (esperava ' + b + ')'); };
q(tetoDia('18:10'), 343.77 * (13 + 10 / 60), '18:10'); q(tetoDia('04:55'), 0, '04:55'); q(tetoDia('05:00'), 0, '05:00');
q(tetoDia('00:00'), 343.77 * 19, '00:00 do dia seguinte = 24:00');

// os casos REAIS (executivo.json e hist/portal_vivo_DIA.json, lidos em 05/10/2026)
passa('05/10/2026 as 18:10, o dia que a guarda antiga recusou', 3153.88, 3150.10, '18:10');
passa('09/09/2026, o maior dia do historico, no fim', 3119.3, 3119.3, '24:00');
passa('09/09/2026 as 15:45, o instante de maior razao do historico (78,9 % do teto)', 343.77 * 10.75 * 0.789, null, '15:45');
passa('madrugada: so consumo (energia negativa)', -4.2, -3.9, '03:00');
passa('05:10, a primeira geracao do historico', 0.3, -4.0, '05:10');
passa('o snapshot cresce por arredondamento de 1 MWh', 1500.0, 1500.9, '12:00');

// os defeitos que a guarda existe para pegar
barra('unidade errada (kWh lido como MWh) ao meio-dia', 1500 * 1000, null, '12:00');
barra('dia contado em dobro no fim de um dia de sol', 2 * 3153.88, 3153.88, '18:10');
barra('dia contado em dobro as 15:45 do maior dia', 2 * 343.77 * 10.75 * 0.789, null, '15:45');
barra('energia antes do sol (relogio torto)', 50, null, '04:30');
barra('o dia encolheu', 2900, 3153.88, '18:15');
barra('sem o instante lido', 100, null, null);

// a guarda ANTIGA, para registro: com os dias de outubro ate 04/10, ela recusava o caso real (o defeito que motivou o lote)
const antiga = (novo, outros) => novo > Math.max.apply(null, outros) * 1.25;
if (!antiga(3153.88, [2456.66, 1478.56, 759.49, 828.02])) f.push('a guarda antiga devia recusar o caso de 05/10 (o ensaio nao reproduz o defeito)');

if (f.length) { console.error('REPROVADO:\n  ' + f.join('\n  ')); process.exit(1); }
console.log('ensaio-teto-dia: TUDO PASSOU · teto as 18:10 = ' + tetoDia('18:10').toFixed(2) + ' MWh · 6 casos reais passam · 6 defeitos reprovam · a guarda antiga recusava o 05/10');
