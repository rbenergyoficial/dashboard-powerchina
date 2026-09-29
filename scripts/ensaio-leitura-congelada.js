/*
 * ensaio-leitura-congelada.js — a leitura que o supervisorio REPETE nao entra como medicao (PROMOVER leitura-congelada).
 *
 * O DEFEITO. O supervisorio pode repetir o ultimo valor de um inversor em vez de deixar vazio. Medido em 27/09/2026:
 * M1/TS5/INV14 com 22,15 kW CA, 22,79 kW CC e 62,4 °C iguais de 25/09 16:30 a 26/09 14:00, madrugada inclusive — o
 * gerador contava 21 instantes "gerando", 0,33 MWh, e a curva de 30 min ia de 00:30 a 23:00, esticando a grade do mapa
 * das nove usinas de 27 para 46 colunas. E M8/TS1/INV02 repetindo 0,08/0,32 kW e 51,10 °C das 18:00 as 23:30 de 23/09.
 *
 * A REGRA (gen-perdas.js, `carimbosCongelados`): CA, CC e temperatura IGUAIS, com potencia acima de zero, em
 * CONGELA_MIN instantes seguidos ou mais; o primeiro fica (e a ultima leitura boa) so se houver leitura antes dele.
 *
 * O que este ensaio exige:
 *   A · a regra, COMPILADA DO GERADOR, contra casos forjados: o congelamento e pego (as repeticoes, nao a primeira
 *       leitura); o que vem congelado do dia anterior sai inteiro; NAO sao pegos o inversor segurado no limite (CA parada,
 *       CC e temperatura andando), a madrugada em zero com a temperatura parada, a parada de dia (temperatura andando) e
 *       o patamar curto (3 instantes).
 *   B · o PRODUTO (`pvstr_hora_<usina>.json`): nenhum inversor-dia tem CONGELA_MIN meias horas seguidas com CA, CC e
 *       temperatura iguais e potencia acima de zero — e o plantio de um patamar desses reprova.
 *
 * Roda DEPOIS de gerar. `LOCAL_DIR` aponta a saida local do gerador (os pvstr_hora_*.json) para ensaiar antes de publicar.
 * uso: node ensaio-leitura-congelada.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

const SRC = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8').replace(/\r\n/g, '\n');
const CONGELA_MIN = (() => { const m = SRC.match(/const CONGELA_MIN = (\d+);/); if (!m) throw new Error('o gerador nao tem CONGELA_MIN'); return +m[1]; })();
function regraDoGerador() {
  const i = SRC.indexOf('function carimbosCongelados(');
  if (i < 0) throw new Error('o gerador nao tem mais carimbosCongelados');
  const fim = SRC.indexOf('\n}\n', i);
  // eslint-disable-next-line no-new-func
  return new Function('const CONGELA_MIN = ' + CONGELA_MIN + ';\n' + SRC.slice(i, fim + 3) + '; return carimbosCongelados;')();
}

/* um inversor forjado de 48 carimbos; `muda(s)` altera as series */
function dia(muda) {
  const n = 48, s = { p_ca: [], p_cc: [], temp: [] };
  for (let i = 0; i < n; i += 1) {
    const sol = i >= 11 && i <= 35 ? Math.sin(Math.PI * (i - 11) / 24) : 0;
    s.p_ca.push(+(300 * sol).toFixed(2)); s.p_cc.push(+(306 * sol).toFixed(2)); s.temp.push(+(30 + 40 * sol + i * 0.01).toFixed(2));
  }
  muda(s, n);
  const o = { ts: 'TS1', inv: 'INV01', serie: s };
  return { linhas: new Array(n).fill(0), inv: new Map([['x', o]]) };
}
const anulados = (regra, d) => [...regra(d).keys()].sort((a, b) => a - b);

function baixa(url) {
  return new Promise((res, rej) => https.get(url, (r) => {
    if (r.statusCode !== 200) { r.resume(); return rej(new Error(url + ' HTTP ' + r.statusCode)); }
    const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => {
      let buf = Buffer.concat(b); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      res(JSON.parse(buf.toString('utf8')));
    });
  }).on('error', rej));
}
async function le(nome) {
  if (process.env.LOCAL_DIR) {
    let buf = fs.readFileSync(path.join(process.env.LOCAL_DIR, nome)); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return JSON.parse(buf.toString('utf8'));
  }
  return baixa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
}

