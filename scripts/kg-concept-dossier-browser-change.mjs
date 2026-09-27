import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { openSqliteStore } from '../src/kg-store.mjs'

const path = realpathSync(process.argv[2] || '')
assert.match(path, /^\/tmp\/kg-dossier-browser-[^/]+\/graphs\.sqlite$/,
  'this adversarial fixture may only edit its dedicated temporary browser database')
const expectedRevision = Number(process.argv[3] || 1)
assert([1, 2].includes(expectedRevision))
const store = await openSqliteStore(path)
try {
  const quote = expectedRevision === 1 ? '迁移在此修订中指数据库数据的搬迁。' :
    '迁移在新修订中指服务之间的数据复制。'
  store.saveGraph({ source: { id: 'dossier-book-b-source', documentId: 'dossier-book-b',
    title: 'Database Book', author: 'Author B', publicationDate: String(2020 + expectedRevision), paragraphCount: 1 },
    nodes: [{ id: 'concept', type: 'concept', text: '迁移', paragraph: 0, quote,
      evidence: [{ documentId: 'dossier-book-b', sourceId: 'dossier-book-b-source', paragraph: 0, quote }] }],
    edges: [] }, { expectedRevision, sourceText: quote,
    sourceUnits: [{ paragraph: 0, text: quote }] })
  assert.equal(store.getDocumentRevision('dossier-book-b'), expectedRevision + 1)
  console.log(`isolated source revision ${expectedRevision + 1}; confirmed dossier remains at its previous bound revision`)
} finally { store.close() }
