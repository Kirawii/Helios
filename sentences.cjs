const {digest,mediaBlock,ignoredBlock,protectText}=require('./translation-model.cjs');
const PROFILE='sentence-ranges-v1';
const union=boxes=>[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))];

function formulaSpans(block,page){
  const text=block.originalText??block.text??'',spans=[];
  for(const task of page.tasks||[])if(task.kind==='formula'&&task.blockId===block.id&&task.end>task.start)spans.push({start:task.start,end:task.end,bbox:task.bbox,kind:'formula'});
  for(const line of block.lines||[]){
    const runs=line.runs||[],math=runs.filter(r=>r.mathFont);
    // Preserve neighboring operators printed in a roman math font with the native math run.
    // This expands text protection only; it does not propose regions or issue OCR requests.
    for(const run of math){
      let start=run.start,end=run.end,boxes=[run.bbox];
      for(const other of runs){
        if(!/^(?:.*\+)?CMR\d/i.test(other.fontFamily||'')||!/^[\s\d=+−\-×÷*/^_()[\]{},.:;]+$/.test(text.slice(other.start,other.end)))continue;
        if(other.end<=start&&/^[\s=+−\-×÷*/^_()[\]{},.:;]*$/.test(text.slice(other.end,start))&&start-other.end<4){start=other.start;boxes.push(other.bbox);}
        if(other.start>=end&&/^[\s=+−\-×÷*/^_()[\]{},.:;]*$/.test(text.slice(end,other.start))&&other.start-end<4){end=other.end;boxes.push(other.bbox);}
      }
      spans.push({start,end,bbox:union(boxes),kind:'formula'});
    }
  }
  for(const match of text.matchAll(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)/g))spans.push({start:match.index,end:match.index+match[0].length,kind:'formula'});
  const merged=[];
  for(const span of spans.sort((a,b)=>a.start-b.start||b.end-a.end)){
    if(span.start<0||span.end>text.length||span.end<=span.start)continue;
    const last=merged.at(-1);
    if(last&&span.start<=last.end){last.end=Math.max(last.end,span.end);if(last.bbox&&span.bbox)last.bbox=union([last.bbox,span.bbox]);}
    else merged.push({...span});
  }
  return merged.map(span=>{const replacement=block.mathReplacements?.find(r=>r.start===span.start&&r.end===span.end);return replacement?{...span,latex:replacement.latex}:span;});
}

