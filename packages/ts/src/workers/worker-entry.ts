declare const self: unknown

import type { WorkerAction, WorkerResponse } from './protocol'
import { isValidWorkerAction } from './protocol'

export function startWorker(): void {
  setup().catch(err => {
    console.error('Narsil worker setup failed:', err)
  })
}

async function setup(): Promise<void> {
  let parentPort: {
    on: (event: string, handler: (msg: unknown) => void) => void
    postMessage: (msg: unknown) => void
    close: () => void
  } | null = null

  try {
    const workerThreads = await import('node:worker_threads')
    parentPort = workerThreads.parentPort ?? null
  } catch {
    parentPort = null
  }

  const { createDirectExecutor } = await import('./direct-executor')
  const executor = createDirectExecutor()

  function buildErrorResponse(requestId: string, code: string, message: string): WorkerResponse {
    return { type: 'error', requestId, code, message }
  }

  function buildSuccessResponse(requestId: string, data: unknown): WorkerResponse {
    return { type: 'success', requestId, data }
  }

  async function handleAction(action: WorkerAction, postFn: (msg: WorkerResponse) => void) {
    if (action.type === 'shutdown') {
      await executor.shutdown()
      postFn(buildSuccessResponse(action.requestId, undefined))
      return true
    }

    try {
      const result = await executor.execute(action)
      postFn(buildSuccessResponse(action.requestId, result))
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code ?? 'UNKNOWN_ERROR'
      const message = err instanceof Error ? err.message : String(err)
      postFn(buildErrorResponse(action.requestId, code, message))
    }

    return false
  }

  if (parentPort) {
    const port = parentPort
    port.on('message', (raw: unknown) => {
      if (!isValidWorkerAction(raw)) {
        const requestId = (raw as { requestId?: string })?.requestId ?? 'unknown'
        port.postMessage(buildErrorResponse(requestId, 'INVALID_ACTION', 'Received an invalid worker action'))
        return
      }

      handleAction(raw, msg => port.postMessage(msg)).then(shouldClose => {
        if (shouldClose) {
          port.close()
        }
      })
    })
    return
  }

  const globalSelf = typeof self !== 'undefined' ? self : undefined
  if (globalSelf && typeof (globalSelf as { postMessage?: unknown }).postMessage === 'function') {
    const webSelf = globalSelf as unknown as {
      onmessage: ((event: { data: unknown }) => void) | null
      postMessage: (msg: unknown) => void
      close: () => void
    }

    webSelf.onmessage = (event: { data: unknown }) => {
      const raw = event.data
      if (!isValidWorkerAction(raw)) {
        const requestId = (raw as { requestId?: string })?.requestId ?? 'unknown'
        webSelf.postMessage(buildErrorResponse(requestId, 'INVALID_ACTION', 'Received an invalid worker action'))
        return
      }

      handleAction(raw, msg => webSelf.postMessage(msg)).then(shouldClose => {
        if (shouldClose) {
          webSelf.close()
        }
      })
    }
  }
}
