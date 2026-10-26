const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
const isMedia = block => /^(image|figure|chart|table|formula|equation|algorithm)$/.test(block.type);
const isIgnored = block => /^(header|footer|page_number|number|formula_number|header_image|footer_image|seal)$/.test(block.type);
const typeNames = {doc_title: '文章标题', paragraph_title: '章节标题', text: '正文', abstract: '摘要', figure_title: '图注', table_title: '表注', image: '插图', table: '表格', formula: '公式', reference: '参考文献', reference_content: '参考文献', footnote: '脚注'};
const stageNames = {ocr: '识别与阅读顺序', analysis: '文章理解与术语', translation: '全文翻译', done: '翻译结果'};

export function createTranslationReader({getPaper, getConfig, api, toast, settings, modal, closeModal, mode = 'recognition'}) {
  const recognitionOnly = mode === 'recognition';
  let state = null, paperId = null, timer = null, generation = 0, syncing = false, syncTimer = null;
  let pageSignatures = new Map();
  const endpoint = () => '/api/papers/' + encodeURIComponent(paperId) + '/' + mode;
  function detach() {
    generation++; clearTimeout(timer); clearTimeout(syncTimer); paperId = null; state = null; pageSignatures.clear();
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
    const progress = state?.progress || {done: 0, total: 0};
    workspace.querySelector('.translation-task').innerHTML = `<div class="translation-task-heading"><strong>${escapeHtml(labels[state?.status] || '准备识别')}</strong><span>${progress.done} / ${progress.total}${state?.stage === 'ocr' ? ' 页' : ' 块'}</span></div><progress aria-label="当前阶段进度" value="${progress.done}" max="${Math.max(1, progress.total)}"></progress><ol class="translation-stages">${(recognitionOnly ? ['识别内容类型', '恢复阅读顺序', '重排阅读与校对'] : ['识别', '文章理解', '翻译']).map(label => `<li>${label}</li>`).join('')}</ol>${state?.error ? `<p class="translation-error" role="status">${escapeHtml(state.error)}</p>` : ''}<div class="translation-task-actions">${active ? '<button data-translation-action="cancel">停止处理</button>' : `<button class="primary" data-translation-action="start">${recognitionOnly ? state?.blocks?.length ? '继续 / 检查识别' : '开始全文识别' : '继续 / 重试翻译'}</button>`}${recognitionOnly ? '' : `<button data-translation-action="context" ${state?.context ? '' : 'disabled'}>文章理解与术语</button>`}<button data-translation-action="correct" ${state?.blocks?.length && !active ? '' : 'disabled'}>校对识别文本</button>${!recognitionOnly && state?.status === 'completed' ? '<button data-translation-action="force">重新翻译全文</button>' : ''}</div><small class="translation-explanation">${recognitionOnly ? '本机识别，无需模型密钥。' : ''}图表、公式保留原图；编号连接原文与${recognitionOnly ? '识别结果' : '译文'}。</small>`;
    const documentContainer = workspace.querySelector('.translation-document');
    if (!state?.pages?.length) {
      documentContainer.innerHTML = recognitionOnly ? '<div class="translation-empty"><h3>让论文结构清晰可读</h3><p>本机识别标题、段落、图表与公式，按阅读顺序重排。识别结果自动保存，可以逐块校对。</p></div>' : '<div class="translation-empty"><h3>在中文里读懂这篇论文</h3><p>先识别文章结构，再统一术语，最后逐段翻译。结果会自动保存。</p></div>';
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
    sourceAnchors();
  }
  function renderPage(page) {
    const section = document.createElement('section'); section.className = 'reflow-page'; section.dataset.translationPage = page.page;
    const heading = document.createElement('h3'); heading.className = 'reflow-page-label'; heading.textContent = '第 ' + page.page + ' 页'; section.append(heading);
    for (const block of page.blocks.filter(block => !isIgnored(block))) {
      const element = document.createElement('article'); element.className = 'reflow-block'; element.dataset.blockId = block.id; element.tabIndex = 0;
      if (/title/.test(block.type) && !/figure|table|chart/.test(block.type)) element.classList.add('reflow-heading');
      const label = document.createElement('button'); label.className = 'reflow-block-label'; label.textContent = '#' + block.order + ' · ' + (typeNames[block.type] || block.type) + (block.confidence != null && block.confidence < .85 ? ' · 建议校对' : ''); label.title = '定位原文'; label.onclick = () => locateSource(block);
      element.append(label);
      if (isMedia(block)) {
        const source = document.querySelector('#original .page[data-page="' + block.page + '"] canvas');
        if (source) {
          const canvas = document.createElement('canvas'); canvas.className = 'reflow-media';
          const [left, top, right, bottom] = block.bbox;
          canvas.width = Math.max(1, Math.round((right - left) * source.width)); canvas.height = Math.max(1, Math.round((bottom - top) * source.height));
          canvas.getContext('2d').drawImage(source, left * source.width, top * source.height, (right - left) * source.width, (bottom - top) * source.height, 0, 0, canvas.width, canvas.height);
          canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', (typeNames[block.type] || '原文区域') + '，第 ' + page.page + ' 页'); element.append(canvas);
        }
      } else {
        const entry = recognitionOnly ? null : state.translations[block.id];
        const text = document.createElement('p'); text.className = 'reflow-text'; text.textContent = entry?.text || block.text;
        if (!recognitionOnly && !entry && /[A-Za-z]/.test(block.text)) text.classList.add('translation-pending');
        element.append(text);
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
  function clearHighlight() { document.querySelectorAll('.translation-source-focus').forEach(element => element.remove()); }
  function highlightSource(block) {
    clearHighlight();
    const source = document.querySelector('#original .page[data-page="' + block.page + '"]');
    if (!source) return;
    const highlight = document.createElement('div'); highlight.className = 'translation-source-focus';
    const [left, top, right, bottom] = block.bbox;
    Object.assign(highlight.style, {left: left * 100 + '%', top: top * 100 + '%', width: (right - left) * 100 + '%', height: (bottom - top) * 100 + '%'}); source.append(highlight);
  }
  function sourceAnchors() {
    document.querySelectorAll('.translation-source-anchor').forEach(element => element.remove());
    for (const block of state.blocks.filter(block => !isIgnored(block))) {
      const source = document.querySelector('#original .page[data-page="' + block.page + '"]'); if (!source) continue;
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
  function showCorrections() {
    if (!state?.blocks.length || state.active) return;
    const revision = state.revision, texts = {};
    const editable = state.blocks.filter(block => block.text.trim());
    if (!editable.length) return toast('没有可校对的识别文本');
    modal(`<header class="settings-head"><h3>校对识别文本</h3><button data-close aria-label="关闭">×</button></header><p>修正断词、识别错误或数学符号；${recognitionOnly ? '保存后立即更新阅读排版。' : '保存后重新分析文章并翻译。'}</p><label>按阅读顺序选择原文块<select id="ocr-review-block">${editable.map(block => `<option value="${escapeHtml(block.id)}">#${block.order} · 第 ${block.page} 页 · ${escapeHtml(typeNames[block.type] || block.type)} · ${escapeHtml(block.text.slice(0, 50))}</option>`).join('')}</select></label><div id="ocr-review-meta"></div><textarea id="ocr-review-text" rows="12" aria-label="识别文本"></textarea><footer><button id="ocr-review-locate">定位原文</button><button data-close>取消</button><button id="save-ocr-review">${recognitionOnly ? '保存校对' : '保存并重译'}</button></footer>`, 'translation-review-modal');
    let selected = editable[0];
    const textarea = document.querySelector('#ocr-review-text');
    function loadBlock() { textarea.value = texts[selected.id] ?? selected.text; document.querySelector('#ocr-review-meta').textContent = selected.confidence == null ? '置信度未提供' : '识别置信度：' + Math.round(selected.confidence * 100) + '%'; }
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
