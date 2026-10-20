'use strict';
/*
 * gen-malha-estado.js — o estado da malha de dados para a pagina Malha de Dados do Portal Corporativo (lote malha-estado, 19/10/2026).
 *
 * Publica `malha_estado.json` (versao 1 do contrato da pagina) no conteiner PRIVADO do portal admin, em gzip. A pagina le pela
 * rota admin do portal; ela nunca le o cofre nem a agenda. O texto fixo de cada etapa (o que faz, quando) mora na PAGINA,
 * traduzivel: este arquivo so traz estado, datas ISO UTC, numeros e CODIGOS.
 *
 * De onde vem cada estado (a tabela do contrato):
 *   · estado da ponte: os registros do dia que a ponte grava no cofre (`Ponte/estado/`), 15 ultimos dias. Vale, por dia, o
 *     arquivo MAIS NOVO com `modo` = "diario"; o de teste nunca vence. Arquivo sem `modo` (ate 18/10) = diario de versao 0,
 *     SEM o bloco `fontes`: as etapas que dependem dele saem "sem". Dia sem arquivo = "n" no historico;
 *   · frescor: a data de gravacao (cabecalho, lib-le-dados) dos arquivos que o portal le, contra o PRAZO = 2 periodos do
 *     agendamento do workflow que grava cada um, lido da agenda do relogio (`relogio/agenda.json`); workflow que roda uma vez
 *     por dia = 26 h. E a fonte nomeada do limiar: a propria agenda. ok <= prazo, at <= 2 x prazo, fa acima, sem = nao existe;
 *   · execucoes do GitHub Actions: as 2 ultimas execucoes CONCLUIDAS de cada workflow da agenda (API REST, GITHUB_TOKEN),
 *     cruzadas com o frescor do que cada workflow grava: `proc` so e `fa` quando um workflow de producao PAROU DE GRAVAR
 *     (vermelho nas 2 ultimas e arquivo dele fora do prazo); vermelho que segue gravando e ressalva (lote malha-v2, etapaProc);
 *   · o que e declarado por lote (Power Automate, backup local, PC, aviso): constantes abaixo, nada lido de API.
 *
 * 🔴 NADA INVENTADO: etapa sem registro sai `st: "sem"` e "n" no historico, NUNCA ok. Etapa ok/at/fa tem de ter `ultima`.
 * 🔴 O COFRE E SO LEITURA: o conteiner do cofre tem retencao imutavel. Este gerador so LISTA e BAIXA ali; a unica gravacao e
 *    no conteiner do portal admin. Nenhum conteiner e criado.
 * 🔴 SO O 404 DO PROPRIO BLOB E AUSENCIA. Conteiner que nao existe (404 ContainerNotFound), 403, 409, 5xx, rede: ESTOURA.
 * 🔴 TEXTO PUBLICO: nenhum IP, servidor, conta, conteiner, blob, credencial ou caminho na saida. O `log` e o `obs` do estado
 *    da ponte NUNCA entram. A guarda `confere()` roda antes de gravar e aborta SEM GRAVAR: chave fora do contrato, valor de
 *    texto fora da lista (codigos, ids, datas), prazo ausente, ok sem registro.
 *
 * Env: DADOS_STORAGE (connection string da conta: le o cofre e o frescor pelo SDK, grava o resultado)
 *      GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_API_URL (o Actions define os dois ultimos; sem token, `proc` e `portal` saem "sem")
 *      LOCAL_OUT (arquivo: grava ali, em JSON legivel, em vez do blob)
 *      LOCAL_PONTE_DIR (pasta com arquivos de estado da ponte, AAAA-MM-DD[_HHMMSS].json: substitui a leitura do cofre)
 *      Sem DADOS_STORAGE e sem LOCAL_PONTE_DIR as etapas da ponte saem "sem" (nunca ok); o frescor le o publico, com aviso.
 *      So para o ensaio: AGENDA_JSON (outra agenda), MALHA_AGORA (instante ISO no lugar do relogio).
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');
const LD = require('./lib-le-dados');

const COFRE = 'backup-dados-scada';          // SO LEITURA (retencao imutavel)
const DESTINO = 'portal-admin';              // conteiner privado do portal admin; ja existe, nao se cria
const OUT_BLOB = 'malha_estado.json';
const PREFIXO_ESTADO = 'Ponte/estado/';
const RE_NOME = /^Ponte\/estado\/(\d{4}-\d{2}-\d{2})(?:_(\d{6}))?\.json$/;
const DIAS_LISTA = 15;                       // dias listados no cofre (hoje e os 14 anteriores)
const DIAS_H = 14;                           // tamanho do historico `h`
const BRT_MS = 3 * 3600000;                  // Brasilia, UTC-3 (sem horario de verao desde 2019)
const DIARIO_MIN = 26 * 60;                  // prazo de workflow que roda uma vez por dia (contrato)
const PONTE_LIGA_BRT = { h: 5, m: 55 };      // o agendador da ponte liga a maquina as 05:55 de Brasilia, todo dia

/* 🔴 POWER AUTOMATE: estado DECLARADO, atualizado a cada lote do plano de desligar o Power Automate (nada e lido da API dele).
 *    Ao desligar um fluxo, tirar o nome daqui no MESMO lote e mudar `atualizado`. */
const PA = {
  fluxos: ['Sungrow OneDrive RB para Blob', 'Inversores PWC → Blob → Grafana', 'SCADA SharePoint para Blob'],
  fim_licenca: '2026-11-09',
  atualizado: '2026-10-20',   // pa-way2-mes: o "Way2 → Azure Blob Sync" saiu (o way2-mes.yml grava)
};
/* As outras etapas declaradas (contrato, decisoes de 19/10/2026). `desde` = primeiro dia do historico com a letra declarada;
 * antes dele nao ha registro ("n"). aviso: o pipeline nao le o agendador do aviso (sem); local: backup local em implantacao
 * ate existir registro (plan); pc: o computador sai do caminho (des); pa: detalhe no bloco `pa` (des). */
const DECLARADAS = {
  aviso: { st: 'sem', desde: null },
  local: { st: 'plan', desde: '2026-10-19' },
  pc: { st: 'des', desde: '2026-10-19' },
  pa: { st: 'des', desde: '2026-10-19' },
};
/* O deploy do portal NAO roda no GitHub Actions: o Portal Corporativo e publicado da maquina do humano (CLI do Static Web
 * Apps). O unico workflow azure-static-web-apps-*.yml deste repositorio publica o site APOSENTADO em 18/10/2026, entao ler a
 * execucao dele como "deploy do portal" seria mentir. Ate o deploy do portal ganhar registro legivel, `portal` sai "sem". */

