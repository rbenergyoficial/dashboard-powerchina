# -*- coding: utf-8 -*-
"""Boletim de Desempenho · tela executiva (lote boletim-pdf-executivo, desenho aprovado em 20/11/2026).
Monta o arquivo HTML do dia a partir do modelo (tela.src.html) e do dado (tela.json, gravado pelo cálculo aprovado: tela_extrai.py),
e confere o que a tela escreve antes de ela ir ao grupo.

  monta    um arquivo ÚNICO por língua, sem nada de fora: o dado, a fonte Archivo (fontes/, SIL OFL 1.1) e o logotipo vão embutidos.
           O Google Fonts é bloqueado na China; o arquivo abre sem rede. PT e EN no mesmo arquivo (o leitor troca); muda só o padrão.
  guarda   lê o texto que a tela escreve (tela_dom.js, sem navegador) e recusa: o desenho que não terminou; português na versão em
           inglês (ao grupo vai só o inglês); "ONS apurou 0"; e, com o ONS pendente, qualquer "sem limite", potencial ou energia não
           gerada (o diário das 08:00 é sempre pendente).
  rende    para CONFERIR o desenho (não roda no pipeline): Chrome sem janela, a imagem da tela inteira a 1280 px.

    python tela.py <pasta> <tela.json> [--render]     ->  os arquivos na pasta e o que foi gerado, em JSON
Ao grupo a tela vai como arquivo HTML ANEXO, em inglês, junto da imagem e do PDF do boletim em página branca (para_o_grupo; humano,
22/11/2026); o português fica guardado ao lado."""
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import fila as F  # noqa: E402

MODELO = os.path.join(AQUI, 'tela.src.html')
FONTE = os.path.join(AQUI, 'fontes', 'Archivo-latin.woff2')
LOGO = os.path.join(AQUI, 'logo_intrepid_tela.png')
DOM = os.path.join(AQUI, 'tela_dom.js')
LARGURA = 1280          # a largura em que o desenho foi aprovado
TEMA = os.environ.get('BOLETIM_TELA_TEMA') or 'dark'   # o tema em que o arquivo abre (o leitor troca no botão): dark | light
NOME = {'en': 'Mauriti_Daily_Bulletin_%s', 'pt': 'Boletim_Diario_Mauriti_%s'}   # o nome que o leitor vê no WeCom
TITULO = {'en': 'Mauriti · Daily Performance Bulletin · %s', 'pt': 'Mauriti · Boletim Diário de Desempenho · %s'}
ESTADOS = ('publicado', 'ordens', 'nenhuma', 'sem_registro')
# o texto da tela que NUNCA aparece com o ONS pendente, nos blocos que falam do dia (título, números, o instrumento do dia)
PROIBIDO_PEND = [re.compile(p, re.I) for p in (
    r'sem limit', r'no ONS limit', r'without (?:ONS )?limit', r'n[ãa]o gerad', r'not generated', r'potencial estimado', r'estimated potential',
    r'\b0[,.]0\s*h\b', r'apurou\s+0', r'ONS impediu', r'curtailed by the ONS on the day')]
BLOCOS_DIA = ('h1', 'kp', 't-dia', 's-dia', 'l-dia', 'g-dia')
# em qualquer estado, na tela inteira
PROIBIDO = [re.compile(p, re.I) for p in (r'ONS\s+apurou\s+0', r'apurou\s+0[,.]?0*\s*MWh', r'\bNaN\b', r'undefined', r'\bnull\b', r'Infinity')]
PT_RESTO = re.compile(r'[ãõçáéíóúâêô]|\b(?:de|do|da|dos|das|em|com|não|mês|dia|meta|usina|corte|geração)\b', re.I)   # a mesma régua do traduz_en.py
FORA = re.compile(r'https?://|<link\b|@import|url\((?!data:|#)|\bsrc="(?!data:)', re.I)   # nada de fora do arquivo


