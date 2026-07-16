# -*- coding: utf-8 -*-
# Regera Monitor EN/ZH cobrindo TAMBEM: variaveis, colunas Fase A/B/C, unidades % da X, value mappings (clima).
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

TITLE={
 "☀️ Irradiância":("☀️ Irradiance","☀️ 辐照度"),"🌡️ Temperatura":("🌡️ Temperature","🌡️ 温度"),
 "☁️ Nuvens":("☁️ Clouds","☁️ 云量"),"💧 Umidade":("💧 Humidity","💧 湿度"),"Condição do tempo":("Weather","天气状况"),
 "Geração · total (bruta)":("Generation · total (gross)","发电 · 总计（毛值）"),
 "Transformador 1 · bruta":("Transformer 1 · gross","变压器 1 · 毛值"),"Transformador 2 · bruta":("Transformer 2 · gross","变压器 2 · 毛值"),
 "🌡️ Carregamento TR1 (230 MVA)":("🌡️ Loading TR1 (230 MVA)","🌡️ 负载 TR1（230 MVA）"),
 "🌡️ Carregamento TR2 (230 MVA)":("🌡️ Loading TR2 (230 MVA)","🌡️ 负载 TR2（230 MVA）"),
 "⚡ Energia gerada hoje":("⚡ Energy generated today","⚡ 今日发电量"),"🎯 Fator de capacidade":("🎯 Capacity factor","🎯 容量因数"),
 "📈 Pico de potência hoje":("📈 Peak power today","📈 今日功率峰值"),"📊 Potência média hoje":("📊 Average power today","📊 今日平均功率"),
 "⚡ Perfil de geração hoje":("⚡ Generation profile today","⚡ 今日发电曲线"),
 "Tensão de linha (kV) · TR1":("Line voltage (kV) · TR1","线电压 (kV) · TR1"),"Tensão de linha (kV) · TR2":("Line voltage (kV) · TR2","线电压 (kV) · TR2"),
 "Corrente de linha (A) · TR1":("Line current (A) · TR1","线电流 (A) · TR1"),"Corrente de linha (A) · TR2":("Line current (A) · TR2","线电流 (A) · TR2"),
 "Potência P·Q · TR1":("Power P·Q · TR1","功率 P·Q · TR1"),"Potência P·Q · TR2":("Power P·Q · TR2","功率 P·Q · TR2"),
 "Fator de potência · TR1 (meta ≥ 0,92)":("Power factor · TR1 (target ≥ 0.92)","功率因数 · TR1（目标 ≥ 0.92）"),
 "Fator de potência · TR2 (meta ≥ 0,92)":("Power factor · TR2 (target ≥ 0.92)","功率因数 · TR2（目标 ≥ 0.92）"),
 "Potência Complexo · Σ coletores 34,5 kV":("Complex power · Σ 34.5 kV collectors","电站群功率 · Σ 34.5 kV 集电线路"),
 "Circuitos OK":("Circuits OK","线路正常"),
 "Potência ativa por circuito":("Active power per circuit","各线路有功功率"),"Potência reativa por circuito":("Reactive power per circuit","各线路无功功率"),
 "Tensão de linha · por circuito × fase":("Line voltage · per circuit × phase","线电压 · 各线路 × 相"),"Corrente · por circuito × fase":("Current · per circuit × phase","电流 · 各线路 × 相"),
 "🩺 Saúde dos medidores Way2 · atraso da telemetria (5 min)":("🩺 Meter health Way2 · telemetry lag (5 min)","🩺 测量表健康 Way2 · 遥测延迟（5 分钟）"),
 "🩺 Saúde dos medidores (Way2)":("🩺 Meter health (Way2)","🩺 测量表健康 (Way2)"),
}
HDR=[("INDICADOR DE DESEMPENHO",("PERFORMANCE INDICATOR","绩效指标")),("POWERCHINA BRASIL",("POWERCHINA BRAZIL","中国电建巴西")),
 ("Complexo Fotovoltaico",("Photovoltaic Complex","光伏电站群")),("restrições ONS",("ONS restrictions","ONS 限电")),
 ("gerados",("generated","已发电")),("frustrados",("curtailed","受限")),]
# extras
VARLABEL={'UFV':('Plant','电站'),'Circuitos':('Circuits','线路'),'Fases':('Phases','相'),'Estilo':('Style','样式')}
ESTILO={'Linha':('Line','线'),'Barra':('Bar','柱')}
COL={'Fase A':('Phase A','A 相'),'Fase B':('Phase B','B 相'),'Fase C':('Phase C','C 相')}
UNIT={'suffix: % da geração':('suffix: % of gen.','suffix: % 发电占比'),'suffix: % da instalada':('suffix: % of cap.','suffix: % 装机占比'),
 'suffix: % da Outorga':('suffix: % of grant','suffix: % 核准占比')}
