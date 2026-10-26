'use strict';
/*
 * ensaio-portao-gemeo.js — o portao de calibracao do corte por gemeo (`lib-portao-gemeo.js`): so meses FECHADOS entram no
 * MAE, no vies e no pior mes (PROMOVER gemeo-mes-fechado, 11/10/2026).
 *
 *   --lib      A REGRA, antes do gemeo: casos forjados e os numeros REAIS de 11/10 (a rodada das 15:40Z reprovou com o mes
 *              aberto a -42 %); defeitos plantados na lib; a fiacao no gerador. Sem rede.
 *   --produto  O PRODUTO, depois do gemeo: o `corte_gemeo.json` publicado tem o mes em curso (pelo proprio `gerado_em`)
 *              marcado e fora da conta, e o MAE, o vies, o pior mes e a contagem refeitos dos meses fechados fecham com o
 *              publicado no centesimo. Le so blob publico (ou BASE_DADOS=<pasta local>).
 *
 * POR QUE EXISTE. Calibrado em 20/08/2026 sobre seis meses fechados, o portao passou a receber o mes em curso desde o dia
 * 1. Em 11/10, com 9 dias e 83 h de restricao, o veredito virou entre rodadas do mesmo dia so com a republicacao do
 * operador (14:47Z passou, 15:40Z reprovou, 18h passaria), e o blob ficou parado nas reprovadas.
 */
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const LD = require('./lib-le-dados');   // Fase 2: leitura de `dados` com credencial
const PRODUTO = process.argv.includes('--produto');
const f = [];
const fim = (nome) => { if (f.length) { console.error('\nREPROVADO:'); f.forEach((x) => console.error('   🔴 ' + x)); process.exit(1); }
  console.log('\nensaio-portao-gemeo' + nome + ' · TUDO PASSOU'); };
const r2 = (v) => Math.round(v * 100) / 100;

