import { encode } from '@msgpack/msgpack'
import { type PackedEnvelope, packChecksummedEnvelope } from '../../../serialization/envelope-file'
import type { PartitionCheckpoint } from '../partition-checkpoint'

export const SEGMENT_MANIFEST_VERSION = 7
export const EARLIER_SEGMENT_MANIFEST_VERSION = 6
export const MANIFEST_ENVELOPE_VERSION = 2

export const MAX_SEGMENTS_PER_PARTITION = 65_536

export const MAX_SEGMENT_ID = 0xffff_ffff_ffff

export interface FileRef {
  key: string
  bytes: number
  checksum: number
}

export interface SegmentRef extends FileRef {
  id: number
  docCount: number
  tombstoneCount: number
}

export interface VectorFileRef extends FileRef {
  id: number
  count: number
  dead: Uint8Array | null
}

export interface VectorFieldRef {
  fieldPath: string
  nextFileId: number
  files: VectorFileRef[]
  graphGeneration: number
  graphParts: FileRef[]
}

export interface PartitionManifestEntry {
  partitionId: number
  nextSegmentId: number
  segments: SegmentRef[]
}

export interface SegmentManifest {
  version: typeof SEGMENT_MANIFEST_VERSION
  schema: Record<string, string>
  language: string
  checkpoint: PartitionCheckpoint[]
  partitions: PartitionManifestEntry[]
  vectors: VectorFieldRef[]
}

function fileRefOnTheWire(ref: FileRef): FileRef {
  return { key: ref.key, bytes: ref.bytes, checksum: ref.checksum }
}

export function encodeSegmentManifest(manifest: SegmentManifest): Promise<PackedEnvelope> {
  const payload = encode({
    version: SEGMENT_MANIFEST_VERSION,
    schema: manifest.schema,
    language: manifest.language,
    checkpoint: manifest.checkpoint.map(c => ({
      partitionId: c.partitionId,
      lastSeqNo: c.lastSeqNo,
      primaryTerm: c.primaryTerm,
      ...(c.termHistory === undefined
        ? {}
        : {
            termHistory: c.termHistory.map(start => ({ primaryTerm: start.primaryTerm, firstSeqNo: start.firstSeqNo })),
          }),
    })),
    partitions: manifest.partitions.map(p => ({
      partitionId: p.partitionId,
      nextSegmentId: p.nextSegmentId,
      segments: p.segments.map(s => ({
        id: s.id,
        key: s.key,
        docCount: s.docCount,
        tombstoneCount: s.tombstoneCount,
        bytes: s.bytes,
        checksum: s.checksum,
      })),
    })),
    vectors: manifest.vectors.map(v => ({
      fieldPath: v.fieldPath,
      nextFileId: v.nextFileId,
      files: v.files.map(f => ({ id: f.id, ...fileRefOnTheWire(f), count: f.count, dead: f.dead })),
      graphGeneration: v.graphGeneration,
      graphParts: v.graphParts.map(fileRefOnTheWire),
    })),
  })
  return packChecksummedEnvelope([payload], MANIFEST_ENVELOPE_VERSION, 'segment manifest')
}

export function manifestReferencedKeys(manifest: SegmentManifest): Set<string> {
  const keys = new Set<string>()
  for (const partition of manifest.partitions) {
    for (const segment of partition.segments) {
      keys.add(segment.key)
    }
  }
  for (const vector of manifest.vectors) {
    for (const file of vector.files) keys.add(file.key)
    for (const part of vector.graphParts) keys.add(part.key)
  }
  return keys
}

export function manifestFileRefs(manifest: SegmentManifest): FileRef[] {
  const refs: FileRef[] = []
  for (const partition of manifest.partitions) refs.push(...partition.segments)
  for (const vector of manifest.vectors) refs.push(...vector.files, ...vector.graphParts)
  return refs
}
