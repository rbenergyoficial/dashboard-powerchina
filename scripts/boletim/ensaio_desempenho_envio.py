# -*- coding: utf-8 -*-
"""Ensaio do desempenho_envio.py (lote desempenho-envio, 20/11/2026).

Parte 1 · dados fabricados, com o resultado conhecido de antemão (não depende de blob, hora nem rede):
  C1 referência pela soma das usinas na meia hora que o ONS publicou errada;  C2 dias excluídos fora da frustrada e das horas;
  C3 dia que o ONS ainda não publicou sai PENDENTE, nunca "0,00 MWh" nem "sem limitação", e leva a conferência do dia anterior;
  C4 a guarda do texto barra português e texto acima de 2000 caracteres;  C5 o mensal recusa mês aberto;
  C6 o P50 lido do boletim_aprovado.py que não soma 998,416 GWh é recusado;  C7 Real × P50 e × P90 do mensal na conta da página;
  C8 os dois textos (diário e mensal) passam na guarda e cabem.
Parte 2 · defeitos PLANTADOS, um de cada vez: o ensaio só passa se cada um reprovar ao menos uma conferência.
Parte 3 (opcional, --real <pasta>) · os dados reais: a frustrada e as horas de cada mês e de cada dia batem com o executivo.json.

Uso: python ensaio_desempenho_envio.py [--real <pasta das entradas>]      sai 1 se algo reprovar.
"""
import json
import os
import sys
import tempfile

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import desempenho_envio as DE  # noqa: E402

# P50 de mentira (soma 998,416 como o verdadeiro, valores inventados): o ensaio não leva o P50 do projeto
P50_FALSO = {f'{m:02d}': 80.0 for m in range(1, 12)}
P50_FALSO['12'] = round(998.416 - 880.0, 3)


def linha(ts, ger, lim, gref, razao='ENE'):
    return {'ts': ts, 'ger': str(ger), 'lim': '' if lim is None else str(lim), 'disp': '340', 'gref': str(gref), 'razao': razao if lim else '', 'orig': 'SIS' if lim else '', 'dsc': ''}


def monta(pasta, boletim, soma_p50=None):
    os.makedirs(pasta, exist_ok=True); os.makedirs(boletim, exist_ok=True)
    p50 = dict(P50_FALSO)
    if soma_p50 is not None:
        p50['12'] = round(soma_p50 - 880.0, 3)
    open(os.path.join(boletim, 'boletim_aprovado.py'), 'w', encoding='utf-8').write(
        'PV_P50 = %r\nP90_FATOR = 959.0 / 998.416\n' % p50)
    ex = {'ref_conjunto_pela_soma': [{'ts': '2026-10-05 10:00', 'gref_publicado': 0, 'ger': 250, 'soma_usinas': 300}],
          'serie': [{'mes': '2026-10', 'dias': 31, 'w2_dias_completos': 30, 'disp_pct': 98.5, 'disp_cobertura_pct': 99.0}],
          'manchete_ufv': [{'mes': '2026-10', 'ufv': 'Complexo', 'fechado': 1, 'liq_gwh': '60.00', 'liq_fechada_gwh': '60.0000'},
                           {'mes': '2026-11', 'ufv': 'Complexo', 'fechado': 0, 'liq_gwh': '40.00', 'liq_fechada_gwh': '40.0000'}]}
    json.dump(ex, open(os.path.join(pasta, 'executivo.json'), 'w', encoding='utf-8'))
    # out/26: 05/10 com a meia hora errada (10:00, gref 0 → soma 300: perda 25) + uma normal (10:30: perda 30) + uma sem limitação
    out = [linha('2026-10-05 10:00:00', 250, 260, 0), linha('2026-10-05 10:30:00', 200, 210, 260, 'CNF'), linha('2026-10-05 11:00:00', 300, None, 320)]
    out += [linha(f'2026-10-{d:02d} 12:00:00', 300, None, 300) for d in range(1, 32) if d != 5]
    json.dump({'consolidado': out}, open(os.path.join(pasta, 'ons_restricao_2026_10.json'), 'w', encoding='utf-8'))
    # mar/26: 03/03 excluído (limitação com perda 40 que NÃO entra) e 04/03 normal (perda 25)
    mar = [linha('2026-03-03 10:00:00', 100, 120, 180), linha('2026-03-04 10:00:00', 100, 120, 150)]
    json.dump({'consolidado': mar}, open(os.path.join(pasta, 'ons_restricao_2026_03.json'), 'w', encoding='utf-8'))
    # nov/26: o ONS publicou até 18/11 (48 meias horas, 2 com limitação no 18: perda 10 + 15); 19/11 ainda não
    nov = []
    for d in range(1, 19):
        for s in range(48):
            ts = f'2026-11-{d:02d} {s // 2:02d}:{30 * (s % 2):02d}:00'
            lim = 200 if d == 18 and s in (20, 21) else None
            nov.append(linha(ts, 180 if lim else 0, lim, (200 if s == 20 else 210) if lim else 0))
    json.dump({'consolidado': nov}, open(os.path.join(pasta, 'ons_restricao_2026_11.json'), 'w', encoding='utf-8'))
    est = {'serie': [{'u': u, 'd': f'2026-10-{d:02d}', 'n': 144 if not (u == 'M3' and d == 7) else 120} for u in DE.UFV for d in range(1, 32)]
           + [{'u': u, 'd': '2026-11-19', 'n': 144} for u in DE.UFV]}
    json.dump(est, open(os.path.join(pasta, 'estacao_dia.json'), 'w', encoding='utf-8'))
    json.dump({'resumo': {'total': 24, 'ok': 24, 'atraso': 0, 'falha': 0}}, open(os.path.join(pasta, 'way2_saude.json'), 'w', encoding='utf-8'))


