'use strict';
/*
 * ensaio-malha-estado.js — prova as regras do contrato `malha_estado.json` (versao 1) no gerador gen-malha-estado.js
 * (lote malha-estado, 19/10/2026). Sem rede e sem segredo: o SDK do Azure e trocado por um falso (preload em Module._load),
 * o GitHub e o conteiner publico por um servidor local, o relogio por MALHA_AGORA, a agenda por uma de ensaio.
 *
 * Tres camadas:
 *   1. as regras soltas (prazo da agenda, frescor, escolha do arquivo do dia, execucoes, guarda), importadas do gerador;
 *   2. o GERADOR DE VERDADE num processo a parte, em doze mundos fabricados: o principal (estados v0 e v1, dia sem arquivo,
 *      teste e diario no mesmo dia, falha, ressalva, tentativas > 1; frescor ok/atrasado/ausente; execucoes vermelhas), a
 *      gravacao no blob, a pasta local, nenhuma fonte, o cofre que sumiu, a agenda sem um workflow, o publico que sumiu, e
 *      os cinco do `proc` (malha-v2: vermelho com arquivo atrasado, com arquivo ausente, com arquivo no prazo, sem arquivo
 *      no frescor, tudo verde);
 *   3. os PLANTIOS: copias do gerador quebradas de proposito, que TEM de reprovar (estado sem registro virando ok, teste
 *      vencendo o diario, log/conteiner/blob na saida, frescor sem prazo, 404 de conteiner tratado como ausencia; no `proc`,
 *      vermelho com arquivo atrasado virando at e vermelho com arquivo no prazo virando fa). Os de texto e de prazo rodam
 *      duas vezes: com a guarda do gerador (ela barra) e sem ela (a checagem deste ensaio barra).
 *
 * Esperados contados FORA do gerador: letras, numeros e datas escritos a mao a partir dos fixtures abaixo.
 *
 * malha-frescor-conteudo (19/10/2026): cada arquivo do frescor tem GRAVACAO e CONTEUDO. Regras soltas: o instante sem fuso e de
 * Brasilia, o fim do dia, o prazo do conteudo contado a mao na agenda de ensaio AG_FIX (RE-002; trafo 2018, logger 2177, PR 2293,
 * operador 2477, dia do medidor 1590, 5 min 30, registro 30 d), conteudo ilegivel = null. Mundos: verde; CONGELADO (trafo, sager e perdas regravados ha
 * 5 min com o dado parado no dia 14: pela gravacao sairiam ok, o que a premissa prova; pelo conteudo saem fa, e o proc com o trafo
 * vermelho sai fa); conteudo ilegivel (sem registro, nunca a gravacao); a saida anterior do MESMO dia (so o regravado e baixado, e
 * o `ate` que so a saida anterior tem aparece) e de OUTRO dia (tudo baixado); 403 na saida anterior estoura. Plantios: a regra
 * antiga (so a gravacao), ilegivel vira gravacao, a pior medida nao vence, saida anterior com outra gravacao ou de outro dia
 * reaproveitada, 403 como ausencia, o arquivo de 5 min da medicao baixado.
 *
 * malha-vigia-mais (20/10/2026, decisao do humano): oito fontes novas (perdas de 30 e 60 min, historico das entradas de string e
 * inversores hora a hora, do supervisorio; transformadores de 5, 15, 30 e 60 min, do medidor), 39 no total, 37 da publicacao. A lista
 * e conferida contra a declarada AQUI (id, workflow, conteudo). Regras soltas: o fim do dado e o prazo de cada uma contados a mao no
 * AG_FIX (medidor do trafo 1578, supervisorio 2232 e 2147). Mundos: SUPERVISORIO PARADO com o medidor em dia (os quatro do
 * supervisorio fa pelo conteudo, regravados ha 5 min; os do trafo ok com o supervisorio dele parado e a serie seguindo) e MEDIDOR
 * PARADO com linhas do supervisorio no fim da serie (trafo fa). Plantios: fonte nova fora da lista, os do supervisorio pela gravacao,
 * o trafo pelo supervisorio, o trafo pelo fim da serie, a hora de 60 min com 30. Revisao (RE-001..006 do malha-vigia-mais): os quatro
 * trafos pelo C5 numa execucao fora da agenda (1288; o dia fechado daria 2728), sem medidor_ate = null mesmo com o supervisorio e a serie
 * em dia (e um mundo disso, `sem`), o maior ultimo_ok no meio da serie, a ponte numa agenda derivada (3240; sem ela 1800), a lista
 * conferida no proprio mutante pelo require, e o chkC exigindo o mesmo conjunto de ids.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const http = require('http');
const assert = require('assert');
const { execFile } = require('child_process');

const GEN = path.join(__dirname, 'gen-malha-estado.js');
const LIB = path.join(__dirname, 'lib-le-dados.js');
const AGENDA_REAL = path.join(__dirname, '..', 'relogio', 'agenda.json');
const G = require(GEN);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-malha-'));

let falhas = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok    ' : '  FALHA ') + msg); if (!cond) falhas++; };
const igual = (a, b) => { try { assert.deepStrictEqual(a, b); return true; } catch (e) { return false; } };

/* ───────────── fixtures ───────────── */
const AGORA = '2026-10-19T15:30:00Z';                     // 12:30 em Brasilia
const AGORA_MS = Date.parse(AGORA);
const HOJE = '2026-10-19';
const AG_FIX = {
  'estacao-logger.yml': ['0 23 8 * * *', '0 33 15 * * *'], 'executivo.yml': ['0 13 4,9-22 * * *'], 'inv-scada.yml': ['0 47 12 * * *'],
  'inversores.yml': ['0 22 12,18 * * *'], 'must-intra.yml': ['0 */15 * * * *'], 'ons-consolidado.yml': ['0 17 18 * * *'],
  'perdas.yml': ['0 12 14 * * *'], 'ppc.yml': ['0 23 * * * *'], 'sager-disp.yml': ['0 47 7,13 * * *'],
  'scada.yml': ['0 30 11 * * *', '0 0 17,21 * * *'], 'sungrow.yml': ['0 17 13 * * *'], 'trafo.yml': ['0 38 10 * * *'],
  'way2-agg.yml': ['0 5 * * * *'], 'way2-hist.yml': ['0 30 3 * * *'], 'way2-recent.yml': ['0 */5 * * * *'],
};
const precisa = [...new Set(G.FONTES.flatMap((f) => f.wf))];
const faltaFix = precisa.filter((w) => !AG_FIX[w]);
if (faltaFix.length) { console.error('FALHA: a agenda de ensaio nao tem ' + faltaFix.join(', ') + ' (o gerador passou a precisar; atualizar AG_FIX)'); process.exit(1); }
const W = Object.keys(AG_FIX).length;
const agendaFix = path.join(TMP, 'agenda.json');
fs.writeFileSync(agendaFix, JSON.stringify(AG_FIX));
const semTrafo = Object.assign({}, AG_FIX); delete semTrafo['trafo.yml'];
const agendaSemTrafo = path.join(TMP, 'agenda_sem_trafo.json');
fs.writeFileSync(agendaSemTrafo, JSON.stringify(semTrafo));

/* o que nunca pode chegar a saida: o log e o obs da ponte trazem estas marcas */
const MARCA_LOG = 'MARCA-LOG-ENSAIO vpn 10.11.12.13 /var/log/ponte backup-dados-scada';
const MARCA_OBS = 'MARCA-OBS-ENSAIO cofre backup-dados-scada 10.11.12.13';
const PROIBIDO_TEXTO = ['MARCA-LOG', 'MARCA-OBS', '10.11.12.13', 'backup-dados-scada', 'portal-admin', '.json', '/var/', '"obs"', '"log"'];

const t = (dia, hm) => dia + 'T' + hm + '-03:00';
function fonte(dia, hm, resultado, x) {
  return Object.assign({ inicio: t(dia, '06:26:01'), fim: t(dia, hm), resultado, arquivos_vm: null, azure_novos: null, azure_mb: null, onedrive: null, obs: MARCA_OBS }, x);
}
function v1(dia, modo, resultado, tentativas, r, num) {
  num = num || {};
  return {
    dia, modo, resultado, codigo: resultado === 'ok' ? 0 : 1, tentativas,
    ciclo: { inicio: t(dia, '06:26:01'), fim: t(dia, '07:16:40') }, onedrive: r.od === 'ok' ? 'ok' : 'falhou', espelho: 'ok',
    fontes: { versao: 1,
      inversores: fonte(dia, '07:05:00', r.inv, { arquivos_vm: num.inv != null ? num.inv : 378, azure_novos: 378, azure_mb: 120.5, onedrive: 378 }),
      estacoes: fonte(dia, '07:06:00', r.est, r.est === 'ressalva' ? { arquivos_vm: 0, azure_novos: 0, azure_mb: 0, onedrive: 0 } : { arquivos_vm: 9, azure_novos: 9, azure_mb: 1.2, onedrive: 9 }),
      scada_db: fonte(dia, '07:10:00', r.scada, { arquivos_vm: 184, azure_novos: 180, azure_mb: 310.24, onedrive: 180 }),
      espelho_way2: fonte(dia, '07:16:00', 'ok', { azure_novos: 2, azure_mb: 0.4 }),
      espelho_ons: fonte(dia, '07:16:10', 'ok', { azure_novos: 1, azure_mb: 0.1 }),
      onedrive: fonte(dia, '07:15:00', r.od, { onedrive: 562 }),
      cofre: fonte(dia, '07:14:00', r.cofre, { azure_novos: 558, azure_mb: 430.74 }),
    },
    log: MARCA_LOG,
  };
}
function v0(dia, resultado, tentativas, comFontes) {
  const j = { dia, resultado, codigo: resultado === 'ok' ? 0 : 1, tentativas, ciclo: { inicio: t(dia, '06:00:00'), fim: t(dia, '06:40:00') }, onedrive: 'ok', log: MARCA_LOG };
  /* arquivo sem `modo` e de versao 0: um bloco `fontes` que aparecer nele NAO vale */
  if (comFontes) j.fontes = v1(dia, 'diario', 'ok', 1, { inv: 'ok', est: 'ok', scada: 'ok', cofre: 'ok', od: 'ok' }).fontes;
  return j;
}
const TUDO_OK = { inv: 'ok', est: 'ok', scada: 'ok', cofre: 'ok', od: 'ok' };
const TUDO_FALHA = { inv: 'falha', est: 'falha', scada: 'falha', cofre: 'falha', od: 'falha' };
const ESTADOS = [
  /* nome (sem o prefixo), conteudo, gravado em (UTC), gzip */
  ['2026-10-01_070000.json', { dia: '2026-10-01', modo: 'desconhecido', resultado: 'ok' }, '2026-10-01T10:00:00Z'],   // fora dos 15 dias: nunca lido
  ['2026-10-05_070000.json', v1('2026-10-05', 'diario', 'ok', 1, TUDO_OK), '2026-10-05T10:20:00Z'],                   // 15o dia: lista, fora do h
  ['2026-10-13_150000.json', v1('2026-10-13', 'teste', 'ok', 1, TUDO_OK), '2026-10-13T18:00:00Z'],                    // so teste: dia sem diario
  ['2026-10-14_070000.json', v1('2026-10-14', 'diario', 'ok', 1, TUDO_OK), '2026-10-14T10:20:00Z'],
  ['2026-10-14_160000.json', v1('2026-10-14', 'teste', 'falhou', 1, TUDO_FALHA), '2026-10-14T19:00:00Z'],             // teste mais novo que o diario
  ['2026-10-15_070000.json', v0('2026-10-15', 'falhou', 4, true), '2026-10-15T10:00:00Z'],                            // v0 com `fontes` que nao vale
  /* 16/10: nenhum arquivo */
  ['2026-10-17.json', v0('2026-10-17', 'ok', 1, false), '2026-10-17T09:45:00Z', true],                                // nome antigo, gzip
  ['2026-10-18_065900.json', v1('2026-10-18', 'diario', 'falhou', 3, TUDO_FALHA), '2026-10-18T15:01:00Z'],
  ['2026-10-19_065900.json', v1(HOJE, 'diario', 'ok', 2, { inv: 'ok', est: 'ressalva', scada: 'falha', cofre: 'ok', od: 'ok' }), '2026-10-19T10:16:45Z'],
  ['2026-10-19_120000.json', v1(HOJE, 'teste', 'ok', 1, TUDO_OK, { inv: 999 }), '2026-10-19T15:00:00Z'],              // teste de hoje, mais novo
];
const bufEstado = (e) => { const b = Buffer.from(JSON.stringify(e[1]), 'utf8'); return e[3] ? zlib.gzipSync(b) : b; };
const blobsCofre = {};
for (const e of ESTADOS) blobsCofre['Ponte/estado/' + e[0]] = { b64: bufEstado(e).toString('base64'), mod: Date.parse(e[2]) };

/* frescor: idades contra AGORA. Desde o malha-frescor-conteudo cada arquivo tem GRAVACAO (mod) e CONTEUDO (corpo, com o campo de
 * data que o gerador le). Os esperados abaixo foram contados a mao na agenda de ensaio AG_FIX:
 *   prazo do conteudo = (R1 - E) + min(R2 - R1, 120), E = fim do dado, R1 = 1a execucao do workflow a partir de quando o periodo
 *   SEGUINTE fica disponivel (E + passo + regra de chegada), R2 = a execucao depois dela. Vale a medida com a maior fracao do prazo. */
const MOD5 = Date.parse('2026-10-19T15:25:00Z');                                       // 5 min: gravacao ok em qualquer prazo
const D1 = '2026-10-18';                                                               // o dia fechado: fim = 2026-10-19T03:00Z, 750 min antes de AGORA
const FIM_D1 = '2026-10-19T03:00:00Z';
const W5 = '2026-10-19T12:15:00';                                                      // a ultima medicao de 5 min: 15:15 UTC, 15 min antes
const W5Z = '2026-10-19T15:15:00Z';
const okC = (idade, prazo, ate) => ({ st: 'ok', idade_min: idade, prazo_min: prazo, medida: 'conteudo', ate });
const okG = (idade, prazo) => ({ st: 'ok', idade_min: idade, prazo_min: prazo, medida: 'gravacao', ate: null });
/* id -> [corpo, gzip, esperado]. Prazos (AG_FIX):
 *   5 min: E 15:15 -> 15:20 + 16 -> R1 15:40, R2 15:45: 25 + 5 = 30
 *   ponte diario: E 19/10 03:00 -> 20/10 03:00 + 355 = 08:55 -> R1 = trafo 10:38 (1898 + 120 = 2018), sungrow 13:17 (2057 + 120),
 *     perdas 14:12 (2112 + 120), inv-scada 12:47 (2027 + 120), scada 11:30 (1950; R2 17:00 -> + 120), estacao 15:33 (2193; + 120)
 *   PR: ponte -> estacao 15:33 -> executivo 16:13 (2233; R2 17:13 -> + 60 = 2293)
 *   operador nacional: 20/10 03:00 -> ons 18:17 (2357 + 120 = 2477); via executivo: 19:13 (2413 + 60 = 2473)
 *   dia do medidor: way2-hist 03:30 (1470 + 120 = 1590); o assistente do dia: way2-hist 03:30 -> o proprio 03:30, R2 08:23 -> + 120
 *   perfil: E 14:30 -> 15:00 + 16 = 15:16 -> executivo 16:13 (103; + 60 = 163)
 *   operador (sager): 20/10 03:00 -> 07:47 (1727; R2 13:47 -> + 120 = 1847) · registro de trocas: fixo 30 d = 43200 */
