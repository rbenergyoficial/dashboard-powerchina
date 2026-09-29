/*
 * ensaio-carimbo-inversor.js — os geradores de inversor leem todo nome de export que o SCADA manda (PROMOVER att-02).
 *
 * POR QUE EXISTE. O nome do export de inversor ja mudou duas vezes sem aviso, e nas duas o dia sumiu do painel EM
 * SILENCIO, com o job verde:
 *   24/09/2026 · `M02_ATT_20260924_...` (o dia 23/09) — o padrao so aceitava `M<NN>_<data>`;
 *   29/09/2026 · `M05_ATT-02_20260929_...` (o dia 28/09 do M5, ja com o TS1 INV01 de volta) — o padrao aceitava `_ATT`
 *                mas nao `_ATT-02`: 28/09 saiu com 990 de 1.155 inversores.
 * O contrato de nome da intake nao cobria: esse arquivo chega pelo caminho antigo e nem passa por ela. Entao o ensaio
 * le o `CARIMBO` DE DENTRO do fonte de cada gerador e o julga contra os nomes que de fato chegaram.
 *
 * Roda ANTES de gerar: padrao que nao le um nome conhecido reprova sem publicar nada. Sem dependencia, sem segredo.
 */
const fs = require('fs'), path = require('path');

// nomes que CHEGARAM no container (com o prefixo do envio) e o que o gerador deve fazer com eles
const LE = [
  '68800_M04_20260901_030000.csv',          // o nome original
  '91374_M02_ATT_20260928_040625.csv',      // 24/09/2026
  '91745_M05_ATT-02_20260929_034125.csv',   // 29/09/2026
  '91752_M10_ATT_20260929_033503.csv',      // M10 = M1
];
// o que NAO e export de inversor, e um sufixo desconhecido (quem o acusa e o contrato da intake, nao o gerador)
const NAO_LE = ['91751_PR_20260929_030155.csv', '91750_Trafo_20260929_030015.csv', '91740_IRR_20260929_030014.csv',
  '91734_M5.xlsx', '91745_M05_XYZ-03_20260929_034125.csv'];

const f = [];
for (const g of ['gen-perdas.js', 'gen-inv-scada.js']) {
  const src = fs.readFileSync(path.join(__dirname, g), 'utf8');
  const m = src.match(/^const CARIMBO = (\/.+\/[a-z]*);/m);
  if (!m) { f.push(g + ': nao achei `const CARIMBO = /.../` no fonte'); continue; }
  const re = new Function('return ' + m[1])();
  for (const n of LE) {
    const x = n.match(re);
    if (!x) f.push(g + ' NAO le ' + n);
    else console.log('  ok  ' + g.padEnd(17) + ' le ' + n + ' -> usina M' + x[1] + ', carimbo ' + x[2]);
  }
  for (const n of NAO_LE) {
    if (re.test(n)) f.push(g + ' le ' + n + ', que nao e export de inversor conhecido');
    else console.log('  ok  ' + g.padEnd(17) + ' ignora ' + n);
  }
}
if (f.length) { f.forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
console.log('ensaio-carimbo-inversor: TUDO PASSOU');
