// Geometry heuristics for the fast path. Original PDF text/coordinates are kept
// even when a formula/image candidate needs further recognition.
const IDENTITY = [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const point = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const union = boxes => [Math.min(...boxes.map(b=>b[0])), Math.min(...boxes.map(b=>b[1])), Math.max(...boxes.map(b=>b[2])), Math.max(...boxes.map(b=>b[3]))];
const area = b => Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const contains = (outer, inner) => inner[0]>=outer[0]-.002 && inner[1]>=outer[1]-.002 && inner[2]<=outer[2]+.002 && inner[3]<=outer[3]+.002;
const mathFont = name => /math|symbol|cmmi|cmsy|cmex|msam|msbm|stix|txmi|txsy|txex/i.test(name);

function normalizedBox(points, width, height) {
  const box = [Math.min(...points.map(p=>p[0]))/width, Math.min(...points.map(p=>p[1]))/height, Math.max(...points.map(p=>p[0]))/width, Math.max(...points.map(p=>p[1]))/height].map(v=>Math.max(0,Math.min(1,v)));
  return area(box)>0 ? box : null;
}

function visualRegions(operators, OPS, viewport) {
  let matrix = IDENTITY; const stack = [], forms = [], candidates = [];
  const add = (bounds, type, transform = matrix) => {
    const m = multiply(viewport.transform, transform);
    const box = normalizedBox([[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[3]]].map(([x,y])=>point(m,x,y)),viewport.width,viewport.height);
    if (box && area(box)>.00001) candidates.push({bbox:box,type});
  };
  for (let index=0;index<operators.fnArray.length;index++) {
    const op=operators.fnArray[index], args=operators.argsArray[index];
    if (op===OPS.save) stack.push(matrix);
    else if (op===OPS.restore) matrix=stack.pop()||IDENTITY;
    else if (op===OPS.transform && args?.length===6) matrix=multiply(matrix,args);
    else if (op===OPS.paintFormXObjectBegin) {
      forms.push({matrix,bounds:args?.[1],visual:false}); if(args?.[0]) matrix=multiply(matrix,args[0]);
      forms.at(-1).transform=matrix;
    } else if(op===OPS.paintFormXObjectEnd) {
      const form=forms.pop();
      if(form?.visual&&form.bounds?.length===4)add(form.bounds,'form',form.transform);
      matrix=form?.matrix||matrix;
    }
    else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op)) add([0,0,1,1],'image');
    else if(op===OPS.paintImageXObjectRepeat && args?.[3]) {
      for(let i=0;i<args[3].length;i+=2) add([0,0,1,1],'image',multiply(matrix,[args[1],0,0,args[2],args[3][i],args[3][i+1]]));
    }
    if([OPS.constructPath,OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat].includes(op))for(const form of forms)form.visual=true;
  }
  // Page-sized Forms are containers, not figure crops. Nested figure children
  // are represented by the outer figure once, so their text is not OCR'd twice.
  const figures=candidates.filter(r=>r.type==='form'&&area(r.bbox)<.65&&area(r.bbox)>.001);
  const unique=[];
  for(const candidate of [...figures,...candidates.filter(r=>r.type==='image')].sort((a,b)=>area(b.bbox)-area(a.bbox))) {
    if(!unique.some(existing=>contains(existing.bbox,candidate.bbox))) unique.push(candidate);
  }
  return unique;
}

function spatialOrder(blocks) {
  const topDown=(a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0];
  const left=blocks.filter(b=>b.bbox[2]<=.52&&b.bbox[2]-b.bbox[0]>.12);
  const right=blocks.filter(b=>b.bbox[0]>=.48&&b.bbox[2]-b.bbox[0]>.12);
  if(!left.some(a=>right.some(b=>Math.min(a.bbox[3],b.bbox[3])>Math.max(a.bbox[1],b.bbox[1]))))return [...blocks].sort(topDown);
  const spanning=blocks.filter(b=>b.bbox[0]<.48&&b.bbox[2]>.52).sort(topDown);
  const bands=Array.from({length:spanning.length+1},()=>[]), ids=new Set(spanning.map(b=>b.id));
  for(const block of blocks) {
    if(ids.has(block.id))continue;
    const center=(block.bbox[1]+block.bbox[3])/2;
    const band=spanning.findIndex(b=>center<(b.bbox[1]+b.bbox[3])/2);
    bands[band<0?spanning.length:band].push(block);
  }
  const column=b=>(b.bbox[0]+b.bbox[2])/2<.5?0:1;
  return bands.flatMap((band,index)=>[...band.sort((a,b)=>column(a)-column(b)||topDown(a,b)),...(spanning[index]?[spanning[index]]:[])]);
}

