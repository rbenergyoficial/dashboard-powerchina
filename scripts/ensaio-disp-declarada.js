'use strict';
/*
 * ensaio-disp-declarada.js — a disponibilidade declarada do executivo (`lib-disp-declarada.js`), PROMOVER disp-janela,
 * 10/10/2026. Dois modos:
 *
 *   (sem argumento) A REGRA, antes de gerar: meses FORJADOS, defeitos PLANTADOS na lib e a FIACAO no gerador. Sem rede e
 *                   sem blob, vale em qualquer estado do mundo.
 *   --produto       O PRODUTO, depois de gerar: refaz `disp_pct` e `disp_cobertura_pct` de cada mes do `executivo.json`
 *                   publicado direto do `ons_restricao_all.json` cru, com a janela escrita AQUI (sem a lib), e exige
 *                   igualdade no centesimo. Pega o gerador que chama a lib e ainda assim publica outra coisa. Le so blob
 *                   publico (ou BASE_DADOS=<pasta local>).
 *
 * POR QUE EXISTE. A media era sobre "o que o operador publicou", e ele mudou tres vezes o que publica no campo `disp`:
 * as 48 meias horas ate 06/07/2026, so 04:00–19:30 de 07/07 a setembro, e em out/26 a madrugada de volta com o conjunto
 * sem o M2 e o M6 (~270,1 MW). O cartao passou a comparar janelas diferentes mes a mes (out 90,20 % com a noite, set
 * 99,10 % sem ela). A janela agora e fixa, 04:00–17:30, em todo mes; dentro dela `disp` <= 0 e ausencia de publicacao.
 * A regra prova os tres formatos de publicacao do operador, as bordas da janela, o zero dentro dela, o tipo do campo (o
 * arquivo traz texto ate mai/26 e NUMERO de jun a set/26), a capacidade passada pelo gerador, o `ts` fora do formato e a
 * queda real de dia — que nao pode sumir junto com a noite.
 *
 * E PROVA QUE REPROVA: compila a lib com os defeitos de PLANTIOS (cada troca conferida: achada uma vez e o texto mudou) e
 * exige que cada um faca pelo menos um caso sair do esperado. A fiacao tem as suas contraprovas: o gerador do HEAD de
 * antes do lote e quatro geradores quebrados de jeitos que um texto frouxo deixaria passar (revisor-ensaio, 10/10/2026).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const PRODUTO = process.argv.includes('--produto');
const FONTE = path.join(__dirname, 'lib-disp-declarada.js');
const GERADOR = path.join(__dirname, 'gen-executivo.js');
const CAP = 343.77, SEM_M2_M6 = 270.101;   // outorga; o conjunto sem o M2 (24,555) e o M6 (49,109), publicado em out/26
const r2 = (x) => Math.round(x * 100) / 100;
const f = [];
const fim = (nome) => {
  if (f.length) { console.error('\nREPROVADO:'); f.forEach((x) => console.error('   🔴 ' + x)); process.exit(1); }
  console.log('\nensaio-disp-declarada' + nome + ' · TUDO PASSOU');
};

/* ================================ PRODUTO (depois de gerar) ================================ */
if (PRODUTO) {
  const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
  const deJson = (buf) => JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  const pega = (nome) => {
    if (!/^https?:/.test(BASE)) { const p = path.join(BASE, nome);
      return Promise.resolve({ j: deJson(fs.readFileSync(p)), mod: fs.statSync(p).mtime }); }
    return new Promise((ok, erro) => {
      https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
        if (r.statusCode !== 200) { r.resume(); return erro(new Error(nome + ': HTTP ' + r.statusCode)); }
        const ch = []; r.on('data', (d) => ch.push(d));
        r.on('end', () => { try { ok({ j: deJson(Buffer.concat(ch)), mod: new Date(r.headers['last-modified']) }); } catch (e) { erro(e); } });
      }).on('error', erro).on('timeout', function () { this.destroy(new Error(nome + ': tempo esgotado')); });
    });
  };
  (async () => {
    const [E, O] = await Promise.all([pega('executivo.json'), pega('ons_restricao_all.json')]);
    // O PATAMAR QUE O EXECUTIVO TROCOU (PROMOVER ref-parcela-corte, 11/10/2026): o conjunto publicou nenhuma ou uma parcela
    // (01/10 09:00: disp 49,105 com 245,6 MW gerados), e o gerador tira a disp dele da media como nao publicada. A lista vem
    // explicita no produto (`ref_conjunto_pela_soma`); aqui ela so e aceita se o patamar existe no arquivo cru e se
    // contradiz como a regra diz (disp abaixo do gerado). Fora dela, nada muda nesta rota.
    // Cada item e conferido CONTRA O CRU (revisor-ensaio, RE-021): o gref, a disp e o ger publicados sao os do arquivo, a soma
    // esta longe do gref (o patamar nao fechava), o gref e zero ou abaixo da soma (parcela que falta), no maximo o teto por
    // dia, e a contagem por dia e a marca da `serie_diaria`. So os NUMEROS da folga e do teto vem da lib; a conta e desta rota.
    const { FOLGA_MW, MAX_POR_DIA } = require('./lib-ref-conjunto.js');
    const pelaSoma = new Set(), porDia = {};
    const cruPorTs = new Map((O.j.consolidado || []).map((r) => [String(r.ts).slice(0, 16), r]));
    const perto = (a, b) => Math.abs(Number(a) - Number(b)) <= 0.0005;
    for (const x of E.j.ref_conjunto_pela_soma || []) {
      const r = cruPorTs.get(String(x.ts)), id = 'ref_conjunto_pela_soma: ' + x.ts;
      if (!r) { f.push(id + ' nao existe no arquivo do conjunto'); continue; }
      if (!(Number(r.disp) < Number(r.ger))) { f.push(id + ' tem disp ' + r.disp + ' >= ger ' + r.ger + ' no arquivo cru'); continue; }
      if (!perto(x.gref_publicado, r.gref) || !perto(x.disp_publicada, r.disp) || !perto(x.ger, r.ger)) {
        f.push(id + ' nao e o patamar do cru (publicado ' + [x.gref_publicado, x.disp_publicada, x.ger].join('/') + ', cru ' + [r.gref, r.disp, r.ger].join('/') + ')'); continue; }
      const g = Number(r.gref), s = Number(x.soma_usinas);
      if (!(Math.abs(s - g) > FOLGA_MW)) { f.push(id + ' ja fecha com a soma das usinas (' + g + ' x ' + s + ')'); continue; }
      if (!(g === 0 || s >= g + FOLGA_MW)) { f.push(id + ' tem o gref acima da soma: nao e parcela que falta'); continue; }
      pelaSoma.add(String(x.ts)); const d = String(x.ts).slice(0, 10); porDia[d] = (porDia[d] || 0) + 1;
    }
    Object.entries(porDia).forEach(([d, n]) => { if (n > MAX_POR_DIA) f.push('ref_conjunto_pela_soma: ' + n + ' patamares em ' + d + ', acima do teto'); });
    for (const s of E.j.serie_diaria || []) if (s.ref_pela_soma != null && s.ref_pela_soma !== (porDia[s.dia] || 0))
      f.push('serie_diaria ' + s.dia + ': ref_pela_soma ' + s.ref_pela_soma + ' contra ' + (porDia[s.dia] || 0) + ' na lista conferida');
    // a janela escrita de novo, de proposito sem a lib: minutos do dia do INICIO do patamar, 04:00 (240) a 17:30 (1050)
    const M = {};
    for (const r of O.j.consolidado || []) {
      const m = /^(\d{4}-\d{2})-\d{2} (\d{2}):(\d{2})/.exec(String(r.ts)); if (!m) continue;
      const min = Number(m[2]) * 60 + Number(m[3]); if (min < 240 || min > 1050) continue;
      const o = M[m[1]] || (M[m[1]] = { s: 0, d: 0, n: 0 }); o.n++;
      const v = pelaSoma.has(String(r.ts).slice(0, 16)) ? 0 : Number(r.disp);
      if (Number.isFinite(v) && v > 0) { o.s += v; o.d++; }
    }
    if (pelaSoma.size) console.log('   ' + pelaSoma.size + ' patamar(es) com a disp fora da media pela troca do executivo: ' + [...pelaSoma].join(', '));
    const serie = E.j.serie || [];
    const julgados = [];
    for (const s of serie) {
      const o = M[s.mes];
      const esp = s.sem_ons ? { p: null, c: null } : { p: o && o.d ? r2(o.s / o.d / CAP * 100) : null, c: o && o.n ? r2(100 * o.d / o.n) : null };
      julgados.push(s.mes + ' ' + s.disp_pct + '/' + s.disp_cobertura_pct);
      if (s.disp_pct !== esp.p || s.disp_cobertura_pct !== esp.c)
        f.push(s.mes + ': o executivo diz ' + s.disp_pct + ' % / cobertura ' + s.disp_cobertura_pct + ' %, o arquivo do conjunto da '
          + esp.p + ' % / ' + esp.c + ' % na janela 04:00–17:30');
    }
    const cur = serie.find((s) => s.mes === (E.j.mes || {}).mes);
    if (!cur) f.push('o mes da manchete (' + (E.j.mes || {}).mes + ') nao esta na serie');
    else if (E.j.mes.disp_pct !== cur.disp_pct || E.j.mes.disp_cobertura_pct !== cur.disp_cobertura_pct)
      f.push('a manchete diz ' + E.j.mes.disp_pct + ' % e a serie do mesmo mes ' + cur.disp_pct + ' %');
    if (serie.filter((s) => !s.sem_ons).length < 12) f.push('a serie tem ' + serie.length + ' mes(es) com o operador — esperava pelo menos 12');
    console.log('   ' + julgados.length + ' mes(es) conferidos contra o arquivo cru: ' + julgados.slice(-4).join(' · '));
    // DUAS VINTAGES: o arquivo do conjunto e regravado por outro workflow (~18:17Z e ~23Z). Se ele mudou depois que o
    // executivo foi montado, a diferenca e de vintage e nao do gerador: o ensaio DIZ que nao julgou, nao passa calado.
    const montado = new Date(E.j.atualizado);
    if (f.length && O.mod > new Date(montado.getTime() - 15 * 60000)) {
      console.log('   ⚠️ NAO JULGADO: o arquivo do conjunto foi regravado as ' + O.mod.toISOString() + ', perto ou depois do executivo ('
        + E.j.atualizado + '). As diferencas abaixo sao de vintage; a proxima rodada julga.');
      f.forEach((x) => console.log('      ' + x));
      console.log('\nensaio-disp-declarada --produto: NAO JULGADO (duas vintages) — sai sem reprovar e sem afirmar nada');
      return;
    }
    fim(' --produto');
  })().catch((e) => { console.error('ensaio-disp-declarada --produto: ' + e.message); process.exit(1); });
  return;
}

