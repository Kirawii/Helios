// Geometry heuristics for the fast path. Original PDF text/coordinates are kept
// even when a formula/image candidate needs further recognition.
const IDENTITY = [1, 0, 0, 1, 0, 0];
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const point = (m, x, y) => [m[0]*x+m[2]*y+m[4], m[1]*x+m[3]*y+m[5]];
const union = boxes => [Math.min(...boxes.map(b=>b[0])), Math.min(...boxes.map(b=>b[1])), Math.max(...boxes.map(b=>b[2])), Math.max(...boxes.map(b=>b[3]))];
const area = b => Math.max(0,b[2]-b[0])*Math.max(0,b[3]-b[1]);
const contains = (outer, inner) => inner[0]>=outer[0]-.002 && inner[1]>=outer[1]-.002 && inner[2]<=outer[2]+.002 && inner[3]<=outer[3]+.002;
const mathFont = name => /math|symbol|cmmi|cmsy|cmex|msam|msbm|stix|txmi|txsy|txex/i.test(name);

function normalizedBox(points, width, height) {
  const box = [Math.min(...points.map(p=>p[0]))/width, Math.min(...points.map(p=>p[1]))/height, Math.max(...points.map(p=>p[0]))/width, Math.max(...points.map(p=>p[1]))/height].map(v=>Math.max(0,Math.min(1,v)));
  return area(box)>0 ? box : null;
}

function visualRegions(operators, OPS, viewport) {
  let matrix = IDENTITY; const stack = [], forms = [], candidates = [];
  const add = (bounds, type, transform = matrix) => {
    const m = multiply(viewport.transform, transform);
    const box = normalizedBox([[bounds[0],bounds[1]],[bounds[2],bounds[1]],[bounds[0],bounds[3]],[bounds[2],bounds[3]]].map(([x,y])=>point(m,x,y)),viewport.width,viewport.height);
    if (box && area(box)>.00001) candidates.push({bbox:box,type});
  };
  for (let index=0;index<operators.fnArray.length;index++) {
    const op=operators.fnArray[index], args=operators.argsArray[index];
    if (op===OPS.save) stack.push(matrix);
    else if (op===OPS.restore) matrix=stack.pop()||IDENTITY;
    else if (op===OPS.transform && args?.length===6) matrix=multiply(matrix,args);
    else if (op===OPS.paintFormXObjectBegin) {
      forms.push({matrix,bounds:args?.[1],visual:false}); if(args?.[0]) matrix=multiply(matrix,args[0]);
      forms.at(-1).transform=matrix;
    } else if(op===OPS.paintFormXObjectEnd) {
      const form=forms.pop();
      if(form?.visual&&form.bounds?.length===4)add(form.bounds,'form',form.transform);
      matrix=form?.matrix||matrix;
    }
    else if([OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject].includes(op)) add([0,0,1,1],'image');
    else if(op===OPS.paintImageXObjectRepeat && args?.[3]) {
      for(let i=0;i<args[3].length;i+=2) add([0,0,1,1],'image',multiply(matrix,[args[1],0,0,args[2],args[3][i],args[3][i+1]]));
    }
    if([OPS.constructPath,OPS.paintImageXObject,OPS.paintInlineImageXObject,OPS.paintImageMaskXObject,OPS.paintImageXObjectRepeat].includes(op))for(const form of forms)form.visual=true;
  }
  // Page-sized Forms are containers, not figure crops. Nested figure children
  // are represented by the outer figure once, so their text is not OCR'd twice.
  const figures=candidates.filter(r=>r.type==='form'&&area(r.bbox)<.65&&area(r.bbox)>.001);
  const unique=[];
  for(const candidate of [...figures,...candidates.filter(r=>r.type==='image')].sort((a,b)=>area(b.bbox)-area(a.bbox))) {
    if(!unique.some(existing=>contains(existing.bbox,candidate.bbox))) unique.push(candidate);
  }
  return unique;
}

