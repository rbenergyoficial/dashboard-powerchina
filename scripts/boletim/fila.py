# -*- coding: utf-8 -*-
"""Lote boletim-desempenho · o que gerar e o que pôr na fila de envio ao WeCom. Funções puras (o ensaio as chama direto); o __main__
orquestra uma rodada do pipeline.

Calendário:
  · diário do dia anterior a partir das 07:00, UMA vez, com o que houver (o que o ONS ainda não publicou sai estimado); sem segunda
    edição quando o ONS publica. Rodada que falhou ou não rodou se recupera: os dias anteriores ainda não feitos, até TETO_DIAS;
  · no dia 1º (recuperável até o dia TETO_MENSAL_DIA), o MENSAL do mês fechado e o RD do mês (PDF PT e EN, só emitido no acervo); nas viradas que fecham período, também o
    TRIMESTRAL (jan, abr, jul, out), o SEMESTRAL (jan, jul) e o ANUAL (jan). RD ainda não emitido não trava o mensal: entra na fila
    quando aparecer no catálogo, uma vez só;
  · fato relevante (meta do Complexo ou do PPA batida no mês, recorde de geração diária, marco de energia acumulada) com vídeo, uma
    vez por fato.
Texto vai em msgtype "text" (o WeCom traduz para os colegas chineses). Regra do humano: nunca escrever "ONS apurou 0"; quando o ONS não
apurou energia, a limitação sai como "≈ X MWh estimados".

Estado: `estado.json` guarda o que já foi GERADO (tarefas e fatos); o registro do que foi ENVIADO fica com quem envia (Function App).
A fila (`fila.json`) é a lista dos itens gerados nos últimos 30 dias; quem envia manda os que ainda não constam no registro dele."""
import datetime as dt
import json
import os
import re

MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
SEMANA = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo']
MARCO_GWH = 50          # um aviso a cada 50 GWh de energia acumulada desde a operação comercial
# O HORÁRIO DO DIÁRIO, num lugar só: a partir desta hora de Brasília (HH:MM) o diário do dia anterior sai. 08:00 (humano, 08/11/2026: "O
# boletim diário pode ser 08h00"): depois do executivo (07:13, PR e irradiação do dia completos) e da coleta Sungrow da cadeia da manhã
# (06:52, com o lote do logger que a ponte das 05:55 grava no cofre por volta das 06:12). Se a ponte falhar, a disponibilidade dos
# inversores só chega na recuperação das 10:17 e sai como "apuração às 10h", nunca um número parcial.
# Mudou a hora? Mude o cron do boletim.yml junto: o ensaio confere que a janela do cron cobre HORA_DIARIO (primeira passada até
# 10 min depois dela, e passadas por pelo menos 80 min). Parâmetro de ambiente: BOLETIM_HORA_DIARIO
HORA_DIARIO = os.environ.get('BOLETIM_HORA_DIARIO') or '08:00'
# O envio das 17:30 "Geração × limite do dia" (lote boletim-1730, humano 08/11/2026: "ok no boletim do dia 17H30"): o dia corrente, uma vez,
# a partir de HORA_CURVA e só até HORA_CURVA_FIM (passado isso, o dia fica sem a folha: a curva de ontem não vai ao grupo no dia seguinte).
# O cron da tarde acompanha (o ensaio confere). Parâmetros: BOLETIM_HORA_CURVA, BOLETIM_HORA_CURVA_FIM
HORA_CURVA = os.environ.get('BOLETIM_HORA_CURVA') or '17:30'
HORA_CURVA_FIM = os.environ.get('BOLETIM_HORA_CURVA_FIM') or '20:00'
DISP_PENDENTE = {'pt': 'apuração às 10h', 'en': 'computed at 10h'}   # a disponibilidade do dia que ainda não chegou: nunca um número parcial
# opção (DESLIGADA): esperar o dia completo nas entradas que chegam depois das 07:00 (PR e irradiação da estação, disponibilidade dos
# inversores) até HORA_LIMITE_ESPERA; passado o limite, sai com o que houver. Liga com BOLETIM_ESPERA_DIA_COMPLETO=1
ESPERA_DIA_COMPLETO = os.environ.get('BOLETIM_ESPERA_DIA_COMPLETO') == '1'
HORA_LIMITE_ESPERA = int(os.environ.get('BOLETIM_HORA_LIMITE_ESPERA') or 11)
TETO_DIAS = 3           # o diário se recupera até 3 dias para trás (rodada que falhou ou não rodou)
TETO_MENSAL_DIA = 5     # o mensal do mês fechado se recupera até o dia 5
JANELA_FILA_DIAS = 30


