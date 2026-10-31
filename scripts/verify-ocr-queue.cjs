const assert=require('node:assert/strict');
const {WorkQueue}=require('../ocr-work-queue.cjs');
const {PdfPool}=require('../pdf-pool.cjs');

(async()=>{
  const signal=new AbortController().signal;
  const queue=new WorkQueue({maxItems:2,maxBytes:10,priority:item=>item.cost});
  await queue.push({cost:1},4,signal);await queue.push({cost:8},5,signal);
  let pushed=false;
  const blocked=queue.push({cost:3},6,signal).then(()=>{pushed=true;});
  await Promise.resolve();assert.equal(pushed,false);
  assert.equal((await queue.take(signal)).cost,8);await blocked;
  assert.equal(queue.bytes,10);assert.equal(queue.peakItems,2);assert.equal(queue.peakBytes,10);
  assert.equal((await queue.take(signal)).cost,3);assert.equal((await queue.take(signal)).cost,1);
  // Preserve a large input without deadlocking or allowing other items beside it.
  await queue.push({cost:20},20,signal);
  const controller=new AbortController(),cancelled=queue.push({cost:2},1,controller.signal);controller.abort();
  await assert.rejects(cancelled,error=>error.name==='AbortError');assert.equal(queue.waiters.size,0);
  assert.equal((await queue.take(signal)).cost,20);
  const consumer=new AbortController(),waiting=queue.take(consumer.signal);consumer.abort();
  await assert.rejects(waiting,error=>error.name==='AbortError');assert.equal(queue.waiters.size,0);
  const done=queue.take(signal);queue.close();assert.equal(await done,undefined);
  const failed=new WorkQueue(),failure=Error('pipeline failure'),wake=failed.take(signal);failed.fail(failure);
  await assert.rejects(wake,error=>error===failure);
  // RPCs wait in the main process, so queued analysis can overtake rendering.
  const pool=new PdfPool({size:1}),order=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  pool.slot=()=>({ready:Promise.resolve()});
  pool.send=async(slot,message)=>{order.push(message.method);if(message.method==='open')await gate;return {data:message.method,threadId:1};};
  const opening=pool.run(0,{method:'open'},signal),crop=pool.run(0,{method:'cropBatch'},signal),analysis=pool.run(0,{method:'analyze'},signal);
  const queuedController=new AbortController(),queued=pool.run(0,{method:'analyze'},queuedController.signal);queuedController.abort();
  await assert.rejects(queued,error=>error.name==='AbortError');release();await Promise.all([opening,crop,analysis]);
  assert.deepEqual(order,['open','analyze','cropBatch']);assert.equal(pool.loads[0],0);await pool.close();
  console.log('PASS: priority scheduling, item/byte backpressure, oversized input, cancellation, close/failure wakeups');
})().catch(error=>{console.error(error);process.exitCode=1;});
