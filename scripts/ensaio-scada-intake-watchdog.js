// ensaio-scada-intake-watchdog.js — o vigia da intake REPROVA quando deve?
//
// 🔴 POR QUE ELE EXISTE
// Um vigia visto so no caminho feliz nao esta testado. Foi assim que o painel de saude passou
// seis horas dizendo "24/24 medidores" durante uma queda, e foi assim que o fallback do chip
// ficou inerte por semanas — as duas vezes, o codigo que deveria acusar nunca tinha sido posto
// na situacao que ele existe para acusar.
//
// O que se exercita aqui e o JULGAMENTO, contra idades fabricadas. A leitura do Azure fica de
// fora de proposito: ela precisa de segredo, e nao e ela que decide nada.
//
// ⚠️ Ele ja pegou dois defeitos reais deste vigia: a chave do perfil comida por camada de
//    escape (`'/\.xlsx$/i'` virando `/.xlsx$/i`), e o `process.exit(1)` que matava o proprio
//    ensaio antes de o caso ser julgado.
//
// Uso:  node scripts/ensaio-scada-intake-watchdog.js
'use strict';
const Module = require('module');

const H = 3600000;
let ULTIMO = null;

// o dublê do canal de alerta: o ensaio julga o QUE seria enviado, sem enviar nada
const orig = Module.prototype.require;
Module.prototype.require = function (nome) {
  if (nome === './lib-alerta') {
    return { alerta: async (a) => { ULTIMO = a; return { webhook: '-', issue: '-' }; } };
  }
  return orig.apply(this, arguments);
};

const V = require('./gen-scada-intake-watchdog.js');

const ARQ = {
  'M<parque>.xlsx (SCADA por usina)': '79754_M9.xlsx',
  'IRR_GERAL (estacao)': '79758_IRR_GERAL_20260901_040145.csv',
  'IRR (sensor GER_IRR)': '79757_IRR_20260901_030012.csv',
  'Trafo (SE)': '79767_Trafo_20260901_040039.csv',
  'M<NN> csv (inversores/perdas)': '79769_M10_20260901_040032.csv',
};
const JULGADAS = V.FAMILIAS.filter((f) => f.vigia).map((f) => f.nome);

// monta o mapa que `vigiar` recebe: familia -> lista de blobs, ja ordenada
function mapa(idades) {
  const m = new Map(V.FAMILIAS.map((f) => [f.nome, []]));
  for (const [fam, h] of Object.entries(idades)) {
    if (h === null) continue;
    m.get(fam).push({ nome: ARQ[fam], ms: Date.now() - h * H });
  }
  return m;
}

function todasEm(h) {
  return Object.fromEntries(JULGADAS.map((f) => [f, h]));
}

let falhas = 0;

async function caso(rot, idades, espera) {
  ULTIMO = null;
  const a = console.log;
  console.log = () => {};
  let erro = null;
  try { await V.vigiar(mapa(idades)); } catch (e) { erro = e; }
  console.log = a;

  const teve = erro ? 'ERRO' : !ULTIMO ? 'nada' : ULTIMO.resolve ? 'resolve'
    : /\[CRITICO\]/.test(ULTIMO.assunto) ? 'CRITICO'
      : /\[ALERTA\]/.test(ULTIMO.assunto) ? 'ALERTA' : '?';
  const ok = teve === espera;
  if (!ok) falhas++;
  console.log((ok ? '  ok     ' : '  FALHOU ') + rot.padEnd(50)
    + 'esperado ' + espera.padEnd(9) + 'obtido ' + teve
    + (erro && espera !== 'ERRO' ? '  (' + erro.message.slice(0, 54) + ')' : ''));
  return ULTIMO;
}

