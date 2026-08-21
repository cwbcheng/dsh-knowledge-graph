#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { runGraphQaBenchmark } from './kg-qa-benchmark.mjs'

const DEFAULT_SOURCE = new URL('./fixtures/world-recognition-part1-source.txt', import.meta.url)
const DEFAULT_CASES = new URL('./fixtures/world-recognition-part1-qa-cases-calibrated-v2.json', import.meta.url)
const DEFAULT_SOURCE_SHA256 = '9c926c36af919f6f5afb6f1d3b273853d8ceb9461197bb97649040bf2337658e'
const DEFAULT_THRESHOLDS = Object.freeze({
  expectedCases: 25,
  frozenBaselinePassed: 24,
  maxCaseDrop: 1,
  minScore: 92,
  minNodes: 20,
})

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) { out[key] = value; i += 1 } else out[key] = true
  }
  return out
}

function integerArg(value, fallback, name, { min = 0 } = {}) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min) throw new Error(`--${name} must be an integer >= ${min}`)
  return parsed
}

function readJson(pathOrUrl) {
  return JSON.parse(readFileSync(pathOrUrl, 'utf8'))
}

function normalizedSource(pathOrUrl) {
  return readFileSync(pathOrUrl, 'utf8').replace(/\r\n/g, '\n').replace(/\n$/, '')
}

function sourceSha256(sourceText) {
  return createHash('sha256').update(sourceText, 'utf8').digest('hex')
}

export function evaluateFrozenSourceApplicability(sourceText, options = {}) {
  const expectedChars = Number.isSafeInteger(options.expectedChars) ? options.expectedChars : 2844
  const expectedSha256 = typeof options.expectedSha256 === 'string' && options.expectedSha256 ? options.expectedSha256 : DEFAULT_SOURCE_SHA256
  const normalized = typeof sourceText === 'string' ? sourceText.replace(/\r\n/g, '\n').replace(/\n$/, '') : ''
  const actualChars = normalized.length
  const actualSha256 = normalized ? sourceSha256(normalized) : null
  const missing = !normalized
  const matches = !missing && actualChars === expectedChars && actualSha256 === expectedSha256
  return {
    ok: matches,
    applicable: matches,
    code: matches ? null : (missing ? 'frozen_source_missing' : 'frozen_source_mismatch'),
    expected: { chars: expectedChars, sha256: expectedSha256 },
    actual: { chars: actualChars, sha256: actualSha256 },
  }
}

function endpoint(baseUrl, suffix) {
  return String(baseUrl).replace(/\/$/, '') + '/api/dsh-knowledge-graph/' + suffix
}

async function readResponseJson(response) {
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : {} } catch (error) {
    throw new Error(`knowledge-graph endpoint returned non-JSON (${response.status}): ${text.slice(0, 300)}`)
  }
  if (!response.ok) throw new Error(`knowledge-graph endpoint returned HTTP ${response.status}: ${JSON.stringify(value)}`)
  return value
}

export async function extractFrozenGraph({ baseUrl, title, sourceText, model, pollMs = 3000, timeoutMs = 900000, onProgress = null }) {
  if (!baseUrl) throw new Error('baseUrl is required for live extraction')
  if (!model || !model.provider || !model.model) throw new Error('live extraction requires an explicit model provider and model')
  const submitted = await readResponseJson(await fetch(endpoint(baseUrl, 'extract'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, text: sourceText, model }),
  }))
  if (submitted.error) throw new Error(`extraction rejected: ${submitted.error.code || 'error'}: ${submitted.error.message || JSON.stringify(submitted.error)}`)
  if (!submitted.taskId) throw new Error('extraction endpoint did not return taskId')

  const startedAt = Date.now()
  let lastStage = ''
  while (true) {
    if (Date.now() - startedAt > timeoutMs) throw new Error(`extraction timed out after ${timeoutMs}ms (task ${submitted.taskId})`)
    const status = await readResponseJson(await fetch(endpoint(baseUrl, 'task-status') + '?taskId=' + encodeURIComponent(submitted.taskId)))
    if (status.status === 'succeeded') return status.result
    if (status.status === 'failed' || status.status === 'cancelled' || status.status === 'not_found') {
      const detail = status.error && status.error.message ? status.error.message : JSON.stringify(status)
      throw new Error(`extraction ${status.status}: ${detail}`)
    }
    const stage = status.progress && status.progress.stage ? status.progress.stage : status.status || 'running'
    if (stage !== lastStage && typeof onProgress === 'function') onProgress({ taskId: submitted.taskId, stage, progress: status.progress || null })
    lastStage = stage
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
}

