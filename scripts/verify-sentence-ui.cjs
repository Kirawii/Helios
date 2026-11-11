// Disposable local browser fixture. No library writes, credentials or external model requests.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),express=require('express');
const {createSentenceService,installSentenceRoutes}=require('../sentence-service.cjs');
const {openPreparedPdf,closePdfPool}=require('../pdf-pool.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-sentence-ui-'));
function fixturePdf(){
  const objects=[];const add=text=>objects.push(text);
  add('<< /Type /Catalog /Pages 2 0 R >>');add('<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>');add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for(const lines of [['First sentence uses 3.14 units [1]. Second sentence uses $x = 2$.','The third sentence continues'],['across pages. Final sentence describes the observed result.']]){
    const page=objects.length+1;const stream=lines.map((text,n)=>`BT /F1 12 Tf 40 ${720-n*40} Td (${text}) Tj ET`).join('\n');
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page+1} 0 R >>`);add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((o,i)=>{offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${o}\nendobj\n`;});const xref=pdf.length;pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>`${String(n).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;return Buffer.from(pdf);
}
fs.writeFileSync(path.join(root,'fixture.pdf'),fixturePdf());
const paper={id:'fixture',title:'合成验收样本 · 模拟译文 · 无外部请求',pages:2};let modelCalls=0;
const service=createSentenceService({root,getPaper:id=>id==='fixture'?paper:null,openPdf:(filename,options)=>openPreparedPdf(filename,{...options,cacheDirectory:path.join(root,'preparation')}),requestJSON:async(config,messages,signal,budget)=>{
  signal.throwIfAborted();budget.remaining--;modelCalls++;const units=JSON.parse(messages.at(-1).content).blocks;
  return {translations:units.map(u=>({id:u.id,text:'测试译文：'+u.text}))};
}});
const app=express();app.use(express.json());app.use(express.static(path.join(__dirname,'../public')));app.use('/pdfjs',express.static(path.join(__dirname,'../node_modules/pdfjs-dist/build')));
app.use('/katex',express.static(path.join(__dirname,'../node_modules/katex/dist')));
app.get('/api/papers',(_,r)=>r.json([paper]));app.get('/api/papers/fixture',(_,r)=>r.json(paper));app.get('/api/papers/fixture/pdf',(_,r)=>r.sendFile(path.join(root,'fixture.pdf')));
app.get('/api/fixture-status',(_,r)=>r.json({modelCalls,realCloudRequests:0,root}));installSentenceRoutes(app,service);
const server=app.listen(3211,'127.0.0.1',()=>console.log('Disposable fixture: http://localhost:3211/translate/?paper=fixture'));
async function stop(){await service.close();await closePdfPool();await new Promise(resolve=>server.close(resolve));if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-sentence-ui-'))fs.rmSync(root,{recursive:true,force:true});}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