const GUTTER_EPS = .002;
const BOLD_FONT = /bold|black|heavy|semibold|demi|medi|cmbx|bx\d|[-_ ]b$|tb$/i;
const OPERATOR_WORDS = /\b(?:exp|log|ln|sin|cos|tan|max|min|arg|sup|inf|lim|det|softmax|tr|diag)\b/g;
const MATH_SYMBOL = /[∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩∀∃∂∇±×÷→←⇒⇔∝∼≡⊕⊗∥⟨⟩\u{1D400}-\u{1D7FF}]/u;
const MATH_SYMBOLS = /[∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩∀∃∂∇±×÷→←⇒⇔∝∼≡⊕⊗∥⟨⟩\u{1D400}-\u{1D7FF}]/gu;
const MATH_FRAGMENT = /^(?:[\d\s+−\-*/=<>()[\]{},.;:^_|′'~]|(?<![A-Za-zα-ωΑ-Ω])[A-Za-zα-ωΑ-Ω](?![A-Za-zα-ωΑ-Ω])|[∑∏∫√∞≤≥≠≈∈∉⊂⊆∪∩∀∃∂∇±×÷→←⇒⇔∝∼≡⊕⊗∥⟨⟩\u{1D400}-\u{1D7FF}])*$/u;
const TRIVIAL_MATH = /^[\s\d.,;:+−\-×±†•=()[\]{}|%]+$/u;
const FORMULA_NUMBER = /^\(\s*\d+(\.\d+)?[a-z]?\s*\)$/;
const CAPTION = /^(Figure|Fig\.|Table|Algorithm)\s*\d+[.:]/i;
const NUMBERED_HEADING = /^((\d+(\.\d+)*\.?)|[IVX]+\.|[A-Z]\.)\s+\S/;
const BULLET = /^(?:[•◦▪∙·]\s*|[-–—*]\s+|\(\w{1,2}\)\s+|\d{1,2}[.)]\s+|\[\d{1,3}\]\s*)\S/;
const hasWord = text => /[A-Za-z]{3,}/.test(text.replace(OPERATOR_WORDS, ' '));
const looksMath = text => MATH_SYMBOL.test(text) && !hasWord(text);
const numeric = (a, b) => a - b;

// Sides of a vertical gutter: -1 entirely left, 1 entirely right, 0 crossing it.
const gutterSide = (box, gutter) => gutter == null ? 0 : box[2] <= gutter + GUTTER_EPS ? -1 : box[0] >= gutter - GUTTER_EPS ? 1 : 0;
const acrossGutter = (a, b, gutter) => gutter != null && gutterSide(a, gutter) * gutterSide(b, gutter) === -1;

// Finds a vertical whitespace channel between two columns of horizontal text.
function detectGutter(runs) {
  const boxes = runs.filter(run => !run.rotated && run.text.trim()).map(run => run.bbox);
  if (boxes.length < 10) return null;
  const counts = x => {
    let left = 0, right = 0, cross = 0;
    for (const box of boxes) {
      if (box[2] > x - .06 && box[2] <= x) left++;
      if (box[0] >= x && box[0] < x + .06) right++;
      if (box[0] < x - .002 && box[2] > x + .002) cross++;
    }
    return {left, right, cross, score: Math.min(left, right) - 2 * cross};
  };
  const scores = [];
  for (let step = 0; step <= 160; step++) scores.push(counts(.3 + step * .0025).score);
  const best = Math.max(...scores);
  let plateau = null, current = null;
  scores.forEach((score, index) => {
    if (score !== best) { current = null; return; }
    if (!current) current = {start: index, end: index};
    current.end = index;
    if (!plateau || current.end - current.start > plateau.end - plateau.start || current === plateau) plateau = current;
  });
  if (!plateau) return null;
  const x = .3 + (plateau.start + plateau.end) / 2 * .0025, found = counts(x), shortest = Math.min(found.left, found.right);
  return shortest >= 5 && shortest > 2 * found.cross ? x : null;
}

// Rows: runs on one baseline that are close in points and not on opposite sides of the gutter.
function buildRows(runs, gutter, viewport) {
  const near = (row, other) => {
    const height = Math.max(row.height, other.height);
    return Math.abs(row.baseline - other.baseline) < height * .6 &&
      Math.max(0, row.bbox[0] - other.bbox[2], other.bbox[0] - row.bbox[2]) * viewport.width < height * viewport.height * 2 &&
      !acrossGutter(row.bbox, other.bbox, gutter);
  };
  const rows = [];
  for (const run of [...runs].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
    let row = rows.findLast(candidate => near(candidate, run));
    if (!row) { row = {runs: [], bbox: run.bbox, height: run.height, baseline: run.baseline}; rows.push(row); }
    row.runs.push(run); row.bbox = union(row.runs.map(r => r.bbox)); row.height = Math.max(row.height, run.height);
  }
  // Ascenders and subscripts arrive in different top-coordinate order. A late
  // glyph can bridge two row fragments; coalesce them before choosing formulas.
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]; let joined;
    do {
      joined = false;
      for (let other = index + 1; other < rows.length; other++) {
        const next = rows[other];
        if (!near(row, next)) continue;
        row.runs.push(...next.runs); row.bbox = union([row.bbox, next.bbox]);
        if (next.height > row.height) row.baseline = next.baseline;
        row.height = Math.max(row.height, next.height); rows.splice(other, 1); joined = true; break;
      }
    } while (joined);
  }
  return rows;
}

