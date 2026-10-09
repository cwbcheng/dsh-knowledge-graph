#!/usr/bin/env node
// Keyless, source-only UI regression: no bundles, browser, server, or model calls.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGenerationStructureTools } from '../src/kg-generation-structure.mjs'

const source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const tools = createGenerationStructureTools()
const h = (type, props, ...children) => {
  children = children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false)
  return typeof type === 'function' ? type({ ...props, children }) : { type, props: props || {}, children }
}
const walk = (tree, predicate) => {
  if (!tree || typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...(tree.children || []).flatMap(child => walk(child, predicate))]
}
const text = tree => tree == null || tree === false ? '' : typeof tree !== 'object' ? String(tree) : (tree.children || []).map(text).join('')
const paragraphSnapshot = tree => (tree.children || []).filter(child => child?.type === 'p').map(text)
const start = source.indexOf('      function relationBatchBudgetValue(')
const end = source.indexOf('      function ModelUsageStatus(', start)
assert.ok(start >= 0 && end > start, 'Source UI helper boundaries must exist')
assert.ok(source.includes('const GENERATION_STRUCTURE_TOOLS = ('), 'Client must embed its source structure factory')
const ui = new Function('h', 'GENERATION_STRUCTURE_TOOLS', source.slice(start, end) + '\nreturn { relationBatchBudgetValue, RelationBatchBudgetInput, RelationCompletionStatus, RelationCompletionControls, generationStructureQualityState, StructureQualityStatus, GraphContentScopeControls, contentScopeForNode, contentScopeCanvasProps };')(h, tools)

const discoveryStart = source.indexOf('      function RelationDiscoveryStatus(')
const discoveryEnd = source.indexOf('      function relationNetChange(', discoveryStart)
assert.ok(discoveryStart >= 0 && discoveryEnd > discoveryStart)
const discoveryUI = new Function('h', source.slice(discoveryStart, discoveryEnd) + '\nreturn RelationDiscoveryStatus;')(h)
const savedCoverage = { totalTargets: 683, searchedTargets: 612, remainingTargets: 71, pass: 1,
  savedGroups: 0, totalGroups: 4, savedTargets: 0, durable: true }
const recoveryTree = discoveryUI({ coverage: savedCoverage,
  recovery: { requests: 3, maxRequests: 128, splits: 1, completedLeaves: 1, reusedLeaves: 1 } })
assert.match(text(recoveryTree), /查找关系 612\/683/)
assert.match(text(recoveryTree), /本次关系请求 3\/128/)
assert.match(text(recoveryTree), /截断拆组 1/)
assert.match(text(recoveryTree), /本次新完成查找子任务 1/)
assert.match(text(recoveryTree), /复用候选子任务 1/)
assert.match(text(recoveryTree), /不是模型用量或费用预算.*发现候选须经独立检查/)
assert.equal(walk(recoveryTree, item => item.props['aria-label'] === '关系候选查找进度')[0].props.value, 612,
  'A saved leaf or request count must not increase primary-target coverage')
assert.equal(walk(recoveryTree, item => item.props['aria-label'] === '关系截断恢复状态').length, 1)
assert.doesNotMatch(text(discoveryUI({ coverage: savedCoverage })), /本次关系请求|截断拆组/,
  'Missing legacy recovery metadata is unknown, not fabricated zero requests')
assert.match(text(discoveryUI({ coverage: { ...savedCoverage, durable: false } })), /查找进度暂时保存/)
assert.doesNotMatch(text(discoveryUI({ coverage: { ...savedCoverage, durable: false } })), /查找进度已保存/)
assert.match(source, /coverage: progress\.discovery, recovery: progress\.relationRecovery/)
assert.match(source, /coverage: discoveryMeta, recovery: generationMeta\?\.relationRecovery/)

