// Local model validation only: no recognition API calls or library-state writes.
const fs=require('node:fs'),path=require('node:path');
const assert=require('node:assert/strict');
const {openPdf}=require('../pdf-document.cjs');
const {LayoutModel}=require('../layout-model.cjs');
const {buildModelPlan}=require('../pdf-layout-model.cjs');
(async()=>{
  const filename=process.argv[2];if(!filename)throw Error('Usage: node scripts/verify-layout-model-real.cjs paper.pdf [1,2,3]');
  const signal=new AbortController().signal,document=await openPdf(filename),model=new LayoutModel(),reports=[];
  const directory=process.env.HELIOS_LAYOUT_VALIDATION_DIR;if(directory)fs.mkdirSync(directory,{recursive:true});
  try {
    const warm=await model.warmup();
    for(const page of (process.argv[3]||'1,2,3').split(',').map(Number)){
      const began=performance.now(),input=await document.layoutInput(page,signal),prepared=performance.now();
      if(directory)fs.writeFileSync(path.join(directory,'page-'+page+'.f32'),Buffer.from(input.pixels.buffer));
      const detected=await model.detect(input.pixels,signal);delete input.pixels;
      const plan=buildModelPlan(input,detected.regions);
      for(const task of plan.tasks.filter(t=>t.kind==='formula')){const block=plan.blocks.find(b=>b.id===task.blockId);assert.ok(task.start>=0&&task.end<=block.originalText.length);}
      const retained=plan.blocks.flatMap(block=>block.lines.flatMap(line=>line.runs));
      assert.deepEqual(retained.map(run=>run.id).sort((a,b)=>a-b),input.runs.map(run=>run.id),'Every native run must be retained exactly once');
      if(directory){fs.writeFileSync(path.join(directory,'page-'+page+'.json'),JSON.stringify(detected));fs.writeFileSync(path.join(directory,'plan-'+page+'.json'),JSON.stringify(plan));}
      reports.push({page,provider:detected.provider,regions:detected.regions.length,prepareMs:prepared-began,inferenceMs:detected.inferenceMs,totalMs:performance.now()-began,coverage:plan.layout.coverage,tasks:plan.tasks.reduce((counts,t)=>({...counts,[t.kind]:(counts[t.kind]||0)+1}),{}),warning:plan.warning});
      console.log(JSON.stringify(reports.at(-1)));await document.releasePage(page);
    }
    if(directory)fs.writeFileSync(path.join(directory,'report.json'),JSON.stringify({model:warm.model,modelSha256:warm.modelSha256,provider:warm.provider,pages:reports},null,2));
  }finally{await document.close();await model.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
