/*
 * ensaio-sungrow.js — prova o gerador do logger Sungrow (gen-sungrow.js, lib-sungrow.js, lib-zip.js), sem rede.
 *
 * 1 · o leitor de zip: entradas guardadas e com deflate, metodo desconhecido e zip truncado ESTOURAM com o nome.
 * 2 · o leitor de CSV: coluna pelo NOME (a mesma leitura com as colunas embaralhadas), coluna faltando estoura com o nome,
 *     leitura-sentinela (65535) vira nulo, e os CSV vazios de jan-mar (carimbo de 1969) nao viram dia.
 *     O dicionario de codigos de falha (lote 3a) conferido codigo a codigo, de 0 a 2000, contra a tabela 8.1 do manual do
 *     SG350HX transcrita aqui; cinco plantios de digitacao numa copia da tabela.
 * 3 · o gerador de ponta a ponta, com a armadilha que o dado real tem: dois inversores do TS6 dentro da pasta do TS5, e
 *     o logger do TS6 (com o PID) tambem na pasta do TS5. Cada inversor vai para a posicao do CONTADOR DE VIDA (igual ao
 *     do export do SCADA), o logger e o PID vao para o TS cuja soma de potencia instantanea e a dele, a conferencia
 *     logger x SCADA fecha em 1,000, e a segunda rodada (nada novo) sai identica.
 *     Lote 1b (03/10/2026): o logger que para as 16:05 e o dia de uma amostra so saem PARCIAIS e ficam fora da
 *     conferencia; o inversor que so existe num export mais velho que os 4 da passada normal e achado pela BUSCA FUNDA, que
 *     nao se repete sem dado novo; o PID sai sem os minutos com tensao; o historico de esquema 1 e relido inteiro.
 *     Lote 3a (04/10/2026): a saude do inversor (sg_saude_<usina> e sg_saude) com grandezas variando por inversor, um
 *     dia MISTO (um inversor parcial mais quente e de isolamento mais baixo), tipo e origem descasados nos codigos, evento
 *     em dia parcial e dois codigos da mesma familia no mesmo dia.
 *     PT100 do eletrocentro (04/10/2026): temperatura seguindo a carga, zero solto e sensor ausente; resumo do dia e serie de
 *     5 min no TS do logger; migracao do esquema 2 fiel; plantios no gerador e na LIB.
 * 4 · plantios no gerador, cada um rodando o CENARIO inteiro (cinco rodadas): identificar pela PASTA, logger pela PASTA,
 *     presumir o dia inteiro, ver a janela so numa ponta (partida ou parada), tratar o inversor parado como parcial, tratar
 *     a linha sem t0/t1 como inteira, tirar a busca funda, tirar o teto ou a parada da busca, nunca repetir ou sempre
 *     repetir a busca, migrar mantendo o historico velho; e, na saude, grandeza ou evento so do dia inteiro, rede ou alarme
 *     contados pela coisa errada, temperatura ou isolamento com o parcial, eficiencia pelo maximo, familia que sobrescreve,
 *     parcial nulo como inteiro e campo trocado na linha: todos tem de reprovar.
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
  'Tensão do barramento', 'Tensão MPPT1', 'Estado de trabalho PID', 'Código de falha PID', 'Eficiência do inversor',
  ...Array.from({ length: 11 }, (_, k) => 'Tensão MPPT' + (k + 2)), ...Array.from({ length: 12 }, (_, k) => 'Corrente MPPT' + (k + 1))];
const DIAS = ['2026-09-28', '2026-09-29', '2026-09-30'];
const HH = []; for (let m = 0; m < 1440; m += 5) HH.push(String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'));
const perfil = (k, f) => { const h = k / 12; return h < 6 || h > 18 ? 0 : Math.round(300000 * f * Math.sin(Math.PI * (h - 6) / 12) ** 2); };  // W
// `dias` e `corte` ([primeiro, ultimo] indice de 5 min lido em cada dia) fazem o logger que entra ou para no meio do dia
// `cod` ({dia: {indice: codigo}}) escreve um codigo de falha naquela amostra; `q` da as grandezas do inversor: t (0,1 °C),
// iso (kΩ), ef (0,01 %) e lim ([de, ate) indices com potencia limitada)
function csvInversor(vida0, f, ordem, dias, corte, cod, q) {
  q = q || {};
  const linhas = [];
  let vida = vida0;
  for (const d of (dias || DIAS)) { let dia = 0;
    HH.forEach((h, k) => { if (corte && corte[d] && (k < corte[d][0] || k > corte[d][1])) return;
      const p = perfil(k, f); const e = p / 12 / 1000; vida += e; dia += e;
      const v = { 'Horário': d + ' ' + h + ':00', 'Potência ativa nominal': 3200, 'Modo de potência limitada': q.lim && k >= q.lim[0] && k < q.lim[1] ? 1 : 0,
        'Geração de energia ao longo do dia': Math.round(dia * 10), 'Geração total': Math.round(vida * 10), 'Temperatura de ar interna': q.t || 450,
        'Potência CC total': Math.round(p * 1.015), 'Potência ativa total': p, 'Status de operação do inversor': p ? 4 : 0, 'Código de falha': (cod && cod[d] && cod[d][k]) || 0,
        'Impedância paralela em relação à terra': q.iso || 500, 'Tempo de operação diário': p ? 1 : 0, 'Tensão de pólo negativo / terra': -7000,
        'Tensão do barramento': 13000, 'Estado de trabalho PID': 0, 'Código de falha PID': 0, 'Eficiência do inversor': q.ef || 9870 };
      /* os MPPT: 1300 V (0,1 V) e a corrente da potencia dividida por 11 (0,1 A); o MPPT12 sem string (443 V e 0 A, como no
         logger real); `q.mppt` {k: fator} tira tensao de um MPPT, `q.mpptI` {k: fator} tira corrente; durante a LIMITACAO
         o MPPT5 sobe 10 % (o rastreador fora do ponto de maxima potencia), e isso nao pode entrar na razao */
      const lim = v['Modo de potência limitada'] === 1;
      for (let m = 1; m <= 12; m += 1) {
        const fv = ((q.mppt || {})[m] || 1) * (lim && m === 5 ? 1.1 : 1), fi = (q.mpptI || {})[m] || 1;
        v['Tensão MPPT' + m] = m === 12 ? 4430 : Math.round(13000 * fv);
        v['Corrente MPPT' + m] = m === 12 ? 0 : Math.round((p / 1300 / 11) * 10 * fi); }
      linhas.push(ordem.map((c, i) => (c === 'Potência ativa total' && ordem.indexOf(c) !== i ? 0 : v[c])).join(', ')); }); }
  return '﻿' + ordem.join(',') + '\n' + linhas.join('\n') + '\n';
}

/* a tensao dos MPPT na LIB, direto na mpptDoDia, com as fronteiras (achados do revisor, 05/10/2026). Dia A, 20 instantes a
   200 kW sem limitacao: MPPT3 a 0,966; MPPT2 a 12000 nos 3 PRIMEIROS (mediana 1, primeiro valor 0,923); MPPT12 com o
   residuo real de 0,3 A (3 em 0,1 A) e o MPPT10 com 30 exatos: os dois NULOS (piso estrito de 3 A); o MPPT11 com 31: entra;
   o MPPT9 acima do piso em 5 instantes (nulo) e o MPPT8 em 6 (razao). Mais 3 instantes com UM so MPPT acima do piso (nao
   contam) e 2 limitados com o MPPT4 a 15000 (nao contam). Dia B com 5 instantes: nulo; dia C com 6: entra. Sem a coluna
   "Corrente MPPT7": estoura com o nome */
function casosMppt(SL) {
  const cab = ['Horário', 'Potência ativa total', 'Modo de potência limitada', ...Array.from({ length: 12 }, (_, k) => 'Tensão MPPT' + (k + 1)),
    ...Array.from({ length: 12 }, (_, k) => 'Corrente MPPT' + (k + 1))];
  const linha = (d, k, p, lim, V, I) => [d + ' 12:' + String(k).padStart(2, '0') + ':00', p, lim, ...V, ...I].map(String);
  const A = [];
  for (let k = 0; k < 20; k += 1) {
    const V = Array(12).fill(13000), I = Array(12).fill(100);
    V[2] = 12558; if (k < 3) V[1] = 12000; V[11] = 4430; I[11] = 3; I[9] = 30; I[10] = 31; if (k >= 5) I[8] = 0; if (k >= 6) I[7] = 0;
    A.push(linha('2026-09-29', k, 200000, 0, V, I));
  }
  for (let k = 20; k < 23; k += 1) { const I = Array(12).fill(0); I[0] = 100; A.push(linha('2026-09-29', k, 200000, 0, Array(12).fill(13000), I)); }
  // e 2 instantes com EXATAMENTE dois MPPT acima do piso: contam (n 22)
  for (let k = 25; k < 27; k += 1) { const I = Array(12).fill(0); I[0] = 100; I[1] = 100; A.push(linha('2026-09-29', k, 200000, 0, Array(12).fill(13000), I)); }
  for (let k = 23; k < 25; k += 1) { const V = Array(12).fill(13000); V[3] = 15000; A.push(linha('2026-09-29', k, 200000, 1, V, Array(12).fill(100))); }
  const dia = (n) => Array.from({ length: n }, (_, k) => linha('2026-09-30', k, 200000, 0, Array(12).fill(13000), Array(12).fill(100)));
  const a = SL.mpptDoDia(cab, A, 'A') || { r: [], i: [] }, b = SL.mpptDoDia(cab, dia(5), 'B'), c = SL.mpptDoDia(cab, dia(6), 'C');
  let estourou = false;
  try { SL.mpptDoDia(cab.filter((x) => x !== 'Corrente MPPT7'), A.map((l) => l.filter((x, i) => cab[i] !== 'Corrente MPPT7')), 'z.csv'); }
  catch (e) { estourou = /z\.csv: coluna "Corrente MPPT7" ausente/.test(e.message); }
  const ok = a.n === 22 && a.v === 1300 && a.r[0] === 1 && a.r[1] === 1 && a.r[2] === 0.966 && a.r[3] === 1 && a.r[7] === 1 && a.r[8] === null
    && a.r[9] === null && a.r[10] === 1 && a.r[11] === null && a.i[10] === 0.31 && a.i[2] === 1 && b === null && !!c && c.n === 6 && estourou;
  return { ok, txt: 'n ' + a.n + ' · MPPT2 ' + a.r[1] + ' · MPPT3 ' + a.r[2] + ' · MPPT8/9 ' + a.r[7] + '/' + a.r[8] + ' · MPPT10/11/12 ' + a.r[9] + '/' + a.r[10] + '/' + a.r[11]
    + ' (i11 ' + a.i[10] + ') · dia de 5 ' + (b === null ? 'nulo' : 'ENTROU') + ', de 6 ' + (c ? c.n : 'nulo') + ' · coluna faltando ' + (estourou ? 'estoura' : 'NAO estoura') };
}

