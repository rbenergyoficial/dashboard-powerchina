'use strict';
/*
 * gen-ts-setpoint.js — a potencia e o SETPOINT DE DESPACHO de cada eletrocentro, a cada 30 min, nas nove usinas.
 *
 * O setpoint de despacho e por inversor e so existe no export do SCADA (`SETPOINT POTÊNCIA ATIVA`, em kW desde o esquema 2
 * do gen-perdas). O logger Sungrow tambem tem um "setpoint do arranjo", mas e um valor de CONFIGURACAO: o mesmo numero em
 * todos os 180 dias de cada um dos 24 loggers (medido em 04/10/2026), entao nao serve para comparar com a potencia.
 *
 * Fonte: `pvstr_hora_<usina>.json` (gen-perdas), a curva de 30 min de cada inversor nos ultimos 7 dias. Este gerador SOMA,
 * por eletrocentro e por carimbo, a potencia CA e o setpoint dos inversores, e ACUMULA no arquivo publicado do eletrocentro
 * (`sp_ts_<usina>_<ts>.json`, DIAS dias): a fonte guarda 7, entao rodar uma vez por dia basta com folga de seis.
 *
 * 🔴 A CURVA DE CADA INVERSOR SO COBRE A JANELA DELE (do primeiro ao ultimo instante gerando; os zeros do meio ficam, porque
 *    sao parada). Na ponta da manha e da tarde um eletrocentro tem menos inversores somados que a quantidade: por isso cada
 *    linha diz QUANTOS entraram na soma (`n_lido` com potencia, `n_sp` com setpoint) e quantos o eletrocentro tem (`n_tot`,
 *    os inversores distintos dele na fonte). Inversor sem curva no dia (parado o dia inteiro) nao soma setpoint.
 * 🔴 INSTANTE SEM LEITURA (o gen-perdas mantem o carimbo com tudo nulo) sai NULO, nunca zero: soma de nada nao e 0 kW.
 * 🔴 SO O 404 E "PRIMEIRA VEZ". Falha ao ler o arquivo publicado aborta: regravar sem ele apagaria o acumulado.
 *
 * 🔴 CONTRATO DA FONTE: esquema >= 2 do gen-perdas (setpoint em kW; no esquema 1 estava em W), unidade dizendo "pca em kW"
 *    e "sp em kW", e toda linha com as listas h, pca e sp. Fonte fora do contrato ESTOURA: somar W com kW, ou publicar um
 *    ano de setpoint nulo porque o campo mudou de nome, seria pior que a falta de uma rodada.
 * 🔴 QUANTIDADE DO ELETROCENTRO (n_tot) e a uniao dos inversores ja vistos nele (guardada no arquivo, `inversores`) com os
 *    da fonte: inversor parado por mais de 7 dias sai da fonte, mas nao sai do eletrocentro.
 *
 * Env: DADOS_STORAGE · OUT=dados · ensaio: LOCAL_IN_DIR (os pvstr_hora_*.json) e LOCAL_OUT_DIR; BLOB_BASE troca a origem
 *      da LEITURA (fonte e publicado) por outro endereco http(s), para o ensaio julgar o 404 e os outros codigos
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const http = require('http');

const OUT = process.env.OUT || 'dados';
const BLOB = process.env.BLOB_BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const LER_LOCAL = !process.env.BLOB_BASE;
const USINAS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const DIAS = 365;
const GERANDO = 1;                                           // kW: o mesmo piso do "gerando" da saude do inversor

let _svc = null;
const svc = () => { if (!_svc) { const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido'); _svc = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE); } return _svc; };
function puxa(url) {
  return new Promise((ok, ko) => {
    (url.startsWith('http:') ? http : https).get(url, { family: 4, headers: { 'accept-encoding': 'gzip' } }, (r) => {
      if (r.statusCode === 404) { r.resume(); ok(null); return; }
      if (r.statusCode !== 200) { r.resume(); ko(new Error(url + ' -> HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (x) => c.push(x));
      r.on('end', () => { try { let b = Buffer.concat(c); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        ok(JSON.parse(b.toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}
const leLocal = (dir, nome) => { const f = path.join(dir, nome); if (!fs.existsSync(f)) return null;
  let b = fs.readFileSync(f); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return JSON.parse(b.toString('utf8')); };
async function leFonte(nome) {
  if (LER_LOCAL && process.env.LOCAL_IN_DIR) return leLocal(process.env.LOCAL_IN_DIR, nome);
  try { return await puxa(BLOB + nome); } catch (e) { throw new Error('nao consegui ler a fonte ' + nome + ' (' + e.message + ')'); }
}
async function leAnterior(nome) {
  if (LER_LOCAL && process.env.LOCAL_OUT_DIR) return leLocal(process.env.LOCAL_OUT_DIR, nome);
  try { return await puxa(BLOB + nome); } catch (e) {
    throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: regravar sem ele apagaria o acumulado.');
  }
}
async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  await svc().getContainerClient(OUT).getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}
const r1 = (x) => Math.round(x * 10) / 10;
const msDe = (t) => Date.parse(t.replace(' ', 'T') + ':00Z') + 3 * 3600e3;    // epoch do instante em BRT

// soma por eletrocentro e carimbo: [p, sp, n_lido, n_sp, n_ger]
function somaPorTs(serie) {
  const por = new Map(), invs = new Map();
  for (const l of serie) {
    (invs.get(l.ts) || invs.set(l.ts, new Set()).get(l.ts)).add(l.inv);
    const m = por.get(l.ts) || por.set(l.ts, new Map()).get(l.ts);
    (l.h || []).forEach((h, i) => {
      const t = l.d + ' ' + h, a = m.get(t) || m.set(t, [0, 0, 0, 0, 0]).get(t);
      const p = (l.pca || [])[i], sp = (l.sp || [])[i];
      if (p != null) { a[0] += p; a[2] += 1; if (p > GERANDO) a[4] += 1; }
      if (sp != null) { a[1] += sp; a[3] += 1; }
    });
  }
  return { por, invs };
}

(async () => {
  const agora = new Date().toISOString();
  let arquivos = 0, linhas = 0;
  const grava = async (u, fonte) => {
    const { por, invs } = somaPorTs(fonte.serie);
    for (const [ts, m] of [...por].sort()) {
      const nome = 'sp_ts_' + u + '_' + ts + '.json';
      const ant = await leAnterior(nome);
      const tudo = new Map(((ant && ant.serie) || []).map((l) => [l.t, l]));
      const vistos = new Set([...((ant && ant.inversores) || []), ...invs.get(ts)]);
      const nTot = vistos.size;
      for (const [t, a] of m) {
        tudo.set(t, { t, ms: msDe(t), p: a[2] ? r1(a[0]) : null, sp: a[3] ? r1(a[1]) : null,
          n_lido: a[2], n_sp: a[3], n_ger: a[4], n_tot: nTot });
      }
      const ks = [...tudo.keys()].sort();
      const corte = new Date(Date.parse(ks[ks.length - 1].slice(0, 10) + 'T00:00:00Z') - (DIAS - 1) * 864e5).toISOString().slice(0, 10);
      const serie = ks.filter((t) => t.slice(0, 10) >= corte).map((t) => tudo.get(t));
      await escreve(nome, { gerado_em: agora, usina: u, ts, esquema: 1, janela_dias: DIAS, passo: '30 min · amostra INSTANTANEA',
        inversores: [...vistos].sort(),
        unidade: 'p kW (soma da potencia CA dos inversores); sp kW (soma do setpoint de despacho dos inversores); n_lido inversores'
          + ' com potencia na soma; n_sp com setpoint; n_ger gerando (> ' + GERANDO + ' kW); n_tot inversores do eletrocentro; ms epoch do instante (BRT)',
        serie });
      arquivos += 1; linhas += serie.length;
    }
    console.log('  ' + u + ': ' + por.size + ' eletrocentro(s) · ' + fonte.serie.length + ' inversor-dias na fonte');
  };
  /* 🔴 TODAS AS FONTES SAO LIDAS E CONFERIDAS ANTES DE GRAVAR QUALQUER ARQUIVO: fonte ilegivel ou fora do contrato numa
     usina aborta a rodada inteira sem deixar parte das usinas atualizada e parte nao */
  const fontes = [];
  for (const u of USINAS) {
    const fonte = await leFonte('pvstr_hora_' + u + '.json');
    if (!fonte || !(fonte.serie || []).length) { console.log('  ' + u + ': sem curva de 30 min na fonte'); continue; }
    const quebra = (fonte.esquema || 1) < 2 ? 'esquema ' + (fonte.esquema || 1) + ' (setpoint em W)'
      : !/pca em kW/.test(fonte.unidade || '') || !/sp em kW/.test(fonte.unidade || '') ? 'unidade sem "pca em kW" e "sp em kW"'
        : fonte.serie.some((l) => !Array.isArray(l.h) || !Array.isArray(l.pca) || !Array.isArray(l.sp)) ? 'linha sem h, pca ou sp' : null;
    if (quebra) throw new Error('pvstr_hora_' + u + '.json fora do contrato: ' + quebra);
    fontes.push([u, fonte]);
  }
  for (const [u, fonte] of fontes) await grava(u, fonte);
  if (!arquivos) throw new Error('nenhuma usina com curva de 30 min: a fonte (pvstr_hora_*) nao foi lida');
  console.log('sp_ts: ' + arquivos + ' arquivo(s), ' + linhas + ' linhas');
})().catch((e) => { console.error(e.message || e); process.exit(1); });
