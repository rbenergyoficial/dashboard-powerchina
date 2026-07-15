// gen-way2-recent.js — pós-processamento de blob (NÃO consulta a Way2).
// A cada execução (5 min):
//   1) snapshot: copia o blob ao vivo way2_eletrico.json (escrito pelo fluxo Power Automate
//      "Way2 Eletrico 5min") para hist/way2_<hoje>.json — deixa o dia de HOJE no mesmo padrão
//      de URL do histórico (hist/way2_AAAA-MM-DD.json).
//   2) way2_recent.json: mescla os últimos N_RECENT dias (5-min, todas as grandezas) num só
//      blob, para os gráficos de série temporal mostrarem histórico CONTÍNUO que cruza a virada
//      do dia (ex.: "últimos 2 dias" = ontem + hoje juntos).
// Só usa a connection string (DADOS_STORAGE) — nenhum token Way2. Independente do fluxo PA.
const { BlobServiceClient } = require('@azure/storage-blob');
const { gerarClima } = require('./gen-clima');

const CONTAINER = 'dados';
const LIVE_BLOB = 'way2_eletrico.json';
const N_RECENT = 2;                              // dias no blob rolante (ontem+hoje = "≤2d"; menor = download mais leve)

function diaBRT(offset = 0) {                    // dia-calendário BRT (UTC-3), independente do fuso do runner
  const d = new Date(Date.now() - 3 * 3600 * 1000 - offset * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}
const parseJson = (buf) => JSON.parse(buf.toString('utf8').replace(/^﻿/, ''));

/* ══════════════════════════════════════════════════════════════════════════════
 * SAÚDE DOS MEDIDORES  →  way2_saude.json  (~125 KB)
 *
 * POR QUÊ: os medidores Way2 caem e voltam o tempo todo, alternando entre si (confirmado
 * na própria plataforma da Way2). Antes isso passava despercebido — e pior, a âncora dos
 * gauges exigia os 22 circuitos e CONGELAVA a leitura do complexo quando UM medidor caía.
 *
 * ⚠️ ARMADILHA CENTRAL: os slots MAIS NOVOS estão SEMPRE incompletos — a Way2 os preenche aos
 * poucos, ao longo de ~15 min (às 18:25 só 10 dos 25 medidores tinham chegado; às 18:05, 24).
 * Uma métrica ingênua de "quantos reportam agora" gritaria FALHA a cada 5 min e o alarme
 * viraria ruído. Por isso:
 *   - a SAÚDE de cada medidor é medida pela IDADE REAL da sua última leitura (vs. agora),
 *     nunca pela completude do slot mais novo;
 *   - a SÉRIE/TIMELINE só usam slots ASSENTADOS (≥ ASSENTA_MIN de idade);
 *   - a ÂNCORA (o que o selo mostra) é o último slot com ≥20 dos 22 circuitos — exatamente
 *     o instante que os gauges exibem.
 *
 * "virada": buraco que cruza a meia-noite NÃO é falha de medidor — é o nosso snapshot diário
 * (hist/way2_DIA.json) que perde os últimos ~15-20 min do dia. Marcado à parte p/ não alarmar.
 * ══════════════════════════════════════════════════════════════════════════════ */
const CIRC = ['1C1','1C2','1C3','2C1','2C2','3C1','3C2','3C3','4C1','4C2','4C3','5C1','5C2','5C3','6C1','6C2','6C3','7C1','8C1','8C2','8C3','9C1'];
// 24 MEDIDORES FÍSICOS: 22 circuitos coletores (34,5 kV) + 2 transformadores (230 kV).
// O ponto 6233 (Totalizador) é APENAS a soma dos 22 circuitos — não é medidor, não entra na saúde.
const MEDIDORES = [
  { pid: 6196, nome: 'SE · TR1', grupo: '230 kV' },
  { pid: 6197, nome: 'SE · TR2', grupo: '230 kV' },
  ...CIRC.map((c, i) => ({ pid: 6198 + i, nome: 'M' + c[0] + ' · C' + c[2], grupo: '34,5 kV' })),
];
const OK_MIN = 25;        // ≤25 min = saudável (a latência estrutural da Way2 é ~15-16 min)
const FALHA_MIN = 40;     // >40 min = falha
const ASSENTA_MIN = 20;   // um slot só "assenta" depois de ~20 min
const JANELA_TL_H = 24;   // horas no state timeline
const MIN_EVENTO = 15;    // ignora buraco de 1 slot (ruído)

// kpis_dia.json — os 4 KPIs do dia (Energia/FC/Pico/Média) pré-calculados p/ os cards minimalist
// (Business Text). MESMA matemática dos Stat nativos: ponto 6233 (Demat, em kW);
// energia = Σ(kW>0)×5/60/1000 MWh; horas = nº de slots com dado ×5/60; FC = E/(343,77×horas)×100.
function kpisDia(eletJson) {
  const s = (eletJson.dados || []).find(x => x.pontoId === 6233 && x.nomeGrandeza === 'Demat');
  const vals = ((s && s.valores) || []).filter(v => v.valor != null).map(v => v.valor);
  const pos = vals.filter(v => v > 0);
  const energia = pos.reduce((a, v) => a + v, 0) * 5 / 60 / 1000;   // MWh
  const pico = pos.length ? Math.max.apply(null, pos) / 1000 : 0;   // MW
  const horas = vals.length * 5 / 60;
  const fc = horas > 0 ? energia / (343.77 * horas) * 100 : 0;      // %
  const media = horas > 0 ? energia / horas : 0;                    // MW
  return {
    atualizado: new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19),
    kpis: [
      { rotulo: 'Energia hoje', valor: +energia.toFixed(1), unidade: 'MWh', emoji: '⚡', cor: '#FFB020', destaque: 1 },
      { rotulo: 'Fator de capacidade', valor: +fc.toFixed(1), unidade: '%', emoji: '🎯', cor: '#8B93A1', destaque: 0 },
      { rotulo: 'Pico de potência', valor: +pico.toFixed(1), unidade: 'MW', emoji: '📈', cor: '#8B93A1', destaque: 0 },
      { rotulo: 'Potência média', valor: +media.toFixed(1), unidade: 'MW', emoji: '📊', cor: '#8B93A1', destaque: 0 },
    ],
  };
}

