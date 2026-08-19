import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const weaveCalls = []
let manualRetryWeaveCalls = 0
const extractor = {
  async extractChunk({ title, existingNodeIds }) {
    if (title === 'append-connectivity') {
      if (Array.isArray(existingNodeIds) && existingNodeIds.length > 0) {
        return {
          summary: '追加关系编织',
          nodes: [{ id: 'n3', type: 'rule', text: '复诊用于调整学习系统', quote: '复诊用于调整学习系统', paragraph: 0 }],
          edges: [],
        }
      }
      return {
        summary: '追加关系编织基础图',
        nodes: [
          { id: 'n1', type: 'fact', text: '明确目标提高学习效率', quote: '明确目标提高学习效率', paragraph: 0 },
          { id: 'n2', type: 'inference', text: '学习方法必须由目标驱动', quote: '学习方法必须由目标驱动', paragraph: 1 },
        ],
        edges: [{
          fromNodeId: 'n1', toNodeId: 'n2', relation: 'infers',
          evidence: [
            { paragraph: 0, quote: '明确目标提高学习效率' },
            { paragraph: 1, quote: '学习方法必须由目标驱动' },
          ],
        }],
      }
    }
    if (title === 'explicit-relation-seed') {
      return {
        summary: '显式关系种子回归',
        nodes: [
          { id: 's1', type: 'fact', text: '缺少目标', quote: '缺少目标', paragraph: 0 },
          { id: 's2', type: 'inference', text: '方法会走形', quote: '方法会走形', paragraph: 0 },
          { id: 's3', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 1 },
          { id: 's4', type: 'fact', text: '本书帮助重建学习系统', quote: '本书帮助重建学习系统', paragraph: 1 },
        ],
        edges: [],
      }
    }
    if (title === 'manual-relation-retry') {
      return {
        summary: '手动关系补全回归',
        nodes: [
          { id: 'm1', type: 'fact', text: '目标决定学习方向', quote: '目标决定学习方向', paragraph: 0 },
          { id: 'm2', type: 'inference', text: '方法由目标驱动', quote: '方法由目标驱动', paragraph: 1 },
          { id: 'm3', type: 'rule', text: '复诊用于调整方法', quote: '复诊用于调整方法', paragraph: 2 },
        ],
        edges: [{
          fromNodeId: 'm1', toNodeId: 'm2', relation: 'infers',
          evidence: [
            { paragraph: 0, quote: '目标决定学习方向' },
            { paragraph: 1, quote: '方法由目标驱动' },
          ],
        }],
      }
    }
    return {
      summary: '关系编织回归',
      nodes: [
        { id: 'n1', type: 'fact', text: '明确目标提高学习效率', quote: '明确目标提高学习效率', paragraph: 0 },
        { id: 'n2', type: 'inference', text: '学习方法必须由目标驱动', quote: '学习方法必须由目标驱动', paragraph: 1 },
        { id: 'n3', type: 'rule', text: '学习系统需要诊断与复诊', quote: '学习系统需要诊断与复诊', paragraph: 2 },
        { id: 'n4', type: 'example', text: '增肌训练由增肌目标驱动', quote: '增肌训练由增肌目标驱动', paragraph: 3 },
      ],
      edges: [{
        fromNodeId: 'n1',
        toNodeId: 'n2',
        relation: 'infers',
        evidence: [
          { paragraph: 0, quote: '明确目标提高学习效率' },
          { paragraph: 1, quote: '学习方法必须由目标驱动' },
        ],
      }],
    }
  },
  async weaveRelations(args) {
    weaveCalls.push(args)
    if (args.title === 'explicit-relation-seed') return { edges: [] }
    if (args.title === 'manual-relation-retry') {
      manualRetryWeaveCalls += 1
      if (manualRetryWeaveCalls === 1) return { edges: [] }
      return {
        edges: [{
          fromNodeId: 'm2', toNodeId: 'm3', relation: 'supports',
          evidence: [
            { paragraph: 1, quote: '方法由目标驱动' },
            { paragraph: 2, quote: '复诊用于调整方法' },
          ],
        }],
      }
    }
    if (args.title === 'append-connectivity') {
      return {
        edges: [{
          fromNodeId: 'n2',
          toNodeId: 'n3',
          relation: 'supports',
          evidence: [
            { paragraph: 1, quote: '学习方法必须由目标驱动' },
            { paragraph: 2, quote: '复诊用于调整学习系统' },
          ],
        }],
      }
    }
    return {
      edges: [
        {
          fromNodeId: 'n2',
          toNodeId: 'n3',
          relation: 'supports',
          evidence: [
            { paragraph: 1, quote: '学习方法必须由目标驱动' },
            { paragraph: 2, quote: '学习系统需要诊断与复诊' },
          ],
        },
        {
          fromNodeId: 'n4',
          toNodeId: 'n2',
          relation: 'example',
          evidence: [
            { paragraph: 3, quote: '增肌训练由增肌目标驱动' },
            { paragraph: 1, quote: '学习方法必须由目标驱动' },
          ],
        },
        // Missing relation evidence must remain rejected even in the weaving pass.
        { fromNodeId: 'n1', toNodeId: 'n4', relation: 'causes', evidence: [] },
      ],
    }
  },
}

globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({
  get(name) { return name === 'kgExtractor' ? extractor : null },
  interval() { return () => {} },
})

async function waitTask(taskId) {
  for (let i = 0; i < 160; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const text = [
  '明确目标提高学习效率',
  '学习方法必须由目标驱动',
  '学习系统需要诊断与复诊',
  '增肌训练由增肌目标驱动',
].join('\n\n')
const started = await handlers.get('extract')({ title: 'connectivity-weave', text })
assert(started && started.taskId, 'connectivity extraction was not created')
const completed = await waitTask(started.taskId)
assert(completed.status === 'succeeded' && completed.result, 'connectivity extraction failed: ' + JSON.stringify(completed))
assert(weaveCalls.length === 1, 'sparse graph did not trigger one bounded relation-weave pass')
assert(weaveCalls[0].systemPrompt.includes('关系编织引擎'), 'relation weaver did not receive its dedicated system prompt')
assert(weaveCalls[0].prompt.includes('孤立节点'), 'relation-weave prompt omitted connectivity context')
assert(weaveCalls[0].prompt.includes('重点候选关系对'), 'relation-weave prompt omitted bounded candidate pairs')
assert(completed.result.edges.length === 3, 'relation weaving did not add exactly two authenticated edges: ' + JSON.stringify(completed.result.edges))
assert(!completed.result.edges.some((edge) => edge.fromNodeId === 'n1' && edge.toNodeId === 'n4'), 'weaving admitted an edge without direct relation evidence')
const connectivity = completed.result.generation && completed.result.generation.connectivity
assert(connectivity && connectivity.attempted === true, 'generation metadata does not record relation weaving')
assert(connectivity.addedEdges === 2, 'generation metadata reports the wrong added-edge count')
assert(connectivity.before.componentCount === 3 && connectivity.before.isolatedNodes === 2, 'pre-weave connectivity metrics are wrong: ' + JSON.stringify(connectivity.before))
assert(connectivity.after.componentCount === 1 && connectivity.after.isolatedNodes === 0, 'post-weave connectivity metrics are wrong: ' + JSON.stringify(connectivity.after))

const quick = await handlers.get('verify-graph')({ text, graph: completed.result, mode: 'quick' })
assert(quick && quick.report && quick.report.metrics.connectedComponents === 1, 'quick verification omitted connectivity metrics')
assert(quick.report.metrics.isolatedNodes === 0, 'quick verification still reports isolated nodes after weaving')

// Append mode must weave against the complete canonical source so a new node
// can connect to old nodes with evidence from both source revisions.
const baseText = ['明确目标提高学习效率', '学习方法必须由目标驱动'].join('\n\n')
const baseStarted = await handlers.get('extract')({ title: 'append-connectivity', text: baseText })
const baseCompleted = await waitTask(baseStarted.taskId)
assert(baseCompleted.status === 'succeeded', 'append base extraction failed: ' + JSON.stringify(baseCompleted))
const appendStarted = await handlers.get('append-extract')({
  title: 'append-connectivity',
  text: '复诊用于调整学习系统',
  documentId: baseCompleted.result.source.documentId,
})
assert(appendStarted && appendStarted.taskId, 'append connectivity task was not created')
const appendCompleted = await waitTask(appendStarted.taskId)
assert(appendCompleted.status === 'succeeded' && appendCompleted.result, 'append connectivity task failed: ' + JSON.stringify(appendCompleted))
const appendConnectivity = appendCompleted.result.generation && appendCompleted.result.generation.connectivity
assert(appendConnectivity && appendConnectivity.attempted === true && appendConnectivity.addedEdges === 1, 'append relation weaving did not run: ' + JSON.stringify(appendConnectivity))
assert(appendConnectivity.after.componentCount === 1 && appendConnectivity.after.isolatedNodes === 0, 'append graph remained fragmented after weaving')
const crossRevisionEdge = appendCompleted.result.edges.find((edge) => edge.fromNodeId === 'n2' && edge.toNodeId === 'n3' && edge.relation === 'supports')
assert(crossRevisionEdge, 'append weaving did not add the cross-revision edge')
assert(crossRevisionEdge.evidence.length === 2 && crossRevisionEdge.evidence.every((item) => item.sourceId && item.chunkId), 'append edge evidence lacks canonical source/chunk provenance: ' + JSON.stringify(crossRevisionEdge.evidence))
assert(new Set(crossRevisionEdge.evidence.map((item) => item.sourceId)).size === 2, 'cross-revision edge evidence was stamped with one incorrect source version')
assert(weaveCalls.filter((call) => call.title === 'append-connectivity').length === 1, 'append mode did not use exactly one bounded relation-weave pass')

// Explicit same-paragraph inference and concept mentions are admitted through
// deterministic evidence-backed seeds even when the optional model adds none.
const seedText = ['缺少目标，因此方法会走形', '本书帮助重建学习系统'].join('\n\n')
const seedStarted = await handlers.get('extract')({ title: 'explicit-relation-seed', text: seedText })
const seedCompleted = await waitTask(seedStarted.taskId)
assert(seedCompleted.status === 'succeeded' && seedCompleted.result, 'explicit relation seed extraction failed: ' + JSON.stringify(seedCompleted))
const seedConnectivity = seedCompleted.result.generation && seedCompleted.result.generation.connectivity
assert(seedCompleted.result.edges.length === 2, 'explicit relation seeding did not add both grounded edges: ' + JSON.stringify(seedCompleted.result.edges))
assert(seedConnectivity && seedConnectivity.seededEdges === 2 && seedConnectivity.addedEdges === 2, 'explicit seed metadata is wrong: ' + JSON.stringify(seedConnectivity))
assert(seedCompleted.result.edges.some((edge) => edge.fromNodeId === 's1' && edge.toNodeId === 's2' && edge.relation === 'infers'), 'same-paragraph inference seed is missing')
assert(seedCompleted.result.edges.some((edge) => edge.fromNodeId === 's4' && edge.toNodeId === 's3' && edge.relation === 'supports'), 'explicit concept support seed is missing')

// A sparse graph whose automatic weave found nothing can be retried later
// without regenerating or renumbering its nodes.
const manualText = ['目标决定学习方向', '方法由目标驱动', '复诊用于调整方法'].join('\n\n')
const manualStarted = await handlers.get('extract')({ title: 'manual-relation-retry', text: manualText })
const manualCompleted = await waitTask(manualStarted.taskId)
assert(manualCompleted.status === 'succeeded' && manualCompleted.result.edges.length === 1, 'manual retry fixture did not remain sparse after its first weave')
const retryStarted = await handlers.get('relation-retry')({
  documentId: manualCompleted.result.source.documentId,
  expectedRevision: manualCompleted.result.revision,
})
assert(retryStarted && retryStarted.taskId, 'relation-only retry task was not created')
const retryCompleted = await waitTask(retryStarted.taskId)
assert(retryCompleted.status === 'succeeded' && retryCompleted.result, 'relation-only retry failed: ' + JSON.stringify(retryCompleted))
assert(retryCompleted.result.nodes.length === 3 && retryCompleted.result.edges.length === 2, 'relation-only retry regenerated nodes or failed to add the edge')
const retryConnectivity = retryCompleted.result.generation && retryCompleted.result.generation.connectivity
assert(retryConnectivity && retryConnectivity.addedEdges === 1 && retryConnectivity.after.componentCount === 1, 'relation-only retry metadata is wrong: ' + JSON.stringify(retryConnectivity))
assert(retryCompleted.result.generation.relationRetryCount === 1, 'relation retry count was not recorded')

console.log(JSON.stringify({
  ok: true,
  weaveCalls: weaveCalls.length,
  edges: completed.result.edges.length,
  connectivity,
}))
