'use strict';
/*
 * gen-estacao-logger.js — a irradiancia no plano medida pelo DATALOGGER das nove estacoes solarimetricas, em meia hora,
 * publicada em `estacao_logger_30min.json` (10/10/2026, PROMOVER estacao-logger).
 *
 * Fonte: os arquivos de 10 min do CR1000X que o computador da usina envia todo dia as 04:00 ao container privado
 * `backup-dados-scada` (pasta `Estacao_Meteorologica_Logger/<ano>/<mes>/<estacao>/`). E a medicao DIRETA do sensor, media
 * de 10 min; a irradiancia do SCADA (`irr_plano_30min`) e uma amostra instantanea a cada 30 min do mesmo parque.
 * A regra da meia hora e os numeros que a decidiram estao em `lib-estacao-logger.js`.
 *
 * Guardas (abortam, nada e gravado):
 *   · arquivo de 10 min sem o campo da irradiancia no plano;
 *   · o mesmo instante com valores diferentes em dois arquivos (mais de 1 W/m2) em mais de 0,5 % dos registros;
 *   · menos de nove estacoes; leitura acima de 1.800 W/m2 (fora da faixa fisica do piranometro).
 *
 * 🔴 TODAS AS GRANDEZAS (lib-estacao-tudo, 14/10/2026, PROMOVER estacao-tudo): dos mesmos arquivos sai tambem `estacao_dia.json`
 *    (o resumo de cada dia de cada estacao: irradiacao no plano, global, difusa, direta e refletida, albedo, temperaturas do ar e do
 *    modulo, umidade, orvalho, vento, chuva, sujeira, bateria, e as leituras fora da faixa fisica) e `estacao_10min_M<usina>.json`
 *    (o registro de 10 min dos ultimos DIAS_10MIN dias). A pagina Estacao Meteorologica do portal so le o datalogger.
 *
 * Env: DADOS_STORAGE · RAW=backup-dados-scada · PREFIXO=Estacao_Meteorologica_Logger/ · OUT=dados
 *      LOCAL_DIR=<pasta> le os arquivos de uma pasta local em vez do container · LOCAL_OUT_DIR=<pasta> grava ali
 *      CACHE_BLOB_DIR (lib-cache-blob): so o arquivo novo vem pela rede
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./lib-estacao-logger');
const T = require('./lib-estacao-tudo');
const DIAS_10MIN = 14;   // o registro de 10 min publicado por estacao (o resto vai no resumo do dia)

const RAW = process.env.RAW || 'backup-dados-scada';
const PREFIXO = process.env.PREFIXO || 'Estacao_Meteorologica_Logger/';
const OUT = process.env.OUT || 'dados';
const NOME = 'estacao_logger_30min.json';
const TETO = 1800;

let _svc = null;
const svc = () => { if (!_svc) { const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido'); _svc = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE); } return _svc; };

async function arquivos() {
  const out = [];
  if (process.env.LOCAL_DIR) {
    const anda = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) anda(p); else out.push({ nome: path.relative(process.env.LOCAL_DIR, p).split(path.sep).join('/'), ler: async () => fs.readFileSync(p) }); } };
    anda(process.env.LOCAL_DIR);
    return { lista: out, fim: () => {} };
  }
  const cache = require('./lib-cache-blob').abre(RAW);
  const c = svc().getContainerClient(RAW);
  for await (const b of c.listBlobsFlat({ prefix: PREFIXO })) out.push({ nome: b.name, ler: () => cache.baixa(c, b) });
  return { lista: out, fim: () => { cache.poda(); cache.resumo(); } };
}

async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const c = svc().getContainerClient(OUT);
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

async function main() {
  const { lista, fim } = await arquivos();
  // por nome: o nome por dia ("..._2026-10-08.dat") vem antes do antigo ("..._Day398.dat"); o primeiro visto de cada instante fica
  const sel = lista.map((a) => ({ ...a, u: L.usinaDoArquivo(a.nome) })).filter((a) => a.u).sort((a, b) => (a.nome < b.nome ? -1 : 1));
  const R = new Map(), conflito = { n: 0, total: 0, ex: [] };
  const RT = new Map();   // todas as grandezas: usina -> Map(instante -> [valores, marcas]); o primeiro visto de cada instante fica
  let maior = 0;
  for (const a of sel) {
    const buf = await a.ler();
    let reg, tudo;
    const txt = buf.toString('utf8');
    try { reg = L.leArquivo(txt); } catch (e) { throw new Error(a.nome + ': ' + e.message); }
    tudo = T.leTudo(txt, a.nome);
    const mt = RT.get(a.u) || new Map(); RT.set(a.u, mt);
    for (const [t, val, fl] of tudo) if (!mt.has(t)) mt.set(t, [val, fl]);
    const m = R.get(a.u) || new Map(); R.set(a.u, m);
    for (const [t, x] of reg) {
      conflito.total++;
      if (x > maior) maior = x;
      if (x > TETO) throw new Error(a.nome + ': ' + t + ' com ' + x + ' W/m2, acima de ' + TETO + ' (faixa fisica do piranometro)');
      if (m.has(t)) { if (Math.abs(m.get(t) - x) > 1) { conflito.n++; if (conflito.ex.length < 3) conflito.ex.push(a.nome + ' ' + t); } continue; }
      m.set(t, x);
    }
  }
  fim();
  if (R.size < 9) throw new Error('so ' + R.size + ' estacoes nos arquivos (esperadas 9)');
  if (conflito.n > 0.005 * conflito.total) throw new Error(conflito.n + ' instantes com valores diferentes entre arquivos (' + conflito.ex.join('; ') + ')');
  const MH = new Map(), est = {};
  for (const [u, m] of R) {
    const mh = L.meiasHoras([...m]);
    const ks = [...mh.keys()].sort();
    est['M' + u] = { arquivo: u === 1 ? 'M10' : 'M' + u, registros_10min: m.size, meias_horas: ks.length, primeira: ks[0], ultima: ks[ks.length - 1] };
    for (const [t, v] of mh) { const o = MH.get(t) || {}; o['e' + u] = +v.toFixed(1); MH.set(t, o); }
  }
  const serie = [...MH.keys()].sort().map((t) => { const iso = t + ':00-03:00'; return Object.assign({ t: iso, ms: Date.parse(iso) }, MH.get(t)); });
  const obj = {
    gerado_em: new Date().toISOString(),
    fonte: 'Datalogger das estacoes solarimetricas (CR1000X): irradiancia no plano dos modulos, media de 10 min do sensor.',
    unidade: 'W/m2',
    rotulo_de_tempo: 'inicio do intervalo, horario de Brasilia',
    regra_meia_hora: 'media dos registros de 10 min rotulados T+10, T+20 e T+30 (rotulo no fim), os tres presentes; senao vazio',
    estacoes: est,
    conflitos_entre_arquivos: conflito.n,
    maior_leitura_w: maior,
    serie,
  };
  const kb = await escreve(NOME, obj);
  /* o resumo do dia e o 10 min recente de cada estacao (lib-estacao-tudo) */
  const serieDia = [], est10 = {};
  for (const [u, m] of [...RT].sort((a, b) => a[0] - b[0])) {
    for (const o of T.resumos(m)) serieDia.push(Object.assign({ u: 'M' + u, ms: Date.parse(o.d + 'T00:00:00-03:00') }, o));
    const rc = T.recente(m, DIAS_10MIN);
    est10['M' + u] = await escreve('estacao_10min_M' + u + '.json', { gerado_em: obj.gerado_em, usina: 'M' + u, fonte: 'Datalogger da estacao solarimetrica (CR1000X), registro de 10 min.',
      rotulo_de_tempo: 'v[grandeza][i*144 + j]: dia dias[i], intervalo que comeca em j x 10 min (horario de Brasilia); o datalogger rotula o fim',
      unidade: 'irradiancias W/m2; temperaturas °C; ur %; vento m/s e graus (0 = norte); chuva mm em 10 min; s1/s2 perda de sujeira %; bat V',
      dias: rc.dias, v: rc.v });
  }
  serieDia.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : a.u < b.u ? -1 : 1));
  const kbD = await escreve('estacao_dia.json', { gerado_em: obj.gerado_em, esquema: 1, fonte: 'Datalogger das estacoes solarimetricas (CR1000X), registro de 10 min.',
    unidade: 'poa ghi dif dni refl kWh/m2 no dia (irradiancia de 10 min x 1/6 h); poa_max W/m2; alb razao das somas refletida/global com a global'
      + ' acima de ' + T.SOL_ALB + ' W/m2; ta (media) ta_max ta_min po °C; ur ur_min %; tm_sol media dos 4 sensores do modulo com o plano acima de ' + T.SOL_FORTE
      + ' W/m2, tm1..tm4 cada sensor, dt_sol modulo menos ar, tm_max °C; ws ws_max m/s; wd graus (media vetorial pela velocidade); chuva mm, chuva_10'
      + ' maior em 10 min; s1 s2 perda de sujeira mediana com sol forte %; bat V minima; tl_max °C do datalogger; n registros (144 = dia inteiro),'
      + ' n_poa com irradiancia valida; noite registros com mais de 20 W/m2 entre 19:00 e 05:00; fora leituras fora da faixa fisica; teto vento no'
      + ' teto do anemometro (' + T.TETO_VENTO + ' m/s)',
    faixas: Object.fromEntries(T.VARS.map(([k, c, f]) => [k, f])), serie: serieDia });
  console.log('estacao_dia.json: ' + serieDia.length + ' estacao-dias · ' + Math.round(kbD / 1024) + ' KB gzip · 10 min: '
    + Object.entries(est10).map(([k, b]) => k + ' ' + Math.round(b / 1024) + ' KB').join(', '));
  console.log(NOME + ': ' + serie.length + ' meias horas · ' + Object.keys(est).length + ' estacoes · ' + sel.length + ' arquivos · '
    + conflito.n + ' conflitos · ' + Math.round(kb / 1024) + ' KB gzip');
  for (const [k, e] of Object.entries(est)) console.log('  ' + k + ' (' + e.arquivo + '): ' + e.meias_horas + ' meias horas, ' + e.primeira + ' a ' + e.ultima);
}

main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
