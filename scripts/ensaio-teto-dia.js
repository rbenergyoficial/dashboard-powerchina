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
const L = require(process.env.LIBTETO || './lib-teto-dia.js');   // LIBTETO=./<copia>.js: a regra sobre outra versao (plantio)
const { tetoDia, guardaDia, acumuladoAte, relidoDoPublicado, corteTrafos } = L;
const { rollupDia } = require('./gen-way2-hist.js');

const f = [];
let nPassa = 0, nBarra = 0;
const passa = (nome, novo, antes, ate, relido, corteNovo) => { nPassa++; const m = guardaDia(novo, antes, ate, relido, corteNovo); if (m) f.push('devia PASSAR · ' + nome + ': ' + m); };
// `motivo` (regex, opcional): a recusa tem de ser ESSA — a guarda do passado e a da cauda se escondem uma atras da outra
const barra = (nome, novo, antes, ate, relido, motivo, corteNovo) => {
  nBarra++;
  const m = guardaDia(novo, antes, ate, relido, corteNovo);
  if (!m) f.push('devia REPROVAR · ' + nome + ' (' + novo + ' MWh ate ' + ate + ', teto ' + tetoDia(ate).toFixed(2) + ')');
  else if (motivo && !motivo.test(m)) f.push('reprovou pelo motivo ERRADO · ' + nome + ': ' + m);
};
const PASSADO = /ENCOLHEU no trecho ja publicado/, CAUDA = /caiu mais que o consumo maximo/;

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

// A NOITE (PROMOVER dia-noite-encolhe). Os numeros da regra sao medidos e a lib diz de onde vem; o ensaio prende cada um.
const qn = (a, b, nome) => { if (Math.abs(a - b) > 1e-6) f.push(nome + ': ' + a + ' (esperava ' + b + ')'); };
qn(L.CONSUMO_MAX_MW, 2.494, 'consumo maximo do complexo (400 dias do portal_eletrico, 27/03/2026 18:00)');
qn(L.FOLGA_MWH, 2.494 * 5 / 60, 'folga = uma amostra de 5 min do consumo maximo');
qn(L.DEFASAGEM_MIN, 10, 'defasagem trafos x 6233 (54 de 56 rodadas de 07 a 09/10/2026)');

// Casos REAIS de 08 e 09/10/2026. Publicado 1.992,81 ate 19:20 e 1.976,28 ate 18:20 (executivo.json). Relido no snapshot final
// de cada dia (hist/way2_DIA.json, 6196+6197) em volta do instante publicado: 1.992,813 as 19:10 e 1.976,283 as 18:10 — o
// publicado, com os trafos 10 min atras do 6233. Os remendos das 21:30 e 23:55 de 08/10 e das 23:00 de 09/10 leram 1.990,03,
// 1.987,27 e 1.971,65 (runs 37865084777, 37876829165, 38015313604) e foram recusados por "ENCOLHEU".
passa('08/10/2026 21:30, a noite consome', 1990.03, 1992.81, '21:30', { mwh: 1992.813, em: '19:10' });
passa('08/10/2026 23:55, a ultima rodada do dia', 1987.27, 1992.81, '23:55', { mwh: 1992.813, em: '19:10' });
passa('09/10/2026 23:00', 1971.65, 1976.28, '23:00', { mwh: 1976.283, em: '18:10' });

// Um trecho REAL, relido pela lib (revisor RE-102): 09/10/2026 de 23:05 a 23:35, 6196 e 6197 em kW (hist/way2_2026-10-09.json,
// 3 casas), sobre a energia ate 23:00 (1.971,348129 MWh, posta num instante so). Os 10 min mais consumidos da noite (1,86 MW,
// 0,26 MWh de 23:15 a 23:25) passam da folga (0,21): publicado com os trafos ate 23:15 e o `ate` 23:25, so a metade de TRAS da
// janela acha o corte. Sem ela o relido cai para o acumulado das 23:25 e a guarda recusa a noite.
const TR = { 6196: [-993.765, -1046.143, -1023.52, -847.901, -777.001, -742.792, -750.847],
  6197: [-810.496, -827.693, -821.354, -772.445, -735.143, -707.777, -714.575] };
