const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {setTimeout: delay} = require('node:timers/promises');
const {spawn} = require('node:child_process');
const {OcrWorker, acquireWorkerLock, releaseWorkerLock} = require('../ocr-worker.cjs');
const {readingOrder} = require('../recognition-order.cjs');

(async () => {
  const source = [
    {id:'figure',type:'chart',text:'',bbox:[.1,.1,.9,.3]},
    {id:'caption',type:'figure_title',text:'Figure 5',bbox:[.1,.31,.9,.35]},
    {id:'left-chart',type:'chart',text:'',bbox:[.1,.4,.46,.6]},
    {id:'right-body',type:'vision_footnote',text:'Section body',bbox:[.54,.43,.9,.6]},
    {id:'left-caption',type:'figure_title',text:'Figure 6',bbox:[.1,.62,.46,.68]},
    {id:'heading',type:'paragraph_title',text:'Additional analysis',bbox:[.54,.4,.9,.42]},
  ];
  assert.deepEqual(readingOrder(source).map(block=>block.id), ['figure','caption','left-chart','left-caption','heading','right-body']);
  assert.equal(readingOrder(source).at(-1).type, 'text');
  assert.equal(source[3].type, 'vision_footnote');
  const singleColumn = [
    {id:'body',type:'text',text:'Body',bbox:[.1,.4,.9,.6]},
    {id:'title',type:'paragraph_title',text:'Section',bbox:[.1,.35,.9,.38]},
  ];
  assert.deepEqual(readingOrder(singleColumn).map(block=>block.id), ['title','body']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helios-ocr-lock-test-'));
  const lock = path.join(root, 'worker.lock');
  try {
    acquireWorkerLock(lock, 'first');
    assert.throws(() => acquireWorkerLock(lock, 'second'), /已有本机 OCR/);
    releaseWorkerLock(lock, 'wrong-owner'); assert.ok(fs.existsSync(lock));
    releaseWorkerLock(lock, 'first'); assert.ok(!fs.existsSync(lock));
    fs.writeFileSync(lock, JSON.stringify({pid: 2147483647, token: 'stale'}));
    acquireWorkerLock(lock, 'replacement'); assert.equal(JSON.parse(fs.readFileSync(lock)).token, 'replacement');
    releaseWorkerLock(lock, 'replacement');

    const worker = new OcrWorker();
    let releaseQueue;
    worker.queue = new Promise(resolve => { releaseQueue = resolve; });
    worker.launch = () => { throw Error('cancelled job must not launch a model'); };
    const controller = new AbortController();
    const queued = worker.request({}, () => {}, controller.signal); controller.abort();
    await assert.rejects(queued, error => error.name === 'AbortError');
    releaseQueue(); await worker.queue.catch(() => {}); worker.close();

    let launches = 0, child;
    const controlledWorker = new OcrWorker({pythonPath: process.execPath, lockFile: lock, spawnProcess: (command, args, options) => {
      launches++; assert.equal(options.env.OMP_NUM_THREADS, '2');
      assert.equal(options.env.PYTHONIOENCODING, 'utf-8');
      assert.equal(options.env.PYTHONUTF8, '1');
      child = new EventEmitter(); child.pid = process.pid;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdin = new Writable({write(chunk, encoding, callback) {
        const message = JSON.parse(chunk.toString());
        if (!message.hold) setImmediate(() => child.stdout.write(JSON.stringify({event: 'done', requestId: message.requestId, signature: 'protocol-test-only'}) + '\n'));
        callback();
      }});
      child.kill = () => { setImmediate(() => child.emit('close', 0)); return true; };
      return child;
    }});
    await controlledWorker.request({}); await controlledWorker.request({}); assert.equal(launches, 1);
    const activeController = new AbortController();
    const active = controlledWorker.request({hold: true}, () => {}, activeController.signal);
    await delay(5); activeController.abort();
    await assert.rejects(active, error => error.name === 'AbortError'); assert.ok(!fs.existsSync(lock));
    const previousIdle = process.env.HELIOS_OCR_IDLE_SECONDS; process.env.HELIOS_OCR_IDLE_SECONDS = '1';
    await controlledWorker.request({}); await delay(1150); assert.equal(controlledWorker.process, null); assert.ok(!fs.existsSync(lock));
    if (previousIdle === undefined) delete process.env.HELIOS_OCR_IDLE_SECONDS; else process.env.HELIOS_OCR_IDLE_SECONDS = previousIdle;
    controlledWorker.close();
    let timeoutLaunches = 0, previousClosed = true;
    const timeoutWorker = new OcrWorker({pythonPath: process.execPath, lockFile: path.join(root, 'timeout.lock'), timeoutMs: 120, spawnProcess: () => {
      assert.ok(previousClosed, 'a queued request must wait for the timed-out process to close');
      previousClosed = false; timeoutLaunches++;
      const processFixture = new EventEmitter(); processFixture.pid = process.pid;
      processFixture.stdout = new PassThrough(); processFixture.stderr = new PassThrough();
      processFixture.stdin = new Writable({write(chunk, encoding, callback) {
        const message = JSON.parse(chunk.toString());
        const send = event => processFixture.stdout.write(JSON.stringify({...event, requestId: message.requestId}) + '\n');
        if (message.progress) {
          for (const ms of [60, 120, 180]) setTimeout(() => send({event: 'progress', page: 1}), ms);
          setTimeout(() => send({event: 'done'}), 240);
        } else if (!message.hold) setImmediate(() => send({event: 'done'}));
        callback();
      }});
      processFixture.kill = () => { setTimeout(() => {previousClosed = true; processFixture.emit('close');}, 20); return true; };
      return processFixture;
    }});
    const timedOut = assert.rejects(timeoutWorker.request({hold: true}), /长时间没有进展/);
    const following = timeoutWorker.request({});
    await timedOut; await following; assert.equal(timeoutLaunches, 2);
    await timeoutWorker.request({progress: true});
    await new Promise(resolve => {timeoutWorker.process.once('close', resolve); timeoutWorker.close();});
    console.log('PASS: OCR watchdog follows progress and the queue recovers after a timeout');
    const python = process.env.HELIOS_OCR_PYTHON || path.join(__dirname, '..', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (fs.existsSync(python)) {
      const echo = 'import sys,json\nfor line in sys.stdin:\n r=json.loads(line)\n print(json.dumps({"event":"done","requestId":r["requestId"],"signature":r["path"]},ensure_ascii=False),flush=True)';
      const unicodeWorker = new OcrWorker({pythonPath: python, lockFile: path.join(root, 'unicode.lock'), spawnProcess: (command, args, options) => spawn(command, ['-u', '-c', echo], options)});
      try {
        const unicodePath = 'C:/论文/中文 β 𝐴.pdf';
        assert.equal((await unicodeWorker.request({path: unicodePath})).signature, unicodePath);
        console.log('PASS: real Python worker UTF-8 input/output for Chinese paths, Greek and mathematical letters; no models loaded');
      } finally {
        if (unicodeWorker.process) await new Promise(resolve => { unicodeWorker.process.once('close', resolve); unicodeWorker.close(); });
      }
    }
    console.log('PASS: cross-process OCR exclusion, stale lock recovery, reuse, 2-thread limit, idle memory release, active and queued cancellation; no models loaded');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
