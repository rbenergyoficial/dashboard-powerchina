'use strict';
/*
 * ensaio-janela-conjunto.js — PROMOVER janela-restricao (26/10/2026). Julga a lib-janela-conjunto, a fiação dela no gen-executivo e no
 * aviso, e (com --produto, depois de gerar) o executivo publicado.
 *
 * REGRA (sem rede): a janela comum é o último instante do conjunto; a linha igual a ele fica, a seguinte sai, contada por dia; o `desde`
 * vem da publicação anterior; o calendário (Páscoa de 2024 a 2028, Carnaval, Corpus Christi, os feriados nacionais com a lei); o dia
 * completo sem limitação (48 meias horas, nenhuma com `lim` > 0, a partir do `desde`); o aviso com o título fixo por dia e o `soSeNova`.
 * PLANTIOS na lib (cada um tem de reprovar): a linha do último instante cortada; o `desde` não carregado; o dia incompleto avisado; o
 * feriado esquecido; o título do aviso com a hora (dedup quebrado).
 * FIAÇÃO: o gerador lê a lib, corta os DOIS pontos de leitura do detalhe por usina e publica `dias_sem_conjunto`; o executivo.yml roda o
 * ensaio de regra antes do gerador (no gate), o de produto depois e o aviso no fim, com `issues: write`. E o aviso EXECUTADO com o dado e o
 * alerta forjados: o domingo completo sem limitação avisa uma vez, o dia anterior ao `desde`, o incompleto e o com limitação não.
 * PRODUTO (--produto): todo dia de `dias_sem_conjunto` passa do último instante do conjunto publicado e não tem linha no `ref_dia_ufv`
 * nem no `corte_diario_ufv`; e a segunda rota: o detalhe por usina do mês aberto, contado aqui contra o conjunto, dá a mesma lista
 * (salvo quando um dos dois arquivos foi regravado depois do executivo: "não julgado", dito no log).
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const AQUI = __dirname;
const LIB = path.join(AQUI, 'lib-janela-conjunto.js');
const R = [], F = [], PLANTIOS = [];
const ok = (cond, nome) => { R.push(nome); if (!cond) F.push(nome); };
const carrega = (src) => { const m = new module.constructor(); m.paths = module.paths; m._compile(src, LIB); return m.exports; };
const FONTE = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n');
const L = carrega(FONTE);

/* um dia do conjunto: 48 meias horas, com limitação nas que `lim` mandar */
const dia = (d, lim = []) => Array.from({ length: 48 }, (_, i) => ({ ts: d + ' ' + String(Math.floor(i / 2)).padStart(2, '0') + ':' + (i % 2 ? '30' : '00') + ':00',
  lim: lim.includes(i) ? '1' : '' }));

