import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'
import { createImageNodeTools } from '../src/kg-image-nodes.mjs'

const source = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
const contract = createGraphContract()
const start = source.indexOf('      function visualTextHost(')
const end = source.indexOf('      async function transcribeTaskImagesHost(', start)
assert(start >= 0 && end > start)
const normalize = new Function('splitParagraphsHost', 'imageInputErrorHost', `
  const NL = '\\n', MAX_TEXT = 2000000, MAX_VISUAL_UNIT_CHARS_HOST = 1600;
  const MAX_VISUAL_UNITS_PER_IMAGE_HOST = 80, MAX_VISUAL_SOURCE_CHARS_HOST = 120000;
  const VISUAL_UNIT_KINDS_HOST = new Set(['text','table','diagram','chart','formula','layout','other']);
  ${source.slice(start, end)}
  return normalizeVisualTranscriptHost;
`)(contract.splitParagraphs, (code, message) => Object.assign(new Error(message), { code }))
const admitted = [{ id: 'figure-1', name: 'table.png', attachment: { attachmentId: 'owned-1' } }]
const item = { imageIndex: 1, summary: '限定实验数据', units: [{ kind: 'table', text: '仅在条件 A 下：B 为 12。' }], warnings: ['单位不清晰'] }
const valid = normalize({ images: [item] }, admitted, '')
assert(valid.text.includes('仅在条件 A 下'))
assert.deepEqual(valid.imageSource.images[0].warnings, ['单位不清晰'])

// A conflicting duplicate must not silently choose the first attribution.
for (const [name, raw, code] of [
  ['duplicate-index', { images: [item, { ...item, summary: '相反结论' }] }, 'visual_schema_invalid'],
  ['foreign-index', { images: [item, { ...item, imageIndex: 2 }] }, 'visual_schema_invalid'],
  ['missing-image', { images: [] }, 'visual_schema_invalid'],
  ['truncated-unit', { images: [{ ...item, units: [{ kind: 'table', text: 'A'.repeat(1600) + '；但不适用于 B。' }] }] }, 'visual_too_large'],
  ['discarded-unit', { images: [{ ...item, units: Array.from({ length: 81 }, () => item.units[0]) }] }, 'visual_too_large'],
  ['discarded-warning', { images: [{ ...item, warnings: Array.from({ length: 13 }, () => '不可确认') }] }, 'visual_too_large'],
  ['malformed-unit', { images: [{ ...item, units: [null] }] }, 'visual_schema_invalid'],
  ['empty-unit', { images: [{ ...item, units: [{ kind: 'diagram', text: '' }] }] }, 'visual_schema_invalid'],
  ['unknown-kind', { images: [{ ...item, units: [{ kind: 'guessed', text: '无可见依据' }] }] }, 'visual_schema_invalid'],
]) {
  assert.throws(() => normalize(raw, admitted, ''), error => error.code === code, name)
}
assert.equal(valid.imageSource.images[0].interpretationStatus, 'ai_unverified', 'direct image imports also remain AI evidence')

const inspectStart = source.indexOf('      function inspectImageHost(')
const inspectEnd = source.indexOf('      function selectMarkdownImagesForInterpretationHost(', inspectStart)
assert(inspectStart >= 0 && inspectEnd > inspectStart)
const inspect = new Function('splitParagraphsHost', 'IMAGE_NODE_TOOLS', source.slice(inspectStart, inspectEnd) + '; return inspectImageHost')(contract.splitParagraphs, createImageNodeTools())
const nodes = Array.from({ length: 560 }, (_, i) => ({ id: 'n' + i, text: '节点 ' + i, type: 'fact', paragraph: 0 }))
nodes.push(...Array.from({ length: 55 }, (_, i) => ({ id: 'v' + i, text: '视觉节点 ' + i, type: 'fact', paragraph: 2, entailmentStatus: 'unverified' })))
nodes.push({ id: 'evidence-only', text: '跨段节点', type: 'fact', paragraph: 0, evidence: [{ paragraph: 2, quote: '可见表格' }] })
nodes.push({ id: 'foreign-evidence', text: '其他文档', paragraph: 0, evidence: [{ documentId: 'another-book', paragraph: 2, quote: '可见表格' }] })
nodes.push({ id: 'foreign-source', text: '其他版本', paragraph: 2, sourceId: 'old-source' })
const canonical = { documentId: 'doc', revision: 7, sourceText: '原书文字。\n\n图片标题。\n\n可见表格。', nodes, edges: [],
  source: { documentId: 'doc', id: 'current-source', visualSource: { kind: 'markdown-assets', images: [
    { ...admitted[0], interpretationStatus: 'ai_unverified', paragraphs: [0], startParagraph: 1, endParagraph: 2 },
    { id: 'not-read', interpretationStatus: 'not_requested', paragraphs: [0], startParagraph: 0, endParagraph: 0 },
  ] } } }
const before = JSON.stringify(canonical)
const args = { imageId: 'figure-1', expectedRevision: 7 }
const page = inspect(canonical, args)
assert.equal(page.totalNodes, 56, 'all canonical nodes including off-window evidence must be counted')
assert.equal(page.nodes.length, 50)
assert.equal(page.nextOffset, 50)
assert.deepEqual(page.transcript.map(p => p.paragraph), [1, 2])
assert.deepEqual(inspect(canonical, { ...args, nodeOffset: page.nextOffset }).nodes.map(n => n.id), ['v50', 'v51', 'v52', 'v53', 'v54', 'evidence-only'])
assert.equal(inspect(canonical, { ...args, nodeOffset: 50 }).nextOffset, null)
assert.equal(inspect(canonical, { ...args, expectedRevision: 6 }).error.code, 'revision_conflict')
assert.equal(inspect(canonical, { ...args, imageId: 'foreign' }).error.code, 'not_found')
assert.equal(inspect(canonical, { ...args, nodeOffset: -1 }).error.code, 'invalid_input')
const unread = inspect(canonical, { ...args, imageId: 'not-read' })
assert.deepEqual(unread.transcript, [])
assert.equal(unread.totalNodes, 0, 'original neighboring text must not be attributed to an uninterpreted image')
assert.equal(JSON.stringify(canonical), before, 'inspection must never mutate the canonical graph')
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const atStart = client.indexOf('      function visualTranscriptImageAt(')
const atEnd = client.indexOf('      function GraphScene(', atStart)
const imageAt = new Function(client.slice(atStart, atEnd) + '; return visualTranscriptImageAt')()
assert.equal(imageAt(canonical.source.visualSource, 0), null, 'original image anchors are not AI transcript evidence')
assert.equal(imageAt(canonical.source.visualSource, 2).id, 'figure-1')
assert.equal(imageAt({ kind: 'image-derived', images: [{ id: 'legacy-upload', startParagraph: 1, endParagraph: 2 }] }, 2).id,
  'legacy-upload', 'legacy direct image imports must not be presented as original book prose')
console.log(JSON.stringify({ ok: true, strictTranscript: true, canonicalImageInspection: true, revisionFenced: true }))
