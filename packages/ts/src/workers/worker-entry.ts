declare const self: unknown

import { buildErrorResponse, createActionHandler } from './action-handler'
import { isValidWorkerAction } from './protocol'

export function startWorker(): void {
  setup().catch(err => {
    console.error('Narsil worker setup failed:', err)
  })
}

startWorker()

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
  const handleAction = createActionHandler(createDirectExecutor())

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
