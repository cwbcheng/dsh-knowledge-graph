import { readFileSync, writeFileSync } from 'node:fs'

function replaceOnce(source, before, after, label) {
  if (!source.includes(before)) throw new Error('patch marker not found: ' + label)
  return source.replace(before, after)
}

let host = readFileSync('src/index.host.js', 'utf8')

const coverageRuleOld = `        '5. 所有新节点和关系必须由当前编号原文直接支持。quote/evidence 必须逐字来自原文；保留“可能、多数、通常、必须、如果、不是”等限定。若原文明示“并非X/不是X/不意味着X/问题不在X而在Y”，检查防误推理所需的X侧限定是否漏掉；若原文明示问题将在后文回答，可补一条普通 claim 记录“当前范围尚未给出具体答案”，不得猜答案或新增 question/unresolved 类型。',`
const coverageRuleNew = `        '5. 所有新节点和关系必须由当前编号原文直接支持。quote/evidence 必须逐字来自原文；保留“可能、多数、通常、必须、如果、不是、会、能、可、将、应、只有”等限定。对“首先/接着/然后/随后”等显式流程步骤，text 要尽量贴近原句拆成原子陈述并保留原文的会/可能/能/可/将/应/必须/如果/只有等语义强度与条件；不得把可能性、能力或条件性表述提升为无条件事实。若原文明示“并非X/不是X/不意味着X/问题不在X而在Y”，检查防误推理所需的X侧限定是否漏掉；若原文明示问题将在后文回答，可补一条普通 claim 记录“当前范围尚未给出具体答案”，不得猜答案或新增 question/unresolved 类型。',`
host = replaceOnce(host, coverageRuleOld, coverageRuleNew, 'coverage semantic-strength rule')

const mechanismMarker = `      function mechanismCoverageNeededHost(batch, graph) {\n`
const sectionHelper = `      function zeroNodeSectionCoverageHintsHost(batch, graph) {\n        const sectionIds = batch && Array.isArray(batch.sectionIds) ? batch.sectionIds : []\n        const sectionTitles = batch && Array.isArray(batch.sectionTitles) ? batch.sectionTitles : []\n        if (sectionIds.length === 0) return []\n        const covered = new Set()\n        for (const node of graph && Array.isArray(graph.nodes) ? graph.nodes : []) {\n          if (node && typeof node.sectionId === 'string' && node.sectionId) covered.add(node.sectionId)\n        }\n        const hints = []\n        for (let index = 0; index < sectionIds.length && hints.length < 4; index++) {\n          const sectionId = sectionIds[index]\n          if (!sectionId || covered.has(sectionId)) continue\n          hints.push({ sectionId, title: String(sectionTitles[index] || sectionId).slice(0, 120) })\n        }\n        return hints\n      }\n\n`
host = replaceOnce(host, mechanismMarker, sectionHelper + mechanismMarker, 'zero-node section helper')

const coverageReturnOld = `        return workedExampleCoverageHintsHost(batch, graph).length > 0 || simpleIllustrativeCoverageHintsHost(batch, graph).length > 0 || explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
const coverageReturnNew = `        return zeroNodeSectionCoverageHintsHost(batch, graph).length > 0 || workedExampleCoverageHintsHost(batch, graph).length > 0 || simpleIllustrativeCoverageHintsHost(batch, graph).length > 0 || explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
host = replaceOnce(host, coverageReturnOld, coverageReturnNew, 'zero-node section coverage trigger')

