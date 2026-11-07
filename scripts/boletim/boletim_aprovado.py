# -*- coding: utf-8 -*-
"""Relatório diário e semanal do SIGO para o WeCom (imagem). Protótipo v2.
    python gera_v2.py diario 2026-11-06
    python gera_v2.py semanal 2026-11-06      (semana de sábado a sexta que termina no dia dado)
Lê executivo.json, pr_ufv.json, sg_disp_dia.json, irr_ufv.json e benchmark_ne.json (cópias do que está publicado)."""
import json, math, os, re, sys, datetime as dt

AQUI = os.path.dirname(os.path.abspath(__file__))
ld = lambda n: json.load(open(os.path.join(AQUI, n), encoding='utf-8'))
EX, PR, DS, IR, BN = ld('executivo.json'), ld('pr_ufv.json'), ld('sg_disp_dia.json'), ld('irr_ufv.json'), ld('benchmark_ne.json')
MODO = sys.argv[1] if len(sys.argv) > 1 else 'diario'
DIA = sys.argv[2] if len(sys.argv) > 2 else '2026-11-06'
d0 = dt.date.fromisoformat(DIA)

COR = {'Complexo': '#B85137', 'PPA': '#498DF2', 'M1': '#F0509C', 'M2': '#F3D020', 'M3': '#01816E', 'M4': '#DBE3BF',
       'M5': '#AB43D0', 'M6': '#C79889', 'M7': '#DABFE3', 'M8': '#7453FE', 'M9': '#2CDBE8'}
GER, CORTE, OK, ATN, RUIM, IRR = '#F5A623', '#A79BE8', '#43966B', '#FF8A3D', '#C85C60', '#E8C547'
NEUTRO1, NEUTRO2 = '#8B93A1', '#5C6370'   # Abaiara e Nordeste: referências externas, sem cor de entidade
FUNDO, PAINEL, BORDA = '#0A0B0D', '#111317', '#25272C'
T1, T2, T3 = '#FAFBFC', '#DCE1E8', '#A3ABB8'
TRILHO, LINHA, RODA, BASE_ROT = '#16181C', '#1A1C21', '#6B7280', '#F2F4F7'
TEMA = os.environ.get('TEMA', 'escuro')
if TEMA == 'claro':   # claro do SIGO Dados: textos #05070A/#232A33/#434B57; cores de entidade na variante hex_claro do aurora
    FUNDO, PAINEL, BORDA = '#F3F4F6', '#FFFFFF', '#E1E4E9'
    T1, T2, T3 = '#05070A', '#232A33', '#434B57'
    TRILHO, LINHA, RODA, BASE_ROT = '#EEF0F3', '#EEF0F3', '#5C6370', '#05070A'
    COR.update({'M1': '#B6056C', 'M2': '#A58C03', 'M3': '#22907C', 'M4': '#4E5435', 'M6': '#B08374', 'M7': '#9E84A6', 'M9': '#049AA4'})
    GER, IRR = '#BF7E04', '#B8920F'
US = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']
PPA = ['M2', 'M3', 'M4', 'M5', 'M6', 'M8']
CAP = DS['capacidade_mw']

def nf(v, c=2):
    if v is None: return '—'
    return f'{v:,.{c}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')
def mix(c, p):
    if TEMA == 'claro': p = min(round(p * 1.9), 92)   # no branco o véu fica mais cheio (pedido do humano, 07/11)
    return f'color-mix(in srgb, {c} {p}%, transparent)'
def rot(c): return f'color-mix(in srgb, {c} 55%, {BASE_ROT})'
def ddmm(d): return f'{d[8:]}/{d[5:7]}'

# ---------------- fontes por dia ----------------
LIQ = {}   # (ufv, dia) -> (liq_mwh, meta_dia, parcial)
for r in EX['serie_dia_ufv']:
    if r['liq_mwh'] is not None: LIQ[(r['ufv'], r['dia'])] = (r['liq_mwh'], r['meta_dia_mwh'], r['parcial'])
SD = {r['dia']: r for r in EX['serie_diaria']}                     # ONS: entregue, cortado, potencial, horas
BD = {r['dia']: r for r in BN['serie_dia']}                         # corte Mauriti × Abaiara × NE
IRD = {r['dia']: r for r in IR['serie_dia'] if r['ufv'] == 'Complexo'}
DSD = {r['dia']: r for r in DS['serie']}
PRD = {u: {d['dia']: d for d in PR['entidades'][u]['dias']} for u in PR['entidades']}

def pr_dias(us, dias):
    """PR do conjunto: soma da energia injetada ÷ soma do denominador (placa × irradiação); idem com a impedida."""
    inj = den = imp = 0; ok = True
    for u in us:
        for d in dias:
            x = PRD[u].get(d)
            if not x or x['pr_pct'] is None: ok = False; continue
            inj += x['inj_mwh']; den += x['den_mwh']; imp += x['impedida_mwh'] or 0
    if not den: return None, None
    return inj / den * 100, (inj + imp) / den * 100

def disp_dias(us, dias):
    num = den = 0
    for d in dias:
        x = DSD.get(d)
        if not x: continue
        for u in us:
            v = x.get(f'{u}_disp_sol_pct')
            if v is not None: num += v * CAP[u]; den += CAP[u]
    return num / den if den else None

def corte_bench(dias):
    out = {}
    for k in ('nosso', 'abaiara', 'ne'):
        g = sum(BD[d][f'{k}_gerado_gwh'] for d in dias if d in BD); c = sum(BD[d][f'{k}_cortado_gwh'] for d in dias if d in BD)
        out[k] = c / (g + c) * 100 if g + c else None
    return out

# ---------------- meta do mês (Complexo e PPA) ----------------
import calendar
MES = DIA[:7]; NT = calendar.monthrange(d0.year, d0.month)[1]; D = d0.day
man = {m['ufv']: m for m in EX['manchete_ufv'] if m['mes'] == MES}
erro = EX['confianca_projecao']['erro_pp']
def meta_mes(u):
    dias = [f'{MES}-{i:02d}' for i in range(1, D + 1)]
    s = [LIQ[(u, d)][0] for d in dias if (u, d) in LIQ and not LIQ[(u, d)][2]]
    tot = sum(s); mm = man[u]['meta_mwh']; proj = tot / len(s) * NT
    r = dict(tot=tot, meta=mm, pct=tot / mm * 100, proj=proj, proj_pct=proj / mm * 100, s=s, meta_dia=LIQ[(u, dias[0])][1])
    # o dia em que o acumulado passou da meta, ou a data prevista no ritmo dos dias fechados (e no ritmo mais fraco da faixa histórica)
    a = 0; r['bateu'] = None
    for i, v in enumerate(s, 1):
        a += v
        if a >= mm and r['bateu'] is None: r['bateu'] = f'{MES}-{i:02d}'
    if r['bateu'] is None and tot > 0:
        ritmo = tot / len(s); falta = mm - tot
        n = math.ceil(falta / ritmo); n_lo = math.ceil(falta / (ritmo * max(r['proj_pct'] - erro, 1) / r['proj_pct']))
        r['prev'] = len(s) + n; r['prev_lo'] = len(s) + n_lo
    return r

def chip_meta(r):
    if r['bateu']: return (f'meta batida em {ddmm(r["bateu"])}', OK)
    if MODO == 'mensal': return (f'faltaram {nf(r["meta"] - r["tot"], 2)} MWh', RUIM)
    if r['prev'] > NT: return ('no ritmo atual não bate no mês', RUIM)
    dia = f'{r["prev"]:02d}/{MES[5:]}'
    if r['prev_lo'] <= NT: return (f'previsão de bater: {dia}', OK)
    return (f'previsão de bater: {dia} · no ritmo fraco, não bate', ATN)

