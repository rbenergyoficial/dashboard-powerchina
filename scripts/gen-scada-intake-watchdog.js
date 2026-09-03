// gen-scada-intake-watchdog.js — a INTAKE do SCADA parou de chegar?
//
// 🔴 POR QUE ELE EXISTE
// O container `scada-raw` e alimentado pelo fluxo "SCADA SharePoint para Blob" do Power Automate.
// Em 28/08/2026 ele falhou DEZ vezes numa semana e ninguem soube: os geradores que consomem o
// container continuaram rodando, republicando fielmente o que ja tinham, e nada ficou vermelho.
// A solarimetria parou em 06/08 e o comparativo ficou tres dias atras — descobertos por um humano
// olhando a tela, dias depois.
//
// 🔴 O MODO DE FALHAR E O PIOR DESTA CASA: nada quebra, nada fica vazio, e a pagina publica um
// dado velho com cara de dado de hoje. Este vigia existe para trocar isso por um alerta.
//
// ⚠️ ELE NAO SUBSTITUI A MIGRACAO. O fluxo continua sendo a ponte; o vigia so faz a queda dela
//    ser barulhenta. Quando a coleta sair do Power Automate (`gen-scada-intake.js`), ele continua
//    valendo — ai vigiando o coletor novo, que e o mesmo container.
//
// O QUE ELE MEDE
//   A idade do arquivo mais recente DE CADA FAMILIA. Familia e o consumidor: cada uma tem
//   cadencia propria, e uma media entre elas esconderia justamente a que parou.
//
// ⚠️ COMPARA COM O RELOGIO, NUNCA COM O PROPRIO DADO. Quando a ponte quebra, o container
//    simplesmente para de receber — nao ha registro dizendo que deveria ter chegado. E a mesma
//    razao pela qual o vigia do MUST olha a hora e nao a serie.
//
// MODOS
//   MODO=medir   (nao alerta) imprime a DISTRIBUICAO dos intervalos por familia. E daqui que os
//                limiares saem — limiar escolhido a esmo reprova o caso normal, e ja fez isso
//                tres vezes nesta casa.
//   MODO=vigiar  (padrao) julga contra os limiares e alerta.
//
// Ambiente: DADOS_STORAGE, RAW_CONTAINER=scada-raw, e (para alertar) GITHUB_TOKEN / GH_REPO.'
'use strict';
const { BlobServiceClient } = require('@azure/storage-blob');
const { alerta } = require('./lib-alerta');

const RAW = process.env.RAW_CONTAINER || 'scada-raw';
const MODO = (process.env.MODO || 'vigiar').toLowerCase();
const SECO = /^(1|true|sim)$/i.test(process.env.SECO || '');

