# -*- coding: utf-8 -*-
"""Boletim de Desempenho · tela executiva (lote boletim-pdf-executivo) · o DADO da tela, tirado do cálculo aprovado.
Roda DENTRO do boletim_ci.py: a troca 4 do prepara.py chama `grava(globals(), caminho)` quando BOLETIM_TELA_JSON está definido (só no
diário). Os números da tela são as variáveis do MESMO processo que desenha o diário e grava o resumo do texto do WeCom; nenhum número
é escrito à mão nem refeito por outra conta. O que a tela calcula no navegador (fator de capacidade, acumulado em % da meta, potencial
pela irradiância, a ponte do P50) usa só os números daqui.

Estado do ONS no dia (o mesmo `estado_ons` do texto, fila.py): 'publicado' · 'ordens' (pendente, com tempo sob ordem registrada pela
Iqony) · 'nenhuma' (pendente, registro sem ordem) · 'sem_registro' (pendente, sem o registro das ordens). O diário das 08:00 é sempre
pendente: a tela nunca escreve "sem limitação" nem "ONS apurou 0" nesse estado.

Fora da tela de propósito: o "PR sem o corte" POR USINA (a divisão da energia impedida por usina não é confiável; fica só o do complexo)."""
import json

# O estudo PVsyst dá o P75 e o P90 só do ano (977,7 e 959,0 GWh, contra 998,416 GWh do P50): o período sai na mesma proporção do P50,
# a conta do painel executivo do SIGO (lote dados-pvsyst, 23/11/2026). O fator do P90 é o do próprio boletim aprovado (P90_FATOR).
P75_FATOR = 977.7 / 998.416

CAMPOS = ('dia slots cx_mw lim irr us_mw cap_mw placa placa_total NT D mes us_dia cx pp liq meta_d LD erro_pp pr_dia pr_mes pr_mes_sc '
          'disp_dia disp_mes pr_us_mes disp_us_mes bench_mes imp_mes hr_mes p50_mes_ate p75_fator p90_fator livres pr_us_livre pr_cx_livre pr_serie disp_serie '
          'ons gerado txt').split()


def r(v, c=2):
    return None if v is None else round(float(v), c)


def extrai(G):
    """o dicionário da tela, das variáveis do boletim aprovado (G = globals() do boletim_ci.py, modo diário)"""
    if G['MODO'] != 'diario':
        raise SystemExit('RECUSADO: a tela executiva é só do diário')
    DIA, US, f_, dm = G['DIA'], G['US'], G['f_'], G['dias_mes']
    LIQ, SD, IRD, ONS30, ONS_DIAS, F = G['LIQ'], G['SD'], G['IRD'], G['ONS30'], G['ONS_DIAS'], G['_F']
    sl = G['slots'](DIA)
    o = {'dia': DIA, 'slots': [t[11:16] for t in sl], 'NT': G['NT'], 'D': G['D']}
    o['cx_mw'] = [r(G['mw']('Complexo', t)) for t in sl]
    o['lim'] = [r(f_(ONS30.get(t, {}).get('lim'))) for t in sl]
    o['irr'] = [r(G['I30'].get(t), 1) for t in sl]
    o['us_mw'] = {u: [r(G['mw'](u, t)) for t in sl] for u in US}
    o['cap_mw'] = {u: float(G['CAP'][u]) for u in US}
    o['placa'] = {u: float(G['PR']['placa_mwp'][u]) for u in US}
    o['placa_total'] = r(G['PLACA_MWP'], 4)
    o['mes'] = [{'d': d, 'liq': r(LIQ[('Complexo', d)][0]), 'meta': r(LIQ[('Complexo', d)][1]), 'ppa': r(LIQ[('PPA', d)][0]),
                 'cort': r((SD.get(d) or {}).get('cortado_mwh')), 'h': r((SD.get(d) or {}).get('horas_restricao'), 1),
                 'gti': r((IRD.get(d) or {}).get('gti')), 'ons': d in ONS_DIAS} for d in dm]
    o['us_dia'] = {u: [r(LIQ[(u, d)][0]) for d in dm] for u in US}
    for k in ('cx', 'pp'):
        o[k] = {a: G[k].get(a) for a in ('tot', 'meta', 'pct', 'proj_pct', 'prev', 'bateu')}
    o['liq'], o['meta_d'] = r(G['liq']), r(G['meta_d'])
    o['LD'] = {a: (r(b, 5) if isinstance(b, (int, float)) else b) for a, b in G['LD'].items()}
    o['erro_pp'] = G['erro']
    o['pr_dia'] = r(G['p'])
    o['pr_mes'], o['pr_mes_sc'] = r(G['pm']), r(G['pcm'])          # o "sem o corte" fica só no número do complexo
    o['disp_dia'], o['disp_mes'] = r(G['dsp'], 4), r(G['dsm'], 4)   # disp_dia None = os inversores ainda não fecharam o dia
    o['pr_us_mes'] = {u: r(G['pr_dias']([u], dm)[0]) for u in US}   # o PR PUBLICADO do mês por usina (sem o "sem o corte")
    o['disp_us_mes'] = {u: r(G['disp_dias']([u], dm), 3) for u in US}
    # PR por usina só nos dias APURADOS pelo ONS sem energia impedida no conjunto: dia pendente nunca conta como dia sem corte
    livres = [d for d in dm if d in ONS_DIAS and not ((SD.get(d) or {}).get('cortado_mwh') or 0)]
    o['livres'] = livres
    o['pr_us_livre'] = {u: r(G['pr_dias']([u], livres)[0]) for u in US} if livres else {}
    o['pr_cx_livre'] = r(G['pr_dias'](US, livres)[0]) if livres else None
    o['pr_serie'] = [r(G['pr_dias'](US, [d])[0]) for d in dm]
    o['disp_serie'] = [r(G['disp_dias'](US, [d]), 4) for d in dm]
    o['bench_mes'] = {k: r(v, 4) for k, v in G['b_m'].items()}      # só os dias que o ONS publicou
    o['imp_mes'], o['hr_mes'] = r(G['imp_mes']), r(G['hr_mes'], 1)
    o['p50_mes_ate'] = r(G['p50_dias'](dm))
    o['p75_fator'], o['p90_fator'] = r(P75_FATOR, 8), r(G['P90_FATOR'], 8)
    iq = G['IQD'] if isinstance(G['IQD'], dict) else None
    o['ons'] = {'estado': F.estado_ons({'ons_estado': G['ONS_EST'], 'iqony': G['IQD']}), 'ult': G['ULT_ONS'],
                'iq': ({k: iq.get(k) for k in ('n', 'h', 'lmin', 'ini', 'fim', 'herdada', 'coletor')} if iq else None),
                'degraus': [[int(a), int(b), r(v)] for a, b, v in G['degraus_dia'](DIA)]}
    o['gerado'] = G['GERADO']
    o['txt'] = {'disp_pend': dict(F.DISP_PENDENTE, zh='10 时核算')}   # a disponibilidade que ainda não chegou: a mesma frase do texto do WeCom
    return {k: o[k] for k in CAMPOS}


def grava(G, caminho):
    json.dump(extrai(G), open(caminho, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
