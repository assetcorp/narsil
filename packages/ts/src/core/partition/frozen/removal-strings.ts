import type { NativeFrozenSegment, NativeFrozenSegmentState } from '../../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../../vector/native/types/segments'
import { PreparedTokens, packedTokens } from '../../segment-writes/prepared-tokens'
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
const FIELD_TOKEN_WORDS = 8

function changedSurfaces(fields: readonly NativeFieldTokens[]): string[] {
  const spellings: string[] = []
  for (const { tokens, units } of fields) {
    for (let at = 0; at < tokens.length; at += FIELD_TOKEN_WORDS) {
      if (tokens[at + 3] === NO_SURFACE || tokens[at + 4] === 0) continue
      const surface = storedText(units, tokens[at + 3], tokens[at + 4])
      if (surface !== storedText(units, tokens[at + 1], tokens[at + 2])) spellings.push(surface)
    }
  }
  return spellings
}

export function prepareFrozenStrings(
  fieldNames: readonly string[],
  ordinal: number,
  text: PreparedText,
  surfaces: FrozenSurfaceSlot,
  partialWords: FrozenPartialWordSlot,
): { core: FrozenStringRemoval; publish(): void } {
  const fields: NativeFieldTokens[] = []
  const partial = partialWords.removalState()
  for (let field = 0; field < fieldNames.length; field++) {
    const words = text.removalSpellings?.get(fieldNames[field])
    if (words !== undefined) {
      const records = new PreparedTokens()
      let position = 0
      const isPartial = partial?.table.fields.includes(fieldNames[field]) === true
      for (const [written, value] of words) {
        let spelling = written
        let token = isPartial ? partialWords.tokenForSpelling(written) : undefined
        if (token === undefined && isPartial && value.normalized !== null) {
          token = partialWords.tokenForSpelling(value.normalized)
          if (token !== undefined) spelling = value.normalized
        }
        token ??= surfaces.tokenOf(written)
        if (token === undefined) continue
        for (let count = 0; count < value.count; count++)
          records.add(token, position++, spelling === token ? undefined : spelling)
      }
      fields.push({ field, ...packedTokens(records.finish()) })
      continue
    }
    const prepared = text.fields.get(fieldNames[field])
    if (prepared === undefined) continue
    fields.push({ field, ...packedTokens(prepared.records) })
  }
  const surface = surfaces.prepareCoreRemoval(ordinal, changedSurfaces(fields))
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
