import type { NativeFieldMergeRegion, NativeFieldMergeSource } from '../../vector/native/types/field-merge'
import { regionsOverlap } from '../regions'
import { requireSegment, SegmentRefusal } from '../segment-writes/status'
import { typedRegion } from '../stored-values/regions'

type RegionKind = 'Uint8Array' | 'Uint16Array' | 'Uint32Array' | 'Float64Array' | 'BigUint64Array'

export function regionKinds(kind: number): readonly RegionKind[] {
  switch (kind) {
    case 1:
      return ['Float64Array', 'Uint32Array']
    case 2:
      return ['Uint32Array', 'Uint32Array']
    case 3:
      return ['Uint16Array', 'Uint32Array', 'Uint32Array', 'Uint32Array', 'Uint32Array']
    case 4:
      return ['BigUint64Array', 'Float64Array', 'Float64Array', 'Uint32Array']
    case 5:
      return [
        'Uint8Array',
        'Uint32Array',
        'Uint8Array',
        'Float64Array',
        'Uint32Array',
        'Uint32Array',
        'Uint16Array',
        'Uint8Array',
      ]
    case 6:
      return ['Uint32Array', 'Uint32Array', 'Uint32Array', 'Uint32Array']
    default:
      throw new SegmentRefusal(1)
  }
}

export function uint32(value: number): void {
  requireSegment(Number.isInteger(value) && value >= 0 && value <= 0xffffffff)
}

export function embedded(valid: boolean): asserts valid {
  if (!valid) throw new SegmentRefusal(5)
}

export function capture(sources: readonly NativeFieldMergeSource[]): NativeFieldMergeSource[] {
  requireSegment(Array.isArray(sources))
  return sources.map(source => {
    requireSegment(source !== null && typeof source === 'object')
    const mapping = source.mapping
    const regions = source.regions
    requireSegment(Array.isArray(regions))
    return { mapping, regions: [...regions] }
  })
}

export function readRegions(regions: readonly NativeFieldMergeRegion[], kind: number): NativeFieldMergeRegion[] {
  const types = regionKinds(kind)
  requireSegment(Array.isArray(regions) && regions.length === types.length)
  return types.map((type, at) => {
    const region = typedRegion(regions[at], type)
    requireSegment(region !== null && region.length <= 0xffffffff)
    return region
  })
}

export function readSources(sources: readonly NativeFieldMergeSource[], kind: number): NativeFieldMergeSource[] {
  return sources.map(source => {
    const mapping = typedRegion(source.mapping, 'Uint32Array')
    requireSegment(mapping !== null && mapping.length <= 0xffffffff)
    const regions = readRegions(source.regions, kind)
    const count = mapping.length
    const words = Math.max(1, Math.ceil(count / 32))
    switch (kind) {
      case 1:
        requireSegment(regions[0].length === regions[1].length)
        break
      case 2:
        requireSegment(regions[0].length >= words && regions[1].length >= words)
        break
      case 3:
        requireSegment(
          regions[1].length > 0 &&
            regions[2].length === regions[1].length &&
            regions[4].length === regions[1].length - 1,
        )
        break
      case 4:
        requireSegment(
          regions[0].length === regions[1].length &&
            regions[0].length === regions[2].length &&
            regions[0].length === regions[3].length,
        )
        break
      case 5:
        requireSegment(
          regions[0].length === count &&
            regions[1].length === count + 1 &&
            regions[2].length === regions[3].length &&
            regions[2].length === regions[4].length &&
            regions[2].length === regions[5].length,
        )
        break
      case 6:
        requireSegment(regions[1].length % 3 === 0 && regions[2].length === regions[1].length / 3 + 1)
    }
    return { mapping, regions }
  })
}

export function checkOverlap(
  sources: readonly NativeFieldMergeSource[],
  outputs: readonly NativeFieldMergeRegion[],
): void {
  for (let at = 0; at < outputs.length; at++) {
    for (let before = 0; before < at; before++) requireSegment(!regionsOverlap(outputs[at], outputs[before]))
    for (const source of sources) {
      requireSegment(!regionsOverlap(outputs[at], source.mapping))
      for (const region of source.regions) requireSegment(!regionsOverlap(outputs[at], region))
    }
  }
}

export function words(source: NativeFieldMergeSource, at: number): Uint32Array {
  return source.regions[at] as Uint32Array
}

export function numbers(source: NativeFieldMergeSource, at: number): Float64Array {
  return source.regions[at] as Float64Array
}

export interface MergeDocument {
  source: NativeFieldMergeSource
  ordinal: number
}

export interface FieldMergePlan {
  lengths: Uint32Array
  publish(output: readonly NativeFieldMergeRegion[]): void
}

export function documentsOf(sources: readonly NativeFieldMergeSource[], count: number): MergeDocument[] {
  const documents: MergeDocument[] = new Array(count)
  let kept = 0
  for (const source of sources) {
    for (let ordinal = 0; ordinal < source.mapping.length; ordinal++) {
      const target = source.mapping[ordinal]
      if (target === 0xffffffff) continue
      requireSegment(target < count && documents[target] === undefined)
      documents[target] = { source, ordinal }
      kept++
    }
  }
  requireSegment(kept === count)
  return documents
}
