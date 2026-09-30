'use strict';
/*
 * ensaio-strings.js — as strings reais, a mais fraca e a lista de alarmes (PROMOVER strings-lote1, lib-strings.js).
 *
 * A · a REGRA, contra casos forjados com os numeros medidos no parque:
 *     - o MPPT vazio com corrente residual (MPPT 12 do M2/TS2/INV10, 0,27 A em 05/09/2026) NAO e o "mais fraco";
 *     - a string morta com zero exato APARECE: 0 %, e o numero dela;
 *     - entrada residual que nunca passa de 40 % das irmas nao vira string; a intermitente real (M1/TS4/INV08) continua;
 *     - o historico e um CONJUNTO: fundir duas vezes os mesmos dias da o mesmo estado;
 *     - a lista: nuvem de UM dia sobre string sadia nao entra; string a ~43 % por 30 dias entra como fraca, inclusive
 *       quando a hora do pico a leva de 16 a 110 %; morta no ultimo dia entra como morta, com o inicio do trecho.
 * B · o PRODUTO (`strings_alarme.json`, `pvstr_entradas.json`, `perdas_inv.json`, `pvstr_hora_<u>`, `pvstr_str_<u>_<ts>`):
 *     - toda string da lista e real no historico, e a classe e coerente com o limiar;
 *     - nenhum inversor-dia aponta como "mais fraca" uma entrada que nao e real (a prova do fim do falso alarme);
 *     - DUAS ROTAS: a menor razao do arquivo por eletrocentro, em cada meia hora, e a `sm` da curva do inversor, e o
 *       numero dela e a `sw` — o arquivo que o filtro por string le e a curva que ja estava no ar concordam;
 *     - por usina, strings com corrente contra a placa dentro de 1 %.
 * Roda DEPOIS de gerar. `LOCAL_DIR` julga a saida de uma rodada local antes de publicar.
 */
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const STR = require('./lib-strings.js');

let mau = 0;
const ok = (c, m) => { if (c) console.log('  ok  ' + m); else { mau += 1; console.log('  🔴 ' + m); } };
const PISO = 3;

function baixa(url) {
  return new Promise((res, rej) => https.get(url, { family: 4 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return rej(new Error(url + ' HTTP ' + r.statusCode)); }
    const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => {
      let buf = Buffer.concat(b); if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      res(JSON.parse(buf.toString('utf8')));
    });
  }).on('error', rej));
}
async function le(nome) {
  if (process.env.LOCAL_DIR) {
    let buf = fs.readFileSync(path.join(process.env.LOCAL_DIR, nome));
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return JSON.parse(buf.toString('utf8'));
  }
  return baixa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
}

/* historico forjado: `dias` dias em que as correntes `c` foram observadas no pico */
const hist = (c, dias, g) => STR.fundeEntradas([], dias.map((dia) => ({ ufv: 'MX', ts: 'TS1', inv: 'INV01', g: g || 's', dia, c })), PISO);
const reais = (estado, g) => (STR.indiceReais(estado).get('MX|TS1|INV01|' + (g || 's')) || {}).reais || new Set();
const tres = ['2026-09-01', '2026-09-02', '2026-09-03'];

