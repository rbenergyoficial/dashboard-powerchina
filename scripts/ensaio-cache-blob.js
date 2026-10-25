'use strict';
/*
 * ensaio-cache-blob.js — a copia em disco do bruto (lib-cache-blob.js) so serve quando confere, e nunca esconde falha.
 *
 * Sem rede: o container e SIMULADO (conta os downloads). Cada caso planta o defeito e prova que o plantio aconteceu
 * antes de julgar. E confere que os tres geradores que leem o scada-raw passam pela copia.
 *
 * uso: node scripts/ensaio-cache-blob.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { abre, nomeArq } = require('./lib-cache-blob');

let falhas = 0, casos = 0;
function ok(cond, msg) { casos++; if (!cond) { falhas++; console.log('  REPROVADO · ' + msg); } else console.log('  ok · ' + msg); }

// container simulado: blobs em memoria, cada download contado
function container(blobs) {
  const c = { downloads: 0, falhar: new Set() };
  c.getBlobClient = (nome) => ({
    download: async () => {
      if (c.falhar.has(nome)) { const e = new Error('500 simulado'); e.statusCode = 500; throw e; }
      c.downloads++;
      const b = blobs[nome];
      return { etag: b.etag, readableStreamBody: Readable.from([b.buf]) };
    },
  });
  return c;
}
const md5 = (buf) => crypto.createHash('md5').update(buf).digest();
// 🔴 Formato REAL (medido em 10/10/2026): a resposta do download traz o etag COM aspas e a listagem SEM aspas. A
//    primeira versao do ensaio usava o mesmo texto nos dois lados e aprovou uma copia que, no Azure, nunca valia.
function item(blobs, nome, comMd5 = true) {
  const b = blobs[nome];
  return { name: nome, properties: { etag: b.etag.replace(/"/g, ''), contentLength: b.buf.length, contentMD5: comMd5 ? md5(b.buf) : undefined } };
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-cache-'));
  const blobs = {
    '81234_M4.xlsx': { etag: '"0x1"', buf: Buffer.from('planilha M4 '.repeat(500)) },
    'pasta/M03_20261009_0300.csv': { etag: '"0x2"', buf: Buffer.from('2026-10-09 03:00:00;1;2;3\n'.repeat(200)) },
    'a%2Fb.csv': { etag: '"0x3"', buf: Buffer.from('nome com sinal de porcento') },
  };

  console.log('1. sem CACHE_BLOB_DIR nada muda: todo pedido vai a rede');
  { const c = container(blobs); const k = abre('scada-raw', '');
    await k.baixa(c, item(blobs, '81234_M4.xlsx')); await k.baixa(c, item(blobs, '81234_M4.xlsx'));
    ok(c.downloads === 2, 'dois pedidos, dois downloads (' + c.downloads + ')'); ok(k.base === null, 'sem pasta de copia'); }

  console.log('2. com a pasta: o segundo pedido vem da copia, identico');
  const c = container(blobs);
  { const k = abre('scada-raw', dir);
    const a = await k.baixa(c, item(blobs, '81234_M4.xlsx'));
    const b = await abre('scada-raw', dir).baixa(c, item(blobs, '81234_M4.xlsx'));
    ok(c.downloads === 1, 'um download para dois pedidos (' + c.downloads + ')');
    ok(Buffer.compare(a, b) === 0 && Buffer.compare(a, blobs['81234_M4.xlsx'].buf) === 0, 'copia byte a byte igual ao blob'); }

  // ⚠️ SEM MD5 e com o MESMO tamanho: blob grande enviado em blocos vem sem MD5 na listagem, e ai so o etag separa
  //    a versao nova da velha. Com MD5 ou tamanho diferentes, o caso passaria mesmo com o etag ignorado.
  console.log('3. blob regravado no Azure, mesmo tamanho, sem MD5 na listagem: o etag novo forca download');
  { const antes = c.downloads; const velho = blobs['81234_M4.xlsx'].buf;
    const novo = Buffer.from(velho); novo.write('NOVA', 0);
    ok(novo.length === velho.length && Buffer.compare(novo, velho) !== 0, 'plantio feito: conteudo novo, mesmo tamanho');
    blobs['81234_M4.xlsx'] = { etag: '"0x9"', buf: novo };
    const b = await abre('scada-raw', dir).baixa(c, item(blobs, '81234_M4.xlsx', false));
    ok(c.downloads === antes + 1, 'etag novo forcou download');
    ok(Buffer.compare(b, novo) === 0, 'devolveu a versao nova, nao a copia velha'); }

  console.log('4. copia corrompida com o MESMO tamanho: o MD5 da listagem pega');
  { const f = path.join(dir, 'scada-raw', nomeArq('81234_M4.xlsx'));
    const bom = fs.readFileSync(f); const ruim = Buffer.from(bom); ruim[3] ^= 0xff; fs.writeFileSync(f, ruim);
    ok(Buffer.compare(fs.readFileSync(f), bom) !== 0 && fs.readFileSync(f).length === bom.length, 'plantio feito: copia difere e tem o mesmo tamanho');
    const antes = c.downloads;
    const b = await abre('scada-raw', dir).baixa(c, item(blobs, '81234_M4.xlsx'));
    ok(c.downloads === antes + 1, 'copia corrompida foi recusada e baixada de novo');
    ok(Buffer.compare(b, blobs['81234_M4.xlsx'].buf) === 0, 'devolveu o conteudo certo');
    ok(Buffer.compare(fs.readFileSync(f), blobs['81234_M4.xlsx'].buf) === 0, 'a copia em disco foi consertada'); }

  console.log('5. copia sem a marca (gravacao interrompida): nao vale');
  { const n = 'pasta/M03_20261009_0300.csv';
    await abre('scada-raw', dir).baixa(c, item(blobs, n));
    const f = path.join(dir, 'scada-raw', nomeArq(n)); fs.unlinkSync(f + '.meta');
    ok(fs.existsSync(f) && !fs.existsSync(f + '.meta'), 'plantio feito: dado sem marca');
    const antes = c.downloads; await abre('scada-raw', dir).baixa(c, item(blobs, n));
    ok(c.downloads === antes + 1, 'dado sem marca foi baixado de novo'); }

  console.log('6. tamanho da listagem diferente da copia: nao vale (mesmo sem MD5)');
  { const n = 'pasta/M03_20261009_0300.csv'; const it = item(blobs, n, false); it.properties.contentLength += 1;
    const antes = c.downloads; await abre('scada-raw', dir).baixa(c, it);
    ok(c.downloads === antes + 1, 'tamanho divergente forcou download'); }

  console.log('7. nomes com barra e com %2F nao colidem');
  { const k = abre('scada-raw', dir);
    const x = await k.baixa(c, item(blobs, 'a%2Fb.csv'));
    const y = await abre('scada-raw', dir).baixa(c, item(blobs, 'pasta/M03_20261009_0300.csv'));
    ok(x.toString() === 'nome com sinal de porcento' && y.toString().startsWith('2026-10-09'), 'cada nome devolve o seu conteudo');
    ok(nomeArq('a/b') !== nomeArq('a%2Fb'), 'nomes achatados distintos'); }

  console.log('8. falha de download ESTOURA (so o gerador decide o que e ausencia)');
  { const c2 = container(blobs); c2.falhar.add('81234_M4.xlsx'); const k = abre('scada-raw', fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-cache-')));
    let estourou = false; try { await k.baixa(c2, item(blobs, '81234_M4.xlsx')); } catch (e) { estourou = /500/.test(e.message); }
    ok(estourou, 'o erro 500 subiu ao chamador'); }

  console.log('9. pasta onde nao se consegue gravar: devolve o dado assim mesmo');
  { const arqNoLugar = path.join(os.tmpdir(), 'ensaio-cache-arquivo-' + process.pid); fs.writeFileSync(arqNoLugar, 'x');
    const k = abre('scada-raw', dir); fs.rmSync(k.base, { recursive: true }); fs.writeFileSync(k.base, 'nao sou pasta');
    const c3 = container(blobs); const b = await k.baixa(c3, item(blobs, 'a%2Fb.csv'));
    ok(b.toString() === 'nome com sinal de porcento' && k.resumo().semGravar === 1, 'dado devolvido, gravacao contada como falha');
    fs.unlinkSync(k.base); fs.unlinkSync(arqNoLugar); }

  console.log('10. poda: sai do disco so o que esta execucao nao usou');
  { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-cache-'));
    await abre('scada-raw', d).baixa(c, item(blobs, '81234_M4.xlsx'));
    await abre('scada-raw', d).baixa(c, item(blobs, 'a%2Fb.csv'));
    const k = abre('scada-raw', d); await k.baixa(c, item(blobs, '81234_M4.xlsx')); k.poda();
    const resta = fs.readdirSync(path.join(d, 'scada-raw')).sort();
    ok(resta.length === 2 && resta.every((f) => f.startsWith(nomeArq('81234_M4.xlsx'))), 'ficou so o usado, dado e marca: ' + resta.join(', '));
    ok(k.resumo().podados === 1, 'um arquivo podado'); }

  console.log('11. copia gravada antes da correcao (marca com aspas) continua valendo');
  { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio-cache-')); const n = 'a%2Fb.csv';
    await abre('scada-raw', d).baixa(c, item(blobs, n));
    const fm = path.join(d, 'scada-raw', nomeArq(n) + '.meta'); const m = JSON.parse(fs.readFileSync(fm, 'utf8'));
    fs.writeFileSync(fm, JSON.stringify({ etag: '"' + m.etag + '"', bytes: m.bytes }));
    ok(JSON.parse(fs.readFileSync(fm, 'utf8')).etag.startsWith('"'), 'plantio feito: marca no formato antigo, com aspas');
    const antes = c.downloads; await abre('scada-raw', d).baixa(c, item(blobs, n));
    ok(c.downloads === antes, 'marca antiga reconhecida, sem download'); }

  console.log('12. os geradores do bruto passam pela copia (os tres do scada-raw e, desde o custo-ppc, o do ppc-raw; desde o custo-sungrow, os exports do gen-sungrow)');
  for (const g of ['gen-scada.js', 'gen-inv-scada.js', 'gen-perdas.js', 'gen-ppc.js', 'gen-trafo.js']) {   // gen-trafo: as planilhas do historiador (custo-trafo)
    const src = fs.readFileSync(path.join(__dirname, g), 'utf8');
    ok(/require\('\.\/lib-cache-blob'\)\.abre\(RAW_CONTAINER\)/.test(src) && /\.baixa\((c|cont), (b|e\.item)\)/.test(src), g + ' abre a copia e baixa por ela');
    ok(/\.poda\(\)/.test(src) && /\.resumo\(\)/.test(src), g + ' poda e resume');
  }
  /* custo-executivo (24/10/2026): o gen-irradiancia le os CSV do scada-raw (IIRR e IRR_GERAL) pela copia; o executivo.yml guarda o scada-raw/ */
  { const src = fs.readFileSync(path.join(__dirname, 'gen-irradiancia.js'), 'utf8');
    const fc = src.slice(src.indexOf('async function fontesDoContainer'), src.indexOf('async function fonteUnica'));
    ok(/CACHE_RAW = require\('\.\/lib-cache-blob'\)\.abre\(cont, process\.env\.CACHE_SCADA_DIR\)/.test(fc) && /await CACHE_RAW\.baixa\(c, item\)/.test(fc) && fc.length > 0 && !/\.download\(\)/.test(fc),
      'gen-irradiancia.js baixa os CSV do scada-raw pela copia (e nenhum download direto na leitura deles)');
    ok(/CACHE_RAW\.poda\(\); CACHE_RAW\.resumo\(\)/.test(src), 'gen-irradiancia.js poda e resume a copia do scada-raw');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'executivo.yml'), 'utf8').replace(/\r\n/g, '\n');
    ok(/\n      CACHE_SCADA_DIR: \$\{\{ github\.workspace \}\}\/\.cache-scada\n/.test(wf) && /path: \.cache-scada\n\s+key: scada-raw-executivo-\$\{\{ github\.run_id \}\}/.test(wf)
      && /steps\.gen_irr\.outcome == 'success' && hashFiles\('\.cache-scada\/scada-raw\/\*\.meta'\)[\s\S]*?key: scada-raw-executivo-\$\{\{ hashFiles\('\.cache-scada\/scada-raw\/\*\.meta'\) \}\}/.test(wf),
      'executivo.yml: o scada-raw em entrada de cache propria, restaurada e guardada so com a irradiancia verde');
  }
  /* custo-sungrow (24/10/2026): o gen-sungrow le os exports do SCADA (scada-raw) pela copia; o workflow restaura e guarda o diretorio */
  { const src = fs.readFileSync(path.join(__dirname, 'gen-sungrow.js'), 'utf8');
    const ex = src.slice(src.indexOf('async function exportsScada'), src.indexOf('async function vidaDoExport'));
    ok(/require\('\.\/lib-cache-blob'\)\.abre\(SCADA_RAW\)/.test(src) && /ler: async \(\) => CACHE_SC\.baixa\(c, b\)/.test(ex) && ex.length > 0 && !/downloadToBuffer/.test(ex),
      'gen-sungrow.js baixa os exports do SCADA pela copia (e nenhum download direto na leitura deles)');
    ok(/CACHE_SC\.poda\(\); CACHE_SC\.resumo\(\)/.test(src), 'gen-sungrow.js poda e resume a copia dos exports');
    const wf = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'sungrow.yml'), 'utf8');
    ok(/CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-sungrow/.test(wf) && /actions\/cache\/restore@(?:v4|[0-9a-f]{40})[\s\S]*?path: \.cache-sungrow[\s\S]*?- name: Gerar sg_\*\.json/.test(wf)
      && /- name: Gerar sg_\*\.json[\s\S]*?actions\/cache\/save@(?:v4|[0-9a-f]{40})[\s\S]*?path: \.cache-sungrow/.test(wf), 'sungrow.yml restaura a copia antes do gen-sungrow e guarda depois');
    /* revisor-workflow 24/10 (RW-001, RW-002, RW-004): o restore nao herda o success() (os ensaios acima rodam com !cancelled() e o gerador
       nao depende de todos); o save so depois do gerador inteiro; a poda depois da busca funda (ela le export velho na mesma rodada) */
    ok(/- name: Copia da rodada anterior \(exports do SCADA e sg_\*\)[^\n]*\r?\n\s+if: \$\{\{ !cancelled\(\) \}\}/.test(wf), 'sungrow.yml: o restore da copia roda com !cancelled()');
    ok(/- name: Guardar a copia da rodada \(exports do SCADA e sg_\*\)[^\n]*\r?\n\s+if: \$\{\{ !cancelled\(\) && steps\.gen_sg\.outcome == 'success'/.test(wf), 'sungrow.yml: a copia so e guardada com o gerador verde');
    ok(src.indexOf('CACHE_SC.poda()') > src.indexOf("busca funda: '") && src.indexOf("busca funda: '") > 0, 'gen-sungrow.js: a poda vem depois da busca funda'); }

  /* custo-trafo (24/10/2026): o trafo.yml guarda a copia do bruto em DUAS entradas (o banco e as planilhas do historiador), cada uma com
     a sua chave; o gerar com CACHE_BLOB_DIR; restore antes e save depois de cada pasta */
  { const wt = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'trafo.yml'), 'utf8').replace(/\r\n/g, '\n');
    const ps = wt.split(/\n      - name: /).slice(1).map((p) => ({ nome: p.split('\n')[0].trim(), corpo: p }));
    const iG = ps.findIndex((p) => /^Gerar trafo_scada_/.test(p.nome));
    const par = (pasta, chave) => {
      const r = ps.findIndex((p) => /actions\/cache\/restore@/.test(p.corpo) && p.corpo.indexOf('path: .cache-banco/' + pasta + '\n') >= 0);
      const s = ps.findIndex((p) => /actions\/cache\/save@/.test(p.corpo) && p.corpo.indexOf('path: .cache-banco/' + pasta + '\n') >= 0);
      return r >= 0 && s >= 0 && r < iG && s > iG && ps[s].corpo.indexOf("key: " + chave + "-${{ hashFiles('.cache-banco/" + pasta + "/*.meta') }}") >= 0
        && ps[r].corpo.indexOf('restore-keys: ' + chave + '-') >= 0;
    };
    ok(iG >= 0 && /CACHE_BLOB_DIR: \$\{\{ github\.workspace \}\}\/\.cache-banco\n/.test(ps[iG].corpo), 'trafo.yml: o gerar com CACHE_BLOB_DIR .cache-banco');
    ok(par('backup-dados-scada', 'scada-db-gen-trafo') && par('scada-raw', 'scada-raw-gen-trafo'),
      'trafo.yml: o banco e as planilhas em entradas separadas, restore antes e save depois, cada uma com a chave da propria pasta');
    ok(!ps.some((p) => /path: \.cache-banco\n/.test(p.corpo)), 'trafo.yml: nenhuma entrada com a pasta .cache-banco inteira (a chave mudaria todo dia com as planilhas dentro)'); }

  console.log('\n' + (falhas ? 'REPROVADO: ' + falhas + ' de ' + casos : 'APROVADO: ' + casos + ' de ' + casos));
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
