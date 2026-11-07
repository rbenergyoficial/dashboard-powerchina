# -*- coding: utf-8 -*-
"""Versão em inglês do Boletim de Desempenho: troca o texto visível (nunca atributos nem o estilo), datas no formato 6 Nov 2026 e
números no formato inglês (3,068.07). Recusa se sobrar texto em português.
    python traduz_en.py <arquivo.html> [...]   ->  <arquivo>_en.html"""
import html as H, os, re, sys

MES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
MES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']
MES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
SEM = {'segunda': 'Monday', 'terça': 'Tuesday', 'quarta': 'Wednesday', 'quinta': 'Thursday', 'sexta': 'Friday', 'sábado': 'Saturday', 'domingo': 'Sunday'}

# frases inteiras primeiro (as mais longas ganham); glossário da casa: corte = curtailment, impedido = curtailed, meta = target,
# Valor Garantido = Guaranteed Value, usina = plant, Conjunto Fotovoltaico Mauriti = Mauriti Photovoltaic Complex
F = {
 'Fonte: Geração: medição de faturamento (energia líquida). Restrição, potencial e comparação regional: dados do ONS (Abaiara = conjunto Abaiara 230 kV; Nordeste = usinas solares do subsistema). PR = energia injetada ÷ (potência de placa × irradiação no plano); "sem o corte" soma a energia impedida. Disponibilidade: inversores disponíveis nas meias horas de sol, ponderada pela potência. Energia limitada estimada (quando o ONS não apura): irradiação × potência de placa × PR do próprio dia fora da limitação. Meta: Valor Garantido do mês. Projeção = ritmo dos dias fechados × dias do mês; faixa = erro médio da projeção no mesmo dia do mês em':
 'Source: Generation: billing metering (net energy). Curtailment, potential and regional comparison: ONS data (Abaiara = Abaiara 230 kV complex; Northeast = solar plants of the subsystem). PR = injected energy ÷ (nameplate power × plane-of-array irradiation); "without curtailment" adds the curtailed energy. Availability: inverters available in the sunny half hours, weighted by power. Estimated limited energy (when the ONS does not assess it): irradiation × nameplate power × PR of the same day outside the limitation. Target: Guaranteed Value of the month. Projection = pace of the closed days × days of the month; band = average projection error on the same day of the month over',
 'Energética: excesso de geração no sistema · Confiabilidade elétrica: limite operativo da rede · Restrição elétrica: equipamento externo indisponível · Sistêmica × Local: se a causa está no sistema ou na região do conjunto':
 'Energy: excess generation in the system · Electrical reliability: grid operating limit · Electrical restriction: external equipment unavailable · Systemic × Local: whether the cause is in the system or in the region of the complex',
 'geração do dia e do mês · PR do mês sem o corte · disponibilidade do mês': 'day and month generation · month PR without curtailment · month availability',
 'MW a cada 30 min · faixa lilás = limite do ONS no conjunto': 'MW every 30 min · lilac band = ONS limit on the complex',
 'razão e origem declaradas pelo ONS em cada intervalo': 'reason and origin declared by the ONS in each interval',
 'no ritmo fraco, não bate': 'at the weak pace, it misses',
 'Limitação do ONS no dia': 'ONS limitation on the day',
 'Fonte: geração pela medição de faturamento (5 min); limite pelas ordens do ONS registradas pela mesa de operação. A apuração oficial da energia impedida pelo ONS chega no dia seguinte e entra no boletim diário.':
 'Source: generation from billing metering (5 min); limit from the ONS orders recorded by the operation desk. The official ONS assessment of curtailed energy arrives the next day and goes into the daily bulletin.',
 'o número sobre o degrau é a potência pedida em cada ordem (MW) · ordens do ONS registradas pela mesa de operação': 'the number on each step is the power requested in each order (MW) · ONS orders recorded by the operation desk',
 'Geração × limite do dia': 'Generation × limit of the day', 'Geração × limite · Complexo · MW': 'Generation × limit · Complex · MW',
 'medição até': 'metering to', 'dia em andamento': 'day in progress', 'Geração até': 'Generation to', 'Ordens do ONS': 'ONS orders',
 'Tempo sob limite': 'Time under limit', 'Energético (Controle de Frequência)': 'Energy (frequency control)', 'geração (medição de 5 min)': 'generation (5-min metering)',
 'limite das ordens do ONS': 'ONS order limit', 'período sob ordem': 'period under order', 'Geração por usina · MW': 'Generation by plant · MW',
 'medição de 5 min dos circuitos de cada usina': '5-min metering of each plant feeder', 'sem limite no dia': 'no limit on the day', 'entre': 'between', 'sem limite do ONS no dia': 'no ONS limit on the day',
 'Sem limitação do ONS no dia; no Nordeste o corte solar foi de': 'No ONS limitation on the day; Northeast solar curtailment was',
 'Intrepid Participações S.A.': 'Intrepid Participações S.A.',
 'Conjunto Fotovoltaico Mauriti': 'Mauriti Photovoltaic Complex',
 'Relatório diário de desempenho': 'Daily performance report', 'Relatório mensal de desempenho': 'Monthly performance report',
 'Corte do ONS · comparação regional': 'ONS curtailment · regional comparison', 'Corte do ONS · motivo e origem': 'ONS curtailment · reason and origin',
 'Meta do mês · realizado e projeção': 'Month target · actual and projection', 'Curva do dia por usina': 'Day curve by plant',
 'energia impedida ÷ (gerada + impedida)': 'curtailed energy ÷ (generated + curtailed)', 'geração · PR sem o corte · disponibilidade': 'generation · PR without curtailment · availability',
 'impedido pelo ONS, rateio por usina': 'curtailed by the ONS, allocated by plant', 'geração por dia (cor da usina)': 'generation per day (plant colour)',
 'impedido pelo ONS': 'curtailed by the ONS', 'intervalo limitado': 'limited interval', 'referência do ONS': 'ONS reference', 'limite do ONS': 'ONS limit',
 'marca na borda = meta (100%)': 'mark on the edge = target (100%)', 'tracejado = meta linear do mês': 'dashed = linear month target',
 'faixa de acerto histórica': 'historical accuracy band', 'projeção do mês': 'month projection', 'marca de 100%': '100% mark', 'anéis de 0 a 150%': 'rings from 0 to 150%',
 'inversores nas horas de sol': 'inverters in sunny hours', 'Limitado pelo ONS no dia': 'ONS limitation on the day', 'Impedido pelo ONS': 'Curtailed by the ONS',
 'Impedido no mês': 'Curtailed this month', 'Acumulado do mês': 'Month to date', 'Geração do dia': 'Day generation', 'Geração do mês': 'Month generation',
 'Irradiação do dia': 'Day irradiation', 'Irradiação do mês': 'Month irradiation', 'Disponibilidade do dia': 'Day availability', 'Disponibilidade': 'Availability',
 'PR do dia': 'Day PR', 'PR do mês': 'Month PR', 'PR mês': 'Month PR', 'Corte do mês': 'Month curtailment', 'PPA no mês': 'PPA this month',
 'P50 · P90 do projeto': 'Project P50 · P90', 'Usinas · dia e mês': 'Plants · day and month', 'Usinas no mês': 'Plants this month', 'Fatos relevantes': 'Key facts',
 'Melhor dia do mês': 'Best day of the month', 'Melhor dia:': 'Best day:', 'recorde histórico': 'all-time record', 'meta batida em': 'target reached on',
 'previsão de bater:': 'forecast to reach:', 'no ritmo atual não bate no mês': 'at the current pace it misses this month', 'faltaram': 'short by',
 'dia fechado · evolução de': 'closed day · progress of', 'mês fechado': 'closed month', 'gerado no SIGO em': 'generated in SIGO on',
 'energia líquida · Valor Garantido': 'net energy · Guaranteed Value', 'da meta do mês': 'of month target', 'acima da meta do dia': 'above the day target',
 'acima da meta diária': 'above the daily target', 'acima da meta': 'above target', 'abaixo da meta': 'below target', 'da meta': 'of target',
 'Complexo fechou com': 'The complex closed with', 'PPA fechou com': 'PPA closed with', 'ONS limitou a usina por': 'The ONS limited the complex for',
 'ONS impediu': 'The ONS curtailed', 'estimativa de': 'estimated at', 'não gerados.': 'not generated.', 'com o limite do ONS': 'with ONS limit',
 'h com limite do ONS, de': 'h with ONS limit, from', 'limite mínimo': 'minimum limit', 'pico de': 'peak of', 'medição de 30 min': '30-min metering',
 'h de limitação': 'h of limitation', 'h de restrição': 'h of curtailment', 'limite entre': 'limit between', 'maior corte em': 'largest curtailment on',
 'Sem limitação': 'No limitation', 'do ONS no dia; no Nordeste o corte solar foi de': 'by the ONS today; Northeast solar curtailment was',
 'sem energia impedida': 'no curtailed energy', 'sem o corte': 'without curtailment', 'com o impedido': 'with curtailed', 'no mês': 'this month',
 'Mês anterior': 'Previous month', 'Mês até': 'Month to', 'Dia a dia de': 'Day by day,', 'por usina': 'by plant', 'Curva do dia': 'Day curve', 'Meta de': 'Target,',
 'resultado': 'result', 'Geração de': 'Generation of', 'limite': 'limit', 'meses': 'months', 'disponibilidade de': 'availability of', 'MWh estimados': 'MWh estimated', 'MWh no mês': 'MWh in the month', 'sobra': 'surplus', 'falta': 'to go', 'até': 'to',
 'realizado': 'actual', 'projeção de': 'projection of', 'projeção': 'projection', 'faixa': 'band', 'também:': 'also:', 'média': 'average', 'por dia': 'per day',
 'dias acima': 'days above', 'Energética': 'Energy', 'Confiabilidade elétrica': 'Electrical reliability', 'Restrição elétrica': 'Electrical restriction',
 'Sistêmica': 'Systemic', 'Motivo': 'Reason', 'Origem': 'Origin', 'Nordeste (solar)': 'Northeast (solar)', 'Nordeste': 'Northeast', 'COMPLEXO': 'COMPLEX',
 'geração MWh': 'generation MWh', 'geração MW': 'generation MW', 'geração': 'generation', 'irradiação': 'irradiation', 'meta do dia': 'day target',
 'disp. mês': 'month avail.', 'disp.': 'avail.', 'dia': 'day', 'mês': 'month', 'meta': 'target', 'pico': 'peak', 'impedido': 'curtailed', 'Complexo': 'Complex',
 'Dia': 'Day', 'dias': 'days', 'acima de': 'above', 'acima': 'above', 'abaixo': 'below', 'em': 'in', 'de': 'of', 'com': 'with', 'e': 'and', 'a': 'to',
 'da': 'of', 'do': 'of', 'no': 'in', 'na': 'in', 'h,': 'h,', 'agora.': 'now.', 'até agora.': 'so far.', 'diária': 'daily', 'Local': 'Local',
}
PALAVRA = re.compile(r"[A-Za-zÀ-ÿ]+(?:[.:]?)")

