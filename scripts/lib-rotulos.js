// RÓTULO QUE VEM DO DADO · o texto que o painel exibe mas que nasce aqui, no gerador.
//
// 🔴 POR QUE ISTO EXISTE. A suíte tem páginas em PT, EN e 中文, e o construtor de tradução alcança
//    tudo o que está no JSON do dashboard — título, description, nome de coluna. O que ele NÃO
//    alcança é o rótulo que chega pelo BLOB: a barra de selos, a banda de KPI, os cartões do
//    Monitor. Medido em 02/09/2026: 19 painéis em 14 das 19 páginas traduzidas leem rótulo do
//    dado, e por isso a página em inglês mostrava `OUTORGA · GERADO · FRUSTRADO` no topo.
//
// A saída é o gerador publicar o rótulo NAS TRÊS LÍNGUAS, lado a lado (`l`, `l_en`, `l_zh`), e o
// painel de cada idioma escolher a coluna. O `l` original NUNCA muda — nada que já lê o blob
// quebra, e a mudança é puramente aditiva.
//
// ⚠️ AQUI A FALHA É ABERTA, DE PROPÓSITO, e é a única vez que esta casa escolhe isso: um rótulo
//    sem tradução cai no português e o gerador ACUSA no log, em vez de abortar. Abortar aqui
//    pararia a publicação do DADO por causa de uma palavra — e o dado é o que a página existe
//    para mostrar. Quem falha fechado é o construtor de tradução, do outro lado: ele confere o
//    blob antes de publicar a página e recusa se o campo localizado não existir.
'use strict';

// ⚠️ UNIDADE é a mesma nas três línguas, e precisa estar aqui: sem isto o relatório acusaria
//    `MW`, `%` e `min` a cada execução, e alarme que acende sempre ensina a ignorar a ferramenta.
const IDENT = ['MW', 'GWh', 'MWh', 'kWh', 'kW', 'kV', 'MVA', 'MVAr', '%', 'h', 'min', 'W/m²',
  '°C', 'm/s', 'mm', 'V', 'A', 'pp', 'Way2', 'ONS', 'SCADA', 'MUST'];

