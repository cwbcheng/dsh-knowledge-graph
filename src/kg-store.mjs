import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const SCHEMA = `
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS documents (
  document_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  chars INTEGER NOT NULL DEFAULT 0,
  paragraph_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  section_count INTEGER NOT NULL DEFAULT 0,
  source_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  start_paragraph INTEGER,
  end_paragraph INTEGER,
  section_ids_json TEXT NOT NULL,
  section_titles_json TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'completed',
  node_ids_json TEXT NOT NULL,
  edge_count INTEGER NOT NULL DEFAULT 0,
  warnings_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chunks_document_idx ON chunks(document_id, start_paragraph);
CREATE TABLE IF NOT EXISTS graph_nodes (
  node_key TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  type TEXT NOT NULL,
  text TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  paragraph INTEGER,
  evidence_json TEXT NOT NULL,
  chunk_id TEXT,
  section_id TEXT,
  section_title TEXT,
  state TEXT NOT NULL DEFAULT 'candidate',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (document_id, node_id),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS graph_nodes_document_idx ON graph_nodes(document_id, paragraph);
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_key TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  chunk_id TEXT,
  state TEXT NOT NULL DEFAULT 'candidate',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (document_id, from_node_id, to_node_id, relation),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS graph_edges_document_idx ON graph_edges(document_id);
CREATE TABLE IF NOT EXISTS entity_candidates (
  entity_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  node_id TEXT,
  canonical_text TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'concept',
  status TEXT NOT NULL DEFAULT 'candidate',
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (document_id, canonical_text, entity_type),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS entity_candidates_status_idx ON entity_candidates(document_id, status, updated_at);
CREATE TABLE IF NOT EXISTS claim_candidates (
  claim_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  node_id TEXT,
  claim_text TEXT NOT NULL,
  claim_kind TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'candidate',
  confidence REAL,
  evidence_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (document_id, node_id, claim_text),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS claim_candidates_status_idx ON claim_candidates(document_id, status, updated_at);
CREATE TABLE IF NOT EXISTS extraction_runs (
  run_id TEXT PRIMARY KEY,
  document_id TEXT,
  source_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  next_batch_index INTEGER NOT NULL DEFAULT 0,
  total_batches INTEGER NOT NULL DEFAULT 0,
  checkpoint_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS extraction_runs_document_idx ON extraction_runs(document_id, updated_at);
`

const ENTITY_TYPES = new Set(['concept', 'definition'])
const CLAIM_TYPES = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])
const CANDIDATE_STATUSES = new Set(['candidate', 'accepted', 'rejected'])

function stableHash(value) {
  return createHash('sha256').update(String(value == null ? '' : value)).digest('hex').slice(0, 32)
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function int(value, fallback = 0) {
  return Number.isInteger(value) ? value : fallback
}

function json(value, fallback) {
  try { return JSON.stringify(value == null ? fallback : value) } catch (e) { return JSON.stringify(fallback) }
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '')
    return parsed == null ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

function normalizeStatus(value) {
  return CANDIDATE_STATUSES.has(value) ? value : 'candidate'
}

export function defaultStorePath() {
  if (typeof process !== 'undefined' && process.env && process.env.DSH_KG_DB) return process.env.DSH_KG_DB
  return '.dsh-knowledge-graph.sqlite'
}

export async function openSqliteStore(filePath = defaultStorePath()) {
  let sqlite
  try {
    sqlite = await import('node:sqlite')
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    throw new Error('SQLite persistence requires a Node runtime with node:sqlite (Node 22.5+): ' + message)
  }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    throw new Error('SQLite persistence requires node:sqlite.DatabaseSync')
  }
  const filename = filePath || defaultStorePath()
  if (filename !== ':memory:') mkdirSync(dirname(resolve(filename)), { recursive: true })
  const db = new sqlite.DatabaseSync(filename)
  return new SqliteKnowledgeStore(db, filename)
}

