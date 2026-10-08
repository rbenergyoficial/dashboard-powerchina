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

// Potencia instalada de cada CIRCUITO, em MW, na ordem C1, C2, C3 de cada usina (a ordem dos pontos no CIRC do gen-executivo)
// (PROMOVER portal-cap-circuito). Fonte: os unifilares de 34,5 kV do SCADA (telas B1/B2 e B3/B4), o numero sob "UFV MAURITI N"
// de cada alimentador, lido em 05/10/2026. A soma de cada usina fecha com CAP, e a ordem foi conferida pela energia do dia: com
// ela os 22 circuitos ficam entre 8,97 e 9,43 MWh/MW (o M7 inteiro, 7,94). Sem a mesma quantidade de circuitos do mapa, nao publica.
const CAP_CIRC = { M1: [16.38, 19.65, 13.08], M2: [12.27, 12.285], M3: [13.097, 19.633, 16.38], M4: [13.08, 16.37, 19.66],
  M5: [19.66, 9.816, 19.634], M6: [19.639, 16.366, 13.105], M7: [14.733], M8: [13.088, 19.66, 16.362], M9: [9.822] };

const r = (v, c = 2) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** c) / 10 ** c);
const GRUPO = { PPA: ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'], ML: ['M1', 'M7', 'M9'] };

// 🔴 ENERGIA LIDA (PROMOVER vivo-sem-leitura, 08/10/2026). A energia de cada usina e de cada contrato e a curva tudo-ou-nada dela
//    (a de sempre, 3 casas) MAIS, nos instantes da curva do complexo em que ela falta, o que os circuitos dela que mediram leram.
//    Antes era so a curva: um circuito sem leitura tirava a usina e o contrato INTEIROS do instante (27/07/2026, M5 · C2 das 13:55
//    em diante: PPA 589 MWh abaixo do lido; 08/10, M2 · C2: 200 MWh). Em dia sem buraco o numero e o mesmo de antes, ate a 2a casa.
//    O complexo (o ponto da Way2 que soma os 22) ja era assim. A curva da entidade, o pico, o FC e a media seguem tudo-ou-nada: um
//    buraco nao vira queda. O arquivo marca `energia_regra: 'lida'`; o portal (vivLida) e o resumo dos dias (gen-portal-dia) refazem
//    a mesma conta nos arquivos sem a marca, com os `circuitos[].pts` (energiaLidaDoArquivo).
//    grupos: entidade -> pids dos circuitos dela; leitura(pid, h) -> MW ou undefined
function energiaLida(curvas, grupos, horas, leitura) {
  const out = {};
  for (const [e, ps] of Object.entries(grupos)) {
    const ce = new Map(curvas[e] || []);
    let s = 0;
    for (const h of horas) {
      if (ce.has(h)) s += ce.get(h);
      else for (const p of ps) { const v = leitura(p, h); if (v != null) s += v; }
    }
    out[e] = r(s * 5 / 60, 2);
  }
  return out;
}
function energiaLidaDoArquivo(pv) {
  if (!pv || !pv.curvas || !(pv.circuitos || []).length) return {};
  const P = new Map(pv.circuitos.map(c => [c.pid, new Map((c.pts || []).filter(x => x[1] != null))])), G = {};
  for (const c of pv.circuitos) (G[c.u] = G[c.u] || []).push(c.pid);
  for (const [g, us] of Object.entries(GRUPO)) G[g] = us.flatMap(u => G[u] || []);
  return energiaLida(pv.curvas, G, (pv.curva || []).filter(x => x[1] != null).map(x => x[0]), (p, h) => P.get(p).get(h));
}

function serie(elet, ponto, grandeza = 'Demat') {
  const s = (elet.dados || []).find(x => x.pontoId === ponto && x.nomeGrandeza === grandeza);
  const m = new Map();
  for (const v of (s && s.valores) || []) if (v && v.valor != null) m.set(v.data.slice(11, 16), v.valor / 1000);
  return m;
}

// 🔴 O RETRATO ELETRICO de um ponto de medicao no ULTIMO instante em que ele mediu potencia ativa (PROMOVER
// portal-vivo-circuitos). Tudo no MESMO instante: P, Q, as tres tensoes e as tres correntes. Instante sem a grandeza fica
// nulo — nunca o valor de outro instante, que poria no mesmo retrato uma tensao de 14:50 e uma potencia de 15:00.
// Unidades do dado bruto: Demat kW, Demre kVAr, Tensao em V FASE-NEUTRO (19,9 kV no 34,5 kV), Corrente em A.
// A tensao publicada e a de LINHA (media das tres fases x raiz de 3), a grandeza da placa (34,5 kV, 230 kV).
// Desequilibrio de tensao: maior desvio de uma fase em relacao a media das tres, em % da media.
const GRANDEZAS = ['Demat', 'Demre', 'TensaoA', 'TensaoB', 'TensaoC', 'CorrenteA', 'CorrenteB', 'CorrenteC'];
function serieCrua(elet, ponto, grandeza) {
  const s = (elet.dados || []).find(x => x.pontoId === ponto && x.nomeGrandeza === grandeza);
  const m = new Map();
  for (const v of (s && s.valores) || []) if (v && v.valor != null) m.set(v.data.slice(11, 16), v.valor);
  return m;
}
function retrato(elet, pid) {
  const g = {};
  for (const n of GRANDEZAS) g[n] = serieCrua(elet, pid, n);
  const hs = [...g.Demat.keys()].sort();
  if (!hs.length) return null;
  const h = hs[hs.length - 1];
  const p = g.Demat.get(h) / 1000, q = g.Demre.has(h) ? g.Demre.get(h) / 1000 : null;
  const tres = (ns) => { const v = ns.map(n => g[n].get(h)); return v.every(x => x != null) ? v : null; };
  const vf = tres(['TensaoA', 'TensaoB', 'TensaoC']), ia = tres(['CorrenteA', 'CorrenteB', 'CorrenteC']);
  const med = (v) => v.reduce((a, b) => a + b, 0) / v.length;
  const s = q == null ? null : Math.hypot(p, q);
  return { h, p_mw: r(p, 3), q_mvar: r(q, 3), fp: s ? r(Math.abs(p) / s, 3) : null,
    v_kv: vf ? r(med(vf) * Math.sqrt(3) / 1000, 2) : null,
    v_deseq_pct: vf ? r(100 * Math.max(...vf.map(v => Math.abs(v - med(vf)))) / med(vf), 2) : null,
    i_a: ia ? r(med(ia), 1) : null };
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
  let rend = null, rendAte = null, curvas = null, kpis = null, circuitos = null;
  const CIRC = mapaCircuitos();
  if (CIRC) {
    const sc = {};
    for (const ps of Object.values(CIRC)) for (const p of ps) sc[p] = serie(elet, p);

    // 🔴 CURVAS POR ENTIDADE — a tela do portal segue o filtro (usina, PPA, ML), e antes so
    //    tinha o conjunto: quem escolhia "M2" via a curva do complexo com o rotulo M2.
    //    TUDO-OU-NADA POR SLOT: a entidade so existe no instante em que TODOS os seus circuitos
    //    mediram. Somar oito de nove faria uma queda de cobertura parecer queda de geracao — e a
    //    queda apareceria justamente no instante em que um medidor falha.
    //    Custo medido antes de publicar: 11 entidades x 288 slots ~ 45 KB crus, ~10 KB no gzip.
    const somaDe = (ps) => horas
      .map(h => ps.every(p => sc[p].has(h)) ? [h, r(ps.reduce((a, p) => a + sc[p].get(h), 0), 3)] : null)
      .filter(Boolean);
    curvas = {};
    for (const [u, ps] of Object.entries(CIRC)) curvas[u] = somaDe(ps);
    for (const [g, us] of Object.entries(GRUPO)) curvas[g] = somaDe(us.flatMap(u => CIRC[u]));
    // os quatro numeros do topo, POR entidade, pela MESMA conta do conjunto — senao o cartao
    // "Pico do dia" com M2 selecionado continuaria mostrando o pico do complexo; a ENERGIA e trocada abaixo pela energia
    // lida dos circuitos (vivo-sem-leitura), o FC e a media ficam na curva da entidade
    const capDe = (e) => CAP[e] != null ? CAP[e] : (GRUPO[e] || []).reduce((s, u) => s + CAP[u], 0);
    kpis = {};
    for (const [e, c] of Object.entries(curvas)) {
      if (!c.length) { kpis[e] = null; continue; }
      const en = c.reduce((s, [, v]) => s + v, 0) * 5 / 60;
      const pk = c.reduce((a, b) => (b[1] > a[1] ? b : a));
      const ag = c[c.length - 1], cap = capDe(e);
      kpis[e] = { cap_mw: r(cap, 3), n: c.length, hora: ag[0], agora_mw: ag[1], pico_mw: pk[1], pico_hora: pk[0],
        pct_cap: r(100 * pk[1] / cap, 2), energia_mwh: r(en, 2),   // duas casas (PROMOVER portal-vivo-casas): a tela mostra duas
        fc_pct: r(100 * en / (cap * c.length * 5 / 60), 2), media_mw: r(en / (c.length * 5 / 60), 2) };
    }
    // 🔴 OS 22 CIRCUITOS, um a um (PROMOVER portal-vivo-circuitos): a curva do dia de cada um, cada instante que ELE
    //    mediu (nao a grade do complexo: um circuito que parou nao ganha zeros, fica sem ponto), e o retrato eletrico do
    //    ultimo instante. O nome segue o MEDIDORES do gen-way2-recent ("M1 · C1"): a ordem do circuito dentro da usina.
    //    Custo medido antes de publicar: ~90 KB crus, ~25 KB no gzip.
    circuitos = [];
    for (const [u, ps] of Object.entries(CIRC)) ps.forEach((p, i) => {
      circuitos.push({ pid: p, u, nome: u + ' · C' + (i + 1), cap_mw: (CAP_CIRC[u] || []).length === ps.length ? CAP_CIRC[u][i] : null,
        pts: [...sc[p].keys()].sort().map(h => [h, r(sc[p].get(h), 2)]), agora: retrato(elet, p) });
    });
    const G = Object.assign({}, CIRC); for (const [g, us] of Object.entries(GRUPO)) G[g] = us.flatMap(u => CIRC[u]);
    const EL = energiaLida(curvas, G, horas, (p, h) => sc[p].get(h));   // vivo-sem-leitura
    for (const e of Object.keys(kpis)) if (kpis[e] && EL[e] != null) kpis[e].energia_mwh = EL[e];
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
    pct_outorga: r(100 * pico[1] / OUTORGA, 2),   // duas casas (PROMOVER portal-vivo-casas)
    energia_mwh: r(ener, 2), fc_pct: r(100 * ener / (OUTORGA * curva.length * 5 / 60), 2),
    media_mw: r(ener / (curva.length * 5 / 60), 2),
    curva, alta,
    // por entidade: M1..M9, PPA, ML (o Complexo e `curva`/os campos acima); null onde o mapa nao leu
    curvas, kpis, energia_regra: 'lida',   // vivo-sem-leitura: a energia do kpis ja e a lida
    rendimento: rend, rendimento_ate: rendAte,
    // os 22 circuitos e o retrato eletrico dos dois trafos e do medidor do complexo (PROMOVER portal-vivo-circuitos);
    // a reativa de 230 kV do dia, so onde os DOIS trafos mediram (a mesma regra da `alta`)
    circuitos,
    eletrico: { tr1: retrato(elet, TRAFOS[0]), tr2: retrato(elet, TRAFOS[1]), complexo: retrato(elet, COMPLEXO) },
    alta_q: (() => { const a = serieCrua(elet, TRAFOS[0], 'Demre'), b = serieCrua(elet, TRAFOS[1], 'Demre');
      return horas.filter(h => a.has(h) && b.has(h)).map(h => [h, r((a.get(h) + b.get(h)) / 1000, 3)]); })(),
    saude: saude ? { ok: saude.resumo && saude.resumo.ok, total: saude.resumo && saude.resumo.total,
      idade_min: saude.idade_min, ancora: saude.ancora, medidores: med } : null
  };
}

module.exports = { monta, mapaCircuitos, retrato, energiaLida, energiaLidaDoArquivo, GRUPO, COMPLEXO, TRAFOS, OUTORGA, CAP, CAP_CIRC };
