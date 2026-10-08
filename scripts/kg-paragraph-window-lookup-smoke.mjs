import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
const lookup = 'const pi = sourceSpanIndexAtOffset(paragraphs, off)'
assert(viewer.includes(lookup), 'the production view must use the bounded lookup')
function load(code, observe) {
  const sandbox = { window: { React: {} }, console, track: paragraphs => paragraphs.map(paragraph => ({ ...paragraph,
    get start() { observe(); return paragraph.start },
    get end() { observe(); return paragraph.end },
  })) }
  if (observe) code = code.replace('const paragraphs = splitParagraphs(sourceText)', 'const paragraphs = track(splitParagraphs(sourceText))')
  runInNewContext(code.replace('window.KGViewer = {', 'window.KGViewer = { sourceSpanIndexAtOffset,'), sandbox)
  return sandbox.window.KGViewer
}
const api = load(viewer)
const linearCode = viewer.replace(lookup, 'const pi = paragraphs.findIndex(p => off >= p.start && off < p.end)')
const reference = load(linearCode)
const plain = value => JSON.parse(JSON.stringify(value))
const long = 'A long sentence preserves source offsets, including punctuation and emoji \u{1f4da}. '.repeat(24)
const blocks = ['# 标题 \u{1f600}', 'Repeated evidence.', 'Repeated evidence.',
  '> First quote line.\n> Second quote line, with \u{1f4da} evidence.',
  '- 第一项材料。\n- 第二项材料。', '  code_one();\n  code_two();',
  '| 字段 | 值 |\n| 名称 | 结果 |', '<table><tr><td>完整证据</td></tr></table>',
  'Alice: A dialogue.\nBob: Another reply.', long, '   ', '结束。']
const sources = ['', '\n\n\r\n', 'Single paragraph.', ...['\n', '\r\n'].flatMap(newline => [
  blocks.join('\n\n').replaceAll('\n', newline),
  blocks.slice().reverse().join('\n\n\n').replaceAll('\n', newline),
  ' \n\n' + blocks.join('\n\n').replaceAll('\n', newline) + '\n\n ',
])]
let offsetsChecked = 0, viewsChecked = 0
for (const source of sources) {
  const paragraphs = api.splitParagraphs(source)
  for (const [index, paragraph] of paragraphs.entries()) {
    assert(paragraph.start < paragraph.end)
    if (index) assert(paragraphs[index - 1].end <= paragraph.start, 'parser output must stay ordered and disjoint')
    assert.equal(source.slice(paragraph.start, paragraph.end), paragraph.text, 'UTF-16 spans must remain source-aligned')
  }
  const offsets = [NaN, Infinity, -Infinity, -1, source.length + 1]
  for (let offset = 0; offset <= source.length; offset += 0.5) offsets.push(offset)
  for (const offset of offsets) {
    assert.equal(api.sourceSpanIndexAtOffset(paragraphs, offset),
      paragraphs.findIndex(p => offset >= p.start && offset < p.end), 'exclusive ends and whitespace gaps: ' + offset)
    offsetsChecked++
  }
  // Full output parity checks local and legacy evidence, repeated quotes,
  // normalized quotes, stale paragraph declarations, unresolved nodes,
  // type badges, and existing edge sanitization without changing the input.
  const nodes = paragraphs.flatMap((paragraph, i) => [
    { id: 'local-' + i, type: i % 2 ? 'fact' : 'concept', text: paragraph.text, quote: paragraph.text, paragraph: i },
    { id: 'legacy-' + i, type: 'rule', text: '', quote: paragraph.text },
    { id: 'stale-' + i, type: 'claim', text: '', quote: paragraph.text, paragraph: paragraphs.length + 1 },
  ])
  nodes.push({ id: 'unresolved', type: 'fact', text: '', quote: '' },
    { id: 'normalized', type: 'concept', quote: 'Repeated!evidence.', text: 'Repeated evidence.' },
    { id: 'paragraph-fallback', type: 'fact', paragraph: paragraphs.length - 1, quote: '' })
  const graph = { nodes, edges: [{ fromNodeId: 'local-0', toNodeId: 'legacy-0', relation: 'supports' },
    { fromNodeId: 'local-0', toNodeId: 'missing', relation: 'supports' },
    { fromNodeId: 'local-0', toNodeId: 'local-0', relation: 'supports' }] }
  const before = JSON.stringify(graph)
  assert.deepEqual(plain(api.makeView(graph, source)), plain(reference.makeView(graph, source)))
  assert.equal(JSON.stringify(graph), before)
  viewsChecked++
}
// Offset magnitude should not turn an ordinary 800-node tail window into
// millions of paragraph probes. Counters are separate from wall-clock timing.
const book = Array.from({ length: 12000 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const source = book.join('\n\n')
const graph = { nodes: book.slice(-800).map((text, i) => ({ id: 'n' + (11200 + i), type: 'fact', quote: text, text, paragraph: 11200 + i })), edges: [] }
let boundaryReads = 0
const measured = load(viewer, () => boundaryReads++)
const result = measured.makeView(graph, source)
assert.equal(result.paraNodes[11999][0], 'n11999')
assert.equal(result.unresolved.length, 0)
const optimizedReads = boundaryReads
assert(optimizedReads <= graph.nodes.length * (Math.ceil(Math.log2(book.length)) + 4), 'tail window work must be logarithmic in source paragraphs')
boundaryReads = 0
load(linearCode, () => boundaryReads++).makeView({ ...graph, nodes: graph.nodes.slice(0, 64) }, source)
assert(boundaryReads > 1000000, 'the counter must detect the original repeated linear scan')
assert.deepEqual(plain(result), plain(reference.makeView(graph, source)), 'large-window output parity')
// A changed source has shifted offsets; no document or paragraph cache may
// leak previous assignments into the next view or an appended revision.
for (const nextSource of ['A new preface.\n\n' + source, source + '\n\nAppended evidence.', 'Another document.']) {
  assert.deepEqual(plain(api.makeView(graph, nextSource)), plain(reference.makeView(graph, nextSource)))
  viewsChecked++
}
console.log(JSON.stringify({ offsetsChecked, viewsChecked, sourceParagraphs: book.length, tailWindowNodes: graph.nodes.length,
  boundaryReads: optimizedReads, linearNegativeControl: true, sourceAndGraphPreserved: true }))
