// Layout heuristics of the native PDF text path, driven by a fake pdf.js page (no PDF, no rendering).
const assert = require('node:assert/strict');
const {analyzeNativePage} = require('../pdf-native.cjs');

const OPS = {save: 1, restore: 2, transform: 3, paintFormXObjectBegin: 4, paintFormXObjectEnd: 5, paintImageXObject: 6, paintInlineImageXObject: 7, paintImageMaskXObject: 8, paintImageXObjectRepeat: 9, constructPath: 10};
const signal = new AbortController().signal;
const FONTS = {t: 'Times-Roman', b: 'Times-Bold', m: 'CMMI10'};
const PAGE = {width: 612, height: 792};

// Items are described by their top coordinate (y grows downward) like a rendered page.
const item = (str, x, top, {size = 10, width, font = 't'} = {}) => ({str, fontName: font, width: width ?? str.length * size * .5, transform: [size, 0, 0, size, x, PAGE.height - (top + size * .8)]});
const fakePage = (items, pageNumber = 2) => ({
  pageNumber,
  commonObjs: {get: name => ({name: FONTS[name] || name})},
  getViewport: () => ({...PAGE, scale: 1, transform: [1, 0, 0, -1, 0, PAGE.height]}),
  getTextContent: async () => ({items, styles: {t: {ascent: .8}, b: {ascent: .8}, m: {ascent: .8}}}),
  getOperatorList: async () => ({fnArray: [], argsArray: []}),
});
const analyze = (items, pageNumber) => analyzeNativePage(fakePage(items, pageNumber), OPS, signal);
const words = 'alpha beta gamma delta epsilon zeta theta kappa lambda sigma omega tau'.split(' ');
const sentence = (seed, length = 70) => { let text = ''; for (let i = 0; text.length < length; i++) text += (text ? ' ' : '') + words[(seed * 7 + i * 3) % words.length]; return text; };
const column = (x, top, count, width, label) => Array.from({length: count}, (_, i) => item(`${label} ${i} ${sentence(i + label.length, 50)}`, x, top + i * 12, {width}));
const textBlocks = plan => plan.blocks.filter(block => block.type === 'text');
const byType = (plan, type) => plan.blocks.filter(block => block.type === type);

