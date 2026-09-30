/* lib-historico-projecao.js — o que a projecao do mes teria dito em cada marco, contra o que o mes fechou.
 *
 * POR QUE EXISTE. O cartao Projecao so fala do mes ABERTO: fechado o mes, o numero some, e nao ficava registro de
 * quanto ela errou. A projecao e sempre a mesma conta (energia dos dias fechados / dias fechados x dias do mes), e o
 * executivo publica todos os dias de cada entidade, entao o que ela diria com D dias fechados se refaz para qualquer
 * mes fechado. E isso que se publica: por entidade e mes, a meta, o gerado e a projecao em cada marco.
 *
 * ⚠️ E o METODO refeito com os dados de hoje, nao o registro do que a tela mostrou naquele dia: um dia corrigido
 * depois entra corrigido. O registro do que a tela disse e outro arquivo (gen-registro-projecao.js).
 *
 * Um mes entra quando TODOS os dias dele tem energia LIQUIDADA para a entidade (`parcial` 0). O ultimo dia do mes fica
 * parcial do por do sol ate a rodada da madrugada seguinte, e nesse intervalo o remendo de 5 min ainda o move: o mes
 * so entra no historico com ele liquidado, e o gerado publicado nao muda depois. A falta de um dia tira o mes daquela
 * entidade. Mes de comissionamento entra marcado (`ramp_up: 1`) e fica fora do resumo de acerto.
 */

const MARCOS = [5, 10, 15, 20, 25];
const r2 = (x) => Math.round(x * 100) / 100;
const diasNo = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();

/**
 * dias      : [{ufv, mes, dia_num, liq_mwh, parcial}] (a serie diaria publicada)
 * metas     : { [ufv]: { [mes]: meta_mwh } }  (meta do mes INTEIRO)
 * rampUp    : Set de meses de comissionamento
 * aberto    : (mes) => true se o mes ainda esta em curso
 * Devolve { linhas, acerto }.
 */
function historicoProjecao({ dias, metas, rampUp, aberto }) {
  const grupos = {};
  for (const x of dias || []) {
    const k = x.ufv + '|' + x.mes;
    const g = (grupos[k] = grupos[k] || { ufv: x.ufv, mes: x.mes, d: new Map(), pendente: false });
    // dia sem energia ou ainda parcial: o mes nao esta liquidado para esta entidade
    if (x.liq_mwh == null || !isFinite(Number(x.liq_mwh)) || x.parcial === 1) { g.pendente = true; continue; }
    g.d.set(Number(x.dia_num), Number(x.liq_mwh));
  }
  const linhas = [];
  for (const g of Object.values(grupos)) {
    const N = diasNo(g.mes);
    if (aberto(g.mes) || g.pendente) continue;
    let ok = true;
    for (let i = 1; i <= N; i++) if (!g.d.has(i)) { ok = false; break; }
    if (!ok) continue;
    const meta = ((metas || {})[g.ufv] || {})[g.mes];
    if (!(Number(meta) > 0)) continue;
    const acum = [0];
    for (let i = 1; i <= N; i++) acum.push(acum[i - 1] + g.d.get(i));
    const real = acum[N], M = Number(meta);
    const L = { ufv: g.ufv, mes: g.mes, dias: N, meta_mwh: r2(M), liq_mwh: r2(real), ating_pct: r2(100 * real / M),
      bateu: real >= M ? 1 : 0, ramp_up: rampUp && rampUp.has(g.mes) ? 1 : 0 };
    for (const D of MARCOS) {
      const p = acum[D] / D * N;
      L['p' + D + '_mwh'] = r2(p);
      L['p' + D + '_pct'] = r2(100 * p / M);                                   // % da meta que a projecao dizia
      L['p' + D + '_erro_pct'] = real > 0 ? r2(100 * (p - real) / real) : null; // erro contra o gerado
      L['p' + D + '_acertou'] = ((p >= M) === (real >= M)) ? 1 : 0;           // disse certo se a meta seria batida
    }
    linhas.push(L);
  }
  linhas.sort((a, b) => a.ufv < b.ufv ? -1 : a.ufv > b.ufv ? 1 : (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0));

  const acerto = [];
  for (const u of [...new Set(linhas.map(l => l.ufv))]) {
    const U = linhas.filter(l => l.ufv === u && !l.ramp_up);
    if (!U.length) continue;
    for (const D of MARCOS) {
      const E = U.map(l => l['p' + D + '_erro_pct']).filter(e => e != null);
      acerto.push({ ufv: u, dia: D, n_meses: U.length,
        acertos: U.reduce((a, l) => a + l['p' + D + '_acertou'], 0),
        erro_abs_pct: E.length ? r2(E.reduce((a, e) => a + Math.abs(e), 0) / E.length) : null,
        vies_pct: E.length ? r2(E.reduce((a, e) => a + e, 0) / E.length) : null,
        pior_pct: E.length ? r2(Math.max(...E.map(Math.abs))) : null });
    }
  }
  return { linhas, acerto };
}

