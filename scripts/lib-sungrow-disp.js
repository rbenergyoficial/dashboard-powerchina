'use strict';
/*
 * lib-sungrow-disp.js — a disponibilidade dos inversores pelo estado registrado no logger Sungrow, a cada 5 min, e a
 * disponibilidade diaria por usina e do Complexo. Metodo da NT-MRT-2026-0057 (secao 4, Tabelas 2 e 3, equacoes 7 e 8),
 * o mesmo do calculo local de referencia (Indicadores_Calculados/calcula_disp_pr.py), que fecha a segunda rota.
 *
 * 🔴 COLUNA PELO NOME, NUNCA PELA POSICAO: "Status do dispositivo" (no CSV de 03/2026 e a coluna 28), "Codigo de falha"
 *    (32) e "Potencia ativa nominal" (1, em 0,1 kW). O "Status de operacao do inversor" (coluna 31, campo `st` da
 *    lib-sungrow) e OUTRA grandeza (0 a 4) e nao classifica nada aqui. Coluna ausente estoura com o nome.
 * 🔴 TABELA 2 da NT: disponivel 0x0, 0x8200, 0x8100, 0x9100, 0x1400, 0x1200, 0x1600; indisponivel 0x8000, 0x1300,
 *    0x1500, 0x2500 e 0x5500 com codigo de falha diferente de zero; 0x5500 com codigo 0, 0xFFFE (leitura invalida) e
 *    qualquer outro valor HERDAM o ultimo estado valido do inversor (no inicio, disponivel). A heranca atravessa a
 *    meia-noite: o historico e lido em ordem, inversor a inversor.
 * 🔴 FALTA DE LEITURA NAO E PARADA: o carimbo sem amostra fica fora (f = disponiveis / amostras PRESENTES no patamar);
 *    o inversor sem nenhuma amostra no patamar sai do numerador e do denominador; o patamar sem nenhum inversor lido e
 *    NULO. Amostra presente = estado e codigo de falha legiveis, no carimbo de 5 min exato (hh:m0:00 ou hh:m5:00).
 * 🔴 Usina no patamar = Σ fi·Pni / Σ Pni (equacao 8 dividida por Capu), Pni = maior potencia nominal lida do inversor
 *    (320 kW se nenhuma). O dia so usa os patamares com irradiancia da estacao da usina (estacao_logger_30min.json,
 *    meia hora T = media dos registros T+10, T+20, T+30): disp_24h = media de todos eles com logger; disp_sol = media dos
 *    que tem irradiancia >= LIMIAR_SOL. O Complexo e a media das usinas ponderada pela capacidade instalada Capu
 *    (Tabela 3 da NT: despachos ANEEL de liberacao para operacao comercial), so com as usinas que tem o valor no dia.
 * 🔴 QUEM CONTA (decisao de 11/10/2026): a regra 'posicao' conta so o numero de serie que OCUPA a posicao no dia
 *    (identificacao do gen-sungrow, `posNoDia`: o inversor retirado sai no primeiro dia do sucessor; serie sem posicao
 *    fica fora). A regra 'leitura' conta todo inversor com leitura na pasta da usina, como o calculo local; existe para a
 *    conferencia de duas rotas e NAO e a publicada.
 */
const { col } = require('./lib-sungrow.js');
const { PLACA } = require('./lib-placa.js');

const ESQUEMA = 1;                                      // do historico interno sg_disp_hist.json (classe de cada 5 min)
const COLUNAS = { st: 'Status do dispositivo', cod: 'Código de falha', pn: 'Potência ativa nominal' };
const DISPONIVEL = new Set([0x0, 0x8200, 0x8100, 0x9100, 0x1400, 0x1200, 0x1600]);
const INDISPONIVEL = new Set([0x8000, 0x1300, 0x1500, 0x2500]);
const FALHA = 0x5500;                                   // indisponivel com codigo de falha; com codigo 0, herda
const PN_PADRAO = 320;                                  // kW, a nominal que o logger registra em todos (NT, eq. 8)
const LIMIAR_SOL = 50;                                  // W/m², o patamar "com sol" da disponibilidade diaria
// Capu, MW: NT-MRT-2026-0057 Rev. 00, Tabela 3 (despachos ANEEL 2.720, 2.654, 2.685, 2.655, 2.684, 2.682, 2.653, 2.683
// de 2025 e 3.454/2025); soma 343,770 MW
const CAPU = { M1: 49.110, M2: 24.555, M3: 49.110, M4: 49.110, M5: 49.110, M6: 49.110, M7: 14.733, M8: 49.110, M9: 9.822 };
const USINAS = Object.keys(CAPU);
const SLOTS = 288, POR_MEIA = 6;