function boundaries(text,spans=[]){
  const masked=Array(text.length).fill(false);
  for(const span of spans)for(let i=span.start;i<span.end;i++)masked[i]=true;
  for(const match of text.matchAll(/https?:\/\/[^\s]+|\[[\d,;–—\-\s]+\]/g))for(let i=match.index;i<match.index+match[0].length;i++)masked[i]=true;
  const cuts=[];
  for(let i=0;i<text.length;i++){
    if(masked[i]||!/[.!?。！？]/.test(text[i]))continue;
    if(text[i]==='.'){
      if(/\d/.test(text[i-1]||'')&&/\d/.test(text[i+1]||''))continue;
      if(text[i+1]==='.'||text[i-1]==='.')continue;
      if(/[A-Za-z]/.test(text[i+1]||''))continue;
      const prefix=text.slice(0,i+1);
      if(/(?:\b(?:Dr|Mr|Mrs|Ms|Prof|Fig|Figs|Eq|Eqs|Sec|Secs|Vol|No|vs|approx|al)|\be\.g|\bi\.e|\bcf)\.$/i.test(prefix))continue;
      if(/(?:^|\s)[A-Z]\.$/.test(prefix)&&/^[\s]+[A-Z]/.test(text.slice(i+1)))continue;
    }
    let end=i+1;while(/["'”’）)\]]/.test(text[end]||'')&&end<text.length)end++;
    if(end===text.length||/\s/.test(text[end])||/[。！？]/.test(text[i]))cuts.push(end);
  }
  return cuts;
}

// Only identical marginal lines repeated on several pages are excluded. Originals stay in pages.
function repeatedMargins(pages){
  const seen=new Map();
  for(const page of pages)for(const block of page.blocks)for(const line of block.lines||[]){
    const text=line.text?.trim();if(!text||text.length>160||!(line.bbox[3]<.12||line.bbox[1]>.82))continue;
    if(!seen.has(text))seen.set(text,new Set());seen.get(text).add(page.page);
  }
  return new Set([...seen].filter(([,ps])=>ps.size>=Math.max(3,Math.ceil(pages.length*.5))).map(([text])=>text));
}

function buildSentences(pages,{pdfHash='',profile=PROFILE}={}){
  const sentences=[],excluded=[],warnings=[],margins=repeatedMargins(pages);
  let text='',segments=[],formulas=[];
  function emit(end,complete){
    let start=0;while(start<end&&/\s/.test(text[start]))start++;while(end>start&&/\s/.test(text[end-1]))end--;
    if(end<=start)return;
    const ranges=segments.filter(s=>s.end>start&&s.start<end).map(s=>{
      const a=Math.max(start,s.start),b=Math.min(end,s.end),from=s.offset+a-s.start,to=s.offset+b-s.start;
      const runs=(s.block.lines||[]).flatMap(l=>l.runs||[]).filter(r=>r.end>from&&r.start<to);
      const rects=runs.length?runs.map(r=>r.bbox):[s.block.bbox];
      return {page:s.page,blockId:s.block.id,start:from,end:to,sentenceStart:a-start,sentenceEnd:b-start,rects,bbox:union(rects),granularity:runs.length?'run':'block'};
    });
    const original=text.slice(start,end),spans=formulas.filter(f=>f.start>=start&&f.end<=end).map(f=>({...f,start:f.start-start,end:f.end-start}));
    const id='s-'+digest([pdfHash,profile,ranges.map(({rects,bbox,granularity,...r})=>r),original]).slice(0,24);
    sentences.push({id,text:original,sourceRanges:ranges,formulas:spans,page:ranges[0].page,complete});
  }
  function flush(all=false){
    const cuts=boundaries(text,formulas);let consumed=0;
    for(const absolute of cuts){const cut=absolute-consumed;emit(cut,true);text=text.slice(cut);segments=segments.map(s=>({...s,start:s.start-cut,end:s.end-cut})).filter(s=>s.end>0);formulas=formulas.map(f=>({...f,start:f.start-cut,end:f.end-cut})).filter(f=>f.end>0);consumed=absolute;}
    if(all&&text.trim()){emit(text.length,false);text='';segments=[];formulas=[];}
  }
  let previousPage,previousBlock;
  for(const page of [...pages].sort((a,b)=>a.page-b.page)){
    if(previousPage!==undefined&&page.page!==previousPage+1){flush(true);warnings.push({page:page.page,text:'输入缺页，不跨越缺失页拼接句子'});}
    previousPage=page.page;
    if(page.warning)warnings.push({page:page.page,text:page.warning});
    for(const block of page.blocks){
      if(ignoredBlock(block)||mediaBlock(block))continue;
      const raw=block.originalText??block.text??'';if(!raw.trim())continue;
      const isolated=block.type!=='text'&&block.type!=='reference_content';if(isolated)flush(true);
      const omit=(block.lines||[]).filter(l=>margins.has(l.text?.trim())).map(l=>({start:l.start,end:l.end}));
      for(const range of omit)excluded.push({page:page.page,blockId:block.id,...range,reason:'repeated-margin',text:raw.slice(range.start,range.end)});
      const included=[];let from=0;for(const range of omit.sort((a,b)=>a.start-b.start)){if(range.start>from)included.push([from,range.start]);from=range.end;}if(from<raw.length)included.push([from,raw.length]);
      const spans=formulaSpans(block,page);
      // A new model paragraph starting with a capital is not automatically a continuation.
      // Cross-column/page continuations remain joinable when the geometry confirms that transition.
      if(text.trim()&&previousBlock&&/^\s*[A-Z]/.test(raw)){
        const p=previousBlock,b=block,transition=(p.page+1===page.page&&p.bbox[3]>.6&&b.bbox[1]<.4)||(p.page===page.page&&p.bbox[1]>.5&&b.bbox[1]<.5&&b.bbox[0]>p.bbox[0]+.2);
        if(!transition)flush(true);
      }
      for(const [start,end] of included){
        if(text&&!/\s$/.test(text))text+=' ';
        const offset=text.length;const value=raw.slice(start,end).replace(/\n/g,' ');text+=value;
        segments.push({start:offset,end:offset+value.length,offset:start,page:page.page,block});
        formulas.push(...spans.filter(f=>f.start>=start&&f.end<=end).map(f=>({...f,page:page.page,blockId:block.id,start:offset+f.start-start,end:offset+f.end-start})));
        flush();
      }
      if(isolated)flush(true);
      if(included.length)previousBlock={...block,page:page.page};
    }
  }
  flush(true);
  return {sentences,excluded,warnings,profile};
}

function protectSentence(sentence){
  const tokens=[];let text='',position=0;
  function plain(value){const p=protectText(value);text+=p.text.replace(/⟪KEEP_(\d+)⟫/g,(_,index)=>{const token=p.tokens[Number(index)],placeholder=`⟪KEEP_${tokens.length}⟫`;tokens.push({...token,placeholder});return placeholder;});}
  for(const span of sentence.formulas){plain(sentence.text.slice(position,span.start));const placeholder=`⟪KEEP_${tokens.length}⟫`;tokens.push({placeholder,original:sentence.text.slice(span.start,span.end),kind:'formula',source:span});text+=placeholder;position=span.end;}
  plain(sentence.text.slice(position));return {id:sentence.id,original:sentence.text,text,tokens};
}
function translationParts(text,unit){
  const tokens=new Map(unit.tokens.map(t=>[t.placeholder,t])),parts=[];let offset=0;
  const plain=text=>{if(!text)return;if(parts.at(-1)?.kind==='text')parts.at(-1).text+=text;else parts.push({kind:'text',text});};
  for(const match of text.matchAll(/⟪KEEP_\d+⟫/g)){
    plain(text.slice(offset,match.index));const token=tokens.get(match[0]);
    if(!token)throw Error('未知的保护标记');
    if(token.kind==='formula')parts.push({kind:'formula',text:token.original,source:token.source});else plain(token.original);
    offset=match.index+match[0].length;
  }
  plain(text.slice(offset));return parts;
}
module.exports={PROFILE,buildSentences,boundaries,formulaSpans,protectSentence,translationParts};
