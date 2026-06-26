declare const self: unknown

import { crc32 } from './crc32'

export interface ChecksumRequest {
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

export interface ChecksumResponse {
  type: 'success'
  checksum: number
  buffer: ArrayBuffer
  byteOffset: number
  byteLength: number
}

export interface ChecksumError {
  type: 'error'
  message: string
}

export type ChecksumWorkerMessage = ChecksumResponse | ChecksumError

function handleRequest(raw: unknown): ChecksumResponse {
  const request = raw as ChecksumRequest
  if (!(request.buffer instanceof ArrayBuffer)) {
    throw new Error('Checksum request is missing a transferable buffer')
  }
  const { byteOffset, byteLength } = request
  if (!Number.isInteger(byteOffset) || !Number.isInteger(byteLength) || byteOffset < 0 || byteLength < 0) {
    throw new Error('Checksum request has an invalid range')
  }
  if (byteOffset + byteLength > request.buffer.byteLength) {
    throw new Error('Checksum request range exceeds the buffer bounds')
  }
  const checksum = crc32(new Uint8Array(request.buffer, byteOffset, byteLength))
  return { type: 'success', checksum, buffer: request.buffer, byteOffset, byteLength }
}

async function setupAsync(): Promise<void> {
  let parentPort: import('node:worker_threads').MessagePort | null = null

  try {
    const workerThreads = await import('node:worker_threads')
    parentPort = workerThreads.parentPort ?? null
  } catch {
    parentPort = null
  }

  if (parentPort) {
    const port = parentPort
    port.on('message', (raw: unknown) => {
      try {
        const result = handleRequest(raw)
        port.postMessage(result, [result.buffer])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        port.postMessage({ type: 'error', message } satisfies ChecksumError)
      }
    })
    return
  }

  const globalSelf = typeof self !== 'undefined' ? self : undefined
  if (globalSelf && typeof (globalSelf as { postMessage?: unknown }).postMessage === 'function') {
    const webSelf = globalSelf as unknown as {
      onmessage: ((event: { data: unknown }) => void) | null
      postMessage: (msg: unknown, transfer?: ArrayBuffer[]) => void
    }
    webSelf.onmessage = (event: { data: unknown }) => {
      try {
        const result = handleRequest(event.data)
        webSelf.postMessage(result, [result.buffer])
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        webSelf.postMessage({ type: 'error', message } satisfies ChecksumError)
      }
    }
  }
}

function setupWorker(): void {
  setupAsync().catch(err => {
    console.error('Checksum worker setup failed:', err)
  })
}

export { handleRequest }

setupWorker()
