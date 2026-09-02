// gen-relogio-watchdog.js — o workflow rodou dentro da cadencia que ele declara?
//
// 🔴 POR QUE ELE EXISTE
// O relogio (Azure Function) dispara os workflows na cadencia dos proprios crons, porque o
// agendador do GitHub entrega ~1/3 do que declara (medido em 01/09/2026: `executivo` com mediana
// de 159 min e pior caso de 970 para um cron horario). Se o relogio parar — PAT expirado, Function
// App fora, agenda divergente — nada fica vermelho: os workflows voltam a depender do agendador e
// a suite so fica velha. **Silencio nao e sinal.**
//
// ⚠️ E o mesmo vale para a COLETA: desde que o `continue-on-error` saiu do passo da Way2, uma
// falha dela fica vermelha no job — mas so se o job RODAR. Este vigia cobre o caso de o job nao
// rodar, que o job nao tem como cobrir sozinho.
//
// COMO ELE DECIDE
// O limite nao e escolhido: sai do PROPRIO cron. Simula-se a expressao NCRONTAB por 48 h e toma-se
// o MAIOR intervalo entre disparos — para `0 */15 * * * *` da 15 min; para `0 13 4,9-22 * * *` da
// as ~6 h entre as 22:13 e as 04:13 do dia seguinte. O alerta e o maior intervalo vezes a
// tolerancia, mais uma margem fixa para a duracao do proprio job.
//
// Env: GH_TOKEN ou GITHUB_TOKEN (actions: read) · GH_REPO · DADOS_STORAGE (estado e saude)
//      PA_ALERT_WEBHOOK (opcional) · TOLERANCIA (padrao 2.5) · MARGEM_MIN (padrao 20)
'use strict';
const https = require('https');
const path = require('path');

const AGENDA = require(path.join(__dirname, '..', 'relogio', 'agenda.json'));
const REPO = process.env.GH_REPO || 'rbenergyoficial/dashboard-powerchina';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const ESTADO = 'relogio_watchdog.json';
const SAUDE = 'relogio_saude.json';
const WEBHOOK = (process.env.PA_ALERT_WEBHOOK || '').trim();
const TOLERANCIA = Number(process.env.TOLERANCIA || 2.5);
const MARGEM_MIN = Number(process.env.MARGEM_MIN || 20);

// ── NCRONTAB: so os campos que a agenda usa (`*`, `*/n`, lista, faixa) ───────────────────────
// ⚠️ Nao e um parser geral, e nao finge ser: se aparecer uma forma que ele nao entende, ele
//    RECUSA aquele workflow em vez de adivinhar um limite. Limite adivinhado e pior que nenhum.
function campo(exp, min, max) {
  if (exp === '*') { const s = new Set(); for (let i = min; i <= max; i++) s.add(i); return s; }
  const s = new Set();
  for (const parte of exp.split(',')) {
    let m;
    if ((m = parte.match(/^\*\/(\d+)$/))) { for (let i = min; i <= max; i += Number(m[1])) s.add(i); continue; }
    if ((m = parte.match(/^(\d+)-(\d+)$/))) { for (let i = Number(m[1]); i <= Number(m[2]); i++) s.add(i); continue; }
    if ((m = parte.match(/^(\d+)$/))) { s.add(Number(m[1])); continue; }
    return null;                                  // forma desconhecida -> recusa
  }
  return s;
}

// maior intervalo entre disparos, em minutos, simulando 48 h a partir de agora
function maiorIntervalo(crons) {
  const conj = [];
  for (const c of crons) {
    const p = String(c).trim().split(/\s+/);
    if (p.length !== 6) return null;
    const mi = campo(p[1], 0, 59), ho = campo(p[2], 0, 23);
    const di = campo(p[3], 1, 31), me = campo(p[4], 1, 12), sem = campo(p[5], 0, 6);
    if (!mi || !ho || !di || !me || !sem) return null;
    conj.push({ mi, ho, di, me, sem });
  }
  const t0 = Date.now() - (Date.now() % 60000);
  const marcas = [];
  for (let k = 0; k < 48 * 60; k++) {
    const d = new Date(t0 + k * 60000);
    const bate = conj.some((c) => c.mi.has(d.getUTCMinutes()) && c.ho.has(d.getUTCHours())
      && c.di.has(d.getUTCDate()) && c.me.has(d.getUTCMonth() + 1) && c.sem.has(d.getUTCDay()));
    if (bate) marcas.push(k);
  }
  if (marcas.length < 2) return null;
  let maior = 0;
  for (let i = 1; i < marcas.length; i++) maior = Math.max(maior, marcas[i] - marcas[i - 1]);
  return maior;
}

// ── GitHub ───────────────────────────────────────────────────────────────────────────────────
function gh(caminho) {
  return new Promise((ok, ko) => {
    https.get({ host: 'api.github.com', path: '/repos/' + REPO + '/actions' + caminho, family: 4,
      headers: { 'User-Agent': 'relogio-watchdog', Authorization: 'Bearer ' + TOKEN,
        Accept: 'application/vnd.github+json' } }, (r) => {
      const b = []; r.on('data', (c) => b.push(c));
      r.on('end', () => {
        if (r.statusCode !== 200) return ko(new Error('GitHub HTTP ' + r.statusCode));
        try { ok(JSON.parse(Buffer.concat(b).toString())); } catch (e) { ko(e); }
      });
    }).on('error', ko);
  });
}

