// Local preparation only. This benchmark never sends requests to an OCR API.
const fs = require('node:fs');
const {openPdf} = require('../ocr-api.cjs');
const {concurrent} = require('../ocr-hybrid.cjs');

(async()=>{
  const filename=process.argv[2];
  if(!filename)throw Error('Usage: node scripts/benchmark-ocr-native.cjs paper.pdf [report.json]');
  const started=performance.now(),signal=new AbortController().signal;
  const document=await openPdf(filename),openMs=performance.now()-started;
  try {
    const plans=[],parseStarted=performance.now();
    await concurrent(Array.from({length:document.pageCount},(_,index)=>index+1),4,async number=>{plans.push(await document.analyze(number,signal));},signal);
    const parseMs=performance.now()-parseStarted,renderStarted=performance.now();let cropBytes=0;
    await concurrent(plans.filter(plan=>plan.tasks.length),4,async plan=>{
      document.prepareRegions(plan.page,plan.tasks.length);
      for(const task of plan.tasks){const image=task.kind==='page'?await document.render(plan.page,signal):await document.renderRegion(plan.page,task.bbox,signal);cropBytes+=image.png.length;}
      document.releasePage(plan.page);
    },signal);
    const report={measuredAt:new Date().toISOString(),scope:'local preparation only; no cloud latency or end-to-end completion claim',pages:document.pageCount,openMs,parseMs,nativeReadyMs:openMs+parseMs,cropMs:performance.now()-renderStarted,totalMs:performance.now()-started,regions:plans.reduce((sum,plan)=>sum+plan.tasks.length,0),cropBytes,cloudRequests:0,
      perPage:plans.sort((a,b)=>a.page-b.page).map(plan=>({page:plan.page,nativeCharacters:plan.nativeCharacters,blocks:plan.blocks.length,regions:plan.tasks.length,parseMs:plan.parseMs,scanFallback:plan.scanFallback}))};
    if(process.argv[3])fs.writeFileSync(process.argv[3],JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
  }finally{await document.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
