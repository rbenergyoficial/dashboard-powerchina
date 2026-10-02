/**
 * gen-agente-om.js — publica agente_om.json: o RESUMO que o assistente de voz do portal consulta para responder sobre
 * geracao e meta (pedido do humano em 01/10/2026: "quero que ele saiba as informacoes do portal").
 *
 * Por que um blob proprio: o assistente le o dado por uma chamada HTTP a cada pergunta, e a resposta entra inteira no
 * contexto do modelo. O executivo.json tem ~3,7 MB e o portal_vivo.json ~58 KB (curvas de 5 min); nenhum dos dois cabe.
 * Este arquivo carrega so os numeros que as telas mostram, por entidade, em ~10 KB.
 *
 * 🔴 ELE SELECIONA, NAO CALCULA. Todo numero aqui e um campo publicado, copiado sem conta nenhuma:
 *   agora            portal_vivo.json   (Complexo = campos do topo; usinas, PPA e ML = `kpis`)
 *   mes em curso     executivo.json     `serie_ufv` (linha parcial) + `manchete_ufv` (projecao, falta, ritmos)
 *   meses fechados   executivo.json     `serie_ufv` (linhas fechadas, os ultimos MESES_FECHADOS)
 *   ano              executivo.json     `ytd_ufv`
 * Uma conta refeita aqui seria uma segunda copia da regra, livre para divergir da tela em silencio. O ensaio
 * (ensaio-agente-om.js) confere cada numero contra o campo de origem.
 *
 *   node scripts/gen-agente-om.js            grava o blob (DADOS_STORAGE)
 *   LOCAL_OUT_DIR=<pasta> node ...           grava em arquivo
 */
'use strict';
const zlib = require('zlib');

const BASE = process.env.BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const LOCAL_OUT_DIR = process.env.LOCAL_OUT_DIR || '';
const OUT_BLOB = process.env.OUT_BLOB || 'agente_om.json';
const ENTIDADES = ['Complexo', 'PPA', 'ML', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const MESES_FECHADOS = 6;
/* o assistente do portal baixa o resumo a cada pergunta: acima disso ele deixa de ser leve; melhor abortar e cortar de
   proposito (era 25 KB quando o leitor era um modelo de linguagem; o corte do ONS, em 02/10/2026, levou a ~30 KB) */
const TETO_KB = 45;
const DIAS_CORTE = 7;   /* ultimos dias com corte apurado (o operador publica com ~1 dia de atraso) */

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
        try { ok(JSON.parse(b.toString('utf8').replace(/^﻿/, ''))); } catch (e) { erro(new Error('JSON invalido: ' + e.message)); }
      });
    }).on('error', erro);
  });
}

