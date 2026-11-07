'use strict';
/*
 * ensaio-cadeia-manha.js — a ordem da cadeia da manha (lote cadeia-manha, 07/11/2026): quem le um arquivo roda DEPOIS de quem o
 * grava, com a duracao medida do escritor e uma folga. Le os horarios da agenda do relogio (`relogio/agenda.json`, a mesma que o
 * relogio-mauriti dispara no minuto exato) e julga a PRIMEIRA rodada de cada workflow depois das 05:00 de Brasilia.
 *
 * Cadeia (o dado do dia anterior):
 *   ponte (liga 05:55, cofre gravado ate ~06:24 nos dias de uma tentativa) -> estacao-logger -> sungrow (disponibilidade le a irradiancia)
 *   -> executivo (le sg_disp_dia e a estacao) -> boletim (le executivo, pr_ufv, irr_ufv, irr_plano_30min e sg_disp_dia)
 * Duracoes (o pior caso medido, Actions):
 *   · estacao: 1,4 min, rodadas das 06:47 de 31/10 a 07/11 (n=8);
 *   · sungrow: o sg_disp_dia.json GRAVADO (linha "sg_disp_dia.json NN KB" do log do gen-sungrow, menos o inicio da rodada) na rodada
 *     que le o lote novo do dia, as 10:17 de 29/10 a 07/11 (n=9): 9,0 / 10,8 / 10,4 / 11,8 / 10,2 / 11,4 / 10,6 / 12,5 / 10,6 min -> 12,5.
 *     A rodada inteira vai a 17,8 min (os produtos do logger depois do sg_disp); um disparo manual de reparo (01/11 19:38) gravou o
 *     sg_disp aos 20,8 min: fora da rodada diaria;
 *   · executivo: 4,1 min, rodadas das 07:13 de 03 a 07/11 (n=5, 04/11).
 * Folga: 2 min. A ponte: o fim do cofre medido de 22/10 a 07/11 (06:16 a 06:24 nos dias de uma tentativa). Sem rede, sem credencial.
 *    node scripts/ensaio-cadeia-manha.js
 */
const path = require('path');
const AGENDA = require(path.join(__dirname, '..', 'relogio', 'agenda.json'));
const FOLGA = 2;
const PONTE_FIM = 6 * 60 + 24;                 // 06:24 BRT
const DUR = { 'estacao-logger.yml': 1.4, 'sungrow.yml': 12.5, 'executivo.yml': 4.1 };
const ARESTAS = [                               // [escritor, leitor, o que o leitor le]
  ['ponte', 'estacao-logger.yml', 'Estacao_Meteorologica_Logger do cofre'],
  ['ponte', 'sungrow.yml', 'Sungrow_dados do cofre'],
  ['estacao-logger.yml', 'sungrow.yml', 'estacao_logger_30min (irradiancia da disponibilidade)'],
  ['estacao-logger.yml', 'executivo.yml', 'estacao_logger_30min / irr_plano_30min'],
  ['sungrow.yml', 'executivo.yml', 'sg_disp_dia'],
  ['executivo.yml', 'boletim.yml', 'executivo.json, pr_ufv, irr_ufv'],
  ['sungrow.yml', 'boletim.yml', 'sg_disp_dia'],
];

/* minutos de Brasilia (UTC-3) de cada disparo diario de um workflow: cron de 6 campos "s m h * * *" em UTC */
function disparos(agenda, wf) {
  const out = [];
  for (const c of agenda[wf] || []) {
    const [, m, h] = c.split(/\s+/);
    const exp = (campo, max) => campo === '*' ? [...Array(max).keys()] : campo.split(',').flatMap((p) => {
      const [faixa, passo] = p.split('/'); const st = passo ? +passo : 1;
      const [a, b] = faixa === '*' ? [0, max - 1] : faixa.split('-').map(Number);
      const r = []; for (let x = a; x <= (b === undefined ? a : b); x += st) r.push(x); return r;
    });
    for (const hh of exp(h, 24)) for (const mm of exp(m, 60)) out.push(((hh - 3 + 24) % 24) * 60 + mm);
  }
  return out.sort((a, b) => a - b);
}
const primeira = (agenda, wf) => disparos(agenda, wf).find((x) => x >= 5 * 60);
const hm = (x) => String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(Math.round(x % 60)).padStart(2, '0');

