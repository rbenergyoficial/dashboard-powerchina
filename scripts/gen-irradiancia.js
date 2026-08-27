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
 *   IIRR_LOCAL     = caminho de um CSV local (carga historica e testes)
 *   IIRR_CONTAINER = container do blob com os CSV crus (ex.: scada-raw). O gerador LISTA e pega o
 *     export MAIS RECENTE. E o modo definitivo: o nome do export e datado, entao URL fixa apodrece
 *     no proximo export — e foi exatamente a falta de endereco estavel que manteve este gerador
 *     preso na semente. Precisa de DADOS_STORAGE, que o workflow ja tem.
 *   IIRR_URL       = um CSV especifico por URL (util para apontar um export antigo a mao)
 *   nenhum dos dois = republica data/irr_seed.json, o historico ja processado que vive no repo.
 *     O seed existe para o painel funcionar ANTES da automacao; assim que IIRR_URL for definida,
 *     ele deixa de ser usado e o dado passa a vir do CSV.
 */
const fs = require('fs'), https = require('https'), readline = require('readline'), zlib = require('zlib');
const OUT_CONTAINER = 'dados', OUT_BLOB = 'irr_ufv.json';
// SAIDA EM DOIS GRUPOS:
//   irr_ufv.json          - o blob principal: serie diaria, mensal, qualidade e a lista dias_hora.
//   irr_<familia>_<res>   - UM ARQUIVO POR FAMILIA DE GRANDEZA (ver emiteFamilias). Os
//                           antigos por nivel de zoom (irr_hora_*) foram aposentados
//                           em 26/08/2026 e hoje so carregam lapide.
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

// ---------- O CONJUNTO: a media das nove estacoes ----------------------------------------------
//
// 🔴 TODA grandeza da solarimetria e INTENSIVA — W/m2, kWh/m2, graus, %, m/s, mm. NENHUMA se soma:
//    a do conjunto e a MEDIA das estacoes. Somar irradiancia daria nove sois. Nao ha aqui a
//    duvida que existe na energia, onde o conjunto e soma; e por isso que este agregado nao herda
//    a regra do MUST nem a do comparativo.
//
// 🔴 TUDO-OU-NADA, e POR CAMPO. Media sobre subconjunto variavel muda sozinha quando uma estacao
//    cai, e o painel mostra a mudanca como se fosse do ceu. Medido em 26/08/2026 nos 333 dias
//    completos: tirar uma estacao desloca a media diaria em 0,37% na media do ano e ate 12,50%
//    num dia. O custo do tudo-ou-nada foi medido junto e e pequeno: a irradiancia no plano perde
//    31 dias de 364, e eles sao um bloco so (08/08 a 05/09/2025, antes de a estacao do M9
//    reportar); as demais grandezas perdem 1 dia.
//
// ⚠️ POR CAMPO, nao por linha, porque a cobertura difere entre grandezas: a irradiancia no plano
//    tem 333 dias completos e a difusa tem 363. Uma regra por linha descartaria a difusa nos dias
//    em que faltou so a do plano — jogaria fora dado bom por causa do vizinho.
//
// ⚠️ CONTAGEM nao e media: `dias` vale o mesmo nas nove e a media de contagem daria fracao de dia.
//    Vai o maximo.
const COMPLEXO = 'Complexo';

function agregaComplexo(linhas, chaves, opts) {
  const o = opts || {};
  const us = [...new Set((linhas || []).map(l => l.ufv))].filter(u => u !== COMPLEXO);
  if (us.length < 2) return [];
  const grupos = new Map();
  for (const l of linhas) {
    if (l.ufv === COMPLEXO) continue;
    const k = chaves.map(c => l[c]).join('');
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(l);
  }
  const out = [];
  for (const ls of grupos.values()) {
    if (ls.length !== us.length) continue;                 // o grupo precisa das nove estacoes
    const linha = { ufv: COMPLEXO };
    for (const c of chaves) linha[c] = ls[0][c];
    const campos = new Set();
    for (const l of ls) for (const k of Object.keys(l)) campos.add(k);
    for (const k of campos) {
      if (k === 'ufv' || chaves.includes(k)) continue;
      const nums = ls.map(l => l[k]).filter(v => typeof v === 'number' && isFinite(v));
      if (nums.length === us.length) {
        linha[k] = (o.contagens || []).includes(k)
          ? Math.max(...nums)
          : r2(nums.reduce((a, b) => a + b, 0) / nums.length);
        continue;
      }
      // campo nao numerico igual nas nove viaja junto; qualquer outra coisa vira nulo declarado —
      // a CHAVE tem de existir, senao o Infinity infere coluna a menos na linha do conjunto
      const vals = new Set(ls.map(l => l[k]));
      linha[k] = (nums.length === 0 && vals.size === 1) ? ls[0][k] : null;
    }
    // 🔴 TOTAL DO MES so existe se as nove somaram o MESMO numero de dias. Medido em 26/08/2026:
    //    em set/2025 o M9 mediu 23 dias e as outras oito mediram 30, e a media dos nove totais deu
    //    211,99 kWh/m2 contra 219,37 das oito completas — 3,4% ABAIXO, por cobertura e nao por sol.
    //    O conjunto apareceria como o pior "mes" da pagina justamente onde nao houve nada de
    //    errado com o ceu.
    // ⚠️ A guarda vale so para os TOTAIS. Media de 23 dias com media de 30 continua sendo media, e
    //    anular tambem as medias jogaria fora dado bom. Por isso a lista e explicita e diz de qual
    //    campo diario cada total vem — nao ha como deduzir isso do nome.
    for (const [campoMes, campoDia] of Object.entries(o.somas || {})) {
      if (!(campoMes in linha) || linha[campoMes] == null) continue;
      const cob = us.map(u => (o.diarias || [])
        .filter(d => d.ufv === u && d[o.chaveMes] === linha[o.chaveMes] && d[campoDia] != null).length);
      if (new Set(cob).size !== 1) linha[campoMes] = null;
    }
    out.push(linha);
  }
  return out;
}