console.log('\n2 · lib-sungrow');
{ const m = casosMppt(S); ok(m.ok, 'tensao dos MPPT na lib: piso estrito de 3 A, minimos de 6, mediana, instante com um so MPPT e limitacao fora: ' + m.txt); }
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
/* o dicionario de codigos contra a tabela 8.1 do manual do SG350HX (p. 105 a 113), TRANSCRITA AQUI na notacao do proprio
   manual e na ordem dele (familia | tipo | origem | codigos), nao copiada da lib. Tipo: "Alarme..." no nome = alarme.
   Origem rede: a medida corretiva diz que o inversor reconecta quando a rede volta ao normal. A conferencia e de TODO
   codigo de 0 a 2000 (a primeira linha da tabela que o contem; fora dela, fora_manual), e da string das familias por
   string pelas notas do manual (532-547 = strings 1 a 16; 564-579 = 17 a 32; 548-563 = 1 a 16; 580-595 = 17 a 32) */
const MANUAL = `
sobretensao_rede | falha | rede | 2, 3, 14, 15
subtensao_rede | falha | rede | 4, 5
sobrefrequencia_rede | falha | rede | 8
subfrequencia_rede | falha | rede | 9
ilhamento | falha | rede | 10
fuga_corrente | falha | equipamento | 12
rede_anormal | falha | rede | 13
desequilibrio_rede | falha | rede | 17
conexao_reversa | falha | equipamento | 28, 29, 208, 212, 448-479
reversa_fv | alarme | equipamento | 532-547, 564-579
entrada_anormal | alarme | equipamento | 548-563, 580-595
temperatura_alta | falha | equipamento | 37
temperatura_baixa | falha | equipamento | 43
isolacao_baixa | falha | equipamento | 39
cabo_aterramento | falha | equipamento | 106
arco_eletrico | falha | equipamento | 88
medidor_reverso | alarme | equipamento | 84
medidor_comunicacao | alarme | equipamento | 514
conflito_rede | falha | equipamento | 323
comunicacao_paralela | alarme | equipamento | 75
falha_sistema | falha | equipamento | 7, 11, 16, 19-25, 30-34, 36, 38, 40-42, 44-50, 52-58, 60-69, 85, 87, 92, 93, 100-105, 107-114, 116-124, 200-211, 248-255, 300-322, 324-328, 401-412, 600-603, 605, 608, 612, 616, 620, 622-624, 800, 802, 804, 807, 1096-1122
alarme_sistema | alarme | equipamento | 59, 70-74, 76, 82, 83, 89, 77-81, 216-218, 220-232, 432-434, 500-513, 515-518, 635-638, 900, 901, 910, 911, 996
mppt_reversa | falha | equipamento | 264-283
boost_sobretensao_alarme | alarme | equipamento | 332-363
boost_sobretensao | falha | equipamento | 364-395
corrente_reversa | falha | equipamento | 1548-1579
aterramento_fv | falha | equipamento | 1632-1655
hardware_sistema | falha | equipamento | 1616
`.trim().split('\n').map((l) => { const [fam, tipo, origem, cods] = l.split('|').map((x) => x.trim());
  return { fam, tipo, origem, faixas: cods.split(',').map((x) => x.trim().split('-').map(Number)).map((a) => [a[0], a[a.length - 1]]) }; });
// codigo -> familia pela PRIMEIRA linha que o contem (o 208, citado nas duas, fica na primeira: conexao_reversa)
const famDe = (tab, c) => { for (const x of tab) if (x.faixas.some(([a, b]) => c >= a && c <= b)) return x; return null; };
function confereDic(FX, familiaFn) {
  const tab = FX.map(([fam, tipo, origem, fx]) => ({ fam, tipo, origem, faixas: fx }));
  const erros = [];
  const nomes = (t) => t.map((x) => x.fam + '/' + x.tipo + '/' + x.origem).sort().join(',');
  if (nomes(tab) !== nomes(MANUAL)) erros.push('familias, tipo ou origem diferentes do manual');
  for (let c = 0; c <= 2000; c++) {
    const e = famDe(MANUAL, c), a = famDe(tab, c);
    if ((e ? e.fam : 'fora_manual') !== (a ? a.fam : 'fora_manual')) erros.push(c + ': manual ' + (e ? e.fam : 'fora') + ', tabela ' + (a ? a.fam : 'fora'));
    if (familiaFn) { const x = familiaFn(c);
      if (x.fam !== (e ? e.fam : 'fora_manual') || x.tipo !== (e ? e.tipo : null) || x.origem !== (e ? e.origem : null)) erros.push(c + ': familia() ' + x.fam + '/' + x.tipo + '/' + x.origem); }
  }
  // fora das quatro faixas por string, familia() nao devolve string
  const porString = (c) => (c >= 532 && c <= 595);
  if (familiaFn) for (let c = 0; c <= 2000; c++) if (!porString(c) && familiaFn(c).string !== undefined) erros.push(c + ': string ' + familiaFn(c).string + ' fora das familias por string');
  if (familiaFn) for (const [a, b, s0] of [[532, 547, 1], [564, 579, 17], [548, 563, 1], [580, 595, 17]])
    for (let c = a; c <= b; c++) if (familiaFn(c).string !== s0 + c - a) erros.push(c + ': string ' + familiaFn(c).string + ', manual ' + (s0 + c - a));
  return erros;
}
{ const er = confereDic(S.FAIXAS, S.familia);
  ok(!er.length, 'codigos de falha: a tabela 8.1 inteira, de 0 a 2000, igual a transcricao do manual (familia, tipo, origem e string)'
    + (er.length ? ' · ' + er.slice(0, 4).join(' · ') : ''));
  // a conferencia pega erro de digitacao: plantios numa COPIA da tabela
  const copia = () => S.FAIXAS.map(([f, t, o, fx, st]) => [f, t, o, fx.map((x) => x.slice()), st]);
  // a familia() da copia, com a mesma regra da lib (primeira faixa que contem o codigo)
  const fnDe = (t) => (c) => { for (const [fam, tipo, origem, fx, st] of t) if (fx.some(([a2, b2]) => c >= a2 && c <= b2)) return { fam, tipo, origem, ...(st ? { string: st(c) } : {}) };
    return { fam: 'fora_manual', tipo: null, origem: null }; };
  ok(confereDic(copia(), fnDe(copia())).length === 0, 'a copia sem plantio passa (o plantio e o que reprova)');
  const planta1 = (nome, muda) => { const t = copia(); muda(t); ok(confereDic(t, fnDe(t)).length > 0, 'plantio no dicionario "' + nome + '" reprova'); };
  planta1('ponta de faixa 579 vira 578', (t) => { t.find((x) => x[0] === 'reversa_fv')[3][1][1] = 578; });
  planta1('faixa 448-479 vira 448-497', (t) => { t.find((x) => x[0] === 'conexao_reversa')[3][3][1] = 497; });
  planta1('subfrequencia 9 vira 18', (t) => { t.find((x) => x[0] === 'subfrequencia_rede')[3][0] = [18, 18]; });
  planta1('sobrefrequencia com origem equipamento', (t) => { t.find((x) => x[0] === 'sobrefrequencia_rede')[2] = 'equipamento'; });
  planta1('alarme do boost como falha', (t) => { t.find((x) => x[0] === 'boost_sobretensao_alarme')[1] = 'falha'; });
  planta1('ilhamento com string', (t) => { t.find((x) => x[0] === 'ilhamento')[4] = () => 1; }); }

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
// grandezas por inversor (t em 0,1 °C, iso kΩ, ef em 0,01 %); o 601 tem potencia limitada de 10:00 a 15:00 (indices 120 a 179)
// o 501 com um modulo a menos no MPPT3 (0,966 = 28/29, arredondado como o logger grava), o 502 com metade da corrente no MPPT7
Object.assign(INVS[0], { q: { t: 450, iso: 500, ef: 9870, mppt: { 3: 0.966 } } }); Object.assign(INVS[1], { q: { t: 470, iso: 300, ef: 9850, mpptI: { 7: 0.5 } } });
Object.assign(INVS[2], { q: { t: 520, iso: 800, ef: 9880, lim: [120, 180] } }); Object.assign(INVS[3], { q: { t: 430, iso: 450, ef: 9860 } });
PARADO.q = { t: 400, iso: 900, ef: 9870 };
/* o DIA MISTO: o 505 (TS5) inteiro em 28/09 e parcial em 29/09 (logger ate 12:30), com a temperatura mais alta e o
   isolamento mais baixo da usina; no resumo de 29/09 ele NAO pode entrar nas grandezas fisicas */
