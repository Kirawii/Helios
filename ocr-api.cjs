const fs = require('node:fs');
const path = require('node:path');
const {setMaxListeners} = require('node:events');
const {openPdf} = require('./pdf-document.cjs');
const {openPreparedPdf,prewarmPdf} = require('./pdf-pool.cjs');
const {runHybrid} = require('./ocr-hybrid.cjs');

const GROUNDING_PROMPT = '<image>\n<|grounding|>Convert the document to markdown.';
const cleanOutput = text => text.replace(/<｜end▁of▁sentence｜>|<\|(?:endoftext|end_of_sentence)\|>/g, '').trim();

// DeepSeek's reference implementation maps its grounding coordinates with /999.
function normalizeApiPage(answer, page, width, height) {
  const text = cleanOutput(answer);
  if (!text) throw Error('OCR API 返回了空页面');
  const matches = [...text.matchAll(/<\|ref\|>([\s\S]*?)<\|\/ref\|>\s*<\|det\|>([\s\S]*?)<\|\/det\|>/g)];
  const blocks = [];
  const types = {title: 'doc_title', sub_title: 'paragraph_title', subtitle: 'paragraph_title', text: 'text', equation: 'formula', equation_number: 'formula_number', caption: 'figure_title'};
  if (matches.length) {
    if ((text.match(/<\|ref\|>/g) || []).length !== matches.length || text.slice(0, matches[0].index).trim()) throw Error('OCR API 的位置标记不完整，请重试本页');
    for (let index = 0; index < matches.length; index++) {
      const match = matches[index];
      let regions;
      try { regions = JSON.parse(match[2]); } catch { throw Error('OCR API 返回了无效坐标'); }
      if (!Array.isArray(regions) || !regions.length || regions.some(box => !Array.isArray(box) || box.length !== 4 || box.some(value => !Number.isFinite(value) || value < 0 || value > 1000) || box[2] <= box[0] || box[3] <= box[1])) throw Error('OCR API 返回了无效坐标');
      regions = regions.map(box => box.map(value => Math.min(1, value / 999)));
      const label = match[1].trim();
      const content = text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim();
      const type = types[label] || (/^(image|figure|table|formula|header|footer|page_number|reference|chart|algorithm)$/.test(label) ? label : 'text');
      blocks.push({id: `p${page}-b${index}`, page, order: index + 1, sourceOrder: index + 1, type, rawType: label, text: content,
        bbox: [Math.min(...regions.map(box => box[0])), Math.min(...regions.map(box => box[1])), Math.max(...regions.map(box => box[2])), Math.max(...regions.map(box => box[3]))],
        regions, confidence: null, positionGranularity: 'block', format: type === 'formula' ? 'latex' : type === 'table' && /<table[\s>]/i.test(content) ? 'html' : 'markdown'});
    }
  } else {
    if (/<\|(?:ref|det|\/ref|\/det)\|>/.test(text)) throw Error('OCR API 的位置标记不完整，请重试本页');
    // A whole-page box describes page-level anchoring, never a detected text box.
    blocks.push({id: `p${page}-b0`, page, order: 1, sourceOrder: 1, type: 'text', text, bbox: [0, 0, 1, 1], confidence: null, positionGranularity: 'page', format: 'markdown'});
  }
  return {page, width, height, blocks, positionGranularity: matches.length ? 'block' : 'page',
    ...(matches.length ? {} : {warning: 'API 未返回文字位置，本页仅支持页级定位。'})};
}

