/*
 * ensaio-irradiancia-parquet.js — prova que o caminho do PARQUET produz exatamente o mesmo
 * resultado do caminho do CSV.
 *
 * POR QUE ESTE ENSAIO EXISTE
 *
 * A troca de formato e barata de fazer e cara de errar, porque o modo de falha nao levanta erro:
 * o parquet devolve `din_instante` como data marcada UTC, o CSV devolve texto local ingenuo, e
 * converter errado desloca tres horas. Medido antes de migrar, nas 9.504 linhas de agosto/2026:
 *
 *                     chaves que casam      VALORES que casam
 *     em UTC           9.504 / 9.504        9.504 / 9.504
 *     em hora local    9.450 / 9.504        2.827 / 9.504
 *
 * Ou seja: a leitura errada casa 99,4% das CHAVES e estraga 70% dos VALORES. Nenhum log ficaria
 * vermelho. O painel desenharia uma curva plausivel com a geracao trocada de horario.
 *
 * Por isso a verificacao nao pode ser "o parquet leu sem erro". Tem de ser a comparacao linha a
 * linha contra o caminho que ja estava em producao — que continua no gerador exatamente para
 * poder servir de referencia.
 *
 * CUSTO: este ensaio baixa o CSV de ~67 MB de proposito. E o preco de comparar com a referencia,
 * pago uma vez, e nao a cada rodada.
 *
 * Uso: node scripts/ensaio-irradiancia-parquet.js [AAAA_MM]
 */
const G = require('./gen-irradiancia-ons.js');

const MES = (process.argv[2] || '').trim() || G.mesesAlvo()[1];

let falhas = 0;
const ok = (m) => console.log('  [OK]    ' + m);
const nok = (m) => { falhas++; console.log('  [FALHA] ' + m); };

// ---- as duas conversoes de instante, lado a lado ----------------------------------------------
function t0() {
  const d = new Date('2026-08-01T00:00:00.000Z');
  const viaUTC = G.instanteComoONS(d);
  if (viaUTC === '2026-08-01 00:00:00') {
    ok('instante: a data marcada UTC vira ' + viaUTC + ', como o CSV escreve');
  } else {
    nok('instante: esperava "2026-08-01 00:00:00", veio "' + viaUTC + '"');
  }
  const p = (n) => String(n).padStart(2, '0');
  const local = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':00';
  if (local === viaUTC) {
    nok('a maquina esta em UTC, entao este ensaio NAO consegue distinguir as duas leituras — '
      + 'rode onde o fuso local nao seja UTC, ou o teste passa por acidente');
  } else {
    ok('a leitura local daria "' + local + '" — as duas sao distinguiveis nesta maquina');
  }
  if (G.invComoONS(false) === 'False' && G.invComoONS(true) === 'True'
    && G.invComoONS('False') === 'False') {
    ok('indicador de invalido: booleano e texto chegam ao mesmo formato do blob publicado');
  } else {
    nok('indicador de invalido: ' + G.invComoONS(false) + ' / ' + G.invComoONS(true));
  }
}

(async () => {
  console.log('=== parquet contra CSV · mes ' + MES + ' ===\n');
  t0();

  console.log('\n  baixando os dois caminhos (o CSV e grande de proposito)...');
  const tp = Date.now();
  const pq = await G.baixarParquet(MES);
  const msPq = Date.now() - tp;
  const tc = Date.now();
  const csv = await G.baixarCSV(MES);
  const msCsv = Date.now() - tc;

  if (!pq || !csv) { nok('um dos caminhos nao trouxe nada (parquet=' + !!pq + ' csv=' + !!csv + ')'); process.exit(1); }
  console.log('  parquet: ' + pq.length.toLocaleString('pt-BR') + ' linhas em ' + msPq + ' ms');
  console.log('  csv    : ' + csv.length.toLocaleString('pt-BR') + ' linhas em ' + msCsv + ' ms');
  console.log('  o parquet foi ' + (msCsv / msPq).toFixed(1) + 'x mais rapido\n');

  if (pq.length !== csv.length) nok('contagem diferente: ' + pq.length + ' contra ' + csv.length);
  else ok('contagem: ' + pq.length.toLocaleString('pt-BR') + ' linhas nos dois');

  // comparacao linha a linha por chave (instante + usina)
  const mapa = new Map(csv.map((l) => [l.ts + '|' + l.u, l]));
  let semPar = 0;
  const difs = { ts: 0, irr: 0, inv: 0, ge: 0, gv: 0 };
  const exemplos = [];
  for (const a of pq) {
    const b = mapa.get(a.ts + '|' + a.u);
    if (!b) { semPar++; if (exemplos.length < 3) exemplos.push('sem par: ' + JSON.stringify(a)); continue; }
    for (const c of ['irr', 'inv', 'ge', 'gv']) {
      if (String(a[c]) !== String(b[c])) {
        difs[c]++;
        if (exemplos.length < 3) exemplos.push(a.ts + ' ' + a.u + ' ' + c + ': parquet=' + a[c] + ' csv=' + b[c]);
      }
    }
  }
  if (semPar) nok(semPar + ' linha(s) do parquet sem par no CSV — instante ou usina divergem');
  else ok('chaves: toda linha do parquet tem par exato no CSV');

  const totalDif = Object.values(difs).reduce((s, n) => s + n, 0);
  if (totalDif) {
    nok(totalDif + ' valor(es) divergente(s): '
      + Object.keys(difs).filter((k) => difs[k]).map((k) => k + '=' + difs[k]).join(' · '));
    exemplos.forEach((e) => console.log('          ' + e));
  } else {
    ok('valores: irr, inv, ge e gv identicos em todas as linhas');
  }

  // e o JSON final tem de sair byte a byte igual (menos o carimbo de geracao)
  const limpa = (o) => { const x = JSON.parse(JSON.stringify(o)); delete x.gerado_em; return JSON.stringify(x); };
  if (limpa(G.montaSaida(MES, pq)) === limpa(G.montaSaida(MES, csv))) {
    ok('o JSON publicado sai identico pelos dois caminhos');
  } else {
    nok('o JSON publicado DIFERE entre os dois caminhos');
  }

  console.log('\n=== ' + (falhas ? falhas + ' FALHA(S)' : 'TUDO PASSOU') + ' ===');
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
