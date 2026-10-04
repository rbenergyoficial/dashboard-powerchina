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
 *     Lote 1b (03/10/2026): o logger que para as 16:05 e o dia de uma amostra so saem PARCIAIS e ficam fora da
 *     conferencia; o inversor que so existe num export mais velho que os 4 da passada normal e achado pela BUSCA FUNDA, que
 *     nao se repete sem dado novo; o PID sai sem os minutos com tensao; o historico de esquema 1 e relido inteiro.
 * 4 · plantios no gerador, cada um rodando o CENARIO inteiro (cinco rodadas): identificar pela PASTA, logger pela PASTA,
 *     presumir o dia inteiro, ver a janela so numa ponta (partida ou parada), tratar o inversor parado como parcial, tratar
 *     a linha sem t0/t1 como inteira, tirar a busca funda, tirar o teto ou a parada da busca, nunca repetir ou sempre
 *     repetir a busca, migrar mantendo o historico velho: todos tem de reprovar.
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
// `dias` e `corte` ([primeiro, ultimo] indice de 5 min lido em cada dia) fazem o logger que entra ou para no meio do dia
function csvInversor(vida0, f, ordem, dias, corte) {
  const linhas = [];
  let vida = vida0;
  for (const d of (dias || DIAS)) { let dia = 0;
    HH.forEach((h, k) => { if (corte && corte[d] && (k < corte[d][0] || k > corte[d][1])) return;
      const p = perfil(k, f); const e = p / 12 / 1000; vida += e; dia += e;
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
process.on('exit', () => { if (!process.env.MANTEM) fs.rmSync(raiz, { recursive: true, force: true }); else console.log(raiz); });
const RAW = path.join(raiz, 'raw'), SC = path.join(raiz, 'scada'), OUT = path.join(raiz, 'out');
for (const d of [RAW, SC, OUT]) fs.mkdirSync(d);
const mk = (p) => fs.mkdirSync(p, { recursive: true });
const diasEntre = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const carimboDe = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10).replace(/-/g, '');  // export da madrugada seguinte
// o contador de vida no fim do dia `d` de um inversor cujo perfil comeca em `x.dia0` (antes disso, parado em v0)
const fimDia = (x, di) => { let v = x.v0; for (let j = 0; j <= di; j++) HH.forEach((h, k) => { v += perfil(k, x.f) / 12 / 1000; }); return Math.round(v * 100) / 100; };
const vidaEm = (x, d) => fimDia(x, diasEntre(x.dia0, d));
const eDia = (x) => { let e = 0; HH.forEach((h, k) => { e += perfil(k, x.f) / 12 / 1000; }); return Math.round(e * 100) / 100; };

// posicoes reais: M1/TS5/INV01-02 e M1/TS6/INV01-02; na PASTA, os quatro estao no TS05 (a troca do M1)
const INVS = [{ sn: 'A0000000501', pos: 'M1/TS5/INV01', v0: 800000, f: 1.00 }, { sn: 'A0000000502', pos: 'M1/TS5/INV02', v0: 810000, f: 0.97 },
  { sn: 'A0000000601', pos: 'M1/TS6/INV01', v0: 820000, f: 0.95 }, { sn: 'A0000000602', pos: 'M1/TS6/INV02', v0: 830000, f: 0.92 }];
// o inversor PARADO o dia inteiro, lido inteiro pelo logger, num dia em que a usina gerou: tem de sair parcial = false
const PARADO = { sn: 'A0000000504', pos: 'M1/TS5/INV04', v0: 850000, f: 0 };
/* o inversor que o logger PAROU de ler (o A23B1707347 do M5/TS4, ate 26/09): so tem 25/09, que esta num export MAIS VELHO
   que os 4 da passada normal */
const VELHO = { sn: 'A0000000503', pos: 'M1/TS5/INV03', v0: 840000, f: 0.90, dia0: '2026-09-25' };
for (const x of [...INVS, PARADO]) x.dia0 = DIAS[0];
const TODOS = [...INVS, PARADO, VELHO];
// um numero de serie que o SCADA nao tem, noutra usina (M6): fica sem posicao, e a busca dele e LEMBRADA
const NUNCA = 'A0000000999';
mk(path.join(RAW, 'M10', 'TS05', '01 A 05')); mk(path.join(RAW, 'M10', 'TS05', 'PID 100')); mk(path.join(RAW, 'M06', 'TS01', '01 A 05'));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '28.09 A 30.09.zip'), zip([...INVS, PARADO].map((x, i) =>
  ({ nome: 'hiscsv/HIS_' + x.sn + '_202609280000_202609302355.csv', dados: csvInversor(x.v0, x.f, INV_COLS), metodo: i % 2 ? 8 : 0 }))));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '25.09.zip'), zip([
  { nome: 'hiscsv/HIS_' + VELHO.sn + '_202609250000_202609252355.csv', dados: csvInversor(VELHO.v0, VELHO.f, INV_COLS, ['2026-09-25']), metodo: 8 }]));
