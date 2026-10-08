import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

// Exercise the real matcher, counting cached-text checks rather than depending
// on CPU speed. Every check costs 0.25ms in this deterministic task scheduler.
const work = { checks: 0, normalized: 0 }, timers = new Map()
let clock = 0, nextTimer = 0
const environment = { window: { React: {} }, console, work, AbortController, DOMException,
  performance: { now: () => clock }, textCost() { clock += 0.25 },
  setTimeout(fn) { const id = nextTimer++; timers.set(id, fn); return id },
  clearTimeout: id => timers.delete(id),
}
runInNewContext(`const includes = String.prototype.includes, normalize = String.prototype.normalize;
  String.prototype.includes = function(query, ...rest) {
    if (query !== '\\n' && includes.call(this, '\\n')) { work.checks++; textCost(); }
    return includes.call(this, query, ...rest);
  };
  String.prototype.normalize = function(form) {
    if (form === 'NFKC' && includes.call(this, '\\n')) work.normalized++;
    return normalize.call(this, form);
  };`, environment)
const viewer = readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8')
runInNewContext(viewer.replace('window.KGViewer = {', 'window.KGViewer = { createGraphNodeSearch,'), environment)
const { createGraphNodeSearch } = environment.window.KGViewer
const dispatch = () => { const [id, fn] = [...timers][0]; timers.delete(id); fn() }
async function settle(promise) {
  let done = false, result, failure
  promise.then(value => { done = true; result = value }, error => { done = true; failure = error })
  for (let pass = 0; pass < 5000; pass++) {
    await Promise.resolve(); await Promise.resolve()
    if (done) { if (failure) throw failure; return result }
    if (timers.size) dispatch()
  }
  throw new Error('Search did not settle')
}
const nodes = Array.from({ length: 12000 }, (_, i) => ({
  id: i === 5999 ? 'exact>id ' : 'n' + i, type: i % 3 ? 'fact' : 'concept', text: 'Node ' + i,
  quote: '合成摘录，保留完整证据。'.repeat(80) + ' Unique quote ' + i,
}))
const original = JSON.stringify(nodes)
// Independent full-scan oracle, outside the instrumented realm and cache.
const expected = (input, raw, type) => {
  const query = raw.trim().normalize('NFKC').toLocaleLowerCase()
  return input.filter(node => (!type || node.type === type) && (!query ||
    [node.id, node.text, node.quote].join('\n').normalize('NFKC').toLocaleLowerCase().includes(query)))
}
async function check(index, raw, type = '', input = nodes) {
  const before = work.checks
  const actual = await settle(index.findAsync(raw, type, new AbortController().signal))
  assert.deepEqual(Array.from(actual), expected(input, raw, type), 'Full-scan equivalence: ' + raw + ' / ' + type)
  return { checks: work.checks - before, matches: actual.length }
}
const index = createGraphNodeSearch(nodes)
await check(index, 'unique quote 1')
assert.equal(work.normalized, nodes.length)
const refinement = []
for (const query of ['ＵＮＩＱＵＥ ｑｕｏｔｅ １１', 'unique quote 119', 'unique quote 1199', 'unique quote 11999']) {
  refinement.push(await check(index, query))
}
assert.deepEqual(refinement.map(item => item.checks), [3111, 1111, 111, 11])
assert.deepEqual(refinement.map(item => item.matches), [1111, 111, 11, 1])
assert.equal(work.normalized, nodes.length, 'Refining cached queries does not rebuild normalized text')
assert.equal((await check(index, 'unique quote 1199')).checks, nodes.length, 'Backspacing must recover excluded nodes')
assert.equal((await check(index, 'node 5999')).checks, nodes.length, 'Unrelated queries start from the whole graph')
assert.equal((await check(index, 'unique quote 1', 'fact')).matches, expected(nodes, 'unique quote 1', 'fact').length)
assert.equal((await check(index, 'unique quote 11')).checks, nodes.length, 'Broadening type cannot reuse a restricted candidate set')
const narrowed = await check(index, 'unique quote 119', 'concept')
assert.equal(narrowed.checks, expected(nodes, 'unique quote 11', 'concept').length, 'All-type candidates can be narrowed by type')
await check(index, '', 'fact'); await check(index, '', 'concept'); await check(index, '')
await check(index, 'no-such-needle')
assert.equal((await check(index, 'no-such-needle-more')).checks, 0, 'An empty completed result remains a valid narrowing base')
await check(index, 'node 5999')

