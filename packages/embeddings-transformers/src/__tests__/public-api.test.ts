import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { env } from '@huggingface/transformers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTransformersEmbedding } from '../index'
import { createTransformersReranker } from '../reranker'

const ABSENT_MODEL = 'narsil-tests/absent-model'
const DIMENSIONS = 384

const originalAllowRemoteModels = env.allowRemoteModels
const originalCacheDir = env.cacheDir
const emptyCacheDir = mkdtempSync(join(tmpdir(), 'narsil-embeddings-transformers-'))

beforeAll(() => {
  env.allowRemoteModels = false
  env.cacheDir = emptyCacheDir
})

afterAll(() => {
  env.allowRemoteModels = originalAllowRemoteModels
  env.cacheDir = originalCacheDir
  rmSync(emptyCacheDir, { recursive: true, force: true })
})

function embeddingWithoutModel() {
  return createTransformersEmbedding({ dimensions: DIMENSIONS, model: ABSENT_MODEL })
}

function rerankerWithoutModel() {
  return createTransformersReranker({ model: ABSENT_MODEL })
}

function abortedSignal(reason: Error): AbortSignal {
  const controller = new AbortController()
  controller.abort(reason)
  return controller.signal
}

describe('reranker settings refused before any model loads', () => {
  const badWholeNumbers: unknown[] = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '8', null, {}]

  it.each(badWholeNumbers)('refuses a batchSize of %j', batchSize => {
    expect(() => createTransformersReranker({ batchSize: batchSize as number })).toThrow(/batchSize.*whole number/)
  })

  it.each(badWholeNumbers)('refuses a maxLength of %j', maxLength => {
    expect(() => createTransformersReranker({ maxLength: maxLength as number })).toThrow(/maxLength.*whole number/)
  })

  it('accepts the smallest whole numbers and leaves the model unloaded', async () => {
    const reranker = createTransformersReranker({ model: ABSENT_MODEL, batchSize: 1, maxLength: 1 })
    await expect(reranker.rerank('query', [])).resolves.toEqual([])
  })
})

describe('calls that finish before any model loads', () => {
  it('reports the configured dimensions while the model is unloaded', () => {
    expect(embeddingWithoutModel().dimensions).toBe(DIMENSIONS)
  })

  it.each(['document', 'query'] as const)('gives no vectors for an empty %s batch', async purpose => {
    await expect(embeddingWithoutModel().embedBatch([], purpose)).resolves.toEqual([])
  })

  it('gives no scores for an empty document list', async () => {
    await expect(rerankerWithoutModel().rerank('query', [])).resolves.toEqual([])
  })

  it('rejects embed with the reason of a signal that has already aborted', async () => {
    const reason = new Error('the caller cancelled the embedding')
    await expect(embeddingWithoutModel().embed('text', 'document', abortedSignal(reason))).rejects.toBe(reason)
  })

  it('rejects embedBatch with the reason of a signal that has already aborted', async () => {
    const reason = new Error('the caller cancelled the batch')
    await expect(embeddingWithoutModel().embedBatch(['text'], 'query', abortedSignal(reason))).rejects.toBe(reason)
  })

  it('rejects rerank with the reason of a signal that has already aborted', async () => {
    const reason = new Error('the caller cancelled the rerank')
    await expect(rerankerWithoutModel().rerank('query', ['text'], abortedSignal(reason))).rejects.toBe(reason)
  })

  it('shuts down an embedding adapter and a reranker that never loaded, twice over', async () => {
    const embedding = embeddingWithoutModel()
    const reranker = rerankerWithoutModel()
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(embedding.shutdown()).resolves.toBeUndefined()
      await expect(reranker.shutdown()).resolves.toBeUndefined()
    }
  })
})

describe('a model that the library cannot load', () => {
  const unloadableModels: unknown[] = [ABSENT_MODEL, '../../../outside-the-model-directory', 'not a model id', 42]

  it.each(unloadableModels)('rejects every embedding call for the model %j, and shuts down', async model => {
    const adapter = createTransformersEmbedding({ dimensions: DIMENSIONS, model: model as string })
    await expect(adapter.embed('text', 'document')).rejects.toThrow()
    await expect(adapter.embedBatch(['text'], 'document')).rejects.toThrow()
    await expect(adapter.shutdown()).resolves.toBeUndefined()
    await expect(adapter.shutdown()).resolves.toBeUndefined()
  })

  it.each(unloadableModels)('rejects every rerank call for the model %j, and shuts down', async model => {
    const reranker = createTransformersReranker({ model: model as string })
    await expect(reranker.rerank('query', ['text'])).rejects.toThrow()
    await expect(reranker.rerank('query', ['text'])).rejects.toThrow()
    await expect(reranker.shutdown()).resolves.toBeUndefined()
    await expect(reranker.shutdown()).resolves.toBeUndefined()
  })
})
