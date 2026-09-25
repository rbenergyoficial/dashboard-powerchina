'use strict';
/*
 * lib-par-mwh.js — confere o par GWh × MWh do executivo (PROMOVER mwh-gerador, 25/09/2026).
 *
 * O portal escreve energia em MWh com 2 casas. O `serie_ufv` so tinha corte, potencial, entregue e resto em GWh
 * com 2 casas (10 MWh de resolucao), e as razoes do mes idem. Os campos em MWh nascem da energia CRUA, ao lado dos
 * antigos, e passam pelas MESMAS edicoes (reconciliacao ao conjunto, Complexo, grupos, reparticao estimada).
 *
 * O que se confere, e por que nao e so "mwh/1000 = gwh":
 *   PAR       · potencial, entregue, o corte ANTES da reconciliacao e o corte do Complexo nascem do mesmo numero
 *               cru nas duas unidades — fecham em TOL_PAR (dois arredondamentos de 2 casas).
 *   AUSENCIA  · um lado nulo e o outro nao e defeito de emissao: a edicao que anula um tem de anular o outro.
 *   IDENTIDADE· o corte RECONCILIADO nao fecha com o GWh na casa do MWh, e isso e o motivo do campo: o GWh parte de
 *               brutos arredondados a 10 MWh. O que se exige em MWh e o que a regra promete — a soma das usinas
 *               fecha com o conjunto, o grupo e a soma dos seus membros, a reparticao estimada soma o conjunto, e
 *               as tres parcelas fecham com o potencial.
 *   PROPORCAO · cada usina recebe o ajuste na proporcao do proprio bruto; so a de maior corte leva a sobra.
 *   ANO       · o acumulado e a soma dos meses.
 *   RAZOES    · cada razao e origem do mes fecha com a sua irma em GWh.
 */
const { TOL_PAR } = require('./lib-tol-unidade.js');

const USINAS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const FECHA = 0.011;        // soma de valores de 2 casas com a sobra ja distribuida: meio centesimo por lado
const PROP = 0.05;          // a sobra de arredondamento vai inteira para UMA usina: ate meio centesimo por usina