/**
 * O REGISTRO do que o cartao disse: uma entrada por entidade, mes e numero de dias fechados, com a projecao que a manchete
 * publicou para o mes aberto. A projecao parte dos dias fechados e nao se move dentro do dia; quando muda (o ultimo dia
 * fechado se liquida na madrugada, ou um dia e corrigido), a mesma chave ganha uma VERSAO nova: `versoes` guarda todas,
 * na ordem, e a primeira e o que a tela mostrou primeiro. Os campos de fora sao os da versao mais recente.
 * 🔴 O registro so cresce: toda chave antiga continua, e as versoes dela comecam pelas antigas (`confereCrescimento`).
 */
const chaveReg = (x) => x.mes + '|' + x.dias_fechados + '|' + x.ufv;

function entradasDaManchete(manchete, agoraIso) {
  const fora = (manchete || []).filter((m) => m.fechado !== 0 && m.fechado !== 1);
  if (fora.length) throw new Error('manchete com `fechado` fora de 0/1 (' + JSON.stringify(fora[0].fechado) + '): recusado registrar');
  return (manchete || []).filter((m) => m.fechado === 0 && m.liq_proj_mwh != null && m.meta_mwh > 0 && m.dias_decorridos > 0)
    .map((m) => ({ mes: m.mes, ufv: m.ufv, dias_fechados: m.dias_decorridos, dias_total: m.dias_total,
      meta_mwh: m.meta_mwh, liq_fechada_mwh: m.liq_fechada_mwh != null ? m.liq_fechada_mwh : null,
      proj_mwh: m.liq_proj_mwh, proj_pct: m.proj_pct_exato != null ? m.proj_pct_exato : r2(100 * m.liq_proj_mwh / m.meta_mwh),
      gravado: agoraIso }));
}

const versao = (e) => ({ proj_mwh: e.proj_mwh, meta_mwh: e.meta_mwh, liq_fechada_mwh: e.liq_fechada_mwh, gravado: e.gravado });

function mesclaRegistro(antigo, novas) {
  const mapa = new Map();
  for (const x of antigo || []) {
    const k = chaveReg(x);
    if (mapa.has(k)) throw new Error('registro antigo com a chave ' + k + ' repetida: recusado mesclar');
    mapa.set(k, x);
  }
  let novasN = 0, revistas = 0;
  for (const e of novas) {
    const k = chaveReg(e), v = mapa.get(k);
    if (!v) { mapa.set(k, Object.assign({}, e, { versoes: [versao(e)] })); novasN++; continue; }
    if (v.proj_mwh === e.proj_mwh && v.meta_mwh === e.meta_mwh) continue;   // a mesma projecao: nada muda
    mapa.set(k, Object.assign({}, e, { versoes: (v.versoes || []).concat([versao(e)]) }));
    revistas++;
  }
  const lista = [...mapa.values()].sort((a, b) => (a.mes < b.mes ? -1 : a.mes > b.mes ? 1 : 0) || a.dias_fechados - b.dias_fechados || (a.ufv < b.ufv ? -1 : a.ufv > b.ufv ? 1 : 0));
  return { lista, novas: novasN, revistas };
}

/** chave a chave: toda chave antiga continua, e as versoes novas comecam pelas antigas, iguais. Devolve os problemas. */
function confereCrescimento(antigo, novo) {
  const f = [], N = new Map((novo || []).map((x) => [chaveReg(x), x]));
  if (N.size !== (novo || []).length) f.push('registro novo com chave repetida');
  for (const a of antigo || []) {
    const k = chaveReg(a), n = N.get(k);
    if (!n) { f.push(k + ': sumiu'); continue; }
    const va = a.versoes || [], vn = n.versoes || [];
    if (vn.length < va.length || JSON.stringify(vn.slice(0, va.length)) !== JSON.stringify(va)) f.push(k + ': versoes antigas alteradas');
  }
  return f;
}

module.exports = { historicoProjecao, MARCOS, diasNo, entradasDaManchete, mesclaRegistro, confereCrescimento, chaveReg };
