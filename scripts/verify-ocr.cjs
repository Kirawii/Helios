const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {OcrWorker} = require('../ocr-worker.cjs');

(async () => {
  const input = path.resolve(process.argv[2] || path.join(__dirname, 'citation-fixture.pdf'));
  const engine = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const document = await engine.getDocument({data: new Uint8Array(fs.readFileSync(input)), useSystemFonts: true}).promise;
  const pageCount = document.numPages;
  await document.destroy();
  const pages = process.argv[3] ? process.argv[3].split(',').map(Number) : Array.from({length: pageCount}, (_, index) => index + 1);
  assert.ok(pages.every(page => Number.isInteger(page) && page > 0 && page <= pageCount));
  const worker = new OcrWorker(), parsed = [];
  try {
    const result = await worker.request({path: input, pageCount, pages}, event => {
      if (event.event === 'loading') console.log('Loading PP-StructureV3 CPU models...');
      if (event.event === 'page') {
        const page = event.data;
        assert.equal(page.blocks.length, new Set(page.blocks.map(block => block.id)).size);
        assert.ok(page.blocks.every(block => block.bbox.every(value => value >= 0 && value <= 1)));
        parsed.push(page);
        console.log('Page ' + page.page + ': ' + page.blocks.length + ' ordered blocks; types: ' + [...new Set(page.blocks.map(block => block.type))].join(', '));
      }
    });
    assert.deepEqual(parsed.map(page => page.page), pages);
    assert.ok(parsed.some(page => page.blocks.some(block => block.text.trim())));
    const output = process.env.HELIOS_OCR_REPORT;
    if (output) fs.writeFileSync(output, JSON.stringify({signature: result.signature, pages: parsed}, null, 2));
    console.log('PASS: real PaddleOCR, all requested pages, stable IDs, normalized geometry');
  } finally { worker.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
