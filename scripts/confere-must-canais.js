/*
 * confere-must-canais.js — o blob do ensaio traz os dois sentidos, e eles fecham?
 *
 * SOMENTE LEITURA sobre o que o LOCAL_OUT produziu. Nada de Azure, nada de producao.
 *
 * A auditoria contra a fonte (audita-must-grandezas.js) ja disse QUAL canal e qual. Este confere
 * o passo seguinte, que e onde o erro caberia agora: se o GERADOR colocou cada canal na coluna
 * certa e se o Complexo respeita tudo-ou-nada em CADA um deles.
 *
 * 🔴 A primeira versao cobrava a identidade `Demat = geracao - consumo` e REPROVOU — com os
 * desvios concentrados na madrugada e o pior caso em liquida 0 / geracao 0 / consumo 1,5. Nao era
 * ruido de transicao: era a suposicao. Medido em 2.430 pontos, `Demat` e a GERACAO com erro
 * 0,0000, e o medidor de MUST simplesmente nao neta. Por isso a coluna `_g` saiu do blob (era a
 * mesma coluna duas vezes) e virou guarda no gerador.
 *
 * 🔴 A media esconde troca de sinal e troca de coluna. Um gerador que invertesse `_g` e `_c`
 * passaria por qualquer teste de media diaria feito sobre o modulo. Aqui a checagem e por LINHA
 * e por JANELA (dia contra madrugada), que e onde a assinatura solar aparece.
 *
 * Env: LOCAL_OUT (diretorio do ensaio).
 */
const fs = require('fs');

const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const TODOS = PARQUES.concat(['Complexo']);

const dir = process.env.LOCAL_OUT || '/tmp/ensaio/';
const arquivos = ['must_5min.json', 'must_15min.json', 'must_30min.json', 'must_60min.json']
  .filter(n => fs.existsSync(dir + n));

if (!arquivos.length) { console.error('ERRO: nenhum blob em ' + dir); process.exit(1); }

let falhas = 0;
const falha = (m) => { falhas++; console.log('  🔴 ' + m); };

