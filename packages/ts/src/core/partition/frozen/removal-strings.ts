import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../../vector/native/types/segments'
import { PreparedTokens, packedTokens } from '../../segment-writes/prepared-tokens'
import type { FrozenPartialWordSlot } from '../partial-words/types'
import { type PreparedText, preparedSurfaces } from '../prepared-text'
import type { FrozenSurfaceSlot } from './surface-slot'

export interface FrozenStringRemoval
  extends Pick<NativeFrozenSegment, 'surfaces' | 'spellings' | 'spellingTokens' | 'partialFields'>,
    Pick<NativeFrozenSegmentState, 'removedSurfaces' | 'removedSpellings'> {
  fields: NativeFieldTokens[]
}

export function prepareFrozenStrings(
  fieldNames: readonly string[],
  ordinal: number,
  text: PreparedText,
  surfaces: FrozenSurfaceSlot,
  partialWords: FrozenPartialWordSlot,
): { core: FrozenStringRemoval; publish(): void } {
  const fields: NativeFieldTokens[] = []
  const spellings = new Set<string>()
  const partial = partialWords.removalState()
  for (let field = 0; field < fieldNames.length; field++) {
    const words = text.removalSpellings?.get(fieldNames[field])
    if (words !== undefined) {
      const records = new PreparedTokens()
      let position = 0
      const isPartial = partial?.table.fields.includes(fieldNames[field]) === true
      for (const [written, value] of words) {
        const surfaceToken = surfaces.reader
          .candidatesForPrefix(written)
          .find(entry => entry.surface === written)?.token
        let spelling = written
        let token = isPartial ? partialWords.tokenForSpelling(written) : undefined
        if (token === undefined && isPartial && value.normalized !== null) {
          token = partialWords.tokenForSpelling(value.normalized)
          if (token !== undefined) spelling = value.normalized
        }
        token ??= surfaceToken
        if (token === undefined) continue
        if (surfaceToken !== undefined) spellings.add(written)
        for (let count = 0; count < value.count; count++)
          records.add(token, position++, spelling === token ? undefined : spelling)
      }
      fields.push({ field, ...packedTokens(records.finish()) })
      continue
    }
    const prepared = text.fields.get(fieldNames[field])
    if (prepared === undefined) continue
    fields.push({ field, ...packedTokens(prepared.records) })
    for (const [spelling, entry] of preparedSurfaces(prepared)) {
      if (spelling !== entry.token) spellings.add(spelling)
    }
  }
  const surface = surfaces.prepareCoreRemoval(ordinal, [...spellings])
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
      spellingTokens: partial?.table.spellingTokens ?? new Uint32Array(0),
      removedSpellings: partial?.removed ?? new Uint32Array(0),
    },
    publish: surface.publish,
  }
}