// a classe de UMA leitura: 'D' disponivel, 'I' indisponivel, 'H' herda o ultimo estado valido
function classe(st, cod) {
  if (DISPONIVEL.has(st)) return 'D';
  if (INDISPONIVEL.has(st)) return 'I';
  if (st === FALHA && cod !== 0) return 'I';
  return 'H';
}
// inteiro legivel ou null. NAO usa o `num` da lib-sungrow: o 65535 ali e sentinela (nulo), aqui e "outro valor" (herda)
const inteiro = (s) => { const t = String(s == null ? '' : s).trim(); if (!t) return null; const x = Number(t); return Number.isFinite(x) ? Math.trunc(x) : null; };
const exige = (cab, nome, onde) => { const i = col(cab, nome); if (i < 0) throw new Error(onde + ': coluna "' + nome + '" ausente'); return i; };

// o dia em 288 posicoes de 5 min ('.' sem amostra) <-> texto curto por corrida ("96.120D72.")
const rle = (a) => { let s = '', i = 0; while (i < a.length) { let j = i; while (j < a.length && a[j] === a[i]) j += 1; s += (j - i) + a[i]; i = j; } return s; };
const derle = (s) => { const a = []; for (const [, n, ch] of String(s).matchAll(/(\d+)([.DIH])/g)) for (let k = 0; k < Number(n); k += 1) a.push(ch); if (a.length !== SLOTS) throw new Error('dia com ' + a.length + ' posicoes de 5 min'); return a; };

/* um CSV de INVERSOR (o gerador so chama com o tipo pelo cabecalho) -> [{ d, c (rle), pn kW, n amostras, fora }] */
function diaDisp(cab, linhas, onde) {
  const c = { st: exige(cab, COLUNAS.st, onde), cod: exige(cab, COLUNAS.cod, onde), pn: exige(cab, COLUNAS.pn, onde) };
  const dias = new Map();
  for (const v of linhas) {
    const t = String(v[0]).trim();
    const m = t.match(/^(\d{4}-\d\d-\d\d) (\d\d):(\d\d):(\d\d)$/);
    const o = m && (dias.get(m[1]) || dias.set(m[1], { a: new Array(SLOTS).fill('.'), pn: null, fora: 0 }).get(m[1]));
    if (!m) continue;
    if (m[4] !== '00' || Number(m[3]) % 5) { o.fora += 1; continue; }     // fora da grade de 5 min: nao e amostra do patamar
    const st = inteiro(v[c.st]), cod = inteiro(v[c.cod]);
    if (st == null || cod == null) continue;                              // ilegivel = sem amostra, nunca zero
    o.a[(Number(m[2]) * 60 + Number(m[3])) / 5] = classe(st, cod);
    const pn = Number(String(v[c.pn] == null ? '' : v[c.pn]).trim());
    if (String(v[c.pn] == null ? '' : v[c.pn]).trim() && Number.isFinite(pn) && (o.pn == null || pn / 10 > o.pn)) o.pn = pn / 10;
  }
  return [...dias].map(([d, o]) => ({ d, c: rle(o.a), pn: o.pn, n: o.a.filter((x) => x !== '.').length, fora: o.fora }));
}

const histVazio = () => ({ esquema: ESQUEMA, inv: {} });
/* funde os dias lidos no historico: no mesmo carimbo a leitura NOVA ganha; carimbo ausente na nova fica o antigo (dois
   zips do mesmo dia se completam); a nominal fica a maior */
function junta(H, sn, ufv, dias) {
  const o = H.inv[sn] || (H.inv[sn] = { ufv, dias: {} });
  o.ufv = ufv;
  for (const x of dias) {
    const a = o.dias[x.d];
    if (!a) { o.dias[x.d] = { c: x.c, pn: x.pn }; continue; }
    const v = derle(a.c), nv = derle(x.c);
    for (let k = 0; k < SLOTS; k += 1) if (nv[k] !== '.') v[k] = nv[k];
    o.dias[x.d] = { c: rle(v), pn: a.pn == null ? x.pn : x.pn == null ? a.pn : Math.max(a.pn, x.pn) };
  }
}

// a serie publicada da estacao -> Map('AAAA-MM-DDThh:mm' -> { e1..e9 })
const estacaoPorMeia = (est) => new Map(((est && est.serie) || []).map((x) => [String(x.t).slice(0, 16), x]));
const hm = (k) => String(Math.floor(k / 2)).padStart(2, '0') + ':' + (k % 2 ? '30' : '00');
const irrDe = (E, d, k, u) => { const x = E.get(d + 'T' + hm(k)); const v = x ? x['e' + u.slice(1)] : null; return v == null ? null : v; };

