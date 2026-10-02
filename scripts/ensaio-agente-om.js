'use strict';
/*
 * ensaio-agente-om.js — o resumo do assistente de voz (agente_om.json) diz o que a tela diz (01/10/2026).
 *
 * O gerador so SELECIONA campos publicados; o defeito plausivel e pegar o campo errado (a meta do mes no lugar da
 * rateada, o atingido de um campo e a energia de outro) ou perder uma entidade. Conferir o resumo contra o mesmo mapa
 * que o gerador usa seria checagem circular — entao a conferencia e por IDENTIDADE, independente do mapa:
 *   · atingido = 100 x energia / meta, com folga derivada do arredondamento (2 casas na energia e no percentual);
 *   · meta rateada <= meta do mes, e as duas so coincidem no ultimo dia;
 *   · capacidade do Complexo = 343,77 MW = soma das nove usinas = PPA + ML;
 *   · as 12 entidades em cada bloco, os meses fechados em ordem e todos anteriores ao mes em curso;
 *   · o ano so com meses fechados (o ultimo mes do ano nao pode ser o mes em curso).
 * PRODUTO · o resumo publicado passa (e tem o que julgar: vacuidade).
 * PLANTIO · cada defeito tem de reprovar com a mensagem dele: (1) meta do mes no lugar da rateada; (2) energia inflada;
 *   (3) entidade a menos (a guarda do gerador); (4) o mes em curso dentro dos fechados.
 *
 *   node scripts/ensaio-agente-om.js            (BASE_DADOS=<pasta> le uma rodada local; sem ela, o blob publico)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { guarda, ENTIDADES } = require('./gen-agente-om.js');

const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
function parse(buf) { return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }
function le(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(parse(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((res, rej) => https.get(BASE + nome, { headers: { 'Accept-Encoding': 'gzip' } }, (s) => {
    if (s.statusCode !== 200) return rej(new Error(nome + ': HTTP ' + s.statusCode));
    const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => { try { res(parse(Buffer.concat(b))); } catch (e) { rej(e); } });
  }).on('error', rej));
}
const copia = (o) => JSON.parse(JSON.stringify(o));
const USINAS = ENTIDADES.filter((e) => /^M\d$/.test(e));
const CAP_COMPLEXO = 343.77;
const EPS = 1e-9;

/* folga de 100 x E / D com E e D arredondados a 2 casas (meio centesimo cada) e o percentual a 2 casas */
const folgaPct = (E, D) => 0.005 + 100 * 0.005 * (1 / D + Math.abs(E) / (D * D)) + EPS;

