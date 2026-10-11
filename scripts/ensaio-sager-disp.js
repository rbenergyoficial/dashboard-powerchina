'use strict';
/*
 * ensaio-sager-disp.js — a leitura da disponibilidade por usina do Relatorio Geral do SAGER (lib-sager-disp.js, gen-sager-disp.js),
 * sem rede (11/10/2026, PROMOVER sager-disp).
 *
 * Monta em memoria uma pasta xlsx no formato do historico (aba "Patamares": grupos na linha 9, usinas na linha 10 FORA DE ORDEM como no
 * relatorio do ONS — M3, M1, M2, M4..M9 —, celula contestada em amarelo com o comentario, dado insatisfatorio em fonte vermelha numa
 * coluna de IRRADIANCIA) e confere o que a regra extrai. Esperados escritos a mao.
 * PLANTIOS: cada defeito e plantado reescrevendo o PROPRIO codigo da lib/gerador (troca de texto com contagem exata) e o ensaio tem
 * de reprovar — publicado lido da celula, amarelo ignorado, usina pela posicao, marca vermelha so na coluna da disponibilidade,
 * virgula decimal lida como milhar, versao mais ANTIGA do arquivo.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

let falhas = 0;
const ok = (c, m) => { if (c) console.log('  ok   ' + m); else { falhas++; console.log('  FALHA ' + m); } };

/* zip guardado (metodo 0); o leitor (lib-zip) nao confere o CRC */
function zip(arqs) {
  const partes = [], cen = [];
  let off = 0;
  for (const [nome, txt] of arqs) {
    const n = Buffer.from(nome), d = Buffer.from(txt, 'utf8'), h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0, 8); h.writeUInt32LE(0, 14);
    h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(n.length, 26);
    partes.push(h, n, d);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 10);
    c.writeUInt32LE(d.length, 20); c.writeUInt32LE(d.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    cen.push(c, n);
    off += 30 + n.length + d.length;
  }
  const cb = Buffer.concat(cen), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(arqs.length, 8); e.writeUInt16LE(arqs.length, 10); e.writeUInt32LE(cb.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...partes, cb, e]);
}

