import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NarsilError } from '../../../errors'
import { createGcsPersistence } from '../../../persistence/gcs'
import { createS3Persistence } from '../../../persistence/s3'
import type { PersistenceAdapter } from '../../../types/adapters'

const LISTED_KEYS = 1_050
const KEYS_SAVED_AT_ONCE = 32
const STREAMED_BYTES = 20 * 1_048_576 + 12_345
const STREAM_CHUNK_BYTES = 1_000_003
const LIVE_TIMEOUT_MS = 600_000

interface LiveStore {
  name: string
  configured: boolean
  open(keyPrefix: string): Promise<PersistenceAdapter>
}

const env = process.env

const STORES: LiveStore[] = [
  {
    name: 'S3',
    configured: env.NARSIL_TEST_S3_BUCKET !== undefined,
    open: keyPrefix =>
      createS3Persistence({
        bucket: env.NARSIL_TEST_S3_BUCKET ?? '',
        keyPrefix,
        ...(env.NARSIL_TEST_S3_REGION === undefined ? {} : { region: env.NARSIL_TEST_S3_REGION }),
        ...(env.NARSIL_TEST_S3_ENDPOINT === undefined ? {} : { endpoint: env.NARSIL_TEST_S3_ENDPOINT }),
        forcePathStyle: env.NARSIL_TEST_S3_FORCE_PATH_STYLE === '1',
        ...(env.NARSIL_TEST_S3_ACCESS_KEY_ID === undefined || env.NARSIL_TEST_S3_SECRET_ACCESS_KEY === undefined
          ? {}
          : {
              credentials: {
                accessKeyId: env.NARSIL_TEST_S3_ACCESS_KEY_ID,
                secretAccessKey: env.NARSIL_TEST_S3_SECRET_ACCESS_KEY,
              },
            }),
      }),
  },
  {
    name: 'Google Cloud Storage',
    configured: env.NARSIL_TEST_GCS_BUCKET !== undefined,
    open: keyPrefix =>
      createGcsPersistence({
        bucket: env.NARSIL_TEST_GCS_BUCKET ?? '',
        keyPrefix,
        ...(env.NARSIL_TEST_GCS_PROJECT === undefined ? {} : { projectId: env.NARSIL_TEST_GCS_PROJECT }),
        ...(env.NARSIL_TEST_GCS_KEY_FILE === undefined ? {} : { keyFilename: env.NARSIL_TEST_GCS_KEY_FILE }),
        ...(env.NARSIL_TEST_GCS_ENDPOINT === undefined ? {} : { apiEndpoint: env.NARSIL_TEST_GCS_ENDPOINT }),
      }),
  },
]

function patterned(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = seed >>> 0
  for (let at = 0; at < length; at++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[at] = state >>> 24
  }
  return bytes
}

async function* chunksOf(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += STREAM_CHUNK_BYTES) {
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + STREAM_CHUNK_BYTES))
  }
}

async function readAll(chunks: AsyncIterable<Uint8Array>): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash('sha256')
  let bytes = 0
  for await (const chunk of chunks) {
    hash.update(chunk)
    bytes += chunk.byteLength
  }
  return { bytes, sha256: hash.digest('hex') }
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work
  } catch (error) {
    if (error instanceof NarsilError) return error.code
    throw error
  }
  return 'no error'
}

describe.each(STORES)('the $name adapter against a live store', store => {
  const keyPrefix = `narsil-live-${randomUUID()}`
  let adapter: PersistenceAdapter

  beforeAll(async () => {
    if (store.configured) adapter = await store.open(keyPrefix)
  })

  afterAll(async () => {
    if (!store.configured) return
    for (const key of await adapter.list('')) await adapter.delete(key)
  }, LIVE_TIMEOUT_MS)

  it.skipIf(!store.configured)(
    'saves, loads, lists more than one page, and deletes',
    async () => {
      const value = patterned(4_096, 7)
      await adapter.save('single/value', value)
      expect(await adapter.load('single/value')).toEqual(value)
      expect(await adapter.load('single/absent')).toBeNull()

      const keys = Array.from({ length: LISTED_KEYS }, (_, at) => `many/${String(at).padStart(5, '0')}`)
      for (let start = 0; start < keys.length; start += KEYS_SAVED_AT_ONCE) {
        await Promise.all(
          keys.slice(start, start + KEYS_SAVED_AT_ONCE).map(key => adapter.save(key, new TextEncoder().encode(key))),
        )
      }
      expect((await adapter.list('many/')).sort()).toEqual(keys)

      for (let start = 0; start < keys.length; start += KEYS_SAVED_AT_ONCE) {
        await Promise.all(keys.slice(start, start + KEYS_SAVED_AT_ONCE).map(key => adapter.delete(key)))
      }
      expect(await adapter.list('many/')).toEqual([])
      await adapter.delete('many/00000')
      await adapter.delete('single/value')
      expect(await adapter.load('single/value')).toBeNull()
    },
    LIVE_TIMEOUT_MS,
  )

  it.skipIf(!store.configured)(
    'streams a file larger than one part in each direction, and stores nothing for a stream of the wrong length',
    async () => {
      const { saveStream, loadStream } = adapter
      if (saveStream === undefined || loadStream === undefined) throw new Error('The adapter offers no streams')
      const bytes = patterned(STREAMED_BYTES, 11)
      const expected = createHash('sha256').update(bytes).digest('hex')
      await saveStream.call(adapter, 'streamed/large', chunksOf(bytes), bytes.byteLength)
      const loaded = await loadStream.call(adapter, 'streamed/large')
      if (loaded === null) throw new Error('The streamed object is missing')
      expect(await readAll(loaded)).toEqual({ bytes: STREAMED_BYTES, sha256: expected })
      expect(await loadStream.call(adapter, 'streamed/absent')).toBeNull()

      const short = saveStream.call(adapter, 'streamed/short', chunksOf(bytes), bytes.byteLength + 1)
      expect(await codeOf(short)).toBe('PERSISTENCE_SAVE_FAILED')
      const long = saveStream.call(adapter, 'streamed/long', chunksOf(bytes), bytes.byteLength - 1)
      expect(await codeOf(long)).toBe('PERSISTENCE_SAVE_FAILED')
      expect((await adapter.list('streamed/')).sort()).toEqual(['streamed/large'])
    },
    LIVE_TIMEOUT_MS,
  )
})
