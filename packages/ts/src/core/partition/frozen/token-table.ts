import { compareCodePoints } from '../../ordering'

export interface FrozenTokenTable {
  readonly size: number
  find(token: string): number
  tokenAt(sortedIndex: number): string
  payloadSlot(sortedIndex: number): number
  documentFrequencyAt(sortedIndex: number): number
  prefixRange(prefix: string): { start: number; end: number }
  firstCharRange(token: string): { start: number; end: number }
}

export interface FrozenTokenTableData {
  blob: Uint8Array
  offsets: Uint32Array
  payloadSlots: Uint32Array
  documentFrequencies: Uint32Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function compareBytes(blob: Uint8Array, start: number, end: number, query: Uint8Array): number {
  const length = end - start
  const shared = length < query.length ? length : query.length
  for (let i = 0; i < shared; i++) {
    const diff = blob[start + i] - query[i]
    if (diff !== 0) return diff
  }
  return length - query.length
}

function startsWithBytes(blob: Uint8Array, start: number, end: number, prefix: Uint8Array): boolean {
  if (end - start < prefix.length) return false
  for (let i = 0; i < prefix.length; i++) {
    if (blob[start + i] !== prefix[i]) return false
  }
  return true
}

function nextCodePoint(codePoint: number): number {
  const next = codePoint + 1
  if (next >= 0xd800 && next <= 0xdfff) return 0xe000
  return next
}

export function encodeFrozenTokenTableData(
  tokens: readonly string[],
  docFrequencies: Record<string, number>,
): FrozenTokenTableData {
  const size = tokens.length
  const slotArray: number[] = new Array(size)
  for (let i = 0; i < size; i++) slotArray[i] = i
  slotArray.sort((a, b) => compareCodePoints(tokens[a], tokens[b]))
  const payloadSlots = Uint32Array.from(slotArray)

  const encoded: Uint8Array[] = new Array(size)
  let blobLength = 0
  for (let i = 0; i < size; i++) {
    const bytes = encoder.encode(tokens[payloadSlots[i]])
    encoded[i] = bytes
    blobLength += bytes.length
  }
  const blob = new Uint8Array(blobLength)
  const offsets = new Uint32Array(size + 1)
  let cursor = 0
  for (let i = 0; i < size; i++) {
    blob.set(encoded[i], cursor)
    cursor += encoded[i].length
    offsets[i + 1] = cursor
  }

  const documentFrequencies = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    documentFrequencies[i] = docFrequencies[tokens[payloadSlots[i]]] ?? 0
  }

  return { blob, offsets, payloadSlots, documentFrequencies }
}

export function wrapFrozenTokenTable(data: FrozenTokenTableData): FrozenTokenTable {
  const { blob, offsets, payloadSlots, documentFrequencies } = data
  const size = payloadSlots.length
  const decodedTokens: Array<string | undefined> = new Array(size)

  function lowerBound(query: Uint8Array): number {
    let lo = 0
    let hi = size
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareBytes(blob, offsets[mid], offsets[mid + 1], query) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function prefixEnd(from: number, prefix: Uint8Array): number {
    let lo = from
    let hi = size
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (startsWithBytes(blob, offsets[mid], offsets[mid + 1], prefix)) lo = mid + 1
      else if (compareBytes(blob, offsets[mid], offsets[mid + 1], prefix) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  return {
    size,

    find(token: string): number {
      const query = encoder.encode(token)
      const at = lowerBound(query)
      if (at >= size) return -1
      return compareBytes(blob, offsets[at], offsets[at + 1], query) === 0 ? at : -1
    },

    tokenAt(sortedIndex: number): string {
      let token = decodedTokens[sortedIndex]
      if (token === undefined) {
        token = decoder.decode(blob.subarray(offsets[sortedIndex], offsets[sortedIndex + 1]))
        decodedTokens[sortedIndex] = token
      }
      return token
    },

    payloadSlot(sortedIndex: number): number {
      return payloadSlots[sortedIndex]
    },

    documentFrequencyAt(sortedIndex: number): number {
      return documentFrequencies[sortedIndex]
    },

    prefixRange(prefix: string): { start: number; end: number } {
      const bytes = encoder.encode(prefix)
      const start = lowerBound(bytes)
      return { start, end: prefixEnd(start, bytes) }
    },

    firstCharRange(token: string): { start: number; end: number } {
      const unit = token.charCodeAt(0)
      if (Number.isNaN(unit)) return { start: 0, end: 0 }
      let fromCodePoint: number
      let toCodePoint: number
      if (unit >= 0xd800 && unit <= 0xdbff) {
        fromCodePoint = 0x10000 + ((unit - 0xd800) << 10)
        toCodePoint = fromCodePoint + 0x400
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return { start: 0, end: 0 }
      } else {
        fromCodePoint = unit
        toCodePoint = nextCodePoint(unit)
      }
      const from = encoder.encode(String.fromCodePoint(fromCodePoint))
      const to = encoder.encode(String.fromCodePoint(toCodePoint))
      return { start: lowerBound(from), end: lowerBound(to) }
    },
  }
}

export function buildFrozenTokenTable(
  tokens: readonly string[],
  docFrequencies: Record<string, number>,
): FrozenTokenTable {
  return wrapFrozenTokenTable(encodeFrozenTokenTableData(tokens, docFrequencies))
}
