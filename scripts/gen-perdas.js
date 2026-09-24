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
const { disponibilidade, completaDisponibilidade, janelaContrato, dispContrato } = require('./lib-disponibilidade.js');

const RAW_CONTAINER = process.env.RAW_CONTAINER || 'scada-raw';
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const DIAS = Number(process.env.DIAS || 30);
const CMP = 'https://rbenergydata.blob.core.windows.net/dados/cmp_diario.json';
// BRUTO x LIQUIDO: o consumo proprio da usina. O bruto (energia recebida) vem do cmp_diario e o
// liquido do way2_daily — os dois publicos, os dois do MESMO medidor de faturamento.
const W2D = 'https://rbenergydata.blob.core.windows.net/dados/way2_daily.json';

// M<NN>_<AAAAMMDD>_<HHMMSS>.csv em qualquer posicao (o blob vem prefixado pelo id do SharePoint)
// 🔴 `_ATT` entre a usina e a data: em 24/09/2026 o export do dia 23/09 chegou como `M02_ATT_20260924_...`,
//    ja com os 46 inversores que faltavam, e o padrao antigo o ignorava EM SILENCIO — o dia nao foi
//    publicado e nada ficou vermelho. Outro sufixo continua fora de proposito: quem o acusa e o contrato
//    de nome do `gen-scada-intake.js`, que reconhece a familia e reprova o nome desconhecido.
const CARIMBO = /M(\d{2})(?:_ATT)?_(\d{8})_\d{6}\.csv$/i;
const parque = (nn) => 'M' + (Number(nn) === 10 ? 1 : Number(nn));   // M10 = M1, ver a nomenclatura
// a ordem de ENVIO e o numero do prefixo: 5 digitos no legado, 14 na entrada nova. Comparar o nome como
// texto poria o legado ("9...") depois do novo ("2026...").
const envio = (nome) => { const m = String(nome).split('/').pop().match(/^(\d+)_/); return m ? Number(m[1]) : 0; };

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
  e_vida: 'ENERGIA TOTAL GERADA',        // so para achar o carimbo sem registro (ver carimbosSemRegistro)
};

// 🔴 O CARIMBO SEM REGISTRO se reconhece pelo CONTADOR DE VIDA, e nao pela tensao ou pela potencia.
//    Numa parada REAL (disjuntor do alimentador aberto) a tensao e a potencia tambem vao a zero — e
//    sao medicao. O que so o artefato faz e o contador acumulado DESCER: numa parada ele segura o
//    valor; no artefato ele vai a zero ou fica a meio caminho (28/07 09:00 a 76%, 12/08 11:00 a 4,6%).
//    Contador acumulado nao desce por definicao, entao nao ha limiar escolhido. A primeira versao
//    usava a tensao CA abaixo da faixa do fabricante (640 V) e teria apagado um desligamento real.
//    A regra e POR ELETROCENTRO: metade ou mais dos inversores do TS com o contador abaixo do ultimo
//    valor valido, no mesmo carimbo. Uma troca de inversor (um so, o contador novo parte de zero)
//    nao alcanca a metade, e a parada daquele inversor continua na tela.
//    Devolve Map(indice do carimbo -> Set de inversores sem registro nele).
const SEM_REGISTRO = [];
function carimbosSemRegistro(d) {
  const n = d.linhas.length;
  const porTs = new Map();
  for (const o of d.inv.values()) { if (!porTs.has(o.ts)) porTs.set(o.ts, []); porTs.get(o.ts).push(o); }
  const fora = new Map();
  for (const invs of porTs.values()) {
    const ref = invs.map(() => null);          // ultimo valor VALIDO do contador de cada inversor
    for (let i = 0; i < n; i++) {
      let com = 0, desce = 0;
      const v = invs.map((o) => (o.serie.e_vida || [])[i]);
      invs.forEach((o, k) => {
        if (v[k] == null || ref[k] == null) return;
        com += 1; if (v[k] < ref[k] - 1) desce += 1;
      });
      const artefato = com >= 2 && desce * 2 >= com;
      if (artefato) {
        if (!fora.has(i)) fora.set(i, new Set());
        for (const o of invs) fora.get(i).add(o);
      }
      /* a referencia so anda fora do artefato: senao o zero escrito pelo servidor viraria a base, e
         o carimbo seguinte (ainda zero) passaria como valido */
      invs.forEach((o, k) => { if (v[k] != null && !artefato && !(ref[k] != null && v[k] < ref[k] - 1)) ref[k] = v[k]; });
      /* troca de UM inversor: o contador novo nao volta ao antigo; depois de 2 carimbos seguidos
         abaixo, fora de artefato, ele vira a referencia daquele inversor */
      invs.forEach((o, k) => {
        if (artefato || v[k] == null || ref[k] == null || !(v[k] < ref[k] - 1)) { o._abaixo = 0; return; }
        o._abaixo = (o._abaixo || 0) + 1;
        if (o._abaixo >= 2) { ref[k] = v[k]; o._abaixo = 0; }
      });
    }
  }
  for (const o of d.inv.values()) delete o._abaixo;
  return fora;
}
// 🔴 As 12 correntes de MPPT e as 24 de string NAO vao para o blob uma a uma: seriam ~40 mil
//    series para 1.104 inversores, e nenhum painel le isso. O que vai e a DISPERSAO entre elas
//    no instante de maior potencia do inversor — que e o sinal fino de string suja, sombreada ou
//    desconectada, reduzido a um numero por inversor por dia.
const MPPT_RE = /^CORRENTE MPPT (\d+)$/;
const STRING_RE = /^CORRENTE STRING (\d+)$/;

