/*
 * gen-must-watchdog.js — VIGIA da medicao de MUST.
 *
 * ══ 🔴 CORRECAO DE PREMISSA (23/08/2026, apontada pelo humano) ════════════════════════════════
 *
 * A primeira versao deste arquivo chamava os pontos 6380-6388 de "medidores dedicados do MUST".
 * ISSO ESTA ERRADO, e o erro saiu por e-mail para outras pessoas antes de ser visto.
 *
 * NAO EXISTE MEDIDOR DE MUST. Sao os MESMOS medidores fisicos da geracao; o que a fonte publica
 * nesses pontos e um valor CALCULADO — a demanda no ponto de conexao, obtida aplicando uma equacao
 * de perdas sobre a mesma medicao. Ponto calculado, nao instrumento.
 *
 * A consequencia nao e so de vocabulario. Se a origem e a mesma, os dois vigias caem JUNTOS:
 * medido em 23/08/2026, `way2_watchdog` e `must_watchdog` registraram falha no MESMO instante
 * (13:30) e mandaram DOIS e-mails para UMA queda — as 14:30 e as 15:09. Eu tinha acabado de
 * reduzir o volume de e-mail a pedido do humano, e criei um segundo remetente para o mesmo evento.
 *
 * ══ O QUE ELE VIGIA, ENTAO ═══════════════════════════════════════════════════════════════════
 *
 * O que este vigia acrescenta ao da geracao NAO e a coleta — e a CONTA. A medicao pode chegar e o
 * valor de MUST nao ser publicado (equacao, ponto calculado, publicacao do ponto). Esse e o caso
 * que so ele enxerga, e e o unico em que ele avisa por conta propria.
 *
 * 🔴 QUANDO A COLETA INTEIRA CAI, ELE FICA CALADO. O registro continua (o painel le o estado), mas
 * o e-mail e do vigia da geracao, que e quem tem a origem certa. Dois avisos para um evento nao
 * informam o dobro: fazem o leitor parar de ler os dois.
 *
 * ══ O QUE ELE PRODUZ ═════════════════════════════════════════════════════════════════════════
 *
 *   must_saude.json     — estado por parque, para o painel (leitura)
 *   must_watchdog.json  — estado do EVENTO, para nao repetir e-mail e medir a duracao
 *
 * ══ LIMIARES, medidos ════════════════════════════════════════════════════════════════════════
 *
 * IDADE NA FONTE (primaria) — consulta direta a cada rodada, nao depende do nosso cron:
 *   registro 45 min, e-mail 90 min.
 * IDADE DO BLOB (secundaria) — so denuncia pipeline parado, e leva limiar folgado (180/240),
 *   acima do pior caso NORMAL medido de 128 min, porque o cron do GitHub deriva ate 101 min.
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

  // ══ 2b · A COLETA INTEIRA CAIU? ══════════════════════════════════════════════════════════════
  // 🔴 Se sim, o e-mail e do vigia da GERACAO. Este registra e cala. Medido em 23/08/2026: os dois
  // marcaram falha no MESMO instante (13:30) e mandaram dois e-mails para uma queda — porque a
  // origem e a mesma medicao. Dois avisos para um evento nao informam o dobro.
  let coletaCaida = false, estadoGer = null;
  try {
    estadoGer = await leBlob(BASE + 'way2_watchdog.json');
    coletaCaida = !!estadoGer && estadoGer.estado === 'falha';
  } catch (e) { /* sem o estado da geracao, este vigia volta a decidir sozinho */ }

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
    st.calado_por_coleta = coletaCaida || undefined;
    if (coletaCaida) {
      console.log('  a coleta inteira esta em falha (vigia da geracao desde '
        + ((estadoGer || {}).desde || '?') + ') — REGISTRADO, sem e-mail: o aviso e de la.');
    } else if (maduro && (!st.alertado_em || lembrete)) {
      const parcial = nomes.length < PARQUES.length;
      const desdeFmt = fmtTs(st.desde);
      acao = {
        tipo: 'falha', escopo: 'must', origem, parques: nomes, idade_min: idadeTxt,
        sem_dados_desde: st.desde, verificado_em: nowBRT(), lembrete,
        contato_suporte: origem === 'way2' ? SUPORTE : '',
        assunto: (origem === 'way2' ? '🔴' : origem === 'pipeline' ? '🟠' : '⚠️') + ' MUST '
          + (lembrete ? 'AINDA sem dados' : 'sem dados') + ' desde ' + fmtTs(st.desde)
          + ' · ' + (parcial ? lista(nomes) : 'os nove parques'),
        // 🔴 CURTO DE PROPOSITO. O primeiro aviso tinha oito paragrafos, e o humano apontou:
        // "estou vendo muita informacao para um aviso". Um alerta e uma INTERRUPCAO — ele precisa
        // dizer o que parou, ha quanto tempo, e o que fazer. O resto disputa atencao com essas
        // tres coisas e faz o leitor parar de ler.
        corpo: '<b>A medição de MUST parou às ' + fmtTs(st.desde) + '</b>'
          + (idadeTxt != null ? ' — ' + fmtDur(idadeTxt) + ' no momento deste alerta.' : '.')
          + '<br><br>'
          + 'Afetados: <b>' + (parcial ? lista(nomes) + ' (' + nomes.length + ' de 9)' : 'os nove parques') + '</b><br>'
          + (origem === 'way2'
            ? 'Origem: falha na fonte · <b>Ação: suporte@way2.com.br</b>'
            : origem === 'pipeline'
              ? 'Origem: nosso pipeline · <b>Ação: verificar o workflow must-intra</b>'
              : 'Origem não confirmada · <b>Ação: verificar o must-intra; se estiver verde, ' + SUPORTE + '</b>')
          + '<br><br><i>vigia de MUST · e-mail a partir de ' + limiarEmail + ' min</i>',
      };
    }
  } else if (!origem && st.estado === 'falha') {
    const dur = st.desde ? ageMin(st.desde) : 0;
    // 🔴 A CONFIRMACAO SO SAI SE HOUVE AVISO — normalizar uma queda que ninguem soube que comecou
    // e ruido puro. Mesma regra do watchdog de geracao.
    acao = (st.avisos || 0) > 0 ? {
      tipo: 'normalizado', escopo: 'must', duracao_min: Math.round(dur),
      ficou_fora_desde: st.desde, ate: nowBRT(), parques: st.parques || [], avisos: st.avisos || 0,
      assunto: '✅ MUST normalizado · ficou fora ' + fmtDur(dur),
      corpo: '<b>A medição de MUST voltou às ' + fmtTs(nowBRT()) + '.</b><br><br>'
        + 'Ficou fora <b>' + fmtDur(dur) + '</b>, de ' + fmtTs(st.desde) + '.'
        + '<br><br><i>vigia de MUST</i>',
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
