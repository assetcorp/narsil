import type { FrozenSegment } from '../../core/partition/frozen'
import {
  fieldIndexRemapOf,
  mergeFieldLengths,
  mergePartialWords,
  mergeSurfaceForms,
  type SegmentSelection,
  selectionKeeps,
} from '../../core/partition/frozen/merge'
import { mergeFieldIndexes } from '../../core/partition/frozen/merge-fields'
import type { SegmentRemap } from '../../core/partition/frozen/merge-postings'
import type { TextAnalysis } from '../../core/partition/frozen/surface-slot'
import { encodeSurfaceTable } from '../../core/partition/frozen/surface-table'
import { wrapFrozenTokenTable } from '../../core/partition/frozen/token-table'
import { buildPartialWordTableFrom } from '../../core/partition/partial-words/registry'
import type { PartialWordAnalysis } from '../../core/partition/partial-words/spellings'
import { ErrorCodes, NarsilError } from '../../errors'
import { crc32, crc32Final, crc32Init, crc32Update } from '../../serialization/crc32'
import { engineVersionParts, requireWithinFileLimit } from '../../serialization/envelope-file'
import { HEADER_SIZE, writeHeader } from '../../serialization/header'
import {
  writeBooleanColumns,
  writeEnumColumns,
  writeFieldLengths,
  writeGeopointColumns,
  writePartialWords,
  writePatternColumns,
  writeSurfaceForms,
  writeValueColumns,
} from '../../serialization/keyword-segment/encode'
import { littleEndianBytes } from '../../serialization/keyword-segment/little-endian'
import { MessagePackChunks } from '../../serialization/keyword-segment/msgpack-chunks'
import type { SegmentWriteRecords } from '../../serialization/keyword-segment/types'
import type { DurableDirectory } from '../durability/durable-filesystem'
import { FILE_ASSEMBLY_CHUNK_BYTES } from './constants'
import {
  encodePagedSegmentHead,
  PAGED_SEGMENT_ENVELOPE_VERSION,
  type PlannedSection,
  SECTION_ALIGNMENT_BYTES,
  SEGMENT_PAGE_BYTES,
  type SectionName,
} from './format'
import { openRemovalWriter } from './removal-sort'
import { type FinishedSection, openSectionSink, type SectionSink } from './sink'
import { writeDocumentRows, writeIdOrder } from './write-documents'
import { writeMergedLists } from './write-lists'

const RESERVED_BYTES = 14
const RESIDENT_SECTION_ORDER: readonly SectionName[] = [
  'tokens',
  'tokenOffsets',
  'documentFrequencies',
  'postingOffsets',
  'blockLists',
  'blockListOffsets',
  'blockSummaries',
  'fieldLengths',
  'numeric',
  'sizes',
  'boolean',
  'enum',
  'geopoint',
  'pattern',
  'partialWords',
  'documentBlocks',
  'idSample',
]

export interface PagedSegmentWriteRequest {
  directory: DurableDirectory
  key: string
  schema: Record<string, string>
  tombstones: readonly string[]
  selections: readonly SegmentSelection[]
  partialWordAnalysis: PartialWordAnalysis | null
  textAnalysis: TextAnalysis | null
  writeRecords?: ReadonlyMap<FrozenSegment, SegmentWriteRecords>
  keepsWriteRecords?: boolean
}

export interface WrittenPagedSegment {
  bytes: number
  checksum: number
  documentCount: number
  tombstoneCount: number
}

function buildInputs(
  selections: readonly SegmentSelection[],
  fieldNames: string[],
): {
  inputs: SegmentRemap[]
  documentCount: number
} {
  let documentCount = 0
  const inputs = selections.map(selection => {
    const count = selection.segment.arrays.documentCount
    const remap = new Int32Array(count).fill(-1)
    for (let ordinal = 0; ordinal < count; ordinal++) {
      if (selectionKeeps(selection, ordinal)) {
        remap[ordinal] = documentCount
        documentCount += 1
      }
    }
    return { segment: selection.segment, remap, fieldIndexRemap: fieldIndexRemapOf(selection.segment, fieldNames) }
  })
  return { inputs, documentCount }
}

function postingUpperBound(inputs: readonly SegmentRemap[]): number {
  let total = 0
  for (const { segment } of inputs) {
    const { postingOffsets, tokenTable } = segment.arrays
    if (tokenTable.size > 0) {
      let largest = 0
      for (let at = 0; at < postingOffsets.length; at++) {
        if (postingOffsets[at] > largest) largest = postingOffsets[at]
      }
      total += largest
    }
  }
  return total
}

function onlyBytes(out: MessagePackChunks): Uint8Array {
  const joined = new Uint8Array(out.byteLength)
  let at = 0
  for (const chunk of out.chunks) {
    joined.set(chunk, at)
    at += chunk.byteLength
  }
  return joined
}

function keepsRecordsOf(request: PagedSegmentWriteRequest, inputs: readonly SegmentRemap[]): boolean {
  if (request.keepsWriteRecords === true || request.writeRecords !== undefined) return true
  return inputs.length > 0 && inputs.every(input => input.segment.paged?.writeRecordsHeld === true)
}

