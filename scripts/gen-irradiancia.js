/*
 * gen-irradiancia.js — solarimetria do SCADA por UFV, com AS FALHAS COMO DADO.
 *
 * FONTE: export do SCADA "IIRR_<AAAAMMDD>_<HHMMSS>.csv" — `;` como separador, BOM no inicio,
 *   coluna 1 = Timestamp e as demais no padrao
 *      UFV_<PARQUE>_WS_<ESTACAO> WS <GRANDEZA>[_2]
 *   As colunas com sufixo _2 sao duplicata do proprio export e vieram VAZIAS: ignoradas.
 *   Resolucao de 30 min. No export de 08/08/2026: 365 dias exatos, 17.520 linhas, sem buraco.
 *
 * MAPEAMENTO DAS ESTACOES -> NOSSAS UFVs. Nao confiei no nome: correlacionei a irradiancia diaria
 *   de cada estacao contra a serie que ja temos por UFV, um ano de dias (r de Pearson).
 *      MRT02->M2 .924   MRT03->M3 .908   MRT04->M4 .906   MRT05->M5 .922
 *      MRT06->M6 .912   MRT09->M9 .951   MRT10->M1 .920  <- confirma o "M10 = M1" da nomenclatura
 *   RESSALVA: MRT07 e MRT08 correlacionam mais alto com M9 (.946 e .917) do que com M7 (.917) e
 *   M8 (.908). Adotei a regra do nome (MRT0n = Mn) porque e consistente e porque a serie do M9 tem
 *   defeito conhecido — mas se algum dia o M7/M8 desta fonte divergir do resto, comecar por aqui.
 *
 * FILOSOFIA: o usuario quer o dado PARA achar o que esta errado. Entao nada e descartado em
 *   silencio. Cada leitura fora da faixa fisica e CONTADA e reportada, e o agregado sai em duas
 *   versoes — bruta (tudo) e limpa (so o que passa na faixa) — para a diferenca entre as duas ser
 *   ela mesma um indicador.
 *
 * Env: DADOS_STORAGE (RW no container dados).
 *   IIRR_LOCAL  = caminho de um CSV local (carga historica e testes)
 *   IIRR_URL    = CSV cru no blob — e o modo definitivo, quando a ponte SharePoint->blob existir
 *   nenhum dos dois = republica data/irr_seed.json, o historico ja processado que vive no repo.
 *     O seed existe para o painel funcionar ANTES da automacao; assim que IIRR_URL for definida,
 *     ele deixa de ser usado e o dado passa a vir do CSV.
 */
const fs = require('fs'), https = require('https'), readline = require('readline'), zlib = require('zlib');
const OUT_CONTAINER = 'dados', OUT_BLOB = 'irr_ufv.json';
// SAIDA EM DOIS GRUPOS:
//   irr_ufv.json          - o blob principal: serie diaria, mensal, qualidade e a lista dias_hora.
//   irr_hora_<mes>-<dia>  - UM ARQUIVO POR NIVEL DE ZOOM do painel (ver emiteNiveis).
// O Infinity BAIXA a URL e SO DEPOIS aplica o JSONata, entao filtrar no root_selector nao economiza
// um byte de rede: quem decide o peso e o recorte do ARQUIVO. Um blob unico com todo o semi-horario
// daria 8 MB, e um por mes daria 1,7 MB por mes cheio - em toda renderizacao, inclusive nos niveis
// que nao leem semi-horario nenhum. Um arquivo por nivel deixa cada visao em 32 a 158 KB.
// Janela de 120 dias para o semi-horario: inspecao ponto a ponto se faz em dia recente.
const HORA_PRE = 'irr_hora_', HORA_DIAS = 120;

// MRT0n = Mn, e MRT10 = M1 (ver o bloco de mapeamento acima)
const EST_UFV = { MRT02: 'M2', MRT03: 'M3', MRT04: 'M4', MRT05: 'M5', MRT06: 'M6',
  MRT07: 'M7', MRT08: 'M8', MRT09: 'M9', MRT10: 'M1' };