/* Os arquivos do conteiner de dados que o portal le, com o workflow que GRAVA cada um (lido nos geradores em 19/10/2026).
 * `id` e a chave publica da fonte (a pagina traduz); nunca o nome do arquivo.
 * Ficaram FORA, porque a data de gravacao nao mede a execucao: os que so regravam quando o conteudo muda (dia em curso por
 * hora, comparativo de fontes, MUST de 5/15 min e o diario), o historico do portal (grava uma vez por dia, so quando fecha
 * ontem; o cron e repescagem), o oleo (por campanha, sem agenda), os recortes por usina e por mes (o agregado os representa)
 * e as imagens dos paineis. */
const FONTES = [
  { id: 'medidor_5min', etapa: 'way2', blob: 'way2_recent.json', wf: ['way2-recent.yml'] },
  { id: 'ons_restricao', etapa: 'ons', blob: 'ons_restricao_all.json', wf: ['ons-consolidado.yml'] },
  { id: 'visao_executiva', etapa: 'pub', blob: 'executivo.json', wf: ['executivo.yml'] },
  { id: 'ao_vivo', etapa: 'pub', blob: 'portal_vivo.json', wf: ['way2-recent.yml'] },
  { id: 'ao_vivo_eletrico', etapa: 'pub', blob: 'portal_eletrico.json', wf: ['way2-recent.yml'] },
  { id: 'selo_medidores', etapa: 'pub', blob: 'way2_saude.json', wf: ['way2-recent.yml'] },
  { id: 'assistente_om', etapa: 'pub', blob: 'agente_om.json', wf: ['way2-recent.yml'] },
  { id: 'assistente_dia', etapa: 'pub', blob: 'agente_dia.json', wf: ['estacao-logger.yml', 'sungrow.yml', 'way2-hist.yml'] },
  { id: 'selos_fontes', etapa: 'pub', blob: 'fontes_saude.json', wf: ['way2-agg.yml'] },
  { id: 'benchmark_ne', etapa: 'pub', blob: 'benchmark_ne.json', wf: ['executivo.yml'] },
  { id: 'referencia_hora', etapa: 'pub', blob: 'ref_hora.json', wf: ['executivo.yml'] },
  { id: 'perfil_recente', etapa: 'pub', blob: 'perfil_recente.json', wf: ['executivo.yml'] },
  { id: 'pr', etapa: 'pub', blob: 'pr.json', wf: ['executivo.yml'] },
  { id: 'pr_usina', etapa: 'pub', blob: 'pr_ufv.json', wf: ['executivo.yml'] },
  { id: 'pr_hora', etapa: 'pub', blob: 'pr_hora.json', wf: ['executivo.yml'] },
  { id: 'corte_gemeo', etapa: 'pub', blob: 'corte_gemeo.json', wf: ['ons-consolidado.yml'] },
  { id: 'ons_indicadores', etapa: 'pub', blob: 'ons_kpis.json', wf: ['ons-consolidado.yml'] },
  { id: 'estacao_30min', etapa: 'pub', blob: 'estacao_logger_30min.json', wf: ['estacao-logger.yml'] },
  { id: 'estacao_dia', etapa: 'pub', blob: 'estacao_dia.json', wf: ['estacao-logger.yml'] },
  { id: 'perdas_inversor', etapa: 'pub', blob: 'perdas_inv_scada.json', wf: ['perdas.yml'] },   // supervisorio; o perdas_inv.json e do logger (sungrow.yml) desde 19/10/2026
  { id: 'perdas_dia', etapa: 'pub', blob: 'perdas_diario_scada.json', wf: ['perdas.yml'] },   // idem, fonte-inv-logger
  { id: 'inversores_scada', etapa: 'pub', blob: 'inv_scada_supervisorio.json', wf: ['inv-scada.yml'] },   // o inv_scada.json e do logger (sungrow.yml)
  { id: 'inversores_registro', etapa: 'pub', blob: 'inversores.json', wf: ['inversores.yml'] },
  { id: 'ativos', etapa: 'pub', blob: 'portal_ativos.json', wf: ['inversores.yml'] },
  { id: 'registro_mesa', etapa: 'pub', blob: 'ppc_restricao.json', wf: ['ppc.yml'] },
  { id: 'sager_disp', etapa: 'pub', blob: 'sager_disp_30min.json', wf: ['sager-disp.yml'] },
  { id: 'logger_saude', etapa: 'pub', blob: 'sg_saude.json', wf: ['sungrow.yml'] },
  { id: 'logger_disp', etapa: 'pub', blob: 'sg_disp_dia.json', wf: ['sungrow.yml'] },
  { id: 'supervisorio', etapa: 'pub', blob: 'portal_scada.json', wf: ['scada.yml'] },
  { id: 'trafo_dia', etapa: 'pub', blob: 'trafo_diario.json', wf: ['trafo.yml'] },
  { id: 'medidor_dia', etapa: 'pub', blob: 'way2_daily.json', wf: ['way2-hist.yml'] },
];

const ETAPAS = ['inv', 'est', 'scada', 'vm', 'vpn', 'ponte', 'aviso', 'local', 'cofre', 'pc', 'onedrive', 'pa', 'way2', 'ons', 'proc', 'pub', 'portal'];
const PONTE_ETAPAS = ['inv', 'est', 'scada', 'vm', 'vpn', 'ponte', 'cofre', 'onedrive'];
const ST = ['ok', 'at', 'fa', 'des', 'plan', 'sem'];
const LETRA = { ok: 'o', at: 'a', fa: 'f', des: 'd', plan: 'p', sem: 'n' };
const CODIGOS = ['sem_estado_hoje', 'sem_fontes_v0', 'ponte_falhou', 'ponte_tentativas', 'fonte_falha', 'fonte_ressalva', 'atrasado',
  'muito_atrasado', 'workflow_vermelho', 'workflow_vermelho_grava', 'deploy_falhou', 'ponte_inicio', 'ponte_fim', 'cofre_gravou', 'onedrive_gravou',
  'coleta_inversores', 'processamento', 'publicacao'];
