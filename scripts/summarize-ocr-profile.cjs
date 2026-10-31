const fs=require('node:fs');
const path=require('node:path');
const report=JSON.parse(fs.readFileSync(process.argv[2]||'.cache/ocr-bottleneck-latest.json'));
const dir=path.join(report.root,'trace');
const events=fs.readdirSync(dir).flatMap(file=>JSON.parse(fs.readFileSync(path.join(dir,file))));
const sum=list=>list.reduce((n,e)=>n+e.end-e.start,0);
const summaries=report.results.map(row=>{
  const selected=events.filter(e=>e.run===row.label),byName=name=>selected.filter(e=>e.name===name);
  const rpcs=byName('rpc-roundtrip');let queueMs=0,transportMs=0,workerMs=0;
  const details=rpcs.map(rpc=>{
    const local=selected.filter(e=>e.thread===rpc.workerThread&&e.rpc===rpc.rpc),received=local.find(e=>e.name==='rpc-received'),reply=local.find(e=>e.name==='rpc-reply');
    const spans=local.filter(e=>!e.name.startsWith('rpc-'));
    if(!received||!reply||!spans.length)return {...rpc};
    const began=Math.min(...spans.map(e=>e.start)),queue=began-received.start,work=reply.start-began,transport=rpc.end-rpc.start-(reply.start-received.start);
    queueMs+=queue;workerMs+=work;transportMs+=transport;
    return {method:rpc.method,page:rpc.page,thread:rpc.workerThread,start:received.start,end:reply.start,queue,work,transport};
  });
  const native=byName('native-analysis');
  const geometryMs=native.reduce((n,e)=>{const ends=selected.filter(child=>child.rpc===e.rpc&&child.thread===e.thread&&['getTextContent','getOperatorList'].includes(child.name)).map(e=>e.end);return n+e.end-Math.max(e.start,...ends);},0);
  const pages=[...new Set(details.filter(e=>e.method==='crop').map(e=>e.page))].map(page=>{
    const crops=details.filter(e=>e.page===page&&e.method==='crop'),span=Math.max(...crops.map(e=>e.end))-Math.min(...crops.map(e=>e.start)),work=crops.reduce((n,e)=>n+(e.work||0),0),queue=crops.reduce((n,e)=>n+(e.queue||0),0);
    return {page,crops:crops.length,spanMs:span,workerMs:work,queueMs:queue,gapMs:span-work-queue};
  }).sort((a,b)=>b.spanMs-a.spanMs);
  const totals=Object.fromEntries(['document-open','getTextContent','getOperatorList','native-analysis','page-render','canvas-create','canvas-draw-image','png-encode','document-renderRegion','cache-writeInfo','cache-writeLayout','cache-writeImage'].map(name=>[name,{calls:byName(name).length,ms:sum(byName(name))}]));
  return {label:row.label,totalMs:row.totalMs,parseMs:row.parseMs,cropMs:row.cropMs,cpuMs:row.cpuMs,totals,geometryMs,rpc:{calls:rpcs.length,queueMs,workerMs,transportMs},slowestPages:pages.slice(0,6)};
});
fs.writeFileSync(path.join(report.root,'summary.json'),JSON.stringify({scope:'Summed concurrent spans overlap; do not add these times to wall time.',summaries},null,2));
console.log(JSON.stringify(summaries.filter(row=>row.label==='4 threads, disk cache writes, repeat 1'),null,2));