export function evaluateQualityGate(graph, cases, options = {}) {
  const thresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options,
  }
  const benchmark = runGraphQaBenchmark(graph, cases)
  const nodeCount = Array.isArray(graph && graph.nodes) ? graph.nodes.length : 0
  const edgeCount = Array.isArray(graph && graph.edges) ? graph.edges.length : 0
  const minimumPassed = Math.max(0, thresholds.frozenBaselinePassed - thresholds.maxCaseDrop)
  const issues = []

  if (benchmark.total !== thresholds.expectedCases) {
    issues.push({
      code: 'frozen_case_count_changed',
      message: `expected ${thresholds.expectedCases} frozen QA cases, received ${benchmark.total}`,
    })
  }
  if (benchmark.score < thresholds.minScore) {
    issues.push({
      code: 'qa_score_below_minimum',
      message: `trusted QA score ${benchmark.score} is below ${thresholds.minScore}`,
    })
  }
  if (benchmark.passed < minimumPassed) {
    issues.push({
      code: 'qa_cases_below_frozen_baseline',
      message: `trusted QA passed ${benchmark.passed}/${benchmark.total}; gate requires at least ${minimumPassed} (frozen baseline ${thresholds.frozenBaselinePassed} minus ${thresholds.maxCaseDrop})`,
    })
  }
  if (nodeCount < thresholds.minNodes) {
    issues.push({
      code: 'catastrophic_node_collapse',
      message: `graph has ${nodeCount} nodes; collapse sentinel requires at least ${thresholds.minNodes}`,
    })
  }

  return {
    ok: issues.length === 0,
    nodeCount,
    edgeCount,
    thresholds: { ...thresholds, minimumPassed },
    benchmark,
    issues,
  }
}

