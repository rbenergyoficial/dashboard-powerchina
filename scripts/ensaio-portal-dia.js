/*
 * ensaio-portal-dia.js — o gerador dos arquivos de cada dia (gen-portal-dia.js) em casos forjados (PROMOVER portal-dia).
 *
 * O que nao pode acontecer sem nada ficar vermelho:
 *   1. o fechamento do dia trocar o historico por uma fonte com MENOS leituras (perderia medicao);
 *   2. o fechamento NAO trocar quando a API trouxe o fim do dia que o snapshot perdeu (o furo da virada ficaria);
 *   3. gravar o arquivo de um dia que nao passa na conferencia (o ponto 6233 deixou de ser a soma dos 22);
 *   4. o `precisa` dizer "ja fechado" com um medidor sem o 24:00, ou "precisa" com os 24 completos;
 *   5. a carga regravar o que ja existe sem FORCAR, ou pular o que falta;
 *   6. o resumo (hist/portal_resumo.json) nao ser o dos arquivos dos dias: dia regravado com resumo velho, resumo apagado que
 *      nao se refaz (PROMOVER portal-resumo-dias).
 * Tudo numa pasta temporaria (LOCAL_DIR), sem Azure e sem API. Cada caso planta o defeito e exige o resultado.
 *
 *   node scripts/ensaio-portal-dia.js
 *   GENPD=scripts/<copia>.js node scripts/ensaio-portal-dia.js   o mesmo contra outra versao do gerador (defeito plantado)
 */
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), zlib = require('zlib'), cp = require('child_process');

const PIDS = [6196, 6197, 6233]; for (let p = 6198; p <= 6219; p++) PIDS.push(p);
const BASE = { Demat: 1500, Demre: -250, TensaoA: 20000, TensaoB: 19900, TensaoC: 20100, CorrenteA: 120, CorrenteB: 121, CorrenteC: 122 };
const SOMADOS = ['Demat', 'Demre', 'CorrenteA', 'CorrenteB', 'CorrenteC'];
const ontem = new Date(Date.now() - 3 * 3600e3 - 86400e3).toISOString().slice(0, 10);
const prox = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10);

