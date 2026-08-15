const fs=require('fs');
const n=process.argv[2], from=+(process.argv[3]||1), to=+(process.argv[4]||9999), onlyCols=(process.argv[5]||'').split(',').filter(Boolean);
const xml=fs.readFileSync(`x/xl/worksheets/sheet${n}.xml`,'utf8');
const un=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,d)=>String.fromCharCode(d)).replace(/&amp;/g,'&');
for(const rm of xml.matchAll(/<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)){
  const rn=+rm[1]; if(rn<from||rn>to) continue;
  for(const cm of rm[2].matchAll(/<c ([^>]*)>([\s\S]*?)<\/c>/g)){
    const attrs=cm[1], body=cm[2];
    const rr=(attrs.match(/r="([A-Z]+\d+)"/)||[])[1]; if(!rr) continue;
    const cl=rr.match(/^[A-Z]+/)[0];
    if(onlyCols.length && !onlyCols.includes(cl)) continue;
    const t=(attrs.match(/t="([^"]+)"/)||[])[1];
    let v='';
    if(t==='inlineStr') v=[...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x=>un(x[1])).join('');
    else { const vm=body.match(/<v>([\s\S]*?)<\/v>/); if(vm) v=un(vm[1]); }
    const fm=body.match(/<f[^>]*>([\s\S]*?)<\/f>/);
    if(v==='' && !fm) continue;
    console.log(rr.padEnd(6), (fm?'[='+un(fm[1])+'] ':'')+v);
  }
}
