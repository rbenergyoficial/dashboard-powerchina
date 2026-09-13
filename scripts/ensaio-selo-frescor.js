/*
 * ensaio-selo-frescor.js — prova que o selo CONSEGUE ficar vermelho sozinho.
 *
 * 🔴 O DEFEITO QUE ELE GUARDA. Em 13/09/2026 o cabeçalho dizia "Way2 9 min · 24/24" em VERDE
 *    sobre um dado de duas horas, porque o número é gravado pelo gerador e o gerador tinha
 *    parado. Um selo que só sabe a idade do instante em que foi escrito **nunca denuncia a
 *    própria parada** — e é justamente aí que ele teria de gritar.
 *
 * O que este ensaio exige, sobre os blobs PÚBLICOS (sem segredo nenhum):
 *
 *   A · TODO selo que mostra IDADE tem âncora. Selo com unidade de tempo e sem `ms` está
 *       congelado por construção, e é o defeito voltando pela porta dos fundos.
 *   B · a cor publicada e a que se recalcula NO INSTANTE DA GRAVACAO — as duas contas
 *       concordam sobre o mesmo relogio. ⚠️ Comparar com o relogio de AGORA reprovaria
 *       justamente quando a correcao esta funcionando: o dado envelheceu e a cor mudou.
 *   C · NEGATIVA, e é ela que prova a correção: adiantando o relógio para além do limiar de
 *       alerta, todo selo com âncora fica VERMELHO. Guarda que não reprova não é guarda.
 *   D · e no instante da âncora ele é VERDE — senão "fica vermelho" seria só "está sempre
 *       vermelho", que não serve para nada.
 *
 * uso: node ensaio-selo-frescor.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const SELO = require('./lib-selo.js');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const ARQS = ['fontes_saude.json', 'way2_saude.json'];

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };

const le = (nome) => new Promise((ok, erro) => {
  https.get(BASE + nome, { family: 4 }, (r) => {
    /* só o 404 é ausência; qualquer outra falha estoura, em vez de virar "nada a conferir" */
    if (r.statusCode !== 200) { r.resume(); erro(new Error(nome + ' HTTP ' + r.statusCode)); return; }
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => {
      try {
        let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        ok(JSON.parse(b.toString('utf8')));
      } catch (e) { erro(e); }
    });
  }).on('error', erro);
});

/* a mesma regra que o PAINEL vai aplicar, escrita aqui de forma independente: se as duas
   divergirem, o ensaio reprova em vez de a tela passar a mentir */
function corPorIdade(b, agora) {
  const min = (agora - b.ms) / 60000;
  const cs = String(b.cs || '').split(',');
  if (cs.length !== 3) return null;
  return min <= b.ok ? cs[0] : min <= b.alt ? cs[1] : cs[2];
}

/* um selo mostra IDADE quando a unidade dele é de tempo */
const UNI_TEMPO = /^(min|h|dias?|d)$/i;

(async () => {
  const listas = [];
  for (const a of ARQS) {
    const j = await le(a);
    /* 🔴 O INSTANTE DE REFERENCIA E O DA GRAVACAO, NAO O DE AGORA. A cor publicada foi calculada
       quando o blob foi escrito; comparar com a de agora reprova justamente quando a correcao
       esta FUNCIONANDO — o dado envelheceu desde entao e a cor mudou, que e o objetivo. A
       primeira versao fazia isso e acusou dois selos corretos vinte minutos depois de publicar.
       ⚠️ E a guarda tem de saber de onde vem esse instante: `gerado_em` e ISO com fuso; o
       `atualizado` do way2_saude e hora local SEM fuso, e le-lo como UTC deslocaria 3 h. */
    const quando = j.gerado_em ? Date.parse(j.gerado_em)
      : j.atualizado ? Date.parse(j.atualizado + '-03:00') : null;
    if (!quando || !isFinite(quando)) { falha(a + ': sem instante de gravacao legivel'); continue; }
    for (const [k, v] of Object.entries(j)) {
      if (/^badges/.test(k) && Array.isArray(v)) listas.push([a + ' · ' + k, v, quando]);
    }
  }
  if (!listas.length) { console.log('🔴 nenhuma lista de selos nos blobs'); process.exit(1); }

  let comAncora = 0, total = 0;
  const agora = Date.now();

  console.log('A · todo selo de IDADE tem âncora');
  for (const [onde, lista] of listas) {
    for (const b of lista) {
      total += 1;
      const mostraIdade = UNI_TEMPO.test(String(b.u || '')) || b.un;
      if (mostraIdade && !b.ms) falha(onde + ' · "' + b.l + '" mostra idade (' + b.v + ' ' + b.u + ') e NÃO tem âncora: congelado por construção');
      if (b.ms) comAncora += 1;
    }
  }
  if (!mau) console.log('  ' + comAncora + ' de ' + total + ' selos com âncora; nenhum selo de idade sem ela.');

  console.log('');
  console.log('B · a cor publicada é a que se recalcula NO INSTANTE DA GRAVAÇÃO');
  for (const [onde, lista, quando] of listas) {
    for (const b of lista) {
      if (!b.ms) continue;
      const c = corPorIdade(b, quando);
      if (!c) { falha(onde + ' · "' + b.l + '" sem as três cores em `cs`'); continue; }
      /* ⚠️ um minuto de folga: entre calcular a cor e gravar o arquivo passam segundos, e um selo
         em cima do limiar pode legitimamente cair do outro lado */
      if (c !== b.c && corPorIdade(b, quando - 60000) !== b.c) {
        falha(onde + ' · "' + b.l + '": publicada ' + b.c + ' e recalculada ' + c);
      }
    }
  }
  if (!mau) console.log('  as duas contas concordam nos ' + comAncora + ' selos com âncora.');

  /* ℹ️ e a idade AGORA vai impressa, porque e ela que o leitor ve — e quando ela passa da
     publicada, e o selo fazendo o que este lote existe para ele fazer */
  for (const [onde, lista] of listas) {
    for (const b of lista) {
      if (!b.ms || !b.un) continue;
      const div = b.un === 'min' ? 1 : b.un === 'h' ? 60 : 1440;
      console.log('  ' + onde + ' · "' + b.l + '": publicado ' + b.v + ' ' + b.u
        + ' · na tela agora ' + Math.round((agora - b.ms) / 60000 / div) + ' ' + b.u
        + ' · ' + corPorIdade(b, agora));
    }
  }

  console.log('');
  console.log('C · NEGATIVA · com o relógio além do alerta, TODOS ficam vermelhos');
  let verm = 0;
  for (const [onde, lista] of listas) {
    for (const b of lista) {
      if (!b.ms) continue;
      const depois = b.ms + (b.alt + 1) * 60000;
      const c = corPorIdade(b, depois);
      if (c !== SELO.VERMELHO) falha(onde + ' · "' + b.l + '" não fica vermelho nem com ' + (b.alt + 1) + ' min de idade: ' + c);
      else verm += 1;
    }
  }
  if (verm) console.log('  ' + verm + ' selos passam a vermelho quando o dado envelhece.');

  console.log('');
  console.log('D · e no instante da âncora ele é verde');
  for (const [onde, lista] of listas) {
    for (const b of lista) {
      if (!b.ms) continue;
      const c = corPorIdade(b, b.ms);
      if (c !== SELO.VERDE) falha(onde + ' · "' + b.l + '" não é verde no próprio instante do dado: ' + c);
    }
  }

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio do selo: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