// um dia forjado: `ate` = ultimo minuto do dia com leitura (1440 = o 24:00, gravado como 00:00 do dia seguinte)
function forja(dia, ate, desvio6233) {
  const dados = [];
  for (const p of PIDS) for (const [g, v] of Object.entries(BASE)) {
    const val = p === 6233 ? (SOMADOS.includes(g) ? v * 22 + (desvio6233 && g === 'Demat' ? 5 : 0) : v) : v;
    const valores = [];
    for (let m = 5; m <= 1440; m += 5) {
      const data = m === 1440 ? prox(dia) + 'T00:00:00' : dia + 'T' + String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0') + ':00';
      valores.push(m <= ate ? { data, valor: val } : { data });
    }
    dados.push({ pontoId: p, nomeGrandeza: g, valores });
  }
  return { dataInicio: dia + 'T00:00:00', dados };
}
const cam = (d, n) => path.join(d, n.replace(/\//g, '__'));
const grava = (d, n, o) => fs.writeFileSync(cam(d, n), JSON.stringify(o));
const le = (d, n) => { if (!fs.existsSync(cam(d, n))) return null; let b = fs.readFileSync(cam(d, n)); if (b[0] === 0x1f) b = zlib.gunzipSync(b); return JSON.parse(b.toString('utf8')); };
function roda(dir, env) {
  const r = cp.spawnSync(process.execPath, [process.env.GENPD || path.join(__dirname, 'gen-portal-dia.js')], { env: Object.assign({}, process.env, { LOCAL_DIR: dir, GITHUB_OUTPUT: path.join(dir, 'saida.txt') }, env), encoding: 'utf8' });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
const novo = () => fs.mkdtempSync(path.join(os.tmpdir(), 'portal-dia-'));
const ultimo = (o) => { const s = o.dados.find(x => x.pontoId === 6198 && x.nomeGrandeza === 'Demat'); const v = s.valores.filter(x => x.valor != null); return v[v.length - 1].data; };

const f = [];
// 1 e 2 · o fechamento troca SO com mais leituras
{ const d = novo(); grava(d, 'hist/way2_' + ontem + '.json', forja(ontem, 1420)); const api = path.join(d, 'api.json'); fs.writeFileSync(api, JSON.stringify(forja(ontem, 1440)));
  const r = roda(d, { MODO: 'fecha', LOCAL_ELET: api });
  if (r.code !== 0) f.push('fecha com a API mais completa saiu ' + r.code + ': ' + r.out.slice(-200));
  if (ultimo(le(d, 'hist/way2_' + ontem + '.json')) !== prox(ontem) + 'T00:00:00') f.push('o furo da virada ficou: o historico nao recebeu o fim do dia da API');
  const pe = le(d, 'hist/portal_eletrico_' + ontem + '.json');
  if (!pe || pe.hora !== '24:00') f.push('o arquivo do dia nao vai ate 24:00: ' + (pe && pe.hora)); }
{ const d = novo(); grava(d, 'hist/way2_' + ontem + '.json', forja(ontem, 1440)); const api = path.join(d, 'api.json'); fs.writeFileSync(api, JSON.stringify(forja(ontem, 1300)));
  roda(d, { MODO: 'fecha', LOCAL_ELET: api });
  if (ultimo(le(d, 'hist/way2_' + ontem + '.json')) !== prox(ontem) + 'T00:00:00') f.push('o fechamento trocou o historico por uma fonte com MENOS leituras'); }
// 3 · dia que nao passa na conferencia nao ganha arquivo
{ const d = novo(); grava(d, 'hist/way2_' + ontem + '.json', forja(ontem, 1440, true));
  const r = roda(d, { MODO: 'fecha' });
  if (le(d, 'hist/portal_eletrico_' + ontem + '.json')) f.push('gravou o arquivo de um dia em que o 6233 deixou de ser a soma');
  if (r.code === 0 || !/rotulo mente/.test(r.out)) f.push('o dia reprovado nao saiu vermelho com o motivo: ' + r.out.slice(-200)); }
// 4 · precisa
{ const d = novo(); grava(d, 'hist/way2_' + ontem + '.json', forja(ontem, 1440)); roda(d, { MODO: 'fecha' });
  fs.writeFileSync(path.join(d, 'saida.txt'), ''); roda(d, { MODO: 'precisa' });
  if (!/precisa=false/.test(fs.readFileSync(path.join(d, 'saida.txt'), 'utf8'))) f.push('precisa=true com os 24 medidores ate 24:00');
  const pe = le(d, 'hist/portal_eletrico_' + ontem + '.json'); pe.medidores.find(m => m.pid === 6210).hora = '23:55';
  fs.writeFileSync(cam(d, 'hist/portal_eletrico_' + ontem + '.json'), zlib.gzipSync(JSON.stringify(pe)));
  fs.writeFileSync(path.join(d, 'saida.txt'), ''); roda(d, { MODO: 'precisa' });
  if (!/precisa=true/.test(fs.readFileSync(path.join(d, 'saida.txt'), 'utf8'))) f.push('precisa=false com um medidor sem o 24:00'); }
// 5 · carga: pula o que existe, faz o que falta, e o indice lista os dias
{ const d = novo(); const d1 = '2026-01-01', d2 = '2026-01-02', d3 = '2026-01-03';
  [d1, d2, d3].forEach(x => grava(d, 'hist/way2_' + x + '.json', forja(x, 1440)));
  roda(d, { MODO: 'carga', DE: d1, ATE: d1 });
  const t0 = fs.statSync(cam(d, 'hist/portal_vivo_' + d1 + '.json')).mtimeMs;
  const r = roda(d, { MODO: 'carga', DE: d1, ATE: d3 });
  if (fs.statSync(cam(d, 'hist/portal_vivo_' + d1 + '.json')).mtimeMs !== t0) f.push('a carga regravou um dia que ja existia sem FORCAR');
  if (!le(d, 'hist/portal_eletrico_' + d3 + '.json')) f.push('a carga pulou um dia que faltava');
  const ix = le(d, 'hist/portal_dias.json');
  if (!ix || JSON.stringify(ix.dias) !== JSON.stringify([d1, d2, d3])) f.push('indice ' + JSON.stringify(ix && ix.dias));
  if (!/2 dia\(s\) gravado\(s\), 1 ja existiam/.test(r.out)) f.push('a carga nao contou certo: ' + r.out.split('\n').find(l => /^carga/.test(l))); }

// 6 · o resumo: a energia de cada dia do indice, a do proprio arquivo do dia; dia regravado acompanha; resumo apagado se refaz
{ const d = novo(); const d1 = '2026-02-01', d2 = '2026-02-02', d3 = '2026-02-03';
  [d1, d2, d3].forEach(x => grava(d, 'hist/way2_' + x + '.json', forja(x, 1440)));
  roda(d, { MODO: 'carga', DE: d1, ATE: d3 });
  const bate = (tag) => { const rs = le(d, 'hist/portal_resumo.json');
    if (!rs || !rs.dias) { f.push('resumo ' + tag + ': nao existe'); return null; }
    if (JSON.stringify(Object.keys(rs.dias)) !== JSON.stringify([d1, d2, d3])) f.push('resumo ' + tag + ': dias ' + JSON.stringify(Object.keys(rs.dias)));
    [d1, d2, d3].forEach(x => { const pv = le(d, 'hist/portal_vivo_' + x + '.json'), r = rs.dias[x] || {};
      if (!pv || r.e == null || r.e !== pv.energia_mwh || !r.k || r.k.M1 !== pv.kpis.M1.energia_mwh || r.k.PPA !== pv.kpis.PPA.energia_mwh || r.k.ML !== pv.kpis.ML.energia_mwh)
        f.push('resumo ' + tag + ': o dia ' + x + ' nao e o do arquivo do dia (' + JSON.stringify(r).slice(0, 100) + ' x ' + (pv && pv.energia_mwh) + ')'); });
    return rs; };
  const r0 = bate('da carga');
  // d2 refeito com o dobro da potencia e regravado (FORCAR): o resumo daquele dia tem de acompanhar o arquivo novo
  const o2 = forja(d2, 1440); o2.dados.forEach(s => { if (s.nomeGrandeza === 'Demat') s.valores.forEach(v => { if (v.valor != null) v.valor *= 2; }); });
  grava(d, 'hist/way2_' + d2 + '.json', o2);
  roda(d, { MODO: 'carga', DE: d2, ATE: d2, FORCAR: '1' });
  const r1 = bate('com um dia regravado');
  if (r0 && r1 && r1.dias[d2] && r0.dias[d2] && !(r1.dias[d2].e > r0.dias[d2].e)) f.push('resumo: o dia regravado com o dobro nao mudou (' + r0.dias[d2].e + ' -> ' + r1.dias[d2].e + ')');
  fs.unlinkSync(cam(d, 'hist/portal_resumo.json'));
  roda(d, { MODO: 'carga', DE: d1, ATE: d3 });
  bate('refeito dos arquivos'); }

if (f.length) { console.log('REPROVADO:\n  ' + f.join('\n  ')); process.exit(1); }
console.log('gen-portal-dia: os seis casos saem como deviam (troca so com mais leituras, o furo da virada fecha, dia reprovado sem arquivo, precisa, carga e indice, resumo)');
