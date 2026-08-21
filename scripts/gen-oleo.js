/*
 * gen-oleo.js — laudos de analise de oleo mineral isolante -> dados/oleo.json.
 *
 * POR QUE EXISTE. O pipeline dos laudos vive fora deste repositorio, em
 * `PWC_Docs/Controle Analise de Oleo/_pipeline`: os PDFs viram `laudos_raw.json` e depois
 * `dados_html.json`, que alimenta o painel HTML. Este gerador NAO refaz aquele trabalho — ele pega
 * o resultado, valida e publica no blob para o Grafana ler. Sem isso os paineis teriam de carregar
 * o dado embutido no proprio JSON do dashboard, congelado no momento da montagem: cada campanha
 * nova exigiria remontar os 24 paineis.
 *
 * ENTRADA: data/oleo_laudos.json, versionado neste repositorio. O ciclo hoje e manual e assumido
 * como tal — a coleta e trimestral, nao ha o que automatizar num evento que acontece 4 vezes ao
 * ano. Quem atualiza copia o arquivo do _pipeline para ca e da push.
 *
 * VALIDACAO QUE ABORTA. Publicar laudo malformado e pior que nao publicar: o painel desenharia
 * campos vazios com cara de medicao. Confere contagem, campos obrigatorios e tipos antes de gravar,
 * e recusa se algo faltar.
 *
 * Env: DADOS_STORAGE [obrigatorio] · OUT_CONTAINER · OUT_BLOB · LOCAL_OUT (grava em arquivo).
 */
const fs = require('fs');
const path = require('path');

const ENTRADA = process.env.ENTRADA || path.join(__dirname, '..', 'data', 'oleo_laudos.json');
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'oleo.json';

// Campos que TODO laudo tem de trazer. A lista sai do proprio dado (46 campos em 176 registros);
// aqui ficam os que os paineis leem — se um deles sumir, o painel desenha vazio sem avisar.
const OBRIGATORIOS = ['camp', 'site', 'eq', 'classe', 'estado', 'st', 'dcol',
  'rig', 'fp', 'ti', 'iN', 'agua', 'dens', 'h2', 'ch4', 'co', 'co2', 'c2h4', 'c2h6', 'c2h2',
  'o2', 'n2', 'tot', 'comb', 'r1'];
const MIN_REGISTROS = 100;   // a base ja tem 176; queda abaixo disto e arquivo truncado

// ---- LIMITES DA NORMA, e o uso de cada um ----------------------------------------------------
// A regra normativa mora AQUI, no gerador, e nao no JSONata dos paineis: sao 24 paineis lendo o
// mesmo dado, e duplicar a interpretacao da norma em cada um e garantir que uma copia envelheca
// diferente das outras. O painel so desenha.
//
// ABNT NBR 10576:2017, quarta edicao. Transformador em servico: Tabela 7, por classe de tensao.
// Comutador em servico: Tabela 10, por POSICAO — o 04T1 e o 04T2 sao de neutro.
//
// 🔴 OLEO NOVO NAO TEM PERCENTUAL. A nota (a) da Tabela 2 restringe aqueles valores a amostras de
// 24 h a 30 dias apos o ENCHIMENTO, antes da energizacao. A 1a coleta e de jan-fev/2025 em
// equipamento fabricado em 2023 e energizado a partir de set/2025 — muito fora da janela, e fora
// dela a norma manda acordar os valores entre comprador e fabricante. Aplicar a Tabela 2 assim
// mesmo produziria uma nao conformidade que a propria norma nao sustenta.
const ALTA = '> 145 kV', SERV = 'Em serviço (NBR 10576)';
const ehComut = l => /COMUT/i.test(l.eq || '');
function limitesDe(l) {
  if (l.estado !== SERV) return {};
  if (ehComut(l)) return { rig: { min: 30 }, agua: { max: 40 } };
  const a = l.classe === ALTA;
  return { rig: { min: a ? 60 : 40 }, fp: { max: 0.5 }, ti: { min: a ? 25 : 20 },
           iN: { max: a ? 0.15 : 0.20 }, agua: { max: a ? 20 : 40 } };
}
// uso = quanto do limite esta consumido. Para limite de MAXIMO e valor/limite; para o de MINIMO e
// limite/valor — assim os dois lem na MESMA direcao: 0 e folga total, 100 e estar no limite.
// Sem isso o leitor teria de inverter a leitura mentalmente em dois dos cinco ensaios.
const ENSAIOS = ['rig', 'fp', 'ti', 'iN', 'agua'];
const r1 = v => (v == null || !isFinite(v)) ? null : Math.round(v * 10) / 10;
function enriquece(l) {
  const L = limitesDe(l);
  let pior = null;
  for (const k of ENSAIOS) {
    const lim = L[k];
    const u = (!lim || l[k] == null) ? null
      : (lim.max != null ? l[k] / lim.max * 100 : (l[k] > 0 ? lim.min / l[k] * 100 : null));
    l['uso_' + k] = r1(u);
    l['lim_' + k] = lim ? (lim.max != null ? lim.max : lim.min) : null;
    if (u != null && (pior == null || u > pior)) pior = u;
  }
  l.uso_pior = r1(pior);
  l.unidade = (l.site || '') + ' · ' + (l.ts || l.eq || '');
  l.comutador = ehComut(l) ? 1 : 0;
  // rotulo curto da campanha, para caber em eixo e legenda
  l.camp_rot = String(l.camp || '').replace(/^(\d)ª Coleta – (\d{4}).*/, '$1ª/$2');
  return l;
}

