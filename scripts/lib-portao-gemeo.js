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

/*
 * 🔔 A MEIA HORA RESTRITA QUE O GEMEO NAO CONSEGUE CONTAR (decisao do humano, 26/10/2026, "pode fazer a guarda do gemeo"). O corte
 *    do gemeo so existe onde ha irradiancia (o potencial vem da faixa de sol) e geracao verificada (o que se subtrai). A meia hora
 *    COM limitacao e sem uma das duas era pulada em silencio: o corte do mes saia menor e parecia normal. Medido em 26/10/2026:
 *    0 de 6.267 meias horas restritas sem irradiancia (os dois arquivos do operador saem da mesma consolidacao). A guarda conta
 *    essas meias horas por mes; o mes com alguma sai em `entrada.meses_incompletos` e a rodada avisa. Nenhum numero muda.
 * linhas: [{ mes, restrito (0/1), irr (null = sem irradiancia), ger (null = sem geracao) }]
 * devolve { por_mes: [{ mes, restritos, sem_irr, sem_ger }] (so meses com restricao, em ordem), incompletos: ['AAAA-MM', ...] }
 */
function semEntrada(linhas) {
  const M = {};
  for (const t of linhas || []) {
    if (!t.restrito) continue;
    const o = M[t.mes] || (M[t.mes] = { mes: t.mes, restritos: 0, sem_irr: 0, sem_ger: 0 });
    o.restritos++;
    if (t.irr == null) o.sem_irr++;
    else if (t.ger == null) o.sem_ger++;   // sem irradiancia ja conta acima: cada meia hora perdida conta uma vez so
  }
  const por_mes = Object.keys(M).sort().map((m) => M[m]);
  return { por_mes, incompletos: por_mes.filter((o) => o.sem_irr + o.sem_ger > 0).map((o) => o.mes) };
}

module.exports = { valida, mesEmCurso, semEntrada };
