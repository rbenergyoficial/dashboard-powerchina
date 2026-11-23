# -*- coding: utf-8 -*-
"""Ensaio do Boletim de Desempenho (lote boletim-desempenho, 07/11/2026). Sem rede e sem Chrome: só as regras.
Cada regra tem o caso que ela existe para RECUSAR, e um PLANTIO (o código com a trava arrancada) que tem de reprovar.
    python ensaio_boletim.py          sai 0 = aprovado; 1 = alguma regra falhou ou algum plantio passou"""
import contextlib
import datetime as dt
import importlib.util
import io
import os
import sys
import tempfile
import types

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
FONTE = io.open(os.path.join(AQUI, 'fila.py'), encoding='utf-8').read()
WF = os.path.join(AQUI, '..', '..', '.github', 'workflows', 'boletim.yml')
WF_TEXTO = None   # o plantio do cron troca o texto do workflow (None = o arquivo)
ENS = os.path.join(AQUI, '..', '..', '.github', 'workflows', 'ensaios.yml')
ENS_TEXTO = None   # idem, o ensaios.yml (RW-007: é lá que a imagem do diário roda)
SEM_IMAGEM = '--sem-imagem' in sys.argv   # boletim.yml, passo "Ensaio · boletim": as regras e o transporte (RW-003)
SO_IMAGEM = '--so-imagem' in sys.argv     # boletim.yml, passo "Ensaio · imagem do diário": só a imagem e os plantios dela (RE-011)


def carrega(src, nome='fila_x'):
    m = types.ModuleType(nome)
    exec(compile(src, nome, 'exec'), m.__dict__)
    return m


def recusa(f, *a):
    try:
        f(*a)
    except SystemExit:
        return True
    return False


# ── dados forjados ──
def executivo(meta_cx=1000.0, meta_ppa=600.0, meta_ml=100.0):
    dias = [f'2026-11-{i:02d}' for i in range(1, 7)]
    serie = []
    for i, d in enumerate(dias):
        serie.append({'ufv': 'Complexo', 'dia': d, 'liq_mwh': 200.0 + 10 * i, 'meta_dia_mwh': 150.0, 'parcial': False})
        serie.append({'ufv': 'PPA', 'dia': d, 'liq_mwh': 110.0, 'meta_dia_mwh': 90.0, 'parcial': False})
        serie.append({'ufv': 'ML', 'dia': d, 'liq_mwh': 40.0, 'meta_dia_mwh': 30.0, 'parcial': False})
    serie.append({'ufv': 'Complexo', 'dia': '2026-10-05', 'liq_mwh': 240.0, 'meta_dia_mwh': 150.0, 'parcial': False})
    return {'serie_dia_ufv': serie, 'totais_vida': {'total_gwh': 1100.4},
            'manchete_ufv': [{'ufv': 'Complexo', 'mes': '2026-11', 'meta_mwh': meta_cx}, {'ufv': 'PPA', 'mes': '2026-11', 'meta_mwh': meta_ppa},
                             {'ufv': 'ML', 'mes': '2026-11', 'meta_mwh': meta_ml}]}


def catalogo(emissao='AP', en=True):
    pd = lambda c: [{'idioma': 'pt', 'blob': f'acervo/pdf/{c}_Rev00.pdf'}] + ([{'idioma': 'en', 'blob': f'acervo/pdf/{c}_Rev00_EN.pdf'}] if en else [])
    return {'documentos': [
        {'codigo': 'RD-MRT-2026-0090', 'tipo': 'RD', 'emissao': emissao, 'revisao': '00', 'titulo': 'Desempenho Operacional de setembro de 2026', 'pdfs': pd('RD-MRT-2026-0090')},
        {'codigo': 'RD-MRT-2026-0091', 'tipo': 'RD', 'emissao': emissao, 'revisao': '00', 'titulo': 'Desempenho Operacional do 3\ufffd trimestre de 2026', 'pdfs': pd('RD-MRT-2026-0091')},
        {'codigo': 'RD-MRT-2026-0092', 'tipo': 'RD', 'emissao': emissao, 'revisao': '00', 'titulo': 'Desempenho Operacional de agosto de 2026', 'pdfs': pd('RD-MRT-2026-0092')},
    ]}


