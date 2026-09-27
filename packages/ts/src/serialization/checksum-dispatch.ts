import { nativeCrc32 } from '#platform/native-crc32'
import { isNodeMainThread, spawnNodeWorker } from '#platform/node-worker'
import { detectRuntime } from '../runtime/detect'
import { resolveWorkerEntry } from '../workers/entry-point'
import { CHECKSUM_TIMEOUT_MS, CHECKSUM_YIELD_CHUNK_BYTES } from './constants'
import { crc32Final, crc32Init, crc32Update } from './crc32'
import type { ChecksumWorkerMessage } from './crc32-worker'

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
let mainThreadResolved = false
let onMainThread = true

async function isOnMainThread(): Promise<boolean> {
  if (!mainThreadResolved) {
    onMainThread = await isNodeMainThread()
    mainThreadResolved = true
  }
  return onMainThread
}

async function spawnWorker(): Promise<WorkerHandle | null> {
  const entryPoint = resolveWorkerEntry(
    import.meta.url,
    /\/src\/serialization\/[^/]+$/,
    'serialization/crc32-worker.mjs',
  )
  if (entryPoint === null) return null
  try {
    return await spawnNodeWorker(new URL(entryPoint))
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

async function advanceChecksum(start: number, payload: Uint8Array): Promise<number> {
  let state = start
  for (let offset = 0; offset < payload.length; offset += CHECKSUM_YIELD_CHUNK_BYTES) {
    const end = Math.min(offset + CHECKSUM_YIELD_CHUNK_BYTES, payload.length)
    state = crc32Update(state, payload.subarray(offset, end))
    if (end < payload.length) {
      await yieldToEventLoop()
    }
  }
  return state
}

async function chunkedChecksum(payload: Uint8Array): Promise<number> {
  return crc32Final(await advanceChecksum(crc32Init(), payload))
}

export async function checksumOfChunks(chunks: readonly Uint8Array[]): Promise<number> {
  let state = crc32Init()
  for (const chunk of chunks) state = await advanceChecksum(state, chunk)
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
      } catch {}
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
  if (nativeCrc32 !== null) return { checksum: await chunkedChecksum(payload), payload }
  if (detectRuntime().supportsWorkerThreads && workerUsable && (await isOnMainThread())) {
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
