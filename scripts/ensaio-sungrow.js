/*
 * ensaio-sungrow.js — prova o gerador do logger Sungrow (gen-sungrow.js, lib-sungrow.js, lib-zip.js), sem rede.
 *
 * 1 · o leitor de zip: entradas guardadas e com deflate, metodo desconhecido e zip truncado ESTOURAM com o nome.
 * 2 · o leitor de CSV: coluna pelo NOME (a mesma leitura com as colunas embaralhadas), coluna faltando estoura com o nome,
 *     leitura-sentinela (65535) vira nulo, e os CSV vazios de jan-mar (carimbo de 1969) nao viram dia.
 * 3 · o gerador de ponta a ponta, com a armadilha que o dado real tem: dois inversores do TS6 dentro da pasta do TS5, e
 *     o logger do TS6 (com o PID) tambem na pasta do TS5. Cada inversor vai para a posicao do CONTADOR DE VIDA (igual ao
 *     do export do SCADA), o logger e o PID vao para o TS cuja soma de potencia instantanea e a dele, a conferencia
 *     logger x SCADA fecha em 1,000, e a segunda rodada (nada novo) sai identica.
 * 4 · plantios no gerador: identificar pela PASTA e posicionar o logger pela PASTA tem de reprovar.
 *
 * uso: node scripts/ensaio-sungrow.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const { entradas } = require('./lib-zip.js');
const S = require('./lib-sungrow.js');

const falhas = [];
const ok = (c, m) => { if (!c) falhas.push(m); console.log((c ? '  ok   ' : '  FALHA ') + m); };
const estoura = (f, re) => { try { f(); return false; } catch (e) { return re.test(e.message); } };

/* um zip minimo (local + diretorio central), metodo 0 ou 8 por entrada */
function crc32(b) { let c, t = crc32.t || (crc32.t = Array.from({ length: 256 }, (x, n) => { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
  let x = 0xFFFFFFFF; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xFFFFFFFF) >>> 0; }
function zip(arqs) {
  const loc = [], cen = []; let off = 0;
  for (const a of arqs) {
    const nome = Buffer.from(a.nome), dados = Buffer.from(a.dados), comp = a.metodo === 8 ? zlib.deflateRawSync(dados) : dados;
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(a.metodo, 8);
    h.writeUInt32LE(crc32(dados), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(nome.length, 26);
    loc.push(h, nome, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(a.metodo, 10);
    c.writeUInt32LE(crc32(dados), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, nome); off += 30 + nome.length + comp.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(arqs.length, 8); e.writeUInt16LE(arqs.length, 10);
  e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cb, e]);
}

console.log('1 · lib-zip');
{ const z = zip([{ nome: 'hiscsv/a.csv', dados: 'abc,1\n', metodo: 0 }, { nome: 'hiscsv/b.csv', dados: 'x'.repeat(5000), metodo: 8 }]);
  const es = entradas(z, 't.zip');
  ok(es.length === 2 && es[0].dados.toString() === 'abc,1\n' && es[1].dados.toString() === 'x'.repeat(5000), 'guardado e deflate lidos');
  const z12 = Buffer.from(z); z12.writeUInt16LE(12, z12.indexOf(Buffer.from([0x50, 0x4b, 1, 2])) + 10);
  ok(estoura(() => entradas(z12, 't12.zip'), /t12\.zip: metodo de compressao 12/), 'metodo desconhecido estoura com o nome do zip');
  ok(estoura(() => entradas(z.slice(0, z.length - 30), 'tc.zip'), /tc\.zip/), 'zip truncado estoura com o nome do zip'); }

/* ---------- os CSV sinteticos, no formato do logger ---------- */
const INV_COLS = ['Horário', 'Potência ativa nominal', 'Modo de potência limitada', 'Geração de energia ao longo do dia', 'Geração total',
  'Temperatura de ar interna', 'Potência CC total', 'Potência ativa total', 'Potência ativa total', 'Status de operação do inversor',
  'Código de falha', 'Impedância paralela em relação à terra', 'Tempo de operação diário', 'Tensão de pólo negativo / terra',
  'Tensão do barramento', 'Tensão MPPT1', 'Estado de trabalho PID', 'Código de falha PID', 'Eficiência do inversor'];
const DIAS = ['2026-09-28', '2026-09-29', '2026-09-30'];
const HH = []; for (let m = 0; m < 1440; m += 5) HH.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
const perfil = (k, f) => { const h = k / 12; return h < 6 || h > 18 ? 0 : Math.round(300000 * f * Math.sin(Math.PI * (h - 6) / 12) ** 2); };  // W
function csvInversor(vida0, f, ordem) {
  const linhas = [];
  let vida = vida0;
  for (const d of DIAS) { let dia = 0;
    HH.forEach((h, k) => { const p = perfil(k, f); const e = p / 12 / 1000; vida += e; dia += e;
      const v = { 'Horário': d + ' ' + h + ':00', 'Potência ativa nominal': 3200, 'Modo de potência limitada': 0,
        'Geração de energia ao longo do dia': Math.round(dia * 10), 'Geração total': Math.round(vida * 10), 'Temperatura de ar interna': 450,
        'Potência CC total': Math.round(p * 1.015), 'Potência ativa total': p, 'Status de operação do inversor': p ? 4 : 0, 'Código de falha': 0,
        'Impedância paralela em relação à terra': 500, 'Tempo de operação diário': p ? 1 : 0, 'Tensão de pólo negativo / terra': -7000,
        'Tensão do barramento': 13000, 'Tensão MPPT1': 13000, 'Estado de trabalho PID': 0, 'Código de falha PID': 0, 'Eficiência do inversor': 9870 };
      linhas.push(ordem.map((c, i) => (c === 'Potência ativa total' && ordem.indexOf(c) !== i ? 0 : v[c])).join(', ')); }); }
  return '﻿' + ordem.join(',') + '\n' + linhas.join('\n') + '\n';
}

console.log('\n2 · lib-sungrow');
{ const a = S.le(csvInversor(800000, 1, INV_COLS)), embaralhado = [INV_COLS[0], ...INV_COLS.slice(1).reverse()];
  const b = S.le(csvInversor(800000, 1, embaralhado));
  const da = S.diaInversor(a.cab, a.linhas, 'a'), db = S.diaInversor(b.cab, b.linhas, 'b');
  const sem = (x) => JSON.stringify(x.map((o) => { const c = { ...o }; delete c._p; return c; }));
  ok(S.tipo(a.cab) === 'inversor' && sem(da) === sem(db) && da.length === 3, 'colunas embaralhadas, a mesma leitura (3 dias)');
  let eEsp = 0; HH.forEach((h, k) => { eEsp += perfil(k, 1) / 12 / 1000; });
  ok(Math.abs(da[1].e - eEsp) < 0.1 && da[1].p_max === 300 && da[1].ef_med === 98.7 && da[1].t_max === 45 && da[1].vneg_min === -700,
    'escalas: energia ' + da[1].e + ' kWh (esperado ' + eEsp.toFixed(1) + '), 300 kW, 98,7 %, 45 °C, -700 V');
  const sem1 = S.le(csvInversor(800000, 1, INV_COLS.filter((c) => c !== 'Temperatura de ar interna')));
  ok(estoura(() => S.diaInversor(sem1.cab, sem1.linhas, 'z.csv'), /z\.csv: coluna "Temperatura de ar interna" ausente/), 'coluna faltando estoura com o nome');
  ok(S.num('65535') === null && S.num(' 32767 ') === null && S.num('15') === 15, 'leitura-sentinela vira nulo');
  ok(S.le('Horário, x\n1969-12-31 21:00:00, 1\n').linhas.length === 0, 'CSV de 1969 (os zips vazios de jan-mar) nao vira dia'); }

/* ---------- 3 · o gerador de ponta a ponta ---------- */
console.log('\n3 · gen-sungrow de ponta a ponta');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'sungrow-'));
const RAW = path.join(raiz, 'raw'), SC = path.join(raiz, 'scada'), OUT = path.join(raiz, 'out');
for (const d of [RAW, SC, OUT]) fs.mkdirSync(d);
// posicoes reais: M1/TS5/INV01-02 e M1/TS6/INV01-02; na PASTA, os quatro estao no TS05 (a troca do M1)
const INVS = [{ sn: 'A0000000501', pos: 'M1/TS5/INV01', v0: 800000, f: 1.00 }, { sn: 'A0000000502', pos: 'M1/TS5/INV02', v0: 810000, f: 0.97 },
  { sn: 'A0000000601', pos: 'M1/TS6/INV01', v0: 820000, f: 0.95 }, { sn: 'A0000000602', pos: 'M1/TS6/INV02', v0: 830000, f: 0.92 }];
const mk = (p) => fs.mkdirSync(p, { recursive: true });
mk(path.join(RAW, 'M10', 'TS05', '01 A 05')); mk(path.join(RAW, 'M10', 'TS05', 'PID 100'));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '28.09 A 30.09.zip'),
  zip(INVS.map((x, i) => ({ nome: 'hiscsv/HIS_' + x.sn + '_202609280000_202609302355.csv', dados: csvInversor(x.v0, x.f, INV_COLS), metodo: i % 2 ? 8 : 0 }))));
