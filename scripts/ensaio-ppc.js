/*
 * ensaio-ppc.js — prova que a auditoria REPROVA. Roda antes da auditoria, no workflow.
 *
 * 🔴 GUARDA QUE NAO REPROVA NAO E GUARDA. Uma auditoria vista so no caminho feliz nao esta
 *    testada — foi assim que o painel de saude passou seis horas dizendo "24/24" durante uma
 *    queda, e foi assim que o `parcial` do MUST ficou anos sendo escrito sem nunca ser lido.
 *
 * Cada caso planta UM defeito REAL, dos que ja aconteceram neste registro, sobre o dado de
 * verdade — e exige o gatilho certo, na QUANTIDADE certa, apontando para o dia-cobaia:
 *
 *   A · LINHA DE BASE  o dado como esta hoje, achados reais inclusive (medida, nao suposta).
 *       Exige que a classificacao da auditoria FECHE, dia a dia e classe a classe (parcial, sem
 *       registro, comparada), com a contagem que este ensaio faz sozinho: o operador nacional pelo
 *       arquivo dele, o registro pela integralizacao da `lib-ppc`.
 *   B · apaga um dia inteiro do registro                        -> restricao_sem_registro
 *       (aconteceu de verdade: 38 meias horas em jun-jul, seis a sete dias sem uma linha)
 *       exige: TODAS as meias horas restritas do operador no dia-cobaia viram "sem registro",
 *       numero contado no arquivo do operador, nao na classificacao da propria auditoria
 *   C · linhas ilegiveis no recorte, uma de cada tipo, logo depois do ULTIMO evento do dia
 *       (aconteceu de verdade: `11/09/20206`, 18 linhas invisiveis; e as linhas sem hora de
 *       25/09)                                                  -> linha_ilegivel
 *       exige: + uma por tipo, todas datadas no dia-cobaia pela vizinha de CIMA (a de baixo
 *       ja e do dia seguinte: e ali que os dois sentidos dao dias diferentes)
 *   D · desloca a potencia de um dia inteiro                    -> mediana_do_dia_fora
 *       (o caso que separa desalinhamento do dia de um setpoint perdido)
 *       exige: o dia-cobaia entra na lista de dias fora, e so ele
 *   E · a mesa volta a plena com o operador ainda limitando    -> restricao_sem_registro
 *       (o setpoint perdido: a outra metade do gatilho, a que o caso B nao alcanca)
 *       exige: as meias horas que o registro alterado cobre inteiras em plena, contadas pela
 *       mesma integralizacao (`lib-ppc`), viram "sem registro" com o operador restringindo
 *   F · a isencao do dia corrente, nos dois sentidos          -> linha_ilegivel / aviso
 *       exige: uma linha ilegivel no ULTIMO dia fechado do registro acusa (+1), e uma no dia
 *       de HOJE vai para o aviso (+1) e nao para o alarme
 *   Em todo caso, os OUTROS gatilhos ficam com a mesma contagem da linha de base: o defeito
 *   plantado acende o gatilho dele, nao um vermelho qualquer.
 *
 * 🔴 POR QUE A COMPARACAO E POR CONTAGEM, E NAO POR "O GATILHO JA ESTAVA ACESO".
 *    A versao anterior registrava QUAIS gatilhos a linha de base tinha e reprovava o caso cujo
 *    gatilho ja estivesse aceso ("o caso nao julga nada"). A intencao era certa — nao passar por
 *    vacuidade —, mas o efeito foi o oposto do desejado: todo achado REAL da planilha derrubava o
 *    caso correspondente, e o ensaio vermelho deixava SKIPPED justamente a auditoria que
 *    publicaria o achado. De 25/09 a 10/10/2026 essa regra derrubou 28 das 35 execucoes: C caiu
 *    com as linhas sem hora de 25/09, D com o 26/09 duplicado, B com a restricao sem registro de
 *    04/10 — e o `ppc_auditoria.json` ficou parado em 04/10. Agora o caso julga o DELTA do
 *    gatilho sobre a linha de base: um achado real nao o cala, e uma deteccao quebrada nao passa,
 *    porque o delta tem de ser exatamente o que o defeito plantado produz.
 *
 * 🔴 O DIA-COBAIA E UM DIA SEM ACHADO NA LINHA DE BASE e ANTERIOR ao ultimo dia auditado. Em
 *    30/09/2026 o dia mais restrito era o proprio 26/09 que ja estava fora da mediana, e o caso D
 *    nao tinha como julgar nada; em 27/09 o 26/09 estava depois do trecho auditado e B e D
 *    passaram calados. E o ultimo dia do registro, apagado no caso B, faria o trecho auditado
 *    recuar junto. A cobaia e o dia com mais eventos restritos entre os dias auditados ANTES do
 *    ultimo, sem restricao sem registro, fora da lista de mediana, e cujo setpoint restrito mais
 *    longo cobre ao menos uma meia hora inteira com o operador restringindo (o caso E precisa dele).
 *
 * ⚠️ Declarado, nao julgado: com o registro terminando antes do operador (coletor parado) e sem
 *    evento de hoje, a metade "linha de hoje vai para o aviso" do caso F e pulada, e o log diz isso.
 *
 * ⚠️ Declarado, nao julgado: o caso D desloca o dia INTEIRO, e por isso nao distingue a mediana
 *    do MIOLO da mediana de todas as meias horas (a escolha que a auditoria justifica pela borda).
 *
 * ⚠️ O ensaio NAO publica nada: a auditoria grava o relatorio numa pasta TEMPORARIA desta maquina
 *    (LOCAL_OUT_DIR), sem credencial do storage no ambiente. Um ensaio que publicasse o dado
 *    fabricado do caso B poria a mentira no ar para provar que sabe detecta-la. O relatorio e lido
 *    inteiro (o log so mostra tres itens de cada alarme, e a contagem do caso B passa de vinte).
 *
 * uso: node ensaio-ppc.js [<ppc_restricao.json gzipado>]
 *      sem argumento, ensaia contra o blob PUBLICADO — que e o artefato que a auditoria realmente
 *      le, e por isso o unico que prova alguma coisa sobre producao.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const P = require('./lib-ppc.js');

const ORIG = process.argv[2];
const BASE = 'https://rbenergydata.blob.core.windows.net/dados/';
const AUDITOR = path.join(__dirname, 'audita-ppc-ons.js');
const DE = process.env.PPC_DE || '2026-09-01';
const GATILHOS = ['restricao_sem_registro', 'linha_ilegivel', 'mediana_do_dia_fora'];
/* os tipos de linha que o LEITOR marca quando nao consegue ler data, hora ou potencia. Cada nome e
   conferido no fonte do `lib-ppc.js` antes de plantar: tipo que o leitor deixou de emitir reprova
   aqui, em vez de o caso C plantar um defeito que nao existe mais. */
