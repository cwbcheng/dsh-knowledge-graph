import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/index.host.js'
let source = readFileSync(path, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(label + ' marker count=' + count)
  source = source.replace(before, after)
}

// `counter_example_without_target` used to live only in the quality-warning
// layer, so changing that warning's severity did not affect generation. Insert
// one true invariant near the start of validateGraphInvariantsHost, before any
// includeQuality-only checks, and suppress the later duplicate warning.
const validateStart = source.indexOf('function validateGraphInvariantsHost')
if (validateStart < 0) throw new Error('validateGraphInvariantsHost not found')
const validateTail = source.slice(validateStart)
const edgeDecl = /(\n\s*const edges = graph && Array\.isArray\(graph\.edges\) \? graph\.edges : \[\]\n)/.exec(validateTail)
if (!edgeDecl) throw new Error('validator edge declaration not found')
const insertAt = validateStart + edgeDecl.index + edgeDecl[0].length
const counterInvariant = `        // A counter-example is a logical role, not merely a negative-looking\n        // example. Without an explicit challenged proposition it is invalid\n        // canonical knowledge and must be repaired before publication.\n        for (const node of nodes) {\n          if (!node || !node.id || node.type !== 'counter_example') continue\n          const hasCounterTarget = edges.some((edge) => edge && edge.fromNodeId === node.id && edge.relation === 'counter_example')\n          if (!hasCounterTarget) {\n            add('counter_example_without_target', true, 'error', 'type', 'node', node.id,\n              '反例节点没有明确的被挑战命题',\n              'counter_example 的逻辑角色是削弱/限制一个一般命题；如果该节点只是负向结果或对照情形，应改用 example，并用 supports/analogy 表达其说明作用。',\n              [], { action: 'none' })\n          }\n        }\n\n`
source = source.slice(0, insertAt) + counterInvariant + source.slice(insertAt)

replaceOnce(
  'counter-example quality duplicate guard',
  "            if (!hasCounterTarget) {\n              add('counter_example_without_target', false, 'warning', 'type', 'node', node.id,\n",
  "            if (!hasCounterTarget && !issues.some((issue) => issue.code === 'counter_example_without_target' && issue.targetId === node.id)) {\n              add('counter_example_without_target', false, 'warning', 'type', 'node', node.id,\n",
)

replaceOnce(
  'anti-inference semantic coverage',
  "            const covered = paragraphNodes.some((node) => boundaryCue.test(String(node.quote || '') + ' ' + String(node.text || '')))\n",
  "            const covered = paragraphNodes.some((node) => boundaryCue.test(String(node.text || '')))\n",
)

replaceOnce(
  'forward-reference semantic coverage',
  "            const covered = paragraphNodes.some((node) => forwardCue.test(String(node.quote || '') + ' ' + String(node.text || '')))\n",
  "            const covered = paragraphNodes.some((node) => forwardCue.test(String(node.text || '')))\n",
)

replaceOnce(
  'analogy relation recall contract',
  "        '7. 原文明示“属于/是一种/包含/由…驱动/不是/类比/旨在/导致/因此/例子/定义”等关系时，应选择对应的最精确 relation。',\n",
  "        '7. 原文明示“属于/是一种/包含/由…驱动/不是/类比/旨在/导致/因此/例子/定义”等关系时，应选择对应的最精确 relation。若原文使用“拿…来说/好比/类似于/类比”等显式跨域说明语气，且具体案例用于解释一个抽象原则，优先使用 analogy（案例→原则），不要因为它是具体案例就退化成 example 或 supports。',\n",
)

writeFileSync(path, source)
console.log(JSON.stringify({ ok: true, changed: [path] }))
