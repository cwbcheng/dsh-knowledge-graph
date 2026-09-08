import { createHash } from 'node:crypto'
import { graphContract } from './normalize.mjs'

export const { splitParagraphs, splitParagraphsOffsets } = graphContract

export function buildSourceManifest(title, text, paras) {
  const hash = value => createHash('sha256').update(value).digest('hex')
  const sourceId = 'source-' + hash(String(text || ''))
  // Preserve the CLI's content-addressed document identity across recovery.
  return graphContract.buildSourceManifest(title, text, paras, 'document-' + hash(sourceId), sourceId)
}
