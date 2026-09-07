/*
 * gen-perdas.js — a cascata de perdas do complexo -> dados/perdas_*.json
 *
 * A PERGUNTA QUE ELE RESPONDE: onde a energia se perde entre o arranjo fotovoltaico e o ponto de
 * medicao, e quanto em cada degrau. Hoje a suite mostra o que ENTROU no medidor; ela nao mostra o
 * que existia antes dele.
 *
 * A CASCATA, e o que e MEDIDO em cada etapa:
 *
 *   arranjo CC  --[POTENCIA DC TOTAL]-->  inversor  --[POTENCIA ATIVA TOTAL]-->  coletor 34,5 kV
 *        --[EneatRec do medidor]-->  ponto de faturamento
 *
 *   1. conversao       = (E_cc - E_ca) / E_cc          <- os DOIS lados medidos no MESMO inversor
 *   2. coletor         NAO E MENSURAVEL com estas fontes — ver abaixo
 *   3. consumo proprio = EneatDel / EneatRec           <- bruto contra liquido no mesmo medidor
 *
 * 🔴 A ETAPA 2 FOI REFUTADA, E A REFUTACAO ESTAVA ERRADA — corrigido em 26/08/2026. O medidor
 *    esta DEPOIS dos inversores, entao deveria ler MENOS que eles; media de 100,4% a 103,3%.
 *    Eu atribui isso a diferenca de CLASSE DE INSTRUMENTO (0,2S contra classe 1-2), o que e
 *    tecnicamente verdadeiro em si, encaixava no numero, e por isso encerrou a investigacao.
 *
 *    A causa real e outra: 5 de cada 165 inversores NAO ESTAO no arquivo de origem — 51 de 1.155
 *    no parque. Corrigindo cada usina pela cobertura (placa / arquivo), o medidor passa a ler de
 *    1% a 2% MENOS, que e exatamente a perda que a fisica exige, e as oito usinas com export
 *    quase completo caem numa faixa de 0,7% a 2,1%.
 *
 *    O que quebrou o impasse foi uma referencia EXTERNA ao dado: a contagem de placa do parque.
 *    Enquanto a completude era julgada contra o proprio dado, 3% de falta cabia folgado na
 *    tolerancia e o gerador dizia `completa: true`.
 *
 *    A perda CONTINUA fora do blob como numero, mas por outro motivo: a correcao e uma regra de
 *    tres que supoe que o inversor ausente gera como o presente. O blob publica `cobertura_pct` e
 *    `razao_medidor_corrigida`; a perda volta a ser publicavel no dia em que a medicao alcancar
 *    os 1.155.
 *
 * 🔴 NADA AQUI E ESTIMADO. A etapa 1 e a mais forte da cascata: e o mesmo equipamento, no mesmo
 *    instante, com as duas grandezas publicadas lado a lado pelo proprio inversor.
 *
 * 🔴 ENERGIA CC E CA SAO INTEGRADAS DO MESMO JEITO, e isso e uma decisao, nao um detalhe. O
 *    inversor publica `ENERGIA DIARIA GERADA`, que e um contador REAL do lado CA — mas nao existe
 *    contador equivalente do lado CC. Se eu usasse o contador para o CA e integrasse o CC, o erro
 *    de integracao cairia INTEIRO dentro da eficiencia, que e justamente o numero que a pagina
 *    existe para mostrar. Entao para a eficiencia os dois lados sao integrados por soma de
 *    amostras; o contador entra separado, onde a energia absoluta importa (a comparacao com o
 *    medidor).
 *
 * ⚠️ A amostra e INSTANTANEA a cada 30 min, nao um intervalo integrado — a mesma natureza do
 *    export dos transformadores. `p x 0,5 h` e aproximacao. Ela se cancela em boa parte na RAZAO
 *    (os dois lados erram junto), e nao se cancela no valor absoluto.
 *
 * 🔴 O DADO NAO ESTA NA COLUNA QUE O NOME SUGERE. O export repete cada bloco de inversor ate tres
 *    vezes, com sufixo _2 e _3, e a que tem dado varia. A regra e a mesma do gen-inv-scada: para
 *    cada (TS, inversor, grandeza) escolhe-se a coluna que REALMENTE tem valores naquele dia.
 *
 * FONTES: `M<NN>_<AAAAMMDD>_<HHMMSS>.csv` no container scada-raw (lado do inversor) e o blob
 *    PUBLICO `cmp_diario.json` (medidor de faturamento por usina). Ler o blob publico evita
 *    precisar da credencial da Way2 aqui, e garante que o numero do medidor seja exatamente o
 *    mesmo que a pagina de Comparativo mostra — divergencia entre duas paginas sobre o mesmo
 *    medidor seria pior que nao ter a comparacao.
 *
 * Env: DADOS_STORAGE · RAW_CONTAINER=scada-raw · OUT_CONTAINER=dados · DIAS=30
 *      LOCAL_DIR / LOCAL_OUT_DIR para ensaio.
 */
const zlib = require('zlib');
const https = require('https');
const { disponibilidade } = require('./lib-disponibilidade.js');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const DIAS = Number(process.env.DIAS || 30);
const CMP = 'https://rbenergydata.blob.core.windows.net/dados/cmp_diario.json';
// BRUTO x LIQUIDO: o consumo proprio da usina. O bruto (energia recebida) vem do cmp_diario e o
// liquido do way2_daily — os dois publicos, os dois do MESMO medidor de faturamento.
const W2D = 'https://rbenergydata.blob.core.windows.net/dados/way2_daily.json';

// M<NN>_<AAAAMMDD>_<HHMMSS>.csv em qualquer posicao (o blob vem prefixado pelo id do SharePoint)
const CARIMBO = /M(\d{2})_(\d{8})_\d{6}\.csv$/i;
const parque = (nn) => 'M' + (Number(nn) === 10 ? 1 : Number(nn));   // M10 = M1, ver a nomenclatura

// 🔴 A capacidade CA de cada usina e o que permite DESCOBRIR a unidade da coluna de potencia sem
//    supor, e e tambem a referencia que revela usina rodando abaixo do que deveria. Ver decideUnidade.
const CAP_CA_MW = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11,
  M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };

// A PLACA DOS MODULOS, da folha de dados do fabricante. Fica aqui pela mesma razao pela qual a
// placa do transformador mora no gen-trafo: duplicar a constante em N paineis garante que uma
// copia envelheca diferente.
const MODULOS = {
  jinko: { modelo: 'JKM575N/580N-72HL4-BDV', wp: [575, 580], eficiencia_pct: 22.70,
    coef_pmax_por_c: -0.29, noct_c: 45, fator_bifacial_pct: 80,
    dimensoes_mm: [2278, 1134], usinas: ['M1', 'M2', 'M3', 'M6'] },
  ja: { modelo: 'JAM72D40-575/580MB', wp: [575, 580], potencia_cc_mw: 211.14,
    usinas: ['M4', 'M5', 'M7', 'M8', 'M9'] },
};

// ---------- A PLACA DO PARQUE ------------------------------------------------------------------
//
// Lida da planilha de informacao do parque (uma tabela consolidada mais uma por usina, aberta por
// eletrocentro). Mora aqui pela mesma razao que a placa do transformador mora no gen-trafo e a
// interpretacao da NBR mora no gen-oleo: constante duplicada em N paineis envelhece diferente.
//
// 🔴 E ela que da a REFERENCIA que faltava. Ate hoje `completa` saia de um limiar sobre o proprio
//    dado (razao do medidor abaixo de 1,08) — guarda que julga o resultado contra a premissa que
//    o produziu, e por isso dizia `completa: true` nas seis usinas de 165 inversores das quais o
//    export traz 160. Agora e uma COMPARACAO com um numero de fora.
//
// Cada linha fecha por tres caminhos independentes, e foi essa conferencia que autorizou gravar:
//   1. modulos x Wp reproduz a potencia CC da propria planilha (60.988,16 kWp no M1, e nas nove);
//   2. modulos / 29 da INTEIRO exato nas nove, e esse inteiro dividido pelo numero de inversores
//      da 22,0 — exatamente o `str_n` dominante MEDIDO na telemetria. A string tem 29 modulos e o
//      inversor tem 22 strings, e as duas rotas se confirmam sem terem sido combinadas;
//   3. trackers x capacidade (Sti-H250 = 116 modulos, Trina Vanguard 1x87 = 87, 1x58 = 58)
//      reproduz a contagem de modulos EXATA nas nove.
//
// ⚠️ A planilha tem UM erro, CONFIRMADO pelo usuario em 26/08/2026: em M05 as 11 e as 22 unidades
//    estao TROCADAS entre TS7 e TS8 — o TS7 tem 22 e o TS8 tem 11. Ele tambem se prova sozinho:
//    a linha do TS8 traz metade do kWp, metade do kW, metade dos modulos e
//    metade dos trackers do TS7 — e mesmo assim 22 inversores contra 11. A telemetria concorda
//    com a fisica (TS7 com 22, TS8 com 11). Fica registrado com o numero que sustenta a decisao,
//    para que a proxima leitura da planilha encontre a conclusao em vez da duvida.
const MODULOS_POR_STRING = 29;          // DERIVADO, nao declarado — ver o item 2 acima

