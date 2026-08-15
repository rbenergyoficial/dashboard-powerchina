const {readSheet,MAX0}=require('./lib');
const r=x=>Math.round(x*100)/100;

// ---------- ABA 18 (sheet19): SAGER 30 min, 04/09 a 25/11/2025 ----------
const S18=readSheet(19);
let J1447=0,Q1447=0; const sagerPorRazao={}, sagerPre={}, sagerPos={};
for(let i=5;i<=1446;i++){
  const o=S18.get(i); if(!o||o.G==null||o.I==null) continue;
  const H=o.F*o.G, J=MAX0(H-o.I)/2;            // energia frustrada 30 min
  const P=o.O*o.G, Q=MAX0(P-o.I)/2;            // versão simplificada (viés)
  J1447+=J; Q1447+=Q;
  const raz=o.K||'ND';
  sagerPorRazao[raz]=(sagerPorRazao[raz]||0)+J;
  sagerPre[raz]=(sagerPre[raz]||0)+J*(o.L||0);
  sagerPos[raz]=(sagerPos[raz]||0)+J*(1-(o.L||0));
}
const R1447=Q1447/J1447;

// ---------- ABA 19 (sheet20): k sazonal por mês calendário ----------
const S19=readSheet(20);
const kMes={};
for(const [mes,idx] of [['2026-01',1],['2026-02',2],['2026-03',3],['2026-04',4],['2026-05',5],['2026-06',6],['2026-07',7]]){
  let D=0,E=0;
  for(let i=6;i<=2990;i++){ const o=S19.get(i); if(!o||o.D!==mes) continue;
    D+=MAX0((o.F||0)*(o.G||0)-(o.I||0))/2;      // J = MAX(0,F*G-I)/2  (referência)
    E+=MAX0((o.K||0)*(o.G||0)-(o.I||0))/2; }    // M = MAX(0,K*G-I)/2  (simplificado)
  kMes[idx]=(E/D)/R1447;
}

// ---------- ABA 17 (sheet18): base horária ----------
const S17=readSheet(18);
const linhas=[];
for(let i=17;i<=2152;i++){
  const o=S17.get(i); if(!o||o.B==null) continue;
  const I=(o.G||0)*(o.H||0), K=MAX0(I-(o.J||0));
  const X=(o.W!=null)?MAX0(o.W*(o.H||0)-(o.J||0))*(o.F||0):null;
  linhas.push({row:i,serial:o.B,mes:o.D,fase:o.E,F:o.F||0,H:o.H||0,I,J:o.J||0,K,
               L:K*(o.F||0), M:K, W:o.W, X, O:o.O||0,P:o.P||0,Q:o.Q||0,R:o.R||0});
}
const mesDoSerial=s=>{const d=new Date(Date.UTC(1899,11,30)+s*864e5);return d.getUTCMonth()+1;};
let sumLval=0,sumMval=0;
for(const l of linhas) if(l.fase==='Validação'){ sumLval+=l.L; sumMval+=l.M; }
const G5=sumLval/J1447, G6=sumMval/J1447, G7=0.15;
// k de agosto: medido na própria fase, sobre as linhas com φ do instante
let numAgo=0,denAgo=0;
for(const l of linhas){ if(mesDoSerial(l.serial)===8 && typeof l.W==='number'){ numAgo+=l.L; denAgo+=(l.X||0);} }
kMes[8]=(numAgo/denAgo)/G5;
const Kfac={},Lfac={};
for(let m=1;m<=8;m++){ Kfac[m]=G5*kMes[m]; Lfac[m]=G6*kMes[m]; }
for(const l of linhas){ const m=mesDoSerial(l.serial); l.N=(l.L/Kfac[m]+l.M/Lfac[m])/2; }

