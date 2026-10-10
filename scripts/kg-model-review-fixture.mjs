import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

export function modelReviewSource(source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')) {
  const start = source.indexOf('        const reviewConnectionModel = async')
  const end = source.indexOf('        const showImageNodes =', start)
  assert(start >= 0 && end > start, 'Production model review boundary')
  return source.slice(start, end)
}

export function modelQuestionNodeSource(source = readFileSync(new URL('../src/index.client.js', import.meta.url), 'utf8')) {
  const start = source.indexOf('        const handleQuestionNode = (node) =>')
  const end = source.indexOf('        const handleOpenNodeIssues =', start)
  assert(start >= 0 && end > start, 'Production workbench question navigation')
  return source.slice(start, end)
}

export function modelReviewReceiver(environment) {
  return new Function(...Object.keys(environment), modelReviewSource() + '\nreturn reviewConnectionModel')(...Object.values(environment))
}
