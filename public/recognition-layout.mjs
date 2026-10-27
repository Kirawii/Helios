// Include a formula's printed equation numbers in its original-image crop.
export function preserveInlineMath(block) {
  return /^(text|abstract|figure_title|table_title|footnote)$/.test(block.type) &&
    /[=∑∏∫∥⊗∈≤≥±≈≠→←∝∞∇∂α-ωΑ-Ω]|\$|\\[A-Za-z]+|\b[A-Za-z]\s*\*(?:\s|[),.;])/u.test(block.text);
}

export function mediaBounds(block, blocks) {
  const bounds = [...block.bbox];
  if (block.type !== 'formula') return bounds;
  const [, top, right, bottom] = block.bbox;
  for (const candidate of blocks) {
    if (candidate.type !== 'formula_number') continue;
    const [x0, y0, x1, y1] = candidate.bbox;
    const center = (y0 + y1) / 2;
    if (center < top - .003 || center > bottom + .003 || x0 < right - .003 || x0 - right > .25) continue;
    if (right <= .5 && x0 >= .5) continue;
    bounds[1] = Math.min(bounds[1], y0);
    bounds[2] = Math.max(bounds[2], x1);
    bounds[3] = Math.max(bounds[3], y1);
  }
  return bounds;
}
