import { ErrorCodes, NarsilError } from '../errors'
import type { PersistenceAdapter } from '../types/adapters'
import { OBJECT_STORE_LIST_PAGE_KEYS, OBJECT_STORE_PART_BYTES } from './constants'
import {
  countedChunks,
  objectKeyPrefix,
  objectStoreFailure,
  partsOf,
  readWhole,
  refuseOversizedObject,
  requireBucket,
  requireObjectKey,
  requireStreamLength,
} from './object-store'

type S3Module = typeof import('@aws-sdk/client-s3')
type S3Client = import('@aws-sdk/client-s3').S3Client

const S3_NOT_FOUND_STATUS = 404

/**
 * The access keys {@link createS3Persistence} signs its requests with.
 *
 * @public
 */
export interface S3Credentials {
  /** The access key ID. */
  accessKeyId: string
  /** The secret access key. */
  secretAccessKey: string
  /** The session token of temporary credentials, which long-lived keys leave out. */
  sessionToken?: string
}

/**
 * Where {@link createS3Persistence} stores its objects, and how it reaches the store.
 *
 * @public
 */
export interface S3PersistenceConfig {
  /** The adapter writes every object to this bucket. */
  bucket: string
  /** The bucket's region, which the SDK otherwise reads from the environment. */
  region?: string
  /** The address of an S3-compatible service, which you leave out for Amazon S3 itself. */
  endpoint?: string
  /** Puts the bucket name in the path of each request, which most S3-compatible services need. */
  forcePathStyle?: boolean
  /** The keys to sign with, which the SDK otherwise reads from its default credential chain. */
  credentials?: S3Credentials
  /** The adapter stores every key under this prefix inside the bucket, so several stores can share one bucket. */
  keyPrefix?: string
  /** The SDK tries each request this many times before it reports the failure. */
  maxAttempts?: number
}

async function loadS3Module(): Promise<S3Module> {
  try {
    return await import('@aws-sdk/client-s3')
  } catch (err) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_DEPENDENCY_MISSING,
      'The `@aws-sdk/client-s3` package is not installed. Install it with `pnpm add @aws-sdk/client-s3` (or the npm or yarn equivalent) to use createS3Persistence.',
      { cause: err instanceof Error ? err.message : String(err) },
    )
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const named = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }
  return (
    named.name === 'NoSuchKey' || named.name === 'NotFound' || named.$metadata?.httpStatusCode === S3_NOT_FOUND_STATUS
  )
}

function discardBody(body: unknown): void {
  if (typeof body === 'object' && body !== null && 'destroy' in body && typeof body.destroy === 'function') {
    body.destroy()
  }
}

interface ObjectTarget {
  sdk: S3Module
  client: S3Client
  bucket: string
  objectKey: string
}

async function uploadParts(target: ObjectTarget, parts: AsyncIterator<Uint8Array>, first: Uint8Array) {
  const { sdk, client, bucket, objectKey } = target
  const created = await client.send(new sdk.CreateMultipartUploadCommand({ Bucket: bucket, Key: objectKey }))
  const uploadId = created.UploadId
  if (uploadId === undefined) {
    throw new NarsilError(
      ErrorCodes.PERSISTENCE_SAVE_FAILED,
      `The object store started a multipart upload of "${objectKey}" without an upload ID`,
      { key: objectKey },
    )
  }
  try {
    const completed: Array<{ ETag: string | undefined; PartNumber: number }> = []
    let part: Uint8Array | undefined = first
    while (part !== undefined) {
      const PartNumber = completed.length + 1
      const sent = await client.send(
        new sdk.UploadPartCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploadId,
          PartNumber,
          Body: part,
          ContentLength: part.byteLength,
        }),
      )
      completed.push({ ETag: sent.ETag, PartNumber })
      const next: IteratorResult<Uint8Array> = await parts.next()
      part = next.done === true ? undefined : next.value
    }
    await client.send(
      new sdk.CompleteMultipartUploadCommand({
        Bucket: bucket,
        Key: objectKey,
        UploadId: uploadId,
        MultipartUpload: { Parts: completed },
      }),
    )
  } catch (error) {
    await client
      .send(new sdk.AbortMultipartUploadCommand({ Bucket: bucket, Key: objectKey, UploadId: uploadId }))
      .catch(() => undefined)
    throw error
  }
}

async function saveObjectStream(target: ObjectTarget, key: string, data: AsyncIterable<Uint8Array>, length: number) {
  requireStreamLength(key, length)
  const counted = countedChunks(key, data, length)
  if (length <= OBJECT_STORE_PART_BYTES) {
    const body = await readWhole(counted, length)
    await target.client.send(
      new target.sdk.PutObjectCommand({
        Bucket: target.bucket,
        Key: target.objectKey,
        Body: body,
        ContentLength: length,
      }),
    )
    return
  }
  const parts = partsOf(counted, OBJECT_STORE_PART_BYTES)[Symbol.asyncIterator]()
  const first = await parts.next()
  if (first.done === true) {
    throw new NarsilError(ErrorCodes.PERSISTENCE_SAVE_FAILED, `The stream for "${key}" ended before its first part`, {
      key,
    })
  }
  await uploadParts(target, parts, first.value)
}

