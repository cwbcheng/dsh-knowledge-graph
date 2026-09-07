#!/usr/bin/env node
/**
 * Normalize a raw LLM extraction into the repo's canonical node/edge shape,
 * mirroring src/index.host.js normalizeGraph + exactOrUniqueTypographicQuoteHost.
 *
 * The host plugin applies this after every model call before admitting nodes; a
 * standalone pipeline must do the same or it will hand saveGraph a malformed /
 * ungrounded graph. In particular:
 *   - node type / relation are mapped through the same alias tables;
 *   - each fact/claim/inference/rule/definition/counter_example node is grounded:
 *     its `quote` must be found in the designated source paragraph, otherwise it
 *     is downgraded to 'unsupported'/'candidate' rather than trusted;
 *   - every edge must carry a quote that directly proves the relation, from a
 *     paragraph range that is in scope;
 *   - paragraph indices are validated against the actual segmentation.
 */

const TYPE_ALIASES = {
  fact: 'fact', 事实: 'fact',
  claim: 'claim', 主张: 'claim', 观点: 'claim',
  inference: 'inference', 推论: 'inference',
  concept: 'concept', 概念: 'concept',
  definition: 'definition', 定义: 'definition',
  example: 'example', 例子: 'example',
  counter_example: 'counter_example', counterexample: 'counter_example', 'counter-example': 'counter_example', 反例: 'counter_example',
  rule: 'rule', 规则: 'rule',
}

const REL_ALIASES = {
  supports: 'supports', support: 'supports', 支持: 'supports',
  example: 'example', example_of: 'example', 例子: 'example',
  counter_example: 'counter_example', counterexample: 'counter_example', 反例: 'counter_example',
  defines: 'defines', define: 'defines', 定义: 'defines',
  infers: 'infers', infer: 'infers', implies: 'infers', 推断: 'infers',
  causes: 'causes', cause: 'causes', 因果: 'causes', 导致: 'causes', drives: 'causes', drive: 'causes', 驱动: 'causes',
  is_a: 'is_a', isa: 'is_a', 属于: 'is_a',
  contains: 'contains', contain: 'contains', 包含: 'contains',
  driven_by: 'driven_by', drivenby: 'driven_by', 受驱动于: 'driven_by',
  not_is: 'not_is', notis: 'not_is', 不是: 'not_is', 不等于: 'not_is',
  analogy: 'analogy', analogizes: 'analogy', 类比: 'analogy', 类比说明: 'analogy',
  aims_at: 'aims_at', aim_at: 'aims_at', 旨在: 'aims_at',
}

export const VALID_NODE_TYPES = new Set(Object.keys(TYPE_ALIASES).filter((k) => k === TYPE_ALIASES[k]))
export const VALID_RELATIONS = new Set(Object.keys(REL_ALIASES).filter((k) => k === REL_ALIASES[k]))

// Quote authentication: fold typographic variants and whitespace, then require a
// unique match inside the target text (mirrors the host).
const DOUBLE_QUOTES = new Set(['"', '“', '”', '„', '‟', '「', '」', '『', '』'])
const SINGLE_QUOTES = new Set(["'", '‘', '’', '‚', '‛'])
const IDEO_SPACE = String.fromCharCode(12288)

function foldTypography(value) {
  const source = String(value || '')
  const chars = []
  const map = []
  let lastWasSpace = true
  for (let i = 0; i < source.length; i++) {
    const raw = source[i]
    let ch = raw
    if (DOUBLE_QUOTES.has(raw)) ch = '"'
    else if (SINGLE_QUOTES.has(raw)) ch = "'"
    else if (/\s/.test(raw) || raw === IDEO_SPACE) ch = ' '
    if (ch === ' ') {
      if (lastWasSpace) continue
      chars.push(' ')
      map.push(i)
      lastWasSpace = true
      continue
    }
    chars.push(ch)
    map.push(i)
    lastWasSpace = false
  }
  if (chars.length > 0 && chars[chars.length - 1] === ' ') { chars.pop(); map.pop() }
  return { text: chars.join(''), map }
}

export function exactOrUniqueTypographicQuote(sourceText, rawQuote) {
  const source = String(sourceText || '')
  const quote = String(rawQuote || '').trim().slice(0, 600)
  if (!source || !quote) return ''
  if (source.includes(quote)) return quote
  const foldedSource = foldTypography(source)
  const foldedQuote = foldTypography(quote).text
  if (!foldedQuote) return ''
  const first = foldedSource.text.indexOf(foldedQuote)
  if (first < 0 || foldedSource.text.indexOf(foldedQuote, first + 1) >= 0) return ''
  const last = first + foldedQuote.length - 1
  const startOffset = foldedSource.map[first]
  const endOffset = foldedSource.map[last]
  if (!Number.isInteger(startOffset) || !Number.isInteger(endOffset)) return ''
  return source.slice(startOffset, endOffset + 1).trim()
}