// o logger e o PID do TS6, na pasta do TS05: a potencia do logger e a SOMA dos dois inversores do TS6
const EST_COLS = ['Horário', 'Utilização da CPU', 'Valor da amostra PT 1', 'Valor da amostra PT 2', 'Potência ativa total',
  'Valor de potência FV ativa definida', 'Taxa de potência ativa', 'Quantidade de inversores', 'Número de dispositivos conectados à rede', 'Máx. potência ativa nominal total'];
const est = [];
for (const d of DIAS) HH.forEach((h, k) => { const p = perfil(k, 0.95) + perfil(k, 0.92);
  est.push([d + ' ' + h + ':00', 20, 40, 41, p, 7040, 1000, 2, 2, 704].join(', ')); });
const PID_H = ['Horário', ...Object.values(S.PID_COLS)];
const pid = []; for (const d of DIAS) HH.forEach((h, k) => pid.push([d + ' ' + h + ':00', 75, k > 240 ? 300 : 0, k > 240 ? 2 : 0, 45, 0, 0, 85].join(', ')));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', 'PID 100', '28.09 A 30.09.zip'), zip([
  { nome: 'hiscsv/HIS_B0000000006_202609280000_202609302355.csv', dados: '﻿' + EST_COLS.join(',') + '\n' + est.join('\n') + '\n', metodo: 8 },
  { nome: 'hiscsv/HIS_6_8510_202609280000_202609302355.csv', dados: '﻿' + PID_H.join(',') + '\n' + pid.join('\n') + '\n', metodo: 8 }]));
