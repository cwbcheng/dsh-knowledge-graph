import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const requests = []
let queuedReplies = []
let reply = {
  verdict: 'insufficient', answer: '需要复核。', evidence: [], proposedFix: { action: 'none' },
}
const llm = {
  stream(request) {
    requests.push(request)
    const response = queuedReplies.length > 0 ? queuedReplies.shift() : reply
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  },
}
const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get(name) { return name === 'llm' ? llm : null }, interval() { return () => {} } })

const paragraphs = Array.from({ length: 350 }, (_, i) => i === 270
  ? '外延是归入概念之下的全部现象。'
  : i === 300 ? '内涵是概念的共有属性。'
    : i === 340 ? '抽象层是由判别模型形成的概念层。'
      : '普通段落 ' + i + '，此处只有常规叙述。')
const text = paragraphs.join('\n\n')
const graph = { nodes: [{ id: 'n340', type: 'concept', text: '抽象层', paragraph: 340, quote: paragraphs[340] }], edges: [] }

async function ask(question, sourceUnits) {
  const start = await handlers.get('question-graph')({
    graph, text, question, ...(sourceUnits ? { sourceUnits } : {}),
    target: { kind: 'graph', id: null }, model: { provider: 'fake', model: 'fake' },
  })
  assert(start.taskId, 'question did not start')
  for (let i = 0; i < 100; i++) {
    const status = await handlers.get('task-status')({ taskId: start.taskId })
    if (status.status !== 'running') {
      assert(status.status === 'succeeded', 'question failed: ' + JSON.stringify(status.error))
      return requests.at(-1).messages[0].content[0].text
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('question did not finish')
}

const referenced = await ask('请复核 P269-P305 的外延和内涵定义，P340 的子图是否漏拆？')
assert(referenced.includes('[P270] 外延是归入概念之下的全部现象。'), 'referenced late source paragraph was omitted')
assert(referenced.includes('[P300] 内涵是概念的共有属性。'), 'end of referenced range was omitted')
assert(referenced.includes('[P340] 抽象层是由判别模型形成的概念层。'), 'single paragraph reference was omitted')
assert(!referenced.includes('[P0] '), 'irrelevant opening paragraph displaced cited evidence')

const searched = await ask('抽象层由什么形成？')
assert(searched.includes('[P340] 抽象层是由判别模型形成的概念层。'), 'late unreferenced paragraph was not retrieved')
assert(!searched.includes('[P0] '), 'lexical retrieval regressed to the opening paragraphs')

const scoped = await ask('请复核 P269-P305 的外延和内涵定义，P340 的子图是否漏拆？', [
  { paragraph: 270, text: paragraphs[270] },
  { paragraph: 300, text: paragraphs[300] },
  { paragraph: 340, text: paragraphs[340] },
])
assert(scoped.includes('原文 P270') && scoped.includes('外延是归入概念之下的全部现象'), 'source-unit question lost original paragraph 270')
assert(scoped.includes('原文 P300') && scoped.includes('内涵是概念的共有属性'), 'source-unit question lost original paragraph 300')
assert(scoped.includes('原文 P340') && scoped.includes('抽象层是由判别模型形成的概念层'), 'source-unit question lost original paragraph 340')

reply = {
  verdict: 'contradicted', answer: '特定情境的例子不是普遍规律。',
  evidence: [{ paragraph: 0, quote: '这个模型预测碰巧可以拆分为如下两步。' }],
  proposedFix: { action: 'update_node', nodePatch: { id: 'n2076', patch: { type: 'positive_example' } } },
}
const learningText = '这个模型预测碰巧可以拆分为如下两步。\n\n这里只是一种特殊情况。'
const learningGraph = { ontology: 'learning-view-v1', nodes: [
  { id: 'n2076', type: 'rule', text: '这个模型预测碰巧可以拆分为如下两步。', quote: '这个模型预测碰巧可以拆分为如下两步。', paragraph: 0 },
], edges: [] }
const learningStart = await handlers.get('question-graph')({
  graph: learningGraph, text: learningText, question: 'n2076 是否误标为 rule？',
  target: { kind: 'node', id: 'n2076' }, model: { provider: 'fake', model: 'fake' },
})
assert(learningStart.taskId, 'learning-view question did not start')
let learningResult = null
for (let i = 0; i < 100; i++) {
  const status = await handlers.get('task-status')({ taskId: learningStart.taskId })
  if (status.status !== 'running') {
    assert(status.status === 'succeeded', 'learning-view question failed: ' + JSON.stringify(status.error))
    learningResult = status.result
    break
  }
  await new Promise((resolve) => setTimeout(resolve, 5))
}
assert(learningResult?.proposedFix?.action === 'update_node', 'ontology-aware node repair was discarded')
assert(learningResult.proposedFix.nodePatch.patch.type === 'positive_example', 'learning-view node type was lost')
const learningRequest = JSON.stringify(requests.at(-1))
assert(learningRequest.includes('positive_example') && learningRequest.includes('states_intension'),
  'question prompt did not carry learning-view node and relation vocabulary')
assert(learningRequest.includes('全部入边和出边') && learningRequest.includes('类型约束'),
  'question prompt must not suggest a node retype without checking incident relations')
assert(learningRequest.includes('has_feature 的目标必须是 feature'),
  'question prompt must distinguish a feature from a feature description when repairing edges')
const relationText = '这个例子说明无法确定绝对意义上的下一层。'
const relationGraph = { ontology: 'learning-view-v1', nodes: [
  { id: 'n2035', type: 'positive_example', text: relationText, quote: relationText, paragraph: 0 },
  { id: 'n2025', type: 'rule', text: '旧结论', quote: relationText, paragraph: 0 },
  { id: 'n2027', type: 'rule', text: '无法确定下一层', quote: relationText, paragraph: 0 },
], edges: [{ fromNodeId: 'n2035', toNodeId: 'n2025', relation: 'exemplifies',
  evidence: [{ paragraph: 0, quote: relationText }] }] }
async function askRelation(fix) {
  reply = { verdict: 'contradicted', answer: '例证目标有误。',
    evidence: [{ paragraph: 0, quote: relationText }], proposedFix: fix }
  const start = await handlers.get('question-graph')({ graph: relationGraph, text: relationText,
    question: '例证指向是否正确？', target: { kind: 'graph', id: null }, model: { provider: 'fake', model: 'fake' } })
  assert(start.taskId, 'relation question did not start')
  for (let i = 0; i < 100; i++) {
    const status = await handlers.get('task-status')({ taskId: start.taskId })
    if (status.status !== 'running') {
      assert(status.status === 'succeeded', 'relation question failed: ' + JSON.stringify(status.error))
      return status.result
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('relation question did not finish')
}
const retarget = await askRelation({ action: 'update_edge', edgePatch: {
  fromNodeId: 'n2035', toNodeId: 'n2025', newToNodeId: 'n2027', relation: 'exemplifies',
  evidence: [{ paragraph: 0, quote: relationText }],
} })
assert(retarget.proposedFix.action === 'update_edge' && retarget.proposedFix.edgePatch.newToNodeId === 'n2027',
  'evidence-backed edge retarget was not preserved')
const nonexistentOldEdge = await askRelation({ action: 'update_edge', edgePatch: {
  fromNodeId: 'n2035', toNodeId: 'n2027', relation: 'exemplifies',
  evidence: [{ paragraph: 0, quote: relationText }],
} })
assert(nonexistentOldEdge.proposedFix.action === 'none',
  'a proposed update must not silently target an edge that does not exist')

const reviewText = '原文仅说明第一特征。'
const reviewGraph = { nodes: [
  { id: 'n1', type: 'concept', text: '第一特征和第二特征', quote: reviewText, paragraph: 0 },
  { id: 'n2', type: 'concept', text: '相关概念', quote: reviewText, paragraph: 0 },
], edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports' }] }
const candidate = { id: 'review-1', targetKind: 'node', targetId: 'n1', category: 'grounding',
  title: '节点编造了原文没有的第二特征', detail: '应删除第二特征',
  evidence: [{ paragraph: 0, quote: reviewText }],
  proposedFix: { action: 'delete_node', nodePatch: { id: 'n1' } } }
async function reviewIssue(issue = candidate, target = { kind: 'node', id: 'n1' }, currentGraph = reviewGraph) {
  const start = await handlers.get('question-graph')({ graph: currentGraph, text: reviewText,
    question: '请独立核实问题是否成立', target, reviewIssue: issue,
    model: { provider: 'fake', model: 'fake' } })
  if (start.error) return start
  assert(start.taskId, 'issue review did not start')
  for (let i = 0; i < 100; i++) {
    const status = await handlers.get('task-status')({ taskId: start.taskId })
    if (status.status !== 'running') return status
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('issue review did not finish')
}
reply = { verdict: 'confirmed', answer: '原文没有第二特征，应收窄节点。',
  evidence: [{ paragraph: 0, quote: reviewText }],
  proposedFix: { action: 'update_node', nodePatch: { id: 'n1', patch: { text: '第一特征' } } } }
const confirmed = await reviewIssue()
assert(confirmed.status === 'succeeded' && confirmed.result.mode === 'issue_review'
  && confirmed.result.reviewedIssueId === candidate.id && confirmed.result.verdict === 'confirmed',
  'a source-backed issue must receive an issue-specific verdict')
assert(confirmed.result.proposedFix.action === 'update_node'
  && confirmed.result.proposedFix.nodePatch.patch.text === '第一特征',
  'a confirmed issue must carry a sanitized repair rather than the original deletion suggestion')
const reviewPrompt = requests.at(-1).messages[0].content[0].text
assert(reviewPrompt.includes('待复核问题') && reviewPrompt.includes('不是事实')
  && reviewPrompt.includes('"fromNodeId":"n1"') && reviewPrompt.includes('"toNodeId":"n2"'),
  'issue review must send the allegation and complete incident relation context')
queuedReplies = [
  { verdict: 'confirmed', answer: '节点结尾的第二特征没有原文依据，应删除这一句。',
    evidence: [{ paragraph: 0, quote: reviewText }], proposedFix: { action: 'none' } },
  { proposedFix: { action: 'update_node', nodePatch: { id: 'n1', patch: { text: '第一特征' } } },
    reason: '保留有据部分，不改变类型或关系。' },
]
const beforeRepairCalls = requests.length
const planned = await reviewIssue()
assert(planned.result.verdict === 'confirmed' && planned.result.repairStatus === 'ready'
  && planned.result.proposedFix.action === 'update_node'
  && planned.result.proposedFix.nodePatch.patch.text === '第一特征',
  'a confirmed overclaim with no initial patch must receive a second structured repair attempt')
assert(requests.length === beforeRepairCalls + 2 &&
  requests.at(-1).messages[0].content[0].text.includes('独立核实结论'),
  'the repair planner must use the verified conclusion instead of treating the allegation as fact')
assert(reviewGraph.nodes[0].text === '第一特征和第二特征' && reviewGraph.edges.length === 1,
  'planning a repair must not mutate the graph before user confirmation')
queuedReplies = [
  { verdict: 'confirmed', answer: '第二特征无据。', evidence: [{ paragraph: 0, quote: reviewText }],
    proposedFix: { action: 'none' } },
  { proposedFix: { action: 'update_node', nodePatch: { id: 'n2', patch: { text: '错误修改' } } } },
]
const invalidPlan = await reviewIssue()
assert(invalidPlan.result.verdict === 'confirmed' && invalidPlan.result.repairStatus === 'not_generated'
  && invalidPlan.result.proposedFix.action === 'none',
  'a second model call cannot repair a different node or expose a misleading apply button')
reply = { verdict: 'false_positive', answer: '原图有依据。',
  evidence: [{ paragraph: 0, quote: reviewText }],
  proposedFix: { action: 'delete_node', nodePatch: { id: 'n1' } } }
const falsePositive = await reviewIssue()
assert(falsePositive.result.verdict === 'false_positive' && falsePositive.result.proposedFix.action === 'none',
  'a false positive must never expose a graph mutation')
reply = { verdict: 'false_positive', answer: '没有提供证据但声称原图有依据。',
  evidence: [{ paragraph: 0, quote: '原文没有这段内容' }], proposedFix: { action: 'none' } }
const unsupportedDismissal = await reviewIssue()
assert(unsupportedDismissal.result.verdict === 'uncertain',
  'an ungrounded false-positive verdict must not allow dismissing an existing issue')
reply = { verdict: 'confirmed', answer: '编造了特征。',
  evidence: [{ paragraph: 0, quote: '不存在的原文引文' }],
  proposedFix: { action: 'delete_node', nodePatch: { id: 'n1' } } }
const ungrounded = await reviewIssue()
assert(ungrounded.result.verdict === 'uncertain' && ungrounded.result.proposedFix.action === 'none',
  'a grounding issue without a validated paragraph quote must not be confirmed or repaired')
reply = { verdict: 'confirmed', answer: '目标节点有误。',
  evidence: [{ paragraph: 0, quote: reviewText }],
  proposedFix: { action: 'update_node', nodePatch: { id: 'n2', patch: { text: '错误修改' } } } }
const unrelated = await reviewIssue()
assert(unrelated.result.verdict === 'confirmed' && unrelated.result.proposedFix.action === 'none',
  'a repair aimed at a different node must be rejected')
const mismatched = await reviewIssue({ ...candidate, targetId: 'n2' })
assert(mismatched.error?.code === 'invalid_input', 'a candidate cannot be rechecked against a different target')
const hub = { nodes: [reviewGraph.nodes[0], ...Array.from({ length: 96 }, (_, i) => ({
  id: 'h' + i, type: 'concept', text: '邻居 ' + i, quote: reviewText, paragraph: 0,
}))], edges: Array.from({ length: 96 }, (_, i) => ({ fromNodeId: 'n1', toNodeId: 'h' + i, relation: 'supports' })) }
const callsBeforeHub = requests.length
const oversized = await reviewIssue(candidate, { kind: 'node', id: 'n1' }, hub)
assert(oversized.status === 'failed' && oversized.error?.code === 'review_context_incomplete'
  && requests.length === callsBeforeHub, 'an oversized hub must fail closed before querying the model')
console.log(JSON.stringify({ ok: true, referenced: true, searched: true, scoped: true,
  ontologyRepair: true, retarget: true, issueReview: true }))
