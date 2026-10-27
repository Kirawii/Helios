export function stripMathDelimiters(value) {
  const text = String(value || '').trim();
  for (const [start, end] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']]) {
    if (text.startsWith(start) && text.endsWith(end)) return text.slice(start.length, -end.length).trim();
  }
  return text;
}

export function mathSegments(value) {
  const text = String(value || ''), result = [];
  const pattern = /(?<!\\)(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?!\$)[^$\n]+?\$)/g;
  let previous = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > previous) result.push({text: text.slice(previous, match.index)});
    result.push({text: stripMathDelimiters(match[0]), math: true, display: match[0].startsWith('$$') || match[0].startsWith('\\[')});
    previous = match.index + match[0].length;
  }
  if (previous < text.length) result.push({text: text.slice(previous)});
  return result;
}

export function markdownTableRows(value) {
  const lines = String(value || '').trim().split(/\r?\n/).filter(line => line.includes('|'));
  const rows = lines.map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, '|')));
  return rows.filter(row => !row.every(cell => /^:?-{2,}:?$/.test(cell)));
}

export function recognitionMarkdown(state) {
  return state.pages.map(page => '## 第 ' + page.page + ' 页\n\n' + page.blocks.filter(block => block.order != null).map(block => {
    const anchor = '<!-- #' + block.order + ' ' + block.id + ' -->\n';
    if (block.type === 'formula' || block.type === 'equation') return anchor + '$$\n' + stripMathDelimiters(block.text) + '\n$$';
    if (block.type === 'paragraph_title') return anchor + '### ' + block.text;
    if (block.type === 'doc_title') return anchor + '# ' + block.text;
    if (block.type === 'chart') return anchor + '> 图表数据为模型估读，请核对原图。\n\n' + block.text;
    if (/^(image|figure|algorithm)$/.test(block.type)) return anchor + '[原图：第 ' + page.page + ' 页，' + block.bbox.join(', ') + ']';
    return anchor + block.text;
  }).join('\n\n')).join('\n\n');
}