(async () => {
  // (a) Two columns separated by a 14pt gutter must never merge into one line/block.
  {
    const plan = await analyze([...column(54, 100, 30, 238, 'LEFT'), ...column(306, 100, 30, 238, 'RIGHT')]);
    assert.ok(plan.gutter > .47 && plan.gutter < .5, 'gutter detected at ' + plan.gutter);
    for (const block of plan.blocks) assert.ok(block.bbox[2] <= plan.gutter + .003 || block.bbox[0] >= plan.gutter - .003, 'block crosses gutter: ' + block.text.slice(0, 40));
    assert.ok(plan.blocks.every(block => !(/LEFT/.test(block.text) && /RIGHT/.test(block.text))));
    const kinds = plan.blocks.map(block => /LEFT/.test(block.text) ? 'L' : 'R').join('');
    assert.match(kinds, /^L+R+$/, 'left column fully precedes right column: ' + kinds);
    assert.ok(plan.blocks.every((block, index) => block.order === index + 1));
    const single = await analyze(column(54, 100, 30, 504, 'ONE'));
    assert.equal(single.gutter, null);
  }

  // (b) + (c) First-line indents keep a paragraph together; a hyphenated line break joins into one word.
  {
    const lines = (x, top, texts) => texts.map((text, i) => item(text, x[i] ?? x.at(-1), top + i * 12, {width: 478 - ((x[i] ?? x.at(-1)) - 54)}));
    const plan = await analyze([
      ...lines([69, 54], 200, ['First paragraph begins with an indent and runs on for a while here', 'second line of the first paragraph shows a hyphenated exam-', 'ple that continues on the following line of the paragraph text', 'and the first paragraph ends here.']),
      ...lines([69, 54], 248, ['Second paragraph starts with an indent too and continues for a bit', 'with a second line of body text', 'and a closing line.']),
    ]);
    const blocks = textBlocks(plan);
    assert.equal(blocks.length, 2, JSON.stringify(blocks.map(block => block.text)));
    assert.match(blocks[0].originalText, /hyphenated example that continues/);
    assert.ok(!/exam-\nple/.test(blocks[0].originalText));
    const [first, second] = blocks[0].lines.slice(1, 3);
    assert.equal(blocks[0].originalText.slice(first.start, first.end).replace(/-$/, ''), 'second line of the first paragraph shows a hyphenated exam');
    assert.equal(first.end, second.start, 'joined lines are contiguous');
    assert.equal(blocks[0].originalText.slice(second.start, second.start + 3), 'ple');
    const lastRun = first.runs.at(-1);
    assert.equal(lastRun.end, first.end);
    assert.equal(plan.tasks.length, 0);
  }

  // (d) Running header, page number and margin line numbers are typed, not body text.
  {
    const body = Array.from({length: 20}, (_, i) => item(sentence(i, 60 + (i % 5) * 5), 100, 150 + i * 12, {width: 400}));
    const numbers = Array.from({length: 20}, (_, i) => item(String(i + 1), 60, 150 + i * 12));
    const plan = await analyze([item('Journal of Examples', 100, 40, {size: 8}), ...body, ...numbers, item('7', 300, 750)]);
    assert.equal(byType(plan, 'header').length, 1);
    assert.equal(byType(plan, 'header')[0].text, 'Journal of Examples');
    assert.equal(byType(plan, 'page_number').length, 1);
    assert.equal(byType(plan, 'number').length, 20);
    assert.ok(textBlocks(plan).every(block => !/^\d+$/.test(block.text)));
    assert.equal(textBlocks(plan).length, 1);
    assert.equal(plan.blocks[0].type, 'header');
    // A rotated margin stamp becomes aside_text.
    const stamp = {str: 'arXiv:1234.56789v1 [cs.LG] 1 Jan 2024', fontName: 't', width: 200, transform: [0, 10, -10, 0, 20, 300]};
    const stamped = await analyze([...body, stamp]);
    assert.equal(byType(stamped, 'aside_text').length, 1);
    assert.ok(textBlocks(stamped).every(block => !/arXiv/.test(block.text)));
  }

  // (e) A multi-level display equation is one formula block, one OCR task and a separate equation number.
  {
    const above = Array.from({length: 6}, (_, i) => item(sentence(i + 3, 70), 100, 300 + i * 12, {width: 400}));
    const below = Array.from({length: 6}, (_, i) => item(sentence(i + 9, 70), 100, 430 + i * 12, {width: 400}));
    const plan = await analyze([...above,
      item('a+b', 255, 384, {size: 8, font: 'm'}), item('E =', 232, 392, {font: 'm'}), item('c+d', 255, 403, {size: 8, font: 'm'}), item('(1)', 500, 392),
      ...below]);
    const formulas = byType(plan, 'formula');
    assert.equal(formulas.length, 1, JSON.stringify(plan.blocks.map(block => [block.type, block.text])));
    assert.equal(formulas[0].format, 'latex');
    assert.match(formulas[0].text, /a\+b/); assert.match(formulas[0].text, /c\+d/);
    const formulaTasks = plan.tasks.filter(task => task.kind === 'formula');
    assert.equal(formulaTasks.length, 1);
    assert.equal(formulaTasks[0].blockId, formulas[0].id);
    assert.equal(formulaTasks[0].start, 0); assert.equal(formulaTasks[0].end, formulas[0].text.length);
    const numberBlocks = byType(plan, 'formula_number');
    assert.equal(numberBlocks.length, 1); assert.equal(numberBlocks[0].text, '(1)');
    assert.ok(plan.tasks.every(task => task.blockId !== numberBlocks[0].id));
    assert.ok(textBlocks(plan).every(block => !/a\+b|\(1\)/.test(block.text)));
  }

  // (f) Headings: bold same-size numbered heading; author line with commas is not a title.
  {
    const body = Array.from({length: 8}, (_, i) => item(sentence(i + 1, 75), 100, 300 + i * 12, {width: 400}));
    const plan = await analyze([
      item('Deep Learning for Examples', 100, 80, {size: 20, font: 'b'}),
      item('Alice Smith, Bob Jones, Carol Lee', 100, 120, {size: 12}),
      ...body,
      item('2 Method', 100, 420, {font: 'b'}),
      ...Array.from({length: 4}, (_, i) => item(sentence(i + 5, 75), 100, 440 + i * 12, {width: 400})),
    ], 1);
    assert.equal(byType(plan, 'doc_title').length, 1);
    assert.equal(byType(plan, 'doc_title')[0].text, 'Deep Learning for Examples');
    const method = plan.blocks.find(block => block.text === '2 Method');
    assert.equal(method.type, 'paragraph_title');
    const authors = plan.blocks.find(block => /Alice Smith/.test(block.text));
    assert.equal(authors.type, 'text');
    assert.equal(byType(plan, 'paragraph_title').length, 1);
    const caption = await analyze([...body, item('Figure 3: A caption that spans', 100, 420), item('two lines of smaller text.', 100, 432)]);
    assert.equal(byType(caption, 'figure_title').length, 1);
    assert.match(byType(caption, 'figure_title')[0].text, /caption that spans\ntwo lines/);
  }
  console.log('PASS: gutter-aware columns, paragraph indents, de-hyphenation offsets, header/footer/margin numbers, display equations, heading and caption typing');
})().catch(error => { console.error(error); process.exitCode = 1; });
