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
 * 🔴 A SOLARIMETRIA EM MEIA HORA, COM O HISTORICO INTEIRO (lib-estacao-30min, 19/10/2026, lote fonte-pr-logger): `estacao_tudo_30min.json`
 *    traz as 22 grandezas da solarimetria por estacao, meia hora = media das tres medias de 10 min (soma na chuva, minimo na bateria,
 *    media vetorial na direcao do vento), tudo-ou-nada por grandeza. E a fonte da estacao do `gen-irradiancia` (irr_ufv, irr_<res>,
 *    irr_<familia>_<res>), que alimenta a Solarimetria, a Visao Executiva e o PR: regra do humano de 19/10/2026, o SCADA so no
 *    Comparativo. Guarda: a irradiancia no plano dele e a do `estacao_logger_30min.json` (duas leituras do mesmo arquivo) sao a
 *    mesma meia hora a meia hora; divergiu, nada e gravado.
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
const S30 = require('./lib-estacao-30min');   // lote fonte-pr-logger: a solarimetria inteira em meia hora, para o gen-irradiancia
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
  const R30 = new Map();  // a solarimetria crua de 10 min (lib-estacao-30min): usina -> Map(instante -> {chave: valor}); o primeiro visto fica
  let maior = 0;
  for (const a of sel) {
    const buf = await a.ler();
    let reg, tudo;
    const txt = buf.toString('utf8');
    try { reg = L.leArquivo(txt); } catch (e) { throw new Error(a.nome + ': ' + e.message); }
    tudo = T.leTudo(txt, a.nome);
    const mt = RT.get(a.u) || new Map(); RT.set(a.u, mt);
    for (const [t, val, fl] of tudo) if (!mt.has(t)) mt.set(t, [val, fl]);
    const m3 = R30.get(a.u) || new Map(); R30.set(a.u, m3);
    for (const [t, o] of S30.le10(txt, a.nome)) if (!m3.has(t)) m3.set(t, o);
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
  /* a solarimetria inteira em meia hora (lib-estacao-30min). 🔴 GUARDA DE DUAS LEITURAS: a irradiancia no plano daqui e a do
     estacao_logger_30min (outro leitor do mesmo arquivo, a mesma regra da meia hora) tem de ser a MESMA em toda meia hora das duas;
     divergir e um dos dois leitores errado, e nada e gravado. Folga 0,1 W/m2: os dois publicam 1 casa, e a mesma media somada em outra
     ordem pode cair do outro lado de um empate (medido: 127 de 192.931 meias horas a 0,1 com o arredondamento por Math.round). */
  const P30 = new Map();
  for (const [u, m] of R30) P30.set(u, S30.meias(m));
  { let n = 0, dif = 0; const ex = [];
    for (const [t, o] of MH) for (const [k, v] of Object.entries(o)) {
      const u = +k.slice(1), x = P30.get(u) && P30.get(u).get(t); const g = x ? x.gti : null; n++;
      if (g == null || Math.abs(g - v) > 0.1001) { dif++; if (ex.length < 3) ex.push('M' + u + ' ' + t + ' ' + v + ' x ' + g); } }
    let sobra = 0; for (const [u, mh] of P30) for (const [t, x] of mh) if (x.gti != null && !(MH.get(t) && MH.get(t)['e' + u] != null)) sobra++;
    if (dif || sobra) throw new Error('estacao_tudo_30min x ' + NOME + ': ' + dif + ' de ' + n + ' meias horas diferentes, ' + sobra + ' a mais (' + ex.join('; ') + ')');
    console.log('estacao_tudo_30min x ' + NOME + ': ' + n + ' meias horas iguais na irradiancia no plano'); }
  const col = S30.colunar(P30);
  const kb30 = await escreve('estacao_tudo_30min.json', { gerado_em: obj.gerado_em, esquema: 1,
    fonte: 'Datalogger das estacoes solarimetricas (CR1000X), registro de 10 min.',
    rotulo_de_tempo: 'inicio da meia hora, horario de Brasilia: o indice i e o instante inicio + 30 min x i; o valor cobre [T, T+30)',
    regra_meia_hora: 'os registros de 10 min rotulados T+10, T+20 e T+30 (o datalogger rotula o fim), os tres presentes e com valor; senao nulo',
    agregacao: S30.AGREGA, escala: S30.ESCALA,
    campos: Object.fromEntries(S30.CAMPOS.map((c) => [c[0], c[1]])),
    unidade: 'irradiancias W/m2 (media do intervalo); albedo razao; temperaturas °C; umid %; vento m/s; vento_dir graus (0 = norte); chuva mm na meia hora; suj e perda_suj %; bateria V (minimo)',
    inicio: col.inicio, passo_min: 30, n: col.n, estacoes: col.estacoes });
  console.log('estacao_tudo_30min.json: ' + col.n + ' meias horas desde ' + col.inicio + ' · ' + Object.keys(col.estacoes).length + ' estacoes · '
    + S30.CHAVES.length + ' grandezas · ' + Math.round(kb30 / 1024) + ' KB gzip');
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
