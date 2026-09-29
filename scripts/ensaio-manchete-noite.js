/*
 * ensaio-manchete-noite.js — a energia do mes na manchete nunca conta um dia duas vezes (PROMOVER manchete-noite).
 *
 * POR QUE EXISTE. A ancora `liq_fechada_*` da rodada completa desconta o dia de hoje so enquanto ele RENDE
 * (`parcial && !encerrado`). Depois do por do sol o dia e "encerrado" e a ancora ja o contem; o remendo de 5 min somava
 * ancora + hoje e contava o dia de novo. Em 28/09/2026 a manchete do Complexo foi a 58.350,06 MWh com 56.563,30 medidos,
 * e o portal anunciou "meta ja batida" com 1.436,70 MWh por entregar. Nenhum ensaio pegou: o de origem roda logo depois da
 * rodada completa (quando a manchete ainda e a da rodada) e o do remendo forjava a ancora SEM o dia.
 *
 * DUAS PARTES, em dois pontos do workflow:
 *   --lib     · ANTES de gravar: de noite (ancora que ja contem o dia) e de dia (ancora sem o dia), com a soma dos dias do
 *               mes, o remendo publica a soma; e o caminho antigo, sem a soma, reprova no caso da noite (o plantio). Julga a
 *               REGRA em linhas forjadas, entao roda antes do gerador: lib quebrada nao chega a gravar.
 *   --produto · DEPOIS de gravar: no blob publicado, em cada entidade do mes em curso com todos os dias na serie, `liq_mwh`
 *               da manchete e a soma de `liq_mwh` da serie diaria, com a folga do arredondamento; e o mesmo produto com um
 *               dia inteiro somado de novo na manchete reprova, entidade por entidade.
 *   sem argumento, as duas (uso local).
 *
 * Sem segredo nenhum: le so blob publico (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const { remendaManchete } = require('./lib-manchete.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

// descompacta pelos BYTES (1f 8b), como o gerador, e nao pelo cabecalho da resposta
const deJson = b => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 120 s: ' + nome)));
    req.on('error', ko);
  });
}

const clone = o => JSON.parse(JSON.stringify(o));

// ---- LIB: linha sintetica com a forma da manchete ------------------------------------------------------
function linhaSintetica(ancoraMwh) {
  return { ufv: 'X', mes: '2026-09', fechado: 0, dias_total: 30, dias_decorridos: 28,
    meta_gwh: '1.20', meta_mwh: 1200, liq_proj: '1.25', liq_proj_mwh: 1250,
    liq_fechada_gwh: (ancoraMwh / 1000).toFixed(2), liq_fechada_mwh: ancoraMwh };
}
function remenda(ancoraMwh, hojeMwh, somaMwh) {
  const L = [linhaSintetica(ancoraMwh)];
  const arg = { mes: '2026-09', diaNum: 28, ate: '20:40', gwhPorUfv: { X: hojeMwh / 1000 } };
  if (somaMwh != null) arg.mwhMesPorUfv = { X: somaMwh };
  remendaManchete(L, arg);
  return L[0];
}
function julgaLib() {
  const f = [];
  // soma do mes 1.000 MWh, dos quais 100 sao de hoje
  const noite = remenda(1000, 100, 1000);   // ancora ja contem o dia (encerrado)
  const dia = remenda(900, 100, 1000);      // ancora sem o dia (rendendo)
  [['noite', noite], ['dia', dia]].forEach(([k, m]) => {
    if (Math.abs(Number(m.liq_mwh) - 1000) > 0.005) f.push('lib/' + k + ': liq_mwh ' + m.liq_mwh + ', a soma dos dias e 1000');
    if (Math.abs(Number(m.liq_gwh) - 1.00) > 0.005) f.push('lib/' + k + ': liq_gwh ' + m.liq_gwh + ', a soma dos dias e 1,00');
    if (Number(m.liq_proj_mwh) !== 1250) f.push('lib/' + k + ': a projecao andou (' + m.liq_proj_mwh + ')');
  });
  // PLANTIO: o caminho antigo (sem a soma) de noite conta o dia duas vezes — tem de ficar fora da folga
  const antigo = remenda(1000, 100, null);
  const plantio = Math.abs(Number(antigo.liq_mwh) - 1000) > 0.005;
  console.log('   lib: noite ' + noite.liq_mwh + ' · dia ' + dia.liq_mwh + ' · caminho antigo de noite ' + antigo.liq_mwh
    + (plantio ? ' (reprovado, como deve)' : ''));
  if (!plantio) f.push('lib: o caminho antigo de noite NAO reprova — o ensaio nao mede nada');
  return f;
}

// ---- PRODUTO: a manchete publicada contra a soma dos dias ------------------------------------------------
// cada dia e publicado com 2 casas (meio centesimo de erro por dia), a manchete tambem (mais meio centesimo), e 1e-6 cobre
// o ponto flutuante da soma
const folga = nd => 0.005 * nd + 0.005 + 1e-6;
function cobertura(exec, ufv) {
  const mes = exec.mes_atual;
  const dias = (exec.serie_dia_ufv || []).filter(x => x.ufv === ufv && x.dia.slice(0, 7) === mes && x.liq_mwh != null);
  const nd = new Set(dias.map(x => x.dia)).size, ultimo = dias.reduce((a, x) => (x.dia > a ? x.dia : a), '');
  return { dias, nd, ultimo, completa: !!ultimo && nd === +ultimo.slice(8, 10) };
}
function julgaProduto(exec, fala) {
  const f = [], mes = exec.mes_atual, julgadas = [], pulo = [];
  (exec.manchete_ufv || []).filter(x => x.mes === mes && x.fechado === 0 && x.liq_mwh != null).forEach(m => {
    const c = cobertura(exec, m.ufv);
    // entidade com dia faltando: o remendo cai no caminho antigo (ancora + hoje), e o ensaio nao tem a soma para julgar.
    // Nao e silencio — sai nomeada; se TODAS faltarem, reprova (abaixo)
    if (!c.completa) { pulo.push(m.ufv + ' (' + c.nd + ' dias ate ' + (c.ultimo || '—') + ')'); return; }
    const soma = c.dias.reduce((s, x) => s + Number(x.liq_mwh), 0);
    julgadas.push(m.ufv);
    if (Math.abs(Number(m.liq_mwh) - soma) > folga(c.nd)) {
      f.push('produto/' + m.ufv + ': manchete ' + m.liq_mwh + ' MWh, soma dos ' + c.nd + ' dias ' + soma.toFixed(2)
        + ' (folga ' + folga(c.nd).toFixed(3) + ')');
    }
  });
  if (fala) {
    console.log('   produto ' + mes + ': ' + julgadas.length + ' entidades julgadas');
    if (pulo.length) console.log('   ⚠️ serie do mes com dia faltando, manchete NAO julgada (o remendo usa ancora + hoje nelas): ' + pulo.join(', '));
  }
  if (!julgadas.length) f.push('produto: nenhuma entidade julgada' + (pulo.length ? ' — serie com dia faltando em todas: ' + pulo.join(', ') : ''));
  return { f, julgadas };
}

async function produto() {
  const exec = await getJSON('executivo.json');
  // na virada do mes, ate a rodada completa criar a linha do mes novo, nao ha manchete em curso: nada a julgar, declarado
  if (!(exec.manchete_ufv || []).some(x => x.mes === exec.mes_atual && x.fechado === 0 && x.liq_mwh != null)) {
    console.log('   produto: a manchete ainda nao tem o mes ' + exec.mes_atual + ' em curso — nada a julgar nesta rodada');
    return [];
  }
  const { f, julgadas } = julgaProduto(exec, true);
  if (!julgadas.length) return f;
  // PLANTIO: um dia contado duas vezes em cada entidade JULGADA. O valor plantado nao depende do dia de hoje (de madrugada
  // a linha do dia e o consumo noturno, negativo): e o MAIOR dia do mes, e nunca menos que 10 vezes a folga
  const plant = clone(exec);
  julgadas.forEach(u => {
    const m = plant.manchete_ufv.find(x => x.ufv === u && x.mes === plant.mes_atual && x.fechado === 0);
    const c = cobertura(plant, u);
    const maior = Math.max.apply(null, c.dias.map(x => Math.abs(Number(x.liq_mwh))));
    m.liq_mwh = Math.round((Number(m.liq_mwh) + Math.max(maior, 10 * folga(c.nd))) * 100) / 100;
  });
  const fp = julgaProduto(plant, false).f.filter(x => /^produto\//.test(x));
  const reprovadas = new Set(fp.map(x => x.split(':')[0].slice(8)));
  const escaparam = julgadas.filter(u => !reprovadas.has(u));
  console.log('   plantio no produto (um dia a mais em ' + julgadas.length + ' entidades): ' + reprovadas.size + ' reprovada(s)');
  if (escaparam.length) f.push('produto: o plantio do dia contado duas vezes NAO reprova em ' + escaparam.join(', '));
  return f;
}

(async () => {
  const so = process.argv.includes('--lib') ? 'lib' : process.argv.includes('--produto') ? 'produto' : 'ambos';
  const f = [];
  if (so !== 'produto') f.push(...julgaLib());
  if (so !== 'lib') f.push(...await produto());
  if (f.length) { f.forEach(x => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-manchete-noite' + (so === 'ambos' ? '' : ' --' + so) + ': TUDO PASSOU');
})().catch(e => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
