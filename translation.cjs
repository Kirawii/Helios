const fs = require('node:fs');
const path = require('node:path');
const {OcrProvider, resolveOcrConfig, publicOcrConfig, ocrFingerprint} = require('./ocr-provider.cjs');
const model = require('./translation-model.cjs');
const {readingOrder} = require('./recognition-order.cjs');

const VERSION = 1;
const OCR_PROFILE = 'structurev3-3.7.0-pdfium-144dpi-utf8-all-features-quality-v4';
const CONTEXT_PROFILE = 'evidence-context-v1';
const TRANSLATION_PROFILE = 'zh-protected-v1';

function createTranslationService({root, getPaper, worker = new OcrProvider(), requestJSON = model.requestJSON}) {
  const states = new Map(), jobs = new Map();
  const stateDirectory = id => path.join(root, 'translations', id);
  const initialState = (id, pdfHash, pageCount) => ({version: VERSION, paperId: id, pdfHash, ocrProfile: OCR_PROFILE, revision: 0, pages: {}, overrides: {}, context: null, contextOverride: null, contextFingerprint: '', analysisCache: {}, translations: {}, errors: {}, status: 'idle', stage: 'ocr', progress: {done: 0, total: pageCount}, stale: false});
  const getBlocks = state => {
    let order = 0;
    return Object.values(state.pages).sort((first, second) => first.page - second.page)
      .flatMap(page => readingOrder(page.blocks).map(block => ({...block, text: state.overrides[block.id] ?? block.text})))
      .map(block => ({...block, order: model.ignoredBlock(block) ? null : ++order}));
  };
  const pendingWrites=new Map();
  const writeState = state => {
    const directory = stateDirectory(state.paperId);
    fs.mkdirSync(directory, {recursive: true});
    const filename = path.join(directory, 'state.json');
    fs.writeFileSync(filename + '.tmp', JSON.stringify(state)); fs.renameSync(filename + '.tmp', filename);
  };
  const persist = (state,defer=false) => {
    state.updatedAt=new Date().toISOString();state.revision++;
    if(defer){if(!pendingWrites.has(state.paperId)){const timer=setTimeout(()=>{pendingWrites.delete(state.paperId);writeState(state);},100);timer.unref();pendingWrites.set(state.paperId,timer);}return;}
    clearTimeout(pendingWrites.get(state.paperId));pendingWrites.delete(state.paperId);writeState(state);
  };
  function load(id) {
    const paper = getPaper(id);
    if (!paper) { const error = Error('论文不存在'); error.status = 404; throw error; }
    if (states.has(id)) return states.get(id);
    const pdfHash = model.digest(fs.readFileSync(path.join(root, id + '.pdf')));
    const filename = path.join(stateDirectory(id), 'state.json');
    let state = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    if (!state || state.version !== VERSION || state.pdfHash !== pdfHash || state.ocrProfile !== OCR_PROFILE) {
      if (state) {
        const backup = path.join(stateDirectory(id), 'state-before-' + model.digest(state).slice(0, 16) + '.json');
        if (!fs.existsSync(backup)) fs.copyFileSync(filename, backup);
      }
      state = initialState(id, pdfHash, paper.pages);
    }
    if (state.status === 'running') { state.status = 'interrupted'; state.error = state.mode === 'recognition' ? '服务已重启，点击继续识别即可恢复' : '服务已重启；重新提供模型密钥后可继续'; persist(state); }
    states.set(id, state); return state;
  }
  function view(id) {
    const state = load(id), blocks = getBlocks(state);
    return {...state, analysisCache: undefined, pages: Object.values(state.pages).sort((first, second) => first.page - second.page).map(page => ({...page, blocks: blocks.filter(block => block.page === page.page)})), blocks, active: jobs.has(id)};
  }
  function start(id, input = {}, recognitionOnly = false) {
    const state = load(id);
    if (jobs.has(id)) { const error = Error('这篇论文已有翻译任务正在运行'); error.status = 409; throw error; }
    const config = recognitionOnly ? null : model.providerConfig(input);
    const ocr = resolveOcrConfig(input.ocr, state.ocrProvider);
    const fingerprint = ocrFingerprint(ocr);
    const previousFingerprint = state.ocrFingerprint || ocrFingerprint({mode: 'local'});
    const changedOcr = previousFingerprint !== fingerprint;
    const paper = getPaper(id);
    if (ocr.mode === 'api' && ocr.strategy !== 'hybrid' && !ocr.key && (changedOcr || Object.keys(state.pages).length < paper.pages)) throw Error('请填写硅基流动 OCR API Key，或配置 SILICONFLOW_API_KEY');
    if (changedOcr) {
      if (Object.keys(state.pages).length || Object.keys(state.overrides).length) {
        const directory = stateDirectory(id); fs.mkdirSync(directory, {recursive: true});
        const backup = path.join(directory, 'state-before-' + model.digest(state).slice(0, 16) + '.json');
        if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify(state));
      }
      const fresh = initialState(id, state.pdfHash, paper.pages), revision = state.revision;
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, fresh, {revision, assetDirectory: 'pages-' + fingerprint.slice(0, 16)});
    }
    state.ocrProvider = publicOcrConfig(ocr); state.ocrFingerprint = fingerprint;
    const providerFingerprint = config ? model.digest({baseUrl: config.baseUrl, model: config.model, protocol: config.protocol}) : state.providerFingerprint;
    if (input.force) { state.generation = (state.generation || 0) + 1; state.stale = true; }
    if (state.providerFingerprint && state.providerFingerprint !== providerFingerprint) state.stale = true;
    state.providerFingerprint = providerFingerprint;
    if (config) state.provider = {baseUrl: config.baseUrl, model: config.model, protocol: config.protocol};
    state.mode = recognitionOnly ? 'recognition' : 'translation';
    state.status = 'running'; state.error = null; state.startedAt = new Date().toISOString(); state.ocrTiming = null;
    const controller = new AbortController();
    const job = {controller}; jobs.set(id, job); persist(state);
    job.promise = run(state, config, controller.signal, recognitionOnly, ocr).catch(error => {
      state.status = controller.signal.aborted ? 'cancelled' : 'failed';
      state.error = controller.signal.aborted ? '已停止，已完成的内容保留，可继续处理' : [config?.key, ocr.key].filter(Boolean).reduce((message, key) => message.split(key).join('[已隐藏]'), String(error.message || '处理失败'));
    }).finally(() => { jobs.delete(id); persist(state); });
    return view(id);
  }
  async function run(state, config, signal, recognitionOnly, ocr) {
    const paper = getPaper(state.paperId);
    const pageNumbers = Array.from({length: paper.pages}, (_, index) => index + 1);
    const completed = page => state.pages[page] && state.pages[page].complete !== false;
    const missing = pageNumbers.filter(page => !completed(page));
    state.stage = 'ocr'; state.ocrPhase = 'queued'; state.ocrPage = null; state.progress = {done: paper.pages - missing.length, total: paper.pages}; persist(state);
    if (missing.length) {
      const result = await worker.request({path: path.join(root, state.paperId + '.pdf'), pageCount: paper.pages, pages: missing, outputDirectory: path.join(stateDirectory(state.paperId), state.assetDirectory || 'pages'), ocr}, event => {
        signal.throwIfAborted();
        if (event.event === 'queued' || event.event === 'loading' || event.event === 'progress') {
          state.ocrPhase = event.event === 'progress' ? 'recognizing' : event.event;
          if (event.device) state.ocrDevice = event.device;
          state.ocrPage = event.page || null; state.ocrStep = event.step || null;
          if(event.timing)state.ocrTiming=event.timing;
          persist(state,Boolean(event.timing)); return;
        }
        if (event.event !== 'page' && event.event !== 'draft') return;
        const page = event.data;
        if (!missing.includes(page.page) || !Array.isArray(page.blocks)) throw Error('OCR 返回了错误页码');
        const ids = new Set();
        for (const block of page.blocks) {
          if (block.page !== page.page || !/^p\d+-b[\w-]+$/.test(block.id) || ids.has(block.id) || typeof block.text !== 'string' || !Array.isArray(block.bbox) || block.bbox.length !== 4 || block.bbox.some(value => !Number.isFinite(value) || value < 0 || value > 1) || block.bbox[2] <= block.bbox[0] || block.bbox[3] <= block.bbox[1]) throw Error('OCR 文本块或坐标无效');
          ids.add(block.id);
        }
        state.pages[page.page] = page; state.progress.done = pageNumbers.filter(completed).length; persist(state,event.event==='draft');
      }, signal);
      state.parser = result.signature;
      if(result.timing)state.ocrTiming=result.timing;
    }
    signal.throwIfAborted();
    if (pageNumbers.some(page => !state.pages[page])) throw Error('OCR 遗漏了页面，未启动翻译');
    if(pageNumbers.some(page=>!completed(page))) {
      state.status='partial';state.stage='ocr';state.ocrPhase='done';
      state.error=(Object.values(state.pages).some(page=>page.sourceKind==='pdf-native')?'文字层已提取，部分图像/公式尚未识别完成。':'部分页面/区域尚未识别完成。')+'继续处理会复用已完成区域。';
      return;
    }
    const blocks = getBlocks(state);
    if (!blocks.some(block => block.text.trim())) throw Error('没有识别到可读内容，请检查扫描清晰度');
    if (recognitionOnly) {
      state.status = 'recognized'; state.stage = 'layout'; state.ocrPhase = 'done';
      const visible = blocks.filter(block => !model.ignoredBlock(block));
      state.progress = {done: visible.length, total: visible.length};
      return;
    }
    const sourceFingerprint = model.digest(blocks.map(({id, text, type}) => ({id, text, type})));
    const contextKey = model.digest([sourceFingerprint, CONTEXT_PROFILE, state.providerFingerprint]);
    state.stage = 'analysis';
    if (state.contextSourceFingerprint !== contextKey || !state.context) {
      const chunks = model.chunkItems(model.analysisInput(blocks));
      let analyses = [];
      state.progress = {done: 0, total: chunks.length}; persist(state);
      for (const chunk of chunks) {
        signal.throwIfAborted();
        const cacheKey = model.digest([chunk, state.providerFingerprint, CONTEXT_PROFILE]);
        let context = state.analysisCache[cacheKey];
        if (!context) {
          context = await validatedAnalysis(model.analysisMessages(paper.title, chunk), chunk, config, signal);
          state.analysisCache[cacheKey] = context;
        }
        analyses.push(context); state.progress.done++; persist(state);
      }
      while (analyses.length > 1) {
        const groups = model.chunkItems(analyses, 24000);
        const merged = [];
        for (let index = 0; index < groups.length; index++) {
          signal.throwIfAborted();
          const group = groups[index];
          if (group.length === 1 && analyses.length > 1 && groups.length === analyses.length) {
            const next = analyses[index + 1];
            if (next) { group.push(next); index++; }
          }
          merged.push(group.length === 1 ? group[0] : await validatedAnalysis(model.analysisMessages(paper.title, group, true), blocks, config, signal));
        }
        analyses = merged;
      }
      state.context = analyses[0]; state.contextSourceFingerprint = contextKey;
      if (state.contextOverride) {
        for (const field of ['terms', 'symbols']) {
          const key = field === 'terms' ? 'term' : 'symbol';
          state.context[field] = state.context[field].map(entry => {
            const override = (state.contextOverride[field] || []).find(candidate => candidate[key] === entry[key]);
            return override ? {...entry, meaning: override.meaning, ...(field === 'terms' ? {translation: override.translation} : {})} : entry;
          });
        }
      }
      state.contextFingerprint = model.digest(state.context); persist(state);
    }
    const context = state.context;
    const translationFingerprint = model.digest([sourceFingerprint, state.contextFingerprint, state.providerFingerprint, TRANSLATION_PROFILE, state.generation || 0]);
    state.translationFingerprint = translationFingerprint;
    state.stage = 'translation'; state.errors = {};
    const candidates = blocks.filter(model.translatable);
    state.progress = {done: 0, total: candidates.length}; persist(state);
    for (let index = 0; index < candidates.length; index++) {
      signal.throwIfAborted();
      const block = candidates[index];
      const sourceHash = model.digest(block.text);
      const existing = state.translations[block.id];
      if (existing?.sourceHash === sourceHash && existing.contextHash === translationFingerprint) { state.progress.done++; continue; }
      const segments = model.splitText(block.text);
      const symbols = context.symbols.map(entry => entry.symbol);
      const units = segments.map((original, part) => ({id: block.id + '~' + part, original, ...model.protectText(original, symbols)}));
      const translated = new Map();
      let failure = '';
      for (const batch of model.chunkItems(units, 6500)) {
        let pending = batch;
        for (let attempt = 0; attempt < 3 && pending.length; attempt++) {
          signal.throwIfAborted();
          try {
            const sourceIndex = blocks.findIndex(source => source.id === block.id);
            const neighbors = [blocks[sourceIndex - 1], blocks[sourceIndex + 1]].filter(Boolean).map(source => ({id: source.id, text: source.text.slice(0, 2000)}));
            const value = await requestJSON(config, model.translationMessages(context, pending, neighbors), signal);
            const result = model.validateTranslations(value, pending);
            for (const [unitId, text] of result.results) translated.set(unitId, text);
            pending = pending.filter(unit => !result.results.has(unit.id));
            failure = [...result.errors.values()].join('；');
          } catch (error) { signal.throwIfAborted(); if (error.failedRequest) throw error; failure = error.message; }
        }
        if (pending.length) break;
      }
      if (translated.size === units.length) {
        state.translations[block.id] = {text: units.map(unit => translated.get(unit.id)).join('\n'), sourceHash, contextHash: translationFingerprint, updatedAt: new Date().toISOString()};
      } else state.errors[block.id] = failure || '译文校验未通过';
      state.progress.done = index + 1; persist(state);
    }
    state.stale = Object.keys(state.errors).length > 0;
    state.status = state.stale ? 'partial' : 'completed'; state.stage = 'done';
    state.error = state.stale ? '部分段落未通过校验，可重试；已有译文已保留' : null;
  }
  async function validatedAnalysis(messages, blocks, config, signal) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      try { return model.validateContext(await requestJSON(config, messages, signal), blocks); }
      catch (error) { signal.throwIfAborted(); if (error.failedRequest) throw error; lastError = error; }
    }
    throw lastError;
  }
  function correct(id, input, recognitionOnly = false) {
    const state = load(id);
    if (jobs.has(id)) { const error = Error('请先停止当前翻译，再保存校对'); error.status = 409; throw error; }
    if (input.revision !== state.revision) { const error = Error('内容已更新，请重新打开校对窗口'); error.status = 409; throw error; }
    const blocks = getBlocks(state), ids = new Set(blocks.map(block => block.id));
    const corrections = input.texts || {};
    if (typeof corrections !== 'object' || Array.isArray(corrections) || Object.entries(corrections).some(([blockId, text]) => !ids.has(blockId) || typeof text !== 'string' || !text.trim() || text.length > 100000)) throw Error('校对文本或块 ID 无效');
    let context;
    if (input.context) context = model.validateContext(input.context, blocks.map(block => ({...block, text: corrections[block.id] ?? block.text})));
    const sourceChanged = Object.entries(corrections).some(([blockId, text]) => state.overrides[blockId] !== text && blocks.find(block => block.id === blockId).text !== text);
    Object.assign(state.overrides, corrections);
    if (sourceChanged) state.contextSourceFingerprint = '';
    if (context) {
      const overrides = state.contextOverride || {terms: [], symbols: []};
      for (const field of ['terms', 'symbols']) {
        const key = field === 'terms' ? 'term' : 'symbol';
        for (const entry of context[field]) {
          const previous = state.context?.[field].find(candidate => candidate[key] === entry[key]);
          if (!previous || previous.meaning !== entry.meaning || previous.translation !== entry.translation) {
            overrides[field] = overrides[field].filter(candidate => candidate[key] !== entry[key]);
            overrides[field].push(entry);
          }
        }
      }
      state.context = context; state.contextFingerprint = model.digest(context);
      state.contextOverride = overrides;
    }
    state.stale = true; state.status = recognitionOnly ? 'recognized' : 'idle';
    if (recognitionOnly) state.stage = 'layout';
    state.error = null; persist(state); return view(id);
  }
  async function cancel(id) {
    const job = jobs.get(id);
    if (job) { job.controller.abort(); await job.promise; }
    return view(id);
  }
  function remove(id) {
    jobs.get(id)?.controller.abort();
    states.delete(id);
  }
  async function close() {
    for (const job of jobs.values()) job.controller.abort();
    await Promise.allSettled([...jobs.values()].map(job => job.promise)); worker.close?.();
  }
  function sourceAsset(id, pageNumber, format = 'png') {
    const state = load(id), number = Number(pageNumber), page = state.pages[number];
    if (!Number.isSafeInteger(number) || number < 1 || !page || (format === 'png' && !page.sourceImage) || !['png', 'json'].includes(format)) {
      const error = Error('识别页面不存在'); error.status = 404; throw error;
    }
    return {filename: 'page-' + number + '.' + format, directory: path.join(stateDirectory(id), state.assetDirectory || 'pages')};
  }
  return {view, sourceAsset, start, recognize: (id, input) => start(id, input, true), correct, cancel, remove, close, wait: id => jobs.get(id)?.promise};
}

