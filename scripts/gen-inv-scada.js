/*
 * gen-inv-scada.js — SCADA por INVERSOR -> dados/inv_scada.json
 *
 * A PERGUNTA QUE ELE RESPONDE: qual inversor esta rendendo abaixo dos seus pares, HOJE, antes de
 * queimar. A pagina de Confiabilidade ja mostra o inversor DEPOIS da troca (P1) e os alarmes do
 * SCADA (P2); o que faltava era o degrau anterior — o que gera menos que os vizinhos e ainda nao
 * deu alarme.
 *
 * FONTE: os CSV diarios por usina que o fluxo "SCADA SharePoint para Blob" copia da pasta
 *   11 - Dados_Scada_PWC para o container scada-raw. Um arquivo por usina e por dia,
 *   M<NN>_<AAAAMMDD>_<HHMMSS>.csv, `;` como separador, BOM, 48 leituras de 30 min.
 *
 * ⚠️ O NOME DO BLOB VEM PREFIXADO pelo id do item do SharePoint (77884_IIRR_...). Por isso o
 *   casamento e por CARIMBO em qualquer posicao do nome, nunca ancorado no inicio — foi
 *   exatamente uma ancora em ^ que fez o gerador de irradiancia dizer "0 candidatos" com o
 *   arquivo presente.
 *
 * 🔴 O DADO NAO ESTA NA COLUNA QUE O NOME SUGERE. O export repete cada bloco de inversor ate tres
 *   vezes, com sufixo _2 e _3, e MEDIDO em 23/08/2026 no M02:
 *        (sem sufixo)  88 colunas ·  6 com dado
 *        _2            83 colunas · 82 com dado   <- o dado esta aqui
 *        _3            81 colunas ·  0 com dado
 *   O gerador de irradiancia documenta que ali o _2 e duplicata VAZIA. Carregar aquela regra para
 *   ca produziria um ranking sobre 6 de 88 inversores — e ele pareceria plausivel na tela.
 *   Entao a regra aqui e OUTRA: para cada (TS, inversor, grandeza) escolhe-se a coluna que
 *   REALMENTE tem valores naquele dia. Auto-corrige se o layout do export mudar de novo.
 *
 * A CONTA: `ENERGIA DIÁRIA GERADA` e contador diario acumulado (medido: 0 -> 1,45 -> 141 -> 733,8
 *   e estabiliza a noite). A energia do dia e o MAIOR valor do dia, nao a soma.
 *   razao = energia do inversor / MEDIANA dos pares do mesmo TS no mesmo dia.
 *
 * ⚠️ O par e o TS, nao a usina: mesmo transformador, mesmo arranjo, mesma sombra e mesma sujeira.
 *   TS com menos de MIN_PARES inversores reportando cai para a mediana da USINA — mediana de tres
 *   nao separa defeito de acaso.
 *
 * Env: DADOS_STORAGE · RAW_CONTAINER=scada-raw · OUT_CONTAINER=dados · OUT_BLOB=inv_scada.json
 *      DIAS=60 (janela) · LOCAL_DIR / LOCAL_OUT para ensaio.
 */
const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'inv_scada.json';
const DIAS = Number(process.env.DIAS || 60);          // quanto do BRUTO reprocessar a cada rodada
// 🔴 A FONTE SO GUARDA ~38 DIAS. Enquanto o gerador reescrevia o blob inteiro a cada rodada, o
//    historico ficava PRESO nesse tanto para sempre — nao por escolha, por construcao. Acumulando,
//    ele cresce um dia por rodada a partir de agora. Mesmo padrao do gerador de perdas.
const JANELA = Number(process.env.JANELA || 365);     // quanto o HISTORICO guarda
const HIST_BLOB = process.env.HIST_BLOB || 'inv_scada_hist.json';
// 🔴 O HISTORICO NAO VAI NO BLOB QUE O PAINEL LE. Medido em 03/09/2026: a serie custa 8 KB por dia
//    na rede, entao um ano seriam 2,9 MB e 403 mil linhas — e o Infinity baixa a URL INTEIRA antes
//    de aplicar o JSONata. O painel passa a ler agregados que o gerador ja calculou, e o bruto fica
//    num blob separado que so este gerador le.
const TOP_SERIE = 20;                                 // de quantos piores a serie diaria e publicada
const MIN_DIAS = 10;
const msDoDia = (dia) => Date.parse(dia + 'T00:00:00Z') + 3 * 3600e3;   // 00:00 BRT (UTC-3)                                  // abaixo disso a mediana do inversor nao decide
const MIN_PARES = 5;                       // abaixo disso a mediana do TS nao separa defeito de acaso
const GRANDEZA = 'ENERGIA DIÁRIA GERADA';
// grandezas de SAUDE que acompanham o inversor no ranking. Nao entram na razao — servem para quem
// abrir a linha entender se a queda tem cara de sujeira, de temperatura ou de isolamento.
const SAUDE = ['TEMPERATURA INTERNA', 'RESISTÊNCIA DE ISOLAÇÃO', 'TENSÃO NEGATIVA À TERRA'];

