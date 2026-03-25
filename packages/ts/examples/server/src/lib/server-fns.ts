import type { QueryRequest, SuggestRequest } from '@delali/narsil-example-shared/backend'
import { createServerFn } from '@tanstack/react-start'

const BACKEND_KEY = Symbol.for('narsil-server-backend')
const g = globalThis as unknown as Record<symbol, import('./server-backend').ServerBackend | undefined>

async function getBackend() {
  if (g[BACKEND_KEY]) return g[BACKEND_KEY]
  const { ServerBackend } = await import('./server-backend')
  const instance = new ServerBackend()
  g[BACKEND_KEY] = instance
  return instance
}

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
