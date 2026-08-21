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

// ---- AGREGACOES ------------------------------------------------------------------------------
// Os 24 paineis nao recalculam media, ranking nem pivo em JSONata: recebem prontos. E o mesmo
// padrao do executivo.json (serie, serie_ufv, serie_e_media) e existe pela mesma razao — a regra
// de negocio num lugar so, e o painel reduzido a projecao.
//
// NENHUM ROTULO DE CAMPANHA VIRA NOME DE COLUNA nas tabelas. Coluna chamada "CO₂ 3ª/2026"
// apodrece na 4a coleta: o painel declara o seletor, o dado passa a trazer outro nome, e o
// Infinity devolve null SEM ERRO. As colunas tem nome estavel (co2_atu, co2_ant) e quem diz de
// que campanha se trata e o TITULO do painel, por variavel de dashboard — que o Grafana
// reinterpola a cada carga. A excecao e o barchart [541], que usa a tecnica de colunas dinamicas
// (columns: [] + $merge): ali o nome da coluna E a serie, e a ordem alfabetica das campanhas
// coincide com a cronologica.
const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;
const media = (lista, k, casas = 1) => {
  const v = lista.map(x => num(x[k])).filter(x => x != null);
  if (!v.length) return null;
  const m = v.reduce((a, b) => a + b, 0) / v.length;
  return Math.round(m * 10 ** casas) / 10 ** casas;
};
// data da campanha = MEDIANA das coletas dela. A campanha se estende por semanas ("jan-fev/25"),
// entao qualquer extremo desloca o ponto no eixo; a mediana fica no centro de massa da coleta.
function tsDe(lista) {
  const ds = lista.map(x => x.dcol).filter(Boolean).sort();
  if (!ds.length) return null;
  return ds[Math.floor(ds.length / 2)] + 'T12:00:00-03:00';
}
// os 11 parametros que o painel HTML acompanha campanha a campanha. Limite so onde a norma fixa
// valor de manutencao — gas dissolvido nao tem teto na NBR 10576, e linha inventada seria pior
// que linha nenhuma.
const PARAMS = [
  { k: 'rig', nome: 'Rigidez dielétrica', un: 'kV', lim: 40, sentido: 'min' },
  { k: 'fp', nome: 'Fator de potência', un: '%', lim: 0.5, sentido: 'max' },
  { k: 'ti', nome: 'Tensão interfacial', un: 'dina/cm', lim: 20, sentido: 'min' },
  { k: 'iN', nome: 'Índice de neutralização', un: 'mg KOH/g', lim: 0.2, sentido: 'max' },
  { k: 'agua', nome: 'Teor de água', un: 'ppm', lim: 40, sentido: 'max' },
  { k: 'dens', nome: 'Densidade', un: 'g/cm³', lim: null },
  { k: 'co', nome: 'CO', un: 'ppm', lim: null },
  { k: 'co2', nome: 'CO₂', un: 'ppm', lim: null },
  { k: 'tot', nome: 'Gases totais dissolvidos', un: 'ppm', lim: null },
  { k: 'o2', nome: 'O₂', un: 'ppm', lim: null },
  { k: 'r1', nome: 'Relação CO₂/CO', un: '', lim: null },
];
const ENSAIO_NOME = { rig: 'Rigidez', fp: 'Fator de potência', ti: 'Tensão interfacial',
  iN: 'Índ. neutralização', agua: 'Teor de água' };
// Os cinco gases combustiveis que denunciam falha, e o que a presenca de cada um aponta.
// ABNT NBR 7274:2026 para a interpretacao, IEC 60599 para os metodos de razao entre gases.
const GK = [['h2', 'H₂'], ['ch4', 'CH₄'], ['c2h6', 'C₂H₆'], ['c2h4', 'C₂H₄'], ['c2h2', 'C₂H₂']];
const NOTA_GAS = {
  'H₂': 'descargas parciais, arco ou eletrólise — acompanhar na próxima coleta',
  'CH₄': 'falha térmica de baixa temperatura, abaixo de 300 °C',
  'C₂H₆': 'sobreaquecimento moderado, de 150 a 300 °C',
  'C₂H₄': 'falha térmica severa, acima de 300 °C — em comutador é esperado com a comutação; avaliar contra o contador de operações',
  'C₂H₂': 'arco ou descarga de alta energia, acima de 700 °C — qualquer valor exige investigação',
};

