/*
 * ensaio-portal-eletrico.js — as oito grandezas do dia no portal_eletrico.json (PROMOVER portal-eletrico).
 *
 * POR QUE EXISTE. A secao "Grandezas eletricas" do Ao vivo desenha, medidor a medidor, potencia ativa e reativa, tensao e
 * corrente de cada fase ao longo do dia, e o navegador deriva delas a aparente, o fator de potencia, o angulo e os
 * desequilibrios. Maneiras de o numero sair errado sem nada ficar vermelho: instante sem leitura vira ZERO; o fim do dia
 * ("00:00" do dia seguinte no bruto) vai para o comeco da grade ou some; tensao fase-neutro publicada como de linha; kW no
 * lugar de MW; fase trocada; grade cortada no ultimo instante dos trafos, ou esticada pela soma; medidor faltando; e o ponto
 * 6233 rotulado "soma dos 22 circuitos" depois que a Way2 mudar o que ele e.
 *
 * 🔴 A REFERENCIA E INDEPENDENTE: refeita do bruto aqui, sem a lib; os nomes dos circuitos vem de uma lista DECLARADA aqui
 * (nao do mapa do gen-executivo, que e de onde a lib os le). Ela e conferida contra valores feitos A MAO nos casos forjados.
 *
 * DUAS FOLGAS, cada uma da sua cadeia:
 *   publicado x bruto   a do arredondamento: c casas -> 0,5·10^-c (+1e-9);
 *   o rotulo da soma    no BRUTO, 6233 contra a soma (P, Q, as tres correntes) ou a media (as tres tensoes) dos 22 no mesmo
 *                       instante: folga de ponto flutuante, 1e-6 relativo + 1e-6 absoluto (medido em 03/10: 3e-11).
 *
 * O ESTADO ANTES DA LIB. De 00:00 a ~00:10 o coletor grava o dia novo sem leitura nenhuma, e o gerador (certo) nao grava:
 * o produto e o de ontem. Isso e "nao se aplica", dito como tal. Produto de OUTRO dia com a fonte medindo, ou de outro
 * instante, e falha da rodada, dita com todas as letras — sem a lista de diferencas de grade que pareceria defeito da lib.
 * NADA A JULGAR NAO E PASSAR: conta o que comparou; contagem zero com dado presente reprova, e a soma sem instante em que
 * os 23 pontos mediram e declarada com o motivo.
 *
 *   node scripts/ensaio-portal-eletrico.js --lib       casos forjados, valores a mao, defeitos plantados (cada um com a
 *                                                      mensagem que tem de sair)
 *   node scripts/ensaio-portal-eletrico.js --produto   o portal_eletrico.json publicado contra o way2_eletrico.json do
 *                                                      mesmo job, refeito aqui
 *   LOCAL_PE=arq.json LOCAL_ELET=arq.json ... --produto  o mesmo, com arquivos locais (gzip pelos bytes 1f 8b)
 *   LIBPE=./lib/<copia>.js ... --lib                     a regra sobre outra versao da lib
 *
 * ⚠️ ONDE A REGRA SEGURA O BLOB: o gerador (gen-way2-recent.js) chama `confere` (abaixo) sobre o arquivo que acabou de montar,
 * contra a MESMA fonte, e nao grava se houver achado. Assim uma lib quebrada nao chega ao ar e o passo que segura o remendo
 * do executivo nao para. O --lib roda no fim do job e julga a regra em casos forjados.
 */
'use strict';
const https = require('https'), zlib = require('zlib'), fs = require('fs');
const R3 = 1.7320508075688772;

