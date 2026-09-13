/*
 * ensaio-fechamento-dia.js — a serie por DIA fecha com a serie por MES, nos dois blobs.
 *
 * POR QUE EXISTE. Em 13/09/2026 o portal ganhou dia a dia em dois paineis que so tinham mes: o motivo
 * do corte (`executivo.serie_diaria[].razoes`) e a comparacao regional (`benchmark_ne.serie_dia`). Os
 * dois nascem do MESMO laco que soma o mes, entao eles fecham por construcao — e "por construcao" e
 * exatamente o tipo de afirmacao que envelhece calada quando alguem mexe na convencao de um lado so.
 * Dia e mes discordando na tela e pior que dia nenhum: o leitor nao ve duas janelas, ve dado errado.
 *
 * DUAS ROTAS INDEPENDENTES, de proposito. Cada gerador ja ABORTA sem gravar se a soma dos dias nao
 * reproduzir o mes — sobre os acumuladores CRUS, em memoria. Este ensaio confere o PRODUTO PUBLICADO,
 * sobre os valores ja arredondados que o painel de fato le. Uma rota pega erro de agregacao; a outra
 * pega erro de emissao (campo faltando, slice errado, arredondamento que empilha).
 *
 * E ele prova que REPROVA: tres defeitos plantados sobre copias sadias dos proprios blobs. Guarda que
 * nunca foi vista reprovando e guarda por reputacao.
 *
 * Sem segredo nenhum: le so blob publico. Roda em qualquer maquina.
 */
const https = require('https'), zlib = require('zlib');
const BASE = process.env.BASE_DADOS || 'https://rbenergydata.blob.core.windows.net/dados/';

function getJSON(url) {
  return new Promise((ok, ko) => {
    https.get(url, { headers: { 'accept-encoding': 'gzip' }, timeout: 120000 }, r => {
      if (r.statusCode !== 200) { r.resume(); return ko(new Error('HTTP ' + r.statusCode + ' em ' + url)); }
      const cru = /gzip/i.test(r.headers['content-encoding'] || '') ? r.pipe(zlib.createGunzip()) : r;
      const c = []; cru.on('data', d => c.push(d));
      cru.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString('utf8'))); } catch (e) { ko(e); } });
    }).on('error', ko);
  });
}

const diasNoMes = m => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
const r2 = v => Math.round(v * 100) / 100;

// ---- as duas conferencias, cada uma devolvendo a lista de achados -------------------------------

// 1) motivo do corte: Σ razoes dos dias de um mes COMPLETO na janela == razoes do mes
function fechaMotivo(exec) {
  const out = [], sd = exec.serie_diaria || [], sm = exec.serie || [];
  if (!sd.length) return ['executivo.serie_diaria vazio'];
  if (!sd.some(d => d.razoes)) return ['executivo.serie_diaria sem o campo `razoes` — o painel do motivo por dia nao tem o que desenhar'];
  const por = {};
  sd.forEach(d => {
    const m = d.dia.slice(0, 7), b = por[m] || (por[m] = { n: 0, raz: {} });
    b.n++;
    Object.entries(d.razoes || {}).forEach(([k, o]) => { b.raz[k] = (b.raz[k] || 0) + (o.gwh || 0); });
  });
  let conferidos = 0;
  Object.entries(por).forEach(([mes, b]) => {
    if (b.n !== diasNoMes(mes)) return;                       // mes na ponta da janela de 90 dias
    const mm = sm.find(x => x.mes === mes);
    if (!mm || !mm.razoes) return;
    conferidos++;
    const cods = new Set([...Object.keys(b.raz), ...Object.keys(mm.razoes)]);
    cods.forEach(k => {
      const dia = r2(b.raz[k] || 0), mesv = (mm.razoes[k] || {}).gwh || 0;
      // tolerancia = so o arredondamento de 2 casas das linhas somadas, nada alem
      const tol = Math.max(0.01, b.n * 0.005);
      if (Math.abs(dia - mesv) > tol) out.push('motivo ' + mes + ' ' + k + ': dias ' + dia + ' GWh × mes ' + mesv);
    });
  });
  if (!conferidos) out.push('motivo: nenhum mes COMPLETO na janela — a conferencia nao julgou nada');
  return out;
}