const ORDEM = [3, 1, 2, 4, 5, 6, 7, 8, 9];   // a ordem do relatorio do ONS
const L = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
/* colunas: A data, B patamar, C ger conj, D disponibilidade do conjunto; irradiancia E..M; geracao N..V; disponibilidade W..AE */
function pasta(o) {
  o = o || {};
  const ss = [], idx = (t) => { let i = ss.indexOf(t); if (i < 0) { ss.push(t); i = ss.length - 1; } return i; };
  const linhas = {};
  const put = (ref, v, s) => { const r = +/\d+/.exec(ref)[0]; (linhas[r] = linhas[r] || []).push({ ref, v, s: s || 0 }); };
  put('E9', 'Dados Irradiância (W/m2)'); put('N9', 'Geração Verificada por Usina (MW)'); put('W9', 'Disponibilidade por Usina (MW)');
  put('A10', 'Data'); put('B10', 'Patamar'); put('C10', 'Geração Verificada (MWh/h)'); put('D10', 'Disponibilidade\n(MWh/h)');
  ORDEM.forEach((u, k) => { const nome = u === 3 ? 'MTD_MAURITI 3' : 'MTD_MAURITI_' + u; put(L(5 + k) + '10', nome); put(L(14 + k) + '10', nome); put(L(23 + k) + '10', nome + '\nCEFMT' + u + '_D'); });
  const pats = o.pats || ['00:00 - 00:29', '00:30 - 00:59'];
  pats.forEach((pt, j) => {
    const r = 11 + j;
    put('A' + r, '01/10/2026'); put('B' + r, pt); put('C' + r, 10); put('D' + r, 73.367);
    ORDEM.forEach((u, k) => {
      put(L(5 + k) + r, 500 + u, j === 1 && u === 7 ? 2 : 0);          // irradiancia; a da M7 no 2o patamar em vermelho
      put(L(14 + k) + r, u + 0.5);                                       // geracao = usina + 0,5
      put(L(23 + k) + r, (j === 0 && u === 2) ? (o.semAmarelo ? 24.555 : 24.555) : 40 + u, (j === 0 && u === 2 && !o.semAmarelo) ? 1 : 0);
    });
  });
  const sheet = '<worksheet><sheetData>' + Object.keys(linhas).sort((a, b) => a - b).map((r) => '<row r="' + r + '">' + linhas[r].map((c) =>
    typeof c.v === 'string' ? '<c r="' + c.ref + '" s="' + c.s + '" t="s"><v>' + idx(c.v) + '</v></c>' : '<c r="' + c.ref + '" s="' + c.s + '"><v>' + c.v + '</v></c>').join('') + '</row>').join('') + '</sheetData></worksheet>';
  const sst = '<sst>' + ss.map((t) => '<si><t>' + t.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></si>').join('') + '</sst>';
  const styles = '<styleSheet><fonts count="2"><font><sz val="11"/></font><font><color rgb="FFFF0000"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>'
    + '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="0" fontId="0" fillId="2" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="0" applyFont="1"/></cellXfs></styleSheet>';
  const refM2 = L(23 + ORDEM.indexOf(2)) + '11';
  const com = o.semComentario ? '<comments><commentList></commentList></comments>'
    : '<comments><commentList><comment ref="' + refM2 + '" authorId="0"><text><r><t>Valor no SAGER: 0,000 MW. Valor proposto pelo agente: ' + (o.comDiverge ? '20,000' : '24,555') + ' MW, disponibilidade efetiva.</t></r></text></comment></commentList></comments>';
  return zip([
    ['xl/workbook.xml', '<workbook><sheets><sheet name="Patamares" sheetId="1" r:id="rId1"/><sheet name="Restrições" sheetId="2" r:id="rId2"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/worksheets/sheet2.xml', '<worksheet><sheetData/></worksheet>'],
    ['xl/worksheets/_rels/sheet1.xml.rels', '<Relationships><Relationship Id="rId9" Type="comments" Target="../comments1.xml"/></Relationships>'],
    ['xl/comments1.xml', com],
    ['xl/sharedStrings.xml', sst],
    ['xl/styles.xml', styles],
  ]);
}

/* carrega a lib/gerador do PROPRIO codigo, com uma troca de texto plantada (contagem exata 1) */
function carrega(arq, de, para) {
  const f = path.join(__dirname, arq);
  let src = fs.readFileSync(f, 'utf8');
  if (de != null) { const n = src.split(de).length - 1; if (n !== 1) throw new Error('plantio "' + de.slice(0, 50) + '" casou ' + n + ' vezes em ' + arq); src = src.replace(de, para); }
  const m = new Module(f, module); m.filename = f; m.paths = Module._nodeModulePaths(__dirname); m._compile(src, f);
  return m.exports;
}

function julga(Lib, G, fala) {
  const r = {}, d = (m) => { if (fala) console.log('    ' + m); };
  const x = Lib.extrai(Lib.leXlsx(pasta(), 'Patamares'));
  const s0 = x.serie[0], s1 = x.serie[1];
  r.okPub = s0.p[1] === 0 && s1.p[1] === 42;                                  // M2: publicado do comentario no 1o patamar; da celula no 2o
  r.okProp = s0.c[1] === 24.555 && s1.c[1] === null && x.contestadas === 1;
  r.okMapa = s0.p[2] === 43 && s0.p[0] === 41 && s0.g[2] === 3.5 && s0.g[8] === 9.5;   // M3 (1a coluna do relatorio) e M1, pelo nome
  r.okIns = s0.i.every((v) => v === 0) && s1.i[6] === 1 && s1.i.filter(Boolean).length === 1 && x.insatisfatorias === 1;
  r.okTempo = s0.t === '2026-10-01T00:00' && s1.t === '2026-10-01T00:30' && s0.ms === Date.parse('2026-10-01T00:00:00-03:00') && s0.cx === 73.367;
  r.okCol = x.colunas_disp.M3 === 'W' && x.colunas_disp.M1 === 'X';
  // guardas
  const estoura = (o, rx) => { try { Lib.extrai(Lib.leXlsx(pasta(o), 'Patamares')); return false; } catch (e) { d(e.message); return rx.test(e.message); } };
  r.okSemComentario = estoura({ semComentario: true }, /sem o comentario/);
  r.okDiverge = estoura({ comDiverge: true }, /difere da celula/);
  r.okRepetido = estoura({ pats: ['00:00 - 00:29', '00:00 - 00:29'] }, /repetido/);
  // gerador: versao mais nova e conferencia do dia
  const P = 'SAGER_ONS/Historico/RelatorioGeral_MRT_Historico.xlsx';
  r.okVersao = G.maisNova([P, P + '~20261009-134200', P + '~20261011-040002', P + '~20261010-040001', 'SAGER_ONS/Historico/outro.xlsx']) === P + '~20261011-040002'
    && G.maisNova([P]) === P && G.maisNova(['x']) === null;
  const dia48 = { serie: Array.from({ length: 48 }, (_, k) => ({ t: '2026-10-01T' + String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00'), p: [1, 1, 1, 1, 1, 1, 1, 1, 1], c: Array(9).fill(null) })) };
  let ok48 = true; try { G.confere(dia48); } catch (e) { ok48 = false; d(e.message); }
  let pega47 = false; try { G.confere({ serie: dia48.serie.slice(1) }); } catch (e) { pega47 = /48 patamares/.test(e.message); }
  const alto = JSON.parse(JSON.stringify(dia48)); alto.serie[10].p[1] = 26;
  let pegaAlto = false; try { G.confere(alto); } catch (e) { pegaAlto = /acima de 102/.test(e.message); }
  r.okConfere = ok48 && pega47 && pegaAlto;
  return r;
}

console.log('1 · a regra e o gerador como estao');
const R = julga(carrega('lib-sager-disp.js'), carrega('gen-sager-disp.js'), true);
for (const [k, v] of Object.entries(R)) ok(v, k);

console.log('\n2 · plantios: cada um reprova');
const PL = [
  ['publicado lido da celula contestada', 'lib-sager-disp.js', 'const pub = mc ? numBr(mc[1]) : val', 'const pub = val', 'okPub'],
  ['amarelo ignorado', 'lib-sager-disp.js', 'prop = c.amarela ? val : null', 'prop = null', 'okProp'],
  ['usina pela posicao da coluna', 'lib-sager-disp.js', 'const u = usinaDe(c.v); if (u) { if (m[u])', 'const u = p.c - f[0] + 1; if (u) { if (m[u])', 'okMapa'],
  ['marca vermelha so na coluna da disponibilidade', 'lib-sager-disp.js', '(todas[u] || []).some(', '[cD[u]].some(', 'okIns'],
  ['virgula decimal lida como milhar', 'lib-sager-disp.js', "const numBr = (s) => Number(String(s).replace(/\\./g, '').replace(',', '.'));", "const numBr = (s) => Number(String(s).replace(',', ''));", 'okPub'],
  ['versao mais antiga do arquivo', 'gen-sager-disp.js', 'return v[v.length - 1].n;', 'return v[0].n;', 'okVersao'],
];
for (const [rot, arq, de, para, chave] of PL) {
  let r;
  try { r = arq === 'gen-sager-disp.js' ? julga(carrega('lib-sager-disp.js'), carrega(arq, de, para)) : julga(carrega(arq, de, para), carrega('gen-sager-disp.js')); }
  catch (e) { r = { [chave]: false, _erro: e.message }; }
  ok(r[chave] === false, 'plantio "' + rot + '" reprova em ' + chave + (r._erro ? ' (estourou: ' + r._erro.slice(0, 80) + ')' : ''));
}

console.log(falhas ? '\nensaio da disponibilidade do SAGER: ' + falhas + ' FALHA(S)' : '\nensaio da disponibilidade do SAGER: tudo ok');
process.exit(falhas ? 1 : 0);
