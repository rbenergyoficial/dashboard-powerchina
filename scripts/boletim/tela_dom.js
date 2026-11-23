// Boletim de Desempenho · tela executiva (lote boletim-pdf-executivo) · o TEXTO que a tela escreve, sem navegador.
// Roda o script do arquivo HTML montado com um DOM mínimo e devolve em JSON o que ele pôs na página, para a guarda do envio (tela.py) e
// para o ensaio (ensaio_tela.py): os dois leem a tela pelo MESMO caminho.
//    node tela_dom.js <arquivo.html> [pt|en|zh] [largura em px, padrão 1280]
// Saída: { ok: 'en:dark:ordens', titulo, textos: {id: texto visível}, html: {id: innerHTML}, visivel: 'tudo junto', rotulos: [aria-label] }
// Sem língua, vale o padrão gravado no arquivo (o que o leitor vê ao abrir). Erro do script = saída 1 com a mensagem.
'use strict';
const fs = require('fs');

function roda(arquivo, lang, largura) {
  const h = fs.readFileSync(arquivo, 'utf8');
  const dados = (h.match(/<script id="dados"[^>]*>([\s\S]*?)<\/script>/) || [])[1];
  const blocos = [...h.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (dados == null || !blocos.length) throw new Error('arquivo sem o dado ou sem o script da tela');
  const W = largura || 1280, pagina = Math.min(W - 32, 1180), largo = W > 900;
  const larg = (id) => {
    if (id === 'g-gcx' || id === 'g-gpp') return largo ? 236 : W <= 520 ? pagina : (pagina - 12) / 2;
    if (id === 'g-leq') return largo ? pagina - 524 : pagina;
    if (id === 'g-pon' || id === 'g-viz' || id === 'g-mes') return largo ? (pagina - 44) / 2 : pagina;
    if (id === 'sp') return W > 1000 ? pagina / 6 - 28 : W > 520 ? pagina / 3 - 28 : pagina / 2 - 24;
    return pagina;
  };
  const semTag = (s) => String(s).replace(/<[^>]+>/g, ' ').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  const els = {};
  class El {
    constructor(id, w) { this.id = id; this._h = ''; this.attrs = {}; this.style = {}; this.hidden = false; this.clientWidth = w == null ? larg(id) : w; this.offsetWidth = 120; this.offsetHeight = 60;
      this.classList = { remove() {}, add() {} }; }
    set innerHTML(v) { this._h = String(v); } get innerHTML() { return this._h; }
    set textContent(v) { this._h = String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;'); } get textContent() { return semTag(this._h); }
    setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
    addEventListener() {} querySelector() { return new El('?', 0); } querySelectorAll() { return []; }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: 100 }; }
  }
  const $ = (id) => els[id] || (els[id] = new El(id));
  Object.defineProperty($('dados'), 'textContent', { get() { return dados; } });
  const raiz = new El('html', W);
  for (const m of ((h.match(/<html([^>]*)>/) || [])[1] || '').matchAll(/([\w-]+)="([^"]*)"/g)) raiz.attrs[m[1]] = m[2];
  let minis = [];
  const document = { documentElement: raiz, title: '', getElementById: $,
    querySelectorAll(sel) { if (sel !== '.sp') return []; minis = [...$('kp').innerHTML.matchAll(/class="sp" data-k="(\w+)"/g)].map((m) => { const e = new El('sp'); e.attrs['data-k'] = m[1]; return e; }); return minis; } };
  const location = { search: lang ? '?lang=' + lang : '' };
  const nada = () => {};
  // eslint-disable-next-line no-new-func
  new Function('document', 'location', 'localStorage', 'innerWidth', 'addEventListener', 'setTimeout', 'clearTimeout', blocos[blocos.length - 1][1])(
    document, location, { getItem() { return null; }, setItem() {} }, W, nada, nada, nada);
  const IDS = ['m-sub', 'm-data', 'ante', 'h1', 'kp', 't-dia', 's-dia', 'l-dia', 'g-dia', 't-leq', 's-leq', 'l-leq', 'g-gcx', 'g-gpp', 'g-leq', 't-pon', 's-pon', 'g-pon', 'n-pon',
    't-viz', 'g-viz', 't-mes', 's-mes', 'l-mes', 'g-mes', 't-usi', 's-usi', 'l-usi', 'g-usi', 'rod1', 'rod2'];
  const textos = {}, html = {};
  for (const id of IDS) { const e = $(id); html[id] = e.innerHTML; textos[id] = e.hidden ? '' : semTag(e.innerHTML); }
  html.sp = minis.map((e) => '<i data-k="' + e.attrs['data-k'] + '">' + e.innerHTML + '</i>').join('');
  const rotulos = [];
  for (const id of IDS) for (const m of html[id].matchAll(/aria-label="([^"]*)"/g)) rotulos.push(m[1].replace(/&lt;/g, '<').replace(/&amp;/g, '&'));
  return { ok: raiz.attrs['data-ok'] || null, faltaZh: raiz.attrs['data-zh-falta'] == null ? null : Number(raiz.attrs['data-zh-falta']), tema: raiz.attrs['data-theme'] || null, lang: raiz.lang || null, titulo: document.title, textos, html,
    visivel: [document.title].concat(IDS.map((id) => textos[id]), rotulos).filter(Boolean).join(' | '), rotulos };
}

if (require.main === module) {
  try {
    const [arquivo, lang, largura] = process.argv.slice(2);
    process.stdout.write(JSON.stringify(roda(arquivo, lang === 'pt' || lang === 'en' || lang === 'zh' ? lang : '', Number(largura) || 1280)));
  } catch (e) { console.error('RECUSADO: a tela não desenhou: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); process.exit(1); }
}
module.exports = { roda };