(async () => {
  console.log('limiar em uso: alerta ' + V.ALERTA_H + ' h · critico ' + V.CRITICO_H
    + ' h  (medido em 02/09/2026)\n');

  // 🔴 O CASO NORMAL NAO PODE ALARMAR. Limiar que reprova o caso normal ja aconteceu tres
  //    vezes nesta casa — e a primeira coisa que este ensaio existe para impedir.
  await caso('12 h (cadencia folgada)', todasEm(12), 'resolve');
  await caso('23,6 h — a MEDIANA medida', todasEm(23.6), 'resolve');
  await caso('28,9 h — o p75 medido', todasEm(28.9), 'resolve');
  await caso('49 h — um cabelo abaixo do limiar', todasEm(49), 'resolve');
  await caso('35,8 h — o estado REAL medido em 02/09', todasEm(35.8), 'resolve');

  // e o caso que ele existe para pegar TEM de alarmar
  await caso('51 h — um dia de deposito perdido', todasEm(51), 'ALERTA');
  await caso('75 h — dois dias', todasEm(75), 'CRITICO');
  await caso('219,8 h — o pior vao ja medido', todasEm(219.8), 'CRITICO');

  // 🔴 container vazio NAO e "em dia": tratar como tal seria o defeito silencioso dentro do
  //    proprio vigia.
  await caso('container VAZIO', Object.fromEntries(
    JULGADAS.map((f) => [f, null])), 'ERRO');

  // ⚠️ familia muito atras do PROPRIO deposito nao dispara sozinha — nem todo lote traz todas —
  //    mas tem de aparecer no corpo quando ha alerta.
  const soUma = todasEm(10);
  soUma['IRR_GERAL (estacao)'] = 400;
  await caso('lote fresco com UMA familia 400 h atras', soUma, 'resolve');

  const atrasado = todasEm(80);
  atrasado['IRR_GERAL (estacao)'] = 400;
  const u = await caso('lote de 80 h com UMA familia 400 h atras', atrasado, 'CRITICO');
  const cita = u && /ficaram para tras/.test(u.corpo);
  console.log((cita ? '  ok     ' : '  FALHOU ')
    + 'e o corpo NOMEIA a familia atrasada'.padEnd(50)
    + 'esperado sim      obtido ' + (cita ? 'sim' : 'nao'));
  if (!cita) falhas++;

  // ── cada container carrega com o SEU limiar, e o desconhecido e recusado ────────────────────
  // 🔴 O que se julga aqui nao e so carregar ou nao: e recusar pelo MOTIVO certo. Um container
  //    desconhecido tem duas razoes possiveis para cair — nao ter consumidor e nao ter limiar —
  //    e elas pedem acoes diferentes de quem le a mensagem.
  // ⚠️ Em `MODO=medir` a checagem de limiar e PULADA de proposito: e ela que produz o numero, e
  //    exigi-lo antes tornaria o caminho documentado impossivel de percorrer. O caso abaixo
  //    prova isso pelo motivo da recusa — em medir ela nao pode ser "limiar NAO MEDIDO".
  for (const [cont, modo, deveCarregar, motivo] of [
    ['scada-raw', 'vigiar', true, null],
    ['inversores-raw', 'vigiar', true, null],   // medido em 02/09/2026: 170/336 h
    ['container-que-ninguem-mediu', 'vigiar', false, /limiar NAO MEDIDO/],
    ['container-que-ninguem-mediu', 'medir', false, /nenhum consumidor declarado/],
  ]) {
    const antes = process.env.RAW_CONTAINER, antesModo = process.env.MODO;
    process.env.RAW_CONTAINER = cont;
    process.env.MODO = modo;
    delete require.cache[require.resolve('./gen-scada-intake-watchdog.js')];
    let carregou = true, msg = '';
    try { require('./gen-scada-intake-watchdog.js'); }
    catch (e) { carregou = false; msg = e.message; }
    if (antes === undefined) delete process.env.RAW_CONTAINER;
    else process.env.RAW_CONTAINER = antes;
    if (antesModo === undefined) delete process.env.MODO;
    else process.env.MODO = antesModo;
    delete require.cache[require.resolve('./gen-scada-intake-watchdog.js')];

    const bom = carregou === deveCarregar && (carregou || motivo.test(msg));
    console.log((bom ? '  ok     ' : '  FALHOU ') + (cont + ' MODO=' + modo).padEnd(46)
      + (deveCarregar ? 'carrega' : 'RECUSA por ' + String(motivo).slice(1, -1)).padEnd(34)
      + (carregou ? 'carrega' : 'RECUSA: ' + msg.slice(0, 34)));
    if (!bom) falhas++;
  }

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os casos passaram'));
  process.exit(falhas ? 1 : 0);
})();