def confere(raiz):
    """devolve a lista de conferências reprovadas (vazia = tudo certo)"""
    pasta, bol = os.path.join(raiz, 'bd'), os.path.join(raiz, 'boletim')
    monta(pasta, bol)
    falhas = []

    def ok(cond, msg):
        if not cond:
            falhas.append(msg)

    ex = json.load(open(os.path.join(pasta, 'executivo.json'), encoding='utf-8'))
    o = DE.ons_mes(json.load(open(os.path.join(pasta, 'ons_restricao_2026_10.json'), encoding='utf-8')), DE.pela_soma(ex))
    ok(abs(o['fru'] - 55.0) < 1e-9 and o['n'] == 2, 'C1 out/26: frustrada %.2f MWh em %d meias horas (esperado 55,00 em 2)' % (o['fru'], o['n']))
    m = DE.ons_mes(json.load(open(os.path.join(pasta, 'ons_restricao_2026_03.json'), encoding='utf-8')), DE.pela_soma(ex))
    ok(abs(m['fru'] - 25.0) < 1e-9 and m['n'] == 1, 'C2 mar/26: frustrada %.2f MWh em %d meias horas (esperado 25,00 em 1: o 03/03 fica fora)' % (m['fru'], m['n']))

    D = DE.dados_diario(pasta, '2026-11-19', '2026-11-20T08:00', bol)
    en = DE.texto_diario(D, 'en')
    ok(D['hoje']['publicado'] is False and 'pending' in en, 'C3 o 19/11 (fora do arquivo do ONS) não saiu pendente')
    ok('ONS curtailment on 19 Nov\n- ONS open data' not in en and 'no half hour with limitation' not in en.split('Check of')[0],
       'C3 o 19/11 saiu como dado do ONS (zero ou sem limitação) antes de o ONS publicar')
    ok('Check of 18 Nov' in en and '25.00 MWh frustrated in 1.0 h' in en, 'C3 a conferência do 18/11 não saiu com 25,00 MWh em 1,0 h')
    ok('No record of the ONS orders' in en, 'C3 sem o arquivo da Iqony o texto não disse "sem registro das ordens"')
    # com as ordens da Iqony (a conta é a do fila.iqony_dia do Boletim; aqui só o texto)
    orig = DE.ordens_iqony
    DE.ordens_iqony = lambda iq, d, b: ('ordens', {'h': 2.5, 'ini': '09:10', 'fim': '11:40', 'lmin': 200, 'motivos': ['ENE_FREQ']})
    try:
        en2 = DE.texto_diario(DE.dados_diario(pasta, '2026-11-19', '2026-11-20T08:00', bol), 'en')
    finally:
        DE.ordens_iqony = orig
    ok('2.5 h under order, 09:10 to 11:40, lowest limit 200 MW (energy, frequency control)' in en2, 'C3 as ordens da Iqony não saíram no texto')
    ok('Difference in hours (orders − ONS): +1.5 h' in en2, 'C3 a diferença ordens − ONS do 18/11 não é +1,5 h')

    ok(DE.confere_en('Generation of the dia') != [] and DE.confere_en('x' * 2001) != [] and DE.confere_en('Fine text.') == [],
       'C4 a guarda do texto não barra português ou texto longo')

    try:
        DE.dados_mensal(pasta, '2026-11', '2026-11-20T08:00', bol)
        falhas.append('C5 o mensal de nov/26 saiu com o mês aberto')
    except SystemExit:
        pass

    bol2 = os.path.join(raiz, 'boletim_errado')
    monta(os.path.join(raiz, 'bd2'), bol2, soma_p50=990.0)
    try:
        DE.p50_do_boletim(os.path.join(bol2, 'boletim_aprovado.py'))
        falhas.append('C6 o P50 que soma 990 GWh foi aceito')
    except SystemExit:
        pass

    M = DE.dados_mensal(pasta, '2026-10', '2026-11-01T08:00', bol)
    k, p50 = M['k'], P50_FALSO['10']
    ok(abs(k['real_p50'] - 60.0 / p50 * 100) < 1e-9 and abs(k['real_p50_imp'] - (60.0 + 0.055) / p50 * 100) < 1e-9,
       'C7 Real × P50 de out/26 fora da conta da página')
    ok(abs(k['real_p90'] - 60.0 / (p50 * 959.0 / 998.416) * 100) < 1e-9, 'C7 Real × P90 de out/26 fora da conta da página')
    ok(abs(k['fru_mwh'] - 55.0) < 1e-9 and k['horas'] == 1.0, 'C7 o mensal não leva a frustrada e as horas do C1')
    ok(any(x['dia'] == '2026-10-07' and ('M3', 'est', 120) in [tuple(e) for e in x['exc']] for x in M['linhas']),
       'C7 a estação de M3 com 120 de 144 em 07/10 não ficou a justificar')

    try:   # a guarda da rodada (fila.valida_item: "ONS apurou 0" e o português do traduz_en), quando o ensaio roda dentro de scripts/boletim/
        import fila as F
    except ImportError:
        F = None
    for nome, t in (('diário', en), ('diário com ordens', en2), ('mensal', DE.texto_mensal(M, 'en'))):
        ok(DE.confere_en(t) == [], 'C8 o %s em inglês reprova na guarda: %s' % (nome, DE.confere_en(t)))
        if F is not None:
            try:
                F.valida_item({'texto': t})
            except SystemExit as e:
                falhas.append('C8 o %s em inglês reprova na guarda da rodada: %s' % (nome, str(e)[:120]))
    ok(DE.PORTUGUES.search(DE.texto_mensal(M, 'pt')) is not None, 'C8 o texto em português não tem português (a guarda não serve)')

    # C9 o calendário da rodada: nada sem a semeadura; diário de ontem só a partir das 08:00 e uma vez; mensal nos dias 1 a 3
    import datetime as dt
    t = lambda s: dt.datetime.fromisoformat(s)
    est = {'desempenho_desde': '2026-11-21', 'feitos': []}
    ok(DR.tarefas(t('2026-11-25T09:00'), {'feitos': []}) == [], 'C9 sem a semeadura saiu tarefa (inundaria o grupo)')
    ok(DR.tarefas(t('2026-11-25T07:59'), est) == [], 'C9 o diário saiu antes das 08:00')
    ok(DR.tarefas(t('2026-11-25T08:01'), est) == [('desempenho-diario', '2026-11-24')], 'C9 o diário de 24/11 não saiu às 08:01 de 25/11')
    ok(DR.tarefas(t('2026-11-25T08:31'), dict(est, feitos=['desempenho-diario:2026-11-24'])) == [], 'C9 o diário feito saiu de novo')
    ok(DR.tarefas(t('2026-11-21T09:00'), est) == [], 'C9 saiu o diário de um dia anterior à semeadura')
    ok(('desempenho-mensal', '2026-11') in DR.tarefas(t('2026-12-01T08:01'), est), 'C9 o mensal de nov/26 não saiu em 01/12')
    ok(all(m != 'desempenho-mensal' for m, _ in DR.tarefas(t('2026-12-04T08:01'), est)), 'C9 o mensal saiu depois do dia 3')
    ok(all(m != 'desempenho-mensal' for m, _ in DR.tarefas(t('2026-11-01T09:00'), dict(est, desempenho_desde='2026-11-01'))),
       'C9 saiu o mensal de um mês anterior à semeadura')
    it = DR.gera_item(pasta, os.path.join(raiz, 'saida', 'boletim'), 'desempenho-diario', '2026-11-19', t('2026-11-20T08:01'), bol)
    ok(it['id'] == 'desempenho-diario-2026-11-19' and it['texto'] == en and it['arquivos'] == [] and DE.confere_en(it['texto']) == [],
       'C9 o item do diário fora da forma da fila')
    return falhas


