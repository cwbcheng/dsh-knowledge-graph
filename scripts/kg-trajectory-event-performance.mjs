// Construct actual production trajectory source rows, excluding React/DOM
// reconciliation, graph preparation and HTTP. Counters run outside timing.
// node scripts/kg-trajectory-event-performance.mjs [baseline-git-revision]
// --smoke guards lookup work, memo invalidation and row behavior without timings.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'

const smoke = process.argv.includes('--smoke')
const revisions = process.argv.slice(2).filter(value => value !== '--smoke')
if (revisions.length > 1 || revisions[0]?.startsWith('-')) throw new Error('Expected at most one baseline git revision')
const revision = revisions[0]
const current = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const baseline = revision ? execFileSync('git', ['show', revision + ':src/index.client.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : null
const h = (type, props, ...children) => ({ type, props: { ...props, children } })
const plain = value => JSON.parse(JSON.stringify(value))
const makeMemo = () => { let previous, value; return (factory, deps) => {
  if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) { previous = deps; value = factory() }
  return value
} }
function compile(client) {
  const tab = client.indexOf('      function TrajectoryTab(')
  const start = client.indexOf('        const paraEl = (p, i) => {', tab)
  const end = client.indexOf('        const resultPanel = view', start)
  assert(tab >= 0 && start > tab && end > start)
  let helpers = ''
  for (const [from, to] of [['      function sourceSpanIndexAtOffset(', '      function sourceCodeRanges('],
    ['      function createTraceEventLookup(', '      function TrajectoryTab(']]) {
    const a = client.indexOf(from), b = client.indexOf(to, a)
    if (a >= 0) { assert(b > a); helpers += client.slice(a, b) }
  }
  const memo = client.split('\n').find(line => line.includes('const traceEventLookup = useMemo(')) || ''
  const factory = new Function('h', 'view', 'traceEvents', 'TRACE_TYPE_LABEL', 'activePara', 'flashPara', 'handleParagraphClick', 'TYPE_META', 'badgeStyle', 'useMemo',
    helpers + memo + '\n' + client.slice(start, end) + '; return paraEl')
  const types = { fact: { label: '事实', color: '#3b82f6' }, concept: { label: '概念', color: '#059669' } }
  const view = { paraTypes: Array.from({ length: 12000 }, (_, i) => [i % 3 ? 'fact' : 'concept']) }
  return (events, { active = -1, flash = -1, click = () => {}, memo = makeMemo() } = {}) =>
    factory(h, view, events, { 'user/message': '用户消息', 'tool/result': '工具结果' }, active, flash, click, types, color => ({ color }), memo)
}
const count = 12000, paragraphs = []
let offset = 0
const events = Array.from({ length: count }, (_, i) => {
  const line = 'Fixture observation ' + i + ' is recorded in the source.'
  const event = { line, type: i % 2 ? 'user/message' : 'tool/result', seq: 1000 + i, start: offset, end: offset + line.length }
  paragraphs.push({ text: line, start: event.start, end: event.end }); offset = event.end + 2
  return event
})
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const reference = compile(baseline || current)(events)
const expectedRows = paragraphs.map((p, i) => plain(reference(p, i)))
const metrics = []
for (const [version, client] of [...(baseline ? [[revision, baseline]] : []), ['current', current]]) {
  const create = compile(client), firstTimes = [], repeatedTimes = []
  for (let trial = 0; trial < (smoke ? 1 : 5); trial++) {
    const memo = makeMemo()
    let start = performance.now()
    const render = create(events, { memo }), rows = paragraphs.map(render)
    firstTimes.push(performance.now() - start)
    rows.forEach((row, i) => assert.deepEqual(plain(row), expectedRows[i], 'initial complete row parity'))
    let elapsed = 0
    for (const active of [11996, 11997, 11998, 11999]) {
      start = performance.now()
      const next = create(events, { memo, active, flash: active })
      const updated = paragraphs.map(next)
      elapsed += performance.now() - start
      assert(updated[active].props.className.includes('kg-active kg-flash'))
      for (const i of [0, 4000, active - 1, active + 1].filter(i => i >= 0 && i < count)) assert.deepEqual(plain(updated[i]), expectedRows[i])
    }
    repeatedTimes.push(elapsed)
  }
  let arrayReads = 0, boundaryReads = 0
  const measured = new Proxy(events.map(event => ({ ...event,
    get start() { boundaryReads++; return event.start }, get end() { boundaryReads++; return event.end },
  })), { get(target, key, receiver) { if (typeof key === 'string' && /^\d+$/.test(key)) arrayReads++; return Reflect.get(target, key, receiver) } })
  const memo = makeMemo(), first = create(measured, { memo })
  for (let i = 11200; i < count; i++) first(paragraphs[i], i)
  const firstReads = { arrayReads, boundaryReads }
  arrayReads = boundaryReads = 0
  const retained = create(measured, { memo, active: 11999 })
  for (let i = 11200; i < count; i++) retained(paragraphs[i], i)
  const retainedReads = { arrayReads, boundaryReads }
  if (smoke) {
    assert(firstReads.arrayReads <= count, 'index creation must visit each event once')
    assert(firstReads.boundaryReads <= count * 6 + 800 * 18, 'cold lookups must be bounded')
    assert.equal(retainedReads.arrayReads, 0, 'selection updates must reuse the event index')
    assert(retainedReads.boundaryReads <= 800 * 18, 'retained lookups must be logarithmic')
    const replacement = [{ ...events[0], type: 'user/message', seq: 99999, start: 0, end: paragraphs.at(-1).end }]
    let clicked = -1
    const replaced = create(replacement, { memo, click: i => { clicked = i } })(paragraphs.at(-1), 11999)
    assert(replaced.props['aria-label'].includes('用户消息'), 'replaced ranges must refresh event labels')
    assert(replaced.props.children[0].props.children.some(child => child?.props?.children?.includes('#99999')))
    replaced.props.onKeyDown({ key: 'Enter', preventDefault() {} }); assert.equal(clicked, 11999)
  }
  metrics.push({ version, firstRenderMedianMs: Math.round(median(firstTimes) * 100) / 100,
    fourSelectionRendersMedianMs: Math.round(median(repeatedTimes) * 100) / 100, tail800: { firstReads, retainedReads } })
}
console.log(JSON.stringify({ sourceParagraphs: count, traceEvents: count, trials: smoke ? 1 : 5,
  completeRowParity: true, timingsExclude: ['HTTP', 'graph preparation', 'React/DOM reconciliation'], metrics }, null, 2))
