const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {setTimeout: delay} = require('node:timers/promises');
const {ApiOcrWorker, openPdf} = require('../ocr-api.cjs');
const {OcrProvider, resolveOcrConfig} = require('../ocr-provider.cjs');
const {createTranslationService} = require('../translation.cjs');
const {analyzeNativePage, visualRegions} = require('../pdf-native.cjs');
const {testPdf} = require('./test-pdf.cjs');

const signal = new AbortController().signal;
const config = resolveOcrConfig({mode:'api', key:'TEST-ONLY-HYBRID-KEY', concurrency:2});
const response = text => new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:text}}]}));
const formulaPlan = page => ({page,width:600,height:800,nativeCharacters:80,parseMs:1,sourceKind:'pdf-native',
  blocks:[{id:`p${page}-b0`,page,type:'text',text:'Before x+1 after.',originalText:'Before x+1 after.',bbox:[.1,.1,.8,.2],regions:[[.1,.1,.8,.2]],format:'text'}],
  tasks:[{id:`p${page}-m0`,kind:'formula',bbox:[.2,.1,.3,.2],blockId:`p${page}-b0`,start:7,end:10}]});

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-hybrid-test-'));
  const filename=path.join(root,'paper.pdf');fs.writeFileSync(filename,testPdf());
  let document,service;
  try {
    // Real PDF: extract native text with geometry; zero API calls, even without a key.
    let calls=0;
    const nativeWorker=new ApiOcrWorker({fetchImpl:async()=>{calls++;throw Error('Unexpected paid request');}});
    const native=[];
    const metrics=await nativeWorker.request({path:filename,pageCount:2,pages:[1,2],outputDirectory:path.join(root,'native'),config:{...config,key:''}},event=>{if(event.event==='page')native.push(event.data);},signal);
    assert.equal(calls,0);assert.equal(native.length,2);assert.ok(native.every(page=>page.complete&&page.blocks[0].positionGranularity==='line'));
    assert.match(native.find(page=>page.page===1).blocks[0].text,/Two distinct representations/);
    assert.equal(metrics.timing.totalRegions,0);
    document=await openPdf(filename);
    const full=await document.render(1,signal);
    document.prepareRegions(1,2);
    const crop=await document.renderRegion(1,[0,0,.5,.5],signal);
    assert.equal(crop.width,Math.ceil(full.width/2));assert.equal(crop.height,Math.ceil(full.height/2));
    document.releasePage(1);await document.close();document=null;

    // Text-only Forms must never swallow native body text as an image candidate.
    const OPS={save:1,restore:2,transform:3,paintFormXObjectBegin:4,paintFormXObjectEnd:5,paintImageXObject:6,constructPath:7};
    const viewport={transform:[1,0,0,1,0,0],width:100,height:100};
    assert.equal(visualRegions({fnArray:[4,5],argsArray:[[[1,0,0,1,0,0],[10,10,50,50]],[]]},OPS,viewport).length,0);
    const nested=visualRegions({fnArray:[1,3,4,3,6,5,2],argsArray:[[],[2,0,0,2,10,20],[[1,0,0,1,0,0],[0,0,20,20]],[5,0,0,5,0,0],[],[],[]]},OPS,viewport);
    assert.deepEqual(nested[0].bbox,[.1,.2,.5,.6]);

    // Source offsets refer to the preserved native text, not generated LaTeX.
    const fakePage={pageNumber:1,commonObjs:{get:name=>({name:name==='m'?'CMMI10':'Helvetica'})},getViewport:()=>({...viewport,scale:1}),
      getTextContent:async()=>({styles:{},items:[{str:'Native text before ',fontName:'t',width:55,transform:[5,0,0,5,0,50]},{str:'xy',fontName:'m',width:7,transform:[5,0,0,5,55,50]},{str:' after native text.',fontName:'t',width:35,transform:[5,0,0,5,62,50]}]}),
      getOperatorList:async()=>({fnArray:[],argsArray:[]})};
    const detected=await analyzeNativePage(fakePage,OPS,signal);
    assert.equal(detected.tasks.length,1);
    const task=detected.tasks[0],block=detected.blocks.find(block=>block.id===task.blockId);
    assert.equal(block.originalText.slice(task.start,task.end),'xy');

    const bridged=await analyzeNativePage({...fakePage,getTextContent:async()=>({styles:{},items:[
      {str:'Native prose before ',fontName:'t',width:20,transform:[5,0,0,5,0,50]},
      {str:'D',fontName:'m',width:5,transform:[5,0,0,5,20,50]},
      {str:'n,...',fontName:'m',width:25,transform:[3,0,0,3,25,52]},
      {str:'}',fontName:'m',width:4,transform:[5,0,0,5,50,50]},
      {str:'. Each document has more prose.',fontName:'t',width:44,transform:[5,0,0,5,54,50]}
    ]})},OPS,signal);
    assert.equal(bridged.tasks.length,1);
    const range=bridged.tasks[0],nativeBlock=bridged.blocks.find(block=>block.id===range.blockId);
    assert.match(nativeBlock.originalText.slice(range.start,range.end),/^Dn,\.\.\.\}$/);
    assert.match(nativeBlock.originalText.slice(range.end),/Each document/);

    let active=0,peak=0,failPage=2,closes=0;
    const requests=[],renders=[];
    const fixture=()=>({pageCount:2,analyze:async page=>formulaPlan(page),regionIdentity:(page,bounds)=>JSON.stringify([page,bounds]),
      render:async()=>{throw Error('Native text pages must not use full-page OCR');},
      renderRegion:async(page,bbox)=>{renders.push({page,bbox});return {width:40,height:20,png:Buffer.from('REGION-'+page)};},
      close:async()=>{closes++;}});
    const worker=new ApiOcrWorker({openDocument:async()=>fixture(),fetchImpl:async(url,request)=>{
      const input=JSON.parse(request.body),parts=input.messages[0].content;
      assert.equal(parts[1].text,'Formula Recognition:');
      const page=Number(Buffer.from(parts[0].image_url.url.split(',')[1],'base64').toString().split('-')[1]);
      requests.push(page);active++;peak=Math.max(peak,active);await delay(page===1?35:10);active--;
      if(page===failPage)return new Response('rate limited',{status:429});
      return response('\\[x_{'+page+'}+1\\]');
    }});
    service=createTranslationService({root,getPaper:id=>({id,pages:2}),worker:new OcrProvider({local:{close(){}},api:worker}),requestJSON:async()=>{throw Error('Incomplete OCR must never start translation');}});
    service.recognize('paper',{ocr:config});await service.wait('paper');
    let state=service.view('paper');
    assert.equal(state.status,'partial');assert.equal(state.pages[0].complete,true);assert.equal(state.pages[1].complete,false);
    assert.equal(state.pages[1].recognition.failed,1);assert.match(state.pages[1].regions[0].error,/429/);
    assert.equal(state.pages[0].blocks[0].text,'Before $x_{1}+1$ after.');
    const {recognitionMarkdown}=await import('../public/recognition-content.mjs');
    assert.match(recognitionMarkdown(state),/尚未全部识别完成/);
    assert.equal(peak,2);assert.equal(state.progress.done,1);assert.equal(state.ocrTiming.apiRequests,2);
    assert.ok(renders.every(value=>value.bbox[2]<1));
    assert.ok(!fs.readFileSync(path.join(root,'translations/paper/state.json'),'utf8').includes(config.key));
    failPage=0;
    service.recognize('paper',{ocr:config});await service.wait('paper');state=service.view('paper');
    assert.equal(state.status,'recognized',state.error);assert.deepEqual(requests,[1,2,2]);
    const before=requests.length;
    const rendersBefore=renders.length;
    // Cache may be reused without credentials, while incomplete pages still need a key.
    const cached=[];
    const result=await worker.request({path:filename,pageCount:2,pages:[1,2],outputDirectory:path.join(root,'translations/paper',state.assetDirectory),config:{...config,key:''}},event=>{if(event.event==='page')cached.push(event.data);},signal);
    assert.equal(requests.length,before);assert.equal(cached.length,2);assert.equal(result.timing.cacheHits,2);
    assert.equal(renders.length,rendersBefore,'OCR result cache must be checked before any crop is rendered');
    assert.equal(result.timing.renderSkipped,2);

    let laterPageReady=false,startedEarly=false;
    const pipelineWorker=new ApiOcrWorker({openDocument:async()=>({...fixture(),analyze:async page=>{
      if(page===2){await delay(100);laterPageReady=true;}return formulaPlan(page);
    }}),fetchImpl:async()=>{if(!laterPageReady)startedEarly=true;return response('x+1');}});
    await pipelineWorker.request({path:filename,pageCount:2,pages:[1,2],outputDirectory:path.join(root,'pipeline'),config},()=>{},signal);
    assert.equal(startedEarly,true,'Cloud inference must overlap parsing later pages');
    assert.throws(()=>resolveOcrConfig({...config,concurrency:0}),/并发/);

    // Hold HTTP responses: local preparation/release must finish independently.
    let unblock,prepared,heldCalls=0,localRenders=0,releases=0;
    const gate=new Promise(resolve=>{unblock=resolve;}),localDone=new Promise(resolve=>{prepared=resolve;});
    const independentWorker=new ApiOcrWorker({openDocument:async()=>({...fixture(),pageCount:6,
      renderRegion:async page=>{localRenders++;return {width:40,height:20,png:Buffer.from('INDEPENDENT-'+page)};},
      releasePage:async()=>{releases++;}
    }),fetchImpl:async()=>{heldCalls++;await gate;return response('x+1');}});
    const independent=independentWorker.request({path:filename,pageCount:6,pages:[1,2,3,4,5,6],outputDirectory:path.join(root,'independent'),config},event=>{if(event.step==='preparation-done')prepared(event.timing);},signal);
    let deadline;
    try {
      const localTiming=await Promise.race([localDone,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error('HTTP blocked local preparation')),3000);})]);
      assert.equal(localRenders,6);assert.equal(releases,6);assert.equal(heldCalls,2);
      assert.equal(localTiming.preparedRegions,6);assert.ok(localTiming.preparationMs>=0);
      assert.ok(localTiming.buffer.peakItems<=128);
    }finally{clearTimeout(deadline);unblock();await independent;}

    // A batch failure is isolated; retry uses early cache for the successful crop.
    let batchFailure=true;const batchSizes=[],batchPages=[];
    const batchWorker=new ApiOcrWorker({openDocument:async()=>({...fixture(),pageCount:1,
      analyze:async()=>{const plan=formulaPlan(1);plan.blocks.push({...plan.blocks[0],id:'p1-b1'});plan.tasks.push({...plan.tasks[0],id:'p1-m1',blockId:'p1-b1',bbox:[.3,.2,.4,.3]});return plan;},
      renderRegions:async(page,tasks)=>{batchSizes.push(tasks.length);return tasks.map(task=>batchFailure&&task.id==='p1-m1'?{error:{message:'isolated crop error'}}:{width:40,height:20,png:Buffer.from(task.id)});}
    }),fetchImpl:async()=>response('x+1')});
    const batchPayload={path:filename,pageCount:1,pages:[1],outputDirectory:path.join(root,'batch'),config};
    let batchResult=await batchWorker.request(batchPayload,event=>{if(event.event==='draft'||event.event==='page')batchPages.push(event.data);},signal);
    assert.equal(batchResult.timing.failedRegions,1);assert.equal(batchResult.timing.completedRegions,1);
    assert.equal(batchPages.at(-1).complete,false);
    batchFailure=false;batchResult=await batchWorker.request(batchPayload,()=>{},signal);
    assert.deepEqual(batchSizes,[2,1]);assert.equal(batchResult.timing.renderSkipped,1);assert.equal(batchResult.timing.completedRegions,2);

    // Scan-only page fallback is explicit; failures never produce a complete event.
    const scanWorker=new ApiOcrWorker({openDocument:async()=>({pageCount:1,analyze:async()=>({page:1,width:600,height:800,blocks:[],tasks:[{id:'scan',kind:'page',bbox:[0,0,1,1]}],scanFallback:true}),render:async()=>({width:600,height:800,png:Buffer.from('SCAN')}),close:async()=>{}}),fetchImpl:async(url,request)=>{
      assert.equal(JSON.parse(request.body).messages[0].content[1].text,'OCR:');return response('Scanned content.');
    }});
    let scan;
    await scanWorker.request({path:filename,pageCount:1,pages:[1],outputDirectory:path.join(root,'scan'),config},event=>{if(event.event==='page')scan=event.data;},signal);
    assert.equal(scan.complete,true);assert.equal(scan.positionGranularity,'page');assert.equal(scan.sourceImage,'page-1.png');

    const imageWorker=new ApiOcrWorker({openDocument:async()=>({pageCount:1,analyze:async()=>({page:1,width:600,height:800,sourceKind:'pdf-native',blocks:[{id:'p1-b0',page:1,order:1,type:'image',text:'',bbox:[.1,.1,.5,.5]}],tasks:[{id:'figure',kind:'image',blockId:'p1-b0',bbox:[.1,.1,.5,.5]}]}),renderRegion:async()=>({width:40,height:40,png:Buffer.from('FIGURE')}),close:async()=>{}}),fetchImpl:async(url,request)=>{
      assert.equal(JSON.parse(request.body).messages[0].content[1].text,'OCR:');return response('Recognized figure labels.');
    }});
    let figure;
    await imageWorker.request({path:filename,pageCount:1,pages:[1],outputDirectory:path.join(root,'image'),config},event=>{if(event.event==='page')figure=event.data;},signal);
    assert.equal(figure.blocks[0].text,'');assert.equal(figure.blocks[0].ocrText,'Recognized figure labels.');
    assert.match(recognitionMarkdown({pages:[figure]}),/Recognized figure labels/);

    const controller=new AbortController(),events=[];
    const cancelledWorker=new ApiOcrWorker({openDocument:async()=>fixture(),fetchImpl:async(url,request)=>{
      await delay(5000,null,{signal:request.signal});return response('unused');
    }});
    const cancelled=cancelledWorker.request({path:filename,pageCount:2,pages:[1,2],outputDirectory:path.join(root,'cancel'),config},event=>{events.push(event);if(event.step==='requesting')setTimeout(()=>controller.abort(),5);},controller.signal);
    await assert.rejects(cancelled,error=>error.name==='AbortError');assert.equal(events.filter(event=>event.event==='page').length,0);
    assert.ok(closes>=3);
    console.log('PASS: native PDF text/coordinates, ROI rendering, formula offsets/prompts, cross-page bounded concurrency, partial failure/resume, credential-free cache, explicit scan fallback, cancellation, no key persistence');
  } finally {await document?.close();await service?.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
