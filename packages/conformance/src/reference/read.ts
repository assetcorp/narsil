import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decode } from '@msgpack/msgpack'
import { decodeBackupManifest } from '../../../ts/src/distribution/backups/manifest'
import { decodeIndexConfiguration } from '../../../ts/src/engine/snapshot/index-configuration-decode'
import { createNarsil } from '../../../ts/src/narsil'
import { sourceIndexNameOf } from '../../../ts/src/persistence/archive/read'
import { readCommitMarker } from '../../../ts/src/persistence/durability/commit-marker'
import { createDurableDirectory } from '../../../ts/src/persistence/durability/durable-filesystem'
import {
  decodeSegmentManifest,
  listedKeysOf,
  openManifestPayload,
} from '../../../ts/src/persistence/durability/segment/manifest-decode'
import { readDurableRegion } from '../../../ts/src/persistence/durability/wal-framing'
import { checkPagedSegmentFully } from '../../../ts/src/persistence/paged/segment-scan'
import { readMetadataEnvelope } from '../../../ts/src/serialization/envelope'
import { openChecksummedEnvelope } from '../../../ts/src/serialization/envelope-file'
import { decodeKeywordSegment } from '../../../ts/src/serialization/keyword-segment/decode'
import {
  decodeVectorFilePayload,
  decodeVectorGraphPartPayload,
} from '../../../ts/src/vector/vector-index/checkpoint-payload'
import { FormError } from '../forms/decoded'
import type { JsonObject } from '../forms/json'
import { type FormRequest, formOf } from '../forms/kinds'
import { referenceContext } from './context'

const PAGED_SEGMENT_KEY = 'conformance/segments/0/s0000000000000000'
const ARCHIVE_INDEX_NAME = 'conformance'
const KEYWORD_SEGMENT_ENVELOPE_VERSION = 4
const VECTOR_ENVELOPE_VERSION = 2
const HEADER_CHECKSUM_OFFSET = 14

async function inTemporaryDirectory<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'narsil-conformance-read-'))
  try {
    return await work(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function payloadOf(bytes: Uint8Array, version: number, what: string, allowsCompression: boolean) {
  const { payload } = await openChecksummedEnvelope(bytes, { envelopeFormatVersion: version, what, allowsCompression })
  return payload
}

async function acceptPagedSegment(bytes: Uint8Array): Promise<void> {
  await inTemporaryDirectory(async root => {
    const path = join(root, PAGED_SEGMENT_KEY)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const checksum = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      HEADER_CHECKSUM_OFFSET,
      false,
    )
    await checkPagedSegmentFully(createDurableDirectory(root), {
      key: PAGED_SEGMENT_KEY,
      bytes: bytes.byteLength,
      checksum,
    })
  })
}

async function acceptThroughEngine(bytes: Uint8Array, kind: 'snapshot-archive' | 'document-export'): Promise<void> {
  await inTemporaryDirectory(async root => {
    const narsil = await createNarsil({ workers: { enabled: false }, durability: { directory: root, mode: 'sync' } })
    try {
      if (kind === 'snapshot-archive') {
        await narsil.restore(ARCHIVE_INDEX_NAME, bytes)
        return
      }
      const result = await narsil.importDocumentExport(ARCHIVE_INDEX_NAME, bytes)
      if (result.refusedCount > 0) {
        const [first] = result.refused
        throw new FormError(
          `the reference refused ${result.refusedCount} lines, first line ${first?.line}: ${first?.message}`,
        )
      }
    } finally {
      await narsil.shutdown()
    }
  })
}

export async function referenceAccepts(request: FormRequest): Promise<void> {
  const { kind, bytes, what } = request
  switch (kind) {
    case 'log-segment':
      readDurableRegion(bytes, bytes.byteLength)
      return
    case 'commit-marker':
      if (readCommitMarker(bytes) === null) throw new FormError(`${what} holds no valid slot`)
      return
    case 'manifest': {
      const raw = await openManifestPayload(bytes)
      await decodeSegmentManifest(bytes, sourceIndexNameOf(listedKeysOf(raw)))
      return
    }
    case 'keyword-segment':
      decodeKeywordSegment(await payloadOf(bytes, KEYWORD_SEGMENT_ENVELOPE_VERSION, what, true), false)
      return
    case 'paged-segment':
      await acceptPagedSegment(bytes)
      return
    case 'vector-file':
      decodeVectorFilePayload(decode(await payloadOf(bytes, VECTOR_ENVELOPE_VERSION, what, false)))
      return
    case 'graph-part':
      decodeVectorGraphPartPayload(decode(await payloadOf(bytes, VECTOR_ENVELOPE_VERSION, what, true)))
      return
    case 'index-metadata':
      await readMetadataEnvelope(bytes)
      return
    case 'index-configuration':
      await decodeIndexConfiguration(bytes)
      return
    case 'backup-manifest':
      await decodeBackupManifest(bytes, ARCHIVE_INDEX_NAME)
      return
    case 'snapshot-archive':
    case 'document-export':
      await acceptThroughEngine(bytes, kind)
      return
  }
}

export async function referenceForm(request: FormRequest): Promise<JsonObject> {
  await referenceAccepts(request)
  return formOf(request, referenceContext)
}