/* ================================ REGRA (antes de gerar) ================================ */
const hh = (k) => String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00');
/* um mes de `dias` dias; `disp(k, dia)` da o valor publicado na meia hora k (0..47), NO TIPO EM QUE VEM (texto ou numero),
   ou undefined para a linha faltar */
function mes(dias, disp, tsDe) {
  const L = [];
  for (let d = 1; d <= dias; d++) for (let k = 0; k < 48; k++) {
    const v = disp(k, d); if (v === undefined) continue;
    L.push({ ts: tsDe ? tsDe(k, d) : '2026-10-' + String(d).padStart(2, '0') + ' ' + hh(k) + ':00', disp: v });
  }
  return L;
}
const txt = (x) => String(x);
const noite = (k) => k < 8 || k >= 36;            // fora de 04:00–17:30
const CASOS = [
  { nome: 'as 48 meias horas cheias (set/25 a 06/07/2026), em texto', L: mes(3, () => txt(CAP)), pct: 100, cob: 100 },
  { nome: 'a madrugada zerada (07/07 a setembro de 2026), em NUMERO como no arquivo de jun a set/26',
    L: mes(3, (k) => (k < 8 || k >= 40 ? 0 : CAP)), pct: 100, cob: 100 },
  { nome: 'out/26: 18:00–20:00 zerados e a noite sem o M2 e o M6 — a noite nao entra',
    L: mes(3, (k) => txt(k >= 36 && k <= 40 ? 0 : noite(k) ? SEM_M2_M6 : CAP)), pct: 100, cob: 100 },
  { nome: 'queda REAL de dia: o conjunto sem o M2 e o M6 o dia inteiro (06–07/10)', L: mes(2, () => txt(SEM_M2_M6)),
    pct: 78.57, cob: 100 },
  { nome: 'mes misto, texto e numero: dia 1 em texto cheio, dia 2 em numero sem o M2 e o M6',
    L: mes(2, (k, d) => (d === 1 ? txt(CAP) : SEM_M2_M6)), pct: 89.29, cob: 100 },
  { nome: 'um zero dentro da janela (01/10 09:00 de 03/10) e ausencia, nao parada', L: mes(1, (k) => txt(k === 18 ? 0 : CAP)),
    pct: 100, cob: 96.43 },
  { nome: 'campo vazio e texto nao numerico dentro da janela tambem sao ausencia', L: mes(1, (k) => (k === 18 ? '' : k === 19 ? 'nd' : txt(CAP))),
    pct: 100, cob: 92.86 },
  { nome: 'borda de abertura: 04:00 entra', L: mes(1, (k) => txt(k === 8 ? CAP / 2 : CAP)), pct: 98.21, cob: 100 },
  { nome: 'borda de fechamento: 17:30 entra', L: mes(1, (k) => txt(k === 35 ? CAP / 2 : CAP)), pct: 98.21, cob: 100 },
  { nome: 'fora das bordas: 03:30 e 18:00 nao entram', L: mes(1, (k) => txt(k === 7 || k === 36 ? CAP / 2 : CAP)), pct: 100, cob: 100 },
  { nome: 'linha faltando no arquivo nao vira patamar da janela', L: mes(1, (k) => (k === 20 ? undefined : txt(CAP))), pct: 100, cob: 100 },
  { nome: 'a capacidade e a do gerador: com metade da outorga o mesmo mes da o dobro',
    L: mes(1, () => txt(SEM_M2_M6 / 2)), cap: CAP / 2, pct: 78.57, cob: 100 },
  { nome: 'ts em ISO UTC (…T07:00:00Z = 04:00 aqui) nao entra pela hora errada: o mes sai nulo',
    L: mes(1, (k) => txt(noite(k) ? CAP / 2 : CAP), (k) => '2026-10-01T' + hh(k) + ':00Z'), pct: null, cob: null },
  { nome: 'nada declarado na janela: nulo, nunca zero', L: mes(1, (k) => txt(noite(k) ? CAP : 0)), pct: null, cob: 0 },
  { nome: 'mes sem linha nenhuma: os dois nulos', L: [], pct: null, cob: null },
];

