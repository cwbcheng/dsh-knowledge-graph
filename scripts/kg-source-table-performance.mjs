// Production table preprocessing; counters are separate from uninstrumented timing.
// The deterministic parser stand-in excludes native HTML parsing and browser work.
// node scripts/kg-source-table-performance.mjs [baseline-git-revision] | --smoke
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { runInNewContext } from 'node:vm'

const args = process.argv.slice(2), smoke = args.includes('--smoke')
const revision = args.find(arg => arg !== '--smoke')
if (args.length > 1 || revision?.startsWith('-')) throw new Error('Expected --smoke or one baseline git revision')
const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const baseline = revision ? execFileSync('git', ['show', revision + ':src/index.client.js'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }) : null
const sandbox = { window: { React: {} }, console }
runInNewContext(readFileSync(new URL('../extension/viewer.js', import.meta.url), 'utf8'), sandbox)
const splitParagraphs = sandbox.window.KGViewer.splitParagraphs
function extract(bundle) {
  const start = bundle.indexOf('      function sourceSpanIndexAtOffset('), end = bundle.indexOf('      // Build the view model:', start)
  assert(start > 0 && end > start)
  return bundle.slice(start, end)
}
// Freeze the former first-overlap algorithm independently of the candidate.
const oldGroups = `function sourceTableGroups(source, paragraphs) {
  const byParagraph = new Map(), codeRanges = sourceCodeRanges(source)
  for (const match of source.matchAll(/<table\\b[^>]*>[\\s\\S]*?<\\/table\\s*>/gi)) {
    if (match[0].length > 100000) continue
    const start = match.index, end = start + match[0].length
    if (codeRanges.some(([from, to]) => from <= start && start < to)) continue
    const first = paragraphs.findIndex(p => p.start < end && p.end > start)
    if (first < 0 || byParagraph.has(first)) continue
    let last = first
    while (last + 1 < paragraphs.length && paragraphs[last + 1].start < end) last++
    if (paragraphs[first].start > start || paragraphs[last].end < end) continue
    if (Array.from({ length: last - first + 1 }, (_, n) => first + n).some(i => byParagraph.has(i))) continue
    const parsed = new DOMParser().parseFromString(match[0], 'text/html').querySelector('table')
    if (!parsed) continue
    const rows = Array.from(parsed.rows, row => Array.from(row.cells, cell => ({
      text: cell.textContent.trim(), colspan: Math.min(20, Math.max(1, cell.colSpan)), rowspan: Math.min(20, Math.max(1, cell.rowSpan)),
    }))).filter(row => row.length > 0)
    if (!rows.length) continue
    const group = { first, last, rows, caption: parsed.caption?.textContent.trim() || '',
      prefix: source.slice(paragraphs[first].start, start).trim(), suffix: source.slice(end, paragraphs[last].end).trim() }
    for (let i = first; i <= last; i++) byParagraph.set(i, group)
  }
  return byParagraph
}`
const currentCode = extract(client), codeStart = currentCode.indexOf('      function sourceTableGroups(')
assert(codeStart > 0)
const referenceCode = currentCode.slice(0, codeStart) + oldGroups
function compile(code, counts, parsedInputs) {
  const Parser = class {
    parseFromString(html, mime) {
      assert.equal(mime, 'text/html')
      if (counts) counts.parserCalls++
      if (parsedInputs) parsedInputs.push(html)
      return { querySelector(selector) {
        assert.equal(selector, 'table')
        if (html.includes('data-missing')) return null
        return { caption: { textContent: ' caption ' }, rows: html.includes('data-empty') ? [] : [
          { cells: [] }, { cells: [{ textContent: ' ' + html + ' ', colSpan: 0, rowSpan: 99 },
            { textContent: 'value', colSpan: 99, rowSpan: 0 }] },
        ] }
      } }
    }
  }
  if (counts) code = code.replace('function sourceCodeRanges(source) {', 'function sourceCodeRanges(source) { observe();')
  return new Function('DOMParser', 'NL', 'observe', code + '; return sourceTableGroups')(Parser, '\n', () => counts.codeScans++)
}
const table = i => '<table><tr><td>📚来源 ' + i + '</td></tr></table>'
const plain = groups => JSON.parse(JSON.stringify([...groups]))
let comparisons = 0
function compare(source, paragraphs = splitParagraphs(source)) {
  for (const p of paragraphs) if (p && typeof p === 'object') Object.freeze(p)
  Object.freeze(paragraphs)
  const input = JSON.stringify(paragraphs), runs = []
  for (const code of [referenceCode, currentCode]) {
    const parsedInputs = []
    let result, error
    try {
      const groups = compile(code, null, parsedInputs)(source, paragraphs)
      for (const [index, group] of groups) {
        assert(index >= group.first && index <= group.last)
        for (let i = group.first; i <= group.last; i++) assert.equal(groups.get(i), group)
      }
      result = plain(groups)
    } catch (err) { error = { name: err.name, message: err.message } }
    runs.push({ result, error, parsedInputs })
    assert.equal(JSON.stringify(paragraphs), input, 'source range inputs remain unchanged')
  }
  assert.deepEqual(runs[1], runs[0], 'complete groups and parser invocation parity')
  comparisons++
}
const markup = table(0), source = '📚 前言\r\n\r\n' + markup + '\r\n\r\n结语'
const start = source.indexOf('<table>'), end = start + markup.length
compare(source, [{ start: 0, end: start + 12 }, { start: start + 12, end: source.length }])
for (const ranges of [[], [{ start, end }], [{ start: start + 1, end }], [{ start, end: end - 1 }],
  [{ start: 0, end: start }, { start, end }], [{ start: 0, end: start - 1 }, { start, end }],
  [{ start: end, end: source.length }, { start, end }], [{ start: 0, end }, { start, end }],
  [{ start: String(start), end: String(end) }], [{ start: NaN, end: NaN }, { start, end }],
  [{ start: -Infinity, end: Infinity }], [{ start, end: start }, { start, end }],
  [{ start, end: start - 1 }, { start, end }], [null, { start, end }],
  [{ start, end }, undefined], [undefined, { start, end }],
  [{ start, end }, , { start: source.length, end: source.length + 1 }]]) compare(source, ranges)
