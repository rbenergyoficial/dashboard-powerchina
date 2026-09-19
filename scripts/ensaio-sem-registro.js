/*
 * ensaio-sem-registro.js — o carimbo que o export escreve SEM registro nao entra como medicao.
 *
 * O DEFEITO. Quando o servidor do supervisorio fica sem registro, o export nao deixa vazio: escreve
 * ZERO em tudo e interpola rampas nos vizinhos. Medido em 19/09/2026 nos 57 dias da fonte: zero
 * carimbos vazios com a usina gerando, e 28/07 09:30-10:00 publicado como o complexo inteiro a 0 MW.
 *
 * A REGRA (gen-perdas.js, `carimbosSemRegistro`) e o CONTADOR DE VIDA descendo em metade ou mais do
 * eletrocentro no mesmo carimbo. Contador acumulado nao desce; numa parada REAL ele segura o valor.
 *
 * O que este ensaio exige:
 *   A · a regra, COMPILADA DO GERADOR, contra casos forjados que separam artefato de parada:
 *       queda do servidor (zero) e meia-queda (70%) sao pegas; a parada real (potencia e tensao a
 *       zero, contador seguro) NAO; a troca de UM inversor NAO; a volta NAO; e so o eletrocentro
 *       atingido sai.
 *   B · o PRODUTO: os carimbos-artefato conhecidos nao estao publicados como medicao no perdas_30min
 *       (quando o dia ainda esta na janela do arquivo e ja foi recalculado com a regra).
 *
 * uso: node ensaio-sem-registro.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

function regraDoGerador() {
  const src = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8');
  const i = src.indexOf('function carimbosSemRegistro(');
  if (i < 0) throw new Error('o gerador nao tem mais carimbosSemRegistro');
  const fim = src.indexOf('\n}\n', i);
  // eslint-disable-next-line no-new-func
  return new Function(src.slice(i, fim + 3) + '; return carimbosSemRegistro;')();
}

/* um dia forjado: TS1 com 10 inversores, TS2 com 10, 20 carimbos, contador subindo 100 por carimbo */
function dia(mexe) {
  const n = 20;
  const inv = new Map();
  for (const ts of ['TS1', 'TS2']) {
    for (let k = 0; k < 10; k += 1) {
      const e = [], p = [], v = [];
      for (let i = 0; i < n; i += 1) { e.push(500000 + k * 1000 + i * 100); p.push(200); v.push(800); }
      inv.set(ts + k, { ts, inv: 'INV' + k, serie: { e_vida: e, p_ca: p, vab: v } });
    }
  }
  const d = { linhas: new Array(n).fill(0), inv };
  mexe(d);
  return d;
}
const doTs = (d, ts) => [...d.inv.values()].filter((o) => o.ts === ts);

