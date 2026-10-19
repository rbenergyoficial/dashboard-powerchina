/* repara-ons-mes.js — reconstrói do ONS os meses cujo blob ficou com dias faltando.
 *
 * O DEFEITO QUE ISTO CONSERTA. Os blobs mensais `ons_restricao_YYYY_MM.json` são escritos por um
 * fluxo do Power Automate que só toca no MÊS CORRENTE. O último gravado de cada mês sai às 23:00 UTC
 * do próprio dia 30/31 — e nesse horário o ONS ainda não publicou o dia que está terminando. No dia
 * seguinte o fluxo passa a escrever o mês novo e nunca mais volta ao anterior.
 * Resultado: o ÚLTIMO DIA DE CADA MÊS se perde para sempre.
 *   jun/26 ficou com 29 dias de 30 · jul/26 com 30 de 31 · e 31/08 se perderia igual.
 * Os meses de set/25 a mai/26 estão íntegros só porque foram refeitos num backfill manual em
 * 29/06/2026, quando o ONS já tinha tudo.
 *
 * POR QUE AQUI E NÃO NO FLUXO. O fluxo é a correção certa e continua sendo — mas está fora deste
 * repositório. Enquanto ele não muda, o consolidador (que roda todo dia e já sabe escrever no blob)
 * verifica e repara. Quando o fluxo for corrigido, esta rotina simplesmente não acha nada para fazer.
 *
 * O QUE ELE NÃO FAZ: o reparo não toca no mês corrente (quem o escreve é o `gravarMesCorrente`, no fim do arquivo) nem em
 * mês cujo blob já esteja completo. Reparar é caro — ~9 MB do S3 do ONS por mês — então só age quando falta dia.
 */
const readline = require('readline');
const https = require('https');

const ONS = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/'
  + 'restricao_coff_fotovoltaica_tm/RESTRICAO_COFF_FOTOVOLTAICA';
const ID_ONS = 'CJU_CEMTD';                    // Conjunto Mauriti no arquivo por conjunto
const COLS = { id: 5, ts: 7, ger: 8, lim: 9, disp: 10, gref: 11, razao: 13, orig: 14, dsc: 15 };

const diasNoMes = ym => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();

/** Baixa o mês do ONS e devolve as linhas do conjunto, no formato do blob. */
function baixarMes(ym) {
  const arq = ONS + '_' + ym.replace('-', '_') + '.csv';
  return new Promise((res, rej) => {
    https.get(arq, { timeout: 300000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const out = [];
      const rl = readline.createInterface({ input: r, crlfDelay: Infinity });
      rl.on('line', l => {
        if (!l || l.indexOf(ID_ONS) < 0) return;             // filtro barato antes do split
        const c = l.split(';');
        if (c[COLS.id] !== ID_ONS) return;
        const n = i => { const v = String(c[i] ?? '').trim().replace(',', '.'); return v === '' ? null : +v; };
        out.push({ ts: String(c[COLS.ts]).trim(), ger: n(COLS.ger), lim: n(COLS.lim),
          disp: n(COLS.disp), gref: n(COLS.gref),
          razao: String(c[COLS.razao] ?? '').trim(), orig: String(c[COLS.orig] ?? '').trim(),
          dsc: String(c[COLS.dsc] ?? '').trim() });
      });
      rl.on('close', () => res(out));
      rl.on('error', rej);
    }).on('error', rej);
  });
}

/**
 * @param {(u:string)=>Promise<any>} fetchJson  leitor de blob do consolidador
 * @param {(nome:string,json:string)=>Promise<void>} upload  gravador de blob do consolidador
 * @param {string} BASE  url pública do container
 * @param {string[]} meses  lista YYYY_MM que o consolidador já monta
 */
