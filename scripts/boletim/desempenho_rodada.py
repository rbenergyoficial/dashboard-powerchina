# -*- coding: utf-8 -*-
"""SIGO · Desempenho na rodada do Boletim (lote desempenho-envio, 20/11/2026): o que gerar e o item da fila.

Entra na rodada.py do Boletim com um gancho só (ver LEIA do lote, "Passos do PROMOVER"). Os itens vão para a MESMA fila
`boletim/fila.json`, que a boletim_envio.js posta no grupo "Reports O&M - SIGO"; ao grupo vai só o inglês, o português é guardado.

Calendário (decisão do humano, 20/11/2026):
  · diário do dia anterior a partir das 08:00 (HORA_DIARIO), uma vez; as rodadas de 08:31, 09:01 e 09:31 recuperam a que falhou;
    dia mais antigo que ontem NÃO sai (o registro vale pelo dia; o atrasado não vai ao grupo);
  · mensal do mês fechado nos dias 1 a 3, uma vez, a partir das 08:00 do dia 1º.
Nada sai antes de `desempenho_desde` no estado do Boletim (a semeadura deste lote, gravada no PROMOVER): sem ela, nada sai.
"""
import datetime as dt
import os

import desempenho_envio as DE

HORA_DIARIO = '08:00'
TETO_MENSAL_DIA = 3


def tarefas(agora_brt, estado):
    feitos = set((estado or {}).get('feitos') or [])
    desde = (estado or {}).get('desempenho_desde')
    if not desde:
        return []
    hoje, hm = agora_brt.date(), agora_brt.strftime('%H:%M')
    out = []
    ontem = (hoje - dt.timedelta(days=1)).isoformat()
    if hm >= HORA_DIARIO and ontem >= desde and 'desempenho-diario:' + ontem not in feitos:
        out.append(('desempenho-diario', ontem))
    if hoje.day <= TETO_MENSAL_DIA and (hoje.day > 1 or hm >= HORA_DIARIO):
        m = (hoje.replace(day=1) - dt.timedelta(days=1)).isoformat()[:7]
        if m >= desde[:7] and 'desempenho-mensal:' + m not in feitos:
            out.append(('desempenho-mensal', m))
    return out


def gera_item(entradas, sai, modo, ref, agora_brt, boletim_dir):
    """gera em <sai>/desempenho/<diario|mensal>/<ref>/ e devolve o item da fila (caminhos de blob em boletim/)."""
    tipo = modo.split('-', 1)[1]
    pasta = os.path.join(sai, 'desempenho', tipo, ref)
    R, tx, arqs = DE.gera(entradas, tipo, ref, agora_brt.strftime('%Y-%m-%dT%H:%M'), pasta, boletim_dir)
    blob = lambda p: 'boletim/' + os.path.relpath(p, sai).replace('\\', '/')
    return {'id': f'{modo}-{ref}', 'tipo': modo, 'dia': ref, 'criado': agora_brt.strftime('%Y-%m-%dT%H:%M'),
            'texto': tx['en'], 'imagens': [], 'arquivos': [blob(p) for p in arqs.get('en', [])],
            'guardado': {'pt': {'texto': blob(os.path.join(pasta, 'texto_pt.txt')), 'arquivos': [blob(p) for p in arqs.get('pt', [])]},
                         'en': {'texto': blob(os.path.join(pasta, 'texto_en.txt'))}}}
