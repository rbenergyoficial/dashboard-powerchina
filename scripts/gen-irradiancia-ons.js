/*
 * gen-irradiancia-ons.js — extrai o Conj. Mauriti (CEFMT1-9) do arquivo DETAIL do ONS e publica
 * `ons_irradiancia_AAAA_MM.json`. Regenera o mes corrente e o anterior (o ONS corrige D-1/D-2).
 *
 * Credencial: a connection string da storage vem do ENV DADOS_STORAGE (secret do Actions).
 * NUNCA colocar credencial no codigo ou no repositorio.
 *
 * == POR QUE PARQUET E NAO CSV (23/08/2026) ==================================================
 *
 * O ONS publica o MESMO mes em tres formatos. Medido em agosto/2026:
 *
 *     CSV       67.283 KB
 *     PARQUET    3.842 KB     <- 94,3% menos
 *
 * Baixavamos o CSV, dois meses por rodada, cinco rodadas por dia: ~650 MB/dia de rede para
 * extrair NOVE usinas. Em parquet sao ~38 MB/dia. O conteudo e o mesmo: 575.808 linhas, as
 * mesmas 12 colunas do dicionario de dados, 9.504 linhas de Mauriti — conferidas uma a uma
 * contra o blob que o caminho do CSV ja tinha produzido.
 *
 * 🔴 A ARMADILHA, MEDIDA ANTES DE MIGRAR. O parquet devolve `din_instante` como data marcada
 * UTC; o CSV devolve texto local ingenuo. Formatando as 9.504 linhas de agosto:
 *
 *                     chaves que casam      VALORES que casam
 *     em UTC           9.504 / 9.504        9.504 / 9.504     <- reproduz o CSV exatamente
 *     em hora local    9.450 / 9.504        2.827 / 9.504     <- parece certo e nao e
 *
 * A leitura local casa 99,4% das CHAVES — a grade de meia hora e densa, entao um deslocamento de
 * tres horas ainda cai numa chave valida — e erra 70% dos VALORES. E a mesma familia do
 * `$toMillis` que ignora o offset e do balde deslocado do MUST: falha silenciosa que parece
 * correta. Por isso a formatacao aqui e explicitamente em UTC, e o ensaio compara os dois
 * caminhos linha a linha.
 *
 * == O BLOB VAI COMPRIMIDO ===================================================================
 *
 * O Azure nao comprime sozinho — serve exatamente os bytes gravados. Sao doze blobs mensais
 * somando 11,82 MB que a pagina baixa de uma vez. Gravando ja em gzip, o navegador e a datasource
 * descomprimem sozinhos e nenhum consumidor precisa saber.
 *
 * == ENV =====================================================================================
 *   DADOS_STORAGE  connection string do Azure (secret)   obrigatorio fora do LOCAL_OUT
 *   FONTE          'csv' volta ao caminho antigo (o ensaio usa para comparar)
 *   MESES          lista separada por virgula (ex.: 2026_07,2026_08); o padrao e corrente+anterior
 *   LOCAL_OUT      diretorio local; grava em arquivo em vez do blob e nao exige credencial
 */
const https = require('https');
const readline = require('readline');

const BASE = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/'
  + 'restricao_coff_fotovoltaica_detail_tm/RESTRICAO_COFF_FOTOVOLTAICA_DETAIL';
const CONTAINER = 'dados';
const CONJUNTO = 'Conj. Mauriti';
const RE_UFV = /^CEFMT[1-9]$/;

// Colunas do CSV (0-based), conforme o dicionario de dados do ONS:
//   3=nom_conjuntousina  5=id_ons  7=din_instante  8=val_irradianciaverificado
//   9=flg_dadoirradianciainvalido  10=val_geracaoestimada  11=val_geracaoverificada
const COL = { conj: 3, id: 5, ts: 7, irr: 8, inv: 9, ge: 10, gv: 11 };

function mesesAlvo() {
  if (process.env.MESES) return process.env.MESES.split(',').map((x) => x.trim()).filter(Boolean);
  const now = new Date();
  const out = [];
  for (let k = 0; k < 2; k++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    out.push(d.getUTCFullYear() + '_' + String(d.getUTCMonth() + 1).padStart(2, '0'));
  }
  return out;
}

const r1 = (v) => +(parseFloat(v) || 0).toFixed(1);
const r2 = (v) => +(parseFloat(v) || 0).toFixed(2);

