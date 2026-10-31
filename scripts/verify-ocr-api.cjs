const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {setTimeout: delay} = require('node:timers/promises');
const {ApiOcrWorker, normalizeApiPage, openPdf} = require('../ocr-api.cjs');
const {OcrProvider, resolveOcrConfig, publicOcrConfig, ocrFingerprint} = require('../ocr-provider.cjs');
const {createTranslationService} = require('../translation.cjs');
const {testPdf} = require('./test-pdf.cjs');

const grounded = page => `<|ref|>title<|/ref|><|det|>[[50, 40, 900, 100]]<|/det|>\nHeading ${page}\n<|ref|>text<|/ref|><|det|>[[50, 150, 450, 220], [50, 225, 800, 300]]<|/det|>\nA full sentence. A second sentence with $x=2$.`;

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helios-ocr-api-test-'));
  const filename = path.join(root, 'paper.pdf'); fs.writeFileSync(filename, testPdf());
  const secret = 'TEST-ONLY-OCR-KEY';
  let server, service, worker, opened;
  try {
    const parsed = normalizeApiPage(grounded(1), 1, 1200, 1600);
    assert.equal(parsed.blocks.length, 2); assert.equal(parsed.blocks[1].regions.length, 2);
    assert.equal(parsed.blocks[1].positionGranularity, 'block');
    assert.equal(parsed.blocks[0].confidence, null);
    assert.match(parsed.blocks[1].text, /A full sentence.*\$x=2\$/);
    const unpositioned = normalizeApiPage('Recognized paragraph without coordinates.', 2, 1200, 1600);
    assert.equal(unpositioned.blocks[0].positionGranularity, 'page'); assert.ok(unpositioned.warning);
    assert.throws(() => normalizeApiPage('<|ref|>text<|/ref|><|det|>[[0,0,0,9]]<|/det|>text', 1, 1, 1), /无效坐标/);
    assert.throws(() => normalizeApiPage('<|ref|>text<|/ref|><|det|>process.exit()', 1, 1, 1), /不完整/);
    assert.throws(() => resolveOcrConfig({mode: 'invalid'}), /本地部署/);
    assert.throws(() => resolveOcrConfig({mode: 'api', baseUrl: 'https://example.com/v1?key=secret'}), /查询参数/);
    assert.throws(() => resolveOcrConfig({mode: 'api', baseUrl: 'file:///private'}), /HTTP/);
    const sample = resolveOcrConfig({mode: 'api', key: secret});
    assert.ok(!JSON.stringify(publicOcrConfig(sample)).includes(secret));
    assert.equal(ocrFingerprint(sample), ocrFingerprint({...sample, key: 'ROTATED', maxTokens: 8192}));

    // API mode renders PDFs using Node only; no Paddle import or Python process.
    opened = await openPdf(filename);
    assert.equal(opened.pageCount, 2);
    const images = new Map();
    for (const number of [1, 2]) {
      const image = await opened.render(number, new AbortController().signal);
      assert.equal(image.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
      images.set(number, image);
    }
    assert.notDeepEqual(images.get(1).png, images.get(2).png, 'Different source pages must not render to identical blank images');
    await opened.close(); opened = null;
    let closes = 0, localCalls = 0, mode = 'normal', secondFailed = false;
    const requests = [], sockets = new Set();
    let releaseHeld;
    server = http.createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      assert.equal(request.url, '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer ' + secret);
      assert.equal(input.stream, false); assert.equal(input.temperature, 0);
      const image = input.messages[0].content.find(part => part.type === 'image_url').image_url.url;
      const number = [...images].find(([, value]) => image.endsWith(value.png.toString('base64')))?.[0];
      assert.ok(number); requests.push({number, input});
      assert.match(input.messages[0].content[1].text, /grounding/);
      if (mode === 'partial' && number === 2 && !secondFailed) { secondFailed = true; response.writeHead(429); return response.end(secret); }
      if (mode === 'denied') { response.writeHead(401); return response.end(secret); }
      if (mode === 'hold') { releaseHeld?.(); return; }
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({choices: [{finish_reason: mode === 'truncated' ? 'length' : 'stop', message: {content: grounded(number)}}]}));
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const config = {mode: 'api', baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'deepseek-ai/DeepSeek-OCR', key: secret, maxTokens: 4096, strategy: 'full', concurrency: 1};
    worker = new ApiOcrWorker({openDocument: async () => ({pageCount: 2, render: async number => images.get(number), close: async () => { closes++; }})});
    const local = {close() {}, async request(payload, emit) {
      localCalls++;
      fs.mkdirSync(payload.outputDirectory, {recursive: true});
      for (const number of payload.pages) {
        fs.writeFileSync(path.join(payload.outputDirectory, `page-${number}.png`), images.get(number).png);
        emit({event: 'page', data: {...normalizeApiPage(grounded(number), number, 1200, 1600), sourceImage: `page-${number}.png`}});
      }
      return {signature: 'LOCAL FIXTURE ONLY'};
    }};
    const provider = new OcrProvider({local, api: worker});
    service = createTranslationService({root, getPaper: id => id === 'paper' ? {id, title: 'Synthetic API test', pages: 2} : null, worker: provider});
    service.recognize('paper', {ocr: {mode: 'local'}}); await service.wait('paper');
    assert.equal(localCalls, 1); assert.equal(requests.length, 0);
    let state = service.view('paper');
    service.correct('paper', {revision: state.revision, texts: {'p1-b1': 'Manual local correction to preserve'}}, true);
    const originalAsset = service.sourceAsset('paper', 1);
    const originalAssetBytes = fs.readFileSync(path.join(originalAsset.directory, originalAsset.filename));

    mode = 'partial';
    service.recognize('paper', {ocr: config}); await service.wait('paper');
    state = service.view('paper'); assert.equal(state.status, 'failed'); assert.match(state.error, /HTTP 429/);
    assert.equal(state.pages.length, 1); assert.equal(state.ocrProvider.mode, 'api');
    assert.equal(state.overrides['p1-b1'], undefined);
    assert.notEqual(service.sourceAsset('paper', 1).directory, originalAsset.directory);
    assert.deepEqual(fs.readFileSync(path.join(originalAsset.directory, originalAsset.filename)), originalAssetBytes);
    const stateDirectory = path.join(root, 'translations/paper');
    const backup = fs.readdirSync(stateDirectory).filter(name => name.startsWith('state-before-')).map(name => JSON.parse(fs.readFileSync(path.join(stateDirectory, name))));
    assert.ok(backup.some(value => value.overrides['p1-b1'] === 'Manual local correction to preserve'));
    assert.throws(() => service.recognize('paper', {ocr: {...config, key: ''}}), /API Key/);
    assert.equal(service.view('paper').pages.length, 1);

    // Larger output allowance must resume missing pages rather than discard page 1.
    mode = 'normal'; service.recognize('paper', {ocr: {...config, maxTokens: 8192}}); await service.wait('paper');
    state = service.view('paper'); assert.equal(state.status, 'recognized', state.error);
    assert.deepEqual(requests.map(request => request.number), [1, 2, 2]); assert.equal(localCalls, 1);
    assert.equal(requests.at(-1).input.max_tokens, 8192);
    const beforeCached = requests.length;
    service.recognize('paper'); await service.wait('paper'); assert.equal(requests.length, beforeCached);
    const restored = createTranslationService({root, getPaper: id => ({id, pages: 2}), worker: provider});
    assert.equal(restored.view('paper').ocrProvider.mode, 'api');
    assert.equal(restored.view('paper').pages.length, 2);

    const payload = {path: filename, pageCount: 2, pages: [1], outputDirectory: path.join(root, 'other'), config};
    let paddlePage;
    const paddleWorker = new ApiOcrWorker({openDocument: async () => ({pageCount: 2, render: async number => images.get(number), close: async () => {}}), fetchImpl: async (url, request) => {
      const input = JSON.parse(request.body);
      assert.equal(input.model, 'PaddlePaddle/PaddleOCR-VL-1.5');
      assert.equal(input.messages[0].content[1].text, 'OCR:');
      return new Response(JSON.stringify({choices: [{finish_reason: 'stop', message: {content: 'PaddleOCR recognized text.'}}]}), {headers: {'Content-Type': 'application/json'}});
    }});
    await paddleWorker.request({...payload, config: {...config, model: 'PaddlePaddle/PaddleOCR-VL-1.5'}}, event => { if (event.event === 'page') paddlePage = event.data; });
    assert.equal(paddlePage.blocks[0].text, 'PaddleOCR recognized text.');
    assert.equal(paddlePage.positionGranularity, 'page');
    mode = 'denied';
    await assert.rejects(worker.request(payload), error => /HTTP 401/.test(error.message) && !error.message.includes(secret));
    mode = 'truncated'; let emitted = false;
    await assert.rejects(worker.request(payload, event => { if (event.event === 'page') emitted = true; }), /截断/);
    assert.equal(emitted, false);
    mode = 'hold';
    const entered = new Promise(resolve => { releaseHeld = resolve; });
    const controller = new AbortController();
    const cancelled = worker.request(payload, () => {}, controller.signal);
    await entered; controller.abort();
    await assert.rejects(cancelled, error => error.name === 'AbortError');
    assert.ok(closes >= 5);
    assert.equal(localCalls, 1); // API errors never silently fall back to local.
    service.recognize('paper', {ocr: {mode: 'local'}}); await service.wait('paper');
    assert.equal(localCalls, 2); assert.equal(service.view('paper').ocrProvider.mode, 'local');
    function assertNoSecrets(directory) {
      for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) assertNoSecrets(target);
        else if (entry.name.endsWith('.json')) assert.ok(!fs.readFileSync(target, 'utf8').includes(secret), target);
      }
    }
    assertNoSecrets(root);
    console.log('PASS: Node PDF rendering, SiliconFlow HTTP contract, grounding/multiple regions, page-only fallback, independent local/API routing, cache and asset isolation, backup, resume, cancellation, truncation, no key persistence');
    for (const socket of sockets) socket.destroy();
  } finally {
    await service?.close(); worker?.close(); await opened?.close(); server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(root);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('helios-ocr-api-test-')) fs.rmSync(resolved, {recursive: true, force: true});
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
