import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createGraphContract } from '../src/index.host.js'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('        const questionParagraphIndicesClient =')
const end = client.indexOf('        const questionNeighborhoodGraph =', start)
assert(start >= 0 && end > start, 'question source scope must remain testable')
const makeScope = new Function('splitParagraphs', 'MAX_VERIFY_SCOPE_CHARS', 'MAX_VERIFY_SCOPE_UNITS',
  client.slice(start, end) + '; return { questionParagraphIndicesClient, verificationSourcePayload }')
const { questionParagraphIndicesClient, verificationSourcePayload } = makeScope(
  source => source.split('\n\n').map(text => ({ text })), 80, 10)

assert.deepEqual(questionParagraphIndicesClient('P1、P548-P551、P12', 600), [0, 547, 548, 549, 550, 11])
assert.deepEqual(questionParagraphIndicesClient('P0 P11-P9 P999 P2-P83', 12), [])
assert.deepEqual(questionParagraphIndicesClient('P10 至 P15', 12), [9, 10, 11])

const source = Array.from({ length: 12 }, (_, index) => 'unique source paragraph ' + (index + 1)).join('\n\n')
const scoped = verificationSourcePayload(source, { nodes: [] }, '复核 P3 至 P5')
assert.deepEqual(scoped.sourceUnits.map(unit => unit.paragraph), [2, 3, 4])
assert.deepEqual(scoped.sourceUnits.map(unit => unit.text), [
  'unique source paragraph 3', 'unique source paragraph 4', 'unique source paragraph 5',
])
assert.equal(scoped.text, '', 'scoped source replaces the oversized full text')

const reviewIssue = { title: 'Check source', evidence: [{ paragraph: 0, quote: 'Target source.' }] }
const reviewGraph = { nodes: [{ id: 'n1', paragraph: 0 }, { id: 'n2', paragraph: 2 }],
  edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports' }] }
const overlong = ['Target source.', 'Optional context.', 'x'.repeat(81)].join('\n\n')
assert.throws(() => verificationSourcePayload(overlong, reviewGraph, 'Check n1.', reviewIssue), /原文|上下文/,
  'review scoping must not silently drop an over-budget implicit neighbor paragraph')
const prioritized = verificationSourcePayload(['Target source.', 'keyword '.repeat(8), 'Remote evidence.'].join('\n\n'),
  reviewGraph, 'Check keyword n1.', reviewIssue)
assert.deepEqual(prioritized.sourceUnits.map(unit => unit.paragraph), [0, 2],
  'optional keyword matches cannot displace required relation context')
const evidenceGraph = { nodes: [{ id: 'n1', paragraph: 0, evidence: [{ paragraph: 2 }] }],
  edges: [{ fromNodeId: 'n1', toNodeId: 'n1', evidence: [{ paragraph: 3 }] }] }
const complete = verificationSourcePayload(['Target source.', 'x'.repeat(81), 'Node evidence.', 'Edge evidence.', 'Issue evidence.'].join('\n\n'),
  evidenceGraph, 'Check n1.', { ...reviewIssue, evidence: [{ paragraph: 4 }] })
assert.deepEqual(complete.sourceUnits.map(unit => unit.paragraph), [0, 2, 3, 4],
  'node, edge and issue evidence are all mandatory, even outside neighboring paragraphs')
const boundaryGraph = { nodes: [{ id: 'n1', paragraph: 0 }, { id: 'n2', paragraph: 1 }], edges: [] }
assert.deepEqual(verificationSourcePayload(['x'.repeat(40), 'y'.repeat(40)].join('\n\n'), boundaryGraph, '', reviewIssue)
  .sourceUnits.map(unit => unit.paragraph), [0, 1], 'exact source budget remains supported')
assert.throws(() => verificationSourcePayload(['x'.repeat(40), 'y'.repeat(41)].join('\n\n'), boundaryGraph, '', reviewIssue), /原文/)
assert.throws(() => verificationSourcePayload(source, { nodes: [{ id: 'n1', paragraph: 99 }] }, '', reviewIssue), /原文/)
const unitLimited = makeScope(text => text.split('\n\n').map(text => ({ text })), 500, 2).verificationSourcePayload
assert.throws(() => unitLimited(['a', 'b', 'c', 'x'.repeat(501)].join('\n\n'),
  { nodes: [0, 1, 2].map(paragraph => ({ paragraph })) }, '', reviewIssue), /原文/,
  'source-unit budget cannot silently remove a required paragraph')
assert.ok(verificationSourcePayload(overlong, reviewGraph, 'Check n1.').sourceUnits.length > 0,
  'ordinary exploratory retrieval retains its permissive bounded behavior')
const structural = '  indentation_is_source_identity()'
const structuralScope = makeScope(createGraphContract().splitParagraphsOffsets, 80, 10).verificationSourcePayload(
  structural + '\n\n> ' + 'x'.repeat(81), { nodes: [{ id: 'n1', paragraph: 0 }] }, '', { evidence: [] })
assert.equal(structuralScope.sourceUnits[0].text, structural, 'source scoping must preserve indentation, not merely trimmed words')

console.log(JSON.stringify({ ok: true, firstParagraph: true, explicitRange: true,
  invalidReferencesRejected: true, scopedEvidenceAligned: true }))
