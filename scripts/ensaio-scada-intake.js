// Ensaio da intake do `scada-raw`. Ele existe para provar UMA coisa acima de todas: que a guarda
// reprova o nome LIMPO — o defeito que uma migracao ingenua produziria, e que nao daria erro
// nenhum (o arquivo entraria no container para ser ignorado em silencio pelo consumidor).
//
// ⚠️ Guarda que so e vista passando no caminho feliz nao esta testada. Aqui cada uma e exercitada
//    pelo lado que ela existe para reprovar.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const M = require('./gen-scada-intake.js');

let mau = 0;
const ok = (cond, msg) => { if (!cond) { mau += 1; console.log('  [X] ' + msg); } else console.log('  ok  ' + msg); };

console.log('1 · o contrato de nome, consumidor a consumidor');
const casos = [
  // [original, nomeLimpoDeveriaReprovar?, quem]
  ['M04.xlsx', true, 'gen-scada'],
  ['IRR_20260901_120000.csv', true, 'gen-irradiancia'],
  ['IIRR_20260901_120000.csv', false, 'gen-irradiancia'],
  ['IRR_GERAL_20260901_120000.csv', false, 'gen-irradiancia'],
  ['Trafo_20260901_120000.csv', false, 'gen-trafo'],
  ['M04_20260901_120000.csv', false, 'gen-perdas'],
];
for (const [orig, reprovaLimpo, quem] of casos) {
  const c = M.consumidorDe(orig);
  ok(c && c.quem === quem, orig.padEnd(30) + ' -> reconhecido por ' + (c ? c.quem : 'NINGUEM'));
  // 🔴 o teste que importa: o nome LIMPO (sem prefixo) casa o consumidor?
  const limpo = M.casaConsumidor(orig, orig);
  ok(limpo.ok !== reprovaLimpo, '   nome limpo ' + (reprovaLimpo ? 'REPROVA' : 'passa')
    + ' — ' + (limpo.ok ? 'casou' : limpo.motivo));
  // e o nome com prefixo sempre tem de casar
  const comPref = M.casaConsumidor(M.nomeFinal(orig, '2026-09-01T12:00:00Z'), orig);
  ok(comPref.ok, '   com prefixo casa ' + (comPref.quem || comPref.motivo));
}

console.log('\n2 · o carimbo e monotonico e maior que o id do SharePoint');
const c1 = M.carimboDe('2026-09-01T12:00:00Z'), c2 = M.carimboDe('2026-09-01T12:00:01Z');
ok(Number(c2) > Number(c1), 'um segundo depois da carimbo maior (' + c1 + ' < ' + c2 + ')');
ok(Number(c1) > 99999, 'maior que o maior id de 5 digitos do legado (' + c1 + ' > 99999)');
ok(/^\d{14}$/.test(c1), 'so digitos, 14 posicoes');

console.log('\n3 · ponta a ponta numa pasta, com um arquivo de cada familia');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'intake-'));
const src = path.join(tmp, 'src'), dst = path.join(tmp, 'dst');
fs.mkdirSync(src); fs.mkdirSync(dst);
['M04.xlsx', 'IRR_20260901_120000.csv', 'IIRR_20260901_120000.csv',
  'IRR_GERAL_20260901_120000.csv', 'Trafo_20260901_120000.csv', 'M04_20260901_120000.csv']
  .forEach((f) => fs.writeFileSync(path.join(src, f), 'x'));
// legado com id de 5 digitos, como o Power Automate grava
fs.writeFileSync(path.join(dst, '68656_M04.xlsx'), 'velho');

const roda = (env) => execFileSync(process.execPath, [path.join(__dirname, 'gen-scada-intake.js')],
  { env: { ...process.env, FONTE: 'pasta', PASTA: src, LOCAL_OUT: dst, ...env }, encoding: 'utf8' });

