const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {Worker} = require('node:worker_threads');
const {PreparationCache,digest} = require('./pdf-preparation-cache.cjs');

// A change to geometry, rendering, dependency version or pixel settings invalidates
// preparation caches without touching saved OCR results or provider fingerprints.
const PROFILE=digest(JSON.stringify([require('pdfjs-dist/package.json').version,require('@napi-rs/canvas/package.json').version,process.platform,process.arch,'144dpi-png-adaptive-v1',
  ...['pdf-native.cjs','pdf-document.cjs','pdf-embedded-image.cjs'].map(file=>fs.readFileSync(path.join(__dirname,file),'utf8'))]));

class PdfPool {
  constructor({size=Number(process.env.HELIOS_PDF_WORKERS||Math.min(4,Math.max(1,os.availableParallelism()-1)))}={}) {
    if(!Number.isInteger(size)||size<1||size>8)throw Error('HELIOS_PDF_WORKERS must be an integer from 1 to 8');
    this.size=size;this.slots=[];this.loads=Array(size).fill(0);this.sequence=0;this.closed=false;this.nextSlot=0;
    this.queues=Array.from({length:size},()=>[]);this.busy=Array(size).fill(false);
  }
  leastBusy(){let chosen=this.nextSlot;for(let offset=1;offset<this.size;offset++){const index=(this.nextSlot+offset)%this.size;if(this.loads[index]<this.loads[chosen])chosen=index;}this.nextSlot=(chosen+1)%this.size;return chosen;}
  slot(index) {
    if(this.closed)throw Error('PDF worker pool is closed');
    if(this.slots[index]&&!this.slots[index].failed)return this.slots[index];
    const slot={worker:new Worker(path.join(__dirname,'pdf-thread.cjs')),pending:new Map(),failed:false};
    this.slots[index]=slot;
    const fail=error=>{
      slot.failed=true;
      for(const pending of slot.pending.values()){pending.cleanup();pending.reject(error);}
      slot.pending.clear();slot.worker.unref();
    };
    slot.worker.on('message',message=>{
      const pending=slot.pending.get(message.id);if(!pending)return;
      slot.pending.delete(message.id);pending.cleanup();
      if(message.error)pending.reject(Object.assign(Error(message.error.message),{name:message.error.name}));
      else pending.resolve({data:message.data,threadId:message.threadId});
      if(!slot.pending.size)slot.worker.unref();
    });
    slot.worker.on('error',fail);
    slot.worker.on('exit',code=>{if(!this.closed)fail(Error('PDF worker exited ('+code+')'));});
    slot.ready=this.send(slot,{method:'warm'});slot.ready.catch(()=>{});
    return slot;
  }
  send(slot,message,signal) {
    return new Promise((resolve,reject)=>{
      try{signal?.throwIfAborted();}catch(error){reject(error);return;}
      const id=++this.sequence;
      const abort=()=>{
        slot.pending.delete(id);signal.removeEventListener('abort',abort);
        slot.worker.postMessage({cancel:id});if(!slot.pending.size)slot.worker.unref();reject(signal.reason);
      };
      slot.pending.set(id,{resolve,reject,cleanup:()=>signal?.removeEventListener('abort',abort)});
      signal?.addEventListener('abort',abort,{once:true});slot.worker.ref();
      try{slot.worker.postMessage({...message,id});}catch(error){slot.pending.delete(id);signal?.removeEventListener('abort',abort);if(!slot.pending.size)slot.worker.unref();reject(error);}
    });
  }
  run(index,message,signal) {
    if(this.closed)return Promise.reject(Error('PDF worker pool is closed'));
    try{signal?.throwIfAborted();}catch(error){return Promise.reject(error);}
    this.loads[index]++;
    return new Promise((resolve,reject)=>{
      const entry={message,signal,resolve,reject};
      entry.abort=()=>{
        const position=this.queues[index].indexOf(entry);if(position<0)return;
        this.queues[index].splice(position,1);this.loads[index]--;reject(signal.reason);
      };
      signal?.addEventListener('abort',entry.abort,{once:true});this.queues[index].push(entry);this.drain(index);
    });
  }
  async drain(index) {
    if(this.busy[index]||!this.queues[index].length)return;
    // Do not bury later page analysis behind queued rendering. Knowing layouts
    // first lets the local preparation queue see and prioritize expensive pages.
    const priority=entry=>entry.message.method==='analyze'?2:entry.message.method==='cropBatch'?1:0;
    let chosen=0;for(let n=1;n<this.queues[index].length;n++)if(priority(this.queues[index][n])>priority(this.queues[index][chosen]))chosen=n;
    const [entry]=this.queues[index].splice(chosen,1);this.busy[index]=true;
    entry.signal?.removeEventListener('abort',entry.abort);
    try{const slot=this.slot(index);await slot.ready;entry.signal?.throwIfAborted();entry.resolve(await this.send(slot,entry.message,entry.signal));}
    catch(error){entry.reject(error);}
    finally{this.loads[index]--;this.busy[index]=false;this.drain(index);}
  }
  async prewarm(){const started=performance.now();const threads=await Promise.all(Array.from({length:this.size},(_,index)=>this.slot(index).ready));return {workers:this.size,threadIds:threads.map(result=>result.threadId),warmupMs:performance.now()-started};}
  async close(){this.closed=true;
    for(let index=0;index<this.size;index++)for(const entry of this.queues[index].splice(0)){entry.signal?.removeEventListener('abort',entry.abort);this.loads[index]--;entry.reject(Error('PDF worker pool is closed'));}
    for(const slot of this.slots)if(slot){for(const pending of slot.pending.values()){pending.cleanup();pending.reject(Error('PDF worker pool is closed'));}slot.pending.clear();}
    await Promise.all(this.slots.map(slot=>slot?.worker.terminate()));
  }
}

