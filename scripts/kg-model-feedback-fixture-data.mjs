export function feedbackResponse(type = 'observation') {
  return { type, comparison: 'inconclusive', diagnosis: 'unsure', observationConfirmed: type === 'observation', parentResultId: '',
    content: type === 'observation' ? '账单含额外费用；实付 21 元。' : '这份记录尚不足以确认真实情境中的结果。',
    context: '里程为 7 km；存在尚未说明的附加费用。',
    observedOn: type === 'observation' ? new Date(Date.now() - 86400000).toISOString().slice(0, 10) : '',
    observedTimeZone: type === 'observation' ? 'Asia/Shanghai' : '',
    sourceName: type === 'ai_suggestion' ? '测试 AI 的手动记录' : type === 'reference' ? '隔离参考资料' : '',
    sourceUrl: '', sourceLocator: type === 'reference' ? '第 2 节，第 3 段' : '',
    rationale: '情境含额外费用，不能把总价差异当作分段规律被反驳。', revisionReason: '', reference: null }
}
