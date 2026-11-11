const fs=require('node:fs'),path=require('node:path');
const model=require('./translation-model.cjs');
const {buildSentences,protectSentence,translationParts,PROFILE}=require('./sentences.cjs');
const {openPreparedPdf}=require('./pdf-pool.cjs');
const {layoutMode,layoutProvider,layoutProfile,MODEL}=require('./layout-contract.cjs');
const {clientError,sendHttpError}=require('./http-error.cjs');

function createSentenceService({root,getPaper,getRecognition=()=>null,openPdf=openPreparedPdf,requestJSON=model.requestJSON}={}){
  const states=new Map(),jobs=new Map(),deleting=new Set(),retired=new WeakSet();
  const profile=model.digest([PROFILE,layoutMode(),layoutProvider(),MODEL.sha256,...['sentences.cjs','pdf-layout-model.cjs','pdf-native.cjs','layout-contract.cjs','translation-model.cjs'].map(f=>fs.readFileSync(path.join(__dirname,f),'utf8'))]);
  const directory=id=>path.join(root,'sentence-translations',id);
  function load(id){
    if(deleting.has(id))throw clientError('论文正在删除',409);
    if(!getPaper(id))throw clientError('论文不存在',404);
    if(states.has(id))return states.get(id);
    const pdfHash=model.digest(fs.readFileSync(path.join(root,id+'.pdf'))),filename=path.join(directory(id),'state.json');
    let state=fs.existsSync(filename)?JSON.parse(fs.readFileSync(filename,'utf8')):null;
    if(!state||state.pdfHash!==pdfHash||state.profile!==profile){
      if(state)fs.copyFileSync(filename,path.join(directory(id),'before-'+model.digest(state).slice(0,16)+'.json'));
      state={version:1,paperId:id,pdfHash,profile,revision:0,pages:[],sentences:[],translations:{},errors:{},excluded:[],warnings:[],status:'idle',stage:'prepare',progress:{done:0,total:0}};
    }
    if(state.status==='running')state.status='cancelled';states.set(id,state);return state;
  }
  function persist(state){
    if(retired.has(state))return;
    state.revision++;state.updatedAt=new Date().toISOString();fs.mkdirSync(directory(state.paperId),{recursive:true});
    const target=path.join(directory(state.paperId),'state.json');fs.writeFileSync(target+'.tmp',JSON.stringify(state));fs.renameSync(target+'.tmp',target);
  }
  const view=id=>({...load(id),active:jobs.has(id)});
  async function prepare(state,signal){
    state.stage='prepare';state.progress={done:0,total:getPaper(state.paperId).pages};persist(state);
    let document;
    try{
      document=await openPdf(path.join(root,state.paperId+'.pdf'),{signal});
      const recognition=getRecognition(state.paperId),pages=[];
      for(let number=1;number<=document.pageCount;number++){
        signal.throwIfAborted();let page=await document.analyze(number,signal);
        const recognized=recognition?.pdfHash===state.pdfHash?recognition.pages?.find?.(p=>p.page===number)||recognition.pages?.[number]:null;
        // Corrected/deskewed images need their own coordinate system; don't attach their boxes to the original PDF.
        if(recognition?.ocrProvider?.layoutProfile===layoutProfile()&&recognized?.complete&&recognized.blocks?.length&&(!recognized.sourceImage||recognized.sourceKind==='original-render')&&recognized.blocks.every(b=>b.source==='pdf-layout-model')){
          const overrides=recognition.overrides||{};
          page={...page,blocks:recognized.blocks.map(b=>{
            const override=overrides[b.id];
            if(override!==undefined)return {...b,text:override,originalText:override,lines:[],mathReplacements:[]};
            if(!b.originalText&&b.text)return {...b,originalText:b.text,lines:[]};
            const native=page.blocks.find(n=>n.id===b.id&&n.originalText===b.originalText);
            return native?{...b,lines:native.lines}:b;
          }),tasks:page.tasks};
        }
        // Scan pages without completed OCR cannot be silently counted as translated.
        if(page.scanFallback&&!page.blocks.some(b=>!model.mediaBlock(b)&&!model.ignoredBlock(b)&&b.text?.trim()))throw clientError(`第 ${number} 页缺少可用文字，请先在 OCR 调试页完成识别`);
        pages.push(page);state.progress.done=number;persist(state);await document.releasePage?.(number);
      }
      signal.throwIfAborted();
      const built=buildSentences(pages,{pdfHash:state.pdfHash,profile});
      if(!built.sentences.length)throw clientError('没有可翻译的句子，请先完成 OCR');
      const sourceHash=model.digest(built.sentences);
      if(state.sourceHash!==sourceHash)state.translations={};
      Object.assign(state,built,{pages,sourceHash,profile,status:'prepared',stage:'translate',errors:{},progress:{done:0,total:built.sentences.length}});
      state.progress.done=built.sentences.filter(s=>state.translations[s.id]).length;persist(state);
    }finally{await document?.close();}
  }
  async function translate(state,config,signal){
    const fingerprint=model.digest([state.sourceHash,config.baseUrl,config.protocol,config.model,'zh-sentence-v1']);
    if(state.translationFingerprint!==fingerprint)state.translations={};
    state.translationFingerprint=fingerprint;state.stage='translate';state.errors={};
    const pending=state.sentences.filter(s=>!state.translations[s.id]).map(protectSentence);
    const context={problem:[],method:[],results:[],terms:[],symbols:[]};
    state.progress={done:state.sentences.length-pending.length,total:state.sentences.length};persist(state);
    for(const batch of model.chunkItems(pending,6500)){
      signal.throwIfAborted();let remaining=batch;const budget=model.requestBudget();
      if(batch.some(s=>s.text.length>18000)){for(const s of batch)state.errors[s.id]='单句过长，请核对断句后重试';persist(state);continue;}
      while(remaining.length&&budget.remaining>0){
        signal.throwIfAborted();
        try{
          const messages=model.translationMessages(context,remaining,[]);
          messages[0].content+=' 每个块是一句原文；逐句输出中文，每个 ID 与原句一一对应。可能是标题或未完句，忠实翻译现有内容。';
          const raw=await requestJSON(config,messages,signal,budget);signal.throwIfAborted();
          const checked=model.validateTranslations(raw,remaining);
          for(const unit of remaining){
            if(checked.results.has(unit.id)){
              state.translations[unit.id]={text:checked.results.get(unit.id),parts:translationParts(raw.translations.find(t=>t.id===unit.id).text,unit),updatedAt:new Date().toISOString()};delete state.errors[unit.id];
            }else state.errors[unit.id]=checked.errors.get(unit.id);
          }
          remaining=remaining.filter(s=>!checked.results.has(s.id));
        }catch(error){signal.throwIfAborted();for(const unit of remaining)state.errors[unit.id]=error.message;if(error.failedRequest)break;}
        state.progress.done=state.sentences.filter(s=>state.translations[s.id]).length;persist(state);
      }
      // Keep successes so retry only submits missing/invalid sentences.
      for(const unit of remaining)state.errors[unit.id]||='模型请求次数已耗尽';
    }
    state.status=Object.keys(state.errors).length?'partial':'complete';persist(state);
  }
  function start(id,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||!['prepare','translate'].includes(input.action))throw clientError('请选择 prepare 或 translate');
    const state=load(id);if(jobs.has(id))throw clientError('该论文已有任务运行中',409);
    const config=input.action==='translate'?model.providerConfig(input):null;
    const controller=new AbortController(),job={controller};jobs.set(id,job);state.status='running';state.error=null;persist(state);
    job.promise=(async()=>{
      try{
        // Rebuild from current OCR revision on every explicit start, reusing cached local layouts.
        await prepare(state,controller.signal);state.status='running';persist(state);
        if(config)await translate(state,config,controller.signal);else{state.status='prepared';persist(state);}
      }catch(error){state.status=controller.signal.aborted?'cancelled':'error';state.error=controller.signal.aborted?'任务已取消':error.message;persist(state);}
      finally{if(jobs.get(id)===job)jobs.delete(id);}
    })();return view(id);
  }
  function cancel(id){load(id);jobs.get(id)?.controller.abort(Error('任务已取消'));return view(id);}
  async function remove(id){
    deleting.add(id);const state=states.get(id);if(state)retired.add(state);
    const job=jobs.get(id);job?.controller.abort(Error('论文已删除'));
    try{await job?.promise;states.delete(id);fs.rmSync(directory(id),{recursive:true,force:true});}finally{deleting.delete(id);}
  }
  return {view,start,cancel,remove,wait:id=>jobs.get(id)?.promise||Promise.resolve(),async close(){for(const job of jobs.values())job.controller.abort(Error('服务关闭'));await Promise.allSettled([...jobs.values()].map(j=>j.promise));}};
}
function installSentenceRoutes(app,service){
  const route=fn=>(q,r)=>{try{r.json(fn(q));}catch(error){sendHttpError(r,error);}};
  app.get('/api/papers/:id/sentences',route(q=>service.view(q.params.id)));
  app.post('/api/papers/:id/sentences',route(q=>service.start(q.params.id,q.body)));
  app.post('/api/papers/:id/sentences/cancel',route(q=>service.cancel(q.params.id)));
}
module.exports={createSentenceService,installSentenceRoutes};