/* os numeros da linha "resultado" de cada etapa (contrato); nada fora disto entra em `n` */
const N_PERMITIDO = {
  inv: ['arquivos', 'mb'], est: ['arquivos', 'mb'], scada: ['arquivos', 'mb'], vm: ['arquivos'], vpn: [],
  ponte: ['arquivos', 'mb', 'tentativas'], aviso: [], local: [], cofre: ['gravados', 'mb'], pc: [], onedrive: ['gravados'],
  pa: ['restam'], way2: ['idade_min'], ons: ['idade_min'], proc: ['ok', 'total', 'vermelhos', 'parados'], pub: ['no_prazo', 'total'], portal: [],
};
/* as fontes do bloco `fontes` do estado da ponte que este gerador usa (as outras, o espelho, nao viram etapa) */
const FONTES_PONTE = ['inversores', 'estacoes', 'scada_db', 'cofre', 'onedrive'];
const RES_FONTE = ['ok', 'ressalva', 'falha'];
/* conclusoes do GitHub: vermelho = falhou; cancelada/pulada nao conta como nenhum dos dois */
const GH_OK = ['success'], GH_VERMELHO = ['failure', 'timed_out', 'startup_failure'];
const GH_NEUTRO = ['cancelled', 'skipped', 'neutral', 'action_required', 'stale'];

/* ───────────── tempo ───────────── */
const isoZ = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const diaBRT = (ms) => new Date(ms - BRT_MS).toISOString().slice(0, 10);
const somaDias = (dia, k) => new Date(Date.parse(dia + 'T00:00:00Z') + k * 86400000).toISOString().slice(0, 10);
function paraIso(v, onde) {
  if (v == null || v === '') return null;
  const t = Date.parse(v);
  if (!isFinite(t)) throw new Error('data ilegivel em ' + onde);
  return isoZ(t);
}
const r1 = (x) => Math.round(x * 10) / 10;
const num = (x) => (typeof x === 'number' && isFinite(x) ? x : null);

/* ───────────── agenda: prazo e proxima execucao ───────────── */
function expande(campo, max) {
  const out = new Set();
  for (const parte of String(campo).split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(parte);
    if (!m) throw new Error('agenda: campo de cron nao reconhecido "' + campo + '"');
    let a, b;
    if (m[1] === '*') { a = 0; b = max - 1; } else { a = +m[2]; b = m[3] != null ? +m[3] : (m[4] ? max - 1 : a); }
    const passo = m[4] ? +m[4] : 1;
    if (a > b || b >= max || passo < 1) throw new Error('agenda: campo de cron fora da faixa "' + campo + '"');
    for (let x = a; x <= b; x += passo) out.add(x);
  }
  return [...out];
}
/* NCRONTAB do relogio (6 campos, UTC): os minutos do dia em que dispara. Dia, mes e semana tem de ser '*': o prazo por
 * periodo diario nao vale para agenda semanal ou mensal, e e melhor estourar do que inventar um prazo. */
function minutosDoDia(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 6 || f[0] !== '0') throw new Error('agenda: cron fora do formato do relogio "' + expr + '"');
  if (f[3] !== '*' || f[4] !== '*' || f[5] !== '*') throw new Error('agenda: cron com dia/mes/semana nao tem prazo por periodo "' + expr + '"');
  const out = [];
  for (const h of expande(f[2], 24)) for (const m of expande(f[1], 60)) out.push(h * 60 + m);
  return out;
}
function instantes(crons) {
  const T = [...new Set(crons.flatMap(minutosDoDia))].sort((a, b) => a - b);
  if (!T.length) throw new Error('agenda: nenhum disparo');
  return T;
}
/* 2 periodos: o maior intervalo entre um disparo e o SEGUNDO seguinte (agenda irregular, ex.: de hora em hora so de dia);
 * uma vez por dia = 26 h (contrato). */
function prazoMin(crons) {
  const T = instantes(crons);
  if (T.length === 1) return DIARIO_MIN;
  const g = T.map((t, i) => (i + 1 < T.length ? T[i + 1] : T[0] + 1440) - t);
  let mx = 0;
  for (let i = 0; i < g.length; i++) mx = Math.max(mx, g[i] + g[(i + 1) % g.length]);
  return mx;
}
function cronsDe(agenda, wfs) {
  const out = [];
  for (const w of wfs) {
    const c = agenda[w];
    if (!Array.isArray(c) || !c.length) throw new Error('sem prazo: ' + w + ' nao esta na agenda do relogio');
    out.push(...c);
  }
  return out;
}
function prazoDe(agenda, wfs) { return prazoMin(cronsDe(agenda, wfs)); }
function proximo(crons, agoraMs) {
  const T = instantes(crons);
  const d0 = Date.parse(new Date(agoraMs).toISOString().slice(0, 10) + 'T00:00:00Z');
  for (let k = 0; k < 2; k++) for (const t of T) { const ms = d0 + k * 86400000 + t * 60000; if (ms > agoraMs) return ms; }
  throw new Error('agenda: sem proximo disparo');
}
function proximaPonte(agoraMs) {
  const d = diaBRT(agoraMs);
  let ms = Date.parse(d + 'T00:00:00Z') + (PONTE_LIGA_BRT.h * 60 + PONTE_LIGA_BRT.m) * 60000 + BRT_MS;
  if (ms <= agoraMs) ms += 86400000;
  return ms;
}

/* ───────────── frescor ───────────── */
function estadoFrescor(idadeMin, prazo) {
  if (idadeMin == null) return 'sem';
  return idadeMin <= prazo ? 'ok' : idadeMin <= 2 * prazo ? 'at' : 'fa';
}
async function leFrescor(agenda, agoraMs) {
  const prazos = FONTES.map((f) => prazoDe(agenda, f.wf));           // estoura antes de ler: fonte sem prazo nao e publicada
  const cab = await Promise.all(FONTES.map((f) => LD.cabecalho(LD.BASE + f.blob)));
  return FONTES.map((f, i) => {
    const h = cab[i];
    if (h.status === 404) return { id: f.id, etapa: f.etapa, idade_min: null, prazo_min: prazos[i], st: 'sem', _t: null };
    if (h.status !== 200) throw new Error('frescor ' + f.id + ': resposta ' + h.status);
    const t = Date.parse(h.ultimaMod);
    if (!isFinite(t)) throw new Error('frescor ' + f.id + ': sem data de gravacao');
    const idade = Math.max(0, (agoraMs - t) / 60000);
    return { id: f.id, etapa: f.etapa, idade_min: Math.round(idade), prazo_min: prazos[i], st: estadoFrescor(idade, prazos[i]), _t: t };
  });
}