async function grava(obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { fs.writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=900' } });
  return json.length;
}

(async () => {
  if (!fs.existsSync(ENTRADA)) throw new Error('entrada nao encontrada: ' + ENTRADA);
  const cru = JSON.parse(fs.readFileSync(ENTRADA, 'utf8'));
  // o _pipeline emite um dicionario indexado por posicao; aqui vira lista, que e o que o
  // JSONata do painel espera e o que sobrevive a reordenacao
  const laudos = Array.isArray(cru) ? cru : Object.values(cru);

  if (laudos.length < MIN_REGISTROS)
    throw new Error('so ' + laudos.length + ' laudos (minimo ' + MIN_REGISTROS + ') — arquivo truncado?');

  const faltando = {};
  for (const l of laudos) for (const c of OBRIGATORIOS) if (!(c in l)) faltando[c] = (faltando[c] || 0) + 1;
  if (Object.keys(faltando).length)
    throw new Error('campos ausentes: ' + Object.entries(faltando).map(([k, n]) => k + ' em ' + n).join(', '));

  laudos.forEach(enriquece);
  const camps = [...new Set(laudos.map(l => l.camp))].sort();
  const sites = [...new Set(laudos.map(l => l.site))].sort();
  const naoConforme = laudos.filter(l => l.st && l.st !== 'CONFORME').length;

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'Laudos de analise de oleo mineral isolante, SE Mauriti e usinas. Pipeline de extracao '
      + 'em PWC_Docs/Controle Analise de Oleo/_pipeline: PDFs -> parse_laudos.py -> extrai_dados.py.',
    criterio: 'Limites da ABNT NBR 10576:2017, quarta edicao — Tabela 7 (transformador em servico, '
      + 'por classe de tensao) e Tabela 10 (comutador em servico, por posicao). Interpretacao de '
      + 'gases pela ABNT NBR 7274:2026 e IEC 60599.',
    ressalva_oleo_novo: 'Laudo de oleo NOVO nao tem percentual de limite. A nota (a) da Tabela 2 da '
      + 'NBR 10576 restringe aqueles valores a amostras de 24 h a 30 dias apos o enchimento, antes '
      + 'da energizacao — a 1a coleta esta muito fora dessa janela, e fora dela a norma manda acordar '
      + 'os valores entre comprador e fabricante.',
    campanhas: camps, locais: sites,
    laudos_total: laudos.length, nao_conformes: naoConforme,
    laudos,
  };
  const t = await grava(out);
  console.log(OUT_BLOB + ' OK · ' + Math.round(t / 1024) + ' KB · ' + laudos.length + ' laudos · '
    + camps.length + ' campanhas · ' + sites.length + ' locais · ' + naoConforme + ' nao conformes');
  const comUso = laudos.filter(l => l.uso_pior != null);
  const pior = comUso.slice().sort((a, b) => b.uso_pior - a.uso_pior)[0];
  console.log('   uso do limite calculado em ' + comUso.length + ' laudos em servico · pior caso: '
    + (pior ? pior.unidade + ' ' + pior.uso_pior + '%' : '—'));
  camps.forEach(c => console.log('   ' + c + ': ' + laudos.filter(l => l.camp === c).length + ' laudos'));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
