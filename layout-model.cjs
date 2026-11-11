const {Worker}=require('node:worker_threads');
const path=require('node:path');
class LayoutModel {
  constructor({maxQueued=4,spawnWorker=()=>new Worker(path.join(__dirname,'layout-thread.cjs'))}={}){this.spawnWorker=spawnWorker;this.maxQueued=maxQueued;this.sequence=0;this.waiting=[];this.active=null;this.worker=null;this.closed=false;}
  launch(){
    if(this.worker)return;
    const worker=this.spawnWorker();this.worker=worker;
    worker.on('message',message=>{
      const entry=this.active;if(!entry||entry.id!==message.id)return;
      this.active=null;entry.cleanup();
      if(message.error)entry.reject(Object.assign(Error(message.error.message),{name:message.error.name}));else entry.resolve(message.data);
      this.drain();if(!this.active)worker.unref();
    });
    const fail=error=>{this.worker=null;if(this.active){this.active.cleanup();this.active.reject(error);this.active=null;}for(const entry of this.waiting.splice(0)){entry.cleanup();entry.reject(error);}};
    worker.on('error',fail);worker.on('exit',code=>{if(!this.closed)fail(Error('Layout worker exited ('+code+')'));});worker.unref();
  }
  async detect(pixels,signal=new AbortController().signal){
    signal.throwIfAborted();if(this.closed)throw Error('Layout model is closed');
    if(this.waiting.length>=this.maxQueued)throw Error('本地版面检测队列已满，请稍后重试');
    this.launch();
    return new Promise((resolve,reject)=>{
      const entry={id:++this.sequence,pixels,resolve,reject};
      const abort=()=>{const index=this.waiting.indexOf(entry);if(index>=0)this.waiting.splice(index,1);entry.cleanup();reject(signal.reason);};
      entry.cleanup=()=>signal.removeEventListener('abort',abort);signal.addEventListener('abort',abort,{once:true});
      this.waiting.push(entry);this.drain();
    });
  }
  drain(){if(this.active||!this.waiting.length||!this.worker)return;const entry=this.waiting.shift();this.active=entry;this.worker.ref();this.worker.postMessage({id:entry.id,pixels:entry.pixels},entry.pixels?[entry.pixels.buffer]:[]);}
  warmup(signal){return this.detect(null,signal);}
  async close(){this.closed=true;const error=Error('Layout model closed');if(this.active){this.active.cleanup();this.active.reject(error);this.active=null;}for(const entry of this.waiting.splice(0)){entry.cleanup();entry.reject(error);}const worker=this.worker;this.worker=null;await worker?.terminate();}
}
let shared;
const getLayoutModel=()=>shared ||= new LayoutModel();
const closeLayoutModel=async()=>{const model=shared;shared=null;await model?.close();};
module.exports={LayoutModel,getLayoutModel,closeLayoutModel};