// ---- caminho antigo: CSV lido linha a linha ---------------------------------------------------
// Continua aqui porque e a REFERENCIA contra a qual o parquet e conferido. Um caminho novo que so
// pode ser comparado com a lembranca de como o antigo funcionava nao e comparavel.
function baixarCSV(mo) {
  return new Promise((resolve, reject) => {
    https.get(BASE + '_' + mo + '.csv', (res) => {
      if (res.statusCode === 403 || res.statusCode === 404) { res.resume(); return resolve(null); }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode + ' em ' + mo)); }
      const rl = readline.createInterface({ input: res, crlfDelay: Infinity });
      const cons = [];
      rl.on('line', (line) => {
        if (line.indexOf(CONJUNTO) === -1) return;
        const c = line.split(';');
        const id = c[COL.id];
        if (!RE_UFV.test(id)) return;
        cons.push({
          ts: c[COL.ts], u: id, irr: r1(c[COL.irr]), inv: c[COL.inv],
          ge: r2(c[COL.ge]), gv: r2(c[COL.gv]),
        });
      });
      rl.on('close', () => resolve(cons));
      rl.on('error', reject);
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ---- caminho novo: PARQUET --------------------------------------------------------------------
function baixarBytes(url) {
  return new Promise((ok, ko) => {
    https.get(url, (r) => {
      if (r.statusCode === 403 || r.statusCode === 404) { r.resume(); return ok(null); }
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode)); }
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => ok(Buffer.concat(c)));
      r.on('error', ko);
    }).on('error', ko);
  });
}

// 🔴 FORMATACAO EM UTC, e o motivo esta no cabecalho: o parquet marca o instante como UTC, e
// converter para hora local desloca tres horas de um jeito que casa quase todas as chaves e
// estraga 70% dos valores.
function instanteComoONS(v) {
  if (typeof v === 'string') return v.replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19);
  const d = new Date(v);
  if (isNaN(d)) throw new Error('din_instante ilegivel: ' + v);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// O CSV traz o indicador como texto ('False'/'True'); o parquet traz booleano. O blob publicado usa
