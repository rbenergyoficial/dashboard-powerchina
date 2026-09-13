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
// 🔴 E ELE PASSOU A OLHAR O RESULTADO, NAO SO A CADENCIA (13/09/2026).
// Ate aqui ele media se o workflow RODOU. Um job que roda no horario e falha TODA vez saia daqui
// com `conclusao: "failure"` e `ok: 1` ao mesmo tempo — o campo estava publicado e ninguem o
// julgava. Foi assim que o `perdas.yml` ficou vermelho por dois dias, cinco execucoes, sem alarme
// nenhum; e a primeira medicao do criterio novo, feita antes de escrever uma linha, achou um
// SEGUNDO caso que ninguem via: o `render-paineis.yml` rodando a cada 7 min e sem um unico
// sucesso ha 5,6 dias.
//
// A regua e a MESMA — o limite que sai do cron —, aplicada a outra coisa: a idade do ultimo
// SUCESSO. Falha isolada nao acende (o sucesso seguinte devolve a idade a zero); falha que
// persiste alem da cadencia acende. Medido em 18 workflows: 1 acende, e e real.
//
// ⚠️ Execucao EM ANDAMENTO nao conta como falha. Sem isso, todo workflow pego no meio de uma
//    rodada apareceria com o ultimo sucesso "defasado" — medido: dois dos dezoito, no instante
//    da medicao.
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
// 🔴 o alerta sai pela lib compartilhada: ela manda para o webhook do Power Automate E abre uma
//    ISSUE no repositorio. O webhook cai com a licenca; a issue nao depende de nada externo.
const { alerta } = require('./lib-alerta.js');

const AGENDA = require(path.join(__dirname, '..', 'relogio', 'agenda.json'));
const REPO = process.env.GH_REPO || 'rbenergyoficial/dashboard-powerchina';
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const ESTADO = 'relogio_watchdog.json';
const SAUDE = 'relogio_saude.json';
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


