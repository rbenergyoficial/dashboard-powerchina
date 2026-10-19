/**
 * gen-pr.js - publica pr.json: o Performance Ratio do conjunto no 230 kV, por dia e por mes, com o corte
 * dentro e corrigido pelo corte (energia impedida pelo operador somada). A conta mora em lib-pr.js.
 *
 * Fontes (todas ja publicadas):
 *   hist/way2_<dia>.json      medidor, 5 min, TR1 e TR2 — o dia de hoje e reescrito a cada 5 min
 *   irr_60min.json            irradiacao no plano, media das estacoes, 1 h (~1 ano)
 *   ons_restricao_all.json    limitacao do operador por meia hora (~1 dia de atraso)
 *   corte_gemeo.json          quais meses tem o corte apurado pela referencia do operador
 *   irr_plano_30min.json      as AMOSTRAS de 30 min da irradiacao (so para o dia em meias horas)
 *
 * Publica tambem pr_hora.json: o dia em meias horas [T, T+30), para o painel descer ao dia escolhido. A conta e a
 * mesma do dia (lib-pr.js, prMeias); a irradiacao da meia hora e o TRAPEZIO das amostras T e T+30, porque a estacao
 * amostra no instante e o medidor e o operador integram a meia hora. Guarda: a soma das meias horas fecha com o dia.
 *
 * O dia so fecha quando a irradiacao chega (export das estacoes, D-1): a energia e fresca, o PR nao
 * pode ser mais fresco que a irradiacao. Acumulativo: dia ja publicado e completo nao e refeito, salvo
 * os ultimos REFAZ_DIAS (o operador e as estacoes corrigem dias recentes).
 *
 *   node scripts/gen-pr.js                  grava o blob (DADOS_STORAGE)
 *   LOCAL_OUT_DIR=<pasta> node ...          grava em arquivo
 */
'use strict';
const zlib = require('zlib');
const L = require('./lib-pr.js');
const { PLACA } = require('./lib-placa.js');
const LOTE_UFV = Number(process.env.PR_LOTE_UFV || 60);   /* dias de historico por entidade preenchidos por rodada */

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const REFAZ_DIAS = Number(process.env.PR_REFAZ || 5);
const INICIO = process.env.PR_INICIO || '';   /* vazio: desde o primeiro dia com irradiacao por hora */
const LOTE_MEIAS = Number(process.env.PR_LOTE_MEIAS || 60);   /* dias sem meia hora preenchidos por rodada */

/* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`). So o 404 do proprio blob vira 'HTTP 404 <nome>' (a ausencia
   que os chamadores testam); o que a lib estoura (403, 409, 5xx, rede, e o 404 de conteiner sumido) sai sem casar com /HTTP 404/,
   para nunca virar "primeira rodada" e regravar o acumulado do zero. */
