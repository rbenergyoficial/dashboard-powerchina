'use strict';
/*
 * lib-portao-gemeo.js — o portao de calibracao do corte por gemeo de irradiancia (`gen-corte-gemeo.js`): revalida o
 * modelo contra os meses em que a apuracao do ONS presta e diz se o blob pode ser gravado (PROMOVER gemeo-mes-fechado,
 * 11/10/2026). Saiu do gerador para o ensaio (`ensaio-portao-gemeo.js`) julgar a MESMA conta.
 *
 * 🔴 SO MESES FECHADOS ENTRAM NA CONTA (decisao do humano, 11/10/2026). O portao foi calibrado em 20/08/2026 sobre seis
 * meses fechados (mar-ago/26: MAE 6,7 %, vies -2,3 %; limites 12 % e +-8 % = ~1,8x o erro medido). Cada mes novo entrava
 * sozinho na validacao, inclusive o mes EM CURSO. Em 11/10 o mes aberto tinha 9 dias e 83 h de restricao, e o veredito
 * virou entre rodadas do mesmo dia so com a republicacao do operador: 14:47Z passou (vies -7,04 %), 15:40Z reprovou
 * (-8,38 %: out/26 a -42 %), e com o dado das 18h passaria (-7,26 %). Portao que vira com o mes incompleto nao mede
 * calibracao, e deixava o blob parado. O mes em curso continua nos `pares` (o portal mostra o apurado do ONS ao lado do
 * gemeo nele), marcado `aberto: 1`, e fica FORA do MAE, do vies, do pior mes e da contagem.
 */
const r2 = (v) => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

/* o mes em curso no fuso de Brasilia (UTC-3, sem horario de verao), 'AAAA-MM' */
const mesEmCurso = (agoraMs) => new Date(agoraMs - 3 * 3600e3).toISOString().slice(0, 7);

/* serie: [{ mes, corte_gwh }]; verdade: { mes: GWh apurado pelo ONS }; devolve o bloco `validacao` e o veredito */
function valida(serie, verdade, mesAberto, maxMae, maxVies) {
  const pares = serie.filter((s) => verdade[s.mes] != null)
    .map((s) => ({ mes: s.mes, ons: verdade[s.mes], modelo: s.corte_gwh,
      erro_pct: r2(100 * (s.corte_gwh - verdade[s.mes]) / verdade[s.mes]), aberto: s.mes === mesAberto ? 1 : 0 }));
  const F = pares.filter((p) => !p.aberto);
  const mae = F.length ? r2(F.reduce((a, p) => a + Math.abs(p.erro_pct), 0) / F.length) : null;
  const vies = F.length ? r2(F.reduce((a, p) => a + p.erro_pct, 0) / F.length) : null;
  const pior = F.length ? r2(Math.max(...F.map((p) => Math.abs(p.erro_pct)))) : null;
  const validacao = { meses: F.length, mae_pct: mae, vies_pct: vies, pior_mes_pct: pior,
    limite_mae_pct: maxMae, limite_vies_pct: maxVies, mes_em_curso_fora: pares.some((p) => p.aberto) ? mesAberto : null, pares };
  // `impossivel` derruba sempre (nem SEM_PORTAO grava modelo que nao se mediu); `reprova` e o portao dos limites
  const impossivel = F.length < 4 ? 'validacao impossivel: so ' + F.length + ' mes(es) fechado(s) de referencia valida no benchmark. '
    + 'Nao gravo modelo que nao pude medir.' : null;
  const reprova = !impossivel && (mae > maxMae || Math.abs(vies) > maxVies) ? 'PORTAO REPROVOU: MAE ' + mae + '% (limite ' + maxMae
    + ') · vies ' + vies + '% (limite +-' + maxVies + '), em ' + F.length + ' meses fechados. O blob NAO foi atualizado.' : null;
  return { validacao, impossivel, reprova };
}

module.exports = { valida, mesEmCurso };
