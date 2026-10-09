import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openSqliteStore } from '../lib/kg-store.mjs'
import { ordinaryWindowFixture } from './kg-document-window-ordinary-query-benchmark.mjs'
import { windowQueryFoldSql, isWindowQueryFoldSql, isWindowQuerySql } from './kg-document-window-query-benchmark.mjs'

const directory = mkdtempSync(join(tmpdir(), 'kg-window-fold-'))
let reads = 0, nativeChecks = 0, valueChecks = 0, interleavings = 0, casts = 0, fallbacks = 0
const values = [null, '', 'MiXeD ABC', 'CAFÉ café Straße Æ æ İ ı Σ σ', '中😀ABC', 'before\u0000AFTER',
  123.5, 1e20, 9223372036854775807n, Buffer.from('MiXeD ABC'), Buffer.from([65, 0, 66, 255]), Buffer.from([])]
const valueQueries = ['abc', 'mixed', 'CAFÉ', 'café', 'Æ', 'æ', 'İ', 'ı', 'ß', 'Σ', 'σ', '中😀abc',
  'before', 'after', '123', 'e+20', '9223372', '\u0000', '\\', 'absent']

// Test real SQLite coercion, including encodings and values that a JavaScript
// substring reference cannot faithfully represent. No production SQL is reused.
try {
  for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) {
    const database = new DatabaseSync(join(directory, encoding + '.sqlite'))
    try {
      database.exec("PRAGMA encoding = '" + encoding + "'; CREATE TABLE legacy_values (value)")
      for (const value of values) database.prepare('INSERT INTO legacy_values VALUES (?)').run(value)
      for (const sensitive of [false, true, false]) {
        database.exec('PRAGMA case_sensitive_like = ' + (sensitive ? 'ON' : 'OFF'))
        const folded = database.prepare(windowQueryFoldSql).get().folds_ascii === 1
        assert.equal(folded, !sensitive)
        for (const field of ['value', "COALESCE(value, '')"]) for (const query of valueQueries) {
          const pattern = '%' + query.toLowerCase() + '%'
          const old = database.prepare('SELECT rowid, LOWER(' + field + ') LIKE ? AS matched FROM legacy_values ORDER BY rowid').all(pattern)
          const current = database.prepare('SELECT rowid, ' + (folded ? 'CAST(' + field + ' AS TEXT)' : 'LOWER(' + field + ')') +
            ' LIKE ? AS matched FROM legacy_values ORDER BY rowid').all(pattern)
          assert.deepEqual(current, old); valueChecks++
        }
      }
    } finally { database.close() }
  }

  const database = join(directory, 'windows.sqlite'), writer = await openSqliteStore(database)
  writer.db.exec('PRAGMA journal_mode = WAL')
  const reader = await openSqliteStore(database), nativePrepare = reader.db.prepare
  const fixtures = [64, 12000].map(size => ordinaryWindowFixture(size, 'fold-window-' + size))
  const originalWhere = literal => literal ? `document_id = ? AND (
        INSTR(LOWER(node_id), ?) > 0 OR INSTR(LOWER(type), ?) > 0 OR INSTR(LOWER(text), ?) > 0 OR
        INSTR(LOWER(quote), ?) > 0 OR INSTR(LOWER(COALESCE(section_id, '')), ?) > 0 OR INSTR(LOWER(COALESCE(section_title, '')), ?) > 0
      )` : `document_id = ? AND (
        LOWER(node_id) LIKE ? OR LOWER(type) LIKE ? OR LOWER(text) LIKE ? OR
        LOWER(quote) LIKE ? OR LOWER(COALESCE(section_id, '')) LIKE ? OR LOWER(COALESCE(section_title, '')) LIKE ?
      )`
  const queries = ['MiXeD', 'BlOb', 'blobtype', 'CAFÉ', 'café', 'Straße', '中😀', '321', 'node17', 'windowunder', 'windowexact',
    'fact', 'observation 11999.', 'not-in-this-source', 'chapter_17', 'node_17', '%_', '\\', '\u0000', 'after', '   ']
  function read(fixture, options, { full = writer.getDocument(fixture.documentId), folded = true, boundary, mutate } = {}) {
    const query = (options.query || '').trim().slice(0, 200), literal = /[%_]/.test(query)
    const pattern = literal ? query.toLowerCase() : '%' + query.toLowerCase() + '%'
    const params = [fixture.documentId, pattern, pattern, pattern, pattern, pattern, pattern]
    const limit = options.limit || 800, where = originalWhere(literal)
    let probes = 0, direct, matched, counted = 0, fired = false
    reader.db.prepare = function (sql) {
      const statement = nativePrepare.call(this, sql)
      for (const method of ['get', 'all']) {
        const execute = statement[method]
        statement[method] = function (...args) {
          const value = execute.apply(this, args)
          if (boundary?.(sql) && !fired) { mutate(); fired = true; interleavings++ }
          if (isWindowQueryFoldSql(sql) && method === 'get') { probes++; assert.equal(value.folds_ascii === 1, folded) }
          if (isWindowQuerySql(sql)) {
            assert.deepEqual(args.slice(0, 7), params)
            assert.equal(sql.includes('CAST(node_id AS TEXT) LIKE ?'), !literal && folded)
            if (method === 'all') {
              assert.equal(args[7], limit)
              direct = nativePrepare.call(reader.db, 'SELECT * FROM graph_nodes WHERE ' + where + ' ORDER BY paragraph, node_id LIMIT ?').all(...params, limit)
              matched = nativePrepare.call(reader.db, 'SELECT COUNT(*) AS count FROM graph_nodes WHERE ' + where).get(...params).count
              assert.deepEqual(value, direct, 'Every original Native column and direct-row order must survive')
              nativeChecks++
              if (!literal) { if (folded) casts++; else fallbacks++ }
            } else { counted++; assert.equal(value.count, matched) }
          }
          return value
        }
      }
      return statement
    }
    let actual
    try { actual = reader.getDocumentWindow(fixture.documentId, { ...options, includeSourceText: false }) }
    finally { reader.db.prepare = nativePrepare }
    assert.equal(probes, query && !literal ? 1 : 0)
    if (query) {
      assert.equal(actual.view.matchedNodes, matched)
      assert.equal(counted, matched >= limit ? 1 : 0)
      assert.deepEqual(actual.nodes.slice(0, direct.length).map(node => node.id), direct.map(row => row.node_id))
    }
    assert.equal(actual.view.totalNodes, full.nodes.length); assert.equal(actual.view.totalEdges, full.edges.length)
    assert.equal(actual.view.truncated, full.nodes.length > actual.nodes.length || full.edges.length > actual.edges.length)
    assert.equal(actual.revision, full.revision); assert.deepEqual(actual.source, full.source)
    assert.deepEqual(actual.staging, full.staging); assert.equal(actual.sourceText, '')
    if (boundary) assert(fired, 'The independent commit must reach the intended SQL boundary')
    reads++
    return actual
  }
  try {
    for (const fixture of fixtures) {
      writer.saveGraph(fixture.graph, { sourceText: fixture.sourceText, sourceUnits: fixture.sourceUnits })
      for (const [field, id, value] of [
        ['text', 'n20', 'MiXeD CAFÉ only. windowexact'], ['text', 'n21', 'café Straße 中😀 windowexact'],
        ['quote', 'n22', Buffer.from('BlOb MiXeD only')], ['type', 'n23', Buffer.from('blobtype')],
        ['section_id', 'n24', 321], ['section_title', 'n25', null], ['quote', 'n26', 'before\u0000AFTER'],
        ['section_title', 'n27', 'MiXeD title'],
      ]) writer.db.prepare('UPDATE graph_nodes SET ' + field + ' = ? WHERE document_id = ? AND node_id = ?').run(value, fixture.documentId, id)
      const full = writer.getDocument(fixture.documentId), source = full.sourceText
      for (const sensitive of [false, true, false]) {
        reader.db.exec('PRAGMA case_sensitive_like = ' + (sensitive ? 'ON' : 'OFF'))
        for (const query of queries) for (const limit of [1, 200, 800, 2000]) read(fixture, { query, limit }, { full, folded: !sensitive })
      }
      assert.equal(writer.getDocument(fixture.documentId).sourceText, source)
    }
    const fixture = fixtures[1], full = writer.getDocument(fixture.documentId)
    reader.db.exec('BEGIN')
    reader.db.prepare('SELECT document_id FROM documents WHERE document_id = ?').get(fixture.documentId)
    writer.db.prepare('UPDATE graph_nodes SET text = ? WHERE document_id = ? AND node_id = ?').run('New independent token', fixture.documentId, 'n21')
    read(fixture, { query: 'café', limit: 200 }, { full })
    reader.db.exec('ROLLBACK')
    read(fixture, { query: 'New independent token', limit: 200 })
    for (const boundary of [isWindowQueryFoldSql,
      sql => isWindowQuerySql(sql) && sql.startsWith('SELECT *'),
      sql => isWindowQuerySql(sql) && sql.startsWith('SELECT COUNT'),
      sql => sql.startsWith('SELECT * FROM chunks')]) {
      read(fixture, { query: 'observation', limit: 1 }, { boundary, mutate: () => {
        writer.db.prepare('UPDATE graph_nodes SET text = text || ? WHERE document_id = ? AND node_id = ?').run(' write', fixture.documentId, 'n28')
        writer.db.prepare('UPDATE documents SET graph_revision = graph_revision + 1 WHERE document_id = ?').run(fixture.documentId)
      } })
      read(fixture, { query: 'observation', limit: 1 })
    }
    // An altered Unicode LOWER implementation must retain the original path.
    reader.db.function('lower', value => value == null ? null : String(value).toLowerCase())
    for (const query of ['café', 'CAFÉ', 'observation', '%_']) read(fixture, { query, limit: 200 }, { folded: false })
    reader.db.prepare = function (sql) {
      if (isWindowQueryFoldSql(sql)) throw new Error('Synthetic fold check failure')
      return nativePrepare.call(this, sql)
    }
    try { assert.throws(() => reader.getDocumentWindow(fixture.documentId, { query: 'fact' }), /Synthetic fold check failure/) }
    finally { reader.db.prepare = nativePrepare }
    read(fixture, { query: 'fact', limit: 200 }, { folded: false })
    assert(reader.db.isTransaction === undefined || reader.db.isTransaction === false)
    console.log(JSON.stringify({ ok: true, reads, nativeChecks, valueChecks, interleavings, casts, fallbacks,
      completeNativeRowsAndCountsIdentical: true, sixFieldsAndTypeCoercion: true, utf8AndUtf16: true,
      unicodeNullBlobNumericAndNul: true, connectionModeChanges: true, unicodeFunctionFallback: true,
      literalAndEmptyQueriesUnchanged: true, historicalAndIndependentWal: true, failureRecovery: true }))
  } finally { reader.close(); writer.close() }
} finally { rmSync(directory, { recursive: true, force: true }) }
