'use strict';
/*
 * gen-sager-disp.js — a disponibilidade por usina do Relatorio Geral do SAGER (ONS), publicada e contestada, em meia hora,
 * para o portal: `sager_disp_30min.json` (11/10/2026, PROMOVER sager-disp). A regra esta em `lib-sager-disp.js`.
 *
 * Fonte: o historico `RelatorioGeral_MRT_Historico.xlsx` que o computador da usina envia todo dia as 04:00 ao container privado
 * `backup-dados-scada` (pasta `SAGER_ONS/Historico/`). A chave de envio so CRIA: arquivo que mudou sobe ao lado como
 * `<nome>~AAAAMMDD-HHMMSS`. Vale a versao mais nova (o maior sufixo; o nome sem sufixo e a primeira).
 *
 * Guardas (abortam, nada e gravado): as da lib (cabecalho, as 9 usinas nos dois grupos, patamar repetido, celula contestada sem o
 * comentario, comentario que discorda da celula) e: disponibilidade acima de 102 % da capacidade instalada (ANEEL); dia com numero de
 * patamares diferente de 48; nenhuma versao do arquivo no container.
 *
 * Env: a credencial pela lib-conteiner (DADOS_STORAGE, ou o OIDC do job) · RAW=backup-dados-scada · PREFIXO=SAGER_ONS/Historico/ · OUT=dados
 *      LOCAL_FILE=<xlsx> le um arquivo local em vez do container · LOCAL_OUT_DIR=<pasta> grava ali
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const L = require('./lib-sager-disp');

const RAW = process.env.RAW || 'backup-dados-scada';
const PREFIXO = process.env.PREFIXO || 'SAGER_ONS/Historico/';
const OUT = process.env.OUT || 'dados';
const BASE = 'RelatorioGeral_MRT_Historico.xlsx';
const NOME = 'sager_disp_30min.json';
// capacidade instalada (despachos ANEEL de operacao comercial); M6 = 49,109 MW, o valor que o ONS aceita para a usina
const CAP = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.109, M7: 14.733, M8: 49.11, M9: 9.822 };

// a chave ou o OIDC do job (lib-conteiner, plano OIDC etapa 4): o bruto do SAGER e a saida, cada um no seu conteiner
const conteiner = (nome) => require('./lib-conteiner').conteiner(nome);

/* a versao mais nova: o nome sem sufixo e a primeira; as seguintes tem ~AAAAMMDD-HHMMSS */
function maisNova(nomes) {
  const v = nomes.filter((n) => n === PREFIXO + BASE || n.startsWith(PREFIXO + BASE + '~')).map((n) => ({ n, k: (/~(\d{8}-\d{6})$/.exec(n) || [, ''])[1] }));
  if (!v.length) return null;
  v.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return v[v.length - 1].n;
}

async function le() {
  if (process.env.LOCAL_FILE) return { nome: path.basename(process.env.LOCAL_FILE), buf: fs.readFileSync(process.env.LOCAL_FILE), versoes: 1 };
  const c = conteiner(RAW), nomes = [];
  for await (const b of c.listBlobsFlat({ prefix: PREFIXO + BASE })) nomes.push(b.name);
  const n = maisNova(nomes);
  if (!n) throw new Error('nenhuma versao de ' + BASE + ' em ' + RAW + '/' + PREFIXO);
  return { nome: n, buf: await c.getBlobClient(n).downloadToBuffer(), versoes: nomes.length };
}

async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { fs.writeFileSync(path.join(process.env.LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const c = conteiner(OUT);
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

function confere(r) {
  const porDia = {};
  for (const o of r.serie) {
    porDia[o.t.slice(0, 10)] = (porDia[o.t.slice(0, 10)] || 0) + 1;
    L.USINAS.forEach((u, k) => {
      for (const [rot, v] of [['publicada', o.p[k]], ['contestada', o.c[k]]]) {
        if (v != null && v > CAP['M' + u] * 1.02) throw new Error(o.t + ' M' + u + ': disponibilidade ' + rot + ' ' + v + ' MW acima de 102 % da capacidade (' + CAP['M' + u] + ')');
      }
    });
  }
  const torto = Object.entries(porDia).filter(([, n]) => n !== 48);
  if (torto.length) throw new Error('dia sem os 48 patamares: ' + torto.map(([d, n]) => d + ' (' + n + ')').join(', '));
  return Object.keys(porDia).sort();
}

async function main() {
  const a = await le();
  const r = L.extrai(L.leXlsx(a.buf, 'Patamares'));
  const dias = confere(r);
  const obj = {
    gerado_em: new Date().toISOString(),
    fonte: 'Relatorio Geral do SAGER (ONS), disponibilidade por usina a cada meia hora, desde 01/10/2026 (apuracao por usina do Despacho ANEEL 2.038/2026).',
    unidade: 'MW',
    rotulo_de_tempo: 'inicio do patamar de meia hora, horario de Brasilia',
    usinas: 'arrays p, c, g, i na ordem M1..M9',
    campos: { p: 'disponibilidade como o ONS publicou', c: 'disponibilidade proposta pelo agente na contestacao (nulo = nao contestada)',
      g: 'geracao verificada da usina', i: '1 = o ONS marcou dado insatisfatorio da usina no patamar', cx: 'disponibilidade do conjunto como o ONS publicou' },
    capacidade_mw: CAP,
    arquivo_ms: (/~(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(a.nome) || []).slice(1).length
      ? Date.parse(a.nome.replace(/^.*~(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6-03:00')) : null,
    dias: dias.length, primeiro: dias[0], ultimo: dias[dias.length - 1],
    contestadas: r.contestadas, insatisfatorias: r.insatisfatorias,
    serie: r.serie,
  };
  const kb = await escreve(NOME, obj);
  console.log(NOME + ': ' + r.serie.length + ' patamares · ' + dias[0] + ' a ' + dias[dias.length - 1] + ' · ' + r.contestadas + ' contestados · '
    + r.insatisfatorias + ' insatisfatorios · ' + Math.round(kb / 1024) + ' KB gzip · de ' + a.nome + ' (' + a.versoes + ' versoes)');
}

if (require.main === module) main().catch((e) => { console.error('ERRO: ' + e.message); process.exit(1); });
module.exports = { maisNova, confere, CAP };
