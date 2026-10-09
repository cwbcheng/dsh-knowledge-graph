import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { getOntology, ontologyIdOf, rawProfiles, withManualModels } from './kg-ontology.mjs'
import { createImageNodeTools } from './kg-image-nodes.mjs'
import { createModelStructureTools, createModelConsumptionTools } from './kg-model-structure.mjs'
import { createTargetMapTools } from './kg-target-map.mjs'

const imageNodeTools = createImageNodeTools()
const modelStructureTools = createModelStructureTools()
const modelConsumptionTools = createModelConsumptionTools(modelStructureTools)
const targetMapTools = createTargetMapTools()

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
CREATE TABLE IF NOT EXISTS document_units (
  document_id TEXT NOT NULL,
  paragraph INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (document_id, paragraph),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_units_document_idx ON document_units(document_id, paragraph);
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
  attributes_json TEXT NOT NULL DEFAULT '{}',
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
CREATE INDEX IF NOT EXISTS graph_nodes_type_idx ON graph_nodes(document_id, type, paragraph, node_id);
CREATE INDEX IF NOT EXISTS graph_nodes_section_idx ON graph_nodes(document_id, section_id, paragraph, node_id);
CREATE INDEX IF NOT EXISTS graph_nodes_status_idx ON graph_nodes(document_id, grounding_status, entailment_status, node_id);
CREATE TABLE IF NOT EXISTS graph_edges (
  edge_key TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  from_node_id TEXT NOT NULL,
  to_node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  attributes_json TEXT NOT NULL DEFAULT '{}',
  chunk_id TEXT,
  state TEXT NOT NULL DEFAULT 'candidate',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (document_id, from_node_id, to_node_id, relation),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS graph_edges_document_idx ON graph_edges(document_id);
CREATE INDEX IF NOT EXISTS graph_edges_from_idx ON graph_edges(document_id, from_node_id, relation, to_node_id);
CREATE INDEX IF NOT EXISTS graph_edges_to_idx ON graph_edges(document_id, to_node_id, relation, from_node_id);
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
CREATE TABLE IF NOT EXISTS relation_retry_checkpoints (
  document_id TEXT PRIMARY KEY,
  base_revision INTEGER NOT NULL,
  binding TEXT NOT NULL,
  checkpoint_version INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  checkpoint_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS verification_batch_results (
  run_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, batch_index),
  FOREIGN KEY (run_id) REFERENCES extraction_runs(run_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS verification_batch_reuse_idx
  ON verification_batch_results(json_extract(result_json, '$.reuse.inputHash'), created_at DESC)
  WHERE json_extract(result_json, '$.reuse.version') = 1;
CREATE TABLE IF NOT EXISTS graph_revisions (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  parent_revision INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'extract',
  summary_json TEXT NOT NULL DEFAULT '{}',
  snapshot_json TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, revision),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS graph_revisions_document_idx ON graph_revisions(document_id, revision DESC);
CREATE TABLE IF NOT EXISTS document_perspectives (
  perspective_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS document_perspectives_document_idx ON document_perspectives(document_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS image_reviews (
  document_id TEXT NOT NULL,
  image_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'matched', 'needs_correction')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (document_id, image_id),
  FOREIGN KEY (document_id) REFERENCES documents(document_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS concept_dossiers (
  dossier_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  anchor_document_id TEXT NOT NULL,
  anchor_node_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS concept_dossier_members (
  dossier_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  applicability TEXT NOT NULL DEFAULT '',
  valid_time TEXT NOT NULL DEFAULT '',
  reference_json TEXT NOT NULL DEFAULT '{}',
  bound_revision INTEGER NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (dossier_id, document_id, node_id),
  FOREIGN KEY (dossier_id) REFERENCES concept_dossiers(dossier_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS concept_dossier_members_document_idx ON concept_dossier_members(document_id, dossier_id);
CREATE INDEX IF NOT EXISTS graph_nodes_concept_lookup_idx ON graph_nodes(type, text COLLATE NOCASE, document_id);
CREATE TABLE IF NOT EXISTS learning_attempts (
  attempt_id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  base_revision INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  task_kind TEXT NOT NULL,
  task_json TEXT NOT NULL,
  answer TEXT NOT NULL,
  scenario TEXT NOT NULL DEFAULT '',
  self_rating TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS learning_attempts_document_idx ON learning_attempts(document_id, created_at DESC);
`

const ENTITY_TYPES = new Set(['concept', 'definition'])
const CLAIM_TYPES = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])
const CANDIDATE_STATUSES = new Set(['candidate', 'accepted', 'rejected'])
const NODE_ATTRIBUTES = new Set(Object.values(rawProfiles()).flatMap((profile) => profile.nodeAttributes || []))
const EDGE_ATTRIBUTES = new Set(Object.values(rawProfiles()).flatMap((profile) => profile.edgeAttributes || []))

// A completed review is recoverable only until its report has been committed.
// Current and historical revisions are atomic publication evidence, even after
// another report replaces it or the reader restores a pre-review revision.
const INCOMPLETE_RUN_PREDICATE = `run.status IN ('running', 'failed', 'paused')
  OR (run.status = 'succeeded' AND run.document_id IS NOT NULL
    AND json_extract(run.checkpoint_json, '$.taskKind') = 'verify'
    AND json_type(run.checkpoint_json, '$.report.reportId') = 'text'
    AND (SELECT json_extract(graph_meta_json, '$.verification.lastReport.reportId')
      FROM documents WHERE document_id = run.document_id)
      IS NOT json_extract(run.checkpoint_json, '$.report.reportId')
    AND NOT EXISTS (SELECT 1 FROM graph_revisions AS history
      WHERE history.document_id = run.document_id AND history.snapshot_json IS NOT NULL
        AND json_extract(history.snapshot_json, '$.graph.verification.lastReport.reportId')
          = json_extract(run.checkpoint_json, '$.report.reportId')))`

function stableHash(value) {
  return createHash('sha256').update(String(value == null ? '' : value)).digest('hex').slice(0, 32)
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function int(value, fallback = 0) {
  return Number.isInteger(value) ? value : fallback
}

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : '')
    return parsed == null ? fallback : parsed
  } catch (e) {
    return fallback
  }
}

function perspectiveInputError(message) {
  return Object.assign(new Error(message), { code: 'invalid_input' })
}

function perspectiveString(value, max, label, fallback = '') {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > max) throw perspectiveInputError(label + '无效')
  return value
}

function perspectiveKeys(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw perspectiveInputError(label + '包含不支持的字段')
  }
}

function normalizePerspectiveState(state) {
  perspectiveKeys(state, ['tab', 'query', 'filters', 'chapterId', 'layout', 'focusNodeId', 'gather', 'reading', 'sourceParagraph'], '视图')
  const filters = state.filters === undefined ? {} : state.filters
  perspectiveKeys(filters, ['type', 'relation', 'section', 'grounding', 'entailment'], '筛选')
  const tab = perspectiveString(state.tab, 10, '视图类型', 'search')
  const layout = perspectiveString(state.layout, 16, '布局', 'layered')
  if (!['search', 'answer'].includes(tab) || !['force', 'circular', 'radial', 'layered'].includes(layout)) throw perspectiveInputError('视图模式无效')
  const focusNodeId = state.focusNodeId == null ? null : perspectiveString(state.focusNodeId, 160, '焦点节点')
  let gather = null
  if (state.gather != null) {
    perspectiveKeys(state.gather, ['centerId', 'direction', 'relation', 'hops'], '聚拢状态')
    const direction = perspectiveString(state.gather.direction, 8, '聚拢方向', 'both')
    if (!['both', 'in', 'out'].includes(direction) || !Number.isInteger(state.gather.hops) || state.gather.hops < 1 || state.gather.hops > 5) {
      throw perspectiveInputError('聚拢参数无效')
    }
    gather = { centerId: perspectiveString(state.gather.centerId, 160, '聚拢中心'), direction,
      relation: perspectiveString(state.gather.relation, 80, '聚拢关系'), hops: state.gather.hops }
    if (!gather.centerId) throw perspectiveInputError('聚拢中心不能为空')
  }
  const reading = state.reading === undefined ? {} : state.reading
  perspectiveKeys(reading, ['open', 'topicId', 'themeId', 'offset', 'themeOffset'], '阅读位置')
  const count = (value, label) => {
    if (value === undefined) return 0
    if (!Number.isInteger(value) || value < 0 || value > 1000000) throw perspectiveInputError(label + '无效')
    return value
  }
  if (reading.open !== undefined && typeof reading.open !== 'boolean') throw perspectiveInputError('阅读状态无效')
  const sourceParagraph = state.sourceParagraph == null ? null : count(state.sourceParagraph, '原文位置')
  return { tab, query: perspectiveString(state.query, 600, '检索词'),
    filters: { type: perspectiveString(filters.type, 80, '节点类型', 'all'),
      relation: perspectiveString(filters.relation, 80, '关系上下文', 'all'),
      section: perspectiveString(filters.section, 160, '章节', 'all'),
      grounding: perspectiveString(filters.grounding, 32, '证据状态', 'all'),
      entailment: perspectiveString(filters.entailment, 32, '语义状态', 'all') },
    chapterId: perspectiveString(state.chapterId, 160, '章节', 'all'), layout, focusNodeId, gather,
    reading: { open: reading.open === true, topicId: perspectiveString(reading.topicId, 160, '阅读章节'),
      themeId: perspectiveString(reading.themeId, 160, '阅读线索'), offset: count(reading.offset, '阅读页码'),
      themeOffset: count(reading.themeOffset, '线索页码') }, sourceParagraph }
}

function normalizeStatus(value) {
  return CANDIDATE_STATUSES.has(value) ? value : 'candidate'
}

function edgeIdentity(edge) {
  return edge && typeof edge === 'object'
    ? String(edge.fromNodeId || '') + '>' + String(edge.toNodeId || '') + ':' + String(edge.relation || '')
    : ''
}

function declaredAttributes(value, allowed) {
  const attributes = {}
  for (const key of allowed || []) {
    const item = value?.[key]
    if (typeof item === 'string' && item.trim()) attributes[key] = item.trim().slice(0, 64)
    else if (typeof item === 'number' && Number.isFinite(item)) attributes[key] = item
  }
  return attributes
}

function nodeFromRow(node) {
  const attributes = parseJson(node.attributes_json, {})
  return {
    ...declaredAttributes(attributes, NODE_ATTRIBUTES),
    ...(attributes.modelStructure ? { modelStructure: attributes.modelStructure } : {}),
    ...(['main', 'source_context'].includes(attributes.contentLayer) ? { contentLayer: attributes.contentLayer } : {}),
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
    ...declaredAttributes(parseJson(edge.attributes_json, {}), EDGE_ATTRIBUTES),
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

function consumeEvidenceProjection(value) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!item || typeof item !== 'object') continue
    const paragraph = Number(item.paragraph)
    const quote = text(item.quote).trim().slice(0, 600)
    if (!Number.isInteger(paragraph) || paragraph < 0 || !quote) continue
    out.push({
      documentId: typeof item.documentId === 'string' ? item.documentId : null,
      sourceId: typeof item.sourceId === 'string' ? item.sourceId : null,
      chunkId: typeof item.chunkId === 'string' ? item.chunkId : null,
      paragraph,
      quote,
    })
    if (out.length >= 2) break
  }
  return out
}

function consumeNodeFromRow(node) {
  return {
    ...declaredAttributes(parseJson(node.attributes_json, {}), NODE_ATTRIBUTES),
    id: text(node.node_id),
    type: text(node.type).slice(0, 40),
    text: text(node.text).slice(0, 1200),
    quote: text(node.quote).slice(0, 600),
    paragraph: Number.isInteger(node.paragraph) ? node.paragraph : null,
    evidence: consumeEvidenceProjection(parseJson(node.evidence_json, [])),
    documentId: typeof node.document_id === 'string' ? node.document_id : null,
    sourceId: typeof node.source_id === 'string' ? node.source_id : null,
    chunkId: typeof node.chunk_id === 'string' ? node.chunk_id : null,
    sectionId: typeof node.section_id === 'string' ? node.section_id : null,
    sectionTitle: typeof node.section_title === 'string' ? node.section_title.slice(0, 300) : null,
    groundingStatus: text(node.grounding_status, 'candidate'),
    entailmentStatus: text(node.entailment_status, 'unverified'),
    state: text(node.state, 'candidate'),
  }
}

function consumeEdgeFromRow(edge) {
  return {
    ...declaredAttributes(parseJson(edge.attributes_json, {}), EDGE_ATTRIBUTES),
    fromNodeId: text(edge.from_node_id),
    toNodeId: text(edge.to_node_id),
    relation: text(edge.relation).slice(0, 40),
    evidence: consumeEvidenceProjection(parseJson(edge.evidence_json, [])),
    documentId: typeof edge.document_id === 'string' ? edge.document_id : null,
    sourceId: typeof edge.source_id === 'string' ? edge.source_id : null,
    chunkId: typeof edge.chunk_id === 'string' ? edge.chunk_id : null,
    state: text(edge.state, 'candidate'),
  }
}

function consumeSourceProjection(value, row, revision) {
  const raw = value && typeof value === 'object' ? value : {}
  const sections = []
  for (const item of Array.isArray(raw.sections) ? raw.sections : []) {
    if (!item || typeof item !== 'object') continue
    sections.push({
      id: typeof item.id === 'string' ? item.id : '',
      title: typeof item.title === 'string' ? item.title.slice(0, 300) : '',
      startParagraph: Number.isInteger(Number(item.startParagraph)) ? Number(item.startParagraph) : null,
      endParagraph: Number.isInteger(Number(item.endParagraph)) ? Number(item.endParagraph) : null,
    })
    if (sections.length >= 80) break
  }
  return {
    id: typeof raw.id === 'string' ? raw.id : null,
    documentId: row.document_id,
    title: typeof raw.title === 'string' ? raw.title.slice(0, 300) : '',
    chars: Number.isFinite(Number(raw.chars)) ? Number(raw.chars) : 0,
    paragraphCount: Number.isFinite(Number(raw.paragraphCount)) ? Number(raw.paragraphCount) : 0,
    chunkCount: Number.isFinite(Number(raw.chunkCount)) ? Number(raw.chunkCount) : 0,
    sectionCount: Number.isFinite(Number(raw.sectionCount)) ? Number(raw.sectionCount) : sections.length,
    sections,
    revision,
  }
}

function boundConsumeGraph(nodes, edges, directIds) {
  const direct = directIds instanceof Set ? directIds : new Set()
  const orderedNodes = [
    ...nodes.filter((node) => direct.has(node.id)),
    ...nodes.filter((node) => !direct.has(node.id)),
  ]
  const keptNodes = []
  const keptIds = new Set()
  let contextChars = 0
  const nodeBudget = Math.floor(CONSUME_CONTEXT_CHARS * 0.62)
  for (const node of orderedNodes) {
    const size = JSON.stringify(node).length
    // Opaque identities cannot be clipped to fit or bypass the response cap.
    if (direct.has(node.id) && contextChars + size > CONSUME_CONTEXT_CHARS) {
      throw Object.assign(new Error('指定节点的完整身份与记录超过检索预算，请缩小范围'), { code: 'limit_exceeded' })
    }
    if (!direct.has(node.id) && contextChars + size > nodeBudget) continue
    keptNodes.push(node)
    keptIds.add(node.id)
    contextChars += size
  }
  const orderedEdges = [
    ...edges.filter((edge) => direct.has(edge.fromNodeId) || direct.has(edge.toNodeId)),
    ...edges.filter((edge) => !direct.has(edge.fromNodeId) && !direct.has(edge.toNodeId)),
  ]
  const keptEdges = []
  for (const edge of orderedEdges) {
    if (!keptIds.has(edge.fromNodeId) || !keptIds.has(edge.toNodeId)) continue
    const size = JSON.stringify(edge).length
    if (contextChars + size > CONSUME_CONTEXT_CHARS) continue
    keptEdges.push(edge)
    contextChars += size
  }
  return {
    nodes: keptNodes,
    edges: keptEdges,
    contextChars,
    truncated: keptNodes.length < nodes.length || keptEdges.length < edges.length,
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

const CONSUME_GROUNDING = new Set(['grounded', 'candidate', 'unsupported'])
const CONSUME_ENTAILMENT = new Set(['verified', 'unsupported', 'uncertain', 'unverified'])
const CONSUME_SOURCE_UNITS = 80
const CONSUME_SOURCE_CHARS = 24000
const CONSUME_CONTEXT_CHARS = 384000
const CONSUME_SOURCE_FALLBACK = 8
function validateConsumeOptions(options, profile) {
  const types = new Set([...profile.consumptionTypes, 'image'])
  const relations = new Set([...profile.relationTypes.map(relation => relation.id), 'visual_source', 'visual_reference'])
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
  for (const [field, allowed] of [['types', types], ['relations', relations],
    ['groundingStatuses', CONSUME_GROUNDING], ['entailmentStatuses', CONSUME_ENTAILMENT],
    ['nodeIds', null], ['sectionIds', null]]) {
    if (options[field] == null) continue
    if (!Array.isArray(options[field])) fail('invalid_input', field + ' 必须是数组')
    if (options[field].length > 40) fail('limit_exceeded', field + ' 最多允许 40 项')
    for (const item of options[field]) {
      if (typeof item !== 'string' || !item.trim() || (allowed && !allowed.has(item.trim()))) {
        fail('invalid_input', field + ' 包含不支持的值：' + String(item))
      }
    }
  }
  if (options.direction != null && !['both', 'in', 'out'].includes(options.direction)) {
    fail('invalid_input', 'direction 只能是 both、in 或 out')
  }
  return { types, relations }
}
function normalizeConsumeText(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ' ').trim()
}
function consumeTerms(value) {
  const normalized = normalizeConsumeText(value)
  const result = []
  const add = (term) => {
    const item = term.trim()
    if (item && !result.includes(item)) result.push(item)
  }
  add(normalized)
  for (const part of normalized.split(/\s+/)) {
    add(part)
    if (part.length >= 3 && /[^\x00-\x7f]/.test(part)) {
      for (let i = 0; i + 2 <= part.length && result.length < 14; i++) add(part.slice(i, i + 2))
    }
    if (result.length >= 14) break
  }
  return result.slice(0, 14)
}
function boundedConsumeList(value, allowed, limit = 40) {
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    const v = text(item).trim()
    if (!v || (allowed && !allowed.has(v)) || out.includes(v)) continue
    out.push(v)
    if (out.length >= limit) break
  }
  return out
}
function consumeScore(node, query, terms, explicitIds, queryRaw) {
  const id = normalizeConsumeText(node.node_id)
  const type = normalizeConsumeText(node.type)
  const body = normalizeConsumeText(node.text)
  const quote = normalizeConsumeText(node.quote)
  const section = normalizeConsumeText((node.section_title || '') + ' ' + (node.section_id || ''))
  let score = explicitIds.has(node.node_id) ? 1000 : 0
  const reasons = explicitIds.has(node.node_id) ? ['指定节点'] : []
  const modelMatch = node.type === 'connection_model'
    ? modelConsumptionTools.matchFields(parseJson(node.attributes_json, {}).modelStructure, queryRaw) : null
  if (modelMatch) { score += modelMatch.score; reasons.push(...modelMatch.reasons) }
  if (query) {
    if (id === query) { score += 120; reasons.push('节点 ID 精确匹配') }
    if (body === query) { score += 100; reasons.push('节点文本精确匹配') }
    else if (body.includes(query)) { score += 52; reasons.push('节点文本包含查询') }
    if (quote.includes(query)) { score += 30; reasons.push('原文摘录包含查询') }
    if (section.includes(query)) { score += 18; reasons.push('章节匹配') }
    if (type === query) { score += 12; reasons.push('节点类型匹配') }
    const haystack = id + ' ' + type + ' ' + body + ' ' + quote + ' ' + section
    let matched = 0
    for (const term of terms) if (term && haystack.includes(term)) matched += 1
    if (terms.length > 0 && matched > 0) {
      const coverage = matched / terms.length
      score += coverage * 38 + Math.min(matched, 8) * 2
      reasons.push('关键词覆盖 ' + Math.round(coverage * 100) + '%')
    }
  }
  if ((query || explicitIds.size > 0) && score === 0) return null
  if (!query && explicitIds.size === 0) score += 1
  if (node.grounding_status === 'grounded') score += 1.5
  if (node.entailment_status === 'verified') score += 1
  return score > 0 ? { score: Math.round(score * 100) / 100, reasons,
    ...(modelMatch ? { modelFieldMatches: modelMatch.fieldMatches } : {}) } : null
}
function consumeSourceScore(value, query, terms) {
  const normalized = normalizeConsumeText(value)
  if (!normalized) return 0
  let score = query && normalized.includes(query) ? 100 : 0
  let hits = 0
  for (const term of terms) if (term && normalized.includes(term)) hits += 1
  if (hits > 0) score += (hits / Math.max(1, terms.length)) * 40 + hits * 2
  return Math.round(score * 100) / 100
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
    throw new Error('SQLite persistence requires a Node runtime with node:sqlite (Node 22.13+): ' + message)
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
  #windowStructureCache = null

  constructor(db, filename) {
    this.db = db
    this.filename = filename
    // Fresh connections otherwise fail immediately on brief independent locks.
    // Preserve an explicit caller timeout; never retry at the application layer.
    if (this.db.prepare('PRAGMA busy_timeout').get().timeout === 0) this.db.exec('PRAGMA busy_timeout = 2000')
    this.db.exec(SCHEMA)
    this.migrateChunkIdentitySchema()
    // CREATE TABLE IF NOT EXISTS does not add columns to databases created by
    // older releases. Keep migrations additive and deterministic.
    this.ensureColumn('documents', 'source_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('documents', 'graph_meta_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('documents', 'graph_revision', 'INTEGER NOT NULL DEFAULT 0')
    this.ensureColumn('graph_revisions', 'snapshot_json', 'TEXT')
    this.db.exec(`CREATE INDEX IF NOT EXISTS verification_report_history_idx
      ON graph_revisions(document_id, json_extract(snapshot_json, '$.graph.verification.lastReport.reportId'))
      WHERE snapshot_json IS NOT NULL`)
    this.ensureColumn('graph_nodes', 'grounding_status', "TEXT NOT NULL DEFAULT 'candidate'")
    this.ensureColumn('graph_nodes', 'entailment_status', "TEXT NOT NULL DEFAULT 'unverified'")
    this.ensureColumn('graph_nodes', 'attributes_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('graph_edges', 'attributes_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('extraction_runs', 'title', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('extraction_runs', 'source_text', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('extraction_runs', 'error_code', 'TEXT')
    this.ensureColumn('extraction_runs', 'error_message', 'TEXT')
    this.ensureColumn('concept_dossier_members', 'applicability', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('concept_dossier_members', 'valid_time', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('concept_dossier_members', 'reference_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('learning_attempts', 'model_id', "TEXT NOT NULL DEFAULT ''")
    this.ensureColumn('learning_attempts', 'response_json', "TEXT NOT NULL DEFAULT '{}'")
    this.ensureColumn('learning_attempts', 'revealed_at', 'INTEGER')
    this.ensureColumn('learning_attempts', 'review_json', 'TEXT')
    this.ensureColumn('learning_attempts', 'attempt_version', 'INTEGER NOT NULL DEFAULT 1')
    this.db.exec(`CREATE INDEX IF NOT EXISTS learning_attempts_model_idx
      ON learning_attempts(document_id, model_id, created_at DESC, attempt_id DESC)`)
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
    this.#windowStructureCache = null
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
    if ((graph.nodes || []).some(node => node?.type === 'image')
      || (graph.edges || []).some(edge => ['visual_source', 'visual_reference'].includes(edge?.relation))) graph = imageNodeTools.materialize(graph)
    const sourceInput = graph.source && typeof graph.source === 'object' ? graph.source : {}
    let nodes = hasNodes ? graph.nodes.slice() : []
    let edges = hasEdges ? graph.edges.slice() : []
    const profile = withManualModels(getOntology(ontologyIdOf(graph)))
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
    const hasSourceUnits = Array.isArray(options.sourceUnits)
    const sourceUnits = []
    if (hasSourceUnits) {
      for (let index = 0; index < options.sourceUnits.length; index++) {
        const raw = options.sourceUnits[index]
        const paragraph = raw && typeof raw === 'object' && Number.isInteger(raw.paragraph) ? raw.paragraph : index
        const unitText = typeof raw === 'string' ? raw : text(raw && raw.text)
        if (!Number.isInteger(paragraph) || paragraph < 0 || !unitText.trim()) continue
        sourceUnits.push({ paragraph, text: unitText.trim() })
      }
    }
    const graphMeta = {
      summary: text(graph.summary),
      warnings: Array.isArray(graph.warnings) ? graph.warnings : [],
      ...(graph.generation && typeof graph.generation === 'object' ? { generation: graph.generation } : {}),
      ...(typeof graph.traceText === 'string' ? { traceText: graph.traceText } : {}),
      ...(Array.isArray(graph.traceEvents) ? { traceEvents: graph.traceEvents } : {}),
      ...(graph.verification && typeof graph.verification === 'object' ? { verification: graph.verification } : {}),
      ...(graph.factCheck && typeof graph.factCheck === 'object' ? { factCheck: graph.factCheck } : {}),
      // The ontology a graph was extracted with is a property of the document.
      // Persisting it here (rather than adding a column) means a re-opened
      // document keeps its profile, and an append can refuse to mix ontologies.
      ...(typeof graph.ontology === 'string' && graph.ontology ? { ontology: graph.ontology } : {}),
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
      const current = this.db.prepare('SELECT graph_revision, source_text FROM documents WHERE document_id = ?').get(documentId)
      const currentRevision = current && Number.isInteger(current.graph_revision) ? current.graph_revision : 0
      if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== currentRevision) {
        const error = new Error('graph revision conflict: expected ' + options.expectedRevision + ', current ' + currentRevision)
        error.code = 'revision_conflict'
        error.currentRevision = currentRevision
        throw error
      }
      // Older projections cannot silently erase a reviewed model structure.
      const previousStructures = new Map(this.db.prepare("SELECT node_id, attributes_json FROM graph_nodes WHERE document_id = ? AND json_type(attributes_json, '$.modelStructure') = 'object'").all(documentId)
        .map(row => [row.node_id, parseJson(row.attributes_json, {}).modelStructure]))
      for (let index = 0; index < nodes.length; index++) {
        if (!Object.hasOwn(nodes[index], 'modelStructure') && previousStructures.get(nodes[index].id)) {
          nodes[index] = { ...nodes[index], modelStructure: previousStructures.get(nodes[index].id) }
        }
      }
      const structureUnits = new Map((hasSourceUnits ? sourceUnits : current && text(current.source_text) === sourceText
        ? this.getDocumentSourceUnits(documentId) : []).map(unit => [unit.paragraph, unit.text]))
      if (graph.source?.visualSource?.textReferences?.length) {
        const projected = imageNodeTools.materialize({ ...graph, nodes, edges }, structureUnits)
        nodes = projected.nodes; edges = projected.edges
      }
      const structureErrors = nodes.some(node => node.modelStructure != null) ? modelStructureTools.errors({ ...graph, nodes }, structureUnits) : []
      if (structureErrors.length) throw Object.assign(new Error(structureErrors[0].message), { code: 'invalid_model_structure' })
      // Keep the overwritten graph and source units in the same transaction.
      // Older revisions without snapshots remain explicitly non-restorable.
      if (currentRevision > 0) {
        const snapshot = {
          graph: this.getDocument(documentId),
          sourceUnits: this.db.prepare('SELECT paragraph, text FROM document_units WHERE document_id = ? ORDER BY paragraph').all(documentId),
        }
        this.db.prepare('UPDATE graph_revisions SET snapshot_json = ? WHERE document_id = ? AND revision = ?')
          .run(JSON.stringify(snapshot), documentId, currentRevision)
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
      `).run(documentId, sourceId, title, source.chars, source.paragraphCount, source.chunkCount, source.sectionCount, JSON.stringify(source), sourceText, JSON.stringify(graphMeta), revision, now, now)
      if (hasSourceUnits) {
        this.db.prepare('DELETE FROM document_units WHERE document_id = ?').run(documentId)
        const unitStmt = this.db.prepare('INSERT INTO document_units (document_id, paragraph, text) VALUES (?, ?, ?)')
        for (const unit of sourceUnits) unitStmt.run(documentId, unit.paragraph, unit.text)
      } else if (current && text(current.source_text) !== sourceText) {
        // Never retain paragraph text from an older source version. Legacy
        // callers without structured units keep evidence quotes as a safe
        // fallback until the document is next extracted with sourceUnits.
        this.db.prepare('DELETE FROM document_units WHERE document_id = ?').run(documentId)
      }

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
          JSON.stringify(Array.isArray(chunk.sectionIds) ? chunk.sectionIds : []),
          JSON.stringify(Array.isArray(chunk.sectionTitles) ? chunk.sectionTitles : []),
          text(chunk.summary),
          text(chunk.status, 'completed'),
          JSON.stringify(Array.isArray(chunk.nodeIds) ? chunk.nodeIds : []),
          int(chunk.edgeCount, 0),
          JSON.stringify(Array.isArray(chunk.warnings) ? chunk.warnings : []),
          JSON.stringify(chunk),
          now,
        )
      }

      const nodeStmt = this.db.prepare(`
        INSERT INTO graph_nodes (node_key, document_id, source_id, node_id, type, text, quote, paragraph, evidence_json, attributes_json, chunk_id, section_id, section_title, grounding_status, entailment_status, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_key) DO UPDATE SET
          source_id = excluded.source_id,
          type = excluded.type,
          text = excluded.text,
          quote = excluded.quote,
          paragraph = excluded.paragraph,
          evidence_json = excluded.evidence_json,
          attributes_json = excluded.attributes_json,
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
          JSON.stringify(Array.isArray(node.evidence) ? node.evidence : []),
          JSON.stringify({ ...declaredAttributes(node, profile.nodeAttributes),
            ...(node.modelStructure ? { modelStructure: node.modelStructure } : {}),
            ...(['main', 'source_context'].includes(node.contentLayer) ? { contentLayer: node.contentLayer } : {}) }),
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
        INSERT INTO graph_edges (edge_key, document_id, source_id, from_node_id, to_node_id, relation, evidence_json, attributes_json, chunk_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(edge_key) DO UPDATE SET
          source_id = excluded.source_id,
          relation = excluded.relation,
          evidence_json = excluded.evidence_json,
          attributes_json = excluded.attributes_json,
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
          JSON.stringify(Array.isArray(edge.evidence) ? edge.evidence : []),
          JSON.stringify(declaredAttributes(edge, profile.edgeAttributes)),
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
            JSON.stringify(evidence),
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
            JSON.stringify(evidence),
            now,
            now,
          )
        }
      }
      this.db.prepare(`
        INSERT OR REPLACE INTO graph_revisions (document_id, revision, parent_revision, kind, summary_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(documentId, revision, Math.max(0, revision - 1), text(options.kind, 'extract'), JSON.stringify({ nodes: nodes.length, edges: edges.length, chunks: Array.isArray(staging.chunks) ? staging.chunks.length : 0 }), now)
      // Completion is part of the graph commit, not a second best-effort write.
      // A crash can expose either the recoverable run or its completed graph,
      // never a new graph with an obsolete, apparently unfinished checkpoint.
      if (options.completedRun) {
        const { checkpoint, runId, title, sourceText } = options.completedRun
        if (!text(runId).trim() || checkpoint?.documentId !== documentId || checkpoint?.sourceId !== sourceId || checkpoint?.baseRevision !== currentRevision) {
          throw Object.assign(new Error('Completed run does not match the graph commit'), { code: 'checkpoint_invalid' })
        }
        this.saveCheckpoint(checkpoint, { runId, title, sourceText, status: 'succeeded' })
      }
      if (options.completedRelationRetry) {
        const completed = options.completedRelationRetry
        const row = this.db.prepare('SELECT base_revision, binding, checkpoint_version FROM relation_retry_checkpoints WHERE document_id = ?').get(documentId)
        if (completed.documentId !== documentId || completed.baseRevision !== currentRevision ||
            !row || row.base_revision !== currentRevision || row.binding !== completed.binding ||
            row.checkpoint_version !== completed.checkpointVersion) {
          throw Object.assign(new Error('Relation recovery changed before canonical commit'), { code: 'checkpoint_conflict' })
        }
        // Deliberately inside THIS graph/source/revision transaction. A failed
        // clear rolls back the graph; a failed graph write retains paid leaves.
        this.db.prepare('DELETE FROM relation_retry_checkpoints WHERE document_id = ? AND base_revision = ? AND checkpoint_version = ?')
          .run(documentId, currentRevision, completed.checkpointVersion)
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
      revision,
    }
  }

  loadRelationRetryCheckpoint(documentId, expectedRevision) {
    if (!text(documentId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw Object.assign(new Error('Relation recovery read requires expectedRevision'), { code: 'checkpoint_invalid' })
    }
    // An independent snapshot authenticates the cursor and the record together;
    // reading recovery does not acquire or retain a canonical write transaction.
    return this.#readDocumentSnapshot(() => {
      const doc = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(documentId)
      if (!doc) throw Object.assign(new Error('Document not found'), { code: 'not_found' })
      if (doc.graph_revision !== expectedRevision) throw Object.assign(new Error('Document revision changed'), { code: 'revision_conflict', currentRevision: doc.graph_revision })
      const row = this.db.prepare('SELECT * FROM relation_retry_checkpoints WHERE document_id = ?').get(documentId)
      // A user edit leaves old recovery unactionable, never rolls the graph back.
      if (!row || row.base_revision !== expectedRevision) return null
      const hash = createHash('sha256').update(row.checkpoint_json, 'utf8').digest('hex')
      const checkpoint = parseJson(row.checkpoint_json, null)
      if (hash !== row.checkpoint_hash || checkpoint?.version !== 1 || checkpoint.documentId !== documentId ||
          checkpoint.baseRevision !== expectedRevision || checkpoint.binding !== row.binding) {
        throw Object.assign(new Error('Relation recovery record failed authentication'), { code: 'checkpoint_invalid' })
      }
      return { checkpoint, checkpointVersion: row.checkpoint_version, baseRevision: row.base_revision }
    })
  }

  saveRelationRetryCheckpoint(checkpoint, options = {}) {
    const expectedRevision = options.expectedRevision
    const expectedVersion = options.expectedVersion
    if (checkpoint?.version !== 1 || !text(checkpoint.documentId) ||
        !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || checkpoint.baseRevision !== expectedRevision ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !/^[a-f0-9]{64}$/.test(checkpoint.binding || '')) {
      throw Object.assign(new Error('Invalid relation recovery write binding'), { code: 'checkpoint_invalid' })
    }
    const json = JSON.stringify(checkpoint)
    const hash = createHash('sha256').update(json, 'utf8').digest('hex')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(checkpoint.documentId)
      if (!doc) throw Object.assign(new Error('Document not found'), { code: 'not_found' })
      if (doc.graph_revision !== expectedRevision) throw Object.assign(new Error('Document revision changed'), { code: 'revision_conflict', currentRevision: doc.graph_revision })
      const row = this.db.prepare('SELECT base_revision, binding, checkpoint_version FROM relation_retry_checkpoints WHERE document_id = ?').get(checkpoint.documentId)
      const sameRevision = row?.base_revision === expectedRevision
      const currentVersion = sameRevision ? row.checkpoint_version : 0
      if (currentVersion !== expectedVersion || (sameRevision && row.binding !== checkpoint.binding)) {
        throw Object.assign(new Error('Relation recovery was updated by another writer'), { code: 'checkpoint_conflict' })
      }
      const checkpointVersion = currentVersion + 1
      const now = Date.now()
      this.db.prepare(`INSERT INTO relation_retry_checkpoints
        (document_id, base_revision, binding, checkpoint_version, checkpoint_json, checkpoint_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET base_revision = excluded.base_revision, binding = excluded.binding,
          checkpoint_version = excluded.checkpoint_version, checkpoint_json = excluded.checkpoint_json,
          checkpoint_hash = excluded.checkpoint_hash, updated_at = excluded.updated_at`)
        .run(checkpoint.documentId, expectedRevision, checkpoint.binding, checkpointVersion, json, hash, now, now)
      this.db.exec('COMMIT')
      return { documentId: checkpoint.documentId, baseRevision: expectedRevision, checkpointVersion }
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch { /* Preserve the original CAS/write failure. */ }
      throw error
    }
  }

  saveCheckpoint(checkpoint, options = {}) {
    if (!checkpoint || typeof checkpoint !== 'object') throw new Error('checkpoint must be an object')
    const runId = text(options.runId || checkpoint.runId) || 'run_' + stableHash(JSON.stringify(checkpoint))
    const now = Date.now()
    const status = text(options.status || checkpoint.status, 'running')
    const documentId = text(checkpoint.documentId || options.documentId) || null
    const sourceId = text(checkpoint.sourceId || options.sourceId) || null
    const nextBatchIndex = checkpoint.taskKind === 'verify'
      ? this.db.prepare('SELECT COUNT(*) AS count FROM verification_batch_results WHERE run_id = ?').get(runId).count
      : int(checkpoint.nextBatchIndex, 0)
    const savedCheckpoint = checkpoint.taskKind === 'verify' ? { ...checkpoint, nextBatchIndex } : checkpoint
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
    `).run(runId, documentId, sourceId, status, nextBatchIndex, totalBatches, JSON.stringify(savedCheckpoint), title, sourceText, errorCode, errorMessage, now, now)
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

  saveVerificationBatch(runId, batchIndex, result, inputHash) {
    if (typeof runId !== 'string' || !runId || !Number.isInteger(batchIndex) || batchIndex < 0 ||
      !result || !Array.isArray(result.issues) || !Array.isArray(result.warnings) || typeof inputHash !== 'string') {
      throw Object.assign(new Error('审校批次记录无效'), { code: 'checkpoint_invalid' })
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const run = this.db.prepare('SELECT status, total_batches, checkpoint_json FROM extraction_runs WHERE run_id = ?').get(runId)
      const checkpoint = run ? parseJson(run.checkpoint_json, {}) : null
      if (!run || run.status !== 'running' || checkpoint?.taskKind !== 'verify' || checkpoint.inputHash !== inputHash || batchIndex >= run.total_batches) {
        throw Object.assign(new Error('审校任务状态或输入已变化，拒绝保存批次'), { code: 'checkpoint_invalid' })
      }
      const json = JSON.stringify(result)
      const existing = this.db.prepare('SELECT result_json FROM verification_batch_results WHERE run_id = ? AND batch_index = ?').get(runId, batchIndex)
      if (existing && existing.result_json !== json) throw Object.assign(new Error('审校批次已保存不同结果'), { code: 'checkpoint_invalid' })
      if (!existing) this.db.prepare('INSERT INTO verification_batch_results (run_id, batch_index, result_json, created_at) VALUES (?, ?, ?, ?)').run(runId, batchIndex, json, Date.now())
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM verification_batch_results WHERE run_id = ?').get(runId).count
      this.db.prepare('UPDATE extraction_runs SET next_batch_index = ?, updated_at = ? WHERE run_id = ?').run(count, Date.now(), runId)
      this.db.exec('COMMIT')
      return count
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  loadVerificationBatches(runId) {
    return this.db.prepare('SELECT batch_index AS batchIndex, result_json AS resultJson FROM verification_batch_results WHERE run_id = ? ORDER BY batch_index')
      .all(runId).map(row => ({ batchIndex: row.batchIndex, result: parseJson(row.resultJson, null) }))
  }

  loadReusableVerificationBatch(documentId, inputHash) {
    if (!text(documentId) || !/^[a-f0-9]{64}$/.test(inputHash)) return null
    const row = this.db.prepare(`SELECT b.batch_index AS batchIndex, b.result_json AS resultJson,
      b.run_id AS runId, json_extract(r.checkpoint_json, '$.baseRevision') AS revision
      FROM verification_batch_results b JOIN extraction_runs r ON r.run_id = b.run_id
      WHERE r.document_id = ? AND json_extract(b.result_json, '$.reuse.inputHash') = ?
        AND json_extract(b.result_json, '$.reuse.version') = 1
      ORDER BY b.created_at DESC, b.rowid DESC LIMIT 1`).get(documentId, inputHash)
    return row ? { runId: row.runId, batchIndex: row.batchIndex, revision: row.revision,
      result: parseJson(row.resultJson, null) } : null
  }

  listIncompleteRuns(limit = 50) {
    return this.db.prepare(`SELECT run_id AS runId, document_id AS documentId,
      title, status, next_batch_index AS nextBatchIndex, total_batches AS totalBatches,
      json_extract(checkpoint_json, '$.taskKind') AS taskKind,
      json_extract(checkpoint_json, '$.model.provider') AS modelProvider,
      json_extract(checkpoint_json, '$.model.model') AS modelId,
      error_code AS errorCode, updated_at AS updatedAt,
      (SELECT count(*) FROM json_each(checkpoint_json, '$.pendingWave.results') WHERE coalesce(json_extract(value, '$.stage'), 'complete') != 'coverage_pending') AS bufferedBatches,
      (SELECT count(*) FROM json_each(checkpoint_json, '$.pendingWave.results') WHERE json_extract(value, '$.stage') = 'coverage_pending') AS preparedBatches,
      json_extract(checkpoint_json, '$.postprocess.reviewSummary.reviewed') AS reviewedRelations,
      json_extract(checkpoint_json, '$.postprocess.reviewSummary.eligible') AS totalRelations,
      CASE WHEN json_extract(checkpoint_json, '$.relationWeave.version') = 3
        THEN (SELECT count(*) FROM json_each(checkpoint_json, '$.relationWeave.batches') AS batch,
          json_each(batch.value, '$.journal.results'))
        ELSE (SELECT count(*) FROM json_each(checkpoint_json, '$.relationWeave.results')) END AS savedRelationGroups,
      CASE WHEN json_extract(checkpoint_json, '$.relationWeave.version') = 3
        THEN (SELECT coalesce(sum(json_extract(batch.value, '$.journal.totalGroups')), 0)
          FROM json_each(checkpoint_json, '$.relationWeave.batches') AS batch)
        ELSE json_extract(checkpoint_json, '$.relationWeave.totalGroups') END AS totalRelationGroups
      FROM extraction_runs AS run WHERE ${INCOMPLETE_RUN_PREDICATE}
      ORDER BY updated_at DESC LIMIT ?`).all(Math.max(1, Math.min(100, int(limit, 50))))
  }

  deleteIncompleteRun(runId, expectedUpdatedAt) {
    if (typeof runId !== 'string' || !runId.trim() || runId.length > 200 || !Number.isSafeInteger(expectedUpdatedAt) || expectedUpdatedAt < 0) {
      throw Object.assign(new Error('任务标识或更新时间无效'), { code: 'invalid_input' })
    }
    const result = this.db.prepare(`DELETE FROM extraction_runs AS run WHERE run_id = ? AND updated_at = ?
      AND (${INCOMPLETE_RUN_PREDICATE})`).run(runId, expectedUpdatedAt)
    if (result.changes) return { deleted: true, runId }
    const row = this.db.prepare('SELECT status FROM extraction_runs WHERE run_id = ?').get(runId)
    if (!row) return { deleted: false, runId }
    throw Object.assign(new Error('任务已更新或不再是未完成任务，请刷新列表后重试'), { code: 'run_conflict' })
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

  conceptReference(documentId, nodeId) {
    const row = this.db.prepare(`SELECT n.*, d.title AS document_title, d.source_json, d.graph_revision
      FROM graph_nodes n JOIN documents d ON d.document_id = n.document_id
      WHERE n.document_id = ? AND n.node_id = ? AND n.type IN ('concept', 'definition')`).get(documentId, nodeId)
    if (!row) return null
    const source = parseJson(row.source_json, {})
    const evidence = parseJson(row.evidence_json, [])
    const unitAt = this.db.prepare('SELECT text FROM document_units WHERE document_id = ? AND paragraph = ?')
    let verifiedQuote = ''
    let evidenceParagraph = null
    let sourceParagraphText = ''
    let sourceParagraphTruncated = false
    const recordUnit = (unitText, quote, paragraph) => {
      verifiedQuote = quote
      evidenceParagraph = paragraph
      const matchStart = unitText.indexOf(quote)
      let start = Math.max(0, matchStart - 1000)
      if (matchStart + quote.length > start + 20000) start = matchStart + quote.length - 20000
      const end = Math.min(unitText.length, start + 20000)
      sourceParagraphText = unitText.slice(start, end)
      sourceParagraphTruncated = start > 0 || end < unitText.length
    }
    if (Array.isArray(evidence)) {
      for (const item of evidence) {
        if (item?.documentId !== documentId || item?.sourceId !== row.source_id ||
            !Number.isInteger(item.paragraph) || item.paragraph < 0 || typeof item.quote !== 'string') continue
        const quote = item.quote.trim()
        const unitText = quote && unitAt.get(documentId, item.paragraph)?.text
        if (!quote || !unitText?.includes(quote)) continue
        recordUnit(unitText, quote, item.paragraph)
        break
      }
      if (!verifiedQuote && evidence.length === 0 && Number.isInteger(row.paragraph) && row.quote.trim()) {
        const unitText = unitAt.get(documentId, row.paragraph)?.text
        if (unitText?.includes(row.quote.trim())) recordUnit(unitText, row.quote.trim(), row.paragraph)
      }
    }
    return { documentId, nodeId, type: row.type, text: row.text, paragraph: row.paragraph,
      source: { title: row.document_title, author: text(source.author).slice(0, 200),
        publicationDate: text(source.publicationDate || source.date).slice(0, 100) },
      quote: verifiedQuote, evidenceParagraph, sourceParagraphText, sourceParagraphTruncated,
      evidenceStatus: verifiedQuote ? 'source_quote_matched' : 'unverified',
      attributionStatus: text(row.entailment_status, 'unverified'), realWorldTruth: 'not_assessed',
      revision: row.graph_revision }
  }

  searchConceptCandidates({ documentId, nodeId, query, limit = 30 } = {}) {
    const anchor = this.conceptReference(documentId, nodeId)
    if (!anchor) throw Object.assign(new Error('找不到概念节点'), { code: 'not_found' })
    if (query !== undefined && (typeof query !== 'string' || query.length > 80)) {
      throw Object.assign(new Error('概念检索词无效'), { code: 'invalid_input' })
    }
    const searched = typeof query === 'string' && !!query.trim()
    const term = searched ? query.trim() : anchor.text
    const rows = this.db.prepare(`SELECT document_id, node_id FROM graph_nodes
      WHERE type IN ('concept', 'definition') AND ${searched ? 'instr(lower(text), lower(?)) > 0' : 'text = ? COLLATE NOCASE'}
      AND document_id <> ? ORDER BY document_id, node_id LIMIT ?`)
      .all(term, documentId, Math.max(1, Math.min(100, int(limit, 30))))
    return { anchor, candidates: rows.map(row => this.conceptReference(row.document_id, row.node_id)),
      matchRule: searched ? 'user_search_candidate_only' : 'same_label_candidate_only' }
  }

  listConceptDossiers(documentId) {
    return this.db.prepare(`SELECT DISTINCT d.dossier_id AS id, d.title, d.anchor_document_id AS anchorDocumentId,
      d.anchor_node_id AS anchorNodeId, d.version, d.updated_at AS updatedAt
      FROM concept_dossiers d JOIN concept_dossier_members m ON m.dossier_id = d.dossier_id
      WHERE m.document_id = ? ORDER BY d.updated_at DESC, d.dossier_id LIMIT 100`).all(documentId)
  }

  getConceptDossier(id) {
    const row = this.db.prepare('SELECT * FROM concept_dossiers WHERE dossier_id = ?').get(id)
    if (!row) return null
    const members = this.db.prepare(`SELECT document_id, node_id, relation, note, applicability, valid_time,
      reference_json, bound_revision
      FROM concept_dossier_members WHERE dossier_id = ? ORDER BY position`).all(id).map(member => {
      const current = this.conceptReference(member.document_id, member.node_id)
      const savedReference = parseJson(member.reference_json, null)
      const confirmed = savedReference?.source && typeof savedReference.text === 'string' ? savedReference : null
      return { documentId: member.document_id, nodeId: member.node_id, relation: member.relation,
        note: member.note, noteOrigin: member.note ? 'user_annotation' : null,
        applicability: member.applicability, validTime: member.valid_time,
        applicabilityOrigin: member.applicability ? 'user_annotation' : null,
        validTimeOrigin: member.valid_time ? 'user_annotation' : null,
        boundRevision: member.bound_revision, stale: !current || current.revision !== member.bound_revision,
        confirmedReference: confirmed,
        ...(current || confirmed || { evidenceStatus: 'unverified', realWorldTruth: 'not_assessed' }),
        missing: !current }
    })
    return { id: row.dossier_id, title: row.title, anchor: { documentId: row.anchor_document_id,
      nodeId: row.anchor_node_id }, version: row.version, createdAt: row.created_at,
      updatedAt: row.updated_at, members }
  }

  saveConceptDossier(input) {
    const invalid = message => Object.assign(new Error(message), { code: 'invalid_input' })
    if (!input || typeof input !== 'object') throw invalid('档案内容无效')
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    const anchor = input.anchor
    if (!title || title.length > 100 || !anchor || typeof anchor.documentId !== 'string' ||
        typeof anchor.nodeId !== 'string' || !anchor.documentId || !anchor.nodeId ||
        !Array.isArray(input.members) || input.members.length > 19) throw invalid('档案标题、锚点或成员无效')
    const members = [{ documentId: anchor.documentId, nodeId: anchor.nodeId, relation: 'anchor', note: '',
      applicability: '', validTime: '' }]
    const seen = new Set([anchor.documentId + '\u0000' + anchor.nodeId])
    for (const member of input.members) {
      if (!member || typeof member.documentId !== 'string' || typeof member.nodeId !== 'string' ||
          !member.documentId || !member.nodeId || !['aligned', 'contrast', 'related'].includes(member.relation) ||
          typeof member.note !== 'string' || member.note.length > 500 ||
          typeof (member.applicability ?? '') !== 'string' || member.applicability?.length > 300 ||
          typeof (member.validTime ?? '') !== 'string' || member.validTime?.length > 100) {
        throw invalid('档案成员、适用条件或时间无效')
      }
      const key = member.documentId + '\u0000' + member.nodeId
      if (seen.has(key)) throw invalid('档案包含重复概念')
      seen.add(key); members.push({ ...member, applicability: member.applicability || '', validTime: member.validTime || '' })
    }
    const id = typeof input.id === 'string' && input.id ? input.id : randomUUID()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const old = this.db.prepare('SELECT * FROM concept_dossiers WHERE dossier_id = ?').get(id)
      if (old && (old.anchor_document_id !== anchor.documentId || old.anchor_node_id !== anchor.nodeId)) throw invalid('不能更改档案锚点')
      if (old && (!Number.isInteger(input.expectedVersion) || old.version !== input.expectedVersion)) {
        throw Object.assign(new Error('档案已被修改，请刷新'), { code: 'dossier_conflict' })
      }
      if (!old && input.id) throw Object.assign(new Error('找不到档案'), { code: 'not_found' })
      const revisions = input.expectedRevisions
      if (!revisions || typeof revisions !== 'object' || Array.isArray(revisions)) throw invalid('缺少知识图版本围栏')
      const bound = new Map()
      const references = new Map()
      for (const member of members) {
        const current = this.conceptReference(member.documentId, member.nodeId)
        if (!current) throw Object.assign(new Error('概念节点已不存在'), { code: 'not_found' })
        if (!Number.isInteger(revisions[member.documentId]) || revisions[member.documentId] !== current.revision) {
          throw Object.assign(new Error('知识图已变化，请重新比较'), { code: 'revision_conflict' })
        }
        bound.set(member.documentId, current.revision)
        references.set(member.documentId + '\u0000' + member.nodeId, {
          source: current.source, type: current.type, text: current.text, quote: current.quote,
          paragraph: current.paragraph, evidenceParagraph: current.evidenceParagraph,
          evidenceStatus: current.evidenceStatus, attributionStatus: current.attributionStatus,
          realWorldTruth: 'not_assessed', revision: current.revision,
        })
      }
      const now = Date.now()
      if (old) {
        this.db.prepare('UPDATE concept_dossiers SET title = ?, version = version + 1, updated_at = ? WHERE dossier_id = ?')
          .run(title, now, id)
        this.db.prepare('DELETE FROM concept_dossier_members WHERE dossier_id = ?').run(id)
      } else {
        this.db.prepare(`INSERT INTO concept_dossiers
          (dossier_id, title, anchor_document_id, anchor_node_id, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, 1, ?, ?)`).run(id, title, anchor.documentId, anchor.nodeId, now, now)
      }
      const insert = this.db.prepare(`INSERT INTO concept_dossier_members
        (dossier_id, document_id, node_id, relation, note, applicability, valid_time, reference_json,
         bound_revision, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      members.forEach((member, position) => insert.run(id, member.documentId, member.nodeId,
        member.relation, member.note, member.applicability, member.validTime,
        JSON.stringify(references.get(member.documentId + '\u0000' + member.nodeId)),
        bound.get(member.documentId), position))
      this.db.exec('COMMIT')
      return this.getConceptDossier(id)
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deleteConceptDossier(id, expectedVersion) {
    if (typeof id !== 'string' || !Number.isInteger(expectedVersion)) {
      throw Object.assign(new Error('档案标识或版本无效'), { code: 'invalid_input' })
    }
    const result = this.db.prepare('DELETE FROM concept_dossiers WHERE dossier_id = ? AND version = ?').run(id, expectedVersion)
    if (result.changes) return true
    if (this.db.prepare('SELECT 1 FROM concept_dossiers WHERE dossier_id = ?').get(id)) {
      throw Object.assign(new Error('档案已被修改，请刷新'), { code: 'dossier_conflict' })
    }
    return false
  }

  targetMap(args) {
    if (!args || typeof args.documentId !== 'string') return targetMapTools.handle(null, args)
    this.db.exec(args.action === 'save' ? 'BEGIN IMMEDIATE' : 'BEGIN')
    try {
      const graph = this.getDocument(args.documentId)
      const targetId = typeof args.targetId === 'string' ? args.targetId : ''
      if (args.action === 'catalog') {
        // Default browsing reads only metadata; explicit body queries stream snapshots in the same read transaction.
        const rows = this.db.prepare(`SELECT counts.*, latest.attempt_id AS recordId, latest.base_revision AS baseRevision,
          latest.created_at AS createdAt, json_extract(latest.response_json, '$.title') AS title FROM (
            SELECT model_id AS targetId, COUNT(*) AS recordCount,
              SUM(CASE WHEN base_revision = ? THEN 1 ELSE 0 END) AS currentRecordCount
            FROM learning_attempts WHERE document_id = ? AND task_kind = 'target_map' GROUP BY model_id
          ) counts JOIN learning_attempts latest ON latest.attempt_id = (
            SELECT attempt_id FROM learning_attempts WHERE document_id = ? AND model_id = counts.targetId AND task_kind = 'target_map'
            ORDER BY created_at DESC, attempt_id DESC LIMIT 1
          )`).all(graph?.revision || 0, args.documentId, args.documentId)
        const counts = new Map(rows.map(row => [row.targetId, { recordCount: row.recordCount, currentRecordCount: row.currentRecordCount,
          latestRecord: { id: row.recordId, title: row.title, baseRevision: row.baseRevision, createdAt: row.createdAt } }]))
        const saved = graph ? { documentId: args.documentId, revision: graph.revision, graph } : null
        let result = targetMapTools.handle(saved, args, [], Date.now(), 0, [], null, counts)
        if (!result.error && args.searchIn === 'content' && args.query) {
          const targets = new Set(graph.nodes.filter(node => ['concept', 'connection_model', 'discrimination_model'].includes(node.type) &&
            (!args.mode || args.mode === 'all' || (node.type === 'connection_model' ? 'connection' : 'discrimination') === args.mode)).map(node => node.id))
          const snapshots = this.db.prepare(`SELECT model_id AS targetId, attempt_id AS id, base_revision AS baseRevision, created_at AS createdAt, response_json
            FROM learning_attempts WHERE document_id = ? AND task_kind = 'target_map' ORDER BY created_at DESC, attempt_id DESC`).iterate(args.documentId)
          for (const row of snapshots) {
            if (!targets.has(row.targetId)) continue
            const map = parseJson(row.response_json, {}), match = targetMapTools.historyContentMatch(map, args.query)
            if (!match) continue
            const count = counts.get(row.targetId)
            count.matchCount = (count.matchCount || 0) + 1
            count.latestMatch ||= { id: row.id, title: map.title, baseRevision: row.baseRevision, createdAt: row.createdAt, match }
          }
          result = targetMapTools.handle(saved, args, [], Date.now(), 0, [], null, counts)
        }
        this.db.exec('COMMIT')
        return result
      }
      if (args.action === 'history') {
        const where = "document_id = ? AND model_id = ? AND task_kind = 'target_map'"
        const keys = [args.documentId, targetId]
        const head = this.db.prepare(`SELECT attempt_id FROM learning_attempts WHERE ${where} ORDER BY created_at DESC, attempt_id DESC LIMIT 1`).get(...keys)
        const historyRecordTotal = this.db.prepare(`SELECT COUNT(*) AS n FROM learning_attempts WHERE ${where}`).get(...keys).n
        const offset = Number.isSafeInteger(args.offset) && args.offset >= 0 ? args.offset : 0
        const query = typeof args.query === 'string' && args.query.length <= 256 ? args.query : ''
        const content = args.searchIn === 'content' && !!query
        // Stream snapshots only for explicit body searches; retain a bounded page, never send maps to the list.
        const rows = this.db.prepare(`SELECT attempt_id AS id, base_revision AS baseRevision, created_at AS createdAt,
          json_extract(response_json, '$.title') AS title, json_extract(task_json, '$.reason') AS reason${content ? ', response_json' : ''}
          FROM learning_attempts WHERE ${where} ORDER BY created_at DESC, attempt_id DESC${query ? '' : ' LIMIT 20 OFFSET ?'}`).iterate(...keys, ...(query ? [] : [offset]))
        let historyTotal = query ? 0 : historyRecordTotal
        const history = []
        for (const row of rows) {
          const { response_json, ...item } = row
          if (content) item.match = targetMapTools.historyContentMatch(parseJson(response_json, {}), query)
          if (query && !targetMapTools.historyMatches(item, query, content ? 'content' : 'metadata')) continue
          if (!query || historyTotal >= offset && history.length < 20) history.push(item)
          if (query) historyTotal++
        }
        const result = targetMapTools.handle(graph ? { documentId: args.documentId, revision: graph.revision, graph } : null, args, [], Date.now(), historyTotal, [],
          { historyHead: head?.attempt_id || '', historyRecordTotal, historyTotal, history })
        this.db.exec('COMMIT')
        return result
      }
      const rows = this.db.prepare(`SELECT task_json, response_json FROM learning_attempts
        WHERE document_id = ? AND model_id = ? AND task_kind = 'target_map'
        ORDER BY created_at DESC, attempt_id DESC LIMIT 20`).all(args.documentId, targetId)
      const records = rows.map(row => ({ ...parseJson(row.task_json, {}), map: parseJson(row.response_json, {}) }))
      const count = this.db.prepare(`SELECT COUNT(*) AS n FROM learning_attempts
        WHERE document_id = ? AND model_id = ? AND task_kind = 'target_map'`).get(args.documentId, targetId).n
      const requestedId = args.action === 'save' ? args.id : args.recordId
      if (typeof requestedId === 'string' && !records.some(record => record.id === requestedId)) {
        const row = this.db.prepare('SELECT task_kind, task_json, response_json FROM learning_attempts WHERE attempt_id = ?').get(requestedId)
        if (row && row.task_kind !== 'target_map') {
          this.db.exec('ROLLBACK')
          return { error: { code: 'attempt_conflict', message: '保存身份已被其他记录使用' } }
        }
        if (row) records.push({ ...parseJson(row.task_json, {}), map: parseJson(row.response_json, {}) })
      }
      const contexts = args.action === 'save' && Array.isArray(args.map?.examples) && args.map.examples.some(item => item?.exposure === 'self_reported_new')
        ? this.db.prepare(`SELECT DISTINCT json_extract(example.value, '$.context') AS context
            FROM learning_attempts, json_each(learning_attempts.response_json, '$.examples') AS example
            WHERE document_id = ? AND model_id = ? AND task_kind = 'target_map'`).all(args.documentId, targetId)
          .map(row => row.context).filter(value => typeof value === 'string') : []
      const result = targetMapTools.handle(graph ? { documentId: args.documentId, revision: graph.revision, graph } : null, args, records, Date.now(), count, contexts)
      if (result.appendRecord) {
        const { map, ...record } = result.appendRecord
        this.db.prepare(`INSERT INTO learning_attempts (attempt_id, document_id, base_revision, task_id, task_kind,
          task_json, answer, scenario, self_rating, created_at, model_id, response_json)
          VALUES (?, ?, ?, ?, 'target_map', ?, ?, '', 'not_assessed', ?, ?, ?)`).run(record.id, record.documentId, record.baseRevision,
          'target_map:' + encodeURIComponent(record.target.id), JSON.stringify(record), map.mapping, record.createdAt, record.target.id, JSON.stringify(map))
        delete result.appendRecord
      }
      this.db.exec('COMMIT')
      return result
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listLearningAttempts(documentId, modelId = '', exercise = '') {
    if (typeof documentId !== 'string' || !documentId || documentId.length > 160) return []
    if (typeof modelId !== 'string' || modelId.length > 160) return []
    if (exercise && (!modelId || !['prediction', 'counterexample', 'understanding', 'feedback'].includes(exercise))) return []
    const revision = this.getDocumentRevision(documentId)
    const taskId = (exercise === 'feedback' ? 'model_feedback:' : exercise === 'understanding' ? 'model_understanding:' : exercise === 'counterexample' ? 'model_counterexample:' : 'model_prediction:') + encodeURIComponent(modelId)
    return this.db.prepare(`SELECT * FROM learning_attempts
      WHERE document_id = ? AND model_id = ? AND task_kind <> 'target_map' ${exercise ? 'AND task_id = ?' : ''}
      ORDER BY created_at DESC, attempt_id DESC LIMIT 100`).all(documentId, modelId, ...(exercise ? [taskId] : []))
      .map(row => this.learningAttemptOf(row, documentId, revision))
  }

  learningAttemptOf(row, documentId, revision) {
    return { attemptId: row.attempt_id, documentId, baseRevision: row.base_revision,
      taskId: row.task_id, kind: row.task_kind, task: parseJson(row.task_json, {}), answer: row.answer,
      scenario: row.scenario, selfRating: row.self_rating, createdAt: row.created_at,
      modelId: row.model_id, response: parseJson(row.response_json, {}), revealedAt: row.revealed_at,
      review: parseJson(row.review_json, null), version: row.attempt_version,
      stale: revision !== row.base_revision }
  }

  getLearningAttempt(attemptId) {
    const row = this.db.prepare('SELECT * FROM learning_attempts WHERE attempt_id = ?').get(attemptId)
    return row ? this.learningAttemptOf(row, row.document_id, this.getDocumentRevision(row.document_id)) : null
  }

  saveLearningAttempt(input) {
    const invalid = message => Object.assign(new Error(message), { code: 'invalid_input' })
    const { attemptId, documentId, expectedRevision, task, selfRating } = input || {}
    const modelExercise = task?.kind === 'model_prediction'
    const understanding = task?.kind === 'model_understanding'
    let answer = input?.answer, scenario = input?.scenario ?? '', response = {}
    if (understanding) {
      const value = input.response
      const fields = { inputs: 2000, mapping: 4000, outputs: 2000, conditions: 2000, boundary: 2000, questions: 2000, revisionReason: 2000 }
      if (task.exercise !== 'understanding' || task.origin !== 'personal_expression_not_source' ||
          typeof task.modelId !== 'string' || !task.modelId || task.modelId.length > 160 ||
          task.id !== 'model_understanding:' + encodeURIComponent(task.modelId) ||
          !value || typeof value !== 'object' || Array.isArray(value) ||
          typeof value.parentAttemptId !== 'string' || value.parentAttemptId.length > 120 ||
          !Array.isArray(value.practiceIds) || value.practiceIds.length > 10 ||
          value.practiceIds.some(id => typeof id !== 'string' || !id || id.length > 120) ||
          new Set(value.practiceIds).size !== value.practiceIds.length) throw invalid('个人表述身份或关联记录无效')
      for (const [field, limit] of Object.entries(fields)) {
        if (typeof value[field] !== 'string' || value[field].length > limit) throw invalid('个人表述字段无效或过长')
        response[field] = value[field].trim()
      }
      if (!response.mapping || value.parentAttemptId && !response.revisionReason) throw invalid('请填写联结规律；修订时还需填写修改理由')
      response.parentAttemptId = value.parentAttemptId
      response.practiceIds = [...value.practiceIds].sort()
      answer = response.mapping
      scenario = ''
    }
    if (modelExercise) {
      const fields = { inputs: 1000, mapping: 2000, outputs: 1000, boundary: 1500,
        scenario: 2000, prediction: 2000, check: 2000,
        ...(task.exercise === 'counterexample' ? { baseline: 2000, baselinePrediction: 2000, changedVariable: 1500, falsifier: 2000 } : {}) }
      if (task.exercise && task.exercise !== 'counterexample') throw invalid('模型练习类型无效')
      if (!input.response || typeof input.response !== 'object' || Array.isArray(input.response) ||
          !['not_seen', 'seen', 'unsure'].includes(input.response.sourceExposure) ||
          typeof task.modelId !== 'string' || !task.modelId || task.modelId.length > 160 ||
          task.id !== (task.exercise === 'counterexample' ? 'model_counterexample:' : 'model_prediction:') + encodeURIComponent(task.modelId)) throw invalid('模型练习内容无效')
      for (const [field, limit] of Object.entries(fields)) {
        const value = input.response[field]
        if (typeof value !== 'string' || !value.trim() || value.length > limit) throw invalid('请完整填写模型理解、情境、预测和验证依据')
        response[field] = value.trim()
      }
      response.sourceExposure = input.response.sourceExposure
      scenario = response.scenario
      answer = response.prediction
    }
    if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 120 ||
        typeof documentId !== 'string' || !documentId || documentId.length > 160 ||
        !Number.isInteger(expectedRevision) || expectedRevision < 1 ||
        !task || typeof task.id !== 'string' || !['distinction', 'mechanism', 'transfer', 'model_prediction', 'model_understanding'].includes(task.kind) ||
        task.origin !== (understanding ? 'personal_expression_not_source' : 'derived_exercise_not_source') || !Array.isArray(task.references) ||
        typeof answer !== 'string' || !answer.trim() || answer.length > 10000 ||
        typeof scenario !== 'string' || scenario.length > 2000 ||
        !(understanding ? selfRating === 'not_assessed' : ['needs_work', 'uncertain', 'confident'].includes(selfRating)) ||
        task.kind === 'transfer' && !scenario.trim()) throw invalid('学习记录内容无效')
    const comparableText = value => typeof value === 'string' ?
      value.normalize('NFKC').replace(/[\s\p{P}\p{S}]/gu, '') : ''
    if (task.exercise === 'counterexample' && (!comparableText(response.baseline) || !comparableText(response.scenario) ||
        comparableText(response.baseline) === comparableText(response.scenario))) throw invalid('请给出与基准不同的情境；仅修改标点或排版不构成条件变化')
    if ((task.kind === 'transfer' || modelExercise) && task.references.some(ref =>
      [ref.quote, ref.text, ...(ref.citations || []).map(citation => citation.quote)].some(quote =>
        comparableText(scenario) && comparableText(scenario) === comparableText(quote)))) {
      throw invalid('新情境不能直接复制原文引文；请描述具体的新场景')
    }
    let taskJson = JSON.stringify(task)
    const retryTaskJson = value => {
      const original = { ...value }
      // Evidence derived at the first commit is frozen, not part of the learner's retry identity.
      delete original.practiceSnapshots
      return JSON.stringify(original)
    }
    const answerText = answer.trim()
    const scenarioText = scenario.trim()
    const responseJson = JSON.stringify(response)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.db.prepare('SELECT * FROM learning_attempts WHERE attempt_id = ?').get(attemptId)
      if (previous) {
        const matchesTask = understanding ? retryTaskJson(parseJson(previous.task_json, {})) === retryTaskJson(task)
          : previous.task_json === taskJson
        if (previous.document_id !== documentId || previous.base_revision !== expectedRevision ||
            previous.task_id !== task.id || !matchesTask || previous.answer !== answerText ||
            previous.scenario !== scenarioText || previous.self_rating !== selfRating || previous.response_json !== responseJson) {
          throw Object.assign(new Error('学习记录请求与已保存记录冲突'), { code: 'attempt_conflict' })
        }
        this.db.exec('COMMIT')
        return this.getLearningAttempt(attemptId)
      }
      const revision = this.getDocumentRevision(documentId)
      if (!revision || revision !== expectedRevision) {
        throw Object.assign(new Error('知识图已变化，请重新生成学习任务'), { code: 'revision_conflict', currentRevision: revision })
      }
      let createdAt = Date.now()
      if (understanding) {
        const latest = this.db.prepare(`SELECT attempt_id, created_at FROM learning_attempts
          WHERE document_id = ? AND model_id = ? AND task_kind = 'model_understanding'
          ORDER BY created_at DESC, attempt_id DESC LIMIT 1`).get(documentId, task.modelId)
        if ((latest?.attempt_id || '') !== response.parentAttemptId) {
          throw Object.assign(new Error('个人表述已有新版本；草稿保留，请对照最新记录后再修订'), { code: 'attempt_conflict' })
        }
        // Append-only revisions retain both the learner's expression and the evidence as it was then.
        const practiceSnapshots = response.practiceIds.map(id => {
          const practice = this.getLearningAttempt(id)
          if (!practice || practice.documentId !== documentId || practice.modelId !== task.modelId || practice.kind !== 'model_prediction') {
            throw invalid('关联练习不属于当前文档和模型')
          }
          const feedback = this.listModelFeedback(documentId, task.modelId, id)
          return { attemptId: id, version: practice.version, baseRevision: practice.baseRevision,
            exercise: practice.task.exercise || 'prediction', createdAt: practice.createdAt, response: practice.response,
            revealedAt: practice.revealedAt, review: practice.review, assessment: 'learner_reported_not_verified',
            feedbackSnapshots: feedback.attempts.slice(0, 5).map(item => ({ attemptId: item.attemptId, version: item.version,
              createdAt: item.createdAt, rootResultId: item.task.rootResultId, response: item.response,
              reference: item.task.reference, assessment: item.task.assessment,
              supersededAtSave: feedback.attempts.find(other => other.task.rootResultId === item.task.rootResultId).attemptId !== item.attemptId })),
            feedbackTotal: feedback.total, feedbackLimited: feedback.total > 5 }
        })
        taskJson = JSON.stringify({ ...task, practiceSnapshots })
        createdAt = Math.max(createdAt, (latest?.created_at || 0) + 1)
      }
      this.db.prepare(`INSERT INTO learning_attempts (attempt_id, document_id, base_revision,
        task_id, task_kind, task_json, answer, scenario, self_rating, created_at, model_id, response_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(attemptId, documentId, expectedRevision,
        task.id, task.kind, taskJson, answerText, scenarioText, selfRating, createdAt, modelExercise || understanding ? task.modelId : '', responseJson)
      this.db.exec('COMMIT')
      return this.getLearningAttempt(attemptId)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  advanceLearningAttempt(input) {
    const { action, attemptId, documentId, modelId, expectedVersion } = input || {}
    const invalid = message => Object.assign(new Error(message), { code: 'invalid_input' })
    const conflict = message => Object.assign(new Error(message), { code: 'attempt_conflict' })
    if (!['reveal', 'review'].includes(action) || typeof attemptId !== 'string' || !attemptId || attemptId.length > 120 ||
        typeof documentId !== 'string' || !documentId || documentId.length > 160 ||
        typeof modelId !== 'string' || !modelId || modelId.length > 160 ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw invalid('练习记录身份或版本无效')
    let review = null
    if (action === 'review') {
      const value = input.review
      if (!value || !['input', 'mapping', 'output', 'boundary', 'evidence', 'no_change', 'unsure'].includes(value.diagnosis) ||
          !['needs_work', 'uncertain', 'confident'].includes(value.selfRating) ||
          typeof value.reflection !== 'string' || !value.reflection.trim() || value.reflection.length > 4000 ||
          typeof value.nextCheck !== 'string' || !value.nextCheck.trim() || value.nextCheck.length > 2000) throw invalid('请填写复盘判断和下一步验证')
      review = { diagnosis: value.diagnosis, reflection: value.reflection.trim(), nextCheck: value.nextCheck.trim(), selfRating: value.selfRating }
    }
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.db.prepare('SELECT * FROM learning_attempts WHERE attempt_id = ?').get(attemptId)
      if (!row || row.document_id !== documentId || row.model_id !== modelId || row.task_kind !== 'model_prediction') {
        throw invalid('找不到属于当前模型的练习记录')
      }
      if (expectedVersion > row.attempt_version) throw conflict('练习记录版本不一致，请重新读取')
      // Lost responses can be retried, but neither prediction nor completed review may be overwritten.
      if (action === 'reveal' && row.revealed_at || action === 'review' && row.review_json) {
        if (action === 'review') {
          const previous = parseJson(row.review_json, {})
          if (JSON.stringify(previous.content) !== JSON.stringify(review)) throw conflict('复盘已保存，不能覆盖；请另开练习')
        }
        this.db.exec('COMMIT')
        return this.getLearningAttempt(attemptId)
      }
      if (row.attempt_version !== expectedVersion) throw conflict('练习记录已变化，请重新读取')
      if (action === 'review' && !row.revealed_at) throw invalid('请先展开原文对照，再保存复盘')
      if (action === 'reveal') {
        this.db.prepare('UPDATE learning_attempts SET revealed_at = ?, attempt_version = attempt_version + 1 WHERE attempt_id = ?')
          .run(Date.now(), attemptId)
      } else {
        this.db.prepare('UPDATE learning_attempts SET review_json = ?, attempt_version = attempt_version + 1 WHERE attempt_id = ?')
          .run(JSON.stringify({ content: review, createdAt: Date.now() }), attemptId)
      }
      this.db.exec('COMMIT')
      return this.getLearningAttempt(attemptId)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listModelLearningHistory(documentId, modelId, options = {}) {
    const invalid = message => Object.assign(new Error(message), { code: 'invalid_input' })
    const { offset = 0, exercise = '', sourceType = '', diagnosis = '', comparison = '', expectedRevision } = options
    const types = ['observation', 'reference', 'derivation', 'ai_suggestion', 'reflection']
    if ([documentId, modelId].some(id => typeof id !== 'string' || !id || id.length > 160) ||
        !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
        !['', 'prediction', 'counterexample'].includes(exercise) || !['', ...types].includes(sourceType) ||
        !['', 'input', 'mapping', 'condition', 'calculation', 'output', 'evidence', 'no_change', 'unsure'].includes(diagnosis) ||
        !['', 'consistent', 'different', 'inconclusive', 'not_compared'].includes(comparison)) throw invalid('学习记录筛选或来源版本无效')
    // Fold entire correction chains before any filtering or pagination. A result row is not a new trial.
    const cte = `WITH predictions AS (
      SELECT * FROM learning_attempts WHERE document_id = ? AND model_id = ? AND task_kind = 'model_prediction'
        AND COALESCE(json_extract(task_json, '$.exercise'), 'prediction') IN ('prediction', 'counterexample')
    ), feedback AS (
      SELECT f.*, json_extract(f.task_json, '$.predictionId') AS prediction_id,
        json_extract(f.task_json, '$.rootResultId') AS root_result_id,
        ROW_NUMBER() OVER (PARTITION BY json_extract(f.task_json, '$.predictionId'), json_extract(f.task_json, '$.rootResultId')
          ORDER BY f.created_at DESC, f.attempt_id DESC) AS result_rank
      FROM learning_attempts f JOIN predictions p ON p.attempt_id = json_extract(f.task_json, '$.predictionId')
        AND p.base_revision = f.base_revision
      WHERE f.document_id = ? AND f.model_id = ? AND f.task_kind = 'model_feedback'
        AND json_extract(f.task_json, '$.assessment') = 'not_independently_verified'
        AND json_extract(f.task_json, '$.origin') = 'learner_reported_feedback_not_verification'
        AND LENGTH(json_extract(f.task_json, '$.rootResultId')) > 0
    ), heads AS (
      SELECT *, json_extract(response_json, '$.type') AS source_type,
        json_extract(response_json, '$.comparison') AS comparison,
        json_extract(response_json, '$.diagnosis') AS diagnosis FROM feedback WHERE result_rank = 1
    ), filtered AS (
      SELECT p.* FROM predictions p WHERE (? = '' OR COALESCE(json_extract(p.task_json, '$.exercise'), 'prediction') = ?)
        AND ((? = '' AND ? = '' AND ? = '') OR EXISTS (SELECT 1 FROM heads h WHERE h.prediction_id = p.attempt_id
          AND (? = '' OR h.source_type = ?) AND (? = '' OR h.diagnosis = ?) AND (? = '' OR h.comparison = ?)))
    ) `
    const args = [documentId, modelId, documentId, modelId, exercise, exercise, sourceType, diagnosis, comparison,
      sourceType, sourceType, diagnosis, diagnosis, comparison, comparison]
    this.db.exec('BEGIN')
    try {
      const revision = this.getDocumentRevision(documentId)
      if (revision !== expectedRevision) throw Object.assign(new Error('知识图版本已变化，请重新读取学习记录'),
        { code: 'revision_conflict', currentRevision: revision })
      const summary = this.db.prepare(cte + `SELECT COUNT(*) AS predictions,
        COUNT(CASE WHEN base_revision = ? THEN 1 END) AS currentRevision,
        COUNT(CASE WHEN base_revision <> ? THEN 1 END) AS olderRevision,
        COUNT(CASE WHEN revealed_at IS NULL THEN 1 END) AS unrevealed,
        COUNT(CASE WHEN json_extract(response_json, '$.sourceExposure') = 'seen' THEN 1 END) AS seenSource,
        COUNT(CASE WHEN json_extract(response_json, '$.sourceExposure') = 'not_seen' THEN 1 END) AS unseenSourceReported,
        COUNT(CASE WHEN review_json IS NOT NULL THEN 1 END) AS withReview,
        COUNT(CASE WHEN EXISTS (SELECT 1 FROM heads h WHERE h.prediction_id = predictions.attempt_id) THEN 1 END) AS withFeedback,
        (SELECT COUNT(*) FROM feedback) AS feedbackRows, (SELECT COUNT(*) FROM heads) AS feedbackRoots
        FROM predictions`).get(...args, revision, revision)
      summary.corrections = summary.feedbackRows - summary.feedbackRoots
      const grouped = this.db.prepare(cte + `SELECT h.source_type AS type, COUNT(*) AS roots,
        COUNT(DISTINCT h.prediction_id) AS predictions,
        COUNT(DISTINCT CASE WHEN h.comparison = 'consistent' THEN h.prediction_id END) AS consistent,
        COUNT(DISTINCT CASE WHEN h.comparison = 'different' THEN h.prediction_id END) AS different,
        COUNT(DISTINCT CASE WHEN h.comparison = 'inconclusive' THEN h.prediction_id END) AS inconclusive,
        COUNT(DISTINCT CASE WHEN h.comparison = 'not_compared' THEN h.prediction_id END) AS notCompared,
        COUNT(DISTINCT CASE WHEN h.comparison = 'consistent' AND EXISTS (SELECT 1 FROM heads other
          WHERE other.prediction_id = h.prediction_id AND other.source_type = h.source_type AND other.comparison = 'different')
          THEN h.prediction_id END) AS mixed FROM heads h GROUP BY h.source_type`).all(...args)
      const sourceCounts = types.map(type => grouped.find(row => row.type === type) ||
        { type, roots: 0, predictions: 0, consistent: 0, different: 0, inconclusive: 0, notCompared: 0, mixed: 0 })
      const total = this.db.prepare(cte + 'SELECT COUNT(*) AS count FROM filtered').get(...args).count
      const rows = this.db.prepare(cte + `SELECT p.*,
        (SELECT COUNT(*) FROM heads h WHERE h.prediction_id = p.attempt_id) AS result_total,
        (SELECT h.attempt_id FROM heads h WHERE h.prediction_id = p.attempt_id
          AND (? = '' OR h.source_type = ?) AND (? = '' OR h.diagnosis = ?) AND (? = '' OR h.comparison = ?)
          ORDER BY h.created_at DESC, h.attempt_id DESC LIMIT 1) AS matching_result_id
        FROM filtered p ORDER BY p.created_at DESC, p.attempt_id DESC LIMIT 20 OFFSET ?`)
        .all(...args, sourceType, sourceType, diagnosis, diagnosis, comparison, comparison, offset)
      const resultRows = this.db.prepare(cte + `, page AS (
        SELECT attempt_id FROM filtered ORDER BY created_at DESC, attempt_id DESC LIMIT 20 OFFSET ?
      ), previews AS (
        SELECT h.*, ROW_NUMBER() OVER (PARTITION BY h.prediction_id ORDER BY h.created_at DESC, h.attempt_id DESC) AS preview_rank
          FROM heads h JOIN page p ON p.attempt_id = h.prediction_id
      ) SELECT prediction_id AS predictionId, attempt_id AS attemptId, root_result_id AS rootResultId,
        source_type AS type, comparison, diagnosis, created_at AS createdAt, base_revision AS baseRevision,
        SUBSTR(json_extract(response_json, '$.content'), 1, 500) AS content,
        json_extract(response_json, '$.observedOn') AS observedOn,
        json_extract(response_json, '$.observedTimeZone') AS observedTimeZone
        FROM previews WHERE preview_rank <= 5 ORDER BY created_at DESC, attempt_id DESC`).all(...args, offset)
      const items = rows.map(row => {
        const results = resultRows.filter(item => item.predictionId === row.attempt_id)
        // The response preview is bounded, but result counts and filters are based on all heads.
        return { attemptId: row.attempt_id, exercise: parseJson(row.task_json, {}).exercise || 'prediction',
          baseRevision: row.base_revision, version: row.attempt_version, createdAt: row.created_at,
          stale: row.base_revision !== revision, revealedAt: row.revealed_at,
          response: parseJson(row.response_json, {}), review: parseJson(row.review_json, null),
          resultTotal: row.result_total, results, resultsLimited: row.result_total > 5,
          matchingResultId: row.matching_result_id || '' }
      })
      this.db.exec('COMMIT')
      return { documentId, modelId, revision, basis: 'learner_reports_not_mastery',
        summary, sourceCounts, total, offset, limit: 20, filters: { exercise, sourceType, diagnosis, comparison }, items }
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  listModelFeedback(documentId, modelId, predictionId) {
    if ([documentId, modelId].some(id => typeof id !== 'string' || !id || id.length > 160) ||
        typeof predictionId !== 'string' || !predictionId || predictionId.length > 120) {
      throw Object.assign(new Error('结果记录缺少有效的模型和预测身份'), { code: 'invalid_input' })
    }
    const prediction = this.getLearningAttempt(predictionId)
    if (!prediction || prediction.documentId !== documentId || prediction.modelId !== modelId || prediction.kind !== 'model_prediction') {
      throw Object.assign(new Error('找不到当前模型的预测'), { code: 'invalid_input' })
    }
    const where = "document_id = ? AND model_id = ? AND task_kind = 'model_feedback' AND json_extract(task_json, '$.predictionId') = ?"
    const args = [documentId, modelId, predictionId]
    const total = this.db.prepare(`SELECT COUNT(*) AS count FROM learning_attempts WHERE ${where}`).get(...args).count
    const revision = this.getDocumentRevision(documentId)
    const attempts = this.db.prepare(`SELECT * FROM learning_attempts WHERE ${where}
      ORDER BY created_at DESC, attempt_id DESC LIMIT 100`).all(...args).map(row => this.learningAttemptOf(row, documentId, revision))
    return { predictionId, total, attempts, limited: total > attempts.length }
  }

  modelFeedbackHead(attempt) {
    if (attempt?.kind !== 'model_feedback') return ''
    return this.db.prepare(`SELECT attempt_id FROM learning_attempts WHERE document_id = ? AND model_id = ?
      AND task_kind = 'model_feedback' AND json_extract(task_json, '$.predictionId') = ?
      AND json_extract(task_json, '$.rootResultId') = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1`)
      .get(attempt.documentId, attempt.modelId, attempt.task.predictionId, attempt.task.rootResultId)?.attempt_id || ''
  }

  saveModelFeedback(input) {
    const invalid = message => Object.assign(new Error(message), { code: 'invalid_input' })
    const conflict = message => Object.assign(new Error(message), { code: 'attempt_conflict' })
    const { attemptId, documentId, modelId, predictionId, expectedVersion, expectedRevision } = input || {}
    const value = input?.response
    if ([attemptId, predictionId].some(id => typeof id !== 'string' || !id || id.length > 120) ||
        [documentId, modelId].some(id => typeof id !== 'string' || !id || id.length > 160) ||
        !Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1 ||
        !value || typeof value !== 'object' || Array.isArray(value) ||
        !['observation', 'reference', 'derivation', 'ai_suggestion', 'reflection'].includes(value.type) ||
        !['consistent', 'different', 'inconclusive', 'not_compared'].includes(value.comparison) ||
        !['input', 'mapping', 'condition', 'calculation', 'output', 'evidence', 'no_change', 'unsure'].includes(value.diagnosis) ||
        typeof value.observationConfirmed !== 'boolean' || typeof value.parentResultId !== 'string' || value.parentResultId.length > 120) {
      throw invalid('结果记录身份、来源类型或预测版本无效')
    }
    const response = { type: value.type, comparison: value.comparison, diagnosis: value.diagnosis,
      observationConfirmed: value.observationConfirmed, parentResultId: value.parentResultId }
    const limits = { content: 4000, context: 2000, observedOn: 10, observedTimeZone: 100, sourceName: 500, sourceUrl: 2000,
      sourceLocator: 1000, rationale: 2000, revisionReason: 2000 }
    for (const [field, limit] of Object.entries(limits)) {
      if (typeof value[field] !== 'string' || value[field].length > limit) throw invalid('结果记录字段无效或过长')
      response[field] = value[field].trim()
    }
    if (!response.content || response.parentResultId && !response.revisionReason ||
        response.comparison !== 'not_compared' && !response.rationale ||
        response.comparison === 'not_compared' && response.diagnosis !== 'unsure') throw invalid('请记录结果；比较或更正时还需填写理由')
    if (response.sourceUrl) {
      let url
      try { url = new URL(response.sourceUrl) } catch { throw invalid('来源链接必须是完整的 HTTP 或 HTTPS 地址') }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw invalid('来源链接协议或凭据无效')
    }
    response.reference = null
    if (value.reference !== null) {
      const ref = value.reference
      if (response.type !== 'reference' || !ref || typeof ref !== 'object' || Array.isArray(ref) ||
          typeof ref.nodeId !== 'string' || !ref.nodeId || ref.nodeId.length > 160 ||
          !Number.isSafeInteger(ref.paragraph) || ref.paragraph < 0 ||
          typeof ref.quote !== 'string' || !ref.quote.trim() || ref.quote.length > 2000 ||
          response.sourceName || response.sourceUrl || response.sourceLocator) throw invalid('原文引用身份无效；不能混用外部来源')
      response.reference = { nodeId: ref.nodeId, paragraph: ref.paragraph, quote: ref.quote.trim() }
    }
    if (response.type === 'observation') {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(response.observedOn) ? new Date(response.observedOn + 'T00:00:00Z') : null
      let today
      try {
        if (!response.observedTimeZone) throw new Error('Missing observation time zone')
        const parts = new Intl.DateTimeFormat('en', { timeZone: response.observedTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(Date.now())
        const part = type => parts.find(item => item.type === type).value
        today = part('year') + '-' + part('month') + '-' + part('day')
      } catch { throw invalid('观察日期须有有效的时区') }
      if (!date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== response.observedOn ||
          response.observedOn > today || !response.context || !response.observationConfirmed) throw invalid('真实观察须记录已发生的日期、实际条件并明确确认；计划不是证据')
    } else if (response.observedOn || response.observedTimeZone || response.observationConfirmed) throw invalid('非观察来源不能记为已发生的真实观察')
    if (response.type === 'reference' && !response.reference && (!response.sourceName || !response.sourceLocator)) {
      throw invalid('外部参考资料须填写名称和可核对的位置')
    }
    if (response.type === 'ai_suggestion' && !response.sourceName) throw invalid('请记录 AI 建议的生成来源')
    if (response.type === 'derivation' && !response.context) throw invalid('公式或规则推导须记录使用的输入和前提')
    const responseJson = JSON.stringify(response)
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const previous = this.getLearningAttempt(attemptId)
      if (previous) {
        if (previous.documentId !== documentId || previous.modelId !== modelId || previous.kind !== 'model_feedback' ||
            previous.task.predictionId !== predictionId || previous.task.predictionSnapshot.version !== expectedVersion ||
            previous.baseRevision !== expectedRevision || JSON.stringify(previous.response) !== responseJson) throw conflict('结果请求与已保存记录冲突，不能覆盖')
        this.db.exec('COMMIT')
        return previous
      }
      const prediction = this.getLearningAttempt(predictionId)
      if (!prediction || prediction.documentId !== documentId || prediction.modelId !== modelId || prediction.kind !== 'model_prediction') throw invalid('结果必须关联当前模型已有的预测')
      if (prediction.version !== expectedVersion) throw conflict('预测或复盘版本已变化；结果草稿保留，请重新对照后保存')
      if (prediction.baseRevision !== expectedRevision) throw invalid('结果必须绑定最初预测的来源版本')
      let reference = null
      if (response.reference) {
        if (!prediction.revealedAt) throw invalid('请先展开当时的原文对照，再引用资料')
        const { nodeId, paragraph, quote } = response.reference
        const ref = prediction.task.references.find(item => item.nodeId === nodeId &&
          item.citations.some(citation => citation.paragraph === paragraph && citation.quote.includes(quote)))
        if (!ref) throw invalid('引用不是当时模型的连续原文摘录')
        const citation = ref.citations.find(item => item.paragraph === paragraph && item.quote.includes(quote))
        reference = { ...response.reference, documentId, sourceId: citation.sourceId || '', text: ref.text, type: ref.type, origin: 'frozen_source_reference_not_outcome' }
      }
      let rootResultId = attemptId, createdAt = Date.now()
      if (response.parentResultId) {
        const parent = this.getLearningAttempt(response.parentResultId)
        if (!parent || parent.documentId !== documentId || parent.modelId !== modelId || parent.kind !== 'model_feedback' ||
            parent.task.predictionId !== predictionId) throw invalid('更正记录不属于当前预测')
        rootResultId = parent.task.rootResultId
        const latest = this.db.prepare(`SELECT attempt_id, created_at FROM learning_attempts WHERE document_id = ? AND model_id = ?
          AND task_kind = 'model_feedback' AND json_extract(task_json, '$.rootResultId') = ? ORDER BY created_at DESC, attempt_id DESC LIMIT 1`)
          .get(documentId, modelId, rootResultId)
        if (latest.attempt_id !== parent.attemptId) throw conflict('这条结果已有新更正，请重新读取；旧结果保留')
        createdAt = Math.max(createdAt, latest.created_at + 1)
      }
      // Evidence remains a typed learner report, not a verdict, even after source or review revisions.
      const task = { id: 'model_feedback:' + encodeURIComponent(modelId), kind: 'model_feedback', exercise: 'feedback',
        modelId, predictionId, rootResultId, origin: 'learner_reported_feedback_not_verification', assessment: 'not_independently_verified',
        references: [], reference, predictionSnapshot: { attemptId: predictionId, version: prediction.version,
          baseRevision: prediction.baseRevision, createdAt: prediction.createdAt, exercise: prediction.task.exercise || 'prediction',
          model: prediction.task.model, response: prediction.response, revealedAt: prediction.revealedAt, review: prediction.review } }
      this.db.prepare(`INSERT INTO learning_attempts (attempt_id, document_id, base_revision, task_id, task_kind,
        task_json, answer, scenario, self_rating, created_at, model_id, response_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(attemptId, documentId, expectedRevision, task.id, task.kind, JSON.stringify(task), response.content, response.context,
          'not_assessed', createdAt, modelId, responseJson)
      this.db.exec('COMMIT')
      return this.getLearningAttempt(attemptId)
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }

  getDocumentRevision(documentId) {
    const row = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(text(documentId).trim())
    return row && Number.isInteger(row.graph_revision) ? row.graph_revision : 0
  }

  getDocumentSourceUnits(documentId) {
    return this.db.prepare('SELECT paragraph, text FROM document_units WHERE document_id = ? ORDER BY paragraph').all(documentId)
  }

  #readDocumentSnapshot(read) {
    // Metadata, counts, graph rows and source units must agree on one revision.
    // SAVEPOINT preserves enclosing reads/writes, including on a nested read failure.
    this.db.exec('SAVEPOINT kg_document_read')
    try {
      const result = read()
      this.db.exec('RELEASE SAVEPOINT kg_document_read')
      return result
    } catch (error) {
      this.db.exec('ROLLBACK TO SAVEPOINT kg_document_read')
      this.db.exec('RELEASE SAVEPOINT kg_document_read')
      throw error
    }
  }

  getCanonicalDocument(documentId) {
    return this.#readDocumentSnapshot(() => {
      const graph = this.getDocument(documentId)
      return graph ? { documentId, revision: graph.revision, sourceText: graph.sourceText,
        sourceUnits: this.getDocumentSourceUnits(documentId), graph } : null
    })
  }

  listPerspectives(documentId) {
    return this.db.prepare(`SELECT perspective_id, name, state_json, base_revision, version, created_at, updated_at
      FROM document_perspectives WHERE document_id = ? ORDER BY updated_at DESC, perspective_id LIMIT 20`).all(documentId)
      .map(row => ({ id: row.perspective_id, name: row.name, state: parseJson(row.state_json, {}),
        baseRevision: row.base_revision, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }))
  }

  resolvePerspective(documentId, id) {
    const perspective = this.listPerspectives(documentId).find(item => item.id === id)
    const document = this.db.prepare('SELECT graph_revision, source_json, paragraph_count FROM documents WHERE document_id = ?').get(documentId)
    if (!perspective || !document) return null
    const state = normalizePerspectiveState(perspective.state)
    const warnings = []
    const ids = [state.focusNodeId, state.gather?.centerId, state.reading.themeId].filter(Boolean)
    const nodes = new Map(ids.map(nodeId => [nodeId, this.db.prepare(
      'SELECT type, section_id, paragraph FROM graph_nodes WHERE document_id = ? AND node_id = ?').get(documentId, nodeId)]))
    const source = parseJson(document.source_json, {})
    const sourceSections = Array.isArray(source.sections) ? source.sections : []
    const sections = new Set(sourceSections.map(section => section?.id).filter(Boolean))
    if (state.chapterId !== 'all' && !sections.has(state.chapterId)) {
      state.chapterId = 'all'; warnings.push('原章节已不存在，改为全部章节')
    }
    if (state.filters.section !== 'all' && !sections.has(state.filters.section)) {
      state.filters.section = 'all'; warnings.push('筛选章节已不存在，已清除')
    }
    if (state.focusNodeId && !nodes.get(state.focusNodeId)) {
      state.focusNodeId = null; warnings.push('焦点节点已不存在，未定位')
    }
    if (state.gather && !nodes.get(state.gather.centerId)) {
      state.gather = null; warnings.push('聚拢中心已不存在，未恢复聚拢')
    }
    if (state.reading.topicId && state.reading.topicId !== '__unassigned__' && !sections.has(state.reading.topicId)) {
      state.reading.topicId = ''; state.reading.themeId = ''; warnings.push('阅读章节已不存在，已回到章节列表')
    }
    const theme = nodes.get(state.reading.themeId)
    const themeSection = theme && Number.isInteger(theme.paragraph)
      ? sourceSections.find(section => Number.isInteger(section.startParagraph) && Number.isInteger(section.endParagraph)
        && theme.paragraph >= section.startParagraph && theme.paragraph <= section.endParagraph)?.id || '__unassigned__'
      : '__unassigned__'
    if (state.reading.themeId && (!theme || theme.type !== 'concept' ||
      (state.reading.topicId && themeSection !== state.reading.topicId))) {
      state.reading.themeId = ''; warnings.push('概念线索已不存在，已清除')
    }
    if (state.sourceParagraph !== null && state.sourceParagraph >= document.paragraph_count) {
      state.sourceParagraph = null; warnings.push('原文位置已不存在，未定位')
    }
    if (perspective.baseRevision !== document.graph_revision) {
      state.reading.offset = 0
      state.reading.themeOffset = 0
      warnings.unshift('知识图版本已变化，已重新检查节点与章节；阅读页码已重置')
    }
    return { perspectiveId: perspective.id, baseRevision: perspective.baseRevision,
      revision: document.graph_revision, revisionChanged: perspective.baseRevision !== document.graph_revision,
      state, warnings }
  }

  listImageReviews(documentId) {
    return this.db.prepare(`SELECT image_id AS imageId, fingerprint, status, note, version, updated_at AS updatedAt
      FROM image_reviews WHERE document_id = ? ORDER BY image_id`).all(documentId)
      .map(row => ({ ...row, reviewer: 'user' }))
  }

  saveImageReview(record, expectedRevision, expectedVersion) {
    if (!record || typeof record.documentId !== 'string' || !record.documentId || record.documentId.length > 160
      || typeof record.imageId !== 'string' || !record.imageId || record.imageId.length > 80
      || !/^[a-f0-9]{64}$/.test(record.fingerprint || '')
      || !['pending', 'matched', 'needs_correction'].includes(record.status)
      || typeof record.note !== 'string' || record.note.length > 2000
      || (record.status === 'needs_correction' && !record.note.trim())
      || !Number.isSafeInteger(expectedRevision) || expectedRevision < 1
      || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw perspectiveInputError('图片核对记录无效')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const document = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(record.documentId)
      if (!document) throw Object.assign(new Error('找不到图片所属文档'), { code: 'not_found' })
      if (document.graph_revision !== expectedRevision) throw Object.assign(new Error('知识图已更新，未保存图片核对'), { code: 'revision_conflict' })
      const previous = this.db.prepare('SELECT version FROM image_reviews WHERE document_id = ? AND image_id = ?').get(record.documentId, record.imageId)
      if ((previous?.version || 0) !== expectedVersion) throw Object.assign(new Error('核对记录已变化，请刷新核对状态后重试'), { code: 'image_review_conflict' })
      this.db.prepare(`INSERT INTO image_reviews (document_id, image_id, fingerprint, status, note, version, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(document_id, image_id) DO UPDATE SET
        fingerprint = excluded.fingerprint, status = excluded.status, note = excluded.note,
        version = excluded.version, updated_at = excluded.updated_at`)
        .run(record.documentId, record.imageId, record.fingerprint, record.status, record.note, expectedVersion + 1, Date.now())
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  savePerspective(documentId, input) {
    if (typeof documentId !== 'string' || !documentId || !input || typeof input !== 'object') throw perspectiveInputError('视图参数无效')
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name || name.length > 80) throw perspectiveInputError('视图名称需要 1 至 80 个字')
    const state = normalizePerspectiveState(input.state)
    const stateJson = JSON.stringify(state)
    if (stateJson.length > 4096 || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw perspectiveInputError('视图内容或版本无效')
    const id = input.id == null ? randomUUID() : perspectiveString(input.id, 160, '视图编号')
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const doc = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(documentId)
      if (!doc) throw Object.assign(new Error('找不到知识图文档'), { code: 'not_found' })
      if (doc.graph_revision !== input.expectedRevision) throw Object.assign(new Error('知识图版本已变化，未保存视图'), { code: 'revision_conflict', currentRevision: doc.graph_revision })
      const now = Date.now()
      if (input.id == null) {
        const count = this.db.prepare('SELECT COUNT(*) AS count FROM document_perspectives WHERE document_id = ?').get(documentId).count
        if (count >= 20) throw perspectiveInputError('每张知识图最多保存 20 个视图')
        this.db.prepare(`INSERT INTO document_perspectives
          (perspective_id, document_id, name, state_json, base_revision, version, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(id, documentId, name, stateJson, doc.graph_revision, now, now)
      } else {
        if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw perspectiveInputError('更新视图缺少版本')
        const result = this.db.prepare(`UPDATE document_perspectives SET name = ?, state_json = ?, base_revision = ?,
          version = version + 1, updated_at = ? WHERE perspective_id = ? AND document_id = ? AND version = ?`)
          .run(name, stateJson, doc.graph_revision, now, id, documentId, input.expectedVersion)
        if (result.changes !== 1) throw Object.assign(new Error('视图已被修改或移除，请刷新列表'), { code: 'perspective_conflict' })
      }
      const row = this.db.prepare(`SELECT perspective_id, name, state_json, base_revision, version, created_at, updated_at
        FROM document_perspectives WHERE perspective_id = ? AND document_id = ?`).get(id, documentId)
      this.db.exec('COMMIT')
      return { id: row.perspective_id, name: row.name, state: parseJson(row.state_json, {}),
        baseRevision: row.base_revision, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  deletePerspective(documentId, id, expectedVersion) {
    if (typeof documentId !== 'string' || !documentId || typeof id !== 'string' || !id ||
      !Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw perspectiveInputError('删除视图参数无效')
    const deleted = this.db.prepare('DELETE FROM document_perspectives WHERE document_id = ? AND perspective_id = ? AND version = ?')
      .run(documentId, id, expectedVersion)
    if (deleted.changes === 1) return true
    if (this.db.prepare('SELECT 1 FROM document_perspectives WHERE document_id = ? AND perspective_id = ?').get(documentId, id)) {
      throw Object.assign(new Error('视图已被修改，请刷新列表'), { code: 'perspective_conflict' })
    }
    return false
  }

  listRevisions(documentId, limit = 50) {
    return this.db.prepare('SELECT revision, parent_revision, kind, summary_json, created_at, snapshot_json IS NOT NULL AS restorable FROM graph_revisions WHERE document_id = ? ORDER BY revision DESC LIMIT ?')
      .all(documentId, Math.max(1, Math.min(200, int(limit, 50))))
  }

  restoreRevision(documentId, revision, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || !Number.isSafeInteger(revision) || revision < 1) throw Object.assign(new Error('restore requires revision and expectedRevision'), { code: 'invalid_input' })
    const row = this.db.prepare('SELECT snapshot_json FROM graph_revisions WHERE document_id = ? AND revision = ?').get(documentId, revision)
    if (!row?.snapshot_json) throw Object.assign(new Error('This revision has no restorable snapshot'), { code: 'snapshot_unavailable' })
    const snapshot = JSON.parse(row.snapshot_json)
    return this.saveGraph(snapshot.graph, {
      expectedRevision, kind: 'restore', sourceText: snapshot.graph.sourceText,
      sourceUnits: snapshot.sourceUnits,
    })
  }

  getDocument(documentId) {
    return this.#readDocumentSnapshot(() => this.#getDocument(documentId))
  }

  #getDocument(documentId) {
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

  /** Read a bounded graph window with optional full-graph structural diagnostics.
   * @param {string} documentId Canonical document identifier.
   * @param {object} options Window, query, edge and source-text limits. Optional
   * focusParagraph selects its ordinary page and requires expectedRevision.
   * @param {Function} [inspectStructure] Pure, synchronous full-graph inspector.
   * @returns {object|null} The window and diagnostics from the same SQLite snapshot.
   */
  getDocumentWindow(documentId, options = {}, inspectStructure) {
    // Cache only an independent read: an enclosing transaction may later roll
    // back, or retain a historical WAL snapshot. Older runtimes without an
    // explicit transaction flag safely keep the uncached path.
    const cacheable = !!inspectStructure && this.db.isTransaction === false
    let pending = null
    try {
      const result = this.#readDocumentSnapshot(() => {
        // data_version starts the SQLite read snapshot BEFORE the document
        // query. It fences other connections; total_changes fences this one,
        // including raw SQL, failed writes and delete/recreate at revision 1.
        const stamp = cacheable ? {
          dataVersion: this.db.prepare('PRAGMA data_version').get().data_version,
          localChanges: this.db.prepare('SELECT total_changes() AS changes').get().changes,
        } : null
        const window = this.#getDocumentWindow(documentId, options)
        if (window && !window.error && inspectStructure) {
          const cached = this.#windowStructureCache
          if (stamp && cached && cached.documentId === documentId && cached.inspector === inspectStructure &&
              cached.revision === window.revision && cached.dataVersion === stamp.dataVersion && cached.localChanges === stamp.localChanges) {
            window.graphStructureQuality = structuredClone(cached.quality)
            pending = cached
          } else {
            const quality = inspectStructure(this.getDocument(documentId))
            window.graphStructureQuality = quality
            if (stamp) {
              // Callers own their returned result. Retain only one detached
              // diagnostic, never the canonical graph or a mutable response.
              try { pending = { documentId, inspector: inspectStructure, revision: window.revision, ...stamp, quality: structuredClone(quality) } }
              catch { /* Non-cloneable custom inspectors remain uncached. */ }
            }
          }
        }
        return window
      })
      // Publish only after the savepoint has successfully released.
      if (cacheable) this.#windowStructureCache = pending
      return result
    } catch (error) {
      this.#windowStructureCache = null
      throw error
    }
  }

  #getDocumentWindow(documentId, options) {
    // Source omission must happen before SQLite converts the full text to a
    // Node string. Keep the complete document path for requested source text
    // and canonical diagnostics; project every metadata field used below.
    const documentSql = options.includeSourceText === false
      ? 'SELECT document_id, source_id, title, chars, paragraph_count, chunk_count, section_count, source_json, graph_meta_json, graph_revision FROM documents WHERE document_id = ?'
      : 'SELECT * FROM documents WHERE document_id = ?'
    const row = this.db.prepare(documentSql).get(documentId)
    if (!row) return null
    const locatingParagraph = options.focusParagraph !== undefined
    if (locatingParagraph && (!Number.isSafeInteger(options.focusParagraph) || options.focusParagraph < 0
      || !Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 || text(options.query).trim())) {
      return { error: { code: 'invalid_input', message: '原文定位需要非负整数段落编号和知识图版本，不能同时查询其他子图' } }
    }
    if (locatingParagraph && row.graph_revision !== options.expectedRevision) {
      return { error: { code: 'revision_conflict', message: '知识图版本已更新，请重新载入后定位', currentRevision: row.graph_revision } }
    }
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(2000, options.limit) : 800
    const edgeLimit = Math.max(limit, Math.min(12000, int(options.edgeLimit, limit * 6)))
    const totalNodesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE document_id = ?').get(documentId)
    const totalEdgesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE document_id = ?').get(documentId)
    const totalNodes = totalNodesRow ? Number(totalNodesRow.count) || 0 : 0
    const totalEdges = totalEdgesRow ? Number(totalEdgesRow.count) || 0 : 0
    const requestedOffset = Number.isInteger(options.offset) && options.offset > 0 ? options.offset : 0
    let offset = Math.min(requestedOffset, Math.max(0, totalNodes - 1))
    let focusNodeId = ''
    if (locatingParagraph) {
      const focus = this.db.prepare(`SELECT node_id FROM graph_nodes
        WHERE document_id = ? AND paragraph = ? ORDER BY node_id LIMIT 1`).get(documentId, options.focusParagraph)
      if (focus) {
        focusNodeId = focus.node_id
        // focus is already the first binary node ID in its paragraph, so no
        // same-paragraph row can precede it. Separate NULLs and earlier units
        // into covering index ranges instead of testing every document row.
        const preceding = this.db.prepare(`SELECT
          (SELECT COUNT(*) FROM graph_nodes WHERE document_id = ? AND paragraph IS NULL)
          + (SELECT COUNT(*) FROM graph_nodes WHERE document_id = ? AND paragraph < ?) AS count`)
          .get(documentId, documentId, options.focusParagraph)
        offset = Math.floor(Number(preceding.count) / limit) * limit
      } else offset = 0
    }
    const query = text(options.query).trim().slice(0, 200)

    const fetchNodesByIds = (ids, remaining) => {
      const result = []
      const unique = Array.from(new Set(ids.filter(Boolean)))
      for (let start = 0; start < unique.length && result.length < remaining; start += 400) {
        const part = unique.slice(start, start + 400)
        const marks = part.map(() => '?').join(',')
        // Resolve the bounded ID set before sorting complete records. Sorting
        // the direct IN query may instead scan the document/paragraph index.
        // Row identities stay inside this statement; preserve each batch's
        // original paragraph/node-ID order and subsequent budget handling.
        const rows = this.db.prepare('SELECT * FROM graph_nodes WHERE rowid IN (' +
          'SELECT rowid FROM graph_nodes WHERE document_id = ? AND node_id IN (' + marks +
          ')) ORDER BY paragraph, node_id').all(documentId, ...part)
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
        // Sparse selections otherwise scan the document's ordered edge index.
        // Probe narrow endpoint indexes without complete payloads, stopping
        // after the combined budget plus one. Small batches retain the 64-row
        // bound; larger batches may hydrate at most 2048 incident records.
        // Small graphs and dense selections keep the original ordered LIMIT.
        let indexed = false
        if (totalEdges >= 4096) {
          const budget = Math.min(part.length <= 64 ? 64 : 2048, remaining)
          const candidates = this.db.prepare(
            'SELECT COUNT(*) AS count FROM (SELECT 1 FROM (SELECT 1 FROM graph_edges WHERE document_id = ? AND from_node_id IN (' + marks + ') LIMIT ?) ' +
            'UNION ALL SELECT 1 FROM (SELECT 1 FROM graph_edges WHERE document_id = ? AND to_node_id IN (' + marks + ') LIMIT ?) LIMIT ?)'
          ).get(documentId, ...part, budget + 1, documentId, ...part, budget + 1, budget + 1)
          // Shared endpoints count twice: a conservative bound, not a total.
          indexed = candidates.count <= budget
        }
        const rows = indexed ? this.db.prepare(
          'SELECT * FROM graph_edges WHERE rowid IN (SELECT rowid FROM graph_edges WHERE document_id = ? AND from_node_id IN (' + marks + ') ' +
          'UNION SELECT rowid FROM graph_edges WHERE document_id = ? AND to_node_id IN (' + marks + ')) ORDER BY from_node_id, to_node_id, relation LIMIT ?'
        ).all(documentId, ...part, documentId, ...part, remaining) : this.db.prepare(
          'SELECT * FROM graph_edges WHERE document_id = ? AND (from_node_id IN (' + marks + ') OR to_node_id IN (' + marks + ')) ORDER BY from_node_id, to_node_id, relation LIMIT ?'
        ).all(documentId, ...part, ...part, remaining)
        for (const item of rows) result.set(item.edge_key || (item.from_node_id + '>' + item.to_node_id + ':' + item.relation), item)
      }
      return Array.from(result.values())
    }
    const fetchWindowEdges = (ids, maxRows) => {
      if (ids.length === 0) return []
      const unique = Array.from(new Set(ids.filter(Boolean)))
      const selected = JSON.stringify(unique)
      // Two indexed IN predicates can probe every pair of window IDs. Keep
      // the complete-graph bound for sparse large windows; otherwise probe
      // only outgoing index entries, stopping at 2049 without full payloads.
      // At least 64 IDs means 4096 pairs: at most 2048 outgoing entries can
      // safely use the same boolean membership test. Smaller sets and dense
      // selections keep their selective lookup, ordering, TEXT affinity and
      // LIMIT. The probe and full read share this document's read snapshot.
      let outgoing = totalEdges < unique.length * unique.length
      if (!outgoing && unique.length >= 64) {
        const candidates = this.db.prepare(
          'SELECT COUNT(*) AS count FROM (SELECT 1 FROM graph_edges WHERE document_id = ? AND from_node_id IN (SELECT value FROM json_each(?)) LIMIT ?)'
        ).get(documentId, selected, 2049)
        outgoing = candidates.count <= 2048
      }
      const destination = outgoing
        ? '(to_node_id IN (SELECT value FROM json_each(?))) = 1'
        : 'to_node_id IN (SELECT value FROM json_each(?))'
      return this.db.prepare(`SELECT * FROM graph_edges
        WHERE document_id = ?
          AND from_node_id IN (SELECT value FROM json_each(?))
          AND ${destination}
        ORDER BY from_node_id, to_node_id, relation LIMIT ?`)
        .all(documentId, selected, selected, maxRows)
    }

    let nodeRows = []
    let matchedNodes = null
    let viewKind = 'window'
    if (query) {
      viewKind = 'query'
      // '%' and '_' are user text, not LIKE syntax or disposable characters.
      // Use a literal substring only for these queries; retain ordinary LIKE
      // behavior (including its existing case folding) for all other inputs.
      const literal = /[%_]/.test(query)
      const pattern = literal ? query.toLowerCase() : '%' + query.toLowerCase() + '%'
      const where = literal ? `document_id = ? AND (
        INSTR(LOWER(node_id), ?) > 0 OR INSTR(LOWER(type), ?) > 0 OR INSTR(LOWER(text), ?) > 0 OR
        INSTR(LOWER(quote), ?) > 0 OR INSTR(LOWER(COALESCE(section_id, '')), ?) > 0 OR INSTR(LOWER(COALESCE(section_title, '')), ?) > 0
      )` : `document_id = ? AND (
        LOWER(node_id) LIKE ? OR LOWER(type) LIKE ? OR LOWER(text) LIKE ? OR
        LOWER(quote) LIKE ? OR LOWER(COALESCE(section_id, '')) LIKE ? OR LOWER(COALESCE(section_title, '')) LIKE ?
      )`
      const params = [documentId, pattern, pattern, pattern, pattern, pattern, pattern]
      const countMatches = () => {
        const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE ' + where).get(...params)
        return countRow ? Number(countRow.count) || 0 : 0
      }
      // An underfilled direct page already contains every match, including
      // zero, for both LIKE and literal predicates. Do not scan twice.
      // A full page still needs COUNT (even when exactly limit rows match).
      const direct = this.db.prepare('SELECT * FROM graph_nodes WHERE ' + where + ' ORDER BY paragraph, node_id LIMIT ?').all(...params, limit)
      matchedNodes = direct.length < limit ? direct.length : countMatches()
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
    } else if (!locatingParagraph || focusNodeId) {
      // Deep pages need only narrow row identities while sorting/skipping.
      // Hydrate this page in the same statement and restore canonical order;
      // rowids are transient here, never persisted or exposed to callers.
      // Keep shallow reads direct to avoid extra lookups for small offsets.
      const nodeSql = offset >= limit * 4
        ? `SELECT * FROM graph_nodes WHERE rowid IN (
            SELECT rowid FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id LIMIT ? OFFSET ?
          ) ORDER BY paragraph, node_id`
        : 'SELECT * FROM graph_nodes WHERE document_id = ? ORDER BY paragraph, node_id LIMIT ? OFFSET ?'
      nodeRows = this.db.prepare(nodeSql).all(documentId, limit, offset)
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
        ...(locatingParagraph ? { focusParagraph: options.focusParagraph, focusNodeId } : {}),
        ...(query ? { query, matchedNodes } : {}),
      },
    }
  }

  getGraphNeighborhood(documentId, options = {}) {
    return this.#readDocumentSnapshot(() => this.#getGraphNeighborhood(documentId, options))
  }

  #getGraphNeighborhood(documentId, options) {
    const row = this.db.prepare('SELECT graph_revision FROM documents WHERE document_id = ?').get(documentId)
    if (!row) return null
    const revision = row.graph_revision
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0 ||
        typeof options.centerId !== 'string' || !options.centerId || options.centerId.length > 160 ||
        !['both', 'in', 'out'].includes(options.direction || 'both') ||
        (options.relation != null && (typeof options.relation !== 'string' || options.relation.length > 160)) ||
        !Number.isSafeInteger(options.hops ?? 1) || (options.hops ?? 1) < 1 || (options.hops ?? 1) > 5 ||
        !Number.isSafeInteger(options.offset ?? 0) || (options.offset ?? 0) < 0 ||
        !Number.isSafeInteger(options.limit ?? 80) || (options.limit ?? 80) < 1 || (options.limit ?? 80) > 200) {
      return { error: { code: 'invalid_input', message: '无效的关系聚拢查询' } }
    }
    if (options.expectedRevision !== revision) return { error: { code: 'revision_conflict', message: '知识图版本已更新，请重新载入后聚拢', currentRevision: revision } }
    const centerId = options.centerId, direction = options.direction || 'both', relation = options.relation || '', hops = options.hops ?? 1
    const center = this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? AND node_id = ?').get(documentId, centerId)
    if (!center) return { error: { code: 'not_found', message: '中心节点已不存在，请重新载入知识图' } }
    // Walk only the current frontier through indexed edge lookups. A one-hop
    // query stays cheap even when the canonical document is much larger than
    // the rendering window; text and evidence are hydrated for one page only.
    const depthById = new Map([[centerId, 0]]), neighborRelations = new Map(), relationTypesSet = new Set()
    let frontier = [centerId]
    for (let depth = 1; depth <= hops && frontier.length; depth++) {
      const next = []
      const ids = JSON.stringify(frontier)
      const outSql = `SELECT from_node_id, to_node_id, relation FROM graph_edges
        WHERE document_id = ? AND from_node_id IN (SELECT value FROM json_each(?))`
      const inSql = `SELECT from_node_id, to_node_id, relation FROM graph_edges
        WHERE document_id = ? AND to_node_id IN (SELECT value FROM json_each(?))`
      const edges = direction === 'out' ? this.db.prepare(outSql).all(documentId, ids)
        : direction === 'in' ? this.db.prepare(inSql).all(documentId, ids)
          : this.db.prepare(outSql + ' UNION ' + inSql).all(documentId, ids, documentId, ids)
      const fromFrontier = new Set(frontier)
      for (const edge of edges) {
        const candidates = []
        if (direction !== 'in' && fromFrontier.has(edge.from_node_id)) candidates.push(edge.to_node_id)
        if (direction !== 'out' && fromFrontier.has(edge.to_node_id)) candidates.push(edge.from_node_id)
        for (const id of candidates) {
          relationTypesSet.add(edge.relation)
          if (relation && edge.relation !== relation) continue
          if (!depthById.has(id)) { depthById.set(id, depth); next.push(id) }
          if (depthById.get(id) === depth) {
            const previous = neighborRelations.get(id)
            if (previous === undefined || edge.relation < previous) neighborRelations.set(id, edge.relation)
          }
        }
      }
      frontier = next
    }
    const metadata = new Map(this.db.prepare(`SELECT node_id, paragraph FROM graph_nodes
      WHERE document_id = ? AND node_id IN (SELECT value FROM json_each(?))`)
      .all(documentId, JSON.stringify([...neighborRelations.keys()])).map(node => [node.node_id, node]))
    const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0
    const neighbors = [...neighborRelations.keys()].filter(id => metadata.has(id)).sort((a, b) => depthById.get(a) - depthById.get(b) || cmp(neighborRelations.get(a), neighborRelations.get(b)) ||
      (metadata.get(a).paragraph ?? Number.MAX_SAFE_INTEGER) - (metadata.get(b).paragraph ?? Number.MAX_SAFE_INTEGER) || cmp(a, b))
    const visibleTotal = Math.min(neighbors.length, 600)
    const offset = Math.min(options.offset ?? 0, visibleTotal), limit = options.limit ?? 80
    const pageIds = neighbors.slice(offset, Math.min(visibleTotal, offset + limit))
    const nextOffset = offset + pageIds.length
    const selected = [centerId, ...neighbors.slice(0, nextOffset)]
    const added = offset === 0 ? [centerId, ...pageIds] : pageIds
    const nodes = this.db.prepare(`SELECT * FROM graph_nodes WHERE document_id = ?
      AND node_id IN (SELECT value FROM json_each(?))`).all(documentId, JSON.stringify(pageIds)).map(nodeFromRow)
    const byId = new Map(nodes.map(n => [n.id, n]))
    // Each induced edge is delivered once, on the page that introduces its
    // last endpoint. UNION deduplicates reciprocal incident lookups, not edges.
    const edgeRows = this.db.prepare(`SELECT * FROM graph_edges WHERE document_id = ?
      AND from_node_id IN (SELECT value FROM json_each(?)) AND to_node_id IN (SELECT value FROM json_each(?))
      UNION SELECT * FROM graph_edges WHERE document_id = ?
      AND to_node_id IN (SELECT value FROM json_each(?)) AND from_node_id IN (SELECT value FROM json_each(?))`)
      .all(documentId, JSON.stringify(added), JSON.stringify(selected), documentId, JSON.stringify(added), JSON.stringify(selected))
      .filter(e => (!relation || e.relation === relation) &&
        (direction === 'both' || (e.from_node_id !== centerId && e.to_node_id !== centerId) ||
          (direction === 'in' ? e.to_node_id === centerId : e.from_node_id === centerId)))
    edgeRows.sort((a, b) => cmp(a.from_node_id, b.from_node_id) || cmp(a.to_node_id, b.to_node_id) || cmp(a.relation, b.relation))
    return { documentId, revision, centerId, direction, relation, hops,
      relationTypes: [...relationTypesSet].sort(), offset, nextOffset, neighborsTotal: neighbors.length,
      visibleTotal, truncated: visibleTotal < neighbors.length, hasMore: nextOffset < visibleTotal,
      nodes: [nodeFromRow(center), ...pageIds.map(id => byId.get(id))].map(node => ({ ...node, gatherDepth: depthById.get(node.id) })),
      edges: edgeRows.map(edgeFromRow) }
  }

  queryDocumentGraph(documentId, options = {}) {
    return this.#readDocumentSnapshot(() => this.#queryDocumentGraph(documentId, options))
  }

  #queryDocumentGraph(documentId, options) {
    const row = this.db.prepare('SELECT * FROM documents WHERE document_id = ?').get(documentId)
    if (!row) return null
    const revision = Number.isInteger(row.graph_revision) ? row.graph_revision : 0
    if (Number.isInteger(options.expectedRevision) && options.expectedRevision !== revision) {
      const error = new Error('graph revision conflict: expected ' + options.expectedRevision + ', current ' + revision)
      error.code = 'revision_conflict'
      error.currentRevision = revision
      throw error
    }
    const meta = parseJson(row.graph_meta_json, {})
    const sourceRaw = parseJson(row.source_json, {
      id: row.source_id,
      documentId: row.document_id,
      title: row.title,
      chars: row.chars,
      paragraphCount: row.paragraph_count,
      chunkCount: row.chunk_count,
      sectionCount: row.section_count,
    })
    // Validate against the canonical ontology inside the same snapshot as the
    // selected graph. Dropping an invalid filter would silently broaden it.
    const allowed = validateConsumeOptions(options, withManualModels(getOntology(ontologyIdOf({ ...meta, source: sourceRaw }))))
    const queryRaw = text(options.query).trim().slice(0, 600)
    const query = normalizeConsumeText(queryRaw)
    const terms = consumeTerms(queryRaw)
    const requestedNodeIds = boundedConsumeList(options.nodeIds, null, 40)
    const explicitIds = new Set(requestedNodeIds)
    const types = boundedConsumeList(options.types, allowed.types, allowed.types.size)
    const relations = boundedConsumeList(options.relations, allowed.relations, allowed.relations.size)
    const sectionIds = boundedConsumeList(options.sectionIds, null, 40)
    const grounding = boundedConsumeList(options.groundingStatuses, CONSUME_GROUNDING, CONSUME_GROUNDING.size)
    const entailment = boundedConsumeList(options.entailmentStatuses, CONSUME_ENTAILMENT, CONSUME_ENTAILMENT.size)
    const limit = Math.max(1, Math.min(40, int(options.limit, 20)))
    const hops = Math.max(0, Math.min(2, int(options.hops, 1)))
    const direction = options.direction === 'in' || options.direction === 'out' ? options.direction : 'both'
    const maxNodes = Math.max(1, Math.min(160, int(options.maxNodes, Math.min(160, limit * 4))))
    const directLimit = Math.min(limit, maxNodes)
    const maxEdges = Math.max(1, Math.min(480, int(options.maxEdges, Math.min(480, maxNodes * 3))))
    const candidateCap = Math.min(600, Math.max(80, limit * 15))
    const relationSeedOrder = new Map()
    let relationCandidateEdges = 0
    const hasNodeSelector = Boolean(query || requestedNodeIds.length > 0 || types.length > 0 || sectionIds.length > 0 || grounding.length > 0 || entailment.length > 0)
    const relationOnly = relations.length > 0 && !hasNodeSelector
    if (relationOnly) {
      const marks = relations.map(() => '?').join(',')
      const relationWhere = 'document_id = ? AND relation IN (' + marks + ')'
      const count = this.db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE ' + relationWhere).get(documentId, ...relations)
      relationCandidateEdges = count ? Number(count.count) || 0 : 0
      const seedEdges = this.db.prepare('SELECT from_node_id, to_node_id FROM graph_edges WHERE ' + relationWhere + ' ORDER BY edge_key LIMIT ?').all(documentId, ...relations, candidateCap)
      for (const edge of seedEdges) {
        for (const nodeId of [edge.from_node_id, edge.to_node_id]) {
          if (relationSeedOrder.size >= candidateCap) break
          if (!nodeId || relationSeedOrder.has(nodeId)) continue
          relationSeedOrder.set(nodeId, relationSeedOrder.size)
          explicitIds.add(nodeId)
        }
      }
    }
    const totalNodesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE document_id = ?').get(documentId)
    const totalEdgesRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_edges WHERE document_id = ?').get(documentId)
    const totalNodes = totalNodesRow ? Number(totalNodesRow.count) || 0 : 0
    const totalEdges = totalEdgesRow ? Number(totalEdgesRow.count) || 0 : 0

    const filterSql = []
    const filterParams = []
    const addInFilter = (column, values) => {
      if (values.length === 0) return
      filterSql.push(column + ' IN (' + values.map(() => '?').join(',') + ')')
      filterParams.push(...values)
    }
    addInFilter('type', types)
    addInFilter('section_id', sectionIds)
    addInFilter('grounding_status', grounding)
    addInFilter('entailment_status', entailment)
    const where = ['document_id = ?', ...filterSql]
    const params = [documentId, ...filterParams]
    if (relationOnly && explicitIds.size === 0) where.push('0')
    if (terms.length > 0) {
      const termSql = []
      for (const term of terms) {
        const pattern = '%' + term.replace(/[%_]/g, '') + '%'
        termSql.push('(LOWER(node_id) LIKE ? OR LOWER(type) LIKE ? OR LOWER(text) LIKE ? OR LOWER(quote) LIKE ? OR LOWER(COALESCE(section_id, \'\')) LIKE ? OR LOWER(COALESCE(section_title, \'\')) LIKE ?)')
        params.push(pattern, pattern, pattern, pattern, pattern, pattern)
      }
      // Structured fields need parsed, normalized text, not serialized JSON
      // matches (which can accidentally match provenance notes or escaped text).
      // Model candidates use the same bounded paging and ranking as other hits.
      where.push('(' + termSql.join(' OR ') + " OR type = 'connection_model')")
    }
    if (explicitIds.size > 0 && terms.length === 0) {
      const values = Array.from(explicitIds)
      where.push('node_id IN (' + values.map(() => '?').join(',') + ')')
      params.push(...values)
    }
    const whereSql = where.join(' AND ')
    const countRow = this.db.prepare('SELECT COUNT(*) AS count FROM graph_nodes WHERE ' + whereSql).get(...params)
    let candidateCount = countRow ? Number(countRow.count) || 0 : 0
    let lexicalCandidateCount = 0
    const scored = []
    const seenCandidates = new Set()
    const scoreRow = (item) => {
      if (!item || seenCandidates.has(item.node_id)) return
      seenCandidates.add(item.node_id)
      const value = consumeScore(item, query, terms, explicitIds, queryRaw)
      if (value && relationSeedOrder.has(item.node_id)) {
        value.score = Math.round((value.score + 500 - Math.min(100, relationSeedOrder.get(item.node_id) / 1000)) * 100) / 100
        value.reasons.unshift('关系端点')
      }
      if (value) { lexicalCandidateCount++; scored.push({ row: item, ...value }) }
    }
    const trimScored = () => {
      scored.sort((a, b) => b.score - a.score || (Number.isInteger(a.row.paragraph) ? a.row.paragraph : Number.MAX_SAFE_INTEGER) - (Number.isInteger(b.row.paragraph) ? b.row.paragraph : Number.MAX_SAFE_INTEGER) || a.row.node_id.localeCompare(b.row.node_id))
      if (scored.length > candidateCap) scored.splice(candidateCap)
    }
    if (terms.length > 0) {
      // Score every SQL-filtered lexical candidate in bounded pages instead of
      // scoring only the first paragraph-ordered 600 rows. Memory stays capped,
      // while an exact late-document match cannot be hidden by common early
      // bigrams (dynamic mode also scores the complete filtered candidate set).
      const pageSize = 600
      const paragraphKey = 'COALESCE(paragraph, 2147483647)'
      const pageStatement = this.db.prepare('SELECT * FROM graph_nodes WHERE ' + whereSql + ' AND ((' + paragraphKey + ' > ?) OR (' + paragraphKey + ' = ? AND node_id > ?)) ORDER BY ' + paragraphKey + ', node_id LIMIT ?')
      let lastParagraph = -1
      let lastNodeId = ''
      for (;;) {
        const page = pageStatement.all(...params, lastParagraph, lastParagraph, lastNodeId, pageSize)
        if (page.length === 0) break
        for (const item of page) scoreRow(item)
        if (scored.length > candidateCap * 2) trimScored()
        const last = page[page.length - 1]
        lastParagraph = Number.isInteger(last.paragraph) ? last.paragraph : 2147483647
        lastNodeId = last.node_id
        if (page.length < pageSize) break
      }
    } else {
      const candidateRows = this.db.prepare('SELECT * FROM graph_nodes WHERE ' + whereSql + ' ORDER BY paragraph, node_id LIMIT ?').all(...params, candidateCap)
      for (const item of candidateRows) scoreRow(item)
    }
    if (explicitIds.size > 0 && terms.length > 0) {
      const values = Array.from(explicitIds)
      const explicitWhere = ['document_id = ?', ...filterSql, 'node_id IN (' + values.map(() => '?').join(',') + ')'].join(' AND ')
      const explicitRows = this.db.prepare('SELECT * FROM graph_nodes WHERE ' + explicitWhere + ' ORDER BY paragraph, node_id').all(documentId, ...filterParams, ...values)
      for (const item of explicitRows) scoreRow(item)
    }
    if (terms.length > 0) candidateCount = lexicalCandidateCount
    trimScored()
    const direct = scored.slice(0, directLimit)
    const selectedRows = new Map(direct.map((item) => [item.row.node_id, item.row]))
    let frontier = new Set(selectedRows.keys())
    const edgeRows = new Map()

    const fetchNodesByIds = (ids) => {
      const result = []
      const unique = Array.from(new Set(ids.filter(Boolean)))
      for (let start = 0; start < unique.length; start += 350) {
        const part = unique.slice(start, start + 350)
        const marks = part.map(() => '?').join(',')
        result.push(...this.db.prepare('SELECT * FROM graph_nodes WHERE document_id = ? AND node_id IN (' + marks + ') ORDER BY paragraph, node_id').all(documentId, ...part))
      }
      result.sort((a, b) => (Number.isInteger(a.paragraph) ? a.paragraph : Number.MAX_SAFE_INTEGER) - (Number.isInteger(b.paragraph) ? b.paragraph : Number.MAX_SAFE_INTEGER) || a.node_id.localeCompare(b.node_id))
      return result
    }
    const fetchFrontierEdges = (ids, cap) => {
      const result = []
      const unique = Array.from(new Set(ids.filter(Boolean)))
      for (let start = 0; start < unique.length && result.length < cap; start += 240) {
        const part = unique.slice(start, start + 240)
        const marks = part.map(() => '?').join(',')
        const relationSql = relations.length > 0 ? ' AND relation IN (' + relations.map(() => '?').join(',') + ')' : ''
        const directionSql = direction === 'out'
          ? 'from_node_id IN (' + marks + ')'
          : direction === 'in'
            ? 'to_node_id IN (' + marks + ')'
            : '(from_node_id IN (' + marks + ') OR to_node_id IN (' + marks + '))'
        const sqlParams = direction === 'both'
          ? [documentId, ...relations, ...part, ...part, cap - result.length]
          : [documentId, ...relations, ...part, cap - result.length]
        const rows = this.db.prepare('SELECT * FROM graph_edges WHERE document_id = ?' + relationSql + ' AND ' + directionSql + ' ORDER BY from_node_id, to_node_id, relation LIMIT ?').all(...sqlParams)
        result.push(...rows)
      }
      return result
    }
    for (let depth = 0; depth < hops && frontier.size > 0 && selectedRows.size < maxNodes; depth++) {
      const fetchedEdges = fetchFrontierEdges(Array.from(frontier), maxEdges - edgeRows.size)
      const neighborIds = []
      for (const edge of fetchedEdges) {
        const key = edge.edge_key || (edge.from_node_id + '>' + edge.to_node_id + ':' + edge.relation)
        if (edgeRows.size < maxEdges) edgeRows.set(key, edge)
        const ids = direction === 'out' ? [edge.to_node_id] : direction === 'in' ? [edge.from_node_id] : [edge.from_node_id, edge.to_node_id]
        for (const id of ids) if (id && !selectedRows.has(id)) neighborIds.push(id)
      }
      const next = new Set()
      for (const node of fetchNodesByIds(neighborIds)) {
        if (selectedRows.size >= maxNodes) break
        if (selectedRows.has(node.node_id)) continue
        selectedRows.set(node.node_id, node)
        next.add(node.node_id)
      }
      frontier = next
    }
    const selectedIds = Array.from(selectedRows.keys())
    const selectedIdSet = new Set(selectedIds)
    for (let start = 0; start < selectedIds.length && edgeRows.size < maxEdges; start += 240) {
      const part = selectedIds.slice(start, start + 240)
      const marks = part.map(() => '?').join(',')
      const relationSql = relations.length > 0 ? ' AND relation IN (' + relations.map(() => '?').join(',') + ')' : ''
      const rows = this.db.prepare('SELECT * FROM graph_edges WHERE document_id = ?' + relationSql + ' AND from_node_id IN (' + marks + ') ORDER BY from_node_id, to_node_id, relation LIMIT ?').all(documentId, ...relations, ...part, maxEdges - edgeRows.size)
      for (const edge of rows) {
        if (!selectedIdSet.has(edge.to_node_id)) continue
        const key = edge.edge_key || (edge.from_node_id + '>' + edge.to_node_id + ':' + edge.relation)
        edgeRows.set(key, edge)
        if (edgeRows.size >= maxEdges) break
      }
    }
    const source = consumeSourceProjection(sourceRaw, row, revision)
    const returnedEdges = Array.from(edgeRows.values())
      .filter((edge) => selectedRows.has(edge.from_node_id) && selectedRows.has(edge.to_node_id))
      .slice(0, maxEdges)
    const projectedNodes = Array.from(selectedRows.values()).map(consumeNodeFromRow)
    const projectedEdges = returnedEdges.map(consumeEdgeFromRow)
    const directIds = new Set(direct.map((item) => item.row.node_id))
    const boundedGraph = boundConsumeGraph(projectedNodes, projectedEdges, directIds)
    const selectedNodes = boundedGraph.nodes
    const selectedEdges = boundedGraph.edges
    const graphSummary = text(meta.summary).slice(0, 2000)
    if (JSON.stringify(source).length + graphSummary.length > 60000) {
      throw Object.assign(new Error('来源与章节的完整身份超过检索预算'), { code: 'limit_exceeded' })
    }
    const modelNodes = selectedNodes.filter(node => node.type === 'connection_model').map(node => {
      const row = selectedRows.get(node.id)
      return { ...nodeFromRow(row), modelStructure: parseJson(row.attributes_json, {}).modelStructure }
    })
    const modelReadContext = {
      documentId, revision, budget: 60000 - JSON.stringify(source).length - graphSummary.length - 256,
      loadNodes: ids => new Map(fetchNodesByIds(ids).map(row => [row.node_id, nodeFromRow(row)])),
      loadUnits: paragraphs => {
        const units = new Map()
        for (let start = 0; start < paragraphs.length; start += 240) {
          const part = paragraphs.slice(start, start + 240), marks = part.map(() => '?').join(',')
          for (const unit of this.db.prepare('SELECT paragraph, text FROM document_units WHERE document_id = ? AND paragraph IN (' + marks + ')')
            .all(documentId, ...part)) units.set(unit.paragraph, unit.text)
        }
        return units
      },
    }
    const modelContexts = modelConsumptionTools.build(modelNodes, modelReadContext)
    const modelExampleContexts = modelConsumptionTools.buildExamples(modelNodes, modelContexts, { ...modelReadContext,
      budget: 60000 - JSON.stringify(source).length - graphSummary.length - JSON.stringify(modelContexts).length })
    const paragraphRefs = new Map()
    const addParagraphRef = (paragraph, nodeId, edgeId, quote, priority) => {
      if (!Number.isInteger(paragraph) || paragraph < 0) return
      let item = paragraphRefs.get(paragraph)
      if (!item) {
        item = { paragraph, priority: Number.isInteger(priority) ? priority : 2, nodeIds: new Set(), edgeIds: new Set(), quotes: [] }
        paragraphRefs.set(paragraph, item)
      } else if (Number.isInteger(priority)) item.priority = Math.min(item.priority, priority)
      if (nodeId) item.nodeIds.add(nodeId)
      if (edgeId) item.edgeIds.add(edgeId)
      const clipped = text(quote).trim().slice(0, 500)
      if (clipped && !item.quotes.includes(clipped) && item.quotes.length < 6) item.quotes.push(clipped)
    }
    for (const node of selectedNodes) {
      const priority = directIds.has(node.id) ? 0 : 2
      const evidence = Array.isArray(node.evidence) ? node.evidence : []
      if (evidence.length > 0) {
        for (const item of evidence) addParagraphRef(Number(item && item.paragraph), node.id, '', item && item.quote, priority)
      } else addParagraphRef(node.paragraph, node.id, '', node.quote, priority)
    }
    for (const edge of selectedEdges) {
      const key = edgeIdentity(edge)
      const priority = directIds.has(edge.fromNodeId) || directIds.has(edge.toNodeId) ? 1 : 2
      for (const item of Array.isArray(edge.evidence) ? edge.evidence : []) addParagraphRef(Number(item && item.paragraph), '', key, item && item.quote, priority)
    }
    for (const item of modelContexts.items.filter(item => item.status === 'recorded_core')) {
      for (const { provenance } of modelConsumptionTools.provenances(item.structure)) {
        if (provenance.kind === 'source') addParagraphRef(provenance.paragraph, item.modelId, '', provenance.quote, 0)
      }
    }
    for (const item of modelExampleContexts.items) {
      const provenance = item.example.provenance
      if (provenance.kind === 'source') addParagraphRef(provenance.paragraph, item.modelId, '', provenance.quote, 0)
    }
    const unitTextByParagraph = new Map()
    const referencedParagraphs = Array.from(paragraphRefs.keys()).sort((a, b) => a - b)
    for (let start = 0; start < referencedParagraphs.length; start += 240) {
      const part = referencedParagraphs.slice(start, start + 240)
      const marks = part.map(() => '?').join(',')
      for (const unit of this.db.prepare('SELECT paragraph, text FROM document_units WHERE document_id = ? AND paragraph IN (' + marks + ')').all(documentId, ...part)) {
        unitTextByParagraph.set(unit.paragraph, unit.text)
      }
    }
    const sourceUnits = []
    let sourceChars = 0
    const appendSourceUnit = (unit) => {
      if (!unit || sourceUnits.length >= CONSUME_SOURCE_UNITS) return false
      const unitText = text(unit.text).trim().slice(0, unit.sourceFallback ? 2000 : 1600)
      if (!unitText || sourceChars + unitText.length > CONSUME_SOURCE_CHARS) return false
      sourceChars += unitText.length
      sourceUnits.push({ ...unit, text: unitText })
      return true
    }
    for (const ref of Array.from(paragraphRefs.values()).sort((a, b) => a.priority - b.priority || a.paragraph - b.paragraph)) {
      const storedText = text(unitTextByParagraph.get(ref.paragraph)).trim()
      const fallback = ref.quotes.join(' … ')
      appendSourceUnit({
        paragraph: ref.paragraph,
        text: storedText || fallback,
        nodeIds: Array.from(ref.nodeIds),
        edgeIds: Array.from(ref.edgeIds),
      })
    }
    let sourceFallbackUnits = 0
    const sourceFallbackEvaluated = options.includeSourceFallback === true
    if (sourceFallbackEvaluated && query && terms.length > 0 && sourceUnits.length < CONSUME_SOURCE_UNITS && sourceChars < CONSUME_SOURCE_CHARS) {
      const seenParagraphs = new Set(sourceUnits.map((unit) => unit.paragraph))
      const termSql = []
      const termParams = []
      for (const term of terms) {
        const pattern = '%' + term.replace(/[%_]/g, '') + '%'
        termSql.push('LOWER(text) LIKE ?')
        termParams.push(pattern)
      }
      const fallbackWhere = 'document_id = ? AND (' + termSql.join(' OR ') + ')'
      const fallbackStatement = this.db.prepare('SELECT paragraph, text FROM document_units WHERE ' + fallbackWhere + ' AND paragraph > ? ORDER BY paragraph LIMIT ?')
      const ranked = []
      const pageSize = 600
      let lastParagraph = -1
      for (;;) {
        const page = fallbackStatement.all(documentId, ...termParams, lastParagraph, pageSize)
        if (page.length === 0) break
        for (const unit of page) {
          if (seenParagraphs.has(unit.paragraph)) continue
          const score = consumeSourceScore(unit.text, query, terms)
          if (score > 0) ranked.push({ paragraph: unit.paragraph, text: unit.text, score })
        }
        if (ranked.length > 64) {
          ranked.sort((a, b) => b.score - a.score || a.paragraph - b.paragraph)
          ranked.splice(32)
        }
        lastParagraph = page[page.length - 1].paragraph
        if (page.length < pageSize) break
      }
      ranked.sort((a, b) => b.score - a.score || a.paragraph - b.paragraph)
      for (const unit of ranked.slice(0, CONSUME_SOURCE_FALLBACK)) {
        if (!appendSourceUnit({
          paragraph: unit.paragraph,
          text: unit.text,
          nodeIds: [], edgeIds: [],
          sourceFallback: true, score: unit.score,
        })) continue
        sourceFallbackUnits += 1
      }
    }
    const matches = direct.map((item) => ({ nodeId: item.row.node_id, score: item.score, reasons: item.reasons.slice(0, 4),
      ...(item.modelFieldMatches ? { modelFieldMatches: item.modelFieldMatches } : {}) }))
    const contextChars = boundedGraph.contextChars + sourceChars + graphSummary.length + JSON.stringify(source).length
      + JSON.stringify(modelContexts).length + JSON.stringify(modelExampleContexts).length
    const view = {
      kind: 'consumption', query: queryRaw, directMatches: direct.length,
      candidateMatches: candidateCount, relationCandidateEdges, totalNodes, totalEdges,
      returnedNodes: selectedNodes.length, returnedEdges: selectedEdges.length,
      hops, direction,
      truncated: candidateCount > direct.length || selectedRows.size >= maxNodes || edgeRows.size >= maxEdges || boundedGraph.truncated,
    }
    const result = {
      queryId: 'kgq-' + stableHash(JSON.stringify({
        documentId, revision, query: queryRaw,
        nodeIds: requestedNodeIds.slice().sort(), types: types.slice().sort(), relations: relations.slice().sort(),
        sectionIds: sectionIds.slice().sort(), groundingStatuses: grounding.slice().sort(), entailmentStatuses: entailment.slice().sort(),
        limit, hops, direction, maxNodes, maxEdges,
      })).slice(0, 24),
      documentId,
      revision,
      query: queryRaw,
      matches,
      modelContexts,
      modelExampleContexts,
      graph: {
        summary: graphSummary,
        source,
        nodes: selectedNodes,
        edges: selectedEdges,
        view,
      },
      sourceUnits,
      metrics: {
        candidateMatches: candidateCount,
        relationCandidateEdges,
        directMatches: direct.length,
        returnedNodes: selectedNodes.length,
        returnedEdges: selectedEdges.length,
        sourceUnits: sourceUnits.length,
        sourceRefsOmitted: Math.max(0, paragraphRefs.size - sourceUnits.filter((unit) => unit.sourceFallback !== true).length),
        sourceFallbackUnits,
        sourceFallbackEvaluated,
        modelContextChars: JSON.stringify(modelContexts).length,
        modelExampleContextChars: JSON.stringify(modelExampleContexts).length,
        contextChars,
        contextBudget: CONSUME_CONTEXT_CHARS + CONSUME_SOURCE_CHARS + 60000,
        hops,
      },
    }
    if (contextChars > result.metrics.contextBudget || JSON.stringify(result).length > result.metrics.contextBudget + 20000) {
      throw Object.assign(new Error('完整身份与引用超过检索响应预算，请缩小范围'), { code: 'limit_exceeded' })
    }
    return result
  }

  commitViewGraph(options = {}) {
    if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 0) {
      throw Object.assign(new Error('graph commit requires a non-negative expectedRevision'), { code: 'invalid_input' })
    }
    const documentId = text(options.documentId)
    const incoming = options.graph && typeof options.graph === 'object' ? options.graph : null
    if (!documentId || !incoming) throw new Error('documentId and graph are required')
    const current = this.getDocument(documentId)
    if (!current) {
      const error = new Error('document not found: ' + documentId)
      error.code = 'not_found'
      throw error
    }
    const expectedRevision = options.expectedRevision
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
