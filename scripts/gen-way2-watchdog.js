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
 * Env: DADOS_STORAGE (obrig.), WAY2_TOKEN (p/ a confirmação direta), LIMIAR_MIN (default 30).
 *   Os destinos do alerta vêm do `lib-alerta` (PA_ALERT_WEBHOOK e/ou GITHUB_TOKEN + GH_REPO).
 *
 * 🔴 POR QUE ESTE VIGIA PASSOU A USAR O `lib-alerta` (02/09/2026)
 * Ele falava DIRETO no `PA_ALERT_WEBHOOK` — o gatilho HTTP de um fluxo do Power Automate. Ou
 * seja: o vigia que existe para avisar quando a telemetria congela tinha um canal só, e esse
 * canal morre com a licença.
 *
 * ⚠️ E ele vigia a ÚNICA entrada de dado do ao-vivo: `way2_eletrico.json` é a raiz de
 * `way2_saude` (32 dashboards), `way2_latest` (9), `kpis_dia` (3) e do portal. Ficar sem voz
 * aqui significa a suíte inteira congelar sem ninguém saber — some o alerta E some a notícia
 * de que ele sumiu.
 *
 * O `lib-alerta` ACRESCENTA a issue no próprio repositório, que não depende de licença nenhuma
 * (o `GITHUB_TOKEN` do Actions basta) e avisa por e-mail quem acompanha o repo. O webhook
 * continua ligado enquanto existir — o segundo destino soma, não substitui.
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');
const { alerta } = require('./lib-alerta');

// 🔴 O EVENTO tem chave e título FIXOS; quem carrega a duração é o assunto. O `tituloDe` do
// `lib-alerta` monta o título da issue de `chave` + `titulo`, então qualquer um dos dois
// carregando os minutos abriria uma issue NOVA a cada lembrete — e issue a cada lembrete ensina
// a ignorar a issue. Com a chave fixa, o lembrete COMENTA na aberta e a normalização a FECHA.
const EV_TELEMETRIA = { chave: 'way2:telemetria', titulo: 'Telemetria Way2 sem atualizar' };
const EV_MEDIDOR = { chave: 'way2:medidores', titulo: 'Medidores Way2 sem comunicacao' };

// Entregue = QUALQUER canal aceitou. Antes isto era "o webhook respondeu"; com dois destinos,
// bastar um é justamente o motivo de existir o segundo. '-' = canal não configurado.
const entregou = (r) => ['webhook', 'issue'].some((k) => {
  const v = String(r[k]);
  return v !== '-' && !v.startsWith('FALHOU') && !v.startsWith('nada aberto');
});

const CONTAINER = 'dados';
// 🔴 REGISTRAR E NOTIFICAR SAO COISAS DIFERENTES, e misturar as duas e o que enche a caixa de
// e-mail. Ate 23/08/2026 havia um limiar so: aos 30 min o watchdog registrava a falha E mandava
// e-mail. Uma oscilacao de 35 min — que se resolve sozinha — custava dois e-mails, o da queda e o
// da normalizacao.
//
//   LIMIAR_REGISTRO (30 min) — marca a falha no estado, que o Grafana le. NAO manda e-mail.
//   LIMIAR_EMAIL    (60 min) — a partir daqui a interrupcao deixou de ser oscilacao e vira
//                              evento: sai o primeiro aviso, e depois os lembretes.
//
// O registro continua fino para o painel ter historico; a notificacao fica grossa para so
// interromper alguem quando ha o que fazer.
const LIMIAR = Math.max(10, (parseInt(process.env.LIMIAR_MIN || '30', 10) || 30));
const LIMIAR_EMAIL = Math.max(LIMIAR, (parseInt(process.env.LIMIAR_EMAIL_MIN || '60', 10) || 60));
// ⚠️ O webhook NAO e mais lido aqui: quem conhece os destinos e o `lib-alerta`. Duas leituras da
// mesma variavel em dois lugares e a receita para uma delas envelhecer sozinha.
// 🔴 UM ALERTA SO NAO BASTA NUMA PARADA LONGA. Ate 23/08/2026 o watchdog avisava 1x por evento:
// a telemetria caiu as 02:10, o e-mail saiu as 02:41, e as seis horas seguintes correram em
// silencio. Quem abriu a caixa de manha tinha um unico aviso, com um numero de 31 minutos.
// Agora, enquanto a falha persistir, sai um LEMBRETE a cada LEMBRETE_H horas, com a duracao
// recontada — assim o e-mail mais recente e sempre verdadeiro.
// 🔴 LEMBRETE DE INTERVALO FIXO VIRA ENXURRADA NUMA INTERRUPCAO LONGA. Simulado: com lembrete a
// cada 2 h, uma queda de 24 h renderia 13 e-mails — o oposto de "recebo e-mail demais".
//
// O espacamento DOBRA a cada aviso, com teto de 12 h: 2h, 4h, 8h, 12h, 12h... Assim a queda nova
// avisa cedo e com frequencia, e a que ja se arrasta por um dia lembra duas vezes por dia. Numa
// interrupcao de 24 h sao 5 e-mails em vez de 13, e nenhum deles chega tarde.
const LEMBRETE_BASE = Math.max(30, (parseInt(process.env.LEMBRETE_H || '2', 10) || 2) * 60);
const LEMBRETE_TETO = Math.max(LEMBRETE_BASE, (parseInt(process.env.LEMBRETE_TETO_H || '12', 10) || 12) * 60);
// avisos ja enviados -> quanto esperar antes do proximo
const proximoLembrete = (n) => Math.min(LEMBRETE_TETO, LEMBRETE_BASE * Math.pow(2, Math.max(0, n - 1)));
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

