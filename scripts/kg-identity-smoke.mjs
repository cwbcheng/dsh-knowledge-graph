import { createHash } from 'node:crypto'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const extractor = async ({ title, chunk }) => {
  const unit = chunk && Array.isArray(chunk.units) && chunk.units.length > 0 ? chunk.units[0] : { num: 0, text: '' }
  const quote = String(unit.text || '').slice(0, 80)
  return {
    summary: String(title || 'identity smoke'),
    nodes: [{ id: 'n1', type: 'fact', text: 'identity:' + quote.slice(0, 24), quote, paragraph: unit.num }],
    edges: [],
  }
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 200; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status === 'succeeded') return status.result
    if (status.status === 'failed' || status.status === 'cancelled') throw new Error('task failed: ' + JSON.stringify(status))
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error('task did not finish: ' + taskId)
}

const commonPrefix = '共同前缀'.repeat(900) // > 4000 chars: legacy document hash used only this prefix.
const textA = commonPrefix + '版本甲尾部'
const textB = commonPrefix + '版本乙尾部'
const startA = await handlers.get('extract')({ title: '同标题', text: textA })
const startB = await handlers.get('extract')({ title: '同标题', text: textB })
// Host has a single extraction busy lock, so wait A before starting B when the
// second request was rejected as busy.
const graphA = await waitTask(startA.taskId)
let graphB
if (startB && startB.taskId) graphB = await waitTask(startB.taskId)
else {
  const retryB = await handlers.get('extract')({ title: '同标题', text: textB })
  assert(retryB && retryB.taskId, 'second identity extraction could not start')
  graphB = await waitTask(retryB.taskId)
}

assert(/^document-[0-9a-f-]{32,}$/i.test(graphA.source.documentId), 'documentId is not UUID/random logical identity: ' + graphA.source.documentId)
assert(graphA.source.documentId !== graphB.source.documentId, 'documents with same title/prefix collapsed to one logical documentId')
assert(/^source-[0-9a-f]{64}$/i.test(graphA.source.id), 'sourceId is not full SHA-256 content identity: ' + graphA.source.id)
const expectedSourceA = 'source-' + createHash('sha256').update(textA).digest('hex')
const expectedSourceB = 'source-' + createHash('sha256').update(textB).digest('hex')
assert(graphA.source.id === expectedSourceA && graphB.source.id === expectedSourceB, 'Host self-contained SHA-256 does not match Node crypto')
assert(graphA.source.id !== graphB.source.id, 'different full source contents produced the same sourceId')
assert(graphA.staging.chunks.length > 0 && graphB.staging.chunks.length > 0, 'identity fixtures did not produce chunks')
assert(graphA.staging.chunks[0].chunkId !== graphB.staging.chunks[0].chunkId, 'chunk identity ignored source identity')
assert(graphA.staging.chunks[0].sourceId === graphA.source.id, 'initial chunk did not retain its source version id')

const append = await handlers.get('append-extract')({
  documentId: graphA.source.documentId,
  title: '同标题',
  text: '追加后的新内容。',
  existing: graphA,
})
assert(append && append.taskId, 'append identity task was not created')
const appendedA = await waitTask(append.taskId)
assert(appendedA.source.documentId === graphA.source.documentId, 'append changed logical document identity')
assert(appendedA.source.id !== graphA.source.id, 'append did not create a new immutable source-version identity')
assert(appendedA.source.previousId === graphA.source.id, 'append source version did not link to its previous version')
const chunkKeys = appendedA.staging.chunks.map((chunk) => String(chunk.sourceId || '') + '|' + String(chunk.chunkId || ''))
assert(new Set(chunkKeys).size === chunkKeys.length, 'append produced duplicate source/chunk identities')
assert(appendedA.staging.chunks.some((chunk) => chunk.sourceId === graphA.source.id), 'append lost prior source-version chunks')
assert(appendedA.staging.chunks.some((chunk) => chunk.sourceId === appendedA.source.id), 'append did not tag new chunks with the new source version')

const store = await openSqliteStore(':memory:')
try {
  const savedA = store.saveGraph(graphA, { sourceText: textA })
  const savedB = store.saveGraph(graphB, { sourceText: textB })
  assert(savedA.revision === 1 && savedB.revision === 1, 'independent documents did not start at revision 1')
  const savedAppend = store.saveGraph(appendedA, { sourceText: textA + '\n\n追加后的新内容。', expectedRevision: 1, kind: 'append' })
  assert(savedAppend.revision === 2, 'append persistence did not advance the logical document revision')
  const restoredA = store.getDocument(graphA.source.documentId)
  const restoredB = store.getDocument(graphB.source.documentId)
  assert(restoredA && restoredB, 'one document disappeared after another document was persisted')
  assert(restoredB.staging.chunks.length === graphB.staging.chunks.length, 'Doc B chunks were overwritten by Doc A append')
  assert(restoredA.staging.chunks.length === appendedA.staging.chunks.length, 'Doc A append lost old or new chunks')
  const restoredKeys = restoredA.staging.chunks.map((chunk) => chunk.sourceId + '|' + chunk.chunkId)
  assert(new Set(restoredKeys).size === restoredKeys.length, 'SQLite collapsed distinct append chunks')
  for (const node of restoredA.nodes) {
    if (!node.chunkId || !node.sourceId) continue
    assert(restoredA.staging.chunks.some((chunk) => chunk.chunkId === node.chunkId && chunk.sourceId === node.sourceId), 'node provenance points at the wrong source/chunk pair: ' + node.id)
  }
} finally {
  store.close()
}

console.log(JSON.stringify({
  ok: true,
  documentIdsDistinct: true,
  sourceIds: [graphA.source.id, graphB.source.id, appendedA.source.id],
  appendChunks: appendedA.staging.chunks.length,
}))
