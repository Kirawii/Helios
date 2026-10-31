class WorkQueue {
  constructor({maxItems=Infinity,maxBytes=Infinity,priority=()=>0}={}) {
    this.items=[];this.bytes=0;this.maxItems=maxItems;this.maxBytes=maxBytes;this.priority=priority;
    this.waiters=new Set();this.closed=false;this.error=null;this.peakItems=0;this.peakBytes=0;
  }
  wake(){for(const resolve of [...this.waiters])resolve();}
  async wait(signal) {
    signal.throwIfAborted();
    await new Promise((resolve,reject)=>{
      const cleanup=()=>{this.waiters.delete(done);signal.removeEventListener('abort',abort);};
      const done=()=>{cleanup();resolve();},abort=()=>{cleanup();reject(signal.reason);};
      this.waiters.add(done);signal.addEventListener('abort',abort,{once:true});
    });
  }
  async push(value,weight,signal) {
    weight=Math.max(0,weight||0);
    while(true) {
      signal.throwIfAborted();if(this.error)throw this.error;if(this.closed)throw Error('Work queue is closed');
      // A single oversized image is allowed alone; never deadlock waiting for
      // an image to fit without changing its resolution or formula pixels.
      if((this.items.length<this.maxItems&&this.bytes+weight<=this.maxBytes)||!this.items.length) {
        this.items.push({value,weight});this.bytes+=weight;
        this.peakItems=Math.max(this.peakItems,this.items.length);this.peakBytes=Math.max(this.peakBytes,this.bytes);
        this.wake();return;
      }
      await this.wait(signal);
    }
  }
  async take(signal) {
    while(true) {
      signal.throwIfAborted();if(this.error)throw this.error;
      if(this.items.length) {
        let index=0;for(let n=1;n<this.items.length;n++)if(this.priority(this.items[n].value)>this.priority(this.items[index].value))index=n;
        const [entry]=this.items.splice(index,1);this.bytes-=entry.weight;this.wake();return entry.value;
      }
      if(this.closed)return;
      await this.wait(signal);
    }
  }
  close(){this.closed=true;this.wake();}
  fail(error){this.error=error;this.items=[];this.bytes=0;this.wake();}
}
module.exports={WorkQueue};