/* o calculo. opc.regra 'posicao' (publicada, exige opc.posNoDia(sn, d) -> 'Mn/TSn/INVnn' | null) ou 'leitura';
   opc.janela [d0, d1] (so a conferencia: como o calculo local, le so esses dias, a heranca comeca em d0 como disponivel e
   a nominal e a maior da janela); opc.meias = true devolve tambem os patamares. Devolve as linhas por usina e dia, sem
   arredondar. opc.porInv = true (so na regra da posicao) devolve tambem, por POSICAO e dia, a soma das fracoes disponiveis
   nas meias horas de sol (irradiancia de LIMIAR_SOL ou mais) com leitura e quantas foram: { linhas, inv: { pos: { d: { s, n } } } },
   a mesma conta da usina sem a ponderacao pela nominal (o inversor e um so) */
function calcula(H, E, opc) {
  const regra = opc.regra;
  if (regra !== 'posicao' && regra !== 'leitura') throw new Error('regra desconhecida: ' + regra);
  if (regra === 'posicao' && typeof opc.posNoDia !== 'function') throw new Error('a regra da posicao precisa de posNoDia');
  const [j0, j1] = opc.janela || ['', '9999'];
  const naJanela = (d) => d >= j0 && d <= j1;
  const pn = {};
  for (const [sn, o] of Object.entries(H.inv)) {
    let m = null; for (const [d, x] of Object.entries(o.dias)) if (naJanela(d) && x.pn != null && (m == null || x.pn > m)) m = x.pn;
    pn[sn] = m || PN_PADRAO;
  }
  const dias = [...new Set(Object.values(H.inv).flatMap((o) => Object.keys(o.dias)))].filter(naJanela).sort();
  const ult = {};                                        // ultimo estado valido de cada inversor: true disponivel
  const linhas = [], meias = [], inv = {};
  for (const d of dias) {
    const acc = {};                                      // usina -> { num[48], den[48], inv:Set }
    for (const [sn, o] of Object.entries(H.inv)) {
      const x = o.dias[d]; if (!x) continue;
      const a = derle(x.c);
      const pos = regra === 'posicao' ? opc.posNoDia(sn, d) : null;
      const u = regra === 'posicao' ? (pos ? pos.split('/')[0] : null) : o.ufv;
      for (let k = 0; k < 48; k += 1) {
        let ok = 0, n = 0;
        for (let i = k * POR_MEIA; i < (k + 1) * POR_MEIA; i += 1) {
          const ch = a[i]; if (ch === '.') continue;
          n += 1;
          if (ch === 'D') { ult[sn] = true; ok += 1; } else if (ch === 'I') ult[sn] = false; else if (ult[sn] !== false) ok += 1;
        }
        if (opc.porInv && pos && n) {                     // a posicao no dia: so as meias horas de sol com leitura
          const g = irrDe(E, d, k, u);
          if (g != null && g >= LIMIAR_SOL) { const p = inv[pos] || (inv[pos] = {}), c = p[d] || (p[d] = { s: 0, n: 0 }); c.s += ok / n; c.n += 1; }
        }
        if (!n || !u) continue;                          // sem leitura no patamar (ou fora da posicao): fora da conta
        const s = acc[u] || (acc[u] = { num: new Array(48).fill(0), den: new Array(48).fill(0), inv: new Set() });
        s.num[k] += (ok / n) * pn[sn]; s.den[k] += pn[sn]; s.inv.add(sn);
      }
    }
    for (const u of USINAS) {
      const s = acc[u];
      let s24 = 0, n24 = 0, ssol = 0, nsol = 0, semLog = 0;
      for (let k = 0; k < 48; k += 1) {
        const f = s && s.den[k] > 0 ? s.num[k] / s.den[k] : null;
        const g = irrDe(E, d, k, u);
        if (opc.meias) meias.push({ d, u, k, hm: hm(k), f, g });
        if (g == null) continue;                         // sem irradiancia da estacao: o patamar nao entra no dia
        if (f == null) { if (g >= LIMIAR_SOL) semLog += 1; continue; }
        s24 += f; n24 += 1;
        if (g >= LIMIAR_SOL) { ssol += f; nsol += 1; }
      }
      linhas.push({ d, u, disp_sol: nsol ? ssol / nsol : null, disp_24h: n24 ? s24 / n24 : null, meias_sol: nsol, meias_24h: n24,
        meias_sol_sem_logger: semLog, inv_logger: s ? s.inv.size : 0 });
    }
  }
  if (opc.porInv) return opc.meias ? { linhas, meias, inv } : { linhas, inv };
  return opc.meias ? { linhas, meias } : linhas;
}