// ── as familias ──────────────────────────────────────────────────────────────────────────────
// 🔴 A LISTA E DERIVADA DO COLETOR, nao copiada dele. `gen-scada-intake.js` ja define quais
//    arquivos existem e quem os consome; uma segunda copia aqui envelheceria em outra direcao, e
//    o vigia passaria a vigiar um conjunto que ninguem le — dando a impressao de cobertura sem
//    ter nenhuma. A primeira versao deste arquivo copiava, e a guarda que eu escrevi para
//    detectar a divergencia comparava os campos ERRADOS (`casa` contra `exige`, que respondem a
//    perguntas diferentes): guarda que compara a coisa errada nao e guarda.
//
// O que mora AQUI e so o que o coletor nao tem: o rotulo legivel e os dois limiares.
// `alerta_h`/`critico_h` NULOS ate a medicao — publicar limiar antes de medir e o defeito que
// este cabecalho existe para evitar. Rode MODO=medir e preencha com o numero MEDIDO.
// 🔴 A CHAVE E UMA MARCA SEM BARRA INVERTIDA, e isso e deliberado. A primeira versao usava a
//    FONTE da expressao como chave — e ela nao sobrevive a uma camada de escape: `'/\.xlsx$/i'`
//    escrito com uma barra so vira `/.xlsx$/i` em JS (escape desconhecido perde a barra), a
//    chave deixa de casar, e o vigia morre com "familia sem perfil". Foi o ensaio que pegou.
//    Marca sem barra invertida nao tem como ser comida por camada nenhuma.
//
// ⚠️ Cada marca tem de ser SUBSTRING de exatamente UMA expressao do coletor — a guarda abaixo
//    exige isso, senao duas familias trocariam de rotulo em silencio.
// ⚠️ `onde` tem de estar aqui TAMBEM, e nao so no coletor: a guarda de marca orfa percorre esta
//    lista, e sem o mesmo escopo ela acusa a marca de um container como orfa do outro — alarme
//    sobre estado legitimo, que e o defeito que este arquivo mais evita.
const PERFIL = [
  { onde: 'scada-raw', marca: 'xlsx',      nome: 'M<parque>.xlsx (SCADA por usina)' },
  { onde: 'scada-raw', marca: 'IRR_GERAL', nome: 'IRR_GERAL (estacao)' },
  { onde: 'scada-raw', marca: '(^|_)IRR_', nome: 'IRR (sensor GER_IRR)' },
  { onde: 'scada-raw', marca: 'Trafo',     nome: 'Trafo (SE)' },
  { onde: 'scada-raw', marca: '{2}_',      nome: 'M<NN> csv (inversores/perdas)' },

  // ⚠️ `IIRR_` fica de fora do JULGAMENTO de proposito (`vigia: false`): sao despejos manuais de
  //    365 dias, exportados de vez em quando. Vigiar cadencia de algo que nao tem cadencia
  //    produz alarme que acende sempre — e alarme que acende sempre ensina a ignorar a
  //    ferramenta. Ele continua sendo CONTADO, para aparecer na medicao.
  { onde: 'scada-raw', marca: 'IIRR', nome: 'IIRR (despejo manual)', vigia: false },

  // ── inversores-raw ─────────────────────────────────────────────────────────────────────────
  // ⚠️ `xls[xm]` NAO colide com o `xlsx` do `gen-scada`: sao containers diferentes, e o filtro
  //    `DESTE` ja separa os dois antes desta lista ser consultada. Dentro de cada container a
  //    marca continua casando exatamente uma expressao, que e o que a guarda exige.
  { onde: 'inversores-raw', marca: 'xls[xm]', nome: 'planilhas de falha/troca (inversores)' },
];

// o mesmo escopo do coletor, pela mesma razao
const PERFIL_DESTE = PERFIL.filter((p) => !p.onde || p.onde === RAW);

// ── O LIMIAR, e ele e do CONTAINER, nao da familia ───────────────────────────────────────────
// 🔴 MEDIDO em 02/09/2026, 38 lotes de `M<parque>.xlsx` (a familia presente em quase todo
//    deposito), colapsando arquivos a menos de 2 h:
//
//      mediana 23,6 h · p75 28,9 h · p90 49,9 h · maximo 219,8 h
//      <=26h 26 · 26-32h 2 · 32-50h 5 · 50-74h 1 · 74-170h 2 · >7d 1
//
// ⚠️ NAO ha separacao limpa em duas familias como no caso do `spanNulls`: a cauda e continua,
//    porque o deposito e feito por gente e SE RECUPERA — os lotes de 18, 27 e 45 arquivos sao
//    2, 3 e 5 dias depositados de uma vez. Entao o limiar nao "separa": ele escolhe onde doi
//    menos errar, e isso fica declarado em vez de disfarcado de aritmetica.
//
// 🔴 E O GATILHO E DO CONTAINER porque as familias CHEGAM JUNTAS — medido: os lotes de
//    29/08 22:21, 30/08 18:56, 31/08 20:18 e 01/09 11:48 aparecem identicos em quatro delas. O
//    que difere entre as distribuicoes por familia nao e cadencia: e que nem todo deposito traz
//    todas as familias. Limiar por familia alarmaria nas que legitimamente pulam um deposito.
//
// 🔴 E ELE E POR CONTAINER, sem default. Herdar 50/74 h no `inversores-raw` acenderia quase
//    sempre: MEDIDO em 02/09/2026, 14 blobs / 13 lotes,
//
//      mediana 76,7 h · p75 99,6 · p90 133,1 · maximo 320,3
//      <=26h 1 · 26-32h 1 · 32-50h 2 · 50-74h 1 · 74-170h 6 · >7d 1
//
// ⚠️ E O p90 NAO SERVE DE ALERTA AQUI, ao contrario do `scada-raw`. Metade dos vaos (6 de 12)
//    cai na faixa 74-170 h, entao um corte em 133 h fica DENTRO da banda normal e alarmaria no
//    caso comum. O corte tem de ficar acima dela.
//
// ⚠️ E a minha estimativa previa estava ERRADA: eu tinha escrito "algumas vezes por mes", e a
//    medicao mostra ~2 depositos por semana. Nos 8 lotes recentes (09/08 a 02/09) os vaos vao de
//    29,6 a 137,7 h — mediana 90,9. 170 h deixa folga sobre o pior recente, e o unico vao acima
//    dele em toda a serie e o de 320 h.
const LIMIAR = {
  'scada-raw': { alerta: 50, critico: 74 },
  'inversores-raw': { alerta: 170, critico: 336 },
};