function postJson(url, obj) {
  return new Promise((ok, ko) => {
    const u = new URL(url); const body = JSON.stringify(obj);
    const r = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000 }, (res) => { res.resume();
      res.on('end', () => (res.statusCode < 300 ? ok(res.statusCode) : ko(new Error('webhook HTTP ' + res.statusCode)))); });
    r.on('error', ko); r.write(body); r.end();
  });
}

(async () => {
  if (!TOKEN) { console.error('RECUSADO: sem GH_TOKEN/GITHUB_TOKEN — nao da para ler as execucoes'); process.exit(1); }
  const agora = Date.now();
  const linhas = [], atrasados = [], indecididos = [];

  for (const [wf, crons] of Object.entries(AGENDA)) {
    const gap = maiorIntervalo(crons);
    if (gap == null) { indecididos.push(wf); continue; }
    let ult = null;
    try {
      const r = await gh('/workflows/' + wf + '/runs?per_page=1');
      ult = (r.workflow_runs || [])[0] || null;
    } catch (e) { indecididos.push(wf + ' (' + e.message + ')'); continue; }
    if (!ult) { indecididos.push(wf + ' (sem execucao registrada)'); continue; }
    const idade = Math.round((agora - new Date(ult.created_at).getTime()) / 60000);
    const limite = Math.round(gap * TOLERANCIA + MARGEM_MIN);
    const ok = idade <= limite;
    linhas.push({ wf, cadencia_min: gap, idade_min: idade, limite_min: limite,
      evento: ult.event, conclusao: ult.conclusion, ok: ok ? 1 : 0 });
    if (!ok) atrasados.push({ wf, idade, limite, cadencia: gap });
  }

  linhas.sort((a, b) => (b.idade_min / b.limite_min) - (a.idade_min / a.limite_min));
  linhas.forEach((l) => console.log('  ' + (l.ok ? '   ' : '🔴 ') + l.wf.padEnd(26)
    + 'cadencia ' + String(l.cadencia_min).padStart(4) + ' min · idade ' + String(l.idade_min).padStart(4)
    + ' · limite ' + String(l.limite_min).padStart(4) + ' · ' + l.evento));
  if (indecididos.length) console.log('  sem julgamento: ' + indecididos.join(', '));

  // ── estado e saude no blob ────────────────────────────────────────────────────────────────
  const conn = process.env.DADOS_STORAGE;
  let cont = null, estado = {};
  if (conn) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
    try {
      const bc = cont.getBlockBlobClient(ESTADO);
      if (await bc.exists()) estado = JSON.parse((await bc.downloadToBuffer()).toString('utf8'));
    } catch (e) { console.error('estado: ' + e.message); }
    const saude = { gerado_em: new Date().toISOString(), tolerancia: TOLERANCIA,
      margem_min: MARGEM_MIN, atrasados: atrasados.length, workflows: linhas };
    const b = JSON.stringify(saude);
    await cont.getBlockBlobClient(SAUDE).upload(b, Buffer.byteLength(b),
      { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
  }

  // ── alerta, com dedup por workflow ────────────────────────────────────────────────────────
  // ⚠️ 1x por evento: so volta a avisar depois de normalizar. Vigia que repete a cada 5 min
  //    ensina a ignorar o alerta — que e o oposto do que ele existe para fazer.
  const novos = atrasados.filter((a) => !estado[a.wf]);
  const voltaram = Object.keys(estado).filter((w) => !atrasados.some((a) => a.wf === w));
  if (novos.length && WEBHOOK) {
    const acao = { tipo: 'relogio_atrasado',
      assunto: 'Mauriti · ' + novos.length + ' workflow(s) fora da cadencia',
      corpo: novos.map((a) => a.wf + ': ' + a.idade + ' min sem rodar (cadencia ' + a.cadencia
        + ' min, limite ' + a.limite + ')').join('\n') };
    try { console.log('ALERTA enviado (HTTP ' + (await postJson(WEBHOOK, acao)) + '): ' + acao.assunto); }
    catch (e) { console.error('FALHA ao enviar alerta: ' + e.message); }
  } else if (novos.length) {
    console.log('ALERTA (sem PA_ALERT_WEBHOOK — so log): ' + novos.map((a) => a.wf).join(', '));
  }

  if (cont) {
    const st = {};
    atrasados.forEach((a) => { st[a.wf] = estado[a.wf] || new Date().toISOString(); });
    const b = JSON.stringify(st);
    await cont.getBlockBlobClient(ESTADO).upload(b, Buffer.byteLength(b),
      { blobHTTPHeaders: { blobContentType: 'application/json' } });
  }
  if (voltaram.length) console.log('  normalizaram: ' + voltaram.join(', '));

  console.log('\n  ' + linhas.length + ' workflows julgados · '
    + (atrasados.length ? '🔴 ' + atrasados.length + ' fora da cadencia' : 'todos dentro da cadencia'));
  // 🔴 NAO derruba o job: o vigia informa, nao interrompe a coleta que ele acompanha.
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