# ---------------- componentes ----------------
def anel(u, r):
    W, R, sw = 300, 108, 16; cx = cy = W / 2; ESC = 150
    def pt(p, rr):
        a = 2 * math.pi * p - math.pi / 2; return cx + rr * math.cos(a), cy + rr * math.sin(a)
    def arco(p, rr):
        p = max(0.0001, min(p, 0.9999)); x, y = pt(p, rr)
        return f'M {cx} {cy-rr} A {rr} {rr} 0 {1 if p > .5 else 0} 1 {x:.2f} {y:.2f}'
    c = COR[u]; lo, hi = max(r['proj_pct'] - erro, 0) / ESC, min(r['proj_pct'] + erro, ESC) / ESC
    x1, y1 = pt(lo, R + 30); x2, y2 = pt(hi, R + 30)
    t1, t2 = pt(100 / ESC, R + 21), pt(100 / ESC, R + 39)
    chip = chip_meta(r); fechado = MODO == 'mensal'
    return f'''<div class="anel"><svg viewBox="-24 -24 {W+48} {W+48}" width="290" height="290">
  <circle cx="{cx}" cy="{cy}" r="{R}" stroke="{BORDA}" stroke-width="{sw}" fill="none"/>
  <path d="{arco(r['pct']/ESC, R)}" stroke="{mix(c,70)}" stroke-width="{sw}" fill="none" stroke-linecap="round"/>
  {'' if fechado else f'<circle cx="{cx}" cy="{cy}" r="{R+30}" stroke="{TRILHO}" stroke-width="10" fill="none"/>'}
  {'' if fechado else f'<path d="M {x1:.2f} {y1:.2f} A {R+30} {R+30} 0 {1 if hi-lo>.5 else 0} 1 {x2:.2f} {y2:.2f}" stroke="{mix(c,24)}" stroke-width="10" fill="none" stroke-linecap="round"/>'}
  {'' if fechado else f'<path d="{arco(min(r["proj_pct"],ESC)/ESC, R+30)}" stroke="{mix(c,55)}" stroke-width="2.5" fill="none" stroke-dasharray="2 5" stroke-linecap="round"/>'}
  <line x1="{t1[0]:.1f}" y1="{t1[1]:.1f}" x2="{t2[0]:.1f}" y2="{t2[1]:.1f}" stroke="{T2}" stroke-width="2.5"/>
  <text x="{cx}" y="{cy-30}" text-anchor="middle" class="sv-lbl" fill="{rot(c)}">{u.upper()}</text>
  <text x="{cx}" y="{cy+18}" text-anchor="middle" class="sv-big">{nf(r['pct'],1)}<tspan class="sv-u">%</tspan></text>
  <text x="{cx}" y="{cy+46}" text-anchor="middle" class="sv-sub">da meta do mês</text></svg>
 {f'<div class="anel-proj">{nf(r["tot"],2)} de {nf(r["meta"],2)} MWh</div>' if fechado else f'<div class="anel-proj">projeção <b style="color:{rot(c)}">{nf(r["proj_pct"],0)}%</b> <span>faixa {nf(max(r["proj_pct"]-erro,0),0)}–{nf(r["proj_pct"]+erro,0)}%</span></div>'}
 <div class="chip" style="color:{rot(chip[1])};background:{mix(chip[1],14)};border-color:{mix(chip[1],50)}">{chip[0]}</div></div>'''

def anel_fechado(u, r):
    W, R, sw = 300, 108, 18; cx = cy = W / 2; c = COR[u]
    def pt(p, rr):
        a = 2 * math.pi * p - math.pi / 2; return cx + rr * math.cos(a), cy + rr * math.sin(a)
    def arco(p, rr):
        p = max(0.0001, min(p, 0.9999)); x, y = pt(p, rr)
        return f'M {cx} {cy-rr} A {rr} {rr} 0 {1 if p > .5 else 0} 1 {x:.2f} {y:.2f}'
    base = min(r['pct'], 100) / 100; extra = max(r['pct'] - 100, 0) / 100
    volta = (f'<circle cx="{cx}" cy="{cy}" r="{R-24}" stroke="{TRILHO}" stroke-width="10" fill="none"/>'
             f'<path d="{arco(extra, R-24)}" stroke="{mix(c,95)}" stroke-width="10" fill="none" stroke-linecap="round"/>') if extra > 0 else ''
    chip = chip_meta(r)
    sobra = f'+{nf(r["pct"]-100,1)}% acima da meta' if extra > 0 else f'{nf(100-r["pct"],1)}% abaixo da meta'
    return f'''<div class="anel"><svg viewBox="-24 -24 {W+48} {W+48}" width="290" height="290">
  <circle cx="{cx}" cy="{cy}" r="{R}" stroke="{TRILHO}" stroke-width="{sw}" fill="none"/>
  <path d="{arco(base, R)}" stroke="{mix(c,70)}" stroke-width="{sw}" fill="none" stroke-linecap="round"/>{volta}
  <text x="{cx}" y="{cy-26}" text-anchor="middle" class="sv-lbl" fill="{rot(c)}">{u.upper()}</text>
  <text x="{cx}" y="{cy+18}" text-anchor="middle" class="sv-big" style="font-size:46px">{nf(r['pct'],1)}<tspan class="sv-u">%</tspan></text>
  <text x="{cx}" y="{cy+42}" text-anchor="middle" class="sv-sub">da meta do mês</text></svg>
 <div class="anel-proj"><b style="color:{rot(c)}">{sobra}</b></div>
 <div class="anel-proj" style="margin-top:2px">{nf(r["tot"],2)} de {nf(r["meta"],2)} MWh</div>
 <div class="chip" style="color:{rot(chip[1])};background:{mix(chip[1],14)};border-color:{mix(chip[1],50)}">{chip[0]}</div></div>'''

def gauge_mes(u, r):
    """o gauge do SIGO Dados (painel ao vivo, carregamento do trafo): arco de 270° aberto embaixo, trilho claro, barra na cor da entidade,
    número grande no centro; a meta como MARCA FINA na borda de fora (sem faixa de cor: o estado vai no texto)"""
    c = COR[u]; cx, cy, rr, w = 150, 140, 104, 22; mx = max(150.0, math.ceil(r['pct'] / 10) * 10); A0, A1 = 225, -45
    def ang(v): return math.radians(A0 - (A0 - A1) * max(0, min(1, v / mx)))
    def pt(v, q): a = ang(v); return cx + q * math.cos(a), cy - q * math.sin(a)
    def arc(v0, v1, q):
        a, b = pt(v0, q), pt(v1, q); g = 1 if (v1 - v0) / mx * 270 > 180 else 0
        return f'M{a[0]:.1f} {a[1]:.1f} A{q} {q} 0 {g} 1 {b[0]:.1f} {b[1]:.1f}'
    rb = rr + w / 2 + 6; i, e, l = pt(100, rb - 3), pt(100, rb + 6), pt(100, rb + 20); p0, p1 = pt(0, rr), pt(mx, rr)
    chip = chip_meta(r)
    sobra = f'+{nf(r["pct"]-100,1)}% acima da meta' if r['pct'] >= 100 else f'{nf(100-r["pct"],1)}% abaixo da meta'
    return f'''<div class="anel"><svg viewBox="0 0 300 262" width="300" height="262">
  <path d="{arc(0, mx, rb)}" stroke="{BORDA}" stroke-width="2" fill="none"/>
  <path d="{arc(0, mx, rr)}" stroke="{TRILHO}" stroke-width="{w}" fill="none"/>
  <path d="{arc(0, max(.001, min(mx, r['pct'])), rr)}" stroke="{mix(c,30)}" stroke-width="{w}" fill="none"/>
  <path d="{arc(0, max(.001, min(mx, r['pct'])), rr + w/2 - 1)}" stroke="{mix(c,45)}" stroke-width="2" fill="none"/>
  <line x1="{i[0]:.1f}" y1="{i[1]:.1f}" x2="{e[0]:.1f}" y2="{e[1]:.1f}" stroke="{T2}" stroke-width="2.5"/>
  <text x="{l[0]:.1f}" y="{l[1]+4:.1f}" text-anchor="middle" class="sv-ax" style="font-weight:600">meta</text>
  <text x="{cx}" y="{cy-34}" text-anchor="middle" class="sv-lbl" fill="{rot(c)}">{u.upper()}</text>
  <text x="{cx}" y="{cy+12}" text-anchor="middle" class="sv-big" style="font-size:46px">{nf(r['pct'],1)}<tspan class="sv-u">%</tspan></text>
  <text x="{cx}" y="{cy+36}" text-anchor="middle" class="sv-sub">da meta do mês</text>
  <text x="{p0[0]:.1f}" y="{p0[1]+28:.1f}" text-anchor="middle" class="sv-ax">0</text>
  <text x="{p1[0]:.1f}" y="{p1[1]+28:.1f}" text-anchor="middle" class="sv-ax">{nf(mx,0)}%</text></svg>
 <div class="anel-proj"><b style="color:{rot(c)}">{sobra}</b></div>
 <div class="anel-proj" style="margin-top:2px">{nf(r["tot"],2)} de {nf(r["meta"],2)} MWh</div>
 <div class="chip" style="color:{rot(chip[1])};background:{mix(chip[1],14)};border-color:{mix(chip[1],50)}">{chip[0]}</div></div>'''