const FIX = {
  medidor_5min: [{ inicio: '2026-10-18', fim: '2026-10-19', dados: [] }, false, { st: 'ok', idade_min: 4, prazo_min: 10, medida: 'gravacao', ate: null }],
  /* o conteudo (dia 17, 2190/2477 = 0,88) perde para a gravacao (1800/1560 = 1,15): vale a gravacao */
  ons_restricao: [{ consolidado: [{ ts: '2026-10-17 23:00:00' }, { ts: '2026-10-17 23:30:00' }] }, false, { st: 'at', idade_min: 1800, prazo_min: 1560, medida: 'gravacao', ate: '2026-10-18T03:00:00Z' }],
  visao_executiva: [{ serie_diaria: [{ dia: '2026-10-17' }, { dia: D1 }] }, true, { st: 'sem', idade_min: null, prazo_min: 660, medida: 'conteudo', ate: null }],   // arquivo ausente
  /* conteudo 15/30 = 0,5; gravacao 25/10 = 2,5: vale a gravacao */
  ao_vivo: [{ dia: '2026-10-19', hora: '12:15' }, true, { st: 'fa', idade_min: 25, prazo_min: 10, medida: 'gravacao', ate: W5Z }],
  /* empate 0,5 x 0,5: vale o conteudo */
  ao_vivo_eletrico: [{ dia: '2026-10-19', hora: '12:15' }, true, okC(15, 30, W5Z)],
  selo_medidores: [{ ancora: W5 }, false, okC(15, 30, W5Z)],
  assistente_om: [{ tempo_real: { medidores: { ancora: W5 } } }, false, okC(15, 30, W5Z)],
  assistente_dia: [{ ultimo_dia_fechado: D1 }, false, okC(750, 1590, FIM_D1)],
  selos_fontes: [{ badges_way2: [] }, false, okG(5, 120)],
  benchmark_ne: [{ serie_dia: [{ dia: D1 }, { dia: '2026-10-01' }] }, false, okC(750, 2473, FIM_D1)],
  referencia_hora: [{ dias: [{ dia: D1 }] }, true, okC(750, 2473, FIM_D1)],
  /* a meia hora sem medicao (ent_mw nulo) nao conta: o fim e 12:00 de Brasilia, 15:00 UTC */
  /* RE-004: a ultima linha COM valor e a meia hora h = 11.5 (11:30 de Brasilia = 14:30 UTC, 60 min antes); a de 12 sem valor nao conta.
   * Prazo: 14:30 + 30 + 16 = 15:16 -> executivo 16:13 (103) + 60 = 163 */
  perfil_recente: [{ perfil: [{ dia: '2026-10-19', h: 11, ent_mw: 1 }, { dia: '2026-10-19', h: 11.5, ent_mw: 2 }, { dia: '2026-10-19', h: 12, ent_mw: null }] }, true,
    okC(60, 163, '2026-10-19T14:30:00Z')],
  pr: [{ ultimo_dia: D1 }, true, okC(750, 2293, FIM_D1)],
  pr_usina: [{ ultimo_dia: D1 }, true, okC(750, 2293, FIM_D1)],
  pr_hora: [{ ultimo_dia: D1 }, true, okC(750, 2293, FIM_D1)],
  corte_gemeo: [{ serie: [{ mes: '2026-10' }] }, false, okG(5, 1560)],
  ons_indicadores: [{ ultimo_dado: '2026-10-18 23:30:00' }, false, okC(750, 2477, FIM_D1)],
  estacao_30min: [{ serie: [{ t: '2026-10-18T23:00:00-03:00' }, { t: '2026-10-18T23:30:00-03:00' }] }, true, okC(750, 2313, FIM_D1)],
  estacao_dia: [{ serie: [{ d: D1 }] }, true, okC(750, 2313, FIM_D1)],
  perdas_inversor: [{ serie: [{ dia: D1 }] }, true, okC(750, 2232, FIM_D1)],
  perdas_dia: [{ serie: [{ dia: D1 }] }, true, okC(750, 2232, FIM_D1)],
  inversores_scada: [{ escopo: { ate: D1 } }, true, okC(750, 2147, FIM_D1)],
  /* planilha salva em 15/10 12:00 UTC: 5970 min de 43200 */
  inversores_registro: [{ fontes: { substituicoes_planilha_em: '2026-10-15T12:00:00.000Z' } }, false, okC(5970, 43200, '2026-10-15T12:00:00Z')],
  ativos: [{ fontes: { substituicoes_planilha_em: '2026-10-15T12:00:00.000Z' } }, true, okC(5970, 43200, '2026-10-15T12:00:00Z')],
  registro_mesa: [{ dias: [{ dia: '2026-10-19' }] }, true, okG(5, 120)],
  sager_disp: [{ serie: [{ t: '2026-10-18T23:30' }] }, true, okC(750, 1847, FIM_D1)],
  logger_saude: [{ usina_dia: [{ d: D1 }] }, true, okC(750, 2177, FIM_D1)],
  logger_disp: [{ serie: [{ dia: D1 }] }, true, okC(750, 2177, FIM_D1)],
  supervisorio: [{ ultimo_dia: D1 }, true, okC(750, 2070, FIM_D1)],
  trafo_dia: [{ serie: [{ dia: '2026-10-17' }, { dia: D1 }] }, true, okC(750, 2018, FIM_D1)],
  medidor_dia: [{ dias: [{ dia: D1 }] }, false, okC(750, 1590, FIM_D1)],
  /* malha-vigia-mais. Supervisorio, dia D pela ponte (como perdas_dia e inversores_scada): a meia hora 23:30 + 30 e a hora 23:00 + 60
   * fecham o dia 18; o historico das entradas vale pelo MAIOR ultimo_ok; os inversores hora a hora pelo escopo.ate */
  perdas_30: [{ serie: [{ ms: Date.parse('2026-10-19T02:00:00Z'), t: '2026-10-18 23:00' }, { ms: Date.parse('2026-10-19T02:30:00Z'), t: '2026-10-18 23:30' }] }, true, okC(750, 2232, FIM_D1)],
  perdas_60: [{ serie: [{ ms: Date.parse('2026-10-19T01:00:00Z'), t: '2026-10-18 22:00' }, { ms: Date.parse('2026-10-19T02:00:00Z'), t: '2026-10-18 23:00' }] }, true, okC(750, 2232, FIM_D1)],
  strings_entradas: [{ serie: [{ ufv: 'M1', ok: ['2026-07-23'], ultimo_ok: '2026-09-30' }, { ufv: 'M2', ok: ['2026-07-24'], ultimo_ok: D1 }, { ufv: 'M3', ok: ['2026-07-24'], ultimo_ok: '2026-08-02' }, { ufv: 'M4', ok: [], ultimo_ok: null }] }, true, okC(750, 2232, FIM_D1)],
  inversores_scada_hora: [{ escopo: { de: '2026-09-15', ate: D1 }, serie_hora: [{ dia: D1 }] }, true, okC(750, 2147, FIM_D1)],
  /* medidor, 5 min, pela execucao diaria do trafo (10:38 UTC): o ultimo intervalo lido comeca 07:15 de Brasilia, fim 10:20 UTC (310 min
   * antes de AGORA); o seguinte termina 10:25 + 16 = 10:41, depois da execucao do dia: R1 20/10 10:38 (24h18 = 1458) + 120 = 1578.
   * O supervisorio do trafo (temperaturas) parou no dia 14 e NAO conta */
  trafo_5: [{ medidor_ate: '2026-10-19 07:15', supervisorio_ate: '2026-10-14 23:30', serie: [{ ms: Date.parse('2026-10-19T10:15:00Z'), t: '2026-10-19 07:15' }] }, true, okC(310, 1578, '2026-10-19T10:20:00Z')],
  /* RE-001: o trafo_15 e o trafo_60 com o medidor lido fora da agenda (execucao manual, como em 20/10 15:24): fim 12:10 de Brasilia =
   * 15:10 UTC, 20 min antes; o seguinte (15:15 + 16 = 15:31) cai na execucao de 20/10 10:38: 19h28 + 2 h = 1288 (o dia fechado daria 2728) */
  trafo_15: [{ medidor_ate: '2026-10-19 12:05', supervisorio_ate: null, serie: [{ ms: Date.parse('2026-10-19T15:05:00Z'), t: '2026-10-19 12:05' }] }, true, okC(20, 1288, '2026-10-19T15:10:00Z')],
  trafo_30: [{ medidor_ate: '2026-10-19 07:15', supervisorio_ate: '2026-10-14 23:30', serie: [{ ms: Date.parse('2026-10-19T10:00:00Z'), t: '2026-10-19 07:00' }] }, false, okC(310, 1578, '2026-10-19T10:20:00Z')],
  trafo_60: [{ medidor_ate: '2026-10-19 12:05', supervisorio_ate: '2026-10-14 23:00', serie: [{ ms: Date.parse('2026-10-19T15:00:00Z'), t: '2026-10-19 12:00' }] }, true, okC(20, 1288, '2026-10-19T15:10:00Z')],
};
/* malha-vigia-mais: a lista declarada AQUI, fora do gerador (id -> workflow que grava). Fonte que some do gerador, ou muda de workflow,
 * reprova; o total tambem e escrito a mao */
const VIGIA_MAIS = { perdas_30: 'perdas.yml', perdas_60: 'perdas.yml', strings_entradas: 'perdas.yml', inversores_scada_hora: 'inv-scada.yml',
  trafo_5: 'trafo.yml', trafo_15: 'trafo.yml', trafo_30: 'trafo.yml', trafo_60: 'trafo.yml' };
const N_FONTES = 39, N_PUB = 37;
/* RE-005: a conferencia da lista, aplicada ao gerador de verdade e a um mutante (a fonte que falta, ou que mudou, pelo id) */
const faltaVigia = (Gx) => Object.entries(VIGIA_MAIS).filter(([id, w]) => { const f = Gx.FONTES.find((x) => x.id === id); return !f || f.etapa !== 'pub' || !f.conteudo || f.wf.join() !== w; }).map(([id]) => id);
const faltaFixC = G.FONTES.filter((f) => !FIX[f.id]).map((f) => f.id);
if (faltaFixC.length) { console.error('FALHA: o ensaio nao tem fixture de conteudo para ' + faltaFixC.join(', ')); process.exit(1); }
const BLOB = Object.fromEntries(G.FONTES.map((f) => [f.id, f.blob]));
const corpoB64 = (corpo, gz) => { const b = Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo), 'utf8'); return (gz ? zlib.gzipSync(b) : b).toString('base64'); };
/* os arquivos de um mundo: { blob: { mod, b64 } }; `over` por id: { mod, corpo, gz, ausente } */
function dadosDe(over, base) {
  const out = {};
  for (const f of G.FONTES) {
    const o = Object.assign({}, (base || {})[f.id], (over || {})[f.id]);
    if (o.ausente) continue;
    const [corpo, gz] = FIX[f.id];
    out[f.blob] = { mod: o.mod != null ? o.mod : MOD5, b64: corpoB64(o.corpo !== undefined ? o.corpo : corpo, o.gz !== undefined ? o.gz : gz) };
  }
  return out;
}
/* o mundo principal: way2 a 4 min, o ONS gravado ha 30 h, o executivo ausente, o Ao vivo gravado ha 25 min */
const OVER_PRINCIPAL = {
  medidor_5min: { mod: Date.parse('2026-10-19T15:26:00Z') }, ons_restricao: { mod: Date.parse('2026-10-18T09:30:00Z') },
  visao_executiva: { ausente: true }, ao_vivo: { mod: Date.parse('2026-10-19T15:05:00Z') },
};
const blobsDados = dadosDe(OVER_PRINCIPAL);
const PUB = Object.fromEntries(Object.entries(blobsDados).map(([n, x]) => [n, x.mod]));
const CORPOS = Object.fromEntries(Object.entries(blobsDados).map(([n, x]) => [n, x.b64]));
const FRESCOR_ESPERADO = Object.fromEntries(G.FONTES.map((f) => [f.id, Object.assign({}, FIX[f.id][2],
  { gravado: blobsDados[f.blob] ? new Date(blobsDados[f.blob].mod).toISOString().replace(/\.\d{3}Z$/, 'Z') : null })]));
const N_CONTEUDO = G.FONTES.filter((f) => f.conteudo && blobsDados[f.blob]).length;   // o que o gerador tem de BAIXAR no principal

/* execucoes: 2 verdes por workflow; o executivo com 1 vermelha das 2 */
/* malha-sem-mesa: cada execucao tem id e os passos do job; vermelha sem passos declarados falha no passo 'Gerar' */
const RUNS = {}; let idRun = 1000;
const run = (c, u, passos) => { const r = { id: ++idRun, conclusion: c, status: 'completed', updated_at: u }; RUNS[r.id] = { c, passos }; return r; };
const GH_PADRAO = [run('success', '2026-10-19T15:20:00Z'), run('success', '2026-10-19T14:20:00Z')];
const GH_PRINCIPAL = { 'executivo.yml': [run('failure', '2026-10-19T15:10:00Z'), run('success', '2026-10-19T14:10:00Z')] };

