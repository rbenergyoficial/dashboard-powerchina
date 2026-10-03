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
      /* os dois com 1 casa, de somas diferentes do mesmo medidor: dois arredondamentos de meio decimo (medido: 0,1 no M6) */
      if (a && a.energia_hoje_mwh != null && Math.abs(a.energia_hoje_mwh - r.mwh) > 0.1 + 1e-6) mau.push('tempo real: rendimento ' + r.ufv + ' ' + r.mwh + ' MWh contra ' + a.energia_hoje_mwh + ' do agora');
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
  plantio('medidor fora escondido', (Y) => { Y.tempo_real.medidores.ok -= 1; return true; }, /medidores em dia/);
  plantio('rendimento trocado entre usinas', (Y) => {
    const r = Y.tempo_real.rendimento.por_usina; const a = r.find((x) => x.ufv === 'M2'), b = r.find((x) => x.ufv === 'M9');
    if (!a || !b || Math.abs(a.mwh_por_mw - b.mwh_por_mw) < 0.05) return false; const t = a.mwh_por_mw; a.mwh_por_mw = b.mwh_por_mw; b.mwh_por_mw = t; return true;
  }, /rendimento M[29] /);
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
  plantio('trocas termicas inflada', (Y) => { if (!Y.ativos) return false; Y.ativos.trocas.termicas += 10; return true; }, /termicas/);
  plantio('oleo conforme com laudo nao conforme', (Y) => { if (!Y.ativos || Y.ativos.oleo.conforme !== true) return false; Y.ativos.oleo.nao_conformes = 1; return true; }, /oleo conforme/);
  plantio('capacidade de uma usina trocada', (Y) => { Y.agora.por_entidade.M9.cap_mw = 14.733; return true; }, /usinas somam/);

  if (falhas.length) { console.log(falhas.map((f) => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-agente-om: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
