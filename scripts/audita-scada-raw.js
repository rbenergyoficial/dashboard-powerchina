/*
 * audita-scada-raw.js — o que ha DENTRO dos despejos do SCADA que ninguem consome.
 *
 * O container `scada-raw` recebe, alem dos CSV diarios, alguns arquivos SOLTOS: despejos de 365
 * dias em 30 minutos que a equipe exporta de vez em quando. Em 25/08/2026 eram tres — IIRR (as
 * estacoes solarimetricas), IRR (o grupo GER_IRR) e Trafo (os dois transformadores da SE) — e so
 * o primeiro tinha gerador. Este auditor responde as duas perguntas que precedem qualquer painel:
 *
 *   VOCAB — que colunas existem, agrupadas por equipamento, SEM truncar. Desenhar painel a partir
 *           de um cabecalho cortado e desenhar de memoria.
 *   PAR   — duas colunas de arquivos diferentes medem a MESMA coisa ou sao sensores distintos?
 *           A pergunta decide se um arquivo redundante vira conferencia independente ou lixo.
 *
 * 🔴 So LE. Nao grava blob nenhum, e por isso pode rodar a qualquer momento.
 *
 * Uso (variaveis de ambiente):
 *   ALVOS=IIRR_2026,Trafo_2026        pedacos de nome; a busca e por SUBSTRING, sem ancora
 *   MODO=vocab                        (padrao) vocabulario de colunas
 *   MODO=inv   ALVOS=M01_2026        quais INV existem no cabecalho, por TS, e quais vem vazios
 *   MODO=par  PAR_A=IRR_20260807  PAR_B=IIRR_20260808  PAR_COL='IRRADIAÇÃO INCLINADA'
 */
const { BlobServiceClient } = require('@azure/storage-blob');
const zlib = require('zlib');

const RAW = process.env.RAW_CONTAINER || 'scada-raw';
const MODO = (process.env.MODO || 'vocab').toLowerCase();

const cli = () => BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW);

async function acha(c, pedaco) {
  const p = pedaco.toLowerCase();
  const hits = [];
  let total = 0;
  for await (const b of c.listBlobsFlat()) {
    total++;
    if (b.name.toLowerCase().includes(p)) hits.push({ nome: b.name, bytes: b.properties.contentLength || 0 });
  }
  // 🔴 A guarda diz o TOTAL, nao so o casado: uma varredura que devolve "0" sem dizer de quantos
  // ja me fez concluir "o arquivo nao existe" quando o padrao e que estava errado.
  if (!hits.length) throw new Error('nenhum blob contendo "' + pedaco + '" — 0 de ' + total + ' no container');
  hits.sort((a, b) => b.bytes - a.bytes);
  return hits[0];
}

async function le(c, nome) {
  const buf = await c.getBlobClient(nome).downloadToBuffer();
  const txt = (buf[0] === 0x1f && buf[1] === 0x8b) ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
  const linhas = txt.split(/\r?\n/).filter((l) => l.length);
  const cab = linhas[0].replace(/^﻿/, '').split(';').map((x) => x.trim());
  return { cab, linhas };
}

// separa IDENTIFICADOR (equipamento) de GRANDEZA sem supor formato: onde ha espaco, o
// identificador e o que vem antes dele; onde nao ha (tag IEC 61850), a quebra e o ultimo ponto.
function parte(c) {
  if (c.includes(' ')) return [c.slice(0, c.indexOf(' ')), c.slice(c.indexOf(' ') + 1)];
  const i = c.lastIndexOf('.');
  return i < 0 ? [c, '(sem)'] : [c.slice(0, i), c.slice(i + 1)];
}

