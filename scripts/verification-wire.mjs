export async function encodeVerificationRequest(payload) {
  const json = JSON.stringify(payload)
  const gzip = json.length >= 512 * 1024 && typeof CompressionStream === 'function'
  const body = gzip
    ? await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()
    : json
  const bytes = gzip ? body.byteLength : new TextEncoder().encode(body).byteLength
  if (bytes > 4 * 1024 * 1024) throw new Error('审校请求超过传输上限；请缩小审校范围后重试')
  return {
    headers: { 'Content-Type': 'application/json', ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) },
    body,
  }
}
