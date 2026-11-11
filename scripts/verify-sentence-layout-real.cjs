// Verify sentence source coverage on already exported real-model plans; no cloud calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {buildSentences,protectSentence}=require('../sentences.cjs');
const {ignoredBlock,mediaBlock}=require('../translation-model.cjs');
const directory=process.argv[2];assert.ok(directory,'Provide layout-validation directory');
const pages=fs.readdirSync(directory).filter(f=>/^plan-\d+\.json$/.test(f)).map(f=>JSON.parse(fs.readFileSync(path.join(directory,f),'utf8'))).sort((a,b)=>a.page-b.page);
const result=buildSentences(pages,{pdfHash:'readonly-quality-check'}),seen=new Set(),omitted=new Set();
for(const x of result.excluded)for(let i=x.start;i<x.end;i++)omitted.add(`${x.page}:${x.blockId}:${i}`);
for(const s of result.sentences)for(const r of s.sourceRanges){
  const b=pages.find(p=>p.page===r.page).blocks.find(b=>b.id===r.blockId),raw=b.originalText??b.text;
  assert.equal(s.text.slice(r.sentenceStart,r.sentenceEnd),raw.slice(r.start,r.end).replace(/\n/g,' '));
  for(let i=r.start;i<r.end;i++){const key=`${r.page}:${r.blockId}:${i}`;assert.ok(!seen.has(key),'Repeated native character');seen.add(key);}
}
for(const p of pages)for(const b of p.blocks){
  if(ignoredBlock(b)||mediaBlock(b))continue;
  const raw=b.originalText??b.text;for(let i=0;i<raw.length;i++)if(!/\s/.test(raw[i])){const key=`${p.page}:${b.id}:${i}`;assert.ok(seen.has(key)||omitted.has(key),'Missing native character '+key);}
}
const report={pages:pages.map(p=>p.page),sentences:result.sentences.length,incomplete:result.sentences.filter(s=>!s.complete).length,multiRange:result.sentences.filter(s=>s.sourceRanges.length>1).length,nativeMathRuns:pages.reduce((n,p)=>n+p.blocks.reduce((n,b)=>n+(b.lines||[]).flatMap(l=>l.runs||[]).filter(r=>r.mathFont).length,0),0),protectedFormulas:result.sentences.reduce((n,s)=>n+protectSentence(s).tokens.filter(t=>t.kind==='formula').length,0),excludedMargins:result.excluded,exactNativeCoverage:true,realCloudRequests:0};
console.log(JSON.stringify(report,null,2));fs.writeFileSync(path.join(directory,'sentence-coverage.json'),JSON.stringify(report,null,2));
