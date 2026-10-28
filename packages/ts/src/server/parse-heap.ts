import {
  type MemoryFigures,
  readMemoryFigures,
  readRecentMemoryFigures,
} from '../distribution/cluster-node/memory/measure'
import { HEAP_BLOCK_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE } from '../runtime/constants'
import {
  admitHeapBytes,
  collectGarbageBeforeRefusal,
  collectYoungGenerationBeforeRefusal,
  reportRefusalAfterCollection,
  reservedHeapBytes,
} from '../runtime/thread-heap'
import {
  PARSE_ARRAY_HEAP_BYTES,
  PARSE_HEAP_BLOCK_FRACTION,
  PARSE_HEAP_READ_BLOCK_FRACTION,
  PARSE_OBJECT_HEAP_BYTES,
  PARSE_PROPERTY_HEAP_BYTES,
  PARSE_SCALAR_HEAP_BYTES,
  PARSE_STRING_HEAP_BYTES,
  PARSE_STRING_HEAP_BYTES_PER_BYTE,
  PARSE_TEXT_HEAP_BYTES_PER_BODY_BYTE,
  PARSE_WORST_HEAP_BYTES_PER_BODY_BYTE,
} from './constants'
import { ServerErrorCodes } from './errors'

const PARSE_WOULD_FILL_MEMORY_REASON = 'parse_would_fill_memory'
const PARSE_EXCEEDS_MEMORY_REASON = 'parse_exceeds_memory'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_OBJECT = 0x7b
const OPEN_ARRAY = 0x5b
const COLON = 0x3a

export interface ParseRefusal {
  status: 413 | 429
  code: string
  message: string
  details: {
    reason: string
    bodyBytes: number
    parseBytes: number
    heapBytes: number
    youngHeapBytes: number
    reservedBytes: number
    blockBytes: number
    collectedGarbage: boolean
  }
}

function isScalarByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    byte === 0x2d ||
    byte === 0x2b ||
    byte === 0x2e
  )
}

export function closingQuoteOf(raw: Uint8Array, from: number): number {
  let at = raw.indexOf(QUOTE, from)
  while (at !== -1) {
    let backslashes = 0
    while (at - 1 - backslashes >= from && raw[at - 1 - backslashes] === BACKSLASH) backslashes++
    if (backslashes % 2 === 0) return at
    at = raw.indexOf(QUOTE, at + 1)
  }
  return raw.length
}

export function scannedParseBytes(raw: Uint8Array): number {
  let objects = 0
  let arrays = 0
  let properties = 0
  let strings = 0
  let stringBytes = 0
  let scalars = 0
  let inScalar = false
  for (let at = 0; at < raw.length; at++) {
    const byte = raw[at]
    if (byte === QUOTE) {
      const end = closingQuoteOf(raw, at + 1)
      strings++
      stringBytes += end - at - 1
      at = end
      inScalar = false
    } else if (isScalarByte(byte)) {
      if (!inScalar) scalars++
      inScalar = true
    } else {
      inScalar = false
      if (byte === OPEN_OBJECT) objects++
      else if (byte === OPEN_ARRAY) arrays++
      else if (byte === COLON) properties++
    }
  }
  return (
    raw.length * PARSE_TEXT_HEAP_BYTES_PER_BODY_BYTE +
    objects * PARSE_OBJECT_HEAP_BYTES +
    arrays * PARSE_ARRAY_HEAP_BYTES +
    properties * PARSE_PROPERTY_HEAP_BYTES +
    strings * PARSE_STRING_HEAP_BYTES +
    stringBytes * PARSE_STRING_HEAP_BYTES_PER_BYTE +
    scalars * PARSE_SCALAR_HEAP_BYTES
  )
}

interface ParseLine {
  heap: number
  process: number
}

const WRITE_PARSE_LINE: ParseLine = {
  heap: Math.min(PARSE_HEAP_BLOCK_FRACTION, HEAP_BLOCK_FRACTION_BELOW_V8_INEFFECTIVE_MARK_COMPACT_LINE),
  process: PARSE_HEAP_BLOCK_FRACTION,
}
const READ_PARSE_LINE: ParseLine = { heap: PARSE_HEAP_READ_BLOCK_FRACTION, process: PARSE_HEAP_READ_BLOCK_FRACTION }

function roomIn(figures: MemoryFigures, line: ParseLine): number {
  return (
    Math.min(
      line.heap * figures.heapLimitBytes - figures.heapBytes - figures.youngHeapBytes,
      line.process * figures.processLimitBytes - figures.processBytes,
    ) - reservedHeapBytes()
  )
}

function refusal(
  status: 413 | 429,
  raw: Uint8Array,
  parseBytes: number,
  figures: MemoryFigures,
  collectedGarbage: boolean,
  line: ParseLine,
): ParseRefusal {
  const blockBytes = Math.floor(line.heap * figures.heapLimitBytes)
  const message =
    status === 413
      ? `Parsing this ${raw.length}-byte body can take up to ${parseBytes} bytes of memory, more than the ${blockBytes} bytes that the server allows its heap even when idle. Send the request in smaller parts.`
      : `Parsing this ${raw.length}-byte body can take up to ${parseBytes} bytes of memory, which with the ${figures.heapBytes} bytes already in use would pass the server's limit of ${blockBytes} bytes. Retry once the requests in progress finish.`
  return {
    status,
    code: status === 413 ? ServerErrorCodes.PAYLOAD_TOO_LARGE : ServerErrorCodes.TOO_MANY_REQUESTS,
    message,
    details: {
      reason: status === 413 ? PARSE_EXCEEDS_MEMORY_REASON : PARSE_WOULD_FILL_MEMORY_REASON,
      bodyBytes: raw.length,
      parseBytes,
      heapBytes: figures.heapBytes,
      youngHeapBytes: figures.youngHeapBytes,
      reservedBytes: reservedHeapBytes(),
      blockBytes,
      collectedGarbage,
    },
  }
}

function admitted(parseBytes: number): null {
  admitHeapBytes(parseBytes)
  return null
}

export type ParsedBodyKind = 'write' | 'read'

export function parseRefusalOf(raw: Uint8Array, kind: ParsedBodyKind = 'write'): ParseRefusal | null {
  const line = kind === 'read' ? READ_PARSE_LINE : WRITE_PARSE_LINE
  const recent = readRecentMemoryFigures()
  if (recent === null) return null
  const worstBytes = raw.length * PARSE_WORST_HEAP_BYTES_PER_BODY_BYTE
  if (worstBytes <= roomIn(recent, line)) return admitted(worstBytes)
  const parseBytes = Math.min(scannedParseBytes(raw), worstBytes)
  if (parseBytes > line.heap * recent.heapLimitBytes) {
    return refusal(413, raw, parseBytes, recent, false, line)
  }
  if (parseBytes <= roomIn(recent, line)) return admitted(parseBytes)
  const figures = readMemoryFigures() ?? recent
  if (parseBytes <= roomIn(figures, line)) return admitted(parseBytes)
  const collectedGarbage = collectGarbageBeforeRefusal()
  const collectedYoung = !collectedGarbage && collectYoungGenerationBeforeRefusal()
  const settled = collectedGarbage || collectedYoung ? (readMemoryFigures() ?? figures) : figures
  if (parseBytes <= roomIn(settled, line)) return admitted(parseBytes)
  if (collectedGarbage && kind === 'write') reportRefusalAfterCollection(settled)
  return refusal(429, raw, parseBytes, settled, collectedGarbage, line)
}
