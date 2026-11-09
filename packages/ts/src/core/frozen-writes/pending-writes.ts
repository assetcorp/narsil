import { PENDING_DOCUMENTS, PENDING_TOKEN_WORDS, PENDING_TOKENS, PENDING_UNITS } from '#platform/frozen-kernel-host'
import type { NativeFrozenSegmentState } from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'
import { PENDING_REMOVAL_DOCUMENTS, PENDING_REMOVAL_TOKENS, PENDING_REMOVAL_UNITS } from './constants'
import type { PendingSize } from './pending'
import type { GrowFrozenRemovalRegions } from './types'

export const NO_SURFACE = 0xffffffff
const FIELD_TOKEN_WORDS = 8

function sameUnits(units: Uint16Array, left: number, leftLength: number, right: number, rightLength: number) {
  if (leftLength !== rightLength) return false
  for (let unit = 0; unit < leftLength; unit++) if (units[left + unit] !== units[right + unit]) return false
  return true
}

function tokenIsPending(partialFields: Uint8Array, field: NativeFieldTokens, at: number): boolean {
  if (partialFields[field.field] !== 0) return true
  const { tokens, units } = field
  const surface = tokens[at + 3]
  const length = tokens[at + 4]
  return surface !== NO_SURFACE && length > 0 && !sameUnits(units, tokens[at + 1], tokens[at + 2], surface, length)
}

export function pendingNeeds(partialFields: Uint8Array, fields: readonly NativeFieldTokens[]): PendingSize {
  let tokens = 0
  let units = 0
  for (const field of fields) {
    for (let at = 0; at < field.tokens.length; at += FIELD_TOKEN_WORDS) {
      if (!tokenIsPending(partialFields, field, at)) continue
      tokens++
      units += field.tokens[at + 2]
      if (field.tokens[at + 3] !== NO_SURFACE) units += field.tokens[at + 4]
    }
  }
  return { documents: 1, tokens, units }
}

export function pendingFits(state: NativeFrozenSegmentState, needed: PendingSize, empty: boolean): boolean {
  const header = state.pendingHeader
  const held = (word: number) => (empty ? 0 : header[word])
  return (
    held(PENDING_DOCUMENTS) + needed.documents <= state.pendingDocuments.length &&
    held(PENDING_TOKENS) + needed.tokens <= state.pendingTokens.length / PENDING_TOKEN_WORDS &&
    held(PENDING_UNITS) + needed.units <= state.pendingUnits.length
  )
}

function grown<T extends Uint32Array | Uint16Array>(held: T, length: number, create: new (length: number) => T): T {
  if (held.length >= length) return held
  const next = new create(length)
  next.set(held)
  return next
}

export const growFrozenRemovalRegions: GrowFrozenRemovalRegions = (segment, state, fields) => {
  const { tokens, units } = pendingNeeds(segment.partialFields, fields)
  state.pendingDocuments = grown(state.pendingDocuments, PENDING_REMOVAL_DOCUMENTS, Uint32Array)
  if (tokens * PENDING_TOKEN_WORDS > state.pendingTokens.length)
    state.pendingTokens = grown(
      state.pendingTokens,
      Math.max(PENDING_REMOVAL_TOKENS, tokens) * PENDING_TOKEN_WORDS,
      Uint32Array,
    )
  if (units > state.pendingUnits.length)
    state.pendingUnits = grown(state.pendingUnits, Math.max(PENDING_REMOVAL_UNITS, units), Uint16Array)
}

export function appendPending(
  state: NativeFrozenSegmentState,
  partialFields: Uint8Array,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
): void {
  const header = state.pendingHeader
  state.pendingDocuments[header[PENDING_DOCUMENTS]] = ordinal
  let written = header[PENDING_TOKENS]
  let units = header[PENDING_UNITS]
  const copy = (source: Uint16Array, start: number, length: number) => {
    state.pendingUnits.set(source.subarray(start, start + length), units)
    units += length
  }
  for (const field of fields) {
    for (let at = 0; at < field.tokens.length; at += FIELD_TOKEN_WORDS) {
      if (!tokenIsPending(partialFields, field, at)) continue
      const word = written++ * PENDING_TOKEN_WORDS
      const surface = field.tokens[at + 3]
      state.pendingTokens[word] = field.field
      state.pendingTokens[word + 1] = units
      state.pendingTokens[word + 2] = field.tokens[at + 2]
      copy(field.units, field.tokens[at + 1], field.tokens[at + 2])
      state.pendingTokens[word + 3] = surface === NO_SURFACE ? NO_SURFACE : units
      state.pendingTokens[word + 4] = surface === NO_SURFACE ? 0 : field.tokens[at + 4]
      if (surface !== NO_SURFACE) copy(field.units, surface, field.tokens[at + 4])
    }
  }
}
