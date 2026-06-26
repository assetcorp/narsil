import { detectRuntime } from '../runtime/detect'
import { crc32Final, crc32Init, crc32Update } from './crc32'
import type { ChecksumWorkerMessage } from './crc32-worker'

const CHECKSUM_TIMEOUT_MS = 120_000
const YIELD_CHUNK_BYTES = 4 * 1024 * 1024

export interface ChecksumResult {
  checksum: number
  payload: Uint8Array
}

interface WorkerHandle {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void
  on(event: string, handler: (...args: unknown[]) => void): void
  terminate(): void | Promise<void>
}

let workerUsable = true
let failNextWorkerForTests = false

function resolveWorkerEntryPoint(): string {
  const base = import.meta.url
  const distIndex = base.lastIndexOf('/dist/')
  if (distIndex !== -1) {
    return new URL('serialization/crc32-worker.mjs', base.slice(0, distIndex + 6)).href
  }
  return base.replace(/\/src\/serialization\/[^/]+$/, '/dist/serialization/crc32-worker.mjs')
}

async function spawnWorker(): Promise<WorkerHandle | null> {
  try {
    const workerThreads = await import('node:worker_threads')
    return new workerThreads.Worker(new URL(resolveWorkerEntryPoint())) as unknown as WorkerHandle
  } catch {
    return null
  }
}

function yieldToEventLoop(): Promise<void> {
  if (typeof setImmediate === 'function') {
    return new Promise<void>(resolve => setImmediate(resolve))
  }
  return new Promise<void>(resolve => setTimeout(resolve, 0))
}

async function chunkedChecksum(payload: Uint8Array): Promise<number> {
  let state = crc32Init()
  for (let offset = 0; offset < payload.length; offset += YIELD_CHUNK_BYTES) {
    const end = Math.min(offset + YIELD_CHUNK_BYTES, payload.length)
    state = crc32Update(state, payload.subarray(offset, end))
    if (end < payload.length) {
      await yieldToEventLoop()
    }
  }
  return crc32Final(state)
}

function runWorkerChecksum(worker: WorkerHandle, payload: Uint8Array): Promise<ChecksumResult> {
  return new Promise<ChecksumResult>((resolve, reject) => {
    let settled = false

    const timeoutId = setTimeout(
      () => settle(() => reject(new Error(`Checksum worker timed out after ${CHECKSUM_TIMEOUT_MS}ms`))),
      CHECKSUM_TIMEOUT_MS,
    )
    if (typeof (timeoutId as { unref?: () => void }).unref === 'function') {
      ;(timeoutId as { unref: () => void }).unref()
    }

    function settle(action: () => void): void {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      try {
        void worker.terminate()
      } catch {
        /* termination failure is non-critical; the timeout is already cleared */
      }
      action()
    }

    worker.on('message', (msg: unknown) => {
      const response = msg as ChecksumWorkerMessage
      if (response.type === 'success') {
        const returned = new Uint8Array(response.buffer, response.byteOffset, response.byteLength)
        settle(() => resolve({ checksum: response.checksum >>> 0, payload: returned }))
      } else {
        settle(() => reject(new Error(response.message)))
      }
    })

    worker.on('error', (err: unknown) => {
      settle(() => reject(err instanceof Error ? err : new Error('Checksum worker failed')))
    })

    try {
      const buffer = payload.buffer as ArrayBuffer
      worker.postMessage({ buffer, byteOffset: payload.byteOffset, byteLength: payload.byteLength }, [buffer])
    } catch (err) {
      settle(() => reject(err instanceof Error ? err : new Error('Failed to post message to checksum worker')))
    }
  })
}

export async function computeOffThreadChecksum(payload: Uint8Array): Promise<ChecksumResult> {
  if (failNextWorkerForTests) {
    failNextWorkerForTests = false
    workerUsable = false
    throw new Error('simulated checksum worker failure')
  }
  if (detectRuntime().supportsWorkerThreads && workerUsable) {
    const worker = await spawnWorker()
    if (worker !== null) {
      try {
        return await runWorkerChecksum(worker, payload)
      } catch {
        workerUsable = false
        throw new Error(
          'Checksum worker failed mid-transfer; the snapshot payload was consumed and the checkpoint must retry',
        )
      }
    }
    workerUsable = false
  }
  return { checksum: await chunkedChecksum(payload), payload }
}

export function resetChecksumWorkerLatch(): void {
  workerUsable = true
  failNextWorkerForTests = false
}

export function __failNextChecksumWorkerForTests(): void {
  failNextWorkerForTests = true
}
