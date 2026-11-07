'use strict';
/*
 * gen-analise-vivo.js — grava `analise_vivo.json`: os achados da Análise de dados ao vivo (lote analise-ao-vivo, 07/11/2026). A regra é a
 * lib-analise-vivo.js; aqui ficam a leitura, a fusão com o publicado e a gravação.
 *
 * Roda no way2-recent.yml, DEPOIS do gen-alarmes-way2.js e ANTES do gen-alarmes-eventos.js (que leva os achados com voz para a faixa e a fala), sobre a
 * cópia local da coleta da MESMA rodada (ELET_LOCAL_DIR): nenhuma leitura nova da Way2.
 * Leituras do storage por rodada: o próprio analise_vivo.json, o alarmes_way2.json (a queda de medidor que já está publicada, para o D5 não repetir) e
 * a MARCA do ppc_restricao.json; o corpo do registro da mesa só se baixa quando a marca muda (a mesa sobe uma cópia a cada mudança e o ppc.yml republica
 * de hora em hora, no :23). Os eventos da mesa do dia ficam guardados no próprio arquivo (`mesa_dia`).
 * Latência da restrição em tempo real: a planilha da mesa → o coletor local (uma cópia a cada mudança) → ppc-raw → ppc.yml (cron :23, de hora em hora) →
 * ppc_restricao.json. O D1 de uma liberação só roda depois que ela chega ao blob: na prática, de 30 a 90 min depois.
 * A MESA: o registro sem a lista `eventos` é ERRO, nunca mesa vazia (mesa vazia calaria o D1 sem aviso). Quando a rodada não tem um registro confiável,
 * ela grava os outros detectores SEM o D1 (`mesa_ok: false`) e diz isso no log; só o alerta "liberado e não recuperou" fica desligado.
 *   · formato errado ou erro que não é passageiro: ::error:: e código 1;
 *   · falha passageira da rede (5xx, 408, 429, tempo, conexão) com o registro do dia guardado e lido há até MESA_MAX_H horas: usa o guardado (::warning::);
 *   · falha passageira sem registro guardado do dia (a virada do dia, a primeira rodada): a PRIMEIRA é tolerada (::warning::, sem o D1 nesta rodada);
 *     a segunda seguida, ou o guardado lido há mais de MESA_MAX_H horas: ::error:: e código 1. As falhas seguidas ficam em `mesa_falhas`.
 * MESA_MAX_H mede há quanto tempo ESTA rotina não consegue ler o registro (falhas seguidas de leitura): 3 h são ~36 rodadas de 5 min. O frescor do próprio
 * ppc_restricao.json (o ppc.yml parado, o coletor da mesa parado) não é medido aqui: é assunto do vigia do ppc.
 * Grava com If-Match no ETag lido (If-None-Match na primeira vez): outra rodada no meio, desiste e a próxima refaz.
 * Ensaio sem rede: LOCAL_ELET (a coleta) · LOCAL_MESA (ppc_restricao.json) · LOCAL_WAY2 (alarmes_way2.json) · LOCAL_PUB · LOCAL_OUT · AGORA (ISO BRT).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const A = require('./lib-analise-vivo');
const C = require('./lib-alarme-circuito');

const CONTAINER = 'dados', BLOB = 'analise_vivo.json', MESA = 'ppc_restricao.json', WAY2 = 'alarmes_way2.json';
const JANELA_DIAS = 7;
const MESA_MAX_H = 3;

/* o registro da mesa: sem a lista `eventos` é erro (nunca mesa vazia) */
function eventosDaMesa(j) {
  if (!j || !Array.isArray(j.eventos)) throw new Error(MESA + ' sem a lista `eventos`: formato inesperado, o D1 não roda');
  return j.eventos;
}
/* falha passageira da rede: a próxima rodada resolve; o resto é erro */
const passageira = (e) => (e && (e.statusCode >= 500 || e.statusCode === 408 || e.statusCode === 429)) || /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i.test(String(e && (e.code || e.message)));

/* o que fazer quando a leitura do registro falhou nesta rodada (pura: o ensaio julga cada caso). Devolve a mesa a usar (ou null), o aviso ou o erro e as
   falhas seguidas */
