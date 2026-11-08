# -*- coding: utf-8 -*-
"""Boletim de Desempenho · UMA rodada do pipeline (boletim.yml, na janela da manhã).
Entrada: a pasta BOLETIM_DIR com os blobs baixados (executivo.json, pr_ufv.json, sg_disp_dia.json, irr_ufv.json, benchmark_ne.json,
way2_30min.json, irr_plano_30min.json, ons_restricao_<mês e anterior>.json, acervo__catalogo.json) e o estado anterior
(boletim__estado.json, boletim__fila.json, boletim__indice.json).
Saída: BOLETIM_DIR/saida/boletim/... com os nomes de blob (o passo seguinte sobe para o contêiner `dados`):
  diario/<dia>/diario_{claro,escuro}.html, diario_claro.pdf, diario_claro_p<n>.png|jpg, resumo.json
  mensal/<AAAA-MM>/mensal_{claro,escuro}.html, mensal_claro.pdf, partes, resumo.json
  fatos/<id>.mp4 e .png · fila.json · estado.json · indice.json (o que a página do SIGO lista)
    python rodada.py --precisa                    só com as entradas leves: há o que gerar? (pesado=true|false, agora=...)
    python rodada.py [--agora AAAA-MM-DDTHH:MM] [--sem-render]
    python rodada.py --semeia [--feitos a,b]      a primeira rodada no ar (marca o que já foi; fixa o `desde`; fila vazia)
A rodada normal recusa sem a semeadura. --sem-render não chama o Chrome nem o ffmpeg: as partes e o PDF ficam de fora."""
import datetime as dt
import glob
import json
import os
import shutil
import subprocess
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
import fila as F  # noqa: E402
import curvas as C  # noqa: E402

DIR = os.environ.get('BOLETIM_DIR') or os.getcwd()
SAI = os.path.join(DIR, 'saida', 'boletim')


def le_curvas():
    """o curvas.json da rodada anterior; ilegível vale como ausente (é derivado, a rodada refaz do zero)"""
    try:
        return le('boletim/curvas.json')
    except Exception as e:   # noqa: BLE001
        print('::warning::curvas da página ilegíveis, refeitas do zero: ' + str(e)[:200])
        return None


def le(nome, padrao=None):
    p = os.path.join(DIR, nome.replace('/', '__'))
    return json.load(open(p, encoding='utf-8-sig')) if os.path.exists(p) else padrao   # utf-8-sig: com ou sem BOM


