const NEWLINE = 0x0a
const CARRIAGE_RETURN = 0x0d

export class NdjsonLineTooLongError extends Error {
  constructor(readonly lineNumber: number) {
    super(`NDJSON line ${lineNumber} exceeds the configured per-line size limit`)
    this.name = 'NdjsonLineTooLongError'
  }
}

export interface NdjsonLine {
  lineNumber: number
  text: string
}

/**
 * Iterates newline-delimited records over an already-buffered body without
 * copying the whole corpus into a second array. Blank lines are skipped; a
 * trailing carriage return is trimmed so CRLF streams parse cleanly. A single
 * record longer than `maxLineBytes` raises {@link NdjsonLineTooLongError}, which
 * the import handler maps to 413, so an unterminated line cannot exhaust memory.
 */
export function* iterateNdjson(buffer: Buffer, maxLineBytes: number): Generator<NdjsonLine> {
  let start = 0
  let lineNumber = 0
  const length = buffer.length
  while (start < length) {
    let end = buffer.indexOf(NEWLINE, start)
    if (end === -1) end = length
    if (end - start > maxLineBytes) throw new NdjsonLineTooLongError(lineNumber + 1)
    let contentEnd = end
    if (contentEnd > start && buffer[contentEnd - 1] === CARRIAGE_RETURN) contentEnd--
    if (contentEnd > start) {
      lineNumber++
      yield { lineNumber, text: buffer.toString('utf8', start, contentEnd) }
    }
    start = end + 1
  }
}