const pct = (f) => (f == null ? null : Math.round(f * 1e5) / 1e3);   // a fracao com 5 casas, em %
/* o blob publico, formato largo (uma linha por dia, campos por usina), como o perdas_diario.json */
function produto(linhas, agora) {
  const porD = new Map();
  for (const l of linhas) (porD.get(l.d) || porD.set(l.d, {}).get(l.d))[l.u] = l;
  const serie = [];
  for (const d of [...porD.keys()].sort()) {
    const r = { dia: d, ms: Date.parse(d + 'T00:00:00-03:00') };
    const L = porD.get(d);
    const cx = { sol: [0, 0, 0], h24: [0, 0, 0] };
    for (const u of USINAS) {
      const l = L[u] || {};
      r[u + '_disp_sol_pct'] = pct(l.disp_sol == null ? null : l.disp_sol);
      r[u + '_disp_24h_pct'] = pct(l.disp_24h == null ? null : l.disp_24h);
      r[u + '_meias_sol'] = l.meias_sol || 0;
      r[u + '_meias_sol_sem_logger'] = l.meias_sol_sem_logger || 0;
      r[u + '_inv_logger'] = l.inv_logger || 0;
      r[u + '_inv_placa'] = PLACA[u].inversores;
      if (l.disp_sol != null) { cx.sol[0] += CAPU[u] * l.disp_sol; cx.sol[1] += CAPU[u]; cx.sol[2] += 1; }
      if (l.disp_24h != null) { cx.h24[0] += CAPU[u] * l.disp_24h; cx.h24[1] += CAPU[u]; cx.h24[2] += 1; }
    }
    r.CX_disp_sol_pct = cx.sol[1] ? pct(cx.sol[0] / cx.sol[1]) : null;
    r.CX_disp_24h_pct = cx.h24[1] ? pct(cx.h24[0] / cx.h24[1]) : null;
    r.CX_usinas_sol = cx.sol[2];
    r.CX_usinas_24h = cx.h24[2];
    serie.push(r);
  }
  return { gerado_em: agora, esquema: 1,
    metodo: 'Estado de cada inversor a cada 5 min no registrador de dados do fabricante. Disponivel: 0x0, 0x8200, 0x8100, 0x9100, 0x1400,'
      + ' 0x1200, 0x1600. Indisponivel: 0x8000, 0x1300, 0x1500, 0x2500 e 0x5500 com codigo de falha. 0x5500 sem codigo de falha, 0xFFFE e'
      + ' outros valores mantem o ultimo estado valido do inversor. Na meia hora, a fracao de cada inversor e a das leituras presentes que'
      + ' estao disponiveis; a usina e a media dessas fracoes ponderada pela potencia nominal do inversor, so com os inversores que tem'
      + ' leitura; meia hora sem nenhuma leitura fica sem valor. Conta so o inversor que ocupa cada posicao no dia. O dia usa as meias horas'
      + ' com irradiancia no plano da estacao da usina: disp_24h todas, disp_sol so as com irradiancia de ' + LIMIAR_SOL + ' W/m2 ou mais.'
      + ' Complexo: media das usinas com valor no dia, ponderada pela capacidade instalada (despachos ANEEL de liberacao para operacao comercial).',
    limiar_sol_wm2: LIMIAR_SOL, capacidade_mw: CAPU,
    campos: {
      dia: 'dia (horario de Brasilia)', ms: 'epoch de 00:00 do dia em Brasilia',
      'Mn_disp_sol_pct': '% disponivel nas meias horas com irradiancia de ' + LIMIAR_SOL + ' W/m2 ou mais e leitura dos inversores',
      'Mn_disp_24h_pct': '% disponivel em todas as meias horas com irradiancia medida e leitura dos inversores',
      'Mn_meias_sol': 'meias horas que entram no disp_sol',
      'Mn_meias_sol_sem_logger': 'meias horas com irradiancia de ' + LIMIAR_SOL + ' W/m2 ou mais e nenhuma leitura de inversor (0 = dia coberto)',
      'Mn_inv_logger': 'inversores com leitura no dia', 'Mn_inv_placa': 'inversores da usina',
      CX_disp_sol_pct: 'Complexo, media das usinas ponderada pela capacidade instalada', CX_disp_24h_pct: 'idem, 24 h',
      CX_usinas_sol: 'usinas no CX_disp_sol_pct (9 = Complexo inteiro)', CX_usinas_24h: 'usinas no CX_disp_24h_pct',
    },
    serie };
}

/* o blob publico POR INVERSOR (sg_disp_inv_dia.json): uma grade dias x posicoes, compacta (1.155 posicoes x centenas de dias).
   d = % disponivel da posicao nas meias horas de sol com leitura (5 casas da fracao); m = quantas meias horas entraram (0 e d nulo:
   a posicao nao teve leitura com sol no dia) */