const coveragePromptTailOld = `        const simpleExampleHints = simpleIllustrativeCoverageHintsHost(batch, accepted)\n        if (simpleExampleHints.length > 0) {\n          text += NL + '独立说明例子候选（完整原文单元尚无节点；只是召回提示，不是建节点或连边的证据）：' + NL\n          for (const hint of simpleExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '只在该具体场景确实承担说明已有主张/机制的作用且当前图完全遗漏时，补最小 example 节点及原文直接支持的必要关系。' + NL\n        }\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n`
const coveragePromptTailNew = `        const simpleExampleHints = simpleIllustrativeCoverageHintsHost(batch, accepted)\n        if (simpleExampleHints.length > 0) {\n          text += NL + '独立说明例子候选（完整原文单元尚无节点；只是召回提示，不是建节点或连边的证据）：' + NL\n          for (const hint of simpleExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '只在该具体场景确实承担说明已有主张/机制的作用且当前图完全遗漏时，补最小 example 节点及原文直接支持的必要关系。' + NL\n        }\n        const zeroSectionHints = zeroNodeSectionCoverageHintsHost(batch, accepted)\n        if (zeroSectionHints.length > 0) {\n          text += NL + '完全未覆盖 section 候选（结构导航提示，不是“每节必须有节点”的 completeness invariant）：' + NL\n          for (const hint of zeroSectionHints) text += hint.sectionId + '|' + hint.title + NL\n          text += '这些已识别 section 当前没有任何已接受节点。逐项检查其中是否遗漏核心 claim/definition/rule 或明确 deferred-scope 信息；纯标题、过渡或修辞内容可以继续保持为空，禁止为了填满 section 而造节点。' + NL\n        }\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n`
host = replaceOnce(host, coveragePromptTailOld, coveragePromptTailNew, 'zero-node section prompt')

const relationRuleOld = `        '6. 候选关系对只是召回提示，不是关系证据。孤立节点可以保持孤立，未定义概念也可以悬空。连续流程候选同样只是召回提示；只有原文直接呈现前一步产物/状态进入后一步，或直接支持 causes/infers/supports 中某一关系时才连边，单纯时间相邻不得连边。',`
const relationRuleNew = `        '6. 候选关系对只是召回提示，不是关系证据。孤立节点可以保持孤立，未定义概念也可以悬空。连续流程候选同样只是召回提示；只有原文直接呈现前一步产物/状态进入后一步，或直接支持 causes/infers/supports 中某一关系时才连边，单纯时间相邻不得连边。例子角色候选也只是召回提示；example/analogy 的语义方向仍是具体例子→被说明项，不能仅因已有反向边或相邻出现就复制、反转或补边。',`
host = replaceOnce(host, relationRuleOld, relationRuleNew, 'example role relation rule')

const relationBuildMarker = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n`
const exampleRoleHelper = `      function exampleRoleCandidatePairsHost(groupNodes, existingEdges, stats) {\n        const nodes = Array.isArray(groupNodes) ? groupNodes : []\n        const edges = Array.isArray(existingEdges) ? existingEdges : []\n        const outgoingRole = new Set()\n        for (const edge of edges) {\n          if (!edge || !edge.fromNodeId) continue\n          if (edge.relation === 'example' || edge.relation === 'analogy') outgoingRole.add(edge.fromNodeId)\n        }\n        const targetTypes = new Set(['fact', 'claim', 'inference', 'concept', 'definition', 'rule'])\n        const pairs = []\n        for (const example of nodes) {\n          if (!example || example.type !== 'example' || outgoingRole.has(example.id)) continue\n          const related = nodes\n            .filter((node) => node && node.id !== example.id && targetTypes.has(node.type))\n            .map((node) => ({ node, score: relationCandidateScoreHost(example, node, stats) }))\n            .sort((a, b) => b.score - a.score || String(a.node.id).localeCompare(String(b.node.id)))\n            .slice(0, 3)\n          for (const item of related) {\n            pairs.push({ example, target: item.node })\n            if (pairs.length >= 12) return pairs\n          }\n        }\n        return pairs\n      }\n\n`
host = replaceOnce(host, relationBuildMarker, exampleRoleHelper + relationBuildMarker, 'example role helper')

const relationHeadOld = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n        const ids = new Set(groupNodes.map((node) => node.id))\n        const units = relationEvidenceUnitsHost(groupNodes, paragraphTexts)\n        const sequencePairs = sequentialRelationCandidatePairsHost(groupNodes, existingEdges, paragraphTexts)\n        let text = ''\n`
const relationHeadNew = `      function buildRelationWeaveUserTextHost(title, groupNodes, existingEdges, paragraphTexts, stats, index, total) {\n        const ids = new Set(groupNodes.map((node) => node.id))\n        const units = relationEvidenceUnitsHost(groupNodes, paragraphTexts)\n        const sequencePairs = sequentialRelationCandidatePairsHost(groupNodes, existingEdges, paragraphTexts)\n        const exampleRolePairs = exampleRoleCandidatePairsHost(groupNodes, existingEdges, stats)\n        let text = ''\n`
host = replaceOnce(host, relationHeadOld, relationHeadNew, 'example role build head')

