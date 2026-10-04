// portal_eletrico.json — as grandezas eletricas do DIA, medidor a medidor, para a secao "Grandezas eletricas" da tela
// "Ao vivo" do portal (PROMOVER portal-eletrico).
//
// 🔴 POR QUE ELE EXISTE
// O portal_vivo.json carrega so a potencia ativa do dia e o RETRATO do ultimo instante. Tensao e corrente por fase ao
// longo do dia so existiam no way2_eletrico.json (3,5 MB, todas as grandezas com data e qualidade em cada valor): pesado
// demais para o navegador. Este arquivo carrega SO os numeros, numa grade fixa de 5 min: medido em 03/10/2026 com o dia
// inteiro, ~70 KB no gzip. E um arquivo a parte porque so a tela Ao vivo o baixa.
//
// 🔴 24 MEDIDORES E UMA SOMA. Os 22 circuitos de 34,5 kV e os dois trafos de 230 kV sao os medidores. O ponto 6233 NAO e
// medidor: e um ponto CALCULADO pela Way2. Provado em 03/10/2026 (286 instantes, diferenca 0,0): P, Q e corrente de cada
// fase = SOMA dos 22 circuitos; tensao de cada fase = MEDIA dos 22. Ele entra marcado `soma: true`, com o nome que diz o que
// e. ⚠️ A aparente e o fator de potencia que a Way2 publica para ele estao ERRADOS (soma das aparentes; soma dos 22 fatores,
// ate 21,94): por isso este arquivo nao os carrega. S e FP saem de P e Q, que nos 24 medidores dao exatamente o
// DemAparente e o FatorPotencia da Way2 (auditoria audita-way2-grandezas.js, 04/10/2026).
//
// ⚠️ Ele DERIVA, nao mede: tudo sai do mesmo way2_eletrico.json do resto do ao-vivo. So converte unidade e arredonda.
//
// FORMATO. `grade` e a lista de instantes do dia, de 00:05 ate o ultimo instante em que QUALQUER medidor mediu potencia
// ativa (o "00:00" do fim do dia vira "24:00"). Cada medidor traz oito listas alinhadas a `grade`, com null onde ELE nao
// mediu — nunca o valor de outro instante, nunca zero:
//   p, q        potencia ativa e reativa, MW e MVAr, 3 casas (o bruto vem em kW e kVAr)
//   va, vb, vc  tensao de cada fase REFERIDA A LINHA (fase-neutro x raiz de 3), kV, 3 casas — a grandeza da placa
//               (34,5 kV, 230 kV); com 3 casas o desequilibrio sai com resolucao de 0,003 %
//   ia, ib, ic  corrente de cada fase, A, 1 casa

'use strict';

const CIRCUITOS = [];
for (let p = 6198; p <= 6219; p++) CIRCUITOS.push(p);
const TRAFOS = [6196, 6197];
const SOMA = 6233;
const GR = { p: 'Demat', q: 'Demre', va: 'TensaoA', vb: 'TensaoB', vc: 'TensaoC', ia: 'CorrenteA', ib: 'CorrenteB', ic: 'CorrenteC' };
const R3 = Math.sqrt(3);
const CONV = {   // [fator sobre o bruto, casas]
  p: [1 / 1000, 3], q: [1 / 1000, 3],
  va: [R3 / 1000, 3], vb: [R3 / 1000, 3], vc: [R3 / 1000, 3],
  ia: [1, 1], ib: [1, 1], ic: [1, 1]
};

const r = (v, c) => (v == null || !isFinite(v) ? null : Math.round(v * 10 ** c) / 10 ** c);
const hm = (m) => m === 1440 ? '24:00' : String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
// o bruto chama o ultimo instante do dia de "AAAA-MM-(DD+1)T00:00:00": ele e o 24:00 do dia, nao o 00:00
const chave = (data, dia) => {
  const h = data.slice(11, 16);
  return h === '00:00' && data.slice(0, 10) !== dia ? '24:00' : h;
};

function indice(elet, dia) {
  const I = new Map();   // pid -> grandeza -> Map(hh:mm -> valor bruto)
  for (const s of elet.dados || []) {
    if (!I.has(s.pontoId)) I.set(s.pontoId, new Map());
    const m = new Map();
    for (const v of s.valores || []) if (v && v.valor != null && isFinite(v.valor)) m.set(chave(v.data, dia), v.valor);
    I.get(s.pontoId).set(s.nomeGrandeza, m);
  }
  return I;
}

// o nome do circuito segue o do portal_vivo ("M1 · C1"): a ordem do circuito dentro da usina, pelo mapa do gerador
function nomes(mapaCircuitos) {
  const N = {};
  if (mapaCircuitos) for (const [u, ps] of Object.entries(mapaCircuitos)) ps.forEach((p, i) => { N[p] = { nome: u + ' · C' + (i + 1), u }; });
  return N;
}

function monta(elet, mapaCircuitos) {
  const dia = (elet.dataInicio || '').slice(0, 10);
  if (!dia) return null;
  const I = indice(elet, dia);
  const N = nomes(mapaCircuitos);
  const lista = [
    { pid: TRAFOS[0], nome: 'SE · TR1', nivel: '230 kV', u: null },
    { pid: TRAFOS[1], nome: 'SE · TR2', nivel: '230 kV', u: null },
    { pid: SOMA, nome: 'soma dos 22 circuitos', nivel: '34,5 kV', u: null, soma: true },
    ...CIRCUITOS.map(p => ({ pid: p, nome: (N[p] && N[p].nome) || 'circuito ' + p, nivel: '34,5 kV', u: (N[p] && N[p].u) || null }))
  ];
  // a grade vai ate o ultimo instante em que algum MEDIDOR (nao a soma) mediu potencia ativa
  let ult = 0;
  for (const p of TRAFOS.concat(CIRCUITOS)) {
    const m = I.get(p) && I.get(p).get('Demat');
    if (m) for (const h of m.keys()) { const mm = +h.slice(0, 2) * 60 + +h.slice(3, 5); if (mm > ult) ult = mm; }
  }
  if (!ult) return null;
  const grade = [];
  for (let mm = 5; mm <= ult; mm += 5) grade.push(hm(mm));

  const medidores = lista.map(x => {
    const g = I.get(x.pid) || new Map();
    const o = Object.assign({}, x);
    let ultH = null;
    for (const [k, nomeG] of Object.entries(GR)) {
      const m = g.get(nomeG) || new Map(), [f, c] = CONV[k];
      o[k] = grade.map(h => (m.has(h) ? r(m.get(h) * f, c) : null));
      if (k === 'p') for (const h of grade) if (m.has(h)) ultH = h;
    }
    o.hora = ultH;
    return o;
  });

  return {
    gerado: new Date().toISOString(), dia, hora: grade[grade.length - 1], passo_min: 5, n: grade.length,
    unidades: { p: 'MW', q: 'MVAr', v: 'kV (fase referida à linha)', i: 'A' },
    grade, medidores
  };
}

module.exports = { monta, CIRCUITOS, TRAFOS, SOMA, GR, CONV };