const zipNunca = (d) => zip([{ nome: 'hiscsv/HIS_' + NUNCA + '_' + d.replace(/-/g, '') + '0000_' + d.replace(/-/g, '') + '2355.csv',
  dados: csvInversor(990000 + diasEntre('2026-09-25', d) * 2000, 0.9, INV_COLS, [d]), metodo: 8 }]);
fs.writeFileSync(path.join(RAW, 'M06', 'TS01', '01 A 05', '25.09.zip'), zipNunca('2026-09-25'));
/* o logger PARCIAL, nos dois do TS5: 01/10 ate 16:05 (indice 193, como o M9 em 30/09), 02/10 so a amostra de 00:00 e
   03/10 a partir de 10:00 (indice 120: a manha nao foi lida) */
const PARC = { '2026-10-01': [0, 193], '2026-10-02': [0, 0], '2026-10-03': [120, 287] };
const TS5 = INVS.filter((x) => x.pos.startsWith('M1/TS5/'));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '01.10 A 03.10.zip'), zip(TS5.map((x) => ({ nome: 'hiscsv/HIS_' + x.sn + '_202610010000_202610032355.csv',
  dados: csvInversor(fimDia(x, 2), x.f, INV_COLS, Object.keys(PARC), PARC), metodo: 8 }))));
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
/* os exports do SCADA. M1: oito, de 24/09 a 01/10; a passada normal le os 4 mais novos (28/09 a 01/10). A busca funda do
   VELHO (ultimo dia 25/09, teto = carimbo de 27/09) PULA o de 27/09, le o de 26/09 (nao casa) e o de 25/09 (casa) e PARA:
   o de 24/09 nao e lido. M6: cinco, de 25 a 29/09, so com uma posicao que nao e o NUNCA; a busca le o de 25/09.
   Total da primeira rodada: 2 + 1 = 3 exports. Sem o teto seriam 4, sem a parada tambem 4 */
const exporta = (pref, d, cols, vals) => fs.writeFileSync(path.join(SC, pref + '_ATT_' + carimboDe(d) + '_034000.csv'),
  ['Tempo', ...cols].join(';') + '\n' + d + ' 12:00:00;' + vals.map(() => '1').join(';') + '\n' + d + ' 23:30:00;' + vals.map((v) => String(v).replace('.', ',')).join(';') + '\n');
