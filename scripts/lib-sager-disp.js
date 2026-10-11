'use strict';
/*
 * lib-sager-disp.js — a disponibilidade POR USINA do Conjunto Mauriti no Relatorio Geral do SAGER (ONS), como publicada e como
 * contestada pelo agente (11/10/2026, PROMOVER sager-disp).
 *
 * Desde 01/10/2026 (Despacho ANEEL 2.038/2026) o ONS apura o constrained-off por USINA e o Relatorio Geral do SAGER traz a
 * disponibilidade de cada uma a cada meia hora. Os dados abertos do ONS NAO trazem isso por usina (conferido em 11/10/2026: a
 * restricao FV traz so o conjunto "Conj. Mauriti"; o detalhamento por usina traz irradiancia, geracao e referencia, sem
 * disponibilidade). A fonte e o historico que a Engenharia mantem a partir dos relatorios recebidos (`RelatorioGeral_MRT_Historico.xlsx`,
 * aba "Patamares", no formato do ONS): celula contestada = preenchimento AMARELO com o valor proposto pelo agente e um comentario
 * "Valor no SAGER: X MW. Valor proposto pelo agente: Y MW"; dado que o ONS marcou como insatisfatorio = fonte VERMELHA.
 *
 * Regra (tudo pelo NOME do cabecalho, nunca pela posicao — a ordem das usinas no relatorio e M3, M1, M2, M4...):
 *   · linha 9: o grupo ("Disponibilidade por Usina", "Geracao Verificada por Usina"); linha 10: a usina (MTD_MAURITI_1, MTD_MAURITI 3...);
 *   · publicado = o X do comentario, quando a celula tem comentario no padrao; senao, o valor da celula;
 *   · contestado = o valor da celula AMARELA (ha de ter o comentario: amarela sem ele estoura);
 *   · insatisfatorio = alguma celula DA USINA na meia hora (irradiancia, geracao, disponibilidade...) com fonte vermelha: o ONS
 *     marcou o dado dela como insatisfatorio.
 */
const zlib = require('zlib');
const { entradas } = require('./lib-zip');

const USINAS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const GRUPO_DISP = /^disponibilidade por usina/i, GRUPO_GER = /^gera[cç][aã]o verificada por usina/i;
const RX_COM = /Valor no SAGER:\s*([\d.,]+)\s*MW\.\s*Valor proposto pelo agente:\s*([\d.,]+)\s*MW/i;

const desfaz = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const numBr = (s) => Number(String(s).replace(/\./g, '').replace(',', '.'));
function col(ref) { const m = /^([A-Z]+)(\d+)$/.exec(ref); let n = 0; for (const ch of m[1]) n = n * 26 + ch.charCodeAt(0) - 64; return { c: n, r: +m[2] }; }

