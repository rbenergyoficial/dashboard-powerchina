/*
 * ensaio-pvstr-hora.js — prova que a curva de 30 min por inversor existe e que o PISO a protege.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA. Ate 13/09/2026 estas grandezas eram reduzidas ao dia — a corrente
 *    no pico, a temperatura maxima — e a curva que as produz era descartada. O humano pediu os
 *    intervalos QUATRO vezes e eu respondi tres que eles nao existiam, por ter conferido os blobs
 *    PUBLICADOS e generalizado para a fonte. Eles existem: a amostra e instantanea a cada 30 min,
 *    e o proprio gerador ja dizia isso por escrito, na linha 47.
 *
 * 🔴 E o piso e a parte que pode dar errado em silencio. A dispersao entre strings e uma RAZAO, e
 *    razao entre correntes pequenas estoura: sem piso, o amanhecer publica "string a 15% das
 *    irmas" na frota inteira e o painel vira um alarme diario que ninguem le. O numero saiu de
 *    MEDICAO, nos 160 inversores do M3 em 12/09, meia hora a meia hora: abaixo de 3 A de mediana a
 *    dispersao entre inversores e de 56 pp; acima dela, 28 pp.
 *
 * O que este ensaio exige, sobre os blobs PUBLICOS (sem segredo nenhum):
 *
 *   A · a curva EXISTE e tem o passo declarado — 30 min —, e todo campo de valor acompanha o eixo.
 *   B · a razao respeita o PISO: onde ela existe ha strings com corrente, e ela some nas pontas.
 *   C · FECHAMENTO com o diario, que e a conferencia que autoriza publicar: o maximo da curva de
 *       potencia tem de ser o `p_ca_max` do MESMO inversor no MESMO dia, e o maximo da temperatura
 *       o `temp_max`. Duas rotas sobre a mesma fonte; divergirem significa coluna trocada.
 *   D · NEGATIVA · a consequencia do piso no proprio produto: onde a razao existe, a potencia
 *       NUNCA e irrisoria. Sem piso ela existiria nas pontas, e sao esses pontos que se contam.
 *   E · o peso na REDE cabe no que a pagina pode pagar.
 *
 * uso: node ensaio-pvstr-hora.js [ufv]        (padrao: M3)
 */
'use strict';
const https = require('https');
const zlib = require('zlib');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const UFV = (process.argv[2] || 'M3').toUpperCase();
const PISO_A = 3;

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

const le = (nome) => new Promise((res, rej) => {
  /* LOCAL_DIR julga a saida de uma rodada local ANTES de publicar (24/09/2026): sem isto o ensaio so
     via o blob no ar, e uma correcao do gerador so podia ser provada depois de publicada */
  if (process.env.LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    let b = fs.readFileSync(path.join(process.env.LOCAL_DIR, nome));
    const gz = b[0] === 0x1f && b[1] === 0x8b;
    const naRede = gz ? b.length : zlib.gzipSync(b).length;   // o peso que a pagina paga e o COMPRIMIDO
    if (gz) b = zlib.gunzipSync(b);
    const j = JSON.parse(b.toString('utf8'));
    j.__bytes = naRede;
    res(j); return;
  }
  https.get(BASE + nome, { family: 4 }, (r) => {
    /* so o 404 e ausencia; qualquer outra falha estoura em vez de virar "nada a conferir" */
    if (r.statusCode !== 200) { r.resume(); rej(new Error(nome + ': HTTP ' + r.statusCode)); return; }
    const c = [];
    let bytes = 0;
    r.on('data', (d) => { c.push(d); bytes += d.length; });
    r.on('end', () => {
      try {
        let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        const j = JSON.parse(b.toString('utf8'));
        j.__bytes = bytes;
        res(j);
      } catch (e) { rej(e); }
    });
  }).on('error', rej);
});

const num = (x) => typeof x === 'number' && isFinite(x);
const q = (v, p) => v[Math.floor(v.length * p)];

