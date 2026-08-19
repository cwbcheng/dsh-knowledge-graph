import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': source pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': source pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

const hostPath = new URL('../src/index.host.js', import.meta.url)
let host = readFileSync(hostPath, 'utf8')

host = replaceOnce(host,
`      function evidenceRecordHost(paragraph, quote, sourceContext, item) {
        const out = { paragraph, quote }
        const context = sourceContext && typeof sourceContext === 'object' ? sourceContext : {}
        const raw = item && typeof item === 'object' ? item : {}
        const documentId = typeof raw.documentId === 'string' && raw.documentId ? raw.documentId : context.documentId
        const sourceId = typeof raw.sourceId === 'string' && raw.sourceId ? raw.sourceId : context.sourceId
        const chunkId = typeof raw.chunkId === 'string' && raw.chunkId ? raw.chunkId : context.chunkId
        if (documentId) out.documentId = documentId
        if (sourceId) out.sourceId = sourceId
        if (chunkId) out.chunkId = chunkId
        return out
      }`,
`      function evidenceRecordHost(paragraph, quote, sourceContext, item) {
        const out = { paragraph, quote }
        const context = sourceContext && typeof sourceContext === 'object' ? sourceContext : {}
        const raw = item && typeof item === 'object' ? item : {}
        // Canonical paragraph provenance is the authority. Caller-provided
        // provenance is accepted only when no canonical context exists (for
        // example while merging already-authenticated legacy records).
        const documentId = typeof context.documentId === 'string' && context.documentId
          ? context.documentId
          : (typeof raw.documentId === 'string' && raw.documentId ? raw.documentId : null)
        const sourceId = typeof context.sourceId === 'string' && context.sourceId
          ? context.sourceId
          : (typeof raw.sourceId === 'string' && raw.sourceId ? raw.sourceId : null)
        const chunkId = typeof context.chunkId === 'string' && context.chunkId
          ? context.chunkId
          : (typeof raw.chunkId === 'string' && raw.chunkId ? raw.chunkId : null)
        if (documentId) out.documentId = documentId
        if (sourceId) out.sourceId = sourceId
        if (chunkId) out.chunkId = chunkId
        return out
      }`,
'evidence provenance authority')

host = replaceOnce(host,
`      function preserveEntailmentAuthorityHost(currentGraph, incomingGraph) {
        if (!incomingGraph || typeof incomingGraph !== 'object') return incomingGraph
        const current = new Map((Array.isArray(currentGraph && currentGraph.nodes) ? currentGraph.nodes : [])
          .filter((node) => node && typeof node.id === 'string' && node.id)
          .map((node) => [node.id, ENTAILMENT_STATUSES.has(node.entailmentStatus) ? node.entailmentStatus : 'unverified']))
        for (const node of Array.isArray(incomingGraph.nodes) ? incomingGraph.nodes : []) {
          if (!node || typeof node !== 'object') continue
          node.entailmentStatus = current.has(node.id) ? current.get(node.id) : 'unverified'
        }
        return incomingGraph
      }`,
`      function preserveEntailmentAuthorityHost(currentGraph, incomingGraph) {
        if (!incomingGraph || typeof incomingGraph !== 'object') return incomingGraph
        const claimFingerprint = (node) => {
          if (!node || typeof node !== 'object') return ''
          const type = TYPE_ALIASES[typeof node.type === 'string' ? node.type.trim().toLowerCase() : ''] || String(node.type || '')
          return type + '|' + normalizeGraphLookupTextHost(node.text)
        }
        const current = new Map((Array.isArray(currentGraph && currentGraph.nodes) ? currentGraph.nodes : [])
          .filter((node) => node && typeof node.id === 'string' && node.id)
          .map((node) => [node.id, {
            fingerprint: claimFingerprint(node),
            status: ENTAILMENT_STATUSES.has(node.entailmentStatus) ? node.entailmentStatus : 'unverified',
          }]))
        for (const node of Array.isArray(incomingGraph.nodes) ? incomingGraph.nodes : []) {
          if (!node || typeof node !== 'object') continue
          const previous = current.get(node.id)
          const sameClaim = Boolean(previous && previous.fingerprint && previous.fingerprint === claimFingerprint(node))
          // Verification authority is bound to claim semantics, not merely to
          // a stable node id. Any type/text rewrite invalidates prior entailment.
          node.entailmentStatus = sameClaim ? previous.status : 'unverified'
        }
        return incomingGraph
      }`,
'entailment fingerprint fence')

