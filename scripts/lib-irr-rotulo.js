/*
 * lib-irr-rotulo.js — o NOME da grandeza da solarimetria nas três línguas do painel (PROMOVER irr-rotulo).
 *
 * POR QUE EXISTE. A tabela "Qualidade dos sensores" lê `qualidade[].grandeza` do irr_ufv.json, e esse texto é o nome da
 * coluna do export do SCADA ("TENSÃO DA BATERIA", "UMIDADE RELATIVA DO AR"…). Ele vem do DADO: o dicionário de tradução
 * dos painéis não o alcança, e a página em inglês mostrava as 22 grandezas em português (varredura da tela, 11/10/2026).
 * A regra da casa para rótulo que vem do dado: o GERADOR publica a irmã de cada língua (`<campo>_pt` / `_en` / `_zh`) e o
 * painel lê o `_pt`, que a tradução troca pela irmã só quando TODA linha a tem.
 *
 * FALHA FECHADA. Grandeza sem rótulo nas três línguas aborta o gerador ANTES de gravar qualquer arquivo: um nome novo no
 * export não pode aparecer calado em português na página em inglês.
 *
 * O VOCABULÁRIO é o que o dicionário dos painéis já usa nos títulos e legendas da própria Solarimetria (11/10/2026):
 * "PLANE-OF-ARRAY IRRADIANCE"/组件平面辐照度, "STATION BATTERY VOLTAGE"/电池电压, "RELATIVE HUMIDITY"/空气相对湿度,
 * "Dew point"/露点, "Soiling loss"/积灰损失, "Incident (from above)"/入射（朝上）… "Direção do vento" não tinha entrada e
 * leva o termo padrão (WIND DIRECTION / 风向). O PT é o próprio nome do export, sem mudança: a página PT fica igual.
 */
const ROTULO = {
  'IRRADIAÇÃO INCLINADA': { en: 'PLANE-OF-ARRAY IRRADIANCE', zh: '组件平面辐照度' },
  'IRRADIAÇÃO DIFUSA': { en: 'DIFFUSE IRRADIANCE', zh: '散射辐照度' },
  'IRRADIAÇÃO DIRETA': { en: 'DIRECT IRRADIANCE', zh: '直射辐照度' },
  'IRRADIAÇÃO ALBEDO DE CIMA': { en: 'ALBEDO IRRADIANCE · INCIDENT (FROM ABOVE)', zh: '反照率辐照度 · 入射（朝上）' },
  'IRRADIAÇÃO ALBEDO DE BAIXO': { en: 'ALBEDO IRRADIANCE · REFLECTED (FROM BELOW)', zh: '反照率辐照度 · 反射（朝下）' },
  'TAXA DE ALBEDO': { en: 'ALBEDO RATIO', zh: '反照率' },
  'TEMPERATURA MÓDULO 1': { en: 'MODULE TEMPERATURE 1', zh: '组件温度 1' },
  'TEMPERATURA MÓDULO 2': { en: 'MODULE TEMPERATURE 2', zh: '组件温度 2' },
  'TEMPERATURA MÓDULO 3': { en: 'MODULE TEMPERATURE 3', zh: '组件温度 3' },
  'TEMPERATURA MÓDULO 4': { en: 'MODULE TEMPERATURE 4', zh: '组件温度 4' },
  'TEMPERATURA AMBIENTE': { en: 'AMBIENT TEMPERATURE', zh: '环境温度' },
  'TEMPERATURA INTERNA': { en: 'INTERNAL TEMPERATURE', zh: '机箱内部温度' },
  'UMIDADE RELATIVA DO AR': { en: 'RELATIVE HUMIDITY', zh: '空气相对湿度' },
  'PONTO DE CONDENSAÇÃO': { en: 'DEW POINT', zh: '露点' },
  'VELOCIDADE VENTO': { en: 'WIND SPEED', zh: '风速' },
  'DIREÇÃO VENTO': { en: 'WIND DIRECTION', zh: '风向' },
  'PRECIPITAÇÃO': { en: 'PRECIPITATION', zh: '降水' },
  'SENSOR DE SUJEIRA 1': { en: 'SOILING SENSOR 1', zh: '积灰传感器 1' },
  'SENSOR DE SUJEIRA 2': { en: 'SOILING SENSOR 2', zh: '积灰传感器 2' },
  'TAXA DE PERDA POR SUJEIRA 1': { en: 'SOILING LOSS RATIO 1', zh: '积灰损失率 1' },
  'TAXA DE PERDA POR SUJEIRA 2': { en: 'SOILING LOSS RATIO 2', zh: '积灰损失率 2' },
  'TENSÃO DA BATERIA': { en: 'BATTERY VOLTAGE', zh: '电池电压' },
};

// o rótulo de cada língua: texto não vazio; o inglês sem letra acentuada do português (pega a tradução esquecida que
// copiou o PT); o chinês com ao menos um ideograma
const PT_ACENTO = /[ÁÀÂÃÉÊÍÓÔÕÚÇáàâãéêíóôõúç]/;
const IDEOGRAMA = /[一-鿿]/;
function rotuloBom(r) {
  return !!r && typeof r.en === 'string' && r.en.trim() !== '' && !PT_ACENTO.test(r.en)
    && typeof r.zh === 'string' && IDEOGRAMA.test(r.zh);
}

// as grandezas que o gerador conhece (as chaves da FAIXA) e as que têm rótulo têm de ser o MESMO conjunto
function confereCobertura(grandezas) {
  const falta = grandezas.filter((g) => !rotuloBom(ROTULO[g]));
  const sobra = Object.keys(ROTULO).filter((g) => !grandezas.includes(g));
  return { falta, sobra };
}

/**
 * Acrescenta `grandeza_pt`, `grandeza_en` e `grandeza_zh` a cada linha da tabela de qualidade, AO LADO de `grandeza`
 * (campo novo ao lado do antigo). Aborta, sem mexer em nada, se alguma grandeza não tiver rótulo bom.
 * @param {Array<{grandeza:string}>} qualidade
 * @returns {number} linhas rotuladas
 */
function rotulaQualidade(qualidade) {
  const L = qualidade || [];
  const sem = [...new Set(L.map((q) => q.grandeza).filter((g) => !rotuloBom(ROTULO[g])))];
  if (sem.length) throw new Error('grandeza sem rótulo EN/中文 em lib-irr-rotulo.js: ' + sem.join(', '));
  L.forEach((q) => { q.grandeza_pt = q.grandeza; q.grandeza_en = ROTULO[q.grandeza].en; q.grandeza_zh = ROTULO[q.grandeza].zh; });
  return L.length;
}

module.exports = { ROTULO, rotuloBom, confereCobertura, rotulaQualidade };