// Rastreadores por usina.
//
// 🔴 ATE 02/09/2026 a contagem era DERIVADA: nao existia em fonte nenhuma e saia de dividir os
//    modulos pela capacidade do modelo. A «Apresentacao do Parque Fotovoltaico e Sistemas
//    Associados» a declara por usina E por eletrocentro, e ela deixou de ser derivada.
//
// 🔴 E corrigiu o M5: sao 1.221 rastreadores, nao os 1.210 que a divisao dava. O erro nasceu de
//    supor UM modelo por usina — 105.270 / 87 = 1.210, e os 33 rastreadores de meia capacidade
//    desapareciam na conta. A apresentacao mostra o TS4 do M5 com 172 rastreadores contra os 161
//    dos irmaos: e la que eles estao.
//
// ⚠️ A apresentacao NAO serve para os MODULOS, e a guarda de strings por inversor diz por que.
//    Ela multiplica 87 por todo rastreador e chega a 106.227 no M5 — 957 modulos a mais, que sao
//    33 strings. Com eles a usina teria 22,20 strings por inversor, e o inversor tem 22; a
//    estrutura eletrica (165 x 22 x 29 = 105.270) nao os comporta. A apresentacao conta
//    ESTRUTURAS e assume capacidade cheia em todas; a placa conta MODULOS. Onde divergem, vale a
//    que a guarda sustenta: a apresentacao nos rastreadores, a placa nos modulos.
//   Sti-H250 (M1-M4) leva 116 modulos; Trina Vanguard leva 87 (1x87) ou 58 (1x58).
const TRACKERS = {
  M1: { 'Sti-H250': { cap: 116, n: 907 } },
  M2: { 'Sti-H250': { cap: 116, n: 484 } },
  M3: { 'Sti-H250': { cap: 116, n: 908 } },
  M4: { 'Sti-H250': { cap: 116, n: 907 } },
  M5: { 'Trina Vanguard 1x87': { cap: 87, n: 1188 }, 'Trina Vanguard 1x58': { cap: 58, n: 33 } },
  M6: { 'Trina Vanguard 1x87': { cap: 87, n: 1210 } },
  M7: { 'Trina Vanguard 1x87': { cap: 87, n: 322 }, 'Trina Vanguard 1x58': { cap: 58, n: 2 } },
  M8: { 'Trina Vanguard 1x87': { cap: 87, n: 1206 }, 'Trina Vanguard 1x58': { cap: 58, n: 6 } },
  M9: { 'Trina Vanguard 1x87': { cap: 87, n: 242 } },
};

// 🔴 A contagem TOTAL por usina, como a documentacao do parque a declara. Ela e a SEGUNDA rota:
//    `TRACKERS` decompoe por modelo e tem de somar isto. Sem esta guarda a decomposicao pode
//    fechar nos modulos e errar no numero de estruturas — que foi exatamente o que aconteceu no
//    M5, e ficou dois meses sem ninguem ver porque a unica conta conferida era a dos modulos.
const TRACKERS_TOTAL = { M1: 907, M2: 484, M3: 908, M4: 907, M5: 1221,
                         M6: 1210, M7: 324, M8: 1212, M9: 242 };

for (const [u, tot] of Object.entries(TRACKERS_TOTAL)) {
  const soma = Object.values(TRACKERS[u]).reduce((a, v) => a + v.n, 0);
  if (soma !== tot) {
    throw new Error('TRACKERS ' + u + ': a decomposicao por modelo soma ' + soma
      + ' rastreadores e a documentacao do parque declara ' + tot);
  }
}

const PLACA = {
  M1: { inversores: 165, modulos: 105212, cc_kwp: 60988.16, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 11, TS4: 22, TS5: 22, TS6: 22, TS7: 22, TS8: 22 } },
  M2: { inversores: 88, modulos: 56144, cc_kwp: 32282.80, ca_kw: 27200,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22 } },
  M3: { inversores: 165, modulos: 105328, cc_kwp: 61054.86, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 11, TS5: 22, TS6: 22, TS7: 22, TS8: 22 } },
  M4: { inversores: 165, modulos: 105212, cc_kwp: 60988.16, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 11, TS7: 22, TS8: 22 } },
  M5: { inversores: 165, modulos: 105270, cc_kwp: 61021.36, ca_kw: 51000,
    // TS7/TS8: a planilha inverte 11 e 22; vale a leitura que a propria linha dela sustenta
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 22, TS7: 22, TS8: 11 } },
  M6: { inversores: 165, modulos: 105270, cc_kwp: 60530.25, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 11, TS6: 22, TS7: 22, TS8: 22 } },
  M7: { inversores: 44, modulos: 28130, cc_kwp: 16174.75, ca_kw: 13600,
    inv_por_ts: { TS1: 22, TS2: 22 } },
  M8: { inversores: 165, modulos: 105270, cc_kwp: 60530.25, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 22, TS7: 11, TS8: 22 } },
  // ⚠️ M9: o TS1 tem 22 inversores e o TS2 tem 11 — confirmado pela equipe em 02/09/2026, e e o
  //    inverso do que esta constante trazia. A leitura se sustenta no padrao das tags ausentes:
  //    as mesmas cinco (INV04, 05, 06, 08 e 10) faltam sempre num eletrocentro de 22, e no M9 elas
  //    faltam no TS1.
  M9: { inversores: 33, modulos: 21054, cc_kwp: 12106.05, ca_kw: 10200,
    inv_por_ts: { TS1: 22, TS2: 11 } },
};

// 🔴 Os trackers fecham contra a placa: trackers x capacidade tem de reproduzir a contagem de
//    modulos de CADA usina. E o que sustenta os 7.404 — sem esta guarda ele seria so um numero
//    bonito no meio do arquivo, porque nenhuma fonte o declara. Corrigir a placa sem corrigir os
//    trackers deixa o job vermelho, em vez de publicar uma contagem que ninguem consegue conferir.
for (const [u, p] of Object.entries(PLACA)) {
  const mods = Object.values(TRACKERS[u] || {}).reduce((s, v) => s + v.cap * v.n, 0);
  if (mods !== p.modulos) {
    throw new Error('TRACKERS ' + u + ': trackers x capacidade dao ' + mods
      + ' modulos e a placa diz ' + p.modulos);
  }
}

// 🔴 A placa se confere contra ELA MESMA na partida, nao na revisao de codigo. Se alguem corrigir
//    um numero sem corrigir os outros, o job fica vermelho em vez de publicar uma placa incoerente.
for (const [u, p] of Object.entries(PLACA)) {
  const soma = Object.values(p.inv_por_ts).reduce((a, b) => a + b, 0);
  if (soma !== p.inversores) {
    throw new Error('PLACA ' + u + ': os eletrocentros somam ' + soma + ' inversores e o total diz '
      + p.inversores);
  }
  if (p.modulos % MODULOS_POR_STRING) {
    throw new Error('PLACA ' + u + ': ' + p.modulos + ' modulos nao e multiplo de '
      + MODULOS_POR_STRING + ' — ou a contagem mudou, ou a string deixou de ter 29 modulos');
  }
  const strPorInv = (p.modulos / MODULOS_POR_STRING) / p.inversores;
  if (Math.abs(strPorInv - 22) > 0.15) {
    throw new Error('PLACA ' + u + ': ' + strPorInv.toFixed(2) + ' strings por inversor, e o '
      + 'inversor tem 22 — modulos e inversores nao contam a mesma usina');
  }
}

