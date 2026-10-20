'use strict';
/*
 * gen-pvstr-logger.js — a curva de 30 min por inversor (pvstr_hora_<usina>) e a razao de cada string (pvstr_str_<usina>_<ts>) pelo
 * logger Sungrow (strings-logger, 19/10/2026).
 *
 * Decisao do humano (19/10/2026): "strings de 30 minutos deve sair todas do scada, e utilizar logger sungrow". Grava, com os MESMOS
 * nomes de blob e de campo que o Grafana (pvstr1r) e o Mapa do portal leem, a partir do que o gen-sungrow acabou de gravar
 * (sg_curva_<k>, sg_str_<k>, sg_str_entradas, sg_ident). A regra (meia hora integralizada, tudo ou nada, strings e MPPT pela
 * lib-strings, contrato) mora na lib-pvstr-logger.js; aqui so se le, chama, confere e grava.
 *
 * 🔴 A COPIA DO SUPERVISORIO NAO SE PERDE NA VIRADA. Ate este lote o gen-perdas gravava pvstr_hora_<u> e pvstr_str_<u>_<ts> com o
 *    export do supervisorio; agora grava pvstr_hora_<u>_scada e pvstr_str_<u>_<ts>_scada (lib-pvstr-logger.nomeScada), que o
 *    gen-ts-setpoint le (o setpoint de despacho so existe ali). Na primeira rodada, se a copia ainda nao existe, este gerador a
 *    SEMEIA com o blob antigo — so se ele nao tiver a marca do logger (`origem_inversor`); com a marca e sem a copia, aborta.
 * 🔴 GUARDAS antes de gravar (aborta sem gravar nada): fonte ausente; usina sem nenhuma curva; linha fora do contrato (listas do
 *    tamanho de h, grade de 30 min, sem `sp`, faixas fisicas); inversores por usina e dia acima da placa; curva sem as strings do
 *    mesmo inversor-dia em mais de 1 % dos pares.
 *
 * Roda no sungrow.yml, DEPOIS do gen-sungrow e ANTES do gen-ts-setpoint (que le a copia semeada aqui).
 * Env: DADOS_STORAGE · LOCAL_IN_DIR (le os blobs de uma pasta) · LOCAL_OUT_DIR (grava numa pasta)
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const LD = require('./lib-le-dados');
const PV = require('./lib-pvstr-logger.js');
const { PLACA } = require('./lib-placa.js');
const { USINAS } = require('./lib-sungrow-disp.js');

const BLOB = 'https://rbenergydata.blob.core.windows.net/dados/';
const SEM_STR_MAX = 0.01;                                    // curva sem as strings do mesmo inversor-dia: ate 1 % dos pares

const parse = (b) => { if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return JSON.parse(b.toString('utf8').replace(/^﻿/, '')); };
/* so o 404 do proprio blob e ausencia (null); qualquer outra falha estoura */
async function le(nome) {
  if (process.env.LOCAL_IN_DIR) {
    const f = path.join(process.env.LOCAL_IN_DIR, nome);
    return fs.existsSync(f) ? parse(fs.readFileSync(f)) : null;
  }
  const x = await LD.pede(BLOB + nome, { 'accept-encoding': 'gzip' });
  if (x.status === 404) return null;
  if (x.status !== 200) throw new Error(nome + ' -> HTTP ' + x.status);
  return parse(x.buf);
}
async function existe(nome) {
  if (process.env.LOCAL_IN_DIR) return fs.existsSync(path.join(process.env.LOCAL_IN_DIR, nome));
  const h = await LD.cabecalho(BLOB + nome);
  if (h.status === 404) return false;
  if (h.status !== 200) throw new Error(nome + ' -> HTTP ' + h.status + ' (HEAD)');
  return true;
}
async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados');
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}
// a decisao da copia do supervisorio (usar, semear, abortar) mora na lib-inv-logger (copiaScada), com o ensaio dela
const copiaScada = (novo, antigo) => PV.copiaScada({ existe, le, log: (m) => console.log(m) }, novo, antigo, false);

/* as guardas sobre o que vai ser gravado; devolve a lista do que esta errado */
function guardas(M) {
  const mau = [];
  for (const u of USINAS) if (!(M.hora[u] || []).length) mau.push(u + ': nenhuma curva de 30 min');
  for (const [u, L] of Object.entries(M.hora)) {
    for (const l of L) mau.push(...PV.contrato(l));
    const porDia = {}; for (const l of L) porDia[l.d] = (porDia[l.d] || 0) + 1;
    for (const [d, n] of Object.entries(porDia)) if (n > PLACA[u].inversores) mau.push(u + ' ' + d + ': ' + n + ' inversores acima da placa ' + PLACA[u].inversores);
  }
  const tot = M.n.pares + M.n.sem_meia;
  if (tot && M.n.sem_str / tot > SEM_STR_MAX) mau.push(M.n.sem_str + ' de ' + tot + ' inversor-dias com curva e sem as strings (acima de ' + (SEM_STR_MAX * 100) + ' %)');
  return mau;
}