(async () => {
  const regra = regraDoGerador();
  console.log('A · a regra do gerador contra casos forjados');
  {
    const d = dia((x) => { for (const o of x.inv.values()) { o.serie.e_vida[8] = 0; o.serie.e_vida[9] = 0; o.serie.p_ca[8] = 0; o.serie.p_ca[9] = 0; } });
    const f = regra(d);
    ok(f.has(8) && f.has(9) && f.get(8).size === 20, 'queda do SERVIDOR (tudo a zero, 2 carimbos): os dois carimbos, os 20 inversores');
    ok(!f.has(10), 'a volta (carimbo seguinte, contador de novo no lugar) NAO e artefato');
  }
  {
    const d = dia((x) => { for (const o of x.inv.values()) o.serie.e_vida[7] *= 0.7; });
    ok(regra(d).has(7), 'meia-queda (contador a 70%, o valor interpolado): pega');
  }
  {
    const d = dia((x) => { for (const o of x.inv.values()) { o.serie.p_ca[12] = 0; o.serie.vab[12] = 0; o.serie.e_vida[12] = o.serie.e_vida[11]; } });
    ok(regra(d).size === 0, 'PARADA REAL (potencia e tensao a zero, contador seguro): NAO e artefato');
  }
  {
    const d = dia((x) => { const o = doTs(x, 'TS1')[3]; for (let i = 14; i < 20; i += 1) o.serie.e_vida[i] = 50 + (i - 14) * 100; });
    ok(regra(d).size === 0, 'TROCA de um inversor (contador novo partindo de ~0): NAO e artefato');
  }
  {
    const d = dia((x) => { for (const o of doTs(x, 'TS2')) o.serie.e_vida[5] = 0; });
    const f = regra(d);
    ok(f.has(5) && f.get(5).size === 10 && [...f.get(5)].every((o) => o.ts === 'TS2'), 'queda de UM eletrocentro: sai so ele');
  }

  console.log('\nC · o acumulador do gerador: o dia recalculado e inteiro da rodada');
  {
    const src = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8');
    const i = src.indexOf('function acumula(');
    // eslint-disable-next-line no-new-func
    const acumula = new Function(src.slice(i, src.indexOf('\n}\n', i) + 3) + '; return acumula;')();
    const dd = (l) => l.dia;
    /* linhas que juntam as usinas (uma por carimbo): o carimbo que a rodada NAO produziu sai */
    const a = [{ dia: 'D', ms: 1, v: 'zero velho' }, { dia: 'D', ms: 2, v: 'velho' }, { dia: 'C', ms: 0, v: 'outro dia' }];
    const r = acumula(a, [{ dia: 'D', ms: 2, v: 'novo' }], (l) => l.ms, 99, dd).serie;
    ok(!r.some((l) => l.ms === 1), 'o carimbo que a rodada nao produziu no dia recalculado SAI');
    ok(r.find((l) => l.ms === 2).v === 'novo' && r.some((l) => l.dia === 'C'), 'a colisao ganha a nova e o dia nao recalculado FICA');
    /* linhas por inversor: a rodada que leu so o M1 nao apaga o M2 do mesmo dia */
    const b = [{ dia: 'D', ufv: 'M1', k: 'x' }, { dia: 'D', ufv: 'M2', k: 'y' }];
    const r2 = acumula(b, [{ dia: 'D', ufv: 'M1', k: 'x2' }], (l) => l.ufv + l.k, 99, dd).serie;
    ok(r2.some((l) => l.ufv === 'M2') && !r2.some((l) => l.k === 'x'), 'por inversor: o M2 nao lido fica, a linha velha do M1 sai');
  }

  console.log('\nB · o produto publicado');
  const le = (nome) => new Promise((res, rej) => {
    https.get('https://rbenergydata.blob.core.windows.net/dados/' + nome, { family: 4 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); rej(new Error(nome + ': HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (x) => c.push(x));
      r.on('end', () => { try { let b = Buffer.concat(c); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); res(JSON.parse(b.toString('utf8'))); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
  const p = await le('perdas_30min.json');
  const idx = new Map(p.serie.map((l) => [l.t, l]));
  const primeiro = p.serie.length ? p.serie[0].t.slice(0, 10) : '9999';
  /* os artefatos MEDIDOS em 19/09/2026 na fonte */
  const CONHECIDOS = [['2026-07-28 09:30', ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']],
    ['2026-07-28 10:00', ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']],
    ['2026-08-05 13:30', ['M2']], ['2026-08-12 11:00', ['M4']]];
  let julgados = 0;
  for (const [t, us] of CONHECIDOS) {
    if (t.slice(0, 10) < primeiro) { console.log('      ' + t + ' fora da janela do arquivo — nao julgado'); continue; }
    const l = idx.get(t);
    const pub = us.filter((u) => l && l[u + '_p_ca'] != null);
    julgados += 1;
    ok(!pub.length, t + ': nenhuma usina publicada como medicao' + (pub.length ? ' (publicado: ' + pub.map((u) => u + ' ' + l[u + '_p_ca'] + ' MW').join(', ') + ')' : ''));
  }
  if (!julgados) console.log('      nenhum carimbo conhecido na janela — a parte B nao julgou nada');

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio do carimbo sem registro: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