async function analyzeNativePage(page, OPS, signal) {
  signal.throwIfAborted();
  const started=performance.now();
  const [content,operators]=await Promise.all([page.getTextContent(),page.getOperatorList()]);
  signal.throwIfAborted();
  const viewport=page.getViewport({scale:1}), runs=[];
  const figures=visualRegions(operators,OPS,viewport);
  for(const item of content.items) {
    if(!item.str?.trim()||!item.transform)continue;
    const transform=multiply(viewport.transform,item.transform), h=Math.max(1,Math.hypot(transform[2],transform[3]));
    const angle=Math.atan2(transform[1],transform[0]), width=Math.max(.5,item.width*viewport.scale);
    const ascent=content.styles[item.fontName]?.ascent??.85;
    const baseline=[transform[4],transform[5]], advance=[Math.cos(angle)*width,Math.sin(angle)*width], up=[Math.sin(angle)*h,-Math.cos(angle)*h];
    const corners=[0,1].flatMap(end=>[-.2,ascent].map(rise=>[baseline[0]+end*advance[0]+rise*up[0],baseline[1]+end*advance[1]+rise*up[1]]));
    const bbox=normalizedBox(corners,viewport.width,viewport.height);if(!bbox)continue;
    let font='';try{font=page.commonObjs.get(item.fontName)?.name||'';}catch{}
    runs.push({text:item.str,bbox,font,math:mathFont(font),height:h/viewport.height,baseline:baseline[1]/viewport.height});
  }
  const characters=runs.reduce((n,r)=>n+r.text.length,0);
  const badCharacters=runs.reduce((n,r)=>n+(r.text.match(/[\uFFFD\u0000]/g)||[]).length,0);
  const hasDrawing=figures.length||operators.fnArray.some(op=>op===OPS.constructPath);
  const usable=characters>=30&&badCharacters/characters<.15;
  if(!usable) {
    return {page:page.pageNumber,width:viewport.width,height:viewport.height,blocks:[],tasks:hasDrawing||characters?[{id:`p${page.pageNumber}-scan`,kind:'page',bbox:[0,0,1,1]}]:[],nativeCharacters:characters,scanFallback:Boolean(hasDrawing||characters),parseMs:performance.now()-started};
  }
  const textRuns=runs.filter(run=>!figures.some(figure=>contains(figure.bbox,run.bbox)));
  const rows=[];
  for(const run of [...textRuns].sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0])) {
    let row=rows.findLast(row=>Math.abs(row.baseline-run.baseline)<Math.max(row.height,run.height)*.6&&Math.max(0,row.bbox[0]-run.bbox[2],run.bbox[0]-row.bbox[2])<Math.max(row.height,run.height)*2);
    if(!row){row={runs:[],bbox:run.bbox,height:run.height,baseline:run.baseline};rows.push(row);}
    row.runs.push(run);row.bbox=union(row.runs.map(r=>r.bbox));row.height=Math.max(row.height,run.height);
  }
  // Ascenders and subscripts arrive in different top-coordinate order. A late
  // glyph can bridge two row fragments; coalesce them before choosing formulas.
  for(let index=0;index<rows.length;index++) {
    const row=rows[index];let joined;
    do {
      joined=false;
      for(let other=index+1;other<rows.length;other++) {
        const next=rows[other],height=Math.max(row.height,next.height);
        if(Math.abs(row.baseline-next.baseline)>=height*.6||Math.max(0,row.bbox[0]-next.bbox[2],next.bbox[0]-row.bbox[2])>=height*2)continue;
        row.runs.push(...next.runs);row.bbox=union([row.bbox,next.bbox]);
        if(next.height>row.height)row.baseline=next.baseline;
        row.height=height;rows.splice(other,1);joined=true;break;
      }
    }while(joined);
  }
  rows.sort((a,b)=>a.bbox[1]-b.bbox[1]||a.bbox[0]-b.bbox[0]);
  // Weight by characters: hundreds of tiny math glyph runs must not make the
  // document's body font appear to be a superscript-sized font.
  const heights=textRuns.flatMap(r=>Array.from({length:Math.min(100,r.text.length)},()=>r.height)).sort((a,b)=>a-b), median=heights[Math.floor(heights.length/2)]||.015;
  const blocks=[],tasks=[];
  for(const row of rows) {
    row.runs.sort((a,b)=>a.bbox[0]-b.bbox[0]);let text='',previous=null;
    for(const run of row.runs){const gap=previous?run.bbox[0]-previous.bbox[2]:0;if(previous&&gap>row.height*.12&&!/\s$/.test(text)&&!/^\s/.test(run.text))text+=' ';run.start=text.length;text+=run.text;run.end=text.length;previous=run;}
    const heading=row.height>median*1.3&&text.length<180;
    const type=/^\d+$/.test(text.trim())&&(row.bbox[1]<.06||row.bbox[3]>.94)?'page_number':heading?(page.pageNumber===1&&row.bbox[1]<.25?'doc_title':'paragraph_title'):'text';
    let block=blocks.findLast(b=>b.type==='text'&&type==='text'&&Math.abs(b.bbox[0]-row.bbox[0])<.015&&row.bbox[1]-b.bbox[3]>=-.003&&row.bbox[1]-b.bbox[3]<median*.85&&b.originalText.length<1000&&Math.abs(b.fontHeight-row.height)<median*.25);
    if(!block){block={id:`p${page.pageNumber}-b${blocks.length}`,page:page.pageNumber,type,text:'',originalText:'',bbox:row.bbox,regions:[],lines:[],fontHeight:row.height,source:'pdf-text',format:'text',confidence:null,positionGranularity:'line'};blocks.push(block);}
    const prefix=block.originalText.length?block.originalText.length+1:0;
    block.originalText+=(prefix?'\n':'')+text;block.text=block.originalText;block.bbox=union([block.bbox,row.bbox]);block.regions.push(row.bbox);
    block.lines.push({text,bbox:row.bbox,start:prefix,end:prefix+text.length,runs:row.runs.map(run=>({text:run.text,bbox:run.bbox,start:prefix+run.start,end:prefix+run.end,math:run.math,font:run.font}))});
    let groups=[];
    for(let index=0;index<row.runs.length;index++) {
      if(!row.runs[index].math)continue;
      let last=index;
      while(last+1<row.runs.length&&(row.runs[last+1].math||/^[\d\s=+−\-*/()[\]{},.;:^_|]+$/.test(row.runs[last+1].text))&&row.runs[last+1].bbox[0]-row.runs[last].bbox[2]<row.height*1.5)last++;
      groups.push(row.runs.slice(index,last+1));index=last;
    }
    const mathCharacters=row.runs.filter(run=>run.math).reduce((n,run)=>n+run.text.length,0);
    if(groups.length&&mathCharacters/text.length>.25&&!row.runs.some(run=>!run.math&&/[A-Za-z]{3,}/.test(run.text)))groups=[row.runs];
    else {
      const merged=[];
      for(const group of groups){const previous=merged.at(-1),between=previous?text.slice(previous.at(-1).end,group[0].start):'';if(previous&&between.length<12&&!/[A-Za-z]{3,}|[.!?;]/.test(between))merged[merged.length-1]=row.runs.filter(run=>run.start>=previous[0].start&&run.end<=group.at(-1).end);else merged.push(group);}
      groups=merged;
    }
    for(const group of groups) {
      const original=text.slice(group[0].start,group.at(-1).end).trim();
      // Unicode numbers, comparison/table symbols and single variables already
      // have an exact text-layer representation; do not OCR them again.
      if(/^[\s\d.,;:+−\-×±†•=()[\]{}|%]+$/u.test(original)||/^[\p{L}\p{N}]$/u.test(original))continue;
      const bounds=union(group.map(run=>run.bbox));
      const padding=Math.min(.006,row.height*.25);
      const bbox=[Math.max(0,bounds[0]-padding),Math.max(0,bounds[1]-padding),Math.min(1,bounds[2]+padding),Math.min(1,bounds[3]+padding)];
      tasks.push({id:`${block.id}-m${tasks.length}`,kind:'formula',bbox,blockId:block.id,start:prefix+group[0].start,end:prefix+group.at(-1).end,status:'pending'});
    }
  }
  for(const figure of figures) {
    const id=`p${page.pageNumber}-b${blocks.length}`;
    blocks.push({id,page:page.pageNumber,type:'image',text:'',bbox:figure.bbox,source:'pdf-visual',format:'image',confidence:null,positionGranularity:'block',candidateKind:figure.type});
    tasks.push({id:id+'-ocr',kind:'image',bbox:figure.bbox,blockId:id,status:'pending'});
  }
  const ordered=spatialOrder(blocks).map((block,index)=>({...block,order:index+1,sourceOrder:index+1}));
  return {page:page.pageNumber,width:viewport.width,height:viewport.height,blocks:ordered,tasks,nativeCharacters:characters,scanFallback:false,parseMs:performance.now()-started,sourceKind:'pdf-native',positionGranularity:'line'};
}

module.exports={analyzeNativePage,visualRegions,spatialOrder,multiply};