/* o que cada campo QUER DIZER, para o assistente nao adivinhar. Texto de negocio: vai para fora. */
const LEGENDA = {
  unidades: 'Energia em MWh, potencia em MW, percentuais em %. Hora de Brasilia.',
  agora: 'Medicao ao vivo do dia de hoje, de 5 em 5 minutos, no medidor de faturamento. agora_mw e a potencia no ultimo '
    + 'instante medido; valor negativo e o consumo noturno da instalacao (sem geracao). pico_mw e pico_hora sao o maior valor '
    + 'do dia ate agora. pct_cap e o pico em relacao a capacidade. energia_hoje_mwh e a energia liquida do dia ate a hora '
    + 'informada. fc_pct e o fator de capacidade do dia ate agora.',
  mes_em_curso: 'O mes mais recente. Se fechado = true, ele acabou de fechar e o mes novo ainda nao tem dado; nesse caso '
    + 'a meta rateada e a do mes inteiro e nao ha projecao a fazer. liquida_mwh e a energia liquida entregue no mes ate agora. meta_mes_mwh e a meta '
    + 'contratual do mes inteiro; meta_rateada_mwh e a parte dela que corresponde aos dias ja decorridos. '
    + 'atingido_rateada_pct compara o entregue com a meta rateada (100 % = no ritmo); atingido_mes_pct compara com a meta do '
    + 'mes inteiro. projecao_mwh e projecao_pct estimam o fechamento do mes no ritmo atual. falta_mwh e quanto falta para a '
    + 'meta do mes. ritmo_necessario_mwh_dia e ritmo_atual_mwh_dia sao medias diarias.',
  meses_fechados: 'Meses ja encerrados: energia liquida, meta contratual do mes e percentual atingido.',
  ano: 'Acumulado do ano so com os meses JA FECHADOS (o mes em curso nao entra). meses_na_meta conta quantos meses bateram a '
    + 'meta.',
  corte: 'Energia que a usina deixou de gerar por limitacao do operador nacional (ONS). cortado_mwh e a energia impedida; '
    + 'corte_pct e essa energia em % do potencial (o que teria gerado sem a limitacao); horas_restricao sao as horas sob '
    + 'limitacao no mes (no mes so vao cortado_mwh e potencial_mwh; o percentual do dia vai pronto). O operador publica com atraso de cerca de um dia, entao o mes em curso so tem os dias ja publicados '
    + '(ultimos_dias). motivos: ENE = razao energetica (sobra de energia no sistema), CNF = confiabilidade da rede, REL = '
    + 'indisponibilidade de equipamento externo. ano.complexo compara o corte do conjunto com o da regiao Nordeste (solar) e '
    + 'com o do parque vizinho Abaiara, na mesma janela; vantagem_pp positiva = Mauriti cortou menos que o Nordeste.',
  grupos: 'Complexo = as nove usinas (343,77 MW). PPA = contrato de longo prazo (M2, M3, M4, M5, M6 e M8). ML = mercado livre '
    + '(M1, M7 e M9); no ML a geracao e reduzida de proposito quando ha restricao, entao ficar abaixo da meta ali nao e '
    + 'defeito. M1 e a usina que a planilha comercial chama de Mauriti 10.',
};

