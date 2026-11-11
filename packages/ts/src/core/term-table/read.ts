import type { NativeTermDictionary, NativeTermTable } from '../../vector/native/types/terms'
import { typedRegion } from '../stored-values/regions'
import { storedText } from '../stored-values/text'

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

function snapshotTable(input: NativeTermTable): NativeTermTable | null {
  if (typeof input !== 'object' || input === null) return null
  return {
    header: input.header,
    slots: input.slots,
    termOffset: input.termOffset,
    termLength: input.termLength,
    firstUnitNext: input.firstUnitNext,
    firstUnitHead: input.firstUnitHead,
    units: input.units,
  }
}

function readTable(input: NativeTermTable): NativeTermTable | null {
  const header = typedRegion(input.header, 'Uint32Array')
  const slots = typedRegion(input.slots, 'Int32Array')
  const termOffset = typedRegion(input.termOffset, 'Uint32Array')
  const termLength = typedRegion(input.termLength, 'Uint32Array')
  const firstUnitNext = typedRegion(input.firstUnitNext, 'Uint32Array')
  const firstUnitHead = typedRegion(input.firstUnitHead, 'Uint32Array')
  const units = typedRegion(input.units, 'Uint16Array')
  if (
    header === null ||
    slots === null ||
    termOffset === null ||
    termLength === null ||
    firstUnitNext === null ||
    firstUnitHead === null ||
    units === null ||
    header.length !== 8 ||
    firstUnitHead.length !== 65536 ||
    slots.length < 2 ||
    slots.length > 0x80000000 ||
    (slots.length & (slots.length - 1)) !== 0 ||
    termOffset.length > 0x7fffffff ||
    termLength.length !== termOffset.length ||
    firstUnitNext.length !== termOffset.length ||
    units.length > 0xffffffff ||
    header[0] > termOffset.length ||
    header[1] > header[0] ||
    header[2] !== slots.length ||
    header[4] > units.length
  )
    return null
  return { header, slots, termOffset, termLength, firstUnitNext, firstUnitHead, units }
}

export function readDictionary(input: NativeTermDictionary): NativeTermDictionary | null {
  if (typeof input !== 'object' || input === null) return null
  const growingInput = input.growing
  const table = growingInput === null ? null : snapshotTable(growingInput)
  const raw = { tokens: input.tokens, offsets: input.offsets, frequencies: input.frequencies, removed: input.removed }
  const growing = table === null ? null : readTable(table)
  const tokens = typedRegion(raw.tokens, 'Uint8Array')
  const offsets = typedRegion(raw.offsets, 'Uint32Array')
  const frequencies = typedRegion(raw.frequencies, 'Uint32Array')
  const removed = typedRegion(raw.removed, 'Uint32Array')
  if (
    (growingInput !== null && growing === null) ||
    tokens === null ||
    offsets === null ||
    frequencies === null ||
    removed === null ||
    tokens.length > 0xffffffff ||
    offsets.length > 0xffffffff ||
    frequencies.length > 0xffffffff ||
    removed.length !== frequencies.length
  )
    return null
  if (growing === null) {
    if (offsets.length !== frequencies.length + 1) return null
  } else if (tokens.length !== 0 || offsets.length !== 0 || frequencies.length < growing.header[0]) return null
  return { growing, tokens, offsets, frequencies, removed }
}

export function dictionaryRegions(dictionary: NativeTermDictionary): ArrayBufferView[] {
  return [
    dictionary.tokens,
    dictionary.offsets,
    dictionary.frequencies,
    dictionary.removed,
    ...(dictionary.growing === null ? [] : Object.values(dictionary.growing)),
  ]
}

export function termCount(dictionary: NativeTermDictionary): number {
  return dictionary.growing?.header[0] ?? dictionary.frequencies.length
}

export function liveFrequency(dictionary: NativeTermDictionary, ordinal: number): number {
  return Math.max(0, dictionary.frequencies[ordinal] - dictionary.removed[ordinal])
}

export function termText(dictionary: NativeTermDictionary, ordinal: number): string | null {
  const table = dictionary.growing
  if (table !== null) {
    const start = table.termOffset[ordinal]
    const length = table.termLength[ordinal]
    if (start > table.header[4] || length > table.header[4] - start || length > 0x40000000) return null
    return storedText(table.units, start, length)
  }
  const start = dictionary.offsets[ordinal]
  const end = dictionary.offsets[ordinal + 1]
  if (start > end || end > dictionary.tokens.length) return null
  try {
    const text = decoder.decode(dictionary.tokens.subarray(start, end))
    return text.length > 0x40000000 ? null : text
  } catch {
    return null
  }
}
