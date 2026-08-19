#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

function norm(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '')
}

function selectorMatches(node, selector) {
  if (!node || !selector || typeof selector !== 'object') return false
  if (selector.type && node.type !== selector.type) return false
  const text = norm(node.text)
  const all = Array.isArray(selector.all) ? selector.all : []
  const any = Array.isArray(selector.any) ? selector.any : []
  if (all.some((term) => !text.includes(norm(term)))) return false
  if (any.length > 0 && !any.some((term) => text.includes(norm(term)))) return false
  return all.length > 0 || any.length > 0 || Boolean(selector.type)
}

function matchingNodes(graph, selector) {
  return (Array.isArray(graph?.nodes) ? graph.nodes : []).filter((node) => selectorMatches(node, selector))
}

function edgeKey(edge) {
  return `${edge.fromNodeId}>${edge.toNodeId}:${edge.relation}`
}

function findPath(graph, fromSelector, toSelector, relations, maxHops = 6) {
  const starts = matchingNodes(graph, fromSelector)
  const targets = new Set(matchingNodes(graph, toSelector).map((node) => node.id))
  if (starts.length === 0 || targets.size === 0) return null
  const allowed = Array.isArray(relations) && relations.length > 0 ? new Set(relations) : null
  const byFrom = new Map()
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!edge || !edge.fromNodeId || !edge.toNodeId) continue
    if (allowed && !allowed.has(edge.relation)) continue
    const list = byFrom.get(edge.fromNodeId) || []
    list.push(edge)
    byFrom.set(edge.fromNodeId, list)
  }
  for (const start of starts) {
    const queue = [{ id: start.id, nodes: [start.id], edges: [] }]
    const seen = new Set([start.id])
    while (queue.length > 0) {
      const current = queue.shift()
      if (targets.has(current.id) && current.edges.length > 0) return current
      if (current.edges.length >= maxHops) continue
      for (const edge of byFrom.get(current.id) || []) {
        if (seen.has(edge.toNodeId)) continue
        seen.add(edge.toNodeId)
        queue.push({ id: edge.toNodeId, nodes: [...current.nodes, edge.toNodeId], edges: [...current.edges, edge] })
      }
    }
  }
  return null
}

function renderPath(graph, path) {
  if (!path) return ''
  const byId = new Map((graph.nodes || []).map((node) => [node.id, node]))
  const parts = []
  for (let i = 0; i < path.nodes.length; i++) {
    const node = byId.get(path.nodes[i])
    parts.push(node?.text || path.nodes[i])
    if (i < path.edges.length) parts.push(`--${path.edges[i].relation}-->`)
  }
  return parts.join(' ')
}

function evaluateCase(graph, testCase) {
  const kind = testCase.kind
  if (kind === 'node') {
    const nodes = matchingNodes(graph, testCase.selector)
    return { pass: nodes.length > 0, verdict: nodes.length > 0 ? 'supported' : 'insufficient', evidence: nodes.slice(0, 3).map((n) => n.id), answer: nodes[0]?.text || '' }
  }
  if (kind === 'path') {
    const path = findPath(graph, testCase.from, testCase.to, testCase.relations, testCase.maxHops || 6)
    return { pass: Boolean(path), verdict: path ? 'supported' : 'insufficient', evidence: path ? path.nodes : [], edgeEvidence: path ? path.edges.map(edgeKey) : [], answer: renderPath(graph, path) }
  }
  if (kind === 'relation') {
    const from = new Set(matchingNodes(graph, testCase.from).map((n) => n.id))
    const to = new Set(matchingNodes(graph, testCase.to).map((n) => n.id))
    const edges = (graph.edges || []).filter((edge) => from.has(edge.fromNodeId) && to.has(edge.toNodeId) && (!testCase.relations || testCase.relations.includes(edge.relation)))
    return { pass: edges.length > 0, verdict: edges.length > 0 ? 'supported' : 'insufficient', evidence: [...from, ...to], edgeEvidence: edges.map(edgeKey), answer: edges.length > 0 ? edges.map(edgeKey).join(', ') : '' }
  }
  if (kind === 'unknown') {
    const guard = testCase.guard ? matchingNodes(graph, testCase.guard) : []
    const positive = testCase.positive ? matchingNodes(graph, testCase.positive) : []
    const pass = guard.length > 0 && positive.length === 0
    return { pass, verdict: pass ? 'insufficient' : (positive.length > 0 ? 'supported' : 'insufficient'), evidence: guard.map((n) => n.id), answer: pass ? (guard[0]?.text || '当前图未给出答案') : '' }
  }
  if (kind === 'forbidden-node') {
    const nodes = matchingNodes(graph, testCase.selector)
    return { pass: nodes.length === 0, verdict: nodes.length === 0 ? 'insufficient' : 'contradicted', evidence: nodes.map((n) => n.id), answer: nodes.length === 0 ? '未发现被禁止的推论' : nodes[0].text }
  }
  if (kind === 'forbidden-relation') {
    const from = new Set(matchingNodes(graph, testCase.from).map((n) => n.id))
    const to = new Set(matchingNodes(graph, testCase.to).map((n) => n.id))
    const edges = (graph.edges || []).filter((edge) => from.has(edge.fromNodeId) && to.has(edge.toNodeId) && (!testCase.relations || testCase.relations.includes(edge.relation)))
    return { pass: edges.length === 0, verdict: edges.length === 0 ? 'insufficient' : 'contradicted', edgeEvidence: edges.map(edgeKey), answer: edges.length === 0 ? '未发现被禁止的关系' : edges.map(edgeKey).join(', ') }
  }
  throw new Error(`unknown case kind: ${kind}`)
}

export function runGraphQaBenchmark(graph, cases) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) throw new Error('graph must contain nodes[] and edges[]')
  if (!Array.isArray(cases) || cases.length === 0) throw new Error('cases must be a non-empty array')
  const results = cases.map((testCase) => ({ id: testCase.id, question: testCase.question, category: testCase.category || 'answerability', ...evaluateCase(graph, testCase) }))
  const categories = {}
  for (const result of results) {
    const entry = categories[result.category] || { passed: 0, total: 0 }
    entry.total += 1
    if (result.pass) entry.passed += 1
    categories[result.category] = entry
  }
  const passed = results.filter((r) => r.pass).length
  return {
    ok: passed === results.length,
    passed,
    total: results.length,
    score: Math.round((passed / results.length) * 100),
    categories,
    results,
  }
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) { out[key] = value; i += 1 } else out[key] = true
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  if (!args.graph || !args.cases) {
    console.error('Usage: node scripts/kg-qa-benchmark.mjs --graph GRAPH.json --cases CASES.json')
    process.exit(2)
  }
  const graph = JSON.parse(readFileSync(args.graph, 'utf8'))
  const cases = JSON.parse(readFileSync(args.cases, 'utf8'))
  const result = runGraphQaBenchmark(graph, cases)
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
  if (!result.ok) process.exitCode = 1
}
