/* lib-manchete.js — os campos da manchete que SE MOVEM dentro do dia, numa escrita so.
 *
 * POR QUE EXISTE. O executivo completo entrega 5,6 das 15 execucoes declaradas (p90 de 10 h entre
 * elas), e o remendo de 5 min (`gen-dia-corrente.js`) mantinha fresca a serie diaria e a camada
 * horaria — e nao a manchete. Medido em 15/09/2026 09:34, no MESMO blob: a serie dizia dia 15 ate
 * 09:30 e a manchete dizia `dia_hoje: null`, `ao_vivo_ate: 20:40`, `hoje_gwh: 0,00`. Treze horas.
 *
 * 🔴 E REMENDAR A MANCHETE NAO E TROCAR UM CAMPO. `liq_gwh`, `atingido`, `liq_proj`, `falta_gwh` e
 * os ritmos sao um retrato COERENTE de uma rodada: avancar um sozinho cria a divergencia que o
 * remendo veio consertar. Ou se move o conjunto, ou nao se move nada — e mover o conjunto em dois
 * lugares seria reescrever a conta do executivo num segundo arquivo, que e como duas escritas da
 * mesma regra divergem na primeira edicao.
 *
 * Entao a conta mora AQUI e os dois a chamam. O executivo passa o que sempre passou, e por isso a
 * saida dele nao muda (conferido byte a byte nos meses fechados); o remendo passa a MESMA conta com
 * a energia de hoje ja crescida.
 *
 * ⚠️ A ANCORA E `liq_fechada_gwh`, campo novo e aditivo: a energia do mes SEM o dia em curso. Ela
 * nao se move dentro do dia, entao `liq = liq_fechada + hoje` e EXATO e IDEMPOTENTE — o remendo
 * pode rodar 288 vezes no dia sem acumular erro. Aplicar um delta sobre o proprio `liq_gwh` ja
 * remendado acumularia o arredondamento de cada passada.
 *
 * ⚠️ O que este modulo NAO move, de proposito: `dias_decorridos` (so a rodada completa sabe do por
 * do sol), `spark_*` (a sparkline e desenhada da serie MENSAL, que tem a sua propria vintagem) e
 * tudo o que e cadastro — `escopo`, cores, confianca.
 */

const r2 = (x) => Math.round(x * 100) / 100;

/* padrao numerico da casa: ponto decimal, espaco estreito (U+202F) no milhar, 2 casas nas medidas.
   Vem para ca porque o remendo tem de escrever a MESMA string que o executivo escreveria — formato
   em dois lugares diverge calado, e o campo e texto no blob. */
const fmt = (n, dec) => {
  if (n == null) return '—';
  const t = Number(n).toFixed(dec == null ? 2 : dec);
  const [i, f2] = t.split('.');
  return i.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (f2 ? '.' + f2 : '');
};

/** o inverso do `fmt` para os campos que voltam do blob como texto */
const parse = (v) => {
  if (v == null || v === '—') return null;
  const x = parseFloat(String(v).replace(/ /g, '').replace(',', '.'));
  return isNaN(x) ? null : x;
};

/**
 * Os campos que se movem, todos derivados de quatro entradas e nada mais.
 *   liq   energia do mes ATE AGORA, ja com o dia em curso
 *   base  a mesma energia SEM o dia em curso — e dela que a projecao parte
 *   hoje  a energia do dia em curso
 *   meta / dCorr / dTot  constantes da rodada
 * Devolve strings no formato da casa e as versoes numericas que a gauge usa.
 */
