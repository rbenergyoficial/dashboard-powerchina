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
   proposito (era 25 KB quando o leitor era um modelo de linguagem; o corte do ONS, em 02/10/2026, levou a ~30 KB).
   50 KB desde 03/10/2026 (PROMOVER agente-corte-ufv): o percentual do mes nas 11 entidades levou o resumo a 44,97 KB, sem
   folga para a variacao do tempo real. O leitor e o motor de regras do portal (sem modelo de linguagem), com cache de 60 s. */
const TETO_KB = 50;
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
    + 'limitacao no mes (o percentual vai pronto no dia e no mes). Ate jul/26 o potencial do Complexo no mes e o do conjunto no '
    + 'operador, sem o M7, que ele so passou a registrar em 17/07/2026: por isso fica abaixo da soma das usinas. O operador publica com atraso de cerca de um dia, entao o mes em curso so tem os dias ja publicados '
    + '(ultimos_dias). motivos: ENE = razao energetica (sobra de energia no sistema), CNF = confiabilidade da rede, REL = '
    + 'indisponibilidade de equipamento externo. ano.complexo compara o corte do conjunto com o da regiao Nordeste (solar) e '
    + 'com o do parque vizinho Abaiara, na mesma janela; vantagem_pp positiva = Mauriti cortou menos que o Nordeste.',
  tempo_real: 'medidores: dos 24 medidores (2 de 230 kV e 22 de circuito de 34,5 kV), quantos chegaram em dia e quais estao fora (idade em minutos). '
    + 'rendimento: energia de hoje por usina e por MW instalado (compara usinas de tamanhos diferentes). operador: registro '
    + 'da mesa do controlador de potencia; ultima_ordem e o limite pedido pelo operador nacional na ultima mudanca registrada '
    + '(limite igual a 343,77 MW = sem limitacao); o registro chega da planilha da mesa, nao e instantaneo. must: demanda no '
    + 'ponto de conexao no ultimo instante de hoje e o maior valor de hoje, contra o contratado (acima de 100 % do contratado '
    + 'gera penalidade). fontes: o selo de frescor de cada '
    + 'fonte de dado (em dia, atencao, atrasada). A irradiancia nao e em tempo real: a estacao chega por export diario.',
  ativos: 'inversores_dia: ultimo dia fechado; parados = menos da metade da janela de sol, parciais = entre 50 % e 90 %; '
    + 'disponibilidade em %. abaixo_dos_pares: inversores cuja energia diaria fica abaixo da mediana dos vizinhos do mesmo '
    + 'eletrocentro (razao 1,00 = igual aos pares); sinal precoce, antes da falha. trocas: substituicoes de inversor registradas '
    + 'na planilha (termicas = capacitor estufado, carbonizado, superaquecimento); MTBF da frota em anos; estoque de inversores '
    + 'disponiveis. alarmes: export de alarmes do supervisorio, que vai so ate o mes ate_mes; alarmes de rede nao sao defeito do '
    + 'inversor. transformadores: carga maxima do dia contra a potencia ONAF2 da placa; temperatura so onde o canal existe; '
    + 'temperatura_em_verificacao = o enrolamento leu abaixo do oleo, o que nao e fisico, e os canais estao em verificacao em campo '
    + '(nenhuma das duas temperaturas e publicada como fato). oleo: '
    + 'laudos da ultima campanha contra a ABNT NBR 10576; pior_uso e quanto do limite o pior ensaio consome.',
  desempenho: 'pr: Performance Ratio = energia injetada / (potencia CC de placa x irradiacao no plano / 1 kW/m2), sem correcao '
    + 'de temperatura. pr_pct tem o CORTE DENTRO: usina cortada parece usina ruim, e o ML e cortado primeiro de proposito; '
    + 'pr_corrigido_pct devolve a energia impedida pelo operador (estimativa; so nos meses em que ela e apurada). O conjunto e '
    + 'medido no 230 kV; usina e contrato nos circuitos de 34,5 kV, com a estacao da propria usina: o PR de uma usina nao se '
    + 'compara 1:1 com o do conjunto. dias_validos = dias com energia e irradiacao (a irradiacao chega um dia depois). '
    + 'disponibilidade: declarada_pct = a disponibilidade do CONJUNTO declarada ao operador nacional; inversores = tempo de '
    + 'operacao de cada inversor sobre a janela de sol, medido no supervisorio, por usina e grupo.',
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
      /* O `corte_pct` do mes vai em todas as entidades. Ate 03/10/2026 ele nao fechava com o par em MWh da linha: no Complexo
         o potencial misturava bases (corrigido em `eac9bce`), nas usinas e contratos o percentual saia do par em GWh e a
         sobra do arredondamento entrava depois dele (corrigido em `2a1efa5`). O executivo agora para se algum percentual nao
         fechar com o par da propria linha. O `potencial_escopo` do Complexo fica no executivo: a legenda diz o mesmo. */
      const o = { potencial_mwh: s.potencial_mwh, cortado_mwh: s.cortado_mwh, corte_pct: s.corte_pct, horas_restricao: s.horas_restricao };
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

