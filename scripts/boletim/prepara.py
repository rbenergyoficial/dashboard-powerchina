# -*- coding: utf-8 -*-
"""Boletim de Desempenho · prepara o boletim.py aprovado (Boletim_Desempenho/boletim.py) para rodar no pipeline.
Não muda o desenho: cinco trocas de ambiente e de saída, cada uma com contagem exata 1.
  1. a pasta de entrada e saída vem de BOLETIM_DIR (no PC era a pasta do script);
  2. o logotipo vem de BOLETIM_LOGO (no PC era um caminho do OneDrive);
  3. a hora "gerado no SIGO em" sai no fuso de Brasília também no Linux do GitHub (TZ do runner é UTC);
  4. grava o resumo em JSON (os números do texto do WeCom);
  5. a disponibilidade do dia que ainda não chegou (os inversores só fecham o dia às 10:17) sai "apuração às 10h", nunca "—%".
    python prepara.py <boletim.py aprovado> <saida boletim_ci.py>
Recusa se alguma âncora não casar uma vez só (o desenho mudou: refazer a conferência)."""
import hashlib, io, sys

TROCAS = [
    ("AQUI = os.path.dirname(os.path.abspath(__file__))",
     "AQUI = os.environ.get('BOLETIM_DIR') or os.path.dirname(os.path.abspath(__file__))   # boletim-desempenho: a pasta do pipeline"),
    ("open(r'C:\\Users\\user\\OneDrive - rbenergy.com.br\\PWC\\Logo_Intrepid\\logo_intrepid_800.png', 'rb')",
     "open(os.environ.get('BOLETIM_LOGO') or r'C:\\Users\\user\\OneDrive - rbenergy.com.br\\PWC\\Logo_Intrepid\\logo_intrepid_800.png', 'rb')"),
    ("GERADO = dt.datetime.now().strftime('%d/%m/%Y %H:%M')",
     "GERADO = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(hours=3)).strftime('%d/%m/%Y %H:%M')   # Brasília, sem horário de verão"),
    # 4. o resumo em JSON (os números do texto do WeCom saem do MESMO cálculo da imagem, nunca de outra conta)
    ("print('ok', saida + suf, len(partes), 'partes'",
     "_R = {'modo': MODO, 'dia': DIA, 'complexo': {k: cx.get(k) for k in ('tot', 'meta', 'pct', 'proj_pct', 'bateu', 'prev')},\n"
     "      'ppa': {k: pp.get(k) for k in ('tot', 'meta', 'pct', 'proj_pct', 'bateu', 'prev')}}\n"
     "if MODO == 'diario':\n"
     "    _R.update(liq=liq, meta_dia=meta_d, ons_mwh=o.get('cortado_mwh'), limitado=LD, pr=p, disp=dsp, ons_estado=ONS_EST, iqony=IQD)\n"
     "else:\n"
     "    _R.update(imp_mes=imp_mes, pr=pm, pr_sem_corte=pcm, disp=dsm)\n"
     "json.dump(_R, open(os.path.join(AQUI, f'{saida}{suf}_resumo.json'), 'w', encoding='utf-8'), ensure_ascii=False, default=str)   # boletim-desempenho\n"
     "print('ok', saida + suf, len(partes), 'partes'"),
    (" {kpi(OK,'Disponibilidade do dia',nf(dsp,2),'%',f'no mês {nf(dsm,2)}%')}",
     " {kpi(OK,'Disponibilidade do dia',nf(dsp,2) if dsp is not None else '<span style=font-size:19px>apuração às 10h</span>',"
     "'%' if dsp is not None else '',f'no mês {nf(dsm,2)}%')}"),
]


def prepara(texto):
    for de, para in TROCAS:
        n = texto.count(de)
        if n != 1:
            raise SystemExit('RECUSADO: a âncora casou %d vezes: %r' % (n, de[:70]))
        texto = texto.replace(de, para)
    return texto


# boletim-branco (humano, 21/11/2026: "o colorido no pdf está muito forte, quero algo mais profissional faça o relatorio com o fundo branco
# mesmo, igual ao RDO restrição ONS, no padrão" e "Branco nos dois", diário e mensal; substitui o desenho v2 de 20/11). Só o tema CLARO
# muda (o que vai ao WeCom e ao PDF): página branca, Arial, títulos em marinho, uma cor por série da paleta Iqony/MBRF, estado só em verde,
# âmbar e vermelho sóbrios, cartões sem caixa nem faixa colorida. Em qualquer tema, o nome da empresa sai de baixo do logotipo (o logotipo
# já o traz; fica no rodapé). O tema escuro (a página do SIGO) não muda.
CSS_BRANCO = ("\nif TEMA == 'claro':   # boletim-branco: camada por cima do CSS do tema claro\n"
              "    CSS += f'''body,.k,.bh,.sv-lbl,.sv-big,.sv-sub,.sv-ax,.sv-ax2,.sv-val,.pt h2,.kc b{{font-family:Arial,'Liberation Sans',sans-serif !important}}\n"
              ".sv-big{{font-weight:700 !important}} .pn{{border-radius:6px;padding:18px 20px}} .pt h2{{color:{RDO_AZUL};font-size:18px}}\n"
              ".kc{{border:0;border-top:1px solid {BORDA};border-radius:0;padding:11px 4px 6px 2px}}'''\n")
