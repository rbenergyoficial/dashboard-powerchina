# -*- coding: utf-8 -*-
"""Boletim de Desempenho · ensaio da TELA EXECUTIVA (lote boletim-pdf-executivo). Sem rede e sem navegador: Python e Node.
Roda o cálculo aprovado sobre a forja do ensaio_boletim.py (os mesmos dias e estados do ONS), extrai o dado da tela, monta o HTML e lê o
que ela escreve (tela_dom.js). Cada regra tem o caso que ela existe para RECUSAR e um PLANTIO (o código com a trava arrancada) que tem
de reprovar pelo motivo dele.

Regras ensaiadas:
  · o estado do ONS é um só, o do texto do WeCom: publicado, pendente com ordens, com ordem herdada, sem ordem, sem o registro;
  · com o ONS pendente a tela nunca diz "sem limite", não desenha potencial nem energia não gerada, mostra o degrau das ordens da
    Iqony, hachura o dia no dia a dia e avisa na ponte do mês; dia pendente nunca conta como dia sem corte no PR por usina;
  · o "PR sem o corte" POR USINA não existe na tela nem no diário (só o número do complexo);
  · a disponibilidade que ainda não chegou sai como a frase do texto do WeCom, nunca um número;
  · o arquivo é fechado (fonte e logotipo embutidos, nenhum pedido de rede) e a versão em inglês não leva português;
  · a tela é um ANEXO: vai junto das partes e do PDF; se a guarda ou este ensaio reprovam, o boletim vai sem ela e a rodada sai vermelha.
    python ensaio_tela.py"""
import io
import json
import os
import subprocess
import sys
import tempfile
import types

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import ensaio_boletim as EB  # noqa: E402  (a forja dos dias e dos estados do ONS)
import prepara as P  # noqa: E402
import tela as TL  # noqa: E402

LE = lambda *p: io.open(os.path.join(AQUI, *p), encoding='utf-8').read()   # noqa: E731
APROVADO, MODELO, EXTRAI, TELA_PY, RODADA = LE('boletim_aprovado.py'), LE('tela.src.html'), LE('tela_extrai.py'), LE('tela.py'), LE('rodada.py')
PREPARA = LE('prepara.py')
WF = LE('..', '..', '.github', 'workflows', 'boletim.yml')
# caso: (dia, ordens da Iqony na forja, dias que o ONS publicou, coletor, estado esperado)
CASOS = {'pub': ('2026-11-02', 'bom', None, 'ok', 'publicado'), 'ordens': ('2026-11-03', 'bom', None, 'ok', 'ordens'),
         'herdada': ('2026-11-03', 'herdada', None, 'ok', 'ordens'), 'nenhuma': ('2026-11-03', 'nenhuma', None, 'ok', 'nenhuma'),
         'parado': ('2026-11-03', 'nenhuma', None, 'parado', 'nenhuma'), 'semreg': ('2026-11-03', None, None, 'ok', 'sem_registro'),
         'mes0': ('2026-11-01', 'bom', [], 'ok', 'nenhuma')}
_DADO = {}   # o dado de cada caso com as fontes do repositório (os plantios da tela e da guarda não refazem o cálculo)


def modulo(src, nome):
    m = types.ModuleType(nome); m.__file__ = os.path.join(AQUI, 'tela.py')
    exec(compile(src, nome + '.py', 'exec'), m.__dict__)   # noqa: S102
    return m


