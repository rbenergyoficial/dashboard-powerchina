/*
 * gen-irradiancia.js — solarimetria do SCADA por UFV, com AS FALHAS COMO DADO.
 *
 * FONTE: export do SCADA "IIRR_<AAAAMMDD>_<HHMMSS>.csv" — `;` como separador, BOM no inicio,
 *   coluna 1 = Timestamp e as demais no padrao
 *      UFV_<PARQUE>_WS_<ESTACAO> WS <GRANDEZA>[_2]
 *   As colunas com sufixo _2 sao duplicata do proprio export e vieram VAZIAS: ignoradas.
 *   Resolucao de 30 min. No export de 08/08/2026: 365 dias exatos, 17.520 linhas, sem buraco.
 *
 * MAPEAMENTO DAS ESTACOES -> NOSSAS UFVs. Nao confiei no nome: correlacionei a irradiancia diaria
 *   de cada estacao contra a serie que ja temos por UFV, um ano de dias (r de Pearson).
 *      MRT02->M2 .924   MRT03->M3 .908   MRT04->M4 .906   MRT05->M5 .922
 *      MRT06->M6 .912   MRT09->M9 .951   MRT10->M1 .920  <- confirma o "M10 = M1" da nomenclatura
 *   RESSALVA: MRT07 e MRT08 correlacionam mais alto com M9 (.946 e .917) do que com M7 (.917) e
 *   M8 (.908). Adotei a regra do nome (MRT0n = Mn) porque e consistente e porque a serie do M9 tem
 *   defeito conhecido — mas se algum dia o M7/M8 desta fonte divergir do resto, comecar por aqui.
 *
 * FILOSOFIA: o usuario quer o dado PARA achar o que esta errado. Entao nada e descartado em
 *   silencio. Cada leitura fora da faixa fisica e CONTADA e reportada, e o agregado sai em duas
 *   versoes — bruta (tudo) e limpa (so o que passa na faixa) — para a diferenca entre as duas ser
 *   ela mesma um indicador.
 *
 * Env: DADOS_STORAGE (RW no container dados).
 *   IIRR_LOCAL  = caminho de um CSV local (carga historica e testes)
 *   IIRR_URL    = CSV cru no blob — e o modo definitivo, quando a ponte SharePoint->blob existir
 *   nenhum dos dois = republica data/irr_seed.json, o historico ja processado que vive no repo.
 *     O seed existe para o painel funcionar ANTES da automacao; assim que IIRR_URL for definida,
 *     ele deixa de ser usado e o dado passa a vir do CSV.
 */
const fs = require('fs'), https = require('https'), readline = require('readline');
const OUT_CONTAINER = 'dados', OUT_BLOB = 'irr_ufv.json';
// A serie HORARIA sai FORA do blob principal e QUEBRADA POR MES: irr_hora_<AAAA-MM>.json.
//   Fora, porque junto o arquivo dava 12 MB e toda a pagina pagaria por isso para desenhar um card.
//   Por mes, porque o Infinity BAIXA a URL e SO DEPOIS aplica o JSONata: um blob horario unico de
//   3,4 MB seria puxado em toda renderizacao do painel, inclusive no modo mensal, em que ele nao usa
//   nada dali. Com o mes na URL, o navegador puxa so o mes que esta na tela (~850 KB).
// TODO mes conhecido ganha arquivo, mesmo os sem dado horario (esboco vazio), e existe tambem
//   irr_hora_tudo.json: a URL do painel e montada por variavel, e URL que nao resolve deixa o painel
//   em ERRO VERMELHO, nao vazio.
// Janela de 120 dias, nao o ano: inspecao hora a hora se faz em dia recente.
const HORA_PRE = 'irr_hora_', HORA_DIAS = 120;

// MRT0n = Mn, e MRT10 = M1 (ver o bloco de mapeamento acima)
const EST_UFV = { MRT02: 'M2', MRT03: 'M3', MRT04: 'M4', MRT05: 'M5', MRT06: 'M6',
  MRT07: 'M7', MRT08: 'M8', MRT09: 'M9', MRT10: 'M1' };