function mesaNaFalha(e, { guardada, lida, falhasAntes = 0, agoraMs }) {
  const falhas = falhasAntes + 1, msg = (e && e.message) || String(e);
  if (!passageira(e)) return { mesa: null, erro: MESA + ' com erro: ' + msg, falhas };
  if (guardada && lida != null && agoraMs - lida <= MESA_MAX_H * 3600e3) return { mesa: guardada, aviso: MESA + ' ilegível nesta rodada (' + msg + '): o D1 usa o registro guardado', falhas };
  if (!guardada && falhasAntes === 0) return { mesa: null, aviso: MESA + ' ilegível na primeira rodada do dia (' + msg + '): o D1 fica para a rodada seguinte', falhas };
  return { mesa: null, erro: MESA + ' ilegível em ' + falhas + ' rodadas seguidas e sem registro guardado lido nas últimas ' + MESA_MAX_H + ' h (' + msg + ')', falhas };
}
/* a linha do log de erro: diz o que segue funcionando (quem abre o log pelo e-mail do vigia) */
const linhaErro = (m) => '::error::Análise ao vivo: o alerta "liberado e não recuperou" está DESLIGADO nesta rodada; os outros alertas ao vivo (ocorrência agrupada, circuito sem geração, medidor sem dado) seguem gravando. Causa: ' + m;

const gunzipSe = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
const parse = (b) => JSON.parse(gunzipSe(b).toString('utf8').replace(/^﻿/, ''));
const leLocal = (f) => (f && fs.existsSync(f) ? parse(fs.readFileSync(f)) : null);
const nao404 = (e) => !(e.statusCode === 404 && (e.code === 'BlobNotFound' || (e.details && e.details.errorCode === 'BlobNotFound')));

function leColeta() {
  const arq = process.env.LOCAL_ELET || (process.env.ELET_LOCAL_DIR && path.join(process.env.ELET_LOCAL_DIR, 'way2_eletrico.json'));
  if (!arq || !fs.existsSync(arq)) throw new Error('sem a cópia local da coleta desta rodada (ELET_LOCAL_DIR): a coleta não gravou');
  const j = parse(fs.readFileSync(arq));
  if (!Array.isArray(j.dados)) throw new Error('a coleta não tem `dados`');
  return j;
}

/* o dia da coleta: o do primeiro carimbo (a cópia local tem só o dia corrente) */
function diaDaColeta(elet) {
  for (const s of elet.dados) for (const v of s.valores || []) if (v.data) return C.isoBRT(C.msBRT(v.data) - 1000).slice(0, 10);
  return null;
}

/* os eventos da mesa que valem para o dia: os do dia e o último anterior (a restrição que vinha aberta) */
function mesaDoDia(eventos, dia) {
  const ev = (eventos || []).filter((x) => x.dia <= dia).sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const ant = ev.filter((x) => x.dia < dia).slice(-1);
  return ant.concat(ev.filter((x) => x.dia === dia)).map((x) => ({ dia: x.dia, ts: x.ts, pot: x.pot, restr: x.restr }));
}

/* a parte pura: coleta + mesa do dia + publicado → o arquivo novo */
function compoe({ elet, mesa, way2, pub, agoraMs, marcaMesa = null, mesaLidaMs = null, erros = [], mesaFalhas = 0 }) {
  const dia = diaDaColeta(elet);
  if (!dia) return null;
  /* mesa null = sem registro confiável: os outros detectores rodam; o D1 fica sem liberação para olhar (e o arquivo diz mesa_ok falso) */
  const novos = A.guarda(A.analisa({ dados: elet.dados, mesa: mesa || [], dia, agoraMs, medidorCom: (way2 && way2.medidor_com) || [] }));
  const achados = A.guarda(A.funde(pub && pub.achados, novos, dia, agoraMs, JANELA_DIAS));
  return {
    esquema: A.ESQUEMA, gerado: C.isoBRT(agoraMs), gerado_ms: agoraMs, dia, janela_dias: JANELA_DIAS, fonte: 'analise',
    limiares: A.LIM, calibracao: A.CALIBRACAO, marcas: { mesa: marcaMesa }, mesa_dia: mesa || null, mesa_lida_ms: mesaLidaMs, mesa_ok: !!mesa, mesa_falhas: mesaFalhas, erros, achados,
    resumo: { abertos: achados.filter((a) => a.fim == null).length, por_tipo: achados.reduce((o, a) => { o[a.tipo] = (o[a.tipo] || 0) + 1; return o; }, {}) },
  };
}

