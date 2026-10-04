/*
 * audita-way2-grandezas.js — QUAIS grandezas a Way2 publica, e para QUAIS medidores?
 *
 * SOMENTE LEITURA. Nao grava blob, nao toca em producao.
 *
 * ══ POR QUE ISTO EXISTE ══════════════════════════════════════════════════════════════════════
 *
 * Os codigos de grandeza da API foram descobertos por tentativa (a API responde 400 a um nome que
 * nao conhece, e os nomes "amigaveis" da documentacao NAO sao codigos). Em 04/10/2026 a Way2 mandou
 * tres nomes de API: `Demre` (demanda reativa), `DemAparente` (demanda aparente) e `FatorPotencia`.
 * O coletor de 5 min busca so oito grandezas; antes de publicar uma nona, o dado decide:
 *
 *   1. o codigo e ACEITO (HTTP 200) ou recusado (400)?
 *   2. ele vem em TODOS os 25 medidores (22 circuitos, dois trafos de 230 kV, o complexo)?
 *   3. vem FRESCO — o ultimo instante dele acompanha o ultimo instante da `Demat` no mesmo ponto?
 *   4. e a grandeza que o nome diz? Aparente contra raiz(P^2 + Q^2) e fator de potencia contra
 *      P / S, no mesmo instante, com o dado que ja coletamos (sem isso um FP em % ou uma aparente em
 *      VA passariam por kVA).
 *
 * Um codigo por chamada: um nome recusado derruba a chamada inteira, e misturar esconderia qual foi.
 *
 * Env: WAY2_TOKEN (obrigatorio), DIA_ALVO (AAAA-MM-DD; default = ontem), EXTRAS (codigos a mais,
 * separados por virgula).
 */
'use strict';
const https = require('https');
const API = { host: 'pim.way2.com.br', port: 183, path: '/api/v3/dados-de-medicao/pontos' };

const IDS = [];
for (let p = 6196; p <= 6219; p++) IDS.push(p);
IDS.push(6233);
const NOME = (p) => p === 6196 ? 'TR1 230 kV' : p === 6197 ? 'TR2 230 kV' : p === 6233 ? 'Complexo' : 'circ ' + p;

// os tres da Way2 primeiro; depois variantes plausiveis do mesmo padrao (Dem/Ene + At/Re/Aparente),
// e as grandezas que a lista de 12/07/2026 dava como ausentes, para a resposta valer as duas coisas
const CODIGOS = ['Demre', 'DemAparente', 'FatorPotencia',
  'FatorPotenciaA', 'FatorPotenciaB', 'FatorPotenciaC', 'DemreDel', 'DemreRec', 'Frequencia',
  // o diagrama fasorial exige o ANGULO de cada fase; sem ele, so a magnitude e o angulo total atan(Q/P)
  'AnguloTensaoA', 'AnguloCorrenteA', 'AnguloA', 'DefasagemA', 'FatorPotenciaFaseA', 'DhtTensaoA', 'DhtCorrenteA', 'ThdTensaoA']
  .concat((process.env.EXTRAS || '').split(',').map(s => s.trim()).filter(Boolean));
const BASE = ['Demat', 'Demre'];

const diaBRT = (off) => new Date(Date.now() - 3 * 3600 * 1000 - off * 86400000).toISOString().slice(0, 10);

