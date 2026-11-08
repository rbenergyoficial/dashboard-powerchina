# -*- coding: utf-8 -*-
"""Ensaio da folha das 17:30 "Geração × limite do dia" (lote boletim-1730, 08/11/2026). Separado do ensaio do diário: roda no passo
"Ensaio · folha da tarde" do boletim.yml em TODA execução, de manhã e à tarde (uma regra que nunca gera a folha não fica verde para sempre),
não precisa dos pacotes do render (Pillow, pypdf, imageio-ffmpeg) e não barra o diário: se ele falhar, só as entradas da tarde deixam de
descer, a rodada registra o erro da folha e o diário sai.
Sem rede e sem Chrome. Cada regra tem o caso que ela existe para RECUSAR, e um PLANTIO que tem de reprovar.
    python ensaio_curva1730.py          sai 0 = aprovado; 1 = alguma regra falhou ou algum plantio passou"""
import contextlib
import datetime as dt
import io
import json
import os
import sys
import tempfile
import types

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from ensaio_boletim import carrega, recusa, passadas_brt, executivo  # noqa: E402

FONTE = io.open(os.path.join(AQUI, 'fila.py'), encoding='utf-8').read()
CURVA = io.open(os.path.join(AQUI, 'curva1730.py'), encoding='utf-8').read()
RODADA = io.open(os.path.join(AQUI, 'rodada.py'), encoding='utf-8').read()
WF = os.path.join(AQUI, '..', '..', '.github', 'workflows', 'boletim.yml')
WF_TEXTO = None   # o plantio do cron troca o texto do workflow (None = o arquivo)


def casos_fila(F):
    """as regras da fila para a folha: a janela, uma vez por dia, o texto ao grupo e o cron da tarde"""
    falhas = []
    ok = lambda c, msg: falhas.append(msg) if not c else None
    h = lambda s: dt.datetime.fromisoformat(s)
    est = {'feitos': [], 'desde': '2026-11-06'}
    ok(F.tarefa_curva(h('2026-11-08T17:29'), est) == [], 'antes das 17:30 a folha da tarde não sai')
    ok(F.tarefa_curva(h('2026-11-08T17:31'), est) == [('curva', '2026-11-08')], 'às 17:31 sai a folha do dia corrente')
    ok(F.tarefa_curva(h('2026-11-08T20:01'), est) == [], 'depois das 20:00 a folha do dia não sai mais (nunca vai ao grupo no dia seguinte)')
    ok(F.tarefa_curva(h('2026-11-08T08:05'), est) == [], 'de manhã não sai a folha de ontem')
    ok(F.tarefa_curva(h('2026-11-08T18:00'), {'feitos': ['curva:2026-11-08'], 'desde': '2026-11-06'}) == [], 'a folha da tarde sai uma vez por dia')
    ok(F.tarefa_curva(h('2026-11-08T18:00'), {'feitos': [], 'desde': '2026-11-09'}) == [], 'nada antes da semeadura')
    rc = {'dia': '2026-11-08', 'medicao_ate': '17:30', 'energia_mwh': 2335.58, 'pico_mw': 296.2, 'n_ordens': 0, 'herdada': False,
          'horas_sob_limite': 0.0, 'limite_min_mw': None, 'motivos': [], 'coletor': 'ok'}
    tc = F.texto_curva_en(rc)
    ok('No ONS curtailment order recorded in the day to 17:30' in tc and '2,335.58 MWh' in tc and not recusa(F.sem_portugues, tc),
       'dia sem ordem: o texto diz que não houve ordem (nunca um limite inventado), em inglês, MWh com 2 casas')
    ok('collector is stopped' in F.texto_curva_en(dict(rc, coletor='parado')), 'coletor das ordens parado: o texto avisa que o limite pode estar incompleto')
    # RW-401 (c): os motivos do Gestão em inglês; o desconhecido sai neutro, nunca cru nem em português
    tm = F.texto_curva_en(dict(rc, n_ordens=3, primeira='08:00', ultima='09:00', horas_sob_limite=1.0, limite_min_mw=100,
                               motivos=['FLUXO', 'ELE_SGI', 'DESPACHO_ÚNICO', 'de']))
    ok('flow or interchange' in tm and 'contingency, SGI or unavailability' in tm and 'other reason' in tm and not recusa(F.sem_portugues, tm),
       'os motivos em inglês, o desconhecido "other reason", sem português: %s' % tm.splitlines()[2:3])
    # RW-501: o documento ruim do catálogo não barra os outros
    fr = []
    its = F.itens_rd(catalogo_rd(), dt.date(2026, 11, 8), {'feitos': []}, fr)
    ok([i['codigo'] for i in its] == ['RD-MRT-2026-da', 'RD-MRT-2026-0101'] and sorted(x['codigo'] for x in fr) == ['?', 'RD-MRT-2026-0103'],
       'o documento ruim do catálogo vai para as falhas e os outros seguem (itens %s, falhas %s)' % ([i['codigo'] for i in its], fr))
    # RW-503: o arquivo do ONS ilegível não derruba quem chama e entra nas falhas
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, 'ons_restricao_2026_10.json'), 'w', encoding='utf-8').write('{"consolidado": [{"ts": "2026-10-31T12:00"}]}')
        open(os.path.join(d, 'ons_restricao_2026_11.json'), 'w', encoding='utf-8').write('{quebrado')
        fo = []
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                dias, dias0 = F.ons_dias(d, fo), F.ons_dias(d)
        except Exception as e:   # noqa: BLE001
            dias, dias0 = 'estourou: %s' % e, None
        ok(dias == {'2026-10-31'} and dias0 == {'2026-10-31'} and fo == ['ons_restricao_2026_11.json'],
           'o arquivo do ONS ilegível vira falha registrada e os outros seguem, sem derrubar a decisão (%s, %s)' % (dias, fo))
    # o cron da tarde cobre HORA_CURVA: primeira passada até 10 min depois, passadas por 80 min ou mais, antes do fim
    wf = WF_TEXTO if WF_TEXTO is not None else (io.open(WF, encoding='utf-8').read() if os.path.exists(WF) else None)
    if wf is not None:
        ps = passadas_brt(wf)
        hc, hf = (int(F.HORA_CURVA[:2]) * 60 + int(F.HORA_CURVA[3:]), int(F.HORA_CURVA_FIM[:2]) * 60 + int(F.HORA_CURVA_FIM[3:]))
        pt = [p for p in ps if hc <= p < hf]
        ok(pt and pt[0] <= hc + 10 and max(pt) >= hc + 80,
           'a janela do cron cobre a folha das %s (passadas da tarde: %s)' % (F.HORA_CURVA, ' '.join('%02d:%02d' % divmod(p, 60) for p in pt)))
    return falhas


