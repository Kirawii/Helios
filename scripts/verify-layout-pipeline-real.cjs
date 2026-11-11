// Opt-in integration test with real PDF/model workers and mock paid recognition.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {PdfPool,openPreparedPdf}=require('../pdf-pool.cjs');
const {closeLayoutModel}=require('../layout-model.cjs');
const {ApiOcrWorker}=require('../ocr-api.cjs');
const {resolveOcrConfig}=require('../ocr-provider.cjs');
(async()=>{
  assert.equal(process.env.HELIOS_LAYOUT,'model','Run with HELIOS_LAYOUT=model');
  const filename=process.argv[2];assert.ok(filename,'Provide PDF filename');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-layout-pipeline-')),pool=new PdfPool({size:4}),cacheDirectory=path.join(root,'preparation');
  const pages=(process.argv[3]||'2,8,16').split(',').map(Number),completed=[],prompts=[];let cached;
  const worker=new ApiOcrWorker({openDocument:filename=>openPreparedPdf(filename,{pool,cacheDirectory}),fetchImpl:async(url,request)=>{
    const prompt=JSON.parse(request.body).messages[0].content[1].text;prompts.push(prompt);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:prompt==='Formula Recognition:'?'x_{i}+1':prompt==='Table Recognition:'?'<table><tr><td>value</td></tr></table>':'Synthetic recognized content.'}}]}));
  }});
  try{
    await pool.prewarm();cached=await openPreparedPdf(filename,{pool,cacheDirectory});const pageCount=cached.pageCount;await cached.close();cached=null;
    const result=await worker.request({path:filename,pageCount,pages,outputDirectory:path.join(root,'results'),config:resolveOcrConfig({mode:'api',key:'MOCK-ONLY'})},event=>{if(event.event==='page')completed.push(event.data);},new AbortController().signal);
    assert.equal(result.timing.failedRegions,0);assert.equal(completed.length,pages.length);assert.ok(completed.every(p=>p.layout.engine==='PP-DocLayoutV3'));
    cached=await openPreparedPdf(filename,{pool,cacheDirectory});for(const page of pages)await cached.analyze(page,new AbortController().signal);
    assert.equal(cached.stats().layoutCacheHits,pages.length);assert.equal(cached.stats().analyses,0);assert.deepEqual(cached.stats().workerThreads,[]);
    console.log(JSON.stringify({pages:pages.length,completedRegions:result.timing.completedRegions,mockRequests:prompts.length,prompts:[...new Set(prompts)],layoutCacheHits:cached.stats().layoutCacheHits,realCloudRequests:0}));
  }finally{await cached?.close();worker.close();await pool.close();await closeLayoutModel();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-layout-pipeline-'))fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
