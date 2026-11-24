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
const zlib = require('zlib'), fs = require('fs'), path = require('path');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const r2 = v => Math.round(v * 100) / 100;
// A data da correcao da tag do M7 sai do PROPRIO gerador — escrita de novo aqui, as duas copias
// divergiriam na primeira edicao, e o ensaio passaria a julgar outra regra.
const TAG_M7_OK = (function () {
  const src = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8');
  const m = src.match(/const TAG_M7_OK = '(\d{4}-\d{2}-\d{2})'/);
  if (!m) { console.error('✗ nao achei TAG_M7_OK no gen-executivo.js — o ensaio nao sabe a data que julga'); process.exit(1); }
  return m[1];
})();

function getJSON(nome) {
  if (!/^https?:/i.test(BASE)) return Promise.resolve(JSON.parse(fs.readFileSync(path.join(BASE, nome), 'utf8')));
  const url = BASE + nome;
  /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`); o gzip pelos bytes, a lib devolve o que esta gravado */
  return LD.pede(url, { 'accept-encoding': 'gzip' }).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' em ' + url);
    const b = x.buf[0] === 0x1f && x.buf[1] === 0x8b ? zlib.gunzipSync(x.buf) : x.buf;
    return JSON.parse(b.toString('utf8'));
  });
}

// A RECALIBRACAO da referencia por usina (corte-ufv-recalibrado): as constantes saem do PROPRIO gerador, pelo mesmo motivo do TAG_M7_OK
const CONST = (function () {
  const src = fs.readFileSync(path.join(__dirname, 'gen-executivo.js'), 'utf8'), o = {};
  for (const [k, re] of [['REF_DESDE', /const REF_DESDE = '(\d{4}-\d{2}-\d{2})'/], ['RTC', /const RTC_M3_REPARO = "(\d{4}-\d{2}-\d{2})"/],
    ['SOL', /const SOL_REF = (\d+), PISO_FATOR_REF = (\d+);/]]) {
    const m = src.match(re); if (!m) { console.error('✗ nao achei ' + k + ' no gen-executivo.js — o ensaio nao sabe a regra que julga'); process.exit(1); }
    if (k === 'SOL') { o.SOL = +m[1]; o.PISO = +m[2]; } else o[k] = m[1];
  }
  return o;
})();

/* O fator de cada usina e mes refeito por OUTRA rota: as meias horas publicadas no `ref_hora` (ge, gv e irradiancia valida por usina, a
   marca de limitacao do conjunto por dia), e nao os acumuladores do gerador. Devolve mes|usina -> { f, n }. */
function fatorPelaMeiaHora(RH) {
  const lim = new Map((RH.dias || []).map((d) => [d.dia, d])), o = new Map();
  for (const s of RH.serie || []) {
    const d = lim.get(s.dia); if (!d || d.excluido) continue;
    const k = s.dia.slice(0, 7) + '|' + s.ufv, a = o.get(k) || o.set(k, { ge: 0, gv: 0, n: 0 }).get(k);
    for (let i = 0; i < 48; i++) {
      if (d.lim[i] || s.irr[i] == null || s.irr[i] < CONST.SOL || !(s.ge[i] > 0)) continue;
      a.ge += s.ge[i]; a.gv += s.gv[i] || 0; a.n++;
    }
  }
  o.forEach((a) => { a.f = a.gv > 0 ? a.ge / a.gv : null; });
  return o;
}

/* A REGRA da recalibracao, numa escrita so (ensaio e plantio chamam a mesma). Devolve a lista de divergencias. */
function julgaFator(ufv, refDia, fatMH) {
  const ruins = [], dia = new Map(refDia.map((x) => [x.dia + '|' + x.ufv, x]));
  const mesRTC = CONST.RTC.slice(0, 7);
  for (const r of ufv) {
    if (!('fator_ref' in r) || !('fator_ref_mes' in r)) { ruins.push(r.dia + ' ' + r.ufv + ': sem fator_ref/fator_ref_mes'); continue; }
    if (r.dia < CONST.REF_DESDE) { if (r.fator_ref != null) ruins.push(r.dia + ' ' + r.ufv + ': fator antes de ' + CONST.REF_DESDE); continue; }
    const mh = fatMH.get(r.mes + '|' + r.ufv);
    // o mes ate a virada do RTC do M3 soma o registro "M7" no M3, que o ref_hora publica separado: a segunda rota nao vale ali
    const comparavel = !(r.ufv === 'M3' && r.mes <= mesRTC);
    if (r.fator_ref == null) {
      if (comparavel && mh && mh.n >= CONST.PISO) ruins.push(r.dia + ' ' + r.ufv + ': sem fator, e o mes tem ' + mh.n + ' meias horas livres de sol');
    } else {
      if (!(r.fator_ref > 0)) { ruins.push(r.dia + ' ' + r.ufv + ': fator_ref ' + r.fator_ref); continue; }
      if (comparavel && r.fator_ref_mes === r.mes && mh && mh.n >= CONST.PISO && Math.abs(mh.f - r.fator_ref) > 0.002)
        ruins.push(r.dia + ' ' + r.ufv + ': fator ' + r.fator_ref + ' x ' + mh.f.toFixed(4) + ' refeito das meias horas (' + mh.n + ')');
      if (comparavel && r.fator_ref_mes === r.mes && mh && mh.n < CONST.PISO)
        ruins.push(r.dia + ' ' + r.ufv + ': fator do proprio mes com ' + mh.n + ' meias horas, abaixo do piso ' + CONST.PISO);
      if (r.fator_ref_mes > r.mes) ruins.push(r.dia + ' ' + r.ufv + ': fator emprestado de mes POSTERIOR (' + r.fator_ref_mes + ')');
    }
    // o bruto sai da referencia recalibrada: max(0, ge / fator - gv), com o ge e o gv do ref_dia_ufv
    const d = dia.get(r.dia + '|' + r.ufv);
    if (d && d.ref_mwh != null && d.ger_mwh != null && comparavel) {
      const esp = Math.max(0, d.ref_mwh / (r.fator_ref || 1) - d.ger_mwh);
      // folga DERIVADA do arredondamento publicado: o fator a 4 casas (meia unidade = 5e-5) pesa ge x 5e-5 / fator^2; o ge, o gv e o bruto
      // a 2 casas, 0,005 cada (o ge dividido pelo fator)
      const fol = d.ref_mwh * 5e-5 / Math.pow(r.fator_ref || 1, 2) + 0.005 / (r.fator_ref || 1) + 0.010 + 1e-6;
      if (Math.abs(esp - r.cortado_bruto_mwh) > fol) ruins.push(r.dia + ' ' + r.ufv + ': bruto ' + r.cortado_bruto_mwh + ' x ' + r2(esp) + ' da referencia recalibrada');
    }
  }
  return ruins;
}

/* O mensal por usina (`serie_ufv`) contra o diario (`corte_diario_ufv`). Nos meses que a janela do diario cobre desde o dia 1: (a) a usina
   do diario com fator tem o MESMO fator no mensal; (b) o cortado do mensal fica a no maximo 10 % (ou 30 MWh, o que for maior) da soma dos
   dias. A folga: as duas reconciliam a totais diferentes (o mensal ao corte do conjunto no mes, o diario ao deficit de cada grupo no dia),
   e medido com o fator nas duas a maior distancia em out/26 foi 7,5 % (M9). Sem o fator no mensal a M3 de nov/26 fica a 56 %. */
function julgaMensal(SU, ufv) {
  const ruins = [], dias = new Map(), fd = new Map();
  for (const r of ufv) { const k = r.mes + '|' + r.ufv; dias.set(k, (dias.get(k) || 0) + (r.cortado_mwh || 0)); if (r.fator_ref != null) fd.set(k, r.fator_ref); }
  const prim = ufv.map((x) => x.dia).sort()[0] || '';
  const meses = [...new Set(ufv.map((x) => x.mes))].filter((m) => prim <= m + '-01');
  for (const m of meses) for (const u of PPA.concat(ML)) {
    const k = m + '|' + u, s = SU.find((x) => x.mes === m && x.ufv === u); if (!s || !dias.has(k)) continue;
    if (fd.has(k) && s.fator_ref !== fd.get(k)) ruins.push(m + ' ' + u + ': fator do mensal ' + s.fator_ref + ' x diario ' + fd.get(k));
    if (s.cortado_mwh == null) continue;
    const d = dias.get(k), fol = Math.max(30, 0.10 * d);
    if (Math.abs(s.cortado_mwh - d) > fol) ruins.push(m + ' ' + u + ': mensal ' + s.cortado_mwh + ' MWh x soma dos dias ' + r2(d) + ' (folga ' + r2(fol) + ')');
  }
  return ruins;
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

  // 3 · ELENCO — as nove usinas, e o M7 SO desde a correcao da tag
  // O registro "M7" do operador foi o circuito 2 do M3 ate 16/07/2026 e e o proprio M7 desde TAG_M7_OK.
  // 🔴 Ate 23/09 esta guarda exigia o M7 FORA em qualquer data, e por isso nunca viu que o gerador o
  // descartava tambem depois da correcao — 16,7 % do potencial do grupo ML fora do painel. Guarda que
  // cristaliza uma premissa defende a premissa, nao o dado (PROMOVER m7-pos-tag).
  const nomes = [...new Set(ufv.map(x => x.ufv))].sort();
  const esperado = PPA.concat(ML).sort();
  if (nomes.join(',') !== esperado.join(',')) nok('elenco: ' + nomes.join(',') + ' · esperado ' + esperado.join(','));
  const m7cedo = ufv.filter(x => x.ufv === 'M7' && x.dia < TAG_M7_OK);
  if (m7cedo.length) nok('M7 com linha antes de ' + TAG_M7_OK + ' (' + m7cedo.length + '): ate la o registro era o circuito 2 do M3');
  const diasM7 = new Set(ufv.filter(x => x.ufv === 'M7').map(x => x.dia));
  const semM7 = [...new Set(agg.map(x => x.dia))].filter(d => d >= TAG_M7_OK && !diasM7.has(d));
  if (semM7.length) nok('M7 ausente em ' + semM7.length + ' dia(s) depois de ' + TAG_M7_OK + ' (ex.: ' + semM7.slice(0, 3).join(', ') + ')');
  const m7ml = ufv.filter(x => x.ufv === 'M7' && x.grupo !== 'ML');
  if (m7ml.length) nok('M7 fora do grupo ML em ' + m7ml.length + ' linha(s)');
  if (nomes.join(',') === esperado.join(',') && !m7cedo.length && !semM7.length && !m7ml.length)
    console.log('  ✓ elenco: %s · o M7 so desde %s, no grupo ML, em %d dias', nomes.join(' '), TAG_M7_OK, diasM7.size);

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
    // a linha mudada tem de ter corte: a primeira do PPA pode vir com corte ~0 e o grupo nao mudar de percentual (corte-ufv-recalibrado)
    ['uma usina fora do grupo certo', L => { const r = L.find(x => x.grupo === 'PPA' && x.cortado_mwh > 5); r.grupo = 'ML'; return r; }],
    ['um dia com o cortado inflado', L => { const r = L.find(x => x.cortado_mwh > 1); r.cortado_mwh = r2(r.cortado_mwh * 1.5); return r; }],
    ['o corte CRU no lugar do reconciliado', L => { let m = null; L.forEach(x => { if (x.cortado_bruto_mwh !== x.cortado_mwh) { x.cortado_mwh = x.cortado_bruto_mwh; m = x; } }); return m; }],
    // o defeito que o lote m7-pos-tag conserta, visto pela abertura: sem as linhas do M7 as usinas do
    // ML deixam de reproduzir o grupo, que agora o inclui
    ['o M7 fora do grupo ML depois da correcao da tag', L => { let r = null; for (let k = L.length - 1; k >= 0; k--) if (L[k].ufv === 'M7') r = L.splice(k, 1)[0]; return r; }],
  ];
  for (const [nome, planta] of plantios) {
    const L = copia(), antes = JSON.stringify(L);
    const alvo = planta(L);
    if (!alvo || JSON.stringify(L) === antes) { nok('plantio "' + nome + '" NAO mudou nada — nao julgou a guarda'); continue; }
    if (!julga(agg, L).length) nok('plantio "' + nome + '" passou — a guarda nao mede');
    else console.log('  ✓ reprova o plantio: %s', nome);
  }

  // 7 · A REFERENCIA RECALIBRADA (corte-ufv-recalibrado) — o fator de cada usina e mes refeito das meias horas publicadas, e o bruto
  // refeito do ref_dia_ufv com esse fator. Sem esta guarda o gerador poderia voltar a dividir o corte pela referencia crua (a M3 com
  // metade do corte das iguais) e o fechamento passaria: o total do grupo nao muda, so a divisao.
  const RH = await getJSON('ref_hora.json');
  const fatMH = fatorPelaMeiaHora(RH), refDia = j.ref_dia_ufv || [];
  const rf = julgaFator(ufv, refDia, fatMH);
  if (rf.length) { nok('recalibracao da referencia em ' + rf.length + ' caso(s):'); rf.slice(0, 8).forEach((s) => console.error('      ' + s)); }
  else {
    const ms = [...new Set(ufv.map((x) => x.mes))].sort().pop();
    console.log('  ✓ recalibracao: fator e bruto refeitos por outra rota em %d linhas · %s: %s', ufv.length, ms,
      [...new Set(ufv.filter((x) => x.mes === ms).map((x) => x.ufv + ' ' + x.fator_ref))].join(' · '));
  }
  const plantiosF = [
    ['o bruto pela referencia CRUA (o fator ignorado)', (L) => { let m = null; L.forEach((x) => { const d = refDia.find((y) => y.dia === x.dia && y.ufv === x.ufv);
      if (d && x.fator_ref && Math.abs(x.fator_ref - 1) > 0.05) { x.cortado_bruto_mwh = r2(Math.max(0, d.ref_mwh - d.ger_mwh)); m = x; } }); return m; }],
    ['o fator de uma usina trocado', (L) => { const ms = L[L.length - 1].mes; let m = null;
      L.forEach((x) => { if (x.ufv === 'M3' && x.mes === ms) { x.fator_ref = r2(x.fator_ref * 1.05); m = x; } }); return m; }],
    ['a recalibracao desligada (fator nulo, bruto cru)', (L) => { let m = null; L.forEach((x) => { const d = refDia.find((y) => y.dia === x.dia && y.ufv === x.ufv);
      if (d && x.fator_ref != null) { x.fator_ref = null; x.fator_ref_mes = null; x.cortado_bruto_mwh = r2(Math.max(0, d.ref_mwh - d.ger_mwh)); m = x; } }); return m; }],
    ['fator antes de REF_DESDE', (L) => { const x = L[0]; x.dia = '2026-02-27'; x.fator_ref = 1.1; x.fator_ref_mes = '2026-02'; return x; }],
  ];
  for (const [nome, planta] of plantiosF) {
    const L = copia(), antes = JSON.stringify(L);
    const alvo = planta(L);
    if (!alvo || JSON.stringify(L) === antes) { nok('plantio "' + nome + '" NAO mudou nada — nao julgou a guarda'); continue; }
    if (!julgaFator(L, refDia, fatMH).length) nok('plantio "' + nome + '" passou — a guarda nao mede');
    else console.log('  ✓ reprova o plantio: %s', nome);
  }

  // 8 · O MENSAL POR USINA COM O MESMO FATOR (corte-ufv-recalibrado) — o `serie_ufv` leva o fator do diario do mesmo mes, e nos meses que a
  // janela cobre desde o dia 1 a parte de cada usina no mensal fica perto da soma dos dias. Antes do lote, a M3 de nov/26 dava 760 MWh no
  // mensal contra 880 na soma dos dias (e 1.725 com o diario recalibrado): a mesma usina com dois tamanhos na Visao Executiva.
  const SU = j.serie_ufv || [];
  const rm = julgaMensal(SU, ufv);
  if (rm.length) { nok('mensal por usina em ' + rm.length + ' caso(s):'); rm.slice(0, 8).forEach((s) => console.error('      ' + s)); }
  else console.log('  ✓ mensal por usina: o mesmo fator do diario, e a parte de cada usina perto da soma dos dias');
  const plantiosM = [
    ['o mensal sem o fator', (L) => { let m = null; L.forEach((x) => { if (x.fator_ref != null) { x.fator_ref = null; m = x; } }); return m; }],
    ['o mensal da M3 com a referencia crua (metade do corte)', (L) => { const ms = [...new Set(ufv.map((x) => x.mes))].sort().pop();
      const x = L.find((y) => y.mes === ms && y.ufv === 'M3'); if (x) x.cortado_mwh = r2(x.cortado_mwh * 0.5); return x; }],
  ];
  for (const [nome, planta] of plantiosM) {
    const L = JSON.parse(JSON.stringify(SU)), antes = JSON.stringify(L);
    const alvo = planta(L);
    if (!alvo || JSON.stringify(L) === antes) { nok('plantio "' + nome + '" NAO mudou nada — nao julgou a guarda'); continue; }
    if (!julgaMensal(L, ufv).length) nok('plantio "' + nome + '" passou — a guarda nao mede');
    else console.log('  ✓ reprova o plantio: %s', nome);
  }

  console.log(falhas ? '\n✗ ' + falhas + ' falha(s)' : '\n✓ tudo passou · ' + conferidos + ' linhas conferidas');
  process.exit(falhas ? 1 : 0);
})().catch(e => { console.error('erro: ' + e.message); process.exit(1); });
