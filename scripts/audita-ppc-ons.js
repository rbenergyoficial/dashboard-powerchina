/*
 * audita-ppc-ons.js — o registro da mesa contra o dado aberto do operador nacional.
 *
 * Duas rotas independentes para o MESMO fato: quanto o operador nacional mandou limitar. Uma sai
 * da mesa, anotada a mao no minuto da ordem; a outra sai do arquivo publico, por meia hora. Elas
 * nunca se falaram, e conferi-las e o tipo de verificacao que esta casa exige antes de confiar
 * num numero.
 *
 * ── O QUE A PRIMEIRA MEDICAO ESTABELECEU (setembro/2026, 126 meias horas) ────────────────────
 *   · no MIOLO do episodio as duas fecham: mediana da diferenca 0,000 MW, media 0,71 MW;
 *   · nas BORDAS elas discordam quase sempre (88%), e por um motivo conhecido — a mesa anota o
 *     setpoint ~16 min depois de a ordem chegar e anota a liberacao ~14 min antes de o operador
 *     nacional encerrar. A janela registrada sai ~30 min mais curta que a real, todo dia restrito.
 *
 * 🔴 POR ISSO O ALARME NAO E POR MEIA HORA. A 2 MW ele acenderia em 9,9% dos slots por um setpoint
 *    intermediario nao anotado, que e operacao normal — e alarme que acende todo dia deixa de ser
 *    lido. O que fica VERMELHO sao tres coisas, e cada uma tem a medicao que a sustenta:
 *
 *      1 · meia hora em que o operador nacional limitou e a mesa NAO registrou nada
 *          (38 ocorrencias em jun-jul; ZERO em setembro — e o achado caro, corte sem registro)
 *      2 · linha ilegivel dentro do recorte
 *          (foi o `11/09/20206`: 18 linhas invisiveis, um dia inteiro que nao existia)
 *      3 · dia cuja MEDIANA de diferenca no miolo passa do limiar
 *          (a mediana medida e 0,000 MW; um dia acima de 2 MW e desalinhamento do dia inteiro,
 *           nao um setpoint perdido)
 *
 * ⚠️ A divergencia de BORDA e o atraso de registro vao PUBLICADOS, sem alarme: sao conhecidos,
 *    medidos, e tem outra natureza — quem os resolve e a mesa lancando uma linha no instante da
 *    ordem e outra no instante da liberacao, nao o pipeline.
 *
 * uso: node audita-ppc-ons.js            (le os dois blobs publicados e grava a auditoria)
 *      PPC_LOCAL=<arquivo.json>          le o registro de um arquivo, para ensaio
 */
'use strict';
const zlib = require('zlib');
const P = require('./lib-ppc.js');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const DE = process.env.PPC_DE || '2026-09-01';        // o recorte, decidido pelo humano em 12/09/2026
const TOL = Number(process.env.PPC_TOL || 2);         // MW — a folga entre as duas rotas
const TOL_DIA = Number(process.env.PPC_TOL_DIA || 2); // MW — a MEDIANA do dia acima disso e vermelho
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');

const puxa = (url) => new Promise((ok, erro) => {
  require('https').get(url, (r) => {
    if (r.statusCode !== 200) { erro(new Error('HTTP ' + r.statusCode)); r.resume(); return; }
    const p = [];
    r.on('data', (c) => p.push(c));
    r.on('end', () => {
      let b = Buffer.concat(p);
      if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
      try { ok(JSON.parse(b.toString('utf8'))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); }
    });
  }).on('error', erro);
});

async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (LOCAL_OUT_DIR) { require('fs').writeFileSync(require('path').join(LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await c.createIfNotExists();
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

const mediana = (a) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
const quantil = (a, f) => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(f * b.length))]; };
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);

