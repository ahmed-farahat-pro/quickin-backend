// Generates solid-burgundy QuickIn pass template PNGs (no external deps).
// Run: node pass-assets/generate.mjs
// Output: icon.png (29x29), icon@2x.png (58x58), icon@3x.png (87x87), logo.png (160x50), logo@2x.png (320x100)
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const DIR = dirname(fileURLToPath(import.meta.url))

// QuickIn burgundy #5B0F16
const R = 0x5b, G = 0x0f, B = 0x16, A = 0xff

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}
function solidPng(width, height) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const rowLen = width * 4
  const raw = Buffer.alloc((rowLen + 1) * height)
  for (let y = 0; y < height; y++) {
    const off = y * (rowLen + 1)
    raw[off] = 0 // filter type: none
    for (let x = 0; x < width; x++) {
      const p = off + 1 + x * 4
      raw[p] = R
      raw[p + 1] = G
      raw[p + 2] = B
      raw[p + 3] = A
    }
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const files = {
  'icon.png': [29, 29],
  'icon@2x.png': [58, 58],
  'icon@3x.png': [87, 87],
  'logo.png': [160, 50],
  'logo@2x.png': [320, 100],
}
for (const [name, [w, h]] of Object.entries(files)) {
  writeFileSync(join(DIR, name), solidPng(w, h))
  console.log(`wrote ${name} (${w}x${h})`)
}