// FAIXA FISICA de cada grandeza. Fora dela, a leitura e contada como suspeita e fica fora do
// agregado LIMPO — mas continua no agregado BRUTO e no contador de qualidade.
// Os limites vieram da fisica do local (Mauriti, 7 S), nao de gosto:
//   GTI acima de 1400 nao existe nem com reflexao; DNI nao passa da constante solar na superficie;
//   difusa acima de 600 significa que o sensor nao esta medindo difusa; modulo a 85 C ja e limite
//   de catalogo; 30 m/s e vendaval, 75 m/s e furacao categoria 4 no sertao do Ceara.
const FAIXA = {
  'IRRADIAÇÃO INCLINADA': [0, 1400], 'IRRADIAÇÃO DIFUSA': [0, 600], 'IRRADIAÇÃO DIRETA': [0, 1100],
  'IRRADIAÇÃO ALBEDO DE CIMA': [0, 1400], 'IRRADIAÇÃO ALBEDO DE BAIXO': [0, 600],
  'TAXA DE ALBEDO': [0, 100],
  'TEMPERATURA MÓDULO 1': [-5, 85], 'TEMPERATURA MÓDULO 2': [-5, 85],
  'TEMPERATURA MÓDULO 3': [-5, 85], 'TEMPERATURA MÓDULO 4': [-5, 85],
  'TEMPERATURA AMBIENTE': [5, 48], 'TEMPERATURA INTERNA': [0, 70],
  'UMIDADE RELATIVA DO AR': [0, 100], 'PONTO DE CONDENSAÇÃO': [-5, 35],
  'VELOCIDADE VENTO': [0, 30], 'DIREÇÃO VENTO': [0, 360],
  'PRECIPITAÇÃO': [0, 60],
  'SENSOR DE SUJEIRA 1': [0, 105], 'SENSOR DE SUJEIRA 2': [0, 105],
  // perda por sujeira oscila em torno de ZERO quando o modulo esta limpo, e o par de celulas nao
  // e calibrado entre si — negativo de alguns pontos e RUIDO, nao defeito. Minha faixa inicial de
  // -1 reprovava 49% das leituras do M9 e apontava "sensor suspeito" onde havia painel limpo.
  // Faixa alargada para -5: abaixo disso, sim, e inversao ou par trocado.
  'TAXA DE PERDA POR SUJEIRA 1': [-5, 25], 'TAXA DE PERDA POR SUJEIRA 2': [-5, 25],
  'TENSÃO DA BATERIA': [8, 16],
};
// as que se INTEGRAM no tempo (energia); as demais se promediam
const INTEGRA = new Set(['IRRADIAÇÃO INCLINADA', 'IRRADIAÇÃO DIFUSA', 'IRRADIAÇÃO DIRETA',
  'IRRADIAÇÃO ALBEDO DE CIMA', 'IRRADIAÇÃO ALBEDO DE BAIXO']);
const SOMA = new Set(['PRECIPITAÇÃO']);           // chuva acumula
const H_SLOT = 0.5;                               // horas por leitura (30 min)
const DIURNO = [8, 15];                           // janela de sol alto p/ contar zero suspeito

const r2 = v => (v == null || !isFinite(v) ? null : Math.round(v * 100) / 100);
const r3 = v => (v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000);

function fonteLinhas() {
  const local = process.env.IIRR_LOCAL;
  if (local) return readline.createInterface({ input: fs.createReadStream(local, 'utf8'), crlfDelay: Infinity });
  const url = process.env.IIRR_URL;
  if (!url) throw new Error('defina IIRR_URL (blob) ou IIRR_LOCAL (arquivo)');
  const { PassThrough } = require('stream');
  const pt = new PassThrough();
  https.get(url, r => { if (r.statusCode >= 300) pt.destroy(new Error('HTTP ' + r.statusCode)); else r.pipe(pt); })
    .on('error', e => pt.destroy(e));
  return readline.createInterface({ input: pt, crlfDelay: Infinity });
}