const relationPromptOld = `        if (sequencePairs.length === 0) text += '（无）' + NL\n        text += NL + '已有关系（禁止重复）：' + NL\n`
const relationPromptNew = `        if (sequencePairs.length === 0) text += '（无）' + NL\n        text += NL + '例子角色候选关系对（example 节点当前缺少 outgoing example/analogy；方向按 example→候选被说明项展示；只是召回提示，不是关系证据）：' + NL\n        for (const pair of exampleRolePairs) {\n          const pe = Number.isInteger(pair.example.paragraph) ? pair.example.paragraph : '?'\n          const pt = Number.isInteger(pair.target.paragraph) ? pair.target.paragraph : '?'\n          text += pair.example.id + '->' + pair.target.id + '|P' + pe + '->P' + pt + NL\n        }\n        if (exampleRolePairs.length === 0) text += '（无）' + NL\n        text += NL + '已有关系（禁止重复）：' + NL\n`
host = replaceOnce(host, relationPromptOld, relationPromptNew, 'example role prompt')

writeFileSync('src/index.host.js', host)

let mechanism = readFileSync('scripts/kg-mechanism-coverage-smoke.mjs', 'utf8')
const mechanismExtractOld = `    if (title === 'plain-fact') {\n      return { summary: '直接事实', nodes: [{ id: 'f1', type: 'fact', text: '项目包含三个文件', quote: '项目包含三个文件。', paragraph: 0 }], edges: [] }\n    }\n`
const mechanismExtractNew = `    if (title === 'zero-section-coverage') {\n      return {\n        summary: '第二部分已有内容',\n        nodes: [{ id: 'z1', type: 'claim', text: '当前部分已有节点。', quote: '当前部分已有节点。', paragraph: 3 }],\n        edges: [],\n      }\n    }\n    if (title === 'plain-fact') {\n      return { summary: '直接事实', nodes: [{ id: 'f1', type: 'fact', text: '项目包含三个文件', quote: '项目包含三个文件。', paragraph: 0 }], edges: [] }\n    }\n`
mechanism = replaceOnce(mechanism, mechanismExtractOld, mechanismExtractNew, 'zero-section extract fixture')

const mechanismReviewMarker = `    if (args.title === 'coverage-partial-prune') {\n`
const mechanismReviewInsert = `    if (args.title === 'zero-section-coverage') {\n      assert(args.prompt.includes('完全未覆盖 section 候选'), 'zero-node section was not surfaced to coverage review')\n      assert(args.prompt.includes('第一部分'), 'zero-node section title was not surfaced')\n      assert(args.systemPrompt.includes('显式流程步骤') && args.systemPrompt.includes('不得把可能性、能力或条件性表述提升为无条件事实'), 'coverage prompt does not protect process-step semantic strength')\n      return {\n        nodes: [{ id: 'm1', type: 'claim', text: '这一部分介绍颜色标记体系。', quote: '这一部分介绍颜色标记体系。', paragraph: 1 }],\n        edges: [],\n      }\n    }\n    if (args.title === 'coverage-partial-prune') {\n`
mechanism = replaceOnce(mechanism, mechanismReviewMarker, mechanismReviewInsert, 'zero-section coverage review')