const colDe = (x) => { const [, ts, inv] = x.pos.split('/'); return 'UFV_MRT10_' + ts + '_' + inv + '_MRT10 ' + ts + ' ' + inv + ' ENERGIA TOTAL GERADA'; };
for (let i = 0; i < 8; i++) { const d = new Date(Date.parse('2026-09-24T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
  exporta('M10', d, TODOS.map(colDe), TODOS.map((x) => vidaEm(x, d))); }
for (let i = 0; i < 5; i++) { const d = new Date(Date.parse('2026-09-25T00:00:00Z') + i * 864e5).toISOString().slice(0, 10);
  exporta('M06', d, ['UFV_MRT06_TS1_INV01_MRT06 TS1 INV01 ENERGIA TOTAL GERADA'], [700000 + i]); }
const hl = (d, x) => { const [u, ts, inv] = x.pos.split('/'); return { dia: d, ufv: u, ts, inv, kwh: eDia(x) }; };
fs.writeFileSync(path.join(raiz, 'inv_scada_hist.json'), JSON.stringify({ serie: [...DIAS.flatMap((d) => [...INVS, PARADO].map((x) => hl(d, x))),
  hl('2026-09-25', VELHO), ...Object.keys(PARC).flatMap((d) => TS5.map((x) => hl(d, x)))] }));

/* folgas, da resolucao: o logger grava o contador de vida em 0,1 kWh, e a energia do dia e a diferenca de duas leituras
   (meia unidade em cada ponta = 0,1 kWh); o esperado (eDia) e a energia publicada tem 2 casas (0,005 cada). A razao tem 4
   casas (0,00005) e, como razao de somas, erra no maximo o pior erro relativo de um inversor: TOL_E / a menor energia */
const TOL_E = 0.1 + 0.005 + 0.005;
const TOL_R = 0.00005 + TOL_E / Math.min(...[...INVS, VELHO].map(eDia));

function roda(gen) {
  const env = Object.assign({}, process.env, { LOCAL_RAW_DIR: RAW, LOCAL_SCADA_DIR: SC, LOCAL_OUT_DIR: OUT, LOCAL_INV_SCADA: path.join(raiz, 'inv_scada_hist.json') });
  return execFileSync('node', [gen], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const le = (n) => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(OUT, n))).toString('utf8'));
const grava = (n, o) => fs.writeFileSync(path.join(OUT, n), zlib.gzipSync(JSON.stringify(o)));
const semGerado = (n) => JSON.stringify(le(n), (k, v) => (k === 'gerado_em' ? undefined : v));
const lidosFundo = (log) => { const m = log.match(/busca funda: (\d+) export/); return m ? Number(m[1]) : 0; };

/* o CENARIO inteiro, cinco rodadas; o gerador de verdade e cada plantio passam por ele todo */
function cenario(gen) {
  const R = { txt: {} };
  for (const n of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, n));
  const novo = path.join(RAW, 'M06', 'TS01', '01 A 05', '26.09.zip');
  if (fs.existsSync(novo)) fs.unlinkSync(novo);
  try {
    // 1 · primeira rodada
    let log = roda(gen);
    const I = le('sg_ident.json'), P = le('sg_pid_dia.json').serie, T = le('sg_ts_dia.json').serie, C = le('sg_conf.json').serie;
    R.okId = TODOS.every((x) => I.ident[x.sn] && I.ident[x.sn].pos === x.pos);
    R.txt.id = TODOS.map((x) => x.sn.slice(-3) + '→' + (I.ident[x.sn] || {}).pos).join(' ');
    R.okBusca1 = lidosFundo(log) === 3;
    R.txt.busca1 = lidosFundo(log);
    R.okSemPos = I.sem_posicao.length === 1 && I.sem_posicao[0].sn === NUNCA && I.busca[NUNCA] === '2026-09-25' && Object.keys(I.busca).length === 1;
    R.okPid = P.length === 3 && P.every((x) => x.chave === 'M1/TS6/6' && x.ts_por === 'potencia') && T.every((x) => x.ts === 'TS6');
    R.txt.pid = [...new Set(P.map((x) => x.chave + ' (' + x.ts_por + ')'))].join(' ');
    const p29 = P.find((x) => x.d === '2026-09-29');
    R.okPidCampos = !!p29 && p29.v_max === 300 && !('min_saida' in p29) && !('ini_saida' in p29) && !('fim_saida' in p29);
    // a conferencia: os dias inteiros fecham em 1; os parciais do logger ficam FORA (n 0, razao nula), contados em n_parcial
    const cd = (d) => C.find((x) => x.d === d) || {};
    R.okConf = DIAS.every((d) => cd(d).n === 4 && cd(d).n_parcial === 0 && Math.abs(cd(d).razao - 1) <= TOL_R)
      && cd('2026-09-25').n === 1 && Math.abs(cd('2026-09-25').razao - 1) <= TOL_R
      && Object.keys(PARC).every((d) => cd(d).n === 0 && cd(d).n_parcial === 2 && cd(d).razao === null);
    R.txt.conf = C.map((x) => x.d.slice(5) + ' ' + x.n + '+' + x.n_parcial + ' ' + x.razao).join(' · ');
    const M1 = le('sg_inv_dia_M1.json').serie, ehParc = (x) => x.d in PARC;
    R.okInv = M1.length === 22 && M1.every((x) => x._p === undefined) && M1.every((x) => x.parcial === ehParc(x))
      && M1.filter((x) => !ehParc(x)).every((x) => Math.abs(x.e - eDia(TODOS.find((y) => y.sn === x.sn))) <= TOL_E);
    R.okParado = M1.filter((x) => x.sn === PARADO.sn).length === 3 && M1.filter((x) => x.sn === PARADO.sn).every((x) => x.ini === null && x.parcial === false);
    R.txt.inv = M1.filter(ehParc).map((x) => x.d.slice(5) + ' ' + x.t0 + '-' + x.t1).join(' ');
    const antes = Object.fromEntries(fs.readdirSync(OUT).map((n) => [n, semGerado(n)]));
    // 2 · segunda rodada: nada novo
    log = roda(gen);
    R.okIdem = /novos ou mudados: 0/.test(log) && fs.readdirSync(OUT).every((n) => semGerado(n) === antes[n]);
    R.okNaoRepete = lidosFundo(log) === 0;
    // 3 · migracao por MARCA, com o esquema 1 FIEL: linhas sem t0/t1 e o PID com os minutos com tensao
    const h = le('sg_hist.json'); h.esquema = 1;
    for (const o of Object.values(h.inv)) for (const x of Object.values(o.dias)) { delete x.t0; delete x.t1; }
    for (const o of Object.values(h.pid)) for (const x of Object.values(o.dias)) Object.assign(x, { min_saida: 0, ini_saida: null, fim_saida: null });
    grava('sg_hist.json', h);
    log = roda(gen);
    R.okMigra = /esquema 1 -> 2: relendo todos os zips/.test(log) && /novos ou mudados: [1-9]/.test(log)
      && fs.readdirSync(OUT).every((n) => semGerado(n) === antes[n]);
    // 4 · dia novo do inversor sem posicao: a busca VOLTA (1 export do M6) e a memoria anda para o dia novo
    fs.writeFileSync(novo, zipNunca('2026-09-26'));
    log = roda(gen);
    R.okBuscaVolta = lidosFundo(log) === 1 && le('sg_ident.json').busca[NUNCA] === '2026-09-26';
    // 5 · linha sem t0/t1 (nao apurada) sai parcial nula e fora da conferencia
    const h2 = le('sg_hist.json'); delete h2.inv[INVS[0].sn].dias['2026-09-29'].t0; grava('sg_hist.json', h2);
    roda(gen);
    const l29 = le('sg_inv_dia_M1.json').serie.find((x) => x.sn === INVS[0].sn && x.d === '2026-09-29');
    const c29 = le('sg_conf.json').serie.find((x) => x.d === '2026-09-29');
    R.okNula = !!l29 && l29.parcial === null && c29.n === 3 && c29.n_parcial === 1;
  } catch (e) { R.erro = String(e.message).split('\n')[0]; }
  return R;
}