const DIC = {
  // --- barra de selos (way2_saude.json) · 13 páginas -----------------------
  'Way2': { en: 'Way2', zh: 'Way2' },
  'Medidores': { en: 'Meters', zh: '电表' },
  '230 kV parcial': { en: '230 kV partial', zh: '230 kV 部分' },
  '230 kV fora': { en: '230 kV down', zh: '230 kV 失电' },

  // --- banda de KPI do ONS (ons_kpis.json) · Curtailment -------------------
  'Outorga': { en: 'Granted', zh: '核准容量' },
  'Gerado': { en: 'Generated', zh: '已发电' },
  'Frustrado': { en: 'Curtailed', zh: '限电损失' },
  'Restrições': { en: 'Restrictions', zh: '限电次数' },
  'Duração': { en: 'Duration', zh: '持续时间' },
  'eventos': { en: 'events', zh: '次' },
  'Razão Energética (ENE)': { en: 'Energy Reason (ENE)', zh: '能量原因（ENE）' },
  'Confiabilidade Elétrica (CNF)': { en: 'Electrical Reliability (CNF)', zh: '电气可靠性（CNF）' },
  'Restrição Elétrica (REL)': { en: 'Electrical Restriction (REL)', zh: '电气受限（REL）' },
  'Pré-COD · comissionamento': { en: 'Pre-COD · commissioning', zh: '商运前 · 调试' },
  'Capacidade outorgada do complexo': { en: 'Granted capacity of the complex', zh: '电站群核准容量' },
  'Energia verificada ONS no período': { en: 'ONS verified energy in the period', zh: '期间内 ONS 实际电量' },
  'Energia perdida por restrição ONS': { en: 'Energy lost to ONS restriction', zh: '因 ONS 限电损失的电量' },
  'Intervalos de 30 min com limite ativo': { en: '30-minute intervals with an active limit', zh: '存在有效限值的 30 分钟时段' },
  'Horas totais sob restrição': { en: 'Total hours under restriction', zh: '限电小时数合计' },

  // --- razões do pré-COD (executivo.json · pre_cod_razoes.tiles) -----------
  'Razão energética': { en: 'Energy reason', zh: '能量原因' },
  'Confiabilidade elétrica': { en: 'Electrical reliability', zh: '电气可靠性' },
  'Indisponibilidade externa': { en: 'External unavailability', zh: '外部不可用' },
  'Sem motivo registrado': { en: 'No reason recorded', zh: '无记录原因' },
  'Compensável': { en: 'Compensable', zh: '可补偿' },
  'Não compensável': { en: 'Not compensable', zh: '不可补偿' },
  'A classificar': { en: 'To be classified', zh: '待分类' },

  // --- cartões do dia (kpis_dia.json) · Monitor ----------------------------
  'Energia hoje': { en: 'Energy today', zh: '今日电量' },
  'Fator de capacidade': { en: 'Capacity factor', zh: '容量系数' },
  'Pico de potência': { en: 'Peak power', zh: '功率峰值' },
  'Potência média': { en: 'Average power', zh: '平均功率' },

  // --- clima (clima.json) · Monitor ----------------------------------------
  'Irradiância': { en: 'Irradiance', zh: '辐照度' },
  'Temperatura': { en: 'Temperature', zh: '温度' },
  'Nuvens': { en: 'Clouds', zh: '云量' },
  'Umidade': { en: 'Humidity', zh: '湿度' },
  'Vento': { en: 'Wind', zh: '风速' },
  'Condição': { en: 'Condition', zh: '天气' },
  // domínio FECHADO: os doze retornos do mapa de código de tempo
  'Céu limpo': { en: 'Clear sky', zh: '晴' },
  'Noite limpa': { en: 'Clear night', zh: '晴夜' },
  'Predom. limpo': { en: 'Mostly clear', zh: '大致晴朗' },
  'Parc. nublado': { en: 'Partly cloudy', zh: '局部多云' },
  'Nuvens à noite': { en: 'Clouds at night', zh: '夜间多云' },
  'Nublado': { en: 'Cloudy', zh: '阴' },
  'Névoa': { en: 'Fog', zh: '雾' },
  'Garoa': { en: 'Drizzle', zh: '毛毛雨' },
  'Chuva': { en: 'Rain', zh: '雨' },
  'Neve': { en: 'Snow', zh: '雪' },
  'Pancadas de chuva': { en: 'Rain showers', zh: '阵雨' },
  'Tempestade': { en: 'Thunderstorm', zh: '雷暴' },
  'Indefinido': { en: 'Undefined', zh: '未知' },
};

