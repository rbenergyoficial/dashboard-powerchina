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
 * BASE NOVA (alarmes-base, 05/11/2026): `medidor_com` traz a QUEDA DE COMUNICAÇÃO do medidor, lida do `eventos` do way2_saude da mesma rodada
 * (cópia local). Lista à parte, nunca em `eventos`: a tela lê todo `eventos` como desligamento. Cada item {id, c: 'medidor_com', p: 3, pid, tag, ini,
 * fim|null, fx: fim inferido}. Sem a cópia da saúde, a lista segue como estava. O histórico vai em hist/alarmes_way2_<AAAA>_<MM>.json (eventos e
 * medidor_com por mês, gravado só quando algo muda; id repetido: vale o mais novo). HIST_DE=AAAA-MM-DD refaz os circuitos desde a data, dia a dia,
 * lendo hist/way2_<dia>.json (~4 MB por dia) e não toca no alarmes_way2.json.
 * Env: a credencial do storage pela lib-conteiner (o OIDC do job) · ELET_LOCAL_DIR.
 * Ensaio sem rede: LOCAL_ELET (a coleta) · LOCAL_PUB (o publicado; ausente = primeira vez) · LOCAL_OUT (onde gravar) · AGORA (ISO).
 * LOCAL_SAUDE (a saúde da rodada) · LOCAL_HIST_DIR (onde gravar os meses).
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

// a queda de comunicação do medidor: o vigia diz o que está aberto agora; o aberto que sumiu dele voltou, em instante que a lista já não dá (`fx`)
function medidorCom(saude, anteriores, agoraMs) {
  const m = new Map((anteriores || []).map((e) => [e.id, e]));
  if (!saude || !Array.isArray(saude.eventos)) return [...m.values()];
  const visto = new Set();
  for (const e of saude.eventos) {
    if (e.tipo && e.tipo !== 'falha') continue;
    const id = 'med:' + e.pid + ':' + e.de, x = { id, c: 'medidor_com', p: 3, pid: e.pid, tag: A.PID[e.pid] || e.nome, ini: e.de, fim: e.ate || null };
    m.set(id, x); visto.add(id);
  }
  for (const e of m.values()) if (e.fim == null && !visto.has(e.id)) { e.fim = saude.atualizado || A.isoBRT(agoraMs); e.fx = 1; }
  const lim = agoraMs - JANELA_DIAS * DIA_MS;
  return [...m.values()].filter((e) => (e.fim ? A.msBRT(e.fim) : Infinity) >= lim).sort((a, b) => (a.ini < b.ini ? -1 : a.ini > b.ini ? 1 : a.id < b.id ? -1 : 1));
}

// a parte pura: coleta do dia + publicado → o arquivo novo (null = nada a gravar)
function compoe(elet, pub, agoraMs, saude = null) {
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
    eq: A.EQ, eventos, medidor_com: medidorCom(saude, pub && pub.medidor_com, agoraMs),
  };
}

