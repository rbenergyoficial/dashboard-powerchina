const {readSheet,MAX0}=require('./lib');
const S=readSheet(21);
const M={};
for(let i=21;i<=5028;i++){const o=S.get(i);if(!o||!o.D||o.G==null)continue;
  const m=o.D; M[m]=M[m]||{n:0,ger:0,nosso:0,ons:0,razao:{}};
  const x=M[m], H=(o.F||0)*o.G, I=(o.I||0), K=(o.K||0);
  x.n++; x.ger+=I/2; x.nosso+=MAX0(H-I)/2; x.ons+=MAX0(K-I)/2;
  const rz=o.M||'ND'; x.razao[rz]=(x.razao[rz]||0)+MAX0(H-I)/2;
}
const r=x=>Math.round(x*100)/100;
console.log('=== ABA 20 · SÉRIE CONTÍNUA set/25 → jul/26 ===');
console.log('mês      horas   gerado(MWh)  nosso(MWh)   ONS(MWh)    dif      potencial   perda%   ref.ONS');
let T={h:0,g:0,n:0,o:0};
for(const m of Object.keys(M).sort()){
  const x=M[m], h=x.n/2, pot=x.ger+x.nosso;
  const dif = x.ons>0 ? ((x.nosso/x.ons-1)*100).toFixed(1)+'%' : '—';
  const val = x.ons===0 ? 'ZERADA' : (x.nosso/x.ons-1>0.5||x.nosso/x.ons-1<-0.5 ? 'suspeita' : 'ok');
  T.h+=h;T.g+=x.ger;T.n+=x.nosso;T.o+=x.ons;
  console.log(m+'  '+r(h).toFixed(1).padStart(7)+r(x.ger).toFixed(0).padStart(12)+r(x.nosso).toFixed(0).padStart(12)+r(x.ons).toFixed(0).padStart(11)+dif.padStart(9)+r(pot).toFixed(0).padStart(12)+(x.nosso/pot*100).toFixed(1).padStart(8)+'%   '+val);
}
console.log('TOTAL  '+r(T.h).toFixed(1).padStart(7)+r(T.g).toFixed(0).padStart(12)+r(T.n).toFixed(0).padStart(12)+r(T.o).toFixed(0).padStart(11)+((T.n/T.o-1)*100).toFixed(1).padStart(8)+'%'+r(T.g+T.n).toFixed(0).padStart(12)+(T.n/(T.g+T.n)*100).toFixed(1).padStart(8)+'%');
console.log();
console.log('=== POR RAZÃO, série contínua (nosso método) ===');
const tot={};for(const m of Object.keys(M))for(const [k,v] of Object.entries(M[m].razao))tot[k]=(tot[k]||0)+v;
const gt=Object.values(tot).reduce((a,b)=>a+b,0);
for(const k of Object.keys(tot).sort((a,b)=>tot[b]-tot[a])) console.log('  '+k.padEnd(5)+r(tot[k]).toFixed(2).padStart(12)+' MWh  '+(tot[k]/gt*100).toFixed(2)+'%');
require('fs').writeFileSync('serie.json',JSON.stringify(M,null,1));
