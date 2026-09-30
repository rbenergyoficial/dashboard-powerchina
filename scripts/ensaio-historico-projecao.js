/*
 * ensaio-historico-projecao.js — o historico da projecao e a conta do cartao refeita, mes a mes (PROMOVER hist-projecao).
 *
 * POR QUE EXISTE. O executivo passou a publicar, por entidade e mes liquidado, a meta, o gerado e o que a projecao diria
 * com 5, 10, 15, 20 e 25 dias fechados (`historico_projecao`), e o resumo de acerto por marco; e um segundo arquivo,
 * `projecao_registro.json`, guarda o que a manchete publicou dia a dia. Numero de acerto errado nao quebra tela: faz o
 * historico elogiar ou condenar o metodo pelo motivo errado. Registro que para de crescer nao se recupera.
 *
 *   --lib       a REGRA, em casos forjados: conta de cada marco, dias do mes (28, 30, 31), dia faltando, dia parcial, mes
 *               aberto, mes sem meta, comissionamento fora do resumo, fronteira na meta; e o registro: so o mes aberto
 *               entra, a mesma projecao nao regrava, a nova vira versao, chave antiga some ou versao alterada reprova.
 *               Roda ANTES de gerar.
 *   --produto   o blob publicado contra uma segunda conta, escrita aqui sem a lib: cada linha campo a campo, nenhum mes
 *               liquidado de fora, nenhuma linha a mais ou repetida, o comissionamento contra a serie mensal, o gerado
 *               contra a serie mensal (em TODA linha), o resumo inteiro refeito. Cada plantio tem de reprovar pelo campo
 *               que plantou.
 *   --registro  o registro publicado: chaves unicas, versoes coerentes, e a projecao de hoje da manchete presente nele
 *               enquanto o mes estiver aberto. Roda logo depois do gravador.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const MARCOS = [5, 10, 15, 20, 25];

const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome, opcional) {
  if (!/^https?:/.test(BASE)) {
    const p = path.join(BASE, nome);
    if (opcional && !fs.existsSync(p)) return Promise.resolve(null);
    return Promise.resolve(deJson(fs.readFileSync(p)));
  }
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (opcional && r.statusCode === 404) { r.resume(); return ok(null); }
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome)));
    req.on('error', ko);
  });
}
const perto = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;

/* ---------------------------------------------------------------- --lib ---- */
function ensaioLib() {
  const L_ = require('./lib-historico-projecao.js');
  const f = [];
  const cobra = (cond, msg) => { if (!cond) f.push(msg); };
  const dia = (ufv, mes, n, v, parcial) => ({ ufv, mes, dia_num: n, liq_mwh: v, parcial: parcial ? 1 : 0 });
  const mesCheio = (ufv, mes, N, fn) => Array.from({ length: N }, (_, i) => dia(ufv, mes, i + 1, fn(i + 1)));
  const dias = [].concat(
    mesCheio('A', '2026-06', 30, () => 100),                          // constante: toda projecao = gerado
    mesCheio('E', '2026-06', 30, (d) => (d <= 15 ? 50 : 150)),        // metade fraca: ate o dia 25 diz "nao bate", bateu
    mesCheio('F', '2026-02', 28, (d) => d),                           // fevereiro, rampa 1..28
    mesCheio('G', '2026-07', 31, () => 10),                           // 31 dias
    mesCheio('B', '2026-06', 30, () => 100).filter((x) => x.dia_num !== 17),   // um dia faltando: fora
    mesCheio('P', '2026-06', 30, () => 100).map((x) => (x.dia_num === 30 ? Object.assign({}, x, { parcial: 1 }) : x)),   // ultimo dia parcial: fora
    mesCheio('C', '2026-09', 30, () => 100),                          // mes aberto: fora
    mesCheio('S', '2026-06', 30, () => 100),                          // sem meta: fora
    mesCheio('A', '2025-09', 30, () => 20),                           // comissionamento: entra marcado, fora do resumo
    mesCheio('T', '2026-06', 30, () => 100));                         // fronteira: gerado e projecao IGUAIS a meta
  const metas = { A: { '2026-06': 2900, '2025-09': 3000 }, E: { '2026-06': 2900 }, F: { '2026-02': 400 }, G: { '2026-07': 320 },
    B: { '2026-06': 2900 }, P: { '2026-06': 2900 }, C: { '2026-09': 2900 }, T: { '2026-06': 3000 } };
  const H = L_.historicoProjecao({ dias, metas, rampUp: new Set(['2025-09']), aberto: (m) => m === '2026-09' });
  const L = (u, m) => H.linhas.find((x) => x.ufv === u && x.mes === m);

  const a = L('A', '2026-06');
  cobra(a && a.liq_mwh === 3000 && a.ating_pct === 103.45 && a.bateu === 1, 'A: gerado/atingimento/bateu errados: ' + JSON.stringify(a));
  cobra(a && MARCOS.every((D) => a['p' + D + '_mwh'] === 3000 && a['p' + D + '_erro_pct'] === 0 && a['p' + D + '_acertou'] === 1),
    'A: dia constante tem de projetar o proprio gerado em todo marco');
  const e = L('E', '2026-06');
  cobra(e && e.p10_mwh === 1500 && e.p10_pct === 51.72 && e.p10_erro_pct === -50 && e.p10_acertou === 0,
    'E: com 10 dias fechados a projecao e 50 x 30 = 1500 MWh, 51,72 % da meta, -50 %, errou o veredito: ' + JSON.stringify(e && [e.p10_mwh, e.p10_pct, e.p10_erro_pct, e.p10_acertou]));
  cobra(e && e.p15_mwh === 1500 && e.p20_mwh === 2250 && e.p20_acertou === 0 && e.p25_mwh === 2700 && e.p25_acertou === 0,
    'E: marcos 15/20/25 (750/15x30=1500, 1500/20x30=2250, 2250/25x30=2700, todos abaixo da meta): ' + JSON.stringify(e && [e.p15_mwh, e.p20_mwh, e.p25_mwh]));
  const fv = L('F', '2026-02');
  cobra(fv && fv.dias === 28 && fv.liq_mwh === 406 && fv.p5_mwh === 84 && fv.p25_mwh === 364,
    'F: fevereiro tem 28 dias; 1..5 = 15, x28/5 = 84; 1..25 = 325, x28/25 = 364: ' + JSON.stringify(fv && [fv.dias, fv.liq_mwh, fv.p5_mwh, fv.p25_mwh]));
  const g = L('G', '2026-07');
  cobra(g && g.dias === 31 && g.liq_mwh === 310 && g.p15_mwh === 310 && g.bateu === 0 && g.p15_acertou === 1,
    'G: julho tem 31 dias: ' + JSON.stringify(g && [g.dias, g.liq_mwh, g.p15_mwh]));
  const t = L('T', '2026-06');
  cobra(t && t.bateu === 1 && t.ating_pct === 100 && MARCOS.every((D) => t['p' + D + '_acertou'] === 1),
    'T: gerado igual a meta e meta batida, e projecao igual a meta diz que bate: ' + JSON.stringify(t && [t.bateu, t.p15_acertou]));
  cobra(!L('B', '2026-06'), 'B: mes com um dia faltando nao pode entrar');
  cobra(!L('P', '2026-06'), 'P: mes com o ultimo dia parcial nao pode entrar');
  cobra(!L('C', '2026-09'), 'C: mes aberto nao pode entrar');
  cobra(!L('S', '2026-06'), 'S: mes sem meta nao pode entrar');
  const r = L('A', '2025-09');
  cobra(r && r.ramp_up === 1, 'A 2025-09: comissionamento entra marcado');
  const acA = H.acerto.filter((x) => x.ufv === 'A');
  cobra(acA.length === MARCOS.length && acA.every((x) => x.n_meses === 1 && x.acertos === 1 && x.erro_abs_pct === 0),
    'resumo de A: so jun/26 (o comissionamento fica fora): ' + JSON.stringify(acA[0]));
  const acE = H.acerto.find((x) => x.ufv === 'E' && x.dia === 10);
  cobra(acE && acE.acertos === 0 && acE.erro_abs_pct === 50 && acE.vies_pct === -50 && acE.pior_pct === 50, 'resumo de E no dia 10: ' + JSON.stringify(acE));

  // o REGISTRO
  const man = [
    { mes: '2026-10', ufv: 'Complexo', fechado: 0, dias_decorridos: 3, dias_total: 31, meta_mwh: 58000, liq_fechada_mwh: 6000, liq_proj_mwh: 62000, proj_pct_exato: 106.9 },
    { mes: '2026-10', ufv: 'M1', fechado: 0, dias_decorridos: 3, dias_total: 31, meta_mwh: 9000, liq_fechada_mwh: 900, liq_proj_mwh: 9300 },
    { mes: '2026-09', ufv: 'Complexo', fechado: 1, dias_decorridos: 30, dias_total: 30, meta_mwh: 58000, liq_proj_mwh: 61230 },
    { mes: '2026-10', ufv: 'M2', fechado: 0, dias_decorridos: 0, dias_total: 31, meta_mwh: 3000, liq_proj_mwh: null },
  ];
  const en = L_.entradasDaManchete(man, 'T1');
  cobra(en.length === 2 && en.every((x) => x.mes === '2026-10' && x.dias_fechados === 3), 'registro: so o mes aberto com projecao entra: ' + en.length);
  cobra(en[1] && en[1].proj_pct === 103.33, 'registro: sem proj_pct_exato, o % sai da projecao e da meta: ' + (en[1] && en[1].proj_pct));
  let recusou = false; try { L_.entradasDaManchete([{ mes: '2026-10', ufv: 'X', fechado: false }], 'T'); } catch (x) { recusou = true; }
  cobra(recusou, 'registro: `fechado` fora de 0/1 tem de estourar (a manchete mudou de forma)');
  const m0 = L_.mesclaRegistro([], en);
  cobra(m0.lista.length === 2 && m0.novas === 2 && m0.lista.every((x) => x.versoes.length === 1 && x.versoes[0].gravado === 'T1'), 'registro: entrada nova nasce com uma versao');
  const m1 = L_.mesclaRegistro(m0.lista, L_.entradasDaManchete(man, 'T2'));
  cobra(m1.novas === 0 && m1.revistas === 0 && JSON.stringify(m1.lista) === JSON.stringify(m0.lista), 'registro: a mesma projecao nao muda nada (fica a gravacao T1)');
  const m2 = L_.mesclaRegistro(m1.lista, [Object.assign({}, en[0], { proj_mwh: 62100, gravado: 'T3' })]);
  const rv = m2.lista.find((x) => x.ufv === 'Complexo');
  cobra(m2.revistas === 1 && rv.proj_mwh === 62100 && rv.versoes.length === 2 && rv.versoes[0].proj_mwh === 62000 && rv.versoes[1].gravado === 'T3',
    'registro: projecao nova vira a SEGUNDA versao e a primeira fica: ' + JSON.stringify(rv && rv.versoes));
  cobra(L_.confereCrescimento(m1.lista, m2.lista).length === 0, 'registro: crescimento legitimo acusado');
  cobra(L_.confereCrescimento(m2.lista, m2.lista.slice(1)).some((x) => /sumiu/.test(x)), 'registro: chave antiga sumida nao reprovou');
  const adulterado = JSON.parse(JSON.stringify(m2.lista)); adulterado.find((x) => x.ufv === 'Complexo').versoes[0].proj_mwh = 1;
  cobra(L_.confereCrescimento(m2.lista, adulterado).some((x) => /versoes antigas/.test(x)), 'registro: versao antiga alterada nao reprovou');
  let dup = false; try { L_.mesclaRegistro(m2.lista.concat([m2.lista[0]]), []); } catch (x) { dup = true; }
  cobra(dup, 'registro: registro antigo com chave repetida tem de estourar');
  return f;
}