// ⚠️ O TEXTO do alerta tambem e do container. Com um so, o vigia dos inversores mandaria um
//    assunto dizendo "SCADA" e listaria paginas que nao tem nada a ver — e quem recebe iria
//    procurar o defeito no lugar errado.
const IDENTIDADE = {
  'scada-raw': {
    rotulo: 'SCADA',
    paginas: 'SCADA/Solarimetria, Comparativo de fontes, Transformadores e Perdas de PV',
    fluxo: 'SCADA SharePoint para Blob',
  },
  'inversores-raw': {
    rotulo: 'Inversores',
    paginas: 'Inversores',
    fluxo: 'Inversores PWC -> Blob -> Grafana',
  },
};
const ID = IDENTIDADE[RAW] || { rotulo: RAW, paginas: '(nao declaradas)', fluxo: '(nao declarado)' };
const ROTULO = ID.rotulo, PAGINAS = ID.paginas, FLUXO = ID.fluxo;

// ⚠️ E o que este vigia NAO faz, dito antes que alguem conte com ele: com 7 dias de alerta, ele
//    nao pega uma queda em 15/09 a tempo. A cadencia deste container e humana e irregular, e nao
//    da para apertar o corte sem alarme falso — quem avisa depressa e o fluxo falhando, nao a
//    idade do arquivo. Aqui ele serve para parada PROLONGADA, e so.
// 🔴 A RECUSA E SO DO `vigiar`. `MODO=medir` existe justamente para PRODUZIR o limiar de um
//    container novo — bloquea-lo aqui tornaria o caminho documentado impossivel de percorrer:
//    para medir seria preciso ja ter o numero que se quer medir. Ovo e galinha, e foi assim que
//    a primeira versao desta guarda saiu.
if (!LIMIAR[RAW] && MODO !== 'medir') {
  throw new Error('limiar NAO MEDIDO para o container "' + RAW + '". A cadencia de cada container '
    + 'e diferente; copiar o numero de outro produz alarme que acende sempre. Rode MODO=medir '
    + 'neste container e acrescente o numero MEDIDO em LIMIAR.');
}
// no modo medir os limiares nao julgam nada — servem so de referencia impressa ao lado
const ALERTA_H = (LIMIAR[RAW] || {}).alerta ?? null;
const CRITICO_H = (LIMIAR[RAW] || {}).critico ?? null;

const INTAKE = require('./gen-scada-intake.js');