(async () => {
  console.log('A · a regra');
  {
    // M2/TS2/INV10 em 05/09: MPPT 1..11 a ~15 A e o MPPT 12, sem string, a 0,27 A
    const m = {}; for (let n = 1; n <= 11; n++) m[n] = 14.75 + n * 0.05; m[12] = 0.27;
    const R = reais(hist(m, tres, 'm'), 'm');
    const d = STR.dispersao(m, R, 0.2, PISO);
    ok(!R.has(12) && R.size === 11, 'MPPT vazio com 0,27 A nao e entrada real (11 reais)');
    ok(d && d.min_n !== 12 && d.min_pct > 90, 'o MPPT mais fraco deixa de ser o vazio: ' + (d && d.min_n) + ' a ' + (d && d.min_pct) + ' %');
    // a regra ANTIGA (so descartava o zero exato) apontava o vazio: o caso existe
    const antiga = Object.entries(m).filter(([, x]) => x > 0).sort((a, b) => a[1] - b[1])[0];
    ok(antiga[0] === '12', 'controle: descartando so o zero exato, o "mais fraco" seria o MPPT 12 vazio');
  }
  {
    const s = {}; for (let n = 1; n <= 22; n++) s[n] = 7.5; s[23] = 0; s[24] = 0;
    const R = reais(hist(s, tres));
    const hoje = { ...s, 9: 0 };
    const d = STR.dispersao(hoje, R, 0.2, PISO);
    ok(R.size === 22 && !R.has(23), 'entradas 23 e 24 sem corrente nao sao strings (22 reais)');
    ok(d && d.min_pct === 0 && d.min_n === 9 && d.mortas === 1, 'string 9 morta com zero exato aparece: ' + (d && (d.min_n + ' a ' + d.min_pct + ' %, mortas ' + d.mortas)));
  }
  {
    const s = {}; for (let n = 1; n <= 22; n++) s[n] = 8; s[24] = 1.4;   // residual 17,5 %, como a entrada 24
    const R = reais(hist(s, ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']));
    ok(!R.has(24), 'residual a 17,5 % em cinco dias nao vira string');
    const um = STR.fundeEntradas([], [{ ufv: 'MX', ts: 'TS1', inv: 'INV01', g: 's', dia: '2026-09-01', c: { ...s, 24: 8 } }], PISO);
    ok(!reais(um).has(24), 'um dia so acima de 40 % nao faz string (pede ' + STR.DIAS_REAL + ')');
  }
  {
    const s = {}; for (let n = 1; n <= 22; n++) s[n] = 8;
    const e1 = hist(s, tres);
    const obs = tres.map((dia) => ({ ufv: 'MX', ts: 'TS1', inv: 'INV01', g: 's', dia, c: s }));
    const e2 = STR.fundeEntradas(e1, obs, PISO);
    ok(JSON.stringify(e1) === JSON.stringify(e2), 'fundir de novo os mesmos dias nao muda o historico (conjunto, nao soma)');
    const e3 = STR.fundeEntradas(e2, [{ ufv: 'MX', ts: 'TS1', inv: 'INV01', g: 's', dia: '2026-09-20', c: { ...s, 9: 0 } }], PISO);
    ok(reais(e3).has(9), 'a string que zera depois de ser string continua string no historico');
  }
  {
    const dias = (rs) => rs.map((r, i) => ({ dia: '2026-09-' + String(i + 1).padStart(2, '0'), x: 14 * r, md: 14 }));
    const sadia = Array(29).fill(1.0).concat([0.36]);
    ok(STR.alarme(dias(sadia), PISO) === null, 'nuvem de UM dia sobre string sadia (36 % em 29/09) nao entra');
    // M8/TS1/INV07 s13: 43, 18, 67, 54, 57, 110, 43, 16, 40, 43, 36, 98, 65, 39, 11 ... (a hora do pico decide)
    const fraca = [0.43, 0.18, 0.67, 0.54, 0.57, 1.10, 0.43, 0.16, 0.40, 0.43, 0.36, 0.98, 0.65, 0.39, 0.11,
      0.43, 0.41, 0.45, 0.44, 0.42, 0.40, 0.46, 0.43, 0.38, 0.44, 0.45, 0.43, 0.41, 0.44, 0.105];
    const a = STR.alarme(dias(fraca), PISO);
    ok(a && a.classe === 'fraca' && a.pct < STR.FRACA * 100, 'string a ~43 % com dias de 110 % e 11 %: fraca, ' + (a && a.pct) + ' % na mediana');
    const morta = Array(20).fill(1.0).concat([0, 0, 0]);
    const mo = STR.alarme(dias(morta), PISO);
    ok(mo && mo.classe === 'morta' && mo.desde === '2026-09-21' && mo.dias_fora === 3, 'morta nos 3 ultimos dias: desde 21/09 (' + (mo && mo.desde) + ')');
    const semSol = dias(Array(10).fill(1.0)).map((d, i) => (i === 9 ? { ...d, md: 2 } : d));
    ok(STR.alarme(semSol, PISO) === null, 'dia sem sol (mediana abaixo do piso) nao julga');
  }

  console.log('B · o produto' + (process.env.LOCAL_DIR ? ' (saida local)' : ''));
  const al = await le('strings_alarme.json');
  const en = await le('pvstr_entradas.json');
  const I = STR.indiceReais(en.serie);
  ok(Array.isArray(al.serie) && Array.isArray(al.resumo) && al.criterio, 'strings_alarme tem serie, resumo e criterio');
  let foraReal = 0, classeErrada = 0;
  for (const x of al.serie) {
    const r = I.get(x.ufv + '|' + x.ts + '|' + x.inv + '|s');
    if (!r || !r.reais.has(Number(x.str))) foraReal++;
    if (!((x.classe === 'fraca' && x.pct < STR.FRACA * 100) || (x.classe === 'morta' && x.a <= STR.MORTA_A))) classeErrada++;
  }
  ok(!foraReal, al.serie.length + ' strings em alarme, todas reais no historico (' + foraReal + ' fora)');
  ok(!classeErrada, 'classe coerente com o limiar em todas (' + classeErrada + ' incoerentes)');
  for (const r of al.resumo) ok(Math.abs(r.placa - r.strings_com_corrente) <= 0.01 * r.placa, r.ufv + ': ' + r.strings_com_corrente + ' strings com corrente contra ' + r.placa + ' de placa');

  const pi = await le('perdas_inv.json');
  let aponta = 0, comN = 0, pontoFraco = 0;
  for (const l of pi.serie) {
    for (const [c, g] of [['str_min_n', 's'], ['mppt_min_n', 'm']]) {
      if (l[c] == null) continue;
      comN++;
      const r = I.get(l.ufv + '|' + l.ts + '|' + l.inv + '|' + g);
      if (!r || !r.reais.has(Number(l[c]))) { aponta++; if (!pontoFraco) pontoFraco = l.dia + ' ' + l.ufv + '/' + l.ts + '/' + l.inv + ' ' + c + '=' + l[c]; }
    }
  }
  ok(comN > 0, comN + ' inversor-dias com a entrada mais fraca nomeada');
  ok(!aponta, 'nenhum aponta entrada que nao e real (' + aponta + (pontoFraco ? ', ex. ' + pontoFraco : '') + ')');

  // DUAS ROTAS: o arquivo por eletrocentro contra a curva do inversor
  let comp = 0, div = 0, divN = 0, ex = '';
  for (const [u, ts] of [['M2', 'TS2'], ['M8', 'TS1'], ['M6', 'TS3']]) {
    const f = await le('pvstr_str_' + u + '_' + ts + '.json');
    const h = await le('pvstr_hora_' + u + '.json');
    const H = new Map(h.serie.map((l) => [l.d + '|' + l.ts + '|' + l.inv, l]));
    for (const r of f.serie) {
      const c = H.get(r.d + '|' + r.ts + '|' + r.inv); if (!c) continue;
      for (let i = 0; i < r.h.length; i++) {
        const k = c.h.indexOf(r.h[i]); if (k < 0 || c.sm[k] == null) continue;
        let mn = null, mnN = null;
        for (const n of r.reais) { const v = r.s[n][i]; if (v != null && (mn == null || v < mn || (v === mn && Number(n) < mnN))) { mn = v; mnN = Number(n); } }
        if (mn == null) continue;
        comp++;
        if (Math.abs(mn - c.sm[k]) > 0.06) { div++; if (!ex) ex = r.d + ' ' + u + '/' + r.ts + '/' + r.inv + ' ' + r.h[i] + ' ' + mn + ' x ' + c.sm[k]; }
        if (c.sw[k] != null && Math.abs(r.s[c.sw[k]][i] - mn) > 0.06) divN++;
      }
    }
  }
  ok(comp > 500, comp + ' meias horas comparadas entre o arquivo por eletrocentro e a curva');
  ok(!div, 'a menor razao do arquivo e a sm da curva (' + div + ' divergem' + (ex ? ', ex. ' + ex : '') + ')');
  ok(!divN, 'e o numero sw da curva aponta a string de menor razao (' + divN + ' divergem)');

  if (mau) { console.log('✗ ' + mau + ' falha(s)'); process.exit(1); }
  console.log('✓ strings: a entrada vazia nao e a mais fraca, a morta aparece, e as duas rotas concordam');
})().catch((e) => { console.error('✗ ' + (e.stack || e)); process.exit(1); });