/* B · no produto: patamares de CONGELA_MIN meias horas com CA, CC e temperatura iguais e potencia acima de zero */
function patamares(serie) {
  const achados = [];
  for (const r of serie) {
    const P = r.pca || [], C = r.pcc || [], T = r.t || [];
    let ini = 0;
    for (let i = 1; i <= r.h.length; i += 1) {
      const igual = i < r.h.length && P[i] > 0 && C[i] > 0 && P[i] != null && P[i] === P[i - 1] && C[i] === C[i - 1] && T[i] != null && T[i] === T[i - 1];
      if (igual) continue;
      if (i - ini >= CONGELA_MIN) achados.push(r.d + ' ' + r.ts + '/' + r.inv + ' ' + r.h[ini] + '..' + r.h[i - 1]);
      ini = i;
    }
  }
  return achados;
}

(async () => {
  const regra = regraDoGerador();
  console.log('A · a regra do gerador contra casos forjados (CONGELA_MIN = ' + CONGELA_MIN + ')');
  {
    const a = anulados(regra, dia((s) => { for (let i = 20; i < 30; i += 1) { s.p_ca[i] = s.p_ca[19]; s.p_cc[i] = s.p_cc[19]; s.temp[i] = s.temp[19]; } }));
    ok(a.length === 10 && a[0] === 20 && a[a.length - 1] === 29, 'congelamento de 19 a 29: saem as 10 repeticoes e fica a leitura de 19 (' + a.join(',') + ')');
  }
  {
    const a = anulados(regra, dia((s) => { s.p_ca[0] = s.p_cc[0] = s.temp[0] = null;
      for (let i = 1; i < 25; i += 1) { s.p_ca[i] = 22.15; s.p_cc[i] = 22.79; s.temp[i] = 62.4; } }));
    ok(a.length === 24 && a[0] === 1, 'congelado desde o dia anterior (00:00 vazio): sai inteiro, a partir do primeiro (' + a.slice(0, 3).join(',') + '…, ' + a.length + ')');
  }
  ok(!anulados(regra, dia((s) => { for (let i = 16; i < 30; i += 1) s.p_ca[i] = 352; })).length,
    'segurado no limite (CA parada em 352, CC e temperatura andando): nada sai');
  ok(!anulados(regra, dia((s) => { for (let i = 0; i < 11; i += 1) s.temp[i] = 49.8; })).length,
    'madrugada em zero com a temperatura parada: nada sai');
  ok(!anulados(regra, dia((s) => { for (let i = 18; i < 26; i += 1) { s.p_ca[i] = 0; s.p_cc[i] = 0; } })).length,
    'parada de dia (potencia zero, temperatura andando): nada sai');
  // o patamar CONTA a primeira leitura: CONGELA_MIN - 1 instantes iguais no total ainda e medicao
  ok(!anulados(regra, dia((s) => { for (let i = 20; i < 20 + CONGELA_MIN - 2; i += 1) { s.p_ca[i] = s.p_ca[19]; s.p_cc[i] = s.p_cc[19]; s.temp[i] = s.temp[19]; } })).length,
    'patamar curto (' + (CONGELA_MIN - 1) + ' instantes iguais no total): nada sai');

  console.log('B · o produto: pvstr_hora das nove usinas' + (process.env.LOCAL_DIR ? ' (saida local)' : ''));
  let n = 0, primeiro = null;
  for (let u = 1; u <= 9; u += 1) {
    let j; try { j = await le('pvstr_hora_M' + u + '.json'); } catch (e) { falha('M' + u + ': ' + e.message); continue; }
    const s = j.serie || []; n += s.length; if (!primeiro && s.length) primeiro = s;
    const p = patamares(s);
    ok(!p.length, 'M' + u + ': ' + s.length + ' inversor-dias, nenhum patamar congelado' + (p.length ? ' · ' + p.slice(0, 3).join(' · ') : ''));
  }
  ok(n > 0, n + ' inversor-dias julgados');
  if (primeiro) {
    const r = JSON.parse(JSON.stringify(primeiro.find((x) => x.h.length >= CONGELA_MIN + 4)));
    for (let i = 3; i < 3 + CONGELA_MIN; i += 1) { r.pca[i] = 22.15; r.pcc[i] = 22.79; r.t[i] = 62.4; }
    ok(patamares([r]).length === 1, 'plantio: um patamar de ' + CONGELA_MIN + ' meias horas iguais no produto reprova');
  }
  if (mau) { console.log('✗ ' + mau + ' falha(s)'); process.exit(1); }
  console.log('✓ leitura congelada: a regra separa congelamento de medicao, e o produto nao carrega patamar');
})().catch((e) => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