for (const text of ['', 'plain 📚\r\n\nsource', '<table>unclosed', '<table>' + 'x'.repeat(100001) + '</table>',
  markup + '\n\n' + table(1), 'prefix ' + markup + ' suffix ' + table(1),
  '<table data-empty></table>\n\n' + markup, '<table data-missing></table>\n\n' + markup,
  ...['```html\n' + markup + '\n```', '~~~html\r\n' + markup + '\r\n~~~', '    ' + markup,
    '\t' + markup, '示例 `' + markup + '`', '示例 ``' + markup + '``', '示例 \\`\n\n' + markup,
    '未闭合 `\n\n' + markup, '<table><tr><td>`code`</td></tr></table>']]) compare(text)
let seed = 98431
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
for (let trial = 0; trial < 150; trial++) {
  const text = Array.from({ length: 15 }, (_, i) => [table(i), 'plain ' + i, '例 `' + table(i) + '`', '    ' + table(i)][random(4)]).join('\n\n')
  const ranges = splitParagraphs(text).map(p => ({ start: p.start, end: p.end }))
  compare(text, ranges.map(p => ({ ...p })))
  const shuffled = ranges.map(p => ({ ...p }))
  for (let i = shuffled.length - 1; i > 0; i--) { const j = random(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]] }
  compare(text, shuffled)
  compare(text, ranges.map((p, i) => ({ start: i % 3 ? p.start : Math.max(0, p.start - 30), end: p.end + (i % 4 ? 0 : 20) })))
}
const book = Array.from({ length: 12000 }, (_, i) => 'Fixture observation ' + i + ' is recorded in the source.')
const samples = [
  ['plain-12000', book.join('\n\n')],
  ['single-table-first', book.map((text, i) => i === 0 ? table(i) : text).join('\n\n')],
  ['single-table-last', book.map((text, i) => i === book.length - 1 ? table(i) : text).join('\n\n')],
  ['tables-400', book.map((text, i) => i % 30 ? text : table(i)).join('\n\n')],
  ['tables-and-literals-400', book.map((text, i) => i % 30 === 0 ? table(i) : i % 30 === 1 ? '例 `' + table(i) + '`' : text).join('\n\n')],
  ['literals-only-400', book.map((text, i) => i % 30 ? text : '例 `' + table(i) + '`').join('\n\n')],
  ['unclosed-only', book.join('\n\n') + '\n\n<table>unclosed'],
  ['oversized-only', book.join('\n\n') + '\n\n<table>' + 'x'.repeat(100001) + '</table>'],
  ['small-table', 'before\n\n' + markup + '\n\nafter'],
]
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)], results = []
for (const [scenario, text] of samples) {
  const paragraphs = splitParagraphs(text), expected = plain(compile(referenceCode)(text, paragraphs)), metrics = []
  for (const [version, code] of [...(baseline ? [[revision, extract(baseline)]] : []), ['current', currentCode]]) {
    const times = [], group = compile(code)
    if (!smoke) for (let trial = 0; trial < 7; trial++) {
      const begin = performance.now(), result = group(text, paragraphs)
      times.push(performance.now() - begin)
      assert.deepEqual(plain(result), expected)
    }
    const counts = { paragraphBoundaryReads: 0, codeScans: 0, parserCalls: 0 }
    const spans = paragraphs.map(p => ({ get start() { counts.paragraphBoundaryReads++; return p.start },
      get end() { counts.paragraphBoundaryReads++; return p.end } }))
    assert.deepEqual(plain(compile(code, counts)(text, spans)), expected)
    if (version === 'current') {
      if (['plain-12000', 'unclosed-only', 'oversized-only'].includes(scenario)) assert.equal(counts.codeScans, 0)
      else assert.equal(counts.codeScans, 1, 'code ranges are built at most once per source')
      if (!expected.length) assert.equal(counts.paragraphBoundaryReads, 0, 'no real table needs no paragraph lookup')
      if (scenario === 'single-table-first') assert.equal(counts.paragraphBoundaryReads, 7, 'a single first table skips the ordered-range check')
      if (scenario === 'single-table-last') assert.equal(counts.paragraphBoundaryReads, 24004, 'a single last table keeps original lookup work')
      if (scenario === 'small-table') assert.equal(counts.paragraphBoundaryReads, 9, 'a small single table keeps original lookup work')
      if (scenario.startsWith('tables-')) assert(counts.paragraphBoundaryReads < 40000, 'one ordered-range check plus binary lookups')
    }
    metrics.push({ version, ...(times.length ? { medianMs: Math.round(median(times) * 10000) / 10000 } : {}), ...counts })
  }
  results.push({ scenario, sourceChars: text.length, paragraphs: paragraphs.length, groupedParagraphs: expected.length, metrics })
}
console.log(JSON.stringify({ ok: true, comparisons, completeGroupAndParserParity: true, inputsUnchanged: true,
  countersSeparate: true, trials: smoke ? 0 : 7, productionPreprocessing: true,
  excludes: ['native DOMParser HTML parsing', 'HTTP', 'paragraph splitting', 'React/DOM rendering'], results }, null, 2))
