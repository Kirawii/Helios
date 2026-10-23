const assert=require('node:assert/strict'),http=require('node:http');
const {handler,endpoint}=require('../ai.cjs');
const express=require('express');
(async()=>{
 let received;const model=http.createServer(async(req,res)=>{let input='';for await(const chunk of req)input+=chunk;received=JSON.parse(input);if(received.model==='error'){res.writeHead(503);res.end('offline');return}const ollama=req.url==='/api/chat';res.setHeader('Content-Type',ollama?'application/x-ndjson':'text/event-stream');const frame=text=>ollama?JSON.stringify({message:{content:text}})+'\n':'data: '+JSON.stringify({choices:[{delta:{content:text}}]})+'\n\n';res.write(frame('中文'));setTimeout(()=>res.end(frame('逐字输出')+(ollama?'':'data: [DONE]\n\n')),20)});
 await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));const modelBase='http://127.0.0.1:'+model.address().port;
 const app=express();app.use(express.json());app.post('/api/ai',handler(()=>[{id:'main',title:'Main paper',text:'Primary evidence'},{id:'ref',title:'Reference paper',text:'Additional evidence'}]));const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.on('listening',resolve));const url='http://127.0.0.1:'+server.address().port+'/api/ai';
 try{for(const protocol of ['ollama','openai']){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:modelBase,protocol,model:'test',paperId:'main',stream:true,referenceIds:['ref'],question:'What is supported?'})});assert.equal(response.status,200);const frames=(await response.text()).trim().split('\n').map(JSON.parse);assert.equal(frames.map(f=>f.delta||'').join(''),'中文逐字输出');assert.equal(frames.at(-1).done,true);assert.match(received.messages[0].content,/Reference paper/);assert.match(received.messages[0].content,/Additional evidence/)}
 const error=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({baseUrl:modelBase,protocol:'ollama',model:'error',paperId:'main',stream:true})});assert.equal(error.status,502);assert.match((await error.json()).error,/503/);
 assert.equal(endpoint('http://localhost:11434','ollama').url,'http://localhost:11434/api/chat');assert.equal(endpoint('http://localhost:1234/v1/','openai').url,'http://localhost:1234/v1/chat/completions');
 console.log('PASS: Ollama NDJSON, OpenAI SSE, UTF-8 streamed text, selected reference context, upstream failures, endpoint normalization');
 }finally{server.close();model.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