import desempenho_rodada as DR  # noqa: E402

DEFEITOS = {
    'referência do conjunto como o ONS publicou (sem a soma das usinas)': (DE, 'pela_soma', lambda ex: {}),
    'dias excluídos de volta na conta': (DE, 'DIAS_EXCLUIDOS', set()),
    'dia fora do arquivo do ONS tratado como publicado': (DE, 'publicado', lambda n: True),
    'guarda do texto desligada': (DE, 'confere_en', lambda t: []),
    'meia hora contada como 1 h': (DE, 'H', 1.0),
    'diário antes das 08:00': (DR, 'HORA_DIARIO', '00:00'),
}


def parte_real(pasta):
    """a frustrada e as horas da conta da página contra o executivo.json, mês a mês e dia a dia, nos meses que há arquivo do ONS"""
    falhas, n = [], 0
    ex = json.load(open(os.path.join(pasta, 'executivo.json'), encoding='utf-8-sig'))
    ps, serie = DE.pela_soma(ex), {s['mes']: s for s in ex.get('serie') or []}
    dia_ex = {d['dia']: d for d in ex.get('serie_diaria') or []}
    for f in sorted(os.listdir(pasta)):
        if not (f.startswith('ons_restricao_') and f.endswith('.json')):
            continue
        m = f[14:21].replace('_', '-')
        o = DE.ons_mes(json.load(open(os.path.join(pasta, f), encoding='utf-8-sig')), ps)
        s = serie.get(m)
        if s and s.get('frustrada_mwh') is not None:
            n += 1
            if abs(o['fru'] - s['frustrada_mwh']) > 0.01 or abs(o['n'] * 0.5 - s['horas_restricao']) > 0.5:
                falhas.append('%s: %.2f MWh e %.1f h; o executivo tem %.2f MWh e %s h' % (m, o['fru'], o['n'] * .5, s['frustrada_mwh'], s['horas_restricao']))
            print('  %s: %s MWh, %.1f h (executivo %s MWh, %s h)' % (m, f'{o["fru"]:,.2f}', o['n'] * .5, f'{s["frustrada_mwh"]:,.2f}', s['horas_restricao']))
        for d, pd in sorted(o['por_dia'].items()):
            e = dia_ex.get(d)
            if e and d not in DE.DIAS_EXCLUIDOS:
                n += 1
                if abs(pd['fru'] - e['cortado_mwh']) > 0.01 or abs(pd['n'] * 0.5 - e['horas_restricao']) > 1e-9:
                    falhas.append('%s: %.2f MWh e %.1f h; o executivo tem %s MWh e %s h' % (d, pd['fru'], pd['n'] * .5, e['cortado_mwh'], e['horas_restricao']))
    print('  %d comparações com o executivo, %d divergência(s)' % (n, len(falhas)))
    return falhas if n else ['nenhuma comparação feita (faltam os arquivos do ONS ou o executivo)']


