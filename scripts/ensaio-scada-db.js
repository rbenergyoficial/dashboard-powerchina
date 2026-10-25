'use strict';
/*
 * ensaio-scada-db.js — o SCADA lido do BANCO do supervisorio (`lib-scada-db.js` + `gen-scada.js`, 17/10/2026).
 *
 * Sem rede. Monta zips MRT sinteticos em memoria (o mesmo formato da extracao: CSV por cubiculo, `;`, `inicio_5min`,
 * 288 linhas) e julga contra a conta feita aqui:
 *   1. a soma por usina segue o unifilar e a energia e a media x 5/60; o 15 min e a soma dos tres;
 *   2. intervalo com um circuito vazio fica sem valor (tudo-ou-nada); usina sem o arquivo de um circuito nao sai;
 *   3. linha de outro dia e instante repetido estouram;
 *   4. vale o zip mais novo (`~AAAAMMDD-HHMMSS`);
 *   5. o RTC do M3 dobra o CUB10.1 so antes de 12/07/2026 e so com a guarda (35-70 % das irmas);
 *   6. o gerador inteiro (processo filho, LOCAL_*): o banco completo vence a planilha e marca `media_5min`; o banco
 *      pela metade NAO substitui um dia inteiro da planilha; dia so do banco e pela metade entra sem total do dia;
 *      dia sem banco fica intacto; o arquivo de 5 min leva a marca.
 * Cada regra tem o seu plantio, que TEM de reprovar.
 *
 * uso: node scripts/ensaio-scada-db.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const DB = require('./lib-scada-db');

let falhas = 0, casos = 0;
function ok(cond, msg) { casos++; if (!cond) { falhas++; console.log('  REPROVADO · ' + msg); } else console.log('  ok · ' + msg); }
const perto = (a, b, tol = 1e-9) => a != null && b != null && Math.abs(a - b) <= tol;
function estoura(fn) { try { fn(); return false; } catch (e) { return true; } }

// ---- zip em memoria (deflate), o bastante para o `lib-zip` ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (const x of b) c = CRC[(c ^ x) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(arquivos) {
  const loc = [], cen = [];
  let off = 0;
  for (const [nome, txt] of Object.entries(arquivos)) {
    const dados = Buffer.from(txt, 'utf8'), comp = zlib.deflateRawSync(dados), n = Buffer.from(nome, 'utf8');
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(dados), 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(dados.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(dados), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(dados.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    loc.push(h, n, comp); cen.push(c, n); off += 30 + n.length + comp.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(cen.length / 2, 8); e.writeUInt16LE(cen.length / 2, 10); e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...loc, cb, e]);
}

// ---- dia sintetico: P(cub, i) em MW e Q(cub, i) em MVAr; `vazio(cub, i)` deixa a celula em branco ----
const hm = (i) => String(Math.floor(i * 5 / 60)).padStart(2, '0') + ':' + String(i * 5 % 60).padStart(2, '0');
function csvCub(dia, cub, P, Q, vazio, extra) {
  const pre = 'IEC_61850.CUB' + cub + '.CUB' + cub + '_LD0_';
  const l = ['inicio_5min;' + pre + 'CMMXU1_A_phsA;' + pre + 'CVMMXN1_Watt;' + pre + 'CVMMXN1_VolAmpr'];
  for (let i = 0; i < 288; i++) {
    const v = vazio && vazio(cub, i) ? '' : String(P(cub, i));
    l.push(dia + ' ' + hm(i) + ';123.4;' + v + ';' + Q(cub, i));
  }
  if (extra) l.push(extra);
  return '﻿' + l.join('\r\n') + '\r\n';
}
const TODOS = Object.values(DB.CIRCUITOS).flat();
function zipDia(dia, o = {}) {
  const P = o.P || ((cub, i) => (i >= 72 && i < 216 ? 1 + (TODOS.indexOf(cub) % 5) * 0.5 + i / 1000 : -0.01));
  const Q = o.Q || ((cub, i) => 0.2);
  const arq = { 'MRT_04T1.csv': 'inicio_5min;x\r\n', 'dicionario_pontos.csv': 'tabela;FieldID;FieldName\r\n' };
  if (o.metodo !== null) arq['metodo.txt'] = '﻿' + (o.metodo || 'media_da_reta_entre_registros_v3');
  for (const cub of TODOS.concat(['1_1', '16_2'])) {
    if ((o.sem || []).includes(cub)) continue;
    arq['MRT_CUB' + cub + '.csv'] = csvCub(dia, cub, P, Q, o.vazio, o.extra && o.extra[cub]);
  }
  return zip(arq);
}
const Pbase = (cub, i) => (i >= 72 && i < 216 ? 1 + (TODOS.indexOf(cub) % 5) * 0.5 + i / 1000 : -0.01);
const somaPk = (pk, i, P = Pbase) => DB.CIRCUITOS[pk].reduce((s, c) => s + P(c, i), 0);

console.log('1. soma por usina pelo unifilar; energia = media x 5/60; 15 min = soma dos tres');
{ const z = DB.leZip(zipDia('2026-10-14'), '2026-10-14');
  const u = DB.usinasDoDia(z.circ);
  ok(Object.keys(u).sort().join() === 'M1,M2,M3,M4,M5,M6,M7,M8,M9', 'as nove usinas, nenhum cubiculo de reserva somado');
  ok(perto(u.M3.e5[100], somaPk('M3', 100) * 5 / 60), 'M3 as 08:20 = (CUB9.1 + CUB10.1 + CUB11.1) x 5/60');
  ok(!perto(u.M3.e5[100], (somaPk('M3', 100) + Pbase('1_1', 100)) * 5 / 60), 'plantio: somar o CUB1.1 (reserva) daria outro numero');
  ok(perto(u.M7.e5[0], -0.01 * 5 / 60), 'consumo da noite entra negativo (nao se descarta)');
  ok(u.M1.completo && u.M1.intervalos === 288, 'dia cheio = 288 intervalos, completo');
  const q = DB.para15(u.M2.e5, u.M2.q5);
  ok(perto(q.e15[30], u.M2.e5[90] + u.M2.e5[91] + u.M2.e5[92]), '15 min das 07:30 = soma dos 5 min de 07:30, 07:35 e 07:40');
  ok(perto(q.q15[30], 0.4), 'reativa de 15 min = media dos tres (2 circuitos x 0,2)'); }

console.log('2. tudo-ou-nada: um circuito vazio tira o intervalo da usina; sem o arquivo, a usina nao sai');
{ const z = DB.leZip(zipDia('2026-10-14', { vazio: (cub, i) => cub === '10_1' && i === 120, sem: ['12_2'] }), '2026-10-14');
  const u = DB.usinasDoDia(z.circ);
  ok(u.M3.e5[120] === null && !u.M3.completo && u.M3.intervalos === 287, 'M3 as 10:00 sem valor e o dia nao fica completo');
  ok(perto(u.M3.e5[121], somaPk('M3', 121) * 5 / 60), 'o intervalo seguinte segue normal');
  ok(DB.para15(u.M3.e5, u.M3.q5).e15[40] === null, 'o 15 min das 10:00 tambem fica sem valor');
  ok(!u.M8 && z.faltam.join() === '12_2', 'M8 sem o CUB12.2: a usina nao sai, e a falta e dita');
  // plantio: a soma "do que veio" daria o M3 com dois tercos
  const parcial = ['9_1', '11_1'].reduce((s, c) => s + Pbase(c, 120), 0) * 5 / 60;
  ok(u.M3.e5[120] !== parcial, 'plantio: somar so os circuitos presentes publicaria ' + parcial.toFixed(3) + ' MWh'); }

console.log('3. arquivo que nao e o que se pensa estoura');
ok(estoura(() => DB.leZip(zipDia('2026-10-14', { extra: { '7_2': '2026-10-15 00:00;1;1;1' } }), '2026-10-14')), 'linha de outro dia');
ok(estoura(() => DB.leZip(zipDia('2026-10-14', { extra: { '7_2': '2026-10-14 12:00;1;1;1' } }), '2026-10-14')), 'instante repetido');
ok(estoura(() => DB.leZip(zipDia('2026-10-14'), '2026-10-13')), 'zip de um dia lido como outro');
ok(!estoura(() => DB.leZip(zipDia('2026-10-14'), '2026-10-14')), 'o zip certo nao estoura');

console.log('3b. so vale o zip da extracao pela RETA entre registros (metodo.txt)');
{ const sem = DB.leZip(zipDia('2026-10-14', { metodo: null }), '2026-10-14');
  const velho = DB.leZip(zipDia('2026-10-14', { metodo: 'media_segurando_o_ultimo' }), '2026-10-14');
  const novo = DB.leZip(zipDia('2026-10-14'), '2026-10-14');
  ok(!sem.aceito && !Object.keys(sem.circ).length, 'zip sem metodo.txt (a extracao antiga): recusado, nenhum circuito lido');
  ok(!velho.aceito, 'zip com outro metodo: recusado');
  ok(novo.aceito && novo.metodo === 'media_da_reta_entre_registros_v3' && Object.keys(novo.circ).length === 22, 'zip da reta: aceito, 22 circuitos'); }

console.log('4. vale o zip mais novo do dia');
{ const e = DB.escolhe(['SCADA_DB/saida/2026-10/MRT_2026-10-14.zip', 'SCADA_DB/saida/2026-10/MRT_2026-10-14.zip~20261016-120000',
    'SCADA_DB/saida/2026-10/MRT_2026-10-14.zip~20261015-040000', 'SCADA_DB/saida/2026-10/UFV_MRT_2026-10-14.zip',
    'SCADA_DB/saida/2026-10/MRT_2026-10-13.zip']);
  ok(e.get('2026-10-14') === 'SCADA_DB/saida/2026-10/MRT_2026-10-14.zip~20261016-120000', 'a versao de 16/10 12:00');
  ok(e.size === 2 && [...e.keys()].join() === '2026-10-13,2026-10-14', 'so os MRT, em ordem de dia'); }

console.log('5. RTC do M3: dobra o CUB10.1 so antes de 12/07/2026 e so com a guarda');
{ const metade = (cub, i) => (cub === '10_1' ? 0.5 : 1) * Pbase(cub, i);
  const pd = new Map([['2026-07-10', DB.leZip(zipDia('2026-07-10', { P: metade }), '2026-07-10')],
    ['2026-07-11', DB.leZip(zipDia('2026-07-11', { P: metade }), '2026-07-11')],
    ['2026-07-12', DB.leZip(zipDia('2026-07-12', { P: metade }), '2026-07-12')]]);
  const r = DB.reparaRtc(pd);
  ok(r.aplicado && r.dias === 2, 'aplicado em 2 dias (razao ' + (r.razao * 100).toFixed(0) + '%)');
  ok(perto(pd.get('2026-07-11').circ['10_1'].P[100], Pbase('10_1', 100)), 'antes do reparo: CUB10.1 volta ao valor cheio');
  ok(perto(pd.get('2026-07-12').circ['10_1'].P[100], 0.5 * Pbase('10_1', 100)), 'no dia do reparo em diante: nao mexe');
  ok(perto(pd.get('2026-07-11').circ['9_1'].P[100], Pbase('9_1', 100)), 'as irmas nao mexem');
  const sadio = new Map([['2026-07-10', DB.leZip(zipDia('2026-07-10'), '2026-07-10')]]);
  const r2 = DB.reparaRtc(sadio);
  ok(!r2.aplicado && perto(sadio.get('2026-07-10').circ['10_1'].P[100], Pbase('10_1', 100)), 'plantio: circuito sadio (razao ' + (r2.razao * 100).toFixed(0) + '%) nao e dobrado'); }

console.log('6. o gerador inteiro: precedencia do banco sobre a planilha');
{ const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-scada-db-'));
  const vazio = path.join(tmp, 'xlsx'), dbd = path.join(tmp, 'saida'), out = path.join(tmp, 'out');
  [vazio, path.join(dbd, '2026-10'), out].forEach((d) => fs.mkdirSync(d, { recursive: true }));
  // o que esta no ar: tres dias da planilha (o retangulo antigo, 0 nas noites)
  const plan = (v) => new Array(96).fill(v), plan5 = (v) => new Array(288).fill(v);
  const base = { diario: {}, intra15: {}, intra5: {}, diario_reativa: {}, intra15_reativa: {} };
  for (const d of ['2026-10-12', '2026-10-13', '2026-10-14']) {
    base.intra15[d] = {}; base.intra5[d] = {};
    for (const pk of Object.keys(DB.CIRCUITOS)) { (base.diario[pk] = base.diario[pk] || {})[d] = 999; base.intra15[d][pk] = plan(9); base.intra5[d][pk] = plan5(3); }
  }
  fs.writeFileSync(path.join(out, 'scada_comparativo.json'), JSON.stringify(base));
  fs.writeFileSync(path.join(out, 'scada_5min.json'), JSON.stringify({ intra5: base.intra5 }));
  // banco: 13/10 com o M2 pela metade (um vazio), 14/10 completo, 15/10 so no banco e com o M5 pela metade
  const buraco = (pk, dia) => (cub, i) => dia && cub === DB.CIRCUITOS[pk][0] && i === 150;
  fs.writeFileSync(path.join(dbd, '2026-10', 'MRT_2026-10-12.zip'), zipDia('2026-10-12', { metodo: null }));   // extracao antiga
  fs.writeFileSync(path.join(dbd, '2026-10', 'MRT_2026-10-13.zip'), zipDia('2026-10-13', { vazio: buraco('M2', true) }));
  fs.writeFileSync(path.join(dbd, '2026-10', 'MRT_2026-10-14.zip'), zipDia('2026-10-14'));
  fs.writeFileSync(path.join(dbd, '2026-10', 'MRT_2026-10-15.zip'), zipDia('2026-10-15', { vazio: buraco('M5', true) }));
  execFileSync(process.execPath, [path.join(__dirname, 'gen-scada.js')], { stdio: 'pipe',
    env: { ...process.env, LOCAL_DIR: vazio, LOCAL_DB_DIR: dbd, LOCAL_OUT: path.join(out, 'scada_comparativo.json'), DADOS_STORAGE: '', DADOS_SAS: '' } });
  const B = JSON.parse(fs.readFileSync(path.join(out, 'scada_comparativo.json'), 'utf8'));
  const C5 = JSON.parse(fs.readFileSync(path.join(out, 'scada_5min.json'), 'utf8'));
  const dia14 = Array.from({ length: 288 }, (_, i) => somaPk('M1', i) * 5 / 60).reduce((a, b) => a + b, 0);
  ok(perto(B.diario.M1['2026-10-14'], +dia14.toFixed(2)), 'banco completo vence a planilha: M1 14/10 = ' + B.diario.M1['2026-10-14'] + ' MWh (planilha 999)');
  ok(perto(B.intra15['2026-10-14'].M1[40], +([120, 121, 122].reduce((s, i) => s + somaPk('M1', i) * 5 / 60, 0)).toFixed(3)), 'o 15 min das 10:00 do M1 e o do banco');
  ok((B.media_5min['2026-10-14'] || []).length === 9, '14/10 marcado nas nove usinas');
  ok(B.diario.M2['2026-10-13'] === 999 && B.intra15['2026-10-13'].M2[0] === 9 && !(B.media_5min['2026-10-13'] || []).includes('M2'),
    'banco pela metade NAO substitui o dia inteiro da planilha (M2 13/10 mantido, sem marca)');
  ok((B.media_5min['2026-10-13'] || []).includes('M1') && B.diario.M1['2026-10-13'] !== 999, 'no mesmo dia, as usinas completas vem do banco');
  ok(B.diario.M5['2026-10-15'] === undefined && C5.intra5['2026-10-15'].M5[150] === null && C5.intra5['2026-10-15'].M5[151] != null
    && (B.media_5min['2026-10-15'] || []).includes('M5'), 'dia so do banco e pela metade: entra sem total do dia, com o buraco');
  ok(B.diario.M6['2026-10-15'] != null, 'as outras usinas de 15/10 entram com o total do dia');
  ok(B.diario.M1['2026-10-12'] === 999 && !B.media_5min['2026-10-12'], 'zip da extracao antiga (sem metodo.txt) nao entra: 12/10 fica com a planilha');
  ok(JSON.stringify((C5.media_5min || {})['2026-10-14']) === JSON.stringify(B.media_5min['2026-10-14']) && C5.intra5['2026-10-14'].M1[100] != null,
    'o arquivo de 5 min leva a marca e o 5 min do banco');
  ok(B.diario_reativa.M2['2026-10-14'] && perto(B.diario_reativa.M2['2026-10-14'].media, 0.4), 'reativa do dia = soma dos circuitos (2 x 0,2)');
  // plantio: o gerador sem o banco (SEM_DB=1) deixa a planilha, e o ensaio tem de ver isso
  fs.writeFileSync(path.join(out, 'scada_comparativo.json'), JSON.stringify(base));
  execFileSync(process.execPath, [path.join(__dirname, 'gen-scada.js')], { stdio: 'pipe',
    env: { ...process.env, LOCAL_DIR: vazio, LOCAL_DB_DIR: dbd, SEM_DB: '1', LOCAL_OUT: path.join(out, 'scada_comparativo.json'), DADOS_STORAGE: '', DADOS_SAS: '' } });
  const S = JSON.parse(fs.readFileSync(path.join(out, 'scada_comparativo.json'), 'utf8'));
  ok(S.diario.M1['2026-10-14'] === 999, 'plantio: sem o banco, 14/10 fica com a planilha (o caso acima reprovaria)');
  fs.rmSync(tmp, { recursive: true, force: true }); }

// ---- 7. o vigia do banco (gen-scada-db-vigia.js, 22/10/2026): o dia D ate D+2 12:00 BRT, pelo ULTIMO DIA aceito ----
console.log('7 · o vigia do banco');
{
  const brt = (s) => Date.parse(s + '-03:00');
  const casosVigia = (V) => {
    const r = [];
    r.push(V.julga('2026-10-19', brt('2026-10-22T11:59:00')).estado === 'ok');          // 19/10 vence 21/10 12:00; 20/10 so vence 22/10 12:00
    r.push(V.julga('2026-10-19', brt('2026-10-22T12:00:00')).estado === 'atrasado');    // agora 20/10 venceu e nao veio
    r.push(V.julga('2026-10-20', brt('2026-10-22T12:00:00')).estado === 'ok');
    r.push(V.julga(null, brt('2026-10-22T12:00:00')).estado === 'atrasado');
    r.push(V.julga('2026-10-21', brt('2026-10-22T11:00:00')).exigido === '2026-10-19');   // em UTC (14:00) o prazo de 20/10 ja teria vencido
    const met = { '2026-10-21': null, '2026-10-20': 'media_segurada_v1', '2026-10-19': DB.METODOS_ACEITOS[0] };
    r.push(V.ultimoAceito(['2026-10-21', '2026-10-20', '2026-10-19'], (d) => met[d]) === '2026-10-19');
    return r;
  };
  const V = require('./gen-scada-db-vigia');
  const r = casosVigia(V);
  ok(r[0] && r[1] && r[2], 'o prazo: 19/10 em dia ate 22/10 11:59; atrasado as 12:00; 20/10 em dia as 12:00');
  ok(r[3], 'sem nenhum dia aceito: atrasado');
  ok(r[4], 'o prazo conta em BRT: 22/10 11:00 em Brasilia exige 19/10 (em UTC ja seriam 14:00 e exigiria 20/10)');
  ok(r[5], 'o ultimo ACEITO pula o zip sem metodo.txt e o da extracao antiga');
  // plantios: a copia do vigia com o defeito tem de cair num dos casos acima
  const fonte = fs.readFileSync(path.join(__dirname, 'gen-scada-db-vigia.js'), 'utf8');
  const planta = (de, para, rot, idx) => {
    if (fonte.split(de).length !== 2) { ok(false, 'plantio "' + rot + '" nao plantou'); return; }
    const arq = path.join(__dirname, '.plantio-vigia-' + process.pid + '.js');
    fs.writeFileSync(arq, fonte.replace(de, para));
    try { const P = casosVigia(require(arq)); ok(!P[idx], 'plantio: ' + rot + ' (o caso ' + (idx + 1) + ' reprova)'); }
    finally { fs.rmSync(arq, { force: true }); delete require.cache[require.resolve(arq)]; }
  };
  planta('const PRAZO_MS = (2 * 24 + 12)', 'const PRAZO_MS = (3 * 24 + 12)', 'prazo de D+3 em vez de D+2', 1);
  planta('if (DB.METODOS_ACEITOS.includes(metodoDe(d))) return d;', 'return d;', 'o ultimo dia sem olhar o metodo', 5);
  planta('return diaUTC(agoraMs - BRT_MS - PRAZO_MS);', 'return diaUTC(agoraMs - PRAZO_MS);', 'o prazo contado em UTC', 4);
}

console.log('\n' + (falhas ? 'REPROVADO: ' + falhas + ' de ' + casos : 'APROVADO: ' + casos + ' de ' + casos));
process.exit(falhas ? 1 : 0);
