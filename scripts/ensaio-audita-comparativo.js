/*
 * ensaio-audita-comparativo.js — prova que o auditor REPROVA.
 *
 * Auditor que nunca foi visto reprovando pode nunca ter funcionado. Foi assim com a guarda de nulo
 * do JSONata, que existia ha meses, nunca disparou porque nenhuma chave faltava, e no dia em que
 * uma faltou o painel inteiro abriu vazio.
 *
 * Aqui cada defeito conhecido vira um arquivo, e o ensaio exige que o auditor o pegue. O arquivo
 * SADIO e montado de dado real de producao (ONS e SCADA), entao "passar" tambem e medido.
 *
 * Uso: node scripts/ensaio-audita-comparativo.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const G = require('./gen-comparativo.js');

const DIA = '2026-07-10';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cmpaud-'));

let falhas = 0;
const ok = (m) => console.log('  [OK]    ' + m);
const nok = (m) => { falhas++; console.log('  [FALHA] ' + m); };

function roda(dir) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'audita-comparativo.js'), dir],
    { encoding: 'utf8' });
  return { codigo: r.status, saida: (r.stdout || '') + (r.stderr || '') };
}

function grava(dir, nome, obj) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, nome), JSON.stringify(obj));
}

function caso(rotulo, nome, obj, esperaFalha, trecho) {
  const dir = path.join(TMP, rotulo.replace(/[^a-z0-9]+/gi, '_'));
  grava(dir, nome, obj);
  const { codigo, saida } = roda(dir);
  const reprovou = codigo !== 0;
  if (reprovou !== esperaFalha) {
    nok(rotulo + ': esperava ' + (esperaFalha ? 'REPROVAR' : 'passar') + ', e '
      + (reprovou ? 'reprovou' : 'passou'));
    console.log(saida.split('\n').filter((l) => /FALHA/.test(l)).map((l) => '          ' + l).join('\n'));
    return;
  }
  if (esperaFalha && trecho && saida.indexOf(trecho) < 0) {
    nok(rotulo + ': reprovou, mas por outro motivo — nao achei "' + trecho + '"');
    console.log(saida.split('\n').filter((l) => /FALHA/.test(l)).map((l) => '          ' + l).join('\n'));
    return;
  }
  ok(rotulo + (esperaFalha ? '  reprovado, como devia' : '  aprovado'));
}

function molde(serie, resolucaoMin, presentes) {
  const NOME = { o: 'operador nacional', w: 'medidor', s: 'supervisorio' };
  return {
    gerado: new Date().toISOString(),
    resolucao_min: resolucaoMin,
    granularidade: resolucaoMin == null ? 'diario' : resolucaoMin + ' min',
    unidade: 'MWh por intervalo',
    fontes: presentes.map((c) => ({ chave: c, nome: NOME[c], grandeza: 'x' })),
    fontes_ausentes: [],
    colunas: 'o<N>, w<N>, s<N>',
    rotulo_de_tempo: 'inicio do intervalo',
    serie,
  };
}

(async () => {
  console.log('=== o auditor do comparativo reprova mesmo? ===\n');
  console.log('  montando o arquivo sadio de dado real de producao...');
  const scada = await G.leBlob('scada_comparativo.json');
  const ons30 = await G.lerONS(DIA);
  const sc30 = G.agrega(G.scadaParaMapa(scada, DIA, 'intra15', 15), 30);
  const soDia = (m) => new Map([...m].filter(([k]) => k.slice(0, 10) === DIA));
  const sadia = G.montaSerie({ ons: soDia(ons30), scada: soDia(sc30) }, false);
  console.log('  ' + sadia.length + ' linhas de ' + DIA + '\n');
  if (sadia.length !== 48) { nok('o arquivo sadio nao tem 48 baldes de 30 min'); }

  const copia = () => JSON.parse(JSON.stringify(sadia));

  caso('arquivo sadio de 30 min', 'cmp_30min.json',
    molde(sadia, 30, ['o', 's']), false);

  // --- rotulo no FIM do intervalo (o defeito que inverteu conclusao no MUST) -----------------
  const desloc = copia().map((l) => {
    const ms = l.ms + 30 * 60000;
    return { ...l, ms, t: new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19) + '-03:00' };
  });
  caso('rotulo no fim do intervalo', 'cmp_30min.json',
    molde(desloc, 30, ['o', 's']), true, 'pode estar no FIM do intervalo');

  // --- unidade trocada: o supervisorio publicado como potencia, nao energia ------------------
  const emEscalaErrada = copia().map((l) => {
    const n = { ...l };
    for (let i = 1; i <= 9; i++) if (typeof n['s' + i] === 'number') n['s' + i] = +(n['s' + i] * 1.12).toFixed(2);
    return n;
  });
  caso('supervisorio 12% acima', 'cmp_30min.json',
    molde(emEscalaErrada, 30, ['o', 's']), true, 'fechamento fora de 90-110%');

  // --- coluna do ONS num arquivo de 5 min ----------------------------------------------------
  const cinco = copia().slice(0, 12).map((l, i) => ({ ...l, ms: l.ms, t: l.t }));
  caso('coluna do ONS num arquivo de 5 min', 'cmp_5min.json',
    molde(cinco, 5, ['o', 's']), true, 'publica em 30 min');

  // --- granularidade trocada: 30 min declarado, 15 min de conteudo ---------------------------
  const quinze = [];
  for (let i = 0; i < 96; i++) {
    const ms = Date.parse(DIA + 'T00:00:00-03:00') + i * 15 * 60000;
    quinze.push({ t: new Date(ms - 3 * 3600 * 1000).toISOString().slice(0, 19) + '-03:00', ms, s1: 1, o1: 1 });
  }
  caso('conteudo de 15 min num arquivo de 30', 'cmp_30min.json',
    molde(quinze, 30, ['o', 's']), true, 'fora do passo de 30 min');

  // --- valor acima do teto fisico -------------------------------------------------------------
  const gigante = copia();
  gigante[20] = { ...gigante[20] };
  for (let i = 1; i <= 9; i++) gigante[20]['s' + i] = 500;
  caso('acima do teto fisico do complexo', 'cmp_30min.json',
    molde(gigante, 30, ['o', 's']), true, 'teto fisico');

  // --- casas decimais -------------------------------------------------------------------------
  const casas = copia();
  casas[10] = { ...casas[10], s1: 12.3456 };
  caso('valor com quatro casas', 'cmp_30min.json',
    molde(casas, 30, ['o', 's']), true, 'mais de 2 casas decimais');

  // --- metadado ausente -----------------------------------------------------------------------
  const semUnidade = molde(sadia, 30, ['o', 's']);
  delete semUnidade.unidade;
  caso('sem o campo de unidade', 'cmp_30min.json', semUnidade, true, 'falta o campo');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log('\n=== ' + (falhas ? falhas + ' FALHA(S)' : 'TUDO PASSOU') + ' ===');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