const saida = roda({});
const gravados = fs.readdirSync(dst).filter((f) => f !== '68656_M04.xlsx');
ok(gravados.length === 6, 'gravou os 6 arquivos (' + gravados.length + ')');
ok(gravados.every((f) => /^\d{14}_/.test(f)), 'todos com o prefixo de 14 digitos');
ok(gravados.every((f) => M.casaConsumidor(f, f.replace(/^\d{14}_/, '')).ok),
  'todos casam o consumidor que os le');
// 🔴 o legado nao pode ser tocado, e o novo tem de ordenar DEPOIS dele
const ids = fs.readdirSync(dst).filter((f) => /\.xlsx$/.test(f))
  .map((f) => Number(f.match(/^(\d+)_/)[1])).sort((a, b) => a - b);
ok(ids.length === 2 && ids[0] === 68656 && ids[1] > 68656,
  'o novo .xlsx ordena DEPOIS do legado (' + ids.join(' < ') + ')');
ok(fs.readFileSync(path.join(dst, '68656_M04.xlsx'), 'utf8') === 'velho', 'o legado ficou intacto');

console.log('\n4 · idempotencia: rodar de novo nao duplica');
const antes = fs.readdirSync(dst).length;
roda({});
ok(fs.readdirSync(dst).length === antes, 'segunda passada nao gravou nada (' + antes + ' arquivos)');

console.log('\n5 · o que a guarda RECUSA');
const lixo = path.join(tmp, 'lixo'); fs.mkdirSync(lixo);
fs.writeFileSync(path.join(lixo, 'relatorio_qualquer.csv'), 'x');
let recusou = false;
try { execFileSync(process.execPath, [path.join(__dirname, 'gen-scada-intake.js')],
  { env: { ...process.env, FONTE: 'pasta', PASTA: lixo, LOCAL_OUT: dst }, encoding: 'utf8', stdio: 'pipe' }); }
catch (e) { recusou = true; }
ok(recusou, 'arquivo que nenhum consumidor le e RECUSADO, e o script sai com erro');

console.log('\n6 · o caminho do SharePoint, codificado');
// 🔴 E a UNICA parte do ramo Graph que se prova sem credencial — e e a que erraria calada. A pasta
//    real tem ACENTO e IDEOGRAMA; montar a URL do Graph por concatenacao crua devolve 400, e a
//    mensagem do Graph parece dizer que a pasta nao existe. Diagnostico errado, horas perdidas.
{
  // ⚠️ O caminho aqui e SINTETICO, e de proposito: ele so precisa ter as mesmas armadilhas do
  //    real (acento, ideograma, espaco e `&`). O caminho de verdade e dado interno e vem de
  //    `SP_PASTA` — repositorio publico nao guarda estrutura de pasta do cliente.
  const pasta = '/Documentos Compartilhados/1.OPERAÇÃO E MANUTENÇÃO - O&M - 運作與維護'
    + '/01 - OPERAÇÃO - 运行记录/99 - Pasta_De_Ensaio';
  const rel = M.caminhoGraph(pasta);
  ok(typeof M.caminhoGraph === 'function', 'o coletor exporta caminhoGraph');

  ok(!/[À-ÿ]/.test(rel), 'nenhum acento cru sobrou na URL');
  ok(!/[　-鿿]/.test(rel), 'nenhum ideograma cru sobrou na URL');
  ok(!/ /.test(rel), 'nenhum espaco cru sobrou na URL');
  ok(rel.split('/').map(decodeURIComponent).join('/') === pasta.split('/').filter(Boolean).join('/'),
    'decodificar devolve exatamente a pasta original');
  ok(!rel.startsWith('/') && !rel.endsWith('/'), 'sem barra sobrando nas pontas');
  ok(rel.split('/').length === 4, 'quatro segmentos, como no fluxo (' + rel.split('/').length + ')');
  // ⚠️ `encodeURIComponent` NAO escapa `&`, e o nome da pasta tem "O&M". Em query string isso
  //    partiria o parametro; aqui esta no CAMINHO, onde `&` e legal — por isso passa.
  ok(/O&M|O%26M/.test(rel), 'o "O&M" do nome sobreviveu');
}