def data_en(t):
    t = re.sub(r'\b(segunda|terça|quarta|quinta|sexta|sábado|domingo), ', lambda m: SEM[m.group(1)] + ', ', t)
    t = re.sub(r'\b(\d{2})/(\d{2})/(\d{4})\b', lambda m: f'{int(m.group(1))} {MES[int(m.group(2))-1]} {m.group(3)}', t)
    t = re.sub(r'\b(\d{2})/(20\d{2})\b', lambda m: f'{MES[int(m.group(1))-1]} {m.group(2)}', t)
    t = re.sub(r'\b(\d{2})/(\d{2})\b', lambda m: f'{int(m.group(1))} {MES[int(m.group(2))-1]}', t)
    for i, m in enumerate(MES_PT):
        t = re.sub(rf'\b{m}/(\d{{4}})', MES_EN[i] + r' \1', t)
        t = re.sub(rf'\b{m} de (\d{{4}})', MES_EN[i] + r' \1', t)
        t = re.sub(rf'\b{m.capitalize()}\b', MES_EN[i], t); t = re.sub(rf'\b{m}\b', MES_EN[i], t)
    return t

def num_en(t):
    def f(m):
        s = m.group(0); inteiro, _, dec = s.partition(',')
        inteiro = inteiro.replace('.', '')
        return f'{int(inteiro):,}' + ('.' + dec if dec else '')
    return re.sub(r'(?<![\d.,])\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\d])|(?<![\d.,])\d+,\d+(?![\d])', f, t)