def curva(u, r, W=420, H=200):
    c = COR[u]; mm = r['meta']; top = max(mm, r['proj'] * (1 + erro / 100)) * 1.06
    X = lambda d: 10 + (W - 20) * d / NT; Y = lambda v: H - 22 - (H - 34) * v / top
    pts, a = [(0, 0)], 0
    for i, v in enumerate(r['s'], 1): a += v; pts.append((i, a))
    n = len(r['s']); path = ' '.join(f'{"M" if i==0 else "L"} {X(d):.1f} {Y(v):.1f}' for i, (d, v) in enumerate(pts))
    p_fim = r['proj']; p_lo, p_hi = p_fim * (1 - erro / r['proj_pct']), p_fim * (1 + erro / r['proj_pct'])
    ym, yp = (Y(mm) - 8, Y(p_fim) + 17) if p_fim < mm else (Y(mm) + 17, Y(p_fim) - 8)
    fechado = MODO == 'mensal'
    return f'''<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block">
  <line x1="{X(0)}" y1="{Y(0)}" x2="{X(NT)}" y2="{Y(0)}" stroke="{BORDA}"/>
  <line x1="{X(0)}" y1="{Y(0)}" x2="{X(NT)}" y2="{Y(mm):.1f}" stroke="{T3}" stroke-width="1.2" stroke-dasharray="5 4"/>
  <circle cx="{X(NT):.1f}" cy="{Y(mm):.1f}" r="3" fill="{T3}"/>
  <text x="{X(NT)-6:.1f}" y="{ym:.1f}" text-anchor="end" class="sv-ax">meta {nf(mm,0)} MWh</text>
  {'' if fechado else f'<path d="M {X(n):.1f} {Y(a):.1f} L {X(NT):.1f} {Y(p_hi):.1f} L {X(NT):.1f} {Y(p_lo):.1f} Z" fill="{mix(c,12)}"/>'}
  {'' if fechado else f'<line x1="{X(n):.1f}" y1="{Y(a):.1f}" x2="{X(NT):.1f}" y2="{Y(p_fim):.1f}" stroke="{mix(c,65)}" stroke-width="1.5" stroke-dasharray="2 4"/>'}
  <path d="{path} L {X(n):.1f} {Y(0):.1f} Z" fill="{mix(c,20)}"/><path d="{path}" stroke="{mix(c,85)}" stroke-width="2" fill="none"/>
  <circle cx="{X(n):.1f}" cy="{Y(a):.1f}" r="4" fill="{c}"/>
  <text x="{X(NT)-6:.1f}" y="{yp:.1f}" text-anchor="end" class="sv-ax" fill="{rot(c)}">{'realizado' if fechado else 'projeção'} {nf(p_fim,0)} MWh</text>
  <text x="{X(0)}" y="{H-4}" class="sv-ax">01/{MES[5:]}</text><text x="{X(NT)}" y="{H-4}" text-anchor="end" class="sv-ax">{NT}/{MES[5:]}</text></svg>
  <div class="mini-n"><b>{nf(a,2)}</b> MWh {'no mês' if fechado else 'até ' + ddmm(DIA)} · {('sobra ' + nf(a-mm,2)) if a >= mm else ('falta ' + nf(mm-a,2))} MWh</div>'''

def barras_ger_irr(dias, W=1000):
    """Geração + impedido (barras) com a meta do dia; irradiação logo abaixo, no mesmo eixo de dias (nunca dois eixos)."""
    H1, H2 = 220, 92; n = len(dias); bw = (W - 50) / n
    vals = [(LIQ.get(('Complexo', d), (0, 0, 0)), SD.get(d, {}).get('cortado_mwh', 0) or 0) for d in dias]
    top = max(l[0] + c for l, c in vals) * 1.1
    Y = lambda v: H1 - 6 - (H1 - 30) * v / top
    g = []
    for i, (d, ((liq, meta, _), ct)) in enumerate(zip(dias, vals)):
        x = 30 + i * bw + bw * .16; w = bw * .68; foco = d == DIA and MODO == 'diario'
        g.append(f'<rect x="{x:.1f}" y="{Y(liq):.1f}" width="{w:.1f}" height="{Y(0)-Y(liq):.1f}" rx="4" fill="{mix(GER, 46 if foco else 26)}" stroke="{mix(GER, 75 if foco else 45)}"/>')
        if ct > 0: g.append(f'<rect x="{x:.1f}" y="{Y(liq+ct):.1f}" width="{w:.1f}" height="{max(Y(liq)-Y(liq+ct)-2,1):.1f}" rx="4" fill="{mix(CORTE, 26)}" stroke="{mix(CORTE, 55)}"/>')
        g.append(f'<line x1="{x-4:.1f}" x2="{x+w+4:.1f}" y1="{Y(meta):.1f}" y2="{Y(meta):.1f}" stroke="{mix(T2,85)}" stroke-width="2"/>')
        if foco or n <= 7:
            g.append(f'<text x="{x+w/2:.1f}" y="{Y(liq+ct)-9:.1f}" text-anchor="middle" class="sv-val">{nf(liq,0)}</text>')
    if n > 20: g = [x.replace('class="sv-ax"', 'class="sv-ax" style="font-size:10px"') for x in g]
    irr = [IRD.get(d, {}).get('gti') for d in dias]; itop = max(v or 0 for v in irr) * 1.15
    YI = lambda v: H1 + H2 - 26 - (H2 - 36) * v / itop
    for i, (d, v) in enumerate(zip(dias, irr)):
        x = 30 + i * bw + bw * .16; w = bw * .68
        if v: g.append(f'<rect x="{x:.1f}" y="{YI(v):.1f}" width="{w:.1f}" height="{YI(0)-YI(v):.1f}" rx="3" fill="{mix(IRR, 22)}" stroke="{mix(IRR, 45)}"/>'
                       f'<text x="{x+w/2:.1f}" y="{YI(v)-5:.1f}" text-anchor="middle" class="sv-ax2">{nf(v,1)}</text>')
        g.append(f'<text x="{x+w/2:.1f}" y="{H1+H2-6}" text-anchor="middle" class="sv-ax" {f"style=\"fill:{T1};font-weight:700\"" if d==DIA and MODO=='diario' else ""}>{int(d[8:]) if len({x[:7] for x in dias}) == 1 else ddmm(d)}</text>')
    return f'<svg viewBox="0 0 {W} {H1+H2}" style="width:100%;height:auto;display:block">{"".join(g)}</svg>'

def bench(blocos, W=1000):
    """Corte do ONS em %: Mauriti × Abaiara × Nordeste, por período."""
    ser = [('nosso', 'Mauriti', COR['Complexo']), ('abaiara', 'Abaiara', NEUTRO1), ('ne', 'Nordeste (solar)', NEUTRO2)]
    top = max([v for _, b in blocos for v in b.values() if v is not None] + [10]) * 1.15
    rows = []
    for lbl, b in blocos:
        rows.append(f'<div class="bh">{lbl}</div>')
        for k, nome, c in ser:
            v = b[k]; w = (v or 0) / top * 100
            rows.append(f'<div class="bl"><span style="color:{rot(c) if k=="nosso" else T3}">{nome}</span><div class="bt"><div class="bf" style="width:{w:.1f}%;background:{mix(c, 34 if k=="nosso" else 22)};border-color:{mix(c,60)}"></div></div><b>{nf(v,1)}%</b></div>')
    return ''.join(rows)

MOTIVO = {'ENE': ('Energética', '#A79BE8'), 'CNF': ('Confiabilidade elétrica', '#7A6FB5'), 'REL': ('Restrição elétrica', '#544B85')}
ORIGEM = {'SIS': ('Sistêmica', '#A79BE8'), 'LOC': ('Local', '#7A6FB5')}
def soma_razao(dias, campo):
    t = {}
    for d in dias:
        for k, v in (SD.get(d, {}).get(campo) or {}).items(): t[k] = t.get(k, 0) + (v.get('mwh') or 0)
    return t
