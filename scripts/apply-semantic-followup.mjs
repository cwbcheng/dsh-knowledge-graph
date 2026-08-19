import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(label + ': pattern not found')
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(label + ': pattern is not unique')
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function replaceIfPresent(source, before, after) {
  const first = source.indexOf(before)
  return first < 0 ? source : source.slice(0, first) + after + source.slice(first + before.length)
}

const hostPath = new URL('../src/index.host.js', import.meta.url)
let host = readFileSync(hostPath, 'utf8')
host = replaceOnce(host,
`      const FACT_KINDS = new Set(['fact', 'inference', 'rule', 'definition', 'counter_example'])
      const FACT_CHECKWORTHY = { fact: 0.9, counter_example: 0.9, rule: 0.85, definition: 0.75, inference: 0.6 }`,
`      const FACT_KINDS = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])
      const FACT_CHECKWORTHY = { fact: 0.9, counter_example: 0.9, rule: 0.85, definition: 0.75, claim: 0.7, inference: 0.6 }`,
'external fact-check claim integration')
writeFileSync(hostPath, host)

const testPath = new URL('./kg-semantic-contract-smoke.mjs', import.meta.url)
let test = readFileSync(testPath, 'utf8')
test = replaceOnce(test,
`import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'`,
`import { readFileSync } from 'node:fs'
import hostPlugin from '../src/index.host.js'
import { openSqliteStore } from '../src/kg-store.mjs'`,
'semantic test fs import')
test = replaceOnce(test,
`assert(contractPrompt.includes('这是安全上限，不是压缩目标'), 'node cap still incentivizes proposition compression')`,
`assert(contractPrompt.includes('这是安全上限，不是压缩目标'), 'node cap still incentivizes proposition compression')
const hostSource = readFileSync(new URL('../src/index.host.js', import.meta.url), 'utf8')
assert(hostSource.includes("const FACT_KINDS = new Set(['fact', 'claim', 'inference', 'rule', 'definition', 'counter_example'])"), 'claim nodes are excluded from external fact checking')`,
'fact-check regression assertion')
writeFileSync(testPath, test)

const readmePath = new URL('../README.md', import.meta.url)
let zh = readFileSync(readmePath, 'utf8')
zh = replaceOnce(zh,
`- **7 类节点 / 6 类关系**：
  - 节点：\`fact\` 事实 · \`inference\` 推论 · \`concept\` 概念 · \`definition\` 定义 · \`example\` 例子 · \`counter_example\` 反例 · \`rule\` 规则。
  - 关系：\`supports\` 支持 · \`example\` 例子 · \`counter_example\` 反例 · \`defines\` 定义 · \`infers\` 推断 · \`causes\` 因果。`,
`- **8 类节点 / 12 类关系**：
  - 节点：\`fact\` 事实 · \`claim\` 主张 · \`inference\` 推论 · \`concept\` 概念 · \`definition\` 定义 · \`example\` 例子 · \`counter_example\` 反例 · \`rule\` 规则。
  - 关系：\`supports\` 支持 · \`example\` 例子 · \`counter_example\` 反例 · \`defines\` 定义 · \`infers\` 推断 · \`causes\` 因果 · \`is_a\` 属于 · \`contains\` 包含 · \`driven_by\` 受驱动于 · \`not_is\` 不是 · \`analogy\` 类比说明 · \`aims_at\` 旨在。
  - **最小语义契约**：一个节点只表达一个原子命题；作者的理论/经验概括用 \`claim\` 而不是 \`fact\`；保留“可能 / 多数 / 通常 / 必须 / 如果”等原文限定；存在更精确关系时不退化成 \`supports\`。`,
'Chinese type/relation docs')
zh = replaceOnce(zh, 'SVG 画布 + 7 类配色', 'SVG 画布 + 8 类配色', 'Chinese palette docs')
zh = replaceOnce(zh,
'把知识图中的 fact/inference/rule/definition/counter_example 节点转为**可核查断言**',
'把知识图中的 fact/claim/inference/rule/definition/counter_example 节点转为**可核查断言**',
'Chinese fact-check docs')
zh = replaceOnce(zh,
'把任意资料用 AI 拆成「事实/推论/概念/定义/例子/反例/规则」知识图',
'把任意资料用 AI 拆成「事实/主张/推论/概念/定义/例子/反例/规则」知识图',
'Chinese mock docs')
zh = replaceIfPresent(zh,
'- 7 类节点 wire 类型见上文；6 类关系边见上文。',
'- 8 类节点 wire 类型与 12 类关系边见上文。')
writeFileSync(readmePath, zh)

const readmeEnPath = new URL('../README.en.md', import.meta.url)
let en = readFileSync(readmeEnPath, 'utf8')
en = replaceOnce(en,
`- **7 node types / 6 relation types**:
  - Nodes: \`fact\` · \`inference\` · \`concept\` · \`definition\` · \`example\` · \`counter_example\` · \`rule\`.
  - Relations: \`supports\` · \`example\` · \`counter_example\` · \`defines\` · \`infers\` · \`causes\`.`,
`- **8 node types / 12 relation types**:
  - Nodes: \`fact\` · \`claim\` · \`inference\` · \`concept\` · \`definition\` · \`example\` · \`counter_example\` · \`rule\`.
  - Relations: \`supports\` · \`example\` · \`counter_example\` · \`defines\` · \`infers\` · \`causes\` · \`is_a\` · \`contains\` · \`driven_by\` · \`not_is\` · \`analogy\` · \`aims_at\`.
  - **Minimal semantic contract**: one node expresses one atomic proposition; source/author theories and empirical generalizations use \`claim\` rather than \`fact\`; qualifiers such as “possible / most / usually / must / if” must be preserved; use a precise semantic relation instead of falling back to \`supports\` when the source makes that relation explicit.`,
'English type/relation docs')
en = replaceOnce(en, 'SVG canvas + 7-color node palette', 'SVG canvas + 8-color node palette', 'English palette docs')
en = replaceOnce(en,
'fact/inference/rule/definition/counter-example nodes become checkable claims',
'fact/claim/inference/rule/definition/counter-example nodes become checkable claims',
'English fact-check docs')
en = replaceIfPresent(en,
'The 7 node wire types and 6 relation edge types are listed above.',
'The 8 node wire types and 12 relation edge types are listed above.')
writeFileSync(readmeEnPath, en)

console.log(JSON.stringify({ ok: true, patched: ['src/index.host.js', 'scripts/kg-semantic-contract-smoke.mjs', 'README.md', 'README.en.md'] }))