def casos(F):
    """devolve a lista de falhas (vazia = tudo certo)"""
    falhas = []
    ok = lambda c, msg: falhas.append(msg) if not c else None
    h = lambda s: dt.datetime.fromisoformat(s)
    # calendário
    ok(F.tarefas(h('2026-11-07T07:59'), {'feitos': []}, set()) == [], 'antes das 08:00 não gera o diário')
    ok(F.tarefas(h('2026-11-07T08:01'), {'feitos': []}, set()) == [('diario', '2026-11-06')], 'às 08:01 gera o diário de ontem')
    ok(F.tarefas(h('2026-11-07T09:00'), {'feitos': ['diario:2026-11-06']}, set()) == [], 'diário feito não se repete')
    # o complemento saiu do plano (humano, 07/11/2026): com o ONS publicado, a qualquer hora, nada além do diário de uma vez
    pub = {'2026-11-04', '2026-11-05', '2026-11-06'}
    ok(all(m != 'complemento' for hr in range(24) for m, _ in F.tarefas(h('2026-11-07T%02d:05' % hr), {'feitos': ['diario:2026-11-06']}, pub)),
       'o complemento voltou: o diário sai uma vez por dia, sem segunda edição quando o ONS publica')
    ok(F.tarefas(h('2026-11-07T17:35'), {'feitos': ['diario:2026-11-06']}, pub) == [], 'à tarde, com o ONS publicado, nada novo')
    ok(('mensal', '2026-10-31') in F.tarefas(h('2026-11-01T08:05'), {'feitos': []}, set()), 'mensal no dia 1º')
    # metas só do Complexo e do PPA, uma vez por fato
    ex = executivo(meta_cx=1300.0, meta_ppa=500.0, meta_ml=230.0)   # PPA passa a meta no dia 05; Complexo e ML no dia 06
    f1 = F.fatos(ex, '2026-11-06', {'feitos': []})
    ok(not any(f.get('ufv') == 'ML' for f in f1), 'meta do ML nunca vira fato (só Complexo e PPA)')
    ok(any(f['id'] == 'meta-Complexo-2026-11' for f in f1), 'meta do Complexo batida no dia vira fato')
    ok(not any(f['id'].startswith('meta-PPA') for f in f1), 'meta do PPA batida em dia anterior não vira fato de novo')
    feitos = ['fato:' + f['id'] for f in f1]
    ok(F.fatos(ex, '2026-11-06', {'feitos': feitos}) == [], 'fato já dado não se repete')
    ok(any(f['id'] == 'recorde-2026-11-06' for f in F.fatos(executivo(), '2026-11-06', {'feitos': []})), 'recorde diário vira fato')
    ok(any(f['id'] == 'marco-1100GWh' for f in F.fatos(executivo(), '2026-11-06', {'feitos': [], 'ultimo_total_gwh': 1095.0})), 'marco de 50 GWh vira fato')
    ok(not any(f['tipo'] == 'marco' for f in F.fatos(executivo(), '2026-11-06', {'feitos': []})), 'primeira rodada sem total visto não inventa marco')
    # a limitação: nunca "ONS apurou 0"; estimado sempre marcado
    r = {'dia': '2026-11-06', 'liq': 3068.07, 'meta_dia': 2066.67, 'ons_mwh': 0, 'limitado': {'h': 5.5, 'est': 36.82}, 'pr': 75.1, 'disp': 99.96, 'ons_estado': 'publicado',
         'complexo': {'pct': 22.1, 'proj_pct': 110}, 'ppa': {'pct': 30.1, 'proj_pct': 151}}
    t = F.texto_en('diario', r)
    ok('≈ 36.82 MWh estimated' in t, 'limitação sem apuração do ONS sai "≈ X MWh estimated"')
    ok('apurou' not in t and 'curtailed 0' not in t.lower(), 'nada de "ONS apurou 0"')
    ok('No ONS limitation' in F.texto_en('diario', dict(r, limitado={'h': 0, 'est': None}, ons_estado='publicado')), 'sem limitação no dia (ONS publicado)')
    # boletim-ons-pendente: o ONS que ainda não publicou o dia nunca vira "sem limitação"
    rp = dict(r, ons_mwh=None, limitado={'h': 0, 'est': None}, ons_estado='pendente',
              iqony={'n': 5, 'h': 2.3, 'lmin': 282.0, 'ini': '10:50', 'fim': '13:06', 'herdada': False, 'motivos': ['ENE_FREQ'], 'coletor': 'ok'})
    tp_en, tp_pt = F.texto_en('diario', rp), F.texto('diario', rp)
    ok('ONS: 5 limitation orders, 2.3 h under limit, minimum 282 MW (Iqony). Official figure pending.' in tp_en and 'No ONS limitation' not in tp_en,
       'ONS pendente com ordens: as ordens da Iqony e "official figure pending", nunca "No ONS limitation": ' + tp_en.splitlines()[2])
    ok('5 ordens de limitação, 2,3 h sob limite' in tp_pt and 'Sem limitação' not in tp_pt, 'ONS pendente com ordens, em português: ' + tp_pt.splitlines()[2])
    ok('1 limitation order,' in F.texto_en('diario', dict(rp, iqony=dict(rp['iqony'], n=1))), 'uma ordem no singular')
    rn = dict(rp, iqony=dict(rp['iqony'], n=0, h=0, lmin=None))
    ok('no limitation order received (official figure pending)' in F.texto_en('diario', rn) and 'No ONS limitation' not in F.texto_en('diario', rn),
       'ONS pendente sem ordem: "no limitation order received", nunca "No ONS limitation"')
    for nome, rx in (('sem o registro das ordens', dict(rp, iqony=None)), ('resumo sem o estado do ONS', {k: v for k, v in r.items() if k != 'ons_estado'})):
        t_ = F.texto_en('diario', rx)
        ok('No ONS limitation' not in t_ and 'official figure pending' in t_ and '—' not in t_, 'ONS pendente, %s: nunca "No ONS limitation" nem "—": %s' % (nome, t_.splitlines()[2]))
    ok('stopped' in F.texto_en('diario', dict(rp, iqony=dict(rp['iqony'], coletor='parado'))), 'coletor das ordens parado avisa')
    ok('coletor das ordens está parado' in F.texto('diario', dict(rp, iqony=dict(rp['iqony'], coletor='parado'))), 'coletor das ordens parado avisa em português')
    rh = dict(rp, iqony=dict(rp['iqony'], n=0, h=14.0, lmin=282.0, herdada=True))
    ok('the day started under the order of the previous day, 14.0 h under limit, minimum 282 MW' in F.texto_en('diario', rh)
       and 'o dia começou sob a ordem do dia anterior, 14,0 h sob limite' in F.texto('diario', rh), 'dia sob a ordem da véspera, sem ordem nova, em EN e PT')
    for t_ in (tp_en, F.texto_en('diario', rn), F.texto_en('diario', dict(rp, iqony=None))):
        ok(not recusa(F.valida_item, {'texto': t_}), 'as frases novas passam nas guardas do grupo (inglês sem português): ' + t_.splitlines()[2])
    # as ordens da Iqony no dia fechado: a conta da folha das 17:30 (degrau, 5 min, 05:00 a 19:00)
    iq = {'versao': 1, 'campos': ['dia', 'h', 'tipo', 'mw', 'raz', 'mot', 'origem_ons', 'destino', 'conf', 'corr'], 'coletor': {'estado': 'ok'}, 'eventos': [
        ['2026-11-17', '08:21:00', 'limite', 142, 'REL', 'ELE_SGI', 'COSR-NE', 'rdo', None, None],
        ['2026-11-17', '09:25:00', 'limite', 173, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', None, None],
        ['2026-11-17', '09:51:00', 'fim', None, None, None, 'COSR-NE', 'rdo', None, None],
        ['2026-11-17', '10:00:00', 'limite', 99, 'ENE', 'ENE_FREQ', 'COSR-NE', 'conflito', None, None],
        ['2026-11-17', '19:30:00', 'limite', 100, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', None, None],
        ['2026-11-17', '20:10:00', 'fim', None, None, None, 'COSR-NE', 'rdo', None, None],
        ['2026-11-18', '10:50:00', 'limite', 282, 'ENE', 'FLUXO', 'COSR-NE', 'rdo', None, None]],
          'gerado_em': '2026-11-20T11:00:00Z'}
    iq['coletor']['ultimo_pulso'] = '2026-11-20T10:58:00Z'
    q = F.iqony_dia(iq, '2026-11-17')
    ok(q and q['n'] == 2 and q['h'] == 1.5 and q['lmin'] == 142.0 and q['ini'] == '08:21' and q['fim'] == '09:51' and q['motivos'] == ['ELE_SGI', 'ENE_FREQ'],
       'ordens da Iqony do dia: 2 ordens, 1,5 h, mínimo 142 MW, sem o evento em conflito: %s' % ({k: q.get(k) for k in ('n', 'h', 'lmin', 'ini', 'fim')} if q else q))
    q16 = F.iqony_dia(iq, '2026-11-16')
    ok(q16 and q16['n'] == 0 and q16['h'] == 0 and F.estado_ons({'ons_estado': 'pendente', 'iqony': q16}) == 'nenhuma', 'dia sem ordem no registro: nenhuma ordem')
    ok(F.iqony_dia(None, '2026-11-17') is None and F.estado_ons({'ons_estado': 'pendente', 'iqony': None}) == 'sem_registro', 'sem o arquivo das ordens: sem o registro')
    real = {'coletor': {'estado': 'ok', 'ultimo_pulso': '2026-11-17T20:30:03Z'}}   # o formato real, lido do resumo da folha de 17/11
    ok(F.cobre_dia(real, '2026-11-16') and not F.cobre_dia(real, '2026-11-17'), 'a hora do coletor no formato real: cobre o dia anterior, não o próprio dia às 17:30')
    q19 = F.iqony_dia(iq, '2026-11-19')
    ok(q19 and q19['n'] == 0 and q19['herdada'] is True and q19['h'] == 14.0 and q19['lmin'] == 282.0,
       'dia sob a ordem da véspera (282 MW de 18/11 sem fim): 0 ordem nova, herdada, 14,0 h, mínimo 282 MW: %s' % ({k: q19.get(k) for k in ('n', 'herdada', 'h', 'lmin')} if q19 else q19))
    ok(F.iqony_dia(dict(iq, gerado_em='2026-11-17T21:30:00Z'), '2026-11-17') is None and F.iqony_dia(dict(iq, coletor={'estado': 'ok', 'ultimo_pulso': '2026-11-17T20:00:00Z'}), '2026-11-17') is None
       and F.iqony_dia({k: v for k, v in iq.items() if k not in ('gerado_em', 'coletor')}, '2026-11-17') is None,
       'arquivo das ordens gravado, ou coletor parado, antes do fim do dia (19:00): sem o registro, nunca "nenhuma ordem"')
    ok(recusa(F.confere_texto, 'O ONS apurou 0,00 MWh no dia'), 'a guarda recusa "ONS apurou 0"')
    # só inglês ao grupo
    ok(recusa(F.sem_portugues, 'Geração do dia acima da meta'), 'a guarda recusa texto em português')
    ok(F.sem_portugues(t) == t, 'o texto em inglês passa na guarda')
    ok(recusa(F.junta_fila, {'itens': []}, [{'id': 'x', 'texto': 'Boletim diário: geração do dia'}], h('2026-11-07T07:00')), 'a fila recusa item em português')
    fl = F.junta_fila({'itens': [{'id': 'velho', 'texto': 'old', 'criado': '2026-09-01T07:00'}]}, [{'id': 'a', 'texto': t}, {'id': 'a', 'texto': t}], h('2026-11-07T07:00'))
    ok([i['id'] for i in fl['itens']] == ['a'], 'fila: id repetido entra uma vez e item de mais de 30 dias sai')
    # RD do período: só emitido, PT e EN, uma vez; RD ausente não trava nada
    it = F.itens_rd(catalogo(), dt.date(2026, 10, 3), {'feitos': []})
    ids = sorted(i['codigo'] for i in it)
    ok(ids == ['RD-MRT-2026-0090', 'RD-MRT-2026-0091', 'RD-MRT-2026-0092'], 'RD mensal de setembro, trimestral do 3º e o de agosto que atrasou: %s' % ids)
    ok(all(len(i['arquivos']) == 2 and i['arquivos'][0].endswith('_Rev00.pdf') for i in it), 'RD vai em PT e EN')
    ok(F.itens_rd(catalogo(), dt.date(2026, 10, 3), {'feitos': ['rd:' + c for c in ids]}) == [], 'RD já enviado não volta')
    ok(F.itens_rd(catalogo(emissao='PR'), dt.date(2026, 10, 3), {'feitos': []}) == [], 'RD não emitido (PR) não vai')
    ok(F.itens_rd(catalogo(en=False), dt.date(2026, 10, 3), {'feitos': []}) == [], 'RD sem a versão EN espera')
    ok(('mensal', '2026-09-30') in F.tarefas(h('2026-10-01T08:05'), {'feitos': []}, set()), 'sem RD emitido, o mensal sai assim mesmo')
    # recuperação: dias anteriores não feitos (até o teto), nunca antes da semeadura; mensal até o dia 5
    ok(F.tarefas(h('2026-11-09T08:05'), {'feitos': ['diario:2026-11-06'], 'desde': '2026-11-06'}, set())
       == [('diario', '2026-11-07'), ('diario', '2026-11-08')], 'a rodada que não rodou se recupera (07 e 08/11, o mais antigo primeiro)')
    ok(F.tarefas(h('2026-11-20T08:05'), {'feitos': [], 'desde': '2026-11-01'}, set())
       == [('diario', '2026-11-17'), ('diario', '2026-11-18'), ('diario', '2026-11-19')], 'a recuperação tem teto de 3 dias')
    ok(F.tarefas(h('2026-11-08T08:05'), {'feitos': [], 'desde': '2026-11-07'}, set()) == [('diario', '2026-11-07')],
       'nada anterior à semeadura sai')
    ok(F.tarefas(h('2026-11-08T06:30'), {'feitos': [], 'desde': '2026-11-06'}, set()) == [('diario', '2026-11-06')],
       'antes das 08:00 só recupera dia anterior a ontem')
    ok(('mensal', '2026-11-30') in F.tarefas(h('2026-12-03T07:10'), {'feitos': [], 'desde': '2026-11-06'}, set()), 'o mensal se recupera no dia 3')
    ok(not any(m == 'mensal' for m, _ in F.tarefas(h('2026-12-06T07:10'), {'feitos': [], 'desde': '2026-11-06'}, set())), 'o mensal tem teto no dia 5')
    ok(not any(m == 'mensal' for m, _ in F.tarefas(h('2026-11-03T07:10'), {'feitos': [], 'desde': '2026-11-02'}, set())),
       'o mensal de antes da semeadura não sai')
    # a guarda de português barra: o item não vira feito (a rodada seguinte tenta de novo e segue vermelha até corrigir)
    ok(F.marca('diario', '2026-11-07', ['Geração'], set()) == [], 'item barrado pela guarda de português não vira feito')
    ok(F.marca('diario', '2026-11-07', [], {'2026-11-07'}) == ['diario:2026-11-07', 'ons:2026-11-07'], 'item gerado vira feito')
    # a semeadura: sem ela a rodada recusa; ela marca, fixa o `desde` e poda a fila
    ok(recusa(F.exige_semeado, None) and recusa(F.exige_semeado, {'feitos': ['diario:2026-11-06']}), 'rodada sem semeadura recusa')
    est, fl0 = F.semente({'feitos': []}, ['rd:RD-MRT-2026-0086'], ['diario:2026-11-06'], 1062.6, h('2026-11-07T20:00'))
    ok(not recusa(F.exige_semeado, est) and est['desde'] == '2026-11-06' and fl0['itens'] == [] and 'rd:RD-MRT-2026-0086' in est['feitos'],
       'a semeadura marca os feitos, fixa o desde e poda a fila')
    # o disparo manual: feitos só na forma
    ok(F.valida_feitos('diario:2026-11-06,ons:2026-11-06,mensal:2026-10-31') == ['diario:2026-11-06', 'ons:2026-11-06', 'mensal:2026-10-31'],
       'feitos na forma passam')
    ok(recusa(F.valida_feitos, 'diario:2026-11-06,$(curl x)'), 'feitos fora da forma recusam')
    # virada do mês: o arquivo do ONS do mês corrente ainda não existe; os dias saem do anterior
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, 'ons_restricao_2026_10.json'), 'w', encoding='utf-8').write('{"consolidado": [{"ts": "2026-10-31T12:00"}]}')
        ok(F.ons_dias(d) == {'2026-10-31'}, 'virada do mês: sem o arquivo do mês corrente, a rodada segue')
    # a opção de esperar o dia completo (desligada): sabe dizer o que falta
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, 'pr_ufv.json'), 'w', encoding='utf-8').write('{"ultimo_dia": "2026-11-06"}')
        open(os.path.join(d, 'sg_disp_dia.json'), 'w', encoding='utf-8').write('{"serie": [{"dia": "2026-11-07"}]}')
        open(os.path.join(d, 'irr_ufv.json'), 'w', encoding='utf-8').write('{"janela": {"fim": "2026-11-07 23:30:00"}}')
        ok(F.faltam_no_dia(d, '2026-11-07') == ['PR'], 'dia completo: falta só o PR')
    # as curvas da página: a mesma conta do boletim (soma dos pontos, nula se falta um), sem o dia em curso, acumulando a anterior
    import curvas as C
    w2 = {'dados': [{'nomeGrandeza': 'Demat', 'pontoId': 6196, 'valores': [{'data': '2026-11-06T12:00:00', 'valor': 150000.0}, {'data': '2026-11-07T12:00:00', 'valor': 9000.0}]},
                    {'nomeGrandeza': 'Demat', 'pontoId': 6197, 'valores': [{'data': '2026-11-06T12:00:00', 'valor': 140000.0}, {'data': '2026-11-07T12:00:00', 'valor': 9000.0}]},
                    {'nomeGrandeza': 'Demre', 'pontoId': 6196, 'valores': [{'data': '2026-11-06T12:30:00', 'valor': 1.0}]}]}
    ant = {'esquema': 1, 'slots': C.SLOTS, 'dias': {'2026-11-01': {u: [1.0] * 28 for u in C.PONTOS}}}
    cv = C.monta(w2, {'serie_dia': [{'dia': '2026-11-06', 'ufv': 'Complexo', 'gti': 6.1}, {'dia': '2026-11-06', 'ufv': 'M1', 'gti': 9.9}]},
                 ant, '2026-11-07')
    i12 = C.SLOTS.index('12:00')
    ok(cv['dias']['2026-11-06']['Complexo'][i12] == 290.0 and cv['dias']['2026-11-06']['Complexo'][i12 + 1] is None,
       'curvas: a soma dos dois pontos do conjunto em MW, e nula onde falta medição')
    ok('2026-11-07' not in cv['dias'] and '2026-11-01' in cv['dias'] and cv['irr_dia'] == {'2026-11-06': 6.1},
       'curvas: sem o dia em curso, acumulando a rodada anterior; a irradiação é a do conjunto')
    bom = dict(ant, ate='2026-11-06')
    ok(C.velho(None, '2026-11-06') and C.velho(dict(bom, ate='2026-11-05'), '2026-11-06') and not C.velho(bom, '2026-11-06'),
       'curvas: sem o arquivo ou parado antes de ontem, refaz')
    # fora da forma vale como ausente: refaz do zero, sem estourar
    fora = ['x', {'esquema': 2, 'dias': {}}, {'esquema': 1, 'slots': C.SLOTS, 'dias': []}, {'esquema': 1, 'slots': C.SLOTS, 'dias': {'2026-11-01': 'x'}}]
    try:
        cvs = [C.monta(w2, {}, a, '2026-11-07') for a in fora]
        ok(all(list(x['dias']) == ['2026-11-06'] for x in cvs) and all(C.velho(a, '2026-11-06', '2026-11-07') for a in fora),
           'curvas anteriores fora da forma: refeitas do zero, sem estourar')
    except Exception as e:
        ok(False, 'curvas anteriores fora da forma: refeitas do zero, sem estourar (%s)' % e)
    # no máximo uma tentativa por dia: dia sem a medição de ontem não faz toda rodada descer o pesado
    ok(cv['tentado_em'] == '2026-11-07' and not C.velho(dict(bom, ate='2026-11-05', tentado_em='2026-11-07'), '2026-11-06', '2026-11-07')
       and C.velho(dict(bom, ate='2026-11-05', tentado_em='2026-11-06'), '2026-11-06', '2026-11-07'),
       'curvas: uma tentativa por dia (tentado_em)')
    ok(F.ESPERA_DIA_COMPLETO is False and F.HORA_DIARIO == '08:00', 'a espera do dia completo fica desligada e o diário às 08:00 (decisão do humano, 08/11)')
    # a disponibilidade do dia que ainda não chegou: "apuração às 10h", nunca um número parcial nem "—%"
    r0 = {'dia': '2026-11-07', 'liq': 2328.62, 'meta_dia': 2066.67, 'limitado': {'h': 0, 'est': None}, 'pr': 81.2, 'disp': None, 'ons_estado': 'publicado',
          'complexo': {'pct': 22.1, 'proj_pct': 110}, 'ppa': {'pct': 30.1, 'proj_pct': 151}}
    te, tp = F.texto_en('diario', r0), F.texto('diario', r0)
    ok('Availability: computed at 10h' in te.replace('· availability', '· Availability') and '—' not in te and 'apuração às 10h' in tp, 'disponibilidade ausente vira "computed at 10h" / "apuração às 10h"')
    ok('availability 99.87%' in F.texto_en('diario', dict(r0, disp=99.87)), 'disponibilidade presente sai com o número')
    # o cron do boletim.yml cobre o horário do diário (a hora vive num lugar só; o cron tem de acompanhar). Só as passadas da MANHÃ
    # (antes da folha das 17:30): as da tarde não cobrem o diário (sem o corte, a checagem passaria pela tarde em silêncio)
    wf = WF_TEXTO if WF_TEXTO is not None else (io.open(WF, encoding='utf-8').read() if os.path.exists(WF) else None)
    if wf is not None:
        ps = passadas_brt(wf)
        hm = int(F.HORA_DIARIO[:2]) * 60 + int(F.HORA_DIARIO[3:])
        hc = int(F.HORA_CURVA[:2]) * 60 + int(F.HORA_CURVA[3:])
        pm = [p for p in ps if p < hc]
        dep = [p for p in pm if p >= hm - 5]
        ok(dep and dep[0] <= hm + 10 and max(pm) >= hm + 80,
           'a janela do cron cobre o diário das %s (passadas da manhã: %s)' % (F.HORA_DIARIO, ' '.join('%02d:%02d' % divmod(p, 60) for p in pm)))
        # RW-003/RW-007: o boletim.yml roda as regras sem a imagem; o ensaios.yml roda a imagem (sem a flag): a prova da imagem não some em silêncio
        ok('ensaio_boletim.py --sem-imagem' in wf, 'o boletim.yml roda o ensaio sem a imagem (a imagem não barra a folha da tarde)')
        import re as _r
        pi = _r.search(r'- name: Ensaio · imagem do diário\n(?:        .*\n)+', wf)
        pe = _r.search(r'- name: Entradas pesadas\n(?:        .*\n)+', wf)
        # RE-017: linhas EXATAS (um "|| true", um "if: false" ou o ENSAIO_IMG_OK a menos desligariam a prova em silêncio)
        li = pi.group(0).splitlines() if pi else []
        # RE-019: o id é o que o ENSAIO_IMG_OK lê, e o passo vem ANTES da Rodada (senão o valor chega vazio e vale como aprovado)
        ok(pi and '        id: ensaio_img' in li and wf.find('- name: Ensaio · imagem do diário') < wf.find('- name: Rodada'),
           'o passo da imagem tem o id ensaio_img e vem antes da Rodada')
        ok(pi and "        if: ${{ !cancelled() && steps.decide.outputs.pesado == 'true' }}" in li and '        continue-on-error: true' in li
           and any(x.startswith('        timeout-minutes: ') for x in li) and '        run: python3 scripts/boletim/ensaio_boletim.py --so-imagem' in li
           and pe and 'ensaio_img' not in pe.group(0) and '          ENSAIO_IMG_OK: ${{ steps.ensaio_img.outcome }}' in wf.splitlines(),
           'o boletim.yml ensaia a imagem num passo próprio (continue-on-error, com teto) que chega à Rodada pelo ENSAIO_IMG_OK; as entradas pesadas não dependem dele')
    ens = ENS_TEXTO if ENS_TEXTO is not None else (io.open(ENS, encoding='utf-8').read() if os.path.exists(ENS) else None)
    if ens is not None:
        import re as _re
        cs = _re.findall(r'ensaio_boletim\.py[^\n]*', ens)
        ok(cs and all('--sem-imagem' not in c for c in cs), 'o ensaios.yml roda o ensaio com a imagem do diário: %s' % cs)
    return falhas


