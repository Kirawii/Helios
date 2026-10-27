const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const {setTimeout: delay} = require('node:timers/promises');
const {createTranslationService, installTranslationRoutes} = require('../translation.cjs');
const model = require('../translation-model.cjs');
const {testPdf} = require('./test-pdf.cjs');

const pages = [
  {page: 1, width: 1200, height: 1600, blocks: [
    {id: 'p1-b0', page: 1, order: 1, type: 'doc_title', text: 'Efficient Research', bbox: [.1, .05, .9, .1]},
    {id: 'p1-b1', page: 1, order: 2, type: 'text', text: 'Our method improves accuracy by 15.06% using $x = 2$ [1].', bbox: [.1, .15, .48, .6]},
    {id: 'p1-b2', page: 1, order: 3, type: 'text', text: 'A separate right column retains 8 × less data.', bbox: [.52, .15, .9, .6]},
    {id: 'p1-b3', page: 1, order: 4, type: 'formula', text: 'x = 2', bbox: [.1, .65, .8, .7]},
  ]},
  {page: 2, width: 1200, height: 1600, blocks: [
    {id: 'p2-b0', page: 2, order: 1, type: 'text', text: 'Two distinct representations use beta β in 2026.', bbox: [.1, .1, .9, .4]},
    {id: 'p2-b1', page: 2, order: 2, type: 'table', text: '<table><tr><td>8</td></tr></table>', bbox: [.1, .5, .9, .8]},
  ]},
];

