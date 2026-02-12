import { deflateSync } from "node:zlib"

/**
 * Minimal PNG encoder optimized for the audiovis visualizer.
 *
 * Per-frame allocations:
 *   - deflateSync output (~3-8KB) — unavoidable, but small with level 1
 *   - final data URI string (~5-12KB) — unavoidable (JS strings are immutable)
 *
 * All structural buffers (rawBuf, pngOut, dataUriBuf) are pre-allocated and reused.
 * The inline base64 encoder writes directly into dataUriBuf, avoiding an
 * intermediate ~107KB string that the old toString("base64") approach created.
 */

// ============================================================
// CRC32 table for PNG chunk validation
// ============================================================
const crcTable = (() => {
    const table = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        }
        table[n] = c
    }
    return table
})()

function crc32(buf: Buffer, offset: number, length: number): number {
    let crc = 0xffffffff
    const end = offset + length
    for (let i = offset; i < end; i++) {
        crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
    }
    return (crc ^ 0xffffffff) >>> 0
}

// ============================================================
// Image constants
// ============================================================
const WIDTH = 200
const HEIGHT = 100
const ROW_SIZE = WIDTH * 4
const RAW_SIZE = (ROW_SIZE + 1) * HEIGHT // 80100 bytes (with filter byte per row)

// ============================================================
// Pre-allocated raw pixel buffer with filter bytes
// ============================================================
const rawBuf = Buffer.alloc(RAW_SIZE)
for (let y = 0; y < HEIGHT; y++) {
    rawBuf[y * (ROW_SIZE + 1)] = 0 // filter byte = None
}

// ============================================================
// Pre-allocated PNG output buffer
// With deflate level 1, compressed data is typically 3-8KB for mostly-black
// RGBA images. Allocate for worst case (incompressible = raw size + overhead).
// ============================================================
const PNG_HEADER_SIZE = 8 + 25 // signature + IHDR
const MAX_COMPRESSED = RAW_SIZE + 1024 // generous upper bound
const PNG_MAX = PNG_HEADER_SIZE + (12 + MAX_COMPRESSED) + 12
const pngOut = Buffer.alloc(PNG_MAX)

// Pre-write PNG signature
pngOut[0] = 137
pngOut[1] = 80
pngOut[2] = 78
pngOut[3] = 71
pngOut[4] = 13
pngOut[5] = 10
pngOut[6] = 26
pngOut[7] = 10

// Pre-write IHDR chunk (constant for 200x100 RGBA)
const IHDR_OFF = 8
pngOut.writeUInt32BE(13, IHDR_OFF)
pngOut.write("IHDR", IHDR_OFF + 4, 4, "ascii")
pngOut.writeUInt32BE(WIDTH, IHDR_OFF + 8)
pngOut.writeUInt32BE(HEIGHT, IHDR_OFF + 12)
pngOut[IHDR_OFF + 16] = 8 // bit depth
pngOut[IHDR_OFF + 17] = 6 // color type: RGBA
pngOut[IHDR_OFF + 18] = 0 // compression
pngOut[IHDR_OFF + 19] = 0 // filter
pngOut[IHDR_OFF + 20] = 0 // interlace
pngOut.writeUInt32BE(crc32(pngOut, IHDR_OFF + 4, 17), IHDR_OFF + 21)

const IDAT_OFF = IHDR_OFF + 25

// ============================================================
// Inline base64 encoder — writes directly into pre-allocated buffer
// ============================================================
const B64_TABLE = new Uint8Array(64)
const B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
for (let i = 0; i < 64; i++) B64_TABLE[i] = B64_CHARS.charCodeAt(i)

const DATA_URI_PREFIX = "data:image/png;base64,"
const PREFIX_LEN = DATA_URI_PREFIX.length // 22
const MAX_B64_LEN = Math.ceil(PNG_MAX / 3) * 4
const dataUriBuf = Buffer.alloc(PREFIX_LEN + MAX_B64_LEN)
// @ts-expect-error Buffer assignability with Uint8Array in TS5
Buffer.from(DATA_URI_PREFIX, "ascii").copy(dataUriBuf)

/**
 * Encode RGBA pixel data as a PNG and return as a base64 data URI string.
 *
 * Per-frame allocations: only deflateSync output (~3-8KB) + final string (~5-12KB).
 * With level 1 deflate, output is ~15-20x smaller than uncompressed, dramatically
 * reducing IPC bandwidth to the Stream Deck software.
 *
 * @param width Image width (must be 200)
 * @param height Image height (must be 100)
 * @param rgba Raw RGBA pixel data
 * @returns Data URI string "data:image/png;base64,..."
 */
export function encodePNGToDataURI(width: number, height: number, rgba: Uint8Array): string {
    // 1. Copy pixel data into raw buffer (interleaved with filter bytes)
    for (let y = 0; y < height; y++) {
        const rawOff = y * (ROW_SIZE + 1) + 1
        const srcOff = y * ROW_SIZE
        for (let i = 0; i < ROW_SIZE; i++) {
            rawBuf[rawOff + i] = rgba[srcOff + i]
        }
    }

    // 2. Compress with deflate level 1 (fast, typically 15-20x compression)
    // This allocates a small (~3-8KB) Buffer — acceptable for V8's generational GC
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const compressed = deflateSync(rawBuf as any, { level: 1 })

    // 3. Build IDAT chunk into pre-allocated pngOut
    const compLen = compressed.length
    pngOut.writeUInt32BE(compLen, IDAT_OFF)
    pngOut.write("IDAT", IDAT_OFF + 4, 4, "ascii")
    // @ts-expect-error Buffer assignability with Uint8Array in TS5
    compressed.copy(pngOut, IDAT_OFF + 8)
    const crcOff = IDAT_OFF + 8 + compLen
    pngOut.writeUInt32BE(crc32(pngOut, IDAT_OFF + 4, 4 + compLen), crcOff)

    // 4. Build IEND chunk
    const iendOff = crcOff + 4
    pngOut.writeUInt32BE(0, iendOff)
    pngOut.write("IEND", iendOff + 4, 4, "ascii")
    pngOut.writeUInt32BE(crc32(pngOut, iendOff + 4, 4), iendOff + 8)

    const pngLen = iendOff + 12

    // 5. Base64 encode directly into pre-allocated dataUriBuf (no intermediate string)
    let si = 0
    let di = PREFIX_LEN
    const end3 = pngLen - (pngLen % 3)

    for (; si < end3; si += 3) {
        const b0 = pngOut[si],
            b1 = pngOut[si + 1],
            b2 = pngOut[si + 2]
        dataUriBuf[di++] = B64_TABLE[(b0 >> 2) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[((b0 << 4) | (b1 >> 4)) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[((b1 << 2) | (b2 >> 6)) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[b2 & 0x3f]
    }

    const rem = pngLen % 3
    if (rem === 1) {
        const b0 = pngOut[si]
        dataUriBuf[di++] = B64_TABLE[(b0 >> 2) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[(b0 << 4) & 0x3f]
        dataUriBuf[di++] = 0x3d // '='
        dataUriBuf[di++] = 0x3d
    } else if (rem === 2) {
        const b0 = pngOut[si],
            b1 = pngOut[si + 1]
        dataUriBuf[di++] = B64_TABLE[(b0 >> 2) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[((b0 << 4) | (b1 >> 4)) & 0x3f]
        dataUriBuf[di++] = B64_TABLE[(b1 << 2) & 0x3f]
        dataUriBuf[di++] = 0x3d
    }

    // 6. Single string allocation — the only one, and it's small (~5-12KB vs old ~107KB)
    return dataUriBuf.toString("ascii", 0, di)
}
