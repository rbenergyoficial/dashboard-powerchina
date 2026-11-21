# -*- coding: utf-8 -*-
"""SIGO · Desempenho · envio diário e mensal (lote desempenho-envio, 20/11/2026).

Gera o texto do registro DIÁRIO (D-1, às 08:00) e do MENSAL (dia 1º, mês fechado) da área SIGO · Desempenho, com os MESMOS números
da página /desempenho/ (lote desempenho-fase1). O envio é o do Boletim de Desempenho: o item entra na fila `boletim/fila.json` e a
função boletim_envio.js do Function App o posta no grupo "Reports O&M - SIGO" (texto em msgtype "text", que o WeCom traduz; arquivo
por upload_media). Nenhum robô, segredo ou canal novo.

Decisões do humano (20/11/2026): mesmo grupo do Boletim; diário às 08:00 com as ordens do ONS recebidas pela Iqony (o RDO de
restrições), e a conferência ordens × dados abertos do ONS do dia anterior no diário seguinte; mensal com PDF e planilha; e-mail
depois. Ao grupo vai SÓ o inglês (regra do Boletim, 07/11); o português é guardado.

O cálculo é o da página (index.html do desempenho-fase1, funções onsMes, pelaSoma, p50Mes, compEstacoes):
  · energia frustrada = Σ máx(0; referência − gerada) × 0,5 h nas meias horas com limitação > 0;
  · referência = a soma das usinas nas meias horas listadas em executivo.ref_conjunto_pela_soma;
  · dias excluídos 03/03 e 11/03/2026 (o ONS publicou geração impossível): fora da frustrada e das horas;
  · P50 do PVsyst (estudo de viabilidade, fev/2023) só do conjunto e de dez/25 em diante; P90 = P50 × 959,0 ÷ 998,416. O P50 NÃO é
    copiado aqui: é lido do boletim_aprovado.py, a única cópia que o pipeline já tem.

Uso:
  python desempenho_envio.py <pasta das entradas> diario <AAAA-MM-DD> [--agora AAAA-MM-DDTHH:MM] [--saida <pasta>] [--boletim <scripts/boletim>]
  python desempenho_envio.py <pasta das entradas> mensal <AAAA-MM>    [--agora ...] [--saida <pasta>] [--boletim ...]
As entradas têm os nomes que o boletim-blobs.js grava ('/' vira '__'): executivo.json, ons_restricao_AAAA_MM.json, estacao_dia.json,
way2_saude.json, sager_disp_30min.json e gestao__restricao_iqony.json (este opcional: sem ele, o diário diz "sem registro das ordens").
"""
import ast
import calendar
import datetime as dt
import json
import os
import re
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
UFV = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']
RAZ = ['ENE', 'CNF', 'REL']
H = 0.5
DIAS_EXCLUIDOS = {'2026-03-03', '2026-03-11'}   # a mesma lista do gen-executivo.js e da página; se mudar lá, muda aqui
PV_INICIO = '2025-12'
LIMITE_TEXTO = 2000   # o boletim_envio.js corta em 2000 caracteres; o texto tem de caber inteiro
# a guarda do boletim_envio.js (ao grupo vai só inglês): a mesma expressão, para o item nunca chegar lá e ser barrado
PORTUGUES = re.compile(r'[ãõçáéíóúâêô]|\b(?:de|do|da|dos|das|em|com|não|mês|dia|meta|usina|corte|geração)\b', re.I)
PROIBIDO = re.compile(r'ONS\s+apurou\s+0', re.I)

MES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
MES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
SEM_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
SEM_PT = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom']
MOTIVO = {'ENE_FREQ': ('energy, frequency control', 'energético, controle de frequência'),
          'FLUXO': ('flow or interchange', 'fluxo ou intercâmbio'),
          'ELE_SGI': ('contingency, SGI or unavailability', 'contingência, SGI ou indisponibilidade'),
          'REATIVO': ('reactive power control', 'controle de reativo'),
          'PATAMAR': ('load level', 'patamar de carga'),
          'OUTRO': ('other reason', 'outro motivo')}


# ── números e datas nas duas línguas ──────────────────────────────────────────────────────────────────────────────────────────────
def nf(v, d, lg):
    if v is None:
        return '—'
    s = f'{v:,.{d}f}'
    return s if lg == 'en' else s.replace(',', '§').replace('.', ',').replace('§', '.')


def data(d, lg, semana=True):
    x = dt.date.fromisoformat(d)
    if lg == 'en':
        return (SEM_EN[x.weekday()] + ', ' if semana else '') + f'{x.day} {MES_EN[x.month - 1][:3]} {x.year}'
    return (SEM_PT[x.weekday()] + ', ' if semana else '') + x.strftime('%d/%m/%Y')


def curta(d, lg):
    x = dt.date.fromisoformat(d)
    return f'{x.day} {MES_EN[x.month - 1][:3]}' if lg == 'en' else x.strftime('%d/%m')


def rot_mes(m, lg):
    y, mo = int(m[:4]), int(m[5:7])
    return f'{MES_EN[mo - 1]} {y}' if lg == 'en' else f'{MES_PT[mo - 1]} de {y}'


def motivo(m, lg):
    return MOTIVO.get(m, MOTIVO['OUTRO'])[0 if lg == 'en' else 1]