/* ───────────── o SDK falso (preload) e o servidor local ───────────── */
const PRELOAD = path.join(TMP, 'preload.js');
fs.writeFileSync(PRELOAD, `'use strict';
const Module = require('module'); const fs = require('fs'); const { Readable } = require('stream');
const MUNDO = JSON.parse(fs.readFileSync(process.env.MALHA_FAKE, 'utf8'));
const anota = (x) => fs.appendFileSync(process.env.MALHA_FAKE_REG, JSON.stringify(x) + '\\n');
const erro = (st, code) => { const e = new Error(code); e.statusCode = st; e.code = code; e.details = { errorCode: code }; return e; };
function conteiner(nome) {
  const C = MUNDO.conteineres[nome];
  const proibido = (op) => { anota({ violacao: op, conteiner: nome }); throw erro(403, 'AuthorizationPermissionMismatch'); };
  const o = {
    async *listBlobsFlat(op) {
      const prefixo = (op && op.prefix) || '';
      anota({ op: 'lista', conteiner: nome, prefixo });
      if (!C) throw erro(404, 'ContainerNotFound');
      if (C.proibido) proibido('lista');
      for (const n of Object.keys(C.blobs).sort()) if (n.startsWith(prefixo)) yield { name: n, properties: { lastModified: new Date(C.blobs[n].mod) } };
    },
    getBlobClient(n) { return {
      async download() {
        anota({ op: 'baixa', conteiner: nome, blob: n });
        if (!C) throw erro(404, 'ContainerNotFound'); if (C.proibido) proibido('baixa');
        const b = C.blobs[n]; if (!b) throw erro(404, 'BlobNotFound');
        if (C.falhaBaixa) throw erro(C.falhaBaixa, C.falhaBaixa === 403 ? 'AuthorizationPermissionMismatch' : 'InternalError');   /* RE-001: o cabecalho responde, a leitura nao */
        return { readableStreamBody: Readable.from([Buffer.from(b.b64 || '', 'base64')]), etag: '"e"', lastModified: new Date(b.mod) };
      },
      async getProperties() {
        if (!C) throw erro(404, 'ContainerNotFound'); if (C.proibido) proibido('cabecalho');
        const b = C.blobs[n]; if (!b) throw erro(404, 'BlobNotFound');
        return { lastModified: new Date(b.mod), contentLength: 10, etag: '"e"' };
      },
    }; },
    getBlockBlobClient(n) { return { async upload(buf, len, opcoes) {
      if (nome !== 'portal-admin') proibido('grava ' + n);
      if (!C) throw erro(404, 'ContainerNotFound');
      anota({ op: 'grava', conteiner: nome, blob: n, opcoes, b64: Buffer.from(buf).toString('base64') });
      return {};
    } }; },
  };
  for (const op of ['create', 'createIfNotExists', 'delete', 'deleteIfExists', 'deleteBlob', 'setMetadata', 'setAccessPolicy', 'uploadBlockBlob']) o[op] = async () => proibido(op);
  return o;
}
const falso = { BlobServiceClient: { fromConnectionString: () => ({ getContainerClient: conteiner }) } };
const orig = Module._load;
Module._load = function (req) { if (req === '@azure/storage-blob') return falso; return orig.apply(this, arguments); };
`);

let MUNDO_HTTP = { gh: {}, pub: {}, corpos: {}, pubSumiu: false };
let PORTA = 0;
const servidor = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://local');
  let m = /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/runs$/.exec(u.pathname);
  if (m) {
    if (q.headers.authorization !== 'Bearer tk-ensaio') { r.writeHead(401); return r.end('{}'); }
    if (u.searchParams.get('status') !== 'completed' || u.searchParams.get('per_page') !== '2') { r.writeHead(400); return r.end('{}'); }
    const runs = MUNDO_HTTP.gh[decodeURIComponent(m[1])] || GH_PADRAO;
    r.writeHead(200, { 'content-type': 'application/json' });
    return r.end(JSON.stringify({ total_count: runs.length, workflow_runs: runs }));
  }
  m = /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs$/.exec(u.pathname);
  if (m) {
    if (q.headers.authorization !== 'Bearer tk-ensaio') { r.writeHead(401); return r.end('{}'); }
    const R = RUNS[m[1]]; if (!R) { r.writeHead(404); return r.end('{}'); }
    const passos = R.passos || (R.c === 'success' ? [{ name: 'Gerar', conclusion: 'success' }] : [{ name: 'Gerar', conclusion: R.c }]);
    r.writeHead(200, { 'content-type': 'application/json' });
    return r.end(JSON.stringify({ total_count: 1, jobs: [{ conclusion: R.c, steps: passos }] }));
  }
  m = /^\/dados\/(.+)$/.exec(u.pathname);
  if (m) {
    if (MUNDO_HTTP.pubSumiu) { r.writeHead(404, { 'x-ms-error-code': 'ContainerNotFound' }); return r.end(); }
    const tm = MUNDO_HTTP.pub[decodeURIComponent(m[1])];
    if (tm == null) { r.writeHead(404, { 'x-ms-error-code': 'BlobNotFound' }); return r.end(); }
    const c = MUNDO_HTTP.corpos[decodeURIComponent(m[1])], corpo = c != null ? Buffer.from(c, 'base64') : Buffer.from('{}');
    r.writeHead(200, { 'last-modified': new Date(tm).toUTCString(), 'content-length': String(corpo.length) });
    return r.end(q.method === 'HEAD' ? undefined : corpo);
  }
  r.writeHead(404); r.end();
});

let nRodada = 0;
const LIMPA = ['DADOS_STORAGE', 'DADOS_SAS', 'DADOS_BASE_PUB', 'GITHUB_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_API_URL', 'LOCAL_OUT', 'LOCAL_PONTE_DIR', 'AGENDA_JSON', 'MALHA_AGORA', 'NODE_OPTIONS'];
/* cen: { script, agenda, sdk (mundo do SDK falso; liga DADOS_STORAGE), ponteDir, gh (mapa; liga o token), http, blob (grava no blob, sem LOCAL_OUT) } */
function roda(cen) {
  const id = ++nRodada;
  const outF = path.join(TMP, 'saida' + id + '.json'), reg = path.join(TMP, 'reg' + id + '.jsonl'), mundo = path.join(TMP, 'mundo' + id + '.json');
  fs.writeFileSync(reg, '');
  fs.writeFileSync(mundo, JSON.stringify(cen.sdk || { conteineres: {} }));
  const env = Object.assign({}, process.env);
  for (const k of LIMPA) delete env[k];
  Object.assign(env, { MALHA_AGORA: cen.agora || AGORA, AGENDA_JSON: cen.agenda || agendaFix, MALHA_FAKE: mundo, MALHA_FAKE_REG: reg });
  if (cen.sdk) env.DADOS_STORAGE = 'conexao-de-ensaio';
  else env.DADOS_BASE_PUB = 'http://127.0.0.1:' + PORTA + '/dados/';
  if (!cen.blob) env.LOCAL_OUT = outF;
  if (cen.ponteDir) env.LOCAL_PONTE_DIR = cen.ponteDir;
  if (cen.gh) Object.assign(env, { GITHUB_TOKEN: 'tk-ensaio', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'http://127.0.0.1:' + PORTA });
  MUNDO_HTTP = Object.assign({ gh: cen.gh || {}, pub: PUB, corpos: CORPOS, pubSumiu: false }, cen.http || {});
  return new Promise((res) => {
    execFile(process.execPath, ['-r', PRELOAD, cen.script || GEN], { env, timeout: 60000, maxBuffer: 1 << 24 }, (err, so, se) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      let out = null, texto = null;
      if (fs.existsSync(outF)) { texto = fs.readFileSync(outF, 'utf8'); out = JSON.parse(texto); }
      const regs = fs.readFileSync(reg, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      res({ code, out, texto, regs, stdout: so, stderr: se });
    });
  });
}

/* ───────────── os esperados, contados a mao a partir dos fixtures ───────────── */
const N13 = 'nnnnnnnnnnnnn';
const H_ESPERADO = {
  /*        06..13 (8)  14 15 16 17 18 19 */
  ponte: 'nnnnnnnn' + 'ofnofa',
  inv: 'nnnnnnnn' + 'onnnfo', est: 'nnnnnnnn' + 'onnnfa', scada: 'nnnnnnnn' + 'onnnff',
  vm: 'nnnnnnnn' + 'onnnfa', vpn: 'nnnnnnnn' + 'onnnfa', cofre: 'nnnnnnnn' + 'onnnfo', onedrive: 'nnnnnnnn' + 'onnnfo',
  aviso: N13 + 'n', local: N13 + 'p', pc: N13 + 'd', pa: N13 + 'd',
  way2: N13 + 'o', ons: N13 + 'a', proc: N13 + 'a', pub: N13 + 'f', portal: N13 + 'n',
};
const PROX_PONTE = '2026-10-20T08:55:00Z';
const ETAPA_ESPERADA = {
  inv: { st: 'ok', motivo: null, ultima: '2026-10-19T10:05:00Z', ref_dia: '2026-10-18', prox: PROX_PONTE, n: { arquivos: 378, mb: 120.5 } },
  est: { st: 'at', motivo: 'fonte_ressalva', ultima: '2026-10-19T10:06:00Z', ref_dia: '2026-10-18', prox: PROX_PONTE, n: { arquivos: 0, mb: 0 } },
  scada: { st: 'fa', motivo: 'fonte_falha', ultima: '2026-10-19T10:10:00Z', ref_dia: '2026-10-18', prox: PROX_PONTE, n: { arquivos: 184, mb: 310.2 } },
  vm: { st: 'at', motivo: 'fonte_falha', ultima: '2026-10-19T10:10:00Z', ref_dia: '2026-10-18', prox: PROX_PONTE, n: { arquivos: 562 } },
  vpn: { st: 'at', motivo: 'fonte_falha', ultima: '2026-10-19T10:10:00Z', ref_dia: HOJE, prox: PROX_PONTE, n: {} },
  ponte: { st: 'at', motivo: 'ponte_tentativas', ultima: '2026-10-19T10:16:40Z', ref_dia: HOJE, prox: PROX_PONTE, n: { tentativas: 2, arquivos: 562, mb: 430.7 } },
  aviso: { st: 'sem', motivo: null, ultima: null, ref_dia: null, prox: null, n: {} },
  local: { st: 'plan', motivo: null, ultima: null, ref_dia: null, prox: null, n: {} },
  cofre: { st: 'ok', motivo: null, ultima: '2026-10-19T10:14:00Z', ref_dia: HOJE, prox: PROX_PONTE, n: { gravados: 558, mb: 430.7 } },
  pc: { st: 'des', motivo: null, ultima: null, ref_dia: null, prox: null, n: {} },
  onedrive: { st: 'ok', motivo: null, ultima: '2026-10-19T10:15:00Z', ref_dia: HOJE, prox: PROX_PONTE, n: { gravados: 562 } },
  pa: { st: 'des', motivo: null, ultima: null, ref_dia: null, prox: null, n: { restam: 3 } },
  way2: { st: 'ok', motivo: null, ultima: '2026-10-19T15:26:00Z', ref_dia: null, prox: '2026-10-19T15:35:00Z', n: { idade_min: 4 } },
  ons: { st: 'at', motivo: 'atrasado', ultima: '2026-10-18T09:30:00Z', ref_dia: null, prox: '2026-10-19T18:17:00Z', n: { idade_min: 1800 } },
  proc: { st: 'at', motivo: 'workflow_vermelho', ultima: '2026-10-19T15:20:00Z', ref_dia: null, prox: '2026-10-19T15:33:00Z', n: { ok: 2 * W - 1, total: 2 * W, vermelhos: 1, parados: 0 } },
  pub: { st: 'fa', motivo: 'muito_atrasado', ultima: '2026-10-19T15:05:00Z', ref_dia: null, prox: '2026-10-19T15:33:00Z', n: { no_prazo: G.FONTES.length - 4, total: G.FONTES.length - 2 } },
  portal: { st: 'sem', motivo: null, ultima: null, ref_dia: null, prox: null, n: {} },
};
const LINHA_ESPERADA = [
  { ts: '2026-10-19T09:26:01Z', etapa: 'ponte', st: 'at', ev: 'ponte_inicio' },
  { ts: '2026-10-19T10:05:00Z', etapa: 'inv', st: 'ok', ev: 'coleta_inversores' },
  { ts: '2026-10-19T10:14:00Z', etapa: 'cofre', st: 'ok', ev: 'cofre_gravou' },
  { ts: '2026-10-19T10:15:00Z', etapa: 'onedrive', st: 'ok', ev: 'onedrive_gravou' },
  { ts: '2026-10-19T10:16:40Z', etapa: 'ponte', st: 'at', ev: 'ponte_fim' },
  { ts: '2026-10-19T15:20:00Z', etapa: 'proc', st: 'at', ev: 'processamento' },
  { ts: '2026-10-19T15:25:00Z', etapa: 'pub', st: 'fa', ev: 'publicacao' },
];

