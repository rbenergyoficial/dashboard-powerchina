/*
 * guarda-index.js — recusa uma publicacao que AMPUTE o index.html.
 *
 * ══ POR QUE EXISTE ═══════════════════════════════════════════════════════════════════════════
 *
 * 🔴 Em 17/08/2026 o commit `87d6a6d` ("Auto-update dashboard 2026-08-17 11:05:34") sobrescreveu
 * o index.html com uma copia de 28/06:
 *
 *     1 file changed, 335 insertions(+), 3288 deletions(-)
 *     1.322.724 bytes  ->  1.080.217 bytes   (-18%)
 *
 * Sumiram o comparativo SCADA, o painel do ONS, o monitor lendo o blob leve e a tela cheia. O site
 * serviu a versao amputada por SEIS DIAS — e so foi descoberto porque um humano abriu a pagina e
 * estranhou. Nenhum job ficou vermelho, nenhum alerta saiu: publicar menos nao e erro para nenhuma
 * ferramenta, e um deploy de 1 MB parece tao saudavel quanto um de 1,3 MB.
 *
 * ══ O CRITERIO ═══════════════════════════════════════════════════════════════════════════════
 *
 * O arquivo cresce por acrescimo de funcionalidade — doze commits entre 09 e 13/07 o levaram de
 * 1,27 MB a 1,32 MB. Uma remocao deliberada raramente passa de alguns por cento; a de 17/08 tirou
 * 18%. O limiar de 5% cabe folgado entre os dois casos.
 *
 * ⚠️ NAO E UM PORTAO DE QUALIDADE. Ele nao sabe se o conteudo esta certo — so recusa a forma de
 * falha que ja aconteceu: publicar por cima uma copia velha e menor. Encolher de proposito
 * continua possivel, com `PERMITE_ENCOLHER=1` na mensagem do commit, que deixa a decisao
 * registrada em vez de silenciosa.
 *
 * Env: LIMITE_PCT (default 5), ARQUIVO (default index.html).
 */
const { execSync } = require('child_process');

const LIMITE = parseFloat(process.env.LIMITE_PCT || '5');
const ARQ = process.env.ARQUIVO || 'index.html';

const sh = (c) => execSync(c, { encoding: 'utf8' }).trim();
const tamanho = (ref) => {
  try { return parseInt(sh('git cat-file -s ' + ref + ':' + ARQ), 10); }
  catch (e) { return null; }
};

const novo = tamanho('HEAD');
const velho = tamanho('HEAD~1');

if (novo == null) {
  console.log('  ' + ARQ + ' nao existe em HEAD — nada a guardar.');
  process.exit(0);
}
if (velho == null) {
  console.log('  ' + ARQ + ' nao existia no commit anterior (arquivo novo, ' + novo + ' bytes) — ok.');
  process.exit(0);
}

const delta = novo - velho;
const pct = (delta / velho) * 100;
console.log('  ' + ARQ);
console.log('    antes:  ' + velho.toLocaleString('pt-BR') + ' bytes');
console.log('    agora:  ' + novo.toLocaleString('pt-BR') + ' bytes');
console.log('    varia:  ' + (delta >= 0 ? '+' : '') + delta.toLocaleString('pt-BR')
  + ' bytes  (' + pct.toFixed(1) + '%)');

if (pct >= -LIMITE) {
  console.log('  ✓ dentro do limite de -' + LIMITE + '%');
  process.exit(0);
}

// a decisao deliberada tem um caminho, e ele deixa rastro
let msg = '';
try { msg = sh('git log -1 --format=%B'); } catch (e) {}
if (/PERMITE_ENCOLHER/.test(msg)) {
  console.log('  ⚠️ encolheu ' + pct.toFixed(1) + '%, mas o commit declara PERMITE_ENCOLHER — liberado.');
  process.exit(0);
}

console.error('');
console.error('  🔴 PUBLICACAO RECUSADA: o ' + ARQ + ' encolheu ' + Math.abs(pct).toFixed(1)
  + '%, acima do limite de ' + LIMITE + '%.');
console.error('');
console.error('  Foi assim que a versao de 13/07 se perdeu em 17/08: uma copia velha publicada por');
console.error('  cima levou embora o comparativo SCADA, o painel do ONS e o monitor — e ninguem');
console.error('  soube por seis dias.');
console.error('');
console.error('  Se a remocao e proposital, escreva PERMITE_ENCOLHER na mensagem do commit.');
console.error('  Se nao e, o arquivo bom provavelmente esta no commit anterior:');
console.error('      git checkout HEAD~1 -- ' + ARQ);
process.exit(1);
