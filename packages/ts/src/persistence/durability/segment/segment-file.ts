import { openChecksummedEnvelope, packChecksummedEnvelope } from '../../../serialization/envelope-file'
import { HEADER_SIZE } from '../../../serialization/header'
import { decodeKeywordSegment } from '../../../serialization/keyword-segment/decode'
import { encodeKeywordSegment } from '../../../serialization/keyword-segment/encode'
import {
  KEYWORD_SEGMENT_ENVELOPE_VERSION,
  type KeywordSegmentContents,
} from '../../../serialization/keyword-segment/types'
import type { FileRef } from './manifest'
import { type CheckpointStore, readListedFile, requireListedChecksum } from './store'

export function encodedSegmentBytes(contents: KeywordSegmentContents): number {
  return HEADER_SIZE + encodeKeywordSegment(contents).byteLength
}

export async function writeSegmentFile(
  store: CheckpointStore,
  key: string,
  contents: KeywordSegmentContents,
): Promise<FileRef> {
  const encoded = encodeKeywordSegment(contents)
  const packed = await packChecksummedEnvelope(encoded.chunks, KEYWORD_SEGMENT_ENVELOPE_VERSION, 'keyword segment')
  await store.write(key, packed.chunks)
  return { key, bytes: packed.byteLength, checksum: packed.checksum }
}

export function sharesMemoryWithWorkers(): boolean {
  return typeof SharedArrayBuffer === 'function'
}

export async function readSegmentFile(store: CheckpointStore, ref: FileRef): Promise<KeywordSegmentContents> {
  const bytes = await readListedFile(store, ref.key, { bytes: ref.bytes, what: 'segment' })
  const { header, payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: KEYWORD_SEGMENT_ENVELOPE_VERSION,
    what: `segment "${ref.key}"`,
    allowsCompression: true,
  })
  requireListedChecksum('segment', ref.key, header.checksum, ref.checksum)
  return decodeKeywordSegment(payload, sharesMemoryWithWorkers())
}