export async function writePagedSegment(request: PagedSegmentWriteRequest): Promise<WrittenPagedSegment> {
  const { directory, key } = request
  const fieldNames: string[] = []
  const { inputs, documentCount } = buildInputs(request.selections, fieldNames)
  const lengths = mergeFieldLengths(inputs, documentCount)
  const keepsRecords = keepsRecordsOf(request, inputs)
  const sinks: SectionSink[] = []
  const finished = new Map<SectionName, FinishedSection>()
  const residentBytes = new Map<SectionName, Uint8Array>()
  const temporaries: string[] = []

  async function sink(name: SectionName): Promise<SectionSink> {
    const temporaryKey = `${key}.part-${name}`
    temporaries.push(temporaryKey)
    const opened = await openSectionSink(directory, temporaryKey)
    sinks.push(opened)
    return opened
  }

  const postings = await sink('postings')
  const tokenTotals = await sink('tokenTotals')
  const tracksPositions = inputs.some(
    input => input.segment.paged?.snapshot.tracksPositions ?? input.segment.arrays.positionOffsets !== null,
  )
  const positionOffsets = tracksPositions ? await sink('positionOffsets') : null
  const positions = tracksPositions ? await sink('positions') : null
  const documents = await sink('documents')
  const ids = await sink('ids')
  const idOffsets = await sink('idOffsets')
  const idOrder = await sink('idOrder')
  const removalOffsets = await sink('removalOffsets')
  const removalValues = await sink('removals')
  const seqNos = keepsRecords ? await sink('seqNos') : null
  const primaryTerms = keepsRecords ? await sink('primaryTerms') : null
  const removals = await openRemovalWriter(directory, key, documentCount, postingUpperBound(inputs))

  const temporaryAssembly = `${key}.part-assembled`
  try {
    const lengthByName = new Map<string, Uint32Array>()
    for (let at = 0; at < lengths.fieldLengthNames.length; at++) {
      lengthByName.set(lengths.fieldLengthNames[at], lengths.fieldLengthColumns[at])
    }
    const columnsByField = fieldNames.map(name => lengthByName.get(name) ?? null)
    const columns = await writeMergedLists(
      inputs,
      columnsByField,
      { postings, tokenTotals, positionOffsets, positions },
      removals,
      false,
    )
    await removals.drain(async (offsets, values) => {
      await removalOffsets.write(littleEndianBytes(offsets))
      await removalValues.write(littleEndianBytes(values))
    })
    const documentBlocks = await writeDocumentRows(
      inputs,
      { documents, ids, idOffsets, seqNos, primaryTerms },
      request.writeRecords,
    )
    const idSample = await writeIdOrder(inputs, idOrder)

    const surfaces = mergeSurfaceForms(inputs, request.textAnalysis)
    const surfaceTable = surfaces === null ? null : encodeSurfaceTable(surfaces)
    if (surfaceTable !== null && surfaceTable.counts.length > 0) {
      const surfaceChunks = new MessagePackChunks()
      writeSurfaceForms(surfaceChunks, { surfaceTable })
      const surfaceForms = await sink('surfaceForms')
      await surfaceForms.write(onlyBytes(surfaceChunks))
    }

    const tokenCount = columns.tokenTable.documentFrequencies.length
    const partial = mergePartialWords(inputs, tokenCount, request.partialWordAnalysis)
    const partialTable =
      partial.reused ??
      (partial.spellings === null
        ? null
        : buildPartialWordTableFrom(partial.spellings, wrapFrozenTokenTable(columns.tokenTable)))
    const fields = mergeFieldIndexes(inputs)

    const resident = (name: SectionName, write: (out: MessagePackChunks) => void): void => {
      const out = new MessagePackChunks()
      write(out)
      residentBytes.set(name, onlyBytes(out))
    }
    residentBytes.set('tokens', columns.tokenTable.blob)
    residentBytes.set('tokenOffsets', littleEndianBytes(columns.tokenTable.offsets))
    residentBytes.set('documentFrequencies', littleEndianBytes(columns.tokenTable.documentFrequencies))
    residentBytes.set('postingOffsets', littleEndianBytes(columns.postingOffsets))
    residentBytes.set('blockLists', littleEndianBytes(columns.blockLists))
    residentBytes.set('blockListOffsets', littleEndianBytes(columns.blockListOffsets))
    residentBytes.set('blockSummaries', columns.blockSummaries)
    resident('fieldLengths', out => writeFieldLengths(out, lengths))
    resident('numeric', out => writeValueColumns(out, fields.numeric))
    resident('sizes', out => writeValueColumns(out, fields.sizes))
    resident('boolean', out => writeBooleanColumns(out, fields.boolean))
    resident('enum', out => writeEnumColumns(out, fields.enums))
    resident('geopoint', out => writeGeopointColumns(out, fields.geo))
    resident('pattern', out => writePatternColumns(out, fields.pattern))
    resident('partialWords', out => writePartialWords(out, { partialWords: partialTable }))
    residentBytes.set('documentBlocks', documentBlocks)
    residentBytes.set('idSample', idSample)

    for (const opened of sinks) {
      const done = await opened.finish()
      const name = done.temporaryKey.slice(`${key}.part-`.length) as SectionName
      finished.set(name, done)
    }

    const planned: PlannedSection[] = []
    for (const name of RESIDENT_SECTION_ORDER) {
      const bytes = residentBytes.get(name)
      if (bytes === undefined) continue
      planned.push({ name, length: bytes.byteLength, checksums: checksumsOfPages(bytes) })
    }
    for (const [name, done] of finished) planned.push({ name, length: done.length, checksums: done.checksums })

    const encoded = encodePagedSegmentHead(
      { schema: request.schema, tombstones: [...request.tombstones], documentCount, fieldNames },
      planned,
    )
    requireWithinFileLimit(HEADER_SIZE + encoded.payloadLength, `segment "${key}"`)

    await directory.remove(temporaryAssembly)
    temporaries.push(temporaryAssembly)
    const assembly = await directory.appendHandle(temporaryAssembly)
    let state = crc32Init()
    let cursor = 0
    const appendPayload = async (bytes: Uint8Array): Promise<void> => {
      state = crc32Update(state, bytes)
      await assembly.append(bytes)
      cursor += bytes.byteLength
    }
    const alignTo = async (offset: number): Promise<void> => {
      if (offset < cursor || offset - cursor >= SECTION_ALIGNMENT_BYTES) {
        throw new NarsilError(
          ErrorCodes.PERSISTENCE_SAVE_FAILED,
          `Section offset ${offset} of "${key}" does not follow byte ${cursor}`,
          { key, offset, cursor },
        )
      }
      if (offset > cursor) await appendPayload(new Uint8Array(offset - cursor))
    }
    try {
      await assembly.append(new Uint8Array(HEADER_SIZE))
      await appendPayload(encoded.prefix)
      await appendPayload(encoded.head)
      for (const section of encoded.sections) {
        await alignTo(section.offset)
        const name = section.name as SectionName
        const heldBytes = residentBytes.get(name)
        if (heldBytes !== undefined) {
          await appendPayload(heldBytes)
          continue
        }
        const done = finished.get(name)
        if (done === undefined) {
          throw new NarsilError(
            ErrorCodes.PERSISTENCE_SAVE_FAILED,
            `Section "${name}" of "${key}" holds no written bytes`,
            { key, section: name },
          )
        }
        await copySection(directory, done, appendPayload)
      }
      await assembly.sync()
    } finally {
      await assembly.close()
    }
    const checksum = crc32Final(state)
    const [major, minor, patch] = engineVersionParts()
    const header = writeHeader({
      magic: 'NRSL',
      envelopeFormatVersion: PAGED_SEGMENT_ENVELOPE_VERSION,
      engineVersionMajor: major,
      engineVersionMinor: minor,
      engineVersionPatch: patch,
      payloadLength: encoded.payloadLength,
      flags: {
        compressionEnabled: false,
        compressionAlgorithm: 'none',
        checksumPresent: true,
        encryptionEnabled: false,
      },
      checksum,
      reserved: new Uint8Array(RESERVED_BYTES),
    })
    const patched = await directory.markerHandle(temporaryAssembly)
    try {
      await patched.writeSlot(0, header)
    } finally {
      await patched.close()
    }
    await directory.move(temporaryAssembly, key)
    await directory.syncDirectoryOf(key)
    return {
      bytes: HEADER_SIZE + encoded.payloadLength,
      checksum,
      documentCount,
      tombstoneCount: request.tombstones.length,
    }
  } catch (error) {
    await removals.abandon()
    throw error
  } finally {
    for (const opened of sinks) await opened.abandon().catch(() => undefined)
    for (const temporaryKey of temporaries) await directory.remove(temporaryKey).catch(() => undefined)
  }
}

function checksumsOfPages(bytes: Uint8Array): Uint8Array {
  const pages = Math.ceil(bytes.byteLength / SEGMENT_PAGE_BYTES)
  const checksums = new Uint8Array(pages * 4)
  const view = new DataView(checksums.buffer)
  for (let page = 0; page < pages; page++) {
    const from = page * SEGMENT_PAGE_BYTES
    view.setUint32(page * 4, crc32(bytes.subarray(from, Math.min(from + SEGMENT_PAGE_BYTES, bytes.byteLength))), true)
  }
  return checksums
}

async function copySection(
  directory: DurableDirectory,
  section: FinishedSection,
  append: (bytes: Uint8Array) => Promise<void>,
): Promise<void> {
  const { readRange } = directory
  if (readRange === undefined) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'A paged segment requires a directory that reads ranges')
  }
  for (let at = 0; at < section.length; at += FILE_ASSEMBLY_CHUNK_BYTES) {
    const size = Math.min(FILE_ASSEMBLY_CHUNK_BYTES, section.length - at)
    await append(await readRange.call(directory, section.temporaryKey, at, size))
  }
}
