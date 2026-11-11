import * as pdfjs from '/pdfjs/pdf.mjs';
import katex from '/katex/katex.mjs';
import {stripMathDelimiters} from '/recognition-content.mjs';
pdfjs.GlobalWorkerOptions.workerSrc='/pdfjs/pdf.worker.mjs';
const $=s=>document.querySelector(s),original=$('#original'),target=$('.translated-pages'),select=$('#paper-select');
let state=null,paper=null,pdfTask=null,observer=null,generation=0,timer=null,polling=false,revision=-1,selectedId=null;
const pageEntries=new Map();
const fields={baseUrl:$('#base-url'),model:$('#model'),protocol:$('#protocol'),key:$('#key')};
try{const saved=JSON.parse(localStorage.getItem('moon-api')||'{}');for(const name of ['baseUrl','model','protocol'])if(saved[name])fields[name].value=saved[name];}catch{}
$('#model-settings').onsubmit=e=>e.preventDefault();
$('#model-settings').onchange=()=>{try{localStorage.setItem('moon-api',JSON.stringify(Object.fromEntries(['baseUrl','model','protocol'].map(k=>[k,fields[k].value]))));}catch{}};
async function api(url,body){const response=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const result=await response.json();if(!response.ok)throw Error(result.error||'请求失败');return result;}
function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,5000);}
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;}
function position(node,rect){Object.assign(node.style,{left:`${rect[0]*100}%`,top:`${rect[1]*100}%`,width:`${(rect[2]-rect[0])*100}%`,height:`${(rect[3]-rect[1])*100}%`});}
function formulaCrop(source,text){
  const holder=el('span','formula-crop',text);
  const latex=source?.latex||(/^(?:\$|\\\()/.test(text.trim())?stripMathDelimiters(text):null);
  if(latex){try{katex.render(latex,holder,{throwOnError:true,trust:false,maxExpand:1000});holder.title='原公式保留';return holder;}catch{}}
  if(!source?.bbox)return holder;
  holder.dataset.formulaPage=source.page;holder.dataset.formulaBox=JSON.stringify(source.bbox);holder.title='公式保留原页图像；点击整句可查看原文';
  const entry=pageEntries.get(source.page);if(entry?.painted)updateCrops(source.page);return holder;
}
function updateCrops(number){
  const originalCanvas=original.querySelector(`[data-page="${number}"]>canvas`);if(!originalCanvas)return;
  for(const node of target.querySelectorAll(`[data-formula-page="${number}"]`)){
    if(node.querySelector('canvas'))continue;const [x0,y0,x1,y1]=JSON.parse(node.dataset.formulaBox),canvas=el('canvas');
    const width=Math.max(1,(x1-x0)*originalCanvas.width),height=Math.max(1,(y1-y0)*originalCanvas.height);canvas.width=Math.ceil(width);canvas.height=Math.ceil(height);canvas.setAttribute('role','img');canvas.setAttribute('aria-label',node.textContent);
    canvas.getContext('2d').drawImage(originalCanvas,x0*originalCanvas.width,y0*originalCanvas.height,width,height,0,0,canvas.width,canvas.height);
    canvas.style.height=Math.min(node.classList.contains('display-media')?420:36,Math.max(16,height/(devicePixelRatio||1)))+'px';node.replaceChildren(canvas);
  }
}
const cropObserver=new IntersectionObserver(changes=>{for(const change of changes)if(change.isIntersecting){const node=change.target,entry=pageEntries.get(Number(node.dataset.formulaPage));if(entry)paint(entry,generation).then(()=>updateCrops(Number(node.dataset.formulaPage)));cropObserver.unobserve(node);}},{root:$('#translated'),rootMargin:'300px'});
function sourceHighlight(sentence){
  original.querySelectorAll('.source-focus').forEach(n=>n.remove());
  if(!sentence)return;
  for(const range of sentence.sourceRanges){const page=original.querySelector(`[data-page="${range.page}"]`);if(!page)continue;for(const rect of range.rects){const box=el('div','source-focus');position(box,rect);page.append(box);}}
}
function focusSentence(id,direction){
  const sentence=state?.sentences.find(s=>s.id===id);if(!sentence)return;
  selectedId=id;target.querySelectorAll('.sentence').forEach(n=>n.classList.toggle('active',n.dataset.sentenceId===id));sourceHighlight(sentence);
  if(direction==='target')target.querySelector(`[data-sentence-id="${id}"]`)?.scrollIntoView({block:'center'});
  else if(direction==='source'){
    const range=sentence.sourceRanges[0],page=original.querySelector(`[data-page="${range.page}"]`);if(page){original.scrollTop+=page.getBoundingClientRect().top-original.getBoundingClientRect().top+page.clientHeight*range.bbox[1]-60;if(innerWidth<=760)original.scrollIntoView({block:'start'});}
  }
}
function renderMarkers(){
  original.querySelectorAll('.sentence-marker').forEach(n=>n.remove());if(!state)return;
  const collisions=new Map();
  state.sentences.forEach((sentence,index)=>{
    const visited=new Set();for(const range of sentence.sourceRanges){
      if(visited.has(range.page))continue;visited.add(range.page);
      const page=original.querySelector(`[data-page="${range.page}"]`);if(!page)continue;
      const key=`${range.page}-${Math.round(range.bbox[1]*100)}`,slot=collisions.get(key)||0;collisions.set(key,slot+1);
      const button=el('button','sentence-marker',String(index+1));button.dataset.sentenceId=sentence.id;button.setAttribute('aria-label',`第 ${index+1} 句，定位译文`);
      button.style.left=`calc(${Math.max(0,range.bbox[0]*100-5)}% + ${slot*22}px)`;button.style.top=`${range.bbox[1]*100}%`;
      button.onclick=e=>{e.stopPropagation();focusSentence(sentence.id,'target');};button.onmouseenter=()=>sourceHighlight(sentence);button.onmouseleave=()=>sourceHighlight(state?.sentences.find(s=>s.id===selectedId));page.append(button);
    }
  });
}
function render(){
  const active=state?.active;$('#prepare').disabled=$('#translate').disabled=!paper||active;$('#cancel').disabled=!active;
  if(!state)return;
  const labels={idle:'未开始',running:'处理中',prepared:'断句完成',partial:'部分译文待重试',complete:'翻译完成',error:'失败',cancelled:'已取消'};
  $('#document-status').textContent=`${paper.title} · ${labels[state.status]||state.status} · ${state.stage==='prepare'?'布局与断句':'逐句翻译'} ${state.progress.done}/${state.progress.total}${state.error?' · '+state.error:''}`;
  if(revision===state.revision)return;revision=state.revision;
  const oldTop=$('#translated').scrollTop;cropObserver.disconnect();target.replaceChildren();
  if(state.warnings.length||state.excluded.length){const info=el('details','quality-warning');info.append(el('summary','',`布局提示 ${state.warnings.length} 项 · 排除 ${state.excluded.length} 条重复页边文字（原文保留）`));info.append(el('p','',state.warnings.map(w=>`第 ${w.page} 页：${w.text}`).join('\n')));for(const x of state.excluded)info.append(el('p','',`第 ${x.page} 页：${x.text}`));target.append(info);}
  state.sentences.forEach((sentence,index)=>{
    const node=el('article','sentence');node.tabIndex=0;node.dataset.sentenceId=sentence.id;node.setAttribute('aria-label',`第 ${index+1} 句`);
    const header=el('header');header.append(el('span','',`第 ${index+1} 句`),el('span','source-location',`原文第 ${[...new Set(sentence.sourceRanges.map(r=>r.page))].join('、')} 页`));node.append(header);
    node.append(el('p','source',sentence.text));const entry=state.translations[sentence.id],translated=el('p',entry?'target':'target pending');
    if(entry?.parts)for(const part of entry.parts)translated.append(part.kind==='formula'?formulaCrop(part.source,part.text):document.createTextNode(part.text));else translated.textContent=entry?.text||'等待翻译';node.append(translated);
    if(!sentence.complete)node.append(el('p','notice','标题或未完句：按现有原文保留，不补造后文。'));
    if(sentence.sourceRanges.some(r=>r.granularity==='block'))node.append(el('p','notice','原文仅有块级坐标，定位框覆盖整个文本块。'));
    if(state.errors[sentence.id])node.append(el('p','error',state.errors[sentence.id]));
    node.onclick=()=>focusSentence(sentence.id,'source');node.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();focusSentence(sentence.id,'source');}};
    node.onmouseenter=()=>sourceHighlight(sentence);node.onmouseleave=()=>sourceHighlight(state.sentences.find(s=>s.id===selectedId));target.append(node);
  });
  // Display equations and figures remain original source crops, with their page provenance.
  for(const page of state.pages)for(const block of page.blocks.filter(b=>/^(formula|image|figure|chart|table|algorithm)$/.test(b.type)&&!b.inlineAnchor)){
    const media=el('aside','retained-media');media.append(el('p','source-location',`第 ${page.page} 页 · ${block.type} · 保留原图`));const crop=formulaCrop({page:page.page,bbox:block.bbox},block.nativeText||block.text||'原页图像');crop.classList.add('display-media');media.append(crop);
    const after=new Set(page.blocks.slice(page.blocks.indexOf(block)+1).map(b=>b.id));
    const next=state.sentences.find(s=>s.sourceRanges.some(r=>r.page===page.page&&after.has(r.blockId))&&s.sourceRanges[0].page>=page.page)||state.sentences.find(s=>s.page>page.page);
    const nextNode=next&&target.querySelector(`[data-sentence-id="${next.id}"]`);target.insertBefore(media,nextNode||null);
  }
  for(const crop of target.querySelectorAll('[data-formula-page]'))cropObserver.observe(crop);
  $('#translated').scrollTop=oldTop;renderMarkers();if(selectedId)focusSentence(selectedId);
}
function schedulePoll(current){clearTimeout(timer);if(state?.active)timer=setTimeout(()=>refresh(current),700);}
async function refresh(current=generation){
  if(!paper||polling)return;const id=paper.id;polling=true;
  try{const next=await api(`/api/papers/${encodeURIComponent(id)}/sentences`);if(current!==generation)return;state=next;render();schedulePoll(current);}catch(error){if(current===generation){toast(error.message);timer=setTimeout(()=>refresh(current),2000);}}finally{polling=false;}
}
async function openPaper(id){
  const current=++generation;clearTimeout(timer);observer?.disconnect();const old=pdfTask;pdfTask=null;await old?.destroy();
  if(current!==generation)return;paper=null;state=null;revision=-1;selectedId=null;polling=false;pageEntries.clear();cropObserver.disconnect();original.querySelector('.pages').replaceChildren();target.replaceChildren();render();
  if(!id)return;
  $('#document-status').textContent='正在加载原文…';
  try{
    const selected=await api('/api/papers/'+encodeURIComponent(id));if(current!==generation)return;paper=selected;history.replaceState(null,'','?paper='+encodeURIComponent(id));$('#ocr-link').href='/ocr-debug/?paper='+encodeURIComponent(id);
    const loading=pdfjs.getDocument({url:'/api/papers/'+encodeURIComponent(id)+'/pdf',useSystemFonts:true});pdfTask=loading;const pdf=await loading.promise;if(current!==generation)return;
    const entries=[];
    for(let number=1;number<=pdf.numPages;number++){
      const page=await pdf.getPage(number);if(current!==generation)return;const base=page.getViewport({scale:1}),viewport=page.getViewport({scale:Math.max(.25,Math.min(1.5,(original.clientWidth-36)/base.width))});
      const node=el('div','page');node.dataset.page=number;node.style.width=viewport.width+'px';node.style.aspectRatio=`${viewport.width}/${viewport.height}`;original.querySelector('.pages').append(node);const entry={node,page,viewport};entries.push(entry);pageEntries.set(number,entry);
    }
    observer=new IntersectionObserver(changes=>{for(const change of changes)if(change.isIntersecting){const entry=entries.find(e=>e.node===change.target);paint(entry,current);observer.unobserve(change.target);}},{root:original,rootMargin:'600px'});
    for(const entry of entries)observer.observe(entry.node);await refresh(current);
  }catch(error){if(current===generation){$('#document-status').textContent=error.message;toast(error.message);}}
}
async function paint(entry,current){
  if(!entry)return;if(entry.promise)return entry.promise;
  entry.promise=(async()=>{const {node,page,viewport}=entry,ratio=Math.min(devicePixelRatio||1,2),canvas=el('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);
  try{await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]}).promise;if(current===generation){node.prepend(canvas);entry.painted=true;updateCrops(page.pageNumber);}}catch(error){if(current===generation)toast(error.message);}})();return entry.promise;
}
original.onclick=event=>{
  const page=event.target.closest('.page');if(!page||!state||event.target.closest('button'))return;
  const bounds=page.getBoundingClientRect(),x=(event.clientX-bounds.left)/bounds.width,y=(event.clientY-bounds.top)/bounds.height;
  const hits=state.sentences.filter(s=>s.sourceRanges.some(r=>r.page===Number(page.dataset.page)&&r.rects.some(b=>x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3])));
  if(hits.length===1)focusSentence(hits[0].id,'target');
  else if(hits.length>1){const dialog=$('#sentence-chooser'),list=dialog.querySelector('div');list.replaceChildren();for(const sentence of hits){const button=el('button','',sentence.text);button.onclick=()=>{dialog.close();focusSentence(sentence.id,'target');};list.append(button);}dialog.showModal();}
};
$('#close-chooser').onclick=()=>$('#sentence-chooser').close();
async function start(action){const current=generation,id=paper?.id;if(!id)return;$('#prepare').disabled=$('#translate').disabled=true;
  try{const config=Object.fromEntries(Object.entries(fields).map(([k,n])=>[k,n.value.trim()]));const next=await api(`/api/papers/${encodeURIComponent(id)}/sentences`,{action,...(action==='translate'?config:{})});if(current!==generation)return;state=next;render();schedulePoll(current);}catch(error){if(current===generation){toast(error.message);render();}}
}
$('#prepare').onclick=()=>start('prepare');$('#translate').onclick=()=>start('translate');$('#cancel').onclick=async()=>{const current=generation;try{const next=await api(`/api/papers/${encodeURIComponent(paper.id)}/sentences/cancel`,{});if(current===generation){state=next;render();schedulePoll(current);}}catch(error){toast(error.message);}};
select.onchange=()=>openPaper(select.value);
window.addEventListener('pagehide',()=>{generation++;clearTimeout(timer);observer?.disconnect();cropObserver.disconnect();pdfTask?.destroy();});
try{const papers=await api('/api/papers');for(const p of papers)select.add(new Option(`${p.title} · ${p.pages} 页`,p.id));const id=new URLSearchParams(location.search).get('paper');if(papers.some(p=>p.id===id)){select.value=id;await openPaper(id);}}catch(error){toast(error.message);}
