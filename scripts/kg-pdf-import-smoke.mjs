import { deflateSync } from 'node:zlib'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function makePdf(text) {
  const content = Buffer.from(`BT /F1 12 Tf 72 720 Td (${text}) Tj ET`, 'latin1')
  const stream = deflateSync(content)
  return Buffer.concat([
    Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'),
  ])
}

function makeUnicodePdf() {
  const cmap = [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /DshKgUnicode def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    '4 beginbfchar',
    '<0001> <5982>',
    '<0002> <4F55>',
    '<0003> <4EBA>',
    '<0004> <751F>',
    'endbfchar',
    'endcmap',
    'CMapName currentdict /CMap defineresource pop',
    'end',
    'end',
  ].join('\n')
  const content = 'BT /F1 18 Tf 72 720 Td <0001000200030004> Tj ET'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /DshKgUnicode /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DshKgUnicode /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> >>',
    `<< /Length ${Buffer.byteLength(cmap, 'latin1')} >>\nstream\n${cmap}\nendstream`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ]
  let source = '%PDF-1.7\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(source, 'latin1'))
    source += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xrefOffset = Buffer.byteLength(source, 'latin1')
  source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let index = 1; index < offsets.length; index++) source += String(offsets[index]).padStart(10, '0') + ' 00000 n \n'
  source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  return Buffer.from(source, 'latin1')
}

const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get() { return null },
  interval() { return () => {} },
})

const pdf = makePdf('PDF knowledge graph support')
const imported = await handlers.get('document-import')({
  uploads: [{ name: 'knowledge.pdf', mediaType: 'application/pdf', data: pdf.toString('base64') }],
})
assert(imported && !imported.error, 'direct PDF import failed')
assert(imported.title === 'knowledge', 'PDF title was not derived from the filename')
assert(imported.text.includes('PDF knowledge graph support'), 'PDF text was not extracted')
assert(imported.files.length === 1 && imported.files[0].format === 'pdf', 'PDF metadata was not returned')
assert(imported.files[0].bytes === pdf.length, 'PDF byte count is incorrect')
assert(imported.files[0].warning && imported.files[0].warning.includes('扫描版 PDF'), 'PDF extraction warning is missing')
assert(imported.warnings.some((warning) => warning.includes('扫描版 PDF')), 'PDF warning was not surfaced to the client')
assert(imported.manifest && imported.manifest.documentId, 'PDF import manifest is missing')

const unicodePdf = makeUnicodePdf()
const unicodeImported = await handlers.get('document-import')({
  uploads: [{ name: 'unicode.pdf', mediaType: 'application/pdf', data: unicodePdf.toString('base64') }],
})
assert(unicodeImported && !unicodeImported.error, 'ToUnicode PDF import failed')
assert(unicodeImported.text.includes('如何人生'), 'PDF.js did not decode the ToUnicode font mapping')

const disguised = await handlers.get('document-import')({
  uploads: [{ name: 'fake.pdf', mediaType: 'application/pdf', data: Buffer.from('not a pdf').toString('base64') }],
})
assert(disguised && disguised.error && disguised.error.code === 'no_attachment', 'disguised PDF was accepted')
assert(Array.isArray(disguised.warnings) && disguised.warnings.some((warning) => warning.includes('不是有效的 PDF')), 'invalid PDF warning is missing')

const spoofedMediaType = await handlers.get('document-import')({
  uploads: [{ name: 'notes.txt', mediaType: 'application/pdf', data: Buffer.from('plain text').toString('base64') }],
})
assert(spoofedMediaType && spoofedMediaType.error && spoofedMediaType.warnings.some((warning) => warning.includes('不是有效的 PDF')), 'spoofed PDF media type was accepted')

const nonPdf = await handlers.get('document-import')({
  uploads: [{ name: 'notes.txt', mediaType: 'text/plain', data: Buffer.from('plain text').toString('base64') }],
})
assert(nonPdf && nonPdf.error && nonPdf.warnings.some((warning) => warning.includes('仅支持 PDF')), 'non-PDF direct upload was accepted')

console.log(JSON.stringify({ ok: true, bytes: pdf.length, chars: imported.files[0].chars, documentId: imported.manifest.documentId }))
