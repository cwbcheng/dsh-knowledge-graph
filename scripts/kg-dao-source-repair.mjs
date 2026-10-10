import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { createGraphContract } from '../src/index.host.js'
import { createSourceRelationTools } from '../src/kg-source-relations.mjs'
import { daoEndpoints, daoClauses, daoBoundaries } from './fixtures/dao-source-relations.mjs'

export const DAO_DOCUMENT = 'document-e297c2a5-20fa-4825-a952-2ccf4bc732ec'
const prefix = 'dao-source-20261010-c-'
const modelPrefix = 'dao-connection-20261007-m-'
const edgeKey = edge => edge.fromNodeId + '>' + edge.toNodeId + ':' + edge.relation
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

// Pure, deterministic preparation. Does not contact a service or modify a graph.
export function prepareDaoSourceRepair(document, sourceUnits) {
  if (document.documentId !== DAO_DOCUMENT || document.graph?.ontology !== 'aggregate-v1') throw new Error('Unexpected target document or ontology')
  const original = document.graph, graph = structuredClone(original)
  const units = new Map(sourceUnits.map(unit => [unit.paragraph, unit.text]))
  if (units.size !== sourceUnits.length || units.size !== 254) throw new Error('Expected the 254 stored source units, with unique identities')
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const models = Object.keys(daoBoundaries).map(key => nodes.get(modelPrefix + key))
  if (models.some(model => model?.type !== 'connection_model' || !model.modelStructure)) throw new Error('The ten reviewed models are required')
  const beforeModelHash = hash(models)
  const modelIds = new Set(models.map(model => model.id))
  const oldPorts = graph.edges.filter(edge => edge.relation === 'maps_between' && modelIds.has(edge.fromNodeId))
  graph.edges = graph.edges.filter(edge => !oldPorts.includes(edge))
  for (const model of models) model.modelStructure = { ...model.modelStructure, identity: 'hypothesis', slots: [], branches: [], examples: [] }
  const endpointIds = new Map(), endpointUsage = new Map(), clauses = []
  const provenance = (paragraph, quote) => ({ kind: 'source', paragraph, quote, note: '沿用存储的现代整理工作文本；逐字出处不是经验真值认证。' })
  function endpoint(key, paragraph, quote) {
    if (endpointIds.has(key)) return endpointIds.get(key)
    const label = daoEndpoints[key]
    if (!label) throw new Error('Unknown scoped endpoint ' + key)
    const id = label.startsWith('@') ? label.slice(1) : prefix + key
    if (label.startsWith('@')) {
      if (nodes.get(id)?.type !== 'concept' || nodes.get(id).state === 'rejected') throw new Error('Existing concept unavailable: ' + id)
    } else {
      if (nodes.has(id)) throw new Error('Repair endpoint already exists; inspect current revision rather than overwriting')
      const evidence = [{ paragraph, quote }]
      const node = { id, type: 'concept', text: label, paragraph, quote, evidence, contentLayer: 'main',
        state: 'candidate', groundingStatus: 'grounded', entailmentStatus: 'unverified' }
      graph.nodes.push(node); nodes.set(id, node)
    }
    endpointIds.set(key, id)
    return id
  }
  for (const [modelKey, branchId, p, fromKey, toKey, statement, condition, contextP] of daoClauses) {
    const paragraph = p - 1, quote = units.get(paragraph), contextParagraph = (contextP || p) - 1
    const contextQuote = units.get(contextParagraph)
    if (!quote?.includes(statement) || !contextQuote || condition && !contextQuote.includes(condition)) throw new Error('Source mismatch at P' + p + ' / ' + branchId)
    const modelId = modelPrefix + modelKey, model = nodes.get(modelId)
    const from = endpoint(fromKey, paragraph, quote), to = endpoint(toKey, paragraph, quote)
    const use = endpointUsage.get(modelId) || new Map(); endpointUsage.set(modelId, use)
    for (const [id, role] of [[from, 'input'], [to, 'output']]) {
      if (!use.has(id)) use.set(id, { roles: new Set(), paragraph, quote })
      use.get(id).roles.add(role)
    }
    model.modelStructure.branches.push({ id: branchId, label: statement.slice(0, 180),
      condition: { text: condition || contextQuote, provenance: provenance(contextParagraph, contextQuote) },
      mapping: { text: statement, provenance: provenance(paragraph, quote) },
      boundary: { text: daoBoundaries[modelKey], provenance: { kind: 'ai', paragraph: null, quote: '', note: '整理时所加的解释范围说明，不冒充原文。' } } })
    clauses.push({ modelId, branchId, from, to, paragraph, quote, statement })
  }
  for (const model of models) {
    const use = endpointUsage.get(model.id)
    for (const [conceptId, item] of use) {
      const role = item.roles.has('input') ? 'input' : 'output'
      model.modelStructure.slots.push({ id: 's' + (model.modelStructure.slots.length + 1), conceptId,
        label: nodes.get(conceptId).text.slice(0, 200), role, unit: '',
        state: item.roles.size === 2 ? '既为中间结果又为后续前项，具体角色以各分支条件和原文对应为准' : '仅在各分支所列语境中解读，不作全称断言',
        provenance: provenance(item.paragraph, item.quote) })
      graph.edges.push({ fromNodeId: model.id, toNodeId: conceptId, relation: 'maps_between', role,
        evidence: [{ paragraph: item.paragraph, quote: item.quote }], state: 'candidate' })
    }
  }
  const tools = createSourceRelationTools(), newRelations = []
  const existing = new Set(graph.edges.map(edgeKey))
  for (const clause of clauses) {
    const edge = tools.build(graph, clause.modelId, clause.branchId, clause.from, clause.to)
    if (existing.has(edgeKey(edge))) throw new Error('Ambiguous duplicate correspondence; preserve distinct scoped endpoints')
    existing.add(edgeKey(edge)); graph.edges.push(edge); newRelations.push(edge)
    // A referenced concept can depend on the original, locatable rule. This
    // joins the rule material to its actual input without adding a causal edge.
    for (const old of original.edges.filter(item => item.fromNodeId === clause.modelId && item.relation === 'has_rule')) {
      const rule = nodes.get(old.toNodeId)
      if (rule?.paragraph !== clause.paragraph || !rule.quote?.includes(clause.statement)) continue
      const attachment = { fromNodeId: clause.from, toNodeId: rule.id, relation: 'has_rule',
        evidence: [{ paragraph: clause.paragraph, quote: clause.quote }], state: 'candidate' }
      if (!existing.has(edgeKey(attachment))) { existing.add(edgeKey(attachment)); graph.edges.push(attachment) }
    }
  }
  const gate = createGraphContract().validateGraphInvariants(graph, document.sourceText, { includeQuality: false, sourceUnits })
  if (gate.blockingIssues.length) throw new Error('Repair rejected: ' + JSON.stringify(gate.blockingIssues.slice(0, 8)))
  const originalIds = new Set(original.nodes.map(node => node.id))
  const newEdges = graph.edges.filter(edge => !original.edges.some(old => edgeKey(old) === edgeKey(edge)))
  const request = { documentId: DAO_DOCUMENT, expectedRevision: document.revision,
    baseNodeIds: models.map(model => model.id), baseEdgeKeys: oldPorts.map(edgeKey),
    graph: { nodes: graph.nodes.filter(node => modelIds.has(node.id) || !originalIds.has(node.id)),
      edges: graph.edges.filter(edge => edge.relation === 'maps_between' && modelIds.has(edge.fromNodeId) || newEdges.includes(edge)) } }
  return { request, graph, audit: { version: 1, documentId: DAO_DOCUMENT, parentRevision: document.revision,
    sourceUnitsSha256: hash(sourceUnits), beforeModelSha256: beforeModelHash, reviewedModels: models.length,
    sourceCorrespondences: newRelations.length, addedNodes: graph.nodes.length - original.nodes.length,
    beforeNodes: original.nodes.length, afterNodes: graph.nodes.length, beforeEdges: original.edges.length, afterEdges: graph.edges.length,
    replacedPorts: oldPorts.length, remainingInterpretation: 'candidate; source quotations checked, empirical entailment not asserted',
    clauses: newRelations.map(({ modelId, branchId, fromNodeId, toNodeId, statement, condition, boundary, evidence }) =>
      ({ modelId, branchId, fromNodeId, toNodeId, statement, condition, boundary, evidence })) } }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [input, unitsFile, output] = process.argv.slice(2)
  if (!input || !unitsFile || !output) throw new Error('Usage: kg-dao-source-repair.mjs document.json stored-units.json prepared.json (dry run only)')
  const document = JSON.parse(readFileSync(input, 'utf8').replace(/^\uFEFF/, ''))
  const sourceUnits = JSON.parse(readFileSync(unitsFile, 'utf8').replace(/^\uFEFF/, '')).sourceUnits
  const result = prepareDaoSourceRepair(document, sourceUnits)
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ ...result.audit, clauses: undefined }))
}
