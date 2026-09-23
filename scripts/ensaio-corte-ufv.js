/*
 * ensaio-corte-ufv.js — o corte diario aberto por USINA fecha com o corte diario por CONTRATO.
 *
 * POR QUE EXISTE. Em 23/09/2026 o painel "A estrategia PPA x Mercado Livre" ganhou o recorte por
 * usina, a pedido. Ate entao o blob so publicava os dois agregados (`corte_diario`).
 *
 * 🔴 E A ABERTURA NAO FECHA SOZINHA — isso foi MEDIDO, nao suposto: com o corte cru por usina, 50 dos
 * 75 dias da janela divergiam do contrato, sempre com a soma das usinas ACIMA. A causa esta no dado
 * do operador: a referencia por usina nao presta (este pipeline declara "o conjunto e integro; a
 * abertura por usina NAO"), e o M3 vem com a referencia ABAIXO da verificada em 43 dos 75 dias. No
 * grupo essa sobra compensa o deficit dos vizinhos; aberta por usina, nao compensa. Por isso o corte
 * por usina e RECONCILIADO ao total do grupo, pelo mesmo metodo que o mensal ja usa.
 *
 * DUAS ROTAS INDEPENDENTES. O gerador ja ABORTA sem gravar se a soma reconciliada nao reproduzir o
 * grupo — sobre os acumuladores CRUS, em memoria. Este ensaio confere o PRODUTO PUBLICADO, sobre os
 * valores ja arredondados que o painel de fato le. Uma rota pega erro de agregacao; a outra pega erro
 * de emissao (campo faltando, janela diferente, arredondamento que empilha).
 *
 * ⚠️ RODA DEPOIS DE GERAR, como os outros ensaios de PRODUTO. O custo fica declarado — se ele
 * reprovar, o dado ruim ja esta no ar; e dado ruim com o job vermelho e melhor que dado ruim em
 * silencio.
 *
 * Sem segredo nenhum: le blob publico. `BASE_DADOS` apontando para um DIRETORIO le do disco, que e o
 * que permite exercita-lo contra uma rodada local ANTES de publicar.
 */
const https = require('https'), zlib = require('zlib'), fs = require('fs'), path = require('path');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M9'];          // ⚠️ SEM o M7: ele nao tem registro proprio no operador (ver abaixo)
const r2 = v => Math.round(v * 100) / 100;