/* ───────────── as checagens (devolvem a lista do que esta errado) ───────────── */
function textoLimpo(r) {
  const e = [];
  if (r.texto) for (const p of PROIBIDO_TEXTO) if (r.texto.includes(p)) e.push('a saida contem "' + p + '"');
  return e;
}
function semViolacao(r) { return r.regs.filter((x) => x.violacao).map((x) => 'acesso proibido: ' + x.violacao + ' em ' + x.conteiner); }
function frescorComPrazo(o) {
  return (o.frescor || []).filter((x) => !(typeof x.prazo_min === 'number' && x.prazo_min > 0)).map((x) => 'frescor ' + x.id + ' sem prazo');
}
function chkPrincipal(r) {
  const e = [];
  if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-2).join(' | ')];
  const o = r.out;
  e.push(...textoLimpo(r), ...semViolacao(r), ...frescorComPrazo(o));
  for (const [id, x] of Object.entries(ETAPA_ESPERADA)) {
    const y = o.etapas[id];
    if (!y) { e.push('falta a etapa ' + id); continue; }
    const z = Object.assign({}, y); delete z.h;
    if (!igual(z, x)) e.push('etapa ' + id + ': ' + JSON.stringify(z) + ' (esperado ' + JSON.stringify(x) + ')');
    if (y.h !== H_ESPERADO[id]) e.push('etapa ' + id + ': h ' + y.h + ' (esperado ' + H_ESPERADO[id] + ')');
  }
  if (!igual(o.ponte_hoje, { resultado: 'ok', tentativas: 2, inicio: '2026-10-19T09:26:01Z', fim: '2026-10-19T10:16:40Z', ontem: { resultado: 'falhou', tentativas: 3 } })) e.push('ponte_hoje: ' + JSON.stringify(o.ponte_hoje));
  if (!igual(o.recebido_hoje, { arquivos: 562, mb: 430.7, dia: HOJE })) e.push('recebido_hoje: ' + JSON.stringify(o.recebido_hoje));
  /* o disparo mais cedo e o do estacao-logger, 15:33 (proc e pub empatam; vale a ordem das etapas) */
  if (!igual(o.proxima, { etapa: 'proc', quando: '2026-10-19T15:33:00Z' })) e.push('proxima: ' + JSON.stringify(o.proxima));
  if (!igual(o.linha_dia, LINHA_ESPERADA)) e.push('linha_dia: ' + JSON.stringify(o.linha_dia));
  if (o.frescor.length !== G.FONTES.length) e.push('frescor com ' + o.frescor.length + ' fontes');
  for (const f of o.frescor) {
    const x = FRESCOR_ESPERADO[f.id];
    for (const k of Object.keys(x)) if (f[k] !== x[k]) e.push('frescor ' + f.id + '.' + k + ' = ' + f[k] + ' (esperado ' + x[k] + ')');
  }
  if (!igual(o.pa, { restam: 3, fluxos: ['Sungrow OneDrive RB para Blob', 'Inversores PWC → Blob → Grafana', 'SCADA SharePoint para Blob'], fim_licenca: '2026-11-09', atualizado: '2026-10-20' })) e.push('pa: ' + JSON.stringify(o.pa));
  if (o.acesso !== null || o.versao !== 1 || o.gerado !== AGORA) e.push('topo: versao/gerado/acesso');
  /* o cofre: so lido, os 15 dias e nenhum alem */
  const listas = r.regs.filter((x) => x.op === 'lista' && x.conteiner === 'backup-dados-scada').map((x) => x.prefixo).sort();
  const dias15 = []; for (let k = 14; k >= 0; k--) dias15.push('Ponte/estado/' + new Date(Date.parse(HOJE + 'T00:00:00Z') - k * 86400000).toISOString().slice(0, 10));
  if (!igual(listas, dias15)) e.push('listou no cofre: ' + listas.join(', '));
  if (r.regs.some((x) => x.op === 'grava')) e.push('gravou no blob com LOCAL_OUT');
  if (r.regs.some((x) => x.op === 'baixa' && /2026-10-01/.test(x.blob))) e.push('leu arquivo fora da janela');
  /* malha-frescor-conteudo: sem saida anterior, baixa o conteudo de cada fonte com conteudo declarado que existe, uma vez; as
   * fontes so pela gravacao (o 7,8 MB da medicao entre elas) nunca sao baixadas */
  const baixados = r.regs.filter((x) => x.op === 'baixa' && x.conteiner === 'dados').map((x) => x.blob).sort();
  const esperados = G.FONTES.filter((f) => f.conteudo && blobsDados[f.blob]).map((f) => f.blob).sort();
  if (!igual(baixados, esperados)) e.push('baixou do conteiner de dados: ' + baixados.length + ' (esperado ' + esperados.length + ')');
  if (baixados.includes('way2_recent.json')) e.push('baixou o arquivo de 5 min da medicao (so pela gravacao)');
  return e;
}
function chkGrava(r, ref) {
  const e = [...semViolacao(r)];
  if (r.code !== 0) return ['o gerador nao terminou (codigo ' + r.code + ')'];
  const g = r.regs.filter((x) => x.op === 'grava');
  if (g.length !== 1) return e.concat(['gravacoes: ' + g.length]);
  const x = g[0];
  if (x.conteiner !== 'portal-admin' || x.blob !== 'malha_estado.json') e.push('gravou em ' + x.conteiner + '/' + x.blob);
  const H = (x.opcoes && x.opcoes.blobHTTPHeaders) || {};
  if (H.blobContentType !== 'application/json' || H.blobContentEncoding !== 'gzip') e.push('cabecalhos: ' + JSON.stringify(H));
  const b = Buffer.from(x.b64, 'base64');
  if (!(b[0] === 0x1f && b[1] === 0x8b)) e.push('o blob nao esta em gzip');
  else if (!igual(JSON.parse(zlib.gunzipSync(b).toString('utf8')), ref)) e.push('o blob gravado difere da saida local');
  return e;
}
function chkPasta(r, ref) {
  const e = [...semViolacao(r)];
  if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + ')'];
  if (!igual(r.out.etapas, ref.etapas) || !igual(r.out.ponte_hoje, ref.ponte_hoje) || !igual(r.out.recebido_hoje, ref.recebido_hoje) || !igual(r.out.linha_dia, ref.linha_dia)) e.push('a pasta local nao reproduz o cofre');
  if (r.regs.some((x) => x.conteiner === 'backup-dados-scada')) e.push('tocou no cofre com LOCAL_PONTE_DIR');
  return e.concat(textoLimpo(r));
}
function chkSemFonte(r, ref) {
  if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-1)];
  const e = [];
  for (const id of G.PONTE_ETAPAS) {
    const x = r.out.etapas[id];
    if (x.st !== 'sem' || x.h !== 'nnnnnnnnnnnnnn') e.push('etapa ' + id + ' sem fonte saiu ' + x.st + ' ' + x.h);
  }
  if (r.out.ponte_hoje.resultado !== 'sem' || r.out.ponte_hoje.ontem.resultado !== 'sem') e.push('ponte_hoje sem fonte: ' + JSON.stringify(r.out.ponte_hoje));
  if (r.out.etapas.proc.st !== 'sem' || r.out.etapas.portal.st !== 'sem') e.push('sem token, proc/portal sairam ' + r.out.etapas.proc.st + '/' + r.out.etapas.portal.st);
  if (!igual(r.out.frescor, ref.frescor)) e.push('o frescor pelo publico difere do frescor pelo SDK');
  return e;
}
function chkEstoura(oque) {
  return (r) => {
    const e = [];
    if (r.code === 0) e.push(oque + ': o gerador terminou com sucesso');
    if (r.out) e.push(oque + ': gravou saida');
    if (r.regs.some((x) => x.op === 'grava')) e.push(oque + ': gravou no blob');
    return e;
  };
}

/* ───────────── plantios ───────────── */
function mutante(nome, trocas) {
  const orig = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
  let src = orig;
  for (const [de, para] of trocas.concat([["require('./lib-le-dados')", 'require(' + JSON.stringify(LIB) + ')']])) {
    const n = src.split(de).length - 1;
    if (n !== 1) throw new Error('plantio ' + nome + ': ancora achada ' + n + ' vezes (a linha do gerador mudou: atualizar a ancora do plantio, isto NAO e deteccao): ' + de.slice(0, 70));
    src = src.replace(de, () => para);
  }
  assert.notStrictEqual(src, orig, 'plantio ' + nome + ' nao mudou nada');
  const f = path.join(TMP, 'mutante_' + nome + '.js');
  fs.writeFileSync(f, src);
  return f;
}
const SEM_GUARDA = ['  const erros = confere(out);', '  const erros = [];'];
/* malha-frescor-conteudo: o prazo do conteudo tambem le a agenda e estouraria sozinho; o plantio "frescor sem prazo" cala os dois */
const PRAZO_C_NULO = ['function prazoConteudo(C, wfs, agenda, E) {\n', 'function prazoConteudo(C, wfs, agenda, E) { try { return prazoConteudo0(C, wfs, agenda, E); } catch (e) { return null; } }\nfunction prazoConteudo0(C, wfs, agenda, E) {\n'];