const dominantSize = (runs, weight = run => run.text.length) => {
  const weights = new Map();
  for (const run of runs) { const key = Math.round(run.size * 4) / 4; weights.set(key, (weights.get(key) || 0) + weight(run)); }
  let best = 0, bestWeight = -1;
  for (const [size, total] of weights) if (total > bestWeight || (total === bestWeight && size > best)) { best = size; bestWeight = total; }
  return best;
};

function finishRow(row, viewport) {
  row.runs.sort((a, b) => a.bbox[0] - b.bbox[0]);
  let text = '', previous = null;
  for (const run of row.runs) {
    const gap = previous ? (run.bbox[0] - previous.bbox[2]) * viewport.width : 0;
    if (previous && gap > row.height * viewport.height * .12 && !/\s$/.test(text) && !/^\s/.test(run.text)) text += ' ';
    run.start = text.length; text += run.text; run.end = text.length; previous = run;
  }
  row.text = text; row.left = row.bbox[0] * viewport.width;
  row.size = dominantSize(row.runs) || row.height * viewport.height;
  row.bold = row.runs.every(run => !run.text.trim() || run.bold);
  return row;
}

function visualLines(rows) {
  const lines = [];
  for (const row of [...rows].sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])) {
    let line = lines.slice(-4).findLast(candidate => Math.abs(candidate.baseline - row.baseline) < Math.max(candidate.height, row.height) * .6);
    if (!line) { line = {rows: [], baseline: row.baseline, height: row.height, top: row.bbox[1], bottom: row.bbox[3]}; lines.push(line); }
    line.rows.push(row); line.height = Math.max(line.height, row.height); line.top = Math.min(line.top, row.bbox[1]); line.bottom = Math.max(line.bottom, row.bbox[3]);
  }
  return lines.sort((a, b) => a.top - b.top);
}

// Running headers/footers: short, not larger than the body, and separated from the body by a clear gap.
function edgeLines(lines, fromTop, body, viewport) {
  const list = fromTop ? lines : [...lines].reverse(), bodyGap = body / viewport.height * .9, group = [];
  for (let index = 0; index < Math.min(3, list.length); index++) {
    const line = list[index];
    const zone = fromTop ? line.bottom < .13 : line.top > .8;
    const limit = fromTop ? 120 : 80;
    if (!zone || line.height * viewport.height > body * 1.1 + .01) return [];
    if (line.rows.some(row => row.text.trim().length >= limit || CAPTION.test(row.text.trim()) || (row.bold && NUMBERED_HEADING.test(row.text.trim())))) return [];
    group.push(line);
    const next = list[index + 1];
    if (!next) return [];
    if ((fromTop ? next.top - line.bottom : line.top - next.bottom) > bodyGap) return group;
  }
  return [];
}

const mathRowKind = row => {
  const text = row.text.trim();
  if (!text) return null;
  let mathCharacters = 0;
  for (const run of row.runs) mathCharacters += run.math ? run.text.replace(/\s/g, '').length : (run.text.match(MATH_SYMBOLS) || []).length;
  if (mathCharacters / row.text.length > .25 && !row.runs.some(run => !run.math && hasWord(run.text))) return 'ratio';
  if (text.length <= 6 && MATH_FRAGMENT.test(text)) return 'fragment';
  return null;
};

