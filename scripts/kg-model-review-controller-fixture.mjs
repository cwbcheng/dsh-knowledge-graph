import { readFileSync } from 'node:fs'

export function modelReviewControllerSource() {
  const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
  const production = (start, end) => {
    const from = client.indexOf(start), to = client.indexOf(end, from)
    if (from < 0 || to <= from) throw new Error('production model controller boundary missing')
    return client.slice(from, to)
  }
  return `function createModelReviewController(state, host) {
    ${production('      const edgeKeyOf =', '      function edgeIndexForIssue(')}
    ${production('      function connectionRolePatch(', '      function ConnectionModelPanel(')}
    ${production('      function documentIdOfGraph(', '      function graphViewMetadata(')}
    ${production('      function asAllNodesGraph(', '      function historyMetadata(')}
    ${production('      function semanticOperationsOf(', '      function carrySemanticOperations(')}
    const graphSemanticOperations = new WeakMap()
    const { resultView, graphCommitQueueRef, currentResultRef, graphRevisionRef, verifyBusyRef } = state
    const generationTaskActive = false, questionPhase = '', fullText = resultView.sourceText
    const makeView = (graph, sourceText) => ({ graph, sourceText })
    const setResultView = view => { state.savedView = view; currentResultRef.current = view; state.onSaved?.(view) }
    const setVerification = () => {}, setQuestionResult = () => {}
    ${production('        const reviewConnectionRoles =', '        const reviewConnectionModel =')}
    return reviewConnectionRoles
  }`
}

export const createModelReviewController = new Function('return (' + modelReviewControllerSource() + ')')()