const real = (k) => [{ data: '2026-10-09T12:00:00', valor: k === 6196 ? 1971.348129 * 12000 : 0 }]
  .concat(TR[k].map((v, i) => ({ data: '2026-10-09T23:' + String(5 + 5 * i).padStart(2, '0') + ':00', valor: v })));
const SR = [real(6196), real(6197)];
const pubR = Math.round(acumuladoAte(SR, '2026-10-09', '23:15') * 100) / 100;
qn(pubR, 1970.89, 'trecho real: acumulado ate 23:15');
const relR = relidoDoPublicado(SR, '2026-10-09', '23:25');
if (!relR || relR.em !== '23:15') f.push('trecho real: o relido devia achar o corte das 23:15 (achou ' + JSON.stringify(relR) + ')');
passa('09/10/2026 23:45, trecho real relido pela lib', Math.round(acumuladoAte(SR, '2026-10-09', '23:35') * 100) / 100, pubR, '23:45', relR);

// as bordas, para nenhuma das duas folgas poder andar sem reprovar
const F = L.FOLGA_MWH;
passa('relido abaixo do publicado por 0,9 da folga', 1989.7, 1990, '19:30', { mwh: 1990 - 0.9 * F, em: '19:20' });
barra('relido abaixo do publicado por 1,1 da folga (o passado perdeu energia)', 1999, 1990, '19:30', { mwh: 1990 - 1.1 * F, em: '19:20' }, PASSADO);
const piso = 1990 - F - 2.494 * (21 * 60 + 30 + 10 - (19 * 60 + 20)) / 60;   // relido 1990 as 19:20, novo ate 21:30 (+10 min)
passa('cauda no piso + 0,01 (2,494 MW x 2 h 20)', piso + 0.01, 1990, '21:30', { mwh: 1990, em: '19:20' });
barra('cauda no piso - 0,01', piso - 0.01, 1990, '21:30', { mwh: 1990, em: '19:20' }, CAUDA);
// com o corte novo conhecido (o remendo sempre o tem), a cauda vai ate ELE, nao ate `ate` + 10 min
const pisoC = 1990 - F - 2.494 * (21 * 60 + 20 - (19 * 60 + 20)) / 60;      // relido 1990 as 19:20, corte novo 21:20
passa('cauda ate o corte novo, no piso + 0,01 (2,494 MW x 2 h)', pisoC + 0.01, 1990, '21:30', { mwh: 1990, em: '19:20' }, '21:20');
barra('cauda ate o corte novo, no piso - 0,01', pisoC - 0.01, 1990, '21:30', { mwh: 1990, em: '19:20' }, CAUDA, '21:20');