// FAIXA FISICA de cada grandeza. Fora dela, a leitura e contada como suspeita e fica fora do
// agregado LIMPO — mas continua no agregado BRUTO e no contador de qualidade.
// Os limites vieram da fisica do local (Mauriti, 7 S), nao de gosto:
//   GTI acima de 1400 nao existe nem com reflexao; DNI nao passa da constante solar na superficie;
//   difusa acima de 600 significa que o sensor nao esta medindo difusa; modulo a 85 C ja e limite
//   de catalogo; 30 m/s e vendaval, 75 m/s e furacao categoria 4 no sertao do Ceara.
const FAIXA = {
  'IRRADIAÇÃO INCLINADA': [0, 1400], 'IRRADIAÇÃO DIFUSA': [0, 600], 'IRRADIAÇÃO DIRETA': [0, 1100],
  'IRRADIAÇÃO ALBEDO DE CIMA': [0, 1400], 'IRRADIAÇÃO ALBEDO DE BAIXO': [0, 600],
  'TAXA DE ALBEDO': [0, 100],
  'TEMPERATURA MÓDULO 1': [-5, 85], 'TEMPERATURA MÓDULO 2': [-5, 85],
  'TEMPERATURA MÓDULO 3': [-5, 85], 'TEMPERATURA MÓDULO 4': [-5, 85],
  'TEMPERATURA AMBIENTE': [5, 48], 'TEMPERATURA INTERNA': [0, 70],
  'UMIDADE RELATIVA DO AR': [0, 100], 'PONTO DE CONDENSAÇÃO': [-5, 35],
  'VELOCIDADE VENTO': [0, 30], 'DIREÇÃO VENTO': [0, 360],
  'PRECIPITAÇÃO': [0, 60],
  'SENSOR DE SUJEIRA 1': [0, 105], 'SENSOR DE SUJEIRA 2': [0, 105],
  // perda por sujeira oscila em torno de ZERO quando o modulo esta limpo, e o par de celulas nao
  // e calibrado entre si — negativo de alguns pontos e RUIDO, nao defeito. Minha faixa inicial de
  // -1 reprovava 49% das leituras do M9 e apontava "sensor suspeito" onde havia painel limpo.
  // Faixa alargada para -5: abaixo disso, sim, e inversao ou par trocado.
  'TAXA DE PERDA POR SUJEIRA 1': [-5, 25], 'TAXA DE PERDA POR SUJEIRA 2': [-5, 25],
  'TENSÃO DA BATERIA': [8, 16],
};
// as que se INTEGRAM no tempo (energia); as demais se promediam
const INTEGRA = new Set(['IRRADIAÇÃO INCLINADA', 'IRRADIAÇÃO DIFUSA', 'IRRADIAÇÃO DIRETA',
  'IRRADIAÇÃO ALBEDO DE CIMA', 'IRRADIAÇÃO ALBEDO DE BAIXO']);
const SOMA = new Set(['PRECIPITAÇÃO']);           // chuva acumula
// Tetos do DIA, para pegar sensor travado — a faixa fisica por leitura nao pega (ver o bloco do
// "dia impossivel"). 11 kWh/m2/dia fica acima do maior real medido no ano (10,72 no M2) e abaixo do
// primeiro impossivel (12,30 no M9); 5 W/m2 de media entre 21h e 03h e generoso para ruido de
// piranometro; 3 valores distintos em 48 leituras so acontece com registro repetido.
const GTI_DIA_MAX = 11, GTI_NOITE_MAX = 5, GTI_VALORES_MIN = 3;
// Corte de "esta com sol", para a media diaria em W/m2. 5 W/m2 nao e escolha minha: e o mesmo corte
// que o gen-executivo.js usa no irr do ONS (`util = irr > 5`), e so com o MESMO corte as duas medias
// sao comparaveis. Irradiancia e W/m2 (potencia) e irradiacao e kWh/m2 (energia): sao grandezas
// diferentes, entao emito as DUAS, e a hora de sol e o que liga uma na outra de forma auditavel.
const SOL_MIN = 5;
const H_SLOT = 0.5;                               // horas por leitura (30 min)
const DIURNO = [8, 15];                           // janela de sol alto p/ contar zero suspeito

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);

function fonteLinhas() {
  const local = process.env.IIRR_LOCAL;
  if (local) return readline.createInterface({ input: fs.createReadStream(local, 'utf8'), crlfDelay: Infinity });
  const url = process.env.IIRR_URL;
  if (!url) throw new Error('defina IIRR_URL (blob) ou IIRR_LOCAL (arquivo)');
  const { PassThrough } = require('stream');
  const pt = new PassThrough();
  https.get(url, r => { if (r.statusCode >= 300) pt.destroy(new Error('HTTP ' + r.statusCode)); else r.pipe(pt); })
    .on('error', e => pt.destroy(e));
  return readline.createInterface({ input: pt, crlfDelay: Infinity });
}

