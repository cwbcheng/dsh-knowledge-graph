import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureReviewRun } from './kg-review-benchmark.mjs'
import { validateLiveModel, validateLiveTarget } from './kg-review-benchmark-live.mjs'
import { hostBuildSha256 } from '../lib/index.js'

const dir = mkdtempSync(join(tmpdir(), 'kg-live-benchmark-'))
const fixture = JSON.parse(readFileSync(new URL('./fixtures/kg-review-benchmark-codex-v1.json', import.meta.url), 'utf8'))
const gold = { ...fixture, datasetId: 'kg-live-runner-smoke', cases: fixture.cases.slice(0, 1) }
const goldPath = join(dir, 'gold.json')
const rawPath = join(dir, 'raw.json')
writeFileSync(goldPath, JSON.stringify(gold))
const productionUrl = new URL('http://127.0.0.1:3099/')
assert.throws(() => validateLiveTarget(productionUrl), /production or unrelated service port/)
assert.throws(() => validateLiveTarget(new URL('http://127.0.0.1:3109/')),
  /production or unrelated service port/)
validateLiveTarget(new URL('http://127.0.0.1:3119/'))
validateLiveModel({ provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' })
assert.throws(() => validateLiveTarget(new URL('http://127.0.0.1:3120/'),
  { provider: 'commandcode', model: 'deepseek/deepseek-v4.1-flash' }), /isolated 3119/)
assert.throws(() => validateLiveModel({ provider: 'commandcode', model: 'deepseek/deepseek-v4-pro' }),
  /restricted to DeepSeek V4.1 Flash/)
let admissions = 0
let preAdmissionRecorded = true
let failFirst = true
let busy = false
let concurrentOutput = null
let pendingActiveReplies = []
let runtimeHash = '0'.repeat(64)
const model = { provider: 'fixture', model: 'controlled' }
const result = { mode: 'issue_review', reviewedIssueId: gold.cases[0].id,
  target: { kind: 'node', id: 'n1' }, model, verdict: 'confirmed',
  proposedFix: gold.cases[0].gold.allowedFixes[0] }
const reply = (res, value) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
const server = createServer(async (req, res) => {
  const route = new URL(req.url, 'http://localhost/')
  if (route.pathname.endsWith('/engine-identity')) return reply(res, { hostBuildSha256: runtimeHash })
  if (route.pathname.endsWith('/list-models')) return reply(res, { providers: [{ id: model.provider, models: [{ id: model.model }] }] })
  if (route.pathname.endsWith('/task-active')) {
    if (concurrentOutput) {
      pendingActiveReplies.push(res)
      if (pendingActiveReplies.length === 1) setTimeout(() => {
        for (const waiting of pendingActiveReplies.splice(0)) reply(waiting, { busy })
      }, 400)
      if (pendingActiveReplies.length === 2) {
        for (const waiting of pendingActiveReplies.splice(0)) reply(waiting, { busy })
      }
      return
    }
    return reply(res, { busy })
  }
  if (route.pathname.endsWith('/question-graph')) {
    const capturePath = concurrentOutput || rawPath
    const recorded = existsSync(capturePath) ? JSON.parse(readFileSync(capturePath, 'utf8')).pending : null
    preAdmissionRecorded &&= recorded?.phase === 'admitting' && !recorded.taskId
    let body = ''
    for await (const chunk of req) body += chunk
    const request = JSON.parse(body)
    assert.equal(request.reviewIssue.id, gold.cases[0].id)
    admissions += 1
    return reply(res, { taskId: 'fixture-task-' + admissions })
  }
  if (route.pathname.endsWith('/task-status')) {
    const id = route.searchParams.get('taskId')
    if (id === 'fixture-task-1' && failFirst) return reply(res, { status: 'failed', error: { code: 'MISSING_CREDENTIAL' } })
    return reply(res, { status: 'succeeded', result, modelUsage: {
      startedRequests: 1, finishedRequests: 1, reportedRequests: 1,
      totals: { totalInputTokens: { requests: 1, tokens: 50 }, outputTokens: { requests: 1, tokens: 20 } },
    } })
  }
  res.writeHead(404); res.end()
})
async function run(port, extra = [], output = rawPath) {
  const args = [new URL('./kg-review-benchmark-live.mjs', import.meta.url).pathname,
    '--gold', goldPath, '--output', output, '--provider', model.provider, '--model', model.model,
    '--base-url', 'http://127.0.0.1:' + port, ...extra]
  return await new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => done({ code, stderr }))
  })
}
try {
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  const stale = await run(port, [], join(dir, 'stale.json'))
  assert.equal(stale.code, 1, 'stale runtime must fail before a paid task can start')
  assert.match(stale.stderr, /runtime build differs/)
  assert.equal(admissions, 0)
  runtimeHash = hostBuildSha256
  concurrentOutput = join(dir, 'concurrent.json')
  failFirst = false
  const concurrent = await Promise.all([run(port, [], concurrentOutput), run(port, [], concurrentOutput)])
  assert.equal(admissions, 1, 'two capture processes must not admit the same paid case twice')
  assert.equal(concurrent.filter(run => run.code === 0).length, 1)
  assert.equal(concurrent.filter(run => run.code === 1).length, 1)
  concurrentOutput = null
  admissions = 0
  failFirst = true
  const first = await run(port)
  assert.equal(first.code, 1)
  assert.match(first.stderr, /no automatic retry/)
  assert.equal(preAdmissionRecorded, true, 'the task must be recorded before a paid admission can reach the service')
  let raw = JSON.parse(readFileSync(rawPath, 'utf8'))
  assert.equal(admissions, 1)
  assert.equal(raw.failures[0].taskStatus.error.code, 'MISSING_CREDENTIAL')
  assert.equal(raw.cases.length, 0)
  const withoutApproval = await run(port)
  assert.equal(withoutApproval.code, 1)
  assert.match(withoutApproval.stderr, /--retry-failed/)
  assert.equal(admissions, 1, 'failed requests must not be billed twice on an ordinary resume')
  failFirst = false
  writeFileSync(rawPath + '.pending', 'orphaned incomplete write')
  const retried = await run(port, ['--retry-failed'])
  assert.equal(retried.code, 0, retried.stderr)
  assert.equal(admissions, 2)
  raw = JSON.parse(readFileSync(rawPath, 'utf8'))
  assert.equal(raw.cases.length, 1)
  assert.equal(captureReviewRun(gold, raw).predictions[0].usage.inputTokens, 50)
  assert.equal(readFileSync(rawPath + '.pending', 'utf8'), 'orphaned incomplete write',
    'an old interrupted write must not be overwritten or block a new atomic capture')
  const savedCase = raw.cases.pop()
  raw.pending = { caseId: savedCase.caseId, request: savedCase.request,
    taskId: savedCase.taskId, startedAtMs: savedCase.startedAtMs }
  writeFileSync(rawPath, JSON.stringify(raw))
  busy = true
  const resumed = await run(port)
  assert.equal(resumed.code, 0, resumed.stderr)
  assert.equal(admissions, 2, 'resuming an admitted task must poll, not submit another model request')
  assert.equal(JSON.parse(readFileSync(rawPath, 'utf8')).cases.length, 1)
  raw = JSON.parse(readFileSync(rawPath, 'utf8'))
  raw.cases = []
  raw.pending = { phase: 'admitting', caseId: savedCase.caseId, request: savedCase.request,
    startedAtMs: savedCase.startedAtMs }
  writeFileSync(rawPath, JSON.stringify(raw))
  const ambiguous = await run(port)
  assert.equal(ambiguous.code, 1)
  assert.match(ambiguous.stderr, /pending admission has no taskId/)
  assert.equal(admissions, 2, 'an ambiguous admission must never start another paid request automatically')
  console.log(JSON.stringify({ failureCaptured: true, explicitRetry: true, pendingResume: true,
    preAdmissionRecorded: true, orphanDoesNotBlockResume: true, ambiguousAdmissionFailClosed: true,
    duplicateAdmissions: false }))
} finally {
  server.close()
  rmSync(dir, { recursive: true, force: true })
}