export class SqliteKnowledgeStore {
  constructor(db, filename) {
    this.db = db
    this.filename = filename
    this.db.exec(SCHEMA)
  }

  close() {
    if (this.db && typeof this.db.close === 'function') this.db.close()
  }

  saveGraph(graph, options = {}) {
    if (!graph || typeof graph !== 'object') throw new Error('graph must be an object')
    const sourceInput = graph.source && typeof graph.source === 'object' ? graph.source : {}
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((node) => node && typeof node === 'object') : []
    const edges = Array.isArray(graph.edges) ? graph.edges.filter((edge) => edge && typeof edge === 'object') : []
    const staging = graph.staging && typeof graph.staging === 'object' ? graph.staging : {}
    const sourceId = text(sourceInput.id || sourceInput.sourceId || graph.sourceId || options.sourceId) || 'source_' + stableHash(JSON.stringify({ title: sourceInput.title || options.title || '', nodes }))
    const documentId = text(sourceInput.documentId || graph.documentId || options.documentId) || 'document_' + stableHash(sourceId)
    const title = text(sourceInput.title || options.title)
    const paragraphCount = int(sourceInput.paragraphCount, nodes.reduce((max, node) => Math.max(max, int(node.paragraph, -1) + 1), 0))
    const now = Date.now()
    const source = {
      ...sourceInput,
      id: sourceId,
      documentId,
      title,
      chars: int(sourceInput.chars, text(options.sourceText).length),
      paragraphCount,
      chunkCount: int(sourceInput.chunkCount, Array.isArray(staging.chunks) ? staging.chunks.length : 0),
      sectionCount: int(sourceInput.sectionCount, Array.isArray(sourceInput.sections) ? sourceInput.sections.length : 0),
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.prepare(`
        INSERT INTO documents (document_id, source_id, title, chars, paragraph_count, chunk_count, section_count, source_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          source_id = excluded.source_id,
          title = excluded.title,
          chars = excluded.chars,
          paragraph_count = excluded.paragraph_count,
          chunk_count = excluded.chunk_count,
          section_count = excluded.section_count,
          source_json = excluded.source_json,
          updated_at = excluded.updated_at
      `).run(documentId, sourceId, title, source.chars, source.paragraphCount, source.chunkCount, source.sectionCount, json(source, {}), now, now)

      const chunkStmt = this.db.prepare(`
        INSERT INTO chunks (chunk_id, document_id, source_id, start_paragraph, end_paragraph, section_ids_json, section_titles_json, summary, status, node_ids_json, edge_count, warnings_json, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET
          document_id = excluded.document_id,
          source_id = excluded.source_id,
          start_paragraph = excluded.start_paragraph,
          end_paragraph = excluded.end_paragraph,
          section_ids_json = excluded.section_ids_json,
          section_titles_json = excluded.section_titles_json,
          summary = excluded.summary,
          status = excluded.status,
          node_ids_json = excluded.node_ids_json,
          edge_count = excluded.edge_count,
          warnings_json = excluded.warnings_json,
          payload_json = excluded.payload_json,
          updated_at = excluded.updated_at
      `)
      for (const chunk of Array.isArray(staging.chunks) ? staging.chunks : []) {
        const chunkId = text(chunk.chunkId)
        if (!chunkId) continue
        chunkStmt.run(
          chunkId,
          documentId,
          sourceId,
          int(chunk.startParagraph, 0),
          int(chunk.endParagraph, 0),
          json(Array.isArray(chunk.sectionIds) ? chunk.sectionIds : [], []),
          json(Array.isArray(chunk.sectionTitles) ? chunk.sectionTitles : [], []),
          text(chunk.summary),
          text(chunk.status, 'completed'),
          json(Array.isArray(chunk.nodeIds) ? chunk.nodeIds : [], []),
          int(chunk.edgeCount, 0),
          json(Array.isArray(chunk.warnings) ? chunk.warnings : [], []),
          json(chunk, {}),
          now,
        )
      }

      const nodeStmt = this.db.prepare(`
        INSERT INTO graph_nodes (node_key, document_id, source_id, node_id, type, text, quote, paragraph, evidence_json, chunk_id, section_id, section_title, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_key) DO UPDATE SET
          source_id = excluded.source_id,
          type = excluded.type,
          text = excluded.text,
          quote = excluded.quote,
          paragraph = excluded.paragraph,
          evidence_json = excluded.evidence_json,
          chunk_id = excluded.chunk_id,
          section_id = excluded.section_id,
          section_title = excluded.section_title,
          updated_at = excluded.updated_at
      `)
      for (const node of nodes) {
        const nodeId = text(node.id)
        const nodeText = text(node.text)
        if (!nodeId || !nodeText) continue
        const nodeKey = documentId + '\u001f' + nodeId
        nodeStmt.run(
          nodeKey,
          documentId,
          text(node.sourceId, sourceId),
          nodeId,
          text(node.type, 'fact'),
          nodeText,
          text(node.quote),
          Number.isInteger(node.paragraph) ? node.paragraph : null,
          json(Array.isArray(node.evidence) ? node.evidence : [], []),
          text(node.chunkId) || null,
          text(node.sectionId) || null,
          text(node.sectionTitle) || null,
          normalizeStatus(node.state),
          now,
          now,
        )
      }

      const edgeStmt = this.db.prepare(`
        INSERT INTO graph_edges (edge_key, document_id, source_id, from_node_id, to_node_id, relation, evidence_json, chunk_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(edge_key) DO UPDATE SET
          source_id = excluded.source_id,
          relation = excluded.relation,
          evidence_json = excluded.evidence_json,
          chunk_id = excluded.chunk_id,
          updated_at = excluded.updated_at
      `)
      for (const edge of edges) {
        const fromNodeId = text(edge.fromNodeId)
        const toNodeId = text(edge.toNodeId)
        const relation = text(edge.relation)
        if (!fromNodeId || !toNodeId || !relation) continue
        const edgeKey = documentId + '_' + stableHash(fromNodeId + '\u001f' + toNodeId + '\u001f' + relation)
        edgeStmt.run(
          edgeKey,
          documentId,
          text(edge.sourceId, sourceId),
          fromNodeId,
          toNodeId,
          relation,
          json(Array.isArray(edge.evidence) ? edge.evidence : [], []),
          text(edge.chunkId) || null,
          normalizeStatus(edge.state),
          now,
          now,
        )
      }

      const entityStmt = this.db.prepare(`
        INSERT INTO entity_candidates (entity_id, document_id, node_id, canonical_text, entity_type, status, evidence_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entity_id) DO UPDATE SET
          node_id = excluded.node_id,
          canonical_text = excluded.canonical_text,
          entity_type = excluded.entity_type,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at
      `)
      const claimStmt = this.db.prepare(`
        INSERT INTO claim_candidates (claim_id, document_id, node_id, claim_text, claim_kind, status, confidence, evidence_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(claim_id) DO UPDATE SET
          node_id = excluded.node_id,
          claim_text = excluded.claim_text,
          claim_kind = excluded.claim_kind,
          confidence = excluded.confidence,
          evidence_json = excluded.evidence_json,
          updated_at = excluded.updated_at
      `)
      for (const node of nodes) {
        const nodeId = text(node.id)
        const nodeText = text(node.text)
        const nodeType = text(node.type, 'fact')
        if (!nodeId || !nodeText) continue
        const evidence = Array.isArray(node.evidence) ? node.evidence : []
        if (ENTITY_TYPES.has(nodeType)) {
          entityStmt.run(
            'ent_' + stableHash(documentId + '\u001f' + nodeType + '\u001f' + nodeText),
            documentId,
            nodeId,
            nodeText,
            nodeType,
            'candidate',
            json(evidence, []),
            now,
            now,
          )
        }
        if (CLAIM_TYPES.has(nodeType)) {
          claimStmt.run(
            'clm_' + stableHash(documentId + '\u001f' + nodeId + '\u001f' + nodeText),
            documentId,
            nodeId,
            nodeText,
            nodeType,
            'candidate',
            typeof node.confidence === 'number' ? node.confidence : null,
            json(evidence, []),
            now,
            now,
          )
        }
      }
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (e) {}
      throw error
    }

    return {
      documentId,
      sourceId,
      nodes: nodes.length,
      edges: edges.length,
      chunks: Array.isArray(staging.chunks) ? staging.chunks.length : 0,
      entityCandidates: nodes.filter((node) => ENTITY_TYPES.has(text(node.type))).length,
      claimCandidates: nodes.filter((node) => CLAIM_TYPES.has(text(node.type))).length,
    }
  }