function usage() {
  console.error(`Frozen knowledge-graph quality regression gate

Evaluate an existing graph:
  node scripts/kg-quality-regression.mjs --graph GRAPH.json

Run the real extractor through an existing DSH web server, then evaluate it:
  node scripts/kg-quality-regression.mjs --base-url http://127.0.0.1:3080 \\
    --provider codex-proxy --model gpt-5.6-sol [--output GRAPH.json]

CI may provide DSH_KG_QA_BASE_URL, DSH_KG_QA_PROVIDER, and DSH_KG_QA_MODEL
instead of command-line flags.

Defaults freeze the 2844-character world-recognition source, calibrated-v2 25-case QA,
24/25 observed baseline, at most one-case regression (minimum 23/25), score >= 92,
and nodes >= 20. Existing graphs with a missing or mismatched source are not scored.
`)
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help || args.h) { usage(); return 0 }

  const sourcePath = args.source || DEFAULT_SOURCE
  const casesPath = args.cases || DEFAULT_CASES
  const cases = readJson(casesPath)
  const thresholds = {
    expectedCases: integerArg(args['expected-cases'], DEFAULT_THRESHOLDS.expectedCases, 'expected-cases'),
    frozenBaselinePassed: integerArg(args['baseline-passed'], DEFAULT_THRESHOLDS.frozenBaselinePassed, 'baseline-passed'),
    maxCaseDrop: integerArg(args['max-case-drop'], DEFAULT_THRESHOLDS.maxCaseDrop, 'max-case-drop'),
    minScore: integerArg(args['min-score'], DEFAULT_THRESHOLDS.minScore, 'min-score'),
    minNodes: integerArg(args['min-nodes'], DEFAULT_THRESHOLDS.minNodes, 'min-nodes'),
  }

  const baseUrl = args['base-url'] || process.env.DSH_KG_QA_BASE_URL || ''
  const expectedSourceChars = integerArg(args['expected-source-chars'], 2844, 'expected-source-chars')
  const expectedSourceHash = args['expected-source-sha256'] || DEFAULT_SOURCE_SHA256
  let graph
  let mode
  let sourceChars = null
  let sourceHash = null
  let model = null
  let applicability = null
  if (args.graph) {
    graph = readJson(args.graph)
    mode = 'existing-graph'
    applicability = evaluateFrozenSourceApplicability(graph && graph.sourceText, {
      expectedChars: expectedSourceChars,
      expectedSha256: expectedSourceHash,
    })
    sourceChars = applicability.actual.chars
    sourceHash = applicability.actual.sha256
    if (!applicability.ok) {
      process.stdout.write(JSON.stringify({
        ok: false,
        applicable: false,
        code: applicability.code,
        mode,
        sourceChars,
        sourceSha256: sourceHash,
        source: applicability,
        message: 'graph source does not match the frozen QA source; no score was computed',
      }, null, 2) + '\n')
      return 2
    }
  } else if (baseUrl) {
    const sourceText = normalizedSource(sourcePath)
    applicability = evaluateFrozenSourceApplicability(sourceText, {
      expectedChars: expectedSourceChars,
      expectedSha256: expectedSourceHash,
    })
    if (!applicability.ok) throw new Error(`frozen source changed: expected ${JSON.stringify(applicability.expected)}, received ${JSON.stringify(applicability.actual)}`)
    sourceChars = applicability.actual.chars
    sourceHash = applicability.actual.sha256
    model = {
      provider: args.provider || process.env.DSH_KG_QA_PROVIDER || '',
      model: args.model || process.env.DSH_KG_QA_MODEL || '',
    }
    graph = await extractFrozenGraph({
      baseUrl,
      title: args.title || 'world-recognition-part1-quality-regression',
      sourceText,
      model,
      pollMs: integerArg(args['poll-ms'], 3000, 'poll-ms', { min: 250 }),
      timeoutMs: integerArg(args['timeout-ms'], 900000, 'timeout-ms', { min: 1000 }),
      onProgress: ({ taskId, stage }) => console.error(`[kg-quality-regression] ${taskId}: ${stage}`),
    })
    mode = 'live-extraction'
    if (args.output) writeFileSync(args.output, JSON.stringify(graph, null, 2) + '\n')
  } else {
    usage()
    throw new Error('provide either --graph or --base-url')
  }

  const result = evaluateQualityGate(graph, cases, thresholds)
  const report = {
    ok: result.ok,
    applicable: true,
    mode,
    sourceChars,
    sourceSha256: sourceHash,
    source: applicability,
    model,
    graph: { nodes: result.nodeCount, edges: result.edgeCount },
    qa: {
      passed: result.benchmark.passed,
      total: result.benchmark.total,
      score: result.benchmark.score,
      categories: result.benchmark.categories,
      failedCaseIds: result.benchmark.results.filter((item) => !item.pass).map((item) => item.id),
    },
    generation: graph && graph.generation ? {
      retryCount: Number(graph.generation.retryCount || 0),
      collapseRetryCount: Number(graph.generation.collapseRetryCount || 0),
      initial: graph.generation.initial || null,
      coverage: graph.generation.coverage || null,
      connectivity: graph.generation.connectivity || null,
    } : null,
    thresholds: result.thresholds,
    issues: result.issues,
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  return result.ok ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code }).catch((error) => {
    console.error('[kg-quality-regression] ' + (error && error.message ? error.message : String(error)))
    process.exitCode = 2
  })
}