function evidenceRecord(paragraph, quote, context) {
  const out = { paragraph, quote }
  if (context && context.documentId) out.documentId = context.documentId
  if (context && context.sourceId) out.sourceId = context.sourceId
  if (context && context.chunkId) out.chunkId = context.chunkId
  return out
}

function normalizeRelationEvidence(rawEvidence, totalParagraphs, context, warnings, edgeLabel) {
  const out = []
  const paragraphs = context && Array.isArray(context.paragraphTexts) ? context.paragraphTexts : null
  for (const item of Array.isArray(rawEvidence) ? rawEvidence : []) {
    if (!item || typeof item !== 'object') continue
    const rawParagraph = item.paragraph != null ? item.paragraph : item.para
    const paragraph = Number(String(rawParagraph == null ? '' : rawParagraph).trim())
    const quote = typeof item.quote === 'string' ? item.quote.trim().slice(0, 600) : ''
    if (!Number.isInteger(paragraph) || paragraph < 0 || paragraph >= totalParagraphs || !quote) continue
    let authenticatedQuote = quote
    if (paragraphs && typeof paragraphs[paragraph] === 'string') {
      authenticatedQuote = exactOrUniqueTypographicQuote(paragraphs[paragraph], quote)
      if (!authenticatedQuote) continue
    }
    out.push(evidenceRecord(paragraph, authenticatedQuote, context))
    if (out.length >= 8) break
  }
  if (out.length === 0 && warnings) warnings.push('edge_dropped:missing_relation_evidence:' + edgeLabel)
  return out
}

/**
 * Normalize one model extraction object. `context` carries paragraphTexts,
 * totalParagraphs, documentId, sourceId, chunkId, paragraphMeta.
 * Returns { summary, nodes, edges, warnings }.
 */
export function normalizeGraph(obj, totalParagraphs, extraIds, context) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { error: '结果不是 JSON 对象' }
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  if (!Array.isArray(obj.nodes)) return { error: '缺少 nodes 数组' }
  if (!Array.isArray(obj.edges)) return { error: '缺少 edges 数组' }

  const warnings = []
  const nodes = []
  const seen = new Set()

  for (const n of obj.nodes) {
    if (!n || typeof n !== 'object') { warnings.push('node_dropped:not_object'); continue }
    const id = typeof n.id === 'string' ? n.id.trim() : ''
    if (!id) { warnings.push('node_dropped:missing_id'); continue }
    if (seen.has(id)) { warnings.push('node_dropped:duplicate_id:' + id); continue }
    const type = TYPE_ALIASES[typeof n.type === 'string' ? n.type.trim().toLowerCase() : '']
    if (!type) { warnings.push('node_dropped:unknown_type:' + id); continue }
    const text = typeof n.text === 'string' ? n.text.trim() : ''
    if (!text) { warnings.push('node_dropped:empty_text:' + id); continue }
    const quote = typeof n.quote === 'string' ? n.quote.trim() : ''
    if (!quote) warnings.push('node_missing_quote:' + id)

    const rawP = n.paragraph != null ? n.paragraph : (n.para != null ? n.para : n.paragraphIndex)
    let pNum = null
    if (rawP != null) {
      const num = Number(String(rawP).trim())
      if (isFinite(num) && num >= 0 && Math.floor(num) === num) pNum = num
    }
    if (rawP == null) warnings.push('node_missing_paragraph:' + id)
    else if (pNum == null) warnings.push('node_paragraph_invalid:' + id)
    else if (pNum >= totalParagraphs) { warnings.push('node_paragraph_out_of_range:' + id); pNum = null }

    const paragraphMeta = context && Array.isArray(context.paragraphMeta) && pNum != null
      ? context.paragraphMeta[pNum]
      : null
    const paragraphs = context && Array.isArray(context.paragraphTexts) ? context.paragraphTexts : null
    const sourceParagraph = paragraphs && pNum != null && typeof paragraphs[pNum] === 'string' ? paragraphs[pNum] : ''
    const authenticatedQuote = quote && pNum != null && sourceParagraph ? exactOrUniqueTypographicQuote(sourceParagraph, quote) : ''
    const quoteAuthenticated = Boolean(authenticatedQuote)
    const evidence = quoteAuthenticated ? [evidenceRecord(pNum, authenticatedQuote, context)] : []
    const sourceFields = context && context.sourceId
      ? {
          documentId: context.documentId || null,
          sourceId: context.sourceId,
          chunkId: context.chunkId || null,
          sectionId: paragraphMeta && paragraphMeta.sectionId ? paragraphMeta.sectionId : null,
          sectionTitle: paragraphMeta && paragraphMeta.sectionTitle ? paragraphMeta.sectionTitle : null,
        }
      : {}
    const groundingStatus = evidence.length > 0 ? 'grounded' : (quote ? 'unsupported' : 'candidate')
    const entailmentStatus = 'unverified'
    seen.add(id)
    nodes.push({ id, type, text, quote, paragraph: pNum, evidence, groundingStatus, entailmentStatus, ...sourceFields })
  }

  const edges = []
  for (const e of obj.edges) {
    if (!e || typeof e !== 'object') { warnings.push('edge_dropped:not_object'); continue }
    const from = typeof e.fromNodeId === 'string' ? e.fromNodeId.trim() : ''
    const to = typeof e.toNodeId === 'string' ? e.toNodeId.trim() : ''
    const relation = REL_ALIASES[typeof e.relation === 'string' ? e.relation.trim().toLowerCase() : '']
    if (!relation) { warnings.push('edge_dropped:unknown_relation:' + from + '->' + to); continue }
    if (!seen.has(from) && !(extraIds && extraIds.has(from))) { warnings.push('edge_dropped:missing_endpoint:' + from + '->' + to); continue }
    if (!seen.has(to) && !(extraIds && extraIds.has(to))) { warnings.push('edge_dropped:missing_endpoint:' + from + '->' + to); continue }
    if (from === to) { warnings.push('edge_dropped:self_loop:' + from); continue }
    const edgeEvidence = normalizeRelationEvidence(e.evidence, totalParagraphs, context, warnings, from + '->' + to + ':' + relation)
    if (edgeEvidence.length === 0) continue
    edges.push({
      fromNodeId: from,
      toNodeId: to,
      relation,
      evidence: edgeEvidence,
      ...(context && context.sourceId ? {
        documentId: context.documentId || null,
        sourceId: context.sourceId,
        chunkId: context.chunkId || null,
      } : {}),
    })
  }

  return { summary, nodes, edges, warnings }
}