// o texto, e mudar isso quebraria consumidor sem aviso — entao o parquet se adapta ao formato
// antigo, nao o contrario.
function invComoONS(v) {
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

async function baixarParquet(mo) {
  const buf = await baixarBytes(BASE + '_' + mo + '.parquet');
  if (buf === null) return null;
  const { parquetReadObjects } = await import('hyparquet');
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const linhas = await parquetReadObjects({
    file: ab,
    columns: ['nom_conjuntousina', 'id_ons', 'din_instante', 'val_irradianciaverificado',
      'flg_dadoirradianciainvalido', 'val_geracaoestimada', 'val_geracaoverificada'],
  });
  const cons = [];
  for (const l of linhas) {
    if (l.nom_conjuntousina !== CONJUNTO) continue;
    if (!RE_UFV.test(l.id_ons)) continue;
    cons.push({
      ts: instanteComoONS(l.din_instante),
      u: l.id_ons,
      irr: r1(l.val_irradianciaverificado),
      inv: invComoONS(l.flg_dadoirradianciainvalido),
      ge: r2(l.val_geracaoestimada),
      gv: r2(l.val_geracaoverificada),
    });
  }
  return cons;
}

const USA_CSV = /^csv$/i.test(process.env.FONTE || '');
const baixarEConverter = (mo) => (USA_CSV ? baixarCSV(mo) : baixarParquet(mo));

function montaSaida(mo, cons, nota) {
  cons.sort((a, b) => (a.ts === b.ts ? (a.u < b.u ? -1 : 1) : (a.ts < b.ts ? -1 : 1)));
  return {
    fonte: 'ONS RESTRICAO_COFF_FOTOVOLTAICA_DETAIL',
    usina: 'Conj. Mauriti (CEFMT1-9)',
    mes: mo.replace('_', '-'),
    gerado_em: new Date().toISOString(),
    // Unidades NATIVAS do ONS preservadas (sem conversao) para analises e comparativos.
    // Fonte: Dicionario de Dados oficial do dataset.
    intervalo: 'semi-hora (30 min)',
    unidades: { irr: 'W/m2', ge: 'MWmed', gv: 'MWmed' },
    campos: {
      ts: 'din_instante - Data/Hora',
      u: 'id_ons - CEFMT1..9 = Mauriti 1..9',
      irr: 'val_irradianciaverificado - Irradiancia verificada, em W/m2',
      inv: 'flg_dadoirradianciainvalido - 1 = medida invalida (>6 min sem dado na semi-hora)',
      ge: 'val_geracaoestimada - Geracao estimada, em MWmed',
      gv: 'val_geracaoverificada - Geracao verificada, em MWmed',
    },
    // ⚠️ presente SO no arquivo publicado vazio: diz que a ausencia e da FONTE, nao nossa.
    //    Quem consumir consegue distinguir "o operador nao publicou" de "nao ha o que ler".
    aguardando_fonte: nota ? 1 : 0,
    nota: nota || undefined,
    consolidado: cons,
  };
}

module.exports = { baixarCSV, baixarParquet, montaSaida, mesesAlvo, instanteComoONS, invComoONS };

if (require.main !== module) return;

(async () => {
  const local = process.env.LOCAL_OUT;
  let container = null;
  if (!local) {
    const conn = process.env.DADOS_STORAGE;
    if (!conn) { console.error('ERRO: secret DADOS_STORAGE ausente.'); process.exit(1); }
    const { BlobServiceClient } = require('@azure/storage-blob');
    container = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  }
  const nomeDe = (mo) => 'ons_irradiancia_' + mo + '.json';
  const jaExiste = async (mo) => {
    if (local) return require('fs').existsSync(require('path').join(local, nomeDe(mo)));
    return container.getBlockBlobClient(nomeDe(mo)).exists();
  };
  const grava = async (mo, body) => {
    if (local) { require('fs').writeFileSync(require('path').join(local, nomeDe(mo)), body); return 0; }
    const gz = require('zlib').gzipSync(Buffer.from(body, 'utf8'), { level: 9 });
    await container.getBlockBlobClient(nomeDe(mo)).upload(gz, gz.length, {
      blobHTTPHeaders: {
        blobContentType: 'application/json',
        blobContentEncoding: 'gzip',
        blobCacheControl: 'public, max-age=1800',
      },
    });
    return gz.length;
  };
  console.log('=== irradiancia ONS · fonte: ' + (USA_CSV ? 'CSV (caminho antigo)' : 'PARQUET') + ' ===');
  let erros = 0;
  for (const mo of mesesAlvo()) {
    try {
      const t0 = Date.now();
      const cons = await baixarEConverter(mo);
      // 🔴 mes sem publicacao NAO e pulado: o blob nasce VAZIO, senao o painel pede um arquivo
      //    que nao existe e abre com o triangulo vermelho. Medido: os paineis toleram
      //    `consolidado: []` — devolvem 9 e 1 linhas, sem erro.
      // ⚠️ mas NUNCA por cima de um arquivo que ja existe: uma falha de download devolve `null`
      //    igual a "ainda nao publicado", e o vazio APAGARIA o mes inteiro.
      if (cons === null || !cons.length) {
        const motivo = cons === null ? 'o operador ainda nao publicou este mes'
          : 'o operador publicou o mes sem nenhuma linha das usinas do conjunto';
        if (await jaExiste(mo)) {
          console.log('[' + mo + '] ' + motivo + ' — o arquivo ja existe e foi MANTIDO');
          continue;
        }
        await grava(mo, JSON.stringify(montaSaida(mo, [], motivo)));
        console.log('[' + mo + '] ' + motivo + ' — publicado VAZIO (o painel deixa de bater em 404)');
        continue;
      }
      const body = JSON.stringify(montaSaida(mo, cons));
      // ⚠️ um caminho so: `grava` decide entre arquivo local e blob, e devolve o tamanho
      //    comprimido para o log — antes o mesmo JSON era gzipado DUAS vezes por mes.
      const nGz = await grava(mo, body);
      console.log('[' + mo + '] OK — ' + cons.length + ' registros · '
        + Math.round(body.length / 1024) + ' KB'
        + (nGz ? ' -> ' + Math.round(nGz / 1024) + ' KB comprimido ('
          + Math.round((1 - nGz / body.length) * 100) + '% menos)' : ' gravado local')
        + ' · ' + (Date.now() - t0) + ' ms');
    } catch (e) {
      erros++;
      console.error('[' + mo + '] falhou: ' + e.message);
    }
  }
  if (erros) process.exit(1);
})();
