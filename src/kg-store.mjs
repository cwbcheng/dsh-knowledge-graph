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
  source_text TEXT NOT NULL DEFAULT '',
  graph_meta_json TEXT NOT NULL DEFAULT '{}',
  graph_revision INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT NOT NULL,
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
  PRIMARY KEY (document_id, source_id, chunk_id),
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
  grounding_status TEXT NOT NULL DEFAULT 'candidate',
  entailment_status TEXT NOT NULL DEFAULT 'unverified',
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
  title TEXT NOT NULL DEFAULT '',
  source_text TEXT NOT NULL DEFAULT '',
  error_code TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS extraction_runs_document_idx ON extraction_runs(document_id, updated_at);
CREATE TABLE IF NOT EXISTS graph_revisions (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_revision INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'extract',
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, revision),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS graph_revisions_document_idx ON graph_revisions(document_id, revision DESC);
`

const ENTITY_TYPES = new Set(['concept', 'definition'])
const CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])
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

function edgeIdentity(edge) {
  return edge && typeof edge === 'object'
    ? String(edge.fromNodeId || '') + '>' + String(edge.toNodeId || '') + ':' + String(edge.relation || '')
    : ''
}

function nodeFromRow(node) {
  return {
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
    groundingStatus: text(node.grounding_status, 'candidate'),
    entailmentStatus: text(node.entailment_status, 'unverified'),
    state: node.state,
  }
}

function edgeFromRow(edge) {
  return {
    fromNodeId: edge.from_node_id,
    toNodeId: edge.to_node_id,
    relation: edge.relation,
    evidence: parseJson(edge.evidence_json, []),
    documentId: edge.document_id,
    sourceId: edge.source_id,
    chunkId: edge.chunk_id,
    state: edge.state,
  }
}

function chunkFromRow(chunk) {
  return {
    chunkId: chunk.chunk_id,
    sourceId: chunk.source_id,
    startParagraph: chunk.start_paragraph,
    endParagraph: chunk.end_paragraph,
    sectionIds: parseJson(chunk.section_ids_json, []),
    sectionTitles: parseJson(chunk.section_titles_json, []),
    summary: chunk.summary,
    status: chunk.status,
    nodeIds: parseJson(chunk.node_ids_json, []),
    edgeCount: chunk.edge_count,
    warnings: parseJson(chunk.warnings_json, []),
  }
}

function escapeLike(value) {
  return String(value == null ? '' : value).replace(/[\\%_]/g, (match) => '\\' + match)
}

function mergeEvidence(primary, secondary, limit = 8) {
  const out = []
  for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!item || typeof item !== 'object' || out.length >= limit) continue
    const key = String(item.documentId || '') + '|' + String(item.sourceId || '') + '|' + String(item.chunkId || '') + '|' + String(item.paragraph) + '|' + String(item.quote || '')
    if (!out.some((existing) => String(existing.documentId || '') + '|' + String(existing.sourceId || '') + '|' + String(existing.chunkId || '') + '|' + String(existing.paragraph) + '|' + String(existing.quote || '') === key)) out.push({ ...item })
  }
  return out
}

function applyCanonicalOperations(graph, operations) {
  let next = {
    ...graph,
    nodes: (Array.isArray(graph && graph.nodes) ? graph.nodes : []).map((node) => ({ ...node, evidence: mergeEvidence([], node.evidence) })),
    edges: (Array.isArray(graph && graph.edges) ? graph.edges : []).map((edge) => ({ ...edge, evidence: mergeEvidence([], edge.evidence) })),
  }
  for (const operation of Array.isArray(operations) ? operations : []) {
    if (!operation || operation.kind !== 'merge_node') continue
    const fromId = text(operation.fromNodeId)
    const intoId = text(operation.intoNodeId)
    if (!fromId || !intoId || fromId === intoId) {
      const error = new Error('invalid merge_node operation')
      error.code = 'invalid_operation'
      throw error
    }
    const from = next.nodes.find((node) => node && node.id === fromId)
    const intoIndex = next.nodes.findIndex((node) => node && node.id === intoId)
    if (!from) {
      if (intoIndex >= 0) continue
      const error = new Error('merge target not found: ' + intoId)
      error.code = 'invalid_operation'
      throw error
    }
    if (intoIndex < 0) {
      const error = new Error('merge target not found: ' + intoId)
      error.code = 'invalid_operation'
      throw error
    }
    const target = { ...next.nodes[intoIndex] }
    if ((!target.quote || !String(target.quote).trim()) && from.quote) target.quote = from.quote
    if (!Number.isInteger(target.paragraph) && Number.isInteger(from.paragraph)) target.paragraph = from.paragraph
    for (const field of ['documentId', 'sourceId', 'chunkId', 'sectionId', 'sectionTitle']) {
      if (target[field] == null && from[field] != null) target[field] = from[field]
    }
    target.evidence = mergeEvidence(target.evidence, from.evidence)
    if (target.evidence.length > 0 || from.groundingStatus === 'grounded') target.groundingStatus = 'grounded'
    else if (!target.groundingStatus) target.groundingStatus = from.groundingStatus || 'candidate'
    if (target.entailmentStatus !== 'verified') target.entailmentStatus = from.entailmentStatus || target.entailmentStatus || 'unverified'
    next.nodes[intoIndex] = target
    next.nodes = next.nodes.filter((node) => node && node.id !== fromId)
    const edgeMap = new Map()
    for (const edge of next.edges) {
      if (!edge) continue
      const rewritten = {
        ...edge,
        fromNodeId: edge.fromNodeId === fromId ? intoId : edge.fromNodeId,
        toNodeId: edge.toNodeId === fromId ? intoId : edge.toNodeId,
      }
      if (rewritten.fromNodeId === rewritten.toNodeId) continue
      const key = edgeIdentity(rewritten)
      const previous = edgeMap.get(key)
      if (previous) previous.evidence = mergeEvidence(previous.evidence, rewritten.evidence)
      else edgeMap.set(key, rewritten)
    }
    next.edges = Array.from(edgeMap.values())
  }
  return next
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
    this.migrateChunkIdentitySchema()
    // CREATE TABLE IF NOT EXISTS does not add columns to databases created by
    // older releases. Keep migrations additive and deterministic.
    this.ensureColumn('documents', 'source_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('documents', 'graph_meta_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('documents', 'graph_revision', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('graph_nodes', 'grounding_status', "TEXT NOT NULL DEFAULT 'candidate'")
    this.ensureColumn('graph_nodes', 'entailment_status', "TEXT NOT NULL DEFAULT 'unverified'")
    this.ensureColumn('extraction_runs', 'title', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('extraction_runs', 'source_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('extraction_runs', 'error_code', 'TEXT')
    this.ensureColumn('extraction_runs', 'error_message', 'TEXT')
  }

  ensureColumn(table, column, declaration) {
    const columns = this.db.prepare('PRAGMA table_info(' + table + ')').all()
    if (columns.some((row) => row && row.name === column)) return
    this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + declaration)
  }

  migrateChunkIdentitySchema() {
    const info = this.db.prepare('PRAGMA table_info(chunks)').all()
    const primary = info.filter((row) => row && row.pk > 0).sort((a, b) => a.pk - b.pk).map((row) => row.name)
    if (primary.join(',') === 'document_id,source_id,chunk_id') return
    // Legacy releases used chunk_id as a database-global primary key even
    // though extraction restarts numbering per source. Rebuild the table with
    // the real provenance identity; already-overwritten rows cannot be
    // reconstructed, but future documents/appends cannot move each other's chunks.
    this.db.exec('PRAGMA foreign_keys = OFF')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DROP INDEX IF EXISTS chunks_document_idx')
      this.db.exec('ALTER TABLE chunks RENAME TO chunks_legacy_identity')
      this.db.exec(`
        CREATE TABLE chunks (
          chunk_id TEXT NOT NULL,
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
          PRIMARY KEY (document_id, source_id, chunk_id),
          FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
        )
      `)
      this.db.exec(`
        INSERT OR IGNORE INTO chunks (
          chunk_id, document_id, source_id, start_paragraph, end_paragraph,
          section_ids_json, section_titles_json, summary, status, node_ids_json,
          edge_count, warnings_json, payload_json, updated_at
        )
        SELECT chunk_id, document_id, source_id, start_paragraph, end_paragraph,
          section_ids_json, section_titles_json, summary, status, node_ids_json,
          edge_count, warnings_json, payload_json, updated_at
        FROM chunks_legacy_identity
      `)
      this.db.exec('DROP TABLE chunks_legacy_identity')
      this.db.exec('CREATE INDEX chunks_document_idx ON chunks(document_id, start_paragraph)')
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch (e) {}
      throw error
    } finally {
      this.db.exec('PRAGMA foreign_keys = ON')
    }
  }

  close() {
    if (this.db && typeof this.db.close === 'function') this.db.close()
  }

  saveGraph(graph, options = {}) {
    const invalidGraph = (message) => {
      const error = new Error(message)
      error.code = 'invalid_graph'
      return error
    }
    if (!graph || typeof graph !== 'object' || Array.isArray(graph)) throw invalidGraph('graph must be an object')
    const hasNodes = Object.prototype.hasOwnProperty.call(graph, 'nodes')
    const hasEdges = Object.prototype.hasOwnProperty.call(graph, 'edges')
    if (hasNodes && !Array.isArray(graph.nodes)) throw invalidGraph('graph.nodes must be an array when provided')
    if (hasEdges && !Array.isArray(graph.edges)) throw invalidGraph('graph.edges must be an array when provided')
    const sourceInput = graph.source && typeof graph.source === 'object' ? graph.source : {}
    const nodes = hasNodes ? graph.nodes.slice() : []
    const edges = hasEdges ? graph.edges.slice() : []
    const nodeIds = new Set()
    for (let index = 0; index < nodes.length; index++) {
      const node = nodes[index]
      if (!node || typeof node !== 'object' || Array.isArray(node)) throw invalidGraph('graph node at index ' + index + ' must be an object')
      const rawNodeId = text(node.id)
      const rawNodeText = text(node.text)
      const nodeId = rawNodeId.trim()
      const nodeText = rawNodeText.trim()
      if (!nodeId || !nodeText) throw invalidGraph('graph node at index ' + index + ' must have non-empty id and text')
      if (rawNodeId !== nodeId || rawNodeText !== nodeText) throw invalidGraph('graph node at index ' + index + ' has leading or trailing whitespace')
      if (nodeIds.has(nodeId)) throw invalidGraph('duplicate graph node id: ' + nodeId)
      nodeIds.add(nodeId)
    }
    const edgeIds = new Set()
    for (let index = 0; index < edges.length; index++) {
      const edge = edges[index]
      if (!edge || typeof edge !== 'object' || Array.isArray(edge)) throw invalidGraph('graph edge at index ' + index + ' must be an object')
      const rawFromNodeId = text(edge.fromNodeId)
      const rawToNodeId = text(edge.toNodeId)
      const rawRelation = text(edge.relation)
      const fromNodeId = rawFromNodeId.trim()
      const toNodeId = rawToNodeId.trim()
      const relation = rawRelation.trim()
      if (!fromNodeId || !toNodeId || !relation) throw invalidGraph('graph edge at index ' + index + ' must have non-empty endpoints and relation')
      if (rawFromNodeId !== fromNodeId || rawToNodeId !== toNodeId || rawRelation !== relation) throw invalidGraph('graph edge at index ' + index + ' has leading or trailing whitespace')
      if (fromNodeId === toNodeId) throw invalidGraph('graph edge at index ' + index + ' is a self-loop: ' + fromNodeId)
      if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) throw invalidGraph('graph edge at index ' + index + ' references a missing node: ' + fromNodeId + '>' + toNodeId)
      const identity = fromNodeId + '>' + toNodeId + ':' + relation
      if (edgeIds.has(identity)) throw invalidGraph('duplicate graph edge: ' + identity)
      edgeIds.add(identity)
    }
    const staging = graph.staging && typeof graph.staging === 'object' ? graph.staging : {}
    const sourceId = text(sourceInput.id || sourceInput.sourceId || graph.sourceId || options.sourceId) || 'source_' + stableHash(JSON.stringify({ title: sourceInput.title || options.title || '', nodes }))
    const documentId = text(sourceInput.documentId || graph.documentId || options.documentId) || 'document_' + stableHash(sourceId)
    const title = text(sourceInput.title || options.title)
    const paragraphCount = int(sourceInput.paragraphCount, nodes.reduce((max, node) => Math.max(max, int(node.paragraph, -1) + 1), 0))
    const sourceText = text(options.sourceText)
    const graphMeta = {
      summary: text(graph.summary),
      warnings: Array.isArray(graph.warnings) ? graph.warnings : [],
      ...(graph.generation && typeof graph.generation === 'object' ? { generation: graph.generation } : {}),
      ...(typeof graph.traceText === 'string' ? { traceText: graph.traceText } : {}),
      ...(Array.isArray(graph.traceEvents) ? { traceEvents: graph.traceEvents } : {}),
      ...(graph.verification && typeof graph.verification === 'object' ? { verification: graph.verification } : {}),
      ...(graph.factCheck && typeof graph.factCheck === 'object' ? { factCheck: graph.factCheck } : {}),
    }
    const now = Date.now()
    let revision = 0
    const source = {
      ...sourceInput,
      id: sourceId,
      documentId,
      title,
      chars: int(sourceInput.chars, sourceText.length),
      paragraphCount,
      chunkCount: int(sourceInput.chunkCount, Array.isArray(staging.chunks) ? staging.chunks.length : 0),
      sectionCount: int(sourceInput.sectionCount, Array.isArray(sourceInput.sections) ? sourceInput.sections.length : 0),
    }

    this.db.exec('BEGIN IMMEDIATE')
    try {
      const current = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(documentId)
      const currentRevision = current && Number.isInteger(current.graph_revision) ? current.graph_revision : 0
      if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== currentRevision) {
        const error = new Error('graph revision conflict: expected ' + options.expectedRevision + ', current ' + currentRevision)
        error.code = 'revision_conflict'
        error.currentRevision = currentRevision
        throw error
      }
      revision = currentRevision + 1
      source.revision = revision
      this.db.prepare(`
        INSERT INTO documents (document_id, source_id, title, chars, paragraph_count, chunk_count, section_count, source_json, source_text, graph_meta_json, graph_revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          source_id = excluded.source_id,
          title = excluded.title,
          chars = excluded.chars,
          paragraph_count = excluded.paragraph_count,
          chunk_count = excluded.chunk_count,
          section_count = excluded.section_count,
          source_json = excluded.source_json,
          source_text = excluded.source_text,
          graph_meta_json = excluded.graph_meta_json,
          graph_revision = excluded.graph_revision,
          updated_at = excluded.updated_at
      `).run(documentId, sourceId, title, source.chars, source.paragraphCount, source.chunkCount, source.sectionCount, json(source, {}), sourceText, json(graphMeta, {}), revision, now, now)

      // saveGraph represents a canonical revision, not an upsert-only staging
      // append. Remove prior materialized graph rows so UI deletions cannot
      // leave a stale second truth in SQLite. Candidate review state is kept
      // only when the same stable candidate id still exists in the new graph.
      const previousEntityStatuses = new Map(this.db.prepare('SELECT entity_id, status FROM entity_candidates WHERE document_id = ?').all(documentId).map((row) => [row.entity_id, row.status]))
      const previousClaimStatuses = new Map(this.db.prepare('SELECT claim_id, status FROM claim_candidates WHERE document_id = ?').all(documentId).map((row) => [row.claim_id, row.status]))
      this.db.prepare('DELETE FROM chunks WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM graph_edges WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM graph_nodes WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM entity_candidates WHERE document_id = ?').run(documentId)
      this.db.prepare('DELETE FROM claim_candidates WHERE document_id = ?').run(documentId)

      const chunkStmt = this.db.prepare(`
        INSERT INTO chunks (chunk_id, document_id, source_id, start_paragraph, end_paragraph, section_ids_json, section_titles_json, summary, status, node_ids_json, edge_count, warnings_json, payload_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id, source_id, chunk_id) DO UPDATE SET
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
          text(chunk.sourceId, sourceId),
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
        INSERT INTO graph_nodes (node_key, document_id, source_id, node_id, type, text, quote, paragraph, evidence_json, chunk_id, section_id, section_title, grounding_status, entailment_status, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          grounding_status = excluded.grounding_status,
          entailment_status = excluded.entailment_status,
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
          ['grounded', 'candidate', 'unsupported'].includes(text(node.groundingStatus)) ? text(node.groundingStatus) : 'candidate',
          ['verified', 'unsupported', 'uncertain', 'unverified'].includes(text(node.entailmentStatus)) ? text(node.entailmentStatus) : 'unverified',
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
          const entityId = 'ent_' + stableHash(documentId + '\u001f' + nodeType + '\u001f' + nodeText)
          entityStmt.run(
            entityId,
            documentId,
            nodeId,
            nodeText,
            nodeType,
            CANDIDATE_STATUSES.has(previousEntityStatuses.get(entityId)) ? previousEntityStatuses.get(entityId) : 'candidate',
            json(evidence, []),
            now,
            now,
          )
        }
        if (CLAIM_TYPES.has(nodeType)) {
          const claimId = 'clm_' + stableHash(documentId + '\u001f' + nodeId + '\u001f' + nodeText)
          claimStmt.run(
            claimId,
            documentId,
            nodeId,
            nodeText,
            nodeType,
            CANDIDATE_STATUSES.has(previousClaimStatuses.get(claimId)) ? previousClaimStatuses.get(claimId) : 'candidate',
            typeof node.confidence === 'number' ? node.confidence : null,
            json(evidence, []),
            now,
            now,
          )
        }
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO graph_revisions (document_id, revision, parent_revision, kind, summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(documentId, revision, Math.max(0, revision - 1), text(options.kind, 'extract'), json({ nodes: nodes.length, edges: edges.length, chunks: Array.isArray(staging.chunks) ? staging.chunks.length : 0 }, {}), now)
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
      revision,
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
    const title = text(options.title || checkpoint.title)
    const sourceText = text(options.sourceText)
    const errorCode = text(options.errorCode) || null
    const errorMessage = text(options.errorMessage) || null
    this.db.prepare(`
      INSERT INTO extraction_runs (run_id, document_id, source_id, status, next_batch_index, total_batches, checkpoint_json, title, source_text, error_code, error_message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        document_id = excluded.document_id,
        source_id = excluded.source_id,
        status = excluded.status,
        next_batch_index = excluded.next_batch_index,
        total_batches = excluded.total_batches,
        checkpoint_json = excluded.checkpoint_json,
        title = excluded.title,
        source_text = excluded.source_text,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `).run(runId, documentId, sourceId, status, nextBatchIndex, totalBatches, json(checkpoint, {}), title, sourceText, errorCode, errorMessage, now, now)
    return { runId, documentId, sourceId, status, nextBatchIndex, totalBatches }
  }

  loadCheckpoint(runId) {
    const row = this.db.prepare('SELECT * FROM extraction_runs WHERE run_id = ?').get(runId)
    if (!row) return null
    return {
      runId: row.run_id,
      documentId: row.document_id,
      sourceId: row.source_id,
      status: row.status,
      nextBatchIndex: row.next_batch_index,
      totalBatches: row.total_batches,
      checkpoint: parseJson(row.checkpoint_json, {}),
      title: row.title || '',
      sourceText: row.source_text || '',
      errorCode: row.error_code || null,
      errorMessage: row.error_message || null,
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
    const nodes = this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id').all(documentId).map(nodeFromRow)
    const edges = this.db.prepare('SELECT * FROM graph_edges WHERE document_id = ? ORDER BY from_node_id, to_node_id').all(documentId).map(edgeFromRow)
    const chunks = this.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY start_paragraph, chunk_id').all(documentId).map(chunkFromRow)
    const meta = parseJson(row.graph_meta_json, {})
    const source = {
      ...parseJson(row.source_json, {
        id: row.source_id,
        documentId: row.document_id,
        title: row.title,
        chars: row.chars,
        paragraphCount: row.paragraph_count,
        chunkCount: row.chunk_count,
        sectionCount: row.section_count,
      }),
      revision: Number.isInteger(row.graph_revision) ? row.graph_revision : 0,
    }
    return {
      ...meta,
      source,
      sourceText: row.source_text || '',
      revision: Number.isInteger(row.graph_revision) ? row.graph_revision : 0,
      nodes,
      edges,
      staging: { sourceId: row.source_id, documentId: row.document_id, chunkCount: chunks.length, chunks },
    }
  }

  getDocumentWindow(documentId, options = {}) {
    const row = this.db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId)
    if (!row) return null
    const limit = Math.max(1, Math.min(800, int(options.limit, 800)))
    const edgeLimit = Math.max(limit, Math.min(4800, int(options.edgeLimit, limit * 6)))
    const totalNodesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE document_id = ?').get(documentId)
    const totalEdgesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE document_id = ?').get(documentId)
    const totalNodes = totalNodesRow ? Number(totalNodesRow.count) || 0 : 0
    const totalEdges = totalEdgesRow ? Number(totalEdgesRow.count) || 0 : 0
    const requestedOffset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
    const offset = Math.min(requestedOffset, Math.max(0, totalNodes - 1))
    const query = text(options.query).trim().slice(0, 200)

    const fetchNodesByIds = (ids, remaining) => {
      const result = []
      const unique = Array.from(new Set(ids.filter(Boolean)))
      for (let start = 0; start < unique.length && result.length < remaining; start += 400) {
        const part = unique.slice(start, start + 400)
        const marks = part.map(() => '?').join(',')
        const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? AND node_id IN (' + marks + ') ORDER BY paragraph, node_id').all(documentId, ...part)
        for (const item of rows) {
          if (result.length >= remaining) break
          result.push(item)
        }
      }
      return result
    }
    const fetchIncidentEdges = (ids, maxRows) => {
      const result = new Map()
      const unique = Array.from(new Set(ids.filter(Boolean)))
      for (let start = 0; start < unique.length && result.size < maxRows; start += 300) {
        const part = unique.slice(start, start + 300)
        const marks = part.map(() => '?').join(',')
        const remaining = maxRows - result.size
        const rows = this.db.prepare(
          'SELECT * FROM graph_edges WHERE document_id = ? AND (from_node_id IN (' + marks + ') OR to_node_id IN (' + marks + ')) ORDER BY from_node_id, to_node_id LIMIT ?'
        ).all(documentId, ...part, ...part, remaining)
        for (const item of rows) result.set(item.edge_key || (item.from_node_id + '>' + item.to_node_id + ':' + item.relation), item)
      }
      return Array.from(result.values())
    }
    const fetchWindowEdges = (ids, maxRows) => {
      const selected = new Set(ids.filter(Boolean))
      const result = new Map()
      const unique = Array.from(selected)
      for (let start = 0; start < unique.length && result.size < maxRows; start += 400) {
        const part = unique.slice(start, start + 400)
        const marks = part.map(() => '?').join(',')
        const remaining = maxRows - result.size
        const rows = this.db.prepare(
          'SELECT * FROM graph_edges WHERE document_id = ? AND from_node_id IN (' + marks + ') ORDER BY from_node_id, to_node_id LIMIT ?'
        ).all(documentId, ...part, remaining)
        for (const item of rows) {
          if (!selected.has(item.to_node_id)) continue
          result.set(item.edge_key || (item.from_node_id + '>' + item.to_node_id + ':' + item.relation), item)
        }
      }
      return Array.from(result.values())
    }

    let nodeRows = []
    let matchedNodes = null
    let viewKind = 'window'
    if (query) {
      viewKind = 'query'
      const pattern = '%' + query.toLowerCase().replace(/[%_]/g, '') + '%'
      const where = `document_id = ? AND (
        LOWER(node_id) LIKE ? OR LOWER(type) LIKE ? OR LOWER(text) LIKE ? OR
        LOWER(quote) LIKE ? OR LOWER(COALESCE(section_id, '')) LIKE ? OR LOWER(COALESCE(section_title, '')) LIKE ?
      )`
      const params = [documentId, pattern, pattern, pattern, pattern, pattern, pattern]
      const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE ' + where).get(...params)
      matchedNodes = countRow ? Number(countRow.count) || 0 : 0
      const direct = this.db.prepare('SELECT * FROM graph_nodes WHERE ' + where + ' ORDER BY paragraph, node_id LIMIT ?').all(...params, limit)
      const selected = new Map(direct.map((item) => [item.node_id, item]))
      if (selected.size > 0 && selected.size < limit) {
        const incident = fetchIncidentEdges(Array.from(selected.keys()), edgeLimit)
        const neighborIds = []
        for (const edge of incident) {
          if (!selected.has(edge.from_node_id)) neighborIds.push(edge.from_node_id)
          if (!selected.has(edge.to_node_id)) neighborIds.push(edge.to_node_id)
        }
        const neighbors = fetchNodesByIds(neighborIds, limit - selected.size)
        for (const item of neighbors) if (!selected.has(item.node_id) && selected.size < limit) selected.set(item.node_id, item)
      }
      nodeRows = Array.from(selected.values())
    } else {
      nodeRows = this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id LIMIT ? OFFSET ?').all(documentId, limit, offset)
    }
    const nodeIds = nodeRows.map((item) => item.node_id)
    const edgeRows = fetchWindowEdges(nodeIds, edgeLimit)
    const chunks = this.db.prepare('SELECT * FROM chunks WHERE document_id = ? ORDER BY start_paragraph, chunk_id').all(documentId).map(chunkFromRow)
    const meta = parseJson(row.graph_meta_json, {})
    const revision = Number.isInteger(row.graph_revision) ? row.graph_revision : 0
    const source = {
      ...parseJson(row.source_json, {
        id: row.source_id,
        documentId: row.document_id,
        title: row.title,
        chars: row.chars,
        paragraphCount: row.paragraph_count,
        chunkCount: row.chunk_count,
        sectionCount: row.section_count,
      }),
      revision,
    }
    return {
      ...meta,
      source,
      sourceText: options.includeSourceText === false ? '' : (row.source_text || ''),
      revision,
      nodes: nodeRows.map(nodeFromRow),
      edges: edgeRows.map(edgeFromRow),
      staging: { sourceId: row.source_id, documentId: row.document_id, chunkCount: chunks.length, chunks },
      view: {
        kind: viewKind,
        nodeOffset: query ? 0 : offset,
        nodeLimit: limit,
        totalNodes,
        totalEdges,
        truncated: totalNodes > nodeRows.length || totalEdges > edgeRows.length,
        ...(query ? { query, matchedNodes } : {}),
      },
    }
  }

  commitViewGraph(options = {}) {
    const documentId = text(options.documentId)
    const incoming = options.graph && typeof options.graph === 'object' ? options.graph : null
    if (!documentId || !incoming) throw new Error('documentId and graph are required')
    const current = this.getDocument(documentId)
    if (!current) {
      const error = new Error('document not found: ' + documentId)
      error.code = 'not_found'
      throw error
    }
    const expectedRevision = Number.isInteger(options.expectedRevision) ? options.expectedRevision : current.revision
    if (expectedRevision !== current.revision) {
      const error = new Error('graph revision conflict: expected ' + expectedRevision + ', current ' + current.revision)
      error.code = 'revision_conflict'
      error.currentRevision = current.revision
      throw error
    }
    const working = applyCanonicalOperations(current, options.operations)
    const baseNodeIds = new Set(Array.isArray(options.baseNodeIds) ? options.baseNodeIds.filter((id) => typeof id === 'string' && id) : [])
    const baseEdgeKeys = new Set(Array.isArray(options.baseEdgeKeys) ? options.baseEdgeKeys.filter((key) => typeof key === 'string' && key) : [])
    const canonicalNodeIds = new Set((current.nodes || []).filter((node) => node && node.id).map((node) => node.id))
    const nodeMap = new Map((working.nodes || []).filter((node) => node && node.id).map((node) => [node.id, node]))
    for (const id of baseNodeIds) nodeMap.delete(id)
    for (const node of Array.isArray(incoming.nodes) ? incoming.nodes : []) {
      if (!node || typeof node.id !== 'string' || !node.id || typeof node.text !== 'string' || !node.text.trim()) continue
      if (canonicalNodeIds.has(node.id) && !baseNodeIds.has(node.id)) {
        const error = new Error('incoming node id collides with an unseen canonical node: ' + node.id)
        error.code = 'node_id_conflict'
        error.nodeId = node.id
        throw error
      }
      nodeMap.set(node.id, node)
    }
    const edgeMap = new Map((working.edges || []).filter((edge) => edgeIdentity(edge)).map((edge) => [edgeIdentity(edge), edge]))
    for (const key of baseEdgeKeys) edgeMap.delete(key)
    for (const edge of Array.isArray(incoming.edges) ? incoming.edges : []) {
      const key = edgeIdentity(edge)
      if (key) {
        const previous = edgeMap.get(key)
        if (previous) previous.evidence = mergeEvidence(previous.evidence, edge.evidence)
        else edgeMap.set(key, edge)
      }
    }
    const nodeIds = new Set(nodeMap.keys())
    const edges = Array.from(edgeMap.values()).filter((edge) => nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
    const nextGraph = {
      ...working,
      ...incoming,
      source: current.source,
      staging: current.staging,
      nodes: Array.from(nodeMap.values()),
      edges,
    }
    delete nextGraph.sourceText
    return this.saveGraph(nextGraph, {
      sourceText: current.sourceText,
      expectedRevision,
      kind: text(options.kind, 'ui_patch'),
    })
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