# ── entradas ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def le(pasta, nome, padrao=None):
    p = os.path.join(pasta, nome)
    if not os.path.exists(p):
        return padrao
    with open(p, encoding='utf-8-sig') as f:
        return json.load(f)


def p50_do_boletim(caminho):
    """PV_P50 e P90_FATOR lidos do boletim_aprovado.py por árvore sintática (nada é executado, nada é copiado)."""
    arv = ast.parse(open(caminho, encoding='utf-8').read())
    p50 = fator = None
    for no in arv.body:
        if isinstance(no, ast.Assign) and len(no.targets) == 1 and isinstance(no.targets[0], ast.Name):
            nome = no.targets[0].id
            if nome == 'PV_P50':
                p50 = ast.literal_eval(no.value)
            elif nome == 'P90_FATOR' and isinstance(no.value, ast.BinOp) and isinstance(no.value.op, ast.Div):
                fator = ast.literal_eval(no.value.left) / ast.literal_eval(no.value.right)
    if not p50 or len(p50) != 12 or not fator:
        raise SystemExit('RECUSADO: P50/P90 do PVsyst não encontrados em ' + caminho)
    if abs(sum(p50.values()) - 998.416) > 0.01:
        raise SystemExit('RECUSADO: o P50 lido não soma 998,416 GWh: %.3f' % sum(p50.values()))
    return p50, fator


def num(v):
    try:
        x = float(v)
        return x if x == x else 0.0
    except (TypeError, ValueError):
        return 0.0


# ── o cálculo da página (onsMes, pelaSoma, compEstacoes) ─────────────────────────────────────────────────────────────────────────
def pela_soma(executivo):
    return {str(r['ts'])[:16]: num(r.get('soma_usinas')) for r in (executivo or {}).get('ref_conjunto_pela_soma') or []}


def ons_mes(arq, ps, excluidos=None):
    """onsMes da página: frustrada, meias horas com limitação, por razão e por dia. ps = pela_soma(executivo)."""
    excluidos = DIAS_EXCLUIDOS if excluidos is None else excluidos
    o = {'fru': 0.0, 'n': 0, 'raz': {}, 'dias': {}, 'por_dia': {}, 'ultimo': ''}
    for r in sorted((arq or {}).get('consolidado') or [], key=lambda r: r['ts']):
        dia, k16 = r['ts'][:10], r['ts'][:16]
        ger, lim = num(r.get('ger')), num(r.get('lim'))
        gref = ps[k16] if k16 in ps else num(r.get('gref'))
        o['dias'][dia] = o['dias'].get(dia, 0) + 1
        o['ultimo'] = max(o['ultimo'], r['ts'])
        pd = o['por_dia'].setdefault(dia, {'fru': 0.0, 'n': 0, 'raz': {}})
        if lim > 0 and dia not in excluidos:
            perda = max(0.0, (gref - ger) * H)
            rz = str(r.get('razao') or '').strip().upper() or 'N/D'
            o['fru'] += perda; o['n'] += 1; o['raz'][rz] = o['raz'].get(rz, 0.0) + perda
            pd['fru'] += perda; pd['n'] += 1; pd['raz'][rz] = pd['raz'].get(rz, 0.0) + perda
    return o


def estacoes_dia(est, dia):
    """registros de 10 min de cada estação no dia (teto 144); estação que ainda não existia no dia fica de fora (como na página)."""
    if not est or not est.get('serie'):
        return None
    primeiro, idx = {}, {}
    for s in est['serie']:
        if s['u'] not in primeiro or s['d'] < primeiro[s['u']]:
            primeiro[s['u']] = s['d']
        if s['d'] == dia:
            idx[s['u']] = s
    return {u: min(144, int((idx.get(u) or {}).get('n') or 0)) for u in UFV if primeiro.get(u) and dia >= primeiro[u]}


def dias_do_mes(m):
    y, mo = int(m[:4]), int(m[5:7])
    return [f'{m}-{d:02d}' for d in range(1, calendar.monthrange(y, mo)[1] + 1)]


def comp_estacoes(est, m, hoje):
    fech = [d for d in dias_do_mes(m) if d < hoje]
    if not est or not est.get('serie') or not fech:
        return None
    a = b = 0
    por = {}
    for d in fech:
        for u, n in (estacoes_dia(est, d) or {}).items():
            a += n; b += 144
            por.setdefault(d, {})[u] = n
    return {'cpx': a / b if b else None, 'fech': fech, 'por_dia': por}


def sager_mes(sg, m, hoje):
    """meias horas com dado insatisfatório (marca do ONS) por usina e dia, nos dias fechados do mês."""
    pts = [x for x in (sg or {}).get('serie') or [] if x['t'][:7] == m and x['t'][:10] < hoje]
    if not pts:
        return None
    ruins = {}
    for x in pts:
        for k, u in enumerate(UFV):
            if (x.get('i') or [0] * 9)[k]:
                ruins[(x['t'][:10], u)] = ruins.get((x['t'][:10], u), 0) + 1
    return {'n': len(pts), 'ruins': ruins, 'cpx': 1 - sum(ruins.values()) / (len(pts) * 9)}


