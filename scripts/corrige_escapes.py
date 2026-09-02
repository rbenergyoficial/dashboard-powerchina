# -*- coding: utf-8 -*-
u"""Reata as quebras de linha que o heredoc comeu dentro de literais JS.

O heredoc do bash consome a barra invertida: `\\n` escrito no gerador chega ao arquivo como
uma QUEBRA DE LINHA de verdade, no meio de um literal de texto. O sintoma e sempre o mesmo —
`SyntaxError: Invalid or unexpected token` apontando para uma linha que parece correta.

Este arquivo existe escrito em DISCO, e nao num heredoc, exatamente por isso.
"""
from __future__ import print_function
import io
import re
import sys

ALVO = u"scripts/gen-scada-intake-watchdog.js"

s = io.open(ALVO, encoding=u"utf-8").read()
antes = s

# uma linha que termina em aspa-simples-abre e a seguinte que comeca com aspa-simples-fecha:
# e um `\n` que virou quebra de verdade.
s, n = re.subn(r"'\n'", r"\\n'", s)

io.open(ALVO, u"w", encoding=u"utf-8").write(s)
print(u"quebras reatadas: %d" % n)
if s == antes:
    print(u"nada a fazer")
    sys.exit(1)