/* ---- TEMPO REAL AMPLIADO (02/10/2026): o que as telas "Ao vivo" e "Estado das fontes" mostram ----
   medidores     portal_vivo.saude: quantos dos 24 medidores estao em dia e QUAIS nao estao;
   rendimento    portal_vivo.rendimento: MWh e MWh por MW instalado de cada usina hoje;
   operador      ppc_restricao (registro da mesa do controlador de potencia): o dia de hoje e a ULTIMA ordem registrada;
   must          must_5min: o ultimo instante de hoje e o maior valor de hoje por parque, contra o contratado;
   fontes        fontes_saude: o selo de frescor de cada fonte, com o estado pela cor que o gerador dos selos ja decidiu.
   🔴 Unica conta do bloco: o MAXIMO de hoje do MUST (mecanico, sobre as linhas do dia). Irradiancia NAO entra: a estacao
      chega por export diario (D-1), e chamar isso de "agora" seria mentir sobre a idade do dado. */
const ESTADO_COR = { '#2FBF71': 'em dia', '#FF8A3D': 'atencao', '#E5484D': 'atrasada', '#8B93A1': 'informativo' };
const GRUPO_SELO = { badges_trafo: 'transformadores', badges_oleo: 'oleo dos transformadores', badges_ons: 'operador (ONS)',
  badges_way2: 'medidores', badges_inversores: 'inversores', badges_solarimetria: 'estacao solarimetrica', badges_historico: 'historico do medidor' };
function montaTempoReal(V, P, MU, F) {
  const s = V.saude || {};
  const medidores = { ok: s.ok, total: s.total, idade_min: s.idade_min, ancora: s.ancora,
    fora: (s.medidores || []).filter((m) => m.estado !== 'ok').map((m) => ({ nome: m.nome, grupo: m.grupo, idade_min: m.idade, estado: m.estado })) };
  const rendimento = { ate: V.rendimento_ate || V.hora, por_usina: (V.rendimento || []).map((r) => ({ ufv: r.ufv, mwh: r.mwh, mwh_por_mw: r.mwh_mw })) };
  const evs = P.eventos || [], ult = evs[evs.length - 1] || null, hojeP = (P.dias || []).find((d) => d.dia === V.dia) || null;
  const operador = { registro_gerado: P.gerado_em, hoje: hojeP && { dia: hojeP.dia, ordens: hojeP.eventos, ordens_com_limite: hojeP.restritos,
      primeira: hojeP.primeiro, ultima: hojeP.ultimo, menor_limite_mw: hojeP.pot_min, horas_sob_limite: hojeP.horas_restricao,
      termina_limitado: hojeP.restricao_aberta === 1, motivos: hojeP.motivo_cods },
    ultima_ordem: ult && { quando: ult.ts, limite_mw: ult.pot, limitado: ult.restr === 1, motivo: ult.motivo } };
  /* so as linhas com leitura: a serie traz os intervalos de 5 min ainda VAZIOS do fim (so os campos _c), e o "ultimo
     instante" era um desses: "as 08:40 a demanda e —" (achado em 03/10/2026) */
  const linhasHoje = (MU.serie || []).filter((r) => String(r.t).slice(0, 10) === V.dia && (MU.parques || []).some((p) => r[p] != null));
  const must = { contratos_mw: MU.contratos, instante: null, por_parque: {} };
  if (linhasHoje.length) {
    const u = linhasHoje[linhasHoje.length - 1];
    must.instante = String(u.t).slice(11, 16);
    for (const p of MU.parques || []) {
      let pico = null;
      for (const r of linhasHoje) if (r[p] != null && (!pico || r[p] > pico.v)) pico = { v: r[p], h: String(r.t).slice(11, 16) };
      must.por_parque[p] = { agora_mw: u[p], pico_hoje_mw: pico ? pico.v : null, pico_hora: pico ? pico.h : null };
    }
  }
  const fontes = [];
  for (const [k, lista] of Object.entries(F || {})) {
    if (!k.startsWith('badges_')) continue;
    (lista || []).forEach((b) => fontes.push({ grupo: GRUPO_SELO[k] || k.slice(7), item: b.l, valor: b.v, unidade: b.u || '', estado: ESTADO_COR[b.c] || 'sem estado' }));
  }
  return { medidores, rendimento, operador, must, fontes: { gerado: F && F.gerado_em, selos: fontes } };
}

