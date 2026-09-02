// A CAMADA HORARIA DE UM DIA, construida SO do snapshot de 5 min.
//
// 🔴 POR QUE EXISTE. O `hora_ufv.json` so era escrito pela execucao completa do executivo, que
//    vive no agendador do GitHub — medido em 02/09/2026: 14 execucoes em 14 h, com vaos de ate
//    47 min. O remendo de 5 minutos ja existia e regravava so `serie_dia_ufv`, nunca as horas.
//    Efeito na tela: o painel de atingimento andava (dado ate 12:50) e o de entrega por hora
//    ficava parado em 11h, na mesma pagina, com 50 min de diferenca entre eles.
//
// ⚠️ E a regra da hora NAO se copia: ela e longa (hora cheia pela melhor cobertura, hora em
//    curso com energia acumulada, tudo-ou-nada por entidade) e uma copia envelheceria diferente
//    da outra. Ela mora aqui, e os dois — o executivo e o remendo de 5 min — chamam esta funcao.
'use strict';

const CIRC = { M1: [6198, 6199, 6200], M2: [6201, 6202], M3: [6203, 6204, 6205],
  M4: [6206, 6207, 6208], M5: [6209, 6210, 6211], M6: [6212, 6213, 6214],
  M7: [6215], M8: [6216, 6217, 6218], M9: [6219] };
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);

// Devolve as linhas de `horas` daquele dia, no MESMO formato do blob.
function horasDoDia(snap, dia) {
  const porPonto = {};                       // pontoId -> { hora -> [kW] }
  const melhor = {};                         // hora -> maior numero de amostras entre os pontos
  let maiorHora = -1;
  (snap.dados || []).forEach((s) => {
    if (s.nomeGrandeza !== 'Demat') return;
    const m = porPonto[s.pontoId] = porPonto[s.pontoId] || {};
    (s.valores || []).forEach((v) => {
      if (v.valor == null) return;
      const hh = +String(v.data).slice(11, 13);
      (m[hh] = m[hh] || []).push(v.valor);
      if (hh > maiorHora) maiorHora = hh;
    });
  });
  if (maiorHora < 0) return { horas: [], maiorHora: -1, min: 0 };
  Object.values(porPonto).forEach((m) => Object.entries(m).forEach(([hh, vs]) => {
    if (!(melhor[hh] >= vs.length)) melhor[hh] = vs.length;
  }));
  // ⚠️ HORA CHEIA para aquele ponto: nem em curso, nem com slot faltando em relacao aos outros.
  //    O criterio saiu da DISTRIBUICAO — a contagem do ponto tem de ser a MELHOR daquela hora,
  //    e nao um piso fixo, senao a amostra que falta na rampa desloca a media em silencio.
  const cheia = (h, n) => h < maiorHora && n >= 11 && n === melhor[h];

  const dem = {};                            // pontoId -> { 'AAAA-MM-DDTHH' -> kW }
  const chaveDe = (h) => dia + 'T' + String(h).padStart(2, '0');
  Object.entries(porPonto).forEach(([pid, m]) => {
    Object.entries(m).forEach(([hh, vs]) => {
      if (!cheia(+hh, vs.length)) return;
      dem[pid] = dem[pid] || {};
      dem[pid][chaveDe(+hh)] = vs.reduce((a, b) => a + b, 0) / vs.length;
    });
  });

  // 🔴 A HORA EM CURSO leva a ENERGIA ACUMULADA nela, nao a media das amostras. A media finge
  //    hora inteira: com UMA de 12 amostras ela dizia 79,8 MW como se fosse a hora toda, e a
  //    curva desenhava uma queda de 206 para 80 que nao aconteceu. A formula GENERALIZA a da
  //    hora cheia — soma(kW) x 5/60 == media x 1 h com 12 amostras.
  const cCurso = chaveDe(maiorHora);
  const nCurso = melhor[maiorHora] || 0;
  let emCurso = 0;
  Object.entries(porPonto).forEach(([pid, m]) => {
    const vs = m[maiorHora];
    if (vs && vs.length === nCurso && nCurso > 0) {
      dem[pid] = dem[pid] || {};
      dem[pid][cCurso] = vs.reduce((a, b) => a + b, 0) * 5 / 60;
      emCurso += 1;
    }
  });
  const parcialChave = emCurso ? cCurso : null;
  const parcialMin = emCurso ? nCurso * 5 : 0;

  // 🔴 TUDO-OU-NADA por entidade: se QUALQUER circuito faltar naquela hora, a entidade nao tem
  //    hora. Somar o que existir subdeclara em SILENCIO — medido em 01/09/2026, PPA + ML davam
  //    288,42 MWh contra 206,20 do Complexo na mesma tela.
  const soma = (pts, k) => {
    let t = 0;
    for (const p of pts) { const v = (dem[p] || {})[k]; if (v == null) return null; t += v; }
    return pts.length ? t : null;
  };
  const chaves = new Set();
  Object.values(dem).forEach((m) => Object.keys(m).forEach((k) => chaves.add(k)));
  const horas = [];
  [...chaves].sort().forEach((k) => {
    const h = +k.slice(11, 13);
    const ehParcial = (k === parcialChave);
    const poe = (u, kw) => {
      if (kw == null) return;
      const l = { dia, h, ufv: u, mwh: r2(kw / 1000) };
      // ⚠️ o painel NAO deduz "em curso" do relogio: quem sabe a cobertura e quem a mediu
      if (ehParcial) { l.parcial = 1; l.min = parcialMin; }
      horas.push(l);
    };
    Object.entries(CIRC).forEach(([u, ps]) => poe(u, soma(ps, k)));
    poe('PPA', soma(PPA.flatMap((u) => CIRC[u]), k));
    poe('ML', soma(ML.flatMap((u) => CIRC[u]), k));
    poe('Complexo', soma([6233], k));
  });
  return { horas, maiorHora, min: parcialMin };
}

module.exports = { horasDoDia, CIRC, PPA, ML };
