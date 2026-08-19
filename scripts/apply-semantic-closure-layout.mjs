import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}
function replaceCount(source, before, after, count, label) {
  let out = source
  let seen = 0
  while (out.includes(before)) { out = out.replace(before, after); seen += 1 }
  if (seen !== count) throw new Error(label + ': expected ' + count + ', got ' + seen)
  return out
}

const hostPath = new URL('../src/index.host.js', import.meta.url)
let host = readFileSync(hostPath, 'utf8')
host = replaceOnce(host,
  "        '4. concept 概念 —— 稳定、可复用的术语或明确命名对象。作者临时标签、修辞表达不得仅因显眼就升级为 concept，除非文本明确把它当作持续讨论的理论对象。',",
  "        '4. concept 概念 —— 稳定、可复用的术语或明确命名对象。作者临时标签、修辞表达不得仅因显眼就升级为 concept，除非文本明确把它当作持续讨论的理论对象。被两个以上独立核心命题反复引用、可跨段/跨章节继续承载知识的明确命名对象，应保留独立 concept anchor；concept 名称优先使用稳定对象本身，不把“重建/优化/提高/建立 + 对象”整体实体化，除非该过程本身被正式命名。',",
  'concept anchor contract')
host = replaceOnce(host,
  "        '7. counter_example 反例 —— 边界约束、不成立的情况。',",
  "        '7. counter_example 反例 —— 只有当一个具体案例明确削弱、限制或否定某个一般命题时使用，并应通过 counter_example 关系指向被挑战命题。负向结果、失败情形或对照情形如果仍在帮助说明/支持原命题，仍用 example，并通过 supports/analogy 表达作用。',",
  'counterexample contract')
host = replaceOnce(host,
  "        '12. 同一稳定概念或同一原子命题只建一个节点；优先保留能跨段复用的概念和机制链，但不要把多个原子命题合成“主结论大节点”。',",
  "        '12. 同一稳定概念或同一原子命题只建一个节点；优先保留能跨段复用的概念和机制链，但不要把多个原子命题合成“主结论大节点”。若一个稳定对象被多个核心命题共同引用，应保留其 concept anchor，而不是只让该术语散落在命题文本里。',",
  'stable concept requirement')
host = replaceOnce(host,
  "        '14. 与主题有关的节点可保持孤立；原文未定义的核心概念允许作为待后文展开的节点存在，禁止为了连通率强行补关系。',",
  "        '14. 与主题有关的节点可保持孤立；原文未定义的核心概念允许作为待后文展开的节点存在，禁止为了连通率强行补关系。原文明示“并非X/不是X/不意味着X/问题不在X而在Y”等纠偏时，应保留防止错误推理所必需的限定主张；原文明示某问题留待后文回答时，可用普通 claim 记录“当前范围尚未给出具体答案”，不要虚构答案。',",
  'boundary and forward-reference requirement')
host = replaceOnce(host,
  "        '15. 输出前自查：节点是否原子？fact/claim 是否分对？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',",
  "        '15. 输出前自查：节点是否原子？fact/claim 是否分对？counter_example 是否真的在反驳一个命题而不是仅描述负向/对照结果？核心稳定对象是否有 concept anchor？显式纠偏或留待后文的信息是否被遗漏？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',",
  'semantic self-check')
host = replaceOnce(host,
  "        '2. 一节点一命题；多个后果、步骤或判断必须拆成多个节点。fact 仅用于可直接核对的具体事实，作者理论/经验判断使用 claim。',",
  "        '2. 一节点一命题；多个后果、步骤或判断必须拆成多个节点。fact 仅用于可直接核对的具体事实，作者理论/经验判断使用 claim。counter_example 只用于真正削弱/限制某个命题的案例；负向对照仍用 example。稳定对象被多个核心命题复用时保留 concept anchor，并优先用对象本身而不是“重建/优化/提高 + 对象”作为 concept 名称。',",
  'append semantic contract')
