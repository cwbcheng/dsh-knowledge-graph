import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const environment = { window: { React: {} }, console }
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { createGraphImageIndex, visualTranscriptImageAt, sourceImageForNode,'), environment)
const { createGraphImageIndex, visualTranscriptImageAt, sourceImageForNode } = environment.window.KGViewer
const compare = (source, paragraphs) => {
  const before = JSON.stringify(source), index = createGraphImageIndex(source)
  for (const paragraph of paragraphs) assert.equal(index.transcriptAt(paragraph), visualTranscriptImageAt(source, paragraph),
    'Indexed provenance must retain the first original image for paragraph ' + String(paragraph))
  const nodes = [null, {}, { type: 'fact', id: 'image:missing' }, { type: 'image', id: 'image:missing' },
    ...(source?.images || []).map(image => ({ type: 'image', id: 'image:' + encodeURIComponent(image.id) }))]
  for (const node of nodes) assert.equal(index.sourceForNode(node), sourceImageForNode(source, node))
  const validParagraphs = paragraphs.filter(Number.isSafeInteger)
  const originalFigures = indices => source?.kind === 'markdown-assets' ? (source.images || []).filter(image =>
    (image.paragraphs || []).some(paragraph => indices.includes(paragraph)) ||
    (image.interpretationStatus === 'ai_unverified' && indices.includes(image.startParagraph))) : []
  for (const paragraph of validParagraphs) assert.deepEqual(Array.from(index.figuresForParagraphs([paragraph])), originalFigures([paragraph]))
  for (const indices of [[], validParagraphs, [...validParagraphs].reverse(), [0, 0, 1, -1]]) {
    assert.deepEqual(Array.from(index.figuresForParagraphs(indices)), originalFigures(indices),
      'Grouped figures must retain every original entry in source order without repeating paragraph anchors')
  }
  assert.equal(JSON.stringify(source), before, 'Indexing must not sort or rewrite stored image metadata')
  return index
}
const invalidParagraphs = [null, undefined, '2', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]
for (const source of [null, undefined, {}, { images: [] }]) compare(source, [-1, 0, 1, ...invalidParagraphs])
const images = [
  { id: 'first > 空格', startParagraph: 5, endParagraph: 8, interpretationStatus: 'ai_unverified' },
  { id: 'earlier-start', startParagraph: 0, endParagraph: 20, interpretationStatus: 'ai_unverified' },
  { id: 'first > 空格', startParagraph: -5, endParagraph: -1, interpretationStatus: 'ai_unverified' },
  { id: 'nested', startParagraph: 6, endParagraph: 7, interpretationStatus: 'ai_unverified' },
  { id: 'adjacent', startParagraph: 21, endParagraph: 22, interpretationStatus: 'ai_unverified' },
  { id: 'unrequested', startParagraph: 23, endParagraph: 25, interpretationStatus: 'not_requested' },
  { id: 'reversed', startParagraph: 10, endParagraph: 9, interpretationStatus: 'ai_unverified' },
  { id: 'numeric-string', startParagraph: '26', endParagraph: 27, interpretationStatus: 'ai_unverified' },
  { id: 'fractional', startParagraph: 28.5, endParagraph: 29, interpretationStatus: 'ai_unverified' },
  { id: 'absent-range', interpretationStatus: 'ai_unverified' },
  { id: 'unsafe-end', startParagraph: 30, endParagraph: Number.MAX_SAFE_INTEGER + 1, interpretationStatus: 'ai_unverified' },
]
const paragraphs = [...Array.from({ length: 40 }, (_, i) => i - 6), ...invalidParagraphs]
for (const kind of ['markdown-assets', 'image-derived', undefined]) {
  const source = { kind, images }, index = compare(source, paragraphs)
  assert.equal(index.transcriptAt(5), images[0], 'Earlier array order wins over an earlier range start')
  assert.equal(index.transcriptAt(8), images[0], 'The range end remains inclusive')
  assert.equal(index.transcriptAt(9), images[1], 'An expired higher-priority interval reveals the enclosing image')
  assert.equal(index.transcriptAt(21), images[4], 'Touching ranges do not overlap past their endpoint')
  assert.equal(index.transcriptAt(23), kind === 'image-derived' ? images[5] : null,
    'Unrequested markdown images are not AI evidence; image-derived ranges retain their legacy meaning')
  assert.equal(index.sourceForNode({ type: 'image', id: 'image:' + encodeURIComponent(images[0].id) }), images[0],
    'Duplicate IDs keep the first original object and exact encoded identity')
  assert.equal(index.sourceForNode({ type: 'image', id: 'image:' + encodeURIComponent(images[0].id) + ' ' }), null)
}

// Wide ranges must use bounded storage, including the last safe integer.
const huge = { kind: 'image-derived', images: [
  { id: 'single', startParagraph: Number.MAX_SAFE_INTEGER, endParagraph: Number.MAX_SAFE_INTEGER },
  { id: 'wide', startParagraph: Number.MIN_SAFE_INTEGER, endParagraph: Number.MAX_SAFE_INTEGER },
] }
compare(huge, [Number.MIN_SAFE_INTEGER, -1, 0, 1, Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, ...invalidParagraphs])

// Fixed-seed overlap probes cover heap expiry in a different order from starts.
let seed = 0x321978
const random = bound => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % bound }
for (let trial = 0; trial < 200; trial++) {
  const source = { kind: trial % 2 ? 'image-derived' : 'markdown-assets', images: Array.from({ length: 64 }, (_, i) => {
    const start = random(100) - 40
    return { id: 'random-' + i, startParagraph: start, endParagraph: start + random(70) - 4,
      paragraphs: [random(100) - 40, start, start, String(start), start + 0.5],
      interpretationStatus: random(3) ? 'ai_unverified' : 'not_requested' }
  }) }
  compare(source, Array.from({ length: 171 }, (_, i) => i - 50))
}

let reads = 0
const originals = Array.from({ length: 200 }, (_, i) => ({ id: 'figure-' + i, startParagraph: i * 50,
  endParagraph: i * 50 + 20, interpretationStatus: 'ai_unverified' }))
const source = { kind: 'markdown-assets', images: new Proxy(originals, { get(target, key, receiver) {
  if (typeof key === 'string' && /^\d+$/.test(key)) reads++
  return Reflect.get(target, key, receiver)
} }) }
const index = createGraphImageIndex(source)
assert.equal(reads, originals.length, 'Build must read each image record exactly once')
for (let paragraph = 0; paragraph < 12000; paragraph++) {
  assert.equal(index.transcriptAt(paragraph), originals.find(image => paragraph >= image.startParagraph && paragraph <= image.endParagraph) || null)
  assert.equal(index.sourceForNode({ type: 'image', id: 'image:figure-' + paragraph % 200 }), originals[paragraph % 200])
}
assert.equal(reads, originals.length, 'Lookups must not return to the full image list')
for (const path of ['src/index.client.js', 'lib/client.js']) {
  assert(readFileSync(new URL('../' + path, import.meta.url), 'utf8').includes(createGraphImageIndex.toString()), path + ': generated index parity')
}
console.log(JSON.stringify({ ok: true, overlapProbes: 200, firstMatchAndInclusiveBounds: true,
  exactImageIdentity: true, boundedHugeRanges: true, originalMetadataUnchanged: true,
  groupedSourceFigures: true, exactParagraphAnchors: true,
  graphParagraphs: 12000, imageRecords: 200, imageReads: reads, generatedParity: true }))
