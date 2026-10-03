// Ensaio do PRODUTO da guarda da EneatLiquida: julga o que o gen-executivo PUBLICOU (guarda_liquida.json) contra a lib.
// Roda DEPOIS do gerador, no executivo.yml. A logica e julgada a parte, com dados plantados, no ensaio-liquidada.js.
//
//   · a janela publicada tem o formato certo, e so residuos de dia COMPLETO dentro de JANELA_DIAS (nenhum dia meio
//     liquidado guardado: ele afrouxaria o teto por 60 dias);
//   · a mediana publicada e a refeita pela lib sobre os mesmos residuos;
//   · PARTIDA (bootstrap): enquanto a janela nunca teve MIN_DIAS dias (`janela_cheia_desde` nulo), o ensaio DECLARA que a
//     guarda esta so no sinal e passa. Depois que ela encheu uma vez, janela curta de novo REPROVA, e dia aceito so pelo
//     sinal tambem;
//   · os dias reais do mes sao julgados com a mesma funcao do gerador (GL.julgaDias), e a decisao de cada um e impressa.
const https = require('https'), zlib = require('zlib');
const GL = require('./lib-guarda-liquida.js');
const BASE = process.env.BASE_DADOS ? null : 'https://rbenergydata.blob.core.windows.net/dados/';
const PT = { 6368: 'M1', 6369: 'M2', 6373: 'M3', 6374: 'M4', 6375: 'M5', 6376: 'M6', 6215: 'M7', 6378: 'M8', 6219: 'M9' };

const pega = (nome) => {
  if (!BASE) return Promise.resolve(JSON.parse(require('fs').readFileSync(require('path').join(process.env.BASE_DADOS, nome), 'utf8').replace(/^﻿/, '')));
  return new Promise((s, f) => https.get(BASE + nome, { family: 4 }, (r) => {
    const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => {
      if (r.statusCode !== 200) return f(new Error(String(r.statusCode)));
      let x = Buffer.concat(b); if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
      try { s(JSON.parse(x.toString('utf8').replace(/^﻿/, ''))); } catch (e) { f(e); } }); }).on('error', f));
};
const porDia = (j) => { const o = {};
  (j.dados || []).forEach((d) => { const u = PT[d.pontoId]; if (!u) return;
    (d.valores || []).forEach((v) => { if (v.valor == null) return;
      (o[String(v.data).slice(0, 10)] = o[String(v.data).slice(0, 10)] || {})[u] = v.valor / 1000; }); });
  return o; };
const soma = (o) => o ? Object.values(o).reduce((a, b) => a + b, 0) : 0;

(async () => {
  const falhas = [];
  let G;
  try { G = await pega('guarda_liquida.json'); }
  catch (e) { console.log('🔴 guarda_liquida.json ausente ou ilegivel (' + e.message + '): o gerador nao gravou a janela'); process.exit(1); }
  /* o dia de referencia e o da GRAVACAO (BRT), nao o relogio do ensaio: rodado depois da meia-noite, o corte da janela
     andaria um dia e a mediana refeita divergiria do certo */
  const hoje = new Date(new Date(G.gerado_em).getTime() - 3 * 3600e3).toISOString().slice(0, 10);
  if (!GL.formatoValido(G.residuos)) { console.log('🔴 guarda_liquida.json com formato estranho'); process.exit(1); }
  const fora = G.residuos.filter((g) => GL.guardadosValidos([g], [], hoje).length === 0);
  if (fora.length) falhas.push('a janela guarda ' + fora.length + ' residuo(s) que nao valem (fora da janela ou acima de metade do contador): ' + fora.map((g) => g.dia + ' ' + g.res_mwh).join(', '));
  /* referencia independente da peneira de 0,5: cada residuo guardado tem de caber no teto que os OUTROS dias da janela
     dao (um dia 45 % liquidado passa na peneira, mas nao cabe em 3x a mediana do consumo auxiliar) */
  const acima = G.residuos.filter((g) => { const t = GL.teto([], G.residuos, hoje, g.dia).teto; return t != null && g.res_mwh > t; });
  if (acima.length) falhas.push('a janela guarda residuo acima do teto dos outros dias (dia meio liquidado?): ' + acima.map((g) => g.dia + ' ' + g.res_mwh + ' MWh').join(', '));
  const T = GL.teto([], G.residuos, hoje, null);
  const mdRef = T.mediana == null ? null : Math.round(T.mediana * 100) / 100;
  if (mdRef !== G.mediana_mwh) falhas.push('mediana publicada ' + G.mediana_mwh + ' contra ' + mdRef + ' refeita pela lib');
  if (G.dias !== G.residuos.length) falhas.push('dias publicado ' + G.dias + ' contra ' + G.residuos.length + ' residuos');
  console.log('janela publicada: ' + G.residuos.length + ' dia(s) · mediana ' + G.mediana_mwh + ' MWh · teto ' + (T.teto == null ? 'NULO' : T.teto.toFixed(1) + ' MWh')
    + ' · cheia desde ' + (G.janela_cheia_desde || '(ainda nao)'));

  /* os dias reais do mes, julgados pela mesma funcao do gerador */
  const L = porDia(await pega('way2_energia_mes.json')), R = porDia(await pega('way2_eneat_diario.json'));
  const dias = Object.keys(L).sort().map((d) => ({ dia: d, parcial: d >= hoje, liq: L[d], rec: soma(R[d]) }));
  const J = GL.julgaDias(dias, G.residuos, hoje);
  J.decisoes.forEach((d) => console.log('  ' + d.dia + ' · ' + (d.aceito ? 'aceito' : 'recusado') + ' · ' + d.motivo
    + (d.teto != null ? ' (teto ' + d.teto.toFixed(1) + ' MWh, residuo ' + (d.rec - d.tot).toFixed(1) + ')' : '')));
  const soSinal = J.decisoes.filter((d) => d.aceito && d.so_sinal);
  if (G.janela_cheia_desde) {
    if (G.residuos.length < GL.MIN_DIAS) falhas.push('a janela encheu em ' + G.janela_cheia_desde + ' e voltou a ' + G.residuos.length + ' dia(s): a guarda caiu no sinal');
    if (soSinal.length) falhas.push(soSinal.length + ' dia(s) aceito(s) SO PELO SINAL depois de a janela ter enchido: ' + soSinal.map((d) => d.dia).join(', '));
  } else if (soSinal.length > GL.MIN_DIAS) {
    /* a PARTIDA tem prazo derivado da regra: com MIN_DIAS + 1 dias completos no mes, todo dia tem MIN_DIAS outros e ganha
       teto; mais de MIN_DIAS dias aceitos so pelo sinal nao acontece numa partida normal (contador ausente, peneira
       recusando tudo, ou o blob apagado no meio do mes). Isso tambem limita a volta da partida depois de um 404. */
    falhas.push('partida sem fim: ' + soSinal.length + ' dia(s) aceito(s) so pelo sinal, mais que os ' + GL.MIN_DIAS + ' que a partida admite: ' + soSinal.map((d) => d.dia).join(', '));
  } else {
    console.log('⚠️ PARTIDA: a janela ainda nao teve ' + GL.MIN_DIAS + ' dias; ' + soSinal.length + ' dia(s) aceito(s) so pelo sinal (um dia meio liquidado passaria). Declarado, nao reprova.');
  }
  if (falhas.length) { console.log('\n🔴 ' + falhas.join('\n🔴 ')); process.exit(1); }
  console.log('\n✅ ensaio-liquidada-produto: janela e decisoes coerentes com a lib');
})().catch((e) => { console.log('ERRO ' + e.message); process.exit(1); });