host = replaceOnce(host,
  "        '你是「知识图机制覆盖复核器」。你会收到一个原文内容块，以及已经通过确定性验收的该块知识节点。你的唯一任务是检查：首轮抽取是否把对后续“为什么/如何”问答必要的中间机制、独立后果或高知识密度例子摘要掉了。',",
  "        '你是「知识图解释覆盖复核器」。你会收到一个原文内容块，以及已经通过确定性验收的该块知识节点。你的唯一任务是检查首轮图是否丢失后续解释/检索必需的信息：中间机制、独立后果、稳定概念锚点、显式防误推理限定、当前范围明确留待后文回答的信息，以及高知识密度例子。',",
  'coverage purpose')
host = replaceOnce(host,
  "        '2. 优先恢复原文明确表达的多步机制链、条件→结果、中间状态、独立可查询后果。若首轮只保留“A最终导致E”，而原文明示A→B→C→D→E，则补回对解释为什么/如何有用的B/C/D。',",
  "        '2. 优先恢复原文明确表达的多步机制链、条件→结果、中间状态、独立可查询后果。若首轮只保留“A最终导致E”，而原文明示A→B→C→D→E，则补回对解释为什么/如何有用的B/C/D。若一个明确命名的稳定对象被多个核心命题反复引用却没有独立 concept anchor，也可补回该对象；concept 名称使用稳定对象本身。',",
  'coverage concept anchor')
host = replaceOnce(host,
  "        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。',",
  "        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。counter_example 只用于真正削弱/限制某个命题的案例；负向结果或对照情形若仍在支持原命题，不得标为 counter_example。',",
  'coverage counterexample')
host = replaceOnce(host,
  "        '5. 所有新节点和关系必须由当前编号原文直接支持。quote/evidence 必须逐字来自原文；保留“可能、多数、通常、必须、如果、不是”等限定。',",
  "        '5. 所有新节点和关系必须由当前编号原文直接支持。quote/evidence 必须逐字来自原文；保留“可能、多数、通常、必须、如果、不是”等限定。若原文明示“并非X/不是X/不意味着X/问题不在X而在Y”，检查防误推理所需的X侧限定是否漏掉；若原文明示问题将在后文回答，可补一条普通 claim 记录“当前范围尚未给出具体答案”，不得猜答案或新增 question/unresolved 类型。',",
  'coverage boundaries')

const oldCoverageTrigger = `      function mechanismCoverageNeededHost(batch, graph) {
        const units = batch && Array.isArray(batch.units) ? batch.units : []
        if (units.length === 0) return false
        const cue = /(?:导致|因此|所以|于是|从而|因而|进而|继而|随后|最终|无法|依赖|变成|成为|误认为|等同|如果|一旦|只有|必须|先|再|然后|接着|直到|越来越)/g
        const nodesByParagraph = new Map()
        for (const node of graph && Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (!node || !Number.isInteger(node.paragraph)) continue
          nodesByParagraph.set(node.paragraph, (nodesByParagraph.get(node.paragraph) || 0) + 1)
        }
        let mechanismUnits = 0
        let suspiciousUnits = 0
        for (const unit of units) {
          if (!unit || !Number.isInteger(unit.num)) continue
          const text = String(unit.text || '')
          const cues = text.match(cue) || []
          if (cues.length === 0) continue
          mechanismUnits += 1
          const represented = nodesByParagraph.get(unit.num) || 0
          if (represented === 0 || (cues.length >= 2 && represented <= 1)) suspiciousUnits += 1
        }
        return suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(cue) || []).length >= 2)))
      }`
