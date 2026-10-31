// Equal local workload; no OCR API calls. Formula candidates and PNGs must match.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {openPdf}=require('../pdf-document.cjs');
const {PdfPool,openPreparedPdf}=require('../pdf-pool.cjs');
const {concurrent}=require('../ocr-hybrid.cjs');
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

async function measure(open,{batch=false}={}) {
  const start=performance.now(),signal=new AbortController().signal,document=await open();
  const opened=performance.now(),plans=[],formulas=[];let cropBytes=0;
  try {
    await concurrent(Array.from({length:document.pageCount},(_,index)=>index+1),4,async page=>{
      const plan=await document.analyze(page,signal);plans.push(plan);
      document.prepareRegions(plan.page,plan.tasks.length,plan.tasks);
    },signal);
    const parsed=performance.now();
    const schedule=plans.filter(plan=>plan.tasks.length);if(batch)schedule.sort((a,b)=>(b.renderCost||0)-(a.renderCost||0));
    await concurrent(schedule,4,async plan=>{
      for(let offset=0;offset<plan.tasks.length;offset+=batch?16:1) {
        const tasks=plan.tasks.slice(offset,offset+(batch?16:1));
        const images=batch?await document.renderRegions(plan.page,tasks,signal):[tasks[0].kind==='page'?await document.render(plan.page,signal):await document.renderRegion(plan.page,tasks[0].bbox,signal,tasks[0].kind)];
        for(let index=0;index<tasks.length;index++) {
        const task=tasks[index],image=images[index];if(image.error)throw Error(image.error.message);
        cropBytes+=image.png.length;
        if(task.kind==='formula')formulas.push([task.id,hash(image.png)]);
        }
      }
      await document.releasePage(plan.page);
    },signal);
    return {openMs:opened-start,parseMs:parsed-opened,cropMs:performance.now()-parsed,totalMs:performance.now()-start,cropBytes,
      regions:plans.reduce((sum,plan)=>sum+plan.tasks.length,0),formulaInputs:formulas.sort((a,b)=>a[0].localeCompare(b[0])),
      geometry:hash(JSON.stringify(plans.sort((a,b)=>a.page-b.page).map(({page,width,height,blocks,tasks})=>({page,width,height,blocks,tasks})))),preparation:document.stats?.()};
  }finally{await document.close();}
}

(async()=>{
  const filename=process.argv[2];if(!filename)throw Error('Usage: node scripts/benchmark-ocr-preparation.cjs paper.pdf [report.json]');
  const cacheDirectory=path.resolve('.cache/preparation-benchmark-'+crypto.randomUUID());
  const baseline=await measure(()=>openPdf(filename));console.log('baseline local preparation: '+baseline.totalMs.toFixed(0)+' ms');
  const pool=new PdfPool();
  try {
    const warmup=await pool.prewarm();
    const first=await measure(()=>openPreparedPdf(filename,{pool,cacheDirectory}),{batch:true});console.log('prewarmed workers, empty cache: '+first.totalMs.toFixed(0)+' ms');
    const cached=await measure(()=>openPreparedPdf(filename,{pool,cacheDirectory}),{batch:true});
    assert.equal(first.geometry,baseline.geometry,'Native blocks, formula candidates and source ranges must remain identical');
    assert.deepEqual(first.formulaInputs,baseline.formulaInputs,'Formula PNG request inputs must remain byte-identical');
    assert.equal(cached.geometry,first.geometry);assert.deepEqual(cached.formulaInputs,first.formulaInputs);
    const summarize=({formulaInputs,geometry,...metrics})=>metrics;
    const report={measuredAt:new Date().toISOString(),scope:'local preparation including awaited cache writes; zero cloud requests; equal parse-then-crop workload, new scheduling prioritizes operator count and batches crops',warmup,baseline:summarize(baseline),first:summarize(first),cached:summarize(cached),
      unchangedFormulaInputs:baseline.formulaInputs.length,formulaInputDigest:hash(JSON.stringify(baseline.formulaInputs)),geometryIdentical:true,formulaPngBytesIdentical:true,cloudRequests:0};
    if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
  }finally{await pool.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
