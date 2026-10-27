const {spawn} = require('node:child_process');
const {createInterface} = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

function acquireWorkerLock(filename, token) {
  fs.mkdirSync(path.dirname(filename), {recursive: true});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(filename, JSON.stringify({pid: process.pid, token}), {flag: 'wx'});
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let holder;
      try { holder = JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { throw Error('OCR 运行锁无效，请检查 .cache/ocr-worker.lock'); }
      let alive = true;
      try { process.kill(holder.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
      if (alive) throw Error('已有本机 OCR 进程运行中，请等待或停止该任务，避免重复占用内存');
      fs.unlinkSync(filename);
    }
  }
  throw Error('无法取得本机 OCR 运行锁');
}

function releaseWorkerLock(filename, token) {
  try { if (JSON.parse(fs.readFileSync(filename, 'utf8')).token === token) fs.unlinkSync(filename); } catch {}
}

function ocrRuntime() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(__dirname, '.cache/ocr-runtime.json'), 'utf8')); } catch {}
  return {
    python: process.env.HELIOS_OCR_PYTHON || path.join(__dirname, saved.verified && saved.environment === '.venv-gpu' ? '.venv-gpu' : '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    device: process.env.HELIOS_OCR_DEVICE || (saved.verified && saved.environment === '.venv-gpu' ? 'gpu:0' : 'cpu'),
  };
}

class OcrWorker {
  constructor({pythonPath, spawnProcess = spawn, lockFile = path.join(__dirname, '.cache/ocr-worker.lock'), timeoutMs = 30 * 60 * 1000} = {}) {
    this.pythonPath = pythonPath;
    this.spawnProcess = spawnProcess;
    this.lockFile = lockFile;
    this.timeoutMs = timeoutMs;
    this.process = null;
    this.active = null;
    this.queue = Promise.resolve();
    this.idleTimer = null;
    this.exitCleanup = null;
  }

  launch() {
    if (this.process) return;
    const runtime = ocrRuntime();
    const python = this.pythonPath || runtime.python;
    if (!fs.existsSync(python)) throw Error('本机 OCR 尚未安装，请先运行 npm run setup:ocr');
    const lockFile = this.lockFile, lockToken = crypto.randomUUID();
    acquireWorkerLock(lockFile, lockToken);
    const threads = String(Math.max(1, Math.min(8, Number.parseInt(process.env.HELIOS_OCR_THREADS, 10) || 2)));
    const certificates = process.platform === 'darwin' && fs.existsSync('/etc/ssl/cert.pem') ? {SSL_CERT_FILE: '/etc/ssl/cert.pem', REQUESTS_CA_BUNDLE: '/etc/ssl/cert.pem'} : {};
    const child = this.spawnProcess(python, ['-u', path.join(__dirname, 'ocr/worker.py')], {
      cwd: __dirname,
      env: {...certificates, ...process.env, HELIOS_OCR_DEVICE: runtime.device, HELIOS_OCR_THREADS: threads, OMP_NUM_THREADS: threads, OPENBLAS_NUM_THREADS: threads, MKL_NUM_THREADS: threads, VECLIB_MAXIMUM_THREADS: threads, NUMEXPR_NUM_THREADS: threads, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True', PADDLE_PDX_CACHE_HOME: path.join(__dirname, '.cache/paddleocr'), HF_HOME: path.join(__dirname, '.cache/huggingface')},
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = child;
    if (child.pid) fs.writeFileSync(lockFile, JSON.stringify({pid: child.pid, token: lockToken}));
    const exitCleanup = () => child.kill();
    this.exitCleanup = exitCleanup;
    process.once('exit', exitCleanup);
    process.once('SIGINT', exitCleanup);
    process.once('SIGTERM', exitCleanup);
    let diagnostics = '';
    child.stderr.on('data', chunk => {
      diagnostics = (diagnostics + chunk.toString()).slice(-2000);
      if (process.env.HELIOS_OCR_DIAGNOSTICS === '1') process.stderr.write(chunk);
    });
    const lines = createInterface({input: child.stdout});
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const active = this.active;
      if (!active || active.child !== child || active.requestId !== message.requestId) return;
      if (message.event === 'page' || message.event === 'loading' || message.event === 'progress') {
        active.touch();
        try { active.onEvent(message); } catch (error) { active.failure = error; child.kill(); }
      }
      if (message.event === 'done') active.resolve(message);
      if (message.event === 'error') active.reject(Error('OCR 处理失败：' + message.error));
    });
    child.on('error', error => {
      releaseWorkerLock(lockFile, lockToken);
      if (this.active?.child === child) this.active.reject(Error('无法启动 OCR：' + error.message));
    });
    child.on('close', () => {
      releaseWorkerLock(lockFile, lockToken);
      process.removeListener('exit', exitCleanup);
      process.removeListener('SIGINT', exitCleanup);
      process.removeListener('SIGTERM', exitCleanup);
      if (this.process === child) this.process = null;
      if (this.active?.child === child) this.active.reject(this.active.failure || (this.active.signal?.aborted ? this.active.signal.reason : Error('OCR 进程已退出。请检查依赖与模型文件。' + diagnostics.slice(-500))));
      lines.close();
    });
    child.stdin.on('error', () => {});
  }

  request(payload, onEvent = () => {}, signal) {
    try { onEvent({event: 'queued'}); } catch (error) { return Promise.reject(error); }
    let started = false;
    const operation = this.queue.catch(() => {}).then(async () => {
      signal?.throwIfAborted();
      started = true;
      clearTimeout(this.idleTimer);
      this.launch();
      const child = this.process;
      const requestId = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const abort = () => {
          if (this.process === child) this.process = null;
          child.kill();
        };
        let timer;
        const touch = () => {
          clearTimeout(timer);
          timer = setTimeout(() => {
            if (this.active?.requestId !== requestId) return;
            this.active.failure = Error('OCR 长时间没有进展，请重试未完成的页面');
            child.kill();
          }, this.timeoutMs);
        };
        const cleanup = () => {
          clearTimeout(timer); signal?.removeEventListener('abort', abort);
          if (this.active?.requestId === requestId) this.active = null;
          const idleSeconds = Math.max(1, Number(process.env.HELIOS_OCR_IDLE_SECONDS) || 30);
          this.idleTimer = setTimeout(() => this.close(), idleSeconds * 1000); this.idleTimer.unref();
        };
        this.active = {child, requestId, onEvent, signal, touch, resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); }};
        touch();
        signal?.addEventListener('abort', abort, {once: true});
        child.stdin.write(JSON.stringify({...payload, requestId}) + '\n');
        if (signal?.aborted) abort();
      });
    });
    this.queue = operation;
    if (!signal) return operation;
    let queuedAbort;
    const cancelled = new Promise((resolve, reject) => {
      queuedAbort = () => { if (!started) reject(signal.reason || new DOMException('任务已取消', 'AbortError')); };
      signal.addEventListener('abort', queuedAbort, {once: true}); if (signal.aborted) queuedAbort();
    });
    return Promise.race([operation, cancelled]).finally(() => signal.removeEventListener('abort', queuedAbort));
  }

  close() {
    clearTimeout(this.idleTimer);
    this.process?.kill();
    this.process = null;
  }
}

module.exports = {OcrWorker, acquireWorkerLock, releaseWorkerLock, ocrRuntime};