const newCoverageTrigger = `      function mechanismCoverageNeededHost(batch, graph) {
        const units = batch && Array.isArray(batch.units) ? batch.units : []
        if (units.length === 0) return false
        const mechanismCue = /(?:导致|因此|所以|于是|从而|因而|进而|继而|随后|最终|无法|依赖|变成|成为|误认为|等同|如果|一旦|只有|必须|先|再|然后|接着|直到|越来越)/g
        const boundaryCue = /(?:并非|并不是|不是说|并不意味着|不意味着|问题不在|而在|而是)/
        const forwardCue = /(?:后文|下文|接下来|留待后文|本书将|将在后文|后面会|随后会|将会回答|将会解释)/
        const nodesByParagraph = new Map()
        for (const node of graph && Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (!node || !Number.isInteger(node.paragraph)) continue
          const list = nodesByParagraph.get(node.paragraph) || []
          list.push(node)
          nodesByParagraph.set(node.paragraph, list)
        }
        let mechanismUnits = 0
        let suspiciousUnits = 0
        let explanatoryBoundaryGap = false
        for (const unit of units) {
          if (!unit || !Number.isInteger(unit.num)) continue
          const text = String(unit.text || '')
          const paragraphNodes = nodesByParagraph.get(unit.num) || []
          const cues = text.match(mechanismCue) || []
          if (cues.length > 0) {
            mechanismUnits += 1
            if (paragraphNodes.length === 0 || (cues.length >= 2 && paragraphNodes.length <= 1)) suspiciousUnits += 1
          }
          if (boundaryCue.test(text)) {
            const covered = paragraphNodes.some((node) => boundaryCue.test(String(node.quote || '') + ' ' + String(node.text || '')))
            if (!covered) explanatoryBoundaryGap = true
          }
          if (forwardCue.test(text)) {
            const covered = paragraphNodes.some((node) => forwardCue.test(String(node.quote || '') + ' ' + String(node.text || '')))
            if (!covered) explanatoryBoundaryGap = true
          }
        }
        return explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))
      }`
host = replaceOnce(host, oldCoverageTrigger, newCoverageTrigger, 'coverage trigger')
host = replaceOnce(host,
  "        '5. 其它方向：例子/反例→被说明项，定义→被定义项，事实/主张→推论，因→果。example/counter_example/defines 的源节点类型仍应分别为 example/counter_example/definition。',",
  "        '5. 其它方向：例子→被说明项，定义→被定义项，事实/主张→推论，因→果。counter_example 必须由真正反驳/限制一般命题的案例指向被挑战命题；仅仅是负向结果或对照情形时使用 example + supports/analogy。example/counter_example/defines 的源节点类型仍应分别为 example/counter_example/definition。',",
  'relation weave counterexample')
host = replaceOnce(host,
  "        '审校时重点检查：作者主张是否被误标 fact；节点是否包含多个独立命题；是否丢失“可能/多数/部分/通常/必须/如果/不是”等语义限定；是否把可用精确关系退化成 supports。',",
  "        '审校时重点检查：作者主张是否被误标 fact；节点是否包含多个独立命题；counter_example 是否真正削弱/限制了一个明确命题；稳定核心对象是否缺少 concept anchor 或被“重建/优化/提高 + 对象”错误实体化；是否遗漏显式纠偏/防误推理限定或“留待后文回答”的范围信息；是否丢失“可能/多数/部分/通常/必须/如果/不是”等语义限定；是否把可用精确关系退化成 supports。',",
  'verifier semantic closure')
host = replaceOnce(host,
  "        '6. completeness 遗漏：原文中重要的结论、定义、规则或边界条件是否漏拆？',",
  "        '6. completeness 遗漏：原文中重要的结论、定义、规则、稳定概念锚点、显式纠偏/防误推理限定或明确留待后文回答的信息是否漏拆？',",
  'verifier completeness')

const quickNeedle = `          for (const node of nodes) {
            if (node && node.id && !degree.has(node.id)) {
              add('node_isolated', false, 'warning', 'completeness', 'node', node.id, '孤立节点', '该节点没有任何关系边，请确认它是否需要连接进图。', [], { action: 'none' })
            }
          }`