/* ================================ PRODUTO ================================ */
if (PRODUTO) {
  const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';
  const deJson = (buf) => JSON.parse((buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : buf).toString('utf8'));
  const pega = (nome) => (!/^https?:/.test(BASE) ? Promise.resolve(deJson(fs.readFileSync(path.join(BASE, nome))))
    /* Fase 2: o transporte e o da lib-le-dados (credencial para `dados`) */
    : LD.pede(BASE + nome, { 'accept-encoding': 'gzip' }).then((x) => {
      if (x.status !== 200) throw new Error(nome + ': HTTP ' + x.status);
      return deJson(x.buf);
    }));
  (async () => {
    const G = await pega('corte_gemeo.json');
    const V = G.validacao || {}, P = V.pares || [];
    // o mes em curso escrito AQUI, sem a lib: BRT = UTC-3
    const aberto = new Date(Date.parse(G.gerado_em) - 3 * 3600e3).toISOString().slice(0, 7);
    P.forEach((p) => { if (p.aberto !== 0 && p.aberto !== 1) f.push(p.mes + ': o par nao diz se e o mes em curso (aberto = ' + p.aberto + ')'); });
    P.filter((p) => p.aberto === 1 && p.mes !== aberto).forEach((p) => f.push(p.mes + ' marcado como em curso, mas o mes em curso de ' + G.gerado_em + ' e ' + aberto));
    P.filter((p) => p.mes === aberto && p.aberto !== 1).forEach((p) => f.push(p.mes + ' e o mes em curso e entrou na conta'));
    const F = P.filter((p) => p.mes !== aberto);
    const mae = F.length ? r2(F.reduce((a, p) => a + Math.abs(p.erro_pct), 0) / F.length) : null;
    const vies = F.length ? r2(F.reduce((a, p) => a + p.erro_pct, 0) / F.length) : null;
    const pior = F.length ? r2(Math.max(...F.map((p) => Math.abs(p.erro_pct)))) : null;
    if (V.meses !== F.length) f.push('meses: publicado ' + V.meses + ', fechados nos pares ' + F.length);
    if (V.mae_pct !== mae) f.push('MAE: publicado ' + V.mae_pct + ', refeito dos fechados ' + mae);
    if (V.vies_pct !== vies) f.push('vies: publicado ' + V.vies_pct + ', refeito dos fechados ' + vies);
    if (V.pior_mes_pct !== pior) f.push('pior mes: publicado ' + V.pior_mes_pct + ', refeito dos fechados ' + pior);
    if ((V.mes_em_curso_fora || null) !== (P.some((p) => p.mes === aberto) ? aberto : null)) f.push('mes_em_curso_fora = ' + V.mes_em_curso_fora + ', esperado ' + aberto);
    if (F.length < 4) f.push('so ' + F.length + ' mes(es) fechado(s): o portao nao podia ter gravado');
    if (!(mae <= V.limite_mae_pct && Math.abs(vies) <= V.limite_vies_pct)) f.push('o blob foi gravado com o portao fora dos limites (MAE ' + mae + ', vies ' + vies + ')');
    console.log('   ' + G.gerado_em + ' · mes em curso ' + aberto + ' · ' + F.length + ' meses fechados · MAE ' + mae + ' % · vies ' + vies + ' % · pior ' + pior + ' %');
    // a guarda da entrada (26/10/2026): o bloco existe e fecha; e, mes a mes, o laco do corte contou exatamente as restritas menos as
    // que a guarda diz que ficaram fora (a segunda rota: `intervalos` vem do laco, `por_mes` da guarda). Mes incompleto AVISA, nao reprova.
    const E = G.entrada;
    if (!E || !Array.isArray(E.por_mes) || !Array.isArray(E.meses_incompletos)) f.push('o corte_gemeo.json publicado nao tem o bloco `entrada`');
    else {
      const soma = (k) => E.por_mes.reduce((a, o) => a + o[k], 0);
      if (E.restritas !== soma('restritos') || E.sem_irradiancia !== soma('sem_irr') || E.sem_geracao !== soma('sem_ger')) f.push('entrada: os totais nao fecham com por_mes');
      const inc = E.por_mes.filter((o) => o.sem_irr + o.sem_ger > 0).map((o) => o.mes);
      if (JSON.stringify(inc) !== JSON.stringify(E.meses_incompletos)) f.push('entrada: meses_incompletos ' + JSON.stringify(E.meses_incompletos) + ', por_mes diz ' + JSON.stringify(inc));
      const S = {}; (G.serie || []).forEach((s) => { S[s.mes] = s; });
      E.por_mes.forEach((o) => { const esp = o.restritos - o.sem_irr - o.sem_ger, s = S[o.mes];
        if ((s ? s.intervalos : 0) !== esp) f.push(o.mes + ': o corte contou ' + (s ? s.intervalos : 0) + ' meias horas restritas, a guarda diz ' + esp); });
      (G.serie || []).forEach((s) => { if (!E.por_mes.some((o) => o.mes === s.mes)) f.push(s.mes + ': mes na serie sem linha na guarda'); });
      E.por_mes.filter((o) => o.sem_irr + o.sem_ger > 0).forEach((o) => console.error('::warning::corte_gemeo: ' + o.mes + ' INCOMPLETO · '
        + o.sem_irr + ' sem irradiancia e ' + o.sem_ger + ' sem geracao, de ' + o.restritos + ' meias horas restritas'));
      console.log('   entrada: ' + E.restritas + ' meias horas restritas · ' + E.sem_irradiancia + ' sem irradiancia · ' + E.sem_geracao
        + ' sem geracao · incompletos ' + (E.meses_incompletos.join(', ') || 'nenhum'));
    }
    fim(' --produto');
  })().catch((e) => { console.error('ensaio-portao-gemeo --produto: ' + e.message); process.exit(1); });
  return;
}

