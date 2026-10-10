import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const production = () => readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const between = (source, start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from)
  assert(from >= 0 && to > from, 'Production workspace boundary: ' + start)
  return source.slice(from, to)
}
export const modelWorkspaceTabsSource = (source = production()) => between(source, 'function WorkbenchTabs(', 'function WorkbenchBody(')
export const modelWorkspaceNavigationSource = (source = production()) => between(source, '        const navigateWorkspace =', '        const workspaceDocumentId =')
export function modelWorkspacePanelSource(source = production()) {
  const start = source.indexOf('h(ConnectionModelPanel, { key: documentIdOfGraph(resultView.graph)')
  const end = source.indexOf('})) : null,', start)
  assert(start >= 0 && end > start, 'Production workbench model mount')
  return source.slice(start, end + 2)
}
export function modelWorkspacePanePropsSource(kind, source = production()) {
  assert(['read', 'use', 'review', 'source'].includes(kind))
  const start = source.indexOf("h('div', { id: 'kg-workspace-" + kind + "'")
  const end = source.indexOf('tabIndex: -1 }', start)
  assert(start >= 0 && end > start, 'Production persistent workspace pane')
  return source.slice(start + "h('div', ".length, end + 'tabIndex: -1 }'.length)
}
export const modelWorkspaceQuestionPropsSource = (source = production()) => between(source,
  'questionDraft, setQuestionDraft: (draft) => {', '                        questionResult, questionError, questionPhase,')