async function writeOut(obj, nome) {
  const json = JSON.stringify(obj);
  if (process.env.LOCAL_OUT) {
    // mesmo diretorio do LOCAL_OUT, mas com o nome do blob. Sem isso os dois writeOut escreviam no
    // MESMO arquivo e a serie horaria era sobrescrita pela diaria — o seed horario simplesmente nao
    // aparecia, sem erro nenhum.
    const alvo = nome
      ? process.env.LOCAL_OUT.split(/[\\/]/).slice(0, -1).concat(nome).join('/')
      : process.env.LOCAL_OUT;
    fs.writeFileSync(alvo, json); return json.length;
  }
  const { BlobServiceClient } = require('@azure/storage-blob');
  const conn = process.env.DADOS_STORAGE;
  if (!conn) throw new Error('DADOS_STORAGE nao definido');
  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(OUT_CONTAINER);
  await cont.createIfNotExists();
  await cont.getBlockBlobClient(nome || OUT_BLOB).upload(json, Buffer.byteLength(json),
    { blobHTTPHeaders: { blobContentType: 'application/json', blobCacheControl: 'public, max-age=300' } });
  return json.length;
}

// Um arquivo por mes, e cada um e o PACOTE COMPLETO do mes: a serie mensal inteira (para a visao
// "All"), os dias daquele mes e as horas daquele mes. Assim o painel de serie resolve os TRES niveis
// com UM alvo so.
// Por que um alvo so: com dois alvos, o do nivel inativo devolve [] e o Infinity responde um frame
// SEM CAMPO NENHUM — o painel trend nao acha o campo x e morre com "Unable to find field: x". E, quando
// dois alvos trazem colunas de mesmo nome, o joinByField cola o refId no nome da serie e a legenda
// vira "Módulo B". Um alvo nao tem nenhum dos dois problemas, e ainda baixa menos: o painel deixa de
// puxar o blob principal de 1,7 MB.
// Todo mes conhecido ganha arquivo, mesmo sem dado horario, e ha um "tudo" — a URL e montada por
// variavel, e URL que nao resolve deixa o painel em erro vermelho, nao vazio.
async function emiteHora(meta, linhas, mesesTodos, serieMes, serieDia) {
  const horaMes = {}, diaMes = {};
  linhas.forEach(l => (horaMes[l.mes] = horaMes[l.mes] || []).push(l));
  (serieDia || []).forEach(l => (diaMes[l.mes] = diaMes[l.mes] || []).push(l));
  const alvos = [...new Set([...(mesesTodos || []), ...Object.keys(horaMes), 'tudo'])].sort();
  let bytes = 0;
  for (const m of alvos) {
    const rows = horaMes[m] || [];
    bytes += await writeOut(Object.assign({}, meta, {
      mes: m,
      dias: [...new Set(rows.map(r => r.dia))].sort(),
      serie_mes: serieMes || [],          // completa: e o nivel "All" do painel
      serie_dia: diaMes[m] || [],         // so os dias deste mes
      serie_hora: rows,                   // so as horas deste mes
    }), HORA_PRE + m + '.json');
  }
  return { arquivos: alvos.length, bytes, comDado: Object.keys(horaMes).length, linhas: linhas.length };
}

