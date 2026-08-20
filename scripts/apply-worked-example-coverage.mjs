import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/index.host.js'
let source = readFileSync(path, 'utf8')

function replaceOnce(label, before, after) {
  const count = source.split(before).length - 1
  if (count !== 1) throw new Error(label + ' marker count=' + count)
  source = source.replace(before, after)
}

replaceOnce(
  'producer worked-example retention',
  "        '15. 输出前自查：节点是否原子？fact/claim 是否分对？counter_example 是否真的在反驳一个命题而不是仅描述负向/对照结果？核心稳定对象是否有 concept anchor？显式纠偏或留待后文的信息是否被遗漏？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',\n",
  "        '15. 高知识密度 worked example 不得只因是例子而整体省略：若例子明确命名一个可复用对象或定义，并在同段或紧邻段落用于引出具体行为、误区、机制或验证区分，至少保留能把该例子连接到后续机制的最小 example/definition/concept 锚点。纯修辞且不承载这种连接作用的例子仍可省略。',\n        '16. 输出前自查：节点是否原子？fact/claim 是否分对？counter_example 是否真的在反驳一个命题而不是仅描述负向/对照结果？核心稳定对象是否有 concept anchor？显式纠偏或留待后文的信息是否被遗漏？高知识密度 worked example 是否被整段丢失？是否保留“可能/多数/必须/如果”等强度？是否存在比 supports 更精确的关系？证据是否真的证明节点和关系？',\n",
)

replaceOnce(
  'coverage worked-example retention',
  "        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。counter_example 只用于真正削弱/限制某个命题的案例；负向结果或对照情形若仍在支持原命题，不得标为 counter_example。',\n",
  "        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。counter_example 只用于真正削弱/限制某个命题的案例；负向结果或对照情形若仍在支持原命题，不得标为 counter_example。若首轮已经保留后续行为或机制，却把承载该行为的明确命名对象/定义型 worked example 整段省略，应补回最小 example/definition/concept 锚点，并只用原文直接支持的 example/analogy/supports 等关系把新锚点连接到已有机制；不得因此收录所有例子。',\n",
)

writeFileSync(path, source)
console.log(JSON.stringify({ ok: true, changed: [path] }))
