import { generateId } from '../../core/id-generator'
import { decodeSynonymRules } from '../../core/synonyms/rules'
import { ErrorCodes, NarsilError } from '../../errors'
import type { SynonymRule } from '../../types/synonyms'
import type { ClusterCoordinator } from '../coordinator/types'
import { isRecord } from '../payload-guards'

export interface SynonymSetRef {
  generation: string
  digest: string
  chunkCount: number
  byteLength: number
}

export type SynonymSetRejection = (message: string) => never

const SYNONYM_CHUNK_BYTES = 1_048_576
const SYNONYM_SET_PREFIX = '_narsil/synonyms/'
const MAX_UINT32 = 0xffff_ffff
const MAX_GENERATION_LENGTH = 128
const DIGEST_PATTERN = /^[0-9a-f]{64}$/
const FIRST_PRINTABLE_CODE = 0x20

function isKeySegment(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < FIRST_PRINTABLE_CODE || value[i] === '/' || value[i] === '\\') return false
  }
  return true
}

function synonymChunkKey(indexUuid: string, generation: string, chunk: number): string {
  return `${SYNONYM_SET_PREFIX}${indexUuid}/${generation}/${chunk}`
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_UINT32
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const view =
    bytes.buffer instanceof ArrayBuffer
      ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : Uint8Array.from(bytes)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', view))
  return Array.from(hash, byte => byte.toString(16).padStart(2, '0')).join('')
}

function synonymSetRefOf(raw: unknown): SynonymSetRef | string {
  if (!isRecord(raw)) return 'synonyms must be an object'
  const { generation, digest, chunkCount, byteLength } = raw
  if (
    typeof generation !== 'string' ||
    generation.length === 0 ||
    generation.length > MAX_GENERATION_LENGTH ||
    !isKeySegment(generation)
  ) {
    return 'synonyms.generation must name one stored copy'
  }
  if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
    return 'synonyms.digest must be a lowercase hexadecimal SHA-256'
  }
  if (!isUint32(byteLength) || byteLength === 0) {
    return 'synonyms.byteLength must be a positive whole number'
  }
  if (!isUint32(chunkCount) || chunkCount !== Math.ceil(byteLength / SYNONYM_CHUNK_BYTES)) {
    return 'synonyms.chunkCount must match synonyms.byteLength'
  }
  return { generation, digest, chunkCount, byteLength }
}

export function decodeSynonymSetRef(raw: unknown, reject: SynonymSetRejection): SynonymSetRef {
  const ref = synonymSetRefOf(raw)
  return typeof ref === 'string' ? reject(ref) : ref
}

export function synonymSetRefOrNull(raw: unknown): SynonymSetRef | null {
  const ref = synonymSetRefOf(raw)
  return typeof ref === 'string' ? null : ref
}

export async function deleteSynonymSet(
  coordinator: ClusterCoordinator,
  indexUuid: string,
  ref: SynonymSetRef,
): Promise<void> {
  for (let chunk = 0; chunk < ref.chunkCount; chunk++) {
    await coordinator.delete(synonymChunkKey(indexUuid, ref.generation, chunk))
  }
}

export async function storeSynonymSet(
  coordinator: ClusterCoordinator,
  indexUuid: string,
  encoded: Uint8Array,
): Promise<SynonymSetRef> {
  const ref: SynonymSetRef = {
    generation: generateId(),
    digest: await digestOf(encoded),
    chunkCount: Math.ceil(encoded.byteLength / SYNONYM_CHUNK_BYTES),
    byteLength: encoded.byteLength,
  }
  try {
    for (let chunk = 0; chunk < ref.chunkCount; chunk++) {
      const start = chunk * SYNONYM_CHUNK_BYTES
      const bytes = encoded.subarray(start, Math.min(start + SYNONYM_CHUNK_BYTES, encoded.byteLength))
      if (!(await coordinator.compareAndSet(synonymChunkKey(indexUuid, ref.generation, chunk), null, bytes))) {
        throw new NarsilError(
          ErrorCodes.CONTROLLER_METADATA_INVALID,
          `Synonym set chunk ${chunk} of a fresh copy already exists in the coordinator`,
          { indexUuid, generation: ref.generation, chunk },
        )
      }
    }
  } catch (err) {
    await deleteSynonymSet(coordinator, indexUuid, ref).catch(() => undefined)
    throw err
  }
  return ref
}

export async function readSynonymSet(
  coordinator: ClusterCoordinator,
  indexUuid: string,
  ref: SynonymSetRef,
  reject: SynonymSetRejection,
): Promise<Uint8Array | null> {
  const encoded = new Uint8Array(ref.byteLength)
  let filled = 0
  for (let chunk = 0; chunk < ref.chunkCount; chunk++) {
    const bytes = await coordinator.get(synonymChunkKey(indexUuid, ref.generation, chunk))
    if (bytes === null) return null
    if (bytes.byteLength > encoded.byteLength - filled) return reject('the stored synonym set exceeds its byteLength')
    encoded.set(bytes, filled)
    filled += bytes.byteLength
  }
  if (filled !== ref.byteLength) return reject('the stored synonym set falls short of its byteLength')
  if ((await digestOf(encoded)) !== ref.digest) return reject('the stored synonym set does not match its digest')
  return encoded
}

export function storedSynonymSetRules(encoded: Uint8Array, reject: SynonymSetRejection): SynonymRule[] {
  return decodeSynonymRules(encoded, message => reject(message))
}
