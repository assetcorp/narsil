import { corrupt } from './raw-fields'
import { isValidUtf8 } from './utf8'

const CONTINUATION_MASK = 0xc0
const CONTINUATION_BYTE = 0x80

export function requireOffsets(offsets: Uint32Array, listSize: number, name: string): void {
  if (offsets.length === 0) corrupt(`${name} must hold at least one value`, { field: name })
  if (offsets[0] !== 0) corrupt(`${name} must start at 0`, { field: name })
  for (let at = 1; at < offsets.length; at++) {
    if (offsets[at] < offsets[at - 1]) corrupt(`${name} decreases at entry ${at}`, { field: name, at })
  }
  if (offsets[offsets.length - 1] !== listSize) {
    corrupt(`${name} ends at ${offsets[offsets.length - 1]} where the list it divides holds ${listSize}`, {
      field: name,
    })
  }
}

export function requireUtf8Entries(blob: Uint8Array, offsets: Uint32Array, name: string): void {
  if (!isValidUtf8(blob)) corrupt(`${name} is not valid UTF-8`, { field: name })
  for (let at = 0; at < offsets.length; at++) {
    const offset = offsets[at]
    if (offset < blob.length && (blob[offset] & CONTINUATION_MASK) === CONTINUATION_BYTE) {
      corrupt(`${name} splits a character at entry ${at}`, { field: name, at })
    }
  }
}

export function requireOrdinals(values: Uint32Array, documentCount: number, name: string): void {
  for (let at = 0; at < values.length; at++) {
    if (values[at] >= documentCount) {
      corrupt(`${name} names document ${values[at]} of a segment of ${documentCount}`, { field: name, at })
    }
  }
}

export function requireStrictlyAscending(values: Uint32Array, start: number, end: number, name: string): void {
  for (let at = start + 1; at < end; at++) {
    if (values[at] <= values[at - 1]) corrupt(`${name} fails to ascend strictly at entry ${at}`, { field: name, at })
  }
}

function compareEntries(blob: Uint8Array, offsets: Uint32Array, left: number, right: number): number {
  const leftStart = offsets[left]
  const leftLength = offsets[left + 1] - leftStart
  const rightStart = offsets[right]
  const rightLength = offsets[right + 1] - rightStart
  const shared = leftLength < rightLength ? leftLength : rightLength
  for (let k = 0; k < shared; k++) {
    const diff = blob[leftStart + k] - blob[rightStart + k]
    if (diff !== 0) return diff
  }
  return leftLength - rightLength
}

export function requireEntriesAscend(
  blob: Uint8Array,
  offsets: Uint32Array,
  order: Uint32Array | null,
  name: string,
): void {
  const count = offsets.length - 1
  for (let at = 1; at < count; at++) {
    const left = order === null ? at - 1 : order[at - 1]
    const right = order === null ? at : order[at]
    if (compareEntries(blob, offsets, left, right) >= 0) {
      corrupt(`${name} fails to ascend strictly at entry ${at}`, { field: name, at })
    }
  }
}

export function requireSpellingEntriesAscend(
  blob: Uint8Array,
  offsets: Uint32Array,
  tokens: Uint32Array,
  name: string,
): void {
  for (let at = 1; at < tokens.length; at++) {
    const order = compareEntries(blob, offsets, at - 1, at) || tokens[at - 1] - tokens[at]
    if (order >= 0) corrupt(`${name} fails to ascend strictly at entry ${at}`, { field: name, at })
  }
}

export function requireBelow(values: Uint32Array, limit: number, name: string): void {
  for (let at = 0; at < values.length; at++) {
    if (values[at] >= limit)
      corrupt(`${name} holds ${values[at]} at entry ${at}, at or above ${limit}`, { field: name, at })
  }
}

export function requireNonZero(values: Uint32Array, name: string): void {
  for (let at = 0; at < values.length; at++) {
    if (values[at] === 0) corrupt(`${name} holds 0 at entry ${at}`, { field: name, at })
  }
}

export function requirePermutation(order: Uint32Array, name: string): void {
  const seen = new Uint8Array(order.length)
  for (let at = 0; at < order.length; at++) {
    const ordinal = order[at]
    if (ordinal >= order.length || seen[ordinal] === 1) {
      corrupt(`${name} repeats or overruns ordinal ${ordinal}`, { field: name, at })
    }
    seen[ordinal] = 1
  }
}

export function requireValuesAscendWithoutNaN(values: Float64Array, name: string): void {
  for (let at = 0; at < values.length; at++) {
    if (Number.isNaN(values[at])) corrupt(`${name} holds NaN at entry ${at}`, { field: name, at })
    if (at > 0 && values[at] < values[at - 1]) corrupt(`${name} descends at entry ${at}`, { field: name, at })
  }
}

export function requireWithin(values: Float64Array, lowest: number, highest: number, name: string): void {
  for (let at = 0; at < values.length; at++) {
    const value = values[at]
    if (!(value >= lowest && value <= highest)) {
      corrupt(`${name} holds ${value} at entry ${at}, outside ${lowest} to ${highest}`, { field: name, at })
    }
  }
}

export function requireRunsAscend(runs: Uint32Array, name: string): void {
  for (let run = 1; run * 3 < runs.length; run++) {
    const at = run * 3
    const before = at - 3
    let diff = runs[at] - runs[before]
    if (diff === 0) diff = runs[at + 1] - runs[before + 1]
    if (diff === 0) diff = runs[at + 2] - runs[before + 2]
    if (diff <= 0) corrupt(`${name} fails to ascend strictly at run ${run}`, { field: name, run })
  }
}
