import fs from 'node:fs';
import path from 'node:path';
import katex from 'katex';
import {mathSegments,stripMathDelimiters,markdownTableRows} from '../public/recognition-content.mjs';

const state = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pages = (Array.isArray(state.pages) ? state.pages : Object.values(state.pages)).sort((a,b)=>a.page-b.page);
const blocks = pages.flatMap(page=>page.blocks), visible = blocks.filter(block=>block.order != null);
const unique = items => items.length === new Set(items).size;
const formulas = [], errors = [];
for (const block of visible) {
  const segments = /^(formula|equation)$/.test(block.type) ? [{math:true,display:true,text:stripMathDelimiters(block.text)}] : block.type === 'table' || block.type === 'chart' ? [] : mathSegments(block.text);
  for (const segment of segments.filter(segment=>segment.math)) {
    try { katex.renderToString(segment.text, {displayMode:segment.display,throwOnError:true,trust:false,strict:'ignore'}); }
    catch (error) { errors.push({id:block.id,page:block.page,latex:segment.text,error:error.message}); }
    formulas.push({id:block.id,page:block.page,display:Boolean(segment.display),latex:segment.text});
  }
}
const assets = process.argv[4];
const requestedPageCount = Number(process.argv[5]) || null;
const sourceImages = pages.map(page=>{
  if (!assets) return {page:page.page,filename:page.sourceImage};
  const png = fs.readFileSync(path.join(assets,page.sourceImage));
  return {page:page.page,filename:page.sourceImage,width:png.readUInt32BE(16),height:png.readUInt32BE(20),matchesCoordinates:png.readUInt32BE(16)===page.width && png.readUInt32BE(20)===page.height};
});
function headingBeforeBody(number, headingText, bodyText) {
  const page = pages.find(page=>page.page===number), heading = page?.blocks.find(block=>headingText.test(block.text)), body = page?.blocks.find(block=>bodyText.test(block.text));
  return {page:number,heading:heading?.id,headingOrder:heading?.order,body:body?.id,bodyOrder:body?.order,passed:Boolean(heading && body && heading.order<body.order)};
}
const collapse = value => value.replace(/<[^>]+>/g,' ').replace(/&plusmn;/g,'±').replace(/&amp;/g,'&').replace(/\s/g,'');
const table = pages.find(page=>page.page===6)?.blocks.find(block=>block.type==='table');
const tableRows = [...(table?.text || '').matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(match=>collapse(match[1]));
const targets = [
  {row:'PI-Linear',values:['83.10±0.41','80.03±0.33','78.47±4.16','35.79±1.80','84.25±4.43','70.40±0.43','66.78±0.49','75.88±0.34','39.69±0.13']},
  {row:'GCNII+PI',values:['83.53±0.21','80.40±0.50','76.26±0.73','47.32±2.00','86.71±1.05','71.85±0.25','70.77±0.59','74.32±0.07','40.27±0.12']},
];
const tableSamples = targets.map(target=>{
  const observed = tableRows.find(row=>row.includes(target.row)) || '';
  return {...target,observed,matches:target.values.map(value=>({value,found:observed.includes(value)}))};
});
const result = {
  parser:state.parser,profile:state.ocrProfile,pageCount:pages.length,
  requestedPageCount,allPagesPresent:requestedPageCount ? pages.length===requestedPageCount && pages.every((page,index)=>page.page===index+1) : null,
  rawBlocks:blocks.length,visibleBlocks:visible.length,uniqueIds:unique(blocks.map(block=>block.id)),
  continuousVisibleNumbers:visible.every((block,index)=>block.order===index+1),
  validGeometry:blocks.every(block=>block.bbox.length===4 && block.bbox.every(value=>Number.isFinite(value)&&value>=0&&value<=1) && block.bbox[0]<block.bbox[2] && block.bbox[1]<block.bbox[3]),
  allModulesEnabled:pages.every(page=>Object.keys(page.features||{}).length===8 && Object.values(page.features).every(value=>value===true)),
  runtime:pages.map(({page,runtime,elapsedSeconds})=>({page,runtime,elapsedSeconds})),sourceImages,
  typeCounts:Object.fromEntries([...new Set(visible.map(block=>block.type))].map(type=>[type,visible.filter(block=>block.type===type).length])),
  latexExpressions:formulas.length,latexSyntaxErrors:errors,formulas,
  chartData:visible.filter(block=>block.type==='chart').map(block=>({id:block.id,page:block.page,rows:markdownTableRows(block.text).length,text:block.text})),
  readingOrderSamples:[headingBeforeBody(6,/^4\.3\s+Deep Propagation/,/^We examine whether PI feedback/),headingBeforeBody(12,/^B\.3\s+Additional/,/^We compare both the standard GCN/)],
  tableSampleScope:'18 numerical cells manually transcribed from original PI Control PDF page 6, Table 2. Other tables require separate review.',
  tableSamples,
};
fs.writeFileSync(process.argv[3],JSON.stringify(result,null,2));
const {formulas:omitted,chartData,...summary}=result;
console.log(JSON.stringify({...summary,chartBlocks:chartData.length,chartBlocksWithData:chartData.filter(chart=>chart.rows>0).length},null,2));