const graph = {
  graphOntology: { id: 'custom', nodeTypes: [{ id: 'discrimination_model', label: '判别模型' }], relationTypes: [{ id: 'grounded_rule', label: '有据规则' }] },
  source: { documentId: 'keyless-ui', revision: 7, title: 'keyless fixture', sections: [{ id: 'm', title: '正文' }, { id: 'c', title: '版本说明' }] },
  nodes: [
    ...Array.from({ length: 8 }, (_, i) => ({ id: 'm' + i, type: i === 0 || i === 2 ? 'concept' : 'discrimination_model', sectionId: 'm', title: '正文 ' + i })),
    { id: 'c0', type: 'concept', sectionId: 'c' }, { id: 'c1', type: 'claim', sectionId: 'c' },
  ],
  edges: [
    { fromNodeId: 'c0', toNodeId: 'c1', relation: 'grounded_rule' },
    { fromNodeId: 'm0', toNodeId: 'm1', relation: 'grounded_rule' },
    { fromNodeId: 'm0', toNodeId: 'c0', relation: 'grounded_rule' },
  ],
  generation: { invariantErrors: 0, relationDiscovery: { totalTargets: 10, searchedTargets: 2, remainingTargets: 8 } },
}
const original = JSON.stringify(graph)
const partial = ui.StructureQualityStatus({ graph })
assert.match(text(partial), /结构检查：有连接问题待核对/)
assert.deepEqual(paragraphSnapshot(partial).slice(0, 4), [
  '查看完整知识图的连接情况。',
  '正文内容 8 个节点 · 1 条关系 · 版本与来源说明 2 个节点（不计入正文连通性）',
  '正文孤立 6 个（75%） · 最大连通簇 2 个（25%） · 孤立概念锚点 1/2',
  '查找关系主目标待查找 8 个 / 总 10 个（已查找 2 个）。',
])
assert.match(text(partial), /正文.*孤立|主正文的孤立/)
assert.match(text(partial), /结构检查只提示连接情况/)
assert.match(text(partial), /独立事实可以保存.*是否有关系仍需原文依据/)
assert.equal(JSON.stringify(graph), original, 'Read-only diagnostics must preserve ontology, source, and canonical graph')

const completeGraph = { ...graph, generation: { relationDiscovery: { totalTargets: 10, searchedTargets: 10, remainingTargets: 0 } } }
const complete = ui.StructureQualityStatus({ graph: completeGraph })
assert.match(text(complete), /本轮查找关系主目标已覆盖；不等于所有关系已找到或语义正确/)
assert.match(text(complete), /不代表|不等于/)
const healthyGraph = { ...graph, nodes: graph.nodes.slice(0, 2), edges: [graph.edges[1]], generation: completeGraph.generation }
const healthy = ui.StructureQualityStatus({ graph: healthyGraph })
assert.match(text(healthy), /暂无连接问题，内容仍需核对/)

const unknown = ui.StructureQualityStatus({ graph: { ...graph, generation: {} } })
assert.match(text(unknown), /查找关系覆盖尚未评估/)
assert.doesNotMatch(text(unknown), /待查找 0 个/)
const unknownCounts = tools.inspect(graph)
unknownCounts.relationSearch = { status: 'partial', totalTargets: null, searchedTargets: null, remainingTargets: null }
assert.match(text(ui.StructureQualityStatus({ graph: { ...graph, graphStructureQuality: unknownCounts } })), /待查找 未评估 个 \/ 总 未评估 个/)

// Large/old Host windows may NOT be mistaken for the complete canonical graph.
const quality = tools.inspect(graph)
const oldWindow = { ...graph, nodes: [graph.nodes[0]], edges: [], view: { kind: 'window', totalNodes: 1000, totalEdges: 800, nodeLimit: 800, truncated: true }, generation: {} }
assert.equal(ui.generationStructureQualityState(oldWindow).origin, 'unavailable')
assert.match(text(ui.StructureQualityStatus({ graph: oldWindow })), /旧服务未提供全图结构诊断；不能用当前窗口评价全图/)
const snapshotWindow = { ...oldWindow, generation: { structureQuality: quality } }
assert.equal(ui.generationStructureQualityState(snapshotWindow).origin, 'snapshot')
assert.match(text(ui.StructureQualityStatus({ graph: snapshotWindow })), /生成时快照，并非当前全图实时统计/)
const canonicalWindow = { ...snapshotWindow, graphStructureQuality: quality }
assert.equal(ui.generationStructureQualityState(canonicalWindow).origin, 'canonical')
assert.equal(ui.generationStructureQualityState(canonicalWindow).quality, quality)
assert.match(text(ui.StructureQualityStatus({ graph: canonicalWindow })), /正文内容 8 个节点/)
assert.equal(ui.generationStructureQualityState({ ...oldWindow, view: { ...oldWindow.view, graphStructureQuality: quality } }).origin, 'canonical', 'Historical nested-field forwarding remains compatible')
const staleSnapshot = tools.inspect(healthyGraph)
assert.equal(ui.generationStructureQualityState({ ...canonicalWindow, view: { ...oldWindow.view, graphStructureQuality: staleSnapshot } }).quality, quality, 'Canonical root field takes precedence over historical nested forwarding')
assert.equal(ui.generationStructureQualityState({ ...graph, generation: { structureQuality: staleSnapshot } }).origin, 'loaded', 'Full loaded graph overrides an old generation snapshot')
assert.equal(ui.generationStructureQualityState({ ...oldWindow, view: { ...oldWindow.view, kind: 'query', truncated: false, totalNodes: 1, totalEdges: 0 } }).origin, 'unavailable')
assert.equal(ui.generationStructureQualityState({ ...oldWindow, view: { ...oldWindow.view, truncated: false } }).origin, 'unavailable', 'Declared totals still prove a view incomplete')