for (const nome of arquivos) {
  const j = JSON.parse(fs.readFileSync(dir + nome, 'utf8'));
  const serie = j.serie || [];
  console.log('\n══ ' + nome + '  (' + serie.length + ' linhas) ══');
  if (!serie.length) { falha('serie vazia'); continue; }

  // ---- 1 · as colunas existem ------------------------------------------------------------------
  const chaves = new Set();
  for (const l of serie) for (const k of Object.keys(l)) chaves.add(k);
  const faltando = [];
  for (const p of TODOS) for (const suf of ['', '_c']) if (!chaves.has(p + suf)) faltando.push(p + suf);
  if (faltando.length) falha('colunas ausentes: ' + faltando.join(', '));
  else console.log('  ✓ as 20 colunas presentes (9 parques + Complexo × geracao/consumo)');
  // `_g` era duplicata exata de `<parque>`; se voltar, alguem reintroduziu a coluna redundante
  const dup = TODOS.filter(p => chaves.has(p + '_g') || chaves.has(p + '_v'));
  if (dup.length) falha('colunas redundantes de volta no blob: ' + dup.map(p => p + '_g/_v').join(', '));

  // ---- 2 · a assinatura solar poe cada canal no seu lugar --------------------------------------
  const jan = (h0, h1, campo) => {
    const v = serie.filter(l => { const h = +l.t.slice(11, 13); return h >= h0 && h < h1 && l[campo] != null; })
      .map(l => l[campo]);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const gDia = jan(10, 15, 'Complexo'), gNoite = jan(1, 4, 'Complexo');
  const cDia = jan(10, 15, 'Complexo_c'), cNoite = jan(1, 4, 'Complexo_c');
  console.log('  geracao  dia ' + (gDia == null ? '—' : gDia.toFixed(2)) + ' MW   madrugada '
    + (gNoite == null ? '—' : gNoite.toFixed(3)) + ' MW');
  console.log('  consumo  dia ' + (cDia == null ? '—' : cDia.toFixed(2)) + ' MW   madrugada '
    + (cNoite == null ? '—' : cNoite.toFixed(3)) + ' MW');
  if (gDia == null || cDia == null) falha('sem dado nas janelas de comparacao');
  else {
    // a geracao tem de dominar o dia; o consumo tem de dominar a madrugada. Se estiver invertido,
    // as duas condicoes falham juntas — e e exatamente o erro que uma media global esconderia.
    if (!(gDia > cDia * 5)) falha('de DIA a geracao nao domina o consumo (' + gDia.toFixed(2)
      + ' contra ' + cDia.toFixed(2) + ') — canais possivelmente TROCADOS');
    if (!(cNoite > (gNoite || 0))) falha('de MADRUGADA o consumo nao supera a geracao ('
      + (cNoite == null ? '—' : cNoite.toFixed(3)) + ' contra '
      + (gNoite == null ? '—' : gNoite.toFixed(3)) + ') — canais possivelmente TROCADOS');
    if (gDia > cDia * 5 && cNoite > (gNoite || 0)) console.log('  ✓ assinatura solar confere: geracao de dia, consumo de madrugada');
  }

  // ---- 3 · a identidade fecha LINHA A LINHA ----------------------------------------------------
  // 🔴 Um numero solto ("pior erro X") nao diz se e defeito ou fisica. O que decide e a
  // DISTRIBUICAO e a HORA: erro concentrado no nascer e no por do sol e a janela em que o sinal
  // troca de sentido; erro espalhado pelo dia inteiro seria coluna trocada.
  // ---- 3 · os dois sentidos so se sobrepoem na TRANSICAO ---------------------------------------
  // Sem netting, a relacao que resta e fisica: uma usina nao injeta e consome ao mesmo tempo.
  //
  // 🔴 Mas o balde tem largura, e o nascer do sol cabe DENTRO dele. Medido no ensaio, a maior
  // sobreposicao cresce monotonicamente com a resolucao — 0,132 MW em 5 min · 0,360 em 15 min ·
  // 0,378 em 30 min · 0,667 em 1 h — e sempre as 05:45/06:00 ou as 17:45. Isso e o amanhecer e o
  // anoitecer partidos pelo balde, nao canal trocado.
  //
  // Um limiar absoluto reprovava so o de 1 hora, o que denunciava o CRITERIO e nao o dado. O que
  // separa fisica de defeito nao e a magnitude: e a HORA. Canal trocado produziria sobreposicao
  // ao meio-dia, quando nao ha transicao nenhuma.
  const transicao = (h) => (h >= 4 && h < 9) || (h >= 16 && h < 21);
  let foraDaTransicao = 0, piorSim = { m: -1 }, piorFora = { m: -1 };
  for (const p of TODOS) {
    for (const l of serie) {
      const g = l[p], c = l[p + '_c'];
      if (g == null || c == null) continue;
      const m = Math.min(g, c);            // o menor dos dois: se ele for grande, ha sobreposicao
      const h = +l.t.slice(11, 13);
      if (m > piorSim.m) piorSim = { m, p, t: l.t.slice(0, 16), g, c };
      if (m > 0.5 && !transicao(h)) {
        foraDaTransicao++;
        if (m > piorFora.m) piorFora = { m, p, t: l.t.slice(0, 16), g, c };
      }
    }
  }
  console.log('  sobreposicao  maior ' + piorSim.m.toFixed(3) + ' MW  (' + piorSim.p + ' em '
    + piorSim.t + ': geracao ' + piorSim.g + ' · consumo ' + piorSim.c + ')');
  if (foraDaTransicao) {
    console.log('    FORA da transicao: ' + foraDaTransicao + ' intervalos · pior '
      + piorFora.m.toFixed(3) + ' MW em ' + piorFora.t);
    falha(foraDaTransicao + ' intervalos com os dois sentidos grandes FORA do nascer/por do sol'
      + ' — ai nao ha transicao que explique, e o canal pode estar trocado');
  } else console.log('  ✓ sobreposicao so na transicao, como a fisica manda');

  // ---- 4 · tudo-ou-nada do Complexo, em CADA canal ---------------------------------------------
  for (const suf of ['', '_c']) {
    let erro = 0;
    for (const l of serie) {
      const n = PARQUES.filter(p => l[p + suf] != null).length;
      const temCx = l['Complexo' + suf] != null;
      if ((n === 9) !== temCx) erro++;
    }
    if (erro) falha('Complexo' + (suf || ' (liquida)') + ': ' + erro
      + ' linhas em que a guarda de tudo-ou-nada nao foi respeitada');
  }
  if (!falhas) console.log('  ✓ tudo-ou-nada respeitado nos dois canais');
}

console.log('');
if (falhas) { console.log('CONFERENCIA REPROVADA · ' + falhas + ' problema(s)'); process.exit(1); }
console.log('CONFERENCIA APROVADA · os dois sentidos estao nas colunas certas e fecham com a liquida');