const GRANDEZAS = {
  p_cc: 'POTÊNCIA DC TOTAL',
  p_ca: 'POTÊNCIA ATIVA TOTAL',
  e_conta: 'ENERGIA DIÁRIA GERADA',      // contador diario do lado CA
  setpoint: 'SETPOINT POTÊNCIA ATIVA',   // separa curtailment de defeito
  nominal: 'POTÊNCIA ATIVA NOMINAL',
  temp: 'TEMPERATURA INTERNA',
  isol: 'RESISTÊNCIA DE ISOLAÇÃO',
  freq: 'FREQUÊNCIA DA REDE',
  fp: 'FATOR DE POTÊNCIA TOTAL',
  horas: 'TEMPO DE OPERAÇÃO DIÁRIA',
};
// 🔴 As 12 correntes de MPPT e as 24 de string NAO vao para o blob uma a uma: seriam ~40 mil
//    series para 1.104 inversores, e nenhum painel le isso. O que vai e a DISPERSAO entre elas
//    no instante de maior potencia do inversor — que e o sinal fino de string suja, sombreada ou
//    desconectada, reduzido a um numero por inversor por dia.
const MPPT_RE = /^CORRENTE MPPT (\d+)$/;
const STRING_RE = /^CORRENTE STRING (\d+)$/;

const norm = (s) => String(s == null ? '' : s).trim();
const num = (v) => { const s = norm(v).replace(',', '.'); if (!s) return null;
  const n = Number(s); return isFinite(n) ? n : null; };
const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);
const r4 = (x) => (x == null ? null : Math.round(x * 10000) / 10000);
const soma = (a) => a.reduce((s, x) => s + x, 0);
const media = (a) => (a.length ? soma(a) / a.length : null);

// ---------- entrada ---------------------------------------------------------------------------
function puxa(url) {
  return new Promise((ok, ko) => {
    const u = new URL(url);
    https.get({ host: u.host, path: u.pathname, family: 4,
      headers: { 'accept-encoding': 'gzip' } }, (r) => {
      if (r.statusCode !== 200) { ko(new Error(url + ' -> HTTP ' + r.statusCode)); return; }
      const c = []; r.on('data', (d) => c.push(d));
      r.on('end', () => {
        let b = Buffer.concat(c);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        try { ok(JSON.parse(b.toString('utf8'))); } catch (e) { ko(e); }
      });
    }).on('error', ko);
  });
}

async function listaArquivos() {
  if (process.env.LOCAL_DIR) {
    const fs = require('fs'), path = require('path');
    return fs.readdirSync(process.env.LOCAL_DIR).filter((n) => CARIMBO.test(n))
      .map((n) => ({ nome: n, ler: async () => fs.readFileSync(path.join(process.env.LOCAL_DIR, n)) }));
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  if (!process.env.DADOS_STORAGE) throw new Error('DADOS_STORAGE nao definido');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(RAW_CONTAINER);
  const out = []; let total = 0;
  for await (const b of c.listBlobsFlat()) {
    total++;
    if (!CARIMBO.test(b.name)) continue;
    out.push({ nome: b.name, ler: async () => c.getBlobClient(b.name).downloadToBuffer() });
  }
  if (!out.length) throw new Error('nenhum M<NN>_<data>_<hora>.csv em "' + RAW_CONTAINER
    + '" — 0 de ' + total + ' blob(s)');
  return out;
}

// ---------- um arquivo = uma usina num dia ----------------------------------------------------
function leUsinaDia(buf) {
  const txt = buf.toString('utf8').replace(/^﻿/, '').replace(/\r/g, '');
  const L = txt.split('\n');
  const cols = L[0].split(';');
  const linhas = [];
  for (let k = 1; k < L.length; k++) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2};/.test(L[k])) linhas.push(L[k].split(';'));
  }
  if (!linhas.length) return null;

  // 🔴 O RETROVISOR (\1 \2 \3) E O QUE ANCORA — a coluna repete o proprio prefixo antes do rotulo.
  //    Esta forma foi MEDIDA contra o arquivo real, e "simplifica-la" ja fez o gerador irmao casar
  //    ZERO colunas em 45 arquivos. Copiada de la, nao reescrita.
  const RE = /^UFV_(\w+?)_(TS\d+)_(INV\d+)_\1 \2 \3 (.+?)(_\d)?$/;
  const alvo = new Map(Object.entries(GRANDEZAS).map(([k, v]) => [v, k]));
  const cand = new Map();
  const vistas = [];
  cols.forEach((c, i) => {
    const m = norm(c).match(RE);
    if (!m) { if (vistas.length < 3 && /^UFV_.*INV\d/.test(norm(c))) vistas.push(norm(c).slice(0, 80)); return; }
    let chave = alvo.get(m[4]);
    if (!chave && MPPT_RE.test(m[4])) chave = 'mppt#' + m[4].match(MPPT_RE)[1];
    if (!chave && STRING_RE.test(m[4])) chave = 'str#' + m[4].match(STRING_RE)[1];
    if (!chave) return;
    const k = m[2] + '|' + m[3] + '|' + chave;
    if (!cand.has(k)) cand.set(k, []);
    cand.get(k).push(i);
  });
  if (!cand.size) {
    throw new Error('nenhuma coluna de inversor casou o padrao'
      + (vistas.length ? ' — vistas: ' + vistas.join(' | ') : ''));
  }

  // 🔴 escolhe a coluna que TEM dado, em vez de supor o sufixo
  const inv = new Map();                      // "TS|INV" -> { serie: {chave: [v por linha]} }
  for (const [k, idxs] of cand) {
    const [ts, iv, chave] = k.split('|');
    let melhor = null, melhorN = 0;
    for (const i of idxs) {
      let n = 0; for (const l of linhas) if (num(l[i]) != null) n++;
      if (n > melhorN) { melhorN = n; melhor = i; }
    }
    if (!melhorN) continue;
    const kk = ts + '|' + iv;
    if (!inv.has(kk)) inv.set(kk, { ts, inv: iv, serie: {} });
    inv.get(kk).serie[chave] = linhas.map((l) => num(l[melhor]));
  }
  return { linhas, inv, instantes: linhas.map((l) => l[0]) };
}

// ---------- a unidade da coluna de potencia sai da MEDICAO -------------------------------------
// 🔴 O export nao declara unidade. Supor kW e publicar potencia mil vezes maior com o rotulo certo
//    e o modo de falhar mais caro desta familia. Aqui o pico da SOMA dos inversores da usina e
//    comparado com a capacidade CA declarada dela: a razao so pode dar ~1 (MW), ~1000 (kW) ou
//    ~1e6 (W). Qualquer outra coisa significa que a coluna nao e o que o nome diz, e o job para.
// 🔴 A unidade e determinada UMA VEZ para o export inteiro, e nao por usina. Ela e propriedade da
//    coluna — mesmo SCADA, mesmo nome —, entao decidi-la usina a usina faz uma usina que gera
//    POUCO parecer erro de unidade. Foi o que aconteceu na primeira rodada: o M9 chegou a 49% da
//    capacidade e o job abortou, quando 49% e um ACHADO sobre o M9, nao um problema de leitura.
//    A regra passa a ser: a unidade sai da usina que casa MELHOR, e a razao de cada uma das outras
//    vira informacao no log.
let UNIDADE = null;
function decideUnidade(picos) {
  const cand = [{ f: 1, u: 'MW' }, { f: 1e-3, u: 'kW' }, { f: 1e-6, u: 'W' }];
  let melhor = null;
  for (const c of cand) {
    for (const [ufv, pico] of Object.entries(picos)) {
      const razao = (pico * c.f) / CAP_CA_MW[ufv];
      const erro = Math.abs(Math.log(razao));            // simetrico: 2x e 0,5x pesam igual
      if (razao > 0.6 && razao < 1.3 && (!melhor || erro < melhor.erro)) {
        melhor = { fator: c.f, unidade: c.u, razao, erro, ufv };
      }
    }
  }
  if (!melhor) {
    throw new Error('nenhuma usina casa MW, kW ou W contra a capacidade declarada. Picos: '
      + Object.entries(picos).map(([u, p]) => u + '=' + Math.round(p)).join(' ')
      + '. A coluna de potencia ativa mudou de significado — publicar assim poria a grandeza '
      + 'errada com o rotulo certo.');
  }
  return melhor;
}