async function writeOut(obj, nome) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    // mesmo diretorio do LOCAL_OUT, mas com o nome do blob. Sem isso os dois writeOut escreviam no
    // MESMO arquivo e a serie horaria era sobrescrita pela diaria — o seed horario simplesmente nao
    // aparecia, sem erro nenhum.
    const alvo = nome
      ? process.env.LOCAL_OUT.split(/[\\/]/).slice(0, -1).concat(nome).join('/')
      : process.env.LOCAL_OUT;
    fs.writeFileSync(alvo, json); return json.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(nome || OUT_BLOB).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  return json.length;
}

// UM ARQUIVO POR NIVEL DE ZOOM, nomeado pelo par (mes, dia) que o painel monta na URL com as duas
// variaveis do filtro:
//    irr_hora_tudo-tudo.json      -> a serie mensal      (visao do ano)
//    irr_hora_<mes>-tudo.json     -> os dias daquele mes (visao do mes)
//    irr_hora_<mes>-<dd>.json     -> o semi-horario daquele dia, 48 pontos (visao do dia)
// Cada arquivo carrega SO o nivel que o painel vai ler naquele estado, e nada mais. E o que mantem a
// pagina leve: um mes cheio de semi-horario da 1,7 MB, e a visao por dia precisa de 40 KB desse total.
//
// Por que UM alvo por painel, e nao um alvo por nivel: com dois alvos, o do nivel inativo devolve [],
// o Infinity responde um frame SEM CAMPO NENHUM e o trend morre em "Unable to find field: x"; e quando
// os dois trazem coluna de mesmo nome, o joinByField cola o refId no nome da serie e a legenda vira
// "Módulo B". Com um alvo, a URL escolhe o nivel e nenhum dos dois acontece.
//
// TODA combinacao que os filtros podem produzir precisa existir — URL que nao resolve deixa o painel
// em ERRO VERMELHO, nao vazio. O filtro de dia se alimenta de `dias_hora`, entao as combinacoes
// possiveis sao exatamente: (tudo,tudo), (cada mes,tudo) e (cada dia de dias_hora).
// Os arquivos do formato anterior (irr_hora_<mes>.json, sem o dia) recebem LAPIDE: sem isso ficariam
// no container com nome plausivel e dado congelado, esperando alguem apontar para eles.
async function emiteNiveis(meta, semihora, serieDia, serieMes, mesesTodos, antigos) {
  const shDia = {}, diaMes = {};
  semihora.forEach(l => (shDia[l.dia] = shDia[l.dia] || []).push(l));
  (serieDia || []).forEach(l => (diaMes[l.mes] = diaMes[l.mes] || []).push(l));
  let n = 0, bytes = 0;
  const grava = async (nome, obj) => { bytes += await writeOut(Object.assign({}, meta, obj), nome); n++; };

  await grava(HORA_PRE + 'tudo-tudo.json', { nivel: 'mes', serie_mes: serieMes || [] });
  for (const m of [...new Set(mesesTodos || [])].sort()) {
    await grava(HORA_PRE + m + '-tudo.json', { nivel: 'dia', mes: m, serie_dia: diaMes[m] || [] });
  }
  for (const d of Object.keys(shDia).sort()) {
    // o `dia` sai das linhas: o arquivo INTEIRO e daquele dia, repetir a data 432 vezes e desperdicio
    const rows = shDia[d].map(({ dia, ...r }) => r);
    await grava(HORA_PRE + d.slice(0, 7) + '-' + d.slice(8, 10) + '.json',
      { nivel: 'semihora', dia: d, resolucao_min: 30, serie_semihora: rows });
  }
  for (const nome of antigos || []) {
    await grava(nome, { obsoleto: 'Formato antigo (um pacote por mes). O painel agora le um arquivo '
      + 'por nivel de zoom: irr_hora_<mes>-tudo.json para os dias do mes e irr_hora_<mes>-<dd>.json '
      + 'para o semi-horario do dia. Este arquivo nao e mais atualizado.' });
  }
  return { arquivos: n, bytes, dias: Object.keys(shDia).length, linhas: semihora.length };
}

// os seeds vao GZIPADOS no repo: o semi-horario cru da 6 MB, e cada regeracao gravaria 6 MB novos no
// historico do git (blob binario nao se delta-comprime). Gzipado da ~600 KB, e ler custa uma linha.
const leSeed = cam => JSON.parse(zlib.gunzipSync(fs.readFileSync(cam)).toString('utf8'));

