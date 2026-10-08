// Render the production source rows with an optional baseline revision.
// node scripts/kg-source-image-performance.mjs [baseline-git-revision]
// --smoke checks lookup bounds and source/table behavior without timing gates.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const smoke = process.argv.includes('--smoke')
const revision = process.argv.slice(2).find(value => value !== '--smoke')
if (revision?.startsWith('-')) throw new Error('Expected a git revision')
const client = revision ? execFileSync('git', ['show', revision + ':src/index.client.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  : readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('        const paraEl = (p, i) => {')
const end = client.indexOf('        const inputPanel = ', start)
const helperStart = client.indexOf('      function visualTranscriptImageAt(')
const helperEnd = client.indexOf('      function createGraphNodeSearch(', helperStart)
assert(start >= 0 && end > start && helperStart >= 0 && helperEnd > helperStart)
const memoLine = client.split('\n').find(line => line.includes('const sourceImageIndex = useMemo(')) || ''
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const SourceFigure = () => {}
const renderer = new Function('h', 'React', 'SourceFigure', 'displayView', 'resultView', 'sourceTables', 'visibleParagraphIds',
  'activePara', 'flashPara', 'handleParagraphClick', 'paragraphRef', 'setOpenFigure', 'useMemo',
  client.slice(helperStart, helperEnd) + '\nconst TYPE_META = { fact: { label: "事实" } };\n'
  + memoLine + '\n' + client.slice(start, end) + '; return paraEl')
const makeMemo = () => {
  let previous, value, initialized = false
  return (factory, deps) => {
    if (!initialized || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
      value = factory(); previous = deps; initialized = true
    }
    return value
  }
}
const makeRenderer = (source, { tables = new Map(), visible = new Set(), active = -1, flash = -1, click = () => {}, memo = makeMemo() } = {}) => {
  const view = { graph: { source: { documentId: 'source-fixture', visualSource: source }, revision: 7 }, paraTypes: {} }
  return renderer(h, { Fragment: 'fragment' }, SourceFigure, view, view, tables, visible, active, flash, click,
    (paragraph, grouped) => h('span', { 'data-paragraph': paragraph, grouped }), () => {}, memo)
}
const walk = element => Array.isArray(element) ? element.flatMap(walk) : !element || typeof element !== 'object' ? []
  : [element, ...walk(element.props?.children)]
const figures = row => walk(row).filter(element => element.type === SourceFigure).map(element => element.props.image)
const originalFigures = (source, indices) => source?.kind === 'markdown-assets' ? source.images.filter(image =>
  (image.paragraphs || []).some(paragraph => indices.includes(paragraph)) ||
  (image.interpretationStatus === 'ai_unverified' && indices.includes(image.startParagraph))) : []
const originalTranscript = (source, paragraph) => source?.images?.find(image =>
  (source.kind === 'image-derived' || image.interpretationStatus === 'ai_unverified') &&
  Number.isSafeInteger(image.startParagraph) && Number.isSafeInteger(image.endParagraph) &&
  paragraph >= image.startParagraph && paragraph <= image.endParagraph)
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

for (const [count, imageCount] of [[803, 14], [12000, 200]]) {
  const trials = []
  for (let trial = 0; trial < (smoke ? 1 : 5); trial++) {
    let reads = 0
    const images = Array.from({ length: imageCount }, (_, i) => ({ id: 'figure-' + i, name: 'Image ' + i,
      paragraphs: [i * 50, i * 50], startParagraph: i * 50 + 1, endParagraph: i * 50 + 24,
      interpretationStatus: i % 2 ? 'not_requested' : 'ai_unverified' }))
    const source = { kind: 'markdown-assets', images: new Proxy(images, { get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    } }) }
    const before = JSON.stringify(images), memo = makeMemo(), started = performance.now(), render = makeRenderer(source, { memo })
    const rows = Array.from({ length: count }, (_, i) => render({ text: 'Original paragraph ' + i }, i))
    const firstRenderMs = performance.now() - started, firstImageReads = reads
    for (let i = 0; i < count; i++) {
      assert.deepEqual(figures(rows[i]), originalFigures({ kind: source.kind, images }, [i]))
      assert.equal(rows[i].props['aria-label'].startsWith('AI 视觉转写'), Boolean(originalTranscript({ kind: source.kind, images }, i)))
      assert.equal(rows[i].props.id, 'kg-para-' + i)
      assert(walk(rows[i]).some(element => element.type === 'p' && element.props.children[0] === 'Original paragraph ' + i))
    }
    reads = 0
    const retained = makeRenderer(source, { memo, active: count - 1, flash: 1 })
    for (let i = 0; i < count; i++) retained({ text: 'Original paragraph ' + i }, i)
    const retainedImageReads = reads
    if (smoke) {
      assert.equal(firstImageReads, imageCount, 'First source render must read each image record once')
      assert.equal(retainedImageReads, 0, 'Retained source rows must not return to the full image list')
    }
    assert.equal(JSON.stringify(images), before, 'Reading source rows must not rewrite original metadata')
    trials.push({ firstRenderMs, firstImageReads, retainedImageReads })
  }
  console.log(JSON.stringify({ baseline: revision || 'current', sourceParagraphs: count, images: imageCount,
    trials: trials.length, firstRenderImageReads: trials[0].firstImageReads, retainedImageReads: trials[0].retainedImageReads,
    firstRenderMedianMs: Math.round(median(trials.map(value => value.firstRenderMs)) * 100) / 100,
    exactSourceLabelsAndFigures: true, paragraphAnchors: true, unchangedMetadata: true }))
}

// Tables collect images from every member paragraph, once per original entry,
// and retain source-list order even when the paragraph anchors are unsorted.
const images = [
  { id: 'last-paragraph-first-image', paragraphs: [2, 2], interpretationStatus: 'not_requested' },
  { id: 'second', paragraphs: [1, 2], interpretationStatus: 'not_requested' },
  { id: 'second', paragraphs: [2], interpretationStatus: 'not_requested' },
  { id: 'transcript-start', paragraphs: [], startParagraph: 1, endParagraph: 2, interpretationStatus: 'ai_unverified' },
  { id: 'numeric-string', paragraphs: ['1'], startParagraph: '1', endParagraph: 2, interpretationStatus: 'ai_unverified' },
  { id: 'raw-range-without-anchor', startParagraph: 1, endParagraph: 2, interpretationStatus: 'not_requested' },
]
const source = { kind: 'markdown-assets', images }, table = { first: 1, last: 2, rows: [[{ text: 'Source heading', colspan: 1, rowspan: 1 }],
  [{ text: 'Source cell', colspan: 1, rowspan: 1 }]], prefix: 'Original prefix', suffix: 'Original suffix' }
let clicked = null
const render = makeRenderer(source, { tables: new Map([[1, table], [2, table]]), visible: new Set([1, 2]),
  active: 2, flash: 1, click: paragraph => { clicked = paragraph } })
const row = render({ text: 'Partial source markup' }, 1)
assert.deepEqual(figures(row), originalFigures(source, [1, 2]))
assert.equal(figures(row).length, 4, 'Duplicate IDs represent distinct original entries; repeated paragraph anchors do not repeat an entry')
assert.equal(render({ text: 'Remaining source markup' }, 2), null, 'A split table still renders once')
assert(row.props.className.includes('kg-active') && row.props.className.includes('kg-flash'))
row.props.onClick(); assert.equal(clicked, 1)
assert.deepEqual(walk(row).filter(element => element.props?.['data-paragraph'] !== undefined).map(element => element.props['data-paragraph']), [1, 2])
assert(walk(row).some(element => element.type === 'td' && element.props.children[0] === 'Source cell'))
assert(walk(row).filter(element => element.type === SourceFigure).every(element => element.props.documentId === 'source-fixture' && element.props.revision === 7))
const clipped = makeRenderer(source, { tables: new Map([[1, table], [2, table]]), visible: new Set([2]) })({ text: 'Remaining markup' }, 2)
assert.deepEqual(figures(clipped), figures(row), 'A chapter starting inside a table must retain the full table and its images')
for (const kind of ['image-derived', undefined]) {
  assert.deepEqual(figures(makeRenderer({ kind, images })({ text: 'Original paragraph' }, 1)), [])
}
const replaced = { kind: 'markdown-assets', images: [{ ...images[3], interpretationStatus: 'not_requested', caption: 'Updated caption' }] }
assert.equal(makeRenderer(replaced)({ text: 'Original paragraph' }, 1).props['aria-label'].startsWith('原文第'), true)
assert.equal(figures(makeRenderer(replaced)({ text: 'Original paragraph' }, 1)).length, 0, 'Replacing status removes the transcript-only source figure')
const memo = makeMemo()
assert.equal(makeRenderer(source, { memo })({ text: 'Original paragraph' }, 1).props['aria-label'].startsWith('AI 视觉转写'), true)
assert.equal(makeRenderer(replaced, { memo })({ text: 'Original paragraph' }, 1).props['aria-label'].startsWith('原文第'), true,
  'The production memo dependency must invalidate the source index when metadata is replaced')
if (smoke) {
  const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert(generated.includes(client.slice(start, end)) && generated.includes(memoLine), 'Generated workbench source rows must match production source')
}
console.log(JSON.stringify({ splitTable: true, clippedChapter: true, sourceOrderAndIdentity: true,
  duplicateIdsAndAnchors: true, exactNumericParagraphs: true, sourceKinds: true, replacementMetadata: true }))