// Partition and the canvas adapter retain canonical object identities and edge indices.
const calls = []
const props = { nodes: graph.nodes, edges: graph.edges, contentGraph: graph, contentScope: 'main', selectedEdgeId: 1,
  onSelectEdge: index => calls.push(['select', index]),
  onQuestionEdge: (edge, index) => calls.push(['question', edge, index]),
  onDeleteEdge: (edge, index) => calls.push(['delete', edge, index]) }
const canvas = ui.contentScopeCanvasProps(props)
assert.equal(canvas.nodes.length, 8)
assert.deepEqual(canvas.edges, [graph.edges[1]])
assert.equal(canvas.edges[0], graph.edges[1])
assert.equal(canvas.nodes[0], graph.nodes[0])
assert.equal(canvas.selectedEdgeId, 0)
canvas.onSelectEdge(0)
canvas.onQuestionEdge(canvas.edges[0], 0)
canvas.onDeleteEdge(canvas.edges[0], 0)
canvas.onSelectEdge(null)
assert.deepEqual(calls, [['select', 1], ['question', graph.edges[1], 1], ['delete', graph.edges[1], 1], ['select', null]])
canvas.onSelectEdge(99)
canvas.onDeleteEdge(graph.edges[0], 0)
assert.equal(calls.length, 4, 'Out-of-range or mismatched edge identity must never reach canonical callbacks')
assert.equal(ui.contentScopeCanvasProps({ ...props, selectedEdgeId: 0 }).selectedEdgeId, null)
const allProps = { ...props, contentScope: 'all' }
assert.equal(ui.contentScopeCanvasProps(allProps), allProps, 'Default all mode must keep the existing graph/callbacks unchanged')
const contextCanvas = ui.contentScopeCanvasProps({ ...props, contentScope: 'source_context', selectedEdgeId: 0 })
assert.equal(contextCanvas.nodes.length, 2)
assert.equal(contextCanvas.edges[0], graph.edges[0])
const image = { id: 'img1', type: 'image', contentLayer: 'main' }
assert.ok(ui.contentScopeCanvasProps({ ...props, nodes: [...props.nodes, image] }).nodes.includes(image), 'Layer filters preserve visible image objects')
const projected = tools.partition(canonicalWindow, 'main')
assert.equal(projected.graphStructureQuality, quality, 'Partition retains full canonical quality metadata without recomputing window counts')
assert.equal(projected.source, canonicalWindow.source)
assert.equal(projected.graphOntology, canonicalWindow.graphOntology)
assert.equal(JSON.stringify(graph), original)
assert.equal(ui.contentScopeForNode(graph, 'main', 'c0'), 'all')
assert.equal(ui.contentScopeForNode(graph, 'source_context', 'm0'), 'all')
assert.equal(ui.contentScopeForNode(graph, 'main', 'm0'), 'main', 'Visible canvas selection must not reset the chosen layer')
assert.equal(ui.contentScopeForNode(graph, 'main', 'external-projection-node'), 'main', 'Neighborhood nodes absent from the base window keep the current scope')
let changedScope
const scopeTree = ui.GraphContentScopeControls({ scope: 'all', onChange: scope => { changedScope = scope } })
const scopeSelect = walk(scopeTree, node => node.type === 'select')[0]
assert.equal(scopeSelect.props.value, 'all')
assert.deepEqual(scopeSelect.children.map(option => [option.props.value, text(option)]), [['all', '全部'], ['main', '正文内容'], ['source_context', '版本与来源']])
scopeSelect.props.onChange({ target: { value: 'main' } })
assert.equal(changedScope, 'main')
scopeSelect.props.onChange({ target: { value: 'invalid' } })
assert.equal(changedScope, 'main')

