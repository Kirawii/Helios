const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const express=require('express');
const {setTimeout:delay}=require('node:timers/promises');
const {createTranslationService,installTranslationRoutes}=require('../translation.cjs');
const {resolveOcrConfig}=require('../ocr-provider.cjs');
const {providerConfig}=require('../translation-model.cjs');
const {testPdf}=require('./test-pdf.cjs');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'helios-service-regressions-'));
const paper={id:'paper',title:'Synthetic fixture',pages:1};
const page={page:1,width:600,height:800,complete:true,blocks:[{id:'p1-b0',page:1,type:'text',order:1,text:'A paragraph with enough original text for the regression test.',bbox:[.1,.1,.9,.2]}]};
const worker={async request(payload,emit){emit({event:'page',data:structuredClone(page)});return {signature:'mock'};},close(){}};
const context={problem:[],method:[],results:[],terms:[],symbols:[]};
const answer=value=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}]}));
const config={baseUrl:'https://model.invalid/v1',model:'fixture',ocr:{mode:'local'}};
const cases=[];const test=(name,fn)=>cases.push({name,fn});
function fixture(name){const directory=path.join(root,name);fs.mkdirSync(directory);fs.writeFileSync(path.join(directory,'paper.pdf'),testPdf());return directory;}

test('one shared retry budget across transport and validation failures',async()=>{
  const originalFetch=global.fetch;
  try{
    for(const scenario of ['invalid-json','invalid-schema','translation-validation']){
      const directory=fixture(scenario);let calls=0,translationCalls=0;
      global.fetch=async(url,request)=>{
        const input=JSON.parse(JSON.parse(request.body).messages.at(-1).content);
        if(scenario==='translation-validation'&&!input.blocks)return answer(context);
        calls++;if(input.blocks)translationCalls++;
        if(calls%3)return new Response('',{status:503});
        return answer(scenario==='invalid-json'?'not JSON':scenario==='invalid-schema'?{}:{translations:[]});
      };
      const service=createTranslationService({root:directory,getPaper:()=>paper,worker});
      try{service.start('paper',config);await service.wait('paper');assert.equal(calls,3,scenario+' exceeded its request budget');if(scenario==='translation-validation'){assert.equal(translationCalls,3);assert.equal(service.view('paper').status,'partial');}}
      finally{await service.close();}
    }
  }finally{global.fetch=originalFetch;}
});