// ---------- saida -------------------------------------------------------------------------------
// ---------- historico: o gerador passa a ACUMULAR -----------------------------------------------
//
// 🔴 A FONTE SO GUARDA 30 DIAS. Medido em 26/08/2026: o container tem 288 arquivos em 30 carimbos
//    (24/07 a 25/08). Enquanto o gerador reescrevia o blob inteiro a cada rodada, o historico de
//    PV ficava PRESO nesses 30 dias para sempre — nao por escolha, por construcao. Acumulando, ele
//    cresce um dia por rodada a partir de hoje.
//
// Janelas: as de tempo saem do mesmo teto de ~8.700 linhas que dimensiona os blobs do MUST e da
// solarimetria (48 leituras por dia em 30 min, 24 em 1 h). A de inversor sai do PESO: sao 1.104
// linhas por dia e ~47 KB por dia gzipado, e essa e a maior coisa que a pagina de strings baixa.
const JANELA = { diario: 730, min30: 180, min60: 365, inv: 60 };

const diaDeMs = (ms) => new Date(ms - 3 * 3600e3).toISOString().slice(0, 10);

// 🔴 SO O 404 DEVOLVE VAZIO. Qualquer outra falha — 500, gzip corrompido, JSON truncado — ESTOURA.
//    A versao ingenua devolve vazio para tudo, o gerador trata como primeira execucao e regrava o
//    blob so com os dias da rodada: uma falha de rede apagaria o historico inteiro, sem erro
//    visivel. E a licao que o `leBlob` do MUST ja tinha pago.
async function leAnterior(nome) {
  try {
    const j = await puxa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
    return Array.isArray(j.serie) ? j.serie : [];
  } catch (e) {
    if (/HTTP 404/.test(e.message)) return [];
    throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: '
      + 'regravar sem o historico apagaria o que ja foi acumulado.');
  }
}

// funde o que veio agora com o que ja estava publicado; a rodada nova sempre GANHA na colisao,
// porque um dia pode voltar mais completo do que da primeira vez
function acumula(antigas, novas, chave, dias, diaDe) {
  const m = new Map();
  for (const l of antigas) m.set(chave(l), l);
  let n = 0;
  for (const l of novas) { if (!m.has(chave(l))) n++; m.set(chave(l), l); }
  let todas = [...m.values()];
  const ds = [...new Set(todas.map(diaDe))].sort();
  const corte = ds.slice(-dias)[0];
  todas = todas.filter((l) => diaDe(l) >= corte);
  todas.sort((a, b) => (chave(a) < chave(b) ? -1 : chave(a) > chave(b) ? 1 : 0));
  return { serie: todas, novas: n, mantidas: todas.length - n };
}