def barra100(nome, t, mapa):
    tot = sum(t.values())
    if tot <= 0: return f'<div class="mo"><span class="mo-n">{nome}</span><div class="mo-z">sem energia impedida</div><b></b></div>'
    itens = [(k, v) for k, v in sorted(t.items(), key=lambda x: -x[1]) if v > 0]
    seg = ''.join(f'<div class="mo-s" style="flex:{v:.2f};background:{mix(mapa.get(k, (k, T3))[1], 40)};border-color:{mix(mapa.get(k, (k, T3))[1], 80)}{'' if v / tot >= .15 else ';padding:0;min-width:3px'}">'
                  + (f'{mapa.get(k, (k, T3))[0]} · {nf(v / tot * 100, 1)}%' if v / tot >= .15 else '') + '</div>' for k, v in itens)
    miudo = [f'{mapa.get(k, (k, T3))[0]} {nf(v / tot * 100, 1)}% ({nf(v, 2)} MWh)' for k, v in itens if v / tot < .15]
    extra = f'<div class="mo-x">também: {" · ".join(miudo)}</div>' if miudo else ''
    return f'<div class="mo"><span class="mo-n">{nome}</span><div><div class="mo-b">{seg}</div>{extra}</div><b>{nf(tot, 2)} MWh</b></div>'
def painel_motivo(blocos):
    rows = ''.join(f'<div class="bh">{lbl}</div>' + barra100('Motivo', soma_razao(ds, 'razoes'), MOTIVO) + barra100('Origem', soma_razao(ds, 'origens'), ORIGEM) for lbl, ds in blocos)
    return (f'<div class="pn"><div class="pt"><h2>Corte do ONS · motivo e origem</h2><small>razão e origem declaradas pelo ONS em cada intervalo</small></div>{rows}'
            f'<div class="leg" style="justify-content:flex-start;text-align:left">Energética: excesso de geração no sistema · Confiabilidade elétrica: limite operativo da rede · '
            f'Restrição elétrica: equipamento externo indisponível · Sistêmica × Local: se a causa está no sistema ou na região do conjunto</div></div>')

def usinas(dias):
    rows = []
    for u in US:
        g = sum(LIQ.get((u, d), (0,))[0] for d in dias)
        p, pc = pr_dias([u], dias); ds = disp_dias([u], dias); c = COR[u]
        rows.append(f'''<div class="us"><div class="us-n"><i style="background:{c}"></i>{u}</div>
  <div class="us-g">{nf(g,2)} <small>MWh</small></div>
  <div class="us-bar"><div class="us-f" style="width:{min(pc or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(pc,1)}%</span></div>
  <div class="us-d">{nf(ds,2)}%</div></div>''')
    return ''.join(rows)

PV_P50 = {'01': 85.587, '02': 76.824, '03': 84.108, '04': 80.187, '05': 75.905, '06': 71.020, '07': 71.323, '08': 87.375,
          '09': 91.944, '10': 94.639, '11': 91.356, '12': 88.147}   # GWh, PVsyst do estudo de viabilidade (fev/2023), o mesmo do SIGO Dados
P90_FATOR = 959.0 / 998.416
def p50_dias(dias):
    import calendar
    return sum(PV_P50[d[5:7]] * 1000 / calendar.monthrange(int(d[:4]), int(d[5:7]))[1] for d in dias)
def card_p50(dias, entregue, impedido):
    p50 = p50_dias(dias); p90 = p50 * P90_FATOR
    return kpi(T3, 'P50 · P90 do projeto', nf(entregue / p50 * 100, 1), '% do P50',
               f'com o impedido {nf((entregue + impedido) / p50 * 100, 1)}% · P90 {nf(entregue / p90 * 100, 1)}%')

def kpi(cor, k, v, u, sub):
    return f'<div class="kc" style="--c:{cor}"><div class="k">{k}</div><b>{v}<small> {u}</small></b><p>{sub}</p></div>'

CSS = f'''*{{box-sizing:border-box;margin:0;padding:0}}
body{{background:{FUNDO};color:{T2};font-family:Inter,'Segoe UI',sans-serif;width:1080px;padding:36px 40px 30px}}
.top{{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:1px solid {BORDA};padding-bottom:18px}}
.k{{font:600 12px 'JetBrains Mono',monospace;letter-spacing:.13em;color:{T3};text-transform:uppercase}}
h1{{font-size:38px;font-weight:800;color:{T1};letter-spacing:-.02em;margin-top:6px}} h1 span{{color:{rot(GER)}}}
.dt{{text-align:right}} .dt b{{display:block;font-size:28px;color:{T1};font-weight:700}} .dt small{{color:{T3};font-size:14px}}
.pn{{background:{PAINEL};border:1px solid {BORDA};border-radius:16px;padding:20px 22px;margin-top:16px}}
.pt{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;gap:16px}}
.pt h2{{font-size:19px;color:{T1};font-weight:700;white-space:nowrap}} .pt small{{color:{T3};font-size:12.5px;text-align:right}}
.duas{{display:grid;grid-template-columns:1fr 1fr;gap:18px}} .col{{display:flex;flex-direction:column;align-items:center}}
.anel{{text-align:center}}
.sv-lbl{{font:700 15px 'JetBrains Mono',monospace;letter-spacing:.16em}} .sv-big{{font:800 52px Inter;fill:{T1};letter-spacing:-.03em}}
.sv-u{{font-size:25px;fill:{T3}}} .sv-sub{{font:500 14px Inter;fill:{T3}}} .sv-ax{{font:500 12px Inter;fill:{T3}}} .sv-ax2{{font:600 11.5px Inter;fill:{rot(IRR)}}}
.sv-val{{font:700 14px Inter;fill:{T1}}}
.anel-proj{{font-size:15px;color:{T3};margin-top:-8px}} .anel-proj b{{font-size:23px;margin:0 6px}} .anel-proj span{{font-size:12.5px}}
.chip{{display:inline-block;margin-top:9px;padding:5px 14px;border-radius:999px;border:1px solid;font-size:13px;font-weight:600}}
.mini-n{{font-size:13px;color:{T3};margin-top:2px}} .mini-n b{{color:{T1};font-size:16px}}
.leg{{display:flex;gap:18px;color:{T3};font-size:12px;margin-top:12px;justify-content:center;flex-wrap:wrap}}
.kp{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}}
.kc{{background:{PAINEL};border:1px solid {BORDA};border-left:4px solid var(--c);border-radius:12px;padding:13px 15px 13px 16px}}
.kc .k{{font-size:10.5px}} .kc b{{display:block;font-size:27px;color:{T1};font-weight:800;margin-top:6px;letter-spacing:-.02em}}
.kc b small{{font-size:13px;color:{T3};font-weight:500}} .kc p{{font-size:12px;color:{T3};margin-top:2px}}
.bh{{font:600 12px 'JetBrains Mono',monospace;letter-spacing:.12em;color:{T3};text-transform:uppercase;margin:10px 0 6px}} .bh:first-child{{margin-top:0}}
.bl{{display:grid;grid-template-columns:160px 1fr 70px;gap:14px;align-items:center;padding:4px 0}} .bl span{{font-size:15px;font-weight:600}}
.bl b{{text-align:right;color:{T1};font-size:16px}} .bt{{height:18px;background:{TRILHO};border-radius:5px;position:relative}}
.bf{{position:absolute;left:0;top:0;bottom:0;border:1px solid;border-radius:5px}}
.us{{display:grid;grid-template-columns:90px 150px 1fr 100px;align-items:center;gap:16px;padding:7px 0;border-top:1px solid {LINHA}}}
.ush{{display:grid;grid-template-columns:90px 150px 1fr 100px;gap:16px;font-size:11.5px;color:{T3};margin-bottom:2px}} .ush div:nth-child(4),.us-d{{text-align:right}}
.us-n{{font-weight:700;color:{T1};font-size:16px}} .us-n i{{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px}}
.us-g{{color:{T1};font-weight:600;font-size:15px;text-align:right}} .us-g small{{color:{T3};font-weight:500;font-size:11px}}
.us-bar{{position:relative;height:20px;background:{TRILHO};border-radius:5px}} .us-f{{position:absolute;left:0;top:0;bottom:0;border-radius:5px;border:1px solid}}
.us-bar span{{position:absolute;right:8px;top:1px;font-size:13px;font-weight:700;color:{T1}}} .us-d{{font-weight:700;font-size:15px;color:{T1}}}
.mo{{display:grid;grid-template-columns:90px 1fr 150px;gap:14px;align-items:center;padding:5px 0}} .mo-n{{font-size:14px;color:{T3}}} .mo b{{text-align:right;color:{T1};font-size:15px}}
.mo-b{{display:flex;gap:3px;height:30px}} .mo-s{{border:1px solid;border-radius:6px;font-size:12.5px;font-weight:600;color:{T1};display:flex;align-items:center;padding:0 10px;white-space:nowrap;overflow:hidden;min-width:0}}
.mo-x{{font-size:12.5px;color:{T3};margin-top:4px}}
.mo-z{{font-size:14px;color:{T3};font-style:italic}}
.ft li{{list-style:none;display:flex;gap:14px;align-items:flex-start;padding:9px 0;border-top:1px solid {LINHA};font-size:16px;line-height:1.4}}
.ft li:first-child{{border-top:0}} .ft b{{color:{T1}}}
.ft em{{font-style:normal;flex:0 0 30px;height:30px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px}}
.top2{{display:flex;justify-content:space-between;border-bottom:1px solid {BORDA};padding-bottom:12px}}
@page{{margin:0}} html{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
.rodape{{margin-top:16px;color:{RODA};font-size:11.5px;line-height:1.5}}'''

