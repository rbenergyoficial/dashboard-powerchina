'use strict';
/*
 * ensaio-trafo-way2.js — o lado de 230 kV dos transformadores pelo medidor de faturamento (lote fonte-trafo-way2, 19/10/2026):
 * lib-trafo-way2.js e gen-trafo-way2.js.
 *
 *   --lib      SEM REDE, antes de gerar (trafo.yml). Um mundo forjado de 40 dias (02/12/2025 a 10/01/2026, "hoje" = 10/01 ate o
 *              meio-dia), com a conta esperada escrita AQUI, das formulas da forja (nunca pela lib):
 *                 dia 0 desenergizado (tudo zero) · noite com P e Q negativos e correntes desequilibradas de 8 A · dia com P variando a
 *                 cada intervalo (media != primeiro != ultimo) · 06/01 sem a P do 04T1 as 08:20 · 07/01 um valor com qualidade 2 ·
 *                 o arquivo de 05/01 com um valor de 07/01 · 09/01 sem arquivo
 *              e a copia do supervisorio (temperatura, 34,5 kV E o lado de 230 kV dele, com valores-sentinela 999).
 *              Cenarios, todos executando o GERADOR de verdade num processo a parte (sem rede, pastas locais):
 *                 normal (sem saida anterior) · migra (saida anterior no esquema do supervisorio, sem a copia) · incremental (a saida
 *                 do normal com sentinelas) · watts (Demat em W: a guarda de fisica derruba sem gravar) · trocados (pontos
 *                 6196/6197 invertidos: a guarda de identidade derruba sem gravar)
 *              e PLANTIOS na lib e no gerador (cada um conferido como plantado; cada um TEM de reprovar pela regra certa).
 *   --selo     SEM REDE, antes do gen-fontes-saude (way2-agg.yml): os dois selos dos trafos (copia do supervisorio x diario do medidor), o
 *              404 da copia caindo no diario antigo so sem a marca, o erro que nao e 404 sem cair; o gerador de verdade e plantios.
 *   --produto  depois do gerador, sobre o publicado (ou BASE_DADOS=<pasta> e HIST_DIR=<pasta>): a marca; nenhuma chave do lado de
 *              230 kV do supervisorio; so campos declarados; os dois ultimos dias completos RECONTADOS aqui do historico do medidor
 *              (conta propria, sem a lib) nos passos de 5, 15, 30 e 60 min e no dia, com folga de 0,01 (uma unidade da ultima casa
 *              publicada); as grandezas do supervisorio iguais a copia na mesma chave. Nao passa por vacuidade.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const MODO = process.argv.includes('--lib') ? 'lib' : process.argv.includes('--selo') ? 'selo' : 'produto';
const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const R3 = Math.sqrt(3);
const r2 = (x) => Math.round(x * 100) / 100;
const media = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const perto = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= (tol == null ? 0.0100001 : tol);
const gz = (o) => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
const desembrulha = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
const diaMais = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const msDe = (dia, min) => Date.parse(dia + 'T00:00:00Z') + 3 * 3600e3 + min * 60e3;     // epoch do instante BRT
const naive = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 19);
const CAMPOS_MED = ['i1a', 'i1b', 'i1c', 'v1a', 'v1b', 'v1c', 'p', 'q', 's', 'fp', 'carga_pct'];
const CAMPOS_MED_DIA = ['s_max', 's_med', 'carga_pct_max', 'p_max', 'p_med', 'deseq_max', 'deseq_med'];
const SUP_INT = ['i2a', 'i2b', 'i2c', 'i3a', 'i3b', 'i3c', 'v2ab', 'v2bc', 'v2ca', 'v3ab', 'v3bc', 'v3ca', 't_oleo', 't_oleo_cdc', 't_enrol', 'tap'];
const SUP_DIA = ['t_oleo_max', 't_oleo_med', 't_oleo_cdc_max', 't_oleo_cdc_med', 't_enrol_max', 't_enrol_med'];
const TR = ['04T1', '04T2'];

/* ================================================================ --selo ======================================================
   O selo de frescor dos transformadores (gen-fontes-saude.js, lote fonte-trafo-way2), SEM REDE: o gerador de verdade num processo a
   parte, com a lib-le-dados trocada por uma leitura forjada (preload em Module._load) e LOCAL_OUT. Quatro mundos:
     A  copia do supervisorio presente e o diario do medidor: `badges_trafo` = a copia (Supervisorio), `badges_trafo_230` = o diario
     B  copia AUSENTE (404) e o diario ainda sem a marca (o produto do supervisorio): `badges_trafo` cai no diario antigo
     C  copia ausente e o diario JA com a marca do medidor: `badges_trafo` = "sem leitura" (o medidor nao e o supervisorio)
     D  copia com erro 500 (nao e ausencia): "sem leitura", sem cair no diario
   e plantios no gerador (cada um conferido como plantado): o 404 deixa de ser exigido, a marca deixa de ser conferida, os dois
   selos trocados de arquivo. */
