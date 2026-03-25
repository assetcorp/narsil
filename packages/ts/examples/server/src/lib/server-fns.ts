import type { QueryRequest, SuggestRequest } from '@delali/narsil-example-shared/backend'
import type { LoadDatasetRequest } from '@delali/narsil-example-shared/types'
import { createServerFn } from '@tanstack/react-start'

let backendInstance: import('./server-backend').ServerBackend | null = null

async function getBackend() {
  if (backendInstance) return backendInstance
  const { ServerBackend } = await import('./server-backend')
  backendInstance = new ServerBackend()
  return backendInstance
}

export const loadDatasetFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as LoadDatasetRequest)
  .handler(async ({ data }) => {
    const backend = await getBackend()
    await backend.loadDataset(data)
  })

export const queryFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as QueryRequest)
  .handler(async ({ data }) => {
    const backend = await getBackend()
    return backend.query(data)
  })

export const suggestFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as SuggestRequest)
  .handler(async ({ data }) => {
    const backend = await getBackend()
    return backend.suggest(data)
  })

export const getStatsFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const backend = await getBackend()
    return backend.getStats(data.indexName)
  })

export const getPartitionStatsFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const backend = await getBackend()
    return backend.getPartitionStats(data.indexName)
  })

export const getMemoryStatsFn = createServerFn({ method: 'POST' }).handler(async () => {
  const backend = await getBackend()
  return backend.getMemoryStats()
})

export const listIndexesFn = createServerFn({ method: 'POST' }).handler(async () => {
  const backend = await getBackend()
  return backend.listIndexes()
})

export const deleteIndexFn = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => d as { indexName: string })
  .handler(async ({ data }) => {
    const backend = await getBackend()
    await backend.deleteIndex(data.indexName)
  })