// ── a REFERENCIA, refeita do bruto sem a lib ──────────────────────────────────────────────────────────────────────────
const MEDIDORES = [6196, 6197]; for (let p = 6198; p <= 6219; p++) MEDIDORES.push(p);
const CIRC = MEDIDORES.slice(2);
const PIDS = [6196, 6197, 6233].concat(CIRC);
const CAMPOS = [['p', 'Demat', 1e-3, 3], ['q', 'Demre', 1e-3, 3], ['va', 'TensaoA', R3 / 1000, 3], ['vb', 'TensaoB', R3 / 1000, 3],
  ['vc', 'TensaoC', R3 / 1000, 3], ['ia', 'CorrenteA', 1, 1], ['ib', 'CorrenteB', 1, 1], ['ic', 'CorrenteC', 1, 1]];
// 🔴 os nomes ESPERADOS, declarados: a ordem do circuito dentro da usina (o mapa do gen-executivo em 04/10/2026). Mudou o
//    mapa, este ensaio tem de doer — e quem o atualiza confere a lista a mao.
const NOMES = { 6196: 'SE · TR1', 6197: 'SE · TR2', 6233: 'soma dos 22 circuitos' };
[['M1', [6198, 6199, 6200]], ['M2', [6201, 6202]], ['M3', [6203, 6204, 6205]], ['M4', [6206, 6207, 6208]], ['M5', [6209, 6210, 6211]],
  ['M6', [6212, 6213, 6214]], ['M7', [6215]], ['M8', [6216, 6217, 6218]], ['M9', [6219]]]
  .forEach(([u, ps]) => ps.forEach((p, i) => { NOMES[p] = u + ' · C' + (i + 1); }));

function refIndex(elet) {
  const dia = String(elet.dataInicio || '').slice(0, 10), I = {};
  for (const s of elet.dados || []) {
    const m = {};
    for (const v of s.valores || []) {
      if (!v || v.valor == null) continue;
      let h = v.data.slice(11, 16);
      if (v.data.slice(0, 10) > dia && h === '00:00') h = '24:00';   // o fim do dia
      else if (v.data.slice(0, 10) !== dia) continue;
      m[h] = v.valor;
    }
    (I[s.pontoId] = I[s.pontoId] || {})[s.nomeGrandeza] = m;
  }
  return { dia, I };
}
const min = (h) => +h.slice(0, 2) * 60 + +h.slice(3, 5);
const hm = (m) => m === 1440 ? '24:00' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');

// o rotulo "soma dos 22 circuitos" e uma AFIRMACAO sobre a Way2, conferida no BRUTO
function confereSoma(I, f, cont) {
  let n = 0;
  const horas = Object.keys((I[6233] || {}).Demat || {});
  for (const h of horas) {
    for (const [, g] of CAMPOS) {
      const v = ((I[6233] || {})[g] || {})[h], vs = CIRC.map(p => ((I[p] || {})[g] || {})[h]);
      if (v == null || vs.some(x => x == null)) continue;
      const media = /^Tensao/.test(g), ag = vs.reduce((a, b) => a + b, 0) / (media ? 22 : 1);
      n++;
      if (Math.abs(v - ag) > 1e-6 * Math.abs(ag) + 1e-6) {
        f.push('6233 ' + h + ' ' + g + ': ' + v + ' e a ' + (media ? 'media' : 'soma') + ' dos 22 da ' + ag + ' — o ponto deixou de ser a soma; o rotulo mente');
        return n;
      }
    }
  }
  cont.soma = n;
  return n;
}