// 🔴 SO OS CONSUMIDORES DESTE CONTAINER. O coletor passou a servir tambem o `inversores-raw`, e
//    sem este filtro o vigia do `scada-raw` exigia perfil para uma familia que nao e dele — a
//    guarda disparou em producao, corretamente. Filtrar por `onde` mantem cada vigia com o seu
//    escopo, e um container novo continua obrigando perfil novo em vez de passar despercebido.
//
// ⚠️ Entrada sem `onde` conta como deste container: e o formato antigo, e trata-la como "de
//    outro" a esconderia do vigia — que e o defeito oposto e mais silencioso.
//
// ⚠️ A ORDEM e a do coletor, e ela importa: `IIRR_` e `IRR_GERAL_` tem de ser testados ANTES de
//    `IRR_`, senao o terceiro padrao os captura. Preservar a ordem e o motivo de percorrer
//    CONSUMIDORES em vez de iterar PERFIL.
const DESTE = INTAKE.CONSUMIDORES.filter((c) => !c.onde || c.onde === RAW);
if (!DESTE.length) {
  throw new Error('nenhum consumidor declarado para o container "' + RAW + '"');
}
const FAMILIAS = DESTE.map((c) => {
  const fonte = String(c.quando);
  const casam = PERFIL_DESTE.filter((p) => fonte.includes(p.marca));
  if (casam.length !== 1) {
    // 🔴 Falha ALTA nos DOIS sentidos. Zero: familia nova no coletor que ninguem vigia —
    //    silenciar seria o defeito original com outra roupa. Mais de uma: marca ambigua, e ai
    //    duas familias trocariam de rotulo em silencio, que e pior que nao ter rotulo.
    throw new Error('perfil ' + (casam.length ? 'AMBIGUO' : 'AUSENTE') + ' para '
      + c.quem + ' ' + fonte + (casam.length
        ? ' — marcas que casam: ' + casam.map((p) => p.marca).join(', ')
        : ' — acrescente em PERFIL'));
  }
  return { nome: casam[0].nome, quem: c.quem, casa: c.quando,
    vigia: casam[0].vigia !== false };
});

// ⚠️ e nenhuma marca pode sobrar sem dono: marca escrita e nunca casada e perfil que o humano
//    acha que esta valendo e nao esta.
{
  const usadas = new Set(FAMILIAS.map((f) => f.nome));
  const orfas = PERFIL_DESTE.filter((p) => !usadas.has(p.nome)).map((p) => p.marca);
  if (orfas.length) throw new Error('marca sem familia no coletor: ' + orfas.join(', '));
}

function familiaDe(nome) {
  for (const f of FAMILIAS) if (f.casa.test(nome)) return f;
  return null;
}