// Existing-node provenance is not editable browser state. Re-derive it from
// canonical paragraph/chunk metadata whenever evidence is authenticated.
const authNeedle = `        for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (!node || typeof node !== 'object') continue
          const authenticated = []`
const authReplacement = `        for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
          if (!node || typeof node !== 'object') continue
          const canonicalProvenance = provenanceForParagraphHost(graph, node.paragraph)
          if (canonicalProvenance.documentId) node.documentId = canonicalProvenance.documentId
          if (canonicalProvenance.sourceId) node.sourceId = canonicalProvenance.sourceId
          if (canonicalProvenance.chunkId) node.chunkId = canonicalProvenance.chunkId
          const authenticated = []`
host = replaceOnce(host, authNeedle, authReplacement, 'canonical node provenance')

const seedStart = host.indexOf('      function seedExplicitRelationEdgesHost(acc, paragraphTexts) {')
const seedEnd = host.indexOf('      function isRelationRateLimitErrorHost(error) {', seedStart)
if (seedStart < 0 || seedEnd <= seedStart) throw new Error('relation seed function bounds not found')
const safeSeed = `      function seedExplicitRelationEdgesHost(acc, paragraphTexts) {
        const nodes = Array.from(acc.nodes.values())
        const existingPairs = new Set()
        for (const edge of acc.edges) existingPairs.add([edge.fromNodeId, edge.toNodeId].sort().join('|'))
        let added = 0
        const paragraphOf = (node) => Number.isInteger(node && node.paragraph) ? node.paragraph : null
        const offsetOf = (node) => {
          const paragraph = paragraphOf(node)
          if (paragraph == null) return -1
          const text = String(paragraphTexts[paragraph] || '')
          const quote = typeof node.quote === 'string' ? node.quote.trim() : ''
          if (quote) {
            const index = text.indexOf(quote)
            if (index >= 0) return index
          }
          const label = typeof node.text === 'string' ? node.text.trim() : ''
          return label ? text.indexOf(label) : -1
        }
        const provenanceFromNode = (node, paragraph) => {
          const item = (Array.isArray(node && node.evidence) ? node.evidence : [])
            .find((evidence) => evidence && evidence.paragraph === paragraph && evidence.sourceId && evidence.chunkId)
          return {
            documentId: item && item.documentId ? item.documentId : (node && node.documentId ? node.documentId : null),
            sourceId: item && item.sourceId ? item.sourceId : (node && node.sourceId ? node.sourceId : null),
            chunkId: item && item.chunkId ? item.chunkId : (node && node.chunkId ? node.chunkId : null),
          }
        }
        const directRelationEvidence = (paragraph, from, to, start, end) => {
          const source = String(paragraphTexts[paragraph] || '')
          if (!source) return []
          const full = source.trim()
          const span = source.slice(Math.max(0, start), Math.min(source.length, end)).trim()
          const quote = full.length <= 600 ? full : (span && span.length <= 600 ? span : '')
          if (!quote) return []
          const context = provenanceFromNode(from, paragraph)
          if (!context.sourceId || !context.chunkId) Object.assign(context, provenanceFromNode(to, paragraph))
          return [evidenceRecordHost(paragraph, quote, context, null)]
        }
        const add = (from, to, relation, evidence) => {
          if (!from || !to || from.id === to.id || added >= 16) return false
          const pairKey = [from.id, to.id].sort().join('|')
          const edgeKey = from.id + '>' + to.id + ':' + relation
          if (existingPairs.has(pairKey) || acc.edgeKeys.has(edgeKey)) return false
          const authenticatedEvidence = mergeEvidenceRecordsHost([], evidence, 8)
          if (authenticatedEvidence.length === 0) return false
          acc.edges.push({ fromNodeId: from.id, toNodeId: to.id, relation, evidence: authenticatedEvidence })
          acc.edgeKeys.add(edgeKey)
          existingPairs.add(pairKey)
          added += 1
          return true
        }
        const inferenceMarkers = /(?:导致|以至于|因此|所以|从而|意味着|一旦|如果|只要|才会|就会)/
        // Deterministic seeds are allowed only when one source unit itself
        // contains both propositions plus an explicit relation cue. Endpoint
        // evidence alone is never promoted into relation evidence. All other
        // connectivity hints remain candidates for the relation weaver.
        for (let i = 0; i < nodes.length; i++) {
          for (let j = i + 1; j < nodes.length; j++) {
            const a = nodes[i]
            const b = nodes[j]
            const paragraph = paragraphOf(a)
            if (paragraph == null || paragraph !== paragraphOf(b)) continue
            const paragraphText = String(paragraphTexts[paragraph] || '')
            const ao = offsetOf(a)
            const bo = offsetOf(b)
            if (ao < 0 || bo < 0) continue
            const first = ao <= bo ? a : b
            const second = first === a ? b : a
            if (!((first.type === 'fact' || first.type === 'rule') && second.type === 'inference')) continue
            const start = Math.min(ao, bo)
            const end = Math.max(ao, bo) + Math.max(String(second.quote || second.text || '').length, 24)
            const relationSpan = paragraphText.slice(start, end)
            if (!inferenceMarkers.test(relationSpan)) continue
            const evidence = directRelationEvidence(paragraph, first, second, start, end)
            const relation = first.type === 'fact' ? 'infers' : 'supports'
            add(first, second, relation, evidence)
          }
        }
        return added
      }
`
host = host.slice(0, seedStart) + safeSeed + host.slice(seedEnd)
writeFileSync(hostPath, host)

