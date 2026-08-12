/*
 * gen-benchmark-ons.js — dados/benchmark_ne.json : o corte do Mauriti contra o SUBSISTEMA NORDESTE
 * inteiro, solar e eolico, mes a mes, pelo MESMO criterio nos tres.
 *
 * POR QUE EXISTE: o painel executivo comparava o Mauriti com a regiao usando TRES NUMEROS COLADOS no
 * gen-executivo.js (MAURITI 21,20 · NORDESTE 26,80 · ABAIARA 21,32), apurados uma vez fora do pipeline
 * numa janela mar-jul/26 e congelados desde entao. Numero colado apodrece: a janela passou, o mes
 * virou, e o painel seguiu anunciando o mesmo valor. Aqui eles passam a ser calculados.
 *
 * FONTE (dados abertos do ONS, CSV mensal, `;` como separador, semi-hora):
 *   solar   restricao_coff_fotovoltaica_tm/RESTRICAO_COFF_FOTOVOLTAICA_<AAAA_MM>.csv    ~13 MB/mes
 *   eolico  restricao_coff_eolica_tm/RESTRICAO_COFF_EOLICA_<AAAA_MM>.csv                ~35 MB/mes
 * Os dois tem as MESMAS colunas, o que e o que torna a comparacao legitima:
 *   id_subsistema;nom_subsistema;id_estado;nom_estado;nom_usina;id_ons;ceg;din_instante;
 *   val_geracao;val_geracaolimitada;val_disponibilidade;val_geracaoreferencia;
 *   val_geracaoreferenciafinal;cod_razaorestricao;cod_origemrestricao;dsc_restricao
 * Nivel CONJUNTO (nao usina): em jul/26 o NE tem 55 conjuntos solares e 138 eolicos.
 * O Mauriti e o conjunto CJU_CEMTD ("CONJ. MAURITI") — sai do MESMO arquivo que a regiao, de proposito:
 * comparar o nosso numero de uma fonte com o da regiao de outra seria comparar criterio, nao desempenho.
 *
 * CRITERIO — o mesmo da casa, e as DUAS convencoes, porque elas divergem e a diferenca importa:
 *   frustrada = Σ max(0, (gref − ger) × H)  nos intervalos com limitacao registrada
 *   `preenchido`  val_geracaolimitada NAO vazio, INCLUSIVE zero  <- a convencao da apuracao auditada
 *   `maior_zero`  val_geracaolimitada > 0                        <- a que o gen-executivo.js usa hoje
 * Limitacao a ZERO e limitacao real (o ONS mandou parar), e e justamente ela que as duas tratam
 * diferente. Publicar as duas deixa a escolha explicita em vez de escondida numa comparacao.
 *
 * JANELA: jan/2026 em diante — decisao do usuario, todas as analises do painel executivo tem jan/26
 * como referencia.
 *
 * MEMORIA: le em STREAMING, linha a linha. Sao ~390 MB por rodada somando os dois arquivos de oito
 * meses; nada disso fica em memoria nem e versionado — so o resumo mensal, que da alguns KB.
 *
 * Env: DADOS_STORAGE (RW no container dados) · LOCAL_OUT p/ teste · MESES p/ limitar a janela.
 */
