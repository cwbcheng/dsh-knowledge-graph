import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectedRequest, fingerprintReviewGold } from './kg-review-benchmark.mjs'
import { acquireBenchmarkCaptureLock, saveBenchmarkCapture } from './kg-benchmark-capture-atomic.mjs'
import { hostBuildSha256, verifyBenchmarkEngineIdentity } from './kg-benchmark-engine-identity.mjs'

function fail(message) { throw new Error(message) }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}
function hash(value) { return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex') }
function argument(name) {
  const index = process.argv.indexOf('--' + name)
  return index < 0 ? null : process.argv[index + 1] || fail('missing --' + name + ' value')
}
async function response(url, body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const result = await fetch(url, body === undefined ? { signal: controller.signal } : {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal,
    })
    if (!result.ok) fail(url.pathname + ' returned HTTP ' + result.status)
    return await result.json()
  } finally { clearTimeout(timer) }
}
export function validateLiveTarget(base, model = null) {
  if (!['127.0.0.1', 'localhost'].includes(base.hostname) || base.protocol !== 'http:' || base.pathname !== '/') {
    fail('benchmark runner requires a loopback HTTP service root')
  }
  if (['3099', '3109'].includes(base.port)) fail('refusing production or unrelated service port')
  if (model?.provider === 'commandcode' && base.port !== '3119') {
    fail('CommandCode benchmark calls require the isolated 3119 service')
  }
}
export function validateLiveModel(model) {
  if (model.provider === 'commandcode' && model.model !== 'deepseek/deepseek-v4.1-flash') {
    fail('CommandCode benchmark calls are restricted to DeepSeek V4.1 Flash')
  }
}
async function runCapture(output) {
  const goldPath = argument('gold') || fail('usage: --gold GOLD --output RAW --provider ID --model ID [--base-url http://127.0.0.1:3119] [--max-cases N]')
  const model = { provider: argument('provider') || fail('missing --provider'), model: argument('model') || fail('missing --model') }
  validateLiveModel(model)
  const maxCases = Number(argument('max-cases') || Number.MAX_SAFE_INTEGER)
  if (!Number.isSafeInteger(maxCases) || maxCases < 1) fail('invalid --max-cases')
  const base = new URL(argument('base-url') || 'http://127.0.0.1:3119')
  validateLiveTarget(base, model)
  const endpoint = name => new URL('/api/dsh-knowledge-graph/' + name, base)
  const gold = JSON.parse(readFileSync(goldPath, 'utf8'))
  const identity = { schemaVersion: 1, datasetId: gold.datasetId, goldHash: fingerprintReviewGold(gold),
    runId: 'live-' + model.provider + '-' + model.model + '-' + Date.now(), model,
    promptVersion: 'host-issue-review-' + hostBuildSha256.slice(0, 16), hostBuildSha256,
    measurementStatus: 'reported_real_run' }
  const existing = existsSync(output) ? JSON.parse(readFileSync(output, 'utf8')) : null
  if (existing && (existing.datasetId !== identity.datasetId || existing.goldHash !== identity.goldHash ||
      existing.model?.provider !== model.provider || existing.model?.model !== model.model ||
      existing.promptVersion !== identity.promptVersion || existing.hostBuildSha256 !== hostBuildSha256 ||
      existing.serviceUrl !== base.origin ||
      !Array.isArray(existing.cases) || !Array.isArray(existing.failures))) {
    fail('existing capture identity differs; choose a new output path')
  }
  const capture = existing || { ...identity, serviceUrl: base.origin, cases: [], failures: [] }
  const seen = new Set(capture.cases.map(item => item.caseId))
  if (seen.size !== capture.cases.length || capture.cases.some(entry => !gold.cases.some(item => item.id === entry.caseId))) {
    fail('existing capture has duplicate or unknown cases')
  }
  if (capture.pending && (seen.has(capture.pending.caseId) ||
      !gold.cases.some(item => item.id === capture.pending.caseId &&
        hash(expectedRequest(item, model)) === hash(capture.pending.request)))) {
    fail('pending task does not match the frozen case; inspect it before continuing')
  }
  if (capture.pending && !capture.pending.taskId) {
    fail('pending admission has no taskId; inspect the isolated task state before any retry')
  }
  verifyBenchmarkEngineIdentity(await response(endpoint('engine-identity')))
  const models = await response(endpoint('list-models'))
  if (!models.providers?.some(provider => provider.id === model.provider && provider.models?.some(item => item.id === model.model))) {
    fail('model is not listed by isolated service')
  }
  let completed = 0
  for (const item of gold.cases) {
    if (seen.has(item.id)) continue
    if (completed >= maxCases) break
    const request = expectedRequest(item, model)
    if (capture.pending && capture.pending.caseId !== item.id) fail('pending task is out of order; inspect the capture')
    if (!capture.pending && capture.failures.some(failure => failure.caseId === item.id) &&
        !process.argv.includes('--retry-failed')) {
      fail('previous failure for ' + item.id + '; inspect it and pass --retry-failed explicitly to start a new task')
    }
    if (!capture.pending) {
      const active = await response(endpoint('task-active'))
      if (active.busy || active.task || active.trackedTask) fail('service is busy; no benchmark request was started for ' + item.id)
      verifyBenchmarkEngineIdentity(await response(endpoint('engine-identity')))
      const startedAtMs = Date.now()
      capture.pending = { phase: 'admitting', caseId: item.id, request, startedAtMs }
      saveBenchmarkCapture(output, capture)
      const admitted = await response(endpoint('question-graph'), request)
      if (!admitted.taskId) {
        capture.failures.push({ caseId: item.id, startedAtMs, finishedAtMs: Date.now(), admission: admitted })
        delete capture.pending
        saveBenchmarkCapture(output, capture)
        fail('question-graph rejected ' + item.id + ': ' + JSON.stringify(admitted.error || admitted))
      }
      capture.pending = { ...capture.pending, phase: 'running', taskId: admitted.taskId }
      saveBenchmarkCapture(output, capture)
      process.stdout.write(item.id + ' started as ' + admitted.taskId + '\n')
    }
    const pending = capture.pending
    let taskStatus
    const deadline = Date.now() + 240000
    do {
      await new Promise(done => setTimeout(done, 1500))
      taskStatus = await response(new URL(endpoint('task-status').toString() + '?taskId=' + encodeURIComponent(pending.taskId)))
    } while (taskStatus.status === 'running' && Date.now() < deadline)
    if (taskStatus.status !== 'running' && taskStatus.status !== 'not_found') {
      verifyBenchmarkEngineIdentity(await response(endpoint('engine-identity')))
    }
    if (taskStatus.status !== 'succeeded') {
      if (taskStatus.status !== 'running' && taskStatus.status !== 'not_found') {
        capture.failures.push({ ...pending, finishedAtMs: Date.now(), taskStatus })
        delete capture.pending
        saveBenchmarkCapture(output, capture)
      }
      fail('task ' + pending.taskId + ' ended as ' + taskStatus.status + '; no automatic retry or cancellation')
    }
    if (taskStatus.result?.mode !== 'issue_review' || taskStatus.result.reviewedIssueId !== item.allegation.issueId ||
        taskStatus.result.model?.provider !== model.provider || taskStatus.result.model?.model !== model.model) {
      fail('task ' + pending.taskId + ' returned mismatched issue or model; pending capture retained')
    }
    capture.cases.push({ caseId: item.id, request, taskId: pending.taskId, startedAtMs: pending.startedAtMs,
      finishedAtMs: Date.now(), taskStatus })
    delete capture.pending
    saveBenchmarkCapture(output, capture)
    completed += 1
    process.stdout.write(item.id + ' ' + taskStatus.result.verdict + ' (' + completed + ' new)\n')
  }
  process.stdout.write(JSON.stringify({ output, completed: capture.cases.length, total: gold.cases.length,
    goldHash: capture.goldHash, model }) + '\n')
}
async function main() {
  const output = resolve(argument('output') || fail('missing --output'))
  const release = acquireBenchmarkCaptureLock(output)
  try { await runCapture(output) } finally { release() }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
