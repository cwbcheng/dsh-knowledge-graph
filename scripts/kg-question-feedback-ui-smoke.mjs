import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const client = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')
const panelStart = client.indexOf('      function VerificationPanel(')
const panelEnd = client.indexOf('      function ', panelStart + 10)
assert(panelStart >= 0 && panelEnd > panelStart)
const panel = client.slice(panelStart, panelEnd)
assert(panel.indexOf('questionContent,') < panel.indexOf("className: 'kg-verify-filters'"),
  'question and its feedback must appear before a potentially long issue list')
assert.equal((panel.match(/className: 'kg-question-bar'/g) || []).length, 1)
assert(panel.includes("className: 'kg-question-progress', role: 'status'"))
assert(panel.includes("className: 'kg-question-error', role: 'alert'"))
assert(panel.includes("className: 'kg-question-result', role: 'status'"))
assert(panel.includes('questionFeedbackRef.current?.scrollIntoView'),
  'completed feedback must be brought into the visible scroll region')

const graph = { summary: '', nodes: [], edges: [] }
const view = { graph, sourceText: 'source' }
const starts = [...client.matchAll(/        const submitQuestion = async \(draftOverride, targetOverride\) => \{/g)].map(match => match.index)
assert.equal(starts.length, 2, 'both document and trajectory question forms need feedback')

function fixture(start, response) {
  const end = client.indexOf('        const handleApplyIssue =', start)
  assert(end > start)
  const states = { phase: [], error: [], questionError: [], result: [], progress: [], taskId: [] }
  const env = {
    questionDraft: 'Why?', resultView: view, view, questionPhase: 'idle',
    title: 'Fixture', fullText: 'source', questionTarget: null, effectiveModelArg: null,
    setError: value => states.error.push(value),
    setQuestionError: value => states.questionError.push(value),
    setVerifyProgress: value => states.progress.push(value),
    setQuestionPhase: value => states.phase.push(value),
    setQuestionResult: value => states.result.push(value),
    setQuestionTaskId: value => states.taskId.push(value),
    verificationSourcePayload: () => ({}),
    host: { call: async () => {
      if (response instanceof Error) throw response
      return response
    } },
  }
  const source = client.slice(start, end) + '; return submitQuestion'
  const submit = new Function(...Object.keys(env), source)(...Object.values(env))
  return { submit, states }
}

for (const start of starts) {
  for (const [response, expected] of [
    [{ error: { message: 'upstream unavailable' } }, 'upstream unavailable'],
    [{}, '无法提交质疑任务，请重试'],
    [new Error('network down'), '无法提交质疑任务：network down'],
  ]) {
    const { submit, states } = fixture(start, response)
    await submit()
    assert.equal(states.questionError.at(-1), expected)
    assert.equal(states.phase.at(-1), 'idle')
    assert.deepEqual(states.error, [null], 'question failures must not be hidden in a remote global banner')
  }
  const { submit, states } = fixture(start, { taskId: 'question-1' })
  await submit()
  assert.deepEqual(states.taskId, ['question-1'])
  assert.equal(states.phase.at(-1), 'running')
  assert.equal(states.questionError.at(-1), '')
}

console.log('question feedback UI smoke passed')