(async () => {
  // modo seed: sem CSV nenhum, republica o historico do repo e sai
  if (!process.env.IIRR_LOCAL && !process.env.IIRR_URL) {
    const seed = 'data/irr_seed.json.gz';
    if (!fs.existsSync(seed)) throw new Error('sem IIRR_URL/IIRR_LOCAL e sem ' + seed);
    const j = leSeed(seed);
    j.modo = 'seed';
    j.nota_seed = 'Historico processado do export IIRR de 08/08/2026, versionado no repo. '
      + 'Enquanto a ponte SharePoint -> blob nao existir, e esta a fonte do painel. '
      + 'Definir IIRR_URL no workflow faz o gerador voltar a ler o CSV cru.';
    const seedH = 'data/irr_hora_seed.json.gz';
    if (fs.existsSync(seedH)) {
      const h = leSeed(seedH);
      const linhas = h.serie_semihora || [];
      // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode
      // oferecer dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
      j.dias_hora = [...new Set(linhas.map(x => x.dia))].sort();
      const rh = await emiteNiveis({ gerado_em: h.gerado_em, fonte: h.fonte,
        nota: h.nota, ufvs: h.ufvs, modo: 'seed' }, linhas, j.serie_dia || [], j.serie_mes || [],
      j.meses || [], (j.meses || []).concat('tudo').map(m => HORA_PRE + m + '.json'));
      console.log('niveis republicados do seed · ' + rh.arquivos + ' arquivos · '
        + Math.round(rh.bytes / 1024) + ' KB · ' + rh.dias + ' dias · ' + rh.linhas + ' linhas de 30 min');
    }
    const t = await writeOut(j);
    console.log('irr_ufv.json republicado do seed · ' + Math.round(t / 1024) + ' KB · '
      + (j.serie_dia || []).length + ' linhas diarias · ' + (j.dias_hora || []).length
      + ' dias com hora · janela ' + j.janela.ini + ' a ' + j.janela.fim);
    return;
  }
  const rl = fonteLinhas();
  let cab = null;
  const mapa = [];                 // { i, ufv, gr }
  const acc = {};                  // dia -> ufv -> gr -> {sB,nB,sL,nL,minL,maxL,fora,zd,nd}
  // acumulador HORARIO: o painel precisa descer ao dia e mostrar as 24 horas. Guardo so as
  // grandezas que se leem numa curva de dia — nao as 22, senao o blob passa de 20 MB.
  // TODAS as grandezas vao para o semi-horario, nao so as seis do inicio: cada variavel da
  // solarimetria tem painel proprio e precisa descer ao dia igual as outras. Como o arquivo e por DIA,
  // o custo e pequeno — o arquivo do dia sai de 43 KB para ~130 KB, e so um dia e baixado por vez.
  const HORA_GR = new Set(Object.keys(FAIXA));
  const accH = {};                 // dia|ufv|hora -> gr -> {s,n}
  const qual = {};                 // ufv -> gr -> {n,vazio,fora,zd,nd,min,max}
  let nLinhas = 0, tsIni = null, tsFim = null;

  for await (const linha of rl) {
    if (!linha.trim()) continue;
    const cols = linha.replace(/^﻿/, '').split(';');
    if (!cab) {
      cab = cols;
      cab.forEach((c, i) => {
        const m = c.match(/^UFV_([^_]+)_WS_(\S+)\s+WS\s+(.+?)(_\d+)?$/);
        if (!m || m[4]) return;                       // _2 = duplicata vazia do export
        const ufv = EST_UFV[m[1]];
        if (!ufv || !FAIXA[m[3]]) return;             // estacao ou grandeza que nao conheco
        mapa.push({ i, ufv, gr: m[3] });
      });
      if (!mapa.length) throw new Error('nenhuma coluna reconhecida — o layout do export mudou?');
      continue;
    }
    nLinhas++;
    const ts = cols[0]; if (!tsIni) tsIni = ts; tsFim = ts;
    const d = ts.slice(0, 10), hh = +ts.slice(11, 13);
    const diurno = hh >= DIURNO[0] && hh <= DIURNO[1];
    for (const m of mapa) {
      const bruto = cols[m.i];
      // min/max em DUAS versoes: o que o sensor reportou (bruto) e o que passou na faixa (limpo).
      // Na primeira versao eu so guardava o limpo — e ai a tabela de qualidade dizia "fora da faixa
      // 8.619 leituras, max 0,99", que nao explica nada. O valor que denuncia o sensor e justamente
      // o que a faixa recusou.
      const q = ((qual[m.ufv] = qual[m.ufv] || {})[m.gr] = qual[m.ufv][m.gr]
        || { n: 0, vazio: 0, fora: 0, foraBaixo: 0, foraAlto: 0, zd: 0, nd: 0,
          min: null, max: null, minB: null, maxB: null });
      const o = (((acc[d] = acc[d] || {})[m.ufv] = acc[d][m.ufv] || {})[m.gr] = acc[d][m.ufv][m.gr]
        || { sB: 0, nB: 0, sL: 0, nL: 0, maxL: null, fora: 0, zd: 0, nd: 0 });
      if (bruto === '' || bruto == null) { q.vazio++; continue; }
      const x = Number(String(bruto).replace(',', '.'));
      if (!isFinite(x)) { q.vazio++; continue; }
      q.n++;
      if (q.minB == null || x < q.minB) q.minB = x;
      if (q.maxB == null || x > q.maxB) q.maxB = x;
      o.sB += x; o.nB++;
      if (m.gr === 'IRRADIAÇÃO INCLINADA') {
        // NOITE e VALORES DISTINTOS: os dois detectores de sensor travado. Ficam aqui, no BRUTO, antes
        // do teste de faixa, porque sensor pinado passa na faixa fisica sem reclamar — 912,84 W/m2 e
        // um valor perfeitamente possivel ao meio-dia.
        if (hh >= 21 || hh <= 3) { o.sN = (o.sN || 0) + x; o.nN = (o.nN || 0) + 1; }
        (o.vals = o.vals || new Set()).add(x);
      }
      if (diurno) { o.nd++; q.nd++; if (x === 0) { o.zd++; q.zd++; } }
      const [lo, hi] = FAIXA[m.gr];
      if (x < lo || x > hi) {
        q.fora++; o.fora++;
        if (x < lo) q.foraBaixo++; else q.foraAlto++;   // por que lado escapou: o lado e o diagnostico
        continue;                                       // suspeita: fica fora do LIMPO
      }
      o.sL += x; o.nL++;
      if (m.gr === 'IRRADIAÇÃO INCLINADA' && x > SOL_MIN) { o.sS = (o.sS || 0) + x; o.nS = (o.nS || 0) + 1; }
      if (HORA_GR.has(m.gr)) {
        // SLOT de 30 min (0..47), nao a hora: e a resolucao nativa do export e a mesma que o ONS
        // publica (semi-hora), entao a visao por dia nao agrega nada — mostra a leitura como ela veio.
        // Dois digitos de proposito: a serie sai ordenada por Object.keys().sort(), que e ordenacao de
        // TEXTO — com o indice cru, '10' vinha antes de '2' e o trend recusava a serie inteira com
        // "Values must be in ascending order".
        const slot = hh * 2 + (+ts.slice(14, 16) >= 30 ? 1 : 0);
        const kh = d + '|' + m.ufv + '|' + String(slot).padStart(2, '0');
        const oh = ((accH[kh] = accH[kh] || {})[m.gr] = accH[kh][m.gr] || { s: 0, n: 0 });
        oh.s += x; oh.n++;
      }
      if (o.maxL == null || x > o.maxL) o.maxL = x;
      if (q.min == null || x < q.min) q.min = x;
      if (q.max == null || x > q.max) q.max = x;
    }
  }

  const ufvs = [...new Set(mapa.map(m => m.ufv))].sort();
  const grs = [...new Set(mapa.map(m => m.gr))].sort();
  const dias = Object.keys(acc).sort();
  const SLOTS = 48;

  // ---------- serie diaria ----------
  const valor = (o, gr, limpo) => {
    if (!o) return null;
    const s = limpo ? o.sL : o.sB, n = limpo ? o.nL : o.nB;
    if (!n) return null;
    if (INTEGRA.has(gr)) return r3(s * H_SLOT / 1000);     // W/m2 -> kWh/m2
    if (SOMA.has(gr)) return r2(s);
    return r2(s / n);
  };
  const CAMPO = {
    'IRRADIAÇÃO INCLINADA': 'gti', 'IRRADIAÇÃO DIFUSA': 'dif', 'IRRADIAÇÃO DIRETA': 'dni',
    'IRRADIAÇÃO ALBEDO DE CIMA': 'alb_cima', 'IRRADIAÇÃO ALBEDO DE BAIXO': 'alb_baixo',
    'TAXA DE ALBEDO': 'albedo', 'TEMPERATURA MÓDULO 1': 't_mod1', 'TEMPERATURA MÓDULO 2': 't_mod2',
    'TEMPERATURA MÓDULO 3': 't_mod3', 'TEMPERATURA MÓDULO 4': 't_mod4',
    'TEMPERATURA AMBIENTE': 't_amb', 'TEMPERATURA INTERNA': 't_int',
    'UMIDADE RELATIVA DO AR': 'umid', 'PONTO DE CONDENSAÇÃO': 't_orvalho',
    'VELOCIDADE VENTO': 'vento', 'DIREÇÃO VENTO': 'vento_dir', 'PRECIPITAÇÃO': 'chuva',
    'SENSOR DE SUJEIRA 1': 'suj1', 'SENSOR DE SUJEIRA 2': 'suj2',
    'TAXA DE PERDA POR SUJEIRA 1': 'perda_suj1', 'TAXA DE PERDA POR SUJEIRA 2': 'perda_suj2',
    'TENSÃO DA BATERIA': 'bateria',
  };
  const serie_dia = [];
  dias.forEach(d => ufvs.forEach(u => {
    const g = (acc[d] || {})[u]; if (!g) return;
    const l = { dia: d, mes: d.slice(0, 7), dia_num: +d.slice(8, 10), ufv: u };
    grs.forEach(gr => {
      const k = CAMPO[gr]; if (!k) return;
      l[k] = valor(g[gr], gr, true);
      if (gr === 'IRRADIAÇÃO INCLINADA') {
        l.gti_bruta = valor(g[gr], gr, false);
        l.gti_pico_w = r2((g[gr] || {}).maxL);
      }
    });
    // bandeiras do dia: sao dado, nao enfeite
    const inc = g['IRRADIAÇÃO INCLINADA'] || {};
    l.leituras = inc.nB || 0;
    l.cobertura_pct = r2(100 * (inc.nB || 0) / SLOTS);
    l.fora_faixa = Object.values(g).reduce((a, o) => a + (o.fora || 0), 0);
    l.zeros_diurnos = inc.zd || 0;
    l.gti_noite_w = inc.nN ? r2(inc.sN / inc.nN) : null;
    // ALBEDO pela razao das INTEGRAIS do dia, em %. A "TAXA DE ALBEDO" que o SCADA reporta e uma
    // razao instantanea, e razao com denominador indo a zero explode: ao meio-dia ela vem 0,19 e a
    // media do dia sai 3,97, com maximos de 1.625 a 1.843 no ano. Nao e sensor quebrado nem escala
    // trocada (eu havia suposto que fosse irradiancia refletida crua) — e ruido de divisao no
    // amanhecer, no crepusculo e na noite. A razao dos acumulados nao tem esse problema e da o numero
    // fisico esperado para solo e areia, algo entre 15% e 30%.
    // com piso no denominador e faixa fisica: sem o piso, um dia em que a integral de cima ficou em
    // 0,001 kWh/m2 devolvia 27.000%; e albedo de solo/areia vive entre 15% e 30% (neve fresca chega a
    // 90%, e nao neva no Ceara), entao fora de 5% a 60% e defeito, nao terreno.
    l.albedo_calc = (l.alb_cima > 0.5 && l.alb_baixo != null)
      ? (v => (v >= 5 && v <= 60 ? v : null))(r2(100 * l.alb_baixo / l.alb_cima)) : null;
    // a MESMA medida do dia em W/m2: media das leituras com sol, e a duracao do dia solar que faz a
    // ponte com o kWh/m2. Media em 24 h daria metade disso — por isso a janela vai declarada.
    l.gti_sol_w = inc.nS ? r2(inc.sS / inc.nS) : null;
    l.gti_horas_sol = inc.nS ? r2(inc.nS * H_SLOT) : null;
    l.gti_valores = inc.vals ? inc.vals.size : null;
    // DIA IMPOSSIVEL — tres testes, cada um com um defeito diferente atras:
    //   total do dia acima do teto fisico: nao existe em Mauriti (o maior real do ano foi 10,72);
    //   irradiancia a NOITE: o sol nao esta la, entao e offset ou leitura congelada;
    //   pouquissimos valores distintos no dia: o SCADA repetiu o ultimo registro.
    // O caso que trouxe isso: M9, 10 a 18/08/2025 — NOVE dias com 21,91 kWh/m2 identicos e pico
    // identico de 912,84 W/m2. E 912,84 x 24 h / 1000 = 21,91: o sensor ficou pinado num valor, dia e
    // noite. A faixa fisica nao pega, e o dia impossivel dominava sozinho a escala do grafico do ano.
    // O dia impossivel sai do LIMPO (gti = null) mas o bruto FICA, e a serie horaria fica intacta —
    // e nela que se ve a linha reta que denuncia o sensor.
    const impossivel = (l.gti_bruta != null && l.gti_bruta > GTI_DIA_MAX)
      || (l.gti_noite_w != null && l.gti_noite_w > GTI_NOITE_MAX)
      || (l.gti_valores != null && l.gti_valores <= GTI_VALORES_MIN && (inc.nB || 0) > 10);
    l.gti_impossivel = impossivel ? 1 : 0;
    if (impossivel) { l.gti = null; l.gti_sol_w = null; }
    l.suspeito = (l.cobertura_pct < 95 || l.fora_faixa > 0 || (inc.zd || 0) > 2 || impossivel) ? 1 : 0;
    serie_dia.push(l);
  }));

  // ---------- serie mensal ----------
  const meses = [...new Set(dias.map(d => d.slice(0, 7)))].sort();
  const serie_mes = [];
  meses.forEach(m => ufvs.forEach(u => {
    const L = serie_dia.filter(x => x.mes === m && x.ufv === u);
    if (!L.length) return;
    const som = k => { const v = L.map(x => x[k]).filter(x => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0)) : null; };
    const med = k => { const v = L.map(x => x[k]).filter(x => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    serie_mes.push({ mes: m, ufv: u, dias: L.length,
      gti_kwh: som('gti'), gti_dia: med('gti'), dif_kwh: som('dif'), dni_kwh: som('dni'),
      gti_sol_w: med('gti_sol_w'), horas_sol: med('gti_horas_sol'),
      t_mod: med('t_mod1'), t_amb: med('t_amb'), umid: med('umid'), vento: med('vento'),
      chuva_mm: som('chuva'), albedo: med('albedo'),
      // media DIARIA das que se integram, para o nivel "All" de cada painel (o _kwh e soma do mes)
      dif_dia: med('dif'), dni_dia: med('dni'),
      alb_cima_dia: med('alb_cima'), alb_baixo_dia: med('alb_baixo'),
      // e as que ainda nao tinham agregado mensal nenhum
      t_mod2: med('t_mod2'), t_mod3: med('t_mod3'), t_mod4: med('t_mod4'),
      t_int: med('t_int'), t_orvalho: med('t_orvalho'), vento_dir: med('vento_dir'),
      suj1: med('suj1'), suj2: med('suj2'), bateria: med('bateria'),
      albedo_calc: med('albedo_calc'),
      gti_pico_w: med('gti_pico_w'),
      dias_impossiveis: som('gti_impossivel'),
      perda_suj1: med('perda_suj1'), perda_suj2: med('perda_suj2'),
      dias_suspeitos: L.filter(x => x.suspeito).length,
      fora_faixa: L.reduce((a, x) => a + (x.fora_faixa || 0), 0) });
  }));

  // ---------- serie HORARIA ----------
  // As leituras sao de 30 min; duas por hora. Irradiancia vira POTENCIA MEDIA da hora em W/m2 (media
  // das duas), que na janela de 1 h e tambem a energia em Wh/m2. As demais sao media simples.
  // Mesmos nomes da serie diaria, com UMA excecao deliberada: as grandezas que se integram no tempo
  // mudam de GRANDEZA entre os niveis — no dia sao potencia (W/m2) e no acumulado sao energia
  // (kWh/m2) — entao ganham sufixo _w para nao se passarem uma pela outra.
  const CAMPO_H = {};
  Object.entries(CAMPO).forEach(([gr, campo]) => {
    CAMPO_H[gr] = INTEGRA.has(gr) ? campo + '_w' : campo;
  });
  // `t` = hora decimal (0, 0.5, 1 ... 23.5). E o x do painel: numero que sobe, sem depender de
  // mapeamento, e que no eixo se le como hora. `mes` NAO vai na linha — o arquivo ja e de um mes so,
  // e repeti-lo 12.960 vezes custava 230 KB por mes de nada.
  const serie_semihora = [];
  Object.keys(accH).sort().forEach(k => {
    const [d, u, slot] = k.split('|');
    const g = accH[k];
    const l = { dia: d, ufv: u, t: +slot / 2 };
    let algum = false;
    Object.entries(CAMPO_H).forEach(([gr, campo]) => {
      const o = g[gr];
      if (o && o.n) { l[campo] = r2(o.s / o.n); algum = true; }
    });
    if (algum) serie_semihora.push(l);
  });

  // ---------- tabela de QUALIDADE: e o entregavel principal ----------
  const qualidade = [];
  ufvs.forEach(u => grs.forEach(gr => {
    const q = (qual[u] || {})[gr]; if (!q) return;
    const total = q.n + q.vazio;
    const foraPct = q.n ? 100 * q.fora / q.n : 0;
    const zdPct = q.nd ? 100 * q.zd / q.nd : 0;
    qualidade.push({ ufv: u, grandeza: gr, campo: CAMPO[gr] || null,
      faixa_lo: FAIXA[gr][0], faixa_hi: FAIXA[gr][1],
      leituras: q.n, vazias: q.vazio, cobertura_pct: r2(total ? 100 * q.n / total : 0),
      fora_faixa: q.fora, fora_pct: r3(foraPct),
      fora_abaixo: q.foraBaixo, fora_acima: q.foraAlto,
      min_bruto: r2(q.minB), max_bruto: r2(q.maxB),
      zeros_diurnos: q.zd, zeros_diurnos_pct: r3(zdPct),
      min: r2(q.min), max: r2(q.max),
      veredito: q.n === 0 ? 'sem dado'
        : foraPct > 1 ? 'sensor suspeito'
          : zdPct > 2 ? 'falhas diurnas'
            : q.fora > 0 ? 'picos isolados' : 'ok' });
  }));

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'SCADA · export IIRR (estações solarimétricas), 30 min. Energia = média da leitura × 0,5 h. '
      + 'Duas versões de cada agregado: LIMPA (só o que passa na faixa física) e BRUTA (tudo). '
      + 'A diferença entre as duas é indicador de sensor.',
    janela: { ini: tsIni, fim: tsFim }, resolucao_min: 30, linhas: nLinhas,
    mapeamento: EST_UFV, faixa_fisica: FAIXA,
    ufvs, grandezas: grs, dias: dias.length, meses,
    serie_dia, serie_mes, qualidade,
  };
  // a horaria sai antes, em um arquivo por mes, so os ultimos HORA_DIAS dias
  const corte = dias.slice(-HORA_DIAS)[0];
  const hora = serie_semihora.filter(x => x.dia >= corte);
  // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode oferecer
  // dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
  out.dias_hora = [...new Set(hora.map(x => x.dia))].sort();
  const rh = await emiteNiveis({
    gerado_em: out.gerado_em, fonte: out.fonte,
    nota: 'UM ARQUIVO POR NIVEL DE ZOOM do painel: tudo-tudo = serie mensal, <mes>-tudo = os dias do '
      + 'mes, <mes>-<dd> = o semi-horario do dia (30 min, resolucao nativa do export e a mesma que o '
      + 'ONS publica). Cada arquivo carrega so o nivel que o painel le naquele estado. '
      + 'Irradiancia em W/m2 — potencia, como o sensor e o ONS reportam.',
    janela: { ini: corte, fim: dias[dias.length - 1] }, ufvs,
  }, hora, serie_dia, serie_mes, meses, meses.concat('tudo').map(m => HORA_PRE + m + '.json'));
  console.log('niveis OK · ' + rh.arquivos + ' arquivos · ' + Math.round(rh.bytes / 1024) + ' KB · '
    + rh.dias + ' dias de 30 min desde ' + corte);

  const tam = await writeOut(out);
  console.log('irr_ufv.json OK · ' + Math.round(tam / 1024) + ' KB');
  console.log('  janela ' + tsIni + ' a ' + tsFim + '  ·  ' + nLinhas + ' linhas  ·  ' + dias.length + ' dias');
  console.log('  ' + ufvs.length + ' UFVs · ' + grs.length + ' grandezas · ' + serie_dia.length
    + ' linhas diarias · ' + serie_semihora.length + ' linhas de 30 min');
  const ruins = qualidade.filter(q => q.veredito !== 'ok');
  console.log('  qualidade: ' + (qualidade.length - ruins.length) + ' de ' + qualidade.length + ' series ok');
  ruins.sort((a, b) => b.fora_pct - a.fora_pct).slice(0, 12).forEach(q =>
    console.log('     ' + q.ufv + ' · ' + q.grandeza.padEnd(30) + q.veredito.padEnd(17)
      + 'fora ' + String(q.fora_faixa).padStart(5) + ' (' + String(q.fora_pct).padStart(6) + '%)'
      + '  abaixo ' + String(q.fora_abaixo).padStart(5) + '  acima ' + String(q.fora_acima).padStart(4)
      + '   bruto ' + q.min_bruto + ' a ' + q.max_bruto));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
