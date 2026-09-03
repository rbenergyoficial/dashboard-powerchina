/*
 * ensaio-inv-scada-acumula.js — prova que o gerador ACUMULA, com CSV sintetico.
 *
 * 🔴 O CASO QUE IMPORTA E A FONTE ENCOLHER. O export do SCADA retem pouco mais de um mes; enquanto
 *    o gerador reescrevia o blob inteiro a cada rodada, o historico ficava preso nesse tanto. Aqui
 *    a segunda rodada ve a fonte com UM dia so, e o teste exige que os dias anteriores sobrevivam.
 *    Um ensaio que so rodasse o caminho feliz (fonte sempre cheia) nao exercitaria nada disso.
 *
 * Nao toca em rede nem em blob: LOCAL_DIR para a entrada, LOCAL_OUT_DIR para a saida.
 * uso: node scripts/ensaio-inv-scada-acumula.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const GER = path.join(__dirname, 'gen-inv-scada.js');
const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-acum-'));
const ENT = path.join(raiz, 'entrada');
const SAI = path.join(raiz, 'saida');
fs.mkdirSync(ENT); fs.mkdirSync(SAI);

// ---------- CSV sintetico, no formato MEDIDO do export ----------
// A coluna repete o proprio prefixo antes do rotulo, e e esse retrovisor que ancora o padrao do
// gerador: UFV_MRT02_TS1_INV01_MRT02 TS1 INV01 ENERGIA DIÁRIA GERADA
function csv(pref, dia, kwhPorInv) {
  const invs = Object.keys(kwhPorInv);
  const cols = ['Tempo'].concat(invs.map((i) =>
    'UFV_' + pref + '_TS1_' + i + '_' + pref + ' TS1 ' + i + ' ENERGIA DIÁRIA GERADA'));
  const linha = (h, f) => [dia + ' ' + h].concat(invs.map((i) => String(kwhPorInv[i] * f))).join(';');
  // contador diario: o gerador toma o MAIOR valor do dia, entao a primeira leitura vem menor
  return cols.join(';') + '\n' + linha('08:00:00', 0.4) + '\n' + linha('17:00:00', 1) + '\n';
}
// seis inversores por transformador (acima do minimo de pares) e um fraco declarado
// ⚠️ com ruido por inversor, para a frota nao ficar identica: frota identica e caso legitimo, mas
// so exercitaria o recuo da escala. O caso NORMAL tem dispersao pequena e diferente de zero.
const SADIO = 2000, FRACO = 1200;
const RUIDO = { INV01: 1.00, INV02: 0.99, INV03: 1.01, INV04: 0.98, INV05: 1.02, INV06: 1.00 };
const jogo = (fraco, liso) => Object.fromEntries(Object.keys(RUIDO).map((i) =>
  [i, Math.round((i === 'INV06' ? fraco : SADIO) * (liso ? 1 : RUIDO[i]))]));
function poeDia(dia, carimbo) {
  fs.writeFileSync(path.join(ENT, 'M02_' + carimbo + '_120000.csv'), csv('MRT02', dia, jogo(FRACO)));
  fs.writeFileSync(path.join(ENT, 'M03_' + carimbo + '_120000.csv'), csv('MRT03', dia, jogo(SADIO)));
}
const limpaEntrada = () => fs.readdirSync(ENT).forEach((f) => fs.unlinkSync(path.join(ENT, f)));

function roda(janela) {
  const env = Object.assign({}, process.env, { LOCAL_DIR: ENT, LOCAL_OUT_DIR: SAI, DIAS: '400' });
  if (janela) env.JANELA = String(janela);
  delete env.LOCAL_OUT;
  const out = execFileSync('node', [GER], { env, encoding: 'utf8' });
  const le = (n) => { let b = fs.readFileSync(path.join(SAI, n));
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    return JSON.parse(b.toString('utf8')); };
  return { log: out, pub: le('inv_scada.json'), hist: le('inv_scada_hist.json') };
}

const falhas = [];
const ok = (cond, msg) => { if (!cond) falhas.push(msg); console.log((cond ? '  ok   ' : '  FALHA ') + msg); };
const dias = (h) => [...new Set(h.serie.map((l) => l.dia))].sort();

// ---------- 1 · primeira rodada: nao ha historico (o caminho do 404) ----------
console.log('1 · primeira rodada, sem historico publicado');
['2026-09-01', '2026-09-02', '2026-09-03'].forEach((d, i) => poeDia(d, '2026090' + (i + 1)));
let r = roda();
ok(dias(r.hist).length === 3, 'o historico nasce com os 3 dias da fonte · veio ' + dias(r.hist).length);
ok(r.pub.inversores.length === 12, '12 inversores agregados · veio ' + r.pub.inversores.length);
ok(!('serie' in r.pub), 'o blob que o painel le NAO carrega a serie bruta');
ok(r.pub.escopo.dias_cobertos === 3, 'escopo declara 3 dias cobertos · veio ' + r.pub.escopo.dias_cobertos);

// ---------- 2 · o inversor fraco e reconhecido, e o limiar sai da frota ----------
console.log('\n2 · o fraco aparece, e o desvio sai da propria frota');
const pior = r.pub.inversores[0];
ok(pior.chave === 'M2/TS1/INV06', 'o primeiro da lista e o fraco declarado · veio ' + pior.chave);
ok(pior.razao_mediana < 0.65, 'razao proxima de 1200/2000 · veio ' + pior.razao_mediana);
ok(pior.desvios != null && pior.desvios < -3, 'ele fica abaixo de 3 desvios · veio ' + pior.desvios);
ok(r.pub.escopo.referencia.desvio_robusto > 0, 'a dispersao da frota e maior que zero');
ok(r.pub.escopo.referencia.fora_3_desvios === 1, 'exatamente 1 fora de 3 desvios · veio ' + r.pub.escopo.referencia.fora_3_desvios);

// ---------- 3 · A FONTE ENCOLHE e o historico sobrevive ----------
console.log('\n3 · a fonte passa a ter UM dia · e o caso que a acumulacao existe para cobrir');
limpaEntrada();
poeDia('2026-09-04', '20260904');
r = roda();
ok(dias(r.hist).join(' ') === '2026-09-01 2026-09-02 2026-09-03 2026-09-04',
  'o historico tem os 4 dias · veio ' + dias(r.hist).join(' '));
ok(r.pub.escopo.fonte_dias === 1, 'o escopo declara que a fonte trouxe 1 dia · veio ' + r.pub.escopo.fonte_dias);
ok(r.pub.escopo.dias_cobertos === 4, 'e que o arquivo cobre 4 · veio ' + r.pub.escopo.dias_cobertos);

// ---------- 4 · o dia que volta MAIS COMPLETO ganha ----------
console.log('\n4 · um dia reprocessado com valor novo substitui o antigo');
limpaEntrada();
fs.writeFileSync(path.join(ENT, 'M02_20260904_120000.csv'), csv('MRT02', '2026-09-04', jogo(1800)));
fs.writeFileSync(path.join(ENT, 'M03_20260904_120000.csv'), csv('MRT03', '2026-09-04', jogo(SADIO)));
r = roda();
const l4 = r.hist.serie.find((l) => l.dia === '2026-09-04' && l.ufv === 'M2' && l.inv === 'INV06');
ok(l4 && l4.kwh === 1800, 'o valor novo do dia 04 venceu · veio ' + (l4 && l4.kwh));
ok(dias(r.hist).length === 4, 'e nenhum dia se perdeu · veio ' + dias(r.hist).length);

// ---------- 5 · a poda respeita a janela ----------
console.log('\n5 · com a janela em 2 dias, o historico e podado');
r = roda(2);
ok(dias(r.hist).join(' ') === '2026-09-03 2026-09-04', 'sobram os 2 mais recentes · veio ' + dias(r.hist).join(' '));
ok(r.pub.escopo.janela_dias === 2, 'a janela declarada e 2 · veio ' + r.pub.escopo.janela_dias);

// ---------- 6 · a serie publicada e so a dos piores ----------
console.log('\n6 · o painel recebe a serie dos piores, nao a frota inteira');
r = roda();
const invsNaSerie = new Set(r.pub.serie_top.map((l) => l.ufv + '/' + l.ts + '/' + l.inv));
ok(invsNaSerie.size <= r.pub.escopo.serie_top_de, 'no maximo ' + r.pub.escopo.serie_top_de
  + ' inversores na serie · veio ' + invsNaSerie.size);
ok(invsNaSerie.has('M2/TS1/INV06'), 'e o fraco esta entre eles');

// ---------- 7 · frota IDENTICA: estado legitimo, o gerador nao pode abortar ----------
// 🔴 A primeira versao da escala ABORTAVA aqui: com mais da metade da frota exatamente na mediana,
//    a mediana dos afastamentos da zero. Isso e o MELHOR caso possivel — parque uniforme —, e
//    derrubar o job nele seria reprovar o estado que se quer alcancar.
console.log('\n7 · frota sem dispersao nenhuma · o melhor caso possivel nao pode derrubar o job');
limpaEntrada();
['2026-10-01', '2026-10-02', '2026-10-03'].forEach((d, i) => {
  fs.writeFileSync(path.join(ENT, 'M02_2026100' + (i + 1) + '_120000.csv'), csv('MRT02', d, jogo(SADIO, true)));
  fs.writeFileSync(path.join(ENT, 'M03_2026100' + (i + 1) + '_120000.csv'), csv('MRT03', d, jogo(SADIO, true)));
});
fs.rmSync(path.join(SAI, 'inv_scada_hist.json'));
let u = null, erro = null;
try { u = roda(); } catch (e) { erro = e; }
ok(!erro, 'o gerador nao aborta com a frota uniforme' + (erro ? ' · ' + String(erro.message).split('\n')[1] : ''));
if (u) {
  ok(u.pub.escopo.referencia.fora_3_desvios === 0, 'e nao acusa ninguem · veio ' + u.pub.escopo.referencia.fora_3_desvios);
  console.log('       escala usada: ' + u.pub.escopo.referencia.escala);
}

console.log('\n' + (falhas.length ? '🔴 ' + falhas.length + ' FALHA(S)' : '✅ tudo passou'));
fs.rmSync(raiz, { recursive: true, force: true });
process.exit(falhas.length ? 1 : 0);
