import { decode } from '@msgpack/msgpack'
import {
  assemblePagedFrozenSegment,
  type FrozenSegment,
  type FrozenSegmentSource,
  type PagedSegmentAccess,
} from '../../core/partition/frozen'
import { createEncodedDocumentSource } from '../../core/partition/frozen/document-source'
import type { PagedSegmentSnapshot } from '../../core/partition/frozen/paged-snapshot'
import { decodeSurfaceTable, type SurfaceTableData } from '../../core/partition/frozen/surface-table'
import { wrapFrozenTokenTable } from '../../core/partition/frozen/token-table'
import { ErrorCodes, NarsilError } from '../../errors'
import { decodeSurfaceForms } from '../../serialization/keyword-segment/decode-columns'
import { createPagedLiveCounts } from './counts'
import { createDocumentBlockReader } from './documents'
import { type FileSection, loadFailed, sectionNamed } from './format'
import { createPagedIdTable } from './ids'
import { createListReader, createPagedPostingViews } from './lists'
import { type ReadCache, readCacheOfThisThread } from './read-cache'
import { residentBytesOf } from './resident'
import {
  closePagedFile,
  createSectionReader,
  openPagedFile,
  relocatePagedFile,
  type SectionReader,
} from './section-file'
import { createSurfaceTableReader } from './surface-candidates'
import { termFrequenciesAcross } from './term-frequencies'

function onlyMergesThroughTheFile(column: string): never {
  throw new NarsilError(
    ErrorCodes.PARTITION_CORRUPTED,
    `A paged segment holds "${column}" in its file, so a caller must read it through the segment's paged access`,
    { column },
  )
}

function readUint64(section: SectionReader, ordinal: number): number {
  const bytes = section.bytesAt(ordinal * 8, 8)
  const value = new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true)
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) loadFailed(`A write record of document ${ordinal} lies above 2^53 - 1`)
  return Number(value)
}

export function createPagedFrozenSegment(
  snapshot: PagedSegmentSnapshot,
  cache: ReadCache = readCacheOfThisThread(),
): FrozenSegment {
  const file = openPagedFile(snapshot.path, cache)
  const sections = snapshot.sections as FileSection[]

  function reader(name: string): SectionReader | null {
    const section = sectionNamed(sections, name)
    return section === undefined ? null : createSectionReader(file, section)
  }

  function required(name: string): SectionReader {
    const section = reader(name)
    if (section === null) loadFailed(`The segment "${snapshot.key}" holds no section "${name}"`, { section: name })
    return section
  }

  const tokenTable = wrapFrozenTokenTable(snapshot.tokenTable)
  const idTable = createPagedIdTable(snapshot, required('ids'), required('idOffsets'), required('idOrder'))
  const lists = createListReader(file, snapshot, reader)
  const documents = createDocumentBlockReader(snapshot, required('documents'), cache, file.fileNumber)
  const removalOffsets = required('removalOffsets')
  const removals = required('removals')
  const surfaceSection = reader('surfaceForms')
  const seqNos = reader('seqNos')
  const primaryTerms = reader('primaryTerms')
  const resident = residentBytesOf(snapshot)

  function readSurfaceTable(): SurfaceTableData | null {
    if (surfaceSection === null) return null
    let raw: unknown
    try {
      raw = decode(surfaceSection.whole())
    } catch (error) {
      loadFailed(
        `Section "surfaceForms" of "${snapshot.key}" is not MessagePack: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    return decodeSurfaceForms(raw, { documentCount: snapshot.documentCount, shared: false })
  }

  const access: PagedSegmentAccess = {
    key: snapshot.key,
    snapshot,
    writeRecordsHeld: seqNos !== null && primaryTerms !== null,
    listAt: lists.listAt,
    positionsAt: lists.positionsAt,
    encodedDocumentAt: documents.encodedDocumentAt,
    writeRecordAt(ordinal: number) {
      if (seqNos === null || primaryTerms === null) return { seqNo: 0, primaryTerm: 0 }
      return { seqNo: readUint64(seqNos, ordinal), primaryTerm: readUint64(primaryTerms, ordinal) }
    },
    heldBytes(segment) {
      return (
        resident +
        cache.bytesOfFile(file.fileNumber) +
        segment.removalBytes() +
        segment.surfaces.heldBytes() +
        (segment.vectorOrdinalMaps?.bytes ?? 0)
      )
    },
    termFrequenciesAcross,
    close() {
      cache.forgetFile(file.fileNumber)
      closePagedFile(file)
    },
    relocate(rewrite) {
      relocatePagedFile(file, rewrite(file.path))
      snapshot.path = file.path
    },
  }

  const source: FrozenSegmentSource = {
    documentCount: snapshot.documentCount,
    fieldNames: snapshot.fieldNames,
    fieldLengthNames: snapshot.fieldLengthNames,
    fieldLengthColumns: snapshot.fieldLengthColumns,
    totalFieldLengths: snapshot.totalFieldLengths,
    numeric: snapshot.numeric,
    sizes: snapshot.sizes,
    boolean: snapshot.boolean,
    enums: snapshot.enums,
    geo: snapshot.geo,
    pattern: snapshot.pattern,
    tokenTable,
    idTable,
    documentTable: null,
    postingOffsets: snapshot.postingOffsets,
    get postingDocIds(): Uint32Array {
      return onlyMergesThroughTheFile('postingDocIds')
    },
    get postingFrequencies(): Uint16Array {
      return onlyMergesThroughTheFile('postingFrequencies')
    },
    get postingFieldIndices(): Uint16Array {
      return onlyMergesThroughTheFile('postingFieldIndices')
    },
    get positionOffsets(): Uint32Array | null {
      return snapshot.tracksPositions ? onlyMergesThroughTheFile('positionOffsets') : null
    },
    get positionValues(): Uint32Array | null {
      return snapshot.tracksPositions ? onlyMergesThroughTheFile('positionValues') : null
    },
    readSurfaceForms() {
      const table = readSurfaceTable()
      return table === null ? null : decodeSurfaceTable(table)
    },
    surfaceTableOnDisk: createSurfaceTableReader(readSurfaceTable),
    docFrequencies: () => {
      const frequencies: Record<string, number> = Object.create(null)
      for (let at = 0; at < tokenTable.size; at++) {
        frequencies[tokenTable.tokenAt(at)] = tokenTable.documentFrequencyAt(at)
      }
      return frequencies
    },
  }

  const documentSource = createEncodedDocumentSource(
    snapshot.documentCount,
    required('documents').length,
    documents.encodedDocumentAt,
    snapshot.discardedFields.length === 0 ? undefined : snapshot.discardedFields,
  )

  return assemblePagedFrozenSegment(snapshot.segmentId, source, documentSource, snapshot.partialWords, {
    access,
    createCounts: tombstones => createPagedLiveCounts(snapshot, tokenTable, tombstones, removalOffsets, removals),
    createViews: (tombstones, counts) => createPagedPostingViews(snapshot, lists, tombstones, counts),
  })
}
