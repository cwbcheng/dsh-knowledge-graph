/**
 * Read-only structural diagnostics, not a semantic acceptance gate.
 * This entire factory can be embedded using createGenerationStructureTools.toString().
 * It deliberately has no imports or references to values outside its own body.
 */
export function createGenerationStructureTools() {
  const contextTitles = new Set([
    '版本', '版本说明', '版本背景', '版本信息', '版本与整理说明', '版本及整理说明',
    '底本', '底本说明', '底本信息', '底本选择说明', '底本与校勘说明',
    '校勘', '校勘说明', '校勘原则', '校勘记', '版本与校勘说明',
    '转写', '转写说明', '转录说明', '录入说明', '释文说明',
    '来源说明', '文本来源', '文本来源说明', '资料来源', '资料来源说明',
    '出处说明', '资料出处', '可追溯来源', '参考文献', '参考资料',
    '编者说明', '编者按', '编辑说明', '整理者说明', '整理说明', '整理原则',
    '建图说明', '建图资料说明', '建图来源说明', '建图主文本',
    '知识图生成说明', '知识图构建说明', '知识图版本说明', '知识图的阅读层次',
  ])
  const englishContextTitles = new Set([
    'source notes', 'source provenance', 'editorial notes', 'edition notes',
    'version notes', 'transcription notes', 'collation notes', 'graph generation notes',
  ])

  function validId(id) {
    return typeof id === 'string' && id.length > 0 && id.trim().length > 0
  }

  function sectionLayer(title) {
    if (typeof title !== 'string') return 'main'
    let text = title.trim()
    // Remove explicit heading/list numbering, never arbitrary prose or content words.
    for (let pass = 0; pass < 6; pass += 1) {
      const before = text
      text = text
        .replace(/^>\s*/, '')
        .replace(/^#{1,6}\s*/, '')
        .replace(/^[-+*]\s+/, '')
        .replace(/^第[零〇一二三四五六七八九十百千万\d]+(?:部分|章|节|篇|部)\s*[:：、.．-]?\s*/, '')
        .replace(/^[（(][零〇一二三四五六七八九十百千万\d]+[）)]\s*/, '')
        .replace(/^[零〇一二三四五六七八九十百千万]+[、.．)）]\s*/, '')
        .replace(/^\d+(?:[.．]\d+)*[、.．)）]\s*/, '')
        .replace(/^\d+(?:[.．]\d+)*\s+/, '')
        .replace(/\s+#{1,6}\s*$/, '')
        .trim()
      if (/^(\*\*|__)(.+)\1$/.test(text)) text = text.slice(2, -2).trim()
      if (text === before) break
    }
    // A qualified title may end in an exact editorial label, e.g. “老子：版本说明”.
    // Mere occurrences of 来源/年代/版本, or generic 序言, are not sufficient.
    const tail = text.split(/[:：|｜·—–]/).pop().trim()
    const compact = tail.replace(/\s+/g, '')
    if (contextTitles.has(compact)) return 'source_context'
    if (/^(?:版本|底本|校勘|转写)(?:[、与及和](?:版本|底本|校勘|转写))+(?:说明|原则|信息|背景)?$/.test(compact)) return 'source_context'
    if (englishContextTitles.has(tail.toLowerCase().replace(/\s+/g, ' '))) return 'source_context'
    return 'main'
  }

  function sectionIndex(sections, titleCache) {
    const indexed = new Map()
    const classify = (title) => {
      if (typeof title !== 'string') return 'main'
      if (!titleCache.has(title)) titleCache.set(title, sectionLayer(title))
      return titleCache.get(title)
    }
    if (Array.isArray(sections)) {
      for (const section of sections) {
        if (!section || typeof section !== 'object') continue
        const id = section.id
        if (validId(id) && !indexed.has(id)) indexed.set(id, classify(section.title))
      }
    } else if (sections instanceof Map) {
      for (const [id, section] of sections) {
        if (validId(id)) indexed.set(id, classify(typeof section === 'string' ? section : section?.title))
      }
    }
    return indexed
  }

  function resolveLayer(node, indexed, titleCache) {
    if (!node || typeof node !== 'object') return 'main'
    // Only the two documented enum values have authority over a legacy title.
    if (node.contentLayer === 'main' || node.contentLayer === 'source_context') return node.contentLayer
    const sectionId = node.sectionId
    if (validId(sectionId) && indexed.has(sectionId)) return indexed.get(sectionId)
    const title = node.sectionTitle
    if (typeof title !== 'string') return 'main'
    if (!titleCache.has(title)) titleCache.set(title, sectionLayer(title))
    return titleCache.get(title)
  }

  function layerOf(node, sections) {
    const titleCache = new Map()
    return resolveLayer(node, sectionIndex(sections, titleCache), titleCache)
  }

  function graphSections(graph) {
    if (Array.isArray(graph?.source?.sections)) return graph.source.sections
    return Array.isArray(graph?.sections) ? graph.sections : []
  }

  function coverageRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return null
    const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null
    const declared = ['partial', 'complete', 'not_assessed'].includes(record.status) ? record.status : null
    let totalTargets = count(record.totalTargets)
    let searchedTargets = count(record.searchedTargets)
    let remainingTargets = count(record.remainingTargets)
    if (searchedTargets === null && Array.isArray(record.completedTargetIds)) {
      searchedTargets = new Set(record.completedTargetIds.filter(validId)).size
    }
    if (totalTargets === null && searchedTargets !== null && remainingTargets !== null) {
      totalTargets = count(searchedTargets + remainingTargets)
    }
    if (totalTargets === null && searchedTargets === null && remainingTargets === null && declared === null) return null
    let inconsistent = false
    if (totalTargets !== null) {
      if (searchedTargets !== null && searchedTargets > totalTargets) inconsistent = true
      if (remainingTargets !== null && remainingTargets > totalTargets) inconsistent = true
      if (!inconsistent && searchedTargets === null && remainingTargets !== null) searchedTargets = totalTargets - remainingTargets
      if (!inconsistent && searchedTargets !== null) {
        const expected = totalTargets - searchedTargets
        if (remainingTargets !== null && remainingTargets !== expected) inconsistent = true
        if (remainingTargets === null) remainingTargets = expected
      }
    }
    let status = 'not_assessed'
    if (!inconsistent && declared !== 'not_assessed') {
      if (declared === 'partial') status = 'partial'
      else if (remainingTargets !== null && remainingTargets > 0) status = 'partial'
      else if (totalTargets !== null && searchedTargets !== null && remainingTargets === 0) status = 'complete'
      else if (declared === 'complete') status = 'complete'
    }
    return { status, totalTargets, searchedTargets, remainingTargets }
  }

  function relationSearchOf(graph) {
    // Counts describe focused target searches, NOT nodes merely present in context.
    // A successful generation or attempted connectivity pass cannot imply coverage.
    const candidates = [graph?.generation?.relationDiscovery, graph?.generation?.connectivity?.coverage, graph?.connectivity?.coverage]
    for (const candidate of candidates) {
      const coverage = coverageRecord(candidate)
      if (coverage) return coverage
    }
    return { status: 'not_assessed', totalTargets: null, searchedTargets: null, remainingTargets: null }
  }

  function measure(nodes, adjacency, edgeCount, undirectedPairCount) {
    let isolatedNodeCount = 0
    let conceptCount = 0
    const isolatedConceptIds = []
    for (const [id, node] of nodes) {
      const isolated = adjacency.get(id).size === 0
      if (isolated) isolatedNodeCount += 1
      if (node.type === 'concept') {
        conceptCount += 1
        if (isolated) isolatedConceptIds.push(id)
      }
    }
    const visited = new Set()
    let componentCount = 0
    let largestComponentSize = 0
    for (const id of nodes.keys()) {
      if (visited.has(id)) continue
      componentCount += 1
      const pending = [id]
      visited.add(id)
      let size = 0
      while (pending.length) {
        const current = pending.pop()
        size += 1
        for (const neighbor of adjacency.get(current)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor)
            pending.push(neighbor)
          }
        }
      }
      if (size > largestComponentSize) largestComponentSize = size
    }
    const nodeCount = nodes.size
    return {
      metrics: {
        nodeCount, edgeCount, undirectedPairCount, componentCount, isolatedNodeCount,
        isolatedRatio: nodeCount ? isolatedNodeCount / nodeCount : 0,
        largestComponentSize, largestComponentRatio: nodeCount ? largestComponentSize / nodeCount : 0,
        conceptCount, isolatedConceptCount: isolatedConceptIds.length,
      },
      isolatedConceptIds,
    }
  }

  function inspect(graph) {
    const titleCache = new Map()
    const indexed = sectionIndex(graphSections(graph), titleCache)
    const allNodes = new Map()
    const mainNodes = new Map()
    const allAdjacency = new Map()
    const mainAdjacency = new Map()
    for (const node of Array.isArray(graph?.nodes) ? graph.nodes : []) {
      if (!node || typeof node !== 'object' || node.type === 'image') continue
      const id = node.id
      if (!validId(id) || allNodes.has(id)) continue
      allNodes.set(id, node)
      allAdjacency.set(id, new Set())
      if (resolveLayer(node, indexed, titleCache) === 'main') {
        mainNodes.set(id, node)
        mainAdjacency.set(id, new Set())
      }
    }
    const relationKeys = new Set()
    let allEdgeCount = 0
    let mainEdgeCount = 0
    let allPairCount = 0
    let mainPairCount = 0
    for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
      if (!edge || typeof edge !== 'object') continue
      const from = edge.fromNodeId
      const to = edge.toNodeId
      const relation = edge.relation
      if (from === to || !allNodes.has(from) || !allNodes.has(to) || !validId(relation)) continue
      // Collision-safe identity, including unusual IDs and distinct relation types.
      const key = JSON.stringify([from, to, relation])
      if (relationKeys.has(key)) continue
      relationKeys.add(key)
      allEdgeCount += 1
      const inMain = mainNodes.has(from) && mainNodes.has(to)
      if (inMain) mainEdgeCount += 1
      if (!allAdjacency.get(from).has(to)) {
        allAdjacency.get(from).add(to)
        allAdjacency.get(to).add(from)
        allPairCount += 1
        if (inMain) {
          mainAdjacency.get(from).add(to)
          mainAdjacency.get(to).add(from)
          mainPairCount += 1
        }
      }
    }
    const all = measure(allNodes, allAdjacency, allEdgeCount, allPairCount)
    const main = measure(mainNodes, mainAdjacency, mainEdgeCount, mainPairCount)
    const relationSearch = relationSearchOf(graph)
    const checks = []
    if (relationSearch.status === 'partial') {
      const pending = relationSearch.remainingTargets === null ? '部分目标' : `${relationSearch.remainingTargets} 个目标`
      checks.push({ code: 'relation_search_partial', severity: 'warning', message: `${pending}仍待完成重点关系检索；这不表示它们从未进入上下文。请继续有证据的关系检索，不按同主题自动补边。` })
    } else if (relationSearch.status === 'complete') {
      checks.push({ code: 'relation_search_complete', severity: 'info', message: '重点关系检索覆盖记录已完成；不等于所有关系已找到，也不证明哲学或其他语义正确。' })
    } else {
      checks.push({ code: 'relation_search_not_assessed', severity: 'info', message: '没有足够且一致的重点关系检索覆盖记录；不能据此推断已经检索完毕或从未进入上下文。' })
    }
    if (main.metrics.nodeCount >= 8 && (main.metrics.isolatedRatio >= 0.4 || main.metrics.largestComponentRatio < 0.2)) {
      checks.push({ code: 'main_fragmented', severity: 'warning', message: '主正文的孤立节点比例较高或最大连通簇较小。建议检查有证据的跨段关系；碎片化本身不否定有效独立事实，也不要求强行连通。' })
    }
    if (main.isolatedConceptIds.length) {
      checks.push({ code: 'isolated_concept_anchors', severity: 'warning', message: '主正文中有孤立概念锚点，可重点核查有原文支持的定义、用例或命题关联；共享主题或条件规则不能自动互推。', nodeIds: main.isolatedConceptIds })
    }
    if (!main.metrics.nodeCount) {
      checks.push({ code: 'main_structure_not_assessed', severity: 'info', message: '没有可评估的主正文节点（图像节点不计入结构指标），暂不评价主正文连通性。' })
    }
    checks.push({ code: 'structural_advice_only', severity: 'info', message: '这些是纯结构建议，不阻止有效独立事实保存，不宣称语义正确，也不自动添加语义边或物理因果关系。' })
    const status = checks.some((check) => check.severity === 'warning') ? 'needs_attention'
      : main.metrics.nodeCount ? 'no_structural_alert' : 'not_assessed'
    return {
      version: 1, status,
      metrics: { all: all.metrics, main: main.metrics, sourceContextNodeCount: all.metrics.nodeCount - main.metrics.nodeCount },
      relationSearch, checks,
    }
  }

  function partition(graph, scope = 'main') {
    if (!['main', 'all', 'source_context'].includes(scope)) throw new RangeError('Unknown generation structure scope: ' + scope)
    const titleCache = new Map()
    const indexed = sectionIndex(graphSections(graph), titleCache)
    // A view projection preserves original node/edge objects, including image nodes.
    // It must never be persisted as a replacement for the canonical graph.
    const nodes = (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((node) =>
      node && typeof node === 'object' && (scope === 'all' || resolveLayer(node, indexed, titleCache) === scope))
    const nodeIds = new Set(nodes.map((node) => node.id).filter(validId))
    const edges = (Array.isArray(graph?.edges) ? graph.edges : []).filter((edge) =>
      edge && typeof edge === 'object' && nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId))
    return { ...(graph && typeof graph === 'object' ? graph : {}), nodes, edges }
  }

  return { layerOf, sectionLayer, inspect, partition }
}
