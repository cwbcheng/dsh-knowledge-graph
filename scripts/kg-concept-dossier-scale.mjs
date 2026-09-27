import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openSqliteStore } from '../src/kg-store.mjs'

const dir = mkdtempSync(join(tmpdir(), 'kg-dossier-scale-'))
try {
  const store = await openSqliteStore(join(dir, 'graphs.sqlite'))
  const insertDocument = store.db.prepare(`INSERT INTO documents
    (document_id, source_id, title, source_json, graph_revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 1, 1)`)
  const insertNode = store.db.prepare(`INSERT INTO graph_nodes
    (node_key, document_id, source_id, node_id, type, text, quote, paragraph, evidence_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'concept', ?, '', 0, '[]', 1, 1)`)
  store.db.exec('BEGIN IMMEDIATE')
  try {
    for (let document = 0; document < 300; document++) {
      const id = `book-${document.toString().padStart(3, '0')}`
      insertDocument.run(id, id, id, JSON.stringify({ documentId: id, id, title: id }))
      for (let node = 0; node < 100; node++) {
        const nodeId = `concept-${node}`
        const label = node === 0 ? '迁移' : `概念 ${document} ${node}`
        insertNode.run(`${id}:${nodeId}`, id, id, nodeId, label)
      }
    }
    store.db.exec('COMMIT')
  } catch (error) { store.db.exec('ROLLBACK'); throw error }
  const startExact = performance.now()
  const exact = store.searchConceptCandidates({ documentId: 'book-000', nodeId: 'concept-0' })
  const exactMs = performance.now() - startExact
  const startSearch = performance.now()
  const searched = store.searchConceptCandidates({ documentId: 'book-000', nodeId: 'concept-0', query: '概念 299' })
  const searchMs = performance.now() - startSearch
  assert.equal(exact.candidates.length, 30)
  assert.equal(searched.candidates.length, 30)
  assert(searched.candidates.every(item => item.documentId === 'book-299'))
  const exactPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT document_id, node_id FROM graph_nodes
    WHERE type IN ('concept', 'definition') AND text = ? COLLATE NOCASE AND document_id <> ?
    ORDER BY document_id, node_id LIMIT ?`).all('迁移', 'book-000', 30)
  const searchPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT document_id, node_id FROM graph_nodes
    WHERE type IN ('concept', 'definition') AND instr(lower(text), lower(?)) > 0 AND document_id <> ?
    ORDER BY document_id, node_id LIMIT ?`).all('概念 299', 'book-000', 30)
  assert(exactPlan.some(row => row.detail.includes('graph_nodes_concept_lookup_idx')))
  console.log(JSON.stringify({ documents: 300, concepts: 30000, exactMs, searchMs, exactPlan, searchPlan }))
  store.close()
} finally { rmSync(dir, { recursive: true, force: true }) }
