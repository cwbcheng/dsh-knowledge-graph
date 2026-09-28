import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createGraphContract } from '../src/index.host.js'
import { hostBuildSha256, verifyBenchmarkEngineIdentity } from './kg-benchmark-engine-identity.mjs'
import { fingerprintDiscoveryGold, inspectDiscoveryCapture } from './kg-discovery-benchmark.mjs'
import { acquireBenchmarkCaptureLock, saveBenchmarkCapture } from './kg-benchmark-capture-atomic.mjs'

const MODEL = { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }
const BASE = new URL('http://127.0.0.1:3119/')
const fail = message => { throw new Error(message) }
const arg = name => { const index = process.argv.indexOf('--' + name); return index < 0 ? null : process.argv[index + 1] }
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex')
const endpoint = name => new URL('/api/dsh-knowledge-graph/' + name, BASE)

export { verifyBenchmarkEngineIdentity as verifyDiscoveryEngineIdentity } from './kg-benchmark-engine-identity.mjs'

async function call(name, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const response = await fetch(endpoint(name), body === undefined ? { signal: controller.signal } : {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!response.ok) fail(name + ' returned HTTP ' + response.status)
    return response.json()
  } finally { clearTimeout(timer) }
}


export function verifyDiscoverySnapshot(gold, exported, loaded, plan) {
  const documentId = gold.graph?.source?.documentId
  const sourceText = gold.sourceUnits.map(unit => unit.text).join('\n\n')
  const split = createGraphContract().splitParagraphs(sourceText)
  if (!documentId || split.length !== gold.sourceUnits.length ||
      split.some((text, index) => text !== gold.sourceUnits[index].text)) {
    fail('frozen source units do not match the Host splitter')
  }
  if (exported?.error || loaded?.error || plan?.error ||
      exported.revision !== gold.revision || loaded.revision !== gold.revision ||
      loaded.sourceText !== sourceText || digest(exported.graph) !== digest(gold.graph) ||
      plan.coverage?.nodeCount !== gold.graph.nodes.length ||
      plan.coverage?.edgeCount !== gold.graph.edges.length ||
      plan.coverage?.sourceUnitCount !== gold.sourceUnits.length ||
      !Number.isSafeInteger(plan.coverage?.batchCount) || plan.coverage.batchCount < 1) {
    fail('isolated Host snapshot or full-verification plan differs from frozen gold')
  }
  return { graph: exported.graph, sourceUnits: gold.sourceUnits, revision: exported.revision }
}

async function runCapture(output) {
  const goldPath = arg('gold') || fail('usage: --gold FROZEN_GOLD --output NEW_RAW_CAPTURE [--resume]')
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'))
  const goldHash = fingerprintDiscoveryGold(gold)
  const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null
  if (existing && !process.argv.includes('--resume')) fail('capture exists; use --resume to poll its existing task, never readmit')
  if (!existing && process.argv.includes('--resume')) fail('no pending capture to resume')
  verifyBenchmarkEngineIdentity(await call('engine-identity'))
  const promptVersion = 'full-verification-' + hostBuildSha256.slice(0, 16)
  let capture = existing
  if (existing) {
    if (existing.schemaVersion !== 1 || existing.datasetId !== gold.datasetId ||
        existing.goldHash !== goldHash || digest(existing.model) !== digest(MODEL) ||
        existing.promptVersion !== promptVersion || existing.hostBuildSha256 !== hostBuildSha256 ||
        existing.serviceUrl !== BASE.origin ||
        existing.pending?.taskId == null || existing.taskStatus) fail('capture identity or pending task differs')
  } else {
    const active = await call('task-active')
    if (active.busy || active.task || active.trackedTask) fail('isolated service is busy; no model task started')
    const models = await call('list-models')
    if (!models.providers?.some(provider => provider.id === MODEL.provider &&
        provider.models?.some(item => item.id === MODEL.model))) fail('approved Flash model is unavailable on 3119')
    const documentId = gold.graph.source.documentId
    const exported = await call('document-export', { documentId })
    const loaded = await call('document-load', { documentId })
    const plan = await call('verification-plan', { documentId, expectedRevision: gold.revision,
      canonicalFull: true, mode: 'standard' })
    const snapshot = verifyDiscoverySnapshot(gold, exported, loaded, plan)
    const activeAgain = await call('task-active')
    if (activeAgain.busy || activeAgain.task || activeAgain.trackedTask) fail('isolated service became busy; no model task started')
    verifyBenchmarkEngineIdentity(await call('engine-identity'))
    capture = { schemaVersion: 1, datasetId: gold.datasetId, goldHash,
      runId: 'discovery-' + Date.now(), model: MODEL, promptVersion, hostBuildSha256,
      serviceUrl: BASE.origin, snapshot, plan,
      pending: { phase: 'admitting', startedAtMs: Date.now() } }
    saveBenchmarkCapture(output, capture)
    const admitted = await call('verify-graph', { documentId, expectedRevision: gold.revision,
      canonicalFull: true, mode: 'standard', concurrency: 1, model: MODEL })
    if (!admitted.taskId) {
      capture.pending = { ...capture.pending, phase: 'rejected', admission: admitted }
      saveBenchmarkCapture(output, capture)
      fail('full-graph verification rejected; capture retained')
    }
    capture.pending = { ...capture.pending, phase: 'running', taskId: admitted.taskId }
    capture.runId = admitted.taskId
    saveBenchmarkCapture(output, capture)
    process.stdout.write('isolated full-graph task started: ' + admitted.taskId + '\n')
  }
  const deadline = Date.now() + 300000
  let status
  do {
    await new Promise(done => setTimeout(done, 1500))
    status = await call('task-status?taskId=' + encodeURIComponent(capture.pending.taskId))
  } while (status.status === 'running' && Date.now() < deadline)
  if (status.status === 'running' || status.status === 'not_found') {
    fail('task is ' + status.status + '; pending task retained for inspection or --resume, no automatic retry')
  }
  verifyBenchmarkEngineIdentity(await call('engine-identity'))
  capture.taskStatus = status
  capture.startedAtMs = capture.pending.startedAtMs
  capture.finishedAtMs = Date.now()
  delete capture.pending
  saveBenchmarkCapture(output, capture)
  if (status.status !== 'succeeded') fail('task ended as ' + status.status + '; raw result saved, no retry')
  const inspected = inspectDiscoveryCapture(gold, capture)
  process.stdout.write(JSON.stringify({ output, runId: capture.runId, goldHash,
    reportHash: inspected.reportHash, aiIssues: inspected.issues.length,
    localIssuesExcluded: inspected.localIssueCount,
    modelUsage: status.modelUsage || null }) + '\n')
}
async function main() {
  const output = resolve(arg('output') || fail('missing --output'))
  const release = acquireBenchmarkCaptureLock(output)
  try { await runCapture(output) } finally { release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
