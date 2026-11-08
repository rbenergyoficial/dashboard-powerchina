# -*- coding: utf-8 -*-
"""Boletim de Desempenho · as curvas de 30 minutos que a página do SIGO desenha (boletim/curvas.json).
A medição de 30 minutos (way2_30min.json, ~14 MB, com oito grandezas de 25 pontos) é pesada demais para o navegador; o boletim usa dela
só a demanda ativa (Demat) do conjunto e de cada usina. Este arquivo guarda exatamente isso, com a MESMA conta do boletim.py: a soma dos
pontos de cada entidade em MW, por meia hora das 05:00 às 18:30, e nula quando falta um ponto. Leva também a irradiação diária no plano
do conjunto (irr_ufv.json, serie_dia do Complexo), a do cartão de irradiação.
A janela da medição é de 30 dias; o arquivo ACUMULA os dias das rodadas anteriores até GUARDA_DIAS, para a página alcançar meses fechados."""
import datetime as dt

GUARDA_DIAS = 120
CIRC = {'M1': [6198, 6199, 6200], 'M2': [6201, 6202], 'M3': [6203, 6204, 6205], 'M4': [6206, 6207, 6208], 'M5': [6209, 6210, 6211],
        'M6': [6212, 6213, 6214], 'M7': [6215], 'M8': [6216, 6217, 6218], 'M9': [6219]}
PONTOS = {'Complexo': [6196, 6197], **CIRC}
SLOTS = [f'{h:02d}:{m:02d}' for h in range(5, 19) for m in (0, 30)]


def monta(w2, ir, anterior=None, hoje=None):
    """w2: way2_30min.json; ir: irr_ufv.json; anterior: o curvas.json da rodada anterior (ou None); hoje: o dia de Brasília (AAAA-MM-DD)
    (o dia em curso não entra: a curva dele ainda está sendo medida)"""
    dem = {}
    for p in w2.get('dados') or []:
        if p.get('nomeGrandeza') == 'Demat':
            for x in p.get('valores') or []:
                if x.get('valor') is not None:
                    dem[(p['pontoId'], x['data'])] = x['valor'] / 1000
    dias = sorted({k[1][:10] for k in dem})
    out = dias_validos(anterior)
    for d in dias:
        if hoje and d >= hoje:
            continue
        linha = {}
        for u, ps in PONTOS.items():
            arr = []
            for s in SLOTS:
                v = [dem.get((p, f'{d}T{s}:00')) for p in ps]
                arr.append(None if any(x is None for x in v) else sum(v))
            linha[u] = arr
        if any(v is not None for v in linha['Complexo']):
            out[d] = linha
    manter = sorted(out)[-GUARDA_DIAS:]
    out = {d: out[d] for d in manter}
    irr = {r['dia']: r.get('gti') for r in (ir.get('serie_dia') or []) if r.get('ufv') == 'Complexo'}
    return {'esquema': 1, 'slots': SLOTS, 'pontos': PONTOS, 'guarda_dias': GUARDA_DIAS,
            'de': manter[0] if manter else None, 'ate': manter[-1] if manter else None, 'dias': out, 'irr_dia': irr,
            'gerado_em': dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds'), 'tentado_em': hoje}


def na_forma(c):
    """o curvas.json que esta versão sabe ler: esquema 1, as mesmas meias horas, os dias num dicionário"""
    return (isinstance(c, dict) and c.get('esquema') == 1 and c.get('slots') == SLOTS and isinstance(c.get('dias'), dict)
            and all(c.get(k) is None or isinstance(c.get(k), str) for k in ('ate', 'tentado_em')))


def dias_validos(anterior):
    """os dias da rodada anterior que estão na forma; o arquivo fora da forma vale como ausente (a rodada refaz do zero)"""
    if not na_forma(anterior):
        return {}
    n = len(SLOTS)
    return {d: v for d, v in anterior['dias'].items()
            if isinstance(d, str) and len(d) == 10 and isinstance(v, dict)
            and all(isinstance(v.get(u), list) and len(v[u]) == n for u in PONTOS)}


def velho(curvas, ontem, hoje=None):
    """a página precisa do dia de ontem: sem o arquivo, fora da forma, ou parado antes de ontem, a rodada baixa a medição e o refaz.
    No máximo UMA tentativa por dia (`tentado_em`): num dia em que a medição ainda não trouxe ontem, as outras rodadas da janela não
    descem de novo os ~19 MB das entradas pesadas só por causa das curvas."""
    if not na_forma(curvas):
        return True
    if hoje and curvas.get('tentado_em') == hoje:
        return False
    return not curvas.get('ate') or curvas['ate'] < ontem