let sharedPool;
const getPdfPool=()=>sharedPool ||= new PdfPool();
const prewarmPdf=()=>getPdfPool().prewarm();
async function closePdfPool(){const pool=sharedPool;sharedPool=undefined;await pool?.close();}

async function openPreparedPdf(filename,{pool=getPdfPool(),cacheDirectory=process.env.HELIOS_PDF_CACHE||path.join(__dirname,'.cache/pdf-preparation'),signal}={}) {
  signal?.throwIfAborted();
  const pdfHash=digest(await fsp.readFile(filename)),cache=cacheDirectory?new PreparationCache(cacheDirectory,pdfHash,PROFILE):null;
  const documentId=crypto.randomUUID(),used=new Set(),threadIds=new Set(),inFlight=new Set(),pageWorkers=new Map();
  const plans=new Map(),pageImages=new Map(),pageOperations=new Map(),preparation=new Map(),prepared=new Set(),diskHits=new Set();
  let closed=false,legacyAvailable;
  const metrics={layoutCacheHits:0,cropCacheHits:0,analyses:0,renders:0,renderBatches:0,cachePageWrites:0,embeddedImages:0};
  function call(method,page,args=[],operationSignal) {
    if(closed)return Promise.reject(Error('PDF document is closed'));
    if(!pageWorkers.has(page))pageWorkers.set(page,pool.leastBusy());
    const index=pageWorkers.get(page);used.add(index);
    const promise=pool.run(index,{method,documentId,filename,args},operationSignal).then(({data,threadId})=>{
      threadIds.add(threadId);
      for(const image of data?.images||[data])if(image?.png)image.png=Buffer.from(image.png.buffer,image.png.byteOffset,image.png.byteLength);
      return data;
    });
    inFlight.add(promise);promise.then(()=>inFlight.delete(promise),()=>inFlight.delete(promise));return promise;
  }
  let info;
  try {
    info=await cache?.readInfo();
    if(!info){info=await call('open',1,[],signal);await cache?.writeInfo(info);}
    signal?.throwIfAborted();
  }catch(error){await Promise.allSettled([...used].map(index=>pool.run(index,{method:'close',documentId})));throw error;}
  function serial(page,fn) {
    const previous=pageOperations.get(page)||Promise.resolve(),next=previous.catch(()=>{}).then(fn);
    pageOperations.set(page,next);
    next.then(()=>{if(pageOperations.get(page)===next)pageOperations.delete(page);},()=>{if(pageOperations.get(page)===next)pageOperations.delete(page);});
    return next;
  }
  const regionIdentity=(page,bounds,kind='region')=>digest(JSON.stringify([pdfHash,PROFILE,page,bounds,kind]));
  async function renderRegions(page,tasks,operationSignal) {
    return serial(page,async()=>{
      operationSignal.throwIfAborted();
      if(!pageImages.has(page))pageImages.set(page,(async()=>{
        const images=await cache?.readPage(page)||new Map();
        return {images,fromDisk:new Set(images.keys())};
      })());
      const {images,fromDisk}=await pageImages.get(page),result=Array(tasks.length),missing=[];let changed=false;
      for(let index=0;index<tasks.length;index++) {
        const task=tasks[index],key=regionIdentity(page,task.bbox,task.kind);
        let image=images.get(key);
        if(!image&&cache) {
          legacyAvailable ||= cache.hasLegacyImages();
          if(await legacyAvailable){image=await cache.readImage(page,task.bbox,task.kind||'region');if(image){images.set(key,image);fromDisk.add(key);changed=true;}}
        }
        if(image){result[index]=image;if(fromDisk.has(key)&&!diskHits.has(key)){diskHits.add(key);metrics.cropCacheHits++;}}
        else missing.push({index,key,task});
      }
      if(missing.length) {
        operationSignal.throwIfAborted();metrics.renders+=missing.length;metrics.renderBatches++;
        const data=await call('cropBatch',page,[page,prepared.has(page)?null:preparation.get(page),missing.map(entry=>entry.task)],operationSignal);
        prepared.add(page);operationSignal.throwIfAborted();
        if(data.images?.length!==missing.length)throw Error('PDF region batch returned invalid coverage');
        for(let n=0;n<missing.length;n++) {
          const {index,key}=missing[n],image=data.images[n];result[index]=image;
          if(!image.error){images.set(key,image);changed=true;if(image.source==='embedded-image')metrics.embeddedImages++;}
        }
      }
      if(changed&&cache){await cache.writePage(page,images);metrics.cachePageWrites++;}
      operationSignal.throwIfAborted();return result;
    });
  }
  async function single(page,bounds,operationSignal,kind) {
    const [image]=await renderRegions(page,[{bbox:bounds,kind:kind||'region'}],operationSignal);
    if(image.error)throw Object.assign(Error(image.error.message),{name:image.error.name});return image;
  }
  return {
    pageCount:info.pageCount,regionIdentity,
    stats:()=>({...metrics,workerThreads:[...threadIds],poolSize:pool.size}),
    async analyze(page,operationSignal) {
      operationSignal.throwIfAborted();
      if(!plans.has(page))plans.set(page,(async()=>{
        const started=performance.now();let plan=await cache?.readLayout(page);operationSignal.throwIfAborted();
        if(plan)metrics.layoutCacheHits++;
        else {metrics.analyses++;plan=await call('analyze',page,[page],operationSignal);operationSignal.throwIfAborted();await cache?.writeLayout(page,plan);}
        return {...plan,parseMs:performance.now()-started};
      })());
      try{return structuredClone(await plans.get(page));}catch(error){plans.delete(page);throw error;}
    },
    prepareRegions(page,count,regions){preparation.set(page,[count,regions]);},
    async releasePage(page) {
      await pageOperations.get(page)?.catch(()=>{});
      prepared.delete(page);preparation.delete(page);pageImages.delete(page);
      if(pageWorkers.has(page))await call('release',page,[page]);
    },
    renderRegions,
    render:(page,operationSignal)=>single(page,[0,0,1,1],operationSignal,'page'),
    renderRegion:(page,bounds,operationSignal,kind)=>single(page,bounds,operationSignal,kind),
    async close() {
      if(closed)return;closed=true;
      await Promise.allSettled([...pageOperations.values(),...inFlight]);
      await Promise.allSettled([...used].map(index=>pool.run(index,{method:'close',documentId})));
      plans.clear();pageImages.clear();
    },
  };
}

module.exports={PdfPool,getPdfPool,prewarmPdf,closePdfPool,openPreparedPdf};
