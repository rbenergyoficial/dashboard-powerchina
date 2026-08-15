const {readSheet,MAX0}=require('./lib');
const R=require('./resultado.json'), serie=require('./serie.json');
const r2=x=>Math.round(x*100)/100, r4=x=>Math.round(x*10000)/10000;
const S17=readSheet(18), S12=readSheet(12);
const mm=s=>new Date(Date.UTC(1899,11,30)+s*864e5).getUTCMonth()+1;
const Kf={},Lf={};for(let m=1;m<=8;m++){Kf[m]=R.G5*R.kMes[m];Lf[m]=R.G6*R.kMes[m];}
const L=[];for(let i=17;i<=2152;i++){const o=S17.get(i);if(!o||o.B==null)continue;
 const I=(o.G||0)*(o.H||0),K=MAX0(I-(o.J||0)),m=mm(o.B);
 L.push({m,mes:o.D,fase:o.E,F:o.F||0,H:o.H||0,J:o.J||0,N:m<=8?((K*(o.F||0))/Kf[m]+K/Lf[m])/2:0,O:o.O||0,P:o.P||0,Q:o.Q||0,Rr:o.R||0});}
const gerMes={};['C','D','E','F','G','H','I','J'].forEach((c,i)=>{let g=0;for(let rw=7;rw<=15;rw++){const o=S12.get(rw);if(o&&typeof o[c]==='number')g+=o[c];}gerMes[i+1]=g;});
const pre=L.filter(l=>l.fase==='Pré-COD');
const mensal=[];
for(let m=1;m<=8;m++){const ls=pre.filter(l=>l.m===m);const N=ls.reduce((a,l)=>a+l.N,0),h=ls.reduce((a,l)=>a+l.F,0);
 mensal.push({mes:`2025-${String(m).padStart(2,'0')}`,horas:r2(h),gerado_mwh:r2(gerMes[m]),cortado_mwh:r2(N),
  cortado_inf_mwh:r2(N*0.85),cortado_sup_mwh:r2(N*1.15),potencial_mwh:r2(gerMes[m]+N),perda_pct:r2(N/(gerMes[m]+N)*100),k:r4(R.kMes[m])});}
const razoes=['CNF','REL','ENE','ND'], cmap={CNF:'O',REL:'P',ENE:'Q',ND:'R'};
const preRaz={},preH={};
for(const z of razoes){const c=cmap[z]==='R'?'Rr':cmap[z];preRaz[z]=pre.reduce((a,l)=>a+l.N*l[c],0);preH[z]=pre.reduce((a,l)=>a+l.F*l[c],0);}
const totPre=Object.values(preRaz).reduce((a,b)=>a+b,0);
const sag=R.sagerPorRazao, totSag=R.J1447, janela=totPre+totSag;
const CLASS={CNF:'compensavel',REL:'compensavel',ENE:'nao_compensavel',ND:'a_classificar'};
const NOME={CNF:'Confiabilidade elétrica',REL:'Indisponibilidade externa',ENE:'Razão energética',ND:'Sem motivo registrado'};
const out={
 gerado_em:null, fonte:'Apuracao_Pre_Pos_COD_MRD_PT-EN_Rev06.xlsx (abas 14-20)',
 norma:'Portaria MME nº 140/2026, art. 3º',
 janela:{inicio:'2025-01-01',fim:'2025-11-25',
  total_mwh:r2(janela), pre_cod_estimado_mwh:r2(totPre), sager_medido_mwh:r2(totSag),
  compensavel_mwh:r2(preRaz.CNF+preRaz.REL+(sag.CNF||0)+(sag.REL||0)),
  compensavel_pct:r2((preRaz.CNF+preRaz.REL+(sag.CNF||0)+(sag.REL||0))/janela*100)},
 razoes:razoes.map(z=>({codigo:z,nome:NOME[z],portaria:CLASS[z],
   pre_cod_mwh:r2(preRaz[z]), pre_cod_horas:r2(preH[z]), sager_mwh:r2(sag[z]||0),
   total_mwh:r2(preRaz[z]+(sag[z]||0)), pct:r2((preRaz[z]+(sag[z]||0))/janela*100)})),
 pre_cod:{periodo:'2025-01-04 a 2025-08-31', natureza:'estimativa', banda_pct:15,
   horas_calendario:r2(Object.values(preH).reduce((a,b)=>a+b,0)),
   horas_sinapse:1201.58, sobreposicao_h:10.41, mensal},
 validacao:{periodo:'2025-09 a 2025-11', metodo:'âncora calibrada no total; erro mensal é a medida honesta',
   erro_total_pct:0, desvio_padrao_mensal_pct:4.0,
   ancora_inferior:r4(R.G5), ancora_superior:r4(R.G6),
   aviso:'O erro total de 0% é POR CONSTRUÇÃO: as âncoras são definidas como a razão que faz o total fechar. Citar o desvio mensal de 4%, nunca o zero.'},
 serie_continua:Object.keys(serie).sort().map(m=>{const x=serie[m];const pot=x.ger+x.nosso;
   return {mes:m,horas:r2(x.n/2),gerado_intervalos_mwh:r2(x.ger),nosso_mwh:r2(x.nosso),ons_mwh:r2(x.ons),
     dif_pct:x.ons>0?r2((x.nosso/x.ons-1)*100):null, perda_nos_intervalos_pct:r2(x.nosso/pot*100),
     ref_ons_valida:m>='2026-03'};})
};
require('fs').writeFileSync('pre_cod_razoes.json',JSON.stringify(out,null,2));
console.log(JSON.stringify(out.janela,null,2));
console.log(JSON.stringify(out.razoes,null,2));
console.log('\narquivo escrito: pre_cod_razoes.json ('+(require('fs').statSync('pre_cod_razoes.json').size/1024).toFixed(1)+' KB)');
