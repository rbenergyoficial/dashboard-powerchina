/*
 * ensaio-disponibilidade.js — prova a lib de disponibilidade por usina contra DADO REAL (o blob
 * publico perdas_inv.json, sem segredo nenhum) e contra casos forjados.
 *
 * O que ele exige, cada linha por um modo de falhar visto na analise de 06/09/2026:
 *   1. a janela do dia e o sol de Mauriti (11,9 a 12,5 h) em TODOS os dias — se sair 23 h, o p90
 *      voltou a contaminar a referencia;
 *   2. os inversores de contador de 24 h existem (M4 tem dezenas) e contam como disponiveis;
 *   3. nenhuma usina sai abaixo de 99% no periodo, e o M9 tem o pior dia (27/07, ~80%);
 *   4. o complexo fecha com a disponibilidade DECLARADA ao operador (executivo.json) em ate 1,5 pp
 *      no mes fechado mais recente — dois caminhos independentes no mesmo numero;
 *   5. forjado: um inversor parado o dia inteiro derruba a usina em exatamente 1/n;
 *   6. forjado: dia em que todos marcam 23 h nao produz numero — produz nota.
 * uso: node scripts/ensaio-disponibilidade.js
 */
const zlib = require('zlib');
const { disponibilidade, mensal } = require('./lib-disponibilidade.js');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const get = (u) => fetch(u).then(async (r) => {
  if (r.status !== 200) throw new Error(r.status + ' ' + u);
  let b = Buffer.from(await r.arrayBuffer());
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  return JSON.parse(b.toString('utf8'));
});
const falhas = [];
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FALHA ') + m); if (!c) falhas.push(m); };

(async () => {
  const pi = await get(BASE + 'perdas_inv.json');
  const { porDia } = disponibilidade(pi.serie);
  const dias = [...porDia.keys()].sort();
  console.log('1 · janela do dia, ' + dias.length + ' dias');
  const jan = dias.map((d) => porDia.get(d).janela_min).filter((x) => x != null);
  ok(jan.length === dias.length, 'todo dia tem janela · ' + jan.length + ' de ' + dias.length);
  ok(Math.min(...jan) >= 11.9 * 60 && Math.max(...jan) <= 12.5 * 60,
    'janela entre 11,9 e 12,5 h · veio ' + (Math.min(...jan) / 60).toFixed(2) + ' a ' + (Math.max(...jan) / 60).toFixed(2));

  console.log('\n2 · contador de 24 h conta como disponivel');
  const c24 = dias.reduce((a, d) => a + ((porDia.get(d).porUfv.M4 || {}).contador_24h || 0), 0) / dias.length;
  ok(c24 > 20, 'M4 tem dezenas de inversores com contador de 24 h por dia · veio ' + c24.toFixed(0));
  const m4 = dias.map((d) => (porDia.get(d).porUfv.M4 || {}).disp_pct).filter((x) => x != null);
  ok(Math.min(...m4) > 98, 'e mesmo assim o M4 nunca cai de 98% · pior ' + Math.min(...m4));

  console.log('\n3 · usinas e pior dia');
  const grupos = { Complexo: ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'], PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
  const M = mensal(porDia, grupos);
  const us = grupos.Complexo;
  for (const u of us) {
    const v = dias.map((d) => (porDia.get(d).porUfv[u] || {}).disp_pct).filter((x) => x != null);
    const med = v.reduce((a, x) => a + x, 0) / v.length;
    ok(med >= 99 && med <= 100, u + ' media do periodo entre 99 e 100 · ' + med.toFixed(2));
  }
  const m9 = (porDia.get('2026-07-27') || { porUfv: {} }).porUfv.M9;
  ok(m9 && m9.disp_pct > 78 && m9.disp_pct < 83, 'M9 em 27/07 entre 78 e 83% · ' + (m9 ? m9.disp_pct : 'sem dia'));
  ok(m9 && m9.parciais >= 3, 'e o motivo esta na contagem de parciais · ' + (m9 ? m9.parciais : '-'));

  console.log('\n4 · fecha com a disponibilidade declarada ao operador');
  const ex = await get(BASE + 'executivo.json');
  const mesesLib = [...new Set(Object.keys(M).map((k) => k.split('|')[1]))].sort();
  const mesCheio = mesesLib.filter((m) => M['Complexo|' + m] && M['Complexo|' + m].dias >= 25).pop();
  const ons = (ex.serie || []).find((s) => s.mes === mesCheio);
  ok(!!ons && ons.disp_pct != null, 'executivo tem disp declarada em ' + mesCheio + ' · ' + (ons ? ons.disp_pct : '-'));
  if (ons && ons.disp_pct != null) {
    const nossa = M['Complexo|' + mesCheio].disp_pct;
    ok(Math.abs(nossa - ons.disp_pct) <= 1.5, 'inversor ' + nossa + '% contra declarada ' + ons.disp_pct + '% · diferenca ' + Math.abs(nossa - ons.disp_pct).toFixed(2) + ' pp');
  }
  console.log('     mensal: ' + us.map((u) => u + ' ' + (M[u + '|' + mesCheio] || {}).disp_pct).join(' · '));

  console.log('\n5 · forjado: um inversor parado o dia inteiro');
  const base = []; for (let i = 0; i < 100; i++) base.push({ dia: '2030-01-01', ufv: 'MX', inv: 'I' + i, horas: 740 });
  const forj = base.map((l) => ({ ...l })); forj[0].horas = 0;
  const r = disponibilidade(forj).porDia.get('2030-01-01').porUfv.MX;
  ok(r.disp_pct === 99 && r.parados === 1, 'usina de 100 com um parado = 99,00% e 1 parado · veio ' + r.disp_pct + ' / ' + r.parados);
  const meio = base.map((l) => ({ ...l })); meio[0].horas = 370;
  const r2_ = disponibilidade(meio).porDia.get('2030-01-01').porUfv.MX;
  ok(r2_.disp_pct === 99.5 && r2_.parciais === 1, 'um a meia janela = 99,50% e 1 parcial · veio ' + r2_.disp_pct + ' / ' + r2_.parciais);

  console.log('\n6 · forjado: todos com contador de 24 h → nota, nao numero');
  const todos24 = base.map((l) => ({ ...l, horas: 1410 }));
  const r3 = disponibilidade(todos24).porDia.get('2030-01-01');
  ok(r3.janela_min == null && !!r3.nota && Object.keys(r3.porUfv).length === 0, 'sem janela, com nota: ' + (r3.nota || '(sem nota)'));

  console.log('\n' + (falhas.length ? '🔴 ' + falhas.length + ' FALHA(S)' : '✅ tudo passou'));
  process.exit(falhas.length ? 1 : 0);
})().catch((e) => { console.log('🔴 ' + e.message); process.exit(1); });