// o export do SCADA de cada dia: o contador de vida de cada POSICAO no fim do dia; e o historico da energia do dia
const fimDia = (x, di) => { let v = x.v0; for (let j = 0; j <= di; j++) HH.forEach((h, k) => { v += perfil(k, x.f) / 12 / 1000; }); return Math.round(v * 100) / 100; };
const eDia = (x) => { let e = 0; HH.forEach((h, k) => { e += perfil(k, x.f) / 12 / 1000; }); return Math.round(e * 100) / 100; };
DIAS.forEach((d, di) => {
  const cols = ['Tempo', ...INVS.map((x) => { const [, ts, inv] = x.pos.split('/'); return 'UFV_MRT10_' + ts + '_' + inv + '_MRT10 ' + ts + ' ' + inv + ' ENERGIA TOTAL GERADA'; })];
  const lin = [d + ' 12:00:00;' + INVS.map(() => '1').join(';'), d + ' 23:30:00;' + INVS.map((x) => String(fimDia(x, di)).replace('.', ',')).join(';')];
  fs.writeFileSync(path.join(SC, 'M10_ATT_' + d.replace(/-/g, '').replace(/(\d{6})(\d\d)/, (a, b, c) => b + String(Number(c) + 1).padStart(2, '0')) + '_034000.csv'), cols.join(';') + '\n' + lin.join('\n') + '\n');
});
fs.writeFileSync(path.join(raiz, 'inv_scada_hist.json'), JSON.stringify({ serie: DIAS.flatMap((d) => INVS.map((x) => { const [u, ts, inv] = x.pos.split('/'); return { dia: d, ufv: u, ts, inv, kwh: eDia(x) }; })) }));