const AVISO = process.argv.includes('--aviso');   // revisor-workflow RW-002: a parte do aviso não barra o gerador
function julga(lib, rot) {
  const f = [];
  const c = (cond, n) => { if (!cond) f.push(n); };
  if (AVISO) return julgaAviso(lib, f, c, rot);
  const conj = dia('2026-10-24', [20]).concat(dia('2026-10-25', [24]).slice(0, 10));
  c(lib.janelaComum(conj) === '2026-10-25 04:30:00', 'a janela comum é o último instante do conjunto');
  c(lib.janelaComum([{ ts: 'lixo' }, { ts: '2026-10-01 00:00:00' }]) === '2026-10-01 00:00:00', 'linha sem data não entra na janela');
  const usina = dia('2026-10-25').concat(dia('2026-10-26').slice(0, 3)).flatMap((r) => ['CEFMT1', 'CEFMT2'].map((u) => ({ ts: r.ts, u })));
  const k = lib.cortaJanela(usina, '2026-10-25 04:30:00');
  c(k.dentro.length === 20 && k.dentro.every((r) => r.ts <= '2026-10-25 04:30:00'), 'a linha igual ao último instante fica, a seguinte sai');
  c(k.fora.get('2026-10-25') === 76 && k.fora.get('2026-10-26') === 6, 'as linhas de fora contadas por dia');
  c(lib.cortaJanela(usina, '').dentro.length === usina.length, 'sem conjunto, nada sai (janela vazia não corta)');
  const L1 = lib.diasSemConjunto(k.fora, { '2026-10-25': '2026-10-26T16:46:00Z' }, '2026-10-26T19:00:00Z', '2026-10-25 04:30:00');
  c(L1.length === 2 && L1[0].dia === '2026-10-25' && L1[0].desde === '2026-10-26T16:46:00Z' && L1[1].desde === '2026-10-26T19:00:00Z'
    && L1.every((x) => x.motivo === lib.MOTIVO_SEM_CONJUNTO && x.conjunto_ate === '2026-10-25 04:30:00'), 'o desde vem da publicação anterior; o dia novo, do agora');
  // o cortador que o gerador chama (RE-002): corta, conta por dia, e a mesma linha lida duas vezes conta uma
  const K = lib.cortador('2026-10-25 04:30:00'), d1 = K.corta(usina), d2 = K.corta(usina);
  c(d1.length === 20 && d2.length === 20 && K.fora.get('2026-10-25') === 76 && K.fora.get('2026-10-26') === 6 && K.fora.size === 2,
    'o cortador corta, conta por dia, e a leitura repetida não dobra a conta');
  const K0 = lib.cortador(''); c(K0.corta(usina).length === usina.length && K0.fora.size === 0, 'o cortador sem conjunto não corta nem conta');
  // a carga do desde da publicação anterior (RE-003)
  const D0 = lib.desdeAnterior({ dias_sem_conjunto: [{ dia: '2026-10-25', desde: '2026-10-26T16:46:00Z' }, { dia: '2026-10-26' }] });
  c(D0['2026-10-25'] === '2026-10-26T16:46:00Z' && !('2026-10-26' in D0) && Object.keys(lib.desdeAnterior(null)).length === 0
    && Object.keys(lib.desdeAnterior({ ref_dias_retidos: [{ dia: 'x', desde: 'y' }] })).length === 0, 'o desde da publicação anterior, só da lista desta regra');
  if (rot) f.forEach((x) => console.log('   ' + rot + ': ' + x));
  return f;
}
function julgaAviso(lib, f, c, rot) {
  const P = { 2024: '2024-03-31', 2025: '2025-04-20', 2026: '2026-04-05', 2027: '2027-03-28', 2028: '2028-04-16' };
  c(Object.entries(P).every(([a, d]) => lib.pascoa(+a) === d), 'a Páscoa de 2024 a 2028');
  const F26 = lib.feriados(2026);
  c(/Carnaval/.test(F26['2026-02-16']) && /Carnaval/.test(F26['2026-02-17']) && /Corpus/.test(F26['2026-06-04']), 'Carnaval e Corpus Christi de 2026');
  c(/6\.802\/1980/.test(F26['2026-10-12']) && /14\.759\/2023/.test(F26['2026-11-20']) && /662\/1949/.test(F26['2026-09-07'])
    && Object.keys(F26).length === 12, 'os 9 feriados nacionais com a lei e os 3 pontos facultativos');
  c(lib.tipoDoDia('2026-06-13').tipo === 'fim_de_semana' && lib.tipoDoDia('2026-10-25').tipo === 'fim_de_semana'
    && lib.tipoDoDia('2026-10-26').tipo === 'util' && lib.tipoDoDia('2026-10-12').tipo === 'feriado', 'o tipo do dia (sábado, domingo, útil, feriado)');
  const conj2 = dia('2026-10-24').concat(dia('2026-10-25', [30]), dia('2026-10-26'), dia('2026-10-27').slice(0, 47), dia('2026-10-28'));
  const S = lib.diasSemRestricao(conj2, { desde: '2026-10-25' });
  c(S.map((x) => x.dia).join() === '2026-10-26,2026-10-28', 'completo sem limitação, a partir do desde (fora: o anterior, o com limitação, o incompleto)');
  const a1 = lib.avisoDoDia({ dia: '2026-10-25', tipo: 'fim_de_semana', nome: 'domingo' }), a2 = lib.avisoDoDia({ dia: '2026-10-26', tipo: 'util', nome: 'dia útil' });
  c(a1.chave === 'dia-sem-restricao-2026-10-25' && a1.soSeNova === true && /^\D*Dia completo sem restrição do operador · 25\/10\/2026$/.test(a1.titulo)
    && /Incomum/.test(a1.corpo) && /pontual/.test(a2.corpo) && !/Incomum/.test(a2.corpo), 'o aviso: título fixo por dia, soSeNova, incomum só fora do dia útil');
  if (rot) f.forEach((x) => console.log('   ' + rot + ': ' + x));
  return f;
}