console.log('\n7 · o CONTAINER desempata: `.xlsx` existe nos dois');
// 🔴 Sem o container no contrato, um `.xlsx` de inversores casaria a regra do `gen-scada`. Ele
//    passaria — o prefixo satisfaz as duas — mas ficaria atribuido ao consumidor errado, e guarda
//    que aponta o consumidor errado ensina a desconfiar da guarda no dia em que ela acusar de
//    verdade.
{
  const px = '20260902120000_';
  const xlsx = px + 'Inverter Failure Control.xlsx';
  const xlsm = px + 'Registro de Falhas.xlsm';
  const csv = px + 'Trafo_20260901_040039.csv';

  ok(M.casaConsumidor(xlsx, 'Inverter Failure Control.xlsx', 'scada-raw').quem === 'gen-scada',
    'em scada-raw, .xlsx e do gen-scada');
  ok(M.casaConsumidor(xlsx, 'Inverter Failure Control.xlsx', 'inversores-raw').quem === 'gen-inversores',
    'em inversores-raw, o MESMO nome e do gen-inversores');

  // o .xlsm (a planilha de falhas virou macro em 20/08/2026) so existe do lado dos inversores
  ok(!M.casaConsumidor(xlsm, 'Registro de Falhas.xlsm', 'scada-raw').ok,
    '.xlsm e RECUSADO em scada-raw — nenhum consumidor de la o le');
  ok(M.casaConsumidor(xlsm, 'Registro de Falhas.xlsm', 'inversores-raw').ok,
    '.xlsm e aceito em inversores-raw');

  ok(!M.casaConsumidor(csv, 'Trafo_20260901_040039.csv', 'inversores-raw').ok,
    'um csv de trafo e RECUSADO em inversores-raw');
  ok(M.casaConsumidor(csv, 'Trafo_20260901_040039.csv', 'scada-raw').quem === 'gen-trafo',
    'e continua sendo do gen-trafo em scada-raw');

  // ⚠️ sem `onde`, o comportamento antigo continua valendo — quem chamava com dois argumentos
  //    nao quebra
  ok(M.casaConsumidor(csv, 'Trafo_20260901_040039.csv').quem === 'gen-trafo',
    'sem container, o casamento por nome continua funcionando');

  // 🔴 O nome ORIGINAL vai inteiro no fim: o consumidor dos inversores descarta por SUBSTRING
  //    ("em revisao", "rascunho", "copia"). Um coletor que renomeasse faria um rascunho passar
  //    por versao boa, e o painel mostraria dado provisorio sem nada ficar vermelho.
  const rasc = M.nomeFinal('Failure Control (em revisao).xlsx', '2026-09-02T12:00:00Z');
  ok(/em revisao/i.test(rasc), 'a marca de rascunho sobrevive ao prefixo: ' + rasc);
}

console.log('\n8 · as extensoes saem do CONTRATO, nao de uma lista escrita ao lado');
{
  const s = M.extensoesDe('scada-raw'), i = M.extensoesDe('inversores-raw');
  // 🔴 `.xlsm` e o caso que uma lista a mao engoliria: a planilha de falhas dos inversores virou
  //    macro em 20/08/2026. O filtro antigo (`/\.(csv|xlsx)$/`) a descartaria antes de qualquer
  //    guarda — sem erro, sem log, so o painel parando de receber versao nova.
  ok(i.test('Registro de Falhas.xlsm'), 'inversores-raw aceita .xlsm');
  ok(!s.test('Registro de Falhas.xlsm'), 'scada-raw NAO aceita .xlsm');
  ok(s.test('Trafo_20260901_040039.csv') && !i.test('Trafo_20260901_040039.csv'),
    '.csv so vale em scada-raw');
  ok(!s.test('relatorio.docx') && !i.test('relatorio.docx'), 'nenhum dos dois aceita .docx');
  ok(!s.test('fooxlsx'), 'o ponto e obrigatorio — "fooxlsx" nao casa');
  let sem = false;
  try { M.extensoesDe('container-que-nao-existe'); } catch (e) { sem = true; }
  ok(sem, 'container sem consumidor declarado ESTOURA, em vez de aceitar tudo');
}