const mechanismPlainMarker = `const beforePlain = coverageCalls.length\n`
const zeroSectionTest = `const zeroSectionText = [\n  '第一部分',\n  '这一部分介绍颜色标记体系。',\n  '第二部分',\n  '当前部分已有节点。',\n].join('\\n\\n')\nconst zeroSectionStart = await handlers.get('extract')({ title: 'zero-section-coverage', text: zeroSectionText })\nconst zeroSection = await waitTask(zeroSectionStart.taskId)\nassert(zeroSection.status === 'succeeded', 'zero-section coverage extraction failed: ' + JSON.stringify(zeroSection))\nconst zeroSectionCall = coverageCalls.find((call) => call.title === 'zero-section-coverage')\nassert(zeroSectionCall, 'zero-node section did not trigger the existing coverage pass')\nassert(zeroSection.result.nodes.some((node) => node.id === 'm1' && node.sectionTitle === '第一部分'), 'missing section knowledge was not recovered into the correct section')\nconst zeroSectionCoverage = zeroSection.result.generation && zeroSection.result.generation.coverage\nassert(zeroSectionCoverage && zeroSectionCoverage.attemptedBatches === 1 && zeroSectionCoverage.repairedBatches === 1 && zeroSectionCoverage.addedNodes === 1, 'zero-section coverage metadata is incorrect: ' + JSON.stringify(zeroSectionCoverage))\n\nconst beforePlain = coverageCalls.length\n`
mechanism = replaceOnce(mechanism, mechanismPlainMarker, zeroSectionTest, 'zero-section coverage regression')
mechanism = replaceOnce(
  mechanism,
  `console.log(JSON.stringify({ ok: true, recoveredNodes: coverage.addedNodes, boundedReview: true, partialPrune: true, plainSkipped: true }))`,
  `console.log(JSON.stringify({ ok: true, recoveredNodes: coverage.addedNodes, boundedReview: true, partialPrune: true, zeroSectionCoverage: true, plainSkipped: true }))`,
  'mechanism smoke result',
)
writeFileSync('scripts/kg-mechanism-coverage-smoke.mjs', mechanism)

let connectivity = readFileSync('scripts/kg-connectivity-smoke.mjs', 'utf8')
const connectivityExtractMarker = `  async extractChunk({ title, existingNodeIds }) {\n    if (title === 'sequence-relation-recall') {\n`
const connectivityExtractInsert = `  async extractChunk({ title, existingNodeIds }) {\n    if (title === 'example-role-recall') {\n      return {\n        summary: '例子角色方向召回',\n        nodes: [\n          { id: 'r1', type: 'claim', text: '在物质世界中再次遇到完全相同现象的概率几乎为零。', quote: '在物质世界中再次遇到完全相同现象的概率几乎为零。', paragraph: 0 },\n          { id: 'e1', type: 'example', text: '人不能两次踏进同一条河流。', quote: '人不能两次踏进同一条河流。', paragraph: 1 },\n          { id: 'r2', type: 'claim', text: '河流水的微观粒子排列状态每时每刻都在变化。', quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。', paragraph: 2 },\n        ],\n        edges: [\n          { fromNodeId: 'r1', toNodeId: 'r2', relation: 'supports', evidence: [{ paragraph: 0, quote: '在物质世界中再次遇到完全相同现象的概率几乎为零。' }, { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' }] },\n          { fromNodeId: 'r2', toNodeId: 'e1', relation: 'analogy', evidence: [{ paragraph: 1, quote: '人不能两次踏进同一条河流。' }, { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' }] },\n        ],\n      }\n    }\n    if (title === 'sequence-relation-recall') {\n`
connectivity = replaceOnce(connectivity, connectivityExtractMarker, connectivityExtractInsert, 'example-role extract fixture')

