import { encode, packChecksummedEnvelope } from '#platform/storage-host'
import type { PackedEnvelope } from '../../../serialization/envelope-file'
import { type FileRef, MANIFEST_ENVELOPE_VERSION, SEGMENT_MANIFEST_VERSION, type SegmentManifest } from './manifest'

function fileRefOnTheWire(ref: FileRef): FileRef {
  return {
    key: ref.key,
    bytes: ref.bytes,
    checksum: ref.checksum,
    ...(ref.headOffset === undefined
      ? {}
      : { headOffset: ref.headOffset, headLength: ref.headLength, headChecksum: ref.headChecksum }),
  }
}

export function encodeSegmentManifest(manifest: SegmentManifest): Promise<PackedEnvelope> {
  const payload = encode({
    version: SEGMENT_MANIFEST_VERSION,
    schema: manifest.schema,
    language: manifest.language,
    ...(manifest.analysisGeneration ? { analysisGeneration: manifest.analysisGeneration } : {}),
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