// ---- histórico mensal: id repetido fica o mais novo. Mês = o do início do episódio
const nomeMes = (m) => 'hist/alarmes_way2_' + m.replace('-', '_') + '.json';
const assina = (o) => JSON.stringify([...(o.eventos || []), ...(o.medidor_com || [])].map((e) => [e.id, e.fim]));
function fundeMes(atual, novo, mes) {
  const juntos = (k) => { const m = new Map(((atual && atual[k]) || []).map((e) => [e.id, e]));
    for (const e of novo[k] || []) if ((e.ini_est || e.ini).slice(0, 7) === mes) m.set(e.id, e);
    return [...m.values()].sort((a, b) => (a.ini < b.ini ? -1 : a.ini > b.ini ? 1 : a.id < b.id ? -1 : 1)); };
  return { esquema: 1, fonte: 'medidores', mes, gerado: novo.gerado, eq: novo.eq, eventos: juntos('eventos'), medidor_com: juntos('medidor_com') };
}
const mesesDe = (o) => [...new Set([...(o.eventos || []), ...(o.medidor_com || [])].map((e) => (e.ini_est || e.ini).slice(0, 7)))].sort();
async function gravaMeses(o, le, grava) {
  for (const mes of mesesDe(o)) { const f = fundeMes(await le(nomeMes(mes)), o, mes); await grava(nomeMes(mes), f); console.log(nomeMes(mes) + ': ' + f.eventos.length + ' eventos, ' + f.medidor_com.length + ' quedas de medidor'); }
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

// a saúde da rodada, pela cópia local: sem ela, nada de leitura nova (a queda de medidor espera a próxima rodada)
function leSaude() {
  const arq = process.env.LOCAL_SAUDE || (process.env.ELET_LOCAL_DIR && path.join(process.env.ELET_LOCAL_DIR, 'way2_saude.json'));
  if (!arq || !fs.existsSync(arq)) return null;
  try { return parse(fs.readFileSync(arq)); } catch (e) { console.log('::warning::way2_saude da rodada ilegível (' + e.message + '): a queda de medidor fica para a próxima'); return null; }
}

function leColeta() {
  const arq = process.env.LOCAL_ELET || (process.env.ELET_LOCAL_DIR && path.join(process.env.ELET_LOCAL_DIR, 'way2_eletrico.json'));
  if (!arq || !fs.existsSync(arq)) throw new Error('sem a cópia local da coleta desta rodada (ELET_LOCAL_DIR): a coleta não gravou');
  const j = parse(fs.readFileSync(arq));
  if (!Array.isArray(j.dados)) throw new Error('a coleta não tem `dados`');
  return j;
}

// o histórico dos circuitos desde HIST_DE: dia a dia, cada dia semeado pelo anterior, como a rodada normal
async function refazHist(de, agoraMs, le, grava) {
  const LD = require('./lib-le-dados');
  const hoje = A.isoBRT(agoraMs).slice(0, 10), dias = [];
  for (let d = de; d < hoje; d = A.isoBRT(A.msBRT(d + 'T12:00:00') + DIA_MS).slice(0, 10)) dias.push(d);
  let pub = null;
  for (const dia of dias) {
    const j = await LD.json(LD.BASE + 'hist/way2_' + dia + '.json');   // só o 404 vem nulo; outra falha estoura
    if (!j || !Array.isArray(j.dados)) { console.log('::warning::sem o histórico do medidor de ' + dia + ', o dia fica de fora'); continue; }
    const fim = A.msBRT(dia + 'T23:59:00');
    const o = compoe(j, pub, fim);
    if (!o) continue;
    await gravaMeses(o, le, grava);
    pub = o;
  }
}

async function main() {
  const agoraMs = process.env.AGORA ? A.msBRT(process.env.AGORA) : Date.now();
  const leMesLocal = async (n) => { const f = path.join(process.env.LOCAL_HIST_DIR, n); return fs.existsSync(f) ? parse(fs.readFileSync(f)) : null; };
  const gravaMesLocal = async (n, o) => { const f = path.join(process.env.LOCAL_HIST_DIR, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, zlib.gzipSync(Buffer.from(JSON.stringify(o)))); };
  const leMes = async (n) => { const LD = require('./lib-le-dados'); return LD.json(LD.BASE + n); };   // só o 404 é ausência
  const gravaMes = async (n, o) => { const b = zlib.gzipSync(Buffer.from(JSON.stringify(o), 'utf8'));
    await require('./lib-conteiner').conteiner(CONTAINER).getBlockBlobClient(n).upload(b, b.length, { blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } }); };
  if (process.env.HIST_DE) {
    if (process.env.LOCAL_HIST_DIR) return refazHist(process.env.HIST_DE, agoraMs, leMesLocal, gravaMesLocal);
    return refazHist(process.env.HIST_DE, agoraMs, leMes, gravaMes);
  }
  const elet = leColeta(), saude = leSaude();

  if (process.env.LOCAL_OUT) {
    let pub = process.env.LOCAL_PUB && fs.existsSync(process.env.LOCAL_PUB) ? parse(fs.readFileSync(process.env.LOCAL_PUB)) : null;
    if (!pub && process.env.SEMEIA_LOCAL === '1') pub = await semeia(elet, agoraMs);
    const out = compoe(elet, pub, agoraMs, saude);
    if (!out) { console.log('a coleta do dia ainda não tem slot: nada a gravar'); return; }
    fs.writeFileSync(process.env.LOCAL_OUT, JSON.stringify(out));
    if (process.env.LOCAL_HIST_DIR && (!pub || assina(pub) !== assina(out))) await gravaMeses(out, leMesLocal, gravaMesLocal);
    console.log('[ensaio] ' + out.eventos.length + ' eventos · ' + out.medidor_com.length + ' quedas de medidor · lido até ' + out.lido_ate);
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
  const out = compoe(elet, pub, agoraMs, saude);
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
  // o mês só se regrava quando algo muda (a rodada é de 5 min). Falha aqui não derruba o job: a próxima mudança refunde, e o blob de 7 dias já subiu
  if (!pub || assina(pub) !== assina(out)) try { await gravaMeses(out, leMes, gravaMes); } catch (e) { console.log('::warning::histórico mensal dos medidores não gravado: ' + e.message); }
  const abertos = out.eventos.filter((e) => e.fim == null);
  console.log(BLOB + ': ' + out.eventos.length + ' eventos em ' + JANELA_DIAS + ' dias · ' + abertos.length + ' em curso'
    + (abertos.length ? ' (' + abertos.map((e) => e.regra + ' ' + e.tag).join(', ') + ')' : '')
    + ' · lido até ' + out.lido_ate + ' · ' + (buf.length / 1024).toFixed(1) + ' KB gz');
}

module.exports = { compoe, medidorCom, fundeMes, assina, mesesDe, nomeMes, JANELA_DIAS };
if (require.main === module) main().catch((e) => { console.error('🔴 ' + e.message); process.exit(1); });
