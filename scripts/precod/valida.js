const {readSheet,MAX0}=require('./lib');
const r=x=>Math.round(x*100)/100;
const S18=readSheet(19), S17=readSheet(18);
// referência SAGER por mês (col J = MAX(0,F*G-I)/2)
const refMes={}; let J1447=0;
for(let i=5;i<=1446;i++){const o=S18.get(i);if(!o||o.G==null)continue;
  const J=MAX0((o.F||0)*o.G-(o.I||0))/2; J1447+=J; refMes[o.D]=(refMes[o.D]||0)+J;}
// base horária
const linhas=[];
for(let i=17;i<=2152;i++){const o=S17.get(i);if(!o||o.B==null)continue;
  const I=(o.G||0)*(o.H||0),K=MAX0(I-(o.J||0));
  linhas.push({mes:o.D,fase:o.E,F:o.F||0,H:o.H||0,J:o.J||0,L:K*(o.F||0),M:K});}
// fases presentes
const fases={}; for(const l of linhas){const k=l.fase+' | '+l.mes.slice(0,7); fases[k]=(fases[k]||0)+1;}
console.log('=== FASE × MÊS (linhas) ===');
for(const k of Object.keys(fases).sort()) console.log('  '+k+': '+fases[k]);
let sumL=0,sumM=0; for(const l of linhas) if(l.fase==='Validação'){sumL+=l.L;sumM+=l.M;}
const G5=sumL/J1447,G6=sumM/J1447;
console.log('\n=== VALIDAÇÃO MÊS A MÊS (aba 15, quadro 3) ===');
console.log('mês        referência    estimativa      erro       horas');
let tC=0,tD=0,tF=0; const erros=[];
for(const m of ['2025-09','2025-10','2025-11']){
  const ls=linhas.filter(l=>l.fase==='Validação'&&l.mes===m);
  const C=refMes[m]||0, D=(ls.reduce((a,l)=>a+l.L,0)/G5+ls.reduce((a,l)=>a+l.M,0)/G6)/2, F=ls.reduce((a,l)=>a+l.F,0);
  const e=D/C-1; erros.push(e); tC+=C;tD+=D;tF+=F;
  console.log(m+'  '+r(C).toFixed(2).padStart(11)+r(D).toFixed(2).padStart(14)+(e*100).toFixed(2).padStart(9)+'%'+r(F).toFixed(2).padStart(11));
}
console.log('TOTAL    '+r(tC).toFixed(2).padStart(11)+r(tD).toFixed(2).padStart(14)+((tD/tC-1)*100).toFixed(4).padStart(9)+'%'+r(tF).toFixed(2).padStart(11));
const mean=erros.reduce((a,b)=>a+b,0)/erros.length;
const sd=Math.sqrt(erros.reduce((a,b)=>a+(b-mean)**2,0)/(erros.length-1));
console.log('desvio-padrão do erro mensal = '+(sd*100).toFixed(2)+'%   |   faixa adotada na aba 14 = ±15%');
