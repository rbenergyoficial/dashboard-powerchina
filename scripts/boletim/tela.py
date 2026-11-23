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
    if t['html'].get('g-pon', '').count('data-pxx=') != 4:
        out.append('a ponte do mês saiu sem o quadro P50 · P75 · P90')
    pend = [m['d'] for m in dado['mes'] if not m['ons']]
    if any(d in pend for d in dado.get('livres') or []):
        out.append('dia pendente contado como dia sem corte no PR por usina')
    if lang == 'en':
        sobra = sorted(set(m.group(0) for m in PT_RESTO.finditer(vis)))
        if sobra:
            out.append('inglês com português: ' + ', '.join(sobra[:12]))
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
    for lang in ('pt', 'en'):
        arq = os.path.join(pasta, NOME[lang] % dado['dia'] + '.html')
        io.open(arq, 'w', encoding='utf-8', newline='\n').write(monta(dado, lang))
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