// aplica nos tres produtos de uma vez; devolve o que acrescentou, para o log dizer.
// ⚠️ IDEMPOTENTE: tira o que ja houver antes de recalcular. Sem isso, rodar sobre a propria saida
//    (o modo semente le um arquivo que este gerador escreveu) duplicaria a linha do conjunto.
function comComplexo(serieDia, serieMes, semihora) {
  for (const l of [serieDia, serieMes, semihora]) {
    for (let i = l.length - 1; i >= 0; i--) if (l[i].ufv === COMPLEXO) l.splice(i, 1);
  }
  const cd = agregaComplexo(serieDia, ['dia', 'mes', 'dia_num']);
  const cm = agregaComplexo(serieMes, ['mes'], { contagens: ['dias'],
    // de qual campo DIARIO cada total do mes vem — a lista e explicita porque o nome nao diz
    somas: { gti_kwh: 'gti', dif_kwh: 'dif', dni_kwh: 'dni', chuva_mm: 'chuva' },
    chaveMes: 'mes', diarias: serieDia });
  const ch = agregaComplexo(semihora, ['dia', 't']);
  if (cd.length) serieDia.push(...cd);
  if (cm.length) serieMes.push(...cm);
  if (ch.length) semihora.push(...ch);
  return { dia: cd.length, mes: cm.length, semihora: ch.length };
}

async function fonteLinhas() {
  // 🔴 NOME DATADO NAO VIRA URL FIXA. O export chega como IIRR_<AAAAMMDD>_<HHMMSS>.csv, e apontar
  // IIRR_URL para um nome congela o gerador naquele arquivo. Listar o container e escolher o mais
  // recente e o que faz a ponte funcionar sem ninguem editar o workflow a cada export.
  const cont = process.env.IIRR_CONTAINER;
  if (cont) {
    return await fontesDoContainer(cont);
  }
  return await fonteUnica();
}

/* 🔴 O DIARIO CHEGA COM OUTRO NOME, e por UMA LETRA. O despejo historico e `IIRR_<data>.csv`; o
 * export DIARIO da mesma estacao chega como `IRR_GERAL_<data>.csv`, todo dia de madrugada. Ate
 * 27/08/2026 este gerador so casava `IIRR_`, entao lia UM arquivo congelado em 08/08 e ignorava,
 * em silencio, os diarios que continuavam chegando — a pagina ficou 19 dias parada com o dado
 * dentro do container. Medido: `IRR_GERAL_20260825` tem as MESMAS 10 estacoes e as MESMAS 44
 * colunas por estacao do despejo, com 48 linhas de 30 min.
 *
 * ⚠️ Nao confundir com `IRR_<data>.csv`, que tambem chega todo dia: aquele e o grupo `GER_IRR`,
 *    91 colunas, OUTRO sensor. Sao tres nomes parecidos e so um deles e o continuacao do historico.
 *
 * A leitura passa a ser a MESMA do gen-trafo: le TODOS e mescla. Escolher "o mais recente" traria
 * um dia so; escolher "o maior" traria o despejo congelado. */
async function fontesDoContainer(cont) {
  {
    const { BlobServiceClient } = require('@azure/storage-blob');
    const conn = process.env.DADOS_STORAGE;
    if (!conn) throw new Error('IIRR_CONTAINER exige DADOS_STORAGE');
    const c = BlobServiceClient.fromConnectionString(conn).getContainerClient(cont);
    // 🔴 O NOME CHEGA PREFIXADO. A ponte do Power Automate grava <id-do-item>_<nome-original>:
    // medido no container, "68656_M04.xlsx". Expressao ancorada em ^IIRR nunca casa — foi o que
    // deu "0 candidatos" na primeira tentativa.
    // ⚠️ E a ordenacao tem de usar a DATA do export, nao o nome inteiro: com o prefixo numerico,
    // comparar o nome todo ordena pelo ID DO ITEM, que nao tem relacao com a data.
    const carimbo = (x) => { const m = x.split('/').pop().match(/IIRR_(\d{8}_\d{6})\.csv$/i); return m ? m[1] : null; };
    let melhor = null, marca = null, vistos = 0, totalBlobs = 0;
    for await (const b of c.listBlobsFlat()) {
      totalBlobs++;
      const k = carimbo(b.name);
      if (!k) continue;
      vistos++;
      if (!marca || k > marca) { melhor = b; marca = k; }
    }
    // 🔴 FALHA ALTO. Cair na semente aqui recriaria o defeito original: o painel mostraria dado
    // congelado e NADA diria por que. Job vermelho com o container no texto custa uma correcao.
    // ⚠️ A mensagem diz o TOTAL, nao so os que casaram: "0 de 972" e "0 de 0" mandam procurar
    // em lugares opostos, e a primeira versao desta guarda so dizia o primeiro numero.
    if (!melhor) throw new Error('nenhum *IIRR_<data>_<hora>.csv em "' + cont + '" — '
      + vistos + ' casaram de ' + totalBlobs + ' blob(s) no container');
    const mb = Math.round((melhor.properties.contentLength || 0) / 1048576);
    console.log('  historico: ' + melhor.name + '  (' + mb + ' MB · '
      + String(melhor.properties.lastModified).slice(0, 24) + ' · ' + vistos + ' despejo(s))');

    // ---- os DIARIOS, que continuam chegando depois que o despejo congelou
    const carimboD = (x) => {
      const m = x.split('/').pop().match(/IRR_GERAL_(\d{8}_\d{6})\.csv$/i); return m ? m[1] : null;
    };
    const diarios = [];
    for await (const b of c.listBlobsFlat()) {
      const k = carimboD(b.name);
      if (k) diarios.push({ nome: b.name, k });
    }
    diarios.sort((a, b) => (a.k < b.k ? -1 : 1));
    console.log('  diarios: ' + diarios.length + ' arquivo(s) IRR_GERAL'
      + (diarios.length ? ' · ' + diarios[0].k.slice(0, 8) + ' a '
        + diarios[diarios.length - 1].k.slice(0, 8) : ''));

    const abre = (nome) => async () => {
      const dl = await c.getBlobClient(nome).download();
      return readline.createInterface({ input: dl.readableStreamBody, crlfDelay: Infinity });
    };
    // o historico primeiro: ele define a base, e o diario que repetir um instante ja lido e
    // descartado pelo dedup do laco — sao a mesma medicao, entao a ordem nao muda numero nenhum
    return [{ nome: melhor.name, abre: abre(melhor.name) }]
      .concat(diarios.map((d) => ({ nome: d.nome, abre: abre(d.nome) })));
  }
}