def nf(v, c=2):
    if v is None:
        return '—'
    return f'{v:,.{c}f}'.replace(',', 'X').replace('.', ',').replace('X', '.')


def maiuscula(s):
    return s[:1].upper() + s[1:]


def ddmm(d):
    return f'{d[8:]}/{d[5:7]}'


def ultimo_dia(ano, mes):
    return (dt.date(ano + (mes == 12), mes % 12 + 1, 1) - dt.timedelta(days=1))


# ───────────────────────── o que gerar nesta rodada ─────────────────────────
def tarefas(agora_brt, estado, ons_dias):
    """agora_brt: datetime de Brasília; estado: {'feitos': [...], 'desde': 'AAAA-MM-DD'}; ons_dias: dias que o ONS já publicou.
    Devolve as tarefas novas, a mais antiga primeiro: ('diario', dia) · ('mensal', ultimo_dia_do_mes). O diário sai uma vez por dia;
    os dias anteriores ainda não feitos (até TETO_DIAS) e o mensal do mês fechado (até o dia TETO_MENSAL_DIA) se recuperam. Nada
    anterior a `desde` (a semeadura) sai; sem `desde`, só o dia anterior."""
    feitos = set(estado.get('feitos', []))
    hoje = agora_brt.date()
    ontem = (hoje - dt.timedelta(days=1)).isoformat()
    desde = estado.get('desde') or ontem
    out = []
    for k in range(TETO_DIAS, 0, -1):
        d = (hoje - dt.timedelta(days=k)).isoformat()
        if k == 1 and agora_brt.strftime('%H:%M') < HORA_DIARIO:
            continue
        if d >= desde and 'diario:' + d not in feitos:
            out.append(('diario', d))
    if hoje.day <= TETO_MENSAL_DIA and (hoje.day > 1 or agora_brt.strftime('%H:%M') >= HORA_DIARIO):
        u = (hoje.replace(day=1) - dt.timedelta(days=1)).isoformat()
        if u >= desde and 'mensal:' + u not in feitos:
            out.append(('mensal', u))
    return out


def tarefa_curva(agora_brt, estado):
    """a folha das 17:30 do dia corrente: uma vez, entre HORA_CURVA e HORA_CURVA_FIM, nunca antes da semeadura"""
    hoje = agora_brt.date().isoformat()
    hm = agora_brt.strftime('%H:%M')
    if not (HORA_CURVA <= hm < HORA_CURVA_FIM) or hoje < (estado.get('desde') or hoje) or 'curva:' + hoje in set(estado.get('feitos', [])):
        return []
    return [('curva', hoje)]


def marca(modo, dia, sobra, ons):
    """o que entra em `feitos` depois de gerar: nada se a guarda de português barrou (a rodada segue vermelha até corrigir)"""
    if sobra:
        return []
    return [f'{modo}:{dia}'] + (['ons:' + dia] if modo == 'diario' and dia in ons else [])


def exige_semeado(estado):
    """a rodada normal só anda com o estado semeado: sem ele, cada RD emitido e cada dia recuperável iriam ao grupo como novos"""
    if not isinstance(estado, dict) or not estado.get('semeado') or not estado.get('desde'):
        raise SystemExit('RECUSADO: boletim/estado.json sem semeadura; rode o workflow com semeia=true uma vez')
    return estado


def semente(estado, rds, ja, total_gwh, agora_brt):
    """a primeira rodada no ar: os RD emitidos e o que já foi ao grupo à mão contam como feitos; nada anterior a ontem sai; a fila
    começa vazia (o que estivesse nela é anterior à semeadura)"""
    quando = agora_brt.isoformat(timespec='minutes')
    est = {'esquema': 1, 'feitos': sorted(set((estado or {}).get('feitos', []) + list(rds) + list(ja))),
           'desde': (agora_brt.date() - dt.timedelta(days=1)).isoformat(), 'ultimo_total_gwh': total_gwh,
           'atualizado': quando, 'semeado': quando}
    return est, {'esquema': 1, 'itens': [], 'atualizado': quando}


FEITO_RE = re.compile(r'^(?:(?:diario|ons|mensal):20[2-9][0-9]-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])|rd:RD-[A-Z]{2,4}-20[2-9][0-9]-[0-9]{4}|fato:[a-z0-9-]{3,60})$')