const MISTO = { sn: 'A0000000505', pos: 'M1/TS5/INV05', v0: 860000, f: 0.90, dia0: DIAS[0], q: { t: 600, iso: 100, ef: 9800 } };
const TODOS = [...INVS, PARADO, VELHO, MISTO];
/* tipo e origem DESCASADOS de proposito: 28/09 uma falha de rede (10, ilhamento, no 601) e um alarme de equipamento no 602
   (532 duas vezes e 533: a mesma familia, as amostras SOMAM); 29/09 so alarme de equipamento (532 tres vezes, no 502);
   30/09 uma falha de equipamento (38, falha do sistema, no 501) e um codigo fora do manual (639, no 601); 01/10, dia
   PARCIAL do 501, uma falha de equipamento (39, isolacao baixa) as 04:10 */
const COD = { A0000000502: { '2026-09-29': { 100: 532, 101: 532, 102: 532 } }, A0000000601: { '2026-09-28': { 80: 10 }, '2026-09-30': { 90: 639 } },
  A0000000602: { '2026-09-28': { 100: 532, 101: 532, 102: 533 }, '2026-09-30': { 90: 38, 100: 532, 110: 548 } }, A0000000501: { '2026-09-30': { 90: 38 }, '2026-10-01': { 50: 39 } } };
// 30/09 no 602: uma falha (38) e DOIS alarmes de familias diferentes (532 reversa_fv, 548 entrada_anormal) no MESMO
// inversor-dia: o tipo do dia e o OU dos bits (3); somar daria 4 (lote sungrow-saude-tipo, RE-001)
// um numero de serie que o SCADA nao tem, noutra usina (M6): fica sem posicao, e a busca dele e LEMBRADA
const NUNCA = 'A0000000999';
mk(path.join(RAW, 'M10', 'TS05', '01 A 05')); mk(path.join(RAW, 'M10', 'TS05', 'PID 100')); mk(path.join(RAW, 'M06', 'TS01', '01 A 05'));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '28.09 A 30.09.zip'), zip([...INVS, PARADO].map((x, i) =>
  ({ nome: 'hiscsv/HIS_' + x.sn + '_202609280000_202609302355.csv', dados: csvInversor(x.v0, x.f, INV_COLS, null, null, COD[x.sn], x.q), metodo: i % 2 ? 8 : 0 }))));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '28.09 A 29.09.zip'), zip([{ nome: 'hiscsv/HIS_' + MISTO.sn + '_202609280000_202609292355.csv',
  dados: csvInversor(MISTO.v0, MISTO.f, INV_COLS, ['2026-09-28', '2026-09-29'], { '2026-09-29': [0, 150] }, null, MISTO.q), metodo: 8 }]));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '00 parcial.zip'), zip([{ nome: 'hiscsv/HIS_' + INVS[1].sn + '_202609280000_202609281100.csv',
  dados: csvInversor(INVS[1].v0, INVS[1].f, INV_COLS, ['2026-09-28'], { '2026-09-28': [0, 132] }, null, { mppt: { 2: 0.9 } }), metodo: 8 }]));
fs.writeFileSync(path.join(RAW, 'M10', 'TS05', '01 A 05', '29.09 B.zip'), zip([{ nome: 'hiscsv/HIS_' + INVS[0].sn + '_202609290000_202609291100.csv',
  dados: csvInversor(INVS[0].v0, INVS[0].f, INV_COLS, ['2026-09-29'], { '2026-09-29': [0, 132] }, null, { mppt: { 3: 0.9 } }), metodo: 8 }]));
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
  dados: csvInversor(fimDia(x, 2), x.f, INV_COLS, Object.keys(PARC), PARC, COD[x.sn], x.q), metodo: 8 }))));
// o logger e o PID do TS6, na pasta do TS05: a potencia do logger e a SOMA dos dois inversores do TS6
const EST_COLS = ['Horário', 'Utilização da CPU', 'Valor da amostra PT 1', 'Valor da amostra PT 2', 'Potência ativa total',
  'Valor de potência FV ativa definida', 'Taxa de potência ativa', 'Quantidade de inversores', 'Número de dispositivos conectados à rede', 'Máx. potência ativa nominal total'];
const est = [];
/* as temperaturas PT100 seguem a carga: PT 1 = 30 + P/20000 °C, PT 2 = 31 + P/18000 °C (P em W); um ZERO solto no PT 1 as
   04:10 (sem leitura, nao temperatura) e o PT 2 sem sensor (32767) em 28/09 */
const PT1 = (p) => Math.round((30 + p / 20000) * 10) / 10, PT2 = (p) => Math.round((31 + p / 18000) * 10) / 10;
/* o eletrocentro (quantidade, rede, capacidade): de noite (potencia zero) nenhum inversor na rede e capacidade zero, como
   no logger real. Em 29/09:
     12:30 a 13:25 (indices 150 a 161, doze amostras gerando) UM inversor fora: capacidade 352, rede 1 -> 1 hora-inversor fora
     06:05 (indice 73, 267 W, abaixo do piso de 1 kW) um inversor fora: NAO conta
     15:00 (indice 180) rede 3 com quantidade 2: conta zero, nao abate
     14:10 e 14:15 (170, 171) potencia ZERO com os inversores na rede: a amostra fica no arquivo (o evento que ele mostra)
     14:20 e 14:25 (172, 173) potencia zero, capacidade zero e rede 2: fica pela rede
     14:30 e 14:35 (174, 175) potencia zero, rede ZERO e capacidade 704 (inversores ligados sem rede): fica pela capacidade
   Em 28/09 a rede SEM LEITURA (65535) a partir das 15:00 (indice 180): as horas fora so julgam a manha, e o dia diz quantas
   amostras julgou. Em 30/09 sem leitura o dia inteiro: horas fora nulas, nunca zero */
const etcDe = (p, di, k) => {
  if (di === 1 && k >= 170 && k < 172) return [2, 2, 704];
  if (di === 1 && k >= 172 && k < 174) return [2, 2, 0];
  if (di === 1 && k >= 174 && k < 176) return [2, 0, 704];
  if (p <= 0) return [2, 0, 0];
  if (di === 1 && ((k >= 150 && k < 162) || k === 73)) return [2, 1, 352];
  if (di === 1 && k === 180) return [2, 3, 1056];
  if (di === 0 && k >= 180) return [2, 65535, 704];
  return [2, di === 2 ? 65535 : 2, 704]; };
const pEst = (di, k) => (di === 1 && k >= 170 && k < 176 ? 0 : perfil(k, 0.95) + perfil(k, 0.92));
const gerando = (di) => HH.map((h, k) => k).filter((k) => pEst(di, k) > 1000);   // as amostras que as horas fora julgam
DIAS.forEach((d, di) => HH.forEach((h, k) => { const p = pEst(di, k);
  est.push([d + ' ' + h + ':00', 20, k === 50 ? 0 : PT1(p), di === 0 ? 32767 : PT2(p), p, 7040, 1000, ...etcDe(p, di, k)].join(', ')); }));