  saveCheckpoint(checkpoint, options = {}) {
    if (!checkpoint || typeof checkpoint !== 'object') throw new Error('checkpoint must be an object')
    const runId = text(options.runId || checkpoint.runId) || 'run_' + stableHash(JSON.stringify(checkpoint))
    const now = Date.now()
    const status = text(options.status || checkpoint.status, 'running')
    const documentId = text(checkpoint.documentId || options.documentId) || null
    const sourceId = text(checkpoint.sourceId || options.sourceId) || null
    const nextBatchIndex = int(checkpoint.nextBatchIndex, 0)
    const totalBatches = int(checkpoint.totalBatches, 0)
    this.db.prepare(`
      INSERT INTO extraction_runs (run_id, document_id, source_id, status, next_batch_index, total_batches, checkpoint_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        document_id = excluded.document_id,
        source_id = excluded.source_id,
        status = excluded.status,
        next_batch_index = excluded.next_batch_index,
        total_batches = excluded.total_batches,
        checkpoint_json = excluded.checkpoint_json,
        updated_at = excluded.updated_at
    `).run(runId, documentId, sourceId, status, nextBatchIndex, totalBatches, json(checkpoint, {}), now, now)
    return { runId, documentId, sourceId, status, nextBatchIndex, totalBatches }
  }