const LD = require('./lib-le-dados');
const naoE404 = (e) => { throw new Error('lib-le-dados: ' + String(e && e.message).replace(/^HTTP 404/, '404')); };
function puxa(url) {
  /* 💰 custo-a (17/10/2026): o historico do medidor vem pela leitura condicional (`lib-le-blob.js`); a mensagem do 404 e a mesma */
  const LB = require('./lib-le-blob');
  if (LB.ALVO.test(url)) return LB.bytes(url, { 'Accept-Encoding': 'gzip' }).catch(naoE404).then((b) => {
    if (b == null) throw new Error('HTTP 404 ' + url.split('/').pop());
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    try { return JSON.parse(b.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new Error('JSON invalido: ' + e.message); }
  });
  return LD.pede(url, { 'Accept-Encoding': 'gzip' }).catch(naoE404).then((x) => {
    if (x.status !== 200) throw new Error('HTTP ' + x.status + ' ' + url.split('/').pop());
    let b = x.buf;
    if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
    /* arquivos antigos do medidor vem com BOM */
    try { return JSON.parse(b.toString('utf8').replace(/^\uFEFF/, '')); } catch (e) { throw new Error('JSON invalido: ' + e.message); }
  });
}

/* 🔴 so o 404 e ausencia; qualquer outra falha aborta (regravar sem o historico apagaria o acumulado) */
async function leAnterior(nome = 'pr.json') {
  try { return await puxa(BASE + nome); }
  catch (e) { if (/HTTP 404/.test(e.message)) return null; throw new Error('nao consegui ler o ' + nome + ' publicado (' + e.message + ')'); }
}

async function grava(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (LOCAL_OUT_DIR) { require('fs').writeFileSync(require('path').join(LOCAL_OUT_DIR, nome), gz); return gz.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados');
  await c.getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

const hojeLocal = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const diasEntre = (a, b) => { const o = []; for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 86400e3) o.push(new Date(t).toISOString().slice(0, 10)); return o; };

(async () => {
  const [irr, ons, gem, ant, irr30, antM, iu, antU, exe] = await Promise.all([puxa(BASE + 'irr_60min.json'), puxa(BASE + 'ons_restricao_all.json'), puxa(BASE + 'corte_gemeo.json'), leAnterior(),
    puxa(BASE + 'irr_plano_30min.json'), leAnterior('pr_hora.json'), puxa(BASE + 'irr_ufv.json').catch((e) => { if (/HTTP 404/.test(e.message)) return null; throw e; }),
    leAnterior('pr_ufv.json'), puxa(BASE + 'executivo.json')]);
  /* 🔴 O PATAMAR DO CONJUNTO QUE O EXECUTIVO TROCOU PELA SOMA DAS USINAS (PROMOVER ref-parcela-corte, 11/10/2026): a impedida
     do conjunto sai daqui com a MESMA troca, pela lista que ele publica (`ref_conjunto_pela_soma`), senao o PR corrigido de
     01/10 fica 36,09 MWh abaixo do corte do executivo. So troca onde o cru ainda traz o defeito (lib-ref-conjunto). */
  const nLista = require('./lib-ref-conjunto.js').aplicaLista(ons.consolidado, exe && exe.ref_conjunto_pela_soma);
  if (nLista) console.log('conjunto: ' + nLista + ' patamar(es) com o gref pela soma das usinas, pela lista do executivo');
  /* PROMOVER irr-travada: dia com leitura de irradiancia TRAVADA retirada (declarado pela solarimetria em
     `leituras_travadas`) e refeito, mesmo fora dos ultimos REFAZ_DIAS — o PR publicado dele saiu com a irradiacao errada
     (23/09/2026: 79,92 % com a manha do M5 a 0,26 W/m2). Sem o campo (solarimetria antiga), nada muda. */
  const travDias = new Set(((iu && iu.leituras_travadas) || []).map((t) => t.dia));
  const sM = L.amostrasIrr(irr30.serie, 'gti_w_Complexo'), impM = L.impedidaMeias(ons.consolidado);
  if (!sM.size) throw new Error('irr_plano_30min sem a coluna gti_w_Complexo: formato mudou?');
  const gH = L.irradiacaoHoras(irr.serie);
  const op = L.operadorHoras(ons.consolidado);
  /* meses em que o corte do executivo vem da referencia do operador (e nao do modelo mensal) */
  const apurados = new Set((gem.serie || []).filter(x => x.base === 'apurado').map(x => x.mes));
  if (!apurados.size) throw new Error('corte_gemeo.json sem nenhum mes apurado: formato mudou?');
  if (!gH.size) throw new Error('irradiacao por hora vazia');

  const chaves = [...gH.keys()].sort();
  const primeiroIrr = chaves[0].slice(0, 10), ultimoIrr = chaves[chaves.length - 1].slice(0, 10);
  const hoje = hojeLocal(), inicio = INICIO || primeiroIrr;
  const velhos = new Map(((ant && ant.dias) || []).map(d => [d.dia, d]));
  const limiteRefaz = new Date(Date.parse(hoje + 'T00:00:00Z') - REFAZ_DIAS * 86400e3).toISOString().slice(0, 10);

  /* 🔴 O DIA QUE O OPERADOR REVISOU DEPOIS DE PUBLICADO (PROMOVER ref-parcela-corte, 11/10/2026; a regra `revisto` que o
     pr_ufv ja tinha, agora no conjunto). 01/10 entrou com a referencia de um quinto do dia (impedida 0) e nunca mais foi refeito:
     tinha corrigido e estava fora dos ultimos REFAZ_DIAS. O dia passa a guardar `op_impedida_mwh`, a impedida do operador
     somada nas 24 h na hora do calculo, e e refeito quando ela muda (folga 0,0006, a do ensaio). Dia antigo, sem a impressao:
     refeito se a impedida publicada difere da do operador nas horas com irradiacao — medido em 11/10: 5 dias (01/10 e 14, 15,
     16 e 24/09, os de setembro com o operador ~0,5 a 4 MWh abaixo do publicado); refeitos, ganham a impressao. A regra mora na
     lib-pr (`revistoConjunto`), e o ensaio-pr a julga em casos forjados. */
  const opDia = (d) => L.opImpedidaDia(d, op);
  const revistoConj = (d, v) => L.revistoConjunto(d, v, op, gH, apurados);
  const alvo = diasEntre(inicio, ultimoIrr).filter(d => {
    const v = velhos.get(d);
    return !v || d >= limiteRefaz || v.pr_pct == null || (v.pr_corrigido_pct == null && apurados.has(d.slice(0, 7))) || travDias.has(d)
      || revistoConj(d, v);
  });
  { const rev = diasEntre(inicio, ultimoIrr).filter(d => d < limiteRefaz && velhos.get(d) && revistoConj(d, velhos.get(d)));
    if (rev.length) console.log('pr do conjunto: ' + rev.length + ' dia(s) refeito(s) pela revisao do operador: ' + rev.join(', ')); }
  /* a meia hora: acumulativa como o dia; refaz o que o dia refaz e o que ainda nao tem (a primeira rodada faz tudo) */
  const primeiroM = [...sM.keys()].sort()[0].slice(0, 10), inicioM = primeiroM > inicio ? primeiroM : inicio;
  const velhosM = new Map(((antM && antM.dias) || []).map(d => [d.dia, d]));
  const alvoSet = new Set(alvo);
  /* o que falta entra em LOTES, dos mais recentes para tras: a primeira rodada baixaria ~180 dias do medidor, e o job do
     executivo tem 15 min para tudo. Com o cron de 15 rodadas por dia, o historico fecha no mesmo dia. */
  const faltam = diasEntre(inicioM, ultimoIrr).filter(d => !alvoSet.has(d) && !velhosM.has(d)).reverse().slice(0, LOTE_MEIAS);
  const alvoM = diasEntre(inicioM, ultimoIrr).filter(d => alvoSet.has(d)).concat(faltam).sort();
  const baixar = [...new Set([...alvo, ...alvoM])].sort();
  console.log('irradiacao', primeiroIrr, 'a', ultimoIrr, '·', alvo.length, 'dias a calcular ·', velhos.size, 'ja publicados ·', alvoM.length, 'dias em meias horas'
    + ' · ' + [...travDias].filter((d) => d >= inicio && d <= ultimoIrr).length + ' com leitura travada retirada');

  /* ── O PR POR ENTIDADE (PROMOVER pr-entidade): M1..M9, PPA e ML em pr_ufv.json. Acumulativo como o do conjunto: refaz o
     que o dia refaz, o que ainda nao tem corrigido e o corte agora apurado, e preenche o historico em LOTES (mais recentes
     primeiro). O corte da usina vem do executivo (`corte_diario_ufv`, janela movel de ~75 dias): o que sai da janela fica
     no que ja foi publicado. */
  const ENT = Object.keys(L.CIRC_UFV), gU = L.irradiacaoHorasUfv(irr.serie);
  const placaMwp = Object.fromEntries(ENT.map((u) => [u, PLACA[u].cc_kwp / 1000]));
  if (Math.abs(ENT.reduce((a, u) => a + placaMwp[u], 0) - L.P_CC_MWP) > 0.001) throw new Error('a placa por usina nao soma a P_CC do conjunto');
  const corteU = new Map();
  for (const x of (exe && exe.corte_diario_ufv) || []) if (x.cortado_mwh != null) corteU.set(x.dia + '|' + x.ufv, +x.cortado_mwh);
  if (!corteU.size) throw new Error('executivo.json sem corte_diario_ufv: formato mudou?');
  const velhosU = new Map();
  for (const [e, v] of Object.entries((antU && antU.entidades) || {})) for (const d of v.dias || []) { const o = velhosU.get(d.dia) || {}; o[e] = d; velhosU.set(d.dia, o); }
  /* 🔴 E o dia cuja impedida publicada DIVERGE do corte que o executivo apura agora (PROMOVER executivo-vermelho,
     10/10/2026). O operador revisa dias velhos: 01/10 entrou com a referencia de UM quinto do dia, foi republicado inteiro em
     06-07/10, e o corte do M1 nesse dia foi de 2,7 a 10,18 MWh. O dia ja estava fora dos ultimos REFAZ_DIAS e tinha corrigido,
     entao nunca mais era refeito: o `ensaio-pr-ufv --produto` reprovou 8 usinas de 01/10 (o M3 fechava) em toda rodada de 07/10 22:13Z
     em diante, e o executivo ficou vermelho com o blob gravado. A folga e a do proprio ensaio (0,0006 MWh). */
  const revisto = (d, v) => ENT.some((u) => v[u] && v[u].impedida_mwh != null && corteU.has(d + '|' + u)
    && Math.abs(v[u].impedida_mwh - corteU.get(d + '|' + u)) > 0.0006);
  const precisaU = (d) => { const v = velhosU.get(d); if (!v) return false;
    return d >= limiteRefaz || travDias.has(d) || revisto(d, v)
      || ENT.some((u) => !v[u] || v[u].pr_pct == null || (v[u].pr_corrigido_pct == null && corteU.has(d + '|' + u))); };
  const alvoU = diasEntre(inicio, ultimoIrr).filter(precisaU)
    .concat(diasEntre(inicio, ultimoIrr).filter((d) => !velhosU.has(d)).reverse().slice(0, LOTE_UFV)).sort();
  const alvoUSet = new Set(alvoU);
  for (const d of alvoU) if (!baixar.includes(d)) baixar.push(d);
  baixar.sort();
  const revistos = [...velhosU.keys()].filter((d) => d < limiteRefaz && revisto(d, velhosU.get(d))).sort();
  console.log('pr por entidade:', alvoU.length, 'dias a calcular ·', velhosU.size, 'ja publicados ·', corteU.size, 'usina-dias com corte apurado'
    + (revistos.length ? ' · ' + revistos.length + ' refeito(s) pelo corte revisto: ' + revistos.join(', ') : ''));
  const cortadoDe = (u, d) => corteU.has(d + '|' + u) ? corteU.get(d + '|' + u)
    : (velhosU.get(d) && velhosU.get(d)[u] && velhosU.get(d)[u].impedida_mwh != null ? velhosU.get(d)[u].impedida_mwh : null);
  const novosU = new Map();

  const novos = new Map(), novosM = new Map(), alvoMSet = new Set(alvoM);
  let i = 0, falhas = 0;
  async function trabalha() {
    while (i < baixar.length) {
      const dia = baixar[i++];
      let hist = null;
      try { hist = await puxa(BASE + 'hist/way2_' + dia + '.json'); }
      catch (e) { if (!/HTTP 404/.test(e.message)) { falhas++; throw e; } }
      if (alvoSet.has(dia)) novos.set(dia, Object.assign(L.prDia(dia, hist ? L.energiaHoras(hist) : new Map(), gH, op, apurados),
        { op_impedida_mwh: Math.round(opDia(dia) * 1000) / 1000 }));   // a impressao da revisao do operador (ver `revistoConj`)
      if (alvoMSet.has(dia)) novosM.set(dia, L.prMeias(dia, hist ? L.energiaMeias(hist) : new Map(), sM, impM, novos.get(dia) || velhos.get(dia)));
      if (alvoUSet.has(dia)) {
        const eU = hist ? L.energiaHorasUfv(hist) : new Map(), o = {};
        for (const u of ENT) o[u] = L.prDiaUfv(dia, eU.get(u) || new Map(), gU.get(u), placaMwp[u], cortadoDe(u, dia));
        for (const [g, membros] of Object.entries(L.GRUPOS)) o[g] = L.prDiaGrupo(dia, membros.map((u) => o[u]));
        novosU.set(dia, o);
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, trabalha));

  const dias = diasEntre(inicio, ultimoIrr).map(d => novos.get(d) || velhos.get(d)).filter(Boolean);
  const meses = L.prMeses(dias);
  const saida = {
    gerado_em: new Date().toISOString(), esquema: 1,
    grandeza: 'Performance Ratio do conjunto no ponto de conexao (230 kV)',
    formula: 'PR = energia injetada / (potencia CC de placa x irradiacao no plano / 1 kW/m2)',
    formula_corrigido: 'PR corrigido = (energia injetada + energia impedida pelo operador) / (potencia CC de placa x irradiacao no plano / 1 kW/m2)',
    p_cc_mwp: L.P_CC_MWP,
    energia: 'injetada no 230 kV: soma de TR1 e TR2 por instante de 5 min, so a parte positiva (sem o consumo noturno)',
    irradiacao: 'no plano dos modulos, media das estacoes do parque, por hora',
    impedida: 'Sum max(0, referencia - geracao) x 0,5 h nas meias horas com limitacao, a mesma do executivo; estimativa; so nos meses em que a referencia do operador vale',
    meses_corrigido: [...apurados].sort(),
    sem_correcao_de_temperatura: 1,
    criterios: { horas_minimas_no_dia: L.PISO_HORAS, meias_horas_do_operador_no_dia: L.PISO_LINHAS_OPERADOR, teto_pr_pct: L.TETO_PR, faixa_corrigido_pct: L.FAIXA_CORRIGIDO },
    ultimo_dia: dias.length ? dias[dias.length - 1].dia : null,
    dias, meses,
  };
  /* 🔴 FECHAMENTO: no dia com as 24 horas validas e as 48 meias horas completas, a soma das meias horas E o dia.
     Mesmas amostras de 5 min e mesmas amostras de irradiacao, somadas em janelas diferentes — divergir e erro de janela. */
  const diasM = diasEntre(inicioM, ultimoIrr).map(d => novosM.get(d) || velhosM.get(d)).filter(Boolean);
  const porDia = new Map(dias.map(d => [d.dia, d]));
  let fechados = 0;
  for (const m of novosM.values()) {
    const d = porDia.get(m.dia);
    if (!d || d.horas_validas !== 24 || m.inj.some(x => x == null) || m.irr.some(x => x == null)) continue;
    const E = m.inj.reduce((a, x) => a + x, 0), Hm = m.irr.reduce((a, x) => a + x, 0) / 2000;
    if (Math.abs(E - d.inj_mwh) > 0.001 * d.inj_mwh + 0.03 || Math.abs(Hm - d.h_kwh_m2) > 0.001 * d.h_kwh_m2 + 0.003)
      throw new Error('meias horas de ' + m.dia + ' nao fecham com o dia: energia ' + E.toFixed(3) + ' x ' + d.inj_mwh + ' MWh, irradiacao ' + Hm.toFixed(4) + ' x ' + d.h_kwh_m2 + ' kWh/m2');
    fechados++;
  }
  const saidaM = {
    gerado_em: saida.gerado_em, esquema: 1,
    grandeza: 'Performance Ratio do conjunto no 230 kV, por meia hora',
    p_cc_mwp: L.P_CC_MWP, passo_min: 30,
    janela: 'a meia hora [T, T+30), T e a posicao no vetor de 48 (00:00, 00:30, ...), hora local',
    unidades: { inj: 'MWh na meia hora', irr: 'W/m2 medio na meia hora', imp: 'MWh impedidos na meia hora', pr: '%', prc: '%' },
    irradiacao: 'trapezio das amostras instantaneas da media das estacoes em T e T+30',
    criterios: { piso_irr_w_m2: L.PISO_IRR_MEIA, teto_pr_pct: L.TETO_PR, corrigido: 'so no dia em que o PR corrigido do dia existe' },
    desde: diasM.length ? diasM[0].dia : null, ultimo_dia: diasM.length ? diasM[diasM.length - 1].dia : null,
    dias: diasM,
  };
  /* o PR por entidade: dias e meses de cada usina e contrato */
  const entidades = {};
  for (const e of ENT.concat(Object.keys(L.GRUPOS))) {
    const de = diasEntre(inicio, ultimoIrr).map((d) => (novosU.get(d) && novosU.get(d)[e]) || (velhosU.get(d) && velhosU.get(d)[e])).filter(Boolean);
    entidades[e] = { dias: de, meses: L.prMesesEnt(de) };
  }
  const saidaU = {
    gerado_em: saida.gerado_em, esquema: 1,
    grandeza: 'Performance Ratio por usina e por contrato',
    formula: saida.formula, formula_corrigido: 'PR corrigido = (energia injetada + energia impedida da usina) / (potencia CC da usina x irradiacao da estacao / 1 kW/m2)',
    energia: 'dos circuitos de 34,5 kV de cada usina, por instante de 5 min, so a parte positiva: energia antes da transformacao (a soma das nove fica ~0,3 % acima da do 230 kV); o PR de uma usina nao se compara 1:1 com o do conjunto no 230 kV',
    irradiacao: 'no plano dos modulos, da estacao da propria usina, por hora',
    impedida: 'o corte diario reconciliado da usina, o mesmo do executivo; estimativa',
    contrato: 'soma da energia das usinas / soma de (potencia CC x irradiacao) de cada uma; o dia do contrato so existe com todas as usinas',
    placa_mwp: placaMwp, grupos: L.GRUPOS,
    criterios: saida.criterios,
    ultimo_dia: (entidades.M1.dias.slice(-1)[0] || {}).dia || null,
    entidades,
  };
  const kbU = await grava('pr_ufv.json', saidaU);
  console.log('pr_ufv.json', (kbU / 1024).toFixed(1), 'KB gz ·', entidades.M1.dias.length, 'dias ·', novosU.size, 'refeitos · set/26:',
    Object.keys(entidades).map((e) => { const m = entidades[e].meses.find((x) => x.mes === '2026-09'); return e + ' ' + (m ? m.pr_pct + '/' + m.pr_corrigido_pct : '-'); }).join(' '));
  const kbM = await grava('pr_hora.json', saidaM);
  console.log('pr_hora.json', (kbM / 1024).toFixed(1), 'KB gz ·', diasM.length, 'dias ·', novosM.size, 'refeitos ·', fechados, 'fechados com o dia');
  const kb = await grava('pr.json', saida);
  const ult = meses.slice(-3).map(m => m.mes + ' ' + m.pr_pct + '/' + m.pr_corrigido_pct + ' (' + m.dias_validos + 'd/' + m.dias_corrigido + 'd)').join(' | ');
  console.log('pr.json', (kb / 1024).toFixed(1), 'KB gz ·', dias.length, 'dias ·', meses.length, 'meses ·', ult);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