function agrega(laudos, camps) {
  const rot = c => (laudos.find(l => l.camp === c) || {}).camp_rot || c;
  const ULT = camps[camps.length - 1], PEN = camps[camps.length - 2];
  const servico = laudos.filter(l => l.estado === SERV);
  const ultServ = servico.filter(l => l.camp === ULT);

  // [500] pior caso da frota por ensaio — o que decide se a frota esta confortavel nao e a media
  const resumo_ensaio = Object.entries(ENSAIO_NOME).map(([k, nome]) => {
    const cand = servico.filter(l => l['uso_' + k] != null)
      .sort((a, b) => b['uso_' + k] - a['uso_' + k])[0];
    return cand ? { ensaio: nome, uso: cand['uso_' + k], unidade: cand.unidade } : null;
  }).filter(Boolean).sort((a, b) => b.uso - a.uso);

  // [501] cobertura de cada coleta
  const campanhas_meta = camps.map(c => {
    const g = laudos.filter(l => l.camp === c);
    const ds = g.map(l => l.dcol).filter(Boolean).sort();
    return { camp: c, camp_rot: rot(c), analises: g.length,
      equipamentos: new Set(g.map(l => l.unidade)).size,
      em_servico: g.filter(l => l.estado === SERV).length,
      conformes: g.filter(l => l.st === 'CONFORME').length,
      primeira: ds[0] || null, ultima: ds[ds.length - 1] || null };
  });

  // locais que tem equipamento em servico — usado pelo comparativo e pelo CO2 por local.
  // O [502] NAO le daqui: ele faz a media sobre TODAS as campanhas em servico direto de
  // laudos, que e o numero que o humano revisou. Campo agregado que nenhum painel consome
  // e o que fez alguem procurar defeito no way2_monitor por um mes — nao entra.
  const locaisServ = [...new Set(servico.map(l => l.site))].sort();

  // [520]-[530] tendencia da frota, um ponto por campanha
  const tendencia = [];
  for (const p of PARAMS) for (const c of camps) {
    const g = laudos.filter(l => l.camp === c);
    tendencia.push({ param: p.nome, camp: c, camp_rot: rot(c), ts: tsDe(g), media: media(g, p.k, 3) });
  }

  // [540] mapa de calor · uma linha por unidade em servico na coleta mais recente
  const mapa = ultServ.map(l => ({ unidade: l.unidade,
    rig: l.uso_rig, fp: l.uso_fp, ti: l.uso_ti, iN: l.uso_iN, agua: l.uso_agua,
    co: num(l.co), co2: num(l.co2) }))
    .sort((a, b) => (b.rig || 0) - (a.rig || 0));

  // [541] CO2 por local em formato LONGO — o painel pivota com $merge e ganha a campanha nova
  // sozinho, sem que ninguem edite o painel
  const co2_local = [];
  for (const site of locaisServ) for (const c of camps) {
    const g = laudos.filter(l => l.site === site && l.camp === c);
    if (g.length) co2_local.push({ site, camp_rot: rot(c), co2: media(g, 'co2', 0) });
  }

  // [560]-[563] quatro rankings de oito. NAO sao alarmes: com a frota inteira conforme, o que
  // eles respondem e "por onde comecar a olhar na proxima coleta", que e outra pergunta.
  const co2U = {}, co2P = {};
  for (const l of laudos) { if (l.camp === ULT) co2U[l.unidade] = num(l.co2);
    if (l.camp === PEN) co2P[l.unidade] = num(l.co2); }
  const rank_co2 = Object.keys(co2U).filter(u => co2P[u] != null && co2U[u] != null)
    .map(u => ({ unidade: u, delta: Math.round(co2U[u] - co2P[u]), de_para: co2P[u] + ' → ' + co2U[u] }))
    .sort((a, b) => b.delta - a.delta).slice(0, 8).map((x, i) => Object.assign({ pos: i + 1 }, x));

  const rank_co = ultServ.filter(l => num(l.co) != null).sort((a, b) => b.co - a.co).slice(0, 8)
    .map((l, i) => ({ pos: i + 1, unidade: l.unidade, co: l.co,
      razao: l.co > 0 ? Math.round(l.co2 / l.co * 10) / 10 : null }));

  const rank_agua = ultServ.filter(l => num(l.agua) != null).sort((a, b) => b.agua - a.agua).slice(0, 8)
    .map((l, i) => ({ pos: i + 1, unidade: l.unidade, agua: l.agua, uso: l.uso_agua }));

  const rank_rig = ultServ.filter(l => l.uso_rig != null).sort((a, b) => b.uso_rig - a.uso_rig).slice(0, 8)
    .map((l, i) => ({ pos: i + 1, unidade: l.unidade, rig: l.rig, uso: l.uso_rig }));

  // [564] gases-chave acima de zero: a lista mais curta do painel, e a mais importante. Sem corte
  // de proposito — em frota saudavel ela deve ser curta, e conferir isso E o resultado.
  const gases_chave = [];
  for (const l of laudos.filter(x => x.camp === ULT)) for (const [k, nome] of GK)
    if (num(l[k]) != null && l[k] > 0)
      gases_chave.push({ unidade: l.unidade + (l.comutador ? ' (comutador)' : ''), gas: nome,
        ppm: l[k], indica: NOTA_GAS[nome] });

  // [565] comparativo por local, colunas de nome ESTAVEL
  const comparativo_local = locaisServ.map(site => {
    const a = laudos.filter(l => l.site === site && l.camp === PEN);
    const b = laudos.filter(l => l.site === site && l.camp === ULT);
    const ca = media(a, 'co2'), cb = media(b, 'co2');
    return { local: site, co2_ant: ca, co2_atu: cb,
      delta: (ca != null && cb != null) ? Math.round(cb - ca) : null,
      co_atu: media(b, 'co'), agua_atu: media(b, 'agua'), rig_atu: media(b, 'rig') };
  }).filter(x => x.co2_atu != null).sort((a, b) => (b.delta || 0) - (a.delta || 0));

  return { camp_atual: ULT, camp_atual_rot: rot(ULT), camp_anterior: PEN, camp_anterior_rot: rot(PEN),
    resumo_ensaio, campanhas_meta, tendencia, mapa, co2_local,
    rank_co2, rank_co, rank_agua, rank_rig, gases_chave, comparativo_local };
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
  // ordem CRONOLOGICA pelo numero da coleta. O sort alfabetico funciona por acidente ate a
  // 9a campanha e quebra na 10a — e quebraria calado, trocando qual e a "mais recente".
  const ordC = c => Number((/^(\d+)/.exec(String(c)) || [0, 0])[1]);
  const camps = [...new Set(laudos.map(l => l.camp))].sort((a, b) => ordC(a) - ordC(b));
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
  Object.assign(out, agrega(laudos, camps));
  const t = await grava(out);
  console.log(OUT_BLOB + ' OK · ' + Math.round(t / 1024) + ' KB · ' + laudos.length + ' laudos · '
    + camps.length + ' campanhas · ' + sites.length + ' locais · ' + naoConforme + ' nao conformes');
  const comUso = laudos.filter(l => l.uso_pior != null);
  const pior = comUso.slice().sort((a, b) => b.uso_pior - a.uso_pior)[0];
  console.log('   uso do limite calculado em ' + comUso.length + ' laudos em servico · pior caso: '
    + (pior ? pior.unidade + ' ' + pior.uso_pior + '%' : '—'));
  camps.forEach(c => console.log('   ' + c + ': ' + laudos.filter(l => l.camp === c).length + ' laudos'));
  console.log('   agregados: tendencia ' + out.tendencia.length + ' pontos · mapa ' + out.mapa.length
    + ' unidades · co2_local ' + out.co2_local.length + ' · gases-chave ' + out.gases_chave.length
    + ' ocorrencias · comparativo ' + out.comparativo_local.length + ' locais');
  console.log('   campanha atual ' + out.camp_atual_rot + ' · anterior ' + out.camp_anterior_rot);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