(async () => {
  const h = await le('pvstr_hora_' + UFV + '.json');
  const s = Array.isArray(h.serie) ? h.serie : [];
  if (!s.length) { console.log('🔴 blob sem serie'); process.exit(1); }
  const dias = [...new Set(s.map((l) => l.d))].sort();
  console.log(UFV + ' · ' + s.length + ' inversor-dias · ' + dias.length + ' dias ('
    + dias[0] + ' a ' + dias[dias.length - 1] + ') · ' + Math.round(h.__bytes / 1024) + ' KB na rede');

  console.log('');
  console.log('A · a curva existe, com o passo declarado');
  {
    let pior = 0;
    let pontos = 0;
    let semH = 0;
    let quebrou = false;
    for (const l of s) {
      pontos += (l.h || []).length;
      if (!Array.isArray(l.h) || !l.h.length) { semH += 1; continue; }
      /* todo campo de valor tem de ter o MESMO comprimento do eixo: array mais curto desenharia
         uma curva que termina antes do dia, sem erro nenhum */
      for (const k of ['pcc', 'pca', 'ef', 'sn', 'sm', 'mm', 't', 'iso', 'sp']) {
        if (!Array.isArray(l[k]) || l[k].length !== l.h.length) {
          falha(l.d + ' ' + l.ts + '/' + l.inv + ': o campo ' + k + ' tem '
            + (Array.isArray(l[k]) ? l[k].length : 'nao-array') + ' contra ' + l.h.length + ' do eixo');
          quebrou = true;
          break;
        }
      }
      if (quebrou) break;
      const mm = l.h.map((x) => Number(String(x).slice(0, 2)) * 60 + Number(String(x).slice(3, 5)));
      for (let i = 1; i < mm.length; i += 1) pior = Math.max(pior, mm[i] - mm[i - 1]);
    }
    if (!quebrou) {
      ok(!semH, semH + ' inversor-dias sem eixo de hora');
      ok(pior === 30, 'maior vao entre amostras: ' + pior + ' min (o passo declarado e 30)');
      console.log('      ' + pontos + ' pontos de 30 min no arquivo');
    }
  }

  console.log('');
  console.log('B · a razao entre strings respeita o PISO de ' + PISO_A + ' A');
  {
    let comRazao = 0;
    let semRazao = 0;
    let razaoSemString = 0;
    const pontas = { com: 0, sem: 0 };
    for (const l of s) {
      for (let i = 0; i < l.h.length; i += 1) {
        const temR = num(l.sm[i]);
        if (temR) comRazao += 1; else semRazao += 1;
        if (temR && !(l.sn[i] >= 3)) razaoSemString += 1;
        /* "ponta" = os dois primeiros e os dois ultimos pontos do dia daquele inversor */
        if (i < 2 || i >= l.h.length - 2) { if (temR) pontas.com += 1; else pontas.sem += 1; }
      }
    }
    ok(!razaoSemString, razaoSemString + ' pontos com razao e menos de 3 strings com corrente');
    ok(comRazao > 0, comRazao + ' pontos COM razao · ' + semRazao + ' sem');
    const frac = pontas.sem / (pontas.com + pontas.sem);
    ok(frac > 0.3, 'nas PONTAS do dia a razao esta ausente em ' + (frac * 100).toFixed(0)
      + '% dos pontos — e ali que o piso tem de morder');
  }

  console.log('');
  console.log('C · FECHAMENTO com o diario — duas rotas sobre a mesma fonte');
  {
    const inv = await le('perdas_inv.json');
    const dmap = new Map();
    for (const l of (inv.serie || [])) {
      if (l.ufv !== UFV) continue;
      dmap.set(l.dia + '|' + l.ts + '|' + l.inv, l);
    }
    let n = 0;
    let piorP = 0;
    let piorT = 0;
    let semPar = 0;
    let ondeP = '';
    let ondeT = '';
    for (const l of s) {
      const d = dmap.get(l.d + '|' + l.ts + '|' + l.inv);
      if (!d) { semPar += 1; continue; }
      const pc = l.pca.filter(num);
      const tc = l.t.filter(num);
      if (pc.length && num(d.p_ca_max)) {
        const e = Math.abs(Math.max(...pc) - d.p_ca_max);
        if (e > piorP) { piorP = e; ondeP = l.d + ' ' + l.ts + '/' + l.inv; }
        n += 1;
      }
      if (tc.length && num(d.temp_max)) {
        const e = Math.abs(Math.max(...tc) - d.temp_max);
        if (e > piorT) { piorT = e; ondeT = l.d + ' ' + l.ts + '/' + l.inv; }
      }
    }
    console.log('      ' + n + ' pares conferidos · ' + semPar + ' inversor-dias sem par no diario');
    /* 0,011 e o arredondamento das duas rotas (duas casas), nao tolerancia escolhida */
    ok(piorP <= 0.011, 'pico da curva contra p_ca_max: pior desvio ' + piorP.toFixed(3) + ' kW'
      + (piorP > 0 ? ' (' + ondeP + ')' : ''));
    ok(piorT <= 0.011, 'maximo da curva contra temp_max: pior desvio ' + piorT.toFixed(3) + ' C'
      + (piorT > 0 ? ' (' + ondeT + ')' : ''));
    ok(n > 100, 'o fechamento cobre mais de cem pares (senao nao julga nada)');
  }

  console.log('');
  console.log('D · NEGATIVA · sem o piso, a razao apareceria onde ela e ruido');
  {
    /* As correntes individuais NAO vao no blob, e nem devem: seriam ~40 mil series. Entao o que se
       prova aqui e a consequencia do piso no proprio produto — onde a razao existe, a potencia do
       inversor nunca e irrisoria. Sem piso ela existiria nos pontos de potencia quase nula. */
    const pts = [];
    for (const l of s) {
      for (let i = 0; i < l.h.length; i += 1) {
        if (num(l.pca[i])) pts.push({ p: l.pca[i], r: num(l.sm[i]) });
      }
    }
    const comR = pts.filter((x) => x.r).map((x) => x.p).sort((a, b) => a - b);
    const semR = pts.filter((x) => !x.r).map((x) => x.p).sort((a, b) => a - b);
    if (!comR.length || !semR.length) {
      falha('faltam pontos dos dois lados para comparar');
    } else {
      console.log('      potencia onde a razao EXISTE: p05 ' + q(comR, 0.05).toFixed(1)
        + ' kW · mediana ' + q(comR, 0.5).toFixed(1) + ' kW');
      console.log('      potencia onde ela NAO existe: mediana ' + q(semR, 0.5).toFixed(1) + ' kW');
      ok(q(comR, 0.5) > q(semR, 0.5) * 2, 'a razao vive na parte ALTA do dia, como o piso manda');
      ok(q(comR, 0.05) > 5, 'mesmo o p05 dos pontos com razao passa de 5 kW');
    }
  }

  console.log('');
  console.log('E · o peso cabe no que a pagina pode pagar');
  {
    const kb = Math.round(h.__bytes / 1024);
    /* o teto declarado: este arquivo tem de ser MENOR que o `perdas_inv` que a pagina ja baixa,
       senao o custo de abrir a pagina mais que dobra */
    ok(kb < 900, 'o arquivo da usina tem ' + kb + ' KB na rede (teto declarado: 900)');
  }

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio da curva de 30 min: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
