import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error('patch marker not found: ' + label)
  return source.replace(before, after)
}

let host = readFileSync('src/index.host.js', 'utf8')

const oldCoverageRule = `        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。counter_example 只用于真正削弱/限制某个命题的案例；负向结果或对照情形若仍在支持原命题，不得标为 counter_example。若首轮已经保留后续行为或机制，却把承载该行为的明确命名对象/定义型 worked example 整段省略，应补回最小 example/definition/concept 锚点，并只用原文直接支持的 example/analogy/supports 等关系把新锚点连接到已有机制；不得因此收录所有例子。',`
const newCoverageRule = `        '4. 多个例子同时存在时，只补能揭示机制步骤、关键区分或连接多个核心命题的例子；纯修辞、只重复已有原则的比喻优先省略。例子节点仍用 example；如果它是类比，用 analogy 关系表达其作用。counter_example 只用于真正削弱/限制某个命题的案例；负向结果或对照情形若仍在支持原命题，不得标为 counter_example。若首轮已经保留后续行为或机制，却把承载该行为的明确命名对象/定义型 worked example 整段省略，应补回最小 example/definition/concept 锚点，并只用原文直接支持的 example/analogy/supports 等关系把新锚点连接到已有机制；不得因此收录所有例子。若一个完整原文单元没有任何已接受节点，但它以“例如/想象一下/哪怕/当…时/如果…就…”等具体场景直接说明已出现的抽象主张或机制，也应逐项检查是否漏掉一个最小 example 节点及必要的 example/supports/analogy 边；这只是补漏，不得因此收录纯修辞或所有例子。',`
host = replaceOnce(host, oldCoverageRule, newCoverageRule, 'coverage rule')

const workedMarker = `      function workedExampleCoverageHintsHost(batch, graph) {\n`
const simpleHelper = `      function simpleIllustrativeCoverageHintsHost(batch, graph) {\n        const units = batch && Array.isArray(batch.units) ? batch.units : []\n        const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []\n        if (units.length === 0) return []\n        const frameCue = /(?:例如|比如|譬如|想象一下|哪怕|就好比|就拿|我们之所以|还有一个现象|当.{1,80}时|如果.{1,80}(?:就|会))/\n        const explanatoryCue = /(?:因为|基于|据此|说明|意味着|预测|不符|导致|所以|因此|从而|用于|支撑)/\n        const nodeByParagraph = new Map()\n        for (const node of nodes) {\n          if (!node || !Number.isInteger(node.paragraph)) continue\n          const list = nodeByParagraph.get(node.paragraph) || []\n          list.push(node)\n          nodeByParagraph.set(node.paragraph, list)\n        }\n        const hints = []\n        for (const unit of units) {\n          if (hints.length >= 4 || !unit || !Number.isInteger(unit.num)) continue\n          const text = String(unit.text || '').trim()\n          if (text.length < 12 || !frameCue.test(text) || !explanatoryCue.test(text)) continue\n          if ((nodeByParagraph.get(unit.num) || []).length > 0) continue\n          hints.push({ paragraph: unit.num, text: text.slice(0, 320) })\n        }\n        return hints\n      }\n\n`
host = replaceOnce(host, workedMarker, simpleHelper + workedMarker, 'simple illustrative helper')

const oldCoverageReturn = `        return workedExampleCoverageHintsHost(batch, graph).length > 0 || explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
const newCoverageReturn = `        return workedExampleCoverageHintsHost(batch, graph).length > 0 || simpleIllustrativeCoverageHintsHost(batch, graph).length > 0 || explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
host = replaceOnce(host, oldCoverageReturn, newCoverageReturn, 'coverage trigger')