/* ───────────── estado da ponte ───────────── */
function fonteCofre() {
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cont = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(COFRE);
  return {
    async lista(dia) {
      const out = [];
      for await (const b of cont.listBlobsFlat({ prefix: PREFIXO_ESTADO + dia })) {
        out.push({ nome: b.name, mod: b.properties && b.properties.lastModified ? +new Date(b.properties.lastModified) : null });
      }
      return out;
    },
    async le(nome) {
      try {
        const r = await cont.getBlobClient(nome).download();
        const p = [];
        for await (const c of r.readableStreamBody) p.push(c);
        return Buffer.concat(p);
      } catch (e) {
        const cod = (e && (e.code || (e.details && e.details.errorCode))) || '';
        if (e && e.statusCode === 404 && cod === 'BlobNotFound') return null;     // listado e sumiu: ausencia; o resto estoura
        throw e;
      }
    },
  };
}
function fontePasta(dir) {
  const nomes = fs.readdirSync(dir);                                   // pasta que nao existe estoura (configuracao errada)
  return {
    async lista(dia) {
      return nomes.filter((n) => n.startsWith(dia)).map((n) => ({ nome: PREFIXO_ESTADO + n, mod: +fs.statSync(path.join(dir, n)).mtime }));
    },
    async le(nome) { return fs.readFileSync(path.join(dir, nome.slice(PREFIXO_ESTADO.length))); },
  };
}
function parseEstado(buf, onde) {
  const b = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf;
  try { return JSON.parse(b.toString('utf8').replace(/^﻿/, '')); } catch (e) { throw new Error('estado da ponte ilegivel: ' + onde); }
}
function normaliza(j, versao, mod, onde) {
  if (j.resultado !== 'ok' && j.resultado !== 'falhou') throw new Error('estado da ponte com resultado desconhecido em ' + onde);
  const S = {
    versao,
    resultado: j.resultado,
    tentativas: num(j.tentativas),
    inicio: paraIso(j.ciclo && j.ciclo.inicio, onde),
    fim: paraIso(j.ciclo && j.ciclo.fim, onde) || (mod ? isoZ(mod) : null),
    fontes: null,
  };
  if (versao === 1 && j.fontes) {
    if (j.fontes.versao !== 1) throw new Error('bloco fontes com versao desconhecida em ' + onde);
    S.fontes = {};
    for (const k of FONTES_PONTE) {
      const f = j.fontes[k];
      if (!f || typeof f !== 'object') throw new Error('bloco fontes sem ' + k + ' em ' + onde);
      if (!RES_FONTE.includes(f.resultado)) throw new Error('fonte ' + k + ' com resultado desconhecido em ' + onde);
      /* so os campos do contrato; `obs` NUNCA */
      S.fontes[k] = { resultado: f.resultado, fim: paraIso(f.fim, onde) || S.fim, arquivos_vm: num(f.arquivos_vm),
        azure_novos: num(f.azure_novos), azure_mb: num(f.azure_mb), onedrive: num(f.onedrive) };
    }
  }
  return S;
}
async function escolheDiario(itens, dia, le) {
  const cand = itens.map((it) => {
    const m = RE_NOME.exec(it.nome);
    if (!m || m[1] !== dia) throw new Error('estado da ponte com nome fora do formato: ' + String(it.nome).slice(PREFIXO_ESTADO.length));
    return { nome: it.nome, mod: it.mod, hora: m[2] || '' };
  }).sort((a, b) => b.hora.localeCompare(a.hora) || ((b.mod || 0) - (a.mod || 0)));
  for (const c of cand) {
    const buf = await le(c.nome);
    if (!buf) continue;
    const onde = c.nome.slice(PREFIXO_ESTADO.length);
    const j = parseEstado(buf, onde);
    if (j.dia != null && j.dia !== dia) throw new Error('estado da ponte de outro dia no nome ' + onde);   // o dia sai do conteudo
    const modo = j.modo;
    if (modo === 'teste') continue;
    if (modo !== undefined && modo !== 'diario') throw new Error('estado da ponte com modo desconhecido em ' + onde);
    return normaliza(j, modo === undefined ? 0 : 1, c.mod, onde);
  }
  return null;
}
async function estadosPorDia(fonte, hoje) {
  const por = {};
  for (let k = DIAS_LISTA - 1; k >= 0; k--) {
    const dia = somaDias(hoje, -k);
    if (!fonte) { por[dia] = null; continue; }
    const itens = await fonte.lista(dia);
    por[dia] = await escolheDiario(itens, dia, fonte.le);
  }
  return por;
}
const stFonte = (r) => (r === 'ok' ? ['ok', null] : r === 'ressalva' ? ['at', 'fonte_ressalva'] : ['fa', 'fonte_falha']);
function semTodas(motivo) {
  const R = {};
  for (const id of PONTE_ETAPAS) R[id] = { st: 'sem', motivo, ultima: null, ref_dia: null, n: {} };
  return R;
}
/* As etapas da ponte num dia. `ref_dia`: as fontes da usina trazem o que a VM exportou de madrugada, que cobre o dia
 * anterior ao do ciclo; a ponte, o cofre e o OneDrive sao o proprio ciclo. */