/* ================================ REGRA ================================ */
const FONTE = path.join(__dirname, 'lib-portao-gemeo.js');
const src = fs.readFileSync(FONTE, 'utf8').replace(/\r\n/g, '\n');
function compila(s) { const m = { exports: {} }; new Function('module', 'exports', 'require', s)(m, m.exports, require); return m.exports; }
// os pares REAIS da rodada das 15:40Z de 11/10/2026 (ons-consolidado 38152291942): o mes em curso a -42,04 %
const ONS = { '2026-03': 14.62, '2026-04': 15.29, '2026-05': 15.62, '2026-06': 8.72, '2026-07': 14.79, '2026-08': 17.32, '2026-09': 21.45, '2026-10': 8.42 };
const MOD = { '2026-03': 15.17, '2026-04': 13.57, '2026-05': 14.31, '2026-06': 8.72, '2026-07': 14.17, '2026-08': 18.97, '2026-09': 18.34, '2026-10': 4.88 };
const serie = (meses, mod) => meses.map((m) => ({ mes: m, corte_gwh: (mod || MOD)[m] }));
// a entrada da guarda: set/26 com uma restrita sem irradiancia e uma sem geracao; out/26 com uma sem as duas; jun/26 so sem geracao;
// ago/26 completo; jul/26 so com livres (inclusive livre sem irradiancia, que nao e da guarda)
const ENT = [
  { mes: '2026-07', restrito: 0, irr: null, ger: 10 }, { mes: '2026-07', restrito: 0, irr: 500, ger: 200 },
  { mes: '2026-08', restrito: 1, irr: 800, ger: 150 }, { mes: '2026-08', restrito: 1, irr: 0, ger: 0 },
  { mes: '2026-09', restrito: 1, irr: 700, ger: 120 }, { mes: '2026-09', restrito: 1, irr: null, ger: 90 },
  { mes: '2026-09', restrito: 1, irr: 650, ger: null }, { mes: '2026-09', restrito: 1, irr: 600, ger: 100 },
  { mes: '2026-09', restrito: 0, irr: null, ger: null },
  { mes: '2026-10', restrito: 1, irr: null, ger: null }, { mes: '2026-10', restrito: 1, irr: 300, ger: 40 },
  { mes: '2026-06', restrito: 1, irr: 500, ger: null }, { mes: '2026-06', restrito: 1, irr: 520, ger: 210 },
];
const TODOS = Object.keys(ONS);
const CASOS = {
  '15:40 real: o mes aberto a -42 % fica fora e o portao passa': (L) => { const r = L.valida(serie(TODOS), ONS, '2026-10', 12, 8);
    return r.reprova === null && r.impossivel === null && r.validacao.meses === 7 && r.validacao.mae_pct === 7.37 && r.validacao.vies_pct === -3.58
      && r.validacao.pior_mes_pct === 14.5 && r.validacao.mes_em_curso_fora === '2026-10'; },
  'o mes aberto continua nos pares, marcado (o portal mostra o apurado dele)': (L) => { const p = L.valida(serie(TODOS), ONS, '2026-10', 12, 8).validacao.pares;
    return p.length === 8 && p.find((x) => x.mes === '2026-10').aberto === 1 && p.filter((x) => x.aberto === 0).length === 7; },
  'mes fechado ruim reprova (setembro a -60 %)': (L) => L.valida(serie(TODOS, Object.assign({}, MOD, { '2026-09': 8.58 })), ONS, '2026-10', 12, 8).reprova !== null,
  'vies NEGATIVO alem do limite reprova': (L) => { const mod = {}; TODOS.forEach((m) => { mod[m] = r2(ONS[m] * 0.9); });
    const r = L.valida(serie(TODOS, mod), ONS, '2026-11', 12, 8); return r.reprova !== null && r.validacao.vies_pct < -8; },
  'borda: vies de exatamente 8 % passa, 8,01 % reprova': (L) => {
    const um = (k) => { const mod = {}; ['2026-03', '2026-04', '2026-05', '2026-06'].forEach((m) => { mod[m] = ONS[m] * (1 + k / 100); }); return mod; };
    const s4 = (mod) => ['2026-03', '2026-04', '2026-05', '2026-06'].map((m) => ({ mes: m, corte_gwh: mod[m] }));
    return L.valida(s4(um(8)), ONS, '2026-11', 12, 8).reprova === null && L.valida(s4(um(8.01)), ONS, '2026-11', 12, 8).reprova !== null; },
  'tres fechados e o aberto: impossivel, o aberto nao completa a conta': (L) => {
    const r = L.valida(serie(['2026-07', '2026-08', '2026-09', '2026-10']), ONS, '2026-10', 12, 8); return r.impossivel !== null && r.validacao.meses === 3; },
  'sem o mes em curso no benchmark: nada marcado, mes_em_curso_fora nulo': (L) => { const r = L.valida(serie(TODOS.slice(0, 7)), ONS, '2026-10', 12, 8);
    return r.validacao.mes_em_curso_fora === null && r.validacao.pares.every((p) => p.aberto === 0) && r.validacao.meses === 7; },
  'o mes em curso e o de Brasilia (UTC-3) na virada': (L) => L.mesEmCurso(Date.parse('2026-11-01T02:59:00Z')) === '2026-10'
    && L.mesEmCurso(Date.parse('2026-11-01T03:00:00Z')) === '2026-11',
  // a guarda da entrada (26/10/2026): a meia hora restrita sem irradiancia ou sem geracao e contada, uma vez so, e marca o mes
  'entrada: restrita sem irradiancia e sem geracao contam, a livre nao': (L) => { const r = L.semEntrada(ENT);
    const s = r.por_mes.find((o) => o.mes === '2026-09');
    return s.restritos === 4 && s.sem_irr === 1 && s.sem_ger === 1 && JSON.stringify(r.incompletos) === '["2026-06","2026-09","2026-10"]'; },
  'entrada: mes so com geracao faltando tambem e incompleto': (L) => { const r = L.semEntrada(ENT); const s = r.por_mes.find((o) => o.mes === '2026-06');
    return s.sem_irr === 0 && s.sem_ger === 1 && r.incompletos.includes('2026-06'); },
  'entrada: sem irradiancia E sem geracao conta uma vez so (em sem_irr)': (L) => { const s = L.semEntrada(ENT).por_mes.find((o) => o.mes === '2026-10');
    return s.restritos === 2 && s.sem_irr === 1 && s.sem_ger === 0; },
  'entrada: mes completo fica fora de incompletos, mas aparece em por_mes': (L) => { const r = L.semEntrada(ENT);
    return r.por_mes.some((o) => o.mes === '2026-08' && o.sem_irr === 0 && o.sem_ger === 0) && !r.incompletos.includes('2026-08'); },
  'entrada: mes so com meias horas livres nao aparece': (L) => !L.semEntrada(ENT).por_mes.some((o) => o.mes === '2026-07'),
  'entrada: irradiancia ZERO e valor, nao falta (a noite com restricao conta como completa)': (L) =>
    L.semEntrada([{ mes: '2026-11', restrito: 1, irr: 0, ger: 0 }]).incompletos.length === 0,
};
const julga = (L) => Object.entries(CASOS).map(([n, fn]) => { let ok; try { ok = fn(L) === true; } catch (e) { ok = false; } return [n, ok]; });
const R = julga(compila(src));
R.forEach(([n, o]) => console.log('   ' + (o ? 'ok ' : '🔴 ') + n));
R.filter(([, o]) => !o).forEach(([n]) => f.push('a regra errou: ' + n));

