import type { QueryRequest, SuggestRequest } from '@delali/narsil-example-shared/backend'
import { createServerFn } from '@tanstack/react-start'

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
