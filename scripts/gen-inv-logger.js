'use strict';
/*
 * gen-inv-logger.js — os blobs de inversor que as telas leem, pela fonte do logger Sungrow (fonte-inv-logger, 19/10/2026).
 *
 * Regra do humano (19/10/2026): dado de inversor vem do logger Sungrow (coleta de 5 min); o supervisorio (export PV_WS_TR, parado
 * desde 14/10/2026) fica so para comparar. Grava, com os MESMOS nomes de blob e de campo que o portal, o Grafana e o gen-agente-om
 * leem:
 *   perdas_diario.json   cobertura, parados e parciais, energia CC/CA e conversao, contador, medidor; e, so para o Comparativo, a
 *                        disponibilidade do supervisorio copiada do perdas_diario_scada.json (o gen-perdas grava este)
 *   perdas_inv.json      por inversor e dia (60 dias): energia, conversao, potencia maxima, temperatura, isolamento, strings, MPPT,
 *                        disponibilidade da posicao
 *   strings_alarme.json  as strings sem corrente e fracas (o sg_str_alarme no contrato do strings_alarme)
 *   inv_scada.json       os inversores abaixo dos pares (a regra do gen-inv-scada sobre a energia do dia do logger)
 * As regras moram na lib-inv-logger.js; aqui so se le, chama, confere e grava.
 *
 * 🔴 A COPIA DO SUPERVISORIO NAO SE PERDE NA VIRADA. Ate este lote o gen-perdas gravava perdas_diario/perdas_inv/strings_alarme com
 *    o dado do supervisorio; agora grava perdas_diario_scada/perdas_inv_scada/strings_alarme_scada. Na primeira rodada, se a copia
 *    `_scada` ainda nao existe, este gerador a SEMEIA com o blob antigo — so se ele nao tiver a marca do logger (`origem_inversor`).
 *    Com a marca e sem a copia, aborta: o historico do supervisorio teria se perdido, e quem decide e o humano.
 * 🔴 GUARDAS antes de gravar (aborta sem gravar nada): fonte ausente ou vazia; parados + parciais acima do lido ou lido acima da
 *    placa; lido + sem leitura diferente da placa; ultimo dia do diario diferente do ultimo dia da disponibilidade do logger; campo
 *    do supervisorio (horas, lidos, gerando, jan_slots, setpoint) num inversor-dia; ranking vazio.
 *
 * Roda no sungrow.yml, DEPOIS do gen-sungrow (le o que ele acabou de gravar).
 * Env: DADOS_STORAGE · LOCAL_IN_DIR (le os blobs de uma pasta) · LOCAL_OUT_DIR (grava numa pasta) · JANELA_INV=60
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const LD = require('./lib-le-dados');
const L = require('./lib-inv-logger.js');
const { PLACA } = require('./lib-placa.js');
const { USINAS } = require('./lib-sungrow-disp.js');

const BLOB = 'https://rbenergydata.blob.core.windows.net/dados/';
const JANELA_INV = Number(process.env.JANELA_INV || 60);     // a mesma janela do perdas_inv do supervisorio (peso do mapa)
const SEMENTES = L.SEMENTES;
const CAMPOS_SO_SCADA_INV = ['horas', 'lidos', 'gerando', 'jan_slots', 'setpoint_min', 'setpoint_ger', 'nominal', 'ef_imp'];

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
async function exige(nome, ok) {
  const j = await le(nome);
  if (!j || !ok(j)) throw new Error(nome + ' ausente ou vazio: nada gravado');
  return j;
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

async function existe(nome) {
  if (process.env.LOCAL_IN_DIR) return fs.existsSync(path.join(process.env.LOCAL_IN_DIR, nome));
  const h = await LD.cabecalho(BLOB + nome);
  if (h.status === 404) return false;
  if (h.status !== 200) throw new Error(nome + ' -> HTTP ' + h.status + ' (HEAD)');
  return true;
}
// a decisao da copia do supervisorio (usar, semear, abortar) mora na lib (L.copiaScada), com o ensaio dela; aqui so o transporte
const copiaScada = (novo, antigo, conteudo) => L.copiaScada({ existe, le, log: (m) => console.log(m) }, novo, antigo, conteudo);

function guardas(serie, inv, rank, sgDisp) {
  const mau = [];
  for (const o of serie) for (const u of USINAS) {
    const n = o[u + '_n_inv']; if (n == null) continue;
    const p = PLACA[u].inversores;
    if (n > p) mau.push(o.dia + ' ' + u + ': ' + n + ' lidos acima da placa ' + p);
    if (o[u + '_inv_parados'] + o[u + '_inv_parciais'] > n) mau.push(o.dia + ' ' + u + ': parados + parciais acima dos ' + n + ' lidos');
    if (n + o[u + '_inv_sem_leitura'] !== p) mau.push(o.dia + ' ' + u + ': lidos + sem leitura diferente da placa');
  }
  const ultDisp = sgDisp.serie[sgDisp.serie.length - 1].dia;
  const ultDia = serie.filter((o) => USINAS.some((u) => o[u + '_n_inv'] != null)).map((o) => o.dia).pop();
  if (ultDia !== ultDisp) mau.push('ultimo dia do diario ' + ultDia + ' diferente do ultimo da disponibilidade do logger ' + ultDisp);
  const sujo = inv.find((l) => CAMPOS_SO_SCADA_INV.some((c) => c in l));
  if (sujo) mau.push('campo do supervisorio no inversor-dia ' + sujo.dia + ' ' + sujo.ufv + '/' + sujo.ts + '/' + sujo.inv);
  if (!inv.length) mau.push('perdas_inv vazio');
  if (!rank.ranking.length) mau.push('ranking vazio');
  return mau;
}

(async () => {
  const agora = new Date().toISOString();
  const temSerie = (j) => Array.isArray(j.serie) && j.serie.length > 0;
  const sgDisp = await exige('sg_disp_dia.json', temSerie);
  const sgDispInv = await exige('sg_disp_inv_dia.json', (j) => Array.isArray(j.dias) && j.dias.length && j.inv && Object.keys(j.inv).length);
  const sgSaude = await exige('sg_saude.json', (j) => Array.isArray(j.usina_dia) && j.usina_dia.length);
  const sgFrota = await exige('sg_frota_dia.json', (j) => Array.isArray(j.dias) && j.dias.length && j.inv);
  const sgStr = await exige('sg_str_alarme.json', (j) => Array.isArray(j.serie) && Array.isArray(j.resumo));
  const sgIdent = await exige('sg_ident.json', (j) => j.ident && Object.keys(j.ident).length);
  const cmp = await exige('cmp_diario.json', temSerie);
  const w2d = await exige('way2_daily.json', (j) => Array.isArray(j.dias) && j.dias.length);
  const saudePorUsina = {}, invDiaPorUsina = {};
  for (const u of USINAS) {
    saudePorUsina[u] = await exige('sg_saude_' + u + '.json', temSerie);
    invDiaPorUsina[u] = await exige('sg_inv_dia_' + u + '.json', temSerie);
  }
  // os eletrocentros com inversor identificado (os mesmos que o gen-sungrow grava no sg_mppt_<k>); arquivo ausente = sem MPPT nele
  const etcs = [...new Set(Object.values(sgIdent.ident).map((a) => a.pos.split('/').slice(0, 2).join('_')))].sort();
  const mpptPorEtc = {}; let semMppt = 0;
  for (const k of etcs) { const j = await le('sg_mppt_' + k + '.json'); if (j) mpptPorEtc[k] = j; else semMppt++; }
  const copias = {};
  for (const [novo, antigo] of SEMENTES) copias[novo] = await copiaScada(novo, antigo, novo === 'perdas_diario_scada.json');
  const scada = copias['perdas_diario_scada.json'].j;
  console.log('fontes: sg_disp_dia ' + sgDisp.serie.length + ' dias (' + sgDisp.serie[0].dia + ' a ' + sgDisp.serie[sgDisp.serie.length - 1].dia + ') · '
    + 'sg_disp_inv_dia ' + Object.keys(sgDispInv.inv).length + ' posicoes · sg_frota_dia ' + sgFrota.dias.length + ' dias · mppt ' + Object.keys(mpptPorEtc).length
    + ' de ' + etcs.length + ' eletrocentros' + (semMppt ? ' (' + semMppt + ' sem arquivo)' : '') + ' · copia do supervisorio: '
    + (scada ? scada.serie.length + ' dias' + (copias['perdas_diario_scada.json'].semeada ? ' (SEMEADA nesta rodada)' : '') : 'nenhuma'));

  const serie = L.diario({ sgDisp, sgDispInv, sgSaude, saudePorUsina, cmp, w2d, scada });
  const inv = L.porInversor({ saudePorUsina, invDiaPorUsina, mpptPorEtc, sgDispInv }, JANELA_INV);
  const rank = L.ranking(sgFrota, agora);
  const alarm = L.alarmes(sgStr, agora);
  const mau = guardas(serie, inv, rank, sgDisp);
  if (mau.length) { console.error('gen-inv-logger: NADA GRAVADO\n  ' + mau.slice(0, 20).join('\n  ')); process.exit(1); }

  // a raiz do diario: o cadastro fixo (placa, rastreadores, modulos) vem da copia do supervisorio, que o gen-perdas mantem
  const CADASTRO = ['usinas', 'modulos', 'placa', 'trackers', 'trackers_total', 'trackers_nota', 'placa_total', 'modulos_por_string', 'capacidade_ca_mw'];
  const raiz = { gerado_em: agora, origem_inversor: L.ORIGEM, esquema: L.ESQUEMA };
  for (const k of CADASTRO) if (scada && scada[k] != null) raiz[k] = scada[k];
  if (!raiz.usinas) raiz.usinas = USINAS;
  const cob = L.cobertura(serie);
  const dCob = new Set(serie.map((o) => o.dia)).size;
  const diario = { ...raiz, metodo: L.METODO_DIARIO,
    fontes: { inversor: 'logger do fabricante (sg_disp_inv_dia, sg_saude, sg_saude_<usina>)', medidor: 'medidor de faturamento (cmp_diario, way2_daily)',
      supervisorio: 'so os campos ' + L.CAMPOS_SCADA_U.map((c) => '<usina>' + c).concat(L.CAMPOS_SCADA_DIA, Object.values(L.RENOMEIA_SCADA_U).map((c) => '<usina>' + c), ['janela_scada_h']).join(', ')
        + ': copiados do supervisorio para o Comparativo de Medicoes (export parado em 14/10/2026)' },
    campos: {
      '<usina>_n_inv': 'posicoes com leitura nas meias horas de sol do dia', '<usina>_n_placa': 'inversores de placa', '<usina>_cob_pct': 'n_inv / placa, %',
      '<usina>_inv_parados': 'posicoes disponiveis em menos de 50 % das meias horas de sol', '<usina>_inv_parciais': 'entre 50 e 90 %',
      '<usina>_inv_sem_leitura': 'posicoes sem leitura com sol (nao contam como paradas)', janela_h: 'mediana das usinas das horas de sol do dia',
      '<usina>_e_cc / _e_ca': 'MWh, soma dos n_cc inversores com o dia inteiro', '<usina>_perda_conv_pct': '(CC - CA) / CC dos mesmos n_cc, %',
      '<usina>_e_conta': 'MWh, soma da subida do contador de energia dos n_conta inversores com o dia inteiro',
      '<usina>_razao_med_conta': 'medidor / e_conta, so com o contador do parque inteiro da usina',
      'Complexo_*': 'so com as nove usinas inteiras no logger (e_cc, e_ca, e_conta) e no medidor (e_med, consumo)',
      '<usina>_disp_pct, CX_disp_pct, _disp_contrato_*': 'SUPERVISORIO (Comparativo): ver fontes.supervisorio; a disponibilidade do logger esta em sg_disp_dia',
    },
    cobertura_por_usina: cob, janela_dias: 730, dias_cobertos: dCob, serie };
  const pInv = { ...raiz, metodo: L.METODO_DIARIO, janela_dias: JANELA_INV, dias_cobertos: new Set(inv.map((l) => l.dia)).size,
    unidade: 'e_cc e e_ca MWh; ef CA/CC (0..1); p_ca_max kW; temp_max C; isol_min kOhm; str_* e mppt_min_pct em % da mediana das irmas no pico; '
      + 'disp_pct % das meias horas de sol disponivel; parcial 1 = o registrador nao viu o dia inteiro (grandezas fisicas nulas)', serie: inv };

  const pesos = {};
  for (const [novo] of SEMENTES) if (copias[novo].semeada) pesos[novo + ' (semente)'] = await escreve(novo, copias[novo].j);
  pesos['perdas_diario.json'] = await escreve('perdas_diario.json', diario);
  pesos['perdas_inv.json'] = await escreve('perdas_inv.json', pInv);
  pesos['strings_alarme.json'] = await escreve('strings_alarme.json', alarm);
  pesos['inv_scada.json'] = await escreve('inv_scada.json', rank);
  const ult = serie[serie.length - 1];
  console.log('  perdas_diario: ' + serie.length + ' dias (' + serie[0].dia + ' a ' + ult.dia + ') · ultimo: '
    + USINAS.map((u) => u + ' ' + ult[u + '_n_inv'] + '/' + PLACA[u].inversores + (ult[u + '_inv_parados'] ? ' (' + ult[u + '_inv_parados'] + ' parados)' : '')).join(' '));
  console.log('  perdas_inv: ' + inv.length + ' inversor-dias · strings_alarme: ' + alarm.serie.length + ' (ate ' + alarm.ate + ') · inv_scada: '
    + rank.inversores.length + ' inversores de ' + rank.escopo.de + ' a ' + rank.escopo.ate + ', pior ' + (rank.ranking[0] ? rank.ranking[0].chave + ' ' + rank.ranking[0].razao_mediana : '-'));
  for (const [k, v] of Object.entries(pesos)) console.log('  ' + k.padEnd(34) + (v / 1024).toFixed(0).padStart(6) + ' KB');
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