async function* bodyChunks(body: { transformToWebStream(): ReadableStream<Uint8Array> }): AsyncGenerator<Uint8Array> {
  const reader = body.transformToWebStream().getReader()
  try {
    for (;;) {
      const step = await reader.read()
      if (step.done) return
      yield step.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

async function* failingAs(
  key: string,
  chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  try {
    yield* chunks
  } catch (error) {
    throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error)
  }
}

/**
 * Builds a persistence adapter that stores each key as one object in an S3 bucket, or in any service that speaks
 * the S3 protocol.
 *
 * Cluster backups use it as the store outside the cluster. The adapter loads `@aws-sdk/client-s3`, an optional
 * peer dependency, when you call this function, and it refuses to load an object larger than one stored file can be.
 *
 * @param config - The bucket, the region or endpoint, and the credentials.
 * @returns An adapter you pass wherever Narsil takes a {@link PersistenceAdapter}.
 * @throws A `NarsilError` with `PERSISTENCE_DEPENDENCY_MISSING` and the install command when the SDK is missing, and
 * with `CONFIG_INVALID` when the bucket name is empty.
 *
 * @public
 */
export async function createS3Persistence(config: S3PersistenceConfig): Promise<PersistenceAdapter> {
  const bucket = requireBucket(config.bucket, 'S3')
  const root = objectKeyPrefix(config.keyPrefix, 'S3')
  const sdk = await loadS3Module()
  const client = new sdk.S3Client({
    ...(config.region === undefined ? {} : { region: config.region }),
    ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    ...(config.forcePathStyle === undefined ? {} : { forcePathStyle: config.forcePathStyle }),
    ...(config.credentials === undefined ? {} : { credentials: config.credentials }),
    ...(config.maxAttempts === undefined ? {} : { maxAttempts: config.maxAttempts }),
  })

  return {
    async save(key: string, data: Uint8Array): Promise<void> {
      requireObjectKey(key)
      try {
        await client.send(
          new sdk.PutObjectCommand({
            Bucket: bucket,
            Key: `${root}${key}`,
            Body: data,
            ContentLength: data.byteLength,
          }),
        )
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key, error)
      }
    },

    async load(key: string): Promise<Uint8Array | null> {
      requireObjectKey(key)
      try {
        const object = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: `${root}${key}` }))
        try {
          refuseOversizedObject(key, object.ContentLength ?? 0)
        } catch (error) {
          discardBody(object.Body)
          throw error
        }
        if (object.Body === undefined) return new Uint8Array(0)
        const bytes = await object.Body.transformToByteArray()
        refuseOversizedObject(key, bytes.byteLength)
        return bytes
      } catch (error) {
        if (isNotFound(error)) return null
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error)
      }
    },

    async saveStream(key: string, data: AsyncIterable<Uint8Array>, length: number): Promise<void> {
      requireObjectKey(key)
      try {
        await saveObjectStream({ sdk, client, bucket, objectKey: `${root}${key}` }, key, data, length)
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_SAVE_FAILED, 'save', key, error)
      }
    },

    async loadStream(key: string): Promise<AsyncIterable<Uint8Array> | null> {
      requireObjectKey(key)
      try {
        const object = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: `${root}${key}` }))
        try {
          refuseOversizedObject(key, object.ContentLength ?? 0)
        } catch (error) {
          discardBody(object.Body)
          throw error
        }
        const body = object.Body
        if (body === undefined) return failingAs(key, [])
        return failingAs(key, bodyChunks(body))
      } catch (error) {
        if (isNotFound(error)) return null
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'load', key, error)
      }
    },

    async delete(key: string): Promise<void> {
      requireObjectKey(key)
      try {
        await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: `${root}${key}` }))
      } catch (error) {
        if (isNotFound(error)) return
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_DELETE_FAILED, 'delete', key, error)
      }
    },

    async list(prefix: string): Promise<string[]> {
      const keys: string[] = []
      let continuationToken: string | undefined
      try {
        do {
          const page = await client.send(
            new sdk.ListObjectsV2Command({
              Bucket: bucket,
              Prefix: `${root}${prefix}`,
              MaxKeys: OBJECT_STORE_LIST_PAGE_KEYS,
              ...(continuationToken === undefined ? {} : { ContinuationToken: continuationToken }),
            }),
          )
          for (const object of page.Contents ?? []) {
            if (object.Key?.startsWith(root) === true) keys.push(object.Key.slice(root.length))
          }
          continuationToken = page.IsTruncated === true ? page.NextContinuationToken : undefined
        } while (continuationToken !== undefined)
      } catch (error) {
        throw objectStoreFailure(ErrorCodes.PERSISTENCE_LOAD_FAILED, 'list the keys under', prefix, error)
      }
      return keys
    },
  }
}
