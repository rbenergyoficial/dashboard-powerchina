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

const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const REFAZ_DIAS = Number(process.env.PR_REFAZ || 5);
const INICIO = process.env.PR_INICIO || '';   /* vazio: desde o primeiro dia com irradiacao por hora */
const LOTE_MEIAS = Number(process.env.PR_LOTE_MEIAS || 60);   /* dias sem meia hora preenchidos por rodada */

function puxa(url) {
  const https = require('https');
  return new Promise((ok, erro) => {
    https.get(url, { headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      if (res.statusCode !== 200) { erro(new Error('HTTP ' + res.statusCode + ' ' + url.split('/').pop())); res.resume(); return; }
      const p = [];
      res.on('data', (c) => p.push(c));
      res.on('end', () => {
        let b = Buffer.concat(p);
        if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
        /* arquivos antigos do medidor vem com BOM */
        try { ok(JSON.parse(b.toString('utf8').replace(/^\uFEFF/, ''))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); }
      });
    }).on('error', erro);
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
  const [irr, ons, gem, ant, irr30, antM] = await Promise.all([puxa(BASE + 'irr_60min.json'), puxa(BASE + 'ons_restricao_all.json'), puxa(BASE + 'corte_gemeo.json'), leAnterior(),
    puxa(BASE + 'irr_plano_30min.json'), leAnterior('pr_hora.json')]);
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

  const alvo = diasEntre(inicio, ultimoIrr).filter(d => {
    const v = velhos.get(d);
    return !v || d >= limiteRefaz || v.pr_pct == null || (v.pr_corrigido_pct == null && apurados.has(d.slice(0, 7)));
  });
  /* a meia hora: acumulativa como o dia; refaz o que o dia refaz e o que ainda nao tem (a primeira rodada faz tudo) */
  const primeiroM = [...sM.keys()].sort()[0].slice(0, 10), inicioM = primeiroM > inicio ? primeiroM : inicio;
  const velhosM = new Map(((antM && antM.dias) || []).map(d => [d.dia, d]));
  const alvoSet = new Set(alvo);
  /* o que falta entra em LOTES, dos mais recentes para tras: a primeira rodada baixaria ~180 dias do medidor, e o job do
     executivo tem 15 min para tudo. Com o cron de 15 rodadas por dia, o historico fecha no mesmo dia. */
  const faltam = diasEntre(inicioM, ultimoIrr).filter(d => !alvoSet.has(d) && !velhosM.has(d)).reverse().slice(0, LOTE_MEIAS);
  const alvoM = diasEntre(inicioM, ultimoIrr).filter(d => alvoSet.has(d)).concat(faltam).sort();
  const baixar = [...new Set([...alvo, ...alvoM])].sort();
  console.log('irradiacao', primeiroIrr, 'a', ultimoIrr, '·', alvo.length, 'dias a calcular ·', velhos.size, 'ja publicados ·', alvoM.length, 'dias em meias horas');

  const novos = new Map(), novosM = new Map(), alvoMSet = new Set(alvoM);
  let i = 0, falhas = 0;
  async function trabalha() {
    while (i < baixar.length) {
      const dia = baixar[i++];
      let hist = null;
      try { hist = await puxa(BASE + 'hist/way2_' + dia + '.json'); }
      catch (e) { if (!/HTTP 404/.test(e.message)) { falhas++; throw e; } }
      if (alvoSet.has(dia)) novos.set(dia, L.prDia(dia, hist ? L.energiaHoras(hist) : new Map(), gH, op, apurados));
      if (alvoMSet.has(dia)) novosM.set(dia, L.prMeias(dia, hist ? L.energiaMeias(hist) : new Map(), sM, impM, novos.get(dia) || velhos.get(dia)));
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
  const kbM = await grava('pr_hora.json', saidaM);
  console.log('pr_hora.json', (kbM / 1024).toFixed(1), 'KB gz ·', diasM.length, 'dias ·', novosM.size, 'refeitos ·', fechados, 'fechados com o dia');
  const kb = await grava('pr.json', saida);
  const ult = meses.slice(-3).map(m => m.mes + ' ' + m.pr_pct + '/' + m.pr_corrigido_pct + ' (' + m.dias_validos + 'd/' + m.dias_corrigido + 'd)').join(' | ');
  console.log('pr.json', (kb / 1024).toFixed(1), 'KB gz ·', dias.length, 'dias ·', meses.length, 'meses ·', ult);
})().catch(e => { console.error('ERRO', e.message); process.exit(1); });