(async () => {
  const agora = new Date().toISOString();
  const sgIdent = await le('sg_ident.json');
  if (!sgIdent || !sgIdent.ident || !Object.keys(sgIdent.ident).length) throw new Error('sg_ident.json ausente ou vazio: nada gravado');
  const entradas = await le('sg_str_entradas.json');
  if (!entradas || !Array.isArray(entradas.entradas) || !entradas.entradas.length) throw new Error('sg_str_entradas.json ausente ou vazio: nada gravado');
  // os eletrocentros com inversor identificado (os mesmos do sg_curva_<k> do gen-sungrow)
  const etcs = [...new Set(Object.values(sgIdent.ident).map((a) => a.pos.split('/').slice(0, 2).join('_')))].sort();
  const curva = {}, str = {}; let semCurva = 0;
  for (const k of etcs) {
    const c = await le('sg_curva_' + k + '.json'), s = await le('sg_str_' + k + '.json');
    if (c) curva[k] = c; else semCurva += 1;
    if (s) str[k] = s;
  }
  const M = PV.monta({ etcs, curva, str, entradas });
  console.log('fontes: ' + etcs.length + ' eletrocentros (' + semCurva + ' sem sg_curva) · ' + M.n.pares + ' inversor-dias com meia hora · '
    + M.n.sem_meia + ' sem meia hora gerando · ' + M.n.sem_str + ' curva sem strings');
  const mau = guardas(M);
  if (mau.length) { console.error('gen-pvstr-logger: NADA GRAVADO\n  ' + mau.slice(0, 20).join('\n  ') + (mau.length > 20 ? '\n  ... +' + (mau.length - 20) : '')); process.exit(1); }

  // a copia do supervisorio: semeada so na primeira rodada (o gen-perdas passa a grava-la), conferida antes de qualquer gravacao
  const sementes = [];
  for (const u of USINAS) sementes.push([PV.nomeScada('pvstr_hora_' + u + '.json'), 'pvstr_hora_' + u + '.json']);
  for (const k of etcs) sementes.push([PV.nomeScada('pvstr_str_' + k + '.json'), 'pvstr_str_' + k + '.json']);
  const copias = [];
  for (const [novo, antigo] of sementes) { const c = await copiaScada(novo, antigo); if (c.semeada) copias.push([novo, c.j]); }

  const pesos = {};
  for (const [novo, j] of copias) pesos[novo + ' (semente)'] = await escreve(novo, j);
  const base = { gerado_em: agora, origem_inversor: PV.ORIGEM, esquema: PV.ESQUEMA, janela_dias: PV.DIAS, fonte: 'logger Sungrow, leitura a cada 5 min',
    piso_dispersao_a: PV.PISO_A,
    nota_piso: 'a razao entre strings (sm) e entre MPPT (mm) so existe quando a mediana das correntes da meia hora passa de ' + PV.PISO_A
      + ' A. Abaixo disso a razao e ruido de amanhecer e de anoitecer, e sai nula em vez de sair errada.' };
  for (const u of USINAS) {
    const L = M.hora[u];
    pesos['pvstr_hora_' + u + '.json'] = await escreve('pvstr_hora_' + u + '.json', { ...base, usina: u, dias_cobertos: M.dias[u].length,
      passo: '30 min · media das seis leituras de 5 min do logger (T a T+25), rotulo no inicio', unidade: PV.UNIDADE, serie: L });
  }
  let nS = 0, kbS = 0;
  for (const [k, L] of Object.entries(M.str).sort()) {
    const [u, ts] = k.split('_');
    const b = await escreve('pvstr_str_' + k + '.json', { ...base, usina: u, ts,
      unidade: 's: corrente de cada string real em % da mediana das strings reais do inversor, na media da meia hora (seis leituras de 5 min); '
        + 'md: essa mediana em A. Nulo com a mediana abaixo de ' + PV.PISO_A + ' A (piso de leitura).', serie: L });
    nS += 1; kbS += b / 1024;
  }
  for (const u of USINAS) console.log('  pvstr_hora_' + u + '.json: ' + M.hora[u].length + ' inversor-dias · ' + M.dias[u][0] + ' a ' + M.dias[u][M.dias[u].length - 1]
    + ' · ' + Math.round(pesos['pvstr_hora_' + u + '.json'] / 1024) + ' KB');
  console.log('  pvstr_str_<usina>_<ts>.json: ' + nS + ' arquivos · ' + Math.round(kbS) + ' KB no total');
  for (const [k, v] of Object.entries(pesos)) if (/semente/.test(k)) console.log('  ' + k + ' ' + Math.round(v / 1024) + ' KB');
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
