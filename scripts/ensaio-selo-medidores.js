/*
 * ensaio-selo-medidores.js — o selo de medidores pinta por GRUPO, e isso precisa ser testavel.
 *
 * SOMENTE LEITURA, sem rede. Reproduz a regra de cor do gen-way2-recent.js contra estados
 * sinteticos e confere o resultado.
 *
 * 🔴 POR QUE EXISTE: a regra so roda quando ha medidor em falha, e falha e raro. Em 23/08/2026 a
 * versao antiga pintou `22/24` de AMBAR enquanto os dois ausentes eram o TR1 e o TR2 de 230 kV —
 * o ponto de conexao — e o humano leu "quase tudo bem" numa parada de quase 3 horas. A correcao
 * so pode ser conferida na proxima queda, o que e tarde: quando a nova regra rodou pela primeira
 * vez, a telemetria ja tinha voltado e o caminho novo nao foi exercitado.
 *
 * ⚠️ A regra e DUPLICADA aqui de proposito, e isso e uma divida assumida: o gerador nao exporta a
 * funcao. Se a regra mudar la e nao aqui, este ensaio passa a mentir. A guarda contra isso e o
 * proprio teste do formato do selo — ele compara o resultado com o que o gerador produz de
 * verdade quando ha dado real (`--real`).
 */
const OK_MIN = 25;
const FALHA_MIN = 40;

// ---- a regra, igual a do gen-way2-recent.js ----------------------------------------------------
function selo(medidores, total) {
  const falhas = medidores.filter(m => m.estado === 'falha');
  const f230 = falhas.filter(m => m.grupo === '230 kV').length;
  const f345 = falhas.length - f230;
  const cor = f230 > 0 ? '#E5484D'
    : f345 === 0 ? '#2FBF71'
      : (f345 <= 2 ? '#FF8A3D' : '#E5484D');
  const suf = f230 > 0 ? (f230 === 1 ? '230 kV parcial' : '230 kV fora') : '';
  return { v: (total - falhas.length) + '/' + total, u: suf, c: cor };
}

const NOME = { '#2FBF71': 'VERDE', '#FF8A3D': 'AMBAR', '#E5484D': 'VERMELHO' };

function frota({ fora230 = 0, fora345 = 0 }) {
  const m = [];
  for (let i = 0; i < 2; i++)
    m.push({ nome: 'SE · TR' + (i + 1), grupo: '230 kV', estado: i < fora230 ? 'falha' : 'ok' });
  for (let i = 0; i < 22; i++)
    m.push({ nome: 'C' + i, grupo: '34,5 kV', estado: i < fora345 ? 'falha' : 'ok' });
  return m;
}

const CASOS = [
  ['tudo no ar', { }, 'VERDE', ''],
  ['1 coletor fora', { fora345: 1 }, 'AMBAR', ''],
  ['2 coletores fora', { fora345: 2 }, 'AMBAR', ''],
  ['3 coletores fora', { fora345: 3 }, 'VERMELHO', ''],
  // 🔴 O CASO DE 23/08: dois fora, e a regra antiga pintava ambar por serem "so dois"
  ['os 2 de 230 kV fora (23/08)', { fora230: 2 }, 'VERMELHO', '230 kV fora'],
  ['1 de 230 kV fora', { fora230: 1 }, 'VERMELHO', '230 kV parcial'],
  ['230 kV fora + 5 coletores', { fora230: 2, fora345: 5 }, 'VERMELHO', '230 kV fora'],
];

let falhou = 0;
console.log('  caso                            selo        cor         esperado');
for (const [nome, cfg, corEsperada, sufEsperado] of CASOS) {
  const m = frota(cfg);
  const s = selo(m, m.length);
  const ok = NOME[s.c] === corEsperada && s.u === sufEsperado;
  if (!ok) falhou++;
  console.log('  ' + nome.padEnd(31) + (s.v + ' ' + s.u).padEnd(12)
    + NOME[s.c].padEnd(12) + corEsperada + (sufEsperado ? ' + "' + sufEsperado + '"' : '')
    + (ok ? '' : '   🔴 DIVERGE'));
}

// ---- a comparacao que impede a regra duplicada de divergir em silencio -------------------------
if (process.argv.includes('--real')) {
  const https = require('https'), zlib = require('zlib');
  https.get('https://rbenergydata.blob.core.windows.net/dados/way2_saude.json',
    { headers: { 'accept-encoding': 'gzip' } }, r => {
      const st = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; st.on('data', b => c.push(b));
      st.on('end', () => {
        const j = JSON.parse(Buffer.concat(c).toString('utf8'));
        const meu = selo(j.medidores, j.resumo.total);
        const dele = (j.badges || []).find(b => /medidor/i.test(b.l)) || {};
        const igual = meu.v === dele.v && meu.u === (dele.u || '') && meu.c === dele.c;
        console.log('');
        console.log('  contra o blob REAL (' + j.atualizado + '):');
        console.log('    gerador: "' + dele.v + '" "' + (dele.u || '') + '" ' + dele.c);
        console.log('    ensaio:  "' + meu.v + '" "' + meu.u + '" ' + meu.c);
        console.log('    ' + (igual ? '✓ a regra duplicada ainda concorda com o gerador'
                                    : '🔴 DIVERGIU — a regra mudou no gerador e nao aqui'));
        process.exit(igual && !falhou ? 0 : 1);
      });
    });
} else {
  console.log('');
  console.log(falhou ? '  ENSAIO REPROVADO · ' + falhou + ' caso(s)' : '  ENSAIO APROVADO');
  console.log('  (use --real para comparar tambem com o blob que esta no ar)');
  process.exit(falhou ? 1 : 0);
}