// 🔴 A CURVA DENTRO DO DIA, e o PISO que decide quando ela existe.
//    Ate 13/09/2026 estas grandezas eram reduzidas ao dia — o pico, o maximo — e a curva de 30 min
//    que as produz era descartada. O humano pediu quatro vezes os intervalos, e ele estava certo:
//    a fonte os tem, e a linha 47 deste arquivo ja dizia que a amostra e instantanea a cada 30 min.
//    Nao ha leitura nova aqui: e a MESMA passada, sem jogar a curva fora.
//
// 🔴 O PISO NAO E ESCOLHIDO, e sem ele o painel publicaria ruido como defeito. A dispersao entre
//    strings e uma RAZAO, e razao entre correntes pequenas estoura: medido no M3 em 12/09, nos 160
//    inversores, meia hora a meia hora — com a mediana das strings ABAIXO de 3 A a dispersao entre
//    os inversores e de 56 pp; acima dela, 28 pp. A transicao e abrupta e cai entre 06:00
//    (mediana 1,15 A) e 06:30 (3,47 A). Abaixo do piso a razao NAO EXISTE, em vez de existir
//    errada — a mesma decisao que o irmao da razao contra os pares ja tomou com os 10 kWh.
const PISO_STR_A = 3;

// Piso do `ef_imp` (instantes com CA > CC). NAO e escolhido: e a convencao da casa para "o
// inversor estava gerando" (p >= 1 kW, a mesma da faixa do piso no painel de strings), e ela e
// onde o ruido de zero acaba. Medido nas nove usinas, 7 dias de curva: ABAIXO de 1 kW de CC,
// 21 de 21 instantes tem CA > CC (offset de zero, nao energia); de 1 kW para cima, de 0,2% a 2,5%.
// 🔴 O piso vale sobre o CA (o lado ALTO do par), nao sobre o CC — corrigido em 24/09/2026. Aqueles 21
//    NAO eram todos offset: 14 tinham CA de 1 a 5 kW (rampa) e 7 tinham CA de 12 a 123 kW com CC abaixo
//    de 1 kW — queda de leitura do lado CC, seis no MESMO instante (21/09 14:30) em quatro usinas. O piso
//    no CC descartava justamente esses, e tres dias ficaram com ef > 100% e ef_imp zero. Com o piso no
//    CA, fica de fora so o que o piso existe para tirar: os dois lados perto de zero.
const EF_IMP_PISO_KW = 1;

// 🔴 ZERO NA ISOLACAO E AUSENCIA, NAO MEDICAO — e isso foi medido no arquivo CRU, nao deduzido.
//    Em 12/08 o M3/TS1/INV01 traz isolacao 0 as 12:00 com o inversor entregando 317 kW,
//    cercada de 462 nos vizinhos; as 18h, 20h e 22h, com o inversor PARADO, traz 462. Arranjo
//    com isolacao zero esta em curto e nao gera: o 0 e o valor sentinela de "sem leitura".
//    Os zeros se concentram em 6 dias de 51, em quatro deles na frota INTEIRA — e como
//    `isol_min` e o MINIMO do dia, um unico instante assim zerava o dia do inversor. Eram
//    4.468 dias-inversor publicando zero, e o painel desenhava a curva caindo a zero.
//    ⚠️ Isto NAO e alisar valor implausivel (a licao do canal do 04T2): la o canal descia em
//       RAMPA e filtrar escondia a rampa. Aqui o zero e exato, isolado e com o equipamento em
//       plena geracao. Ele vira ausencia, e vai CONTADO.
const isoSemLeitura = (x) => x === 0;
const DIAS_HORA = 7;              // a janela do intradiario, por usina — ver o custo no cabecalho

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
// memoria por NOME: o `perdas_inv.json` passou a ser lido duas vezes na mesma rodada (uma para
// alimentar a disponibilidade, outra para acumular na publicacao) e ele e o maior dos quatro.
// Dentro de uma rodada o blob nao muda, entao cachear e so nao baixar de novo.
// 🔴 O ESQUEMA VAI MARCADO NO BLOB, E A CONVERSAO NAO SE ADIVINHA PELO VALOR.
//    O setpoint passou de W para kW em 13/09/2026, e as linhas ja publicadas estao em W. A
//    tentacao e converter quem "parece W" (valor alto), e ela FALHA: medido no arquivo, existe um
//    valor de 36,9 entre 112.604 — em W e um inversor quase parado, em kW seria 36,9 kW, e o
//    corte por magnitude o deixaria para tras. Um caso em cento e doze mil ainda e um caso, e
//    varrer isso para baixo e o que esta casa nao faz.
//    Entao o arquivo DIZ em que esquema esta, e a conversao roda uma vez, sobre o arquivo inteiro.
// 🔴 E O MESMO MECANISMO SERVE AO `isol_min`: as linhas ja publicadas trazem 4.468 zeros, que a
//    medicao mostrou serem ausencia de leitura e nunca isolamento. Elas nao podem ser
//    recalculadas — a fonte retem ~30 dias e os dias afetados vao ate 28/07 —, entao o zero
//    vira NULO: ausencia e honesta, e zero ali e uma afirmacao que sabemos falsa.
//    ⚠️ So o zero EXATO do campo de isolacao e tocado. Nenhum outro valor, nenhum outro campo.
const ESQUEMA = 3;   // 1 = setpoint em W · 2 = setpoint em kW · 3 = zero da isolacao e ausencia
const CAMPOS_SETPOINT = ['setpoint_min', 'setpoint_ger'];

function migraSetpoint(j, nome) {
  const s = Array.isArray(j.serie) ? j.serie : [];
  if (nome !== 'perdas_inv.json' || !s.length) return s;
  if (Number(j.esquema) >= 2) return s;
  let n = 0;
  for (const l of s) {
    for (const k of CAMPOS_SETPOINT) {
      if (typeof l[k] === 'number') { l[k] = Math.round((l[k] / 1000) * 100) / 100; n += 1; }
    }
  }
  console.log('  setpoint: ' + n + ' valor(es) do historico convertidos de W para kW (esquema '
    + (j.esquema || 1) + ' -> ' + ESQUEMA + ')');
  return s;
}