function roda(gen) {
  const env = Object.assign({}, process.env, { LOCAL_RAW_DIR: RAW, LOCAL_SCADA_DIR: SC, LOCAL_OUT_DIR: OUT, LOCAL_INV_SCADA: path.join(raiz, 'inv_scada_hist.json') });
  return execFileSync('node', [gen || path.join(__dirname, 'gen-sungrow.js')], { env, encoding: 'utf8' });
}
const le = (n) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(OUT, n))).toString('utf8'));
function julga(rotulo) {
  const I = le('sg_ident.json').ident;
  const okId = INVS.every((x) => I[x.sn] && I[x.sn].pos === x.pos);
  const P = le('sg_pid_dia.json').serie, T = le('sg_ts_dia.json').serie;
  const okPid = P.length === 3 && P.every((x) => x.chave === 'M1/TS6/6' && x.ts_por === 'potencia') && T.every((x) => x.ts === 'TS6');
  return { okId, okPid, I, P, T, rotulo };
}
let log = roda();
let r = julga('gerador');
ok(r.okId, 'cada inversor na posicao do contador de vida, inclusive os dois do TS6 na pasta do TS5: '
  + INVS.map((x) => x.sn.slice(-3) + '→' + (r.I[x.sn] || {}).pos).join(' '));
ok(r.okPid, 'o logger e o PID da pasta do TS5 vao para o TS6, pela potencia: ' + [...new Set(r.P.map((x) => x.chave + ' (' + x.ts_por + ')'))].join(' '));
{ const p = r.P.find((x) => x.d === '2026-09-29');
  ok(p && p.min_saida === (288 - 241) * 5 && p.v_max === 300 && p.ini_saida === '20:05', 'PID: minutos com tensao de saida, maximo e inicio (' + (p && p.min_saida) + ' min)'); }
{ const c = le('sg_conf.json').serie;
  ok(c.length === 3 && c.every((x) => x.n === 4 && Math.abs(x.razao - 1) < 0.0005), 'conferencia logger x SCADA: 3 dias, 4 inversores, razao ' + c.map((x) => x.razao).join(' ')); }
{ const M1 = le('sg_inv_dia_M1.json').serie;
  ok(M1.length === 12 && M1.every((x) => x._p === undefined) && M1.every((x) => Math.abs(x.e - eDia(INVS.find((y) => y.sn === x.sn))) < 0.05),
    'sg_inv_dia_M1: 4 inversores x 3 dias, energia igual a do SCADA, sem a potencia de 5 min (so no historico interno)'); }
const antes = Object.fromEntries(fs.readdirSync(OUT).map((n) => [n, JSON.stringify(le(n), (k, v) => (k === 'gerado_em' ? undefined : v))]));
log = roda();
ok(/novos ou mudados: 0/.test(log), 'segunda rodada: nenhum zip novo');
ok(fs.readdirSync(OUT).every((n) => JSON.stringify(le(n), (k, v) => (k === 'gerado_em' ? undefined : v)) === antes[n]), 'segunda rodada: os ' + Object.keys(antes).length + ' produtos identicos');

/* ---------- 4 · plantios ---------- */
console.log('\n4 · plantios no gerador');
const src = fs.readFileSync(path.join(__dirname, 'gen-sungrow.js'), 'utf8');
function planta(nome, de, para, julgaFn) {
  if (src.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  const g = path.join(__dirname, '_plantio_sungrow.js');
  fs.writeFileSync(g, src.split(de).join(para));
  for (const n of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, n));
  try { roda(g); const r2 = julga(nome); ok(!julgaFn(r2), 'plantio "' + nome + '" reprova'); } finally { fs.unlinkSync(g); }
}
planta('identificar pela pasta', "if (hits.length === 1) { const a = ident[sn];",
  "if (hits.length === 1) { hits[0] = o.ufv + '/' + o.pasta + '/' + hits[0].split('/')[2]; } if (hits.length === 1) { const a = ident[sn];", (x) => x.okId);
planta('logger pela pasta', "tsDoLogger[sn] = H.tsLogger[sn] || { ts: o.pasta, por: 'pasta', dias: 0, de: dias };",
  "tsDoLogger[sn] = { ts: o.pasta, por: 'pasta', dias: 0, de: dias };", (x) => x.okPid);

fs.rmSync(raiz, { recursive: true, force: true });
console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-sungrow: tudo ok');
process.exit(falhas.length ? 1 : 0);
