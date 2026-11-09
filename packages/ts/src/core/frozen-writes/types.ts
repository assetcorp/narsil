import type {
  NativeFrozenPagedRemovals,
  NativeFrozenSegment,
  NativeFrozenSegmentState,
} from '../../vector/native/types/frozen-segments'
import type { NativeFieldTokens } from '../../vector/native/types/segments'

export interface FrozenPagedRemovals {
  native(): NativeFrozenPagedRemovals | null
  read(ordinal: number): Uint32Array
  fail(status: number): never
}

export type RemoveFrozenDocument = (
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
  paged: FrozenPagedRemovals | null,
) => number

export type PrepareFrozenRemoval = (
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  ordinal: number,
  fields: readonly NativeFieldTokens[],
  entries: Uint32Array,
  values: Float64Array,
  paged: FrozenPagedRemovals | null,
) => number

export type GrowFrozenRemovalRegions = (
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  fields: readonly NativeFieldTokens[],
) => void

export type SettleFrozenState = (
  segment: NativeFrozenSegment,
  state: NativeFrozenSegmentState,
  paged: FrozenPagedRemovals | null,
) => number
