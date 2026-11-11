import {
  decode,
  ErrorCodes,
  encode,
  NarsilError,
  openChecksummedEnvelope,
  packChecksummedEnvelope,
  sha256,
} from '#platform/storage-host'
import type { DurableDirectory } from '../durable-filesystem'
import type { SegmentManifest } from '../segment/manifest'
import { manifestReferencedKeys } from '../segment/manifest'
import { decodeSegmentManifest } from '../segment/manifest-decode'
import { publishedSnapshotKey } from './layout'

const PUBLISHED_SNAPSHOT_ENVELOPE_VERSION = 1
const PUBLISHED_SNAPSHOT_WHAT = 'published snapshot'

export interface PublishedSnapshot {
  config: Uint8Array
  manifestBytes: Uint8Array
  manifest: SegmentManifest
  entityTag: string
  keys: ReadonlySet<string>
}

function hexOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}

function isBytes(value: unknown): value is Uint8Array {
  return value instanceof Uint8Array
}

async function publishedFrom(
  indexName: string,
  payload: Uint8Array,
  config: Uint8Array,
  manifestBytes: Uint8Array,
): Promise<PublishedSnapshot> {
  const decoded = await decodeSegmentManifest(manifestBytes, indexName)
  if (decoded.kind !== 'current') {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The published snapshot of index "${indexName}" holds a manifest of an earlier layout`,
      { indexName },
    )
  }
  return {
    config,
    manifestBytes,
    manifest: decoded.manifest,
    entityTag: hexOf(sha256(payload)),
    keys: manifestReferencedKeys(decoded.manifest),
  }
}

export async function writePublishedSnapshot(
  directory: DurableDirectory,
  indexName: string,
  config: Uint8Array,
  manifestBytes: Uint8Array,
): Promise<PublishedSnapshot> {
  const payload = encode({ config, manifest: manifestBytes })
  const packed = await packChecksummedEnvelope([payload], PUBLISHED_SNAPSHOT_ENVELOPE_VERSION, PUBLISHED_SNAPSHOT_WHAT)
  const published = await publishedFrom(indexName, payload, config, manifestBytes)
  await directory.atomicWrite(publishedSnapshotKey(indexName), packed.chunks)
  return published
}

export async function readPublishedSnapshot(
  directory: DurableDirectory,
  indexName: string,
): Promise<PublishedSnapshot | null> {
  const bytes = await directory.read(publishedSnapshotKey(indexName))
  if (bytes === null) return null
  const { payload } = await openChecksummedEnvelope(bytes, {
    envelopeFormatVersion: PUBLISHED_SNAPSHOT_ENVELOPE_VERSION,
    what: PUBLISHED_SNAPSHOT_WHAT,
    allowsCompression: false,
  })
  const raw = decode(payload) as { config?: unknown; manifest?: unknown } | null
  if (raw === null || typeof raw !== 'object' || !isBytes(raw.config) || !isBytes(raw.manifest)) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_LOAD_FAILED,
      `The published snapshot of index "${indexName}" lacks its configuration or its manifest`,
      { indexName },
    )
  }
  return publishedFrom(indexName, payload, raw.config, raw.manifest)
}