async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) {
    require('fs').writeFileSync(require('path').join(process.env.LOCAL_OUT_DIR, nome), gz);
    return gz.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient(OUT_CONTAINER);
  await c.createIfNotExists();
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

// ---------- principal ---------------------------------------------------------------------------
(async () => {
  const arqs = await listaArquivos();
  // so a versao MAIS RECENTE de cada (usina, dia): o export pode ser repetido no mesmo dia
  // 🔴 O DIA SAI DO DADO, nunca do nome do arquivo. O carimbo do nome e a data em que alguem
  //    EXPORTOU, e o export cobre o dia ANTERIOR — medido no irmao dos transformadores, onde
  //    `Trafo_20260822` traz 21/08. Usar o nome desloca a serie inteira em um dia e, pior, casa a
  //    energia dos inversores de um dia com o medidor de outro.
  const porChave = new Map();
  for (const a of arqs) {
    const m = a.nome.split('/').pop().match(CARIMBO);
    porChave.set(a.nome, { ...a, ufv: parque(m[1]), carimbo: m[2] });
  }
  // o carimbo do nome so serve para ESCOLHER quais ler (os mais recentes); o dia vem do conteudo
  const carimbos = [...new Set([...porChave.values()].map((x) => x.carimbo))].sort();
  const corteC = carimbos.slice(-(DIAS + 1))[0];
  const escolhidos = [...porChave.values()].filter((x) => x.carimbo >= corteC)
    .sort((a, b) => (a.carimbo + a.ufv < b.carimbo + b.ufv ? -1 : 1));
  console.log('  arquivos: ' + arqs.length + ' · ' + carimbos.length + ' carimbos ('
    + carimbos[0] + ' a ' + carimbos[carimbos.length - 1] + ') · lendo ' + escolhidos.length);

  const diario = new Map();          // dia -> { ufv -> {...} }
  const meia = new Map();            // ms -> { ufv -> {p_cc, p_ca, n} }
  const porInv = new Map();          // (dia|ufv|ts|inv) -> linha; lendo em ordem, o ultimo vence
  const picos = {}, nInv = {}, cobertura = {};
  let avisouDia = false;       // pico CRU da soma CA e n de inversores, por usina

  for (const a of escolhidos) {
    let d;
    try { d = leUsinaDia(await a.ler()); }
    catch (e) { console.log('    ' + a.ufv + ' ' + a.dia + ': ' + e.message); continue; }
    if (!d) continue;
    // o dia REAL: o primeiro carimbo de tempo do conteudo. Se um arquivo cobrir dois dias, o
    // majoritario decide — e a divergencia contra o nome vai ao log uma vez.
    const contagem = {};
    for (const t of d.instantes) { const dd = String(t).slice(0, 10); contagem[dd] = (contagem[dd] || 0) + 1; }
    a.dia = Object.entries(contagem).sort((x, y) => y[1] - x[1])[0][0];
    if (!avisouDia) {
      const doNome = a.carimbo.slice(0, 4) + '-' + a.carimbo.slice(4, 6) + '-' + a.carimbo.slice(6);
      console.log('  dia do CONTEUDO ' + a.dia + ' · dia do NOME ' + doNome
        + (a.dia === doNome ? '  (iguais)' : '  <- o nome e a data do EXPORT, nao do dado'));
      avisouDia = true;
    }

    // pico da soma CA, para descobrir a unidade
    const nLin = d.linhas.length;
    const somaCA = new Array(nLin).fill(0), somaCC = new Array(nLin).fill(0);
    const nCA = new Array(nLin).fill(0), nCC = new Array(nLin).fill(0);
    for (const o of d.inv.values()) {
      const ca = o.serie.p_ca, cc = o.serie.p_cc;
      for (let i = 0; i < nLin; i++) {
        if (ca && ca[i] != null) { somaCA[i] += ca[i]; nCA[i]++; }
        if (cc && cc[i] != null) { somaCC[i] += cc[i]; nCC[i]++; }
      }
    }
    const totalInv = d.inv.size;
    // ⚠️ Guarda o valor CRU e escala DEPOIS: a unidade so pode ser decidida quando todas as usinas
    //    tiverem sido vistas, senao a primeira usina do lote decide sozinha por todas.
    const f = 1;
    picos[a.ufv] = Math.max(picos[a.ufv] || 0, Math.max(...somaCA));
    nInv[a.ufv] = totalInv;

    // ---- por instante, com TUDO-OU-NADA -------------------------------------------------------
    // 🔴 Somar 800 inversores de 1.104 e chamar de usina INVENTA perda: o que falta some do lado
    //    CA e do CC em proporcoes diferentes, e a diferenca vira "perda" que ninguem teve.
    for (let i = 0; i < nLin; i++) {
      if (nCA[i] !== totalInv || nCC[i] !== totalInv) continue;
      const ms = Date.parse(d.instantes[i].replace(' ', 'T') + 'Z') + 3 * 3600e3;
      if (!meia.has(ms)) meia.set(ms, {});
      meia.get(ms)[a.ufv] = { cc: somaCC[i] * f, ca: somaCA[i] * f, n: totalInv };
    }

    // ---- energia do dia: integra os DOIS lados do mesmo jeito ---------------------------------
    const completos = [];
    for (let i = 0; i < nLin; i++) if (nCA[i] === totalInv && nCC[i] === totalInv) completos.push(i);
    const e_cc = soma(completos.map((i) => somaCC[i] * f)) * 0.5;      // MWh
    const e_ca = soma(completos.map((i) => somaCA[i] * f)) * 0.5;
    // o contador do lado CA, para a comparacao com o medidor (energia absoluta)
    let e_conta = 0, comConta = 0;
    for (const o of d.inv.values()) {
      const v = (o.serie.e_conta || []).filter((x) => x != null);
      if (v.length) { e_conta += Math.max(...v); comConta++; }
    }
    if (!diario.has(a.dia)) diario.set(a.dia, {});
    diario.get(a.dia)[a.ufv] = { e_cc, e_ca, e_conta: e_conta / 1000, n_inv: totalInv,
      n_conta: comConta, slots: completos.length, slots_totais: nLin };

    // ---- por inversor -------------------------------------------------------------------------
    for (const o of d.inv.values()) {
      const cc = o.serie.p_cc || [], ca = o.serie.p_ca || [];
      const bons = [];
      for (let i = 0; i < nLin; i++) if (cc[i] != null && ca[i] != null) bons.push(i);
      if (!bons.length) continue;
      const eCC = soma(bons.map((i) => cc[i] * f)) * 0.5;
      const eCA = soma(bons.map((i) => ca[i] * f)) * 0.5;
      // dispersao entre MPPTs e entre strings NO INSTANTE DE MAIOR POTENCIA do proprio inversor.
      // ⚠️ Tem de ser no pico: em baixa irradiancia todas as correntes sao pequenas e a dispersao
      //    relativa estoura por ruido, apontando defeito onde ha so amanhecer.
      let iPico = bons[0];
      for (const i of bons) if ((ca[i] || 0) > (ca[iPico] || 0)) iPico = i;
      const disp = (pref) => {
        const v = Object.keys(o.serie).filter((k) => k.startsWith(pref))
          .map((k) => o.serie[k][iPico]).filter((x) => x != null && x > 0);
        if (v.length < 3) return null;
        const ord = v.slice().sort((x, y) => x - y);
        const md = ord[ord.length >> 1];
        return md > 0.2 ? { n: v.length, med: r2(md),
          min_pct: r2((ord[0] / md) * 100), max_pct: r2((ord[ord.length - 1] / md) * 100) } : null;
      };
      const dm = disp('mppt#'), ds = disp('str#');
      const t = (o.serie.temp || []).filter((x) => x != null);
      // 🔴 A REFERENCIA DE DESPACHO SE MEDE DURANTE A GERACAO, nao no minimo do dia. O minimo do
      //    dia e a NOITE: com o inversor desligado a referencia vai a zero, e o minimo diario passa
      //    a ser zero quase todo dia. Publiquei assim na primeira versao e o painel saiu com M1 em
      //    6.893% — dividir pelo tipico de um inversor cujo tipico e ~zero explode. A mediana
      //    tomada apenas nos instantes em que o inversor de fato produz e a grandeza que existe.
      const pico = Math.max(...bons.map((i) => ca[i] || 0));
      const spGer = bons.filter((i) => (ca[i] || 0) > 0.05 * pico)
        .map((i) => (o.serie.setpoint || [])[i]).filter((x) => x != null);
      const spOrd = spGer.slice().sort((x, y) => x - y);
      const sp = (o.serie.setpoint || []).filter((x) => x != null);
      const nom = (o.serie.nominal || []).filter((x) => x != null);
      porInv.set(a.dia + '|' + a.ufv + '|' + o.ts + '|' + o.inv, { dia: a.dia, ufv: a.ufv, ts: o.ts, inv: o.inv,
        e_cc: r4(eCC), e_ca: r4(eCA),
        ef: eCC > 0.001 ? r4(eCA / eCC) : null,
        p_ca_max: r2(Math.max(...bons.map((i) => ca[i] * f)) * 1000),   // kW
        temp_max: t.length ? r2(Math.max(...t)) : null,
        setpoint_min: sp.length ? r2(Math.min(...sp)) : null,
        setpoint_ger: spOrd.length >= 3 ? r2(spOrd[spOrd.length >> 1]) : null,
        nominal: nom.length ? r2(nom[nom.length - 1]) : null,
        // no pico do proprio inversor: quanto a MENOR corrente vale em relacao a mediana das suas
        // irmas. 100% e equilibrio perfeito; string desconectada leva isso perto de zero.
        mppt_min_pct: dm ? dm.min_pct : null, mppt_n: dm ? dm.n : null,
        str_min_pct: ds ? ds.min_pct : null, str_max_pct: ds ? ds.max_pct : null, str_n: ds ? ds.n : null,
        isol_min: (o.serie.isol || []).filter((x) => x != null).length
          ? r2(Math.min(...(o.serie.isol || []).filter((x) => x != null))) : null,
        horas: (o.serie.horas || []).filter((x) => x != null).length
          ? r2(Math.max(...(o.serie.horas || []).filter((x) => x != null))) : null,
        n: bons.length });
    }
    if (escolhidos.indexOf(a) % 40 === 0) {
      console.log('    ' + a.dia + ' ' + a.ufv + ': ' + totalInv + ' inversores · '
        + completos.length + '/' + nLin + ' slots completos');
    }
  }

  if (!diario.size) throw new Error('nenhum dia aproveitado');
  const us = [...new Set(Object.keys(CAP_CA_MW))];

  // ---- a unidade, decidida UMA VEZ com todas as usinas a vista --------------------------------
  const u = decideUnidade(picos);
  UNIDADE = u.unidade;
  console.log('  unidade da coluna de potencia: ' + u.unidade + ' (decidida pelo ' + u.ufv
    + ', razao ' + u.razao.toFixed(3) + ')');
  console.log('  pico da soma CA contra a capacidade declarada, por usina:');
  for (const ufv of us) {
    if (picos[ufv] == null) { console.log('    ' + ufv + ': sem dado'); continue; }
    const r = (picos[ufv] * u.fator) / CAP_CA_MW[ufv];
    console.log('    ' + ufv.padEnd(4) + String(nInv[ufv]).padStart(4) + ' inversores · pico '
      + (picos[ufv] * u.fator).toFixed(2).padStart(7) + ' MW de ' + String(CAP_CA_MW[ufv]).padStart(7)
      + ' MW = ' + (r * 100).toFixed(1) + '%' + (r < 0.6 ? '   <-- ACHADO: bem abaixo da capacidade' : ''));
  }

  // aplica o fator a tudo o que foi guardado cru
  const F = u.fator;
  for (const porU of diario.values()) {
    for (const o of Object.values(porU)) { o.e_cc *= F; o.e_ca *= F; }
  }
  for (const porU of meia.values()) {
    for (const o of Object.values(porU)) { o.cc *= F; o.ca *= F; }
  }
  for (const o of porInv.values()) {
    if (o.e_cc != null) o.e_cc = r4(o.e_cc * F);
    if (o.e_ca != null) o.e_ca = r4(o.e_ca * F);
    if (o.p_ca_max != null) o.p_ca_max = r2(o.p_ca_max * F);
  }

  // ---- o medidor, do blob PUBLICO --------------------------------------------------------------
  const cmp = await puxa(CMP);
  const med = new Map();
  for (const l of (cmp.serie || [])) {
    const dia = String(l.t || '').slice(0, 10);
    const o = {};
    for (let i = 1; i <= 9; i++) if (l['w' + i] != null) o['M' + i] = l['w' + i];
    if (Object.keys(o).length) med.set(dia, o);
  }
  console.log('  medidor lido do blob publico: ' + med.size + ' dias');

  // ---- bruto x liquido: o consumo proprio ------------------------------------------------------
  const w2 = await puxa(W2D);
  const liq = new Map();
  for (const l of (w2.dias || [])) {
    if (!l.completo) continue;          // dia parcial nao serve para consumo, que e quase fixo
    liq.set(l.dia, { ufv: l.ufv_liq_mwh || {}, ger: l.ene_ger_mwh, lq: l.ene_liq_mwh });
  }
  console.log('  liquido lido do blob publico: ' + liq.size + ' dias completos');

  // ---- guardas ----------------------------------------------------------------------------------
  const efs = [], razMed = [];
  for (const [dia, porU] of diario) {
    for (const [ufv, o] of Object.entries(porU)) {
      if (o.e_cc > 1) efs.push(o.e_ca / o.e_cc);
      const m = (med.get(dia) || {})[ufv];
      if (m != null && o.e_ca > 1) razMed.push(m / o.e_ca);
    }
  }
  // 🔴 A falha tem de DIZER O QUE VIU. Uma guarda que so barra manda adivinhar entre mapa
  //    trocado, inversor faltando, dia deslocado e integracao errada — e sao quatro hipoteses
  //    diferentes, cada uma com uma correcao diferente.
  console.log('  medidor contra as DUAS medidas de energia CA do inversor:');
  console.log('    (integrada = soma das amostras; contador = ENERGIA DIARIA GERADA do inversor)');
  for (const ufv of us) {
    const rs = [];
    for (const [dia, porU] of diario) {
      const o = porU[ufv], m = (med.get(dia) || {})[ufv];
      if (o && m != null && o.e_ca > 1) {
        rs.push({ dia, inv: o.e_ca, con: o.e_conta, med: m, r: m / o.e_ca,
          rc: o.e_conta > 1 ? m / o.e_conta : null });
      }
    }
    if (!rs.length) { console.log('    ' + ufv + ': sem par'); continue; }
    rs.sort((a, b) => a.r - b.r);
    const q = rs[rs.length >> 1];
    console.log('    ' + ufv.padEnd(4) + q.dia + '  integrada ' + q.inv.toFixed(1).padStart(7)
      + ' · contador ' + (q.con == null ? '   -   ' : q.con.toFixed(1).padStart(7))
      + ' · medidor ' + q.med.toFixed(1).padStart(7) + ' MWh  ->  medidor/integrada '
      + (q.r * 100).toFixed(1) + '%  medidor/contador '
      + (q.rc == null ? '-' : (q.rc * 100).toFixed(1) + '%') + '  (n=' + rs.length + ')');
  }
  efs.sort((a, b) => a - b); razMed.sort((a, b) => a - b);
  const efMed = efs[efs.length >> 1], medMed = razMed[razMed.length >> 1];
  console.log('  eficiencia de conversao (mediana dos dias-usina): ' + (efMed * 100).toFixed(2) + '%'
    + ' · faixa ' + (efs[0] * 100).toFixed(1) + '% a ' + (efs[efs.length - 1] * 100).toFixed(1) + '%');
  console.log('  medidor / energia CA dos inversores (mediana): ' + (medMed * 100).toFixed(2) + '%');

  // 🔴 A eficiencia de um inversor de string moderno fica entre 96% e 99% em carga util. Fora
  //    disso a coluna nao e o que o nome diz — e um numero plausivel com rotulo certo e o modo de
  //    falhar mais caro desta familia.
  if (!(efMed > 0.90 && efMed < 0.995)) {
    throw new Error('eficiencia mediana de ' + (efMed * 100).toFixed(2) + '% esta fora de 90..99,5%. '
      + 'As colunas de potencia CC e CA nao estao no papel que o nome sugere — NAO publicar.');
  }
  // 🔴 A PRIMEIRA VERSAO DESTA GUARDA ESTAVA ERRADA, e vale registrar por que. Eu exigi que o
  //    medidor fosse MENOR que a soma dos inversores — ele esta depois deles, afinal — e pus o teto
  //    em 102%. Medido: sete usinas dao 100,9% a 104,2%, de forma consistente. O motivo e que a
  //    amostra do inversor e INSTANTANEA a cada 30 min e o medidor e integrador de verdade: a
  //    integracao por soma de amostras erra alguns por cento, nos dois sentidos, e essa faixa
  //    engole a perda de coletor, que e de 1% a 2%. Guarda apertada demais transforma o metodo em
  //    defeito.
  //
  //    O que a guarda julga agora e o SISTEMATICO — a mediana entre usinas. Usina fora da faixa
  //    NAO aborta: vira ACHADO de cobertura, porque e exatamente assim que o export incompleto se
  //    manifesta. Medido no mesmo dia: M7 com 39 inversores da 111%, e M9 com 18 da 154% — nos
  //    dois o medidor ve energia que nenhum inversor do arquivo reportou.
  if (!(medMed > 0.90 && medMed < 1.10)) {
    throw new Error('a mediana entre usinas do medidor contra a energia CA dos inversores e '
      + (medMed * 100).toFixed(1) + '%, fora de 90..110%. Isso nao e erro de integracao — e mapa '
      + 'de usina trocado ou grandeza errada.');
  }
  // ---- cobertura por usina: quantos dos inversores DE PLACA chegaram ao arquivo ----------------
  //
  // 🔴 O criterio mudou de dono. Ele era `razao_medidor <= 1,08`, um limiar sobre o proprio dado —
  //    e por isso dizia `completa: true` nas seis usinas de 165 inversores das quais o export traz
  //    160: 3% de falta cabia folgado dentro dos 8% de tolerancia. Agora a completude e uma
  //    CONTAGEM contra a placa, e o limiar sobre o medidor volta ao papel dele, que e outro:
  //    denunciar o caso em que a falta e grande o bastante para aparecer na energia.
  //
  // A razao corrigida e o que torna a perda ate o medidor legivel de novo. Sem ela, o somatorio
  // dos inversores esta sistematicamente subdimensionado e o medidor parece ler MAIS do que a
  // usina gerou — foi o que refutou, erradamente, a perda de coletora.
  //
  // ⚠️ Ela e uma REGRA DE TRES, e a suposicao vai declarada: os inversores ausentes geram como os
  //    presentes. Vale enquanto a falta for pequena e espalhada; e por isso que a perda ate o
  //    medidor NAO e publicada como numero, so a razao de onde ela sai. Publicar "perda de X%"
  //    apoiado numa extrapolacao de 3% da usina seria dar ao numero uma firmeza que ele nao tem.
  for (const ufv of us) {
    const rs = [];
    for (const [dia, porU] of diario) {
      const o = porU[ufv], m = (med.get(dia) || {})[ufv];
      if (o && m != null && o.e_ca > 1) rs.push(m / o.e_ca);
    }
    if (!rs.length) continue;
    rs.sort((a, b) => a - b);
    const r = rs[rs.length >> 1];
    const p = PLACA[ufv];
    const n = nInv[ufv] || 0;
    const fator = n ? p.inversores / n : null;             // o quanto o somatorio esta subdimensionado
    cobertura[ufv] = {
      razao_medidor: r4(r),
      n_inversores: n || null,
      inversores_de_placa: p.inversores,
      inversores_ausentes: p.inversores - n,
      cobertura_pct: n ? r2((n / p.inversores) * 100) : null,
      razao_medidor_corrigida: fator ? r4(r / fator) : null,
      pico_pct_da_capacidade: r2(((picos[ufv] || 0) * u.fator / CAP_CA_MW[ufv]) * 100),
      completa: n === p.inversores,
    };
    if (n !== p.inversores) {
      console.log('  ⚠️ ' + ufv + ': ' + n + ' de ' + p.inversores + ' inversores de placa no '
        + 'arquivo (' + ((n / p.inversores) * 100).toFixed(1) + '%) · medidor '
        + (r * 100).toFixed(1) + '% da energia deles, ' + ((r / fator) * 100).toFixed(1)
        + '% corrigido pela cobertura');
    }
  }
  // 🔴 A soma nao pode ser um numero que ninguem confere: o total de placa e conhecido, entao o
  //    total ausente vai para o log toda rodada. Uma falta que CRESCE e a informacao que interessa.
  const totPlaca = us.reduce((a, x) => a + PLACA[x].inversores, 0);
  const totArq = us.reduce((a, x) => a + (nInv[x] || 0), 0);
  console.log('  cobertura do parque: ' + totArq + ' de ' + totPlaca + ' inversores ('
    + ((totArq / totPlaca) * 100).toFixed(1) + '%) · ausentes ' + (totPlaca - totArq));

  // ---- limitacao de despacho, por usina e por dia ------------------------------------------------
  // 🔴 A REFERENCIA E O PROPRIO INVERSOR, nao a potencia nominal. Medido: `setpoint_min` dividido
  //    por `POTENCIA ATIVA NOMINAL` da mediana 411 e p90 838 — as duas colunas nao estao na mesma
  //    unidade, e eu nao sei qual e a de cada uma. Comparar o dia com o valor TIPICO daquele mesmo
  //    inversor no periodo dispensa saber a unidade: a razao e adimensional por construcao.
  //
  //    Isto existe para separar DEFEITO de DESPACHO. Sem ele, o painel de perdas acusa o inversor
  //    de um problema que e de operacao: medido no M1 em 09/08, a referencia caiu 94%, a usina
  //    rodou a 2,5% da nominal o dia inteiro, e a eficiencia caiu POR ISSO — inversor longe do
  //    ponto nominal converte pior por natureza, e nao ha o que consertar nele.
  const tipico = new Map();                  // (ufv|ts|inv) -> mediana do setpoint_min no periodo
  const porInvUfv = new Map();
  for (const o of porInv.values()) {
    const k = o.ufv + '|' + o.ts + '|' + o.inv;
    if (o.setpoint_ger == null) continue;
    if (!porInvUfv.has(k)) porInvUfv.set(k, []);
    porInvUfv.get(k).push(o.setpoint_ger);
  }
  for (const [k, v] of porInvUfv) {
    const s = v.slice().sort((a, b) => a - b);
    // 🔴 a MEDIANA tem de ser positiva, nao o maximo: um inversor cujo tipico e ~zero faz
    //    qualquer dia normal virar milhares por cento, que foi exatamente o defeito publicado.
    const md = s[s.length >> 1];
    if (s.length >= 5 && md > 0) tipico.set(k, md);
  }
  const desp = new Map();                    // dia -> ufv -> { raz, limitados, n }
  for (const o of porInv.values()) {
    const t = tipico.get(o.ufv + '|' + o.ts + '|' + o.inv);
    if (t == null || t <= 0 || o.setpoint_ger == null) continue;
    if (!desp.has(o.dia)) desp.set(o.dia, {});
    const d = desp.get(o.dia);
    if (!d[o.ufv]) d[o.ufv] = { rs: [], lim: 0 };
    const r = o.setpoint_ger / t;
    d[o.ufv].rs.push(r);
    if (r < 0.5) d[o.ufv].lim++;             // metade do proprio tipico: limitacao inequivoca
  }
  console.log('  dias-usina com a maioria dos inversores sob referencia reduzida:');
  let nAviso = 0;
  for (const [dia, porU] of [...desp.entries()].sort()) {
    for (const [ufv, x] of Object.entries(porU)) {
      if (x.lim > x.rs.length / 2 && nAviso < 12) {
        console.log('    ' + dia + ' ' + ufv.padEnd(4) + x.lim + ' de ' + x.rs.length
          + ' inversores abaixo de metade da propria referencia tipica');
        nAviso++;
      }
    }
  }

  // ---- saida ------------------------------------------------------------------------------------
  const meta = {
    gerado_em: new Date().toISOString(),
    usinas: us, unidade_de_origem: UNIDADE,
    unidade: 'energia em MWh; potencia em MW; eficiencia adimensional (0..1)',
    rotulo_de_tempo: 'amostra instantânea a cada 30 min (não é média de intervalo)',
    metodo: 'energia CC e CA integradas da MESMA forma (soma das amostras × 0,5 h), para que o '
      + 'erro de integração se cancele na razão; o contador do inversor entra separado, onde a '
      + 'energia absoluta importa',
    tudo_ou_nada: 'instante só entra se TODOS os inversores da usina reportarem os dois lados',
    modulos: MODULOS,
    // a placa vai INTEIRA no blob para que o painel leia dela em vez de repetir a contagem: o
    // total do parque escrito num título envelhece na primeira usina que ganhar inversor
    placa: PLACA,
    trackers: TRACKERS,
    trackers_total: Object.values(TRACKERS).reduce((t, m) =>
      t + Object.values(m).reduce((x, v) => x + v.n, 0), 0),
    // ⚠️ A nota dizia 'Contagem DERIVADA... nao ha fonte que a declare'. Deixou de ser verdade em
    //    02/09/2026, e nota que afirma ausencia de fonte quando a fonte existe manda o proximo
    //    leitor derivar de novo o que ja esta declarado — foi assim que o M5 ficou com 1.210.
    trackers_nota: 'Contagem LIDA da Apresentacao do Parque Fotovoltaico e Sistemas Associados, '
      + 'por usina e por eletrocentro. Confere por duas rotas: a decomposicao por modelo soma o '
      + 'total declarado, e trackers x capacidade reproduz a contagem de modulos da placa nas nove.',
    placa_total: {
      inversores: Object.values(PLACA).reduce((a, p) => a + p.inversores, 0),
      modulos: Object.values(PLACA).reduce((a, p) => a + p.modulos, 0),
      strings: Object.values(PLACA).reduce((a, p) => a + p.modulos, 0) / MODULOS_POR_STRING,
      cc_mwp: r2(Object.values(PLACA).reduce((a, p) => a + p.cc_kwp, 0) / 1000),
      ca_mw: r2(Object.values(PLACA).reduce((a, p) => a + p.ca_kw, 0) / 1000),
    },
    modulos_por_string: MODULOS_POR_STRING,
    capacidade_ca_mw: CAP_CA_MW,
    cobertura_por_usina: cobertura,
    fonte_medidor: 'medidor de faturamento, o mesmo número publicado na página de comparação de fontes',
    disponibilidade: {
      metodo: 'tempo de operação diário de cada inversor sobre a janela do dia (mediana do complexo dos '
        + 'contadores diurnos); média simples dos inversores da usina; grupos ponderados pelo número '
        + 'de inversores. Inversor com contador de 24 h conta como disponível e é contado à parte.',
      campos: { disp_pct: 'disponibilidade da usina no dia, %', inv_parados: 'inversores com menos de metade da janela',
        inv_parciais: 'entre 50% e 90% da janela', inv_contador_24h: 'inversores cujo contador não zera à noite',
        janela_h: 'janela de operação do dia, em horas', CX_disp_pct: 'o complexo, ponderado por inversor' },
      nao_e: 'a disponibilidade declarada ao operador nacional (disp_pct do executivo), que é capacidade '
        + 'declarada no nível do conjunto — as duas convivem e se conferem',
    },
  };

  // ---- disponibilidade por usina, do contador de operacao do inversor ----------------------------
  // A regra mora em lib-disponibilidade.js, com o ensaio dela; aqui so se alimenta e se emite.
  const DISP = disponibilidade([...porInv.values()].map((o) => ({ dia: o.dia, ufv: o.ufv, ts: o.ts, inv: o.inv, horas: o.horas }))).porDia;
  { const semJanela = [...DISP.entries()].filter(([, r]) => r.janela_min == null);
    if (semJanela.length) console.log('  ⚠️ disponibilidade sem janela em ' + semJanela.length + ' dia(s): ' + semJanela.slice(0, 3).map(([d, r]) => d + ' (' + r.nota + ')').join(' · '));
    const jan = [...DISP.values()].map((r) => r.janela_min).filter((x) => x != null);
    if (jan.length) console.log('  disponibilidade: janela do dia ' + (Math.min(...jan) / 60).toFixed(2) + ' a ' + (Math.max(...jan) / 60).toFixed(2) + ' h em ' + jan.length + ' dias'); }

  const serieDiaria = [...diario.entries()].sort().map(([dia, porU]) => {
    const o = { dia, ms: Date.parse(dia + 'T00:00:00Z') + 3 * 3600e3 };
    let scc = 0, sca = 0, scon = 0, smed = 0, ok = 0;
    for (const ufv of us) {
      const x = porU[ufv]; if (!x) continue;
      o[ufv + '_e_cc'] = r2(x.e_cc);
      o[ufv + '_e_ca'] = r2(x.e_ca);
      o[ufv + '_e_conta'] = r2(x.e_conta);
      o[ufv + '_n_inv'] = x.n_inv;
      // 🔴 A cobertura sai AQUI, do lado da placa, e nao no JSONata do painel: dividir pela
      //    contagem de placa dentro da consulta seria escrever a placa em cada painel que a usa,
      //    e a primeira usina que ganhasse inversor deixaria as copias divergindo em silencio.
      o[ufv + '_cob_pct'] = r2((x.n_inv / PLACA[ufv].inversores) * 100);
      o[ufv + '_n_placa'] = PLACA[ufv].inversores;
      const D = (desp.get(dia) || {})[ufv];
      if (D && D.rs.length) {
        const rs = D.rs.slice().sort((p, q) => p - q);
        o[ufv + '_despacho_pct'] = r2(rs[rs.length >> 1] * 100);   // referencia do dia / tipica
        o[ufv + '_n_limitados'] = D.lim;
      }
      o[ufv + '_n_conta'] = x.n_conta;
      o[ufv + '_slots'] = x.slots;
      { const R = DISP.get(dia); const dv = R && R.porUfv[ufv];
        if (dv) { o[ufv + '_disp_pct'] = dv.disp_pct; o[ufv + '_inv_parados'] = dv.parados;
          o[ufv + '_inv_parciais'] = dv.parciais; o[ufv + '_inv_contador_24h'] = dv.contador_24h; }
        if (R && R.janela_min != null && o.janela_h == null) { o.janela_h = r2(R.janela_min / 60);
          if (R.complexo) o.CX_disp_pct = R.complexo.disp_pct; } }
      if (x.e_cc > 1) o[ufv + '_perda_conv_pct'] = r2(((x.e_cc - x.e_ca) / x.e_cc) * 100);
      // consumo proprio da usina: o que o medidor recebeu menos o que ficou liquido
      const L = liq.get(dia);
      if (L && L.ufv[ufv] != null) {
        const bruto = (med.get(dia) || {})[ufv];
        if (bruto != null && bruto > 1) {
          o[ufv + '_e_liq'] = r2(L.ufv[ufv]);
          o[ufv + '_consumo_mwh'] = r2(bruto - L.ufv[ufv]);
          o[ufv + '_consumo_pct'] = r2(((bruto - L.ufv[ufv]) / bruto) * 100);
        }
      }
      const m = (med.get(dia) || {})[ufv];
      if (m != null) {
        o[ufv + '_e_med'] = r2(m);
        // 🔴 NAO EXISTE "perda de coletor" AQUI, e a medicao e que diz isso. Eu supus que o erro
        //    da integracao por amostra (~2 a 3%) estivesse mascarando uma perda de 1 a 2%, e liguei
        //    o contador de energia do inversor para eliminar esse erro. Medido nas sete usinas com
        //    export completo: contador e integracao concordam dentro de 0,5% — a integracao nunca
        //    foi o problema.
        //
        //    O que sobra e que o medidor le 1 a 3% A MAIS que os inversores produzem, de forma
        //    consistente. Isso NAO pode ser perda: perda faria o medidor ler MENOS. E diferenca de
        //    INSTRUMENTO — medidor de faturamento e classe 0,2S/0,5S, medicao interna de inversor
        //    e classe 1 a 2 —, e ela tem a mesma ordem de grandeza da perda que se queria medir.
        //
        //    Entao a etapa publica a RAZAO entre os dois instrumentos, e nao uma perda. Publicar
        //    `perda_col_pct` poria um numero NEGATIVO num painel de perdas, e quem lesse concluiria
        //    que o coletor gera energia.
        if (x.e_conta > 1) o[ufv + '_razao_med_conta'] = r4(m / x.e_conta);
        smed += m; ok++;
      }
      scc += x.e_cc; sca += x.e_ca; scon += x.e_conta;
    }
    if (ok === us.length) {          // tudo-ou-nada tambem no agregado
      o.Complexo_e_cc = r2(scc); o.Complexo_e_ca = r2(sca);
      o.Complexo_e_conta = r2(scon); o.Complexo_e_med = r2(smed);
      o.Complexo_perda_conv_pct = r2(((scc - sca) / scc) * 100);
      // ⚠️ No complexo o bruto e o liquido saem do MESMO blob, medidos no mesmo ponto — nao ha
      //    mistura de fontes. O consumo em MWh e quase FIXO ao longo dos dias; e a geracao que
      //    varia. Publicar so o percentual faria o dia nublado parecer desperdicio, entao vao os
      //    dois: o absoluto diz quanto se consome, o percentual diz quanto isso pesa.
      const L = liq.get(dia);
      if (L && L.ger > 1) {
        o.Complexo_e_bruto = r2(L.ger); o.Complexo_e_liq = r2(L.lq);
        o.Complexo_consumo_mwh = r2(L.ger - L.lq);
        o.Complexo_consumo_pct = r2(((L.ger - L.lq) / L.ger) * 100);
      }
      if (scon > 1) o.Complexo_razao_med_conta = r4(smed / scon);
    }
    return o;
  });

  const serie30 = [...meia.entries()].sort((a, b) => a[0] - b[0]).map(([ms, porU]) => {
    const o = { ms, t: new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') };
    for (const ufv of us) {
      const x = porU[ufv]; if (!x) continue;
      o[ufv + '_p_cc'] = r2(x.cc); o[ufv + '_p_ca'] = r2(x.ca);
      if (x.cc > 0.5) o[ufv + '_ef'] = r4(x.ca / x.cc);
    }
    return o;
  });

  // ---------- a serie de 1 HORA, agregada da de 30 min ------------------------------------------
  // ⚠️ POTENCIA se promedia no balde; a eficiencia se REFAZ da soma dos dois lados, nunca se
  //    promedia — media de razoes nao e a razao das medias, e o erro apareceria justamente nas
  //    pontas do dia, onde a potencia e pequena.
  const hora = new Map();
  for (const [ms, porU] of meia) {
    const k = Math.floor(ms / 3600e3) * 3600e3;
    const a = hora.get(k) || hora.set(k, {}).get(k);
    for (const ufv of us) {
      const x = porU[ufv]; if (!x) continue;
      const o = a[ufv] || (a[ufv] = { cc: 0, ca: 0, n: 0 });
      o.cc += x.cc; o.ca += x.ca; o.n++;
    }
  }
  const serie60 = [...hora.entries()].sort((a, b) => a[0] - b[0]).map(([ms, porU]) => {
    const o = { ms, t: new Date(ms - 3 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') };
    for (const ufv of us) {
      const x = porU[ufv]; if (!x || !x.n) continue;
      o[ufv + '_p_cc'] = r2(x.cc / x.n); o[ufv + '_p_ca'] = r2(x.ca / x.n);
      if (x.cc > 0.5) o[ufv + '_ef'] = r4(x.ca / x.cc);
    }
    return o;
  });

  const saidas = [];
  for (const [nome, serie, chave, dias] of [
    ['perdas_diario.json', serieDiaria, (l) => l.dia, JANELA.diario],
    ['perdas_30min.json', serie30, (l) => l.ms, JANELA.min30],
    ['perdas_60min.json', serie60, (l) => l.ms, JANELA.min60],
    ['perdas_inv.json', [...porInv.values()],
      (l) => l.dia + '|' + l.ufv + '|' + l.ts + '|' + l.inv, JANELA.inv],
  ]) {
    const { serie: sf, novas, mantidas } = acumula(
      await leAnterior(nome), serie, chave, dias, (l) => l.dia || diaDeMs(l.ms));
    // 🔴 A JANELA MEDIDA VAI AO LADO DA CONFIGURADA. `janela_dias` e o TETO; quem quiser dizer ao
    //    leitor quanto o arquivo cobre HOJE tem de usar `dias_cobertos`. Publicar so o teto e o
    //    que faz um seletor prometer "180 dias" num arquivo de 32 — numero declarado que nao
    //    corresponde ao dado vira promessa quebrada na tela, e o leitor culpa o dado.
    const cob = new Set(sf.map((l) => l.dia || diaDeMs(l.ms))).size;
    saidas.push(nome + ': ' + sf.length + ' linhas (' + novas + ' novas, ' + mantidas
      + ' do historico) · ' + cob + ' dias cobertos de ' + dias + ' · '
      + Math.round(await grava(nome, { ...meta, janela_dias: dias, dias_cobertos: cob,
        serie: sf }) / 1024) + ' KB');
  }
  for (const s of saidas) console.log('  ' + s);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
