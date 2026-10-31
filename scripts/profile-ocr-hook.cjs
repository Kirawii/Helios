// Diagnostic preload only. Run via --require; the application never imports it.
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const {AsyncLocalStorage}=require('node:async_hooks');
const threads=require('node:worker_threads');
const context=new AsyncLocalStorage(),events=[];
const now=()=>Number(process.hrtime.bigint())/1e6;
function record(name,start,details={}){events.push({name,start,end:now(),thread:threads.threadId,...context.getStore(),...details});}
function flush(){const dir=process.env.OCR_PREPARATION_TRACE_DIR;if(!dir)return;fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'thread-'+threads.threadId+'.json'),JSON.stringify(events));}
function timed(object,key,name,details=()=>({})) {
  const original=object[key];if(typeof original!=='function')return;
  object[key]=function(...args){const start=now(),extra=details.call(this,args);try{const value=original.apply(this,args);if(value?.then)return value.then(result=>{record(name,start,extra);return result;},error=>{record(name,start,{...extra,error:true});throw error;});record(name,start,extra);return value;}catch(error){record(name,start,{...extra,error:true});throw error;}};
}
if(threads.parentPort) {
  const on=threads.parentPort.on;
  threads.parentPort.on=function(event,listener){
    if(event!=='message')return on.call(this,event,listener);
    return on.call(this,event,message=>context.run({rpc:message.id,method:message.method,page:message.args?.[0],document:message.documentId,run:message.profileRun},()=>{
      if(!message.cancel)record('rpc-received',now());return listener(message);
    }));
  };
  const post=threads.parentPort.postMessage;
  threads.parentPort.postMessage=function(message,...rest){record('rpc-reply',now(),{rpc:message.id});const result=post.call(this,message,...rest);if(context.getStore()?.method==='close')flush();return result;};
}
const load=Module._load,patched=new WeakSet();
Module._load=function(request,parent,isMain){
  const value=load.apply(this,arguments);
  if(!value||typeof value!=='object'||patched.has(value))return value;
  if(request==='@napi-rs/canvas') {
    patched.add(value);const create=value.createCanvas;
    value.createCanvas=function(...args){
      const start=now(),canvas=create.apply(this,args);record('canvas-create',start,{width:args[0],height:args[1]});
      const prototype=Object.getPrototypeOf(canvas);
      if(!patched.has(prototype)){patched.add(prototype);timed(prototype,'toBuffer','png-encode',function(args){return {format:args[0],width:this.width,height:this.height};});}
      const ctxPrototype=Object.getPrototypeOf(canvas.getContext('2d'));
      if(!patched.has(ctxPrototype)){patched.add(ctxPrototype);timed(ctxPrototype,'drawImage','canvas-draw-image',args=>({sourceWidth:args[0]?.width,sourceHeight:args[0]?.height}));}
      return canvas;
    };
  }else if(request.endsWith('pdf-native.cjs')) {
    patched.add(value);const analyze=value.analyzeNativePage;
    value.analyzeNativePage=async function(page,...args){
      const start=now(),overrides={};
      if(!patched.has(page)) {
        patched.add(page);const render=page.render.bind(page);
        page.render=function(...params){const began=now(),task=render(...params);task.promise.then(()=>record('page-render',began),()=>record('page-render',began,{error:true}));return task;};
      }
      for(const method of ['getTextContent','getOperatorList']) {
        const fn=page[method].bind(page);
        overrides[method]=async(...params)=>{const t=now();try{return await fn(...params);}finally{record(method,t);}};
      }
      const proxy=new Proxy(page,{get:(target,key)=>key in overrides?overrides[key]:(typeof Reflect.get(target,key,target)==='function'?Reflect.get(target,key,target).bind(target):Reflect.get(target,key,target))});
      try{return await analyze(proxy,...args);}finally{record('native-analysis',start);}
    };
  }else if(request.endsWith('pdf-document.cjs')) {
    patched.add(value);const open=value.openPdf;
    value.openPdf=async(...args)=>{
      const start=now(),document=await open(...args);record('document-open',start);
      for(const key of ['analyze','renderRegion','render','prepareRegions','releasePage','close'])timed(document,key,'document-'+key,args=>({page:args[0]}));
      const close=document.close;document.close=async function(){try{return await close.call(this);}finally{flush();}};
      return document;
    };
    timed(value,'loadPdfEngine','engine-warm');
  }else if(request.endsWith('pdf-preparation-cache.cjs')) {
    patched.add(value);
    for(const key of ['readInfo','writeInfo','readLayout','writeLayout','readImage','writeImage','readPage','writePage'])timed(value.PreparationCache.prototype,key,'cache-'+key,args=>({page:args[0]}));
  }else if(request.endsWith('pdf-pool.cjs')) {
    patched.add(value);const send=value.PdfPool.prototype.send;
    value.PdfPool.prototype.send=function(slot,message,...rest){
      const start=now(),rpc=this.sequence+1;
      return send.call(this,slot,{...message,profileRun:context.getStore()?.run},...rest).then(result=>{record('rpc-roundtrip',start,{rpc,method:message.method,page:message.args?.[0],document:message.documentId,workerThread:result.threadId});return result;});
    };
  }
  return value;
};
process.on('exit',flush);

module.exports={events,now,flush,context};
