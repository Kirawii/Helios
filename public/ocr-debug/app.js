import * as pdfjs from '/pdfjs/pdf.mjs';
import {createTranslationReader} from './reader.js';

pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
const select = document.querySelector('#paper-select');
const status = document.querySelector('#document-status');
const pageInput = document.querySelector('#page-number');
const toggle = document.querySelector('#toggle-original');
const original = document.querySelector('#original');
let paper = null, pdf = null, loadingTask = null, generation = 0, toastTimer, pageObserver;
const ocrForm = document.querySelector('#ocr-settings');
const ocrMode = document.querySelector('#ocr-mode');
const ocrUrl = document.querySelector('#ocr-api-url');
const ocrModel = document.querySelector('#ocr-api-model');
const ocrKey = document.querySelector('#ocr-api-key');
const ocrMaxTokens = document.querySelector('#ocr-max-tokens');
const ocrStrategy = document.querySelector('#ocr-strategy');
const ocrConcurrency = document.querySelector('#ocr-concurrency');
try {
  const saved = JSON.parse(localStorage.getItem('moon-ocr') || '{}');
  if (['local', 'api'].includes(saved.mode)) ocrMode.value = saved.mode;
  if (saved.baseUrl) ocrUrl.value = saved.baseUrl;
  if (saved.model) ocrModel.value = saved.model === 'deepseek-ai/DeepSeek-OCR' ? 'PaddlePaddle/PaddleOCR-VL-1.5' : saved.model;
  if (saved.maxTokens) ocrMaxTokens.value = saved.maxTokens;
  if (['hybrid','full'].includes(saved.strategy)) ocrStrategy.value = saved.strategy;
  if (saved.concurrency) ocrConcurrency.value = saved.concurrency;
} catch {}
function getOcrConfig() {
  return ocrMode.value === 'api' ? {mode: 'api', baseUrl: ocrUrl.value.trim(), model: ocrModel.value.trim(), maxTokens: Number(ocrMaxTokens.value), strategy: ocrStrategy.value, concurrency: Number(ocrConcurrency.value), key: ocrKey.value.trim()} : {mode: 'local'};
}
function updateOcrSettings() {
  document.querySelector('#ocr-api-fields').hidden = ocrMode.value !== 'api';
  document.querySelector('#ocr-mode-description').textContent = ocrMode.value === 'api'
    ? ocrStrategy.value === 'hybrid' ? '先提取 PDF 文字与坐标，仅将图像、公式候选区域并发发送到 API；扫描页回退整页识别。缺失或失败区域仍标为未完成。' : '兼容模式逐页发送整页图像到 API；长文档建议使用混合解析。'
    : '本地识别需先运行 npm run setup:ocr；PDF 在本机处理。切换识别方式会备份旧结果并重新识别。';
  const {key, ...settings} = getOcrConfig();
  // Preserve API preferences when switching to local; never store the API key.
  try { localStorage.setItem('moon-ocr', JSON.stringify({...settings, baseUrl: ocrUrl.value.trim(), model: ocrModel.value.trim(), maxTokens: Number(ocrMaxTokens.value),strategy:ocrStrategy.value,concurrency:Number(ocrConcurrency.value)})); } catch {}
}
ocrForm.onsubmit = event => event.preventDefault();
ocrForm.onchange = updateOcrSettings;
updateOcrSettings();

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw Error(data.error || '请求失败');
  return data;
}
function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = message; element.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { element.hidden = true; }, 5000);
}
function closeModal() { document.querySelector('.modalback')?.remove(); }
function modal(content, className = '') {
  closeModal();
  const wrapper = document.createElement('div'); wrapper.className = 'modalback';
  wrapper.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true" aria-label="校对识别文本">${content}</div>`;
  document.body.append(wrapper);
  wrapper.onclick = event => { if (event.target === wrapper || event.target.closest('[data-close]')) closeModal(); };
  wrapper.querySelector('button,select,textarea')?.focus();
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });
const reader = createTranslationReader({getPaper: () => paper, getDocument: () => pdf, getOcrConfig, api, toast, modal, closeModal, mode: 'recognition'});

