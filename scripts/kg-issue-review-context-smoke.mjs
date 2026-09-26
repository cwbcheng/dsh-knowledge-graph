import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import hostPlugin, { createGraphContract } from '../src/index.host.js'
import * as persistentPlugin from '../lib/index.js'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const selectorStart = client.indexOf('        const questionNeighborhoodGraph =')
const selectorEnd = client.indexOf('        // End question context helpers.', selectorStart)
assert.ok(selectorStart > 0 && selectorEnd > selectorStart)
const selectContext = new Function(client.slice(selectorStart, selectorEnd) + '; return questionNeighborhoodGraph')()
const sharedStart = client.indexOf('      function withVerification(')
const sharedEnd = client.indexOf('      function paragraphTypeNodes(', sharedStart)
const reviewHelpers = new Function('documentIdOfGraph', client.slice(sharedStart, sharedEnd)
  + '; return { reviewIssueContextTarget, reviewContextSignature, reviewIssueSignature }')(graph => graph?.source?.documentId)
const directory = mkdtempSync(join(tmpdir(), 'kg-issue-context-'))
const previousDatabase = process.env.DSH_KG_DB
process.env.DSH_KG_DB = join(directory, 'fixture.sqlite')
const paragraphs = Array.from({ length: 305 }, (_, i) => 'Independent source statement ' + i + '.')
const text = paragraphs.join('\n\n')
const node = (id, paragraph) => ({ id, type: 'fact', text: paragraphs[paragraph],
  quote: paragraphs[paragraph], paragraph })
const edge = (fromNodeId, toNodeId) => ({ fromNodeId, toNodeId, relation: 'supports' })
const graph = { summary: 'Context fixture', nodes: [node('n1', 0), node('n2', 1), node('n3', 2),
  node('n300', 300), node('n301', 301), node('n9', 0)],
edges: [edge('n1', 'n2'), edge('n1', 'n3'), edge('n2', 'n3'), edge('n300', 'n301'), edge('n2', 'n301')] }
const candidate = { id: 'compare-issue', title: 'Possible duplicate', detail: 'Compare n1 with n300 before changing either node.',
  targetKind: 'node', targetId: 'n1', evidence: [{ paragraph: 0, quote: paragraphs[0] }] }