def passadas_brt(wf):
    """os minutos do dia (Brasília) em que os crons `m[,m] h[-h|,h] * * *` do workflow passam"""
    import re
    out = set()
    for m in re.finditer(r"cron:\s*'([0-9,]+) ([0-9,-]+) \* \* \*'", wf):
        mins = [int(x) for x in m.group(1).split(',')]
        hs = []
        for p in m.group(2).split(','):
            a, _, b = p.partition('-')
            hs += list(range(int(a), int(b or a) + 1))
        out |= {((h - 3) % 24) * 60 + mi for h in hs for mi in mins}
    return sorted(out)


def ensaio_prepara():
    import prepara as P
    falhas = []
    fonte = "AQUI = os.path.dirname(os.path.abspath(__file__))\nX = open(r'C:\\Users\\user\\OneDrive - rbenergy.com.br\\PWC\\Logo_Intrepid\\logo_intrepid_800.png', 'rb')\n" \
            "GERADO = dt.datetime.now().strftime('%d/%m/%Y %H:%M')\nprint('ok', saida + suf, len(partes), 'partes')\n" \
            " {kpi(OK,'Disponibilidade do dia',nf(dsp,2),'%',f'no mês {nf(dsm,2)}%')}\n"
    try:
        s = P.prepara(fonte)
        if "os.environ.get('BOLETIM_DIR')" not in s or '_resumo.json' not in s or 'apuração às 10h' not in s:
            falhas.append('prepara: as trocas não entraram')
    except SystemExit as e:
        falhas.append('prepara recusou a fonte certa: %s' % e)
    if not recusa(P.prepara, fonte.replace('GERADO = ', 'GERADO_X = ')):
        falhas.append('prepara aceitou fonte sem a âncora')
    return falhas


