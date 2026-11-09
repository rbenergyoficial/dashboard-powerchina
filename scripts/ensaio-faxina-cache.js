// Ensaio da faxina do cache do Actions (lote faxina-cache, 09/11/2026). Sem rede: uma lista forjada no formato da API.
// 🔴 O que esta sendo provado: fica a MAIS NOVA de cada família e por ref; a família é a chave sem o último segmento (famílias de
// prefixo parecido não se misturam); entrada superada usada nas últimas 2 h fica; nada some de família com uma entrada só.
'use strict';
const fs = require('fs');
const path = require('path');
const FONTE = fs.readFileSync(path.join(__dirname, 'faxina-cache.js'), 'utf8');
const carrega = (src) => { const m = { exports: {} }; new Function('module', 'exports', 'require', src)(m, m.exports, require); return m.exports; };

const H = 3600e3, AG = Date.UTC(2026, 10, 10, 12);
const c = (id, key, horasCriado, horasUso, ref) => ({ id, key, ref: ref || 'refs/heads/main', size_in_bytes: 1e8,
  created_at: new Date(AG - horasCriado * H).toISOString(), last_accessed_at: new Date(AG - horasUso * H).toISOString() });
const LISTA = [
  c(1, 'sungrow-scada-aaa', 30, 29), c(2, 'sungrow-scada-bbb', 10, 9), c(3, 'sungrow-scada-ccc', 1, 1),
  c(4, 'scada-raw-gen-scada-111', 50, 40), c(5, 'scada-raw-gen-scada-222', 20, 5),
  c(6, 'scada-raw-gen-trafo-999', 60, 60),                                   // família de prefixo parecido, entrada única
  c(7, 'hist-publico-way2-agg-x1', 5, 1.5), c(8, 'hist-publico-way2-agg-x2', 2, 0.5),   // a superada foi usada há 1,5 h: fica
  c(9, 'ppc-raw-77', 40, 40, 'refs/pull/12/merge'), c(10, 'ppc-raw-88', 30, 30)         // refs diferentes: cada uma fica
];

function confere(F, dizer) {
  let mau = 0;
  const ok = (v, m) => { if (!v) { mau++; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  try {
    const { fica, sai } = F.plano(LISTA, AG);
    const ids = (xs) => xs.map((x) => x.id).sort((a, b) => a - b).join(',');
    ok(ids(sai) === '1,2,4', `saem só as superadas sem uso recente (saem ${ids(sai)})`);
    ok(fica.some((x) => x.id === 3) && fica.some((x) => x.id === 5), 'fica a mais nova de cada família');
    ok(fica.some((x) => x.id === 6), 'família de prefixo parecido (scada-raw-gen-trafo) não se mistura com a scada-raw-gen-scada');
    ok(fica.some((x) => x.id === 7), 'superada usada há menos de 2 h fica');
    ok(fica.some((x) => x.id === 9) && fica.some((x) => x.id === 10), 'a mesma chave em outra ref é outra família');
    ok(fica.length + sai.length === LISTA.length, 'nenhuma entrada some da conta');
  } catch (e) { ok(false, 'estourou: ' + e.message); }
  return mau;
}

console.log('ensaio da faxina do cache');
const mau = confere(carrega(FONTE), true);
const PLANTIOS = {
  'fica a mais velha': ['(a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)', '(a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)'],
  'família = chave inteira': [".replace(/-[^-]*$/, '')", ''],
  'família sem a ref': ["+ ' @ ' + c.ref", ''],
  'sem a folga de 2 h': ['(agoraMs - Date.parse(c.last_accessed_at) > FOLGA_MS ? sai : fica)', 'sai'],
  'família = primeiro segmento': [".replace(/-[^-]*$/, '')", ".replace(/-.*$/, '')"]
};
let furou = 0;
for (const [nome, [de, para]] of Object.entries(PLANTIOS)) {
  if (!FONTE.includes(de)) { console.log('  [X] plantio "' + nome + '": trecho não encontrado'); furou++; continue; }
  const n = confere(carrega(FONTE.replace(de, para)), false);
  console.log((n ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n ? 'reprova' : 'PASSOU — o ensaio não o vê'));
  if (!n) furou++;
}
console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) não pego(s)` : 'APROVADO');
process.exit(mau || furou ? 1 : 0);
