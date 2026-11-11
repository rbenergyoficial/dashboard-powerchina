/*
 * ensaio-ppc-folha.js — a leitura da folha da planilha da mesa (lib-ppc.linhasDaFolha), sem rede: folhas montadas aqui.
 *   1. a folha pequena com tudo que a mesa produz (titulo, cabecalho, dado, linha em branco no meio, celula de erro, texto, numero,
 *      celula solta abaixo do dado): as linhas sao as MESMAS do sheet_to_json(header 1, raw, defval null), linha a linha;
 *   2. a folha com uma celula solta muito abaixo do dado (o ":" da B1048576 de 31/10/2026, aqui na linha 200.000 para o plantio caber no
 *      tempo do job): so as linhas COM celula sao montadas, o comprimento e o da area usada, e o leEventos acusa a celula solta como
 *      defeito (data_ilegivel) na linha certa, com as vazias contadas como antes.
 * --planta <nome> troca a regra por uma errada, numa copia do lib ao lado (apagada no fim; casa com scripts/_plantio_* do .gitignore),
 *   e o ensaio TEM de reprovar: folha-inteira (volta ao sheet_to_json da area inteira), erro-vira-valor (a celula de erro vira o codigo).
 */
'use strict';
const fs = require('fs'), path = require('path');
const XLSX = require('xlsx');
const PLANTA = (process.argv.indexOf('--planta') >= 0 && process.argv[process.argv.indexOf('--planta') + 1]) || '';
const NO_CODIGO = {
  'folha-inteira': ['  const L = linhasDaFolha(XLSX, ws);', '  const L = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });',
    '  if (ws[\'!data\']) return XLSX.utils.sheet_to_json(', '  if (true) return XLSX.utils.sheet_to_json('],
  'erro-vira-valor': ["(cel.t === 'e' || cel.v == null) ? null : cel.v", '(cel.v == null) ? null : cel.v'],
};
if (PLANTA && !NO_CODIGO[PLANTA]) throw new Error('plantio desconhecido: ' + PLANTA);
const P = (() => {
  if (!PLANTA) return require('./lib-ppc.js');
  let src = fs.readFileSync(path.join(__dirname, 'lib-ppc.js'), 'utf8');
  const t = NO_CODIGO[PLANTA];
  for (let k = 0; k < t.length; k += 2) {
    if (src.split(t[k]).length !== 2) throw new Error('plantio sem ancora: ' + t[k]);
    src = src.replace(t[k], t[k + 1]);
  }
  const tmp = path.join(__dirname, '_plantio_lib-ppc-folha.js');
  fs.writeFileSync(tmp, src);
  try { return require(tmp); } finally { fs.unlinkSync(tmp); }
})();
let falhas = 0, n = 0;
const ok = (c, nome) => { n++; if (!c) { falhas++; console.log('  FALHA: ' + nome); } else console.log('  ok: ' + nome); };

// a folha como o Excel a grava: monta, escreve em xlsx e le de volta (o caminho do gerador)
function folha(celulas, ref) {
  const ws = {};
  for (const [k, v] of Object.entries(celulas)) ws[k] = v;
  ws['!ref'] = ref;
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Registro');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
const le = (buf) => (w => w.Sheets[w.SheetNames[0]])(XLSX.read(buf, { type: 'buffer', cellDates: false }));
// o dado: linha 7 em diante (LINHA0 = 6), data serial na A, hora em fracao na B, potencia na E, limite na H
const base = {
  A1: { t: 's', v: 'REGISTRO DO PPC' }, A6: { t: 's', v: 'Data' }, B6: { t: 's', v: 'Hora' },
  A7: { t: 'n', v: 46337 }, B7: { t: 'n', v: 0.25 }, C7: { t: 's', v: 'Manhã' }, E7: { t: 'n', v: 171 }, H7: { t: 'n', v: 343.77 },
  A8: { t: 'n', v: 46337 }, B8: { t: 'n', v: 0.5 }, E8: { t: 'n', v: 343.77 }, F8: { t: 'e', v: 7 }, H8: { t: 'n', v: 343.77 },
  A10: { t: 'n', v: 46337 }, B10: { t: 's', v: '15:30' }, E10: { t: 'n', v: 200 }, AD10: { t: 's', v: 'obs' },
};

// 1. a folha pequena: linha a linha igual ao sheet_to_json
{
  const ws = le(folha(Object.assign({}, base, { B40: { t: 's', v: ':' } }), 'A1:AD40'));
  const A = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }), B = P.linhasDaFolha(XLSX, ws);
  const nul = (m) => new Array(m).fill(null);
  let dif = 0;
  for (let i = 0; i < Math.max(A.length, B.length); i++) if (JSON.stringify(A[i]) !== JSON.stringify(B[i] || nul((A[i] || []).length))) dif++;
  ok(A.length === 40 && B.length === 40 && dif === 0, 'folha pequena: as 40 linhas iguais ao sheet_to_json (erro vira null, linha em branco vira vazia)');
  ok(B[7] && B[7][5] === null && B[7][4] === 343.77, 'a celula de erro vira null, o vizinho dela fica');
}

// 2. a celula solta muito abaixo do dado
{
  const FUNDO = 200000;
  const buf = folha(Object.assign({}, base, { ['B' + FUNDO]: { t: 's', v: ':' } }), 'A1:AD' + FUNDO);
  const ws = le(buf);
  const comCelula = new Set(Object.keys(ws).filter((k) => k[0] !== '!').map((k) => XLSX.utils.decode_cell(k).r)).size;
  const B = P.linhasDaFolha(XLSX, ws);
  ok(B.length === FUNDO && Object.keys(B).length === comCelula && comCelula === 6,
    'so as linhas com celula sao montadas (' + comCelula + ' de ' + FUNDO + '), no comprimento da area usada');
  const r = P.leEventos(XLSX, buf);
  ok(r.ev.length === 3 && r.ev.map((e) => e.ts).join(',') === '2026-11-11 06:00,2026-11-11 12:00,2026-11-11 15:30',
    'os tres lancamentos lidos, na ordem, com a hora em fracao e em texto');
  const d = r.def.filter((x) => x.linha === FUNDO);
  ok(d.length === 1 && d[0].tipo === 'data_ilegivel', 'a celula solta continua acusada: data_ilegivel na linha ' + FUNDO + ' (a data vazia)');
  ok(r.vazias === FUNDO - 6 - 4, 'as vazias contadas como antes: ' + (FUNDO - 6 - 4) + ' (a area usada menos o cabecalho e as 4 linhas com dado)');
}

console.log(falhas ? `REPROVADO · ${falhas} de ${n}` + (PLANTA ? ' (plantio ' + PLANTA + ', como devia)' : '')
  : `APROVADO · ${n} conferencias ok` + (PLANTA ? ' — PLANTIO ' + PLANTA + ' PASSOU: o ensaio nao pega' : ''));
process.exitCode = PLANTA ? (falhas ? 0 : 1) : (falhas ? 1 : 0);
