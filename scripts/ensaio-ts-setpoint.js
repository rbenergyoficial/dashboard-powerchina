'use strict';
/*
 * ensaio-ts-setpoint.js — julga o gen-ts-setpoint.js sem rede externa, com uma fonte forjada (pvstr_hora_M1.json) e plantios.
 *
 * Cenario (M1/TS1, tres inversores; o M2 sem fonte):
 *   29/09  INV01 e INV02 das 06:00 as 17:00; o INV03 so das 09:00 (a janela dele comeca depois); as 12:00 o carimbo SEM
 *          LEITURA (tudo nulo, como o gen-perdas grava); as 13:00 o INV02 PARADO (0 kW) com o setpoint pedindo 100 kW
 *   30/09  so o INV01 e o INV02 (o INV03 sem curva no dia): n_tot continua 3
 *   rodada 2: a fonte anda (30/09 com outro valor, 01/10 novo e 28/09, um dia ANTERIOR ao publicado); o INV03 sai da fonte e
 *          o INV04 ENTRA nela (01/10): o eletrocentro passa a ter 4;
 *          o publicado tem duas linhas na BORDA da janela de 365 dias (a do ultimo dia - 364 fica, a do - 365 sai)
 *   rodada 3: sem nenhuma fonte, o gerador tem de falhar
 *   contrato: fonte sem o setpoint, de esquema 1 (setpoint em W) ou com outra unidade estoura
 *   HTTP: um servidor local no lugar do blob. 404 do publicado = primeira vez; 500 do publicado e 503 da fonte (de OUTRA usina,
 *          depois de uma legivel) ESTOURAM sem gravar nada: as fontes sao todas lidas antes da primeira gravacao
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync, spawn } = require('child_process');

let falhas = 0;
const ok = (c, msg) => { console.log((c ? '  ok   ' : '  FALHA ') + msg); if (!c) falhas += 1; };

const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-sp-'));
let servidor = null;
process.on('exit', () => { if (servidor) servidor.kill(); fs.rmSync(raiz, { recursive: true, force: true }); });
const IN = path.join(raiz, 'in'), OUT = path.join(raiz, 'out'), WEB = path.join(raiz, 'web');
const H = ['06:00', '07:00', '08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00', '17:00'];
const UNIDADE = 'pcc e pca em kW; ef em %; t em C; iso em MOhm; sp em kW; sn e a contagem de strings com corrente';
// potencia e setpoint por hora: o INV01 entrega 300 com setpoint 352; o INV02 entrega 250 com setpoint 280 (as 13:00 para)
const linha = (d, inv, hs, pca, sp) => ({ d, ts: 'TS1', inv, nom: 352, h: hs, pca, sp });
const nulo12 = (a, hs) => a.map((x, i) => (hs[i] === '12:00' ? null : x));
const fonte = (serie, extra) => Object.assign({ esquema: 3, unidade: UNIDADE, serie }, extra || {});
const fonte1 = [
  linha('2026-09-29', 'INV01', H, nulo12(H.map(() => 300), H), nulo12(H.map(() => 352), H)),
  linha('2026-09-29', 'INV02', H, nulo12(H.map((h) => (h === '13:00' ? 0 : 250)), H), nulo12(H.map((h) => (h === '13:00' ? 100 : 280)), H)),
  linha('2026-09-29', 'INV03', H.slice(3), nulo12(H.slice(3).map(() => 200), H.slice(3)), nulo12(H.slice(3).map(() => 352), H.slice(3))),
  linha('2026-09-30', 'INV01', H, H.map(() => 310), H.map(() => 352)),
  linha('2026-09-30', 'INV02', H, H.map(() => 260), H.map(() => 280)),
];
const fonte2 = [
  linha('2026-09-30', 'INV01', H, H.map(() => 320), H.map(() => 352)),
  linha('2026-09-30', 'INV02', H, H.map(() => 260), H.map(() => 280)),
  linha('2026-10-01', 'INV01', H, H.map(() => 330), H.map(() => 352)),
  linha('2026-10-01', 'INV04', H, H.map(() => 100), H.map(() => 352)),
  linha('2026-09-28', 'INV01', H, H.map(() => 290), H.map(() => 352)),
];
const grava = (dir, n, o) => fs.writeFileSync(path.join(dir, n), zlib.gzipSync(JSON.stringify(o)));
const le = (n) => { const f = path.join(OUT, n); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) : null; };
const roda = (gen, env) => { try { execFileSync('node', [gen], { env: Object.assign({}, process.env, { LOCAL_IN_DIR: IN, LOCAL_OUT_DIR: OUT }, env || {}),
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); return true; } catch (e) { return false; } };
const limpa = (...ds) => { for (const d of ds) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d); } };

/* o servidor no lugar do blob, num processo a parte (o gerador roda sincrono): serve os arquivos de WEB com
   content-encoding gzip e responde o codigo que rotas.json mandar; arquivo ausente = 404 */
