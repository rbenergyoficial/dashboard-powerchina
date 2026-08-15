const fs=require('fs');
const wb=fs.readFileSync('x/xl/workbook.xml','utf8');
const rels=fs.readFileSync('x/xl/_rels/workbook.xml.rels','utf8');
const map={};
for(const m of rels.matchAll(/Target="([^"]*sheet(\d+)\.xml)"\s+Id="(rId\d+)"/g)) map[m[3]]='x/xl/worksheets/sheet'+m[2]+'.xml';
let i=0;
for(const m of wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="(rId\d+)"/g)){
  const f=map[m[2]]; const sz=fs.existsSync(f)?fs.statSync(f).size:0;
  console.log(String(i).padStart(2,'0'), '|', m[1].padEnd(42), '|', (f||'?').replace('x/xl/worksheets/',''), '|', (sz/1024).toFixed(0)+' KB');
  i++;
}