def valida_feitos(txt):
    """a lista que vem do disparo manual (vírgula); qualquer item fora da forma recusa a lista inteira"""
    itens = [x.strip() for x in (txt or '').split(',') if x.strip()]
    ruins = [x for x in itens if not FEITO_RE.match(x)]
    if ruins:
        raise SystemExit('RECUSADO: feitos fora da forma: ' + ', '.join(repr(x[:40]) for x in ruins[:5]))
    return itens


def faltam_no_dia(pasta, dia):
    """as entradas com prazo que ainda não têm o dia completo (só conta com ESPERA_DIA_COMPLETO)"""
    def le(n):
        try:
            return json.load(open(os.path.join(pasta, n), encoding='utf-8'))
        except Exception:
            return None
    falta = []
    pr = le('pr_ufv.json') or {}
    if str(pr.get('ultimo_dia') or '') < dia:
        falta.append('PR')
    ds = le('sg_disp_dia.json') or {}
    if not any(isinstance(x, dict) and x.get('dia') == dia for x in (ds.get('serie') or [])):
        falta.append('disponibilidade')
    ir = le('irr_ufv.json') or {}
    if str((ir.get('janela') or {}).get('fim') or '') < dia + ' 23:30':
        falta.append('irradiação')
    return falta


# ───────────────────────── RD do acervo ─────────────────────────
def _norm(s):
    return (s or '').replace('�', '').lower()


def rd_esperados(ano, mes):
    """Os RD que fecham na virada do mês (ano, mes) = o mês que acabou de fechar."""
    m = MESES[mes - 1]
    out = [('mensal', f'de {m} de {ano}')]
    if mes in (3, 6, 9, 12):
        out.append(('trimestral', f'{(mes - 1) // 3 + 1}', 'trimestre de %d' % ano))
    if mes in (6, 12):
        out.append(('semestral', f'{(mes - 1) // 6 + 1}', 'semestre de %d' % ano))
    if mes == 12:
        out.append(('anual', 'de %d' % ano))
    return out


def _falha_rd(falhas, d, e):
    """o documento ruim do catálogo: com a lista, registra e segue para o próximo; sem a lista, estoura (quem chama decidiu não tratar)"""
    if falhas is None:
        raise e
    c = str((d.get('codigo') if isinstance(d, dict) else None) or '?')
    if not any(f['codigo'] == c for f in falhas):
        falhas.append({'codigo': c, 'motivo': (str(e) or type(e).__name__)[:200]})


def rd_do_periodo(catalogo, ano, mes, falhas=None):
    """Do catálogo do acervo, os RD emitidos (AP) do período que fechou, com o PDF PT e o EN. Devolve [(tipo, doc)]; o que ainda não foi
    emitido simplesmente não aparece (e aparece numa rodada seguinte, quando o acervo publicar)."""
    docs = []
    for d in (catalogo or {}).get('documentos', []):
        try:
            if d.get('tipo') == 'RD' and d.get('emissao') == 'AP':
                docs.append(d)
        except Exception as e:   # noqa: BLE001
            _falha_rd(falhas, d, e)
    out = []
    for esp in rd_esperados(ano, mes):
        tipo = esp[0]
        for d in docs:
            try:
                t = _norm(d.get('titulo'))
                if tipo == 'mensal' and t.endswith(_norm(esp[1])) and 'trimestre' not in t and 'semestre' not in t:
                    pass
                elif tipo in ('trimestral', 'semestral') and re.search(r'do %s\D{0,3}\s*%s$' % (esp[1], re.escape(_norm(esp[2]))), t):
                    pass
                elif tipo == 'anual' and re.search(r'desempenho operacional %s$' % re.escape(esp[1]), t):
                    pass
                else:
                    continue
                idi = {p.get('idioma'): p for p in d.get('pdfs', [])}
                if 'pt' in idi and 'en' in idi:
                    out.append((tipo, d))
            except Exception as e:   # noqa: BLE001
                _falha_rd(falhas, d, e)
    return out


RD_EN = {'mensal': 'Monthly', 'trimestral': 'Quarterly', 'semestral': 'Half-year', 'anual': 'Annual'}


