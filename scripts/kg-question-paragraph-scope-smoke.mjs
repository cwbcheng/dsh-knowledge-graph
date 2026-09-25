import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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

console.log(JSON.stringify({ ok: true, firstParagraph: true, explicitRange: true,
  invalidReferencesRejected: true, scopedEvidenceAligned: true }))
