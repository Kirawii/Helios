const {multiply} = require('./pdf-native.cjs');

// Direct extraction is deliberately limited to one opaque, axis-aligned image,
// with no clips, graphics, Forms or later text that could alter the crop. Complex
// figures retain the normal rendered appearance; formulas never use this path.
async function embeddedImage(page,engine,bounds,signal,canvasFactory) {
  const operators=await page.getOperatorList();signal.throwIfAborted();
  const {OPS,ImageKind}=engine;
  const unsafe=new Set([OPS.paintFormXObjectBegin,OPS.constructPath,OPS.clip,OPS.eoClip,OPS.setGState,OPS.paintImageMaskXObject,OPS.paintInlineImageXObject,OPS.paintImageXObjectRepeat]);
  if(operators.fnArray.some(op=>unsafe.has(op)))return;
  const indices=operators.fnArray.flatMap((op,index)=>op===OPS.paintImageXObject?[index]:[]);if(indices.length!==1)return;
  const index=indices[0],laterText=new Set([OPS.beginText,OPS.showText,OPS.showSpacedText,OPS.nextLineShowText,OPS.nextLineSetSpacingShowText]);
  if(operators.fnArray.slice(index+1).some(op=>laterText.has(op)))return;
  let matrix=[1,0,0,1,0,0];const stack=[];
  for(let i=0;i<index;i++) {
    const op=operators.fnArray[i],args=operators.argsArray[i];
    if(op===OPS.save)stack.push(matrix);
    else if(op===OPS.restore)matrix=stack.pop()||[1,0,0,1,0,0];
    else if(op===OPS.transform)matrix=multiply(matrix,args);
  }
  const viewport=page.getViewport({scale:2}),transform=multiply(viewport.transform,matrix);
  if(transform[0]<=0||transform[3]>=0||Math.abs(transform[1])>1e-8||Math.abs(transform[2])>1e-8)return;
  const box=[transform[4]/viewport.width,(transform[5]+transform[3])/viewport.height,(transform[4]+transform[0])/viewport.width,transform[5]/viewport.height];
  if(box.some((value,index)=>Math.abs(value-bounds[index])>1e-8))return;
  const id=operators.argsArray[index][0],objects=id.startsWith('g_')?page.commonObjs:page.objs;
  if(!objects.has(id))return;
  const image=objects.get(id);
  if(image.kind!==ImageKind.RGB_24BPP||image.data?.length!==image.width*image.height*3||image.width*image.height>Math.abs(transform[0]*transform[3])*1.25)return;
  const surface=canvasFactory.create(image.width,image.height);
  try {
    const pixels=surface.context.createImageData(image.width,image.height);
    for(let source=0,target=0;source<image.data.length;source+=3,target+=4){pixels.data[target]=image.data[source];pixels.data[target+1]=image.data[source+1];pixels.data[target+2]=image.data[source+2];pixels.data[target+3]=255;}
    surface.context.putImageData(pixels,0,0);
    return {width:image.width,height:image.height,png:surface.canvas.toBuffer('image/png'),source:'embedded-image'};
  }finally{canvasFactory.destroy(surface);}
}

module.exports={embeddedImage};