/* le a aba de uma pasta xlsx: celulas (valor, estilo), estilos amarelo/vermelho, comentarios */
function leXlsx(buf, aba) {
  const Z = new Map(entradas(buf, 'xlsx').map((e) => [e.nome, e.dados.toString('utf8')]));
  const wb = Z.get('xl/workbook.xml'), rels = Z.get('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new Error('xlsx sem workbook');
  const abas = [...wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)].map((m) => ({ nome: desfaz(m[1]), rid: m[2] }));
  const alvo = abas.find((a) => a.nome === aba);
  if (!alvo) throw new Error('aba "' + aba + '" nao encontrada (ha: ' + abas.map((a) => a.nome).join(', ') + ')');
  const rel = new RegExp('<Relationship [^>]*Id="' + alvo.rid + '"[^>]*Target="([^"]+)"').exec(rels) || new RegExp('<Relationship [^>]*Target="([^"]+)"[^>]*Id="' + alvo.rid + '"').exec(rels);
  const arq = 'xl/' + rel[1].replace(/^\/?xl\//, '');
  const S = Z.get(arq); if (!S) throw new Error('xlsx sem ' + arq);
  const ss = (Z.get('xl/sharedStrings.xml') || '').match(/<si>[\s\S]*?<\/si>/g) || [];
  const txt = ss.map((x) => desfaz((x.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  // estilos: preenchimento amarelo solido e fonte vermelha, resolvidos ate o indice do estilo da celula (cellXfs)
  const st = Z.get('xl/styles.xml') || '';
  const fills = (st.match(/<fills[^>]*>([\s\S]*?)<\/fills>/) || [, ''])[1].match(/<fill>[\s\S]*?<\/fill>|<fill\/>/g) || [];
  const fonts = (st.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/) || [, ''])[1].match(/<font>[\s\S]*?<\/font>|<font\/>/g) || [];
  const xfs = ((st.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [, ''])[1].match(/<xf [^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g)) || [];
  const amarela = new Set(fills.map((f, i) => (/patternType="solid"/.test(f) && /fgColor rgb="FFFFFF00"/i.test(f) ? i : -1)).filter((i) => i >= 0));
  const vermelha = new Set(fonts.map((f, i) => (/<color rgb="FFFF0000"/i.test(f) ? i : -1)).filter((i) => i >= 0));
  const xf = xfs.map((x) => ({ fill: +((/fillId="(\d+)"/.exec(x) || [, 0])[1]), font: +((/fontId="(\d+)"/.exec(x) || [, 0])[1]) }));
  const cel = new Map();
  for (const m of S.matchAll(/<c r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const at = m[2], corpo = m[3] || '', s = +((/ s="(\d+)"/.exec(at) || [, 0])[1]), t = (/ t="(\w+)"/.exec(at) || [, ''])[1];
    let v = null;
    if (t === 's') { const k = /<v>(\d+)<\/v>/.exec(corpo); v = k ? txt[+k[1]] : null; }
    else if (t === 'inlineStr') { v = desfaz((corpo.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((x) => x.replace(/<[^>]+>/g, '')).join('')); }
    else if (t === 'str') { const k = /<v>([\s\S]*?)<\/v>/.exec(corpo); v = k ? desfaz(k[1]) : null; }
    else { const k = /<v>([\s\S]*?)<\/v>/.exec(corpo); v = k ? Number(k[1]) : null; }
    const e = xf[s] || { fill: 0, font: 0 };
    cel.set(m[1], { v, amarela: amarela.has(e.fill), vermelha: vermelha.has(e.font) });
  }
  // comentarios da aba (o arquivo vem do rels da aba)
  const crel = Z.get(arq.replace('worksheets/', 'worksheets/_rels/') + '.rels') || '';
  const cm = /Target="([^"]*comments[^"]*)"/.exec(crel);
  const com = new Map();
  if (cm) {
    const caminho = cm[1].startsWith('/') ? cm[1].slice(1) : 'xl/' + cm[1].replace(/^\.\.\//, '');
    for (const c of (Z.get(caminho) || '').matchAll(/<comment ref="([A-Z]+\d+)"[^>]*>([\s\S]*?)<\/comment>/g)) com.set(c[1], desfaz(c[2].replace(/<[^>]+>/g, '')));
  }
  return { cel, com };
}

/* a usina pelo nome da coluna: MTD_MAURITI_1, MTD_MAURITI 3, "MTD_MAURITI 3\nCEFMT3_D"... */
function usinaDe(rotulo) { const m = /MAURITI[ _]?(\d)/i.exec(String(rotulo || '')); return m ? +m[1] : null; }

/* extrai a serie por meia hora; estoura (sem gravar nada) em qualquer coisa fora do esperado */
function extrai(x) {
  const { cel, com } = x;
  let rCab = null;
  for (const [ref, c] of cel) { const p = col(ref); if (p.c === 1 && /^data$/i.test(String(c.v || '').trim())) { rCab = p.r; break; } }
  if (!rCab) throw new Error('cabecalho "Data" nao encontrado na coluna A');
  // grupos na linha de cima: cada grupo vai da sua coluna ate a coluna antes do proximo grupo
  const grupos = [...cel].map(([ref, c]) => ({ ...col(ref), v: String(c.v || '').trim() })).filter((p) => p.r === rCab - 1 && p.v).sort((a, b) => a.c - b.c);
  const faixa = (rx) => { const i = grupos.findIndex((g) => rx.test(g.v)); if (i < 0) return null; return [grupos[i].c, i + 1 < grupos.length ? grupos[i + 1].c - 1 : 1e9]; };
  const fD = faixa(GRUPO_DISP), fG = faixa(GRUPO_GER);
  if (!fD) throw new Error('grupo "Disponibilidade por Usina" nao encontrado');
  if (!fG) throw new Error('grupo "Geracao Verificada por Usina" nao encontrado');
  const mapa = (f) => { const m = {}; for (const [ref, c] of cel) { const p = col(ref); if (p.r === rCab && p.c >= f[0] && p.c <= f[1]) { const u = usinaDe(c.v); if (u) { if (m[u]) throw new Error('usina M' + u + ' duas vezes no grupo'); m[u] = p.c; } } } return m; };
  const cD = mapa(fD), cG = mapa(fG);
  const todas = {};   /* toda coluna de usina no cabecalho, de qualquer grupo: para a marca de dado insatisfatorio */
  for (const [ref, c] of cel) { const p = col(ref); if (p.r === rCab) { const u = usinaDe(c.v); if (u) (todas[u] = todas[u] || []).push(p.c); } }
  for (const u of USINAS) { if (!cD[u]) throw new Error('disponibilidade sem a coluna da M' + u); if (!cG[u]) throw new Error('geracao sem a coluna da M' + u); }
  let cCx = null;
  for (const [ref, c] of cel) { const p = col(ref); if (p.r === rCab && p.c < fD[0] && /^disponibilidade/i.test(String(c.v || '').trim())) { cCx = p.c; break; } }
  const nomeCol = (n) => { let s = ''; while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); } return s; };
  const serie = [], visto = new Set();
  let contestadas = 0, insat = 0;
  for (let r = rCab + 1; ; r += 1) {
    const d = cel.get('A' + r), pt = cel.get('B' + r);
    if (!d || d.v == null || d.v === '') break;
    const md = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(d.v).trim()), mp = /^(\d{2}):(\d{2})/.exec(String(pt && pt.v || '').trim());
    if (!md || !mp) throw new Error('linha ' + r + ': data/patamar fora do formato (' + d.v + ' · ' + (pt && pt.v) + ')');
    const t = md[3] + '-' + md[2] + '-' + md[1] + 'T' + mp[1] + ':' + mp[2];
    if (visto.has(t)) throw new Error('patamar repetido: ' + t);
    visto.add(t);
    const o = { t, ms: Date.parse(t + ':00-03:00'), p: [], c: [], g: [], i: [] };
    const cx = cCx ? cel.get(nomeCol(cCx) + r) : null;
    o.cx = cx && typeof cx.v === 'number' ? +cx.v.toFixed(3) : null;
    for (const u of USINAS) {
      const ref = nomeCol(cD[u]) + r, c = cel.get(ref) || { v: null }, cm = com.get(ref), mc = cm ? RX_COM.exec(cm) : null;
      const val = typeof c.v === 'number' ? c.v : null;
      if (c.amarela && !mc) throw new Error(ref + ': celula contestada (amarela) sem o comentario com o valor do SAGER');
      const pub = mc ? numBr(mc[1]) : val, prop = c.amarela ? val : null;
      if (mc && c.amarela && Math.abs(numBr(mc[2]) - val) > 0.0015) throw new Error(ref + ': o valor proposto no comentario (' + mc[2] + ') difere da celula (' + val + ')');
      o.p.push(pub == null ? null : +pub.toFixed(3));
      o.c.push(prop == null ? null : +prop.toFixed(3));
      const verm = (todas[u] || []).some((k) => { const x = cel.get(nomeCol(k) + r); return x && x.vermelha; });
      o.i.push(verm ? 1 : 0);
      if (prop != null) contestadas++;
      if (verm) insat++;
      const gc = cel.get(nomeCol(cG[u]) + r);
      o.g.push(gc && typeof gc.v === 'number' ? +gc.v.toFixed(3) : null);
    }
    serie.push(o);
  }
  if (!serie.length) throw new Error('nenhum patamar depois do cabecalho');
  return { serie, contestadas, insatisfatorias: insat, colunas_disp: Object.fromEntries(USINAS.map((u) => ['M' + u, nomeCol(cD[u])])) };
}

module.exports = { leXlsx, extrai, usinaDe, USINAS, RX_COM };
