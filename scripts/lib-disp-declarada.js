'use strict';
/*
 * lib-disp-declarada.js — a disponibilidade DECLARADA ao operador nacional (`disp_pct` do executivo), media mensal do
 * campo `disp` do arquivo do conjunto (MW por meia hora) sobre a outorga (PROMOVER disp-janela, 10/10/2026). Saiu do
 * `gen-executivo.js` para o ensaio de regra (`ensaio-disp-declarada.js`) julgar a MESMA conta que o gerador roda.
 *
 * A JANELA E FIXA, 04:00 a 17:30 (inicio do patamar; cobre das 04h as 18h), em TODOS os meses. O operador mudou tres
 * vezes o que publica no campo, e a media sobre "o que veio" mudava de janela junto com ele:
 *   - set/25 a 06/07/2026: as 48 meias horas;
 *   - 07/07 a 30/09/2026: so 04:00 a 19:30 (32), a madrugada vinha zerada;
 *   - out/2026: tudo menos 18:00 a 20:00 (43), e a madrugada voltou com o conjunto SEM o M2 e o M6 (~270,1 MW =
 *     343,77 − 24,555 − 49,109), a mesma disponibilidade zero dessas duas usinas que a NT-MRT-2026-0057 contesta.
 * Com a media sobre o que veio, out/26 incluia a noite e jul–set nao: 90,20 % contra 99,10 % em set, comparando janelas
 * diferentes, e a variacao do cartao em pontos percentuais media a troca de janela. 04:00–17:30 e a unica janela
 * publicada em todos os meses (mapa por mes e meia hora no livro do pipeline, lote `disp-janela`).
 *
 * DENTRO da janela, `disp` <= 0 continua sendo AUSENCIA de publicacao, nao indisponibilidade: fica fora da media e
 * aparece na cobertura (`disp_cobertura_pct` = declarados / patamares da janela que o arquivo trouxe).
 *
 * O QUE ISTO NAO E: a disponibilidade medida no inversor (`disp_inv_pct`, `lib-disponibilidade.js`). E o valor que o
 * operador registrou, com as revisoes dele; muda quando ele revisa.
 */
const JANELA = { de: '04:00', ate: '17:30' };   // HH:MM do INICIO do patamar, os dois inclusive

const r2 = (x) => Math.round(x * 100) / 100;
// o `ts` do arquivo do conjunto e hora LOCAL de Brasilia, 'AAAA-MM-DD HH:MM:SS'. Outro formato (um ISO em UTC, '…T07:00:00Z',
// que sao 04:00 aqui) deslocaria a janela em silencio: fica fora, e o mes inteiro nesse formato sai NULO, nao errado.
const FORMATO_TS = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
const naJanela = (ts) => { const s = String(ts); if (!FORMATO_TS.test(s)) return false;
  const h = s.slice(11, 16); return h >= JANELA.de && h <= JANELA.ate; };

/* acumuladores do mes: { disp, n_disp, n_janela } — o gerador os guarda no objeto do mes, ao lado dos outros */
function novo() { return { disp: 0, n_disp: 0, n_janela: 0 }; }

/* uma linha do arquivo do conjunto ({ ts: 'AAAA-MM-DD HH:MM:SS', disp }) no acumulador do mes dela */
function acumula(m, r) {
  if (!naJanela(r.ts)) return;
  m.n_janela++;
  const d = Number(r.disp);
  if (Number.isFinite(d) && d > 0) { m.disp += d; m.n_disp++; }
}

/* { disp_pct, disp_cobertura_pct } do mes; nulos quando nada foi declarado na janela */
function fecha(m, capMw) {
  return {
    disp_pct: m.n_disp ? r2(m.disp / m.n_disp / capMw * 100) : null,
    disp_cobertura_pct: m.n_janela ? r2(100 * m.n_disp / m.n_janela) : null,
  };
}

module.exports = { JANELA, naJanela, novo, acumula, fecha };