function julga(R) {
  const mau = [];
  let julgados = 0;
  const pct = (rot, E, D, P) => {
    if (E == null || D == null || P == null || !(D > 0)) return;
    julgados++;
    const esp = 100 * E / D;
    if (Math.abs(esp - P) > folgaPct(E, D)) mau.push(rot + ': atingido ' + P + ' % contra 100 x ' + E + ' / ' + D + ' = ' + esp.toFixed(3) + ' %');
  };
  const blocos = [['agora', R.agora && R.agora.por_entidade], ['mes em curso', R.mes_em_curso && R.mes_em_curso.por_entidade],
    ['ano', R.ano && R.ano.por_entidade]];
  blocos.forEach(([n, o]) => ENTIDADES.forEach((e) => { if (!o || !o[e]) mau.push(n + ': sem ' + e); }));

  const C = (R.mes_em_curso || {}).por_entidade || {};
  for (const e of Object.keys(C)) {
    const x = C[e];
    pct('mes em curso ' + e + ' (rateada)', x.liquida_mwh, x.meta_rateada_mwh, x.atingido_rateada_pct);
    pct('mes em curso ' + e + ' (mes inteiro)', x.liquida_mwh, x.meta_mes_mwh, x.atingido_mes_pct);
    if (x.meta_rateada_mwh != null && x.meta_mes_mwh != null) {
      if (x.meta_rateada_mwh > x.meta_mes_mwh + 0.01) mau.push('mes em curso ' + e + ': meta rateada ' + x.meta_rateada_mwh + ' acima da meta do mes ' + x.meta_mes_mwh);
      const ultimo = R.mes_em_curso.fechado === true || R.mes_em_curso.dias_corridos === R.mes_em_curso.dias_do_mes;
      if (!ultimo && x.meta_mes_mwh > 0 && Math.abs(x.meta_rateada_mwh - x.meta_mes_mwh) <= 0.01)
        mau.push('mes em curso ' + e + ': meta rateada igual a do mes inteiro no dia ' + R.mes_em_curso.dias_corridos + ' de ' + R.mes_em_curso.dias_do_mes);
    }
  }
  (R.meses_fechados || []).forEach((m) => {
    if (m.mes >= R.mes_em_curso.mes) mau.push('meses fechados: ' + m.mes + ' nao e anterior ao mes em curso ' + R.mes_em_curso.mes);
    Object.entries(m.por_entidade || {}).forEach(([e, x]) => pct('mes ' + m.mes + ' ' + e, x.liquida_mwh, x.meta_mwh, x.atingido_pct));
  });
  const fe = (R.meses_fechados || []).map((m) => m.mes);
  if (fe.some((m, i) => i && m <= fe[i - 1])) mau.push('meses fechados fora de ordem: ' + fe.join(', '));
  /* o atingido do ANO sai do executivo em GWh: 100 x soma(liquida_gwh do mes) / soma(meta_gwh do mes), cada mes com 2 casas
     (10 MWh). Contra a energia em MWh a folga e a desses n arredondamentos de meio centesimo de GWh em cada soma (medido em
     01/10/2026: M7 57,68 % publicado contra 57,757 % refeito do MWh, folga derivada 0,28 pp). */
  Object.entries((R.ano || {}).por_entidade || {}).forEach(([e, x]) => {
    if (x.liquida_mwh == null || !(x.meta_mwh > 0) || x.atingido_pct == null) return;
    julgados++;
    const Lg = x.liquida_mwh / 1000, Mg = x.meta_mwh / 1000, n = x.meses_com_meta || x.meses || 1;
    const tol = 0.005 + 100 * n * 0.005 * (1 / Mg + Math.abs(Lg) / (Mg * Mg)) + EPS;
    const esp = 100 * Lg / Mg;
    if (Math.abs(esp - x.atingido_pct) > tol) mau.push('ano ' + e + ': atingido ' + x.atingido_pct + ' % contra 100 x ' + x.liquida_mwh + ' / ' + x.meta_mwh + ' = ' + esp.toFixed(3) + ' %');
  });
  if (R.ano && R.mes_em_curso && R.mes_em_curso.fechado !== true && R.ano.meses_fechados_ate && R.ano.meses_fechados_ate === R.mes_em_curso.lbl)
    mau.push('ano: vai ate ' + R.ano.meses_fechados_ate + ', que e o mes em curso');

  const A = (R.agora || {}).por_entidade || {};
  if (A.Complexo) {
    const cap = (e) => (A[e] ? A[e].cap_mw : NaN);
    if (Math.abs(cap('Complexo') - CAP_COMPLEXO) > 0.001) mau.push('agora: capacidade do Complexo ' + cap('Complexo') + ' MW, nao ' + CAP_COMPLEXO);
    const su = USINAS.reduce((a, u) => a + cap(u), 0);
    if (!(Math.abs(su - CAP_COMPLEXO) <= 0.001)) mau.push('agora: as usinas somam ' + su.toFixed(3) + ' MW de capacidade, nao ' + CAP_COMPLEXO);
    if (!(Math.abs(cap('PPA') + cap('ML') - CAP_COMPLEXO) <= 0.001)) mau.push('agora: PPA + ML somam ' + (cap('PPA') + cap('ML')).toFixed(3) + ' MW, nao ' + CAP_COMPLEXO);
  }
  /* CORTE: corte_pct = 100 x cortado / potencial (dia e mes); as usinas somam o conjunto no mes; vantagem = Nordeste - Mauriti */
  const K = R.corte;
  if (!K) mau.push('corte: bloco ausente');
  else {
    (K.ultimos_dias || []).forEach((d) => Object.entries(d.por_usina || {}).forEach(([u, x]) =>
      pct('corte ' + d.dia + ' ' + u, x.cortado_mwh, x.potencial_mwh, x.corte_pct)));
    (K.meses || []).forEach((m) => {
      /* o mes vai sem percentual (ver o gerador): o que se exige e que ele NAO volte sem a guarda que o justifique */
      Object.entries(m.por_entidade || {}).forEach(([e, x]) => {
        if ('corte_pct' in x) mau.push('corte ' + m.mes + ' ' + e + ': percentual do mes publicado de novo (no Complexo ele nao fecha com o par em MWh)');
        if (x.cortado_mwh != null && x.potencial_mwh != null && x.cortado_mwh > x.potencial_mwh + 0.01) mau.push('corte ' + m.mes + ' ' + e + ': cortado acima do potencial');
      });
      const P = m.por_entidade || {};
      if (P.Complexo && P.Complexo.cortado_mwh != null && USINAS.every((u) => P[u] && P[u].cortado_mwh != null)) {
        const s = USINAS.reduce((a, u) => a + P[u].cortado_mwh, 0);
        if (Math.abs(s - P.Complexo.cortado_mwh) > 0.011 * USINAS.length) mau.push('corte ' + m.mes + ': usinas somam ' + s.toFixed(2) + ' MWh contra ' + P.Complexo.cortado_mwh + ' do conjunto');
      }
    });
    const C0 = ((K.ano || {}).por_entidade || {}).Complexo;
    if (C0 && C0.nordeste_pct != null && C0.corte_pct != null && C0.vantagem_pp != null
      && Math.abs((C0.nordeste_pct - C0.corte_pct) - C0.vantagem_pp) > 0.011)
      mau.push('corte do ano: vantagem ' + C0.vantagem_pp + ' pp contra Nordeste ' + C0.nordeste_pct + ' - Mauriti ' + C0.corte_pct);
    if (!(K.ultimos_dias || []).length || !(K.meses || []).length) mau.push('VACUO: corte sem dias ou sem meses');
  }
  if (julgados < 12) mau.push('VACUO: so ' + julgados + ' percentuais julgados');
  return mau;
}

