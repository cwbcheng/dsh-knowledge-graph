import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { evaluateQualityGate } from './kg-quality-regression.mjs'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const frozenSource = readFileSync(new URL('./fixtures/world-recognition-part1-source.txt', import.meta.url), 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
const frozenSourceHash = createHash('sha256').update(frozenSource, 'utf8').digest('hex')
const frozenCases = JSON.parse(readFileSync(new URL('./fixtures/world-recognition-part1-qa-cases-calibrated-v2.json', import.meta.url), 'utf8'))
assert(frozenSource.length === 2844, 'frozen source character count changed: ' + frozenSource.length)
assert(frozenSourceHash === '9c926c36af919f6f5afb6f1d3b273853d8ceb9461197bb97649040bf2337658e', 'frozen source hash changed: ' + frozenSourceHash)
assert(frozenCases.length === 25, 'frozen calibrated-v2 case count changed: ' + frozenCases.length)

const cases = [
  { id: 'alpha', category: 'answerability', kind: 'node', selector: { all: ['甲', '成立'] } },
  { id: 'beta', category: 'answerability', kind: 'node', selector: { all: ['乙', '成立'] } },
]
const graph = {
  nodes: [
    { id: 'a', type: 'claim', text: '甲命题成立。', groundingStatus: 'grounded' },
    { id: 'b', type: 'claim', text: '乙命题成立。', groundingStatus: 'grounded' },
    { id: 'anchor', type: 'concept', text: '质量门禁锚点', groundingStatus: 'grounded' },
  ],
  edges: [],
}
const thresholds = {
  expectedCases: 2,
  frozenBaselinePassed: 2,
  maxCaseDrop: 0,
  minScore: 100,
  minNodes: 3,
}

const passing = evaluateQualityGate(graph, cases, thresholds)
assert(passing.ok, 'known-good graph did not pass the quality gate: ' + JSON.stringify(passing.issues))
assert(passing.benchmark.passed === 2 && passing.benchmark.score === 100, 'quality gate benchmark aggregate is wrong')

const missingKnowledge = evaluateQualityGate({ ...graph, nodes: graph.nodes.filter((node) => node.id !== 'b') }, cases, { ...thresholds, minNodes: 2 })
assert(!missingKnowledge.ok, 'QA regression unexpectedly passed')
assert(missingKnowledge.issues.some((issue) => issue.code === 'qa_score_below_minimum'), 'score regression was not reported')
assert(missingKnowledge.issues.some((issue) => issue.code === 'qa_cases_below_frozen_baseline'), 'baseline case regression was not reported')

const collapsedButAnswerable = evaluateQualityGate({ nodes: graph.nodes.slice(0, 2), edges: [] }, cases, thresholds)
assert(collapsedButAnswerable.benchmark.score === 100, 'collapse fixture should still answer every QA case')
assert(!collapsedButAnswerable.ok, 'catastrophically small graph unexpectedly passed')
assert(collapsedButAnswerable.issues.some((issue) => issue.code === 'catastrophic_node_collapse'), 'node-collapse sentinel was not reported')

const changedCases = evaluateQualityGate(graph, cases.slice(0, 1), { ...thresholds, frozenBaselinePassed: 1 })
assert(!changedCases.ok, 'changed frozen-case count unexpectedly passed')
assert(changedCases.issues.some((issue) => issue.code === 'frozen_case_count_changed'), 'frozen-case count drift was not reported')

console.log(JSON.stringify({ ok: true, scoreGate: true, baselineGate: true, collapseSentinel: true, frozenSource: true, frozenCases: true }))
