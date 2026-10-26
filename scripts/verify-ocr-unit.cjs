const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {PassThrough, Writable} = require('node:stream');
const {setTimeout: delay} = require('node:timers/promises');
const {OcrWorker, acquireWorkerLock, releaseWorkerLock} = require('../ocr-worker.cjs');

(async () => {
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
    console.log('PASS: cross-process OCR exclusion, stale lock recovery, reuse, 2-thread limit, idle memory release, active and queued cancellation; no models loaded');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
})().catch(error => { console.error(error); process.exitCode = 1; });
