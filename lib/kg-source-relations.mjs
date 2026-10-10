// Source-scoped model correspondences, deliberately distinct from causal laws.
// Self-contained: the dynamic Host embeds this exact factory.
export function createSourceRelationTools() {
  const attributes = ['modelId', 'branchId', 'statement', 'condition', 'boundary']
  const attributeLimit = key => ['statement', 'condition', 'boundary'].includes(key) ? 2000
    : key === 'modelId' ? 160 : key === 'branchId' ? 80 : 64
  const fail = message => { throw Object.assign(new Error(message), { code: 'invalid_source_relation' }) }
  const branchOf = (graph, modelId, branchId, from, to, nodes = new Map((graph.nodes || []).map(node => [node.id, node]))) => {
    const model = nodes.get(modelId)
    const structure = model?.modelStructure
    const branch = structure?.branches?.find(item => item.id === branchId)
    if (model?.type !== 'connection_model' || model.state === 'rejected' || !branch) fail('missing active model or branch')
    for (const id of [from, to]) {
      if (nodes.get(id)?.type !== 'concept' || nodes.get(id).state === 'rejected'
        || !structure.slots.some(slot => slot.conceptId === id)) fail('endpoint must be a concept in the recorded model slots')
    }
    if (from === to) fail('a correspondence needs two distinct scoped endpoints')
    for (const field of ['condition', 'mapping', 'boundary']) {
      if (!branch[field]?.text?.trim()) fail('condition, mapping and interpretive boundary must be recorded')
    }
    const origin = branch.mapping.provenance
    if (origin?.kind !== 'source' || !origin.quote || !Number.isSafeInteger(origin.paragraph)
      || !origin.quote.includes(branch.mapping.text)) fail('the mapping must retain a literal source clause')
    const condition = branch.condition.provenance
    if (condition?.kind !== 'source' || !condition.quote || !Number.isSafeInteger(condition.paragraph)
      || !condition.quote.includes(branch.condition.text)) fail('condition needs literal, locatable source context')
    return branch
  }
  const build = (graph, modelId, branchId, fromNodeId, toNodeId, nodes) => {
    const branch = branchOf(graph, modelId, branchId, fromNodeId, toNodeId, nodes)
    const evidence = []
    for (const field of ['mapping', 'condition']) {
      const p = branch[field].provenance
      if (!evidence.some(item => item.paragraph === p.paragraph && item.quote === p.quote)) evidence.push({ paragraph: p.paragraph, quote: p.quote })
    }
    return { fromNodeId, toNodeId, relation: 'source_relation', modelId, branchId,
      statement: branch.mapping.text, condition: branch.condition.text, boundary: branch.boundary.text,
      evidence, state: 'candidate' }
  }
  // Learning-view has no arbitrary concept → concept relation. A condition
  // belongs to a mapping rule, linked by has_rule to its model and concepts.
  // Keep the old builder only for historical snapshots; do not relabel it.
  const buildLearning = (graph, modelId, branchId, fromNodeId, toNodeId, nodes = new Map((graph.nodes || []).map(node => [node.id, node]))) => {
    const model = nodes.get(modelId), slots = model?.modelStructure?.slots || []
    const endpoints = [...new Set(slots.map(slot => slot.conceptId))]
    const branch = branchOf(graph, modelId, branchId, endpoints[0], endpoints[1], nodes)
    const from = nodes.get(fromNodeId), rule = nodes.get(toNodeId)
    if (fromNodeId !== modelId && (from?.type !== 'concept' || from.state === 'rejected' || !endpoints.includes(fromNodeId))) fail('has_rule requires the recorded model or one of its concepts')
    if (rule?.type !== 'rule' || rule.state === 'rejected' || rule.text !== branch.mapping.text) fail('has_rule must target the literal mapping rule')
    const evidence = []
    for (const field of ['mapping', 'condition']) {
      const p = branch[field].provenance
      if (!evidence.some(item => item.paragraph === p.paragraph && item.quote === p.quote)) evidence.push({ paragraph: p.paragraph, quote: p.quote })
    }
    return { fromNodeId, toNodeId, relation: 'has_rule', modelId, branchId,
      statement: branch.mapping.text, condition: branch.condition.text, boundary: branch.boundary.text, evidence, state: 'candidate' }
  }
  const errors = (graph, units) => {
    const out = []
    const nodes = new Map((graph.nodes || []).map(node => [node.id, node]))
    for (const edge of graph.edges || []) {
      const learning = edge?.relation === 'has_rule' && attributes.some(key => edge?.[key] !== undefined)
      if (edge?.relation !== 'source_relation' && !learning) {
        if (attributes.some(key => edge?.[key] !== undefined)) out.push({ targetId: edge.fromNodeId + '>' + edge.toNodeId,
          message: 'source correspondence fields cannot be relabeled as another relation' })
        continue
      }
      try {
        for (const key of attributes) {
          if (typeof edge[key] !== 'string' || !edge[key].trim() || edge[key].length > attributeLimit(key)) fail('missing or oversized ' + key)
        }
        const expected = (learning ? buildLearning : build)(graph, edge.modelId, edge.branchId, edge.fromNodeId, edge.toNodeId, nodes)
        for (const key of attributes) if (edge[key] !== expected[key]) fail('edge no longer matches its recorded model ' + key)
        for (const citation of expected.evidence) {
          if (!units?.get(citation.paragraph)?.includes(citation.quote)) fail('mapping or condition quotation does not match its source unit')
          if (!edge.evidence?.some(item => item.paragraph === citation.paragraph && item.quote === citation.quote)) fail('mapping or condition evidence is missing')
        }
      } catch (error) { out.push({ targetId: edge.fromNodeId + '>' + edge.toNodeId, message: error.message }) }
    }
    return out
  }
  return { attributes, attributeLimit, build, buildLearning, errors }
}