const SRV = path.join(raiz, 'srv.js');
fs.writeFileSync(SRV, "const http = require('http'), fs = require('fs'), path = require('path'); const W = process.argv[2];\n"
  + "const s = http.createServer((q, r) => { const n = decodeURIComponent(q.url.split('/').pop()); let rot = {}; try { rot = JSON.parse(fs.readFileSync(path.join(W, 'rotas.json'), 'utf8')); } catch (e) {}\n"
  + "  if (rot[n]) { r.writeHead(rot[n]); r.end('x'); return; } const f = path.join(W, n);\n"
  + "  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-encoding': 'gzip' }); r.end(fs.readFileSync(f)); });\n"
  + "s.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(W, 'porta'), String(s.address().port)));\n");
let BASE = null;
function sobeServidor() {
  limpa(WEB);
  servidor = spawn('node', [SRV, WEB], { stdio: 'ignore' });
  const espera = new Int32Array(new SharedArrayBuffer(4));
  for (let i = 0; i < 100 && !fs.existsSync(path.join(WEB, 'porta')); i += 1) Atomics.wait(espera, 0, 0, 50);
  if (!fs.existsSync(path.join(WEB, 'porta'))) throw new Error('o servidor local nao subiu');
  BASE = 'http://127.0.0.1:' + fs.readFileSync(path.join(WEB, 'porta'), 'utf8') + '/';
}

