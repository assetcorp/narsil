import type { FormContext } from './codec'
import { type Decoded, FormError, isDecodedMap, listOf, mapOf } from './decoded'
import { headerJson } from './header'
import { type Json, type JsonObject, tagged } from './json'
import { keywordSegmentPayload } from './keyword-segment'
import { numbersJson } from './numbers'

const ARCHIVE_PLACEMENT_KEYS = new Set(['bytes', 'checksum', 'headOffset', 'headLength', 'headChecksum'])

export async function keywordSegmentJson(bytes: Uint8Array, context: FormContext, what: string): Promise<JsonObject> {
  const { header, payload } = await context.openEnvelope(bytes, what)
  return {
    header: headerJson(header),
    payload: keywordSegmentPayload.toJson(context.unpack(payload, what), `${what} payload`, context),
  }
}

export async function mirroredMapJson(bytes: Uint8Array, context: FormContext, what: string): Promise<JsonObject> {
  const { header, payload } = await context.openEnvelope(bytes, what)
  const map = mapOf(context.unpack(payload, what), `${what} payload`)
  return { header: headerJson(header), payload: tagged(map) }
}

function fileRefJson(ref: Decoded, inArchive: boolean, what: string): Json {
  const map = mapOf(ref, what)
  const object: JsonObject = {}
  for (const [key, value] of map) {
    if (inArchive && ARCHIVE_PLACEMENT_KEYS.has(key)) continue
    if (key === 'dead' && value instanceof Uint8Array) {
      object[key] = numbersJson(value, 'uint8', `${what}.dead`)
      continue
    }
    object[key] = tagged(value)
  }
  return object
}

function refListJson(value: Decoded, inArchive: boolean, what: string): Json {
  return listOf(value, what).map((ref, at) => fileRefJson(ref, inArchive, `${what}[${at}]`))
}

function partitionJson(entry: Decoded, inArchive: boolean, what: string): Json {
  const map = mapOf(entry, what)
  const object: JsonObject = {}
  for (const [key, value] of map) {
    object[key] = key === 'segments' ? refListJson(value, inArchive, `${what}.segments`) : tagged(value)
  }
  return object
}

function vectorFieldJson(entry: Decoded, inArchive: boolean, what: string): Json {
  const map = mapOf(entry, what)
  const object: JsonObject = {}
  for (const [key, value] of map) {
    object[key] =
      key === 'files' || key === 'graphParts' ? refListJson(value, inArchive, `${what}.${key}`) : tagged(value)
  }
  return object
}

export function manifestPayloadJson(payload: Decoded, inArchive: boolean, what: string): JsonObject {
  const map = mapOf(payload, what)
  const object: JsonObject = {}
  for (const [key, value] of map) {
    const path = `${what}.${key}`
    if (key === 'partitions') {
      object[key] = listOf(value, path).map((entry, at) => partitionJson(entry, inArchive, `${path}[${at}]`))
    } else if (key === 'vectors') {
      object[key] = listOf(value, path).map((entry, at) => vectorFieldJson(entry, inArchive, `${path}[${at}]`))
    } else {
      object[key] = tagged(value)
    }
  }
  return object
}

export async function manifestJson(
  bytes: Uint8Array,
  context: FormContext,
  what: string,
  inArchive: boolean,
): Promise<JsonObject> {
  const { header, payload } = await context.openEnvelope(bytes, what)
  const decoded = context.unpack(payload, what)
  if (!isDecodedMap(decoded)) throw new FormError(`${what} payload is not a map`)
  return { header: headerJson(header), payload: manifestPayloadJson(decoded, inArchive, `${what} payload`) }
}
