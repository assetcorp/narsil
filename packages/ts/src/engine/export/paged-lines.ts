import { parseVectorDimension } from '../../core/partition/utils'
import { setNestedValue } from '../../distribution/replication/replica'
import type { ArchiveCheckpoint } from '../../persistence/durability/archive-checkpoint'
import type { PartitionManifestEntry, VectorFieldRef } from '../../persistence/durability/segment/manifest'
import { openColdVectorField } from '../../persistence/paged/cold-field'
import { countsAsLatestHolder, openPagedSegmentScan, type SegmentScan } from '../../persistence/paged/segment-scan'
import { isPagedSegmentFile } from '../../persistence/paged/verify'
import type { ColdVectorField } from '../../vector/vector-index/shared'
import { encodeDocumentJson } from './json-line'

export interface VectorReads {
  vectorOf(fieldPath: string, docId: string): Promise<number[] | null>
  close(): void
}

async function coldFieldOf(checkpoint: ArchiveCheckpoint, field: VectorFieldRef): Promise<ColdVectorField | null> {
  const { directory } = checkpoint
  if (directory === undefined || field.files.length === 0 || field.graphParts.length === 0) return null
  if (![...field.files, ...field.graphParts].every(file => file.headOffset !== undefined)) return null
  const fieldType = checkpoint.manifest.schema[field.fieldPath]
  const dimension = fieldType === undefined ? null : parseVectorDimension(fieldType)
  if (dimension === null) return null
  const withPath = async <Ref extends { key: string }>(ref: Ref) => ({ ref, path: await directory.pathOf(ref.key) })
  return openColdVectorField({
    fieldPath: field.fieldPath,
    dimension,
    metric: 'cosine',
    codeBits: null,
    files: await Promise.all(field.files.map(withPath)),
    graphParts: await Promise.all(field.graphParts.map(withPath)),
    resolvePartition: () => undefined,
  })
}

export async function openFileVectorReads(
  checkpoint: ArchiveCheckpoint,
  wholeFileReads: () => Promise<VectorReads>,
): Promise<VectorReads> {
  const fields = new Map<string, ColdVectorField>()
  for (const field of checkpoint.manifest.vectors) {
    const opened = await coldFieldOf(checkpoint, field)
    if (opened !== null) fields.set(field.fieldPath, opened)
  }
  const fallback = fields.size === checkpoint.manifest.vectors.length ? null : await wholeFileReads()
  return {
    async vectorOf(fieldPath, docId) {
      const field = fields.get(fieldPath)
      if (field === undefined) return fallback === null ? null : fallback.vectorOf(fieldPath, docId)
      const number = field.numberOf(docId)
      return number === undefined ? null : Array.from(field.vectorOfNumber(number))
    },
    close() {
      for (const field of fields.values()) field.close()
      fallback?.close()
    },
  }
}

export async function* pagedPartitionLines(
  checkpoint: ArchiveCheckpoint,
  partition: PartitionManifestEntry,
  vectors: VectorReads,
  openWholeSegment: (ref: PartitionManifestEntry['segments'][number]) => Promise<SegmentScan>,
): AsyncGenerator<string> {
  const { directory } = checkpoint
  if (directory === undefined) return
  const scans: SegmentScan[] = []
  try {
    for (const ref of partition.segments) {
      const paged = await isPagedSegmentFile(directory, ref.key)
      scans.push(paged ? await openPagedSegmentScan(directory, ref) : await openWholeSegment(ref))
    }
    for (let at = 0; at < scans.length; at++) {
      const scan = scans[at]
      for (let ordinal = 0; ordinal < scan.count; ordinal++) {
        const docId = scan.idAt(ordinal)
        if (!countsAsLatestHolder(scans, at, docId)) continue
        const document: Record<string, unknown> = { id: docId, ...scan.storedDocumentAt(ordinal) }
        document.id = docId
        for (const field of checkpoint.manifest.vectors) {
          const vector = await vectors.vectorOf(field.fieldPath, docId)
          if (vector !== null) setNestedValue(document, field.fieldPath, vector)
        }
        yield `${encodeDocumentJson(document, docId)}\n`
      }
    }
  } finally {
    for (const scan of scans) scan.close()
  }
}