def itens_rd(catalogo, hoje_brt, estado, falhas=None):
    """Itens de RD a pôr na fila: os do período que fechou no último dia 1º (até 60 dias para trás), cada código uma vez só. Com `falhas`
    (lista), o documento ruim vai para ela e os outros seguem."""
    feitos = set(estado.get('feitos', []))
    out = []
    ref = hoje_brt.replace(day=1) - dt.timedelta(days=1)          # o último mês fechado
    for k in range(2):                                             # o mês fechado e o anterior (RD que atrasou mais de um mês)
        a, m = (ref.year, ref.month) if k == 0 else ((ref.replace(day=1) - dt.timedelta(days=1)).year, (ref.replace(day=1) - dt.timedelta(days=1)).month)
        for tipo, d in rd_do_periodo(catalogo, a, m, falhas):
            try:
                if 'rd:' + d['codigo'] in feitos:
                    continue
                pdfs = sorted(d['pdfs'], key=lambda p: p.get('idioma') != 'pt')
                out.append({'id': 'rd-' + d['codigo'], 'tipo': 'rd', 'rd_tipo': tipo, 'codigo': d['codigo'],
                            'texto': f'SIGO · {RD_EN[tipo]} performance report issued: {d["codigo"]} Rev{d.get("revisao", "00")}. '
                                     'Attached: the Portuguese and the English versions.',
                            'imagens': [], 'arquivos': [p['blob'] for p in pdfs if p.get('idioma') in ('pt', 'en')]})
            except Exception as e:   # noqa: BLE001
                _falha_rd(falhas, d, e)
    return out


