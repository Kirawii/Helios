const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const gpu = args.has('--gpu') || !args.has('--cpu') && spawnSync('nvidia-smi', ['--query-gpu=name', '--format=csv,noheader'], {encoding: 'utf8', windowsHide: true}).status === 0;
const environment = gpu ? '.venv-gpu' : '.venv';
const python = path.join(root, environment, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const certificateEnv = process.platform === 'darwin' && fs.existsSync('/etc/ssl/cert.pem') ? {SSL_CERT_FILE: '/etc/ssl/cert.pem', REQUESTS_CA_BUNDLE: '/etc/ssl/cert.pem', PIP_CERT: '/etc/ssl/cert.pem'} : {};
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', windowsHide: true, env: {...certificateEnv, ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK: 'True', PADDLE_PDX_CACHE_HOME: path.join(root, '.cache/paddleocr'), HF_HOME: path.join(root, '.cache/huggingface')}});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(python)) run(process.env.HELIOS_SYSTEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', environment]);
run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Please use Python 3.12 for the verified OCR dependency set"']);
if (gpu) run(python, ['-m', 'pip', 'install', 'paddlepaddle-gpu==3.2.2', '--index-url', 'https://www.paddlepaddle.org.cn/packages/stable/cu126/']);
run(python, ['-m', 'pip', 'install', '-r', gpu ? 'ocr/requirements-common.txt' : 'ocr/requirements.txt']);
run(python, ['-c', 'import paddle; from paddleocr import PPStructureV3; import pypdfium2; ' + (gpu ? 'assert paddle.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0, "GPU unavailable"; paddle.set_device("gpu:0"); x=paddle.ones([2,2]); assert float((x@x).sum()) == 8; ' : '') + 'paddle.utils.run_check()']);
fs.mkdirSync(path.join(root, '.cache'), {recursive: true});
fs.writeFileSync(path.join(root, '.cache/ocr-runtime.json'), JSON.stringify({verified: true, environment, device: gpu ? 'gpu:0' : 'cpu', verifiedAt: new Date().toISOString()}));
console.log((gpu ? 'GPU' : 'CPU') + ' OCR 依赖就绪。PP-StructureV3 全部识别模块已启用，首次识别将下载并缓存模型。');