function julga(lib) {
  return CASOS.map((c) => {
    let o;
    try { const m = lib.novo(); c.L.forEach((r) => lib.acumula(m, r)); o = lib.fecha(m, c.cap || CAP); }
    catch (e) { return { nome: c.nome, ok: false, veio: 'estourou: ' + e.message, espera: c.pct + ' % / ' + c.cob + ' %' }; }
    const ok = o.disp_pct === c.pct && o.disp_cobertura_pct === c.cob;
    return { nome: c.nome, ok, veio: o.disp_pct + ' % / ' + o.disp_cobertura_pct + ' %', espera: c.pct + ' % / ' + c.cob + ' %' };
  });
}

function compila(src) {
  const m = { exports: {} };
  new Function('module', 'exports', 'require', src)(m, m.exports, require);
  return m.exports;
}

const src = fs.readFileSync(FONTE, 'utf8').replace(/\r\n/g, '\n');
const R = julga(compila(src));
R.forEach((x) => console.log('   ' + (x.ok ? 'ok ' : '🔴 ') + x.nome + ' -> ' + x.veio));
R.filter((x) => !x.ok).forEach((x) => f.push('a regra errou: ' + x.nome + ' (esperado ' + x.espera + ', veio ' + x.veio + ')'));
if (R.length !== CASOS.length || R.length < 15) f.push('julgou ' + R.length + ' caso(s), esperava ' + CASOS.length);

