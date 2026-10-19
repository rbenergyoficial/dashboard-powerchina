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
 * CASOS DO RENDIMENTO (19/10/2026): um dia forjado com buraco no meio e outro com buraco na ponta, montados pela lib do
 *   portal_vivo e pelo gerador; valores a mao; plantios com a regra de antes de cada lado (ver casosRendimento).
 *
 *   node scripts/ensaio-agente-om.js            (BASE_DADOS=<pasta> le uma rodada local; sem ela, o blob publico)
 */
const fs = require('fs');
const path = require('path');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const zlib = require('zlib');
const GA = require('./gen-agente-om.js');
const { guarda, ENTIDADES } = GA;
/* a lib do portal_vivo, para os casos forjados do rendimento (LIBPV aponta outra versao: a do HEAD reprova o caso do meio) */
const LV = require(process.env.LIBPV || './lib/portal-vivo.js');

const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
function parse(buf) { return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }
function le(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(parse(fs.readFileSync(path.join(BASE, nome))));
  /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); como antes, toda resposta que nao e 200 reprova, o 404 tambem */
  return LD.pede(BASE + nome, { 'Accept-Encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error(nome + ': HTTP ' + x.status);
    return parse(x.buf);
  });
}
const copia = (o) => JSON.parse(JSON.stringify(o));
const USINAS = ENTIDADES.filter((e) => /^M\d$/.test(e));
const CAP_COMPLEXO = 343.77;
const EPS = 1e-9;

/* folga de 100 x E / D com E e D arredondados a 2 casas (meio centesimo cada) e o percentual a 2 casas */
const folgaPct = (E, D) => 0.005 + 100 * 0.005 * (1 / D + Math.abs(E) / (D * D)) + EPS;

