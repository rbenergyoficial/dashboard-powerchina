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
    ok(F.tarefas(h('2026-11-07T07:39'), {'feitos': []}, set()) == [], 'antes das 07:40 não gera o diário')
    ok(F.tarefas(h('2026-11-07T07:41'), {'feitos': []}, set()) == [('diario', '2026-11-06')], 'às 07:41 gera o diário de ontem')
    ok(F.tarefas(h('2026-11-07T09:00'), {'feitos': ['diario:2026-11-06']}, set()) == [], 'diário feito não se repete')
    # o complemento saiu do plano (humano, 07/11/2026): com o ONS publicado, a qualquer hora, nada além do diário de uma vez
    pub = {'2026-11-04', '2026-11-05', '2026-11-06'}
    ok(all(m != 'complemento' for hr in range(24) for m, _ in F.tarefas(h('2026-11-07T%02d:05' % hr), {'feitos': ['diario:2026-11-06']}, pub)),
       'o complemento voltou: o diário sai uma vez por dia, sem segunda edição quando o ONS publica')
    ok(F.tarefas(h('2026-11-07T17:35'), {'feitos': ['diario:2026-11-06']}, pub) == [], 'à tarde, com o ONS publicado, nada novo')
    ok(('mensal', '2026-10-31') in F.tarefas(h('2026-11-01T07:45'), {'feitos': []}, set()), 'mensal no dia 1º')
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
    r = {'dia': '2026-11-06', 'liq': 3068.07, 'meta_dia': 2066.67, 'ons_mwh': 0, 'limitado': {'h': 5.5, 'est': 36.82}, 'pr': 75.1, 'disp': 99.96,
         'complexo': {'pct': 22.1, 'proj_pct': 110}, 'ppa': {'pct': 30.1, 'proj_pct': 151}}
    t = F.texto_en('diario', r)
    ok('≈ 36.82 MWh estimated' in t, 'limitação sem apuração do ONS sai "≈ X MWh estimated"')
    ok('apurou' not in t and 'curtailed 0' not in t.lower(), 'nada de "ONS apurou 0"')
    ok('No ONS limitation' in F.texto_en('diario', dict(r, limitado={'h': 0, 'est': None})), 'sem limitação no dia')
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
    ok(('mensal', '2026-09-30') in F.tarefas(h('2026-10-01T07:45'), {'feitos': []}, set()), 'sem RD emitido, o mensal sai assim mesmo')
    # recuperação: dias anteriores não feitos (até o teto), nunca antes da semeadura; mensal até o dia 5
    ok(F.tarefas(h('2026-11-09T07:45'), {'feitos': ['diario:2026-11-06'], 'desde': '2026-11-06'}, set())
       == [('diario', '2026-11-07'), ('diario', '2026-11-08')], 'a rodada que não rodou se recupera (07 e 08/11, o mais antigo primeiro)')
    ok(F.tarefas(h('2026-11-20T07:45'), {'feitos': [], 'desde': '2026-11-01'}, set())
       == [('diario', '2026-11-17'), ('diario', '2026-11-18'), ('diario', '2026-11-19')], 'a recuperação tem teto de 3 dias')
    ok(F.tarefas(h('2026-11-08T07:45'), {'feitos': [], 'desde': '2026-11-07'}, set()) == [('diario', '2026-11-07')],
       'nada anterior à semeadura sai')
    ok(F.tarefas(h('2026-11-08T06:30'), {'feitos': [], 'desde': '2026-11-06'}, set()) == [('diario', '2026-11-06')],
       'antes das 07:40 só recupera dia anterior a ontem')
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
    ok(F.ESPERA_DIA_COMPLETO is False and F.HORA_DIARIO == '07:40', 'a espera do dia completo fica desligada e o diário às 07:40 (decisão do humano)')
    # a disponibilidade do dia que ainda não chegou: "apuração às 10h", nunca um número parcial nem "—%"
    r0 = {'dia': '2026-11-07', 'liq': 2328.62, 'meta_dia': 2066.67, 'limitado': {'h': 0, 'est': None}, 'pr': 81.2, 'disp': None,
          'complexo': {'pct': 22.1, 'proj_pct': 110}, 'ppa': {'pct': 30.1, 'proj_pct': 151}}
    te, tp = F.texto_en('diario', r0), F.texto('diario', r0)
    ok('Availability: computed at 10h' in te.replace('· availability', '· Availability') and '—' not in te and 'apuração às 10h' in tp, 'disponibilidade ausente vira "computed at 10h" / "apuração às 10h"')
    ok('availability 99.87%' in F.texto_en('diario', dict(r0, disp=99.87)), 'disponibilidade presente sai com o número')
    # o cron do boletim.yml cobre o horário do diário (a hora vive num lugar só; o cron tem de acompanhar)
    wf = os.path.join(AQUI, '..', '..', '.github', 'workflows', 'boletim.yml')
    if os.path.exists(wf):
        ps = passadas_brt(io.open(wf, encoding='utf-8').read())
        hm = int(F.HORA_DIARIO[:2]) * 60 + int(F.HORA_DIARIO[3:])
        dep = [p for p in ps if p >= hm - 5]
        ok(dep and dep[0] <= hm + 10 and max(ps) >= hm + 80,
           'a janela do cron cobre o diário das %s (passadas: %s)' % (F.HORA_DIARIO, ' '.join('%02d:%02d' % divmod(p, 60) for p in ps)))
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