// 2) comparacao regional: Σ cortado/gerado dos dias == o mes, nas tres entidades
function fechaRegiao(bench) {
  const out = [], sd = bench.serie_dia || [], sm = (bench.serie || []).filter(x => x.fonte === 'solar');
  if (!sd.length) return ['benchmark_ne.serie_dia ausente — o painel regional por dia nao tem o que desenhar'];
  const por = {};
  sd.forEach(d => { (por[d.dia.slice(0, 7)] = por[d.dia.slice(0, 7)] || []).push(d); });
  const CAMPOS = ['ne_cortado_gwh', 'ne_gerado_gwh', 'nosso_cortado_gwh', 'nosso_gerado_gwh',
    'abaiara_cortado_gwh', 'abaiara_gerado_gwh'];
  let conferidos = 0;
  Object.entries(por).forEach(([mes, L]) => {
    if (L.length !== diasNoMes(mes)) return;
    const mm = sm.find(x => x.mes === mes);
    if (!mm) return;
    conferidos++;
    CAMPOS.forEach(c => {
      if (mm[c] == null) return;
      const soma = r2(L.reduce((a, x) => a + (x[c] || 0), 0));
      const tol = Math.max(0.01, L.length * 0.005);
      if (Math.abs(soma - mm[c]) > tol) out.push('regiao ' + mes + ' ' + c + ': dias ' + soma + ' × mes ' + mm[c]);
    });
  });
  if (!conferidos) out.push('regiao: nenhum mes COMPLETO na janela — a conferencia nao julgou nada');
  // e o percentual de cada dia tem de sair do proprio par cortado/gerado do dia, nao de outro lugar
  sd.forEach(d => {
    [['nosso', d.nosso_cortado_gwh, d.nosso_gerado_gwh, d.nosso_corte_pct],
      ['abaiara', d.abaiara_cortado_gwh, d.abaiara_gerado_gwh, d.abaiara_corte_pct],
      ['ne', d.ne_cortado_gwh, d.ne_gerado_gwh, d.ne_corte_pct]].forEach(([q, c, g, p]) => {
      if (c == null || g == null || p == null || (c + g) <= 0) return;
      if (Math.abs(100 * c / (c + g) - p) > 0.05) {
        out.push('regiao ' + d.dia + ' ' + q + ': percentual ' + p + ' nao sai do proprio cortado/gerado');
      }
    });
  });
  return out;
}

// ---- os defeitos plantados: a guarda tem de acusar CADA UM, e o certo ---------------------------
function provaQueReprova(exec, bench) {
  const clone = o => JSON.parse(JSON.stringify(o));
  const casos = [];

  // (a) um dia de motivo perdido: o mes deixa de fechar pela energia daquele dia
  {
    const e = clone(exec);
    const alvo = [...e.serie_diaria].reverse().find(d => Object.keys(d.razoes || {}).length
      && Object.values(d.razoes).some(o => o.gwh > 0.2));
    if (alvo) { alvo.razoes = {}; casos.push(['dia de motivo apagado (' + alvo.dia + ')', () => fechaMotivo(e)]); }
  }
  // (b) o campo inteiro some — o defeito que este lote veio consertar, ao contrario
  {
    const e = clone(exec); e.serie_diaria.forEach(d => { delete d.razoes; });
    casos.push(['serie_diaria sem razoes', () => fechaMotivo(e)]);
  }
  // (c) um dia da regiao com o percentual mexido sem mexer na energia — o par se desencontra
  {
    const b = clone(bench);
    const alvo = (b.serie_dia || []).find(d => d.ne_corte_pct > 1);
    if (alvo) { alvo.ne_corte_pct = r2(alvo.ne_corte_pct + 5); casos.push(['percentual da regiao adulterado (' + alvo.dia + ')', () => fechaRegiao(b)]); }
  }
  // (d) a serie diaria da regiao some
  {
    const b = clone(bench); delete b.serie_dia;
    casos.push(['benchmark sem serie_dia', () => fechaRegiao(b)]);
  }
  return casos;
}

(async () => {
  const [exec, bench] = await Promise.all([getJSON(BASE + 'executivo.json'), getJSON(BASE + 'benchmark_ne.json')]);
  console.log('executivo  · serie_diaria ' + (exec.serie_diaria || []).length + ' dias'
    + ' · com razoes ' + (exec.serie_diaria || []).filter(d => d.razoes).length);
  console.log('benchmark  · serie_dia ' + (bench.serie_dia || []).length + ' dias'
    + ' · parciais ' + (bench.serie_dia || []).filter(d => d.parcial).length);

  const achados = [...fechaMotivo(exec), ...fechaRegiao(bench)];
  achados.forEach(a => console.log('  ACHADO · ' + a));

  console.log('\n-- a guarda reprova? --');
  let falhouProva = 0;
  for (const [nome, roda] of provaQueReprova(exec, bench)) {
    const r = roda();
    console.log('  ' + (r.length ? 'reprovou' : 'PASSOU (errado!)') + ' · ' + nome
      + (r.length ? ' -> ' + r[0].slice(0, 90) : ''));
    if (!r.length) falhouProva++;
  }

  if (achados.length || falhouProva) {
    console.error('\nREPROVADO: ' + achados.length + ' achado(s) e ' + falhouProva + ' defeito(s) plantado(s) que passaram');
    process.exit(1);
  }
  console.log('\nOK · dia e mes fecham nos dois blobs, e a guarda foi vista reprovando');
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
