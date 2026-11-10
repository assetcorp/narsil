import type { EmbeddingAdapter, Narsil, RerankAdapter } from '@delali/narsil'
import {
  PLACES_EMBEDDING_ADAPTER_NAME,
  PLACES_EMBEDDING_DIMENSIONS,
  RERANK_ADAPTER_NAME,
  RERANK_DTYPE,
  RERANK_MODEL,
} from './local-models'

interface LoadedOnFirstUse<T> {
  get: () => Promise<T>
  loaded: () => T | null
}

function loadOnFirstUse<T>(load: () => Promise<T>): LoadedOnFirstUse<T> {
  let pending: Promise<T> | null = null
  let ready: T | null = null
  return {
    get() {
      if (ready !== null) return Promise.resolve(ready)
      if (pending === null) {
        pending = load().then(
          value => {
            ready = value
            return value
          },
          (err: unknown) => {
            pending = null
            throw err
          },
        )
      }
      return pending
    },
    loaded: () => ready,
  }
}

function lazyPlacesEmbedding(): EmbeddingAdapter {
  const adapter = loadOnFirstUse(async () => {
    const { createPlacesEmbedding } = await import('./local-embedding')
    return createPlacesEmbedding()
  })
  return {
    dimensions: PLACES_EMBEDDING_DIMENSIONS,
    async embed(input, purpose, signal) {
      return (await adapter.get()).embed(input, purpose, signal)
    },
    async embedBatch(inputs, purpose, signal) {
      return (await adapter.get()).embedBatch(inputs, purpose, signal)
    },
    async shutdown() {
      await adapter.loaded()?.shutdown()
    },
  }
}

function lazyCrossEncoder(): RerankAdapter {
  const adapter = loadOnFirstUse(async () => {
    const { createTransformersReranker } = await import('@delali/narsil-embeddings-transformers/reranker')
    return createTransformersReranker({ model: RERANK_MODEL, dtype: RERANK_DTYPE })
  })
  return {
    async rerank(query, documents, signal) {
      return (await adapter.get()).rerank(query, documents, signal)
    },
    async shutdown() {
      await adapter.loaded()?.shutdown()
    },
  }
}

export function registerLocalModels(engine: Narsil): void {
  engine.registerEmbeddingAdapter(PLACES_EMBEDDING_ADAPTER_NAME, lazyPlacesEmbedding())
  engine.registerRerankAdapter(RERANK_ADAPTER_NAME, lazyCrossEncoder())
}
