// Gera ons_irradiancia_YYYY_MM.json (Conj. Mauriti, CEFMT1-9) a partir do ONS DETAIL
// e envia ao blob `dados/`. Regenera mês corrente + anterior (ONS corrige D-1/D-2).
// Credencial: connection string da storage vem do ENV DADOS_STORAGE (GitHub Actions secret).
// NUNCA colocar a credencial no código/repositório.
const { BlobServiceClient } = require('@azure/storage-blob');
const https = require('https');
const readline = require('readline');

const BASE = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/restricao_coff_fotovoltaica_detail_tm/RESTRICAO_COFF_FOTOVOLTAICA_DETAIL';
const CONTAINER = 'dados';
const CONJUNTO = 'Conj. Mauriti';
const RE_UFV = /^CEFMT[1-9]$/;
// Colunas DETAIL (0-based): 3=conjunto 5=id_ons 7=din_instante
//   8=val_irradianciaverificado 9=flg_dadoirradianciainvalido 10=val_geracaoestimada 11=val_geracaoverificada

function mesesAlvo() {
  const now = new Date(); const out = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    out.push(d.getUTCFullYear() + '_' + String(d.getUTCMonth() + 1).padStart(2, '0'));
  }
  return out; // ex.: ["2026_07","2026_06"]
}

function baixarEConverter(mo) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE}_${mo}.csv`, (res) => {
      if (res.statusCode === 403 || res.statusCode === 404) { res.resume(); return resolve(null); } // mês ainda não publicado
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' em ' + mo)); }
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
      const cons = [];
      rl.on('line', (line) => {
        if (line.indexOf(CONJUNTO) === -1) return;
        const c = line.split(';'); const id = c[5];
        if (!RE_UFV.test(id)) return;
        cons.push({
          ts: c[7], u: id,
          irr: +(parseFloat(c[8]) || 0).toFixed(1),
          inv: c[9],
          ge: +(parseFloat(c[10]) || 0).toFixed(2),
          gv: +(parseFloat(c[11]) || 0).toFixed(2)
        });
      });
      rl.on('close', () => resolve(cons));
      rl.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const conn = process.env.DADOS_STORAGE;
  if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
  const container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  let erros = 0;
  for (const mo of mesesAlvo()) {
    try {
      const cons = await baixarEConverter(mo);
      if (cons === null) { console.log(`[${mo}] CSV ainda não publicado — pulando`); continue; }
      if (!cons.length) { console.log(`[${mo}] sem linhas de Mauriti — pulando`); continue; }
      cons.sort((a, b) => (a.ts === b.ts ? (a.u < b.u ? -1 : 1) : (a.ts < b.ts ? -1 : 1)));
      const out = {
        fonte: 'ONS RESTRICAO_COFF_FOTOVOLTAICA_DETAIL',
        usina: 'Conj. Mauriti (CEFMT1-9)',
        mes: mo.replace('_', '-'),
        gerado_em: new Date().toISOString(),
        consolidado: cons
      };
      const body = JSON.stringify(out);
      const blob = container.getBlockBlobClient(`ons_irradiancia_${mo}.json`);
      await blob.upload(body, Buffer.byteLength(body), { blobHTTPHeaders: { blobContentType: 'application/json' } });
      console.log(`[${mo}] OK — ${cons.length} registros, ${(body.length / 1024).toFixed(0)} KB enviados ao blob`);
    } catch (e) {
      erros++; console.error(`[${mo}] falhou: ${e.message}`);
    }
  }
  if (erros) process.exit(1);
})();
