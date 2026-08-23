/*
 * audita-comparativo.js — le os cmp_*.json produzidos e julga se estao publicaveis.
 *
 * Roda depois do gerador no modo de ensaio (LOCAL_OUT), sobre ARQUIVO, nunca sobre o blob. E a
 * segunda metade do par: o gerador tem guardas de processo (nao encolher, nao regravar a toa,
 * granularidade), este aqui olha o PRODUTO.
 *
 * A diferenca importa. Uma guarda dentro do gerador so ve o que o gerador acabou de fazer; este
 * auditor ve o arquivo como o painel vai ver, incluindo o que veio do merge com o que ja estava
 * publicado. Foi um auditor assim que pegou, no MUST, que a correcao estava certa mas a guarda
 * julgava linhas que a rodada nao tinha reprocessado.
 *
 * Uso: node scripts/audita-comparativo.js <diretorio>
 */
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2] || 'ensaio';
const PARQUES = 9;
const AMOSTRAS_DIA = { 5: 288, 15: 96, 30: 48, 60: 24 };

let falhas = 0;
const ok = (m) => console.log('  [OK]    ' + m);
const nok = (m) => { falhas++; console.log('  [FALHA] ' + m); };
const avisa = (m) => console.log('  [nota]  ' + m);

function somaFonte(l, pref) {
  let s = 0; let n = 0;
  for (let i = 1; i <= PARQUES; i++) {
    const v = l[pref + i];
    if (typeof v === 'number') { s += v; n++; }
  }
  return { s, n };
}