const PLANTIOS = [
  ['o mes aberto na conta (a regra de antes)', 'const F = pares.filter((p) => !p.aberto);', 'const F = pares;', ['15:40 real: o mes aberto a -42 % fica fora e o portao passa']],
  ['o mes em curso pelo relogio UTC', 'new Date(agoraMs - 3 * 3600e3)', 'new Date(agoraMs)', ['o mes em curso e o de Brasilia (UTC-3) na virada']],
  ['so o vies positivo', 'Math.abs(vies) > maxVies', 'vies > maxVies', ['vies NEGATIVO alem do limite reprova']],
  ['limite exclusivo', 'Math.abs(vies) > maxVies', 'Math.abs(vies) >= maxVies', ['borda: vies de exatamente 8 % passa, 8,01 % reprova']],
  ['o aberto conta para o minimo de quatro', 'const impossivel = F.length < 4', 'const impossivel = pares.length < 4', ['tres fechados e o aberto: impossivel, o aberto nao completa a conta']],
  ['o aberto sai dos pares', "aberto: s.mes === mesAberto ? 1 : 0 }));", "aberto: s.mes === mesAberto ? 1 : 0 })).filter((p) => !p.aberto);",
    ['o mes aberto continua nos pares, marcado (o portal mostra o apurado dele)']],
  ['a guarda conta a livre tambem', '    if (!t.restrito) continue;\n', '', ['entrada: restrita sem irradiancia e sem geracao contam, a livre nao',
    'entrada: mes so com meias horas livres nao aparece']],
  ['sem geracao nao conta', '    else if (t.ger == null) o.sem_ger++;', '', ['entrada: restrita sem irradiancia e sem geracao contam, a livre nao']],
  ['a meia hora sem as duas conta duas vezes', '    else if (t.ger == null) o.sem_ger++;', '    if (t.ger == null) o.sem_ger++;',
    ['entrada: sem irradiancia E sem geracao conta uma vez so (em sem_irr)']],
  ['irradiancia zero como falta', '    if (t.irr == null) o.sem_irr++;', '    if (!t.irr) o.sem_irr++;',
    ['entrada: irradiancia ZERO e valor, nao falta (a noite com restricao conta como completa)']],
  ['o mes incompleto nao e marcado', 'incompletos: por_mes.filter((o) => o.sem_irr + o.sem_ger > 0)', 'incompletos: por_mes.filter((o) => o.sem_irr > 0)',
    ['entrada: mes so com geracao faltando tambem e incompleto']],
];
for (const [nome, de, para, devem] of PLANTIOS) {
  const n = src.split(de).length - 1;
  if (n !== 1) { f.push('plantio "' + nome + '": o trecho aparece ' + n + ' vez(es)'); continue; }
  let caidos; try { caidos = julga(compila(src.replace(de, para))).filter(([, o]) => !o).map(([x]) => x); } catch (e) { caidos = ['(nao compila)']; }
  const faltou = devem.filter((d) => !caidos.includes(d));
  console.log('   plantio "' + nome + '": reprova ' + caidos.length + ' caso(s)');
  if (faltou.length) f.push('plantio "' + nome + '" nao reprovou: ' + faltou.join('; '));
}