function monta(V, X) {
  const agoraPor = {};
  agoraPor.Complexo = { cap_mw: V.outorga_mw, agora_mw: V.agora_mw, pico_mw: V.pico_mw, pico_hora: V.pico_hora,
    pct_cap: V.pct_outorga, energia_hoje_mwh: V.energia_mwh, fc_pct: V.fc_pct };
  for (const e of ENTIDADES.slice(1)) {
    const k = (V.kpis || {})[e];
    if (!k) continue;
    agoraPor[e] = { cap_mw: k.cap_mw, agora_mw: k.agora_mw, pico_mw: k.pico_mw, pico_hora: k.pico_hora,
      pct_cap: k.pct_cap, energia_hoje_mwh: k.energia_mwh, fc_pct: k.fc_pct };
  }

  const S = X.serie_ufv || [], M = X.manchete_ufv || [];
  const mesAtual = X.mes_atual;
  const cursoPor = {};
  /* o mes do executivo, aberto ou nao: na virada o `mes_atual` fica no mes que acabou de fechar ate o primeiro dado do mes
     novo, e exigir a linha parcial deixaria o resumo vermelho a cada 5 min nesse intervalo */
  let lbl = null, dc = null, dm = null, fechado = null;
  for (const e of ENTIDADES) {
    const s = S.find((x) => x.ufv === e && x.mes === mesAtual);
    const m = M.find((x) => x.ufv === e && x.mes === mesAtual);
    if (!s || !m) continue;
    lbl = s.lbl; dc = s.dias_corridos; dm = s.dias_do_mes; fechado = s.parcial === 0;
    cursoPor[e] = { liquida_mwh: s.liquida_mwh, meta_mes_mwh: s.meta_mwh, meta_rateada_mwh: s.meta_rateada_mwh,
      atingido_rateada_pct: s.atingido_pct, atingido_mes_pct: s.atingido_mes_cheio_pct,
      projecao_mwh: m.liq_proj_mwh, projecao_pct: m.proj_pct_exato, falta_mwh: m.falta_mwh,
      ritmo_necessario_mwh_dia: m.ritmo_nec_mwh, ritmo_atual_mwh_dia: m.ritmo_atual_mwh };
  }

  const fechados = [...new Set(S.filter((x) => x.parcial === 0 && x.mes !== mesAtual).map((x) => x.mes))].sort().slice(-MESES_FECHADOS);
  const mesesFechados = fechados.map((mes) => {
    const por = {};
    let l = null;
    for (const e of ENTIDADES) {
      const s = S.find((x) => x.ufv === e && x.mes === mes && x.parcial === 0);
      if (!s) continue;
      l = s.lbl;
      por[e] = { liquida_mwh: s.liquida_mwh, meta_mwh: s.meta_mwh, atingido_pct: s.atingido_pct };
    }
    return { mes, lbl: l, por_entidade: por };
  });

  const anoPor = {};
  let ano = null, ate = null;
  for (const e of ENTIDADES) {
    const y = (X.ytd_ufv || []).find((x) => x.ufv === e);
    if (!y) continue;
    ano = y.ano; ate = y.ultimo;
    anoPor[e] = { meses: y.meses, liquida_mwh: y.liquida_mwh, meta_mwh: y.meta_mwh, atingido_pct: y.atingido_pct,
      meses_na_meta: y.bateram, meses_com_meta: y.meses_com_meta };
  }

  /* ---- CORTE DO OPERADOR (ONS): so selecao, como o resto ---- */
  const CDU = X.corte_diario_ufv || [];
  const diasC = [...new Set(CDU.map((x) => x.dia))].sort().slice(-DIAS_CORTE);
  const ultimosDias = diasC.map((dia) => {
    const por = {};
    CDU.filter((x) => x.dia === dia).forEach((x) => { por[x.ufv] = { potencial_mwh: x.potencial_mwh, cortado_mwh: x.cortado_mwh, corte_pct: x.corte_pct }; });
    return { dia, por_usina: por };
  });
  const MU = X.motivo_ufv || [], SC = X.serie || [];
  const corteMeses = fechados.map((mes) => {
    const por = {};
    for (const e of ENTIDADES) {
      const s = S.find((x) => x.ufv === e && x.mes === mes && x.parcial === 0);
      if (!s) continue;
      /* 🔴 SEM o `corte_pct` do mes: medido em 02/10/2026, no Complexo de abr a jul/26 ele nao confere com o cortado e o
         potencial da MESMA linha (abr: 23,28 % publicado, 22,29 % pelo par em MWh) — o cortado foi editado depois e o
         percentual ficou para tras. Ate o lote proprio no executivo, o assistente fala o par em MWh, que fecha. */
      const o = { potencial_mwh: s.potencial_mwh, cortado_mwh: s.cortado_mwh, horas_restricao: s.horas_restricao };
      if (e === 'Complexo') {
        const c = SC.find((x) => x.mes === mes);
        if (c && c.razoes) o.motivos_pct = Object.fromEntries(Object.entries(c.razoes).map(([k, v]) => [k, v.pct]));
      } else {
        const mu = MU.find((x) => x.ufv === e && x.mes === mes);
        if (mu && mu.razoes_mwh) o.motivos_mwh = mu.razoes_mwh;
      }
      por[e] = o;
    }
    return { mes, lbl: (S.find((x) => x.mes === mes) || {}).lbl, por_entidade: por };
  });
  const corteAno = {};
  for (const e of ENTIDADES) {
    const y = (X.ytd_ufv || []).find((x) => x.ufv === e);
    if (!y) continue;
    corteAno[e] = { cortado_mwh: y.cortado_mwh, meses_com_corte: y.meses_com_corte };
    if (e === 'Complexo') Object.assign(corteAno[e], {
      janela: y.corte_janela, corte_pct: y.corte_conj_pct, nordeste_pct: y.corte_ne_pct, abaiara_pct: y.corte_abaiara_pct,
      vantagem_pp: y.corte_vantagem_pp, horas_restricao: y.corte_horas,
      motivos_pct: { ENE: y.corte_ene_pct, CNF: y.corte_cnf_pct, REL: y.corte_rel_pct } });
  }

  return {
    gerado: new Date().toISOString(),
    fontes: { ao_vivo: V.gerado, executivo: X.atualizado },
    legenda: LEGENDA,
    agora: { dia: V.dia, hora: V.hora, por_entidade: agoraPor },
    mes_em_curso: { mes: mesAtual, lbl, fechado, dias_corridos: dc, dias_do_mes: dm, por_entidade: cursoPor },
    meses_fechados: mesesFechados,
    ano: { ano, meses_fechados_ate: ate, por_entidade: anoPor },
    corte: { ultimos_dias: ultimosDias, meses: corteMeses, ano: { ano, por_entidade: corteAno } },
  };
}

