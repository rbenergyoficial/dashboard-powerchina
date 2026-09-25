'use strict';
/*
 * lib-inversor-cru.js — os inversores que o export traz em REGISTRO CRU, e o mapa de cada codigo para a
 * grandeza nomeada que os geradores ja leem (25/09/2026, PROMOVER m9-cru).
 *
 * O M9 TS1 INV13..INV22 nao tem as colunas nomeadas ("UFV_MRT09_TS1_INV13_MRT09 TS1 INV13 POTENCIA ATIVA
 * TOTAL"): a medicao vem com o codigo do equipamento,
 *
 *     UFV_MRT09_TS1_INV13_UFV_MRT09_Comunicacao_TS1.EMU200A_INV.INV13.[MRT09-C01-WAA01GW013XQ50]
 *
 * e ate aqui era lida como "so comunicacao, sem medicao". Nao era: os dez geram ate o teto de 352 kW em
 * todos os arquivos conferidos (15, 22, 23 e 24/09). Sem este mapa o parque publicava 23 de 33 no M9.
 *
 * 🔴 CADA CODIGO ENTROU COM PROVA, e a prova e uma IDENTIDADE FISICA no mesmo inversor sempre que existe uma
 *    (medido nos dez, em 24/09 e repetido em 15/09):
 *    - Q42 contador diario e Q33 contador de vida: o de vida sobe no dia EXATAMENTE o maximo do diario;
 *    - Q50 potencia ativa (kW): integrada em 30 min da 97–111 % do contador diario (o erro conhecido da
 *      amostra instantanea); Q54 potencia CC (kW): Q50/Q54 entre 0,97 e 0,99;
 *    - Q13 aparente = hypot(Q50, Q51 reativa), erro de 1 a 7 kVA; Q52 fator de potencia = Q50/Q13, erro
 *      mediano 0,004;
 *    - J13..J32, J45, J46 sao as 22 strings e J33..J44 as correntes de MPPT: soma das strings / soma dos MPPT
 *      mediana 0,98–1,00; e J01..J12 sao as tensoes de MPPT: soma(V x I) / Q54 mediana 0,99–1,00;
 *    - sem identidade propria, contra os 12 vizinhos NOMEADOS do mesmo eletrocentro (mesmo sol, mesmo
 *      despacho), dentro da faixa deles em 87–96 % dos instantes e diferenca mediana zero: Q53 temperatura,
 *      Q49 isolacao, Q19 frequencia, Q40 tempo de operacao diaria, Q67 tensao negativa a terra;
 *    - J81 setpoint (W) e N60 nominal (kW): IGUAIS aos dos vizinhos (351.360 W; 320 kW).
 * ⚠️ J81 NAO e a potencia ativa. Foi a primeira leitura, e ela estava errada: acompanha os vizinhos porque o
 *    despacho e o mesmo. Quem separou foi o valor lado a lado com as colunas nomeadas.
 * ⚠️ A ORDEM das strings e dos MPPT nao esta provada (o pareamento "MPPT k = strings 2k-1 e 2k" errou ate 13
 *    A). Os geradores so usam o CONJUNTO (dispersao entre elas), entao a ordem nao entra em conta nenhuma.
 * Codigo que nao esta aqui nao e lido: um codigo sem prova seria uma grandeza inventada.
 */

// o nome da coluna repete usina, eletrocentro e inversor; o codigo e o que vem depois do ultimo "X"
const RE_CRU = /^UFV_(\w+?)_(TS\d+)_(INV\d+)_UFV_\1_Comunicacao_\2\.EMU200A_INV\.\3\.\[[^\]]*X([A-Z]\d+)\]$/;

const CODIGO = {
  Q54: 'POTÊNCIA DC TOTAL',
  Q50: 'POTÊNCIA ATIVA TOTAL',
  Q13: 'POTÊNCIA APARENTE TOTAL',
  Q51: 'POTÊNCIA REATIVA TOTAL',
  Q42: 'ENERGIA DIÁRIA GERADA',
  Q33: 'ENERGIA TOTAL GERADA',
  Q52: 'FATOR DE POTÊNCIA TOTAL',
  J81: 'SETPOINT POTÊNCIA ATIVA',
  N60: 'POTÊNCIA ATIVA NOMINAL',
  Q53: 'TEMPERATURA INTERNA',
  Q49: 'RESISTÊNCIA DE ISOLAÇÃO',
  Q19: 'FREQUÊNCIA DA REDE',
  Q40: 'TEMPO DE OPERAÇÃO DIÁRIA',
  Q67: 'TENSÃO NEGATIVA À TERRA',
};
const dois = (n) => String(n).padStart(2, '0');
for (let k = 1; k <= 12; k++) {
  CODIGO['J' + dois(k)] = 'TENSÃO MPPT ' + dois(k);
  CODIGO['J' + dois(32 + k)] = 'CORRENTE MPPT ' + dois(k);
}
['J13', 'J14', 'J15', 'J16', 'J17', 'J18', 'J19', 'J20', 'J21', 'J22', 'J23', 'J24', 'J25', 'J26', 'J27', 'J28',
  'J29', 'J30', 'J31', 'J32', 'J45', 'J46'].forEach((c, i) => { CODIGO[c] = 'CORRENTE STRING ' + dois(i + 1); });

// Devolve {ts, inv, grandeza} com a grandeza no MESMO nome da coluna nomeada, ou null.
function casaCru(nome) {
  const m = String(nome).match(RE_CRU);
  if (!m) return null;
  const g = CODIGO[m[4]];
  return g ? { ts: m[2], inv: m[3], grandeza: g, codigo: m[4] } : null;
}

module.exports = { casaCru, CODIGO, RE_CRU };
