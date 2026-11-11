// Annotation aid ONLY. Native font proposals are not detector predictions or gold labels.
// A reviewer must check the original page, remove numeric/figure labels and merge expressions.
const fs=require('node:fs'),path=require('node:path');
const {compose}=require('../pdf-layout-model.cjs');
const base=path.join(__dirname,'..'),out=path.join(base,'output/layout-benchmark/v1'),prepared=path.join(base,'.cache/layout-benchmark/prepared');
const metadata=JSON.parse(fs.readFileSync(path.join(out,'preparation.json'))),pages=[];
const math=r=>/\+(?:CM(?:MI|SY|EX|R|BX|MIB)\d|MSAM|MSBM)|LibertineMath|\+tx(?:mia|sys|ex)/.test(r.fontFamily||'');
const punctuation=r=>r.text.length<18&&/^[\s\d=+−\-×÷*/^_()[\]{},.:;<>|∈∪]+$/.test(r.text);
const box=runs=>[Math.min(...runs.map(r=>r.bbox[0])),Math.min(...runs.map(r=>r.bbox[1])),Math.max(...runs.map(r=>r.bbox[2])),Math.max(...runs.map(r=>r.bbox[3]))];
for(const page of metadata.pages){
  const input=JSON.parse(fs.readFileSync(path.join(prepared,page.key+'.json'))),groups=[];
  for(const line of compose(input.runs).lines){let group=[];
    const flush=()=>{if(group.some(math))groups.push({runs:group.map(r=>r.id),text:group.map(r=>r.text).join(''),bbox:box(group)});group=[];};
    for(const run of line.runs){if((math(run)||punctuation(run))&&(!group.length||run.bbox[0]-group.at(-1).bbox[2]<.012))group.push(run);else{flush();if(math(run)||punctuation(run))group.push(run);}}flush();
  }
  groups.forEach((g,i)=>g.id='n'+i);pages.push({key:page.key,status:'pending',groups});
  console.log(page.key+' '+groups.length);console.log(groups.map(g=>`${g.id} ${g.text} @${Math.round(g.bbox[0]*page.imageWidth)},${Math.round(g.bbox[1]*page.imageHeight)}`).join('\n'));
}
fs.writeFileSync(path.join(out,'native-draft.json'),JSON.stringify({warning:'Unreviewed native-font proposals; not gold, not a benchmark result',pages},null,2));