function audita(arq) {
  const nome = path.basename(arq);
  console.log('\n--- ' + nome + ' ---');
  let j;
  try { j = JSON.parse(fs.readFileSync(arq, 'utf8')); }
  catch (e) { nok(nome + ': JSON invalido — ' + e.message); return; }

  const serie = j.serie || [];
  if (!serie.length) { nok(nome + ': serie vazia'); return; }
  const diario = j.resolucao_min == null;
  const passo = j.resolucao_min;
  console.log('  ' + serie.length + ' linhas · ' + j.granularidade + ' · '
    + serie[0].t.slice(0, 16) + ' -> ' + serie[serie.length - 1].t.slice(0, 16));

  // --- metadados que o painel vai citar na tela --------------------------------------------
  for (const campo of ['unidade', 'rotulo_de_tempo', 'colunas', 'fontes']) {
    if (!j[campo]) nok(nome + ': falta o campo `' + campo + '` — o painel cita esses textos');
  }
  const presentes = (j.fontes || []).map((f) => f.chave);
  avisa('fontes presentes: ' + presentes.join(', ')
    + (j.fontes_ausentes || []).map((f) => ' · ausente ' + f.chave + ' (' + f.motivo + ')').join(''));

  // --- 1. esquema: nenhuma coluna de fonte que o arquivo diz nao ter -------------------------
  // A falha que isto pega e a pior da familia: uma coluna vazia de ONS num blob de 5 min nao
  // quebraria nada — desenharia uma serie zerada, e o leitor concluiria que a fonte falhou.
  const vistas = new Set();
  serie.forEach((l) => Object.keys(l).forEach((k) => vistas.add(k)));
  const prefixos = new Set([...vistas].filter((k) => k !== 't' && k !== 'ms').map((k) => k[0]));
  const intrusas = [...prefixos].filter((p) => !presentes.includes(p));
  if (intrusas.length) nok('coluna de fonte que o arquivo declara nao ter: ' + intrusas.join(', '));
  else ok('esquema: so as fontes declaradas aparecem nas colunas');

  if (!diario && passo < 30 && prefixos.has('o')) {
    nok('ha coluna do operador nacional num arquivo de ' + passo
      + ' min — essa fonte publica em 30 min e nao pode ser repartida');
  }

  // --- 2. rotulo de tempo: o espacamento tem de ser o passo declarado -------------------------
  const passos = new Map();
  for (let i = 1; i < serie.length; i++) {
    const d = (serie[i].ms - serie[i - 1].ms) / 60000;
    passos.set(d, (passos.get(d) || 0) + 1);
  }
  const esperado = diario ? 1440 : passo;
  const fora = [...passos.entries()].filter(([d]) => d !== esperado && d > 0);
  const totalFora = fora.reduce((s, [, n]) => s + n, 0);
  if (!fora.length) {
    ok('espacamento: todos os intervalos com ' + esperado + ' min');
  } else if (totalFora / serie.length < 0.02) {
    // vao de coleta e legitimo — o que nao pode e o passo NORMAL ser outro
    const maior = [...passos.entries()].sort((a, b) => b[1] - a[1])[0];
    if (maior[0] !== esperado) {
      nok('o espacamento MAIS COMUM e ' + maior[0] + ' min, nao os ' + esperado
        + ' declarados — isso e granularidade trocada');
    } else {
      ok('espacamento: ' + esperado + ' min, com ' + totalFora + ' vao(s) de coleta ('
        + (totalFora / serie.length * 100).toFixed(1) + '%)');
    }
  } else {
    nok(totalFora + ' intervalos (' + (totalFora / serie.length * 100).toFixed(1)
      + '%) fora do passo de ' + esperado + ' min: ' + fora.slice(0, 4).map(([d, n]) => d + 'min x' + n).join(', '));
  }

  // --- 3. o primeiro instante do dia tem de ser 00:00 ----------------------------------------
  // Se o rotulo fosse o FIM do intervalo, o primeiro balde do dia seria 00:05 (ou 00:15) e o
  // ultimo carregaria a data do dia seguinte. E o defeito que no MUST inverteu conclusao.
  if (!diario) {
    const primeiros = {};
    for (const l of serie) {
      const d = l.t.slice(0, 10);
      if (!primeiros[d] || l.t < primeiros[d]) primeiros[d] = l.t;
    }
    // 🔴 A PRIMEIRA VERSAO DESTA REGRA ERA INERTE. Ela descartava o primeiro e o ultimo dia por
    // serem parciais e julgava o resto — o que, num arquivo de UM dia, nao julgava nada: imprimia
    // "poucos dias" e passava. O ensaio flagrou justamente assim, com a serie inteira deslocada
    // meia hora. Regra que se cala quando o dado e curto e regra que nao existe.
    //
    // Agora o julgamento recai sobre o dia mais COMPLETO da serie, que existe sempre, e as pontas
    // parciais deixam de ser desculpa.
    const contagem = {};
    serie.forEach((l) => { const d = l.t.slice(0, 10); contagem[d] = (contagem[d] || 0) + 1; });
    const maisCheio = Object.keys(contagem).sort((a, b) => contagem[b] - contagem[a]
      || (a < b ? -1 : 1))[0];
    const inicio = primeiros[maisCheio].slice(11, 16);
    const ruins = Object.keys(primeiros).filter((d) => primeiros[d].slice(11, 16) !== '00:00');
    if (inicio !== '00:00') {
      nok('o dia mais completo (' + maisCheio + ', ' + contagem[maisCheio] + ' baldes) comeca as '
        + inicio + ' e nao as 00:00 — o rotulo pode estar no FIM do intervalo, e nesse caso a '
        + 'serie inteira esta um intervalo adiantada em relacao as outras fontes');
    } else if (ruins.length > 1) {
      nok(ruins.length + ' dia(s) comecando fora de 00:00 (ex.: ' + ruins[0] + ' as '
        + primeiros[ruins[0]].slice(11, 16) + ')');
    } else {
      ok('rotulo de tempo: o dia mais completo (' + maisCheio + ') comeca em 00:00, como o '
        + 'inicio do intervalo exige');
    }

    // e nenhum dia fechado pode ter mais baldes do que a resolucao comporta
    const porDia = {};
    serie.forEach((l) => { const d = l.t.slice(0, 10); porDia[d] = (porDia[d] || 0) + 1; });
    const demais = Object.keys(porDia).filter((d) => porDia[d] > AMOSTRAS_DIA[passo]);
    if (demais.length) {
      nok(demais.length + ' dia(s) com mais de ' + AMOSTRAS_DIA[passo] + ' baldes (ex.: '
        + demais[0] + ' com ' + porDia[demais[0]] + ')');
    } else ok('contagem: nenhum dia passa de ' + AMOSTRAS_DIA[passo] + ' baldes');
  }

  // --- 4. casas decimais ---------------------------------------------------------------------
  let maisDeDuas = 0;
  for (const l of serie) {
    for (const k of Object.keys(l)) {
      if (k === 't' || k === 'ms') continue;
      const v = l[k];
      if (typeof v === 'number' && Math.abs(v * 100 - Math.round(v * 100)) > 1e-9) maisDeDuas++;
    }
  }
  if (maisDeDuas) nok(maisDeDuas + ' valor(es) com mais de 2 casas decimais');
  else ok('casas decimais: duas, em todos os valores');

  // --- 5. as fontes fecham entre si ----------------------------------------------------------
  // So compara instantes em que as duas fontes tem os NOVE parques. Comparar oito contra nove
  // produz divergencia de cobertura disfarcada de divergencia de medicao — que e exatamente o
  // erro que este arquivo existe para evitar.
  // Os TRES pares, nao so os que envolvem o medidor. Um arquivo em que o medidor falte — ou uma
  // resolucao em que ele nao esteja — deixaria a verificacao inteira sem rodar, e um auditor que
  // se cala conforme a fonte disponivel e um auditor que nao se pode confiar. O par entre o
  // operador nacional e o supervisorio tambem e comparacao legitima: sao dois caminhos
  // independentes de medicao.
  const pares = [['w', 'o'], ['w', 's'], ['o', 's']];
  const NOME = { o: 'operador nacional', w: 'medidor', s: 'supervisorio' };
  for (const [a, b] of pares) {
    if (!presentes.includes(a) || !presentes.includes(b)) continue;
    let sa = 0; let sb = 0; let n = 0;
    for (const l of serie) {
      const A = somaFonte(l, a); const B = somaFonte(l, b);
      if (A.n !== PARQUES || B.n !== PARQUES) continue;
      sa += A.s; sb += B.s; n++;
    }
    if (!n) { avisa(NOME[a] + ' x ' + NOME[b] + ': nenhum instante com as nove usinas nas duas'); continue; }
    const razao = sb / sa * 100;
    const txt = NOME[b] + ' / ' + NOME[a] + ' = ' + razao.toFixed(2) + '% em ' + n + ' instantes';
    if (razao > 90 && razao < 110) ok('fechamento: ' + txt);
    else nok('fechamento fora de 90-110%: ' + txt + ' — isso e conversao ou cobertura, nao medicao');
  }

  // --- 6. ordem de grandeza -------------------------------------------------------------------
  // O complexo tem 343,77 MW. Num intervalo de `passo` minutos o teto fisico e a potencia
  // instalada vezes a duracao. Valor acima disso e unidade trocada, nao usina excepcional.
  const teto = diario ? 343.77 * 24 : 343.77 * (passo / 60);
  let acima = 0; let maior = 0;
  for (const l of serie) {
    for (const p of presentes) {
      const { s } = somaFonte(l, p);
      if (s > maior) maior = s;
      if (s > teto * 1.02) acima++;
    }
  }
  if (acima) {
    nok(acima + ' instante(s) acima do teto fisico de ' + teto.toFixed(1)
      + ' MWh (maior: ' + maior.toFixed(1) + ') — cheira a unidade trocada');
  } else {
    ok('ordem de grandeza: maior soma ' + maior.toFixed(1) + ' MWh contra teto fisico de '
      + teto.toFixed(1) + ' (' + (maior / teto * 100).toFixed(0) + '%)');
  }
}

const arquivos = fs.existsSync(DIR)
  ? fs.readdirSync(DIR).filter((f) => /^cmp_.*\.json$/.test(f)).sort()
  : [];
if (!arquivos.length) {
  console.error('ERRO: nenhum cmp_*.json em "' + DIR + '".');
  process.exit(1);
}
console.log('=== auditoria de ' + arquivos.length + ' arquivo(s) em ' + DIR + ' ===');
arquivos.forEach((f) => audita(path.join(DIR, f)));
console.log('\n=== ' + (falhas ? falhas + ' FALHA(S)' : 'TUDO PASSOU') + ' ===');
process.exit(falhas ? 1 : 0);