# ───────────────────────── fatos relevantes ─────────────────────────
def fatos(executivo, dia, estado):
    """Fatos novos no dia (AAAA-MM-DD fechado). Cada um tem id estável: meta-<u>-<mes>, recorde-<dia>, marco-<n>GWh."""
    feitos = set(estado.get('feitos', []))
    out = []
    serie = [r for r in executivo.get('serie_dia_ufv', []) if r.get('liq_mwh') is not None and not r.get('parcial')]
    # meta do mês batida (só Complexo e PPA: humano, 07/11/2026)
    mes = dia[:7]
    for u in ('Complexo', 'PPA'):
        man = next((m for m in executivo.get('manchete_ufv', []) if m.get('ufv') == u and m.get('mes') == mes), None)
        if not man or not man.get('meta_mwh'):
            continue
        dias = sorted(r['dia'] for r in serie if r['ufv'] == u and r['dia'][:7] == mes and r['dia'] <= dia)
        acum = sum(r['liq_mwh'] for r in serie if r['ufv'] == u and r['dia'][:7] == mes and r['dia'] <= dia)
        antes = sum(r['liq_mwh'] for r in serie if r['ufv'] == u and r['dia'][:7] == mes and r['dia'] < dia)
        fid = f'meta-{u}-{mes}'
        if acum >= man['meta_mwh'] > antes and 'fato:' + fid not in feitos and dias and dias[-1] == dia:
            out.append({'id': fid, 'tipo': 'meta', 'ufv': u, 'dia': dia, 'valor': acum, 'meta': man['meta_mwh'],
                        'texto': f'SIGO · Key fact · {"Complex" if u == "Complexo" else u}: {MES_EN[int(mes[5:]) - 1]} target reached on {data_en(dia)}. '
                                 f'{nf_en(acum)} MWh of {nf_en(man["meta_mwh"])} MWh ({nf_en(acum / man["meta_mwh"] * 100, 1)}%).'})
    # recorde de geração diária do Complexo
    cx = sorted(((r['liq_mwh'], r['dia']) for r in serie if r['ufv'] == 'Complexo' and r['dia'] <= dia), reverse=True)
    hoje = next((v for v, d in cx if d == dia), None)
    antes = max((v for v, d in cx if d < dia), default=None)
    if hoje is not None and antes is not None and hoje > antes and 'fato:recorde-' + dia not in feitos:
        out.append({'id': 'recorde-' + dia, 'tipo': 'recorde', 'dia': dia, 'valor': hoje, 'anterior': antes,
                    'texto': f'SIGO · Key fact · daily generation record on {data_en(dia)}: {nf_en(hoje)} MWh '
                             f'(previous record {nf_en(antes)} MWh).'})
    # marco de energia acumulada: o total da vida (energia líquida medida desde jan/2025, executivo.totais_vida.total_gwh) cruzou um
    # múltiplo de MARCO_GWH desde a última rodada (o estado guarda o total visto por último; a primeira rodada só registra)
    tot = (executivo.get('totais_vida') or {}).get('total_gwh')
    visto = estado.get('ultimo_total_gwh')
    if tot is not None and visto is not None:
        n1, n0 = int(tot // MARCO_GWH), int(visto // MARCO_GWH)
        if n1 > n0 and 'fato:marco-%dGWh' % (n1 * MARCO_GWH) not in feitos:
            out.append({'id': 'marco-%dGWh' % (n1 * MARCO_GWH), 'tipo': 'marco', 'dia': dia, 'valor': tot,
                        'texto': f'SIGO · Key fact · the Mauriti Photovoltaic Complex has passed {nf_en(n1 * MARCO_GWH, 0)} GWh generated '
                                 f'since January 2025 ({nf_en(tot, 2)} GWh up to {data_en(dia)}).'})
    return out


# ───────────────────────── textos ─────────────────────────
def linha_limitacao(r):
    """A frase da limitação do ONS no dia, pela regra do humano (nunca "ONS apurou 0")."""
    ons = r.get('ons_mwh') or 0
    ld = r.get('limitado') or {}
    if ons > 0:
        return f'Impedido pelo ONS: {nf(ons)} MWh em {nf(ld.get("h"), 1)} h de limitação.'
    if (ld.get('h') or 0) > 0 and ld.get('est') is not None:
        return f'Limitado pelo ONS: ≈ {nf(ld["est"])} MWh estimados em {nf(ld["h"], 1)} h de limitação.'
    if (ld.get('h') or 0) > 0:
        return f'Limitado pelo ONS por {nf(ld["h"], 1)} h.'
    return 'Sem limitação do ONS no dia.'


def texto(modo, r):
    """Texto puro (msgtype text) do boletim; r = o resumo que o boletim grava."""
    cx, pp = r.get('complexo') or {}, r.get('ppa') or {}
    d = r['dia']
    if modo in ('diario', 'complemento'):
        sem = SEMANA[dt.date.fromisoformat(d).weekday()]
        cab = ('SIGO · Boletim diário' if modo == 'diario' else 'SIGO · Complemento do boletim') + f' · {sem}, {ddmm(d)}/{d[:4]}'
        linhas = [cab,
                  f'Geração: {nf(r.get("liq"))} MWh (meta do dia {nf(r.get("meta_dia"))} MWh).',
                  linha_limitacao(r),
                  f'Meta do mês: Complexo {nf(cx.get("pct"), 1)}% · PPA {nf(pp.get("pct"), 1)}% (projeção {nf(cx.get("proj_pct"), 0)}% e {nf(pp.get("proj_pct"), 0)}%).',
                  maiuscula(' · '.join(x for x in ((f'PR do dia {nf(r.get("pr"), 1)}%' if r.get('pr') is not None else ''),
                                          (f'disponibilidade {nf(r.get("disp"), 2)}%' if r.get('disp') is not None
                                           else 'disponibilidade: ' + DISP_PENDENTE['pt'])) if x)) + '.']
        linhas = [l for l in linhas if l != '.']   # PR e disponibilidade ainda não apurados: a linha não sai com '—%'
        if modo == 'complemento':
            linhas.insert(1, 'O ONS publicou o dia: a restrição e a comparação com Abaiara e o Nordeste entram agora.')
        return '\n'.join(linhas)
    mes = MESES[int(d[5:7]) - 1]
    return '\n'.join([f'SIGO · Boletim mensal · {mes} de {d[:4]}',
                      f'Complexo: {nf(cx.get("tot"))} MWh, {nf(cx.get("pct"), 1)}% da meta' + (f' (batida em {ddmm(cx["bateu"])}).' if cx.get('bateu') else '.'),
                      f'PPA: {nf(pp.get("tot"))} MWh, {nf(pp.get("pct"), 1)}% da meta' + (f' (batida em {ddmm(pp["bateu"])}).' if pp.get('bateu') else '.'),
                      f'Impedido pelo ONS no mês: {nf(r.get("imp_mes"))} MWh.',
                      f'PR do mês {nf(r.get("pr"), 1)}% ({nf(r.get("pr_sem_corte"), 1)}% sem o corte) · disponibilidade {nf(r.get("disp"), 2)}%.'])


MES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
MES_EN3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
SEMANA_EN = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']


def nf_en(v, c=2):
    return '—' if v is None else f'{v:,.{c}f}'


def data_en(d):
    return f'{int(d[8:])} {MES_EN3[int(d[5:7]) - 1]} {d[:4]}'


def linha_limitacao_en(r):
    ons = r.get('ons_mwh') or 0
    ld = r.get('limitado') or {}
    if ons > 0:
        return f'Curtailed by the ONS: {nf_en(ons)} MWh in {nf_en(ld.get("h"), 1)} h of limitation.'
    if (ld.get('h') or 0) > 0 and ld.get('est') is not None:
        return f'Limited by the ONS: ≈ {nf_en(ld["est"])} MWh estimated in {nf_en(ld["h"], 1)} h of limitation.'
    if (ld.get('h') or 0) > 0:
        return f'Limited by the ONS for {nf_en(ld["h"], 1)} h.'
    return 'No ONS limitation on the day.'


def texto_en(modo, r):
    """O texto que vai ao grupo do WeCom: SÓ EM INGLÊS (humano, 07/11/2026). Os números saem do mesmo resumo da imagem."""
    cx, pp = r.get('complexo') or {}, r.get('ppa') or {}
    d = r['dia']
    if modo in ('diario', 'complemento'):
        cab = ('SIGO · Daily performance bulletin' if modo == 'diario' else 'SIGO · Bulletin update') + \
              f' · {SEMANA_EN[dt.date.fromisoformat(d).weekday()]}, {data_en(d)}'
        linhas = [cab,
                  f'Generation: {nf_en(r.get("liq"))} MWh (day target {nf_en(r.get("meta_dia"))} MWh).',
                  linha_limitacao_en(r),
                  f'Month target: Complex {nf_en(cx.get("pct"), 1)}% · PPA {nf_en(pp.get("pct"), 1)}% (projection {nf_en(cx.get("proj_pct"), 0)}% and {nf_en(pp.get("proj_pct"), 0)}%).',
                  maiuscula(' · '.join(x for x in ((f'Day PR {nf_en(r.get("pr"), 1)}%' if r.get('pr') is not None else ''),
                                          (f'availability {nf_en(r.get("disp"), 2)}%' if r.get('disp') is not None
                                           else 'availability: ' + DISP_PENDENTE['en'])) if x)) + '.']
        linhas = [l for l in linhas if l != '.']
        if modo == 'complemento':
            linhas.insert(1, 'The ONS has published the day: curtailment and the comparison with Abaiara and the Northeast are now included.')
        return '\n'.join(linhas)
    mes = MES_EN[int(d[5:7]) - 1]
    bateu = lambda x: f' (reached on {data_en(x["bateu"])}).' if x.get('bateu') else '.'
    return '\n'.join([f'SIGO · Monthly performance bulletin · {mes} {d[:4]}',
                      f'Complex: {nf_en(cx.get("tot"))} MWh, {nf_en(cx.get("pct"), 1)}% of the target' + bateu(cx),
                      f'PPA: {nf_en(pp.get("tot"))} MWh, {nf_en(pp.get("pct"), 1)}% of the target' + bateu(pp),
                      f'Curtailed by the ONS this month: {nf_en(r.get("imp_mes"))} MWh.',
                      f'Month PR {nf_en(r.get("pr"), 1)}% ({nf_en(r.get("pr_sem_corte"), 1)}% without curtailment) · availability {nf_en(r.get("disp"), 2)}%.'])


# os motivos que o Gestão grava (coleta_parser.js e a lista fechada do RDO, rdo.js MOTIVOS), em inglês; código desconhecido sai neutro,
# "other reason (CODE)", nunca cru nem em português
MOTIVO_EN = {'ENE_FREQ': 'energy, frequency control', 'FLUXO': 'flow or interchange', 'ELE_SGI': 'contingency, SGI or unavailability',
             'REATIVO': 'reactive power control', 'PATAMAR': 'load level', 'OUTRO': 'other reason'}


def motivo_en(m):
    if m in MOTIVO_EN:
        return MOTIVO_EN[m]
    c = re.sub(r'[^A-Z0-9_]', '', str(m or '').upper())
    # o código que coincide com palavra portuguesa ("DE", "EM"...) cairia na guarda do inglês: sai sem ele
    return 'other reason (%s)' % c if c and not PT_RESTO.search(c) else 'other reason'


def texto_curva_en(r):
    """O texto das 17:30 ao grupo (só inglês): os números do mesmo resumo da folha. Dia sem ordem diz isso; coletor parado avisa."""
    d = r['dia']
    linhas = [f'SIGO · Generation × limit of the day · {SEMANA_EN[dt.date.fromisoformat(d).weekday()]}, {data_en(d)}, metering to {r["medicao_ate"]}',
              f'Generation: {nf_en(r.get("energia_mwh"))} MWh (peak {nf_en(r.get("pico_mw"), 1)} MW).']
    if r.get('n_ordens'):
        mot = ', '.join(motivo_en(m) for m in r.get('motivos') or []) or '—'
        linhas.append(f'ONS orders: {r["n_ordens"]} between {r["primeira"]} and {r["ultima"]}; {nf_en(r.get("horas_sob_limite"), 1)} h under limit, '
                      f'minimum {nf_en(r.get("limite_min_mw"), 0)} MW ({mot}).')
    elif r.get('herdada'):
        linhas.append(f'No new ONS order; the day started under the order of the previous day ({nf_en(r.get("horas_sob_limite"), 1)} h under limit).')
    else:
        linhas.append(f'No ONS curtailment order recorded in the day to {r["medicao_ate"]}.')
    if r.get('coletor') == 'parado':
        linhas.append('Warning: the order collector is stopped; the limit may be incomplete.')
    linhas.append('Limit from the ONS orders received by Iqony; the official ONS figures come in the daily bulletin of tomorrow.')
    return '\n'.join(linhas)


PT_RESTO = re.compile(r'[ãõçáéíóúâêô]|\b(?:de|do|da|dos|das|em|com|não|mês|dia|meta|usina|corte|geração)\b', re.I)


def sem_portugues(t):
    """a mesma guarda do traduz_en.py, para o texto: inglês com português não vai ao grupo"""
    s = sorted(set(m.group(0) for m in PT_RESTO.finditer(t.replace('Participações', ''))))
    if s:
        raise SystemExit('RECUSADO: texto em inglês com português: ' + ', '.join(s))
    return t


PROIBIDO = [re.compile(r'ONS\s+apurou\s+0', re.I), re.compile(r'apurou\s+0[,.]?0*\s*MWh', re.I)]


def confere_texto(t):
    for p in PROIBIDO:
        if p.search(t):
            raise SystemExit('RECUSADO: texto com "ONS apurou 0" (regra do humano): ' + t[:120])
    return t


# ───────────────────────── a fila ─────────────────────────
def valida_item(n):
    """as guardas de texto de um item da fila, num lugar só: a rodada chama dentro do try de cada item (a recusa vira erro daquele item) e a
    junta_fila de novo, por garantia"""
    confere_texto(n.get('texto', ''))
    sem_portugues(n.get('texto', ''))   # ao grupo vai só inglês (humano, 07/11/2026)
    return n


def junta_fila(fila, novos, hoje_brt):
    """Acrescenta os itens novos (id único) e descarta os de mais de 30 dias."""
    lim = (hoje_brt.date() - dt.timedelta(days=JANELA_FILA_DIAS)).isoformat()
    ids = {i['id'] for i in fila.get('itens', [])}
    itens = [i for i in fila.get('itens', []) if i.get('criado', '9999')[:10] >= lim]
    for n in novos:
        if n['id'] in ids:
            continue
        valida_item(n)
        n.setdefault('criado', hoje_brt.isoformat(timespec='minutes'))
        itens.append(n)
        ids.add(n['id'])
    return {'esquema': 1, 'gerado': hoje_brt.isoformat(timespec='minutes'), 'itens': itens}


def ons_dias(pasta, falhas=None):
    """Os dias que o ONS já publicou, pelos arquivos ons_restricao_AAAA_MM.json baixados. O arquivo ilegível não derruba quem chama (a decisão
    e a folha das 17:30 não dependem dele): vira aviso e entra em `falhas` (lista), para a rodada recair só no diário e no mensal."""
    out = set()
    for f in os.listdir(pasta):
        if f.startswith('ons_restricao_') and f.endswith('.json'):
            try:
                c = json.load(open(os.path.join(pasta, f), encoding='utf-8-sig')).get('consolidado') or []
                if isinstance(c, str):
                    import ast
                    c = ast.literal_eval(c)
                out.update(str(x.get('ts', ''))[:10] for x in c if x.get('ts'))
            except Exception as e:   # noqa: BLE001
                print('::warning::arquivo do ONS ilegível, %s: %s' % (f, (str(e) or type(e).__name__)[:200]))
                if falhas is not None:
                    falhas.append(f)
    return out