# ── ordens do ONS recebidas pela Iqony (o RDO de restrições): a conta do Boletim, nunca refeita aqui ───────────────────────────────
def ordens_iqony(iq, dia, boletim_dir):
    """('sem_registro'|'nenhuma'|'ordens', resumo) — a função iqony_dia do fila.py do Boletim."""
    if not iq:
        return 'sem_registro', None
    if boletim_dir not in sys.path:
        sys.path.insert(0, boletim_dir)
    import fila as F
    try:
        r = F.iqony_dia(iq, dia)
    except (Exception, SystemExit):   # noqa: BLE001 (fora da forma = sem o registro, como no Boletim)
        return 'sem_registro', None
    if r is None:
        return 'sem_registro', None
    return ('ordens' if (r.get('h') or 0) > 0 else 'nenhuma'), r


# ── o DIÁRIO ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def publicado(meias):
    """o dia está no arquivo do ONS. Dia fora do arquivo é PENDENTE, nunca "sem limitação" nem "0 MWh" (regra do boletim-ons-pendente)."""
    return meias > 0


def dados_diario(pasta, dia, agora, boletim_dir):
    ex = le(pasta, 'executivo.json')
    if ex is None:
        raise SystemExit('RECUSADO: executivo.json ausente (sem ele não há a referência pela soma das usinas)')
    ps = pela_soma(ex)
    ontem = (dt.date.fromisoformat(dia) - dt.timedelta(days=1)).isoformat()
    ons = {}
    for m in sorted({dia[:7], ontem[:7]}):
        arq = le(pasta, 'ons_restricao_%s.json' % m.replace('-', '_'))
        if arq is not None:
            ons[m] = ons_mes(arq, ps)
    iq = le(pasta, 'gestao__restricao_iqony.json')

    def do_dia(d):
        o = ons.get(d[:7])
        n = (o or {}).get('dias', {}).get(d, 0)
        pd = (o or {}).get('por_dia', {}).get(d) or {'fru': 0.0, 'n': 0, 'raz': {}}
        est_iq, r_iq = ordens_iqony(iq, d, boletim_dir)
        return {'dia': d, 'ons_meias': n, 'publicado': publicado(n), 'excluido': d in DIAS_EXCLUIDOS,
                'fru': pd['fru'], 'horas': pd['n'] * H, 'raz': pd['raz'], 'iq_estado': est_iq, 'iq': r_iq}

    hoje = do_dia(dia)
    conf = do_dia(ontem) if not hoje['publicado'] else None
    om = ons.get(dia[:7])
    mes_ate = None
    if om:
        dias_pub = sorted(d for d in om['dias'] if d <= dia)
        if dias_pub:
            mes_ate = {'ate': dias_pub[-1], 'fru': sum(om['por_dia'][d]['fru'] for d in dias_pub),
                       'horas': sum(om['por_dia'][d]['n'] for d in dias_pub) * H}
    est = estacoes_dia(le(pasta, 'estacao_dia.json'), dia)
    w2 = (le(pasta, 'way2_saude.json') or {}).get('resumo')
    ons_ult = conf if conf and conf['publicado'] else (hoje if hoje['publicado'] else None)
    return {'modo': 'diario', 'dia': dia, 'agora': agora, 'hoje': hoje, 'conf': conf, 'mes_ate': mes_ate,
            'estacoes': est, 'medidores': w2, 'ons_completo': ons_ult and {'dia': ons_ult['dia'], 'meias': ons_ult['ons_meias']}}


def _razoes(raz, lg):
    partes = [f'{k} {nf(raz[k], 2, lg)}' for k in RAZ + sorted(set(raz) - set(RAZ)) if raz.get(k, 0) > 0.005]
    return ' · '.join(partes)


def _linha_ordens(x, lg):
    en = lg == 'en'
    if x['iq_estado'] == 'sem_registro':
        return '- No record of the ONS orders for the day (Iqony log).' if en else '- Sem registro das ordens do ONS no dia (registro da Iqony).'
    if x['iq_estado'] == 'nenhuma':
        return '- No ONS order received on the day (Iqony log).' if en else '- Nenhuma ordem do ONS recebida no dia (registro da Iqony).'
    r = x['iq']
    mot = ', '.join(motivo(m, lg) for m in r.get('motivos') or [])
    if en:
        return (f'- Orders received through Iqony: {nf(r["h"], 1, lg)} h under order'
                + (f', {r["ini"]} to {r["fim"]}' if r.get('ini') else '')
                + (f', lowest limit {nf(r["lmin"], 0, lg)} MW' if r.get('lmin') is not None else '')
                + (f' ({mot})' if mot else '') + '.')
    return (f'- Ordens recebidas pela Iqony: {nf(r["h"], 1, lg)} h sob ordem'
            + (f', das {r["ini"]} às {r["fim"]}' if r.get('ini') else '')
            + (f', limite mínimo {nf(r["lmin"], 0, lg)} MW' if r.get('lmin') is not None else '')
            + (f' ({mot})' if mot else '') + '.')