// o arquivo contra a fonte. `f` recebe os achados; o retorno diz em que estado a rodada estava
function confere(pe, elet, f, cont) {
  cont = cont || {};
  cont.n = 0; cont.soma = 0;
  const { dia, I } = refIndex(elet);
  let ult = 0;
  for (const p of MEDIDORES) for (const h of Object.keys((I[p] || {}).Demat || {})) ult = Math.max(ult, min(h));
  if (!ult) return 'sem-leitura';                       // dia novo, ninguem mediu: o gerador (certo) nao grava
  if (!pe) { f.push('a fonte tem leitura ate ' + hm(ult) + ' e o arquivo nao existe'); return 'falha'; }
  if (pe.dia !== dia) { f.push('o arquivo e de ' + pe.dia + ' e a fonte de ' + dia + ' ja tem leitura ate ' + hm(ult) + ': o arquivo NAO foi regravado nesta rodada'); return 'falha'; }
  if (pe.hora !== hm(ult)) { f.push('o arquivo vai ate ' + pe.hora + ' e a fonte ate ' + hm(ult) + ': os dois sao de rodadas diferentes (arquivo nao regravado, ou fonte regravada depois)'); return 'falha'; }
  const grade = []; for (let m = 5; m <= ult; m += 5) grade.push(hm(m));
  if (JSON.stringify(pe.grade) !== JSON.stringify(grade)) f.push('grade com ' + (pe.grade || []).length + ' instantes (' + ((pe.grade || [])[0] || '—') + ' a ' + ((pe.grade || []).slice(-1)[0] || '—') + '), a fonte pede ' + grade.length + ' (00:05 a ' + grade.slice(-1)[0] + ')');
  if (pe.n !== grade.length) f.push('n ' + pe.n + ', a grade tem ' + grade.length);
  const M = pe.medidores || [];
  if (JSON.stringify(M.map(x => x.pid)) !== JSON.stringify(PIDS)) f.push('medidores ' + M.map(x => x.pid).join(',') + ' (esperava os 24 e a soma, nesta ordem)');
  for (const x of M) {
    if (x.nome !== NOMES[x.pid]) f.push(x.pid + ': nome ' + JSON.stringify(x.nome) + ', esperava ' + JSON.stringify(NOMES[x.pid]));
    if (!!x.soma !== (x.pid === 6233)) f.push(x.pid + ': marca de soma ' + !!x.soma);
    let ultH = null;
    for (const [k, g, fat, c] of CAMPOS) {
      const arr = x[k], src = (I[x.pid] || {})[g] || {};
      if (!Array.isArray(arr) || arr.length !== grade.length) { f.push(x.pid + '.' + k + ': lista de ' + (arr ? arr.length : 'nada') + ' (grade ' + grade.length + ')'); continue; }
      grade.forEach((h, i) => {
        const bruto = src[h], v = arr[i];
        if (bruto == null) { if (v != null) f.push(x.pid + '.' + k + ' ' + h + ': ' + v + ' onde a fonte nao mediu'); return; }
        if (k === 'p') ultH = h;
        cont.n++;
        if (v == null || Math.abs(v - bruto * fat) > 0.5 * 10 ** -c + 1e-9) f.push(x.pid + '.' + k + ' ' + h + ': ' + v + ', a fonte da ' + (bruto * fat).toFixed(c + 2));
      });
    }
    if (x.hora !== ultH) f.push(x.pid + ': hora ' + x.hora + ', a potencia ativa dele vai ate ' + ultH);
  }
  confereSoma(I, f, cont);
  return 'julgado';
}

// ── --lib: casos forjados, valores a mao, defeitos plantados ─────────────────────────────────────────────────────────────
const BASE = { Demat: 1500, Demre: -250, TensaoA: 20000, TensaoB: 19900, TensaoC: 20100, CorrenteA: 123.46, CorrenteB: 120, CorrenteC: 121 };
const SOMADOS = ['Demat', 'Demre', 'CorrenteA', 'CorrenteB', 'CorrenteC'];
// `horas(pid, grandeza)` decide quais instantes cada ponto tem; `soma6233(g, v)` o que o ponto calculado vale
function forja(horas, soma6233) {
  const dia = '2026-10-04', dados = [];
  for (const p of PIDS) for (const [g, v] of Object.entries(BASE)) {
    const val = p === 6233 ? soma6233(g, v) : v;
    dados.push({ pontoId: p, nomeGrandeza: g, valores: horas(p, g).map(h => (h === '24:00'
      ? { data: '2026-10-05T00:00:00', valor: val } : { data: dia + 'T' + h + ':00', valor: val })) });
  }
  return { dataInicio: dia + 'T00:00:00', dados };
}
const somaCerta = (g, v) => SOMADOS.includes(g) ? v * 22 : v;
// CASO A: um CIRCUITO decide o fim da grade (e no 24:00, o "00:00" do dia seguinte); os trafos terminam antes; o TR1 sem a
//         potencia das 00:10 (null, nunca zero)
const horasA = (p, g) => p === 6205 ? ['00:05', '00:10', '00:15', '24:00']
  : (p === 6196 && g === 'Demat') ? ['00:05', '00:15'] : ['00:05', '00:10', '00:15'];