// Budgets are strict integers; invalid input remains editable but never starts a request.
for (const value of ['', ' ', '3.5', '3.0', '2e1', '21', 0, -1, 21, NaN, Infinity, null, undefined, true, {}, []]) assert.equal(ui.relationBatchBudgetValue(value), null)
for (const value of [1, '1', 3, '3', 20, '20']) assert.equal(ui.relationBatchBudgetValue(value), Number(value))
let started = []
const control = opts => ui.RelationCompletionControls({ continuous: true, budget: 3, onBudgetChange: () => {}, onContinuousChange: () => {}, onStart: budget => started.push(budget), ...opts })
const invalidControl = control({ budget: '2.5' })
const invalidButton = walk(invalidControl, node => node.type === 'button')[0]
assert.equal(invalidButton.props.disabled, true)
invalidButton.props.onClick()
assert.deepEqual(started, [])
assert.equal(walk(invalidControl, node => node.type === 'input' && node.props.type === 'number')[0].props['aria-invalid'], true)
assert.match(text(invalidControl), /预算须为 1–20 的整数/)
assert.match(text(control({ budget: '3' })), /最多 3 批/)
assert.match(text(control()), /不是模型用量或费用上限/)
walk(control(), node => node.type === 'button')[0].props.onClick()
walk(control({ continuous: false, budget: '' }), node => node.type === 'button')[0].props.onClick()
walk(control({ disabled: true }), node => node.type === 'button')[0].props.onClick()
assert.deepEqual(started, [3, 1], 'Single mode has budget 1 and ignores an inactive invalid continuous input')
assert.match(text(control({ coverage: { remainingTargets: 0 } })), /新一轮查找（最多 3 批）/)
assert.doesNotMatch(text(control()), /持续到本轮完成/)

const exhausted = ui.RelationCompletionStatus({ completion: { maxBatches: 3, completedBatches: 3, savedCycles: 3, stopReason: 'budget_exhausted' } })
assert.match(text(exhausted), /3\/3 批（上限 3）/)
assert.match(text(exhausted), /已达本次批次预算；可继续查找，不表示本轮查找完成/)
const checkpoint = ui.RelationCompletionStatus({ completion: { maxBatches: 3, completedBatches: 1, savedCycles: 0, checkpointOnly: true, stopReason: 'single_batch' } })
assert.match(text(checkpoint), /已记录检查点批次 1\/3/)
assert.match(text(checkpoint), /尚不等于独立检查后提交到正式知识图/)
assert.doesNotMatch(text(checkpoint), /检查后已保存/)
assert.match(text(ui.RelationCompletionStatus({ completion: { maxBatches: 3, completedBatches: 2, stopReason: 'coverage_complete' } })), /不代表全部可能关系已找到/)
assert.match(text(ui.RelationCompletionStatus({ completion: { savedCycles: 2 } })), /旧记录未记预算/)
assert.equal(ui.RelationCompletionStatus({}), null)

