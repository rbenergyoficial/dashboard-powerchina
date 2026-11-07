# -*- coding: utf-8 -*-
"""Lote boletim-desempenho · fotografia (PNG das partes) e PDF de página única do boletim, a partir do renderiza.py aprovado.
Chrome sem janela (CHROME: no GitHub, google-chrome; no PC, o Chrome do Windows). Cada imagem para o WeCom fica com no máximo 2 MB
(limite medido): se o PNG passar, vira JPG com qualidade decrescente até caber.
    python render_ci.py <pasta> <base>      ex.: <pasta> diario_claro  ->  diario_claro_p1.png … + diario_claro.pdf"""
import os, shutil, subprocess, sys

LIMITE = 2 * 1024 * 1024
CHROME = os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def _url(p):
    return 'file:///' + os.path.abspath(p).replace('\\', '/')


def foto(html, png, alt=3600):
    from PIL import Image
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2',
                    f'--window-size=1080,{alt}', '--virtual-time-budget=4000', f'--screenshot={png}', _url(html)], capture_output=True, timeout=180)
    im = Image.open(png).convert('RGB'); w, h = im.size; px = im.load(); bg = px[4, h - 1]
    y = h - 1
    while y > 0 and all(sum(abs(a - b) for a, b in zip(px[x, y], bg)) < 10 for x in range(0, w, 30)):
        y -= 1
    im = im.crop((0, 0, w, min(h, y + 50))); im.save(png, optimize=True)
    return cabe(png)


def cabe(png):
    """devolve o caminho da imagem que cabe em 2 MB (o próprio PNG, ou um JPG ao lado)"""
    if os.path.getsize(png) <= LIMITE:
        return png
    from PIL import Image
    im = Image.open(png).convert('RGB'); jpg = png[:-4] + '.jpg'
    for q in (90, 85, 80, 75, 70, 60):
        im.save(jpg, quality=q, optimize=True)
        if os.path.getsize(jpg) <= LIMITE:
            os.remove(png)
            return jpg
    raise SystemExit('RECUSADO: imagem acima de 2 MB mesmo em JPG: ' + png)


def pdf(html, alt_css):
    from pypdf import PdfReader
    saida = html[:-5] + '.pdf'
    for extra in range(0, 400, 20):
        src = open(html, encoding='utf-8').read().replace('@page{margin:0}', f'@page{{margin:0;size:1080px {alt_css + extra}px}}')
        tmp = html[:-5] + '_pdf.html'; open(tmp, 'w', encoding='utf-8').write(src)
        subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--virtual-time-budget=4000',
                        f'--print-to-pdf={saida}', _url(tmp)], capture_output=True, timeout=180)
        os.remove(tmp)
        if len(PdfReader(saida).pages) == 1:
            return saida
    raise SystemExit('RECUSADO: PDF ainda com mais de uma página: ' + html)


def rende(pasta, base):
    """as partes (imagens para o WeCom) e o PDF do relatório inteiro"""
    from PIL import Image
    inteiro = os.path.join(pasta, base + '.html')
    tmp_png = os.path.join(pasta, base + '_inteiro.png')
    foto(inteiro, tmp_png, 6000)
    h = Image.open(tmp_png if os.path.exists(tmp_png) else tmp_png[:-4] + '.jpg').size[1]
    for x in (tmp_png, tmp_png[:-4] + '.jpg'):
        if os.path.exists(x):
            os.remove(x)
    out = {'pdf': pdf(inteiro, h // 2 + 10), 'partes': []}
    i = 1
    while os.path.exists(os.path.join(pasta, f'{base}_p{i}.html')):
        out['partes'].append(foto(os.path.join(pasta, f'{base}_p{i}.html'), os.path.join(pasta, f'{base}_p{i}.png')))
        i += 1
    return out


if __name__ == '__main__':
    r = rende(sys.argv[1], sys.argv[2])
    print(r['pdf'], [(os.path.basename(p), os.path.getsize(p) // 1024) for p in r['partes']])
