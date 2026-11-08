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
    return json.load(open(p, encoding='utf-8')) if os.path.exists(p) else padrao


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
            # o arquivo do enviado: enviados/<data>/PT|EN/<nome>, com o sufixo _en no fim (diario_claro_p1_en.png, mensal_2026-10_claro_en.pdf)
            hoje = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).date().isoformat()
            dst = os.path.join(SAI, 'enviados', hoje, idi.upper())
            os.makedirs(dst, exist_ok=True)
            base_env = 'diario_claro' if modo == 'diario' else f'mensal_{dia[:7]}_claro'
            for p in r['partes'] + [r['pdf']]:
                n = os.path.basename(p).replace(f'{arg}_claro_en', f'{arg}_claro').replace(f'{arg}_claro', base_env)
                if idi == 'en':
                    raiz, ext = os.path.splitext(n); n = raiz + '_en' + ext
                shutil.copyfile(p, os.path.join(dst, n))
    return resumo, guardado, sorted(sobra), rel(pasta)


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
            saida_gh(pesado='true', agora=agora.isoformat(timespec='minutes'))
            return
        F.exige_semeado(estado)
        ts = F.tarefas(agora, estado, F.ons_dias(DIR))
        # as curvas de 30 min da página: sem o arquivo, ou parado antes de ontem, a rodada desce a medição e o refaz
        cv = C.velho(le_curvas(), (agora.date() - dt.timedelta(days=1)).isoformat(), agora.date().isoformat())
        print('tarefas:', ', '.join(f'{m}:{d}' for m, d in ts) or 'nenhuma', '· curvas da página:', 'refazer' if cv else 'em dia')
        saida_gh(pesado='true' if ts or cv else 'false', agora=agora.isoformat(timespec='minutes'))
        return
    fila = le('boletim/fila.json', {'itens': []})
    indice = le('boletim/indice.json', {'diario': {}, 'mensal': {}})
    executivo = le('executivo.json')
    ons = F.ons_dias(DIR)
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
    for modo, dia in F.tarefas(agora, estado, ons):
        if modo == 'diario' and F.ESPERA_DIA_COMPLETO and agora.hour < F.HORA_LIMITE_ESPERA:
            falta = F.faltam_no_dia(DIR, dia)
            if falta:
                print(f'diário de {dia} espera o dia completo em: {", ".join(falta)} (até {F.HORA_LIMITE_ESPERA}:00)')
                continue
        if executivo is None:
            raise SystemExit(f'RECUSADO: há o que gerar ({modo} {dia}) e as entradas pesadas não foram baixadas')
        resumo, guardado, sobra, pasta = gera('mensal' if modo == 'mensal' else 'diario', dia, render)
        iid = f'{modo}-{dia}'
        feitos += F.marca(modo, dia, sobra, ons)
        if sobra:
            # inglês com português não vai ao grupo e NÃO vira feito: a rodada seguinte tenta de novo e segue vermelha até corrigir
            erros.append({'id': iid, 'quando': agora.isoformat(timespec='minutes'), 'motivo': 'inglês com português: ' + ', '.join(sobra)})
            barrados.append(iid)
        else:
            en = guardado.get('en', {})
            novos.append({'id': iid, 'tipo': modo, 'dia': dia, 'texto': F.texto_en(modo, resumo),
                          'imagens': en.get('imagens', []), 'arquivos': [en['pdf']] if en.get('pdf') else [],
                          'guardado': guardado})
        chave = 'mensal' if modo == 'mensal' else 'diario'
        indice.setdefault(chave, {})[dia if chave == 'diario' else dia[:7]] = {'pasta': pasta, 'ons': dia in ons, 'gerado': agora.isoformat(timespec='minutes')}
        if modo == 'diario' and not sobra:
            for fato in F.fatos(executivo, dia, dict(estado, feitos=feitos)):
                arqs_f, imgs_f = [], []
                if render:
                    import anima_fato
                    os.makedirs(os.path.join(SAI, 'fatos'), exist_ok=True)
                    mp4, png = anima_fato.anima(fato, executivo, os.path.join(SAI, 'fatos', fato['id'] + '.mp4'))
                    rel = lambda p: os.path.relpath(p, os.path.dirname(SAI)).replace('\\', '/')
                    arqs_f, imgs_f = [rel(mp4)], [rel(png)]
                novos.append({'id': 'fato-' + fato['id'], 'tipo': 'fato', 'dia': dia, 'texto': fato['texto'], 'imagens': imgs_f, 'arquivos': arqs_f})
                feitos.append('fato:' + fato['id'])
    w2 = le('way2_30min.json')
    erro_curvas = None
    if w2 is not None:
        # a página do SIGO desenha as curvas do boletim: a mesma conta do boletim.py, só a demanda ativa por entidade. São DERIVADAS:
        # falha aqui não derruba o diário (fila, índice e estado seguem gravados; a rodada sai vermelha no fim)
        try:
            cv = C.monta(w2, le('irr_ufv.json', {}), le_curvas(), agora.date().isoformat())
            grava('curvas.json', cv)
            print('curvas da página:', len(cv['dias']), 'dias, de', cv['de'], 'a', cv['ate'])
        except Exception as e:   # noqa: BLE001
            erro_curvas = str(e)[:300] or type(e).__name__
            print('::error::curvas da página não refeitas: ' + erro_curvas)
    for item in F.itens_rd(le('acervo/catalogo.json', {}), agora.date(), dict(estado, feitos=feitos)):
        novos.append(item)
        feitos.append('rd:' + item['codigo'])
    total = ((executivo or {}).get('totais_vida') or {}).get('total_gwh') or estado.get('ultimo_total_gwh')
    estado = dict(estado, feitos=feitos[-2000:], erros=erros, ultimo_total_gwh=total, atualizado=agora.isoformat(timespec='minutes'))
    # a ordem de subida (boletim-blobs.js) é edições → fila → índice → estado; aqui só se grava
    grava('fila.json', F.junta_fila(fila, novos, agora))
    grava('indice.json', dict(indice, esquema=1, atualizado=agora.isoformat(timespec='minutes')))
    grava('estado.json', estado)
    print('rodada', agora.isoformat(timespec='minutes'), '·', len(novos), 'novo(s):', ', '.join(n['id'] for n in novos) or 'nada')
    if barrados:
        print('::error::boletim barrado pela guarda de português (não enviado, tenta de novo na próxima rodada): ' + ', '.join(barrados))
    if barrados or erro_curvas:
        sys.exit(1)


if __name__ == '__main__':
    main()
