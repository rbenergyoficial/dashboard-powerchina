'use strict';
/*
 * gen-sungrow.js — o logger Sungrow (container `sungrow-raw`) vira resumos por dia de cada inversor, PID e eletrocentro.
 *
 * O logger da Sungrow registra a cada 5 minutos o que o export do SCADA traz a cada 30, e mais: codigo de falha, estado
 * de operacao, eficiencia, horarios de partida e parada, o PID de cada eletrocentro e o proprio logger (setpoint do
 * arranjo, inversores na rede, PT100). Cobre o M1 e o M5 a M9 (o M2, o M3 e o M4 nao estao na pasta). Auditoria e
 * decisoes: livro do pipeline, secao do logger Sungrow (03/10/2026).
 *
 * 🔴 A PASTA NAO E POSICAO. No M1 os grupos de inversores dos TS5 e TS6 estao trocados nas pastas, e o M9/TS1 01-05 esta
 *    na pasta do TS2. Cada inversor e identificado pelo CONTADOR DE VIDA: no fim do dia ele e IGUAL (a 0,5 kWh) ao
 *    `ENERGIA TOTAL GERADA` do mesmo inversor no export do SCADA. Medido: 594 de 594, sem ambiguidade. Inversor que nao
 *    casa (trocado antes da janela do export) fica fora dos produtos por posicao e e contado em `sem_posicao`.
 * 🔴 INCREMENTAL. O historico tem 3,9 GB de zip e 38 GB de CSV; cada rodada le so os zips novos ou mudados (nome +
 *    tamanho, no manifesto `sg_lidos.json`) e funde no historico interno (`sg_hist.json`). REFAZER=1 relê tudo.
 *    No mesmo inversor-dia vindo de dois zips (a PowerChina renomeia e regrava os lotes), fica o de mais amostras.
 * 🔴 SO O 404 E "PRIMEIRA RODADA". Falha ao ler o historico publicado aborta: regravar sem ele apagaria o acumulado.
 *
 * Env: DADOS_STORAGE · RAW=sungrow-raw · SCADA_RAW=scada-raw · OUT=dados · REFAZER=1
 *      ensaio: LOCAL_RAW_DIR (pasta com a mesma arvore M05/TS01/...) · LOCAL_SCADA_DIR · LOCAL_OUT_DIR · LOCAL_INV_SCADA
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { entradas } = require('./lib-zip.js');
const S = require('./lib-sungrow.js');
const { casaCru } = require('./lib-inversor-cru.js');

const RAW = process.env.RAW || 'sungrow-raw';
const SCADA_RAW = process.env.SCADA_RAW || 'scada-raw';
const OUT = process.env.OUT || 'dados';
const REFAZER = !!process.env.REFAZER;
const DIAS_5MIN = 7;                                        // a serie de 5 min do PID publicada (o resto vira resumo do dia)
const TOL_VIDA = 0.5;                                       // kWh: contador de vida igual nas duas fontes (medido: 594/594)
const BLOB = 'https://rbenergydata.blob.core.windows.net/dados/';
const parque = (nn) => 'M' + (Number(nn) === 10 ? 1 : Number(nn));   // M10 = M1 (nomenclatura das usinas)

/* ------------------------------------------------------------------ armazenamento ------------------------------------- */
let _svc = null;
const svc = () => { if (!_svc) { const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido'); _svc = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE); } return _svc; };

async function listaRaw() {
  if (process.env.LOCAL_RAW_DIR) {
    const out = [];
    const anda = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) anda(path.join(d, e.name), r);
      else if (/^M\d\d\/TS\d\d\/[^/]+\/[^/]+\.zip$/i.test(r)) out.push({ nome: r, bytes: fs.statSync(path.join(d, e.name)).size,
        ler: async () => fs.readFileSync(path.join(d, e.name)) }); } };
    anda(process.env.LOCAL_RAW_DIR, '');
    return out;
  }
  const c = svc().getContainerClient(RAW);
  const out = [];
  for await (const b of c.listBlobsFlat()) {
    if (!/^M\d\d\/TS\d\d\/[^/]+\/[^/]+\.zip$/i.test(b.name)) continue;
    out.push({ nome: b.name, bytes: b.properties.contentLength, ler: async () => c.getBlobClient(b.name).downloadToBuffer() });
  }
  return out;
}

