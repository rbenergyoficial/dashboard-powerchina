/*
 * gen-must-watchdog.js — VIGIA dos nove medidores dedicados do MUST.
 *
 * ══ POR QUE ELE EXISTE ═══════════════════════════════════════════════════════════════════════
 *
 * 🔴 Em 23/08/2026 o M6 parou de reportar as 02:15 e a telemetria de MUST inteira parou as 05:35.
 * O painel de saude continuou marcando MEDIDORES 24/24 — e estava CERTO: o `way2_saude.json` e
 * construido a partir do `way2_eletrico.json`, que tem exatamente 25 pontos (6196-6219 + 6233),
 * os medidores de GERACAO. Conferido no blob: nenhum dos pontos 6380-6388 esta la, porque o fluxo
 * do Power Automate nao os coleta.
 *
 * Ou seja: os nove medidores que sustentam a pagina de MUST NAO ERAM VIGIADOS POR NINGUEM. A queda
 * so apareceu porque um humano abriu a pagina e viu "Sem dados".
 *
 * ⚠️ E a ausencia nao deixa rastro no blob: o gerador descarta valor nulo, entao um instante em que
 * TODOS os parques estao fora simplesmente nao vira linha. A serie termina, e nao ha registro
 * dizendo que ela deveria continuar. Mesma forma do defeito do painel de saude corrigido de manha:
 * ausencia representada por ausencia. Por isso o vigia compara com o RELOGIO, nunca com o proprio
 * dado.
 *
 * ══ 🔴 A MEDICAO QUE MUDOU O DESENHO ═════════════════════════════════════════════════════════
 *
 * A primeira versao vigiava a idade do BLOB, com limiares de 45/90 min derivados do cron de 15 min
 * declarado no must-intra.yml. Medindo as 48 execucoes agendadas mais recentes, o cron REAL:
 *
 *     intervalo entre execucoes   minimo 14 · mediana 23 · p90 47 · MAXIMO 101 min
 *     duracao do job              mediana 0,5 · maximo 11 min
 *     -----------------------------------------------------------------------------
 *     idade normal do blob no pior caso = 101 + 11 + 16 (latencia da fonte) = 128 min
 *
 * A deriva do agendador do GitHub e MAIOR que a interrupcao que se quer detectar. Vigiar o blob
 * com limiar apertado daria alarme falso todo dia; afrouxa-lo ate 128 min tornaria o vigia cego
 * a uma queda de duas horas. Os dois lados perdem — o sinal esta na variavel errada.
 *
 * ══ O DESENHO QUE FICOU: DUAS IDADES, DOIS PROPOSITOS ════════════════════════════════════════
 *
 * IDADE NA FONTE (sinal primario) — consulta direta a Way2 a cada rodada. Nao depende do nosso
 *   cron, entao aceita limiar apertado: registro 45 min, e-mail 90 min. E ela que responde a
 *   pergunta que interessa: "o medidor esta medindo?".
 *
 * IDADE DO BLOB (sinal secundario) — so denuncia PIPELINE PARADO, e por isso leva limiar folgado
 *   (registro 180, e-mail 240), acima do pior caso normal medido de 128 min. Sem ele, um
 *   must-intra quebrado passaria despercebido enquanto a fonte seguisse sadia.
 *
 * A combinacao tambem CLASSIFICA a origem sem adivinhar:
 *     fonte velha                  -> a Way2 parou           -> suporte
 *     fonte fresca + blob velho    -> o nosso pipeline parou -> workflow
 *     sem credencial               -> INDETERMINADA          -> nao acusa ninguem
 *
 * ══ O QUE ELE PRODUZ ═════════════════════════════════════════════════════════════════════════
 *
 *   must_saude.json     — estado por parque, para o painel (leitura)
 *   must_watchdog.json  — estado do EVENTO, para nao repetir e-mail e medir a duracao
 *
 * Env: DADOS_STORAGE (obrig. fora de LOCAL_OUT), WAY2_TOKEN (o sinal primario depende dele),
 *      PA_ALERT_WEBHOOK (vazio = so loga), LIMIAR_MIN (45), LIMIAR_EMAIL_MIN (90),
 *      LIMIAR_BLOB_MIN (180), LIMIAR_BLOB_EMAIL_MIN (240), LEMBRETE_H (2), LEMBRETE_TETO_H (12),
 *      LOCAL_OUT (ensaio: nao grava estado, nao dispara), FONTE_URL (ensaio: recorte gravado).
 */
