/* idade-blob.js — diz se um blob publico esta VELHO, para um passo condicional.
 *
 * Existe porque o agendador do GitHub nao cumpre o cron: medido em 45 execucoes do
 * `executivo.yml`, o cron declara 15/dia e ele entrega 5,6, com p90 de 615 min entre
 * execucoes; o `perdas.yml` declara uma por dia e simplesmente nao rodou em 31/08.
 * Quem roda de verdade a cada 5 minutos e o `way2-recent`, porque e disparado de fora.
 * Entao o job confiavel passa a cobrir o que o agendador esquece — mas so quando o
 * resultado ja esta velho, para nao pagar o custo a cada cinco minutos.
 *
 * uso: node scripts/idade-blob.js <blob> <horas> [janela_min]
 *
 * ⚠️ `janela_min` limita as tentativas aos primeiros N minutos de cada hora, e existe
 * por causa de um modo de falha real: o job que hospeda isto roda a cada 5 min com
 * `cancel-in-progress`, e o passo pesado leva ~204 s. Medido, o ciclo cabe (253 s de 300),
 * mas com 47 s de folga — se um dia nao couber, o job e cancelado, o blob continua velho
 * e a tentativa se repetiria a cada cinco minutos para sempre. Com a janela, o pior caso
 * e uma tentativa por hora.
 * escreve `velho=true|false` em $GITHUB_OUTPUT e imprime a idade medida.
 */
const https = require('https');
const fs = require('fs');

const BASE = process.env.BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const blob = process.argv[2];
const horas = Number(process.argv[3] || 3);
const janela = process.argv[4] == null ? null : Number(process.argv[4]);
if (!blob || !isFinite(horas)) { console.error('uso: idade-blob.js <blob> <horas> [janela_min]'); process.exit(2); }

const saida = (velho, msg) => {
  console.log(msg);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'velho=' + velho + '\n');
};

https.request(BASE + blob, { method: 'HEAD', family: 4 }, (r) => {
  r.resume();
  // 🔴 404 conta como VELHO: blob que nao existe e o caso em que mais se quer gerar.
  //    Qualquer outra resposta estranha tambem, porque o custo de gerar a toa e 3 min
  //    e o custo de nao gerar e a pagina ficar parada por um dia.
  if (r.statusCode !== 200) return saida(true, blob + ': HTTP ' + r.statusCode + ' — trata como velho');
  const lm = r.headers['last-modified'];
  if (!lm) return saida(true, blob + ': sem last-modified — trata como velho');
  const h = (Date.now() - new Date(lm).getTime()) / 3600000;
  const min = new Date().getUTCMinutes();
  const naJanela = janela == null || min < janela;
  const idade = blob + ': ' + h.toFixed(1) + ' h de idade (limite ' + horas + ' h)';
  if (h < horas) return saida(false, idade + ' — fresco, pula');
  if (!naJanela) return saida(false, idade + ' — velho, mas fora da janela (minuto ' + min + ')');
  saida(true, idade + ' — VELHO, vai gerar');
}).on('error', (e) => saida(true, blob + ': ' + e.message + ' — trata como velho')).end();