const oldCoveragePromptTail = `        if (workedExampleHints.length > 0) {\n          text += NL + '结构性 worked-example 候选（只是补漏召回提示，不是建节点或连边的证据；已有等价覆盖就跳过）：' + NL\n          for (const hint of workedExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '请逐项检查这些候选是否承载了后续行为、误区、机制或验证区分；只有确实缺失时才补最小锚点。' + NL\n        }\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n`
const newCoveragePromptTail = `        if (workedExampleHints.length > 0) {\n          text += NL + '结构性 worked-example 候选（只是补漏召回提示，不是建节点或连边的证据；已有等价覆盖就跳过）：' + NL\n          for (const hint of workedExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '请逐项检查这些候选是否承载了后续行为、误区、机制或验证区分；只有确实缺失时才补最小锚点。' + NL\n        }\n        const simpleExampleHints = simpleIllustrativeCoverageHintsHost(batch, accepted)\n        if (simpleExampleHints.length > 0) {\n          text += NL + '独立说明例子候选（完整原文单元尚无节点；只是召回提示，不是建节点或连边的证据）：' + NL\n          for (const hint of simpleExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '只在该具体场景确实承担说明已有主张/机制的作用且当前图完全遗漏时，补最小 example 节点及原文直接支持的必要关系。' + NL\n        }\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n`
host = replaceOnce(host, oldCoveragePromptTail, newCoveragePromptTail, 'coverage prompt hints')

const oldRelationRule = `        '6. 候选关系对只是召回提示，不是关系证据。孤立节点可以保持孤立，未定义概念也可以悬空。',`
const newRelationRule = `        '6. 候选关系对只是召回提示，不是关系证据。孤立节点可以保持孤立，未定义概念也可以悬空。连续流程候选同样只是召回提示；只有原文直接呈现前一步产物/状态进入后一步，或直接支持 causes/infers/supports 中某一关系时才连边，单纯时间相邻不得连边。',`
host = replaceOnce(host, oldRelationRule, newRelationRule, 'relation sequence rule')

