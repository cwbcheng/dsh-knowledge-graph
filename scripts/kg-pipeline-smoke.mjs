import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { normalizeGraph, mergeBatch, graphContract } from './kg-pipeline/normalize.mjs'
import { callLLM } from './kg-pipeline/llm-client.mjs'
import { prepareGraphImport, importGraph } from '../src/kg-import.mjs'
import { openSqliteStore } from '../src/kg-store.mjs'

const work = mkdtempSync(join(tmpdir(), 'kg-pipeline-'))
const script = fileURLToPath(new URL('./kg-pipeline/kg-extract.mjs', import.meta.url))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
let mode = 'success', calls = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  calls++
  const first = request.messages[1].content.match(/\[P(\d+)\] (.+)/)
  const text = first?.[2] || 'Synthetic source.'
  const graph = { summary: 'Synthetic batch', nodes: [{ id: 'n1', type: 'claim', text, quote: text, paragraph: Number(first?.[1] || 0) }], edges: [] }
  if (mode === 'invalid') {
    graph.nodes[0].type = 'rule'
    graph.nodes.push({ ...graph.nodes[0], id: 'n2', type: 'fact' })
    graph.edges.push({ fromNodeId: 'n1', toNodeId: 'n2', relation: 'example', evidence: [{ paragraph: graph.nodes[0].paragraph, quote: text }] })
  }
  const payload = JSON.stringify({ choices: [{ message: { content: JSON.stringify(graph) }, finish_reason: mode === 'truncated' ? 'length' : 'stop' }] })
  res.writeHead(mode === 'fail' || mode === 'slow-error' ? 500 : 200, { 'Content-Type': 'application/json' })
  res.flushHeaders()
  if (mode.startsWith('slow')) {
    const timer = setTimeout(() => res.end(payload), 1000)
    res.on('close', () => clearTimeout(timer))
  } else res.end(mode === 'oversized' ? 'x'.repeat(10000) : payload)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const env = { ...process.env, KG_LLM_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', KG_LLM_API_KEY: 'synthetic-key', KG_LLM_MODEL: 'synthetic-model' }
function run(args, extra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: work, env: { ...env, ...extra } })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pipeline child timed out')) }, 30000)
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', reject)
    child.on('close', code => { clearTimeout(timer); resolve({ code, output }) })
  })
}
const assertCode = (result, code) => assert.equal(result.code, code, result.output)
let store
try {
  const pages = join(work, 'pages.json')
  writeFileSync(pages, JSON.stringify({ 1: Array.from({ length: 180 }, (_, i) => 'Observation ' + i + ': This synthetic source records a bounded statement with a uniquely numbered label. ' + 'Additional neutral context. '.repeat(3)).join('\n\n') }))
  const options = out => ['--pages', pages, '--out', out, '--title', 'Synthetic audit']
  const full = join(work, 'full.json'), db = join(work, 'graph.sqlite')
  assertCode(await run([...options(full), '--import', '--db', db]), 0)
  const complete = json(full)
  assert(complete.nodes.length > 2)
  assert.equal(new Set(complete.nodes.map(node => node.id)).size, complete.nodes.length, 'Batch-local n1 IDs must be mapped uniquely')
  store = await openSqliteStore(db)
  const doc = complete.source.documentId, saved = store.getDocument(doc)
  const beforeCalls = calls
  assertCode(await run([...options(full), '--resume', '--import', '--db', db]), 0)
  assert.equal(calls, beforeCalls)
  assert.deepEqual(json(full), complete)
  assert.deepEqual(store.getDocument(doc), saved, 'Completed resume must not overwrite or increment the canonical revision')

  const partial = join(work, 'partial.json'), neverImported = join(work, 'never.sqlite')
  assertCode(await run([...options(partial), '--max-batches', '1', '--import', '--db', neverImported]), 2)
  assert.equal(json(partial).generation.status, 'partial')
  assert.equal(json(partial).staging.chunks.filter(chunk => chunk.status === 'completed').length, 1)
  assert(!existsSync(neverImported), 'Partial results must not even open a database for publication')
  const partialCalls = calls
  assertCode(await run([...options(partial), '--resume']), 0)
  assert.equal(calls - partialCalls, complete.generation.chunkCount - 1)
  assert.deepEqual(json(partial), complete, 'Recovered execution must equal uninterrupted execution')
  const checkpoint = readFileSync(partial + '.partial.json')
  writeFileSync(partial + '.partial.json', JSON.stringify({ nextBatch: 4, nodes: [] }))
  assertCode(await run([...options(partial), '--resume']), 1)
  assert.deepEqual(json(partial), complete)
  writeFileSync(partial + '.partial.json', checkpoint)
  assertCode(await run([...options(partial), '--resume'], { KG_LLM_MODEL: 'changed-model' }), 1)
  const source = readFileSync(pages)
  writeFileSync(pages, JSON.stringify({ 1: 'Changed source.' }))
  assertCode(await run([...options(partial), '--resume']), 1)
  writeFileSync(pages, source)
  assertCode(await run([...options(partial), '--max-batches', 'NaN']), 1)

  mode = 'fail'
  const failed = join(work, 'failed.json'), failedCalls = calls
  assertCode(await run([...options(failed), '--import', '--db', db]), 1)
  assert.equal(calls - failedCalls, 3)
  assert.equal(json(failed).generation.status, 'failed')
  assert.equal(json(failed).staging.chunks.filter(chunk => chunk.status === 'completed').length, 0)
  assert.equal(json(failed + '.partial.json').nextBatch, 0)
  assert.deepEqual(store.getDocument(doc), saved)
  mode = 'success'
  assertCode(await run([...options(failed), '--resume']), 0)
  assert.deepEqual(json(failed), complete, 'A failed batch must be retried, not skipped')
  for (const bad of ['invalid', 'truncated']) {
    mode = bad
    const out = join(work, bad + '.json')
    assertCode(await run(options(out)), 1)
    assert.equal(json(out).generation.status, 'failed')
  }
  mode = 'success'
  const unwritable = join(work, 'unwritable.json')
  mkdirSync(unwritable + '.partial.json')
  const callsBeforeWriteFailure = calls
  assertCode(await run([...options(unwritable), '--restart']), 1)
  assert.equal(calls, callsBeforeWriteFailure, 'Checkpoint errors must fail before spending model calls')
  assert(!readdirSync(work).some(name => name.endsWith('.tmp')))

  const paragraphs = ['Alpha exists.', 'Beta exists.', 'Beta supports Gamma.']
  const context = { paragraphTexts: paragraphs, documentId: 'ids', sourceId: 'source-ids', chunkId: 'chunk-ids' }
  const acc = { nodes: new Map(), edges: [], ids: [], edgeKeys: new Set(), warnings: [] }
  mergeBatch(normalizeGraph({ nodes: [{ id: 'n1', type: 'claim', text: 'Alpha', quote: paragraphs[0], paragraph: 0 }], edges: [] }, 3, new Set(), context), acc, 0)
  mergeBatch(normalizeGraph({ nodes: [{ id: 'n1', type: 'claim', text: 'Beta', quote: paragraphs[1], paragraph: 1 }, { id: 'n2', type: 'claim', text: 'Gamma', quote: paragraphs[2], paragraph: 2 }], edges: [{ fromNodeId: 'n1', toNodeId: 'n2', relation: 'supports', evidence: [{ paragraph: 2, quote: paragraphs[2] }] }] }, 3, new Set(acc.nodes.keys()), context), acc, 1)
  assert.deepEqual([...acc.nodes.values()].map(node => node.text), ['Alpha', 'Beta', 'Gamma'])
  assert.equal(acc.nodes.get(acc.edges[0].fromNodeId).text, 'Beta')
  assert.equal(acc.nodes.get(acc.edges[0].toNodeId).text, 'Gamma')

  const fake = structuredClone(complete)
  fake.nodes[0].evidence = [{ paragraph: 0, quote: 'Not in the source.' }]
  fake.nodes[0].groundingStatus = 'grounded'
  fake.nodes[0].entailmentStatus = 'verified'
  assert.throws(() => importGraph(store, fake, { expectedRevision: 1 }), /Evidence quote/)
  const fakeLegacyQuote = structuredClone(complete)
  fakeLegacyQuote.nodes[0].quote = 'Fabricated legacy quote.'
  assert.throws(() => prepareGraphImport(fakeLegacyQuote), /Node quote/)
  delete fakeLegacyQuote.nodes[0].evidence
  assert.throws(() => prepareGraphImport(fakeLegacyQuote), /Node quote/)
  const duplicate = structuredClone(complete)
  duplicate.nodes[1].id = duplicate.nodes[0].id
  assert.throws(() => prepareGraphImport(duplicate), /Duplicate node IDs/)
  const selfAuthorized = structuredClone(complete)
  selfAuthorized.verification = { status: 'verified' }
  selfAuthorized.factCheck = { status: 'verified' }
  selfAuthorized.source.chars = 1
  selfAuthorized.source.paragraphCount = 1
  const admitted = prepareGraphImport(selfAuthorized).graph
  assert.equal(admitted.verification, undefined)
  assert.equal(admitted.factCheck, undefined)
  assert.equal(admitted.source.chars, admitted.sourceText.length)
  assert.equal(admitted.source.paragraphCount, graphContract.splitParagraphs(admitted.sourceText).length)
  const typed = structuredClone(complete)
  typed.nodes[0].type = 'rule'
  typed.edges.push({ fromNodeId: typed.nodes[0].id, toNodeId: typed.nodes[1].id, relation: 'example', evidence: typed.nodes[0].evidence })
  assert.throws(() => prepareGraphImport(typed), /edge_source_type_mismatch/)
  assert.throws(() => importGraph(store, complete), /revision conflict/)
  const replacement = structuredClone(complete)
  replacement.summary = 'Replacement summary'
  replacement.sourceText += '\n\nRevision two source appendix.'
  replacement.nodes[0].entailmentStatus = 'verified'
  assert.equal(importGraph(store, replacement, { expectedRevision: 1 }).revision, 2)
  assert.equal(store.getDocument(doc).nodes.find(node => node.id === replacement.nodes[0].id).entailmentStatus, 'unverified')
  assert.equal(store.listRevisions(doc).find(revision => revision.revision === 1).restorable, 1)
  assert.notEqual(store.getDocument(doc).sourceText, saved.sourceText)
  assert.throws(() => store.restoreRevision(doc, 2, 2), /no restorable snapshot/)
  assert.throws(() => store.restoreRevision(doc, 1, 1), /revision conflict/)
  assert.equal(store.restoreRevision(doc, 1, 2).revision, 3)
  assert.equal(store.getDocument(doc).summary, saved.summary)
  assert.deepEqual(store.getDocument(doc).nodes, saved.nodes)
  assert.equal(store.getDocument(doc).sourceText, saved.sourceText)
  assert.equal(store.getDocument(doc).source.paragraphCount, saved.source.paragraphCount)
  assert.throws(() => store.commitViewGraph({ documentId: doc, graph: replacement }), /expectedRevision/)

  const oldEnv = Object.fromEntries(['KG_LLM_BASE_URL', 'KG_LLM_API_KEY', 'KG_LLM_MODEL'].map(key => [key, process.env[key]]))
  Object.assign(process.env, Object.fromEntries(Object.keys(oldEnv).map(key => [key, env[key]])))
  try {
    for (const slow of ['slow-success', 'slow-error']) {
      mode = slow
      const started = Date.now()
      await assert.rejects(callLLM({ system: '', user: '', timeoutMs: 50 }), /abort/i)
      assert(Date.now() - started < 900)
    }
    mode = 'oversized'
    await assert.rejects(callLLM({ system: '', user: '', maxResponseBytes: 64 }), /byte limit/)
  } finally {
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  assert.equal(graphContract.normalizeGraph, normalizeGraph, 'CLI must use the Host implementation, not a contract copy')
  console.log(JSON.stringify({ ok: true, nodes: complete.nodes.length, resumedWithoutLoss: true, completedImportIdempotent: true, failedBatchRetried: true, invalidImportsBlocked: true, snapshotRestored: true, bodyDeadline: true }))
} finally {
  store?.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(work, { recursive: true, force: true })
}
