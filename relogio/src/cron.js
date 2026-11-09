// O RELOGIO DE UM TEMPORIZADOR SO: le a agenda (NCRONTAB de 6 campos, UTC) e diz quais workflows
// tocam num minuto. Lote relogio-um-temporizador (09/11/2026).
//
// 🔴 POR QUE UM SO
// Com um temporizador por linha da agenda (35 em 09/11), o Azure consultava o estado de cada um a cada ~10 s:
// 10 a 12 mil leituras por hora na conta de armazenamento do relogio, ~R$ 25/mes so disso (medido no Cost
// Management, "Hot Read Operations" do relogiofunc, e na metrica Transactions/GetBlob: 254.655 em 07/11 com 31
// temporizadores, 303.992 em 08/11 com 35). Um temporizador de minuto faz a mesma coisa com 1/35 das leituras.
//
// ⚠️ O que o relogio dispara NAO muda: a agenda continua gerada dos workflows (gerar-agenda.js) e conferida no CI.
'use strict';

const LIM = [[0, 59], [0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const MIN = 60 * 1000;

function campo(txt, i) {
  const [lo, hi] = LIM[i];
  const s = new Set();
  for (const parte of txt.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(parte);
    if (!m) throw new Error('campo de cron nao reconhecido: "' + txt + '"');
    let a = lo, b = hi;
    if (m[1] !== '*') {
      const [x, y] = m[1].split('-').map(Number);
      a = x;
      b = y === undefined ? (m[2] ? hi : x) : y;
    }
    const passo = m[2] ? Number(m[2]) : 1;
    if (!(passo >= 1) || a < lo || b > hi || a > b) throw new Error('campo fora da faixa: "' + txt + '"');
    for (let v = a; v <= b; v += passo) s.add(v);
  }
  return s;
}

// Devolve um teste (Date -> bool) para o MINUTO. Recusa, na carga, o que este relogio nao sabe tocar: segundo
// diferente de 0 e dia do mes junto com dia da semana (a semantica OU/E muda entre implementacoes). Recusar na
// carga faz o deploy ficar vermelho; tocar errado em silencio e o pior modo de falhar desta casa.
function compila(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 6) throw new Error('NCRONTAB precisa de 6 campos: "' + expr + '"');
  const c = f.map(campo);
  if (c[0].size !== 1 || !c[0].has(0)) throw new Error('o relogio so toca no segundo 0: "' + expr + '"');
  if (f[3] !== '*' && f[5] !== '*') throw new Error('dia do mes e dia da semana juntos: "' + expr + '"');
  return (d) => c[1].has(d.getUTCMinutes()) && c[2].has(d.getUTCHours()) && c[3].has(d.getUTCDate())
    && c[4].has(d.getUTCMonth() + 1) && c[5].has(d.getUTCDay());
}

function regras(agenda) {
  return Object.entries(agenda).map(([wf, crons]) => ({ wf, testes: crons.map(compila) }));
}

// Quais workflows disparar agora. `ultimoMs` e a ultima ocorrencia que o proprio Azure registrou (scheduleStatus.last);
// varre os minutos de depois dela ate o minuto atual, INCLUSIVE o atual. Cada workflow sai UMA vez, mesmo que tenha
// varios horarios no intervalo: e o que o temporizador antigo fazia ao voltar de uma parada (isPastDue dispara uma vez).
// ⚠️ A varredura para em 6 h, o mesmo teto da guarda anti-empilhamento (um job do GitHub morre em 6 h): depois de uma
// parada maior, o que ficou para tras ja nao e "atrasado", e o horario seguinte de cada workflow resolve.
const TETO_ATRASO_MS = 6 * 60 * MIN;

// ⚠️ O temporizador pode disparar alguns milissegundos ANTES da virada do minuto (relogio do host): sem folga, 12:59:59.9 seria
// lido como 12:59 e os workflows das 13:00 nunca sairiam (a execucao seguinte ja comeca depois de 13:00). 5 s de folga.
const ADIANTO_MS = 5000;

function plano(rs, ultimoMs, agoraMs) {
  const agora = Math.floor((agoraMs + ADIANTO_MS) / MIN) * MIN;
  let de = Number.isFinite(ultimoMs) ? Math.floor(ultimoMs / MIN) * MIN + MIN : agora;
  if (de > agora) de = agora;
  if (de < agora - TETO_ATRASO_MS) de = agora - TETO_ATRASO_MS;
  const sai = [];
  for (const r of rs) {
    for (let t = de; t <= agora; t += MIN) {
      const d = new Date(t);
      if (r.testes.some((f) => f(d))) { sai.push(r.wf); break; }
    }
  }
  return { de: new Date(de).toISOString(), ate: new Date(agora).toISOString(), workflows: sai };
}

module.exports = { compila, regras, plano, TETO_ATRASO_MS };
