import { type ByteSource, chunksOf } from '../../persistence/archive/byte-reader'

const NEWLINE = 0x0a

export type ExportLine = { line: number; text: string } | { line: number; refused: 'too-long' | 'not-utf8' }

function joined(parts: readonly Uint8Array[], total: number): Uint8Array {
  if (parts.length === 1) return parts[0]
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

export async function* exportLines(source: ByteSource, maxLineBytes: number): AsyncGenerator<ExportLine> {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let parts: Uint8Array[] = []
  let pending = 0
  let overflowing = false
  let line = 0
  const finishLine = (): ExportLine => {
    line += 1
    if (overflowing) {
      overflowing = false
      parts = []
      pending = 0
      return { line, refused: 'too-long' }
    }
    const bytes = joined(parts, pending)
    parts = []
    pending = 0
    try {
      return { line, text: decoder.decode(bytes) }
    } catch {
      return { line, refused: 'not-utf8' }
    }
  }
  for await (const chunk of chunksOf(source)) {
    let start = 0
    for (;;) {
      const newline = chunk.indexOf(NEWLINE, start)
      const end = newline < 0 ? chunk.byteLength : newline
      const piece = chunk.subarray(start, end)
      if (!overflowing && pending + piece.byteLength <= maxLineBytes) {
        if (piece.byteLength > 0) parts.push(piece.slice())
        pending += piece.byteLength
      } else {
        overflowing = true
        parts = []
      }
      if (newline < 0) break
      yield finishLine()
      start = newline + 1
    }
  }
  if (pending > 0 || overflowing) yield finishLine()
}