const quickReplacement = `          for (const node of nodes) {
            if (!node || !node.id || node.type !== 'counter_example') continue
            const hasCounterTarget = edges.some((edge) => edge && edge.fromNodeId === node.id && edge.relation === 'counter_example')
            if (!hasCounterTarget) {
              add('counter_example_without_target', false, 'warning', 'type', 'node', node.id,
                '反例节点没有明确的被挑战命题',
                'counter_example 的逻辑角色是削弱/限制一个一般命题；如果该节点只是负向结果或对照情形，应改用 example，并用 supports/analogy 表达其说明作用。',
                [], { action: 'none' })
            }
          }
          for (const node of nodes) {
            if (node && node.id && !degree.has(node.id)) {
              add('node_isolated', false, 'warning', 'completeness', 'node', node.id, '孤立节点', '该节点没有任何关系边，请确认它是否需要连接进图。', [], { action: 'none' })
            }
          }`
host = replaceOnce(host, quickNeedle, quickReplacement, 'counterexample quick warning')
writeFileSync(hostPath, host)

const clientPath = new URL('../src/index.client.js', import.meta.url)
let client = readFileSync(clientPath, 'utf8')
const oldLayerSeed = `        let hub = nodes[0]
        for (const node of nodes) if (deg.get(node.id) > deg.get(hub.id)) hub = node
        const adj = new Map()
        for (const node of nodes) adj.set(node.id, [])
        for (const e of edges) {
          const fa = adj.get(e.fromNodeId)
          const tb = adj.get(e.toNodeId)
          if (fa && tb) { fa.push(e.toNodeId); tb.push(e.fromNodeId) }
        }
        const level = new Map([[hub.id, 0]])
        const queue = [hub.id]
        while (queue.length > 0) {
          const id = queue.shift()
          for (const nb of adj.get(id)) {
            if (!level.has(nb)) { level.set(nb, level.get(id) + 1); queue.push(nb) }
          }
        }`
