/*
 * ensaio-dia-noite.js — o remendo de 5 min (gen-dia-corrente.js) EXECUTADO sobre um dia forjado (PROMOVER dia-noite-encolhe).
 *
 * POR QUE EXISTE. A guarda "o dia nunca encolhe" comparava a liquida nova com a publicada. A liquida cai depois do por do sol
 * (o trafo consome), e depois de uma pausa do remendo a guarda recusava todo o resto do dia: 08/10/2026 ficou publicado em
 * 1.992,81 MWh ate 19:20, e o dia inteiro foi 1.987,00. O ensaio-teto-dia.js julga a REGRA (lib-teto-dia.js); este julga o
 * GERADOR: que ele le o publicado ANTES de regravar a linha, rele os dois trafos em volta do instante publicado e passa isso
 * a guarda. Uma conferencia por texto na fonte deixava passar o bloco movido para depois do laco (revisor-ensaio, RE-003).
 *
 * Como: o gerador roda inteiro com `node -r ensaio-dia-noite-stub.js`, que troca o Azure e o https por arquivos numa pasta
 * temporaria. Sem rede, sem segredo, nada gravado fora da pasta temporaria.
 *
 * Desde `fecha-ontem` julga tambem o FECHAMENTO DE ONTEM pelo remendo (as linhas de 08 e 09/10/2026 ficaram `parcial` e acima do
 * dia inteiro dois dias, com a rodada completa parada) e a reparticao `liq_hoje_mwh` / `liq_fechada_mwh` que o grafico diario le.
 *
 *   node scripts/ensaio-dia-noite.js
 *   GENDIA=<copia em scripts/>.js node scripts/ensaio-dia-noite.js     o mesmo ensaio sobre outra versao do gerador (plantio)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const GEN = process.env.GENDIA || path.join(__dirname, 'gen-dia-corrente.js');
module.exports = { DIA_PADRAO: '2026-10-08' };
const STUB = path.join(__dirname, 'ensaio-dia-noite-stub.js');
const DIA = module.exports.DIA_PADRAO;   // o relogio do stub fica as 12:00 de Brasilia do dia em curso
const ENT = ['Complexo', 'PPA', 'ML', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];

// o dia forjado, kW de 5 min, com os dois trafos DIFERENTES: um gerador que relesse 6196+6196 ou 6197+6197 passaria com series
// iguais (revisor RE-101). TR1 sino de 90 MW e consumo de 1.350 kW, TR2 sino de 76 MW e consumo de 1.100 kW: os 2,45 MW da
// noite ficam acima do limiar em que a metade de tras da janela decide (folga / 10 min = 1,25 MW; RE-102) e abaixo do
// consumo maximo da regra (2,494).
const PICO = { 1: 90000, 2: 76000 }, NOITE = { 1: -1350, 2: -1100 };
const pot = (k, m) => (m > 360 && m < 1080 ? PICO[k] * Math.sin(Math.PI * (m - 360) / 720) : NOITE[k]);
const proximo = (d) => new Date(Date.parse(d + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10);
const carimboDe = (d, m) => (m === 1440 ? proximo(d) + 'T00:00:00' : d + 'T' + hm(m) + ':00');
const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const serieDe = (d, k, ate, mexe) => { const s = []; for (let m = 5; m <= ate; m += 5) s.push({ data: carimboDe(d, m), valor: mexe ? mexe(m, pot(k, m)) : pot(k, m) }); return s; };
const serie = (k, ate, mexe) => serieDe(DIA, k, ate, mexe);
const acum = (ate) => { let s = 0; for (let m = 5; m <= ate; m += 5) s += pot(1, m) + pot(2, m); return Math.round(s * 5 / 60 / 1000 * 100) / 100; };

// Os 22 circuitos (6198-6219) entram no snapshot forjado com pesos DIFERENTES (o circuito 6198+i pesa i+1): sem eles o rateio
// por usina do rollup da zero em todas, e um gerador que zerasse as usinas ou trocasse PPA por ML passava (revisor fecha-ontem
// RE-001). O mapa usina -> circuitos e os grupos sao escritos AQUI, de proposito, e nao importados do gerador: o esperado sai de
// uma conta independente. Cada circuito segue a potencia liquida do conjunto, entao a fracao da usina e fixa por instante.
const UFV_CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205], M4: [6206, 6207, 6208], M5: [6209, 6210, 6211],
  M6: [6212, 6213, 6214], M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
const GRUPO = { PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };
const PESO = (pid) => pid - 6197, PESO_TOT = 253;   // 1 + 2 + ... + 22
const FRAC = Object.fromEntries(Object.entries(UFV_CIRC).map(([u, cs]) => [u, cs.reduce((a, c) => a + PESO(c), 0) / PESO_TOT]));
function snapshotDe(d, trafosAte, ate6233, mexe1, mexe2) {
  const circ = [];
  for (let pid = 6198; pid <= 6219; pid++) {
    const vs = []; for (let m = 5; m <= ate6233; m += 5) vs.push({ data: carimboDe(d, m), valor: PESO(pid) * (pot(1, m) + pot(2, m)) / PESO_TOT });
    circ.push({ pontoId: pid, nomeGrandeza: 'Demat', valores: vs });
  }
  const sn = { dados: [
    { pontoId: 6196, nomeGrandeza: 'Demat', valores: serieDe(d, 1, trafosAte, mexe1) },
    { pontoId: 6197, nomeGrandeza: 'Demat', valores: serieDe(d, 2, trafosAte, mexe2) },
    { pontoId: 6233, nomeGrandeza: 'Demat', valores: serieDe(d, 1, ate6233) },
  ].concat(circ) };
  // o esperado por entidade (MWh, sem arredondar): o conjunto soma os trafos; a usina, a fracao dela nos instantes em que ha
  // trafo E circuito (o rollup pula o instante sem circuito); o grupo, a soma dos membros. So vale sem `mexe`.
  if (!mexe1 && !mexe2) {
    const ac = (ate) => { let x = 0; for (let m = 5; m <= ate; m += 5) x += pot(1, m) + pot(2, m); return x * 5 / 60 / 1000; };
    const e = { Complexo: ac(trafosAte) };
    Object.keys(UFV_CIRC).forEach((u) => { e[u] = FRAC[u] * ac(Math.min(trafosAte, ate6233)); });
    Object.entries(GRUPO).forEach(([g, us]) => { e[g] = us.reduce((a, u) => a + e[u], 0); });
    Object.defineProperty(sn, 'esperado', { value: e, enumerable: false });
  }
  return sn;
}
// folga por entidade, das casas: o gerador grava r2 do rollup em 3 casas (ate 0,005 + 0,0005) e o grupo soma os membros em 3 casas
// (0,0005 por membro); o esperado nao e arredondado
const FOLGA_ENT = (u) => 0.005 + 0.0005 * (GRUPO[u] ? GRUPO[u].length : 1) + 1e-9;
function confereEntidades(nome, linhas, dia, esperado) {
  if (!esperado) return;
  ENT.forEach((u) => {
    const x = linhas.find((y) => y.dia === dia && y.ufv === u);
    if (!x || Math.abs(x.liq_mwh - esperado[u]) > FOLGA_ENT(u)) f.push('entidade ' + u + ' ERRADA · ' + nome + ' · ' + (x && x.liq_mwh) + ' (esperava ' + esperado[u].toFixed(3) + ')');
  });
}
const snapshot = (trafosAte, ate6233, mexe1, mexe2) => snapshotDe(DIA, trafosAte, ate6233, mexe1, mexe2);
// `corte`: o `liq_corte` que o remendo grava (o ultimo instante dos trafos somado); sem ele, a linha da rodada completa.
// `semFonte`: o corte numa linha que NAO e do remendo (sem `liq_fonte`): nao pode valer (revisor RE-206).
// As linhas de OUTROS dias vem ANTES das de hoje e envenenadas (revisor RE-202): um gerador que lesse o publicado ou o corte
// fora de `hoje` acharia primeiro um dia antigo sem `ate` (28,3 MWh) e ontem com 9.999 MWh e corte 23:55.
const VENENO = 9999;
function executivo(liq, ate, corte, semFonte) {
  const velho = { mes: '2025-09', dia: '2025-09-01', dia_num: 1, ufv: 'Complexo', liq_mwh: 28.3, parcial: 0, ate: null };
  const ontem = ENT.map((u) => ({ mes: DIA.slice(0, 7), dia: '2026-10-07', dia_num: 7, ufv: u, liq_mwh: VENENO, parcial: 1, ate: '23:55', liq_corte: '23:55', liq_fonte: 'snapshot 5 min' }));
  const hoje = ENT.map((u) => Object.assign({ mes: DIA.slice(0, 7), dia: DIA, dia_num: 8, ufv: u, liq_mwh: u === 'Complexo' ? liq : 0, parcial: 1, ate },
    corte ? Object.assign({ liq_corte: corte }, semFonte ? {} : { liq_fonte: 'snapshot 5 min' }) : {}));
  return { mes_atual: DIA.slice(0, 7), manchete_ufv: [], serie_dia_ufv: [velho].concat(ontem, hoje) };
}

// roda o gerador sobre (snapshot, publicado) e devolve { status, saida, gravado: linha do Complexo gravada ou null }
// `leitura`: { status: 500 } forja a resposta do https; { cru: '...' } serve o texto no lugar do snapshot; { falta: 1 } nao serve nada (404)
// `outros`: { 'AAAA-MM-DD': snapshot | { status } } servidos ALEM do de hoje; `hoje`: outro dia em curso (o relogio anda junto)
function roda(snap, pub, leitura, outros, hoje) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-dia-noite-'));
  const DIA = hoje || module.exports.DIA_PADRAO;
  try {
    const L = leitura || {};
    Object.entries(outros || {}).forEach(([d, v]) => {
      if (v && v.status) fs.writeFileSync(path.join(dir, 'status_hist_way2_' + d + '.json'), String(v.status));
      else fs.writeFileSync(path.join(dir, 'url_hist_way2_' + d + '.json'), JSON.stringify(v));
    });
    if (L.status) fs.writeFileSync(path.join(dir, 'status_hist_way2_' + DIA + '.json'), String(L.status));
    else if (L.cru != null) fs.writeFileSync(path.join(dir, 'url_hist_way2_' + DIA + '.json'), L.cru);
    else if (!L.falta) fs.writeFileSync(path.join(dir, 'url_hist_way2_' + DIA + '.json'), JSON.stringify(snap));
    fs.writeFileSync(path.join(dir, 'blob_executivo.json'), zlib.gzipSync(Buffer.from(JSON.stringify(pub))));
    const r = spawnSync(process.execPath, ['-r', STUB, GEN], { encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { STUB_DIR: dir, STUB_AGORA: String(Date.parse(DIA + 'T15:00:00Z')), DADOS_STORAGE: 'stub', LOCAL_OUT: '' }) });
    const up = path.join(dir, 'up_executivo.json');
    let gravado = null, linhas = null, manchete = null;
    if (fs.existsSync(up)) {
      let b = fs.readFileSync(up); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
      const jg = JSON.parse(b.toString('utf8'));
      linhas = jg.serie_dia_ufv;
      manchete = jg.manchete_ufv;
      gravado = linhas.find((x) => x.dia === DIA && x.ufv === 'Complexo') || null;
    }
    return { status: r.status, saida: ((r.stdout || '') + (r.stderr || '')).trim(), gravado, linhas, manchete };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const f = [];
let julgados = 0;
const motivo = (r) => (r.saida.split('\n').filter((l) => /abortando|ERRO|ENCOLHEU|consumo maximo/.test(l))[0] || r.saida.split('\n').pop() || '');
// `corte`: o `liq_corte` que tem de sair gravado (o ultimo instante dos trafos do snapshot)
function grava(nome, snap, pub, esperado, ate, corte) {
  julgados++;
  const r = roda(snap, pub);
  if (r.status !== 0 || !r.gravado) { f.push('devia GRAVAR · ' + nome + ' · exit ' + r.status + ' · ' + motivo(r)); return; }
  // as 12 linhas de HOJE, por nome: o mesmo corte, o mesmo `ate` e a fonte do remendo (o crivo do sintetizador do portal
  // compara os membros de cada grupo; revisor RE-203). As de ontem ficam intactas.
  ENT.forEach((u) => {
    const x = r.linhas.find((y) => y.dia === DIA && y.ufv === u);
    if (!x) { f.push('linha ' + u + ' sumiu · ' + nome); return; }
    if (x.liq_corte !== corte || x.ate !== ate || x.liq_fonte !== 'snapshot 5 min') {
      f.push('linha ' + u + ' ERRADA · ' + nome + ' · corte ' + x.liq_corte + ' ate ' + x.ate + ' fonte ' + x.liq_fonte + ' (esperava ' + corte + ' / ' + ate + ')');
    }
    // o grafico diario le `liq_hoje_mwh` (rendendo) e `liq_fechada_mwh` (encerrado): eles andam com `liq_mwh` (fecha-ontem). O
    // `encerrado` e da rodada completa: o esperado sai da ENTRADA, e o remendo nao pode mexer nele (revisor fecha-ontem RE-002)
    const xin = pub.serie_dia_ufv.find((y) => y.dia === DIA && y.ufv === u) || {};
    const enc = xin.encerrado ? 1 : 0;
    if ((x.encerrado ? 1 : 0) !== enc) f.push('encerrado MEXIDO · ' + u + ' · ' + nome + ' · ' + xin.encerrado + ' -> ' + x.encerrado);
    const [fe, ho] = enc ? [x.liq_mwh, null] : [null, x.liq_mwh];
    if (x.liq_fechada_mwh !== fe || x.liq_hoje_mwh !== ho) {
      f.push('reparticao ERRADA · ' + u + ' · ' + nome + ' · liq ' + x.liq_mwh + ' fechada ' + x.liq_fechada_mwh + ' hoje ' + x.liq_hoje_mwh + (enc ? ' (encerrado)' : ''));
    }
  });
  if (r.linhas.some((y) => y.dia === '2026-10-07' && y.liq_mwh !== VENENO)) f.push('mexeu na linha de ONTEM · ' + nome);
  confereEntidades(nome, r.linhas, DIA, snap.esperado);
  // 0,011: o gravado passa por dois arredondamentos (r 3 casas no rollupDia, depois r2 no gerador) e o esperado por um (r2):
  // diferem em ate 0,01, mais o ponto flutuante (revisor RE-105)
  if (Math.abs(r.gravado.liq_mwh - esperado) > 0.011 || r.gravado.ate !== ate) {
    f.push('gravou ERRADO · ' + nome + ' · ' + r.gravado.liq_mwh + ' ate ' + r.gravado.ate + ' (esperava ' + esperado + ' ate ' + ate + ')');
  }
}
// `porque`: a recusa tem de ser ESSA guarda. Recusa por qualquer erro (stub quebrado, require que falta) passaria por
// vacuidade, e as duas guardas se escondem uma atras da outra: o relido cego ao TR2 e salvo pela cauda (revisor RE-103).
const PASSADO = /ENCOLHEU no trecho ja publicado/, CAUDA = /caiu mais que o consumo maximo/;
function recusa(nome, snap, pub, porque) {
  julgados++;
  const r = roda(snap, pub);
  if (r.gravado) f.push('devia RECUSAR · ' + nome + ' · gravou ' + r.gravado.liq_mwh + ' ate ' + r.gravado.ate);
  else if (r.status === 0) f.push('devia RECUSAR com erro · ' + nome + ' · saiu 0 sem gravar: ' + motivo(r));
  else if (!porque.test(r.saida)) f.push('recusou por OUTRO motivo · ' + nome + ' · ' + motivo(r));
}

const T = (h, m) => h * 60 + m;
// 1) a noite depois de 2 h sem remendo (o caso de 08/10): publicado com os trafos 10 min atras do 6233
grava('noite: publicado ate 19:20 (trafos 19:10), o remendo volta as 23:45', snapshot(T(23, 35), T(23, 45)), executivo(acum(T(19, 10)), '19:20', '19:10'), acum(T(23, 35)), '23:45', '23:35');
// 1b) os trafos 20 min atras: com o corte gravado passa (RE-104); a linha da rodada completa (sem corte) cai na janela e recusa
grava('noite: trafos 20 min atras, corte gravado', snapshot(T(23, 25), T(23, 45)), executivo(acum(T(19, 0)), '19:20', '19:00'), acum(T(23, 25)), '23:45', '23:25');
grava('noite: linha da rodada completa (sem corte), trafos 10 min atras', snapshot(T(23, 35), T(23, 45)), executivo(acum(T(19, 10)), '19:20'), acum(T(23, 35)), '23:45', '23:35');
grava('noite: corte 23:55 numa linha que NAO e do remendo (sem liq_fonte): vale a janela', snapshot(T(23, 35), T(23, 45)), executivo(acum(T(19, 10)), '19:20', '23:55', true), acum(T(23, 35)), '23:45', '23:35');
// 2) o trafo A FRENTE do 6233 no publicado (RE-001): de dia, 5 min depois
grava('dia: publicado com os trafos ate 13:00 e o 6233 ate 12:55', snapshot(T(13, 5), T(13, 5)), executivo(acum(T(13, 0)), '12:55', '13:00'), acum(T(13, 5)), '13:05', '13:05');
grava('dia: idem, linha da rodada completa (sem corte)', snapshot(T(13, 5), T(13, 5)), executivo(acum(T(13, 0)), '12:55'), acum(T(13, 5)), '13:05', '13:05');
// 3) a rodada seguinte comum, de dia e de noite
grava('dia: 5 min depois, alinhado', snapshot(T(12, 5), T(12, 5)), executivo(acum(T(12, 0)), '12:00', '12:00'), acum(T(12, 5)), '12:05', '12:05');
// a fonte que nao avancou entre duas rodadas (o gerador diz que acontece: "a fonte nao avancou"): passa (revisor RE-301)
grava('dia: a fonte nao avancou, corte igual ao gravado', snapshot(T(13, 0), T(13, 10)), executivo(acum(T(13, 0)), '13:10', '13:00'), acum(T(13, 0)), '13:10', '13:00');
grava('noite: a fonte nao avancou, corte igual ao gravado', snapshot(T(21, 0), T(21, 10)), executivo(acum(T(21, 0)), '21:10', '21:00'), acum(T(21, 0)), '21:10', '21:00');
grava('noite: 5 min depois, alinhado', snapshot(T(21, 5), T(21, 5)), executivo(acum(T(21, 0)), '21:00', '21:00'), acum(T(21, 5)), '21:05', '21:05');
// 4) o que a guarda existe para recusar
recusa('leitura torta: o TR2 zerado das 12:00 as 12:55, de noite', snapshot(T(21, 20), T(21, 30), null, (m, p) => (m >= 720 && m <= 775 ? 0 : p)), executivo(acum(T(19, 10)), '19:20', '19:10'), PASSADO);
// a cauda mede ate o CORTE novo (21:20), nao ate o `ate` + 10 (21:50): queda de 5,98 MWh desde 19:10 (2,45 MW de consumo e 8 MW a
// mais no TR1 das 21:00) passa do piso pelo corte (0,21 + 2,494 x 2 h 10 = 5,61) e caberia no piso pelo `ate` (6,86)
// de dia a perda no passado tem de ser menor que um passo de geracao, senao um relido lido um passo depois a esconderia (RE-201)
recusa('dia: o TR1 das 11:00 zerado (perda de 7,2 MWh), corte gravado 13:00', snapshot(T(13, 30), T(13, 40), (m, p) => (m === T(11, 0) ? 0 : p)), executivo(acum(T(13, 0)), '13:10', '13:00'), PASSADO);
recusa('noite: o snapshot novo recuou UM passo (o ultimo instante perdido nos dois trafos)', snapshot(T(20, 55), T(21, 5)), executivo(acum(T(21, 0)), '21:10', '21:00'), /RECUOU/);
recusa('noite: o snapshot novo recuou meia hora antes do corte gravado', snapshot(T(20, 30), T(20, 40)), executivo(acum(T(21, 0)), '21:10', '21:00'), /RECUOU/);
recusa('cauda: queda acima do consumo maximo ate o corte novo (trafos 20 min atras)', snapshot(T(21, 20), T(21, 40), (m, p) => (m === T(21, 0) ? p - 8000 : p)), executivo(acum(T(19, 10)), '19:20', '19:10'), CAUDA);
recusa('cauda torta: o TR1 das 21:00 em W lido como kW',snapshot(T(23, 35), T(23, 45), (m, p) => (m === T(21, 0) ? -600000 : p)), executivo(acum(T(19, 10)), '19:20', '19:10'), CAUDA);

// 6) O DIA DE ONTEM (fecha-ontem). Ontem 07/10 publicado pelo remendo da noite (`parcial`, encerrado pela rodada completa, corte
//    23:45). Com o snapshot COMPLETO de ontem as 12 linhas fecham: o dia inteiro, `parcial` 0, sem `ate` nem corte, a energia em
//    `liq_fechada_mwh`. Sem ele, ou ja fechado, ou de outro mes, ou torto, ontem fica como estava — e hoje grava do mesmo jeito.
const ONTEM = '2026-10-07';
// `ontemCampos`: campos que sobrescrevem a linha de ontem (o Complexo; as usinas levam 0); `semEnt`: entidade que FALTA em ontem
// `comMes`: os dias 01 a 06 do Complexo (1.000 MWh cada) e a manchete do mes, para a soma dos dias do mes ler ontem fechado
function execComOntem(ontemCampos, semEnt, comMes) {
  const e = executivo(acum(T(12, 0)), '12:00', '12:00');
  const base = (u) => ({ mes: ONTEM.slice(0, 7), dia: ONTEM, dia_num: 7, ufv: u, liq_mwh: u === 'Complexo' ? acum(T(23, 45)) : 0,
    liq_fechada_mwh: u === 'Complexo' ? acum(T(23, 45)) : 0, liq_hoje_mwh: null,
    parcial: 1, encerrado: 1, ate: '23:55', liq_corte: '23:45', liq_fonte: 'snapshot 5 min' });
  e.serie_dia_ufv = e.serie_dia_ufv.filter((x) => x.dia !== ONTEM).concat(ENT.filter((u) => u !== semEnt).map((u) => {
    const x = Object.assign(base(u), u === 'Complexo' ? (ontemCampos || {}) : {});
    Object.keys(x).forEach((k) => { if (x[k] === undefined) delete x[k]; });
    return x;
  }));
  if (comMes) {
    for (let d = 1; d <= 6; d++) e.serie_dia_ufv.push({ mes: '2026-10', dia: '2026-10-0' + d, dia_num: d, ufv: 'Complexo', liq_mwh: 1000, liq_fechada_mwh: 1000, liq_hoje_mwh: null, parcial: 0, encerrado: 0, ate: null });
    e.manchete_ufv = [{ mes: '2026-10', ufv: 'Complexo', fechado: 0, dias_total: 31, dias_decorridos: 7, liq_fechada_gwh: '7.00', liq_fechada_mwh: 7000,
      meta_gwh: '57.00', meta_mwh: 57000, liq_proj: '31.00', liq_proj_mwh: 31000, liq_gwh: '7.00', hoje_gwh: '0.00' }];
  }
  return e;
}
const linhasDe = (r, d) => (r.linhas || []).filter((x) => x.dia === d);
// `espera`: { fecha: snapshot completo de ontem (o esperado por entidade sai dele) } | { log } | { estoura } | { manchete: true }
function ontemCaso(nome, pub, outros, espera, hoje) {
  julgados++;
  const r = roda(snapshot(T(12, 5), T(12, 5)), pub, null, outros, hoje);
  if (espera.estoura) {
    if (r.status === 0 || r.gravado) f.push('ontem · ' + nome + ': devia ESTOURAR sem gravar (exit ' + r.status + ')');
    else if (!espera.estoura.test(r.saida)) f.push('ontem · ' + nome + ': estourou por OUTRO motivo (' + motivo(r) + ')');
    return;
  }
  if (r.status !== 0 || !r.linhas) { f.push('ontem · ' + nome + ': hoje devia GRAVAR (exit ' + r.status + ' · ' + motivo(r) + ')'); return; }
  const antes = pub.serie_dia_ufv.filter((x) => x.dia === ONTEM), depois = linhasDe(r, ONTEM);
  if (espera.fecha) {
    if (depois.length !== 12) { f.push('ontem · ' + nome + ': ' + depois.length + ' linhas'); return; }
    depois.forEach((x) => {
      if (x.parcial !== 0 || x.encerrado !== 0 || x.ate !== null || 'liq_corte' in x
        || x.liq_fechada_mwh !== x.liq_mwh || x.liq_hoje_mwh !== null || x.liq_fonte !== 'snapshot completo') {
        f.push('ontem · ' + nome + ': linha ' + x.ufv + ' nao fechou certo ' + JSON.stringify(x));
      }
    });
    confereEntidades('ontem · ' + nome, r.linhas, ONTEM, espera.fecha.esperado);
  } else if (JSON.stringify(antes) !== JSON.stringify(depois)) {
    f.push('ontem · ' + nome + ': MEXEU em ontem (' + JSON.stringify(depois.find((x) => x.ufv === 'Complexo')) + ')');
  }
  if (espera.log && !espera.log.test(r.saida)) f.push('ontem · ' + nome + ': o log nao diz o motivo (' + espera.log + ')');
  // a manchete do mes le a soma dos dias JA com ontem fechado: o fechamento vem antes dela (revisor fecha-ontem RE-003)
  if (espera.manchete) {
    const m = (r.manchete || []).find((x) => x.ufv === 'Complexo' && x.mes === '2026-10');
    const soma = r.linhas.filter((x) => x.ufv === 'Complexo' && x.mes === '2026-10' && x.liq_mwh != null).reduce((a, x) => a + x.liq_mwh, 0);
    if (!m || Math.abs(m.liq_mwh - soma) > 0.006) f.push('ontem · ' + nome + ': manchete ' + (m && m.liq_mwh) + ' contra a soma dos dias ' + soma.toFixed(2));
  }
}
const completo = snapshotDe(ONTEM, 1440, 1440);
ontemCaso('snapshot completo fecha as 12 linhas, com a manchete pela soma dos dias', execComOntem(null, null, true), { [ONTEM]: completo },
  { fecha: completo, log: /ontem \(2026-10-07\) FECHADO/, manchete: true });
ontemCaso('linha da rodada completa (sem corte) fecha pela janela', execComOntem({ liq_corte: undefined, liq_fonte: undefined, ate: '19:20', liq_mwh: acum(T(19, 10)), liq_fechada_mwh: acum(T(19, 10)) }),
  { [ONTEM]: completo }, { fecha: completo });
// o corte de ontem so vale em linha do REMENDO: 23:55 numa linha sem `liq_fonte` faria o relido cair 7 MWh (revisor RE-004a)
ontemCaso('corte 23:55 numa linha que nao e do remendo: vale a janela e fecha', execComOntem({ liq_fonte: undefined, liq_corte: '23:55', ate: '19:20', liq_mwh: acum(T(19, 10)), liq_fechada_mwh: acum(T(19, 10)) }),
  { [ONTEM]: completo }, { fecha: completo });
// a rodada completa de madrugada com o snapshot TRUNCADO (parcial, sem `ate`): rele onde a curva nova passa pelo publicado (RE-005)
ontemCaso('linha da rodada completa sem ate (snapshot truncado as 21:00) fecha', execComOntem({ liq_corte: undefined, liq_fonte: undefined, ate: null, encerrado: 0, liq_mwh: acum(T(21, 0)), liq_fechada_mwh: null, liq_hoje_mwh: acum(T(21, 0)) }),
  { [ONTEM]: completo }, { fecha: completo });
ontemCaso('linha-reserva de ontem (parcial 0, sem energia) fecha', execComOntem({ liq_corte: undefined, liq_fonte: undefined, ate: null, parcial: 0, encerrado: 0, liq_mwh: null, liq_fechada_mwh: null }),
  { [ONTEM]: completo }, { fecha: completo, log: /FECHADO/ });
// o limite DECLARADO da janela: a rodada completa de noite com os trafos 20 min atras do `ate` fica aberta, com o aviso
ontemCaso('linha da rodada completa de noite, trafos 20 min atras: fica (limite da janela, declarado)', execComOntem({ liq_corte: undefined, liq_fonte: undefined, ate: '23:55', liq_mwh: acum(T(23, 35)), liq_fechada_mwh: acum(T(23, 35)) }),
  { [ONTEM]: completo }, { log: /::warning::ontem \(2026-10-07\) NAO fechado/ });
ontemCaso('snapshot de ontem incompleto (trafos ate 23:00) nao fecha', execComOntem(), { [ONTEM]: snapshotDe(ONTEM, T(23, 0), 1440) }, { log: /incompleto/ });
ontemCaso('snapshot de ontem sem o 6233 completo nao fecha', execComOntem(), { [ONTEM]: snapshotDe(ONTEM, 1440, T(22, 0)) }, { log: /incompleto/ });
ontemCaso('ontem ja fechado pela rodada completa fica', execComOntem({ parcial: 0, encerrado: 0, ate: null, liq_corte: undefined, liq_fonte: 'EneatLiquida', liq_mwh: 1234.56, liq_fechada_mwh: 1234.56 }),
  { [ONTEM]: completo }, { log: /ja fechado/ });
ontemCaso('ontem sem uma das 12 entidades (M9): aviso, nao fecha', execComOntem(null, 'M9'), { [ONTEM]: completo }, { log: /::warning::ontem \(2026-10-07\) sem as 12 entidades/ });
ontemCaso('snapshot de ontem que perdeu energia no passado: aviso, nao fecha', execComOntem(), { [ONTEM]: snapshotDe(ONTEM, 1440, 1440, (m, p) => (m === T(12, 0) ? 0 : p)) },
  { log: /::warning::ontem \(2026-10-07\) NAO fechado: dia em curso ENCOLHEU no trecho ja publicado/ });
ontemCaso('ontem sem snapshot (404) fica', execComOntem(), {}, { log: /nao existe/ });
ontemCaso('HTTP 500 no snapshot de ontem estoura', execComOntem(), { [ONTEM]: { status: 500 } }, { estoura: /ERRO HTTP 500 em .*hist\/way2_2026-10-07/ });
// a virada do mes: hoje 01/11, ontem 31/10 parcial com o snapshot completo — fica para a rodada completa (a manchete do mes fechado)
(() => {
  const H = '2026-11-01', O = '2026-10-31';
  const e = executivo(acum(T(12, 0)), '12:00', '12:00');
  e.mes_atual = '2026-11';
  e.serie_dia_ufv = e.serie_dia_ufv.filter((x) => x.dia !== DIA && x.dia !== ONTEM)
    .concat(ENT.map((u) => ({ mes: '2026-10', dia: O, dia_num: 31, ufv: u, liq_mwh: u === 'Complexo' ? acum(T(23, 45)) : 0, liq_fechada_mwh: u === 'Complexo' ? acum(T(23, 45)) : 0,
      liq_hoje_mwh: null, parcial: 1, encerrado: 1, ate: '23:55', liq_corte: '23:45', liq_fonte: 'snapshot 5 min' })))
    .concat(ENT.map((u) => ({ mes: '2026-11', dia: H, dia_num: 1, ufv: u, liq_mwh: u === 'Complexo' ? acum(T(12, 0)) : 0, parcial: 1, ate: '12:00', liq_corte: '12:00', liq_fonte: 'snapshot 5 min' })));
  julgados++;
  const r = roda(snapshotDe(H, T(12, 5), T(12, 5)), e, null, { [O]: snapshotDe(O, 1440, 1440) }, H);
  if (r.status !== 0 || !r.linhas) { f.push('virada do mes: hoje devia GRAVAR (exit ' + r.status + ' · ' + motivo(r) + ')'); return; }
  if (JSON.stringify(e.serie_dia_ufv.filter((x) => x.dia === O)) !== JSON.stringify(linhasDe(r, O))) f.push('virada do mes: MEXEU em 31/10');
  if (!/mes anterior/.test(r.saida)) f.push('virada do mes: o log nao diz que ontem e do mes anterior');
  if (!linhasDe(r, H).every((x) => x.ate === '12:05')) f.push('virada do mes: 01/11 nao foi remendado');
})();
// a reparticao com o dia ENCERRADO pela rodada completa (depois do por do sol): a energia vai em `liq_fechada_mwh`
(() => {
  const e = executivo(acum(T(21, 0)), '21:00', '21:00');
  e.serie_dia_ufv.forEach((x) => { if (x.dia === DIA) x.encerrado = 1; });
  grava('noite: dia ENCERRADO pela rodada completa, a energia em liq_fechada', snapshot(T(21, 5), T(21, 5)), e, acum(T(21, 5)), '21:05', '21:05');
})();
// hoje vindo da LINHA-RESERVA da rodada completa (parcial 0, sem energia, sem `ate`): a primeira rodada do dia reparte como dia
// em curso — `parcial` vira 1 ANTES da reparticao (revisor RE-004c)
(() => {
  const e = executivo(null, null);
  e.serie_dia_ufv.forEach((x) => { if (x.dia === DIA) { x.parcial = 0; x.liq_mwh = null; x.ate = null; } });
  grava('dia: hoje vindo da linha-reserva da rodada completa', snapshot(T(12, 5), T(12, 5)), e, acum(T(12, 5)), '12:05', '12:05');
})();

// 5) a LEITURA do snapshot: so o 404 e ausencia (verde, nada gravado); qualquer outra falha estoura (RE-007)
const pubL = executivo(acum(T(12, 0)), '12:00');
// `porque` (falhas): o erro tem de ser o da LEITURA, nao uma quebra qualquer do gerador (revisor RE-106)
const leit = (nome, leitura, deveFalhar, porque) => {
  julgados++;
  const r = roda(null, pubL, leitura);
  if (r.gravado) f.push('leitura · ' + nome + ': gravou ' + r.gravado.liq_mwh);
  else if (deveFalhar && r.status === 0) f.push('leitura · ' + nome + ': saiu 0 em silencio (' + motivo(r) + ')');
  else if (deveFalhar && !porque.test(r.saida)) f.push('leitura · ' + nome + ': estourou por OUTRO motivo (' + motivo(r) + ')');
  else if (!deveFalhar && r.status !== 0) f.push('leitura · ' + nome + ': devia sair 0 (ausencia), saiu ' + r.status + ' (' + motivo(r) + ')');
};
leit('snapshot ainda nao existe (404)', { falta: 1 }, false);
leit('HTTP 500 na leitura do snapshot', { status: 500 }, true, /ERRO HTTP 500 em .*hist\/way2_/);
leit('snapshot com JSON quebrado', { cru: '{"dados": [' }, true, /ERRO .*JSON/);

if (f.length) { console.error('REPROVADO (' + path.basename(GEN) + '):\n  ' + f.join('\n  ')); process.exit(1); }
console.log('ensaio-dia-noite: TUDO PASSOU · o gerador executado em ' + julgados + ' rodadas forjadas: grava a noite depois da pausa '
  + '(com e sem o corte gravado, trafos ate 20 min atras), o trafo a frente do 6233 e a rodada comum, com o `liq_corte` certo; '
  + 'recusa o passado torto e a cauda torta; so o 404 e ausencia; fecha ontem so com o snapshot completo, no mesmo mes e '
  + 'pela guarda, e reparte liq_hoje / liq_fechada');
