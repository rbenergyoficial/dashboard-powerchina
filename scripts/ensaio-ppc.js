/*
 * ensaio-ppc.js — prova que a auditoria REPROVA. Roda antes de gerar, no workflow.
 *
 * 🔴 GUARDA QUE NAO REPROVA NAO E GUARDA. Uma auditoria vista so no caminho feliz nao esta
 *    testada — foi assim que o painel de saude passou seis horas dizendo "24/24" durante uma
 *    queda, e foi assim que o `parcial` do MUST ficou anos sendo escrito sem nunca ser lido.
 *
 * Cada caso planta UM defeito REAL, dos que ja aconteceram neste registro, sobre o dado de
 * verdade — e exige o gatilho certo, nao um vermelho qualquer:
 *
 *   A · POSITIVA   o dado como esta hoje passa                 (sem isto o ensaio so diria "reprova sempre")
 *   B · apaga um dia inteiro do registro                        -> restricao_sem_registro
 *       (aconteceu de verdade: 38 meias horas em jun-jul, seis a sete dias sem uma linha)
 *   C · planta uma linha ilegivel no recorte                    -> linha_ilegivel
 *       (aconteceu de verdade: `11/09/20206`, 18 linhas invisiveis)
 *   D · desloca a potencia de um dia inteiro                    -> mediana_do_dia_fora
 *       (o caso que separa desalinhamento do dia de um setpoint perdido)
 *
 * ⚠️ O ensaio NAO grava nada: roda a auditoria com SECO=1. Um ensaio que publicasse o dado
 *    fabricado do caso B poria a mentira no ar para provar que sabe detecta-la.
 *
 * uso: node ensaio-ppc.js [<ppc_restricao.json gzipado>]
 *      sem argumento, ensaia contra o blob PUBLICADO — que e o artefato que a auditoria realmente
 *      le, e por isso o unico que prova alguma coisa sobre producao.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const ORIG = process.argv[2];
const TMP = process.env.TEMP || process.env.TMPDIR || '.';
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const AUDITOR = path.join(__dirname, 'audita-ppc-ons.js');
const DE = process.env.PPC_DE || '2026-09-01';

const leJson = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
const gravaJson = (p, o) => fs.writeFileSync(p, zlib.gzipSync(Buffer.from(JSON.stringify(o))));

/* roda o auditor e devolve { ok, saida } — nunca estoura, porque reprovar e o resultado esperado */
function roda(arquivo) {
  try {
    const s = execFileSync(process.execPath, [AUDITOR], { encoding: 'utf8',
      env: Object.assign({}, process.env, { PPC_LOCAL: arquivo, SECO: '1', PPC_DE: DE }) });
    return { ok: true, saida: s };
  } catch (e) {
    return { ok: false, saida: String(e.stdout || '') + String(e.stderr || '') };
  }
}

/* sem arquivo, baixa o publicado. 🔴 So o 404 vira erro claro; qualquer outra falha de leitura
   estoura, porque ensaiar contra um arquivo pela metade diria "tudo bem" sobre nada. */
function baixaPublicado() {
  const https = require('https');
  return new Promise((ok, erro) => {
    https.get(BASE + 'ppc_restricao.json', (r) => {
      if (r.statusCode !== 200) { erro(new Error('HTTP ' + r.statusCode + ' ao ler o registro publicado')); r.resume(); return; }
      const p = [];
      r.on('data', (c) => p.push(c));
      r.on('end', () => {
        let b = Buffer.concat(p);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        try { ok(JSON.parse(b.toString('utf8'))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); }
      });
    }).on('error', erro);
  });
}

(async () => {
const base = ORIG ? leJson(ORIG) : await baixaPublicado();
const dias = [...new Set(base.eventos.map((e) => e.dia).filter((d) => d >= DE))].sort();
if (dias.length < 2) throw new Error('o registro tem menos de dois dias no recorte: nao da para ensaiar');

/* o dia-cobaia: o que tem mais eventos restritos, para o caso B doer de verdade */
const cont = new Map();
for (const e of base.eventos) if (e.restr && e.dia >= DE) cont.set(e.dia, (cont.get(e.dia) || 0) + 1);
const alvo = [...cont].sort((a, b) => b[1] - a[1])[0][0];

const casos = [];
casos.push({ nome: 'A · o dado de hoje', espera: null, monta: (j) => j });

casos.push({ nome: 'B · um dia some do registro', espera: 'restricao_sem_registro', monta: (j) => {
  j.eventos = j.eventos.filter((e) => e.dia !== alvo);
  return j;
} });

casos.push({ nome: 'C · uma linha ilegivel no recorte', espera: 'linha_ilegivel', monta: (j) => {
  /* a linha fica logo DEPOIS de um evento do dia alvo, para ser datada dentro do recorte —
     e o auditor tem de data-la pela vizinha de cima, que e o que ele promete fazer */
  const vizinha = j.eventos.filter((e) => e.dia === alvo).pop();
  j.defeitos = (j.defeitos || []).concat([{ linha: vizinha.linha + 1, tipo: 'ano_impossivel', valor: '11/09/20206' }]);
  return j;
} });

casos.push({ nome: 'D · o dia inteiro deslocado', espera: 'mediana_do_dia_fora', monta: (j) => {
  for (const e of j.eventos) if (e.dia === alvo && e.restr) e.pot = e.pot + 12;
  return j;
} });

console.log('ENSAIO DA AUDITORIA DO PPC · recorte ' + DE + ' · dia-cobaia ' + alvo);
let mau = 0;
for (const c of casos) {
  const j = c.monta(JSON.parse(JSON.stringify(base)));
  const arq = path.join(TMP, 'ensaio_ppc_' + c.nome.slice(0, 1) + '.json');
  gravaJson(arq, j);
  const r = roda(arq);
  try { fs.unlinkSync(arq); } catch (e) { /* o ensaio nao falha por nao conseguir apagar o proprio rascunho */ }

  if (!c.espera) {
    if (r.ok) console.log('  OK   ' + c.nome + ' -> passou, como tem de passar');
    else { mau += 1; console.log('  FALHA ' + c.nome + ' -> REPROVOU o dado bom:\n' + r.saida.split('\n').slice(-6).join('\n')); }
    continue;
  }
  if (r.ok) { mau += 1; console.log('  FALHA ' + c.nome + ' -> o defeito PASSOU sem alarme'); continue; }
  if (r.saida.indexOf(c.espera) < 0) {
    mau += 1;
    console.log('  FALHA ' + c.nome + ' -> reprovou, mas por outro motivo (esperava ' + c.espera + ')');
    console.log('        ' + r.saida.split('\n').filter((l) => l.indexOf('gatilho') >= 0 || l.indexOf('🔴') >= 0).join(' | ').slice(0, 200));
    continue;
  }
  console.log('  OK   ' + c.nome + ' -> ' + c.espera);
}

if (mau) { console.error('ENSAIO REPROVOU em ' + mau + ' caso(s).'); process.exit(1); }
console.log('ensaio: os ' + casos.length + ' casos se comportaram como o esperado.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
