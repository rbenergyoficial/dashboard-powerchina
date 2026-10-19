'use strict';
/*
 * ensaio-ons-mes-corrente.js — prova que o gravador do mês corrente do ONS (repara-ons-mes.js) escreve o blob no MESMO formato
 * do fluxo do Power Automate que ele substitui, nunca piora o que está gravado e fica VERMELHO quando não consegue gravar.
 *
 * Fabricado (CSV, blob, datas); o transporte é julgado contra um servidor HTTP local. Nada depende do ONS do dia.
 *   1. linhas como o fluxo: só id_ons = CJU_CEMTD, texto cru, só o dsc aparado; colunas pelo NOME (coluna nova no meio não
 *      troca campo; coluna sumida estoura);
 *   2. mês em UTC e mês anterior (inclusive janeiro);
 *   3. topo do blob igual ao do fluxo; a URL pedida no HEAD e no GET é a do mês UTC;
 *   4. CSV não mais novo que o blob -> sem gravar; forcar e CSV mais novo gravam;
 *   5. ausência × defeito: 404 no dia 1-2 é ausência; 404 no dia 18, 500, CSV sem o conjunto, falha de LEITURA do blob e CSV
 *      com menos linhas ESTOURAM sem gravar; blob 404 é primeira gravação;
 *   6. virada: 31/10 22:00 BRT (01/11 UTC) grava novembro (se houver) e REFAZ outubro;
 *   7. transporte: UTF-8 partido entre dois pedaços chega inteiro; Last-Modified lido do cabeçalho; corpo menor que o
 *      Content-Length estoura; o leitor do blob separa 404 (null) de 500 e de JSON ilegível (estouram);
 *   8. a etapa do consolidador pinta o job (exitCode 1) e o gen-ons-consolidado a chama antes de consolidar.
 */
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const path = require('path');
const M = require('./repara-ons-mes');

const COLS = ['id_subsistema', 'nom_subsistema', 'id_estado', 'nom_estado', 'nom_usina', 'id_ons', 'ceg', 'din_instante', 'val_geracao',
  'val_geracaolimitada', 'val_disponibilidade', 'val_geracaoreferencia', 'val_geracaoreferenciafinal', 'cod_razaorestricao',
  'cod_origemrestricao', 'dsc_restricao', 'id_pontoconexao', 'nom_pontoconexao', 'nom_agenteoperador', 'val_geracaonaorealizadaapurada',
  'num_minutos_rel', 'num_minutos_cnf', 'num_minutos_ene', 'num_minutos_restricao'];
function csv(linhas, cols = COLS) {
  return [cols.join(';')].concat(linhas.map((o) => cols.map((c) => (c in o ? o[c] : '')).join(';'))).join('\r\n') + '\r\n';
}
const L = (id, ts, ger, lim, disp, gref, razao, orig, dsc) => ({ id_ons: id, din_instante: ts, val_geracao: ger, val_geracaolimitada: lim,
  val_disponibilidade: disp, val_geracaoreferencia: gref, cod_razaorestricao: razao, cod_origemrestricao: orig, dsc_restricao: dsc, nom_usina: 'Conj. X' });
const BASICO = [L('CJU_CEMTD', '2026-10-01 00:00:00', '0.0', '', '266.2', '0.0', '', '', ''),
  L('CJU_CEMTD', '2026-10-01 12:00:00', '310.5', '200.0', '343.169', '330.1', 'ENE', 'SIS', '  Controle de frequência  '),
  L('CJU_BABJL', '2026-10-01 12:00:00', '35.0', '', '35.0', '30.0', '', '', 'vizinho do CJU_CEMTD')];
const ESPERADO = [
  { ts: '2026-10-01 00:00:00', ger: '0.0', lim: '', disp: '266.2', gref: '0.0', razao: '', orig: '', dsc: '' },
  { ts: '2026-10-01 12:00:00', ger: '310.5', lim: '200.0', disp: '343.169', gref: '330.1', razao: 'ENE', orig: 'SIS', dsc: 'Controle de frequência' }];

