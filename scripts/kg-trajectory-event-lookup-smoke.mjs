import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const spanStart = client.indexOf('      function sourceSpanIndexAtOffset(')
const spanEnd = client.indexOf('      function sourceCodeRanges(', spanStart)
const traceStart = client.indexOf('      function normalizeTraceEvents(')
const traceEnd = client.indexOf('      function TrajectoryTab(', traceStart)
assert(spanStart >= 0 && spanEnd > spanStart && traceStart >= 0 && traceEnd > traceStart)
const helpers = client.slice(spanStart, spanEnd) + client.slice(traceStart, traceEnd)
const generated = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
assert(generated.includes(client.slice(spanStart, spanEnd)) && generated.includes(client.slice(traceStart, traceEnd)))
const { normalizeTraceEvents, createTraceEventLookup } = new Function(helpers + '; return { normalizeTraceEvents, createTraceEventLookup }')()
const original = (events, offset, paragraph) => (typeof offset === 'number' && Array.isArray(events)
  ? events.find(e => e && typeof e.start === 'number' && typeof e.end === 'number' && offset >= e.start && offset < e.end) : null)
  || events?.[paragraph] || null
let queries = 0
function check(events, offsets) {
  const before = JSON.stringify(events)
  const lookup = createTraceEventLookup(events)
  for (const offset of offsets) for (const paragraph of [-1, 0, 1, 5, 29, 1000]) {
    assert.equal(lookup.eventAt(offset, paragraph), original(events, offset, paragraph), 'first-match and legacy index parity')
    queries++
  }
  assert.equal(JSON.stringify(events), before, 'event lookup must not reorder or rewrite metadata')
  return lookup
}
const offsets = [undefined, null, '2', NaN, -Infinity, Infinity, -5]
for (let i = 0; i <= 110; i += 0.5) offsets.push(i)
const event = (seq, start, end) => Object.freeze({ seq, type: seq % 2 ? 'tool/result' : 'assistant/message', line: 'Event ' + seq, start, end })
check([], offsets)
check(Object.freeze([event(12, 0, 5), event(1, 8, 20), event(91, 20, 100)]), offsets)
check(Object.freeze([event(12, 0, 0), event(5, 2, 1), null, event(4, NaN, 20), event(9, '8', 20),
  event(10, 0, 5), event(11, 8, 20), event(3, 20, Infinity)]), offsets)
check(Object.freeze([event(71, -Infinity, 5), event(2, 5, Infinity)]), offsets)
// Preserve source-list precedence for overlapping, duplicate or unsorted
// imported spans. Sorting by offset or sequence would change their labels.
check(Object.freeze([event(90, 10, 70), event(4, 0, 30), event(2, 10, 70), event(8, 65, 100)]), offsets)
check(Object.freeze([event(5, 50, 80), event(1, 0, 10), event(2, 15, 35)]), offsets)
const sparse = []
sparse[3] = event(100, 8, 40)
check(sparse, offsets)
let seed = 1729
const random = limit => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % limit }
for (let trial = 0; trial < 40; trial++) {
  const events = Array.from({ length: 30 }, (_, i) => { const start = random(100); return event(i + 1, start, start + random(30)) })
  check(events, offsets)
}
const legacy = [{ seq: 30, type: 'user/message', line: '> First \u{1f4da} quote.\r\n> Another line.' },
  { seq: 70, type: 'tool/result', line: '  code_one();\n  code_two();' }, { seq: 71, line: '' },
  { seq: 90, type: 'assistant/message', line: 'Long source sentence. '.repeat(70) }]
const saved = JSON.stringify(legacy)
const normalized = normalizeTraceEvents(legacy)
assert.equal(JSON.stringify(legacy), saved, 'rebuilding legacy offsets must preserve the original records')
assert.equal(normalizeTraceEvents(normalized), normalized, 'canonical offset metadata stays intact')
const source = legacy.map(e => e.line).join('\n\n')
const legacyOffsets = Array.from({ length: source.length + 1 }, (_, i) => i)
check(normalized, legacyOffsets)
assert.equal(normalized[1].start, legacy[0].line.length + 2, 'CRLF and UTF-16 code units retain their source offsets')
// Replacing or appending an event array must produce a fresh lookup, with no
// session-wide cached event identity or offset leaking across restorations.
const before = createTraceEventLookup([event(1, 0, 10)])
const changed = event(20, 0, 30), appended = event(21, 32, 90)
const after = createTraceEventLookup([changed, appended])
assert.equal(before.eventAt(5, 0).seq, 1)
assert.equal(after.eventAt(5, 0), changed)
assert.equal(after.eventAt(50, 0), appended)
console.log(JSON.stringify({ queries, orderedAndIrregularParity: true, legacyOffsets: true,
  utf16AndCrlf: true, firstSourceEntryPreserved: true, replacementAndAppend: true, unchangedEvents: true }))
