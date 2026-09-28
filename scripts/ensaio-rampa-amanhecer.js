/*
 * ensaio-rampa-amanhecer.js — a reta que o export desenha ao sair do repouso nao entra como medicao
 * (PROMOVER rampa-amanhecer).
 *
 * O DEFEITO. Sem amostra guardada de madrugada, o export liga o ultimo zero da noite a primeira leitura da manha por
 * uma RETA, e a reta cai nos carimbos de 30 min. M6/TS2/INV19 em 25/09/2026: 0,79 · 1,67 · 2,55 · 3,43 kW CA de 04:00
 * a 05:30 (passo de 0,88), a CC no mesmo passo, 6,7 °C de temperatura interna, e o contador de energia andando 0,09 kWh
 * contra 3,17 kWh da potencia — antes do sol nascer (~05:20). Nos exports de 23 a 26/09 a reta abria a curva de
 * centenas de inversores as 04:30 ou 05:00. O mesmo desenho aparece ao sair de uma AUSENCIA: M1/TS5/INV14 em 26/09,
 * depois da leitura congelada, desceu 17,49 · 9,68 · 1,86 kW com o contador DIARIO de operacao caindo de 650 a 54 min.
 *
 * A REGRA (gen-perdas.js, `rampasDoRepouso`): o instante anterior com CA e CC LIDOS em zero, ou anulado como leitura
 * congelada, e, dali, CA e CC com o MESMO passo (diferenca entre passos ate RAMPA_TOL = 4 x 0,005, o arredondamento de
 * duas casas do export somado nos tres pontos) em 2+ passos seguidos; os pontos da reta viram ausencia. A ausencia
 * simples NAO e repouso: um inversor que volta de um vao perto do meio-dia pode estar em reta de verdade.
 *
 * O que este ensaio exige:
 *   A · a regra, COMPILADA DO GERADOR, contra casos forjados com os numeros medidos: a reta do amanhecer sai inteira e
 *       a primeira leitura de verdade fica; a reta saindo de um patamar congelado sai; NAO sao pegos a reta no meio do
 *       dia (3 pontos colineares perto do meio-dia existem de verdade, e ali o contador concorda), a reta real saindo de
 *       um vao simples, o amanhecer de verdade (curva que acelera), a reta de um passo so (2 pontos nao provam reta) e
 *       a reta so na CA.
 *   B · o PRODUTO (`pvstr_hora_<usina>.json`): nenhuma curva abre — no inicio ou logo depois de um zero lido — com 3
 *       pontos em reta na CA e na CC; cada usina tem serie; e o plantio de uma reta dessas reprova.
 *
 * Roda DEPOIS de gerar. `LOCAL_DIR` aponta a saida local do gerador (os pvstr_hora_*.json) para ensaiar antes de publicar.
 * uso: node ensaio-rampa-amanhecer.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

const SRC = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8');
const RAMPA_TOL = (() => { const m = SRC.match(/const RAMPA_TOL = ([\d.]+);/); if (!m) throw new Error('o gerador nao tem RAMPA_TOL'); return +m[1]; })();
function regraDoGerador() {
  const i = SRC.indexOf('function rampasDoRepouso(');
  if (i < 0) throw new Error('o gerador nao tem mais rampasDoRepouso');
  const fim = SRC.indexOf('\n}\n', i);
  // eslint-disable-next-line no-new-func
  return new Function('const RAMPA_TOL = ' + RAMPA_TOL + ';\n' + SRC.slice(i, fim + 3) + '; return rampasDoRepouso;')();
}

/* um inversor forjado: `ca` e `cc` a partir do carimbo 0; `cong` sao os carimbos que a regra da leitura congelada anulou */
function anulados(regra, ca, cc, cong) {
  const o = { ts: 'TS2', inv: 'INV19', serie: { p_ca: ca.slice(), p_cc: cc.slice(), temp: ca.map(() => 30) } };
  const d = { linhas: new Array(ca.length).fill(0), inv: new Map([['x', o]]) };
  const congeladas = new Map((cong || []).map((i) => [i, new Set([o])]));
  return [...regra(d, congeladas).keys()].sort((a, b) => a - b).join(',');
}

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

/* B · no produto: a curva que abre (no inicio ou depois de um ZERO lido) com 3 pontos em reta na CA e na CC. Depois de um
   vao nao se julga: a regra deixa ali a reta que pode ser real, e o produto nao diz de onde veio o vao */
