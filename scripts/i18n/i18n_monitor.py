# -*- coding: utf-8 -*-
# Gera Monitor em EN e ZH (adfmd6en / adfmd6zh) a partir do PT (adfmd6), + botoes de idioma.
import json, urllib.request, urllib.error, copy
CFG = r'C:\Users\user\OneDrive - rbenergy.com.br\PWC\ID_Indicador de Desempenho\.mcp.json'
cfg = json.load(open(CFG, encoding='utf-8'))['mcpServers']['grafana']['env']
BASE=cfg['GRAFANA_URL'].rstrip('/'); TOK=cfg['GRAFANA_SERVICE_ACCOUNT_TOKEN']
Hh={'Authorization':'Bearer '+TOK,'Content-Type':'application/json','Accept':'application/json'}
def api(path, method='GET', body=None):
    data=json.dumps(body).encode() if body is not None else None
    req=urllib.request.Request(BASE+path,data=data,headers=Hh,method=method)
    try:
        with urllib.request.urlopen(req,timeout=40) as r: return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e: return e.code, e.read().decode()[:400]

# ---- dicionario de TITULOS (pt -> {en, zh}) ----
TITLE={
 "☀️ Irradiância":("☀️ Irradiance","☀️ 辐照度"),
 "🌡️ Temperatura":("🌡️ Temperature","🌡️ 温度"),
 "☁️ Nuvens":("☁️ Clouds","☁️ 云量"),
 "💧 Umidade":("💧 Humidity","💧 湿度"),
 "Condição do tempo":("Weather","天气状况"),
 "Geração · total (bruta)":("Generation · total (gross)","发电 · 总计（毛值）"),
 "Transformador 1 · bruta":("Transformer 1 · gross","变压器 1 · 毛值"),
 "Transformador 2 · bruta":("Transformer 2 · gross","变压器 2 · 毛值"),
 "🌡️ Carregamento TR1 (230 MVA)":("🌡️ Loading TR1 (230 MVA)","🌡️ 负载 TR1（230 MVA）"),
 "🌡️ Carregamento TR2 (230 MVA)":("🌡️ Loading TR2 (230 MVA)","🌡️ 负载 TR2（230 MVA）"),
 "⚡ Energia gerada hoje":("⚡ Energy generated today","⚡ 今日发电量"),
 "🎯 Fator de capacidade":("🎯 Capacity factor","🎯 容量因数"),
 "📈 Pico de potência hoje":("📈 Peak power today","📈 今日功率峰值"),
 "📊 Potência média hoje":("📊 Average power today","📊 今日平均功率"),
 "⚡ Perfil de geração hoje":("⚡ Generation profile today","⚡ 今日发电曲线"),
 "Tensão de linha (kV) · TR1":("Line voltage (kV) · TR1","线电压 (kV) · TR1"),
 "Tensão de linha (kV) · TR2":("Line voltage (kV) · TR2","线电压 (kV) · TR2"),
 "Corrente de linha (A) · TR1":("Line current (A) · TR1","线电流 (A) · TR1"),
 "Corrente de linha (A) · TR2":("Line current (A) · TR2","线电流 (A) · TR2"),
 "Potência P·Q · TR1":("Power P·Q · TR1","功率 P·Q · TR1"),
 "Potência P·Q · TR2":("Power P·Q · TR2","功率 P·Q · TR2"),
 "Fator de potência · TR1 (meta ≥ 0,92)":("Power factor · TR1 (target ≥ 0.92)","功率因数 · TR1（目标 ≥ 0.92）"),
 "Fator de potência · TR2 (meta ≥ 0,92)":("Power factor · TR2 (target ≥ 0.92)","功率因数 · TR2（目标 ≥ 0.92）"),
 "Potência Complexo · Σ coletores 34,5 kV":("Complex power · Σ 34.5 kV collectors","电站群功率 · Σ 34.5 kV 集电线路"),
 "Circuitos OK":("Circuits OK","线路正常"),
 "Potência ativa por circuito":("Active power per circuit","各线路有功功率"),
 "Potência reativa por circuito":("Reactive power per circuit","各线路无功功率"),
 "Tensão de linha · por circuito × fase":("Line voltage · per circuit × phase","线电压 · 各线路 × 相"),
 "Corrente · por circuito × fase":("Current · per circuit × phase","电流 · 各线路 × 相"),
 "🩺 Saúde dos medidores Way2 · atraso da telemetria (5 min)":("🩺 Meter health Way2 · telemetry lag (5 min)","🩺 测量表健康 Way2 · 遥测延迟（5 分钟）"),
 "🩺 Saúde dos medidores (Way2)":("🩺 Meter health (Way2)","🩺 测量表健康 (Way2)"),
}
# header: fragmentos de texto
HDR=[("INDICADOR DE DESEMPENHO",("PERFORMANCE INDICATOR","绩效指标")),
 ("POWERCHINA BRASIL",("POWERCHINA BRAZIL","中国电建巴西")),
 ("Complexo Fotovoltaico",("Photovoltaic Complex","光伏电站群")),
 ("restrições ONS",("ONS restrictions","ONS 限电")),
 ("gerados",("generated","已发电")),
 ("frustrados",("curtailed","受限")),
]
# nav labels (o rótulo visível). uid base -> label pt
NAV=[('adfmd6','Monitor'),('perfmt1','Performance'),('histmt1','Historico'),('ppaml1','PPA x ML'),('a75gd7','SCADA'),('rbb7ggq','ONS'),('a88bwp','Irradiancia'),('asldtr','MUST')]
NAVL={'Historico':('History','历史'),'Irradiancia':('Irradiance','辐照'),'Performance':('Performance','性能'),'Monitor':('Monitor','监控')}
LANGS=[('pt','🇧🇷',''),('en','🇬🇧','en'),('zh','🇨🇳','zh')]

