/* gen-dia-corrente.js — mantem a LINHA DO DIA EM CURSO fresca no executivo.json.
 *
 * Por que existe: o executivo declara 15 execucoes/dia no cron e o agendador do GitHub
 * entrega 5,6 (medido em 45 execucoes: mediana 91 min entre elas, p90 615 min). O snapshot
 * de 5 min da Way2, por outro lado, e disparado por fora e chega a cada 5 minutos exatos.
 * Entao o dado existe quase ao vivo e so nao chegava a tela.
 *
 * O que faz: le o snapshot de hoje, aplica o MESMO rollup do arquivador (rollupDia, que ja
 * desconta o consumo — a equacao da casa) e regrava SO as linhas de hoje de `serie_dia_ufv`.
 * Custa uma leitura e uma escrita; roda dentro do job de 5 minutos.
 *
 * 🔴 CONCORRENCIA: o executivo reescreve o blob inteiro a cada ~2 h. Sem controle, um patch
 * montado sobre uma leitura velha desfaria essa reescrita e o estrago duraria ate a proxima
 * (horas). A gravacao vai com `If-Match` no ETag lido: se o blob mudou no meio, o Azure
 * recusa com 412, este job desiste e a proxima rodada (5 min) refaz sobre o estado novo.
 *
 * Env: DADOS_STORAGE · BASE (url publica) · LOCAL_OUT p/ ensaio sem gravar.
 */
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const zlib = require('zlib');
const { BlobServiceClient } = require('@azure/storage-blob');
const { rollupDia, valores: valoresW2 } = require('./gen-way2-hist.js');
const { horasDoDia } = require('./lib-horas.js');
// a conta dos campos da manchete que se movem no dia — a MESMA que o executivo chama
const { remendaManchete } = require('./lib-manchete.js');
// a guarda do dia em curso: teto FISICO (343,77 MW x horas desde 05:00), PROMOVER executivo-teto-fisico
const { guardaDia, relidoDoPublicado, corteTrafos } = require('./lib-teto-dia.js');

const CONTAINER = process.env.OUT_CONTAINER || 'dados';
const BLOB = process.env.OUT_BLOB || 'executivo.json';
const BLOB_H = process.env.OUT_BLOB_HORA || 'hora_ufv.json';
const BASE = process.env.BASE || 'https://rbenergydata.blob.core.windows.net/dados/';
const PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8'];
const ML = ['M1', 'M7', 'M9'];
const UFVS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9'];
const r2 = (v) => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : null);
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
const SLOTS_DIA_COMPLETO = 286;   // o dia passado so fecha com o snapshot completo: a MESMA regra do `DIAS_SNAP` k > 0 do executivo

// por entidade, a MESMA regra do executivo: grupo e a soma dos membros, o conjunto vem
// do rollup dos dois transformadores (nao da soma das nove, que e outra grandeza).
function valoresDia(linha) {
  const uf = linha.ufv_liq_mwh || {};
  const soma = (us) => us.reduce((a, u) => a + num(uf[u]), 0);
  const val = { Complexo: num(linha.ene_liq_mwh), PPA: soma(PPA), ML: soma(ML) };
  UFVS.forEach((u) => { val[u] = num(uf[u]); });
  return val;
}

// A energia do dia sai tambem repartida em dois campos COMPLEMENTARES (um sempre nulo), que o grafico diario le como duas series:
// `liq_hoje_mwh` enquanto o dia rende, `liq_fechada_mwh` depois. E a MESMA regra do `parte` do executivo (parcial e nao
// encerrado = rendendo). Sem isto o remendo movia so `liq_mwh` e o grafico ficava no valor da ultima rodada completa (11/10/2026:
// 545,25 publicado, 476,53 no grafico).
const parte = (x, v) => ((x.parcial && !x.encerrado) ? [null, v] : [v, null]);