test('environment credentials require an exact trusted origin',async()=>{
  const saved={key:process.env.SILICONFLOW_API_KEY,url:process.env.HELIOS_OCR_API_URL,deepseek:process.env.DEEPSEEK_API_KEY};
  process.env.SILICONFLOW_API_KEY='SYNTHETIC-ENV-KEY';delete process.env.HELIOS_OCR_API_URL;
  try{
    const key=url=>resolveOcrConfig({mode:'api',baseUrl:url}).key;
    assert.equal(key('https://api.siliconflow.cn/v1'),'SYNTHETIC-ENV-KEY');assert.equal(key('https://api.siliconflow.com/v1'),'SYNTHETIC-ENV-KEY');
    for(const url of ['http://api.siliconflow.cn/v1','https://api.siliconflow.cn:9443/v1','https://api.siliconflow.cn.evil.invalid/v1'])assert.equal(key(url),'',url);
    process.env.HELIOS_OCR_API_URL='https://internal.invalid:8443/v1';
    assert.equal(key('https://internal.invalid:8443/v2'),'SYNTHETIC-ENV-KEY');assert.equal(key('http://internal.invalid:8443/v1'),'');assert.equal(key('https://internal.invalid:9443/v1'),'');
    assert.equal(resolveOcrConfig({mode:'api',baseUrl:'http://localhost:1234/v1',key:'OWN-KEY'}).key,'OWN-KEY');
    process.env.HELIOS_OCR_API_URL='http://localhost:8123/v1';assert.equal(key('http://localhost:8123/v2'),'SYNTHETIC-ENV-KEY');assert.equal(key('http://localhost:8124/v1'),'');
    process.env.DEEPSEEK_API_KEY='SYNTHETIC-DEEPSEEK-KEY';
    assert.equal(providerConfig({baseUrl:'https://api.deepseek.com/v1',model:'fixture'}).key,'SYNTHETIC-DEEPSEEK-KEY');
    assert.equal(providerConfig({baseUrl:'http://api.deepseek.com/v1',model:'fixture'}).key,'');assert.equal(providerConfig({baseUrl:'https://api.deepseek.com:9443/v1',model:'fixture'}).key,'');
  }finally{for(const [name,value] of [['SILICONFLOW_API_KEY',saved.key],['HELIOS_OCR_API_URL',saved.url],['DEEPSEEK_API_KEY',saved.deepseek]]){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});

test('HTTP deletion waits for recognition and prevents state resurrection',async()=>{
  const directory=fixture('deletion'),other={...paper,id:'other'};fs.writeFileSync(path.join(directory,'other.pdf'),testPdf());fs.writeFileSync(path.join(directory,'library.json'),JSON.stringify([paper,other]));
  process.env.MOON_DATA_DIR=directory;
  const app=require('../server.cjs');let aborted,release;
  const cancelled=new Promise(resolve=>{aborted=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const slowWorker={close(){},async request(payload,emit,signal){
    emit({event:'progress',page:1,timing:{totalMs:1}});
    await new Promise(resolve=>signal.addEventListener('abort',()=>{aborted();resolve();},{once:true}));
    await gate;signal.throwIfAborted();
  }};
  const service=createTranslationService({root:directory,getPaper:id=>id==='paper'?paper:id==='other'?other:null,worker:slowWorker});
  Object.assign(app.locals.translationService,service);
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  let deletion;
  try{
    service.recognize('paper');const running=service.wait('paper');
    deletion=fetch('http://127.0.0.1:'+server.address().port+'/api/papers/paper',{method:'DELETE'});
    await cancelled;
    assert.ok(fs.existsSync(path.join(directory,'paper.pdf')),'PDF removed before the task exited');
    assert.throws(()=>service.recognize('paper'),error=>error.status===409,'New work must be rejected while deleting');
    release();assert.equal((await deletion).status,200);await running;await delay(150);
    assert.equal(fs.existsSync(path.join(directory,'translations','paper')),false,'Deleted recognition state was recreated');
    assert.equal(fs.existsSync(path.join(directory,'paper.pdf')),false);
    const library=JSON.parse(fs.readFileSync(path.join(directory,'library.json')));assert.deepEqual(library.map(p=>p.id),['other']);assert.ok(fs.existsSync(path.join(directory,'other.pdf')));
  }finally{release();await deletion?.catch(()=>{});await service.close();await new Promise(resolve=>server.close(resolve));}
});

test('recognition routes distinguish internal failures from client errors',async()=>{
  const app=express();app.use(express.json());
  const service={view(id){if(id==='missing')throw Object.assign(Error('missing paper'),{status:404});if(id==='conflict')throw Object.assign(Error('conflict'),{status:409});throw Object.assign(Error('INTERNAL-PATH-AND-SECRET'),{code:'EIO'});}};
  installTranslationRoutes(app,service);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const originalError=console.error;console.error=()=>{};
  try{for(const endpoint of ['translation','recognition']){
    const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/papers/internal/'+endpoint);assert.equal(response.status,500);assert.equal(JSON.stringify(await response.json()).includes('INTERNAL-PATH-AND-SECRET'),false);
    for(const [id,status] of [['missing',404],['conflict',409]])assert.equal((await fetch('http://127.0.0.1:'+server.address().port+'/api/papers/'+id+'/'+endpoint)).status,status);
  }}finally{console.error=originalError;await new Promise(resolve=>server.close(resolve));}
});

test('invalid recognition input remains a client error',async()=>{
  const directory=fixture('invalid-input'),service=createTranslationService({root:directory,getPaper:id=>id==='paper'?paper:null,worker});
  const app=express();app.use(express.json());installTranslationRoutes(app,service);const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+server.address().port+'/api/papers/paper';
  try{
    for(const [endpoint,body] of [['recognition',{ocr:{mode:'invalid'}}],['translation',{baseUrl:'not-a-url',model:'fixture'}],['translation',[]]]){
      const response=await fetch(base+'/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});assert.equal(response.status,400);
    }
    const response=await fetch(base+'/recognition',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:service.view('paper').revision,texts:{'p1-b0':123}})});assert.equal(response.status,400);
  }finally{await service.close();await new Promise(resolve=>server.close(resolve));}
});

(async()=>{
  let failures=0;
  try{for(const {name,fn} of cases){try{await fn();console.log('PASS: '+name);}catch(error){failures++;console.error('FAIL: '+name+' — '+error.message);}}}
  finally{if(path.dirname(root)===path.resolve(os.tmpdir())&&path.basename(root).startsWith('helios-service-regressions-'))fs.rmSync(root,{recursive:true,force:true});}
  if(failures)process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
