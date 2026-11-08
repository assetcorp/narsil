import type {
  NativeFieldTokens,
  NativeGrowingSegment,
  NativeRunTable,
  NativeSliceAllocator,
  NativeSurfaceTable,
} from '../../vector/native/types/segments'
import type { NativeTermTable } from '../../vector/native/types/terms'
import { regionsOverlap } from '../regions'
import { typedRegion } from '../stored-values/regions'
import { requireSegment } from './status'

type RegionKind = Parameters<typeof typedRegion>[1]

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

  read<K extends RegionKind>(input: unknown, kind: K, length?: number, writable = true) {
    const value = typedRegion(input, kind)
    requireSegment(value !== null && (length === undefined || value.length === length))
    if (writable) this.writes.push(value)
    else this.reads.push(value)
    return value
  }

  check(): void {
    const buffers = new Map<ArrayBufferLike, number>()
    for (let at = 0; at < this.writes.length; at++) {
      const region = this.writes[at]
      if (region.byteLength === 0) continue
      const held = buffers.get(region.buffer)
      if (held === undefined) buffers.set(region.buffer, at)
      else
        for (let previous = held; previous < at; previous++)
          requireSegment(!regionsOverlap(region, this.writes[previous]))
    }
    for (const region of this.reads) {
      const held = buffers.get(region.buffer)
      if (held === undefined) continue
      for (let output = held; output < this.writes.length; output++)
        requireSegment(!regionsOverlap(region, this.writes[output]))
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

function readSegment(input: NativeGrowingSegment, regions: Regions): NativeGrowingSegment {
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
  const surfaces = input.surfaces === null ? null : surface(input.surfaces, regions)
  const spellingStrings = input.spellings === null ? null : surface(input.spellings, regions)
  const spellings =
    input.spellings === null || spellingStrings === null
      ? null
      : {
          ...spellingStrings,
          codePoints: regions.read(input.spellings.codePoints, 'Uint32Array', spellingStrings.token.length),
          runs: runs(input.spellings.runs, regions),
        }
  const partialFields = regions.read(input.partialFields, 'Uint8Array', undefined, false)
  requireSegment(partialFields.length <= 65536)
  for (const flag of partialFields) requireSegment(flag <= 1 && (flag === 0 || spellings !== null))
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

function checkText(units: Uint16Array, start: number, length: number): void {
  requireSegment(length <= 0x40000000 && start <= units.length && length <= units.length - start)
  const end = start + length
  for (let at = start; at < end; at++) {
    const unit = units[at]
    if (unit < 0xd800 || unit >= 0xe000) continue
    requireSegment(unit < 0xdc00 && ++at < end)
    requireSegment(units[at] >= 0xdc00 && units[at] < 0xe000)
  }
}

export function readRequest(input: NativeGrowingSegment, ordinal: number, rawFields: readonly NativeFieldTokens[]) {
  const captured = captureSegment(input)
  requireSegment(Array.isArray(rawFields) && rawFields.length <= 65536)
  const fields = rawFields.map(copy)
  const regions = new Regions()
  const segment = readSegment(captured, regions)
  requireSegment(Number.isInteger(ordinal) && ordinal >= 0 && ordinal < segment.ordinalCapacity)
  requireSegment(fields.length <= segment.partialFields.length)
  let previous = -1
  for (const field of fields) {
    requireSegment(
      Number.isInteger(field.field) && field.field > previous && field.field < segment.partialFields.length,
    )
    field.tokens = regions.read(field.tokens, 'Uint32Array', undefined, false)
    field.units = regions.read(field.units, 'Uint16Array', undefined, false)
    requireSegment(field.units.length <= 0xffffffff)
    requireSegment(field.tokens.length % 8 === 0 && field.tokens.length / 8 <= 0xffffffff)
    for (let at = 0; at < field.tokens.length; at += 8) {
      checkText(field.units, field.tokens[at + 1], field.tokens[at + 2])
      if (field.tokens[at + 3] !== 0xffffffff) checkText(field.units, field.tokens[at + 3], field.tokens[at + 4])
    }
    previous = field.field
  }
  regions.check()
  return { segment, fields }
}

export function readBatch(input: NativeGrowingSegment): NativeGrowingSegment {
  const captured = captureSegment(input)
  const regions = new Regions()
  const segment = readSegment(captured, regions)
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
