const fs=require('node:fs');
const fsp=require('node:fs/promises');
const https=require('node:https');
const path=require('node:path');
const crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {HttpsProxyAgent}=require('https-proxy-agent');
const {MODEL,modelPath}=require('../layout-contract.cjs');
async function download(url,filename,redirects=0){
  if(redirects>8)throw Error('Too many model download redirects');
  const parsed=new URL(url);if(parsed.protocol!=='https:')throw Error('Model downloads require HTTPS');
  const proxy=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
  const response=await new Promise((resolve,reject)=>{const request=https.get(parsed,{agent:proxy?new HttpsProxyAgent(proxy):undefined},resolve);request.setTimeout(120000,()=>request.destroy(Error('Model download timeout')));request.on('error',reject);});
  if([301,302,303,307,308].includes(response.statusCode)){response.resume();return download(new URL(response.headers.location,url).href,filename,redirects+1);}
  if(response.statusCode!==200){response.resume();throw Error('Model download HTTP '+response.statusCode);}
  await pipeline(response,fs.createWriteStream(filename));
}
async function hash(filename){const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(filename))digest.update(chunk);return digest.digest('hex');}
(async()=>{
  const provider=process.argv.find(arg=>arg.startsWith('--provider='))?.split('=')[1];if(provider)process.env.HELIOS_LAYOUT_PROVIDER=provider;
  const filename=modelPath();await fsp.mkdir(path.dirname(filename),{recursive:true});
  if(!fs.existsSync(filename)||await hash(filename)!==MODEL.sha256){
    const temporary=filename+'.'+crypto.randomUUID()+'.part';
    try{console.log('Downloading '+MODEL.name+' ('+MODEL.bytes+' bytes)');await download('https://huggingface.co/'+MODEL.repository+'/resolve/'+MODEL.revision+'/'+MODEL.filename,temporary);if(await hash(temporary)!==MODEL.sha256)throw Error('Model SHA-256 mismatch');await fsp.rename(temporary,filename);}
    finally{await fsp.rm(temporary,{force:true});}
  }
  const {LayoutModel}=require('../layout-model.cjs'),model=new LayoutModel();
  try{const ready=await model.warmup();await fsp.writeFile(path.join(__dirname,'../.cache/layout-runtime.json'),JSON.stringify({modelSha256:MODEL.sha256,provider:ready.provider,verifiedAt:new Date().toISOString()}));console.log('Layout ready: '+ready.model+' / '+ready.provider+'; SHA-256 verified; warm inference '+Math.round(ready.inferenceMs)+' ms');}
  finally{await model.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
