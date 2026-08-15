const fs=require('fs');
// dump.js <sheetN> [maxRows] [maxCol]
const n=process.argv[2], MAXR=+(process.argv[3]||60), MAXC=+(process.argv[4]||14);
const xml=fs.readFileSync(`x/xl/worksheets/sheet${n}.xml`,'utf8');
const un=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(d)).replace(/&amp;/g,'&');
const col=r=>{const m=r.match(/^([A-Z]+)/)[1];let x=0;for(const ch of m)x=x*26+(ch.charCodeAt(0)-64);return x;};
const rows=new Map();
for(const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
  const rn=+rm[1]; if(rn>MAXR) continue;
  const cells=new Map();
  for(const cm of rm[2].matchAll(/<c ([^>]*)>([\s\S]*?)<\/c>|<c ([^>]*)\/>/g)){
    const attrs=cm[1]||cm[3]||'', body=cm[2]||'';
    const rr=(attrs.match(/r="([A-Z]+\d+)"/)||[])[1]; if(!rr) continue;
    const t=(attrs.match(/t="([^"]+)"/)||[])[1];
    let v='';
    if(t==='inlineStr'){ v=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>un(x[1])).join(''); }
    else { const vm=body.match(/<v>([\s\S]*?)<\/v>/); if(vm) v=un(vm[1]); }
    const f=body.match(/<f[^>]*>([\s\S]*?)<\/f>/);
    if(f && process.env.SHOWF) v=(v===''?'':v)+' {='+un(f[1]).slice(0,60)+'}';
    if(v!=='') cells.set(col(rr),v);
  }
  if(cells.size) rows.set(rn,cells);
}
const keys=[...rows.keys()].sort((a,b)=>a-b);
for(const k of keys){
  const c=rows.get(k); const out=[];
  for(let i=1;i<=MAXC;i++){ let v=c.get(i)||''; if(v.length>26)v=v.slice(0,25)+'…'; out.push(v.padEnd(14)); }
  console.log(String(k).padStart(4)+'| '+out.join('|').replace(/\s+$/,''));
}