const newLayerSeed = `        const adj = new Map()
        for (const node of nodes) adj.set(node.id, [])
        for (const e of edges) {
          const fa = adj.get(e.fromNodeId)
          const tb = adj.get(e.toNodeId)
          if (fa && tb) { fa.push(e.toNodeId); tb.push(e.fromNodeId) }
        }
        // Relation-aware ranking. A causal/inference chain is the visual
        // backbone; examples/analogies/definitions become nearby branches.
        // Components without such a chain keep the old deterministic BFS
        // behaviour, so this is a projection change rather than a graph-model
        // change.
        const reasoningRelations = new Set(['causes', 'infers'])
        const satelliteRelations = new Set(['example', 'counter_example', 'analogy', 'defines', 'is_a', 'contains'])
        const directionalRelations = new Set(['supports', 'driven_by', 'aims_at'])
        const level = new Map()
        const componentSeen = new Set()
        for (const start of nodes) {
          if (componentSeen.has(start.id)) continue
          const component = []
          const queue = [start.id]
          componentSeen.add(start.id)
          while (queue.length > 0) {
            const id = queue.shift()
            component.push(id)
            for (const nb of adj.get(id) || []) {
              if (componentSeen.has(nb)) continue
              componentSeen.add(nb)
              queue.push(nb)
            }
          }
          const componentSet = new Set(component)
          const componentEdges = edges.filter((edge) => edge && componentSet.has(edge.fromNodeId) && componentSet.has(edge.toNodeId))
          const reasoningEdges = componentEdges.filter((edge) => reasoningRelations.has(edge.relation))
          const local = new Map()
          if (reasoningEdges.length >= 2) {
            const reasonIds = new Set()
            const indegree = new Map()
            const outgoing = new Map()
            for (const edge of reasoningEdges) {
              reasonIds.add(edge.fromNodeId); reasonIds.add(edge.toNodeId)
            }
            for (const id of reasonIds) { indegree.set(id, 0); outgoing.set(id, []) }
            for (const edge of reasoningEdges) {
              indegree.set(edge.toNodeId, indegree.get(edge.toNodeId) + 1)
              outgoing.get(edge.fromNodeId).push(edge.toNodeId)
            }
            const topo = component.filter((id) => reasonIds.has(id) && indegree.get(id) === 0)
            for (const id of topo) local.set(id, 0)
            let processed = 0
            while (topo.length > 0) {
              const id = topo.shift()
              processed += 1
              const base = local.get(id) || 0
              for (const to of outgoing.get(id) || []) {
                local.set(to, Math.max(local.get(to) || 0, base + 1))
                indegree.set(to, indegree.get(to) - 1)
                if (indegree.get(to) === 0) topo.push(to)
              }
            }
            if (processed !== reasonIds.size) local.clear()
          }
          if (local.size === 0) {
            let hub = nodes.find((node) => node.id === component[0])
            for (const id of component) {
              const node = nodes.find((candidate) => candidate.id === id)
              if (node && deg.get(node.id) > deg.get(hub.id)) hub = node
            }
            const bfs = [hub.id]
            local.set(hub.id, 0)
            while (bfs.length > 0) {
              const id = bfs.shift()
              for (const nb of adj.get(id) || []) {
                if (!componentSet.has(nb) || local.has(nb)) continue
                local.set(nb, local.get(id) + 1)
                bfs.push(nb)
              }
            }
          } else {
            for (let pass = 0; pass < component.length; pass++) {
              let changed = false
              for (const edge of componentEdges) {
                const fromLevel = local.get(edge.fromNodeId)
                const toLevel = local.get(edge.toNodeId)
                if (fromLevel == null && toLevel != null) {
                  local.set(edge.fromNodeId, satelliteRelations.has(edge.relation) || directionalRelations.has(edge.relation) ? Math.max(0, toLevel - 1) : toLevel + 1)
                  changed = true
                } else if (fromLevel != null && toLevel == null) {
                  local.set(edge.toNodeId, fromLevel + 1)
                  changed = true
                }
              }
              if (!changed) break
            }
            for (let pass = 0; pass < component.length; pass++) {
              let changed = false
              for (const id of component) {
                if (local.has(id)) continue
                const ranked = (adj.get(id) || []).find((nb) => local.has(nb))
                if (ranked) { local.set(id, local.get(ranked) + 1); changed = true }
              }
              if (!changed) break
            }
            const tail = local.size > 0 ? Math.max(...local.values()) + 1 : 1
            for (const id of component) if (!local.has(id)) local.set(id, tail)
          }
          for (const [id, rank] of local) level.set(id, rank)
        }`
client = replaceOnce(client, oldLayerSeed, newLayerSeed, 'relation-aware layered ranking')
client = replaceCount(client, "return 'force'", "return 'layered'", 2, 'default layout storage fallbacks')
client = replaceCount(client, "layoutMode || 'force'", "layoutMode || 'layered'", 2, 'default layout uses')
writeFileSync(clientPath, client)

