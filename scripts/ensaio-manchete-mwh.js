/*
 * ensaio-manchete-mwh.js — a manchete do mes tambem em MWh com centesimos (PROMOVER manchete-mwh).
 *
 * POR QUE EXISTE. A manchete (meta, projecao, falta, ritmos) saia so em GWh com 2 casas, calculada de energias ja
 * arredondadas: com o M5 a meta ia a 6,55 GWh contra 6.545,52 MWh da serie mensal, e o portal escrevia "9.730,00 MWh
 * projetados" com um ",00" que a conta nao tem. Os campos `*_mwh` e `*_exato` refazem a MESMA conta das energias em MWh.
 *
 * Quatro coisas, sobre o PRODUTO publicado (ou `BASE_DADOS` apontando para um diretorio local):
 *   1 · ORIGEM: a meta e a energia em MWh da manchete sao as da serie mensal da mesma entidade e mes;
 *   2 · COERENCIA: projecao, percentuais, falta e ritmos em MWh saem uns dos outros (identidades), e cada um fecha com o
 *       irmao em GWh dentro do arredondamento dele — a folga e derivada, nao escolhida;
 *   3 · REMENDO: o remendo de 5 min move os campos em MWh junto com os de GWh — a energia sobe exatamente o que hoje
 *       cresceu, a falta desce o mesmo tanto, e a projecao (que parte dos dias fechados) fica parada;
 *   4 · PLANTIO: dois defeitos reprovam — a meta tirada do GWh (o defeito que o lote conserta) e a manchete sem a ancora
 *       em MWh (o remendo passaria por vacuidade, sem julgar nada).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const { remendaManchete } = require('./lib-manchete.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

function getJSON(nome) {
  if (!/^https?:/.test(BASE)) {
    let b = fs.readFileSync(path.join(BASE, nome));
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    return Promise.resolve(JSON.parse(b.toString('utf8')));
  }
  return new Promise((ok, ko) => {
    https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

const num = v => (v == null || v === '' || v === '—') ? null : Number(String(v).replace(/[\s ]/g, ''));
const clone = o => JSON.parse(JSON.stringify(o));

function julga(exec) {
  const f = [];
  const SU = exec.serie_ufv || [];
  const linhas = (exec.manchete_ufv || []).filter(x => x.meta_mwh != null);
  if (!linhas.length) { f.push('nenhuma linha da manchete traz `meta_mwh` — nada a julgar'); return { f, n: 0 }; }
  linhas.forEach(m => {
    const k = m.ufv + ' ' + m.mes, s = SU.find(x => x.ufv === m.ufv && x.mes === m.mes);
    const dC = Number(m.dias_decorridos), dT = Number(m.dias_total), rest = Math.max(0, dT - dC);
    // 1 · origem
    if (!s) f.push(k + ': sem linha na serie mensal');
    else {
      if (s.meta_mwh != null && Math.abs(m.meta_mwh - s.meta_mwh) > 0.005) f.push(k + ': meta ' + m.meta_mwh + ' na manchete, ' + s.meta_mwh + ' na serie');
      if (s.liquida_mwh != null && Math.abs(m.liq_mwh - s.liquida_mwh) > 0.005) f.push(k + ': energia ' + m.liq_mwh + ' na manchete, ' + s.liquida_mwh + ' na serie');
    }
    // 2 · coerencia (identidades em MWh; cada numero publicado com 2 casas, entao +-0,005 em cada termo)
    const M = m.meta_mwh, L = m.liq_mwh, P = m.liq_proj_mwh;
    if (M > 0 && Math.abs(m.atingido_exato - 100 * L / M) > 0.0051 + 100 * 0.01 / M) f.push(k + ': atingido_exato ' + m.atingido_exato + ' nao sai de ' + L + '/' + M);
    if (M > 0 && P != null && Math.abs(m.proj_pct_exato - 100 * P / M) > 0.0051 + 100 * 0.01 / M) f.push(k + ': proj_pct_exato ' + m.proj_pct_exato + ' nao sai de ' + P + '/' + M);
    const falta = Math.max(0, M - L);
    if (Math.abs(m.falta_mwh - falta) > 0.011) f.push(k + ': falta_mwh ' + m.falta_mwh + ', meta - energia = ' + falta.toFixed(2));
    if (dC > 0 && Math.abs(m.ritmo_atual_mwh - L / dC) > 0.006 + 0.005 / dC) f.push(k + ': ritmo_atual_mwh ' + m.ritmo_atual_mwh + ' nao e energia/dias');
    if (falta > 0 && rest > 0 && Math.abs(m.ritmo_nec_mwh - falta / rest) > 0.006 + 0.011 / rest) f.push(k + ': ritmo_nec_mwh ' + m.ritmo_nec_mwh + ' nao e falta/dias');
    if (dC > 0 && Math.abs(P - m.liq_fechada_mwh * dT / dC) > 0.006 + 0.005 * dT / dC) f.push(k + ': projecao ' + P + ' nao sai da ancora ' + m.liq_fechada_mwh);
    // ... e cada um fecha com o irmao em GWh, que parte de energias arredondadas a 10 MWh
    const g = x => num(x);
    if (g(m.meta_gwh) != null && Math.abs(M / 1000 - g(m.meta_gwh)) > 0.0051) f.push(k + ': meta ' + M + ' MWh contra ' + m.meta_gwh + ' GWh');
    if (g(m.liq_proj) != null && P != null && Math.abs(P / 1000 - g(m.liq_proj)) > 0.0051 + (dC > 0 ? 0.005 * dT / dC : 0)) f.push(k + ': projecao ' + P + ' MWh contra ' + m.liq_proj + ' GWh');
  });
  return { f, n: linhas.length };
}

function remendo(exec) {
  const f = [];
  const mes = exec.mes_atual, doMes = (exec.manchete_ufv || []).filter(x => x.mes === mes);
  /* a janela de fim de mes (30/09/2026): o mes atual FECHADO e nenhuma linha aberta. Julga-se a regra do remendo sobre
     as linhas do mes atual reabertas numa copia (com as ancoras que ja trazem; sem ancora continua reprovando) */
  const fimDeMes = doMes.length > 0 && doMes.every(x => x.fechado === 1);
  const R = clone(doMes.filter(x => (fimDeMes || x.fechado === 0) && x.liq_fechada_mwh != null)).map(x => Object.assign(x, { fechado: 0 }));
  if (fimDeMes && R.length) console.log('   ⚠️ ' + mes + ' esta FECHADO no blob e nao ha mes aberto (fim de mes): remendo julgado em ' + R.length + ' linhas reabertas numa copia');
  if (!R.length) return { f: ['nenhuma linha do mes em curso com a ancora em MWh — o remendo nao foi julgado'], n: 0 };
  const antes = clone(R), extra = 0.5;   // meio GWh de hoje, forjado
  const gwhPorUfv = {}; R.forEach(m => { gwhPorUfv[m.ufv] = extra; });
  remendaManchete(R, { mes, diaNum: 26, ate: '12:00', gwhPorUfv });
  R.forEach((m, i) => {
    const a = antes[i], k = m.ufv;
    const esp = a.liq_fechada_mwh + 1000 * extra;
    if (Math.abs(m.liq_mwh - esp) > 0.006) f.push(k + ': o remendo levou a energia a ' + m.liq_mwh + ', esperado ' + esp.toFixed(2));
    if (m.liq_proj_mwh !== a.liq_proj_mwh) f.push(k + ': o remendo mexeu na projecao em MWh (' + a.liq_proj_mwh + ' -> ' + m.liq_proj_mwh + ')');
    if (Math.abs(m.falta_mwh - Math.max(0, m.meta_mwh - m.liq_mwh)) > 0.011) f.push(k + ': falta nao acompanhou a energia no remendo');
    if (Math.abs(m.liq_mwh / 1000 - num(m.liq_gwh)) > 0.0051) f.push(k + ': no remendo, ' + m.liq_mwh + ' MWh contra ' + m.liq_gwh + ' GWh');
  });
  return { f, n: R.length };
}

