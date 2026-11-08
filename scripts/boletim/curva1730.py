# -*- coding: utf-8 -*-
"""Boletim de Desempenho · envio das 17:30 "Geração × limite do dia" (lote boletim-1730, 08/11/2026; conteúdo aprovado pelo humano em
08/11: "ok no boletim do dia 17H30"). O desenho é o do protótipo curva_1730.py da Investigações (Boletim_Desempenho/prototipo_07nov/1730),
com o limite das ORDENS DA IQONY registradas no Gestão (decisão do humano de 07/11 ~20h: `indicadores/restricao_iqony.json`, a fonte do
degrau do RDO), não da planilha da mesa. O ONS consolidado não serve às 17:30 (publica D-1).
Entradas (BOLETIM_DIR): way2_recent.json (medição de faturamento de 5 min, ontem e hoje) e gestao__restricao_iqony.json.
Saída: curva_{claro,escuro}{,_en}.html, curva_claro{,_en}_p1.html (a parte do WeCom) e o resumo (os números do texto).
Regras: dado que falta não se inventa (dia sem ordem diz isso; ponto de medição sem leitura deixa o instante vazio, nunca zero); energia em
MWh com 2 casas; nenhum limiar de cor (a cor é da grandeza: geração, limite).
    python curva1730.py <pasta> <AAAA-MM-DD> [HH:MM]     gera as folhas na pasta (sem Chrome)"""
import base64
import datetime as dt
import json
import os
import re

COMPLEXO = [6196, 6197]   # os dois trafos da SE: a geração líquida do conjunto
CIRC = {'M1': [6198, 6199, 6200], 'M2': [6201, 6202], 'M3': [6203, 6204, 6205], 'M4': [6206, 6207, 6208], 'M5': [6209, 6210, 6211],
        'M6': [6212, 6213, 6214], 'M7': [6215], 'M8': [6216, 6217, 6218], 'M9': [6219]}
H0, H1 = 5, 19   # o eixo do dia: 05:00 a 19:00, em passos de 5 min
SLOTS = [f'{m // 60:02d}:{m % 60:02d}' for m in range(H0 * 60, H1 * 60, 5)]
PLENA = 343.77

# a paleta do boletim (boletim_aprovado.py): claro vivo, escuro profundo. O ensaio confere que estes valores são os do aprovado.
PALETA = {
    'escuro': dict(GER='#F5A623', CORTE='#A79BE8', FUNDO='#0A0B0D', PAINEL='#111317', BORDA='#25272C', T1='#FAFBFC', T2='#DCE1E8', T3='#A3ABB8',
                   LINHA='#1A1C21', RODA='#6B7280', BASE_ROT='#F2F4F7',
                   COR={'M1': '#F0509C', 'M2': '#F3D020', 'M3': '#01816E', 'M4': '#DBE3BF', 'M5': '#AB43D0', 'M6': '#C79889', 'M7': '#DABFE3',
                        'M8': '#7453FE', 'M9': '#2CDBE8'}),
    'claro': dict(GER='#BF7E04', CORTE='#A79BE8', FUNDO='#F3F4F6', PAINEL='#FFFFFF', BORDA='#E1E4E9', T1='#05070A', T2='#232A33', T3='#434B57',
                  LINHA='#EEF0F3', RODA='#5C6370', BASE_ROT='#05070A',
                  COR={'M1': '#B6056C', 'M2': '#A58C03', 'M3': '#22907C', 'M4': '#4E5435', 'M5': '#AB43D0', 'M6': '#B08374', 'M7': '#9E84A6',
                       'M8': '#7453FE', 'M9': '#049AA4'}),
}
# os motivos que o Gestão grava (coleta_parser.js e a lista fechada do RDO, rdo.js MOTIVOS); código desconhecido sai neutro, nunca cru. Da
# razão, a folha mostra só o código (ENE, CNF, REL)
MOTIVO = {'ENE_FREQ': ('Energia (controle de frequência)', 'Energy (frequency control)'), 'FLUXO': ('Fluxo ou intercâmbio', 'Flow or interchange'),
          'ELE_SGI': ('Contingência, SGI ou indisponibilidade', 'Contingency, SGI or unavailability'),
          'REATIVO': ('Controle de reativo', 'Reactive power control'), 'PATAMAR': ('Patamar de carga', 'Load level'),
          'OUTRO': ('Outro motivo', 'Other reason')}