async function repararMeses(fetchJson, upload, BASE, meses) {
  const agora = new Date();
  const mesCorrente = agora.getUTCFullYear() + '_' + String(agora.getUTCMonth() + 1).padStart(2, '0');
  const reparados = [];
  for (const ym of meses) {
    if (ym === mesCorrente) continue;                        // o ONS ainda está publicando
    const alvo = 'ons_restricao_' + ym + '.json';
    const d = await fetchJson(BASE + alvo);
    if (!d || !Array.isArray(d.consolidado)) continue;
    const iso = ym.replace('_', '-');
    const tem = new Set(d.consolidado.map(r => String(r.ts || '').slice(0, 10)));
    const esperado = diasNoMes(iso);
    const faltam = [];
    for (let i = 1; i <= esperado; i++) {
      const dia = iso + '-' + String(i).padStart(2, '0');
      if (!tem.has(dia)) faltam.push(dia);
    }
    if (!faltam.length) continue;
    console.log('  ' + ym + ': faltam ' + faltam.length + ' dia(s) — ' + faltam.map(x => x.slice(-2)).join(',')
      + ' · rebaixando do ONS');
    let linhas;
    try { linhas = await baixarMes(iso); }
    catch (e) { console.warn('  ' + ym + ': ONS indisponível (' + e.message + ') — mantido como está'); continue; }
    const diasNovo = new Set(linhas.map(r => r.ts.slice(0, 10)));
    // NUNCA piorar: se o ONS ainda não tem os dias que faltam, o blob antigo fica.
    if (linhas.length <= d.consolidado.length || faltam.some(x => !diasNovo.has(x))) {
      console.warn('  ' + ym + ': o ONS ainda não publicou tudo (' + diasNovo.size + ' dias) — mantido');
      continue;
    }
    const obj = Object.assign({}, d, {
      atualizado: new Date().toISOString(),
      reparado_em: new Date().toISOString(),
      reparo_nota: 'Reconstruído do arquivo do ONS: o blob anterior tinha ' + tem.size + ' de '
        + esperado + ' dias. O fluxo que grava este arquivo só escreve o mês corrente e para no dia '
        + esperado + ' às 23:00 UTC, antes de o ONS publicar o último dia.',
      consolidado: linhas,
    });
    await upload(alvo, JSON.stringify(obj));
    console.log('  ' + ym + ': reparado — ' + tem.size + ' -> ' + diasNovo.size + ' dias, '
      + d.consolidado.length + ' -> ' + linhas.length + ' linhas');
    reparados.push(ym);
  }
  if (!reparados.length) console.log('  nenhum mês precisou de reparo');
  return reparados;
}

/* ── O MÊS CORRENTE (PROMOVER pa-ons, 18/10/2026) ───────────────────────────────────────────────────────────────
 * Até aqui o mês corrente era escrito pelo fluxo "ONS Restricao Fotovoltaica" do Power Automate (16:00 e 23:00 UTC), que sai com
 * o Premium em 09/11/2026. Agora quem escreve é o consolidador, na rodada diária dele (ons-consolidado.yml, 18:17 UTC), a partir
 * do MESMO CSV e no MESMO FORMATO do fluxo, campo a campo, para o `ons_restricao_all.json` não mudar:
 *   - mês em UTC (`formatDateTime(utcNow(),'yyyy_MM')`); linhas cujo id_ons é `CJU_CEMTD`;
 *   - campos como TEXTO cru do CSV (`"0.0"`, `""` no vazio), só o `dsc` aparado. O reparo dos meses fechados, acima, grava
 *     número e null: os dois formatos convivem há meses no all, e o consolidador copia a linha como vem.
 *   - O ONS publica o CSV por volta das 22:06 UTC (o dia anterior). O all já era montado às 18:17 com o que o fluxo gravou às
 *     23:00 da véspera: mesmo dado, mesmo horário.
 * As colunas são lidas pelo NOME do cabeçalho (o fluxo usava a posição): coluna sumida ou renomeada estoura em vez de trocar
 * campo em silêncio.
 * Só baixa (~11 MB) quando o CSV mudou depois da última gravação (HEAD Last-Modified contra `atualizado`).
 * 🔴 O que é ausência legítima e o que é defeito:
 *   - 404 do CSV só é ausência nos dias 1 e 2 do mês UTC (o arquivo do mês nasce com a primeira publicação); depois disso, e
 *     qualquer outro status, ESTOURA;
 *   - blob que não existe (404) é "primeira gravação"; falha ao LER o blob estoura (nunca vira "sem blob" e sobrescreve);
 *   - CSV sem o conjunto, CSV truncado (bytes ≠ Content-Length) ou com menos linhas que o blob ESTOURAM sem gravar;
 *   - nos dias 1 e 2 do mês UTC o mês ANTERIOR também é refeito pela mesma regra: o ONS publica o último dia dele no dia 1º às
 *     ~22:06 UTC, e sem isto o all ficaria até um dia sem os DOIS últimos dias do mês (o fluxo gravava às 23:00 do último dia).
 */