// ---------- SAÍDAS ----------
console.log('ÂNCORAS  G5(inferior)='+G5.toFixed(6)+'  G6(superior)='+G6.toFixed(6)+'  faixa=±'+(G7*100)+'%');
console.log('SAGER    J1447(frustrada total 30min)='+r(J1447)+' MWh   R1447(viés)='+R1447.toFixed(6));
console.log('k sazonal por mês: '+[1,2,3,4,5,6,7,8].map(m=>m+':'+kMes[m].toFixed(4)).join('  '));
console.log();
const nomeMes=['','jan','fev','mar','abr','mai','jun','jul','ago'];
console.log('=== ABA 14 · ESTIMATIVA MENSAL PRÉ-COD ===');
console.log('mês     horas     ger.medida   central(MWh)   inferior    superior');
let tH=0,tG=0,tN=0;
for(let m=1;m<=8;m++){
  const ls=linhas.filter(l=>l.fase==='Pré-COD'&&l.mes===`2025-0${m}`);
  const H=ls.reduce((a,l)=>a+l.F,0), G=ls.reduce((a,l)=>a+l.J,0), N=ls.reduce((a,l)=>a+l.N,0);
  tH+=H;tG+=G;tN+=N;
  console.log(nomeMes[m].padEnd(8)+r(H).toFixed(2).padStart(8)+r(G).toFixed(2).padStart(13)+r(N).toFixed(2).padStart(15)+r(N*(1-G7)).toFixed(2).padStart(12)+r(N*(1+G7)).toFixed(2).padStart(12));
}
console.log('TOTAL   '+r(tH).toFixed(2).padStart(8)+r(tG).toFixed(2).padStart(13)+r(tN).toFixed(2).padStart(15)+r(tN*(1-G7)).toFixed(2).padStart(12)+r(tN*(1+G7)).toFixed(2).padStart(12));
console.log();
console.log('=== ENERGIA E HORAS POR RAZÃO — PRÉ-COD (aba 14, quadro 2) ===');
const razCols={CNF:'O',REL:'P',ENE:'Q',ND:'R'};
const preE={},preH={};
for(const [raz,c] of Object.entries(razCols)){
  preE[raz]=linhas.filter(l=>l.fase==='Pré-COD').reduce((a,l)=>a+l.N*l[c],0);
  preH[raz]=linhas.filter(l=>l.fase==='Pré-COD').reduce((a,l)=>a+l.F*l[c],0);
}
const totE=Object.values(preE).reduce((a,b)=>a+b,0);
for(const raz of ['CNF','REL','ENE','ND']) console.log(raz.padEnd(5)+r(preH[raz]).toFixed(2).padStart(10)+' h '+r(preE[raz]).toFixed(2).padStart(12)+' MWh  '+(preE[raz]/totE*100).toFixed(2)+'%');
console.log('TOTAL'+r(Object.values(preH).reduce((a,b)=>a+b,0)).toFixed(2).padStart(10)+' h '+r(totE).toFixed(2).padStart(12)+' MWh');
console.log('COMPENSÁVEL (CNF+REL) = '+r(preE.CNF+preE.REL)+' MWh  ('+((preE.CNF+preE.REL)/totE*100).toFixed(2)+'%)');
console.log();
console.log('=== SAGER (04/09 a 25/11/2025), por razão ===');
for(const raz of Object.keys(sagerPorRazao).sort()) console.log(raz.padEnd(5)+r(sagerPorRazao[raz]).toFixed(2).padStart(12)+' MWh   (pré-COD '+r(sagerPre[raz]).toFixed(2)+' / pós-COD '+r(sagerPos[raz]).toFixed(2)+')');
console.log();
console.log('=== QUADRO CONSOLIDADO DA JANELA DO ART. 3º (aba 16) ===');
const totalJanela=tN+J1447;
console.log('Pré-COD estimado (04/01-31/08)  '+r(tN).toFixed(2).padStart(10)+' MWh   (estimativa ±15%)');
console.log('SAGER medido    (04/09-25/11)  '+r(J1447).toFixed(2).padStart(10)+' MWh   (calculado)');
console.log('TOTAL DA JANELA                '+r(totalJanela).toFixed(2).padStart(10)+' MWh');
console.log();
console.log('POR RAZÃO NA JANELA INTEIRA:');
for(const raz of ['CNF','REL','ENE','ND']){
  const t=(preE[raz]||0)+(sagerPorRazao[raz]||0);
  console.log('  '+raz.padEnd(4)+r(preE[raz]||0).toFixed(2).padStart(10)+' + '+r(sagerPorRazao[raz]||0).toFixed(2).padStart(10)+' = '+r(t).toFixed(2).padStart(11)+' MWh   '+(t/totalJanela*100).toFixed(2)+'%');
}
const comp=(preE.CNF+preE.REL)+((sagerPorRazao.CNF||0)+(sagerPorRazao.REL||0));
console.log('  COMPENSÁVEL (CNF+REL) = '+r(comp)+' MWh  ('+(comp/totalJanela*100).toFixed(2)+'% da janela)');
require('fs').writeFileSync('resultado.json',JSON.stringify({G5,G6,G7,J1447,R1447,kMes,preE,preH,sagerPorRazao,sagerPre,sagerPos,totalJanela,tN,tH,tG},null,2));
