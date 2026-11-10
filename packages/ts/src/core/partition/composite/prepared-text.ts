import { removedSurfaceSpellings } from '../frozen/removal-text'
import {
  addRemovedSpelling,
  beginRemovedSpellings,
  finishRemovedSpellings,
  type RemovedSpellings,
} from '../frozen/removed-spellings'
import { type PreparedText, preparedSurfaces } from '../prepared-text'
import type { PartitionInsertOptions } from '../utils'

export function preparedRemovedSpellings(before: PreparedText | undefined): RemovedSpellings | undefined {
  if (before === undefined) return undefined
  if (before.removalSpellings !== undefined) return removedSurfaceSpellings(before)
  beginRemovedSpellings()
  for (const field of before.fields.values())
    for (const [spelling, value] of preparedSurfaces(field))
      if (spelling !== value.token) addRemovedSpelling(spelling, value.count)
  return finishRemovedSpellings()
}

export function withPreviousText(
  options: PartitionInsertOptions | undefined,
  before: PreparedText | undefined,
): PartitionInsertOptions | undefined {
  return before === undefined
    ? options
    : {
        ...options,
        preparedText: { ...options?.preparedText, before },
        onPreparedText: change => options?.onPreparedText?.({ ...change, before }),
      }
}
