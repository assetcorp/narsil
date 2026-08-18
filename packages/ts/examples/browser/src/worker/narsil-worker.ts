import { createNarsil, type Narsil, NarsilError } from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared'
import { loadDataset } from './datasets'
import { registerDemoLanguages } from './languages'
import type { WorkerArgs, WorkerMethod, WorkerOutbound, WorkerRequest } from './protocol'

const PERSISTENCE_DB_NAME = 'narsil-browser-demo'

let engine: Narsil | null = null
let starting: Promise<Narsil> | null = null

/**
 * Starts the engine over IndexedDB persistence. Recovery runs inside
 * `createNarsil`, so every index built in an earlier visit is back before the
 * first call returns.
 */
function getEngine(): Promise<Narsil> {
  if (engine !== null) return Promise.resolve(engine)
  if (starting !== null) return starting

  starting = (async () => {
    registerDemoLanguages()
    const instance = await createNarsil({
      persistence: createIndexedDBPersistence({ dbName: PERSISTENCE_DB_NAME }),
    })
    engine = instance
    return instance
  })()

  starting.catch(() => {
    starting = null
  })
  return starting
}

function post(message: WorkerOutbound): void {
  self.postMessage(message)
}

function reportProgress(progress: DatasetLoadProgress): void {
  post({ kind: 'progress', progress })
}

const HANDLERS: { [K in WorkerMethod]: (instance: Narsil, args: WorkerArgs<K>) => Promise<unknown> } = {
  loadDataset: (instance, [request]) => loadDataset(instance, request, reportProgress),
  query: (instance, [indexName, params]) => instance.query(indexName, params),
  suggest: (instance, [indexName, params]) => instance.suggest(indexName, params),
  listDocuments: (instance, [indexName, params]) => instance.listDocuments(indexName, params),
  getStats: (instance, [indexName]) => Promise.resolve(instance.getStats(indexName)),
  getPartitionStats: (instance, [indexName]) => Promise.resolve(instance.getPartitionStats(indexName)),
  getMemoryStats: instance => instance.getMemoryStats(),
  vectorMaintenanceStatus: (instance, [indexName]) => Promise.resolve(instance.vectorMaintenanceStatus(indexName)),
  listIndexes: instance => Promise.resolve(instance.listIndexes()),
  dropIndex: async (instance, [indexName]) => {
    await instance.dropIndex(indexName)
    return null
  },
}

function runHandler(instance: Narsil, request: WorkerRequest): Promise<unknown> {
  const handler = HANDLERS[request.method] as (engine: Narsil, args: unknown[]) => Promise<unknown>
  return handler(instance, request.args)
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data
  try {
    const instance = await getEngine()
    const result = await runHandler(instance, request)
    post({ kind: 'result', id: request.id, result: result ?? null })
  } catch (err) {
    post({
      kind: 'failure',
      id: request.id,
      code: err instanceof NarsilError ? err.code : 'CLIENT_UNEXPECTED_ERROR',
      message: err instanceof Error ? err.message : String(err),
    })
  }
}