/* ---- ATIVOS E SAUDE (02/10/2026): o que as telas Inversores, Confiabilidade, Transformadores e Oleo mostram ----
   inversores_dia  perdas_diario (ultimo dia fechado): parados, parciais e disponibilidade por usina e do conjunto;
   abaixo_dos_pares inv_scada.ranking: os inversores que rendem abaixo da mediana do proprio eletrocentro, ANTES de falhar;
   trocas          portal_ativos.p1 (planilha de substituicoes): total, termicas, modos, pior parque, MTBF, reposicao, estoque;
   alarmes         portal_ativos.p2 (export de alarmes do supervisorio): classes, maior emissor; com a data ate onde vai;
   transformadores trafo_diario (ultimo dia): carga maxima contra ONAF2, temperaturas que existirem;
   oleo            oleo.manchete: conformidade dos laudos, pior ensaio, gases-chave a acompanhar.
   Tudo selecao; o emoji dos modos de falha sai do texto (o assistente le em voz alta). */
const USINAS9 = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const semEmoji = (s) => String(s == null ? '' : s).replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]️?/gu, '').trim();
function montaAtivos(A, P, I, T, O) {
  const s = (P.serie || [])[(P.serie || []).length - 1] || {};
  const porUsina = {};
  USINAS9.forEach((u) => { porUsina[u] = { inversores: s[u + '_n_inv'], parados: s[u + '_inv_parados'], parciais: s[u + '_inv_parciais'], disp_pct: s[u + '_disp_pct'] }; });
  const inversores_dia = { dia: s.dia, disp_conjunto_pct: s.CX_disp_pct, disp_contrato_pct: s.CX_disp_contrato_pct, por_usina: porUsina };
  const esc = I.escopo || {};
  const abaixo = { de: esc.de, ate: esc.ate, lista: (I.ranking || []).slice(0, 10).map((r) => ({ inversor: r.chave, razao_mediana: r.razao_mediana, razao_min: r.razao_min, dias: r.dias })) };
  const p1 = A.p1 || {}, p2 = A.p2 || {}, est = (A.escopo || {}).estoque || {}, F = A.fontes || {};
  const trocas = { total: p1.total, termicas: p1.termico, termicas_pct: p1.termico_pct, desde_dias: p1.janela_dias, ultima: F.substituicoes_ultima,
    modos: (p1.por_modo || []).map((m) => ({ modo: semEmoji(m.modo), n: m.n, termico: !!m.termico })),
    pior_parque: p1.pior_parque && { parque: p1.pior_parque.parque, trocas: p1.pior_parque.n, por_100_inversores: p1.pior_parque.taxa_100 },
    mtbf_anos: p1.mtbf_anos, consumo_mensal: p1.consumo_mensal, reposicao_mesmo_dia_pct: (p1.reposicao || {}).pct_mesmo_dia, reposicao_max_dias: (p1.reposicao || {}).max_dias,
    estoque: { novos: est.novo, reparados: est.reparado, total: est.total, cobertura_meses: est.cobertura_meses } };
  const alarmes = { ate_mes: F.alarmes_ultimo_mes, eventos: p2.eventos, falha_inversor: p2.falha_inversor, rede: p2.rede, aviso: p2.aviso, rede_pct: p2.rede_pct,
    classes: (p2.por_classe || []).map((c) => ({ classe: c.classe, n: c.n, pct: c.pct })), maior_emissor: p2.bad_actor && { inversor: p2.bad_actor.inv, alarmes: p2.bad_actor.n },
    mtba_dias: p2.mtba_dias };
  const ts = (T.serie || [])[(T.serie || []).length - 1] || {};
  const onaf2 = ((T.placa || {}).potencia_at_mva || {}).onaf2;
  const trafos = {};
  (T.trafos || []).forEach((k) => {
    const o = { s_max_mva: ts[k + '_s_max'], carga_max_pct: ts[k + '_carga_pct_max'], p_max_mw: ts[k + '_p_max'] };
    const tO = ts[k + '_t_oleo_max'], tE = ts[k + '_t_enrol_max'];
    /* a imagem termica do enrolamento e o topo do oleo MAIS o gradiente: enrolamento abaixo do oleo nao e fisico. No 04T2
       e assim todo dia desde 21/09 (AnIn30/AnIn32 trocados entre o export e a lista de pontos, ou o canal do oleo lendo
       errado; a conferir em campo). Enquanto for assim, nenhuma das duas sai como fato: o resumo diz "em verificacao".
       A regra le o dado, entao as temperaturas voltam sozinhas quando os canais forem corrigidos. */
    if (tO != null && tE != null && tE < tO) o.temperatura_em_verificacao = true;
    else {
      if (tO != null) o.t_oleo_max_c = tO;
      if (tE != null) o.t_enrolamento_max_c = tE;
    }
    trafos[k] = o;
  });
  const transformadores = { dia: ts.dia, referencia_mva: onaf2, referencia: 'ONAF2', por_trafo: trafos };
  const m = O.manchete || {};
  const oleo = { campanha: O.camp_atual_rot, campanhas: m.campanhas, laudos: m.laudos, conforme: m.conforme, nao_conformes: O.nao_conformes, texto: m.texto,
    pior_ensaio: m.pior_ensaio, pior_uso_pct: m.pior_uso, pior_margem_pct: m.pior_margem, pior_unidade: m.pior_unidade,
    gases_a_acompanhar: (O.gases_chave || []).map((x) => ({ unidade: x.unidade, gas: x.gas, ppm: x.ppm, indica: x.indica })) };
  return { inversores_dia, abaixo_dos_pares: abaixo, trocas, alarmes, transformadores, oleo };
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
  const T = R.tempo_real;
  if (!T) mau.push('tempo real: bloco ausente');
  else {
    if (T.medidores.total !== 24) mau.push('tempo real: ' + T.medidores.total + ' medidores em vez de 24');
    if (T.rendimento.por_usina.length !== 9) mau.push('tempo real: rendimento de ' + T.rendimento.por_usina.length + ' usinas');
    if (!T.operador.ultima_ordem) mau.push('tempo real: sem ordem da mesa');
    if (!T.fontes.selos.length) mau.push('tempo real: sem selos de frescor');
  }
  const DS = R.desempenho;
  if (!DS) mau.push('desempenho: bloco ausente');
  else {
    if (!DS.pr.meses.length || !DS.pr.meses.some((m) => m.pr_pct != null)) mau.push('desempenho: PR do conjunto sem mes');
    ENT_DESEMPENHO.forEach((e) => { if (!(DS.pr.por_entidade[e] || []).length) mau.push('desempenho: PR sem ' + e); });
    if (!DS.disponibilidade.meses.length) mau.push('desempenho: disponibilidade declarada sem mes');
    USINAS9.forEach((u) => { if (!(DS.disponibilidade.inversores[u] || []).length) mau.push('desempenho: disponibilidade dos inversores sem ' + u); });
  }
  const AT = R.ativos;
  if (!AT) mau.push('ativos: bloco ausente');
  else {
    USINAS9.forEach((u) => { if (!AT.inversores_dia.por_usina[u] || AT.inversores_dia.por_usina[u].parados == null) mau.push('ativos: sem o dia de inversores do ' + u); });
    if (!AT.abaixo_dos_pares.lista.length) mau.push('ativos: lista dos abaixo dos pares vazia');
    if (!AT.trocas.total) mau.push('ativos: sem trocas');
    if (Object.keys(AT.transformadores.por_trafo).length !== 2) mau.push('ativos: transformadores ' + Object.keys(AT.transformadores.por_trafo).length + ' em vez de 2');
    if (AT.oleo.laudos == null) mau.push('ativos: sem laudos de oleo');
  }
  const kb = Buffer.byteLength(JSON.stringify(R)) / 1024;
  if (kb > TETO_KB) mau.push('tamanho ' + kb.toFixed(1) + ' KB acima do teto de ' + TETO_KB);
  return { mau, kb };
}

