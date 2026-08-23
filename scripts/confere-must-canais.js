/*
 * confere-must-canais.js — o blob do ensaio traz os dois sentidos, e eles fecham?
 *
 * SOMENTE LEITURA sobre o que o LOCAL_OUT produziu. Nada de Azure, nada de producao.
 *
 * A auditoria contra a fonte (audita-must-grandezas.js) ja disse QUAL canal e qual. Este confere
 * o passo seguinte, que e onde o erro caberia agora: se o GERADOR colocou cada canal na coluna
 * certa, se o Complexo respeita tudo-ou-nada em CADA um deles, e se a identidade fecha linha a
 * linha em vez de so na media.
 *
 * 🔴 A media esconde troca de sinal e troca de coluna. Um gerador que invertesse `_g` e `_c`
 * passaria por qualquer teste de media diaria feito sobre o modulo. Aqui a checagem e por LINHA
 * e por JANELA (dia contra madrugada), que e onde a assinatura solar aparece.
 *
 * Env: LOCAL_OUT (diretorio do ensaio), TOL_MW (tolerancia da identidade, default 0,05).
 */
const fs = require('fs');

const PARQUES = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const TODOS = PARQUES.concat(['Complexo']);
const TOL = parseFloat(process.env.TOL_MW || '0.05');

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
  for (const p of TODOS) for (const suf of ['', '_g', '_c']) if (!chaves.has(p + suf)) faltando.push(p + suf);
  if (faltando.length) falha('colunas ausentes: ' + faltando.join(', '));
  else console.log('  ✓ as 30 colunas presentes (9 parques + Complexo × liquida/geracao/consumo)');

  // ---- 2 · a assinatura solar poe cada canal no seu lugar --------------------------------------
  const jan = (h0, h1, campo) => {
    const v = serie.filter(l => { const h = +l.t.slice(11, 13); return h >= h0 && h < h1 && l[campo] != null; })
      .map(l => l[campo]);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const gDia = jan(10, 15, 'Complexo_g'), gNoite = jan(1, 4, 'Complexo_g');
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
  const erros = [];
  const porHora = {};
  let pior = { e: -1 };
  for (const p of TODOS) {
    for (const l of serie) {
      if (l[p] == null || l[p + '_g'] == null || l[p + '_c'] == null) continue;
      const e = Math.abs(l[p] - (l[p + '_g'] - l[p + '_c']));
      erros.push(e);
      if (e > TOL) { const h = l.t.slice(11, 13); porHora[h] = (porHora[h] || 0) + 1; }
      if (e > pior.e) pior = { e, p, t: l.t.slice(0, 16), liq: l[p], g: l[p + '_g'], c: l[p + '_c'] };
    }
  }
  erros.sort((x, y) => x - y);
  const q = (f) => erros.length ? erros[Math.min(erros.length - 1, Math.floor(erros.length * f))] : 0;
  const acima = erros.filter(e => e > TOL).length;
  console.log('  identidade  liquida = geracao - consumo   ·   ' + erros.length + ' comparacoes');
  console.log('    mediana ' + q(0.5).toFixed(4) + '   p95 ' + q(0.95).toFixed(4)
    + '   p99 ' + q(0.99).toFixed(4) + '   maximo ' + q(1).toFixed(4) + ' MW');
  console.log('    acima de ' + TOL + ' MW: ' + acima + ' (' + (acima / erros.length * 100).toFixed(2) + '%)');
  if (acima) {
    const hs = Object.entries(porHora).sort((x, y) => y[1] - x[1]).slice(0, 6);
    console.log('    horas com mais desvio: ' + hs.map(([h, n]) => h + 'h(' + n + ')').join(' · '));
    console.log('    PIOR CASO ' + pior.p + ' em ' + pior.t + ':  liquida ' + pior.liq
      + '   geracao ' + pior.g + '   consumo ' + pior.c
      + '   ->  g-c = ' + (pior.g - pior.c).toFixed(3) + '   erro ' + pior.e.toFixed(3));
  }
  if (acima) falha('a identidade nao fecha dentro de ' + TOL + ' MW em ' + acima + ' comparacoes');
  else console.log('  ✓ identidade fecha em todas as linhas dos dez');

  // ---- 4 · tudo-ou-nada do Complexo, em CADA canal ---------------------------------------------
  for (const suf of ['', '_g', '_c']) {
    let erro = 0;
    for (const l of serie) {
      const n = PARQUES.filter(p => l[p + suf] != null).length;
      const temCx = l['Complexo' + suf] != null;
      if ((n === 9) !== temCx) erro++;
    }
    if (erro) falha('Complexo' + (suf || ' (liquida)') + ': ' + erro
      + ' linhas em que a guarda de tudo-ou-nada nao foi respeitada');
  }
  if (!falhas) console.log('  ✓ tudo-ou-nada respeitado nos tres canais');
}

console.log('');
if (falhas) { console.log('CONFERENCIA REPROVADA · ' + falhas + ' problema(s)'); process.exit(1); }
console.log('CONFERENCIA APROVADA · os dois sentidos estao nas colunas certas e fecham com a liquida');