const semanticClosureTest = `import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) { if (!condition) throw new Error(message) }
const handlers = new Map()
const coverageCalls = []
let producerPrompt = ''
const extractor = {
  async extractChunk({ title, systemPrompt }) {
    producerPrompt = systemPrompt
    if (title === 'semantic-closure') {
      return {
        summary: '目标应驱动方法',
        nodes: [{ id: 'n1', type: 'claim', text: '真正的问题在于学习方法缺少正确行为目标驱动', quote: '真正的问题在于学习方法缺少正确行为目标驱动。', paragraph: 1 }],
        edges: [],
      }
    }
    throw new Error('unexpected title: ' + title)
  },
  async reviewCoverage(args) {
    coverageCalls.push(args)
    assert(args.systemPrompt.includes('稳定概念锚点'), 'coverage does not review concept anchors')
    assert(args.systemPrompt.includes('防误推理'), 'coverage does not review anti-inference boundaries')
    assert(args.systemPrompt.includes('当前范围尚未给出具体答案'), 'coverage does not preserve forward-reference scope')
    return {
      nodes: [
        { id: 'm1', type: 'claim', text: '以教促学、联想记忆、保持专注和定期复习等学习手段本身并非有问题', quote: '这些学习手段本身并非有问题。', paragraph: 0 },
        { id: 'm2', type: 'concept', text: '可验证的行为目标', quote: '可验证的行为目标', paragraph: 2 },
        { id: 'm3', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 3 },
        { id: 'm4', type: 'claim', text: '当前序言尚未给出可验证的行为目标的具体内容，该问题将在后文回答', quote: '本书将在后文回答可验证的行为目标具体是什么。', paragraph: 2 },
      ],
      edges: [
        { fromNodeId: 'm1', toNodeId: 'n1', relation: 'supports', evidence: [{ paragraph: 0, quote: '这些学习手段本身并非有问题。' }, { paragraph: 1, quote: '真正的问题在于学习方法缺少正确行为目标驱动。' }] },
      ],
    }
  },
  async weaveRelations() { return { edges: [] } },
}
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'kgExtractor' ? extractor : null }, interval() { return () => {} } })
async function waitTask(taskId) {
  for (let i = 0; i < 200; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish')
}
const source = [
  '这些学习手段本身并非有问题。',
  '真正的问题在于学习方法缺少正确行为目标驱动。',
  '可验证的行为目标是本书反复讨论的核心对象。本书将在后文回答可验证的行为目标具体是什么。',
  '本书旨在重建学习系统。',
].join('\\n\\n')
const start = await handlers.get('extract')({ title: 'semantic-closure', text: source })
const done = await waitTask(start.taskId)
assert(done.status === 'succeeded', 'semantic closure extraction failed: ' + JSON.stringify(done))
assert(coverageCalls.length === 1, 'explicit boundary/forward gap did not trigger one bounded coverage review')
for (const expected of ['学习手段本身并非有问题', '可验证的行为目标', '学习系统', '尚未给出可验证的行为目标的具体内容']) {
  assert(done.result.nodes.some((node) => String(node.text || '').includes(expected)), 'missing semantic closure node: ' + expected)
}
assert(producerPrompt.includes('被两个以上独立核心命题反复引用'), 'producer does not preserve stable concept anchors')
assert(producerPrompt.includes('负向结果、失败情形或对照情形如果仍在帮助说明/支持原命题，仍用 example'), 'counter-example role is still too broad')
assert(producerPrompt.includes('不要虚构答案'), 'forward-reference scope contract is missing')

const contrastText = '如果不明确目标，运动可能被执行成减肥。'
const contrastGraph = { nodes: [{ id: 'c1', type: 'counter_example', text: '不明确目标时运动可能变成减肥', quote: contrastText, paragraph: 0 }], edges: [] }
const quick = await handlers.get('verify-graph')({ text: contrastText, graph: contrastGraph, mode: 'quick' })
assert(quick && quick.report && quick.report.issues.some((issue) => issue.code === 'counter_example_without_target'), 'quick check did not flag a counter_example without a challenged proposition')

const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
assert(hostSource.includes('知识图解释覆盖复核器'), 'coverage pass was not generalized narrowly to explanatory coverage')
console.log(JSON.stringify({ ok: true, semanticClosure: true, counterExampleGuard: true, schemaFrozen: true }))
`
writeFileSync(new URL('./kg-semantic-closure-smoke.mjs', import.meta.url), semanticClosureTest)