  loadCheckpoint(runId) {
    const row = this.db.prepare('SELECT run_id, document_id, source_id, status, next_batch_index, total_batches, checkpoint_json, created_at, updated_at FROM extraction_runs WHERE run_id = ?').get(runId)
    if (!row) return null
    return {
      runId: row.run_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      status: row.status,
      nextBatchIndex: row.next_batch_index,
      totalBatches: row.total_batches,
      checkpoint: parseJson(row.checkpoint_json, {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  listDocuments(limit = 50) {
    const rows = this.db.prepare('SELECT document_id, source_id, title, chars, paragraph_count, chunk_count, section_count, created_at, updated_at FROM documents ORDER BY updated_at DESC LIMIT ?').all(Math.max(1, Math.min(500, int(limit, 50))))
    return rows.map((row) => ({
      documentId: row.document_id,
      sourceId: row.source_id,
      title: row.title,
      chars: row.chars,
      paragraphCount: row.paragraph_count,
      chunkCount: row.chunk_count,
      sectionCount: row.section_count,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
  }

  getDocument(documentId) {
    const row = this.db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId)
    if (!row) return null
    const nodes = this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id').all(documentId).map((node) => ({
      id: node.node_id,
      type: node.type,
      text: node.text,
      quote: node.quote,
      paragraph: node.paragraph,
      evidence: parseJson(node.evidence_json, []),
      documentId: node.document_id,
      sourceId: node.source_id,
      chunkId: node.chunk_id,
      sectionId: node.section_id,
      sectionTitle: node.section_title,
      state: node.state,
    }))
    const edges = this.db.prepare('SELECT * FROM graph_edges WHERE document_id = ? ORDER BY from_node_id, to_node_id').all(documentId).map((edge) => ({
      fromNodeId: edge.from_node_id,
      toNodeId: edge.to_node_id,
      relation: edge.relation,
      evidence: parseJson(edge.evidence_json, []),
      documentId: edge.document_id,
      sourceId: edge.source_id,
      chunkId: edge.chunk_id,
      state: edge.state,
    }))
    const chunks = this.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY start_paragraph, chunk_id').all(documentId).map((chunk) => ({
      chunkId: chunk.chunk_id,
      startParagraph: chunk.start_paragraph,
      endParagraph: chunk.end_paragraph,
      sectionIds: parseJson(chunk.section_ids_json, []),
      sectionTitles: parseJson(chunk.section_titles_json, []),
      summary: chunk.summary,
      status: chunk.status,
      nodeIds: parseJson(chunk.node_ids_json, []),
      edgeCount: chunk.edge_count,
      warnings: parseJson(chunk.warnings_json, []),
    }))
    return {
      source: parseJson(row.source_json, {
        id: row.source_id,
        documentId: row.document_id,
        title: row.title,
        chars: row.chars,
        paragraphCount: row.paragraph_count,
        chunkCount: row.chunk_count,
        sectionCount: row.section_count,
      }),
      nodes,
      edges,
      staging: { sourceId: row.source_id, documentId: row.document_id, chunkCount: chunks.length, chunks },
    }
  }

