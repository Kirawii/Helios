const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),https=require('node:https'),crypto=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {HttpsProxyAgent}=require('https-proxy-agent');
const base=path.join(__dirname,'..'),directory=path.join(base,'benchmarks/layout-v1');
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));
async function download(url,filename,redirects=0){
  if(redirects>5)throw Error('Too many PDF redirects');
  const parsed=new URL(url);if(parsed.protocol!=='https:')throw Error('PDF download requires HTTPS');
  const proxy=process.env.HTTPS_PROXY||process.env.https_proxy||process.env.HTTP_PROXY||process.env.http_proxy;
  const response=await new Promise((resolve,reject)=>{const request=https.get(parsed,{agent:proxy?new HttpsProxyAgent(proxy):undefined,headers:{'User-Agent':'Helios-Layout-Benchmark/1.0 (local research evaluation)'}},resolve);request.setTimeout(45000,()=>request.destroy(Error('PDF download timeout')));request.on('error',reject);});
  if([301,302,303,307,308].includes(response.statusCode)){response.resume();return download(new URL(response.headers.location,url).href,filename,redirects+1);}
  if(response.statusCode!==200){response.resume();throw Error('PDF download HTTP '+response.statusCode);}
  let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>50*1024*1024)response.destroy(Error('PDF exceeds 50 MiB'));});
  await pipeline(response,fs.createWriteStream(filename));
}
async function main(){
  const lockPath=path.join(directory,'sources.lock.json'),previous=fs.existsSync(lockPath)?JSON.parse(fs.readFileSync(lockPath)):null,entries=[];
  for(const paper of manifest.papers){
    const relative=paper.localPath||`.cache/layout-benchmark/pdfs/${paper.id}-${paper.arxiv}.pdf`,filename=path.join(base,relative);
    if(!fs.existsSync(filename)){
      if(!paper.url)throw Error('Missing local development PDF: '+relative);
      await fsp.mkdir(path.dirname(filename),{recursive:true});const temporary=filename+'.part';
      try{await download(paper.url,temporary);if(fs.readFileSync(temporary).subarray(0,5).toString()!=='%PDF-')throw Error('Downloaded file is not a PDF');await fsp.rename(temporary,filename);}finally{await fsp.rm(temporary,{force:true});}
    }
    const bytes=fs.readFileSync(filename),sha256=crypto.createHash('sha256').update(bytes).digest('hex');
    const pinned=previous?.papers.find(p=>p.id===paper.id);if(pinned&&pinned.sha256!==sha256)throw Error('Pinned source hash mismatch: '+paper.id);
    entries.push({id:paper.id,path:relative,sha256,bytes:bytes.length,source:paper.source||'existing local library; not redistributed',pages:paper.pages});console.log('Verified '+paper.id+' '+sha256.slice(0,12));
  }
  const manifestSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'manifest.json'))).digest('hex');
  if(previous&&previous.manifestSha256!==manifestSha256)throw Error('Frozen manifest changed; create a new benchmark version');
  fs.writeFileSync(lockPath,JSON.stringify({version:1,manifestSha256,papers:entries},null,2)+'\n');
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={download};