TROCAS_BRANCO = [
    ("    FUNDO, PAINEL, BORDA = '#F3F4F6', '#FFFFFF', '#E1E4E9'\n    T1, T2, T3 = '#05070A', '#232A33', '#434B57'\n"
     "    TRILHO, LINHA, RODA, BASE_ROT = '#EEF0F3', '#EEF0F3', '#5C6370', '#05070A'\n"
     "    COR.update({'M1': '#B6056C', 'M2': '#A58C03', 'M3': '#22907C', 'M4': '#4E5435', 'M6': '#B08374', 'M7': '#9E84A6', 'M9': '#049AA4'})\n"
     "    GER, IRR = '#BF7E04', '#B8920F'\n",
     "    FUNDO, PAINEL, BORDA = '#FFFFFF', '#FFFFFF', '#D5DBE3'   # boletim-branco\n    T1, T2, T3 = '#1F2933', '#1F2933', '#5B6778'\n"
     "    TRILHO, LINHA, RODA, BASE_ROT = '#F2F5F9', '#E3E7ED', '#787878', '#1F2933'\n"
     "    COR.update({k: '#1F6FB2' for k in COR}); COR['PPA'] = '#2E9E84'   # uma cor por série (paleta Iqony/MBRF)\n"
     "    GER, CORTE, IRR = '#1F6FB2', '#A9B4C2', '#2E9E84'\n"
     "    OK, ATN, RUIM = '#1E7B4F', '#B26B00', '#B3261E'   # estado só em verde, âmbar e vermelho sóbrios\n"),
    ("    if TEMA == 'claro': p = min(round(p * 1.9), 92)   # no branco o véu fica mais cheio (pedido do humano, 07/11)\n",
     "    if TEMA == 'claro': p = min(round(p * 1.2), 60)   # boletim-branco: véu leve\n"),
    ("ORIGEM = {'SIS': ('Sistêmica', '#A79BE8'), 'LOC': ('Local', '#7A6FB5')}\n",
     "ORIGEM = {'SIS': ('Sistêmica', '#A79BE8'), 'LOC': ('Local', '#7A6FB5')}\n"
     "if TEMA == 'claro':   # boletim-branco: azul e cinza, sem lilás\n"
     "    MOTIVO = {'ENE': ('Energética', '#7FA6CF'), 'CNF': ('Confiabilidade elétrica', '#A9B4C2'), 'REL': ('Restrição elétrica', '#5B6778')}\n"
     "    ORIGEM = {'SIS': ('Sistêmica', '#7FA6CF'), 'LOC': ('Local', '#A9B4C2')}\n"),
    (".rd .c{{text-align:center}} .rd .b{{display:flex;justify-content:space-between;margin-top:6px}}'''\n",
     ".rd .c{{text-align:center}} .rd .b{{display:flex;justify-content:space-between;margin-top:6px}}'''\n" + CSS_BRANCO),
    ('<img src="data:image/png;base64,{LOGO64}"><div class="emp">{EMPRESA}</div><div class="cj">{CONJ}</div>',
     '<img src="data:image/png;base64,{LOGO64}"><div class="cj">{CONJ}</div>'),
]


def branco(texto):
    """boletim-branco: as trocas do padrão branco, cada uma com contagem exata 1 (o desenho mudou = recusa)"""
    for de, para in TROCAS_BRANCO:
        n = texto.count(de)
        if n != 1:
            raise SystemExit('RECUSADO (boletim-branco): a âncora casou %d vezes: %r' % (n, de[:70]))
        texto = texto.replace(de, para)
    return texto


if __name__ == '__main__':
    fonte, saida = sys.argv[1], sys.argv[2]
    t = io.open(fonte, encoding='utf-8', newline='').read()
    novo = branco(prepara(t))
    assert prepara.__name__ and all(p in novo for _, p in TROCAS) and all(p in novo for _, p in TROCAS_BRANCO)
    io.open(saida, 'w', encoding='utf-8', newline='').write(novo)
    h = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]
    print('boletim aprovado %s -> pipeline %s (%d trocas)' % (h(t), h(novo), len(TROCAS)))
