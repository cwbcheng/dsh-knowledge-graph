import { createGraphContract } from './index.host.js'

const contract = createGraphContract()
const nodeTypes = new Set(contract.nodeTypes)
const relations = new Set(contract.relations)

function invalid(message, code = 'invalid_graph') {
  return Object.assign(new Error(message), { code })
}

export function prepareGraphImport(input) {
  if (!input || !Array.isArray(input.nodes) || !input.nodes.length || !Array.isArray(input.edges)) throw invalid('Import requires a non-empty graph')
  if (typeof input.sourceText !== 'string' || !input.sourceText.trim()) throw invalid('Import requires the full sourceText')
  if (!input.source || typeof input.source.documentId !== 'string' || !input.source.documentId.trim() || input.source.documentId !== input.source.documentId.trim() || input.source.documentId.length > 160) throw invalid('Import requires a canonical source.documentId (1-160 characters)')
  if (input.view?.truncated || input.view?.totalNodes > input.nodes.length) throw invalid('Cannot import a truncated graph view')
  if (input.generation?.status && !['succeeded', 'succeeded_with_warnings'].includes(input.generation.status)) throw invalid('Cannot publish a partial or failed generation')
  if (input.staging?.chunks?.some(chunk => chunk.status && chunk.status !== 'completed')) throw invalid('Cannot publish unfinished chunks')
  if (input.nodes.some(node => !node || !nodeTypes.has(node.type)) || input.edges.some(edge => !edge || !relations.has(edge.relation))) throw invalid('Unknown canonical node type or relation')
  const graph = structuredClone(input)
  delete graph.verification
  delete graph.factCheck
  if (new Set(graph.nodes.map(node => node.id)).size !== graph.nodes.length) throw invalid('Duplicate node IDs')
  if (graph.nodes.some(node => typeof node.id !== 'string' || !node.id.trim() || node.id !== node.id.trim() || typeof node.text !== 'string' || !node.text.trim() || node.text !== node.text.trim())) throw invalid('Invalid node identity or text')
  const paragraphs = contract.splitParagraphs(graph.sourceText)
  graph.source.chars = graph.sourceText.length
  graph.source.paragraphCount = paragraphs.length
  const authentic = item => item && Number.isInteger(item.paragraph) && item.paragraph >= 0 && item.paragraph < paragraphs.length
    && typeof item.quote === 'string' && Boolean(contract.exactOrUniqueTypographicQuote(paragraphs[item.paragraph], item.quote))
  for (const node of graph.nodes) {
    if (node.quote != null && (typeof node.quote !== 'string' || (node.quote.trim() && !authentic(node)))) throw invalid('Node quote does not match its source paragraph', 'invalid_evidence')
  }
  for (const item of [...graph.nodes, ...graph.edges]) {
    if (item.evidence != null && !Array.isArray(item.evidence)) throw invalid('Evidence must be an array', 'invalid_evidence')
    if ((item.evidence || []).some(evidence => !authentic(evidence))) throw invalid('Evidence quote does not match its source paragraph', 'invalid_evidence')
  }
  // An imported file cannot act as the independent entailment authority.
  for (const node of graph.nodes) node.entailmentStatus = 'unverified'
  contract.authenticateGraphEvidence(graph, graph.sourceText)
  const validation = contract.validateGraphInvariants(graph, graph.sourceText, { includeQuality: true })
  if (validation.blockingIssues.length) {
    throw Object.assign(invalid('Graph failed canonical validation: ' + validation.blockingIssues.map(issue => issue.code).join(', '), 'invariant_violation'), { issues: validation.blockingIssues })
  }
  return { graph, validation, sourceUnits: paragraphs.map((text, paragraph) => ({ paragraph, text })) }
}

export function importGraph(store, input, options = {}) {
  const prepared = prepareGraphImport(input)
  const expectedRevision = options.expectedRevision === undefined ? 0 : options.expectedRevision
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw invalid('expectedRevision must be a non-negative integer')
  const currentRevision = store.getDocumentRevision(prepared.graph.source.documentId)
  if (currentRevision !== expectedRevision) throw invalid('Import revision conflict: expected ' + expectedRevision + ', current ' + currentRevision + '; use an explicit --expected-revision to replace a document', 'revision_conflict')
  if (options.dryRun) return { dryRun: true, documentId: prepared.graph.source.documentId, revision: currentRevision, issues: prepared.validation.issues }
  const result = store.saveGraph(prepared.graph, {
    title: options.title,
    sourceText: prepared.graph.sourceText,
    sourceUnits: prepared.sourceUnits,
    expectedRevision,
    kind: 'import',
  })
  return { ...result, issues: prepared.validation.issues }
}