async function refreshLibrary(selectedId = paper?.id || '') {
  const papers = await api('/api/papers');
  select.replaceChildren(new Option(papers.length ? '选择 PDF…' : '文献库为空，请上传 PDF', ''));
  for (const item of papers) select.add(new Option(`${item.title} · ${item.pages} 页`, item.id));
  select.value = selectedId;
  return papers;
}
async function openPaper(id) {
  const current = ++generation;
  pageObserver?.disconnect();
  reader.detach(); closeModal();
  paper = null;
  const previousTask = loadingTask; loadingTask = null; pdf = null;
  // Destroying a loading task also releases its document and any active render.
  await previousTask?.destroy();
  if (current !== generation) return;
  original.querySelector('.pages').replaceChildren();
  document.querySelector('.translated-pages').replaceChildren();
  original.scrollTop = document.querySelector('#translated').scrollTop = 0;
  pageInput.disabled = toggle.disabled = true;
  pageInput.value = 1; document.querySelector('#page-count').textContent = '/ 0';
  document.querySelector('.pdf-area').classList.remove('translation-only');
  document.querySelector('#source-pane').hidden = false;
  toggle.textContent = '仅看识别结果'; toggle.setAttribute('aria-pressed', 'false');
  if (!id) { history.replaceState(null, '', location.pathname); status.textContent = '选择或上传 PDF。进入页面不会自动启动 OCR。'; return; }
  status.textContent = '正在加载 PDF…';
  try {
    const selected = await api('/api/papers/' + encodeURIComponent(id));
    if (current !== generation) return;
    paper = selected;
    history.replaceState(null, '', '?paper=' + encodeURIComponent(id));
    loadingTask = pdfjs.getDocument({url: '/api/papers/' + encodeURIComponent(id) + '/pdf', useSystemFonts: true});
    const documentPdf = await loadingTask.promise;
    if (current !== generation) return;
    pdf = documentPdf;
    pageInput.max = pdf.numPages;
    document.querySelector('#page-count').textContent = '/ ' + pdf.numPages;
    const entries=[];
    for (let number = 1; number <= documentPdf.numPages; number++) {
      if (current !== generation) return;
      const page = await documentPdf.getPage(number);
      if (current !== generation) return;
      const base = page.getViewport({scale: 1});
      const viewport = page.getViewport({scale: Math.max(.25, Math.min(1.5, (original.clientWidth - 36) / base.width))});
      const element = document.createElement('div'); element.className = 'page'; element.dataset.page = number;
      element.style.width = viewport.width + 'px'; element.style.aspectRatio = `${viewport.width} / ${viewport.height}`;
      const placeholder=document.createElement('canvas');element.append(placeholder);
      original.querySelector('.pages').append(element);entries.push({page,viewport,element});
    }
    const rendered=new Set();
    async function paint(entry) {
      if(rendered.has(entry)||current!==generation)return;rendered.add(entry);
      const {page,viewport,element}=entry,canvas=document.createElement('canvas'),ratio=Math.min(devicePixelRatio||1,2);
      canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);
      try {
        await page.render({canvasContext:canvas.getContext('2d'),viewport,transform:[ratio,0,0,ratio,0,0]}).promise;
        if(current===generation&&!element.dataset.recognitionSource)element.querySelector('canvas').replaceWith(canvas);
      } catch(error){if(current===generation)toast('原文页面渲染失败：'+error.message);}
    }
    pageObserver=new IntersectionObserver(changes=>{for(const change of changes)if(change.isIntersecting){const entry=entries.find(entry=>entry.element===change.target);if(entry)paint(entry);pageObserver.unobserve(change.target);}},{root:original,rootMargin:'600px'});
    for(const entry of entries)pageObserver.observe(entry.element);
    paint(entries[0]);
    if (current !== generation) return;
    await reader.attach(id);
    if (current !== generation) return;
    pageInput.disabled = toggle.disabled = false;
    status.textContent = `${paper.title} · ${pdf.numPages} 页 · 点击右侧“开始全文识别”后，按上方选择的方式处理。`;
  } catch (error) {
    if (current !== generation) return;
    reader.detach(); paper = null;
    status.textContent = '文档加载失败：' + error.message;
    toast(error.message);
  }
}
select.onchange = () => openPaper(select.value);
document.querySelector('#refresh-library').onclick = async () => {
  try { await refreshLibrary(); toast('文献库已刷新'); } catch (error) { toast(error.message); }
};
document.querySelector('#upload-file').onchange = async event => {
  const file = event.target.files[0]; if (!file) return;
  const upload = document.querySelector('.upload-button'); upload.setAttribute('aria-busy', 'true');
  status.textContent = '正在导入 PDF…';
  try {
    const data = new FormData(); data.append('file', file);
    const uploaded = await api('/api/papers', {method: 'POST', body: data});
    await refreshLibrary(uploaded.id); await openPaper(uploaded.id);
  } catch (error) { status.textContent = '导入失败：' + error.message; toast(error.message); }
  finally { upload.removeAttribute('aria-busy'); event.target.value = ''; }
};
pageInput.onchange = () => {
  if (!pdf) return;
  const number = Math.max(1, Math.min(pdf.numPages, Number(pageInput.value) || 1));
  pageInput.value = number;
  const target = original.querySelector(`[data-page="${number}"]`);
  if (target) original.scrollTop += target.getBoundingClientRect().top - original.getBoundingClientRect().top - 18;
};
toggle.onclick = () => {
  const only = document.querySelector('.pdf-area').classList.toggle('translation-only');
  document.querySelector('#source-pane').hidden = only;
  pageInput.disabled = only;
  toggle.textContent = only ? '并排查看原文' : '仅看识别结果';
  toggle.setAttribute('aria-pressed', String(only));
  reader.render();
};
window.addEventListener('pagehide', () => { pageObserver?.disconnect();reader.detach(); loadingTask?.destroy(); });
try {
  const id = new URLSearchParams(location.search).get('paper');
  const papers = await refreshLibrary(id || '');
  if (id && papers.some(item => item.id === id)) await openPaper(id);
} catch (error) { status.textContent = '文献库加载失败：' + error.message; toast(error.message); }