def _linha_ons(x, lg):
    en = lg == 'en'
    if x['excluido']:
        return ('- Day excluded from the curtailment count: the ONS published generation above the billing meter.' if en else
                '- Dia fora da conta da restrição: o ONS publicou geração acima do medidor de faturamento.')
    if x['horas'] == 0:
        return ('- ONS open data: no half hour with limitation on the day.' if en else
                '- Dados abertos do ONS: nenhuma meia hora com limitação no dia.')
    rz = _razoes(x['raz'], lg)
    if en:
        return f'- ONS open data: {nf(x["fru"], 2, lg)} MWh frustrated in {nf(x["horas"], 1, lg)} h with limitation' + (f' ({rz} MWh).' if rz else '.')
    return f'- Dados abertos do ONS: {nf(x["fru"], 2, lg)} MWh de energia frustrada em {nf(x["horas"], 1, lg)} h com limitação' + (f' ({rz} MWh).' if rz else '.')


def _excecoes_diario(D, lg):
    en, exc = lg == 'en', []
    for u, n in sorted((D['estacoes'] or {}).items()):
        if n < 144:
            exc.append((f'{u} weather station {n} of 144' if en else f'estação de {u} {n} de 144') if n else
                       (f'{u} weather station with no record' if en else f'estação de {u} sem registro'))
    oc = D['ons_completo']
    if oc and oc['meias'] != 48:
        exc.append(f'ONS {curta(oc["dia"], lg)} {oc["meias"]} of 48 half hours' if en else f'ONS {curta(oc["dia"], lg)} {oc["meias"]} de 48 meias horas')
    w = D['medidores'] or {}
    if w.get('falha'):
        exc.append(f'{w["falha"]} boundary meter(s) without reading' if en else f'{w["falha"]} medidor(es) de fronteira sem leitura')
    return exc


def texto_diario(D, lg):
    en, d, x = lg == 'en', D['dia'], D['hoje']
    L = [(f'SIGO · Performance · daily record · {data(d, lg)}' if en else f'SIGO · Desempenho · registro diário · {data(d, lg)}'),
         'Mauriti PV complex (9 plants)' if en else 'Conjunto Fotovoltaico Mauriti (9 usinas)', '',
         (f'ONS curtailment on {curta(d, lg)}' if en else f'Restrição do ONS em {curta(d, lg)}')]
    if x['publicado']:
        L.append(_linha_ons(x, lg))
        L.append(_linha_ordens(x, lg))
    else:
        L.append(_linha_ordens(x, lg))
        L.append('- ONS settlement pending: the open data for the day is published the next afternoon.' if en else
                 '- Apuração do ONS pendente: os dados abertos do dia saem na tarde seguinte.')
    c = D['conf']
    if c:
        L += ['', (f'Check of {curta(c["dia"], lg)}: Iqony orders × ONS open data' if en else
                   f'Conferência de {curta(c["dia"], lg)}: ordens da Iqony × dados abertos do ONS')]
        if c['publicado']:
            L.append(_linha_ons(c, lg))
            L.append(_linha_ordens(c, lg))
            if c['iq_estado'] != 'sem_registro' and not c['excluido']:
                dif = (c['iq']['h'] if c['iq'] else 0) - c['horas']
                L.append((f'- Difference in hours (orders − ONS): {"+" if dif >= 0 else "−"}{nf(abs(dif), 1, lg)} h.' if en else
                          f'- Diferença de horas (ordens − ONS): {"+" if dif >= 0 else "−"}{nf(abs(dif), 1, lg)} h.'))
        else:
            L.append('- ONS open data not published yet; the check follows in the next record.' if en else
                     '- Dados abertos do ONS ainda não publicados; a conferência segue no próximo registro.')
    ma = D['mes_ate']
    if ma:
        L += ['', (f'Month to date ({rot_mes(d[:7], lg)}, through {curta(ma["ate"], lg)})' if en else
                   f'Acumulado de {rot_mes(d[:7], lg)} (até {curta(ma["ate"], lg)})'),
              (f'- Frustrated energy: {nf(ma["fru"], 2, lg)} MWh in {nf(ma["horas"], 1, lg)} h with limitation.' if en else
               f'- Energia frustrada: {nf(ma["fru"], 2, lg)} MWh em {nf(ma["horas"], 1, lg)} h com limitação.')]
    L += ['', 'Data completeness' if en else 'Completude dos dados']
    e = D['estacoes']
    if e:
        tot, ok = sum(e.values()), sum(1 for n in e.values() if n >= 144)
        L.append((f'- Weather stations on {curta(d, lg)}: {nf(tot, 0, lg)} of {nf(144 * len(e), 0, lg)} ten-minute records ({ok} of {len(e)} complete).' if en else
                  f'- Estações em {curta(d, lg)}: {nf(tot, 0, lg)} de {nf(144 * len(e), 0, lg)} registros de 10 min ({ok} de {len(e)} completas).'))
    else:
        L.append('- Weather stations: no data received.' if en else '- Estações: nenhum dado recebido.')
    w = D['medidores']
    if w:
        L.append((f'- Boundary meters now: {w.get("ok", 0)} of {w.get("total", 0)} up to date, {w.get("atraso", 0)} late, {w.get("falha", 0)} without reading.' if en else
                  f'- Medidores de fronteira agora: {w.get("ok", 0)} de {w.get("total", 0)} em dia, {w.get("atraso", 0)} em atraso, {w.get("falha", 0)} sem leitura.'))
    oc = D['ons_completo']
    if oc:
        L.append((f'- ONS open data on {curta(oc["dia"], lg)}: {oc["meias"]} of 48 half hours.' if en else
                  f'- Dados abertos do ONS em {curta(oc["dia"], lg)}: {oc["meias"]} de 48 meias horas.'))
    exc = _excecoes_diario(D, lg)
    L.append(('To justify: ' if en else 'A justificar: ') + '; '.join(exc) + '.' if exc else ('Nothing to justify.' if en else 'Nada a justificar.'))
    return '\n'.join(L)