// CASO B: os circuitos terminam 00:15, o TR1 00:20, e a SOMA tem um instante depois de todos (00:30): ela nao estica a grade
const horasB = (p) => p === 6196 ? ['00:05', '00:10', '00:15', '00:20'] : p === 6233 ? ['00:05', '00:10', '00:15', '00:30'] : ['00:05', '00:10', '00:15'];

function modoLib() {
  const L = require(process.env.LIBPE || './lib/portal-eletrico.js');
  const casos = [['A', forja(horasA, somaCerta)], ['B', forja(horasB, somaCerta)]];
  const f = [], R = {};
  for (const [nome, elet] of casos) {
    const pe = L.monta(elet, null), cont = {};
    R[nome] = { pe, elet };
    // a lib sem mapa nomeia "circuito <pid>"; o ensaio exige os nomes reais, entao o caso forjado os recebe do mapa declarado
    if (pe) pe.medidores.forEach(m => { if (m.pid >= 6198 && m.pid <= 6219 && m.nome === 'circuito ' + m.pid) m.nome = NOMES[m.pid]; });
    const g = []; const st = confere(pe, elet, g, cont);
    if (st !== 'julgado' || !cont.n || !cont.soma) g.push('caso ' + nome + ': estado ' + st + ', ' + cont.n + ' valores, ' + cont.soma + ' somas');
    g.forEach(x => f.push('caso ' + nome + ' · ' + x));
    R[nome].cont = cont;
  }
  const A = R.A.pe, B = R.B.pe, med = (o, pid) => o.medidores.find(x => x.pid === pid);
  const mao = [['A grade', A.grade.length, 288], ['A fim', A.grade[287], '24:00'], ['A 6205 p 24:00', med(A, 6205).p[287], 1.5],
    ['A TR2 q 00:05', med(A, 6197).q[0], -0.25], ['A TR2 va', med(A, 6197).va[0], 34.641], ['A TR2 vb', med(A, 6197).vb[0], 34.468],
    ['A TR2 vc', med(A, 6197).vc[0], 34.814], ['A TR2 ia', med(A, 6197).ia[0], 123.5], ['A TR1 p 00:10', med(A, 6196).p[1], null],
    ['A TR1 q 00:10', med(A, 6196).q[1], -0.25], ['A TR1 hora', med(A, 6196).hora, '00:15'], ['A 6205 hora', med(A, 6205).hora, '24:00'],
    ['A soma p', med(A, 6233).p[0], 33], ['A soma va', med(A, 6233).va[0], 34.641],
    ['B grade', B.grade.length, 4], ['B fim', B.grade[3], '00:20'], ['B soma p 00:20', med(B, 6233).p[3], null]];
  for (const [n, a, b] of mao) if (a !== b) f.push('a mao · ' + n + ': ' + a + ', esperava ' + b);
  if (f.length) { console.log('REPROVADO nos casos forjados:\n  ' + f.slice(0, 20).join('\n  ')); process.exit(1); }
  console.log('casos forjados: ' + (R.A.cont.n + R.B.cont.n) + ' valores e ' + (R.A.cont.soma + R.B.cont.soma) + ' conferencias da soma batem, inclusive os ' + mao.length + ' feitos a mao');

  // defeitos plantados: cada um tem de reprovar COM A SUA mensagem
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const ks = Object.keys(L.GR || { p: 1, q: 1, va: 1, vb: 1, vc: 1, ia: 1, ib: 1, ic: 1 });
  const plantas = [
    ['instante sem leitura vira zero', 'A', o => { med(o, 6196).p[1] = 0; }, /6196\.p 00:10: 0 onde a fonte nao mediu/],
    ['tensao fase-neutro como de linha', 'A', o => { med(o, 6197).va = med(o, 6197).va.map(v => v == null ? v : Math.round(v / R3 * 1000) / 1000); }, /6197\.va .*a fonte da 34\.641/],
    ['kW no lugar de MW', 'A', o => { med(o, 6198).p = med(o, 6198).p.map(v => v == null ? v : v * 1000); }, /6198\.p 00:05: 1500, a fonte da 1\.5/],
    ['fases trocadas', 'A', o => { const m = med(o, 6199); const t = m.va; m.va = m.vb; m.vb = t; }, /6199\.va 00:05: 34\.468/],
    ['fim do dia no comeco', 'A', o => { o.grade = ['00:00'].concat(o.grade.slice(0, -1)); }, /grade com 288 instantes \(00:00 a /],
    ['fim do dia descartado', 'A', o => { o.grade = o.grade.slice(0, -1); o.n--; o.medidores.forEach(m => ks.forEach(k => m[k].pop())); }, /grade com 287 instantes/],
    ['medidor faltando', 'A', o => { o.medidores.splice(5, 1); }, /esperava os 24 e a soma/],
    ['nome de circuito trocado', 'A', o => { med(o, 6200).nome = 'M1 · C1'; }, /6200: nome "M1 · C1", esperava "M1 · C3"/],
    ['soma sem a marca', 'A', o => { delete med(o, 6233).soma; }, /6233: marca de soma false/],
    ['corrente de fase somada no lugar da fase', 'A', o => { const m = med(o, 6200); m.ia = m.ia.map((v, i) => v == null ? v : Math.round((v + m.ib[i] + m.ic[i]) * 10) / 10); }, /6200\.ia 00:05: 364\.5/],
    ['grade esticada pela soma', 'B', o => { o.grade.push('00:25', '00:30'); o.n += 2; o.hora = '00:30'; o.medidores.forEach(m => ks.forEach(k => m[k].push(null, null))); }, /arquivo vai ate 00:30 e a fonte ate 00:20/]
  ];
  let ok = 0;
  for (const [nome, caso, mexe, msg] of plantas) {
    const o = clone(R[caso].pe); mexe(o);
    const g = []; confere(o, R[caso].elet, g, {});
    if (g.some(x => msg.test(x))) ok++;
    else console.log('  NAO REPROVOU COMO DEVIA: ' + nome + (g.length ? ' (saiu: ' + g[0] + ')' : ' (nenhum achado)'));
  }
  // o ROTULO: uma fonte em que o 6233 deixou de ser a soma, com o produto fiel a ela (a lib so copia). Tem de sair "o rotulo mente".
  const desvios = [['P +5 kW', (g, v) => g === 'Demat' ? v * 22 + 5 : somaCerta(g, v)],
    ['tensao B fora da media', (g, v) => g === 'TensaoB' ? v + 2 : somaCerta(g, v)],
    ['corrente C pela metade', (g, v) => g === 'CorrenteC' ? v * 11 : somaCerta(g, v)]];
  for (const [nome, s] of desvios) {
    const elet = forja(horasA, s), pe = L.monta(elet, null);
    pe.medidores.forEach(m => { if (m.pid >= 6198 && m.pid <= 6219) m.nome = NOMES[m.pid]; });
    const g = []; confere(pe, elet, g, {});
    if (g.some(x => /o rotulo mente/.test(x))) ok++; else console.log('  NAO REPROVOU COMO DEVIA: soma · ' + nome + (g.length ? ' (saiu: ' + g[0] + ')' : ''));
  }
  // o ESTADO: dia novo sem leitura e "nao se aplica"; produto de ontem com a fonte medindo e falha da rodada
  const vazio = { dataInicio: '2026-10-05T00:00:00', dados: PIDS.map(p => ({ pontoId: p, nomeGrandeza: 'Demat', valores: [{ data: '2026-10-05T00:05:00', valor: null }] })) };
  const g1 = [], g2 = [];
  if (confere(A, vazio, g1, {}) === 'sem-leitura' && !g1.length) ok++; else console.log('  NAO REPROVOU COMO DEVIA: dia novo sem leitura virou ' + (g1[0] || 'julgado'));
  const amanha = JSON.parse(JSON.stringify(R.A.elet).replace(/2026-10-05/g, '2026-10-06').replace(/2026-10-04/g, '2026-10-05'));
  if (confere(A, amanha, g2, {}) === 'falha' && /NAO foi regravado/.test(g2[0] || '')) ok++; else console.log('  NAO REPROVOU COMO DEVIA: produto de ontem com a fonte medindo');
  const total = plantas.length + desvios.length + 2;
  if (ok !== total) { console.log('REPROVADO: ' + (total - ok) + ' de ' + total + ' defeitos/estados nao sairam como deviam'); process.exit(1); }
  console.log('defeitos plantados e estados: ' + ok + ' de ' + total + ' com a mensagem certa');
}

// ── --produto ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function le(nome, local) {
  const dec = (b) => JSON.parse(((b[0] === 0x1f && b[1] === 0x8b) ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
  if (local) return Promise.resolve(dec(fs.readFileSync(local)));
  const BASE_DADOS = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
  return new Promise((ok, ko) => https.get(BASE_DADOS + nome + '?t=' + Date.now(), { headers: { 'accept-encoding': 'gzip' } }, res => {
    if (res.statusCode === 404) { res.resume(); return ok(null); }
    if (res.statusCode !== 200) { res.resume(); return ko(new Error(nome + ' HTTP ' + res.statusCode)); }
    const ch = []; res.on('data', c => ch.push(c)); res.on('end', () => { try { ok(dec(Buffer.concat(ch))); } catch (e) { ko(e); } });
  }).on('error', ko));
}
async function modoProduto() {
  const [pe, elet] = await Promise.all([le('portal_eletrico.json', process.env.LOCAL_PE), le('way2_eletrico.json', process.env.LOCAL_ELET)]);
  if (!elet) { console.log('REPROVADO: way2_eletrico.json ausente'); process.exit(1); }
  const f = [], cont = {};
  const st = confere(pe, elet, f, cont);
  if (st === 'sem-leitura') { console.log('nao se aplica: o dia ' + String(elet.dataInicio).slice(0, 10) + ' ainda nao tem leitura de nenhum medidor (o arquivo e o de ' + (pe ? pe.dia : '—') + ')'); return; }
  if (st === 'julgado' && !cont.n) f.push('nada comparado com a fonte tendo dado');
  if (f.length) { console.log('REPROVADO (' + f.length + ' achados):\n  ' + f.slice(0, 25).join('\n  ')); process.exit(1); }
  console.log('portal_eletrico.json · ' + pe.dia + ' ate ' + pe.hora + ' · ' + cont.n + ' valores conferidos contra o way2_eletrico.json · '
    + (cont.soma ? cont.soma + ' conferencias no bruto: o 6233 e a soma (media, na tensao) dos 22' : 'soma NAO conferida: nenhum instante em que o 6233 e os 22 circuitos mediram juntos'));
}

module.exports = { confere };
if (require.main === module) {
  const modo = process.argv[2];
  if (modo === '--lib') modoLib();
  else if (modo === '--produto') modoProduto().catch(e => { console.log('ERRO: ' + e.message); process.exit(1); });
  else { console.log('uso: --lib | --produto'); process.exit(2); }
}
