// Real local preparation through production runHybrid, held mock HTTP only.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const {PdfPool,openPreparedPdf}=require('../pdf-pool.cjs');
const {ApiOcrWorker}=require('../ocr-api.cjs');
const {resolveOcrConfig}=require('../ocr-provider.cjs');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');

(async()=>{
  const filename=process.argv[2];assert.ok(filename,'Provide PDF filename');
  const root=path.resolve('.cache/pipeline-benchmark-'+crypto.randomUUID());fs.mkdirSync(root,{recursive:true});
  const reference=process.argv[4]?JSON.parse(fs.readFileSync(process.argv[4],'utf8')):null;
  const pool=new PdfPool(),warmup=await pool.prewarm(),results=[];
  try {
    for(let repeat=0;repeat<2;repeat++) {
      let release,localTiming,mockRequests=0;const formulas=[];
      const gate=new Promise(resolve=>{release=resolve;});
      const cacheDirectory=path.join(root,'preparation-'+repeat),outputDirectory=path.join(root,'ocr-'+repeat);
      const worker=new ApiOcrWorker({openDocument:async file=>{
        const document=await openPreparedPdf(file,{pool,cacheDirectory}),render=document.renderRegions;
        document.renderRegions=async(page,tasks,signal)=>{
          const images=await render(page,tasks,signal);
          for(let n=0;n<tasks.length;n++)if(tasks[n].kind==='formula'&&!images[n].error)formulas.push([tasks[n].id,hash(images[n].png)]);
          return images;
        };return document;
      },fetchImpl:async()=>{
        mockRequests++;await gate;
        return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'x'}}]}));
      }});
      const config=resolveOcrConfig({mode:'api',key:'LOCAL-MOCK-ONLY',concurrency:8});
      const doc=await openPreparedPdf(filename,{pool,cacheDirectory});const pageCount=doc.pageCount;await doc.close();
      const watchdog=setTimeout(()=>release(),30000);let result;
      try{result=await worker.request({path:filename,pageCount,pages:Array.from({length:pageCount},(_,n)=>n+1),outputDirectory,config},event=>{
        if(event.step==='preparation-done'){localTiming=structuredClone(event.timing);release();}
      },new AbortController().signal);}finally{clearTimeout(watchdog);release();}
      assert.ok(localTiming,'Local preparation must finish while mock HTTP is held');
      assert.equal(localTiming.completedRegions,0,'No response may finish before local preparation');
      assert.equal(result.timing.failedRegions,0);
      const formulaDigest=hash(JSON.stringify(formulas.sort((a,b)=>a[0].localeCompare(b[0]))));
      if(reference)assert.equal(formulaDigest,reference.formulaInputDigest,'Reference formula PNG digest changed');
      if(results.length)assert.equal(formulaDigest,results[0].formulaDigest,'Formula PNGs changed between repeats');
      results.push({repeat,localPreparationMs:localTiming.preparationMs,parseMs:localTiming.parseMs,
        totalWithMockResponsesMs:result.timing.totalMs,regions:result.timing.totalRegions,mockRequests,formulaInputs:formulas.length,formulaDigest,
        buffer:result.timing.buffer,preparation:result.timing.preparation});
      console.log(JSON.stringify(results.at(-1)));
    }
    const report={measuredAt:new Date().toISOString(),scope:'Real production local pipeline; HTTP responses held until preparation done; no actual network requests; each repeat has empty disk caches; document-info primed before timing',warmup,results};
    fs.writeFileSync(process.argv[3]||path.join(root,'report.json'),JSON.stringify(report,null,2));
  }finally{await pool.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
