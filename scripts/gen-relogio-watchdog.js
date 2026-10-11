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
// o ultimo sucesso, o veredito e quem abre/fecha moram numa lib que o ensaio julga (PROMOVER vigia-desmente)
const VIG = require('./lib-vigia.js');

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
  const agoraIso = new Date(agora).toISOString();

  // ── o estado ANTES de julgar: a rodada decide quem abre e quem fecha contra ele ─────────────
  // 🔴 so `exists() === false` e ausencia. Erro de leitura NAO vira estado vazio: com estado vazio o vigia esqueceria
  //    o alarme aberto (o ✅ nunca chegaria) e reabriria o que ja esta aberto. Estado ilegivel (ou que nao e um objeto
  //    de chaves e datas): a lib nao decide nada por workflow e nada se grava no estado, mas a saude sai e o aviso proprio
  //    e pedido (PROMOVER vigia-desmente-2 — na primeira versao o vigia parava aqui e ficava mudo se o blob nao se lesse).
  // 🔴 E O STORAGE INTEIRO PODE FALHAR (credencial trocada, 403): toda E/S do blob fica em try, e cada falha vai para o
  //    mesmo aviso. O dedup dele e a issue aberta (`soSeNova`), que nao depende do storage.
  const conn = process.env.DADOS_STORAGE;
  let cont = null, estado = {}, estadoLegivel = true;
  const falhasStorage = [];
  if (conn) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
    try {
      const bc = cont.getBlockBlobClient(ESTADO);
      if (await bc.exists()) {
        const lido = JSON.parse((await bc.downloadToBuffer()).toString('utf8'));
        if (!VIG.estadoValido(lido)) throw new Error(ESTADO + ' nao e um objeto de chaves e datas (' + JSON.stringify(lido).slice(0, 60) + ')');
        estado = lido;
      }
    } catch (e) { estadoLegivel = false; estado = {}; falhasStorage.push('ler ' + ESTADO + ': ' + e.message); console.error('ESTADO ILEGIVEL: ' + e.message); }
  }

  // ── a leitura: as respostas do GitHub vao CRUAS para a lib ──────────────────────────────────
  // a lista das 100 ultimas traz a ultima execucao e os sucessos recentes; a filtrada so alcanca o sucesso mais velho
  // que isso (e em 07/10/2026 devolveu um de 22 dias com o real a 9 h: vale o mais recente das duas, na lib)
  const entradas = [];
  for (const [wf, crons] of Object.entries(AGENDA)) {
    const gap = maiorIntervalo(crons);
    if (gap == null) { entradas.push({ wf, gap: null }); continue; }
    try {
      const r = await gh('/workflows/' + wf + '/runs?per_page=100');
      const s = await gh('/workflows/' + wf + '/runs?status=success&per_page=1');
      entradas.push({ wf, gap, lista: r.workflow_runs || [], filtrado: (s.workflow_runs || [])[0] || null });
    } catch (e) { entradas.push({ wf, gap, erro: e.message }); }
  }
  const R = VIG.rodada({ agora, agoraIso, agenda: Object.keys(AGENDA), entradas, estado,
    tolerancia: TOLERANCIA, margem: MARGEM_MIN, estadoLegivel });
  const { linhas, atrasados, quebrados, indecididos, novos, voltaram, novosQ, voltaramQ, sairam } = R;

  linhas.forEach((l) => console.log('  ' + (l.ok && l.saudavel !== 0 ? '   ' : '🔴 ') + l.wf.padEnd(26)
    + 'cadencia ' + String(l.cadencia_min).padStart(4) + ' min · idade ' + String(l.idade_min).padStart(4)
    + ' · limite ' + String(l.limite_min).padStart(4) + ' · ' + l.evento
    + (l.saudavel === 0 ? '  · SEM SUCESSO ha ' + l.idade_sucesso_min + ' min' : '')
    + (l.pendente ? '  · em andamento, ultimo sucesso ha ' + l.idade_sucesso_min + ' min (alarme mantido como estava)' : '')));
  if (indecididos.length) console.log('  sem julgamento (alarmes mantidos como estavam): ' + indecididos.join(', '));

  // ── saude no blob ─────────────────────────────────────────────────────────────────────────
  if (cont) {
    const b = JSON.stringify(R.saude);
    try {
      await cont.getBlockBlobClient(SAUDE).upload(b, Buffer.byteLength(b),
        { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    } catch (e) { falhasStorage.push('gravar ' + SAUDE + ': ' + e.message); }
  }

  // ── alerta, com dedup por workflow ────────────────────────────────────────────────────────
  // ⚠️ 1x por evento: so volta a avisar depois de normalizar. Vigia que repete a cada 5 min
  //    ensina a ignorar o alerta — que e o oposto do que ele existe para fazer.
  // 🔴 AS DUAS FAMILIAS TEM CHAVE PROPRIA, e o estado as guarda separadas. "nao rodou" e "rodou
  //    e falhou" sao diagnosticos diferentes, com causas diferentes — misturar os dois num dedup
  //    so faria o segundo alerta ser engolido pelo primeiro, calado.
  // 🔴 QUEM ABRE E QUEM FECHA sai da lib (lib-vigia.js): o alarme de resultado so fecha para o workflow julgado saudavel,
  //    o de cadencia so para o lido e em dia; pendente e nao lido mantem o estado. Ate 10/10/2026 a execucao em
  //    andamento fechava o alarme com um ✅ falso, e a rodada seguinte abria issue nova.

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

  // o workflow que SAIU DA AGENDA nao voltou nem se recuperou: as duas familias fecham com o que de fato aconteceu
  for (const w of sairam) {
    for (const [fam, tit] of [['cadencia', ' fora da cadencia'], ['resultado', ' roda e falha']]) {
      if (!estado[fam + ':' + w]) continue;
      await alerta({
        tipo: 'relogio_fora_da_agenda', resolve: true,
        chave: fam + ':' + w,
        titulo: w + tit,
        assunto: 'ℹ️ Mauriti · ' + w + ' saiu da agenda do relogio',
        corpo: '<b>' + w + ' saiu da agenda do relogio</b> e deixou de ser vigiado. O alarme fecha por isso, nao porque '
          + 'o workflow voltou a rodar ou a ter sucesso.',
        workflow: w,
      });
    }
  }

  if (cont && R.estado) {
    const b = JSON.stringify(R.estado);
    try {
      await cont.getBlockBlobClient(ESTADO).upload(b, Buffer.byteLength(b),
        { blobHTTPHeaders: { blobContentType: 'application/json' } });
    } catch (e) { falhasStorage.push('gravar ' + ESTADO + ': ' + e.message); }
  }

  // o vigia sem o estado (ou sem o storage): o aviso proprio, pedido em TODA rodada assim e deduplicado pela issue aberta
  // (`soSeNova`); na rodada em que tudo se le e se grava, ele e fechado (sem issue aberta, nada sai).
  // 🔴 o job so fica VERMELHO se esse aviso nao chega a canal nenhum: o aviso e o canal, e um vermelho a cada rodada
  //    (~72 por dia) ensinaria a ignorar o vermelho do vigia (decisao de 11/10/2026, RE-025).
  if (R.avisoEstado === 'abre' || falhasStorage.length) {
    const r = await alerta({
      soSeNova: true,
      tipo: 'vigia_estado_ilegivel',
      chave: 'vigia:estado',
      titulo: 'vigia sem o estado dos alarmes',
      assunto: '🔴 Mauriti · o vigia nao consegue ler o estado dos alarmes',
      corpo: '<b>O vigia nao consegue ler ou gravar o estado dos alarmes no storage.</b><br><br>' + falhasStorage.join('<br>')
        + '<br><br>Enquanto durar, o vigia pode nao saber quais alarmes estao abertos: lido nada, nenhum alarme de workflow '
        + 'abre nem fecha e a saude sai marcada como sem estado; nao gravado, os avisos da rodada podem se repetir. Se o '
        + 'arquivo ' + ESTADO + ' estiver corrompido, apaga-lo faz o vigia recomecar do zero (os alarmes ainda abertos voltam '
        + 'a ser avisados); se for a credencial do storage, o segredo DADOS_STORAGE do repositorio.',
    });
    // chegou = a issue foi aberta, comentada ou JA ESTA aberta (numero de verdade), ou o webhook respondeu 2xx, ou o e-mail saiu
    const chegou = !!r && (/^(abriu|comentou) #\d|^ja aberta #[1-9]/.test(r.issue || '') || /^HTTP 2/.test(r.webhook || '')
      || (!!r.email && r.email !== '-' && !/^FALHOU/.test(r.email)));
    console.error('\n  🔴 storage: ' + falhasStorage.join(' · ') + (R.estado ? '' : ' — nenhum alarme de workflow decidido nesta rodada'));
    if (!chegou) { console.error('  🔴 e o aviso nao chegou a canal nenhum'); process.exitCode = 1; }
  } else {
    await alerta({
      tipo: 'vigia_estado_legivel', resolve: true,
      chave: 'vigia:estado',
      titulo: 'vigia sem o estado dos alarmes',
      assunto: '✅ Mauriti · o vigia voltou a ler o estado dos alarmes',
      corpo: '<b>O vigia voltou a ler ' + ESTADO + '</b> e os alarmes de workflow voltaram a abrir e fechar.',
    });
  }

  console.log('\n  ' + linhas.length + ' workflows julgados · '
    + (atrasados.length ? '🔴 ' + atrasados.length + ' fora da cadencia' : 'todos dentro da cadencia') + ' · ' + (quebrados.length ? '🔴 ' + quebrados.length + ' rodando e falhando (' + quebrados.map((q) => q.wf).join(', ') + ')' : 'todos com sucesso recente'));
  // 🔴 NAO derruba o job: o vigia informa, nao interrompe a coleta que ele acompanha.
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