(async () => {
  const falhas = [];
  const R = await le('agente_om.json');
  const base = julga(R).concat(guarda(R).mau);
  base.forEach((m) => falhas.push('PRODUTO: ' + m));
  console.log('  produto: ' + Object.keys(R.mes_em_curso.por_entidade).length + ' entidades no mes ' + R.mes_em_curso.lbl + ', '
    + R.meses_fechados.length + ' meses fechados, ano ate ' + R.ano.meses_fechados_ate + ', ' + (Buffer.byteLength(JSON.stringify(R)) / 1024).toFixed(1)
    + ' KB · ' + (base.length ? base.length + ' achado(s)' : 'fecha'));

  const plantio = (nome, muda, esperado) => {
    const Y = copia(R);
    const ok = muda(Y);
    if (ok === 'pula') { console.log('  plantio "' + nome + '": nao se aplica hoje (ultimo dia do mes: as duas metas coincidem)'); return; }
    if (!ok) { falhas.push('plantio "' + nome + '" nao achou onde plantar'); return; }
    if (JSON.stringify(Y) === JSON.stringify(R)) { falhas.push('plantio "' + nome + '" nao mudou nada'); return; }
    const novos = julga(Y).concat(guarda(Y).mau).filter((m) => !base.includes(m));
    if (!novos.length) falhas.push('plantio "' + nome + '" NAO reprovou');
    else if (!novos.some((m) => esperado.test(m))) falhas.push('plantio "' + nome + '" reprovou pelo motivo errado: ' + novos[0]);
    else console.log('  plantio "' + nome + '": reprovou · ' + novos.find((m) => esperado.test(m)).slice(0, 100));
  };
  plantio('meta do mes no lugar da rateada', (Y) => {
    if (Y.mes_em_curso.fechado === true || Y.mes_em_curso.dias_corridos === Y.mes_em_curso.dias_do_mes) return 'pula';   /* no ultimo dia (ou mes ja fechado) as duas coincidem */
    Object.values(Y.mes_em_curso.por_entidade).forEach((x) => { x.meta_rateada_mwh = x.meta_mes_mwh; }); return true;
  }, /meta rateada igual|rateada\)/);
  plantio('energia do ano inflada', (Y) => { const x = Y.ano.por_entidade.M5; if (!x) return false; x.liquida_mwh = Math.round((x.liquida_mwh * 1.02) * 100) / 100; return true; },
    /ano M5: atingido/);
  plantio('entidade a menos', (Y) => { delete Y.mes_em_curso.por_entidade.ML; return true; }, /mes em curso: sem ML/);
  plantio('mes em curso dentro dos fechados', (Y) => {
    const x = copia(Y.meses_fechados[Y.meses_fechados.length - 1]); x.mes = Y.mes_em_curso.mes; Y.meses_fechados.push(x); return true;
  }, /nao e anterior ao mes em curso/);
  plantio('corte de um dia trocado entre usinas', (Y) => {
    const d = Y.corte.ultimos_dias.find((q) => q.por_usina.M5 && q.por_usina.M1 && q.por_usina.M5.cortado_mwh > 1 && Math.abs(q.por_usina.M5.corte_pct - q.por_usina.M1.corte_pct) > 1);
    if (!d) return false; const t = d.por_usina.M5.corte_pct; d.por_usina.M5.corte_pct = d.por_usina.M1.corte_pct; d.por_usina.M1.corte_pct = t; return true;
  }, /corte \d{4}-\d{2}-\d{2} M[15]: atingido/);
  plantio('vantagem sobre o Nordeste com o sinal trocado', (Y) => {
    const c = Y.corte.ano.por_entidade.Complexo; if (!c || !c.vantagem_pp) return false; c.vantagem_pp = -c.vantagem_pp; return true;
  }, /vantagem/);
  plantio('capacidade de uma usina trocada', (Y) => { Y.agora.por_entidade.M9.cap_mw = 14.733; return true; }, /usinas somam/);

  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-agente-om: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
