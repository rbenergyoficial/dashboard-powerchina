'use strict';
/*
 * ensaio-gen-must-intra.js — EXECUTA o gen-must-intra.js de verdade, num processo a parte, com a Way2, o blob e o relogio
 * forjados (preload: este mesmo arquivo carregado com -r), e confere o que ele PEDE a fonte e o que ele GRAVA (LOCAL_OUT).
 * Lote must-gerador (22/10/2026). Nada sai da maquina: a rede e a leitura do contêiner `dados` sao trocadas no preload.
 *
 * Casos:
 *   1. hoje com o fim PROVISORIO (qualidade 2): o usina-instante provisorio fica AUSENTE, a linha sem as 9 fica sem Complexo,
 *      a linha toda provisoria nao entra; ontem completo nao e pedido de novo; a rodada seguinte com a mesma Way2 NAO regrava;
 *   2. o provisorio ja gravado numa linha de hoje sai quando a fonte ainda o da como provisorio (e a linha que ela nao da mais);
 *   3. celula vazia ('' e ' ') em qualidade 0 e nulo em qualidade 1 nao viram 0 MW;
 *   4. qualidade em texto estoura em vez de apagar hoje em silencio;
 *   5. 00:40 do dia seguinte, ontem gravado ate 23:30: ontem e relido, ganha o 23:45 e o balde das 00:00 e fica com os 96;
 *   6. ontem relido com o balde das 00:00 ainda provisorio: NAO estoura (a guarda de grade aceita dia mais curto), grava os 95
 *      e diz INCOMPLETO; a rodada seguinte, com a Way2 fechada, completa os 96;
 *   7. as 04:00 (depois de RELER_ONTEM_H) ontem incompleto nao e mais pedido; ontem completo as 00:40 tambem nao;
 *   8. na hora seguinte ao fim da releitura, ontem incompleto vira ::warning::; depois, nao;
 *   9. reler ontem nao apaga ontem: a Way2 curta ou vazia preserva o que ja estava gravado;
 *  10. ontem relido: a usina que continua provisoria sai da linha gravada (a linha nova substitui a velha inteira);
 *  11. ontem relido troca um valor provisorio que ja estava gravado pelo medido SEM mudar contagem nem ultimo instante: o blob
 *      e regravado (antes a guarda anti-regressao calava essa correcao);
 *  12. guarda de grade: 30 min pedido como 15 estoura (mesmo pela metade); fora do passo, acima do numero de amostras e fora
 *      do dia estouram;
 *  13. as quatro resolucoes juntas: cada uma rele ontem e fecha com o numero de amostras dela.
 *
 * Preload (env ENSAIO_GMI_CENARIO = arquivo JSON do cenario, ENSAIO_GMI_LOG = arquivo onde anotar os pedidos):
 *   Date.now fixo no `agora` do cenario; setTimeout sem espera; https.get responde pelo cenario; lib-le-dados devolve os blobs
 *   do cenario (404 para o que nao estiver la).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PONTOS = { 6380: 'M1', 6381: 'M2', 6382: 'M3', 6383: 'M4', 6384: 'M5', 6385: 'M6', 6386: 'M7', 6387: 'M8', 6388: 'M9' };
const P9 = Object.values(PONTOS);
const MIN = { CincoMinutos: 5, QuinzeMinutos: 15, TrintaMinutos: 30, UmaHora: 60 };
const KW = { M1: 30000, M2: 15000, M3: 30000, M4: 30000, M5: 30000, M6: 30000, M7: 9000, M8: 30000, M9: 6000 };
const iso = (ms) => new Date(ms - 3 * 3600000).toISOString().slice(0, 19);   /* hora local de Brasilia, sem offset */
const msDe = (s) => Date.parse(s.length === 16 ? s + ':00-03:00' : s + '-03:00');

