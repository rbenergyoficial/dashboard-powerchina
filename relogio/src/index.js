// O RELOGIO — dispara os workflows do repo na cadencia que eles proprios declaram.
//
// 🔴 POR QUE ELE EXISTE
// O agendador do GitHub entrega uma fracao do que o cron pede. Medido em 01/09/2026, 40 execucoes
// de cada workflow:
//
//     way2-recent   39 de 40 por dispatch externo   mediana   5 min   pior caso     5 min
//     executivo     24 de 40 pelo agendador         mediana 159 min   pior caso   970 min
//
// Os dois declaram cron. A diferenca e so QUEM aperta o botao. Quem apertava era um fluxo do Power
// Automate, por HTTP — conector premium, licenca com prazo. Este relogio ocupa esse lugar sem
// depender de licenca nenhuma.
//
// ⚠️ Ele NAO coleta e NAO gera nada. So dispara. Toda a logica continua nos geradores do repo, com
// as guardas e o gauntlet que eles ja tem — mover isso para ca seria risco real para resolver um
// problema de relogio.

'use strict';
const { app } = require('@azure/functions');
const AGENDA = require('../agenda.json');

const REPO = process.env.GH_REPO || 'rbenergyoficial/dashboard-powerchina';
const REF = process.env.GH_REF || 'main';
const API = 'https://api.github.com/repos/' + REPO + '/actions';

function cabecalho() {
  const t = process.env.GH_TOKEN;
  if (!t) throw new Error('GH_TOKEN nao definido nas configuracoes do aplicativo');
  return {
    Authorization: 'Bearer ' + t,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'relogio-mauriti'
  };
}

async function gh(caminho, init = {}) {
  const r = await fetch(API + caminho, { ...init, headers: { ...cabecalho(), ...(init.headers || {}) } });
  if (r.status === 204) return null;
  const corpo = await r.text();
  if (!r.ok) throw Object.assign(new Error('GitHub HTTP ' + r.status + ': ' + corpo.slice(0, 200)), { status: r.status });
  return corpo ? JSON.parse(corpo) : null;
}

// 🔴 A GUARDA CONTRA EMPILHAR. O `way2-recent` roda a cada 5 min e leva 1 a 2; se um dia levar
// mais, disparar em cima gera fila. Foi assim que o fluxo do Power Automate foi throttled em
// 09/07/2026 — com runs zumbis marcadas como canceladas segurando o slot por 10h+. Os workflows
// tem `concurrency` propria; isto e o cinto por cima do suspensorio, do lado de quem chama.
async function jaRodando(wf) {
  const r = await gh('/workflows/' + wf + '/runs?per_page=5&status=in_progress')
    .catch(() => null);
  const q = await gh('/workflows/' + wf + '/runs?per_page=5&status=queued').catch(() => null);
  return ((r && r.total_count) || 0) + ((q && q.total_count) || 0) > 0;
}

async function dispara(wf, log) {
  if (await jaRodando(wf)) { log.warn(`${wf}: ja ha execucao em andamento — pulando`); return 'pulado'; }
  await gh('/workflows/' + wf + '/dispatches', {
    method: 'POST',
    body: JSON.stringify({ ref: REF }),
    headers: { 'Content-Type': 'application/json' }
  });
  log.info(`${wf}: disparado`);
  return 'disparado';
}

// Um temporizador por linha da agenda. A agenda e GERADA dos proprios workflows (ver
// gerar-agenda.js) e conferida no CI: se alguem mudar um cron no workflow e nao aqui, fica
// vermelho — em vez de o relogio continuar tocando no horario antigo, calado.
for (const [wf, crons] of Object.entries(AGENDA)) {
  crons.forEach((schedule, i) => {
    const nome = 'dispara-' + wf.replace(/\.yml$/, '') + (crons.length > 1 ? '-' + (i + 1) : '');
    app.timer(nome, {
      schedule,                    // NCRONTAB: 6 campos, UTC (o mesmo fuso do cron do GitHub)
      runOnStartup: false,         // subir o app nao e motivo para disparar tudo de uma vez
      handler: async (_t, ctx) => {
        try { await dispara(wf, ctx); }
        catch (e) {
          // Estourar de proposito: no Azure isso vira execucao falha e fica visivel. Engolir aqui
          // deixaria o relogio parado sem ninguem saber, que e como se perde dado sem alarme.
          ctx.error(`${wf}: FALHOU — ${e.message}`);
          throw e;
        }
      }
    });
  });
}

// Sonda manual: abre /api/saude e diz o que o relogio acha que tem de fazer. Serve para conferir
// que a agenda subiu inteira, sem esperar o proximo horario.
app.http('saude', {
  methods: ['GET'],
  authLevel: 'function',
  handler: async () => {
    const linhas = Object.entries(AGENDA).map(([wf, c]) => ({ workflow: wf, horarios: c }));
    return {
      jsonBody: {
        repo: REPO, ref: REF,
        temTokenn: Boolean(process.env.GH_TOKEN),
        workflows: linhas.length,
        temporizadores: linhas.reduce((s, x) => s + x.horarios.length, 0),
        agenda: linhas
      }
    };
  }
});