let n = 0;
const caso = async (nome, f) => { await f(); n++; console.log('ok · ' + nome); };
/* roda o gravador com CSV, HEAD e blob simulados por mes; registra URLs pedidas e o que foi gravado */
async function roda({ agora = '2026-10-18T15:00:00Z', csvs = { '2026_10': csv(BASICO) }, head = {}, blobs = {}, forcar = false, le } = {}) {
  const urls = [], gravados = [];
  const pede = async (metodo, url) => {
    urls.push(metodo + ' ' + url.split('/').pop());
    const ym = url.match(/(\d{4}_\d{2})\.csv$/)[1];
    if (metodo === 'HEAD') return head[ym] ? Object.assign({ modificado: Date.parse('2026-10-17T22:06:44Z') }, head[ym]) : (csvs[ym] ? { status: 200, modificado: Date.parse('2026-10-17T22:06:44Z') } : { status: 404 });
    return csvs[ym] ? { status: 200, texto: csvs[ym] } : { status: 404 };
  };
  const leF = le || (async (u) => { const ym = u.match(/(\d{4}_\d{2})\.json$/)[1]; return blobs[ym] === undefined ? null : blobs[ym]; });
  const r = await M.gravarMesCorrente(async (nome, json) => gravados.push({ nome, j: JSON.parse(json) }), 'base/', { agora: new Date(agora), pede, le: leF, forcar });
  return { r, urls, gravados };
}
const falha = async (opc, re) => {
  const g = []; let msg = '';
  try { await roda(Object.assign({}, opc)); } catch (e) { msg = e.message; }
  assert.ok(re.test(msg), 'esperava erro ' + re + ', veio "' + msg + '"');
};