function cenario(gen) {
  const R = {};
  try {
    limpa(IN, OUT);
    // 1 · primeira rodada
    grava(IN, 'pvstr_hora_M1.json', fonte(fonte1));
    R.roda1 = roda(gen);
    const A = (le('sp_ts_M1_TS1.json') || { serie: [] }).serie, a = (t) => A.find((x) => x.t === t) || {};
    R.okSoma = a('2026-09-29 10:00').p === 750 && a('2026-09-29 10:00').sp === 984 && a('2026-09-29 10:00').n_lido === 3
      && a('2026-09-29 10:00').n_sp === 3 && a('2026-09-29 10:00').n_ger === 3 && a('2026-09-29 10:00').n_tot === 3
      // antes da janela do INV03: dois somados de tres
      && a('2026-09-29 07:00').p === 550 && a('2026-09-29 07:00').sp === 632 && a('2026-09-29 07:00').n_lido === 2 && a('2026-09-29 07:00').n_tot === 3
      && a('2026-09-29 10:00').ms === Date.parse('2026-09-29T10:00:00-03:00');
    // o carimbo sem leitura: nulo, nunca zero
    R.okNulo = a('2026-09-29 12:00').p === null && a('2026-09-29 12:00').sp === null && a('2026-09-29 12:00').n_lido === 0;
    // o inversor parado com setpoint: soma o setpoint, nao conta como gerando
    R.okParado = a('2026-09-29 13:00').p === 500 && a('2026-09-29 13:00').sp === 804 && a('2026-09-29 13:00').n_lido === 3 && a('2026-09-29 13:00').n_ger === 2;
    // dia sem curva de um inversor: n_tot e o eletrocentro, nao o carimbo
    R.okTot = a('2026-09-30 10:00').n_lido === 2 && a('2026-09-30 10:00').n_tot === 3 && a('2026-09-30 10:00').p === 570;
    R.okSemFonte = !fs.readdirSync(OUT).some((n) => n.startsWith('sp_ts_M2_')) && A.length === 24;
    // 2 · a fonte anda (e o INV03 sai dela); o publicado ganha as duas linhas da borda da janela
    const pub = le('sp_ts_M1_TS1.json');
    const velha = (t) => ({ t, ms: Date.parse(t.replace(' ', 'T') + ':00-03:00'), p: 1, sp: 1, n_lido: 1, n_sp: 1, n_ger: 1, n_tot: 3 });
    pub.serie.unshift(velha('2025-10-01 10:00'), velha('2025-10-02 10:00'));
    grava(OUT, 'sp_ts_M1_TS1.json', pub);
    grava(IN, 'pvstr_hora_M1.json', fonte(fonte2));
    R.roda2 = roda(gen);
    const B = (le('sp_ts_M1_TS1.json') || { serie: [] }).serie, b = (t) => B.find((x) => x.t === t) || {};
    // 29/09 (so no publicado), 30/09 refeito, 01/10 novo, 28/09 anterior, e a linha de ultimo - 364 dias: 4 x 12 + 1
    R.okAcumula = B.length === 49 && b('2026-09-29 10:00').p === 750 && b('2026-10-01 10:00').p === 430
      && b('2026-09-30 10:00').p === 580 && b('2026-09-28 10:00').p === 290;
    R.okJanela = B.some((x) => x.t === '2025-10-02 10:00') && !B.some((x) => x.t === '2025-10-01 10:00');
    R.okOrdem = B.length > 0 && B.every((x, i) => i === 0 || B[i - 1].t < x.t);
    // o INV03 saiu da fonte, mas nao do eletrocentro; o INV04 entrou: 4 nos carimbos desta rodada, 3 no dia que ela nao refez
    R.okTot2 = b('2026-09-30 10:00').n_tot === 4 && b('2026-10-01 10:00').n_tot === 4 && b('2026-09-29 10:00').n_tot === 3;
    // 3 · sem fonte nenhuma: falha
    fs.unlinkSync(path.join(IN, 'pvstr_hora_M1.json'));
    R.okFalha = roda(gen) === false;
    // 4 · o contrato da fonte
    const quebra = (f) => { limpa(IN, OUT); grava(IN, 'pvstr_hora_M1.json', f); return roda(gen) === false && !fs.readdirSync(OUT).length; };
    R.okContrato = quebra(fonte(fonte1.map((l) => { const x = Object.assign({}, l); delete x.sp; return x; })))
      && quebra(fonte(fonte1, { esquema: 1 })) && quebra(fonte(fonte1, { unidade: 'pca em kW; sp em W' }));
    // 5 · a leitura pelo endereco http: 404 e primeira vez; 500 do publicado e 503 da fonte estouram sem gravar
    const env = { BLOB_BASE: BASE };
    limpa(IN, OUT);
    grava(WEB, 'pvstr_hora_M1.json', fonte(fonte1));
    fs.writeFileSync(path.join(WEB, 'rotas.json'), '{}');
    const h1 = roda(gen, env) && (le('sp_ts_M1_TS1.json') || { serie: [] }).serie.length === 24;
    limpa(OUT);
    fs.writeFileSync(path.join(WEB, 'rotas.json'), JSON.stringify({ 'sp_ts_M1_TS1.json': 500 }));
    const h2 = roda(gen, env) === false && !fs.readdirSync(OUT).length;
    fs.writeFileSync(path.join(WEB, 'rotas.json'), JSON.stringify({ 'pvstr_hora_M2.json': 503 }));
    limpa(OUT);
    const h3 = roda(gen, env) === false && !fs.readdirSync(OUT).length;
    fs.writeFileSync(path.join(WEB, 'rotas.json'), '{}');
    R.okHttp = h1 && h2 && h3;
    R.txtHttp = '404 primeira vez ' + h1 + ' · 500 do publicado ' + h2 + ' · 503 da fonte ' + h3;
  } catch (e) { R.erro = String(e.message).split('\n')[0]; }
  return R;
}