# ── o MENSAL ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
def dados_mensal(pasta, m, agora, boletim_dir):
    ex = le(pasta, 'executivo.json')
    if ex is None:
        raise SystemExit('RECUSADO: executivo.json ausente')
    hoje = agora[:10]
    if dias_do_mes(m)[-1] >= hoje:
        raise SystemExit('RECUSADO: o mensal só sai com o mês fechado (%s, hoje %s)' % (m, hoje))
    p50tab, fator = p50_do_boletim(os.path.join(boletim_dir, 'boletim_aprovado.py'))
    ps = pela_soma(ex)
    arq = le(pasta, 'ons_restricao_%s.json' % m.replace('-', '_'))
    ons = ons_mes(arq, ps) if arq is not None else None
    s = next((x for x in ex.get('serie') or [] if x.get('mes') == m), None)
    man = next((x for x in ex.get('manchete_ufv') or [] if x.get('mes') == m and x.get('ufv') == 'Complexo'), None)
    p50 = p50tab[m[5:7]] if m >= PV_INICIO else None
    liq = None
    if man:
        liq = num(man.get('liq_gwh')) if num(man.get('fechado')) else num(man.get('liq_fechada_gwh'))
    est = comp_estacoes(le(pasta, 'estacao_dia.json'), m, hoje)
    sg = sager_mes(le(pasta, 'sager_disp_30min.json'), m, hoje)
    fru_gwh = ons['fru'] / 1000 if ons else None
    K = {
        'real_p50': liq / p50 * 100 if liq is not None and p50 else None,
        'real_p50_imp': (liq + fru_gwh) / p50 * 100 if liq is not None and p50 and fru_gwh is not None else None,
        'real_p90': liq / (p50 * fator) * 100 if liq is not None and p50 else None,
        'real_p90_imp': (liq + fru_gwh) / (p50 * fator) * 100 if liq is not None and p50 and fru_gwh is not None else None,
        'p50_gwh': p50, 'p90_gwh': p50 * fator if p50 else None, 'liq_gwh': liq,
        'fru_mwh': ons['fru'] if ons else None, 'horas': ons['n'] * H if ons else None, 'meias': ons['n'] if ons else None,
        'raz': ons['raz'] if ons else {},
        'disp': s.get('disp_pct') if s else None, 'disp_cob': s.get('disp_cobertura_pct') if s else None,
        'met': est['cpx'] * 100 if est and est['cpx'] is not None else None, 'met_dias': len(est['fech']) if est else 0,
        'med': s['w2_dias_completos'] / s['dias'] * 100 if s and s.get('dias') else None,
        'med_dias': (s.get('w2_dias_completos'), s.get('dias')) if s else None,
    }
    linhas = []
    for d in dias_do_mes(m):
        pd = (ons or {}).get('por_dia', {}).get(d) or {'fru': 0.0, 'n': 0, 'raz': {}}
        e = (est or {}).get('por_dia', {}).get(d) or {}
        sr = {u: n for (dd, u), n in ((sg or {}).get('ruins') or {}).items() if dd == d}
        meias = (ons or {}).get('dias', {}).get(d, 0)
        exc = [(u, 'est', n) for u, n in sorted(e.items()) if n < 144]
        if ons is not None and meias != 48:
            exc.append(('ONS', 'ons', meias))
        exc += [(u, 'sager', n) for u, n in sorted(sr.items())]
        linhas.append({'dia': d, 'excluido': d in DIAS_EXCLUIDOS, 'fru': pd['fru'], 'horas': pd['n'] * H,
                       'raz': {k: pd['raz'].get(k, 0.0) for k in RAZ}, 'ons_meias': meias,
                       'est_reg': sum(e.values()), 'est_esp': 144 * len(e), 'sager_ruins': sum(sr.values()), 'exc': exc})
    return {'modo': 'mensal', 'mes': m, 'agora': agora, 'k': K, 'linhas': linhas,
            'n_exc': sum(len(x['exc']) for x in linhas), 'fechado': bool(man and num(man.get('fechado')))}


def _pct(v, lg):
    return nf(v, 1, lg) + '%' if lg == 'en' else nf(v, 1, lg) + ' %'