function julga(R, cont) {
  cont = cont || {};
  cont.rend_mesmo = 0; cont.rend_atrasado = 0;
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
  /* o atingido do ANO e a razao das somas em MWh desde 03/10/2026 (PROMOVER ating-ano-mwh). Antes saia das somas em GWh, cada
     mes a 10 MWh, e a folga aqui era a de n arredondamentos de meio centesimo de GWh (M7 57,68 x 57,757 %, folga 0,28 pp).
     Agora a folga e a do percentual a 2 casas e dos dois MWh a centesimos. */
  Object.entries((R.ano || {}).por_entidade || {}).forEach(([e, x]) => {
    if (x.liquida_mwh == null || !(x.meta_mwh > 0) || x.atingido_pct == null) return;
    julgados++;
    const tol = folgaPct(x.liquida_mwh, x.meta_mwh);
    const esp = 100 * x.liquida_mwh / x.meta_mwh;
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
      /* o rendimento (1 casa) e a energia do agora (2 casas) saem da MESMA conta, a energia lida da lib do portal_vivo, cada
         um ate o seu horizonte (lote rendimento-lida, 19/10/2026): no mesmo horizonte a diferenca e so a dos dois
         arredondamentos, meio decimo mais meio centesimo (era 0,1 quando os dois tinham 1 casa).
         O HORIZONTE da energia do agora e `energia_ate`, nao a `hora` da usina: com um circuito atrasado a energia vai ate o
         ultimo instante lido e a `hora` fica no ultimo em que TODOS leram. Julgado pela `hora`, o agora de 19/10/2026 as 15:45
         (M8 com hora 15:30 e energia ate 15:40) parecia "mesmo horizonte" e o way2-recent ficou vermelho duas vezes. Resumo
         sem `energia_ate` (o de antes) cai na `hora`, como antes. Fora do mesmo horizonte (16:40 x 16:50 em 03/10/2026) o
         rendimento cobre menos instantes e so nao pode passar do agora. */
      if (a && a.energia_hoje_mwh != null) {
        const ha = a.energia_ate != null ? a.energia_ate : a.hora;
        /* o horizonte da energia nunca fica antes do comum aos 22 (todos leram ate la) nem antes da hora da propria usina */
        if (a.energia_ate != null && T.rendimento.ate && a.energia_ate < T.rendimento.ate)
          mau.push('tempo real: energia do ' + r.ufv + ' ate ' + a.energia_ate + ', antes do horizonte comum ' + T.rendimento.ate);
        if (a.energia_ate != null && a.hora != null && a.energia_ate < a.hora)
          mau.push('tempo real: energia do ' + r.ufv + ' ate ' + a.energia_ate + ', antes da hora da usina ' + a.hora);
        const mesmo = ha == null || ha === T.rendimento.ate;
        if (mesmo) cont.rend_mesmo++; else cont.rend_atrasado++;
        if (mesmo ? Math.abs(a.energia_hoje_mwh - r.mwh) > 0.05 + 0.005 + 1e-6 : r.mwh > a.energia_hoje_mwh + 0.1 + 1e-6)
          mau.push('tempo real: rendimento ' + r.ufv + ' ' + r.mwh + ' MWh contra ' + a.energia_hoje_mwh + ' do agora'
            + (mesmo ? '' : ' (ate ' + T.rendimento.ate + ' x ' + ha + ': o rendimento cobre menos instantes e passou do agora)'));
      }
    });
    /* o instante publicado tem de ter leitura do conjunto (o intervalo vazio do fim da serie nao e "agora") */
    if (T.must.instante && T.must.por_parque.Complexo && T.must.por_parque.Complexo.agora_mw == null) mau.push('tempo real: MUST no instante ' + T.must.instante + ' sem leitura do Complexo');
    Object.entries(T.must.por_parque || {}).forEach(([p, x]) => {
      if (x.agora_mw != null && x.pico_hoje_mw != null && x.pico_hoje_mw + EPS < x.agora_mw) mau.push('tempo real: MUST ' + p + ' pico ' + x.pico_hoje_mw + ' abaixo do agora ' + x.agora_mw);
      if (!(T.must.contratos_mw || {})[p]) mau.push('tempo real: MUST ' + p + ' sem contratado');
    });
    /* o registro da mesa vai marcado como preliminar, no campo e na legenda (decisao do humano, 11/10/2026) */
    if (!/preliminar/i.test(T.operador.fonte || '')) mau.push('tempo real: o registro da mesa sem a marca de preliminar');
    if (!/operador: registro da mesa[^.]*PRELIMINAR/i.test((R.legenda || {}).tempo_real || '')) mau.push('legenda: o registro da mesa sem a marca de preliminar');
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

/* ---- CASOS FORJADOS DO RENDIMENTO x AGORA (lote rendimento-lida, 19/10/2026): nao dependem da hora nem do dado do dia ----
   A lib do portal_vivo (LV) monta o agora e o rendimento de um dia FORJADO, o gerador do resumo (GA) seleciona os dois como no
   job, e a julga acima confere. Quatro instantes (10:00 a 10:15); o circuito de ordem k no mapa (M1 · C1 = 1 ... M9 = 22) gera
   k MW constantes; o complexo e a soma. Valores conferidos A MAO, para a lib e a julga nao errarem juntas.
     meio   M2 · C1 (k = 4) sem a leitura de 10:05. Horizonte comum 10:15. M1 = 6 MW x 4 x 5 min = 2,0 MWh; M2 = (4 x 3 + 5 x 4)
            x 5 min = 2,667 (rendimento 2,7; agora 2,67). Nove usinas julgadas no mesmo horizonte. PLANTIO: o rendimento pela
            regra de antes (so os instantes em que os 22 mediram: o 10:05 sai das nove usinas) da M1 = 1,5 e reprova.
     ponta  M8 · C1 (k = 19) e o M9 (k = 22) sem a leitura de 10:15. Horizonte comum 10:10. M8: rendimento 60 x 3 x 5 min = 15,0;
            agora 15 + (20 + 21) x 5 min = 18,42, hora 10:10, energia ate 10:15. M9: 5,5 nos dois, energia ate 10:10 = o
            horizonte comum (julgado igual). PLANTIO: o agora sem o horizonte da energia (o resumo de antes, so com a hora) julga
            o M8 como mesmo horizonte e reprova: e o vermelho de 19/10/2026 as 15:45. */
const HF = ['10:00', '10:05', '10:10', '10:15'];
function forjaDia(falta) {
  const CIRC = LV.mapaCircuitos();
  if (!CIRC) throw new Error('o mapa de circuitos do gen-executivo.js nao leu');
  const dados = [], tot = HF.map(() => 0);
  let k = 0;
  for (const ps of Object.values(CIRC)) for (const p of ps) {
    k++;
    const kw = 1000 * k;
    dados.push({ pontoId: p, nomeGrandeza: 'Demat', valores: HF.map((h, i) => {
      if (falta(p, h)) return { data: '2026-10-19T' + h + ':00', valor: null };
      tot[i] += kw; return { data: '2026-10-19T' + h + ':00', valor: kw }; }) });
  }
  dados.push({ pontoId: LV.COMPLEXO, nomeGrandeza: 'Demat', valores: HF.map((h, i) => ({ data: '2026-10-19T' + h + ':00', valor: tot[i] })) });
  return { elet: { dataInicio: '2026-10-19T00:00:00', dados }, CIRC };
}
function resumoDoDia(R, elet) {
  const V = LV.monta(elet, null);
  const Y = copia(R);
  Y.agora = GA.monta(V, {}).agora;
  Y.tempo_real.rendimento = GA.montaTempoReal(V, {}, {}, {}).rendimento;
  return Y;
}
const doRendimento = (ms) => ms.filter((m) => /^tempo real: (rendimento|energia)/.test(m));
function casosRendimento(R, falhas) {
  const q = (nome, a, b, tol) => { if (a == null || typeof a !== typeof b || (typeof b === 'number' ? Math.abs(a - b) > tol : a !== b)) falhas.push('caso ' + nome + ': ' + a + ' (a mao: ' + b + ')'); };
  const rd = (Y, u) => (Y.tempo_real.rendimento.por_usina.find((x) => x.ufv === u) || {}).mwh;
  /* meio */
  const M = forjaDia((p, h) => p === 6201 && h === '10:05');
  const Ym = resumoDoDia(R, M.elet), cm = {};
  doRendimento(julga(Ym, cm)).forEach((m) => falhas.push('caso buraco no meio: ' + m));
  q('meio · horizonte comum', Ym.tempo_real.rendimento.ate, '10:15'); q('meio · rendimento M1', rd(Ym, 'M1'), 2.0, 1e-9);
  q('meio · rendimento M2', rd(Ym, 'M2'), 2.7, 1e-9); q('meio · agora M2', Ym.agora.por_entidade.M2.energia_hoje_mwh, 2.67, 1e-9);
  q('meio · usinas julgadas no mesmo horizonte', cm.rend_mesmo, 9, 0);
  /* plantio: a regra de antes do rendimento (so os instantes em que os 22 mediram), refeita aqui do dia forjado */
  const Pm = copia(Ym), sc = new Map(M.elet.dados.map((s) => [s.pontoId, new Map(s.valores.filter((v) => v.valor != null).map((v) => [v.data.slice(11, 16), v.valor / 1000]))]));
  const ids = Object.values(M.CIRC).flat(), comuns = HF.filter((h) => ids.every((p) => sc.get(p).has(h)));
  Pm.tempo_real.rendimento.por_usina.forEach((x) => {
    const e = comuns.reduce((s, h) => s + M.CIRC[x.ufv].reduce((a, p) => a + sc.get(p).get(h), 0), 0) * 5 / 60;
    x.mwh = Math.round(10 * e) / 10; x.mwh_por_mw = Math.round(1000 * e / LV.CAP[x.ufv]) / 1000; });
  if (JSON.stringify(Pm) === JSON.stringify(Ym)) falhas.push('plantio "rendimento so nos instantes comuns aos 22" nao mudou nada');
  else if (!doRendimento(julga(Pm)).some((m) => /^tempo real: rendimento M1 1\.5 MWh contra 2 do agora$/.test(m)))
    falhas.push('plantio "rendimento so nos instantes comuns aos 22" NAO reprovou o M1 (1,5 contra 2,0)');
  else console.log('  caso buraco no meio: ' + cm.rend_mesmo + ' usinas no mesmo horizonte, iguais; plantio "rendimento so nos instantes comuns aos 22": reprovou');
  /* ponta */
  const P = forjaDia((p, h) => (p === 6216 || p === 6219) && h === '10:15');
  const Yp = resumoDoDia(R, P.elet), cp = {};
  doRendimento(julga(Yp, cp)).forEach((m) => falhas.push('caso buraco na ponta: ' + m));
  const a8 = Yp.agora.por_entidade.M8, a9 = Yp.agora.por_entidade.M9;
  q('ponta · horizonte comum', Yp.tempo_real.rendimento.ate, '10:10'); q('ponta · rendimento M8', rd(Yp, 'M8'), 15, 1e-9);
  q('ponta · agora M8', a8.energia_hoje_mwh, 18.42, 1e-9); q('ponta · hora M8', a8.hora, '10:10'); q('ponta · energia do M8 ate', a8.energia_ate, '10:15');
  q('ponta · rendimento M9', rd(Yp, 'M9'), 5.5, 1e-9); q('ponta · agora M9', a9.energia_hoje_mwh, 5.5, 1e-9); q('ponta · energia do M9 ate', a9.energia_ate, '10:10');
  q('ponta · usinas julgadas no mesmo horizonte', cp.rend_mesmo, 1, 0); q('ponta · usinas julgadas pelo atraso', cp.rend_atrasado, 8, 0);
  /* plantio: o agora sem o horizonte da energia (o resumo de antes) */
  const Pp = copia(Yp); Object.values(Pp.agora.por_entidade).forEach((x) => { delete x.energia_ate; });
  if (!doRendimento(julga(Pp)).some((m) => /^tempo real: rendimento M8 15 MWh contra 18\.42 do agora$/.test(m)))
    falhas.push('plantio "agora sem o horizonte da energia" NAO reprovou o M8 (15 contra 18,42)');
  else console.log('  caso buraco na ponta: ' + cp.rend_mesmo + ' usina no mesmo horizonte e ' + cp.rend_atrasado + ' pelo atraso; plantio "agora sem o horizonte da energia": reprovou');
  /* plantio: a energia do agora com horizonte antes do comum (impossivel: os 22 leram ate la) */
  const Pq = copia(Yp); Pq.agora.por_entidade.M9.energia_ate = '10:05';
  if (!doRendimento(julga(Pq)).some((m) => /energia do M9 ate 10:05, antes do horizonte comum/.test(m))) falhas.push('plantio "energia antes do horizonte comum" NAO reprovou');
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
    if (!r || !a || !T.ate) return false; a.hora = mesmo ? T.ate : '23:59'; a.energia_ate = a.hora;
    r.mwh = Math.round((a.energia_hoje_mwh + 2) * 10) / 10; r.mwh_por_mw = Math.round(1000 * r.mwh / 49.11) / 1000; return true; };
  /* de madrugada a energia do dia e NEGATIVA (consumo do trafo): o numero da mensagem aceita o sinal (06/10/2026, 41 runs
     vermelhas das 02:25 as 05:40 com o detector certo e "reprovou pelo motivo errado" so porque [\d.]+ nao casa "-0.1") */
  plantio('rendimento diferente do agora no mesmo horizonte', (Y) => infla(Y, true), /rendimento M5 -?[\d.]+ MWh contra -?[\d.]+ do agora$/);
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
  plantio('registro da mesa sem a marca de preliminar', (Y) => { delete Y.tempo_real.operador.fonte; return true; }, /mesa sem a marca de preliminar/);
  plantio('legenda que apresenta a mesa como fonte', (Y) => { if (!Y.legenda) return false;
    Y.legenda.tempo_real = Y.legenda.tempo_real.replace(/, PRELIMINAR: [^.]*\./, '.'); return true; }, /legenda: o registro da mesa sem/);
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

  casosRendimento(R, falhas);

  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-agente-om: produto, plantios e casos do rendimento OK');
})().catch((e) => { console.error(e); process.exit(1); });
