// Generate simple extension icons (blue circle + white node-edge glyph) as PNG.
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

function crc32(buf) {
  let c, table = []
  for (let n = 0; n < 256; n++) {
    c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  let crc = 0xffffffff
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixels) {
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6 // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)))
  const cx = x1 + t * dx, cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}
for (const size of [16, 48, 128]) {
  const px = Buffer.alloc(size * size * 4)
  const S = size
  const cx0 = S / 2, cy0 = S / 2, R = S * 0.44
  const nodes = [[0.30, 0.34], [0.70, 0.34], [0.50, 0.70]]
  const lines = [[0, 1], [1, 2], [2, 0]]
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4
    const d = Math.hypot(x + 0.5 - cx0, y + 0.5 - cy0)
    if (d > R) continue
    // blue disc
    px[i] = 59; px[i + 1] = 130; px[i + 2] = 246; px[i + 3] = 255
    const nx = (x + 0.5) / S, ny = (y + 0.5) / S
    let white = false
    for (const [a, b] of lines) {
      const [x1, y1] = nodes[a], [x2, y2] = nodes[b]
      if (distSeg(nx, ny, x1, y1, x2, y2) * S < S * 0.045) white = true
    }
    for (const [nx0, ny0] of nodes) {
      if (Math.hypot(nx - nx0, ny - ny0) * S < S * 0.085) white = true
    }
    if (white) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255 }
  }
  writeFileSync(`extension/icons/icon${size}.png`, png(size, px))
  console.log('icon' + size + '.png written')
}