def texto_mensal(M, lg):
    en, k, m = lg == 'en', M['k'], M['mes']
    pend = 'no figure yet' if en else 'sem número ainda'
    L = [(f'SIGO · Performance · monthly record · {rot_mes(m, lg)}' if en else f'SIGO · Desempenho · registro mensal · {rot_mes(m, lg)}'),
         'Mauriti PV complex (9 plants), closed month' if en else 'Conjunto Fotovoltaico Mauriti (9 usinas), mês fechado', '']
    if k['real_p50'] is not None:
        L.append((f'1. Real × P50: {_pct(k["real_p50"], lg)}' + (f' ({_pct(k["real_p50_imp"], lg)} adding the ONS curtailment)' if k['real_p50_imp'] is not None else '')
                  + f'. Net {nf(k["liq_gwh"], 2, lg)} GWh against a P50 of {nf(k["p50_gwh"], 3, lg)} GWh (feasibility study, PVsyst).') if en else
                 (f'1. Real × P50: {_pct(k["real_p50"], lg)}' + (f' ({_pct(k["real_p50_imp"], lg)} somando a restrição do ONS)' if k['real_p50_imp'] is not None else '')
                  + f'. Líquida {nf(k["liq_gwh"], 2, lg)} GWh contra P50 de {nf(k["p50_gwh"], 3, lg)} GWh (estudo de viabilidade, PVsyst).'))
        L.append((f'2. Real × P90: {_pct(k["real_p90"], lg)}' + (f' ({_pct(k["real_p90_imp"], lg)} adding the curtailment)' if k['real_p90_imp'] is not None else '')
                  + '. Physical guarantee per plant: awaiting.') if en else
                 (f'2. Real × P90: {_pct(k["real_p90"], lg)}' + (f' ({_pct(k["real_p90_imp"], lg)} somando a restrição)' if k['real_p90_imp'] is not None else '')
                  + '. Garantia física de cada usina: aguarda.'))
    else:
        L.append('1. Real × P50: ' + ('the PVsyst P50 covers the complex from December 2025 on.' if en else 'o P50 do PVsyst vale para o conjunto a partir de dezembro de 2025.'))
        L.append('2. Real × P90: ' + pend + '.')
    rz = _razoes(k['raz'], lg)
    L.append((f'3. Frustrated energy (ONS): {nf(k["fru_mwh"], 2, lg)} MWh' + (f' ({rz} MWh).' if rz else '.')) if en else
             (f'3. Energia frustrada (ONS): {nf(k["fru_mwh"], 2, lg)} MWh' + (f' ({rz} MWh).' if rz else '.'))
             if k['fru_mwh'] is not None else ('3. Frustrated energy (ONS): ' if en else '3. Energia frustrada (ONS): ') + pend + '.')
    L.append((f'4. Curtailment hours: {nf(k["horas"], 1, lg)} h ({k["meias"]} half hours with limitation).' if en else
              f'4. Horas de restrição: {nf(k["horas"], 1, lg)} h ({k["meias"]} meias horas com limitação).')
             if k['horas'] is not None else ('4. Curtailment hours: ' if en else '4. Horas de restrição: ') + pend + '.')
    L.append((f'5. Declared availability: {nf(k["disp"], 2, lg)}%' + (f' (coverage {nf(k["disp_cob"], 1, lg)}%).' if k['disp_cob'] is not None else '.')) if en else
             (f'5. Disponibilidade declarada: {nf(k["disp"], 2, lg)} %' + (f' (cobertura {nf(k["disp_cob"], 1, lg)} %).' if k['disp_cob'] is not None else '.'))
             if k['disp'] is not None else ('5. Declared availability: ' if en else '5. Disponibilidade declarada: ') + pend + '.')
    L.append(('6. Loss from equipment failure: ' if en else '6. Perda por falha: ') + pend + '.')
    L.append(('7. SCADA completeness: ' if en else '7. Completude do supervisório: ') + pend + '.')
    L.append((f'8. Weather data completeness: {_pct(k["met"], lg)} ({k["met_dias"]} days, 9 stations).' if en else
              f'8. Completude meteorológica: {_pct(k["met"], lg)} ({k["met_dias"]} dias, 9 estações).')
             if k['met'] is not None else ('8. Weather data completeness: ' if en else '8. Completude meteorológica: ') + pend + '.')
    L.append((f'9. Metering completeness: {_pct(k["med"], lg)} ({k["med_dias"][0]} of {k["med_dias"][1]} days complete).' if en else
              f'9. Completude da medição: {_pct(k["med"], lg)} ({k["med_dias"][0]} de {k["med_dias"][1]} dias completos).')
             if k['med'] is not None else ('9. Metering completeness: ' if en else '9. Completude da medição: ') + pend + '.')
    L.append(('10. Physical guarantee compliance: awaiting the physical guarantee of each plant.' if en else
              '10. Atendimento da garantia física: aguarda a garantia física de cada usina.'))
    L += ['', (f'Records to justify in the month: {M["n_exc"]}. Daily record attached (PDF and spreadsheet).' if en else
               f'Registros a justificar no mês: {M["n_exc"]}. Registro diário anexo (PDF e planilha).')]
    return '\n'.join(L)


# ── os anexos do mensal: planilha e página para o PDF (padrão Intrepid, página branca) ──────────────────────────────────────────
COL = {'en': ['Date', 'Frustrated energy (MWh)', 'Hours with limitation', 'ENE (MWh)', 'CNF (MWh)', 'REL (MWh)', 'ONS half hours published',
              'Weather records (10 min)', 'Weather records expected', 'ONS unsatisfactory half hours', 'To justify'],
       'pt': ['Data', 'Energia frustrada (MWh)', 'Horas com limitação', 'ENE (MWh)', 'CNF (MWh)', 'REL (MWh)', 'Meias horas publicadas pelo ONS',
              'Registros meteorológicos (10 min)', 'Registros esperados', 'Meias horas com dado insatisfatório (ONS)', 'A justificar']}


