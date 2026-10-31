const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {setMaxListeners}=require('node:events');
const {WorkQueue}=require('./ocr-work-queue.cjs');

async function concurrent(items,limit,fn,signal) {
  let next=0;
  const settled=await Promise.allSettled(Array.from({length:Math.min(limit,items.length)},async()=>{
    while(next<items.length){signal.throwIfAborted();const index=next++;await fn(items[index],index);}
  }));
  const failure=settled.find(result=>result.status==='rejected');if(failure)throw failure.reason;
}

const stripMath=text=>text.trim().replace(/^(?:\$\$|\\\[|\\\(|\$)/,'').replace(/(?:\$\$|\\\]|\\\)|\$)$/,'').trim();
const cachedResult=filename=>{try{const value=JSON.parse(fs.readFileSync(filename,'utf8'));if(typeof value.text==='string'&&value.text.trim())return value;}catch{}};

async function runHybrid({document,payload,onEvent,signal,worker,normalizeApiPage,requestStarted=performance.now()}) {
  const controller=new AbortController();signal=AbortSignal.any([signal,controller.signal]);
  setMaxListeners(64,signal);
  const started=requestStarted,{config,outputDirectory,pages}=payload;
  const timing={startedAt:new Date(Date.now()-(performance.now()-started)).toISOString(),openMs:performance.now()-started,parseMs:0,renderMs:0,renderSkipped:0,preparedRegions:0,activeApi:0,apiRequests:0,cacheHits:0,totalRegions:0,completedRegions:0,failedRegions:0,concurrency:config.concurrency||8};
  const plans=[],cacheDirectory=path.join(outputDirectory,'regions');
  fs.mkdirSync(cacheDirectory,{recursive:true});
  const cachedNames=new Set(fs.readdirSync(cacheDirectory));
  const hasCachedRegions=[...cachedNames].some(name=>name.endsWith('.json'));
  const readCached=file=>file&&cachedNames.has(path.basename(file))?cachedResult(file):undefined;
  const saveCached=(file,value)=>{fs.writeFileSync(file,JSON.stringify(value));cachedNames.add(path.basename(file));};
  const layouts=new WorkQueue({priority:plan=>plan.renderCost||0});
  const ready=new WorkQueue({maxItems:128,maxBytes:32*1024*1024});
  const dirty=new Set(),publishedAt=new Map();
  const progress=(step,page)=>{if(document.stats)timing.preparation=document.stats();timing.buffer={items:ready.items.length,bytes:ready.bytes,peakItems:ready.peakItems,peakBytes:ready.peakBytes,maxItems:ready.maxItems,maxBytes:ready.maxBytes};onEvent({event:'progress',device:'hybrid',page,step,timing:{...timing,totalMs:performance.now()-started}});};
  const publish=(plan,force=false)=>{
    const terminal=plan.tasks.every(task=>task.status!=='pending');
    if(!force&&!terminal&&performance.now()-(publishedAt.get(plan)||0)<100){dirty.add(plan);return;}
    dirty.delete(plan);publishedAt.set(plan,performance.now());
    plan.complete=plan.tasks.every(task=>task.status==='completed');
    plan.recognition={pending:plan.tasks.filter(task=>task.status==='pending').length,failed:plan.tasks.filter(task=>task.status==='failed').length,total:plan.tasks.length};
    plan.timing={parseMs:plan.parseMs,totalMs:performance.now()-started};
    plan.runtime={device:'hybrid',model:config.model};
    const {tasks,...page}=plan;
    page.regions=tasks.map(({id,kind,bbox,status,error,timing})=>({id,kind,bbox,status,...(error?{error}:{}),...(timing?{timing}:{} )}));
    fs.writeFileSync(path.join(outputDirectory,`page-${plan.page}.json`),JSON.stringify(page));
    onEvent({event:plan.complete?'page':'draft',data:page});
  };
  const pending=new Map();
  const failRegion=(plan,task,error)=>{
    signal.throwIfAborted();
    task.status='failed';task.error=String(error.message||'区域识别失败').split(config.key||'\0').join('[已隐藏]');timing.failedRegions++;
    publish(plan);progress('regions',plan.page);
  };
  const processRegion=async({plan,task,image,result,lookupFile,cacheFile,cacheKey,cacheHit,renderMs,taskStarted})=>{
    try {
      if(!result) {
        if(!config.key)throw Error('请填写 API Key 后继续图像/公式识别；PDF 文字已保留');
        if(!pending.has(cacheKey))pending.set(cacheKey,(async()=>{
          timing.apiRequests++;timing.activeApi++;progress('requesting',plan.page);
          try {
            const value=await worker.recognizeImage(image,config,signal,task.kind);
            signal.throwIfAborted();
            if(!value.text.trim())throw Error('OCR API 返回了空区域');
            saveCached(cacheFile,value);return value;
          }finally{timing.activeApi--;}
        })());else cacheHit=true;
        result=await pending.get(cacheKey);
      }
      signal.throwIfAborted();
      if(lookupFile&&image)saveCached(lookupFile,{...result,width:image.width,height:image.height});
      if(cacheHit)timing.cacheHits++;
      task.timing={renderMs,apiMs:cacheHit?0:result.apiMs,cacheHit,totalMs:performance.now()-taskStarted};
      if(task.kind==='page') {
        const recognized=normalizeApiPage(result.text,plan.page,image.width,image.height);
        plan.blocks=recognized.blocks;plan.width=image.width;plan.height=image.height;
        plan.positionGranularity=recognized.positionGranularity;plan.warning=recognized.warning;
        plan.sourceImage=`page-${plan.page}.png`;plan.sourceKind='original-render';
        fs.writeFileSync(path.join(outputDirectory,plan.sourceImage),image.png);
      } else {
        const block=plan.blocks.find(block=>block.id===task.blockId);
        if(task.kind==='formula') {
          const latex=stripMath(result.text);if(!latex)throw Error('OCR API 返回了空公式');
          block.mathReplacements||=[];block.mathReplacements.push({start:task.start,end:task.end,latex,bbox:task.bbox});
          let text=block.originalText;
          for(const replacement of [...block.mathReplacements].sort((a,b)=>b.start-a.start))text=text.slice(0,replacement.start)+'$'+replacement.latex+'$'+text.slice(replacement.end);
          block.text=text;block.format='mixed';
        } else {block.ocrText=result.text;block.recognitionSource='api-region';}
      }
      task.status='completed';timing.completedRegions++;
    } catch(error) {failRegion(plan,task,error);return;}
    publish(plan);progress('regions',plan.page);
  };

  const preparePlan=async plan=>{
    const missing=[];
    try {
      for(const task of plan.tasks) {
        signal.throwIfAborted();
        const identity=document.regionIdentity?.(plan.page,task.bbox,task.kind);
        const lookupFile=identity?path.join(cacheDirectory,'lookup-'+crypto.createHash('sha256').update(JSON.stringify([identity,config.baseUrl,config.model,task.kind,'roi-v1'])).digest('hex')+'.json'):null;
        const result=readCached(lookupFile);
        const item={plan,task,lookupFile,result,cacheHit:Boolean(result),renderMs:0,taskStarted:performance.now()};
        if(result&&task.kind!=='page'){timing.renderSkipped++;timing.preparedRegions++;await ready.push(item,0,signal);}
        else if(!result&&!config.key&&!hasCachedRegions)failRegion(plan,task,Error('请填写 API Key 后继续图像/公式识别；PDF 文字已保留'));
        else missing.push(item);
      }
      // Transfer crops in page batches, independently of HTTP completion. Limit
      // in-flight local batches as well as the byte/item-bounded ready queue.
      for(let offset=0;offset<missing.length;offset+=16) {
        const batch=missing.slice(offset,offset+16),renderStarted=performance.now();
        progress('rendering',plan.page);
        let images;
        try {
          if(document.renderRegions)images=await document.renderRegions(plan.page,batch.map(item=>item.task),signal);
          else images=await Promise.all(batch.map(async({task})=>{
            try{return task.kind==='page'?await document.render(plan.page,signal):await document.renderRegion(plan.page,task.bbox,signal,task.kind);}
            catch(error){signal.throwIfAborted();return {error};}
          }));
          if(images.length!==batch.length)throw Error('PDF region batch returned invalid coverage');
        }catch(error){signal.throwIfAborted();images=batch.map(()=>({error}));}
        const renderMs=(performance.now()-renderStarted)/batch.length;
        timing.renderMs+=renderMs*batch.length;
        for(let n=0;n<batch.length;n++) {
          const item=batch[n],image=images[n];
          if(image.error){failRegion(plan,item.task,image.error);continue;}
          item.image=image;item.renderMs=renderMs;
          if(!item.result) {
            item.cacheKey=crypto.createHash('sha256').update(config.baseUrl+'\n'+config.model+'\n'+item.task.kind+'\nroi-v1\n').update(image.png).digest('hex');
            item.cacheFile=path.join(cacheDirectory,item.cacheKey+'.json');
            item.result=readCached(item.cacheFile);item.cacheHit=Boolean(item.result);
          }
          timing.preparedRegions++;await ready.push(item,image.png.length,signal);
        }
        progress('prepared',plan.page);
      }
    }finally{await document.releasePage?.(plan.page);}
  };
  // A fatal pipeline error must wake blocked producers/consumers and cancel all
  // other stages before the caller closes the underlying PDF document.
  let pipelineError;
  const guarded=async fn=>{try{return await fn();}catch(error){pipelineError||=error;layouts.fail(error);ready.fail(error);controller.abort(error);throw error;}};
  const parseStart=performance.now();
  const parsingDone=guarded(async()=>{
    try{await concurrent(pages,4,async number=>{
      progress('extracting',number);
      const plan=await document.analyze(number,signal);
      document.prepareRegions?.(number,plan.tasks.length,plan.tasks);
      for(const task of plan.tasks)task.status='pending';
      plans.push(plan);timing.totalRegions+=plan.tasks.length;publish(plan,true);
      if(plan.tasks.length)await layouts.push(plan,0,signal);else await document.releasePage?.(number);
    },signal);}finally{timing.parseMs=performance.now()-parseStart;layouts.close();}
  });
  const preparingDone=guarded(async()=>{
    const count=Math.min(4,document.stats?.().poolSize||4);
    await concurrent(Array.from({length:count}),count,()=>guarded(async()=>{
      while(true){const plan=await layouts.take(signal);if(!plan)return;await preparePlan(plan);}
    }),signal);
    timing.preparationMs=performance.now()-started;ready.close();progress('preparation-done');
  });
  const recognizingDone=guarded(async()=>{
    await concurrent(Array.from({length:timing.concurrency}),timing.concurrency,()=>guarded(async()=>{
      while(true){const item=await ready.take(signal);if(!item)return;await processRegion(item);}
    }),signal);
  });
  await Promise.allSettled([parsingDone,preparingDone,recognizingDone]);
  for(const plan of dirty)publish(plan,true);
  if(pipelineError)throw pipelineError;
  timing.totalMs=performance.now()-started;timing.completedAt=new Date().toISOString();
  progress('done');
  return {signature:`PDF-text+SiliconFlow:${config.model}:roi-v1`,timing};
}

module.exports={runHybrid,concurrent};
