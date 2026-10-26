const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
  const certificateEnv = process.platform === 'darwin' && fs.existsSync('/etc/ssl/cert.pem') ? {SSL_CERT_FILE: '/etc/ssl/cert.pem', REQUESTS_CA_BUNDLE: '/etc/ssl/cert.pem', PIP_CERT: '/etc/ssl/cert.pem'} : {};
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env: {...certificateEnv, ...process.env, PADDLE_PDX_CACHE_HOME: path.join(root, '.cache/paddleocr'), HF_HOME: path.join(root, '.cache/huggingface')}});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
if (!fs.existsSync(python)) run(process.env.HELIOS_SYSTEM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', '.venv']);
run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 12), "Please use Python 3.12 for the verified OCR dependency set"']);
run(python, ['-m', 'pip', 'install', '-r', 'ocr/requirements.txt']);
run(python, ['-c', 'import paddle; from paddleocr import PPStructureV3; import pypdfium2; paddle.utils.run_check()']);
console.log('OCR 依赖就绪。首次翻译时会下载并加载模型，之后复用本机缓存。');