// um dia FORJADO, kW de 5 min, com os dois trafos DIFERENTES (um ensaio com series iguais nao sabe que ponto entrou na soma):
// TR1 sino de 90 MW e consumo de 1.350 kW, TR2 sino de 76 MW e consumo de 1.100 kW. Os 2,45 MW da noite ficam acima do
// limiar em que a metade de tras da janela decide (folga / 10 min = 1,25 MW) e abaixo do consumo maximo da regra (2,494).
const DIA = '2026-10-08';
const inst = []; for (let m = 5; m <= 1440; m += 5) inst.push(m);
const carimbo = (m) => (m === 1440 ? '2026-10-09T00:00:00' : DIA + 'T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00');
const PICO = { 1: 90000, 2: 76000 }, NOITE = { 1: -1350, 2: -1100 };
const pot = (k, m) => (m > 360 && m < 1080 ? PICO[k] * Math.sin(Math.PI * (m - 360) / 720) : NOITE[k]);
const serie = (k, ate, mexe) => inst.filter((m) => m <= ate).map((m) => ({ data: carimbo(m), valor: mexe ? mexe(m, pot(k, m)) : pot(k, m) }));
const hm = (m) => (m >= 1440 ? '00:00' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
const A = (ate) => acumuladoAte([serie(1, 1440), serie(2, 1440)], DIA, hm(ate));
const caso = (nome, deve, antesCorte, antesAte, novoAte, mexe1, mexe2, motivo) => {
  const S = [serie(1, novoAte, mexe1), serie(2, novoAte, mexe2)];     // o snapshot NOVO (trafos ate novoAte)
  const antes = Math.round(A(antesCorte) * 100) / 100;                // publicado: trafos ate antesCorte, `ate` do 6233 = antesAte
  const novo = Math.round(acumuladoAte(S, DIA, hm(novoAte)) * 100) / 100;
  const rel = relidoDoPublicado(S, DIA, hm(antesAte));
  if (deve) passa('forjado · ' + nome, novo, antes, hm(Math.min(novoAte + 10, 1435)), rel);
  else barra('forjado · ' + nome, novo, antes, hm(Math.min(novoAte + 10, 1435)), rel, motivo);
};
caso('noite depois de 2 h sem remendo, trafos 10 min atras', true, 19 * 60 + 10, 19 * 60 + 20, 23 * 60 + 45);
caso('trafos 5 min A FRENTE do 6233 no publicado, de dia', true, 13 * 60, 12 * 60 + 55, 13 * 60 + 5);
caso('trafos alinhados, de dia, 5 min depois', true, 12 * 60, 12 * 60, 12 * 60 + 5);
caso('trafos alinhados, de noite, 5 min depois', true, 21 * 60, 21 * 60, 21 * 60 + 5);
caso('leitura torta: o TR2 zerado das 12:00 as 12:55 no snapshot novo, de noite', false, 19 * 60 + 10, 19 * 60 + 20, 21 * 60 + 30,
  null, (m, p) => (m >= 720 && m <= 775 ? 0 : p), PASSADO);
caso('cauda torta: o TR1 das 21:00 em W lido como kW (-600.000)', false, 19 * 60 + 10, 19 * 60 + 20, 23 * 60 + 45,
  (m, p) => (m === 1260 ? -600000 : p), null, CAUDA);
// O CORTE GRAVADO (`liq_corte`, revisor RE-104): o relido sai exato, e qualquer defasagem passa. Sem ele, a janela de +/- 10 min
// tolera de -15 a +10 min: com os trafos 20 min atras do 6233 ela recusa, e o caso fica aqui para o limite nao andar calado.
const casoC = (nome, deve, antesCorte, antesAte, novoAte, gravado, motivo, mexe1) => {
  const S = [serie(1, novoAte, mexe1), serie(2, novoAte)];
  const antes = Math.round(A(antesCorte) * 100) / 100;
  const novo = Math.round(acumuladoAte(S, DIA, hm(novoAte)) * 100) / 100;
  const rel = relidoDoPublicado(S, DIA, hm(antesAte), gravado ? hm(antesCorte) : undefined);
  if (gravado && !(rel && rel.exato && rel.em === hm(antesCorte))) f.push('corte gravado · ' + nome + ': o relido devia ser exato no corte (' + JSON.stringify(rel) + ')');
  // o VALOR do exato: o acumulado do snapshot novo ate o corte, nem um passo a mais nem a menos (revisor RE-201)
  if (gravado && rel && Math.abs(rel.mwh - acumuladoAte(S, DIA, hm(antesCorte))) > 1e-9) f.push('corte gravado · ' + nome + ': relido ' + rel.mwh + ' (esperava o acumulado ate ' + hm(antesCorte) + ')');
  const corteNovo = corteTrafos(S, DIA);
  if (corteNovo !== hm(novoAte)) f.push('corteTrafos · ' + nome + ': ' + corteNovo + ' (esperava ' + hm(novoAte) + ')');
  if (deve) passa('corte · ' + nome, novo, antes, hm(Math.min(novoAte + 20, 1435)), rel, corteNovo);
  else barra('corte · ' + nome, novo, antes, hm(Math.min(novoAte + 20, 1435)), rel, motivo, corteNovo);
};
casoC('noite, trafos 20 min atras, corte gravado', true, 19 * 60, 19 * 60 + 20, 23 * 60 + 25, true);
casoC('noite, trafos 40 min atras, corte gravado', true, 18 * 60 + 40, 19 * 60 + 20, 23 * 60 + 25, true);
casoC('dia, trafos 20 min atras, corte gravado', true, 12 * 60, 12 * 60 + 20, 12 * 60 + 5, true);
casoC('noite, trafos 20 min atras, SEM o corte: a janela recusa (o limite declarado)', false, 19 * 60, 19 * 60 + 20, 23 * 60 + 25, false, PASSADO);
casoC('noite, o TR1 das 12:00 zerado no snapshot novo (o passado perdeu 7,5 MWh), relido no corte gravado', false,
  19 * 60, 19 * 60 + 20, 23 * 60 + 25, true, PASSADO, (m, p) => (m === 12 * 60 ? 0 : p));
// DE DIA a perda tem de ser menor que um passo de geracao (~13,8 MWh ao meio-dia): o TR1 das 11:00 zerado tira 7,2 MWh. Um
// relido exato lido um passo DEPOIS do corte a esconderia (revisor RE-201: de noite um passo e 0,20 MWh, abaixo da folga).
casoC('dia, o TR1 das 11:00 zerado no snapshot novo (o passado perdeu 7,2 MWh), relido no corte gravado das 13:00', false,
  13 * 60, 13 * 60 + 10, 13 * 60 + 30, true, PASSADO, (m, p) => (m === 11 * 60 ? 0 : p));
// o snapshot que RECUA: corte gravado 21:00, o novo so ate 20:30 (revisor RE-204); de dia e de noite
casoC('noite, o snapshot novo recuou meia hora antes do corte gravado', false, 21 * 60, 21 * 60 + 10, 20 * 60 + 30, true, /RECUOU/);
casoC('dia, o snapshot novo recuou meia hora antes do corte gravado', false, 13 * 60, 13 * 60 + 10, 12 * 60 + 30, true, /RECUOU/);
// as BORDAS do recuo (revisor RE-301/RE-302): a fonte que nao avancou (corte novo IGUAL ao gravado) passa, de dia, de noite e no
// 24:00; o recuo de UM passo (o ultimo instante perdido nos dois trafos) recusa
casoC('dia, a fonte nao avancou: corte novo igual ao gravado', true, 13 * 60, 13 * 60 + 10, 13 * 60, true);
casoC('noite, a fonte nao avancou: corte novo igual ao gravado', true, 21 * 60, 21 * 60 + 10, 21 * 60, true);
casoC('24:00, a fonte nao avancou: corte 00:00 contra 00:00', true, 1440, 1440, 1440, true);
casoC('noite, o snapshot novo recuou UM passo', false, 21 * 60, 21 * 60 + 10, 20 * 60 + 55, true, /RECUOU/);
if (relidoDoPublicado([serie(1, 1440)], DIA, null) !== null) f.push('relidoDoPublicado sem instante devia ser null (a guarda cai na regra antiga)');

// a conta do acumulado: rotulo na borda DIREITA (o dia vai de 00:05 a 00:00 do dia seguinte), inclusive no instante, soma o
// negativo, ignora o nulo e o que e de outro dia. 12.000 kW num passo de 5 min = 1 MWh.
const qa = (a, b, nome) => qn(a, b, 'acumulado ' + nome);
const S1 = [{ data: '2026-10-08T00:00:00', valor: 99000 }, { data: '2026-10-08T00:05:00', valor: -1200 },
  { data: '2026-10-08T12:00:00', valor: 12000 }, { data: '2026-10-08T19:20:00', valor: 12000 }, { data: '2026-10-08T19:25:00', valor: null },
  { data: '2026-10-08T23:55:00', valor: -1200 }, { data: '2026-10-09T00:00:00', valor: -1200 }, { data: '2026-10-09T00:05:00', valor: 99000 }];
const S2 = [{ data: '2026-10-08T19:20:00', valor: 12000 }, { data: '2026-10-08T19:25:00', valor: -1200 }];
// corteTrafos nas bordas: o ultimo instante do dia com valor em ALGUMA serie; 00:00 do dia seguinte = '00:00'; nulo nao conta
const CT = (sr) => corteTrafos(sr, '2026-10-08');
const ct = (a, b, nome) => { if (a !== b) f.push('corteTrafos ' + nome + ': ' + a + ' (esperava ' + b + ')'); };
ct(CT([S1, S2]), '00:00', 'com o 00:00 do dia seguinte');
ct(CT([S2]), '19:25', 'uma serie so');
ct(CT([[{ data: '2026-10-08T19:20:00', valor: 5 }, { data: '2026-10-08T19:25:00', valor: null }]]), '19:20', 'o nulo do fim nao conta');
ct(CT([[{ data: '2026-10-08T00:00:00', valor: 5 }, { data: '2026-10-09T00:05:00', valor: 5 }]]), null, 'so instantes de outros dias');
qa(acumuladoAte([S1, S2], '2026-10-08', '19:20'), (-1200 + 12000 * 3) * 5 / 60 / 1000, 'ate 19:20 (inclusive, as duas series)');
qa(acumuladoAte([S1, S2], '2026-10-08', '19:15'), (-1200 + 12000) * 5 / 60 / 1000, 'ate 19:15 (sem o instante seguinte)');
qa(acumuladoAte([S1, S2], '2026-10-08', '00:00'), (12000 * 3 - 1200 * 4) * 5 / 60 / 1000, 'ate 24:00 (00:00 do dia seguinte entra, 00:00 do proprio dia nao)');
// e a MESMA conta do rollupDia (o publicado sai dele): o dia forjado inteiro pelos dois caminhos
const snapF = { dados: [{ pontoId: 6196, nomeGrandeza: 'Demat', valores: serie(1, 1440) }, { pontoId: 6197, nomeGrandeza: 'Demat', valores: serie(2, 1440) },
  { pontoId: 6233, nomeGrandeza: 'Demat', valores: serie(1, 1440) }] };
qa(Math.round(acumuladoAte([serie(1, 1440), serie(2, 1440)], DIA, '00:00') * 1000) / 1000, rollupDia(snapF, DIA).ene_liq_mwh, 'ate 24:00 = rollupDia do mesmo snapshot');

// a guarda ANTIGA, para registro: com os dias de outubro ate 04/10, ela recusava o caso real (o defeito que motivou o lote)
const antiga = (novo, outros) => novo > Math.max.apply(null, outros) * 1.25;
if (!antiga(3153.88, [2456.66, 1478.56, 759.49, 828.02])) f.push('a guarda antiga devia recusar o caso de 05/10 (o ensaio nao reproduz o defeito)');

if (f.length) { console.error('REPROVADO:\n  ' + f.join('\n  ')); process.exit(1); }
console.log('ensaio-teto-dia: TUDO PASSOU · teto as 18:10 = ' + tetoDia('18:10').toFixed(2) + ' MWh · ' + nPassa + ' casos passam · ' + nBarra
  + ' defeitos reprovam · a guarda antiga recusava o 05/10 · a noite real de 08 e 09/10 passa · acumulado = rollupDia');
