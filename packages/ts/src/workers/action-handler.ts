import { ErrorCodes, isNarsilError, NarsilError } from '../errors'
import type { DirectExecutorExtensions } from './direct-executor'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'

export type ActionHandler = (action: WorkerAction, post: (msg: WorkerResponse) => void) => Promise<boolean>

export function buildErrorResponse(
  requestId: string,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): WorkerResponse {
  return details === undefined || Object.keys(details).length === 0
    ? { type: 'error', requestId, code, message }
    : { type: 'error', requestId, code, message, details }
}

function buildSuccessResponse(requestId: string, data: unknown): WorkerResponse {
  return { type: 'success', requestId, data }
}

async function importBootstrapModule(moduleUrl: string): Promise<void> {
  if (typeof moduleUrl !== 'string' || moduleUrl.trim().length === 0) {
    throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'A bootstrap module needs a non-empty module URL', {
      moduleUrl,
    })
  }

  await import(moduleUrl)
}

async function stopServingRequests(): Promise<void> {
  const { drainRequestThread } = await import('../server/request-threads/thread')
  await drainRequestThread()
  const { closeLongQueryThread } = await import('../server/request-threads/long-query-thread')
  closeLongQueryThread()
}

function holdsCopies(
  executor: Executor & Partial<DirectExecutorExtensions>,
): executor is Executor & DirectExecutorExtensions {
  return typeof executor.queryContextOf === 'function'
}

export function createActionHandler(executor: Executor & Partial<DirectExecutorExtensions>): ActionHandler {
  let servingRequests = false
  let stopping = false
  const serving: { start: Promise<void> | null } = { start: null }
  const copyChanges = new Map<string, Promise<void>>()

  function executeCopyAction(action: WorkerAction): Promise<unknown> {
    if (!('indexName' in action)) return executor.execute(action)
    const indexName = action.indexName
    const previous = copyChanges.get(indexName)
    const result = previous === undefined ? executor.execute(action) : previous.then(() => executor.execute(action))
    if (action.type === 'createIndex' || action.type === 'dropIndex') {
      const settled = result.then(
        () => undefined,
        () => undefined,
      )
      copyChanges.set(indexName, settled)
      void settled.then(() => {
        if (copyChanges.get(indexName) === settled) copyChanges.delete(indexName)
      })
    }
    return result
  }

  async function stopServingOnceStarted(): Promise<void> {
    if (serving.start !== null) await serving.start
    if (servingRequests) await stopServingRequests()
    servingRequests = false
  }

  return async function handleAction(action, post) {
    if (action.type === 'probe') {
      post(buildSuccessResponse(action.requestId, undefined))
      return false
    }
    try {
      if (stopping) throw new NarsilError(ErrorCodes.WORKER_CRASHED, 'The worker is shutting down')
      if (action.type === 'shutdown') {
        stopping = true
        await stopServingOnceStarted()
        await Promise.all(copyChanges.values())
        await executor.shutdown()
        post(buildSuccessResponse(action.requestId, undefined))
        return true
      }
      if (action.type === 'bootstrap') {
        await importBootstrapModule(action.moduleUrl)
        post(buildSuccessResponse(action.requestId, undefined))
        return false
      }

      if (action.type === 'serveRequests') {
        if (!holdsCopies(executor)) {
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'This executor holds no copies to answer requests from')
        }
        const starting = import('../server/request-threads/thread').then(({ serveRequests }) =>
          serveRequests(executor, action.settings),
        )
        serving.start = starting.then(
          () => {
            servingRequests = true
          },
          () => undefined,
        )
        const result = await starting
        post(buildSuccessResponse(action.requestId, result))
        return false
      }

      if (action.type === 'serveLongQueries') {
        if (!holdsCopies(executor)) {
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'This executor holds no copies to answer long queries from')
        }
        const { serveLongQueries } = await import('../server/request-threads/long-query-thread')
        serveLongQueries(executor, action.settings)
        servingRequests = true
        post(buildSuccessResponse(action.requestId, undefined))
        return false
      }

      if (action.type === 'stopServing') {
        await stopServingOnceStarted()
        post(buildSuccessResponse(action.requestId, undefined))
        return false
      }

      const result = await executeCopyAction(action)
      post(buildSuccessResponse(action.requestId, result))
    } catch (err: unknown) {
      const failure = isNarsilError(err) ? err : null
      const code = failure?.code ?? ErrorCodes.WORKER_ACTION_FAILED
      const message = err instanceof Error ? err.message : String(err)
      post(buildErrorResponse(action.requestId, code, message, failure?.details))
    }

    return false
  }
}