/* ------------------------------------------------------------ --produto ---- */
const diasNo = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
/* AS FOLGAS, da cadeia de arredondamento. O historico e a segunda conta somam os MESMOS valores diarios publicados, na
   mesma ordem: o que difere e so o r2 final de cada campo, |r2(x) - x| <= 0,005. O gerado contra a serie MENSAL e outro
   acumulador, do valor cru: cada um dos N dias publicados carrega ate 0,005 de arredondamento, e o mensal mais 0,005. */
const TOL = 0.0051;
const tolMensal = (N) => 0.005 * N + 0.0051;

function julgaProduto(j) {
  const f = [];
  const H = j.historico_projecao, A = j.historico_projecao_acerto;
  if (!Array.isArray(H) || !H.length) return ['historico_projecao ausente ou vazio'];
  if (!Array.isArray(A) || !A.length) return ['historico_projecao_acerto ausente ou vazio'];
  const mc = (j.manchete_ufv || []).find((m) => m.ufv === 'Complexo' && m.mes === j.mes_atual);
  const aberto = (m) => m > j.mes_atual || (m === j.mes_atual && !(mc && mc.fechado === 1));
  const rampSerie = new Set((j.serie || []).filter((s) => s.ramp_up).map((s) => s.mes));
  const meta = {};
  (j.serie_ufv || []).forEach((x) => { meta[x.ufv + '|' + x.mes] = x; });
  // a segunda conta: agrupa a serie diaria sem a lib
  const G = {}, pend = new Set();
  (j.serie_dia_ufv || []).forEach((x) => {
    const k = x.ufv + '|' + x.mes;
    if (x.liq_mwh == null || x.parcial === 1) { pend.add(k); return; }
    (G[k] = G[k] || [])[x.dia_num] = x.liq_mwh;
  });
  const esperadas = new Set();
  Object.entries(G).forEach(([k, arr]) => {
    const m = k.split('|')[1], N = diasNo(m), s = meta[k];
    if (aberto(m) || pend.has(k) || !s || !(s.meta_mwh > 0)) return;
    for (let d = 1; d <= N; d++) if (arr[d] == null) return;
    esperadas.add(k);
  });
  const pub = new Map(H.map((l) => [l.ufv + '|' + l.mes, l]));
  if (pub.size !== H.length) f.push('historico com ' + (H.length - pub.size) + ' linha(s) repetida(s)');
  esperadas.forEach((k) => { if (!pub.has(k)) f.push(k + ': mes liquidado e completo, fora do historico'); });
  pub.forEach((l, k) => { if (!esperadas.has(k)) f.push(k + ': no historico sem ser mes liquidado e completo'); });

  let nMensal = 0, nJulg = 0;
  pub.forEach((l, k) => {
    if (!esperadas.has(k)) return;
    nJulg++;
    const arr = G[k], N = diasNo(l.mes), M = meta[k].meta_mwh;
    let real = 0; for (let d = 1; d <= N; d++) real += arr[d];
    const chk = (campo, v, tol) => { if (!perto(l[campo], v, tol)) f.push(k + ' ' + campo + ': publicado ' + l[campo] + ', refeito ' + (v == null ? v : Math.round(v * 1000) / 1000)); };
    chk('meta_mwh', M, TOL); chk('liq_mwh', real, TOL); chk('ating_pct', 100 * real / M, TOL);
    if (l.bateu !== (real >= M ? 1 : 0)) f.push(k + ' bateu: publicado ' + l.bateu);
    if (l.dias !== N) f.push(k + ' dias: publicado ' + l.dias + ', o mes tem ' + N);
    if (l.ramp_up !== (rampSerie.has(l.mes) ? 1 : 0)) f.push(k + ' ramp_up: publicado ' + l.ramp_up + ', a serie mensal diz ' + (rampSerie.has(l.mes) ? 1 : 0));
    // o gerado contra a serie MENSAL (segunda rota: outro acumulador do gerador), em TODA linha
    const lm = meta[k].liquida_mwh;
    if (lm != null) { nMensal++; if (!perto(real, lm, tolMensal(N))) f.push(k + ' mensal: soma dos dias ' + real.toFixed(3) + ' x serie mensal ' + lm); }
    MARCOS.forEach((D) => {
      let ac = 0; for (let d = 1; d <= D; d++) ac += arr[d];
      const p = ac / D * N;
      chk('p' + D + '_mwh', p, TOL);
      chk('p' + D + '_pct', 100 * p / M, TOL);
      if (real > 0) chk('p' + D + '_erro_pct', 100 * (p - real) / real, TOL);
      if (l['p' + D + '_acertou'] !== (((p >= M) === (real >= M)) ? 1 : 0)) f.push(k + ' p' + D + '_acertou: publicado ' + l['p' + D + '_acertou']);
    });
  });
  if (nMensal !== nJulg) f.push('mensal: so ' + nMensal + ' de ' + nJulg + ' linhas comparadas com a serie mensal (campo liquida_mwh ausente)');

  // o resumo, refeito das linhas publicadas (fora o comissionamento): nem a mais, nem a menos
  const chavesA = new Set();
  A.forEach((a) => { const k = a.ufv + '|' + a.dia; if (chavesA.has(k)) f.push('resumo ' + k + ': repetido'); chavesA.add(k); });
  const ufvs = [...new Set(H.map((l) => l.ufv))], esperA = new Set();
  ufvs.forEach((u) => {
    const U = H.filter((l) => l.ufv === u && !l.ramp_up);
    if (!U.length) return;
    MARCOS.forEach((D) => {
      esperA.add(u + '|' + D);
      const a = A.find((x) => x.ufv === u && x.dia === D);
      if (!a) { f.push('resumo ' + u + '|' + D + ': ausente'); return; }
      const E = U.map((l) => l['p' + D + '_erro_pct']).filter((x) => x != null);
      if (a.n_meses !== U.length) f.push('resumo ' + u + '|' + D + ' n_meses: ' + a.n_meses + ', linhas ' + U.length);
      const ac = U.filter((l) => l['p' + D + '_acertou'] === 1).length;
      if (a.acertos !== ac) f.push('resumo ' + u + '|' + D + ' acertos: ' + a.acertos + ', refeito ' + ac);
      const ck = (campo, v) => { if (!perto(a[campo], v, TOL)) f.push('resumo ' + u + '|' + D + ' ' + campo + ': ' + a[campo] + ', refeito ' + Math.round(v * 1000) / 1000); };
      if (!E.length) { ['erro_abs_pct', 'vies_pct', 'pior_pct'].forEach((c) => { if (a[c] != null) f.push('resumo ' + u + '|' + D + ' ' + c + ': sem erro para medir, publicado ' + a[c]); }); return; }
      ck('erro_abs_pct', E.reduce((s, e) => s + Math.abs(e), 0) / E.length);
      ck('vies_pct', E.reduce((s, e) => s + e, 0) / E.length);
      ck('pior_pct', Math.max(...E.map(Math.abs)));
    });
  });
  A.forEach((a) => { if (!esperA.has(a.ufv + '|' + a.dia)) f.push('resumo ' + a.ufv + '|' + a.dia + ': sem linhas que o sustentem'); });
  if (!H.some((l) => l.ufv === 'Complexo')) f.push('o Complexo nao tem historico — o ensaio passaria sobre as usinas so');
  // uma expectativa que NAO depende da flag `parcial` (a lib e a segunda conta excluem pelo mesmo sinal): todo mes da serie
  // mensal do conjunto anterior ao atual, cujo ultimo dia ficou mais de 2 dias para tras (a liquidacao e D+1), tem linha
  // do Complexo no historico
  const hojeBRT = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const limite = new Date(Date.parse(hojeBRT + 'T00:00:00Z') - 2 * 86400e3).toISOString().slice(0, 10);
  (j.serie || []).map((s) => s.mes).filter((m) => m < j.mes_atual).forEach((m) => {
    const fim = m + '-' + String(diasNo(m)).padStart(2, '0');
    if (fim < limite && !H.some((l) => l.ufv === 'Complexo' && l.mes === m)) f.push('Complexo|' + m + ': mes antigo fora do historico (terminou em ' + fim + ')');
  });
  return f;
}