def ensaio_guarda_pt():
    """o HTML com uma frase que o tradutor não conhece: a guarda acha português e a rodada não põe na fila"""
    import rodada as R
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, 'diario_claro.html'), 'w', encoding='utf-8').write('<html><body><h2>Geração do dia</h2><p>texto qualquer que não traduz</p></body></html>')
        s = R.traduz_pasta(d, 'diario')
        ok_en = os.path.exists(os.path.join(d, 'diario_claro_en.html'))
    with tempfile.TemporaryDirectory() as d:
        open(os.path.join(d, 'diario_claro.html'), 'w', encoding='utf-8').write('<html><body><b><span style=font-size:19px>apuração às 10h</span></b></body></html>')
        s2 = R.traduz_pasta(d, 'diario')
        en2 = open(os.path.join(d, 'diario_claro_en.html'), encoding='utf-8').read()
    return ([] if s else ['a guarda de português não achou nada no HTML sem tradução']) + ([] if ok_en else ['o HTML em inglês não foi guardado']) \
        + ([] if not s2 and 'computed at 10h' in en2 else ['"apuração às 10h" não vira "computed at 10h" na folha em inglês: %s' % s2])


# ───────── a imagem (boletim_aprovado.py pelo prepara.py), com dados forjados: boletim-ons-pendente ─────────
# 01 e 02/11 publicados pelo ONS (02 com limitação), 03/11 pendente. As ordens da Iqony têm ordens em 02 (que o publicado IGNORA) e em 03.
# Roda no ensaios.yml (a cada push). No boletim.yml roda com --sem-imagem: a imagem do diário não barra a folha da tarde (RW-003).
US_ = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9']
PONTOS_ = [6196, 6197] + list(range(6198, 6220))
DIAS_ = ['2026-11-01', '2026-11-02', '2026-11-03']
SLOTS_ = [f'{h:02d}:{m:02d}' for h in range(5, 19) for m in (0, 30)]
# RE-001: o TEXTO VISÍVEL inteiro do dia publicado (sem a hora de geração), sha256, medido em 20/11/2026 rodando o boletim_aprovado.py e o
# prepara.py do HEAD 2671721 sobre esta forja (com as ordens da Iqony presentes, que o publicado ignora). Mudou o desenho de propósito? Meça
# de novo com o código aprovado e troque aqui, dizendo no livro por quê.
# boletim-pdf-executivo (22/11/2026): medido de novo depois que a coluna "PR sem o corte" POR USINA saiu do diário (a divisão da energia impedida
# por usina não é confiável). Contra o HEAD a85b748 mudam só 10 trechos por dia: o subtítulo do painel das usinas e os nove valores (81,7% -> 80,0%,
# o PR publicado). Antes: ba082ac9e458… (01/11) e dab4af05b6b0… (02/11).
# boletim-p75 (23/11/2026): medido de novo com o P75 no cartão do estudo ("P50 · P75 · P90 do projeto"). Contra o HEAD b499fee mudam só 2
# trechos por dia: o título do cartão e o subtítulo (+ "P75 67,1%" em 01/11, "P75 68,7%" em 02/11). Antes: fbb37ae59671… e 77311277f190….
OURO_VIS = {'2026-11-01': '8ada61b930a43bc963c6f2ef0ea9f655a02fbbdec4b5b085f3a445e5a5031137', '2026-11-02': '3a615d1780896316a09502671ee9458fbdbbc3890ee0c5c310d11bfb9c0c53de'}
_EV_BOM = [['2026-11-02', '09:00:00', 'limite', 120, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', None, None],
           ['2026-11-02', '13:00:00', 'fim', None, None, None, 'COSR-NE', 'rdo', None, None],
           ['2026-11-03', '10:50:00', 'limite', 282, 'ENE', 'FLUXO', 'COSR-NE', 'rdo', None, None],
           ['2026-11-03', '12:00:00', 'limite', 300, 'ENE', 'ENE_FREQ', 'COSR-NE', 'rdo', None, None],
           ['2026-11-03', '13:06:00', 'fim', None, None, None, 'COSR-NE', 'rdo', None, None]]
CAMPOS_ = ['dia', 'h', 'tipo', 'mw', 'raz', 'mot', 'origem_ons', 'destino', 'conf', 'corr']


def forja(d, iqony='bom', pub=None, coletor='ok'):
    """iqony: 'bom' | 'herdada' (02 termina sob limite, 03 sem ordem) | 'nenhuma' (só 02) | 'velho' (gravado antes do fim de 03) |
    'quebrado' (JSON truncado) | 'forma' (campos fora da ordem) | None (sem o arquivo). pub: os dias que o ONS publicou."""
    import json
    import math
    J = lambda n, o: json.dump(o, open(os.path.join(d, n), 'w', encoding='utf-8'))
    sol = lambda s: max(0.0, math.sin(math.pi * (int(s[:2]) * 60 + int(s[3:]) - 330) / 720))
    ger = {dia: 2000.0 + 100 * i for i, dia in enumerate(DIAS_)}
    serie = []
    for dia in DIAS_:
        serie.append({'ufv': 'Complexo', 'dia': dia, 'liq_mwh': ger[dia], 'meta_dia_mwh': 2000.0, 'parcial': False})
        serie.append({'ufv': 'PPA', 'dia': dia, 'liq_mwh': ger[dia] * .6, 'meta_dia_mwh': 1200.0, 'parcial': False})
        serie += [{'ufv': u, 'dia': dia, 'liq_mwh': ger[dia] / 9, 'meta_dia_mwh': 220.0, 'parcial': False} for u in US_]
    pub = DIAS_[:2] if pub is None else pub
    J('executivo.json', {'serie_dia_ufv': serie, 'totais_vida': {'total_gwh': 1000.0}, 'confianca_projecao': {'erro_pp': 3.0, 'n_meses': 6},
                         'manchete_ufv': [{'ufv': 'Complexo', 'mes': '2026-11', 'meta_mwh': 62000.0}, {'ufv': 'PPA', 'mes': '2026-11', 'meta_mwh': 36000.0}],
                         'serie_diaria': [{'dia': x, 'entregue_mwh': ger[x], 'cortado_mwh': 55.5 if x == '2026-11-02' else 0.0, 'horas_restricao': 2 if x == '2026-11-02' else 0,
                                           'razoes': {'ENE': {'mwh': 55.5 if x == '2026-11-02' else 0.0}}, 'origens': {'SIS': {'mwh': 55.5 if x == '2026-11-02' else 0.0}}} for x in pub],
                         'corte_diario_ufv': [{'dia': x, 'ufv': u, 'cortado_mwh': 6.0 if x == '2026-11-02' else 0.0} for x in pub for u in US_]})
    J('pr_ufv.json', {'placa_mwp': {u: 46.0 for u in US_}, 'entidades': {u: {'dias': [{'dia': x, 'pr_pct': 80.0, 'inj_mwh': 230.0, 'den_mwh': 287.5, 'impedida_mwh': 5.0} for x in DIAS_]} for u in US_}})
    J('sg_disp_dia.json', {'capacidade_mw': {u: 38.2 for u in US_}, 'serie': [dict({'dia': x}, **{f'{u}_disp_sol_pct': 99.5 for u in US_}) for x in DIAS_]})
    J('irr_ufv.json', {'serie_dia': [{'dia': x, 'ufv': 'Complexo', 'gti': 6.0} for x in DIAS_]})
    J('benchmark_ne.json', {'serie_dia': [{'dia': x, 'nosso_gerado_gwh': 2.0, 'nosso_cortado_gwh': .05, 'abaiara_gerado_gwh': 1.0, 'abaiara_cortado_gwh': .02,
                                           'ne_gerado_gwh': 50.0, 'ne_cortado_gwh': 3.0} for x in pub]})
    J('way2_30min.json', {'dados': [{'nomeGrandeza': 'Demat', 'pontoId': p, 'valores': [{'data': f'{x}T{s}:00', 'valor': 300000.0 * sol(s) / (2 if p < 6198 else 24)}
                                                                                       for x in DIAS_ for s in SLOTS_]} for p in PONTOS_]})
    J('irr_plano_30min.json', {'serie': [{'t': f'{x}T{s}:00', 'gti_w_C': 950.0 * sol(s)} for x in DIAS_ for s in SLOTS_]})
    J('ons_restricao_2026_11.json', {'consolidado': [dict({'ts': f'{x} {s}:00', 'gref': 300.0 * sol(s)}, **({'lim': 200.0} if x == '2026-11-02' and '10:00' <= s < '12:00' else {}))
                                                     for x in pub for s in SLOTS_]})
    if iqony is None:
        return
    p = os.path.join(d, 'gestao__restricao_iqony.json')
    if iqony == 'quebrado':
        open(p, 'w', encoding='utf-8').write('{"versao": 1, "campos": ["dia", "h"')
        return
    ev = {'bom': _EV_BOM, 'velho': _EV_BOM, 'herdada': _EV_BOM[:1], 'nenhuma': _EV_BOM[:2], 'forma': _EV_BOM}[iqony]
    hora = '2026-11-03T12:00:00Z' if iqony == 'velho' else '2026-11-04T11:00:00Z'
    J('gestao__restricao_iqony.json', {'versao': 1, 'campos': CAMPOS_[::-1] if iqony == 'forma' else CAMPOS_, 'gerado_em': hora,
                                       'coletor': {'estado': coletor, 'ultimo_pulso': hora}, 'eventos': ev})


def roda_imagem(aprovado_src, dia, iqony='bom', pub=None, coletor='ok'):
    """o boletim do dia (tema claro) pela forja: (resumo, html sem estilo) ou (None, erro)"""
    import json
    import re
    import subprocess
    import prepara as P
    with tempfile.TemporaryDirectory() as d:
        forja(d, iqony, pub, coletor)
        io.open(os.path.join(d, 'boletim_ci.py'), 'w', encoding='utf-8').write(P.prepara(aprovado_src))
        env = dict(os.environ, BOLETIM_DIR=d, BOLETIM_LOGO=os.path.join(AQUI, 'logo_intrepid_800.png'), TEMA='claro', PYTHONPATH=AQUI, PYTHONIOENCODING='utf-8')
        try:
            r = subprocess.run([sys.executable, os.path.join(d, 'boletim_ci.py'), 'diario', dia], cwd=d, env=env, capture_output=True, text=True,
                               encoding='utf-8', timeout=120)   # RW-004
        except subprocess.TimeoutExpired:
            return None, 'o boletim passou de 120 s'
        if r.returncode:
            return None, 'o boletim estourou: ' + r.stderr[-300:]
        html = open(os.path.join(d, 'diario_claro.html'), encoding='utf-8').read()
        r = json.load(open(os.path.join(d, 'diario_claro_resumo.json'), encoding='utf-8'))
        r['_marca'] = os.path.exists(os.path.join(d, 'gestao__restricao_iqony.erro'))   # RW-006: o arquivo congelado deixa a rodada vermelha
        return r, re.sub(r'<style>.*?</style>', '', html, flags=re.S)


def vis(h):
    """o texto visível, um trecho por nó, sem a hora de geração"""
    import html as H
    import re
    v = ' | '.join(x for x in (H.unescape(t).strip() for t in re.findall(r'>([^<>]+)<', re.sub(r'</?(b|span)[^>]*>', '', h))) if x)
    return re.sub(r'gerado no SIGO em \d\d/\d\d/\d{4} \d\d:\d\d', 'gerado no SIGO em X', v)


CASOS_IMG = ('pub', 'ordens', 'nenhuma', 'herdada', 'semreg', 'mes0')


def ensaio_imagem(aprovado_src=None, so=CASOS_IMG):
    """os estados do ONS na imagem: publicado igual ao HEAD; pendente com ordens, sem ordem, herdada, sem o registro; mês sem dia publicado"""
    import hashlib
    src = aprovado_src if aprovado_src is not None else io.open(os.path.join(AQUI, 'boletim_aprovado.py'), encoding='utf-8').read()
    falhas = []
    ok = lambda c, m: falhas.append(m) if not c else None
    fila_ = carrega(FONTE)
    sem_traco = lambda v: [x for x in v.split(' | ') if '—' in x]
    if 'pub' in so:   # 1. publicado: o texto visível inteiro igual ao do HEAD, com as ordens da Iqony presentes
        for dia in ('2026-11-01', '2026-11-02'):
            r, h = roda_imagem(src, dia)
            if r is None:
                falhas.append('publicado %s: %s' % (dia, h)); continue
            sha = hashlib.sha256(vis(h).encode('utf-8')).hexdigest()
            ok(sha == OURO_VIS[dia], 'ONS publicado %s: o texto visível do dia publicado é o do HEAD (sha %s)' % (dia, sha[:12]))
            ok(r.get('ons_estado') == 'publicado' and 'ons-pendente' not in h and 'iq-degrau' not in h, 'ONS publicado %s: sem marca de pendente' % dia)
        if r is not None:
            ok('Impedido pelo ONS: 55,50 MWh' in fila_.texto('diario', r), 'ONS publicado: o texto diz o número apurado')
    if 'ordens' in so:   # 2. pendente com ordens
        r, h = roda_imagem(src, '2026-11-03')
        if r is None:
            return falhas + ['pendente com ordens: ' + h]
        v = vis(h)
        q = r.get('iqony') or {}
        ok(r.get('ons_estado') == 'pendente' and q.get('n') == 2 and q.get('h') == 2.3 and q.get('lmin') == 282.0, 'ONS pendente: as ordens da Iqony no resumo (%s)' % q)
        ok('Limitação do ONS · ordens da Iqony' in v and 'apuração do ONS pendente' in v, 'ONS pendente: o cartão mostra as ordens da Iqony e a apuração pendente')
        ok('Sem limitação' not in v and 'sem limite do ONS no dia' not in v, 'ONS pendente com ordens: nunca "sem limitação" na imagem')
        ok('ONS: 2 ordens de limitação recebidas pela Iqony, 2,3 h sob limite, mínimo 282 MW. Apuração do ONS pendente.' in v, 'ONS pendente: o fato relevante diz as ordens')
        ok(not sem_traco(v), 'nunca "—" dentro de frase: %s' % sem_traco(v)[:3])
        ok(h.count('class="ons-pendente"') == 1 and 'ONS pendente' in v, 'o dia pendente sai hachurado no dia a dia, com a legenda')
        ok(h.count('class="iq-degrau"') == 2 and h.count('class="iq-faixa"') == 2, 'a curva do dia leva o degrau das ordens da Iqony')
        ok('2,3 h sob ordens do ONS (Iqony), de 10:50 a 13:06; limite mínimo 282 MW; apuração do ONS pendente' in v, 'a curva do dia diz o período sob ordem')
        ok(h.count('class="iq-mini"') == 18, 'as miniaturas das usinas levam a faixa das ordens (9 usinas × 2 degraus): %d' % h.count('class="iq-mini"'))
        ok('referência do ONS' not in v and 'limite das ordens (Iqony)' in v, 'a legenda da curva pendente lista só o que está no gráfico')
        ok('>Dia 03/11<' not in h and '>Mês até 02/11<' in h, 'ONS pendente: a comparação regional e o motivo do dia somem (fica o mês até o último dia publicado)')
        ok('No ONS limitation' not in fila_.texto_en('diario', r) and 'Official figure pending' in fila_.texto_en('diario', r), 'ONS pendente: o texto do grupo')
        ok('2,0 h de restrição · 03/11 pendente' in v, 'ONS pendente: o impedido do mês avisa que o dia ainda não entrou')
        r, h = roda_imagem(src, '2026-11-03', coletor='parado')
        ok(r is not None and 'limite mínimo 282 MW · apuração do ONS pendente · coletor das ordens parado' in vis(h),
           'ONS pendente com ordens e coletor parado: o cartão das ordens leva a ressalva')
    if 'nenhuma' in so:   # 3. pendente, registro sem ordem no dia, coletor parado
        r, h = roda_imagem(src, '2026-11-03', 'nenhuma', coletor='parado')
        if r is None:
            return falhas + ['pendente sem ordem: ' + h]
        v = vis(h)
        ok(isinstance(r.get('iqony'), dict) and ' | nenhuma ordem | ' in ' | %s | ' % v and 'nenhuma ordem de limitação recebida no dia' in v
           and 'nenhuma ordem do ONS recebida no dia' in v, 'ONS pendente sem ordem: cartão, fato e curva dizem "nenhuma ordem" (não "registro indisponível")')
        ok('coletor das ordens parado' in v and 'coletor das ordens está parado' in v, 'ONS pendente sem ordem e coletor parado: a imagem leva a ressalva')
    if 'herdada' in so:   # 4. pendente, o dia começou sob a ordem da véspera
        r, h = roda_imagem(src, '2026-11-03', 'herdada')
        if r is None:
            return falhas + ['pendente herdada: ' + h]
        v, q = vis(h), r.get('iqony') or {}
        ok(q.get('n') == 0 and q.get('herdada') is True and q.get('h') == 14.0 and q.get('lmin') == 120.0
           and 'ONS: o dia começou sob a ordem do dia anterior, 14,0 h sob limite (Iqony). Apuração do ONS pendente.' in v,
           'ONS pendente sob a ordem da véspera: começou sob a ordem do dia anterior, 14,0 h, mínimo 120 MW (%s)' % {k: q.get(k) for k in ('n', 'herdada', 'h', 'lmin')})
        ok('Limitação do ONS · ordens da Iqony | 14,0 | h | limite mínimo 120 MW' in v and ' | nenhuma ordem | ' not in ' | %s | ' % v,
           'ONS pendente sob a ordem da véspera: o cartão mostra as 14,0 h sob ordem, nunca "nenhuma ordem"')
    if 'semreg' in so:   # 5. pendente sem o registro: sem o arquivo, ilegível, fora da forma, gravado antes do fim do dia
        for var in (None, 'quebrado', 'forma', 'velho'):
            r, h = roda_imagem(src, '2026-11-03', var)
            if r is None:
                falhas.append('pendente sem o registro (%s): %s' % (var, h)); continue
            v = vis(h)
            ok(r.get('ons_estado') == 'pendente' and r.get('iqony') is None and 'apuração pendente' in v and 'Sem limitação' not in v
               and 'nenhuma ordem' not in v and 'No ONS limitation' not in fila_.texto_en('diario', r),
               'ONS pendente sem o registro (%s): "apuração pendente", nunca "sem limitação" nem "nenhuma ordem"' % var)
            ok(r.get('_marca') == (var == 'velho'), 'sem o registro (%s): o arquivo congelado (e só ele) deixa a marca de erro para a rodada' % var)
    if 'mes0' in so:   # 6. o dia 1º lido no dia 2: nenhum dia do mês publicado
        r, h = roda_imagem(src, '2026-11-01', pub=[])
        if r is None:
            return falhas + ['mês sem dia publicado: ' + h]
        v = vis(h)
        ok(not sem_traco(v) and 'nenhum dia do mês apurado pelo ONS ainda' in v, 'mês sem dia publicado: nunca "—": %s' % sem_traco(v)[:3])
        ok('sem energia impedida' not in v and 'Mês até' not in v and 'Dia 01/11' not in v,
           'mês sem dia publicado: o motivo e a origem não dizem "sem energia impedida" nem "Mês até"')
    return falhas


# (nome, de, para, caso que roda, trecho do motivo que TEM de aparecer) · RE-009: o plantio reprova pela asserção dele
PLANTIOS_IMG = [
    ('o cartão volta a "0,0 h · sem limite" com o ONS pendente', "    if est == 'pendente':   # o ONS ainda não publicou: as ordens da Iqony", "    if False:   # o ONS ainda não publicou: as ordens da Iqony",
     'ordens', 'o cartão mostra as ordens'),
    ('o fato volta a "Sem limitação … —%" com o ONS pendente', "    if ONS_EST == 'pendente':\n        if IQD and IQD['h'] > 0 and IQD['n']:", "    if False:\n        if IQD and IQD['h'] > 0 and IQD['n']:",
     'ordens', 'nunca "sem limitação"'),
    ('dia pendente sem hachura', "        if pend: g.append(", "        if False: g.append(", 'ordens', 'hachurado'),
    ('o publicado vira pendente', "    if dia in ONS_DIAS: return 'publicado', None", "    if False: return 'publicado', None", 'pub', 'texto visível do dia publicado'),
    ('as ordens da Iqony valem com o ONS publicado', "    if dia in ONS_DIAS: return 'publicado', None", "    if dia in ONS_DIAS and not IQ: return 'publicado', None", 'pub', 'texto visível do dia publicado'),
    ('o número do ONS muda no cartão do dia publicado', "return kpi(CORTE, 'Impedido pelo ONS no dia', nf(ons, 2)", "return kpi(CORTE, 'Impedido pelo ONS no dia', nf(ons * .9, 2)", 'pub', 'texto visível do dia publicado'),
    ('o regional do dia fica com o ONS pendente', "bench([(f'Dia {ddmm(DIA)}', b_d), (f'Mês até {ddmm(DIA)}', b_m)]) if ONS_EST == 'publicado' else",
     "bench([(f'Dia {ddmm(DIA)}', b_d), (f'Mês até {ddmm(DIA)}', b_m)]) if True else", 'ordens', 'comparação regional e o motivo do dia somem'),
    ('sem o registro das ordens vira publicado', "    try: return 'pendente', _F.iqony_dia(IQ, dia)", "    try: return ('pendente', _F.iqony_dia(IQ, dia)) if IQ else ('publicado', None)", 'semreg', 'sem o registro (None)'),
    ('a curva do dia sem o degrau das ordens', "    dg = degraus_dia(dia)   # ONS pendente", "    dg = []   # ONS pendente", 'ordens', 'degrau das ordens'),
    ('as miniaturas sem a faixa das ordens', "    s += [f'<rect class=\"iq-mini\"", "    s += [] and [f'<rect class=\"iq-mini\"", 'ordens', 'miniaturas'),
    ('a legenda pendente volta a citar a referência do ONS', "    if ons_do_dia(dia)[0] == 'pendente':   # a legenda lista", "    if False:   # a legenda lista", 'ordens', 'legenda'),
    ('o cartão "nenhuma ordem" vira "apuração pendente"', "        if iq:\n            return kpi(CORTE, 'Limitação do ONS', '<span style=font-size:19px>nenhuma ordem</span>'",
     "        if False:\n            return kpi(CORTE, 'Limitação do ONS', '<span style=font-size:19px>nenhuma ordem</span>'", 'nenhuma', 'dizem "nenhuma ordem"'),
    ('o fato "nenhuma ordem" vira "registro indisponível"', "        elif IQD:\n            f.append(('◆', CORTE, 'ONS: <b>nenhuma ordem", "        elif False:\n            f.append(('◆', CORTE, 'ONS: <b>nenhuma ordem",
     'nenhuma', 'dizem "nenhuma ordem"'),
    ('o fato da ordem herdada some', "        elif IQD and IQD['h'] > 0:", "        elif False:", 'herdada', 'começou sob a ordem do dia anterior'),
    ('a ressalva do coletor parado some do fato', "        if IQD and IQD.get('coletor') == 'parado':   #", "        if False:   #", 'nenhuma', 'leva a ressalva'),
    ('as ordens fora da forma derrubam o diário', "    except (Exception, SystemExit) as e:   # noqa: BLE001  (fora da forma = sem o registro)",
     "    except ZeroDivisionError as e:   # noqa: BLE001  (fora da forma = sem o registro)", 'semreg', '(forma)'),
    ('as ordens ilegíveis derrubam o diário', "    except Exception as _e:   # noqa: BLE001  (ilegível", "    except ZeroDivisionError as _e:   # noqa: BLE001  (ilegível", 'semreg', '(quebrado)'),
    ('o arquivo congelado não deixa marca', "open(os.path.join(AQUI, 'gestao__restricao_iqony.erro'), 'w', encoding='utf-8').write(_m[:300])", "None", 'semreg', '(velho): o arquivo congelado'),
    ('o cartão da ordem herdada decide pelas ordens novas', "        if iq and iq['h'] > 0:", "        if iq and iq['n'] > 0:", 'herdada', 'o cartão mostra as 14,0 h'),
    ('o motivo do mês sem dia publicado volta a "sem energia impedida"', "[(f'Mês até {ddmm(ULT_ONS)}', dias_mes)] if ULT_ONS else [])", "[(f'Mês até {ddmm(ULT_ONS or DIA)}', dias_mes)])",
     'mes0', 'o motivo e a origem não dizem'),
    ('o impedido do mês esquece o dia pendente', "+ (f' · {ddmm(DIA)} pendente' if ONS_EST == 'pendente' else '')", "+ ''", 'ordens', 'o dia ainda não entrou'),
    ('o coletor parado some do cartão das ordens', "                       + (' · coletor das ordens parado' if iq.get('coletor') == 'parado' else ''))\n        if iq:",
     "                       + '')\n        if iq:", 'ordens', 'cartão das ordens leva a ressalva'),
    ('o mês sem dia publicado volta a "—%"', "bench([(f'Mês até {ddmm(ULT_ONS)}', b_m)]) if ULT_ONS else SEM_MES_ONS", "bench([(f'Mês até {ddmm(ULT_ONS or DIA)}', b_m)])", 'mes0', 'nunca "—"'),
]


PLANTIOS = [
    ('a meta do ML vira fato', "for u in ('Complexo', 'PPA'):", "for u in ('Complexo', 'PPA', 'ML'):"),
    ('o fato se repete', "if acum >= man['meta_mwh'] > antes and 'fato:' + fid not in feitos", "if acum >= man['meta_mwh'] > antes"),
    ('a guarda de "ONS apurou 0" some', "PROIBIDO = [re.compile(r'ONS\\s+apurou\\s+0', re.I), re.compile(r'apurou\\s+0[,.]?0*\\s*MWh', re.I)]", "PROIBIDO = []"),
    ('texto em português vai ao grupo', "    sem_portugues(n.get('texto', ''))   # ao grupo vai só inglês", "    pass   # ao grupo vai só inglês"),
    ('o estimado perde a marca', "return f'Limited by the ONS: ≈ {nf_en(ld[\"est\"])} MWh estimated", "return f'Limited by the ONS: {nf_en(ld[\"est\"])} MWh"),
    ('RD não emitido vai', "d.get('tipo') == 'RD' and d.get('emissao') == 'AP'", "d.get('tipo') == 'RD'"),
    ('RD se repete', "                if 'rd:' + d['codigo'] in feitos:\n                    continue\n", ""),
    ('o complemento volta', "            out.append(('diario', d))\n",
     "            out.append(('diario', d))\n        elif d in ons_dias and 'ons:' + d not in feitos:\n            out.append(('complemento', d))\n"),
    ('o diário sai antes das 08:00', "BOLETIM_HORA_DIARIO') or '08:00'", "BOLETIM_HORA_DIARIO') or '07:40'"),
    ('a disponibilidade parcial vira número', "else 'availability: ' + DISP_PENDENTE['en']", "else 'availability —%'"),
    ('o diário não se recupera', "for k in range(TETO_DIAS, 0, -1):", "for k in range(1, 0, -1):"),
    ('a recuperação não tem teto', "TETO_DIAS = 3 ", "TETO_DIAS = 30 "),
    ('a semeadura é ignorada', "if d >= desde and 'diario:' + d not in feitos:", "if 'diario:' + d not in feitos:"),
    ('o mensal só no dia 1º', "if hoje.day <= TETO_MENSAL_DIA and", "if hoje.day <= 1 and"),
    ('o barrado vira feito', "    if sobra:\n        return []\n", ""),
    ('rodada sem semeadura anda', "    if not isinstance(estado, dict) or not estado.get('semeado') or not estado.get('desde'):\n        raise SystemExit(", "    if False:\n        raise SystemExit("),
    ('a semeadura não poda a fila', "'itens': [], 'atualizado': quando}", "'itens': (estado or {}).get('itens_x', [{'id': 'velho'}]), 'atualizado': quando}"),
    ('feitos sem forma', "    if ruins:\n        raise SystemExit('RECUSADO: feitos fora da forma", "    if False:\n        raise SystemExit('RECUSADO: feitos fora da forma"),
    ('a espera vem ligada', "ESPERA_DIA_COMPLETO = os.environ.get('BOLETIM_ESPERA_DIA_COMPLETO') == '1'", "ESPERA_DIA_COMPLETO = True"),
    # boletim-ons-pendente
    ('ONS pendente com ordens diz "No ONS limitation"', "    if estado_ons(r) != 'publicado':\n        return linha_pendente(r, 'en')\n", ""),
    ('resumo sem o estado do ONS vale como publicado', "    if r.get('ons_estado') == 'publicado':\n        return 'publicado'", "    if r.get('ons_estado') in ('publicado', None):\n        return 'publicado'"),
    ('pendente sem ordem diz "sem limitação"', "    elif e == 'nenhuma':\n        s = ('ONS: nenhuma ordem de limitação recebida (apuração oficial pendente).' if idi == 'pt'\n             else 'ONS: no limitation order received (official figure pending).')",
     "    elif e == 'nenhuma':\n        s = 'Sem limitação do ONS no dia.' if idi == 'pt' else 'No ONS limitation on the day.'"),
    ('as horas da Iqony fora da conta da folha', "'h': round(sum(1 for v in L if v is not None) * 5 / 60, 1)", "'h': round(len(restr) * 0.5, 1)"),
    ('o evento em conflito entra', "    ords = CV.ordens(iq, dia)\n", "    ords = CV.ordens(dict(iq, eventos=[e[:7] + ['rdo'] + list(e[8:]) for e in iq.get('eventos') or []]), dia)\n"),
    ('o arquivo congelado antes do fim do dia vale', "    return bool(hs) and min(hs) >= lim", "    return True"),
    ('a ordem herdada fora das horas', "    L = [CV.limite_em(ords, CV.minuto(h)) for h in CV.SLOTS]", "    L = [CV.limite_em([o for o in ords if not o['herdada']], CV.minuto(h)) for h in CV.SLOTS]"),
    ('evento depois das 19:00 entra nos degraus', "    validas = [o for o in ords if o['min'] < fim_dia]", "    validas = list(ords)"),
    ('a ordem herdada vira "nenhuma ordem"', "if n else 'o dia começou sob a ordem do dia anterior'", "if n else 'nenhuma ordem de limitação'"),
    ('o aviso do coletor parado some em português', "        s += (' Aviso: o coletor das ordens está parado; podem faltar ordens.' if idi == 'pt'", "        s += ('' if idi == 'pt'"),
]


# o cron da manhã (o plantio troca o texto do workflow): uma passada só não cobre o atraso do agendador
PLANTIOS_WF = [
    ("só '1 11' de manhã", "    - cron: '31 11 * * *'      # 08:31: o agendador do GitHub atrasa de 30 a 90 min; a janela cobre\n    - cron: '1,31 12 * * *'    # 09:01 e 09:31\n", ''),
    ('o boletim.yml roda a imagem', 'ensaio_boletim.py --sem-imagem', 'ensaio_boletim.py'),
    ('o ensaio da imagem nunca falha (|| true)', 'ensaio_boletim.py --so-imagem', 'ensaio_boletim.py --so-imagem || true'),
    ('o ensaio da imagem desligado (if: false)', "        if: ${{ !cancelled() && steps.decide.outputs.pesado == 'true' }}\n        continue-on-error: true",
     "        if: false\n        continue-on-error: true"),
    ('a Rodada não recebe o ensaio da imagem', '          ENSAIO_IMG_OK: ${{ steps.ensaio_img.outcome }}\n', ''),
    ('o ensaio da imagem sem teto', '        timeout-minutes: 5\n', ''),
    ('o id do passo da imagem muda', '        id: ensaio_img\n', '        id: ensaio_imagem\n'),
    ('a Rodada antes do passo da imagem', '      - name: Ensaio · imagem do diário\n', '      - name: Rodada\n        run: true\n      - name: Ensaio · imagem do diário\n'),
]
PLANTIOS_ENS = [
    ('o ensaios.yml pula a imagem', 'python3 scripts/boletim/ensaio_boletim.py\n', 'python3 scripts/boletim/ensaio_boletim.py --sem-imagem\n'),
]


PLANTIOS_CURVAS = [
    ('a curva soma com ponto faltando', "arr.append(None if any(x is None for x in v) else sum(v))", "arr.append(sum(x or 0 for x in v))"),
    ('o dia em curso entra nas curvas', "        if hoje and d >= hoje:\n            continue\n", ""),
    ('as curvas esquecem a rodada anterior', "out = dias_validos(anterior)", "out = {}"),
    ('as curvas nunca envelhecem', "return not curvas.get('ate') or curvas['ate'] < ontem", "return False"),
    ('curvas anteriores fora da forma', "out = dias_validos(anterior)", "out = dict((anterior or {}).get('dias') or {})"),
    ('as curvas refazem toda rodada', "if hoje and curvas.get('tentado_em') == hoje:", "if False:"),
]


PLANTIOS_RODADA = [
    ('a falha das curvas derruba o diário', "except Exception as e:   # noqa: BLE001\n        erro_curvas", "except ZeroDivisionError as e:   # noqa: BLE001\n        erro_curvas"),
    ('a falha das curvas sai verde', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_iqony or erro_img:",
     "    if barrados or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_iqony or erro_img:"),
    ('a imagem reprovada sai verde sem diário', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_iqony or erro_img:",
     "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_iqony:"),
    ('a imagem reprovada gera o diário', "            if os.environ.get('ENSAIO_IMG_OK') not in (None, '', 'success', 'skipped'):   # RE-011",
     "            if False:   # RE-011"),
    ('a falha das ordens da Iqony sai verde', "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_iqony or erro_img:",
     "    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados or erro_img:"),
]


def ensaio_rodada_curvas(R=None):
    """a rodada com as curvas quebradas: o diário entra na fila e o estado é gravado; a falha das curvas sai vermelha no fim"""
    import json
    import curvas as C
    R = R or __import__('rodada')
    falhas = []
    ok = lambda c, m: falhas.append(m) if not c else None
    ex = executivo()
    for nome, prep, quebra, espera_rc in (
            ('curvas anteriores fora da forma', {'boletim__curvas.json': {'esquema': 1, 'slots': C.SLOTS, 'dias': 'x'}}, False, 0),
            ('as curvas estouram na rodada', {}, True, 1),
            ('as ordens da Iqony sem leitura (403)', {'gestao__restricao_iqony.erro': 'ordens da Iqony ausentes ou ilegíveis (AuthorizationPermissionMismatch)'}, False, 1),
            ('a imagem do diário reprovada', {}, False, 1),
            ('a imagem reprovada, só as curvas', {'boletim__estado.json': {'esquema': 1, 'feitos': ['diario:2026-11-06'], 'semeado': '2026-11-06T20:00', 'desde': '2026-11-06'}}, False, 1)):
        with tempfile.TemporaryDirectory() as d:
            arqs = dict({'boletim__estado.json': {'esquema': 1, 'feitos': [], 'semeado': '2026-11-06T20:00', 'desde': '2026-11-06'},
                         'boletim__fila.json': {'itens': []}, 'executivo.json': ex, 'irr_ufv.json': {'serie_dia': []},
                         'way2_30min.json': {'dados': [{'nomeGrandeza': 'Demat', 'pontoId': 6196, 'valores': [{'data': '2026-11-06T12:00:00', 'valor': 1.0}]}]}}, **prep)
            for k, v in arqs.items():
                json.dump(v, open(os.path.join(d, k), 'w', encoding='utf-8'))
            R.DIR, R.SAI = d, os.path.join(d, 'saida', 'boletim')
            gera0, monta0 = R.gera, R.C.monta
            R.gera = lambda modo, dia, render: ({'dia': dia, 'liq': 3000.0, 'meta_dia': 2000.0, 'limitado': {'h': 0, 'est': None}, 'pr': 80.0, 'disp': 99.0,
                                                 'complexo': {'pct': 20.0, 'proj_pct': 100}, 'ppa': {'pct': 20.0, 'proj_pct': 100}}, {}, [], 'boletim/diario/' + dia)
            if quebra:
                def _q(*a, **k):
                    raise ValueError('medição de mentira')
                R.C.monta = _q
            argv0, rc = sys.argv, 0
            img0 = os.environ.pop('ENSAIO_IMG_OK', None)
            if nome.startswith('a imagem'):
                os.environ['ENSAIO_IMG_OK'] = 'failure'
            sys.argv = ['rodada.py', '--agora', '2026-11-07T08:05', '--sem-render']
            os.environ.pop('BOLETIM_AGORA', None)
            try:
                with contextlib.redirect_stdout(io.StringIO()):   # o log da rodada não polui o veredito
                    R.main()
            except SystemExit as e:
                rc = e.code or 0
            except Exception as e:   # noqa: BLE001
                rc = 'estourou: %s' % e
            finally:
                sys.argv, R.gera, R.C.monta = argv0, gera0, monta0
                os.environ.pop('ENSAIO_IMG_OK', None)
                if img0 is not None:
                    os.environ['ENSAIO_IMG_OK'] = img0
            fl = os.path.join(d, 'saida', 'boletim', 'fila.json')
            fila = json.load(open(fl, encoding='utf-8')) if os.path.exists(fl) else {'itens': []}
            est = os.path.exists(os.path.join(d, 'saida', 'boletim', 'estado.json'))
            if nome.startswith('a imagem'):   # RW-010: sem diário, as curvas refeitas, o estado gravado e a saída vermelha
                cvs = os.path.exists(os.path.join(d, 'saida', 'boletim', 'curvas.json'))
                ok(not any(i['id'] == 'diario-2026-11-06' for i in fila['itens']) and cvs and est and rc == 1,
                   'rodada com %s: sem diário, curvas refeitas, estado gravado e saída 1 (diário %s, curvas %s, saiu %r)'
                   % (nome, any(i['id'] == 'diario-2026-11-06' for i in fila['itens']), cvs, rc))
                continue
            ok(any(i['id'] == 'diario-2026-11-06' for i in fila['itens']) and est and rc == espera_rc,
               'rodada com %s: o diário entra na fila, o estado é gravado e a saída é %s (saiu %r)' % (nome, espera_rc, rc))
    return falhas


def roda_plantios_img(falhas):
    """a imagem: o código real (falhas; None = pulada) e os plantios dela, cada um pela asserção dele. Devolve True = aprovado"""
    if falhas is None:
        return True
    for f in falhas:
        print('  FALHOU · imagem ·', f)
    bom = not falhas
    AP = io.open(os.path.join(AQUI, 'boletim_aprovado.py'), encoding='utf-8').read()
    for nome, de, para, caso, motivo in PLANTIOS_IMG:
        if AP.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); bom = False; continue
        try:
            f = ensaio_imagem(AP.replace(de, para), (caso,))
        except Exception as e:   # noqa: BLE001
            f = ['quebrou: %s' % e]
        pelo = [x for x in f if motivo in x]
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % pelo[0][:110] if pelo else
                                      ('REPROVADO POR OUTRO MOTIVO (%s)' % f[0][:110] if f else 'PASSOU — o ensaio não pega')))
        bom &= bool(pelo)
    print('imagem do diário:', 'APROVADA' if bom else 'REPROVADA')
    return bom


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    if SO_IMAGEM:
        sys.exit(0 if roda_plantios_img(ensaio_imagem()) else 1)
    falhas = casos(carrega(FONTE)) + ensaio_prepara() + ensaio_guarda_pt() + ensaio_rodada_curvas() + ([] if SEM_IMAGEM else ensaio_imagem())
    if SEM_IMAGEM:
        print('a imagem do diário fica para o passo próprio (--so-imagem) e o ensaios.yml (--sem-imagem)')
    for f in falhas:
        print('  FALHOU ·', f)
    print('código real:', 'APROVADO' if not falhas else 'REPROVADO (%d)' % len(falhas))
    ruim = bool(falhas)
    for nome, de, para in PLANTIOS:
        if FONTE.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        try:
            f = casos(carrega(FONTE.replace(de, para)))
        except Exception as e:
            f = ['quebrou: %s' % e]
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0] if f else 'PASSOU — o ensaio não pega'))
        ruim |= not f
    # as curvas da página: o plantio vai no curvas.py (o ensaio importa o módulo pelo nome)
    CV = io.open(os.path.join(AQUI, 'curvas.py'), encoding='utf-8').read()
    for nome, de, para in PLANTIOS_CURVAS:
        if CV.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        sys.modules['curvas'] = carrega(CV.replace(de, para), 'curvas')
        try:
            f = casos(carrega(FONTE))
        except Exception as e:
            f = ['quebrou: %s' % e]
        finally:
            del sys.modules['curvas']
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0] if f else 'PASSOU — o ensaio não pega'))
        ruim |= not f
    # a rodada: o plantio vai no rodada.py (a falha das curvas deixa de ser contida)
    RD = io.open(os.path.join(AQUI, 'rodada.py'), encoding='utf-8').read()
    for nome, de, para in PLANTIOS_RODADA:
        if RD.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        m = types.ModuleType('rodada'); m.__file__ = os.path.join(AQUI, 'rodada.py')
        exec(compile(RD.replace(de, para), 'rodada', 'exec'), m.__dict__)
        try:
            f = ensaio_rodada_curvas(m)
        except Exception as e:   # noqa: BLE001
            f = ['quebrou: %s' % e]
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0][:110] if f else 'PASSOU — o ensaio não pega'))
        ruim |= not f
    ruim |= not roda_plantios_img(None if SEM_IMAGEM else [])   # a imagem (boletim-ons-pendente): o plantio vai no boletim_aprovado.py
    # o cron da manhã: o plantio vai no texto do boletim.yml
    global WF_TEXTO
    wf0 = io.open(WF, encoding='utf-8').read()
    for nome, de, para in PLANTIOS_WF:
        if wf0.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        WF_TEXTO = wf0.replace(de, para)
        try:
            f = casos(carrega(FONTE))
        finally:
            WF_TEXTO = None
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0] if f else 'PASSOU — o ensaio não pega'))
        ruim |= not f
    global ENS_TEXTO
    en0 = io.open(ENS, encoding='utf-8').read()
    for nome, de, para in PLANTIOS_ENS:
        if en0.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        ENS_TEXTO = en0.replace(de, para)
        try:
            f = casos(carrega(FONTE))
        finally:
            ENS_TEXTO = None
        print('  plantio "%s": %s' % (nome, 'reprovado, como devia (%s)' % f[0] if f else 'PASSOU — o ensaio não pega'))
        ruim |= not f
    print('ensaio do boletim:', 'REPROVADO' if ruim else 'APROVADO')
    sys.exit(1 if ruim else 0)


if __name__ == '__main__':
    main()