const connectivityPath = new URL('./kg-connectivity-smoke.mjs', import.meta.url)
let connectivity = readFileSync(connectivityPath, 'utf8')
const connectivityStart = connectivity.indexOf('// Explicit same-paragraph inference and concept mentions are admitted through')
const connectivityEnd = connectivity.indexOf('// A sparse graph whose automatic weave found nothing can be retried later', connectivityStart)
if (connectivityStart < 0 || connectivityEnd <= connectivityStart) throw new Error('connectivity seed test bounds not found')
const connectivityReplacement = `// Deterministic seeds may enter canonical state only when the source span itself
// contains both propositions and an explicit relation cue. A nearby concept
// mention is only a recall hint and must not be promoted from endpoint evidence.
const seedText = ['缺少目标，因此方法会走形', '本书帮助重建学习系统'].join('\\n\\n')
const seedStarted = await handlers.get('extract')({ title: 'explicit-relation-seed', text: seedText })
const seedCompleted = await waitTask(seedStarted.taskId)
assert(seedCompleted.status === 'succeeded' && seedCompleted.result, 'explicit relation seed extraction failed: ' + JSON.stringify(seedCompleted))
const seedConnectivity = seedCompleted.result.generation && seedCompleted.result.generation.connectivity
assert(seedCompleted.result.edges.length === 1, 'deterministic relation seeding admitted a relation without relation-spanning evidence: ' + JSON.stringify(seedCompleted.result.edges))
assert(seedConnectivity && seedConnectivity.seededEdges === 1 && seedConnectivity.addedEdges === 1, 'explicit seed metadata is wrong: ' + JSON.stringify(seedConnectivity))
const explicitSeedEdge = seedCompleted.result.edges.find((edge) => edge.fromNodeId === 's1' && edge.toNodeId === 's2' && edge.relation === 'infers')
assert(explicitSeedEdge, 'same-paragraph inference seed is missing')
assert(explicitSeedEdge.evidence.length === 1 && explicitSeedEdge.evidence[0].quote.includes('因此'), 'deterministic seed did not preserve the relation-bearing source span')
assert(!seedCompleted.result.edges.some((edge) => edge.fromNodeId === 's4' && edge.toNodeId === 's3'), 'endpoint evidence was promoted into a fact-to-concept relation')

`
connectivity = connectivity.slice(0, connectivityStart) + connectivityReplacement + connectivity.slice(connectivityEnd)
writeFileSync(connectivityPath, connectivity)