if (MODO === 'selo') {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-selo-trafo-'));
  const tmpCod = [];
  process.on('exit', () => { fs.rmSync(raiz, { recursive: true, force: true }); for (const f of tmpCod) if (fs.existsSync(f)) fs.unlinkSync(f); });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130));
  const PRE = path.join(raiz, 'preload.js');
  fs.writeFileSync(PRE, [
    "const Module = require('module'); const orig = Module._load;",
    "const B = JSON.parse(require('fs').readFileSync(process.env.SELO_BLOBS, 'utf8'));",
    "Module._load = function (req) {",
    "  if (/(^|\\/)lib-le-dados(\\.js)?$/.test(req)) return { pede: async (url) => { const n = String(url).split('/dados/')[1]; const b = B[n];",
    "    if (!b) return { status: 404, buf: Buffer.from('') }; if (b.status !== 200) return { status: b.status, buf: Buffer.from('') };",
    "    return { status: 200, buf: Buffer.from(JSON.stringify(b.corpo)) }; } };",
    "  return orig.apply(this, arguments);",
    "};"].join('\n'));
  const GEN = path.join(__dirname, 'gen-fontes-saude.js');
  const copia = { status: 200, corpo: { copia_do_supervisorio: 'x', serie: [{ dia: '2026-10-13' }, { dia: '2026-10-14' }] } };
  const diarioMed = { status: 200, corpo: { esquema: 'medidor-230kv-1', serie: [{ dia: '2026-10-17' }, { dia: '2026-10-18' }] } };
  const diarioSup = { status: 200, corpo: { serie: [{ dia: '2026-10-12' }] } };
  const MUNDOS = {
    A: { 'trafo_scada_diario.json': copia, 'trafo_diario.json': diarioMed },
    B: { 'trafo_diario.json': diarioSup },
    C: { 'trafo_diario.json': diarioMed },
    D: { 'trafo_scada_diario.json': { status: 500 }, 'trafo_diario.json': diarioSup },
  };
  let seq = 0;
  function roda(gen, mundo) {
    const fb = path.join(raiz, 'b' + (++seq) + '.json'), out = path.join(raiz, 'o' + seq + '.json');
    fs.writeFileSync(fb, JSON.stringify(mundo));
    try { execFileSync('node', ['-r', PRE, gen], { env: Object.assign({}, process.env, { SELO_BLOBS: fb, LOCAL_OUT: out, DADOS_STORAGE: '', DADOS_SAS: '' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return { erro: String(e.stderr || e.message).slice(-300) }; }
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  }
  const sel = (o, k) => ((o[k] || [])[0] || {});
  function julga(gen) {
    const J = {}, A = roda(gen, MUNDOS.A), Bm = roda(gen, MUNDOS.B), Cm = roda(gen, MUNDOS.C), Dm = roda(gen, MUNDOS.D);
    J.okA = sel(A, 'badges_trafo').l === 'Supervisório' && sel(A, 'badges_trafo').v === '14/10' && sel(A, 'badges_trafo_230').l === 'Medidores' && sel(A, 'badges_trafo_230').v === '18/10';
    J.okB = sel(Bm, 'badges_trafo').v === '12/10' && sel(Bm, 'badges_trafo').l === 'Supervisório';
    J.okC = sel(Cm, 'badges_trafo').v === 'sem leitura' && sel(Cm, 'badges_trafo_230').v === '18/10';
    J.okD = sel(Dm, 'badges_trafo').v === 'sem leitura';
    J.erro = A.erro || Bm.erro || Cm.erro || Dm.erro;
    return J;
  }
  console.log('gen-fontes-saude · os dois selos dos transformadores (leitura forjada, sem rede)');
  const J = julga(GEN);
  if (J.erro) ok(false, 'o gerador estourou: ' + J.erro);
  ok(J.okA === true, 'copia presente: badges_trafo e a copia do supervisorio (14/10) e badges_trafo_230 e o diario do medidor (18/10)');
  ok(J.okB === true, 'copia ausente (404) e o diario ainda sem a marca: badges_trafo cai no diario antigo (o produto do supervisorio)');
  ok(J.okC === true, 'copia ausente e o diario ja com a marca do medidor: badges_trafo diz "sem leitura" (o medidor nao e o supervisorio)');
  ok(J.okD === true, 'copia com HTTP 500: badges_trafo diz "sem leitura" e nao cai no diario (so a ausencia cai)');
  const src = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
  function planta(nome, de, para, chave) {
    if (src.split(de).length !== 2) { ok(false, 'plantio "' + nome + '": o trecho nao casou'); return; }
    const g = path.join(__dirname, '_plantio_fontes_saude_' + process.pid + '.js');
    tmpCod.push(g); fs.writeFileSync(g, src.split(de).join(para));
    const Jp = julga(g);
    ok(!Jp.erro && Jp[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (Jp.erro ? ' (o plantado nem rodou: ' + Jp.erro + ')' : ''));
  }
  planta('qualquer erro cai no diario antigo', " || !/HTTP 404/.test(e.message)) throw e;", ') throw e;', 'okD');
  planta('a marca do medidor nao e conferida', "t = await le('trafo_diario.json'); if (t.esquema) throw e; }", "t = await le('trafo_diario.json'); }", 'okC');
  planta('os dois selos trocados de arquivo', "trafo('trafo_scada_diario.json', 'Supervisório')", "trafo('trafo_diario.json', 'Supervisório')", 'okA');
  console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-trafo-way2 --selo: tudo ok');
  process.exit(falhas.length ? 1 : 0);
}

/* ================================================================ --lib ======================================================= */
if (MODO === 'lib') {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-trafo-way2-'));
  const tmpCod = [];
  process.on('exit', () => { fs.rmSync(raiz, { recursive: true, force: true }); for (const f of tmpCod) if (fs.existsSync(f)) fs.unlinkSync(f); });
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => process.exit(130));   // o 'exit' acima limpa os plantios de scripts/
  const D0 = '2025-12-02', N = 40, HOJE = diaMais(D0, N - 1);                 // 10/01/2026
  const dia = (d) => diaMais(D0, d);
  const ID = { '04T1': 6196, '04T2': 6197 };
  const K = { '04T1': 1, '04T2': 2 };
  const FALTA = { d: 35, i: 100 };            // 06/01 08:20, a P do 04T1
  const QUAL = { d: 36, i: 110 };             // 07/01 09:10, a P do 04T2 com qualidade 2
  const ESTRANHO = { d: 34, alvo: 36, i: 121 };   // no arquivo de 05/01, um valor de 07/01 10:05 (inicio)
  const SEM_ARQ = 38;                         // 09/01
  const VAZIO = { d: 32, i: 130 };            // 03/01 10:50, a P do 04T1 com valor '' e qualidade 0 (celula vazia): nao medido
  const HOJE_ATE = 144;                       // hoje: so os intervalos ate o meio-dia

  /* a forja: a media de cada intervalo i (inicio = 5 i min), em unidades do medidor (kW, kVAr, V fase-neutro, A) */
  function bruto(t, d, i) {
    const k = K[t];
    if (d === 0) return { p: 0, q: 0, va: 0, vb: 0, vc: 0, ia: 0, ib: 0, ic: 0 };            // desenergizado
    // dia 1: o caso real de out/2024 a jan/2025 — 5 intervalos com tensao (ensaio de comissionamento) e o resto em zero: NAO e energizacao
    if (d === 1) { const v1 = i >= 100 && i < 105 ? 137000 : 0; return { p: 0, q: 0, va: v1, vb: v1, vc: v1, ia: 0, ib: 0, ic: 0 }; }
    // as TRES fase-neutro diferentes (+400 V na B, -300 V na C): fase trocada ou copiada na leitura aparece
    const vn = 136000 + 100 * k;
    const noite = { p: -800 - 10 * k, q: -12000 - 100 * k, va: vn, vb: vn + 400, vc: vn - 300 };
    if (i >= 56 && i < 60) return Object.assign(noite, { ia: 12, ib: 15, ic: 18 });     // 15 A de media, 40 % desequilibrado: fica FORA do piso
    if (i >= 216 && i < 220) return Object.assign(noite, { ia: 24, ib: 25, ic: 26 });   // 25 A de media, 8 %: ENTRA no piso de 20 A
    if (i < 60 || i >= 216) return Object.assign(noite, { ia: 8, ib: 6, ic: 10 });      // noite
    const p = 1000 * (60 + 0.5 * k + 2 * Math.sin(d) * (k === 1 ? 1 : -1) + (i - 60) / 4);
    // Q alterna +-15 MVAr de um intervalo para o outro: no balde, raiz(P^2 + Q^2) das MEDIAS e a media das raizes se separam por
    // MVA inteiros (bem acima da folga de 0,01), e so a primeira e a regra
    const q = -1000 * (3 + 0.5 * k + (i % 5) / 10) + (i % 2 ? 15000 : -15000);
    const v = 137000 + 20 * (i % 12) + 100 * k;
    const sMVA = Math.hypot(p, q) / 1000, vff = ((v + 100 / 3) * R3) / 1000, i0 = (sMVA * 1000) / (R3 * vff);   // a media das tres fases
    return { p, q, va: v, vb: v + 400, vc: v - 300, ia: i0 * 1.01, ib: i0 * 0.99, ic: i0 };
  }
  // o que o medidor publica para (t, d, i): null = nao medido
  function medido(t, d, i, g) {
    if (d === FALTA.d && i === FALTA.i && t === '04T1' && g === 'p') return null;
    if (d === QUAL.d && i === QUAL.i && t === '04T2' && g === 'p') return null;   // rejeitado (qualidade 2)
    if (d === VAZIO.d && i === VAZIO.i && t === '04T1' && g === 'p') return null; // celula vazia
    return bruto(t, d, i)[g];
  }
  // o esperado PUBLICADO de um intervalo de 5 min (do jeito que a regra manda, escrito aqui)
  function esperado5(t, d, i) {
    const g = (x) => medido(t, d, i, x), o = {};
    if (g('ia') != null) { o.i1a = g('ia'); o.i1b = g('ib'); o.i1c = g('ic'); }
    if (g('va') != null) o.v1a = (g('va') * R3) / 1000;
    if (g('vb') != null) o.v1b = (g('vb') * R3) / 1000;
    if (g('vc') != null) o.v1c = (g('vc') * R3) / 1000;
    if (g('p') != null) o.p = g('p') / 1000;
    if (g('q') != null) o.q = g('q') / 1000;
    if (o.p != null && o.q != null) { o.s = Math.hypot(o.p, o.q); if (o.s > 0) o.fp = Math.abs(o.p) / o.s; o.carga_pct = (o.s / 230) * 100; }
    return o;
  }
  function esperadoPasso(t, d, i0, n) {       // media de n intervalos de 5 min a partir de i0, so completo
    const o = {}, m = {};
    for (const g of ['p', 'q', 'va', 'vb', 'vc', 'ia', 'ib', 'ic']) {
      const vs = []; for (let i = i0; i < i0 + n; i++) { const x = medido(t, d, i, g); if (x != null) vs.push(x); }
      if (vs.length === n) m[g] = media(vs);
    }
    if (m.ia != null) { o.i1a = m.ia; o.i1b = m.ib; o.i1c = m.ic; }
    if (m.va != null) o.v1a = (m.va * R3) / 1000;
    if (m.vb != null) o.v1b = (m.vb * R3) / 1000;
    if (m.vc != null) o.v1c = (m.vc * R3) / 1000;
    if (m.p != null) o.p = m.p / 1000;
    if (m.q != null) o.q = m.q / 1000;
    if (o.p != null && o.q != null) { o.s = Math.hypot(o.p, o.q); o.fp = Math.abs(o.p) / o.s; }
    return o;
  }
  function esperadoDia(t, d) {
    const S = [], P = [], des = [];
    for (let i = 0; i < 288; i++) {
      const e = esperado5(t, d, i);
      if (e.s != null) S.push(e.s);
      if (e.p != null) P.push(e.p);
      if (e.i1a != null) { const f = [e.i1a, e.i1b, e.i1c], m = media(f); if (m > 20) des.push(((Math.max(...f) - Math.min(...f)) / m) * 100); }
    }
    return { s_max: Math.max(...S), s_med: media(S), p_max: Math.max(...P), p_med: media(P), deseq_max: des.length ? Math.max(...des) : null,
      deseq_med: des.length ? media(des) : null, nP: P.length };
  }

  /* os arquivos do medidor, no formato do historico (rotulo = FIM do intervalo) */
  function arquivoDia(d, opc) {
    const o = opc || {}, dados = [];
    const NOME = { p: 'Demat', q: 'Demre', v: ['TensaoA', 'TensaoB', 'TensaoC'], ia: 'CorrenteA', ib: 'CorrenteB', ic: 'CorrenteC' };
    for (const t of TR) {
      const pid = o.trocados ? ID[t === '04T1' ? '04T2' : '04T1'] : ID[t];
      const ate = d === N - 1 ? HOJE_ATE : 288;
      const serie = (g, nome, mult) => {
        const valores = [];
        for (let i = 0; i < ate; i++) {
          let v = o.desligado && t === '04T2' && d >= 35 ? 0 : medido(t, d, i, g);
          let q = v == null ? 1 : 0;
          if (d === QUAL.d && i === QUAL.i && t === '04T2' && g === 'p') { v = 9.9e6; q = 2; }
          let valor = v == null ? null : v * (mult || 1);
          if (d === VAZIO.d && i === VAZIO.i && t === '04T1' && g === 'p') { valor = o.completo ? bruto(t, d, i).p : ''; q = 0; }
          valores.push({ data: naive(msDe(dia(d), 5 * i + 5)), valor, qualidade: q });
        }
        if (d === ESTRANHO.d && t === '04T1' && g === 'p') valores.push({ data: naive(msDe(dia(ESTRANHO.alvo), 5 * ESTRANHO.i + 5)), valor: 12345000, qualidade: 0 });
        dados.push({ pontoId: pid, nomeGrandeza: nome, valores });
      };
      // watts: P e Q x1000 (W no lugar de kW) · metade: P, Q e corrente x0,5 (fisica coerente, so a escala contra o supervisorio denuncia)
      // permutados: Demat e Demre com os nomes trocados (S igual, FP perto de 0)
      const kp = o.watts ? 1000 : o.metade ? 0.5 : 1, ki = o.metade ? 0.5 : 1;
      serie('p', o.permutados ? NOME.q : NOME.p, kp); serie('q', o.permutados ? NOME.p : NOME.q, kp);
      serie('va', NOME.v[0]); serie('vb', NOME.v[1]); serie('vc', NOME.v[2]);
      serie('ia', NOME.ia, ki); serie('ib', NOME.ib, ki); serie('ic', NOME.ic, ki);
    }
    dados.push({ pontoId: 6233, nomeGrandeza: 'Demat', valores: [{ data: naive(msDe(dia(d), 5)), valor: 1, qualidade: 0 }] });   // outro ponto: ignorado
    return { inicio: '', fim: '', dataInicio: dia(d) + 'T00:00:00', dataFim: dia(d) + 'T23:59:59', intervalo: o.quinze ? 'QuinzeMinutos' : 'CincoMinutos', dados };
  }
  function montaHist(dir, opc) {
    fs.mkdirSync(dir, { recursive: true });
    for (let d = 0; d < N; d++) if (d !== SEM_ARQ) fs.writeFileSync(path.join(dir, 'way2_' + dia(d) + '.json'), JSON.stringify(arquivoDia(d, opc)));
  }
  /* a copia do supervisorio: temperaturas, 34,5 kV E o lado de 230 kV dele com sentinelas (999) que nunca podem chegar a tela */
  const T_OLEO = (d, min) => 40 + d / 10 + min / 10000;
  const T_ISO = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  function copiaSup() {
    const C = {};
    const linhaSup = (d, min) => {
      const o = { ms: msDe(dia(d), min), t: '' };
      for (const t of TR) Object.assign(o, { [t + '_t_oleo']: r2(T_OLEO(d, min) + K[t]), [t + '_i2a']: 300 + K[t], [t + '_tap']: 8,
        [t + '_p']: 999, [t + '_s']: 999, [t + '_v1ab']: 999, [t + '_i1a']: 999, [t + '_carga_pct']: 999 });
      return o;
    };
    const lin = (dias, passo) => { const L = []; for (const d of dias) for (let m = 0; m < 1440; m += passo) L.push(linhaSup(d, m)); return L; };
    C['5min'] = { serie: lin([35, 36, 37], 5), temperaturas_implausiveis: { '04T2|t_oleo': 7 }, rotulos: { t_oleo: 'oleo' }, fonte_dos_nomes: 'lista' };
    C['30min'] = { serie: lin([30, 31, 32, 33, 34, 35, 36, 37], 30).concat([linhaSup(SEM_ARQ, 720)]), temperaturas_implausiveis: { '04T2|t_oleo': 7 }, rotulos: { t_oleo: 'oleo' }, fonte_dos_nomes: 'lista' };
    C['60min'] = { serie: lin([30, 31, 32, 33, 34, 35, 36, 37], 60), temperaturas_implausiveis: { '04T2|t_oleo': 7 }, rotulos: { t_oleo: 'oleo' }, fonte_dos_nomes: 'lista' };
    const dd = [];
    for (let d = 1; d <= 37; d++) {
      const o = { dia: dia(d), ms: msDe(dia(d), 0), n: 48 };
      for (const t of TR) {
        const e = esperadoDia(t, d);
        Object.assign(o, { [t + '_p_med']: r2(e.p_med * 1.003), [t + '_p_max']: r2(e.p_max * 0.998), [t + '_s_max']: r2(e.s_max * 0.997),
          [t + '_s_med']: 999, [t + '_deseq_max']: 999, [t + '_t_oleo_max']: r2(50 + d / 10 + K[t]), [t + '_t_oleo_med']: r2(45 + d / 10) });
      }
      dd.push(o);
    }
    C.dia = { serie: dd, temperaturas_implausiveis: { '04T2|t_oleo': 7 }, rotulos: { t_oleo: 'oleo' }, fonte_dos_nomes: 'lista', placa: { velha: true } };
    // a copia forjada traz o gerado_em, como toda copia real (gen-trafo): o plantio da temperatura diferente passa pelo ramo que roda no ar
    for (const k of Object.keys(C)) C[k].gerado_em = '2026-01-01T03:00:00.000Z';
    return C;
  }
  const NOMES = { 5: 'trafo_5min.json', 15: 'trafo_15min.json', 30: 'trafo_30min.json', 60: 'trafo_60min.json', dia: 'trafo_diario.json' };
  const NOMES_SUP = { '5min': 'trafo_scada_5min.json', '30min': 'trafo_scada_30min.json', '60min': 'trafo_scada_60min.json', dia: 'trafo_scada_diario.json' };
  function gravaSup(dir, C, comoAnterior) {
    for (const [k, o] of Object.entries(C)) fs.writeFileSync(path.join(dir, comoAnterior ? (k === 'dia' ? 'trafo_diario.json' : 'trafo_' + k + '.json') : NOMES_SUP[k]), gz(o));
  }

  const HIST = path.join(raiz, 'hist'), HIST_W = path.join(raiz, 'hist_watts'), HIST_X = path.join(raiz, 'hist_trocados');
  const HIST_C = path.join(raiz, 'hist_completo'), HIST_M = path.join(raiz, 'hist_metade'), HIST_P = path.join(raiz, 'hist_permutados'), HIST_Q = path.join(raiz, 'hist_quinze');
  montaHist(HIST); montaHist(HIST_W, { watts: true }); montaHist(HIST_X, { trocados: true });
  const HIST_D = path.join(raiz, 'hist_desligado');
  montaHist(HIST_D, { desligado: true }); montaHist(HIST_C, { completo: true }); montaHist(HIST_M, { metade: true }); montaHist(HIST_P, { permutados: true }); montaHist(HIST_Q, { quinze: true });
  const GEN = path.join(__dirname, 'gen-trafo-way2.js'), LIB = path.join(__dirname, 'lib-trafo-way2.js');
  const lerSaida = (dir) => { const o = {}; for (const [k, n] of Object.entries(NOMES)) { const f = path.join(dir, n); o[k] = fs.existsSync(f) ? desembrulha(fs.readFileSync(f)) : null; } return o; };
  let seq = 0;
  function roda(gen, cen, hist, prepara) {
    const IN = path.join(raiz, 'in' + (++seq)), OUT = path.join(raiz, 'out' + seq);
    fs.mkdirSync(IN, { recursive: true }); fs.mkdirSync(OUT, { recursive: true });
    if (prepara) prepara(IN);
    let log = '', okr = true;
    try { log = execFileSync('node', [gen], { env: Object.assign({}, process.env, { LOCAL_HIST_DIR: hist, LOCAL_IN_DIR: IN, LOCAL_OUT_DIR: OUT, HOJE, FORCAR: '', DADOS_STORAGE: '', DADOS_SAS: '' }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { okr = false; log = String(e.stdout || '') + String(e.stderr || ''); }
    return { ok: okr, log, out: lerSaida(OUT), outDir: OUT, gravados: fs.readdirSync(OUT) };
  }
  const linha = (S, ms) => (S && S.serie || []).find((x) => x.ms === ms);
  const linhaDia = (S, d) => (S && S.serie || []).find((x) => x.dia === d);
  const confere = (l, t, e, campos) => campos.every((c) => (e[c] == null ? l[t + '_' + c] == null : perto(l[t + '_' + c], r2(e[c]))));

  /* o julgamento de um conjunto de saidas: um booleano por regra, todas com o caso exigido PRESENTE (nunca por vacuidade) */
  function julga(R, cen) {
    const J = {}, O = R.out;
    if (!R.ok || !O.dia) return J;
    // 5 min: o intervalo [12:00, 12:05) e o valor rotulado 12:05; as 00:00 do dia e o rotulado 00:05; noite com P negativa e FP em modulo
    const d = 33, rows = [[d, 144], [d, 0], [d, 30], [37, 200], [N - 1, 143]];
    J.okCampos = rows.every(([dd, i]) => { const l = linha(O[5], msDe(dia(dd), 5 * i)); return !!l && TR.every((t) => confere(l, t, esperado5(t, dd, i), CAMPOS_MED)); })
      && TR.every((t) => (linha(O[5], msDe(dia(d), 0)) || {})[t + '_fp'] > 0);
    J.okBorda = [0, 12, 144, 287].every((i) => (linha(O[5], msDe(dia(d), 5 * i)) || {})['04T1_p'] === r2(esperado5('04T1', d, i).p))
      && (linha(O[5], msDe(dia(d + 1), 0)) || {})['04T1_p'] === r2(esperado5('04T1', d + 1, 0).p);
    // 15/30/60: a MEDIA dos 3/6/12 intervalos, rotulada no inicio; nunca a primeira nem a ultima amostra
    J.okIntegra = [[15, 3], [30, 6], [60, 12]].every(([min, n]) => [[33, 144], [33, 72], [37, 180]].every(([dd, i0]) => {
      const l = linha(O[min], msDe(dia(dd), 5 * i0));
      return !!l && TR.every((t) => confere(l, t, esperadoPasso(t, dd, i0, n), ['p', 'q', 's', 'fp', 'i1a', 'i1b', 'i1c', 'v1a', 'v1b', 'v1c']));
    }))
      // a forja separa as duas contas: no balde de 30 min das 12:00 do dia 33, media dos S menos S das medias passa de 1 MVA
      && TR.every((t) => { const ms = []; for (let i = 144; i < 150; i++) ms.push(esperado5(t, 33, i).s); return media(ms) - esperadoPasso(t, 33, 144, 6).s > 1; });
    // o balde sem um intervalo: a grandeza faltante (e o que depende dela) AUSENTE no 04T1; o resto e o 04T2 presentes
    J.okIncompleto = [[15, 99], [30, 96], [60, 96]].every(([min, i0]) => {
      const l = linha(O[min], msDe(dia(FALTA.d), 5 * i0));
      return !!l && l['04T1_p'] == null && l['04T1_s'] == null && l['04T1_carga_pct'] == null && l['04T1_q'] != null && l['04T1_i1a'] != null && l['04T2_p'] != null;
    }) && linhaDia(O.dia, dia(FALTA.d)).n === 287;
    // qualidade 2 nunca entra; o valor de outro dia dentro do arquivo fica fora (o dia sai do CONTEUDO)
    J.okQualidade = (linha(O[5], msDe(dia(QUAL.d), 5 * QUAL.i)) || {})['04T2_p'] == null && (linhaDia(O.dia, dia(QUAL.d)) || {})['04T2_p_max'] < 1000;
    J.okConteudo = perto((linhaDia(O.dia, dia(ESTRANHO.d)) || {})['04T1_p_max'], r2(esperadoDia('04T1', ESTRANHO.d).p_max))
      && perto((linha(O[5], msDe(dia(ESTRANHO.alvo), 5 * ESTRANHO.i)) || {})['04T1_p'], r2(esperado5('04T1', ESTRANHO.alvo, ESTRANHO.i).p));
    // o dia: maximo e media dos 5 min; desequilibrio so com corrente acima de 20 A (a noite desequilibrada fica fora)
    J.okDiario = [10, 33, 37].every((dd) => { const l = linhaDia(O.dia, dia(dd)); return !!l && l.n === 288 && TR.every((t) => {
      const e = esperadoDia(t, dd);
      return perto(l[t + '_s_max'], r2(e.s_max)) && perto(l[t + '_s_med'], r2(e.s_med)) && perto(l[t + '_p_max'], r2(e.p_max)) && perto(l[t + '_p_med'], r2(e.p_med))
        && perto(l[t + '_carga_pct_max'], r2((e.s_max / 230) * 100)); }); });
    // o piso de 20 A: a faixa de 25 A (8 %) entra e fica sendo o maximo; a de 15 A (40 %) e a de 8 A (50 %) ficam fora
    J.okDeseq = [10, 33].every((dd) => { const l = linhaDia(O.dia, dia(dd)); return !!l && TR.every((t) => { const e = esperadoDia(t, dd);
      return perto(e.deseq_max, 8) && perto(l[t + '_deseq_max'], r2(e.deseq_max)) && perto(l[t + '_deseq_med'], r2(e.deseq_med)); }); });
    // a celula vazia ('' com qualidade 0) e intervalo NAO medido: ausente, e o dia fica com 287
    J.okVazio = !!linha(O[5], msDe(dia(VAZIO.d), 5 * VAZIO.i)) && linha(O[5], msDe(dia(VAZIO.d), 5 * VAZIO.i))['04T1_p'] == null
      && (linha(O[5], msDe(dia(VAZIO.d), 5 * VAZIO.i)) || {})['04T1_i1a'] != null && (linhaDia(O.dia, dia(VAZIO.d)) || {}).n === 287;
    // desde a energizacao (o dia 0, desenergizado, fica fora); o dia sem arquivo e hoje ficam fora do diario (ausentes, nunca zero)
    J.okDesde = O.dia.serie[0].dia === dia(2) && O.dia.medicao_desde === dia(2);   // o dia 1 (5 intervalos com tensao) nao e energizacao
    J.okAusente = !linhaDia(O.dia, dia(SEM_ARQ)) || linhaDia(O.dia, dia(SEM_ARQ)).n === 0 && linhaDia(O.dia, dia(SEM_ARQ))['04T1_p_max'] == null;
    J.okHoje = !linhaDia(O.dia, HOJE) && !!linha(O[5], msDe(HOJE, 5 * 143)) && !linha(O[5], msDe(HOJE, 5 * 144));
    // o supervisorio: so os campos declarados, na mesma chave; o lado de 230 kV dele (999) nunca; o 15 min sem ele; linha so dele entra
    const todas = [5, 15, 30, 60, 'dia'].flatMap((k) => O[k].serie);
    const permitidas = new Set(['ms', 't', 'dia', 'n', ...TR.flatMap((t) => [...CAMPOS_MED, ...CAMPOS_MED_DIA, ...SUP_INT, ...SUP_DIA].map((c) => t + '_' + c))]);
    J.okSem230Sup = todas.every((l) => Object.entries(l).every(([k, v]) => permitidas.has(k) && v !== 999)) && todas.every((l) => !('04T1_v1ab' in l));
    if (cen !== 'migra') {
      const l30 = linha(O[30], msDe(dia(33), 600)), l5 = linha(O[5], msDe(dia(36), 600)), ld = linhaDia(O.dia, dia(20)), lso = linha(O[30], msDe(dia(SEM_ARQ), 720));
      J.okSup = !!l30 && l30['04T1_t_oleo'] === r2(T_OLEO(33, 600) + 1) && l30['04T2_i2a'] === 302 && l30['04T1_tap'] === 8
        && !!l5 && l5['04T2_t_oleo'] === r2(T_OLEO(36, 600) + 2) && !!ld && ld['04T1_t_oleo_max'] === r2(50 + 20 / 10 + 1)
        && !!lso && lso['04T1_t_oleo'] === r2(T_OLEO(SEM_ARQ, 720) + 1) && lso['04T1_p'] == null
        && O[15].serie.every((l) => !('04T1_t_oleo' in l)) && O.dia.supervisorio_ate === dia(37) && O[30].fontes_por_campo.supervisorio.includes('t_oleo')
        && O[15].fontes_por_campo.supervisorio.length === 0 && O[30].temperaturas_implausiveis['04T2|t_oleo'] === 7;
      J.okParidade = !!O.dia.paridade_supervisorio && O.dia.paridade_supervisorio.correlacao > 0.9 && O.dia.paridade_supervisorio.dias >= 30;
    }
    J.okMeta = [5, 15, 30, 60, 'dia'].every((k) => O[k].esquema === 'medidor-230kv-1' && O[k].placa && O[k].placa.potencia_at_mva.onaf2 === 230)
      && O.dia.placa.velha === undefined && O[5].medidor_ate === new Date(msDe(HOJE, 5 * 143) - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
      && /√3/.test(O[5].tensao_230kv) && !/way2/i.test(JSON.stringify([O[5].rotulo_de_tempo, O[5].passo, O[5].fonte_230kv, O.dia.supervisorio_nota]));
    J.okJanela = O[5].serie[0].ms >= msDe(HOJE, 5 * 143) - 29 * 864e5 && O[5].janela_dias_alvo === 30 && O[15].janela_dias_alvo === 90;
    return J;
  }

  /* ---- cenarios ---- */
  const C = copiaSup();
  const cenarios = {
    normal: () => roda(GEN, 'normal', HIST, (IN) => gravaSup(IN, C)),
    migra: () => roda(GEN, 'migra', HIST, (IN) => {
      // o esquema VELHO fiel: sem `esquema`, com v1ab e o lado de 230 kV do supervisorio; sem trafo_15min e sem a copia trafo_scada_*
      const V = copiaSup(); gravaSup(IN, V, true); fs.writeFileSync(path.join(IN, 'trafo_15min.json'), gz(V['30min']));
    }),
    watts: () => roda(GEN, 'watts', HIST_W, null),
    trocados: () => roda(GEN, 'trocados', HIST_X, (IN) => gravaSup(IN, C)),
  };
  function juizoIncremental(R) {
    const O = R.out, J = {};
    if (!R.ok || !O.dia) return J;
    const l30v = linha(O[30], msDe(dia(30), 600)), l30n = linha(O[30], msDe(dia(37), 600));
    J.okGuarda = !!l30v && l30v['04T1_p'] === 7.77 && linhaDia(O.dia, dia(10))['04T1_p_max'] === 7.77;          // o dia nao relido fica
    J.okNova = !!l30n && perto(l30n['04T1_p'], r2(esperadoPasso('04T1', 37, 120, 6).p)) && perto(linhaDia(O.dia, dia(37))['04T1_p_max'], r2(esperadoDia('04T1', 37).p_max));
    J.okMescla = !!l30v && l30v['04T1_t_oleo'] === r2(T_OLEO(30, 600) + 1) && !('04T1_v1ab' in l30v) && linhaDia(O.dia, dia(10))['04T1_t_oleo_max'] === r2(50 + 10 / 10 + 1);
    J.okModoInc = /modo incremental/.test(R.log) && !/modo completo/.test(R.log);
    // o dia incompleto dos ultimos 7 (o 32, n 287 no publicado) e RELIDO: o medidor o completou, e o publicado fica com 288 e a P
    J.okRebusca = (linhaDia(O.dia, dia(VAZIO.d)) || {}).n === 288 && perto((linha(O[5], msDe(dia(VAZIO.d), 5 * VAZIO.i)) || {})['04T1_p'], r2(bruto('04T1', VAZIO.d, VAZIO.i).p / 1000));
    return J;
  }

  console.log('lib-trafo-way2 e gen-trafo-way2 · mundo forjado de ' + N + ' dias (' + dia(0) + ' a ' + HOJE + ')');
  const Rn = cenarios.normal();
  if (!Rn.ok) console.log(Rn.log.split('\n').slice(-4).join('\n'));
  ok(Rn.ok, 'o gerador termina a rodada sem saida anterior (modo completo) e grava os cinco: ' + Rn.gravados.sort().join(' '));
  ok(/modo completo/.test(Rn.log), 'sem saida anterior o modo e completo');
  const Jn = julga(Rn, 'normal');
  const MSG = {
    okCampos: '5 min: corrente, tensao de linha (fase-neutro x raiz(3)), P e Q em MW/MVAr, S e FP em modulo (noite com P negativa), carga % de 230 MVA',
    okBorda: 'o valor rotulado 12:05 e o intervalo que COMECA 12:00; as 00:00 do dia e o rotulado 00:05; 23:55 e o ultimo',
    okIntegra: '15, 30 e 60 min: a MEDIA dos 3, 6 e 12 intervalos (nunca a amostra), S e FP sobre P e Q integralizados',
    okIncompleto: 'balde sem um intervalo: a grandeza que falta (e S, FP, carga) fica ausente nos tres passos; o resto fica; n do dia 287',
    okQualidade: 'valor com qualidade diferente de 0 nao entra',
    okConteudo: 'valor de outro dia dentro do arquivo fica fora (o dia sai do conteudo)',
    okDiario: 'o dia: maximo e media dos 5 min de S e P, carga maxima, n = 288',
    okDeseq: 'desequilibrio so com corrente media acima de 20 A: a faixa de 25 A (8 %) entra e e o maximo; as de 15 A (40 %) e 8 A (50 %) ficam fora',
    okVazio: "celula vazia ('' com qualidade 0) e intervalo nao medido: a P fica ausente (nunca 0 MW) e o dia fica com 287",
    okDesde: 'o diario comeca na energizacao: o dia todo em zero e o dia de ensaio isolado (5 intervalos com tensao) ficam fora; o meta diz desde quando',
    okAusente: 'dia sem arquivo do medidor: sem linha do medidor (ausente, nunca zero)',
    okHoje: 'hoje entra nos passos ate o ultimo intervalo medido e nao entra no diario',
    okSem230Sup: 'nenhuma grandeza do lado de 230 kV do supervisorio (sentinela 999, v1ab) em passo nenhum; so campos declarados',
    okSup: 'temperatura, 34,5 kV e comutador da copia na mesma chave; linha so do supervisorio entra; o 15 min sem supervisorio; meta da copia',
    okParidade: 'paridade contra a copia do supervisorio julgada (30+ dias) e com a correlacao das diferencas positiva',
    okMeta: 'a marca do esquema, a placa da lib (nunca a da copia), medidor_ate, a tensao declarada com raiz(3), texto sem o nome do fornecedor',
    okJanela: 'janela de 30 dias no 5 min e 90 no 15 min',
  };
  for (const [k, m] of Object.entries(MSG)) ok(Jn[k] === true, m);

  const Rm = cenarios.migra();
  const Jm = julga(Rm, 'migra');
  Jm.okMigra = Rm.ok && /modo completo/.test(Rm.log) && (linha(Rm.out[30], msDe(dia(33), 600)) || {})['04T1_t_oleo'] === r2(T_OLEO(33, 600) + 1);
  ok(Jm.okMigra, 'migracao: saida anterior no esquema do supervisorio (sem a marca) e sem a copia -> modo completo, e a temperatura vem do anterior');
  ok(Jm.okSem230Sup === true && Jm.okCampos === true && Jm.okDiario === true, 'migracao: nenhuma grandeza de 230 kV do supervisorio sobrevive; o medidor em todos os passos');

  const Rm2 = roda(GEN, 'migra2', HIST, (IN) => { for (const [k, n] of Object.entries(NOMES)) fs.writeFileSync(path.join(IN, n), gz(Rm.out[k])); });
  ok(Rm2.ok && /modo incremental/.test(Rm2.log) && /copia do supervisorio trafo_scada_30min\.json ausente: uso as grandezas do supervisorio do trafo_30min\.json anterior \(esquema do medidor/.test(Rm2.log)
    && (linha(Rm2.out[30], msDe(dia(33), 600)) || {})['04T1_t_oleo'] === r2(T_OLEO(33, 600) + 1) && (linhaDia(Rm2.out.dia, dia(20)) || {})['04T1_t_oleo_max'] === r2(50 + 20 / 10 + 1)
    && julga(Rm2, 'migra').okSem230Sup === true && Rm2.out[30].supervisorio_ate === T_ISO(msDe(dia(SEM_ARQ), 720)),
    'segunda rodada sem a copia (anterior ja com a marca): avisa no log, a temperatura continua (do anterior) e supervisorio_ate e a ultima linha do supervisorio');

  const prepInc = (base) => (IN) => {
    gravaSup(IN, C);
    for (const [k, n] of Object.entries(NOMES)) {
      const o = JSON.parse(JSON.stringify(base.out[k]));
      if (k !== 'dia') for (const l of o.serie) {
        if (l.ms === msDe(dia(30), 600)) { l['04T1_p'] = 7.77; l['04T1_t_oleo'] = 55.5; l['04T1_v1ab'] = 1; }
        if (l.ms === msDe(dia(37), 600)) l['04T1_p'] = 7.77;
      } else { for (const l of o.serie) { if (l.dia === dia(10)) { l['04T1_p_max'] = 7.77; l['04T1_t_oleo_max'] = 55.5; } if (l.dia === dia(37)) l['04T1_p_max'] = 7.77; }
        o.serie.push({ dia: HOJE, ms: msDe(HOJE, 0), n: 100, '04T1_p_max': 7.77 }); }
      fs.writeFileSync(path.join(IN, n), gz(o));
    }
  };
  const Ri = roda(GEN, 'incremental', HIST_C, prepInc(Rn));
  const Ji = Object.assign(julga(Ri, 'incremental'), juizoIncremental(Ri));
  ok(Ji.okModoInc === true, 'saida anterior com a marca -> modo incremental');
  ok(Ji.okGuarda === true, 'incremental: o dia que nao foi relido fica como estava publicado (sentinela 7,77 preservada)');
  ok(Ji.okNova === true, 'incremental: o dia relido e refeito do medidor (a rodada nova ganha)');
  ok(Ji.okMescla === true, 'incremental: do anterior so ficam os campos do medidor; a temperatura vem de novo da copia, e o v1ab velho some');
  ok(Ji.okCampos === true && Ji.okIntegra === true && Ji.okSup === true, 'incremental: os passos e a juncao continuam certos');
  ok(Ji.okHoje === true, 'incremental: a linha velha de um dia relido que a rodada nova nao produz (o diario de hoje de uma rodada antiga) some');
  ok(Ji.okRebusca === true, 'incremental: o dia incompleto dos ultimos 7 (fora dos 3 de releitura) e relido, e o que o medidor completou depois entra (n 288)');

  const Rw = cenarios.watts();
  ok(!Rw.ok && /raiz\(3\)xVxI diverge de S/.test(Rw.log) && Rw.gravados.length === 0, 'Demat em W (x1000): a guarda de fisica derruba o job e nada e gravado');
  const Rmet = roda(GEN, 'metade', HIST_M, (IN) => gravaSup(IN, C));
  ok(!Rmet.ok && /paridade 04T1_p_max: razao mediana/.test(Rmet.log) && Rmet.gravados.length === 0, 'P, Q e corrente x0,5 (fisica coerente): a paridade contra o supervisorio derruba o job e nada e gravado');
  const Rper = roda(GEN, 'permutados', HIST_P, (IN) => gravaSup(IN, C));
  ok(!Rper.ok && /\|FP\| mediano/.test(Rper.log) && Rper.gravados.length === 0, 'Demat e Demre trocados (S igual, FP perto de 0): a guarda do FP derruba o job e nada e gravado');
  const Rq = roda(GEN, 'quinze', HIST_Q, (IN) => gravaSup(IN, C));
  ok(!Rq.ok && /intervalo QuinzeMinutos/.test(Rq.log) && Rq.gravados.length === 0, 'arquivo do medidor com outro intervalo: o gerador recusa e nada e gravado');
  const Rx = cenarios.trocados();
  ok(!Rx.ok && /identidade/.test(Rx.log) && Rx.gravados.length === 0, 'pontos 6196/6197 trocados: a guarda de identidade derruba o job e nada e gravado');

  /* ---- plantios: copia da lib e do gerador com UMA regra quebrada; tem de rodar e reprovar no julgamento da regra ---- */
  const srcL = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n'), srcG = fs.readFileSync(GEN, 'utf8').replace(/\r\n/g, '\n');
  function aplica(trocas) {
    let L = srcL, G = srcG;
    for (const [a, de, para] of trocas) {
      const src = a === 'lib' ? L : G;
      if (src.split(de).length !== 2) return null;
      if (a === 'lib') L = L.split(de).join(para); else G = G.split(de).join(para);
    }
    if (L === srcL && G === srcG) return null;                      // plantado de verdade: algo mudou
    // nome com o pid: duas rodadas do ensaio ao mesmo tempo (outra sessao, o revisor) nao trocam o plantio uma da outra
    const l = path.join(__dirname, '_plantio_lib_trafo_way2_' + process.pid + '.js'), g = path.join(__dirname, '_plantio_gen_trafo_way2_' + process.pid + '.js');
    tmpCod.push(l, g);
    fs.writeFileSync(l, L); fs.writeFileSync(g, G.split("require('./lib-trafo-way2.js')").join("require('./" + path.basename(l) + "')"));
    return g;
  }
  function planta(nome, trocas, juiz) {
    const g = aplica(trocas);
    if (!g) { ok(false, 'plantio "' + nome + '": o trecho nao casou (nada plantado)'); return; }
    const reprovou = juiz(g);
    ok(reprovou === true, 'plantio "' + nome + '" reprova');
  }
  const naRegra = (cen, chave) => (g) => { const R = cen === 'incremental' ? roda(g, 'inc', HIST_C, prepInc(roda(GEN, 'n', HIST, (IN) => gravaSup(IN, C)))) : roda(g, cen, cen === 'watts' ? HIST_W : cen === 'trocados' ? HIST_X : HIST, cen === 'migra' ? (IN) => { const V = copiaSup(); gravaSup(IN, V, true); fs.writeFileSync(path.join(IN, 'trafo_15min.json'), gz(V['30min'])); } : cen === 'watts' ? null : (IN) => gravaSup(IN, C));
    if (!R.ok) return false;                                        // o plantado tem de RODAR e reprovar na regra
    const J = cen === 'incremental' ? Object.assign(julga(R, 'incremental'), juizoIncremental(R)) : julga(R, cen);
    if (cen === 'migra') J.okMigra = J.okSem230Sup && J.okCampos;
    return J[chave] === false; };
  const publica = (cen, hist) => (g) => { const R = roda(g, cen, hist, cen === 'watts' ? null : (IN) => gravaSup(IN, C)); return R.ok && R.gravados.length > 0; };

  planta('amostra no lugar da media (15/30/60 min)', [['lib', '        if (vs.length === n) m[k] = media(vs);', '        if (vs.length === n) m[k] = vs[0];']], naRegra('normal', 'okIntegra'));
  planta('balde incompleto aceito', [['lib', '        if (vs.length === n) m[k] = media(vs);', '        if (vs.length) m[k] = media(vs);']], naRegra('normal', 'okIncompleto'));
  planta('rotulo na borda direita (sem os 5 min)', [['lib', '        const i0 = ms - PASSO;', '        const i0 = ms;']], naRegra('normal', 'okBorda'));
  planta('qualidade ignorada', [['lib', '        if (v.qualidade !== 0) { est.qualidade += 1; continue; }', '']], naRegra('normal', 'okQualidade'));
  planta('dia pelo nome do arquivo, nao pelo conteudo', [['lib', '        if (i0 < ini || i0 >= fim) { est.fora_do_dia += 1; continue; }', '']], naRegra('normal', 'okConteudo'));
  planta('FP sem modulo', [['lib', '    if (o.s > 0) o.fp = Math.abs(o.p) / o.s;', '    if (o.s > 0) o.fp = o.p / o.s;']], naRegra('normal', 'okCampos'));
  planta('desequilibrio sem o piso de corrente', [['lib', '        if (m > CORRENTE_COM_CARGA) des.push(', '        if (m > 0) des.push(']], naRegra('normal', 'okDeseq'));
  planta('supervisorio de 230 kV vaza na juncao', [['lib', "const CAMPOS_SUP_INTERVALO = ['i2a',", "const CAMPOS_SUP_INTERVALO = ['p', 'v1ab', 'i2a',"]], naRegra('normal', 'okSem230Sup'));
  planta('supervisorio no passo de 15 min', [['gen', '    const semSup = r === 15 || !sup[r];', '    const semSup = !sup[r];'], ['gen', "  for (const r of [...RES, 'dia']) { anteriores[r] = await leBlob(nomeRes(r)); sup[r] = await leBlob(nomeSup(r)); }",
    "  for (const r of [...RES, 'dia']) { anteriores[r] = await leBlob(nomeRes(r)); sup[r] = await leBlob(nomeSup(r === 15 ? 5 : r)); }"]], naRegra('normal', 'okSup'));
  planta('mescla guarda os campos do supervisorio do anterior', [['lib', '.map((r) => soMedidor(r, camposPorTrafo, chaves))', '.map((r) => Object.assign({}, r))']], naRegra('incremental', 'okMescla'));
  planta('incremental descarta os dias nao relidos', [['lib', '  const fica = (anteriorSerie || []).filter((r) => !relidos.has(chaveDia(r)))', '  const fica = (anteriorSerie || []).filter(() => false)']], naRegra('incremental', 'okGuarda'));
  planta('linha velha de dia relido fica', [['lib', '  const fica = (anteriorSerie || []).filter((r) => !relidos.has(chaveDia(r)))', '  const fica = (anteriorSerie || []).filter(() => true)']], naRegra('incremental', 'okHoje'));
  planta('migracao pela existencia, nao pela marca', [['lib', "  for (const k of ['5', '15', '30', '60', 'dia']) if (!anteriores[k] || anteriores[k].esquema !== ESQUEMA) return 'completo';",
    "  for (const k of ['5', '15', '30', '60', 'dia']) if (!anteriores[k]) return 'completo';"]], naRegra('migra', 'okMigra'));
  planta('energizacao por um intervalo so', [['lib', '    if (n >= ENERGIZADO_MIN_INTERVALOS) return true;', '    if (n >= 0 && mapa.size) return true;']], naRegra('normal', 'okDesde'));
  planta('raiz(3) esquecida na tensao', [['lib', '  if (m.va != null) o.v1a = (m.va * R3) / 1000;', '  if (m.va != null) o.v1a = m.va / 1000;'],
    ['lib', '  if (m.vb != null) o.v1b = (m.vb * R3) / 1000;', '  if (m.vb != null) o.v1b = m.vb / 1000;'], ['lib', '  if (m.vc != null) o.v1c = (m.vc * R3) / 1000;', '  if (m.vc != null) o.v1c = m.vc / 1000;']], (g) => { const R = roda(g, 'normal', HIST, (IN) => gravaSup(IN, C)); return !R.ok && /tensao de linha mediana/.test(R.log) && R.gravados.length === 0; });
  planta('guarda de fisica desligada', [['lib', "    if (!(err < TOL_FISICA)) throw new Error('trafo ' + t + ': raiz(3)xVxI diverge de S em '", "    if (false) throw new Error('trafo ' + t + ': raiz(3)xVxI diverge de S em '"]], publica('watts', HIST_W));
  planta('guarda de identidade desligada', [['lib', '  if (out.correlacao != null && !(out.correlacao > 0.3)) throw', '  if (false) throw']], publica('trocados', HIST_X));
  planta('celula vazia lida como zero', [['lib', "        if (typeof v.valor !== 'number' || !isFinite(v.valor)) { est.nulos += 1; continue; }", '        if (v.valor == null || !isFinite(v.valor)) { est.nulos += 1; continue; }']], naRegra('normal', 'okVazio'));
  planta('energizacao com um intervalo de tensao', [['lib', 'const ENERGIZADO_MIN_INTERVALOS = 144;', 'const ENERGIZADO_MIN_INTERVALOS = 1;']], naRegra('normal', 'okDesde'));
  planta('piso do desequilibrio em 10 A', [['lib', 'const CORRENTE_COM_CARGA = 20;', 'const CORRENTE_COM_CARGA = 10;']], naRegra('normal', 'okDeseq'));
  planta('piso do desequilibrio em 30 A', [['lib', 'const CORRENTE_COM_CARGA = 20;', 'const CORRENTE_COM_CARGA = 30;']], naRegra('normal', 'okDeseq'));
  planta('dia incompleto nao e relido', [['lib', '  for (const r of S) if (r.dia >= desde && r.n < 288) set.add(r.dia);', '']], naRegra('incremental', 'okRebusca'));
  planta('guarda da paridade desligada', [['lib', '  for (const [k, v] of Object.entries(out.razoes)) if (!(v > 0.9 && v < 1.1)) throw', '  for (const [k, v] of Object.entries(out.razoes)) if (false) throw']], publica('metade', HIST_M));
  planta('guarda do FP desligada', [['lib', '    if (fp != null && !(fp > 0.85)) throw', '    if (false) throw']], publica('permutados', HIST_P));
  planta('intervalo do arquivo nao conferido', [['lib', "  if (h.intervalo && h.intervalo !== 'CincoMinutos') throw", '  if (false) throw']], publica('quinze', HIST_Q));
  planta('fase trocada na leitura (TensaoA <-> TensaoB)', [['lib', "TensaoA: 'va', TensaoB: 'vb',", "TensaoA: 'vb', TensaoB: 'va',"]], naRegra('normal', 'okCampos'));
  planta('fase copiada na leitura (TensaoC lida como A)', [['lib', "TensaoC: 'vc',", "TensaoC: 'va',"]], naRegra('normal', 'okCampos'));
  planta('S do balde como media dos S de 5 min', [['lib', '    const linha = linhaPublicada(b, porTrafo);\n',
    "    const linha = linhaPublicada(b, porTrafo);\n    for (const t of TRAFOS) { const ss = regs.map((x) => campos(x[t]).s).filter((x) => x != null); if (ss.length === n) linha[t + '_s'] = r2(media(ss)); }\n"]], naRegra('normal', 'okIntegra'));
  planta('o dia de hoje no diario', [['gen', '    if (dia < HOJE) o.dia = T.diario(dia, mapa);', '    o.dia = T.diario(dia, mapa);']], naRegra('normal', 'okHoje'));

  /* ---- o ensaio de PRODUTO tambem prova que reprova: o --produto deste arquivo sobre a saida forjada (passa) e sobre ela adulterada ---- */
  function produto(muda, base, hist, semCopia, mudaSup) {
    const B = base || Rn;
    const dir = path.join(raiz, 'prod' + (++seq));
    fs.mkdirSync(dir, { recursive: true });
    for (const f of B.gravados) {
      const o = desembrulha(fs.readFileSync(path.join(B.outDir, f)));
      if (muda) muda(f, o);
      fs.writeFileSync(path.join(dir, f), gz(o));
    }
    if (!semCopia) gravaSup(dir, C);
    if (mudaSup) for (const f of fs.readdirSync(dir).filter((x) => /^trafo_scada_/.test(x))) { const o = desembrulha(fs.readFileSync(path.join(dir, f))); mudaSup(f, o); fs.writeFileSync(path.join(dir, f), gz(o)); }
    try { return { ok: true, log: execFileSync('node', [__filename, '--produto'], { env: Object.assign({}, process.env, { BASE_DADOS: dir, HIST_DIR: hist || HIST, HOJE }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
    catch (e) { return { ok: false, log: String(e.stdout || '') + String(e.stderr || '') }; }
  }
  // reprova = saiu com erro, imprimiu a FALHA da regra adulterada e nenhum ERRO de codigo (um crash no caminho da divergencia nao conta)
  const reprova = (P, re) => !P.ok && re.test(P.log) && !/^ERRO:/m.test(P.log);
  { const P = produto(null); ok(P.ok && /julgou alguma coisa: 2 dia/.test(P.log), '--produto passa sobre a saida certa do mundo forjado' + (P.ok ? '' : ': ' + P.log.split('\n').filter((x) => /FALHA|ERRO/.test(x)).slice(0, 2).join(' | '))); }
  const em5 = (o, ms, k, v) => { const l = o.serie.find((x) => x.ms === ms); if (!l) throw new Error('linha forjada ausente'); l[k] = v; };
  ok(reprova(produto((f, o) => { if (f === 'trafo_5min.json') em5(o, msDe(dia(37), 720), '04T1_p', r2(esperado5('04T1', 37, 144).p) + 0.02); }), /FALHA o publicado e o medidor recontado.*5min 2026-01-08T12:00 04T1_p/),
    '--produto reprova o 5 min com P 0,02 MW fora do medidor recontado');
  ok(reprova(produto((f, o) => { if (f === 'trafo_30min.json') em5(o, msDe(dia(37), 720), '04T2_p', 1); }), /FALHA o publicado e o medidor recontado.*30min 2026-01-08T12:00 04T2_p/), '--produto reprova o 30 min fora da media recontada');
  ok(reprova(produto((f, o) => { if (f === 'trafo_5min.json') em5(o, msDe(dia(37), 720), '04T2_v1c', 1); }), /FALHA o publicado e o medidor recontado.*04T2_v1c/), '--produto reprova a tensao da fase C fora do medidor (todos os campos recontados)');
  ok(reprova(produto((f, o) => { if (f === 'trafo_60min.json') em5(o, msDe(dia(37), 720), '04T1_fp', 0.5); }), /FALHA o publicado e o medidor recontado.*60min 2026-01-08T12:00 04T1_fp/), '--produto reprova o FP integralizado fora da conta');
  ok(reprova(produto((f, o) => { if (f === 'trafo_diario.json') o.serie.find((x) => x.dia === dia(37)).n = 280; }), /FALHA o publicado e o medidor recontado.*diario 2026-01-08 n/), '--produto reprova o n do dia');
  ok(reprova(produto((f, o) => { if (f === 'trafo_diario.json') o.serie.find((x) => x.dia === dia(37))['04T2_deseq_max'] = 1; }), /FALHA o publicado e o medidor recontado.*diario 2026-01-08 04T2_deseq_max/), '--produto reprova o desequilibrio do dia');
  ok(reprova(produto((f, o) => { delete o.guardas; }), /FALHA as guardas do gerador julgaram/), '--produto reprova produto sem o veredito das guardas (fisica e paridade)');
  ok(reprova(produto((f, o) => { if (f === 'trafo_60min.json') o.serie[5]['04T1_v1ab'] = 239; }), /FALHA so campos declarados.*04T1_v1ab/), '--produto reprova a tensao entre fases do supervisorio de volta (v1ab)');
  ok(reprova(produto((f, o) => { if (f === 'trafo_30min.json') em5(o, msDe(dia(37), 720), '04T1_t_oleo', 1); }), /FALHA temperatura, comutador e 34,5 kV iguais/), '--produto reprova temperatura diferente da copia');
  ok(reprova(produto((f, o) => { if (f === 'trafo_diario.json') delete o.esquema; }), /FALHA os cinco com a marca/), '--produto reprova sem a marca do esquema');
  // trafo-um-escritor: a copia regravada pelo trafo.yml depois da leitura do gerador nao e a que o produto leu: nao vira vermelho falso, e
  // o log diz. A marca e a IDENTIDADE da copia, nao a hora: uma copia de marca ANTERIOR a do produto, mas outra, tambem fica para depois
  { const P = produto((f, o) => { if (f === 'trafo_30min.json') em5(o, msDe(dia(37), 720), '04T1_t_oleo', 1); }, null, null, false, (f, o) => { o.gerado_em = '2025-12-31T23:00:00.000Z'; });
    ok(P.ok && /diferente da que o produto leu/.test(P.log), '--produto nao reprova a copia diferente da que o produto leu, mesmo de marca anterior (a comparacao fica para a rodada seguinte, dita no log)'); }
  ok(desembrulha(fs.readFileSync(path.join(Rn.outDir, 'trafo_30min.json'))).supervisorio_gerado_em === C['30min'].gerado_em, 'o produto registra a marca da copia que leu (supervisorio_gerado_em)');
  ok(reprova(produto(null, null, null, true), /FALHA copia do supervisorio ausente \(trafo_scada_30min\.json, trafo_scada_diario\.json\)/), '--produto sem a copia do supervisorio reprova dizendo a causa');
  ok(reprova(produto((f, o) => { if (f === 'trafo_5min.json') { o.serie.push({ ms: msDe(dia(37), 2), t: 'x', '04T1_p': 1 }); o.serie.sort((a, b) => a.ms - b.ms); } }), /FALHA o publicado e o medidor recontado.*publicado sem o medidor/),
    '--produto reprova linha publicada sem o intervalo no medidor (o inverso da recontagem)');
  // RE-101: o 04T2 desligado nos ultimos dias (manutencao) nao derruba; com a guarda de fisica desligada, reprova
  const Rd = roda(GEN, 'desligado', HIST_D, (IN) => gravaSup(IN, C));
  { const P = Rd.ok ? produto(null, Rd, HIST_D) : { ok: false, log: Rd.log };
    ok(Rd.ok && P.ok && /04T2 NAO julgada: sem carga na janela: 0 intervalo/.test(P.log) && /04T1 julgada/.test(P.log),
      'o 04T2 desligado na janela (manutencao): o gerador publica, o veredito diz o porque e o --produto passa com o 04T1 julgado'); }
  { const g = aplica([['lib', '    if (cheias.length < 100) {\n', '    if (true) {\n']]);
    if (!g) ok(false, 'plantio "guarda de fisica sem julgar": o trecho nao casou');
    else { const Rg = roda(g, 'semfisica', HIST, (IN) => gravaSup(IN, C));
      ok(Rg.ok && reprova(produto(null, Rg), /FALHA as guardas do gerador julgaram: fisica \(04T1 NAO julgada/), 'plantio "guarda de fisica sem julgar" reprova no --produto (os dois trafos sem veredito julgado)'); } }

  console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-trafo-way2 --lib: tudo ok');
  process.exit(falhas.length ? 1 : 0);
}

/* ============================================================== --produto =====================================================
   Sobre o publicado, logo depois do gerador (no workflow, com a mesma copia do historico: os dias recontados acabaram de ser relidos).
   Os dias: os DOIS mais recentes do diario antes de hoje, dentro da janela do 5 min — sempre dentro dos dias que o gerador rele em toda
   rodada (os 3 antes do ultimo publicado). Sem exigir 288: a recontagem itera os valores presentes, como o gerador.
   A conta e propria (nao usa a lib): leitura do medidor, conversao, integralizacao, S, FP, carga, dia e desequilibrio. */
(async () => {
  const BASE = process.env.DADOS_BASE_PUB || 'https://rbenergydata.blob.core.windows.net/dados/';
  const HOJE = process.env.HOJE || new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const le = async (nome) => {
    if (process.env.BASE_DADOS) { const f = path.join(process.env.BASE_DADOS, nome); return fs.existsSync(f) ? desembrulha(fs.readFileSync(f)) : null; }
    const b = await require('./lib-le-dados.js').bytes(BASE + nome); return b ? desembrulha(b) : null;
  };
  const leHist = async (d) => {
    if (process.env.HIST_DIR) { const f = path.join(process.env.HIST_DIR, 'way2_' + d + '.json'); return fs.existsSync(f) ? desembrulha(fs.readFileSync(f)) : null; }
    const b = await require('./lib-le-blob.js').bytes(BASE + 'hist/way2_' + d + '.json', { 'Accept-Encoding': 'gzip' }); return b ? desembrulha(b) : null;
  };
  const iso = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 16);
  const O = {};
  for (const k of ['5min', '15min', '30min', '60min', 'diario']) O[k] = await le('trafo_' + k + '.json');
  const SUP = {};
  for (const k of ['5min', '30min', '60min', 'diario']) SUP[k] = await le('trafo_scada_' + k + '.json');
  console.log('trafo_* publicado (' + (process.env.BASE_DADOS ? 'pasta ' + process.env.BASE_DADOS : 'blob') + ') · hoje ' + HOJE);
  ok(Object.values(O).every((o) => o && o.esquema === 'medidor-230kv-1'), 'os cinco com a marca do esquema do medidor');
  if (!Object.values(O).every((o) => o && Array.isArray(o.serie))) { console.log('\n' + (falhas.length || 1) + ' FALHA(S)'); process.exit(1); }
  const permitidas = new Set(['ms', 't', 'dia', 'n', ...TR.flatMap((t) => [...CAMPOS_MED, ...CAMPOS_MED_DIA, ...SUP_INT, ...SUP_DIA].map((c) => t + '_' + c))]);
  const estranhas = new Set();
  for (const o of Object.values(O)) for (const l of o.serie) for (const k of Object.keys(l)) if (!permitidas.has(k)) estranhas.add(k);
  ok(estranhas.size === 0, 'so campos declarados (medidor ou supervisorio); nenhuma chave do lado de 230 kV do supervisorio' + (estranhas.size ? ': ' + [...estranhas].slice(0, 8).join(' ') : ''));
  ok(O['15min'].serie.every((l) => Object.keys(l).every((k) => !SUP_INT.some((c) => k.endsWith('_' + c)))), 'o 15 min sem grandeza do supervisorio');
  // a recontagem usa as MESMAS premissas de unidade do gerador: quem pega a mudanca de unidade da fonte sao as guardas dele, e elas
  // podem pular com pouco dado. Entao o produto tem de dizer que elas JULGARAM (RE-008)
  // um trafo legitimamente desligado na janela (manutencao, SEP) nao derruba: basta UM julgado, e o que nao julgou diz o porque
  const G = O.diario.guardas || {};
  const fis = G.fisica || {}, par = G.paridade || {};
  const porque = (t) => (fis[t] ? (fis[t].julgada ? 'julgada em ' + fis[t].intervalos + ' intervalos' : 'NAO julgada: ' + (fis[t].motivo || '?')) : 'sem veredito');
  ok(TR.some((t) => fis[t] && fis[t].julgada === true) && TR.every((t) => fis[t] && (fis[t].julgada === true || !!fis[t].motivo)) && par.dias >= 30,
    'as guardas do gerador julgaram: fisica (' + TR.map((t) => t + ' ' + porque(t)).join('; ') + (fis.sem_arquivo && fis.sem_arquivo.length ? '; dias sem arquivo na janela: ' + fis.sem_arquivo.join(' ') : '')
    + ') e paridade contra o supervisorio em ' + (par.dias == null ? '?' : par.dias) + ' dias (30+)');

  const ini5 = O['5min'].serie.length ? O['5min'].serie[0].ms : Infinity;
  const D = O.diario.serie.filter((l) => l.n > 0 && l.dia < HOJE && msDe(l.dia, 0) >= ini5).slice(-2).map((l) => l.dia);
  const GR = { Demat: 'p', Demre: 'q', TensaoA: 'va', TensaoB: 'vb', TensaoC: 'vc', CorrenteA: 'ia', CorrenteB: 'ib', CorrenteC: 'ic' };
  const pub = (b) => {                                     // os campos publicados de UMA media (5 min, ou a media do balde)
    const o = {};
    if (b.ia != null) o.i1a = b.ia; if (b.ib != null) o.i1b = b.ib; if (b.ic != null) o.i1c = b.ic;
    if (b.va != null) o.v1a = b.va * R3 / 1000; if (b.vb != null) o.v1b = b.vb * R3 / 1000; if (b.vc != null) o.v1c = b.vc * R3 / 1000;
    if (b.p != null) o.p = b.p / 1000; if (b.q != null) o.q = b.q / 1000;
    if (o.p != null && o.q != null) { o.s = Math.sqrt(o.p * o.p + o.q * o.q); if (o.s > 0) o.fp = Math.abs(o.p) / o.s; o.carga_pct = o.s / 2.3; }
    return o;
  };
  const porMs = (S) => new Map(S.serie.map((l) => [l.ms, l]));
  const M5 = porMs(O['5min']), MP = { 15: porMs(O['15min']), 30: porMs(O['30min']), 60: porMs(O['60min']) };
  let julgados = 0, valores = 0, baldes = 0;
  const errados = [];
  const compara = (rot, l, t, e, campos) => { for (const c of campos) { valores += 1; const v = (l || {})[t + '_' + c];
    if (e[c] == null ? v != null : !perto(v, r2(e[c]))) errados.push(rot + ' ' + t + '_' + c + ' (publicado ' + v + ', medidor ' + (e[c] == null ? 'ausente' : r2(e[c])) + ')'); } };
  for (const d of D) {
    const h = await leHist(d);
    if (!h) { errados.push('diario ' + d + ': sem o arquivo do medidor para recontar'); continue; }
    julgados += 1;
    const ini = msDe(d, 0), M = new Map();
    for (const [t, pid] of [['04T1', 6196], ['04T2', 6197]]) for (const s of h.dados) {
      if (s.pontoId !== pid || !GR[s.nomeGrandeza]) continue;
      for (const v of s.valores) {
        if (typeof v.valor !== 'number' || !isFinite(v.valor) || v.qualidade !== 0) continue;
        const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v.data);
        const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) + 3 * 3600e3 - 300000;   // borda direita -> inicio
        if (ms < ini || ms >= ini + 864e5) continue;
        const r = M.get(ms) || M.set(ms, {}).get(ms); (r[t] || (r[t] = {}))[GR[s.nomeGrandeza]] = v.valor;
      }
    }
    for (const [ms, r] of M) for (const t of TR) compara('5min ' + iso(ms), M5.get(ms), t, pub(r[t] || {}), CAMPOS_MED);
    // o inverso: toda linha publicada do dia com grandeza do medidor tem o intervalo (ou o balde) no medidor recontado
    const temMed = (l) => TR.some((t) => CAMPOS_MED.some((c) => l[t + '_' + c] != null));
    for (const [rot, S, min] of [['5min', O['5min'], 5], ['15min', O['15min'], 15], ['30min', O['30min'], 30], ['60min', O['60min'], 60]]) for (const l of S.serie) {
      if (l.ms < ini || l.ms >= ini + 864e5 || !temMed(l)) continue;
      valores += 1;
      if (![...Array(min / 5).keys()].some((j) => M.has(l.ms + j * 300000))) errados.push(rot + ' ' + iso(l.ms) + ': publicado sem o medidor (nenhum intervalo do medidor nesse instante)');
    }
    for (const min of [15, 30, 60]) for (let b = ini; b < ini + 864e5; b += min * 60e3) {
      if (![...Array(min / 5).keys()].some((j) => M.has(b + j * 300000))) continue;
      baldes += 1;
      for (const t of TR) {
        const md = {};
        for (const g of ['p', 'q', 'va', 'vb', 'vc', 'ia', 'ib', 'ic']) {
          const vs = []; for (let x = b; x < b + min * 60e3; x += 300000) { const r = (M.get(x) || {})[t]; if (r && r[g] != null) vs.push(r[g]); }
          if (vs.length === min / 5) md[g] = media(vs);
        }
        const e = pub(md); delete e.carga_pct; if (e.s != null) e.carga_pct = e.s / 2.3;
        compara(min + 'min ' + iso(b), MP[min].get(b), t, e, CAMPOS_MED);
      }
    }
    const ld = O.diario.serie.find((x) => x.dia === d) || {};
    let n = null;
    for (const t of TR) {
      const S = [], P = [], des = [];
      for (const r of M.values()) {
        const e = pub(r[t] || {});
        if (e.s != null) S.push(e.s); if (e.p != null) P.push(e.p);
        if (e.i1a != null && e.i1b != null && e.i1c != null) { const f = [e.i1a, e.i1b, e.i1c], m = media(f); if (m > 20) des.push((Math.max(...f) - Math.min(...f)) / m * 100); }
      }
      n = n == null ? P.length : Math.min(n, P.length);
      const e = S.length ? { s_max: Math.max(...S), s_med: media(S), carga_pct_max: Math.max(...S) / 2.3 } : {};
      if (P.length) Object.assign(e, { p_max: Math.max(...P), p_med: media(P) });
      if (des.length) Object.assign(e, { deseq_max: Math.max(...des), deseq_med: media(des) });
      compara('diario ' + d, ld, t, e, CAMPOS_MED_DIA);
    }
    valores += 1;
    if (ld.n !== n) errados.push('diario ' + d + ' n (publicado ' + ld.n + ', medidor ' + n + ')');
  }
  ok(julgados >= 1 && valores >= 500 && baldes >= 50, 'julgou alguma coisa: ' + julgados + ' dia(s) (' + (D.join(', ') || 'nenhum dia relido para recontar') + '), ' + valores + ' valores, ' + baldes + ' baldes de 15/30/60 min');
  ok(errados.length === 0, 'o publicado e o medidor recontado aqui batem com folga de 0,01' + (errados.length ? ': ' + errados.length + ' diferentes, ex. ' + errados.slice(0, 4).join(' · ')
    + ' — os dias recontados sao relidos pelo gerador em toda rodada: no workflow, logo depois dele, e defeito do GERADOR; rodado mais tarde, '
    + 'pode ser a fonte revisada depois de publicar (a rodada seguinte, ou forcar=1, refaz)' : ''));
  let supComp = 0, supDif = 0;
  // sem a copia nao ha com o que comparar: a causa vai na mensagem (o gerador herdou as grandezas do supervisorio do anterior)
  const semCopia = ['30min', 'diario'].filter((k) => !SUP[k]);
  if (semCopia.length) ok(false, 'copia do supervisorio ausente (' + semCopia.map((k) => 'trafo_scada_' + k + '.json').join(', ') + '): temperatura, comutador e 34,5 kV publicados vem herdados da rodada anterior e nao se conferem; o gen-trafo nao gravou a copia');
  // trafo-um-escritor (23/10/2026): a copia e gravada pelo trafo.yml, sem ordem com este workflow. Compara so com a MESMA copia que o
  // produto leu (a marca `supervisorio_gerado_em` dele = o gerado_em da copia); outra copia fica para a rodada seguinte (dita no log),
  // nunca vira vermelho falso. Produto sem a marca (anterior ao lote): compara como antes
  const depois = [];
  for (const [k, campos, chave] of [['30min', SUP_INT, 'ms'], ['diario', SUP_DIA, 'dia']]) {
    if (!SUP[k]) continue;
    if (O[k].supervisorio_gerado_em !== undefined && O[k].supervisorio_gerado_em !== (SUP[k].gerado_em || null)) { depois.push('trafo_scada_' + k + ' (no ar a copia de ' + SUP[k].gerado_em + ', o produto leu a de ' + O[k].supervisorio_gerado_em + ')'); continue; }
    const pubM = new Map(O[k].serie.map((l) => [l[chave], l]));
    for (const s of SUP[k].serie.slice(-500)) { const l = pubM.get(s[chave]); if (!l) continue; for (const t of TR) for (const c of campos) if (s[t + '_' + c] != null) { supComp += 1; if (l[t + '_' + c] !== s[t + '_' + c]) supDif += 1; } }
  }
  if (depois.length) console.log('  ..   copia do supervisorio diferente da que o produto leu, comparada na rodada seguinte: ' + depois.join('; '));
  if (!semCopia.length && depois.length < 2) ok(supComp > 0 && supDif === 0, 'temperatura, comutador e 34,5 kV iguais a copia do supervisorio na mesma chave (' + supComp + ' valores, ' + supDif + ' diferentes)');
  try { if (!process.env.HIST_DIR) require('./lib-le-blob.js').resumo(); } catch (e) { /* sem lib */ }
  console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-trafo-way2 --produto: tudo ok');
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