(async () => {
  if (!TOKEN) { console.error('RECUSADO: sem GH_TOKEN/GITHUB_TOKEN — nao da para ler as execucoes'); process.exit(1); }
  const agora = Date.now();
  const linhas = [], atrasados = [], quebrados = [], indecididos = [];

  for (const [wf, crons] of Object.entries(AGENDA)) {
    const gap = maiorIntervalo(crons);
    if (gap == null) { indecididos.push(wf); continue; }
    let ult = null, suc = null;
    try {
      const r = await gh('/workflows/' + wf + '/runs?per_page=1');
      ult = (r.workflow_runs || [])[0] || null;
      // a idade do ultimo SUCESSO vem do proprio GitHub, filtrada: um workflow quebrado ha
      // semanas nao caberia numa pagina de execucoes recentes
      const s = await gh('/workflows/' + wf + '/runs?status=success&per_page=1');
      suc = (s.workflow_runs || [])[0] || null;
    } catch (e) { indecididos.push(wf + ' (' + e.message + ')'); continue; }
    if (!ult) { indecididos.push(wf + ' (sem execucao registrada)'); continue; }
    const idade = Math.round((agora - new Date(ult.created_at).getTime()) / 60000);
    const limite = Math.round(gap * TOLERANCIA + MARGEM_MIN);
    const ok = idade <= limite;

    // ── o RESULTADO ────────────────────────────────────────────────────────────────────────
    // ⚠️ `conclusion` nulo e execucao EM ANDAMENTO, nao falha: enquanto ela nao termina, quem
    //    responde pela saude e a anterior, e o ultimo sucesso ainda pode ser ela mesma.
    const idadeOk = suc ? Math.round((agora - new Date(suc.created_at).getTime()) / 60000) : null;
    const rodando = ult.conclusion === null || ult.status !== 'completed';
    // 🔴 sem NENHUM sucesso registrado o vigia NAO inventa veredito: um workflow recem-criado
    //    ainda nao teve chance, e acusa-lo seria alarme que nasce falso.
    const saudavel = (idadeOk === null) ? null : (idadeOk <= limite || rodando ? 1 : 0);

    linhas.push({ wf, cadencia_min: gap, idade_min: idade, limite_min: limite,
      evento: ult.event, conclusao: ult.conclusion, ok: ok ? 1 : 0,
      idade_sucesso_min: idadeOk, saudavel });
    if (!ok) atrasados.push({ wf, idade, limite, cadencia: gap });
    if (saudavel === 0) quebrados.push({ wf, idade: idadeOk, limite, cadencia: gap, conclusao: ult.conclusion });
  }

  linhas.sort((a, b) => (b.idade_min / b.limite_min) - (a.idade_min / a.limite_min));
  linhas.forEach((l) => console.log('  ' + (l.ok && l.saudavel !== 0 ? '   ' : '🔴 ') + l.wf.padEnd(26)
    + 'cadencia ' + String(l.cadencia_min).padStart(4) + ' min · idade ' + String(l.idade_min).padStart(4)
    + ' · limite ' + String(l.limite_min).padStart(4) + ' · ' + l.evento
    + (l.saudavel === 0 ? '  · SEM SUCESSO ha ' + l.idade_sucesso_min + ' min' : '')));
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
      margem_min: MARGEM_MIN, atrasados: atrasados.length, sem_sucesso: quebrados.length,
      workflows: linhas };
    const b = JSON.stringify(saude);
    await cont.getBlockBlobClient(SAUDE).upload(b, Buffer.byteLength(b),
      { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
  }

  // ── alerta, com dedup por workflow ────────────────────────────────────────────────────────
  // ⚠️ 1x por evento: so volta a avisar depois de normalizar. Vigia que repete a cada 5 min
  //    ensina a ignorar o alerta — que e o oposto do que ele existe para fazer.
  // 🔴 AS DUAS FAMILIAS TEM CHAVE PROPRIA, e o estado as guarda separadas. "nao rodou" e "rodou
  //    e falhou" sao diagnosticos diferentes, com causas diferentes — misturar os dois num dedup
  //    so faria o segundo alerta ser engolido pelo primeiro, calado, que e o defeito que este
  //    lote existe para fechar.
  const chaveEstado = (tipo, wf) => tipo + ':' + wf;
  const novos = atrasados.filter((a) => !estado[chaveEstado('cadencia', a.wf)]);
  const voltaram = Object.keys(estado).filter((k) => k.indexOf('cadencia:') === 0)
    .map((k) => k.slice('cadencia:'.length))
    .filter((w) => !atrasados.some((a) => a.wf === w));
  const novosQ = quebrados.filter((a) => !estado[chaveEstado('resultado', a.wf)]);
  const voltaramQ = Object.keys(estado).filter((k) => k.indexOf('resultado:') === 0)
    .map((k) => k.slice('resultado:'.length))
    .filter((w) => !quebrados.some((a) => a.wf === w));

  // 🔴 UM ALERTA POR WORKFLOW, com chave estavel. A chave e o que faz o dedup do canal
  //    funcionar: o mesmo workflow atrasado sempre gera o MESMO titulo de issue, entao a
  //    segunda rodada COMENTA em vez de abrir outra. Chave que carregasse a idade abriria uma
  //    issue a cada 5 min — e issue a cada 5 min ensina a ignorar a issue.
  for (const a of novos) {
    await alerta({
      tipo: 'relogio_atrasado',
      chave: 'cadencia:' + a.wf,
      titulo: a.wf + ' fora da cadencia',
      assunto: '🟠 Mauriti · ' + a.wf + ' nao roda ha ' + a.idade + ' min',
      corpo: '<b>' + a.wf + ' esta fora da cadencia que declara.</b><br><br>'
        + 'Sem rodar ha <b>' + a.idade + ' min</b>. A cadencia do cron dele e de ' + a.cadencia
        + ' min, e o limite (com tolerancia) e ' + a.limite + ' min.<br><br>'
        + 'Quem dispara os workflows e o relogio. Se varios aparecerem juntos, o suspeito e ele: '
        + 'PAT expirado, Function App fora, ou a agenda divergente dos crons.',
      workflow: a.wf, idade_min: a.idade, limite_min: a.limite, cadencia_min: a.cadencia,
    });
  }

  // ── o RESULTADO ────────────────────────────────────────────────────────────────────────────
  for (const a of novosQ) {
    await alerta({
      tipo: 'relogio_sem_sucesso',
      chave: 'resultado:' + a.wf,
      titulo: a.wf + ' roda e falha',
      assunto: '🔴 Mauriti · ' + a.wf + ' nao tem sucesso ha ' + a.idade + ' min',
      corpo: '<b>' + a.wf + ' esta rodando na cadencia e FALHANDO.</b><br><br>'
        + 'A ultima execucao terminou em <b>' + (a.conclusao || 'sem conclusao') + '</b>, e o '
        + 'ultimo sucesso foi ha <b>' + a.idade + ' min</b> — acima do limite de ' + a.limite
        + ' min que a cadencia dele (' + a.cadencia + ' min) admite.<br><br>'
        + 'ISTO NAO E PROBLEMA DO RELOGIO: o disparo esta funcionando. O que falha e o proprio '
        + 'job, e a causa esta no log da execucao. Enquanto durar, o dado que ele publica esta '
        + 'parado na ultima rodada que deu certo.',
      workflow: a.wf, idade_sucesso_min: a.idade, limite_min: a.limite, cadencia_min: a.cadencia,
    });
  }
  for (const w of voltaramQ) {
    await alerta({
      tipo: 'relogio_sucesso_normalizado', resolve: true,
      chave: 'resultado:' + w,
      titulo: w + ' roda e falha',
      assunto: '✅ Mauriti · ' + w + ' voltou a concluir com sucesso',
      corpo: '<b>' + w + ' voltou a terminar com sucesso dentro da cadencia que declara.</b>',
      workflow: w,
    });
  }

  // ⚠️ NORMALIZAR TAMBEM E NOTICIA. Antes isso so ia para o log da execucao; agora fecha a
  //    issue do evento, e o estado fica legivel sem ninguem abrir log nenhum.
  for (const w of voltaram) {
    await alerta({
      tipo: 'relogio_normalizado', resolve: true,
      chave: 'cadencia:' + w,
      titulo: w + ' fora da cadencia',
      assunto: '✅ Mauriti · ' + w + ' voltou a cadencia',
      corpo: '<b>' + w + ' voltou a rodar dentro da cadencia que declara.</b>',
      workflow: w,
    });
  }

  if (cont) {
    const st = {};
    const agoraIso = new Date().toISOString();
    atrasados.forEach((a) => { const k = chaveEstado('cadencia', a.wf); st[k] = estado[k] || agoraIso; });
    quebrados.forEach((a) => { const k = chaveEstado('resultado', a.wf); st[k] = estado[k] || agoraIso; });
    const b = JSON.stringify(st);
    await cont.getBlockBlobClient(ESTADO).upload(b, Buffer.byteLength(b),
      { blobHTTPHeaders: { blobContentType: 'application/json' } });
  }

  console.log('\n  ' + linhas.length + ' workflows julgados · '
    + (atrasados.length ? '🔴 ' + atrasados.length + ' fora da cadencia' : 'todos dentro da cadencia') + ' · ' + (quebrados.length ? '🔴 ' + quebrados.length + ' rodando e falhando (' + quebrados.map((q) => q.wf).join(', ') + ')' : 'todos com sucesso recente'));
  // 🔴 NAO derruba o job: o vigia informa, nao interrompe a coleta que ele acompanha.
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