function produtoInv(inv, agora) {
  const dias = [...new Set(Object.values(inv).flatMap((p) => Object.keys(p)))].sort();
  const out = {};
  for (const pos of Object.keys(inv).sort()) {
    const p = inv[pos];
    out[pos] = { d: dias.map((x) => (p[x] && p[x].n ? pct(p[x].s / p[x].n) : null)), m: dias.map((x) => (p[x] ? p[x].n : 0)) };
  }
  return { gerado_em: agora, esquema: 1,
    metodo: 'Por posicao de inversor e dia, a mesma regra da disponibilidade da usina (sg_disp_dia): estado a cada 5 min no registrador de'
      + ' dados do fabricante, fracao disponivel das leituras presentes em cada meia hora, so as meias horas com irradiancia no plano da'
      + ' estacao da usina de ' + LIMIAR_SOL + ' W/m2 ou mais e com leitura do inversor; o dia e a media dessas meias horas. Conta o'
      + ' inversor que ocupa a posicao no dia (troca de inversor pelo contador de vida).',
    limiar_sol_wm2: LIMIAR_SOL,
    campos: { dias: 'dias (horario de Brasilia)', inv: 'posicao Mn/TSnn/INVnn -> { d: % disponivel por dia (nulo sem leitura com sol), m: meias horas de sol com leitura }' },
    dias, inv: out };
}

/* troca de inversor: cada numero de serie de uma posicao vale do seu INICIO EFETIVO ate o do sucessor (fim exclusivo; nulo = aberto).
   Inicio efetivo do sucessor = o primeiro dia dele que NAO e duplicado do dono da posicao. Dia duplicado = o sucessor repete, no
   mesmo dia, o contador de vida e a energia do dono (dup(novo, dono, d), do gerador): e o arquivo do antigo gravado com o numero de
   serie do novo, e nao antecipa a troca (M1/TS4 INV01, INV07 e INV08 em 15/04 e 15/07/2026, M6/TS6 INV20 em 29/04/2026: o antigo
   seguiu lendo; a regra anterior, "a partir do primeiro dia do sucessor", esvaziava a posicao). A partir do inicio efetivo o antigo
   sai, mesmo com registro depois. Serie so com dias duplicados nao vale.
   A ORDEM das series e a do primeiro dia PROPRIO de cada uma (o primeiro que nao e duplicado de nenhuma outra da posicao), e nao a do
   primeiro arquivo nem a do numero de serie (revisor de ensaio, 16/10/2026): o arquivo do antigo gravado com o numero novo pode ser
   o mais antigo da posicao, e o numero de serie de reposicao pode ordenar antes do retirado. Empate: o primeiro arquivo, e o nome.
   🔴 FORA (declarado, nao coberto): o arquivo duplicado do sucessor ANTERIOR ao primeiro dia do dono no historico. Sem leitura do dono
   antes dele, o contador nao decide de quem e o dia, o sucessor fica com o primeiro dia proprio e vira dono (a troca e antecipada).
   O acerto depende de o historico do dono comecar antes do primeiro duplicado: em M1/TS4 o dono comeca em 03/04/2026 e o primeiro
   duplicado e 15/04. O sg_hist.json ACUMULA; refaze-lo so com a janela movel de 180 dias do logger pode quebrar essa premissa.
   series: { sn: [dias 'AAAA-MM-DD'] } de UMA posicao; dup(novo, dono, d) -> booleano. */
function janelasTroca(series, dup) {
  const eDup = typeof dup === 'function' ? dup : () => false;
  const ss = Object.keys(series).filter((s) => series[s] && series[s].length);
  const ord = ss.map((s) => { const ds = series[s].slice().sort();
    return { s, ds, own: ds.find((d) => !ss.some((o) => o !== s && eDup(s, o, d))) || '9999-99-99' }; })
    .sort((a, b) => (a.own !== b.own ? (a.own < b.own ? -1 : 1) : a.ds[0] !== b.ds[0] ? (a.ds[0] < b.ds[0] ? -1 : 1) : (a.s < b.s ? -1 : 1)));
  const J = {};
  let dono = null;
  for (const x of ord) {
    if (!dono) { J[x.s] = { ini: x.ds[0], fim: null }; dono = x; continue; }
    const e = x.ds.find((d) => !eDup(x.s, dono.s, d));
    if (!e) { J[x.s] = { ini: null, fim: null }; continue; }
    J[dono.s].fim = e; J[x.s] = { ini: e, fim: null }; dono = x;
  }
  return J;
}

/* o dia do sucessor que e dado do DONO gravado com o numero de serie novo (sg-troca-contador, 16/10/2026): o contador de vida
   do sucessor naquele dia CONTINUA o do dono, entre a ultima leitura do dono ANTES do dia e a primeira DEPOIS dele (o proprio dia
   do dono fica fora do intervalo: cortado, ele esta abaixo do contador inteiro do sucessor; inteiro, acima do sucessor cortado).
   A regra anterior (o mesmo contador e a mesma energia no mesmo dia) nao via o dia em que o arquivo do dono esta CORTADO: em
   30/09/2026 a exportacao manual de M1/TS4 parou as 11:20 e o "rec" do mesmo dia trouxe o dia inteiro com o numero novo e o
   contador do antigo; a troca caia em 30/09 e o INV01 e o INV07 sumiam de 01 a 08/10 (a troca real e 09/10, contador do novo em
   1.334,8 kWh). Sem leitura do dono antes ou depois do dia, so vale a regra anterior. diasNovo e diasDono: { d: { vida, e } }
   TOL_DUP: o contador e publicado com uma casa (0,1 kWh, lib-sungrow `r(vida, 1)`); meia unidade dessa casa separa o mesmo valor
   arredondado de dois valores vizinhos da grade. */
