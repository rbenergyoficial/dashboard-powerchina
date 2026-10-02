/*
 * ensaio-med-ufv.js — a cobertura da medição por usina e por contrato no diário Way2 (PROMOVER med-entidade).
 *
 * POR QUE EXISTE. O diário passou a publicar `ufv_slots` (registros de 5 min em que TODOS os circuitos da usina têm valor;
 * no contrato, todos os circuitos de todas as suas usinas no mesmo registro) e `ufv_completo`. É o que o cartão "Medição
 * no período" mostra quando o filtro está numa usina. Contagem errada não quebra tela: diz que o dia da usina estava
 * completo quando faltava medidor, e esconde o furo que explicaria uma energia baixa. A cobertura por usina DIFERE da do
 * conjunto e entre usinas (medido: 18/07/2026 M4 278 contra 284 nas outras; 27/07/2026 M5 166).
 *
 * O QUE PROVA:
 *   --lib      sobre dias SINTÉTICOS (rollupDia do arquivador):
 *              · cada usina com furos num horário SÓ dela e em quantidade só dela, no ÚLTIMO circuito (a usina conta o
 *                instante com todos os circuitos): qualquer troca de composição do PPA ou do ML muda a contagem;
 *              · o M1 exatamente no limiar (completo) e o M2 um abaixo (incompleto): limiar deslocado ou `>` no lugar de
 *                `>=` reprova; o conjunto, com o medidor 6233 no limiar e um abaixo, segue o MESMO critério;
 *              · o circuito do M7 inteiro ausente: M7 e ML zerados;
 *   --produto  no blob publicado:
 *              · TODO dia do diário tem o campo (cada dia tem o seu snapshot arquivado; o recálculo do histórico roda
 *                no lote — dia sem o campo depois disso é recálculo truncado);
 *              · inteiros de 0 a 288 nas 11 chaves; completo de cada chave = contagem >= limiar do arquivador; o limiar
 *                do arquivador fica entre o maior dia INCOMPLETO e o menor dia COMPLETO do conjunto (o critério que o
 *                diário já publicava); contrato <= a menor das suas usinas;
 *              · SEGUNDA ROTA: o snapshot de 5 min do dia mais recente recontado aqui, por código próprio, com os 22
 *                circuitos presentes no snapshot e alguma leitura: as 11 contagens iguais;
 *              · PLANTIOS sobre uma linha forjada (não dependem do formato do dia real): completo invertido, contrato
 *                acima da menor usina, contagem acima de 288, completo com limiar errado; e, sobre o dia real, uma
 *                usina com um registro a mais contra a recontagem.
 * Sem segredo: lê só blob público (ou BASE_DADOS=<pasta local>).
 */
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const { rollupDia, SLOTS_COMPLETO: L } = require('./gen-way2-hist.js');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
const deJson = (b) => JSON.parse((b[0] === 0x1f && b[1] === 0x8b ? zlib.gunzipSync(b) : b).toString('utf8').replace(/^﻿/, ''));
function getJSON(nome) {
  if (!/^https?:/.test(BASE)) return Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))));
  return new Promise((ok, ko) => {
    const req = https.get(BASE + nome, { headers: { 'accept-encoding': 'gzip' }, timeout: 180000 }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + nome)); }
      const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => { try { ok(deJson(Buffer.concat(c))); } catch (e) { ko(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('sem resposta em 180 s: ' + nome))); req.on('error', ko);
  });
}
const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
const GRUPOS = { PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
const CHAVES = Object.keys(CIRC).concat(Object.keys(GRUPOS));
const TODOS = [].concat(...Object.values(CIRC));

// a segunda rota: recontagem por código próprio, sobre o snapshot cru
function reconta(j) {
  const tem = {};
  for (const s of j.dados || []) if (s.nomeGrandeza === 'Demat') tem[s.pontoId] = new Set((s.valores || []).filter((v) => v.valor != null).map((v) => v.data));
  const faltam = TODOS.filter((p) => !tem[p]);
  const lidos = TODOS.reduce((a, p) => a + (tem[p] ? tem[p].size : 0), 0);
  const conta = (pids) => { const S = pids.map((p) => tem[p] || new Set()); return [...S[0]].filter((t) => S.every((x) => x.has(t))).length; };
  const o = {}; for (const u in CIRC) o[u] = conta(CIRC[u]);
  for (const g in GRUPOS) o[g] = conta([].concat(...GRUPOS[g].map((u) => CIRC[u])));
  return { o, faltam, lidos };
}

function julgaLinha(x) {
  const f = [], S = x.ufv_slots, C = x.ufv_completo;
  if (!S || !C) return [x.dia + ': sem ufv_slots/ufv_completo'];
  for (const k of CHAVES) {
    if (!Number.isInteger(S[k]) || S[k] < 0 || S[k] > 288) f.push(x.dia + ' ' + k + ': contagem ' + S[k]);
    if (C[k] !== (S[k] >= L)) f.push(x.dia + ' ' + k + ': ' + S[k] + ' registros com completo ' + C[k] + ' (limiar ' + L + ')');
  }
  if (x.slots != null && x.completo !== (x.slots >= L)) f.push(x.dia + ' conjunto: ' + x.slots + ' registros com completo ' + x.completo + ' (limiar ' + L + ')');
  for (const [g, mb] of Object.entries(GRUPOS)) { const mn = Math.min(...mb.map((u) => S[u]));
    if (S[g] > mn) f.push(x.dia + ' ' + g + ': ' + S[g] + ' registros, acima da menor usina (' + mn + ')'); }
  return f;
}

// ---------------------------------------------------------------- --lib
const grade = []; for (let i = 0; i < 288; i++) grade.push('2026-01-01T' + String(Math.floor(i / 12)).padStart(2, '0') + ':' + String(5 * (i % 12)).padStart(2, '0') + ':00');
function sintetico({ furos, semCirc = [], conj = 288 }) {
  const dados = [];
  for (const p of [6196, 6197, 6233].concat(TODOS)) {
    if (semCirc.includes(p)) continue;
    const fura = furos[p] || new Set();
    dados.push({ pontoId: p, nomeGrandeza: 'Demat', valores: grade.map((t, i) => ({ data: t, valor: (p === 6233 ? i >= conj : fura.has(i)) ? null : 1000 })) });
  }
  return { dados };
}
// o criterio de dia completo da casa (~24 h dos 288 registros): mudar a constante do arquivador muda a definicao do
// conjunto E das usinas juntos, e depois do recalculo a faixa do diario passaria por construcao. Mudanca deliberada
// troca os dois lados no mesmo lote.
const LIMIAR_CASA = 280;
function lib() {
  const f = [];
  if (L !== LIMIAR_CASA) f.push('SLOTS_COMPLETO do arquivador = ' + L + ', criterio da casa = ' + LIMIAR_CASA + ': mudanca de definicao fora deste ensaio');
  // furos: quantidade só da usina, em horários só dela, no ÚLTIMO circuito
  const qtd = { M1: 288 - L, M2: 288 - L + 1, M3: 1, M4: 2, M5: 3, M6: 4, M7: 5, M8: 6, M9: 7 };
  const furos = {}; let ini = 0;
  for (const u in CIRC) { const s = new Set(); for (let i = 0; i < qtd[u]; i++) s.add(ini + i); ini += qtd[u]; furos[CIRC[u][CIRC[u].length - 1]] = s; }
  if (ini > 288) return ['sintetico: furos demais para a grade (' + ini + ')'];
  const esp = {}; for (const u in CIRC) esp[u] = 288 - qtd[u];
  for (const [g, mb] of Object.entries(GRUPOS)) esp[g] = 288 - mb.reduce((a, u) => a + qtd[u], 0);
  const x = rollupDia(sintetico({ furos, conj: L }), '2026-01-01');
  const S = x.ufv_slots || {}, C = x.ufv_completo || {};
  for (const k of CHAVES) {
    if (S[k] !== esp[k]) f.push('sintetico ' + k + ': ' + S[k] + ' (esperava ' + esp[k] + ')');
    if (C[k] !== (esp[k] >= L)) f.push('sintetico completo ' + k + ': ' + C[k] + ' com ' + esp[k] + ' registros (limiar ' + L + ')');
  }
  if (C.M1 !== true || C.M2 !== false) f.push('sintetico no limiar: M1 (' + S.M1 + ') ' + C.M1 + ', M2 (' + S.M2 + ') ' + C.M2 + ' (esperava true e false)');
  if (x.slots !== L || x.completo !== true) f.push('conjunto no limiar: ' + x.slots + ' registros, completo ' + x.completo);
  const x1 = rollupDia(sintetico({ furos, conj: L - 1 }), '2026-01-01');
  if (x1.completo !== false) f.push('conjunto um abaixo do limiar: completo ' + x1.completo);
  const rc = reconta(sintetico({ furos, conj: L })).o;
  for (const k of CHAVES) if (rc[k] !== S[k]) f.push('segunda rota no sintetico ' + k + ': ' + rc[k] + ' contra ' + S[k]);
  const x2 = rollupDia(sintetico({ furos: {}, semCirc: [6215] }), '2026-01-01');
  if (x2.ufv_slots.M7 !== 0 || x2.ufv_slots.ML !== 0 || x2.ufv_slots.M9 !== 288) f.push('circuito do M7 ausente: ' + JSON.stringify(x2.ufv_slots));
  f.push(...julgaLinha(Object.assign({ dia: 'sintetico' }, x)));
  console.log('   limiar ' + L + ' · sintetico: ' + JSON.stringify(S));
  return f;
}

// ---------------------------------------------------------------- --produto
async function produto() {
  const f = [];
  const D = (await getJSON('way2_daily.json')).dias || [];
  if (!D.length) return ['diario vazio'];
  const sem = D.filter((x) => !x.ufv_slots);
  if (sem.length) f.push(sem.length + ' de ' + D.length + ' dias sem ufv_slots (' + sem.slice(0, 3).map((x) => x.dia).join(', ') + '…): recalculo do historico truncado ou nao rodado');
  for (const x of D.filter((y) => y.ufv_slots)) f.push(...julgaLinha(x));
  // o limiar do arquivador contra o criterio que o conjunto ja publicava
  const inc = D.filter((x) => x.completo === false && x.slots > 0).map((x) => x.slots), com = D.filter((x) => x.completo === true).map((x) => x.slots);
  const lo = inc.length ? Math.max(...inc) : -1, hi = com.length ? Math.min(...com) : 289;
  if (!(lo < L && L <= hi)) f.push('limiar ' + L + ' fora do criterio do conjunto publicado (maior incompleto ' + lo + ', menor completo ' + hi + ')');
  // segunda rota no dia mais recente
  const ult = D[D.length - 1];
  const ontem = new Date(Date.now() - 3 * 3600 * 1000 - 86400 * 1000).toISOString().slice(0, 10);
  if (ult.dia < ontem) console.log('   ⚠️ o dia mais recente do diario (' + ult.dia + ') e anterior a ontem (' + ontem + '): o arquivamento de ontem nao entrou');
  const { o: rc, faltam, lidos } = reconta(await getJSON('hist/way2_' + ult.dia + '.json'));
  if (faltam.length) f.push(ult.dia + ': snapshot sem a serie Demat de ' + faltam.length + ' circuito(s): ' + faltam.join(','));
  if (!lidos) f.push(ult.dia + ': snapshot sem nenhuma leitura nos circuitos — a recontagem nao julgou nada');
  // dia completo no medidor do conjunto com TODAS as usinas zeradas nas duas rotas: formato do snapshot mudou (nome da
  // grandeza, pontoId), e as duas contagens concordariam em zero sem ter lido nada
  if (ult.completo && CHAVES.every((k) => rc[k] === 0)) f.push(ult.dia + ': conjunto completo (' + ult.slots + ' registros) e todas as usinas com zero na recontagem');
  if (ult.ufv_slots) for (const k of CHAVES) if (rc[k] !== ult.ufv_slots[k]) f.push(ult.dia + ' ' + k + ': publicado ' + ult.ufv_slots[k] + ', recontado no snapshot ' + rc[k]);
  console.log('   ' + (D.length - sem.length) + ' de ' + D.length + ' dias com cobertura por usina · limiar ' + L + ' (conjunto: maior incompleto ' + lo + ', menor completo ' + hi + ')');
  console.log('   ' + ult.dia + ' · ' + lidos + ' leituras de circuito · publicado ' + JSON.stringify(ult.ufv_slots) + ' · recontado ' + JSON.stringify(rc));
  const dif = D.filter((x) => x.ufv_slots && CHAVES.some((k) => x.ufv_slots[k] !== x.slots));
  console.log('   dias com alguma usina ou contrato diferente do conjunto: ' + dif.length + (dif.length ? ' (ex.: ' + dif.slice(-3).map((x) => x.dia + ' ' + CHAVES.filter((k) => x.ufv_slots[k] !== x.slots).map((k) => k + '=' + x.ufv_slots[k]).slice(0, 3).join(' ')).join(' · ') + ')' : ''));
  // plantios sobre uma linha forjada: a assinatura do defeito existe sempre
  const limpa = () => { const S = {}, C = {}; CHAVES.forEach((k) => { S[k] = 288; C[k] = true; }); return { dia: 'forjada', slots: 288, completo: true, ufv_slots: S, ufv_completo: C }; };
  if (julgaLinha(limpa()).length) f.push('a linha forjada limpa reprova: ' + julgaLinha(limpa()).join('; '));
  const planta = (nome, fn, espera) => { const P = limpa(); fn(P); const nv = julgaLinha(P);
    const ok = nv.some((x) => x.indexOf(espera) >= 0);
    console.log('   plantio (' + nome + '): ' + nv.length + ' achado(s)' + (ok ? '' : ' — NENHUM com "' + espera + '"'));
    if (!ok) f.push('plantio "' + nome + '" nao reprova pelo que plantou'); };
  planta('completo invertido', (P) => { P.ufv_completo.M5 = false; }, 'M5: 288 registros com completo false');
  planta('contrato acima da menor usina', (P) => { P.ufv_slots.M4 = 200; P.ufv_completo.M4 = false; }, 'PPA: 288 registros, acima da menor usina');
  planta('contagem acima de 288', (P) => { P.ufv_slots.M9 = 289; }, 'M9: contagem 289');
  planta('completo com limiar errado', (P) => { P.ufv_slots.M3 = L - 1; P.ufv_slots.PPA = L - 1; P.ufv_completo.PPA = false; }, 'M3: ' + (L - 1) + ' registros com completo true');
  if (ult.ufv_slots) {   // contra a recontagem, no dia real
    const P = JSON.parse(JSON.stringify(ult)); P.ufv_slots.M3 += 1;
    const ok = rc.M3 !== P.ufv_slots.M3;
    console.log('   plantio (M3 com um registro a mais contra a recontagem): ' + (ok ? 'reprova' : 'NAO reprova'));
    if (!ok) f.push('plantio contra a recontagem nao reprova');
  }
  return f;
}

(async () => {
  const modo = process.argv.includes('--lib') ? 'lib' : 'produto';
  const f = modo === 'lib' ? lib() : await produto();
  if (f.length) { f.slice(0, 30).forEach((x) => console.error('REPROVADO: ' + x)); process.exit(1); }
  console.log('ensaio-med-ufv (' + modo + '): TUDO PASSOU');
})().catch((e) => { console.error('ERRO: ' + (e && e.stack || e)); process.exit(1); });