export function mergeBatch(batch, acc, batchIndex) {
  const prefix = 'batch' + (batchIndex + 1) + ':'
  for (const w of batch.warnings) acc.warnings.push(prefix + w)
  for (const node of batch.nodes) {
    if (!acc.nodes.has(node.id)) {
      acc.nodes.set(node.id, node)
      acc.ids.push(node.id)
    }
  }
  for (const e of batch.edges) {
    if (!acc.nodes.has(e.fromNodeId) || !acc.nodes.has(e.toNodeId)) {
      acc.warnings.push(prefix + 'edge_dropped:missing_endpoint:' + e.fromNodeId + '->' + e.toNodeId)
      continue
    }
    if (e.fromNodeId === e.toNodeId) {
      acc.warnings.push(prefix + 'edge_dropped:self_loop:' + e.fromNodeId)
      continue
    }
    const key = e.fromNodeId + '>' + e.toNodeId + ':' + e.relation
    if (acc.edgeKeys.has(key)) {
      const existing = acc.edges.find((edge) => edge && edge.fromNodeId === e.fromNodeId && edge.toNodeId === e.toNodeId && edge.relation === e.relation)
      if (existing) existing.evidence = mergeEvidenceRecords(existing.evidence, e.evidence, 8)
      acc.warnings.push(prefix + 'edge_merged:duplicate:' + key)
      continue
    }
    acc.edgeKeys.add(key)
    acc.edges.push(e)
    acc.ids.push('__edge_' + key)
  }
}

function mergeEvidenceRecords(primary, secondary, limit) {
  const cap = Number.isInteger(limit) && limit > 0 ? limit : 8
  const out = []
  const seen = new Set()
  for (const item of [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]) {
    if (!item || typeof item !== 'object' || out.length >= cap) continue
    const quote = typeof item.quote === 'string' ? item.quote.trim().slice(0, 600) : ''
    const paragraph = Number(item.paragraph)
    if (!Number.isInteger(paragraph) || paragraph < 0 || !quote) continue
    const key = paragraph + '|' + quote
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ paragraph, quote, ...(item.documentId ? { documentId: item.documentId } : {}), ...(item.sourceId ? { sourceId: item.sourceId } : {}), ...(item.chunkId ? { chunkId: item.chunkId } : {}) })
  }
  return out
}
