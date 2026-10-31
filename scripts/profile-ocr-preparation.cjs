const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
assert.ok(require.cache[require.resolve('./profile-ocr-hook.cjs')],'Run with: node --require ./scripts/profile-ocr-hook.cjs scripts/profile-ocr-preparation.cjs paper.pdf');
const {PdfPool,openPreparedPdf}=require('../pdf-pool.cjs');
const {concurrent}=require('../ocr-hybrid.cjs');
const {context}=require('./profile-ocr-hook.cjs');

async function measure(filename,pool,cacheDirectory,label,mode='serial') {
  const started=performance.now(),cpu=process.cpuUsage(),signal=new AbortController().signal;
  const document=await openPreparedPdf(filename,{pool,cacheDirectory});
  const opened=performance.now(),plans=[],formulas=[];let bytes=0;
  try {
    await concurrent(Array.from({length:document.pageCount},(_,index)=>index+1),4,async page=>{
      const plan=await document.analyze(page,signal);plans.push(plan);document.prepareRegions(page,plan.tasks.length,plan.tasks);
    },signal);
    const parsed=performance.now();
    // Diagnostic ablation only: prioritise a specified known expensive page.
    // No production document ordering or OCR request logic is changed here.
    if(mode.includes('heavy-first'))plans.sort((a,b)=>Number(b.page===Number(process.env.OCR_PROFILE_FIRST_PAGE))-Number(a.page===Number(process.env.OCR_PROFILE_FIRST_PAGE)));
    await concurrent(plans.filter(plan=>plan.tasks.length),4,async plan=>{
      const render=async task=>{const image=await document.renderRegion(plan.page,task.bbox,signal,task.kind);bytes+=image.png.length;if(task.kind==='formula')formulas.push([task.id,crypto.createHash('sha256').update(image.png).digest('hex')]);};
      if(mode.includes('batch'))await concurrent(plan.tasks,8,render,signal);
      else for(const task of plan.tasks)await render(task);
      document.releasePage(plan.page);
    },signal);
    const usage=process.cpuUsage(cpu);
    return {label,mode,workers:pool.size,persistentCache:Boolean(cacheDirectory),openMs:opened-started,parseMs:parsed-opened,cropMs:performance.now()-parsed,totalMs:performance.now()-started,cpuMs:(usage.user+usage.system)/1000,bytes,regions:plans.reduce((sum,plan)=>sum+plan.tasks.length,0),formulaDigest:crypto.createHash('sha256').update(JSON.stringify(formulas.sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex'),preparation:document.stats()};
  }finally{await document.close();}
}

(async()=>{
  const filename=process.argv[2];assert.ok(filename,'Provide PDF filename');
  const root=path.resolve('.cache/ocr-bottleneck-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
  process.env.OCR_PREPARATION_TRACE_DIR=path.join(root,'trace');
  const results=[];
  const counts=process.env.OCR_PROFILE_WORKERS?process.env.OCR_PROFILE_WORKERS.split(',').map(Number):[1,2,4,8];
  for(const size of counts) {
    const pool=new PdfPool({size});await pool.prewarm();
    try {
      const modes=(process.env.OCR_PROFILE_MODES||'serial').split(',');
      for(let repeat=0;repeat<2;repeat++)for(const disk of process.env.OCR_PROFILE_CACHE==='disk'?[true]:[false,true])for(const mode of modes) {
        const label=size+' threads, '+(disk?'disk cache writes':'no disk cache')+', repeat '+repeat+(mode==='serial'?'':', '+mode);
        const row=await context.run({run:label},()=>measure(filename,pool,disk?path.join(root,'cache-'+size+'-'+repeat+'-'+mode):false,label,mode));
        results.push(row);console.log(JSON.stringify(row));
      }
    }finally{await pool.close();}
  }
  assert.equal(new Set(results.map(row=>row.formulaDigest)).size,1,'Formula image inputs must not change across scheduling experiments');
  const report={measuredAt:new Date().toISOString(),scope:'local only, prewarmed modules, uncached documents, same regions and formula PNGs, no API calls',root,results};
  fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync('.cache/ocr-bottleneck-latest.json',JSON.stringify(report,null,2));
  console.log('REPORT '+path.join(root,'report.json'));
})().catch(error=>{console.error(error);process.exitCode=1;});