function installTranslationRoutes(app, service) {
  const wrap = handler => async (request, response) => {
    try { await handler(request, response); } catch (error) { response.status(error.status || 400).json({error: error.message}); }
  };
  app.get('/api/papers/:id/translation', wrap((request, response) => response.json(service.view(request.params.id))));
  app.post('/api/papers/:id/translation', wrap((request, response) => response.status(202).json(service.start(request.params.id, request.body))));
  app.patch('/api/papers/:id/translation', wrap((request, response) => response.json(service.correct(request.params.id, request.body))));
  app.post('/api/papers/:id/translation/cancel', wrap(async (request, response) => response.json(await service.cancel(request.params.id))));
  app.get('/api/papers/:id/recognition', wrap((request, response) => response.json(service.view(request.params.id))));
  for (const [suffix, format] of [['image', 'png'], ['raw', 'json']]) app.get('/api/papers/:id/recognition/pages/:page/' + suffix, wrap((request, response) => {
    const asset = service.sourceAsset(request.params.id, request.params.page, format);
    response.sendFile(asset.filename, {root: asset.directory, dotfiles: 'allow'});
  }));
  app.post('/api/papers/:id/recognition', wrap((request, response) => response.status(202).json(service.recognize(request.params.id, request.body))));
  app.patch('/api/papers/:id/recognition', wrap((request, response) => response.json(service.correct(request.params.id, request.body, true))));
  app.post('/api/papers/:id/recognition/cancel', wrap(async (request, response) => response.json(await service.cancel(request.params.id))));
}

module.exports = {createTranslationService, installTranslationRoutes};
