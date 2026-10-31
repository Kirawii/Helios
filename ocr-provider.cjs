const crypto = require('node:crypto');
const {OcrWorker} = require('./ocr-worker.cjs');
const {ApiOcrWorker} = require('./ocr-api.cjs');

function resolveOcrConfig(input, previous) {
  if (input != null && (typeof input !== 'object' || Array.isArray(input))) throw Error('OCR 配置无效');
  const settings = input || previous || {};
  const mode = settings.mode || process.env.HELIOS_OCR_MODE || 'local';
  if (mode === 'local') return {mode};
  if (mode !== 'api') throw Error('请选择本地部署或 API 识别');
  const url = new URL(settings.baseUrl || process.env.HELIOS_OCR_API_URL || 'https://api.siliconflow.cn/v1');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('OCR API 地址必须是 HTTP(S) 地址，不能包含密钥或查询参数');
  const model = String(settings.model || process.env.HELIOS_OCR_API_MODEL || 'PaddlePaddle/PaddleOCR-VL-1.5').trim();
  if (!model || model.length > 200) throw Error('OCR 模型名称无效');
  const key = String(settings.key || process.env.SILICONFLOW_API_KEY || '');
  if (/[\r\n]/.test(key)) throw Error('OCR API Key 格式无效');
  const maxTokens = Number(settings.maxTokens || 4096);
  if (!Number.isInteger(maxTokens) || maxTokens < 256 || maxTokens > 32768) throw Error('OCR 最大输出长度应在 256–32768 之间');
  const strategy=settings.strategy||'hybrid',concurrency=Number(settings.concurrency??8);
  if(!['hybrid','full'].includes(strategy))throw Error('OCR 解析策略无效');
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>32)throw Error('API 并发数应在 1–32 之间');
  return {mode, provider: 'siliconflow', baseUrl: url.href.replace(/\/+$/, ''), model, maxTokens, strategy, concurrency, key};
}

function publicOcrConfig(config) {
  const {key, ...publicConfig} = config;
  return publicConfig;
}

function ocrFingerprint(config) {
  const {maxTokens, concurrency, ...identity} = publicOcrConfig(config);
  return crypto.createHash('sha256').update(JSON.stringify([identity, 'ocr-api-grounding-144dpi-v1'])).digest('hex');
}

class OcrProvider {
  constructor({local = new OcrWorker(), api = new ApiOcrWorker()} = {}) { this.local = local; this.api = api; }
  request({ocr, ...payload}, onEvent, signal) {
    const config = ocr || resolveOcrConfig();
    return config.mode === 'api' ? this.api.request({...payload, config}, onEvent, signal) : this.local.request(payload, onEvent, signal);
  }
  close() { this.local.close(); this.api.close(); }
}

module.exports = {OcrProvider, resolveOcrConfig, publicOcrConfig, ocrFingerprint};
