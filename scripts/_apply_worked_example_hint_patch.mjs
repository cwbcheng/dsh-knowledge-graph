import { readFileSync, writeFileSync } from 'node:fs'

function patchFile(path) {
  let s = readFileSync(path, 'utf8')
  const marker = `      function mechanismCoverageNeededHost(batch, graph) {\n`
  if (!s.includes(marker)) throw new Error('mechanism coverage marker not found in ' + path)
  const helper = `      function workedExampleCoverageHintsHost(batch, graph) {\n        const units = batch && Array.isArray(batch.units) ? batch.units : []\n        const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []\n        if (units.length === 0) return []\n        const exampleFrameCue = /(?:例如|比如|譬如|举例|例子|拿.{0,24}来说|以.{0,24}为例|假设|面对|学习|阅读|看到|看见)/\n        const namedKnowledgeCue = /(?:定义|概念|公式|定理|规则|命题|模型|算法|术语|题目)/\n        const quotedCue = /[“\\\"「『][^”\\\"」』]{2,160}[”\\\"」』]/\n        const behaviorCue = /(?:感觉|记住|理解|判断|验证|误认为|误以为|错把|学会|掌握|完成|反复|阅读|练习)/\n        const hints = []\n        const nodeByParagraph = new Map()\n        for (const node of nodes) {\n          if (!node || !Number.isInteger(node.paragraph)) continue\n          const list = nodeByParagraph.get(node.paragraph) || []\n          list.push(node)\n          nodeByParagraph.set(node.paragraph, list)\n        }\n        for (let index = 0; index < units.length && hints.length < 6; index++) {\n          const unit = units[index]\n          if (!unit || !Number.isInteger(unit.num)) continue\n          const text = String(unit.text || '').trim()\n          if (text.length < 8) continue\n          const framed = exampleFrameCue.test(text)\n          const named = namedKnowledgeCue.test(text)\n          const quoted = quotedCue.test(text)\n          if (!(framed && (named || quoted))) continue\n          let downstream = behaviorCue.test(text)\n          for (let delta = 1; !downstream && delta <= 2; delta++) {\n            const neighbor = units[index + delta]\n            if (neighbor && behaviorCue.test(String(neighbor.text || ''))) downstream = true\n          }\n          for (let delta = 0; !downstream && delta <= 2; delta++) {\n            const paragraph = unit.num + delta\n            for (const node of nodeByParagraph.get(paragraph) || []) {\n              if (behaviorCue.test(String(node.text || ''))) { downstream = true; break }\n            }\n          }\n          if (!downstream) continue\n          const locallyCovered = (nodeByParagraph.get(unit.num) || []).some((node) => {\n            const material = String(node.text || '') + ' ' + String(node.quote || '')\n            return (named && namedKnowledgeCue.test(material)) || (quoted && quotedCue.test(material))\n          })\n          if (locallyCovered) continue\n          hints.push({ paragraph: unit.num, text: text.slice(0, 260) })\n        }\n        return hints\n      }\n\n`
  s = s.replace(marker, helper + marker)

  const oldReturn = `        return explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
  const newReturn = `        return workedExampleCoverageHintsHost(batch, graph).length > 0 || explanatoryBoundaryGap || (suspiciousUnits > 0 && (mechanismUnits >= 2 || units.some((unit) => ((String(unit && unit.text || '').match(mechanismCue) || []).length >= 2))))\n`
  if (!s.includes(oldReturn)) throw new Error('mechanism return marker not found in ' + path)
  s = s.replace(oldReturn, newReturn)

  const oldPrompt = `        if (!accepted || !Array.isArray(accepted.nodes) || accepted.nodes.length === 0) text += '（无）' + NL\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n        return text\n`
  const newPrompt = `        if (!accepted || !Array.isArray(accepted.nodes) || accepted.nodes.length === 0) text += '（无）' + NL\n        const workedExampleHints = workedExampleCoverageHintsHost(batch, accepted)\n        if (workedExampleHints.length > 0) {\n          text += NL + '结构性 worked-example 候选（只是补漏召回提示，不是建节点或连边的证据；已有等价覆盖就跳过）：' + NL\n          for (const hint of workedExampleHints) text += '[P' + hint.paragraph + '] ' + hint.text + NL\n          text += '请逐项检查这些候选是否承载了后续行为、误区、机制或验证区分；只有确实缺失时才补最小锚点。' + NL\n        }\n        if (existingDigest) text += NL + '前文/已有图可引用节点（禁止重复创建）：' + NL + existingDigest + NL\n        return text\n`
  if (!s.includes(oldPrompt)) throw new Error('coverage prompt marker not found in ' + path)
  s = s.replace(oldPrompt, newPrompt)
  writeFileSync(path, s)
}

patchFile('src/index.host.js')

const fixturePath = 'scripts/fixtures/preface-qa-cases.json'
let fixture = readFileSync(fixturePath, 'utf8')
const feelingOld = `  {\n    "id": "feeling-understood-not-goal",\n    "question": "‘感觉懂了’是不是明确的行为目标？",\n    "category": "answerability",\n    "kind": "node",\n    "selector": { "all": ["感觉懂了", "不是", "行为目标"] }\n  },`
const feelingNew = `  {\n    "id": "feeling-understood-not-goal",\n    "question": "‘感觉懂了’是不是明确的行为目标？",\n    "category": "answerability",\n    "kind": "any-of",\n    "options": [\n      {\n        "kind": "node",\n        "selector": { "all": ["感觉懂了", "不是", "行为目标"] }\n      },\n      {\n        "kind": "relation",\n        "from": { "all": ["感觉懂了"] },\n        "to": { "all": ["行为目标"] },\n        "relations": ["not_is"]\n      }\n    ]\n  },`
if (!fixture.includes(feelingOld)) throw new Error('feeling-understood fixture marker not found')
fixture = fixture.replace(feelingOld, feelingNew)
const methodsOld = `        ["手段本身并非有问题", "方法本身并非有问题", "并非这些手段有问题", "并非这些方法有问题"]`
const methodsNew = `        ["手段本身并非有问题", "方法本身并非有问题", "并非这些手段有问题", "并非这些方法有问题", "并非因为这些手段本身有问题", "并非因为这些方法本身有问题"]`
if (!fixture.includes(methodsOld)) throw new Error('methods fixture marker not found')
fixture = fixture.replace(methodsOld, methodsNew)
writeFileSync(fixturePath, fixture)

const smokePath = 'scripts/kg-worked-example-coverage-smoke.mjs'
let smoke = readFileSync(smokePath, 'utf8')
smoke = smoke.replace(
  `const source = '拿函数定义来说，面对函数定义时，学习者可能反复阅读，直到感觉懂了，然后努力记住讲解。'`,
  `const source = '例子：“函数定义描述一种对应关系。”\\n\\n面对函数定义时，学习者可能反复阅读并记住这句话。'`,
)
smoke = smoke.replace(
  `        text: '学习者可能反复阅读，直到感觉懂了，然后努力记住讲解。',\n        quote: '学习者可能反复阅读，直到感觉懂了，然后努力记住讲解',\n        paragraph: 0,`,
  `        text: '面对函数定义时，学习者可能反复阅读并记住这句话。',\n        quote: '面对函数定义时，学习者可能反复阅读并记住这句话',\n        paragraph: 1,`,
)
smoke = smoke.replace(
  `    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')`,
  `    assert(args.systemPrompt.includes('明确命名对象/定义型 worked example'), 'coverage prompt does not protect named worked-example context')\n    assert(args.prompt.includes('结构性 worked-example 候选'), 'coverage prompt did not surface structural worked-example hints')\n    assert(args.prompt.includes('[P0] 例子：“函数定义描述一种对应关系。”'), 'coverage prompt did not point at the omitted definition example')`,
)
smoke = smoke.replace(
  `        text: '面对函数定义时的学习场景。',\n        quote: '面对函数定义时',\n        paragraph: 0,`,
  `        text: '函数定义的学习例子。',\n        quote: '函数定义描述一种对应关系',\n        paragraph: 0,`,
)
smoke = smoke.replace(
  `        evidence: [{ paragraph: 0, quote: source }],`,
  `        evidence: [\n          { paragraph: 0, quote: '例子：“函数定义描述一种对应关系。”' },\n          { paragraph: 1, quote: '面对函数定义时，学习者可能反复阅读并记住这句话。' },\n        ],`,
)
smoke = smoke.replace(
  `assert(done.result.nodes.some((node) => node.id === 'm1' && String(node.text || '').includes('面对函数定义')), 'worked-example context anchor was not recovered')`,
  `assert(done.result.nodes.some((node) => node.id === 'm1' && String(node.text || '').includes('函数定义')), 'worked-example context anchor was not recovered')`,
)
writeFileSync(smokePath, smoke)