def dado(caso, extrai_src=None, prepara_src=None):
    """(dado da tela, resumo do diário) do caso, pelo cálculo aprovado; RuntimeError com o motivo se não sair"""
    padrao = extrai_src is None and prepara_src is None
    if padrao and caso in _DADO:
        return _DADO[caso]
    dia, iq, pub, coletor, _ = CASOS[caso]
    with tempfile.TemporaryDirectory() as d:
        EB.forja(d, iq, pub, coletor)
        prep = P if prepara_src is None else modulo(prepara_src, 'prepara_x')
        io.open(os.path.join(d, 'boletim_ci.py'), 'w', encoding='utf-8').write(prep.prepara(APROVADO))
        if extrai_src is not None:   # o plantio do extrator: a cópia ao lado do boletim_ci.py vence a do repositório
            io.open(os.path.join(d, 'tela_extrai.py'), 'w', encoding='utf-8').write(extrai_src)
        tj = os.path.join(d, 'tela.json')
        env = dict(os.environ, BOLETIM_DIR=d, BOLETIM_LOGO=os.path.join(AQUI, 'logo_intrepid_800.png'), TEMA='claro', PYTHONPATH=AQUI, PYTHONIOENCODING='utf-8',
                   BOLETIM_TELA_JSON=tj)
        try:
            r = subprocess.run([sys.executable, os.path.join(d, 'boletim_ci.py'), 'diario', dia], cwd=d, env=env, capture_output=True, text=True, encoding='utf-8', timeout=120)
        except subprocess.TimeoutExpired:
            raise RuntimeError('o boletim passou de 120 s')
        if r.returncode:
            raise RuntimeError('o boletim estourou: ' + r.stderr[-300:])
        if not os.path.exists(tj):
            raise RuntimeError('o cálculo não gravou o dado da tela')
        out = (json.load(open(tj, encoding='utf-8')), json.load(open(os.path.join(d, 'diario_claro_resumo.json'), encoding='utf-8')))
    if padrao:
        _DADO[caso] = out
    return out


