import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

const handlers = new Map()
globalThis.harness = { handle(name, handler) { handlers.set(name, handler) } }
hostPlugin().apply({ get() { return null }, interval() { return () => {} } })

const graph = {
  nodes: [
    { id: 'rule-1', type: 'rule', text: '规则节点' },
    { id: 'fact-1', type: 'fact', text: '事实节点' },
  ],
  edges: [{ fromNodeId: 'rule-1', toNodeId: 'fact-1', relation: 'example' }],
}
const checked = await handlers.get('verify-graph')({ text: '规则节点是一个例子。', graph, mode: 'quick' })
const issue = checked && checked.report && checked.report.issues && checked.report.issues.find((item) => item.title === '关系与源节点类型不匹配')
assert(issue, 'relation source-type mismatch was not reported')
assert(issue.targetKind === 'edge' && issue.targetId === 'rule-1>fact-1', 'mismatch target is incorrect')
assert(issue.proposedFix && issue.proposedFix.action === 'none', 'unsafe relation mismatch must not be auto-applied')

const clientSource = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
assert(clientSource.includes("'复核并提交'"), 'recheck button is not labeled as an immediate submission')
assert(clientSource.includes('submitQuestion(draft, target)'), 'recheck handler does not submit the targeted question')
assert(clientSource.includes('relationTypeFix'), 'relation mismatch repair option is missing')
console.log(JSON.stringify({ ok: true, issue: issue.id, target: issue.targetId, client: 'recheck-submit-and-repair-option' }))