SEMANA = (['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'], ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'])
MES_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def minuto(h):
    return int(h[:2]) * 60 + int(h[3:5])


def nf(v, c=2, idi='pt'):
    if v is None:
        return '—'
    s = f'{v:,.{c}f}'
    return s if idi == 'en' else s.replace(',', 'X').replace('.', ',').replace('X', '.')


# ───────────────────────── os dados ─────────────────────────
def ordens(iq, dia):
    """As ordens do dia em degrau, da mais antiga à mais nova: [{'min', 'pot' (None = liberado), 'raz', 'mot', 'h'}].
    Vale a correção da mesa (`corr`) quando a ordem foi conferida e mudada; o evento em conflito (destino != 'rdo') fica de fora; a ordem
    que vinha do dia anterior sem fim entra às 00:00 (`herdada`)."""
    campos = iq.get('campos') or []
    if campos[:8] != ['dia', 'h', 'tipo', 'mw', 'raz', 'mot', 'origem_ons', 'destino']:
        raise SystemExit('RECUSADO: restricao_iqony.json com campos fora da forma: %s' % campos)
    evs = []
    for e in iq.get('eventos') or []:
        d = dict(zip(campos, e))
        if d['destino'] != 'rdo' or d['dia'] > dia:
            continue
        c = d.get('corr') if d.get('conf') == 1 else None
        if c:
            d = dict(d, h=c.get('h') or d['h'], mw=c.get('mw', d['mw']), raz=c.get('raz', d['raz']), mot=c.get('mot', d['mot']),
                     tipo='fim' if c.get('tipo') == 'lib' else 'limite')
        evs.append(d)
    evs.sort(key=lambda d: (d['dia'], d['h']))
    antes = [d for d in evs if d['dia'] < dia]
    out = []
    if antes and antes[-1]['tipo'] == 'limite':
        a = antes[-1]
        out.append({'min': 0, 'h': '00:00', 'pot': float(a['mw']), 'raz': a['raz'], 'mot': a['mot'], 'herdada': True})
    for d in evs:
        if d['dia'] == dia:
            lim = d['tipo'] == 'limite'
            out.append({'min': minuto(d['h']), 'h': d['h'][:5], 'pot': float(d['mw']) if lim else None, 'raz': d['raz'] if lim else None,
                        'mot': d['mot'] if lim else None, 'herdada': False})
    return out


def limite_em(ords, m):
    v = None
    for o in ords:
        if o['min'] <= m:
            v = o['pot']
    return v


def demanda(w2, dia):
    """{(ponto, 'HH:MM'): MW} do dia, só os instantes COM leitura (sem `valor` = sem leitura, nunca zero)"""
    out = {}
    for p in w2.get('dados') or []:
        if p.get('nomeGrandeza') != 'Demat':
            continue
        for x in p.get('valores') or []:
            if x.get('data', '').startswith(dia) and 'valor' in x and x['valor'] is not None:
                out[(p['pontoId'], x['data'][11:16])] = x['valor'] / 1000
    return out


def soma(dem, pontos, h):
    v = [dem.get((p, h)) for p in pontos]
    return None if any(x is None for x in v) else sum(v)


def calcula(w2, iq, dia, ate):
    """os números da folha e do texto, uma conta só"""
    dem = demanda(w2, dia)
    lim_ate = minuto(ate)
    g = [soma(dem, COMPLEXO, h) if minuto(h) <= lim_ate else None for h in SLOTS]
    com = [i for i, v in enumerate(g) if v is not None]
    if not com:
        raise SystemExit('RECUSADO: sem medição do conjunto em %s até %s (a folha não sai sem a geração)' % (dia, ate))
    ords = ordens(iq, dia)
    ate_med = SLOTS[com[-1]]
    L = [limite_em(ords, minuto(h)) if minuto(h) <= minuto(ate_med) else None for h in SLOTS]
    restr = [o for o in ords if o['pot'] is not None and o['min'] <= minuto(ate_med)]
    novas = [o for o in restr if not o['herdada']]
    us = {}
    for u, pts in CIRC.items():
        gu = [soma(dem, pts, h) if minuto(h) <= minuto(ate_med) else None for h in SLOTS]
        val = [v for v in gu if v is not None]
        us[u] = {'serie': gu, 'mwh': round(sum(val) * 5 / 60, 2) if val else None, 'pico': round(max(val), 1) if val else None}
    co = iq.get('coletor') or {}
    return {'dia': dia, 'ate': ate, 'medicao_ate': ate_med, 'serie': g, 'limite': L, 'ordens': ords,
            'energia_mwh': round(sum(g[i] for i in com) * 5 / 60, 2), 'pico_mw': round(max(g[i] for i in com), 1),
            'n_ordens': len(novas), 'herdada': any(o['herdada'] for o in restr),
            'primeira': novas[0]['h'] if novas else None,
            'ultima': [o for o in ords if o['min'] <= minuto(ate_med)][-1]['h'] if novas else None,
            'horas_sob_limite': round(sum(1 for v in L if v is not None) * 5 / 60, 1),
            'limite_min_mw': min((o['pot'] for o in restr), default=None),
            'razoes': sorted({o['raz'] for o in restr if o['raz']}), 'motivos': sorted({o['mot'] for o in restr if o['mot']}),
            'coletor': co.get('estado'), 'coletor_ultimo': co.get('ultimo_pulso'), 'usinas': us}


# ───────────────────────── a folha ─────────────────────────
TXT = {
    'pt': dict(titulo='Geração × limite do dia', ate='medição até {a} · dia em andamento', gerado='gerado no SIGO em {g}',
               k_ger='Geração até {a}', pico='pico de {p} MW', k_ord='Ordens do ONS', entre='entre {a} e {b}', nenhuma='nenhuma até {a}',
               k_tempo='Tempo sob limite', lmin='limite mínimo {v} MW', sem_lim='sem limite no dia', k_mot='Motivo', h_graf='Geração × limite · Complexo · MW',
               leg='<span style="color:{g}">■</span> geração (medição de 5 min) · <span style="color:{c}">━</span> limite das ordens do ONS · <span style="color:{r}">▮</span> período sob ordem',
               nota='o número sobre o degrau é a potência pedida em cada ordem (MW) · ordens do ONS recebidas pela Iqony e registradas no SIGO',
               sem_ordem='Sem ordem de limitação do ONS registrada no dia até {a}.',
               herdada='O dia começou sob a ordem de {v} MW da véspera.',
               coletor='Atenção: o coletor das ordens está parado (último sinal {u}); o limite pode estar incompleto.',
               h_us='Geração por usina · MW', us_sub='medição de 5 min dos circuitos de cada usina', us_val='{e} MWh · pico {p} MW',
               fonte='Fonte: geração pela medição de faturamento (5 min); limite pelas ordens do ONS recebidas pela Iqony e registradas no SIGO. '
                     'A apuração oficial da energia impedida pelo ONS chega no dia seguinte e entra no boletim diário.',
               emp='Intrepid Participações S.A.', cj='Conjunto Fotovoltaico Mauriti', sigo='Conjunto Fotovoltaico Mauriti · SIGO'),
    'en': dict(titulo='Generation × limit of the day', ate='metering to {a} · day in progress', gerado='generated in SIGO on {g}',
               k_ger='Generation to {a}', pico='peak of {p} MW', k_ord='ONS orders', entre='between {a} and {b}', nenhuma='none to {a}',
               k_tempo='Time under limit', lmin='minimum limit {v} MW', sem_lim='no limit in the day', k_mot='Reason', h_graf='Generation × limit · Complex · MW',
               leg='<span style="color:{g}">■</span> generation (5-min metering) · <span style="color:{c}">━</span> ONS order limit · <span style="color:{r}">▮</span> period under order',
               nota='the number on each step is the power requested in each order (MW) · ONS orders received by Iqony and recorded in SIGO',
               sem_ordem='No ONS curtailment order recorded in the day to {a}.',
               herdada='The day started under the {v} MW order of the previous day.',
               coletor='Warning: the order collector is stopped (last signal {u}); the limit may be incomplete.',
               h_us='Generation by plant · MW', us_sub='5-min metering of each plant feeder', us_val='{e} MWh · peak {p} MW',
               fonte='Source: generation from billing metering (5 min); limit from the ONS orders received by Iqony and recorded in SIGO. '
                     'The official ONS assessment of curtailed energy arrives the next day and goes into the daily bulletin.',
               emp='Intrepid Participações S.A.', cj='Mauriti Photovoltaic Complex', sigo='Mauriti Photovoltaic Complex · SIGO'),
}


def data_txt(dia, idi):
    d = dt.date.fromisoformat(dia)
    if idi == 'en':
        return f'{SEMANA[1][d.weekday()]}, {d.day} {MES_EN[d.month - 1]} {d.year}'
    return f'{SEMANA[0][d.weekday()]}, {dia[8:]}/{dia[5:7]}/{dia[:4]}'


def motivo_txt(r, idi):
    i = 1 if idi == 'en' else 0
    if not r['motivos']:
        return '—', '—'
    limpo = lambda c: re.sub(r'[^A-Z0-9_]', '', str(c or '').upper())
    outro = lambda m: ('outro motivo', 'other reason')[i] + (' (%s)' % limpo(m) if limpo(m) and idi != 'en' else '')
    nome = ' · '.join(MOTIVO[m][i] if m in MOTIVO else outro(m) for m in r['motivos'])
    return ' · '.join(limpo(x) for x in r['razoes'] if limpo(x)) or '—', nome


def grafico(P, r, W=1000, H=400):
    n, g, L = len(SLOTS), r['serie'], r['limite']
    X = lambda i: 46 + (W - 58) * i / (n - 1)
    top = max([v or 0 for v in g] + [v or 0 for v in L] + [10]) * 1.15
    Y = lambda v: H - 30 - (H - 46) * v / top
    mix = lambda c, p: f'color-mix(in srgb, {c} {p}%, transparent)'
    rot = lambda c: f'color-mix(in srgb, {c} 55%, {P["BASE_ROT"]})'
    s = []
    for v in (100, 200, 300):
        if v < top:
            s.append(f'<line x1="46" x2="{W-12}" y1="{Y(v):.1f}" y2="{Y(v):.1f}" stroke="{P["LINHA"]}"/><text x="40" y="{Y(v)+4:.1f}" text-anchor="end" class="sv-ax">{v}</text>')
    i = 0
    while i < n:   # a faixa do período sob ordem
        if L[i] is not None:
            j = i
            while j + 1 < n and L[j + 1] is not None:
                j += 1
            s.append(f'<rect x="{X(i):.1f}" y="10" width="{max(X(j)-X(i), 1):.1f}" height="{H-40}" fill="{mix(P["CORTE"], 10)}"/>')
            i = j + 1
        else:
            i += 1
    pts = [(X(i), Y(v)) for i, v in enumerate(g) if v is not None]
    # a curva só liga instantes vizinhos com leitura: o buraco da medição fica vazio
    seg, ant = [], None
    for i, v in enumerate(g):
        if v is None:
            ant = None
            continue
        seg.append(f'{"M" if ant is None else "L"} {X(i):.1f} {Y(v):.1f}')
        ant = i
    if pts:
        s.append(f'<path d="M {pts[0][0]:.1f} {Y(0):.1f} ' + ' '.join('L %.1f %.1f' % p for p in pts) + f' L {pts[-1][0]:.1f} {Y(0):.1f} Z" fill="{mix(P["GER"], 30)}"/>')
        s.append(f'<path d="{" ".join(seg)}" stroke="{P["GER"]}" stroke-width="2.4" fill="none"/>')
    seg, ult = [], None   # o degrau do limite
    for i, v in enumerate(L):
        if v is not None:
            seg.append(f'{"M" if ult is None else "L"} {X(i):.1f} {Y(v):.1f}')
            if ult is not None and v != ult:
                seg[-1] = f'L {X(i):.1f} {Y(ult):.1f} L {X(i):.1f} {Y(v):.1f}'
        if v is None and ult is not None:
            s.append(f'<path d="{" ".join(seg)}" stroke="{P["CORTE"]}" stroke-width="2.4" fill="none"/>')
            seg = []
        ult = v
    if seg:
        s.append(f'<path d="{" ".join(seg)}" stroke="{P["CORTE"]}" stroke-width="2.4" fill="none"/>')
    ultimo_x, alto = -99, True
    for o in r['ordens']:   # o valor de cada ordem, alternando acima e abaixo
        if o['pot'] is None or o['herdada']:
            continue
        m5 = int(round(o['min'] / 5) * 5)
        h = f'{m5 // 60:02d}:{m5 % 60:02d}'
        if h not in SLOTS or minuto(h) > minuto(r['medicao_ate']):
            continue
        x = X(SLOTS.index(h))
        if x - ultimo_x < 16:
            continue
        y = Y(o['pot']) + (-10 if alto else 22)
        alto, ultimo_x = not alto, x
        s.append(f'<text x="{x+3:.1f}" y="{y:.1f}" class="sv-val" style="font-size:12.5px;fill:{rot(P["CORTE"])}">{o["pot"]:.0f}</text>')
    k = max((i for i, v in enumerate(g) if v is not None), default=None)
    if k is not None:
        s.append(f'<circle cx="{X(k):.1f}" cy="{Y(g[k]):.1f}" r="4.5" fill="{P["GER"]}"/>')
    for hh in range(H0, H1, 2):
        s.append(f'<text x="{X(SLOTS.index(f"{hh:02d}:00")):.1f}" y="{H-8}" text-anchor="middle" class="sv-ax">{hh:02d}:00</text>')
    return f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block">{"".join(s)}</svg>'


def mini(P, serie, cor, W=320, H=130):
    n = len(SLOTS)
    X = lambda i: 4 + (W - 8) * i / (n - 1)
    top = max([v or 0 for v in serie] + [1]) * 1.1
    Y = lambda v: H - 6 - (H - 12) * max(v, 0) / top
    pts = [(X(i), Y(v)) for i, v in enumerate(serie) if v is not None]
    if not pts:
        return f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block"></svg>'
    p = 'M ' + ' L '.join('%.1f %.1f' % q for q in pts)
    return (f'<svg viewBox="0 0 {W} {H}" style="width:100%;height:auto;display:block"><line x1="4" x2="{W-4}" y1="{Y(0):.1f}" y2="{Y(0):.1f}" stroke="{P["BORDA"]}"/>'
            f'<path d="{p} L {pts[-1][0]:.1f} {Y(0):.1f} L {pts[0][0]:.1f} {Y(0):.1f} Z" fill="color-mix(in srgb, {cor} 28%, transparent)"/>'
            f'<path d="{p}" stroke="{cor}" stroke-width="1.6" fill="none"/></svg>')


def css(P):
    rot = lambda c: f'color-mix(in srgb, {c} 55%, {P["BASE_ROT"]})'
    return (f"*{{box-sizing:border-box;margin:0;padding:0}} body{{background:{P['FUNDO']};color:{P['T2']};font-family:Inter,'Segoe UI',sans-serif;width:1080px;padding:36px 40px 30px}}"
            f".k{{font:600 12px 'JetBrains Mono',monospace;letter-spacing:.13em;color:{P['T3']};text-transform:uppercase}}"
            f".pn{{background:{P['PAINEL']};border:1px solid {P['BORDA']};border-radius:16px;padding:20px 22px;margin-top:16px}}"
            f".pt{{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px;gap:16px}} .pt h2{{font-size:19px;color:{P['T1']};font-weight:700;white-space:nowrap}} .pt small{{color:{P['T3']};font-size:12.5px;text-align:right}}"
            f".sv-ax{{font:500 12px Inter;fill:{P['T3']}}} .sv-val{{font:700 14px Inter;fill:{P['T1']}}}"
            f".leg{{display:flex;gap:18px;color:{P['T3']};font-size:12px;margin-top:12px;flex-wrap:wrap}}"
            f".kp{{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px}}"
            f".kc{{background:{P['PAINEL']};border:1px solid {P['BORDA']};border-left:4px solid var(--c);border-radius:12px;padding:13px 15px 13px 16px}}"
            f".kc .k{{font-size:10.5px}} .kc b{{display:block;font-size:27px;color:{P['T1']};font-weight:800;margin-top:6px;letter-spacing:-.02em}} .kc b small{{font-size:13px;color:{P['T3']};font-weight:500}} .kc p{{font-size:12px;color:{P['T3']};margin-top:2px}}"
            f".av{{margin-top:12px;padding:10px 14px;border-radius:10px;border:1px solid {P['BORDA']};font-size:14px;color:{P['T2']}}}"
            f".grade{{display:grid;grid-template-columns:repeat(3,1fr);gap:14px 18px}} .mu-t{{display:flex;justify-content:space-between;align-items:baseline}} .mu-t b{{font-size:16px}} .mu-t span{{font-size:12px;color:{P['T3']}}}"
            f".rodape{{margin-top:16px;color:{P['RODA']};font-size:11.5px;line-height:1.5}} @page{{margin:0}} html{{-webkit-print-color-adjust:exact;print-color-adjust:exact}}"
            f".cab{{display:flex;justify-content:space-between;align-items:flex-start;font-family:Arial,'Liberation Sans',sans-serif;padding-bottom:12px;border-bottom:2.5px solid #0D47A1}}"
            f".cab img{{height:62px;display:block;margin-bottom:6px}} .cab .emp{{font-size:22px;font-weight:700;color:#0D47A1}} .cab .cj{{font-size:15px;color:#64748B;margin-top:2px}}"
            f".cab .dir{{text-align:right;line-height:1.45}} .cab .ti{{font-size:24px;font-weight:700;color:{P['T1']}}} .cab .li{{font-size:14.5px;color:#64748B}}"
            f".rd{{font-family:Arial,'Liberation Sans',sans-serif;margin-top:14px;border-top:1px solid #969696;padding-top:6px;font-size:12.5px;color:#787878}} .rd .c{{text-align:center}} .rd .b{{display:flex;justify-content:space-between;margin-top:6px}}"
            f".rot-ger{{color:{rot(P['GER'])}}}")


def html(r, tema, idi, logo64, gerado):
    P, T = PALETA[tema], TXT[idi]
    rot = lambda c: f'color-mix(in srgb, {c} 55%, {P["BASE_ROT"]})'
    a = r['medicao_ate']
    kpi = lambda cor, k, v, u, sub: f'<div class="kc" style="--c:{cor}"><div class="k">{k}</div><b>{v}<small> {u}</small></b><p>{sub}</p></div>'
    raz, mot = motivo_txt(r, idi)
    avisos = []
    if not r['n_ordens'] and not r['herdada']:
        avisos.append(T['sem_ordem'].format(a=a))
    if r['herdada']:
        h0 = next(o for o in r['ordens'] if o['herdada'])
        avisos.append(T['herdada'].format(v=nf(h0['pot'], 0, idi)))
    if r['coletor'] == 'parado':
        avisos.append(T['coletor'].format(u=(r['coletor_ultimo'] or '—')[11:16] or '—'))
    us = ''.join(f'<div class="mu"><div class="mu-t"><b style="color:{rot(P["COR"][u])}">{u}</b><span>'
                 f'{T["us_val"].format(e=nf(x["mwh"], 2, idi), p=nf(x["pico"], 1, idi))}</span></div>{mini(P, x["serie"], P["COR"][u])}</div>'
                 for u, x in r['usinas'].items())
    corpo = (f'<div class="cab"><div><img src="data:image/png;base64,{logo64}"><div class="emp">{T["emp"]}</div><div class="cj">{T["cj"]}</div></div>'
             f'<div class="dir"><div class="ti">{T["titulo"]}</div><div class="li">{data_txt(r["dia"], idi)}</div><div class="li">{T["ate"].format(a=a)}</div>'
             f'<div class="li">{T["gerado"].format(g=gerado)}</div></div></div>'
             '<div class="kp">'
             + kpi(P['GER'], T['k_ger'].format(a=a), nf(r['energia_mwh'], 2, idi), 'MWh', T['pico'].format(p=nf(r['pico_mw'], 1, idi)))
             + kpi(P['CORTE'], T['k_ord'], str(r['n_ordens']), '', T['entre'].format(a=r['primeira'], b=r['ultima']) if r['n_ordens'] else T['nenhuma'].format(a=a))
             + kpi(P['CORTE'], T['k_tempo'], nf(r['horas_sob_limite'], 1, idi), 'h',
                   T['lmin'].format(v=nf(r['limite_min_mw'], 0, idi)) if r['limite_min_mw'] is not None else T['sem_lim'])
             + kpi(P['CORTE'], T['k_mot'], raz, '', mot) + '</div>'
             + ''.join(f'<div class="av">{x}</div>' for x in avisos)
             + f'<div class="pn"><div class="pt"><h2>{T["h_graf"]}</h2><small>{T["leg"].format(g=P["GER"], c=P["CORTE"], r=rot(P["CORTE"]))}</small></div>'
             + grafico(P, r) + f'<div class="leg">{T["nota"]}</div></div>'
             + f'<div class="pn"><div class="pt"><h2>{T["h_us"]}</h2><small>{T["us_sub"]}</small></div><div class="grade">{us}</div></div>'
             + f'<div class="rodape">{T["fonte"]}</div>'
             + f'<div class="rd"><div class="c">{T["emp"]} · {T["titulo"]} · {T["gerado"].format(g=gerado)}</div><div class="b"><span>{T["sigo"]}</span><span>1 / 1</span></div></div>')
    lang = 'en' if idi == 'en' else 'pt-BR'
    return (f'<!doctype html><html lang="{lang}"><head><meta charset="utf-8">'
            '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">'
            f'<style>{css(P)}</style></head><body>{corpo}</body></html>')


def visivel(t):
    import html as H
    return ' '.join(H.unescape(x) for x in re.findall(r'>([^<>]+)<', re.sub(r'<style>.*?</style>', '', t, flags=re.S)))


def gera(pasta, w2, iq, dia, ate, logo64, gerado):
    """grava as folhas e devolve (resumo, sobra_pt): sobra_pt = texto visível em português na folha EN (barra o envio)"""
    r = calcula(w2, iq, dia, ate)
    os.makedirs(pasta, exist_ok=True)
    sobra = set()
    for tema in ('claro', 'escuro'):
        for idi in ('pt', 'en'):
            t = html(r, tema, idi, logo64, gerado[idi])
            suf = '_en' if idi == 'en' else ''
            open(os.path.join(pasta, f'curva_{tema}{suf}.html'), 'w', encoding='utf-8').write(t)
            if tema == 'claro':   # a parte do WeCom é a folha inteira (uma página)
                open(os.path.join(pasta, f'curva_claro{suf}_p1.html'), 'w', encoding='utf-8').write(t)
            if idi == 'en':
                from fila import PT_RESTO
                sobra |= {m.group(0) for m in PT_RESTO.finditer(visivel(t).replace('Participações', '').replace('Intrepid', ''))}
    resumo = {k: v for k, v in r.items() if k not in ('serie', 'limite', 'usinas')}
    resumo['usinas'] = {u: {'mwh': x['mwh'], 'pico': x['pico']} for u, x in r['usinas'].items()}
    json.dump(resumo, open(os.path.join(pasta, 'curva_resumo.json'), 'w', encoding='utf-8'), ensure_ascii=False)
    return resumo, sorted(sobra)


if __name__ == '__main__':
    import sys
    pasta, dia = sys.argv[1], sys.argv[2]
    ate = sys.argv[3] if len(sys.argv) > 3 else '17:30'
    le = lambda n: json.load(open(os.path.join(pasta, n), encoding='utf-8'))
    logo = os.environ.get('BOLETIM_LOGO') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'logo_intrepid_800.png')
    agora = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3))
    ger = {'pt': agora.strftime('%d/%m/%Y %H:%M'), 'en': f'{agora.day} {MES_EN[agora.month - 1]} {agora.year} {agora:%H:%M}'}
    r, s = gera(os.path.join(pasta, 'curva_' + dia), le('way2_recent.json'), le('gestao__restricao_iqony.json'), dia, ate,
                base64.b64encode(open(logo, 'rb').read()).decode(), ger)
    print(json.dumps({k: r[k] for k in ('energia_mwh', 'pico_mw', 'n_ordens', 'primeira', 'ultima', 'horas_sob_limite', 'limite_min_mw', 'medicao_ate')}), 'sobra PT:', s)
