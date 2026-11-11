const CLASSES=['inline_formula','display_formula'];
const area=b=>Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const intersection=(a,b)=>Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
const iou=(a,b)=>intersection(a,b)/(area(a)+area(b)-intersection(a,b)||1);
const fraction=(a,b)=>b?a/b:null;
function counts(tp=0,fp=0,fn=0,ignored=0){return {tp,fp,fn,ignored,precision:fraction(tp,tp+fp),recall:fraction(tp,tp+fn),f1:fraction(2*tp,2*tp+fp+fn)};}
function matchBoxes(gt,pred,threshold=.5){
  const edges=gt.map(g=>pred.map((p,index)=>({index,iou:iou(g.bbox,p.bbox)})).filter(e=>e.iou>=threshold).sort((a,b)=>b.iou-a.iou||a.index-b.index));
  const assigned=new Map();
  function augment(g,visited){for(const {index} of edges[g]){if(visited.has(index))continue;visited.add(index);if(!assigned.has(index)||augment(assigned.get(index),visited)){assigned.set(index,g);return true;}}return false;}
  for(let g=0;g<gt.length;g++)augment(g,new Set());
  return [...assigned].map(([p,g])=>({gt:g,pred:p,iou:iou(gt[g].bbox,pred[p].bbox)}));
}
function scoreFormulas(annotation,regions,threshold=.5){
  if(annotation.status!=='complete')return null;
  const result={};
  for(const label of CLASSES){
    const gt=annotation.formulas.filter(g=>g.label===label),pred=regions.filter(p=>p.label===label),matches=matchBoxes(gt,pred,threshold),used=new Set(matches.map(m=>m.pred));
    const ignored=pred.filter((p,i)=>!used.has(i)&&(annotation.ignore||[]).some(g=>(!g.label||g.label===label)&&intersection(g.bbox,p.bbox)/(area(p.bbox)||1)>.5)).length;
    result[label]={...counts(matches.length,pred.length-matches.length-ignored,gt.length-matches.length,ignored),matches:matches.map(m=>({gtId:gt[m.gt].id,predId:pred[m.pred].id,iou:m.iou})),falseNegatives:gt.filter((_,i)=>!matches.some(m=>m.gt===i)).map(g=>g.id),falsePositives:pred.filter((p,i)=>!used.has(i)&&!(annotation.ignore||[]).some(g=>(!g.label||g.label===label)&&intersection(g.bbox,p.bbox)/(area(p.bbox)||1)>.5)).map(p=>p.id)};
  }
  return result;
}
function sumScores(rows){
  return Object.fromEntries(CLASSES.map(label=>[label,counts(...['tp','fp','fn','ignored'].map(k=>rows.reduce((n,r)=>n+(r?.[label]?.[k]||0),0)))]));
}
function readingOrder(annotation,plan){
  const anchors=annotation.readingOrder||[];
  if(anchors.length<2)return null;
  const body=plan.blocks.filter(b=>/^(text|doc_title|paragraph_title|figure_title|footnote|reference_content)$/.test(b.type));
  const matched=anchors.map(a=>body.filter(b=>a.point[0]>b.bbox[0]&&a.point[0]<b.bbox[2]&&a.point[1]>b.bbox[1]&&a.point[1]<b.bbox[3]).sort((a,b)=>area(a.bbox)-area(b.bbox))[0]);
  let pairs=0,resolved=0,rawCorrect=0,applicationCorrect=0;
  for(let i=0;i<anchors.length;i++)for(let j=i+1;j<anchors.length;j++){
    pairs++;const a=matched[i],b=matched[j];if(!a||!b||a.id===b.id||a.layoutOrder==null||b.layoutOrder==null)continue;
    resolved++;if(a.layoutOrder<b.layoutOrder)rawCorrect++;if(a.order<b.order)applicationCorrect++;
  }
  return {anchors:anchors.length,matchedAnchors:matched.filter(Boolean).length,pairs,resolvedPairs:resolved,rawCorrect,applicationCorrect,rawStrict:fraction(rawCorrect,pairs),applicationStrict:fraction(applicationCorrect,pairs),rawOnResolved:fraction(rawCorrect,resolved),applicationOnResolved:fraction(applicationCorrect,resolved)};
}
function validateAnnotation(annotation){
  if(!['pending','complete'].includes(annotation.status))throw Error('Invalid annotation status');
  if(!Array.isArray(annotation.formulas)||!Array.isArray(annotation.ignore)||!Array.isArray(annotation.readingOrder))throw Error('Invalid annotation arrays');
  const ids=new Set();
  for(const f of [...annotation.formulas,...annotation.ignore]){
    if(typeof f.id!=='string'||ids.has(f.id))throw Error('Duplicate/missing annotation ID');ids.add(f.id);
    if(!Array.isArray(f.bbox)||f.bbox.length!==4||f.bbox.some(v=>!Number.isFinite(v)||v<0||v>1)||area(f.bbox)<=0)throw Error('Invalid annotation box');
  }
  for(const f of annotation.formulas)if(!CLASSES.includes(f.label))throw Error('Invalid formula label');
  for(const f of annotation.ignore)if(!f.reason?.trim())throw Error('Ignore region requires a reason');
  for(const a of annotation.readingOrder)if(!a.id||!a.point||a.point.length!==2||a.point.some(v=>!Number.isFinite(v)||v<0||v>1))throw Error('Invalid reading anchor');
  if(annotation.status==='complete'&&(!annotation.reviewedBy||!annotation.sourceSha256))throw Error('Complete annotation requires provenance');
}
module.exports={CLASSES,area,intersection,iou,counts,matchBoxes,scoreFormulas,sumScores,readingOrder,validateAnnotation};