const https = require('https');

const CONTAINER = 'dados';
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const FONTE = 'must_5min.json';        // a resolucao mais fina: e a que denuncia a queda mais cedo
// FONTE_URL existe para o ENSAIO poder apontar para um recorte gravado de uma queda REAL. Um vigia
// que so foi visto no caminho feliz nao esta testado: o que importa nele e o ramo que quase nunca
// roda. Em producao a variavel nao e definida e o caminho e o de cima.

// pontoId -> parque. A MESMA tabela do gen-must.js; duplicar aqui e deliberado, porque o vigia
// precisa saber consultar a fonte sozinho mesmo que o gerador esteja quebrado.
const PONTOS = { 6380: 'M1', 6381: 'M2', 6382: 'M3', 6383: 'M4', 6384: 'M5',
                 6385: 'M6', 6386: 'M7', 6387: 'M8', 6388: 'M9' };
const IDS = Object.keys(PONTOS);
const PARQUES = Object.values(PONTOS);
const GRAND = 'Demat';

const num = (v, d) => Math.max(1, parseInt(v || String(d), 10) || d);
const LIMIAR = Math.max(10, num(process.env.LIMIAR_MIN, 45));              // fonte · registro
const LIMIAR_EMAIL = Math.max(LIMIAR, num(process.env.LIMIAR_EMAIL_MIN, 90));
// 🔴 acima do pior caso NORMAL medido (128 min): abaixo disso o alarme seria da deriva do cron
const LIMIAR_BLOB = Math.max(LIMIAR, num(process.env.LIMIAR_BLOB_MIN, 180));
const LIMIAR_BLOB_EMAIL = Math.max(LIMIAR_BLOB, num(process.env.LIMIAR_BLOB_EMAIL_MIN, 240));
const LEMBRETE_BASE = Math.max(30, num(process.env.LEMBRETE_H, 2) * 60);
const LEMBRETE_TETO = Math.max(LEMBRETE_BASE, num(process.env.LEMBRETE_TETO_H, 12) * 60);
const proximoLembrete = (n) => Math.min(LEMBRETE_TETO, LEMBRETE_BASE * Math.pow(2, Math.max(0, n - 1)));
const WEBHOOK = (process.env.PA_ALERT_WEBHOOK || '').trim();
const SUPORTE = 'suporte@way2.com.br';
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };

const nowBRT = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19);
const ageMin = (ts) => (Date.now() - Date.parse(ts + '-03:00')) / 60000;
const fmtDur = (min) => { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? (h + 'h' + (m ? ' ' + m + 'min' : '')) : (m + ' min'); };
const fmtTs = (ts) => ts ? (ts.slice(11, 16) + ' de ' + ts.slice(8, 10) + '/' + ts.slice(5, 7) + '/' + ts.slice(0, 4)) : '—';
const lista = (a) => !a.length ? '—' : a.length === 1 ? a[0] : a.slice(0, -1).join(', ') + ' e ' + a[a.length - 1];

