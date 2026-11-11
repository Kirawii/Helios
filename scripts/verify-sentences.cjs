const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSentences,protectSentence,boundaries,translationParts}=require('../sentences.cjs');
const model=require('../translation-model.cjs');
const {createSentenceService,installSentenceRoutes}=require('../sentence-service.cjs');
const {testPdf}=require('./test-pdf.cjs');
const express=require('express');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-sentences-'));
const paper={id:'fixture',pages:2,title:'Sentence fixture'};fs.writeFileSync(path.join(root,'fixture.pdf'),testPdf());
const block=(id,page,text,bbox=[.1,.2,.9,.3],type='text')=>({id,page,type,text,originalText:text,bbox,lines:[{text,start:0,end:text.length,bbox,runs:[{text,start:0,end:text.length,bbox}]}]});
const pages=[{page:1,blocks:[block('a',1,'Dr. Smith uses 3.14 units [1]. We use $x = 2.5$ to'),block('b',1,'improve accuracy. The next sentence crosses')]},{page:2,blocks:[block('c',2,'pages, e.g. in Fig. 2. Done!')]}];
let analyses=0,calls=[],failId=null;
const openPdf=async()=>({pageCount:2,async analyze(number){analyses++;return {...structuredClone(pages[number-1]),parseMs:analyses};},async close(){}});
const answer=(units,omit)=>({translations:units.filter(u=>u.id!==omit).map(u=>({id:u.id,text:'译文 '+u.text}))});
const requestJSON=async(config,messages,signal,budget)=>{budget.remaining--;signal.throwIfAborted();const units=JSON.parse(messages.at(-1).content).blocks;calls.push(units.map(u=>u.id));return answer(units,failId);};
const config={action:'translate',baseUrl:'http://localhost:9999/v1',model:'fixture',key:'SYNTHETIC-ONLY'};
const service=createSentenceService({root,getPaper:id=>id===paper.id?paper:null,openPdf,requestJSON});
(async()=>{
  const built=buildSentences(pages,{pdfHash:'fixture'});
  assert.deepEqual(built.sentences.map(s=>s.text),['Dr. Smith uses 3.14 units [1].','We use $x = 2.5$ to improve accuracy.','The next sentence crosses pages, e.g. in Fig. 2.','Done!']);
  assert.equal(built.sentences[1].sourceRanges.length,2);assert.deepEqual(built.sentences[2].sourceRanges.map(r=>r.page),[1,2]);
  assert.deepEqual(buildSentences(pages,{pdfHash:'fixture'}).sentences.map(s=>s.id),built.sentences.map(s=>s.id));
  const seen=new Set();for(const s of built.sentences)for(const range of s.sourceRanges)for(let i=range.start;i<range.end;i++){const key=range.blockId+':'+i;assert.ok(!seen.has(key),'duplicate source character');seen.add(key);}
  for(const page of pages)for(const b of page.blocks)for(let i=0;i<b.text.length;i++)if(!/\s/.test(b.text[i]))assert.ok(seen.has(b.id+':'+i),'missing source character');
  const unit=protectSentence(built.sentences[1]);assert.ok(unit.tokens.some(t=>t.kind==='formula'));
  assert.equal(model.validateTranslations({translations:[{id:unit.id,text:'翻译 '+unit.text}]},[unit]).errors.size,0);
  assert.ok(model.validateTranslations({translations:[{id:unit.id,text:'漏公式'}]},[unit]).errors.size);
  assert.ok(model.validateTranslations({translations:[{id:unit.id,text:unit.text+' 42'}]},[unit]).errors.size);
  const parts=translationParts('翻译 '+unit.text,unit);assert.equal(parts.filter(p=>p.kind==='formula').length,1);assert.equal(parts.map(p=>p.text).join(''),'翻译 '+unit.original);
  assert.equal(boundaries('Use https://test.invalid/a.b with 3.14. Then go.').length,2);
  const fonts=block('math',1,'Use H for hidden state.');fonts.lines[0].runs=[{start:4,end:5,bbox:[.2,.2,.22,.3],mathFont:true}];
  assert.ok(protectSentence(buildSentences([{page:1,blocks:[fonts]}]).sentences[0]).tokens.some(t=>t.kind==='formula'&&t.original==='H'));
  const marginal=Array.from({length:3},(_,n)=>({page:n+1,blocks:[block('body'+n,n+1,'Body text.'),block('foot'+n,n+1,'Manuscript submitted to ACM',[.1,.9,.9,.93])]}));
  const clean=buildSentences(marginal);assert.equal(clean.excluded.length,3);assert.ok(clean.sentences.every(s=>!s.text.includes('Manuscript')));assert.ok(marginal[0].blocks[1].text.includes('Manuscript'));
  const withMedia=buildSentences([{page:1,blocks:[block('t',1,'A sentence continues'),block('image',1,'','', 'image'),block('t2',1,'after the figure.')]}]);assert.equal(withMedia.sentences.length,1);
  const metadata=buildSentences([{page:1,blocks:[block('author',1,'AUTHOR NAME, University, China'),block('abstract',1,'Retrieval improves answers.')]}]);assert.equal(metadata.sentences.length,2);assert.equal(metadata.sentences[0].complete,false);
  assert.equal(buildSentences([{page:1,blocks:[block('missing1',1,'This continues')]},{page:3,blocks:[block('missing3',3,'across missing pages.')]}]).sentences.length,2);
  failId=built.sentences[1].id;
  // IDs depend on the service profile, obtain them through a local-only preparation first.
  service.start('fixture',{action:'prepare'});await service.wait('fixture');let state=service.view('fixture');assert.equal(state.status,'prepared');assert.equal(calls.length,0);
  failId=state.sentences[1].id;
  service.start('fixture',config);await service.wait('fixture');state=service.view('fixture');assert.equal(state.status,'partial');assert.equal(calls.length,3);assert.deepEqual(calls.slice(1),[[failId],[failId]]);assert.equal(Object.keys(state.translations).length,3);
  const successful=Object.keys(state.translations);calls=[];failId=null;
  service.start('fixture',config);await service.wait('fixture');state=service.view('fixture');assert.equal(state.status,'complete');assert.deepEqual(calls,[[state.sentences[1].id]]);assert.ok(successful.every(id=>state.translations[id]));
  const filename=path.join(root,'sentence-translations','fixture','state.json');assert.ok(!fs.readFileSync(filename,'utf8').includes(config.key));
  calls=[];service.start('fixture',{...config,model:'new-model'});await service.wait('fixture');assert.equal(calls.flat().length,4,'provider/model change must invalidate translations');
  assert.throws(()=>service.start('fixture',{action:'unknown'}),{status:400});assert.throws(()=>service.view('missing'),{status:404});
  const app=express();app.use(express.json());installSentenceRoutes(app,service);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  try{const base='http://127.0.0.1:'+server.address().port+'/api/papers/fixture/sentences';assert.equal((await fetch(base)).status,200);assert.equal((await fetch(base,{method:'POST',headers:{'Content-Type':'application/json'},body:'{"action":"bad"}'})).status,400);}finally{await new Promise(resolve=>server.close(resolve));}
  let entered,release;const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  const slow=createSentenceService({root,getPaper:()=>paper,openPdf,requestJSON:async(c,m,s,b)=>{b.remaining--;entered();await gate;s.throwIfAborted();return {};}});
  slow.start('fixture',{...config,model:'slow'});await started;assert.throws(()=>slow.start('fixture',config),{status:409});
  const removing=slow.remove('fixture');assert.throws(()=>slow.start('fixture',config),{status:409});release();await removing;assert.ok(!fs.existsSync(filename));await slow.close();
  const scanRoot=path.join(root,'scan');fs.mkdirSync(scanRoot);fs.writeFileSync(path.join(scanRoot,'fixture.pdf'),testPdf());
  let corrected=false;
  const recognition={pdfHash:model.digest(testPdf()),ocrProvider:{layoutProfile:require('../layout-contract.cjs').layoutProfile()},pages:pages.map(p=>({...p,complete:true,sourceImage:'original.png',sourceKind:'original-render',blocks:p.blocks.map(b=>({...b,source:'pdf-layout-model',originalText:'',lines:[]}))}))};
  const scan=createSentenceService({root:scanRoot,getPaper:()=>paper,getRecognition:()=>corrected?{...recognition,pages:recognition.pages.map(p=>({...p,sourceKind:'deskewed'}))}:recognition,openPdf:async()=>({pageCount:2,async analyze(page){return {page,scanFallback:true,blocks:[],tasks:[]};},async close(){}})});
  try{scan.start('fixture',{action:'prepare'});await scan.wait('fixture');assert.equal(scan.view('fixture').status,'prepared');assert.ok(scan.view('fixture').sentences.every(s=>s.sourceRanges.every(r=>r.granularity==='block')));corrected=true;scan.start('fixture',{action:'prepare'});await scan.wait('fixture');assert.equal(scan.view('fixture').status,'error');assert.match(scan.view('fixture').error,/OCR/);}finally{await scan.close();}
  console.log('PASS: punctuation, decimals, abbreviations, math protection, stable IDs, exact source coverage, cross-column/page ranges, repeated margins, partial retry, cache invalidation, key isolation, HTTP routes, deletion/cancellation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await service.close();if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-sentences-'))fs.rmSync(root,{recursive:true,force:true});});