const R = cenario(path.join(__dirname, 'gen-sungrow.js'));
if (R.erro) ok(false, 'o gerador estourou: ' + R.erro);
ok(R.okId, 'cada inversor na posicao do contador de vida, inclusive os dois do TS6 na pasta do TS5 e o que so existe no export velho: ' + R.txt.id);
ok(R.okBusca1, 'busca funda: ' + R.txt.busca1 + ' exports lidos (esperado 3: o teto pula o de 27/09 e a busca para no primeiro casamento)');
ok(R.okSemPos, 'sem posicao: so o numero de serie que o SCADA nao tem, com a busca lembrada pelo ultimo dia do logger (25/09)');
ok(R.okPid, 'o logger e o PID da pasta do TS5 vao para o TS6, pela potencia: ' + R.txt.pid);
ok(R.okPidCampos, 'PID: tensao maxima 300 V, sem os minutos com tensao (esquema 2)');
ok(R.okConf, 'conferencia (folga ' + TOL_R.toFixed(6) + '): dias inteiros com razao 1; 01, 02 e 03/10 fora (n_parcial 2, razao nula): ' + R.txt.conf);
ok(R.okInv, 'sg_inv_dia_M1: 22 inversor-dias, parcial exatamente nos 6 de 01 a 03/10 (' + R.txt.inv + '), energia dos inteiros a ' + TOL_E.toFixed(2) + ' kWh do SCADA');
ok(R.okParado, 'o inversor parado o dia inteiro, lido inteiro, num dia em que a usina gerou: parcial = false');
ok(R.okIdem, 'segunda rodada: nenhum zip novo, produtos identicos');
ok(R.okNaoRepete, 'segunda rodada: a busca funda nao se repete (nenhum dado novo do inversor sem posicao)');
ok(R.okMigra, 'historico de esquema 1 FIEL (sem t0/t1, PID com minutos): relido inteiro, produtos identicos');
ok(R.okBuscaVolta, 'dia novo do inversor sem posicao: a busca volta (1 export) e a memoria anda para 26/09');
ok(R.okNula, 'linha sem t0/t1: parcial nula e fora da conferencia (29/09 com 3 + 1)');