function apiGet(q, token, timeout = 90000) {
  return new Promise((ok) => {
    const req = https.get({ ...API, path: API.path + '?' + q, headers: { 'Pim-Auth': token }, timeout }, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        if (res.statusCode !== 200) return ok({ status: res.statusCode });
        try { ok({ status: 200, j: JSON.parse(b.replace(/^\uFEFF/, '')) }); } catch (e) { ok({ status: 'json-invalido' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => ok({ status: 'erro ' + e.message }));
  });
}
const query = (cod, dia) => 'ids=' + IDS.join(',') + '&grandezas=' + cod
  + '&contextodasdatas=ConsiderarDiaCheio&intervalo=CincoMinutos'
  + '&medicao-datainicio=' + dia + 'T00:00:00&medicao-datafim=' + dia + 'T23:59:59'
  + '&aplicarhorariodeverao=false&separardadoscomcpsemcp=false&medicao-hasvalue=false';

// {pid: Map(hh:mm -> valor)} de uma resposta
function porPonto(j) {
  const o = {};
  for (const s of (j && j.dados) || []) {
    const m = o[s.pontoId] || (o[s.pontoId] = new Map());
    for (const v of s.valores || []) if (v && v.valor != null && /T\d\d:\d\d/.test(v.data)) m.set(v.data.slice(11, 16), v.valor);
  }
  return o;
}
const ult = (m) => m && m.size ? [...m.keys()].sort().pop() : '—';
const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f = (v, c = 3) => v == null ? '—' : (+v).toFixed(c);
const espera = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const token = process.env.WAY2_TOKEN;
  if (!token) { console.error('ERRO: WAY2_TOKEN ausente.'); process.exit(1); }
  const ontem = (process.env.DIA_ALVO || '').trim() || diaBRT(1), hoje = diaBRT(0);
  console.log('dias: ' + ontem + ' (completo) e ' + hoje + ' (em curso) · 25 medidores · codigos: ' + CODIGOS.join(', ') + '\n');

  const R = {};   // R[dia][codigo] = {status, pp}
  for (const dia of [ontem, hoje]) {
    R[dia] = {};
    for (const cod of BASE.concat(CODIGOS)) {
      if (R[dia][cod]) continue;
      const r = await apiGet(query(cod, dia), token);
      R[dia][cod] = { status: r.status, pp: r.status === 200 ? porPonto(r.j) : null };
      await espera(1500);   // a API limita por janela (429); sem pressa
    }
  }

  // 1-3: aceito? em quantos medidores? fresco?
  for (const cod of CODIGOS) {
    const a = R[ontem][cod], b = R[hoje][cod];
    console.log('══ ' + cod + ' · HTTP ' + a.status + ' (ontem) / ' + b.status + ' (hoje)');
    if (a.status !== 200 && b.status !== 200) { console.log('   recusado — a API nao conhece este codigo\n'); continue; }
    let com = 0;
    const linhas = [];
    for (const p of IDS) {
      const mo = a.pp && a.pp[p], mh = b.pp && b.pp[p];
      const dem = R[hoje].Demat.pp && R[hoje].Demat.pp[p];
      const n0 = mo ? mo.size : 0, n1 = mh ? mh.size : 0;
      if (n0 || n1) com++;
      const vals = mo ? [...mo.values()] : [];
      linhas.push('   ' + (NOME(p) + '      ').slice(0, 12) + ' ontem ' + String(n0).padStart(3) + ' leituras'
        + ' · hoje ' + String(n1).padStart(3) + ' ate ' + ult(mh) + ' (Demat ate ' + ult(dem) + ')'
        + ' · ontem min/med/max ' + f(q(vals, 0)) + ' / ' + f(q(vals, 0.5)) + ' / ' + f(q(vals, 0.999)));
    }
    console.log('   com dado em ' + com + ' de ' + IDS.length + ' medidores');
    console.log(linhas.join('\n') + '\n');
  }

  // 4: e a grandeza que o nome diz? Contra Demat/Demre do mesmo ponto e instante (ontem, so com carga)
  const P = R[ontem].Demat.pp || {}, Q = R[ontem].Demre.pp || {};
  const S = R[ontem].DemAparente && R[ontem].DemAparente.pp, FP = R[ontem].FatorPotencia && R[ontem].FatorPotencia.pp;
  console.log('══ conferencia no mesmo instante (ontem, so instantes com |P| > 1% do maximo do ponto)');
  for (const p of IDS) {
    const mp = P[p], mq = Q[p];
    if (!mp || !mq) { console.log('   ' + NOME(p) + ': sem Demat/Demre'); continue; }
    const pmax = Math.max(...[...mp.values()].map(Math.abs));
    const eS = [], rS = [], eF = [], rF = [];
    let sinalNeg = 0, nF = 0;
    for (const [h, pv] of mp) {
      if (Math.abs(pv) <= 0.01 * pmax || !mq.has(h)) continue;
      const sCalc = Math.hypot(pv, mq.get(h));
      const sv = S && S[p] && S[p].get(h);
      if (sv != null) { eS.push(Math.abs(sv - sCalc) / sCalc); rS.push(sv / sCalc); }
      const fv = FP && FP[p] && FP[p].get(h);
      if (fv != null) { nF++; if (fv < 0) sinalNeg++; eF.push(Math.abs(Math.abs(fv) - Math.abs(pv) / sCalc)); rF.push(Math.abs(fv) / (Math.abs(pv) / sCalc)); }
    }
    console.log('   ' + (NOME(p) + '      ').slice(0, 12)
      + ' S/raiz(P2+Q2): n ' + eS.length + ' · razao mediana ' + f(q(rS, 0.5), 4) + ' · erro rel p95 ' + f(q(eS, 0.95), 4)
      + ' || FP/(|P|/S): n ' + eF.length + ' · razao mediana ' + f(q(rF, 0.5), 4) + ' · erro abs p95 ' + f(q(eF, 0.95), 4)
      + ' · FP negativo em ' + sinalNeg + '/' + nF);
  }
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
