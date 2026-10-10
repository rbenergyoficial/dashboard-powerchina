'use strict';
/*
 * lib-cache-blob.js — copia em disco dos blobs BRUTOS entre uma execucao e a seguinte (10/10/2026).
 *
 * Por que existe: o storage cobra o trafego de SAIDA, e a saida para fora do continente (onde rodam os runners do
 * GitHub) e a mais cara. Medido em 09/10/2026, minuto a minuto contra as execucoes: o SCADA baixava ~1,8 GB do
 * scada-raw por execucao (6 por dia), o Inversores SCADA ~2 GB e o Perdas ~0,8 GB — o MESMO bruto a cada vez. O
 * bruto do scada-raw nao muda depois de gravado (o nome leva o numero do envio), entao a copia da execucao anterior
 * serve, e so o arquivo NOVO precisa vir pela rede.
 *
 * Como a copia e julgada: a listagem do container, que o gerador ja faz, traz etag, tamanho e (quando houver) o MD5
 * do blob. A copia so vale se o etag e o tamanho baterem com a listagem e, havendo MD5 na listagem, se o MD5 do
 * arquivo em disco bater. Qualquer diferenca, ou copia ilegivel: baixa de novo e regrava.
 *
 * Sem CACHE_BLOB_DIR nada muda: baixa direto, como antes. Falha do DOWNLOAD estoura como antes (so o 404 e ausencia,
 * e quem decide isso e o gerador). Falha ao LER ou GRAVAR a copia nao derruba o gerador: vira download, e o resumo
 * conta.
 *
 * Uso:
 *   const cache = require('./lib-cache-blob').abre('scada-raw');
 *   for await (const b of cont.listBlobsFlat()) ... buf = await cache.baixa(cont, b);
 *   cache.poda();      // depois de ler tudo: apaga do disco o que esta execucao nao usou
 *   cache.resumo();    // uma linha no log: quantos da copia, quantos da rede, quantos MB
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// um arquivo por blob, nome achatado: a barra do nome do blob vira %2F e nada cria subpasta
const nomeArq = (nome) => encodeURIComponent(nome);

async function corrente(readable) {
  const ch = [];
  for await (const c of readable) ch.push(c instanceof Buffer ? c : Buffer.from(c));
  return Buffer.concat(ch);
}

// 🔴 A LISTAGEM traz o etag SEM aspas (`0x8DF0F30B3F8F222`) e a RESPOSTA do download COM aspas (`"0x8DF0F30B3F8F222"`).
//    Comparados crus, nunca batem e a copia nunca vale: medido em 10/10/2026 no scada-raw real, a segunda passada
//    rebaixou tudo. Compara-se sem aspas (e sem o `W/` de etag fraco).
const etagNu = (e) => String(e == null ? '' : e).replace(/^W\//, '').replace(/^"|"$/g, '');

function md5DaListagem(p) {
  if (!p || !p.contentMD5 || !p.contentMD5.length) return null;
  return Buffer.from(p.contentMD5).toString('base64');
}

function abre(container, dir) {
  const raiz = dir === undefined ? process.env.CACHE_BLOB_DIR : dir;
  const base = raiz ? path.join(raiz, container) : null;
  if (base) fs.mkdirSync(base, { recursive: true });
  const est = { daCopia: 0, daRede: 0, bytesCopia: 0, bytesRede: 0, invalidas: 0, ilegiveis: 0, semGravar: 0, podados: 0 };
  const usados = new Set();

  function daCopia(item) {
    const p = item.properties || {};
    const f = path.join(base, nomeArq(item.name));
    let meta;
    try { meta = JSON.parse(fs.readFileSync(f + '.meta', 'utf8')); }
    catch (e) { if (e.code !== 'ENOENT') est.ilegiveis++; return null; }
    if (!meta.etag || etagNu(meta.etag) !== etagNu(p.etag) || meta.bytes !== p.contentLength) { est.invalidas++; return null; }
    let buf;
    try { buf = fs.readFileSync(f); } catch (e) { est.ilegiveis++; return null; }
    if (buf.length !== p.contentLength) { est.invalidas++; return null; }
    const md5 = md5DaListagem(p);
    if (md5 && crypto.createHash('md5').update(buf).digest('base64') !== md5) { est.invalidas++; return null; }
    return buf;
  }

  function grava(nome, buf, etag) {
    const f = path.join(base, nomeArq(nome));
    try {
      // dado primeiro, meta por ultimo: copia sem meta nao vale, entao uma gravacao interrompida so custa um download
      fs.writeFileSync(f + '.tmp', buf);
      fs.renameSync(f + '.tmp', f);
      fs.writeFileSync(f + '.meta', JSON.stringify({ etag: etagNu(etag), bytes: buf.length }));
    } catch (e) { est.semGravar++; }
  }

  async function baixa(cont, item) {
    if (base) {
      usados.add(nomeArq(item.name));
      const buf = daCopia(item);
      if (buf) { est.daCopia++; est.bytesCopia += buf.length; return buf; }
    }
    const r = await cont.getBlobClient(item.name).download();
    const buf = await corrente(r.readableStreamBody);
    est.daRede++; est.bytesRede += buf.length;
    // o etag gravado e o da RESPOSTA: se o blob mudou entre a listagem e o download, a copia nao vale na proxima
    if (base) grava(item.name, buf, r.etag);
    return buf;
  }

  function poda() {
    if (!base) return;
    for (const f of fs.readdirSync(base)) {
      const raizArq = f.replace(/\.(meta|tmp)$/, '');
      if (usados.has(raizArq)) continue;
      try { fs.unlinkSync(path.join(base, f)); if (f === raizArq) est.podados++; } catch (e) { /* proxima execucao tenta de novo */ }
    }
  }

  function resumo() {
    const mb = (b) => (b / 1048576).toFixed(1);
    console.log('  cache "' + container + '": ' + (base
      ? est.daCopia + ' da copia (' + mb(est.bytesCopia) + ' MB) · ' + est.daRede + ' da rede (' + mb(est.bytesRede) + ' MB)'
        + (est.invalidas ? ' · ' + est.invalidas + ' copia(s) invalida(s)' : '')
        + (est.ilegiveis ? ' · ' + est.ilegiveis + ' ilegivel(is)' : '')
        + (est.semGravar ? ' · ' + est.semGravar + ' sem gravar' : '')
        + (est.podados ? ' · ' + est.podados + ' podado(s)' : '')
      : 'desligado (sem CACHE_BLOB_DIR) · ' + est.daRede + ' da rede (' + mb(est.bytesRede) + ' MB)'));
    return { ...est };
  }

  return { baixa, poda, resumo, base };
}

module.exports = { abre, nomeArq, etagNu };