function puxa(url) {
  return new Promise((ok, ko) => {
    https.get(url, { family: 4, headers: { 'accept-encoding': 'gzip' } }, (r) => {
      if (r.statusCode === 404) { r.resume(); ok(null); return; }
      if (r.statusCode !== 200) { r.resume(); ko(new Error(url + ' -> HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (x) => c.push(x));
      r.on('end', () => { try { let b = Buffer.concat(c); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        ok(JSON.parse(b.toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}
async function leAnterior(nome) {
  if (process.env.LOCAL_OUT_DIR) {
    const f = path.join(process.env.LOCAL_OUT_DIR, nome);
    if (!fs.existsSync(f)) return null;
    let b = fs.readFileSync(f); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    return JSON.parse(b.toString('utf8'));
  }
  try { return await puxa(BLOB + nome); } catch (e) {
    throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: regravar sem ele apagaria o acumulado.');
  }
}
async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const c = svc().getContainerClient(OUT);
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

/* ------------------------------------------------------------------ o SCADA, para identificar ------------------------- */
// o contador de vida de cada POSICAO no fim de cada dia, dos ultimos exports por usina: Map(dia -> Map(pos -> kWh))
const CARIMBO = /M(\d{2})(?:_ATT(?:-\d+)?)?_(\d{8})_\d{6}\.csv$/i;
const RE = /^UFV_(\w+?)_(TS\d+)_(INV\d+)_\1 \2 \3 (.+?)(_\d)?$/;
async function vidaScada(K) {
  let arqs = [];
  if (process.env.LOCAL_SCADA_DIR) {
    arqs = fs.readdirSync(process.env.LOCAL_SCADA_DIR).filter((n) => CARIMBO.test(n))
      .map((n) => ({ nome: n, ler: async () => fs.readFileSync(path.join(process.env.LOCAL_SCADA_DIR, n)) }));
  } else {
    const c = svc().getContainerClient(SCADA_RAW);
    for await (const b of c.listBlobsFlat()) if (CARIMBO.test(b.name.split('/').pop())) arqs.push({ nome: b.name, ler: async () => c.getBlobClient(b.name).downloadToBuffer() });
  }
  const porU = new Map();
  for (const a of arqs) { const m = a.nome.split('/').pop().match(CARIMBO); const u = parque(m[1]);
    (porU.get(u) || porU.set(u, []).get(u)).push({ ...a, carimbo: m[2] }); }
  const out = new Map();
  for (const [u, L] of porU) {
    L.sort((x, y) => (x.carimbo < y.carimbo ? 1 : x.carimbo > y.carimbo ? -1 : (x.nome < y.nome ? 1 : -1)));
    const vistos = new Set();
    for (const a of L) {
      if (vistos.size >= K) break;
      if (vistos.has(a.carimbo)) continue;               // o envio mais recente do mesmo carimbo ja foi lido
      vistos.add(a.carimbo);
      const txt = (await a.ler()).toString('utf8').replace(/^\uFEFF/, '').replace(/\r/g, '');
      const Ls = txt.split('\n'); const cab = Ls[0].split(';');
      const rows = Ls.slice(1).filter((l) => /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(l)).map((l) => l.split(';'));
      if (!rows.length) continue;
      const dia = rows[0][0].slice(0, 10);
      const melhor = new Map();
      cab.forEach((c, i) => {
        const nc = c.trim(); const cr = casaCru(nc); const m = nc.match(RE) || (cr && [null, null, cr.ts, cr.inv, cr.grandeza]);
        if (!m || m[4] !== 'ENERGIA TOTAL GERADA') return;
        const pos = u + '/' + m[2] + '/' + m[3];
        let ult = null, n = 0;
        for (const r of rows) { const x = Number(String(r[i] || '').trim().replace(',', '.')); if (String(r[i] || '').trim() && Number.isFinite(x) && x > 0) { ult = x; n += 1; } }
        if (ult != null && (!melhor.has(pos) || n > melhor.get(pos).n)) melhor.set(pos, { v: ult, n });
      });
      const md = out.get(dia) || out.set(dia, new Map()).get(dia);
      for (const [pos, o] of melhor) md.set(pos, o.v);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ principal ------------------------------------------ */
(async () => {
  const t0 = Date.now();
  const lidosAnt = REFAZER ? null : await leAnterior('sg_lidos.json');
  const hist = REFAZER ? null : await leAnterior('sg_hist.json');
  const identAnt = await leAnterior('sg_ident.json');
  const H = hist || { esquema: 1, inv: {}, pid: {}, est: {}, pid5: {} };
  H.pinv = H.pinv || {}; H.pest = H.pest || {};            // potencia de 5 min dos ultimos P_DIAS dias: prova o TS do logger
  const P_DIAS = 3;
  /* 🔴 O CORTE E FEITO DURANTE A LEITURA, nao no fim (03/10/2026): na carga inteira (824 zips, seis meses) guardar a
     potencia de 5 min de todo dia e cortar depois levou o processo a 3,4 GB e o coletor de lixo a dominar o tempo. O
     resultado e o mesmo: um dia que fica entre os ultimos no fim nunca saiu dos ultimos durante a leitura */
  const corta = (s, n) => { const ds = Object.keys(s).sort(); for (const d of ds.slice(0, Math.max(0, ds.length - n))) delete s[d]; };
  const guardaP = (store, key, linhas) => { const s = store[key] || (store[key] = {});
    for (const x of linhas) { const p = x._p; delete x._p; if (p && (!s[x.d] || Object.keys(p).length > Object.keys(s[x.d]).length)) s[x.d] = p; }
    corta(s, P_DIAS); };
  const lidos = new Map(Object.entries((lidosAnt && lidosAnt.zips) || {}));
  const raw = await listaRaw();
  const novos = raw.filter((z) => lidos.get(z.nome) !== z.bytes);
  console.log('sungrow-raw: ' + raw.length + ' zips · novos ou mudados: ' + novos.length + (REFAZER ? ' (REFAZER)' : ''));

  const junta = (dias, linhas) => { for (const x of linhas) { const a = dias[x.d]; if (!a || x.n > a.n) dias[x.d] = x; } };
  let nCsv = 0;
  const tipos = {};
  for (const z of novos) {
    const [mm, tt] = z.nome.split('/');
    const u = parque(mm.slice(1)), tsPasta = 'TS' + Number(tt.slice(2));
    let es;
    try { es = entradas(await z.ler(), z.nome); } catch (e) { throw new Error(z.nome + ': ' + e.message); }
    /* o PID e identificado pelo LOGGER do mesmo zip (o logger do eletrocentro, na pasta `PID 100`): o TS do logger sai
       da energia dele contra a soma dos inversores identificados, e a caixa herda. A pasta so vale sem essa prova */
    const lidas = [];
    for (const e of es) {
      const m = e.nome.match(/HIS_([^_]+(?:_\d+)?)_(\d{12})_(\d{12})\.csv$/i);
      if (!m) continue;
      const { cab, linhas } = S.le(e.dados.toString('utf8'));
      if (!linhas.length) continue;
      lidas.push({ e, m, cab, linhas, t: S.tipo(cab) });
    }
    const logger = (lidas.find((x) => x.t === 'estacao') || { m: [null, null] }).m[1];
    for (const { e, m, cab, linhas, t } of lidas) {
      tipos[t] = (tipos[t] || 0) + 1; nCsv += 1;
      const onde = z.nome + ' :: ' + e.nome;
      if (t === 'inversor') {
        const o = H.inv[m[1]] || (H.inv[m[1]] = { ufv: u, pasta: tsPasta, dias: {} });
        const dl = S.diaInversor(cab, linhas, onde); guardaP(H.pinv, m[1], dl); junta(o.dias, dl);
      } else if (t === 'pid') {
        const end = m[1].split('_')[0];
        const id = (logger || (u + '/' + tsPasta)) + '/' + end;
        const o = H.pid[id] || (H.pid[id] = { ufv: u, pasta: tsPasta, logger, end, dias: {} });
        const serie = S.seriePid(cab, linhas, onde);
        junta(o.dias, S.diaPid(serie));
        const s5 = H.pid5[id] || (H.pid5[id] = {});
        for (const x of serie) s5[x.t] = [x.iso, x.v, x.i, x.temp, x.al, x.fa, x.st];
        const ds5 = [...new Set(Object.keys(s5).map((t) => t.slice(0, 10)))].sort();
        if (ds5.length > DIAS_5MIN) { const c5 = ds5[ds5.length - DIAS_5MIN]; for (const t of Object.keys(s5)) if (t.slice(0, 10) < c5) delete s5[t]; }
      } else if (t === 'estacao') {
        const o = H.est[m[1]] || (H.est[m[1]] = { ufv: u, pasta: tsPasta, dias: {} });
        const dl = S.diaEstacao(cab, linhas, onde); guardaP(H.pest, m[1], dl); junta(o.dias, dl);
      }
    }
    lidos.set(z.nome, z.bytes);
  }
  console.log('  lidos ' + nCsv + ' CSV ' + JSON.stringify(tipos) + ' · ' + Math.round((Date.now() - t0) / 1000) + ' s');

  // a potencia de 5 min guarda so os ultimos P_DIAS dias de cada aparelho
  for (const store of [H.pinv, H.pest]) for (const s of Object.values(store)) {
    const ds = Object.keys(s).sort(); for (const d of ds.slice(0, Math.max(0, ds.length - P_DIAS))) delete s[d]; }
  // o 5 min do PID guarda so os ultimos DIAS_5MIN dias de cada aparelho
  for (const id of Object.keys(H.pid5)) {
    const ts = Object.keys(H.pid5[id]).sort();
    const dias = [...new Set(ts.map((t) => t.slice(0, 10)))].slice(-DIAS_5MIN);
    const corte = dias[0];
    for (const t of ts) if (t.slice(0, 10) < corte) delete H.pid5[id][t];
  }

  /* -------- identificacao: contador de vida do logger = ENERGIA TOTAL GERADA do SCADA no fim do mesmo dia -------- */
  const sc = await vidaScada(4);
  const ident = { ...((identAnt && identAnt.ident) || {}) };
  let casados = 0, ambiguos = 0;
  for (const [sn, o] of Object.entries(H.inv)) {
    for (const [d, mp] of sc) {
      const x = o.dias[d]; if (!x || x.vida == null) continue;
      const hits = [...mp].filter(([p, v]) => p.startsWith(o.ufv + '/') && Math.abs(v - x.vida) <= TOL_VIDA).map(([p]) => p);
      if (hits.length === 1) { const a = ident[sn]; if (!a || a.d <= d) ident[sn] = { pos: hits[0], d, metodo: 'contador de vida' }; casados += 1; break; }
      if (hits.length > 1) ambiguos += 1;
    }
  }
  // uma posicao com DOIS numeros de serie e troca: cada um vale no seu periodo (o mais novo a partir do primeiro dia dele)
  const porPos = new Map();
  for (const [sn, a] of Object.entries(ident)) (porPos.get(a.pos) || porPos.set(a.pos, []).get(a.pos)).push(sn);
  const semPos = Object.keys(H.inv).filter((sn) => !ident[sn]);
  console.log('  identificados ' + Object.keys(ident).length + ' de ' + Object.keys(H.inv).length + ' (nesta rodada ' + casados
    + ', ambiguos ' + ambiguos + ') · posicoes com troca: ' + [...porPos.values()].filter((l) => l.length > 1).length
    + ' · sem posicao: ' + semPos.length);

  /* -------- produtos -------- */
  const pesos = {};
  const porU = {};
  for (const [sn, o] of Object.entries(H.inv)) {
    const a = ident[sn]; if (!a) continue;
    const [u, ts, inv] = a.pos.split('/');
    const dono = porPos.get(a.pos);
    // com troca, cada serie so vale a partir do seu primeiro dia e ate o primeiro dia do sucessor
    const ini = (s) => Object.keys(H.inv[s].dias).sort()[0];
    const suc = dono.filter((s) => s !== sn && ini(s) > ini(sn)).map(ini).sort()[0];
    for (const x of Object.values(o.dias)) {
      if (suc && x.d >= suc) continue;
      (porU[u] || (porU[u] = [])).push({ ...x, ufv: u, ts, inv, sn, chave: u + '/' + ts + '/' + inv });
    }
  }
  const agora = new Date().toISOString();
  for (const [u, L] of Object.entries(porU)) {
    L.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.chave < y.chave ? -1 : 1));
    pesos['sg_inv_dia_' + u + '.json'] = await escreve('sg_inv_dia_' + u + '.json', { gerado_em: agora, usina: u, esquema: 1,
      unidade: 'e kWh (subida do contador de vida); p kW; t °C; iso kΩ; ef %; v V; h_op min; lim_pct % dos instantes gerando', serie: L });
  }
  /* -------- o TS de cada LOGGER: a potencia dele a cada 5 min e a SOMA dos inversores que ele le, no mesmo carimbo.
     Contra o TS certo bate em quase todo instante; contra o vizinho erra por kW a cada instante (os TS de uma usina geram
     quase igual no dia, entao a energia do dia nao separa). Folga: 22 arredondamentos de 0,05 kW, ou 0,2 % ------- */
  const tsDoLogger = {};
  for (const [sn, o] of Object.entries(H.est)) {
    const votos = {};
    let dias = 0;
    for (const [d, pst] of Object.entries(H.pest[sn] || {})) {
      const porTs = {};
      for (const [isn, a] of Object.entries(ident)) {
        if (!a.pos.startsWith(o.ufv + '/')) continue;
        const pi = (H.pinv[isn] || {})[d]; if (!pi) continue;
        const t = a.pos.split('/')[1]; (porTs[t] || (porTs[t] = [])).push(pi);
      }
      /* a MEDIANA do erro instantaneo |soma dos inversores - logger|. Medido no M1 (28 a 30/09): o TS certo erra 0,2 a
         0,4 kW; o vizinho, 79 a 137 kW. A fracao de acertos (0,80 a 0,88) ficava encostada em qualquer limiar */
      const erro = {};
      for (const [t, Ls] of Object.entries(porTs)) {
        const e = [];
        for (const [h, v] of Object.entries(pst)) {
          if (!(v > 100)) continue;
          let s = 0, falta = false;
          for (const pi of Ls) { if (pi[h] == null) { falta = true; break; } s += pi[h]; }
          if (!falta) e.push(Math.abs(s - v));
        }
        if (e.length >= 20) { e.sort((a, b) => a - b); erro[t] = e[e.length >> 1]; }
      }
      const ord = Object.entries(erro).sort((a, b) => a[1] - b[1]);
      if (ord.length && ord[0][1] <= 2 && (ord.length === 1 || ord[1][1] >= 10)) { votos[ord[0][0]] = (votos[ord[0][0]] || 0) + 1; dias += 1; }
    }
    const melhor = Object.entries(votos).sort((a, b) => b[1] - a[1])[0];
    // a decisao PERSISTE no historico: a potencia de 5 min so guarda P_DIAS dias, e a prova de ontem continua valendo
    H.tsLogger = H.tsLogger || {};
    if (melhor && melhor[1] >= Math.max(2, 0.8 * dias)) H.tsLogger[sn] = { ts: melhor[0], por: 'potencia', dias: melhor[1], de: dias, d: Object.keys(H.pest[sn] || {}).sort().pop() };
    tsDoLogger[sn] = H.tsLogger[sn] || { ts: o.pasta, por: 'pasta', dias: 0, de: dias };
  }
  const trocados = Object.entries(tsDoLogger).filter(([sn, a]) => a.ts !== H.est[sn].pasta);
  console.log('  loggers: ' + Object.keys(tsDoLogger).length + ' · pela potencia ' + Object.values(tsDoLogger).filter((a) => a.por === 'potencia').length
    + ' · TS diferente da pasta: ' + trocados.map(([sn, a]) => H.est[sn].ufv + ' pasta ' + H.est[sn].pasta + ' -> ' + a.ts).join(', '));
  const tsPid = (o) => { const a = o.logger && tsDoLogger[o.logger]; return a ? a : { ts: o.pasta, por: 'pasta' }; };
  const pidRows = [];
  for (const [id, o] of Object.entries(H.pid)) { const a = tsPid(o);
    for (const x of Object.values(o.dias)) pidRows.push({ ...x, ufv: o.ufv, ts: a.ts, ts_por: a.por, pid: o.end, chave: o.ufv + '/' + a.ts + '/' + o.end }); }
  pidRows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.chave < y.chave ? -1 : 1));
  pesos['sg_pid_dia.json'] = await escreve('sg_pid_dia.json', { gerado_em: agora, esquema: 1,
    unidade: 'iso kΩ (impedancia de isolamento CA); v V e i mA de saida; t °C; min_saida minutos com tensao de saida', serie: pidRows });
  const p5 = {};
  for (const [id, s] of Object.entries(H.pid5)) {
    const o = H.pid[id]; if (!o) continue;
    const u = o.ufv, ch = u + '/' + tsPid(o).ts + '/' + o.end;
    for (const [t, v] of Object.entries(s)) (p5[u] || (p5[u] = [])).push({ t, ms: Date.parse(t.replace(' ', 'T') + ':00Z') + 3 * 3600e3,
      chave: ch, iso: v[0], v: v[1], i: v[2], temp: v[3], al: v[4], fa: v[5], st: v[6] });
  }
  for (const [u, L] of Object.entries(p5)) {
    L.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : x.chave < y.chave ? -1 : 1));
    pesos['sg_pid_5min_' + u + '.json'] = await escreve('sg_pid_5min_' + u + '.json', { gerado_em: agora, usina: u, esquema: 1, janela_dias: DIAS_5MIN, serie: L });
  }
  const estRows = [];
  for (const [sn, o] of Object.entries(H.est)) { const a = tsDoLogger[sn];
    for (const x of Object.values(o.dias)) estRows.push({ ...x, ufv: o.ufv, ts: a.ts, ts_por: a.por, logger: sn, chave: o.ufv + '/' + a.ts }); }
  estRows.sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.chave < y.chave ? -1 : 1));
  pesos['sg_ts_dia.json'] = await escreve('sg_ts_dia.json', { gerado_em: agora, esquema: 1,
    unidade: 'p_max kW; sp_min kW (setpoint do arranjo); taxa_min ‰; pt °C', serie: estRows });

  /* -------- conferencia: energia do dia, logger x export do SCADA, mesmo inversor e dia -------- */
  let invSc = null;
  if (process.env.LOCAL_INV_SCADA) { let b = fs.readFileSync(process.env.LOCAL_INV_SCADA); if (b[0] === 0x1f) b = zlib.gunzipSync(b); invSc = JSON.parse(b.toString('utf8')); }
  else invSc = await puxa(BLOB + 'inv_scada_hist.json');
  const scK = new Map(((invSc && invSc.serie) || []).map((l) => [l.dia + '|' + l.ufv + '/' + l.ts + '/' + l.inv, l.kwh]));
  const conf = new Map();
  for (const L of Object.values(porU)) for (const x of L) {
    const s = scK.get(x.d + '|' + x.chave);
    if (s == null || x.e == null || s <= 0) continue;
    const k = x.d + '|' + x.ufv;
    const c = conf.get(k) || conf.set(k, { d: x.d, ufv: x.ufv, n: 0, e_logger: 0, e_scada: 0, rs: [] }).get(k);
    c.n += 1; c.e_logger += x.e; c.e_scada += s; c.rs.push(x.e / s);
  }
  const confRows = [...conf.values()].map((c) => { c.rs.sort((a, b) => a - b);
    return { d: c.d, ufv: c.ufv, n: c.n, e_logger_mwh: Math.round(c.e_logger) / 1000, e_scada_mwh: Math.round(c.e_scada) / 1000,
      razao: Math.round((c.e_logger / c.e_scada) * 10000) / 10000, dentro_1pct: Math.round(100 * c.rs.filter((x) => Math.abs(x - 1) <= 0.01).length / c.rs.length * 10) / 10 }; })
    .sort((x, y) => (x.d < y.d ? -1 : x.d > y.d ? 1 : x.ufv < y.ufv ? -1 : 1));
  pesos['sg_conf.json'] = await escreve('sg_conf.json', { gerado_em: agora, esquema: 1, serie: confRows });

  pesos['sg_ident.json'] = await escreve('sg_ident.json', { gerado_em: agora, esquema: 1, ident, sem_posicao: semPos.map((sn) => ({ sn, ufv: H.inv[sn].ufv, pasta: H.inv[sn].pasta })) });
  pesos['sg_hist.json'] = await escreve('sg_hist.json', H);
  pesos['sg_lidos.json'] = await escreve('sg_lidos.json', { gerado_em: agora, zips: Object.fromEntries(lidos) });
  for (const [k, v] of Object.entries(pesos)) console.log('  ' + k.padEnd(24) + ' ' + (v / 1024).toFixed(0).padStart(6) + ' KB');
  const cf = confRows.filter((c) => c.n >= 10);
  if (cf.length) { const rz = cf.map((c) => c.razao).sort((a, b) => a - b);
    console.log('  conferencia logger x SCADA: ' + cf.length + ' usina-dias · razao p01 ' + rz[Math.floor(rz.length * 0.01)] + ' p50 ' + rz[rz.length >> 1] + ' p99 ' + rz[Math.floor(rz.length * 0.99)]); }
  console.log('fim em ' + Math.round((Date.now() - t0) / 1000) + ' s');
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
