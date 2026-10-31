const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {PdfPool,openPreparedPdf}=require('../pdf-pool.cjs');
const {openPdf}=require('../pdf-document.cjs');
const {embeddedImage}=require('../pdf-embedded-image.cjs');
const {PreparationCache}=require('../pdf-preparation-cache.cjs');
const {createCanvas}=require('@napi-rs/canvas');
const {testPdf}=require('./test-pdf.cjs');

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-preparation-test-')),filename=path.join(root,'paper.pdf'),cacheDirectory=path.join(root,'cache');
  fs.writeFileSync(filename,testPdf());
  const pool=new PdfPool({size:2}),signal=new AbortController().signal;let original,prepared,cached,other;
  try {
    const warmed=await pool.prewarm();assert.equal(new Set(warmed.threadIds).size,2);
    original=await openPdf(filename);prepared=await openPreparedPdf(filename,{pool,cacheDirectory});
    const plans=await Promise.all([1,2].map(page=>prepared.analyze(page,signal)));
    assert.equal(prepared.stats().workerThreads.length,2,'Different pages must execute in different worker threads');
    for(const plan of plans){const baseline=await original.analyze(plan.page,signal);assert.deepEqual(plan.blocks,baseline.blocks);assert.deepEqual(plan.tasks,baseline.tasks);}
    const bounds=[.05,.05,.7,.3];
    const tasks=[{kind:'formula',bbox:bounds},{kind:'formula',bbox:[.1,.4,.7,.5]}];
    prepared.prepareRegions(1,2,tasks);original.prepareRegions(1,2);
    const old=await original.renderRegion(1,bounds,signal),oldSecond=await original.renderRegion(1,tasks[1].bbox,signal);
    const [fresh,freshSecond]=await prepared.renderRegions(1,tasks,signal);
    assert.deepEqual(fresh.png,old.png,'Formula pixels must not change');
    assert.deepEqual(freshSecond.png,oldSecond.png);assert.equal(prepared.stats().renderBatches,1);assert.equal(prepared.stats().cachePageWrites,1);
    await prepared.close();prepared=null;
    cached=await openPreparedPdf(filename,{pool,cacheDirectory});
    const reused=await cached.analyze(1,signal);reused.blocks[0].text='Mutated caller result';
    assert.notEqual((await cached.analyze(1,signal)).blocks[0].text,'Mutated caller result');
    const reusedImages=await cached.renderRegions(1,tasks,signal);
    assert.deepEqual(reusedImages[0].png,old.png);assert.deepEqual(reusedImages[1].png,oldSecond.png);
    assert.equal(cached.stats().analyses,0);assert.equal(cached.stats().renders,0);assert.deepEqual(cached.stats().workerThreads,[]);
    assert.equal(cached.stats().layoutCacheHits,1);assert.equal(cached.stats().cropCacheHits,2);
    const identity=cached.regionIdentity(1,bounds,'formula');
    await cached.close();cached=null;

    // Corrupted cache files must be regenerated, not silently treated as valid.
    function files(directory){return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?files(path.join(directory,entry.name)):[path.join(directory,entry.name)]);}
    const stored=files(cacheDirectory),layout=stored.find(file=>path.basename(file)==='layout-1.json'),pack=stored.find(file=>file.endsWith('.crops'));
    const bytes=fs.readFileSync(pack),headerLength=bytes.readUInt32BE(8);bytes[12+headerLength+24]^=255;
    fs.writeFileSync(layout,'{"broken":');fs.writeFileSync(pack,bytes);
    cached=await openPreparedPdf(filename,{pool,cacheDirectory});
    await cached.analyze(1,signal);cached.prepareRegions(1,2,tasks);
    const repaired=await cached.renderRegions(1,tasks,signal);
    assert.deepEqual(repaired.map(image=>image.png),[old.png,oldSecond.png]);
    assert.equal(cached.stats().analyses,1);assert.equal(cached.stats().renders,1);
    assert.equal(cached.stats().cropCacheHits,1,'Damage in one entry must preserve other cached crops');
    await cached.close();cached=null;

    // Legacy per-image files remain readable; packed entry checks isolate damage.
    const legacy=new PreparationCache(path.join(root,'legacy'),'pdf','profile');
    await legacy.writeImage(1,bounds,fresh,'formula');assert.equal(await legacy.hasLegacyImages(),true);
    assert.deepEqual((await legacy.readImage(1,bounds,'formula')).png,old.png);
    await legacy.writePage(1,new Map([['first',fresh],['second',freshSecond]]));
    assert.deepEqual([...(await legacy.readPage(1)).values()].map(image=>image.png),[old.png,oldSecond.png]);

    // File content, not pathname, controls invalidation.
    fs.writeFileSync(filename,Buffer.from(testPdf().toString().replace('Two distinct representations.','New distinct representations.')));
    cached=await openPreparedPdf(filename,{pool,cacheDirectory});
    assert.notEqual(cached.regionIdentity(1,bounds,'formula'),identity);
    await cached.analyze(1,signal);assert.equal(cached.stats().layoutCacheHits,0);
    other=await openPreparedPdf(filename,{pool,cacheDirectory:path.join(root,'other')});
    const controller=new AbortController(),cancelled=cached.analyze(2,controller.signal);controller.abort();
    await assert.rejects(cancelled,error=>error.name==='AbortError');
    assert.match((await other.analyze(2,signal)).blocks[0].text,/Evidence and methods/);

    // The conservative embedded-image path must reject later labels and graphics.
    const OPS={paintImageXObject:1,transform:2,save:3,restore:4,beginText:5,constructPath:6};
    let ops={fnArray:[2,1],argsArray:[[20,0,0,20,10,10],['image']]};
    const fakePage={getOperatorList:async()=>ops,getViewport:()=>({width:200,height:200,transform:[2,0,0,-2,0,200]}),objs:{has:()=>true,get:()=>({kind:2,width:2,height:2,data:Uint8Array.from([255,0,0,0,255,0,0,0,255,255,255,255])})}};
    const factory={create:(width,height)=>{const canvas=createCanvas(width,height);return {canvas,context:canvas.getContext('2d')};},destroy:value=>{value.canvas.width=0;value.canvas.height=0;}};
    const image=await embeddedImage(fakePage,{OPS,ImageKind:{RGB_24BPP:2}},[.1,.7,.3,.9],signal,factory);
    assert.equal(image.source,'embedded-image');assert.equal(image.width,2);
    ops={fnArray:[2,1,5],argsArray:[[20,0,0,20,10,10],['image'],[]]};
    assert.equal(await embeddedImage(fakePage,{OPS,ImageKind:{RGB_24BPP:2}},[.1,.7,.3,.9],signal,factory),undefined);
    console.log('PASS: real worker prewarm and page parallelism, byte-identical formula crops, durable layout/image caches, mutation isolation, corruption recovery, content invalidation, isolated cancellation, conservative embedded-image extraction');
  }finally{
    await Promise.allSettled([original?.close(),prepared?.close(),cached?.close(),other?.close()]);await pool.close();
    if(path.dirname(path.resolve(root))===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-preparation-test-'))fs.rmSync(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
