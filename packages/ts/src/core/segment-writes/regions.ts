import type {
  NativeGrowingSegment,
  NativeRunTable,
  NativeSliceAllocator,
  NativeSurfaceTable,
} from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import { typedRegion } from '../stored-values/regions'
import { requireSegment } from './status'

type RegionKind = Parameters<typeof typedRegion>[1]

export interface SegmentReach {
  readonly surfaces: boolean
  spellings(partialFields: Uint8Array): boolean
}

const WHOLE_SEGMENT: SegmentReach = { surfaces: true, spellings: () => true }

function copy<T extends object>(input: T): T {
  requireSegment(typeof input === 'object' && input !== null)
  return { ...input }
}

function copySurface(input: NativeSurfaceTable): NativeSurfaceTable {
  const table = copy(input)
  return { ...table, strings: copy(table.strings) }
}

export function captureSegment(input: NativeGrowingSegment): NativeGrowingSegment {
  const segment = copy(input)
  const spellings = segment.spellings === null ? null : copy(segment.spellings)
  return {
    ...segment,
    terms: copy(segment.terms),
    columns: copy(segment.columns),
    postings: copy(segment.postings),
    positions: segment.positions === null ? null : copy(segment.positions),
    surfaces: segment.surfaces === null ? null : copySurface(segment.surfaces),
    spellings:
      spellings === null ? null : { ...spellings, strings: copy(spellings.strings), runs: copy(spellings.runs) },
  }
}

class Regions {
  readonly writes: ArrayBufferView[] = []
  readonly reads: ArrayBufferView[] = []
  private readonly buffers: ArrayBufferLike[] = []
  private readonly starts: number[] = []
  private readonly ends: number[] = []
  private readonly writable: boolean[] = []

  read<K extends RegionKind>(input: unknown, kind: K, length?: number, writable = true) {
    const value = typedRegion(input, kind)
    requireSegment(value !== null && (length === undefined || value.length === length))
    if (writable) this.writes.push(value)
    else this.reads.push(value)
    const byteLength = value.byteLength
    if (byteLength > 0) {
      const start = value.byteOffset
      this.buffers.push(value.buffer)
      this.starts.push(start)
      this.ends.push(start + byteLength)
      this.writable.push(writable)
    }
    return value
  }

  check(): void {
    const { buffers, starts, ends, writable } = this
    for (let at = 1; at < buffers.length; at++) {
      const buffer = buffers[at]
      const start = starts[at]
      const end = ends[at]
      const writes = writable[at]
      for (let previous = 0; previous < at; previous++)
        if (
          buffers[previous] === buffer &&
          (writes || writable[previous]) &&
          start < ends[previous] &&
          starts[previous] < end
        )
          requireSegment(false)
    }
  }
}

function table(input: NativeTermTable, regions: Regions): NativeTermTable {
  const header = regions.read(input.header, 'Uint32Array', 8)
  const slots = regions.read(input.slots, 'Int32Array')
  const termOffset = regions.read(input.termOffset, 'Uint32Array')
  const termLength = regions.read(input.termLength, 'Uint32Array', termOffset.length)
  const firstUnitNext = regions.read(input.firstUnitNext, 'Uint32Array', termOffset.length)
  const firstUnitHead = regions.read(input.firstUnitHead, 'Uint32Array', 65536)
  const units = regions.read(input.units, 'Uint16Array')
  requireSegment(
    slots.length >= 2 &&
      slots.length <= 0x80000000 &&
      (slots.length & (slots.length - 1)) === 0 &&
      termOffset.length <= 0x7fffffff &&
      header[0] <= termOffset.length &&
      header[1] <= header[0] &&
      header[2] === slots.length &&
      header[4] <= units.length &&
      units.length <= 0xffffffff,
  )
  return { header, slots, termOffset, termLength, firstUnitNext, firstUnitHead, units }
}