console.log('ensaio-janela-conjunto · regra');
const f0 = julga(L);
f0.forEach((x) => F.push('regra: ' + x)); R.push('regra (' + f0.length + ' falhas)');
console.log('   ' + (f0.length ? f0.length + ' falha(s): ' + f0.join('; ') : 'a lib passa em todos os casos'));

/* plantios na lib: cada um tem de reprovar a regra */
const PL = (AVISO ? [] : [
  ['a linha do último instante cortada', "if (tsMax && t > tsMax)", "if (tsMax && t >= tsMax)"],
  ['o desde não carregado', "desde: (desdeAntes && desdeAntes[dia]) || agoraIso", "desde: agoraIso"],
  ['o cortador que não corta', "c.fora.forEach((n, d) => fora.set(d, Math.max(fora.get(d) || 0, n))); return c.dentro; }", "c.fora.forEach((n, d) => fora.set(d, Math.max(fora.get(d) || 0, n))); return linhas; }"],
  ['o cortador que não conta', "c.fora.forEach((n, d) => fora.set(d, Math.max(fora.get(d) || 0, n))); return c.dentro; }", "return c.dentro; }"],
  ['o cortador que soma a leitura repetida', "fora.set(d, Math.max(fora.get(d) || 0, n))", "fora.set(d, (fora.get(d) || 0) + n)"],
  ['a carga do desde que ignora a publicação anterior', "  ((publicado && publicado.dias_sem_conjunto) || []).forEach", "  ([]).forEach"],
]).concat(!AVISO ? [] : [
  ['o dia incompleto avisado', "o.ts.size === 48 && o.lim === 0", "o.ts.size >= 40 && o.lim === 0"],
  ['o feriado esquecido', "  if (F[dia]) return { tipo: 'feriado', nome: F[dia] };\n", ''],
  ['o título do aviso com a hora (dedup quebrado)', "titulo: 'Dia completo sem restrição do operador · ' + dataBR,", "titulo: 'Dia completo sem restrição do operador · ' + dataBR + ' ' + new Date().toISOString(),"],
]);
for (const [nome, de, para] of PL) {
  PLANTIOS.push(nome);
  if (FONTE.split(de).length !== 2) { F.push('plantio sem âncora: ' + nome); continue; }
  let lib; try { lib = carrega(FONTE.replace(de, para)); } catch (e) { F.push('plantio não compila: ' + nome); continue; }
  const f = julga(lib);
  if (!f.length) F.push('o plantio PASSOU (devia reprovar): ' + nome);
  console.log('   plantio "' + nome + '": ' + (f.length ? 'reprovou (' + f[0] + ')' : 'NAO reprovou'));
}