def exc_txt(exc, lg):
    en, out = lg == 'en', []
    for u, tipo, n in exc:
        if tipo == 'est':
            out.append(f'{u} station {n}/144' if en else f'estação {u} {n}/144')
        elif tipo == 'ons':
            out.append(f'ONS {n}/48' if en else f'ONS {n}/48')
    sg = [(u, n) for u, tipo, n in exc if tipo == 'sager']
    if sg:
        lista = 'M1–M9' if len(sg) == 9 else ', '.join(u for u, _ in sg)
        out.append((f'ONS unsatisfactory data: {lista}' if en else f'dado insatisfatório do ONS: {lista}'))
    return '; '.join(out)


def linha_tab(x, lg):
    if x['excluido']:
        nota = 'excluded day (ONS published impossible generation)' if lg == 'en' else 'dia excluído (ONS publicou geração impossível)'
        return [x['dia'], None, None, None, None, None, x['ons_meias'], x['est_reg'], x['est_esp'], x['sager_ruins'], nota + ('; ' + exc_txt(x['exc'], lg) if x['exc'] else '')]
    return [x['dia'], round(x['fru'], 2), x['horas'], round(x['raz']['ENE'], 2), round(x['raz']['CNF'], 2), round(x['raz']['REL'], 2),
            x['ons_meias'], x['est_reg'], x['est_esp'], x['sager_ruins'], exc_txt(x['exc'], lg)]


def planilha(M, lg, caminho):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    wb = Workbook()
    ws = wb.active
    ws.title = 'Daily record' if lg == 'en' else 'Registro diário'
    ws.append([(f'SIGO · Performance · daily record · {rot_mes(M["mes"], lg)}' if lg == 'en' else f'SIGO · Desempenho · registro diário · {rot_mes(M["mes"], lg)}')])
    ws['A1'].font = Font(bold=True, size=12, color='0D47A1')
    ws.append([])
    ws.append(COL[lg])
    for c in ws[3]:
        c.font = Font(bold=True, color='FFFFFF'); c.fill = PatternFill('solid', fgColor='0D47A1'); c.alignment = Alignment(wrap_text=True, vertical='center')
    for x in M['linhas']:
        ws.append(linha_tab(x, lg))
    for i, w in enumerate([12, 14, 12, 11, 11, 11, 14, 16, 14, 18, 60]):
        ws.column_dimensions[chr(65 + i)].width = w
    ws.freeze_panes = 'B4'
    k = wb.create_sheet('Indicators' if lg == 'en' else 'Indicadores')
    for linha in texto_mensal(M, lg).split('\n'):
        k.append([linha])
    k.column_dimensions['A'].width = 140
    wb.save(caminho)


def pagina(M, lg, logo_uri):
    en = lg == 'en'
    esc = lambda s: str(s).replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
    fmt = lambda v, d: '' if v is None else (v if isinstance(v, str) else nf(v, d, lg))
    corpo = ''.join('<tr' + (' class="ex"' if x['excluido'] else '') + '>' + ''.join(
        f'<td>{esc(fmt(v, d))}</td>' for v, d in zip([data(x['dia'], lg, False)] + linha_tab(x, lg)[1:], [0, 2, 1, 2, 2, 2, 0, 0, 0, 0, 0])) + '</tr>'
        for x in M['linhas'])
    ind = ''.join(f'<li>{esc(l)}</li>' for l in texto_mensal(M, lg).split('\n')[3:] if l and l[0].isdigit())
    tit = 'Daily record' if en else 'Registro diário'
    return f'''<!doctype html><html lang="{lg}"><head><meta charset="utf-8"><title>{tit}</title><style>
@page {{ size: A4 landscape; margin: 12mm 10mm 14mm 10mm; }}
body {{ font-family: Arial, 'Liberation Sans', sans-serif; color: #1F2933; font-size: 10.5px; margin: 0; }}
.cab {{ display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 8px; border-bottom: 2.5px solid #0D47A1; }}
.cab img {{ height: 44px; display: block; margin-bottom: 4px; }} .emp {{ font-size: 15px; font-weight: 700; color: #0D47A1; }}
.cj {{ font-size: 11px; color: #64748B; }} .dir {{ text-align: right; }} .ti {{ font-size: 17px; font-weight: 700; }} .li {{ font-size: 11px; color: #64748B; }}
h2 {{ font-size: 12px; color: #0D47A1; margin: 12px 0 4px; }} ol {{ margin: 0; padding-left: 0; list-style: none; columns: 2; column-gap: 24px; }}
li {{ margin: 0 0 3px; break-inside: avoid; }}
table {{ width: 100%; border-collapse: collapse; margin-top: 4px; }} th {{ background: #E8EEF7; color: #0D47A1; text-align: left; padding: 4px; font-size: 9.5px; }}
td {{ padding: 3px 4px; border-bottom: 1px solid #E3E7ED; font-variant-numeric: tabular-nums; }} td:first-child {{ white-space: nowrap; }} tr.ex td {{ color: #787878; }}
thead {{ display: table-header-group; }} tr {{ break-inside: avoid; }}
.rd {{ margin-top: 10px; border-top: 1px solid #969696; padding-top: 4px; color: #787878; font-size: 9.5px; text-align: center; }}
</style></head><body>
<div class="cab"><div><img src="{logo_uri}" alt=""><div class="emp">Intrepid Participações S.A.</div><div class="cj">Conjunto Fotovoltaico Mauriti</div></div>
<div class="dir"><div class="ti">SIGO · {"Performance" if en else "Desempenho"} · {tit}</div><div class="li">{esc(rot_mes(M["mes"], lg))}</div>
<div class="li">{"Generated by SIGO on" if en else "Gerado no SIGO em"} {esc(data(M["agora"][:10], lg, False))}</div></div></div>
<h2>{"Indicators of the month" if en else "Indicadores do mês"}</h2><ol>{ind}</ol>
<h2>{tit}</h2><table><thead><tr>{"".join(f"<th>{esc(c)}</th>" for c in COL[lg])}</tr></thead><tbody>{corpo}</tbody></table>
<div class="rd">{"Frustrated energy = Σ max(0; ONS reference − generation) × 0.5 h in the half hours with limitation. Grey rows: days excluded from the count." if en else
"Energia frustrada = Σ máx(0; referência do ONS − gerada) × 0,5 h nas meias horas com limitação. Linhas em cinza: dias fora da conta."}</div>
</body></html>'''