const FONTE_TXT = 'ONS Dados Abertos - Constrained-off Fotovoltaica';
const COMPLEXO = 'CONJ. MAURITI';
const NOMES = { id: 'id_ons', ts: 'din_instante', ger: 'val_geracao', lim: 'val_geracaolimitada', disp: 'val_disponibilidade',
  gref: 'val_geracaoreferencia', razao: 'cod_razaorestricao', orig: 'cod_origemrestricao', dsc: 'dsc_restricao' };
const mesUTC = (agora) => agora.getUTCFullYear() + '_' + String(agora.getUTCMonth() + 1).padStart(2, '0');
const mesAnterior = (ym) => { const y = +ym.slice(0, 4), m = +ym.slice(5, 7); return m === 1 ? (y - 1) + '_12' : y + '_' + String(m - 1).padStart(2, '0'); };

/** As linhas do conjunto como o fluxo as montava (texto cru), com as colunas achadas pelo nome do cabeçalho. */
function linhasComoFluxo(texto) {
  const ls = String(texto).split('\n');
  const cab = (ls[0] || '').replace(/^﻿/, '').split(';').map((x) => x.trim());
  const I = {};
  for (const [k, nome] of Object.entries(NOMES)) {
    I[k] = cab.indexOf(nome);
    if (I[k] < 0) throw new Error('CSV do ONS sem a coluna ' + nome + ' no cabecalho');
  }
  const out = [];
  for (const l of ls.slice(1)) {
    if (l.indexOf(ID_ONS) < 0) continue;
    const c = l.split(';');
    if (c[I.id] !== ID_ONS) continue;
    const t = (i) => (c[i] == null ? '' : c[i]);
    out.push({ ts: t(I.ts), ger: t(I.ger), lim: t(I.lim), disp: t(I.disp), gref: t(I.gref),
      razao: t(I.razao), orig: t(I.orig), dsc: t(I.dsc).trim() });
  }
  return out;
}

/** HEAD devolve { status, modificado }; GET devolve { status, texto } — UTF-8 dos pedaços JUNTOS e tamanho conferido. */
function pedeCsv(metodo, url) {
  const mod = url.startsWith('http:') ? require('http') : https;
  return new Promise((res, rej) => {
    const r = mod.request(url, { method: metodo, timeout: 300000 }, (x) => {
      if (metodo === 'HEAD') { x.resume(); return res({ status: x.statusCode, modificado: Date.parse(x.headers['last-modified'] || '') }); }
      if (x.statusCode !== 200) { x.resume(); return res({ status: x.statusCode }); }
      const b = []; x.on('data', (d) => b.push(d));
      x.on('end', () => {
        /* segunda rede: o Node ja recusa (aborted) a conexao fechada antes do Content-Length; isto pega o resto */
        const buf = Buffer.concat(b), esperado = +x.headers['content-length'];
        if (isFinite(esperado) && esperado !== buf.length) return rej(new Error('CSV truncado: ' + buf.length + ' de ' + esperado + ' bytes'));
        res({ status: 200, texto: buf.toString('utf8') });
      });
      x.on('error', rej);
    });
    r.on('timeout', () => r.destroy(new Error('tempo esgotado'))); r.on('error', rej); r.end();
  });
}

