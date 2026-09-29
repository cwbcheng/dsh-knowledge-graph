// Source records are not propositions. Keep them outside the model's ontology;
// their identity and links are determined by retained source provenance only.
export function createImageNodeTools() {
  const nodeId = id => 'image:' + encodeURIComponent(id)
  const imagesOf = graph => (Array.isArray(graph?.source?.visualSource?.images) ? graph.source.visualSource.images : []).filter(image =>
    typeof image?.id === 'string' && image.id && image.attachment?.attachmentId)
  const forNode = (graph, node) => node?.type === 'image'
    ? imagesOf(graph).find(image => nodeId(image.id) === node.id) || null : null
  const semanticGraph = graph => {
    if (!(graph?.nodes || []).some(node => node.type === 'image')) return graph
    const nodes = graph.nodes.filter(node => node.type !== 'image'), ids = new Set(nodes.map(node => node.id))
    return { ...graph, nodes, edges: (graph.edges || []).filter(edge => edge.relation !== 'visual_source'
      && ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)) }
  }
  const matches = (graph, image, node) => {
    const source = graph.source || {}
    const own = item => (!item.documentId || item.documentId === source.documentId)
      && (!item.sourceId || !source.id || item.sourceId === source.id)
    const contains = p => Number.isInteger(p) && Number.isInteger(image.startParagraph)
      && Number.isInteger(image.endParagraph) && p >= image.startParagraph && p <= image.endParagraph
    return (source.visualSource?.kind === 'image-derived' || image.interpretationStatus === 'ai_unverified')
      && node.type !== 'image' && own(node) && (contains(node.paragraph)
        || (node.evidence || []).some(item => own(item) && contains(item.paragraph)))
  }
  const materialize = graph => {
    const images = imagesOf(graph)
    if (!images.length && !(graph.nodes || []).some(node => node.type === 'image')) return graph
    const semantic = semanticGraph(graph)
    const nodes = semantic.nodes.slice(), edges = semantic.edges.filter(edge => edge.relation !== 'visual_source')
    const ids = new Set(nodes.map(node => node.id)), imageIds = new Set()
    for (const image of images) {
      const id = nodeId(image.id)
      if (id.length > 160 || ids.has(id) || imageIds.has(id)) throw new Error('image_node_conflict: ' + id)
      imageIds.add(id)
      const paragraph = graph.source.visualSource.kind === 'markdown-assets'
        ? (image.paragraphs || []).find(p => Number.isInteger(p) && p >= 0) ?? null : image.startParagraph ?? null
      nodes.push({ id, type: 'image', text: String(image.caption || image.name || image.id).trim() || image.id,
        paragraph, quote: '', evidence: [], groundingStatus: 'candidate', entailmentStatus: 'unverified',
        documentId: graph.source.documentId, sourceId: graph.source.id })
      for (const node of semantic.nodes) if (matches(graph, image, node)) {
        edges.push({ fromNodeId: node.id, toNodeId: id, relation: 'visual_source', evidence: [] })
      }
    }
    return { ...graph, nodes, edges }
  }
  const errors = graph => {
    const result = []
    if (!(graph.nodes || []).some(node => node?.type === 'image') && !(graph.edges || []).some(edge => edge?.relation === 'visual_source')) return result
    let expected
    try { expected = materialize(graph) } catch (error) { return [{ targetKind: 'graph', targetId: null, detail: error.message }] }
    const byId = new Map(expected.nodes.filter(node => node.type === 'image').map(node => [node.id, node]))
    const key = edge => JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.relation])
    const links = new Set(expected.edges.filter(edge => edge.relation === 'visual_source').map(key))
    const imageIds = new Set((graph.nodes || []).filter(node => node.type === 'image').map(node => node.id))
    for (const node of graph.nodes || []) if (node.type === 'image') {
      const want = byId.get(node.id)
      if (!want || node.text !== want.text || node.paragraph !== want.paragraph || node.quote || node.evidence?.length) {
        result.push({ targetKind: 'node', targetId: node.id, detail: '图片节点必须引用当前文档保留的原图，不能伪造文字证据或更改来源。' })
      }
    }
    for (const edge of graph.edges || []) if (edge.relation === 'visual_source'
      || imageIds.has(edge.fromNodeId) || imageIds.has(edge.toNodeId)) {
      if (edge.relation !== 'visual_source' || !links.has(key(edge)) || edge.evidence?.length) {
        result.push({ targetKind: 'edge', targetId: edge.fromNodeId + '>' + edge.toNodeId,
          detail: '图片连线只能表示当前转写来源，不能当作支持、因果或其他语义断言。' })
      }
    }
    return result
  }
  const signature = graph => JSON.stringify([
    (graph.nodes || []).filter(node => node.type === 'image').map(node => [node.id, node.text, node.paragraph]).sort(),
    (graph.edges || []).filter(edge => edge.relation === 'visual_source').map(edge => [edge.fromNodeId, edge.toNodeId]).sort(),
  ])
  return { nodeId, forNode, matches, materialize, semanticGraph, errors, signature }
}