const TOL_DUP = 0.05;
function dupContador(diasNovo, diasDono, d) {
  const b = diasNovo && diasNovo[d]; if (!b || b.vida == null || !diasDono) return false;
  const a = diasDono[d];
  if (a && a.vida != null && Math.abs(a.vida - b.vida) < TOL_DUP && Math.abs((a.e || 0) - (b.e || 0)) < TOL_DUP) return true;
  let lo = null, hi = null;
  for (const x of Object.keys(diasDono).sort()) { const v = diasDono[x] && diasDono[x].vida; if (v == null) continue; if (x < d) lo = v; else if (x > d) { hi = v; break; } }
  return lo != null && hi != null && b.vida >= lo - TOL_DUP && b.vida <= hi + TOL_DUP;
}

/* quem representa a posicao no dia DUPLICADO fora da janela da serie: o arquivo do sucessor (o dado do dono com o numero novo) vale
   no lugar do dono quando tem MAIS amostras que o do dono no mesmo dia, ou quando o dono nao tem arquivo; empate fica o dono (M1/TS4
   em 15/07/2026, 288 e 288). series, J e dup como no janelasTroca; amostras(sn, d) -> n. Devolve { sn: { d: true | false } }:
   true = a serie vale no dia fora da sua janela, false = o dono sai no dia dentro da sua janela */
function substitutosTroca(series, J, dup, amostras) {
  const S = {}, ss = Object.keys(series).filter((s) => series[s] && series[s].length);
  const dentro = (s, d) => { const w = J[s]; return !!(w && w.ini && d >= w.ini && (!w.fim || d < w.fim)); };
  for (const s of ss) for (const d of series[s]) {
    if (dentro(s, d)) continue;
    const dono = ss.find((o) => o !== s && dentro(o, d)); if (!dono || !dup(s, dono, d)) continue;
    const nd = series[dono].indexOf(d) >= 0 ? amostras(dono, d) : -1;
    if (amostras(s, d) > nd) { (S[s] || (S[s] = {}))[d] = true; if (nd >= 0) (S[dono] || (S[dono] = {}))[d] = false; }
  }
  return S;
}

/* a POSICAO DO INVERSOR NOVO SEM O SCADA (fonte-inv-logger, 19/10/2026). A identificacao pelo contador de vida casa o logger com o
   `ENERGIA TOTAL GERADA` do export do SCADA, e o export parou em 14/10/2026: o inversor que entra numa troca depois disso fica sem
   posicao e sai de todo produto por posicao (M9/TS1/INV16: o A2431800098 leu ate 15/10, o sucessor comecou em 16/10 com o contador
   em 1.277,5 kWh e ficou fora da disponibilidade e da frota). A regra pelo proprio logger: o numero de serie sem posicao assume a
   posicao VAGA do mesmo logger (mesma usina e mesma pasta do sungrow-raw: o inversor novo e lido pelo mesmo registrador do retirado)
   quando ha UMA so vaga e ele e o UNICO candidato a ela.
   Vaga = a posicao identificada cujo dono atual (o numero de serie dela com o ultimo dia mais recente) NAO tem leitura em nenhum dia
   a partir do primeiro dia proprio do novo (o primeiro que nao e duplicado do dono, `dup`, a mesma regra do janelasTroca), com o
   dono lido ANTES desse dia e o logger lendo a pasta nesse dia (outro inversor identificado da mesma pasta com leitura nele: sem
   isso, o novo do dia em que so ele chegou casaria com qualquer posicao da pasta).
   Mais de uma vaga para o mesmo novo, ou mais de um novo para a mesma vaga: nada se atribui, e o caso volta em `ambiguos` (o
   registro de substituicoes e o desempate, por decisao humana). A pasta nao e a posicao (M1/TS5 x TS6, M9/TS1 01-05 na pasta do TS2):
   ela so restringe quem pode ocupar a vaga, a posicao vem do dono.
   inv: { sn: { ufv, pasta, dias: { d: {...} } } } (o historico do gerador); ident: { sn: { pos, ... } }; dup(novo, dono, d) -> bool.
   Devolve { atribui: { sn: { pos, d, metodo, dono } }, ambiguos: [{ sn, vagas: [pos] } | { pos, novos: [sn] }] } */
