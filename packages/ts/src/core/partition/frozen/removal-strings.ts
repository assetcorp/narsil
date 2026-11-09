import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../../vector/native/types/segments'
import { packedTokens } from '../../segment-writes/prepared-tokens'
import { storedText } from '../../stored-values/text'
import type { FrozenPartialWordSlot } from '../partial-words/types'
import type { PreparedText } from '../prepared-text'
import type { FrozenSurfaceSlot } from './surface-slot'

export interface FrozenStringRemoval
  extends Pick<NativeFrozenSegment, 'surfaces' | 'spellings' | 'spellingTokens' | 'partialFields'>,
    Pick<NativeFrozenSegmentState, 'removedSurfaces' | 'removedSpellings'> {
  fields: NativeFieldTokens[]
}

const NO_SURFACE = 0xffffffff
const ABSENT_TEXT = 0xffffffff
const FIELD_TOKEN_WORDS = 8
const NO_SPELLING_TOKENS = new Uint32Array(0)
const NO_REMOVED_SPELLINGS = new Uint32Array(0)

interface DeferredSpelling {
  readonly term: string
  readonly surface: string | undefined
  readonly count: number
}

function writeUnits(units: Uint16Array, text: string, start: number): number {
  for (let at = 0; at < text.length; at++) units[start + at] = text.charCodeAt(at)
  return start + text.length
}

function packDeferred(field: number, deferred: readonly DeferredSpelling[]): NativeFieldTokens {
  let tokenCount = 0
  let unitCount = 0
  for (const { term, surface, count } of deferred) {
    tokenCount += count
    unitCount += term.length + (surface?.length ?? 0)
  }
  const tokens = new Uint32Array(tokenCount * FIELD_TOKEN_WORDS)
  const units = new Uint16Array(unitCount)
  let written = 0
  let unit = 0
  for (const { term, surface, count } of deferred) {
    const termStart = unit
    unit = writeUnits(units, term, unit)
    const surfaceStart = surface === undefined ? NO_SURFACE : unit
    if (surface !== undefined) unit = writeUnits(units, surface, unit)
    for (let copy = 0; copy < count; copy++, written++) {
      const at = written * FIELD_TOKEN_WORDS
      tokens[at] = written
      tokens[at + 1] = termStart
      tokens[at + 2] = term.length
      tokens[at + 3] = surfaceStart
      tokens[at + 4] = surface?.length ?? 0
      tokens[at + 7] = ABSENT_TEXT
    }
  }
  return { field, tokens, units }
}

function deferredRecords(
  field: number,
  isPartial: boolean,
  { tokens, units }: Pick<NativeFieldTokens, 'tokens' | 'units'>,
  changed: string[],
): NativeFieldTokens | null {
  const kept: number[] = []
  for (let at = 0; at < tokens.length; at += FIELD_TOKEN_WORDS) {
    const surface =
      tokens[at + 3] === NO_SURFACE || tokens[at + 4] === 0 ? '' : storedText(units, tokens[at + 3], tokens[at + 4])
    const differs = surface.length > 0 && surface !== storedText(units, tokens[at + 1], tokens[at + 2])
    if (differs) changed.push(surface)
    if (isPartial || differs) kept.push(at)
  }
  if (kept.length === 0) return null
  const selected = new Uint32Array(kept.length * FIELD_TOKEN_WORDS)
  for (let index = 0; index < kept.length; index++)
    selected.set(tokens.subarray(kept[index], kept[index] + FIELD_TOKEN_WORDS), index * FIELD_TOKEN_WORDS)
  return { field, tokens: selected, units }
}

export function prepareFrozenStrings(
  fieldNames: readonly string[],
  ordinal: number,
  text: PreparedText,
  surfaces: FrozenSurfaceSlot,
  partialWords: FrozenPartialWordSlot,
): { core: FrozenStringRemoval; publish(): void } {
  const fields: NativeFieldTokens[] = []
  const changed: string[] = []
  const partial = partialWords.removalState()
  for (let field = 0; field < fieldNames.length; field++) {
    const words = text.removalSpellings?.get(fieldNames[field])
    const isPartial = partial?.table.fields.includes(fieldNames[field]) === true
    if (words !== undefined) {
      const deferred: DeferredSpelling[] = []
      for (const [written, value] of words) {
        let spelling = written
        let token = isPartial ? partialWords.tokenForSpelling(written) : undefined
        if (token === undefined && isPartial && value.normalized !== null) {
          token = partialWords.tokenForSpelling(value.normalized)
          if (token !== undefined) spelling = value.normalized
        }
        token ??= surfaces.tokenOf(written)
        if (token === undefined) continue
        const surface = spelling === token ? undefined : spelling
        if (surface !== undefined && surface.length > 0)
          for (let count = 0; count < value.count; count++) changed.push(surface)
        if (isPartial || (surface !== undefined && surface.length > 0))
          deferred.push({ term: token, surface, count: value.count })
      }
      if (deferred.length > 0) fields.push(packDeferred(field, deferred))
      continue
    }
    const prepared = text.fields.get(fieldNames[field])
    if (prepared === undefined) continue
    const records = deferredRecords(field, isPartial, packedTokens(prepared.records), changed)
    if (records !== null) fields.push(records)
  }
  const surface = surfaces.prepareCoreRemoval(ordinal, changed)
  const partialFields = new Uint8Array(fieldNames.length)
  for (const path of partial?.table.fields ?? []) {
    const field = fieldNames.indexOf(path)
    if (field >= 0) partialFields[field] = 1
  }
  return {
    core: {
      fields,
      partialFields,
      surfaces: surface.table,
      removedSurfaces: surface.removed,
      spellings:
        partial === null
          ? null
          : {
              text: partial.table.spellings,
              offsets: partial.table.spellingOffsets,
              counts: partial.table.spellingCounts,
            },
      spellingTokens: partial?.table.spellingTokens ?? NO_SPELLING_TOKENS,
      removedSpellings: partial?.removed ?? NO_REMOVED_SPELLINGS,
    },
    publish: surface.publish,
  }
}