PLANTIOS = [
    ('a meta do ML vira fato', "for u in ('Complexo', 'PPA'):", "for u in ('Complexo', 'PPA', 'ML'):"),
    ('o fato se repete', "if acum >= man['meta_mwh'] > antes and 'fato:' + fid not in feitos", "if acum >= man['meta_mwh'] > antes"),
    ('a guarda de "ONS apurou 0" some', "PROIBIDO = [re.compile(r'ONS\\s+apurou\\s+0', re.I), re.compile(r'apurou\\s+0[,.]?0*\\s*MWh', re.I)]", "PROIBIDO = []"),
    ('texto em português vai ao grupo', "        sem_portugues(n.get('texto', ''))", "        pass"),
    ('o estimado perde a marca', "return f'Limited by the ONS: ≈ {nf_en(ld[\"est\"])} MWh estimated", "return f'Limited by the ONS: {nf_en(ld[\"est\"])} MWh"),
    ('RD não emitido vai', "d.get('tipo') == 'RD' and d.get('emissao') == 'AP'", "d.get('tipo') == 'RD'"),
    ('RD se repete', "            if 'rd:' + d['codigo'] in feitos:\n                continue\n", ""),
    ('o complemento volta', "            out.append(('diario', d))\n",
     "            out.append(('diario', d))\n        elif d in ons_dias and 'ons:' + d not in feitos:\n            out.append(('complemento', d))\n"),
    ('o diário sai antes das 07:40', "BOLETIM_HORA_DIARIO') or '07:40'", "BOLETIM_HORA_DIARIO') or '07:00'"),
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
    ('a falha das curvas derruba o diário', "except Exception as e:   # noqa: BLE001\n            erro_curvas", "except ZeroDivisionError as e:   # noqa: BLE001\n            erro_curvas"),
    ('a falha das curvas sai verde', "    if barrados or erro_curvas:", "    if barrados:"),
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
            ('as curvas estouram na rodada', {}, True, 1)):
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
            sys.argv = ['rodada.py', '--agora', '2026-11-07T07:45', '--sem-render']
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
            fl = os.path.join(d, 'saida', 'boletim', 'fila.json')
            fila = json.load(open(fl, encoding='utf-8')) if os.path.exists(fl) else {'itens': []}
            est = os.path.exists(os.path.join(d, 'saida', 'boletim', 'estado.json'))
            ok(any(i['id'] == 'diario-2026-11-06' for i in fila['itens']) and est and rc == espera_rc,
               'rodada com %s: o diário entra na fila, o estado é gravado e a saída é %s (saiu %r)' % (nome, espera_rc, rc))
    return falhas


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    falhas = casos(carrega(FONTE)) + ensaio_prepara() + ensaio_guarda_pt() + ensaio_rodada_curvas()
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
    print('ensaio do boletim:', 'REPROVADO' if ruim else 'APROVADO')
    sys.exit(1 if ruim else 0)


if __name__ == '__main__':
    main()