const METODO_VAGA = 'posicao vaga no mesmo logger';
function posicaoPelaVaga(inv, ident, dup) {
  const eDup = typeof dup === 'function' ? dup : () => false;
  const dias = (sn) => Object.keys((inv[sn] && inv[sn].dias) || {}).sort();
  const porPos = new Map();
  for (const [sn, a] of Object.entries(ident || {})) if (inv[sn] && dias(sn).length) (porPos.get(a.pos) || porPos.set(a.pos, []).get(a.pos)).push(sn);
  const vagas = [];
  for (const [pos, sns] of porPos) {
    const dono = sns.slice().sort((x, y) => { const a = dias(x).pop(), b = dias(y).pop(); return a !== b ? (a < b ? 1 : -1) : (x < y ? -1 : 1); })[0];
    vagas.push({ pos, dono, ufv: inv[dono].ufv, pasta: inv[dono].pasta, fim: dias(dono).pop() });
  }
  const lePasta = (ufv, pasta, d, fora) => Object.keys(ident || {}).some((s) => s !== fora && inv[s] && inv[s].ufv === ufv && inv[s].pasta === pasta && inv[s].dias[d]);
  const cand = {};
  for (const sn of Object.keys(inv).filter((s) => !(ident || {})[s] && dias(s).length)) {
    const o = inv[sn];
    const vs = [];
    for (const v of vagas) {
      if (v.ufv !== o.ufv || v.pasta !== o.pasta) continue;
      const own = dias(sn).find((d) => !eDup(sn, v.dono, d));
      if (!own || !(v.fim < own)) continue;                         // o dono leu no dia proprio do novo ou depois: nao ha vaga
      if (!lePasta(v.ufv, v.pasta, own, v.dono)) continue;          // a pasta nao foi lida no dia: nada prova a vaga
      vs.push({ pos: v.pos, d: own, dono: v.dono });
    }
    if (vs.length) cand[sn] = vs;
  }
  const atribui = {}, ambiguos = [];
  const porVaga = new Map();
  for (const [sn, vs] of Object.entries(cand)) {
    if (vs.length > 1) { ambiguos.push({ sn, vagas: vs.map((v) => v.pos).sort() }); continue; }
    (porVaga.get(vs[0].pos) || porVaga.set(vs[0].pos, []).get(vs[0].pos)).push({ sn, ...vs[0] });
  }
  for (const [pos, L] of porVaga) {
    if (L.length > 1) { ambiguos.push({ pos, novos: L.map((x) => x.sn).sort() }); continue; }
    atribui[L[0].sn] = { pos, d: L[0].d, metodo: METODO_VAGA, dono: L[0].dono };
  }
  return { atribui, ambiguos };
}

/* A TROCA PELA PLANILHA DE SUBSTITUICOES (lote sg-troca-planilha, 30/10/2026). O desempate que o posicaoPelaVaga deixa para o registro:
   M4/TS8 trocou o INV03 e o INV05 no mesmo dia (27/10/2026), duas vagas e dois novos, e os dois ficaram sem posicao (fora do
   sg_inv_dia e do mapa). A aba 'Inverter Failure Control' traz, por troca, a posicao (SPV, TS, INV), o RETIRADO (SN), a data (DATA DA
   SUBSTITUICAO) e o INSTALADO (MARKUP). Colunas pelo NOME; linha sem posicao, data ou instalado fica fora.
   trocasDaPlanilha(linhas): a aba como matriz (sheet_to_json header:1, raw) -> [{ pos, d, retirado, instalado }] */
const METODO_PLANILHA = 'planilha de substituicoes';
const normaU = (s) => { const m = /^M\s*0*([1-9])$/i.exec(String(s == null ? '' : s).trim()); return m ? 'M' + m[1] : null; };
const normaTs = (s) => { const m = /^TS\s*0*([1-9]\d?)$/i.exec(String(s == null ? '' : s).trim()); return m ? 'TS' + Number(m[1]) : null; };
const normaInv = (s) => { const m = /^INV\s*0*([1-9]\d?)$/i.exec(String(s == null ? '' : s).trim()); return m ? 'INV' + m[1].padStart(2, '0') : null; };
const normaSn = (s) => { const t = String(s == null ? '' : s).trim().toUpperCase(); return /^[A-Z0-9]{8,}$/.test(t) ? t : null; };
function dataIso(v) {             // celula de data: numero de serie do Excel, 'AAAA-MM-DD' ou 'DD/MM/AAAA'
  if (typeof v === 'number' && v > 40000 && v < 80000) return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 10);
  const s = String(v == null ? '' : v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return null;
}
function trocasDaPlanilha(linhas) {
  let h = -1, c = null;
  for (let i = 0; i < Math.min((linhas || []).length, 20) && h < 0; i++) {
    const r = (linhas[i] || []).map((x) => String(x == null ? '' : x).trim().toUpperCase());
    const k = { u: r.indexOf('SPV'), ts: r.indexOf('TS'), inv: r.indexOf('INV'), sn: r.indexOf('SN'), mk: r.indexOf('MARKUP'),
      d: r.findIndex((x) => x.startsWith('DATA DA SUBSTITUI')) };
    if (Object.values(k).every((j) => j >= 0)) { h = i; c = k; }
  }
  if (h < 0) throw new Error('planilha de substituicoes: cabecalho com SPV, TS, INV, SN, DATA DA SUBSTITUICAO e MARKUP nao encontrado');
  const out = [];
  for (const r of linhas.slice(h + 1)) {
    const u = normaU(r[c.u]), ts = normaTs(r[c.ts]), inv = normaInv(r[c.inv]), ins = normaSn(r[c.mk]), d = dataIso(r[c.d]);
    if (u && ts && inv && ins && d) out.push({ pos: u + '/' + ts + '/' + inv, d, retirado: normaSn(r[c.sn]), instalado: ins });
  }
  return out;
}
/* posicaoPelaPlanilha(inv, ident, trocas, dup): o INSTALADO sem posicao assume a posicao da troca quando tudo confere com o logger:
   o retirado e quem ocupa a posicao (ident), os dois na mesma usina e na mesma pasta do logger, o retirado sem leitura a partir do
   primeiro dia proprio do instalado (o primeiro que nao e duplicado do retirado, a regra do janelasTroca), esse dia nao antes da data
   da troca, e nenhum outro numero de serie da posicao lendo a partir dele. O mesmo instalado em duas posicoes, ou duas atribuicoes
   para a mesma posicao: nada vale. O que nao confere volta em `recusados` com o motivo (o gerador escreve no log).
   Devolve { atribui: { sn: { pos, d, metodo, dono } }, recusados: [{ sn, motivo }] } */
