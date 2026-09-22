import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kg-ontology-attributes-'))
const filename = join(dir, 'test.sqlite')
const sourceText = 'Raw observations can become structured knowledge.'
const evidence = [{ paragraph: 0, quote: sourceText }]
const graph = {
  ontology: 'learning-view-v1', summary: '', warnings: [],
  source: { id: 'source-attributes', documentId: 'attributes', paragraphCount: 1 },
  nodes: [
    { id: 'raw', type: 'data_or_experience', text: 'Raw observations', quote: sourceText, paragraph: 0, evidence, stage: 'data', hidden: 'discard' },
    { id: 'knowledge', type: 'rule', text: 'Structured knowledge', quote: sourceText, paragraph: 0, evidence, relKind: 'basic' },
  ],
  edges: [{ fromNodeId: 'raw', toNodeId: 'knowledge', relation: 'maps_between', role: 'input', mode: 'contrast', evidence, hidden: 'discard' }],
}
const attributes = (value) => ({
  nodes: value.nodes.map((node) => [node.id, node.stage, node.relKind]).sort(),
  edges: value.edges.map((edge) => [edge.fromNodeId, edge.toNodeId, edge.role, edge.mode]).sort(),
})
const expected = attributes(graph)
let store
try {
  store = await openSqliteStore(filename)
  store.saveGraph(graph, { sourceText, sourceUnits: [sourceText] })
  store.close()
  store = await openSqliteStore(filename)
  const loaded = store.getDocument('attributes')
  assert.deepEqual(attributes(loaded), expected, 'canonical attributes must survive closing and reopening SQLite')
  assert(!Object.hasOwn(loaded.nodes[0], 'hidden'))
  assert(!Object.hasOwn(loaded.edges[0], 'hidden'))
  assert.deepEqual(attributes(store.getDocumentWindow('attributes')), expected, 'windowed loading must not erase semantic attributes')
  assert.deepEqual(attributes(store.getGraphNeighborhood('attributes', { centerId: 'raw', expectedRevision: 1 })), expected)
  assert.deepEqual(attributes(store.queryDocumentGraph('attributes', { nodeIds: ['raw', 'knowledge'] }).graph), expected, 'bounded consumption must preserve the same meaning')

  const changed = structuredClone(loaded)
  changed.nodes.find((node) => node.id === 'raw').stage = 'processed'
  changed.edges[0].role = 'output'
  store.saveGraph(changed, { sourceText, expectedRevision: 1 })
  assert.throws(() => store.saveGraph(graph, { sourceText, expectedRevision: 1 }), (error) => error.code === 'revision_conflict')
  assert.equal(store.getDocument('attributes').edges[0].role, 'output', 'a CAS failure must not partially replace attributes')
  store.restoreRevision('attributes', 1, 2)
  assert.deepEqual(attributes(store.getDocument('attributes')), expected, 'revision snapshots must preserve semantic attributes')

  const proposition = structuredClone(graph)
  proposition.ontology = 'proposition-v1'
  proposition.source.documentId = 'default-profile'
  store.saveGraph(proposition, { sourceText })
  const defaultProfile = store.getDocument('default-profile')
  assert(defaultProfile.nodes.every((node) => node.stage === undefined && node.relKind === undefined))
  assert(defaultProfile.edges.every((edge) => edge.role === undefined && edge.mode === undefined), 'a foreign ontology must not smuggle attributes into a proposition graph')

  const malformed = structuredClone(graph)
  malformed.source.documentId = 'malformed-attributes'
  malformed.nodes[0].stage = { id: 'replacement', text: 'injection' }
  malformed.nodes[1].relKind = Infinity
  malformed.edges[0].role = ['input']
  malformed.edges[0].mode = ' '
  store.saveGraph(malformed, { sourceText })
  const filtered = store.getDocument('malformed-attributes')
  assert.equal(filtered.nodes.find((node) => node.id === 'raw').stage, undefined)
  assert.equal(filtered.nodes.find((node) => node.id === 'knowledge').relKind, undefined)
  assert.equal(filtered.edges[0].role, undefined)
  assert.equal(filtered.edges[0].mode, undefined)

  // Recreate the pre-attributes schema with real canonical data and revisions.
  // Migration must be additive; it cannot infer values the old writer lost.
  const beforeMigration = store.getDocument('attributes')
  store.db.exec('ALTER TABLE graph_nodes DROP COLUMN attributes_json')
  store.db.exec('ALTER TABLE graph_edges DROP COLUMN attributes_json')
  store.close()
  store = await openSqliteStore(filename)
  const migrated = store.getDocument('attributes')
  assert.equal(migrated.revision, beforeMigration.revision)
  assert.equal(migrated.nodes.length, beforeMigration.nodes.length)
  assert.equal(migrated.edges.length, beforeMigration.edges.length)
  assert(migrated.nodes.every((node) => node.stage === undefined && node.relKind === undefined))
  assert(migrated.edges.every((edge) => edge.role === undefined && edge.mode === undefined))
  store.saveGraph(graph, { sourceText, expectedRevision: migrated.revision })
  assert.deepEqual(attributes(store.getDocument('attributes')), expected, 'new writes after migration must retain attributes')
  console.log(JSON.stringify({ ok: true, sqliteReopen: true, projections: true, revisionRestore: true, cas: true, allowlist: true, legacyMigration: true }))
} finally {
  store?.close()
  rmSync(dir, { recursive: true, force: true })
}