def casos(TLm=TL, modelo=None, extrai_src=None, prepara_src=None, rodada=RODADA, wf=WF, aprovado=None, so=None):
    """as falhas (lista vazia = aprovado). modelo/extrai_src/prepara_src/rodada/wf/aprovado: a fonte com o plantio; so: só estes casos"""
    falhas = []
    ok = lambda c, m: falhas.append(m) if not c else None   # noqa: E731
    with tempfile.TemporaryDirectory() as tmp:
        mod_arq = os.path.join(tmp, 'modelo.html')
        io.open(mod_arq, 'w', encoding='utf-8', newline='\n').write(MODELO if modelo is None else modelo)
        TLm.MODELO = mod_arq

        def arquivo(nome, lang, d, sufixo=''):
            p = os.path.join(tmp, '%s_%s%s.html' % (nome, lang, sufixo))
            io.open(p, 'w', encoding='utf-8', newline='\n').write(TLm.monta(d, lang))
            return p

        D = {}
        for nome in CASOS:
            if so and nome not in so:
                continue
            try:
                D[nome] = dado(nome, extrai_src, prepara_src)
            except (RuntimeError, SystemExit) as e:
                falhas.append('%s: o dado da tela não saiu (%s)' % (nome, str(e)[:200]))
        T = {}
        for nome, (d, res) in D.items():
            dia, _, _, _, est = CASOS[nome]
            # 1. o dado: o estado é o do texto do WeCom, os números são os do resumo, dia pendente não é dia sem corte
            ok(d['ons']['estado'] == est, '%s: o estado do ONS no dado é %r, esperado %r' % (nome, d['ons']['estado'], est))
            ok(d['ons']['estado'] == TL.F.estado_ons(res), '%s: o estado da tela é o mesmo do texto do WeCom' % nome)
            ok(d['liq'] == round(res['liq'], 2) and d['pr_dia'] == round(res['pr'], 2), '%s: geração e PR do dia iguais aos do resumo do diário' % nome)
            pend = [m['d'] for m in d['mes'] if not m['ons']]
            ok((est == 'publicado') == (dia not in pend), '%s: o dia do boletim está marcado como %s no mês' % (nome, 'pendente' if est != 'publicado' else 'publicado'))
            ok(not set(pend) & set(d['livres']), '%s: dia pendente não conta como dia sem corte (livres %s)' % (nome, d['livres']))
            ok(all(abs(v - 80.0) < .05 for v in d['pr_us_mes'].values()) and not any('sc' in k and 'us' in k for k in d),
               '%s: o PR por usina é o publicado (80,0), sem "PR sem o corte" por usina (%s)' % (nome, sorted(set(d['pr_us_mes'].values()))))
            ok(abs(d['pr_mes_sc'] - 81.74) < .05, '%s: o "sem o corte" do COMPLEXO continua no dado (81,7)' % nome)
            # 2. a tela, PT e EN, larga e celular: a guarda aprova o que é certo
            for lang in ('pt', 'en'):
                try:
                    arq = arquivo(nome, lang, d)
                    for larg in (1280, 390):
                        t = TLm.le(arq, '', larg); T[(nome, lang, larg)] = t
                        p = TLm.problemas(t, d, lang)
                        ok(not p, '%s %s %d px: a guarda aprova a tela certa (%s)' % (nome, lang.upper(), larg, '; '.join(p)[:300]))
                    ok(os.path.getsize(arq) < 400 * 1024 and 'data:font/woff2;base64,' in io.open(arq, encoding='utf-8').read(),
                       '%s %s: arquivo único abaixo de 400 KB com a fonte embutida' % (nome, lang.upper()))
                except (Exception, SystemExit) as e:   # noqa: BLE001
                    falhas.append('%s %s: a tela não montou (%s)' % (nome, lang.upper(), str(e)[:300]))
            # 2b. o chinês (o leitor troca no botão 中文), lido do arquivo em inglês que vai ao grupo: nenhum texto sem o chinês, nenhum português
            try:
                arq_en = arquivo(nome, 'en', d)
                for larg in (1280, 390):
                    tz = TLm.le(arq_en, 'zh', larg); T[(nome, 'zh', larg)] = tz
                    p = TLm.problemas_zh(tz, d)
                    ok(not p, '%s 中文 %d px: a guarda aprova a tela em chinês (%s)' % (nome, larg, '; '.join(p)[:300]))
            except (Exception, SystemExit) as e:   # noqa: BLE001
                falhas.append('%s 中文: a tela não montou (%s)' % (nome, str(e)[:300]))
        tx = lambda nome, bloco, lang='pt', larg=1280: (T.get((nome, lang, larg)) or {'textos': {}})['textos'].get(bloco, '')   # noqa: E731
        hx = lambda nome, bloco, lang='pt', larg=1280: (T.get((nome, lang, larg)) or {'html': {}})['html'].get(bloco, '')       # noqa: E731
        if 'pub' in D:   # publicado: o limite, o potencial e a energia do ONS aparecem; nada de pendente
            ok('200 MW' in tx('pub', 't-dia') and '55,50 MWh' in tx('pub', 'kp') and 'data-pot=' in hx('pub', 'g-dia') and 'data-nger=' in hx('pub', 'g-dia'),
               'publicado: o título diz o limite, o número diz a energia do ONS e a curva traz potencial e não gerado')
            ok('pendente' not in (T.get(('pub', 'pt', 1280)) or {}).get('visivel', 'pendente') and 'data-pend=' not in hx('pub', 'g-mes') and not tx('pub', 'n-pon'), 'publicado: nenhuma marca de pendente')
        if 'pub' in D:   # o quadro do estudo na ponte: entregue contra o P50, o P75 e o P90, pelos fatores do painel executivo
            dp = D['pub'][0]; p50_, ent_ = dp['p50_mes_ate'], dp['cx']['tot']
            br = lambda v: ('%.1f' % v).replace('.', ',') + ' %'   # noqa: E731
            ok(abs((dp.get('p75_fator') or 0) - 977.7 / 998.416) < 1e-6 and abs((dp.get('p90_fator') or 0) - 959.0 / 998.416) < 1e-6,
               'o dado traz os fatores do estudo: P75 = 977,7 ÷ 998,416 e P90 = 959,0 ÷ 998,416 (%s, %s)' % (dp.get('p75_fator'), dp.get('p90_fator')))
            gp_ = tx('pub', 'g-pon')
            quer = ('Entregue ÷ P50', 'Entregue ÷ P75', 'Entregue ÷ P90', br(ent_ / p50_ * 100), br(ent_ / (p50_ * 977.7 / 998.416) * 100), br(ent_ / (p50_ * 959.0 / 998.416) * 100))
            ok(all(s in gp_ for s in quer) and hx('pub', 'g-pon').count('data-pxx=') == 4 and hx('pub', 'g-pon', 'en', 390).count('data-pxx=') == 4,
               'a ponte traz o quadro P50 · P75 · P90 com as três razões do entregue (quer %s; veio %s)' % (quer[3:], gp_[-170:]))
            ok('已送出 ÷ P75' in tx('pub', 'g-pon', 'zh') and '电站群' in tx('pub', 'l-leq', 'zh') and '当日发电量' in tx('pub', 'kp', 'zh'), 'o chinês traduz os números do topo, a legenda e a ponte')
        if 'ordens' in D:   # pendente com ordens: as ordens da Iqony no número, no título, na curva, na ponte, no dia a dia e no PR
            ok('2,3 h' in tx('ordens', 'kp') and '2 ordens recebidas' in tx('ordens', 'kp') and '282 MW' in tx('ordens', 'kp'), 'ordens: o número mostra as 2 ordens, 2,3 h e o mínimo de 282 MW')
            ok('10:50' in tx('ordens', 't-dia') and '13:06' in tx('ordens', 't-dia') and 'pendente' in tx('ordens', 't-dia'), 'ordens: o título diz a janela das ordens e que a apuração está pendente')
            ok('data-ordens="2"' in hx('ordens', 'g-dia') and 'data-ordens="2"' in hx('ordens', 'g-dia', 'en', 390), 'ordens: a curva do dia traz o degrau das 2 ordens (largo e celular)')
            ok('03/11' in tx('ordens', 'n-pon') and 'data-ponte-pend=' in hx('ordens', 'g-pon') and 'apurado até 02/11' in tx('ordens', 'g-pon'), 'ordens: a ponte diz até quando o ONS apurou e avisa do dia pendente')
            ok('data-pend="3"' in hx('ordens', 'g-mes') and 'data-pend="2"' not in hx('ordens', 'g-mes') and 'data-sp-pend=' in hx('ordens', 'sp'), 'ordens: só o dia pendente leva hachura no dia a dia e no minigráfico')
            ok('(01/11)' in tx('ordens', 's-usi') and '03/11 aguarda' in tx('ordens', 's-usi'), 'ordens: o PR por usina usa só o dia apurado sem corte e diz que o pendente não entra')
            ok('3 Nov figure pending' in tx('ordens', 'ante', 'en') and '2 orders received' in tx('ordens', 'kp', 'en'), 'ordens: o inglês diz o mesmo')
        if 'herdada' in D:
            ok('sob a ordem do dia anterior' in tx('herdada', 'kp') and '14,0 h' in tx('herdada', 'kp') and 'data-ordens="1"' in hx('herdada', 'g-dia'), 'herdada: o dia que começou sob a ordem do dia anterior mostra as 14,0 h')
        if 'nenhuma' in D:
            ok('nenhuma ordem' in tx('nenhuma', 'kp') and 'Nenhuma ordem de limitação' in tx('nenhuma', 't-dia') and 'data-ordens=' not in hx('nenhuma', 'g-dia'), 'nenhuma: número e título dizem "nenhuma ordem", com a apuração pendente')
        if 'parado' in D:
            ok('coletor das ordens parado' in tx('parado', 'kp') and 'podem faltar ordens' in tx('parado', 't-dia'), 'parado: "nenhuma ordem" com o coletor parado leva a ressalva')
        if 'semreg' in D:
            ok('sem registro das ordens' in tx('semreg', 'kp') and 'indisponível' in tx('semreg', 't-dia'), 'semreg: sem o registro das ordens a tela diz que ele está indisponível')
        if 'mes0' in D:   # o dia 1º lido no dia 2: nenhum dia do mês apurado
            ok('Ainda não há dia' in tx('mes0', 't-usi') and 'nenhum dia apurado' in tx('mes0', 't-viz') and not hx('mes0', 'g-viz') and 'apuração pendente' in tx('mes0', 'g-pon'),
               'mes0: sem dia apurado no mês, a tela não inventa PR por usina, corte regional nem energia impedida')
        base = 'nenhuma' if 'nenhuma' in D else next(iter(D), None)
        if base:
            d = D[base][0]
            # 3. a disponibilidade que ainda não chegou (os inversores fecham o dia às 10:17)
            try:
                for lang in ('pt', 'en'):
                    dn = dict(d, disp_dia=None, disp_serie=d['disp_serie'][:-1] + [None])
                    t = TLm.le(arquivo(base, lang, dn, '_disp'))
                    ok(TL.F.DISP_PENDENTE[lang] in t['textos']['kp'] and not TLm.problemas(t, dn, lang), 'disponibilidade pendente (%s): sai "%s", nunca um número' % (lang, TL.F.DISP_PENDENTE[lang]))
            except (Exception, SystemExit) as e:   # noqa: BLE001
                falhas.append('disponibilidade pendente: a tela não montou (%s)' % str(e)[:200])
            # 4. a guarda RECUSA o que é errado (cada uma com a tela feita errada de propósito)
            try:
                en = arquivo(base, 'en', d)
                p = TLm.problemas(TLm.le(en, 'pt'), d, 'en')
                ok(any('inglês com português' in x for x in p), 'a guarda recusa a versão em inglês que sai em português')
                de = "  if (PUB){\n    var sOns = cortDia > 0"
                if MODELO.count(de) == 1 and modelo is None:
                    TLm.MODELO = os.path.join(tmp, 'ruim.html')
                    io.open(TLm.MODELO, 'w', encoding='utf-8', newline='\n').write(MODELO.replace(de, "  if (true){\n    var sOns = cortDia > 0"))
                    p = TLm.problemas(TLm.le(arquivo(base, 'pt', d, '_ruim')), d, 'pt')
                    TLm.MODELO = mod_arq
                    ok(any('com o ONS pendente a tela diz' in x for x in p), 'a guarda recusa a tela que diz "sem limite" com o ONS pendente (%s)' % '; '.join(p)[:200])
                if ('pub', 'pt', 1280) in T:
                    p = TLm.problemas(T[('pub', 'pt', 1280)], d, 'pt')
                    ok(len(p) >= 2, 'a guarda recusa a tela de um dia publicado apresentada como a do dia pendente')
                p = TLm.problemas(dict(TLm.le(en), ok=None), d, 'en')
                ok(any('o desenho não terminou' in x for x in p), 'a guarda recusa o desenho que não terminou (o script da tela parou no meio)')
                TLm.MODELO = os.path.join(tmp, 'fora.html')
                io.open(TLm.MODELO, 'w', encoding='utf-8', newline='\n').write((MODELO if modelo is None else modelo).replace('<meta charset="utf-8">', '<meta charset="utf-8"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">', 1))
                ok(EB.recusa(TLm.monta, d, 'en'), 'o arquivo que pede a fonte ao Google é recusado (o Google Fonts é bloqueado na China)')
                TLm.MODELO = mod_arq
            except (Exception, SystemExit) as e:   # noqa: BLE001
                falhas.append('a guarda não pôde ser ensaiada (%s)' % str(e)[:300])
        TLm.MODELO = os.path.join(AQUI, 'tela.src.html')
    # 5. o que vai ao grupo: as partes e o PDF do boletim, mais o HTML da tela ANEXO (inglês)
    g = {'en': {'imagens': ['boletim/d/p1.png', 'boletim/d/p2.png'], 'pdf': 'boletim/d/diario_claro_en.pdf'}, 'pt': {'imagens': ['x'], 'pdf': 'y'},
         'tela': {'en': {'html': 'boletim/d/Mauriti_Daily_Bulletin_2026-11-03.html'}, 'pt': {'html': 'boletim/d/Boletim_Diario_Mauriti_2026-11-03.html'}}}
    ok(TLm.para_o_grupo(g) == (['boletim/d/p1.png', 'boletim/d/p2.png'], ['boletim/d/diario_claro_en.pdf', 'boletim/d/Mauriti_Daily_Bulletin_2026-11-03.html']),
       'ao grupo vão as partes e o PDF em inglês e, anexo, o HTML da tela em inglês: %s' % (TLm.para_o_grupo(g),))
    ok(TLm.para_o_grupo({k: v for k, v in g.items() if k != 'tela'}) == (['boletim/d/p1.png', 'boletim/d/p2.png'], ['boletim/d/diario_claro_en.pdf']), 'sem a tela, o boletim vai como sempre')
    # 6. o diário (página e PDF) sem o "PR sem o corte" por usina (o cálculo inteiro: só na passada completa e no plantio dele)
    try:
        if so is not None and aprovado is None:
            raise StopIteration
        _, h = EB.roda_imagem(APROVADO if aprovado is None else aprovado, '2026-11-02')
        bloco = h[h.index('Usinas · dia e mês'):h.index('Fatos relevantes')]
        ok('81,7' not in bloco and bloco.count('80,0%') == 9 and 'PR do mês sem o corte' not in bloco, 'o diário mostra o PR publicado por usina (80,0%), sem o "PR sem o corte" por usina')
    except StopIteration:
        pass
    except (Exception, SystemExit) as e:   # noqa: BLE001
        falhas.append('o diário não pôde ser lido (%s)' % str(e)[:200])
    # 6b. o mensal (boletim-mensal-pr, 23/11/2026): o painel "Usinas no mês" mostra o PR publicado, nunca o "PR sem o corte" por usina
    apr = APROVADO if aprovado is None else aprovado
    us_m = apr[apr.index('def usinas(dias):'):apr.index('def usinas2(')] if 'def usinas(dias):' in apr and 'def usinas2(' in apr else ''
    ok('<span>{nf(p,1)}%</span>' in us_m and 'nf(pc,1)' not in us_m and 'min(pc ' not in us_m and '<small>geração · PR do mês · disponibilidade</small>' in apr
       and 'PR sem o corte · disponibilidade' not in apr, 'o mensal mostra o PR publicado por usina, sem o "PR sem o corte" por usina')
    # 7. as ligações: a rodada anexa a tela sem deixar que ela barre o boletim; o workflow ensaia antes e avisa a rodada
    ok("tl = TL.gera(pasta, tela_json)" in rodada and "imagens, arquivos = TL.para_o_grupo(guardado)" in rodada, 'a rodada gera a tela e monta o item pelo para_o_grupo')
    ok("        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO da guarda da tela também)\n            guardado.pop('tela', None)\n            TELA_ERROS[" in rodada,
       'a tela recusada não barra o boletim: o item vai sem o anexo e o motivo fica registrado')
    ok("    if erro_tela:   # boletim-pdf-executivo: idem\n        sys.exit(1)" in rodada and "erro_tela = TELA_ERROS.pop(iid)" in rodada, 'o boletim que foi sem a tela deixa a rodada vermelha')
    ok("if os.environ.get('ENSAIO_TELA_OK') not in (None, '', 'success', 'skipped'):" in rodada, 'com este ensaio reprovado a rodada não anexa a tela')
    ok("a_enviar(f'{modo}-{dia}', arqs['html']," in rodada, 'o HTML que foi ao grupo fica em enviados/ (a_enviar, só se o item entrar)')
    li = wf.split('\n')
    i_t = next((k for k, x in enumerate(li) if x == '      - name: Ensaio · tela executiva'), None)
    i_r = next((k for k, x in enumerate(li) if x == '      - name: Rodada'), None)
    passo = li[i_t:i_t + 7] if i_t is not None else []
    ok(i_t is not None and i_r is not None and i_t < i_r and '        id: ensaio_tela' in passo and '        continue-on-error: true' in passo
       and any(x.startswith('        timeout-minutes: ') for x in passo) and '        run: python3 scripts/boletim/ensaio_tela.py' in passo,
       'o boletim.yml ensaia a tela num passo próprio, antes da Rodada, com teto e sem barrar o boletim')
    ok('          ENSAIO_TELA_OK: ${{ steps.ensaio_tela.outcome }}' in li[i_r:] if i_r is not None else False, 'a Rodada recebe o resultado do ensaio da tela')
    return falhas


