import { readFileSync } from 'node:fs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = source.indexOf('function exportFilePart')
const end = source.indexOf('function GraphExportActions')
assert(start >= 0 && end > start, 'export helper block is missing')
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
  nodes: [{ id: 'n1', type: 'fact', text: '带逗号, 换行\n和引号"的节点', paragraph: 0, documentId: 'doc-export', evidence: [{ paragraph: 0, quote: '证据' }] }],
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

  filename = exportGraphFile(graph, '', 'edges', null)
  assert(filename === '导出测试-edges.csv', 'edge CSV filename is wrong')
  text = await capturedBlob.text()
  assert(text.includes('e1,n1,n1,supports'), 'edge CSV content is wrong')
} finally {
  globalThis.document = originalDocument
  globalThis.URL = originalURL
}

console.log(JSON.stringify({ ok: true, formats: ['json', 'nodes.csv', 'edges.csv'], provenance: true }))
