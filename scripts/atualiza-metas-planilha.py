# -*- coding: utf-8 -*-
"""atualiza-metas-planilha.py - traz para data/metas.json as metas que a planilha mudou.

Le a aba PPA da planilha de metas (a copia publicada no blob) POR NOME DE COLUNA, bloco a bloco:
cada mes tem uma linha "Energia Equivalente" e uma "Valor Garantido de <mes>".

Guardas, todas antes de gravar:
  - todo mes da planilha que NAO esta sendo atualizado tem de bater com o metas.json ao centavo.
    Se outro mes mudou sem ter sido anunciado, o script PARA e diz qual — atualizar "o que mudou"
    sem olhar o resto e o jeito de publicar uma alteracao que ninguem viu;
  - por mes: as seis do PPA somam o total do PPA, as tres do ML somam total - PPA;
  - a gravacao reproduz o arquivo byte a byte quando nada muda (indentacao, acentos, ordem).

uso:
  python scripts/atualiza-metas-planilha.py <planilha.xlsx> 2026-09 2026-10 ...          confere
  python scripts/atualiza-metas-planilha.py <planilha.xlsx> 2026-09 2026-10 ... --grava  grava
"""
import io
import json
import os
import re
import sys

import openpyxl

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ALVO = os.path.join(RAIZ, 'data', 'metas.json')
MES = {'jan': 1, 'fev': 2, 'mar': 3, 'abr': 4, 'mai': 5, 'jun': 6,
       'jul': 7, 'ago': 8, 'set': 9, 'out': 10, 'nov': 11, 'dez': 12}
PPA = {'M8': 'M8-PPA (MWh)', 'M2': 'M2-PPA (MWh)', 'M3': 'M3-PPA (MWh)',
       'M4': 'M4-PPA (MWh)', 'M5': 'M5-PPA (MWh)', 'M6': 'M6-PPA (MWh)'}
ML = {'M1': 'UFV Mauriti 10 MWh', 'M7': 'UFV Mauriti 7 MWh', 'M9': 'UFV Mauriti 9 MWh'}   # M10 = M1
EQ = {'M8': 'M8-PPA (MWh)', 'M2': 'M2-PPA (MWh)', 'M3': 'M3-PPA (MWh)', 'M4': 'M4-PPA (MWh)',
      'M5': 'M5-PPA (MWh)', 'M6': 'M6-PPA (MWh)', 'M7': 'UFV Mauriti 7 MWh',
      'M1': 'UFV Mauriti 10 MWh', 'M9': 'UFV Mauriti 9 MWh'}
TOTAL, TOTAL_PPA = 'Energia Total de rede MWh', 'PPA (BRF) MWh'


def num(v):
    """2 casas, e inteiro quando e inteiro — e assim que o arquivo guarda (48960, e nao 48960.0)."""
    v = round(float(v), 2)
    return int(v) if v == int(v) else v


def le_planilha(arq):
    rows = list(openpyxl.load_workbook(arq, read_only=True, data_only=True)['PPA'].iter_rows(values_only=True))
    cab = {str(c).strip(): i for i, c in enumerate(rows[0]) if c is not None}
    for n in list(PPA.values()) + list(ML.values()) + [TOTAL, TOTAL_PPA]:
        if n not in cab:
            raise SystemExit('RECUSADO: a coluna %r sumiu da aba PPA — o layout mudou' % n)
    out, eq = {}, None
    for r in rows:
        a = r[0]
        if not isinstance(a, str):
            continue
        rot = a.strip().lower()
        if rot.startswith('energia equivalente'):
            eq = r
            continue
        if not rot.startswith('valor garantido'):
            continue
        m = re.search(r'de\s+([a-zç]{3})/(\d{2})', rot)
        if not m:
            raise SystemExit('RECUSADO: rotulo de meta nao reconhecido: %r' % a)
        k = '20%s-%02d' % (m.group(2), MES[m.group(1)])
        if k in out:
            raise SystemExit('RECUSADO: %s aparece duas vezes na planilha' % k)
        if eq is None:
            raise SystemExit('RECUSADO: %s sem linha de Energia Equivalente acima' % k)
        g = {
            'garantido_total': num(r[cab[TOTAL]]),
            'garantido_ppa': num(r[cab[TOTAL_PPA]]),
            'ppa_por_ufv': {u: num(r[cab[c]]) for u, c in PPA.items()},
            'ml_por_ufv': {u: num(r[cab[c]]) for u, c in ML.items()},
            'equivalente_total': num(eq[cab[TOTAL]]),
            'equivalente_por_ufv': {u: num(eq[cab[c]]) for u, c in EQ.items()},
        }
        # coerencia interna do proprio bloco
        if abs(sum(g['ppa_por_ufv'].values()) - g['garantido_ppa']) > 0.05:
            raise SystemExit('RECUSADO: %s — as seis do PPA nao somam o total do PPA' % k)
        if abs(sum(g['ml_por_ufv'].values()) - (g['garantido_total'] - g['garantido_ppa'])) > 0.05:
            raise SystemExit('RECUSADO: %s — as tres do ML nao somam total - PPA' % k)
        out[k] = g
        eq = None
    return out


