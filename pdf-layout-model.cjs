const {LABELS}=require('./layout-contract.cjs');
const union=boxes=>[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];
const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const intersection=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
const inside=(a,b,tolerance=0)=>b[0]>=a[0]-tolerance&&b[1]>=a[1]-tolerance&&b[2]<=a[2]+tolerance&&b[3]<=a[3]+tolerance;
const media=label=>/^(image|chart|table|seal|algorithm|display_formula)$/.test(label);
const ignored=label=>/^(header|footer|header_image|footer_image|number|aside_text|vertical_text|formula_number)$/.test(label);
const prose=label=>!media(label)&&!ignored(label)&&label!=='inline_formula';

async function extractRuns(page,signal){
  signal.throwIfAborted();const [content]=await Promise.all([page.getTextContent(),page.getOperatorList()]),viewport=page.getViewport({scale:1});
  const {multiply}=require('./pdf-native.cjs'),runs=[];
  for(const item of content.items){
    if(!item.str?.trim()||!item.transform)continue;
    const m=multiply(viewport.transform,item.transform),height=Math.max(1,Math.hypot(m[2],m[3])),angle=Math.atan2(m[1],m[0]);
    const width=Math.max(.5,item.width*viewport.scale),ascent=content.styles[item.fontName]?.ascent??.85;
    const points=[0,1].flatMap(end=>[-.2,ascent].map(rise=>[m[4]+end*Math.cos(angle)*width+rise*Math.sin(angle)*height,m[5]+end*Math.sin(angle)*width-rise*Math.cos(angle)*height]));
    const bbox=[Math.min(...points.map(p=>p[0]))/viewport.width,Math.min(...points.map(p=>p[1]))/viewport.height,Math.max(...points.map(p=>p[0]))/viewport.width,Math.max(...points.map(p=>p[1]))/viewport.height].map(v=>Math.max(0,Math.min(1,v)));
    let family='';try{family=page.commonObjs.get(item.fontName)?.name||'';}catch{}
    // Font metadata protects native math during translation; it never creates an OCR region.
    const mathFont=/(?:CMMI|CMSY|CMEX|MSAM|MSBM|STIX.*Math|CambriaMath|MathItalic|SymbolMT)/i.test(family);
    if(area(bbox))runs.push({id:runs.length,text:item.str,bbox,baseline:m[5]/viewport.height,height:height/viewport.height,font:item.fontName,fontFamily:family,mathFont});
  }
  signal.throwIfAborted();return {page:page.pageNumber,width:viewport.width,height:viewport.height,runs};
}

function compose(runs){
  const rows=[];
  for(const run of [...runs].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0])){
    let row=rows.findLast(row=>Math.abs(row.baseline-run.baseline)<Math.max(row.height,run.height)*.55);
    if(!row){row={runs:[],height:run.height,baseline:run.baseline,bbox:run.bbox};rows.push(row);}
    row.runs.push(run);row.bbox=union(row.runs.map(r=>r.bbox));if(run.height>row.height)row.baseline=run.baseline;row.height=Math.max(row.height,run.height);
  }
  rows.sort((a,b)=>a.bbox[1]-b.bbox[1]);let text='';const lines=[];
  for(const row of rows){
    row.runs.sort((a,b)=>a.bbox[0]-b.bbox[0]);
    if(text){if(/[A-Za-z]{2,}-$/.test(text)&&/^[a-z]/.test(row.runs[0].text)&&!row.runs.some(run=>run.inlineProtected)){text=text.slice(0,-1);const last=lines.at(-1);last.end--;last.runs.at(-1).end--;}else text+='\n';}
    const start=text.length;let previous;
    const mapped=[];
    for(const run of row.runs){if(previous&&run.bbox[0]-previous.bbox[2]>.001&&!/\s$/.test(text)&&!/^\s/.test(run.text))text+=' ';const offset=text.length;text+=run.text;mapped.push({...run,start:offset,end:text.length});previous=run;}
    lines.push({text:text.slice(start),bbox:row.bbox,start,end:text.length,runs:mapped});
  }
  return {originalText:text,text,lines,regions:lines.map(line=>line.bbox)};
}