const https = require('https'), readline = require('readline'), zlib = require('zlib');
const ONS = 'https://ons-aws-prod-opendata.s3.amazonaws.com/dataset/';
const FONTES = [
  { id: 'solar', dir: 'restricao_coff_fotovoltaica_tm', arq: 'RESTRICAO_COFF_FOTOVOLTAICA' },
  { id: 'eolico', dir: 'restricao_coff_eolica_tm', arq: 'RESTRICAO_COFF_EOLICA' },
];
const SUB = 'NE';                 // subsistema Nordeste
// Os conjuntos que saem NOMEADOS do mesmo arquivo da regiao. Tirar os dois daqui, e nao de fontes
// diferentes, e o que torna a comparacao legitima. `abaiara` entra porque o painel compara com ele e o
// valor dele tambem estava colado — os tres numeros tem de se destravar juntos ou a comparacao nao vale.
const CONJ = { CJU_CEMTD: 'nosso', CJU_CEAB2: 'abaiara' };   // CONJ. MAURITI · CONJ. ABAIARA 230 KV
const H = 0.5;                    // intervalo do ONS = 30 min
// DIAS EM QUE O ONS PUBLICOU IMPOSSIVEL PARA O NOSSO CONJUNTO: em 03/03 e 11/03 ele reporta 70% e 77%
// MAIS geracao do que o medidor de faturamento Way2 registrou. Isso infla o gerado, afunda o percentual
// de corte e faz o mes de marco sair 0,90 GWh acima da apuracao auditada do gen-executivo.js — dois
// numeros para a mesma coisa na mesma pagina.
// SO PARA `nosso`, de proposito: o defeito e na publicacao do CJU_CEMTD, nao no no nem na regiao. Tirar
// dois dias BONS do Nordeste e do Abaiara para casar com um defeito do nosso arquivo seria introduzir
// erro, nao remover. O custo e marco apurado em 29 dias do nosso lado e 31 dos outros; num PERCENTUAL
// (que e uma taxa) isso e de segunda ordem, e e a mesma escolha de denominador honesto que o
// gen-executivo.js ja faz.
const DIAS_EXCLUIDOS = new Set(['2026-03-03', '2026-03-11']);

// ---------------------------------------------------------------------------------------------------
// JAN e FEV/2026 — corte MODELADO com irradiancia, disponibilidade e geracao PROPRIAS.
//
// Nesses dois meses o `val_geracaoreferencia` do ONS e fisicamente impossivel, e da para provar sem
// modelo nenhum: nos patamares SEM restricao a referencia tem de bater com a geracao (sem corte, a
// referencia E o que a usina produziu). Medido contra o medidor de faturamento Way2:
//     jan gref/ger = 0,790   fev 0,884   |   mar 0,998   abr 1,039   mai 1,031   jun 1,004
// Janeiro publica 21% menos referencia do que gerou; fevereiro, 12% menos. Marco a junho fecham.
//
// COMO O NUMERO FOI OBTIDO (analise fora do pipeline, `scratchpad/modelo_v5.js`):
//   irradiancia  GTI no plano dos modulos, 9 estacoes, media ponderada por capacidade  (pacote NT-ONS)
//   disponibilidade  POT = inversores disponiveis x kW/UG, por patamar                 (pacote NT-ONS)
//   geracao      medidor do COMPLEXO no Way2 (ponto 6233) — uma medicao so, imune a rateio de circuito
//   quando       bandeira `val_geracaolimitada > 0` do ONS, que esta INTEGRA em jan e fev
//   modelo       rendimento = ger / (GTI x fracao_disponivel), mediana por faixa de 100 W/m2,
//                calibrado SO nos patamares sem restricao DO PROPRIO MES, com teto na potencia
//                disponivel. corte = Σ max(0, previsto − real) x 0,5 h nos patamares com limitacao.
//
// EXATIDAO MEDIDA, e ela NAO e boa: validado contra os quatro meses em que o ONS mediu o corte deu
//     mar +34,3%   abr −11,1%   mai −12,0%   jun −4,2%   (erro medio 15,4%)
// Sem marco o erro cai para 9,1% e e sempre para MENOS — o modelo subestima. A causa da fragilidade e
// estrutural e esta medida: o corte e a diferenca entre dois numeros grandes, e em marco o potencial
// nos patamares restritos e ~63 GWh contra 14,6 de corte, entao o vies e amplificado 4,3x. Para o corte
// sair a ±5% o potencial teria de acertar a ~1%.
//
// POR QUE MESMO ASSIM VAI PARA O PAINEL: quatro variantes independentes (geracao do SCADA, do Way2, com
// e sem recalibracao) puseram janeiro entre 17,2 e 18,4 GWh — a ordem de grandeza resiste a troca de
// fonte. E a alternativa em uso, a razao do vizinho Abaiara, poe janeiro em 10,81 GWh, que e ~60% menor
// e nao tem nenhuma medicao propria por tras. Vai em SERIE e COR SEPARADAS, nunca na coluna do medido.
const MODELADO = {
  '2026-01': { gwh: 18.38, pct: 24.58, gerado: 56.37 },
  '2026-02': { gwh: 7.89, pct: 13.39, gerado: 51.06 },
};
const MODELADO_METODO = 'Corte MODELADO com dados proprios: irradiancia no plano dos modulos das 9 '
  + 'estacoes, disponibilidade por inversor e geracao do medidor de faturamento Way2 (ponto do '
  + 'complexo), nos patamares que o ONS marcou com limitacao. O ONS publica para estes dois meses uma '
  + 'referencia menor que a propria geracao verificada (jan 79%, fev 88% da gerada nos patamares SEM '
  + 'restricao), o que e fisicamente impossivel e zera a apuracao normal. Validado nos quatro meses de '
  + 'referencia valida: erro medio 15,4% (mar +34,3 · abr -11,1 · mai -12,0 · jun -4,2), tendencia a '
  + 'SUBESTIMAR fora de marco. Numero de ordem de grandeza, nao de precisao contabil.';