/* a fiacao: o gerador usa a lib e nao guarda a conta antiga; o produto (--produto, depois do gemeo) prova o resto */
const ger = fs.readFileSync(path.join(__dirname, 'gen-corte-gemeo.js'), 'utf8').replace(/\r\n/g, '\n');
const fia = (g) => [
  [/^const PG = require\('\.\/lib-portao-gemeo\.js'\);/m.test(g), 'sem o require da lib'],
  [/= PG\.valida\(serie, verdade, MES_ABERTO, MAX_MAE, MAX_VIES\);/.test(g), 'o portao nao sai de PG.valida'],
  [/const MES_ABERTO = process\.env\.MES_EM_CURSO \|\| PG\.mesEmCurso\(Date\.now\(\)\);/.test(g), 'o mes em curso nao sai de PG.mesEmCurso'],
  [!/pares\.reduce\(/.test(g), 'a conta antiga sobre todos os pares segue no gerador'],
  [/if \(impossivel\) throw new Error\(impossivel\);/.test(g), 'a validacao impossivel nao derruba sempre'],
  [/const ENT = PG\.semEntrada\(T\);/.test(g), 'a guarda da entrada nao conta sobre as linhas do conjunto (PG.semEntrada(T))'],
  [/::warning::gemeo: /.test(g), 'o mes incompleto nao vira aviso na rodada'],
  [/meses_incompletos: ENT\.incompletos, por_mes: ENT\.por_mes/.test(g), 'o bloco `entrada` nao publica os meses incompletos'],
  [/if \(!t\.restrito \|\| t\.irr == null \|\| t\.ger == null\) continue;/.test(g), 'o laco do corte mudou: a guarda conta o que ele pula, rever as duas'],
].filter(([ok]) => !ok).map(([, m]) => m);
fia(ger).forEach((m) => f.push('fiacao: ' + m));
console.log('   fiacao no gerador: ' + (fia(ger).length ? fia(ger).length + ' problema(s)' : 'ok'));
if (!fia(ger.replace('if (impossivel) throw new Error(impossivel);', 'if (impossivel && !process.env.SEM_PORTAO) throw new Error(impossivel);')).length)
  f.push('a fiacao nao acusa o gerador que deixa o SEM_PORTAO gravar validacao impossivel');
fim(': ' + R.length + ' casos, ' + PLANTIOS.length + ' plantios e a fiacao');