def problemas_zh(t, dado, tema=TEMA):
    """as recusas da leitura em chinês (o leitor troca a língua no botão 中文; t = le(arquivo, 'zh')): o desenho termina, nenhum texto
    ficou sem o chinês e não sobra português. Lista vazia = pode ir"""
    est, out = dado['ons']['estado'], []
    if t.get('ok') != 'zh:%s:%s' % (tema, est):
        out.append('o desenho em chinês não terminou (%r)' % t.get('ok'))
    if t.get('faltaZh') != 0:
        out.append('%s texto(s) da tela sem o chinês' % t.get('faltaZh'))
    vis = t.get('visivel') or ''
    for rx in PROIBIDO:
        m = rx.search(vis)
        if m:
            out.append('texto proibido na tela em chinês: "%s"' % m.group(0))
    sobra = sorted(set(m.group(0) for m in PT_RESTO.finditer(vis)))
    if sobra:
        out.append('chinês com português: ' + ', '.join(sobra[:12]))
    if not all(re.search('[\u4e00-\u9fff]', t['textos'].get(b, '')) for b in ('h1', 'kp', 't-dia', 't-pon', 'rod1')):
        out.append('título, números ou rodapé sem chinês')
    return out


def monta(dado, lang, tema=TEMA):
    """o HTML do dia, completo e fechado (nenhum pedido de rede), com a língua e o tema em que abre"""
    if lang not in NOME or tema not in ('dark', 'light'):
        raise SystemExit('RECUSADO: tela: língua ou tema fora do previsto: %r %r' % (lang, tema))
    if (dado.get('ons') or {}).get('estado') not in ESTADOS:
        raise SystemExit('RECUSADO: tela: o dado não traz o estado do ONS no dia')
    if not 0.9 < (dado.get('p90_fator') or 0) < (dado.get('p75_fator') or 0) < 1:
        raise SystemExit('RECUSADO: tela: o dado não traz os fatores do P75 e do P90 do estudo')
    src = io.open(MODELO, encoding='utf-8').read()
    b64 = lambda p: base64.b64encode(open(p, 'rb').read()).decode('ascii')
    trocas = (('__TITULO__', TITULO[lang] % dado['dia']), ('__FONTE__', b64(FONTE)), ('__LOGO__', b64(LOGO)),
              ('__DADOS__', json.dumps(dict(dado, padrao={'lang': lang, 'tema': tema}), ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')))
    for de, para in trocas:
        if src.count(de) != 1:
            raise SystemExit('RECUSADO: tela: o modelo traz %d vez(es) a marca %s' % (src.count(de), de))
        src = src.replace(de, para)
    src = src.replace('<html lang="en"', '<html lang="%s"' % ('pt-BR' if lang == 'pt' else 'en'))
    m = FORA.search(re.sub(r'base64,[A-Za-z0-9+/=]+', 'base64,', src))
    if m:
        raise SystemExit('RECUSADO: tela: o arquivo pede algo de fora (%s); tem de abrir sem rede' % m.group(0))
    return src


def le(arquivo, lang='', largura=LARGURA):
    """o que a tela escreve (tela_dom.js): {ok, textos, html, visivel, …}"""
    node = shutil.which('node') or 'node'
    r = subprocess.run([node, DOM, arquivo, lang, str(largura)], capture_output=True, text=True, encoding='utf-8', timeout=60)
    if r.returncode:
        raise SystemExit((r.stderr or 'RECUSADO: tela: o leitor da tela falhou').strip()[-400:])
    return json.loads(r.stdout)


def problemas(t, dado, lang, tema=TEMA):
    """as recusas do que a tela escreveu (t = le(arquivo)); lista vazia = pode ir"""
    est, out = dado['ons']['estado'], []
    if t.get('ok') != '%s:%s:%s' % (lang, tema, est):
        out.append('o desenho não terminou ou abriu fora do padrão (%r, esperado %s:%s:%s)' % (t.get('ok'), lang, tema, est))
    vis = t.get('visivel') or ''
    for rx in PROIBIDO:
        m = rx.search(vis)
        if m:
            out.append('texto proibido na tela: "%s"' % m.group(0))
    try:
        F.confere_texto(vis)   # a guarda do texto do WeCom ("ONS apurou 0") vale para a tela
    except SystemExit as e:
        out.append(str(e)[:200])
    if est != 'publicado':
        dia = ' | '.join(t['textos'].get(b, '') for b in BLOCOS_DIA)
        for rx in PROIBIDO_PEND:
            m = rx.search(dia)
            if m:
                out.append('com o ONS pendente a tela diz "%s"' % m.group(0))
        if not re.search(r'pendente|pending', t['textos'].get('kp', '')) or not re.search(r'pendente|pending', t['textos'].get('t-dia', '')):
            out.append('com o ONS pendente o número e o título do dia não dizem que a apuração está pendente')
        if 'data-pot=' in t['html'].get('g-dia', '') or 'data-nger=' in t['html'].get('g-dia', ''):
            out.append('com o ONS pendente a curva do dia desenha potencial ou energia não gerada')
        if not re.search(r'data-pend="%d"' % int(dado['dia'][8:]), t['html'].get('g-mes', '')):
            out.append('o dia pendente saiu sem a hachura no dia a dia')
        if not t['textos'].get('n-pon'):
            out.append('a ponte do mês não avisa do dia pendente')
        if est == 'ordens' and 'data-ordens=' not in t['html'].get('g-dia', ''):
            out.append('a curva do dia saiu sem o degrau das ordens da Iqony')
    if dado.get('disp_dia') is None and F.DISP_PENDENTE[lang] not in t['textos'].get('kp', ''):
        out.append('a disponibilidade que ainda não chegou não saiu como "%s"' % F.DISP_PENDENTE[lang])
    if 'data-pxx=' in t['html'].get('g-pon', '') or t['html'].get('g-viz'):   # boletim-tela-limpa (24/11/2026): a régua e o quadro saíram
        out.append('a ponte do mês voltou com o quadro P50 · P75 · P90 ou a régua do corte')
    pend = [m['d'] for m in dado['mes'] if not m['ons']]
    if any(d in pend for d in dado.get('livres') or []):
        out.append('dia pendente contado como dia sem corte no PR por usina')
    if lang == 'en':
        sobra = sorted(set(m.group(0) for m in PT_RESTO.finditer(vis)))
        if sobra:
            out.append('inglês com português: ' + ', '.join(sobra[:12]))
    return out


# ---------------- abas com o boletim completo (humano, 24/11/2026: "monte o boletim completo com abas novas no mesmo painel"; "Ficam todas") ----
# As abas novas são as quatro partes do diário APROVADO que a rodada já gerou na pasta do dia (as mesmas que vão ao grupo como imagem),
# em PT e EN e nos dois temas: nenhum número novo. A aba mostra a versão da língua e do tema escolhidos no topo (em 中文, a inglesa).
ABAS = [  # (id, PT, EN, 中文) na ordem das partes do diário
    ('p1', 'Meta e números do dia', 'Target and day figures', '目标与当日数据'),
    ('p2', 'Curva do dia', 'Day curve', '当日曲线'),
    ('p3', 'Dia a dia do mês', 'Month day by day', '本月逐日'),
    ('p4', 'Corte, usinas e fatos', 'Curtailment, plants and facts', '限电、电站与要点'),
]
CSS_ABAS = """<style>
.abas{display:flex;gap:6px;flex-wrap:wrap;margin:18px 0 0;padding:4px;border:1px solid var(--line);border-radius:999px;width:fit-content;max-width:100%}
.abas button{font:inherit;font-size:13px;font-weight:600;padding:6px 14px;border:0;border-radius:999px;background:transparent;color:var(--ink3);cursor:pointer;white-space:nowrap}
.abas button[aria-selected="true"]{background:color-mix(in srgb,var(--ink) 10%,transparent);color:var(--ink)}
.abas button:focus-visible{outline:2px solid var(--ppa);outline-offset:1px}
.aba-f{display:block;width:100%;border:0;margin-top:20px;background:transparent}
.aba-n{font-size:12.5px;color:var(--ink3);margin:10px 0 0}
[data-modo="foto"] .abas{display:none}
@media (max-width:640px){.abas{border-radius:12px}.abas button{padding:6px 10px;font-size:12px}}
</style>"""
JS_ABAS = r"""<script>
(function(){
'use strict';
var A = JSON.parse(document.getElementById('abas-dados').textContent), R = document.documentElement, atual = 'exec';
var NOMES = __NOMES__;
function lg(){ var l = (R.lang || 'en').slice(0, 2); return l === 'pt' ? 'pt' : l === 'zh' ? 'zh' : 'en'; }
function rotulos(){ var l = lg(), k = l === 'pt' ? 1 : l === 'zh' ? 3 : 2;
  Array.prototype.forEach.call(document.querySelectorAll('.abas button'), function(b){ var n = NOMES[b.getAttribute('data-aba')]; if (n) b.textContent = n[k]; });
  var nt = document.getElementById('aba-nota'); nt.textContent = l === 'zh' ? '此页签为英文版（来自每日报告）。' : l === 'pt' ? 'Painéis do boletim diário, como no PDF.' : 'Panels of the daily bulletin, as in the PDF.'; }
function enche(id){ var f = document.getElementById('f-' + id); if (!f) return; var l = lg() === 'pt' ? 'pt' : 'en', t = R.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  var chave = l + ':' + t; if (f.getAttribute('data-chave') === chave) return; f.setAttribute('data-chave', chave);
  f.onload = function(){ try { f.style.height = (f.contentDocument.documentElement.scrollHeight + 4) + 'px'; } catch (e) { f.style.height = '1600px'; } };
  f.srcdoc = A[l][t][Number(id.slice(1)) - 1]; }
function mostra(id){ atual = id;
  Array.prototype.forEach.call(document.querySelectorAll('.abas button'), function(b){ b.setAttribute('aria-selected', b.getAttribute('data-aba') === id); });
  Array.prototype.forEach.call(document.querySelectorAll('[data-painel]'), function(p){ p.hidden = p.getAttribute('data-painel') !== id; });
  if (id !== 'exec') enche(id);
  if (id === 'exec') dispatchEvent(new Event('resize')); }
document.querySelector('.abas').addEventListener('click', function(ev){ var b = ev.target.closest('button[data-aba]'); if (b) mostra(b.getAttribute('data-aba')); });
new MutationObserver(function(){ rotulos(); if (atual !== 'exec') enche(atual); }).observe(R, {attributes: true, attributeFilter: ['lang', 'data-theme']});
addEventListener('load', rotulos); setTimeout(function(){ rotulos(); var q = new URLSearchParams(location.search).get('aba'); if (q && NOMES[q]) mostra(q); }, 0);
})();
</script>"""


def _limpa(h):
    """a parte sem o logotipo (o topo da tela já tem), sem o cabeçalho repetido e sem a fonte do Google (bloqueada na China)"""
    h = re.sub(r'<img src="data:image/png;base64,[A-Za-z0-9+/=]+">', '', h)
    h = re.sub(r'<link [^>]*fonts\.googleapis\.com[^>]*>', '', h)
    st = '<style>.cab{display:none!important}html,body{margin:0}</style>'
    return h.replace('</head>', st + '</head>', 1) if '</head>' in h else st + h


def partes_da_pasta(pasta):
    """{'pt'|'en': {'light'|'dark': [p1..p4]}} das partes do diário na pasta do dia; None se não há nenhuma; RECUSADO se faltar alguma"""
    nomes = {(lg, tm, i): os.path.join(pasta, 'diario_%s_p%d%s.html' % ('claro' if tm == 'light' else 'escuro', i, '_en' if lg == 'en' else ''))
             for lg in ('pt', 'en') for tm in ('light', 'dark') for i in range(1, len(ABAS) + 1)}
    ha = [k for k, v in nomes.items() if os.path.exists(v)]
    if not ha:
        return None
    if len(ha) != len(nomes):
        raise SystemExit('RECUSADO: tela: faltam partes do diário para as abas: %s' % sorted(set(nomes) - set(ha))[:4])
    out = {lg: {tm: [] for tm in ('light', 'dark')} for lg in ('pt', 'en')}
    for k in sorted(nomes, key=lambda k: k[2]):
        out[k[0]][k[1]].append(_limpa(io.open(nomes[k], encoding='utf-8').read()))
    return out


def com_abas(html, partes):
    """a tela com a barra de abas: Executivo (a tela de sempre) + as partes do diário"""
    nav = '<nav class="abas" role="tablist" aria-label="Bulletin"><button type="button" data-aba="exec" aria-selected="true">Executive</button>' + \
        ''.join('<button type="button" data-aba="%s" aria-selected="false">%s</button>' % (a[0], a[2]) for a in ABAS) + '</nav>'
    a0, a1 = html.index('  <p class="ante" id="ante"></p>'), html.index('  <footer class="rod">')
    paineis = ''.join('<div data-painel="%s" hidden><p class="aba-n" id="%s"></p><iframe class="aba-f" id="f-%s" title="%s"></iframe></div>\n'
                      % (a[0], 'aba-nota' if i == 0 else 'aba-nota-%d' % i, a[0], a[2]) for i, a in enumerate(ABAS))
    html = html[:a0] + nav + '\n<div data-painel="exec">\n' + html[a0:a1] + '</div>\n' + paineis + html[a1:]
    dados = json.dumps(partes, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/')
    nomes = json.dumps(dict({'exec': ['exec', 'Executivo', 'Executive', '概览']}, **{a[0]: list(a) for a in ABAS}), ensure_ascii=False)
    bloco = CSS_ABAS + '\n<script id="abas-dados" type="application/json">' + dados + '</script>\n' + JS_ABAS.replace('__NOMES__', nomes) + '\n'
    i = html.index('<script id="dados"')   # antes do dado e do script da tela: o script da tela continua sendo o ÚLTIMO (tela_dom.js)
    html = html[:i] + bloco + html[i:]
    m = FORA.search(re.sub(r'base64,[A-Za-z0-9+/=]+', 'base64,', html))
    if m:
        raise SystemExit('RECUSADO: tela: uma aba pede algo de fora (%s); tem de abrir sem rede' % m.group(0))
    return html


def problemas_abas(html, partes):
    """as recusas das abas: cada aba com o seu painel e o dado das quatro partes nas duas línguas e nos dois temas"""
    out = []
    if html.count('data-aba="') != len(ABAS) + 1 or html.count('class="aba-f"') != len(ABAS):
        out.append('as abas não saíram inteiras (%d botões, %d painéis)' % (html.count('data-aba="'), html.count('class="aba-f"')))
    m = re.search(r'<script id="abas-dados" type="application/json">(.*?)</script>', html, re.S)
    try:
        d = json.loads(m.group(1)) if m else {}
    except ValueError:
        d = {}
    if not all(len(((d.get(lg) or {}).get(tm)) or []) == len(ABAS) for lg in ('pt', 'en') for tm in ('light', 'dark')):
        out.append('o dado das abas não tem as %d partes em PT e EN nos dois temas' % len(ABAS))
    elif d != partes:
        out.append('o dado das abas não é o das partes do diário do dia')
    return out


def _chrome():
    return os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def _url(p):
    return 'file:///' + os.path.abspath(p).replace('\\', '/')


def rende(arquivo):
    """a imagem da tela inteira (PNG, ou JPG se passar de 2 MB), no modo foto (sem animação e sem os botões): para conferir o desenho"""
    import render_ci
    from PIL import Image
    src = io.open(arquivo, encoding='utf-8').read()
    if src.count('data-modo="tela"') != 1:
        raise SystemExit('RECUSADO: tela: o arquivo não traz a marca do modo foto')
    base = arquivo[:-5]
    foto = base + '_foto.html'
    io.open(foto, 'w', encoding='utf-8', newline='\n').write(src.replace('data-modo="tela"', 'data-modo="foto"'))
    comum = [_chrome(), '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars']
    try:
        dom = subprocess.run(comum + [f'--window-size={LARGURA},1200', '--virtual-time-budget=4000', '--dump-dom', _url(foto)],
                             capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=180).stdout or ''
        cab = dom[:dom.find('<head')] if '<head' in dom else dom[:2000]
        ok, h = re.search(r'data-ok="([^"]+)"', cab), re.search(r'data-h="(\d+)"', cab)
        if not ok or not h or dom.count('<svg') < 8:
            raise SystemExit('RECUSADO: tela: o navegador não desenhou a tela inteira (%s, %d gráficos)' % (ok.group(1) if ok else 'sem marca', dom.count('<svg')))
        alt = int(h.group(1))
        png = base + '.png'
        subprocess.run(comum + ['--force-device-scale-factor=2', f'--window-size={LARGURA},{alt}', '--virtual-time-budget=4000', f'--screenshot={png}', _url(foto)],
                       capture_output=True, timeout=180)
        if not os.path.exists(png) or Image.open(png).size != (LARGURA * 2, alt * 2):
            raise SystemExit('RECUSADO: tela: a imagem não saiu no tamanho medido (%d × %d px)' % (LARGURA, alt))
        return {'imagem': render_ci.cabe(png), 'altura': alt}
    finally:
        if os.path.exists(foto):
            os.remove(foto)


def gera(pasta, caminho_json, render=False):
    """os arquivos da tela do dia, PT e EN: {'pt': {'html', 'imagem'}, 'en': {…}}. Qualquer recusa da guarda derruba a tela
    inteira (RECUSADO): a tela que diz o que não deve não vai ao grupo. No pipeline só o HTML é gerado (render=False): ao grupo a tela
    vai como arquivo anexo; a imagem da tela (rende) serve à conferência do desenho."""
    dado = json.load(open(caminho_json, encoding='utf-8'))
    out, ruins = {}, []
    partes = partes_da_pasta(pasta)   # as abas com o boletim completo (24/11/2026); None = sem as partes na pasta, a tela sai sem abas
    for lang in ('pt', 'en'):
        arq = os.path.join(pasta, NOME[lang] % dado['dia'] + '.html')
        h = monta(dado, lang) if partes is None else com_abas(monta(dado, lang), partes)
        io.open(arq, 'w', encoding='utf-8', newline='\n').write(h)
        if partes is not None:
            ruins += ['%s: %s' % (lang.upper(), p) for p in problemas_abas(h, partes)]
        ruins += ['%s: %s' % (lang.upper(), p) for p in problemas(le(arq), dado, lang)]
        ruins += ['%s (celular): %s' % (lang.upper(), p) for p in problemas(le(arq, largura=390), dado, lang)]
        if lang == 'en':   # o chinês é lido do MESMO arquivo que vai ao grupo (o leitor troca no botão 中文)
            ruins += ['ZH: %s' % p for p in problemas_zh(le(arq, 'zh'), dado)]
            ruins += ['ZH (celular): %s' % p for p in problemas_zh(le(arq, 'zh', 390), dado)]
        out[lang] = {'html': arq, 'imagem': None}
    if ruins:
        for lang in out:   # o arquivo recusado não fica na pasta que sobe
            os.remove(out[lang]['html'])
        raise SystemExit('RECUSADO: tela executiva de %s: %s' % (dado['dia'], '; '.join(sorted(set(ruins)))[:900]))
    if render:
        for lang in ('pt', 'en'):
            r = rende(out[lang]['html'])
            out[lang].update(imagem=r['imagem'])
    return out


def para_o_grupo(guardado):
    """o que o diário leva ao grupo (imagens, arquivos), tudo em inglês: as partes e o PDF do boletim em página branca e, ANEXO, o arquivo
    HTML da tela executiva (humano, 22/11/2026: "HTML interativo junto do branco"). Sem a tela (BOLETIM_TELA=0, a guarda que recusou, ou o
    mensal), só as partes e o PDF, como sempre."""
    en = guardado.get('en', {})
    imagens, arquivos = list(en.get('imagens', [])), ([en['pdf']] if en.get('pdf') else [])
    t = (guardado.get('tela') or {}).get('en') or {}
    if t.get('html'):
        arquivos.append(t['html'])
    return imagens, arquivos


if __name__ == '__main__':
    r = gera(sys.argv[1], sys.argv[2], '--render' in sys.argv)
    print(json.dumps({k: {a: (os.path.basename(b) if b else None) for a, b in v.items()} for k, v in r.items()}, ensure_ascii=False))
