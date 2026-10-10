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
const STUB = path.join(__dirname, 'ensaio-dia-noite-stub.js');
const DIA = '2026-10-08';
const AGORA = Date.parse(DIA + 'T15:00:00Z');   // 12:00 de Brasilia: o "hoje" do gerador e o DIA
const ENT = ['Complexo', 'PPA', 'ML', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];

// o dia forjado, kW de 5 min, com os dois trafos DIFERENTES: um gerador que relesse 6196+6196 ou 6197+6197 passaria com series
// iguais (revisor RE-101). TR1 sino de 90 MW e consumo de 1.350 kW, TR2 sino de 76 MW e consumo de 1.100 kW: os 2,45 MW da
// noite ficam acima do limiar em que a metade de tras da janela decide (folga / 10 min = 1,25 MW; RE-102) e abaixo do
// consumo maximo da regra (2,494).
const PICO = { 1: 90000, 2: 76000 }, NOITE = { 1: -1350, 2: -1100 };
const pot = (k, m) => (m > 360 && m < 1080 ? PICO[k] * Math.sin(Math.PI * (m - 360) / 720) : NOITE[k]);
const carimbo = (m) => (m === 1440 ? '2026-10-09T00:00:00' : DIA + 'T' + hm(m) + ':00');
const hm = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const serie = (k, ate, mexe) => { const s = []; for (let m = 5; m <= ate; m += 5) s.push({ data: carimbo(m), valor: mexe ? mexe(m, pot(k, m)) : pot(k, m) }); return s; };
const acum = (ate) => { let s = 0; for (let m = 5; m <= ate; m += 5) s += pot(1, m) + pot(2, m); return Math.round(s * 5 / 60 / 1000 * 100) / 100; };

function snapshot(trafosAte, ate6233, mexe1, mexe2) {
  return { dados: [
    { pontoId: 6196, nomeGrandeza: 'Demat', valores: serie(1, trafosAte, mexe1) },
    { pontoId: 6197, nomeGrandeza: 'Demat', valores: serie(2, trafosAte, mexe2) },
    { pontoId: 6233, nomeGrandeza: 'Demat', valores: serie(1, ate6233) },
  ] };
}
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
function roda(snap, pub, leitura) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-dia-noite-'));
  try {
    const L = leitura || {};
    if (L.status) fs.writeFileSync(path.join(dir, 'status_hist_way2_' + DIA + '.json'), String(L.status));
    else if (L.cru != null) fs.writeFileSync(path.join(dir, 'url_hist_way2_' + DIA + '.json'), L.cru);
    else if (!L.falta) fs.writeFileSync(path.join(dir, 'url_hist_way2_' + DIA + '.json'), JSON.stringify(snap));
    fs.writeFileSync(path.join(dir, 'blob_executivo.json'), zlib.gzipSync(Buffer.from(JSON.stringify(pub))));
    const r = spawnSync(process.execPath, ['-r', STUB, GEN], { encoding: 'utf8', timeout: 60000,
      env: Object.assign({}, process.env, { STUB_DIR: dir, STUB_AGORA: String(AGORA), DADOS_STORAGE: 'stub', LOCAL_OUT: '' }) });
    const up = path.join(dir, 'up_executivo.json');
    let gravado = null, linhas = null;
    if (fs.existsSync(up)) {
      let b = fs.readFileSync(up); if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
      linhas = JSON.parse(b.toString('utf8')).serie_dia_ufv;
      gravado = linhas.find((x) => x.dia === DIA && x.ufv === 'Complexo') || null;
    }
    return { status: r.status, saida: ((r.stdout || '') + (r.stderr || '')).trim(), gravado, linhas };
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
  });
  if (r.linhas.some((y) => y.dia === '2026-10-07' && y.liq_mwh !== VENENO)) f.push('mexeu na linha de ONTEM · ' + nome);
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
  + 'recusa o passado torto e a cauda torta; so o 404 e ausencia');
