const {parentPort,threadId} = require('node:worker_threads');
const {openPdf,loadPdfEngine} = require('./pdf-document.cjs');
const documents=new Map(),controllers=new Map();
let queue=Promise.resolve();

async function execute({method,documentId,filename,args},signal) {
  if(method==='warm'){await loadPdfEngine();return {threadId};}
  if(method==='close') {
    const pending=documents.get(documentId);documents.delete(documentId);
    if(pending)await(await pending).close();return;
  }
  if(!documents.has(documentId))documents.set(documentId,openPdf(filename,{adaptive:true}));
  let document;
  try{document=await documents.get(documentId);}catch(error){documents.delete(documentId);throw error;}
  signal.throwIfAborted();
  if(method==='open')return {pageCount:document.pageCount};
  if(method==='analyze')return document.analyze(args[0],signal);
  if(method==='prepare')return document.prepareRegions(...args);
  if(method==='release')return document.releasePage(args[0]);
  if(method==='render')return document.render(args[0],signal);
  if(method==='crop')return document.renderRegion(args[0],args[1],signal,args[2]);
  if(method==='cropBatch') {
    const [page,preparation,tasks]=args;
    if(preparation)document.prepareRegions(page,...preparation);
    const images=[];
    for(const task of tasks) {
      signal.throwIfAborted();
      try{images.push(task.kind==='page'?await document.render(page,signal):await document.renderRegion(page,task.bbox,signal,task.kind));}
      catch(error){signal.throwIfAborted();images.push({error:{name:error.name,message:error.message}});}
    }
    return {images};
  }
  throw Error('Unknown PDF worker operation');
}

parentPort.on('message',message=>{
  if(message.cancel){controllers.get(message.cancel)?.abort();return;}
  const controller=new AbortController();controllers.set(message.id,controller);
  queue=queue.then(async()=>{
    try {
      controller.signal.throwIfAborted();
      const data=await execute(message,controller.signal);
      if(data?.images){const buffers=[];for(const image of data.images)if(image.png){image.png=Uint8Array.from(image.png);buffers.push(image.png.buffer);}parentPort.postMessage({id:message.id,data,threadId},buffers);}
      else if(data?.png){const png=Uint8Array.from(data.png);parentPort.postMessage({id:message.id,data:{...data,png},threadId},[png.buffer]);}
      else parentPort.postMessage({id:message.id,data,threadId});
    }catch(error){parentPort.postMessage({id:message.id,error:{name:error.name,message:error.message},threadId});}
    finally{controllers.delete(message.id);}
  });
});