function etapasPonte(S, dia, ehHoje) {
  if (!S) return semTodas(ehHoje ? 'sem_estado_hoje' : null);
  const R = semTodas('sem_fontes_v0');
  const ontem = somaDias(dia, -1);
  const F = S.fontes;
  const nPonte = {};
  if (S.tentativas != null) nPonte.tentativas = S.tentativas;
  if (F) {
    const us = ['inversores', 'estacoes', 'scada_db'].map((k) => F[k]);
    const arq = us.map((f) => f.arquivos_vm).filter((x) => x != null);
    const mb = us.map((f) => f.azure_mb).filter((x) => x != null);
    if (arq.length) nPonte.arquivos = arq.reduce((a, b) => a + b, 0);
    if (mb.length) nPonte.mb = r1(mb.reduce((a, b) => a + b, 0));
    const usina = (id, f) => {
      const [st, motivo] = stFonte(f.resultado);
      const n = {};
      if (f.arquivos_vm != null) n.arquivos = f.arquivos_vm;
      if (f.azure_mb != null) n.mb = r1(f.azure_mb);
      R[id] = { st, motivo, ultima: f.fim, ref_dia: ontem, n };
    };
    usina('inv', F.inversores); usina('est', F.estacoes); usina('scada', F.scada_db);
    const rs = us.map((f) => f.resultado);
    const [stVm, moVm] = rs.every((r) => r === 'falha') ? ['fa', 'fonte_falha'] : rs.includes('falha') ? ['at', 'fonte_falha']
      : rs.includes('ressalva') ? ['at', 'fonte_ressalva'] : ['ok', null];
    const fimVm = us.map((f) => f.fim).filter(Boolean).sort().pop() || S.fim;
    R.vm = { st: stVm, motivo: moVm, ultima: fimVm, ref_dia: ontem, n: nPonte.arquivos != null ? { arquivos: nPonte.arquivos } : {} };
    R.vpn = { st: stVm, motivo: moVm, ultima: fimVm, ref_dia: dia, n: {} };      // a ponte so chega a VM pela VPN
    const [stC, moC] = stFonte(F.cofre.resultado);
    const nC = {};
    if (F.cofre.azure_novos != null) nC.gravados = F.cofre.azure_novos;
    if (F.cofre.azure_mb != null) nC.mb = r1(F.cofre.azure_mb);
    R.cofre = { st: stC, motivo: moC, ultima: F.cofre.fim, ref_dia: dia, n: nC };
    const [stO, moO] = stFonte(F.onedrive.resultado);
    R.onedrive = { st: stO, motivo: moO, ultima: F.onedrive.fim, ref_dia: dia, n: F.onedrive.onedrive != null ? { gravados: F.onedrive.onedrive } : {} };
  }
  const [stP, moP] = S.resultado === 'falhou' ? ['fa', 'ponte_falhou'] : (S.tentativas != null && S.tentativas > 1) ? ['at', 'ponte_tentativas'] : ['ok', null];
  R.ponte = { st: stP, motivo: moP, ultima: S.fim, ref_dia: dia, n: nPonte };
  return R;
}