const zlib = require('zlib');
const norm = (s) => String(s == null ? '' : s).trim();
const num = (v) => { const s = norm(v).replace(',', '.'); if (!s) return null; const n = Number(s); return isFinite(n) ? n : null; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const mediana = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// M<NN>_<AAAAMMDD>_<HHMMSS>.csv em qualquer posicao do nome (o blob vem prefixado pelo id)
const CARIMBO = /M(\d{2})_(\d{8})_\d{6}\.csv$/i;
const parque = (nn) => 'M' + (Number(nn) === 10 ? 1 : Number(nn));   // M10 = M1, ver a nomenclatura

// ---------- entrada -------------------------------------------------------------------------
async function listaArquivos() {
  if (process.env.LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    return fs.readdirSync(process.env.LOCAL_DIR).filter((n) => CARIMBO.test(n))
      .map((n) => ({ nome: n, ler: async () => fs.readFileSync(path.join(process.env.LOCAL_DIR, n)) }));
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(conn).getContainerClient(RAW_CONTAINER);
  const out = []; let total = 0;
  for await (const b of c.listBlobsFlat()) {
    total++;
    if (!CARIMBO.test(b.name.split('/').pop())) continue;
    out.push({ nome: b.name, ler: async () => c.getBlobClient(b.name).downloadToBuffer() });
  }
  console.log('  container "' + RAW_CONTAINER + '": ' + total + ' blob(s) · ' + out.length + ' arquivo(s) de usina/dia');
  return out;
}

function puxa(url) {
  const https = require('https');
  return new Promise((ok, ko) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname, family: 4, headers: { 'accept-encoding': 'gzip' } }, (r) => {
      if (r.statusCode !== 200) { ko(new Error(url + ' -> HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        try { ok(JSON.parse(b.toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

// 🔴 SO O 404 DEVOLVE VAZIO. Qualquer outra falha — 500, gzip corrompido, JSON truncado — ESTOURA.
//    A versao ingenua devolve vazio para tudo, o gerador trata como primeira execucao e regrava o
//    blob so com os dias desta rodada: uma falha de rede apagaria o historico inteiro, sem erro
//    visivel. E a licao que o `leBlob` do MUST ja pagou.
async function leHistorico() {
  if (process.env.LOCAL_OUT_DIR) {
    const fs = require('fs'), path = require('path');
    const f = path.join(process.env.LOCAL_OUT_DIR, HIST_BLOB);
    if (!fs.existsSync(f)) return [];
    let b = fs.readFileSync(f); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    const j = JSON.parse(b.toString('utf8'));
    return Array.isArray(j.serie) ? j.serie : [];
  }
  try {
    const j = await puxa('https://rbenergydata.blob.core.windows.net/dados/' + HIST_BLOB);
    return Array.isArray(j.serie) ? j.serie : [];
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return [];
    throw new Error('nao consegui ler o ' + HIST_BLOB + ' publicado (' + e.message
      + '). Abortando: regravar sem o historico apagaria o que ja foi acumulado.');
  }
}

// funde o que veio agora com o que ja estava publicado. A rodada NOVA ganha na colisao, porque um
// dia pode voltar mais completo do que da primeira vez.
function acumula(antigas, novas, chave, dias) {
  const m = new Map();
  for (const l of antigas) m.set(chave(l), l);
  let n = 0;
  for (const l of novas) { if (!m.has(chave(l))) n++; m.set(chave(l), l); }
  let todas = [...m.values()];
  const ds = [...new Set(todas.map((l) => l.dia))].sort();
  const corte = ds.slice(-dias)[0];
  todas = todas.filter((l) => l.dia >= corte);
  todas.sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0));
  return { serie: todas, novas: n, mantidas: todas.length - n };
}

async function escreve(obj, nome) {
  const json = JSON.stringify(obj);
  const gz = zlib.gzipSync(Buffer.from(json));
  const alvo = nome || OUT_BLOB;
  if (process.env.LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(process.env.LOCAL_OUT_DIR, alvo), gz); return gz.length; }
  if (process.env.LOCAL_OUT && alvo === OUT_BLOB) { require('fs').writeFileSync(process.env.LOCAL_OUT, gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cont = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(alvo).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

// ---------- um arquivo = uma usina num dia --------------------------------------------------
function leUsinaDia(buf) {
  const txt = buf.toString('utf8').replace(/^﻿/, '').replace(/\r/g, '');
  const L = txt.split('\n');
  const cols = L[0].split(';');
  const linhas = [];
  for (let k = 1; k < L.length; k++) if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2};/.test(L[k])) linhas.push(L[k].split(';'));
  if (!linhas.length) return null;

  // (TS, INV, grandeza) -> lista de colunas candidatas, QUALQUER sufixo
  const cand = new Map();
  // 🔴 O RETROVISOR (\1 \2 \3) E O QUE ANCORA. A coluna repete o proprio prefixo antes do rotulo:
  //   UFV_MRT02_TS1_INV01_MRT02 TS1 INV01 TENSÃO MPPT 01
  // Esta forma foi MEDIDA contra o arquivo real. A primeira versao deste gerador a "simplificou"
  // para /_.*?\s(.+?)(_\d)?$/ — lazy e sem ancora — e nao casou NADA: 45 arquivos, zero
  // inversores, e a mensagem so dizia "o layout mudou?". Trocar padrao verificado por padrao
  // parecido e a mesma familia do regex ancorado em ^ que ja custou uma rodada hoje.
  const RE = /^UFV_(\w+?)_(TS\d+)_(INV\d+)_\1 \2 \3 (.+?)(_\d)?$/;
  const vistas = [];
  cols.forEach((c, i) => {
    const m = norm(c).match(RE);
    if (!m) { if (vistas.length < 3 && /^UFV_.*INV\d/.test(norm(c))) vistas.push(norm(c).slice(0, 80)); return; }
    const g = m[4];
    if (g !== GRANDEZA && !SAUDE.includes(g)) return;
    const k = m[2] + '|' + m[3] + '|' + g;
    (cand.get(k) || cand.set(k, []).get(k)).push(i);
  });

  // 🔴 escolhe a coluna que TEM dado, em vez de supor o sufixo
  const inv = new Map();     // "TS|INV" -> { kwh, saude:{} }
  for (const [k, idxs] of cand) {
    const [ts, iv, g] = k.split('|');
    let melhor = null, melhorN = 0;
    for (const i of idxs) {
      let n = 0; for (const l of linhas) if (num(l[i]) != null) n++;
      if (n > melhorN) { melhorN = n; melhor = i; }
    }
    if (!melhorN) continue;
    const vals = linhas.map((l) => num(l[melhor])).filter((v) => v != null);
    const kk = ts + '|' + iv;
    const o = inv.get(kk) || inv.set(kk, { ts, inv: iv, kwh: null, saude: {} }).get(kk);
    if (g === GRANDEZA) o.kwh = Math.max(...vals);          // contador diario: o dia e o MAIOR valor
    else o.saude[g] = r2(vals[vals.length - 1]);            // saude: a ultima leitura do dia
  }
  // ⚠️ A falha tem de DIZER O QUE VIU. Sem isto, "nenhum inversor com energia" manda adivinhar
  // entre layout mudado, grandeza renomeada e regex errado — e foi o regex, das tres vezes.
  const achados = [...inv.values()].filter((x) => x.kwh != null);
  if (!achados.length && vistas.length) console.log('    colunas de inversor que NAO casaram: ' + vistas.join(' | '));
  return { dia: linhas[0][0].slice(0, 10), inversores: achados };
}

// ---------- razao contra os pares ------------------------------------------------------------
function comparaComPares(reg) {
  const porTS = {};
  for (const x of reg.inversores) (porTS[x.ts] = porTS[x.ts] || []).push(x.kwh);
  const medUsina = mediana(reg.inversores.map((x) => x.kwh).filter((v) => v > 0));
  const out = [];
  for (const x of reg.inversores) {
    const pares = (porTS[x.ts] || []).filter((v) => v > 0);
    // ⚠️ TS pequeno cai para a usina: mediana de tres nao separa defeito de acaso
    const usouTS = pares.length >= MIN_PARES;
    const base = usouTS ? mediana(pares) : medUsina;
    out.push({ ts: x.ts, inv: x.inv, kwh: r2(x.kwh),
      razao: base > 0 ? r2(x.kwh / base) : null,
      base: usouTS ? 'ts' : 'usina', pares: pares.length, saude: x.saude });
  }
  return out;
}

// ---------- principal -------------------------------------------------------------------------
(async () => {
  const arqs = await listaArquivos();
  // ⏱️ MODO INVENTARIO: LISTAR=1 imprime todo nome de blob e sai. Existe para responder
  // "o que ha no container?" sem precisar de listagem anonima, que o Azure nao permite aqui.
  if (process.env.LISTAR) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW_CONTAINER);
    const nomes = [];
    // 🔴 O `\d` aqui ja esteve SEM a barra (`/^d+_/`), que casa a letra "d" e nao um digito: o
    // prefixo do item nunca era removido e a lista saia com `77884_IIRR_...`. Nao quebrou nada
    // porque quem analisa tira o prefixo de novo — mas era o padrao mentindo em silencio, o mesmo
    // modo de falha que ja custou quatro rodadas nesta familia de scripts.
    for await (const b of c.listBlobsFlat()) nomes.push(b.name.split('/').pop().replace(/^\d+_/, '') + '|' + b.properties.contentLength);
    nomes.sort();
    console.log('LISTA_INICIO ' + nomes.length);
    for (const x of nomes) console.log('  L ' + x);
    console.log('LISTA_FIM');
    return;
  }

  if (!arqs.length) throw new Error('nenhum M<NN>_<data>_<hora>.csv em "' + RAW_CONTAINER
    + '" — a ponte SharePoint->blob copiou os arquivos por usina?');

  // so a janela pedida, e so o arquivo MAIS RECENTE de cada (usina, dia): o export pode ser
  // repetido no mesmo dia, e a versao nova e a boa.
  const porChave = new Map();
  for (const a of arqs) {
    const m = a.nome.split('/').pop().match(CARIMBO);
    const d = m[2].slice(0, 4) + '-' + m[2].slice(4, 6) + '-' + m[2].slice(6, 8);
    const k = parque(m[1]) + '|' + d;
    const ant = porChave.get(k);
    if (!ant || a.nome > ant.nome) porChave.set(k, { ...a, parque: parque(m[1]), dia: d });
  }
  const dias = [...new Set([...porChave.values()].map((x) => x.dia))].sort();
  const corte = dias.slice(-DIAS)[0];
  const alvo = [...porChave.values()].filter((x) => x.dia >= corte).sort((a, b) => (a.dia + a.parque < b.dia + b.parque ? -1 : 1));
  console.log('  ' + porChave.size + ' par(es) usina/dia · ' + dias.length + ' dia(s) na fonte ('
    + dias[0] + ' a ' + dias[dias.length - 1] + ') · processando ' + alvo.length + ' desde ' + corte);

  const serie = [];
  let lidos = 0, falhos = 0;
  for (const a of alvo) {
    let reg;
    try { reg = leUsinaDia(await a.ler()); }
    catch (e) { falhos++; console.log('  ATENÇÃO · nao consegui ler ' + a.nome.split('/').pop() + ': ' + e.message.slice(0, 60)); continue; }
    if (!reg || !reg.inversores.length) { falhos++; console.log('  ATENÇÃO · sem inversor com energia em ' + a.nome.split('/').pop()); continue; }
    lidos++;
    for (const x of comparaComPares(reg))
      // `ms` = epoch de 00:00 BRT do dia. O painel recorta pela janela do seletor de tempo do Grafana
      // e NAO pode derivar isto do texto: o JSONata Go le '2026-08-10' como 00:00 UTC e ignora o
      // offset, o que deslocaria todo ponto para as 21:00 do dia anterior na tela.
      serie.push({ dia: a.dia, ms: msDoDia(a.dia), ufv: a.parque, ts: x.ts, inv: x.inv, kwh: x.kwh, razao: x.razao, base: x.base });
  }
  if (!serie.length) throw new Error('nenhum inversor com energia em ' + alvo.length + ' arquivo(s) — o layout do export mudou?');

  // ---- acumula com o historico publicado ---------------------------------------------------
  const historico = await leHistorico();
  const { serie: full, novas, mantidas } = acumula(historico, serie,
    (l) => l.dia + '|' + l.ufv + '|' + l.ts + '|' + l.inv, JANELA);
  // ⚠️ as linhas ja publicadas antes de `ms` existir recebem o campo aqui, senao o recorte por
  //    janela as trataria como ausentes — a mesma lacuna que o `must_diario` ja pagou
  let msRetro = 0;
  full.forEach((l) => { if (l.ms == null) { l.ms = msDoDia(l.dia); msRetro++; } });
  const diasFull = [...new Set(full.map((l) => l.dia))].sort();
  // 🔴 GUARDA: nenhum dia que o historico tinha pode sumir, a nao ser por PODA da janela. Sem ela,
  //    uma leitura parcial da fonte encolheria a serie em silencio — e o painel mostraria menos
  //    historico sem nada acusar.
  {
    const antes = new Set(historico.map((l) => l.dia));
    const depois = new Set(diasFull);
    const corte = diasFull[0];
    const sumiram = [...antes].filter((d) => d >= corte && !depois.has(d));
    if (sumiram.length) throw new Error('dia(s) do historico sumiram sem ser por poda: ' + sumiram.join(' '));
  }

  // ---- agregados por inversor, sobre a janela INTEIRA ---------------------------------------
  // ⚠️ MEDIANA, nao media: um dia de manutencao com energia zero puxaria a media para baixo e
  // colocaria um inversor sadio no topo do ranking de problema.
  const porInv = new Map();
  for (const s of full) {
    const k = s.ufv + '|' + s.ts + '|' + s.inv;
    const o = porInv.get(k) || porInv.set(k, { ufv: s.ufv, ts: s.ts, inv: s.inv, r: [], kwh: 0, dias: 0,
      de: s.dia, ate: s.dia }).get(k);
    if (s.razao != null) o.r.push(s.razao);
    o.kwh += s.kwh || 0; o.dias++;
    if (s.dia < o.de) o.de = s.dia;
    if (s.dia > o.ate) o.ate = s.dia;
  }
  const inversores = [...porInv.values()]
    .filter((o) => o.r.length >= Math.min(MIN_DIAS, diasFull.length))
    .map((o) => ({ ufv: o.ufv, ts: o.ts, inv: o.inv,
      chave: o.ufv + '/' + o.ts + '/' + o.inv, dias: o.dias,
      razao_mediana: r2(mediana(o.r)), razao_min: r2(Math.min(...o.r)),
      kwh_janela: r2(o.kwh), de: o.de, ate: o.ate }));

  // 🔴 O LIMIAR SAI DA DISPERSAO DA PROPRIA FROTA, medida a cada rodada, nunca de um numero
  //    escolhido: desvio robusto = 1,4826 x a mediana dos afastamentos. Medido em 03/09/2026 ele
  //    vale 1,48 ponto, entao um inversor a 93% esta a cinco desvios — nao e ruido, e achado. E a
  //    conta mora AQUI e nao no painel, pela mesma razao de sempre: uma copia por painel envelhece
  //    diferente das outras.
  const meds = inversores.map((x) => x.razao_mediana).filter((x) => x != null);
  const refM = mediana(meds);
  const desv = meds.map((x) => Math.abs(x - refM));
  // ⚠️ A MEDIANA DOS AFASTAMENTOS COLAPSA quando mais da metade da frota esta exatamente na
  //    mediana — o que e estado LEGITIMO, e ate desejavel: significa parque uniforme. Abortar ali
  //    seria reprovar o melhor caso possivel. Quando ela da zero, a escala passa a ser a MEDIA dos
  //    afastamentos, que so e zero quando TODOS sao iguais — e af nao ha desvio a medir mesmo.
  const mad = mediana(desv);
  const escala = mad > 0 ? mad : desv.reduce((a, b) => a + b, 0) / (desv.length || 1);
  const refS = 1.4826 * escala;
  const refTipo = mad > 0 ? 'mediana dos afastamentos' : (refS > 0 ? 'média dos afastamentos (a frota está uniforme demais para a mediana)' : 'frota idêntica — não há desvio a medir');
  inversores.forEach((x) => { x.desvios = refS > 0 ? r2((x.razao_mediana - refM) / refS) : null; });
  inversores.sort((a, b) => a.razao_mediana - b.razao_mediana);

  // ---- a serie diaria dos piores, para o grafico -------------------------------------------
  // 🔴 SO OS PIORES: a serie inteira sao 8 KB por dia na rede, entao um ano seriam 2,9 MB que o
  //    painel baixaria por completo antes de filtrar. O grafico desenha meia duzia de linhas.
  const top = new Set(inversores.slice(0, TOP_SERIE).map((x) => x.ufv + '|' + x.ts + '|' + x.inv));
  const serie_top = full.filter((l) => top.has(l.ufv + '|' + l.ts + '|' + l.inv))
    .map((l) => ({ ...l, chave: l.ufv + '/' + l.ts + '/' + l.inv }));   // a chave que o filtro do painel usa

  const escopo = {
    pergunta: 'Qual inversor rende abaixo dos pares do mesmo transformador, antes de falhar.',
    grandeza: GRANDEZA + ' (contador diario, kWh) — a energia do dia e o maior valor do dia',
    par: 'mediana dos inversores do mesmo TS no mesmo dia; TS com menos de ' + MIN_PARES
      + ' reportando cai para a mediana da usina',
    janela_dias: JANELA, dias_cobertos: diasFull.length,
    de: diasFull[0], ate: diasFull[diasFull.length - 1],
    fonte_dias: dias.length, fonte_de: dias[0], fonte_ate: dias[dias.length - 1],
    arquivos_lidos: lidos, arquivos_com_problema: falhos,
    inversores: inversores.length, linhas_historico: full.length,
    referencia: { mediana: r2(refM), desvio_robusto: r2(refS), escala: refTipo, fora_3_desvios: inversores.filter((x) => x.desvios != null && x.desvios < -3).length },
    serie_top_de: TOP_SERIE,
  };
  const out = {
    atualizado: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10),
    escopo,
    ranking: inversores.slice(0, 60),
    inversores,
    serie_top,
  };
  const kb = Math.round((await escreve(out, OUT_BLOB)) / 1024);
  const kbh = Math.round((await escreve({ atualizado: out.atualizado,
    nota: 'historico bruto por inversor e por dia. Existe para o proprio gerador acumular; os paineis leem os agregados do outro arquivo.',
    janela_dias: JANELA, dias_cobertos: diasFull.length, de: escopo.de, ate: escopo.ate, serie: full }, HIST_BLOB)) / 1024);
  console.log('  ' + OUT_BLOB + ' OK · ' + kb + ' KB · ' + inversores.length + ' inversores · '
    + serie_top.length + ' linhas de serie dos ' + TOP_SERIE + ' piores');
  if (msRetro) console.log('  ms retroativo em ' + msRetro + ' linha(s) do historico');
  console.log('  ' + HIST_BLOB + ' OK · ' + kbh + ' KB · ' + full.length + ' linhas ('
    + novas + ' novas, ' + mantidas + ' do historico) · ' + diasFull.length + ' dias cobertos de ' + JANELA);
  console.log('  frota: mediana ' + r2(refM * 100) + '% · desvio robusto ' + r2(refS * 100)
    + ' ponto(s) · ' + escopo.referencia.fora_3_desvios + ' inversor(es) abaixo de 3 desvios');
  console.log('  piores 5: ' + inversores.slice(0, 5).map((x) => x.chave + '=' + x.razao_mediana + ' (' + x.desvios + 'σ)').join(' · '));
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
