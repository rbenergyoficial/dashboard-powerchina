/*
 * lib-irr-travada.js — a leitura de irradiancia TRAVADA sai da meia hora da estacao (PROMOVER irr-travada).
 *
 * POR QUE EXISTE. Em 23/09/2026 a estacao do M5 repetiu 0,26 W/m2 das 05:00 as 11:30 — o principal (WS) e o auxiliar
 * (GER_IRR) com o MESMO valor, e voltaram juntos ao meio-dia: foi a aquisicao da estacao, repetindo o ultimo valor da
 * noite. Os detectores do gerador olham o DIA (noite, teto diario, >= 3 valores distintos) e a tarde tinha valores de
 * sobra: o 0,26 passou como leitura boa. Efeitos medidos: a irradiancia do conjunto as 08:00 saiu 855 W/m2 contra 962
 * das outras oito estacoes, e o PR do conjunto em 23/09 foi publicado a 79,92 % (22/09: 72,56; 24/09: 44,98).
 *
 * A REGRA, com criterios que ja existem na casa:
 *   - TRAVADA: o mesmo valor (a 2 casas) em 4 ou mais meias horas seguidas — o "4+ instantes identicos" das leituras
 *     congeladas do inversor (`gen-perdas`, carimbosCongelados);
 *   - so COM SOL: a meia hora so e retirada quando a MEDIANA DAS OUTRAS estacoes passa do limiar de irradiancia do
 *     contrato (LIMIAR_IRR, 100 W/m2, do anexo). De noite, zeros repetidos sao a leitura certa e ficam;
 *   - RETIRAR, nunca substituir: as outras estacoes DETECTAM, nao dao o valor. A meia hora da estacao fica sem leitura;
 *     o conjunto (que exige as nove) fica sem valor ali, e o PR do dia cai em "dia incompleto" em vez de sair inflado.
 */
const { LIMIAR_IRR } = require('./lib-disponibilidade.js');

const RUN_MIN = 4;   // meias horas seguidas com o mesmo valor (o "4+" das leituras congeladas do inversor)

const mediana = (xs) => { const s = xs.slice().sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

/**
 * @param {Object<string, number>} leitura  chave `dia|ufv|slot` (slot com 2 digitos, 0..47) -> W/m2 medio da meia hora
 * @returns {{ retirar: Set<string>, trechos: Array<{dia:string, ufv:string, ini:number, fim:number, valor:number, n:number}> }}
 *   `retirar` sao as chaves a tirar; `trechos`, cada corrida retirada (slots inclusivos), para o log e o blob dizerem
 */
function travadas(leitura) {
  const porDia = new Map();   // dia -> slot -> ufv -> valor
  for (const [k, v] of Object.entries(leitura || {})) {
    if (v == null || !isFinite(v)) continue;
    const [d, u, s] = k.split('|');
    if (!porDia.has(d)) porDia.set(d, new Map());
    const D = porDia.get(d), sl = +s;
    if (!D.has(sl)) D.set(sl, new Map());
    D.get(sl).set(u, v);
  }
  const retirar = new Set(), trechos = [];
  for (const [d, D] of porDia) {
    const ufvs = new Set();
    for (const m of D.values()) for (const u of m.keys()) ufvs.add(u);
    const slots = [...D.keys()].sort((a, b) => a - b);
    for (const u of ufvs) {
      // corridas de valor igual em slots CONSECUTIVOS
      let run = [];
      const fecha = () => {
        if (run.length >= RUN_MIN) {
          // so as meias horas com SOL nas outras estacoes; o trecho retirado e o que sobra dentro da corrida
          const sol = run.filter((s) => {
            const outras = [...D.get(s).entries()].filter(([w]) => w !== u).map(([, v]) => v);
            const md = mediana(outras);
            return outras.length >= 2 && md != null && md > LIMIAR_IRR;
          });
          if (sol.length) {
            sol.forEach((s) => retirar.add(d + '|' + u + '|' + String(s).padStart(2, '0')));
            trechos.push({ dia: d, ufv: u, ini: sol[0], fim: sol[sol.length - 1], valor: D.get(run[0]).get(u), n: sol.length });
          }
        }
        run = [];
      };
      let ant = null;
      for (const s of slots) {
        const v = D.get(s).get(u);
        if (v == null) { fecha(); ant = null; continue; }
        const r = Math.round(v * 100) / 100;
        if (ant && ant.s === s - 1 && ant.r === r) run.push(s);
        else { fecha(); run = [s]; }
        ant = { s, r };
      }
      fecha();
    }
  }
  return { retirar, trechos };
}

module.exports = { travadas, RUN_MIN };
