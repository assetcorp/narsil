import type { NativeGrowingSegment } from '../../vector/native/types/segments'
import type { PreparedSegmentField } from './prepared-tokens'

export type RemoveSegmentDocument = (
  input: NativeGrowingSegment,
  generation: number,
  ordinal: number,
  fields: readonly PreparedSegmentField[],
) => number

let bound: RemoveSegmentDocument | null = null

export function bindSegmentRemoval(removal: RemoveSegmentDocument): void {
  bound = removal
}

export const removeDocument: RemoveSegmentDocument = (...args) => {
  if (bound === null) throw new Error('The engine reached write code before it loaded that code')
  return bound(...args)
}
