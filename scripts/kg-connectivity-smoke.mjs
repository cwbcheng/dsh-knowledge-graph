import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
const weaveCalls = []
let manualRetryWeaveCalls = 0
const extractor = {
  async extractChunk({ title, existingNodeIds }) {
    if (title === 'example-role-recall') {
      return {
        summary: '例子角色方向召回',
        nodes: [
          { id: 'r1', type: 'claim', text: '在物质世界中再次遇到完全相同现象的概率几乎为零。', quote: '在物质世界中再次遇到完全相同现象的概率几乎为零。', paragraph: 0 },
          { id: 'e1', type: 'example', text: '人不能两次踏进同一条河流。', quote: '人不能两次踏进同一条河流。', paragraph: 1 },
          { id: 'r2', type: 'claim', text: '河流水的微观粒子排列状态每时每刻都在变化。', quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。', paragraph: 2 },
        ],
        edges: [
          { fromNodeId: 'r1', toNodeId: 'r2', relation: 'supports', evidence: [{ paragraph: 0, quote: '在物质世界中再次遇到完全相同现象的概率几乎为零。' }, { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' }] },
          { fromNodeId: 'r2', toNodeId: 'e1', relation: 'analogy', evidence: [{ paragraph: 1, quote: '人不能两次踏进同一条河流。' }, { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' }] },
        ],
      }
    }
    if (title === 'sequence-relation-recall') {
      return {
        summary: '连续流程关系召回',
        nodes: [
          { id: 'v1', type: 'fact', text: '物体反光进入眼睛并在视网膜上聚焦。', quote: '首先，物体的反光进入眼睛并在视网膜上聚焦。', paragraph: 0 },
          { id: 'v2', type: 'fact', text: '视网膜感光细胞将反光转换成神经电信号。', quote: '接着，视网膜感光细胞将反光转换成神经电信号。', paragraph: 1 },
          { id: 'v3', type: 'fact', text: '神经电信号传到视觉皮层并形成宏观预测结果。', quote: '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。', paragraph: 2 },
        ],
        edges: [],
      }
    }
    if (title === 'limitation-relation-recall') {
      return {
        summary: '实时服务限制关系召回',
        nodes: [
          { id: 'b1', type: 'fact', text: '实时服务的输入持续变化，完全相同请求出现的概率很低。', quote: '实时服务的输入持续变化，完全相同请求出现的概率很低。', paragraph: 0 },
          { id: 'b2', type: 'claim', text: '固定缓存策略在实时服务中行不通。', quote: '因此，固定缓存策略在实时服务中行不通。', paragraph: 3 },
          { id: 'b3', type: 'concept', text: '实时服务', quote: '实时服务', paragraph: 1 },
        ],
        edges: [],
      }
    }
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
    if (args.title === 'example-role-recall') {
      assert(args.systemPrompt.includes('例子角色候选'), 'relation-weave contract does not keep example-role hints recall-only')
      assert(args.prompt.includes('例子角色候选关系对'), 'relation-weave prompt omitted example-role candidates')
      assert(args.prompt.includes('e1->r2'), 'role-deficient example was not surfaced in example-to-principle direction')
      return {
        edges: [{
          fromNodeId: 'e1', toNodeId: 'r2', relation: 'analogy',
          evidence: [
            { paragraph: 1, quote: '人不能两次踏进同一条河流。' },
            { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' },
          ],
        }],
      }
    }
    if (args.title === 'limitation-relation-recall') {
      assert(args.systemPrompt.includes('显式限制结论依据候选'), 'relation-weave contract does not keep limitation-basis hints evidence-gated')
      assert(args.prompt.includes('显式限制结论依据候选关系对'), 'relation-weave prompt omitted limitation-basis candidates')
      assert(args.prompt.includes('b1=>b2'), 'upstream basis was not surfaced toward the explicit limitation conclusion')
      return {
        edges: [{
          fromNodeId: 'b1', toNodeId: 'b2', relation: 'supports',
          evidence: [
            { paragraph: 0, quote: '实时服务的输入持续变化，完全相同请求出现的概率很低。' },
            { paragraph: 3, quote: '因此，固定缓存策略在实时服务中行不通。' },
          ],
        }],
      }
    }
    if (args.title === 'sequence-relation-recall') {
      assert(args.systemPrompt.includes('连续流程候选'), 'relation-weave contract does not describe sequence candidates as recall-only')
      assert(args.prompt.includes('连续流程候选关系对'), 'relation-weave prompt omitted explicit sequence candidates')
      assert(args.prompt.includes('v1<>v2|P0->P1'), 'first adjacent process step was not surfaced as a sequence candidate')
      assert(args.prompt.includes('v2<>v3|P1->P2'), 'second adjacent process step was not surfaced as a sequence candidate')
      return {
        edges: [
          {
            fromNodeId: 'v1', toNodeId: 'v2', relation: 'supports',
            evidence: [
              { paragraph: 0, quote: '首先，物体的反光进入眼睛并在视网膜上聚焦。' },
              { paragraph: 1, quote: '接着，视网膜感光细胞将反光转换成神经电信号。' },
            ],
          },
          {
            fromNodeId: 'v2', toNodeId: 'v3', relation: 'supports',
            evidence: [
              { paragraph: 1, quote: '接着，视网膜感光细胞将反光转换成神经电信号。' },
              { paragraph: 2, quote: '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。' },
            ],
          },
        ],
      }
    }
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

// A source-explicit limitation conclusion may summarize cumulative reasoning
// across its section. The model still supplies and authenticates the edge.
const limitationText = [
  '实时服务的输入持续变化，完全相同请求出现的概率很低。',
  '固定缓存策略依赖重复请求。',
  '实时服务持续接收新请求。',
  '因此，固定缓存策略在实时服务中行不通。',
].join('\n\n')
const limitationStarted = await handlers.get('extract')({ title: 'limitation-relation-recall', text: limitationText })
const limitationCompleted = await waitTask(limitationStarted.taskId)
assert(limitationCompleted.status === 'succeeded' && limitationCompleted.result, 'limitation relation recall extraction failed: ' + JSON.stringify(limitationCompleted))
assert(limitationCompleted.result.edges.some((edge) => edge.fromNodeId === 'b1' && edge.toNodeId === 'b2' && edge.relation === 'supports'), 'upstream basis did not reach the explicit limitation conclusion: ' + JSON.stringify(limitationCompleted.result))

// Adjacent process units with explicit “首先/接着/然后” markers are recall
// candidates only. The relation reviewer must still supply direct source
// evidence before any edge enters the canonical graph.
const sequenceText = [
  '首先，物体的反光进入眼睛并在视网膜上聚焦。',
  '接着，视网膜感光细胞将反光转换成神经电信号。',
  '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。',
].join('\n\n')
const sequenceStarted = await handlers.get('extract')({ title: 'sequence-relation-recall', text: sequenceText })
const sequenceCompleted = await waitTask(sequenceStarted.taskId)
assert(sequenceCompleted.status === 'succeeded' && sequenceCompleted.result, 'sequence relation recall extraction failed: ' + JSON.stringify(sequenceCompleted))
assert(sequenceCompleted.result.edges.some((edge) => edge.fromNodeId === 'v1' && edge.toNodeId === 'v2' && edge.relation === 'supports'), 'first process-step relation was not admitted')
assert(sequenceCompleted.result.edges.some((edge) => edge.fromNodeId === 'v2' && edge.toNodeId === 'v3' && edge.relation === 'supports'), 'second process-step relation was not admitted')
assert(sequenceCompleted.result.edges.every((edge) => Array.isArray(edge.evidence) && edge.evidence.length > 0), 'sequence relation entered without direct evidence')

// An example that only has incoming/reversed role edges is still missing its
// queryable example->principle role. The candidate is a recall hint only; the
// reviewer must provide direct evidence before the outgoing relation is added.
const roleText = [
  '在物质世界中再次遇到完全相同现象的概率几乎为零。',
  '人不能两次踏进同一条河流。',
  '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。',
].join('\n\n')
const roleStarted = await handlers.get('extract')({ title: 'example-role-recall', text: roleText })
const roleCompleted = await waitTask(roleStarted.taskId)
assert(roleCompleted.status === 'succeeded' && roleCompleted.result, 'example-role recall extraction failed: ' + JSON.stringify(roleCompleted))
assert(roleCompleted.result.edges.some((edge) => edge.fromNodeId === 'e1' && edge.toNodeId === 'r2' && edge.relation === 'analogy'), 'outgoing example role was not recovered')
assert(roleCompleted.result.edges.some((edge) => edge.fromNodeId === 'r2' && edge.toNodeId === 'e1' && edge.relation === 'analogy'), 'existing reverse edge was unexpectedly rewritten or removed')
const roleEdge = roleCompleted.result.edges.find((edge) => edge.fromNodeId === 'e1' && edge.toNodeId === 'r2' && edge.relation === 'analogy')
assert(roleEdge && Array.isArray(roleEdge.evidence) && roleEdge.evidence.length === 2, 'example-role edge entered without direct evidence')

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

// Deterministic seeds may enter canonical state only when the source span itself
// contains both propositions and an explicit relation cue. A nearby concept
// mention is only a recall hint and must not be promoted from endpoint evidence.
const seedText = ['缺少目标，因此方法会走形', '本书帮助重建学习系统'].join('\n\n')
const seedStarted = await handlers.get('extract')({ title: 'explicit-relation-seed', text: seedText })
const seedCompleted = await waitTask(seedStarted.taskId)
assert(seedCompleted.status === 'succeeded' && seedCompleted.result, 'explicit relation seed extraction failed: ' + JSON.stringify(seedCompleted))
const seedConnectivity = seedCompleted.result.generation && seedCompleted.result.generation.connectivity
assert(seedCompleted.result.edges.length === 1, 'deterministic relation seeding admitted a relation without relation-spanning evidence: ' + JSON.stringify(seedCompleted.result.edges))
assert(seedConnectivity && seedConnectivity.seededEdges === 1 && seedConnectivity.addedEdges === 1, 'explicit seed metadata is wrong: ' + JSON.stringify(seedConnectivity))
const explicitSeedEdge = seedCompleted.result.edges.find((edge) => edge.fromNodeId === 's1' && edge.toNodeId === 's2' && edge.relation === 'infers')
assert(explicitSeedEdge, 'same-paragraph inference seed is missing')
assert(explicitSeedEdge.evidence.length === 1 && explicitSeedEdge.evidence[0].quote.includes('因此'), 'deterministic seed did not preserve the relation-bearing source span')
assert(!seedCompleted.result.edges.some((edge) => edge.fromNodeId === 's4' && edge.toNodeId === 's3'), 'endpoint evidence was promoted into a fact-to-concept relation')

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
  limitationRelationRecall: true,
  sequenceRelationRecall: true,
  exampleRoleRecall: true,
  connectivity,
}))