function getJSON(nome) {
  if (!/^https?:/i.test(BASE)) return Promise.resolve(JSON.parse(fs.readFileSync(path.join(BASE, nome), 'utf8')));
  const url = BASE + nome;
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

let falhas = 0, conferidos = 0;
const nok = m => { console.error('  ✗ ' + m); falhas++; };

/* A REGRA, numa escrita so — o ensaio e o plantio chamam a MESMA funcao. Duas copias provariam
   apenas que a copia concorda consigo mesma. Devolve a lista de divergencias. */
function julga(agg, ufv) {
  const ruins = [];
  const porDia = new Map();
  for (const r of ufv) {
    const g = porDia.get(r.dia) || porDia.set(r.dia, { PPA: [0, 0, true], ML: [0, 0, true] }).get(r.dia);
    if (!g[r.grupo]) { ruins.push(r.dia + ': grupo desconhecido ' + r.grupo); continue; }
    g[r.grupo][0] += r.potencial_mwh; g[r.grupo][1] += r.cortado_mwh;
    if (!r.corte_reconciliado) g[r.grupo][2] = false;
  }
  const porDiaAgg = new Map(agg.map(x => [x.dia, x]));
  for (const [dia, g] of porDia) {
    const a = porDiaAgg.get(dia);
    if (!a) { ruins.push(dia + ': aberto por usina, e sem o agregado'); continue; }
    for (const [k, campo] of [['PPA', 'ppa_corte_pct'], ['ML', 'ml_corte_pct']]) {
      if (!g[k][2]) continue;   // dia declarado sem reconciliacao nao fecha por construcao
      const pct = g[k][0] > 0 ? r2(100 * g[k][1] / g[k][0]) : 0;
      if (Math.abs(pct - a[campo]) > 0.05) ruins.push(dia + ' ' + k + ': usinas ' + pct + '% x grupo ' + a[campo] + '%');
    }
  }
  return ruins;
}

(async () => {
  const j = await getJSON('executivo.json');
  const agg = j.corte_diario || [], ufv = j.corte_diario_ufv || [];
  console.log('corte_diario %d linhas · corte_diario_ufv %d linhas', agg.length, ufv.length);
  if (!ufv.length) { console.error('✗ corte_diario_ufv vazio ou ausente'); process.exit(1); }

  // 1 · FECHAMENTO — a soma reconciliada das usinas reproduz o grupo, dia a dia
  const ruins = julga(agg, ufv);
  if (ruins.length) { nok('fechamento em ' + ruins.length + ' caso(s):'); ruins.slice(0, 8).forEach(s => console.error('      ' + s)); }
  else console.log('  ✓ fechamento: as usinas reproduzem os dois contratos em todos os dias');

  // 2 · JANELA — a abertura nao pode cobrir dia que o agregado nao tem, nem faltar dia que ele tem
  const dAgg = new Set(agg.map(x => x.dia)), dUfv = new Set(ufv.map(x => x.dia));
  const sobra = [...dUfv].filter(d => !dAgg.has(d)), falta = [...dAgg].filter(d => !dUfv.has(d));
  if (sobra.length) nok('a abertura cobre ' + sobra.length + ' dia(s) que o agregado nao tem');
  if (falta.length) nok('o agregado tem ' + falta.length + ' dia(s) que a abertura nao cobre');
  if (!sobra.length && !falta.length) console.log('  ✓ janela: os mesmos %d dias nos dois', dAgg.size);

  // 3 · ELENCO — as oito usinas com registro proprio, e o M7 FORA
  // 🔴 A tag "M7" do operador e o circuito 2 do M3: o M7 nao tem geracao nem potencial la em epoca
  // nenhuma. O mensal dele vive de realizado do medidor + potencial ESTIMADO, e nada disso existe por
  // dia. Publicar um M7 diario seria estimar os dois — numero sem fonte. A ausencia dele e a leitura
  // honesta, e esta guarda existe para que ela nao seja desfeita por distracao.
  const nomes = [...new Set(ufv.map(x => x.ufv))].sort();
  const esperado = PPA.concat(ML).sort();
  if (nomes.join(',') !== esperado.join(',')) nok('elenco: ' + nomes.join(',') + ' · esperado ' + esperado.join(','));
  else console.log('  ✓ elenco: %s · o M7 fora, como manda a tag trocada', nomes.join(' '));

  // 4 · ARITMETICA DA PROPRIA LINHA — o percentual publicado sai do potencial e do cortado publicados
  let fora = 0;
  for (const r of ufv) {
    conferidos++;
    const p = r.potencial_mwh > 0 ? r2(100 * r.cortado_mwh / r.potencial_mwh) : 0;
    if (Math.abs(p - r.corte_pct) > 0.02) fora++;
    if (r.cortado_mwh > r.potencial_mwh + 0.01) nok(r.dia + ' ' + r.ufv + ': cortado acima do potencial');
    if (r.cortado_bruto_mwh == null) nok(r.dia + ' ' + r.ufv + ': sem cortado_bruto_mwh (a auditoria do ajuste)');
  }
  if (fora) nok('o percentual nao sai da propria linha em ' + fora + ' de ' + ufv.length);
  else console.log('  ✓ aritmetica: o percentual sai do potencial e do cortado da propria linha (%d)', ufv.length);

  // 5 · A RECONCILIACAO E PROPORCIONAL — nao pode haver usina favorecida
  // Dentro de um grupo-dia reconciliado, cortado/bruto tem de ser o MESMO fator em todas as usinas,
  // menos a de maior corte, que recebe a sobra de arredondamento. Sem esta guarda, um ajuste que
  // fechasse o total descarregando tudo numa usina passaria pelo teste de fechamento.
  const chaves = new Map();
  for (const r of ufv) { const k = r.dia + '|' + r.grupo; (chaves.get(k) || chaves.set(k, []).get(k)).push(r); }
  let desproporcional = 0;
  for (const [k, L] of chaves) {
    if (!L.every(r => r.corte_reconciliado)) continue;
    const com = L.filter(r => r.cortado_bruto_mwh > 0.05);
    if (com.length < 2) continue;
    const fs_ = com.map(r => r.cortado_mwh / r.cortado_bruto_mwh).sort((a, b) => a - b);
    // fora a linha da sobra, o fator e unico; a folga cobre o centavo distribuido
    if (fs_[fs_.length - 2] - fs_[0] > 0.01) { desproporcional++; if (desproporcional <= 3) console.error('      ' + k + ': fatores ' + fs_.map(x => x.toFixed(4)).join(' ')); }
  }
  if (desproporcional) nok('reconciliacao desproporcional em ' + desproporcional + ' grupo-dia');
  else console.log('  ✓ reconciliacao proporcional em %d grupo-dia', chaves.size);

  // 6 · PROVA QUE REPROVA — defeitos plantados sobre copia sadia do proprio blob
  const copia = () => JSON.parse(JSON.stringify(ufv));
  const plantios = [
    ['uma usina fora do grupo certo', L => { const r = L.find(x => x.grupo === 'PPA'); r.grupo = 'ML'; return r; }],
    ['um dia com o cortado inflado', L => { const r = L.find(x => x.cortado_mwh > 1); r.cortado_mwh = r2(r.cortado_mwh * 1.5); return r; }],
    ['o corte CRU no lugar do reconciliado', L => { let m = null; L.forEach(x => { if (x.cortado_bruto_mwh !== x.cortado_mwh) { x.cortado_mwh = x.cortado_bruto_mwh; m = x; } }); return m; }],
  ];
  for (const [nome, planta] of plantios) {
    const L = copia(), antes = JSON.stringify(L);
    const alvo = planta(L);
    if (!alvo || JSON.stringify(L) === antes) { nok('plantio "' + nome + '" NAO mudou nada — nao julgou a guarda'); continue; }
    if (!julga(agg, L).length) nok('plantio "' + nome + '" passou — a guarda nao mede');
    else console.log('  ✓ reprova o plantio: %s', nome);
  }

  console.log(falhas ? '\n✗ ' + falhas + ' falha(s)' : '\n✓ tudo passou · ' + conferidos + ' linhas conferidas');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('erro: ' + e.message); process.exit(1); });
