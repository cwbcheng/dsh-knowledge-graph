import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/index.host.js'
let source = readFileSync(path, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(label + ' marker count=' + count)
  source = source.replace(before, after)
}

replaceOnce(
  'counter-example invariant',
  "              add('counter_example_without_target', false, 'warning', 'type', 'node', node.id,\n",
  "              add('counter_example_without_target', true, 'error', 'type', 'node', node.id,\n",
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