const semanticLayoutTest = `import { readFileSync } from 'node:fs'
function assert(condition, message) { if (!condition) throw new Error(message) }
function extractFunction(source, name) {
  const start = source.indexOf('function ' + name + '(')
  if (start < 0) throw new Error(name + ' not found')
  const brace = source.indexOf('{', start)
  let depth = 0
  for (let i = brace; i < source.length; i++) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) return source.slice(start, i + 1) }
  }
  throw new Error(name + ' is not balanced')
}
const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const num = (name) => {
  const match = source.match(new RegExp('const ' + name + ' = ([0-9.]+)'))
  if (!match) throw new Error(name + ' not found')
  return Number(match[1])
}
const names = ['LAYER_COL_GAP', 'LAYER_MAX_ROW_WIDTH', 'LAYER_X_GAP', 'LAYER_Y_GAP']
const values = names.map(num)
const layoutLayered = new Function(...names, 'return (' + extractFunction(source, 'layoutLayered') + ')')(...values)
const nodes = ['a','b','c','d','e','x'].map((id) => ({ id }))
const edges = [
  { fromNodeId: 'a', toNodeId: 'b', relation: 'causes' },
  { fromNodeId: 'b', toNodeId: 'c', relation: 'causes' },
  { fromNodeId: 'c', toNodeId: 'd', relation: 'causes' },
  { fromNodeId: 'd', toNodeId: 'e', relation: 'causes' },
  { fromNodeId: 'x', toNodeId: 'c', relation: 'analogy' },
]
const sizes = new Map(nodes.map((node) => [node.id, { w: 170, h: 72 }]))
const pos = layoutLayered(nodes, edges, sizes)
for (const [from, to] of [['a','b'],['b','c'],['c','d'],['d','e']]) {
  assert(pos.get(from).y < pos.get(to).y, 'reasoning chain is not monotonic: ' + from + ' -> ' + to + ' / ' + JSON.stringify({ from: pos.get(from), to: pos.get(to) }))
}
assert(pos.get(x).y < pos.get(c).y, 'analogy satellite was not placed as a branch near its target')
assert(source.includes("const reasoningRelations = new Set(['causes', 'infers'])"), 'relation-aware layered backbone is missing')
assert(source.includes("return 'layered'"), 'new sessions do not default to the semantic layered projection')
console.log(JSON.stringify({ ok: true, chain: ['a','b','c','d','e'].map((id) => ({ id, ...pos.get(id) })), satellite: pos.get('x') }))
`
writeFileSync(new URL('./kg-semantic-layout-smoke.mjs', import.meta.url), semanticLayoutTest)

const packagePath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.scripts['test:kg-semantic-closure'] = 'node scripts/kg-semantic-closure-smoke.mjs'
pkg.scripts['test:kg-semantic-layout'] = 'node scripts/kg-semantic-layout-smoke.mjs'
pkg.scripts.test = pkg.scripts.test.replace(' && npm run test:kg-mechanism-coverage', ' && npm run test:kg-mechanism-coverage && npm run test:kg-semantic-closure && npm run test:kg-semantic-layout')
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

const readmePath = new URL('../README.md', import.meta.url)
let zh = readFileSync(readmePath, 'utf8')
zh = replaceOnce(zh, '- **双向定位**：', '- **关系感知分层布局**：分层模式以 `causes/infers` 推理链作为主路径，把例子、类比、反例、定义和概念关系放成邻近分支；新用户默认使用分层布局，已有本地布局偏好保持不变。\\n- **双向定位**：', 'Chinese layout docs')
writeFileSync(readmePath, zh)
const readmeEnPath = new URL('../README.en.md', import.meta.url)
let en = readFileSync(readmeEnPath, 'utf8')
en = replaceOnce(en, '- **Two-way linking**:', '- **Relation-aware layered layout**: layered mode treats `causes/infers` as the reasoning backbone and keeps examples, analogies, counter-examples, definitions, and concept relations as nearby branches. New users default to layered layout; existing saved layout preferences are preserved.\\n- **Two-way linking**:', 'English layout docs')
writeFileSync(readmeEnPath, en)

console.log(JSON.stringify({ ok: true, files: ['src/index.host.js','src/index.client.js','scripts/kg-semantic-closure-smoke.mjs','scripts/kg-semantic-layout-smoke.mjs','package.json','README.md','README.en.md'] }))