function allocator(input: NativeSliceAllocator, regions: Regions): NativeSliceAllocator {
  const sliceCapacities = regions.read(input.sliceCapacities, 'Uint32Array', undefined, false)
  requireSegment(sliceCapacities.length > 0 && sliceCapacities.length <= 255)
  return {
    allocation: regions.read(input.allocation, 'Uint32Array', 2),
    freeHeads: regions.read(input.freeHeads, 'Uint32Array', sliceCapacities.length),
    sliceCapacities,
  }
}

function surface(input: NativeSurfaceTable, regions: Regions): NativeSurfaceTable {
  const strings = table(input.strings, regions)
  const token = regions.read(input.token, 'Uint32Array', strings.termOffset.length)
  const count = regions.read(input.count, 'Uint32Array', token.length)
  return { strings, token, count }
}

function runs(input: NativeRunTable, regions: Regions): NativeRunTable {
  const header = regions.read(input.header, 'Uint32Array', 8)
  const slots = regions.read(input.slots, 'Int32Array')
  const listStart = regions.read(input.listStart, 'Uint32Array')
  const members = regions.read(input.members, 'Uint32Array')
  requireSegment(members.length <= 0xffffffff)
  requireSegment(
    listStart.length <= 0x7fffffff &&
      slots.length >= 2 &&
      slots.length <= 0x80000000 &&
      (slots.length & (slots.length - 1)) === 0 &&
      header[0] <= listStart.length &&
      header[2] === slots.length,
  )
  return {
    header,
    slots,
    listStart,
    runs: regions.read(input.runs, 'Uint32Array', listStart.length * 3),
    listLength: regions.read(input.listLength, 'Uint32Array', listStart.length),
    listClass: regions.read(input.listClass, 'Uint8Array', listStart.length),
    members,
    ...allocator(input, regions),
  }
}

function readSegment(
  input: NativeGrowingSegment,
  regions: Regions,
  reach: SegmentReach = WHOLE_SEGMENT,
): NativeGrowingSegment {
  requireSegment(
    Number.isInteger(input.ordinalCapacity) && input.ordinalCapacity >= 0 && input.ordinalCapacity <= 0xffffffff,
  )
  const terms = table(input.terms, regions)
  const capacity = terms.termOffset.length
  const source = input.columns
  const columns = {
    sliceStart: regions.read(source.sliceStart, 'Uint32Array', capacity),
    sliceClass: regions.read(source.sliceClass, 'Uint8Array', capacity),
    lengths: regions.read(source.lengths, 'Uint32Array', capacity),
    docFrequency: regions.read(source.docFrequency, 'Uint32Array', capacity),
    deadDocuments: regions.read(source.deadDocuments, 'Uint32Array', capacity),
    totalTermFrequency: regions.read(source.totalTermFrequency, 'Float64Array', capacity),
    surfaceOccurrences: regions.read(source.surfaceOccurrences, 'Float64Array', capacity),
    revision: regions.read(source.revision, 'Uint32Array', capacity),
    flags: regions.read(source.flags, 'Uint8Array', capacity),
  }
  const pool = input.postings
  const docs = regions.read(pool.docIds, 'Uint32Array')
  requireSegment(docs.length <= 0xffffffff)
  const postings = {
    docIds: docs,
    frequencies: regions.read(pool.frequencies, 'Uint16Array', docs.length),
    fieldIndices: regions.read(pool.fieldIndices, 'Uint16Array', docs.length),
    positionStarts: pool.positionStarts === null ? null : regions.read(pool.positionStarts, 'Uint32Array', docs.length),
    ...allocator(pool, regions),
  }
  const positions =
    input.positions === null
      ? null
      : {
          values: regions.read(input.positions.values, 'Uint32Array'),
          allocation: regions.read(input.positions.allocation, 'Uint32Array', 2),
        }
  requireSegment(positions === null || postings.positionStarts !== null)
  requireSegment(positions === null || positions.values.length <= 0xffffffff)
  const partialFields = regions.read(input.partialFields, 'Uint8Array', undefined, false)
  requireSegment(partialFields.length <= 65536)
  for (const flag of partialFields) requireSegment(flag <= 1 && (flag === 0 || input.spellings !== null))
  const surfaces = input.surfaces === null || !reach.surfaces ? null : surface(input.surfaces, regions)
  const spellingStrings =
    input.spellings === null || !reach.spellings(partialFields) ? null : surface(input.spellings, regions)
  const spellings =
    input.spellings === null || spellingStrings === null
      ? null
      : {
          ...spellingStrings,
          codePoints: regions.read(input.spellings.codePoints, 'Uint32Array', spellingStrings.token.length),
          runs: runs(input.spellings.runs, regions),
        }
  const ordinalCapacity = input.ordinalCapacity
  return {
    terms,
    columns,
    postings,
    positions,
    surfaces,
    spellings,
    partialFields,
    ordinalCapacity,
    retired: regions.read(input.retired, 'Uint32Array', Math.max(1, Math.ceil(ordinalCapacity / 32))),
    fieldLengths: regions.read(input.fieldLengths, 'Uint32Array', ordinalCapacity * partialFields.length),
    totalDocuments: regions.read(input.totalDocuments, 'Uint32Array', 1),
    totalFieldLengths: regions.read(input.totalFieldLengths, 'Float64Array', partialFields.length),
  }
}

