const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
require('../load-env.cjs')();
const {digest}=require('../translation-model.cjs');
const {MODEL,modelPath,layoutProvider,decode}=require('../layout-contract.cjs');
const {openPdf}=require('../pdf-document.cjs');
const {buildModelPlan}=require('../pdf-layout-model.cjs');
const metrics=require('../benchmarks/layout-v1/metrics.cjs');
const base=path.join(__dirname,'..'),spec=path.join(base,'benchmarks/layout-v1'),output=path.join(base,'output/layout-benchmark/v1'),prepared=path.join(base,'.cache/layout-benchmark/prepared');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8')),write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');};
const manifest=read(path.join(spec,'manifest.json'));
const quantile=(values,q)=>{if(!values.length)return null;const v=[...values].sort((a,b)=>a-b);return v[Math.max(0,Math.ceil(q*v.length)-1)];};
function sources(){
  const lock=read(path.join(spec,'sources.lock.json'));
  if(lock.manifestSha256!==digest(fs.readFileSync(path.join(spec,'manifest.json'))))throw Error('Manifest differs from frozen source lock');
  for(const paper of lock.papers)if(digest(fs.readFileSync(path.join(base,paper.path)))!==paper.sha256)throw Error('Source PDF hash changed: '+paper.id);
  return lock;
}
async function prepare(){
  const lock=sources(),rows=[],signal=new AbortController().signal;
  for(const paper of manifest.papers){
    const source=lock.papers.find(p=>p.id===paper.id);let document;
    try{document=await openPdf(path.join(base,source.path));
      for(const page of paper.pages){
        if(page<1||page>document.pageCount)throw Error('Page outside PDF: '+paper.id+'/'+page);
        const key=paper.id+'-p'+page,started=performance.now(),input=await document.layoutInput(page,signal),prepareMs=performance.now()-started,image=await document.render(page,signal);
        fs.mkdirSync(prepared,{recursive:true});fs.mkdirSync(path.join(output,'pages'),{recursive:true});
        fs.writeFileSync(path.join(prepared,key+'.f32'),Buffer.from(input.pixels.buffer,input.pixels.byteOffset,input.pixels.byteLength));delete input.pixels;
        write(path.join(prepared,key+'.json'),input);fs.writeFileSync(path.join(output,'pages',key+'.png'),image.png);
        const row={key,paperId:paper.id,page,split:paper.split,sourceSha256:source.sha256,imageSha256:digest(image.png),imageWidth:image.width,imageHeight:image.height,prepareMs};rows.push(row);console.log('Prepared '+key);await document.releasePage(page);
      }
    }finally{await document?.close();}
  }
  const metadata={createdAt:new Date().toISOString(),manifestSha256:lock.manifestSha256,preparationProfile:digest(['pdf-document.cjs','pdf-layout-model.cjs','layout-preprocess.cjs','pdf-native.cjs'].map(f=>fs.readFileSync(path.join(base,f),'utf8'))),pages:rows};
  write(path.join(output,'preparation.json'),metadata);return metadata;
}
function variantRegions(outputs,variant){
  const low=Math.min(variant.threshold,...Object.values(variant.classThresholds||{}));
  return decode(outputs,{threshold:low}).filter(r=>r.score>=(variant.classThresholds?.[r.classId]??variant.threshold));
}
async function run(preparation){
  const ort=require('onnxruntime-node'),provider=layoutProvider(),repeats=3;
  const began=performance.now();if(digest(fs.readFileSync(modelPath()))!==MODEL.sha256)throw Error('Model hash mismatch');const hashMs=performance.now()-began;
  const started=performance.now(),session=await ort.InferenceSession.create(modelPath(),{executionProviders:[provider],intraOpNumThreads:4,interOpNumThreads:1,executionMode:'sequential',graphOptimizationLevel:'all',enableMemPattern:provider!=='dml'}),createMs=performance.now()-started;
  const infer=pixels=>session.run({pixel_values:new ort.Tensor('float32',pixels,[1,3,800,800])},['logits','pred_boxes','order_logits']);
  const pages=[];let warmupMs;
  try{
    const t=performance.now();await infer(new Float32Array(3*800*800));warmupMs=performance.now()-t;
    for(const row of preparation.pages){
      const bytes=fs.readFileSync(path.join(prepared,row.key+'.f32')),pixels=new Float32Array(bytes.buffer,bytes.byteOffset,bytes.byteLength/4),input=read(path.join(prepared,row.key+'.json')),times=[];let outputs;
      for(let repeat=0;repeat<repeats;repeat++){const t=performance.now();outputs=await infer(pixels);times.push(performance.now()-t);}
      const variants={};
      for(const variant of manifest.variants){const t=performance.now(),regions=variantRegions(outputs,variant),plan=buildModelPlan(input,regions),retained=plan.blocks.flatMap(b=>b.lines.flatMap(l=>l.runs)).map(r=>r.id).sort((a,b)=>a-b),expected=input.runs.map(r=>r.id).sort((a,b)=>a-b);
        variants[variant.id]={regions,blocks:plan.blocks.map(({lines,originalText,text,regions,...b})=>b),tasks:plan.tasks,layout:plan.layout,warning:plan.warning||null,postprocessMs:performance.now()-t,nativeRunsRetainedOnce:JSON.stringify(retained)===JSON.stringify(expected)};
      }
      pages.push({...row,inferenceMs:times,variants});console.log('Inferred '+row.key);
    }
  }finally{await session.release();}
  const result={createdAt:new Date().toISOString(),manifestSha256:preparation.manifestSha256,model:MODEL,provider,repeats,hashMs,createMs,warmupMs,preparationProfile:preparation.preparationProfile,codeProfile:digest(['layout-contract.cjs','pdf-layout-model.cjs','benchmarks/layout-v1/metrics.cjs','scripts/benchmark-layout.cjs'].map(f=>fs.readFileSync(path.join(base,f),'utf8'))),runtime:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,onnxruntime:require('onnxruntime-node/package.json').version,canvas:require('@napi-rs/canvas/package.json').version},pages,realCloudRequests:0};
  write(path.join(output,'predictions.json'),result);return result;
}
function evaluate(result){
  const lock=sources();if(result.manifestSha256!==lock.manifestSha256)throw Error('Prediction manifest mismatch');
  const annotationPath=path.join(spec,'annotations.json'),annotation=fs.existsSync(annotationPath)?read(annotationPath):{version:1,pages:[]};
  const pages=result.pages.map(page=>{
    const a=annotation.pages.find(a=>a.key===page.key);if(a){metrics.validateAnnotation(a);if(a.status==='complete'&&a.sourceSha256!==page.sourceSha256)throw Error('Annotation source mismatch: '+page.key);}
    const variants={};for(const variant of manifest.variants){const p=page.variants[variant.id],plan={blocks:p.blocks};const scores=a?Object.fromEntries([.3,.5,.75].map(t=>[t,metrics.scoreFormulas(a,p.regions,t)])):null;
      const formulaTasks=p.tasks.filter(t=>t.kind==='formula'),unresolved=p.blocks.filter(b=>b.alignment==='unresolved');
      const inline=p.regions.filter(r=>r.classId===15),aligned=p.layout.coverage.inlineAligned;
      const matches=scores?.[.5]?.inline_formula?.matches||[],alignedTruePositive=matches.filter(m=>{const region=inline.find(r=>r.id===m.predId);return formulaTasks.some(t=>t.end>t.start&&metrics.iou(t.bbox,region.bbox)>.95&&!p.blocks.find(b=>b.id===t.blockId)?.alignment);}).length;
      variants[variant.id]={scores,order:a?metrics.readingOrder(a,plan):null,formulaTasks:formulaTasks.length,inlineDetections:inline.length,inlineAligned:aligned,inlineUnresolved:unresolved.length,alignedTruePositive,matchedTruePositive:matches.length,nativeRunsRetainedOnce:p.nativeRunsRetainedOnce,unassignedCharacters:p.layout.coverage.unassignedCharacters,postprocessMs:p.postprocessMs};
    }
    return {key:page.key,paperId:page.paperId,page:page.page,split:page.split,annotationStatus:a?.status||'pending',groundTruthFormulas:a?.status==='complete'?a.formulas.length:null,prepareMs:page.prepareMs,inferenceMs:page.inferenceMs,variants};
  });
  const groups={};
  for(const split of ['development','holdout','all'])for(const variant of manifest.variants){
    const eligible=pages.filter(p=>(split==='all'||p.split===split)&&p.annotationStatus==='complete'),byPaper=[...new Set(eligible.map(p=>p.paperId))].map(id=>metrics.sumScores(eligible.filter(p=>p.paperId===id).map(p=>p.variants[variant.id].scores[.5])));
    const micro=Object.fromEntries([.3,.5,.75].map(t=>[t,metrics.sumScores(eligible.map(p=>p.variants[variant.id].scores[t]))]));
    const macro=Object.fromEntries(metrics.CLASSES.map(label=>[label,Object.fromEntries(['precision','recall','f1'].map(k=>{const xs=byPaper.map(p=>p[label][k]).filter(v=>v!==null);return [k,{value:xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null,papersWithDefinedMetric:xs.length}];}))]));
    groups[split]||={};groups[split][variant.id]={annotatedPages:eligible.length,annotatedPapers:byPaper.length,micro,macro,order:eligible.map(p=>p.variants[variant.id].order).filter(Boolean),negativePageFalsePositives:eligible.filter(p=>p.groundTruthFormulas===0).reduce((n,p)=>n+metrics.CLASSES.reduce((n,c)=>n+p.variants[variant.id].scores[.5][c].fp,0),0)};
  }
  const times=result.pages.flatMap(p=>p.inferenceMs),report={createdAt:new Date().toISOString(),annotationVersion:annotation.version,reference:annotation.reference||'pending',annotationSha256:fs.existsSync(annotationPath)?digest(fs.readFileSync(annotationPath)):null,predictionsSha256:digest(fs.readFileSync(path.join(output,'predictions.json'))),model:result.model,provider:result.provider,runtime:result.runtime,manifestSha256:result.manifestSha256,papers:manifest.papers.length,pages:pages.length,annotatedPages:pages.filter(p=>p.annotationStatus==='complete').length,metricsScope:'formula detection only; silver single-reviewer reference; no cloud OCR/transcription/translation accuracy',timing:{repeats:result.repeats,hashMs:result.hashMs,createMs:result.createMs,warmupMs:result.warmupMs,warmInferenceP50Ms:quantile(times,.5),warmInferenceP95Ms:quantile(times,.95),preparationP50Ms:quantile(pages.map(p=>p.prepareMs),.5),preparationP95Ms:quantile(pages.map(p=>p.prepareMs),.95)},groups,pageResults:pages,realCloudRequests:0};
  write(path.join(output,'report.json'),report);return report;
}
function markdown(report){
  const pct=v=>v===null?'N/A':(v*100).toFixed(1)+'%',lines=['# Helios layout mini benchmark v1','',`实际运行：${report.papers} 篇 / ${report.pages} 页；完整人工参考：${report.annotatedPages} 页。${report.reference}。`,`模型：${MODEL.name} / ${report.provider}；真实云端请求：0。`,'','质量仅评价正文公式定位；不等于所有布局类别、LaTeX 或译文准确率。','', '| 分组 | 配置 | 类别 | TP | FP | FN | P | R | F1 |','| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for(const split of ['development','holdout'])for(const variant of manifest.variants)for(const label of metrics.CLASSES){const r=report.groups[split][variant.id].micro[.5][label];lines.push(`| ${split} | ${variant.id} | ${label} | ${r.tp} | ${r.fp} | ${r.fn} | ${pct(r.precision)} | ${pct(r.recall)} | ${pct(r.f1)} |`);}
  lines.push('','IoU≥0.5，类别一致，一对一最大数量匹配。完整的 IoU 0.3/0.75、逐页错误 ID、按论文 macro、对齐及阅读顺序在 report.json。','',`热推理 p50/p95：${report.timing.warmInferenceP50Ms.toFixed(1)} / ${report.timing.warmInferenceP95Ms.toFixed(1)} ms；每页重复 ${report.timing.repeats} 次，共享同一次推理输出比较阈值。`,`准备 p50/p95：${report.timing.preparationP50Ms.toFixed(1)} / ${report.timing.preparationP95Ms.toFixed(1)} ms；不含云端识别、全文并发或端到端两秒承诺。`,'','参考标注为单人视觉 silver reference；需要独立复核。线上阈值未修改。');
  fs.writeFileSync(path.join(output,'REPORT.md'),lines.join('\n')+'\n');
}
async function main(){
  if(process.argv.includes('--prepare')){await prepare();return;}
  let result;
  if(process.argv.includes('--evaluate'))result=read(path.join(output,'predictions.json'));
  else{const p=process.argv.includes('--reuse-inputs')?read(path.join(output,'preparation.json')):await prepare();result=await run(p);}
  const report=evaluate(result);markdown(report);console.log(`Report: ${output} (${report.annotatedPages}/${report.pages} pages annotated)`);
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={variantRegions,quantile};
