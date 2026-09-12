/*
 * ensaio-ppc-duracao.js — prova que a DURACAO sob restricao sai do degrau, e nao da contagem.
 *
 * 🔴 POR QUE ESTE ENSAIO EXISTE. `restritos` conta LINHAS; um dia com vinte lancamentos pode ser
 *    de duas horas ou de dez. A leitura ingenua — "do primeiro ao ultimo lancamento restrito" —
 *    e plausivel, da o mesmo numero na maioria dos dias, e ERRA exatamente no dia em que a
 *    restricao vem em dois blocos com uma liberacao no meio. Por isso o caso E existe: ele e a
 *    unica coisa aqui que separa o metodo certo do metodo que parece certo.
 *
 *   A · POSITIVA   o blob publicado: a lib contra uma recomputacao INDEPENDENTE, dia a dia
 *   B · degrau simples, com liberacao         -> a duracao e do restrito ao evento seguinte
 *   C · ultimo lancamento AINDA restrito      -> aberta = 1, e a duracao e um PISO
 *   D · dia inteiro em potencia plena         -> zero, e nao "o dia todo"
 *   E · dois blocos com liberacao no meio     -> a soma dos blocos, NAO a distancia entre pontas
 *   F · um lancamento so                      -> zero duracao; um instante nao tem duracao
 *
 * ⚠️ Nao grava nada e nao toca em blob: monta eventos em memoria e chama a mesma funcao que o
 *    gerador chama. Ensaio que exercitasse outra escrita da regra nao provaria nada sobre ela.
 *
 * uso: node ensaio-ppc-duracao.js
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const P = require('./lib-ppc.js');

const URL = 'https://rbenergydata.blob.core.windows.net/dados/ppc_restricao.json';

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (m) => console.log('  ' + m);

/* um evento de mentira, com o minimo que a funcao le */
const ev = (dia, hh, mm, pot) => ({ dia, min: hh * 60 + mm, ts: dia + ' ' + P.hhmm(hh * 60 + mm),
  pot, restr: pot < P.PLENA - P.FOLGA ? 1 : 0, linha: 0 });

function caso(nome, eventos, esperaMin, esperaAberta) {
  const r = P.duracaoRestricao(eventos).get(eventos[0].dia);
  const bate = r && r.minutos === esperaMin && r.aberta === esperaAberta;
  if (bate) ok(nome + ': ' + r.minutos + ' min · aberta=' + r.aberta);
  else falha(nome + ': esperava ' + esperaMin + ' min / aberta=' + esperaAberta
    + ' e veio ' + (r ? r.minutos + ' min / aberta=' + r.aberta : 'nada'));
}

const baixa = () => new Promise((resolve, reject) => {
  https.get(URL, (r) => {
    /* 🔴 So o 404 significa ausente. Qualquer outra falha de leitura estoura, em vez de virar
       "primeira execucao" — a licao que o leBlob do MUST e o leitor do ONS ja pagaram. */
    if (r.statusCode === 404) { r.resume(); reject(new Error('o registro ainda nao foi publicado')); return; }
    if (r.statusCode !== 200) { r.resume(); reject(new Error('HTTP ' + r.statusCode)); return; }
    const p = [];
    r.on('data', (c) => p.push(c));
    r.on('end', () => {
      try {
        let b = Buffer.concat(p);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        resolve(JSON.parse(b.toString('utf8')));
      } catch (e) { reject(e); }
    });
  }).on('error', reject);
});

(async () => {
  console.log('A · o blob publicado, contra uma recomputacao independente');
  const j = await baixa();
  const eventos = j.eventos || [];
  if (!eventos.length) { falha('o blob nao trouxe evento nenhum'); process.exit(1); }
  const lib = P.duracaoRestricao(eventos);

  /* a recomputacao NAO reusa a funcao julgada: outro laco, outra ordenacao */
  const porDia = new Map();
  for (const e of eventos) {
    const d = e.dia || String(e.ts).slice(0, 10);
    if (!porDia.has(d)) porDia.set(d, []);
    porDia.get(d).push(e);
  }
  let divergem = 0;
  let abertas = 0;
  for (const [dia, lista] of porDia) {
    const l = lista.slice().sort((a, b) => a.min - b.min);
    let m = 0;
    for (let i = 0; i < l.length - 1; i++) if (l[i].restr) m += l[i + 1].min - l[i].min;
    const g = lib.get(dia);
    if (!g || g.minutos !== m) { divergem += 1; falha(dia + ': lib ' + (g ? g.minutos : '-') + ' contra ' + m); }
    if (g && g.aberta) abertas += 1;
  }
  if (!divergem) ok(porDia.size + ' dias, zero divergencia contra a recomputacao');
  /* ⚠️ o piso tem de ser ALCANCAVEL pelo ensaio: se um dia nunca fechasse aberto, o caso C seria
     a unica prova, e ela e fabricada. Medido em 12/09/2026: 4 dias reais na janela. */
  ok('dias com restricao aberta no registro real: ' + abertas);

  console.log('');
  console.log('B..F · o degrau, em casos montados');
  const D = '2026-01-15';
  caso('B · restrito 08:00, livre 10:00, livre 12:00', [
    ev(D, 8, 0, 200), ev(D, 10, 0, P.PLENA), ev(D, 12, 0, P.PLENA)], 120, 0);

  caso('C · restrito 08:00 e 10:00, sem liberacao', [
    ev(D, 8, 0, 200), ev(D, 10, 0, 150)], 120, 1);

  caso('D · dia inteiro em potencia plena', [
    ev(D, 7, 0, P.PLENA), ev(D, 12, 0, P.PLENA), ev(D, 17, 0, P.PLENA)], 0, 0);

  /* 🔴 O CASO QUE DECIDE. Do primeiro ao ultimo lancamento restrito vao 4 h; sob restricao a
     usina esteve 2 h. A leitura ingenua dobraria o numero, e ela e a que se escreve sozinha. */
  caso('E · dois blocos, livre no meio (a distancia entre pontas daria 240)', [
    ev(D, 8, 0, 200), ev(D, 9, 0, P.PLENA), ev(D, 11, 0, 250), ev(D, 12, 0, P.PLENA)], 120, 0);

  caso('F · um lancamento so, restrito', [ev(D, 8, 0, 200)], 0, 1);

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio da duracao: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