async function ensaioProduto() {
  const j = await getJSON('executivo.json');
  const f = julgaProduto(j);
  const H = j.historico_projecao || [];
  console.log('   ' + H.length + ' linhas · ' + new Set(H.map((l) => l.ufv)).size + ' entidades · meses ' +
    [...new Set(H.map((l) => l.mes))].sort().join(' '));
  if (!H.length) return f;
  const cpx = (p) => p.historico_projecao.find((x) => x.ufv === 'Complexo' && !x.ramp_up);
  const rampL = (p) => p.historico_projecao.find((x) => x.ramp_up === 1);
  // cada plantio declara o que TEM de aparecer entre os achados novos
  const plantios = [
    ['projecao do dia 15 do Complexo +0,01 MWh', (p) => { cpx(p).p15_mwh = Math.round((cpx(p).p15_mwh + 0.01) * 100) / 100; }, () => cpx(j).ufv + '|' + cpx(j).mes + ' p15_mwh'],
    ['ultima linha removida', (p) => { p.historico_projecao.pop(); }, () => { const l = H[H.length - 1]; return l.ufv + '|' + l.mes + ': mes liquidado'; }],
    ['linha repetida', (p) => { p.historico_projecao.push(JSON.parse(JSON.stringify(H[0]))); }, () => 'repetida'],
    ['acerto do dia 10 trocado', (p) => { cpx(p).p10_acertou = 1 - cpx(p).p10_acertou; }, () => cpx(j).ufv + '|' + cpx(j).mes + ' p10_acertou'],
    ['comissionamento desmarcado', (p) => { if (rampL(p)) rampL(p).ramp_up = 0; }, () => (rampL(j) ? rampL(j).ufv + '|' + rampL(j).mes + ' ramp_up' : 'SEM-LINHA-DE-COMISSIONAMENTO')],
    ['serie mensal sem liquida_mwh', (p) => { p.serie_ufv.forEach((x) => { x.liquida_mwh = null; }); }, () => 'mensal: so 0'],
    ['serie mensal do Complexo +0,5 MWh', (p) => { const c = cpx(j), s = p.serie_ufv.find((x) => x.ufv === c.ufv && x.mes === c.mes); s.liquida_mwh += 0.5; }, () => cpx(j).ufv + '|' + cpx(j).mes + ' mensal'],
    ['resumo do dia 20 com um acerto a mais', (p) => { p.historico_projecao_acerto.find((x) => x.ufv === 'Complexo' && x.dia === 20).acertos += 1; }, () => 'resumo Complexo|20 acertos'],
    ['vies do dia 5 trocado', (p) => { p.historico_projecao_acerto.find((x) => x.ufv === 'Complexo' && x.dia === 5).vies_pct += 1; }, () => 'resumo Complexo|5 vies_pct'],
    ['mes antigo sumido com um dia parcial', (p) => { const c = cpx(j);
      p.historico_projecao = p.historico_projecao.filter((x) => !(x.ufv === 'Complexo' && x.mes === c.mes));
      p.serie_dia_ufv.forEach((x) => { if (x.ufv === 'Complexo' && x.mes === c.mes && x.dia_num === 10) x.parcial = 1; }); },
      () => 'Complexo|' + cpx(j).mes + ': mes antigo fora do historico'],
    ['resumo de entidade inexistente', (p) => { p.historico_projecao_acerto.push({ ufv: 'M99', dia: 5, n_meses: 1, acertos: 1 }); }, () => 'resumo M99|5: sem linhas'],
  ];
  const base = new Set(f);
  plantios.forEach(([nome, fn, espera]) => {
    const p = JSON.parse(JSON.stringify(j)); fn(p);
    const novos = julgaProduto(p).filter((x) => !base.has(x)), alvo = espera(p);
    const ok = novos.some((x) => x.indexOf(alvo) >= 0);
    console.log('   plantio (' + nome + '): ' + novos.length + ' achado(s) novo(s)' + (ok ? '' : ' — NENHUM com "' + alvo + '"'));
    if (!ok) f.push('o plantio "' + nome + '" nao reprova pelo que plantou');
  });
  return f;
}

