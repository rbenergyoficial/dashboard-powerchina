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
  const fonte = fs.readFileSync(path.join(__dirname, 'gen-scada-intake.js'), 'utf8');
  const m = /const SP_PASTA_PADRAO = ([\s\S]*?);\n/.exec(fonte);
  ok(!!m, 'SP_PASTA_PADRAO existe no fonte');
  const pasta = new Function('return ' + m[1] + ';')();
  const rel = pasta.split('/').filter(Boolean).map(encodeURIComponent).join('/');

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

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\n' + (mau ? '[X] ' + mau + ' problemas' : 'a intake respeita o contrato de nome dos quatro consumidores'));
process.exit(mau ? 1 : 0);