/* a fiação no gerador, no aviso e no workflow */
const ler = (n) => fs.readFileSync(path.join(AQUI, n), 'utf8').replace(/\r\n/g, '\n');
const gen = ler('gen-executivo.js'), av = ler('alerta-sem-restricao.js'), wf = fs.readFileSync(path.join(AQUI, '..', '.github', 'workflows', 'executivo.yml'), 'utf8').replace(/\r\n/g, '\n');
const FIOS_GEN = [
  ["require('./lib-janela-conjunto.js')", 'o gerador lê a lib'],
  ['JC.janelaComum(restr.consolidado), CORTE = JC.cortador(TS_CONJ)', 'a janela comum e o cortador saem do arquivo do conjunto'],
  ["CRU_LIDO[mes] = CORTE.corta((await getJSON(BASE + 'ons_irradiancia_'", 'o detalhe lido no topo passa pelo cortador'],
  ["CRU[mes] = CRU_LIDO[mes] || CORTE.corta((await getJSON(BASE + 'ons_irradiancia_'", 'o detalhe lido no laço do CRU passa pelo cortador'],
  ['desdeAntes = JC.desdeAnterior(await getJSON(BASE + OUT_BLOB))', 'o desde carregado pela lib, da publicação anterior'],
  ['JC.diasSemConjunto(CORTE.fora, desdeAntes', 'a lista com os dias que o cortador contou'],
  ['dias_sem_conjunto: diasSemConj,', 'o campo publicado'],
  ['conjunto_ate: TS_CONJ', 'o último instante do conjunto publicado'],
];
// toda leitura do detalhe por usina (fora dos comentários) passa pelo cortador: nenhuma terceira leitura, de nenhuma forma
const codigo = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const fiaGen = (s) => { const c = codigo(s), todas = (c.match(/ons_irradiancia_/g) || []).length, cortadas = (c.match(/CORTE\.corta\(\(await getJSON\(BASE \+ 'ons_irradiancia_'/g) || []).length;
  return FIOS_GEN.filter(([x]) => !s.includes(x)).map(([, n]) => n).concat(todas !== cortadas || cortadas !== 2 ? ['uma leitura do detalhe por usina fora do cortador (' + cortadas + ' de ' + todas + ')'] : []); };
const fg = AVISO ? [] : fiaGen(gen);
fg.forEach((x) => F.push('fiação do gerador: ' + x)); if (!AVISO) R.push('fiação do gerador');
const contra = [
  ['a leitura do topo sem o cortador', "CRU_LIDO[mes] = CORTE.corta((await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado)", "CRU_LIDO[mes] = (await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado"],
  ['o laço do CRU sem o cortador', "CRU[mes] = CRU_LIDO[mes] || CORTE.corta((await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado)", "CRU[mes] = CRU_LIDO[mes] || (await getJSON(BASE + 'ons_irradiancia_' + mes.replace('-', '_') + '.json')).consolidado"],
  ['uma terceira leitura do detalhe em template', "  const RC = require('./lib-ref-conjunto.js');", "  const RC = require('./lib-ref-conjunto.js'); const _x = (m) => getJSON(BASE + `ons_irradiancia_${m}.json`);"],
  ['o desde sem a lib', 'desdeAntes = JC.desdeAnterior(await getJSON(BASE + OUT_BLOB))', 'desdeAntes = {}; await getJSON(BASE + OUT_BLOB)'],
];
if (!AVISO) contra.forEach(([n, de, para]) => { const t = gen.replace(de, para); if (t === gen || !fiaGen(t).length) F.push('a conferência da fiação não acusa: ' + n); });
if (!AVISO) console.log('   fiação no gen-executivo: ' + (FIOS_GEN.length - fg.length) + ' de ' + FIOS_GEN.length + (fg.length ? ' (falta: ' + fg.join('; ') + ')' : '')
  + ' · contraprovas acusadas: ' + contra.filter(([, de, para]) => { const t = gen.replace(de, para); return t !== gen && fiaGen(t).length; }).length + ' de ' + contra.length);
const FIOS_AV = [["require('./lib-janela-conjunto.js')", 'o aviso lê a lib'], ['JC.diasSemRestricao(restr.consolidado, { desde })', 'o dia sai da regra da lib'], ['[DESDE, menosDias(hoje, RECENTE_D)].sort().pop()', 'o desde é o do lote ou o dos últimos dias, o mais recente'],
  ['JC.avisoDoDia(x)', 'o texto e o dedup saem da lib']];
if (AVISO) FIOS_AV.filter(([x]) => !av.includes(x)).forEach(([, n]) => F.push('fiação do aviso: ' + n));
const passo = (re) => re.test(wf);
const FIOS_WF = AVISO ? [[/issues: write/, 'issues: write nas permissões do job'], [/run: node scripts\/ensaio-janela-conjunto\.js --aviso\n/, 'o ensaio do aviso'],
  [/if: \$\{\{ !cancelled\(\) && steps\.jc_aviso\.outcome == 'success' \}\}\n(?:\s+[a-z-]+:[^\n]*\n)*?\s+env:[\s\S]*?run: node scripts\/alerta-sem-restricao\.js/, 'o aviso no gate do ensaio do aviso, sem continue-on-error']]
  : [[/run: node scripts\/ensaio-janela-conjunto\.js\n/, 'o ensaio da janela'],
  [/id: gen_exec\n\s+if: \$\{\{[^\n]*steps\.jc_regra\.outcome == 'success'/, 'o gerador no gate do ensaio da janela'],
  [/if: \$\{\{ !cancelled\(\) && steps\.gen_exec\.outcome == 'success' \}\}\n\s+env:\n[^\n]*DADOS_LEITURA[^\n]*\n\s+run: node scripts\/ensaio-janela-conjunto\.js --produto/, 'o ensaio de produto depois do gerador']];
FIOS_WF.filter(([re]) => !passo(re)).forEach(([, n]) => F.push('fiação do executivo.yml: ' + n));
if (AVISO && /continue-on-error[^\n]*\n(?:\s+[a-zA-Z_-]+:[^\n]*\n)*?\s+run: node scripts\/alerta-sem-restricao\.js/.test(wf)) F.push('fiação do executivo.yml: o aviso com continue-on-error (falha calada)');
console.log('   fiação no aviso: ' + (FIOS_AV.length - FIOS_AV.filter(([x]) => !av.includes(x)).length) + ' de ' + FIOS_AV.length
  + ' · no executivo.yml: ' + (FIOS_WF.length - FIOS_WF.filter(([re]) => !passo(re)).length) + ' de ' + FIOS_WF.length);

/* o aviso EXECUTADO com o dado e o alerta forjados */
async function executa() {
  if (!AVISO) return;
  const AV = require('./alerta-sem-restricao.js'), chamadas = [];
  const conj = { consolidado: dia('2026-10-25').concat(dia('2026-11-01'), dia('2026-11-02', [10]), dia('2026-11-03').slice(0, 40), dia('2026-11-04')) };
  const r = await AV.main({ hoje: '2026-11-04', alerta: async (a) => { chamadas.push(a); return { webhook: '-', issue: 'abriu #1', email: 'enviado para x@y' }; }, le: async () => conj });
  ok(chamadas.length === 2 && chamadas[0].chave === 'dia-sem-restricao-2026-11-01' && chamadas.every((a) => a.soSeNova === true) && /Incomum/.test(chamadas[0].corpo)
    && chamadas[1].chave === 'dia-sem-restricao-2026-11-04' && /pontual/.test(chamadas[1].corpo),
    'executado: o domingo 01/11 avisa como incomum e a quarta 04/11 como pontual; 25/10 (antes do desde), 02/11 (com limitação) e 03/11 (incompleto) não');
  console.log('   aviso executado: ' + chamadas.length + ' chamada(s) · ' + chamadas.map((a) => a.chave).join(', ') + ' · dias julgados: ' + r.dias.map((x) => x.dia).join(', '));
  ok(!JSON.stringify(r.avisos).includes('x@y') && r.falhas.length === 0, 'executado: o destinatário não vai ao log; o e-mail que saiu não é falha');
  const vazio = await AV.main({ hoje: '2026-11-04', alerta: async () => { throw new Error('não devia chamar'); }, le: async () => ({ consolidado: dia('2026-10-26', [5]) }) });
  ok(vazio.dias.length === 0, 'executado: sem dia completo sem limitação, nenhum canal');
  const velho = await AV.main({ hoje: '2026-11-20', alerta: async () => { throw new Error('não devia chamar'); }, le: async () => conj });
  ok(velho.dias.length === 0, 'executado: o dia mais velho que ' + AV.RECENTE_D + ' dias não é reavaliado (a issue fechada não reenvia)');
  const falho = await AV.main({ hoje: '2026-11-04', alerta: async () => ({ webhook: '-', issue: 'abriu #2', email: 'FALHOU: Graph 503' }), le: async () => conj });
  const tratado = await AV.main({ hoje: '2026-11-04', alerta: async () => ({ webhook: '-', issue: 'ja aberta #2', email: '-' }), le: async () => conj });
  ok(falho.falhas.length === 2 && tratado.falhas.length === 0, 'executado: o e-mail que falha é falha (a issue aberta não conta como entrega); a issue já aberta, rodada seguinte, é dia tratado');
}

/* ── PRODUTO ─────────────────────────────────────────────────────────────────────────────────────────────────────────── */
async function produto() {
  const LD = require('./lib-le-dados');
  const pega = async (n) => { const x = await LD.pede('https://rbenergydata.blob.core.windows.net/dados/' + n); if (x.status !== 200) throw new Error(x.status + ' ' + n);
    let b = x.buf; if (b[0] === 0x1f && b[1] === 0x8b) b = zlib.gunzipSync(b); return { j: JSON.parse(b.toString('utf8').replace(/^﻿/, '')), mod: x.ultimaMod || (x.meta && x.meta.ultimaMod) || null }; };
  // ENSAIO_EXEC_LOCAL (só no ensaio local, antes de publicar): o executivo gerado em disco no lugar do publicado
  const E = process.env.ENSAIO_EXEC_LOCAL ? JSON.parse(fs.readFileSync(process.env.ENSAIO_EXEC_LOCAL, 'utf8')) : (await pega('executivo.json')).j, C = await pega('ons_restricao_all.json');
  if (!Array.isArray(E.dias_sem_conjunto) || !E.conjunto_ate) { F.push('produto: o executivo publicado sem `dias_sem_conjunto` ou sem `conjunto_ate` (os dois são sempre emitidos)'); return; }
  const tsC = E.conjunto_ate, dsc = E.dias_sem_conjunto, diaC = tsC.slice(0, 10), agora = L.janelaComum(C.j.consolidado);
  // 🔴 A CONFERÊNCIA DIRETA (revisor-ensaio RE-001): nenhuma série por dia que vem do detalhe passa do último instante do conjunto que o
  //    gerador leu. Não depende da lista nem de arquivo regravado: o conjunto só cresce, e o `conjunto_ate` é o que o gerador usou.
  const SERIES = ['ref_dia_ufv', 'corte_diario_ufv'], alem = SERIES.map((k) => [k, (E[k] || []).filter((r) => r && r.dia > diaC).length]).filter(([, n]) => n);
  ok(!alem.length && agora >= tsC, 'produto: nenhuma linha do ref_dia_ufv nem do corte por usina passa do conjunto que o gerador leu (' + tsC + ')');
  console.log('   produto · direto: ' + SERIES.map((k) => k + ' ' + (E[k] || []).length + ' linhas').join(', ') + ', nenhuma depois de ' + diaC
    + (alem.length ? ' · ERRADO: ' + alem.map(([k, n]) => k + ' ' + n).join(', ') : '') + ' · o conjunto agora vai até ' + agora);
  const desdeMal = dsc.filter((x) => !(Date.parse(x.desde) <= Date.parse(E.atualizado)));
  ok(!desdeMal.length, 'produto: todo desde é anterior ou igual à publicação');
  const mal = dsc.filter((x) => !(x.dia >= tsC.slice(0, 10)) || E.ref_dia_ufv.some((r) => r.dia === x.dia) || (E.corte_diario_ufv || []).some((r) => r.dia === x.dia && r.dia > tsC.slice(0, 10)));
  ok(!mal.length, 'produto: os dias sem conjunto passam do conjunto e não estão no ref_dia_ufv nem no corte por usina');
  console.log('   produto: ' + dsc.length + ' dia(s) sem conjunto ' + JSON.stringify(dsc.map((x) => x.dia)) + ' · o conjunto vai até ' + tsC + (mal.length ? ' · ERRADOS: ' + mal.map((x) => x.dia).join(', ') : ''));
  // a segunda rota: o detalhe do mês do último instante do conjunto (e do seguinte, se existir), contado aqui
  const mes = tsC.slice(0, 7), seg = new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 1)).toISOString().slice(0, 7);
  const fora = new Map(); let regravado = false;
  for (const m of [mes, seg]) {
    let d; try { d = await pega('ons_irradiancia_' + m.replace('-', '_') + '.json'); } catch (e) { if (/\b404\b/.test(e.message)) continue; throw e; }
    if (d.mod && Date.parse(d.mod) > Date.parse(E.atualizado)) regravado = true;
    L.cortaJanela(d.j.consolidado, tsC).fora.forEach((n, k) => fora.set(k, n));
  }
  if (C.mod && Date.parse(C.mod) > Date.parse(E.atualizado)) regravado = true;
  const a = [...fora.keys()].sort().join(), b = dsc.map((x) => x.dia).sort().join();
  if (regravado) console.log('   produto · segunda rota: NAO JULGADA (um dos arquivos do operador foi regravado depois do executivo; a conferência direta acima julgou)');
  else { ok(a === b, 'produto · segunda rota: o detalhe contado aqui dá a mesma lista que o executivo publicou'); console.log('   produto · segunda rota: aqui [' + a + '] x publicado [' + b + ']'); }
}

function fim() {
  if (F.length) { console.error('ensaio-janela-conjunto' + (process.argv.includes('--produto') ? ' --produto' : '') + ': REPROVADO\n - ' + F.join('\n - ')); process.exit(1); }
  console.log('ensaio-janela-conjunto' + (process.argv.includes('--produto') ? ' --produto' : '') + ': ' + R.length + ' casos e ' + PLANTIOS.length + ' plantios · TUDO PASSOU');
}
executa().then(() => (process.argv.includes('--produto') ? produto() : null)).then(fim, (e) => { console.error('ensaio-janela-conjunto: ' + e.message); process.exit(1); });
