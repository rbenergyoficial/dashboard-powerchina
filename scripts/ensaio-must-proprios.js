// Ensaio da fiação da cópia própria do must-intra (lote custo-must-proprios, 09/11/2026). Sem rede: lê o gerador e o workflow.
// 🔴 O que esta sendo provado: o gerador lembra a etag DO UPLOAD de cada saída; os três passos que leem as saídas (gerar, vigia,
// alerta) têm o padrão E o diretório (só um dos dois desliga a lib); o restore vem antes do gerar e o save por último, pela chave das
// marcas. O mecanismo da cópia (304 só com a etag dela) é o da lib-le-dados, provado no ensaio-saidas-proprias.
'use strict';
const fs = require('fs');
const path = require('path');
const G0 = fs.readFileSync(path.join(__dirname, 'gen-must-intra.js'), 'utf8');
const Y0 = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'must-intra.yml'), 'utf8').replace(/\r\n/g, '\n');
const PADRAO = "LE_DADOS_PROPRIOS: '^must_(5min|15min|30min|60min)\\.json$'";

function passos(y) { return y.split(/\n      - /).slice(1).map((c) => ({ nome: (/^name: (.*)/.exec(c) || [])[1] || '', corpo: c })); }
function confere(G, Y, dizer) {
  let mau = 0;
  const ok = (v, m) => { if (!v) { mau++; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  ok(/const up = await cont\.getBlockBlobClient\(nome\)\.upload\(gz/.test(G) && /LD\.lembra\(nome, up\.etag, gz, up\.lastModified\)/.test(G),
    'o gerador lembra cada saída com a etag do upload');
  const ps = passos(Y), i = (re) => ps.findIndex((p) => re.test(p.nome));
  const iR = i(/^Restaurar as saidas anteriores/), iG = i(/^Gerar as quatro/), iV = i(/^Medir o frescor/), iA = i(/^Alerta de ultrapassagem/), iS = i(/^Guardar as saidas desta rodada/);
  ok(iR >= 0 && iR < iG, 'o restore da cópia própria vem antes do gerar');
  ok(iS === ps.length - 1 && /key: must-proprios-\$\{\{ hashFiles\('\.cache-blob\/proprios\/\*\.meta'\) \}\}/.test((ps[iS] || {}).corpo || ''), 'o save é o último passo, pela chave das marcas');
  for (const [k, rot] of [[iG, 'gerar'], [iV, 'vigia'], [iA, 'alerta']]) {
    const c = (ps[k] || {}).corpo || '';
    ok(c.includes(PADRAO) && /CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-blob\n/.test(c), `o passo ${rot} tem o padrão e o diretório`);
  }
  return mau;
}

console.log('ensaio da cópia própria do must-intra');
const mau = confere(G0, Y0, true);
const PLANTIOS = {
  'gerador sem lembra': ['g', 'LD.lembra(nome, up.etag, gz, up.lastModified);', ''],
  'lembra sem a etag do upload': ['g', 'LD.lembra(nome, up.etag, gz, up.lastModified)', "LD.lembra(nome, '', gz, up.lastModified)"],
  'vigia sem o diretório': ['y', null, null],
  'save antes do gerar': ['y2', null, null]
};
let furou = 0;
for (const [nome, [onde, de, para]] of Object.entries(PLANTIOS)) {
  let G = G0, Y = Y0;
  if (onde === 'g') G = G0.replace(de, para);
  if (onde === 'y') { const k = Y0.indexOf('- name: Medir o frescor'); const j = Y0.indexOf('CACHE_BLOB_DIR', k); Y = Y0.slice(0, j) + 'XCACHE' + Y0.slice(j + 14); }
  if (onde === 'y2') Y = Y0.replace('- name: Guardar as saidas desta rodada', '- name: Guardar_movido');
  const n = confere(G, Y, false);
  console.log((n ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n ? 'reprova' : 'PASSOU — o ensaio não o vê'));
  if (!n) furou++;
}
console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) não pego(s)` : 'APROVADO');
process.exit(mau || furou ? 1 : 0);