function conferePares(out) {
  const mau = [];
  const S = out.serie_ufv || [];
  const par = (x, g, m, rotulo, tol) => {
    const a = x[g], b = x[m];
    if ((a == null) !== (b == null)) { mau.push(x.ufv + ' ' + x.mes + ': ' + rotulo + ' ' + g + '=' + a + ' e ' + m + '=' + b + ' (um lado nulo)'); return; }
    if (a != null && tol != null && Math.abs(b / 1000 - a) > tol) mau.push(x.ufv + ' ' + x.mes + ': ' + rotulo + ' ' + b + ' MWh contra ' + a + ' GWh');
  };
  S.forEach(x => {
    par(x, 'potencial_gwh', 'potencial_mwh', 'potencial', TOL_PAR);
    par(x, 'entregue_gwh', 'entregue_mwh', 'entregue', TOL_PAR);
    par(x, 'cortado_gwh', 'cortado_mwh', 'corte', x.cortado_bruto_gwh != null || x.corte_estimado || x.grupo ? null : TOL_PAR);
    par(x, 'outras_gwh', 'outras_mwh', 'resto', null);
    if (x.cortado_bruto_gwh != null) par(x, 'cortado_bruto_gwh', 'cortado_bruto_mwh', 'corte bruto', TOL_PAR);
    if (x.outras_mwh != null && x.potencial_mwh != null && x.entregue_mwh != null && x.cortado_mwh != null) {
      const r = Math.max(0, x.potencial_mwh - x.entregue_mwh - x.cortado_mwh);
      if (Math.abs(r - x.outras_mwh) > FECHA) mau.push(x.ufv + ' ' + x.mes + ': resto ' + x.outras_mwh + ' MWh nao fecha (potencial - entregue - corte = ' + r.toFixed(2) + ')');
    }
  });
  const meses = [...new Set(S.map(x => x.mes))];
  meses.forEach(m => {
    const d = u => S.find(x => x.ufv === u && x.mes === m);
    const cx = d('Complexo'), us = USINAS.map(d).filter(Boolean);
    if (cx && cx.cortado_mwh != null && us.length && us.every(x => x.cortado_mwh != null && x.corte_reconciliado === 1)) {
      const s = us.reduce((a, x) => a + x.cortado_mwh, 0);
      if (Math.abs(s - cx.cortado_mwh) > FECHA) mau.push(m + ': usinas somam ' + s.toFixed(2) + ' MWh de corte contra ' + cx.cortado_mwh + ' do conjunto');
      const bru = us.filter(x => x.cortado_bruto_mwh > 0);
      const sb = bru.reduce((a, x) => a + x.cortado_bruto_mwh, 0);
      if (sb > 0) bru.forEach(x => { const esp = x.cortado_bruto_mwh * cx.cortado_mwh / sb;
        if (Math.abs(esp - x.cortado_mwh) > PROP) mau.push(m + ' ' + x.ufv + ': corte ' + x.cortado_mwh + ' MWh fora da proporcao do bruto (' + esp.toFixed(2) + ')'); });
    }
    [['PPA', ['M2', 'M3', 'M4', 'M5', 'M6', 'M8']], ['ML', ['M1', 'M7', 'M9']]].forEach(([g, mem]) => {
      const lg = d(g); if (!lg || lg.cortado_mwh == null || lg.corte_estimado) return;
      const ms = mem.map(d);
      if (ms.some(x => !x || x.cortado_mwh == null)) { mau.push(m + ' ' + g + ': corte em MWh sem todas as usinas'); return; }
      const s = ms.reduce((a, x) => a + x.cortado_mwh, 0);
      if (Math.abs(s - lg.cortado_mwh) > FECHA) mau.push(m + ' ' + g + ': ' + lg.cortado_mwh + ' MWh contra a soma das usinas ' + s.toFixed(2));
    });
    const P = d('PPA'), L = d('ML');
    if (cx && P && L && P.corte_estimado && cx.cortado_mwh != null && Math.abs(P.cortado_mwh + L.cortado_mwh - cx.cortado_mwh) > FECHA)
      mau.push(m + ': reparticao estimada PPA + ML ' + (P.cortado_mwh + L.cortado_mwh).toFixed(2) + ' contra ' + cx.cortado_mwh + ' MWh');
  });
  (out.ytd_ufv || []).forEach(y => {
    if (y.cortado_gwh == null) return;
    if (y.cortado_mwh == null) { mau.push(y.ufv + ' ' + y.ano + ': ano sem corte em MWh'); return; }
    // os meses do acumulado sao os `meses` primeiros do ano (de janeiro em diante, so os fechados)
    const L = S.filter(x => x.ufv === y.ufv && x.mes.slice(0, 4) === y.ano).sort((a, b) => a.mes < b.mes ? -1 : 1)
      .slice(0, y.meses).filter(x => x.cortado_mwh != null);
    const s = L.reduce((a, x) => a + x.cortado_mwh, 0);
    if (Math.abs(y.cortado_mwh - s) > FECHA) mau.push(y.ufv + ' ' + y.ano + ': ano ' + y.cortado_mwh + ' MWh contra a soma dos meses ' + s.toFixed(2));
  });
  (out.serie || []).forEach(s => {
    if (s.frustrada_gwh != null && (s.frustrada_mwh == null || Math.abs(s.frustrada_mwh / 1000 - s.frustrada_gwh) > TOL_PAR)) mau.push(s.mes + ': frustrada ' + s.frustrada_mwh + ' MWh contra ' + s.frustrada_gwh + ' GWh');
    ['razoes', 'origens'].forEach(k => Object.entries(s[k] || {}).forEach(([c, o]) => {
      if (o.mwh == null || Math.abs(o.mwh / 1000 - o.gwh) > TOL_PAR) mau.push(s.mes + ' ' + k + ' ' + c + ': ' + o.mwh + ' MWh contra ' + o.gwh + ' GWh');
    }));
  });
  return mau;
}

module.exports = { conferePares, FECHA, PROP };