const trustTest = `import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { openSqliteStore } from '../src/kg-store.mjs'
import hostPlugin from '../src/index.host.js'
import * as persistentHost from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function post(handler, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = 'POST'
    req.url = '/api/dsh-knowledge-graph/' + endpoint
    req.headers = {}
    const res = {
      status: 0, body: '', setHeader() {},
      writeHead(status) { this.status = status },
      end(value) { this.body = value || ''; resolve(JSON.parse(this.body || '{}')) },
    }
    handler(req, res).catch(reject)
    process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body || {}))); req.emit('end') })
  })
}

async function waitTask(handlers, taskId) {
  for (let i = 0; i < 160; i++) {
    const status = await handlers.get('task-status')({ taskId })
    if (status.status !== 'running') return status
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('task did not finish: ' + taskId)
}

const dir = mkdtempSync('/tmp/dsh-kg-trust-boundary-')
const dbPath = join(dir, 'trust.sqlite')
process.env.DSH_KG_DB = dbPath
const documentId = 'document-trust-boundary'
const sourceId = 'source-canonical'
const chunkId = 'chunk-canonical'
const sourceText = '可信声明'
const seedGraph = {
  summary: 'trust boundary',
  source: {
    id: sourceId,
    documentId,
    title: 'trust-boundary',
    chars: sourceText.length,
    paragraphCount: 1,
    chunkCount: 1,
    sectionCount: 1,
    sections: [{ id: 'section-1', title: '全文', startParagraph: 0, endParagraph: 0, summary: '' }],
  },
  staging: {
    sourceId,
    documentId,
    chunkCount: 1,
    chunks: [{ chunkId, sourceId, startParagraph: 0, endParagraph: 0, sectionIds: ['section-1'], sectionTitles: ['全文'], summary: '', nodeIds: ['n1'], edgeCount: 0, warnings: [] }],
  },
  nodes: [{
    id: 'n1', type: 'fact', text: '可信声明', quote: '可信声明', paragraph: 0,
    evidence: [{ documentId, sourceId, chunkId, paragraph: 0, quote: '可信声明' }],
    groundingStatus: 'grounded', entailmentStatus: 'verified', documentId, sourceId, chunkId,
  }],
  edges: [],
}

let store = await openSqliteStore(dbPath)
store.saveGraph(seedGraph, { sourceText })
store.close()

const routes = []
const webServer = { register(spec) { routes.push(spec); return () => {} } }
persistentHost.apply({
  get(name) { return name === 'webServer' ? webServer : null },
  effect(fn) { return fn() },
  interval() { return () => {} },
})
const api = routes.find((route) => route.path === '/api/dsh-knowledge-graph').handler

try {
  const forged = await post(api, 'graph-commit', {
    documentId,
    expectedRevision: 1,
    graph: {
      summary: 'forged provenance attempt',
      nodes: [{
        id: 'n1', type: 'fact', text: '可信声明', quote: '可信声明', paragraph: 0,
        evidence: [{ documentId: 'document-forged', sourceId: 'source-forged', chunkId: 'chunk-forged', paragraph: 0, quote: '可信声明' }],
        groundingStatus: 'grounded', entailmentStatus: 'unverified',
        documentId: 'document-forged', sourceId: 'source-forged', chunkId: 'chunk-forged',
      }],
      edges: [],
    },
    baseNodeIds: ['n1'],
    baseEdgeKeys: [],
  })
  assert(forged && !forged.error && forged.revision === 2, 'same-claim provenance commit failed: ' + JSON.stringify(forged))

  store = await openSqliteStore(dbPath)
  let canonical = store.getDocument(documentId)
  store.close()
  const canonicalNode = canonical.nodes.find((node) => node.id === 'n1')
  assert(canonicalNode && canonicalNode.evidence.length === 1, 'canonical evidence disappeared after authentication')
  assert(canonicalNode.evidence[0].documentId === documentId && canonicalNode.evidence[0].sourceId === sourceId && canonicalNode.evidence[0].chunkId === chunkId, 'caller forged evidence provenance survived canonical authentication: ' + JSON.stringify(canonicalNode.evidence[0]))
  assert(canonicalNode.documentId === documentId && canonicalNode.sourceId === sourceId && canonicalNode.chunkId === chunkId, 'caller forged node provenance survived canonical authentication')
  assert(canonicalNode.entailmentStatus === 'verified', 'unchanged claim lost its trusted entailment status')

  const rewritten = await post(api, 'graph-commit', {
    documentId,
    expectedRevision: 2,
    graph: {
      summary: 'claim rewrite',
      nodes: [{
        ...canonicalNode,
        text: '修改后的声明',
        entailmentStatus: 'verified',
      }],
      edges: [],
    },
    baseNodeIds: ['n1'],
    baseEdgeKeys: [],
  })
  assert(rewritten && !rewritten.error && rewritten.revision === 3, 'claim rewrite commit failed: ' + JSON.stringify(rewritten))
  store = await openSqliteStore(dbPath)
  canonical = store.getDocument(documentId)
  store.close()
  assert(canonical.nodes[0].text === '修改后的声明', 'claim rewrite was not persisted')
  assert(canonical.nodes[0].entailmentStatus === 'unverified', 'verified entailment survived a semantic claim rewrite')

  const handlers = new Map()
  const extractor = {
    async extractChunk({ title }) {
      if (title === 'unsafe-endpoint-seed') {
        return {
          summary: 'unsafe endpoint seed',
          nodes: [
            { id: 'u1', type: 'fact', text: '本书帮助重建学习系统', quote: '本书帮助重建学习系统', paragraph: 0 },
            { id: 'u2', type: 'concept', text: '学习系统', quote: '学习系统', paragraph: 1 },
            { id: 'u3', type: 'fact', text: '另一事实', quote: '另一事实', paragraph: 2 },
          ],
          edges: [],
        }
      }
      return {
        summary: 'safe explicit relation',
        nodes: [
          { id: 'r1', type: 'fact', text: '缺少目标', quote: '缺少目标', paragraph: 0 },
          { id: 'r2', type: 'inference', text: '方法会走形', quote: '方法会走形', paragraph: 0 },
          { id: 'r3', type: 'fact', text: '另一事实', quote: '另一事实', paragraph: 1 },
        ],
        edges: [],
      }
    },
    async weaveRelations() { return { edges: [] } },
  }
  globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
  hostPlugin().apply({
    get(name) { return name === 'kgExtractor' ? extractor : null },
    interval() { return () => {} },
  })

  const unsafeStart = await handlers.get('extract')({ title: 'unsafe-endpoint-seed', text: ['本书帮助重建学习系统', '学习系统', '另一事实'].join('\\n\\n') })
  const unsafe = await waitTask(handlers, unsafeStart.taskId)
  assert(unsafe.status === 'succeeded', 'unsafe seed fixture failed unexpectedly: ' + JSON.stringify(unsafe))
  assert(unsafe.result.edges.length === 0, 'endpoint evidence was promoted into a canonical relation: ' + JSON.stringify(unsafe.result.edges))

  const safeStart = await handlers.get('extract')({ title: 'safe-relation-seed', text: ['缺少目标，因此方法会走形', '另一事实'].join('\\n\\n') })
  const safe = await waitTask(handlers, safeStart.taskId)
  assert(safe.status === 'succeeded', 'safe seed fixture failed unexpectedly: ' + JSON.stringify(safe))
  assert(safe.result.edges.length === 1 && safe.result.edges[0].fromNodeId === 'r1' && safe.result.edges[0].toNodeId === 'r2' && safe.result.edges[0].relation === 'infers', 'explicit same-source relation was not seeded')
  assert(safe.result.edges[0].evidence.length === 1 && safe.result.edges[0].evidence[0].quote.includes('因此'), 'safe seed evidence does not contain the relation-bearing source span')

  console.log(JSON.stringify({
    ok: true,
    canonicalProvenance: true,
    entailmentFingerprintFence: true,
    endpointEvidenceNotRelationEvidence: true,
    safeRelationSeed: safe.result.edges[0].relation,
  }))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
`
writeFileSync(new URL('./kg-trust-boundary-smoke.mjs', import.meta.url), trustTest)

const packagePath = new URL('../package.json', import.meta.url)
const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
pkg.scripts['test:kg-trust-boundary'] = 'node scripts/kg-trust-boundary-smoke.mjs'
if (!pkg.scripts.test.includes('test:kg-trust-boundary')) {
  pkg.scripts.test = pkg.scripts.test.replace(' && npm run test:kg-policy', ' && npm run test:kg-trust-boundary && npm run test:kg-policy')
}
writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + '\n')

console.log(JSON.stringify({ ok: true, patched: ['src/index.host.js', 'scripts/kg-connectivity-smoke.mjs', 'scripts/kg-trust-boundary-smoke.mjs', 'package.json'] }))
