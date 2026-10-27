import {mediaBounds} from '/recognition-layout.mjs';
import katex from '/katex/katex.mjs';
import {mathSegments, stripMathDelimiters, markdownTableRows, recognitionMarkdown} from '/recognition-content.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const isMedia = block => /^(image|figure|chart|table|formula|equation|algorithm)$/.test(block.type);
const isIgnored = block => /^(header|footer|page_number|number|formula_number|header_image|footer_image|aside_text)$/.test(block.type);
const typeNames = {doc_title: '文章标题', paragraph_title: '章节标题', text: '正文', abstract: '摘要', figure_title: '图注', table_title: '表注', image: '插图', chart: '图表', seal: '印章', table: '表格', formula: '公式', equation: '公式', algorithm: '算法', reference: '参考文献', reference_content: '参考文献', footnote: '脚注'};
const stageNames = {ocr: '识别与阅读顺序', analysis: '文章理解与术语', translation: '全文翻译', done: '翻译结果'};

export function createTranslationReader({getPaper, getConfig, getDocument = () => null, api, toast, settings, modal, closeModal, mode = 'recognition'}) {
  const recognitionOnly = mode === 'recognition';
  let state = null, paperId = null, timer = null, generation = 0, syncing = false, syncTimer = null;
  let pageSignatures = new Map();
  let mediaQueue = Promise.resolve();
  let sourceImages = new Map();
  const endpoint = () => '/api/papers/' + encodeURIComponent(paperId) + '/' + mode;
  function detach() {
    generation++; clearTimeout(timer); clearTimeout(syncTimer); paperId = null; state = null; pageSignatures.clear(); sourceImages.clear();
  }
  async function attach(id) {
    detach(); paperId = id;
    const current = generation;
    await refresh(current);
    const left = document.querySelector('#original'), right = document.querySelector('#translated');
    if (!left || paperId !== id) return;
    left.onscroll = () => { updatePageNumber(); syncFrom('original'); };
    right.onscroll = () => syncFrom('translated');
  }
  async function refresh(current = generation) {
    const targetId = paperId;
    if (!targetId) return;
    try {
      const next = await api('/api/papers/' + encodeURIComponent(targetId) + '/' + mode);
      if (current !== generation || targetId !== paperId) return;
      const changed = state?.revision !== next.revision;
      state = next;
      if (changed) render();
      clearTimeout(timer);
      if (next.active) timer = setTimeout(() => refresh(current), document.hidden ? 4000 : 1000);
    } catch (error) {
      if (current !== generation) return;
      toast(error.message);
      timer = setTimeout(() => refresh(current), 5000);
    }
  }
  function configured() {
    const config = getConfig();
    let official = false;
    try { official = new URL(config.baseUrl).hostname === 'api.deepseek.com'; } catch {}
    if (!config.model || !config.baseUrl || official && !config.key) {
      settings(); toast('请配置翻译模型和 API Key，保存后点击开始翻译'); return null;
    }
    return config;
  }
  async function start(force = false) {
    if (!paperId || state?.active) return;
    const config = recognitionOnly ? {} : configured(); if (!config) return;
    const current = generation;
    try {
      const next = await api(endpoint(), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...config, force})});
      if (current !== generation) return;
      state = next; render(); clearTimeout(timer); timer = setTimeout(() => refresh(current), 500);
    } catch (error) { toast(error.message); }
  }
  async function ensureStarted() {
    render();
    if (recognitionOnly) return;
    if (state && !state.active && (state.status === 'idle' && !state.blocks.length || state.status === 'interrupted')) await start();
  }
  function render() {
    if (!paperId || getPaper()?.id !== paperId) return;
    const container = document.querySelector('.translated-pages');
    if (!container || document.querySelector('#translated').hidden) return;
    let workspace = container.querySelector('.translation-workspace');
    if (!workspace) {
      container.replaceChildren(); pageSignatures.clear();
      workspace = document.createElement('div'); workspace.className = 'translation-workspace';
      workspace.innerHTML = '<div class="translation-task"></div><div class="translation-document"></div>';
      container.append(workspace);
      workspace.addEventListener('click', handleClick);
    }
    const active = state?.active;
    const labels = recognitionOnly ? {idle: '准备识别与排版', running: '正在识别文章结构与阅读顺序', recognized: '全文识别与排版已完成', completed: '识别结果已就绪', partial: '识别结果已就绪', failed: '识别失败', cancelled: '已停止，可继续识别', interrupted: '服务重启后可继续识别'} : {idle: state?.stale ? '内容已校对，译文待更新' : '准备翻译', running: stageNames[state?.stage] || '处理中', completed: '全文翻译已完成', partial: '部分段落需要重试', failed: '处理失败', cancelled: '已停止，可继续', interrupted: '服务重启后可继续'};
    if (state?.status === 'running' && state.stage === 'ocr') {
      labels.running = {queued: '等待本机识别任务', loading: '正在准备识别模型，首次运行需要下载', recognizing: '正在识别第 ' + state.ocrPage + ' 页'}[state.ocrPhase] || labels.running;
    }
    const progress = state?.progress || {done: 0, total: 0};
    workspace.querySelector('.translation-task').innerHTML = `<div class="translation-task-heading"><strong>${escapeHtml(labels[state?.status] || '准备识别')}${(state?.ocrDevice || state?.pages?.[0]?.runtime?.device || '').startsWith('gpu') ? ' · GPU' : ''}</strong><span>${progress.done} / ${progress.total}${state?.stage === 'ocr' ? ' 页' : ' 块'}</span></div><progress aria-label="当前阶段进度" value="${progress.done}" max="${Math.max(1, progress.total)}"></progress><ol class="translation-stages">${(recognitionOnly ? ['识别内容类型', '恢复阅读顺序', '重排阅读与校对'] : ['识别', '文章理解', '翻译']).map(label => `<li>${label}</li>`).join('')}</ol>${state?.error ? `<p class="translation-error" role="status">${escapeHtml(state.error)}</p>` : ''}<div class="translation-task-actions">${active ? '<button data-translation-action="cancel">停止处理</button>' : `<button class="primary" data-translation-action="start">${recognitionOnly ? state?.blocks?.length ? '继续 / 检查识别' : '开始全文识别' : '继续 / 重试翻译'}</button>`}${recognitionOnly ? '' : `<button data-translation-action="context" ${state?.context ? '' : 'disabled'}>文章理解与术语</button>`}<button data-translation-action="correct" ${state?.blocks?.length && !active ? '' : 'disabled'}>校对识别文本</button>${recognitionOnly && state?.pages?.length ? '<button data-translation-action="export">导出 Markdown / LaTeX</button><button data-translation-action="export-json">导出结构化 JSON</button>' : ''}${!recognitionOnly && state?.status === 'completed' ? '<button data-translation-action="force">重新翻译全文</button>' : ''}</div><small class="translation-explanation">${recognitionOnly ? '本机识别，无需模型密钥。' : ''}公式转为 LaTeX，表格与图表提供结构化内容。左侧为识别校正页面；编号连接页面与${recognitionOnly ? '识别结果' : '译文'}。</small>`;
    const features = state?.pages?.[0]?.features;
    if (features) {
      const names = {use_doc_orientation_classify:'页面方向',use_doc_unwarping:'页面校正',use_textline_orientation:'文字行方向',use_seal_recognition:'印章文字',use_table_recognition:'表格结构',use_formula_recognition:'公式 LaTeX',use_chart_recognition:'图表数据',use_region_detection:'区域划分'};
      const enabled = Object.keys(names).filter(key=>features[key]);
      const details = document.createElement('details'); details.className = 'recognition-features';
      const summary = document.createElement('summary'); summary.textContent = 'PP-StructureV3 · 已启用 ' + enabled.length + ' 项能力'; details.append(summary);
      const list = document.createElement('p'); list.textContent = enabled.map(key=>names[key]).join(' · '); details.append(list); workspace.querySelector('.translation-task').append(details);
    }
    const documentContainer = workspace.querySelector('.translation-document');
    if (!state?.pages?.length) {
      documentContainer.innerHTML = recognitionOnly ? '<div class="translation-empty"><h3>让论文结构清晰可读</h3><p>本机识别标题、段落、图表与公式，按阅读顺序重排。启用公式、表格、图表、印章、方向识别与页面校正。识别结果自动保存，可以逐块校对。</p></div>' : '<div class="translation-empty"><h3>在中文里读懂这篇论文</h3><p>先识别文章结构，再统一术语，最后逐段翻译。结果会自动保存。</p></div>';
      return;
    }
    const scroll = document.querySelector('#translated');
    const anchor = [...documentContainer.querySelectorAll('.reflow-block')].find(element => element.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 100);
    const anchorId = anchor?.dataset.blockId, anchorOffset = anchor?.getBoundingClientRect().top;
    for (const page of state.pages) {
      const signature = JSON.stringify([page, page.blocks.map(block => [state.translations[block.id], state.errors[block.id]]), state.translationFingerprint, state.stale, state.stage]);
      let section = documentContainer.querySelector('[data-translation-page="' + page.page + '"]');
      if (section && pageSignatures.get(page.page) === signature) continue;
      const replacement = renderPage(page);
      if (section) section.replaceWith(replacement); else documentContainer.append(replacement);
      pageSignatures.set(page.page, signature);
    }
    if (anchorId) {
      const restored = documentContainer.querySelector('[data-block-id="' + CSS.escape(anchorId) + '"]');
      if (restored) scroll.scrollTop += restored.getBoundingClientRect().top - anchorOffset;
    }
    sourcePages(); sourceAnchors();
  }
  function renderPage(page) {
    const section = document.createElement('section'); section.className = 'reflow-page'; section.dataset.translationPage = page.page;
    const heading = document.createElement('h3'); heading.className = 'reflow-page-label'; heading.textContent = '第 ' + page.page + ' 页'; section.append(heading);
    for (const block of page.blocks.filter(block => !isIgnored(block))) {
      const element = document.createElement('article'); element.className = 'reflow-block'; element.dataset.blockId = block.id; element.tabIndex = 0;
      if (/title/.test(block.type) && !/figure|table|chart/.test(block.type)) element.classList.add('reflow-heading');
      const label = document.createElement('button'); label.className = 'reflow-block-label'; label.textContent = '#' + block.order + ' · ' + (typeNames[block.type] || block.type) + (block.confidence != null && block.confidence < .85 ? ' · 建议校对' : ''); label.title = '定位原文'; label.onclick = () => locateSource(block);
      element.append(label);
      if (/^(formula|equation)$/.test(block.type) && block.text.trim()) {
        const formula = document.createElement('div'); formula.className = 'reflow-formula';
        const equation = document.createElement('div'); equation.className = 'reflow-equation';
        renderMath(formula, stripMathDelimiters(block.text), true); equation.append(formula); element.append(equation);
        const raw = mediaBounds(block, page.blocks);
        const numbers = page.blocks.filter(candidate => candidate.type === 'formula_number' && candidate.bbox[0] >= block.bbox[2] - .003 && candidate.bbox[2] <= raw[2] + .001 && candidate.bbox[1] >= raw[1] - .003 && candidate.bbox[3] <= raw[3] + .003);
        if (numbers.length) { const number = document.createElement('div'); number.className = 'reflow-equation-number'; number.textContent = numbers.map(entry => entry.text.trim()).join('\n'); equation.append(number); }
        blockTools(element, block, '复制 LaTeX'); sourceDetails(element, block, page, '对照公式原图');
      } else if (block.type === 'table' && /<table[\s>]/i.test(block.text)) {
        const wrapper = document.createElement('div'); wrapper.className = 'reflow-table';
        wrapper.tabIndex = 0; wrapper.setAttribute('aria-label', '表格，可横向滚动查看全部列');
        const table = safeTable(block.text); if (table) wrapper.append(table);
        element.append(wrapper);
        if (table?.rows[0]?.cells.length > 6) { const hint = document.createElement('small'); hint.className = 'translation-explanation'; hint.textContent = '横向滚动查看全部列'; element.append(hint); }
        blockTools(element, block, '复制表格 HTML', () => table?.outerHTML || '');
        sourceDetails(element, block, page, '对照表格原图');
      } else if (block.type === 'chart') {
        element.append(mediaCrop(block, page));
        const rows = markdownTableRows(block.text);
        if (rows.length) {
          const details = document.createElement('details'); details.className = 'translation-source chart-data';
          const summary = document.createElement('summary'); summary.textContent = '查看图表识别数据（模型估读，需核对）';
          const wrapper = document.createElement('div'); wrapper.className = 'reflow-table';
          const table = document.createElement('table');
          rows.forEach((row, index) => { const tr = document.createElement('tr'); row.forEach(cell => { const td = document.createElement(index === 0 ? 'th' : 'td'); richText(td, cell); tr.append(td); }); table.append(tr); });
          wrapper.append(table); details.append(summary, wrapper); element.append(details);
          blockTools(element, block, '复制图表 CSV', () => rows.map(row => row.map(cell => '"' + cell.replaceAll('"', '""') + '"').join(',')).join('\n'));
        } else if (block.text.trim()) { const content = document.createElement('p'); richText(content, block.text); element.append(content); }
      } else if (isMedia(block)) {
        element.append(mediaCrop(block, page));
      } else {
        const entry = recognitionOnly ? null : state.translations[block.id];
        const text = document.createElement('p'); text.className = 'reflow-text'; richText(text, entry?.text || block.text);
        if (!recognitionOnly && !entry && /[A-Za-z]/.test(block.text)) text.classList.add('translation-pending');
        element.append(text);
        if (recognitionOnly && /\$|\\\[|\\\(/.test(block.text)) { blockTools(element, block, '复制含 LaTeX 的原文'); sourceDetails(element, block, page, '对照段落原图'); }
        else if (recognitionOnly && block.confidence != null && block.confidence < .85) sourceDetails(element, block, page, '对照低置信度原文');
        if (block.type === 'seal') sourceDetails(element, block, page, '对照印章原图');
        if (entry && (entry.contextHash !== state.translationFingerprint || state.stale && state.stage !== 'translation' && state.stage !== 'done')) {
          const stale = document.createElement('small'); stale.className = 'translation-stale'; stale.textContent = '旧译文 · 待更新'; element.append(stale);
        }
        if (!recognitionOnly && state.errors[block.id]) { const error = document.createElement('p'); error.className = 'translation-error'; error.textContent = state.errors[block.id]; element.append(error); }
        if (entry) { const details = document.createElement('details'); details.className = 'translation-source'; const summary = document.createElement('summary'); summary.textContent = '查看识别原文'; const original = document.createElement('p'); original.textContent = block.text; details.append(summary, original); element.append(details); }
      }
      element.onpointerenter = element.onfocus = () => highlightSource(block);
      element.onpointerleave = element.onblur = clearHighlight;
      section.append(element);
    }
    if (!page.blocks.length) { const empty = document.createElement('p'); empty.textContent = '本页未识别到内容，请检查原文。'; section.append(empty); }
    return section;
  }
  function renderMath(element, text, displayMode = false) {
    try { katex.render(text, element, {displayMode, throwOnError: false, trust: false, strict: 'ignore', maxExpand: 1000}); }
    catch { element.textContent = text; }
    if (element.querySelector('.katex-error')) element.title = '公式语法需要校对，可修改 LaTeX';
  }
  function richText(element, text) {
    for (const segment of mathSegments(text)) {
      if (!segment.math) element.append(document.createTextNode(segment.text));
      else { const span = document.createElement(segment.display ? 'div' : 'span'); renderMath(span, segment.text, segment.display); element.append(span); }
    }
  }
  function safeTable(html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html').querySelector('table');
    if (!parsed) return null;
    const allowed = new Set(['TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'CAPTION', 'BR', 'P', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'SUP', 'SUB']);
    function copy(node) {
      if (node.nodeType === Node.TEXT_NODE) { if (!node.textContent.trim()) return document.createTextNode(node.textContent); const span = document.createElement('span'); richText(span, node.textContent); return span; }
      if (node.nodeType !== Node.ELEMENT_NODE || !allowed.has(node.tagName)) return document.createTextNode('');
      const element = document.createElement(node.tagName.toLowerCase());
      for (const key of ['rowspan', 'colspan']) { const count = Number(node.getAttribute(key)); if (Number.isInteger(count) && count > 0 && count <= 1000) element.setAttribute(key, count); }
      for (const child of node.childNodes) element.append(copy(child));
      return element;
    }
    return copy(parsed);
  }
  function blockTools(element, block, label, content = () => /^(formula|equation)$/.test(block.type) ? stripMathDelimiters(block.text) : block.text) {
    const toolbar = document.createElement('div'); toolbar.className = 'recognition-block-tools';
    const copy = document.createElement('button'); copy.textContent = label; copy.onclick = async () => { try { await navigator.clipboard.writeText(content()); toast('已复制'); } catch { toast('复制失败，请在校对窗口选中文字复制'); } };
    const edit = document.createElement('button'); edit.textContent = /^(formula|equation)$/.test(block.type) ? '校对 LaTeX' : '校对内容'; edit.disabled = Boolean(state.active); edit.onclick = () => showCorrections(block.id);
    toolbar.append(copy, edit); element.append(toolbar);
  }
  function sourceDetails(element, block, page, title) {
    const details = document.createElement('details'); details.className = 'translation-source';
    const summary = document.createElement('summary'); summary.textContent = title;
    details.append(summary, mediaCrop(block, page)); element.append(details);
  }
  function mediaCrop(block, page) {
    const canvas = document.createElement('canvas'); canvas.className = 'reflow-media';
    const raw = mediaBounds(block, page.blocks);
    const bounds = [Math.max(0, raw[0] - .0015), Math.max(0, raw[1] - .0015), Math.min(1, raw[2] + .0015), Math.min(1, raw[3] + .0015)];
    canvas.style.width = Math.round((bounds[2] - bounds[0]) * page.width / 2 * 1.8) + 'px';
    canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', (typeNames[block.type] || '原文区域') + '，第 ' + page.page + ' 页');
    sharpenMedia(canvas, block.page, bounds); return canvas;
  }
  function sourceImage(page) {
    if (!sourceImages.has(page.page)) sourceImages.set(page.page, new Promise((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => { sourceImages.delete(page.page); reject(Error('校正页面加载失败')); };
      image.src = '/api/papers/' + encodeURIComponent(paperId) + '/recognition/pages/' + page.page + '/image?v=' + encodeURIComponent(state.ocrProfile);
    }));
    return sourceImages.get(page.page);
  }
  function sourcePages() {
    const targetId = paperId;
    for (const page of state.pages.filter(page => page.sourceImage)) sourceImage(page).then(image => {
      if (targetId !== paperId || document.querySelector('#translated')?.hidden) return;
      const element = document.querySelector('#original .page[data-page="' + page.page + '"]');
      if (!element || element.dataset.recognitionSource) return;
      const canvas = element.querySelector('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0);
      element.style.height = element.clientWidth * image.naturalHeight / image.naturalWidth + 'px'; element.dataset.recognitionSource = 'true';
      const label = document.createElement('span'); label.className = 'recognition-source-label'; label.textContent = '识别校正页面'; element.append(label); sourceAnchors();
    }).catch(error => toast(error.message));
  }
  function sharpenMedia(canvas, pageNumber, [left, top, right, bottom]) {
    const pdf = getDocument(), targetId = paperId;
    const page = state.pages.find(page => page.page === pageNumber);
    if (page?.sourceImage) {
      sourceImage(page).then(image => {
        if (targetId !== paperId || !canvas.isConnected) return;
        canvas.width = Math.max(1, Math.ceil((right - left) * image.naturalWidth)); canvas.height = Math.max(1, Math.ceil((bottom - top) * image.naturalHeight));
        canvas.getContext('2d').drawImage(image, left * image.naturalWidth, top * image.naturalHeight, (right - left) * image.naturalWidth, (bottom - top) * image.naturalHeight, 0, 0, canvas.width, canvas.height); canvas.dataset.quality = 'corrected-source';
      }).catch(error => toast(error.message)); return;
    }
    if (!pdf) return;
    mediaQueue = mediaQueue.catch(() => {}).then(async () => {
      if (targetId !== paperId || !canvas.isConnected) return;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({scale: 3});
      const crop = document.createElement('canvas');
      crop.width = Math.max(1, Math.ceil((right - left) * viewport.width));
      crop.height = Math.max(1, Math.ceil((bottom - top) * viewport.height));
      await page.render({canvasContext: crop.getContext('2d'), viewport, transform: [1, 0, 0, 1, -left * viewport.width, -top * viewport.height]}).promise;
      if (targetId !== paperId || !canvas.isConnected) return;
      canvas.width = crop.width; canvas.height = crop.height;
      canvas.getContext('2d').drawImage(crop, 0, 0);
      canvas.dataset.quality = 'high';
    }).catch(() => {});
  }
  function clearHighlight() { document.querySelectorAll('.translation-source-focus').forEach(element => element.remove()); }
  function highlightSource(block) {
    clearHighlight();
    const source = document.querySelector('#original .page[data-page="' + block.page + '"]');
    if (!source) return;
    if (state.pages.find(page=>page.page===block.page)?.sourceImage && !source.dataset.recognitionSource) return;
    const highlight = document.createElement('div'); highlight.className = 'translation-source-focus';
    const [left, top, right, bottom] = block.bbox;
    Object.assign(highlight.style, {left: left * 100 + '%', top: top * 100 + '%', width: (right - left) * 100 + '%', height: (bottom - top) * 100 + '%'}); source.append(highlight);
  }
  function sourceAnchors() {
    document.querySelectorAll('.translation-source-anchor').forEach(element => element.remove());
    for (const block of state.blocks.filter(block => !isIgnored(block))) {
      const source = document.querySelector('#original .page[data-page="' + block.page + '"]'); if (!source) continue;
      if (state.pages.find(page => page.page === block.page)?.sourceImage && !source.dataset.recognitionSource) continue;
      const anchor = document.createElement('button'); anchor.className = 'translation-source-anchor'; anchor.textContent = block.order; anchor.setAttribute('aria-label', '查看第 ' + block.order + ' 块' + (recognitionOnly ? '识别内容' : '译文'));
      Object.assign(anchor.style, {left: Math.max(0, block.bbox[0] * 100 - 2) + '%', top: block.bbox[1] * 100 + '%'});
      anchor.onclick = event => { event.stopPropagation(); locateTranslation(block); }; source.append(anchor);
    }
  }
  function lockSync() { syncing = true; clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncing = false; }, 160); }
  function locateSource(block) {
    const source = document.querySelector('#original .page[data-page="' + block.page + '"]'), scroll = document.querySelector('#original'); if (!source || !scroll || scroll.hidden) return;
    lockSync(); scroll.scrollTop += source.getBoundingClientRect().top + block.bbox[1] * source.clientHeight - scroll.getBoundingClientRect().top - 36; highlightSource(block); updatePageNumber();
  }
  function locateTranslation(block) {
    const element = document.querySelector('.reflow-block[data-block-id="' + CSS.escape(block.id) + '"]'), scroll = document.querySelector('#translated'); if (!element || !scroll || scroll.hidden) return;
    lockSync(); scroll.scrollTop += element.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 100; element.focus({preventScroll: true}); highlightSource(block);
  }
  function syncFrom(side) {
    if (syncing || !state?.blocks.length || document.querySelector('#translated')?.hidden || document.querySelector('.pdf-area')?.classList.contains('translation-only')) return;
    if (side === 'original') {
      const scroll = document.querySelector('#original');
      const top = scroll.getBoundingClientRect().top + 55;
      const block = state.blocks.filter(block => !isIgnored(block)).find(block => {
        const page = scroll.querySelector('.page[data-page="' + block.page + '"]'); return page && page.getBoundingClientRect().top + block.bbox[3] * page.clientHeight > top;
      });
      if (block) locateTranslation(block);
    } else {
      const top = document.querySelector('#translated').getBoundingClientRect().top + 110;
      const element = [...document.querySelectorAll('.reflow-block')].find(element => element.getBoundingClientRect().bottom > top);
      const block = state.blocks.find(block => block.id === element?.dataset.blockId); if (block) locateSource(block);
    }
  }
  function updatePageNumber() {
    const scroll = document.querySelector('#original'), input = document.querySelector('#page-number'); if (!scroll || !input) return;
    const current = [...scroll.querySelectorAll('.page')].find(page => page.getBoundingClientRect().bottom > scroll.getBoundingClientRect().top + 100);
    if (current) input.value = current.dataset.page;
  }
  async function handleClick(event) {
    const action = event.target.closest('[data-translation-action]')?.dataset.translationAction; if (!action) return;
    try {
      if (action === 'start') await start();
      if (action === 'force') await start(true);
      if (action === 'cancel') { state = await api(endpoint() + '/cancel', {method: 'POST'}); render(); }
      if (action === 'context') showContext();
      if (action === 'correct') showCorrections();
      if (action === 'export') {
        const url = URL.createObjectURL(new Blob([recognitionMarkdown(state)], {type: 'text/markdown;charset=utf-8'}));
        const link = document.createElement('a'); link.href = url; link.download = getPaper().title + '-识别.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      if (action === 'export-json') {
        const url = URL.createObjectURL(new Blob([JSON.stringify({parser: state.parser, profile: state.ocrProfile, pages: state.pages}, null, 2)], {type: 'application/json;charset=utf-8'}));
        const link = document.createElement('a'); link.href = url; link.download = getPaper().title + '-识别.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (error) { toast(error.message); }
  }
  function evidenceButtons(evidence) { return evidence.map(id => `<button type="button" data-evidence="${escapeHtml(id)}">#${state.blocks.find(block => block.id === id)?.order || id}</button>`).join(' '); }
  function bindEvidence() {
    document.querySelectorAll('[data-evidence]').forEach(button => { button.onclick = () => { const block = state.blocks.find(block => block.id === button.dataset.evidence); if (block) locateSource(block); }; });
  }
  function showContext() {
    if (!state?.context) return;
    const context = structuredClone(state.context), revision = state.revision;
    modal(`<header class="settings-head"><h3>文章理解与统一术语</h3><button data-close aria-label="关闭">×</button></header><div class="translation-review-body">${[['problem', '研究问题'], ['method', '解决办法'], ['results', '结果展示']].map(([field, label]) => `<section><h4>${label}</h4>${context[field].length ? context[field].map(entry => `<p>${escapeHtml(entry.text)} <span class="translation-evidence">${evidenceButtons(entry.evidence)}</span></p>`).join('') : '<p class="muted">文中未明确说明</p>'}</section>`).join('')}<h4>术语与缩写</h4>${context.terms.map((entry, index) => `<div class="translation-term"><strong>${escapeHtml(entry.term)}</strong> ${evidenceButtons(entry.evidence)}<label>统一中文译法<input data-term-translation="${index}" value="${escapeHtml(entry.translation)}"></label><label>本文含义<textarea data-term-meaning="${index}">${escapeHtml(entry.meaning)}</textarea></label></div>`).join('') || '<p>未提取到有依据的专用术语。</p>'}<h4>数学符号</h4>${context.symbols.map((entry, index) => `<div class="translation-term"><strong>${escapeHtml(entry.symbol)}</strong> ${evidenceButtons(entry.evidence)}<label>本文定义与适用范围<textarea data-symbol-meaning="${index}">${escapeHtml(entry.meaning)}</textarea></label></div>`).join('') || '<p>未提取到有依据的符号定义。</p>'}</div><footer><span class="muted">保存修改后，按统一术语重译全文。</span><button data-close>关闭</button><button id="save-translation-context" ${state.active ? 'disabled' : ''}>保存并重译</button></footer>`, 'translation-review-modal');
    bindEvidence();
    document.querySelector('#save-translation-context').onclick = async event => {
      event.target.disabled = true;
      try {
        document.querySelectorAll('[data-term-translation]').forEach(input => { context.terms[Number(input.dataset.termTranslation)].translation = input.value; });
        document.querySelectorAll('[data-term-meaning]').forEach(input => { context.terms[Number(input.dataset.termMeaning)].meaning = input.value; });
        document.querySelectorAll('[data-symbol-meaning]').forEach(input => { context.symbols[Number(input.dataset.symbolMeaning)].meaning = input.value; });
        state = await api(endpoint(), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({revision, context})}); closeModal(); render(); await start();
      } catch (error) { toast(error.message); event.target.disabled = false; }
    };
  }
  function showCorrections(blockId) {
    if (!state?.blocks.length || state.active) return;
    const revision = state.revision, texts = {};
    const editable = state.blocks.filter(block => !isIgnored(block) && block.text.trim());
    if (!editable.length) return toast('没有可校对的识别文本');
    modal(`<header class="settings-head"><h3>校对识别文本</h3><button data-close aria-label="关闭">×</button></header><p>修正断词、识别错误或数学符号；${recognitionOnly ? '保存后立即更新阅读排版。' : '保存后重新分析文章并翻译。'}</p><label>按阅读顺序选择原文块<select id="ocr-review-block">${editable.map(block => `<option value="${escapeHtml(block.id)}">#${block.order} · 第 ${block.page} 页 · ${escapeHtml(typeNames[block.type] || block.type)} · ${escapeHtml(block.text.slice(0, 50))}</option>`).join('')}</select></label><div id="ocr-review-meta"></div><textarea id="ocr-review-text" rows="12" aria-label="识别文本"></textarea><footer><button id="ocr-review-locate">定位原文</button><button data-close>取消</button><button id="save-ocr-review">${recognitionOnly ? '保存校对' : '保存并重译'}</button></footer>`, 'translation-review-modal');
    let selected = editable.find(block => block.id === blockId) || editable[0];
    document.querySelector('#ocr-review-block').value = selected.id;
    const textarea = document.querySelector('#ocr-review-text');
    function loadBlock() {
      textarea.value = texts[selected.id] ?? selected.text;
      document.querySelector('#ocr-review-meta').textContent = /^(formula|equation)$/.test(selected.type) ? '编辑 LaTeX；保存后公式立即重新排版' : selected.type === 'table' ? '编辑表格 HTML；保存后更新结构化表格' : selected.confidence == null ? '置信度未提供' : '文字识别置信度：' + Math.round(selected.confidence * 100) + '%';
    }
    loadBlock();
    textarea.oninput = () => { texts[selected.id] = textarea.value; };
    document.querySelector('#ocr-review-block').onchange = event => { selected = editable.find(block => block.id === event.target.value); loadBlock(); };
    document.querySelector('#ocr-review-locate').onclick = () => locateSource(selected);
    document.querySelector('#save-ocr-review').onclick = async event => {
      event.target.disabled = true;
      try { state = await api(endpoint(), {method: 'PATCH', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({revision, texts})}); closeModal(); render(); if (!recognitionOnly) await start(); else toast('校对已保存，识别排版已更新'); }
      catch (error) { toast(error.message); event.target.disabled = false; }
    };
  }
  return {attach, detach, render, ensureStarted, start};
}

export function addModelPresets() {
  const protocol = document.querySelector('#protocol'); if (!protocol) return;
  const description = document.querySelector('#settings-basic h4:nth-of-type(2) + p');
  if (description) description.textContent = '选择 DeepSeek 官方或自定义接口。OCR 在本机运行，文章文本发送到配置的模型服务。';
  protocol.insertAdjacentHTML('beforebegin', '<label>服务预设</label><select id="model-preset"><option value="custom">当前 / 自定义接口</option><option value="deepseek">DeepSeek 官方 · Flash</option><option value="ollama">Ollama 本机服务</option></select>');
  const preset = document.querySelector('#model-preset');
  if (document.querySelector('#api-url').value.includes('api.deepseek.com')) preset.value = 'deepseek';
  preset.onchange = () => {
    if (preset.value === 'deepseek') { protocol.value = 'openai'; document.querySelector('#api-url').value = 'https://api.deepseek.com/v1'; document.querySelector('#api-model').value = 'deepseek-flash'; }
    if (preset.value === 'ollama') { protocol.value = 'ollama'; document.querySelector('#api-url').value = 'http://localhost:11434/api'; document.querySelector('#api-model').value = 'qwen3:8b'; }
  };
}
