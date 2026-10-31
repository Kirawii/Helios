const fs = require('node:fs');
const path = require('node:path');
const {analyzeNativePage} = require('./pdf-native.cjs');
const {embeddedImage} = require('./pdf-embedded-image.cjs');

let enginePromise;
function loadPdfEngine() {
  return enginePromise ||= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]).then(([engine])=>engine);
}

async function openPdf(filename, {adaptive=false}={}) {
  const engine = await loadPdfEngine();
  const pdf = await engine.getDocument({data:new Uint8Array(fs.readFileSync(filename)),useSystemFonts:false,
    standardFontDataUrl:path.join(path.dirname(require.resolve('pdfjs-dist/package.json')),'standard_fonts')+path.sep}).promise;
  const cachePages=new Set(),fullPages=new Map(),pageBounds=new Map();
  async function surface(number,bounds,signal) {
    signal.throwIfAborted();
    const page=await pdf.getPage(number),viewport=page.getViewport({scale:2});
    const value=pdf.canvasFactory.create(Math.max(1,Math.ceil(viewport.width*(bounds[2]-bounds[0]))),Math.max(1,Math.ceil(viewport.height*(bounds[3]-bounds[1]))));
    let task;const cancel=()=>task?.cancel();signal.addEventListener('abort',cancel,{once:true});
    try{signal.throwIfAborted();task=page.render({canvasContext:value.context,viewport,transform:[1,0,0,1,-bounds[0]*viewport.width,-bounds[1]*viewport.height],background:'rgb(255,255,255)'});await task.promise;signal.throwIfAborted();return value;}
    catch(error){pdf.canvasFactory.destroy(value);throw error;}
    finally{signal.removeEventListener('abort',cancel);}
  }
  async function sharedSurface(number,signal) {
    const page=await pdf.getPage(number),viewport=page.getViewport({scale:2}),regions=pageBounds.get(number);
    let bounds=[0,0,1,1],originX=0,originY=0;
    if(adaptive&&regions?.length) {
      // Keep the original pixel grid, including a halo for interpolation at edges.
      originX=Math.max(0,Math.floor(Math.min(...regions.map(b=>b[0]))*viewport.width)-2);
      originY=Math.max(0,Math.floor(Math.min(...regions.map(b=>b[1]))*viewport.height)-2);
      const right=Math.min(Math.ceil(viewport.width),Math.ceil(Math.max(...regions.map(b=>b[2]))*viewport.width)+2);
      const bottom=Math.min(Math.ceil(viewport.height),Math.ceil(Math.max(...regions.map(b=>b[3]))*viewport.height)+2);
      bounds=[originX/viewport.width,originY/viewport.height,right/viewport.width,bottom/viewport.height];
    }
    const value=await surface(number,bounds,signal);
    return {...value,originX,originY,fullWidth:Math.ceil(viewport.width),fullHeight:Math.ceil(viewport.height)};
  }
  return {
    pageCount:pdf.numPages,
    prepareRegions(number,count,regions){
      if(count>1)cachePages.add(number);
      // Formula pages keep the previous full-page pixel grid and exact inputs.
      // Adaptive clipping applies only to image-only candidate pages.
      if(regions?.length&&regions.every(region=>region.kind==='image'))pageBounds.set(number,regions.map(region=>region.bbox));
      else pageBounds.delete(number);
    },
    releasePage(number){const pending=fullPages.get(number);fullPages.delete(number);cachePages.delete(number);pageBounds.delete(number);pending?.then(value=>pdf.canvasFactory.destroy(value),()=>{});},
    async analyze(number,signal){
      const page=await pdf.getPage(number),plan=await analyzeNativePage(page,engine.OPS,signal);
      // Scheduling metadata only; formula detection and source ranges are intact.
      plan.renderCost=(await page.getOperatorList()).fnArray.length;return plan;
    },
    async render(number,signal){return this.renderRegion(number,[0,0,1,1],signal);},
    async renderRegion(number,bounds,signal,kind) {
      let value;
      try {
        signal.throwIfAborted();
        if(adaptive&&kind==='image') {
          const extracted=await embeddedImage(await pdf.getPage(number),engine,bounds,signal,pdf.canvasFactory);
          if(extracted)return extracted;
        }
        if(cachePages.has(number)&&(bounds[0]!==0||bounds[1]!==0||bounds[2]!==1||bounds[3]!==1)) {
          if(!fullPages.has(number))fullPages.set(number,sharedSurface(number,signal));
          const full=await fullPages.get(number);signal.throwIfAborted();
          value=pdf.canvasFactory.create(Math.max(1,Math.ceil(full.fullWidth*(bounds[2]-bounds[0]))),Math.max(1,Math.ceil(full.fullHeight*(bounds[3]-bounds[1]))));
          value.context.drawImage(full.canvas,bounds[0]*full.fullWidth-full.originX,bounds[1]*full.fullHeight-full.originY,(bounds[2]-bounds[0])*full.fullWidth,(bounds[3]-bounds[1])*full.fullHeight,0,0,value.canvas.width,value.canvas.height);
        }else value=await surface(number,bounds,signal);
        return {width:value.canvas.width,height:value.canvas.height,png:value.canvas.toBuffer('image/png')};
      }finally{if(value)pdf.canvasFactory.destroy(value);}
    },
    async close(){for(const pending of fullPages.values()){try{pdf.canvasFactory.destroy(await pending);}catch{}}fullPages.clear();await pdf.destroy();},
  };
}

module.exports={openPdf,loadPdfEngine};