const PID_H = ['Horário', ...Object.values(S.PID_COLS)];
const pid = []; for (const d of DIAS) HH.forEach((h, k) => pid.push([d + ' ' + h + ':00', 75, k > 240 ? 300 : 0, k > 240 ? 2 : 0, 45, 0, 0, 85].join(', ')));
// um dia NOVO do logger do TS6 (01/10), so na rodada 4: o arquivo do PT100 por eletrocentro tem de ACUMULAR
const estDia = (d) => HH.map((h, k) => { const p = perfil(k, 0.95) + perfil(k, 0.92); return [d + ' ' + h + ':00', 20, PT1(p), PT2(p), p, 7040, 1000, ...etcDe(p, -1, k)].join(', '); });
const N_GER = HH.filter((h, k) => perfil(k, 0.95) + perfil(k, 0.92) > 0).length;   // amostras de um dia com o eletrocentro gerando
const ZIP_EST_NOVO = path.join(RAW, 'M10', 'TS05', 'PID 100', '01.10.zip');
// e um dia NOVO do 501 (04/10), na rodada 4: o arquivo dos MPPT por eletrocentro tem de ACUMULAR
const ZIP_INV_NOVO = path.join(RAW, 'M10', 'TS05', '01 A 05', '04.10.zip');
// a TROCA na rodada 4: o 512 assume a posicao do 502 (M1/TS5/INV02) a partir de 30/09, com o MPPT5 a 0,9; o 502 continua com
// registro de 30/09 no zip dele, e nao pode mais valer nesse dia
const TROCA = { sn: 'A0000000512', pos: 'M1/TS5/INV02', v0: 900000, f: 0.97, q: { mppt: { 5: 0.9 } } };
const ZIP_TROCA = path.join(RAW, 'M10', 'TS05', '01 A 05', '30.09 troca.zip');
// os instantes que a tensao dos MPPT julga: inversor acima de 150 kW e sem limitacao (o 601 limitado de 120 a 179)
const julgados = (f, lim) => HH.map((h, k) => k).filter((k) => perfil(k, f) > 150000 && !(lim && k >= lim[0] && k < lim[1])).length;
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
function cenario(gen, lib) {
  const R = { txt: {} };
  { const q = require.resolve(lib || './lib-sungrow.js'); delete require.cache[q]; R.okLibMppt = casosMppt(require(q)).ok; delete require.cache[q]; }
  for (const n of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, n));
  const novo = path.join(RAW, 'M06', 'TS01', '01 A 05', '26.09.zip');
  if (fs.existsSync(novo)) fs.unlinkSync(novo);
  if (fs.existsSync(ZIP_EST_NOVO)) fs.unlinkSync(ZIP_EST_NOVO);
  if (fs.existsSync(ZIP_INV_NOVO)) fs.unlinkSync(ZIP_INV_NOVO);
  if (fs.existsSync(ZIP_TROCA)) fs.unlinkSync(ZIP_TROCA);
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
    // a temperatura do eletrocentro: o resumo do dia e a serie de 5 min, no TS do logger (TS6), sem o zero e sem o sentinela
    const pMax = Math.max(...HH.map((h, k) => perfil(k, 0.95) + perfil(k, 0.92))), t29 = T.find((x) => x.d === '2026-09-29') || {}, t28 = T.find((x) => x.d === '2026-09-28') || {};
    const PT = le('sg_pt_5min_M1.json').serie, pt12 = PT.find((x) => x.t === '2026-09-29 12:00') || {};
    R.okPt = t29.pt1_max === PT1(pMax) && t29.pt1_h === '12:00' && t29.pt1_min === 30 && t29.n_pt1 === 287 && t29.pt2_max === PT2(pMax) && t29.pt2_min === 31
      && t28.pt2_max === null && t28.pt2_min === null && t28.n_pt2 === 0 && t28.pt1_min === 30
      && PT.length === 863 && PT.every((x) => x.chave === 'M1/TS6') && pt12.pt1 === PT1(pMax) && pt12.pt2 === PT2(pMax) && pt12.p === pMax / 1000
      && pt12.ms === Date.parse('2026-09-29T12:00:00-03:00') && !PT.some((x) => x.pt1 === 0 || x.pt2 === 32767);
    // o arquivo POR ELETROCENTRO: so o TS do logger (TS6), com as mesmas linhas da serie de 5 min, e o ms do instante
    const leOu = (n) => (fs.existsSync(path.join(OUT, n)) ? le(n) : { serie: [] });
    const ET = leOu('sg_pt_M1_TS6.json').serie, et12 = ET.find((x) => x.t === '2026-09-29 12:00') || {};
    R.okPtEtc = ET.length === 863 && !fs.existsSync(path.join(OUT, 'sg_pt_M1_TS5.json')) && et12.pt1 === PT1(pMax) && et12.pt2 === PT2(pMax)
      && et12.p === pMax / 1000 && et12.ms === Date.parse('2026-09-29T12:00:00-03:00') && ET[0].t === '2026-09-28 00:00';
    // o eletrocentro de 5 min: so o TS do logger, so as amostras com geracao, a hora com um inversor fora; e as horas fora no dia
    const EC = leOu('sg_etc_M1_TS6.json').serie, ec = (t) => EC.find((x) => x.t === t) || {};
    const p1230 = HH.map((h, k) => perfil(k, 0.95) + perfil(k, 0.92))[150];
    // a regra do arquivo: fica a amostra com potencia, capacidade OU rede; so a noite (os tres zero) sai
    R.okEtc = EC.length === DIAS.length * N_GER && !fs.existsSync(path.join(OUT, 'sg_etc_M1_TS5.json'))
      && EC.every((x) => x.p > 0 || x.cap > 0 || x.rede > 0)
      && ec('2026-09-29 12:30').cap === 352 && ec('2026-09-29 12:30').rede === 1 && ec('2026-09-29 12:30').qtd === 2 && ec('2026-09-29 12:30').p === Math.round(p1230 / 100) / 10
      && ec('2026-09-29 12:30').ms === Date.parse('2026-09-29T12:30:00-03:00') && ec('2026-09-29 13:30').rede === 2 && ec('2026-09-28 12:30').cap === 704
      && ec('2026-09-29 14:10').p === 0 && ec('2026-09-29 14:10').rede === 2 && ec('2026-09-29 14:20').cap === 0 && ec('2026-09-29 14:20').rede === 2
      && ec('2026-09-29 14:30').p === 0 && ec('2026-09-29 14:30').rede === 0 && ec('2026-09-29 14:30').cap === 704
      && ec('2026-09-30 12:00').rede === null && ec('2026-09-30 12:00').cap === 704
      && t28.n_ger5 === gerando(0).length && t28.n_fora === gerando(0).filter((k) => k < 180).length && t28.n_fora < t28.n_ger5
      && t29.n_fora === t29.n_ger5 && T.find((x) => x.d === '2026-09-30').n_fora === 0 && T.find((x) => x.d === '2026-09-30').n_ger5 > 0
      && t29.inv_h_fora === 1 && t28.inv_h_fora === 0 && T.find((x) => x.d === '2026-09-30').inv_h_fora === null;
    // os campos de trabalho (_p, _pt, _etc) nao vazam para o publico nem para o historico
    // a tensao dos MPPT: o 501 (M1/TS5/INV01) com o MPPT3 a 0,966, o MPPT12 vazio nulo; o 502 com metade da corrente no MPPT7;
    // o 601 (M1/TS6/INV01) com o MPPT5 desviado SO durante a limitacao: razao 1; e o ranking com o MPPT3 do 501 em primeiro
    const M5 = leOu('sg_mppt_M1_TS5.json').serie, M6 = leOu('sg_mppt_M1_TS6.json').serie, RK = leOu('sg_mppt.json').serie;
    const mm = (L, inv, d) => L.find((x) => x.inv === inv && x.d === d) || { r: [], i: [] };
    const a1 = mm(M5, 'INV01', '2026-09-29'), a2 = mm(M5, 'INV02', '2026-09-29'), b1 = mm(M6, 'INV01', '2026-09-29');
    R.okMppt = a1.r[2] === 0.966 && a1.r[0] === 1 && a1.r[11] === null && a1.i[2] === 1 && a1.v === 1300 && a1.n === julgados(1)
      && a1.ms === Date.parse('2026-09-29T00:00:00-03:00') && a2.r[6] === 1 && a2.i[6] === 0.5
      // o parcial do 502 em 28/09 lido ANTES do inteiro (e o do 501 em 29/09 lido DEPOIS): fica o de mais instantes
      && mm(M5, 'INV02', '2026-09-28').r[1] === 1 && mm(M5, 'INV02', '2026-09-28').n === julgados(0.97) && a1.sn === INVS[0].sn
      && b1.r[4] === 1 && b1.n === julgados(0.95, [120, 180]) && !M5.some((x) => x.inv === 'INV04')
      && RK.length > 0 && RK[0].ufv === 'M1' && RK[0].ts === 'TS5' && RK[0].inv === 'INV01' && RK[0].mppt === 3 && RK[0].r === 0.966
      && RK[0].mod === 0.99 && RK[0].dias === 5 && !RK.some((x) => x.ts === 'TS6') && !RK.some((x) => x.mppt === 12)
      // a corrente do ranking: o MPPT7 do 502 pela metade (na rodada 4 a troca o tira da janela: so 4 dias na posicao)
      && RK.some((x) => x.ts === 'TS5' && x.inv === 'INV02' && x.mppt === 7 && x.i === 0.5 && x.r === 1);
    R.txt.mppt = '501 MPPT3 ' + a1.r[2] + ' MPPT12 ' + a1.r[11] + ' n ' + a1.n + ' (esperado ' + julgados(1) + ') · 502 MPPT7 i ' + a2.i[6]
      + ' · 601 MPPT5 ' + b1.r[4] + ' · ranking ' + RK.length + ', 1o ' + (RK[0] ? RK[0].ufv + '/' + RK[0].ts + '/' + RK[0].inv + ' MPPT' + RK[0].mppt + ' ' + RK[0].r + ' (' + RK[0].mod + ' modulo, ' + RK[0].dias + ' d)' : '—');
    R.okSemTrabalho = T.length > 0 && Object.keys(le('sg_hist.json').est).length > 0 && T.every((x) => !Object.keys(x).some((k) => k[0] === '_'))
      && le('sg_inv_dia_M1.json').serie.length > 0 && le('sg_inv_dia_M1.json').serie.every((x) => !Object.keys(x).some((k) => k[0] === '_'))
      && Object.values(le('sg_hist.json').inv).every((o) => Object.values(o.dias).every((x) => !Object.keys(x).some((k) => k[0] === '_')))
      && Object.values(le('sg_hist.json').est).every((o) => Object.values(o.dias).every((x) => !Object.keys(x).some((k) => k[0] === '_')));
    R.txt.etc = EC.length + ' linhas (esperado ' + DIAS.length * N_GER + ') · 29/09 12:30 cap ' + ec('2026-09-29 12:30').cap + ' rede ' + ec('2026-09-29 12:30').rede
      + ' · horas fora 28/09 ' + t28.inv_h_fora + ', 29/09 ' + t29.inv_h_fora + ', 30/09 ' + (T.find((x) => x.d === '2026-09-30') || {}).inv_h_fora;
    R.txt.pt = '29/09 PT1 ' + t29.pt1_max + ' as ' + t29.pt1_h + ' min ' + t29.pt1_min + ' n ' + t29.n_pt1 + ' · PT2 ' + t29.pt2_max + ' · 28/09 PT2 ' + t28.pt2_max + ' · 5 min ' + PT.length + ' linhas, ' + pt12.chave;
    const p29 = P.find((x) => x.d === '2026-09-29');
    R.okPidCampos = !!p29 && p29.v_max === 300 && !('min_saida' in p29) && !('ini_saida' in p29) && !('fim_saida' in p29);
    // a conferencia: os dias inteiros fecham em 1; os parciais do logger ficam FORA (n 0, razao nula), contados em n_parcial
    const cd = (d) => C.find((x) => x.d === d) || {};
    R.okConf = DIAS.every((d) => cd(d).n === 4 && cd(d).n_parcial === 0 && Math.abs(cd(d).razao - 1) <= TOL_R)
      && cd('2026-09-25').n === 1 && Math.abs(cd('2026-09-25').razao - 1) <= TOL_R
      && Object.keys(PARC).every((d) => cd(d).n === 0 && cd(d).n_parcial === 2 && cd(d).razao === null);
    R.txt.conf = C.map((x) => x.d.slice(5) + ' ' + x.n + '+' + x.n_parcial + ' ' + x.razao).join(' · ');
    const M1 = le('sg_inv_dia_M1.json').serie, ehParc = (x) => x.d in PARC || (x.sn === MISTO.sn && x.d === '2026-09-29');
    R.okInv = M1.length === 24 && M1.every((x) => x._p === undefined) && M1.every((x) => x.parcial === ehParc(x))
      && M1.filter((x) => !ehParc(x)).every((x) => Math.abs(x.e - eDia(TODOS.find((y) => y.sn === x.sn))) <= TOL_E);
    R.okParado = M1.filter((x) => x.sn === PARADO.sn).length === 3 && M1.filter((x) => x.sn === PARADO.sn).every((x) => x.ini === null && x.parcial === false);
    R.txt.inv = M1.filter(ehParc).map((x) => x.d.slice(5) + ' ' + x.t0 + '-' + x.t1).join(' ');
    // a saude: o recorte por usina e o resumo do conjunto
    const SA = le('sg_saude_M1.json').serie, SS = le('sg_saude.json');
    const sl = (sn, d) => { const x = TODOS.find((y) => y.sn === sn); const [, ts, inv] = x.pos.split('/'); return SA.find((r) => r.d === d && r.ts === ts && r.inv === inv) || {}; };
    const ud = (d) => SS.usina_dia.find((x) => x.d === d && x.ufv === 'M1') || {};
    const fd = (d, f) => SS.familia_dia.find((x) => x.d === d && x.ufv === 'M1' && x.fam === f) || {};
    // a fracao de instantes gerando (P > 1 kW) com potencia limitada, contada aqui do perfil forjado
    const limEsp = (f, a, b) => { const g = HH.map((h, k) => k).filter((k) => perfil(k, f) / 1000 > 1); return Math.round(1000 * g.filter((k) => k >= a && k < b).length / g.length) / 10; };
    const i601 = M1.find((x) => x.sn === 'A0000000601' && x.d === '2026-09-29') || {}, s601 = sl('A0000000601', '2026-09-29');
    // o tipo do dia (bits): 1 alarme, 2 falha, 4 fora do manual; sem codigo, sem campo
    const TPC = [['A0000000502', '2026-09-29', 1], ['A0000000601', '2026-09-28', 2], ['A0000000602', '2026-09-28', 1], ['A0000000601', '2026-09-30', 4],
      ['A0000000501', '2026-09-30', 2], ['A0000000602', '2026-09-30', 3], ['A0000000501', '2026-10-01', 2], ['A0000000501', '2026-09-29', undefined]];
    // a linha tem de EXISTIR (sl devolve {} quando falta): sem codigo, sem o campo
    R.okSaudeTipo = TPC.every(([sn, d, t]) => { const x = sl(sn, d); return x.d === d && (t === undefined ? !('tp' in x) : x.tp === t); });
    R.txt.tp = TPC.map(([sn, d, t]) => { const x = sl(sn, d); return sn.slice(-3) + ' ' + d.slice(5) + '=' + (x.d ? x.tp : 'SEM LINHA') + '(esp ' + t + ')'; }).join(' · ');
    R.okSaudeLinhas = SA.length === 24 && JSON.stringify(sl('A0000000502', '2026-09-29').f) === '{"532":3}'
      && JSON.stringify(sl('A0000000502', '2026-09-29').ev) === '{"reversa_fv":3}' && JSON.stringify(sl('A0000000601', '2026-09-28').ev) === '{"ilhamento":1}'
      && JSON.stringify(sl('A0000000602', '2026-09-28').f) === '{"532":2,"533":1}' && JSON.stringify(sl('A0000000602', '2026-09-28').ev) === '{"reversa_fv":3}'
      && JSON.stringify(sl('A0000000601', '2026-09-30').ev) === '{"fora_manual":1}' && JSON.stringify(sl('A0000000501', '2026-10-01').ev) === '{"isolacao_baixa":1}'
      && sl('A0000000501', '2026-09-29').f === undefined
      && sl('A0000000501', '2026-10-01').p === 1 && sl('A0000000501', '2026-09-29').p === 0 && sl('A0000000501', '2026-09-29').ms === Date.parse('2026-09-29T00:00:00-03:00');
    // uma linha inteira, campo a campo, contra o sg_inv_dia da mesma rodada; e a limitacao contra a conta feita aqui
    R.okSaudeCampos = s601.e === i601.e && s601.tm === i601.t_max && s601.ef === i601.ef_med && s601.iso === i601.iso_min && s601.lim === i601.lim_pct
      && s601.ini === i601.ini && s601.fim === i601.fim && s601.tm === 52 && s601.ef === 98.8 && s601.iso === 800 && s601.lim === limEsp(0.95, 120, 180) && s601.lim > 0;
    R.txt.campos = 'e ' + s601.e + ' tm ' + s601.tm + ' ef ' + s601.ef + ' iso ' + s601.iso + ' lim ' + s601.lim + ' (esperado ' + limEsp(0.95, 120, 180) + ') ' + s601.ini + '-' + s601.fim;
    const conta = (d, n_ev, n_alarme, n_falha, n_rede, n_equip) => { const x = ud(d);
      return x.n_ev === n_ev && x.n_alarme === n_alarme && x.n_falha === n_falha && x.n_rede === n_rede && x.n_equip === n_equip; };
    R.okSaudeResumo = conta('2026-09-28', 2, 1, 1, 1, 1) && conta('2026-09-29', 1, 1, 0, 0, 1) && conta('2026-09-30', 3, 1, 2, 0, 2)
      // evento em dia PARCIAL conta: 01/10 sem nenhum inversor inteiro, com a falha de isolacao do 501
      && conta('2026-10-01', 1, 0, 1, 0, 1) && ud('2026-10-01').n_inv === 0
      && fd('2026-09-29', 'reversa_fv').n_inv === 1 && fd('2026-09-29', 'reversa_fv').amostras === 3 && fd('2026-09-29', 'reversa_fv').tipo === 'alarme'
      && fd('2026-09-28', 'reversa_fv').n_inv === 1 && fd('2026-09-28', 'reversa_fv').amostras === 3 && fd('2026-09-28', 'ilhamento').origem === 'rede'
      // 29/09 e o dia MISTO: o 505 parcial (60 °C, 100 kΩ, 98,0 %) fica fora; inteiros 501, 502, 601, 602 e o parado
      && ud('2026-09-29').n_inv === 5 && ud('2026-09-29').tm_max === 52 && ud('2026-09-29').tm_med === 45 && ud('2026-09-29').iso_min === 300
      && ud('2026-09-29').ef_med === 98.7 && ud('2026-09-29').lim_med === 0 && ud('2026-09-28').n_inv === 6
      // dia em que todo inversor lido e parcial: nenhuma grandeza fisica (so evento)
      && ud('2026-10-01').tm_max === null && ud('2026-10-01').lim_med === null && ud('2026-10-01').ef_med === null && ud('2026-10-01').iso_min === null;
    R.txt.saude = ['09-28', '09-29', '09-30', '10-01'].map((d) => { const x = ud('2026-' + d); return d + ' inv ' + x.n_inv + ' ev ' + x.n_ev + ' al ' + x.n_alarme + ' fa ' + x.n_falha + ' rede ' + x.n_rede + ' eq ' + x.n_equip + ' tm ' + x.tm_max + ' iso ' + x.iso_min; }).join(' · ');
    const antes = Object.fromEntries(fs.readdirSync(OUT).map((n) => [n, semGerado(n)]));
    // 2 · segunda rodada: nada novo
    log = roda(gen);
    R.okIdem = /novos ou mudados: 0/.test(log) && fs.readdirSync(OUT).every((n) => semGerado(n) === antes[n]);
    R.okNaoRepete = lidosFundo(log) === 0;
    // 3 · migracao por MARCA, com o esquema 5 FIEL (o que esta no ar): o historico igual (os MPPT nunca foram para ele), e SEM
    //     os arquivos dos MPPT (os do PT100 e do eletrocentro de 5 min ja existem e ficam)
    const h = le('sg_hist.json'); h.esquema = 5;
    for (const n of fs.readdirSync(OUT)) if (/^sg_mppt(_M\d+_TS\d+)?\.json$/.test(n)) fs.unlinkSync(path.join(OUT, n));
    grava('sg_hist.json', h);
    log = roda(gen);
    R.okMigra = /esquema 5 -> 6: relendo todos os zips/.test(log) && /novos ou mudados: [1-9]/.test(log)
      && Object.keys(antes).length > 0 && Object.keys(antes).every((n) => fs.existsSync(path.join(OUT, n)) && semGerado(n) === antes[n]);
    // 4 · dia novo do inversor sem posicao: a busca VOLTA (1 export do M6) e a memoria anda para o dia novo
    fs.writeFileSync(novo, zipNunca('2026-09-26'));
    fs.writeFileSync(ZIP_EST_NOVO, zip([{ nome: 'hiscsv/HIS_B0000000006_202610010000_202610012355.csv', dados: '﻿' + EST_COLS.join(',') + '\n' + estDia('2026-10-01').join('\n') + '\n', metodo: 8 }]));
    fs.writeFileSync(ZIP_INV_NOVO, zip([{ nome: 'hiscsv/HIS_' + INVS[0].sn + '_202610040000_202610042355.csv',
      dados: csvInversor(fimDia(INVS[0], 6), INVS[0].f, INV_COLS, ['2026-10-04'], null, null, INVS[0].q), metodo: 8 }]));
    fs.writeFileSync(ZIP_TROCA, zip([{ nome: 'hiscsv/HIS_' + TROCA.sn + '_202609300000_202610042355.csv',
      dados: csvInversor(TROCA.v0, TROCA.f, INV_COLS, ['2026-09-30', '2026-10-04'], null, null, TROCA.q), metodo: 8 }]));
    { const I4 = le('sg_ident.json');
      I4.ident[TROCA.sn] = { pos: TROCA.pos, d: '2026-09-30', metodo: 'contador de vida' };
      // um eletrocentro identificado SEM nenhum inversor-dia de MPPT (M1/TS7): tem de ter arquivo, com a serie vazia
      I4.ident.A0000000777 = { pos: 'M1/TS7/INV01', d: '2026-09-30', metodo: 'contador de vida' };
      grava('sg_ident.json', I4);
      /* no publicado do M1/TS5: o INV08 com 6 dias a mais de 365 dias do ultimo (saem do arquivo); o INV09 com 6 dias logo
         antes da janela de 30 (ficam no arquivo, fora do ranking); o INV10 com 5 dias e o INV11 com 4 dentro da janela (so o
         INV10 entra). O ultimo dia passa a ser 04/10: a janela vai de 05/09 a 04/10 */
      const P4 = le('sg_mppt_M1_TS5.json');
      const lin = (d, inv, r0) => ({ d, ms: Date.parse(d + 'T03:00:00Z'), inv, n: 50, v: 1300, r: [r0, ...Array(10).fill(1), null], i: Array(11).fill(1).concat([null]) });
      const dias = (d0, n) => Array.from({ length: n }, (_, k) => new Date(Date.parse(d0 + 'T00:00:00Z') + k * 864e5).toISOString().slice(0, 10));
      P4.serie.push(lin('2025-10-04', 'INV08', 0.5), lin('2025-10-05', 'INV08', 0.5), ...dias('2026-08-30', 6).map((d) => lin(d, 'INV09', 0.5)),
        ...dias('2026-09-20', 5).map((d) => lin(d, 'INV10', 0.8)), ...dias('2026-09-20', 4).map((d) => lin(d, 'INV11', 0.7)));
      grava('sg_mppt_M1_TS5.json', P4); }
    log = roda(gen);
    { const E = leOu('sg_mppt_M1_TS5.json').serie, K = leOu('sg_mppt.json'), INV = le('sg_inv_dia_M1.json').serie;
      const e = (inv, d) => E.filter((x) => x.inv === inv && x.d === d);
      // a troca: INV02 em 29/09 e do 502 (MPPT5 a 1); a partir de 30/09, do 512 (MPPT5 a 0,9), uma linha so, nos dois produtos
      const diasM = E.filter((x) => x.inv === 'INV02').map((x) => x.d).sort().join(), diasI = INV.filter((x) => x.ts === 'TS5' && x.inv === 'INV02').map((x) => x.d).sort().join();
      R.okTroca = diasM === diasI && E.filter((x) => x.inv === 'INV02' && x.d >= '2026-09-30').every((x) => x.sn === TROCA.sn)
        && !E.some((x) => x.inv === 'INV02' && (x.d === '2026-10-01' || x.d === '2026-10-03'))
        && e('INV02', '2026-09-29').length === 1 && e('INV02', '2026-09-29')[0].r[4] === 1 && e('INV02', '2026-09-30').length === 1
        && e('INV02', '2026-09-30')[0].r[4] === 0.9 && e('INV02', '2026-10-04').length === 1
        && INV.filter((x) => x.ts === 'TS5' && x.inv === 'INV02' && x.d === '2026-09-30').map((x) => x.sn).join() === TROCA.sn
        && INV.filter((x) => x.ts === 'TS5' && x.inv === 'INV02' && x.d === '2026-09-29').map((x) => x.sn).join() === INVS[1].sn;
      R.txt.troca = 'dias MPPT ' + diasM.split(',').map((d) => d.slice(5)).join(' ') + ' | resumo ' + diasI.split(',').map((d) => d.slice(5)).join(' ') + ' · ' + ['2026-09-29', '2026-09-30', '2026-10-04'].map((d) => d.slice(5) + ' mppt ' + JSON.stringify(e('INV02', d).map((x) => x.r[4]))
        + ' inv ' + INV.filter((x) => x.ts === 'TS5' && x.inv === 'INV02' && x.d === d).map((x) => x.sn.slice(-3)).join('+')).join(' · ');
      R.okMpptVazio = fs.existsSync(path.join(OUT, 'sg_mppt_M1_TS7.json')) && le('sg_mppt_M1_TS7.json').serie.length === 0;
      const rk = (inv, m) => (K.serie || []).find((x) => x.ts === 'TS5' && x.inv === inv && x.mppt === m);
      R.okMpptJanela = E.filter((x) => x.inv === 'INV08').map((x) => x.d).join() === '2025-10-05' && E.filter((x) => x.inv === 'INV09').length === 6 && K.de === '2026-09-05' && K.ate === '2026-10-04'
        && !rk('INV09', 1) && !!rk('INV10', 1) && rk('INV10', 1).r === 0.8 && rk('INV10', 1).dias === 5 && !rk('INV11', 1);
      // a ORDEM inteira do ranking: r crescente, depois usina/TS/inversor, depois MPPT; e a corrente do MPPT7 do 502
      const ch = (x) => x.ufv + '/' + x.ts + '/' + x.inv;
      const S4 = K.serie || [];
      R.okRankOrdem = S4.length > 0 && S4.every((x, i) => i === 0 || S4[i - 1].r < x.r || (S4[i - 1].r === x.r && (ch(S4[i - 1]) < ch(x) || (ch(S4[i - 1]) === ch(x) && S4[i - 1].mppt < x.mppt))))
        ;
      R.txt.r4 = 'ranking ' + S4.length + ' de ' + K.de + ' a ' + K.ate + ' · INV10 ' + JSON.stringify(rk('INV10', 1) || null) + ' · INV11 ' + (rk('INV11', 1) ? 'ENTROU' : 'fora');
      R.okMpptAcumula = E.some((x) => x.inv === 'INV01' && x.d === '2026-09-28' && x.r[2] === 0.966) && E.some((x) => x.inv === 'INV01' && x.d === '2026-10-04' && x.r[2] === 0.966)
        && E.some((x) => x.inv === 'INV02' && x.d === '2026-09-29') && !!rk('INV01', 3) && rk('INV01', 3).dias === 6; }
    { const E2 = (fs.existsSync(path.join(OUT, 'sg_pt_M1_TS6.json')) ? le('sg_pt_M1_TS6.json') : { serie: [] }).serie; R.okPtAcumula = E2.length === 863 + 288 && E2[0].t === '2026-09-28 00:00' && E2.some((x) => x.t === '2026-10-01 12:00'); }
    { const E3 = (fs.existsSync(path.join(OUT, 'sg_etc_M1_TS6.json')) ? le('sg_etc_M1_TS6.json') : { serie: [] }).serie;
      R.okEtcAcumula = E3.length === (DIAS.length + 1) * N_GER && E3.some((x) => x.t === '2026-09-29 12:30' && x.rede === 1) && E3.some((x) => x.t === '2026-10-01 12:00'); }
    R.okBuscaVolta = lidosFundo(log) === 1 && le('sg_ident.json').busca[NUNCA] === '2026-09-26';
    // 5 · linha sem t0/t1 (nao apurada) sai parcial nula e fora da conferencia
    const h2 = le('sg_hist.json'); delete h2.inv[INVS[0].sn].dias['2026-09-29'].t0; grava('sg_hist.json', h2);
    roda(gen);
    const l29 = le('sg_inv_dia_M1.json').serie.find((x) => x.sn === INVS[0].sn && x.d === '2026-09-29');
    const c29 = le('sg_conf.json').serie.find((x) => x.d === '2026-09-29');
    const s29 = le('sg_saude_M1.json').serie.find((r) => r.d === '2026-09-29' && r.ts === 'TS5' && r.inv === 'INV01') || {};
    const u29 = le('sg_saude.json').usina_dia.find((x) => x.d === '2026-09-29' && x.ufv === 'M1') || {};
    R.okNula = !!l29 && l29.parcial === null && c29.n === 3 && c29.n_parcial === 1 && s29.p === null && u29.n_inv === 4;
  } catch (e) { R.erro = String(e.message).split('\n')[0]; }
  return R;
}

