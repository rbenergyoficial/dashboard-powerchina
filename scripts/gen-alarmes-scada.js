'use strict';
/*
 * gen-alarmes-scada.js — a tabela de alarmes do supervisório (D+1) para a tela "Alarmes e ocorrências" (Fase 1, 28/10/2026).
 *
 * Lê do cofre `backup-dados-scada` os CSV diários `SCADA_DB/bruto/alarmes/<AAAA-MM>/alarms_<AAAA-MM-DD>.csv.gz` (a versão mais nova de
 * cada dia, lib-alarmes-scada.escolheVersoes) e grava em `dados`:
 *   hist/alarmes_scada_<AAAA>_<MM>.json   o mês inteiro (a tela só busca quando o período passa de 7 dias);
 *   alarmes_scada.json                     os últimos 7 dias com arquivo (lista + resumo de TCU sem comunicação).
 * Toda regra (classe, episódio, agrupamento, formato) mora na lib-alarmes-scada.js; aqui só se lista, lê e grava.
 *
 * Modo normal: refaz o(s) mês(es) que a janela de 7 dias toca e, desde o primeiro mês com dia novo no cofre (o histórico chega aos poucos),
 * esse mês e todos os seguintes em cadeia, cada um semeado pelo anterior (disjuntor ainda aberto); ensaio-gen-alarmes-scada.js.
 * BACKFILL=1: refaz todos os meses com arquivo, do mais antigo ao mais novo.
 * Env: a credencial pela lib-conteiner (DADOS_STORAGE ou o OIDC do job) · RAW=backup-dados-scada · PREFIXO=SCADA_DB/bruto/alarmes/ ·
 *      OUT=dados · ATE=AAAA-MM-DD (último dia da janela; padrão: o último com arquivo) · LOCAL_DIR=<pasta> lê os CSV de uma pasta ·
 *      LOCAL_OUT_DIR=<pasta> grava ali (e lê ali a publicação anterior).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const A = require('./lib-alarmes-scada');

const RAW = process.env.RAW || 'backup-dados-scada';
const PREFIXO = process.env.PREFIXO || 'SCADA_DB/bruto/alarmes/';
const OUT = process.env.OUT || 'dados';
const DIAS = 7;
const conteiner = (nome) => require('./lib-conteiner').conteiner(nome);
const diaMais = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
const nomeMes = (m) => 'hist/alarmes_scada_' + m.replace('-', '_') + '.json';

async function arquivos() {
  const out = [];
  if (process.env.LOCAL_DIR) {
    const anda = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) anda(p); else out.push({ nome: path.relative(process.env.LOCAL_DIR, p).split(path.sep).join('/'), ler: async () => fs.readFileSync(p) }); } };
    anda(process.env.LOCAL_DIR);
    return { lista: out, fim: () => {} };
  }
  const cache = require('./lib-cache-blob').abre(RAW);
  const c = conteiner(RAW);
  for await (const b of c.listBlobsFlat({ prefix: PREFIXO })) out.push({ nome: b.name, ler: () => cache.baixa(c, b) });
  return { lista: out, fim: () => { cache.poda(); cache.resumo(); } };
}

async function lePublicado(nome) {
  if (process.env.LOCAL_OUT_DIR) { const f = path.join(process.env.LOCAL_OUT_DIR, nome); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8')) : null; }
  const LD = require('./lib-le-dados');
  return LD.json(LD.BASE + nome);   // só o 404 é ausência (null); o resto estoura
}

async function escreve(nome, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)));
  if (process.env.LOCAL_OUT_DIR) { const f = path.join(process.env.LOCAL_OUT_DIR, nome); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, gz); return gz.length; }
  await conteiner(OUT).getBlockBlobClient(nome).upload(gz, gz.length, { blobHTTPHeaders: {
    blobContentType: 'application/json', blobContentEncoding: 'gzip', blobCacheControl: 'public, max-age=300' } });
  return gz.length;
}

async function main() {
  const gerado = new Date().toISOString();
  const { lista, fim } = await arquivos();
  const porNome = new Map(lista.map((x) => [x.nome, x]));
  const ver = A.escolheVersoes(lista.map((x) => x.nome));
  const dias = [...ver.keys()];
  if (!dias.length) throw new Error('nenhum arquivo de alarmes em ' + RAW + '/' + PREFIXO);
  const ate = process.env.ATE || dias[dias.length - 1];
  const de = diaMais(ate, -(DIAS - 1));
  /* 🔴 ATRASO NÃO SAI VERDE. Sem ATE, a janela termina no último dia com arquivo: se a ponte atrasa, terminaria anteontem com o `gerado`
     fresco. O arquivo de ontem chega pela ponte até ~12:30 BRT (ela desliga depois do backup): antes disso é aviso; depois, erro e saída
     1, DEPOIS de gravar o que chegou. AGORA=<instante ISO> fixa o relógio (ensaio). */
  const agora = process.env.AGORA ? Date.parse(process.env.AGORA) : Date.now();
  const brt = new Date(agora - 3 * 3600e3).toISOString(), ontem = diaMais(brt.slice(0, 10), -1);
  let atraso = null;
  if (!process.env.ATE && process.env.BACKFILL !== '1' && ate < ontem) {
    atraso = 'o último dia com arquivo é ' + ate + ' e ontem (BRT) foi ' + ontem;
    if (brt.slice(11, 16) < '12:30') { console.log('::warning::' + atraso + ' (a ponte ainda tenta até ~12:30 BRT)'); atraso = null; }
  }
  /* 🔴 QUAIS MESES SE REFAZEM (29/10/2026): a coleta da usina traz o histórico aos poucos (~70 dias por noite, do mais antigo para o mais
     novo), então um mês antigo GANHA dias depois de publicado. Modo normal = os meses da janela de 7 dias + o primeiro mês com MAIS dias
     com arquivo do que `dias` no mês publicado (ausente = incompleto) + em CADEIA os seguintes ENQUANTO a semente muda: refazer um mês
     muda o que fica aberto no fim dele (o disjuntor aberto num dia novo só fecha no mês seguinte se ele for refeito). A cadeia para no
     primeiro mês refeito cujos abertos no fim são os mesmos do publicado; daí em diante só a janela. BACKFILL=1 = todos. */
  const todos = [...new Set(dias.filter((d) => d <= ate).map((d) => d.slice(0, 7)))];
  const publicados = new Map();
  const pub = async (m) => { if (!publicados.has(m)) publicados.set(m, await lePublicado(nomeMes(m))); return publicados.get(m); };
  const abertosNoFim = (o) => (o ? o.ev.filter((e) => e.f === null).map((e) => e.id).sort().join('\n') : null);
  const backfill = process.env.BACKFILL === '1';
  let primeiro = null;
  if (!backfill) for (const m of todos) {
    const p = await pub(m), comArq = dias.filter((d) => d.startsWith(m) && d <= ate);
    if (!p || comArq.some((d) => !(p.dias || []).includes(d))) { primeiro = m; break; }
  }
  // o dia fica COMPACTADO (~4 MB) até a composição pedir o texto (~30 MB): o mês inteiro descompactado de uma vez pesa ~1 GB
  const le = async (d) => { const gz = await porNome.get(ver.get(d)).ler(); return { dia: d, get txt() { return zlib.gunzipSync(gz).toString('utf8'); } }; };

  const prevMes = (m) => diaMais(m + '-01', -1).slice(0, 7);
  // a semente de cada mês é o mês anterior: o refeito nesta rodada, senão o publicado
  let anterior = null, feitoAnt = null, cadeia = false;
  const feitos = [], meses = [], porque = new Map();
  for (const m of todos) {
    const motivo = backfill ? 'backfill' : m === primeiro ? 'incompleto' : cadeia ? 'cadeia' : m >= de.slice(0, 7) ? 'janela' : null;
    if (!motivo) continue;
    meses.push(m); porque.set(m, motivo);
    if (feitoAnt !== prevMes(m)) anterior = await pub(prevMes(m));
    const dm = dias.filter((d) => d.startsWith(m) && d <= ate);
    const vespera = diaMais(m + '-01', -1);
    const textos = [];
    if (ver.has(vespera)) textos.push(await le(vespera));        // fecha o que atravessa a virada do mês
    for (const d of dm) textos.push(await le(d));
    const o = A.compoe(textos, m + '-01', dm[dm.length - 1], { gerado, anterior });
    if (!backfill && (motivo === 'incompleto' || motivo === 'cadeia')) cadeia = abertosNoFim(o) !== abertosNoFim(await pub(m));
    const kb = await escreve(nomeMes(m), o);
    console.log(nomeMes(m) + ': ' + o.dias.length + ' dia(s), ' + o.ev.length + ' eventos, ' + o.tcu_com.length + ' resumos de TCU, '
      + o.estados.length + ' resumos de estado, ' + o.retx.reduce((s, x) => s + x[1], 0) + ' linhas reemitidas descartadas, ' + Math.round(kb / 1024) + ' KB gzip · memória '
      + Math.round(process.memoryUsage().rss / 1048576) + ' MB');
    // só os meses que a JANELA toca vão ao recorte: um mês antigo refeito (incompleto, cadeia) com episódios sem fim punha na janela de
    // hoje o que ficou aberto antes de um buraco (29/10/2026: mar/2025 dava 16.730 eventos à janela de out/2026). E solta a memória.
    if (m >= de.slice(0, 7) && m <= ate.slice(0, 7)) feitos.push(o);
    anterior = o; feitoAnt = m;
  }
  console.log('meses refeitos: ' + (meses.map((m) => m + ' (' + porque.get(m) + ')').join(', ') || 'nenhum'));
  // a janela de 7 dias: dos meses refeitos (e do anterior publicado, se a janela começa nele e ele não foi refeito)
  const fontes = feitos.slice();
  if (!meses.includes(de.slice(0, 7))) { const p = await lePublicado(nomeMes(de.slice(0, 7))); if (p) fontes.unshift(p); }
  const j = A.recorta(fontes, de, ate, { gerado });
  const kb = await escreve('alarmes_scada.json', j);
  console.log('alarmes_scada.json: ' + de + ' a ' + ate + ', ' + j.dias.length + ' dia(s) com arquivo, ' + j.ev.length + ' eventos, '
    + j.tcu_com.length + ' resumos de TCU, ' + Math.round(kb / 1024) + ' KB gzip');
  if (j.dias.length < DIAS) console.log('::warning::a janela de ' + DIAS + ' dias tem só ' + j.dias.length + ' dia(s) com arquivo (faltam: '
    + [...Array(DIAS).keys()].map((k) => diaMais(de, k)).filter((d) => !j.dias.includes(d)).join(', ') + ')');
  fim();
  if (atraso) { console.log('::error::' + atraso + ' (depois de 12:30 BRT: o arquivo de ontem faltou)'); process.exitCode = 1; }
}

main().catch((e) => { console.error('🔴 ' + (e.stack || e.message)); process.exit(1); });
