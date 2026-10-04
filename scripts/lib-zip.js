'use strict';
/*
 * lib-zip.js — le as entradas de um zip em memoria, sem dependencia: o diretorio central e o `zlib` do proprio Node.
 *
 * Feito para os zips do logger Sungrow (`sungrow-raw`), medidos em 03/10/2026: 838 zips, ate 16 MB cada, 4.479 entradas,
 * so os metodos 0 (guardado) e 8 (deflate), nenhum Zip64. Qualquer coisa fora disso ESTOURA com o nome do zip — um
 * leitor que pulasse a entrada que nao entende apagaria dias de dado em silencio.
 */
const zlib = require('zlib');

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

// [{ nome, dados: Buffer }] na ordem do diretorio central
function entradas(buf, rotulo) {
  const r = rotulo || 'zip';
  // o fim do diretorio central fica nos ultimos 22 + ate 65535 bytes (comentario)
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  }
  if (e < 0) throw new Error(r + ': fim do diretorio central nao encontrado');
  const total = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  if (p === 0xFFFFFFFF || total === 0xFFFF) throw new Error(r + ': Zip64 nao suportado');
  const out = [];
  for (let k = 0; k < total; k += 1) {
    if (buf.readUInt32LE(p) !== CEN) throw new Error(r + ': diretorio central corrompido na entrada ' + k);
    const metodo = buf.readUInt16LE(p + 10);
    const tamC = buf.readUInt32LE(p + 20), tamU = buf.readUInt32LE(p + 24);
    const nN = buf.readUInt16LE(p + 28), nX = buf.readUInt16LE(p + 30), nC = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const nome = buf.slice(p + 46, p + 46 + nN).toString('utf8');
    p += 46 + nN + nX + nC;
    if (nome.endsWith('/')) continue;                       // pasta
    if (buf.readUInt32LE(loc) !== LOC) throw new Error(r + ': cabecalho local corrompido em ' + nome);
    const ini = loc + 30 + buf.readUInt16LE(loc + 26) + buf.readUInt16LE(loc + 28);
    const comp = buf.slice(ini, ini + tamC);
    let dados;
    if (metodo === 0) dados = comp;
    else if (metodo === 8) dados = zlib.inflateRawSync(comp);
    else throw new Error(r + ': metodo de compressao ' + metodo + ' em ' + nome);
    if (dados.length !== tamU) throw new Error(r + ': ' + nome + ' com ' + dados.length + ' bytes, o diretorio diz ' + tamU);
    out.push({ nome, dados });
  }
  return out;
}

module.exports = { entradas };
