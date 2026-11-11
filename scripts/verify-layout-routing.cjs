const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {LayoutModel}=require('../layout-model.cjs');
const {ApiOcrWorker}=require('../ocr-api.cjs');
const {resolveOcrConfig}=require('../ocr-provider.cjs');
(async()=>{
  const fake=new EventEmitter(),sent=[];fake.ref=()=>{};fake.unref=()=>{};fake.postMessage=message=>sent.push(message);fake.terminate=async()=>{};
  const model=new LayoutModel({spawnWorker:()=>fake,maxQueued:1});
  const first=model.detect(null),controller=new AbortController(),queued=model.detect(null,controller.signal);
  await assert.rejects(model.detect(null),/队列已满/);controller.abort();await assert.rejects(queued,error=>error.name==='AbortError');
  fake.emit('message',{id:sent[0].id,data:{regions:[]}});await first;assert.equal(sent.length,1);await model.close();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-layout-routing-')),prompts=[];
  const blocks=['text','table','chart'].map((type,index)=>({id:'p1-b'+index,page:1,type,text:'',originalText:'',bbox:[.1,.1+index*.2,.9,.2+index*.2],source:'pdf-layout-model'}));
  const tasks=blocks.map(block=>({id:block.id+'-ocr',kind:block.type,blockId:block.id,bbox:block.bbox}));
  const worker=new ApiOcrWorker({openDocument:async()=>({pageCount:1,analyze:async()=>({page:1,width:600,height:800,blocks:structuredClone(blocks),tasks:structuredClone(tasks)}),renderRegions:async(page,tasks)=>tasks.map(task=>({width:20,height:20,png:Buffer.from(task.kind)})),close:async()=>{}}),fetchImpl:async(url,request)=>{
    const prompt=JSON.parse(request.body).messages[0].content[1].text;prompts.push(prompt);
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:prompt==='OCR:'?'Scanned paragraph.':prompt==='Table Recognition:'?'<table><tr><td>value</td></tr></table>':'Chart labels'} }]}));
  }});
  let page;
  try{const result=await worker.request({path:'mock.pdf',pageCount:1,pages:[1],outputDirectory:root,config:resolveOcrConfig({mode:'api',key:'SYNTHETIC-LAYOUT-KEY'})},event=>{if(event.event==='page')page=event.data;},new AbortController().signal);
    assert.equal(result.timing.failedRegions,0);assert.deepEqual(prompts.sort(),['Chart Recognition:','OCR:','Table Recognition:']);assert.equal(page.blocks[0].text,'Scanned paragraph.');assert.equal(page.blocks[1].format,'html');assert.equal(page.blocks[2].text,'Chart labels');
  }finally{worker.close();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-layout-routing-'))fs.rmSync(root,{recursive:true,force:true});}
  console.log('PASS: shared inference queue limit/cancellation, region OCR/table/chart prompts and result routing');
})().catch(error=>{console.error(error);process.exitCode=1;});