const num = (v) => {
  if (v == null) return null;
  const s = String(v).trim().replace(',', '.');       // ⚠️ decimal com VIRGULA no export
  if (!s || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
};

async function vocab(c, pedaco) {
  const a = await acha(c, pedaco);
  const { cab, linhas } = await le(c, a.nome);
  console.log('\n==== ' + a.nome + '  ' + Math.round(a.bytes / 1024) + ' KB · '
    + cab.length + ' colunas · ' + (linhas.length - 1) + ' linhas de dado');
  console.log('  carimbo de tempo: ' + JSON.stringify(cab[0]) + ' -> primeiro '
    + JSON.stringify(linhas[1].split(';')[0]) + ' · ultimo '
    + JSON.stringify(linhas[linhas.length - 1].split(';')[0]));

  const grupos = new Map();
  for (const col of cab.slice(1)) {
    const [id, g] = parte(col);
    if (!grupos.has(id)) grupos.set(id, []);
    grupos.get(id).push(g);
  }
  // quantas colunas de cada grupo tem ALGUM valor: coluna sempre vazia nao serve de painel
  const cheias = new Array(cab.length).fill(0);
  for (let i = 1; i < linhas.length; i++) {
    const p = linhas[i].split(';');
    for (let j = 1; j < cab.length; j++) if (num(p[j]) != null) cheias[j]++;
  }
  const idx = new Map(cab.map((c2, j) => [c2, j]));

  console.log('  grupos de equipamento: ' + grupos.size);
  for (const [id, gs] of [...grupos].sort((a, b) => b[1].length - a[1].length)) {
    console.log('\n  --- ' + id + '  (' + gs.length + ' colunas)');
    for (const g of gs) {
      // 🔴 O nome da coluna se RECUPERA do cabecalho, nunca se remonta juntando id + separador:
      // remontar exige adivinhar qual separador era, e erra calado na tag IEC 61850.
      const nomeCol = cab.find((x) => parte(x)[0] === id && parte(x)[1] === g);
      const j = idx.get(nomeCol);
      const n = cheias[j] || 0;
      const pct = ((n / (linhas.length - 1)) * 100).toFixed(0);
      console.log('      ' + (n ? String(pct).padStart(3) + '% cheia' : '  VAZIA  ') + '  ' + g);
    }
  }
}

async function par(c) {
  const A = await acha(c, process.env.PAR_A);
  const B = await acha(c, process.env.PAR_B);
  const alvo = (process.env.PAR_COL || '').toUpperCase();
  console.log('\n==== PAR · "' + alvo + '"');
  console.log('  A = ' + A.nome + '\n  B = ' + B.nome);
  const a = await le(c, A.nome), b = await le(c, B.nome);

  // indexa B por carimbo de tempo
  const bIdx = new Map();
  for (let i = 1; i < b.linhas.length; i++) {
    const p = b.linhas[i].split(';');
    bIdx.set(p[0].trim(), p);
  }

  // casa coluna por USINA: o identificador tem o codigo MRTxx nos dois arquivos, com prefixos
  // diferentes (GER_IRR x WS). A usina e o que se usa para parear, nunca o nome inteiro da coluna.
  const usinaDe = (s) => (s.match(/MRT(\d{2})/) || [])[1];
  const colsA = a.cab.map((x, j) => ({ x, j })).filter((o) => o.x.toUpperCase().includes(alvo));
  const colsB = b.cab.map((x, j) => ({ x, j })).filter((o) => o.x.toUpperCase().includes(alvo));
  if (!colsA.length || !colsB.length) throw new Error('coluna nao encontrada: A=' + colsA.length + ' B=' + colsB.length);

  console.log('\n  usina    pares      max|dif|     media A     media B     razao A/B   iguais');
  for (const ca of colsA) {
    const u = usinaDe(ca.x);
    const cb = colsB.find((o) => usinaDe(o.x) === u);
    if (!u || !cb) continue;
    let n = 0, maxd = 0, sa = 0, sb = 0, ident = 0;
    for (let i = 1; i < a.linhas.length; i++) {
      const pa = a.linhas[i].split(';');
      const pb = bIdx.get(pa[0].trim());
      if (!pb) continue;
      const va = num(pa[ca.j]), vb = num(pb[cb.j]);
      if (va == null || vb == null) continue;
      n++; sa += va; sb += vb;
      const d = Math.abs(va - vb);
      if (d > maxd) maxd = d;
      if (d < 1e-9) ident++;
    }
    if (!n) { console.log('  MRT' + u + '   sem par'); continue; }
    console.log('  MRT' + u + '  ' + String(n).padStart(7) + '  ' + maxd.toFixed(3).padStart(11)
      + '  ' + (sa / n).toFixed(2).padStart(10) + '  ' + (sb / n).toFixed(2).padStart(10)
      + '  ' + (sb ? (sa / sb).toFixed(4) : '-').padStart(11)
      + '  ' + ((ident / n) * 100).toFixed(1) + '%');
  }
  // 🔴 A TERCEIRA LEITURA, que a primeira versao deste auditor nao oferecia e por isso quase me
  // fez concluir errado: media igual com diferenca instantanea enorme e a assinatura de ROTULO DE
  // TEMPO DESLOCADO, nao de sensor diferente. Ao longo de um ano um deslocamento de um balde nao
  // mexe na media e estoura o maximo em toda rampa e toda nuvem. Ja inverteu conclusao duas vezes
  // neste projeto (o balde do MUST e a borda da Way2), entao aqui ele e MEDIDO, nao suposto:
  // varre-se o deslocamento e escolhe-se pelo erro, como o gen-comparativo faz.
  const ca0 = colsA[0], cb0 = colsB.find((o) => usinaDe(o.x) === usinaDe(ca0.x));
  if (ca0 && cb0) {
    const linsA = a.linhas.slice(1).map((l) => l.split(';'));
    const carimbos = b.linhas.slice(1).map((l) => l.split(';')[0].trim());
    const posB = new Map(carimbos.map((t, i) => [t, i]));
    const linsB = b.linhas.slice(1).map((l) => l.split(';'));
    console.log('\n  varredura de deslocamento em ' + ('MRT' + usinaDe(ca0.x)) + ' (balde de 30 min):');
    console.log('  desloc    pares    media|dif|     max|dif|   iguais');
    for (let d = -2; d <= 2; d++) {
      let n = 0, soma = 0, maxd = 0, ident = 0;
      for (let i = 0; i < linsA.length; i++) {
        const j = posB.get(linsA[i][0].trim());
        if (j == null) continue;
        const k = j + d;
        if (k < 0 || k >= linsB.length) continue;
        const va = num(linsA[i][ca0.j]), vb = num(linsB[k][cb0.j]);
        if (va == null || vb == null) continue;
        n++; const dif = Math.abs(va - vb); soma += dif;
        if (dif > maxd) maxd = dif;
        if (dif < 1e-9) ident++;
      }
      if (!n) { console.log('  ' + String(d).padStart(6) + '        sem par'); continue; }
      console.log('  ' + String(d).padStart(6) + '  ' + String(n).padStart(7) + '  '
        + (soma / n).toFixed(3).padStart(12) + '  ' + maxd.toFixed(3).padStart(11)
        + '  ' + ((ident / n) * 100).toFixed(1) + '%');
    }
    console.log('\n  Se o menor erro cair em desloc 0 e ainda assim for grande, sao MEDICOES');
    console.log('  DISTINTAS — dois sensores, e os dois viram conferencia independente.');
    console.log('  Se o menor erro cair em -1 ou +1 e ficar perto de zero, e a MESMA medicao com');
    console.log('  rotulo de tempo diferente, e o arquivo redundante nao acrescenta nada.');
  }
}

/*
 * MODO=stats — faixa de cada coluna com dado.
 *
 * 🔴 Existe para NAO batizar coluna no chute. Uma tag `CMMXU1_A_phsA` diz "corrente do ponto de
 * medicao 1", e nao diz se o ponto 1 e a alta ou a baixa tensao. Isso a FISICA responde sem
 * empate: um barramento de 230 kV le ~238, um de 34,5 kV le ~35. E a mesma forma com que o canal
 * `Demat` foi identificado — a assinatura do dado decide, nunca o nome.
 */
async function stats(c, pedaco) {
  const a = await acha(c, pedaco);
  const { cab, linhas } = await le(c, a.nome);
  console.log('\n==== ' + a.nome + '  ' + cab.length + ' colunas · ' + (linhas.length - 1) + ' linhas');
  const acc = cab.map(() => ({ n: 0, min: Infinity, max: -Infinity, soma: 0, vals: [] }));
  const PASSO = Math.max(1, Math.floor((linhas.length - 1) / 4000));   // amostra para a mediana
  for (let i = 1; i < linhas.length; i++) {
    const p = linhas[i].split(';');
    for (let j = 1; j < cab.length; j++) {
      const v = num(p[j]);
      if (v == null) continue;
      const o = acc[j];
      o.n++; o.soma += v;
      if (v < o.min) o.min = v;
      if (v > o.max) o.max = v;
      if (i % PASSO === 0) o.vals.push(v);
    }
  }
  console.log('  coluna                                              n        min      mediana         max');
  for (let j = 1; j < cab.length; j++) {
    const o = acc[j];
    if (!o.n) continue;
    o.vals.sort((x, y) => x - y);
    const med = o.vals.length ? o.vals[o.vals.length >> 1] : o.soma / o.n;
    console.log('  ' + cab[j].slice(-50).padEnd(50) + ' ' + String(o.n).padStart(6)
      + ' ' + o.min.toFixed(2).padStart(10) + ' ' + med.toFixed(2).padStart(12)
      + ' ' + o.max.toFixed(2).padStart(11));
  }
}

// ---------- MODO inv: quem EXISTE no cabecalho do export de inversores -------------------------
//
// A pergunta que este modo responde e uma so, e ela precede qualquer conclusao sobre falta de
// inversor: o inversor que nao aparece no blob esta AUSENTE DO ARQUIVO, ou esta no arquivo com a
// coluna VAZIA? Sao dois defeitos diferentes, com donos diferentes — escopo do export contra
// comunicacao do equipamento — e a tela nao distingue os dois.
//
// 🔴 O PADRAO AQUI E DE PROPOSITO MAIS FROUXO QUE O DO GERADOR. Se ele fosse o mesmo, este
//    auditor validaria a peneira do gerador contra a propria peneira, e um inversor que o
//    gerador deixa cair por causa do padrao sairia daqui como "nao existe no arquivo". E o
//    mesmo defeito de forma da guarda que compara o resultado com a premissa que o produziu.
const INV_FROUXO = /^UFV_\w+_(TS\d+)_(INV\d+)_/;
const INV_GERADOR = /^UFV_(\w+?)_(TS\d+)_(INV\d+)_\1 \2 \3 (.+?)(_\d)?$/;

let LISTA = null;                      // o container tem milhares de blobs; lista-se UMA vez
async function lista(c) {
  if (LISTA) return LISTA;
  LISTA = [];
  for await (const b of c.listBlobsFlat()) {
    LISTA.push({ nome: b.name, bytes: b.properties.contentLength || 0 });
  }
  return LISTA;
}

async function inventario(c, pedaco) {
  // o mais RECENTE, nao o maior: os diarios tem tamanho parecido e o nome carrega a data
  const p = pedaco.toLowerCase();
  const todos = await lista(c);
  const hits = todos.filter((b) => b.nome.toLowerCase().includes(p));
  if (!hits.length) throw new Error('nenhum blob contendo "' + pedaco + '" — 0 de ' + todos.length);
  hits.sort((a, b) => (a.nome < b.nome ? 1 : -1));
  const a = hits[0];
  const { cab, linhas } = await le(c, a.nome);
  const nLin = linhas.length - 1;

  const porTs = new Map();               // TS -> Map(INV -> { cols, cheias, gerador })
  cab.forEach((col, j) => {
    const m = col.match(INV_FROUXO);
    if (!m) return;
    if (!porTs.has(m[1])) porTs.set(m[1], new Map());
    const t = porTs.get(m[1]);
    if (!t.has(m[2])) t.set(m[2], { cols: [], cheias: 0, gerador: 0, exemplo: null });
    const o = t.get(m[2]);
    o.cols.push(j);
    if (INV_GERADOR.test(col)) o.gerador++;
    // 🔴 guarda-se UM nome de coluna recusada. Sem ele o auditor diz QUANTAS o gerador rejeita e
    //    nao diz por que — e mexer no regex as cegas e como reescrever o padrao de memoria.
    else if (!o.exemplo) o.exemplo = col;
  });
  // preenchimento: uma passada so pelo arquivo, contando por coluna
  const cheias = new Array(cab.length).fill(0);
  for (let i = 1; i < linhas.length; i++) {
    const q = linhas[i].split(';');
    for (let j = 1; j < cab.length; j++) if (num(q[j]) != null) cheias[j]++;
  }
  for (const t of porTs.values()) {
    for (const o of t.values()) o.cheias = o.cols.reduce((s, j) => s + (cheias[j] || 0), 0);
  }

  console.log('\n==== ' + a.nome + '  ' + Math.round(a.bytes / 1024) + ' KB · '
    + cab.length + ' colunas · ' + nLin + ' linhas · ' + hits.length + ' arquivo(s) casaram');
  let nInv = 0, nVazios = 0, nSoFrouxo = 0;
  for (const [ts, t] of [...porTs].sort()) {
    const ivs = [...t].sort();
    const vazios = ivs.filter(([, o]) => !o.cheias).map(([i]) => i);
    const soFrouxo = ivs.filter(([, o]) => !o.gerador).map(([i]) => i);
    nInv += ivs.length; nVazios += vazios.length; nSoFrouxo += soFrouxo.length;
    console.log('  ' + ts.padEnd(5) + ' no cabecalho: ' + String(ivs.length).padStart(3)
      + ' · com algum valor: ' + String(ivs.length - vazios.length).padStart(3)
      + (vazios.length ? '   VAZIOS: ' + vazios.join(' ') : '')
      + (soFrouxo.length ? '   SO NO PADRAO FROUXO: ' + soFrouxo.join(' ') : ''));
    for (const [i, o] of ivs) {
      if (!o.gerador && o.exemplo) console.log('        ' + ts + ' ' + i + ' recusada: ' + o.exemplo);
    }
  }
  console.log('  TOTAL no cabecalho ' + nInv + ' · vazios ' + nVazios
    + ' · com dado ' + (nInv - nVazios) + ' · rejeitados pelo padrao do gerador ' + nSoFrouxo);
}

(async () => {
  if (!process.env.DADOS_STORAGE) throw new Error('sem DADOS_STORAGE');
  const c = cli();
  if (MODO === 'inv') {
    for (const p of (process.env.ALVOS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      await inventario(c, p);
    }
    return;
  }
  if (MODO === 'par') { await par(c); return; }
  if (MODO === 'stats') {
    for (const p of (process.env.ALVOS || '').split(',').map((x) => x.trim()).filter(Boolean)) await stats(c, p);
    return;
  }
  for (const p of (process.env.ALVOS || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    await vocab(c, p);
  }
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
