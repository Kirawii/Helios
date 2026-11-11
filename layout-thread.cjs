const {parentPort}=require('node:worker_threads');
const fs=require('node:fs');
const crypto=require('node:crypto');
const ort=require('onnxruntime-node');
const {MODEL,modelPath,layoutProvider,decode}=require('./layout-contract.cjs');
let session,provider;
async function initialize() {
  if(session)return;
  const filename=modelPath();
  if(!fs.existsSync(filename))throw Error('本地版面模型尚未安装，请运行 npm run setup:layout');
  if(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex')!==MODEL.sha256)throw Error('版面模型 SHA-256 校验失败，请重新运行 npm run setup:layout');
  provider=layoutProvider();
  if(!['cpu','dml'].includes(provider))throw Error('HELIOS_LAYOUT_PROVIDER must be cpu or dml');
  session=await ort.InferenceSession.create(filename,{executionProviders:[provider],intraOpNumThreads:Math.max(1,Math.min(8,Number(process.env.HELIOS_LAYOUT_THREADS)||4)),interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',enableMemPattern:provider!=='dml'});
  if(session.inputNames.join(',')!=='pixel_values')throw Error('Layout input contract mismatch');
}
let queue=Promise.resolve();
parentPort.on('message',message=>{
  queue=queue.then(async()=>{
    try {
      await initialize();const started=performance.now();
      const pixels=message.pixels||new Float32Array(3*800*800);
      if(pixels.length!==3*800*800)throw Error('Layout tensor must be 1x3x800x800');
      // Fetch only three heads; mask tensors never cross the worker boundary.
      const outputs=await session.run({pixel_values:new ort.Tensor('float32',pixels,[1,3,800,800])},['logits','pred_boxes','order_logits']);
      const data={regions:decode(outputs),model:MODEL.name,modelSha256:MODEL.sha256,provider,inferenceMs:performance.now()-started};
      parentPort.postMessage({id:message.id,data});
    }catch(error){parentPort.postMessage({id:message.id,error:{message:error.message,name:error.name}});}
  });
});
