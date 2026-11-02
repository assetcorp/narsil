import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ErrorCodes, NarsilError } from '../errors'
import { MAX_FILE_BYTES } from '../serialization/constants'
import type { PersistenceAdapter } from '../types/adapters'
import { OBJECT_STORE_LIST_PAGE_KEYS, OBJECT_STORE_PART_BYTES } from './constants'
import {
  countedChunks,
  joinChunks,
  objectKeyPrefix,
  objectStoreFailure,
  readWhole,
  refuseOversizedObject,
  requireBucket,
  requireObjectKey,
  requireStreamLength,
} from './object-store'

type GcsModule = typeof import('@google-cloud/storage')
type GcsFile = import('@google-cloud/storage').File

const GCS_NOT_FOUND_STATUS = 404
const GCS_PRECONDITION_FAILED_STATUS = 412
const GCS_CONTENT_TYPE = 'application/octet-stream'

/**
 * The service account key that {@link createGcsPersistence} signs its requests with.
 *
 * @public
 */
export interface GcsCredentials {
  /** The service account's email address. */
  client_email: string
  /** The service account's private key in PEM form. */
  private_key: string
}

/**
 * Where {@link createGcsPersistence} stores its objects, and how it reaches Google Cloud Storage.
 *
 * @public
 */
export interface GcsPersistenceConfig {
  /** The adapter writes every object to this bucket. */
  bucket: string
  /** The project that owns the bucket, which the SDK otherwise reads from the environment. */
  projectId?: string
  /** The path of a service account key file, which the SDK otherwise finds through its default credentials. */
  keyFilename?: string
  /** A service account key held in memory, as an alternative to `keyFilename`. */
  credentials?: GcsCredentials
  /** The address of a service that speaks the Cloud Storage JSON API, such as an emulator. */
  apiEndpoint?: string
  /** The adapter stores every key under this prefix inside the bucket, so several stores can share one bucket. */
  keyPrefix?: string
}

async function loadGcsModule(): Promise<GcsModule> {
  try {
    return await import('@google-cloud/storage')
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_DEPENDENCY_MISSING,
      'The `@google-cloud/storage` package is not installed. Install it with `pnpm add @google-cloud/storage` (or the npm or yarn equivalent) to use createGcsPersistence.',
      { cause: err instanceof Error ? err.message : String(err) },
    )
  }
}

function statusOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === GCS_NOT_FOUND_STATUS
}

function isPreconditionFailed(error: unknown): boolean {
  return statusOf(error) === GCS_PRECONDITION_FAILED_STATUS
}

function readObject(file: GcsFile, key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    let settled = false
    const stream = file.createReadStream()
    stream.on('data', (chunk: Uint8Array) => {
      total += chunk.byteLength
      if (total > MAX_FILE_BYTES) {
        stream.destroy()
        if (!settled) {
          settled = true
          try {
            refuseOversizedObject(key, total)
          } catch (error) {
            reject(error)
          }
        }
        return
      }
      chunks.push(chunk)
    })
    stream.on('error', (error: unknown) => {
      if (settled) return
      settled = true
      if (isNotFound(error)) resolve(null)
      else reject(objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error))
    })
    stream.on('end', () => {
      if (settled) return
      settled = true
      resolve(joinChunks(chunks, total))
    })
  })
}

async function* remainingChunks(
  key: string,
  first: Uint8Array,
  rest: AsyncIterator<Uint8Array>,
  stream: Readable,
): AsyncGenerator<Uint8Array> {
  let total = first.byteLength
  try {
    refuseOversizedObject(key, total)
    yield first
    for (;;) {
      const step = await rest.next()
      if (step.done === true) return
      total += step.value.byteLength
      refuseOversizedObject(key, total)
      yield step.value
    }
  } catch (error) {
    throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error)
  } finally {
    stream.destroy()
  }
}

async function* chunksOf(chunks: readonly Uint8Array[]): AsyncGenerator<Uint8Array> {
  yield* chunks
}

async function openObjectStream(file: GcsFile, key: string): Promise<AsyncIterable<Uint8Array> | null> {
  const stream = file.createReadStream()
  const chunks: AsyncIterator<Uint8Array> = stream[Symbol.asyncIterator]()
  let first: IteratorResult<Uint8Array>
  try {
    first = await chunks.next()
  } catch (error) {
    stream.destroy()
    if (isNotFound(error)) return null
    throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error)
  }
  if (first.done === true) {
    stream.destroy()
    return chunksOf([])
  }
  return remainingChunks(key, first.value, chunks, stream)
}