// 💰 custo-a (17/10/2026): o historico do medidor vem pela leitura condicional (`lib-le-blob.js`); o dia de HOJE, quando o job da
//    mesma rodada deixou a copia local (ELET_LOCAL_DIR, gravada pelo gen-way2-eletrico com os bytes que subiram), sai do disco: era o
//    mesmo arquivo de ~4 MB baixado de volta a cada 5 min. As mensagens de erro sao as mesmas de antes.
const LB = require('./lib-le-blob');
function decodifica(x) {
  if (x[0] === 0x1f && x[1] === 0x8b) x = zlib.gunzipSync(x);
  return JSON.parse(x.toString('utf8').replace(/^﻿/, ''));
}
function baixa(url) {
  const m = /\/hist\/way2_(\d{4}-\d{2}-\d{2})\.json$/.exec(url), dl = process.env.ELET_LOCAL_DIR;
  if (m && dl) { const f = require('path').join(dl, 'way2_' + m[1] + '.json'); if (require('fs').existsSync(f)) { console.log('  ' + m[1] + ': copia local da rodada'); return Promise.resolve(decodifica(require('fs').readFileSync(f))); } }
  if (LB.ALVO.test(url)) return LB.bytes(url).then((b) => { if (b == null) throw new Error('HTTP 404 em ' + url); return decodifica(b); }, erroLeitura(url));
  // Fase 2: o resto pelo transporte da lib-le-dados (credencial para `dados`), com as mesmas mensagens
  return LD.pede(url).then((x) => { if (x.status === 404) throw new Error('HTTP 404 em ' + url); return decodifica(x.buf); }, erroLeitura(url));
}
// Fase 2: so o 404 do PROPRIO blob vira 'HTTP 404 em <url>' (a ausencia que os chamadores testam com /^HTTP 404 /). O 404 que a
// lib estoura (conteiner sumido, pedido anonimo a conteiner privado) sai sem casar, para nunca virar "o snapshot nao existe"; os
// outros codigos ficam com a mensagem de antes ('HTTP 500 em <url>').
const erroLeitura = (url) => (e) => {
  const m = String(e && e.message);
  if (/^HTTP 404/.test(m)) throw new Error('lib-le-dados: ' + m.replace(/^HTTP 404/, '404'));
  throw new Error(m.replace(/^HTTP (\d+) .*$/, 'HTTP $1 em ' + url));
};

// Fecha as 12 linhas de ONTEM pelo snapshot completo, se elas ainda estao `parcial`. Nao derruba o job: o que impede o fechamento
// sai no log (com `::warning::` quando e a guarda), e a rodada completa fecha depois. Leitura que falha sem ser 404 estoura.
async function fechaOntem(j, hoje, mes) {
  const ontem = new Date(Date.parse(hoje + 'T12:00:00Z') - 86400000).toISOString().slice(0, 10);
  const linhas = (j.serie_dia_ufv || []).filter((x) => x.dia === ontem);
  const cxO = linhas.find((x) => x.ufv === 'Complexo');
  if (!cxO) { console.log('ontem (' + ontem + ') sem linha no executivo — nada a fechar'); return; }
  // aberto = `parcial`, ou a linha-reserva que a rodada completa cria para os dias futuros (`parcial` 0 e sem energia), quando o
  // remendo nao chegou a escreve-la no dia
  if (!cxO.parcial && cxO.liq_mwh != null) { console.log('ontem (' + ontem + ') ja fechado' + (cxO.liq_fonte ? ' (' + cxO.liq_fonte + ')' : '') + ' — nada a fazer'); return; }
  if (ontem.slice(0, 7) !== mes) { console.log('ontem (' + ontem + ') e do mes anterior — fica para a rodada completa'); return; }
  let snapO;
  try { snapO = await baixa(BASE + 'hist/way2_' + ontem + '.json'); }
  catch (e) {
    if (!/^HTTP 404 /.test(e.message)) throw e;
    console.log('snapshot de ontem (' + ontem + ') nao existe — ontem segue parcial'); return;
  }
  const lO = rollupDia(snapO, ontem);
  const trafosO = [valoresW2(snapO, 6196, 'Demat'), valoresW2(snapO, 6197, 'Demat')];
  const nO = trafosO.map((vs) => vs.filter((v) => v.valor != null).length);
  if (!(lO.slots >= SLOTS_DIA_COMPLETO && nO[0] >= SLOTS_DIA_COMPLETO && nO[1] >= SLOTS_DIA_COMPLETO)) {
    console.log('snapshot de ontem (' + ontem + ') incompleto (6233 ' + lO.slots + ', TR1 ' + nO[0] + ', TR2 ' + nO[1] + ' de 288) — ontem segue parcial');
    return;
  }
  const valO = valoresDia(lO);
  const antesO = cxO.liq_mwh != null ? cxO.liq_mwh : null;
  const relO = antesO != null
    ? relidoDoPublicado(trafosO, ontem, cxO.ate, cxO.liq_fonte === 'snapshot 5 min' ? cxO.liq_corte : null, antesO) : null;
  const novoO = r2(valO.Complexo);
  const motivoO = guardaDia(novoO, antesO, '00:00', relO, corteTrafos(trafosO, ontem));
  if (motivoO) { console.log('::warning::ontem (' + ontem + ') NAO fechado: ' + motivoO); return; }
  if (linhas.filter((x) => x.ufv in valO).length !== 12) { console.log('::warning::ontem (' + ontem + ') sem as 12 entidades — nao fechado'); return; }
  linhas.forEach((x) => {
    if (!(x.ufv in valO)) return;
    x.liq_mwh = r2(valO[x.ufv]);
    x.parcial = 0;
    x.encerrado = 0;
    [x.liq_fechada_mwh, x.liq_hoje_mwh] = parte(x, x.liq_mwh);
    x.ate = null;
    delete x.liq_corte;
    x.liq_fonte = 'snapshot completo';
  });
  console.log('ontem (' + ontem + ') FECHADO pelo snapshot completo: Complexo ' + antesO
    + (relO ? ' (relido ' + r2(relO.mwh) + ' ate ' + relO.em + ')' : '') + ' -> ' + novoO + ' MWh');
}

