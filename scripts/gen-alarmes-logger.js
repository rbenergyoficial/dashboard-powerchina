'use strict';
/*
 * gen-alarmes-logger.js — o código de falha e as paradas dos inversores pelo logger Sungrow, para a tela "Alarmes e ocorrências"
 * (Fase 2, 29/10/2026). A regra mora na lib-alarmes-logger.js; aqui só se lista, lê e grava.
 *
 * Lê os zips do logger no cofre (`backup-dados-scada/Sungrow_Logger/Sungrow_dados/<ano>/M<NN>/TS<NN>/<grupo>/<dd.MM A dd.MM>.zip`, o nome
 * e a versão mais nova pela lib-sungrow-cofre, a mesma do gen-sungrow) e grava em `dados`:
 *   hist/alarmes_logger_arm_<AAAA>_<MM>.json   o armazém do mês (interno): episódios por inversor e dia, a costura se refaz dele;
 *   hist/alarmes_logger_lidos.json              os zips já lidos (nome + tamanho);
 *   hist/alarmes_logger_<AAAA>_<MM>.json        o mês composto (a tela só busca quando o período passa de 7 dias);
 *   alarmes_logger.json                         os últimos 7 dias com dado.
 * 🔴 INCREMENTAL. Um dia de logger tem ~48 MB em ~380 zips (28/10/2026): cada rodada lê só o zip novo ou mudado (nome + tamanho) e só
 *    se a faixa dele chega a DE (padrão: os últimos LER_DIAS dias). DE=AAAA-MM-DD refaz o histórico desde a data (com FONTE=uniao, o que
 *    o sungrow-raw ainda tem antes de 18/10/2026).
 * 🔴 SÓ O 404 É "PRIMEIRA RODADA". Falha ao ler o armazém ou o manifesto publicado aborta: regravar sem eles apagaria o acumulado.
 * Roda no sungrow.yml, depois do gen-sungrow (o sg_ident.json identifica série → posição).
 * Env: a credencial pela lib-conteiner · COFRE=backup-dados-scada · FONTE=cofre|uniao · RAW=sungrow-raw · OUT=dados · DE · LER_DIAS=10
 *      ensaio: LOCAL_RAW_DIR (árvore M<NN>/TS<NN>/<grupo>/*.zip) + ANO · LOCAL_IDENT (sg_ident.json) · LOCAL_OUT_DIR
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const L = require('./lib-alarmes-logger.js');
const S = require('./lib-sungrow.js');
const C = require('./lib-sungrow-cofre.js');
const { entradas } = require('./lib-zip.js');

const COFRE = process.env.COFRE || C.COFRE;
const RAW = process.env.RAW || 'sungrow-raw';
const FONTE = process.env.FONTE || 'cofre';
const OUT = process.env.OUT || 'dados';
const LER_DIAS = Number(process.env.LER_DIAS || 10);
const DIAS = 7;
const parque = (nn) => 'M' + (Number(nn) === 10 ? 1 : Number(nn));   // M10 = M1 (nomenclatura das usinas)
const conteiner = (n) => require('./lib-conteiner').conteiner(n);
const nomeArm = (m) => 'hist/alarmes_logger_arm_' + m.replace('-', '_') + '.json';
const nomeMes = (m) => 'hist/alarmes_logger_' + m.replace('-', '_') + '.json';
const MANIF = 'hist/alarmes_logger_lidos.json';
const mesMais = (m, n) => { const [a, b] = m.split('-').map(Number); const x = new Date(Date.UTC(a, b - 1 + n, 1)); return x.toISOString().slice(0, 7); };
const fimMes = (m) => L.diaMais(mesMais(m, 1) + '-01', -1);

async function lePublicado(nome) {
  if (process.env.LOCAL_OUT_DIR) { const f = path.join(process.env.LOCAL_OUT_DIR, nome); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) : null; }
  const LD = require('./lib-le-dados');
  try { return await LD.json(LD.BASE + nome); }   // só o 404 é ausência (null); o resto estoura
  catch (e) { throw new Error('não consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: regravar sem ele apagaria o acumulado.'); }
}
async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { const f = path.join(process.env.LOCAL_OUT_DIR, nome); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, gz); return gz.length; }
  await conteiner(OUT).getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

// -> [{ nome (forma do sungrow-raw), ano, bytes, ler }]
async function lista() {
  if (process.env.LOCAL_RAW_DIR) {
    const out = [], ano = Number(process.env.ANO);
    if (!ano) throw new Error('LOCAL_RAW_DIR pede ANO');
    const anda = (d, rel) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name, p = path.join(d, e.name);
      if (e.isDirectory()) anda(p, r); else if (C.NOME_RAW.test(r)) out.push({ nome: r, ano, bytes: fs.statSync(p).size, ler: async () => fs.readFileSync(p) });
    } };
    anda(process.env.LOCAL_RAW_DIR, '');
    return out;
  }
  const c = conteiner(COFRE), Lc = [];
  for await (const b of c.listBlobsFlat({ prefix: C.PREFIXO })) Lc.push({ name: b.name, size: b.properties.contentLength, md5: null, lastModified: b.properties.lastModified });
  const M = C.mapeia(Lc);
  for (const r of M.recusados) console.log('::warning::RECUSADO ' + r.nome + ': ' + r.motivo);
  const deCofre = [...M.zips].map(([nome, z]) => ({ nome, ano: Number(z.ano), bytes: z.bytes, ler: async () => c.getBlobClient(z.fonte).downloadToBuffer() }));
  if (FONTE === 'cofre') return deCofre;
  if (FONTE !== 'uniao') throw new Error('FONTE ' + FONTE + ' desconhecida (cofre|uniao)');
  const rc = conteiner(RAW), raw = [];
  for await (const b of rc.listBlobsFlat()) {
    if (!C.NOME_RAW.test(b.name)) continue;
    const lm = new Date(b.properties.lastModified), ano = lm.getUTCFullYear(), fx = L.faixaDoZip(b.name, ano);
    // o sungrow-raw não tem o ano no nome: o da gravação, ou o anterior se a faixa passaria da data de gravação
    raw.push({ nome: b.name, ano: fx && fx[1] > lm.toISOString().slice(0, 10) ? ano - 1 : ano, bytes: b.properties.contentLength,
      ler: async () => rc.getBlobClient(b.name).downloadToBuffer() });
  }
  return C.uniao(raw, deCofre);
}

async function main() {
  const t0 = Date.now(), gerado = new Date().toISOString();
  const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const desde = process.env.DE || L.diaMais(hoje, -LER_DIAS);
  const manif = (await lePublicado(MANIF)) || { zips: {} };
  const zips = await lista();
  let foraForma = 0;
  const novos = zips.filter((z) => {
    const fx = L.faixaDoZip(z.nome, z.ano);
    if (!fx) { foraForma++; return false; }
    z.fx = fx;
    return fx[1] >= desde && (process.env.DE || manif.zips[z.nome] !== z.bytes);
  }).sort((a, b) => (a.fx[1] < b.fx[1] ? -1 : a.fx[1] > b.fx[1] ? 1 : a.nome < b.nome ? -1 : 1));
  console.log('zips: ' + zips.length + ' · fora da forma dd.MM A dd.MM: ' + foraForma + ' · a ler (desde ' + desde + '): ' + novos.length);

  const arms = new Map(), tocados = new Set();
  // armazém de OUTRO esquema aborta: trocá-lo por um vazio com o manifesto dizendo que os zips já foram lidos apagaria o mês para sempre
  // (nenhuma rodada relê aqueles zips). Mudança de esquema = rodada com DE=<início do armazém>, que relê tudo e regrava.
  const arm = async (m) => { if (!arms.has(m)) { const a = await lePublicado(nomeArm(m));
    if (a && a.esquema !== L.ESQUEMA && !process.env.DE) throw new Error(nomeArm(m) + ' tem o esquema ' + a.esquema + ' (a lib é ' + L.ESQUEMA + '): rode com DE=<1º dia do armazém> para reler os zips');
    arms.set(m, a && a.esquema === L.ESQUEMA ? a : L.armVazio()); } return arms.get(m); };
  let nCsv = 0;
  for (const z of novos) {
    const u = parque(z.nome.slice(1, 3));
    let es; try { es = entradas(await z.ler(), z.nome); } catch (e) { throw new Error(z.nome + ': ' + e.message); }
    for (const e of es) {
      const m = e.nome.match(/HIS_([^_]+(?:_\d+)?)_(\d{12})_(\d{12})\.csv$/i);
      if (!m) continue;
      const { cab, linhas } = S.le(e.dados.toString('utf8'));
      if (!linhas.length || S.tipo(cab) !== 'inversor') continue;
      nCsv++;
      const porMes = new Map();
      for (const d of L.diaAlarmes(cab, linhas, z.nome + '/' + e.nome)) (porMes.get(d.d.slice(0, 7)) || porMes.set(d.d.slice(0, 7), []).get(d.d.slice(0, 7))).push(d);
      for (const [mes, ds] of porMes) for (const d of L.junta(await arm(mes), m[1], u, ds)) tocados.add(d);
    }
    manif.zips[z.nome] = z.bytes;
  }
  console.log(nCsv + ' CSV de inversor lidos · ' + tocados.size + ' dia(s) com inversor-dia novo ou maior');

  // o mês composto: o anterior e o seguinte entram para costurar a virada
  const meses = [...new Set([...tocados].map((d) => d.slice(0, 7)))].sort();
  const identJ = process.env.LOCAL_IDENT ? JSON.parse(fs.readFileSync(process.env.LOCAL_IDENT, 'utf8')) : await lePublicado('sg_ident.json');
  if (!identJ || !identJ.ident) throw new Error('sg_ident.json ausente: sem ele nenhum inversor tem posição');
  const ident = identJ.ident;
  for (const m of meses) {
    const o = L.compoe([await arm(mesMais(m, -1)), await arm(m), await arm(mesMais(m, 1))], ident, m + '-01', fimMes(m), { gerado });
    const kb = await escreve(nomeMes(m), o);
    console.log(nomeMes(m) + ': ' + o.dias.length + ' dia(s), ' + o.ev.length + ' eventos, ' + o.sem_posicao.length + ' série(s) sem posição, ' + Math.round(kb / 1024) + ' KB gzip');
  }
  // os 7 dias até o último com dado
  const ult = [...arms.values()].flatMap((a) => Object.keys(a.dias)).sort().pop()
    || (await (async () => { for (let k = 0; k < 3; k++) { const a = await arm(mesMais(hoje.slice(0, 7), -k)); const d = Object.keys(a.dias).sort().pop(); if (d) return d; } return null; })());
  if (!ult) throw new Error('nenhum dia com dado do logger no armazém');
  const de = L.diaMais(ult, -(DIAS - 1));
  const j = L.compoe([await arm(mesMais(de.slice(0, 7), -1)), await arm(de.slice(0, 7)), ...(ult.slice(0, 7) !== de.slice(0, 7) ? [await arm(ult.slice(0, 7))] : [])],
    ident, de, ult, { gerado });
  const kb = await escreve('alarmes_logger.json', j);
  console.log('alarmes_logger.json: ' + de + ' a ' + ult + ', ' + j.dias.length + ' dia(s) com dado, ' + j.ev.length + ' eventos, ' + Math.round(kb / 1024) + ' KB gzip');
  if (j.dias.length < DIAS) console.log('::warning::a janela de ' + DIAS + ' dias tem só ' + j.dias.length + ' dia(s) com dado');

  // o armazém e o manifesto por ÚLTIMO: se algo acima estourou, a próxima rodada relê os mesmos zips
  for (const [m, a] of arms) if ([...tocados].some((d) => d.startsWith(m))) await escreve(nomeArm(m), a);
  await escreve(MANIF, manif);
  console.log('✅ ' + Math.round((Date.now() - t0) / 1000) + ' s');
}

main().catch((e) => { console.error('🔴 ' + (e.stack || e.message)); process.exit(1); });
