const path=require('node:path');
const MODEL=Object.freeze({name:'PP-DocLayoutV3',repository:'phungpx/PP-DocLayoutV3-ONNX',revision:'9dedaf7180045648d81929099a1391ef5d9b443c',filename:'pp_doclayoutv3.onnx',sha256:'29193c815d2d9a9db42cdebe400862fbdbf64e7e14c06f8b1f5064657c769b88',bytes:133739324});
// IDs come from PaddlePaddle/PP-DocLayoutV3/inference.yml, not the lossy
// id2label aliases in the Transformers checkpoint.
const LABELS=Object.freeze(['abstract','algorithm','aside_text','chart','content','display_formula','doc_title','figure_title','footer','footer_image','footnote','formula_number','header','header_image','image','inline_formula','number','paragraph_title','reference','reference_content','seal','table','text','vertical_text','vision_footnote']);
const modelPath=()=>path.join(__dirname,'.cache/models/pp-doclayout-v3',MODEL.filename);
const layoutMode=()=>{const mode=process.env.HELIOS_LAYOUT||'heuristic';if(!['model','heuristic'].includes(mode))throw Error('HELIOS_LAYOUT must be model or heuristic');return mode;};
const layoutProvider=()=>{if(process.env.HELIOS_LAYOUT_PROVIDER)return process.env.HELIOS_LAYOUT_PROVIDER;try{const saved=JSON.parse(require('node:fs').readFileSync(path.join(__dirname,'.cache/layout-runtime.json'),'utf8'));if(saved.modelSha256===MODEL.sha256&&['cpu','dml'].includes(saved.provider))return saved.provider;}catch{}return 'cpu';};
let identity;
const layoutProfile=()=>identity ||= require('node:crypto').createHash('sha256').update(JSON.stringify([MODEL.sha256,layoutProvider(),process.env.HELIOS_LAYOUT_THREADS||'4',...['layout-contract.cjs','layout-thread.cjs','layout-preprocess.cjs','pdf-layout-model.cjs'].map(name=>require('node:fs').readFileSync(path.join(__dirname,name),'utf8'))])).digest('hex');
const sigmoid=value=>1/(1+Math.exp(-value));

function decode(outputs,{threshold=.5}={}) {
  const {logits,pred_boxes:boxes,order_logits:order}=outputs;
  const count=logits?.dims?.[1],classes=logits?.dims?.[2];
  if(logits?.dims?.[0]!==1||count!==300||classes!==25||boxes?.dims?.join(',')!=='1,300,4'||order?.dims?.join(',')!=='1,300,300')throw Error('PP-DocLayoutV3 output contract mismatch');
  // Port of the upstream pointer-head win accumulation. Preserve query IDs
  // through top-k; rank is not the position in the confidence-sorted list.
  const votes=new Float64Array(count);
  for(let column=0;column<count;column++)for(let row=0;row<column;row++)votes[column]+=sigmoid(order.data[row*count+column]);
  for(let column=0;column<count;column++)for(let row=column+1;row<count;row++)votes[column]+=1-sigmoid(order.data[column*count+row]);
  const sorted=Array.from({length:count},(_,i)=>i).sort((a,b)=>votes[a]-votes[b]||a-b),ranks=new Int32Array(count);
  sorted.forEach((query,rank)=>{ranks[query]=rank;});
  const candidates=Array.from(logits.data,(value,index)=>({index,score:sigmoid(value)})).sort((a,b)=>b.score-a.score||a.index-b.index).slice(0,count);
  const regions=[];
  for(const {index,score} of candidates) {
    if(score<threshold)continue;
    const query=Math.floor(index/classes),classId=index%classes,offset=query*4;
    const [cx,cy,w,h]=Array.from(boxes.data.slice(offset,offset+4));
    if(![cx,cy,w,h,score].every(Number.isFinite)||w<=0||h<=0)continue;
    const bbox=[cx-w/2,cy-h/2,cx+w/2,cy+h/2].map(value=>Math.max(0,Math.min(1,value)));
    if(bbox[2]<=bbox[0]||bbox[3]<=bbox[1])continue;
    regions.push({id:'q'+query+'-c'+classId,query,classId,label:LABELS[classId],score,bbox,order:ranks[query]});
  }
  return regions.sort((a,b)=>a.order-b.order||b.score-a.score||a.classId-b.classId);
}
module.exports={MODEL,LABELS,modelPath,layoutMode,layoutProvider,layoutProfile,decode};
