/*
 * gen-way2-watchdog.js — VIGIA de frescor do dado Way2 (1º gatilho do framework de alertas).
 * Roda a cada ~5 min (junto do way2-recent). Se o dado mais novo passar de LIMIAR_MIN sem
 * atualizar, CONFIRMA a origem consultando a API Way2 DIRETO e dispara um alerta (POST no
 * webhook do Power Automate → e-mail / WhatsApp) — 1x por evento. Quando normaliza, dispara
 * um alerta de normalização com a DURAÇÃO da indisponibilidade.
 *
 * Classifica a origem (a sacada anti-alarme-falso):
 *   - Way2 direto TAMBÉM parado  → FONTE (Way2 caiu) → contatar suporte@way2.com.br
 *   - Way2 direto FRESCO         → PIPELINE (nosso lado: fluxo PA parou de gravar)
 *
 * Estado em dados/way2_watchdog.json (dedup + marca início da queda p/ calcular a duração).
 *
 * Env: DADOS_STORAGE (obrig.), WAY2_TOKEN (p/ a confirmação direta), PA_ALERT_WEBHOOK (URL do
 *   gatilho HTTP do fluxo PA de alertas; se vazio, só loga), LIMIAR_MIN (default 30).
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');

const CONTAINER = 'dados';
const LIMIAR = Math.max(10, (parseInt(process.env.LIMIAR_MIN || '30', 10) || 30));
const WEBHOOK = (process.env.PA_ALERT_WEBHOOK || '').trim();
const SUPORTE = 'suporte@way2.com.br';
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };
const PID = 6233, GRAND = 'Demat'; // totalizador de geração — representa o frescor do complexo

const parseJson = (b) => JSON.parse(b.toString('utf8').replace(/^﻿/, ''));
const nowBRT = () => new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19); // "YYYY-MM-DDTHH:MM:SS" BRT
const ageMin = (naiveTs) => (Date.now() - Date.parse(naiveTs + '-03:00')) / 60000; // ts naive BRT → idade em min
function fmtDur(min) { min = Math.max(0, Math.round(min)); const h = Math.floor(min / 60), m = min % 60; return h ? (h + 'h' + (m ? ' ' + m + 'min' : '')) : (m + ' min'); }
function fmtTs(ts) { return ts ? (ts.slice(11, 16) + ' de ' + ts.slice(8, 10) + '/' + ts.slice(5, 7) + '/' + ts.slice(0, 4)) : '—'; } // "2026-07-13T18:40:00" → "18:40 de 13/07/2026"
function newestTs(dados, pid, g) { const s = (dados || []).find(d => d.pontoId === pid && d.nomeGrandeza === g); if (!s) return null; let b = null; (s.valores || []).forEach(v => { if (v.valor != null) b = v; }); return b ? b.data : null; }

function apiGet(query, token, timeout = 45000) {
  return new Promise((resolve, reject) => {
    const req = https.get({ ...API, path: API.path + '?' + query, headers: { 'Pim-Auth': token }, timeout }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('Way2 HTTP ' + res.statusCode)); }
      let buf = ''; res.on('data', c => buf += c); res.on('end', () => { try { resolve(JSON.parse(buf.replace(/^﻿/, ''))); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject);
  });
}
function postJson(url, obj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const body = JSON.stringify(obj);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 30000 },
      (res) => { res.resume(); res.on('end', () => (res.statusCode < 300 ? resolve(res.statusCode) : reject(new Error('webhook HTTP ' + res.statusCode)))); });
    req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  // 1) idade do dado que o painel mostra (way2_latest leve; fallback way2_eletrico)
  let dados = null;
  for (const nome of ['way2_latest.json', 'way2_eletrico.json']) { const bc = cont.getBlockBlobClient(nome); if (await bc.exists()) { dados = parseJson(await bc.downloadToBuffer()).dados; break; } }
  const nossoTs = dados ? newestTs(dados, PID, GRAND) : null;
  const idade = nossoTs ? ageMin(nossoTs) : 99999;

  // 2) estado anterior
  const sbc = cont.getBlockBlobClient('way2_watchdog.json');
  let st = { estado: 'ok' };
  if (await sbc.exists()) { try { st = parseJson(await sbc.downloadToBuffer()); } catch (e) {} }

  let acao = null;
  if (idade > LIMIAR) {
    // 3) CONFIRMA a origem: Way2 também está parada?
    let origem = 'pipeline', way2Ts = null, detalhe = '';
    try {
      const dia = nowBRT().slice(0, 10);
      const q = `ids=${PID}&grandezas=${GRAND}&contextodasdatas=ConsiderarDiaCheio&intervalo=CincoMinutos&medicao-datainicio=${dia}T00:00:00&medicao-datafim=${dia}T23:59:59&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
      const j = await apiGet(q, token); way2Ts = newestTs(j.dados, PID, GRAND);
      const way2Age = way2Ts ? ageMin(way2Ts) : 99999;
      origem = way2Age > (LIMIAR - 5) ? 'way2' : 'pipeline';
      detalhe = `Way2 (consulta direta) tem dado até ${fmtTs(way2Ts)} (${Math.round(way2Age)} min atrás).`;
    } catch (e) { origem = 'way2'; detalhe = 'A API Way2 nem respondeu à confirmação direta (' + e.message + ').'; }

    if (st.estado !== 'falha') st = { estado: 'falha', desde: nossoTs || nowBRT(), origem, idade_disparo: Math.round(idade), alertado_em: null };
    st.origem = origem;
    if (!st.alertado_em) { // só considera "avisado" quando o POST deu certo (senão re-tenta no próximo run)
      const fonte = origem === 'way2';
      acao = {
        tipo: 'falha', origem, idade_min: Math.round(idade), sem_dados_desde: st.desde, verificado_em: nowBRT(), contato_suporte: fonte ? SUPORTE : '',
        assunto: (fonte ? '🔴' : '🟠') + ' Falha de comunicação Way2 · Mauriti · sem dados há ' + Math.round(idade) + ' min',
        corpo: '<b>A telemetria do Complexo Mauriti está SEM ATUALIZAR desde ' + fmtTs(st.desde) + ' (há ' + Math.round(idade) + ' min).</b><br><br>'
          + 'Verificação automática: ' + detalhe + '<br><br>'
          + (fonte
            ? '➡ <b>ORIGEM: FALHA NA FONTE (Way2)</b>. O serviço da Way2 não está entregando dados novos.<br>➡ <b>AÇÃO: contatar o suporte Way2 — ' + SUPORTE + '</b>'
            : '➡ <b>ORIGEM: NOSSO PIPELINE</b>. A Way2 tem dados novos, mas o fluxo Power Automate parou de gravar o blob.<br>➡ <b>AÇÃO: verificar o fluxo "Way2 Eletrico 5min"</b> no Power Automate.')
          + '<br><br><i>(Alerta automático · watchdog Mauriti · limiar ' + LIMIAR + ' min)</i>'
      };
    }
  } else if (st.estado === 'falha') {
    // 4) NORMALIZOU — dispara com a duração
    const dur = st.desde ? ageMin(st.desde) : 0;
    const ate = nowBRT();
    acao = {
      tipo: 'normalizado', duracao_min: Math.round(dur), ficou_fora_desde: st.desde, ate: ate, origem: st.origem || '—',
      assunto: '✅ Way2 NORMALIZADA · Mauriti (ficou fora ' + fmtDur(dur) + ')',
      corpo: '<b>A telemetria do Complexo Mauriti VOLTOU a atualizar.</b><br><br>'
        + 'Ficou indisponível por <b>' + fmtDur(dur) + '</b>.<br>'
        + '↳ Início da falha: <b>' + fmtTs(st.desde) + '</b><br>'
        + '↳ Normalização: <b>' + fmtTs(ate) + '</b><br>'
        + 'Origem da queda: ' + (st.origem === 'way2' ? 'Way2 (fonte)' : 'nosso pipeline') + '.<br><br><i>(Alerta automático · watchdog Mauriti)</i>'
    };
    st = { estado: 'ok' };
  }

  // 5) dispara + salva estado
  if (acao) {
    let entregue = false;
    if (WEBHOOK) { try { const code = await postJson(WEBHOOK, acao); entregue = true; console.log('ALERTA enviado (HTTP ' + code + '):', acao.tipo, '·', acao.assunto); } catch (e) { console.error('FALHA ao enviar alerta:', e.message); } }
    else console.log('ALERTA (sem PA_ALERT_WEBHOOK — só log):', JSON.stringify(acao));
    if (acao.tipo === 'falha' && entregue && st.estado === 'falha') st.alertado_em = nowBRT(); // marca entregue só se o POST deu certo
  }

  /* ────────────────────────────────────────────────────────────────────────────
   * 6) MEDIDOR INDIVIDUAL SEM COMUNICAÇÃO (lê way2_saude.json)
   *
   * Os medidores Way2 caem e voltam o tempo todo, alternando entre si — confirmado na
   * própria plataforma da Way2. Antes isso passava despercebido (e pior: congelava a
   * leitura do complexo inteiro, pois a âncora exigia os 22 circuitos).
   *
   * ⚠️ GUARDA CONTRA ENXURRADA: só alerta medidor individual se o FEED GERAL estiver
   * saudável. Se o feed inteiro está parado (ex.: na virada da meia-noite, quando o dado
   * do dia novo ainda não chegou), TODOS os 25 medidores parecem velhos — sem esta guarda
   * sairiam 25 e-mails de uma vez. A falha sistêmica já é coberta pelo alerta acima.
   * ──────────────────────────────────────────────────────────────────────────── */
  const LIM_MED = Math.max(30, parseInt(process.env.LIMIAR_MEDIDOR_MIN || '45', 10) || 45);
  st.medidores = st.medidores || {};
  if (idade <= LIMIAR) {                      // feed saudável -> dá para julgar medidor a medidor
    let saude = null;
    try {
      const bc = cont.getBlockBlobClient('way2_saude.json');
      if (await bc.exists()) saude = parseJson(await bc.downloadToBuffer());
    } catch (e) { console.error('saúde: não consegui ler way2_saude.json —', e.message); }

    if (saude && Array.isArray(saude.medidores)) {
      const fora = saude.medidores.filter(m => m.idade_min >= LIM_MED);
      const foraPid = new Set(fora.map(m => String(m.pid)));

      // NOVAS quedas (ainda não avisadas)
      const novos = fora.filter(m => !st.medidores[String(m.pid)]);
      for (const m of novos) st.medidores[String(m.pid)] = { nome: m.nome, desde: m.ultima, alertado_em: null };

      const pendentes = Object.entries(st.medidores).filter(([pid, o]) => foraPid.has(pid) && !o.alertado_em);
      if (pendentes.length) {
        const lista = pendentes.map(([pid, o]) => {
          const m = fora.find(x => String(x.pid) === pid);
          return '<li><b>' + o.nome + '</b> (ponto ' + pid + ') — sem dado desde <b>' + fmtTs(o.desde) + '</b> · há <b>' + fmtDur(m ? m.idade_min : 0) + '</b></li>';
        }).join('');
        const n = pendentes.length;
        const acaoMed = {
          tipo: 'medidor_fora', qtd: n, verificado_em: nowBRT(), contato_suporte: SUPORTE,
          assunto: '🟠 ' + (n === 1 ? 'Medidor Way2 sem comunicação' : n + ' medidores Way2 sem comunicação') + ' · Mauriti',
          corpo: '<b>' + (n === 1 ? 'Um medidor parou' : n + ' medidores pararam') + ' de enviar dados para a Way2.</b><br><br>'
            + '<ul>' + lista + '</ul>'
            + 'O restante da telemetria do complexo está <b>normal</b> (' + saude.resumo.ok + ' de ' + saude.resumo.total + ' medidores saudáveis) — '
            + 'ou seja, <b>não é queda geral da Way2</b>, é medidor específico.<br><br>'
            + '➡ <b>AÇÃO: verificar o medidor em campo</b> e, se necessário, acionar o suporte Way2 — ' + SUPORTE
            + '<br><br><i>(Alerta automático · watchdog Mauriti · limiar ' + LIM_MED + ' min)</i>',
        };
        let ok = false;
        if (WEBHOOK) { try { const c = await postJson(WEBHOOK, acaoMed); ok = true; console.log('ALERTA medidor enviado (HTTP ' + c + '): ' + acaoMed.assunto); } catch (e) { console.error('FALHA alerta medidor:', e.message); } }
        else console.log('ALERTA medidor (sem webhook — só log):', acaoMed.assunto);
        if (ok) for (const [pid] of pendentes) st.medidores[pid].alertado_em = nowBRT();
      }

      // RETORNOS (estava avisado, voltou a reportar)
      const voltaram = Object.entries(st.medidores).filter(([pid, o]) => !foraPid.has(pid) && o.alertado_em);
      if (voltaram.length) {
        const lista = voltaram.map(([pid, o]) => {
          const dur = o.desde ? ageMin(o.desde) : 0;
          return '<li><b>' + o.nome + '</b> (ponto ' + pid + ') — ficou fora <b>' + fmtDur(dur) + '</b>, desde ' + fmtTs(o.desde) + '</li>';
        }).join('');
        const acaoOk = {
          tipo: 'medidor_normalizado', qtd: voltaram.length, verificado_em: nowBRT(),
          assunto: '✅ ' + (voltaram.length === 1 ? 'Medidor Way2 NORMALIZADO' : voltaram.length + ' medidores Way2 NORMALIZADOS') + ' · Mauriti',
          corpo: '<b>' + (voltaram.length === 1 ? 'O medidor voltou' : 'Os medidores voltaram') + ' a enviar dados.</b><br><br><ul>' + lista + '</ul>'
            + '<i>(Alerta automático · watchdog Mauriti)</i>',
        };
        let ok = false;
        if (WEBHOOK) { try { const c = await postJson(WEBHOOK, acaoOk); ok = true; console.log('ALERTA medidor normalizado (HTTP ' + c + '): ' + acaoOk.assunto); } catch (e) { console.error('FALHA alerta normalizado:', e.message); } }
        else console.log('ALERTA medidor normalizado (sem webhook — só log):', acaoOk.assunto);
        if (ok) for (const [pid] of voltaram) delete st.medidores[pid];
      }
      // medidor que voltou mas nunca chegou a ser avisado: limpa sem e-mail
      for (const [pid, o] of Object.entries(st.medidores)) if (!foraPid.has(pid) && !o.alertado_em) delete st.medidores[pid];

      console.log('saúde: ' + saude.resumo.ok + '/' + saude.resumo.total + ' ok · ' + fora.length + ' fora (≥' + LIM_MED + 'min)'
        + (fora.length ? ' -> ' + fora.map(m => m.nome + '=' + m.idade_min + 'min').join(', ') : ''));
    }
  } else {
    console.log('saúde: pulada (feed geral parado há ' + Math.round(idade) + ' min — falha sistêmica, não medidor)');
  }

  const body = JSON.stringify(st); await sbc.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
  console.log('watchdog OK · idade=' + Math.round(idade) + 'min · estado=' + st.estado + (acao ? ' · disparou ' + acao.tipo : ''));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
