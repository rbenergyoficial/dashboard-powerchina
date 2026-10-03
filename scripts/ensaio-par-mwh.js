'use strict';
/*
 * ensaio-par-mwh.js — o par GWh × MWh do executivo, sobre o PRODUTO publicado (PROMOVER mwh-gerador, 25/09/2026).
 *
 * A regra mora em lib-par-mwh.js e roda DENTRO do gerador, antes de gravar. Este ensaio e a segunda rota: le o blob
 * que subiu (o que o portal de fato le) e aplica a mesma conferencia — pega defeito de EMISSAO, nao de conta.
 *
 * PRODUTO · o executivo publicado passa na conferencia, e publica os campos em MWh (sem eles nao julgaria nada).
 * PLANTIO · cada defeito tem de reprovar COM A MENSAGEM DELE (contar achados a mais nao prova que o certo mordeu):
 *   1 · o corte das usinas DERIVADO do GWh (x 1000) — a soma deixa de fechar com o conjunto na casa do MWh;
 *   2 · uma usina com o corte inflado em 1 MWh;
 *   3 · o resto nulo de um lado so;
 *   4 · uma razao do mes sem o campo em MWh;
 *   5 · razoes, origens e frustrada DERIVADAS do GWh x 1000 — o par fecha com desvio zero, so a resolucao denuncia;
 *   6 · erro COMPENSADO entre duas usinas que nao levam a sobra (+0,04 e -0,04 MWh): a soma fecha, a proporcao nao;
 *   7 · o acumulado anual some do produto: a vacuidade tem de reprovar.
 * NEGATIVA · um resto que sai do CRU com 0,015 MWh de desvio (cadeia legitima de quatro arredondamentos) NAO pode
 *   reprovar: folga apertada demais deixa o executivo vermelho e sem gravar sem defeito no dado.
 * VACUIDADE · o produto tem de ter o que julgar: corte em MWh no serie_ufv, acumulado anual com corte em MWh e
 *   grupos PPA/ML com corte em MWh (revisao de 26/09/2026, achados RE-001 a RE-004 do revisor de ensaio).
 *
 *   node scripts/ensaio-par-mwh.js        (BASE_DADOS=<pasta> le uma rodada local; sem ela, o blob publico)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { conferePares } = require('./lib-par-mwh.js');

const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
function parse(buf) { return JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8')); }
function le(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(parse(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((res, rej) => https.get(BASE + nome, { headers: { 'Accept-Encoding': 'gzip' } }, (s) => {
    if (s.statusCode !== 200) return rej(new Error(nome + ': HTTP ' + s.statusCode));
    const b = []; s.on('data', (c) => b.push(c)); s.on('end', () => { try { res(parse(Buffer.concat(b))); } catch (e) { rej(e); } });
  }).on('error', rej));
}
const copia = (o) => JSON.parse(JSON.stringify(o));

// o que o produto tem de trazer para a conferencia julgar alguma coisa; lista vazia aqui passaria calada
function vacuidade(X) {
  const S = X.serie_ufv || [], v = [];
  if (!S.some(x => x.cortado_mwh != null)) v.push('VACUO: nenhuma linha do serie_ufv com cortado_mwh');
  if (!(X.ytd_ufv || []).some(y => y.cortado_mwh != null)) v.push('VACUO: nenhum acumulado anual (ytd_ufv) com cortado_mwh');
  if (!S.some(x => ['PPA', 'ML'].includes(x.ufv) && x.cortado_mwh != null && !x.corte_estimado)) v.push('VACUO: nenhum grupo PPA/ML com corte em MWh para julgar');
  return v;
}
const julga = (X) => conferePares(X).concat(vacuidade(X));

(async () => {
  const falhas = [];
  const X = await le('executivo.json');
  const S = X.serie_ufv || [];
  const comM = S.filter(x => x.cortado_mwh != null).length;
  const base = julga(X);
  base.slice(0, 10).forEach(m => falhas.push('PRODUTO: ' + m));
  console.log('  produto: ' + S.length + ' linhas do serie_ufv, ' + comM + ' com corte em MWh, '
    + (X.ytd_ufv || []).filter(y => y.cortado_mwh != null).length + ' acumulados · ' + (base.length ? base.length + ' achado(s)' : 'fecha'));

  // um mes reconciliado inteiro, para os plantios que dependem da soma das usinas
  const US = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
  const mesR = [...new Set(S.map(x => x.mes))].reverse().find(m => US.every(u => { const r = S.find(x => x.ufv === u && x.mes === m);
    return r && r.corte_reconciliado === 1 && r.cortado_mwh != null && r.cortado_bruto_mwh != null; }));
  if (!mesR) falhas.push('nenhum mes com as nove usinas reconciliadas — os plantios 1 e 2 nao teriam onde morder');
  // o plantio so vale se: (1) mudou mesmo o produto; (2) apareceu achado NOVO; (3) um deles e o do defeito plantado
  const plantio = (nome, muda, esperado) => {
    const Y = copia(X); const ok = muda(Y);
    if (!ok) { falhas.push('plantio "' + nome + '" nao achou onde plantar'); return; }
    if (JSON.stringify(Y) === JSON.stringify(X)) { falhas.push('plantio "' + nome + '" nao mudou nada — nao foi plantado'); return; }
    const novos = julga(Y).filter(m => !base.includes(m));
    if (!novos.length) falhas.push('plantio "' + nome + '" NAO reprovou — a conferencia nao mede isso');
    else if (!novos.some(m => esperado.test(m))) falhas.push('plantio "' + nome + '" reprovou pelo motivo errado: ' + novos[0]);
    else console.log('  plantio "' + nome + '": reprovou (' + novos.length + ' achado' + (novos.length > 1 ? 's' : '') + ') · ' + novos.find(m => esperado.test(m)).slice(0, 90));
  };
  // a negativa: a mudanca e legitima, e nada novo pode aparecer
  const negativa = (nome, muda) => {
    const Y = copia(X); const ok = muda(Y);
    if (!ok) { falhas.push('negativa "' + nome + '" nao achou onde aplicar'); return; }
    if (JSON.stringify(Y) === JSON.stringify(X)) { falhas.push('negativa "' + nome + '" nao mudou nada — nao julgou'); return; }
    const novos = julga(Y).filter(m => !base.includes(m));
    if (novos.length) falhas.push('negativa "' + nome + '" REPROVOU o que e legitimo: ' + novos[0]);
    else console.log('  negativa "' + nome + '": passou, como deve');
  };
  if (mesR) {
    plantio('corte das usinas derivado do GWh', Y => { let n = 0; Y.serie_ufv.forEach(x => { if (x.mes === mesR && US.includes(x.ufv)) { x.cortado_mwh = Math.round(x.cortado_gwh * 1e5) / 100; n++; } }); return n === 9; },
      /usinas somam|proporcao|resto/);
    plantio('usina com o corte inflado', Y => { const x = Y.serie_ufv.find(q => q.mes === mesR && q.ufv === 'M5'); x.cortado_mwh += 1; return true; },
      /usinas somam|proporcao/);
    // duas usinas que NAO levam a sobra, com o resto refeito coerente: a soma do mes continua fechando
    plantio('erro compensado entre duas usinas', Y => {
      const us = Y.serie_ufv.filter(q => q.mes === mesR && US.includes(q.ufv) && q.cortado_bruto_mwh > 0).sort((a, b) => b.cortado_mwh - a.cortado_mwh);
      if (us.length < 3) return false;
      const [a, b] = [us[1], us[2]];
      a.cortado_mwh = Math.round((a.cortado_mwh + 0.04) * 100) / 100; b.cortado_mwh = Math.round((b.cortado_mwh - 0.04) * 100) / 100;
      [a, b].forEach(x => { x.outras_mwh = Math.round(Math.max(0, x.potencial_mwh - x.entregue_mwh - x.cortado_mwh) * 100) / 100; });
      return true;
    }, /proporcao/);
  }
  plantio('resto nulo de um lado so', Y => { const x = Y.serie_ufv.find(q => q.outras_mwh != null && q.outras_gwh != null); if (!x) return false; x.outras_mwh = null; return true; },
    /um lado nulo/);
  plantio('razao do mes sem MWh', Y => { const s = Y.serie.find(q => q.razoes && q.razoes.ENE); if (!s) return false; delete s.razoes.ENE.mwh; return true; },
    /razoes ENE/);
  plantio('razoes, origens e frustrada derivadas do GWh', Y => {
    let n = 0;
    Y.serie.forEach(s => {
      ['razoes', 'origens'].forEach(k => Object.values(s[k] || {}).forEach(o => { if (o.gwh != null) { o.mwh = Math.round(o.gwh * 1e5) / 100; n++; } }));
      if (s.frustrada_gwh != null) { s.frustrada_mwh = Math.round(s.frustrada_gwh * 1e5) / 100; n++; }
    });
    return n >= 10;
  }, /resolucao do GWh x 1000/);
  plantio('acumulado anual ausente', Y => { if (!(Y.ytd_ufv || []).length) return false; delete Y.ytd_ufv; return true; },
    /VACUO: nenhum acumulado/);
  // um resto do CRU com 0,015 MWh de desvio e a cadeia legitima (quatro arredondamentos): nao pode reprovar
  negativa('resto do cru com desvio legitimo de 0,015 MWh', Y => {
    const x = Y.serie_ufv.find(q => US.includes(q.ufv) && q.cortado_bruto_mwh == null && q.outras_mwh > 1
      && q.potencial_mwh != null && q.entregue_mwh != null && q.cortado_mwh != null);
    if (!x) return false;
    x.outras_mwh = Math.round((Math.max(0, x.potencial_mwh - x.entregue_mwh - x.cortado_mwh) + 0.015) * 1000) / 1000;
    return true;
  });

  if (falhas.length) { console.log(falhas.map(f => '  RECUSA: ' + f).join('\n')); process.exit(1); }
  console.log('ensaio-par-mwh: produto e plantios OK');
})().catch((e) => { console.error(e); process.exit(1); });