def main():
    reprovou = False
    with tempfile.TemporaryDirectory() as raiz:
        f = confere(os.path.join(raiz, 'limpo'))
        print('Parte 1 · conferências no código como está:', 'APROVADO' if not f else 'REPROVADO')
        for x in f:
            print('  ✗', x)
        reprovou |= bool(f)
        print('Parte 2 · defeitos plantados:')
        for i, (nome, (mod, attr, valor)) in enumerate(DEFEITOS.items()):
            antes = getattr(mod, attr)
            setattr(mod, attr, valor)
            try:
                try:
                    fd = confere(os.path.join(raiz, 'defeito%d' % i))
                except (Exception, SystemExit) as e:   # noqa: BLE001 (quebrar também é reprovar)
                    fd = ['quebrou: %s' % str(e)[:120]]
            finally:
                setattr(mod, attr, antes)
            print('  %s %s → %d conferência(s) reprovada(s)%s' % ('✓' if fd else '✗', nome, len(fd), (': ' + fd[0]) if fd else ' (O ENSAIO NÃO PEGOU)'))
            reprovou |= not fd
    if '--real' in sys.argv:
        print('Parte 3 · dados reais contra o executivo.json:')
        fr = parte_real(sys.argv[sys.argv.index('--real') + 1])
        for x in fr:
            print('  ✗', x)
        reprovou |= bool(fr)
    print('ENSAIO', 'REPROVADO' if reprovou else 'APROVADO')
    sys.exit(1 if reprovou else 0)


if __name__ == '__main__':
    main()