const relationBuildMarker = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n`
const sequenceHelper = `      function sequentialRelationCandidatePairsHost(groupNodes, existingEdges, paragraphTexts) {\n        const byParagraph = new Map()\n        for (const node of Array.isArray(groupNodes) ? groupNodes : []) {\n          if (!node || !Number.isInteger(node.paragraph)) continue\n          const list = byParagraph.get(node.paragraph) || []\n          list.push(node)\n          byParagraph.set(node.paragraph, list)\n        }\n        const existingPairs = new Set()\n        for (const edge of Array.isArray(existingEdges) ? existingEdges : []) {\n          if (!edge || !edge.fromNodeId || !edge.toNodeId) continue\n          existingPairs.add([edge.fromNodeId, edge.toNodeId].sort().join('|'))\n        }\n        const startCue = /^(?:首先|第一步|先(?:是|将|把|由|让|从|经过)?|接着|然后|随后|其次|再次|最后|再然后)/\n        const continuationCue = /^(?:接着|然后|随后|其次|再次|最后|再然后)/\n        const paragraphs = Array.from(byParagraph.keys()).sort((a, b) => a - b)\n        const pairs = []\n        for (let i = 0; i + 1 < paragraphs.length && pairs.length < 12; i++) {\n          const fromParagraph = paragraphs[i]\n          const toParagraph = paragraphs[i + 1]\n          if (toParagraph !== fromParagraph + 1) continue\n          const fromText = String(paragraphTexts[fromParagraph] || '').trim()\n          const toText = String(paragraphTexts[toParagraph] || '').trim()\n          if (!startCue.test(fromText) || !continuationCue.test(toText)) continue\n          for (const a of byParagraph.get(fromParagraph) || []) {\n            for (const b of byParagraph.get(toParagraph) || []) {\n              if (!a || !b || a.id === b.id) continue\n              const pairKey = [a.id, b.id].sort().join('|')\n              if (existingPairs.has(pairKey)) continue\n              pairs.push({ a, b, fromParagraph, toParagraph })\n              if (pairs.length >= 12) break\n            }\n            if (pairs.length >= 12) break\n          }\n        }\n        return pairs\n      }\n\n`
host = replaceOnce(host, relationBuildMarker, sequenceHelper + relationBuildMarker, 'sequence relation helper')

const oldRelationBuildHead = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n        const ids = new Set(groupNodes.map((node) => node.id))\n        const units = relationEvidenceUnitsHost(groupNodes, paragraphTexts)\n        let text = ''\n`
const newRelationBuildHead = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n        const ids = new Set(groupNodes.map((node) => node.id))\n        const units = relationEvidenceUnitsHost(groupNodes, paragraphTexts)\n        const sequencePairs = sequentialRelationCandidatePairsHost(groupNodes, existingEdges, paragraphTexts)\n        let text = ''\n`
host = replaceOnce(host, oldRelationBuildHead, newRelationBuildHead, 'sequence pairs build')

const oldCandidateTail = `        if (candidatePairs.length === 0) text += '（无）' + NL\n        text += NL + '已有关系（禁止重复）：' + NL\n`
const newCandidateTail = `        if (candidatePairs.length === 0) text += '（无）' + NL\n        text += NL + '连续流程候选关系对（相邻原文含“首先/接着/然后”等显式步骤标记；只是召回提示，不是关系证据）：' + NL\n        for (const pair of sequencePairs) {\n          text += pair.a.id + '<>' + pair.b.id + '|P' + pair.fromParagraph + '->P' + pair.toParagraph + NL\n        }\n        if (sequencePairs.length === 0) text += '（无）' + NL\n        text += NL + '已有关系（禁止重复）：' + NL\n`
host = replaceOnce(host, oldCandidateTail, newCandidateTail, 'sequence pair prompt')

writeFileSync('src/index.host.js', host)

let workedSmoke = readFileSync('scripts/kg-worked-example-coverage-smoke.mjs', 'utf8')
workedSmoke = replaceOnce(
  workedSmoke,
  `const source = '拿函数定义来说：“函数定义描述一种对应关系。”面对函数定义时，学习者可能反复阅读并记住这句话。'\n`,
  `const source = '拿函数定义来说：“函数定义描述一种对应关系。”面对函数定义时，学习者可能反复阅读并记住这句话。'\nconst simpleSource = [\n  '预测能力时刻支撑人的行动。',\n  '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。',\n].join('\\n\\n')\n`,
  'worked smoke simple source',
)
workedSmoke = replaceOnce(
  workedSmoke,
  `  async extractChunk(args) {\n    producerPrompt = args.systemPrompt\n    return {\n`,
  `  async extractChunk(args) {\n    producerPrompt = args.systemPrompt\n    if (args.title === 'simple-example-coverage') {\n      return {\n        summary: '预测支撑日常行动',\n        nodes: [{\n          id: 'n1',\n          type: 'claim',\n          text: '预测能力时刻支撑人的行动。',\n          quote: '预测能力时刻支撑人的行动。',\n          paragraph: 0,\n        }],\n        edges: [],\n      }\n    }\n    return {\n`,
  'worked smoke extract branch',
)
workedSmoke = replaceOnce(
  workedSmoke,
  `  async reviewCoverage(args) {\n    coverageCalls.push(args)\n    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')\n`,
  `  async reviewCoverage(args) {\n    coverageCalls.push(args)\n    if (args.title === 'simple-example-coverage') {\n      assert(args.systemPrompt.includes('完整原文单元没有任何已接受节点'), 'coverage contract does not protect omitted independent illustrative examples')\n      assert(args.prompt.includes('独立说明例子候选'), 'coverage prompt did not surface independent illustrative-example hints')\n      assert(args.prompt.includes('[P1] 哪怕是不经意的翻页动作'), 'coverage prompt did not point at the omitted page-turning example')\n      return {\n        nodes: [{\n          id: 'm1',\n          type: 'example',\n          text: '翻页行为基于对翻页后内容的预测。',\n          quote: '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。',\n          paragraph: 1,\n        }],\n        edges: [{\n          fromNodeId: 'm1',\n          toNodeId: 'n1',\n          relation: 'example',\n          evidence: [{ paragraph: 1, quote: '哪怕是不经意的翻页动作，也是你基于大脑预测翻页后会看到后续内容而采取的行动。' }],\n        }],\n      }\n    }\n    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')\n`,
  'worked smoke review branch',
)
workedSmoke = replaceOnce(
  workedSmoke,
  `assert(done.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'worked-example anchor was not connected to the downstream behavior')\nconsole.log(JSON.stringify({ ok: true, workedExampleRecovered: true, boundedCoverage: true }))\n`,
  `assert(done.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'worked-example anchor was not connected to the downstream behavior')\n\nconst simpleStarted = await handlers.get('extract')({ title: 'simple-example-coverage', text: simpleSource })\nconst simpleDone = await waitTask(simpleStarted.taskId)\nassert(simpleDone.status === 'succeeded', 'simple illustrative-example extraction failed: ' + JSON.stringify(simpleDone))\nassert(coverageCalls.length === 2, 'simple illustrative omission did not receive one additional bounded coverage review')\nassert(simpleDone.result.nodes.some((node) => node.id === 'm1' && String(node.text || '').includes('翻页')), 'page-turning illustrative example was not recovered')\nassert(simpleDone.result.edges.some((edge) => edge.fromNodeId === 'm1' && edge.toNodeId === 'n1' && edge.relation === 'example'), 'page-turning example was not connected to the abstract prediction claim')\nconsole.log(JSON.stringify({ ok: true, workedExampleRecovered: true, simpleExampleRecovered: true, boundedCoverage: true }))\n`,
  'worked smoke assertions',
)
writeFileSync('scripts/kg-worked-example-coverage-smoke.mjs', workedSmoke)

let connectivity = readFileSync('scripts/kg-connectivity-smoke.mjs', 'utf8')
connectivity = replaceOnce(
  connectivity,
  `  async extractChunk({ title, existingNodeIds }) {\n    if (title === 'append-connectivity') {\n`,
  `  async extractChunk({ title, existingNodeIds }) {\n    if (title === 'sequence-relation-recall') {\n      return {\n        summary: '连续流程关系召回',\n        nodes: [\n          { id: 'v1', type: 'fact', text: '物体反光进入眼睛并在视网膜上聚焦。', quote: '首先，物体的反光进入眼睛并在视网膜上聚焦。', paragraph: 0 },\n          { id: 'v2', type: 'fact', text: '视网膜感光细胞将反光转换成神经电信号。', quote: '接着，视网膜感光细胞将反光转换成神经电信号。', paragraph: 1 },\n          { id: 'v3', type: 'fact', text: '神经电信号传到视觉皮层并形成宏观预测结果。', quote: '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。', paragraph: 2 },\n        ],\n        edges: [],\n      }\n    }\n    if (title === 'append-connectivity') {\n`,
  'connectivity sequence extract',
)
connectivity = replaceOnce(
  connectivity,
  `  async weaveRelations(args) {\n    weaveCalls.push(args)\n    if (args.title === 'explicit-relation-seed') return { edges: [] }\n`,
  `  async weaveRelations(args) {\n    weaveCalls.push(args)\n    if (args.title === 'sequence-relation-recall') {\n      assert(args.systemPrompt.includes('连续流程候选'), 'relation-weave contract does not describe sequence candidates as recall-only')\n      assert(args.prompt.includes('连续流程候选关系对'), 'relation-weave prompt omitted explicit sequence candidates')\n      assert(args.prompt.includes('v1<>v2|P0->P1'), 'first adjacent process step was not surfaced as a sequence candidate')\n      assert(args.prompt.includes('v2<>v3|P1->P2'), 'second adjacent process step was not surfaced as a sequence candidate')\n      return {\n        edges: [\n          {\n            fromNodeId: 'v1', toNodeId: 'v2', relation: 'supports',\n            evidence: [\n              { paragraph: 0, quote: '首先，物体的反光进入眼睛并在视网膜上聚焦。' },\n              { paragraph: 1, quote: '接着，视网膜感光细胞将反光转换成神经电信号。' },\n            ],\n          },\n          {\n            fromNodeId: 'v2', toNodeId: 'v3', relation: 'supports',\n            evidence: [\n              { paragraph: 1, quote: '接着，视网膜感光细胞将反光转换成神经电信号。' },\n              { paragraph: 2, quote: '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。' },\n            ],\n          },\n        ],\n      }\n    }\n    if (args.title === 'explicit-relation-seed') return { edges: [] }\n`,
  'connectivity sequence weave',
)
connectivity = replaceOnce(
  connectivity,
  `const quick = await handlers.get('verify-graph')({ text, graph: completed.result, mode: 'quick' })\nassert(quick && quick.report && quick.report.metrics.connectedComponents === 1, 'quick verification omitted connectivity metrics')\nassert(quick.report.metrics.isolatedNodes === 0, 'quick verification still reports isolated nodes after weaving')\n\n// Append mode must weave against the complete canonical source so a new node\n`,
  `const quick = await handlers.get('verify-graph')({ text, graph: completed.result, mode: 'quick' })\nassert(quick && quick.report && quick.report.metrics.connectedComponents === 1, 'quick verification omitted connectivity metrics')\nassert(quick.report.metrics.isolatedNodes === 0, 'quick verification still reports isolated nodes after weaving')\n\n// Adjacent process units with explicit “首先/接着/然后” markers are recall\n// candidates only. The relation reviewer must still supply direct source\n// evidence before any edge enters the canonical graph.\nconst sequenceText = [\n  '首先，物体的反光进入眼睛并在视网膜上聚焦。',\n  '接着，视网膜感光细胞将反光转换成神经电信号。',\n  '然后，这些神经电信号传到视觉皮层并形成宏观预测结果。',\n].join('\\n\\n')\nconst sequenceStarted = await handlers.get('extract')({ title: 'sequence-relation-recall', text: sequenceText })\nconst sequenceCompleted = await waitTask(sequenceStarted.taskId)\nassert(sequenceCompleted.status === 'succeeded' && sequenceCompleted.result, 'sequence relation recall extraction failed: ' + JSON.stringify(sequenceCompleted))\nassert(sequenceCompleted.result.edges.some((edge) => edge.fromNodeId === 'v1' && edge.toNodeId === 'v2' && edge.relation === 'supports'), 'first process-step relation was not admitted')\nassert(sequenceCompleted.result.edges.some((edge) => edge.fromNodeId === 'v2' && edge.toNodeId === 'v3' && edge.relation === 'supports'), 'second process-step relation was not admitted')\nassert(sequenceCompleted.result.edges.every((edge) => Array.isArray(edge.evidence) && edge.evidence.length > 0), 'sequence relation entered without direct evidence')\n\n// Append mode must weave against the complete canonical source so a new node\n`,
  'connectivity sequence assertions',
)
writeFileSync('scripts/kg-connectivity-smoke.mjs', connectivity)

const frozenPath = 'scripts/fixtures/world-recognition-part1-qa-cases.json'
const calibratedPath = 'scripts/fixtures/world-recognition-part1-qa-cases-calibrated-v1.json'
const calibrated = JSON.parse(readFileSync(frozenPath, 'utf8'))
const limitCase = calibrated.find((item) => item && item.id === 'experience-prediction-limit')
if (!limitCase || !Array.isArray(limitCase.options)) throw new Error('frozen experience-prediction-limit case not found')
const pathOption = limitCase.options.find((item) => item && item.kind === 'path')
if (!pathOption || !pathOption.to || !Array.isArray(pathOption.to.any)) throw new Error('frozen experience-prediction-limit path selector not found')
const calibratedPhrase = '经验预测在与自然直接交互的物质世界中行不通'
if (!pathOption.to.any.includes(calibratedPhrase)) pathOption.to.any.push(calibratedPhrase)
writeFileSync(calibratedPath, JSON.stringify(calibrated, null, 2) + '\n')