function contextFor(blocks) {
  const evidence = blocks[0]?.id || 'p1-b0';
  const methodBlock = blocks.find(block => block.text?.includes('method'));
  return {problem: [{text: '研究存储与准确率的关系', evidence: [evidence]}], method: [], results: [],
    terms: methodBlock ? [{term: 'method', translation: '方法', meaning: '本文方法', evidence: [methodBlock.id]}] : [], symbols: []};
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helios-translation-test-'));
  fs.writeFileSync(path.join(root, 'paper.pdf'), testPdf());
  const paper = {id: 'paper', title: 'SYNTHETIC FUNCTIONAL TEST', pages: 2};
  let ocrCalls = 0, analysisCalls = 0, translationCalls = 0, badBlock = null, slow = false;
  let omitPage = false;
  const worker = {request: async (request, emit, signal) => {
    ocrCalls++;
    for (const pageNumber of request.pages) {
      signal.throwIfAborted();
      if (omitPage && pageNumber === 2) continue;
      emit({event: 'page', data: structuredClone(pages[pageNumber - 1])});
      await delay(1, null, {signal});
    }
    return {signature: 'TEST FIXTURE OCR; not a real recognizer'};
  }, close() {}};
  const requestJSON = async (config, messages, signal) => {
    const input = JSON.parse(messages.at(-1).content);
    if (!input.blocks) {
      analysisCalls++;
      return contextFor(input.content?.[0]?.problem ? pages.flatMap(page => page.blocks) : input.content);
    }
    translationCalls++;
    if (slow) await delay(1000, null, {signal});
    return {translations: input.blocks.filter(block => !badBlock || !block.id.startsWith(badBlock)).map(block => ({id: block.id, text: '功能验证译文 ' + (block.text.match(/⟪KEEP_\d+⟫/g) || []).join(' ')}))};
  };
  const service = createTranslationService({root, getPaper: id => id === paper.id ? paper : null, worker, requestJSON});
  const config = {baseUrl: 'http://127.0.0.1:12345/v1', model: 'fixture-only', key: 'SECRET-NOT-PERSISTED', protocol: 'openai'};
  let server, upstream;
  try {
    assert.throws(() => service.view('../bad'), /不存在/);
    assert.throws(() => model.providerConfig({baseUrl: 'file:///etc/passwd'}), /HTTP/);
    assert.throws(() => model.providerConfig({baseUrl: 'https://example.com/v1?key=secret', model: 'test'}), /查询参数/);
    const original = 'Result 15.06%, $x=2$, β, [1, 3–5], 24-GiB at https://example.com/123';
    const protectedText = model.protectText(original, ['β']);
    const valid = model.validateTranslations({translations: [{id: 'test', text: protectedText.text}]}, [{id: 'test', original, ...protectedText}]);
    assert.equal(valid.results.get('test'), original);
    assert.ok(model.validateTranslations({translations: [{id: 'test', text: '没有数字'}]}, [{id: 'test', original, ...protectedText}]).errors.size);
    assert.ok(model.validateTranslations({translations: [{id: 'test', text: protectedText.text}, {id: 'test', text: protectedText.text}]}, [{id: 'test', original, ...protectedText}]).errors.size);
    assert.throws(() => model.validateContext({...contextFor(pages[0].blocks), terms: [{term: 'invented', translation: '伪造', meaning: '不存在', evidence: ['p1-b0']}]}, pages[0].blocks), /没有出现在/);
    assert.equal(model.splitText('x'.repeat(25000)).join(''), 'x'.repeat(25000));

    service.recognize('paper'); await service.wait('paper');
    assert.equal(service.view('paper').status, 'recognized'); assert.equal(analysisCalls, 0); assert.equal(translationCalls, 0);
    assert.equal(service.view('paper').blocks.length, 6);

    // Marginal review line numbers must not become paragraphs or consume labels.
    const numberingRoot = fs.mkdtempSync(path.join(root, 'numbering-'));
    fs.writeFileSync(path.join(numberingRoot, 'paper.pdf'), testPdf());
    const numberingWorker = {close() {}, async request(request, emit) {
      emit({event: 'loading'}); emit({event: 'progress', page: 1});
      emit({event: 'page', data: {...pages[0], blocks: [
        {id: 'p1-b9', page: 1, order: 1, sourceOrder: null, type: 'aside_text', text: '1 2 3 4', bbox: [.01, .1, .04, .9]},
        ...pages[0].blocks,
      ]}});
      emit({event: 'page', data: pages[1]});
      return {signature: 'TEST numbering fixture'};
    }};
    const numberingService = createTranslationService({root: numberingRoot, getPaper: () => paper, worker: numberingWorker});
    numberingService.recognize('paper'); await numberingService.wait('paper');
    const numbered = numberingService.view('paper');
    assert.equal(numbered.blocks[0].order, null);
    assert.deepEqual(numbered.blocks.filter(block => !model.ignoredBlock(block)).map(block => block.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(numbered.blocks[0].text, '1 2 3 4');
    assert.equal(numbered.progress.total, 6);
    await numberingService.close();
    const oldStatePath = path.join(numberingRoot, 'translations/paper/state.json');
    const oldState = JSON.parse(fs.readFileSync(oldStatePath, 'utf8'));
    oldState.ocrProfile = 'previous-profile'; oldState.overrides = {'p1-b1': 'User correction to retain in backup'};
    fs.writeFileSync(oldStatePath, JSON.stringify(oldState));
    const updatedService = createTranslationService({root: numberingRoot, getPaper: () => paper, worker: numberingWorker});
    assert.equal(updatedService.view('paper').status, 'idle');
    const backupName = fs.readdirSync(path.dirname(oldStatePath)).find(name => name.startsWith('state-before-'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(path.dirname(oldStatePath), backupName), 'utf8')).overrides['p1-b1'], oldState.overrides['p1-b1']);
    await updatedService.close();

    service.start('paper', config);
    assert.throws(() => service.start('paper', config), error => error.status === 409);
    await service.wait('paper');
    let state = service.view('paper');
    assert.equal(state.status, 'completed', state.error);
    assert.equal(state.pages.length, 2);
    assert.deepEqual(state.blocks.map(block => block.order), [1, 2, 3, 4, 5, 6]);
    assert.equal(Object.keys(state.translations).length, 4);
    assert.match(state.translations['p1-b1'].text, /15\.06%.*\$x = 2\$.*\[1\]/);
    assert.equal(state.translations['p1-b3'], undefined);
    const persisted = fs.readFileSync(path.join(root, 'translations/paper/state.json'), 'utf8');
    assert.ok(!persisted.includes(config.key));
    assert.ok(!JSON.stringify(state).includes(config.key));
    const firstCount = translationCalls, firstAnalysis = analysisCalls;
    service.start('paper', config); await service.wait('paper');
    assert.equal(ocrCalls, 1); assert.equal(translationCalls, firstCount); assert.equal(analysisCalls, firstAnalysis);

    state = service.view('paper');
    const editedContext = structuredClone(state.context); editedContext.terms[0].translation = '统一方法';
    service.correct('paper', {revision: state.revision, context: editedContext});
    service.start('paper', config); await service.wait('paper');
    assert.equal(analysisCalls, firstAnalysis); assert.equal(translationCalls, firstCount + 4); assert.equal(ocrCalls, 1);
    state = service.view('paper');
    assert.throws(() => service.correct('paper', {revision: state.revision - 1, texts: {}}), error => error.status === 409);
    service.correct('paper', {revision: state.revision, texts: {'p1-b1': pages[0].blocks[1].text + ' Corrected OCR.'}});
    service.start('paper', config); await service.wait('paper');
    assert.equal(ocrCalls, 1); assert.ok(analysisCalls > firstAnalysis);
    assert.equal(service.view('paper').context.terms[0].translation, '统一方法');

    badBlock = 'p1-b1';
    service.start('paper', {...config, force: true}); await service.wait('paper');
    state = service.view('paper'); assert.equal(state.status, 'partial'); assert.ok(state.errors['p1-b1']); assert.ok(state.translations['p1-b1']);
    const partialCount = translationCalls;
    badBlock = null; service.start('paper', config); await service.wait('paper');
    assert.equal(service.view('paper').status, 'completed'); assert.equal(translationCalls, partialCount + 1);

    slow = true; service.start('paper', {...config, force: true}); await delay(10);
    await service.cancel('paper'); state = service.view('paper'); assert.equal(state.status, 'cancelled'); assert.equal(state.active, false); assert.ok(state.translations['p1-b1']); slow = false;
    service.start('paper', config); await service.wait('paper'); assert.equal(service.view('paper').status, 'completed');
    const restored = createTranslationService({root, getPaper: () => paper, worker, requestJSON});
    assert.equal(restored.view('paper').status, 'completed'); await restored.close();

    const app = express(); app.use(express.json()); installTranslationRoutes(app, service);
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const apiUrl = 'http://127.0.0.1:' + server.address().port + '/api/papers/paper/translation';
    assert.equal((await fetch(apiUrl)).status, 200);
    const recognitionUrl = apiUrl.replace('/translation', '/recognition');
    assert.equal((await fetch(recognitionUrl)).status, 200);
    assert.equal((await fetch(recognitionUrl + '/pages/999/image')).status, 404);
    const recognitionStatePath = path.join(root, 'translations/paper/state.json');
    const sourceState = JSON.parse(fs.readFileSync(recognitionStatePath, 'utf8'));
    sourceState.pages[1].sourceImage = 'page-1.png';
    const sourceService = createTranslationService({root, getPaper: id => id === paper.id ? paper : null, worker});
    fs.writeFileSync(recognitionStatePath, JSON.stringify(sourceState));
    const asset = sourceService.sourceAsset('paper', '1');
    fs.mkdirSync(asset.directory, {recursive:true}); fs.writeFileSync(path.join(asset.directory, asset.filename), Buffer.from('PNG fixture only'));
    assert.equal(asset.filename, 'page-1.png');
    assert.throws(() => sourceService.sourceAsset('paper', '../1'), error => error.status === 404);
    assert.throws(() => sourceService.sourceAsset('paper', '1', '../../state'), error => error.status === 404);
    assert.throws(() => sourceService.sourceAsset('unknown', '1'), error => error.status === 404);
    const sourceApp = express(); installTranslationRoutes(sourceApp, sourceService);
    const sourceServer = http.createServer(sourceApp); await new Promise(resolve => sourceServer.listen(0,'127.0.0.1',resolve));
    try { assert.equal(await (await fetch('http://127.0.0.1:' + sourceServer.address().port + '/api/papers/paper/recognition/pages/1/image')).text(), 'PNG fixture only'); }
    finally { sourceServer.close(); await sourceService.close(); }
    assert.equal((await fetch(recognitionUrl, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}'})).status, 202);
    await service.wait('paper'); assert.equal(service.view('paper').status, 'recognized');
    assert.equal((await fetch(apiUrl, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(config)})).status, 202);
    await service.wait('paper');
    assert.equal((await (await fetch(apiUrl + '/cancel', {method: 'POST'})).json()).active, false);

    let attempts = 0;
    upstream = http.createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); attempts++;
      if (input.model === 'limited' && attempts === 1) { response.writeHead(429); return response.end(); }
      if (input.model === 'unauthorized') { response.writeHead(401); return response.end('SECRET-NOT-PERSISTED'); }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({choices: [{finish_reason: input.model === 'truncated' ? 'length' : 'stop', message: {content: '{"ok":true}'}}]}));
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamConfig = {...config, baseUrl: 'http://127.0.0.1:' + upstream.address().port, model: 'limited'};
    assert.deepEqual(await model.requestJSON(upstreamConfig, [], new AbortController().signal), {ok: true}); assert.equal(attempts, 2);
    await assert.rejects(model.requestJSON({...upstreamConfig, model: 'unauthorized'}, [], new AbortController().signal), error => error.failedRequest && !error.message.includes(config.key));
    await assert.rejects(model.requestJSON({...upstreamConfig, model: 'truncated'}, [], new AbortController().signal), /截断/);

    const missingRoot = fs.mkdtempSync(path.join(root, 'missing-'));
    fs.writeFileSync(path.join(missingRoot, 'paper.pdf'), testPdf()); omitPage = true;
    const missingService = createTranslationService({root: missingRoot, getPaper: () => paper, worker, requestJSON});
    missingService.start('paper', config); await missingService.wait('paper'); assert.match(missingService.view('paper').error, /遗漏了页面/); await missingService.close();
    console.log('PASS: protected numbers/formulas/citations, evidence validation, OCR page coverage/order, glossary/source correction, cache invalidation, incremental retry, cancellation/resume, persistence, no key leakage, translation HTTP routes, rate limits and truncation');
  } finally {
    await service.close();
    server?.close(); upstream?.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
