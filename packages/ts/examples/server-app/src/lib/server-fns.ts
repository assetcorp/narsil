import type { QueryRequest, SuggestRequest } from '@delali/narsil-example-shared/backend'
import { createServerFn } from '@tanstack/react-start'
import type { StoredThreadWire } from './chat/types'

export const queryFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as QueryRequest)
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    return backend.query(data)
  })

export const suggestFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as SuggestRequest)
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    return backend.suggest(data)
  })

export const getStatsFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    return backend.getStats(data.indexName)
  })

export const getPartitionStatsFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    return backend.getPartitionStats(data.indexName)
  })

export const getMemoryStatsFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { getBackend } = await import('./get-backend')
  const backend = await getBackend()
  return backend.getMemoryStats()
})

export const listIndexesFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { getBackend } = await import('./get-backend')
  const backend = await getBackend()
  return backend.listIndexes()
})

export const deleteIndexFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    await backend.deleteIndex(data.indexName)
  })

export const askCapabilitiesFn = createServerFn({ method: 'POST' }).handler(async () => {
  const [{ readLlmConfig }, { readEmbeddingConfig }] = await Promise.all([
    import('./ask/config'),
    import('./embedding-config'),
  ])
  const llm = readLlmConfig()
  const embeddings = readEmbeddingConfig()
  return {
    llmConfigured: llm !== null,
    llmModel: llm?.model ?? null,
    embeddingsConfigured: embeddings !== null,
    embeddingModel: embeddings?.model ?? null,
    embeddingDimensions: embeddings?.dimensions ?? null,
  }
})

export const getDocumentFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string; docId: string })
  .handler(async ({ data }) => {
    const { getBackend } = await import('./get-backend')
    const backend = await getBackend()
    const document = await backend.getDocument(data.indexName, data.docId)
    return document as Record<string, NonNullable<unknown>> | null
  })

export const listThreadsFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { listThreads } = await import('./chat/store')
  return listThreads()
})

export const loadThreadFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { id: string })
  .handler(async ({ data }): Promise<StoredThreadWire | null> => {
    const { loadThread } = await import('./chat/store')
    return (await loadThread(data.id)) as StoredThreadWire | null
  })

export const deleteThreadFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { id: string })
  .handler(async ({ data }) => {
    const { deleteThread } = await import('./chat/store')
    await deleteThread(data.id)
  })