const TIPOS_ILEGIVEIS = ['ano_impossivel', 'data_ilegivel', 'hora_ilegivel', 'pot_ilegivel'];
const HOJE = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);   // o mesmo corte da auditoria
/* 🔴 ppc-fase2 (23/10/2026): a auditoria roda aqui SEM credencial nenhuma, e desde o conteiner `dados` privado (21/10) ela nao le
   o arquivo do operador nacional pelo endereco publico (409): o ensaio caia na linha de base e a auditoria de verdade ficava
   SKIPPED. O ensaio grava o arquivo que ELE leu (o mesmo da contagem independente) e o entrega pelo ONS_LOCAL. */
let ONS_ARQ = null;

const leJson = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
const gravaJson = (p, o) => fs.writeFileSync(p, zlib.gzipSync(Buffer.from(JSON.stringify(o))));

/* roda o auditor sobre um registro e devolve { ok, saida, rel } — reprovar e o resultado esperado,
   entao nao estoura; mas auditoria que CAIU sem gravar relatorio (excecao, serie ausente) nao e
   reprovacao, e o caso falha dizendo isso. */
function roda(registro, rotulo) {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio_ppc_' + rotulo + '_'));
  const arq = path.join(pasta, 'registro.json');
  gravaJson(arq, registro);
  if (!ONS_ARQ) throw new Error('roda antes do arquivo do operador nacional');
  const env = Object.assign({}, process.env, { PPC_LOCAL: arq, ONS_LOCAL: ONS_ARQ, PPC_DE: DE, LOCAL_OUT_DIR: pasta });
  delete env.SECO;
  delete env.DADOS_STORAGE;   // sem credencial no ambiente: nem por engano o ensaio publica
  delete env.DADOS_SAS;       // nem a de leitura da maquina: a rodada local fica igual a do GitHub (ppc-fase2)
  delete env.AZURE_CLIENT_ID; delete env.AZURE_TENANT_ID;   // nem o OIDC do job, num workflow que grava sem a chave (lib-conteiner)
  let ok = true, saida;
  try { saida = execFileSync(process.execPath, [AUDITOR], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { ok = false; saida = String(e.stdout || '') + String(e.stderr || ''); }
  const relArq = path.join(pasta, 'ppc_auditoria.json');
  const rel = fs.existsSync(relArq) ? leJson(relArq) : null;
  try { fs.rmSync(pasta, { recursive: true, force: true }); } catch (e) { /* o ensaio nao falha por nao apagar o proprio rascunho */ }
  return { ok, saida, rel };
}

/* a saida da auditoria tem de concordar com o relatorio: reprovou <=> tem alarme. Uma auditoria
   que grava e depois quebra (no laco que imprime, por exemplo) sairia com codigo 1 e passaria aqui
   por "reprovou". */
function coerente(r) {
  if (!r.rel) {
    /* a ultima linha de uma pilha do Node e a versao dele; o que diz o motivo e a linha do erro */
    const erro = r.saida.split('\n').find((l) => /FALHOU|Error|erro/i.test(l)) || r.saida.trim().split('\n').pop();
    return 'a auditoria caiu sem relatorio: ' + erro.trim().slice(0, 200);
  }
  const n = (r.rel.alarmes || []).length;
  if (r.ok && n) return 'a auditoria saiu com sucesso e com ' + n + ' alarme(s) no relatorio';
  if (!r.ok && !n) return 'a auditoria saiu com erro e sem alarme no relatorio: ' + r.saida.trim().split('\n').pop().slice(0, 160);
  if (!r.ok && r.saida.indexOf('AUDITORIA REPROVOU') < 0) return 'a auditoria saiu com erro sem dizer que reprovou';
  /* e disse CADA alarme: uma queda no meio do laco que imprime deixa o cabecalho e cala o resto */
  const calado = (r.rel.alarmes || []).filter((a) => r.saida.indexOf(a.gatilho + ': ' + a.n + ' ocorrencia') < 0);
  if (calado.length) return 'a auditoria gravou ' + calado.map((a) => a.gatilho).join(', ') + ' e nao o disse no log (caiu ao imprimir?)';
  return null;
}

const nDe = (rel, g) => { const a = (rel.alarmes || []).find((x) => x.gatilho === g); return a ? a.n : 0; };
const nAviso = (rel, g) => { const a = (rel.avisos || []).find((x) => x.gatilho === g); return a ? a.n : 0; };
const diaDe = (rel, d) => (rel.dias || []).find((x) => x.dia === d) || null;
const diasFora = (rel) => { const a = (rel.alarmes || []).find((x) => x.gatilho === 'mediana_do_dia_fora');
  return new Set(a ? a.detalhe.map((x) => x.dia) : []); };

/* baixa um blob publicado. 🔴 So o 404 vira erro claro; qualquer outra falha de leitura estoura,
   porque ensaiar contra um arquivo pela metade diria "tudo bem" sobre nada. */
/* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`). So o 404 do PROPRIO blob vira a mensagem de "nao publicado";
   o 404 de conteiner sumido e o resto que a lib estoura saem com o texto dela. */
async function baixa(nome, msg404) {
  let r;
  try { r = await require('./lib-le-dados').pede(BASE + nome); } catch (e) { throw new Error('leitura de ' + nome + ' falhou: ' + e.message); }
  if (r.status === 404) throw new Error(msg404 || (nome + ' nao esta publicado'));
  let b = r.buf;
  if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b);
  try { return JSON.parse(b.toString('utf8')); } catch (e) { throw new Error(nome + ': JSON invalido: ' + e.message); }
}
/* 🔴 Esta mensagem existe porque a primeira rodada deste passo caiu assim e o log dizia so
   "HTTP 404". A falha e legitima — sem registro nao ha o que auditar, e calar seria pior —, mas ela
   aponta para FORA deste repositorio: quem parou foi a ponte que sobe a planilha. Mensagem que nao
   diz onde olhar faz procurar defeito no lugar errado. */
const MSG_SEM_REGISTRO = 'o registro do PPC nao esta publicado. Isto NAO se conserta aqui: quem alimenta '
  + 'o container e o coletor que roda na maquina onde a planilha esta sincronizada. '
  + 'Conferir se a tarefa agendada dele ainda roda.';

(async () => {
for (const t of TIPOS_ILEGIVEIS) {
  if (fs.readFileSync(path.join(__dirname, 'lib-ppc.js'), 'utf8').indexOf("'" + t + "'") < 0) {
    throw new Error('o leitor (lib-ppc.js) nao emite mais o tipo ' + t + ': rever a lista do caso C');
  }
}
const base = ORIG ? leJson(ORIG) : await baixa('ppc_restricao.json', MSG_SEM_REGISTRO);
const copia = () => JSON.parse(JSON.stringify(base));

/* ── a contagem INDEPENDENTE: meias horas restritas do operador, direto do arquivo dele ───── */
const ons0 = await baixa('ons_restricao_all.json');
const serie = ons0.consolidado || ons0.linhas || ons0.serie;
if (!Array.isArray(serie) || !serie.length) throw new Error('o arquivo do operador nacional veio sem serie');
const pastaOns = fs.mkdtempSync(path.join(os.tmpdir(), 'ensaio_ppc_ons_'));
ONS_ARQ = path.join(pastaOns, 'ons_restricao_all.json');
gravaJson(ONS_ARQ, ons0);
process.on('exit', () => { try { fs.rmSync(pastaOns, { recursive: true, force: true }); } catch (e) { /* rascunho */ } });
const onsLim = new Map();   // chave 'AAAA-MM-DD HH:MM' -> limite; a ultima linha da chave vale, como na auditoria
for (const r of serie) {
  const ts = String(r.ts || '');
  if (ts.slice(0, 10) < DE) continue;
  onsLim.set(ts.slice(0, 10) + ' ' + ts.slice(11, 16), (r.lim === '' || r.lim == null) ? null : Number(r.lim));
}
const restrOns = (k) => { const l = onsLim.get(k); return l != null && l < P.PLENA - P.FOLGA; };
const contaOns = (dia) => [...onsLim.keys()].filter((k) => k.slice(0, 10) === dia && restrOns(k)).length;

/* ── A · a linha de base, MEDIDA ─────────────────────────────────────────────────────────── */
const A = roda(copia(), 'A');
const incoA = coerente(A);
if (incoA) throw new Error('linha de base: ' + incoA);
const reais = GATILHOS.filter((g) => nDe(A.rel, g) > 0);
console.log('ENSAIO DA AUDITORIA DO PPC · recorte ' + DE + ' · auditado ate ' + A.rel.auditado_ate);
if (!reais.length) console.log('  OK   A · linha de base -> passou limpo');
else {
  /* ⚠️ nao e falha do ensaio: e a auditoria acusando a PLANILHA, que e o trabalho dela. Fica como
     linha de base; os casos seguintes julgam o que o defeito plantado ACRESCENTA por cima. */
  console.log('  ℹ️  A · linha de base -> achado REAL na planilha: '
    + reais.map((g) => g + ' ' + nDe(A.rel, g)).join(', ') + ' (nao e falha do ensaio; a auditoria vai publica-lo)');
}
/* toda meia hora restrita do operador cai numa e so numa classe, e cada classe se conta aqui sem a
   auditoria: o operador pelo arquivo dele, o registro pela MESMA integralizacao (`lib-ppc`):
     parcial          o registro cobre o slot so em parte;
     sem registro     o registro nao cobre o slot, ou cobre inteiro e marca plena;
     comparada        o registro cobre inteiro e restringe (casa + diverge).
   Um defeito que mude a classificacao EM TODO DIA (criterio de restricao mais raso, borda parcial
   contada como sem registro) encolhe ou incha a base e os casos juntos, e o delta fecharia; so a
   contagem de fora o ve. */
const slotsBase = P.integraliza(base.eventos.filter((e) => e.dia >= DE));
const contaClasses = (dia) => {
  const c = { parcial: 0, so_ons: 0, comparada: 0 };
  for (const k of onsLim.keys()) {
    if (k.slice(0, 10) !== dia || !restrOns(k)) continue;
    const s = slotsBase.get(k);
    if (!s) c.so_ons += 1;
    else if (s.cobertura < 1) c.parcial += 1;
    else if (s.pot >= P.PLENA - P.FOLGA) c.so_ons += 1;
    else c.comparada += 1;
  }
  return c;
};
const naoFecha = [];
for (const d of (A.rel.dias || [])) {
  const c = contaClasses(d.dia);
  if (d.parcial !== c.parcial || d.so_ons !== c.so_ons || d.casa + d.diverge !== c.comparada) {
    naoFecha.push(d.dia + ' (auditoria parcial ' + d.parcial + '/sem registro ' + d.so_ons + '/comparada ' + (d.casa + d.diverge)
      + '; conta de fora ' + c.parcial + '/' + c.so_ons + '/' + c.comparada + ')');
  }
}
if (naoFecha.length) {
  console.error('  FALHA A · a classificacao da auditoria nao fecha com as meias horas restritas do operador em '
    + naoFecha.length + ' dia(s): ' + naoFecha.slice(0, 4).join(', '));
  console.error('ENSAIO REPROVOU na linha de base.'); process.exit(1);
}

/* ── G · a serie por meia hora (`meias_horas`, lote painel-mesa-ons, 20/10/2026) ─────────────
   A tela do portal desenha o mapa dia x meia hora e a lista do que corrigir a partir dela; o placar por dia continua sendo o que
   reprova. As duas tem de contar a MESMA coisa: uma serie que perde, duplica ou troca de classe uma meia hora poria na tela um
   achado que a auditoria nao tem (ou esconderia o que ela tem). Confere, sem a auditoria:
     · cada meia hora uma vez so, dentro do trecho auditado;
     · por dia e por classe, a contagem da serie = o placar (casa, diverge de borda e de miolo, parcial, sem registro, sem lastro,
       livre);
     · cada meia hora restrita do operador esta na serie, com o limite dele e a classe que a integralizacao da `lib-ppc` da
       (contada aqui: sem registro, parcial, plena, ou casa/diverge pela tolerancia publicada), e a potencia do registro dela;
     · meia hora sem limite do operador so entra como livre ou sem lastro;
     · as meias horas "sem registro" sao as do alarme.
   E o conferidor e ensaiado: quatro defeitos plantados num relatorio copiado (meia hora apagada, duplicada, de classe trocada e
   com o limite errado) TEM de ser acusados, ou o ensaio reprova por o conferidor nao pegar o defeito. */
const r3 = (x) => (x == null ? null : Math.round(x * 1000) / 1000);
function confereMeias(rel, slots) {
  const M = rel.meias_horas, prob = [];
  if (!Array.isArray(M)) return ['o relatorio nao tem meias_horas'];
  const visto = new Map();
  for (const m of M) {
    if (visto.has(m.ts)) prob.push('meia hora repetida ' + m.ts);
    visto.set(m.ts, m);
    if (m.ts.slice(0, 10) < DE || m.ts.slice(0, 10) > rel.auditado_ate) prob.push('meia hora fora do trecho auditado ' + m.ts);
  }
  for (const d of (rel.dias || [])) {
    const c = { casa: 0, diverge: 0, borda: 0, miolo: 0, parcial: 0, sem_registro: 0, sem_lastro: 0, livre: 0 };
    for (const m of M) {
      if (m.ts.slice(0, 10) !== d.dia) continue;
      c[m.c] = (c[m.c] || 0) + 1;
      if (m.c === 'diverge') c[m.pos === 'MIOLO' ? 'miolo' : 'borda'] += 1;
    }
    const placar = { casa: d.casa, diverge: d.diverge, borda: d.div_borda, miolo: d.div_miolo, parcial: d.parcial,
      sem_registro: d.so_ons, sem_lastro: d.so_registro, livre: d.livres };
    const fora = Object.keys(placar).filter((k) => c[k] !== placar[k]);
    if (fora.length) prob.push(d.dia + ': a serie nao fecha com o placar em ' + fora.map((k) => k + ' ' + c[k] + '/' + placar[k]).join(', '));
  }
  for (const k of onsLim.keys()) {
    if (k.slice(0, 10) > rel.auditado_ate || !restrOns(k)) continue;
    const m = visto.get(k), s = slots.get(k), lim = onsLim.get(k);
    const esp = !s ? 'sem_registro' : s.cobertura < 1 ? 'parcial' : s.pot >= P.PLENA - P.FOLGA ? 'sem_registro'
      : (Math.abs(s.pot - lim) <= rel.tolerancia_mw ? 'casa' : 'diverge');
    if (!m) { prob.push(k + ': meia hora restrita do operador fora da serie'); continue; }
    if (m.c !== esp) prob.push(k + ': classe ' + m.c + ', a contagem de fora da ' + esp);
    if (m.ons_mw !== r3(lim)) prob.push(k + ': limite ' + m.ons_mw + ' na serie, ' + r3(lim) + ' no arquivo do operador');
    if (m.reg_mw !== (s ? r3(s.pot) : null)) prob.push(k + ': registro ' + m.reg_mw + ' na serie, ' + (s ? r3(s.pot) : null) + ' na integralizacao');
  }
  for (const m of M) if (m.ons_mw == null && ['livre', 'sem_lastro'].indexOf(m.c) < 0) prob.push(m.ts + ': classe ' + m.c + ' sem limite do operador');
  const al = (rel.alarmes || []).find((a) => a.gatilho === 'restricao_sem_registro');
  if (!al || al.n <= 20) {
    const a = new Set(al ? al.detalhe.map((x) => x.ts) : []), b = new Set(M.filter((m) => m.c === 'sem_registro').map((m) => m.ts));
    if (a.size !== b.size || [...a].some((t) => !b.has(t))) prob.push('as meias horas sem registro da serie nao sao as do alarme');
  }
  return prob;
}
const probG = confereMeias(A.rel, slotsBase);
if (probG.length) {
  console.error('  FALHA G · a serie por meia hora nao fecha: ' + probG.slice(0, 4).join(' | ') + (probG.length > 4 ? ' (+' + (probG.length - 4) + ')' : ''));
  console.error('ENSAIO REPROVOU na linha de base.'); process.exit(1);
}
{
  const relCopia = () => JSON.parse(JSON.stringify(A.rel));
  const iC = A.rel.meias_horas.findIndex((m) => m.c === 'casa'), iR = A.rel.meias_horas.findIndex((m) => m.ons_mw != null);
  const plantios = [
    ['meia hora apagada', (r) => { r.meias_horas.splice(iR, 1); }],
    ['meia hora duplicada', (r) => { r.meias_horas.push(Object.assign({}, r.meias_horas[iR])); }],
    ['classe trocada (casa -> diverge)', (r) => { r.meias_horas[iC].c = 'diverge'; }],
    ['limite do operador errado (+5 MW)', (r) => { r.meias_horas[iR].ons_mw = r3(r.meias_horas[iR].ons_mw + 5); }],
  ];
  const calado = plantios.filter(([, f]) => { const r = relCopia(); f(r); return !confereMeias(r, slotsBase).length; }).map(([n]) => n);
  if (iC < 0 || iR < 0 || calado.length) {
    console.error('  FALHA G · o conferidor da serie nao pega o defeito plantado: ' + (calado.join(', ') || 'sem meia hora para plantar'));
    console.error('ENSAIO REPROVOU.'); process.exit(1);
  }
  console.log('  OK   G · serie por meia hora: ' + A.rel.meias_horas.length + ' meias horas fecham com o placar e com a contagem de fora;'
    + ' os ' + plantios.length + ' defeitos plantados no relatorio foram acusados');
}

/* ── o dia-cobaia ────────────────────────────────────────────────────────────────────────── */
const foraA = diasFora(A.rel);
const evDia = new Map();
for (const e of base.eventos) { if (!evDia.has(e.dia)) evDia.set(e.dia, []); evDia.get(e.dia).push(e); }
/* o setpoint restrito mais longo do dia (minutos ate o proximo evento do mesmo dia) */
const maisLongo = (dia) => {
  const l = evDia.get(dia) || []; let melhor = null;
  for (let i = 0; i + 1 < l.length; i++) {
    const dur = l[i + 1].min - l[i].min;
    if (l[i].restr && l[i].linha != null && (!melhor || dur > melhor.dur)) melhor = { i, dur };
  }
  return melhor;
};
/* o caso E: o setpoint restrito mais longo do dia vira plena. O valor plantado fica na BORDA do
   criterio de plena da lib (>= PLENA - FOLGA), nao em PLENA: a media da integralizacao de 343,77
   sai 343,77000000000027 e nao distinguiria ">=" de ">" no ramo "registro marca plena". Quantas
   meias horas isso tira do registro sai da MESMA integralizacao que a auditoria usa, contra o
   operador contado aqui: slot inteiro em plena com o operador restringindo. */
const PLANTA_PLENA = P.PLENA - P.FOLGA / 2;
const trocaE = (dia) => {
  const ml = maisLongo(dia);
  if (!ml) return null;
  const linha = evDia.get(dia)[ml.i].linha;
  const mod = evDia.get(dia).map((e) => (e.linha === linha ? Object.assign({}, e, { pot: PLANTA_PLENA, restr: 0 }) : e));
  const esperado = [...P.integraliza(mod)].filter(([k, s]) => restrOns(k) && s.cobertura >= 1 && s.pot >= P.PLENA - P.FOLGA).length;
  return { linha, esperado };
};
const nRestr = (dia) => (evDia.get(dia) || []).filter((e) => e.restr).length;
const exclusao = new Map();
const exclui = (motivo) => { exclusao.set(motivo, (exclusao.get(motivo) || 0) + 1); return false; };
const candidatos = (A.rel.dias || []).filter((d) => {
  if (d.dia >= A.rel.auditado_ate) return exclui('ultimo dia auditado ou depois');
  if (d.so_ons !== 0) return exclui('ja tem restricao sem registro');
  if (foraA.has(d.dia)) return exclui('ja esta fora da mediana');
  if (d.mediana_miolo_mw == null || (d.casa + d.diverge) === 0) return exclui('sem restricao comparada nas duas rotas');
  const t = trocaE(d.dia);
  if (!t || t.esperado < 1) return exclui('sem setpoint restrito que cubra uma meia hora inteira com o operador restringindo');
  return true;
}).sort((a, b) => (nRestr(b.dia) - nRestr(a.dia)) || (a.dia < b.dia ? -1 : 1));
if (!candidatos.length) {
  /* sem cobaia, a distribuicao diz quem a tirou: 39 de 39 dias "ja tem restricao sem registro"
     aponta para a auditoria, nao para a planilha */
  throw new Error('nao ha dia-cobaia. Exclusoes: ' + [...exclusao].map(([m, n]) => m + ' ' + n).join(', ')
    + ' (de ' + (A.rel.dias || []).length + ' dias). Uma exclusao em quase todos os dias e suspeita de defeito da auditoria.');
}
const alvo = candidatos[0].dia;
const aAlvo = diaDe(A.rel, alvo);
const onsAlvo = contaOns(alvo);
console.log('  dia-cobaia ' + alvo + ' (' + nRestr(alvo) + ' eventos restritos; ' + onsAlvo + ' meias horas restritas do operador;'
  + ' na base: casa ' + aAlvo.casa + ', diverge ' + aAlvo.diverge + ', parcial ' + aAlvo.parcial + ', sem registro 0)');

/* linhas novas no registro: entram logo depois da linha `apos`, e todas as linhas abaixo descem,
   como na planilha */
function insereLinhas(j, apos, novas) {
  for (const e of j.eventos) if (e.linha != null && e.linha > apos) e.linha += novas.length;
  for (const d of (j.defeitos || [])) if (d.linha != null && d.linha > apos) d.linha += novas.length;
  const postas = novas.map((x, i) => Object.assign({ linha: apos + 1 + i }, x));
  j.defeitos = (j.defeitos || []).concat(postas);
  return postas;
}
const ultimaLinha = (j, dia) => Math.max(...j.eventos.filter((e) => e.dia === dia && e.linha != null).map((e) => e.linha));

/* ── os casos plantados ──────────────────────────────────────────────────────────────────── */
const casos = [];

let slotsB = null;
casos.push({ nome: 'B · um dia some do registro', espera: 'restricao_sem_registro',
  monta: (j) => { j.eventos = j.eventos.filter((e) => e.dia !== alvo); slotsB = P.integraliza(j.eventos.filter((e) => e.dia >= DE)); return j; },
  julga: (rel) => {
    const d = diaDe(rel, alvo);
    const ganho = nDe(rel, 'restricao_sem_registro') - nDe(A.rel, 'restricao_sem_registro');
    if (!d) return 'o dia-cobaia saiu do trecho auditado';
    if (d.so_ons !== onsAlvo) return 'o dia-cobaia tem ' + d.so_ons + ' meia(s) hora(s) sem registro; o operador restringiu ' + onsAlvo;
    if (ganho !== onsAlvo) return 'o gatilho cresceu ' + ganho + ' sobre a base; esperava ' + onsAlvo;
    /* G no defeito: a serie por meia hora acompanha o placar, e o dia-cobaia inteiro vira "sem registro" sem potencia do registro */
    const sB = (rel.meias_horas || []).filter((m) => m.ts.slice(0, 10) === alvo && m.ons_mw != null);
    if (sB.length !== onsAlvo || sB.some((m) => m.c !== 'sem_registro' || m.reg_mw !== null)) return 'a serie por meia hora do dia-cobaia nao virou "sem registro" ('
      + sB.map((m) => m.c).join(',') + ')';
    const pG = confereMeias(rel, slotsB);
    if (pG.length) return 'a serie por meia hora nao fecha com o registro alterado: ' + pG[0];
    return null;
  } });

let plantadasC = [];
casos.push({ nome: 'C · linhas ilegiveis no recorte', espera: 'linha_ilegivel',
  monta: (j) => {
    /* logo depois do ULTIMO evento do dia-cobaia: a vizinha de cima e do dia-cobaia, a de baixo
       (que desce junto) ja e do dia seguinte. O auditor promete datar pela de cima. */
    plantadasC = insereLinhas(j, ultimaLinha(j, alvo),
      TIPOS_ILEGIVEIS.map((t) => ({ tipo: t, valor: t === 'ano_impossivel' ? '11/09/20206' : '' })));
    return j;
  },
  julga: (rel) => {
    const ganho = nDe(rel, 'linha_ilegivel') - nDe(A.rel, 'linha_ilegivel');
    if (ganho !== plantadasC.length) return 'o gatilho cresceu ' + ganho + ' sobre a base; esperava ' + plantadasC.length + ' (uma por tipo)';
    for (const p of plantadasC) {
      const achada = (rel.defeitos || []).find((d) => d.linha === p.linha && d.tipo === p.tipo);
      if (!achada) return 'a linha plantada ' + p.tipo + ' nao aparece nos defeitos do relatorio';
      if (achada.dia_aprox !== alvo) return 'a linha plantada ' + p.tipo + ' foi datada em ' + achada.dia_aprox + '; esperava ' + alvo;
    }
    return null;
  } });

casos.push({ nome: 'D · o dia inteiro deslocado', espera: 'mediana_do_dia_fora',
  monta: (j) => {
    /* o deslocamento sai do limiar que a auditoria PUBLICA: seis vezes ele, para a mediana do miolo
       (0 na base) passar com folga; sem cruzar a plena, porque um setpoint empurrado para acima
       dela deixaria de ser restricao e acenderia outro gatilho */
    const s = 6 * A.rel.tolerancia_mediana_dia_mw;
    for (const e of j.eventos) if (e.dia === alvo && e.restr) e.pot = Math.min(e.pot + s, P.PLENA - 1);
    return j;
  },
  julga: (rel) => {
    const fora = diasFora(rel);
    if (!fora.has(alvo)) return 'o dia-cobaia nao entrou na lista de dias fora';
    const novos = [...fora].filter((d) => !foraA.has(d));
    if (novos.length !== 1) return 'entraram ' + novos.length + ' dias novos na lista (' + novos.join(', ') + '); esperava so ' + alvo;
    const d = diaDe(rel, alvo);
    if (!(d.mediana_miolo_mw > rel.tolerancia_mediana_dia_mw)) return 'a mediana do miolo do dia-cobaia ficou em ' + d.mediana_miolo_mw + ' MW';
    return null;
  } });

let esperadoE = null;
casos.push({ nome: 'E · a mesa volta a plena com o operador limitando', espera: 'restricao_sem_registro',
  monta: (j) => {
    /* a troca e o esperado sao os de `trocaE`, que ja escolheu a cobaia com esperado >= 1 */
    const t = trocaE(alvo);
    const ev = j.eventos.find((e) => e.dia === alvo && e.linha === t.linha);
    ev.pot = PLANTA_PLENA; ev.restr = 0;
    esperadoE = t.esperado;
    return j;
  },
  /* ⚠️ Um setpoint que domina o dia, virando plena, deixa poucas meias horas de miolo, e as de borda
     mistas podem levar a mediana do miolo DO DIA-COBAIA acima do limiar (medido pelo revisor: 01/09 e
     30/09). E a resposta certa da auditoria ao defeito plantado; o que nao se aceita e outro dia
     entrar na lista. */
  tolera: (g, rel) => g === 'mediana_do_dia_fora' && [...foraA].every((d) => diasFora(rel).has(d))
    && [...diasFora(rel)].filter((d) => !foraA.has(d)).every((d) => d === alvo),
  julga: (rel) => {
    if (!(esperadoE >= 1)) return 'o setpoint trocado nao cobre nenhuma meia hora inteira: o caso nao julgaria nada';
    const d = diaDe(rel, alvo);
    const ganho = nDe(rel, 'restricao_sem_registro') - nDe(A.rel, 'restricao_sem_registro');
    if (!d || d.so_ons !== esperadoE) return 'o dia-cobaia tem ' + (d ? d.so_ons : 'nenhuma') + ' meia(s) hora(s) sem registro; esperava ' + esperadoE;
    if (ganho !== esperadoE) return 'o gatilho cresceu ' + ganho + ' sobre a base; esperava ' + esperadoE;
    return null;
  } });

let plantadasF = null;
casos.push({ nome: 'F · a isencao do dia corrente', espera: 'linha_ilegivel',
  monta: (j) => {
    /* uma linha no ULTIMO dia fechado (o anterior a hoje) e outra no dia de HOJE. Sem evento de
       hoje no registro, entra um evento de hoje em plena, que fica fora do trecho auditado
       (o operador so publica o dia seguinte) e so serve para datar a linha. */
    const dias = [...new Set(j.eventos.map((e) => e.dia))].sort();
    const fechados = dias.filter((d) => d < HOJE && d >= DE);
    const ultFechado = fechados[fechados.length - 1];
    let comHoje = true;
    if (!j.eventos.some((e) => e.dia === HOJE)) {
      /* ⚠️ o evento de hoje estende o fim do registro, e o trecho auditado e o menor dos dois fins.
         Se o registro parou ANTES do operador, ele abriria dias novos na auditoria e acenderia
         outro gatilho: nesse caso a metade de hoje nao e julgada, e o log diz isso. */
      const fimOns = [...onsLim.keys()].sort().pop().slice(0, 10);
      if (dias[dias.length - 1] < fimOns) comHoje = false;
      else {
        const maxL = Math.max(...j.eventos.filter((e) => e.linha != null).map((e) => e.linha));
        j.eventos.push({ dia: HOJE, min: 360, ts: HOJE + ' 06:00', ms: P.msDe(HOJE, 360), pot: P.PLENA, restr: 0,
          motivo: '', motivo_cod: '', linha: maxL + 1 });
      }
    }
    const fechada = insereLinhas(j, ultimaLinha(j, ultFechado), [{ tipo: 'hora_ilegivel', valor: '' }])[0];
    const deHoje = comHoje ? insereLinhas(j, ultimaLinha(j, HOJE), [{ tipo: 'hora_ilegivel', valor: '' }])[0] : null;
    if (!comHoje) console.log('  ⚠️  F · o registro termina antes do operador e nao tem evento de hoje: so a metade do dia fechado e julgada');
    plantadasF = { ultFechado, fechada, deHoje };
    return j;
  },
  julga: (rel) => {
    const ganho = nDe(rel, 'linha_ilegivel') - nDe(A.rel, 'linha_ilegivel');
    const ganhoAviso = nAviso(rel, 'linha_ilegivel_dia_corrente') - nAviso(A.rel, 'linha_ilegivel_dia_corrente');
    const f = (rel.defeitos || []).find((d) => d.linha === plantadasF.fechada.linha);
    if (!f || f.dia_aprox !== plantadasF.ultFechado) return 'a linha do ultimo dia fechado foi datada em ' + (f && f.dia_aprox) + '; esperava ' + plantadasF.ultFechado;
    if (ganho !== 1) return 'o alarme cresceu ' + ganho + '; esperava 1 (a linha do dia fechado ' + plantadasF.ultFechado + ' acusa, a de hoje nao)';
    if (!plantadasF.deHoje) return null;
    const h = (rel.defeitos || []).find((d) => d.linha === plantadasF.deHoje.linha);
    if (!h || h.dia_aprox !== HOJE) return 'a linha de hoje foi datada em ' + (h && h.dia_aprox) + '; esperava ' + HOJE;
    if (ganhoAviso !== 1) return 'o aviso do dia corrente cresceu ' + ganhoAviso + '; esperava 1';
    return null;
  } });

let mau = 0;
for (const c of casos) {
  const r = roda(c.monta(copia()), c.nome.slice(0, 1));
  const inco = coerente(r);
  if (inco) { mau += 1; console.log('  FALHA ' + c.nome + ' -> ' + inco); continue; }
  if (r.ok) { mau += 1; console.log('  FALHA ' + c.nome + ' -> o defeito PASSOU sem alarme'); continue; }
  const motivo = c.julga(r.rel);
  /* os outros gatilhos nao se mexem: o defeito plantado acende o DELE */
  const mudou = GATILHOS.filter((g) => g !== c.espera && nDe(r.rel, g) !== nDe(A.rel, g));
  const tolerado = mudou.filter((g) => c.tolera && c.tolera(g, r.rel));
  const mexeu = mudou.filter((g) => tolerado.indexOf(g) < 0).map((g) => g + ' ' + nDe(A.rel, g) + ' -> ' + nDe(r.rel, g));
  if (motivo) { mau += 1; console.log('  FALHA ' + c.nome + ' -> ' + c.espera + ': ' + motivo); continue; }
  if (mexeu.length) { mau += 1; console.log('  FALHA ' + c.nome + ' -> acendeu tambem outro gatilho: ' + mexeu.join(', ')); continue; }
  console.log('  OK   ' + c.nome + ' -> ' + c.espera + ' ' + nDe(A.rel, c.espera) + ' -> ' + nDe(r.rel, c.espera)
    + (tolerado.length ? ' (e ' + tolerado.join(', ') + ' so no dia-cobaia, tolerado)' : ''));
}

/* ⚠️ A auditoria recalcula o "hoje" a cada rodada. Uma rodada que atravesse a meia-noite de Brasilia
   (03:00Z; o cron e 18:17Z, so um disparo manual cai nisso) mudaria o dia corrente no meio dos casos,
   e o F e a contagem de linhas ilegiveis deixariam de comparar a mesma coisa. */
const hojeFim = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
if (hojeFim !== HOJE) {
  console.error('ENSAIO INCONCLUSIVO: a rodada atravessou a meia-noite de Brasilia (' + HOJE + ' -> ' + hojeFim
    + '). Nao e defeito da auditoria nem da planilha: rodar de novo.');
  process.exit(1);
}
if (mau) { console.error('ENSAIO REPROVOU em ' + mau + ' caso(s).'); process.exit(1); }
console.log('ensaio: os ' + casos.length + ' casos plantados acenderam o gatilho certo, na quantidade certa, sobre a linha de base'
  + (reais.length ? ' com achado real' : ' limpa') + '.');
})().catch((e) => { console.error('FALHOU: ' + e.message); process.exit(1); });
