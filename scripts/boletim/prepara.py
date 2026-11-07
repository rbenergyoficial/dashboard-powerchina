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
     "    _R.update(liq=liq, meta_dia=meta_d, ons_mwh=o.get('cortado_mwh'), limitado=LD, pr=p, disp=dsp)\n"
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


if __name__ == '__main__':
    fonte, saida = sys.argv[1], sys.argv[2]
    t = io.open(fonte, encoding='utf-8', newline='').read()
    novo = prepara(t)
    assert prepara.__name__ and all(p in novo for _, p in TROCAS)
    io.open(saida, 'w', encoding='utf-8', newline='').write(novo)
    h = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()[:16]
    print('boletim aprovado %s -> pipeline %s (%d trocas)' % (h(t), h(novo), len(TROCAS)))