function buildModelPlan(input,detected){
  const warnings=[],regions=[];
  // Remove near-identical same-class detections, never union adjacent boxes or
  // remove an inline formula nested in a paragraph.
  for(const region of [...detected].sort((a,b)=>b.score-a.score)){
    if(!Number.isInteger(region.classId)||!LABELS[region.classId]||!Number.isFinite(region.score)||!Array.isArray(region.bbox)||region.bbox.length!==4||!region.bbox.every(v=>Number.isFinite(v)&&v>=0&&v<=1)||!area(region.bbox)||!Number.isFinite(region.order))throw Error('Invalid layout region');
    if(regions.some(other=>other.classId===region.classId&&intersection(other.bbox,region.bbox)/(area(other.bbox)+area(region.bbox)-intersection(other.bbox,region.bbox))>.95))continue;
    regions.push({...region,label:LABELS[region.classId],runs:[]});
  }
  regions.sort((a,b)=>a.order-b.order||b.score-a.score);
  const characters=input.runs.reduce((n,run)=>n+run.text.length,0),bad=input.runs.reduce((n,run)=>n+(run.text.match(/[\uFFFD\u0000]/g)||[]).length,0);
  const usable=characters>=30&&bad/characters<.15,orphans=[];let assignedCharacters=0;
  for(const run of input.runs){
    const center=[(run.bbox[0]+run.bbox[2])/2,(run.bbox[1]+run.bbox[3])/2];
    const containers=regions.filter(r=>r.label!=='inline_formula'&&center[0]>=r.bbox[0]&&center[0]<=r.bbox[2]&&center[1]>=r.bbox[1]&&center[1]<=r.bbox[3]);
    containers.sort((a,b)=>intersection(b.bbox,run.bbox)/area(run.bbox)-intersection(a.bbox,run.bbox)/area(run.bbox)||Number(media(b.label))-Number(media(a.label))||area(a.bbox)-area(b.bbox));
    let chosen=containers[0];
    if(!chosen){
      const near=regions.filter(r=>prose(r.label)).map(r=>({r,distance:Math.hypot(Math.max(0,r.bbox[0]-run.bbox[2],run.bbox[0]-r.bbox[2])*input.width,Math.max(0,r.bbox[1]-run.bbox[3],run.bbox[1]-r.bbox[3])*input.height)})).sort((a,b)=>a.distance-b.distance);
      if(near[0]?.distance<=run.height*input.height)chosen=near[0].r;
    }
    if(chosen){chosen.runs.push(run);assignedCharacters+=run.text.length;}else orphans.push(run);
  }
  const blocks=[],tasks=[],inline=regions.filter(r=>r.label==='inline_formula');
  const add=(region,type,sourceRuns=region.runs)=>{
    const content=compose(sourceRuns),block={id:`p${input.page}-b${blocks.length}`,page:input.page,type,layoutLabel:region.label,layoutClassId:region.classId,layoutOrder:region.order,bbox:region.bbox,confidence:null,layoutConfidence:region.score,source:'pdf-layout-model',positionGranularity:'block',format:type==='formula'?'latex':'text',...content};
    if(media(region.label)){block.nativeText=content.text;if(type==='image'||type==='algorithm')block.text='';}
    blocks.push(block);return block;
  };
  for(const region of regions.filter(r=>r.label!=='inline_formula')){
    const label=region.label,type=label==='display_formula'?'formula':label==='chart'?'chart':label==='table'?'table':label==='image'||label==='seal'?'image':label==='algorithm'?'algorithm':ignored(label)?label:/^(doc_title|paragraph_title|figure_title)$/.test(label)?label:'text';
    const block=add(region,type);
    const kind=label==='display_formula'?'formula':label==='table'?'table':label==='chart'?'chart':/^(image|seal|algorithm)$/.test(label)?'image':!ignored(label)&&(!usable||!region.runs.length)?'text':null;
    if(kind)tasks.push({id:block.id+'-ocr',kind,blockId:block.id,bbox:region.bbox,...(kind==='formula'?{start:0,end:block.originalText.length}:{}),status:'pending'});
  }
  if(orphans.length){
    const rows=compose(orphans).lines;
    for(const row of rows)add({label:'unassigned_text',classId:null,score:null,bbox:row.bbox,order:regions.length?Math.max(...regions.map(r=>r.order))+1:0},'text',row.runs);
    warnings.push(`${orphans.reduce((n,r)=>n+r.text.length,0)} 个原生字符未匹配布局区域，已保留为独立文本块`);
  }
  let aligned=0,unresolved=0;
  for(const region of inline){
    const candidates=blocks.filter(b=>prose(b.layoutLabel)&&intersection(b.bbox,region.bbox)>0).sort((a,b)=>intersection(b.bbox,region.bbox)-intersection(a.bbox,region.bbox));
    const block=candidates[0],runs=block?.lines.flatMap(line=>line.runs)||[];
    const selected=runs.filter(run=>inside(region.bbox,run.bbox,.002));
    const crossed=runs.some(run=>intersection(run.bbox,region.bbox)/area(run.bbox)>.08&&!selected.includes(run));
    const start=selected.length?Math.min(...selected.map(r=>r.start)):0,end=selected.length?Math.max(...selected.map(r=>r.end)):0;
    const rangeCrossed=runs.some(run=>run.start<end&&run.end>start&&!selected.includes(run));
    const overlaps=tasks.some(t=>t.kind==='formula'&&t.blockId===block?.id&&start<t.end&&end>t.start);
    if(block&&selected.length&&!crossed&&!rangeCrossed&&!overlaps){tasks.push({id:block.id+'-inline-'+aligned,kind:'formula',bbox:region.bbox,blockId:block.id,start,end,status:'pending'});aligned++;}
    else {
      const detached=add(region,'formula',[]);detached.inlineAnchor=block?.id||null;detached.alignment='unresolved';
      tasks.push({id:detached.id+'-inline',kind:'formula',bbox:region.bbox,blockId:detached.id,start:0,end:0,status:'pending'});unresolved++;
    }
  }
  if(unresolved)warnings.push(`${unresolved} 处行内公式无法可靠映射原文范围，保留原文并单独展示识别结果`);
  if(!regions.length){warnings.push('模型未检测到版面区域');if(!usable)throw Error('版面模型未返回可识别区域，请检查页面或显式切换 heuristic 模式');}
  blocks.sort((a,b)=>a.layoutOrder-b.layoutOrder||a.bbox[1]-b.bbox[1]);
  const visible=blocks.filter(block=>!ignored(block.layoutLabel));
  const reversed=visible.some((block,index)=>visible.slice(index+1).some(next=>{
    const horizontal=Math.max(0,Math.min(block.bbox[2],next.bbox[2])-Math.max(block.bbox[0],next.bbox[0]));
    return horizontal>.5*Math.min(block.bbox[2]-block.bbox[0],next.bbox[2]-next.bbox[0])&&next.bbox[3]<block.bbox[1]-.003;
  }));
  let readingOrder='model';
  if(reversed){const {spatialOrder,detectGutter}=require('./pdf-native.cjs');const ordered=spatialOrder(blocks,detectGutter(input.runs));blocks.splice(0,blocks.length,...ordered);readingOrder='geometric-fallback';warnings.push('模型阅读顺序存在同栏上下倒置，已回退到几何阅读顺序');}
  blocks.forEach((block,index)=>{block.order=ignored(block.layoutLabel)?null:index+1;block.sourceOrder=block.order;});
  const coverage={nativeCharacters:characters,assignedCharacters,unassignedCharacters:characters-assignedCharacters,assignmentRatio:characters?assignedCharacters/characters:1,retainedCharacters:characters,inlineAligned:aligned,inlineUnresolved:unresolved};
  if(coverage.assignmentRatio<.95)warnings.push('原生文字布局匹配率低于 95%，请核对未匹配区域');
  return {page:input.page,width:input.width,height:input.height,blocks,tasks,nativeCharacters:characters,scanFallback:!usable,sourceKind:usable?'pdf-native':'layout-scan',positionGranularity:'block',layout:{engine:'PP-DocLayoutV3',readingOrder,coverage,regions:regions.map(({runs,...r})=>r)},...(warnings.length?{warning:warnings.join('；')}:{})};
}
module.exports={extractRuns,compose,buildModelPlan,intersection};
