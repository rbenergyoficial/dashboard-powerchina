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
const DIAS = Number(process.env.DIAS || 60);
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

async function escreve(obj) {
  const json = JSON.stringify(obj);
  const gz = zlib.gzipSync(Buffer.from(json));
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const cont = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(gz, gz.length, { blobHTTPHeaders: {
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

  // ⏱️ MODO ESPIAR: ESPIAR=<pedaco>,<pedaco> baixa cada blob cujo NOME contenha um dos pedacos e
  // imprime forma e alcance — cabecalho, primeiras e ultimas linhas, contagem, e a menor e a maior
  // data encontradas. Le e sai; nao grava nada.
  //
  // 🔴 A busca e por SUBSTRING, sem ancora e sem formato: a pergunta que este modo responde e
  // "o que ha DENTRO deste arquivo que ninguem le", e um padrao ancorado ja me fez concluir
  // "nao existe" com o arquivo presente. Quem filtra e o humano, no parametro.
  if (process.env.ESPIAR) {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW_CONTAINER);
    const alvos = process.env.ESPIAR.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
    const achados = [];
    for await (const b of c.listBlobsFlat()) {
      if (alvos.some((a) => b.name.toLowerCase().includes(a))) {
        achados.push({ nome: b.name, bytes: b.properties.contentLength || 0 });
      }
    }
    achados.sort((a, b) => b.bytes - a.bytes);
    console.log('ESPIA_INICIO ' + achados.length + ' blob(s) para ' + JSON.stringify(alvos));
    for (const a of achados.slice(0, Number(process.env.ESPIAR_MAX || 6))) {
      console.log('  E ==== ' + a.nome + '  ' + Math.round(a.bytes / 1024) + ' KB');
      let txt;
      try {
        const buf = await c.getBlobClient(a.nome).downloadToBuffer();   // o mesmo caminho da linha 75
        txt = (buf[0] === 0x1f && buf[1] === 0x8b) ? require('zlib').gunzipSync(buf).toString('utf8') : buf.toString('utf8');
      } catch (e) { console.log('  E   NAO LI: ' + e.message); continue; }
      const linhas = txt.split(/\r?\n/).filter((l) => l.length);
      console.log('  E   linhas: ' + linhas.length);
      for (let i = 0; i < Math.min(3, linhas.length); i++) console.log('  E   [' + (i + 1) + '] ' + linhas[i].slice(0, 400));
      for (let i = Math.max(3, linhas.length - 2); i < linhas.length; i++) console.log('  E   [' + (i + 1) + '] ' + linhas[i].slice(0, 400));
      // vocabulario de COLUNAS: e o que decide se da para desenhar painel, e nao cabe nos 400
      // caracteres do cabecalho cru. Separa o IDENTIFICADOR (equipamento) da GRANDEZA, contando
      // cada um, sem supor formato: o que vem antes do primeiro espaco e o identificador; o resto
      // e a grandeza. Onde nao ha espaco (tag IEC 61850) a quebra e o ultimo ponto.
      if (process.env.ESPIAR_COLS) {
        const cols = linhas[0].replace(/^﻿/, '').split(';');
        console.log('  E   colunas: ' + cols.length);
        const ident = new Map(), grand = new Map();
        for (const c0 of cols.slice(1)) {
          const c = c0.trim();
          let id, g;
          if (c.includes(' ')) { id = c.slice(0, c.indexOf(' ')); g = c.slice(c.indexOf(' ') + 1); }
          else { const i = c.lastIndexOf('.'); id = i < 0 ? c : c.slice(0, i); g = i < 0 ? '(sem)' : c.slice(i + 1); }
          ident.set(id, (ident.get(id) || 0) + 1);
          grand.set(g, (grand.get(g) || 0) + 1);
        }
        const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n)
          .map(([k, v]) => k + ' x' + v).join(' | ');
        console.log('  E   identificadores: ' + ident.size + ' -> ' + top(ident, 14));
        console.log('  E   grandezas: ' + grand.size + ' -> ' + top(grand, 30));
      }
      // alcance: qualquer data ISO ou dd/mm/aaaa que apareca no corpo
      const datas = txt.match(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/g) || [];
      const norm = (d) => (d.includes('/') ? d.slice(6) + '-' + d.slice(3, 5) + '-' + d.slice(0, 2) : d);
      if (datas.length) {
        const ord = [...new Set(datas.map(norm))].sort();
        console.log('  E   datas: ' + ord.length + ' distintas · de ' + ord[0] + ' a ' + ord[ord.length - 1]);
      } else { console.log('  E   datas: nenhuma reconhecida no corpo'); }
    }
    console.log('ESPIA_FIM');
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
      serie.push({ dia: a.dia, ufv: a.parque, ts: x.ts, inv: x.inv, kwh: x.kwh, razao: x.razao, base: x.base });
  }
  if (!serie.length) throw new Error('nenhum inversor com energia em ' + alvo.length + ' arquivo(s) — o layout do export mudou?');

  // ---- ranking: a MEDIANA da razao de cada inversor na janela ------------------------------
  const porInv = new Map();
  for (const s of serie) {
    const k = s.ufv + '|' + s.ts + '|' + s.inv;
    const o = porInv.get(k) || porInv.set(k, { ufv: s.ufv, ts: s.ts, inv: s.inv, r: [], kwh: 0, dias: 0 }).get(k);
    if (s.razao != null) o.r.push(s.razao);
    o.kwh += s.kwh || 0; o.dias++;
  }
  // ⚠️ MEDIANA, nao media: um dia de manutencao com energia zero puxaria a media para baixo e
  // colocaria um inversor sadio no topo do ranking de problema.
  const ranking = [...porInv.values()]
    .filter((o) => o.r.length >= Math.min(5, DIAS))
    .map((o) => ({ ufv: o.ufv, ts: o.ts, inv: o.inv, dias: o.dias,
      razao_mediana: r2(mediana(o.r)), razao_min: r2(Math.min(...o.r)), kwh_janela: r2(o.kwh) }))
    .sort((a, b) => a.razao_mediana - b.razao_mediana);

  const out = {
    atualizado: new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10),
    escopo: {
      pergunta: 'Qual inversor rende abaixo dos pares do mesmo transformador, antes de falhar.',
      grandeza: GRANDEZA + ' (contador diario, kWh) — a energia do dia e o maior valor do dia',
      par: 'mediana dos inversores do mesmo TS no mesmo dia; TS com menos de ' + MIN_PARES
        + ' reportando cai para a mediana da usina',
      janela_dias: dias.filter((d) => d >= corte).length,
      de: corte, ate: dias[dias.length - 1],
      arquivos_lidos: lidos, arquivos_com_problema: falhos,
      inversores: porInv.size, linhas: serie.length,
    },
    ranking: ranking.slice(0, 60),
    serie,
  };
  const kb = Math.round((await escreve(out)) / 1024);
  console.log('  ' + OUT_BLOB + ' OK · ' + kb + ' KB comprimido · ' + porInv.size + ' inversores · '
    + serie.length + ' linhas · janela ' + out.escopo.janela_dias + ' dias');
  console.log('  piores 5: ' + ranking.slice(0, 5).map((x) => x.ufv + '/' + x.ts + '/' + x.inv + '=' + x.razao_mediana).join(' · '));
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