// Execute real Workbench submit handlers against an inert host stub, not text-only assertions.
const wbStart = source.indexOf('      function WorkbenchBody(')
assert.ok(wbStart >= 0)
function handlerSource(name) {
  const begin = source.indexOf('        const ' + name + ' = async', wbStart)
  const finish = source.indexOf('\n        }\n', begin)
  assert.ok(begin >= wbStart && finish > begin, 'Workbench handler must exist: ' + name)
  return source.slice(begin, finish + '\n        }'.length)
}
function handlerFixture(name, budget, continuous = true) {
  const requests = [], effects = [], errors = []
  const fnSource = handlerSource(name)
  const env = {
    relationBatchBudget: budget, relationBatchBudgetValue: ui.relationBatchBudgetValue, continuousRelations: continuous,
    text: '新增正文', title: 'keyless fixture', fullText: '既有正文', imageInputs: [],
    effectiveModelImageSupport: true, effectiveModelArg: null, ontologyArg: null, markdownBundle: null,
    MAX_LEN: 1000000, extractionConcurrency: 2, phase: 'done', taskId: null,
    generationTaskActiveRef: { current: false }, submissionBusyRef: { current: false }, resumeAttemptRef: { current: false },
    graphRevisionRef: { current: 7 }, submittedRef: { current: {} },
    resultView: { graph: { ...graph, source: { ...graph.source, visualSource: { kind: 'markdown-assets', images: [{ id: 'asset1', interpretationStatus: 'not_requested' }] } } }, sourceText: '既有正文' },
    documentIdOfGraph: g => g?.source?.documentId || '', splitParagraphs: value => [{ text: value }],
    cancelVerifyTasks: () => effects.push('cancelVerifyTasks'), resetGraphCommitQueue: () => effects.push('resetGraphCommitQueue'),
    rememberPendingTask: () => effects.push('rememberPendingTask'), localStorage: { setItem() {} }, LS_PENDING: 'keyless-pending',
    host: { call: async (method, payload) => { requests.push({ method, payload }); return { taskId: 'stub-task' } } },
  }
  for (const [, setter] of fnSource.matchAll(/\b(set[A-Z]\w*)\(/g)) env[setter] = () => effects.push(setter)
  env.setError = error => { errors.push(error); effects.push('setError') }
  const handler = new Function('env', 'with (env) {\n' + fnSource + '\nreturn ' + name + '; }')(env)
  return { handler, env, requests, effects, errors }
}
for (const name of ['submit', 'appendSubmit', 'appendImagesSubmit', 'retryRelations']) {
  for (const invalid of ['', '2.5', '21', 0, 21, null]) {
    const f = handlerFixture(name, invalid)
    const result = await f.handler(name === 'appendImagesSubmit' ? ['asset1'] : undefined)
    assert.deepEqual(f.requests, [], name + ': invalid budget must not reach host')
    assert.deepEqual(f.effects, ['setError'], name + ': no task/state side effect before budget validation')
    assert.equal(f.env.submissionBusyRef.current, false)
    assert.deepEqual(f.env.submittedRef.current, {})
    assert.match(f.errors[0].message, /1–20 的整数/)
    if (name === 'appendImagesSubmit') assert.equal(result.error, f.errors[0])
  }
  const f = handlerFixture(name, '3')
  await f.handler(name === 'appendImagesSubmit' ? ['asset1'] : undefined)
  assert.equal(f.requests.length, 1, name + ': valid input reaches exactly one inert host call')
  assert.equal(f.requests[0].payload.relationBatchBudget, 3)
  assert.equal(typeof f.requests[0].payload.relationBatchBudget, 'number')
  assert.equal(f.requests[0].method, name === 'submit' ? 'extract' : name === 'retryRelations' ? 'relation-retry' : 'append-extract')
  assert.ok(f.errors.every(error => error === null), name + ': handler stub must not hide an execution failure')
}
const singleRetry = handlerFixture('retryRelations', '', false)
await singleRetry.handler()
assert.equal(singleRetry.requests[0].payload.relationBatchBudget, 1)
assert.equal(singleRetry.requests[0].payload.continuous, false)

// Integration invariants: raw canonical data is used for quality and every persistence path.
assert.match(source, /const \[relationBatchBudget, setRelationBatchBudget\] = useState\(3\)/)
assert.match(source, /const \[contentScope, setContentScope\] = useState\('all'\)/)
assert.match(source, /h\(StructureQualityStatus, \{ graph: resultView\.graph/)
const qualityPos = source.indexOf('h(StructureQualityStatus, { graph: resultView.graph')
const detailsPos = source.indexOf("h('details', { className: 'kg-workbench-tools'", qualityPos)
assert.ok(detailsPos > qualityPos, 'Structure quality must be outside and before collapsed generation details')
assert.match(source, /h\(GraphCanvas, contentScopeCanvasProps\(/)
assert.match(source, /contentScope, contentGraph: resultView\.graph/)
assert.doesNotMatch(source, /setResultView\(makeView\(GENERATION_STRUCTURE_TOOLS\.partition/, 'Never persist a content-layer projection as canonical')
const paragraphStart = source.indexOf('        const handleParagraphClick = (pi) => {', wbStart)
assert.match(source.slice(paragraphStart, paragraphStart + 110), /setContentScope\('all'\)/)
assert.match(source, /relationBudgetValid: relationBatchBudgetValue\(relationBatchBudget\) !== null/)
assert.match(source, /disabled: disabled \|\| !relationBudgetValid \|\| !selectedIds\.length/)
assert.match(source, /else graph = \{\s*\.\.\.graph,\s*nodes: Array\.isArray\(graph\.nodes\)/, 'makeView must retain root quality/view/ontology metadata')
console.log('kg-generation-structure-ui-smoke: PASS (source-only; h-tree snapshots, canonical quality, read-only scopes, edge identity, budget guards; zero model calls)')