/* guardas: o resumo incompleto nao e gravado (melhor o assistente ler o anterior que um resumo com buraco) */
function guarda(R) {
  const mau = [];
  const faltam = (obj, nome) => ENTIDADES.filter((e) => !obj[e]).forEach((e) => mau.push(nome + ': sem ' + e));
  faltam(R.agora.por_entidade, 'agora');
  faltam(R.mes_em_curso.por_entidade, 'mes em curso');
  faltam(R.ano.por_entidade, 'ano');
  if (R.meses_fechados.length !== MESES_FECHADOS) mau.push('meses fechados: ' + R.meses_fechados.length + ' em vez de ' + MESES_FECHADOS);
  R.meses_fechados.forEach((m) => faltam(m.por_entidade, 'mes ' + m.mes));
  if (!R.corte || R.corte.ultimos_dias.length !== DIAS_CORTE) mau.push('corte: ' + (R.corte ? R.corte.ultimos_dias.length : 0) + ' dias em vez de ' + DIAS_CORTE);
  else R.corte.ultimos_dias.forEach((d) => ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'].forEach((u) => { if (!d.por_usina[u]) mau.push('corte ' + d.dia + ': sem ' + u); }));
  if (R.corte) faltam(R.corte.ano.por_entidade, 'corte do ano');
  const kb = Buffer.byteLength(JSON.stringify(R)) / 1024;
  if (kb > TETO_KB) mau.push('tamanho ' + kb.toFixed(1) + ' KB acima do teto de ' + TETO_KB);
  return { mau, kb };
}

async function grava(R) {
  const corpo = Buffer.from(JSON.stringify(R));
  if (LOCAL_OUT_DIR) { require('fs').writeFileSync(require('path').join(LOCAL_OUT_DIR, OUT_BLOB), corpo); return; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const c = BlobServiceClient.fromConnectionString(process.env.DADOS_STORAGE).getContainerClient('dados');
  /* SEM gzip de proposito: quem le e o cliente HTTP do assistente, e 10 KB nao justificam depender de ele descomprimir */
  await c.getBlockBlobClient(OUT_BLOB).upload(corpo, corpo.length, { blobHTTPHeaders: {
    blobContentType: 'application/json; charset=utf-8', blobCacheControl: 'public, max-age=60' } });
}

async function main() {
  const [V, X] = await Promise.all([puxa(BASE + 'portal_vivo.json'), puxa(BASE + 'executivo.json')]);
  const R = monta(V, X);
  const { mau, kb } = guarda(R);
  if (mau.length) { console.error('agente_om: NAO gravado\n  ' + mau.join('\n  ')); process.exit(1); }
  await grava(R);
  console.log('agente_om: ' + kb.toFixed(1) + ' KB · agora ' + R.agora.hora + ' · mes ' + R.mes_em_curso.lbl
    + ' · fechados ' + R.meses_fechados.map((m) => m.lbl).join(', ') + ' · ano ' + R.ano.ano + ' ate ' + R.ano.meses_fechados_ate);
}

module.exports = { monta, guarda, ENTIDADES, MESES_FECHADOS, DIAS_CORTE };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