def imprime_pdf(html_path, pdf_path):
    import shutil
    import subprocess
    chrome = os.environ.get('CHROME') or shutil.which('google-chrome') or shutil.which('chromium') or r'C:\Program Files\Google\Chrome\Application\chrome.exe'
    url = 'file:///' + os.path.abspath(html_path).replace('\\', '/').lstrip('/')
    r = subprocess.run([chrome, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', f'--print-to-pdf={pdf_path}', url],
                       capture_output=True, timeout=180)
    if not os.path.exists(pdf_path) or os.path.getsize(pdf_path) < 1000:
        raise SystemExit('RECUSADO: o PDF não saiu: ' + r.stderr.decode('utf-8', 'replace')[-400:])


# ── guardas do texto que vai ao grupo ───────────────────────────────────────────────────────────────────────────────────────────
def confere_en(texto):
    """o que o boletim_envio.js barraria, ou cortaria: devolve a lista de defeitos (vazia = pode ir)"""
    erros = []
    if len(texto) > LIMITE_TEXTO:
        erros.append('texto com %d caracteres (limite %d)' % (len(texto), LIMITE_TEXTO))
    m = PORTUGUES.search(texto)
    if m:
        erros.append('português no inglês: %r' % texto[max(0, m.start() - 20):m.end() + 20])
    if PROIBIDO.search(texto):
        erros.append('"ONS apurou 0"')
    return erros


def gera(pasta, modo, ref, agora, saida, boletim_dir):
    os.makedirs(saida, exist_ok=True)
    R = dados_diario(pasta, ref, agora, boletim_dir) if modo == 'diario' else dados_mensal(pasta, ref, agora, boletim_dir)
    tx = {lg: (texto_diario if modo == 'diario' else texto_mensal)(R, lg) for lg in ('en', 'pt')}
    erros = confere_en(tx['en'])
    if erros:
        raise SystemExit('RECUSADO: ' + '; '.join(erros))
    for lg, t in tx.items():
        open(os.path.join(saida, f'texto_{lg}.txt'), 'w', encoding='utf-8').write(t + '\n')
    arquivos = {}
    if modo == 'mensal':
        import base64
        logo = os.path.join(boletim_dir, 'logo_intrepid_800.png')
        uri = 'data:image/png;base64,' + base64.b64encode(open(logo, 'rb').read()).decode() if os.path.exists(logo) else ''
        for lg in ('en', 'pt'):
            base = os.path.join(saida, f'registro_{ref}_{lg}')
            planilha(R, lg, base + '.xlsx')
            open(base + '.html', 'w', encoding='utf-8').write(pagina(R, lg, uri))
            if '--sem-pdf' not in sys.argv:
                imprime_pdf(base + '.html', base + '.pdf')
            arquivos[lg] = [base + '.pdf', base + '.xlsx'] if '--sem-pdf' not in sys.argv else [base + '.xlsx']
    json.dump(R, open(os.path.join(saida, 'resumo.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
    return R, tx, arquivos


def main():
    a = sys.argv[1:]
    if len(a) < 3 or a[1] not in ('diario', 'mensal'):
        raise SystemExit(__doc__)
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a else d
    agora = opt('--agora') or (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).strftime('%Y-%m-%dT%H:%M')
    saida = opt('--saida') or os.path.join(a[0], 'saida', 'desempenho', a[1], a[2])
    boletim_dir = opt('--boletim') or os.environ.get('BOLETIM_SCRIPTS') or AQUI
    R, tx, arqs = gera(a[0], a[1], a[2], agora, saida, boletim_dir)
    print(tx['en'])
    print('\n[%d caracteres; saída em %s; anexos: %s]' % (len(tx['en']), saida, ', '.join(os.path.basename(p) for p in arqs.get('en', [])) or 'nenhum'))


if __name__ == '__main__':
    main()