// 🔴 So o 404 devolve vazio. Qualquer outra falha ESTOURA — a licao de 23/08: um leitor que
// confunde "falhou" com "nao existe" faz o gerador tratar queda de rede como primeira execucao.
function leBlob(url) {
  // o modulo sai do PROTOCOLO: em producao e sempre https; o ensaio serve o recorte gravado
  // por http em 127.0.0.1, e assim testa o mesmo codigo que roda de verdade
  const mod = url.startsWith('http:') ? require('http') : https;
  return new Promise((ok, ko) => {
    mod.get(url, { headers: { 'accept-encoding': 'gzip' } }, res => {
      if (res.statusCode === 404) { res.resume(); return ok(null); }
      if (res.statusCode !== 200) { res.resume(); return ko(new Error('HTTP ' + res.statusCode + ' ao ler ' + url)); }
      const cru = /gzip/i.test(res.headers['content-encoding'] || '') ? res.pipe(require('zlib').createGunzip()) : res;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('error', e => ko(new Error('descompressao falhou: ' + e.message)));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(new Error('JSON invalido: ' + e.message)); } });
    }).on('error', e => ko(new Error('rede falhou: ' + e.message)));
  });
}
function apiGet(query, token, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': token }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('fonte HTTP ' + res.statusCode)); }
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b.replace(/^﻿/, ''))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const body = JSON.stringify(obj);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 },
      (res) => { res.resume(); res.on('end', () => (res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error('webhook HTTP ' + res.statusCode)))); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  const ensaio = !!process.env.LOCAL_OUT;
  const conn = process.env.DADOS_STORAGE, token = (process.env.WAY2_TOKEN || '').trim();
  if (!conn && !ensaio) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }

  // ══ 1 · SINAL PRIMARIO — idade na FONTE, que nao depende do nosso cron ═══════════════════════
  // Janela curta de proposito: bastam as ultimas horas para saber se o medidor esta medindo, e
  // pedir o dia inteiro a cada 15 min seria carga sem retorno.
  const fonteIdade = {};                      // parque -> idade em min (null = sem leitura na janela)
  let fonteOk = false, fonteErro = '';
  if (token) {
    try {
      const iniMs = Date.now() - 6 * 3600 * 1000;
      const iso = (ms) => new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19);
      const q = 'ids=' + IDS.join(',') + '&grandezas=' + GRAND + '&contextodasdatas=ConsiderarDiaCheio'
        + '&intervalo=CincoMinutos&medicao-datainicio=' + iso(iniMs) + '&medicao-datafim=' + nowBRT()
        + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';
      const j = await apiGet(q, token);
      for (const id of IDS) {
        const s = (j.dados || []).find(x => String(x.pontoId) === String(id) && x.nomeGrandeza === GRAND);
        let ult = null; ((s || {}).valores || []).forEach(v => { if (v.valor != null) ult = v.data; });
        fonteIdade[PONTOS[id]] = ult ? Math.round(ageMin(ult)) : null;
      }
      fonteOk = true;
    } catch (e) { fonteErro = e.message; }
  } else fonteErro = 'sem credencial';

  // ══ 2 · SINAL SECUNDARIO — idade do BLOB, que denuncia PIPELINE parado ═══════════════════════
  const blob = await leBlob(process.env.FONTE_URL || (BASE + FONTE));
  if (!blob) { console.error('ERRO: ' + FONTE + ' nao existe.'); process.exit(1); }
  const ultimo = {};
  for (const l of (blob.serie || [])) for (const p of PARQUES) if (l[p] != null && (!ultimo[p] || l.t > ultimo[p])) ultimo[p] = l.t;

  const medidores = PARQUES.map((p, i) => {
    const ts = ultimo[p] ? ultimo[p].slice(0, 19) : null;
    const ib = ts ? Math.round(ageMin(ts)) : null;
    const iF = fonteOk ? fonteIdade[p] : undefined;
    // o estado do MEDIDOR sai da FONTE quando ela responde; do blob so quando nao ha outro jeito
    const estado = fonteOk
      ? ((iF != null && iF <= LIMIAR) ? 'ok' : 'falha')
      : ((ib != null && ib <= LIMIAR_BLOB) ? 'ok' : 'falha');
    return { parque: p, pid: +IDS[i], ultima_blob: ts, idade_blob_min: ib,
             idade_fonte_min: fonteOk ? iF : null, estado };
  });
  const foraFonte = fonteOk ? medidores.filter(m => m.idade_fonte_min == null || m.idade_fonte_min > LIMIAR) : [];
  const idadesBlob = medidores.map(m => m.idade_blob_min).filter(x => x != null);
  const blobIdade = idadesBlob.length ? Math.min(...idadesBlob) : null;
  // 🔴 DUAS perguntas diferentes, e confundi-las abre um buraco. `blobVelho` = o pipeline PAROU
  // (nenhum parque recebeu nada). `foraBlob` = ESTES parques pararam, com os outros chegando —
  // que e a forma da queda de 23/08, em que so o M6 caiu. A primeira versao so tinha `blobVelho`,
  // entao no caminho sem credencial um parque isolado fora nao gerava alerta nenhum.
  const foraBlob = medidores.filter(m => m.idade_blob_min == null || m.idade_blob_min > LIMIAR_BLOB);
  const blobVelho = foraBlob.length === PARQUES.length;

  console.log('MUST · fonte: registro ' + LIMIAR + ' / e-mail ' + LIMIAR_EMAIL
    + ' min   ·   blob: registro ' + LIMIAR_BLOB + ' / e-mail ' + LIMIAR_BLOB_EMAIL + ' min');
  console.log('  parque  ponto   idade na fonte   idade no blob   estado');
  medidores.forEach(m => console.log('   ' + m.parque.padEnd(6) + m.pid + '   '
    + (fonteOk ? String(m.idade_fonte_min == null ? 'sem leitura' : m.idade_fonte_min + ' min').padStart(13)
              : '     (nao lida)')
    + '   ' + String(m.idade_blob_min == null ? 'sem leitura' : m.idade_blob_min + ' min').padStart(13)
    + '   ' + m.estado.toUpperCase()));
  if (!fonteOk) console.log('  ⚠️ fonte NAO consultada (' + fonteErro + ') — o julgamento caiu no blob, com limiar folgado');
  console.log('  fora na fonte: ' + (foraFonte.length ? foraFonte.map(m => m.parque).join(', ') : 'nenhum')
    + '   ·   fora no blob: ' + (foraBlob.length ? foraBlob.map(m => m.parque).join(', ') : 'nenhum')
    + (blobVelho ? '  (TODOS — pipeline parado)' : ''));

  // carencia pos-meia-noite: o primeiro balde do dia demora a aparecer pela latencia da fonte
  const minDoDia = (() => { const s = nowBRT().slice(11, 19).split(':').map(Number); return s[0] * 60 + s[1]; })();
  const carencia = minDoDia < (LIMIAR + 20);

  // ══ 3 · estado anterior ══════════════════════════════════════════════════════════════════════
  let cont = null, st = { estado: 'ok' };
  if (!ensaio) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
    const sbc = cont.getBlockBlobClient('must_watchdog.json');
    if (await sbc.exists()) { try { st = JSON.parse((await sbc.downloadToBuffer()).toString('utf8').replace(/^﻿/, '')); } catch (e) {} }
  }

  // ══ 4 · julgamento ═══════════════════════════════════════════════════════════════════════════
  // 🔴 TRES origens, nao duas. Sem credencial o vigia NAO acusa o fornecedor: afirma so o que mediu.
  let origem = null, nomes = [], idadeTxt = null, desdeTxt = null, limiarEmail = LIMIAR_EMAIL, detalhe = '';
  if (fonteOk && foraFonte.length) {
    origem = 'way2'; nomes = foraFonte.map(m => m.parque);
    const ids = foraFonte.map(m => m.idade_fonte_min).filter(x => x != null).sort((a, b) => a - b);
    idadeTxt = ids.length ? ids[0] : null;
    desdeTxt = foraFonte.map(m => m.ultima_blob).filter(Boolean).sort().slice(-1)[0] || nowBRT();
    detalhe = 'Consulta direta a fonte: ' + lista(nomes) + ' sem leitura nova la.';
  } else if (fonteOk && blobVelho) {
    origem = 'pipeline'; nomes = PARQUES.slice();
    idadeTxt = blobIdade; limiarEmail = LIMIAR_BLOB_EMAIL;
    desdeTxt = medidores.map(m => m.ultima_blob).filter(Boolean).sort().slice(-1)[0] || nowBRT();
    detalhe = 'A fonte tem leitura nova nos nove medidores, mas o blob do MUST nao recebeu.';
  } else if (!fonteOk && foraBlob.length) {
    origem = 'indeterminada'; nomes = foraBlob.map(m => m.parque);
    const ib = foraBlob.map(m => m.idade_blob_min).filter(x => x != null).sort((a, b) => a - b);
    idadeTxt = ib.length ? ib[0] : null; limiarEmail = LIMIAR_BLOB_EMAIL;
    desdeTxt = foraBlob.map(m => m.ultima_blob).filter(Boolean).sort().slice(-1)[0] || nowBRT();
    detalhe = 'A verificacao contra a fonte nao pode ser feita (' + fonteErro + ').';
  }

  let acao = null;
  if (origem && !carencia) {
    if (st.estado !== 'falha') st = { estado: 'falha', desde: desdeTxt, origem, alertado_em: null, avisos: 0 };
    st.parques = nomes; st.origem = origem; st.idadeTxt = idadeTxt;
    const maduro = (idadeTxt == null) || (idadeTxt >= limiarEmail);
    const lembrete = !!st.alertado_em && ageMin(st.alertado_em) >= proximoLembrete(st.avisos || 1);
    if (maduro && (!st.alertado_em || lembrete)) {
      const parcial = nomes.length < PARQUES.length;
      const desdeFmt = fmtTs(st.desde);
      acao = {
        tipo: 'falha', escopo: 'must', origem, parques: nomes, idade_min: idadeTxt,
        sem_dados_desde: st.desde, verificado_em: nowBRT(), lembrete,
        contato_suporte: origem === 'way2' ? SUPORTE : '',
        assunto: (origem === 'way2' ? '🔴' : origem === 'pipeline' ? '🟠' : '⚠️') + ' '
          + (lembrete ? 'AINDA sem dados' : 'Falha de comunicação')
          + ' · medidores de MUST · ' + (parcial ? lista(nomes) : 'os nove parques')
          + ' · desde ' + desdeFmt,
        corpo: '<b>Os medidores dedicados do MUST pararam de atualizar.</b><br><br>'
          + '↳ Afetados: <b>' + lista(nomes) + '</b>' + (parcial ? ' (' + nomes.length + ' de 9)' : ' — todos') + '<br>'
          + '↳ Última leitura registrada: <b>' + desdeFmt + '</b><br>'
          + '↳ ' + (idadeTxt != null ? fmtDur(idadeTxt) + ' no momento deste alerta' : 'sem leitura na janela verificada')
          + '<br><br>'
          + '<i>' + (lembrete ? 'Lembrete' : 'Primeiro aviso') + ' gerado em ' + fmtTs(nowBRT())
          + '. Se você está lendo isto mais tarde, a interrupção pode ser maior.</i><br><br>'
          + 'Verificação automática: ' + detalhe + '<br><br>'
          + (origem === 'way2'
            ? '➡ <b>ORIGEM: FALHA NA FONTE (Way2)</b>.<br>➡ <b>AÇÃO: contatar o suporte Way2 — ' + SUPORTE + '</b>'
            : origem === 'pipeline'
              ? '➡ <b>ORIGEM: NOSSO PIPELINE</b>. A fonte tem leitura nova, mas o blob do MUST não recebeu.<br>➡ <b>AÇÃO: verificar o workflow must-intra.</b>'
              : '➡ <b>ORIGEM NÃO CONFIRMADA.</b> A verificação contra a fonte não pôde ser feita, então este '
                + 'alerta afirma apenas o que mediu: o dado parou de chegar.<br>'
                + '➡ <b>AÇÃO: verificar primeiro o workflow must-intra; se ele estiver verde, contatar ' + SUPORTE + '.</b>')
          + '<br><br><b>O que fica sem número enquanto durar:</b> a demanda contra o MUST contratado '
          + 'destes parques, e o Complexo — que é a soma simultânea dos nove e por isso não é '
          + 'calculado quando falta um.'
          + '<br><br><i>(Alerta automático · vigia de MUST · e-mail a partir de ' + limiarEmail + ' min)</i>',
      };
    }
  } else if (!origem && st.estado === 'falha') {
    const dur = st.desde ? ageMin(st.desde) : 0;
    // 🔴 A CONFIRMACAO SO SAI SE HOUVE AVISO — normalizar uma queda que ninguem soube que comecou
    // e ruido puro. Mesma regra do watchdog de geracao.
    acao = (st.avisos || 0) > 0 ? {
      tipo: 'normalizado', escopo: 'must', duracao_min: Math.round(dur),
      ficou_fora_desde: st.desde, ate: nowBRT(), parques: st.parques || [], avisos: st.avisos || 0,
      assunto: '✅ Medidores de MUST NORMALIZADOS · ficaram fora ' + fmtDur(dur),
      corpo: '<b>Os medidores do MUST voltaram a atualizar.</b><br><br>'
        + '<b>PRAZO TOTAL DE INDISPONIBILIDADE: ' + fmtDur(dur) + '</b><br>'
        + '↳ Afetados: <b>' + lista(st.parques || []) + '</b><br>'
        + '↳ Início: <b>' + fmtTs(st.desde) + '</b><br>'
        + '↳ Normalização: <b>' + fmtTs(nowBRT()) + '</b><br>'
        + '↳ Avisos enviados no período: <b>' + (st.avisos || 0) + '</b><br><br>'
        + '<i>(Alerta automático · vigia de MUST)</i>',
    } : null;
    st = { estado: 'ok', normalizado_em: nowBRT(), duracao_min: Math.round(dur) };
  } else if (!origem) {
    st = { estado: 'ok', verificado_em: nowBRT() };
  }

  // ══ 5 · dispara, e so marca como avisado se o POST deu certo ═════════════════════════════════
  if (acao) {
    if (ensaio || !WEBHOOK) { console.log('\n[ensaio] ' + acao.assunto); }
    else {
      try {
        await postJson(WEBHOOK, acao);
        if (acao.tipo === 'falha') { st.alertado_em = nowBRT(); st.avisos = (st.avisos || 0) + 1; }
        console.log('\nalerta enviado: ' + acao.assunto);
      } catch (e) { console.error('\nfalha ao enviar alerta: ' + e.message); }
    }
  }

  // ══ 6 · saude para o painel, e estado para o dedup ═══════════════════════════════════════════
  const saude = {
    atualizado: nowBRT(), fonte_consultada: fonteOk,
    limiar_fonte_min: LIMIAR, limiar_fonte_email_min: LIMIAR_EMAIL,
    limiar_blob_min: LIMIAR_BLOB, limiar_blob_email_min: LIMIAR_BLOB_EMAIL,
    total: PARQUES.length, ok: medidores.filter(m => m.estado === 'ok').length,
    falha: medidores.filter(m => m.estado === 'falha').length,
    idade_blob_min: blobIdade, medidores,
  };
  if (ensaio) {
    require('fs').writeFileSync(process.env.LOCAL_OUT + 'must_saude.json', JSON.stringify(saude));
    console.log('\n[ensaio] must_saude.json escrito localmente · estado NAO gravado');
  } else {
    for (const [nome, obj] of [['must_saude.json', saude], ['must_watchdog.json', st]]) {
      const b = JSON.stringify(obj);
      await cont.getBlockBlobClient(nome).upload(b, Buffer.byteLength(b),
        { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    }
    console.log('\nmust_saude.json e must_watchdog.json gravados · estado=' + st.estado);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