/*
 * 🔴 UMA LINHA ILEGIVEL NAO TEM DATA — e sem data nao da para dizer se ela cai no recorte.
 * A saida nao e um numero colado nem uma linha de base congelada: e datar o defeito pela ULTIMA
 * linha LEGIVEL acima dele no arquivo. O registro e cronologico (10 linhas fora de ordem em
 * 1.948, todas de minutos), entao a vizinha de cima diz de que dia a linha quebrada e.
 */
function dataDosDefeitos(eventos, defeitos) {
  const marcos = eventos.map((e) => ({ linha: e.linha, dia: e.dia || String(e.ts).slice(0, 10) }))
    .filter((x) => x.linha != null).sort((a, b) => a.linha - b.linha);
  return defeitos.map((d) => {
    let dia = null;
    for (const m of marcos) { if (m.linha <= d.linha) dia = m.dia; else break; }
    return Object.assign({}, d, { dia_aprox: dia });
  });
}

(async () => {
  const reg = process.env.PPC_LOCAL
    ? JSON.parse(zlib.gunzipSync(require('fs').readFileSync(process.env.PPC_LOCAL)).toString('utf8'))
    : await puxa(BASE + 'ppc_restricao.json');
  const eventos = (reg.eventos || []).filter((e) => (e.dia || String(e.ts).slice(0, 10)) >= DE);
  if (!eventos.length) throw new Error('o registro nao tem evento nenhum de ' + DE + ' em diante');

  const ons0 = await puxa(BASE + 'ons_restricao_all.json');
  const serie = ons0.consolidado || ons0.linhas || ons0.serie;
  if (!Array.isArray(serie) || !serie.length) throw new Error('o arquivo do operador nacional veio sem serie');

  const slots = P.integraliza(eventos);
  const ons = new Map();
  for (const r of serie) {
    const ts = String(r.ts || '');
    if (ts.slice(0, 10) < DE) continue;
    const lim = (r.lim === '' || r.lim == null) ? null : Number(r.lim);
    ons.set(ts.slice(0, 10) + ' ' + ts.slice(11, 16), { lim, razao: String(r.razao || ''), dsc: String(r.dsc || '') });
  }
  const chaves = [...ons.keys()].sort();
  if (!chaves.length) throw new Error('o operador nacional ainda nao publicou nada de ' + DE + ' em diante');
  const ateOns = chaves[chaves.length - 1].slice(0, 10);
  const ateReg = eventos[eventos.length - 1].dia || String(eventos[eventos.length - 1].ts).slice(0, 10);
  const ate = ateOns < ateReg ? ateOns : ateReg;   // so se audita o que as DUAS rotas ja cobrem

  /* episodios: corrida contigua de meias horas com limite, dentro do dia */
  const pos = new Map();
  let corrida = [];
  const fecha = () => {
    if (!corrida.length) return;
    if (corrida.length === 1) pos.set(corrida[0], 'UNICO');
    else corrida.forEach((k, i) => pos.set(k, i === 0 ? 'PRIMEIRO' : (i === corrida.length - 1 ? 'ULTIMO' : 'MIOLO')));
    corrida = [];
  };
  const minDe = (k) => Number(k.slice(11, 13)) * 60 + Number(k.slice(14, 16));
  for (const k of chaves) {
    if (k.slice(0, 10) > ate) break;
    const o = ons.get(k);
    if (!(o.lim != null && o.lim < P.PLENA - P.FOLGA)) { fecha(); continue; }
    if (corrida.length) {
      const ant = corrida[corrida.length - 1];
      if (ant.slice(0, 10) !== k.slice(0, 10) || minDe(k) - minDe(ant) !== 30) fecha();
    }
    corrida.push(k);
  }
  fecha();

  /* ── o confronto ──────────────────────────────────────────────────────────────────────── */
  const porDia = new Map();
  const semRegistro = [];
  const diaDe = (k) => k.slice(0, 10);
  const pega = (d) => {
    if (!porDia.has(d)) porDia.set(d, { dia: d, casa: 0, diverge: 0, parcial: 0, so_ons: 0, so_reg: 0,
      livres: 0, difs: [], difs_miolo: [] });
    return porDia.get(d);
  };

  for (const k of chaves) {
    const d = diaDe(k);
    if (d > ate) continue;
    const o = ons.get(k);
    const onsRestr = o.lim != null && o.lim < P.PLENA - P.FOLGA;
    const p = slots.get(k);
    const x = pega(d);

    if (!p) {
      if (onsRestr) { x.so_ons += 1; semRegistro.push({ ts: k, ons_mw: r3(o.lim), razao: o.razao }); }
      continue;
    }
    /* slot pela metade nao se compara: seria divergencia de JANELA, nao de medicao */
    if (p.cobertura < 1) { if (onsRestr) x.parcial += 1; continue; }

    const regRestr = p.pot < P.PLENA - P.FOLGA;
    if (!onsRestr && !regRestr) { x.livres += 1; continue; }
    if (onsRestr && regRestr) {
      const dif = p.pot - o.lim;
      x.difs.push(Math.abs(dif));
      if (pos.get(k) === 'MIOLO') x.difs_miolo.push(Math.abs(dif));
      if (Math.abs(dif) <= TOL) x.casa += 1; else x.diverge += 1;
    } else if (onsRestr) {
      x.so_ons += 1;
      semRegistro.push({ ts: k, ons_mw: r3(o.lim), razao: o.razao, registro_mw: r3(p.pot), nota: 'registro marca plena' });
    } else {
      x.so_reg += 1;
    }
  }

  /* ── o atraso de borda, por dia — publicado, sem alarme ───────────────────────────────── */
  const primeiroOns = new Map(), ultimoOns = new Map();
  for (const [k, v] of pos) {
    const d = diaDe(k), m = minDe(k);
    if (v === 'PRIMEIRO' || v === 'UNICO') if (!primeiroOns.has(d) || m < primeiroOns.get(d)) primeiroOns.set(d, m);
    if (v === 'ULTIMO' || v === 'UNICO') if (!ultimoOns.has(d) || m + 30 > ultimoOns.get(d)) ultimoOns.set(d, m + 30);
  }
  const evPorDia = new Map();
  for (const e of eventos) {
    const d = e.dia || String(e.ts).slice(0, 10);
    if (!evPorDia.has(d)) evPorDia.set(d, []);
    evPorDia.get(d).push(e);
  }
  for (const [d, mIni] of primeiroOns) {
    if (d > ate) continue;
    const lista = (evPorDia.get(d) || []).filter((e) => e.restr);
    if (!lista.length) continue;
    const x = pega(d);
    x.atraso_inicio_min = lista[0].min - mIni;
    const mFim = ultimoOns.get(d);
    if (mFim != null) {
      const depois = (evPorDia.get(d) || []).filter((e) => e.min > lista[lista.length - 1].min && !e.restr);
      x.atraso_liberacao_min = (depois.length ? depois[0].min : lista[lista.length - 1].min) - mFim;
    }
  }

  /* ── defeitos datados, dentro do recorte ──────────────────────────────────────────────── */
  const ILEGIVEL = new Set(['ano_impossivel', 'data_ilegivel', 'hora_ilegivel', 'pot_ilegivel']);
  const defeitos = dataDosDefeitos(reg.eventos || [], reg.defeitos || [])
    .filter((d) => d.dia_aprox == null || d.dia_aprox >= DE);
  const ilegiveis = defeitos.filter((d) => ILEGIVEL.has(d.tipo));

  /* ── o relatorio ──────────────────────────────────────────────────────────────────────── */
  const dias = [...porDia.values()].filter((x) => x.dia <= ate).sort((a, b) => (a.dia < b.dia ? -1 : 1))
    .map((x) => ({ dia: x.dia, casa: x.casa, diverge: x.diverge, parcial: x.parcial,
      so_ons: x.so_ons, so_registro: x.so_reg, livres: x.livres,
      mediana_mw: r3(mediana(x.difs)), p90_mw: r3(quantil(x.difs, 0.9)),
      mediana_miolo_mw: r3(mediana(x.difs_miolo)),
      atraso_inicio_min: x.atraso_inicio_min == null ? null : x.atraso_inicio_min,
      atraso_liberacao_min: x.atraso_liberacao_min == null ? null : x.atraso_liberacao_min }));

  const todasMiolo = [].concat(...[...porDia.values()].map((x) => x.difs_miolo));
  const totCasa = dias.reduce((s, d) => s + d.casa, 0), totDiv = dias.reduce((s, d) => s + d.diverge, 0);

  const alarmes = [];
  if (semRegistro.length) alarmes.push({ gatilho: 'restricao_sem_registro', n: semRegistro.length,
    detalhe: semRegistro.slice(0, 20) });
  if (ilegiveis.length) alarmes.push({ gatilho: 'linha_ilegivel', n: ilegiveis.length, detalhe: ilegiveis.slice(0, 20) });
  const diasFora = dias.filter((d) => d.mediana_miolo_mw != null && d.mediana_miolo_mw > TOL_DIA);
  if (diasFora.length) alarmes.push({ gatilho: 'mediana_do_dia_fora', n: diasFora.length,
    limiar_mw: TOL_DIA, detalhe: diasFora.map((d) => ({ dia: d.dia, mediana_miolo_mw: d.mediana_miolo_mw })) });

  const out = {
    gerado_em: new Date().toISOString(),
    recorte_de: DE, auditado_ate: ate,
    tolerancia_mw: TOL, tolerancia_mediana_dia_mw: TOL_DIA,
    resumo: {
      dias: dias.length,
      meias_horas_com_restricao_nas_duas: totCasa + totDiv,
      casam: totCasa, divergem: totDiv,
      pct_casam: (totCasa + totDiv) ? Math.round(1000 * totCasa / (totCasa + totDiv)) / 10 : null,
      mediana_miolo_mw: r3(mediana(todasMiolo)), p90_miolo_mw: r3(quantil(todasMiolo, 0.9)),
      restricao_sem_registro: semRegistro.length,
      registro_sem_lastro: dias.reduce((s, d) => s + d.so_registro, 0),
      atraso_inicio_mediana_min: mediana(dias.map((d) => d.atraso_inicio_min).filter((v) => v != null)),
      atraso_liberacao_mediana_min: mediana(dias.map((d) => d.atraso_liberacao_min).filter((v) => v != null)),
    },
    dias, alarmes, defeitos,
  };

  console.log('AUDITORIA ' + DE + ' a ' + ate + ' · ' + dias.length + ' dias');
  console.log('  restricao nas duas rotas: ' + (totCasa + totDiv) + ' -> casam ' + totCasa + ' · divergem ' + totDiv
    + (out.resumo.pct_casam == null ? '' : '  (' + out.resumo.pct_casam + '%)'));
  console.log('  mediana no miolo: ' + out.resumo.mediana_miolo_mw + ' MW · p90 ' + out.resumo.p90_miolo_mw + ' MW');
  console.log('  atraso: inicio ' + out.resumo.atraso_inicio_mediana_min + ' min · liberacao '
    + out.resumo.atraso_liberacao_mediana_min + ' min');

  if (!SECO) {
    const n = await grava('ppc_auditoria.json', out);
    console.log('  ppc_auditoria.json gravado (' + Math.round(n / 1024) + ' KB)');
  } else {
    console.log('  (SECO — nada gravado)');
  }

  if (alarmes.length) {
    console.error('');
    console.error('🔴 AUDITORIA REPROVOU:');
    for (const a of alarmes) console.error('   ' + a.gatilho + ': ' + a.n + ' ocorrencia(s) — '
      + JSON.stringify(a.detalhe.slice(0, 3)));
    process.exit(1);
  }
  console.log('  sem alarme.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
