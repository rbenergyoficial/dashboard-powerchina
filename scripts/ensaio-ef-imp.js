/*
 * ensaio-ef-imp.js — prova o `ef_imp`: quanto da eficiencia do dia vem de instantes com CA > CC.
 *
 * O DEFEITO QUE ELE DOCUMENTA. A eficiencia do inversor e sum(CA)/sum(CC) sobre amostras
 * INSTANTANEAS de 30 min, e as duas leituras NAO sao simultaneas. Num ceu que muda, uma pega um
 * momento e a outra outro: em 12/09 o M1/TS1/INV01 marcou CC 117 kW e CA 180 kW no MESMO carimbo
 * (153%), e esse instante levou o dia a 102,91%. Medido em 17/09/2026: 1,34% dos dias-inversor
 * passam de 100%, espalhados por 553 inversores e concentrados em DIAS — nao e sensor.
 *
 * O gerador NAO corta nada do `ef` (o ruido e simetrico: tirar so a cauda de cima vicia o numero
 * para baixo). Ele PUBLICA o tamanho da contaminacao, e o painel marca o dia pelo criterio
 * FISICO — eficiencia acima de 100% nao existe.
 *
 * O que este ensaio exige, sobre os blobs PUBLICOS (sem segredo nenhum):
 *   A · os dias recalculados trazem `ef_imp` e `ef_imp_n` (senao o resto nao julga nada)
 *   B · FISICA · todo dia com `ef` acima de 100% tem `ef_imp` positivo — soma de CA maior que
 *       soma de CC exige ao menos um instante impossivel acima do piso
 *   C · DUAS ROTAS · o `ef_imp` do dia bate, inversor a inversor, com o recalculado da curva de
 *       30 min do mesmo inversor no mesmo dia (tolerancia derivada do arredondamento da curva)
 *   D · NEGATIVA · o recalculo da rota C respeita o piso (instante plantado abaixo dele fica fora),
 *       e um defeito plantado (`ef_imp` zerado num dia acima de 100%) e acusado pela regra B
 *
 * uso: node ensaio-ef-imp.js [ufv]   ·   LOCAL_DIR=<pasta> julga os .json de um ensaio local
 */
'use strict';
const https = require('https');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const UFV = (process.argv[2] || 'M3').toUpperCase();
/* o MESMO piso do gerador, lido dele — reescrever o numero aqui provaria so que a copia concorda */
const PISO_KW = (() => {
  const m = fs.readFileSync(path.join(__dirname, 'gen-perdas.js'), 'utf8').match(/const EF_IMP_PISO_KW = ([\d.]+);/);
  if (!m) throw new Error('o gerador nao declara mais EF_IMP_PISO_KW');
  return Number(m[1]);
})();

let mau = 0;
const falha = (m) => { mau += 1; console.log('  🔴 ' + m); };
const ok = (c, m) => { if (!c) falha(m); else console.log('  ok  ' + m); };

const le = (nome) => new Promise((res, rej) => {
  if (process.env.LOCAL_DIR) {
    let b = fs.readFileSync(path.join(process.env.LOCAL_DIR, nome));
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    res(JSON.parse(b.toString('utf8'))); return;
  }
  https.get(BASE + nome, { family: 4 }, (r) => {
    if (r.statusCode !== 200) { r.resume(); rej(new Error(nome + ': HTTP ' + r.statusCode)); return; }
    const c = [];
    r.on('data', (d) => c.push(d));
    r.on('end', () => {
      try {
        let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        res(JSON.parse(b.toString('utf8')));
      } catch (e) { rej(e); }
    });
  }).on('error', rej);
});

/* a regra B, isolada para poder ser exercitada contra um defeito plantado */
const violaFisica = (s) => s.filter((l) => l.ef > 1 && 'ef_imp' in l && !(l.ef_imp > 0));

/* o recalculo pela curva: pcc/pca em kW, arredondados a 2 casas pelo gerador */
function daCurva(c, piso) {
  let scc = 0, ex = 0, n = 0;
  for (let i = 0; i < c.h.length; i++) {
    const cc = c.pcc[i], ca = c.pca[i];
    if (cc == null || ca == null) continue;
    scc += cc;
    if (ca > cc && ca >= piso) { ex += ca - cc; n += 1; }   // o piso vale sobre o lado ALTO, como no gerador
  }
  return { f: scc > 0 ? ex / scc : 0, n };
}