/**
 * Builds a persistence adapter that stores each key as one object in a Google Cloud Storage bucket.
 *
 * Cluster backups use it as the store outside the cluster. The adapter loads `@google-cloud/storage`, an optional
 * peer dependency, when you call this function, checks each download against the checksum that Cloud Storage keeps,
 * and refuses to load an object larger than one stored file can be.
 *
 * @param config - The bucket, the project, and the credentials.
 * @returns An adapter you pass wherever Narsil takes a {@link PersistenceAdapter}.
 * @throws A `NarsilError` with `PERSISTENCE_DEPENDENCY_MISSING` and the install command when the SDK is missing, and
 * with `CONFIG_INVALID` when the bucket name is empty.
 *
 * @public
 */
export async function createGcsPersistence(config: GcsPersistenceConfig): Promise<PersistenceAdapter> {
  const bucketName = requireBucket(config.bucket, 'Google Cloud Storage')
  const root = objectKeyPrefix(config.keyPrefix, 'Google Cloud Storage')
  const sdk = await loadGcsModule()
  const storage = new sdk.Storage({
    ...(config.projectId === undefined ? {} : { projectId: config.projectId }),
    ...(config.keyFilename === undefined ? {} : { keyFilename: config.keyFilename }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
    ...(config.apiEndpoint === undefined ? {} : { apiEndpoint: config.apiEndpoint }),
    retryOptions: { idempotencyStrategy: sdk.IdempotencyStrategy.RetryAlways },
  })
  const bucket = storage.bucket(bucketName)

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      requireObjectKey(key)
      try {
        await bucket.file(`${root}${key}`).save(data, { resumable: false, contentType: GCS_CONTENT_TYPE })
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key, error)
      }
    },

    async saveIfAbsent(key: string, data: Uint8Array): Promise<boolean> {
      requireObjectKey(key)
      try {
        await bucket.file(`${root}${key}`).save(data, {
          resumable: false,
          contentType: GCS_CONTENT_TYPE,
          preconditionOpts: { ifGenerationMatch: 0 },
        })
        return true
      } catch (error) {
        if (isPreconditionFailed(error)) return false
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key, error)
      }
    },

    async load(key: string): Promise<Uint8Array | null> {
      requireObjectKey(key)
      return readObject(bucket.file(`${root}${key}`), key)
    },

    async saveStream(key: string, data: AsyncIterable<Uint8Array>, length: number): Promise<void> {
      requireObjectKey(key)
      try {
        requireStreamLength(key, length)
        const counted = countedChunks(key, data, length)
        const file = bucket.file(`${root}${key}`)
        if (length <= OBJECT_STORE_PART_BYTES) {
          await file.save(await readWhole(counted, length), { resumable: false, contentType: GCS_CONTENT_TYPE })
          return
        }
        await pipeline(
          Readable.from(counted, { objectMode: false }),
          file.createWriteStream({
            resumable: true,
            chunkSize: OBJECT_STORE_PART_BYTES,
            contentType: GCS_CONTENT_TYPE,
          }),
        )
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key, error)
      }
    },

    async loadStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
      requireObjectKey(key)
      return openObjectStream(bucket.file(`${root}${key}`), key)
    },

    async delete(key: string): Promise<void> {
      requireObjectKey(key)
      const file = bucket.file(`${root}${key}`)
      try {
        const [metadata] = await file.getMetadata()
        const generation = metadata.generation
        if (generation === undefined) {
          throw new NarsilError(
            ErrorCodes.PERSISTENCE_DELETE_FAILED,
            `Cloud Storage reported no generation for "${key}", so the adapter deletes nothing`,
            { key },
          )
        }
        await file.delete({ ignoreNotFound: true, ifGenerationMatch: generation })
      } catch (error) {
        if (isNotFound(error) || isPreconditionFailed(error)) return
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_DELETE_FAILED, 'delete', key, error)
      }
    },

    async list(prefix: string): Promise<string[]> {
      const keys: string[] = []
      let pageToken: string | undefined
      try {
        do {
          const [files, next] = await bucket.getFiles({
            prefix: `${root}${prefix}`,
            autoPaginate: false,
            maxResults: OBJECT_STORE_LIST_PAGE_KEYS,
            ...(pageToken === undefined ? {} : { pageToken }),
          })
          for (const file of files) {
            if (file.name.startsWith(root)) keys.push(file.name.slice(root.length))
          }
          const token = next !== null && typeof next === 'object' && 'pageToken' in next ? next.pageToken : undefined
          pageToken = typeof token === 'string' && token.length > 0 ? token : undefined
        } while (pageToken !== undefined)
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'list the keys under', prefix, error)
      }
      return keys
    },
  }
}
