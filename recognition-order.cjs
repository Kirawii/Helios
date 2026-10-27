const {ignoredBlock} = require('./translation-model.cjs');

function readingOrder(blocks) {
  const normalized = blocks.map(block => {
    const type = block.type === 'vision_footnote' ? 'text' : block.type === 'figure_title' && /^\s*Table\s+\d/i.test(block.text) ? 'table_title' : block.type;
    return type === block.type ? block : {...block, sourceType: block.type, type};
  });
  const visible = normalized.filter(block => !ignoredBlock(block));
  const overlapsColumn = (first, second) => {
    const overlap = Math.min(first.bbox[2], second.bbox[2]) - Math.max(first.bbox[0], second.bbox[0]);
    return overlap > .5 * Math.min(first.bbox[2] - first.bbox[0], second.bbox[2] - second.bbox[0]);
  };
  const titleInversion = visible.some((block, index) => block.type === 'paragraph_title' &&
    visible.slice(0, index).some(previous => previous.type === 'text' && overlapsColumn(block, previous) && previous.bbox[1] > block.bbox[1] + .003));
  if (!blocks.some(block => block.type === 'vision_footnote') && !titleInversion) return normalized;

  const topDown = (first, second) => first.bbox[1] - second.bbox[1] || first.bbox[0] - second.bbox[0];
  const wideEnough = block => block.bbox[2] - block.bbox[0] >= .15;
  const left = visible.filter(block => wideEnough(block) && block.bbox[2] <= .51);
  const right = visible.filter(block => wideEnough(block) && block.bbox[0] >= .49);
  const twoColumns = left.some(a => right.some(b => Math.min(a.bbox[3], b.bbox[3]) > Math.max(a.bbox[1], b.bbox[1])));
  let ordered;
  if (!twoColumns) ordered = [...visible].sort(topDown);
  else {
    // Full-width titles/figures split a page into bands. Read each band's left
    // column before its right column, with headings preceding the text below.
    const spanning = visible.filter(block => block.bbox[0] < .49 && block.bbox[2] > .51).sort(topDown);
    const spanningIds = new Set(spanning.map(block => block.id));
    const bands = Array.from({length: spanning.length + 1}, () => []);
    for (const block of visible) {
      if (spanningIds.has(block.id)) continue;
      const center = (block.bbox[1] + block.bbox[3]) / 2;
      const index = spanning.findIndex(span => center < (span.bbox[1] + span.bbox[3]) / 2);
      bands[index < 0 ? spanning.length : index].push(block);
    }
    const column = block => (block.bbox[0] + block.bbox[2]) / 2 < .5 ? 0 : 1;
    ordered = bands.flatMap((band, index) => [...band.sort((a, b) => column(a) - column(b) || topDown(a, b)), ...(spanning[index] ? [spanning[index]] : [])]);
  }
  return [...ordered, ...normalized.filter(ignoredBlock)];
}

module.exports = {readingOrder};