WMAP={'☀ Céu limpo':('☀ Clear sky','☀ 晴'),'🌤 Predom. limpo':('🌤 Mostly clear','🌤 大部晴'),'⛅ Parc. nublado':('⛅ Partly cloudy','⛅ 局部多云'),
 '☁ Nublado':('☁ Cloudy','☁ 多云'),'🌫 Neblina':('🌫 Fog','🌫 雾'),'🌦 Garoa':('🌦 Drizzle','🌦 毛毛雨'),'🌧 Chuva fraca':('🌧 Light rain','🌧 小雨'),
 '🌧 Chuva':('🌧 Rain','🌧 雨'),'🌧 Chuva forte':('🌧 Heavy rain','🌧 大雨'),'🌧 Pancadas':('🌧 Showers','🌧 阵雨'),'⛈ Pancadas fortes':('⛈ Heavy showers','⛈ 强阵雨'),'⛈ Trovoada':('⛈ Thunderstorm','⛈ 雷暴')}
NAV=[('adfmd6','Monitor'),('perfmt1','Performance'),('histmt1','Historico'),('ppaml1','PPA x ML'),('a75gd7','SCADA'),('rbb7ggq','ONS'),('a88bwp','Irradiancia'),('asldtr','MUST')]
NAVL={'Historico':('History','历史'),'Irradiancia':('Irradiance','辐照'),'Performance':('Performance','性能'),'Monitor':('Monitor','监控')}
LANGS=[('','🇧🇷'),('en','🇬🇧'),('zh','🇨🇳')]

def build_nav(lang):
    idx=0 if lang=='en' else 1
    out='<div id="navmauriti" style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0;padding-right:4px">'
    for code,flag in LANGS:
        on=(code==lang)
        stl=('border:1px solid #34E0A1' if on else 'border:1px solid rgba(255,255,255,.14);opacity:.55')
        out+='<a href="/d/adfmd6%s" style="font-size:13px;text-decoration:none;padding:2px 6px;border-radius:99px;%s">%s</a>'%(code,stl,flag)
    out+='<span style="width:1px;height:16px;background:rgba(255,255,255,.18);margin:0 4px"></span>'
    for uid,label in NAV:
        lab=NAVL[label][idx] if (lang and label in NAVL) else label
        on=(uid=='adfmd6'); stl=('color:#34E0A1;border:1px solid #34E0A1' if on else 'color:#8aa0b8;border:1px solid rgba(255,255,255,.14)')
        out+='<a href="/d/%s%s" style="font-size:10.5px;font-weight:700;text-decoration:none;padding:3px 10px;border-radius:99px;white-space:nowrap;%s">%s</a>'%(uid,lang,stl,lab)
    out+='</div>'
    return out

def tr_panels(d, idx):
    for p in d['panels']:
        t=p.get('title')
        if t and t in TITLE: p['title']=TITLE[t][idx]
        # unidade
        try:
            u=p['fieldConfig']['defaults'].get('unit')
            if u in UNIT: p['fieldConfig']['defaults']['unit']=UNIT[u][idx]
        except Exception: pass
        # value mappings (clima)
        try:
            for mp in p['fieldConfig']['defaults'].get('mappings',[]):
                opts=mp.get('options',{})
                for k,vv in opts.items():
                    if isinstance(vv,dict) and vv.get('text') in WMAP: vv['text']=WMAP[vv['text']][idx]
        except Exception: pass
        # colunas Fase A/B/C
        for tg in p.get('targets',[]) or []:
            for cc in tg.get('columns',[]) or []:
                if cc.get('text') in COL: cc['text']=COL[cc['text']][idx]
        # overrides byName Fase A/B/C
        for ov in (p.get('fieldConfig',{}).get('overrides',[]) or []):
            m=ov.get('matcher',{})
            if m.get('id')=='byName' and m.get('options') in COL: m['options']=COL[m['options']][idx]

def tr_vars(d, idx):
    for v in d.get('templating',{}).get('list',[]):
        lb=v.get('label') or v.get('name')
        if lb in VARLABEL: v['label']=VARLABEL[lb][idx]
        # estilo: Linha/Barra
        if v.get('name')=='estilo':
            q=v.get('query','')
            for pt,tr in ESTILO.items(): q=q.replace(pt, tr[idx])
            v['query']=q
            cur=v.get('current',{})
            if isinstance(cur.get('text'),str) and cur['text'] in ESTILO: cur['text']=ESTILO[cur['text']][idx]

st,dash=api('/api/dashboards/uid/adfmd6'); base=dash['dashboard']
for lang in ['en','zh']:
    d=copy.deepcopy(base); idx=0 if lang=='en' else 1
    d['uid']='adfmd6'+lang; d['title']=('Monitor · Mauriti (EN)' if lang=='en' else '监控 · Mauriti (中文)')
    d.pop('id',None); d.pop('version',None)
    tr_panels(d, idx); tr_vars(d, idx)
    hp=[p for p in d['panels'] if p.get('type')=='text' and 'navmauriti' in (p.get('options',{}).get('content','') or '')][0]
    c=hp['options']['content']
    for pt,(en,zh) in HDR: c=c.replace(pt, en if lang=='en' else zh)
    c=c[:c.find('<div id="navmauriti"')]+'</div></div>'
    hp['options']['content']=c[:-12]+build_nav(lang)+'</div></div>'
    st2,res=api('/api/dashboards/db','POST',{'dashboard':d,'overwrite':True,'message':'i18n Monitor '+lang+' (completo: vars, colunas, unidades, clima)'})
    print('%s -> %s %s'%(lang, st2, 'uid=%s'%res.get('uid') if st2==200 else res))