const connectivityWeaveMarker = `  async weaveRelations(args) {\n    weaveCalls.push(args)\n    if (args.title === 'sequence-relation-recall') {\n`
const connectivityWeaveInsert = `  async weaveRelations(args) {\n    weaveCalls.push(args)\n    if (args.title === 'example-role-recall') {\n      assert(args.systemPrompt.includes('例子角色候选'), 'relation-weave contract does not keep example-role hints recall-only')\n      assert(args.prompt.includes('例子角色候选关系对'), 'relation-weave prompt omitted example-role candidates')\n      assert(args.prompt.includes('e1->r2'), 'role-deficient example was not surfaced in example-to-principle direction')\n      return {\n        edges: [{\n          fromNodeId: 'e1', toNodeId: 'r2', relation: 'analogy',\n          evidence: [\n            { paragraph: 1, quote: '人不能两次踏进同一条河流。' },\n            { paragraph: 2, quote: '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。' },\n          ],\n        }],\n      }\n    }\n    if (args.title === 'sequence-relation-recall') {\n`
connectivity = replaceOnce(connectivity, connectivityWeaveMarker, connectivityWeaveInsert, 'example-role relation review')

const appendCommentMarker = `// Append mode must weave against the complete canonical source so a new node\n`
const exampleRoleTest = `// An example that only has incoming/reversed role edges is still missing its\n// queryable example->principle role. The candidate is a recall hint only; the\n// reviewer must provide direct evidence before the outgoing relation is added.\nconst roleText = [\n  '在物质世界中再次遇到完全相同现象的概率几乎为零。',\n  '人不能两次踏进同一条河流。',\n  '我们可以从物理学的角度重新诠释这句话：河流水的微观粒子排列状态每时每刻都在变化。',\n].join('\\n\\n')\nconst roleStarted = await handlers.get('extract')({ title: 'example-role-recall', text: roleText })\nconst roleCompleted = await waitTask(roleStarted.taskId)\nassert(roleCompleted.status === 'succeeded' && roleCompleted.result, 'example-role recall extraction failed: ' + JSON.stringify(roleCompleted))\nassert(roleCompleted.result.edges.some((edge) => edge.fromNodeId === 'e1' && edge.toNodeId === 'r2' && edge.relation === 'analogy'), 'outgoing example role was not recovered')\nassert(roleCompleted.result.edges.some((edge) => edge.fromNodeId === 'r2' && edge.toNodeId === 'e1' && edge.relation === 'analogy'), 'existing reverse edge was unexpectedly rewritten or removed')\nconst roleEdge = roleCompleted.result.edges.find((edge) => edge.fromNodeId === 'e1' && edge.toNodeId === 'r2' && edge.relation === 'analogy')\nassert(roleEdge && Array.isArray(roleEdge.evidence) && roleEdge.evidence.length === 2, 'example-role edge entered without direct evidence')\n\n// Append mode must weave against the complete canonical source so a new node\n`
connectivity = replaceOnce(connectivity, appendCommentMarker, exampleRoleTest, 'example-role regression')
connectivity = replaceOnce(
  connectivity,
  `  edges: completed.result.edges.length,\n  connectivity,`,
  `  edges: completed.result.edges.length,\n  exampleRoleRecall: true,\n  connectivity,`,
  'connectivity smoke result',
)
writeFileSync('scripts/kg-connectivity-smoke.mjs', connectivity)

const v1Path = 'scripts/fixtures/world-recognition-part1-qa-cases-calibrated-v1.json'
const v2Path = 'scripts/fixtures/world-recognition-part1-qa-cases-calibrated-v2.json'
const cases = JSON.parse(readFileSync(v1Path, 'utf8'))
const limitCase = cases.find((item) => item && item.id === 'experience-prediction-limit')
if (!limitCase || !Array.isArray(limitCase.options)) throw new Error('experience-prediction-limit case missing from calibrated v1')
const pathOption = limitCase.options.find((item) => item && item.kind === 'path')
if (!pathOption) throw new Error('experience-prediction-limit path option missing')
pathOption.to = {
  all: [
    ['经验预测'],
    ['物质世界'],
    ['行不通', '无法', '无处发力', '失效'],
  ],
}
writeFileSync(v2Path, JSON.stringify(cases, null, 2) + '\n')