(async () => {
  const j = await le('perdas_inv.json');
  const s = Array.isArray(j.serie) ? j.serie : [];
  const com = s.filter((l) => 'ef_imp' in l);
  console.log('perdas_inv · ' + s.length + ' linhas · ' + com.length + ' com ef_imp · piso ' + PISO_KW + ' kW');

  console.log('\nA · os dias recalculados trazem a grandeza');
  ok(com.length >= 1000, com.length + ' inversor-dia(s) com ef_imp (minimo 1000, senao nada abaixo julga)');
  ok(com.every((l) => typeof l.ef_imp === 'number' && Number.isInteger(l.ef_imp_n) && l.ef_imp >= 0),
    'ef_imp e numero >= 0 e ef_imp_n e inteiro em todas');
  const pos = com.filter((l) => l.ef_imp > 0);
  console.log('      ' + pos.length + ' com ef_imp > 0 (' + ((100 * pos.length) / Math.max(1, com.length)).toFixed(1) + '%)');

  console.log('\nB · FISICA · ef acima de 100% exige instante impossivel acima do piso');
  {
    const acima = com.filter((l) => l.ef > 1);
    const v = violaFisica(com);
    console.log('      ' + acima.length + ' dia(s) com ef > 100% entre os recalculados');
    ok(!v.length, v.length + ' dia(s) acima de 100% sem ef_imp positivo'
      + (v.length ? ' (ex.: ' + v[0].dia + ' ' + v[0].ufv + '/' + v[0].ts + '/' + v[0].inv + ')' : ''));
  }

  console.log('\nC · DUAS ROTAS · o dia contra a curva de 30 min (' + UFV + ')');
  const h = await le('pvstr_hora_' + UFV + '.json');
  const idx = new Map(com.filter((l) => l.ufv === UFV).map((l) => [l.dia + '|' + l.ts + '|' + l.inv, l]));
  let pares = 0, pior = 0, onde = '', semPiso = 0;
  for (const c of (h.serie || [])) {
    const l = idx.get(c.d + '|' + c.ts + '|' + c.inv);
    if (!l) continue;
    const r = daCurva(c, PISO_KW);
    /* tolerancia DERIVADA: cada pcc/pca carrega ate 0,005 kW de arredondamento, a fracao publicada
       4 casas (0,00005); nas pontas a curva corta instantes de CC < piso que o dia soma — pequenos */
    const scc = c.pcc.reduce((a, x) => a + (x || 0), 0);
    const tol = 0.00006 + (c.h.length * 0.01) / Math.max(scc, 1);
    const d = Math.abs(r.f - l.ef_imp);
    pares += 1;
    if (d - tol > pior) { pior = d - tol; onde = c.d + ' ' + c.ts + '/' + c.inv + ' dia ' + l.ef_imp + ' curva ' + r.f.toFixed(5); }
    if (Math.abs(daCurva(c, 0).f - r.f) > tol) semPiso += 1;
  }
  ok(pares >= 500, pares + ' par(es) dia x curva (minimo 500)');
  ok(pior <= 0, 'nenhum par fora da tolerancia' + (onde ? ' — pior: ' + onde : ''));

  console.log('\nD · NEGATIVA');
  /* ⚠️ o piso quase nunca morde NA CURVA: ela so guarda a janela com geracao, onde os dois lados
     raramente ficam juntos abaixo de 1 kW. Exigir que ele mude algum dia aqui reprovaria por falta
     do caso no mundo, nao por defeito — entao o numero vai INFORMADO, e o que se prova e que o
     recalculo desta rota respeita o piso. (Os 21 instantes de CC < 1 kW com CA > CC medidos em
     17/09 NAO eram todos offset: 7 eram queda de leitura do CC com CA de 12 a 123 kW — 24/09.) */
  console.log('      sem o piso, ' + semPiso + ' dia(s) mudariam na curva (informativo)');
  {
    const c = { h: ['05:30', '12:00'], pcc: [0.3, 200], pca: [0.8, 196] };
    ok(daCurva(c, PISO_KW).n === 0 && daCurva(c, 0).n === 1,
      'um instante plantado com os DOIS lados abaixo do piso (CC 0,3 kW, CA 0,8 kW) fica FORA com o piso e dentro sem ele');
  }
  {
    /* 🔴 o caso que o piso no CC deixava passar: queda de leitura do CC com o CA em plena geracao
       (medido em 21/09/2026 14:30, CC 0,03 kW e CA 122 kW, em quatro usinas no mesmo instante) */
    const c = { h: ['14:00', '14:30'], pcc: [120, 0.03], pca: [117, 122] };
    ok(daCurva(c, PISO_KW).n === 1, 'uma queda de leitura do CC (CC 0,03 kW, CA 122 kW) CONTA como instante impossivel');
  }
  {
    const alvo = com.find((l) => l.ef > 1) || { ef: 1.02, ef_imp: 0.03, ef_imp_n: 1 };
    const plantado = [Object.assign({}, alvo, { ef_imp: 0, ef_imp_n: 0 })];
    ok(violaFisica(plantado).length === 1, 'ef_imp zerado num dia acima de 100% e ACUSADO pela regra B');
  }

  console.log('');
  if (mau) { console.log('🔴 ENSAIO REPROVOU em ' + mau + ' ponto(s).'); process.exit(1); }
  console.log('ensaio do ef_imp: passou.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