const requests = []
let evidenceParagraph = 300
let modelReply = null
const llm = { stream(request) {
  requests.push(request)
  return (async function* () {
    yield { type: 'text-delta', index: 0, text: JSON.stringify(typeof modelReply === 'function' ? modelReply(request) : modelReply || { verdict: 'false_positive',
      answer: 'The comparison source distinguishes the two claims.',
      evidence: [{ paragraph: evidenceParagraph, quote: paragraphs[evidenceParagraph === 3 ? 300 : evidenceParagraph] }],
      proposedFix: { action: 'none' } }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
} }

async function exercise(call, label) {
  const original = JSON.stringify(graph)
  const missingSourceGraph = { nodes: [node('n1', 0), node('n2', 1)], edges: [edge('n1', 'n2')] }
  const missingSourceIssue = { ...candidate, detail: 'Check the target and all its relations.', evidence: [{ paragraph: 0, quote: paragraphs[0] }] }
  const beforeIncomplete = requests.length
  const missingSource = await call('question-graph', { graph: missingSourceGraph, text: '',
    sourceUnits: [{ paragraph: 0, text: paragraphs[0] }], question: 'Check n1.', target: { kind: 'node', id: 'n1' },
    reviewIssue: missingSourceIssue, model: { provider: 'fixture', model: 'controlled' } })
  for (let i = 0; i < 100 && (await call('task-active', {})).busy; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(missingSource.error?.code, 'review_source_incomplete',
    label + ': a missing source unit must not silently delete an implicit neighbor before model review; model calls: ' + (requests.length - beforeIncomplete))
  assert.equal(requests.length, beforeIncomplete, label + ': incomplete source evidence must spend no model request')
  const review = async (overrides = {}, method = 'question-graph') => {
    const started = await call(method, { graph, text,
      question: 'Independently verify this allegation.', target: { kind: 'node', id: 'n1' },
      reviewIssue: candidate, model: { provider: 'fixture', model: 'controlled' }, ...overrides })
    assert.ok(started.taskId, label + ': review must be admitted: ' + JSON.stringify(started))
    for (let i = 0; i < 100; i++) {
      const status = await call('task-status', { taskId: started.taskId })
      if (status.status !== 'running') {
        for (let wait = 0; wait < 100; wait++) {
          if (!(await call('task-active', {})).busy) return status
          await new Promise(resolve => setTimeout(resolve, 5))
        }
        throw new Error(label + ': terminal review retained admission ownership')
      }
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error(label + ': review did not finish')
  }
  const context = () => {
    const prompt = requests.at(-1).messages[0].content[0].text
    const subgraph = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"summary":')))
    return { prompt, subgraph }
  }
  const fullRepairText = 'The study compared the groups under controlled conditions and recorded their scores. '.repeat(7)
    + 'Its conclusion applies only to adults, not for children.'
  const repairSource = '> ' + fullRepairText
  const repairGraph = { summary: 'The study improves scores.', nodes: [{ id: 'n1', type: 'fact',
    text: 'The scores improve for every population.', paragraph: 0, quote: 'recorded their scores.' }], edges: [] }
  const repairIssue = { ...candidate, title: 'The conclusion overstates its population.', detail: 'Check the population restriction.',
    evidence: [{ paragraph: 0, quote: 'Its conclusion applies only to adults, not for children.' }] }
  modelReply = { verdict: 'confirmed', answer: 'The original conclusion is restricted to adults.', evidence: repairIssue.evidence,
    proposedFix: { action: 'update_node', nodePatch: { id: 'n1', patch: { text: fullRepairText } } } }
  let oversizedRepair
  try { oversizedRepair = await review({ graph: repairGraph, text: repairSource, reviewIssue: repairIssue }) }
  finally { modelReply = null }
  assert.ok(oversizedRepair.result?.proposedFix.action === 'none'
    || oversizedRepair.result?.proposedFix.nodePatch?.patch?.text === fullRepairText,
  label + ': normalization must not turn a qualified model repair into a clipped, unconditional claim')
  assert.equal(oversizedRepair.result?.verdict, 'confirmed', 'rejecting a patch must not discard the independently verified issue')
  assert.equal(oversizedRepair.result?.repairStatus, 'not_generated')
  const shortRepair = 'The conclusion applies only to adults, not for children.'
  const beforeRepairRetry = requests.length
  modelReply = request => ({ verdict: 'confirmed', answer: 'Retain the population restriction.', evidence: repairIssue.evidence,
    proposedFix: { action: 'update_node', nodePatch: { id: 'n1', patch: {
      text: request.system.includes('结构化修复规划员') ? shortRepair : fullRepairText } } } })
  try {
    const repaired = await review({ graph: repairGraph, text: repairSource, reviewIssue: repairIssue })
    assert.equal(repaired.result?.proposedFix.nodePatch?.patch?.text, shortRepair,
      'the existing repair pass can regenerate a complete concise proposal rather than clipping the first answer')
    assert.equal(repaired.result?.repairStatus, 'ready')
    assert.equal(requests.length - beforeRepairRetry, 2, 'invalid output gets one repair pass, not an unbounded retry loop')
    for (const request of requests.slice(beforeRepairRetry)) {
      assert.match(request.system, /text 和 summaryPatch 不超过 500/)
      assert.match(request.system, /quote 不超过 600/)
    }
  } finally { modelReply = null }
  const nodeFix = patch => ({ action: 'update_node', nodePatch: { id: 'n1', patch } })
  const noFix = { action: 'none' }
  const textBoundary = 'x'.repeat(498) + '\u{1f600}'
  const quoteBoundary = 'x'.repeat(598) + '\u{1f600}'
  const patchCases = [
    ['exact text limit', nodeFix({ text: textBoundary }), nodeFix({ text: textBoundary })],
    ['one text unit over', nodeFix({ text: textBoundary + 'x' }), noFix],
    ['surrogate crossing text limit', nodeFix({ text: 'x'.repeat(499) + '\u{1f600}' }), noFix],
    ['exact quote limit', nodeFix({ quote: quoteBoundary }), nodeFix({ quote: quoteBoundary })],
    ['one quote unit over', nodeFix({ quote: quoteBoundary + 'x' }), noFix],
    ['coupled type and overlong text', nodeFix({ type: 'claim', text: fullRepairText }), noFix],
    ['coupled text and overlong quote', nodeFix({ text: shortRepair, quote: fullRepairText }), noFix],
    ['add node overlong text', { action: 'add_node', nodePatch: { patch: { type: 'fact', text: fullRepairText } } }, noFix],
    ['delete with incomplete patch', { ...nodeFix({ text: fullRepairText }), action: 'delete_node' }, noFix],
    ['exact summary limit', { action: 'update_summary', summaryPatch: textBoundary }, { action: 'update_summary', summaryPatch: textBoundary }],
    ['overlong summary', { action: 'update_summary', summaryPatch: fullRepairText }, noFix],
    ['overlong primary summary cannot use fallback', { action: 'update_summary', summaryPatch: fullRepairText,
      nodePatch: { patch: { text: shortRepair } } }, noFix],
    ['valid legacy summary', { action: 'update_summary', nodePatch: { patch: { text: '  ' + shortRepair + '  ' } } },
      { action: 'update_summary', summaryPatch: shortRepair }],
    ['overlong legacy summary', { action: 'update_summary', nodePatch: { patch: { text: fullRepairText } } }, noFix],
    ['null legacy summary', { action: 'update_summary', nodePatch: null }, noFix],
    ['null legacy patch', { action: 'update_summary', nodePatch: { patch: null } }, noFix],
    ['blank legacy summary', { action: 'update_summary', nodePatch: { patch: { text: '  ' } } }, noFix],
    ['existing empty quote removal', nodeFix({ quote: '' }), nodeFix({ quote: '' })],
  ]
  for (const [name, proposedFix, expected] of patchCases) {
    modelReply = { verdict: 'contradicted', answer: 'Controlled output validation.', evidence: repairIssue.evidence, proposedFix }
    try {
      const result = await review({ graph: repairGraph, text: repairSource, reviewIssue: undefined })
      assert.equal(result.status, 'succeeded', label + '/' + name + ': malformed fixes must not fail the question task')
      assert.deepEqual(result.result?.proposedFix, expected, label + '/' + name)
    } finally { modelReply = null }
  }
  for (const ontology of ['proposition-v1', 'learning-view-v1']) {
    const ontologyGraph = { ...repairGraph, ontology,
      nodes: repairGraph.nodes.map(node => ({ ...node, type: ontology === 'proposition-v1' ? 'fact' : 'concept' })) }
    modelReply = { verdict: 'contradicted', answer: 'Controlled output validation.', evidence: repairIssue.evidence,
      proposedFix: nodeFix({ text: fullRepairText }) }
    try {
      const ordinary = await review({ graph: ontologyGraph, text: repairSource, reviewIssue: undefined })
      assert.deepEqual(ordinary.result?.proposedFix, noFix, ontology + ': ordinary question repairs must also be lossless')
      assert.match(requests.at(-1).system, /text 和 summaryPatch 不超过 500/)
      modelReply = request => request.system.includes('"kept"') ? { kept: [{ id: 'b1:repair-boundary' }] }
        : { issues: [{ ...repairIssue, id: 'repair-boundary', severity: 'error', category: 'grounding', confidence: 0.95,
          proposedFix: nodeFix({ text: fullRepairText }) }] }
      const beforeDeep = requests.length
      const deep = await review({ graph: ontologyGraph, text: repairSource, mode: 'standard', reviewIssue: undefined }, 'verify-graph')
      assert.equal(deep.status, 'succeeded', JSON.stringify(deep.error))
      const issue = deep.result.issues.find(issue => issue.id === 'b1:repair-boundary')
      assert.ok(issue, 'an overlong proposed repair must not discard the independently confirmed deep-review issue')
      assert.deepEqual(issue.proposedFix, noFix)
      assert.match(requests[beforeDeep].system, /quote 不超过 600/)
    } finally { modelReply = null }
  }
  const qualifiedSource = '> ' + 'The study compared multiple groups under the same controlled conditions. '.repeat(5)
    + 'The study reports improved scores only for adults, not for children.'
  const qualifiedText = 'The study compared multiple groups and measured their scores under the same conditions. '.repeat(3)
    + 'The conclusion applies only to adults, not for children.'
  const targetedGraph = { summary: 'Study results', nodes: [
    { id: 'n1', type: 'fact', text: qualifiedText, quote: qualifiedSource, paragraph: 0,
      evidence: [{ paragraph: 0, quote: qualifiedSource }], groundingStatus: 'grounded' },
    { id: 'n2', type: 'inference', text: 'Scores improve for the population described in the study.', paragraph: 0 },
  ], edges: [{ ...edge('n1', 'n2'), evidence: [{ paragraph: 0, quote: qualifiedSource }] }] }
  for (const kind of ['node', 'edge']) {
    const targetId = kind === 'node' ? 'n1' : 'n1>n2'
    modelReply = request => {
      const subgraph = JSON.parse(request.messages[0].content[0].text.split('\n').find(line => line.startsWith('{"summary":')))
      const qualifierPresent = subgraph.nodes.find(node => node.id === 'n1').text.includes('not for children')
      return { verdict: qualifierPresent ? 'false_positive' : 'confirmed',
        answer: qualifierPresent ? 'The node already limits its conclusion to adults.' : 'The displayed claim omits the restriction to adults.',
        evidence: [{ paragraph: 0, quote: qualifiedSource }],
        proposedFix: qualifierPresent ? { action: 'none' } : kind === 'node'
          ? { action: 'update_node', nodePatch: { id: 'n1', patch: { text: qualifiedSource } } }
          : { action: 'delete_edge', edgePatch: { fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports' } } }
    }
    let adjudicated
    try {
      adjudicated = await review({ graph: targetedGraph, text: qualifiedSource, target: { kind, id: targetId },
        question: 'Check whether the study conclusion is overstated.', reviewIssue: { ...candidate,
          targetKind: kind, targetId, title: 'Possible overgeneralization', detail: 'The conclusion may improperly include children.',
          evidence: [{ paragraph: 0, quote: qualifiedSource }] } })
    } finally { modelReply = null }
    assert.equal(adjudicated.result?.verdict, 'false_positive',
      label + '/' + kind + ': removing the node qualification before review must not manufacture a confirmed error')
    assert.deepEqual(context().subgraph.nodes, targetedGraph.nodes, 'targeted review needs complete node fields, not display previews')
    assert.deepEqual(context().subgraph.edges, targetedGraph.edges, 'targeted review must retain relation evidence')
  }
  const targetedInput = { graph: targetedGraph, text: qualifiedSource, question: 'Check n1.',
    target: { kind: 'node', id: 'n1' }, reviewIssue: { ...candidate, detail: 'Check the target and its complete context.',
      evidence: [{ paragraph: 0, quote: qualifiedSource }] } }
  for (const [name, modified] of [
    ['long claim', { ...targetedGraph, nodes: targetedGraph.nodes.map(node => node.id === 'n1' ? { ...node, text: 'x'.repeat(240000) } : node) }],
    ['long quote', { ...targetedGraph, nodes: targetedGraph.nodes.map(node => node.id === 'n1' ? { ...node, quote: 'x'.repeat(240000) } : node) }],
    ['long relation evidence', { ...targetedGraph, edges: [{ ...targetedGraph.edges[0], evidence: [{ paragraph: 0, quote: 'x'.repeat(240000) }] }] }],
    ['JSON escape expansion', { ...targetedGraph, nodes: targetedGraph.nodes.map(node => node.id === 'n1' ? { ...node, text: '\n'.repeat(120001) } : node) }],
  ]) {
    const before = requests.length
    const rejected = await review({ ...targetedInput, graph: modified })
    assert.equal(rejected.error?.code, 'review_context_incomplete', label + '/' + name)
    assert.equal(requests.length, before, 'an oversized complete context must not invoke the model or silently shorten fields')
  }
  evidenceParagraph = 0
  await review(targetedInput)
  const remaining = 240000 - context().prompt.length
  assert.ok(remaining > 0)
  const boundaryGraph = structuredClone(targetedGraph)
  boundaryGraph.nodes[0].text += 'x'.repeat(remaining)
  assert.equal((await review({ ...targetedInput, graph: boundaryGraph })).status, 'succeeded',
    'the exact serialized request budget remains supported without clipping')
  assert.equal(context().prompt.length, 240000)
  modelReply = { verdict: 'confirmed', answer: 'Controlled confirmation with no safe patch.',
    evidence: [{ paragraph: 0, quote: qualifiedSource }], proposedFix: { action: 'none' } }
  const beforeRepairOverflow = requests.length
  let repairOverflow
  try { repairOverflow = await review({ ...targetedInput, graph: boundaryGraph }) }
  finally { modelReply = null }
  assert.equal(requests.length - beforeRepairOverflow, 1,
    'a follow-up repair request must not exceed the complete context budget after appending the verdict')
  assert.equal(repairOverflow.result?.verdict, 'confirmed', 'keep an independently obtained verdict when repair context does not fit')
  assert.equal(repairOverflow.result?.repairStatus, 'context_limit')
  assert.deepEqual(repairOverflow.result?.proposedFix, { action: 'none' })
  boundaryGraph.nodes[0].text += 'x'
  const beforeBoundaryOverflow = requests.length
  assert.equal((await review({ ...targetedInput, graph: boundaryGraph })).error?.code, 'review_context_incomplete')
  assert.equal(requests.length, beforeBoundaryOverflow, 'one character over the serialized budget fails before any model request')
  const wholeGraphIssue = { ...candidate, targetKind: 'graph', targetId: null,
    title: 'Summary may omit a qualification', detail: 'Check the entire summary.' }
  evidenceParagraph = 0
  await review({ target: { kind: 'graph', id: null }, question: 'Check the entire summary.', reviewIssue: wholeGraphIssue })
  assert.deepEqual(context().subgraph.nodes.map(node => node.id).sort(), graph.nodes.map(node => node.id).sort(),
    label + ': a graph-wide verdict cannot be based only on keyword-selected nodes')
  assert.ok(context().prompt.includes('[P304] ' + paragraphs[304]),
    label + ': an unanchored source paragraph can qualify the whole summary and cannot be dropped')
  const wholeGraphInput = { graph, text, question: 'Check the entire summary.', target: { kind: 'graph', id: null },
    reviewIssue: wholeGraphIssue, model: { provider: 'fixture', model: 'controlled' } }
  const qualifiedGraph = { ...graph, nodes: graph.nodes.map(node => node.id === 'n9'
    ? { ...node, text: 'a'.repeat(250) + ' Important exception.', quote: 'b'.repeat(350) + ' Source qualification.' } : node),
  edges: graph.edges.map((edge, index) => index ? edge : { ...edge, evidence: [{ paragraph: 304, quote: paragraphs[304] }] }) }
  await review({ ...wholeGraphInput, graph: qualifiedGraph })
  assert.deepEqual(context().subgraph.nodes, qualifiedGraph.nodes, label + ': whole-graph claims require complete node fields')
  assert.deepEqual(context().subgraph.edges, qualifiedGraph.edges, label + ': retain complete relation evidence too')
  for (const [name, overrides] of [
    ['scoped source', { sourceUnits: [{ paragraph: 0, text: paragraphs[0] }] }],
    ['oversized complete source', { text: text + '\n\n> ' + 'x'.repeat(240001) }],
    ['too many source units', { text: Array.from({ length: 2001 }, (_, i) => 'Source ' + i).join('\n\n') }],
  ]) {
    const before = requests.length
    const rejected = await call('question-graph', { ...wholeGraphInput, ...overrides })
    assert.equal(rejected.error?.code, 'review_source_incomplete', label + '/whole graph/' + name)
    assert.equal(rejected.taskId, undefined)
    assert.equal(requests.length, before, 'incomplete whole-graph source cannot admit a model request')
    assert.equal((await call('task-active', {})).busy, false)
  }
  for (const [name, modified] of [
    ['truncated graph', { ...graph, view: { truncated: true } }],
    ['unknown endpoint', { ...graph, edges: [...graph.edges, edge('n9', 'n9999')] }],
    ['unconnected node overflow', { ...graph, nodes: [...graph.nodes, ...Array.from({ length: 91 }, (_, i) => node('n' + (1000 + i), 0))] }],
    ['complete prompt overflow', { ...graph, summary: 'x'.repeat(240000) }],
    ['large node field', { ...graph, nodes: graph.nodes.map(node => node.id === 'n9' ? { ...node, text: 'x'.repeat(240000) } : node) }],
  ]) {
    const before = requests.length
    const rejected = await review({ ...wholeGraphInput, graph: modified })
    assert.equal(rejected.error?.code, 'review_context_incomplete', label + '/whole graph/' + name)
    assert.equal(requests.length, before, 'never clip whole-graph content or spend a model call on partial context')
  }
  const sourcePayload = { graph: missingSourceGraph, question: 'Check n1.', target: { kind: 'node', id: 'n1' },
    reviewIssue: missingSourceIssue, model: { provider: 'fixture', model: 'controlled' } }
  const structural = 'AtomicCodeSegment_'.repeat(14)
  const nextUnit = 'The next canonical source unit is a distinct claim.'
  assert.deepEqual(createGraphContract().splitParagraphs('  start()\n' + structural + '\n  end()\n\n' + nextUnit),
    ['  start()', structural, '  end()', nextUnit],
    'a mixed code block establishes an atomic unindented unit that cannot be re-inferred in isolation')
  const structuralGraph = { nodes: [{ id: 'n1', type: 'fact', text: 'Code statement', paragraph: 10 },
    { id: 'n2', type: 'fact', text: 'Next statement', paragraph: 30 }], edges: [edge('n1', 'n2')] }
  modelReply = { verdict: 'false_positive', answer: 'The target is supported by its own source.',
    evidence: [{ paragraph: 1, quote: nextUnit }], proposedFix: { action: 'none' } }
  let structuralReview
  try {
    structuralReview = await review({ ...sourcePayload, graph: structuralGraph,
      sourceUnits: [{ paragraph: 10, text: structural }, { paragraph: 30, text: nextUnit }],
      reviewIssue: { ...missingSourceIssue, evidence: [{ paragraph: 30, quote: nextUnit }] } })
  } finally { modelReply = null }
  assert.equal(structuralReview.result?.verdict, 'false_positive',
    label + ': re-segmenting a scoped code line must not displace the following unit or invalidate its evidence')
  assert.deepEqual(structuralReview.result.evidence, [{ paragraph: 30, quote: nextUnit }],
    'model evidence must map back to its original canonical unit')
  assert.ok(context().prompt.includes('[P1]（原文 P30；evidence.paragraph 请使用前面的局部编号） ' + nextUnit))
  const structuralInput = { ...sourcePayload, graph: structuralGraph,
    sourceUnits: [{ paragraph: 30, text: nextUnit }, { paragraph: 10, text: structural }],
    reviewIssue: { ...missingSourceIssue, evidence: [{ paragraph: 30, quote: nextUnit }] } }
  try {
    modelReply = { verdict: 'false_positive', answer: 'Wrongly paired source citation.',
      evidence: [{ paragraph: 1, quote: 'AtomicCodeSegment_' }], proposedFix: { action: 'none' } }
    const mismatched = await review(structuralInput)
    assert.equal(mismatched.result.verdict, 'uncertain', 'a code quote cannot be attributed to the next canonical paragraph')
    assert.deepEqual(mismatched.result.evidence, [])
    modelReply = { verdict: 'confirmed', answer: 'Add the source evidence to the relation.',
      evidence: [{ paragraph: 1, quote: nextUnit }], proposedFix: { action: 'update_edge', edgePatch: {
        fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: 1, quote: nextUnit }] } } }
    const fixed = await review(structuralInput)
    assert.equal(fixed.result.proposedFix.action, 'update_edge', 'repair evidence validation must use the same unit boundaries')
    assert.equal(fixed.result.proposedFix.edgePatch.evidence[0].paragraph, 30)
    const anchored = { ...structuralGraph, nodes: structuralGraph.nodes.map(node => node.id === 'n2'
      ? { ...node, quote: nextUnit, evidence: [{ paragraph: 30, quote: nextUnit }] } : node) }
    const quick = await call('verify-graph', { ...structuralInput, graph: anchored, mode: 'quick' })
    assert.ok(!quick.report.issues.some(issue => issue.targetId === 'n2' && issue.invariantCode === 'node_paragraph_mismatch'),
      'quick local validation must not invent a paragraph mismatch after scoping')
    modelReply = { issues: [] }
    const deep = await review({ ...structuralInput, graph: anchored, mode: 'standard' }, 'verify-graph')
    assert.equal(deep.status, 'succeeded')
    assert.ok(context().prompt.includes('[P0] ' + structural + '\n[P1] ' + nextUnit),
      'deep verification batches must preserve exactly the same source boundaries')
    modelReply = { verdict: 'supported', answer: 'The later unit supports this statement.',
      evidence: [{ paragraph: 1, quote: nextUnit }], proposedFix: { action: 'none' } }
    const ordinary = await review({ ...structuralInput, reviewIssue: undefined })
    assert.deepEqual(ordinary.result.evidence, [{ paragraph: 30, quote: nextUnit }],
      'ordinary scoped questions also retain canonical source identity')
    modelReply = { verdicts: [] }
    const external = await review({ ...structuralInput, graph: { ...anchored, nodes: anchored.nodes.map(node =>
      node.id === 'n2' ? { ...node, paragraph: null } : node) }, mode: 'quick', sources: [] }, 'fact-check')
    assert.equal(external.result.claims.find(claim => claim.nodeId === 'n2').paragraph, 30,
      'quote-based fact-check anchors must resolve through the same scoped offsets')
  } finally { modelReply = null }
  const shortUnits = [0, 1].map(paragraph => ({ paragraph, text: paragraphs[paragraph] }))
  // Quote lines are indivisible source units; ordinary long prose is segmented.
  const quoteUnit = length => '> ' + 'x'.repeat(length - 2)
  for (const [name, overrides] of [
    ['node evidence omitted', { graph: { ...missingSourceGraph, nodes: [{ ...missingSourceGraph.nodes[0], evidence: [{ paragraph: 300 }] }, missingSourceGraph.nodes[1]] } }],
    ['relation evidence omitted', { graph: { ...missingSourceGraph, edges: [{ ...missingSourceGraph.edges[0], evidence: [{ paragraph: 300 }] }] } }],
    ['allegation evidence omitted', { reviewIssue: { ...missingSourceIssue, evidence: [{ paragraph: 300 }] } }],
    ['oversized required unit', { sourceUnits: [shortUnits[0], { paragraph: 1, text: 'x'.repeat(240001) }] }],
    ['raw oversized evidence', { sourceUnits: [], text: paragraphs[0] + '\n\n' + quoteUnit(240001) }],
    ['raw missing evidence', { sourceUnits: [], text: paragraphs[0] }],
    ['too many required units', { sourceUnits: Array.from({ length: 2001 }, (_, paragraph) => ({ paragraph, text: 'Source ' + paragraph })),
      graph: { nodes: [{ ...node('n1', 0), evidence: Array.from({ length: 2001 }, (_, paragraph) => ({ paragraph })) }], edges: [] } }],
  ]) {
    const before = requests.length
    const response = await call('question-graph', { ...sourcePayload, sourceUnits: shortUnits, text: '', ...overrides })
    assert.equal(response.error?.code, 'review_source_incomplete', label + '/' + name)
    assert.equal(response.taskId, undefined, 'incomplete source must not create a resumable model task')
    assert.equal(requests.length, before, label + '/' + name + ': no model request')
    assert.equal((await call('task-active', {})).busy, false, 'source rejection must not retain task admission')
  }
  evidenceParagraph = 0
  await review({ ...sourcePayload, text: '', sourceUnits: [{ paragraph: 300, text: 'x'.repeat(239990) }, ...shortUnits] })
  assert.deepEqual(context().subgraph.nodes.map(node => node.id), ['n1', 'n2'],
    'host scoping prioritizes required units over optional transport order')
  const noAnchor = { ...missingSourceGraph, nodes: [missingSourceGraph.nodes[0], { id: 'n2', type: 'fact', text: 'Unanchored neighbor' }] }
  await review({ ...sourcePayload, graph: noAnchor, text: '', sourceUnits: [shortUnits[0]] })
  assert.ok(context().subgraph.nodes.some(node => node.id === 'n2'),
    'lack of an anchor is reviewable data, not permission to erase an incident node')
  for (const kind of ['node', 'edge']) {
    const declared = structuredClone(missingSourceGraph)
    if (kind === 'node') declared.nodes[0].evidence = [{ paragraph: 300, quote: paragraphs[300] }]
    else declared.edges[0].evidence = [{ paragraph: 300, quote: paragraphs[300] }]
    for (const scoped of [false, true]) {
      await review({ ...sourcePayload, graph: declared, ...(scoped
        ? { text: '', sourceUnits: [...shortUnits, { paragraph: 300, text: paragraphs[300] }] } : { text }) })
      assert.ok(context().prompt.includes(paragraphs[300]), label + '/' + kind + ': declared distant evidence must reach the model')
    }
  }
  const exactBudgetSource = paragraphs[0] + '\n\n' + quoteUnit(240000 - paragraphs[0].length)
  const beforeSourceOnlyBudget = requests.length
  assert.equal((await review({ ...sourcePayload, text: exactBudgetSource })).error?.code, 'review_context_incomplete',
    'source alone may fit its budget while the required graph and instructions exceed the complete request budget')
  assert.equal(requests.length, beforeSourceOnlyBudget, 'never omit graph fields to squeeze in otherwise valid source')
  const optionalOversize = await call('question-graph', { ...sourcePayload,
    graph: { nodes: [node('n1', 0)], edges: [] }, text: paragraphs[0] + '\n\n' + quoteUnit(240001) })
  assert.ok(optionalOversize.taskId)
  for (let i = 0; i < 100 && (await call('task-active', {})).busy; i++) await new Promise(resolve => setTimeout(resolve, 5))
  const optionalStatus = await call('task-status', { taskId: optionalOversize.taskId })
  assert.equal(optionalStatus.error?.code, 'review_source_incomplete',
    'the assembled prompt must enforce source limits even when an adjacent paragraph expands it')
  for (const kind of ['node', 'edge', 'graph']) {
    evidenceParagraph = 300
    const target = { kind, id: kind === 'node' ? 'n1' : kind === 'edge' ? 'n1>n2' : null }
    const result = await review({ target, reviewIssue: { ...candidate, targetKind: kind, targetId: target.id } })
    const { subgraph, prompt } = context()
    assert.deepEqual(subgraph.nodes.map(item => item.id).sort(),
      (kind === 'graph' ? graph.nodes.map(node => node.id) : ['n1', 'n2', 'n3', 'n300', 'n301']).sort(),
      label + '/' + kind + ': review must retain the explicitly named distant comparison and both neighborhoods')
    assert.deepEqual(subgraph.edges, graph.edges,
      label + '/' + kind + ': induced relations between reviewed neighbors must not be discarded')
    assert.ok(prompt.includes('[P300] ' + paragraphs[300]) && prompt.includes('[P301] ' + paragraphs[301]),
      label + '/' + kind + ': the comparison and its neighbor need their own source evidence')
    assert.equal(result.result?.verdict, 'false_positive', label + ': independently grounded comparison must survive normalization')
  }

  const longIssue = { ...candidate, title: 'Possible duplicate n1: ' + 'a'.repeat(150),
    detail: 'b'.repeat(430) + ' Compare with n300 before deciding.' }
  const longQuestion = ('Independently verify: ' + longIssue.title + '. ' + longIssue.detail).slice(0, 600)
  assert.ok(!longQuestion.includes('n300'))
  const pairedContext = selectContext(graph, longQuestion, { kind: 'node', id: 'n1' }, longIssue)
  const longResult = await review({ graph: pairedContext, question: longQuestion, reviewIssue: longIssue })
  assert.equal(longResult.status, 'succeeded', label + ': client selection and host validation agree for long allegations')
  assert.deepEqual(context().subgraph.nodes.map(item => item.id).sort(), ['n1', 'n2', 'n3', 'n300', 'n301'].sort())
  assert.ok(context().prompt.includes('[P300] ' + paragraphs[300]) && context().prompt.includes('[P301] ' + paragraphs[301]))

  evidenceParagraph = 0
  await review({ reviewIssue: { ...candidate, detail: 'Check the target node and its relations.' } })
  assert.deepEqual(context().subgraph.nodes.map(item => item.id).sort(), ['n1', 'n2', 'n3'],
    label + ': unrelated nodes sharing a paragraph must not displace the bounded target neighborhood')
  assert.ok(context().subgraph.edges.some(item => item.fromNodeId === 'n2' && item.toNodeId === 'n3'),
    label + ': neighbor-to-neighbor relations are part of the reviewed context')

  let before = requests.length
  const missing = await review({ reviewIssue: { ...candidate, detail: 'Compare n1 with n777.' } })
  assert.equal(missing.error?.code, 'review_context_incomplete', label + ': an unavailable comparison must fail closed')
  assert.equal(requests.length, before, label + ': incomplete comparisons must not spend a model request')

  const tooLarge = { ...graph, nodes: [...graph.nodes, ...Array.from({ length: 96 }, (_, i) => node('n' + (400 + i), 0))],
    edges: [...graph.edges, ...Array.from({ length: 96 }, (_, i) => edge('n300', 'n' + (400 + i)))] }
  before = requests.length
  const oversized = await review({ graph: tooLarge })
  assert.equal(oversized.error?.code, 'review_context_incomplete', label + ': expanding comparison context must preserve the node budget')
  assert.equal(requests.length, before, label + ': oversized comparisons must fail before model admission')

  const plainIssue = { ...candidate, detail: 'Check the target and its complete context.' }
  const hub = { nodes: [node('n1', 0), ...Array.from({ length: 95 }, (_, i) => node('n' + (100 + i), 0))],
    edges: Array.from({ length: 95 }, (_, i) => edge('n1', 'n' + (100 + i))) }
  const atNodeLimit = await review({ graph: hub, reviewIssue: plainIssue })
  assert.equal(atNodeLimit.status, 'succeeded', label + ': the existing 96-node context must remain supported')
  assert.equal(context().subgraph.nodes.length, 96)
  assert.equal((await review({ ...wholeGraphInput, graph: hub })).status, 'succeeded')
  assert.equal(context().subgraph.nodes.length, 96, 'whole-graph review supports the full node budget')

  const denseNodes = hub.nodes.slice(0, 33)
  const neighborEdges = denseNodes.slice(1).flatMap(from => denseNodes.slice(1)
    .filter(to => to !== from).map(to => edge(from.id, to.id)))
  const dense = { summary: 'Dense fixture', nodes: denseNodes, edges: [...hub.edges.slice(0, 32), ...neighborEdges.slice(0, 480)] }
  const atEdgeLimit = await review({ graph: dense, reviewIssue: plainIssue })
  assert.equal(atEdgeLimit.status, 'succeeded', label + ': the full relation budget must remain usable')
  assert.equal(context().subgraph.edges.length, 512)
  assert.equal((await review({ ...wholeGraphInput, graph: dense })).status, 'succeeded')
  assert.equal(context().subgraph.edges.length, 512, 'whole-graph review supports the full relation budget')
  before = requests.length
  const denseOverflow = await review({ graph: { ...dense, edges: [...dense.edges, neighborEdges[480]] }, reviewIssue: plainIssue })
  assert.equal(denseOverflow.error?.code, 'review_context_incomplete', label + ': dense induced relations must have a bounded prompt')
  assert.equal(requests.length, before)
  const wholeDenseOverflow = await review({ ...wholeGraphInput, graph: { ...dense, edges: [...dense.edges, neighborEdges[480]] } })
  assert.equal(wholeDenseOverflow.error?.code, 'review_context_incomplete')
  assert.equal(requests.length, before, 'whole-graph dense overflow is rejected before a model request')

  const comparisons = { nodes: Array.from({ length: 25 }, (_, i) => node('n' + (i + 1), 0)), edges: [] }
  const manyReferences = count => ({ ...candidate, detail: comparisons.nodes.slice(0, count).map(item => item.id).join(' ') })
  const atReferenceLimit = await review({ graph: comparisons, reviewIssue: manyReferences(24) })
  assert.equal(atReferenceLimit.status, 'succeeded')
  assert.equal(context().subgraph.nodes.length, 24)
  before = requests.length
  const referenceOverflow = await review({ graph: comparisons, reviewIssue: manyReferences(25) })
  assert.equal(referenceOverflow.error?.code, 'review_context_incomplete', label + ': never silently drop references past the client signature limit')
  assert.equal(requests.length, before)

  assert.equal((await review({ ...wholeGraphInput, graph: comparisons,
    reviewIssue: { ...wholeGraphIssue, detail: comparisons.nodes.map(node => node.id).join(' ') } })).status, 'succeeded')
  assert.equal(context().subgraph.nodes.length, 25, 'whole-graph review does not use the named-reference retrieval cap')

  const sourceUnits = [0, 1, 2, 300, 301].map(paragraph => ({ paragraph, text: paragraphs[paragraph] }))
  evidenceParagraph = 3
  const scoped = await review({ sourceUnits })
  assert.equal(scoped.result?.evidence[0]?.paragraph, 300, label + ': scoped comparison evidence must map back to canonical paragraphs')
  assert.equal(scoped.result?.verdict, 'false_positive')
  assert.equal(JSON.stringify(graph), original, label + ': review must not mutate graph data')

  // Run the trajectory caller through the real host: a hidden incident edge
  // cannot be recovered by the host after the browser has discarded it.
  evidenceParagraph = 0
  const trajectoryIssue = { ...candidate, status: 'open', detail: 'Check the complete context of n1.' }
  const canonical = { ...graph, revision: 7, source: { documentId: 'trajectory-context', revision: 7 },
    verification: { lastReport: { reportId: 'trajectory-report', issues: [trajectoryIssue] } } }
  const view = { graph: { ...canonical, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1),
    view: { kind: 'window', truncated: true } }, sourceText: text }
  const start = client.lastIndexOf('        const submitQuestion = async (draftOverride, targetOverride, reviewIssue = null) => {')
  const end = client.indexOf('        const handleApplyIssue =', start)
  let taskId, error
  const env = { ...reviewHelpers, view, currentViewRef: { current: view }, sessionId: 'session',
    mountedSessionRef: { current: 'session' }, questionDraft: '', questionTarget: null, questionPhase: 'idle',
    modelCatalog: { issueReview: true }, effectiveModelArg: { provider: 'fixture', model: 'controlled' },
    questionAdmissionRef: { current: null }, verifyGenRef: { current: 0 }, reviewSaveRef: { current: null },
    trajCommitQueueRef: { current: Promise.resolve() }, trajCommitEpochRef: { current: 0 }, trajRevisionRef: { current: 7 },
    documentIdOfGraph: graph => graph?.source?.documentId,
    questionNeighborhoodGraph: selectContext, verificationSourcePayload: () => ({}),
    reviewSignatureHash: async value => createHash('sha256').update(value).digest('hex'),
    setError() {}, setQuestionError(value) { error = value }, setVerifyProgress() {}, setQuestionPhase() {},
    setQuestionResult() {}, setQuestionTarget() {}, setQuestionTaskId(value) { taskId = value },
    host: { call: (name, args) => name === 'document-export'
      ? { documentId: 'trajectory-context', revision: 7, graph: canonical, sourceText: text } : call(name, args) },
  }
  const submit = new Function(...Object.keys(env), client.slice(start, end) + '; return submitQuestion')(...Object.values(env))
  await submit('Check n1.', { kind: 'node', id: 'n1' }, trajectoryIssue)
  assert.ok(taskId, label + ': trajectory review admitted: ' + error)
  for (let i = 0; i < 100 && (await call('task-active', {})).busy; i++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(context().subgraph.nodes.some(node => node.id === 'n3'),
    label + ': trajectory review must send hidden incident nodes to the model, not just the visible window')
  assert.ok(context().subgraph.edges.some(edge => edge.fromNodeId === 'n1' && edge.toNodeId === 'n3'),
    label + ': trajectory review must retain the hidden incident relation')
}

class Timer extends Service {
  constructor(ctx) { super(ctx, 'timer'); ctx.mixin('timer', ['interval']) }
  interval() { return () => {} }
}
const ctx = new Context()
try {
  const handlers = new Map()
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({ get(name) { return name === 'llm' ? llm : null }, interval() { return () => {} } })
  await exercise((name, args) => handlers.get(name)(args), 'dynamic')
  delete globalThis.harness

  const routes = new Map()
  await ctx.plugin(Timer)
  ctx.provide('llm', llm)
  ctx.provide('webServer', { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } })
  await ctx.plugin(persistentPlugin).await()
  await exercise(async (name, args) => {
    const isStatus = name === 'task-status'
    const isRead = isStatus || name === 'task-active'
    const req = Readable.from(isRead ? [] : [JSON.stringify(args)])
    req.method = isRead ? 'GET' : 'POST'
    req.url = '/api/dsh-knowledge-graph/' + name + (isStatus ? '?taskId=' + encodeURIComponent(args.taskId) : '')
    req.headers = { 'content-type': 'application/json' }
    let response
    await routes.get('/api/dsh-knowledge-graph').handler(req, {
      writeHead(code) { assert.equal(code, 200) }, end(body) { response = JSON.parse(body) },
    })
    return response
  }, 'persistent')
  console.log('issue review context: dynamic/persistent comparison nodes, source units, induced relations and pre-model limits passed')
} finally {
  delete globalThis.harness
  await ctx.fiber.dispose()
  if (previousDatabase === undefined) delete process.env.DSH_KG_DB
  else process.env.DSH_KG_DB = previousDatabase
  rmSync(directory, { recursive: true, force: true })
}