(async () => {
  // modo seed: sem CSV nenhum, republica o historico do repo e sai
  if (!process.env.IIRR_LOCAL && !process.env.IIRR_URL) {
    const seed = 'data/irr_seed.json';
    if (!fs.existsSync(seed)) throw new Error('sem IIRR_URL/IIRR_LOCAL e sem ' + seed);
    const j = JSON.parse(fs.readFileSync(seed, 'utf8'));
    j.modo = 'seed';
    j.nota_seed = 'Historico processado do export IIRR de 08/08/2026, versionado no repo. '
      + 'Enquanto a ponte SharePoint -> blob nao existir, e esta a fonte do painel. '
      + 'Definir IIRR_URL no workflow faz o gerador voltar a ler o CSV cru.';
    const seedH = 'data/irr_hora_seed.json';
    if (fs.existsSync(seedH)) {
      const h = JSON.parse(fs.readFileSync(seedH, 'utf8'));
      const linhas = h.serie_hora || [];
      // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode
      // oferecer dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
      j.dias_hora = [...new Set(linhas.map(x => x.dia))].sort();
      const rh = await emiteHora({ gerado_em: h.gerado_em, fonte: h.fonte, resolucao_min: 60,
        nota: h.nota, ufvs: h.ufvs, modo: 'seed' }, linhas, j.meses || [],
      j.serie_mes || [], j.serie_dia || []);
      console.log('irr_hora_<mes>.json republicado do seed · ' + rh.arquivos + ' arquivos ('
        + rh.comDado + ' com dado) · ' + Math.round(rh.bytes / 1024) + ' KB · ' + rh.linhas + ' linhas');
    }
    const t = await writeOut(j);
    console.log('irr_ufv.json republicado do seed · ' + Math.round(t / 1024) + ' KB · '
      + (j.serie_dia || []).length + ' linhas diarias · ' + (j.dias_hora || []).length
      + ' dias com hora · janela ' + j.janela.ini + ' a ' + j.janela.fim);
    return;
  }
  const rl = fonteLinhas();
  let cab = null;
  const mapa = [];                 // { i, ufv, gr }
  const acc = {};                  // dia -> ufv -> gr -> {sB,nB,sL,nL,minL,maxL,fora,zd,nd}
  // acumulador HORARIO: o painel precisa descer ao dia e mostrar as 24 horas. Guardo so as
  // grandezas que se leem numa curva de dia — nao as 22, senao o blob passa de 20 MB.
  const HORA_GR = new Set(['IRRADIAÇÃO INCLINADA', 'IRRADIAÇÃO DIFUSA', 'IRRADIAÇÃO DIRETA',
    'TEMPERATURA MÓDULO 1', 'TEMPERATURA AMBIENTE', 'UMIDADE RELATIVA DO AR']);
  const accH = {};                 // dia|ufv|hora -> gr -> {s,n}
  const qual = {};                 // ufv -> gr -> {n,vazio,fora,zd,nd,min,max}
  let nLinhas = 0, tsIni = null, tsFim = null;

  for await (const linha of rl) {
    if (!linha.trim()) continue;
    const cols = linha.replace(/^﻿/, '').split(';');
    if (!cab) {
      cab = cols;
      cab.forEach((c, i) => {
        const m = c.match(/^UFV_([^_]+)_WS_(\S+)\s+WS\s+(.+?)(_\d+)?$/);
        if (!m || m[4]) return;                       // _2 = duplicata vazia do export
        const ufv = EST_UFV[m[1]];
        if (!ufv || !FAIXA[m[3]]) return;             // estacao ou grandeza que nao conheco
        mapa.push({ i, ufv, gr: m[3] });
      });
      if (!mapa.length) throw new Error('nenhuma coluna reconhecida — o layout do export mudou?');
      continue;
    }
    nLinhas++;
    const ts = cols[0]; if (!tsIni) tsIni = ts; tsFim = ts;
    const d = ts.slice(0, 10), hh = +ts.slice(11, 13);
    const diurno = hh >= DIURNO[0] && hh <= DIURNO[1];
    for (const m of mapa) {
      const bruto = cols[m.i];
      // min/max em DUAS versoes: o que o sensor reportou (bruto) e o que passou na faixa (limpo).
      // Na primeira versao eu so guardava o limpo — e ai a tabela de qualidade dizia "fora da faixa
      // 8.619 leituras, max 0,99", que nao explica nada. O valor que denuncia o sensor e justamente
      // o que a faixa recusou.
      const q = ((qual[m.ufv] = qual[m.ufv] || {})[m.gr] = qual[m.ufv][m.gr]
        || { n: 0, vazio: 0, fora: 0, foraBaixo: 0, foraAlto: 0, zd: 0, nd: 0,
          min: null, max: null, minB: null, maxB: null });
      const o = (((acc[d] = acc[d] || {})[m.ufv] = acc[d][m.ufv] || {})[m.gr] = acc[d][m.ufv][m.gr]
        || { sB: 0, nB: 0, sL: 0, nL: 0, maxL: null, fora: 0, zd: 0, nd: 0 });
      if (bruto === '' || bruto == null) { q.vazio++; continue; }
      const x = Number(String(bruto).replace(',', '.'));
      if (!isFinite(x)) { q.vazio++; continue; }
      q.n++;
      if (q.minB == null || x < q.minB) q.minB = x;
      if (q.maxB == null || x > q.maxB) q.maxB = x;
      o.sB += x; o.nB++;
      if (diurno) { o.nd++; q.nd++; if (x === 0) { o.zd++; q.zd++; } }
      const [lo, hi] = FAIXA[m.gr];
      if (x < lo || x > hi) {
        q.fora++; o.fora++;
        if (x < lo) q.foraBaixo++; else q.foraAlto++;   // por que lado escapou: o lado e o diagnostico
        continue;                                       // suspeita: fica fora do LIMPO
      }
      o.sL += x; o.nL++;
      if (HORA_GR.has(m.gr)) {
        const kh = d + '|' + m.ufv + '|' + hh;
        const oh = ((accH[kh] = accH[kh] || {})[m.gr] = accH[kh][m.gr] || { s: 0, n: 0 });
        oh.s += x; oh.n++;
      }
      if (o.maxL == null || x > o.maxL) o.maxL = x;
      if (q.min == null || x < q.min) q.min = x;
      if (q.max == null || x > q.max) q.max = x;
    }
  }

  const ufvs = [...new Set(mapa.map(m => m.ufv))].sort();
  const grs = [...new Set(mapa.map(m => m.gr))].sort();
  const dias = Object.keys(acc).sort();
  const SLOTS = 48;

  // ---------- serie diaria ----------
  const valor = (o, gr, limpo) => {
    if (!o) return null;
    const s = limpo ? o.sL : o.sB, n = limpo ? o.nL : o.nB;
    if (!n) return null;
    if (INTEGRA.has(gr)) return r3(s * H_SLOT / 1000);     // W/m2 -> kWh/m2
    if (SOMA.has(gr)) return r2(s);
    return r2(s / n);
  };
  const CAMPO = {
    'IRRADIAÇÃO INCLINADA': 'gti', 'IRRADIAÇÃO DIFUSA': 'dif', 'IRRADIAÇÃO DIRETA': 'dni',
    'IRRADIAÇÃO ALBEDO DE CIMA': 'alb_cima', 'IRRADIAÇÃO ALBEDO DE BAIXO': 'alb_baixo',
    'TAXA DE ALBEDO': 'albedo', 'TEMPERATURA MÓDULO 1': 't_mod1', 'TEMPERATURA MÓDULO 2': 't_mod2',
    'TEMPERATURA MÓDULO 3': 't_mod3', 'TEMPERATURA MÓDULO 4': 't_mod4',
    'TEMPERATURA AMBIENTE': 't_amb', 'TEMPERATURA INTERNA': 't_int',
    'UMIDADE RELATIVA DO AR': 'umid', 'PONTO DE CONDENSAÇÃO': 't_orvalho',
    'VELOCIDADE VENTO': 'vento', 'DIREÇÃO VENTO': 'vento_dir', 'PRECIPITAÇÃO': 'chuva',
    'SENSOR DE SUJEIRA 1': 'suj1', 'SENSOR DE SUJEIRA 2': 'suj2',
    'TAXA DE PERDA POR SUJEIRA 1': 'perda_suj1', 'TAXA DE PERDA POR SUJEIRA 2': 'perda_suj2',
    'TENSÃO DA BATERIA': 'bateria',
  };
  const serie_dia = [];
  dias.forEach(d => ufvs.forEach(u => {
    const g = (acc[d] || {})[u]; if (!g) return;
    const l = { dia: d, mes: d.slice(0, 7), dia_num: +d.slice(8, 10), ufv: u };
    grs.forEach(gr => {
      const k = CAMPO[gr]; if (!k) return;
      l[k] = valor(g[gr], gr, true);
      if (gr === 'IRRADIAÇÃO INCLINADA') {
        l.gti_bruta = valor(g[gr], gr, false);
        l.gti_pico_w = r2((g[gr] || {}).maxL);
      }
    });
    // bandeiras do dia: sao dado, nao enfeite
    const inc = g['IRRADIAÇÃO INCLINADA'] || {};
    l.leituras = inc.nB || 0;
    l.cobertura_pct = r2(100 * (inc.nB || 0) / SLOTS);
    l.fora_faixa = Object.values(g).reduce((a, o) => a + (o.fora || 0), 0);
    l.zeros_diurnos = inc.zd || 0;
    l.suspeito = (l.cobertura_pct < 95 || l.fora_faixa > 0 || (inc.zd || 0) > 2) ? 1 : 0;
    serie_dia.push(l);
  }));

  // ---------- serie mensal ----------
  const meses = [...new Set(dias.map(d => d.slice(0, 7)))].sort();
  const serie_mes = [];
  meses.forEach(m => ufvs.forEach(u => {
    const L = serie_dia.filter(x => x.mes === m && x.ufv === u);
    if (!L.length) return;
    const som = k => { const v = L.map(x => x[k]).filter(x => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0)) : null; };
    const med = k => { const v = L.map(x => x[k]).filter(x => x != null); return v.length ? r2(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    serie_mes.push({ mes: m, ufv: u, dias: L.length,
      gti_kwh: som('gti'), gti_dia: med('gti'), dif_kwh: som('dif'), dni_kwh: som('dni'),
      t_mod: med('t_mod1'), t_amb: med('t_amb'), umid: med('umid'), vento: med('vento'),
      chuva_mm: som('chuva'), albedo: med('albedo'),
      perda_suj1: med('perda_suj1'), perda_suj2: med('perda_suj2'),
      dias_suspeitos: L.filter(x => x.suspeito).length,
      fora_faixa: L.reduce((a, x) => a + (x.fora_faixa || 0), 0) });
  }));

  // ---------- serie HORARIA ----------
  // As leituras sao de 30 min; duas por hora. Irradiancia vira POTENCIA MEDIA da hora em W/m2 (media
  // das duas), que na janela de 1 h e tambem a energia em Wh/m2. As demais sao media simples.
  const CAMPO_H = { 'IRRADIAÇÃO INCLINADA': 'gti_w', 'IRRADIAÇÃO DIFUSA': 'dif_w',
    'IRRADIAÇÃO DIRETA': 'dni_w', 'TEMPERATURA MÓDULO 1': 't_mod', 'TEMPERATURA AMBIENTE': 't_amb',
    'UMIDADE RELATIVA DO AR': 'umid' };
  const serie_hora = [];
  Object.keys(accH).sort().forEach(k => {
    const [d, u, hh] = k.split('|');
    const g = accH[k];
    const l = { dia: d, mes: d.slice(0, 7), ufv: u, h: +hh };
    let algum = false;
    Object.entries(CAMPO_H).forEach(([gr, campo]) => {
      const o = g[gr];
      if (o && o.n) { l[campo] = r2(o.s / o.n); algum = true; }
    });
    if (algum) serie_hora.push(l);
  });

  // ---------- tabela de QUALIDADE: e o entregavel principal ----------
  const qualidade = [];
  ufvs.forEach(u => grs.forEach(gr => {
    const q = (qual[u] || {})[gr]; if (!q) return;
    const total = q.n + q.vazio;
    const foraPct = q.n ? 100 * q.fora / q.n : 0;
    const zdPct = q.nd ? 100 * q.zd / q.nd : 0;
    qualidade.push({ ufv: u, grandeza: gr, campo: CAMPO[gr] || null,
      faixa_lo: FAIXA[gr][0], faixa_hi: FAIXA[gr][1],
      leituras: q.n, vazias: q.vazio, cobertura_pct: r2(total ? 100 * q.n / total : 0),
      fora_faixa: q.fora, fora_pct: r3(foraPct),
      fora_abaixo: q.foraBaixo, fora_acima: q.foraAlto,
      min_bruto: r2(q.minB), max_bruto: r2(q.maxB),
      zeros_diurnos: q.zd, zeros_diurnos_pct: r3(zdPct),
      min: r2(q.min), max: r2(q.max),
      veredito: q.n === 0 ? 'sem dado'
        : foraPct > 1 ? 'sensor suspeito'
          : zdPct > 2 ? 'falhas diurnas'
            : q.fora > 0 ? 'picos isolados' : 'ok' });
  }));

  const out = {
    gerado_em: new Date().toISOString(),
    fonte: 'SCADA · export IIRR (estações solarimétricas), 30 min. Energia = média da leitura × 0,5 h. '
      + 'Duas versões de cada agregado: LIMPA (só o que passa na faixa física) e BRUTA (tudo). '
      + 'A diferença entre as duas é indicador de sensor.',
    janela: { ini: tsIni, fim: tsFim }, resolucao_min: 30, linhas: nLinhas,
    mapeamento: EST_UFV, faixa_fisica: FAIXA,
    ufvs, grandezas: grs, dias: dias.length, meses,
    serie_dia, serie_mes, qualidade,
  };
  // a horaria sai antes, em um arquivo por mes, so os ultimos HORA_DIAS dias
  const corte = dias.slice(-HORA_DIAS)[0];
  const hora = serie_hora.filter(x => x.dia >= corte);
  // dias_hora vai no blob PRINCIPAL: e dele que o filtro de dia se alimenta, e ele so pode oferecer
  // dia que tenha curva horaria de verdade — dia oferecido sem dado = painel vazio.
  out.dias_hora = [...new Set(hora.map(x => x.dia))].sort();
  const rh = await emiteHora({
    gerado_em: out.gerado_em, fonte: out.fonte, resolucao_min: 60,
    nota: 'PACOTE DO MES: serie mensal inteira (nivel "All"), os dias deste mes e as horas deste mes. '
      + 'Existe para o painel resolver os tres niveis de zoom com UM alvo — com dois alvos, o do nivel '
      + 'inativo devolve frame sem campo e o trend morre em "Unable to find field: x". '
      + 'Horaria em W/m2 (media da hora, que na janela de 1 h e tambem Wh/m2).',
    janela: { ini: corte, fim: dias[dias.length - 1] }, ufvs,
  }, hora, meses, serie_mes, serie_dia);
  console.log('irr_hora_<mes>.json OK · ' + rh.arquivos + ' arquivos (' + rh.comDado + ' com dado) · '
    + Math.round(rh.bytes / 1024) + ' KB · ' + rh.linhas + ' linhas · desde ' + corte);

  const tam = await writeOut(out);
  console.log('irr_ufv.json OK · ' + Math.round(tam / 1024) + ' KB');
  console.log('  janela ' + tsIni + ' a ' + tsFim + '  ·  ' + nLinhas + ' linhas  ·  ' + dias.length + ' dias');
  console.log('  ' + ufvs.length + ' UFVs · ' + grs.length + ' grandezas · ' + serie_dia.length
    + ' linhas diarias · ' + serie_hora.length + ' linhas horarias');
  const ruins = qualidade.filter(q => q.veredito !== 'ok');
  console.log('  qualidade: ' + (qualidade.length - ruins.length) + ' de ' + qualidade.length + ' series ok');
  ruins.sort((a, b) => b.fora_pct - a.fora_pct).slice(0, 12).forEach(q =>
    console.log('     ' + q.ufv + ' · ' + q.grandeza.padEnd(30) + q.veredito.padEnd(17)
      + 'fora ' + String(q.fora_faixa).padStart(5) + ' (' + String(q.fora_pct).padStart(6) + '%)'
      + '  abaixo ' + String(q.fora_abaixo).padStart(5) + '  acima ' + String(q.fora_acima).padStart(4)
      + '   bruto ' + q.min_bruto + ' a ' + q.max_bruto));
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