const INI_Y = 2026, INI_M = 1;    // jan/26 = referencia do painel executivo
const OUT_CONTAINER = process.env.OUT_CONTAINER || 'dados';
const OUT_BLOB = process.env.OUT_BLOB || 'benchmark_ne.json';
const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);

function meses() {
  const n = new Date(), ny = n.getUTCFullYear(), nm = n.getUTCMonth() + 1, o = [];
  let y = INI_Y, m = INI_M;
  while (y < ny || (y === ny && m <= nm)) { o.push(y + '_' + String(m).padStart(2, '0')); m++; if (m > 12) { m = 1; y++; } }
  return o;
}

// acumulador: um por (fonte, mes, quem). `quem` = 'NE' (a regiao) ou 'MAURITI'.
const novo = () => ({ ger: 0, gref: 0, fru_p: 0, fru_z: 0, n: 0, n_lim_p: 0, n_lim_z: 0, conj: new Set(),
  dias: new Set(), n_excl: 0 });

function linhas(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 600000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      res(readline.createInterface({ input: cru, crlfDelay: Infinity }));
    }).on('error', rej);
  });
}

async function leMes(f, mo, acc) {
  const rl = await linhas(ONS + f.dir + '/' + f.arq + '_' + mo + '.csv');
  let cab = null, iSub, iUsi, iOns, iTs, iGer, iLim, iGref, n = 0;
  for await (const l of rl) {
    if (!l) continue;
    const c = l.replace(/^﻿/, '').split(';');
    if (!cab) {
      cab = c.map(x => x.trim());
      iSub = cab.indexOf('id_subsistema'); iUsi = cab.indexOf('nom_usina'); iOns = cab.indexOf('id_ons');
      iTs = cab.indexOf('din_instante'); iGer = cab.indexOf('val_geracao');
      iLim = cab.indexOf('val_geracaolimitada'); iGref = cab.indexOf('val_geracaoreferencia');
      if ([iSub, iOns, iTs, iGer, iLim, iGref].some(i => i < 0)) throw new Error('layout mudou em ' + f.id + ' ' + mo);
      continue;
    }
    if (c[iSub] !== SUB) continue;                       // so o Nordeste
    const mes = String(c[iTs]).slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(mes)) continue;
    const ger = Number(String(c[iGer] || '').replace(',', '.')) || 0;
    const gref = Number(String(c[iGref] || '').replace(',', '.')) || 0;
    const limTxt = String(c[iLim] == null ? '' : c[iLim]).trim();
    const temLim = limTxt !== '';                        // PREENCHIDO, inclusive zero
    const limNum = Number(limTxt.replace(',', '.')) || 0;
    const perda = Math.max(0, (gref - ger) * H);
    const alvos = [[f.id, mes, 'NE']];
    if (CONJ[c[iOns]]) alvos.push([f.id, mes, CONJ[c[iOns]]]);
    const dia = String(c[iTs]).slice(0, 10);
    for (const [fo, me, quem] of alvos) {
      const k = fo + '|' + me + '|' + quem;
      const a = acc[k] || (acc[k] = novo());
      if (quem === 'nosso' && DIAS_EXCLUIDOS.has(dia)) { a.n_excl++; continue; }   // ver DIAS_EXCLUIDOS
      a.ger += ger * H; a.gref += gref * H; a.n++; a.conj.add(c[iOns]); a.dias.add(dia);
      if (temLim) { a.fru_p += perda; a.n_lim_p++; }
      if (limNum > 0) { a.fru_z += perda; a.n_lim_z++; }
    }
    n++;
  }
  return n;
}