function gerarSaude(dados, agoraMs) {
  const idade = (ts) => (agoraMs - Date.parse(ts + '-03:00')) / 60000;

  const porPid = new Map();
  for (const s of dados) {
    if (s.nomeGrandeza !== 'Demat') continue;
    const set = new Set(); let ultima = null;
    for (const v of (s.valores || [])) if (v.valor != null) { set.add(v.data); if (!ultima || v.data > ultima) ultima = v.data; }
    porPid.set(s.pontoId, { set, ultima });
  }
  const slotsDo = (pid) => (porPid.get(pid) || { set: new Set() }).set;

  // estado atual: IDADE REAL da última leitura de cada medidor
  const medidores = MEDIDORES.map(d => {
    const o = porPid.get(d.pid) || {};
    const im = o.ultima ? Math.round(idade(o.ultima)) : 99999;
    return { pid: d.pid, nome: d.nome, grupo: d.grupo, ultima: o.ultima || null,
             idade_min: im, estado: im <= OK_MIN ? 'ok' : (im <= FALHA_MIN ? 'atraso' : 'falha') };
  });
  const resumo = { total: MEDIDORES.length, ok: 0, atraso: 0, falha: 0 };
  for (const m of medidores) resumo[m.estado]++;

  const todos = new Set();
  for (const o of porPid.values()) for (const t of o.set) todos.add(t);
  const slots = [...todos].sort();
  const assentados = slots.filter(t => idade(t) >= ASSENTA_MIN);

  // âncora dos gauges = último slot com ≥20 dos 22 circuitos (o instante que os painéis exibem)
  const CIRCS = MEDIDORES.filter(d => d.grupo === '34,5 kV').map(d => d.pid);
  let ancora = null;
  for (let i = slots.length - 1; i >= 0; i--) {
    if (CIRCS.reduce((n, p) => n + (slotsDo(p).has(slots[i]) ? 1 : 0), 0) >= 20) { ancora = slots[i]; break; }
  }

  const serie = [], timeline = [];
  for (const t of assentados) {
    let ok = 0; const linha = { ts: t };
    for (const d of MEDIDORES) { const tem = slotsDo(d.pid).has(t) ? 1 : 0; if (tem) ok++; linha[d.nome] = tem; }
    serie.push({ ts: t, ok, fora: MEDIDORES.length - ok });
    if (idade(t) <= JANELA_TL_H * 60) timeline.push(linha);
  }

  const eventos = [];
  for (const d of MEDIDORES) {
    const set = slotsDo(d.pid);
    let de = null;
    const fecha = (ate, min, aberto) => {
      if (min < MIN_EVENTO) return;
      const virada = ate != null && de.slice(0, 10) !== ate.slice(0, 10) && +de.slice(11, 13) >= 23;
      eventos.push({ pid: d.pid, nome: d.nome, de, ate, min, aberto, tipo: virada ? 'virada' : 'falha' });
    };
    for (const t of assentados) {
      if (!set.has(t)) { if (!de) de = t; continue; }
      if (de) { fecha(t, Math.round((Date.parse(t + '-03:00') - Date.parse(de + '-03:00')) / 60000), false); de = null; }
    }
    if (de) fecha(null, Math.round(idade(de)), true);
  }
  eventos.sort((a, b) => (a.de < b.de ? 1 : -1));

  const idadeAncora = ancora ? Math.round(idade(ancora)) : 99999;
  // badges[] pré-computados p/ o card de status do cabeçalho (chip + cor do estado)
  const corIdade = idadeAncora <= OK_MIN ? '#2FBF71' : (idadeAncora <= FALHA_MIN ? '#FF8A3D' : '#E5484D');
  // Medidores: chip = saúde da FROTA. Cor pela FALHA REAL (>40 min, mesma faixa do alerta de 45 min) e
  // número = medidores saudáveis (≤40 min). Antes pintava pela contagem de FRESCOS (≤25 min), então o
  // jitter normal de latência da Way2 (1-2 medidores a 26-40 min = "atraso", não falha) já gritava laranja.
  const medSaudaveis = resumo.total - resumo.falha;
  const corMed = resumo.falha === 0 ? '#2FBF71' : (resumo.falha <= 2 ? '#FF8A3D' : '#E5484D');
  const badges = [
    { ic: '⏱', l: 'Way2', v: String(idadeAncora), u: 'min', c: corIdade },
    { ic: '📡', l: 'Medidores', v: medSaudaveis + '/' + resumo.total, u: '', c: corMed },
  ];

  return {
    atualizado: new Date(agoraMs - 3 * 3600 * 1000).toISOString().slice(0, 19),
    ancora, idade_min: idadeAncora,   // <- o que o SELO mostra
    limiares: { ok_min: OK_MIN, falha_min: FALHA_MIN },
    resumo, badges, medidores, serie, timeline,
    eventos: eventos.filter(e => e.tipo === 'falha').slice(0, 40),
    eventos_virada: eventos.filter(e => e.tipo === 'virada').length,
  };
}