const PLANTIOS = [
  ['a media sobre o que veio (sem janela)', "const JANELA = { de: '04:00', ate: '17:30' };", "const JANELA = { de: '00:00', ate: '23:30' };"],
  ['a janela de jul–set (ate 19:30)', "ate: '17:30' }", "ate: '19:30' }"],
  ['o zero contado como parada', 'd > 0) { m.disp += d', 'd >= 0) { m.disp += d'],
  ['abertura exclusiva', 'h >= JANELA.de', 'h > JANELA.de'],
  ['fechamento exclusivo', 'h <= JANELA.ate', 'h < JANELA.ate'],
  ['cobertura sobre todas as linhas do mes', 'if (!naJanela(r.ts)) return;\n  m.n_janela++;', 'm.n_janela++;\n  if (!naJanela(r.ts)) return;'],
  ['nulo virando zero', 'disp_pct: m.n_disp ? r2(m.disp / m.n_disp / capMw * 100) : null', 'disp_pct: m.n_disp ? r2(m.disp / m.n_disp / capMw * 100) : 0'],
  ['so texto (o numero de jun a set/26 estoura)', 'const d = Number(r.disp);', "const d = Number(r.disp.replace(',', '.'));"],
  ['so texto, em silencio (o numero vira ausencia)', 'const d = Number(r.disp);', "const d = typeof r.disp === 'string' ? Number(r.disp) : 0;"],
  ['a outorga cravada na lib', 'function fecha(m, capMw) {', 'function fecha(m, _c) { const capMw = 343.77;'],
  ['qualquer formato de ts', 'if (!FORMATO_TS.test(s)) return false;', ''],
];
for (const [nome, de, para] of PLANTIOS) {
  const n = src.split(de).length - 1;
  if (n !== 1) { f.push('plantio "' + nome + '": o trecho aparece ' + n + ' vez(es) na lib — o plantio nao foi feito'); continue; }
  const mut = src.replace(de, para);
  if (mut === src) { f.push('plantio "' + nome + '": o texto nao mudou'); continue; }
  const erros = julga(compila(mut)).filter((x) => !x.ok).map((x) => x.nome);
  console.log('   plantio "' + nome + '": ' + erros.length + ' caso(s) fora do esperado');
  if (!erros.length) f.push('plantio "' + nome + '" passou em todos os casos — o ensaio nao o pega');
}

