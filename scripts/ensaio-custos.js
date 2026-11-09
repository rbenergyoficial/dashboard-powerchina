// Ensaio do custos.json ANTES de subir (lote malha-custos, 09/11/2026). Uso: node scripts/ensaio-custos.js <custos.json>
// 🔴 O que esta sendo provado: o arquivo que a aba Custos mostra fecha as próprias contas — o gasto do mês é a soma dos dias,
// cada dia é a soma dos serviços, a previsão não fica abaixo do gasto, o imposto e a meta diária batem, e o aviso de meta
// aparece exatamente quando a previsão com imposto passa da meta. Quatro plantios (cópias adulteradas do mesmo arquivo) reprovam.
'use strict';
const fs = require('fs');
const { META_MENSAL, IMPOSTO, LOTES } = require('./gen-custos');

function confere(j, dizer) {
  let mau = 0;
  const ok = (c, m) => { if (!c) { mau++; if (dizer) console.log('  [X] ' + m); } else if (dizer) console.log('  ok  ' + m); };
  const perto = (a, b, tol) => Math.abs(a - b) <= (tol || 0.06);
  try {
    ok(j.meta.mensal === META_MENSAL && perto(j.meta.diaria, META_MENSAL / j.mes.dias, 0.01), `meta ${j.meta.mensal}/mês e ${j.meta.diaria}/dia`);
    const soma = j.por_dia.reduce((a, x) => a + x.total, 0);
    ok(perto(j.mes.gasto, soma, 0.05 + 0.005 * j.por_dia.length), `gasto do mês (${j.mes.gasto}) = soma dos dias (${soma.toFixed(2)})`);
    ok(j.por_dia.every((x) => perto(x.total, Object.values(x.servicos).reduce((a, b) => a + b, 0), 0.06)), 'cada dia = soma dos serviços');
    const dias = j.por_dia.map((x) => x.dia);
    ok(dias.every((d, i) => d.startsWith(j.mes.inicio.slice(0, 8)) && (i === 0 || d > dias[i - 1])), 'dias do mês, em ordem, sem repetição');
    ok(j.mes.previsao >= j.mes.gasto - 0.01, 'previsão não fica abaixo do gasto');
    ok(perto(j.mes.previsao_com_imposto, j.mes.previsao * (1 + IMPOSTO), 0.02) && perto(j.mes.gasto_com_imposto, j.mes.gasto * (1 + IMPOSTO), 0.02), 'imposto aplicado');
    ok(perto(j.hoje.estimado_dia, j.hoje.fixos_dia + j.hoje.saida_ate_agora * 24 / j.hoje.horas, 0.05), 'estimado de hoje = fixos + saída no ritmo do dia');
    const temMeta = j.avisos.some((a) => a.tipo === 'meta');
    ok(temMeta === (j.mes.previsao_com_imposto > META_MENSAL), 'aviso de meta exatamente quando a previsão com imposto passa da meta');
    ok(j.lotes.map((l) => l.id).join() === LOTES.map((l) => l.id).join(), 'os lotes da auditoria');
    ok(Date.now() - j.ms < 3 * 3600e3, 'arquivo recém-gerado');
  } catch (e) { ok(false, 'estrutura: ' + e.message); }
  return mau;
}

const arq = process.argv[2];
const j = JSON.parse(fs.readFileSync(arq, 'utf8'));
console.log('ensaio do custos.json');
const mau = confere(j, true);
const copia = () => JSON.parse(JSON.stringify(j));
const PLANTIOS = {
  'gasto que não é a soma dos dias': (x) => { x.mes.gasto += 10; },
  'dia que não é a soma dos serviços': (x) => { if (x.por_dia[0]) x.por_dia[0].total += 5; },
  'aviso de meta trocado': (x) => { x.avisos = x.avisos.some((a) => a.tipo === 'meta') ? x.avisos.filter((a) => a.tipo !== 'meta') : x.avisos.concat([{ tipo: 'meta' }]); },
  'previsão abaixo do gasto': (x) => { x.mes.previsao = x.mes.gasto - 5; x.mes.previsao_com_imposto = x.mes.previsao * (1 + IMPOSTO); }
};
let furou = 0;
for (const [nome, f] of Object.entries(PLANTIOS)) {
  const x = copia(); f(x); const n = confere(x, false);
  console.log((n ? '  ok  ' : '  [X] ') + 'plantio "' + nome + '" ' + (n ? 'reprova' : 'PASSOU — o ensaio não o vê'));
  if (!n) furou++;
}
console.log(mau || furou ? `REPROVADO: ${mau} falha(s), ${furou} plantio(s) não pego(s)` : 'APROVADO');
process.exit(mau || furou ? 1 : 0);
