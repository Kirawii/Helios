// Independent geometric approximation; this is not Moonlight's layout parser.
// Finds a vertical whitespace channel between two text columns. `boxes` are [x0,x1] in 0-1 page width.
export function detectGutter(boxes){
 if(boxes.length<10)return null;
 const counts=x=>{let left=0,right=0,cross=0;for(const[a,b]of boxes){if(b>x-.06&&b<=x)left++;if(a>=x&&a<x+.06)right++;if(a<x-.002&&b>x+.002)cross++}return{left,right,cross,score:Math.min(left,right)-2*cross}};
 const scores=[];for(let step=0;step<=160;step++)scores.push(counts(.3+step*.0025).score);
 const best=Math.max(...scores);let plateau=null,current=null;
 scores.forEach((score,index)=>{if(score!==best){current=null;return}if(!current)current={start:index,end:index};current.end=index;if(!plateau||current.end-current.start>plateau.end-plateau.start||current===plateau)plateau=current});
 if(!plateau)return null;
 const x=.3+(plateau.start+plateau.end)/2*.0025,found=counts(x),shortest=Math.min(found.left,found.right);
 return shortest>=5&&shortest>2*found.cross?x:null;
}
export function textBlocks(items,viewport){
 const entries=[];
 for(const item of items){if(!item.str?.trim()||!item.transform)continue;const [x,baseline]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);const height=Math.max(4,Math.hypot(item.transform[2],item.transform[3])*viewport.scale);const width=Math.max(1,item.width*viewport.scale);entries.push({item,x,baseline,height,width,top:baseline-height*.85})}
 const gutterX=detectGutter(entries.map(e=>[e.x/viewport.width,(e.x+e.width)/viewport.width])),gutter=gutterX==null?null:gutterX*viewport.width,eps=.002*viewport.width;
 // -1 entirely left of the gutter, 1 entirely right, 0 crossing it (or no gutter).
 const side=(left,right)=>gutter==null?0:right<=gutter+eps?-1:left>=gutter-eps?1:0;
 const rows=[];
 for(const {item,x,height,width,top} of entries){
  let row=rows.find(row=>Math.abs(row.top-top)<height*.35&&Math.abs(row.height-height)<height*.45&&x>=row.left-3&&x<=row.right+height*2.5&&side(row.left,row.right)*side(x,x+width)!==-1);
  if(!row){row={left:x,right:x+width,top,height,parts:[]};rows.push(row)}row.parts.push({x,text:item.str});row.right=Math.max(row.right,x+width);
 }
 rows.sort((a,b)=>a.top-b.top||a.left-b.left);rows.forEach(row=>row.text=row.parts.sort((a,b)=>a.x-b.x).map(p=>p.text).join(' ').replace(/\s+/g,' ').trim());
 const blocks=[];
 for(const row of rows){
  const rowSide=side(row.left,row.right);
  const previous=blocks.findLast(block=>{
   if(!(row.top-block.bottom>=-row.height*.2&&row.top-block.bottom<row.height*.85&&Math.abs(block.font-row.height)<row.height*.2&&block.lines.length<16))return false;
   if(side(block.left,block.right)*rowSide===-1)return false;
   const base=block.body??block.left,shift=row.left-base;
   if(shift>=row.height*.5)return false; // indented line: a new paragraph begins
   if(Math.abs(shift)<row.height*.9)return true;
   return block.lines.length===1&&block.left-row.left>0&&block.left-row.left<=row.height*3; // first-line indent
  });
  if(previous){if(previous.lines.length===1)previous.body=row.left;previous.text+=' '+row.text;previous.left=Math.min(previous.left,row.left);previous.right=Math.max(previous.right,row.right);previous.bottom=Math.max(previous.bottom,row.top+row.height*1.15);previous.lines.push(row)}else blocks.push({left:row.left,right:row.right,top:row.top,bottom:row.top+row.height*1.15,font:row.height,text:row.text,lines:[row]});
 }
 return blocks.map((b,index)=>({id:'b'+index,text:b.text,x:Math.max(0,b.left/viewport.width),y:Math.max(0,b.top/viewport.height),w:Math.min(1,(b.right-b.left)/viewport.width),h:Math.min(1,(b.bottom-b.top)/viewport.height),font:b.font/viewport.width,translate:/[a-zA-Z]{3}/.test(b.text)&&!/^https?:|@/.test(b.text)}));
}
export function parseBlockTranslations(answer,blocks){
 const clean=String(answer).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(clean)}catch{throw Error('模型未返回有效的分段翻译 JSON，请重试或更换模型')}
 const entries=Array.isArray(data)?data:Array.isArray(data.translations)?data.translations:Object.entries(data).map(([id,text])=>({id,text}));const allowed=new Set(blocks.filter(b=>b.translate).map(b=>b.id)),translations={};
 for(const entry of entries){if(allowed.has(entry.id)&&typeof entry.text==='string'&&entry.text.trim())translations[entry.id]=entry.text.trim()}
 const missing=[...allowed].filter(id=>!translations[id]);if(missing.length)throw Error('模型遗漏了 '+missing.length+' 个文本块，译文未保存，请重试');return translations;
}
