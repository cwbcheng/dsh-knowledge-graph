import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'

// Frozen rank predicate from PR #42 / 557ca88. The focus query has always
// selected the first binary node ID within the requested paragraph.
const oldRankSql = `SELECT COUNT(*) AS count FROM graph_nodes
  WHERE document_id = ? AND (paragraph IS NULL OR paragraph < ? OR (paragraph = ? AND node_id < ?))`
const smoke = process.argv.includes('--smoke')
const directory = mkdtempSync(join(tmpdir(), 'kg-paragraph-rank-'))
const store = await openSqliteStore(join(directory, 'rank.sqlite'))
let cases = 0, rankQueries = 0
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

function readWindow(id, paragraph, limit = 800) {
  const prepare = store.db.prepare
  let rank = null
  store.db.prepare = function (sql) {
    const statement = prepare.call(this, sql)
    if (sql.includes('paragraph IS NULL') && sql.includes('paragraph < ?')) {
      const get = statement.get
      statement.get = function (...args) {
        const result = get.apply(this, args)
        rank = { sql, args, count: result.count }; rankQueries++
        return result
      }
    }
    return statement
  }
  try {
    return { window: store.getDocumentWindow(id, { focusParagraph: paragraph, expectedRevision: 1, limit,
      includeSourceText: false }), rank }
  } finally { store.db.prepare = prepare }
}

try {
  // Compare real window membership to ordinary canonical ordering, not to
  // arithmetic based on paragraph numbers or a JavaScript locale collation.
  let seed = 0x52ac91
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed }
  const documents = [[], [{ id: 'only', type: 'fact', text: 'One', paragraph: 0 }]]
  documents.push(Array.from({ length: 1000 }, (_, i) => ({ id: 'same-' + i.toString(36), type: 'fact', text: 'Same unit', paragraph: 7 })))
  documents.push(Array.from({ length: 200 }, (_, i) => ({ id: 'unlinked-' + i, type: 'fact', text: 'No unit' })))
  const identities = [null, 0, 1, 7, 21, 10000, 1000000000, Number.MAX_SAFE_INTEGER - 1]
  for (let doc = 0; doc < 16; doc++) {
    const nodes = Array.from({ length: 100 + doc * 9 }, (_, i) => ({ id: 'opaque-' + random().toString(36) + '-' + i,
      type: 'fact', text: 'Record ' + i, paragraph: identities[random() % identities.length] }))
    // Several opaque IDs in one paragraph exercise SQLite binary ordering,
    // including astral versus BMP characters and a different case.
    nodes.push(...['A', 'a', 'Ω', '中', '\uE000', '\u{10000}'].map(id => ({ id: 'peer-' + id, type: 'fact', text: 'Shared unit', paragraph: 7 })))
    documents.push(nodes.reverse())
  }
  for (let doc = 0; doc < documents.length; doc++) {
    const id = ' rank:文档 ' + doc, nodes = documents[doc]
    store.saveGraph({ source: { documentId: id }, nodes, edges: [] }, { sourceText: '' })
    const ordered = store.getDocument(id).nodes
    const paragraphs = new Set([0, 7, 2, 1000000000, ...nodes.map(node => node.paragraph).filter(Number.isSafeInteger)])
    for (const paragraph of paragraphs) for (const limit of [1, 20, 200, 800]) {
      const { window, rank } = readWindow(id, paragraph, limit)
      const index = ordered.findIndex(node => node.paragraph === paragraph)
      assert(!window.error)
      assert.equal(window.revision, 1)
      assert.equal(window.view.focusParagraph, paragraph)
      assert.equal(window.sourceText, '')
      if (index < 0) {
        assert.equal(window.view.focusNodeId, '')
        assert.equal(window.nodes.length, 0)
        assert.equal(rank, null, 'An unlinked paragraph must not run a rank query')
      } else {
        assert(rank)
        const focus = ordered[index].id, expectedOffset = Math.floor(index / limit) * limit
        const old = store.db.prepare(oldRankSql).get(id, paragraph, paragraph, focus).count
        assert.equal(rank.count, old, 'Frozen old predicate and index ranges must agree')
        assert.equal(rank.count, index, 'Rank must match the first node in ordinary canonical order')
        assert.equal(window.view.focusNodeId, focus)
        assert.equal(window.view.nodeOffset, expectedOffset)
        assert.deepEqual(window.nodes, ordered.slice(expectedOffset, expectedOffset + limit))
        const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + rank.sql).all(...rank.args).map(row => row.detail)
        assert(plan.some(detail => /COVERING INDEX.*document_id=\? AND paragraph=\?/.test(detail)), 'NULLs use a covering paragraph range')
        assert(plan.some(detail => /COVERING INDEX.*document_id=\? AND paragraph<\?/.test(detail)), 'Earlier units use a covering paragraph range')
      }
      cases++
    }
  }
  console.log(JSON.stringify({ ok: true, productionWindowSql: true, documents: documents.length, windowCases: cases,
    rankQueries, oldPredicateParity: true, ordinaryWindowParity: true, nullFirstAndBinaryTies: true,
    sparseAndMaximumSafeIds: true, noRankForUnlinked: true, coveringParagraphRanges: true }))
  if (!smoke) {
    const samples = []
    for (const count of [12000, 96000]) {
      const id = 'rank-scale-' + count, nodes = Array.from({ length: count }, (_, paragraph) => ({
        id: 'record-' + paragraph.toString(36), type: 'fact', text: 'Record ' + paragraph, paragraph }))
      nodes.push(...['null-a', 'null-b', 'null-c'].map(id => ({ id, type: 'fact', text: 'Legacy unit' })))
      store.saveGraph({ source: { documentId: id }, nodes, edges: [] }, { sourceText: '' })
      for (const paragraph of [0, Math.floor(count / 2), count - 1]) {
        const { window, rank } = readWindow(id, paragraph)
        const oldArgs = [id, paragraph, paragraph, window.view.focusNodeId]
        const before = store.db.prepare(oldRankSql), after = store.db.prepare(rank.sql)
        assert.equal(before.get(...oldArgs).count, after.get(...rank.args).count)
        for (let warm = 0; warm < 3; warm++) { before.get(...oldArgs); after.get(...rank.args) }
        const oldTimes = [], newTimes = []
        // Time uninstrumented prepared statements; alternate order and report
        // only rank SQL, excluding hydration, diagnostics, HTTP, view and DOM.
        for (let run = 0; run < 9; run++) {
          const pair = [[before, oldArgs, oldTimes], [after, rank.args, newTimes]]
          if (run % 2) pair.reverse()
          for (const [statement, args, times] of pair) {
            const started = performance.now(); statement.get(...args); times.push(performance.now() - started)
          }
        }
        samples.push({ canonicalNodes: nodes.length, paragraph, rank: rank.count, nodeOffset: window.view.nodeOffset,
          returnedNodes: window.nodes.length, oldMedianMs: median(oldTimes), rangeMedianMs: median(newTimes),
          oldPlan: store.db.prepare('EXPLAIN QUERY PLAN ' + oldRankSql).all(...oldArgs).map(row => row.detail),
          rangePlan: store.db.prepare('EXPLAIN QUERY PLAN ' + rank.sql).all(...rank.args).map(row => row.detail) })
      }
    }
    console.log(JSON.stringify({ benchmark: '557ca88 rank predicate versus current production rank SQL', repeats: 9,
      scope: 'prepared rank statement only; excludes focus lookup, window hydration, diagnostics, HTTP, view and DOM', samples }))
  }
} finally {
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