/* ----------------------------------------------------------- --registro ---- */
function julgaRegistro(j, R) {
  const f = [];
  const abertas0 = (j.manchete_ufv || []).filter((m) => m.fechado === 0 && m.dias_decorridos > 0);
  abertas0.forEach((m) => { if (m.liq_proj_mwh == null || !(m.meta_mwh > 0)) f.push(m.mes + '|' + m.dias_decorridos + '|' + m.ufv + ': linha de mes aberto sem projecao ou sem meta (o gravador nao a registra)'); });
  const abertas = abertas0.filter((m) => m.liq_proj_mwh != null && m.meta_mwh > 0);
  if (!R) return f.concat(abertas.length ? ['projecao_registro.json nao existe com ' + abertas.length + ' linha(s) de mes aberto na manchete'] : []);
  if (!Array.isArray(R.registro)) return f.concat(['projecao_registro.json sem a lista `registro`']);
  const vistos = new Set();
  R.registro.forEach((x) => {
    const k = x.mes + '|' + x.dias_fechados + '|' + x.ufv;
    if (vistos.has(k)) f.push(k + ': chave repetida'); vistos.add(k);
    const v = x.versoes || [];
    if (!v.length) f.push(k + ': sem versoes');
    else if (v[v.length - 1].proj_mwh !== x.proj_mwh || v[v.length - 1].meta_mwh !== x.meta_mwh) f.push(k + ': os campos de fora nao sao a ultima versao');
  });
  abertas.forEach((m) => {
    const k = m.mes + '|' + m.dias_decorridos + '|' + m.ufv, x = R.registro.find((y) => y.mes + '|' + y.dias_fechados + '|' + y.ufv === k);
    if (!x) f.push(k + ': a projecao publicada pela manchete nao esta no registro');
    else if (x.proj_mwh !== m.liq_proj_mwh) f.push(k + ': registro ' + x.proj_mwh + ', manchete ' + m.liq_proj_mwh);
  });
  return f;
}