async function grava(obj) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) { require('fs').writeFileSync(process.env.LOCAL_OUT, json); return json.length; }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE; if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(OUT_BLOB).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=900' } });
  return json.length;
}

(async () => {
  const MS = process.env.MESES ? process.env.MESES.split(',') : meses();
  const acc = {}, faltou = [];
  for (const f of FONTES) {
    for (const mo of MS) {
      try { const n = await leMes(f, mo, acc); console.log('  ' + f.id + ' ' + mo + '  ' + n + ' linhas NE'); }
      catch (e) { faltou.push(f.id + ' ' + mo + ' (' + e.message.slice(0, 40) + ')'); }
    }
  }
  // ---- serie mensal: uma linha por (mes, fonte), regiao e os conjuntos nomeados lado a lado ----
  const serie = [];
  const chaves = [...new Set(Object.keys(acc).map(k => k.split('|').slice(0, 2).join('|')))].sort();
  const pct = a => (a && (a.ger + a.fru_p) > 0) ? r2(100 * a.fru_p / (a.ger + a.fru_p)) : null;
  const pctZ = a => (a && (a.ger + a.fru_z) > 0) ? r2(100 * a.fru_z / (a.ger + a.fru_z)) : null;
  for (const ch of chaves) {
    const [fonte, mes] = ch.split('|');
    const ne = acc[ch + '|NE'];
    const l = {
      mes: mes.replace('_', '-'), mes_ts: mes.replace('_', '-') + '-01T00:00:00Z', fonte,
      ne_gerado_gwh: r2(ne.ger / 1000), ne_cortado_gwh: r2(ne.fru_p / 1000),
      ne_cortado_gwh_maior_zero: r2(ne.fru_z / 1000),
      ne_corte_pct: pct(ne), ne_corte_pct_maior_zero: pctZ(ne),
      ne_ref_gwh: r2(ne.gref / 1000), ne_conjuntos: ne.conj.size, intervalos: ne.n,
    };
    // um bloco por conjunto nomeado (nosso, abaiara): mesmas colunas, mesmo criterio
    for (const pref of Object.values(CONJ)) {
      const a = acc[ch + '|' + pref];
      l[pref + '_gerado_gwh'] = a ? r2(a.ger / 1000) : null;
      l[pref + '_cortado_gwh'] = a ? r2(a.fru_p / 1000) : null;
      l[pref + '_cortado_gwh_maior_zero'] = a ? r2(a.fru_z / 1000) : null;
      l[pref + '_corte_pct'] = pct(a);
      l[pref + '_corte_pct_maior_zero'] = pctZ(a);
      l[pref + '_ref_gwh'] = a ? r2(a.gref / 1000) : null;
      l[pref + '_intervalos_com_lim'] = a ? a.n_lim_p : null;
      l[pref + '_dias'] = a ? a.dias.size : null;
      l[pref + '_intervalos_excluidos'] = a ? a.n_excl : null;
      // TESTE FISICO: a referencia do ONS nao pode ficar ABAIXO da geracao verificada — usina nao
      // entrega mais do que a propria referencia. Quando acontece, `max(0, gref-ger)` zera em quase
      // todo intervalo e o corte sai artificialmente baixo. Em jan/26 o nosso conjunto publica 28.368
      // MWh de referencia contra 57.230 gerados: metade. E a mesma doenca do `ge` antes de mar/26,
      // agora na referencia. Nao e heuristica de valor, e impossibilidade fisica.
      l[pref + '_ref_suspeita'] = (a && a.gref < a.ger) ? 1 : 0;
    }
    serie.push(l);
  }

  // ---- ESTIMATIVA dos meses com a referencia quebrada -------------------------------------
  // Metodo: a razao entre o corte do conjunto e o do subsistema e estavel nos meses de dado bom.
  // Aplico essa razao a taxa regional do mes quebrado. Escolhi isso em vez da taxa regional cheia
  // porque usa a relacao MEDIDA daquele conjunto com a regiao, em vez de assumir que ele se comporta
  // como a media — e a pagina existe justamente para mostrar que nao se comporta.
  //
  // MEDIDO E ESTIMADO VAO EM COLUNAS SEPARADAS, nao no mesmo campo: assim o grafico mostra a diferenca
  // sozinho, com cor e legenda proprias, e nao depende de ninguem ler a descricao. Um numero estimado
  // nunca ocupa a coluna do medido.
  const estim = [];
  for (const fo of [...new Set(serie.map(x => x.fonte))]) {
    for (const pref of Object.values(CONJ)) {
      const A = serie.filter(x => x.fonte === fo && x[pref + '_corte_pct'] != null);
      // QUAL BASE? Escolhida por estabilidade MEDIDA, nao por intuicao. Nos seis meses de dado bom:
      //   base ABAIARA   razao media 0,997  CV 14,6%  faixa 0,784-1,269
      //   base NORDESTE  razao media 0,790  CV 18,4%  faixa 0,575-1,030
      // O Abaiara ganha, e tem razao FISICA para ganhar: e o conjunto vizinho no MESMO no de 230 kV,
      // entao sofre praticamente a mesma restricao — a razao dar ~1,0 nao e coincidencia. E ele tem
      // referencia VALIDA em jan e fev, quando a nossa esta quebrada, o que tambem mostra que o defeito
      // e da publicacao do NOSSO conjunto e nao do no.
      // O Nordeste fica como reserva: se o par tambem estiver suspeito no mes, cai para a regiao.
      const par = pref === 'nosso' ? 'abaiara' : null;
      const usaPar = par && A.some(x => x[pref + '_ref_suspeita'] && x[par + '_corte_pct'] > 0);
      const baseCol = usaPar ? par + '_corte_pct' : 'ne_corte_pct';
      const baseNome = usaPar ? 'Conj. Abaiara 230 kV, o vizinho no mesmo no' : 'subsistema Nordeste';
      const bons = A.filter(x => !x[pref + '_ref_suspeita'] && x[baseCol] > 0)
        .map(x => x[pref + '_corte_pct'] / x[baseCol]).sort((a, b) => a - b);
      // as colunas existem em TODA linha, mesmo vazias: coluna que aparece e desaparece faz o Grafana
      // perder a serie entre um mes e outro
      A.forEach(x => { x[pref + '_corte_pct_est'] = null; x[pref + '_cortado_gwh_est'] = null; });
      if (!bons.length) continue;
      const razao = bons.length % 2 ? bons[(bons.length - 1) / 2]
        : (bons[bons.length / 2 - 1] + bons[bons.length / 2]) / 2;
      A.filter(x => x[pref + '_ref_suspeita']).forEach(x => {
        if (!(x[baseCol] > 0)) return;                    // sem base valida no mes, nao inventa
        const pe = r2(x[baseCol] * razao);
        // o BRUTO do ONS sai da coluna do medido: ele nao mede corte, mede um gref quebrado
        x[pref + '_corte_pct_bruto'] = x[pref + '_corte_pct'];
        x[pref + '_cortado_gwh_bruto'] = x[pref + '_cortado_gwh'];
        x[pref + '_corte_pct'] = null;
        x[pref + '_cortado_gwh'] = null;
        x[pref + '_corte_pct_est'] = pe;
        // do percentual de volta para energia com o gerado do mes: corte = ger * p/(100-p)
        x[pref + '_cortado_gwh_est'] = (pe != null && pe < 100 && x[pref + '_gerado_gwh'] != null)
          ? r2(x[pref + '_gerado_gwh'] * pe / (100 - pe)) : null;
        x[pref + '_estimado'] = 1;
        x[pref + '_estimado_base'] = baseNome;
        x[pref + '_estimado_razao'] = r2(razao);
        x[pref + '_estimado_metodo'] = 'A referencia do ONS neste mes vem ABAIXO da geracao verificada, '
          + 'o que e fisicamente impossivel e zera o calculo de corte. Estimado pela razao mediana entre '
          + 'o corte deste conjunto e o do ' + baseNome + ', medida em ' + bons.length + ' meses de dado '
          + 'consistente (' + r2(razao) + '). Bruto do ONS em ' + pref + '_corte_pct_bruto.';
        estim.push(fo + ' ' + x.mes + ' ' + pref); });
    }
  }
  // ---- corte MODELADO de jan e fev (ver o bloco MODELADO no topo) --------------------------------
  // Colunas PROPRIAS, presentes em toda linha mesmo vazias: coluna que aparece e some faz o Grafana
  // perder a serie entre um mes e outro. Um modelado NUNCA ocupa a coluna do medido.
  serie.forEach(x => {
    const M = x.fonte === 'solar' ? MODELADO[x.mes] : null;
    x.nosso_cortado_gwh_modelo = M ? M.gwh : null;
    x.nosso_corte_pct_modelo = M ? M.pct : null;
    if (M) { x.nosso_modelo_metodo = MODELADO_METODO; x.nosso_modelo_gerado_gwh = M.gerado; }
  });

  // a vantagem usa o valor VALIDO do mes, medido ou estimado, e diz qual dos dois foi
  serie.forEach(x => {
    const p = x.nosso_corte_pct != null ? x.nosso_corte_pct : x.nosso_corte_pct_est;
    x.nosso_corte_pct_final = p;
    x.vantagem_pp = (p != null && x.ne_corte_pct != null) ? r2(p - x.ne_corte_pct) : null;
    x.base = x.nosso_corte_pct != null ? 'medido' : (p != null ? 'estimado' : 'sem dado');
  });

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'ONS Dados Abertos — restricao_coff_fotovoltaica_tm e restricao_coff_eolica_tm, nivel CONJUNTO, '
      + 'subsistema Nordeste, resolucao semi-hora.',
    criterio: 'frustrada = Σ max(0, (val_geracaoreferencia − val_geracao) × 0,5 h) nos intervalos com '
      + 'val_geracaolimitada PREENCHIDO, inclusive zero. Percentual = frustrada / (gerado + frustrada). '
      + 'A variante *_maior_zero usa val_geracaolimitada > 0, que e a convencao do gen-executivo.js — as '
      + 'duas divergem exatamente nos intervalos de limitacao a ZERO, e por isso vao as duas.',
    janela: 'jan/2026 em diante — referencia de todas as analises do painel executivo',
    estimativa: 'Mes com referencia do ONS abaixo da geracao verificada tem o corte ESTIMADO pela '
      + 'razao mediana entre o nosso corte e o do subsistema nos meses sadios. Vem com estimado=1, '
      + 'estimado_metodo e o valor bruto ao lado. Nunca um estimado se passando por medido.',
    meses_estimados: estim,
    conjuntos: CONJ, subsistema: SUB, serie,
  };
  if (faltou.length) out.meses_sem_arquivo = faltou;
  const t = await grava(out);
  console.log('\nbenchmark_ne.json OK · ' + Math.round(t / 1024) + ' KB · ' + serie.length + ' linhas'
    + (faltou.length ? ' · sem arquivo: ' + faltou.join(', ') : ''));
  if (estim.length) console.log('  estimados: ' + estim.join(' · '));
  serie.filter(x => x.fonte === 'solar').forEach(x => console.log('  solar  ' + x.mes
    + '  NE ' + String(x.ne_corte_pct).padStart(6) + '%  nosso ' + String(x.nosso_corte_pct_final).padStart(6)
    + '% (' + x.base + ')  abaiara ' + String(x.abaiara_corte_pct != null ? x.abaiara_corte_pct
      : x.abaiara_corte_pct_est).padStart(6) + '%  vantagem ' + String(x.vantagem_pp).padStart(6) + ' pp'));
  serie.filter(x => x.fonte === 'eolico').forEach(x => console.log('  eolico ' + x.mes
    + '  NE ' + String(x.ne_corte_pct).padStart(6) + '%  ' + String(x.ne_cortado_gwh).padStart(8)
    + ' GWh  ' + x.ne_conjuntos + ' conjuntos'));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