console.log('gen-ts-setpoint de ponta a ponta');
sobeServidor();
const GEN = path.join(__dirname, 'gen-ts-setpoint.js');
const R = cenario(GEN);
if (R.erro) ok(false, 'o ensaio estourou: ' + R.erro);
ok(R.roda1 && R.roda2, 'as duas rodadas com fonte terminam sem erro');
ok(R.okSoma, 'soma por eletrocentro e carimbo: potencia, setpoint e contagens; antes da janela de um inversor, dois de tres; ms do instante em BRT');
ok(R.okNulo, 'carimbo sem leitura sai nulo, nunca zero');
ok(R.okParado, 'inversor parado com setpoint: o setpoint soma, o inversor nao conta como gerando');
ok(R.okTot, 'dia sem a curva de um inversor: n_tot continua a quantidade do eletrocentro');
ok(R.okTot2, 'n_tot pelo acumulado: o inversor que saiu da fonte de 7 dias continua contado, e o que entrou passa a contar');
ok(R.okSemFonte, 'usina sem fonte nao grava arquivo; um arquivo so para o TS1, 24 carimbos');
ok(R.okAcumula, 'ACUMULA: o dia que saiu da fonte fica, o dia refeito ganha, o dia novo e o dia anterior entram');
ok(R.okJanela, 'janela de 365 dias na borda: a linha de ultimo dia - 364 fica, a de - 365 sai');
ok(R.okOrdem, 'serie em ordem de instante, mesmo com a fonte trazendo um dia anterior ao publicado');
ok(R.okFalha, 'sem nenhuma fonte o gerador falha');
ok(R.okContrato, 'fonte fora do contrato (sem o setpoint, esquema 1 com setpoint em W, outra unidade) estoura sem gravar');
ok(R.okHttp, 'leitura do blob: ' + R.txtHttp);

console.log('\nplantios (cada um roda o cenario inteiro; o gerador plantado tem de RODAR, e reprovar so na regra)');
const src = fs.readFileSync(GEN, 'utf8');
function planta(nome, de, para, chave) {
  if (src.split(de).length !== 2) { ok(false, 'plantio ' + nome + ': trecho nao casou'); return; }
  const g = path.join(__dirname, '_plantio_ts_setpoint.js');
  fs.writeFileSync(g, src.split(de).join(para));
  let r2; try { r2 = cenario(g); } finally { fs.unlinkSync(g); }
  const rodou = r2.roda1 && r2.roda2 && !r2.erro;
  ok(rodou && r2[chave] === false, 'plantio "' + nome + '" reprova em ' + chave + (rodou ? '' : ' (o plantado nem rodou: nao vale)'));
}
planta('sem leitura vira zero', 'p: a[2] ? r1(a[0]) : null', 'p: r1(a[0])', 'okNulo');
planta('setpoint so de quem gera', 'if (sp != null) { a[1] += sp;', 'if (sp != null && p > GERANDO) { a[1] += sp;', 'okParado');
planta('parado conta como gerando', 'if (p > GERANDO) a[4] += 1;', 'if (p >= 0) a[4] += 1;', 'okParado');
planta('quantidade pelo carimbo', 'n_tot: nTot', 'n_tot: a[2]', 'okTot');
planta('quantidade pela fonte da rodada', '...((ant && ant.inversores) || []), ', '', 'okTot2');
planta('quantidade so do publicado', 'new Set([...((ant && ant.inversores) || []), ...invs.get(ts)])', 'new Set(ant && ant.inversores ? ant.inversores : [...invs.get(ts)])', 'okTot2');
planta('grava antes de ler todas as fontes', '    fontes.push([u, fonte]);', '    await grava(u, fonte);', 'okHttp');
planta('sem acumular', 'new Map(((ant && ant.serie) || []).map', 'new Map(([]).map', 'okAcumula');
planta('janela sem corte', 'ks.filter((t) => t.slice(0, 10) >= corte)', 'ks.filter(() => true)', 'okJanela');
planta('janela de 366 dias', '(DIAS - 1) * 864e5', 'DIAS * 864e5', 'okJanela');
planta('sem ordenar', 'const ks = [...tudo.keys()].sort();', 'const ks = [...tudo.keys()];', 'okOrdem');
planta('instante em UTC', "Date.parse(t.replace(' ', 'T') + ':00Z') + 3 * 3600e3", "Date.parse(t.replace(' ', 'T') + ':00Z')", 'okSoma');
planta('sem fonte passa calado', 'if (!arquivos) throw new Error(', 'if (false) throw new Error(', 'okFalha');
planta('sem guarda de contrato', 'if (quebra) throw new Error(', 'if (false) throw new Error(', 'okContrato');
planta('publicado ilegivel vira primeira vez', "throw new Error('nao consegui ler o ' + nome + ' publicado (", "return null; void new Error('nao consegui ler o ' + nome + ' publicado (", 'okHttp');
planta('qualquer codigo vira ausencia', "ko(new Error(url + ' -> HTTP ' + r.statusCode))", 'ok(null)', 'okHttp');

console.log(falhas ? '\n' + falhas + ' FALHA(S)' : '\nensaio-ts-setpoint: tudo ok');
process.exit(falhas ? 1 : 0);