import base64
LOGO64 = base64.b64encode(open(r'C:\Users\user\OneDrive - rbenergy.com.br\PWC\Logo_Intrepid\logo_intrepid_800.png', 'rb').read()).decode()
EMPRESA, CONJ = 'Intrepid Participações S.A.', 'Conjunto Fotovoltaico Mauriti'
RDO_AZUL, RDO_SUB, RDO_ROD, RDO_ROD_L = '#0D47A1', '#64748B', '#787878', '#969696'
GERADO = dt.datetime.now().strftime('%d/%m/%Y %H:%M')
CSS += f'''.cab{{display:flex;justify-content:space-between;align-items:flex-start;font-family:Arial,'Liberation Sans',sans-serif;padding-bottom:12px;border-bottom:2.5px solid {RDO_AZUL}}}
.cab img{{height:62px;display:block;margin-bottom:6px}} .cab .emp{{font-size:22px;font-weight:700;color:{RDO_AZUL}}} .cab .cj{{font-size:15px;color:{RDO_SUB};margin-top:2px}}
.cab .dir{{text-align:right;line-height:1.45}} .cab .ti{{font-size:24px;font-weight:700;color:{T1}}} .cab .li{{font-size:14.5px;color:{RDO_SUB}}}
.rd{{font-family:Arial,'Liberation Sans',sans-serif;margin-top:14px;border-top:1px solid {RDO_ROD_L};padding-top:6px;font-size:12.5px;color:{RDO_ROD}}}
.rd .c{{text-align:center}} .rd .b{{display:flex;justify-content:space-between;margin-top:6px}}'''
def pagina(titulo, data, sub, corpo, rodape, parte=0, n=1):
    topo = f'''<div class="cab"><div><img src="data:image/png;base64,{LOGO64}"><div class="emp">{EMPRESA}</div><div class="cj">{CONJ}</div></div>
<div class="dir"><div class="ti">{titulo}</div><div class="li">{data}</div><div class="li">{sub}</div><div class="li">gerado no SIGO em {GERADO}</div></div></div>'''
    pe = f'''<div class="rd"><div class="c">{EMPRESA} · {titulo} · gerado no SIGO em {GERADO}</div><div class="b"><span>{CONJ} · SIGO</span><span>{parte+1} / {n}</span></div></div>'''
    fonte = f'<div class="rodape">Fonte: {rodape}</div>' if rodape else ''
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
{topo}{corpo}{fonte}{pe}</body></html>'''

def _pagina_antiga(titulo, data, sub, corpo, rodape, parte=0, n=1):
    topo = (f'''<div class="top"><div><div class="k">SIGO · Complexo Fotovoltaico Mauriti · 343,77 MW</div><h1>{titulo}</h1></div>
