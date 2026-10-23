// Independent geometric approximation; this is not Moonlight's layout parser.
export function textBlocks(items,viewport){
 const rows=[];
 for(const item of items){if(!item.str?.trim()||!item.transform)continue;const [x,baseline]=viewport.convertToViewportPoint(item.transform[4],item.transform[5]);const height=Math.max(4,Math.hypot(item.transform[2],item.transform[3])*viewport.scale);const width=Math.max(1,item.width*viewport.scale);const top=baseline-height*.85;
  let row=rows.find(row=>Math.abs(row.top-top)<height*.35&&Math.abs(row.height-height)<height*.45&&x>=row.left-3&&x<=row.right+height*2.5);
  if(!row){row={left:x,right:x+width,top,height,parts:[]};rows.push(row)}row.parts.push({x,text:item.str});row.right=Math.max(row.right,x+width);
 }
 rows.sort((a,b)=>a.top-b.top||a.left-b.left);rows.forEach(row=>row.text=row.parts.sort((a,b)=>a.x-b.x).map(p=>p.text).join(' ').replace(/\s+/g,' ').trim());
 const blocks=[];
 for(const row of rows){let previous=blocks.findLast(block=>Math.abs(block.left-row.left)<row.height*.9&&row.top-block.bottom>=-row.height*.2&&row.top-block.bottom<row.height*.85&&Math.abs(block.font-row.height)<row.height*.2&&block.lines.length<16);
  if(previous){previous.text+=' '+row.text;previous.right=Math.max(previous.right,row.right);previous.bottom=Math.max(previous.bottom,row.top+row.height*1.15);previous.lines.push(row)}else blocks.push({left:row.left,right:row.right,top:row.top,bottom:row.top+row.height*1.15,font:row.height,text:row.text,lines:[row]});
 }
 return blocks.map((b,index)=>({id:'b'+index,text:b.text,x:Math.max(0,b.left/viewport.width),y:Math.max(0,b.top/viewport.height),w:Math.min(1,(b.right-b.left)/viewport.width),h:Math.min(1,(b.bottom-b.top)/viewport.height),font:b.font/viewport.width,translate:/[a-zA-Z]{3}/.test(b.text)&&!/^https?:|@/.test(b.text)}));
}
export function parseBlockTranslations(answer,blocks){
 const clean=String(answer).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(clean)}catch{throw Error('模型未返回有效的分段翻译 JSON，请重试或更换模型')}
 const entries=Array.isArray(data)?data:Array.isArray(data.translations)?data.translations:Object.entries(data).map(([id,text])=>({id,text}));const allowed=new Set(blocks.filter(b=>b.translate).map(b=>b.id)),translations={};
 for(const entry of entries){if(allowed.has(entry.id)&&typeof entry.text==='string'&&entry.text.trim())translations[entry.id]=entry.text.trim()}
 const missing=[...allowed].filter(id=>!translations[id]);if(missing.length)throw Error('模型遗漏了 '+missing.length+' 个文本块，译文未保存，请重试');return translations;
}