async function main() {
  const agoraMs = process.env.AGORA ? C.msBRT(process.env.AGORA) : Date.now();
  const elet = leColeta(), dia = diaDaColeta(elet);
  if (process.env.LOCAL_OUT) {
    let mesa = null; const erros = [];
    try { mesa = mesaDoDia(eventosDaMesa(leLocal(process.env.LOCAL_MESA)), dia); } catch (e) { erros.push(e.message); }
    const out = compoe({ elet, mesa, way2: leLocal(process.env.LOCAL_WAY2), pub: leLocal(process.env.LOCAL_PUB), agoraMs, mesaLidaMs: mesa ? agoraMs : null, erros });
    if (!out) { console.log('a coleta do dia ainda não tem slot: nada a gravar'); return; }
    fs.writeFileSync(process.env.LOCAL_OUT, JSON.stringify(out));
    console.log('[ensaio] ' + out.achados.length + ' achados · ' + out.resumo.abertos + ' em curso');
    if (erros.length) { erros.forEach((m) => console.log(linhaErro(m))); process.exitCode = 1; }
    return;
  }
  const K = require('./lib-conteiner');
  if (!K.credencial()) throw new Error('sem credencial do storage (o OIDC do job)');
  const cont = K.conteiner(CONTAINER), bc = cont.getBlockBlobClient(BLOB);
  let pub = null, etag = null;
  try { etag = (await bc.getProperties()).etag; pub = parse(await bc.downloadToBuffer()); } catch (e) { if (nao404(e)) throw e; }
  let way2 = null;
  try { way2 = parse(await cont.getBlockBlobClient(WAY2).downloadToBuffer()); } catch (e) { console.log('::warning::' + WAY2 + ' ilegível (' + e.message + '): o D5 não suprime a queda já publicada nesta rodada'); }
  /* a mesa: só baixa quando a marca muda; senão, os eventos do dia guardados no publicado (do mesmo dia). Ver "A MESA" no cabeçalho */
  const guardada = pub && pub.dia === dia && pub.mesa_ok !== false && Array.isArray(pub.mesa_dia) ? pub.mesa_dia : null;
  let mesa = guardada, marca = pub && pub.marcas ? pub.marcas.mesa : null, lida = guardada ? pub.mesa_lida_ms || null : null, falhas = 0;
  const erros = [];
  try {
    const mb = cont.getBlockBlobClient(MESA), et = (await mb.getProperties()).etag;
    if (et !== marca || !mesa) { mesa = mesaDoDia(eventosDaMesa(parse(await mb.downloadToBuffer())), dia); marca = et; }
    lida = agoraMs;   // lido agora, ou a marca não mudou e o guardado é o mesmo registro do blob, conferido agora
  } catch (e) {
    const r = mesaNaFalha(e, { guardada, lida, falhasAntes: (pub && pub.mesa_falhas) || 0, agoraMs });
    mesa = r.mesa; falhas = r.falhas;
    if (r.aviso) console.log('::warning::' + r.aviso);
    if (r.erro) erros.push(r.erro);
  }
  const out = compoe({ elet, mesa, way2, pub, agoraMs, marcaMesa: marca, mesaLidaMs: mesa ? lida : null, erros, mesaFalhas: falhas });
  if (!out) { console.log('a coleta do dia ainda não tem slot: nada a gravar'); return; }
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(out), 'utf8'));
  try {
    await bc.upload(buf, buf.length, { conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=60' } });
  } catch (e) {
    if (e.statusCode === 412 || e.statusCode === 409) { console.log(BLOB + ' foi regravado no meio: desisto, a próxima rodada refaz'); return; }
    throw e;
  }
  const ab = out.achados.filter((a) => a.fim == null);
  console.log(BLOB + ': ' + out.achados.length + ' achados em ' + JANELA_DIAS + ' dias · ' + ab.length + ' em curso' + (ab.length ? ' (' + ab.map((a) => a.tipo + ' ' + a.tag).join(', ') + ')' : '')
    + ' · ' + (buf.length / 1024).toFixed(1) + ' KB gz');
  if (erros.length) { erros.forEach((m) => console.log(linhaErro(m))); process.exitCode = 1; }
}

module.exports = { compoe, mesaDoDia, diaDaColeta, eventosDaMesa, passageira, mesaNaFalha, linhaErro, JANELA_DIAS, MESA_MAX_H };
if (require.main === module) main().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