<div class="dt"><b>{data}</b><small>{sub}</small></div></div>''' if parte == 0 else
            f'''<div class="top2"><span class="k">SIGO · {re.sub('<[^>]+>', '', titulo)} · {data}</span><span class="k">{parte+1}/{n}</span></div>''')
    return f'''<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<style>{CSS}</style></head><body>
{topo}{corpo}{f'<div class="rodape">{rodape}</div>' if rodape else ''}</body></html>'''

def fatos_html(f, data):
    return (f'<div class="pn"><div class="pt"><h2>Fatos relevantes</h2><small>{data}</small></div><ul class="ft">'
            + ''.join(f'<li><em style="color:{rot(c)};background:{mix(c,14)}">{i}</em><span>{t}</span></li>' for i, c, t in f) + '</ul></div>')

ROD = ('Geração: medição de faturamento (energia líquida). Restrição, potencial e comparação regional: dados do ONS (Abaiara = conjunto '
       'Abaiara 230 kV; Nordeste = usinas solares do subsistema). PR = energia injetada ÷ (potência de placa × irradiação no plano); '
       '"sem o corte" soma a energia impedida. Disponibilidade: inversores disponíveis nas meias horas de sol, ponderada pela potência. '
       f'Energia limitada estimada (quando o ONS não apura): irradiação × potência de placa × PR do próprio dia fora da limitação. Meta: Valor Garantido do mês. Projeção = ritmo dos dias fechados × dias do mês; faixa = erro médio da projeção no mesmo dia do mês em {EX["confianca_projecao"]["n_meses"]} meses.')
semana_nome = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']


def usinas2(dia, dias):
    """dia e mês lado a lado: geração do dia, geração do mês, PR do mês sem o corte, disponibilidade do mês"""
    rows = []
    for u in US:
        g1 = LIQ.get((u, dia), (0,))[0]; gm = sum(LIQ.get((u, d), (0,))[0] for d in dias)
        p, pc = pr_dias([u], dias); ds = disp_dias([u], dias); c = COR[u]
        rows.append(f"""<div class="us2"><div class="us-n"><i style="background:{c}"></i>{u}</div>
  <div class="us-g">{nf(g1,2)} <small>MWh</small></div><div class="us-g">{nf(gm,2)} <small>MWh</small></div>
  <div class="us-bar"><div class="us-f" style="width:{min(pc or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(pc,1)}%</span></div>
  <div class="us-d">{nf(ds,2)}%</div></div>""")
    return ''.join(rows)
CSS += f""".us2{{display:grid;grid-template-columns:70px 130px 150px 1fr 90px;align-items:center;gap:14px;padding:7px 0;border-top:1px solid {LINHA}}}
.ush2{{display:grid;grid-template-columns:70px 130px 150px 1fr 90px;gap:14px;font-size:11.5px;color:{T3};margin-bottom:2px}} .ush2 div:nth-child(2),.ush2 div:nth-child(3),.ush2 div:nth-child(5){{text-align:right}}"""

# -*- coding: utf-8 -*-
"""Bloco anexado ao gera_v4 (v5): curva do dia com os intervalos limitados, curvas por usina e o mês por usina."""
import ast as _ast
W2 = json.load(open(os.path.join(AQUI, 'way2_30min.json'), encoding='utf-8'))
DEM = {}                                    # (ponto, carimbo) -> MW médio da meia hora (Demat em kW)
for _p in W2['dados']:
    if _p['nomeGrandeza'] == 'Demat':
        for _x in _p['valores']: DEM[(_p['pontoId'], _x['data'])] = _x['valor'] / 1000
CIRC = {'M1': [6198, 6199, 6200], 'M2': [6201, 6202], 'M3': [6203, 6204, 6205], 'M4': [6206, 6207, 6208], 'M5': [6209, 6210, 6211],
        'M6': [6212, 6213, 6214], 'M7': [6215], 'M8': [6216, 6217, 6218], 'M9': [6219]}
PONTOS = {'Complexo': [6196, 6197], **CIRC}
def mw(u, ts):
    v = [DEM.get((p, ts)) for p in PONTOS[u]]
    return None if any(x is None for x in v) else sum(v)
ONS30 = {}
for _f in os.listdir(AQUI):
    if _f.startswith('ons_restricao_') and _f.endswith('.json'):
        _c = json.load(open(os.path.join(AQUI, _f), encoding='utf-8'))['consolidado']
        for _x in (_ast.literal_eval(_c) if isinstance(_c, str) else _c): ONS30[_x['ts'].replace(' ', 'T')] = _x
I30 = {}
for _x in json.load(open(os.path.join(AQUI, 'irr_plano_30min.json'), encoding='utf-8'))['serie']:
    _k = next((k for k in _x if k.startswith('gti_w_C')), None)
    if _k: I30[_x['t'][:19]] = _x[_k]
CDU = {(r['dia'], r['ufv']): r for r in EX['corte_diario_ufv']}
def f_(v):
    try: return float(v)
    except (TypeError, ValueError): return None

def slots(dia, h0=5, h1=19):
    return [f'{dia}T{h:02d}:{m:02d}:00' for h in range(h0, h1) for m in (0, 30)]

PLACA_MWP = sum(PR['placa_mwp'].values()) if isinstance(PR['placa_mwp'], dict) else PR['placa_mwp']
def limitado_dia(dia):
    import statistics
    ts = slots(dia); livres = []; hrs = 0; est = 0; lims = []
    for t in ts:
        g, i, l = mw('Complexo', t), I30.get(t), f_(ONS30.get(t, {}).get('lim'))
        if l is not None: hrs += .5; lims.append(l)
        if g is not None and i and l is None and i > 300: livres.append(g / (PLACA_MWP * i / 1000))
    if len(livres) < 3: return dict(h=hrs, est=None, lmin=min(lims) if lims else None, lmax=max(lims) if lims else None)
    prd = statistics.median(livres)
    for t in ts:
        g, i, l = mw('Complexo', t), I30.get(t), f_(ONS30.get(t, {}).get('lim'))
        if l is None or g is None or i is None: continue
        est += max(0, min(PLACA_MWP * i / 1000 * prd, 343.77) - g) * .5
    return dict(h=hrs, est=est, pr=prd, lmin=min(lims) if lims else None, lmax=max(lims) if lims else None)

def curva_dia(dia, W=1000):
    """MW da medição a cada 30 min; colunas lilás = intervalos com limite do ONS; o limite em degrau; a referência do ONS tracejada;
    irradiação no plano logo abaixo, no mesmo eixo de horas (nunca dois eixos)."""
    ts = slots(dia); n = len(ts); H1, H2 = 300, 110; L, R = 46, 12; bw = (W - L - R) / n
    g = [mw('Complexo', t) for t in ts]; on = [ONS30.get(t, {}) for t in ts]
    lim = [f_(o.get('lim')) for o in on]; ref = [f_(o.get('gref')) for o in on]
    top = max([v or 0 for v in g] + [v or 0 for v in lim] + [v or 0 for v in ref] + [50]) * 1.1
    X = lambda i: L + i * bw; Y = lambda v: H1 - 24 - (H1 - 40) * v / top
    s = []
    for v in (0, 100, 200, 300):
        if v < top: s.append(f'<line x1="{L}" x2="{W-R}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{LINHA}"/><text x="{L-6}" y="{Y(v)+4:.1f}" text-anchor="end" class="sv-ax">{v}</text>')
    for i, l in enumerate(lim):
        if l is not None: s.append(f'<rect x="{X(i):.1f}" y="{Y(top/1.1):.1f}" width="{bw:.1f}" height="{Y(0)-Y(top/1.1):.1f}" fill="{mix(CORTE,16)}"/>')
    pts = [(X(i) + bw / 2, Y(v)) for i, v in enumerate(g) if v is not None]
    if pts:
        path = 'M ' + ' L '.join(f'{x:.1f} {y:.1f}' for x, y in pts)
        s.append(f'<path d="{path} L {pts[-1][0]:.1f} {Y(0):.1f} L {pts[0][0]:.1f} {Y(0):.1f} Z" fill="{mix(GER,24)}"/><path d="{path}" stroke="{mix(GER,95)}" stroke-width="2.5" fill="none"/>')
    rp = [(X(i) + bw / 2, Y(v)) for i, v in enumerate(ref) if v]
    if rp: s.append(f'<path d="M {" L ".join(f"{x:.1f} {y:.1f}" for x, y in rp)}" stroke="{T3}" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>')
    for i, l in enumerate(lim):
        if l is not None: s.append(f'<line x1="{X(i):.1f}" x2="{X(i)+bw:.1f}" y1="{Y(l):.1f}" y2="{Y(l):.1f}" stroke="{mix(CORTE,95)}" stroke-width="3"/>')
    ih = [I30.get(t) for t in ts]; itop = max([v or 0 for v in ih] + [100]) * 1.15
    YI = lambda v: H1 + H2 - 22 - (H2 - 30) * v / itop
    ip = [(X(i) + bw / 2, YI(v)) for i, v in enumerate(ih) if v is not None]
    if ip:
        pa = 'M ' + ' L '.join(f'{x:.1f} {y:.1f}' for x, y in ip)
        s.append(f'<path d="{pa} L {ip[-1][0]:.1f} {YI(0):.1f} L {ip[0][0]:.1f} {YI(0):.1f} Z" fill="{mix(IRR,22)}"/><path d="{pa}" stroke="{mix(IRR,80)}" stroke-width="1.8" fill="none"/>')
        k = max(range(len(ih)), key=lambda i: ih[i] or 0)
        s.append(f'<text x="{X(k)+bw/2:.1f}" y="{YI(ih[k])-6:.1f}" text-anchor="middle" class="sv-ax2">{nf(ih[k],0)} W/m²</text>')
    for i, t in enumerate(ts):
        if t[14:16] == '00' and int(t[11:13]) % 2 == 1: s.append(f'<text x="{X(i):.1f}" y="{H1+H2-4}" text-anchor="middle" class="sv-ax">{t[11:16]}</text>')
    s.append(f'<text x="{L}" y="12" class="sv-ax">MW</text>')
    # o resumo da restrição do dia, para o título do painel
    rest = [t for t, l in zip(ts, lim) if l is not None]
    resumo = (f'{len(rest)*0.5:.1f} h com limite do ONS, de {rest[0][11:16]} a {(dt.datetime.fromisoformat(rest[-1]) + dt.timedelta(minutes=30)):%H:%M}; '
              f'limite mínimo {nf(min(l for l in lim if l is not None),1)} MW').replace('.', ',', 1) if rest else 'sem limite do ONS no dia'
    pico = max((v for v in g if v is not None), default=0)
    return f'<svg viewBox="0 0 {W} {H1+H2}" style="width:100%;height:auto;display:block">{"".join(s)}</svg>', resumo, pico

def mini_ufv(u, dia, W=310, H=150):
    ts = slots(dia); n = len(ts); bw = (W - 8) / n
    g = [mw(u, t) for t in ts]; lim = [f_(ONS30.get(t, {}).get('lim')) for t in ts]
    top = max([v or 0 for v in g] + [1]) * 1.15; X = lambda i: 4 + i * bw; Y = lambda v: H - 18 - (H - 26) * v / top
    s = [f'<rect x="{X(i):.1f}" y="4" width="{bw:.1f}" height="{H-22}" fill="{mix(CORTE,14)}"/>' for i, l in enumerate(lim) if l is not None]
    pts = [(X(i) + bw / 2, Y(v)) for i, v in enumerate(g) if v is not None]; c = COR[u]
    if pts:
        p = 'M ' + ' L '.join(f'{x:.1f} {y:.1f}' for x, y in pts)
        s.append(f'<path d="{p} L {pts[-1][0]:.1f} {Y(0):.1f} L {pts[0][0]:.1f} {Y(0):.1f} Z" fill="{mix(c,26)}"/><path d="{p}" stroke="{mix(c,95)}" stroke-width="2" fill="none"/>')
    s.append(f'<line x1="4" x2="{W-4}" y1="{Y(0):.1f}" y2="{Y(0):.1f}" stroke="{BORDA}"/>')
    s.append(f'<text x="4" y="{H-3}" class="sv-ax" style="font-size:10.5px">05h</text><text x="{W-4}" y="{H-3}" text-anchor="end" class="sv-ax" style="font-size:10.5px">19h</text>')
    pico = max((v for v in g if v is not None), default=0); e = LIQ.get((u, dia), (0,))[0]
    return (f'<div class="mu"><div class="mu-t"><b style="color:{rot(c)}">{u}</b><span>{nf(e,2)} MWh · pico {nf(pico,1)} MW</span></div>'
            f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block">{"".join(s)}</svg></div>')

def mes_ufv(u, dias, W=310, H=150):
    n = len(dias); bw = (W - 8) / n
    v = [(LIQ.get((u, d), (0,))[0], (CDU.get((d, u)) or {}).get('cortado_mwh') or 0, LIQ.get((u, d), (0, 0))[1]) for d in dias]
    top = max([a + b for a, b, _ in v] + [1]) * 1.12; Y = lambda x: H - 18 - (H - 26) * x / top; c = COR[u]
    s = []
    for i, (a, b, m) in enumerate(v):
        x = 4 + i * bw + bw * .12; w = bw * .76
        s.append(f'<rect x="{x:.1f}" y="{Y(a):.1f}" width="{w:.1f}" height="{Y(0)-Y(a):.1f}" rx="2" fill="{mix(c,30)}" stroke="{mix(c,60)}" stroke-width=".8"/>')
        if b > 0: s.append(f'<rect x="{x:.1f}" y="{Y(a+b):.1f}" width="{w:.1f}" height="{max(Y(a)-Y(a+b)-1,.8):.1f}" rx="2" fill="{mix(CORTE,30)}" stroke="{mix(CORTE,60)}" stroke-width=".8"/>')
    s.append(f'<line x1="4" x2="{W-4}" y1="{Y(0):.1f}" y2="{Y(0):.1f}" stroke="{BORDA}"/>')
    s.append(f'<text x="4" y="{H-3}" class="sv-ax" style="font-size:10.5px">{int(dias[0][8:])}</text><text x="{W-4}" y="{H-3}" text-anchor="end" class="sv-ax" style="font-size:10.5px">{int(dias[-1][8:])}</text>')
    tg = sum(a for a, _, _ in v); tc = sum(b for _, b, _ in v)
    return (f'<div class="mu"><div class="mu-t"><b style="color:{rot(c)}">{u}</b><span>{nf(tg,2)} MWh · impedido {nf(tc,2)}</span></div>'
            f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block">{"".join(s)}</svg></div>')

CSS += f""".grade{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 18px}} .mu-t{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:2px}}
.mu-t b{{font-size:16px}} .mu-t span{{font-size:12px;color:{T3}}}"""

def painel_curva_dia(dia):
    svg, resumo, pico = curva_dia(dia)
    leg = (f'<small><span style="color:{rot(GER)}">■</span> geração MW · <span style="color:{rot(CORTE)}">━</span> limite do ONS · '
           f'<span style="color:{rot(CORTE)}">▮</span> intervalo limitado · ┅ referência do ONS · <span style="color:{rot(IRR)}">■</span> irradiação</small>')
    return (f'<div class="pn"><div class="pt"><h2>Curva do dia {ddmm(dia)} · Complexo</h2>{leg}</div>{svg}'
            f'<div class="leg" style="justify-content:flex-start">{resumo} · pico de {nf(pico,1)} MW · medição de 30 min</div></div>'
            f'<div class="pn"><div class="pt"><h2>Curva do dia por usina</h2><small>MW a cada 30 min · faixa lilás = limite do ONS no conjunto</small></div>'
            f'<div class="grade">{"".join(mini_ufv(u, dia) for u in US)}</div></div>')

def painel_mes_ufv(dias, titulo):
    return (f'<div class="pn"><div class="pt"><h2>{titulo}</h2><small><span style="color:{rot(T3)}">■</span> geração por dia (cor da usina) · '
            f'<span style="color:{rot(CORTE)}">■</span> impedido pelo ONS, rateio por usina</small></div><div class="grade">{"".join(mes_ufv(u, dias) for u in US)}</div></div>')

def card_limitado(dia, o):
    """o valor do ONS quando ele apurou energia; senão, a estimativa do SIGO, dita como estimativa"""
    ld = limitado_dia(dia); ons = o.get('cortado_mwh')
    if ons and ons > 0:
        return kpi(CORTE, 'Impedido pelo ONS no dia', nf(ons, 2), 'MWh', f'{nf(ld["h"],1)} h de limitação' + (f' · estimativa SIGO {nf(ld["est"],2)}' if ld['est'] else ''))
    if ld['h'] > 0 and ld['est'] is not None:
        sub = f'{nf(ld["h"],1)} h de limitação · limite {nf(ld["lmin"],0)}–{nf(ld["lmax"],0)} MW'
        return kpi(CORTE, 'Limitado pelo ONS no dia', '≈ ' + nf(ld['est'], 2), 'MWh estimados', sub)
    return kpi(CORTE, 'Limitação do ONS no dia', '0,0', 'h', 'sem limite do ONS no dia')

dias_mes = [f'{MES}-{i:02d}' for i in range(1, D + 1)]
cx, pp = meta_mes('Complexo'), meta_mes('PPA')
imp_mes = sum(SD.get(d, {}).get('cortado_mwh', 0) or 0 for d in dias_mes)
hr_mes = sum(SD.get(d, {}).get('horas_restricao', 0) or 0 for d in dias_mes)
b_m = corte_bench(dias_mes); pm, pcm = pr_dias(US, dias_mes); dsm = disp_dias(US, dias_mes)
irm = [IRD[d]['gti'] for d in dias_mes if d in IRD]
LEG = f'<small><span style="color:{rot(GER)}">■</span> geração MWh · <span style="color:{rot(CORTE)}">■</span> impedido pelo ONS · ━ meta do dia · <span style="color:{rot(IRR)}">■</span> irradiação kWh/m²</small>'
MES_NOME = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'][d0.month - 1]

if MODO == 'diario':
    liq, meta_d, _ = LIQ[('Complexo', DIA)]
    o = SD.get(DIA, {}); LD = limitado_dia(DIA); b_d = corte_bench([DIA]); p, pc = pr_dias(US, [DIA]); dsp = disp_dias(US, [DIA]); ir = IRD.get(DIA, {})
    f = []
    dif = (liq / meta_d - 1) * 100
    f.append(('▲' if dif >= 0 else '▼', OK if dif >= 0 else ATN, f'Geração de <b>{nf(liq,2)} MWh</b>, {nf(abs(dif),0)}% {"acima" if dif>=0 else "abaixo"} da meta do dia.'))
    if liq >= max(cx['s']) and D > 1: f.append(('★', GER, '<b>Melhor dia do mês</b> até agora.'))
    if (o.get('cortado_mwh') or 0) > 0:
        f.append(('◆', CORTE, f'ONS impediu <b>{nf(o["cortado_mwh"],2)} MWh</b> ({nf(b_d["nosso"],1)}%); Abaiara {nf(b_d["abaiara"],1)}% e Nordeste {nf(b_d["ne"],1)}%.'))
    elif LD['h'] > 0 and LD['est']:
        f.append(('◆', CORTE, f'ONS limitou a usina por <b>{nf(LD["h"],1)} h</b> (limite entre {nf(LD["lmin"],1)} e {nf(LD["lmax"],1)} MW); estimativa de <b>{nf(LD["est"],2)} MWh</b> não gerados.'))
    else:
        f.append(('◆', CORTE, f'<b>Sem limitação</b> do ONS no dia; no Nordeste o corte solar foi de {nf(b_d["ne"],1)}%.'))
    for u, r in (('Complexo', cx), ('PPA', pp)):
        t, c = chip_meta(r); f.append(('●', COR[u], f'{u}: <b>{t}</b> (projeção de {nf(r["proj_pct"],0)}% da meta).'))
    corpo = f"""
<div class="pn"><div class="pt"><h2>Meta do mês · realizado e projeção</h2><small>energia líquida · Valor Garantido {MES_NOME}/{MES[:4]}</small></div>
 <div class="duas"><div class="col">{anel('Complexo', cx)}{curva('Complexo', cx)}</div><div class="col">{anel('PPA', pp)}{curva('PPA', pp)}</div></div>
 <div class="leg"><span>━ marca de 100%</span><span>···· projeção do mês</span><span>▬ faixa de acerto histórica ±{nf(erro,1)} pp</span><span>anéis de 0 a 150%</span></div></div>
<div class="kp">
 {kpi(GER,'Geração do dia',nf(liq,2),'MWh',f'meta {nf(meta_d,2)} MWh')}
 {kpi(IRR,'Irradiação do dia',nf(ir.get('gti'),2),'kWh/m²',f'no mês {nf(sum(irm),2)} kWh/m²')}
 {kpi(COR['Complexo'],'PR do dia',nf(p,1),'%',f'no mês {nf(pm,1)}% · sem o corte {nf(pcm,1)}%')}
 {kpi(OK,'Disponibilidade do dia',nf(dsp,2),'%',f'no mês {nf(dsm,2)}%')}
 {card_limitado(DIA, o)}
 {kpi(CORTE,'Impedido no mês',nf(imp_mes,2),'MWh',f'{nf(hr_mes,1)} h de restrição')}
 {kpi(COR['Complexo'],'Acumulado do mês',nf(cx['tot'],2),'MWh',f'PPA {nf(pp["tot"],2)} MWh')}
 {card_p50(dias_mes, cx['tot'], imp_mes)}
</div>
{painel_curva_dia(DIA)}
<div class="pn"><div class="pt"><h2>Dia a dia de {MES_NOME} · Complexo</h2>{LEG}</div>{barras_ger_irr(dias_mes)}</div>
{painel_mes_ufv(dias_mes, f'Dia a dia de {MES_NOME} por usina')}
<div class="pn"><div class="pt"><h2>Corte do ONS · comparação regional</h2><small>energia impedida ÷ (gerada + impedida)</small></div>{bench([(f'Dia {ddmm(DIA)}', b_d), (f'Mês até {ddmm(DIA)}', b_m)])}</div>
{painel_motivo([(f'Dia {ddmm(DIA)}', [DIA]), (f'Mês até {ddmm(DIA)}', dias_mes)])}
<div class="pn"><div class="pt"><h2>Usinas · dia e mês</h2><small>geração do dia e do mês · PR do mês sem o corte · disponibilidade do mês</small></div>
 <div class="ush2"><div></div><div>dia</div><div>mês</div><div>PR mês</div><div>disp. mês</div></div>{usinas2(DIA, dias_mes)}</div>
{fatos_html(f, ddmm(DIA))}"""
    semana = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'][d0.weekday()]
    CAB = ('Relatório diário de desempenho', f'{semana}, {ddmm(DIA)}/{DIA[:4]}', f'dia fechado · evolução de {MES_NOME}, {D} de {NT} dias')
    saida = 'diario'
    marcas = ['<div class="pn"><div class="pt"><h2>Curva do dia ' + ddmm(DIA), f'<div class="pn"><div class="pt"><h2>Dia a dia de {MES_NOME} · Complexo', '<div class="pn"><div class="pt"><h2>Corte do ONS · comparação']
else:
    # mês fechado
    import calendar as _c
    mant = (d0.replace(day=1) - dt.timedelta(days=1)); dias_ant = [f'{mant:%Y-%m}-{i:02d}' for i in range(1, mant.day + 1)]
    g_ant = sum(LIQ.get(('Complexo', d), (0,))[0] for d in dias_ant)
    melhor = max(dias_mes, key=lambda d: LIQ.get(('Complexo', d), (0,))[0]); pior = min(dias_mes, key=lambda d: LIQ.get(('Complexo', d), (0,))[0])
    acima = sum(1 for d in dias_mes if LIQ.get(('Complexo', d), (0, 1e9))[0] >= LIQ.get(('Complexo', d), (0, 1e9))[1])
    maior_c = max(dias_mes, key=lambda d: SD.get(d, {}).get('cortado_mwh', 0) or 0)
    hist = sorted([(r['liq_mwh'], r['dia']) for r in EX['serie_dia_ufv'] if r['ufv'] == 'Complexo' and r['liq_mwh'] and not r['parcial'] and r['dia'] <= DIA], reverse=True)
    rank = next(i for i, (_, d) in enumerate(hist) if d == melhor) + 1
    f = [('▲' if cx['tot'] >= cx['meta'] else '▼', OK if cx['tot'] >= cx['meta'] else RUIM,
          f'Complexo fechou com <b>{nf(cx["tot"],2)} MWh</b>, {nf(cx["pct"],1)}% da meta; {nf(abs(cx["tot"]/g_ant*100-100),1)}% {"acima" if cx["tot"]>=g_ant else "abaixo"} de {mant:%m/%Y}.'),
         ('●', COR['PPA'], f'PPA fechou com <b>{nf(pp["pct"],1)}%</b> da meta ({nf(pp["tot"],2)} de {nf(pp["meta"],2)} MWh)' + (f', meta batida em {ddmm(pp["bateu"])}.' if pp['bateu'] else '.')),
         ('★', GER, f'Melhor dia: <b>{ddmm(melhor)}</b> com {nf(LIQ[("Complexo",melhor)][0],2)} MWh' + (', <b>recorde histórico</b>' if rank == 1 else f', {rank}º maior desde set/2025') + f'. {acima} de {NT} dias acima da meta diária.'),
         ('◆', CORTE, f'ONS impediu <b>{nf(imp_mes,2)} MWh</b> em {nf(hr_mes,1)} h ({nf(b_m["nosso"],1)}%); maior corte em {ddmm(maior_c)} ({nf(SD[maior_c]["cortado_mwh"],2)} MWh). Abaiara {nf(b_m["abaiara"],1)}%, Nordeste {nf(b_m["ne"],1)}%.'),
         ('◐', OK, f'PR do mês {nf(pm,1)}% ({nf(pcm,1)}% sem o corte) e disponibilidade de {nf(dsm,2)}%.')]
    corpo = f"""
<div class="pn"><div class="pt"><h2>Meta de {MES_NOME} · resultado</h2><small>energia líquida · Valor Garantido {MES_NOME}/{MES[:4]}</small></div>
 <div class="duas"><div class="col">{gauge_mes('Complexo', cx)}{curva('Complexo', cx)}</div><div class="col">{gauge_mes('PPA', pp)}{curva('PPA', pp)}</div></div>
 <div class="leg"><span>marca na borda = meta (100%)</span><span>tracejado = meta linear do mês</span></div></div>
<div class="kp">
 {kpi(GER,'Geração do mês',nf(cx['tot'],2),'MWh',f'{mant:%m/%Y}: {nf(g_ant,2)} MWh')}
 {kpi(IRR,'Irradiação do mês',nf(sum(irm),2),'kWh/m²',f'média {nf(sum(irm)/len(irm),2)} por dia')}
 {kpi(COR['Complexo'],'PR do mês',nf(pm,1),'%',f'sem o corte {nf(pcm,1)}%')}
 {kpi(OK,'Disponibilidade',nf(dsm,2),'%','inversores nas horas de sol')}
 {kpi(CORTE,'Impedido pelo ONS',nf(imp_mes,2),'MWh',f'{nf(hr_mes,1)} h de restrição')}
 {kpi(CORTE,'Corte do mês',nf(b_m['nosso'],1),'%',f'Abaiara {nf(b_m["abaiara"],1)}% · Nordeste {nf(b_m["ne"],1)}%')}
 {kpi(COR['PPA'],'PPA no mês',nf(pp['tot'],2),'MWh',f'{nf(pp["pct"],1)}% da meta')}
 {card_p50(dias_mes, cx['tot'], imp_mes)}
</div>
<div class="pn"><div class="pt"><h2>Dia a dia de {MES_NOME} · Complexo</h2>{LEG}</div>{barras_ger_irr(dias_mes)}</div>
{painel_mes_ufv(dias_mes, f'Dia a dia de {MES_NOME} por usina')}
<div class="pn"><div class="pt"><h2>Corte do ONS · comparação regional</h2><small>energia impedida ÷ (gerada + impedida)</small></div>{bench([(f'{MES_NOME.capitalize()}', b_m), (f'Mês anterior ({mant:%m/%Y})', corte_bench(dias_ant))])}</div>
{painel_motivo([(MES_NOME.capitalize(), dias_mes), (f'Mês anterior ({mant:%m/%Y})', dias_ant)])}
<div class="pn"><div class="pt"><h2>Usinas no mês</h2><small>geração · PR sem o corte · disponibilidade</small></div>
 <div class="ush"><div></div><div style="text-align:right">geração</div><div>PR</div><div>disp.</div></div>{usinas(dias_mes)}</div>
{fatos_html(f, f'{MES_NOME}/{MES[:4]}')}"""
    CAB = ('Relatório mensal de desempenho', f'{MES_NOME} de {MES[:4]}', f'mês fechado · {NT} dias')
    saida = f'mensal_{MES}'
    marcas = [f'<div class="pn"><div class="pt"><h2>Dia a dia de {MES_NOME} · Complexo', '<div class="pn"><div class="pt"><h2>Corte do ONS · comparação', '<div class="pn"><div class="pt"><h2>Usinas']

suf = '' if TEMA == 'escuro' else '_claro'
open(os.path.join(AQUI, f'{saida}{suf}.html'), 'w', encoding='utf-8').write(pagina(*CAB, corpo, ROD))
for m in marcas:
    assert corpo.count(m) == 1, m; corpo = corpo.replace(m, '<!--CORTE-->' + m)
partes = corpo.split('<!--CORTE-->')
for i, c in enumerate(partes):
    open(os.path.join(AQUI, f'{saida}{suf}_p{i+1}.html'), 'w', encoding='utf-8').write(pagina(*CAB, c, ROD if i == len(partes) - 1 else '', i, len(partes)))
print('ok', saida + suf, len(partes), 'partes', {u: (round(r['pct'], 2), r.get('bateu'), r.get('prev'), r.get('prev_lo')) for u, r in (('Complexo', cx), ('PPA', pp))})