class ApiOcrWorker {
  constructor({fetchImpl = fetch, openDocument = openPreparedPdf, timeoutMs = 180000} = {}) {
    this.fetchImpl = fetchImpl; this.openDocument = openDocument; this.timeoutMs = timeoutMs; this.controllers = new Set();
  }
  async request({path: filename, pageCount, pages, outputDirectory, config}, onEvent = () => {}, signal) {
    const requestStarted=performance.now();
    if (!config.key && config.strategy !== 'hybrid') throw Error('请填写硅基流动 OCR API Key，或配置 SILICONFLOW_API_KEY');
    const controller = new AbortController(); this.controllers.add(controller);
    const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    setMaxListeners(Math.max(32,(config.concurrency||8)+16),operationSignal);
    let document;
    try {
      operationSignal.throwIfAborted();
      onEvent({event: 'loading', device: 'api'});
      document = await this.openDocument(filename);
      operationSignal.throwIfAborted();
      if (document.pageCount !== pageCount) throw Error('PDF 页数与文献库不一致，请重新导入');
      if (!Array.isArray(pages) || pages.some(number => !Number.isSafeInteger(number) || number < 1 || number > pageCount) || new Set(pages).size !== pages.length) throw Error('OCR 请求页码无效');
      fs.mkdirSync(outputDirectory, {recursive: true});
      if(config.strategy === 'hybrid') return await runHybrid({document,payload:{path:filename,pageCount,pages,outputDirectory,config},onEvent,signal:operationSignal,worker:this,normalizeApiPage,requestStarted});
      for (const page of pages) {
        operationSignal.throwIfAborted();
        onEvent({event: 'progress', device: 'api', page});
        const image = await document.render(page, operationSignal);
        operationSignal.throwIfAborted();
        const result = await this.recognizeImage(image, config, operationSignal);
        const normalized = normalizeApiPage(result.text, page, image.width, image.height);
        operationSignal.throwIfAborted();
        const imageName = `page-${page}.png`;
        fs.writeFileSync(path.join(outputDirectory, imageName), image.png);
        // Only recognition content is retained; never persist request headers or keys.
        fs.writeFileSync(path.join(outputDirectory, `page-${page}.json`), JSON.stringify({provider: 'siliconflow', model: config.model, content: result.text, timing: {apiMs: result.apiMs}}));
        onEvent({event: 'page', data: {...normalized, sourceImage: imageName, sourceKind: 'original-render', runtime: {device: 'api', model: config.model}}});
      }
      return {signature: `SiliconFlow:${config.model}:144dpi:grounding-v1`};
    } catch (error) {
      operationSignal.throwIfAborted();
      if (error.name === 'TimeoutError') throw Error('OCR API 请求超时，已完成页面保留');
      // Do not expose arbitrary transport errors, which can contain credentials.
      if (/^(OCR |硅基流动 OCR|PDF 页数)/.test(error.message)) throw error;
      throw Error('OCR API 调用失败，请检查接口地址、模型和网络连接');
    } finally { this.controllers.delete(controller); await document?.close(); }
  }
  async recognizeImage(image, config, signal, kind='page') {
    const started=performance.now();
    const url=config.baseUrl.endsWith('/chat/completions')?config.baseUrl:config.baseUrl+'/chat/completions';
    const prompt=/deepseek.*ocr/i.test(config.model)?GROUNDING_PROMPT:kind==='formula'?'Formula Recognition:':'OCR:';
    try {
      const response=await this.fetchImpl(url,{method:'POST',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(this.timeoutMs)]),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+config.key},
        body:JSON.stringify({model:config.model,stream:false,temperature:0,max_tokens:config.maxTokens,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,'+image.png.toString('base64')}},{type:'text',text:prompt}]}]})});
      if(!response.ok){await response.body?.cancel();throw Error('硅基流动 OCR 接口返回 HTTP '+response.status+'，已完成区域保留');}
      const result=await response.json(),choice=result.choices?.[0];
      if(choice?.finish_reason!=='stop')throw Error(choice?.finish_reason==='length'?'OCR 输出被截断，请提高最大输出长度后重试':'OCR API 未完整结束识别');
      if(typeof choice.message?.content!=='string')throw Error('OCR API 未返回识别文字');
      return {text:choice.message.content,apiMs:performance.now()-started,...(Number.isFinite(result.usage?.completion_tokens)?{completionTokens:result.usage.completion_tokens}:{})};
    }catch(error){signal.throwIfAborted();if(error.name==='TimeoutError')throw Error('OCR API 请求超时，已完成区域保留');if(/^(OCR |硅基流动 OCR)/.test(error.message))throw error;throw Error('OCR API 调用失败，请检查接口地址、模型和网络连接');}
  }
  close() { for (const controller of this.controllers) controller.abort(); }
}

module.exports = {ApiOcrWorker, normalizeApiPage, openPdf, openPreparedPdf, prewarmPdf};
