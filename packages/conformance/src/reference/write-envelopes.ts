import { encode } from '@msgpack/msgpack'
import { decodeBackupManifest, encodeBackupManifest } from '../../../ts/src/distribution/backups/manifest'
import { decodeIndexConfiguration } from '../../../ts/src/engine/snapshot/index-configuration'
import { sourceIndexNameOf } from '../../../ts/src/persistence/archive/read'
import { encodeSegmentManifest } from '../../../ts/src/persistence/durability/segment/manifest'
import {
  decodeManifestPayload,
  openManifestPayload,
} from '../../../ts/src/persistence/durability/segment/manifest-decode'
import { readMetadataEnvelope, writeMetadataEnvelope } from '../../../ts/src/serialization/envelope'
import { decodeKeywordSegment } from '../../../ts/src/serialization/keyword-segment/decode'
import { encodeKeywordSegment } from '../../../ts/src/serialization/keyword-segment/encode'
import { deserializeMetadata } from '../../../ts/src/serialization/payload-v1/metadata'
import { type Decoded, FormError } from '../forms/decoded'
import { headerFromJson } from '../forms/header'
import { isJsonObject, type Json, type JsonObject, untagged } from '../forms/json'
import { keywordSegmentPayload } from '../forms/keyword-segment'
import { numbersFromJson } from '../forms/numbers'
import { plainOf, referenceContext } from './context'
import { packedEnvelope } from './envelope'

const BACKUP_SAMPLE_NAME = 'conformance'

export function objectAt(value: Json | undefined, what: string): JsonObject {
  if (!isJsonObject(value)) throw new FormError(`${what} is not an object`)
  return value
}

export function listAt(value: Json | undefined, what: string): Json[] {
  if (!Array.isArray(value)) throw new FormError(`${what} is not a list`)
  return value
}

export function keywordPayloadBytes(payload: Json, what: string): Uint8Array {
  const decoded = keywordSegmentPayload.fromJson(payload, `${what} payload`, referenceContext)
  const contents = decodeKeywordSegment(encode(plainOf(decoded, what)), false)
  const encoded = encodeKeywordSegment(contents)
  const bytes = new Uint8Array(encoded.byteLength)
  let at = 0
  for (const chunk of encoded.chunks) {
    bytes.set(chunk, at)
    at += chunk.byteLength
  }
  return bytes
}

export async function writeKeywordSegment(json: JsonObject, what: string): Promise<Uint8Array> {
  return packedEnvelope([keywordPayloadBytes(json.payload, what)], headerFromJson(json.header, `${what} header`))
}

function refFromJson(ref: Json, what: string): Decoded {
  const object = objectAt(ref, what)
  const map = new Map<string, Decoded>()
  for (const [key, value] of Object.entries(object)) {
    map.set(
      key,
      key === 'dead' && Array.isArray(value) ? numbersFromJson(value, 'uint8', `${what}.dead`) : untagged(value),
    )
  }
  return map
}

function withRefLists(entry: Json, listKeys: readonly string[], what: string): Decoded {
  const map = new Map<string, Decoded>()
  for (const [key, value] of Object.entries(objectAt(entry, what))) {
    const path = `${what}.${key}`
    map.set(
      key,
      listKeys.includes(key)
        ? listAt(value, path).map((ref, at) => refFromJson(ref, `${path}[${at}]`))
        : untagged(value),
    )
  }
  return map
}

export function manifestPayloadFromJson(payload: Json, what: string): Map<string, Decoded> {
  const map = new Map<string, Decoded>()
  for (const [key, value] of Object.entries(objectAt(payload, what))) {
    const path = `${what}.${key}`
    if (key === 'partitions') {
      map.set(
        key,
        listAt(value, path).map((entry, at) => withRefLists(entry, ['segments'], `${path}[${at}]`)),
      )
    } else if (key === 'vectors') {
      map.set(
        key,
        listAt(value, path).map((entry, at) => withRefLists(entry, ['files', 'graphParts'], `${path}[${at}]`)),
      )
    } else {
      map.set(key, untagged(value))
    }
  }
  return map
}

export async function manifestBytesOf(
  payload: Map<string, Decoded>,
  json: JsonObject,
  what: string,
): Promise<Uint8Array> {
  const plain = plainOf(payload, what)
  if (plain === null || typeof plain !== 'object') throw new FormError(`${what} payload is not a map`)
  const decoded = decodeManifestPayload(plain as Record<string, unknown>, sourceIndexNameOf(listedKeys(payload)))
  if (decoded.kind !== 'current') throw new FormError(`${what} is not a current manifest`)
  const packed = await encodeSegmentManifest(decoded.manifest)
  const bytes = await packedEnvelope(packed.chunks.slice(1), headerFromJson(json.header, `${what} header`))
  await openManifestPayload(bytes)
  return bytes
}

function listedKeys(payload: Map<string, Decoded>): string[] {
  const keys: string[] = []
  const collect = (value: Decoded | undefined, listKey: string) => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (!(entry instanceof Map)) continue
      const list = entry.get(listKey)
      if (!Array.isArray(list)) continue
      for (const ref of list)
        if (ref instanceof Map && typeof ref.get('key') === 'string') keys.push(String(ref.get('key')))
    }
  }
  collect(payload.get('partitions'), 'segments')
  collect(payload.get('vectors'), 'files')
  collect(payload.get('vectors'), 'graphParts')
  return keys
}

export async function writeManifest(json: JsonObject, what: string): Promise<Uint8Array> {
  return manifestBytesOf(manifestPayloadFromJson(json.payload, `${what} payload`), json, what)
}

export async function writeIndexMetadata(json: JsonObject, what: string): Promise<Uint8Array> {
  const header = headerFromJson(json.header, `${what} header`)
  const metadata = deserializeMetadata(encode(plainOf(untagged(json.payload), what)))
  const bytes = await writeMetadataEnvelope(metadata, {
    compression: header.compression,
    checksum: header.checksum,
    envelopeFormatVersion: header.envelopeFormatVersion,
  })
  await readMetadataEnvelope(bytes)
  return bytes
}

export async function writeIndexConfiguration(json: JsonObject, what: string): Promise<Uint8Array> {
  const header = headerFromJson(json.header, `${what} header`)
  const bytes = await packedEnvelope([encode(plainOf(untagged(json.payload), what))], header)
  await decodeIndexConfiguration(bytes)
  return bytes
}

export async function writeBackupManifest(json: JsonObject, what: string): Promise<Uint8Array> {
  const header = headerFromJson(json.header, `${what} header`)
  const unchecked = await packedEnvelope([encode(plainOf(untagged(json.payload), what))], header)
  return encodeBackupManifest(await decodeBackupManifest(unchecked, BACKUP_SAMPLE_NAME))
}