/* ───────────── 1. as regras soltas ───────────── */
async function regras() {
  console.log('1. regras soltas');
  const P = G.prazoMin;
  ok(P(['0 */5 * * * *']) === 10, 'prazo de 5 em 5 min = 10 min');
  ok(P(['0 */15 * * * *']) === 30 && P(['0 4,19,34,49 * * * *']) === 30, 'prazo de 15 em 15 min = 30 min');
  ok(P(['0 5 * * * *']) === 120, 'prazo de hora em hora = 2 h');
  ok(P(['0 13 4,9-22 * * *']) === 660, 'prazo irregular (04:13 e 09:13..22:13) = 6 h + 5 h = 660 min');
  ok(P(['0 47 12 * * *']) === 26 * 60, 'prazo de workflow diario = 26 h');
  ok(P(['0 23 8 * * *', '0 33 15 * * *']) === 1440, 'prazo de duas vezes por dia = os dois intervalos = 24 h');
  ok(P(['0 30 11 * * *', '0 0 17,21 * * *']) === 1200, 'prazo de tres temporizadores = 14,5 h + 5,5 h = 1200 min');
  ok(P(['0 10,40 3-5 * * *']) === 1320, 'prazo de repescagem de madrugada = 21,5 h + 0,5 h');
  let est = null; try { P(['0 0 1 1 * *']); } catch (e) { est = e; }
  ok(!!est, 'cron mensal estoura (nao inventa prazo)');
  est = null; try { G.prazoDe({ 'a.yml': ['0 */5 * * * *'] }, ['b.yml']); } catch (e) { est = e; }
  ok(!!est && /sem prazo/.test(est.message), 'fonte cujo workflow nao esta na agenda estoura ("sem prazo")');
  const real = JSON.parse(fs.readFileSync(AGENDA_REAL, 'utf8'));
  const semReal = G.FONTES.filter((f) => { try { return !(G.prazoDe(real, f.wf) > 0); } catch (e) { return true; } });
  ok(!semReal.length, 'toda fonte do gerador tem prazo na agenda REAL do relogio' + (semReal.length ? ': falta ' + semReal.map((f) => f.id).join(', ') : ''));
  ok(G.proximo(['0 */5 * * * *'], AGORA_MS) === Date.parse('2026-10-19T15:35:00Z'), 'proximo disparo de 5 em 5 min (15:30 -> 15:35)');
  ok(G.proximo(['0 17 18 * * *'], Date.parse('2026-10-19T19:00:00Z')) === Date.parse('2026-10-20T18:17:00Z'), 'proximo disparo diario ja passado vai para amanha');
  ok(G.proximaPonte(AGORA_MS) === Date.parse(PROX_PONTE) && G.proximaPonte(Date.parse('2026-10-19T08:00:00Z')) === Date.parse('2026-10-19T08:55:00Z'), 'proxima ponte: 05:55 de Brasilia');

  const F = G.estadoFrescor;
  ok(F(10, 10) === 'ok' && F(10.01, 10) === 'at' && F(20, 10) === 'at' && F(20.01, 10) === 'fa' && F(null, 10) === 'sem', 'frescor: ok <= prazo < at <= 2 x prazo < fa; ausente = sem');

  const le = (mapa) => async (n) => (mapa[n] ? Buffer.from(JSON.stringify(mapa[n])) : null);
  const it = (dia, horas) => horas.map((h) => ({ nome: 'Ponte/estado/' + dia + (h ? '_' + h : '') + '.json', mod: 0 }));
  const D = '2026-10-19', p = (h) => 'Ponte/estado/' + D + (h ? '_' + h : '') + '.json';
  let S = await G.escolheDiario(it(D, ['065900', '155500']), D, le({ [p('065900')]: v1(D, 'diario', 'ok', 2, TUDO_OK), [p('155500')]: v1(D, 'teste', 'ok', 1, TUDO_OK) }));
  ok(S && S.tentativas === 2 && S.versao === 1, 'o diario vence o teste mais novo do mesmo dia');
  S = await G.escolheDiario(it(D, ['060000', '070000']), D, le({ [p('060000')]: v1(D, 'diario', 'falhou', 1, TUDO_FALHA), [p('070000')]: v1(D, 'diario', 'ok', 2, TUDO_OK) }));
  ok(S && S.resultado === 'ok', 'entre dois diarios, vale o mais novo');
  S = await G.escolheDiario(it(D, ['150000']), D, le({ [p('150000')]: v1(D, 'teste', 'ok', 1, TUDO_OK) }));
  ok(S === null, 'dia so com teste = sem estado');
  S = await G.escolheDiario(it(D, ['']), D, le({ [p('')]: v0(D, 'ok', 1, true) }));
  ok(S && S.versao === 0 && S.fontes === null, 'arquivo sem modo = diario de versao 0, sem fontes (mesmo com o bloco presente)');
  est = null; try { await G.escolheDiario(it(D, ['1']), D, le({})); } catch (e) { est = e; }
  ok(!!est, 'nome fora do formato estoura');
  est = null; try { await G.escolheDiario(it(D, ['070000']), D, le({ [p('070000')]: Object.assign(v1(D, 'diario', 'ok', 1, TUDO_OK), { modo: 'producao' }) })); } catch (e) { est = e; }
  ok(!!est, 'modo desconhecido estoura (reconhecido e reprovado)');
  est = null; try { await G.escolheDiario(it(D, ['070000']), D, le({ [p('070000')]: v1('2026-10-18', 'diario', 'ok', 1, TUDO_OK) })); } catch (e) { est = e; }
  ok(!!est, 'conteudo de outro dia estoura (o dia sai do conteudo)');
  est = null; try { await G.escolheDiario(it(D, ['070000']), D, le({ [p('070000')]: v1(D, 'diario', 'ok', 1, Object.assign({}, TUDO_OK, { inv: 'parcial' })) })); } catch (e) { est = e; }
  ok(!!est, 'resultado de fonte desconhecido estoura');

  const norm = (j) => G.normaliza(j, 1, 0, 'x');
  let R = G.etapasPonte(norm(v1(D, 'diario', 'ok', 1, TUDO_FALHA)), D, true);
  ok(R.vm.st === 'fa' && R.vpn.st === 'fa' && R.inv.st === 'fa' && R.cofre.st === 'fa', 'as tres fontes da usina em falha: vm e vpn fa');
  R = G.etapasPonte(norm(v1(D, 'diario', 'ok', 1, TUDO_OK)), D, true);
  ok(['inv', 'est', 'scada', 'vm', 'vpn', 'ponte', 'cofre', 'onedrive'].every((k) => R[k].st === 'ok'), 'tudo ok com 1 tentativa: as oito etapas da ponte ok');
  R = G.etapasPonte(norm(v1(D, 'diario', 'falhou', 3, TUDO_FALHA)), D, true);
  ok(R.ponte.st === 'fa' && R.ponte.motivo === 'ponte_falhou', 'resultado falhou: ponte fa (ponte_falhou)');
  R = G.etapasPonte(null, D, true);
  ok(G.PONTE_ETAPAS.every((k) => R[k].st === 'sem' && R[k].motivo === 'sem_estado_hoje'), 'sem estado hoje: as oito sem (sem_estado_hoje), nenhuma ok');
  R = G.etapasPonte(G.normaliza(v0(D, 'ok', 1, false), 0, 0, 'x'), D, true);
  ok(R.ponte.st === 'ok' && ['inv', 'est', 'scada', 'vm', 'vpn', 'cofre', 'onedrive'].every((k) => R[k].st === 'sem' && R[k].motivo === 'sem_fontes_v0'), 'versao 0: a ponte pelo resultado, o resto sem (sem_fontes_v0)');

  /* proc (malha-v2): `fa` so quando um workflow PAROU DE GRAVAR. Os workflows e as fontes sao os do mapa do gerador:
   * ppc.yml grava registro_mesa; perdas.yml grava perdas_inversor e perdas_dia; must-intra.yml nao grava nada do frescor. */
  ok(G.FONTES.filter((f) => f.wf.includes('ppc.yml')).map((f) => f.id).join() === 'registro_mesa'
    && G.FONTES.filter((f) => f.wf.includes('perdas.yml')).map((f) => f.id).join() === 'perdas_inversor,perdas_dia,perdas_30,perdas_60,strings_entradas'
    && !G.FONTES.some((f) => f.wf.includes('must-intra.yml')), 'premissa do caso: o mapa fonte -> workflow do gerador');
  const runs = (...cs) => cs.map((c) => ({ c, t: AGORA_MS }));
  const FR = (over) => G.FONTES.map((f) => ({ id: f.id, st: (over || {})[f.id] || 'ok' }));
  const pr = G.etapaProc;
  const casa = (x, st, motivo, n) => x.st === st && x.motivo === motivo && igual(x.n, n);
  const verde = { wf: 'must-intra.yml', runs: runs('success', 'success') };
  ok(pr(null, FR()).st === 'sem', 'sem token: proc sem');
  ok(pr([{ wf: 'a.yml', runs: [] }], FR()).st === 'sem', 'nenhuma execucao concluida: sem');
  let x = pr([{ wf: 'ppc.yml', runs: runs('success', 'cancelled') }, verde], FR());
  ok(casa(x, 'ok', null, { ok: 3, total: 4, vermelhos: 0, parados: 0 }), 'todas verdes (cancelada nao e vermelha): ok, vermelhos 0 e parados 0 presentes');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'success') }, verde], FR());
  ok(casa(x, 'at', 'workflow_vermelho_grava', { ok: 3, total: 4, vermelhos: 1, parados: 0 }), '1 das 2 vermelha com o arquivo dele no prazo: at (workflow_vermelho_grava)');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'timed_out') }, verde], FR());
  ok(casa(x, 'at', 'workflow_vermelho_grava', { ok: 2, total: 4, vermelhos: 1, parados: 0 }), 'vermelho nas 2 ultimas com o arquivo dele no prazo: at (workflow_vermelho_grava), nao fa');
  for (const s of ['at', 'fa', 'sem']) {
    x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'startup_failure') }, verde], FR({ registro_mesa: s }));
    ok(casa(x, 'fa', 'workflow_vermelho', { ok: 2, total: 4, vermelhos: 1, parados: 1 }), 'vermelho nas 2 ultimas com o arquivo dele ' + s + ' no frescor: fa, parados 1');
  }
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'success') }, verde], FR({ registro_mesa: 'fa' }));
  ok(casa(x, 'at', 'workflow_vermelho', { ok: 3, total: 4, vermelhos: 1, parados: 0 }), 'vermelho em 1 das 2 com o arquivo dele atrasado: at (workflow_vermelho), nao parou');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure') }, verde], FR({ registro_mesa: 'at' }));
  ok(casa(x, 'fa', 'workflow_vermelho', { ok: 2, total: 3, vermelhos: 1, parados: 1 }), 'vermelho na unica execucao que ha com o arquivo atrasado: fa');
  x = pr([{ wf: 'must-intra.yml', runs: runs('failure', 'failure') }], FR({ registro_mesa: 'fa', ons_restricao: 'sem' }));
  ok(casa(x, 'at', 'workflow_vermelho', { ok: 0, total: 2, vermelhos: 1, parados: 0 }), 'vermelho nas 2 ultimas num workflow que nao grava nada do frescor: at (workflow_vermelho)');
  x = pr([{ wf: 'perdas.yml', runs: runs('failure', 'failure') }, verde], FR({ perdas_dia: 'at' }));
  ok(casa(x, 'fa', 'workflow_vermelho', { ok: 2, total: 4, vermelhos: 1, parados: 1 }), 'workflow com dois arquivos, um no prazo e um atrasado: fa (basta um)');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'failure') }, verde], FR({ ons_restricao: 'fa', perdas_dia: 'sem' }));
  ok(casa(x, 'at', 'workflow_vermelho_grava', { ok: 2, total: 4, vermelhos: 1, parados: 0 }), 'arquivo atrasado de OUTRO workflow nao para o vermelho: at (workflow_vermelho_grava)');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'failure') }, { wf: 'must-intra.yml', runs: runs('failure', 'success') }], FR());
  ok(casa(x, 'at', 'workflow_vermelho', { ok: 1, total: 4, vermelhos: 2, parados: 0 }), 'um vermelho que grava e um que nao grava nada do frescor: at (workflow_vermelho), vermelhos 2');
  x = pr([{ wf: 'ppc.yml', runs: runs('failure', 'failure') }, { wf: 'perdas.yml', runs: runs('failure', 'failure') }, verde], FR({ registro_mesa: 'at', perdas_inversor: 'fa' }));
  ok(casa(x, 'fa', 'workflow_vermelho', { ok: 2, total: 6, vermelhos: 2, parados: 2 }), 'dois workflows que pararam de gravar: fa, parados 2');
  est = null; try { pr([{ wf: 'ppc.yml', runs: runs('failure', 'failure') }], FR().filter((f) => f.id !== 'registro_mesa')); } catch (e) { est = e; }
  ok(!!est && /frescor sem a fonte registro_mesa/.test(est.message), 'frescor sem a fonte de um workflow vermelho estoura (nao inventa "no prazo")');

  /* malha-frescor-conteudo: o prazo do CONTEUDO, contado a mao na agenda DE ENSAIO AG_FIX (trafo 10:38, sungrow 13:17, executivo
   * 04:13 e 09:13..22:13, estacao 08:23 e 15:33, ons 18:17, way2-hist 03:30, way2-recent de 5 em 5 min). RE-002: este ensaio e o
   * portao do gerador; com a agenda real, mudar um minuto do relogio derrubaria a malha. A agenda real so entra pela premissa de
   * que toda fonte tem prazo nela (sem minuto escrito). */
  const I = G.instante, FD = G.fimDoDia;
  ok(I('2026-10-19T12:15:00') === Date.parse('2026-10-19T15:15:00Z') && I('2026-10-18 23:30:00') === Date.parse('2026-10-19T02:30:00Z')
    && I('2026-10-18T23:30:00-03:00') === Date.parse('2026-10-19T02:30:00Z') && I('2026-10-19T21:00:41.000Z') === Date.parse('2026-10-19T21:00:41Z')
    && I('2026-10-19') === null && I(1792377000000) === null && I('19/10/2026 12:00') === null, 'instante: sem fuso = Brasilia; com fuso, o dele; o resto nao e instante');
  ok(FD('2026-10-14') === Date.parse('2026-10-15T03:00:00Z') && FD('2026-10') === null && FD(null) === null, 'fim do dia de Brasilia: 00:00 do dia seguinte');
  const PC = (id, E) => { const f = G.FONTES.find((x) => x.id === id); if (!f || !f.conteudo) return null; return G.prazoConteudo(f.conteudo, f.wf, AG_FIX, Date.parse(E)); };
  ok(PC('trafo_dia', '2026-10-15T03:00:00Z') === 2018, 'trafo (dia 14): o dia 15 sai da VM na ponte de 16/10 05:55 e o trafo o publica as 10:38 UTC: 31h38 + 2 h = 2018 min');
  ok(PC('logger_disp', '2026-10-19T03:00:00Z') === 2177, 'logger: sungrow 13:17 UTC do dia seguinte: 34h17 + 2 h = 2177 min (o selo da casa: 36 h)');
  ok(PC('pr', '2026-10-19T03:00:00Z') === 2293, 'PR: ponte -> estacao 15:33 -> executivo 16:13: 37h13 + a folga de 1 execucao (1 h) = 2293 min');
  ok(PC('ons_restricao', '2026-10-19T03:00:00Z') === 2477, 'operador nacional: o dia seguinte no consolidado das 18:17 UTC: 39h17 + 2 h = 2477 min');
  ok(PC('medidor_dia', '2026-10-19T03:00:00Z') === 1590, 'dia do medidor: way2-hist 03:30 UTC: 24h30 + 2 h = 1590 min');
  ok(PC('ao_vivo', '2026-10-19T22:50:00Z') === 30, 'medicao de 5 min: 5 + 16 de latencia, a execucao seguinte, + 1 execucao = 30 min');
  ok(PC('inversores_registro', '2026-10-15T12:00:00Z') === 43200, 'registro de trocas: prazo fixo de 30 dias (revisao mensal)');
  ok(G.estadoFrescor(7010, PC('trafo_dia', '2026-10-15T03:00:00Z')) === 'fa', 'o caso de hoje: trafo com o dia 14, lido 7010 min depois (prazo 2018): fa');
  const FC = (id, corpo, gz) => { const f = G.FONTES.find((x) => x.id === id); if (!f || !f.conteudo) return undefined; let b = Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); if (gz) b = zlib.gzipSync(b); return G.fimDoConteudo(f.conteudo, b); };
  ok(FC('trafo_dia', { serie: [{ dia: '2026-10-14' }, { dia: '2026-10-13' }, { x: 1 }, null] }, true) === Date.parse('2026-10-15T03:00:00Z'), 'conteudo em gzip: o MAIOR dia da serie, linhas sem dia ignoradas');
  ok(FC('selo_medidores', '﻿' + JSON.stringify({ ancora: '2026-10-19T19:50:00' })) === Date.parse('2026-10-19T22:50:00Z'), 'conteudo com BOM');
  ok(FC('trafo_dia', { serie: [] }) === null && FC('trafo_dia', { serie: [{ x: 1 }, null] }) === null, 'serie vazia, ou so com linhas sem dia: null (sai sem registro)');   // RE-005
  ok(FC('trafo_dia', 'nao e json') === null && FC('trafo_dia', { serie: 'x' }) === null && FC('trafo_dia', { dias: [{ dia: '2026-10-18' }] }) === null && FC('trafo_dia', '') === null,
    'conteudo ilegivel, sem a lista ou com o campo noutro lugar: null (nunca a gravacao no lugar)');
  ok(G.FONTES.filter((f) => !f.conteudo).map((f) => f.id).join() === 'medidor_5min,selos_fontes,corte_gemeo,registro_mesa', 'so quatro fontes pela gravacao, declaradas');

  /* malha-vigia-mais: a lista e os prazos das oito fontes novas, contados a mao no AG_FIX */
  const faltaV = faltaVigia(G);
  ok(!faltaV.length && G.FONTES.length === N_FONTES && G.FONTES.filter((f) => f.etapa === 'pub').length === N_PUB,
    'as oito fontes novas na lista, pelo conteudo e com o workflow declarado; ' + N_FONTES + ' fontes, ' + N_PUB + ' da publicacao'
    + (faltaV.length ? ': falta ou difere ' + faltaV.join(', ') : ' (gerador: ' + G.FONTES.length + ')'));
  const TRAFOS_ID = ['trafo_5', 'trafo_15', 'trafo_30', 'trafo_60'];
  ok(TRAFOS_ID.every((id) => PC(id, '2026-10-19T10:20:00Z') === 1578),
    'trafo pelo medidor: o intervalo seguinte (10:25 + 16 = 10:41) passa da execucao das 10:38: a do dia seguinte, 24h18 + 2 h = 1578 min');
  ok(TRAFOS_ID.every((id) => PC(id, '2026-10-20T15:10:00Z') === 1288), 'os quatro trafos, execucao fora da agenda as 15:24 (o caso de hoje): ate 21/10 10:38, 19h28 + 2 h = 1288 min (o dia fechado daria 2728)');
  ok(PC('perdas_30', '2026-10-19T03:00:00Z') === 2232 && PC('perdas_60', '2026-10-19T03:00:00Z') === 2232 && PC('strings_entradas', '2026-10-19T03:00:00Z') === 2232,
    'perdas de 30 e 60 min e entradas de string: ponte -> perdas 14:12 UTC do dia seguinte: 35h12 + 2 h = 2232 min');
  ok(PC('inversores_scada_hora', '2026-10-19T03:00:00Z') === 2147, 'inversores hora a hora: ponte -> inv-scada 12:47 UTC: 33h47 + 2 h = 2147 min');
  /* RE-004: com perdas e inv-scada as 07:00 UTC a ponte (08:55) muda o resultado: R1 22/10 07:00 (3120) + 120 = 3240; sem ela, 1800 */
  const AG_CEDO = Object.assign({}, AG_FIX, { 'perdas.yml': ['0 0 7 * * *'], 'inv-scada.yml': ['0 0 7 * * *'] });
  const PCA = (id, E) => { const f = G.FONTES.find((x) => x.id === id); return f && f.conteudo ? G.prazoConteudo(f.conteudo, f.wf, AG_CEDO, Date.parse(E)) : null; };
  ok(['perdas_30', 'perdas_60', 'strings_entradas', 'inversores_scada_hora'].every((id) => PCA(id, '2026-10-19T03:00:00Z') === 3240),
    'os quatro do supervisorio esperam a ponte das 05:55 de Brasilia: com o workflow as 07:00 UTC, 3240 min (sem a ponte seriam 1800)');
  const F14 = Date.parse('2026-10-15T03:00:00Z');
  ok(FC('trafo_5', { medidor_ate: '2026-10-20 12:05', supervisorio_ate: '2026-10-14 23:30', serie: [{ t: '2026-10-20 12:05' }] }, true) === Date.parse('2026-10-20T15:10:00Z')
    && FC('trafo_30', { medidor_ate: '2026-10-15 07:15', supervisorio_ate: '2026-10-19 23:30', serie: [{ t: '2026-10-19 23:30' }] }) === Date.parse('2026-10-15T10:20:00Z'),
    'trafo: o fim do dado e o medidor_ate + 5 min; o supervisorio e o fim da serie nao contam');
  ok(TRAFOS_ID.every((id) => FC(id, { medidor_ate: null, supervisorio_ate: '2026-10-19 07:00', serie: [{ t: '2026-10-19 07:00' }] }) === null
    && FC(id, { supervisorio_ate: '2026-10-19 07:00', serie: [{ t: '2026-10-19 07:00' }] }) === null),
    'trafo sem medidor_ate: null (sai sem registro, nunca a serie no lugar)');
  ok(FC('perdas_30', { serie: [{ t: '2026-10-14 23:00' }, { t: '2026-10-14 23:30' }] }, true) === F14 && FC('perdas_60', { serie: [{ t: '2026-10-14 23:00' }, { t: '2026-10-14 22:00' }] }) === F14,
    'perdas: a meia hora das 23:30 + 30 e a hora das 23:00 + 60 fecham o dia 14');
  ok(FC('strings_entradas', { serie: [{ ultimo_ok: '2026-09-01' }, { ultimo_ok: null }, { ultimo_ok: '2026-10-14' }, { ok: ['2026-10-19'] }, { ultimo_ok: '2026-10-02' }] }, true) === F14
    && FC('inversores_scada_hora', { escopo: { de: '2026-09-15', ate: '2026-10-14' } }) === F14,
    'entradas de string pelo MAIOR ultimo_ok (o ok[] dos primeiros dias nao conta); inversores hora a hora pelo escopo.ate');
  est = null; try { G.prazoConteudo({ passo: 1440, chegada: [{ wf: ['sumiu.yml'] }] }, ['trafo.yml'], AG_FIX, Date.now()); } catch (e) { est = e; }
  ok(!!est && /sem prazo: sumiu.yml/.test(est.message), 'regra de chegada com workflow fora da agenda estoura');
}