/* ───────────── GitHub Actions ───────────── */
function gh(url, tk) {
  const mod = url.startsWith('http:') ? http : https;
  return new Promise((ok, erro) => {
    const req = mod.get(url, { headers: { Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'gen-malha-estado' } }, (r) => {
      const p = [];
      r.on('data', (c) => p.push(c));
      r.on('error', erro);
      r.on('end', () => {
        if (r.statusCode !== 200) return erro(new Error('GitHub HTTP ' + r.statusCode + ' ' + url.split('?')[0].replace(/^.*\/actions\//, 'actions/')));
        try { ok(JSON.parse(Buffer.concat(p).toString('utf8'))); } catch (e) { erro(new Error('GitHub: resposta ilegivel')); }
      });
    });
    req.on('error', erro);
    req.setTimeout(30000, () => req.destroy(new Error('GitHub: timeout')));
  });
}
async function leExecucoes(agenda) {
  const tk = process.env.GITHUB_TOKEN;
  if (!tk) return null;
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPOSITORY nao definido');
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  return Promise.all(Object.keys(agenda).sort().map(async (wf) => {
    const j = await gh(api + '/repos/' + repo + '/actions/workflows/' + encodeURIComponent(wf) + '/runs?status=completed&per_page=2&exclude_pull_requests=true', tk);
    const runs = await Promise.all((j.workflow_runs || []).slice(0, 2).map(async (r) => {
      let c = r.conclusion;
      if (![...GH_OK, ...GH_VERMELHO, ...GH_NEUTRO].includes(c)) throw new Error('GitHub: conclusao desconhecida em ' + wf);
      if (GH_VERMELHO.includes(c) && CONFERENCIAS_FORA[wf]) c = await semConferenciaFora(api, repo, tk, r.id, CONFERENCIAS_FORA[wf], c);
      return { c, t: Date.parse(r.updated_at) };
    }));
    return { wf, runs };
  }));
}
/* malha-sem-mesa (19/10/2026, decisão do humano): conferências que NÃO entram na Malha de Dados. A auditoria do registro da mesa de
 * operação contra o ONS reprova por divergência de dado real, e isso vai para um painel próprio; aqui, uma execução vermelha SÓ por
 * esses passos conta como verde. Qualquer outro passo vermelho no mesmo workflow continua vermelho. */
const CONFERENCIAS_FORA = { 'ons-consolidado.yml': ['Auditar o registro do PPC contra o ONS'] };
async function semConferenciaFora(api, repo, tk, runId, passos, c) {
  const jj = await gh(api + '/repos/' + repo + '/actions/runs/' + runId + '/jobs?per_page=50', tk);
  const falhos = [];
  for (const job of jj.jobs || []) {
    const st = (job.steps || []).filter((s) => GH_VERMELHO.includes(s.conclusion)).map((s) => s.name);
    if (GH_VERMELHO.includes(job.conclusion) && !st.length) return c;   // job vermelho sem passo vermelho (cancelado, sem runner): fica vermelho
    falhos.push(...st);
  }
  return falhos.length && falhos.every((n) => passos.includes(n)) ? 'success' : c;
}
/* proc (lote malha-v2, regra aprovada pelo humano em 19/10/2026): vermelho sozinho NAO derruba a etapa. Um passo de auditoria
 * que reprova por dado real pinta o workflow de vermelho enquanto o gerador dele gravou normalmente (no ar em 19/10: `fa` com
 * 2 vermelhos em 46). Cada workflow vermelho e cruzado com o frescor dos arquivos que ELE grava (o mapa `FONTES.wf`):
 *   · parado = vermelho em TODAS as ultimas execucoes (as 2, ou a unica que ha) E algum arquivo dele fora do prazo (at/fa)
 *     ou ausente (sem) no frescor -> `fa`: o workflow de producao parou de gravar;
 *   · qualquer outro vermelho -> `at`. Motivo `workflow_vermelho_grava` quando TODO workflow vermelho grava arquivo do frescor
 *     e todos os arquivos deles estao no prazo; senao `workflow_vermelho` (vermelho em 1 das 2 com arquivo atrasado, ou
 *     workflow que nao grava nenhum arquivo do frescor, ex.: ensaios). Com `fa`, o motivo e `workflow_vermelho`;
 *   · n: `ok` e `total` contam EXECUCOES; `vermelhos` e `parados` contam WORKFLOWS (sempre presentes quando ha execucao). */
function etapaProc(execs, frescor) {
  if (!execs) return { st: 'sem', motivo: null, ultima: null, n: {} };
  const stDe = new Map((frescor || []).map((x) => [x.id, x.st]));
  let ok = 0, total = 0, ult = null, verm = 0, parados = 0, gravam = 0;
  for (const e of execs) {
    const v = e.runs.filter((r) => GH_VERMELHO.includes(r.c)).length;
    total += e.runs.length; ok += e.runs.filter((r) => GH_OK.includes(r.c)).length;
    for (const r of e.runs) if (isFinite(r.t) && (ult == null || r.t > ult)) ult = r.t;
    if (!v) continue;
    verm++;
    const sts = FONTES.filter((f) => f.wf.includes(e.wf)).map((f) => {
      if (!stDe.has(f.id)) throw new Error('proc: frescor sem a fonte ' + f.id + ' (gravada por ' + e.wf + ')');   // nao inventa "no prazo"
      return stDe.get(f.id);
    });
    if (!sts.length) continue;                                       // nao grava nada do frescor: so ressalva
    const fora = sts.some((s) => s !== 'ok');
    if (fora && v === e.runs.length) parados++;                      // vermelho nas 2 ultimas (ou na unica) e arquivo fora do prazo
    else if (!fora) gravam++;                                        // vermelho, mas tudo o que ele grava esta no prazo
  }
  if (!total) return { st: 'sem', motivo: null, ultima: null, n: {} };
  const st = parados ? 'fa' : verm ? 'at' : 'ok';
  const motivo = st === 'ok' ? null : st === 'at' && gravam === verm ? 'workflow_vermelho_grava' : 'workflow_vermelho';
  return { st, motivo, ultima: ult == null ? null : isoZ(ult), n: { ok, total, vermelhos: verm, parados } };
}

/* ───────────── montagem ───────────── */
function historico(letraDoDia, hoje) {
  let h = '';
  for (let k = DIAS_H - 1; k >= 0; k--) h += letraDoDia(somaDias(hoje, -k));
  return h;
}
function monta({ agoraMs, agenda, por, frescor, execs }) {
  const hoje = diaBRT(agoraMs);
  const E = {};
  const todos = Object.keys(agenda);
  const proxPonte = isoZ(proximaPonte(agoraMs));

  /* ponte: hoje e o historico de 14 dias */
  const ponteHoje = etapasPonte(por[hoje], hoje, true);
  const porDia = {};
  for (let k = DIAS_H - 1; k >= 0; k--) { const d = somaDias(hoje, -k); porDia[d] = d === hoje ? ponteHoje : etapasPonte(por[d], d, false); }
  for (const id of PONTE_ETAPAS) {
    const x = ponteHoje[id];
    E[id] = { st: x.st, ultima: x.ultima, ref_dia: x.ref_dia, prox: proxPonte, n: x.n, motivo: x.motivo,
      h: historico((d) => LETRA[porDia[d][id].st], hoje) };
  }
  /* declaradas */
  for (const [id, D] of Object.entries(DECLARADAS)) {
    E[id] = { st: D.st, ultima: null, ref_dia: null, prox: null, n: id === 'pa' ? { restam: PA.fluxos.length } : {}, motivo: null,
      h: historico((d) => (D.desde && d >= D.desde ? LETRA[D.st] : 'n'), hoje) };
  }
  /* sem acumulado: o que nao vem da ponte so tem registro de hoje */
  const soHoje = (st) => historico((d) => (d === hoje ? LETRA[st] : 'n'), hoje);
  const motivoFrescor = (st) => (st === 'at' ? 'atrasado' : st === 'fa' ? 'muito_atrasado' : null);
  for (const id of ['way2', 'ons']) {
    const f = frescor.find((x) => x.etapa === id);
    const prox = isoZ(proximo(cronsDe(agenda, FONTES.find((x) => x.id === f.id).wf), agoraMs));
    E[id] = { st: f.st, ultima: f._t == null ? null : isoZ(f._t), ref_dia: null, prox, n: f.idade_min == null ? {} : { idade_min: f.idade_min },
      motivo: motivoFrescor(f.st), h: soHoje(f.st) };
  }
  /* pub: o pior frescor do que o portal le. Arquivo que o portal le e nao existe quebra a pagina: conta como `fa`. */
  const P = frescor.filter((x) => x.etapa === 'pub');
  const stP = P.some((x) => x.st === 'fa' || x.st === 'sem') ? 'fa' : P.some((x) => x.st === 'at') ? 'at' : 'ok';
  /* `ultima` = a gravacao mais antiga entre os que dao o estado (os medidos, se os piores nao existem) */
  const medidos = (L) => L.map((x) => x._t).filter((t) => t != null);
  const tP = medidos(P.filter((x) => x.st === stP)).length ? medidos(P.filter((x) => x.st === stP)) : medidos(P);
  /* (o prazo de cada fonte ja exigiu o workflow na agenda, em leFrescor) */
  const wfP = [...new Set(P.flatMap((x) => FONTES.find((f) => f.id === x.id).wf))].filter((w) => agenda[w]);
  E.pub = { st: stP, ultima: tP.length ? isoZ(Math.min(...tP)) : null,
    ref_dia: null, prox: isoZ(Math.min(...wfP.map((w) => proximo(agenda[w], agoraMs)))),
    n: { no_prazo: P.filter((x) => x.st === 'ok').length, total: P.length }, motivo: motivoFrescor(stP), h: soHoje(stP) };
  /* proc e portal */
  const pr = etapaProc(execs, frescor);
  E.proc = { st: pr.st, ultima: pr.ultima, ref_dia: null, prox: isoZ(Math.min(...todos.map((w) => proximo(agenda[w], agoraMs)))), n: pr.n,
    motivo: pr.motivo, h: soHoje(pr.st) };
  E.portal = { st: 'sem', ultima: null, ref_dia: null, prox: null, n: {}, motivo: null, h: soHoje('sem') };

  const etapas = {};
  for (const id of ETAPAS) etapas[id] = E[id];

  /* o dia de hoje */
  const S = por[hoje], So = por[somaDias(hoje, -1)];
  const ponte_hoje = { resultado: S ? S.resultado : 'sem', tentativas: S ? S.tentativas : null, inicio: S ? S.inicio : null, fim: S ? S.fim : null,
    ontem: { resultado: So ? So.resultado : 'sem', tentativas: So ? So.tentativas : null } };
  const us = S && S.fontes ? ['inversores', 'estacoes', 'scada_db'].map((k) => S.fontes[k]) : null;
  const soma = (L) => (L.length ? L.reduce((a, b) => a + b, 0) : null);
  const recebido_hoje = { arquivos: us ? soma(us.map((f) => f.arquivos_vm).filter((x) => x != null)) : null,
    mb: us ? (soma(us.map((f) => f.azure_mb).filter((x) => x != null)) == null ? null : r1(soma(us.map((f) => f.azure_mb).filter((x) => x != null)))) : null,
    dia: hoje };

  const linha = [];
  const ev = (ts, etapa, codigo) => { const st = etapas[etapa].st; if (ts && ['ok', 'at', 'fa'].includes(st)) linha.push({ ts, etapa, st, ev: codigo }); };
  if (S) {
    ev(S.inicio, 'ponte', 'ponte_inicio');
    if (S.fontes) { ev(S.fontes.inversores.fim, 'inv', 'coleta_inversores'); ev(S.fontes.cofre.fim, 'cofre', 'cofre_gravou'); ev(S.fontes.onedrive.fim, 'onedrive', 'onedrive_gravou'); }
    ev(S.fim, 'ponte', 'ponte_fim');
  }
  if (etapas.proc.ultima && diaBRT(Date.parse(etapas.proc.ultima)) === hoje) ev(etapas.proc.ultima, 'proc', 'processamento');
  const tPub = P.map((x) => x._t).filter((t) => t != null);
  if (tPub.length && diaBRT(Math.max(...tPub)) === hoje) ev(isoZ(Math.max(...tPub)), 'pub', 'publicacao');
  linha.sort((a, b) => a.ts.localeCompare(b.ts) || ETAPAS.indexOf(a.etapa) - ETAPAS.indexOf(b.etapa));

  let proxima = null;
  for (const id of ETAPAS) { const p = etapas[id].prox; if (p && (!proxima || p < proxima.quando)) proxima = { etapa: id, quando: p }; }

  return {
    versao: 1,
    gerado: isoZ(agoraMs),
    etapas,
    ponte_hoje,
    recebido_hoje,
    proxima,
    linha_dia: linha,
    frescor: frescor.map((x) => ({ id: x.id, etapa: x.etapa, idade_min: x.idade_min, prazo_min: x.prazo_min, st: x.st })),
    pa: { restam: PA.fluxos.length, fluxos: PA.fluxos.slice(), fim_licenca: PA.fim_licenca, atualizado: PA.atualizado },
    acesso: null,
  };
}

/* ───────────── guarda: o contrato e o texto publico ───────────── */
const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;
const RE_H = /^[oafdpn]{14}$/;
/* o que nunca pode aparecer, para o diagnostico (a lista de valores permitidos abaixo ja barra tudo que nao e codigo) */
const PROIBIDO = [
  [/\b\d{1,3}(?:\.\d{1,3}){3}\b/, 'endereco IP'],
  [/backup-dados-scada|portal-admin|scada-raw|sungrow-raw|inversores-raw|rbenergydata|blob\.core|\bdados\b/i, 'nome de conteiner ou conta'],
  [/\.(json|csv|zip|gz|log|xlsx?|parquet)\b/i, 'nome de arquivo'],
  [/AccountKey|SharedAccessSignature|\bsig=|Bearer|token/i, 'credencial'],
  [/[\\/]/, 'caminho'],
];
function confere(o) {
  const erros = [];
  const e = (m) => erros.push(m);
  const ids = FONTES.map((f) => f.id);
  const textos = new Set([...ST, ...CODIGOS, ...ETAPAS, ...ids, 'ok', 'falhou', 'sem', ...PA.fluxos]);
  const chaves = (x, lista, onde) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return e(onde + ': nao e objeto');
    for (const k of Object.keys(x)) if (!lista.includes(k)) e(onde + ': chave fora do contrato "' + k + '"');
    for (const k of lista) if (!(k in x)) e(onde + ': falta "' + k + '"');
  };
  const isoOuNulo = (v, onde) => { if (v !== null && !(typeof v === 'string' && RE_ISO.test(v))) e(onde + ': data fora do formato'); };
  chaves(o, ['versao', 'gerado', 'etapas', 'ponte_hoje', 'recebido_hoje', 'proxima', 'linha_dia', 'frescor', 'pa', 'acesso'], 'topo');
  if (o.versao !== 1) e('versao diferente de 1');
  if (!RE_ISO.test(o.gerado || '')) e('gerado fora do formato');
  if (o.acesso !== null) e('acesso deve ser null');
  chaves(o.etapas, ETAPAS, 'etapas');
  for (const id of ETAPAS) {
    const x = (o.etapas || {})[id];
    if (!x) continue;
    chaves(x, ['st', 'ultima', 'ref_dia', 'prox', 'n', 'motivo', 'h'], 'etapa ' + id);
    if (!ST.includes(x.st)) e('etapa ' + id + ': st invalido');
    isoOuNulo(x.ultima, 'etapa ' + id + '.ultima'); isoOuNulo(x.prox, 'etapa ' + id + '.prox');
    if (x.ref_dia !== null && !RE_DIA.test(String(x.ref_dia))) e('etapa ' + id + ': ref_dia fora do formato');
    if (x.motivo !== null && !CODIGOS.includes(x.motivo)) e('etapa ' + id + ': motivo fora dos codigos');
    if (!RE_H.test(String(x.h))) e('etapa ' + id + ': h fora do formato');
    else if (x.h[DIAS_H - 1] !== LETRA[x.st]) e('etapa ' + id + ': hoje no h nao e o st');
    if (['ok', 'at', 'fa'].includes(x.st) && !x.ultima) e('etapa ' + id + ': ' + x.st + ' sem registro (ultima nula)');
    if (x.n && typeof x.n === 'object') for (const [k, v] of Object.entries(x.n)) {
      if (!N_PERMITIDO[id].includes(k)) e('etapa ' + id + ': numero fora do contrato "' + k + '"');
      if (typeof v !== 'number' || !isFinite(v) || v < 0) e('etapa ' + id + '.n.' + k + ': nao e numero');
    } else e('etapa ' + id + ': n nao e objeto');
  }
  const ph = o.ponte_hoje || {};
  chaves(ph, ['resultado', 'tentativas', 'inicio', 'fim', 'ontem'], 'ponte_hoje');
  if (!['ok', 'falhou', 'sem'].includes(ph.resultado)) e('ponte_hoje.resultado invalido');
  isoOuNulo(ph.inicio, 'ponte_hoje.inicio'); isoOuNulo(ph.fim, 'ponte_hoje.fim');
  chaves(ph.ontem, ['resultado', 'tentativas'], 'ponte_hoje.ontem');
  if (ph.ontem && !['ok', 'falhou', 'sem'].includes(ph.ontem.resultado)) e('ponte_hoje.ontem.resultado invalido');
  chaves(o.recebido_hoje, ['arquivos', 'mb', 'dia'], 'recebido_hoje');
  if (o.proxima !== null) { chaves(o.proxima, ['etapa', 'quando'], 'proxima'); if (o.proxima && !ETAPAS.includes(o.proxima.etapa)) e('proxima.etapa invalida'); }
  if (!Array.isArray(o.linha_dia)) e('linha_dia nao e lista');
  else o.linha_dia.forEach((x, i) => {
    chaves(x, ['ts', 'etapa', 'st', 'ev'], 'linha_dia[' + i + ']');
    if (!RE_ISO.test(String(x.ts))) e('linha_dia[' + i + ']: ts fora do formato');
    if (!ETAPAS.includes(x.etapa) || !['ok', 'at', 'fa'].includes(x.st) || !CODIGOS.includes(x.ev)) e('linha_dia[' + i + ']: valor fora dos codigos');
  });
  if (!Array.isArray(o.frescor)) e('frescor nao e lista');
  else o.frescor.forEach((x, i) => {
    chaves(x, ['id', 'etapa', 'idade_min', 'prazo_min', 'st'], 'frescor[' + i + ']');
    if (!ids.includes(x.id)) e('frescor[' + i + ']: id fora da lista');
    if (!['way2', 'ons', 'pub'].includes(x.etapa)) e('frescor[' + i + ']: etapa invalida');
    if (typeof x.prazo_min !== 'number' || !isFinite(x.prazo_min) || x.prazo_min <= 0) e('frescor[' + i + ']: sem prazo_min');
    if (!['ok', 'at', 'fa', 'sem'].includes(x.st)) e('frescor[' + i + ']: st invalido');
    if ((x.st === 'sem') !== (x.idade_min === null)) e('frescor[' + i + ']: idade e st nao concordam');
  });
  chaves(o.pa, ['restam', 'fluxos', 'fim_licenca', 'atualizado'], 'pa');
  /* todo texto da saida e um codigo, um id, uma data ou um nome de fluxo declarado; e nada da lista proibida */
  const anda = (v, onde) => {
    if (typeof v === 'string') {
      if (!(textos.has(v) || RE_ISO.test(v) || RE_DIA.test(v) || RE_H.test(v))) e(onde + ': texto fora da lista do contrato');
      for (const [re, oque] of PROIBIDO) if (!PA.fluxos.includes(v) && re.test(v)) e(onde + ': ' + oque);
    } else if (Array.isArray(v)) v.forEach((x, i) => anda(x, onde + '[' + i + ']'));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
      for (const [re, oque] of PROIBIDO) if (re.test(k)) e(onde + '.' + k + ': ' + oque + ' na chave');
      if (k === 'log' || k === 'obs') e(onde + '.' + k + ': log/obs da ponte na saida');
      anda(x, onde + '.' + k);
    }
  };
  anda(o, 'saida');
  return erros;
}

/* ───────────── principal ───────────── */
async function main() {
  const agoraMs = process.env.MALHA_AGORA ? Date.parse(process.env.MALHA_AGORA) : Date.now();
  if (!isFinite(agoraMs)) throw new Error('MALHA_AGORA ilegivel');
  if (DESTINO === COFRE) throw new Error('destino igual ao cofre');
  const agenda = JSON.parse(fs.readFileSync(process.env.AGENDA_JSON || path.join(__dirname, '..', 'relogio', 'agenda.json'), 'utf8'));

  let fonte = null, modoPonte = 'nenhuma';
  if (process.env.LOCAL_PONTE_DIR) { fonte = fontePasta(process.env.LOCAL_PONTE_DIR); modoPonte = 'pasta local'; }
  else if (process.env.DADOS_STORAGE) { fonte = fonteCofre(); modoPonte = 'cofre'; }
  else console.log('::warning::gen-malha-estado: sem DADOS_STORAGE e sem LOCAL_PONTE_DIR — as etapas da ponte saem "sem"');

  const [por, frescor, execs] = await Promise.all([estadosPorDia(fonte, diaBRT(agoraMs)), leFrescor(agenda, agoraMs), leExecucoes(agenda)]);
  if (!execs) console.log('::warning::gen-malha-estado: sem GITHUB_TOKEN — proc e portal saem "sem"');
  const out = monta({ agoraMs, agenda, por, frescor, execs });

  const erros = confere(out);
  if (erros.length) {
    console.error('malha_estado: NAO gravado — ' + erros.length + ' achado(s) da guarda:\n  ' + erros.slice(0, 20).join('\n  '));
    process.exit(1);
  }
  console.log('ponte: ' + modoPonte + ' · frescor: ' + LD.modo() + ' · execucoes: ' + (execs ? execs.length + ' workflows' : 'sem token'));
  for (const id of ETAPAS) { const x = out.etapas[id]; console.log('  ' + id.padEnd(9) + x.st.padEnd(5) + x.h + (x.motivo ? '  ' + x.motivo : '')); }
  const ruins = out.frescor.filter((x) => x.st !== 'ok');
  console.log('frescor: ' + (out.frescor.length - ruins.length) + '/' + out.frescor.length + ' no prazo' + (ruins.length ? ' · ' + ruins.map((x) => x.id + ' ' + x.st + (x.idade_min != null ? ' ' + x.idade_min + '/' + x.prazo_min + ' min' : '')).join(', ') : ''));

  const json = JSON.stringify(out);
  if (process.env.LOCAL_OUT) {
    fs.writeFileSync(process.env.LOCAL_OUT, JSON.stringify(out, null, 1));
    console.log('local: ' + process.env.LOCAL_OUT + ' · ' + json.length + ' bytes');
    return;
  }
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const { BlobServiceClient } = require('@azure/storage-blob');
  const gz = zlib.gzipSync(Buffer.from(json, 'utf8'));
  await BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(DESTINO).getBlockBlobClient(OUT_BLOB)
    .upload(gz, gz.length, { blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'no-store' } });
  console.log('malha_estado OK · ' + json.length + ' bytes · ' + gz.length + ' gzip');
}

if (require.main === module) main().catch((e) => { console.error('ERRO: ' + (e && e.message ? e.message : e)); process.exit(1); });
else module.exports = { FONTES, ETAPAS, PONTE_ETAPAS, CODIGOS, PA, prazoMin, prazoDe, proximo, proximaPonte, estadoFrescor, escolheDiario,
  etapasPonte, etapaProc, monta, confere, normaliza, diaBRT };