def dados_curva(dia='2026-11-08'):
    """a medição de 5 min (kW) e as ordens da Iqony forjadas: trafos a 100 MW cada das 06:00 às 17:30, o 6197 sem leitura às 12:00;
    véspera terminando sob 150 MW (herdada), 08:00 120 MW corrigida pela mesa para 110, 09:00 em conflito (fora do RDO), 10:00 fim"""
    vals = lambda pid: [({'data': f'{dia}T{m // 60:02d}:{m % 60:02d}:00', 'qualidade': 1} if (pid == 6197 and m == 720) else
                         {'data': f'{dia}T{m // 60:02d}:{m % 60:02d}:00', 'valor': 100000.0, 'qualidade': 0}) for m in range(360, 1051, 5)]
    w2 = {'dados': [{'nomeGrandeza': 'Demat', 'pontoId': p, 'valores': vals(p)} for p in (6196, 6197)]}
    camp = ['dia', 'h', 'tipo', 'mw', 'raz', 'mot', 'origem_ons', 'destino', 'conf', 'corr']
    iq = {'versao': 1, 'campos': camp, 'coletor': {'estado': 'ok'}, 'eventos': [
        ['2026-11-07', '14:00', 'limite', 150, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', None, None],
        [dia, '08:00', 'limite', 120, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', 1, {'h': '08:00', 'mw': 110, 'raz': 'ENE', 'mot': 'ENE_FREQ', 'tipo': 'alt'}],
        [dia, '09:00', 'limite', 90, 'ENE', 'ENE_FREQ', 'COSR-NE', 'conflito', None, None],
        [dia, '10:00', 'fim', 343.77, None, None, 'COSR-NE', 'rdo', None, None]]}
    return w2, iq


def catalogo_rd():
    """o mês fechado (outubro) com um RD bom, um com texto que a guarda recusa, um sem o blob do PDF e uma entrada que nem é documento"""
    pdfs = [{'idioma': 'pt', 'blob': 'acervo/pdf/a.pdf'}, {'idioma': 'en', 'blob': 'acervo/pdf/a_EN.pdf'}]
    doc = lambda c, p=pdfs: {'codigo': c, 'tipo': 'RD', 'emissao': 'AP', 'revisao': '00', 'titulo': 'Desempenho Operacional de outubro de 2026', 'pdfs': p}
    return {'documentos': ['nem documento é', doc('RD-MRT-2026-da'), doc('RD-MRT-2026-0103', [{'idioma': 'pt'}, {'idioma': 'en'}]), doc('RD-MRT-2026-0101')]}


def casos_curva(CV):
    """a conta da folha das 17:30 (curva1730.py) com dado forjado; devolve as falhas"""
    falhas = []
    ok = lambda c, m: falhas.append(m) if not c else None
    w2, iq = dados_curva()
    r = CV.calcula(w2, iq, '2026-11-08', '17:30')
    L = dict(zip(CV.SLOTS, r['limite']))
    ok(L['07:00'] == 150 and r['herdada'], 'a ordem da véspera sem fim vale desde o início do dia (herdada)')
    ok(L['08:30'] == 110, 'vale a correção da mesa na ordem conferida (110 MW, não 120)')
    ok(L['09:30'] == 110, 'o evento em conflito (fora do RDO) não entra no degrau')
    ok(L['10:30'] is None, 'o fim da restrição libera')
    ok(r['n_ordens'] == 1 and r['limite_min_mw'] == 110 and r['primeira'] == '08:00' and r['ultima'] == '10:00',
       'ordens do dia: 1 nova, mínima 110 MW, entre 08:00 e 10:00 (%s)' % {k: r[k] for k in ('n_ordens', 'limite_min_mw', 'primeira', 'ultima')})
    ok(r['horas_sob_limite'] == 5.0, 'tempo sob limite de 05:00 a 10:00 = 5,0 h (%s)' % r['horas_sob_limite'])
    r9 = CV.calcula(w2, iq, '2026-11-08', '09:00')
    ok(r9['horas_sob_limite'] == 4.1 and r9['ultima'] == '08:00', 'a folha das 09:00 conta só até a medição: 05:00 a 09:00 = 4,1 h, última ordem 08:00 (%s, %s)'
       % (r9['horas_sob_limite'], r9['ultima']))
    g = dict(zip(CV.SLOTS, r['serie']))
    ok(g['12:00'] is None and g['12:05'] == 200.0, 'o instante sem leitura de um trafo fica vazio, nunca zero nem meio')
    ok(r['energia_mwh'] == 2300.0, 'energia = soma dos instantes completos × 5 min = 2.300,00 MWh (%s)' % r['energia_mwh'])
    ok(r['medicao_ate'] == '17:30' and CV.calcula(w2, iq, '2026-11-08', '12:02')['medicao_ate'] == '11:55',
       'a medição vai até o último instante completo antes da hora da folha')
    sem = CV.calcula(w2, dict(iq, eventos=[]), '2026-11-08', '17:30')
    ok(sem['n_ordens'] == 0 and not sem['herdada'] and all(v is None for v in sem['limite']), 'dia sem ordem: nenhum limite desenhado')
    t = CV.html(sem, 'claro', 'en', '', {'pt': 'x', 'en': 'x'})
    ok('No ONS curtailment order recorded in the day to 17:30' in t, 'dia sem ordem: a folha diz que não houve ordem')
    t = CV.html(r, 'claro', 'en', '', {'pt': 'x', 'en': 'x'})
    import fila
    vis = CV.visivel(t).replace('Participações', '').replace('Intrepid', '')
    m = fila.PT_RESTO.search(vis)
    ok(not m, 'a folha em inglês sem português: %s' % (m.group(0) if m else ''))
    # RW-401 (c): na folha em inglês, o motivo e a razão desconhecidos saem neutros (sem português)
    t2 = CV.html(dict(r, motivos=['FLUXO', 'DESPACHO_ÚNICO'], razoes=['ENE', 'ção']), 'claro', 'en', '', {'pt': 'x', 'en': 'x'})
    v2 = CV.visivel(t2).replace('Participações', '').replace('Intrepid', '')
    m2 = fila.PT_RESTO.search(v2)
    ok(not m2 and 'flow or interchange' in t2.lower() and 'other reason' in t2.lower(),'motivo e razão desconhecidos na folha EN saem neutros: %s' % (m2.group(0) if m2 else ''))
    ok(recusa(CV.calcula, {'dados': []}, iq, '2026-11-08', '17:30'), 'sem medição do conjunto a folha não sai')
    ok(recusa(CV.ordens, dict(iq, campos=['x']), '2026-11-08'), 'ordens com campos fora da forma param')
    # a paleta é a do boletim aprovado (claro vivo, escuro profundo): nenhum hex inventado
    ap = io.open(os.path.join(AQUI, 'boletim_aprovado.py'), encoding='utf-8').read()
    hexes = {v for tema in CV.PALETA.values() for k, v in tema.items() if k != 'COR'} | {c for tema in CV.PALETA.values() for c in tema['COR'].values()}
    fora = sorted(x for x in hexes if x not in ap)
    ok(not fora, 'a paleta da folha é a do boletim aprovado (fora: %s)' % fora)
    return falhas


ENVIADOS_VISTOS = []   # o que a última rodada deixou em saida/boletim/enviados/ (RW-302)


def roda(R, arqs, agora, env=None, gera=None, troca=None, troca_r=None, extra=None):
    """uma rodada num diretório forjado; devolve (rc, fila, estado). `troca` = {nome: função} trocada na fila (F) e `troca_r` no próprio
    rodada.py, só durante a rodada; o que ficou em enviados/ vai para ENVIADOS_VISTOS"""
    troca_r = troca_r or {}
    with tempfile.TemporaryDirectory() as d:
        for k, v in arqs.items():
            if isinstance(v, bytes):   # o arquivo cru: quebrado, ou com BOM
                open(os.path.join(d, k), 'wb').write(v)
            else:
                json.dump(v, open(os.path.join(d, k), 'w', encoding='utf-8'))
        R.DIR, R.SAI = d, os.path.join(d, 'saida', 'boletim')
        argv0, gera0, rc = sys.argv, R.gera, 0
        env0 = {k: os.environ.get(k) for k in ('BOLETIM_AGORA', 'TARDE_OK', 'PESADO_OK')}
        sys.argv = ['rodada.py', '--agora', agora, '--sem-render'] + (extra or [])
        for k in env0:
            os.environ.pop(k, None)
        os.environ.update(env or {})
        if gera:
            R.gera = gera
        troca0 = {k: getattr(R.F, k) for k in (troca or {})}
        for k, f in (troca or {}).items():
            setattr(R.F, k, f)
        trocar0 = {k: getattr(R, k) for k in troca_r}
        for k, f in troca_r.items():
            setattr(R, k, f)
        getattr(R, 'ENVIADOS', {}).clear()
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                R.main()
        except SystemExit as e:
            rc = e.code or 0
        except Exception as e:   # noqa: BLE001
            rc = 'estourou: %s' % e
        finally:
            sys.argv, R.gera = argv0, gera0
            for k, f in troca0.items():
                setattr(R.F, k, f)
            for k, f in trocar0.items():
                setattr(R, k, f)
            for k, v in env0.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        le = lambda n, p: json.load(open(os.path.join(d, 'saida', 'boletim', n), encoding='utf-8')) if os.path.exists(os.path.join(d, 'saida', 'boletim', n)) else p
        env_dir = os.path.join(d, 'saida', 'boletim', 'enviados')
        ENVIADOS_VISTOS[:] = sorted(os.path.relpath(os.path.join(r, f), env_dir).replace('\\', '/') for r, _, fs in os.walk(env_dir) for f in fs)
        return rc, le('fila.json', {'itens': []}), le('estado.json', None)


def ensaio_rodada_1730(R=None):
    """a rodada da tarde (RW-001): a folha é adicional. Com as ordens, entra na fila e vira feita; sem elas (ou com o passo da tarde que
    falhou), vai para `erros`, não vira feita, a fila e o estado são gravados e a rodada sai 1 só no fim; o diário recuperado na mesma
    rodada sai mesmo assim"""
    R = R or __import__('rodada')
    falhas = []
    ok = lambda c, m: falhas.append(m) if not c else None
    w2, iq = dados_curva()
    est = {'esquema': 1, 'feitos': ['diario:2026-11-06', 'diario:2026-11-07'], 'semeado': '2026-11-06T20:00', 'desde': '2026-11-06'}
    base = {'boletim__estado.json': est, 'boletim__fila.json': {'itens': []}, 'way2_recent.json': w2}
    ids = lambda f: [i['id'] for i in f['itens']]
    curva_erro = lambda e: e and any(x.get('id') == 'curva-2026-11-08' for x in e.get('erros', [])) and 'curva:2026-11-08' not in e.get('feitos', [])
    # com as ordens
    rc, fl, e = roda(R, dict(base, **{'gestao__restricao_iqony.json': iq}), '2026-11-08T17:35')
    it = [i for i in fl['itens'] if i['id'] == 'curva-2026-11-08']
    ok(it and '2,300.00 MWh' in it[0]['texto'] and e and 'curva:2026-11-08' in e['feitos'] and rc == 0,
       'rodada da tarde: a folha entra na fila com o texto em inglês e vira feita (rc %r, itens %s)' % (rc, ids(fl)))
    # sem as ordens: erro registrado, estado gravado, sai 1 no fim
    rc, fl, e = roda(R, base, '2026-11-08T17:35')
    ok('curva-2026-11-08' not in ids(fl) and curva_erro(e) and rc == 1,
       'rodada da tarde sem as ordens da Iqony: sem folha, sem feito, erro no estado e saída 1 no fim (rc %r)' % (rc,))
    # o passo "Entradas da tarde" falhou (TARDE_OK) mesmo com arquivos na pasta: a folha não sai
    rc, fl, e = roda(R, dict(base, **{'gestao__restricao_iqony.json': iq}), '2026-11-08T17:35', env={'TARDE_OK': 'failure'})
    ok('curva-2026-11-08' not in ids(fl) and curva_erro(e) and rc == 1,
       'o passo das entradas da tarde falhou: a folha não sai e o erro fica no estado (rc %r)' % (rc,))
    # a curva falha e o diário recuperado na mesma rodada sai mesmo assim
    est2 = dict(est, feitos=['diario:2026-11-06'])
    gera = lambda modo, dia, render: ({'dia': dia, 'liq': 3000.0, 'meta_dia': 2000.0, 'limitado': {'h': 0, 'est': None}, 'pr': 80.0, 'disp': 99.0,
                                       'complexo': {'pct': 20.0, 'proj_pct': 100}, 'ppa': {'pct': 20.0, 'proj_pct': 100}}, {}, [], 'boletim/diario/' + dia)
    rc, fl, e = roda(R, dict(base, **{'boletim__estado.json': est2, 'executivo.json': executivo()}), '2026-11-08T17:35', gera=gera)
    ok('diario-2026-11-07' in ids(fl) and e and 'diario:2026-11-07' in e['feitos'] and curva_erro(e) and rc == 1,
       'a folha falha e o diário recuperado na mesma rodada sai mesmo assim (rc %r, itens %s)' % (rc, ids(fl)))
    # RW-102: as entradas pesadas falham (PESADO_OK) com o diário pendente; a folha sai mesmo assim, o diário vai para `erros` sem virar
    # feito (a rodada seguinte tenta de novo) e a rodada sai 1 no fim
    # (com o executivo na pasta e um gera que funciona: só o PESADO_OK diz que o passo falhou e a entrada pode estar velha ou parcial)
    rc, fl, e = roda(R, dict(base, **{'boletim__estado.json': est2, 'gestao__restricao_iqony.json': iq, 'executivo.json': executivo()}),
                     '2026-11-08T17:35', env={'PESADO_OK': 'failure'}, gera=gera)
    diario_erro = e and any(x.get('id') == 'diario-2026-11-07' for x in e.get('erros', [])) and 'diario:2026-11-07' not in e.get('feitos', [])
    ok('curva-2026-11-08' in ids(fl) and e and 'curva:2026-11-08' in e['feitos'] and diario_erro and 'diario-2026-11-07' not in ids(fl) and rc == 1,
       'as entradas pesadas falham e a folha sai mesmo assim; o diário fica no erro, sem feito, saída 1 no fim (rc %r, itens %s)' % (rc, ids(fl)))
    # RW-201: o pós-gera do diário estoura (o fato relevante; o texto ao grupo) com a folha pendente: a folha sai e vira feita, o diário fica
    # em `erros` sem virar feito e sem item na fila, e a rodada sai 1 no fim, depois de gravar
    def estoura(*a, **k):
        raise ValueError('pós-gera de mentira')
    for onde in ('fatos', 'texto_en'):
        rc, fl, e = roda(R, dict(base, **{'boletim__estado.json': est2, 'gestao__restricao_iqony.json': iq, 'executivo.json': executivo()}),
                         '2026-11-08T17:35', gera=gera, troca={onde: estoura})
        diario_erro = e and any(x.get('id') == 'diario-2026-11-07' for x in e.get('erros', [])) and 'diario:2026-11-07' not in e.get('feitos', [])
        ok('curva-2026-11-08' in ids(fl) and e and 'curva:2026-11-08' in e['feitos'] and diario_erro and 'diario-2026-11-07' not in ids(fl) and rc == 1,
           'o %s do diário estoura com a folha pendente: a folha sai e vira feita, o diário fica em erros, rc 1 (rc %r, itens %s, estado %s)'
           % ('fato' if onde == 'fatos' else 'texto', rc, ids(fl), 'gravado' if e else 'NÃO gravado'))
    # RW-301: o pós-gera da FOLHA estoura (o texto ao grupo; o resumo sem 'medicao_ate') com o diário pendente: o diário sai e vira feito, a
    # folha fica em `erros` sem feito e sem item, rc 1 e estado gravado
    gc0 = R.gera_curva
    sem_ate = lambda *a, **k: (lambda r: ({k_: v for k_, v in r[0].items() if k_ != 'medicao_ate'},) + tuple(r[1:]))(gc0(*a, **k))
    for rot, kw in (('o texto da folha estoura', {'troca': {'texto_curva_en': estoura}}), ('o resumo da folha sem a medição', {'troca_r': {'gera_curva': sem_ate}})):
        rc, fl, e = roda(R, dict(base, **{'boletim__estado.json': est2, 'gestao__restricao_iqony.json': iq, 'executivo.json': executivo()}),
                         '2026-11-08T17:35', gera=gera, **kw)
        ok('diario-2026-11-07' in ids(fl) and e and 'diario:2026-11-07' in e['feitos'] and curva_erro(e) and 'curva-2026-11-08' not in ids(fl) and rc == 1,
           '%s com o diário pendente: o diário sai e vira feito, a folha fica em erros, rc 1, estado gravado (rc %r, itens %s, estado %s)'
           % (rot, rc, ids(fl), 'gravado' if e else 'NÃO gravado'))
    # RW-302: enviados/ guarda o que FOI ao grupo. O gera só registra a cópia; item que falha depois do render não deixa nada lá
    def gera_env(modo, dia, render):
        src = os.path.join(R.SAI, '_render', f'{modo}_{dia}.png')
        os.makedirs(os.path.dirname(src), exist_ok=True)
        open(src, 'wb').write(b'png')
        R.a_enviar(f'{modo}-{dia}', src, os.path.join(R.SAI, 'enviados', '2026-11-08', 'EN', f'{modo}_{dia}_en.png'))
        return gera(modo, dia, render)

    def curva_env(dia, *a, **k):
        r = gc0(dia, *a, **k)
        src = os.path.join(R.SAI, '_render', f'curva_{dia}.png')
        os.makedirs(os.path.dirname(src), exist_ok=True)
        open(src, 'wb').write(b'png')
        R.a_enviar('curva-' + dia, src, os.path.join(R.SAI, 'enviados', '2026-11-08', 'EN', f'curva1730_{dia}_en.png'))
        return r
    arq = dict(base, **{'boletim__estado.json': est2, 'gestao__restricao_iqony.json': iq, 'executivo.json': executivo()})
    roda(R, arq, '2026-11-08T17:35', gera=gera_env, troca_r={'gera_curva': curva_env})
    ok(ENVIADOS_VISTOS == ['2026-11-08/EN/curva1730_2026-11-08_en.png', '2026-11-08/EN/diario_2026-11-07_en.png'],
       'os dois itens foram ao grupo: os dois arquivos em enviados/ (%s)' % ENVIADOS_VISTOS)
    roda(R, arq, '2026-11-08T17:35', gera=gera_env, troca_r={'gera_curva': curva_env}, troca={'fatos': estoura, 'texto_curva_en': estoura})
    ok(ENVIADOS_VISTOS == [], 'o diário e a folha falham depois do render: nada em enviados/ (%s)' % ENVIADOS_VISTOS)
    # RW-401 (d): o texto da FOLHA vem com português (sem estourar): a guarda recusa DENTRO do try da folha. O diário sai e vira feito, a folha
    # fica em erros sem feito e sem item, rc 1, estado gravado, e enviados/ só com o diário. E o espelho: o texto do DIÁRIO com português
    for rot, troca_f, fica, cai in (
            ('o texto da folha com português', {'texto_curva_en': lambda r: 'Generation da tarde'}, 'diario-2026-11-07', 'curva-2026-11-08'),
            ('o texto do diário com português', {'texto_en': lambda modo, r: 'Daily geração'}, 'curva-2026-11-08', 'diario-2026-11-07')):
        rc, fl, e = roda(R, arq, '2026-11-08T17:35', gera=gera_env, troca_r={'gera_curva': curva_env}, troca=troca_f)
        fica_f, cai_f = fica.replace('-', ':', 1), cai.replace('-', ':', 1)
        env_ok = ['2026-11-08/EN/diario_2026-11-07_en.png'] if fica.startswith('diario') else ['2026-11-08/EN/curva1730_2026-11-08_en.png']
        ok(fica in ids(fl) and e and fica_f in e['feitos'] and any(x.get('id') == cai for x in e.get('erros', [])) and cai_f not in e['feitos']
           and cai not in ids(fl) and rc == 1 and ENVIADOS_VISTOS == env_ok,
           '%s: o outro sai e vira feito, este fica em erros, rc 1, estado gravado, enviados/ só com o que foi (rc %r, itens %s, estado %s, enviados %s)'
           % (rot, rc, ids(fl), 'gravado' if e else 'NÃO gravado', ENVIADOS_VISTOS))
    # RW-402: a cópia para enviados/ falha: os itens continuam na fila (vão ao grupo), mas é erro (enviados-<id>) e o rc é 1
    def copia_falha(iid):
        raise OSError('disco de mentira')
    rc, fl, e = roda(R, arq, '2026-11-08T17:35', gera=gera_env, troca_r={'gera_curva': curva_env, 'copia_enviados': copia_falha})
    erros_env = sorted(x['id'] for x in (e or {}).get('erros', []) if x.get('id', '').startswith('enviados-'))
    ok('diario-2026-11-07' in ids(fl) and 'curva-2026-11-08' in ids(fl) and erros_env == ['enviados-curva-2026-11-08', 'enviados-diario-2026-11-07'] and rc == 1,
       'a cópia para enviados/ falha: os itens ficam na fila, o erro vai para o estado e o rc é 1 (rc %r, itens %s, erros %s)' % (rc, ids(fl), erros_env))
    # RW-401 (b): a fila que não grava não deixa nada em enviados/ (a cópia vem depois da fila gravada)
    g0 = R.grava

    def grava_falha(rel, obj):
        if rel == 'fila.json':
            raise OSError('fila de mentira')
        return g0(rel, obj)
    rc, fl, e = roda(R, arq, '2026-11-08T17:35', gera=gera_env, troca_r={'gera_curva': curva_env, 'grava': grava_falha})
    ok(ENVIADOS_VISTOS == [], 'a fila não foi gravada: nada em enviados/ (rc %r, enviados %s)' % (rc, ENVIADOS_VISTOS))
    # RW-504: o catálogo com RD recusado, documento quebrado e entrada que nem é documento: a folha e o RD bom saem, os ruins ficam em erros, rc 1
    com_iq = dict(base, **{'gestao__restricao_iqony.json': iq})
    rc, fl, e = roda(R, dict(com_iq, **{'acervo__catalogo.json': catalogo_rd()}), '2026-11-08T17:35')
    ids_e = sorted(x['id'] for x in (e or {}).get('erros', []))
    ok('curva-2026-11-08' in ids(fl) and 'rd-RD-MRT-2026-0101' in ids(fl) and e and 'rd:RD-MRT-2026-0101' in e['feitos'] and 'rd:RD-MRT-2026-da' not in e['feitos']
       and ids_e == ['rd-?', 'rd-RD-MRT-2026-0103', 'rd-RD-MRT-2026-da'] and rc == 1,
       'RD recusado e documento quebrado: a folha e o RD bom saem, os ruins ficam em erros, rc 1 (rc %r, itens %s, erros %s)' % (rc, ids(fl), ids_e))
    # RW-501: o catálogo ilegível: nenhum RD nesta rodada, a folha sai, rc 1
    rc, fl, e = roda(R, dict(com_iq, **{'acervo__catalogo.json': b'{quebrado'}), '2026-11-08T17:35')
    ok('curva-2026-11-08' in ids(fl) and e and any(x.get('id') == 'rd-catalogo' for x in e.get('erros', [])) and rc == 1,
       'o catálogo ilegível: a folha sai, o erro fica no estado, rc 1 (rc %r, itens %s, estado %s)' % (rc, ids(fl), 'gravado' if e else 'NÃO gravado'))
    # RW-503: o arquivo do ONS ilegível recai no diário; a folha segue, e a decisão não cai
    rc, fl, e = roda(R, dict(arq, **{'ons_restricao_2026_11.json': b'{quebrado'}), '2026-11-08T17:35', gera=gera)
    ok('curva-2026-11-08' in ids(fl) and e and 'curva:2026-11-08' in e['feitos'] and any(x.get('id') == 'diario-2026-11-07' for x in e.get('erros', []))
       and 'diario-2026-11-07' not in ids(fl) and rc == 1,
       'o arquivo do ONS ilegível: a folha sai e vira feita, o diário fica em erros, rc 1 (rc %r, itens %s)' % (rc, ids(fl)))
    rc, fl, e = roda(R, dict(arq, **{'ons_restricao_2026_11.json': b'{quebrado'}), '2026-11-08T17:35', extra=['--precisa'])
    ok(rc == 0, 'o arquivo do ONS ilegível não derruba a decisão (rc %r)' % (rc,))
    # RW-502: a medição de 30 min ilegível fica nas curvas da página: a folha sai, estado gravado, rc 1
    rc, fl, e = roda(R, dict(com_iq, **{'way2_30min.json': b'{quebrado'}), '2026-11-08T17:35')
    ok('curva-2026-11-08' in ids(fl) and e and 'curva:2026-11-08' in e['feitos'] and rc == 1,
       'a medição de 30 min ilegível: a folha sai, estado gravado, rc 1 (rc %r, itens %s, estado %s)' % (rc, ids(fl), 'gravado' if e else 'NÃO gravado'))
    # RW-502: o total da vida fora da forma: fica o último conhecido
    rc, fl, e = roda(R, dict(com_iq, **{'boletim__estado.json': dict(est, ultimo_total_gwh=12.3), 'executivo.json': {'totais_vida': 'x'}}), '2026-11-08T17:35')
    ok(rc == 0 and e and e.get('ultimo_total_gwh') == 12.3 and 'curva-2026-11-08' in ids(fl),
       'o total da vida fora da forma: fica o último conhecido, a rodada segue (rc %r, total %s)' % (rc, (e or {}).get('ultimo_total_gwh')))
    # RW-502: o le() lê com ou sem BOM
    rc, fl, e = roda(R, dict(com_iq, **{'boletim__estado.json': b'\xef\xbb\xbf' + json.dumps(est).encode('utf-8')}), '2026-11-08T17:35')
    ok(rc == 0 and 'curva-2026-11-08' in ids(fl), 'o estado com BOM é lido (rc %r)' % (rc,))
    # RW-505: o diário leva o dia no nome em enviados/ (dois diários na mesma rodada não se sobrescrevem; o render não roda aqui: conferido na fonte)
    fonte0 = getattr(R, '__fonte__', None) or RODADA
    ok("base_env = f'diario_{dia}_claro'" in fonte0, 'o diário leva o dia no nome em enviados/')
    # e no código: o gera e o gera_curva só REGISTRAM a cópia (o render de verdade não roda no ensaio)
    fonte = getattr(R, '__fonte__', None) or RODADA
    for nome in ('gera', 'gera_curva'):
        i = fonte.find('\ndef %s(' % nome)
        s = fonte[i:fonte.find('\ndef ', i + 1)] if i >= 0 else ''
        ok("a_enviar(" in s and 'copyfile(p, os.path.join(dst' not in s and "'enviados'" in s,
           'o %s registra a cópia para enviados/ (a_enviar) e não copia direto' % nome)
    return falhas


PLANTIOS_FILA = [
    ('o documento ruim barra os outros', "    if falhas is None:\n        raise e\n", "    raise e\n"),
    ('o ONS ruim derruba quem chama', "                print('::warning::arquivo do ONS ilegível, %s: %s' % (f, (str(e) or type(e).__name__)[:200]))\n", "                raise\n"),
    ('o motivo desconhecido sai cru no texto', "    return 'other reason (%s)' % c if c and not PT_RESTO.search(c) else 'other reason'", "    return str(m)"),
    ('a folha nunca sai', "    return [('curva', hoje)]", "    return []"),
    ('a folha da tarde sai antes das 17:30', "BOLETIM_HORA_CURVA') or '17:30'", "BOLETIM_HORA_CURVA') or '17:00'"),
    ('a folha da tarde se repete', " or 'curva:' + hoje in set(estado.get('feitos', [])):", ":"),
    ('a folha de ontem vai no dia seguinte', "if not (HORA_CURVA <= hm < HORA_CURVA_FIM)", "if not (HORA_CURVA <= hm or hm < HORA_CURVA_FIM)"),
    ('o dia sem ordem não diz', "        linhas.append(f'No ONS curtailment order recorded in the day to {r[\"medicao_ate\"]}.')\n", "        pass\n"),
]

PLANTIOS_WF = [
    ('a tarde com uma passada só', "    - cron: '7,37 21 * * *'    # 18:07 e 18:37\n    - cron: '7 22 * * *'       # 19:07\n", ''),
]

PLANTIOS_CURVA = [
    ('o motivo desconhecido sai cru na folha', "    nome = ' · '.join(MOTIVO[m][i] if m in MOTIVO else outro(m) for m in r['motivos'])",
     "    nome = ' · '.join(MOTIVO[m][i] if m in MOTIVO else str(m) for m in r['motivos'])"),
    ('o ponto sem leitura vira zero', "    return None if any(x is None for x in v) else sum(v)", "    return sum(x or 0 for x in v)"),
    ('a correção da mesa é ignorada', "c = d.get('corr') if d.get('conf') == 1 else None", "c = None"),
    ('a ordem da véspera some', "    if antes and antes[-1]['tipo'] == 'limite':", "    if False:"),
    ('o evento em conflito entra', "if d['destino'] != 'rdo' or d['dia'] > dia:", "if d['dia'] > dia:"),
    ('a folha conta as horas depois da medição', "L = [limite_em(ords, minuto(h)) if minuto(h) <= minuto(ate_med) else None for h in SLOTS]", "L = [limite_em(ords, minuto(h)) for h in SLOTS]"),
    ('a paleta inventa um hex', "GER='#BF7E04', CORTE='#A79BE8', FUNDO='#F3F4F6'", "GER='#C08010', CORTE='#A79BE8', FUNDO='#F3F4F6'"),
]

PLANTIOS_RODADA = [
    ('a recusa do RD sai verde', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados:", "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_enviados:"),
    ('a recusa do RD derruba a rodada', "            F.valida_item(item)   # RW-401: a recusa é erro deste RD, não da rodada\n        except (Exception, SystemExit) as e:   # noqa: BLE001\n",
     "            F.valida_item(item)   # RW-401: a recusa é erro deste RD, não da rodada\n        except ZeroDivisionError as e:   # noqa: BLE001\n"),
    ('o catálogo ilegível derruba a rodada', "    except (Exception, SystemExit) as e:   # noqa: BLE001  (o catálogo ilegível: nenhum RD nesta rodada, a rodada segue)", "    except ZeroDivisionError as e:   # noqa: BLE001"),
    ('o ONS ruim não recai no diário', "            if ons_ruins:\n                raise RuntimeError('arquivo do ONS ilegível: ' + ', '.join(sorted(ons_ruins)))\n", ""),
    ('a leitura da medição fica fora do try', "    try:\n        w2 = le('way2_30min.json')\n        if w2 is not None:", "    w2 = le('way2_30min.json')\n    try:\n        if w2 is not None:"),
    ('o total da vida fora do try', "    except Exception:   # noqa: BLE001  (executivo fora da forma: fica o último total conhecido)", "    except ZeroDivisionError:   # noqa: BLE001"),
    ('o le volta a tropeçar no BOM', "encoding='utf-8-sig')) if os.path.exists(p)", "encoding='utf-8')) if os.path.exists(p)"),
    ('dois diários se sobrescrevem em enviados/', "base_env = f'diario_{dia}_claro' if modo", "base_env = 'diario_claro' if modo"),
    ('pesadas falham e a folha sai mesmo assim', "        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do gera também)",
     "        except ZeroDivisionError as e:   # noqa: BLE001"),
    ('o texto da folha fica fora do try', [
        ("                novos_i.append({'id': iid, 'tipo': 'curva', 'dia': dia, 'texto': F.texto_curva_en(resumo),",
         "                novos_i.append({'id': iid, 'tipo': 'curva', 'dia': dia, 'texto': None,"),
        ("        indice.setdefault('curva', {})[dia] = ind_i\n",
         "        indice.setdefault('curva', {})[dia] = ind_i\n        for n_ in novos_i:\n            n_['texto'] = F.texto_curva_en(resumo)\n")], None),
    ('o pós-gera da folha fica sem proteção', "        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do curva1730 também)",
     "        except (RuntimeError, SystemExit) as e:   # noqa: BLE001"),
    ('a cópia para enviados/ sai antes do item entrar', "def a_enviar(iid, origem, destino):\n    ENVIADOS.setdefault(iid, []).append((origem, destino))",
     "def a_enviar(iid, origem, destino):\n    os.makedirs(os.path.dirname(destino), exist_ok=True)\n    shutil.copyfile(origem, destino)"),
    ('o gera volta a copiar direto para enviados/', "                a_enviar(f'{modo}-{dia}', p, os.path.join(dst, n))   # RW-302: copiado só se o item entrar em novos",
     "                os.makedirs(dst, exist_ok=True); shutil.copyfile(p, os.path.join(dst, n))"),
    ('o pós-gera do diário fica sem proteção', "        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do gera também)",
     "        except (RuntimeError, SystemExit) as e:   # noqa: BLE001"),
    ('o diário que sai não vira feito', "        feitos += feitos_i\n        novos += novos_i\n        erros += erros_i\n        if erros_i:\n            barrados.append(iid)\n        indice.setdefault(ind_i[0], {})",
     "        novos += novos_i\n        erros += erros_i\n        if erros_i:\n            barrados.append(iid)\n        indice.setdefault(ind_i[0], {})"),
    ('o passo das pesadas que falhou é ignorado', "            if os.environ.get('PESADO_OK') not in (None, '', 'success', 'skipped'):", "            if False:"),
    ('a falha da folha derruba a rodada', "        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do curva1730 também)",
     "        except ZeroDivisionError as e:   # noqa: BLE001"),
    ('a falha da folha sai verde', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados:",
     "    if barrados or erro_curvas or erro_diario or erro_rd or erro_enviados:"),
    ('a cópia que falha sai verde', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados:",
     "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd:"),
    ('a validação da folha fica fora do try', "            for n_ in novos_i:   # RW-401: as guardas de texto aqui dentro: a recusa é erro da folha, não da rodada\n                F.valida_item(n_)\n", ""),
    ('a validação do diário fica fora do try', "            for n_ in novos_i:   # RW-401: as guardas de texto do item (e dos fatos dele) aqui dentro: a recusa é erro DESTE item\n                F.valida_item(n_)\n", ""),
    ('a cópia sai antes da fila gravada', "    fl = F.junta_fila(fila, novos, agora)\n    grava('fila.json', fl)\n",
     "    for iid_ in a_copiar:\n        copia_enviados(iid_)\n    a_copiar = []\n    fl = F.junta_fila(fila, novos, agora)\n    grava('fila.json', fl)\n"),
    ('o passo da tarde que falhou é ignorado', "            if os.environ.get('TARDE_OK') not in (None, '', 'success'):", "            if False:"),
    ('a folha da tarde não vira feita', "                feitos_i.append('curva:' + dia)\n", "                pass\n"),
]


def mostra(nome, f):
    print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0][:120] if f else 'PASSOU — o ensaio não pega'))
    return not f