console.log('\n9 · ordem de gravacao: cronologia da FONTE, nao da listagem');
// 🔴 Sem ordenar, quem decide o que entra e a ordem em que a fonte respondeu:
//    · a guarda 3 recusa o que nao for maior que o maior ja presente — um arquivo antigo que
//      chegue DEPOIS de um recente e recusado;
//    · e o `gen-inversores` escolhe a planilha vigente pelo `lastModified` do BLOB, entao subir
//      fora de ordem faria a versao velha virar a mais recente do container.
{
  const src2 = path.join(tmp, 'inv'), dst2 = path.join(tmp, 'invout');
  fs.mkdirSync(src2); fs.mkdirSync(dst2);
  // ⚠️ os nomes sao escolhidos para que a ordem ALFABETICA (a que `readdirSync` devolve) seja o
  //    INVERSO da cronologica — senao o ensaio passaria mesmo sem a ordenacao.
  const arqs = [
    ['A Failure Control.xlsx', '2026-09-03T10:00:00Z'],   // o mais NOVO vem primeiro em A-Z
    ['B Failure Control.xlsx', '2026-09-02T10:00:00Z'],
    ['C Registro de Falhas.xlsm', '2026-09-01T10:00:00Z'],
  ];
  for (const [n, dt] of arqs) {
    const p = path.join(src2, n);
    fs.writeFileSync(p, 'x');
    fs.utimesSync(p, new Date(dt), new Date(dt));
  }
  // 🔴 o que se mede e a ORDEM DE GRAVACAO, e ela so existe no log que o script imprime por
  //    arquivo. Olhar a pasta de destino nao serve: o nome final comeca pelo carimbo, entao a
  //    listagem sai cronologica mesmo que a gravacao tenha sido ao contrario — o teste passaria
  //    sem a correcao.
  const log = execFileSync(process.execPath, [path.join(__dirname, 'gen-scada-intake.js')],
    { env: { ...process.env, FONTE: 'pasta', PASTA: src2, LOCAL_OUT: dst2,
      RAW_CONTAINER: 'inversores-raw' }, encoding: 'utf8' });

  const gravou = [...log.matchAll(/<- (.+?)\s+\[/g)].map((m) => m[1]);
  const cron = arqs.slice().sort((a, b) => Date.parse(a[1]) - Date.parse(b[1])).map((a) => a[0]);
  const listagem = fs.readdirSync(src2);   // alfabetica, que e como o readdir/Graph respondem

  ok(JSON.stringify(listagem) !== JSON.stringify(cron),
    'a listagem NAO e a cronologia — o ensaio exercita o caso certo');
  ok(JSON.stringify(gravou) === JSON.stringify(cron),
    'gravou do mais VELHO para o mais novo: ' + gravou.join(' -> '));

  const subiu = fs.readdirSync(dst2).sort();
  ok(subiu.length === 3, 'os 3 subiram (' + subiu.length + ')');
  ok(subiu.some((f) => /\.xlsm$/i.test(f)), 'o .xlsm subiu — nao foi engolido pelo filtro');
  ok(subiu.every((f) => M.casaConsumidor(f, f.replace(/^\d{14}_/, ''), 'inversores-raw').quem
    === 'gen-inversores'), 'os 3 sao atribuidos ao gen-inversores, nunca ao gen-scada');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (mau ? '[X] ' + mau + ' problemas' : 'a intake respeita o contrato dos dois containers e dos cinco consumidores'));
process.exit(mau ? 1 : 0);