/* ---------- 4 · plantios ---------- */
console.log('\n4 · plantios no gerador (cada um roda o cenario inteiro)');
const src = fs.readFileSync(path.join(__dirname, 'gen-sungrow.js'), 'utf8');
function planta(nome, de, para, chave) {
  if (src.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  const g = path.join(__dirname, '_plantio_sungrow.js');
  fs.writeFileSync(g, src.split(de).join(para));
  let r2;
  try { r2 = cenario(g); } finally { fs.unlinkSync(g); }
  ok(!r2.erro && r2[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (r2.erro ? ' (estourou: ' + r2.erro + ')' : ''));
}
planta('identificar pela pasta', "if (hits.length === 1) { const a = ident[sn];",
  "if (hits.length === 1) { hits[0] = o.ufv + '/' + o.pasta + '/' + hits[0].split('/')[2]; } if (hits.length === 1) { const a = ident[sn];", 'okId');
planta('logger pela pasta', "tsDoLogger[sn] = H.tsLogger[sn] || { ts: o.pasta, por: 'pasta', dias: 0, de: dias };",
  "tsDoLogger[sn] = { ts: o.pasta, por: 'pasta', dias: 0, de: dias };", 'okPid');
planta('dia inteiro presumido', 'x.parcial = !j || !(x.t0 < j.ini && x.t1 > j.fim);', 'x.parcial = false;', 'okConf');
planta('janela vista so na partida', 'x.parcial = !j || !(x.t0 < j.ini && x.t1 > j.fim);', 'x.parcial = !j || !(x.t0 < j.ini);', 'okConf');
planta('janela vista so na parada', 'x.parcial = !j || !(x.t0 < j.ini && x.t1 > j.fim);', 'x.parcial = !j || !(x.t1 > j.fim);', 'okConf');
planta('sem geracao = parcial', 'const j = x.ini ? { ini: x.ini, fim: x.fim } : jan.get(x.d);', 'const j = x.ini ? { ini: x.ini, fim: x.fim } : null;', 'okParado');
planta('linha sem t0/t1 tratada como inteira', 'x.parcial = null; continue;', 'x.parcial = false; continue;', 'okNula');
planta('sem busca funda', 'if (!faltam.length) continue;', 'continue;', 'okId');
planta('busca sem teto', 'if (a.carimbo > teto) continue;', '', 'okBusca1');
planta('busca que nao para no casamento', 'if (!faltam.length) break;', '', 'okBusca1');
planta('busca nunca repetida', 'busca[sn] !== ultimo(sn)', '!(sn in busca)', 'okBuscaVolta');
planta('busca sem memoria', ' && busca[sn] !== ultimo(sn)', '', 'okNaoRepete');
planta('migra mantendo o historico', 'hist = null; }', 'hist.esquema = ESQ_HIST; }', 'okMigra');

console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-sungrow: tudo ok');
process.exit(falhas.length ? 1 : 0);
