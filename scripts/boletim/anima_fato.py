# -*- coding: utf-8 -*-
"""Lote boletim-desempenho · vídeo curto (MP4, 1080x1350) de fato relevante, a partir do anima_recorde.py aprovado: o mesmo cartão claro,
o contador animado e, no recorde, o ranking dos 5 maiores dias. Fontes por FONTE_DIR (no GitHub, DejaVu; no PC, Segoe UI).
    anima(fato, executivo, saida_mp4) -> (mp4, png do último quadro)"""
import os

W, H, FPS = 1080, 1350, 30
FUNDO, T1, T2, T3, BORDA = (243, 244, 246), (5, 7, 10), (35, 42, 51), (67, 75, 87), (225, 228, 233)
GER, GER_T = (245, 166, 35), (150, 96, 4)
TITULO = {'recorde': 'Recorde de geração', 'meta': 'Meta do mês batida', 'marco': 'Marco de energia'}


def _fontes():
    from PIL import ImageFont
    d = os.environ.get('FONTE_DIR')
    if d:
        b, r = os.path.join(d, 'DejaVuSans-Bold.ttf'), os.path.join(d, 'DejaVuSans.ttf')
    else:
        b, r = r'C:\Windows\Fonts\segoeuib.ttf', r'C:\Windows\Fonts\segoeui.ttf'
    return lambda s, neg=True: ImageFont.truetype(b if neg else r, s)


def nf(v, c=2):
    return f'{v:,.{c}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def ease(t):
    t = max(0, min(1, t)); return 1 - (1 - t) ** 3


def mix(c, a, base=(255, 255, 255)):
    return tuple(int(base[i] + (c[i] - base[i]) * a) for i in range(3))


def anima(fato, executivo, saida):
    from PIL import Image, ImageDraw
    import imageio_ffmpeg
    F = _fontes()
    dia = fato['dia']
    valor, unidade = (fato['valor'], 'MWh') if fato['tipo'] != 'marco' else (fato['valor'], 'GWh')
    top = []
    if fato['tipo'] == 'recorde':
        serie = sorted([(r['liq_mwh'], r['dia']) for r in executivo['serie_dia_ufv'] if r['ufv'] == 'Complexo' and r['liq_mwh'] and not r['parcial'] and r['dia'] <= dia], reverse=True)
        top = serie[:5]
    linha = {'recorde': 'maior geração diária desde o início da operação',
             'meta': f'{fato.get("ufv", "")}: meta do mês batida em {dia[8:]}/{dia[5:7]}',
             'marco': 'energia gerada desde janeiro de 2025'}[fato['tipo']]
    quadros = []
    for q in range(int(FPS * 6.5)):
        t = q / FPS
        im = Image.new('RGB', (W, H), FUNDO); d = ImageDraw.Draw(im)
        d.rounded_rectangle((50, 50, W - 50, H - 50), 36, fill=(255, 255, 255), outline=BORDA, width=2)
        d.text((100, 105), 'SIGO · CONJUNTO FOTOVOLTAICO MAURITI', font=F(26, False), fill=T3)
        a = ease(t / .6)
        d.text((100, 150), TITULO[fato['tipo']], font=F(64), fill=mix(T1, a))
        d.text((100, 235), f'{dia[8:]}/{dia[5:7]}/{dia[:4]}', font=F(38, False), fill=mix(T3, a))
        num = nf(valor * ease((t - .5) / 2.0), 2)
        d.text((100, 320), num, font=F(128), fill=T1)
        d.text((100 + d.textlength(num, font=F(128)) + 16, 400), unidade, font=F(44, False), fill=T3)
        if t > 2.6:
            d.text((100, 500), linha, font=F(34, False), fill=mix(GER_T, ease((t - 2.6) / .5)))
        if top:
            y0, hb, gap = 600, 86, 22; vmax = top[0][0]; wmax = W - 100 - 340
            for i, (v, dd) in enumerate(top):
                e = ease((t - 1.0 - i * .25) / 1.4); y = y0 + i * (hb + gap); foco = dd == dia
                d.rounded_rectangle((300, y, 300 + wmax, y + hb), 14, fill=(238, 240, 243))
                wb = int(wmax * (v / vmax) * e)
                if wb > 20:
                    d.rounded_rectangle((300, y, 300 + wb, y + hb), 14, fill=mix(GER, .55 if foco else .22), outline=mix(GER, .9 if foco else .45), width=2)
                d.text((100, y + 16), f'{i + 1}º', font=F(40), fill=GER_T if foco else T3)
                d.text((160, y + 22), f'{dd[8:]}/{dd[5:7]}/{dd[2:4]}', font=F(30, foco), fill=T1 if foco else T2)
        quadros.append(im)
    w = imageio_ffmpeg.write_frames(saida, (W, H), fps=FPS, codec='libx264', pix_fmt_out='yuv420p', quality=8, macro_block_size=8)
    w.send(None)
    for im in quadros + [quadros[-1]] * (FPS * 2):
        w.send(im.tobytes())
    w.close()
    png = saida[:-4] + '.png'
    quadros[-1].save(png)
    return saida, png