export function checkText(units: Uint16Array, start: number, length: number): void {
  requireSegment(length <= 0x40000000 && start <= units.length && length <= units.length - start)
  const end = start + length
  for (let at = start; at < end; at++) {
    const unit = units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    requireSegment(unit < 0xdc00 && ++at < end)
    requireSegment(units[at] >= 0xdc00 && units[at] < 0xe000)
  }
}

export type SegmentRetirement = Pick<
  NativeGrowingSegment,
  'ordinalCapacity' | 'partialFields' | 'retired' | 'fieldLengths' | 'totalDocuments' | 'totalFieldLengths'
>

export function readRetirementRegions(input: NativeGrowingSegment): SegmentRetirement {
  requireSegment(typeof input === 'object' && input !== null)
  const ordinalCapacity = input.ordinalCapacity
  requireSegment(Number.isInteger(ordinalCapacity) && ordinalCapacity >= 0 && ordinalCapacity <= 0xffffffff)
  const regions = new Regions()
  const partialFields = regions.read(input.partialFields, 'Uint8Array', undefined, false)
  requireSegment(partialFields.length <= 65536)
  const segment = {
    ordinalCapacity,
    partialFields,
    retired: regions.read(input.retired, 'Uint32Array', Math.max(1, Math.ceil(ordinalCapacity / 32))),
    fieldLengths: regions.read(input.fieldLengths, 'Uint32Array', ordinalCapacity * partialFields.length),
    totalDocuments: regions.read(input.totalDocuments, 'Uint32Array', 1),
    totalFieldLengths: regions.read(input.totalFieldLengths, 'Float64Array', partialFields.length),
  }
  regions.check()
  return segment
}

export function readSegmentRegions(input: NativeGrowingSegment, reach: SegmentReach = WHOLE_SEGMENT) {
  const captured = captureSegment(input)
  const regions = new Regions()
  const segment = readSegment(captured, regions, reach)
  return { segment, regions }
}

export function readBatch(input: NativeGrowingSegment): NativeGrowingSegment {
  const { segment, regions } = readSegmentRegions(input)
  regions.check()
  return segment
}

export function readMergeSegment(input: NativeGrowingSegment): {
  segment: NativeGrowingSegment
  arrays: ArrayBufferView[]
} {
  const regions = new Regions()
  const segment = readSegment(input, regions)
  regions.check()
  return { segment, arrays: [...regions.reads, ...regions.writes] }
}
