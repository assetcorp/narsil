import { ErrorCodes, NarsilError } from '../errors'
import type { DirectExecutorExtensions } from './direct-executor'
import type { Executor } from './executor'
import type { WorkerAction, WorkerResponse } from './protocol'

export type ActionHandler = (action: WorkerAction, post: (msg: WorkerResponse) => void) => Promise<boolean>

export function buildErrorResponse(requestId: string, code: string, message: string): WorkerResponse {
  return { type: 'error', requestId, code, message }
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
  const { closeRequestThread } = await import('../server/request-threads/thread')
  closeRequestThread()
}

function holdsCopies(
  executor: Executor & Partial<DirectExecutorExtensions>,
): executor is Executor & DirectExecutorExtensions {
  return typeof executor.queryContextOf === 'function'
}

export function createActionHandler(executor: Executor & Partial<DirectExecutorExtensions>): ActionHandler {
  let servingRequests = false

  return async function handleAction(action, post) {
    if (action.type === 'shutdown') {
      if (servingRequests) await stopServingRequests()
      await executor.shutdown()
      post(buildSuccessResponse(action.requestId, undefined))
      return true
    }

    try {
      if (action.type === 'bootstrap') {
        await importBootstrapModule(action.moduleUrl)
        post(buildSuccessResponse(action.requestId, undefined))
        return false
      }

      if (action.type === 'serveRequests') {
        if (!holdsCopies(executor)) {
          throw new NarsilError(ErrorCodes.CONFIG_INVALID, 'This executor holds no copies to answer requests from')
        }
        const { serveRequests } = await import('../server/request-threads/thread')
        const result = await serveRequests(executor, action.settings)
        servingRequests = true
        post(buildSuccessResponse(action.requestId, result))
        return false
      }

      if (action.type === 'stopServing') {
        if (servingRequests) await stopServingRequests()
        servingRequests = false
        post(buildSuccessResponse(action.requestId, undefined))
        return false
      }

      const result = await executor.execute(action)
      post(buildSuccessResponse(action.requestId, result))
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'UNKNOWN_ERROR'
      const message = err instanceof Error ? err.message : String(err)
      post(buildErrorResponse(action.requestId, code, message))
    }

    return false
  }
}