function spatialOrder(blocks, gutter = null) {
  const topDown = (a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0];
  const aside = block => /^(footer|page_number|number|aside_text)$/.test(block.type);
  const headers = blocks.filter(block => block.type === 'header').sort(topDown);
  const trailing = blocks.filter(aside).sort(topDown);
  const body = blocks.filter(block => block.type !== 'header' && !aside(block));
  let ordered;
  if (gutter == null) ordered = [...body].sort(topDown);
  else {
    const side = block => gutterSide(block.bbox, gutter);
    const spanning = body.filter(block => side(block) === 0).sort(topDown);
    const bands = Array.from({length: spanning.length + 1}, () => []), ids = new Set(spanning.map(block => block.id));
    for (const block of body) {
      if (ids.has(block.id)) continue;
      const center = (block.bbox[1] + block.bbox[3]) / 2;
      const band = spanning.findIndex(span => center < (span.bbox[1] + span.bbox[3]) / 2);
      bands[band < 0 ? spanning.length : band].push(block);
    }
    ordered = bands.flatMap((band, index) => [...band.sort((a, b) => side(a) - side(b) || topDown(a, b)), ...(spanning[index] ? [spanning[index]] : [])]);
  }
  return [...headers, ...ordered, ...trailing];
}

async function analyzeNativePage(page, OPS, signal, regions) {
  if(regions!==undefined){const {extractRuns,buildModelPlan}=require('./pdf-layout-model.cjs');return buildModelPlan(await extractRuns(page,signal),regions);}
  signal.throwIfAborted();
  const started = performance.now();
  const [content, operators] = await Promise.all([page.getTextContent(), page.getOperatorList()]);
  signal.throwIfAborted();
  const viewport = page.getViewport({scale: 1}), runs = [];
  const figures = visualRegions(operators, OPS, viewport);
  for (const item of content.items) {
    if (!item.str?.trim() || !item.transform) continue;
    const transform = multiply(viewport.transform, item.transform), h = Math.max(1, Math.hypot(transform[2], transform[3]));
    const angle = Math.atan2(transform[1], transform[0]), width = Math.max(.5, item.width * viewport.scale);
    const ascent = content.styles[item.fontName]?.ascent ?? .85;
    const baseline = [transform[4], transform[5]], advance = [Math.cos(angle) * width, Math.sin(angle) * width], up = [Math.sin(angle) * h, -Math.cos(angle) * h];
    const corners = [0, 1].flatMap(end => [-.2, ascent].map(rise => [baseline[0] + end * advance[0] + rise * up[0], baseline[1] + end * advance[1] + rise * up[1]]));
    const bbox = normalizedBox(corners, viewport.width, viewport.height); if (!bbox) continue;
    let font = ''; try { font = page.commonObjs.get(item.fontName)?.name || ''; } catch {}
    runs.push({text: item.str, bbox, font, math: mathFont(font) || looksMath(item.str), bold: BOLD_FONT.test(font), size: h, rotated: Math.abs(angle) > .1745, height: h / viewport.height, baseline: baseline[1] / viewport.height});
  }
  const characters = runs.reduce((n, r) => n + r.text.length, 0);
  const badCharacters = runs.reduce((n, r) => n + (r.text.match(/[�\u0000]/g) || []).length, 0);
  const hasDrawing = figures.length || operators.fnArray.some(op => op === OPS.constructPath);
  const usable = characters >= 30 && badCharacters / characters < .15;
  if (!usable) {
    return {page: page.pageNumber, width: viewport.width, height: viewport.height, blocks: [], tasks: hasDrawing || characters ? [{id: `p${page.pageNumber}-scan`, kind: 'page', bbox: [0, 0, 1, 1]}] : [], nativeCharacters: characters, scanFallback: Boolean(hasDrawing || characters), gutter: null, parseMs: performance.now() - started};
  }
  const textRuns = runs.filter(run => !figures.some(figure => contains(figure.bbox, run.bbox)));
  const rotatedRuns = textRuns.filter(run => run.rotated), horizontal = textRuns.filter(run => !run.rotated);
  const gutter = detectGutter(horizontal);
  const pageNumber = page.pageNumber;

  // Margin line numbers (review manuscripts): integer-only runs outside the body text edges.
  const isInteger = run => /^\d{1,4}$/.test(run.text.trim());
  let marginNumbers = [];
  const wordRuns = horizontal.filter(run => !isInteger(run));
  if (wordRuns.length < horizontal.length && wordRuns.length) {
    const preliminary = buildRows(wordRuns, gutter, viewport);
    if (preliminary.length >= 5) {
      const percentile = (values, p) => values.sort(numeric)[Math.min(values.length - 1, Math.floor(p * values.length))];
      const left = percentile(preliminary.map(row => row.bbox[0]), .05), right = percentile(preliminary.map(row => row.bbox[2]), .95);
      marginNumbers = horizontal.filter(run => isInteger(run) && (run.bbox[2] <= left + .001 || run.bbox[0] >= right - .001) &&
        !wordRuns.some(other => Math.abs(other.baseline - run.baseline) < Math.max(other.height, run.height) * .6 &&
          Math.max(0, other.bbox[0] - run.bbox[2], run.bbox[0] - other.bbox[2]) * viewport.width < run.size * .75));
    }
  }
  const marginSet = new Set(marginNumbers);
  const flowRuns = horizontal.filter(run => !marginSet.has(run));

  const rows = buildRows(flowRuns, gutter, viewport).map(row => finishRow(row, viewport));
  rows.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
  const bodySize = dominantSize(flowRuns) || .015 * viewport.height, bodyHeight = bodySize / viewport.height;
  const maxSize = Math.max(0, ...rows.map(row => row.size));

  // Running headers, footers and bare page numbers.
  const lines = visualLines(rows);
  if (lines.length >= 5) {
    for (const [fromTop, header, footer] of [[true, 'header', 'header'], [false, 'footer', 'footer']])
      for (const line of edgeLines(lines, fromTop, bodySize, viewport)) for (const row of line.rows) row.kind = /^\d+$/.test(row.text.trim()) ? 'page_number' : (fromTop ? header : footer);
  }
  for (const row of rows) if (!row.kind && /^\d+$/.test(row.text.trim()) && (row.bbox[1] < .06 || row.bbox[3] > .94)) row.kind = 'page_number';

  // Display equations: cluster vertically adjacent math rows into one formula.
  const columnOf = box => gutterSide(box, gutter);
  const clusters = [], tolerance = bodySize * 1.5 / viewport.width;
  for (const row of rows) {
    if (row.kind || FORMULA_NUMBER.test(row.text.trim())) continue;
    row.mathKind = mathRowKind(row);
    if (!row.mathKind) continue;
    const cluster = clusters.findLast(candidate => row.bbox[1] - candidate.bbox[3] < bodyHeight * .8 && candidate.bbox[1] - row.bbox[3] < bodyHeight * .8 &&
      row.bbox[0] < candidate.bbox[2] + tolerance && row.bbox[2] > candidate.bbox[0] - tolerance && columnOf(row.bbox) === columnOf(candidate.bbox));
    if (cluster) { cluster.rows.push(row); cluster.bbox = union([cluster.bbox, row.bbox]); }
    else clusters.push({rows: [row], bbox: row.bbox});
  }
  const formulas = clusters.filter(cluster => {
    const joined = cluster.rows.map(row => row.text.trim()).join(' ');
    return cluster.rows.some(row => row.mathKind === 'ratio' && !TRIVIAL_MATH.test(row.text.trim()) && !/^[\p{L}\p{N}]$/u.test(row.text.trim())) && !TRIVIAL_MATH.test(joined);
  });
  for (const cluster of formulas) {
    cluster.rows.sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0]);
    for (const row of cluster.rows) row.cluster = cluster;
  }
  for (const row of rows) {
    if (row.kind || row.cluster || !FORMULA_NUMBER.test(row.text.trim())) continue;
    const center = (row.bbox[1] + row.bbox[3]) / 2;
    if (formulas.some(cluster => row.bbox[0] >= cluster.bbox[2] - .002 && center >= cluster.bbox[1] - bodyHeight * .3 && center <= cluster.bbox[3] + bodyHeight * .3 && columnOf(row.bbox) === columnOf(cluster.bbox))) row.kind = 'formula_number';
  }

  const blocks = [], tasks = [], info = new Map(), open = {L: [], R: [], S: []};
  const columnKey = row => gutter == null ? 'S' : ({'-1': 'L', 1: 'R', 0: 'S'})[gutterSide(row.bbox, gutter)];
  const close = key => { if (key === 'S') { open.L = []; open.R = []; open.S = []; } else { open.S = []; open[key] = []; } };
  const register = (key, block) => { if (key === 'S') { open.L = []; open.R = []; } else open.S = []; open[key].push(block); if (open[key].length > 8) open[key].shift(); };
  const newBlock = (type, bbox, height) => {
    const block = {id: `p${pageNumber}-b${blocks.length}`, page: pageNumber, type, text: '', originalText: '', bbox, regions: [], lines: [], fontHeight: height, source: 'pdf-text', format: 'text', confidence: null, positionGranularity: 'line'};
    blocks.push(block); return block;
  };
  const pushLine = (block, row, prefix) => {
    block.bbox = union([block.bbox, row.bbox]); block.regions.push(row.bbox);
    block.lines.push({text: row.text, bbox: row.bbox, start: prefix, end: prefix + row.text.length, runs: row.runs.map(run => ({text: run.text, bbox: run.bbox, start: prefix + run.start, end: prefix + run.end, math: run.math, font: run.font}))});
  };
  // Joins a line wrapped inside a word ("exam-" / "ple") without a newline; the
  // previous line/run ranges are shortened so offsets still index originalText.
  const dehyphenate = (block, row) => {
    const last = block.lines.at(-1);
    if (!last || !/(?<![A-Za-z0-9-])[A-Za-z]{2,}-$/.test(block.originalText) || !/^[a-z]/.test(row.text)) return false;
    const lastRun = last.runs.reduce((a, b) => b.end >= a.end ? b : a);
    if (lastRun.math || tasks.some(task => task.blockId === block.id && task.end >= block.originalText.length)) return false;
    block.originalText = block.originalText.slice(0, -1); last.end--; if (lastRun.end > lastRun.start) lastRun.end--;
    return true;
  };
  const detectInline = (block, row, prefix) => {
    const text = row.text;
    let groups = [];
    for (let index = 0; index < row.runs.length; index++) {
      if (!row.runs[index].math) continue;
      let last = index;
      while (last + 1 < row.runs.length && (row.runs[last + 1].math || /^[\d\s=+−\-*/()[\]{},.;:^_|]+$/.test(row.runs[last + 1].text)) && row.runs[last + 1].bbox[0] - row.runs[last].bbox[2] < row.height * 1.5) last++;
      groups.push(row.runs.slice(index, last + 1)); index = last;
    }
    const mathCharacters = row.runs.filter(run => run.math).reduce((n, run) => n + run.text.length, 0);
    if (groups.length && mathCharacters / text.length > .25 && !row.runs.some(run => !run.math && /[A-Za-z]{3,}/.test(run.text))) groups = [row.runs];
    else {
      const merged = [];
      for (const group of groups) {
        const previous = merged.at(-1), between = previous ? text.slice(previous.at(-1).end, group[0].start) : '';
        if (previous && between.length < 12 && !/[A-Za-z]{3,}|[.!?;]/.test(between)) merged[merged.length - 1] = row.runs.filter(run => run.start >= previous[0].start && run.end <= group.at(-1).end);
        else merged.push(group);
      }
      groups = merged;
    }
    for (const group of groups) {
      const original = text.slice(group[0].start, group.at(-1).end).trim();
      // Unicode numbers, comparison/table symbols and single variables already
      // have an exact text-layer representation; do not OCR them again.
      if (TRIVIAL_MATH.test(original) || /^[\p{L}\p{N}]$/u.test(original)) continue;
      const bounds = union(group.map(run => run.bbox));
      const padding = Math.min(.006, row.height * .25);
      const bbox = [Math.max(0, bounds[0] - padding), Math.max(0, bounds[1] - padding), Math.min(1, bounds[2] + padding), Math.min(1, bounds[3] + padding)];
      tasks.push({id: `${block.id}-m${tasks.length}`, kind: 'formula', bbox, blockId: block.id, start: prefix + group[0].start, end: prefix + group.at(-1).end, status: 'pending'});
    }
  };
  const appendRow = (block, row, inline = true) => {
    let prefix = 0;
    if (block.originalText.length) {
      if (dehyphenate(block, row)) prefix = block.originalText.length;
      else { block.originalText += '\n'; prefix = block.originalText.length; }
    }
    block.originalText += row.text; block.text = block.originalText;
    pushLine(block, row, prefix);
    if (inline) detectInline(block, row, prefix);
  };
  const headingType = row => {
    const text = row.text.trim();
    if (text.length > 100 || (text.match(/,/g) || []).length >= 2 || /^\d+$/.test(text) || !/[A-Za-z]/.test(text)) return null;
    const heading = row.size >= bodySize * 1.15 || (row.bold && (NUMBERED_HEADING.test(text) || text.length < 60));
    if (!heading) return null;
    return pageNumber === 1 && row.bbox[1] < .4 && row.size >= bodySize * 1.3 && row.size >= maxSize * .95 ? 'doc_title' : 'paragraph_title';
  };
  const rowType = row => {
    const text = row.text.trim();
    if (CAPTION.test(text)) return /^table/i.test(text) ? 'table_title' : 'figure_title';
    return headingType(row) || 'text';
  };
  const continues = (state, block, row, type) => {
    if (type === 'doc_title' ? state.kind !== 'doc_title' : type !== 'text' || state.kind === 'doc_title') return false;
    if (Math.abs(row.size - state.size) > state.size * .2) return false;
    const gap = (row.bbox[1] - block.bbox[3]) * viewport.height;
    if (gap >= state.size * .8 || gap < -state.size * .6) return false;
    if (type === 'doc_title') return true;
    if (BULLET.test(row.text.trim())) return false;
    const em = state.size, shift = row.left - state.first, bodyLeft = state.body ?? state.first;
    if (state.bullet && state.count === 1 && shift >= -2 && shift <= 3 * em) return true;       // hanging indent
    if (Math.abs(row.left - bodyLeft) <= 2) return true;                                         // same body-left
    return state.count === 1 && state.first - row.left > 2 && state.first - row.left <= 3 * em;  // first-line indent
  };

  const emitted = new Set();
  for (const row of rows) {
    if (row.cluster) {
      const cluster = row.cluster;
      if (emitted.has(cluster)) continue;
      emitted.add(cluster);
      const block = newBlock('formula', cluster.bbox, Math.max(...cluster.rows.map(r => r.height)));
      block.format = 'latex';
      for (const member of cluster.rows) {
        const prefix = block.originalText.length ? block.originalText.length + 1 : 0;
        block.originalText += (prefix ? ' ' : '') + member.text; pushLine(block, member, prefix);
      }
      block.text = block.originalText;
      const padding = Math.min(.006, block.fontHeight * .25), b = block.bbox;
      tasks.push({id: `${block.id}-m${tasks.length}`, kind: 'formula', bbox: [Math.max(0, b[0] - padding), Math.max(0, b[1] - padding), Math.min(1, b[2] + padding), Math.min(1, b[3] + padding)], blockId: block.id, start: 0, end: block.text.length, status: 'pending'});
      close(columnKey({bbox: cluster.bbox}));
      continue;
    }
    if (row.kind) {
      appendRow(newBlock(row.kind, row.bbox, row.height), row, false);
      continue;
    }
    const type = rowType(row), key = columnKey(row);
    let block = null;
    if (type === 'text' || type === 'doc_title') block = open[key].slice(-6).findLast(candidate => continues(info.get(candidate), candidate, row, type)) || null;
    if (block) {
      const state = info.get(block);
      appendRow(block, row); block.fontHeight = Math.max(block.fontHeight, row.height);
      if (state.count === 1) state.body = row.left;
      state.count++;
    } else {
      block = newBlock(type, row.bbox, row.height);
      appendRow(block, row);
      if (type === 'paragraph_title') close(key);
      else { info.set(block, {kind: type, first: row.left, body: null, size: row.size, count: 1, bullet: BULLET.test(row.text.trim())}); register(key, block); }
    }
  }
  for (const run of rotatedRuns) {
    const block = newBlock('aside_text', run.bbox, run.height);
    appendRow(block, finishRow({runs: [run], bbox: run.bbox, height: run.height, baseline: run.baseline}, viewport), false);
  }
  for (const run of marginNumbers) {
    const block = newBlock('number', run.bbox, run.height);
    appendRow(block, finishRow({runs: [run], bbox: run.bbox, height: run.height, baseline: run.baseline}, viewport), false);
  }
  for (const figure of figures) {
    const id = `p${pageNumber}-b${blocks.length}`;
    blocks.push({id, page: pageNumber, type: 'image', text: '', bbox: figure.bbox, source: 'pdf-visual', format: 'image', confidence: null, positionGranularity: 'block', candidateKind: figure.type});
    tasks.push({id: id + '-ocr', kind: 'image', bbox: figure.bbox, blockId: id, status: 'pending'});
  }
  const ordered = spatialOrder(blocks, gutter).map((block, index) => ({...block, order: index + 1, sourceOrder: index + 1}));
  return {page: pageNumber, width: viewport.width, height: viewport.height, blocks: ordered, tasks, nativeCharacters: characters, scanFallback: false, gutter, parseMs: performance.now() - started, sourceKind: 'pdf-native', positionGranularity: 'line'};
}

module.exports = {analyzeNativePage, visualRegions, spatialOrder, detectGutter, multiply};