/* a fiacao: o gerador chama a lib, numa linha propria, no laco do arquivo do conjunto e no objeto do mes; nao acumula
   `disp` por conta propria; e toda chave `disp_pct`/`disp_cobertura_pct` que ele escreve e uma das quatro repassagens
   conhecidas (manchete, banda por usina, disponibilidade no inversor) — qualquer outra e conta feita fora da lib */
const REPASSE = new Set(['cur.disp_pct', 'cur.disp_cobertura_pct', 'S.disp_pct', 'v']);
function fiacao(g) {
  const e = [];
  if (!/^const DISP = require\('\.\/lib-disp-declarada\.js'\);/m.test(g)) e.push('sem o require da lib');
  const laco = g.indexOf('for (const r of restr.consolidado) {');
  const fimLaco = laco < 0 ? -1 : g.indexOf('// ---------- 2)', laco);
  if (laco < 0 || fimLaco < 0) e.push('o laco do arquivo do conjunto nao foi achado');
  else if (!/^ {4}DISP\.acumula\(m, r\);$/m.test(g.slice(laco, fimLaco))) e.push('o laco do conjunto nao chama DISP.acumula(m, r) numa linha propria, sem condicao');
  const nAc = (g.match(/DISP\.acumula\(/g) || []).length;
  if (nAc !== 1) e.push('DISP.acumula aparece ' + nAc + ' vez(es), esperava 1');
  if (!/^ {6}\.\.\.DISP\.fecha\(m, CAP_MW\),/m.test(g)) e.push('o objeto do mes nao usa ...DISP.fecha(m, CAP_MW) numa linha propria');
  if (/\bm\.disp\s*(\+|-)?=[^=]|\bm\.n_disp\s*(\+\+|\+=|=[^=])|\bm\.n_janela\s*(\+\+|\+=|=[^=])/.test(g)) e.push('o gerador mexe nos acumuladores da lib por conta propria');
  if (/m\.disp\s*\/\s*m\.n_disp/.test(g)) e.push('copia da conta antiga (m.disp / m.n_disp) no gerador');
  const chaves = [...g.matchAll(/(^|[^\w.])disp_(pct|cobertura_pct)\s*:\s*([^,}\n]*)/g)].map((x) => x[3].trim());
  chaves.filter((x) => !REPASSE.has(x)).forEach((x) => e.push('chave disp_pct/disp_cobertura_pct escrita no gerador fora da lib: "' + x + '"'));
  if (/\.disp_(pct|cobertura_pct)\s*=[^=]/.test(g)) e.push('disp_pct/disp_cobertura_pct atribuido depois de montado');
  if ((g.match(/n_janela: 0/g) || []).length !== 2) e.push('os acumuladores do mes nao trazem n_janela nos dois lugares em que nascem');
  return e;
}
const ger = fs.readFileSync(GERADOR, 'utf8').replace(/\r\n/g, '\n');
const fx = fiacao(ger);
fx.forEach((x) => f.push('fiacao: ' + x));
console.log('   fiacao no gerador: ' + (fx.length ? fx.length + ' problema(s)' : 'ok'));
const ACUM = '    DISP.acumula(m, r);', FECHA = '      ...DISP.fecha(m, CAP_MW),';
const QUEBRADOS = [
  ['sem a chamada no laco', ger.replace(ACUM, '')],
  ['a conta antiga no lugar do fecha', ger.replace(FECHA, '      disp_pct: m.n_disp ? r2(m.disp / m.n_disp / CAP_MW * 100) : null,')],
  ['a cobertura antiga por cima do fecha', ger.replace(FECHA, FECHA + ' disp_cobertura_pct: m.n ? r2(100 * m.n_disp / m.n) : null,')],
  ['a soma antiga ao lado da chamada (a noite volta)', ger.replace(ACUM, ACUM + '\n    const dsp = num(r.disp); if (dsp > 0) { m.disp += dsp; m.n_disp++; }')],
  ['a chamada so em meia hora limitada', ger.replace(ACUM, '    if (lim > 0) DISP.acumula(m, r);')],
  ['a chamada comentada', ger.replace(ACUM, '    // DISP.acumula(m, r);')],
  ['a cobertura sobrescrita depois do fecha', ger.replace(FECHA, FECHA + '\n      disp_cobertura_pct: m.n_janela ? 100 : null,')],
];
for (const [nome, g] of QUEBRADOS) {
  if (g === ger) { f.push('contraprova "' + nome + '": o gerador nao mudou — o trecho nao foi achado'); continue; }
  if (!fiacao(g).length) f.push('contraprova "' + nome + '": a conferencia da fiacao nao acusa');
}
console.log('   contraprovas da fiacao: ' + QUEBRADOS.length + ' geradores quebrados');

fim(': ' + R.length + ' casos, ' + PLANTIOS.length + ' plantios, a fiacao e ' + QUEBRADOS.length + ' contraprovas');
