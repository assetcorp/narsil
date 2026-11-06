import {
  createNarsil,
  type Narsil,
  NarsilError,
  registerPartialWordSearch,
  registerPatternSearch,
  registerSynonyms,
} from '@delali/narsil'
import { createIndexedDBPersistence } from '@delali/narsil/adapters/indexeddb'
import { createBroadcastChannelInvalidation } from '@delali/narsil/invalidation/broadcast-channel'
import { partialWordSearch } from '@delali/narsil/partial-words'
import { patternSearch } from '@delali/narsil/pattern'
import { synonyms } from '@delali/narsil/synonyms'
import type { DatasetLoadProgress } from '@delali/narsil-example-shared'
import { createHandlers } from './handlers'
import { registerDemoLanguages } from './languages'
import { registerLocalModels } from './local-adapters'
import { transferableBuffersIn, type WorkerOutbound, type WorkerRequest } from './protocol'
import { listenForRelayedWrites } from './sync-relay'

const PERSISTENCE_DB_NAME = 'narsil-browser-demo'
const INVALIDATION_CHANNEL_NAME = 'narsil-browser-demo-invalidation'

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
    registerPatternSearch(patternSearch)
    registerPartialWordSearch(partialWordSearch)
    registerSynonyms(synonyms)
    const instance = await createNarsil({
      persistence: createIndexedDBPersistence({ dbName: PERSISTENCE_DB_NAME }),
      invalidation: createBroadcastChannelInvalidation({ channelName: INVALIDATION_CHANNEL_NAME }),
    })
    registerLocalModels(instance)
    instance.on('write', ({ indexName }) => post({ kind: 'changed', indexName }))
    listenForRelayedWrites()
    engine = instance
    return instance
  })()

  starting.catch(() => {
    starting = null
  })
  return starting
}

function post(message: WorkerOutbound): void {
  const transfer = message.kind === 'result' ? transferableBuffersIn([message.result]) : []
  self.postMessage(message, { transfer })
}

function reportProgress(progress: DatasetLoadProgress): void {
  post({ kind: 'progress', progress })
}

const HANDLERS = createHandlers(reportProgress)

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