/* ---- DESEMPENHO (03/10/2026): o que a tela de Performance e a de Disponibilidade mostram ----
   pr.meses           pr.json (conjunto no 230 kV): os ultimos MESES_PR meses, PR com o corte dentro e corrigido pelo corte,
                      com a energia e a irradiacao do mes (o ensaio refaz o PR por elas: a conta nao e circular);
   pr.por_entidade    pr_ufv.json (usinas e contratos, circuitos de 34,5 kV): os ultimos MESES_PR_ENT meses, com energia e
                      denominador (placa x irradiacao da estacao da usina);
   disponibilidade    executivo.serie (declarada ao operador, so o conjunto) e executivo.serie_ufv.disp_inv_pct (contadores
                      dos inversores, por usina e grupo).
   Tudo selecao. O PR GARANTIDO do contrato de O&M nao entra: ele nao vai para o blob publico (fica na pagina do portal). */
const MESES_PR = 7, MESES_PR_ENT = 3;   /* teto do resumo (TETO_KB): 3 meses por entidade bastam para "o mes passado" e o em curso */
const ENT_DESEMPENHO = USINAS9.concat(['PPA', 'ML']);
const LBL_MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const lblDe = (mes) => LBL_MES[Number(mes.slice(5, 7)) - 1] + '/' + mes.slice(2, 4);
function montaDesempenho(PR, PU, X) {
  const pm = (PR.meses || []).slice(-MESES_PR).map((m) => ({ mes: m.mes, lbl: lblDe(m.mes), pr_pct: m.pr_pct, pr_corrigido_pct: m.pr_corrigido_pct,
    dias_validos: m.dias_validos, dias_no_mes: m.dias_no_mes, inj_mwh: m.inj_mwh, h_kwh_m2: m.h_kwh_m2 }));
  const ud = (PR.dias || []).filter((d) => d.pr_pct != null).slice(-1)[0];
  const porEnt = {};
  ENT_DESEMPENHO.forEach((e) => {
    const E = (PU.entidades || {})[e]; if (!E) return;
    porEnt[e] = (E.meses || []).slice(-MESES_PR_ENT).map((m) => ({ mes: m.mes, pr_pct: m.pr_pct, pr_corrigido_pct: m.pr_corrigido_pct,
      dias_validos: m.dias_validos, inj_mwh: m.inj_mwh, den_mwh: m.den_mwh }));
  });
  const S = (X.serie || []).slice(-MESES_PR);
  const inv = {};
  ['Complexo'].concat(ENT_DESEMPENHO).forEach((e) => {
    const L = (X.serie_ufv || []).filter((r) => r.ufv === e && r.disp_inv_pct != null).slice(-MESES_PR_ENT);
    if (L.length) inv[e] = L.map((r) => ({ mes: r.mes, pct: r.disp_inv_pct, dias: r.disp_inv_dias }));
  });
  return {
    pr: { p_cc_mwp: PR.p_cc_mwp, ultimo_dia: ud ? { dia: ud.dia, pr_pct: ud.pr_pct, pr_corrigido_pct: ud.pr_corrigido_pct } : null, meses: pm, por_entidade: porEnt },
    disponibilidade: { meses: S.map((s) => ({ mes: s.mes, lbl: s.lbl, declarada_pct: s.disp_pct })), inversores: inv },
  };
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
  const [V, X, P, MU, F, AT, PD, IS, TD, OL, PR, PU] = await Promise.all(['portal_vivo.json', 'executivo.json', 'ppc_restricao.json', 'must_5min.json',
    'fontes_saude.json', 'portal_ativos.json', 'perdas_diario.json', 'inv_scada.json', 'trafo_diario.json', 'oleo.json', 'pr.json', 'pr_ufv.json'].map((n) => puxa(BASE + n)));
  const R = monta(V, X);
  R.tempo_real = montaTempoReal(V, P, MU, F);
  R.ativos = montaAtivos(AT, PD, IS, TD, OL);
  R.desempenho = montaDesempenho(PR, PU, X);
  const { mau, kb } = guarda(R);
  if (mau.length) { console.error('agente_om: NAO gravado\n  ' + mau.join('\n  ')); process.exit(1); }
  await grava(R);
  console.log('agente_om: ' + kb.toFixed(1) + ' KB · agora ' + R.agora.hora + ' · mes ' + R.mes_em_curso.lbl
    + ' · fechados ' + R.meses_fechados.map((m) => m.lbl).join(', ') + ' · ano ' + R.ano.ano + ' ate ' + R.ano.meses_fechados_ate);
}

module.exports = { monta, montaTempoReal, montaAtivos, montaDesempenho, guarda, ENTIDADES, MESES_FECHADOS, DIAS_CORTE };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