(async () => {
  const conn = process.env.DADOS_STORAGE;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const day = diaBRT();

  // clima.json — some do "No data": em vez de 5 painéis chamarem o Open-Meteo direto (IP
  // compartilhado do Grafana Cloud → 429), 1 chamada aqui grava no nosso blob. Não bloqueia
  // o resto se a API externa falhar (só loga).
  gerarClima(conn).catch(e => console.error('clima.json FALHOU (segue sem bloquear):', e.message));

  // 1) snapshot de hoje
  let eletJson = null;
  const live = container.getBlockBlobClient(LIVE_BLOB);
  if (await live.exists()) {
    const buf = await live.downloadToBuffer();
    await container.getBlockBlobClient(`hist/way2_${day}.json`).upload(buf, buf.length, { blobHTTPHeaders: { blobContentType: 'application/json' } });
    eletJson = parseJson(buf);
    console.log(`snapshot hist/way2_${day}.json OK · ${(buf.length / 1048576).toFixed(1)} MB`);
  } else {
    console.log(`${LIVE_BLOB} não existe — snapshot pulado`);
  }

  // 1b) way2_latest.json — SÓ os últimos N_LATEST slots por série (~130 KB vs 3,7 MB do eletrico).
  // Os painéis de VALOR ATUAL (gauges, %, carregamento, selo de idade) leem daqui: com 39 painéis
  // × leitura própria, ler 3,7 MB cada gerava ~145 MB/refresh e derrubava tudo com "No data".
  // Cache-Control curto p/ os painéis compartilharem 1 download. (Cards de TOTAL DO DIA continuam
  // no way2_eletrico, que precisa do dia inteiro.)
  if (eletJson && Array.isArray(eletJson.dados)) {
    const N_LATEST = 12;
    // O blob tem os 288 slots do dia, com os FUTUROS = null. refTime = instante mais recente com
    // dado em QUALQUER série; janela = os N_LATEST slots ATÉ refTime (não os últimos do array, que
    // seriam 23:xx→00:00 nulos). Mantém a grade alinhada entre séries (null onde a série não reportou).
    let refTime = '';
    for (const s of eletJson.dados) { const vs = s.valores || []; for (let i = vs.length - 1; i >= 0; i--) { if (vs[i].valor != null) { if (vs[i].data > refTime) refTime = vs[i].data; break; } } }
    const latest = { atualizado: refTime || (eletJson.dataFim || day), intervalo: eletJson.intervalo || 'CincoMinutos',
      dados: eletJson.dados.map(s => ({ pontoId: s.pontoId, ultimaColeta: s.ultimaColeta, nomeGrandeza: s.nomeGrandeza,
        valores: (s.valores || []).filter(v => !refTime || v.data <= refTime).slice(-N_LATEST) })) };
    const lb = JSON.stringify(latest);
    await container.getBlockBlobClient('way2_latest.json').upload(lb, Buffer.byteLength(lb), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    console.log(`way2_latest.json OK · ${latest.dados.length} séries × ${N_LATEST} slots · ${(lb.length / 1024).toFixed(0)} KB`);

    // kpis_dia.json — 4 KPIs do dia p/ os cards minimalist (mesma matemática dos Stat nativos)
    const kd = kpisDia(eletJson);
    const kb = JSON.stringify(kd);
    await container.getBlockBlobClient('kpis_dia.json').upload(kb, Buffer.byteLength(kb), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    console.log(`kpis_dia.json OK · energia ${kd.kpis[0].valor} MWh · FC ${kd.kpis[1].valor}% · pico ${kd.kpis[2].valor} MW · média ${kd.kpis[3].valor} MW`);
  }

  // 2) way2_recent.json = últimos N_RECENT dias mesclados (mais antigo -> hoje)
  const dias = [];
  for (let k = N_RECENT - 1; k >= 0; k--) dias.push(diaBRT(k));
  const merged = new Map();   // "pontoId|grandeza" -> { pontoId, ultimaColeta, nomeGrandeza, valores:[] }
  let usados = 0;
  for (const dd of dias) {
    let jb = null;
    if (dd === day) { jb = eletJson; }
    else {
      const bc = container.getBlockBlobClient(`hist/way2_${dd}.json`);
      if (await bc.exists()) jb = parseJson(await bc.downloadToBuffer());
    }
    if (!jb || !jb.dados) continue;
    usados++;
    for (const s of jb.dados) {
      const key = s.pontoId + '|' + s.nomeGrandeza;
      let m = merged.get(key);
      if (!m) { m = { pontoId: s.pontoId, ultimaColeta: s.ultimaColeta, nomeGrandeza: s.nomeGrandeza, valores: [] }; merged.set(key, m); }
      m.ultimaColeta = s.ultimaColeta;
      for (const v of (s.valores || [])) m.valores.push(v);
    }
  }
  if (usados > 0) {
    const dadosMesclados = [...merged.values()];
    const out = { inicio: dias[0], fim: day, dias_incluidos: dias, intervalo: 'CincoMinutos', dados: dadosMesclados };
    const rb = JSON.stringify(out);
    // max-age 60s: os 13 painéis do Monitor compartilham 1 download no carregamento (em vez de
    // cada um re-baixar), e o auto-refresh (>60s) ainda pega dado novo. Blob muda a cada 5min.
    await container.getBlockBlobClient('way2_recent.json').upload(rb, Buffer.byteLength(rb), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    console.log(`way2_recent.json OK · ${usados} dias (${dias.join(', ')}) · ${(rb.length / 1048576).toFixed(1)} MB`);

    // 3) way2_saude.json — saúde dos 25 medidores (tabela + série + timeline + eventos).
    // Derivado das MESMAS linhas; blob leve (~125 KB) para os painéis não re-lerem o recent (7,6 MB).
    const saude = gerarSaude(dadosMesclados, Date.now());
    const sb = JSON.stringify(saude);
    await container.getBlockBlobClient('way2_saude.json').upload(sb, Buffer.byteLength(sb), { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=60' } });
    console.log(`way2_saude.json OK · âncora ${saude.ancora} (há ${saude.idade_min} min) · `
      + `${saude.resumo.ok}/${saude.resumo.total} medidores (${saude.resumo.atraso} atraso, ${saude.resumo.falha} falha) · `
      + `${saude.eventos.length} eventos · ${(sb.length / 1024).toFixed(0)} KB`);
    const ruins = saude.medidores.filter(m => m.estado !== 'ok');
    if (ruins.length) console.log('  medidores fora do normal: ' + ruins.map(m => `${m.nome}=${m.idade_min}min(${m.estado})`).join(', '));
  } else {
    console.log('nenhum dia disponível — way2_recent.json / way2_saude.json não gerados');
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