// Cancel after one real batch of cached-text checking. A partial result must
// never replace the completed 3,111 candidates, including the distant n11999.
const cancellable = createGraphNodeSearch(nodes)
await check(cancellable, 'unique quote 1')
const controller = new AbortController(), beforeCancel = work.checks
const pending = cancellable.findAsync('unique quote 11', '', controller.signal)
const rejected = pending.catch(error => error)
dispatch(); await Promise.resolve(); await Promise.resolve()
assert.equal(work.checks - beforeCancel, 32)
const stale = [...timers.values()][0]
controller.abort()
assert.equal((await settle(rejected)).name, 'AbortError')
stale(); await Promise.resolve()
assert.equal(work.checks - beforeCancel, 32)
assert.equal((await check(cancellable, 'unique quote 119')).checks, 3111, 'Cancelled candidates cannot hide matches outside the first batch')
const preaborted = new AbortController(); preaborted.abort()
const beforePreabort = work.checks
await assert.rejects(settle(cancellable.findAsync('unrelated', '', preaborted.signal)), { name: 'AbortError' })
assert.equal(work.checks, beforePreabort)
assert.equal((await check(cancellable, 'unique quote 1199')).checks, 111)

// Normalization can change an earlier character/sigma when raw text grows.
// Compare normalized queries, never assume a raw prefix guarantees narrowing.
const boundaries = [
  { id: 'space>id ', type: 'fact', text: 'Cafe plain', quote: 'literal evidence' },
  { id: 'accent', type: 'concept', text: 'Café accented', quote: 'accent evidence' },
  { id: 'sigma', type: 'fact', text: 'ΟΣ', quote: 'Greek end' },
  { id: 'sigma-more', type: 'concept', text: 'ΟΣΑ', quote: 'Greek continuation' },
  { id: 'gt', type: 'fact', text: 'x > 3', quote: 'strict greater than' },
  { id: 'lt', type: 'concept', text: 'x < 3', quote: 'strict less than' },
]
for (const asyncMode of [false, true]) {
  const boundaryIndex = createGraphNodeSearch(boundaries)
  for (const [raw, type] of [['Cafe', ''], ['Cafe\u0301', ''], ['ΟΣ', ''], ['ΟΣΑ', ''],
    ['x', ''], ['x >', 'fact'], ['x > 3', ''], ['x < 3', 'concept'], ['', 'fact'],
    ['', ''], ['  ＳＰＡＣＥ＞ＩＤ  ', ''], ['no-match', ''], ['no-match-more', ''], ['space>id', '']]) {
    const actual = asyncMode ? await settle(boundaryIndex.findAsync(raw, type, new AbortController().signal)) : boundaryIndex.find(raw, type)
    assert.deepEqual(Array.from(actual), expected(boundaries, raw, type))
  }
}
assert.equal(JSON.stringify(nodes), original)
assert.equal(timers.size, 0, 'Completed/cancelled searches leave no scheduled work')
for (const path of ['src/index.client.js', 'lib/client.js']) {
  assert(readFileSync(new URL('../' + path, import.meta.url), 'utf8').includes(createGraphNodeSearch.toString()), path + ': helper parity')
}
console.log(JSON.stringify({ ok: true, nodes: nodes.length, refinement,
  baselineTextChecks: nodes.length * refinement.length, optimizedTextChecks: refinement.reduce((sum, item) => sum + item.checks, 0),
  backspaceAndTypeBroadening: true, normalizedQueryContainment: true, partialCancellationCannotHideMatches: true,
  preabortedQuery: true, exactIdentityAndOrder: true, readOnly: true }))
