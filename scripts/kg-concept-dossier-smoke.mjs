import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { openSqliteStore } from '../src/kg-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kg-dossier-'))
const database = join(dir, 'graphs.sqlite')
const graph = (documentId, title, author, concept, quote, paragraph, extra = {}) => ({
  source: { documentId, id: documentId + '-source', title, author, publicationDate: extra.date || '' },
  nodes: [{ id: 'concept', type: 'concept', text: concept, quote, paragraph,
    evidence: [{ documentId, sourceId: documentId + '-source', paragraph, quote }] }], edges: [],
})
try {
  let store = await openSqliteStore(database)
  store.saveGraph(graph('book-a', 'Book A', 'Author A', '迁移', '在本书中，迁移指学习后的新情境应用。', 0),
    { sourceText: '在本书中，迁移指学习后的新情境应用。', sourceUnits: [{ paragraph: 0, text: '在本书中，迁移指学习后的新情境应用。' }] })
  store.saveGraph(graph('book-b', 'Book B', 'Author B', '迁移', '在这里迁移指数据库结构变更。', 0),
    { sourceText: '在这里迁移指数据库结构变更。', sourceUnits: [{ paragraph: 0, text: '在这里迁移指数据库结构变更。' }] })
  store.saveGraph(graph('book-c', 'Book C', 'Author C', '迁移', '不存在的引文', 0),
    { sourceText: '本书讨论迁移，但没有这句话。', sourceUnits: [{ paragraph: 0, text: '本书讨论迁移，但没有这句话。' }] })
  store.saveGraph(graph('book-d', 'Book D', 'Author D', '迁移是绝对不可能的', '迁移并非总能发生。', 0),
    { sourceText: '迁移并非总能发生。', sourceUnits: [{ paragraph: 0, text: '迁移并非总能发生。' }] })
  store.saveGraph({ source: { documentId: 'book-e', id: 'book-e-source', title: 'Book E' },
    nodes: [{ id: 'concept', type: 'concept', text: '跨段定义', paragraph: 0, quote: '', evidence: [
      { documentId: 'book-e', sourceId: 'book-e-source', paragraph: 0, quote: '' },
      { documentId: 'book-e', sourceId: 'book-e-source', paragraph: 1, quote: '第二段才给出定义。' },
    ] }], edges: [] }, { sourceText: '第一段介绍主题。\n\n第二段才给出定义。', sourceUnits: [
      { paragraph: 0, text: '第一段介绍主题。' }, { paragraph: 1, text: '第二段才给出定义。' },
    ] })
  assert.equal(store.conceptReference('book-e', 'concept').quote, '第二段才给出定义。',
    'an empty first citation or a different node paragraph must not hide valid source evidence')
  assert.equal(store.conceptReference('book-e', 'concept').evidenceParagraph, 1)
  assert.equal(store.conceptReference('book-e', 'concept').sourceParagraphText, '第二段才给出定义。')
  const longParagraph = '前置说明'.repeat(5000) + '末尾才给出定义。'
  store.saveGraph(graph('book-f', 'Book F', 'Author F', '长段概念', '末尾才给出定义。', 0),
    { sourceText: longParagraph, sourceUnits: [{ paragraph: 0, text: longParagraph }] })
  assert(store.conceptReference('book-f', 'concept').sourceParagraphText.includes('末尾才给出定义。'),
    'bounded source preview must retain the matched quotation even at the end of a long unit')
  const candidates = store.searchConceptCandidates({ documentId: 'book-a', nodeId: 'concept' }).candidates
  assert(candidates.some(item => item.documentId === 'book-b' && item.nodeId === 'concept'))
  assert(candidates.some(item => item.documentId === 'book-c' && item.evidenceStatus === 'unverified'))
  assert(!candidates.some(item => item.documentId === 'book-d'), 'different labels require an intentional search')
  assert(store.searchConceptCandidates({ documentId: 'book-a', nodeId: 'concept', query: '不可能' })
    .candidates.some(item => item.documentId === 'book-d'), 'different wording can be compared explicitly')
  assert.equal(store.listConceptDossiers('book-a').length, 0, 'same-name candidates must never auto-align')
  assert.throws(() => store.saveConceptDossier({ title: '迁移', anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'aligned', note: '' }] }),
  { code: 'invalid_input' }, 'unversioned cross-book alignment must be rejected')
  const saved = store.saveConceptDossier({ title: '迁移的不同用法', anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'contrast', note: '同名但领域不同',
      applicability: '数据库结构', validTime: '本书所述版本期间' },
      { documentId: 'book-c', nodeId: 'concept', relation: 'related', note: '' }],
    expectedRevisions: { 'book-a': 1, 'book-b': 1, 'book-c': 1 } })
  assert.equal(saved.version, 1)
  assert.equal(store.getDocumentRevision('book-a'), 1, 'dossiers must not revise the canonical graph')
  const dossier = store.getConceptDossier(saved.id)
  assert.equal(dossier.members.length, 3)
  assert.equal(dossier.members[0].realWorldTruth, 'not_assessed')
  assert.equal(dossier.members[0].source.author, 'Author A')
  assert.equal(dossier.members[1].relation, 'contrast')
  assert.equal(dossier.members[1].applicability, '数据库结构')
  assert.equal(dossier.members[1].validTime, '本书所述版本期间')
  assert.equal(dossier.members[1].noteOrigin, 'user_annotation')
  assert.equal(dossier.members[1].validTimeOrigin, 'user_annotation')
  assert.equal(dossier.members[1].confirmedReference.source.title, 'Book B')
  assert.equal(dossier.members[2].evidenceStatus, 'unverified')
  assert.equal(dossier.members[0].attributionStatus, 'unverified', 'matching a quotation is not semantic or real-world verification')
  assert.deepEqual(store.listConceptDossiers('book-b').map(item => item.id), [saved.id], 'membership must be discoverable from either book')
  const updated = store.saveConceptDossier({ id: saved.id, title: '迁移的适用边界',
    anchor: { documentId: 'book-a', nodeId: 'concept' }, expectedVersion: 1,
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'contrast', note: '用法分歧',
      applicability: '结构迁移', validTime: '2020 年讨论范围' },
      { documentId: 'book-c', nodeId: 'concept', relation: 'related', note: '' }],
    expectedRevisions: { 'book-a': 1, 'book-b': 1, 'book-c': 1 } })
  assert.equal(updated.version, 2)
  assert.equal(updated.members[1].applicability, '结构迁移')
  assert.equal(updated.members[1].validTime, '2020 年讨论范围')
  assert.equal(updated.members[1].note, '用法分歧')
  assert.throws(() => store.saveConceptDossier({ title: 'Invalid time', anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'related', note: '', validTime: 'x'.repeat(101) }],
    expectedRevisions: { 'book-a': 1, 'book-b': 1 } }), { code: 'invalid_input' })
  assert.throws(() => store.saveConceptDossier({ id: saved.id, title: 'Lost update',
    anchor: { documentId: 'book-a', nodeId: 'concept' }, expectedVersion: 1,
    members: [], expectedRevisions: { 'book-a': 1 } }), { code: 'dossier_conflict' })
  assert.throws(() => store.saveConceptDossier({ ...saved, expectedVersion: 1,
    expectedRevisions: { 'book-a': 1, 'book-b': 1, 'book-c': 1 },
    anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'same_name_is_proof', note: '' }] }),
  { code: 'invalid_input' }, 'an unknown relation must not imply semantic alignment')
  store.close()

  store = await openSqliteStore(database)
  assert.equal(store.getConceptDossier(saved.id).members[1].source.title, 'Book B', 'dossier must survive store recreation')
  store.saveGraph(graph('book-b', 'Book B', 'Author B', '迁移', '新的原文。', 0),
    { expectedRevision: 1, sourceText: '新的原文。', sourceUnits: [{ paragraph: 0, text: '新的原文。' }] })
  assert.equal(store.getConceptDossier(saved.id).members[1].stale, true, 'changed source must invalidate the old comparison')
  assert.equal(store.getConceptDossier(saved.id).members[1].confirmedReference.quote, '在这里迁移指数据库结构变更。',
    'the comparison must retain what the user confirmed before the source changed')
  assert.throws(() => store.saveConceptDossier({ id: saved.id, title: 'Old revision', expectedVersion: 2,
    anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'contrast', note: '' }],
    expectedRevisions: { 'book-a': 1, 'book-b': 1 } }), { code: 'revision_conflict' })
  store.db.prepare('DELETE FROM documents WHERE document_id = ?').run('book-c')
  assert.equal(store.getConceptDossier(saved.id).members[2].missing, true,
    'deleting a book must preserve a visible missing-source marker, not silently erase the disagreement')
  assert.equal(store.getConceptDossier(saved.id).members[2].source.title, 'Book C',
    'deleting a source must not erase the recorded provenance of an existing dossier')
  assert.equal(store.deleteConceptDossier(saved.id, 2), true)
  assert.equal(store.getConceptDossier(saved.id), null)
  store.close()

  const { DatabaseSync } = await import('node:sqlite')
  const legacyPath = join(dir, 'legacy.sqlite')
  const legacy = new DatabaseSync(legacyPath)
  legacy.exec(`CREATE TABLE concept_dossier_members (
    dossier_id TEXT NOT NULL, document_id TEXT NOT NULL, node_id TEXT NOT NULL,
    relation TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', bound_revision INTEGER NOT NULL,
    position INTEGER NOT NULL, PRIMARY KEY (dossier_id, document_id, node_id))`)
  legacy.close()
  const migrated = await openSqliteStore(legacyPath)
  const columns = migrated.db.prepare('PRAGMA table_info(concept_dossier_members)').all().map(row => row.name)
  assert(columns.includes('applicability') && columns.includes('valid_time') && columns.includes('reference_json'),
    'existing dossier databases must gain condition, effective-time and source-snapshot fields without replacement')
  migrated.close()

  process.env.DSH_KG_DB = database
  const persistentHost = await import('../lib/index.js')
  const routes = []
  persistentHost.apply({
    get(name) { return name === 'webServer' ? { register(route) { routes.push(route); return () => {} } } : null },
    effect(fn) { return fn() }, interval() { return () => {} },
  })
  const route = routes.find(item => item.path === '/api/dsh-knowledge-graph')
  assert(route, 'generated Host must register the concept dossier route')
  const post = body => new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'; req.url = '/api/dsh-knowledge-graph/concept-dossier'; req.headers = {}
    const res = { setHeader() {}, writeHead() {}, end(data) { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } } }
    route.handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end') })
  })
  const apiCandidates = await post({ action: 'candidates', documentId: 'book-a', nodeId: 'concept' })
  assert.equal(apiCandidates.matchRule, 'same_label_candidate_only')
  assert(apiCandidates.candidates.some(item => item.documentId === 'book-b'))
  assert.deepEqual((await post({ action: 'list', documentId: 'book-a' })).dossiers, [])
  const apiSaved = await post({ action: 'save', dossier: { title: 'API comparison',
    anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'contrast', note: '不同领域' }],
    expectedRevisions: { 'book-a': 1, 'book-b': 2 } } })
  assert.equal(apiSaved.dossier.members[1].noteOrigin, 'user_annotation')
  assert.equal(apiSaved.dossier.members[1].stale, false)
  assert.equal((await post({ action: 'get', id: apiSaved.dossier.id })).dossier.version, 1)
  const apiUpdated = await post({ action: 'save', dossier: { id: apiSaved.dossier.id, expectedVersion: 1,
    title: 'Updated API comparison', anchor: { documentId: 'book-a', nodeId: 'concept' },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'related', note: 'Reconsidered' }],
    expectedRevisions: { 'book-a': 1, 'book-b': 2 } } })
  assert.equal(apiUpdated.dossier.version, 2)
  assert.equal(apiUpdated.dossier.members[1].note, 'Reconsidered')
  assert.equal((await post({ action: 'delete', id: apiSaved.dossier.id, expectedVersion: 1 })).error.code,
    'dossier_conflict', 'stale browser cannot remove an edited dossier')
  assert.equal((await post({ action: 'save', dossier: { ...apiSaved.dossier, expectedVersion: 1,
    expectedRevisions: { 'book-a': 1, 'book-b': 1 },
    members: [{ documentId: 'book-b', nodeId: 'concept', relation: 'contrast', note: '' }] } })).error.code, 'dossier_conflict')
  assert.equal((await post({ action: 'delete', id: apiSaved.dossier.id, expectedVersion: 2 })).deleted, true)
  delete process.env.DSH_KG_DB
} finally {
  delete process.env.DSH_KG_DB
  rmSync(dir, { recursive: true, force: true })
}
console.log(JSON.stringify({ candidateOnly: true, explicitComparison: true, sourceFence: true, durable: true }))