function posicaoPelaPlanilha(inv, ident, trocas, dup) {
  const eDup = typeof dup === 'function' ? dup : () => false;
  const I = ident || {};
  const dias = (sn) => Object.keys((inv[sn] && inv[sn].dias) || {}).sort();
  const porSn = new Map();
  for (const t of trocas || []) (porSn.get(t.instalado) || porSn.set(t.instalado, []).get(t.instalado)).push(t);
  const cand = {}, recusados = [];
  for (const [sn, ts] of porSn) {
    if (I[sn] || !dias(sn).length) continue;                       // ja tem posicao, ou o logger nao o le
    const ps = [...new Set(ts.map((t) => t.pos))].sort();
    if (ps.length > 1) { recusados.push({ sn, motivo: 'instalado em mais de uma posicao na planilha: ' + ps.join('|') }); continue; }
    const t = ts.slice().sort((a, b) => (a.d < b.d ? 1 : -1))[0];
    const u = t.pos.split('/')[0], o = inv[sn], dono = t.retirado;
    if (o.ufv !== u) { recusados.push({ sn, motivo: 'o logger o le em ' + o.ufv + ', a planilha o poe em ' + t.pos }); continue; }
    if (!dono || !I[dono] || I[dono].pos !== t.pos || !inv[dono]) { recusados.push({ sn, motivo: 'o retirado ' + dono + ' nao e quem ocupa ' + t.pos }); continue; }
    if (inv[dono].pasta !== o.pasta) { recusados.push({ sn, motivo: 'o retirado e o instalado em pastas diferentes do logger' }); continue; }
    const own = dias(sn).find((d) => !eDup(sn, dono, d));
    const fim = dias(dono).pop();
    if (!own || !(fim < own)) { recusados.push({ sn, motivo: 'o retirado ' + dono + ' leu ate ' + fim + ', no primeiro dia do instalado ou depois' }); continue; }
    if (own < t.d) { recusados.push({ sn, motivo: 'lido desde ' + own + ', antes da troca (' + t.d + ')' }); continue; }
    const outro = Object.keys(I).find((s) => s !== dono && I[s].pos === t.pos && dias(s).some((d) => d >= own));
    if (outro) { recusados.push({ sn, motivo: t.pos + ' ja e de ' + outro + ', com leitura a partir de ' + own }); continue; }
    cand[sn] = { pos: t.pos, d: own, metodo: METODO_PLANILHA, dono };
  }
  const porPos = new Map();
  for (const [sn, a] of Object.entries(cand)) (porPos.get(a.pos) || porPos.set(a.pos, []).get(a.pos)).push(sn);
  const atribui = {};
  for (const [pos, sns] of porPos) {
    if (sns.length > 1) { for (const sn of sns) recusados.push({ sn, motivo: pos + ' para mais de um instalado: ' + sns.sort().join('|') }); continue; }
    atribui[sns[0]] = cand[sns[0]];
  }
  return { atribui, recusados };
}

module.exports = { posicaoPelaPlanilha, trocasDaPlanilha, METODO_PLANILHA, posicaoPelaVaga, METODO_VAGA, produtoInv, janelasTroca, dupContador, substitutosTroca, ESQUEMA, COLUNAS, DISPONIVEL, INDISPONIVEL, FALHA, PN_PADRAO, LIMIAR_SOL, CAPU, USINAS, classe, rle, derle,
  diaDisp, histVazio, junta, estacaoPorMeia, calcula, produto, pct };
