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

/* frescor: idades contra AGORA */
const PUB = {};
for (const f of G.FONTES) PUB[f.blob] = Date.parse('2026-10-19T15:25:00Z');            // 5 min: ok em qualquer prazo da agenda de ensaio
PUB['way2_recent.json'] = Date.parse('2026-10-19T15:26:00Z');                          // 4 min, prazo 10 -> ok
PUB['ons_restricao_all.json'] = Date.parse('2026-10-18T09:30:00Z');                    // 1800 min, prazo 1560 -> atrasado
delete PUB['executivo.json'];                                                          // nao existe -> sem
PUB['portal_vivo.json'] = Date.parse('2026-10-19T15:05:00Z');                          // 25 min, prazo 10 -> muito atrasado
const blobsDados = {};
for (const [n, m] of Object.entries(PUB)) blobsDados[n] = { mod: m };

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

let MUNDO_HTTP = { gh: {}, pub: {}, pubSumiu: false };
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
    r.writeHead(200, { 'last-modified': new Date(tm).toUTCString(), 'content-length': '2' });
    return r.end(q.method === 'HEAD' ? undefined : '{}');
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
  Object.assign(env, { MALHA_AGORA: AGORA, AGENDA_JSON: cen.agenda || agendaFix, MALHA_FAKE: mundo, MALHA_FAKE_REG: reg });
  if (cen.sdk) env.DADOS_STORAGE = 'conexao-de-ensaio';
  else env.DADOS_BASE_PUB = 'http://127.0.0.1:' + PORTA + '/dados/';
  if (!cen.blob) env.LOCAL_OUT = outF;
  if (cen.ponteDir) env.LOCAL_PONTE_DIR = cen.ponteDir;
  if (cen.gh) Object.assign(env, { GITHUB_TOKEN: 'tk-ensaio', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: 'http://127.0.0.1:' + PORTA });
  MUNDO_HTTP = Object.assign({ gh: cen.gh || {}, pub: PUB, pubSumiu: false }, cen.http || {});
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
const FRESCOR_ESPERADO = {
  medidor_5min: { st: 'ok', idade_min: 4, prazo_min: 10 },
  ons_restricao: { st: 'at', idade_min: 1800, prazo_min: 1560 },
  visao_executiva: { st: 'sem', idade_min: null, prazo_min: 660 },
  ao_vivo: { st: 'fa', idade_min: 25, prazo_min: 10 },
};

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
    const x = FRESCOR_ESPERADO[f.id] || { st: 'ok', idade_min: 5 };
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
    if (n !== 1) throw new Error('plantio ' + nome + ': ancora achada ' + n + ' vezes: ' + de.slice(0, 70));
    src = src.replace(de, () => para);
  }
  assert.notStrictEqual(src, orig, 'plantio ' + nome + ' nao mudou nada');
  const f = path.join(TMP, 'mutante_' + nome + '.js');
  fs.writeFileSync(f, src);
  return f;
}
const SEM_GUARDA = ['  const erros = confere(out);', '  const erros = [];'];

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
    && G.FONTES.filter((f) => f.wf.includes('perdas.yml')).map((f) => f.id).join() === 'perdas_inversor,perdas_dia'
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

  console.log('3. plantios (cada um TEM de reprovar)');
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
    ['frescor sem prazo', [['function prazoDe(agenda, wfs) { return prazoMin(cronsDe(agenda, wfs)); }', 'function prazoDe(agenda, wfs) { try { return prazoMin(cronsDe(agenda, wfs)); } catch (e) { return null; } }']],
      CENARIOS_ESTOURA.semPrazo[0], CENARIOS_ESTOURA.semPrazo[1]],
    ['frescor sem prazo, sem a guarda', [['function prazoDe(agenda, wfs) { return prazoMin(cronsDe(agenda, wfs)); }', 'function prazoDe(agenda, wfs) { try { return prazoMin(cronsDe(agenda, wfs)); } catch (e) { return null; } }'], SEM_GUARDA],
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