async function ensaioRegistro() {
  const j = await getJSON('executivo.json'), R = await getJSON('projecao_registro.json', true);
  const f = julgaRegistro(j, R);
  const ab = (j.manchete_ufv || []).find((m) => m.ufv === 'Complexo' && m.fechado === 0);
  console.log('   registro: ' + (R ? (R.registro || []).length + ' entradas' : 'ainda nao existe') + ' · manchete do Complexo: ' +
    (ab ? ab.mes + ' com ' + ab.dias_decorridos + ' dias fechados' : 'sem mes aberto'));
  // CASOS forjados (o estado real pode nao ter mes aberto): o sadio passa, a chave de hoje ausente e a versao incoerente reprovam
  const jf = { manchete_ufv: [{ mes: '2026-10', ufv: 'Complexo', fechado: 0, dias_decorridos: 3, liq_proj_mwh: 62000, meta_mwh: 58000 }] };
  const Rf = { registro: [{ mes: '2026-10', ufv: 'Complexo', dias_fechados: 3, proj_mwh: 62000, meta_mwh: 58000, versoes: [{ proj_mwh: 62000, meta_mwh: 58000 }] }] };
  const casos = [
    ['forjado sadio', jf, Rf, false],
    ['chave de hoje ausente', jf, { registro: [] }, true],
    ['campos de fora diferentes da ultima versao', jf, { registro: [Object.assign({}, Rf.registro[0], { proj_mwh: 1 })] }, true],
    ['registro inexistente com mes aberto', jf, null, true],
    ['linha aberta da manchete sem projecao', { manchete_ufv: jf.manchete_ufv.concat([{ mes: '2026-10', ufv: 'M1', fechado: 0, dias_decorridos: 3, liq_proj_mwh: null, meta_mwh: 9000 }]) }, Rf, true],
  ];
  casos.forEach(([nome, jj, rr, deve]) => {
    const n = julgaRegistro(jj, rr).length;
    console.log('   caso (' + nome + '): ' + n + ' achado(s)');
    if ((n > 0) !== deve) f.push('o caso "' + nome + '" ' + (deve ? 'nao reprova' : 'reprova sem defeito'));
  });
  return f;
}

(async () => {
  const modo = process.argv[2];
  let f;
  if (modo === '--lib') { f = ensaioLib(); console.log('   11 casos forjados do historico, 9 do registro'); }
  else if (modo === '--produto') f = await ensaioProduto();
  else if (modo === '--registro') f = await ensaioRegistro();
  else { console.error('uso: node scripts/ensaio-historico-projecao.js --lib | --produto | --registro'); process.exit(2); }
  if (f.length) { f.slice(0, 40).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-historico-projecao ' + modo + ': TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