/* ───────────── 2 e 3. o gerador de verdade e os plantios ───────────── */
async function processos() {
  const mundoCofre = (extra) => ({ conteineres: Object.assign({ 'backup-dados-scada': { blobs: blobsCofre }, dados: { blobs: blobsDados }, 'portal-admin': { blobs: {} } }, extra || {}) });
  const PRINCIPAL = { sdk: mundoCofre(), gh: GH_PRINCIPAL };

  console.log('2. o gerador num processo a parte');
  const r1 = await roda(PRINCIPAL);
  const e1 = chkPrincipal(r1);
  ok(!e1.length, 'mundo principal: cada regra da tabela do contrato' + (e1.length ? '\n         ' + e1.join('\n         ') : ''));
  const ref = r1.out;
  if (ref) {
    ok(!G.confere(ref).length, 'a saida passa na guarda do gerador');
    const planta = (f, oque) => { const c = JSON.parse(JSON.stringify(ref)); f(c); return G.confere(c).length > 0; };
    ok(planta((c) => { c.etapas.ponte.n.log = 'x'; }, 'log'), 'guarda reprova `log` em n');
    ok(planta((c) => { c.etapas.cofre.motivo = 'backup-dados-scada'; }), 'guarda reprova nome de conteiner num campo');
    ok(planta((c) => { c.frescor[0].prazo_min = null; }), 'guarda reprova frescor sem prazo');
    ok(planta((c) => { c.etapas.est.st = 'ok'; c.etapas.est.ultima = null; c.etapas.est.h = c.etapas.est.h.slice(0, 13) + 'o'; }), 'guarda reprova ok sem registro');
    ok(planta((c) => { c.linha_dia.push({ ts: AGORA, etapa: 'ponte', st: 'ok', ev: '10.1.2.3' }); }), 'guarda reprova IP num evento');
    ok(planta((c) => { c.etapas.inv.h = 'nnnnn'; }), 'guarda reprova h fora do formato');
    /* malha-frescor-conteudo */
    const iC = ref.frescor.findIndex((x) => x.id === 'trafo_dia'), iG = ref.frescor.findIndex((x) => x.id === 'selos_fontes');
    ok(planta((c) => { c.frescor[iC].medida = 'cabecalho'; }), 'guarda reprova medida fora da lista');
    ok(planta((c) => { c.frescor[iC].ate = null; }), 'guarda reprova medido pelo conteudo sem o fim do dado');
    ok(planta((c) => { c.frescor[iC].ate = '14/10/2026'; }), 'guarda reprova fim do dado fora do formato');
    ok(planta((c) => { c.frescor[iC].gravado = null; }), 'guarda reprova medido sem a gravacao');
    ok(planta((c) => { c.frescor[iG].ate = '2026-10-19T03:00:00Z'; }), 'guarda reprova fim do dado em fonte declarada sem conteudo');
    ok(planta((c) => { c.frescor[iC].arquivo = 'trafo_diario.json'; }), 'guarda reprova chave nova no frescor');
  }
  const r2 = await roda(Object.assign({}, PRINCIPAL, { blob: true, sdk: mundoCofre() }));
  const e2 = ref ? chkGrava(r2, ref) : ['sem referencia'];
  ok(!e2.length, 'grava no blob: so no conteiner do portal, gzip, application/json, o mesmo conteudo' + (e2.length ? ': ' + e2.join(' | ') : ''));

  const dir = path.join(TMP, 'ponte');
  fs.mkdirSync(dir);
  for (const e of ESTADOS) { const f = path.join(dir, e[0]); fs.writeFileSync(f, bufEstado(e)); const s = Date.parse(e[2]) / 1000; fs.utimesSync(f, s, s); }
  const r3 = await roda({ sdk: mundoCofre({ 'backup-dados-scada': { blobs: {}, proibido: true } }), ponteDir: dir, gh: GH_PRINCIPAL });
  const e3 = ref ? chkPasta(r3, ref) : ['sem referencia'];
  ok(!e3.length, 'LOCAL_PONTE_DIR substitui o cofre (o cofre nem e tocado)' + (e3.length ? ': ' + e3.join(' | ') : ''));

  const r4 = await roda({});
  const e4 = ref ? chkSemFonte(r4, ref) : ['sem referencia'];
  ok(!e4.length, 'sem DADOS_STORAGE, sem LOCAL_PONTE_DIR e sem token: ponte, proc e portal sem; frescor pelo publico' + (e4.length ? ': ' + e4.join(' | ') : ''));

  /* `undefined` some no JSON: o conteiner deixa de existir no mundo falso */
  const CENARIOS_ESTOURA = {
    cofre404: [{ sdk: mundoCofre({ 'backup-dados-scada': undefined }), gh: GH_PRINCIPAL }, chkEstoura('cofre 404 ContainerNotFound'), /ContainerNotFound/],
    semPrazo: [{ sdk: mundoCofre(), gh: GH_PRINCIPAL, agenda: agendaSemTrafo }, (r) => chkEstoura('agenda sem o workflow de uma fonte')(r).concat(r.out ? frescorComPrazo(r.out) : []), /sem prazo: trafo\.yml/],
    pub404: [{ http: { pubSumiu: true } }, chkEstoura('conteiner publico 404 ContainerNotFound'), /ContainerNotFound/],
  };
  for (const [nome, [cen, chk, motivo]] of Object.entries(CENARIOS_ESTOURA)) {
    const r = await roda(cen);
    const e = chk(r);
    if (!e.length && !motivo.test(r.stderr)) e.push('estourou por outro motivo: ' + String(r.stderr).trim().split('\n').pop());
    ok(!e.length, 'estoura sem gravar: ' + nome + (e.length ? ': ' + e.join(' | ') : ' (' + String(r.stderr).trim().split('\n').pop().slice(0, 90) + ')'));
  }

  /* proc (malha-v2) no gerador de verdade: o frescor e o do mundo principal (ons_restricao at, executivo ausente, portal_vivo
   * fa; o resto no prazo). So o GitHub muda; o resto da saida tem de ficar igual ao principal. */
  const verm2 = (c1, c2) => [run(c1, '2026-10-19T15:10:00Z'), run(c2, '2026-10-19T14:10:00Z')];
  const nProc = (verde, parados) => ({ ok: 2 * W - 2 + verde, total: 2 * W, vermelhos: 1, parados });
  const MUNDOS_PROC = {
    'vermelho nas 2 com o arquivo atrasado (ons)': [{ 'ons-consolidado.yml': verm2('failure', 'timed_out') }, { st: 'fa', motivo: 'workflow_vermelho', n: nProc(0, 1) }],
    'vermelho nas 2 com o arquivo ausente (executivo)': [{ 'executivo.yml': verm2('failure', 'failure') }, { st: 'fa', motivo: 'workflow_vermelho', n: nProc(0, 1) }],
    'vermelho nas 2 com o arquivo no prazo (ppc)': [{ 'ppc.yml': verm2('failure', 'failure') }, { st: 'at', motivo: 'workflow_vermelho_grava', n: nProc(0, 0) }],
    'vermelho nas 2 sem arquivo no frescor (must-intra)': [{ 'must-intra.yml': verm2('failure', 'failure') }, { st: 'at', motivo: 'workflow_vermelho', n: nProc(0, 0) }],
    'todas verdes': [{}, { st: 'ok', motivo: null, n: { ok: 2 * W, total: 2 * W, vermelhos: 0, parados: 0 } }],
    /* malha-sem-mesa: a auditoria da mesa contra o ONS nao entra na Malha (decisao do humano, 19/10) */
    'ons vermelho SO pela auditoria da mesa': [{ 'ons-consolidado.yml': [
      run('failure', '2026-10-19T15:10:00Z', [{ name: 'Consolidar ONS restricao + irradiancia', conclusion: 'success' }, { name: 'Auditar o registro do PPC contra o ONS', conclusion: 'failure' }]),
      run('failure', '2026-10-19T14:10:00Z', [{ name: 'Auditar o registro do PPC contra o ONS', conclusion: 'failure' }])] },
      { st: 'ok', motivo: null, n: { ok: 2 * W, total: 2 * W, vermelhos: 0, parados: 0 } }],
    'ons vermelho pela auditoria E pelo consolidado': [{ 'ons-consolidado.yml': [
      run('failure', '2026-10-19T15:10:00Z', [{ name: 'Consolidar ONS restricao + irradiancia', conclusion: 'failure' }, { name: 'Auditar o registro do PPC contra o ONS', conclusion: 'failure' }]),
      run('failure', '2026-10-19T14:10:00Z', [{ name: 'Consolidar ONS restricao + irradiancia', conclusion: 'failure' }])] },
      { st: 'fa', motivo: 'workflow_vermelho', n: nProc(0, 1) }],
  };
  const chkProc = (esp) => (r) => {
    if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-1)];
    const e = [...textoLimpo(r), ...semViolacao(r)];
    const y = Object.assign({}, r.out.etapas.proc); delete y.h;
    const x = Object.assign({ ultima: '2026-10-19T15:20:00Z', ref_dia: null, prox: '2026-10-19T15:33:00Z' }, esp);
    const xo = { st: x.st, ultima: x.ultima, ref_dia: x.ref_dia, prox: x.prox, n: x.n, motivo: x.motivo };
    if (!igual(y, xo)) e.push('proc: ' + JSON.stringify(y) + ' (esperado ' + JSON.stringify(xo) + ')');
    const L = { ok: 'o', at: 'a', fa: 'f' }[esp.st];
    if (r.out.etapas.proc.h !== N13 + L) e.push('proc: h ' + r.out.etapas.proc.h);
    const ev = r.out.linha_dia.filter((l) => l.etapa === 'proc');
    if (ev.length !== 1 || ev[0].st !== esp.st) e.push('linha_dia do proc: ' + JSON.stringify(ev));
    if (ref) for (const id of G.ETAPAS) if (id !== 'proc' && !igual(r.out.etapas[id], ref.etapas[id])) e.push('etapa ' + id + ' mudou junto com o proc');
    return e;
  };
  for (const [nome, [ghm, esp]] of Object.entries(MUNDOS_PROC)) {
    const r = await roda({ sdk: mundoCofre(), gh: ghm });
    const e = chkProc(esp)(r);
    ok(!e.length, 'proc: ' + nome + ' -> ' + esp.st + (esp.motivo ? ' (' + esp.motivo + ')' : '') + (e.length ? ': ' + e.join(' | ') : ''));
  }
  const MP = (k) => ({ sdk: mundoCofre(), gh: MUNDOS_PROC[k][0] });
  const CP = (k) => chkProc(MUNDOS_PROC[k][1]);

  /* malha-frescor-conteudo: os mundos do CONTEUDO, sobre o mundo VERDE (tudo gravado ha 5 min, o conteudo de cada fixture). */
  const MOD5Z = '2026-10-19T15:25:00Z';
  const ESP_VERDE = {};
  for (const f of G.FONTES) ESP_VERDE[f.id] = Object.assign({}, FIX[f.id][2], { gravado: MOD5Z });
  Object.assign(ESP_VERDE, {
    medidor_5min: Object.assign(okG(5, 10), { gravado: MOD5Z }),
    ons_restricao: Object.assign(okC(2190, 2477, '2026-10-18T03:00:00Z'), { gravado: MOD5Z }),   // o dia 17: 2190/2477, no prazo
    visao_executiva: Object.assign(okC(750, 2473, FIM_D1), { gravado: MOD5Z }),
    ao_vivo: Object.assign(okC(15, 30, W5Z), { gravado: MOD5Z }),
  });
  const mundoDados = (dados, extra) => ({ conteineres: Object.assign({ 'backup-dados-scada': { blobs: blobsCofre }, dados: { blobs: dados }, 'portal-admin': { blobs: {} } }, extra || {}) });
  const DADOS_VERDE = dadosDe({});
  const NOMES_C = G.FONTES.filter((f) => f.conteudo).map((f) => f.blob).sort();
  /* o dado congelado de hoje: regravado ha 5 min, o conteudo parou no dia 14 (fim 15/10 03:00 UTC, 6510 min antes) */
  const CONG = { trafo_dia: { corpo: { serie: [{ dia: '2026-10-13' }, { dia: '2026-10-14' }] } }, sager_disp: { corpo: { serie: [{ t: '2026-10-14T23:30' }] } },
    perdas_dia: { corpo: { serie: [{ dia: '2026-10-14' }] } } };
  const fa14 = (prazo) => ({ st: 'fa', idade_min: 6510, prazo_min: prazo, medida: 'conteudo', ate: '2026-10-15T03:00:00Z', gravado: MOD5Z });
  const ESP_CONG = Object.assign({}, ESP_VERDE, { trafo_dia: fa14(2018), sager_disp: fa14(1847), perdas_dia: fa14(2232) });
  /* o plantio nao e vazio: pela gravacao (a regra antiga), os tres congelados estariam no prazo */
  const velho = ['trafo_dia', 'sager_disp', 'perdas_dia'].map((id) => { const f = G.FONTES.find((x) => x.id === id); return G.estadoFrescor((AGORA_MS - dadosDe(CONG)[f.blob].mod) / 60000, G.prazoDe(AG_FIX, f.wf)); });
  ok(velho.every((s) => s === 'ok') && ['trafo_dia', 'sager_disp', 'perdas_dia'].every((id) => dadosDe(CONG)[BLOB[id]].mod === MOD5),
    'premissa do congelado: os tres foram regravados ha 5 min e, pela gravacao, sairiam ok (' + velho.join(', ') + ')');
  /* o conteudo que nao se le: lista sem data e corpo que nao e JSON. Sai sem registro, com a gravacao e o prazo da agenda */
  const ILEG = { estacao_dia: { corpo: { serie: 'x' } }, pr: { corpo: 'nao e json', gz: false } };
  const ESP_ILEG = Object.assign({}, ESP_VERDE, {
    estacao_dia: { st: 'sem', idade_min: null, prazo_min: 1440, medida: 'conteudo', ate: null, gravado: MOD5Z },
    pr: { st: 'sem', idade_min: null, prazo_min: 660, medida: 'conteudo', ate: null, gravado: MOD5Z } });
  /* a saida anterior do MESMO dia: o trafo foi regravado desde entao (outra gravacao, conteudo velho na saida anterior); o logger
   * nao (a mesma gravacao, e um `ate` que so a saida anterior tem: prova que ela foi usada) */
  const anterior = (gerado) => {
    const fr = G.FONTES.filter((f) => f.conteudo).map((f) => ({ id: f.id, gravado: MOD5Z, ate: ESP_VERDE[f.id].ate }));
    fr.find((x) => x.id === 'trafo_dia').gravado = '2026-10-19T14:00:00Z'; fr.find((x) => x.id === 'trafo_dia').ate = '2026-10-15T03:00:00Z';
    fr.find((x) => x.id === 'logger_disp').ate = '2026-10-19T02:00:00Z';
    return { 'malha_estado.json': { mod: Date.parse(gerado), b64: zlib.gzipSync(Buffer.from(JSON.stringify({ versao: 1, gerado, frescor: fr }))).toString('base64') } };
  };
  /* logger com o fim da saida anterior (02:00 UTC): 810 min; E + 1 dia + 355 = 07:55 -> sungrow 13:17: 35h17 + 2 h = 2237 */
  const ESP_ANT = Object.assign({}, ESP_VERDE, { logger_disp: Object.assign(okC(810, 2237, '2026-10-19T02:00:00Z'), { gravado: MOD5Z }) });
  const MUNDOS_C = {
    verde: [{ sdk: mundoDados(DADOS_VERDE) }, ESP_VERDE, { st: 'ok', n: { no_prazo: 37, total: 37 } }, NOMES_C],
    'congelado em 14/10, regravado hoje': [{ sdk: mundoDados(dadosDe(CONG)), gh: { 'trafo.yml': verm2('failure', 'failure') } }, ESP_CONG,
      { st: 'fa', n: { no_prazo: 34, total: 37 }, proc: { st: 'fa', motivo: 'workflow_vermelho' } }, NOMES_C],
    'conteudo ilegivel': [{ sdk: mundoDados(dadosDe(ILEG)) }, ESP_ILEG, { st: 'fa', n: { no_prazo: 35, total: 37 } }, NOMES_C],
    'saida anterior do mesmo dia': [{ sdk: mundoDados(DADOS_VERDE, { 'portal-admin': { blobs: anterior('2026-10-19T15:15:00Z') } }) }, ESP_ANT,
      { st: 'ok', n: { no_prazo: 37, total: 37 } }, ['trafo_diario.json']],
    'saida anterior de outro dia': [{ sdk: mundoDados(DADOS_VERDE, { 'portal-admin': { blobs: anterior('2026-10-18T23:00:00Z') } }) }, ESP_VERDE,
      { st: 'ok', n: { no_prazo: 37, total: 37 } }, NOMES_C],
  };
  /* malha-vigia-mais. SUPERVISORIO PARADO: os quatro do supervisorio regravados ha 5 min com o dado no dia 14 (fa pelo conteudo; o
   * perdas.yml vermelho nas 2 so com eles fora do prazo: o proc vai a fa por eles), e o trafo com o medidor em dia e o supervisorio dele
   * parado no dia 14 (ok). MEDIDOR PARADO: o medidor_ate no dia 15 e linhas so do supervisorio no fim da serie, ate o dia 19 (fa: 15/10
   * 10:20 a 19/10 15:30 = 6070 min, prazo 1578) */
  const SUP14 = { perdas_30: { corpo: { serie: [{ t: '2026-10-14 23:00' }, { t: '2026-10-14 23:30' }] } }, perdas_60: { corpo: { serie: [{ t: '2026-10-14 23:00' }] } },
    strings_entradas: { corpo: { serie: [{ ultimo_ok: '2026-08-02' }, { ultimo_ok: '2026-10-14' }, { ultimo_ok: null }, { ultimo_ok: '2026-09-30' }] } }, inversores_scada_hora: { corpo: { escopo: { de: '2026-09-15', ate: '2026-10-14' } } } };
  const ESP_SUP14 = Object.assign({}, ESP_VERDE, { perdas_30: fa14(2232), perdas_60: fa14(2232), strings_entradas: fa14(2232), inversores_scada_hora: fa14(2147) });
  const MED15 = { medidor_ate: '2026-10-15 07:15', supervisorio_ate: '2026-10-19 07:00', serie: [{ t: '2026-10-15 07:15' }, { t: '2026-10-19 07:00' }] };
  const TRAFOS = ['trafo_5', 'trafo_15', 'trafo_30', 'trafo_60'];
  const ESP_MED15 = Object.assign({}, ESP_VERDE);
  for (const id of TRAFOS) ESP_MED15[id] = { st: 'fa', idade_min: 6070, prazo_min: 1578, medida: 'conteudo', ate: '2026-10-15T10:20:00Z', gravado: MOD5Z };
  /* premissa: pela gravacao (a regra de antes do lote, com as fontes fora da lista nem medidas) os oito sairiam ok */
  const velhoV = [...Object.keys(SUP14), ...TRAFOS].map((id) => { const f = G.FONTES.find((x) => x.id === id); return f ? G.estadoFrescor((AGORA_MS - MOD5) / 60000, G.prazoDe(AG_FIX, f.wf)) : 'fora da lista'; });
  ok(velhoV.every((s) => s === 'ok'), 'premissa dos mundos do vigia: os oito regravados ha 5 min sairiam ok pela gravacao (' + velhoV.join(', ') + ')');
  /* RE-002: o medidor sem leitura (medidor_ate nulo) com o supervisorio e a serie em dia: sem registro, com o prazo da gravacao (26 h) */
  const MEDNULO = { medidor_ate: null, supervisorio_ate: '2026-10-19 12:00', serie: [{ t: '2026-10-19 12:00' }] };
  const ESP_MEDNULO = Object.assign({}, ESP_VERDE);
  for (const id of TRAFOS) ESP_MEDNULO[id] = { st: 'sem', idade_min: null, prazo_min: 1560, medida: 'conteudo', ate: null, gravado: MOD5Z };
  Object.assign(MUNDOS_C, {
    'vigia: medidor sem leitura, supervisorio e serie em dia': [{ sdk: mundoDados(dadosDe(Object.fromEntries(TRAFOS.map((id) => [id, { corpo: MEDNULO }])))) }, ESP_MEDNULO,
      { st: 'fa', n: { no_prazo: 33, total: 37 } }, NOMES_C],
    'vigia: supervisorio parado no dia 14, medidor em dia': [{ sdk: mundoDados(dadosDe(SUP14)), gh: { 'perdas.yml': verm2('failure', 'failure') } }, ESP_SUP14,
      { st: 'fa', n: { no_prazo: 33, total: 37 }, proc: { st: 'fa', motivo: 'workflow_vermelho' } }, NOMES_C],
    'vigia: medidor parado no dia 15, supervisorio seguindo': [{ sdk: mundoDados(dadosDe(Object.fromEntries(TRAFOS.map((id) => [id, { corpo: MED15 }])))) }, ESP_MED15,
      { st: 'fa', n: { no_prazo: 33, total: 37 } }, NOMES_C],
  });
  const chkC = (esp, pub, baixa, parcial) => (r) => {
    if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-1)];
    const e = [...textoLimpo(r), ...semViolacao(r)];
    if (!parcial) {   /* RE-006: as fontes da saida sao as do esperado, nem uma a menos, nem uma a mais */
      const sai = new Set(r.out.frescor.map((x) => x.id)), quer = Object.keys(esp);
      const falta = quer.filter((k) => !sai.has(k)), sobra = [...sai].filter((k) => !(k in esp));
      if (falta.length || sobra.length) e.push('fontes da saida: faltam ' + (falta.join(', ') || 'nenhuma') + '; sobram ' + (sobra.join(', ') || 'nenhuma'));
    }
    for (const f of r.out.frescor) {
      const x = esp[f.id] || {};
      for (const k of Object.keys(x)) if (f[k] !== x[k]) e.push('frescor ' + f.id + '.' + k + ' = ' + f[k] + ' (esperado ' + x[k] + ')');
    }
    const p = r.out.etapas.pub;
    if (p.st !== pub.st || !igual(p.n, pub.n)) e.push('pub ' + p.st + ' ' + JSON.stringify(p.n) + ' (esperado ' + pub.st + ' ' + JSON.stringify(pub.n) + ')');
    if (pub.proc && (r.out.etapas.proc.st !== pub.proc.st || r.out.etapas.proc.motivo !== pub.proc.motivo)) e.push('proc ' + r.out.etapas.proc.st + ' ' + r.out.etapas.proc.motivo);
    const baixados = r.regs.filter((x) => x.op === 'baixa' && x.conteiner === 'dados').map((x) => x.blob).sort();
    if (!igual(baixados, baixa.slice().sort())) e.push('baixou ' + baixados.length + ' do conteiner de dados (esperado ' + baixa.length + '): ' + baixados.slice(0, 4).join(', '));
    if (r.regs.some((x) => x.op === 'grava')) e.push('gravou no blob com LOCAL_OUT');
    return e;
  };
  for (const [nome, [cen, esp, pub, baixa]] of Object.entries(MUNDOS_C)) {
    const r = await roda(cen);
    const e = chkC(esp, pub, baixa)(r);
    ok(!e.length, 'conteudo: ' + nome + ' -> pub ' + pub.st + ', ' + baixa.length + ' baixado(s)' + (e.length ? ': ' + e.join(' | ') : ''));
  }
  const MC = (k) => MUNDOS_C[k][0];
  /* malha-vigia-mais: as ancoras dos plantios (as linhas do gerador, uma vez cada) e os dois mundos do vigia */
  const L_P30 = "  { id: 'perdas_30', etapa: 'pub', blob: 'perdas_30min.json', wf: ['perdas.yml'], conteudo: CDIA(lerMeiaHora('serie', 't'), PONTE) },";
  const L_P60 = "  { id: 'perdas_60', etapa: 'pub', blob: 'perdas_60min.json', wf: ['perdas.yml'], conteudo: CDIA(lerHora('serie', 't'), PONTE) },";
  const L_SE = "  { id: 'strings_entradas', etapa: 'pub', blob: 'pvstr_entradas.json', wf: ['perdas.yml'], conteudo: CDIA(lerDia('serie', 'ultimo_ok'), PONTE) },";
  const L_ISH = "  { id: 'inversores_scada_hora', etapa: 'pub', blob: 'inv_scada_hora.json', wf: ['inv-scada.yml'], conteudo: CDIA((j) => fimDoDia(j.escopo && j.escopo.ate), PONTE) },";
  const L_MED = 'const lerMedidor = (j) => mais(instante(j.medidor_ate), 5);';
  const L_HORA = 'const lerHora = (lista, campo) => (j) => mais(ultimo(j[lista], (x) => instante(x[campo])), 60);';
  const K_SUP = 'vigia: supervisorio parado no dia 14, medidor em dia', K_MED = 'vigia: medidor parado no dia 15, supervisorio seguindo';
  /* o plantio da regra antiga e julgado SO pelos tres congelados (o erro citado e o deles, nao o de outra fonte) */
  const SO_CONGELADOS = chkC({ trafo_dia: ESP_CONG.trafo_dia, sager_disp: ESP_CONG.sager_disp, perdas_dia: ESP_CONG.perdas_dia }, MUNDOS_C['congelado em 14/10, regravado hoje'][2], NOMES_C, true);
  const CC = (k) => chkC(MUNDOS_C[k][1], MUNDOS_C[k][2], MUNDOS_C[k][3]);
  const ANT403 = [{ sdk: mundoDados(DADOS_VERDE, { 'portal-admin': { blobs: {}, proibido: true } }) }, chkEstoura('saida anterior com 403'), /AuthorizationPermissionMismatch/];
  /* RE-001: o cabecalho do arquivo responde 200 e a leitura do conteudo 403 ou 500: estoura, sem gravar (so o 404 e ausencia) */
  const BAIXA403 = [{ sdk: mundoDados(DADOS_VERDE, { dados: { blobs: DADOS_VERDE, falhaBaixa: 403 } }) }, chkEstoura('leitura do conteudo com 403'), /AuthorizationPermissionMismatch/];
  const BAIXA500 = [{ sdk: mundoDados(DADOS_VERDE, { dados: { blobs: DADOS_VERDE, falhaBaixa: 500 } }) }, chkEstoura('leitura do conteudo com 500'), /InternalError/];
  for (const [nome, X] of [['403 na leitura do conteudo (cabecalho 200)', BAIXA403], ['500 na leitura do conteudo (cabecalho 200)', BAIXA500]]) {
    const r = await roda(X[0]);
    const e = X[1](r);
    if (!e.length && !X[2].test(r.stderr)) e.push('estourou por outro motivo: ' + String(r.stderr).trim().split('\n').pop());
    if (!r.regs.some((x) => x.op === 'baixa' && x.conteiner === 'dados')) e.push('nem chegou a ler o conteudo (o mundo nao prova nada)');
    ok(!e.length, 'estoura sem gravar: ' + nome + (e.length ? ': ' + e.join(' | ') : ''));
  }
  /* RE-003: o dia da saida anterior e o de BRASILIA. (a) gerada as 02:00 UTC de 19/10 = 23:00 de 18/10 em Brasilia: outro dia, baixa
   * tudo. (b) o relogio as 00:30 de Brasilia de 20/10 (03:30 UTC) e a saida anterior as 23:45 de 19/10 (02:45 UTC de 20/10, o MESMO
   * dia em UTC): outro dia, baixa tudo, e o logger sai com o fim do proprio arquivo (19/10 03:00 UTC), nao o da saida anterior */
  const chkDiaBRT = (r) => {
    if (r.code !== 0 || !r.out) return ['o gerador nao terminou (codigo ' + r.code + '): ' + String(r.stderr).trim().split('\n').slice(-1)];
    const e = [];
    const baixados = r.regs.filter((x) => x.op === 'baixa' && x.conteiner === 'dados').map((x) => x.blob).sort();
    if (!igual(baixados, NOMES_C)) e.push('baixou ' + baixados.length + ' (esperado ' + NOMES_C.length + ', tudo)');
    const lg = r.out.frescor.find((x) => x.id === 'logger_disp');
    if (!lg || lg.ate !== FIM_D1) e.push('logger_disp com ate ' + (lg && lg.ate) + ' (esperado ' + FIM_D1 + ', o do arquivo)');
    return e;
  };
  const ANT_0200Z = { sdk: mundoDados(DADOS_VERDE, { 'portal-admin': { blobs: anterior('2026-10-19T02:00:00Z') } }) };
  const ANT_0030 = { agora: '2026-10-20T03:30:00Z', sdk: mundoDados(DADOS_VERDE, { 'portal-admin': { blobs: anterior('2026-10-20T02:45:00Z') } }) };
  for (const [nome, cen] of [['saida anterior das 02:00 UTC (23:00 de Brasilia do dia anterior)', ANT_0200Z], ['relogio as 00:30 de Brasilia, saida anterior do mesmo dia UTC', ANT_0030]]) {
    const e = chkDiaBRT(await roda(cen));
    ok(!e.length, 'o dia e o de Brasilia: ' + nome + ' -> baixa tudo' + (e.length ? ': ' + e.join(' | ') : ''));
  }
  {
    const r = await roda(ANT403[0]);
    const e = ANT403[1](r);
    if (!e.length && !ANT403[2].test(r.stderr)) e.push('estourou por outro motivo: ' + String(r.stderr).trim().split('\n').pop());
    ok(!e.length, 'estoura sem gravar: 403 ao ler a saida anterior (so o 404 do proprio arquivo e ausencia)' + (e.length ? ': ' + e.join(' | ') : ''));
  }

  console.log('3. plantios (cada um TEM de reprovar)');
  {   /* RE-005: a conferencia da lista aplicada ao proprio gerador mutante (sem o perdas_30), carregado pelo require */
    const Mx = require(mutante('vigia_lista_require', [[L_P30 + '\n', '']]));
    const fv = faltaVigia(Mx);
    ok(fv.join() === 'perdas_30' && Mx.FONTES.length === N_FONTES - 1, 'plantio reprovado: vigia: fonte nova fora da lista, pela conferencia da lista — falta ou difere ' + (fv.join(', ') || 'NADA (nao detectado)'));
  }
  const ANCORA_SEM = "  if (!S) return semTodas(ehHoje ? 'sem_estado_hoje' : null);";
  const OK_SEM_REGISTRO = "  if (!S) { const R = semTodas(null); for (const id of PONTE_ETAPAS) R[id] = { st: 'ok', motivo: null, ultima: null, ref_dia: null, n: {} }; return R; }";
  const PLANTIOS = [
    ['sem registro vira ok (mundo principal)', [[ANCORA_SEM, OK_SEM_REGISTRO]], PRINCIPAL, chkPrincipal],
    ['sem registro vira ok (sem fonte)', [[ANCORA_SEM, OK_SEM_REGISTRO]], {}, (r) => (ref ? chkSemFonte(r, ref) : ['sem referencia'])],
    ['sem registro vira ok, sem a guarda (sem fonte)', [[ANCORA_SEM, OK_SEM_REGISTRO], SEM_GUARDA], {}, (r) => (ref ? chkSemFonte(r, ref) : ['sem referencia'])],
    ['teste vence o diario', [["    if (modo === 'teste') continue;", "    if (modo === 'teste') return normaliza(j, 1, c.mod, onde);"]], PRINCIPAL, chkPrincipal],
    ['log na saida', [['    resultado: j.resultado,\n', '    resultado: j.resultado,\n    log: j.log,\n'],
      ['  R.ponte = { st: stP, motivo: moP, ultima: S.fim, ref_dia: dia, n: nPonte };', '  R.ponte = { st: stP, motivo: moP, ultima: S.fim, ref_dia: dia, n: Object.assign({ log: S.log }, nPonte) };']], PRINCIPAL, chkPrincipal],
    ['log na saida, sem a guarda', [['    resultado: j.resultado,\n', '    resultado: j.resultado,\n    log: j.log,\n'],
      ['  R.ponte = { st: stP, motivo: moP, ultima: S.fim, ref_dia: dia, n: nPonte };', '  R.ponte = { st: stP, motivo: moP, ultima: S.fim, ref_dia: dia, n: Object.assign({ log: S.log }, nPonte) };'], SEM_GUARDA], PRINCIPAL, chkPrincipal],
    ['nome de conteiner na saida', [['    R.cofre = { st: stC, motivo: moC,', '    R.cofre = { st: stC, motivo: moC || COFRE,']], PRINCIPAL, chkPrincipal],
    ['nome de conteiner na saida, sem a guarda', [['    R.cofre = { st: stC, motivo: moC,', '    R.cofre = { st: stC, motivo: moC || COFRE,'], SEM_GUARDA], PRINCIPAL, chkPrincipal],
    ['nome de blob na saida', [['    frescor: frescor.map((x) => ({ id: x.id,', '    frescor: frescor.map((x) => ({ blob: FONTES.find((f) => f.id === x.id).blob, id: x.id,']], PRINCIPAL, chkPrincipal],
    ['nome de blob na saida, sem a guarda', [['    frescor: frescor.map((x) => ({ id: x.id,', '    frescor: frescor.map((x) => ({ blob: FONTES.find((f) => f.id === x.id).blob, id: x.id,'], SEM_GUARDA], PRINCIPAL, chkPrincipal],
    ['frescor sem prazo', [['function prazoDe(agenda, wfs) { return prazoMin(cronsDe(agenda, wfs)); }', 'function prazoDe(agenda, wfs) { try { return prazoMin(cronsDe(agenda, wfs)); } catch (e) { return null; } }'], PRAZO_C_NULO],
      CENARIOS_ESTOURA.semPrazo[0], CENARIOS_ESTOURA.semPrazo[1]],
    ['frescor sem prazo, sem a guarda', [['function prazoDe(agenda, wfs) { return prazoMin(cronsDe(agenda, wfs)); }', 'function prazoDe(agenda, wfs) { try { return prazoMin(cronsDe(agenda, wfs)); } catch (e) { return null; } }'], PRAZO_C_NULO, SEM_GUARDA],
      CENARIOS_ESTOURA.semPrazo[0], CENARIOS_ESTOURA.semPrazo[1]],
    ['404 de conteiner tratado como ausencia', [['    const itens = await fonte.lista(dia);', '    const itens = await fonte.lista(dia).catch((e) => { if (e && e.statusCode === 404) return []; throw e; });']],
      CENARIOS_ESTOURA.cofre404[0], CENARIOS_ESTOURA.cofre404[1]],
    /* proc (malha-v2): vermelho com arquivo atrasado virando at; vermelho com arquivo no prazo virando fa */
    ['proc: parado vira at', [["  const st = parados ? 'fa' : verm ? 'at' : 'ok';", "  const st = verm ? 'at' : 'ok';"]],
      MP('vermelho nas 2 com o arquivo atrasado (ons)'), CP('vermelho nas 2 com o arquivo atrasado (ons)')],
    ['proc: atrasado nao conta como fora do prazo', [["    const fora = sts.some((s) => s !== 'ok');", "    const fora = sts.some((s) => s === 'fa' || s === 'sem');"]],
      MP('vermelho nas 2 com o arquivo atrasado (ons)'), CP('vermelho nas 2 com o arquivo atrasado (ons)')],
    ['proc: ausente nao conta como fora do prazo', [["    const fora = sts.some((s) => s !== 'ok');", "    const fora = sts.some((s) => s === 'at' || s === 'fa');"]],
      MP('vermelho nas 2 com o arquivo ausente (executivo)'), CP('vermelho nas 2 com o arquivo ausente (executivo)')],
    ['proc: regra antiga (vermelho nas 2 = fa, com o arquivo no prazo)', [['    if (fora && v === e.runs.length) parados++;', '    if (v === e.runs.length) parados++;']],
      MP('vermelho nas 2 com o arquivo no prazo (ppc)'), CP('vermelho nas 2 com o arquivo no prazo (ppc)')],
    ['proc: arquivo de outro workflow conta', [["    const fora = sts.some((s) => s !== 'ok');", "    const fora = [...stDe.values()].some((s) => s !== 'ok');"]],
      MP('vermelho nas 2 com o arquivo no prazo (ppc)'), CP('vermelho nas 2 com o arquivo no prazo (ppc)')],
    ['proc: workflow sem arquivo no frescor vira fa', [['    if (!sts.length) continue;', '    if (!sts.length) { if (v === e.runs.length) parados++; continue; }']],
      MP('vermelho nas 2 sem arquivo no frescor (must-intra)'), CP('vermelho nas 2 sem arquivo no frescor (must-intra)')],
    ['proc: vermelho em 1 das 2 com arquivo ausente vira fa', [['    if (fora && v === e.runs.length) parados++;', '    if (fora) parados++;']], PRINCIPAL, chkPrincipal],
    /* malha-frescor-conteudo: o frescor volta a ser so a gravacao; conteudo ilegivel cai na gravacao; a pior medida nao vence; a saida
     * anterior reaproveitada com outra gravacao ou de outro dia; 403 na saida anterior como ausencia; o arquivo grande baixado */
    ['conteudo: so a gravacao (a regra antiga)', [['    if (!f.conteudo) return Object.assign(base, {', '    if (true) return Object.assign(base, {']],
      MC('congelado em 14/10, regravado hoje'), SO_CONGELADOS],
    ['conteudo: ilegivel vira a gravacao', [['    if (E == null) { conta.ilegiveis.push(f.id);', '    if (E == null) E = tG;\n    if (E == null) { conta.ilegiveis.push(f.id);']],
      MC('conteudo ilegivel'), CC('conteudo ilegivel')],
    ['conteudo: a pior medida nao vence', [['    const peloConteudo = cIdade / cPrazo >= gIdade / prazos[i];', '    const peloConteudo = true;']], PRINCIPAL, chkPrincipal],
    ['conteudo: saida anterior com outra gravacao reaproveitada', [['      if (a && a.gravado === isoZ(tG)) {', '      if (a) {']],
      MC('saida anterior do mesmo dia'), CC('saida anterior do mesmo dia')],
    ['conteudo: saida anterior de outro dia reaproveitada', [[' || diaBRT(Date.parse(j.gerado)) !== diaBRT(agoraMs)', '']],
      MC('saida anterior de outro dia'), CC('saida anterior de outro dia')],
    ['conteudo: 403 na saida anterior vira ausencia', [["    if (e && e.statusCode === 404 && cod === 'BlobNotFound') return null;\n    throw e;\n  }\n  let j;", '    return null;\n  }\n  let j;']],
      ANT403[0], ANT403[1]],
    /* revisao do ensaio (RE-001, RE-003) */
    ['conteudo: 403 na leitura do conteudo vira ausencia', [['        const x = await LD.pede(LD.BASE + f.blob);', '        const x = await LD.pede(LD.BASE + f.blob).catch(() => ({ status: 404 }));']],
      BAIXA403[0], BAIXA403[1]],
    ['conteudo: 500 na leitura do conteudo vira ausencia', [['        const x = await LD.pede(LD.BASE + f.blob);', '        const x = await LD.pede(LD.BASE + f.blob).catch(() => ({ status: 404 }));']],
      BAIXA500[0], BAIXA500[1]],
    ['conteudo: o dia da saida anterior pelo UTC (02:00 UTC)', [['diaBRT(Date.parse(j.gerado)) !== diaBRT(agoraMs)', 'String(j.gerado).slice(0, 10) !== new Date(agoraMs).toISOString().slice(0, 10)']],
      ANT_0200Z, chkDiaBRT],
    ['conteudo: o dia da saida anterior pelo UTC (00:30 de Brasilia)', [['diaBRT(Date.parse(j.gerado)) !== diaBRT(agoraMs)', 'String(j.gerado).slice(0, 10) !== new Date(agoraMs).toISOString().slice(0, 10)']],
      ANT_0030, chkDiaBRT],
    ['conteudo: baixa tambem o que vai pela gravacao', [['    if (f.conteudo) {\n      const a = anterior', '    if (f.conteudo || f.blob) {\n      const a = anterior']], PRINCIPAL, chkPrincipal],
    /* malha-vigia-mais */
    ['vigia: fonte nova fora da lista', [[L_P30 + '\n', '']], PRINCIPAL, chkPrincipal],
    ['vigia: os do supervisorio pela gravacao', [L_P30, L_P60, L_SE, L_ISH].map((l) => [l, l.replace(/conteudo: .*\},$/, 'conteudo: null },')]),
      MC(K_SUP), CC(K_SUP)],
    ['vigia: o trafo pelo supervisorio', [[L_MED, L_MED.replace('j.medidor_ate', 'j.supervisorio_ate')]], MC(K_SUP), CC(K_SUP)],
    ['vigia: o trafo pelo fim da serie', [[L_MED, L_MED.replace('instante(j.medidor_ate)', 'ultimo(j.serie, (x) => instante(x.t))')]], MC(K_MED), CC(K_MED)],
    ['vigia: a hora de 60 min com 30', [[L_HORA, L_HORA.replace('[campo])), 60);', '[campo])), 30);')]], MC(K_SUP), CC(K_SUP)],
  ];
  /* Barrado pela guarda do gerador so conta se a mensagem dela NOMEIA o defeito plantado (senao a guarda pode ter barrado
   * outra coisa e o plantio nao provou nada). Sem a guarda, quem tem de barrar e a checagem deste ensaio. */
  const MARCA_GUARDA = {
    'sem registro vira ok (sem fonte)': /sem registro \(ultima nula\)/,
    'log na saida': /"log"|log\/obs/,
    'nome de conteiner na saida': /nome de conteiner/,
    'nome de blob na saida': /"blob"|nome de arquivo/,
    'frescor sem prazo': /sem prazo_min/,
  };
  for (const [nome, trocas, cen, chk] of PLANTIOS) {
    const script = mutante(nome.replace(/[^a-z0-9]+/gi, '_'), trocas);
    const r = await roda(Object.assign({}, cen, { script }));
    const e = chk(r);
    const guarda = /NAO gravado — /.test(r.stderr);
    const marca = MARCA_GUARDA[nome];
    let reprovado = false, como = 'PASSOU (defeito nao detectado)';
    if (guarda && marca) {
      const linha = String(r.stderr).split('\n').find((l) => marca.test(l));
      reprovado = !!linha;
      como = linha ? 'pela guarda do gerador: ' + linha.trim().slice(0, 100) : 'a guarda barrou, mas por outro motivo: ' + String(r.stderr).trim().split('\n').slice(0, 2).join(' | ');
    } else if (!guarda && e.length) {
      reprovado = true;
      como = 'pela checagem do ensaio: ' + e[0].slice(0, 120);
    } else if (guarda) como = 'a guarda barrou sem marca declarada: ' + String(r.stderr).trim().split('\n').slice(0, 2).join(' | ');
    ok(reprovado, 'plantio reprovado: ' + nome + ' — ' + como);
  }
}

(async () => {
  try {
    await new Promise((res) => servidor.listen(0, '127.0.0.1', () => { PORTA = servidor.address().port; res(); }));
    await regras();
    await processos();
  } catch (e) {
    console.error('FALHA: o ensaio estourou: ' + (e && e.stack ? e.stack : e));
    falhas++;
  } finally {
    servidor.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* temporario */ }
  }
  console.log(falhas ? '\nensaio-malha-estado: ' + falhas + ' FALHA(S)' : '\nensaio-malha-estado: tudo certo');
  process.exit(falhas ? 1 : 0);
})();