/* ══ PRELOAD ══════════════════════════════════════════════════════════════════════════════════════════════════ */
if (require.main !== module && process.env.ENSAIO_GMI_CENARIO) {
  const Module = require('module');
  const EE = require('events');
  const CEN = JSON.parse(fs.readFileSync(process.env.ENSAIO_GMI_CENARIO, 'utf8'));
  const AGORA = msDe(CEN.agora);
  Date.now = () => AGORA;
  const st = global.setTimeout; global.setTimeout = (f, ms, ...a) => st(f, 0, ...a);

  /* a resposta da Way2 para um dia e uma resolucao. CEN.way2[dia] = { ate, q2: { 'HH:MM' ou 'AAAA-MM-DDTHH:MM': [usinas] | 'todas' },
     celula: { 'HH:MM': { M2: { valor, qualidade } } } (Demat e DematRec daquela usina), passo_errado: min, extra: ['AAAA-MM-DDTHH:MM'],
     qualidade_texto: true } ; dia ausente = sem dado nenhum */
  function resposta(dia, intervalo) {
    const D = CEN.way2[dia];
    const min = (D && D.passo_errado) || MIN[intervalo];
    const dados = [];
    for (const id of Object.keys(PONTOS)) for (const g of ['Demat', 'DematRec', 'DematDel']) dados.push({ pontoId: +id, nomeGrandeza: g, valores: [] });
    if (D) {
      const ini = msDe(dia + 'T00:00'), fim = Math.min(ini + 86400000, msDe(D.ate));
      const instantes = [];
      for (let ms = ini + min * 60000; ms <= fim; ms += min * 60000) instantes.push(ms);
      for (const e of (D.extra || [])) instantes.push(msDe(e));
      for (const ms of instantes) {
        const t = iso(ms), hm = t.slice(11, 16);
        const q2 = (D.q2 && (D.q2[t.slice(0, 16)] || D.q2[hm])) || [];
        for (const d of dados) {
          const p = PONTOS[d.pontoId];
          const cel = d.nomeGrandeza !== 'DematDel' && D.celula && D.celula[hm] && D.celula[hm][p];
          let v = { data: t, valor: d.nomeGrandeza === 'DematDel' ? 0 : KW[p], qualidade: q2 === 'todas' || q2.includes(p) ? 2 : 0 };
          if (cel) v = Object.assign(v, cel);
          if (D.qualidade_texto) v.qualidade = String(v.qualidade);
          d.valores.push(v);
        }
      }
    }
    return { dados };
  }
  require('https').get = (opts, cb) => {
    const q = new URLSearchParams(String(opts.path).split('?')[1]);
    const dia = String(q.get('medicao-datainicio')).slice(0, 10), intervalo = q.get('intervalo');
    fs.appendFileSync(process.env.ENSAIO_GMI_LOG, dia + ' ' + intervalo + '\n');
    const req = new EE(); req.destroy = () => {};
    const res = new EE(); res.statusCode = 200; res.resume = () => {};
    process.nextTick(() => { cb(res); res.emit('data', JSON.stringify(resposta(dia, intervalo))); res.emit('end'); });
    return req;
  };
  const carregaOrig = Module._load;
  Module._load = function (pedido, ...resto) {
    if (/lib-le-dados(\.js)?$/.test(pedido)) {
      return { pede: async (url) => {
        const nome = String(url).split('/dados/')[1];
        const b = (CEN.blobs || {})[nome];
        return b ? { status: 200, buf: Buffer.from(JSON.stringify(b)), etag: '"e"' } : { status: 404, buf: Buffer.alloc(0) };
      } };
    }
    return carregaOrig.call(this, pedido, ...resto);
  };
  return;
}

/* ══ O ENSAIO ═════════════════════════════════════════════════════════════════════════════════════════════════ */
const assert = require('assert');
const cp = require('child_process');
const GEN = process.env.ENSAIO_GMI_GEN || path.join(__dirname, 'gen-must-intra.js');

/* uma serie de blob ja gravada: linhas de `de` a `ate` (local), com as 9 usinas (ou menos), no formato do gerador */
function serie(min, de, ate, mexe) {
  const out = [];
  for (let ms = msDe(de); ms <= msDe(ate); ms += min * 60000) {
    const t = iso(ms), l = { t: t + '-03:00', ms };
    for (const p of P9) l[p] = KW[p] / 1000;
    for (const p of P9) l[p + '_c'] = 0;
    if (mexe) mexe(l, t.slice(11, 16));
    const ps = P9.filter((p) => typeof l[p] === 'number');
    if (ps.length === 9) { l.Complexo = Math.round(ps.reduce((a, p) => a + l[p], 0) * 1000) / 1000; l.Complexo_c = 0; }
    out.push(l);
  }
  return out;
}
const blob = (min, linhas) => ({ gerado_em: '2026-10-01T00:00:00.000Z', resolucao_min: min, serie: linhas });

