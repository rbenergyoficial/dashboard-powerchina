/* lib-placa.js — a placa do parque por usina (inversores, modulos, potencia CC e CA, inversores por eletrocentro).
 *
 * Mora aqui desde 01/10/2026 (PROMOVER pr-entidade): o gen-perdas a conferia contra os rastreadores e contra ela mesma, e
 * o PR por usina (gen-pr) precisa da potencia CC de cada uma. Uma tabela so: copia em dois geradores envelhece diferente.
 * As guardas de coerencia continuam no gen-perdas, que roda a cada export. Soma de cc_kwp: 425.676,64 kWp = P_CC do PR.
 */
'use strict';

const PLACA = {
  M1: { inversores: 165, modulos: 105212, cc_kwp: 60988.16, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 11, TS4: 22, TS5: 22, TS6: 22, TS7: 22, TS8: 22 } },
  M2: { inversores: 88, modulos: 56144, cc_kwp: 32282.80, ca_kw: 27200,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22 } },
  M3: { inversores: 165, modulos: 105328, cc_kwp: 61054.86, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 11, TS5: 22, TS6: 22, TS7: 22, TS8: 22 } },
  M4: { inversores: 165, modulos: 105212, cc_kwp: 60988.16, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 11, TS7: 22, TS8: 22 } },
  M5: { inversores: 165, modulos: 105270, cc_kwp: 61021.36, ca_kw: 51000,
    // TS7/TS8: a planilha inverte 11 e 22; vale a leitura que a propria linha dela sustenta
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 22, TS7: 22, TS8: 11 } },
  M6: { inversores: 165, modulos: 105270, cc_kwp: 60530.25, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 11, TS6: 22, TS7: 22, TS8: 22 } },
  M7: { inversores: 44, modulos: 28130, cc_kwp: 16174.75, ca_kw: 13600,
    inv_por_ts: { TS1: 22, TS2: 22 } },
  M8: { inversores: 165, modulos: 105270, cc_kwp: 60530.25, ca_kw: 51000,
    inv_por_ts: { TS1: 22, TS2: 22, TS3: 22, TS4: 22, TS5: 22, TS6: 22, TS7: 11, TS8: 22 } },
  // ⚠️ M9: o TS1 tem 22 inversores e o TS2 tem 11 — confirmado pela equipe em 02/09/2026, e e o
  //    inverso do que esta constante trazia. A leitura se sustenta no padrao das tags ausentes:
  //    as mesmas cinco (INV04, 05, 06, 08 e 10) faltam sempre num eletrocentro de 22, e no M9 elas
  //    faltam no TS1.
  M9: { inversores: 33, modulos: 21054, cc_kwp: 12106.05, ca_kw: 10200,
    inv_por_ts: { TS1: 22, TS2: 11 } },
};

module.exports = { PLACA };
