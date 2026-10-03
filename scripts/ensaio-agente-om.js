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
      /* o percentual do mes vai em toda entidade com o par, e tem de fechar com o par em MWh da propria linha (o executivo
         ja para se nao fechar; aqui se confere o que chegou ao resumo) */
      Object.entries(m.por_entidade || {}).forEach(([e, x]) => {
        if (x.potencial_mwh > 0 && x.cortado_mwh != null && !(x.corte_pct != null)) mau.push('corte ' + m.mes + ' ' + e + ': sem o percentual do mes');
        pct('corte ' + m.mes + ' ' + e, x.cortado_mwh, x.potencial_mwh, x.corte_pct);
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
  /* TEMPO REAL: identidades dentro do bloco e contra o "agora" do mesmo resumo */
  const T = R.tempo_real;
  if (!T) mau.push('tempo real: bloco ausente');
  else {
    const md = T.medidores;
    if (md.ok + md.fora.length !== md.total) mau.push('tempo real: ' + md.ok + ' medidores em dia + ' + md.fora.length + ' fora nao somam ' + md.total);
    const CAP = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };
    T.rendimento.por_usina.forEach((r) => {
      if (!CAP[r.ufv]) { mau.push('tempo real: rendimento de usina desconhecida ' + r.ufv); return; }
      /* mwh com 1 casa e mwh_por_mw com 3: folga de meio decimo sobre a capacidade mais meio milesimo */
      if (Math.abs(r.mwh / CAP[r.ufv] - r.mwh_por_mw) > 0.0005 + 0.05 / CAP[r.ufv] + EPS) mau.push('tempo real: rendimento ' + r.ufv + ' ' + r.mwh_por_mw + ' MWh/MW contra ' + r.mwh + ' / ' + CAP[r.ufv]);
      const a = ((R.agora || {}).por_entidade || {})[r.ufv];
      /* os dois com 1 casa, de somas diferentes do mesmo medidor: dois arredondamentos de meio decimo (medido: 0,1 no M6).
         IGUAIS so no mesmo horizonte: o rendimento vai ate o ultimo instante que TODOS os circuitos mediram, e o agora da
         usina ate o ultimo dela. Com um medidor atrasado (16:40 x 16:50 em 03/10/2026, o way2-recent ficou vermelho por
         isso) o rendimento cobre menos instantes e so nao pode passar do agora. */
      if (a && a.energia_hoje_mwh != null) {
        const mesmo = a.hora == null || a.hora === T.rendimento.ate;
        if (mesmo ? Math.abs(a.energia_hoje_mwh - r.mwh) > 0.1 + 1e-6 : r.mwh > a.energia_hoje_mwh + 0.1 + 1e-6)
          mau.push('tempo real: rendimento ' + r.ufv + ' ' + r.mwh + ' MWh contra ' + a.energia_hoje_mwh + ' do agora'
            + (mesmo ? '' : ' (ate ' + T.rendimento.ate + ' x ' + a.hora + ': o rendimento cobre menos instantes e passou do agora)'));
      }
    });
    /* o instante publicado tem de ter leitura do conjunto (o intervalo vazio do fim da serie nao e "agora") */
    if (T.must.instante && T.must.por_parque.Complexo && T.must.por_parque.Complexo.agora_mw == null) mau.push('tempo real: MUST no instante ' + T.must.instante + ' sem leitura do Complexo');
    Object.entries(T.must.por_parque || {}).forEach(([p, x]) => {
      if (x.agora_mw != null && x.pico_hoje_mw != null && x.pico_hoje_mw + EPS < x.agora_mw) mau.push('tempo real: MUST ' + p + ' pico ' + x.pico_hoje_mw + ' abaixo do agora ' + x.agora_mw);
      if (!(T.must.contratos_mw || {})[p]) mau.push('tempo real: MUST ' + p + ' sem contratado');
    });
    const o = T.operador.ultima_ordem;
    if (o && (o.limite_mw > CAP_COMPLEXO + 0.01 || (!o.limitado && o.limite_mw < CAP_COMPLEXO - 0.01))) mau.push('tempo real: ultima ordem ' + o.limite_mw + ' MW incoerente com limitado=' + o.limitado);
    T.fontes.selos.forEach((s) => { if (s.estado === 'sem estado') mau.push('tempo real: selo "' + s.item + '" sem estado conhecido'); });
    if (!T.rendimento.por_usina.length || !T.fontes.selos.length) mau.push('VACUO: tempo real sem rendimento ou sem selos');
  }
  /* ATIVOS: identidades de cada familia */
  const AT = R.ativos;
  if (!AT) mau.push('ativos: bloco ausente');
  else {
    Object.entries(AT.inversores_dia.por_usina || {}).forEach(([u, x]) => {
      if (x.parados + x.parciais > x.inversores) mau.push('ativos: ' + u + ' com ' + (x.parados + x.parciais) + ' parados/parciais em ' + x.inversores + ' inversores');
      if (x.disp_pct > 100 + EPS) mau.push('ativos: disponibilidade do ' + u + ' acima de 100 %');
    });
    AT.abaixo_dos_pares.lista.forEach((r) => { if (r.razao_min > r.razao_mediana + EPS) mau.push('ativos: ' + r.inversor + ' com razao minima ' + r.razao_min + ' acima da mediana ' + r.razao_mediana); });
    const tr = AT.trocas;
    if (tr.termicas > tr.total) mau.push('ativos: ' + tr.termicas + ' trocas termicas em ' + tr.total);
    if (tr.total > 0 && Math.abs(100 * tr.termicas / tr.total - tr.termicas_pct) > 0.05 + EPS) mau.push('ativos: termicas ' + tr.termicas_pct + ' % contra 100 x ' + tr.termicas + ' / ' + tr.total);
    const sm = (tr.modos || []).reduce((a, m) => a + m.n, 0);
    if (sm > tr.total) mau.push('ativos: modos de falha somam ' + sm + ' em ' + tr.total + ' trocas');
    const al = AT.alarmes;
    if ((al.falha_inversor || 0) + (al.rede || 0) + (al.aviso || 0) > al.eventos) mau.push('ativos: classes de alarme somam mais que os ' + al.eventos + ' eventos');
    const ref = AT.transformadores.referencia_mva;
    Object.entries(AT.transformadores.por_trafo || {}).forEach(([k, x]) => {
      if (ref > 0 && x.s_max_mva != null && Math.abs(100 * x.s_max_mva / ref - x.carga_max_pct) > 0.005 + 100 * 0.005 / ref + EPS)
        mau.push('ativos: ' + k + ' carga ' + x.carga_max_pct + ' % contra 100 x ' + x.s_max_mva + ' / ' + ref);
      /* fisica: imagem termica do enrolamento = topo do oleo + gradiente; publicado abaixo do oleo e afirmar o impossivel */
      if (x.t_oleo_max_c != null && x.t_enrolamento_max_c != null && x.t_enrolamento_max_c + EPS < x.t_oleo_max_c)
        mau.push('ativos: ' + k + ' enrolamento ' + x.t_enrolamento_max_c + ' °C publicado abaixo do oleo ' + x.t_oleo_max_c + ' °C');
      if (x.temperatura_em_verificacao && (x.t_oleo_max_c != null || x.t_enrolamento_max_c != null))
        mau.push('ativos: ' + k + ' em verificacao e ainda publicando temperatura');
    });
    const ol = AT.oleo;
    if (ol.pior_uso_pct != null && ol.pior_margem_pct != null && Math.abs(ol.pior_uso_pct + ol.pior_margem_pct - 100) > 0.05 + EPS) mau.push('ativos: oleo uso ' + ol.pior_uso_pct + ' + margem ' + ol.pior_margem_pct + ' nao fecha 100');
    if (ol.conforme === true && ol.nao_conformes > 0) mau.push('ativos: oleo conforme com ' + ol.nao_conformes + ' laudos nao conformes');
  }
  /* DESEMPENHO: o PR e refeito pela energia e pela irradiacao publicadas no proprio mes (a conta nao e circular: o
     resumo copia o pr_pct do pr.json e a energia/irradiacao do mesmo mes, e a razao entre elas tem de fechar) */
  const DS = R.desempenho;
  if (!DS) mau.push('desempenho: bloco ausente');
  else {
    const pcc = DS.pr.p_cc_mwp;
    let refeitos = 0;
    DS.pr.meses.forEach((m) => {
      if (m.dias_validos > m.dias_no_mes) mau.push('desempenho: ' + m.mes + ' com ' + m.dias_validos + ' dias validos em ' + m.dias_no_mes);
      if (m.pr_pct != null && m.pr_corrigido_pct != null && m.pr_corrigido_pct + EPS < m.pr_pct) mau.push('desempenho: ' + m.mes + ' PR corrigido ' + m.pr_corrigido_pct + ' abaixo do bruto ' + m.pr_pct);
      if (m.pr_pct != null && pcc > 0 && m.h_kwh_m2 > 0 && m.inj_mwh > 0) {
        const pr = 100 * m.inj_mwh / (pcc * m.h_kwh_m2);   /* MWh / (MWp x kWh/m2 / 1 kW/m2) */
        /* pr com 2 casas, energia com 1, irradiacao com 2: folga dos tres arredondamentos */
        if (Math.abs(pr - m.pr_pct) > 0.005 + pr * (0.05 / m.inj_mwh + 0.005 / m.h_kwh_m2) + EPS) mau.push('desempenho: conjunto ' + m.mes + ' PR ' + m.pr_pct + ' contra 100 x ' + m.inj_mwh + ' / (' + pcc + ' x ' + m.h_kwh_m2 + ') = ' + pr.toFixed(3));
        refeitos++;
      }
    });
    Object.entries(DS.pr.por_entidade).forEach(([e, L]) => L.forEach((m) => {
      if (m.pr_pct != null && m.pr_corrigido_pct != null && m.pr_corrigido_pct + EPS < m.pr_pct) mau.push('desempenho: ' + e + ' ' + m.mes + ' PR corrigido ' + m.pr_corrigido_pct + ' abaixo do bruto ' + m.pr_pct);
      if (m.pr_pct != null && m.den_mwh > 0 && m.inj_mwh > 0) {
        const pr = 100 * m.inj_mwh / m.den_mwh;
        if (Math.abs(pr - m.pr_pct) > 0.005 + pr * (0.05 / m.inj_mwh + 0.05 / m.den_mwh) + EPS) mau.push('desempenho: ' + e + ' ' + m.mes + ' PR ' + m.pr_pct + ' contra 100 x ' + m.inj_mwh + ' / ' + m.den_mwh + ' = ' + pr.toFixed(3));
        refeitos++;
      }
    }));
    DS.disponibilidade.meses.forEach((m) => { if (m.declarada_pct != null && m.declarada_pct > 100 + EPS) mau.push('desempenho: disponibilidade declarada de ' + m.mes + ' acima de 100 %'); });
    Object.entries(DS.disponibilidade.inversores).forEach(([e, L]) => L.forEach((m) => {
      if (m.pct > 100 + EPS) mau.push('desempenho: disponibilidade dos inversores do ' + e + ' em ' + m.mes + ' acima de 100 %');
      if (m.dias > 31) mau.push('desempenho: ' + e + ' ' + m.mes + ' com ' + m.dias + ' dias');
    }));
    if (refeitos < 20) mau.push('VACUO: so ' + refeitos + ' PR refeitos');
  }
  if (julgados < 12) mau.push('VACUO: so ' + julgados + ' percentuais julgados');
  /* a legenda e texto publico: ultrapassagem do MUST nao e "transitorio de medicao" (afirmacao sem fonte que minimiza a
     ultrapassagem; saiu do assistente na v3 e da legenda em 03/10/2026) */
  if (/transit[oó]ri|transient/i.test(JSON.stringify(R.legenda || {}))) mau.push('legenda: chama a ultrapassagem do MUST de transitorio');
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
    if (typeof ok === 'string' && ok.indexOf('pula: ') === 0) { console.log('  plantio "' + nome + '": nao se aplica agora (' + ok.slice(6) + ')'); return; }
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
  /* TROCA ENTRE USINAS pelo PAR DE MAIOR DIFERENCA, nunca por um par fixo (PROMOVER ensaio-par-extremo, 03/10/2026): o par
     fixo depende do dado do momento, e o do rendimento (M2 x M9) recusou o way2-recent as 16:30 de 03/10 por estarem a
     0,02 MWh/MW. `grupos` e uma lista de [rotulo, {usina: objeto}]; troca o campo `f` entre o menor e o maior valor do grupo
     com a maior amplitude. Se nem esse par passa de `minimo`, o caso nao se aplica agora e o ensaio diz por que. */
  const trocaExtremos = (grupos, f, minimo, unidade) => {
    let melhor = null;
    for (const [rot, por] of grupos) {
      const v = Object.entries(por || {}).filter(([u, x]) => /^M\d$/.test(u) && x && x[f] != null).sort((p, q) => p[1][f] - q[1][f]);
      if (v.length < 2) continue;
      const amp = v[v.length - 1][1][f] - v[0][1][f];
      if (!melhor || amp > melhor.amp) melhor = { rot, amp, a: v[0][1], b: v[v.length - 1][1] };
    }
    if (!melhor) return false;
    if (melhor.amp < minimo) return 'pula: a maior diferenca entre usinas e ' + melhor.amp.toFixed(3) + ' ' + unidade + ', abaixo de ' + minimo;
    const t = melhor.a[f]; melhor.a[f] = melhor.b[f]; melhor.b[f] = t; return true;
  };
  plantio('corte de um dia trocado entre usinas', (Y) => trocaExtremos(Y.corte.ultimos_dias.map((q) =>
    [q.dia, Object.fromEntries(Object.entries(q.por_usina).filter(([, x]) => x.cortado_mwh > 1))]), 'corte_pct', 1, 'pp'),
  /corte \d{4}-\d{2}-\d{2} M\d: atingido/);
  /* o percentual do Complexo no mes (PROMOVER agente-corte-complexo): a base antiga do potencial (com o M7 estimado,
     ~3 GWh a mais) dava outro numero; o percentual publicado numa usina; o percentual do Complexo sumido */
  const mesComCorte = (Y) => (Y.corte.meses || []).find((m) => m.por_entidade.Complexo && m.por_entidade.Complexo.potencial_mwh > 0
    && m.por_entidade.Complexo.cortado_mwh > 1000);
  plantio('percentual do Complexo no mes sobre o potencial de outra base', (Y) => {
    const m = mesComCorte(Y); if (!m) return false; const x = m.por_entidade.Complexo;
    x.corte_pct = Math.round(10000 * x.cortado_mwh / (x.potencial_mwh + 3000)) / 100; return true;
  }, /corte \d{4}-\d{2} Complexo/);
  /* nas usinas (PROMOVER agente-corte-ufv): o percentual do mes trocado entre duas usinas, e o de uma usina apagado */
  plantio('percentual do mes trocado entre usinas', (Y) => trocaExtremos((Y.corte.meses || []).map((m) => [m.mes, m.por_entidade]), 'corte_pct', 1, 'pp'),
    /corte \d{4}-\d{2} M\d:/);
  plantio('percentual do mes de uma usina apagado', (Y) => {
    const m = mesComCorte(Y); if (!m || !m.por_entidade.M1) return false; delete m.por_entidade.M1.corte_pct; return true;
  }, /M1: sem o percentual do mes/);
  plantio('percentual do Complexo no mes sumido', (Y) => {
    const m = mesComCorte(Y); if (!m) return false; delete m.por_entidade.Complexo.corte_pct; return true;
  }, /Complexo: sem o percentual do mes/);
  plantio('vantagem sobre o Nordeste com o sinal trocado', (Y) => {
    const c = Y.corte.ano.por_entidade.Complexo; if (!c || !c.vantagem_pp) return false; c.vantagem_pp = -c.vantagem_pp; return true;
  }, /vantagem/);
  plantio('medidor fora escondido', (Y) => { Y.tempo_real.medidores.ok -= 1; return true; }, /medidores em dia/);
  /* o PAR de maior diferenca no rendimento de hoje, e nao M2 x M9 fixos: as 16:30 de 03/10/2026 os dois estavam a 0,02 MWh/MW
     um do outro e o plantio recusou o job. De madrugada todas estao em zero: ai o caso nao se aplica, e o ensaio diz por que */
  /* rendimento contra o agora (PROMOVER ensaio-par-extremo): no mesmo horizonte tem de ser igual; atrasado, nao pode passar */
  const infla = (Y, mesmo) => { const T = Y.tempo_real.rendimento, r = T.por_usina.find((x) => x.ufv === 'M5'), a = Y.agora.por_entidade.M5;
    if (!r || !a || !T.ate) return false; a.hora = mesmo ? T.ate : '23:59';
    r.mwh = Math.round((a.energia_hoje_mwh + 2) * 10) / 10; r.mwh_por_mw = Math.round(1000 * r.mwh / 49.11) / 1000; return true; };
  plantio('rendimento diferente do agora no mesmo horizonte', (Y) => infla(Y, true), /rendimento M5 [\d.]+ MWh contra [\d.]+ do agora$/);
  plantio('rendimento atrasado passando do agora', (Y) => infla(Y, false), /rendimento M5 .* passou do agora/);
  plantio('rendimento trocado entre usinas', (Y) => trocaExtremos([['hoje',
    Object.fromEntries(Y.tempo_real.rendimento.por_usina.map((x) => [x.ufv, x]))]], 'mwh_por_mw', 0.05, 'MWh/MW (madrugada?)'),
  /rendimento M\d /);
  /* plantios que NAO dependem do estado da hora: pico x instante e carga x potencia valem com qualquer leitura */
  plantio('pico do MUST abaixo do instante', (Y) => {
    const x = Y.tempo_real.must.por_parque.Complexo; if (!x || x.pico_hoje_mw == null) return false; x.agora_mw = x.pico_hoje_mw + 1; return true;
  }, /MUST Complexo pico/);
  plantio('MUST no intervalo vazio do fim da serie', (Y) => {
    const x = Y.tempo_real.must.por_parque.Complexo; if (!x || !Y.tempo_real.must.instante) return false; x.agora_mw = null; return true;
  }, /sem leitura do Complexo/);
  plantio('carga de transformador descolada da potencia', (Y) => {
    const a = (((Y.ativos || {}).transformadores || {}).por_trafo || {})['04T1']; if (!a || a.carga_max_pct == null) return false; a.carga_max_pct = Math.round((a.carga_max_pct + 5) * 100) / 100; return true;
  }, /04T1 carga/);
  plantio('enrolamento publicado abaixo do oleo', (Y) => {
    const a = (((Y.ativos || {}).transformadores || {}).por_trafo || {})['04T2']; if (!a) return false;
    delete a.temperatura_em_verificacao; a.t_oleo_max_c = 78.3; a.t_enrolamento_max_c = 59.46; return true;
  }, /enrolamento .* abaixo do oleo/);
  plantio('em verificacao e ainda publicando temperatura', (Y) => {
    const a = (((Y.ativos || {}).transformadores || {}).por_trafo || {})['04T2']; if (!a) return false;
    a.temperatura_em_verificacao = true; a.t_oleo_max_c = 60; return true;
  }, /em verificacao e ainda publicando/);
  plantio('legenda que chama a ultrapassagem de transitorio', (Y) => { if (!Y.legenda) return false; Y.legenda.tempo_real += ' o pico de 5 min passa da outorga por transitorio de medicao'; return true; }, /legenda: chama/);
  plantio('PR do conjunto inflado', (Y) => {
    const m = ((Y.desempenho || {}).pr || { meses: [] }).meses.filter((q) => q.pr_pct != null).slice(-2)[0]; if (!m) return false;
    m.pr_pct = Math.round((m.pr_pct + 3) * 100) / 100; return true;
  }, /desempenho: conjunto .* PR/);
  /* o mes de cada usina e o PENULTIMO da lista (o ultimo pode ser o em curso), como antes; o par e o de maior diferenca */
  plantio('PR trocado entre usinas', (Y) => {
    const E = ((Y.desempenho || {}).pr || {}).por_entidade || {};
    return trocaExtremos([['penultimo mes', Object.fromEntries(Object.entries(E).map(([u, L]) => [u, (L || []).slice(-2)[0]]))]], 'pr_pct', 1, 'pp');
  }, /desempenho: M\d .* PR /);
  plantio('PR corrigido abaixo do bruto', (Y) => {
    const m = ((Y.desempenho || {}).pr || { meses: [] }).meses.find((q) => q.pr_pct != null && q.pr_corrigido_pct != null); if (!m) return false;
    m.pr_corrigido_pct = Math.round((m.pr_pct - 2) * 100) / 100; return true;
  }, /corrigido .* abaixo do bruto/);
  plantio('disponibilidade dos inversores acima de 100', (Y) => {
    const L = (((Y.desempenho || {}).disponibilidade || {}).inversores || {}).M5; if (!L || !L.length) return false; L[0].pct = 100.6; return true;
  }, /disponibilidade dos inversores do M5/);
  plantio('trocas termicas inflada',(Y) => { if (!Y.ativos) return false; Y.ativos.trocas.termicas += 10; return true; }, /termicas/);
  plantio('oleo conforme com laudo nao conforme', (Y) => { if (!Y.ativos || Y.ativos.oleo.conforme !== true) return false; Y.ativos.oleo.nao_conformes = 1; return true; }, /oleo conforme/);
  plantio('capacidade de uma usina trocada', (Y) => { Y.agora.por_entidade.M9.cap_mw = 14.733; return true; }, /usinas somam/);

  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-agente-om: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