# (nome, o que troca: modelo | extrai | tela | prepara | rodada | wf, de, para, casos que rodam, trecho do motivo que TEM de aparecer)
PLANTIOS = [
    ('o número volta a "0,0 h · sem limite" com o ONS pendente', 'modelo', "  if (PUB){\n    var sOns = cortDia > 0", "  if (true){\n    var sOns = cortDia > 0", ('nenhuma',), 'a guarda aprova a tela certa'),
    ('o título do dia pendente vira "Dia sem limite do ONS"', 'modelo', "  else if (PUB) tDia = L('Dia sem limite do ONS", "  else if (true) tDia = L('Dia sem limite do ONS", ('nenhuma',), 'número e título dizem "nenhuma ordem"'),
    ('o potencial e o não gerado aparecem com o ONS pendente', 'modelo', "var TEMPOT = PUB && D.LD.pr != null;", "var TEMPOT = D.LD.pr != null;", ('ordens',), 'a guarda aprova a tela certa'),
    ('a curva do dia sem o degrau das ordens', 'modelo', "DEG = PUB ? [] : (D.ons.degraus || []);", "DEG = [];", ('ordens',), 'o degrau das 2 ordens'),
    ('o dia pendente sem hachura no dia a dia', 'modelo', "    if (!m.ons) s += '<rect data-pend=", "    if (false) s += '<rect data-pend=", ('ordens',), 'só o dia pendente leva hachura'),
    ('a ponte do mês não avisa do dia pendente', 'modelo', "np.hidden = !PEND.length;", "np.hidden = true;", ('ordens',), 'a ponte diz até quando'),
    ('o impedido da ponte não diz até quando o ONS apurou', 'modelo', "(PEND.length && ULT ? L(' · apurado até ' + fd(ULT), ' · settled to ' + fd(ULT), ' · 核算至 ' + fd(ULT)) : '')", "''", ('ordens',), 'a ponte diz até quando'),
    ('a versão em inglês sai em português', 'modelo', "function L(pt, en, zh){ if (LANG === 'zh'){ if (zh == null){ FALTA++; return en; } return zh; } return LANG === 'pt' ? pt : en; }", "function L(pt, en, zh){ return pt; }", ('pub',), 'inglês com português'),
    ('um texto da tela fica sem o chinês', 'modelo', "L('Geração do dia','Day generation','当日发电量')", "L('Geração do dia','Day generation')", ('pub',), 'a guarda aprova a tela em chinês'),
    ('o chinês sai em português', 'modelo', "if (LANG === 'zh'){ if (zh == null){ FALTA++; return en; } return zh; }", "if (LANG === 'zh') return pt;", ('pub',), 'a guarda aprova a tela em chinês'),
    ('o quadro P50 · P75 · P90 some da ponte', 'modelo', "  qd.forEach(function(c, i){", "  [].forEach(function(c, i){", ('pub',), 'o quadro P50 · P75 · P90'),
    ('o P75 sai com o fator do P90', 'extrai', "r(P75_FATOR, 8)", "r(G['P90_FATOR'], 8)", ('pub',), 'os fatores do estudo'),
    ('a disponibilidade que não chegou vira "—"', 'modelo', "    (D.disp_dia != null ? kp('disp'", "    (true ? kp('disp'", ('nenhuma',), 'disponibilidade pendente'),
    ('a ressalva do coletor parado some', 'modelo', "var PARADO = !PUB && IQ && IQ.coletor === 'parado';", "var PARADO = false;", ('parado',), 'leva a ressalva'),
    ('a fonte volta a vir do Google', 'modelo', '<meta name="viewport" content="width=device-width,initial-scale=1">',
     '<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo">', ('pub',), 'a tela não montou'),
    ('dia pendente conta como dia sem corte', 'extrai', "livres = [d for d in dm if d in ONS_DIAS and not", "livres = [d for d in dm if not", ('ordens',), 'dia pendente não conta como dia sem corte'),
    ('sem o registro das ordens vira publicado', 'extrai', "'estado': F.estado_ons({'ons_estado': G['ONS_EST'], 'iqony': G['IQD']})", "'estado': 'publicado'", ('semreg',), 'o estado do ONS no dado'),
    ('o "PR sem o corte" por usina volta ao dado', 'extrai', "o['pr_us_mes'] = {u: r(G['pr_dias']([u], dm)[0]) for u in US}", "o['pr_us_mes'] = {u: r(G['pr_dias']([u], dm)[1]) for u in US}", ('pub',), 'sem "PR sem o corte" por usina'),
    ('o degrau das ordens some do dado', 'extrai', "'degraus': [[int(a), int(b), r(v)] for a, b, v in G['degraus_dia'](DIA)]}", "'degraus': []}", ('ordens',), 'o degrau das 2 ordens'),
    ('a guarda deixa de olhar o ONS pendente', 'tela', "    if est != 'publicado':\n        dia = ' | '.join(", "    if False:\n        dia = ' | '.join(", ('nenhuma',), 'a guarda recusa a tela que diz "sem limite"'),
    ('a guarda deixa passar português no inglês', 'tela', "    if lang == 'en':\n        sobra = sorted(", "    if False:\n        sobra = sorted(", ('nenhuma',), 'a guarda recusa a versão em inglês'),
    ('a guarda aceita o desenho que não terminou', 'tela', "    if t.get('ok') != '%s:%s:%s' % (lang, tema, est):", "    if False:", ('nenhuma',), 'a guarda recusa o desenho que não terminou'),
    ('a guarda aceita arquivo que pede rede', 'tela', "    if m:\n        raise SystemExit('RECUSADO: tela: o arquivo pede algo de fora", "    if False:\n        raise SystemExit('RECUSADO: tela: o arquivo pede algo de fora", ('nenhuma',), 'bloqueado na China'),
    ('o HTML da tela não vai ao grupo', 'tela', "    if t.get('html'):\n        arquivos.append(t['html'])", "    if False:\n        arquivos.append(t['html'])", ('pub',), 'anexo, o HTML da tela'),
    ('o "PR sem o corte" por usina volta ao diário', 'aprovado', '{nf(gm,2)} <small>MWh</small></div>\n  <div class="us-bar"><div class="us-f" style="width:{min(p or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(p,1)}%</span>', '{nf(gm,2)} <small>MWh</small></div>\n  <div class="us-bar"><div class="us-f" style="width:{min(p or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(pc,1)}%</span>', ('pub',), 'o diário mostra o PR publicado por usina'),
    ('o "PR sem o corte" por usina volta ao mensal', 'aprovado', '{nf(g,2)} <small>MWh</small></div>\n  <div class="us-bar"><div class="us-f" style="width:{min(p or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(p,1)}%</span>',
     '{nf(g,2)} <small>MWh</small></div>\n  <div class="us-bar"><div class="us-f" style="width:{min(pc or 0,100):.1f}%;background:{mix(c,26)};border-color:{mix(c,55)}"></div><span>{nf(pc,1)}%</span>', ('pub',), 'o mensal mostra o PR publicado por usina'),
    ('o cálculo não grava o dado da tela', 'prepara', "    import tela_extrai as _TX; _TX.grava(globals(), os.environ['BOLETIM_TELA_JSON'])", "    pass", ('pub',), 'o dado da tela não saiu'),
    ('a tela recusada barra o boletim', 'rodada', "        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO da guarda da tela também)", "        except ZeroDivisionError as e:   # noqa: BLE001  (o RECUSADO da guarda da tela também)", ('pub',), 'não barra o boletim'),
    ('o boletim sem a tela sai verde', 'rodada', "    if erro_tela:   # boletim-pdf-executivo: idem\n        sys.exit(1)", "", ('pub',), 'deixa a rodada vermelha'),
    ('a rodada anexa a tela com o ensaio reprovado', 'rodada', "if os.environ.get('ENSAIO_TELA_OK') not in (None, '', 'success', 'skipped'):", "if False:", ('pub',), 'com este ensaio reprovado'),
    ('o workflow não ensaia a tela', 'wf', '        run: python3 scripts/boletim/ensaio_tela.py\n', '        run: true\n', ('pub',), 'ensaia a tela num passo próprio'),
    ('o ensaio da tela barra o boletim', 'wf', '        id: ensaio_tela\n        continue-on-error: true\n', '        id: ensaio_tela\n', ('pub',), 'ensaia a tela num passo próprio'),
    ('a Rodada não sabe do ensaio da tela', 'wf', '          ENSAIO_TELA_OK: ${{ steps.ensaio_tela.outcome }}\n', '', ('pub',), 'a Rodada recebe o resultado'),
]
FONTES = {'modelo': MODELO, 'extrai': EXTRAI, 'tela': TELA_PY, 'prepara': PREPARA, 'rodada': RODADA, 'wf': WF, 'aprovado': APROVADO}