async function lista() {
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE)
    .getContainerClient(RAW);
  const out = [];
  for await (const b of c.listBlobsFlat()) {
    out.push({ nome: b.name, ms: +new Date(b.properties.lastModified) });
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function porFamilia(blobs) {
  const m = new Map(FAMILIAS.map((f) => [f.nome, []]));
  for (const b of blobs) {
    const f = familiaDe(b.nome.split('/').pop());
    if (f) m.get(f.nome).push(b);
  }
  return m;
}

function pct(v, p) {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
}

// ── lotes ────────────────────────────────────────────────────────────────────────────────────
// 🔴 O DEPOSITO E EM LOTE, e medir arquivo a arquivo mede a coisa errada. As cinco familias
//    chegam juntas (medido: todas param no mesmo minuto), entao a distribuicao arquivo-a-arquivo
//    mistura o vao DENTRO do lote (~0 h, dezenas deles) com o vao ENTRE lotes (~24 h). O p99
//    dessa mistura nao descreve cadencia nenhuma — foi o que a primeira medicao mostrou, com
//    mediana 0,0 h e maximo 219,8 h na mesma familia.
const LOTE_H = 2;   // arquivos a menos de 2 h uns dos outros sao o mesmo deposito

function lotes(v) {
  const out = [];
  for (const b of v) {
    const ult = out[out.length - 1];
    if (ult && (b.ms - ult.fim) / 3600000 <= LOTE_H) { ult.fim = b.ms; ult.n++; }
    else out.push({ ini: b.ms, fim: b.ms, n: 1 });
  }
  return out;
}

// ── MODO=medir ───────────────────────────────────────────────────────────────────────────────
function medir(m) {
  const agora = Date.now();
  console.log('container `' + RAW + '` · ' + new Date(agora).toISOString());
  console.log(LIMIAR[RAW]
    ? '  limiar em uso: ' + ALERTA_H + ' h alerta / ' + CRITICO_H + ' h critico\n'
    : '  SEM LIMIAR MEDIDO — este container ainda nao e vigiado. Escolha os cortes na\n'
      + '  distribuicao abaixo (o p90 e a cauda conhecida) e acrescente em LIMIAR.\n');
  for (const f of FAMILIAS) {
    const v = m.get(f.nome);
    if (!v.length) { console.log(f.nome.padEnd(38) + 'NENHUM arquivo'); continue; }
    const gaps = [];
    for (let i = 1; i < v.length; i++) gaps.push((v[i].ms - v[i - 1].ms) / 3600000);
    const idade = (agora - v[v.length - 1].ms) / 3600000;
    console.log(f.nome.padEnd(38) + v.length + ' arquivos');
    console.log('   ultimo    ' + new Date(v[v.length - 1].ms).toISOString()
      + '  (ha ' + idade.toFixed(1) + ' h)   ' + v[v.length - 1].nome.split('/').pop());
    const L = lotes(v);
    console.log('   ' + L.length + ' lotes (arquivos a menos de ' + LOTE_H
      + ' h sao o mesmo deposito)');
    if (L.length > 1) {
      const g = [];
      for (let i = 1; i < L.length; i++) g.push((L[i].ini - L[i - 1].fim) / 3600000);
      console.log('   entre LOTES (h):  mediana ' + pct(g, 0.5).toFixed(1)
        + ' · p75 ' + pct(g, 0.75).toFixed(1)
        + ' · p90 ' + pct(g, 0.9).toFixed(1)
        + ' · maximo ' + Math.max(...g).toFixed(1));
      const fx = [26, 32, 50, 74, 170, 1e9];
      const rot = ['<=26h (diario)', '26-32h', '32-50h (1 dia perdido)',
        '50-74h (2 dias)', '74-170h', 'alem de 7d'];
      console.log('   ' + fx.map((t, i) => rot[i] + ' ' + g.filter(
        (x) => x <= t && x > (i ? fx[i - 1] : 0)).length).join(' · '));
    }
    // os ultimos lotes, para o humano ver o padrao em vez de confiar no percentil
    console.log('   ultimos lotes: ' + L.slice(-8).map((x) =>
      new Date(x.ini).toISOString().slice(0, 16).replace('T', ' ') + ' (' + x.n + ')')
      .join('  '));
    console.log('');
  }
}

// ── MODO=vigiar ──────────────────────────────────────────────────────────────────────────────
async function vigiar(m) {
  const agora = Date.now();
  const julgadas = FAMILIAS.filter((f) => f.vigia);

  // a idade do DEPOSITO: o arquivo mais recente entre todas as familias vigiadas
  let maisNovo = 0;
  const linhas = [];
  for (const f of julgadas) {
    const v = m.get(f.nome);
    const ms = v.length ? v[v.length - 1].ms : 0;
    if (ms > maisNovo) maisNovo = ms;
    linhas.push('  ' + f.nome.padEnd(38)
      + (v.length ? ((agora - ms) / 3600000).toFixed(1) + ' h' : 'VAZIA').padStart(9)
      + (v.length ? '   ' + v[v.length - 1].nome.split('/').pop() : ''));
  }
  if (!maisNovo) {
    // 🔴 Falha ALTA: container sem arquivo nenhum nao e "esta em dia", e tratar como tal
    //    seria o defeito silencioso outra vez, agora dentro do proprio vigia.
    throw new Error('nenhuma familia vigiada tem arquivo — container vazio ou contrato de '
      + 'nome mudou');
  }

  const idade = (agora - maisNovo) / 3600000;
  const est = idade >= CRITICO_H ? 'CRITICO' : idade >= ALERTA_H ? 'ALERTA' : 'ok';
  console.log('container `' + RAW + '` · ' + new Date(agora).toISOString());
  console.log('deposito mais recente: ' + new Date(maisNovo).toISOString()
    + '  (ha ' + idade.toFixed(1) + ' h)   limiar ' + ALERTA_H + '/' + CRITICO_H + ' h   ' + est);
  console.log(linhas.join('\n'));

  // ⚠️ Familia que ficou MUITO mais atras que o deposito e sinal proprio: significa que o
  //    deposito chega mas SEM aquele arquivo. Nao dispara alerta sozinha (nem todo deposito
  //    traz todas), mas vai no corpo — foi assim que a estacao ficou 17 dias sem o sensor
  //    principal sem ninguem notar.
  const atras = julgadas.map((f) => {
    const v = m.get(f.nome);
    return { f, h: v.length ? (maisNovo - v[v.length - 1].ms) / 3600000 : Infinity };
  }).filter((x) => x.h > CRITICO_H);

  // 🔴 A CHAVE LEVA O CONTAINER. Com os dois vigias dividindo `scada-intake-parada`, o segundo
  //    a cair deduplicaria no evento do primeiro — e a recuperacao de UM fecharia o alerta do
  //    OUTRO, que continuaria parado sem ninguem saber. Dois vigias, duas chaves.
  const chave = 'intake-parada:' + RAW;
  if (est === 'ok') {
    console.log('\nintake em dia.');
    if (!SECO) {
      await alerta({ tipo: 'scada-intake', chave, resolve: true,
        assunto: ROTULO + ' · intake normalizada',
        corpo: 'O container `' + RAW + '` voltou a receber deposito.\n\n'
          + 'ultimo ha ' + idade.toFixed(1) + ' h (limiar ' + ALERTA_H + ' h)\n\n'
          + linhas.join('\n') });
    }
    return 0;
  }

  const corpo = [
    'O container `' + RAW + '` nao recebe deposito ha **' + idade.toFixed(1) + ' h** '
      + '(limiar ' + ALERTA_H + ' h; critico ' + CRITICO_H + ' h).',
    '',
    'Os geradores que o consomem NAO falham por isso: eles republicam o que ja tinham, e a',
    'pagina passa a mostrar dado velho com cara de dado de hoje. Por isso o alerta.',
    '',
    'Ultimo arquivo de cada familia:', linhas.join('\n'), '',
    'Paginas afetadas: ' + PAGINAS + '.',
    '',
    'Onde olhar: o fluxo "' + FLUXO + '" no Power Automate, e o deposito no SharePoint.',
    'Em 28/08/2026 a ponte do SCADA falhou 10x numa semana sem nada acusar.',
  ];
  if (atras.length) {
    corpo.push('', '⚠️ Familias que ficaram para tras do PROPRIO deposito (o lote chega sem '
      + 'elas):', ...atras.map((x) => '  · ' + x.f.nome + ' — ' + x.h.toFixed(1)
      + ' h atras do deposito mais recente'));
  }
  console.log('\n' + est + ': deposito ha ' + idade.toFixed(1) + ' h');
  if (!SECO) {
    await alerta({ tipo: 'scada-intake', chave,
        assunto: '[' + est + '] ' + ROTULO + ' · intake parada ha ' + Math.round(idade) + ' h',
      corpo: corpo.join('\n') });
  }
  // 🔴 NAO derruba o job: ele roda junto de outra coisa e o alerta e a saida, nao o retorno.
  return 0;
}

// ⚠️ so roda quando chamado DIRETO: o ensaio importa este arquivo para exercitar o julgamento
//    contra idades fabricadas, e sem isto o `require` dispararia a leitura do Azure — e, pior, o
//    `process.exit(1)` do tratamento de erro mataria o ensaio no meio, transformando um caso que
//    passa num caso que nunca chega a ser julgado.
module.exports = { vigiar, medir, porFamilia, lotes, FAMILIAS, ALERTA_H, CRITICO_H };
if (require.main !== module) return;

(async () => {
  const blobs = await lista();
  const m = porFamilia(blobs);
  const vistos = [...m.values()].reduce((s, v) => s + v.length, 0);
  console.log(vistos + ' de ' + blobs.length + ' blobs caem numa familia vigiada'
    + ' (o resto e despejo manual ou nome fora do contrato)\n');
  if (MODO === 'medir') return medir(m);
  return vigiar(m);
})().catch((e) => { console.error(e.message); process.exit(1); });
