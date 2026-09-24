import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const start = client.indexOf('      function sourceCodeRanges(source) {')
const end = client.indexOf('      // Build the view model:', start)
assert(start >= 0 && end > start)

const parsedInputs = []
const DOMParser = class {
  parseFromString(html, mimeType) {
    assert.equal(mimeType, 'text/html')
    parsedInputs.push(html)
    return { querySelector: () => ({
      rows: [
        { cells: [{ textContent: '阶段', colSpan: 1, rowSpan: 1 }, { textContent: '系统', colSpan: 1, rowSpan: 1 }] },
        { cells: [{ textContent: '感觉', colSpan: 1, rowSpan: 1 }, { textContent: '眼睛、耳朵', colSpan: 1, rowSpan: 1 }] },
      ],
      caption: null,
    }) }
  }
}
const sourceTableGroups = new Function('DOMParser', 'NL', `${client.slice(start, end)}; return sourceTableGroups`)(DOMParser, '\n')
const source = '前文\n\n<table><tr><td>阶段</td><td>系统</td></tr><tr><td>感觉</td><td>眼睛、耳朵</td></tr></table>\n\n后文'
const tableStart = source.indexOf('<table>')
const split = source.indexOf('耳朵')
const tableEnd = source.indexOf('</table>') + '</table>'.length
const paragraphs = [
  { text: '前文', start: 0, end: 2 },
  { text: source.slice(tableStart, split), start: tableStart, end: split },
  { text: source.slice(split, tableEnd), start: split, end: tableEnd },
  { text: '后文', start: source.indexOf('后文'), end: source.length },
]
const groups = sourceTableGroups(source, paragraphs)
assert.equal(groups.size, 2, 'both evidence paragraphs must remain addressable')
assert.equal(groups.get(1), groups.get(2), 'one table must span a split cell without changing paragraph identities')
assert.equal(groups.get(1).first, 1)
assert.equal(groups.get(1).last, 2)
assert.equal(groups.get(1).rows[1][1].text, '眼睛、耳朵')
assert.equal(parsedInputs[0], source.slice(tableStart, tableEnd), 'the parser needs complete source markup, not individual fragments')
assert.equal(groups.has(0), false)
assert.equal(groups.has(3), false)
assert.equal(sourceTableGroups('前文\n\n<table><tr><td>未闭合', paragraphs).size, 0, 'malformed markup must not consume unrelated source')
const markup = '<table><tr><td>literal</td></tr></table>'
for (const literal of ['```html\n' + markup + '\n```', '~~~html\n' + markup + '\n~~~',
  '    ' + markup, '示例 `' + markup + '`']) {
  const at = literal.indexOf('<table>')
  assert.equal(sourceTableGroups(literal, [{ text: markup, start: at, end: at + markup.length }]).size, 0,
    'a literal HTML example must remain source text: ' + literal)
}
const withInlineCell = '<table><tr><td>`code`</td></tr></table>'
assert.equal(sourceTableGroups(withInlineCell, [{ text: withInlineCell, start: 0, end: withInlineCell.length }]).size, 1,
  'inline code inside a real table must not hide the table')
const escapedTick = '示例 \\` 不是代码\n\n' + withInlineCell
const escapedTableStart = escapedTick.indexOf('<table>')
assert.equal(sourceTableGroups(escapedTick, [{ text: withInlineCell, start: escapedTableStart, end: escapedTick.length }]).size, 1,
  'an escaped backtick before a real table must not suppress it')
const unclosedTick = '未闭合的 ` 不是代码段\n\n' + withInlineCell
const unclosedTableStart = unclosedTick.indexOf('<table>')
assert.equal(sourceTableGroups(unclosedTick, [{ text: withInlineCell, start: unclosedTableStart, end: unclosedTick.length }]).size, 1,
  'an unmatched backtick in an earlier paragraph must not hide a later table')
assert(client.includes("h('table', { className: 'kg-source-table'"), 'render a semantic table')
assert(client.includes("id: grouped ? 'kg-para-' + i"), 'keep every original paragraph anchor')
assert(!client.includes('dangerouslySetInnerHTML'), 'untrusted source HTML must never be mounted directly')
console.log(JSON.stringify({ ok: true, splitTable: true, paragraphAnchors: true, codeExamplesPreserved: true, rawHtmlNotMounted: true }))
