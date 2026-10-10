/* ensaio-dia-noite-stub.js — carregado com `node -r` pelo ensaio-dia-noite.js: o gen-dia-corrente roda INTEIRO, sem rede e
 * sem Azure. O snapshot e o executivo.json vem de arquivos em STUB_DIR; o que o gerador gravaria vai para STUB_DIR/up_<blob>.
 *   STUB_DIR    pasta dos arquivos: url_hist_way2_<DIA>.json (o que o https baixaria), blob_<nome> (o que o Azure devolveria)
 *   STUB_AGORA  o relogio (ms), para o "hoje" do gerador ser o dia forjado
 * Nada aqui toca o mundo: o @azure/storage-blob e trocado no carregamento e o https.get serve so arquivo local.
 */
'use strict';
const Module = require('module');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');

const DIR = process.env.STUB_DIR;
if (!DIR) throw new Error('STUB_DIR ausente');
const agora = Number(process.env.STUB_AGORA);
if (!(agora > 0)) throw new Error('STUB_AGORA ausente');
Date.now = () => agora;

const arq = (nome) => path.join(DIR, nome.replace(/[\\/]/g, '_'));
const falso = {
  BlobServiceClient: {
    fromConnectionString: () => ({
      getContainerClient: () => ({
        getBlockBlobClient: (nome) => ({
          getProperties: async () => {
            if (!fs.existsSync(arq('blob_' + nome))) { const e = new Error('404 em ' + nome); e.statusCode = 404; throw e; }
            return { etag: '"stub"' };
          },
          downloadToBuffer: async () => fs.readFileSync(arq('blob_' + nome)),
          upload: async (buf) => { fs.writeFileSync(arq('up_' + nome), buf); },
        }),
      }),
    }),
  },
};
const carrega = Module._load;
Module._load = function (pedido) {
  if (pedido === '@azure/storage-blob') return falso;
  return carrega.apply(this, arguments);
};

https.get = (url, opts, cb) => {
  if (typeof opts === 'function') cb = opts;
  const nome = String(url).split('/dados/')[1] || String(url);
  const f = arq('url_' + nome);
  const st = arq('status_' + nome);   // status forjado (ex.: 500): o arquivo diz o codigo
  const r = new Readable({ read() {} });
  r.headers = {};
  if (fs.existsSync(st)) { r.statusCode = Number(fs.readFileSync(st, 'utf8')); }
  else if (fs.existsSync(f)) { r.statusCode = 200; r.push(fs.readFileSync(f)); } else { r.statusCode = 404; }
  r.push(null);
  process.nextTick(() => cb(r));
  return { on() { return this; } };
};