def main():
    falhas = casos()
    for f in falhas:
        print('  FALHA:', f)
    ruim = bool(falhas)
    print('tela executiva, %d casos: %s' % (len(CASOS), 'REPROVADA' if falhas else 'aprovada'))
    for nome, onde, de, para, so, motivo in PLANTIOS:
        src = FONTES[onde]
        if src.count(de) != 1:
            print('  PLANTIO SEM ÂNCORA:', nome); ruim = True; continue
        novo = src.replace(de, para)
        try:
            kw = {'modelo': {'modelo': novo}, 'extrai': {'extrai_src': novo}, 'prepara': {'prepara_src': novo}, 'rodada': {'rodada': novo}, 'wf': {'wf': novo}, 'aprovado': {'aprovado': novo}}.get(onde, {})
            fp = casos(modulo(novo, 'tela_x') if onde == 'tela' else TL, so=so, **kw)
        except (Exception, SystemExit) as e:   # noqa: BLE001
            fp = ['estourou: %s' % str(e)[:200]]
        pegou = [f for f in fp if motivo in f]
        if pegou:
            print('  plantio "%s": reprovado, como devia (%s)' % (nome, pegou[0][:140]))
        else:
            print('  PLANTIO PASSOU:', nome, '· esperado um motivo com "%s"; veio: %s' % (motivo, '; '.join(fp)[:300] or 'nada')); ruim = True
    print('ensaio da tela executiva:', 'REPROVADO' if ruim else 'APROVADO')
    sys.exit(1 if ruim else 0)


if __name__ == '__main__':
    main()