ORDEM = sorted(F, key=len, reverse=True)
def frase_en(t):
    t = re.sub(r'Dia a dia de (\w+) · Complexo', '\x00' + r'\1 day by day · Complex' + '\x01', t)
    t = re.sub(r'Dia a dia de (\w+) por usina', '\x00' + r'\1 day by day, by plant' + '\x01', t)
    t = re.sub(r'Meta de (\w+) · resultado', '\x00' + r'\1 target · result' + '\x01', t)
    for pt in ORDEM:
        if len(pt) <= 3: continue
        # só fora dos trechos já traduzidos (senão "Local" casava dentro do inglês)
        seg = re.split('(\x00[^\x01]*\x01)', t)
        t = ''.join(x if x.startswith('\x00') else x.replace(pt, '\x00' + F[pt] + '\x01') for x in seg)
    # o que sobrou, palavra a palavra (só as do dicionário curto, fora dos trechos já trocados)
    partes = re.split(r'(\x00[^\x01]*\x01)', t)
    out = []
    for p in partes:
        if p.startswith('\x00'): out.append(p[1:-1]); continue
        out.append(re.sub(r"\b[A-Za-zÀ-ÿ]+\b", lambda m: F.get(m.group(0), m.group(0)), p))
    return ''.join(out)

def traduz(src):
    corpo = re.split(r'(<style>.*?</style>|<[^>]+>)', src, flags=re.S)
    for i, p in enumerate(corpo):
        if not p or p.startswith('<'): continue
        txt = H.unescape(p)
        if not re.search(r'[A-Za-zÀ-ÿ0-9]', txt): continue
        corpo[i] = H.escape(num_en(frase_en(data_en(txt))), quote=False)
    s = ''.join(corpo).replace('lang="pt-BR"', 'lang="en"')
    return s

RESTO = re.compile(r'[ãõçáéíóúâêô]|\b(?:de|do|da|dos|das|em|com|não|mês|dia|meta|usina|corte|geração)\b', re.I)
if __name__ == '__main__':
    ruim = 0
    for f in sys.argv[1:]:
        en = traduz(open(f, encoding='utf-8').read())
        vis = ' '.join(H.unescape(x) for x in re.findall(r'>([^<>]+)<', re.sub(r'<style>.*?</style>', '', en, flags=re.S)))
        sobra = sorted(set(m.group(0) for m in RESTO.finditer(vis.replace('Participações', '').replace('Intrepid', ''))))
        open(f.replace('.html', '_en.html'), 'w', encoding='utf-8').write(en)
        print(f, '-> _en.html', 'SOBROU PORTUGUÊS: ' + ', '.join(sobra) if sobra else 'ok')
        ruim += bool(sobra)
    sys.exit(1 if ruim else 0)