/* Para cada workflow, a rodada UTIL da manha: a primeira depois de todos os escritores dele terminarem (+ folga). Um workflow que roda
   uma vez na manha (estacao, sungrow) tem de ter essa rodada como a primeira dele: se a primeira corre antes, ela le o dado velho e a
   proxima so vem horas depois. O executivo roda de hora em hora: vale a primeira depois do sungrow. O boletim gera na PRIMEIRA rodada
   da manha: ela tem de vir depois do executivo e do sungrow. PRAZO: a cadeia inteira pronta ate 09:00. */
const ORDEM = ['estacao-logger.yml', 'sungrow.yml', 'executivo.yml', 'boletim.yml'];
const HORARIA = new Set(['executivo.yml']);
const PRAZO = 9 * 60;
function julga(agenda) {
  const F = [], pronto = { ponte: PONTE_FIM };
  for (const wf of ORDEM) {
    if (!agenda[wf]) continue;
    const esc = ARESTAS.filter((a) => a[1] === wf);
    const precisa = Math.max(...esc.map((a) => pronto[a[0]] === undefined ? -1 : pronto[a[0]])) + FOLGA;
    const util = disparos(agenda, wf).find((x) => x >= precisa);
    const prim = primeira(agenda, wf);
    if (util === undefined || util > PRAZO) { F.push(`${wf}: nenhuma rodada entre ${hm(precisa)} e ${hm(PRAZO)}`); continue; }
    if (!HORARIA.has(wf) && prim < precisa) {
      const a = esc.find((e) => pronto[e[0]] + FOLGA > prim);
      F.push(`${wf} (${hm(prim)}) le ${a[2]} antes de ${a[0]} terminar (${hm(pronto[a[0]])} + ${FOLGA} min)`);
    }
    pronto[wf] = (HORARIA.has(wf) ? util : prim) + (DUR[wf] || 0);
  }
  return F;
}

let ruim = 0;
const real = julga(AGENDA);
if (real.length) { ruim++; console.log('REPROVADO na agenda real:\n  ' + real.join('\n  ')); }
else console.log('ok · agenda real: ' + ['estacao-logger.yml', 'sungrow.yml', 'executivo.yml', 'boletim.yml']
  .map((w) => w.replace('.yml', '') + ' ' + (primeira(AGENDA, w) === undefined ? '—' : hm(primeira(AGENDA, w)))).join(' · '));

/* plantios: cada um tem de reprovar */
const PLANTIOS = [
  ['o sungrow volta para antes da estacao', { 'sungrow.yml': ['0 45 9 * * *'] }],
  ['o executivo das 07:13 corre antes do sungrow terminar', { 'sungrow.yml': ['0 0 10 * * *'] }],
  ['a estacao roda antes do fim da ponte', { 'estacao-logger.yml': ['0 20 9 * * *'] }],
  ['o boletim sai antes do executivo', { 'boletim.yml': ['0 14 10 * * *'] }],
];
for (const [nome, troca] of PLANTIOS) {
  const f = julga(Object.assign({}, AGENDA, troca));
  if (f.length) console.log(`ok · plantio "${nome}" reprovado, como devia (${f[0]})`);
  else { ruim++; console.log(`FALHOU · plantio "${nome}" passou`); }
}
console.log(ruim ? 'ensaio da cadeia da manha: REPROVADO' : 'ensaio da cadeia da manha: APROVADO');
process.exit(ruim ? 1 : 0);
