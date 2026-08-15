const fs=require('fs');
const un=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(d)).replace(/&amp;/g,'&');
// devolve Map: rowNum -> {COL: valorLiteral}  (só literais; fórmulas sem cache viram undefined)
function readSheet(n){
  const xml=fs.readFileSync(`x/xl/worksheets/sheet${n}.xml`,'utf8');
  const rows=new Map();
  for(const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
    const rn=+rm[1]; const o={};
    for(const cm of rm[2].matchAll(/<c ([^>]*)>([\s\S]*?)<\/c>/g)){
      const attrs=cm[1], body=cm[2];
      const rr=(attrs.match(/r="([A-Z]+)\d+"/)||[])[1]; if(!rr) continue;
      if(/<f[ >]/.test(body)) continue;               // fórmula sem cache: ignora
      const t=(attrs.match(/t="([^"]+)"/)||[])[1];
      if(t==='inlineStr'){ const v=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>un(x[1])).join(''); if(v!=='')o[rr]=v; }
      else { const vm=body.match(/<v>([\s\S]*?)<\/v>/); if(vm) o[rr]=parseFloat(vm[1]); }
    }
    if(Object.keys(o).length) rows.set(rn,o);
  }
  return rows;
}
const MAX0=(x)=>x>0?x:0;
module.exports={readSheet,MAX0};
