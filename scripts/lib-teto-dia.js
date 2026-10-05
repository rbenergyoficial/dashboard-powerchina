// lib-teto-dia.js — a guarda do DIA EM CURSO no executivo.json (PROMOVER executivo-teto-fisico).
//
// 🔴 POR QUE MUDOU. A guarda antiga comparava o dia em curso com o maior dia JA REGISTRADO NO MES x 1,25. No inicio de um mes
// com dias cortados ela trava um dia de sol: em 05/10/2026 outubro so tinha 01-04 (2.456,66 / 1.478,56 / 759,49 / 828,02 MWh,
// todos com restricao), o teto deu 3.071 MWh e o dia, 3.153,88 MWh as 18:10, foi recusado a cada 5 min desde as 16:45 — e os
// passos seguintes do job (perdas, resumo do assistente, watchdog de frescor, ensaios de produto) deixaram de rodar.
//
// O TETO AGORA E FISICO: nenhuma energia do dia passa de 343,77 MW (a outorga) x as horas desde as 05:00 ate o ultimo instante
// lido. Medido nos 618 dias do historico do Ao vivo (hist/portal_vivo_DIA.json, 25/01/2025 a 04/10/2026): a primeira geracao
// acima de 1 MW nunca veio antes das 05:10, e a energia acumulada nunca passou de 78,9 % desse teto em instante nenhum (o
// maximo, 09/09/2026 e 22/09/2026). O que a guarda existe para pegar continua pego: unidade errada (kWh por MWh, x 1000) sempre,
// e o dia contado em dobro sempre que a razao real passa de 50 % (da metade da manha em diante, num dia de sol).
// O "dia nunca encolhe" fica como estava (o snapshot so cresce).

'use strict';
const OUTORGA = 343.77;      // MW
const INICIO_MIN = 5 * 60;   // 05:00: antes disso nao ha geracao (medido: a primeira, 05:10)

const minutos = (ate) => (ate === '00:00' || ate === '24:00') ? 1440 : (+String(ate).slice(0, 2)) * 60 + (+String(ate).slice(3, 5));

// MWh: o maximo que o complexo pode ter gerado do inicio do dia ate `ate` (HH:MM)
function tetoDia(ate) { return OUTORGA * Math.max(0, minutos(ate) - INICIO_MIN) / 60; }

// null = pode gravar; texto = o motivo para nao gravar
function guardaDia(novo, antes, ate) {
  if (!/^\d\d:\d\d$/.test(String(ate || ''))) return 'dia em curso sem o instante lido (' + ate + ')';
  const t = tetoDia(ate);
  if (novo > t) return 'dia em curso ' + novo + ' MWh acima do teto fisico ' + t.toFixed(2) + ' MWh (343,77 MW x horas desde 05:00, ate ' + ate + ')';
  if (antes != null && novo < antes - 1) return 'dia em curso ENCOLHEU (' + antes + ' -> ' + novo + ')';
  return null;
}

module.exports = { tetoDia, guardaDia, OUTORGA, INICIO_MIN };
