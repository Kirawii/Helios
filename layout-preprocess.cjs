// OpenCV INTER_CUBIC convention (A=-0.75), RGB uint8 -> NCHW float32.
// Resizing happens in PDF workers, never in the HTTP server thread.
const cubic=x=>{x=Math.abs(x);return x<=1?1.25*x*x*x-2.25*x*x+1:x<2?-.75*x*x*x+3.75*x*x-6*x+3:0;};
function weights(length){return Array.from({length:800},(_,out)=>{const position=(out+.5)*length/800-.5,base=Math.floor(position);return Array.from({length:4},(_,n)=>({index:Math.max(0,Math.min(length-1,base+n-1)),weight:cubic(position-(base+n-1))}));});}
function preprocess(rgba,width,height){
  const xs=weights(width),ys=weights(height),horizontal=new Float32Array(height*800*3),pixels=new Float32Array(3*800*800);
  for(let y=0;y<height;y++)for(let x=0;x<800;x++)for(let c=0;c<3;c++){let value=0;for(const tap of xs[x])value+=rgba[(y*width+tap.index)*4+c]*tap.weight;horizontal[(y*800+x)*3+c]=value;}
  for(let y=0;y<800;y++)for(let x=0;x<800;x++)for(let c=0;c<3;c++){let value=0;for(const tap of ys[y])value+=horizontal[(tap.index*800+x)*3+c]*tap.weight;pixels[c*800*800+y*800+x]=Math.max(0,Math.min(255,Math.round(value)))/255;}
  return pixels;
}
module.exports={preprocess};