const R = cenario(path.join(__dirname, 'gen-sungrow.js'));
if (R.erro) ok(false, 'o gerador estourou: ' + R.erro);
ok(R.okId, 'cada inversor na posicao do contador de vida, inclusive os dois do TS6 na pasta do TS5 e o que so existe no export velho: ' + R.txt.id);
ok(R.okBusca1, 'busca funda: ' + R.txt.busca1 + ' exports lidos (esperado 3: o teto pula o de 27/09 e a busca para no primeiro casamento)');
ok(R.okSemPos, 'sem posicao: so o numero de serie que o SCADA nao tem, com a busca lembrada pelo ultimo dia do logger (25/09)');
ok(R.okPid, 'o logger e o PID da pasta do TS5 vao para o TS6, pela potencia: ' + R.txt.pid);
ok(R.okPt, 'temperatura PT100 do eletrocentro: maximo, hora, minimo sem o zero solto, sensor ausente nulo, e a serie de 5 min no TS do logger com a potencia: ' + R.txt.pt);
ok(R.okPtEtc, 'PT100 por eletrocentro: um arquivo so do TS do logger (TS6), 863 linhas de 5 min, valores e instante iguais');
ok(R.okPtAcumula, 'PT100 por eletrocentro ACUMULA: com o dia novo do logger, 863 + 288 linhas e os dias antigos mantidos');
ok(R.okEtc, 'eletrocentro de 5 min: so o TS do logger, so com geracao, a capacidade e a rede da hora com um inversor fora, e as horas fora do dia: ' + R.txt.etc);
ok(R.okMppt, 'tensao dos MPPT: o modulo a menos, o MPPT vazio nulo, a corrente pela metade, a limitacao fora, e o ranking: ' + R.txt.mppt);
ok(R.okLibMppt, 'os casos de fronteira dos MPPT na lib usada pelo cenario');
ok(R.okTroca, 'a troca: o inversor retirado deixa de valer no primeiro dia do sucessor, no resumo do dia e nos MPPT (uma linha por posicao e dia)' + ': ' + R.txt.troca);
ok(R.okMpptVazio, 'eletrocentro identificado sem nenhum dia de MPPT tem arquivo, com a serie vazia');
ok(R.okMpptJanela, 'a janela: o arquivo corta o que passa de 365 dias, o ranking so ve os ultimos 30 e exige 5 dias: ' + R.txt.r4);
ok(R.okRankOrdem, 'o ranking inteiro em ordem (razao, posicao, MPPT)');
ok(R.okMpptAcumula, 'tensao dos MPPT ACUMULA: com o dia novo do inversor, os dias antigos mantidos e o ranking ate o dia novo');
ok(R.okSaudeTipo, 'o tipo do dia na saude: alarme, falha, os dois no mesmo inversor-dia e codigo fora do manual, em bits (OU): ' + R.txt.tp);
ok(R.okSemTrabalho, 'os campos de trabalho de 5 min nao vazam para o resumo do dia publicado nem para o historico');
ok(R.okEtcAcumula, 'eletrocentro de 5 min ACUMULA: com o dia novo do logger, os quatro dias de geracao, a hora do inversor fora mantida');
ok(R.okPidCampos, 'PID: tensao maxima 300 V, sem os minutos com tensao (esquema 2)');
ok(R.okConf, 'conferencia (folga ' + TOL_R.toFixed(6) + '): dias inteiros com razao 1; 01, 02 e 03/10 fora (n_parcial 2, razao nula): ' + R.txt.conf);
ok(R.okInv, 'sg_inv_dia_M1: 24 inversor-dias, parcial exatamente nos 7 (01 a 03/10 no TS5 e o 505 em 29/09: ' + R.txt.inv + '), energia dos inteiros a ' + TOL_E.toFixed(2) + ' kWh do SCADA');
ok(R.okSaudeLinhas, 'sg_saude_M1: 24 linhas; 532 vira reversa_fv, 532+532+533 somam 3 amostras na familia, 10 vira ilhamento, 639 fora do manual, 39 no dia parcial; parcial e ms BRT');
ok(R.okSaudeCampos, 'sg_saude_M1: a linha do 601 em 29/09 campo a campo igual ao sg_inv_dia, com a limitacao contada do perfil: ' + R.txt.campos);
ok(R.okSaudeResumo, 'sg_saude: alarme x falha e rede x equipamento contados em separado, evento em qualquer dia, grandeza fisica so do dia inteiro (dia misto 29/09): ' + R.txt.saude);
ok(R.okParado, 'o inversor parado o dia inteiro, lido inteiro, num dia em que a usina gerou: parcial = false');
ok(R.okIdem, 'segunda rodada: nenhum zip novo, produtos identicos');
ok(R.okNaoRepete, 'segunda rodada: a busca funda nao se repete (nenhum dado novo do inversor sem posicao)');
ok(R.okMigra, 'historico de esquema 5 FIEL (sem os arquivos dos MPPT): relido inteiro, produtos identicos (os arquivos refeitos)');
ok(R.okBuscaVolta, 'dia novo do inversor sem posicao: a busca volta (1 export) e a memoria anda para 26/09');
ok(R.okNula, 'linha sem t0/t1: parcial nula, fora da conferencia (29/09 com 3 + 1) e fora dos inteiros do resumo da saude');

