import { type Decoded, FormError, listOf, mapOf } from './decoded'
import type { HeaderForm } from './header'
import { isJsonObject, type Json, type JsonObject, tagged, untagged } from './json'
import { joinedWithOffsets, type NumberWidth, numbersFromJson, numbersJson, offsetsOf, slicesOf } from './numbers'

export interface OpenedEnvelope {
  header: HeaderForm
  payload: Uint8Array
}

export interface FormContext {
  openEnvelope(bytes: Uint8Array, what: string): Promise<OpenedEnvelope>
  unpack(bytes: Uint8Array, what: string): Decoded
  unpackSequence(bytes: Uint8Array, what: string): Decoded[]
  pack(value: Decoded, what: string): Uint8Array
  crc32(bytes: Uint8Array): number
}

export interface FieldCodec {
  toJson(value: Decoded, what: string, context: FormContext): Json
  fromJson(value: Json, what: string, context: FormContext): Decoded
}

export const anyValue: FieldCodec = {
  toJson: value => tagged(value),
  fromJson: value => untagged(value),
}

export function numbers(width: NumberWidth): FieldCodec {
  return {
    toJson: (value, what) => {
      if (!(value instanceof Uint8Array)) throw new FormError(`${what} is not a binary value`)
      return numbersJson(value, width, what)
    },
    fromJson: (value, what) => {
      if (!Array.isArray(value)) throw new FormError(`${what} is not a list of numbers`)
      return numbersFromJson(value, width, what)
    },
  }
}

export function orNil(codec: FieldCodec): FieldCodec {
  return {
    toJson: (value, what, context) => (value === null ? null : codec.toJson(value, what, context)),
    fromJson: (value, what, context) => (value === null ? null : codec.fromJson(value, what, context)),
  }
}

export function listOfCodec(codec: FieldCodec): FieldCodec {
  return {
    toJson: (value, what, context) =>
      listOf(value, what).map((item, at) => codec.toJson(item, `${what}[${at}]`, context)),
    fromJson: (value, what, context) => {
      if (!Array.isArray(value)) throw new FormError(`${what} is not a list`)
      return value.map((item, at) => codec.fromJson(item, `${what}[${at}]`, context))
    },
  }
}

export type EntryKind = 'text' | 'packed' | 'textPairs'

export interface JoinedList {
  blob: string
  offsets: string
  kind: EntryKind
}

export interface StructShape {
  fields: Record<string, FieldCodec>
  joined?: readonly JoinedList[]
  derived?: readonly string[]
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

function entriesToJson(slices: Uint8Array[], kind: EntryKind, what: string, context: FormContext): Json[] {
  if (kind === 'text') return slices.map(slice => utf8.decode(slice))
  if (kind === 'packed') return slices.map((slice, at) => tagged(context.unpack(slice, `${what}[${at}]`)))
  const pairs: Json[] = []
  for (let at = 0; at + 1 < slices.length; at += 2) pairs.push([utf8.decode(slices[at]), utf8.decode(slices[at + 1])])
  if (slices.length % 2 !== 0) throw new FormError(`${what} holds an odd number of entries`)
  return pairs
}

function entriesFromJson(value: Json, kind: EntryKind, what: string, context: FormContext): Uint8Array[] {
  if (!Array.isArray(value)) throw new FormError(`${what} is not a list`)
  if (kind === 'packed') return value.map((item, at) => context.pack(untagged(item), `${what}[${at}]`))
  if (kind === 'text') {
    return value.map((item, at) => {
      if (typeof item !== 'string') throw new FormError(`${what}[${at}] is not a string`)
      return encoder.encode(item)
    })
  }
  return value.flatMap((pair, at) => {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') {
      throw new FormError(`${what}[${at}] is not a pair of strings`)
    }
    return [encoder.encode(pair[0]), encoder.encode(pair[1])]
  })
}

export function structCodec(shape: StructShape): FieldCodec {
  const joinedByBlob = new Map((shape.joined ?? []).map(entry => [entry.blob, entry]))
  const skipped = new Set([...(shape.joined ?? []).map(entry => entry.offsets), ...(shape.derived ?? [])])
  return {
    toJson(value, what, context) {
      const map = mapOf(value, what)
      const object: JsonObject = {}
      for (const [key, entry] of map) {
        if (skipped.has(key)) continue
        const path = `${what}.${key}`
        const joined = joinedByBlob.get(key)
        if (joined !== undefined) {
          if (entry === null) {
            object[key] = null
            continue
          }
          if (!(entry instanceof Uint8Array)) throw new FormError(`${path} is not a binary value`)
          const offsets = offsetsOf(bytesAt(map, joined.offsets, what), `${what}.${joined.offsets}`)
          object[key] = entriesToJson(slicesOf(entry, offsets, path), joined.kind, path, context)
          continue
        }
        const codec = shape.fields[key]
        object[key] = codec === undefined ? tagged(entry) : codec.toJson(entry, path, context)
      }
      return object
    },
    fromJson(value, what, context) {
      if (!isJsonObject(value)) throw new FormError(`${what} is not an object`)
      const map = new Map<string, Decoded>()
      for (const [key, entry] of Object.entries(value)) {
        const path = `${what}.${key}`
        const joined = joinedByBlob.get(key)
        if (joined !== undefined) {
          if (entry === null) {
            map.set(key, null)
            map.set(joined.offsets, null)
            continue
          }
          const { blob, offsets } = joinedWithOffsets(entriesFromJson(entry, joined.kind, path, context))
          map.set(key, blob)
          map.set(joined.offsets, offsets)
          continue
        }
        const codec = shape.fields[key]
        map.set(key, codec === undefined ? untagged(entry) : codec.fromJson(entry, path, context))
      }
      return map
    },
  }
}

function bytesAt(map: Map<string, Decoded>, key: string, what: string): Uint8Array {
  const value = map.get(key)
  if (!(value instanceof Uint8Array)) throw new FormError(`${what} has no binary ${key}`)
  return value
}