function migraIsolZero(j, nome) {
  const s = Array.isArray(j.serie) ? j.serie : [];
  if (nome !== 'perdas_inv.json' || !s.length) return s;
  if (Number(j.esquema) >= 3) return s;
  let n = 0;
  for (const l of s) {
    if (l.isol_min === 0) { l.isol_min = null; n += 1; }
  }
  console.log('  isolamento: ' + n + ' minimo(s) do historico que valiam ZERO viraram NULO '
    + '(esquema ' + (j.esquema || 1) + ' -> ' + ESQUEMA + ')');
  return s;
}

const _anterior = new Map();
async function leAnterior(nome) {
  if (_anterior.has(nome)) return _anterior.get(nome);
  try {
    const j = await puxa('https://rbenergydata.blob.core.windows.net/dados/' + nome);
    migraSetpoint(j, nome);
    const s = migraIsolZero(j, nome);
    _anterior.set(nome, s);
    return s;
  } catch (e) {
    if (/HTTP 404/.test(e.message)) { _anterior.set(nome, []); return []; }
    throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + '). Abortando: '
      + 'regravar sem o historico apagaria o que ja foi acumulado.');
  }
}


// funde o que veio agora com o que ja estava publicado; a rodada nova sempre GANHA na colisao,
// porque um dia pode voltar mais completo do que da primeira vez
function acumula(antigas, novas, chave, dias, diaDe) {
  const m = new Map();
  // 🔴 O DIA QUE A RODADA RECALCULOU E INTEIRO DELA. So "ganhar na colisao" nao basta: quando a guarda
  //    do carimbo sem registro tira as nove usinas de um carimbo, a rodada nao produz linha para ele,
  //    e a linha velha — o zero escrito pelo servidor — sobrevivia do historico (28/07 09:30, medido
  //    em 19/09/2026). Linha antiga de um dia recalculado que a rodada nao produziu, sai.
  //    ⚠️ Por (dia, usina) onde a linha tem usina (uma linha por inversor): uma rodada que lesse so
  //    algumas usinas de um dia nao pode apagar as outras. Onde a linha junta as usinas, e por dia —
  //    ali a linha ja era trocada inteira na colisao.
  const grupo = (l) => diaDe(l) + '|' + (l.ufv || '');
  const diasNovos = new Set(novas.map(grupo));
  for (const l of antigas) if (!diasNovos.has(grupo(l))) m.set(chave(l), l);
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
  // 🔴 UM arquivo por (usina, carimbo): o dia da usina e SOBRESCRITO pelo ultimo lido, e a ordem entre dois
  //    arquivos do mesmo carimbo nao era determinada. Com `M02_...` e `M02_ATT_...` do mesmo dia, sairia um
  //    ou outro por acaso. Fica o envio mais recente, a mesma regra do `gen-inv-scada.js`.
  const porChave = new Map();
  for (const a of arqs) {
    const m = a.nome.split('/').pop().match(CARIMBO);
    const k = parque(m[1]) + '|' + m[2], ant = porChave.get(k);
    if (!ant || envio(a.nome) > envio(ant.nome)) porChave.set(k, { ...a, ufv: parque(m[1]), carimbo: m[2] });
  }
  // o carimbo do nome so serve para ESCOLHER quais ler (os mais recentes); o dia vem do conteudo
  const carimbos = [...new Set([...porChave.values()].map((x) => x.carimbo))].sort();
  const corteC = carimbos.slice(-(DIAS + 1))[0];
  const escolhidos = [...porChave.values()].filter((x) => x.carimbo >= corteC)
    .sort((a, b) => (a.carimbo + a.ufv < b.carimbo + b.ufv ? -1 : 1));
  console.log('  arquivos: ' + arqs.length + ' · ' + carimbos.length + ' carimbos ('
    + carimbos[0] + ' a ' + carimbos[carimbos.length - 1] + ') · lendo ' + escolhidos.length);

  // a janela do CONTRATO (irradiancia acima de 100 W/m2), por dia e usina, do blob de 30 min que a
  // solarimetria ja publica. Sem ela a disponibilidade contratual simplesmente nao sai nesta rodada
  // — e isso vai ao log, em vez de virar um numero calculado com outra janela.
  let JAN_CONTRATO = new Map();
  try {
    const irr30 = await puxa('https://rbenergydata.blob.core.windows.net/dados/irr_30min.json');
    JAN_CONTRATO = janelaContrato(irr30.serie, (irr30.ufvs || []).filter((u) => u !== 'Complexo'));
    const hs = [...JAN_CONTRATO.values()].map((s) => s.size / 2).sort((a, b) => a - b);
    console.log('  janela do contrato (irradiância > 100 W/m²): ' + JAN_CONTRATO.size + ' dias-usina · '
      + (hs.length ? hs[0].toFixed(1) + ' a ' + hs[hs.length - 1].toFixed(1) + ' h, mediana ' + hs[hs.length >> 1].toFixed(1) + ' h' : '—'));
  } catch (e) {
    console.log('  ⚠️ sem irr_30min: a disponibilidade pela janela do contrato não sai nesta rodada (' + e.message + ')');
  }

  const diario = new Map();          // dia -> { ufv -> {...} }
  const meia = new Map();            // ms -> { ufv -> {p_cc, p_ca, n} }
  const porInv = new Map();          // (dia|ufv|ts|inv) -> linha; lendo em ordem, o ultimo vence
  // a curva de 30 min, por usina · (ufv) -> Map(dia|ts|inv -> linha de ARRAYS)
  // 🔴 ARRAYS, e nao uma linha por ponto: medido no dia real do M3, uma linha por ponto da 84 KB
  //    gzipados e os arrays dao 52 — 38% menos, porque o dia, o eletrocentro e o inversor deixam
  //    de ser repetidos vinte e cinco vezes.
  const horaPorUfv = new Map();
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

    // 🔴 CARIMBO SEM REGISTRO, ESCRITO COMO NUMERO. Quando o servidor do supervisorio fica sem
    //    registro, o export NAO deixa vazio: escreve ZERO em tudo (potencia, tensao da rede,
    //    contadores de vida) e interpola rampas nos carimbos vizinhos. Medido em 19/09/2026 nos 57
    //    dias da fonte: 28/07 09:00-10:00 nas nove usinas (publicado como o complexo a 0 MW),
    //    05/08 13:30 no M2, 12/08 11:00 e 12:00 no M4 — e ZERO carimbos vazios com a usina gerando.
    //    O criterio e o contador de vida descendo em metade ou mais do eletrocentro (ver
    //    `carimbosSemRegistro`): o carimbo vira AUSENCIA para aqueles inversores — nenhuma serie dele
    //    e usada. Uma parada real segura o contador e continua sendo medicao.
    const semRegistro = carimbosSemRegistro(d);
    if (semRegistro.size) {
      const h = [];
      for (const [i, invs] of semRegistro) {
        for (const o of invs) for (const k of Object.keys(o.serie)) o.serie[k][i] = null;
        h.push(String(d.instantes[i]).slice(11, 16) + '(' + invs.size + ')');
      }
      SEM_REGISTRO.push({ ufv: a.ufv, dia: a.dia, h });
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

    // ---- por instante, com o MESMO CONJUNTO dos dois lados ------------------------------------
    // 🔴 Somar todo CA disponivel e todo CC disponivel e chamar de usina INVENTA perda: o que falta
    //    some de um lado e do outro em proporcoes diferentes, e a diferenca vira "perda" que ninguem
    //    teve. A guarda e o CONJUNTO: em cada instante entram so os inversores que tem CC E CA, e os
    //    dois lados sao somados sobre esse mesmo conjunto.
    // 🔴 Ate 19/09/2026 o instante so entrava com TODOS os inversores do arquivo. Cinco inversores do
    //    M9/TS1 entrando na coleta as 14:00 de 18/09 deixaram o dia com 19 de 48 instantes e 4,0 MWh
    //    integrados contra 12,16 do contador: a manha inteira, medida em 18 inversores, foi jogada
    //    fora porque faltavam 5 que ainda nem estavam na coleta — a mesma situacao dos 51 que nunca
    //    estiveram, e que sempre entraram como COBERTURA, nao como corte de instante. Com o conjunto
    //    por instante a energia da usina FECHA com a soma dos inversores, que o `perdas_inv` ja
    //    integrava cada um sobre os seus proprios instantes com os dois lados.
    const parCC = new Array(nLin).fill(0), parCA = new Array(nLin).fill(0), nPar = new Array(nLin).fill(0);
    for (const o of d.inv.values()) {
      const ca = o.serie.p_ca, cc = o.serie.p_cc;
      if (!ca || !cc) continue;
      for (let i = 0; i < nLin; i++) if (ca[i] != null && cc[i] != null) { parCC[i] += cc[i]; parCA[i] += ca[i]; nPar[i]++; }
    }
    for (let i = 0; i < nLin; i++) {
      if (!nPar[i]) continue;
      const ms = Date.parse(d.instantes[i].replace(' ', 'T') + 'Z') + 3 * 3600e3;
      if (!meia.has(ms)) meia.set(ms, {});
      meia.get(ms)[a.ufv] = { cc: parCC[i] * f, ca: parCA[i] * f, n: nPar[i] };
    }

    // ---- energia do dia: integra os DOIS lados do mesmo jeito, sobre o mesmo conjunto ---------
    const medidos = [];
    for (let i = 0; i < nLin; i++) if (nPar[i]) medidos.push(i);
    const e_cc = soma(medidos.map((i) => parCC[i] * f)) * 0.5;      // MWh
    const e_ca = soma(medidos.map((i) => parCA[i] * f)) * 0.5;
    // a cobertura DENTRO do dia, para a tela poder dizer "18 de 23 pela manha": fracao dos inversores
    // do arquivo com o par medido, nos instantes da JANELA DO CONTRATO (irradiancia > 100 W/m2).
    // ⚠️ Medido antes de escolher a janela: com "CA > 0" o amanhecer entrava — meia frota reporta um
    //    lado so as 05:30 — e o campo saia 99,9 % com minimo de 157 em dias normais do M8. Ruido de
    //    aurora nao e falta de coleta; a janela do contrato ja separa os dois, e tem fonte.
    const JC = JAN_CONTRATO.get(a.dia + '|' + a.ufv);
    const comGer = JC ? medidos.filter((i) => JC.has(String(d.instantes[i]).slice(11, 16))) : [];
    const cob_inst_pct = comGer.length ? (soma(comGer.map((i) => nPar[i])) / (comGer.length * totalInv)) * 100 : null;
    const n_inv_min = comGer.length ? Math.min(...comGer.map((i) => nPar[i])) : null;
    // o contador do lado CA, para a comparacao com o medidor (energia absoluta)
    let e_conta = 0, comConta = 0;
    for (const o of d.inv.values()) {
      const v = (o.serie.e_conta || []).filter((x) => x != null);
      if (v.length) { e_conta += Math.max(...v); comConta++; }
    }
    if (!diario.has(a.dia)) diario.set(a.dia, {});
    diario.get(a.dia)[a.ufv] = { e_cc, e_ca, e_conta: e_conta / 1000, n_inv: totalInv,
      n_conta: comConta, slots: medidos.length, slots_totais: nLin, cob_inst_pct, n_inv_min };

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
      // ⚠️ O INSTANTE passou a ser PARAMETRO. A reducao ao dia continua sendo no pico — e o
      //    comentario acima diz por que —, mas a mesma conta serve a curva do dia, e duas escritas
      //    da mesma dispersao divergiriam na primeira edicao.
      const disp = (pref, idx, piso) => {
        const v = Object.keys(o.serie).filter((k) => k.startsWith(pref))
          .map((k) => o.serie[k][idx]).filter((x) => x != null && x > 0);
        if (v.length < 3) return null;
        const ord = v.slice().sort((x, y) => x - y);
        const md = ord[ord.length >> 1];
        return md > (piso == null ? 0.2 : piso) ? { n: v.length, med: r2(md),
          min_pct: r2((ord[0] / md) * 100), max_pct: r2((ord[ord.length - 1] / md) * 100) } : null;
      };
      const dm = disp('mppt#', iPico), ds = disp('str#', iPico);
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
      const isoCru = (o.serie.isol || []).filter((x) => x != null);
      const isoSem = isoCru.filter(isoSemLeitura).length;
      const isoVal = isoCru.filter((x) => !isoSemLeitura(x));
      const sp = (o.serie.setpoint || []).filter((x) => x != null);
      const nom = (o.serie.nominal || []).filter((x) => x != null);
      porInv.set(a.dia + '|' + a.ufv + '|' + o.ts + '|' + o.inv, { dia: a.dia, ufv: a.ufv, ts: o.ts, inv: o.inv,
        e_cc: r4(eCC), e_ca: r4(eCA),
        ef: eCC > 0.001 ? r4(eCA / eCC) : null,
        // 🔴 INSTANTES FISICAMENTE IMPOSSIVEIS (CA > CC): as duas leituras sao instantaneas e NAO
        //    simultaneas, e num ceu que muda uma pega um momento e a outra outro. Um instante assim
        //    empurra o `ef` do dia para cima. Guarda-se o par CRU aqui; o piso de potencia e a fracao
        //    saem depois do fator de unidade (ver EF_IMP_PISO_KW). NAO se corta nada do `ef`: o ruido
        //    e simetrico, e tirar so a cauda de cima vicia o numero para baixo (medido 17/09/2026).
        _imp: eCC > 0.001 ? {
          scc: soma(bons.map((i) => cc[i])),
          pares: bons.filter((i) => ca[i] > cc[i]).map((i) => [cc[i], ca[i]]) } : null,
        p_ca_max: r2(Math.max(...bons.map((i) => ca[i] * f)) * 1000),   // kW
        temp_max: t.length ? r2(Math.max(...t)) : null,
        // 🔴 EM kW, como `p_ca_max` e `nominal` — ver SETPOINT_EM_W logo abaixo do bloco.
        setpoint_min: sp.length ? r2(Math.min(...sp) / 1000) : null,
        setpoint_ger: spOrd.length >= 3 ? r2(spOrd[spOrd.length >> 1] / 1000) : null,
        nominal: nom.length ? r2(nom[nom.length - 1]) : null,
        // no pico do proprio inversor: quanto a MENOR corrente vale em relacao a mediana das suas
        // irmas. 100% e equilibrio perfeito; string desconectada leva isso perto de zero.
        mppt_min_pct: dm ? dm.min_pct : null, mppt_n: dm ? dm.n : null,
        str_min_pct: ds ? ds.min_pct : null, str_max_pct: ds ? ds.max_pct : null, str_n: ds ? ds.n : null,
        isol_min: isoVal.length ? r2(Math.min(...isoVal)) : null,
        // a contagem vai junto: dia sem leitura tem de PODER ser dito, e nao so ficar vazio
        ...(isoSem ? { isol_sem_leitura: isoSem } : {}),
        horas: (o.serie.horas || []).filter((x) => x != null).length
          ? r2(Math.max(...(o.serie.horas || []).filter((x) => x != null))) : null,
        // instantes de 30 min com potencia positiva DENTRO da janela do contrato (> 100 W/m2).
        // 🔴 Conta-se aqui, na passada que ja tem a curva: o blob por inversor guarda o dia
        //    reduzido, e depois de publicado nao ha como saber em QUE instantes ele gerou.
        ...(function () {
          const J = JAN_CONTRATO.get(a.dia + '|' + a.ufv);
          if (!J) return {};
          let ger = 0, lid = 0;
          for (let i = 0; i < nLin; i++) {
            if (!J.has(String(d.instantes[i]).slice(11, 16))) continue;
            // `lidos`: instantes da janela em que o inversor TEM leitura. Sem ele, um inversor que entra
            // na coleta no meio do dia (M9/TS1 INV04/05/06/08/10 em 18/09/2026, a partir das 14:00)
            // conta a manha SEM TELEMETRIA como PARADA — e o contador de operacao dele marcava o dia
            // inteiro. "Sem leitura" e "parado" sao coisas distintas; a lib divide so pelo lido.
            if (ca[i] != null) lid++;
            if (ca[i] != null && ca[i] > 0) ger++;
          }
          return { gerando: ger, lidos: lid, jan_slots: J.size };
        })(),
        n: bons.length });

      // ---- e a MESMA passada guarda a curva, em vez de descartar -----------------------------
      // ⚠️ `f` ainda e 1 aqui: a potencia vai CRUA e e escalada depois, junto com todo o resto,
      //    porque a unidade so pode ser decidida quando todas as usinas tiverem sido vistas.
      // ⚠️ `nom` e UM numero por inversor-dia, nao um array: a nominal e constante do equipamento.
      //    Sem ela o painel nao teria como transformar o setpoint em % — e a conta e a MESMA do
      //    dia (setpoint / nominal), o que faz as duas telas concordarem por construcao.
      const nomV = (o.serie.nominal || []).filter((x) => x != null);
      const cur = { d: a.dia, ts: o.ts, inv: o.inv, nom: nomV.length ? r2(nomV[nomV.length - 1]) : null,
        h: [], pcc: [], pca: [], ef: [], sn: [], sm: [], mm: [], t: [], iso: [], sp: [] };
      // so a janela com geracao: do PRIMEIRO ao ULTIMO instante gerando. A madrugada sao 0,0 repetidos
      // que nao dizem nada e pesam; os zeros do MEIO ficam, porque sao PARADA e nao madrugada.
      // 🔴 Cortar ponto a ponto transformava a parada num vao: o M3/TS2/INV20 em 18/09/2026 ficou em
      //    0 kW das 11:30 as 14:00 com o setpoint pedindo 63 kW e os vizinhos entregando, e a curva
      //    simplesmente nao tinha esses instantes — a tela escondia a parada que existe para mostrar.
      const gerI = bons.filter((i) => cc[i] > 1 || ca[i] > 1);
      const i0 = gerI.length ? gerI[0] : Infinity, i1 = gerI.length ? gerI[gerI.length - 1] : -Infinity;
      // 🔴 E o instante SEM LEITURA dentro da janela fica no eixo, com tudo nulo (24/09/2026). Percorrer so
      //    os `bons` apagava o instante: o carimbo sem registro (eletrocentro inteiro anulado, 21/09 14:00
      //    as 15:30 no M3/TS2) virava 14:00 vizinho de 15:30, e num eixo de CATEGORIA a falta sumia da tela.
      const bom = new Set(bons);
      for (let i = i0; i <= i1; i += 1) {
        if (!bom.has(i)) {
          cur.h.push(String(d.instantes[i]).slice(11, 16));
          for (const k of ['pcc', 'pca', 'ef', 'sn', 'sm', 'mm', 't', 'iso', 'sp']) cur[k].push(null);
          continue;
        }
        const dsi = disp('str#', i, PISO_STR_A);
        const dmi = disp('mppt#', i, PISO_STR_A);
        const ti = (o.serie.temp || [])[i], ii = (o.serie.isol || [])[i], si = (o.serie.setpoint || [])[i];
        cur.h.push(String(d.instantes[i]).slice(11, 16));
        cur.pcc.push(cc[i]); cur.pca.push(ca[i]);
        cur.ef.push(cc[i] > 0.001 ? r2((ca[i] / cc[i]) * 100) : null);
        // ⚠️ `sn` conta as strings COM CORRENTE, e por isso nao tem piso: zero strings ativas as
        //    06:00 e uma medicao, nao ruido. Quem tem piso e a RAZAO entre elas.
        cur.sn.push(Object.keys(o.serie).filter((k) => k.startsWith('str#'))
          .map((k) => o.serie[k][i]).filter((x) => x != null && x > 0.5).length);
        cur.sm.push(dsi ? dsi.min_pct : null);
        cur.mm.push(dmi ? dmi.min_pct : null);
        cur.t.push(ti == null ? null : r2(ti));
        // a MESMA regra do minimo do dia: sem isto a curva desenharia o mergulho a zero que o
        // diario acabou de deixar de publicar — duas telas discordando sobre o mesmo instante
        cur.iso.push(ii == null || isoSemLeitura(ii) ? null : r2(ii));
        cur.sp.push(si == null ? null : r2(si / 1000));
      }
      if (cur.h.length) {
        if (!horaPorUfv.has(a.ufv)) horaPorUfv.set(a.ufv, new Map());
        horaPorUfv.get(a.ufv).set(a.dia + '|' + o.ts + '|' + o.inv, cur);
      }
    }
    if (escolhidos.indexOf(a) % 40 === 0) {
      console.log('    ' + a.dia + ' ' + a.ufv + ': ' + totalInv + ' inversores · '
        + medidos.length + '/' + nLin + ' instantes medidos');
    }
  }

  if (!diario.size) throw new Error('nenhum dia aproveitado');
  const us = [...new Set(Object.keys(CAP_CA_MW))];

  // ---- a unidade, decidida UMA VEZ com todas as usinas a vista --------------------------------
  console.log('  carimbos sem registro (contador de vida descendo em metade ou mais do eletrocentro): '
    + (SEM_REGISTRO.length ? SEM_REGISTRO.map((s) => s.dia + ' ' + s.ufv + ' ' + s.h.join(',')).join(' | ') : 'nenhum'));
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
    // `ef_imp`: quanto do `ef` do dia vem de instantes com CA > CC, em fracao (como o `ef`) —
    // sum(CA - CC) nesses instantes / sum(CC) do dia. E GRANDEZA, nao limiar: o painel a mostra e
    // so marca o dia pelo criterio fisico (ef > 100%). `ef_imp_n` conta os instantes.
    if (o._imp) {
      const v = o._imp.pares.filter(([, a]) => a * F * 1000 >= EF_IMP_PISO_KW);   // o lado ALTO (CA), ver EF_IMP_PISO_KW
      o.ef_imp = o._imp.scc > 0 ? r4(soma(v.map(([c, a]) => a - c)) / o._imp.scc) : 0;
      o.ef_imp_n = v.length;
    }
    delete o._imp;
  }
  // a curva vai em kW, como o `p_ca_max` do dia — mesma grandeza, mesma unidade, e a conferencia
  // entre as duas so fecha se elas concordarem
  for (const m of horaPorUfv.values()) {
    for (const cur of m.values()) {
      cur.pcc = cur.pcc.map((x) => (x == null ? null : r2(x * F * 1000)));
      cur.pca = cur.pca.map((x) => (x == null ? null : r2(x * F * 1000)));
    }
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
  // 🔴 A UNIDADE DO SETPOINT E WATT — medida em 13/09/2026, e ela NAO era conhecida ate aqui.
  //    Este bloco dizia "nao estao na mesma unidade, e eu nao sei qual e a de cada uma", e a saida
  //    era comparar cada dia com o valor TIPICO do proprio inversor, que e adimensional. A razao
  //    continua valendo e continua sendo publicada; o que mudou e que agora o valor ABSOLUTO
  //    tambem pode ir para a tela, em kW, ao lado da nominal.
  //
  //    A PROVA E A SATURACAO, nao a aparencia do numero: quando o setpoint esta no teto (352 000),
  //    a potencia ativa maxima do inversor encosta em 352,0 kW e PARA — p99 de 352,5 e maximo de
  //    353,1 em 3.488 dias. E na faixa em que o limite fica ativo o dia inteiro (250 a 351 kW), a
  //    razao `p_ca_max / (setpoint/1000)` tem mediana 0,97 e fica abaixo de 1,05 em 88% dos dias.
  //    Nominal 320 kW, teto 352 kW = 110% dela, que e a sobrecarga configurada.
  //
  // ⚠️ DUAS LEITURAS MINHAS CAIRAM NO CAMINHO, e as duas por comparar coisas de janelas
  //    diferentes: `setpoint_ger` e a MEDIANA do dia e `p_ca_max` e o PICO do dia, entao num dia
  //    de restricao parcial o pico vem de fora da janela restrita e a razao estoura — 91% dos
  //    dias "violavam" o limite. E "todos os valores sao multiplos de 320" era falso: os DOZE
  //    MAIS COMUNS sao, e apenas 0,2% dos valores distintos.
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
    esquema: ESQUEMA,
    unidade: 'energia em MWh; potencia em MW; eficiencia adimensional (0..1); '
      + 'setpoint e potencia nominal do inversor em kW',
    unidade_setpoint: 'kW · referencia de potencia ativa enviada ao inversor. O teto e 352 kW, '
      + '110% da nominal de 320 kW, e o inversor satura nele: com o setpoint no teto a potencia '
      + 'maxima medida fica em 352,0 kW (p99 352,5). Ate 13/09/2026 este campo era publicado em W.',
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
      pela_janela_do_contrato: {
        metodo: 'a mesma grandeza pela regra do anexo de KPI do contrato de O&M: por inversor, instantes de '
          + '30 min com potência positiva DENTRO da janela de irradiância acima de 100 W/m² (medida na estação '
          + 'de cada usina), sobre os instantes da janela; a usina é a média SIMPLES dos inversores',
        campos: { disp_contrato_pct: 'por usina, %', janela_contrato_h: 'janela de irradiância do dia, em horas',
          disp_contrato_sem_leitura: 'por usina, instantes inversor×30 min da janela SEM leitura no supervisório (só quando > 0); '
            + 'não contam como parada — o denominador de cada inversor é o que foi lido',
          CX_disp_contrato_pct: 'o conjunto, média dos inversores de todas as usinas' },
        nao_e: 'o número contratual: faltam as HORAS EXCLUÍDAS previstas no contrato (falha na transmissão, '
          + 'pedido do contratante, força maior, falta de peça e outras), que não estão registradas em fonte '
          + 'que o pipeline leia. Sem elas a conta é conservadora: uma parada que o contrato excluiria entra '
          + 'aqui como indisponibilidade',
        resolucao: 'a amostra é instantânea a cada 30 min: parada mais curta que isso não aparece',
        comeca_em: 'o campo nasce em 17/09/2026; dia anterior a ele não tem como ser recomposto, porque o '
          + 'blob por inversor guarda o dia reduzido e não os instantes',
      },
      nao_e: 'a disponibilidade declarada ao operador nacional (disp_pct do executivo), que é capacidade '
        + 'declarada no nível do conjunto — as duas convivem e se conferem',
    },
  };

  // ---- disponibilidade por usina, do contador de operacao do inversor ----------------------------
  // A regra mora em lib-disponibilidade.js, com o ensaio dela; aqui so se alimenta e se emite.
  // 🔴 ALIMENTADA COM O ACUMULADO, nao so com o que esta rodada leu. O `perdas_inv` publicado
  //    guarda 60 dias de contador; os arquivos brutos, 30. Usar so os brutos deixava metade da
  //    janela do proprio blob sem disponibilidade, e para sempre — o dia que sai da fonte nunca
  //    mais volta. A rodada nova GANHA na colisao, como no acumulador.
  const chaveInv = (l) => l.dia + '|' + l.ufv + '|' + l.ts + '|' + l.inv;
  const paraDisp = new Map();
  for (const l of await leAnterior('perdas_inv.json')) paraDisp.set(chaveInv(l), l);
  for (const l of porInv.values()) paraDisp.set(chaveInv(l), l);
  const DISP = disponibilidade([...paraDisp.values()].map((o) => ({ dia: o.dia, ufv: o.ufv, ts: o.ts, inv: o.inv, horas: o.horas }))).porDia;
  { const semJanela = [...DISP.entries()].filter(([, r]) => r.janela_min == null);
    if (semJanela.length) console.log('  ⚠️ disponibilidade sem janela em ' + semJanela.length + ' dia(s): ' + semJanela.slice(0, 3).map(([d, r]) => d + ' (' + r.nota + ')').join(' · '));
    const jan = [...DISP.values()].map((r) => r.janela_min).filter((x) => x != null);
    if (jan.length) console.log('  disponibilidade: janela do dia ' + (Math.min(...jan) / 60).toFixed(2) + ' a ' + (Math.max(...jan) / 60).toFixed(2) + ' h em ' + jan.length + ' dias'); }

  // ---- e a MESMA materia-prima pela janela do CONTRATO (irradiancia > 100 W/m2), sem as exclusoes -
  const DISPC = dispContrato([...paraDisp.values()]
    .map((o) => ({ dia: o.dia, ufv: o.ufv, ts: o.ts, inv: o.inv, gerando: o.gerando, lidos: o.lidos })), JAN_CONTRATO);
  { const cx = [...DISPC.values()].map((r) => r.complexo && r.complexo.disp_pct).filter((x) => x != null).sort((a, b) => a - b);
    if (cx.length) console.log('  disponibilidade pela janela do contrato (sem exclusões): ' + cx.length
      + ' dias · ' + cx[0].toFixed(2) + ' a ' + cx[cx.length - 1].toFixed(2) + ' %, mediana ' + cx[cx.length >> 1].toFixed(2) + ' %');
    else console.log('  disponibilidade pela janela do contrato: nenhum dia com instantes contados (o campo nasce nesta rodada)'); }

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
      // so quando a cobertura variou dentro do dia: dia com todos os inversores em todo instante nao leva o campo
      if (x.cob_inst_pct != null && x.cob_inst_pct < 99.995) { o[ufv + '_cob_inst_pct'] = r2(x.cob_inst_pct); o[ufv + '_n_inv_min'] = x.n_inv_min; }
      { const R = DISP.get(dia); const dv = R && R.porUfv[ufv];
        if (dv) { o[ufv + '_disp_pct'] = dv.disp_pct; o[ufv + '_inv_parados'] = dv.parados;
          o[ufv + '_inv_parciais'] = dv.parciais; o[ufv + '_inv_contador_24h'] = dv.contador_24h; }
        if (R && R.janela_min != null && o.janela_h == null) { o.janela_h = r2(R.janela_min / 60);
          if (R.complexo) o.CX_disp_pct = R.complexo.disp_pct; } }
      { const C = DISPC.get(dia); const cv = C && C.porUfv[ufv];
        if (cv) { o[ufv + '_disp_contrato_pct'] = cv.disp_pct; o[ufv + '_janela_contrato_h'] = cv.janela_h;
          // a contagem vai junto, e SO quando ha o que contar: dia em que a coleta faltou tem de PODER ser dito
          if (cv.sem_leitura) o[ufv + '_disp_contrato_sem_leitura'] = cv.sem_leitura; }
        if (C && C.complexo && o.CX_disp_contrato_pct == null) { o.CX_disp_contrato_pct = C.complexo.disp_pct;
          o.janela_contrato_h = C.janela_h; } }
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
    // depois de acumular, e nao antes: os dias que faltam disponibilidade sao justamente os que
    // vieram do HISTORICO, e esses nao passam pelo montador de `serieDiaria`
    if (nome === 'perdas_diario.json') {
      const nd = completaDisponibilidade(sf, DISP, us, r2);
      if (nd) console.log('  disponibilidade preenchida em ' + nd + ' dia(s) que estavam no blob sem ela');
      // idem para a janela do contrato: os dias que vieram do historico so a recebem aqui, e SO se
      // o `perdas_inv` daquele dia ja tiver os instantes contados (dia anterior ao campo nao tem).
      let nc = 0;
      for (const o of sf) {
        const C = DISPC.get(o.dia); if (!C) continue;
        let mexeu = false;
        for (const ufv of us) {
          const cv = C.porUfv[ufv];
          if (cv && o[ufv + '_disp_contrato_pct'] == null) {
            o[ufv + '_disp_contrato_pct'] = cv.disp_pct; o[ufv + '_janela_contrato_h'] = cv.janela_h; mexeu = true;
            if (cv.sem_leitura) o[ufv + '_disp_contrato_sem_leitura'] = cv.sem_leitura;
          }
        }
        if (C.complexo && o.CX_disp_contrato_pct == null) { o.CX_disp_contrato_pct = C.complexo.disp_pct; o.janela_contrato_h = C.janela_h; mexeu = true; }
        if (mexeu) nc++;
      }
      if (nc) console.log('  disponibilidade pela janela do contrato preenchida em ' + nc + ' dia(s) do histórico');
    }
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
  // ---- a curva do dia, UM ARQUIVO POR USINA ----------------------------------------------------
  // 🔴 POR USINA, e a razao e de PESO. Medido com o dia real: 52 KB gzipados por usina por dia, o
  //    que da ~367 KB em sete dias. As nove juntas dariam 5,2 MB num arquivo so, e o Infinity baixa
  //    a URL INTEIRA antes de aplicar a consulta — quem decide o peso da pagina e o recorte do
  //    arquivo, nunca o filtro. A pagina ja tem o seletor de usina que escolhe qual baixar; e o
  //    mesmo recorte por familia que a Solarimetria pagou.
  // ⚠️ CUSTO DECLARADO: sao sete dias. A fonte retem 30, entao o historico intradiario so cresce a
  //    partir de hoje, acumulando — a mesma licao do `perdas_inv`. Janela maior e uma linha aqui,
  //    mas a pagina ja baixa 2,2 MB de `perdas_inv`, e dobrar isso se paga em toda abertura.
  for (const ufv of us) {
    const m = horaPorUfv.get(ufv);
    if (!m) { console.log('  pvstr_hora_' + ufv + ': sem curva nesta rodada'); continue; }
    const nome = 'pvstr_hora_' + ufv + '.json';
    const { serie: sf, novas, mantidas } = acumula(await leAnterior(nome), [...m.values()],
      (l) => l.d + '|' + l.ts + '|' + l.inv, DIAS_HORA, (l) => l.d);
    const cob = new Set(sf.map((l) => l.d)).size;
    saidas.push(nome + ': ' + sf.length + ' inversor-dias (' + novas + ' novos, ' + mantidas
      + ' do historico) · ' + cob + ' dias cobertos de ' + DIAS_HORA + ' · '
      + Math.round(await grava(nome, {
        gerado_em: meta.gerado_em, usina: ufv, esquema: ESQUEMA,
        janela_dias: DIAS_HORA, dias_cobertos: cob,
        passo: '30 min · amostra INSTANTANEA, nao media de intervalo',
        unidade: 'pcc e pca em kW; ef em %; sm e mm em % da mediana das irmas; t em C; '
          + 'iso em MOhm; sp em kW; sn e a contagem de strings com corrente',
        piso_dispersao_a: PISO_STR_A,
        nota_piso: 'a razao entre strings (sm) e entre MPPT (mm) so existe quando a mediana das '
          + 'correntes passa de ' + PISO_STR_A + ' A. Abaixo disso a razao e ruido de amanhecer e '
          + 'de anoitecer, e sai nula em vez de sair errada.',
        serie: sf }) / 1024) + ' KB');
  }

  for (const s of saidas) console.log('  ' + s);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
