import { ErrorCodes, NarsilError } from '../../errors'
import type {
  NativeFieldMergeCore,
  NativeFieldMergeRegion,
  NativeFieldMergeSource,
} from '../../vector/native/types/field-merge'
import { regionKinds } from './regions'

const allocations = {
  Uint8Array: (length: number) => new Uint8Array(length),
  Uint16Array: (length: number) => new Uint16Array(length),
  Uint32Array: (length: number) => new Uint32Array(length),
  Float64Array: (length: number) => new Float64Array(length),
  BigUint64Array: (length: number) => new BigUint64Array(length),
}

function accept(status: number): void {
  if (status !== 0)
    throw new NarsilError(ErrorCodes.PARTITION_CORRUPTED, 'The field regions refused a segment merge', { status })
}

export function mergeFieldRegionsWith(
  kind: number,
  sources: readonly NativeFieldMergeSource[],
  count: number,
  { measureFieldMerge, writeFieldMerge }: NativeFieldMergeCore,
): NativeFieldMergeRegion[] {
  const sizes = new Uint32Array(8)
  accept(measureFieldMerge(kind, sources, count, sizes))
  const output = regionKinds(kind).map((type, at) => allocations[type](sizes[at]))
  accept(writeFieldMerge(kind, sources, count, output))
  return output
}