def main():
    global WF_TEXTO
    sys.stdout.reconfigure(encoding='utf-8')
    import curva1730
    falhas = casos_fila(carrega(FONTE)) + casos_curva(curva1730) + ensaio_rodada_1730()
    for f in falhas:
        print('  FALHOU ·', f)
    print('código real:', 'APROVADO' if not falhas else 'REPROVADO (%d)' % len(falhas))
    ruim = bool(falhas)
    nl = lambda s: s.replace('\r\n', '\n')
    for nome, de, para in PLANTIOS_FILA:
        if FONTE.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        try:
            f = casos_fila(carrega(FONTE.replace(de, para)))
        except Exception as e:   # noqa: BLE001
            f = ['quebrou: %s' % e]
        ruim |= mostra(nome, f)
    wf0 = nl(io.open(WF, encoding='utf-8').read())
    for nome, de, para in PLANTIOS_WF:
        if wf0.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        WF_TEXTO = wf0.replace(de, para)
        try:
            f = casos_fila(carrega(FONTE))
        finally:
            WF_TEXTO = None
        ruim |= mostra(nome, f)
    for nome, de, para in PLANTIOS_CURVA:
        if CURVA.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        try:
            f = casos_curva(carrega(CURVA.replace(de, para), 'curva1730'))
        except Exception as e:   # noqa: BLE001
            f = ['quebrou: %s' % e]
        ruim |= mostra(nome, f)
    for nome, de, para in PLANTIOS_RODADA:
        pares = de if isinstance(de, list) else [(de, para)]   # um plantio pode ter mais de uma troca
        if any(RODADA.count(a) != 1 for a, _ in pares):
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        src = RODADA
        for a, b in pares:
            src = src.replace(a, b)
        m = types.ModuleType('rodada'); m.__file__ = os.path.join(AQUI, 'rodada.py'); m.__fonte__ = src
        exec(compile(src, 'rodada', 'exec'), m.__dict__)
        try:
            f = ensaio_rodada_1730(m)
        except Exception as e:   # noqa: BLE001
            f = ['quebrou: %s' % e]
        ruim |= mostra(nome, f)
    print('ensaio da folha das 17:30:', 'REPROVADO' if ruim else 'APROVADO')
    sys.exit(1 if ruim else 0)


if __name__ == '__main__':
    main()