const reta = (a, b, c) => a != null && b != null && c != null && b !== a && Math.abs((c - b) - (b - a)) <= RAMPA_TOL + 1e-9;
function abreEmReta(serie) {
  const achados = [];
  for (const r of serie) {
    const P = r.pca || [], C = r.pcc || [];
    for (let i = 0; i + 2 < r.h.length; i += 1) {
      if (i > 0 && !(P[i - 1] === 0 && C[i - 1] === 0)) continue;   // so a ABERTURA: o comeco da curva ou a saida de um zero
      if (reta(P[i], P[i + 1], P[i + 2]) && reta(C[i], C[i + 1], C[i + 2])) achados.push(r.d + ' ' + r.ts + '/' + r.inv + ' ' + r.h[i]);
    }
  }
  return achados;
}

(async () => {
  const regra = regraDoGerador();
  console.log('A · a regra do gerador contra casos forjados (RAMPA_TOL = ' + RAMPA_TOL + ')');
  // M6/TS2/INV19, 25/09: 03:30 = indice 0 ... 06:00 = indice 5
  ok(anulados(regra, [0, 0.79, 1.67, 2.55, 3.43, 48.42, 144.83], [0, 1.02, 2.16, 3.29, 4.42, 50.6, 149.9]) === '1,2,3,4',
    'M6/TS2/INV19 em 25/09: a reta de 04:00 a 05:30 sai inteira e as 06:00 (48,42 kW) fica');
  ok(anulados(regra, [0, 0.02, 0.2, 0.38, 1.77, 15.02], [0, 0.04, 0.42, 0.81, 2.07, 15.8]) === '1,2,3',
    'M1/TS5/INV01 em 23/09: a reta de 04:00 a 05:00 sai e a leitura das 05:30 fica');
  ok(anulados(regra, [null, 17.49, 9.68, 1.86, 0.42, 0.98], [null, 18, 9.95, 1.91, 0.44, 1.02], [0]) === '1,2,3',
    'M1/TS5/INV14 em 26/09: a reta saindo do patamar congelado (17,49 · 9,68 · 1,86 kW) sai');
  ok(anulados(regra, [null, 179.38, 179.7, 180.01, 175.2], [null, 181.73, 182.23, 182.73, 177.9]) === '',
    'M1/TS1/INV16 em 21/09: leitura real em reta (179,38 · 179,70 · 180,01 kW) saindo de um vao simples: nada sai');
  ok(anulados(regra, [255.1, 262.62, 263.24, 263.86, 250.4], [260.2, 268.1, 268.73, 269.36, 255.8]) === '',
    'reta no meio do dia (262,62 · 263,24 · 263,86 kW, sem sair do repouso): nada sai');
  ok(anulados(regra, [0, 0.35, 2.11, 15.02, 101.87], [0, 0.4, 2.3, 15.8, 104.17]) === '',
    'amanhecer de verdade (a curva acelera): nada sai');
  ok(anulados(regra, [0, 0.36, 2.11, 20.4], [0, 0.4, 2.3, 21.1]) === '',
    'um passo so (dois pontos nao provam reta): nada sai');
  ok(anulados(regra, [0, 0.79, 1.67, 2.55, 48.42], [0, 1.02, 2.4, 3.1, 50.6]) === '',
    'reta so na CA, com a CC andando de outro jeito: nada sai');

  console.log('B · o produto: pvstr_hora das nove usinas' + (process.env.LOCAL_DIR ? ' (saida local)' : ''));
  let n = 0, primeiro = null;
  for (let u = 1; u <= 9; u += 1) {
    let j; try { j = await le('pvstr_hora_M' + u + '.json'); } catch (e) { falha('M' + u + ': ' + e.message); continue; }
    const s = j.serie || []; n += s.length; if (!primeiro && s.length) primeiro = s;
    const p = abreEmReta(s);
    ok(s.length > 0 && !p.length, 'M' + u + ': ' + s.length + ' inversor-dias, nenhuma curva abrindo em reta'
      + (p.length ? ' · ' + p.length + ' · ' + p.slice(0, 3).join(' · ') : ''));
  }
  ok(n > 0, n + ' inversor-dias julgados');
  if (primeiro) {
    const r = JSON.parse(JSON.stringify(primeiro.find((x) => x.h.length >= 6 && abreEmReta([x]).length === 0)));
    r.pca[0] = 0.79; r.pca[1] = 1.67; r.pca[2] = 2.55; r.pcc[0] = 1.02; r.pcc[1] = 2.16; r.pcc[2] = 3.29;
    ok(abreEmReta([r]).length === 1, 'plantio: a curva aberta com a reta do M6/TS2/INV19 no produto reprova');
  }
  if (mau) { console.log('✗ ' + mau + ' falha(s)'); process.exit(1); }
  console.log('✓ rampa do amanhecer: a regra separa a reta desenhada da medicao, e nenhuma curva abre em reta');
})().catch((e) => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
