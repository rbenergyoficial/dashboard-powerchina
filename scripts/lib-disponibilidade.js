/*
 * lib-disponibilidade.js — disponibilidade POR USINA, medida no proprio inversor.
 *
 * DE ONDE VEM: o supervisorio publica, por inversor e por dia, o TEMPO DE OPERACAO DIARIO (em
 * minutos). Um inversor que operou o dia inteiro marca a janela de sol (~12,3 h em Mauriti); um
 * que parou marca menos. A razao entre o que ele operou e a janela do dia e a disponibilidade
 * dele; a da usina e a media dos inversores (todos SG350HX, mesma capacidade, entao media simples).
 *
 * 🔴 A JANELA DO DIA E MEDIDA, NAO SUPOSTA — e e a MEDIANA do complexo inteiro, nao o maximo nem
 *    o p90. Medido em 06/09/2026, 42 dias: a mediana do tempo de operacao fica entre 11,98 e 12,42 h
 *    em todos os dias (o sol de Mauriti). O p90 NAO serve: em M4, M5, M6 e M9 ha transformadores
 *    inteiros cujos inversores marcam ~23,5 h todo dia, e o p90 contaminado por eles jogava a
 *    disponibilidade do M4 a 87% e a do M9 a 68% com as usinas intactas.
 *
 * 🔴 O CONTADOR DE 24 H NAO E INDISPONIBILIDADE. Sao inversores cujo contador nao zera a noite
 *    (M4/TS7 os 22, M5/TS1-4, M6/TS1,3,4, M9/TS1): geram exatamente como os pares — razao de energia
 *    contra a mediana dos vizinhos = 1,000 (n = 3.987 inversor-dias). Entram como DISPONIVEIS e a
 *    contagem deles e publicada, para o dia em que a semantica do contador mudar aparecer.
 *
 * VALIDADO CONTRA A ENERGIA: nos inversores com menos de 95% da janela, a fracao de horas e a
 * razao de energia contra os pares andam juntas (r = 0,675, n = 73); a energia cai menos que as
 * horas (0,858 contra 0,753) porque a parada tende a cair nas pontas do dia, que valem menos.
 *
 * O QUE ISTO NAO E: a disponibilidade DECLARADA ao operador nacional (disp_pct do executivo), que
 * e capacidade disponivel declarada no nivel do conjunto. As duas medem coisas parecidas por
 * caminhos independentes — em ago/26, 99,81% aqui contra ~99,7% la — e por isso convivem.
 */
const LIMITE_DIURNO_MIN = 900;     // acima de 15 h o contador e de outra natureza (24 h)
const MIN_DIURNOS = 50;            // menos que isso e dia sem base para medir a janela
const JANELA_MIN = 600, JANELA_MAX = 840;   // 10 a 14 h: fora disso o dado nao e o que se pensa
const PARADO = 0.5, PARCIAL = 0.9;

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

/**
 * @param {Array<{dia:string, ufv:string, ts?:string, inv?:string, horas:number}>} linhas
 *   uma linha por inversor por dia; `horas` e o tempo de operacao diario em MINUTOS
 * @returns {{ porDia: Map<string, {janela_min:number|null, porUfv:Object, complexo:Object|null, nota?:string}> }}
 */
function disponibilidade(linhas) {
  const porDia = new Map();
  for (const l of linhas) {
    if (l == null || l.horas == null || !isFinite(l.horas)) continue;
    if (!porDia.has(l.dia)) porDia.set(l.dia, []);
    porDia.get(l.dia).push(l);
  }
  const out = new Map();
  for (const [dia, arr] of porDia) {
    const diurno = arr.filter((l) => l.horas <= LIMITE_DIURNO_MIN).map((l) => l.horas).sort((a, b) => a - b);
    const res = { janela_min: null, porUfv: {}, complexo: null };
    if (diurno.length < MIN_DIURNOS) { res.nota = 'poucos inversores com contador diurno (' + diurno.length + ')'; out.set(dia, res); continue; }
    const ref = diurno[diurno.length >> 1];
    if (!(ref >= JANELA_MIN && ref <= JANELA_MAX)) {
      res.nota = 'janela do dia fora de 10-14 h (' + r2(ref / 60) + ' h): o contador nao e o que se pensa';
      out.set(dia, res); continue;
    }
    res.janela_min = ref;
    const porU = {};
    for (const l of arr) (porU[l.ufv] = porU[l.ufv] || []).push(l);
    let sCx = 0, nCx = 0;
    for (const [ufv, L] of Object.entries(porU)) {
      let soma = 0, parados = 0, parciais = 0, c24 = 0;
      for (const l of L) {
        let f;
        if (l.horas > LIMITE_DIURNO_MIN) { f = 1; c24++; }
        else f = Math.min(l.horas, ref) / ref;
        soma += f;
        if (f < PARADO) parados++; else if (f < PARCIAL) parciais++;
      }
      porUfvSet(res.porUfv, ufv, { disp_pct: r2(100 * soma / L.length), n: L.length, parados, parciais, contador_24h: c24 });
      sCx += soma; nCx += L.length;
    }
    res.complexo = nCx ? { disp_pct: r2(100 * sCx / nCx), n: nCx } : null;
    out.set(dia, res);
  }
  return { porDia: out };
}
function porUfvSet(o, k, v) { o[k] = v; }

/** media por (ufv, mes) sobre os dias; grupos ponderados pelo numero de inversores do dia */
function mensal(porDia, grupos) {
  const acc = {};   // ufv|mes -> { s, n, dias }
  const add = (k, disp, n) => { const o = acc[k] || (acc[k] = { s: 0, n: 0, dias: 0 }); o.s += disp * n; o.n += n; o.dias++; };
  for (const [dia, r] of porDia) {
    if (r.janela_min == null) continue;
    const mes = dia.slice(0, 7);
    for (const [ufv, x] of Object.entries(r.porUfv)) add(ufv + '|' + mes, x.disp_pct, x.n);
    for (const [g, membros] of Object.entries(grupos || {})) {
      let s = 0, n = 0;
      for (const u of membros) { const x = r.porUfv[u]; if (x) { s += x.disp_pct * x.n; n += x.n; } }
      if (n) add(g + '|' + mes, s / n, n);
    }
  }
  const out = {};
  for (const [k, o] of Object.entries(acc)) out[k] = { disp_pct: r2(o.s / o.n), dias: o.dias };
  return out;
}

module.exports = { disponibilidade, mensal, LIMITE_DIURNO_MIN, JANELA_MIN, JANELA_MAX, PARADO, PARCIAL };