(async () => {
  const log = console.log, warn = console.warn, err = console.error;
  console.log = (...a) => { if (/^ok · |^ensaio-ons/.test(String(a[0]))) log(...a); }; console.warn = () => {}; console.error = () => {};
  const exitAntes = process.exitCode;
  try {
    await caso('linhas como o fluxo; colunas pelo nome', () => {
      assert.deepStrictEqual(M.linhasComoFluxo(csv(BASICO)), ESPERADO);
      const nova = COLS.slice(0, 5).concat(['coluna_nova']).concat(COLS.slice(5));
      assert.deepStrictEqual(M.linhasComoFluxo(csv(BASICO.map((o) => Object.assign({ coluna_nova: 'X;Y'.split(';')[0] }, o)), nova)), ESPERADO);
      assert.deepStrictEqual(M.linhasComoFluxo('﻿' + csv(BASICO)), ESPERADO);
      assert.throws(() => M.linhasComoFluxo(csv(BASICO, COLS.filter((c) => c !== 'val_disponibilidade'))), /sem a coluna val_disponibilidade/);
    });
    await caso('mês em UTC e mês anterior', () => {
      assert.strictEqual(M.mesUTC(new Date('2026-10-31T22:00:00-03:00')), '2026_11');
      assert.strictEqual(M.mesUTC(new Date('2026-10-31T20:59:00-03:00')), '2026_10');
      assert.strictEqual(M.mesAnterior('2026_11'), '2026_10');
      assert.strictEqual(M.mesAnterior('2027_01'), '2026_12');
    });
    await caso('topo do blob e URL do mês', async () => {
      const { r, urls, gravados } = await roda();
      assert.deepStrictEqual(r.map((x) => x.acao), ['gravou']);
      assert.deepStrictEqual(urls, ['HEAD RESTRICAO_COFF_FOTOVOLTAICA_2026_10.csv', 'GET RESTRICAO_COFF_FOTOVOLTAICA_2026_10.csv']);
      assert.strictEqual(gravados.length, 1);
      assert.strictEqual(gravados[0].nome, 'ons_restricao_2026_10.json');
      const j = gravados[0].j;
      assert.deepStrictEqual(Object.keys(j), ['periodo', 'atualizado', 'fonte', 'id_ons', 'complexo', 'consolidado']);
      assert.deepStrictEqual([j.periodo, j.fonte, j.id_ons, j.complexo],
        ['2026-10', 'ONS Dados Abertos - Constrained-off Fotovoltaica', 'CJU_CEMTD', 'CONJ. MAURITI']);
      assert.deepStrictEqual(j.consolidado, ESPERADO);
    });
    await caso('CSV não mais novo: nada gravado; forcar e CSV novo gravam', async () => {
      const blob = { atualizado: '2026-10-17T23:00:04.0975997Z', consolidado: [{}, {}] };
      let x = await roda({ blobs: { '2026_10': blob } });
      assert.deepStrictEqual([x.r[0].acao, x.gravados.length, x.urls.length], ['sem-novidade', 0, 1]);
      x = await roda({ blobs: { '2026_10': Object.assign({}, blob, { atualizado: '2026-10-17T22:06:44Z' }) } });
      assert.deepStrictEqual([x.r[0].acao, x.gravados.length], ['sem-novidade', 0], 'mesmo instante tambem');
      x = await roda({ blobs: { '2026_10': blob }, forcar: true });
      assert.deepStrictEqual([x.r[0].acao, x.gravados.length], ['gravou', 1]);
      x = await roda({ blobs: { '2026_10': Object.assign({}, blob, { atualizado: '2026-10-16T23:00:00Z' }) } });
      assert.deepStrictEqual([x.r[0].acao, x.gravados.length], ['gravou', 1]);
    });
    await caso('ausência legítima × defeito', async () => {
      await falha({ csvs: {} }, /2026_10: CSV do ONS respondeu HTTP 404/);                       /* dia 18: 404 e defeito */
      await falha({ head: { '2026_10': { status: 500 } } }, /HTTP 500/);
      await falha({ head: { '2026_10': { status: 403 } } }, /HTTP 403/);
      await falha({ csvs: { '2026_10': csv([BASICO[2]]) } }, /sem linha do CJU_CEMTD/);
      await falha({ le: async () => { throw new Error('leitura do blob: HTTP 500'); } }, /leitura do blob/);
      await falha({ blobs: { '2026_10': { atualizado: '2026-10-16T00:00:00Z', consolidado: [{}, {}, {}] } } }, /nunca piorar/);
      const x = await roda({ blobs: {} });
      assert.deepStrictEqual([x.r[0].acao, x.gravados.length], ['gravou', 1], 'blob 404 = primeira gravacao');
      const d2 = await roda({ agora: '2026-11-02T10:00:00Z', csvs: { '2026_10': csv(BASICO) } });
      assert.deepStrictEqual(d2.r.map((y) => y.acao), ['sem-csv', 'gravou'], 'dia 2: novembro ainda nao existe, outubro refeito');
      await falha({ agora: '2026-11-02T10:00:00Z', csvs: {} }, /2026_10: CSV do ONS respondeu HTTP 404/);  /* o mes anterior tem de existir */
    });
    await caso('virada: 31/10 22:00 BRT grava novembro e refaz outubro', async () => {
      const nov = csv([L('CJU_CEMTD', '2026-11-01 00:00:00', '0.0', '', '300.0', '0.0', '', '', '')]);
      /* o CSV de outubro mudou (o ONS publicou o dia 30 às 22:06 UTC de 31/10) depois da última gravação de outubro */
      const x = await roda({ agora: '2026-10-31T22:00:00-03:00', csvs: { '2026_11': nov, '2026_10': csv(BASICO) },
        head: { '2026_10': { status: 200, modificado: Date.parse('2026-10-31T22:06:44Z') } },
        blobs: { '2026_10': { atualizado: '2026-10-30T23:00:00Z', consolidado: [{}] } } });
      assert.deepStrictEqual(x.gravados.map((g) => g.nome), ['ons_restricao_2026_11.json', 'ons_restricao_2026_10.json']);
      assert.deepStrictEqual(x.urls.filter((u) => /^HEAD/.test(u)), ['HEAD RESTRICAO_COFF_FOTOVOLTAICA_2026_11.csv', 'HEAD RESTRICAO_COFF_FOTOVOLTAICA_2026_10.csv']);
      const dia3 = await roda({ agora: '2026-11-03T10:00:00Z', csvs: { '2026_11': nov } });
      assert.deepStrictEqual(dia3.gravados.map((g) => g.nome), ['ons_restricao_2026_11.json'], 'dia 3: so o mes corrente');
    });
    await caso('transporte: UTF-8 partido, Last-Modified e corpo truncado', async () => {
      const corpo = Buffer.from(csv(BASICO), 'utf8');
      const corte = corpo.indexOf(Buffer.from('ê', 'utf8')) + 1;   /* no meio do caractere de 2 bytes */
      const srv = net.createServer((s) => s.once('data', (d) => {
        const pedido = d.toString(), metodo = pedido.split(' ')[0], rota = pedido.split(' ')[1];
        const cab = (len) => 'HTTP/1.1 200 OK\r\nLast-Modified: Sat, 17 Oct 2026 22:06:44 GMT\r\nContent-Length: ' + len + '\r\nConnection: close\r\n\r\n';
        if (metodo === 'HEAD') { s.end(cab(corpo.length)); return; }
        const vazio = (st) => 'HTTP/1.1 ' + st + '\r\nContent-Length: 0\r\nConnection: close\r\n\r\n';
        if (/^\/blob404/.test(rota)) { s.end(vazio('404 Not Found')); return; }
        if (/^\/blob500/.test(rota)) { s.end(vazio('500 Erro')); return; }
        if (/^\/blobruim/.test(rota)) { s.end(cab(5) + '{"a":'); return; }
        if (/^\/blobok/.test(rota)) { const j = Buffer.from('﻿{"consolidado":[1,2]}', 'utf8'); s.write(cab(j.length)); s.end(j); return; }
        if (rota === '/curto') { s.write(cab(corpo.length + 50)); s.end(corpo); return; }
        s.write(cab(corpo.length)); s.write(corpo.subarray(0, corte));
        setTimeout(() => s.end(corpo.subarray(corte)), 30);
      }));
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const base = 'http://127.0.0.1:' + srv.address().port;
      try {
        const h = await M.pedeCsv('HEAD', base + '/x.csv');
        assert.deepStrictEqual([h.status, h.modificado], [200, Date.parse('2026-10-17T22:06:44Z')]);
        const g = await M.pedeCsv('GET', base + '/x.csv');
        assert.deepStrictEqual(M.linhasComoFluxo(g.texto), ESPERADO);
        await assert.rejects(M.pedeCsv('GET', base + '/curto'), /truncado|aborted|socket hang up|ECONNRESET/);
        /* o leitor do blob: 404 e "ainda nao existe"; 500 e JSON ilegivel ESTOURAM (nunca viram "sem blob") */
        assert.strictEqual(await M.leBlob(base + '/blob404'), null);
        await assert.rejects(M.leBlob(base + '/blob500'), /HTTP 500/);
        await assert.rejects(M.leBlob(base + '/blobruim'), /ilegivel/);
        assert.deepStrictEqual(await M.leBlob(base + '/blobok'), { consolidado: [1, 2] });
      } finally { srv.close(); }
    });
    await caso('a etapa do consolidador pinta o job e é chamada antes de consolidar', async () => {
      process.exitCode = undefined;
      const r = await M.etapaMesCorrente(async () => {}, 'base/', { agora: new Date('2026-10-18T15:00:00Z'), pede: async () => ({ status: 500 }), le: async () => null });
      assert.strictEqual(r, null);
      assert.strictEqual(process.exitCode, 1);
      process.exitCode = exitAntes;
      const fonte = fs.readFileSync(path.join(__dirname, 'gen-ons-consolidado.js'), 'utf8');
      const iE = fonte.indexOf("require('./repara-ons-mes.js').etapaMesCorrente(upload, BASE)"), iC = fonte.indexOf("prefix: 'ons_restricao_'");
      assert.ok(iE > 0, 'o consolidador nao chama a etapa do mes corrente');
      assert.ok(iC > iE, 'a etapa tem de vir antes de consolidar a restricao');
    });
  } finally { console.log = log; console.warn = warn; console.error = err; process.exitCode = exitAntes; }
  console.log('ensaio-ons-mes-corrente: ' + n + ' casos ok');
})().catch((e) => { console.error('REPROVOU:', e.message); process.exit(1); });
