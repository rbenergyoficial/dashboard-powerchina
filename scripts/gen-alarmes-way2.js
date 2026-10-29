'use strict';
/*
 * gen-alarmes-way2.js — os alarmes de circuito ABERTO e de barra/trafo SEM TENSÃO deduzidos dos medidores de 5 min
 * (`alarmes_way2.json`, tela "Alarmes e ocorrências"; lote alarmes-way2, 28/10/2026). A regra é a lib-alarme-circuito.js; aqui ficam
 * a leitura, a fusão com o publicado e a gravação.
 *
 * Roda no way2-recent.yml, DEPOIS de todo produto do job, sobre a cópia local da coleta da MESMA rodada (ELET_LOCAL_DIR): nenhuma
 * leitura nova da Way2 nem do storage além do próprio alarmes_way2.json.
 *   1. a cópia local tem SÓ o dia corrente: a janela recalculada começa na borda esquerda do 1º slot dela (janelaIni);
 *   2. o publicado entra como semente: o episódio com início ANTES da janela (a véspera) que estava aberto, ou que fechou DENTRO da
 *      janela, continua ou fecha com o mesmo id. 🔴 O que fechou hoje também: sem ele, a rodada seguinte veria os slots de hoje como
 *      episódio novo, com início 00:00, sobreposto ao da véspera (achado do ensaio do gerador, 28/10/2026). 🔴 E só os de antes da
 *      janela: um episódio de HOJE passado como véspera geraria um fechamento falso à 00:00 com o id velho quando o início muda (slot
 *      provisório que vira medido). Os de hoje a rodada refaz inteiros;
 *   3. a fusão SUBSTITUI a janela recalculada e poda o que terminou há mais de JANELA_DIAS (o aberto nunca sai);
 *   4. grava em gzip com If-Match no ETag lido (If-None-Match na primeira vez): se outra rodada gravou no meio, desiste e a próxima
 *      refaz. O job tem cancel-in-progress.
 * Primeira vez (o blob não existe): antes de hoje, refaz os JANELA_DIAS dias anteriores do hist/way2_<dia>.json, um a um, cada um
 * semeado pelo anterior (~4 MB por dia, uma vez só). Dia que falta no histórico fica de fora com aviso.
 * Declarado: a cópia do dia e o hist/way2 perdem os últimos ~15–20 min de cada dia (a Way2 completa o slot com atraso e a coleta
 * passa para o dia novo). Abertura nesse trecho só aparece se continuar depois da meia-noite, com início 00:00. Medidor sem leitura
 * não decide: o aberto dele fica aberto até ele voltar.
 *
 * Env: a credencial do storage pela lib-conteiner (o OIDC do job) · ELET_LOCAL_DIR.
 * Ensaio sem rede: LOCAL_ELET (a coleta) · LOCAL_PUB (o publicado; ausente = primeira vez) · LOCAL_OUT (onde gravar) · AGORA (ISO).
 * SEMEIA_LOCAL=1 com LOCAL_OUT e sem LOCAL_PUB: refaz a primeira vez lendo o histórico (lib-le-dados, DADOS_SAS), sem gravar.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const A = require('./lib-alarme-circuito');

const CONTAINER = 'dados', BLOB = 'alarmes_way2.json';
const JANELA_DIAS = 7;
const DIA_MS = 86400 * 1000, SLOT_MS = A.LIMITES.SLOT_MS;
const COBERTURA_MIN = 20;   // `lido_ate`: o último slot com dado completo em pelo menos 20 dos 24 medidores (o critério da âncora do selo)

const gunzipSe = (b) => (b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b);
const parse = (b) => JSON.parse(gunzipSe(b).toString('utf8').replace(/^﻿/, ''));

// a parte pura: coleta do dia + publicado → o arquivo novo (null = nada a gravar)
function compoe(elet, pub, agoraMs) {
  const S = A.serieDosDados(elet.dados);
  let t0 = Infinity;
  const validos = new Map();   // t → quantos medidores com o slot completo
  for (const serie of Object.values(S)) for (const s of serie.values()) {
    t0 = Math.min(t0, s.t);
    if (s.ok) validos.set(s.t, (validos.get(s.t) || 0) + 1);
  }
  if (!isFinite(t0)) return null;                 // a coleta do dia ainda não tem slot (logo depois da meia-noite)
  const janelaIni = t0 - SLOT_MS;
  const anteriores = (pub && pub.eventos) || [];
  const semente = anteriores.filter((e) => e.regra !== 'se_sem_tensao' && A.msBRT(e.ini) < janelaIni
    && (e.fim == null || A.msBRT(e.fim) > janelaIni));
  const novos = A.detecta(elet.dados, { abertos: semente });
  const eventos = A.funde(anteriores, novos, agoraMs - JANELA_DIAS * DIA_MS, janelaIni);
  const ate = [...validos.entries()].filter(([, n]) => n >= COBERTURA_MIN).reduce((m, [t]) => Math.max(m, t), -Infinity);
  return {
    gerado: A.isoBRT(agoraMs), gerado_ms: agoraMs, fonte: 'medidores', janela_dias: JANELA_DIAS,
    lido_ate: isFinite(ate) ? A.isoBRT(ate) : null, lido_ate_ms: isFinite(ate) ? ate : null,
    eq: A.EQ, eventos,
  };
}

// a primeira vez: os dias anteriores do histórico do medidor, do mais antigo ao de ontem
async function semeia(elet, agoraMs) {
  const LD = require('./lib-le-dados');
  const hoje = A.isoBRT(agoraMs).slice(0, 10);
  let pub = null;
  for (let k = JANELA_DIAS; k >= 1; k--) {
    const dia = A.isoBRT(A.msBRT(hoje + 'T12:00:00') - k * DIA_MS).slice(0, 10);
    const j = await LD.json(LD.BASE + 'hist/way2_' + dia + '.json');   // só o 404 vem nulo; outra falha estoura
    if (!j || !Array.isArray(j.dados)) { console.log('::warning::semente: sem o histórico do medidor de ' + dia + ', o dia fica de fora'); continue; }
    pub = compoe(j, pub, agoraMs) || pub;
    console.log('semente ' + dia + ': ' + (pub ? pub.eventos.length : 0) + ' eventos');
  }
  return pub;
}

function leColeta() {
  const arq = process.env.LOCAL_ELET || (process.env.ELET_LOCAL_DIR && path.join(process.env.ELET_LOCAL_DIR, 'way2_eletrico.json'));
  if (!arq || !fs.existsSync(arq)) throw new Error('sem a cópia local da coleta desta rodada (ELET_LOCAL_DIR): a coleta não gravou');
  const j = parse(fs.readFileSync(arq));
  if (!Array.isArray(j.dados)) throw new Error('a coleta não tem `dados`');
  return j;
}

async function main() {
  const agoraMs = process.env.AGORA ? A.msBRT(process.env.AGORA) : Date.now();
  const elet = leColeta();

  if (process.env.LOCAL_OUT) {
    let pub = process.env.LOCAL_PUB && fs.existsSync(process.env.LOCAL_PUB) ? parse(fs.readFileSync(process.env.LOCAL_PUB)) : null;
    if (!pub && process.env.SEMEIA_LOCAL === '1') pub = await semeia(elet, agoraMs);
    const out = compoe(elet, pub, agoraMs);
    if (!out) { console.log('a coleta do dia ainda não tem slot: nada a gravar'); return; }
    fs.writeFileSync(process.env.LOCAL_OUT, JSON.stringify(out));
    console.log('[ensaio] ' + out.eventos.length + ' eventos · lido até ' + out.lido_ate);
    return;
  }

  if (!require('./lib-conteiner').credencial()) throw new Error('sem credencial do storage (o OIDC do job)');
  const bc = require('./lib-conteiner').conteiner(CONTAINER).getBlockBlobClient(BLOB);
  let pub = null, etag = null;
  try {
    etag = (await bc.getProperties()).etag;
    pub = parse(await bc.downloadToBuffer());
  } catch (e) {
    // só o 404 do blob é ausência (primeira vez); qualquer outra falha estoura, senão a rodada apagaria a semana publicada
    if (!(e.statusCode === 404 && (e.code === 'BlobNotFound' || (e.details && e.details.errorCode === 'BlobNotFound')))) throw e;
  }
  if (!etag) pub = await semeia(elet, agoraMs);   // a primeira vez: a semana anterior, do histórico do medidor
  const out = compoe(elet, pub, agoraMs);
  if (!out) { console.log('a coleta do dia ainda não tem slot: nada a gravar'); return; }
  const buf = zlib.gzipSync(Buffer.from(JSON.stringify(out), 'utf8'));
  try {
    await bc.upload(buf, buf.length, {
      conditions: etag ? { ifMatch: etag } : { ifNoneMatch: '*' },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=60' },
    });
  } catch (e) {
    if (e.statusCode === 412 || e.statusCode === 409) { console.log('o alarmes_way2.json foi regravado no meio: desisto, a próxima rodada refaz'); return; }
    throw e;
  }
  const abertos = out.eventos.filter((e) => e.fim == null);
  console.log(BLOB + ': ' + out.eventos.length + ' eventos em ' + JANELA_DIAS + ' dias · ' + abertos.length + ' em curso'
    + (abertos.length ? ' (' + abertos.map((e) => e.regra + ' ' + e.tag).join(', ') + ')' : '')
    + ' · lido até ' + out.lido_ate + ' · ' + (buf.length / 1024).toFixed(1) + ' KB gz');
}

module.exports = { compoe, JANELA_DIAS };
if (require.main === module) main().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