function roda(cen, env) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-gmi-'));
  const arqCen = path.join(d, 'cenario.json'), log = path.join(d, 'pedidos.txt');
  fs.writeFileSync(arqCen, JSON.stringify(cen)); fs.writeFileSync(log, '');
  const r = cp.spawnSync(process.execPath, ['-r', __filename, GEN], { encoding: 'utf8', timeout: 120000,
    env: Object.assign({}, process.env, { ENSAIO_GMI_CENARIO: arqCen, ENSAIO_GMI_LOG: log, WAY2_TOKEN: 'ensaio', LOCAL_OUT: d + path.sep,
      DIAS: '2', FORCAR: '', DADOS_STORAGE: '', DADOS_SAS: '', AZURE_CLIENT_ID: '', AZURE_TENANT_ID: '' }, env || {}) });
  const ler = (n) => { const f = path.join(d, n); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; };
  const out = { exit: r.status, stdout: r.stdout || '', stderr: r.stderr || '', pedidos: fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean),
    m5: ler('must_5min.json'), m15: ler('must_15min.json'), m30: ler('must_30min.json'), m60: ler('must_60min.json') };
  fs.rmSync(d, { recursive: true, force: true });
  return out;
}
const doDia = (b, dia) => b.serie.filter((l) => l.ms > msDe(dia + 'T00:00') && l.ms <= msDe(dia + 'T00:00') + 86400000);
const cheias = (ls) => ls.filter((l) => P9.every((p) => typeof l[p] === 'number')).length;
const linhaEm = (b, t) => b.serie.find((l) => l.t === t + ':00-03:00');
let n = 0;
const caso = (nome, f) => { f(); n++; console.log('ok · ' + nome); };
const so15 = { SO: '15' };

/* o estado de partida comum: anteontem (20/10) e ontem (21/10) completos no blob de 15 min */
const B15_BASE = serie(15, '2026-10-20T00:15', '2026-10-22T00:00');

