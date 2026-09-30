import { connectionFixture } from './kg-connection-model-fixture-data.mjs'
import { learnerResponse } from './kg-model-learning-fixture-data.mjs'

export function comparisonFixture() {
  const document = connectionFixture(), { nodes, edges } = document.graph
  const paragraph = document.sourceUnits.length
  const quote = '夜间附加条件：简化基础计价后加收 20%；须核对适用时段和真实账单。'
  document.sourceUnits.push({ paragraph, text: quote })
  document.sourceText += '\n\n' + quote
  document.graph.source.sections[1].endParagraph = paragraph
  const node = (id, type, text) => ({ id, type, text, paragraph, quote, state: 'candidate', entailmentStatus: 'unverified',
    evidence: [{ documentId: document.documentId, sourceId: document.graph.source.id, paragraph, quote }] })
  const port = (id, target, role) => ({ fromNodeId: id, toNodeId: target, relation: 'maps_between', role,
    evidence: [{ documentId: document.documentId, sourceId: document.graph.source.id, paragraph, quote }] })
  nodes.push(node('night', 'connection_model', '夜间计价：同一基础费用再加 20%；适用时段待核对。'),
    node('reverse', 'connection_model', '由费用反推距离；分段固定费用可能对应多个距离。'),
    node('named-copy', 'connection_model', '同名端点的另一个模型，尚未确认概念身份。'),
    node('distance-copy', 'concept', '行驶距离 (ｋｍ)'), node('fare-copy', 'concept', '打车费用 (元)'))
  edges.push(port('night', 'distance', 'input'), port('night', 'fare', 'output'),
    port('reverse', 'fare', 'input'), port('reverse', 'distance', 'output'),
    port('named-copy', 'distance-copy', 'input'), port('named-copy', 'fare-copy', 'output'))
  for (let index = 0; index < 23; index++) {
    const id = 'peer-' + index
    nodes.push(node(id, 'connection_model', '待比较的分段模型 ' + index))
    edges.push(port(id, 'distance', 'input'), port(id, 'fare', 'output'))
  }
  return document
}

export const counterexampleResponse = { ...learnerResponse,
  baseline: '白天行驶 7 km，不含附加收费。', baselinePrediction: '基础模型预测支付 18 元。',
  changedVariable: '只把白天改为夜间；里程、基础单价与路线不变。',
  scenario: '夜间行驶 7 km，里程和基础单价相同，可能出现附加收费。',
  prediction: '基础模型未包含夜间加价，无法仅凭原联结确定最终费用。',
  check: '查验计价时段和账单收费项，区分附加收费与基础里程计价的偏差。',
  falsifier: '若仍满足无附加费用条件而基础费用不为 18 元，则原联结的预测需重新检查。',
}