// ⚠️ Prefixo variável + cauda fixa: `Sensação 32°` só tem tradução na cauda. A lista guarda a
//    forma, não o valor, senão a cada grau novo faltaria uma entrada.
const FORMAS = [
  { re: /^Sensação (.+)$/, en: (m) => 'Feels like ' + m[1], zh: (m) => '体感 ' + m[1] },
  // nome do medidor: `SE · TR1` tem a sigla da subestação em português; `M1 · C1` é código
  { re: /^SE · (TR\d)$/, en: (m) => 'Substation · ' + m[1], zh: (m) => '升压站 · ' + m[1] },
  { re: /^(M\d · C\d)$/, en: (m) => m[1], zh: (m) => m[1] },
  // grupo de tensão: a vírgula decimal é convenção pt-BR
  { re: /^34,5 kV$/, en: () => '34.5 kV', zh: () => '34.5 kV' },
  { re: /^230 kV$/, en: () => '230 kV', zh: () => '230 kV' },
  // rótulo de MÊS (`set/25`) — é o eixo de todo gráfico mês a mês. Vai por FORMA, não por
  // tabela: uma tabela de meses precisaria de linha nova a cada ano.
  { re: /^(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\/(\d{2})$/,
    en: (m) => ({ jan: 'Jan', fev: 'Feb', mar: 'Mar', abr: 'Apr', mai: 'May', jun: 'Jun',
      jul: 'Jul', ago: 'Aug', set: 'Sep', out: 'Oct', nov: 'Nov', dez: 'Dec' }[m[1]] + '/' + m[2]),
    zh: (m) => (({ jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9,
      out: 10, nov: 11, dez: 12 }[m[1]]) + '月/' + m[2]) },
];


IDENT.forEach((u) => { if (!DIC[u]) DIC[u] = { en: u, zh: u }; });

const FALTA = new Map();

function loc(txt, lang) {
  if (typeof txt !== 'string' || !txt) return txt;
  const e = DIC[txt];
  if (e && e[lang]) return e[lang];
  for (const f of FORMAS) { const m = txt.match(f.re); if (m) return f[lang](m); }
  FALTA.set(txt, (FALTA.get(txt) || 0) + 1);
  return txt;                       // cai no português, e acusa no relatório
}

// Acrescenta <campo>_en e <campo>_zh ao objeto, sem tocar no campo original.
function localiza(obj, campos) {
  if (!obj) return obj;
  campos.forEach((c) => {
    if (typeof obj[c] !== 'string' || !obj[c]) return;
    obj[c + '_en'] = loc(obj[c], 'en');
    obj[c + '_zh'] = loc(obj[c], 'zh');
  });
  return obj;
}

// Para texto montado como `<número> GWh — <cauda fixa>`: traduz só a cauda.
function localizaCauda(obj, campo, sep) {
  const v = obj && obj[campo];
  if (typeof v !== 'string' || v.indexOf(sep) < 0) return obj;
  const i = v.indexOf(sep);
  const cabeca = v.slice(0, i + sep.length), cauda = v.slice(i + sep.length);
  obj[campo + '_en'] = cabeca + loc(cauda, 'en');
  obj[campo + '_zh'] = cabeca + loc(cauda, 'zh');
  return obj;
}

function relatorio(quem) {
  if (!FALTA.size) { console.log('  rótulos localizados · nenhum sem tradução' + (quem ? ' (' + quem + ')' : '')); return 0; }
  console.log('  🔴 ' + FALTA.size + ' rótulo(s) SEM tradução' + (quem ? ' em ' + quem : '')
    + ' — saíram em português nas páginas EN/中文:');
  [...FALTA.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    .forEach(([t, n]) => console.log('       ' + n + '× ' + JSON.stringify(t.slice(0, 70))));
  return FALTA.size;
}

// 🔴 VARREDURA PROFUNDA, para o rótulo que é emitido em muitos lugares do mesmo gerador.
//    Caçar cada ponto de emissão à mão é como manter uma lista escrita à mão: a primeira
//    emissão nova fica de fora e ninguém percebe. A varredura roda uma vez, antes do upload,
//    e alcança todos.
//
// ⚠️ Ela só toca o campo quando o valor tem TRADUÇÃO CONHECIDA — sem isso, um campo de texto
//    livre ganharia `_en` idêntico ao português e o blob cresceria à toa.
function localizaTudo(raiz, campos) {
  let n = 0;
  (function anda(o) {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(anda); return; }
    campos.forEach((c) => {
      const v = o[c];
      if (typeof v !== 'string' || !v || o[c + '_en'] !== undefined) return;
      const en = loc(v, 'en'), zh = loc(v, 'zh');
      if (en === v && zh === v) return;      // sem tradução conhecida: não engorda o blob
      o[c + '_en'] = en; o[c + '_zh'] = zh; n += 1;
    });
    Object.values(o).forEach(anda);
  })(raiz);
  return n;
}

module.exports = { loc, localiza, localizaCauda, localizaTudo, relatorio, DIC };
