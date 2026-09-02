// portal_vivo.json — o blob LEVE que a tela "Ao vivo" do portal Aurora consome.
//
// 🔴 POR QUE ELE EXISTE
// Nenhum blob leve tinha a curva do dia. Medido em 01/09/2026, o que a pagina teria de baixar:
//
//     kpis_dia      < 1 KB   os 4 numeros, sem curva
//     way2_saude    122 KB   saude, com serie e timeline que o portal nao usa
//     way2_latest   180 KB   so os ultimos 12 slots — uma hora, nao o dia
//     way2_recent  7.644 KB  ← a UNICA fonte da curva do dia
//
// Os blobs ricos existem para o Grafana, que os le pelo servidor. Uma pagina que baixa 7,6 MB a
// cada abertura nao e "ao vivo", e lenta. Este arquivo carrega SO o que a tela desenha: ~15 KB.
//
// ⚠️ Ele DERIVA, nao mede. Todo numero aqui sai do mesmo `way2_eletrico.json` que o resto do
// ao-vivo usa — se divergir do painel do Grafana, o defeito e deste arquivo, nao do dado.

'use strict';
const fs = require('fs');
const path = require('path');

const COMPLEXO = 6233;             // o medidor do complexo — UMA medicao, nao a soma dos 22
const TRAFOS = [6196, 6197];       // os dois de 230 kV
const OUTORGA = 343.77;            // MW

// 🔴 O mapa circuito -> usina NAO e copiado: e LIDO do gen-executivo.js, que e o dono dele. Uma
// segunda copia envelheceria em ritmo proprio, e o erro seria invisivel — o total continuaria
// fechando e so a reparticao por usina sairia errada.
// ⚠️ Se a leitura falhar, o rendimento por usina simplesmente NAO e publicado. Melhor a tela
// dizer que nao tem do que publicar uma reparticao adivinhada.
function mapaCircuitos() {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'gen-executivo.js'), 'utf8');
    const m = src.match(/const CIRC = \{([\s\S]{0,400}?)\};/);
    if (!m) return null;
    const circ = {};
    for (const [, u, ids] of m[1].matchAll(/(M\d):\s*\[([\d,\s]+)\]/g)) {
      circ[u] = ids.split(',').map(x => parseInt(x.trim(), 10)).filter(Number.isFinite);
    }
    const n = Object.values(circ).reduce((s, v) => s + v.length, 0);
    return (Object.keys(circ).length === 9 && n === 22) ? circ : null;
  } catch { return null; }
}

// Capacidade contratada por usina, em MW. Usada so para normalizar o rendimento (MWh por MW),
// senao o M9 (9,82 MW) ficaria sempre por ultimo e a comparacao viraria ranking de tamanho.
const CAP = { M1: 49.11, M2: 24.555, M3: 49.11, M4: 49.11, M5: 49.11, M6: 49.11, M7: 14.733, M8: 49.11, M9: 9.822 };

const r = (v, c = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** c) / 10 ** c);

function serie(elet, ponto, grandeza = 'Demat') {
  const s = (elet.dados || []).find(x => x.pontoId === ponto && x.nomeGrandeza === grandeza);
  const m = new Map();
  for (const v of (s && s.valores) || []) if (v && v.valor != null) m.set(v.data.slice(11, 16), v.valor / 1000);
  return m;
}

function monta(elet, saude) {
  const dia = (elet.dataInicio || '').slice(0, 10);
  const comp = serie(elet, COMPLEXO);
  const horas = [...comp.keys()].sort();
  if (!horas.length) return null;

  const curva = horas.map(h => [h, r(comp.get(h), 3)]);
  const ener = curva.reduce((s, [, v]) => s + v, 0) * 5 / 60;
  const pico = curva.reduce((a, b) => (b[1] > a[1] ? b : a));
  const agora = curva[curva.length - 1];

  // A curva de 230 kV so existe onde os DOIS trafos medem: um deles sozinho nao e o plano de alta,
  // e desenhar a soma parcial faria uma queda de cobertura parecer queda de geracao.
  const t1 = serie(elet, TRAFOS[0]), t2 = serie(elet, TRAFOS[1]);
  const alta = horas.filter(h => t1.has(h) && t2.has(h)).map(h => [h, r(t1.get(h) + t2.get(h), 3)]);

  // Rendimento por usina, na janela COMUM aos 22 circuitos. Sem a janela comum a comparacao mede
  // cobertura em vez de geracao: uma usina cujos circuitos pararam antes pareceria pior.
  let rend = null, rendAte = null;
  const CIRC = mapaCircuitos();
  if (CIRC) {
    const sc = {};
    for (const ps of Object.values(CIRC)) for (const p of ps) sc[p] = serie(elet, p);
    const todos = Object.values(sc);
    const comuns = horas.filter(h => todos.every(m => m.has(h)));
    if (comuns.length) {
      rendAte = comuns[comuns.length - 1];
      rend = Object.entries(CIRC).map(([u, ps]) => {
        const e = comuns.reduce((s, h) => s + ps.reduce((a, p) => a + sc[p].get(h), 0), 0) * 5 / 60;
        return { ufv: u, mwh: r(e, 1), mwh_mw: r(e / CAP[u], 3) };
      }).sort((a, b) => b.mwh_mw - a.mwh_mw);
    }
  }

  // Saude: so o resumo e a lista, sem `serie` nem `timeline`, que sao 90% do peso e a tela nao usa.
  const med = saude && Array.isArray(saude.medidores)
    ? saude.medidores.map(m => ({ nome: m.nome, grupo: m.grupo, idade: m.idade_min, estado: m.estado, balde: (m.ultima || '').slice(11, 16) }))
    : null;

  return {
    gerado: new Date().toISOString(),
    dia, hora: agora[0], n: curva.length, passo_min: 5, outorga_mw: OUTORGA,
    agora_mw: agora[1], pico_mw: pico[1], pico_hora: pico[0],
    pct_outorga: r(100 * pico[1] / OUTORGA, 1),
    energia_mwh: r(ener, 1), fc_pct: r(100 * ener / (OUTORGA * curva.length * 5 / 60), 1),
    media_mw: r(ener / (curva.length * 5 / 60), 1),
    curva, alta,
    rendimento: rend, rendimento_ate: rendAte,
    saude: saude ? { ok: saude.resumo && saude.resumo.ok, total: saude.resumo && saude.resumo.total,
      idade_min: saude.idade_min, ancora: saude.ancora, medidores: med } : null
  };
}

module.exports = { monta, mapaCircuitos, COMPLEXO, TRAFOS, OUTORGA, CAP };
