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
const NOSSO = 'CJU_CEMTD';        // CONJ. MAURITI
const H = 0.5;                    // intervalo do ONS = 30 min
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
const novo = () => ({ ger: 0, gref: 0, fru_p: 0, fru_z: 0, n: 0, n_lim_p: 0, n_lim_z: 0, conj: new Set() });

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
    if (c[iOns] === NOSSO) alvos.push([f.id, mes, 'MAURITI']);
    for (const [fo, me, quem] of alvos) {
      const k = fo + '|' + me + '|' + quem;
      const a = acc[k] || (acc[k] = novo());
      a.ger += ger * H; a.gref += gref * H; a.n++; a.conj.add(c[iOns]);
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
  // serie mensal: uma linha por (mes, fonte), com a regiao e o nosso lado a lado
  const serie = [];
  const chaves = [...new Set(Object.keys(acc).map(k => k.split('|').slice(0, 2).join('|')))].sort();
  for (const ch of chaves) {
    const [fonte, mes] = ch.split('|');
    const ne = acc[ch + '|NE'], nos = acc[ch + '|MAURITI'];
    const pct = a => (a && (a.ger + a.fru_p) > 0) ? r2(100 * a.fru_p / (a.ger + a.fru_p)) : null;
    const pctZ = a => (a && (a.ger + a.fru_z) > 0) ? r2(100 * a.fru_z / (a.ger + a.fru_z)) : null;
    serie.push({
      mes: mes.replace('_', '-'), mes_ts: mes.replace('_', '-') + '-01T00:00:00Z', fonte,
      ne_gerado_gwh: r2(ne.ger / 1000), ne_cortado_gwh: r2(ne.fru_p / 1000),
      ne_corte_pct: pct(ne), ne_corte_pct_maior_zero: pctZ(ne), ne_conjuntos: ne.conj.size,
      nosso_gerado_gwh: nos ? r2(nos.ger / 1000) : null,
      nosso_cortado_gwh: nos ? r2(nos.fru_p / 1000) : null,
      nosso_corte_pct: pct(nos), nosso_corte_pct_maior_zero: pctZ(nos),
      ne_ref_gwh: r2(ne.gref / 1000), nosso_ref_gwh: nos ? r2(nos.gref / 1000) : null,
      // TESTE FISICO: a referencia do ONS nao pode ficar ABAIXO da geracao verificada — usina nao
      // entrega mais do que a propria referencia. Quando isso acontece, `frustrada = max(0, gref-ger)`
      // zera em quase todo intervalo e o corte sai artificialmente baixo. Em jan/26 o nosso conjunto
      // tem referencia de 28.368 MWh contra 57.230 gerados: metade. E a mesma doenca do `ge` antes de
      // mar/26, agora na coluna de referencia.
      ref_suspeita: (nos && nos.gref < nos.ger) ? 1 : 0,
      intervalos: ne.n, nosso_intervalos_com_lim: nos ? nos.n_lim_p : null,
      // a vantagem em pontos percentuais: negativa = cortamos MENOS que a regiao
      vantagem_pp: (pct(nos) != null && pct(ne) != null) ? r2(pct(nos) - pct(ne)) : null,
    });
  }
  // ---- ESTIMATIVA dos meses em que a referencia do ONS esta quebrada ----------------------
  // Metodo: a razao entre o NOSSO corte e o do subsistema e estavel nos meses de dado bom (mediana
  // 0,74 nos seis meses sadios de 2026). Aplico essa razao a taxa regional do mes quebrado. Escolhi
  // isso em vez de aplicar a taxa regional cheia porque usa a NOSSA relacao medida com a regiao, em
  // vez de assumir que nos comportamos como a media — e a pagina existe justamente para mostrar que
  // nao nos comportamos. O valor bruto do ONS fica ao lado, e nada aqui se passa por medido.
  ['solar', 'eolico'].forEach(fo => {
    const A = serie.filter(x => x.fonte === fo && x.nosso_corte_pct != null);
    const bons = A.filter(x => !x.ref_suspeita && x.ne_corte_pct > 0)
      .map(x => x.nosso_corte_pct / x.ne_corte_pct).sort((a, b) => a - b);
    if (!bons.length) return;
    const razao = bons.length % 2 ? bons[(bons.length - 1) / 2]
      : (bons[bons.length / 2 - 1] + bons[bons.length / 2]) / 2;
    A.filter(x => x.ref_suspeita).forEach(x => {
      const pctE = r2(x.ne_corte_pct * razao);
      x.nosso_corte_pct_bruto = x.nosso_corte_pct;
      x.nosso_cortado_gwh_bruto = x.nosso_cortado_gwh;
      x.nosso_corte_pct = pctE;
      // do percentual de volta para energia, com o gerado do mes: corte = ger * p/(100-p)
      x.nosso_cortado_gwh = (pctE != null && pctE < 100 && x.nosso_gerado_gwh != null)
        ? r2(x.nosso_gerado_gwh * pctE / (100 - pctE)) : null;
      x.vantagem_pp = (pctE != null && x.ne_corte_pct != null) ? r2(pctE - x.ne_corte_pct) : null;
      x.estimado = 1;
      x.estimado_metodo = 'A referencia do ONS deste mes vem ABAIXO da geracao verificada, o que e '
        + 'fisicamente impossivel e zera o calculo de corte. Valor estimado aplicando a razao mediana '
        + 'entre o nosso corte e o do subsistema, medida em ' + bons.length + ' meses de dado '
        + 'consistente (' + r2(razao) + '). Bruto do ONS em nosso_corte_pct_bruto.'; });
  });
  const estim = serie.filter(x => x.estimado).map(x => x.fonte + ' ' + x.mes);

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
    nosso_conjunto: NOSSO, subsistema: SUB, serie,
  };
  if (faltou.length) out.meses_sem_arquivo = faltou;
  const t = await grava(out);
  console.log('\nbenchmark_ne.json OK · ' + Math.round(t / 1024) + ' KB · ' + serie.length + ' linhas'
    + (faltou.length ? ' · sem arquivo: ' + faltou.join(', ') : ''));
  serie.filter(x => x.fonte === 'solar').forEach(x => console.log('  solar  ' + x.mes
    + '  NE ' + String(x.ne_corte_pct).padStart(6) + '%  nosso ' + String(x.nosso_corte_pct).padStart(6)
    + '%  vantagem ' + String(x.vantagem_pp).padStart(6) + ' pp'));
  serie.filter(x => x.fonte === 'eolico').forEach(x => console.log('  eolico ' + x.mes
    + '  NE ' + String(x.ne_corte_pct).padStart(6) + '%  ' + x.ne_conjuntos + ' conjuntos'));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
