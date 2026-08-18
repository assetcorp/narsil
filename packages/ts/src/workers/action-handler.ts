import { ErrorCodes, NarsilError } from '../errors'
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

export function createActionHandler(executor: Executor): ActionHandler {
  return async function handleAction(action, post) {
    if (action.type === 'shutdown') {
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
