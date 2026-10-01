/*
 * ensaio-motivo-ufv.js — o corte por motivo aberto por usina e por contrato (PROMOVER motivo-entidade).
 *
 * POR QUE EXISTE. O executivo passou a publicar `motivo_ufv` (mes a mes, por usina e por contrato) e `razoes_mwh` em cada
 * linha do corte diario por usina: o deficit da usina (potencial - geracao do operador) nas meias horas limitadas, pelo
 * motivo que o operador apurou para o CONJUNTO naquela meia hora. Motivo errado nao quebra tela: faz o painel atribuir a
 * uma usina um corte de confiabilidade que ela nao teve.
 *
 * O QUE PROVA, no blob publicado:
 *   - nenhum valor negativo; nenhum mes antes de mar/26 (antes o potencial por usina do operador nao presta: a soma
 *     sairia ZERO, e o certo e "nao apurado");
 *   - PPA e ML iguais a soma das suas usinas, motivo a motivo (folga 0,01 por usina somada: os dois lados de r2);
 *   - motivo de usina so se o CONJUNTO teve aquele motivo REGISTRADO no mesmo mes (por dia, no mesmo dia) — registrado, e nao
 *     com perda positiva: pela referencia do conjunto a perda pode sair zero na mesma meia hora em que a usina teve deficit;
 *   - a soma das usinas contra o impedido por motivo do conjunto, mes a mes, entre 0,90 e 1,10 (medido 0,976 a 1,058 de
 *     mar a set/26: a referencia por usina contra a do conjunto; e conferencia de ordem de grandeza, nao identidade).
 *   PLANTIOS: usina do PPA alterada, motivo que o conjunto nao teve e mes de fev/26 reprovam.
 * Sem segredo: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome))); req.on('error', ko);
  });
}
const GRUPOS = { PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
const tot = (o) => Object.values(o || {}).reduce((s, x) => s + x, 0);

function julga(j) {
  const f = [];
  const M = j.motivo_ufv;
  if (!Array.isArray(M) || !M.length) return ['motivo_ufv ausente ou vazio'];
  const conjMes = new Map((j.serie || []).filter((s) => s.razoes).map((s) => [s.mes, Object.fromEntries(Object.entries(s.razoes).map(([k, v]) => [k, v.mwh != null ? v.mwh : 1000 * v.gwh]))]));
  const conjDia = new Map((j.serie_diaria || []).filter((s) => s.razoes).map((s) => [s.dia, s.razoes]));
  const chave = new Map(M.map((x) => [x.mes + '|' + x.ufv, x]));
  for (const x of M) {
    if (x.mes < '2026-03') f.push(x.ufv + ' ' + x.mes + ': mes antes de mar/26 publicado');
    for (const [k, v] of Object.entries(x.razoes_mwh || {})) {
      if (!(v >= 0)) f.push(x.ufv + ' ' + x.mes + ' ' + k + ': valor ' + v);
      const c = conjMes.get(x.mes) || {};
      // o motivo tem de EXISTIR nos registros do conjunto (a perda dele pela referencia do conjunto pode ser zero na mesma meia hora)
      if (v > 0 && !(k in c)) f.push(x.ufv + ' ' + x.mes + ': motivo ' + k + ' que o conjunto nao teve no mes');
    }
  }
  for (const mes of new Set(M.map((x) => x.mes))) {
    for (const [g, mb] of Object.entries(GRUPOS)) {
      const G = chave.get(mes + '|' + g); if (!G) continue;
      const ks = new Set(Object.keys(G.razoes_mwh)); mb.forEach((u) => Object.keys((chave.get(mes + '|' + u) || {}).razoes_mwh || {}).forEach((k) => ks.add(k)));
      for (const k of ks) { const s = mb.reduce((a, u) => a + (((chave.get(mes + '|' + u) || {}).razoes_mwh || {})[k] || 0), 0);
        if (Math.abs(s - (G.razoes_mwh[k] || 0)) > 0.01 * mb.length) f.push(g + ' ' + mes + ' ' + k + ': ' + (G.razoes_mwh[k] || 0) + ' contra a soma das usinas ' + s.toFixed(2)); }
    }
    const c = tot(conjMes.get(mes)), u = tot((chave.get(mes + '|PPA') || {}).razoes_mwh) + tot((chave.get(mes + '|ML') || {}).razoes_mwh);
    if (c > 100 && (u / c < 0.90 || u / c > 1.10)) f.push(mes + ': usinas / conjunto = ' + (u / c).toFixed(3) + ' (esperado 0,90 a 1,10)');
  }
  let nDia = 0;
  for (const r of j.corte_diario_ufv || []) {
    if (!r.razoes_mwh) { f.push(r.ufv + ' ' + r.dia + ': corte diario sem razoes_mwh'); continue; }
    nDia++;
    const c = conjDia.get(r.dia);
    for (const [k, v] of Object.entries(r.razoes_mwh)) {
      if (!(v >= 0)) f.push(r.ufv + ' ' + r.dia + ' ' + k + ': valor ' + v);
      if (v > 0 && c && !(k in c)) f.push(r.ufv + ' ' + r.dia + ': motivo ' + k + ' que o conjunto nao teve no dia');
    }
  }
  if (!nDia) f.push('nenhuma linha do corte diario com razoes_mwh');
  return f;
}

(async () => {
  const j = await getJSON('executivo.json');
  const f = julga(j);
  const M = j.motivo_ufv || [];
  console.log('   motivo_ufv: ' + M.length + ' linhas · meses ' + [...new Set(M.map((x) => x.mes))].join(' ') + ' · corte diario com motivo: ' + (j.corte_diario_ufv || []).filter((r) => r.razoes_mwh).length);
  if (M.length) {
    const base = new Set(f);
    const planta = (nome, fn, espera) => { const P = JSON.parse(JSON.stringify(j)); fn(P); const nv = julga(P).filter((x) => !base.has(x));
      const ok = nv.some((x) => x.indexOf(espera) >= 0); console.log('   plantio (' + nome + '): ' + nv.length + ' achado(s)' + (ok ? '' : ' — NENHUM com "' + espera + '"'));
      if (!ok) f.push('plantio "' + nome + '" nao reprova pelo que plantou'); };
    const alvo = M.find((x) => x.ufv === 'M5' && x.razoes_mwh.ENE > 0);
    if (alvo) planta('ENE do M5 +10 MWh', (P) => { P.motivo_ufv.find((x) => x.mes === alvo.mes && x.ufv === 'M5').razoes_mwh.ENE += 10; }, 'PPA ' + alvo.mes + ' ENE');
    const semCnf = M.find((x) => x.ufv === 'M3' && !((j.serie.find((s) => s.mes === x.mes) || {}).razoes || {}).CNF);
    if (semCnf) planta('CNF que o conjunto nao teve', (P) => { P.motivo_ufv.find((x) => x.mes === semCnf.mes && x.ufv === 'M3').razoes_mwh.CNF = 5; }, 'M3 ' + semCnf.mes + ': motivo CNF');
    planta('mes de fev/26', (P) => { P.motivo_ufv.push({ mes: '2026-02', ufv: 'M1', razoes_mwh: { ENE: 0 } }); }, 'M1 2026-02: mes antes');
  }
  if (f.length) { f.slice(0, 30).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-motivo-ufv: TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
