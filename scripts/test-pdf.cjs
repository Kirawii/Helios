function testPdf() {
  const objects = [];
  const add = content => { objects.push(content); return objects.length; };
  add('<< /Type /Catalog /Pages 2 0 R >>');
  add('<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>');
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const text of ['SYNTHETIC FUNCTIONAL TEST: Two distinct representations.', 'SYNTHETIC FUNCTIONAL TEST: Evidence and methods on page 2.']) {
    const stream = 'BT /F1 12 Tf 40 720 Td (' + text + ') Tj ET';
    const pageId = objects.length + 1;
    add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + (pageId + 1) + ' 0 R >>');
    add('<< /Length ' + Buffer.byteLength(stream) + ' >>\nstream\n' + stream + '\nendstream');
  }
  let result = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(result)); result += (index + 1) + ' 0 obj\n' + object + '\nendobj\n'; });
  const crossReference = Buffer.byteLength(result);
  result += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  result += offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
  result += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + crossReference + '\n%%EOF\n';
  return Buffer.from(result);
}
module.exports = {testPdf};