def grava(rel, obj):
    p = os.path.join(SAI, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(obj, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    return p


def traduz_pasta(pasta, arg):
    """grava <arquivo>_en.html de cada HTML do boletim pelo traduz_en.py aprovado e devolve o que sobrou em português (vazio = ok)"""
    import html as H, re
    import traduz_en as TE
    sobra = set()
    for f in sorted(glob.glob(os.path.join(pasta, f'{arg}_*.html'))):
        if f.endswith('_en.html'):
            continue
        # a disponibilidade do dia pendente ("apuração às 10h") vai ao inglês antes do tradutor, inteira
        en = TE.traduz(open(f, encoding='utf-8').read().replace(F.DISP_PENDENTE['pt'], F.DISP_PENDENTE['en']))
        vis = ' '.join(H.unescape(x) for x in re.findall(r'>([^<>]+)<', re.sub(r'<style>.*?</style>', '', en, flags=re.S)))
        sobra |= set(m.group(0) for m in TE.RESTO.finditer(vis.replace('Participações', '').replace('Intrepid', '')))
        open(f[:-5] + '_en.html', 'w', encoding='utf-8').write(en)
    return sorted(sobra)


# RW-302 (boletim-1730): enviados/<dia>/PT|EN/ guarda o que FOI AO GRUPO. O gera só REGISTRA a cópia (origem, destino) pelo id do item; a
# cópia acontece depois que o item entra em novos (copia_enviados). Item que falha depois do render, ou barrado, não deixa nada em enviados/.
ENVIADOS = {}


def a_enviar(iid, origem, destino):
    ENVIADOS.setdefault(iid, []).append((origem, destino))


def copia_enviados(iid):
    for origem, destino in ENVIADOS.pop(iid, []):
        os.makedirs(os.path.dirname(destino), exist_ok=True)
        shutil.copyfile(origem, destino)


def gera(modo, dia, render):
    """roda o boletim nos dois temas; claro vai ao WeCom (partes e PDF), os dois vão à página"""
    pasta = os.path.join(SAI, 'diario' if modo == 'diario' else 'mensal', dia if modo == 'diario' else dia[:7])
    os.makedirs(pasta, exist_ok=True)
    arg = 'diario' if modo == 'diario' else 'mensal'
    base = 'diario' if modo == 'diario' else f'mensal_{dia[:7]}'
    for tema in ('claro', 'escuro'):
        env = dict(os.environ, TEMA=tema, BOLETIM_DIR=DIR, PYTHONIOENCODING='utf-8')
        r = subprocess.run([sys.executable, os.path.join(AQUI, 'boletim_ci.py'), arg, dia], env=env, capture_output=True, text=True, encoding='utf-8')
        if r.returncode:
            raise SystemExit(f'RECUSADO: o boletim {modo} {dia} ({tema}) falhou: ' + r.stderr[-600:])
        suf = '' if tema == 'escuro' else '_claro'
        for f in glob.glob(os.path.join(DIR, f'{base}{suf}*.html')) + glob.glob(os.path.join(DIR, f'{base}{suf}_resumo.json')):
            nome = os.path.basename(f).replace(f'{base}{suf}', f'{arg}_{tema}')
            shutil.move(f, os.path.join(pasta, nome))
    resumo = json.load(open(os.path.join(pasta, f'{arg}_claro_resumo.json'), encoding='utf-8'))
    # a versão em inglês (ao grupo vai SÓ o inglês; PT e EN guardados), pelo traduz_en.py; a guarda (texto visível que sobrou em
    # português) barra o envio: o item não entra na fila e o erro fica no estado
    import re
    sobra = traduz_pasta(pasta, arg)
    rel = lambda p: os.path.relpath(p, os.path.dirname(SAI)).replace('\\', '/')
    guardado = {}
    if render:
        import render_ci
        for idi, base_r in (('pt', f'{arg}_claro'), ('en', f'{arg}_claro_en')):
            if idi == 'en':   # as partes EN têm o nome <arg>_claro_p<n>_en.html: o renderizador procura <base>_p<n>.html
                for f in glob.glob(os.path.join(pasta, f'{arg}_claro_p*_en.html')):
                    n = re.search(r'_p(\d+)_en\.html$', f).group(1)
                    shutil.copyfile(f, os.path.join(pasta, f'{arg}_claro_en_p{n}.html'))
            r = render_ci.rende(pasta, base_r)
            guardado[idi] = {'imagens': [rel(p) for p in r['partes']], 'pdf': rel(r['pdf'])}
            # o arquivo do enviado: enviados/<data>/PT|EN/<nome>, com o sufixo _en no fim (diario_2026-11-07_claro_p1_en.png, mensal_2026-10_claro_en.pdf)
            hoje = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).date().isoformat()
            dst = os.path.join(SAI, 'enviados', hoje, idi.upper())
            base_env = f'diario_{dia}_claro' if modo == 'diario' else f'mensal_{dia[:7]}_claro'   # o dia no nome: dois diários na mesma rodada não se sobrescrevem
            for p in r['partes'] + [r['pdf']]:
                n = os.path.basename(p).replace(f'{arg}_claro_en', f'{arg}_claro').replace(f'{arg}_claro', base_env)
                if idi == 'en':
                    raiz, ext = os.path.splitext(n); n = raiz + '_en' + ext
                a_enviar(f'{modo}-{dia}', p, os.path.join(dst, n))   # RW-302: copiado só se o item entrar em novos
    return resumo, guardado, sorted(sobra), rel(pasta)


def gera_curva(dia, w2r, iq, agora, render):
    """a folha das 17:30 (curva1730.py): claro e escuro, PT e EN; ao grupo vai a imagem e o PDF em inglês (PT e EN guardados)"""
    import base64
    import curva1730 as CV
    pasta = os.path.join(SAI, 'curva', dia)
    logo = os.environ.get('BOLETIM_LOGO') or os.path.join(AQUI, 'logo_intrepid_800.png')
    ger = {'pt': agora.strftime('%d/%m/%Y %H:%M'), 'en': f'{agora.day} {CV.MES_EN[agora.month - 1]} {agora.year} {agora:%H:%M}'}
    resumo, sobra = CV.gera(pasta, w2r, iq, dia, agora.strftime('%H:%M'), base64.b64encode(open(logo, 'rb').read()).decode(), ger)
    rel = lambda p: os.path.relpath(p, os.path.dirname(SAI)).replace('\\', '/')
    guardado = {}
    if render and not sobra:
        import render_ci
        for idi, base_r in (('pt', 'curva_claro'), ('en', 'curva_claro_en')):
            r = render_ci.rende(pasta, base_r)
            guardado[idi] = {'imagens': [rel(p) for p in r['partes']], 'pdf': rel(r['pdf'])}
            dst = os.path.join(SAI, 'enviados', agora.date().isoformat(), idi.upper())
            for p in r['partes'] + [r['pdf']]:
                a_enviar('curva-' + dia, p, os.path.join(dst, os.path.basename(p).replace('curva_claro', 'curva1730_claro')))   # RW-302
    return resumo, guardado, sobra, rel(pasta)


def agora_brt():
    """a hora da rodada: BOLETIM_AGORA (a que o passo que decide fixou) ou --agora, senão o relógio (Brasília, UTC-3)"""
    txt = os.environ.get('BOLETIM_AGORA') or (sys.argv[sys.argv.index('--agora') + 1] if '--agora' in sys.argv else '')
    if txt:
        return dt.datetime.fromisoformat(txt).replace(tzinfo=None)
    return (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).replace(tzinfo=None).replace(second=0, microsecond=0)


def saida_gh(**kv):
    """o resultado do passo para os passos seguintes do workflow (GITHUB_OUTPUT) e para o log"""
    for k, v in kv.items():
        print(f'{k}={v}')
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as f:
            for k, v in kv.items():
                f.write(f'{k}={v}\n')


def main():
    agora = agora_brt()
    render = '--sem-render' not in sys.argv
    semeia = '--semeia' in sys.argv
    estado = le('boletim/estado.json')
    if '--precisa' in sys.argv:
        # só as entradas leves (estado, fila, índice, ONS, catálogo) estão baixadas: decide se há o que gerar (o pesado vem depois)
        if semeia:
            saida_gh(pesado='true', tarde='false', agora=agora.isoformat(timespec='minutes'))
            return
        F.exige_semeado(estado)
        ts = F.tarefas(agora, estado, F.ons_dias(DIR))
        # as curvas de 30 min da página: sem o arquivo, ou parado antes de ontem, a rodada desce a medição e o refaz
        cv = C.velho(le_curvas(), (agora.date() - dt.timedelta(days=1)).isoformat(), agora.date().isoformat())
        tc = F.tarefa_curva(agora, estado)   # a folha das 17:30 (boletim-1730): entradas próprias, as da tarde
        print('tarefas:', ', '.join(f'{m}:{d}' for m, d in ts + tc) or 'nenhuma', '· curvas da página:', 'refazer' if cv else 'em dia')
        saida_gh(pesado='true' if ts or cv else 'false', tarde='true' if tc else 'false', agora=agora.isoformat(timespec='minutes'))
        return
    fila = le('boletim/fila.json', {'itens': []})
    indice = le('boletim/indice.json', {'diario': {}, 'mensal': {}})
    executivo = le('executivo.json')
    ons_ruins = []   # RW-503: arquivo do ONS ilegível recai só no diário e no mensal, que dependem dele
    ons = F.ons_dias(DIR, ons_ruins)
    if semeia:
        # a primeira rodada no ar: os RD emitidos até hoje, o total da vida e o que já foi ao grupo à mão (--feitos) contam como feitos
        ja = F.valida_feitos(sys.argv[sys.argv.index('--feitos') + 1] if '--feitos' in sys.argv else '')
        rds = ['rd:' + d['codigo'] for d in le('acervo/catalogo.json', {}).get('documentos', []) if d.get('tipo') == 'RD' and d.get('emissao') == 'AP']
        total = ((executivo or {}).get('totais_vida') or {}).get('total_gwh')
        est, fl = F.semente(estado, rds, ja, total, agora)
        grava('fila.json', fl)
        grava('estado.json', est)
        print('semeado:', len(rds), 'RD e', len(ja), 'item(ns) à mão marcados como feitos; desde', est['desde'], '; fila vazia; total da vida', total, 'GWh')
        return
    F.exige_semeado(estado)
    novos, feitos, erros = [], list(estado.get('feitos', [])), list(estado.get('erros', []))[-200:]
    barrados = []
    erro_diario = None
    a_copiar = []   # RW-401 (b): os ids cujos arquivos vão para enviados/ depois que a fila for gravada
    for modo, dia in F.tarefas(agora, estado, ons):
        if modo == 'diario' and F.ESPERA_DIA_COMPLETO and agora.hour < F.HORA_LIMITE_ESPERA:
            falta = F.faltam_no_dia(DIR, dia)
            if falta:
                print(f'diário de {dia} espera o dia completo em: {", ".join(falta)} (até {F.HORA_LIMITE_ESPERA}:00)')
                continue
        iid = f'{modo}-{dia}'
        try:
            # boletim-1730 (RW-102, RW-201): o diário ou o mensal que não sai NÃO barra o resto (a folha das 17:30, a fila, o estado). TUDO
            # do item fica aqui dentro (as entradas, o gera, a marca, o texto, o índice, os fatos e o vídeo); o resultado só entra em feitos,
            # novos, índice e barrados depois que a iteração inteira deu certo. A falha vai para `erros`, não vira feito (a rodada seguinte
            # tenta de novo) e a rodada sai 1 só no FIM, depois de gravar
            if os.environ.get('PESADO_OK') not in (None, '', 'success', 'skipped'):   # o passo "Entradas pesadas" do workflow falhou
                raise RuntimeError('as entradas pesadas não foram baixadas (passo: %s)' % os.environ.get('PESADO_OK'))
            if executivo is None:
                raise RuntimeError(f'há o que gerar ({modo} {dia}) e as entradas pesadas não foram baixadas')
            if ons_ruins:
                raise RuntimeError('arquivo do ONS ilegível: ' + ', '.join(sorted(ons_ruins)))
            resumo, guardado, sobra, pasta = gera('mensal' if modo == 'mensal' else 'diario', dia, render)
            feitos_i, novos_i, erros_i = list(F.marca(modo, dia, sobra, ons)), [], []
            if sobra:
                # inglês com português não vai ao grupo e NÃO vira feito: a rodada seguinte tenta de novo e segue vermelha até corrigir
                erros_i.append({'id': iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': 'inglês com português: ' + ', '.join(sobra)})
            else:
                en = guardado.get('en', {})
                novos_i.append({'id': iid, 'tipo': modo, 'dia': dia, 'texto': F.texto_en(modo, resumo),
                                'imagens': en.get('imagens', []), 'arquivos': [en['pdf']] if en.get('pdf') else [],
                                'guardado': guardado})
            chave = 'mensal' if modo == 'mensal' else 'diario'
            ind_i = (chave, dia if chave == 'diario' else dia[:7], {'pasta': pasta, 'ons': dia in ons, 'gerado': agora.isoformat(timespec='minutes')})
            if modo == 'diario' and not sobra:
                for fato in F.fatos(executivo, dia, dict(estado, feitos=feitos + feitos_i)):
                    arqs_f, imgs_f = [], []
                    if render:
                        import anima_fato
                        os.makedirs(os.path.join(SAI, 'fatos'), exist_ok=True)
                        mp4, png = anima_fato.anima(fato, executivo, os.path.join(SAI, 'fatos', fato['id'] + '.mp4'))
                        rel = lambda p: os.path.relpath(p, os.path.dirname(SAI)).replace('\\', '/')
                        arqs_f, imgs_f = [rel(mp4)], [rel(png)]
                    novos_i.append({'id': 'fato-' + fato['id'], 'tipo': 'fato', 'dia': dia, 'texto': fato['texto'], 'imagens': imgs_f, 'arquivos': arqs_f})
                    feitos_i.append('fato:' + fato['id'])
            for n_ in novos_i:   # RW-401: as guardas de texto do item (e dos fatos dele) aqui dentro: a recusa é erro DESTE item
                F.valida_item(n_)
        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do gera também)
            erro_diario = (str(e) or type(e).__name__)[:300]
            erros.append({'id': iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': f'{modo} de {dia}: ' + erro_diario})
            print('::error::%s de %s não gerado: %s' % (modo, dia, erro_diario))
            ENVIADOS.pop(iid, None)
            continue
        feitos += feitos_i
        novos += novos_i
        erros += erros_i
        if erros_i:
            barrados.append(iid)
        indice.setdefault(ind_i[0], {})[ind_i[1]] = ind_i[2]
        if erros_i:
            ENVIADOS.pop(iid, None)
        else:
            a_copiar.append(iid)
    erro_tarde = None
    for _, dia in F.tarefa_curva(agora, dict(estado, feitos=feitos)):
        # a folha das 17:30 (boletim-1730): o dia corrente, uma vez. É ADICIONAL: falha aqui não barra o resto da rodada (o diário recuperado,
        # a fila, o índice e o estado seguem gravados); vai para `erros`, não vira feito, e a rodada sai vermelha no FIM (como erro_curvas)
        iid = 'curva-' + dia
        try:
            # RW-301: TUDO da folha fica aqui dentro (as entradas, o gera, o texto, o item e o índice); o resultado só entra em feitos, novos,
            # erros, barrados e índice depois que a iteração inteira deu certo
            if os.environ.get('TARDE_OK') not in (None, '', 'success'):   # o passo "Entradas da tarde" do workflow falhou ou não rodou
                raise RuntimeError('as entradas da tarde não foram baixadas (passo: %s)' % os.environ.get('TARDE_OK'))
            w2r, iq = le('way2_recent.json'), le('gestao__restricao_iqony.json')
            if w2r is None or iq is None:   # nunca uma folha sem o limite
                raise RuntimeError('faltam as entradas da tarde (%s)' % ', '.join(n for n, x in (('medição de 5 min', w2r), ('ordens da Iqony', iq)) if x is None))
            resumo, guardado, sobra, pasta = gera_curva(dia, w2r, iq, agora, render)
            feitos_i, novos_i, erros_i = [], [], []
            if sobra:
                erros_i.append({'id': iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': 'inglês com português: ' + ', '.join(sobra)})
            else:
                en = guardado.get('en', {})
                novos_i.append({'id': iid, 'tipo': 'curva', 'dia': dia, 'texto': F.texto_curva_en(resumo),
                                'imagens': en.get('imagens', []), 'arquivos': [en['pdf']] if en.get('pdf') else [], 'guardado': guardado})
                feitos_i.append('curva:' + dia)
            ind_i = {'pasta': pasta, 'ate': resumo['medicao_ate'], 'gerado': agora.isoformat(timespec='minutes')}
            for n_ in novos_i:   # RW-401: as guardas de texto aqui dentro: a recusa é erro da folha, não da rodada
                F.valida_item(n_)
        except (Exception, SystemExit) as e:   # noqa: BLE001  (o RECUSADO do curva1730 também)
            erro_tarde = (str(e) or type(e).__name__)[:300]
            erros.append({'id': iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': 'folha das 17:30: ' + erro_tarde})
            print('::error::folha das 17:30 de %s não gerada: %s' % (dia, erro_tarde))
            ENVIADOS.pop(iid, None)
            continue
        feitos += feitos_i
        novos += novos_i
        erros += erros_i
        if erros_i:
            barrados.append(iid)
        indice.setdefault('curva', {})[dia] = ind_i
        if erros_i:
            ENVIADOS.pop(iid, None)
        else:
            a_copiar.append(iid)
    erro_curvas = None
    # a página do SIGO desenha as curvas do boletim: a mesma conta do boletim.py, só a demanda ativa por entidade. São DERIVADAS:
    # falha aqui, inclusive na leitura da medição, não derruba o diário (fila, índice e estado seguem gravados; a rodada sai vermelha no fim)
    try:
        w2 = le('way2_30min.json')
        if w2 is not None:
            cv = C.monta(w2, le('irr_ufv.json', {}), le_curvas(), agora.date().isoformat())
            grava('curvas.json', cv)
            print('curvas da página:', len(cv['dias']), 'dias, de', cv['de'], 'a', cv['ate'])
    except Exception as e:   # noqa: BLE001
        erro_curvas = str(e)[:300] or type(e).__name__
        print('::error::curvas da página não refeitas: ' + erro_curvas)
    erro_rd = None
    falhas_rd = []
    try:
        itens_rd = F.itens_rd(le('acervo/catalogo.json', {}), agora.date(), dict(estado, feitos=feitos), falhas_rd)
    except (Exception, SystemExit) as e:   # noqa: BLE001  (o catálogo ilegível: nenhum RD nesta rodada, a rodada segue)
        itens_rd = []
        falhas_rd.append({'codigo': 'catalogo', 'motivo': (str(e) or type(e).__name__)[:200]})
    for fr in falhas_rd:
        erro_rd = fr['motivo']
        erros.append({'id': 'rd-' + fr['codigo'], 'quando': agora.isoformat(timespec='minutes'), 'motivo': erro_rd})
        print('::error::RD %s não vai ao grupo: %s' % (fr['codigo'], erro_rd))
    for item in itens_rd:
        try:
            F.valida_item(item)   # RW-401: a recusa é erro deste RD, não da rodada
        except (Exception, SystemExit) as e:   # noqa: BLE001
            erro_rd = (str(e) or type(e).__name__)[:300]
            erros.append({'id': item.get('id') or 'rd-' + item['codigo'], 'quando': agora.isoformat(timespec='minutes'), 'motivo': erro_rd})
            print('::error::RD %s não vai ao grupo: %s' % (item['codigo'], erro_rd))
            continue
        novos.append(item)
        feitos.append('rd:' + item['codigo'])
    try:
        total = ((executivo or {}).get('totais_vida') or {}).get('total_gwh') or estado.get('ultimo_total_gwh')
    except Exception:   # noqa: BLE001  (executivo fora da forma: fica o último total conhecido)
        total = estado.get('ultimo_total_gwh')
    # a ordem de subida (boletim-blobs.js) é edições → fila → índice → estado; aqui só se grava
    fl = F.junta_fila(fila, novos, agora)
    grava('fila.json', fl)
    # RW-401 (b) e RW-402: enviados/ é o que foi ao grupo. A cópia só depois da fila gravada e só para os ids que estão nela; a cópia que
    # falha deixa o item na fila (ele vai ao grupo), mas é erro: entra em `erros` (enviados-<id>) e a rodada sai 1 no fim
    na_fila = {i['id'] for i in fl['itens']}
    erro_enviados = None
    for iid in a_copiar:
        if iid not in na_fila:
            ENVIADOS.pop(iid, None)
            continue
        try:
            copia_enviados(iid)
        except Exception as e:   # noqa: BLE001
            erro_enviados = (str(e) or type(e).__name__)[:300]
            erros.append({'id': 'enviados-' + iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': 'cópia para enviados/: ' + erro_enviados})
            print('::error::cópia para enviados/ de %s falhou (o item está na fila): %s' % (iid, erro_enviados))
    estado = dict(estado, feitos=feitos[-2000:], erros=erros, ultimo_total_gwh=total, atualizado=agora.isoformat(timespec='minutes'))
    grava('indice.json', dict(indice, esquema=1, atualizado=agora.isoformat(timespec='minutes')))
    grava('estado.json', estado)
    print('rodada', agora.isoformat(timespec='minutes'), '·', len(novos), 'novo(s):', ', '.join(n['id'] for n in novos) or 'nada')
    if barrados:
        print('::error::boletim barrado pela guarda de português (não enviado, tenta de novo na próxima rodada): ' + ', '.join(barrados))
    if barrados or erro_curvas or erro_tarde or erro_diario or erro_rd or erro_enviados:
        sys.exit(1)


if __name__ == '__main__':
    main()
