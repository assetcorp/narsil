import { closingQuoteOf } from './parse-heap'

const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_OBJECT = 0x7b
const CLOSE_OBJECT = 0x7d
const OPEN_ARRAY = 0x5b
const CLOSE_ARRAY = 0x5d
const COLON = 0x3a
const REMOVE_BATCH_KEYS = new Set(['action', 'docIds', 'options'])
const REMOVE_ACTION = 'delete'

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d
}

function nextByteAt(raw: Uint8Array, from: number): number {
  let at = from
  while (at < raw.length && isWhitespace(raw[at])) at++
  return at
}

function plainStringOf(raw: Uint8Array, open: number, close: number): string | null {
  const content = raw.subarray(open + 1, close)
  if (content.includes(BACKSLASH)) return null
  return new TextDecoder().decode(content)
}

export function isRemoveOnlyBatch(raw: Uint8Array): boolean {
  const start = nextByteAt(raw, 0)
  if (raw[start] !== OPEN_OBJECT) return false
  let depth = 0
  let action: string | null = null
  for (let at = start; at < raw.length; at++) {
    const byte = raw[at]
    if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) depth++
    else if (byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) depth--
    else if (byte === QUOTE) {
      const close = closingQuoteOf(raw, at + 1)
      if (close >= raw.length) return false
      const afterString = nextByteAt(raw, close + 1)
      if (depth === 1 && raw[afterString] === COLON) {
        const key = plainStringOf(raw, at, close)
        if (key === null || !REMOVE_BATCH_KEYS.has(key)) return false
        if (key === 'action') {
          const value = nextByteAt(raw, afterString + 1)
          const valueClose = raw[value] === QUOTE ? closingQuoteOf(raw, value + 1) : raw.length
          action = valueClose < raw.length ? plainStringOf(raw, value, valueClose) : null
          if (action === null) return false
          at = valueClose
          continue
        }
        at = afterString
        continue
      }
      at = close
    }
  }
  return action === REMOVE_ACTION
}