/** Lê o blob atual: 404 = null (ainda não existe); outro status ou JSON ilegível ESTOURA. */
// Fase 2: o transporte e o da lib-le-dados (credencial para `dados`; o http do ensaio passa direto). So o 404 do proprio blob vira
// null; o que a lib estoura (403, 409, 5xx, rede, conteiner sumido) sai como 'leitura do blob: ...'.
async function leBlob(url) {
  let x;
  try { x = await require('./lib-le-dados').pede(url + '?t=' + Date.now()); } catch (e) { throw new Error('leitura do blob: ' + e.message); }
  if (x.status === 404) return null;
  try { return JSON.parse(x.buf.toString('utf8').replace(/^﻿/, '')); } catch (e) { throw new Error('blob ilegivel: ' + e.message); }
}

async function gravaUmMes(ym, toleraAusente, upload, BASE, pede, le, forcar) {
  const alvo = 'ons_restricao_' + ym + '.json', url = ONS + '_' + ym + '.csv';
  const h = await pede('HEAD', url);
  if (h.status === 404 && toleraAusente) { console.log('  ' + ym + ': CSV do ONS ainda nao existe (inicio do mes)'); return { acao: 'sem-csv', ym, url }; }
  if (h.status !== 200) throw new Error(ym + ': CSV do ONS respondeu HTTP ' + h.status + ' (' + url + ')');
  const atual = await le(BASE + alvo);
  const linhasAtual = atual && Array.isArray(atual.consolidado) ? atual.consolidado.length : 0;
  if (!forcar && atual && Date.parse(atual.atualizado) >= h.modificado) {
    console.log('  ' + ym + ': sem novidade (CSV de ' + new Date(h.modificado).toISOString() + ', blob de ' + atual.atualizado + ')');
    return { acao: 'sem-novidade', ym, url };
  }
  const g = await pede('GET', url);
  if (g.status !== 200) throw new Error(ym + ': GET do CSV respondeu HTTP ' + g.status);
  const linhas = linhasComoFluxo(g.texto);
  if (!linhas.length) throw new Error(ym + ': CSV sem linha do ' + ID_ONS + ' — blob mantido');
  if (linhas.length < linhasAtual) throw new Error(ym + ': o CSV tem ' + linhas.length + ' linhas e o blob ' + linhasAtual + ' — blob mantido (nunca piorar)');
  const obj = { periodo: ym.replace('_', '-'), atualizado: new Date().toISOString(), fonte: FONTE_TXT, id_ons: ID_ONS, complexo: COMPLEXO, consolidado: linhas };
  await upload(alvo, JSON.stringify(obj));
  const dias = new Set(linhas.map((r) => r.ts.slice(0, 10))).size;
  console.log('  ' + ym + ': gravado — ' + linhasAtual + ' -> ' + linhas.length + ' linhas, ' + dias + ' dias');
  return { acao: 'gravou', ym, url, alvo, linhas: linhas.length, antes: linhasAtual, obj };
}

/**
 * Grava `ons_restricao_<mes UTC>.json` do mês corrente (e, nos dias 1 e 2, o do mês anterior). `opc.pede`, `opc.le` e `opc.agora`
 * existem para o ensaio; `opc.forcar` ignora a comparação de datas. Devolve a lista de resultados; defeito ESTOURA.
 */
async function gravarMesCorrente(upload, BASE, opc = {}) {
  const agora = opc.agora || new Date();
  const pede = opc.pede || pedeCsv, le = opc.le || leBlob;
  const ym = mesUTC(agora), inicio = agora.getUTCDate() <= 2;
  const out = [await gravaUmMes(ym, inicio, upload, BASE, pede, le, opc.forcar)];
  if (inicio) out.push(await gravaUmMes(mesAnterior(ym), false, upload, BASE, pede, le, opc.forcar));
  return out;
}

/** A etapa do consolidador: erro NÃO para a consolidação (os meses fechados seguem), mas pinta o job de vermelho. */
async function etapaMesCorrente(upload, BASE, opc) {
  try { return await gravarMesCorrente(upload, BASE, opc); } catch (e) {
    console.error('::error::mes corrente do ONS nao gravado: ' + e.message);
    process.exitCode = 1;
    return null;
  }
}

module.exports = { repararMeses, gravarMesCorrente, etapaMesCorrente, linhasComoFluxo, pedeCsv, leBlob, mesUTC, mesAnterior };