(async () => {
  const hoje = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 10);
  let snap;
  // so o 404 e ausencia (o snapshot do dia ainda nao existe, logo depois da meia-noite); HTTP 500, gzip ou JSON quebrado
  // estouram: com "nada a fazer" o dia em curso parava em silencio e o job ficava verde (revisor-ensaio RE-007, 10/10/2026)
  try { snap = await baixa(BASE + 'hist/way2_' + hoje + '.json'); }
  catch (e) {
    if (!/^HTTP 404 /.test(e.message)) throw e;
    console.log('snapshot de ' + hoje + ' ainda nao existe (' + e.message + ') — nada a fazer'); return;
  }

  const linha = rollupDia(snap, hoje);
  if (!(linha.slots > 0)) { console.log('snapshot de ' + hoje + ' sem slots — nada a fazer'); return; }
  const g = valoresW2(snap, 6233, 'Demat').filter((v) => v.valor != null);
  linha.ate = g.length ? String(g[g.length - 1].data).slice(11, 16) : null;
  if (!linha.ate) { console.log('snapshot sem instante util — nada a fazer'); return; }

  const n1 = valoresW2(snap, 6196, 'Demat').filter((v) => v.valor != null).length;
  const n2 = valoresW2(snap, 6197, 'Demat').filter((v) => v.valor != null).length;
  if (Math.abs(n1 - n2) > 1) {
    console.log('trafos com cobertura diferente (TR1 ' + n1 + ', TR2 ' + n2 + ') — a soma sairia curta, abortando');
    return;
  }

  const val = valoresDia(linha);

  const conn = process.env.DADOS_STORAGE;
  if (!conn && !process.env.LOCAL_OUT) { console.error('ERRO: DADOS_STORAGE ausente.'); process.exit(1); }

  if (process.env.LOCAL_OUT) {
    console.log('[ensaio] ' + hoje + ' ate ' + linha.ate + ' · ' + linha.slots + ' slots · guarda: ' + (guardaDia(r2(val.Complexo), null, linha.ate) || 'passa'));
    Object.entries(val).forEach(([u, v]) => console.log('   ' + u.padEnd(9) + r2(v) + ' MWh'));
    // ⚠️ a camada horaria entra no ensaio TAMBEM: bloco so visto em producao nao esta testado
    const hs = horasDoDia(snap, hoje).horas;
    const ult = hs.length ? Math.max.apply(null, hs.map((x) => x.h)) : -1;
    const pc = hs.find((x) => x.h === ult && x.ufv === 'Complexo') || {};
    console.log('   camada horaria: ' + hs.length + ' linhas, ate ' + ult + 'h'
      + (pc.parcial ? ' (em curso, ' + pc.min + ' min)' : '') + ' · Complexo ' + pc.mwh + ' MWh');
    require('fs').writeFileSync(process.env.LOCAL_OUT,
      JSON.stringify({ dia: hoje, ate: linha.ate, val, horas: hs }, null, 1));
    return;
  }

  const cont = BlobServiceClient.fromConnectionString(conn).getContainerClient(CONTAINER);
  const bc = cont.getBlockBlobClient(BLOB);
  const props = await bc.getProperties();
  const etag = props.etag;
  const buf = await bc.downloadToBuffer();
  let bytes = buf;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = zlib.gunzipSync(bytes);
  const j = JSON.parse(bytes.toString('utf8').replace(/^﻿/, ''));

  const alvo = (j.serie_dia_ufv || []).filter((x) => x.dia === hoje);
  if (!alvo.length) { console.log('o executivo ainda nao tem linha para ' + hoje + ' — nada a patchar'); return; }

  // o que estava publicado, e o snapshot NOVO relido no trecho publicado — ANTES de o laco abaixo regravar a linha. O trecho e o
  // `liq_corte` que este remendo grava (o ultimo instante dos trafos que a `liq_mwh` soma; o `ate` e o do 6233, ~10 min a frente);
  // linha sem ele (escrita pela rodada completa) e relida na janela de +/- 10 min do `ate`.
  const trafos = [valoresW2(snap, 6196, 'Demat'), valoresW2(snap, 6197, 'Demat')];
  const corte = corteTrafos(trafos, hoje);
  const cx = alvo.find((x) => x.ufv === 'Complexo');
  const antes = cx && cx.liq_mwh != null ? cx.liq_mwh : null;
  const antesAte = antes != null ? cx.ate : null;
  // o corte so vale na linha que ESTE remendo escreveu: a rodada completa reconstroi a linha sem ele, e um corte que viesse de
  // outra escrita compararia o valor de um corte com o trecho de outro (revisor RE-206)
  const antesCorte = antes != null && cx.liq_fonte === 'snapshot 5 min' ? cx.liq_corte : null;
  const relido = antes != null ? relidoDoPublicado(trafos, hoje, antesAte, antesCorte) : null;
  let n = 0;
  alvo.forEach((x) => {
    if (!(x.ufv in val)) return;
    x.liq_mwh = r2(val[x.ufv]);
    x.parcial = 1;
    [x.liq_fechada_mwh, x.liq_hoje_mwh] = parte(x, x.liq_mwh);
    x.ate = linha.ate;
    x.liq_corte = corte;
    x.liq_fonte = 'snapshot 5 min';
    n += 1;
  });
  if (n !== 12) { console.log('esperava 12 entidades no dia, patchei ' + n + ' — abortando'); process.exit(1); }

  // guarda: o dia em curso nunca passa do teto FISICO (343,77 MW x horas desde 05:00 ate o ultimo instante); relido no trecho
  // que estava publicado, nunca ENCOLHE; e depois dele nao cai mais que o consumo maximo do complexo. Qualquer um e leitura
  // torta, e publicar seria pior que ficar com o valor de antes. (Era "o maior dia do mes x 1,25": no inicio de um mes com dias
  // cortados, ele recusava um dia de sol — 05/10/2026.)
  // 🔴 A liquida NOVA pode ser menor que a publicada: depois do por do sol o trafo consome (~7 MWh ate a meia-noite). Comparar
  //    o novo com o publicado congelou 08/10/2026 em 19:20 (1.992,81 MWh, o dia inteiro foi 1.987,00) — PROMOVER dia-noite-encolhe.
  const novo = r2(val.Complexo);
  const motivo = guardaDia(novo, antes, linha.ate, relido, corte);
  if (motivo) { console.log(motivo + ' — abortando'); process.exit(1); }
  const mes = hoje.slice(0, 7);   // o mes em curso: a soma dos dias e a manchete abaixo (a linha morava na guarda antiga)

  // ---- o DIA DE ONTEM ------------------------------------------------------
  //
  // 🔴 Quem fechava o dia que acabou era SO a rodada completa do executivo. Com ela parada (06 a 10/10/2026) as linhas de 08 e 09/10
  //    ficaram como o remendo das ~19h as deixou, `parcial` e acima do dia inteiro (1.992,81 e 1.976,28 contra 1.987,00 e 1.969,78),
  //    por dois dias. Agora, enquanto a linha de ontem estiver `parcial`, o remendo a fecha pelo snapshot COMPLETO de ontem, com a
  //    mesma conta e a mesma guarda do dia em curso. A rodada completa, quando rodar, troca pela liquidada da Way2.
  //    Ontem de OUTRO mes fica para a rodada completa: a manchete do mes que fechou nao e remendada aqui.
  await fechaOntem(j, hoje, mes);

  // ---- a MANCHETE do mesmo dia ---------------------------------------------
  //
  // 🔴 Sem isto a pagina mostra DOIS dias em curso. Medido em 15/09/2026 09:34, no MESMO blob: a
  //    serie (esta linha, ja remendada acima) dizia dia 15 ate 09:30, e a manchete — escrita so
  //    pela rodada COMPLETA do executivo — continuava em `dia_hoje: null`, `ao_vivo_ate: 20:40` e
  //    `hoje_gwh: 0,00`, de ontem a noite. Treze horas de defasagem.
  //    E a mesma familia do bloco horario logo abaixo, um andar acima: dois relogios na mesma
  //    pagina o leitor le como DADO errado, nao como cadencia.
  //
  // ⚠️ A conta NAO e reescrita aqui — mora em `lib-manchete.js`, e o executivo chama a MESMA
  //    funcao. Os campos de energia se movem JUNTOS: avancar `liq_gwh` sozinho, com `atingido` e
  //    os ritmos parados, criaria a divergencia que este remendo veio consertar.
  //
  // 🔴 A energia do mes e a SOMA DOS DIAS da serie (o de hoje ja remendado acima), nao ancora + hoje
  //    (PROMOVER manchete-noite). A ancora so desconta o dia enquanto ele rende; depois do por do sol
  //    ela ja o contem, e ancora + hoje contou o dia 28/09/2026 duas vezes (58.350 MWh publicados,
  //    56.563 medidos, "meta ja batida" no portal). A soma so vale com TODOS os dias do mes presentes
  //    na entidade — dia faltando cai no caminho antigo, declarado no log.
  const diaNum = +hoje.slice(8, 10);
  const mwhMesPorUfv = {}, semCobertura = [];
  Object.keys(val).forEach((u) => {
    const dias = (j.serie_dia_ufv || []).filter((x) => x.ufv === u && x.dia.slice(0, 7) === mes && x.liq_mwh != null);
    if (new Set(dias.map((x) => x.dia)).size !== diaNum) { semCobertura.push(u + ' (' + dias.length + '/' + diaNum + ' dias)'); return; }
    mwhMesPorUfv[u] = r2(dias.reduce((s, x) => s + Number(x.liq_mwh), 0));
  });
  if (semCobertura.length) console.log('soma do mes incompleta, ancora + hoje em: ' + semCobertura.join(', '));
  const rem = remendaManchete(j.manchete_ufv, {
    mes, diaNum, ate: linha.ate,
    gwhPorUfv: Object.keys(val).reduce((a, u) => { a[u] = num(val[u]) / 1000; return a; }, {}),
    mwhMesPorUfv,
  });
  if (rem.quando === 0) {
    console.log('a manchete ainda nao tem o mes ' + mes + ' em curso — so a serie foi remendada');
  } else {
    console.log('manchete: ' + rem.quando + ' entidades com a hora, ' + rem.energia + ' com a energia'
      + (rem.semAncora ? ' · ' + rem.semAncora + ' sem a ancora `liq_fechada_gwh` (executivo antigo)' : '')
      + (rem.semDias ? ' · ' + rem.semDias + ' sem contagem de dias' : ''));
  }

  const saida = zlib.gzipSync(Buffer.from(JSON.stringify(j), 'utf8'));
  try {
    await bc.upload(saida, saida.length, {
      conditions: { ifMatch: etag },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip',
        blobCacheControl: 'public, max-age=60' },
    });
  } catch (e) {
    if (e.statusCode === 412) { console.log('o executivo foi reescrito no meio — desisto, a proxima rodada refaz'); return; }
    throw e;
  }
  console.log('dia ' + hoje + ' ate ' + linha.ate + ' · Complexo ' + (antes == null ? '—' : antes)
    + (relido ? ' (relido ' + r2(relido.mwh) + ' ate ' + relido.em + (relido.exato ? ', o corte gravado' : ', na janela de ' + antesAte) + ')' : '')
    + ' -> corte ' + corte
    + ' -> ' + novo + ' MWh (' + linha.slots + ' slots)');

  // ---- a CAMADA HORARIA do mesmo dia ---------------------------------------
  //
  // 🔴 Sem isto os dois paineis da secao 1 mostram horarios diferentes na mesma tela.
  //    Medido em 02/09/2026 as 13:02: o de atingimento trazia dado ate 12:50 (esta linha, ja
  //    remendada a cada 5 min) e o de entrega por hora parava em 11h, porque `hora_ufv.json` so
  //    e escrito pela execucao completa do executivo — 14 execucoes em 14 h, vaos de ate 47 min.
  //    Dois horarios na mesma pagina o leitor le como DADO errado, nao como cadencia.
  //
  // ⚠️ A regra da hora nao e reescrita aqui: ela mora em `lib-horas.js` e o executivo chama a
  //    MESMA funcao para as linhas de hoje.
  try {
    const bh = cont.getBlockBlobClient(BLOB_H);
    const ph = await bh.getProperties();
    const bufH = await bh.downloadToBuffer();
    let by = bufH;
    if (by[0] === 0x1f && by[1] === 0x8b) by = zlib.gunzipSync(by);
    const jh = JSON.parse(by.toString('utf8').replace(/^﻿/, ''));

    const novas = horasDoDia(snap, hoje).horas;
    if (!novas.length) { console.log('sem hora util no snapshot — camada horaria intacta'); return; }

    const antesH = (jh.horas || []).filter((x) => x.dia === hoje);
    const ultAntes = antesH.length ? Math.max.apply(null, antesH.map((x) => x.h)) : -1;
    const ultNovo = Math.max.apply(null, novas.map((x) => x.h));
    // guarda: a camada horaria do dia em curso so cresce. Recuar e sinal de leitura torta, e
    // publicar seria trocar dado bom por dado pior.
    if (ultNovo < ultAntes) {
      console.log('camada horaria RECUOU (' + ultAntes + 'h -> ' + ultNovo + 'h) — abortando');
      return;
    }
    // o Complexo tem de existir na ultima hora, senao a curva termina sem a serie principal
    if (!novas.some((x) => x.h === ultNovo && x.ufv === 'Complexo')) {
      console.log('ultima hora sem o Complexo — abortando');
      return;
    }

    // ⚠️ nada mudou, nada se publica: o arquivo tem 1,28 MB e 25 mil linhas, e uma versao a
    //    toa a cada 5 minutos e ruido que esconde a gravacao que importa. Acontece de verdade
    //    quando a fonte nao avancou entre duas rodadas (a Way2 chega com ~10 a 16 min de atraso).
    const ord = (L) => JSON.stringify(L.slice().sort((a, b) => (a.h - b.h) || (a.ufv < b.ufv ? -1 : 1)));
    if (ord(antesH) === ord(novas)) { console.log('camada horaria sem novidade — nada a gravar'); return; }

    jh.horas = (jh.horas || []).filter((x) => x.dia !== hoje).concat(novas);
    jh.dias = [...new Set(jh.horas.map((x) => x.dia))].sort();
    jh.inicio = jh.dias[0] || null;
    jh.fim = jh.dias[jh.dias.length - 1] || null;
    jh.gerado_em = new Date().toISOString();

    const saiH = zlib.gzipSync(Buffer.from(JSON.stringify(jh), 'utf8'));
    await bh.upload(saiH, saiH.length, {
      conditions: { ifMatch: ph.etag },
      blobHTTPHeaders: { blobContentType: 'application/json', blobContentEncoding: 'gzip',
        blobCacheControl: 'public, max-age=60' },
    });
    const p = novas.find((x) => x.h === ultNovo && x.ufv === 'Complexo') || {};
    console.log('camada horaria de ' + hoje + ': ' + novas.length + ' linhas, ate ' + ultNovo + 'h'
      + (p.parcial ? ' (em curso, ' + p.min + ' min)' : '') + ' · Complexo ' + p.mwh + ' MWh');
  } catch (e) {
    if (e.statusCode === 412) { console.log('hora_ufv.json foi reescrito no meio — a proxima rodada refaz'); return; }
    // ⚠️ a camada horaria NAO derruba o job: a linha do dia ja foi gravada acima, e perde-la
    //    por causa das horas seria trocar um defeito por outro maior.
    console.log('camada horaria falhou (' + e.message + ') — a linha do dia ja esta gravada');
  }
})().catch((e) => { console.error('ERRO ' + e.message); process.exit(1); });