  listCandidates(options = {}) {
    const documentId = text(options.documentId)
    const status = options.status && options.status !== 'all' ? normalizeStatus(options.status) : null
    const kind = options.kind === 'entity' || options.kind === 'claim' ? options.kind : 'all'
    const limit = Math.max(1, Math.min(500, int(options.limit, 50)))
    const result = []
    if (kind === 'all' || kind === 'entity') {
      const where = []
      const params = []
      if (documentId) { where.push('document_id = ?'); params.push(documentId) }
      if (status) { where.push('status = ?'); params.push(status) }
      params.push(limit)
      const sql = 'SELECT * FROM entity_candidates' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC LIMIT ?'
      for (const row of this.db.prepare(sql).all(...params)) result.push({
        kind: 'entity',
        id: row.entity_id,
        documentId: row.document_id,
        nodeId: row.node_id,
        text: row.canonical_text,
        type: row.entity_type,
        status: row.status,
        evidence: parseJson(row.evidence_json, []),
        updatedAt: row.updated_at,
      })
    }
    if (kind === 'all' || kind === 'claim') {
      const where = []
      const params = []
      if (documentId) { where.push('document_id = ?'); params.push(documentId) }
      if (status) { where.push('status = ?'); params.push(status) }
      params.push(limit)
      const sql = 'SELECT * FROM claim_candidates' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY updated_at DESC LIMIT ?'
      for (const row of this.db.prepare(sql).all(...params)) result.push({
        kind: 'claim',
        id: row.claim_id,
        documentId: row.document_id,
        nodeId: row.node_id,
        text: row.claim_text,
        type: row.claim_kind,
        status: row.status,
        confidence: row.confidence,
        evidence: parseJson(row.evidence_json, []),
        updatedAt: row.updated_at,
      })
    }
    return result.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, limit)
  }

  updateCandidate(kind, id, status) {
    if (kind !== 'entity' && kind !== 'claim') throw new Error('kind must be entity or claim')
    if (!CANDIDATE_STATUSES.has(status)) throw new Error('status must be candidate, accepted, or rejected')
    const table = kind === 'entity' ? 'entity_candidates' : 'claim_candidates'
    const idColumn = kind === 'entity' ? 'entity_id' : 'claim_id'
    const result = this.db.prepare('UPDATE ' + table + ' SET status = ?, updated_at = ? WHERE ' + idColumn + ' = ?').run(status, Date.now(), id)
    if (!result || result.changes === 0) return null
    return { kind, id, status }
  }
}