function camposDoMes({ liq, base, hoje, meta, dCorr, dTot, projFixa }) {
  const L = Number(liq), B = Number(base), H = Number(hoje);
  const M = Number(meta), dC = Number(dCorr), dT = Number(dTot);
  // ⚠️ SEM DIA FECHADO nao ha ritmo de onde projetar: a subtracao da zero e a tela afirmaria "o mes
  // vai fechar em 0 GWh". Nulo — o template ja mostra travessao.
  //
  // 🔴 `projFixa` e o caminho do REMENDO, e existe por uma razao medida: a projecao parte dos dias
  // FECHADOS, entao a energia de hoje crescendo NAO pode move-la. Recalcula-la a partir da ancora
  // (que e publicada arredondada) deslocava o ultimo centavo em 5 das 12 entidades — o card
  // anunciaria o fechamento do mes mudando sozinho. Quem ja tem a projecao da rodada completa
  // passa a dela, e ela fica exatamente onde estava.
  const proj = projFixa != null ? Number(projFixa) : (dC > 0 ? r2(B * (dT / dC)) : null);
  const at = M > 0 ? r2(100 * L / M) : null;
  const pj = M > 0 && proj != null ? r2(100 * proj / M) : null;
  const esc = Math.max(120, Math.ceil((pj || 0) / 10) * 10);
  const falta = M - L;
  const rest = Math.max(0, dT - dC);
  return {
    hoje_gwh: fmt(r2(H)),
    liq_gwh: fmt(L),
    // ⚠️ A ANCORA VAI COM 4 CASAS, e nao com as 2 das medidas. Ela nao e numero de tela: e de onde o
    // remendo parte para refazer `liq_gwh`. Publicada com 2 casas, o arredondamento dela (ate
    // 5 MWh) caia dentro do centavo do Entregue e o valor dancava entre a rodada completa e o
    // remendo. Com 4, o erro fica quatro ordens de grandeza abaixo do que a tela mostra.
    liq_fechada_gwh: fmt(Math.round(B * 10000) / 10000, 4),
    liq_proj: fmt(proj),
    atingido: fmt(at),
    proj_pct: fmt(pj),
    falta_gwh: falta > 0 ? fmt(r2(falta)) : '0.00',
    ritmo_nec: (falta > 0 && rest > 0) ? fmt(r2(falta / rest)) : null,
    ritmo_atual: dC > 0 ? fmt(r2(L / dC)) : null,
    // acelerar ou desacelerar: quantos % o ritmo precisa mudar
    ritmo_delta_pct: (falta > 0 && rest > 0 && dC > 0 && L > 0)
      ? fmt(r2(100 * ((falta / rest) / (L / dC) - 1))) : null,
    // versoes NUMERICAS: a gauge precisa de numero, o texto da manchete precisa de string formatada
    atingido_n: at,
    proj_pct_n: pj,
    realizado_w: at == null ? 0 : r2(at / esc * 100),
    projecao_w: pj == null ? 0 : r2(Math.max(0, pj - at) / esc * 100),
    marca100_w: r2(100 / esc * 100),
  };
}

/**
 * Aplica o remendo de 5 min nas linhas de manchete do mes em curso, no lugar.
 *
 * ⚠️ Os campos de QUANDO (`dia_hoje`, `ao_vivo`, `ao_vivo_ate`) entram SEMPRE: eles descrevem o
 * relogio e nao dependem de conta nenhuma. Os de ENERGIA so entram quando a linha traz a ancora
 * `liq_fechada_gwh` — sem ela o remendo nao tem de onde partir, e avancar `liq_gwh` por delta
 * acumularia arredondamento. Assim a primeira rodada completa do executivo novo destrava sozinha.
 *
 * ⚠️ NAO se movem, de proposito: `dias_decorridos` (so a rodada completa sabe do por do sol),
 * `spark_*` (desenhadas da serie MENSAL, que tem vintagem propria) e o cadastro.
 *
 * @returns {{ quando:number, energia:number, semAncora:number, semDias:number }}
 */
function remendaManchete(linhas, { mes, diaNum, ate, gwhPorUfv }) {
  const c = { quando: 0, energia: 0, semAncora: 0, semDias: 0 };
  (linhas || []).forEach((m) => {
    if (!m || m.mes !== mes || m.fechado !== 0) return;
    if (!(m.ufv in gwhPorUfv)) return;
    m.dia_hoje = diaNum;
    m.ao_vivo = 1;
    m.ao_vivo_ate = ate;
    c.quando += 1;
    const base = parse(m.liq_fechada_gwh);
    if (base == null) { c.semAncora += 1; return; }
    const dT = Number(m.dias_total), dC = Number(m.dias_decorridos);
    if (!(dT > 0) || !(dC >= 0)) { c.semDias += 1; return; }
    const hoje = Number(gwhPorUfv[m.ufv]);
    const C = camposDoMes({ liq: base + hoje, base, hoje, meta: parse(m.meta_gwh),
      dCorr: dC, dTot: dT, projFixa: parse(m.liq_proj) });
    Object.keys(C).forEach((k) => { m[k] = C[k]; });
    c.energia += 1;
  });
  return c;
}

module.exports = { r2, fmt, parse, camposDoMes, remendaManchete };
