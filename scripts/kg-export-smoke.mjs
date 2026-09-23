import { readFileSync } from 'node:fs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = source.indexOf('function exportFilePart')
const end = source.indexOf('function GraphExportActions')
assert(start >= 0 && end > start, 'export helper block is missing')
assert(source.includes('function exportRenderedGraphImage') && source.includes('导出知识图 PNG 图片'), 'PNG image export control is missing')
const helpers = source.slice(start, end)
const factory = new Function('NL', helpers + '\nreturn { exportGraphFile }')
const { exportGraphFile } = factory('\n')

let capturedBlob = null
const originalDocument = globalThis.document
const originalURL = globalThis.URL
globalThis.URL = {
  createObjectURL(blob) { capturedBlob = blob; return 'blob:test-export' },
  revokeObjectURL() {},
}
globalThis.document = {
  body: { appendChild() {} },
  createElement() {
    return { style: {}, click() {}, remove() {} }
  },
}

const graph = {
  source: { documentId: 'doc-export', title: '导出测试' },
  summary: '保留完整图',
  nodes: [
    { id: 'n1', type: 'fact', text: '带逗号, 换行\n和引号"的节点', paragraph: 0, documentId: 'doc-export', evidence: [{ paragraph: 0, quote: '证据' }] },
    { id: 'n2', type: 'fact', text: '=HYPERLINK("https://evil.invalid","click")', paragraph: 1, documentId: 'doc-export', evidence: [{ paragraph: 1, quote: '不可信输入' }] },
  ],
  edges: [{ id: 'e1', fromNodeId: 'n1', toNodeId: 'n1', relation: 'supports', documentId: 'doc-export', provenance: { sourceId: 's1' } }],
  verification: { issues: [{ id: 'i1', status: 'open' }] },
}

try {
  let filename = exportGraphFile(graph, '', 'json', null)
  assert(filename === '导出测试.json', 'JSON export filename is wrong')
  let text = await capturedBlob.text()
  assert(JSON.parse(text).verification.issues[0].id === 'i1', 'JSON export did not preserve verification data')

  filename = exportGraphFile(graph, '', 'nodes', null)
  assert(filename === '导出测试-nodes.csv', 'node CSV filename is wrong')
  text = await capturedBlob.text()
  const bytes = new Uint8Array(await capturedBlob.arrayBuffer())
  assert(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && text.includes('"带逗号, 换行\n和引号""的节点"'), 'node CSV escaping or BOM is wrong')
  assert(text.includes('"\'=HYPERLINK(""https://evil.invalid""'), 'CSV formula injection was not neutralized')

  filename = exportGraphFile(graph, '', 'edges', null)
  assert(filename === '导出测试-edges.csv', 'edge CSV filename is wrong')
  text = await capturedBlob.text()
  assert(text.includes('e1,n1,n1,supports'), 'edge CSV content is wrong')
} finally {
  globalThis.document = originalDocument
  globalThis.URL = originalURL
}

console.log(JSON.stringify({ ok: true, formats: ['json', 'nodes.csv', 'edges.csv'], provenance: true }))

const actionStart = source.indexOf('function GraphExportActions')
const actionEnd = source.indexOf('function GraphIcon', actionStart)
assert(actionStart >= 0 && actionEnd > actionStart, 'export action block is missing')
const actionSource = source.slice(actionStart, actionEnd) + '\nreturn GraphExportActions'
const calls = [], exports = [], toasts = []
const h = (tag, props, ...children) => ({ tag, props, children })
const GraphExportActions = new Function('h', 'documentIdOfGraph', 'exportGraphFile', 'toastStore', actionSource)(
  h,
  value => value?.source?.documentId || null,
  (value, title, kind) => { exports.push({ value, title, kind }); return 'complete.json' },
  { show: value => toasts.push(value) },
)
const truncated = { ...graph, nodes: graph.nodes.slice(0, 1), view: { truncated: true } }
const complete = { ...graph, nodes: [...graph.nodes, { id: 'n3', type: 'fact', text: '完整图中的节点' }] }
const loadCanonical = async documentId => { calls.push(documentId); return { graph: complete } }
const button = GraphExportActions({ graph: truncated, title: '', ctx: null, loadCanonical }).children[1]
await button.props.onClick()
assert(calls.length === 1 && calls[0] === 'doc-export',
  'truncated export must fetch the canonical graph through the supplied host')
assert(exports.length === 1 && exports[0].value.nodes.length === 3, 'truncated export must use the complete graph')
assert(toasts.at(-1) === '已导出 complete.json', 'successful canonical export must be visible')

const missingLoader = GraphExportActions({ graph: truncated, title: '', ctx: null }).children[1]
await missingLoader.props.onClick()
assert(exports.length === 1 && toasts.at(-1).startsWith('导出失败：'),
  'missing loader must never silently export the truncated window')
const missingIdentity = GraphExportActions({ graph: { ...truncated, source: {} }, title: '', ctx: null, loadCanonical }).children[1]
await missingIdentity.props.onClick()
assert(exports.length === 1 && calls.length === 1,
  'missing document identity must never create an incomplete backup')
assert(source.includes("loadCanonical: (documentId) => host.call('document-export', { documentId })"),
  'both source and persistent clients must pass a build-compatible canonical loader')
const persistentClient = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert(persistentClient.includes("loadCanonical: (documentId) => rpc('document-export', { documentId })"),
  'the persistent build must use rpc rather than an undefined host object')