/* ---------- 4 · plantios ---------- */
console.log('\n4 · plantios no gerador (cada um roda o cenario inteiro)');
const src = fs.readFileSync(path.join(__dirname, 'gen-sungrow.js'), 'utf8');
function planta(nome, de, para, chave) {
  if (src.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  const g = path.join(__dirname, '_plantio_sungrow.js');
  fs.writeFileSync(g, src.split(de).join(para));
  let r2;
  try { r2 = cenario(g); } finally { fs.unlinkSync(g); }
  ok(r2[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (r2.erro ? ' (e depois estourou: ' + r2.erro.slice(0, 80) + ')' : ''));
}
// o plantio na LIB: uma copia da lib mudada e um gerador que a le no lugar da original
const srcLib = fs.readFileSync(path.join(__dirname, 'lib-sungrow.js'), 'utf8');
function plantaLib(nome, de, para, chave) {
  if (srcLib.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou na lib'); return; }
  const lib = path.join(__dirname, '_plantio_lib_sungrow.js'), g = path.join(__dirname, '_plantio_sungrow.js');
  const req = "require('./lib-sungrow.js')";
  if (src.split(req).length !== 2) { ok(false, 'plantio ' + nome + ': o gerador nao le a lib 1x'); return; }
  fs.writeFileSync(lib, srcLib.split(de).join(para)); fs.writeFileSync(g, src.split(req).join("require('./_plantio_lib_sungrow.js')"));
  let r2;
  try { r2 = cenario(g, lib); } finally { fs.unlinkSync(g); fs.unlinkSync(lib); }
  ok(!r2.erro && r2[chave] === false, 'plantio na lib "' + nome + '" reprova em ' + chave + (r2.erro ? ' (estourou: ' + r2.erro + ')' : ''));
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
planta('grandeza de dia parcial no resumo', 'const inteiros = R.filter((r) => r.p === 0);', 'const inteiros = R;', 'okSaudeResumo');
planta('familia pela ordem do codigo, nao pela tabela', 'if (Object.keys(x.falha || {}).length) { r.f = x.falha; r.ev = evDe(x.falha); }',
  "if (Object.keys(x.falha || {}).length) { r.f = x.falha; r.ev = { [Object.keys(x.falha)[0] < 100 ? 'ilhamento' : 'reversa_fv']: 1 }; }", 'okSaudeLinhas');
planta('evento so de dia inteiro', 'n_ev: R.filter((r) => r.ev).length', 'n_ev: inteiros.filter((r) => r.ev).length', 'okSaudeResumo');
planta('rede conta qualquer evento', "n_rede: R.filter((r) => temTipo(r, 'origem', 'rede')).length", 'n_rede: R.filter((r) => r.ev).length', 'okSaudeResumo');
planta('alarme contado pela origem', "n_alarme: R.filter((r) => temTipo(r, 'tipo', 'alarme')).length", "n_alarme: R.filter((r) => temTipo(r, 'origem', 'equipamento')).length", 'okSaudeResumo');
planta('temperatura maxima com o parcial', 'tm_max: inteiros.length ? Math.max(...inteiros.map((r) => r.tm)', 'tm_max: inteiros.length ? Math.max(...R.map((r) => r.tm)', 'okSaudeResumo');
planta('isolamento minimo com o parcial', 'iso_min: inteiros.some((r) => r.iso != null) ? Math.min(...inteiros.map', 'iso_min: inteiros.some((r) => r.iso != null) ? Math.min(...R.map', 'okSaudeResumo');
planta('eficiencia pelo maximo', 'ef_med: mediana(inteiros.map((r) => r.ef))', 'ef_med: Math.max(...inteiros.map((r) => r.ef).filter((x) => x != null))', 'okSaudeResumo');
planta('familia sobrescreve em vez de somar', 'ev[f] = (ev[f] || 0) + n;', 'ev[f] = n;', 'okSaudeLinhas');
planta('parcial nulo vira inteiro na saude', 'p: x.parcial == null ? null : (x.parcial ? 1 : 0)', 'p: x.parcial ? 1 : 0', 'okNula');
planta('isolamento com a limitacao', 'iso: x.iso_min, lim: x.lim_pct', 'iso: x.lim_pct, lim: x.lim_pct', 'okSaudeCampos');
planta('temperatura de 5 min pela pasta', "const ch = o.ufv + '/' + tsDoLogger[sn].ts;", "const ch = o.ufv + '/' + o.pasta;", 'okPt');
plantaLib('zero do PT100 como temperatura', 'return x != null && x > 0 ? x : null;', 'return x != null ? x : null;', 'okPt');
planta('eletrocentro pela pasta', "const k = o.ufv + '_' + tsDoLogger[sn].ts;\n      const m = porEtc[k]", "const k = o.ufv + '_' + o.pasta;\n      const m = porEtc[k]", 'okEtc');
plantaLib('horas fora contando a noite', 'const fora = L.filter((v) => (num(v[c.p]) || 0) > 1000).map', 'const fora = L.map', 'okEtc');
plantaLib('noite pela quantidade de inversores', 'if (a.slice(0, 3).some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'if (a.some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'okEtc');
plantaLib('noite no eletrocentro de 5 min', 'if (a.slice(0, 3).some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'et5[hhmm(v)] = a;', 'okEtc');
plantaLib('capacidade pela placa', 'num(v[c.nom]), num(v[c.rede])', 'num(v[c.qtd]) * 352, num(v[c.rede])', 'okEtc');
plantaLib('eletrocentro so com potencia', 'if (a.slice(0, 3).some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'if (a[0] != null && a[0] > 0) et5[hhmm(v)] = a;', 'okEtc');
plantaLib('eletrocentro so com capacidade', 'if (a.slice(0, 3).some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'if (a[1] != null && a[1] > 0) et5[hhmm(v)] = a;', 'okEtc');
plantaLib('horas fora com piso zero', 'const fora = L.filter((v) => (num(v[c.p]) || 0) > 1000).map', 'const fora = L.filter((v) => (num(v[c.p]) || 0) > 0).map', 'okEtc');
plantaLib('rede acima da quantidade abate', 'Math.max(0, q - n)', '(q - n)', 'okEtc');
plantaLib('sem leitura da rede vira zero hora', 'return q == null || n == null ? null : Math.max(0, q - n); });',
  'return q == null || n == null ? 0 : Math.max(0, q - n); });', 'okEtc');
plantaLib('sem a capacidade no teste', 'if (a.slice(0, 3).some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'if ([a[0], a[2]].some((x) => x != null && x > 0)) et5[hhmm(v)] = a;', 'okEtc');
plantaLib('cobertura conta toda amostra gerando', 'n_fora: julgadas.length', 'n_fora: fora.length', 'okEtc');
planta('campo de trabalho do eletrocentro no historico', 'const v = x._etc; delete x._etc;', 'const v = x._etc;', 'okSemTrabalho');
plantaLib('MPPT com a limitacao', "if ((num(v[cp]) || 0) <= MPPT.p_min_w || num(v[cl]) !== 0) continue;", "if ((num(v[cp]) || 0) <= MPPT.p_min_w) continue;", 'okMppt');
plantaLib('MPPT sem piso de corrente', 'return x != null && i != null && i > MPPT.i_min ? x : null;', 'return x != null && i != null ? x : null;', 'okMppt');
plantaLib('MPPT contra a media', 'const mv = med(ok),', 'const mv = ok.reduce((a, b) => a + b, 0) / ok.length,', 'okMppt');
planta('ranking sem minimo de dias', 'if (rs.length < MPPT_DIAS_MIN) continue;', '', 'okMppt');
planta('modulos com o sinal trocado', 'mod: Math.round((1 - rm) * MOD_STRING * 100) / 100', 'mod: Math.round((rm - 1) * MOD_STRING * 100) / 100', 'okMppt');
planta('MPPT sem acumular', "const mTudo = new Map(antV.map((l) => [l.d + '|' + l.inv, l]));", 'const mTudo = new Map();', 'okMpptAcumula');
planta('linha antiga do retirado fica', 'const antV = ((ant && ant.serie) || []).filter((l) => vale(l, u, tsx));', 'const antV = ((ant && ant.serie) || []);', 'okTroca');
planta('o primeiro zip vence', 'if (v && (!mr[x.d] || v.n > mr[x.d].n)) mr[x.d] = v;', 'if (v && !mr[x.d]) mr[x.d] = v;', 'okMppt');
plantaLib('instante exige tres MPPT', 'if (ok.length < 2) continue;', 'if (ok.length < 3) continue;', 'okLibMppt');
planta('corte de 366 dias no MPPT', "const corte = ult ? new Date(Date.parse(ult + 'T00:00:00Z') - (DIAS_PT - 1) * 864e5)", "const corte = ult ? new Date(Date.parse(ult + 'T00:00:00Z') - (DIAS_PT) * 864e5)", 'okMpptJanela');
planta('corte de 364 dias no MPPT', "const corte = ult ? new Date(Date.parse(ult + 'T00:00:00Z') - (DIAS_PT - 1) * 864e5)", "const corte = ult ? new Date(Date.parse(ult + 'T00:00:00Z') - (DIAS_PT - 2) * 864e5)", 'okMpptJanela');
planta('campo de trabalho do MPPT no historico', 'const v = x._mppt; delete x._mppt;', 'const v = x._mppt;', 'okSemTrabalho');
plantaLib('MPPT com piso zero', 'i > MPPT.i_min ? x : null', 'i > 0 ? x : null', 'okLibMppt');
plantaLib('MPPT com o piso na escala errada', 'i_min: 30,', 'i_min: 3,', 'okLibMppt');
plantaLib('instante com um so MPPT', 'if (ok.length < 2) continue;', 'if (ok.length < 1) continue;', 'okLibMppt');
plantaLib('MPPT com qualquer numero de amostras', 'return z.length >= MPPT.amostras ? med(z) : null;', 'return z.length ? med(z) : null;', 'okLibMppt');
plantaLib('dia com qualquer numero de instantes', 'if (rs.length < MPPT.amostras) return null;', 'if (rs.length < 1) return null;', 'okLibMppt');
plantaLib('primeiro valor no lugar da mediana', 'return z.length >= MPPT.amostras ? med(z) : null;', 'return z.length >= MPPT.amostras ? z[0] : null;', 'okLibMppt');
plantaLib('coluna de MPPT faltando calada', "cv.push(exige(cab, 'Tensão MPPT' + k, 0, onde)); ci.push(exige(cab, 'Corrente MPPT' + k, 0, onde));", "cv.push(col(cab, 'Tensão MPPT' + k)); ci.push(col(cab, 'Corrente MPPT' + k));", 'okLibMppt');
planta('troca ignorada', 'return suc && d >= suc ? null : a.pos;', 'return a.pos;', 'okTroca');
planta('o ultimo zip vence', 'if (v && (!mr[x.d] || v.n > mr[x.d].n)) mr[x.d] = v;', 'if (v) mr[x.d] = v;', 'okMppt');
planta('arquivo do MPPT sem corte de 365 dias', 'const serie = ks.filter((c) => c.slice(0, 10) >= corte).map((c) => mTudo.get(c));', 'const serie = ks.map((c) => mTudo.get(c));', 'okMpptJanela');
planta('ranking sem a janela de 30 dias', 'if (l.d >= mDe) (porInv', 'if (true) (porInv', 'okMpptJanela');
planta('minimo de dias rebaixado', 'const MPPT_DIAS_MIN = 5;', 'const MPPT_DIAS_MIN = 4;', 'okMpptJanela');
planta('ranking com o desempate do MPPT invertido', '|| x.mppt - y.mppt);', '|| y.mppt - x.mppt);', 'okRankOrdem');
planta('corrente do ranking pela tensao', 'i: med(L.map((l) => l.i[m]))', 'i: med(L.map((l) => l.r[m]))', 'okMppt');
planta('eletrocentro sem MPPT sem arquivo', 'if (!novo.length && ant && !tirados) continue;', 'if (!novo.length) continue;', 'okMpptVazio');
planta('migracao sem o ranking', "pesos['sg_mppt.json'] = await escreve(", "if (!migra) pesos['sg_mppt.json'] = await escreve(", 'okMigra');
planta('tipo do dia pela origem', "(FAM[f] || {}).tipo === 'alarme' ? 1 :", "(FAM[f] || {}).origem === 'rede' ? 1 :", 'okSaudeTipo');
planta('codigo fora do manual vira falha', "(FAM[f] || {}).tipo === 'falha' ? 2 : 4), 0);", "(FAM[f] || {}).tipo === 'falha' ? 2 : 2), 0);", 'okSaudeTipo');
planta('tipo do dia soma os bits em vez de OU', "reduce((b, f) => b | ((FAM[f]", "reduce((b, f) => b + ((FAM[f]", 'okSaudeTipo');
planta('tipo do dia sobrescreve em vez de juntar', "reduce((b, f) => b | ((FAM[f]", "reduce((b, f) => 0 | ((FAM[f]", 'okSaudeTipo');
planta('PT100 por eletrocentro sem acumular', 'const tudo = new Map(((ant && ant.serie) || []).map', 'const tudo = new Map(([]).map', 'okPtAcumula');
planta('sem busca funda', 'if (!faltam.length) continue;', 'continue;', 'okId');
planta('busca sem teto', 'if (a.carimbo > teto) continue;', '', 'okBusca1');
planta('busca que nao para no casamento', 'if (!faltam.length) break;', '', 'okBusca1');
planta('busca nunca repetida', 'busca[sn] !== ultimo(sn)', '!(sn in busca)', 'okBuscaVolta');
planta('busca sem memoria', ' && busca[sn] !== ultimo(sn)', '', 'okNaoRepete');
// na transicao 3 -> 4 o que importa e RELER os zips (o arquivo por eletrocentro so se constroi lendo); migrar sem reler tem de reprovar
planta('migra sem reler os zips', 'const lidosAnt = REFAZER || migra ? null :', 'const lidosAnt = REFAZER ? null :', 'okMigra');

console.log(falhas.length ? '\n' + falhas.length + ' FALHA(S)' : '\nensaio-sungrow: tudo ok');
process.exit(falhas.length ? 1 : 0);