(async () => {
  const exec = await getJSON('executivo.json');
  const A = julga(exec), B = remendo(exec);
  console.log('   manchete em MWh: ' + A.n + ' linhas julgadas · remendo em ' + B.n + ' entidades do mes em curso');
  const f = A.f.concat(B.f);
  // 4 · plantio: cada defeito tem de reprovar
  const P1 = clone(exec); (P1.manchete_ufv || []).forEach(m => { if (m.meta_mwh != null && m.meta_gwh != null) m.meta_mwh = 1000 * num(m.meta_gwh); });
  const r1 = julga(P1).f.filter(x => /na serie/.test(x));
  if (!r1.length) f.push('PLANTIO nao reprovou: a meta tirada do GWh passou');
  const P2 = clone(exec); (P2.manchete_ufv || []).forEach(m => { delete m.liq_fechada_mwh; });
  // sem a ancora em MWh o remendo nao tem de onde refazer os campos: o ensaio tem de dizer que nao julgou, e nao passar
  const mesmoSem = remendo(P2);
  if (!mesmoSem.f.length) f.push('PLANTIO nao reprovou: sem a ancora em MWh o remendo passaria por vacuidade');
  console.log('   plantios: meta do GWh -> ' + r1.length + ' achado(s) · sem ancora -> ' + mesmoSem.f.length + ' achado(s)');
  if (f.length) { console.error('REPROVADO:\n  ' + f.slice(0, 20).join('\n  ')); process.exit(1); }
  console.log('ensaio-manchete-mwh: TUDO PASSOU');
})().catch(e => { console.error('REPROVADO: ' + (e && e.stack || e)); process.exit(1); });