(async () => {
  const conn = process.env.DADOS_STORAGE, token = process.env.WAY2_TOKEN;
  if (!conn) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);

  // 1) idade do dado que o painel mostra (way2_latest leve; fallback way2_eletrico)
  let dados = null;
  for (const nome of ['way2_latest.json', 'way2_eletrico.json']) { const bc = cont.getBlockBlobClient(nome); if (await bc.exists()) { dados = parseJson(await bc.downloadToBuffer()).dados; break; } }
  const nossoTs = dados ? newestTs(dados, PID, GRAND) : null;
  const semDado = !nossoTs;                    // blob vazio/sem o ponto (ex.: virada do dia) — NÃO é "idade 99999"
  const idade = nossoTs ? ageMin(nossoTs) : null;

  // Carência pós-meia-noite: nos 1os minutos do dia o blob legitimamente esvazia e reenche
  // (a Way2 tem ~15 min de latência, então as 1as leituras do dia novo demoram). Não alarmar aí.
  const minDoDia = (() => { const s = nowBRT().slice(11, 19).split(':').map(Number); return s[0] * 60 + s[1]; })();
  const carenciaVirada = minDoDia < (LIMIAR + 5);

  // 2) estado anterior
  const sbc = cont.getBlockBlobClient('way2_watchdog.json');
  let st = { estado: 'ok' };
  if (await sbc.exists()) { try { st = parseJson(await sbc.downloadToBuffer()); } catch (e) {} }

  let acao = null;
  // dispara só se: (dado velho) OU (sem dado E fora da carência da virada). Nunca por sentinela.
  const suspeito = (idade != null && idade > LIMIAR) || (semDado && !carenciaVirada);
  if (suspeito) {
    // 3) CONFIRMA a origem consultando a API Way2 DIRETO — é a prova real, não o nosso blob
    let origem = 'pipeline', way2Ts = null, way2Age = null, detalhe = '';
    try {
      const dia = nowBRT().slice(0, 10);
      const q = `ids=${PID}&grandezas=${GRAND}&contextodasdatas=ConsiderarDiaCheio&intervalo=CincoMinutos&medicao-datainicio=${dia}T00:00:00&medicao-datafim=${dia}T23:59:59&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false`;
      const j = await apiGet(q, token); way2Ts = newestTs(j.dados, PID, GRAND);
      way2Age = way2Ts ? ageMin(way2Ts) : null;
      origem = (way2Age == null || way2Age > (LIMIAR - 5)) ? 'way2' : 'pipeline';
      detalhe = way2Ts ? `Way2 (consulta direta) tem dado até ${fmtTs(way2Ts)} (${Math.round(way2Age)} min atrás).`
                       : 'Way2 (consulta direta) também não tem dado hoje ainda.';
    } catch (e) { origem = 'way2'; detalhe = 'A API Way2 nem respondeu à confirmação direta (' + e.message + ').'; }

    // ⚑ ANTI-FALSO-POSITIVO: nosso blob sem dado, MAS a Way2 tem dado fresco → é transitório
    // nosso (virada/pipeline atrasando), não uma queda da fonte. Não alarma; auto-recupera.
    if (semDado && origem === 'pipeline') {
      console.log('watchdog: blob sem dado mas Way2 fresca (' + detalhe + ') — transitório, sem alarme.');
      const body0 = JSON.stringify(st); await sbc.upload(body0, Buffer.byteLength(body0), { blobHTTPHeaders: { blobContentType: 'application/json' } });
      return;
    }

    // idade REAL para o texto: se não temos ts, usa a idade que a Way2 reportou (nunca a sentinela)
    const idadeTxt = idade != null ? Math.round(idade) : (way2Age != null ? Math.round(way2Age) : null);
    const desdeTxt = nossoTs || way2Ts || nowBRT();
    if (st.estado !== 'falha') st = { estado: 'falha', desde: desdeTxt, origem, idade_disparo: idadeTxt, alertado_em: null };
    st.idadeTxt = idadeTxt;
    st.origem = origem;
    // 🔴 O REGISTRO JA FOI FEITO ACIMA (estado 'falha' no blob, que o Grafana le). O e-mail so
    // sai quando a interrupcao passa do limiar MAIOR — abaixo dele e oscilacao, e oscilacao que
    // se resolve sozinha nao merece interromper ninguem.
    const maduro = (st.idadeTxt != null && st.idadeTxt >= LIMIAR_EMAIL) || semDado;
    // reenvia enquanto durar: o alerta mais recente na caixa tem de estar certo
    const lembrete = !!st.alertado_em && ageMin(st.alertado_em) >= proximoLembrete(st.avisos || 1);
    if (maduro && (!st.alertado_em || lembrete)) { // só considera "avisado" quando o POST deu certo (senão re-tenta no próximo run)
      const fonte = origem === 'way2';
      // 🔴 DURACAO RELATIVA NUM E-MAIL ENVELHECE. "sem dados ha 31 min" era verdade no instante do
      // disparo e vira mentira em quem abre a caixa horas depois — foi exatamente o que aconteceu
      // na parada de 23/08/2026, com o alerta das 02:41 sendo lido as 08:00 dizendo "31 min".
      //
      // O que NAO envelhece e o INSTANTE em que parou. Ele vai no assunto e na primeira linha; a
      // duracao continua no corpo, mas rotulada como "no momento deste alerta", que e o unico
      // jeito de um numero relativo continuar verdadeiro depois.
      const desdeFmt = fmtTs(st.desde);
      const haX = st.idadeTxt != null ? fmtDur(st.idadeTxt) + ' no momento deste alerta'
        : 'sem leitura hoje ainda';
      acao = {
        tipo: 'falha', ...EV_TELEMETRIA,
        origem, idade_min: st.idadeTxt, sem_dados_desde: st.desde, verificado_em: nowBRT(), contato_suporte: fonte ? SUPORTE : '',
        lembrete,
        assunto: (fonte ? '🔴' : '🟠') + ' ' + (lembrete ? 'AINDA sem dados' : 'Falha de comunicação')
          + ' Way2 · Mauriti · desde ' + desdeFmt
          + (st.idadeTxt != null ? ' (' + fmtDur(st.idadeTxt) + ')' : ''),
        corpo: '<b>A telemetria do Complexo Mauriti está SEM ATUALIZAR desde ' + desdeFmt + '.</b><br>'
          + '<i>' + (lembrete ? 'Lembrete' : 'Primeiro aviso') + ' gerado em ' + fmtTs(nowBRT())
          + ' — ' + haX + '. Se você está lendo isto mais tarde, a interrupção pode ser maior: '
          + 'confira o painel MUST para o valor de agora.</i><br><br>'
          + 'Verificação automática: ' + detalhe + '<br><br>'
          + (fonte
            ? '➡ <b>ORIGEM: FALHA NA FONTE (Way2)</b>. O serviço da Way2 não está entregando dados novos.<br>➡ <b>AÇÃO: contatar o suporte Way2 — ' + SUPORTE + '</b>'
            : '➡ <b>ORIGEM: NOSSO PIPELINE</b>. A Way2 tem dados novos, mas o fluxo Power Automate parou de gravar o blob.<br>➡ <b>AÇÃO: verificar o fluxo "Way2 Eletrico 5min"</b> no Power Automate.')
          + '<br><br><i>(Alerta automático · watchdog Mauriti · limiar ' + LIMIAR + ' min · e-mail a partir de ' + LIMIAR_EMAIL + ' min)</i>'
      };
    }
  } else if (st.estado === 'falha' && idade != null && idade <= LIMIAR) {
    // 4) NORMALIZOU — dispara com a duração (só com dado REAL fresco; não "normaliza" no vazio da virada)
    const dur = st.desde ? ageMin(st.desde) : 0;
    const ate = nowBRT();
    // 🔴 A CONFIRMACAO SO SAI SE HOUVE AVISO. Normalizar uma queda que nunca gerou e-mail seria
    // avisar do fim de algo que ninguem soube que comecou — e e-mail sem par e ruido puro.
    const houveAviso = (st.avisos || 0) > 0;
    acao = houveAviso ? {
      // `resolve: true` FECHA a issue do evento — normalizar tambem e noticia, e o estado fica
      // legivel sem ninguem abrir log nenhum.
      tipo: 'normalizado', ...EV_TELEMETRIA, resolve: true,
      duracao_min: Math.round(dur), ficou_fora_desde: st.desde, ate: ate,
      origem: st.origem || '—', avisos: st.avisos || 0,
      assunto: '✅ Way2 NORMALIZADA · Mauriti · ficou fora ' + fmtDur(dur),
      corpo: '<b>A telemetria do Complexo Mauriti VOLTOU a atualizar.</b><br><br>'
        + '<b>PRAZO TOTAL DE INDISPONIBILIDADE: ' + fmtDur(dur) + '</b><br>'
        + '↳ Início: <b>' + fmtTs(st.desde) + '</b><br>'
        + '↳ Normalização: <b>' + fmtTs(ate) + '</b><br>'
        + '↳ Origem: ' + (st.origem === 'way2' ? 'Way2 (fonte)' : 'nosso pipeline') + '<br>'
        + '↳ Avisos enviados durante a interrupção: ' + (st.avisos || 0) + '<br><br>'
        + '<i>Este é o fechamento do evento — o prazo acima é o definitivo, medido do primeiro '
        + 'intervalo sem dado até a volta.</i><br>'
        + '<i>(Alerta automático · watchdog Mauriti)</i>'
    } : null;
    if (!houveAviso) console.log('watchdog: normalizou em ' + fmtDur(dur)
      + ' sem ter gerado aviso (abaixo de ' + LIMIAR_EMAIL + ' min) — sem e-mail de fechamento.');
    st = { estado: 'ok' };
  }

  // 5) dispara + salva estado
  if (acao) {
    const r = await alerta(acao);
    const entregue = entregou(r);
    console.log('ALERTA ' + acao.tipo + ' · ' + acao.assunto + (entregue ? '' : '  <- NENHUM CANAL ACEITOU'));
    // `alertado_em` passa a ser a hora do ULTIMO envio, nao a do primeiro: e dela que o
    // proximo lembrete conta
    if (acao.tipo === 'falha' && entregue && st.estado === 'falha') {
      st.alertado_em = nowBRT();
      st.avisos = (st.avisos || 0) + 1;
    }
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
  if (idade != null && idade <= LIMIAR) {     // feed saudável (com dado real) -> julga medidor a medidor
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
          tipo: 'medidor_fora', ...EV_MEDIDOR,
          qtd: n, verificado_em: nowBRT(), contato_suporte: SUPORTE,
          assunto: '🟠 ' + (n === 1 ? 'Medidor Way2 sem comunicação' : n + ' medidores Way2 sem comunicação') + ' · Mauriti',
          corpo: '<b>' + (n === 1 ? 'Um medidor parou' : n + ' medidores pararam') + ' de enviar dados para a Way2.</b><br><br>'
            + '<ul>' + lista + '</ul>'
            + 'O restante da telemetria do complexo está <b>normal</b> (' + saude.resumo.ok + ' de ' + saude.resumo.total + ' medidores saudáveis) — '
            + 'ou seja, <b>não é queda geral da Way2</b>, é medidor específico.<br><br>'
            + '➡ <b>AÇÃO: verificar o medidor em campo</b> e, se necessário, acionar o suporte Way2 — ' + SUPORTE
            + '<br><br><i>(Alerta automático · watchdog Mauriti · limiar ' + LIM_MED + ' min)</i>',
        };
        const ok = entregou(await alerta(acaoMed));
        console.log('ALERTA medidor · ' + acaoMed.assunto + (ok ? '' : '  <- NENHUM CANAL ACEITOU'));
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
          tipo: 'medidor_normalizado', ...EV_MEDIDOR, resolve: true,
          qtd: voltaram.length, verificado_em: nowBRT(),
          assunto: '✅ ' + (voltaram.length === 1 ? 'Medidor Way2 NORMALIZADO' : voltaram.length + ' medidores Way2 NORMALIZADOS') + ' · Mauriti',
          corpo: '<b>' + (voltaram.length === 1 ? 'O medidor voltou' : 'Os medidores voltaram') + ' a enviar dados.</b><br><br><ul>' + lista + '</ul>'
            + '<i>(Alerta automático · watchdog Mauriti)</i>',
        };
        const ok = entregou(await alerta(acaoOk));
        console.log('ALERTA medidor normalizado · ' + acaoOk.assunto + (ok ? '' : '  <- NENHUM CANAL ACEITOU'));
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
  console.log('watchdog OK · idade=' + (idade != null ? Math.round(idade) + 'min' : (semDado ? 'SEM DADO' + (carenciaVirada ? ' (carência virada)' : '') : '?')) + ' · estado=' + st.estado + (acao ? ' · disparou ' + acao.tipo : ''));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
