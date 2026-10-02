// Source records are not propositions. Keep them outside the model's ontology;
// their identity and links are determined by retained source provenance only.
export function createImageNodeTools() {
  const nodeId = id => 'image:' + encodeURIComponent(id)
  const imagesOf = graph => (Array.isArray(graph?.source?.visualSource?.images) ? graph.source.visualSource.images : []).filter(image =>
    typeof image?.id === 'string' && image.id && image.attachment?.attachmentId)
  const forNode = (graph, node) => node?.type === 'image'
    ? imagesOf(graph).find(image => nodeId(image.id) === node.id) || null : null
  const semanticGraph = graph => {
    if (!(graph?.nodes || []).some(node => node.type === 'image')
      && !(graph?.edges || []).some(edge => ['visual_source', 'visual_reference'].includes(edge.relation))) return graph
    const nodes = (graph.nodes || []).filter(node => node.type !== 'image'), ids = new Set(nodes.map(node => node.id))
    return { ...graph, nodes, edges: (graph.edges || []).filter(edge => !['visual_source', 'visual_reference'].includes(edge.relation)
      && ids.has(edge.fromNodeId) && ids.has(edge.toNodeId)) }
  }
  const matchedParagraph = (graph, image, node) => {
    const source = graph.source || {}
    const documentId = source.documentId || graph.documentId
    const ownDocument = item => !item.documentId || item.documentId === documentId
    const contains = p => Number.isSafeInteger(p) && Number.isSafeInteger(image.startParagraph)
      && Number.isSafeInteger(image.endParagraph) && image.startParagraph >= 0
      && image.endParagraph >= image.startParagraph && p >= image.startParagraph && p <= image.endParagraph
    if (!(source.visualSource?.kind === 'image-derived' || image.interpretationStatus === 'ai_unverified')
      || node.type === 'image' || !ownDocument(node)) return null
    const anchors = [node, ...(Array.isArray(node.evidence) ? node.evidence : [])]
      .filter(item => item && contains(item.paragraph) && ownDocument(item))
    if (!anchors.length) return null
    // A canonical document retains multiple append-source identities. Additional
    // sources are trusted only within their retained chunk's global paragraph range.
    const chunks = documentId && graph.staging?.documentId === documentId && Array.isArray(graph.staging.chunks)
      ? graph.staging.chunks.filter(chunk => chunk && ownDocument(chunk) && typeof chunk.sourceId === 'string' && chunk.sourceId
        && Number.isSafeInteger(chunk.startParagraph) && Number.isSafeInteger(chunk.endParagraph)
        && chunk.startParagraph >= 0 && chunk.endParagraph >= chunk.startParagraph) : []
    if (node.sourceId && node.sourceId !== source.id && !chunks.some(chunk => chunk.sourceId === node.sourceId)) return null
    for (const anchor of anchors) {
      const sourceId = anchor.sourceId || node.sourceId
      const scopes = chunks.filter(chunk => chunk.sourceId === sourceId)
      if (!sourceId || scopes.some(chunk => anchor.paragraph >= chunk.startParagraph && anchor.paragraph <= chunk.endParagraph)
        || (!scopes.length && sourceId === source.id)) return anchor.paragraph
    }
    return null
  }
  const matches = (graph, image, node) => matchedParagraph(graph, image, node) !== null
  const figureNumbers = text => [...String(text || '').matchAll(/图\s*([0-9]+(?:\s*[-－–—.．]\s*[0-9]+)*(?:[a-zA-Z]+)?)/g)]
    .map(match => match[1].replace(/\s/g, '').replace(/[－–—]/g, '-').replace(/．/g, '.'))
  const referenceKey = record => JSON.stringify([record.nodeId, record.nodeText, record.imageId, record.attachmentId,
    record.imageName, record.imageCaption, record.imageParagraph, record.imageQuote,
    record.documentId, record.sourceId, record.paragraph, record.quote])
  const referenceRecords = graph => Array.isArray(graph?.source?.visualSource?.textReferences)
    ? graph.source.visualSource.textReferences.filter(record => record && typeof record === 'object') : []
  const referenceContext = graph => {
    const source = graph.source || {}, visual = source.visualSource || {}
    const documentId = source.documentId || graph.documentId
    const images = Array.isArray(visual.images) ? visual.images : []
    const counts = new Map()
    for (const image of images) for (const number of new Set(figureNumbers(image.caption))) counts.set(number, (counts.get(number) || 0) + 1)
    const chunks = graph.staging?.documentId === documentId && Array.isArray(graph.staging?.chunks) ? graph.staging.chunks : []
    const scope = (sourceId, paragraph) => typeof sourceId === 'string' && sourceId && chunks.some(chunk =>
      (!chunk.documentId || chunk.documentId === documentId) && chunk.sourceId === sourceId
      && Number.isSafeInteger(chunk.startParagraph) && Number.isSafeInteger(chunk.endParagraph)
      && paragraph >= chunk.startParagraph && paragraph <= chunk.endParagraph)
    const original = paragraph => Number.isSafeInteger(paragraph) && paragraph >= 0 && !images.some(image =>
      Number.isSafeInteger(image.startParagraph) && Number.isSafeInteger(image.endParagraph)
      && paragraph >= image.startParagraph && paragraph <= image.endParagraph)
    return { documentId, visual, counts, scope, original }
  }
  const makeReference = (context, node, image, units, anchor) => {
    const { documentId, visual, counts, scope, original } = context
    const numbers = figureNumbers(image.caption)
    if (visual.kind !== 'markdown-assets' || !documentId || node.type === 'image' || node.documentId !== documentId
      || !image.attachment?.attachmentId || numbers.length !== 1 || counts.get(numbers[0]) !== 1
      || !anchor || (anchor.documentId && anchor.documentId !== documentId)
      || (anchor.sourceId && anchor.sourceId !== node.sourceId) || !original(anchor.paragraph)
      || !scope(node.sourceId, anchor.paragraph) || !original(node.paragraph) || !scope(node.sourceId, node.paragraph)) return null
    const quote = typeof anchor.quote === 'string' ? anchor.quote.trim() : ''
    const paragraphText = units.get(anchor.paragraph)
    if (!quote || typeof paragraphText !== 'string' || !paragraphText.includes(quote)
      || !figureNumbers(quote).includes(numbers[0])) return null
    // An explicit book reference is not an adjacency guess. Both ends must
    // belong to the same retained source, outside every AI transcription range.
    const imageParagraph = (image.paragraphs || []).find(paragraph => original(paragraph)
      && scope(node.sourceId, paragraph) && typeof units.get(paragraph) === 'string'
      && typeof image.name === 'string' && image.name && units.get(paragraph).includes(image.name))
    if (imageParagraph === undefined) return null
    return { nodeId: node.id, nodeText: node.text, imageId: image.id, attachmentId: image.attachment.attachmentId,
      imageName: image.name, imageCaption: image.caption, imageParagraph, imageQuote: units.get(imageParagraph),
      documentId, sourceId: node.sourceId, paragraph: anchor.paragraph, quote }
  }
  const referenceCandidates = (graph, units, imageId) => {
    if (!(units instanceof Map)) return []
    const context = referenceContext(graph), result = []
    const approved = new Set(referenceRecords(graph).map(referenceKey))
    for (const image of imagesOf(graph).filter(image => !imageId || image.id === imageId)) {
      for (const node of graph.nodes || []) {
        for (const anchor of [node, ...(Array.isArray(node.evidence) ? node.evidence : [])]) {
          const record = makeReference(context, node, image, units, anchor)
          if (!record) continue
          result.push({ ...record, saved: approved.has(referenceKey(record)) })
          break
        }
      }
    }
    return result.sort((a, b) => a.paragraph - b.paragraph || a.nodeId.localeCompare(b.nodeId) || a.imageId.localeCompare(b.imageId))
  }
  const referenceEdges = (graph, units) => {
    const records = referenceRecords(graph)
    if (!records.length) return []
    const context = referenceContext(graph), nodes = new Map((graph.nodes || []).map(node => [node.id, node]))
    const images = new Map(imagesOf(graph).map(image => [image.id, image])), seen = new Set(), edges = []
    const existing = new Set((graph.edges || []).filter(edge => edge.relation === 'visual_reference')
      .map(edge => JSON.stringify([edge.fromNodeId, edge.toNodeId])))
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      const node = nodes.get(record.nodeId), image = images.get(record.imageId)
      if (!node || !image) continue
      if (!units && !existing.has(JSON.stringify([node.id, nodeId(image.id)]))) continue
      // Non-persistent projections may lack units; SQLite and invariant checks
      // always recheck the approval against canonical source units.
      const texts = units || new Map([[record.paragraph, record.quote], [record.imageParagraph, record.imageQuote]])
      const current = [node, ...(Array.isArray(node.evidence) ? node.evidence : [])]
        .map(anchor => makeReference(context, node, image, texts, anchor)).find(candidate => candidate && referenceKey(candidate) === referenceKey(record))
      const key = JSON.stringify([node.id, image.id])
      if (!current || seen.has(key)) continue
      seen.add(key)
      edges.push({ fromNodeId: node.id, toNodeId: nodeId(image.id), relation: 'visual_reference',
        evidence: [{ documentId: record.documentId, sourceId: record.sourceId, paragraph: record.paragraph, quote: record.quote }] })
    }
    return edges
  }
  const materialize = (graph, units) => {
    const images = imagesOf(graph)
    if (!images.length && !(graph.nodes || []).some(node => node.type === 'image')
      && !(graph.edges || []).some(edge => ['visual_source', 'visual_reference'].includes(edge.relation))) return graph
    const semantic = semanticGraph(graph)
    const nodes = semantic.nodes.slice(), edges = semantic.edges.filter(edge => !['visual_source', 'visual_reference'].includes(edge.relation))
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
    edges.push(...referenceEdges(graph, units))
    return { ...graph, nodes, edges }
  }
  const errors = (graph, units) => {
    const result = []
    if (!(graph.nodes || []).some(node => node?.type === 'image') && !(graph.edges || []).some(edge => ['visual_source', 'visual_reference'].includes(edge?.relation))) return result
    let expected
    try { expected = materialize(graph, units) } catch (error) { return [{ targetKind: 'graph', targetId: null, detail: error.message }] }
    const byId = new Map(expected.nodes.filter(node => node.type === 'image').map(node => [node.id, node]))
    const key = edge => JSON.stringify([edge.fromNodeId, edge.toNodeId, edge.relation])
    const links = new Set(expected.edges.filter(edge => edge.relation === 'visual_source').map(key))
    const references = new Map(expected.edges.filter(edge => edge.relation === 'visual_reference').map(edge => [key(edge), edge]))
    const imageIds = new Set((graph.nodes || []).filter(node => node.type === 'image').map(node => node.id))
    for (const node of graph.nodes || []) if (node.type === 'image') {
      const want = byId.get(node.id)
      if (!want || node.text !== want.text || node.paragraph !== want.paragraph || node.quote || node.evidence?.length) {
        result.push({ targetKind: 'node', targetId: node.id, detail: '图片节点必须引用当前文档保留的原图，不能伪造文字证据或更改来源。' })
      }
    }
    for (const edge of graph.edges || []) if (['visual_source', 'visual_reference'].includes(edge.relation)
      || imageIds.has(edge.fromNodeId) || imageIds.has(edge.toNodeId)) {
      const valid = edge.relation === 'visual_source' ? links.has(key(edge)) && !edge.evidence?.length
        : edge.relation === 'visual_reference' && references.has(key(edge))
          && JSON.stringify(edge.evidence) === JSON.stringify(references.get(key(edge)).evidence)
      if (!valid) {
        result.push({ targetKind: 'edge', targetId: edge.fromNodeId + '>' + edge.toNodeId,
          detail: '图片连线只能表示当前转写来源或已确认的原文图号引用，不能当作支持、因果或其他语义断言。' })
      }
    }
    return result
  }
  const signature = graph => JSON.stringify([
    (graph.nodes || []).filter(node => node.type === 'image').map(node => [node.id, node.text, node.paragraph]).sort(),
    (graph.edges || []).filter(edge => ['visual_source', 'visual_reference'].includes(edge.relation)).map(edge => [edge.fromNodeId, edge.toNodeId, edge.relation, edge.evidence || []]).sort(),
  ])
  return { nodeId, forNode, matchedParagraph, matches, materialize, semanticGraph, errors, signature, referenceCandidates, referenceKey }
}