caso('hoje com o fim provisorio: o provisorio fica ausente, ontem completo nao e pedido', () => {
  const r = roda({ agora: '2026-10-22T12:31', blobs: { 'must_15min.json': blob(15, B15_BASE) },
    way2: { '2026-10-22': { ate: '2026-10-22T12:30', q2: { '12:15': ['M6', 'M9'], '12:30': 'todas' } } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(r.pedidos, ['2026-10-22 QuinzeMinutos'], 'so hoje e pedido');
  const l1215 = linhaEm(r.m15, '2026-10-22T12:15');
  assert.ok(l1215, 'a linha das 12:15 existe (7 usinas medidas)');
  assert.deepStrictEqual(P9.filter((p) => typeof l1215[p] === 'number'), ['M1', 'M2', 'M3', 'M4', 'M5', 'M7', 'M8']);
  assert.ok(!('Complexo' in l1215), 'sem as 9 nao ha Complexo');
  assert.strictEqual(linhaEm(r.m15, '2026-10-22T12:30'), undefined, 'a linha toda provisoria nao entra');
  assert.strictEqual(linhaEm(r.m15, '2026-10-22T12:00').Complexo, 210, 'a medida entra inteira (6 x 30 + 15 + 9 + 6 MW)');
  assert.ok(/qualidade de Demat \{"0":\d+,"2":\d+\}/.test(r.stdout), r.stdout);
  /* controle negativo da anti-regressao: a rodada seguinte, com a MESMA Way2 sobre o blob que esta gravou, nao regrava */
  const r2 = roda({ agora: '2026-10-22T12:31', blobs: { 'must_15min.json': r.m15 },
    way2: { '2026-10-22': { ate: '2026-10-22T12:30', q2: { '12:15': ['M6', 'M9'], '12:30': 'todas' } } } }, so15);
  assert.strictEqual(r2.exit, 0, r2.stderr + r2.stdout);
  assert.strictEqual(r2.m15, null, 'regravou sem mudanca: ' + r2.stdout);
  assert.ok(/must_15min\.json +nada novo \(\d+ linhas\) — NAO regravado/.test(r2.stdout), r2.stdout);
});
caso('o provisorio JA GRAVADO numa linha de hoje sai quando a fonte ainda o da como provisorio', () => {
  /* uma rodada anterior gravou o M6 das 12:15 com 67,443 MW e a linha das 12:30 inteira, com Complexo; a Way2 agora da o M6
     das 12:15 e TODAS as usinas das 12:30 em qualidade 2 */
  const hoje = serie(15, '2026-10-22T00:15', '2026-10-22T12:30', (l, hm) => { if (hm === '12:15') l.M6 = 67.443; });
  const r = roda({ agora: '2026-10-22T12:31', blobs: { 'must_15min.json': blob(15, B15_BASE.concat(hoje.filter((l) => l.ms > msDe('2026-10-22T00:00')))) },
    way2: { '2026-10-22': { ate: '2026-10-22T12:30', q2: { '12:15': ['M6'], '12:30': 'todas' } } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.ok(r.m15, 'regravado: ' + r.stdout);
  const l = linhaEm(r.m15, '2026-10-22T12:15');
  assert.ok(!('M6' in l) && !('Complexo' in l), JSON.stringify(l));
  assert.strictEqual(linhaEm(r.m15, '2026-10-22T12:30'), undefined, 'a linha gravada que a fonte nao da mais como medida sai');
});
caso('celula vazia em qualidade 0 e nulo em qualidade 1 nao viram 0 MW', () => {
  const r = roda({ agora: '2026-10-22T12:31', blobs: { 'must_15min.json': blob(15, B15_BASE) },
    way2: { '2026-10-22': { ate: '2026-10-22T12:00', celula: { '12:00': { M2: { valor: '', qualidade: 0 }, M3: { valor: ' ', qualidade: 0 }, M4: { valor: null, qualidade: 1 } } } } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  const l = linhaEm(r.m15, '2026-10-22T12:00');
  assert.deepStrictEqual(['M2', 'M3', 'M4'].filter((p) => p in l), [], JSON.stringify(l));
  assert.ok(!('Complexo' in l));
});
caso('qualidade em texto estoura em vez de apagar hoje', () => {
  const r = roda({ agora: '2026-10-22T12:31', blobs: { 'must_15min.json': blob(15, B15_BASE.concat(serie(15, '2026-10-22T00:15', '2026-10-22T12:00'))) },
    way2: { '2026-10-22': { ate: '2026-10-22T12:00', qualidade_texto: true } } }, so15);
  assert.notStrictEqual(r.exit, 0);
  assert.ok(/qualidade nao numerica \("0"\)/.test(r.stderr), r.stderr);
  assert.strictEqual(r.m15, null, 'nada gravado');
});

/* ontem (22/10) gravado ate 23:30, sem o 23:45 e o balde das 00:00 */
const B15_ONTEM_CURTO = serie(15, '2026-10-21T00:15', '2026-10-22T23:30');
caso('00:40 do dia seguinte: ontem e relido e fica com os 96', () => {
  const r = roda({ agora: '2026-10-23T00:40', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T00:30' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(r.pedidos.sort(), ['2026-10-22 QuinzeMinutos', '2026-10-23 QuinzeMinutos']);
  assert.strictEqual(cheias(doDia(r.m15, '2026-10-22')), 96);
  assert.ok(linhaEm(r.m15, '2026-10-23T00:00'), 'o balde das 00:00 (de ontem) chegou');
});
caso('ontem relido com o 00:00 ainda provisorio: nao estoura, diz INCOMPLETO, e a rodada seguinte completa', () => {
  const cen = { agora: '2026-10-23T00:20', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00', q2: { '2026-10-23T00:00': 'todas' } }, '2026-10-23': { ate: '2026-10-23T00:15' } } };
  let r = roda(cen, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.strictEqual(cheias(doDia(r.m15, '2026-10-22')), 95);
  assert.ok(/2026-10-22 .*15min:95 \(INCOMPLETO\)/.test(r.stdout), r.stdout);
  /* a rodada seguinte parte do blob que esta acabou de gravar, com a Way2 ja fechada */
  r = roda({ agora: '2026-10-23T00:35', blobs: { 'must_15min.json': r.m15 },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T00:30' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.ok(r.pedidos.includes('2026-10-22 QuinzeMinutos'), 'ontem incompleto e pedido de novo');
  assert.strictEqual(cheias(doDia(r.m15, '2026-10-22')), 96);
});
caso('depois de RELER_ONTEM_H ontem nao e pedido; ontem completo tambem nao', () => {
  let r = roda({ agora: '2026-10-23T04:00', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T03:45' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(r.pedidos, ['2026-10-23 QuinzeMinutos']);
  r = roda({ agora: '2026-10-23T00:40', blobs: { 'must_15min.json': blob(15, serie(15, '2026-10-21T00:15', '2026-10-23T00:00')) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T00:30' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.deepStrictEqual(r.pedidos, ['2026-10-23 QuinzeMinutos']);
});
caso('na hora seguinte ao fim da releitura, ontem incompleto vira ::warning::; depois, nao', () => {
  const way2 = { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T03:15' } };
  let r = roda({ agora: '2026-10-23T03:30', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) }, way2 }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.ok(/::warning::gen-must-intra: 2026-10-22 em 15min fechou a releitura com 94 de 96 intervalos/.test(r.stdout), r.stdout);
  r = roda({ agora: '2026-10-23T04:30', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) }, way2 }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.ok(!/::warning::/.test(r.stdout), r.stdout);
});
caso('reler ontem nao apaga ontem: a Way2 curta preserva o que ja estava gravado', () => {
  /* ontem (22/10) gravado ate 23:30 e medido; a Way2 relida as 00:20 so devolve ate o meio-dia */
  const r = roda({ agora: '2026-10-23T00:20', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) },
    way2: { '2026-10-22': { ate: '2026-10-22T12:00' }, '2026-10-23': { ate: '2026-10-23T00:15' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.strictEqual(cheias(doDia(r.m15 || blob(15, B15_ONTEM_CURTO), '2026-10-22')), 94, 'as 94 linhas medidas de ontem continuam');
  assert.ok(r.m15 ? linhaEm(r.m15, '2026-10-22T23:30') : true);
  /* e com a Way2 respondendo ontem VAZIO (HTTP 200 sem valor) */
  const r2 = roda({ agora: '2026-10-23T00:20', blobs: { 'must_15min.json': blob(15, B15_ONTEM_CURTO) },
    way2: { '2026-10-23': { ate: '2026-10-23T00:15' } } }, so15);
  assert.strictEqual(r2.exit, 0, r2.stderr + r2.stdout);
  assert.strictEqual(cheias(doDia(r2.m15 || blob(15, B15_ONTEM_CURTO), '2026-10-22')), 94);
});
caso('ontem relido: a usina que continua provisoria sai da linha gravada', () => {
  /* ontem com o M6 das 14:00 gravado provisorio (67,443) e o 23:45/00:00 faltando; a Way2 relida ainda da o M6 das 14:00 em qualidade 2 */
  const ontem = serie(15, '2026-10-21T00:15', '2026-10-22T23:30', (l) => { if (l.t.startsWith('2026-10-22T14:00')) l.M6 = 67.443; });
  const r = roda({ agora: '2026-10-23T00:20', blobs: { 'must_15min.json': blob(15, ontem) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00', q2: { '14:00': ['M6'] } }, '2026-10-23': { ate: '2026-10-23T00:15' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  const l = linhaEm(r.m15, '2026-10-22T14:00');
  assert.ok(!('M6' in l) && !('Complexo' in l), JSON.stringify(l));
});
caso('ontem relido troca o provisorio gravado pelo medido sem mudar contagem: o blob e regravado', () => {
  /* ontem com o 23:45 sem o M9 (incompleto, entao relido) e o M6 das 14:00 ainda com o provisorio de 67 MW; hoje sem dado ainda */
  const ontem = serie(15, '2026-10-21T00:15', '2026-10-23T00:00', (l, hm) => {
    if (l.t.startsWith('2026-10-22T14:00')) l.M6 = 67.443;
    if (l.t.startsWith('2026-10-22T23:45')) delete l.M9;
  });
  const r = roda({ agora: '2026-10-23T00:10', blobs: { 'must_15min.json': blob(15, ontem) },
    way2: { '2026-10-22': { ate: '2026-10-23T00:00' } } }, so15);
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  assert.ok(r.m15, 'regravado: ' + r.stdout);
  assert.strictEqual(r.m15.serie.length, ontem.length, 'mesma contagem');
  assert.strictEqual(linhaEm(r.m15, '2026-10-22T14:00').M6, 30, 'o medido no lugar do provisorio');
  assert.strictEqual(cheias(doDia(r.m15, '2026-10-22')), 96);
});
caso('guarda de grade: 30 min pedido como 15 estoura, mesmo pela metade', () => {
  /* anteontem (21/10) ausente no blob: e buscado; a Way2 responde de 30 em 30 min ate o meio-dia */
  const r = roda({ agora: '2026-10-23T10:00', blobs: { 'must_15min.json': blob(15, serie(15, '2026-10-22T00:15', '2026-10-23T00:00')) },
    way2: { '2026-10-21': { ate: '2026-10-21T12:00', passo_errado: 30 }, '2026-10-23': { ate: '2026-10-23T09:45' } } }, so15);
  assert.notStrictEqual(r.exit, 0);
  assert.ok(/2026-10-21 em 15min voltou com passo minimo de 30 min/.test(r.stderr), r.stderr);
  assert.strictEqual(r.m15, null, 'nada gravado');
  const r2 = roda({ agora: '2026-10-23T10:00', blobs: { 'must_15min.json': blob(15, serie(15, '2026-10-22T00:15', '2026-10-23T00:00')) },
    way2: { '2026-10-21': { ate: '2026-10-21T04:00', passo_errado: 5 }, '2026-10-23': { ate: '2026-10-23T09:45' } } }, so15);
  assert.notStrictEqual(r2.exit, 0);
  assert.ok(/fora da grade de 15 min/.test(r2.stderr), r2.stderr);   /* 48 amostras de 5 min: cabem no numero, nao na grade */
  const r3 = roda({ agora: '2026-10-23T10:00', blobs: { 'must_15min.json': blob(15, serie(15, '2026-10-22T00:15', '2026-10-23T00:00')) },
    way2: { '2026-10-21': { ate: '2026-10-21T12:00', passo_errado: 5 }, '2026-10-23': { ate: '2026-10-23T09:45' } } }, so15);
  assert.ok(/voltou com 144 amostras, no maximo 96/.test(r3.stderr), r3.stderr);
  /* um instante na grade certa, mas fora do dia pedido (o 00:15 do dia seguinte) */
  const r4 = roda({ agora: '2026-10-23T10:00', blobs: { 'must_15min.json': blob(15, serie(15, '2026-10-22T00:15', '2026-10-23T00:00')) },
    way2: { '2026-10-21': { ate: '2026-10-21T12:00', extra: ['2026-10-22T00:15'] }, '2026-10-23': { ate: '2026-10-23T09:45' } } }, so15);
  assert.notStrictEqual(r4.exit, 0);
  assert.ok(/2026-10-21 em 15min voltou com 2026-10-22T00:15:00-03:00 fora da grade/.test(r4.stderr), r4.stderr);
});
caso('as quatro resolucoes releem ontem e fecham com as amostras de cada uma', () => {
  const blobs = {};
  for (const [nome, min] of [['must_5min.json', 5], ['must_15min.json', 15], ['must_30min.json', 30], ['must_60min.json', 60]])
    blobs[nome] = blob(min, serie(min, '2026-10-21T01:00', '2026-10-22T23:00'));
  const r = roda({ agora: '2026-10-23T00:40', blobs, way2: { '2026-10-22': { ate: '2026-10-23T00:00' }, '2026-10-23': { ate: '2026-10-23T00:30' } } });
  assert.strictEqual(r.exit, 0, r.stderr + r.stdout);
  const pedidosOntem = r.pedidos.filter((p) => p.startsWith('2026-10-22')).map((p) => p.split(' ')[1]).sort();
  assert.deepStrictEqual(pedidosOntem, ['CincoMinutos', 'QuinzeMinutos', 'TrintaMinutos', 'UmaHora']);
  assert.deepStrictEqual([r.m5, r.m15, r.m30, r.m60].map((b) => cheias(doDia(b, '2026-10-22'))), [288, 96, 48, 24]);
});

console.log('ensaio-gen-must-intra: ' + n + ' casos ok');