def igual(a, b, tol=0.011):
    if isinstance(a, dict):
        return isinstance(b, dict) and set(a) == set(b) and all(igual(a[x], b[x], tol) for x in a)
    try:
        return abs(float(a) - float(b)) <= tol
    except (TypeError, ValueError):
        return a == b


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    arq, alvos = sys.argv[1], [x for x in sys.argv[2:] if re.match(r'^\d{4}-\d{2}$', x)]
    grava = '--grava' in sys.argv
    txt = io.open(ALVO, encoding='utf-8', newline='').read()
    J = json.loads(txt)
    if json.dumps(J, ensure_ascii=False, indent=1) + '\n' != txt and json.dumps(J, ensure_ascii=False, indent=1) != txt:
        raise SystemExit('RECUSADO: gravar reformataria o arquivo — o dump nao reproduz o original')
    fecha_nl = txt.endswith('\n')

    P = le_planilha(arq)
    print('planilha: %d meses (%s a %s)' % (len(P), min(P), max(P)))

    # ── 🔴 os meses NAO anunciados tem de bater
    campos = ('garantido_total', 'garantido_ppa', 'ppa_por_ufv', 'ml_por_ufv', 'equivalente_total', 'equivalente_por_ufv')
    surpresa = []
    for k in sorted(P):
        if k in alvos:
            continue
        j = J['meses'].get(k)
        if j is None:
            surpresa.append('%s existe na planilha e nao no metas.json' % k)
            continue
        for c in campos:
            if not igual(P[k][c], j.get(c)):
                surpresa.append('%s.%s: planilha %s x metas.json %s' % (k, c, P[k][c], j.get(c)))
    if surpresa:
        print('\nRECUSADO — mudou na planilha o que nao foi anunciado:')
        for s in surpresa:
            print('   ' + s)
        sys.exit(1)
    print('meses nao anunciados: todos identicos ao metas.json')

    # ── os anunciados
    for k in alvos:
        if k not in P:
            raise SystemExit('RECUSADO: %s nao esta na planilha' % k)
        antes = J['meses'].get(k, {})
        novo = {c: P[k][c] for c in campos}
        novo['_origem'] = ('LIDO da planilha em 16/09/2026. A meta global deixou de ser a taxa unica de '
                           '1632,0 MWh/dia: %s MWh neste mes. O PPA continua na taxa. O ML e o resto '
                           '(total - PPA) e a planilha o reparte com M1 fixo e o restante em M7/M9; '
                           'o gerador aplica a politica da casa (taxa unica por MW no ML).' % novo['garantido_total'])
        muda = [c for c in campos if not igual(antes.get(c), novo[c])]
        print('   %s  %s' % (k, ', '.join('%s %s -> %s' % (c, antes.get(c), novo[c]) for c in muda
                                          if not isinstance(novo[c], dict)) or 'sem mudanca numerica'))
        J['meses'][k] = novo

    saida = json.dumps(J, ensure_ascii=False, indent=1) + ('\n' if fecha_nl else '')
    if '\r' in saida:
        raise SystemExit('RECUSADO: entrou CR')
    if not grava:
        print('\n(seco — nada gravado)')
        return
    io.open(ALVO, 'w', encoding='utf-8', newline='').write(saida)
    print('\nGRAVADO: %s' % ALVO)


if __name__ == '__main__':
    main()