def li(idx): return 0 if idx=='en' else 1  # tuple index

def build_nav(lang):
    # botoes de idioma + botoes de dashboard (linkando p/ mesma lingua)
    out='<div id="navmauriti" style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0;padding-right:4px">'
    # idioma
    for code,flag,suf in LANGS:
        on=(code==(lang or 'pt'))
        stl=('border:1px solid #34E0A1' if on else 'border:1px solid rgba(255,255,255,.14);opacity:.6')
        out+='<a href="/d/adfmd6%s" style="font-size:13px;text-decoration:none;padding:2px 6px;border-radius:99px;%s">%s</a>'%(suf,stl,flag)
    out+='<span style="width:1px;height:16px;background:rgba(255,255,255,.18);margin:0 4px"></span>'
    # dashboards
    for uid,label in NAV:
        lab=label
        if lang and label in NAVL: lab=NAVL[label][li(lang)]
        on=(uid=='adfmd6')
        stl=('color:#34E0A1;border:1px solid #34E0A1' if on else 'color:#8aa0b8;border:1px solid rgba(255,255,255,.14)')
        href='/d/%s%s'%(uid, lang if lang else '')
        out+='<a href="%s" style="font-size:10.5px;font-weight:700;text-decoration:none;padding:3px 10px;border-radius:99px;white-space:nowrap;%s">%s</a>'%(href,stl,lab)
    out+='</div>'
    return out

st,dash=api('/api/dashboards/uid/adfmd6'); base=dash['dashboard']
for lang,label,suf in [('en','EN',''),('zh','中文','')]:
    d=copy.deepcopy(base)
    idx=0 if lang=='en' else 1
    d['uid']='adfmd6'+lang
    d['title']=('Monitor · Mauriti (EN)' if lang=='en' else '监控 · Mauriti (中文)')
    d.pop('id',None); d.pop('version',None)
    for p in d['panels']:
        t=p.get('title')
        if t and t in TITLE: p['title']=TITLE[t][idx]
    # header: traduz fragmentos + troca nav
    hp=[p for p in d['panels'] if p.get('type')=='text' and 'navmauriti' in (p.get('options',{}).get('content','') or '')][0]
    c=hp['options']['content']
    for pt,(en,zh) in HDR: c=c.replace(pt, en if lang=='en' else zh)
    c=c[:c.find('<div id="navmauriti"')]+'</div></div>'
    assert c.endswith('</div></div>')
    hp['options']['content']=c[:-12]+build_nav(lang)+'</div></div>'
    st2,res=api('/api/dashboards/db','POST',{'dashboard':d,'overwrite':True,'message':'i18n Monitor '+lang})
    print('%s -> %s %s'%(lang, st2, 'uid=%s'%res.get('uid') if st2==200 else res))
# tambem adiciona os botoes de idioma no PT (adfmd6)
d=copy.deepcopy(base); hp=[p for p in d['panels'] if p.get('type')=='text' and 'navmauriti' in (p.get('options',{}).get('content','') or '')][0]
c=hp['options']['content']; c=c[:c.find('<div id="navmauriti"')]+'</div></div>'
hp['options']['content']=c[:-12]+build_nav('')+'</div></div>'
st2,res=api('/api/dashboards/db','POST',{'dashboard':d,'overwrite':True,'message':'i18n Monitor PT: add botoes idioma'})
print('pt -> %s v%s'%(st2, res.get('version') if st2==200 else res))