async function fonteUnica() {
  // IIRR_LOCAL aceita LISTA separada por virgula — e o que permite ensaiar a mescla sem o
  // container. Sem isso o caminho de varios arquivos so seria exercitado em producao.
  const local = process.env.IIRR_LOCAL;
  if (local) {
    return local.split(',').map((x) => x.trim()).filter(Boolean).map((cam) => ({
      nome: cam, abre: async () => readline.createInterface({
        input: fs.createReadStream(cam, 'utf8'), crlfDelay: Infinity }) }));
  }
  const url = process.env.IIRR_URL;
  if (!url) throw new Error('defina IIRR_CONTAINER, IIRR_URL ou IIRR_LOCAL');
  return [{ nome: url, abre: async () => {
    const { PassThrough } = require('stream');
    const pt = new PassThrough();
    https.get(url, r => { if (r.statusCode >= 300) pt.destroy(new Error('HTTP ' + r.statusCode)); else r.pipe(pt); })
      .on('error', e => pt.destroy(e));
    return readline.createInterface({ input: pt, crlfDelay: Infinity });
  } }];
}

// 🔴 O AZURE NAO COMPRIME SOZINHO: ele serve exatamente os bytes gravados. Com o terceiro
// argumento, o arquivo vai gzipado e DECLARADO como tal — navegador e datasource descomprimem sem
// precisar saber. Medido nos arquivos por resolucao: 829 KB caem para ~120.
async function writeOut(obj, nome, comprime) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    // mesmo diretorio do LOCAL_OUT, mas com o nome do blob. Sem isso os dois writeOut escreviam no
    // MESMO arquivo e a serie horaria era sobrescrita pela diaria — o seed horario simplesmente nao
    // aparecia, sem erro nenhum.
    const alvo = nome
      ? process.env.LOCAL_OUT.split(/[\\/]/).slice(0, -1).concat(nome).join('/')
      : process.env.LOCAL_OUT;
    const corpo = comprime ? zlib.gzipSync(Buffer.from(json)) : json;
    fs.writeFileSync(alvo, corpo);
    return Buffer.byteLength(corpo);
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  const corpo = comprime ? zlib.gzipSync(Buffer.from(json)) : Buffer.from(json);
  const cab = { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' };
  if (comprime) cab.blobContentEncoding = 'gzip';
  await cont.getBlockBlobClient(nome || OUT_BLOB).upload(corpo, corpo.length, { blobHTTPHeaders: cab });
  return corpo.length;
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
// ---------------------------------------------------------------------------------------------
// ARQUIVOS POR RESOLUCAO — irr_5min | irr_15min | irr_30min | irr_60min
//
// Sao OUTRO produto, ao lado dos arquivos por nivel de zoom. O zoom responde "que recorte",
// a resolucao responde "que passo de tempo", e as duas perguntas sao independentes.
//
// 🔴 FORMATO LARGO, uma coluna por UFV. A serie fina daqui e LONGA (dia · ufv · t), 432 linhas
// por dia: um ano em 5 minutos daria 946 mil linhas. Em largo o instante deixa de ser repetido
// nove vezes e o mesmo ano cabe em 8.760.
//
// 🔴 AS JANELAS SAEM DO MESMO TETO DE ~8.700 LINHAS que dimensiona os blobs do MUST, e nao de
// numero escolhido a esmo: 30 dias em 5 min, 90 em 15, 180 em 30, 365 em 60. So um arquivo e
// baixado por vez, entao o detalhe fino nao custa rede a quem esta olhando o ano.
//
// ⚠️ SO SE EMITE O QUE A FONTE TEM. Passo mais fino que a fonte nao se inventa reparticionando:
// repartir meia hora em seis pedacos iguais desenharia um patamar que ninguem mediu, e ele
// apareceria como curva plausivel. Com a fonte em 30 min saem `irr_30min` e `irr_60min`; no dia
// em que ela for de 5, os outros dois passam a existir sozinhos, sem tocar neste arquivo.
//
// A grandeza e a IRRADIANCIA NO PLANO (GTI, W/m2), que e a serie principal da pagina. As demais
// continuam nos arquivos por nivel de zoom — um arquivo por resolucao com dezesseis grandezas
// vezes nove usinas teria 144 colunas e nao serviria a leitura nenhuma.
const RESOLUCOES = [{ min: 5, dias: 30 }, { min: 15, dias: 90 },
  { min: 30, dias: 180 }, { min: 60, dias: 365 }];
const TETO_LINHAS = 8800;

// ---------------------------------------------------------------------------------------------
// ARQUIVOS POR FAMILIA DE GRANDEZA — irr_<familia>_<res>.json
//
// 🔴 O QUE ESTES ARQUIVOS SUBSTITUEM, e por que o corte mudou de eixo. Os arquivos por nivel de
//    zoom sao recortados por MES e por DIA, e e isso que obriga a pagina a ter os filtros Mes e
//    Dia: eles nao filtram, eles ESCOLHEM O ARQUIVO. Com o recorte por FAMILIA, quem escolhe o
//    periodo volta a ser o seletor de tempo do Grafana, e os dois filtros somem.
//
// 🔴 O CORTE E POR FAMILIA PORQUE A PAGINA E ASSIM. Cada grandeza mora numa row RECOLHIDA — ao
//    abrir, so a de irradiancia no plano carrega. Um arquivo unico com todas as grandezas por
//    resolucao daria 6,4 MB (medido); por familia, a pagina baixa 447 KB ao abrir e cada row
//    aberta puxa a sua, uma vez. Medido, gzipado, com dado real:
//      plano 447 · difusa/direta 515 · albedo 846 · temperatura 1254 · umidade 307
//      vento 630 · chuva 33 · sujeira 581 · bateria 97   (KB, 365 dias em 1 h)
//
// ⚠️ AS FAMILIAS SAEM DO USO REAL DOS PAINEIS, nao de uma taxonomia inventada: cada uma cobre
//    exatamente as grandezas de uma row. `plano` serve o painel do topo E a row do comparativo,
//    e `temp` serve as duas rows de temperatura — por isso sao 9 familias para 11 rows.
const FAMILIAS = {
  plano: ['gti_w', 'ons_w'],
  comp: ['dif_w', 'dni_w'],
  albedo: ['alb_cima_w', 'alb_baixo_w', 'albedo'],
  // as DUAS rows de temperatura sao familias separadas: juntas dariam 72 colunas e ~2,3 MB no
  // ano, e quem abre so uma pagaria pelas duas. `t_mod1` aparece nas duas — repetir UMA coluna
  // custa menos que fazer cada leitor baixar a familia inteira do vizinho.
  temp: ['t_mod1', 't_amb', 't_int', 't_orvalho'],
  tmod: ['t_mod1', 't_mod2', 't_mod3', 't_mod4'],
  umid: ['umid'],
  vento: ['vento', 'vento_dir'],
  chuva: ['chuva'],
  sujeira: ['suj1', 'suj2', 'perda_suj1', 'perda_suj2'],
  bateria: ['bateria'],
};
// ⚠️ chuva ACUMULA no balde; todo o resto e intensidade e se promedia. Somar umidade ou
//    temperatura ao juntar dois baldes de 30 min daria o dobro do valor, calado.
const CAMPO_SOMA = new Set(['chuva']);

async function emiteFamilias(meta, semihora, resFonte) {
  if (!semihora || !semihora.length) return { arquivos: 0, bytes: 0, detalhe: [] };
  const dias = [...new Set(semihora.map((x) => x.dia))].sort();
  const ultimo = dias[dias.length - 1];
  let n = 0, bytes = 0;
  const detalhe = [];

  for (const { min, dias: janela } of RESOLUCOES) {
    if (min < resFonte) continue;
    const corte = new Date(Date.parse(ultimo + 'T00:00:00Z') - (janela - 1) * 86400000)
      .toISOString().slice(0, 10);
    for (const [fam, campos] of Object.entries(FAMILIAS)) {
      const acc = {};
      for (const l of semihora) {
        if (l.dia < corte) continue;
        const slot = Math.floor(Math.round(l.t * 60) / min) * min;   // borda ESQUERDA
        const k = l.dia + '|' + slot;
        const a = acc[k] || (acc[k] = { dia: l.dia, slot, v: {} });
        for (const c of campos) {
          if (l[c] == null) continue;
          const kk = c + '_' + l.ufv;
          const o = a.v[kk] || (a.v[kk] = { s: 0, n: 0 });
          o.s += l[c]; o.n++;
        }
      }
      const chaves = Object.keys(acc).sort((x, y) => {
        const [dx, sx] = x.split('|'); const [dy, sy] = y.split('|');
        return dx === dy ? (+sx) - (+sy) : (dx < dy ? -1 : 1);
      });
      const serie = chaves.map((k) => {
        const a = acc[k];
        const hh = String(Math.floor(a.slot / 60)).padStart(2, '0');
        const mi = String(a.slot % 60).padStart(2, '0');
        const t = a.dia + 'T' + hh + ':' + mi + ':00-03:00';
        // o EPOCH vai publicado, pela mesma razao do irr_<res>: o JSONata do Grafana ignora o
        // offset ao parsear a data, e derivar o instante no painel erraria em ate um dia
        const l = { t, ms: Date.parse(t) };
        for (const [kk, o] of Object.entries(a.v)) {
          const nome = kk.slice(0, kk.lastIndexOf('_'));
          l[kk] = r2(CAMPO_SOMA.has(nome) ? o.s : o.s / o.n);
        }
        return l;
      });
      if (serie.length > TETO_LINHAS) {
        throw new Error('irr_' + fam + '_' + min + 'min ficou com ' + serie.length
          + ' linhas, acima do teto de ' + TETO_LINHAS);
      }
      // JANELA MEDIDA, NAO DECLARADA — o painel monta o rotulo do seletor a partir daqui
      const ds = [...new Set(serie.map((x) => x.t.slice(0, 10)))];
      const nome = 'irr_' + fam + '_' + min + 'min.json';
      bytes += await writeOut(Object.assign({}, meta, {
        familia: fam, grandezas: campos, resolucao_min: min,
        janela_dias: ds.length, janela_dias_alvo: janela,
        rotulo_de_tempo: 'inicio do intervalo',
        nota: 'Uma coluna por grandeza e entidade (<grandeza>_<entidade>). O recorte do periodo e '
          + 'do seletor de tempo do painel; este arquivo define o ALCANCE MAXIMO.',
        serie,
      }), nome, true);
      n++;
      if (min === 60) detalhe.push(fam + ': ' + Math.round(JSON.stringify(serie).length / 1024)
        + ' KB cru · ' + serie.length + ' linhas · ' + ds.length + ' dias');
    }
  }
  return { arquivos: n, bytes, detalhe };
}

// ---------------------------------------------------------------------------------------------
// LAPIDE DOS ARQUIVOS POR NIVEL DE ZOOM
//
// Eles existiram para dar a pagina um recorte por MES e por DIA, e era isso que obrigava a
// Solarimetria a ter os filtros Mes e Dia — eles nao filtravam, ESCOLHIAM O ARQUIVO. Desde
// 26/08/2026 os paineis leem os arquivos por FAMILIA e recortam pelo seletor de tempo do Grafana.
//
// 🔴 Nao se apagam: eles ficariam no container com nome plausivel e dado congelado, esperando
//    alguem apontar para eles. Recebem lapide — um objeto que DIZ o que aconteceu — pela mesma
//    convencao que os `irr_hora_<mes>.json` do formato anterior ja receberam.
async function lapideNiveis(meses, diasHora) {
  const nomes = [HORA_PRE + 'tudo-tudo.json']
    .concat((meses || []).map((m) => HORA_PRE + m + '-tudo.json'))
    .concat((diasHora || []).map((d) => HORA_PRE + d.slice(0, 7) + '-' + d.slice(8, 10) + '.json'))
    .concat((meses || []).concat('tudo').map((m) => HORA_PRE + m + '.json'));
  let n = 0;
  for (const nome of [...new Set(nomes)]) {
    await writeOut({ obsoleto: 'Aposentado em 26/08/2026. A pagina deixou de ter os filtros Mes e '
      + 'Dia: os paineis agora leem irr_<familia>_<resolucao>.json e recortam pelo seletor de tempo '
      + 'do Grafana. As familias sao plano, comp, albedo, temp, tmod, umid, vento, chuva, sujeira e '
      + 'bateria.' }, nome);
    n++;
  }
  return n;
}

async function emiteResolucoes(meta, semihora, resFonte) {
  if (!semihora || !semihora.length) return { arquivos: 0, bytes: 0, pulados: RESOLUCOES.length };
  const ufvs = [...new Set(semihora.map(x => x.ufv))].sort();
  const dias = [...new Set(semihora.map(x => x.dia))].sort();
  const ultimo = dias[dias.length - 1];
  let n = 0, bytes = 0, pulados = 0;
  const linha = [];

  for (const { min, dias: janela } of RESOLUCOES) {
    if (min < resFonte) { pulados++; linha.push(min + 'min: fonte e de ' + resFonte + ' min'); continue; }
    const corte = new Date(Date.parse(ultimo + 'T00:00:00Z') - (janela - 1) * 86400000)
      .toISOString().slice(0, 10);
    // agrega no balde do passo pedido; a irradiancia e POTENCIA, entao o balde e a media
    const acc = {};
    for (const l of semihora) {
      if (l.dia < corte || l.gti_w == null) continue;
      const mm = Math.round(l.t * 60);                    // t vem em hora decimal
      const slot = Math.floor(mm / min) * min;            // borda ESQUERDA, como o SCADA rotula
      const k = l.dia + '|' + slot;
      const a = acc[k] || (acc[k] = { dia: l.dia, slot, v: {} });
      const c = a.v[l.ufv] || (a.v[l.ufv] = { s: 0, n: 0 });
      c.s += l.gti_w; c.n++;
    }
    const chaves = Object.keys(acc).sort((x, y) => {
      const [dx, sx] = x.split('|'); const [dy, sy] = y.split('|');
      return dx === dy ? (+sx) - (+sy) : (dx < dy ? -1 : 1);
    });
    const serie = chaves.map(k => {
      const a = acc[k];
      const hh = String(Math.floor(a.slot / 60)).padStart(2, '0');
      const mi = String(a.slot % 60).padStart(2, '0');
      const t = a.dia + 'T' + hh + ':' + mi + ':00-03:00';
      // 🔴 o EPOCH vai publicado. O JSONata do Grafana ignora o offset ao parsear a data, entao
      // derivar o instante no painel erraria em ate um dia — o mesmo defeito que ja custou caro
      // no MUST. Com `ms` o painel compara numero com numero.
      const l = { t, ms: Date.parse(t) };
      for (const u of ufvs) { const c = a.v[u]; if (c && c.n) l[u] = r2(c.s / c.n); }
      return l;
    });
    if (serie.length > TETO_LINHAS) {
      throw new Error('irr_' + min + 'min ficou com ' + serie.length + ' linhas, acima do teto de '
        + TETO_LINHAS + ' — a janela precisa encolher');
    }
    // 🔴 JANELA MEDIDA, NAO DECLARADA. Ate 25/08/2026 este campo publicava `janela`, o numero da
    // CONFIGURACAO — e com a fonte na semente, cortada em 120 dias, o arquivo dizia 180 e 365 e
    // tinha 120. O painel monta o rotulo do seletor a partir daqui: numero declarado que nao
    // corresponde ao dado vira promessa quebrada na tela, e o leitor culpa o dado.
    // `janela_dias_alvo` fica ao lado para a diferenca entre o pedido e o obtido ser visivel.
    const diasReais = new Set(serie.map((l) => l.t.slice(0, 10))).size;
    bytes += await writeOut({
      gerado_em: meta.gerado_em, fonte: meta.fonte, modo: meta.modo,
      grandeza: 'Irradiancia no plano dos modulos (GTI), W/m2',
      resolucao_min: min, janela_dias: diasReais, janela_dias_alvo: janela,
      rotulo_de_tempo: 'O instante e o INICIO do intervalo: o valor em T cobre [T, T+' + min + ' min).',
      nota: 'Uma coluna por usina. As demais grandezas ficam nos arquivos por nivel de zoom '
        + '(irr_hora_<mes>-<dia>.json).',
      ufvs, linhas: serie.length, serie,
    }, 'irr_' + min + 'min.json', true);
    n++;
    linha.push(min + 'min: ' + serie.length + ' linhas · ' + diasReais + ' dias'
      + (diasReais < janela ? ' (alvo ' + janela + ' — a fonte nao tem tudo isso)' : ''));
  }
  return { arquivos: n, bytes, pulados, detalhe: linha };
}


// os seeds vao GZIPADOS no repo: o semi-horario cru da 6 MB, e cada regeracao gravaria 6 MB novos no
// historico do git (blob binario nao se delta-comprime). Gzipado da ~600 KB, e ler custa uma linha.
const leSeed = cam => JSON.parse(zlib.gunzipSync(fs.readFileSync(cam)).toString('utf8'));

(async () => {
  // modo seed: sem CSV nenhum, republica o historico do repo e sai
  if (!process.env.IIRR_LOCAL && !process.env.IIRR_URL && !process.env.IIRR_CONTAINER) {
    const seed = 'data/irr_seed.json.gz';
    if (!fs.existsSync(seed)) throw new Error('sem IIRR_URL/IIRR_LOCAL e sem ' + seed);
    const j = leSeed(seed);
    j.modo = 'seed';
    j.nota_seed = 'Historico processado do export IIRR de 08/08/2026, versionado no repo. '
      + 'Enquanto a ponte SharePoint -> blob nao existir, e esta a fonte do painel. '
      + 'Definir IIRR_URL no workflow faz o gerador voltar a ler o CSV cru.';
    const seedH = 'data/irr_hora_seed.json.gz';
    const hSeed = fs.existsSync(seedH) ? leSeed(seedH) : null;
    // 🔴 O CONJUNTO ENTRA AQUI, ANTES DE QUALQUER EMISSAO, e nos TRES produtos de uma vez. Sao 27
    //    paineis que filtram por usina; calcular a media no JSONata de cada um garantiria que uma
    //    copia envelhecesse diferente das outras. Como todos ja filtram `ufv in $us`, o conjunto
    //    chega a eles sem que nenhum painel mude.
    j.serie_dia = j.serie_dia || []; j.serie_mes = j.serie_mes || [];
    const linhas = (hSeed && hSeed.serie_semihora) || [];
    const nc = comComplexo(j.serie_dia, j.serie_mes, linhas);
    j.agregados = [COMPLEXO];
    console.log('conjunto (media das ' + (j.ufvs || []).length + ' estacoes) · '
      + nc.dia + ' dias · ' + nc.mes + ' meses · ' + nc.semihora + ' instantes de 30 min');
    if (hSeed) {
      const h = hSeed;
      // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode
      // oferecer dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
      j.dias_hora = [...new Set(linhas.map(x => x.dia))].sort();
      const rl = await lapideNiveis(j.meses || [], j.dias_hora || []);
      console.log('niveis por zoom: ' + rl + ' arquivo(s) com lapide (aposentados)');
      const rr = await emiteResolucoes({ gerado_em: h.gerado_em, fonte: h.fonte, modo: 'seed' },
        linhas, h.resolucao_min || 30);
      console.log('resolucoes · ' + rr.arquivos + ' arquivo(s) · ' + Math.round(rr.bytes / 1024) + ' KB'
        + (rr.pulados ? ' · ' + rr.pulados + ' pulada(s)' : ''));
      (rr.detalhe || []).forEach(x => console.log('    ' + x));
      const rf = await emiteFamilias({ gerado_em: h.gerado_em, fonte: h.fonte, modo: 'seed' },
        linhas, h.resolucao_min || 30);
      console.log('familias · ' + rf.arquivos + ' arquivo(s) · ' + Math.round(rf.bytes / 1024) + ' KB');
      (rf.detalhe || []).forEach(x => console.log('    ' + x));
    }
    const t = await writeOut(j);
    console.log('irr_ufv.json republicado do seed · ' + Math.round(t / 1024) + ' KB · '
      + (j.serie_dia || []).length + ' linhas diarias · ' + (j.dias_hora || []).length
      + ' dias com hora · janela ' + j.janela.ini + ' a ' + j.janela.fim);
    return;
  }
  const FONTES = await fonteLinhas();
  let cab = null;
  let mapa = [];                   // { i, ufv, gr }
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
  // 🔴 DEDUP POR INSTANTE, e ele e obrigatorio: os acumuladores SOMAM, entao um instante presente
  //    no despejo historico E num diario entraria duas vezes e a media do dia sairia certa por
  //    acidente (soma e contagem dobram juntas) mas o TOTAL do mes sairia dobrado. O historico e
  //    lido primeiro; o diario que repetir um instante ja lido e descartado.
  const vistos = new Set();
  const ufvsVistas = new Set(), grsVistas = new Set();
  let repetidos = 0;

  for (const fonte of FONTES) {
  // ⚠️ CABECALHO POR ARQUIVO. Cada CSV traz o proprio, e a ORDEM das colunas nao e garantida entre
  //    exports — remapear por arquivo e o que impede ler a coluna de uma estacao como se fosse de
  //    outra. Reaproveitar o mapa do arquivo anterior seria o modo silencioso de errar.
  cab = null; mapa = [];
  const rl = await fonte.abre();
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
      if (!mapa.length) {
        throw new Error('nenhuma coluna reconhecida em ' + fonte.nome + ' — o layout mudou?');
      }
      for (const m of mapa) { ufvsVistas.add(m.ufv); grsVistas.add(m.gr); }
      continue;
    }
    const ts = cols[0];
    if (vistos.has(ts)) { repetidos++; continue; }
    vistos.add(ts);
    nLinhas++;
    if (!tsIni || ts < tsIni) tsIni = ts;
    if (!tsFim || ts > tsFim) tsFim = ts;
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
  }   // fim do laco por FONTE

  console.log('  lidos ' + FONTES.length + ' arquivo(s) · ' + nLinhas + ' instantes distintos'
    + (repetidos ? ' · ' + repetidos + ' repetido(s) descartado(s)' : ''));

  // 🔴 O UNIVERSO DE ESTACOES E GRANDEZAS E A UNIAO, nao o do ULTIMO arquivo lido. Com `mapa`
  //    reiniciado a cada CSV, tirar `ufvs` dele depois do laco daria o mapa do ultimo diario — e
  //    uma estacao que so aparecesse no historico sumiria da pagina inteira sem erro nenhum.
  const ufvs = [...ufvsVistas].sort();
  const grs = [...grsVistas].sort();
  const dias = Object.keys(acc).sort();
  const SLOTS = 48;

  // ---------- a irradiancia VERIFICADA do ONS, para o comparativo ----------
  // O join sai daqui, do Node, e nao do painel: cruzar dois blobs no JSONata exigiria uma segunda
  // variavel de mes (o ONS usa 2026_08 e a pagina usa 2026-08) e uma segunda URL baixada em toda
  // renderizacao. Com o ONS dentro dos MEUS arquivos, o comparativo fica simetrico com o resto da
  // pagina: mesmo filtro, mesmo arquivo, mesmo nivel de zoom.
  //
  // MAPEAMENTO DAS TAGS — e aqui que mora o cuidado. CEFMTn = Mn, MENOS:
  //   CEFMT7 nao e o M7: e o circuito 2 do M3 (defeito de tag conhecido do ONS, ja registrado no
  //   projeto). Entao CEFMT7 fica FORA e o M7 simplesmente nao tem serie do ONS — melhor sem dado do
  //   que com o dado do vizinho. O M3 usa so o CEFMT3.
  // O ONS tambem nao tem agosto/2025 (o arquivo nao existe), o que deixa o primeiro mes da janela sem
  // comparativo. Nao ha o que reconstruir ali, e forcar seria inventar.
  const ONS_TAG = { CEFMT1: 'M1', CEFMT2: 'M2', CEFMT3: 'M3', CEFMT4: 'M4', CEFMT5: 'M5',
    CEFMT6: 'M6', CEFMT8: 'M8', CEFMT9: 'M9' };
  const ONS_BASE = 'https://rbenergydata.blob.core.windows.net/dados/ons_irradiancia_';
  const getJSON = url => new Promise((res, rej) => {
    https.get(url, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = []; r.on('data', b => c.push(b));
      r.on('end', () => {
        try {
          // 🔴 GZIP POR BYTES MAGICOS. Os blobs do ONS passaram a ser gravados comprimidos e este
          //    leitor os lia como texto: o JSON.parse estourava, o catch de fora contava "mes sem
          //    arquivo", e o gerador PUBLICAVA assim mesmo. Medido em 26/08/2026: "ONS: 0 de 13
          //    meses lidos, 0 leituras" — a linha do ONS sumiu do comparativo e ninguem foi
          //    avisado. Mesma familia do gzip que ja cegou a medicao do gauntlet.
          let b = Buffer.concat(c);
          if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
          res(JSON.parse(b.toString('utf8')));
        } catch (e) { rej(e); }
      });
    }).on('error', rej);
  });
  const ons = {};                 // 'dia|ufv|slot' -> W/m2 verificado
  // 🔴 OS MESES DO ONS NAO SAEM DOS DIAS DO SCADA. O despejo do SCADA e manual e pode envelhecer
  //    (medido em 27/08/2026: ele parou em 06/08 e o ONS ja estava em 25/08). Derivando a lista da
  //    NOSSA janela, o gerador deixaria de ler justamente o periodo em que o ONS e a UNICA fonte de
  //    irradiancia. Vai do primeiro dia nosso ate o mes corrente.
  const onsMes = (() => {
    const s = new Set(dias.map(d => d.slice(0, 7)));
    const hoje = new Date();
    let a = +dias[0].slice(0, 4), m = +dias[0].slice(5, 7);
    const aF = hoje.getUTCFullYear(), mF = hoje.getUTCMonth() + 1;
    while (a < aF || (a === aF && m <= mF)) {
      s.add(a + '-' + String(m).padStart(2, '0'));
      m++; if (m > 12) { m = 1; a++; }
    }
    return [...s].sort();
  })();
  let onsOk = 0, onsFalta = [];
  for (const m of onsMes) {
    try {
      const j = await getJSON(ONS_BASE + m.replace('-', '_') + '.json');
      (j.consolidado || []).forEach(r => {
        const u = ONS_TAG[r.u]; if (!u) return;
        if (String(r.inv) === 'True') return;              // o proprio ONS marcou a medida invalida
        const v = Number(r.irr); if (!isFinite(v)) return;
        const slot = +r.ts.slice(11, 13) * 2 + (+r.ts.slice(14, 16) >= 30 ? 1 : 0);
        ons[r.ts.slice(0, 10) + '|' + u + '|' + slot] = v;
      });
      onsOk++;
    } catch (e) { onsFalta.push(m + ' (' + e.message + ')'); }
  }
  // 🔴 NENHUM MES LIDO NAO E "o ONS nao tem dado" — e o LEITOR quebrado. A versao anterior
  //    registrava a falha no log e publicava assim mesmo: a linha do ONS sumiu do comparativo e
  //    so foi notada quando alguem foi montar outra coisa em cima. Arquivo que nao existe (404) e
  //    legitimo — mes ainda nao gerado; erro de LEITURA em todos eles, nao.
  if (onsMes.length && onsOk === 0 && onsFalta.some((x) => !/HTTP 404/.test(x))) {
    throw new Error('nenhum dos ' + onsMes.length + ' meses do ONS pode ser lido, e nem todos sao '
      + '404 — o leitor esta quebrado, nao a fonte. Primeiros: ' + onsFalta.slice(0, 3).join(' · '));
  }
  console.log('ONS: ' + onsOk + ' de ' + onsMes.length + ' meses lidos, ' + Object.keys(ons).length
    + ' leituras' + (onsFalta.length ? ' · sem arquivo: ' + onsFalta.join(', ') : ''));

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
    // ONS do dia, com as MESMAS definicoes que uso no nosso lado: integral (kWh/m2) e media das
    // leituras com sol (W/m2, corte de 5). Sem isso o comparativo estaria comparando definicoes
    // diferentes e a diferenca seria minha, nao do dado.
    {
      const v = [];
      for (let k = 0; k < SLOTS; k++) { const x = ons[d + '|' + u + '|' + k]; if (x != null) v.push(x); }
      l.ons_leituras = v.length;
      // 🔴 A INTEGRAL DIARIA DO ONS SOMA O QUE HOUVER. Medido em 27/08/2026: em 28/05 o ONS trouxe
      //    ~25 das 48 meias-horas nas nove usinas e o dia saiu em ~1,4 kWh/m2 contra 6,5 a 7,2
      //    medidos pela estacao — meio dia faltando aparecendo na tela como erro de medicao de 80%.
      //    A cobertura vai ao lado para o painel poder excluir o dia pela metade; o teto de 48 e o
      //    numero de meias-horas do dia, e a mediana normal e 40 (as de noite entram invalidas).
      l.ons_cob_pct = r2(100 * v.length / SLOTS);
      l.ons_gti = v.length ? r3(v.reduce((a2, b2) => a2 + b2, 0) * H_SLOT / 1000) : null;
      const sol = v.filter(x => x > SOL_MIN);
      l.ons_sol_w = sol.length ? r2(sol.reduce((a2, b2) => a2 + b2, 0) / sol.length) : null;
    }
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

  // ---------- os dias que SO o ONS tem ----------
  // Mesma razao da uniao no intradiario: enquanto a linha do dia so nascia de um dia do SCADA, o
  // valor do ONS para os dias seguintes era lido e jogado fora. Hoje o ONS chega a ser a fonte
  // MAIS FRESCA de irradiancia, porque o despejo do SCADA e manual.
  // ⚠️ A linha carrega SO os campos do ONS. Ela nao inventa cobertura nossa nem bandeira de
  //    qualidade: o painel de falhas filtra `suspeito = 1` e os demais filtram por tipo numerico,
  //    entao uma linha sem os nossos campos nao aparece neles — que e o certo, porque nao houve
  //    medicao nossa para julgar.
  // ⚠️ O M7 nao entra por nao ter tag propria no ONS, e o conjunto tambem nao: a agregacao exige
  //    as nove estacoes no grupo e aqui ha oito.
  {
    const jaTem = new Set(serie_dia.map(l => l.dia + '|' + l.ufv));
    const diasOns = [...new Set(Object.keys(ons).map(k => k.slice(0, k.indexOf('|'))))].sort();
    let soOns = 0;
    diasOns.forEach(d => ufvs.forEach(u => {
      if (jaTem.has(d + '|' + u)) return;
      const v = [];
      for (let k = 0; k < SLOTS; k++) { const x = ons[d + '|' + u + '|' + k]; if (x != null) v.push(x); }
      if (!v.length) return;
      const sol = v.filter(x => x > SOL_MIN);
      serie_dia.push({ dia: d, mes: d.slice(0, 7), dia_num: +d.slice(8, 10), ufv: u,
        ons_leituras: v.length,
        ons_cob_pct: r2(100 * v.length / SLOTS),
        ons_gti: r3(v.reduce((a2, b2) => a2 + b2, 0) * H_SLOT / 1000),
        ons_sol_w: sol.length ? r2(sol.reduce((a2, b2) => a2 + b2, 0) / sol.length) : null,
        so_ons: 1, suspeito: 0 });
      soOns++;
    }));
    // a serie tem de continuar em ordem: painel de dia usa `dia` como eixo e recusa x que desce
    serie_dia.sort((a, b) => (a.dia + a.ufv < b.dia + b.ufv ? -1 : 1));
    console.log('dias so do ONS: ' + soOns + ' linhas dia-usina'
      + (soOns ? ' (' + diasOns[diasOns.length - 1] + ' e o ultimo do ONS)' : ''));
  }

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
      ons_gti_dia: med('ons_gti'), ons_sol_w: med('ons_sol_w'), ons_dias: L.filter(x => x.ons_gti != null).length,
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
  // 🔴 A CHAVE E A UNIAO, nao so o nosso acumulador. O ONS alcanca dias que o despejo do SCADA
  //    ainda nao trouxe, e ate 27/08/2026 esses instantes eram lidos, convertidos e DESCARTADOS
  //    aqui — a pagina ficava cega com a informacao dentro de casa. Agora a curva do SCADA termina
  //    e a do ONS continua, que e a leitura honesta.
  // ⚠️ As duas chaves usam formatos DIFERENTES de slot (`|09` no nosso, `|9` no do ONS). Unir sem
  //    normalizar duplicaria as nove primeiras meias-horas de cada dia.
  const chavesH = [...new Set([...Object.keys(accH), ...Object.keys(ons).map((k) => {
    const p = k.split('|'); return p[0] + '|' + p[1] + '|' + String(+p[2]).padStart(2, '0');
  })])].sort();
  const serie_semihora = [];
  chavesH.forEach(k => {
    const [d, u, slot] = k.split('|');
    const g = accH[k] || {};
    const l = { dia: d, ufv: u, t: +slot / 2 };
    // o ONS no MESMO slot, ao lado do nosso: e o que faz o comparativo ser um painel de duas linhas
    // em vez de um cruzamento de dois blobs no navegador
    const xo = ons[d + '|' + u + '|' + (+slot)];
    if (xo != null) l.ons_w = r2(xo);
    let algum = false;
    Object.entries(CAMPO_H).forEach(([gr, campo]) => {
      const o = g[gr];
      if (o && o.n) { l[campo] = r2(o.s / o.n); algum = true; }
    });
    if (algum || l.ons_w != null) serie_semihora.push(l);
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

  // 🔴 O conjunto entra ANTES de `out` e antes das emissoes, para alcancar os TRES produtos: o blob
  //    principal, os arquivos por nivel de zoom e os por resolucao. Mesmo ponto unico do modo
  //    semente — a regra da media nao pode existir em dois lugares.
  const nc = comComplexo(serie_dia, serie_mes, serie_semihora);
  console.log('conjunto (media das ' + ufvs.length + ' estacoes) · ' + nc.dia + ' dias · '
    + nc.mes + ' meses · ' + nc.semihora + ' instantes de 30 min');

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'SCADA · export IIRR (estações solarimétricas), 30 min. Energia = média da leitura × 0,5 h. '
      + 'Duas versões de cada agregado: LIMPA (só o que passa na faixa física) e BRUTA (tudo). '
      + 'A diferença entre as duas é indicador de sensor.',
    janela: { ini: tsIni, fim: tsFim }, resolucao_min: 30, linhas: nLinhas,
    mapeamento: EST_UFV, faixa_fisica: FAIXA,
    ufvs, agregados: [COMPLEXO], grandezas: grs, dias: dias.length, meses,
    serie_dia, serie_mes, qualidade,
  };
  // a horaria sai antes, em um arquivo por mes, so os ultimos HORA_DIAS dias
  const corte = dias.slice(-HORA_DIAS)[0];
  const hora = serie_semihora.filter(x => x.dia >= corte);
  // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode oferecer
  // dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
  out.dias_hora = [...new Set(hora.map(x => x.dia))].sort();
  const rlap = await lapideNiveis(meses, out.dias_hora || []);
  console.log('niveis por zoom: ' + rlap + ' arquivo(s) com lapide (aposentados)');

  // ⚠️ Aqui vai a serie INTEIRA, nao a recortada em 120 dias que alimenta os niveis de zoom: o
  // arquivo de 60 min cobre um ano, e passar `hora` o deixaria com quatro meses sem nada avisar.
  const rr = await emiteResolucoes({ gerado_em: out.gerado_em, fonte: out.fonte, modo: 'csv' },
    serie_semihora, 30);
  console.log('resolucoes · ' + rr.arquivos + ' arquivo(s) · ' + Math.round(rr.bytes / 1024) + ' KB'
    + (rr.pulados ? ' · ' + rr.pulados + ' pulada(s)' : ''));
  (rr.detalhe || []).forEach(x => console.log('    ' + x));

  // as familias saem da serie INTEIRA, como as resolucoes: sao elas que dao a pagina o passado
  const rf = await emiteFamilias({ gerado_em: out.gerado_em, fonte: out.fonte, modo: 'csv' },
    serie_semihora, 30);
  console.log('familias · ' + rf.arquivos + ' arquivo(s) · ' + Math.round(rf.bytes / 1024) + ' KB');
  (rf.detalhe || []).forEach(x => console.log('    ' + x));

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
