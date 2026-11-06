import { type NodeWorkerHandle, spawnNodeWorker } from '#platform/node-worker'
import { resolveMergeWorkerEntry } from '#platform/query-merge-worker-entry'
import { ErrorCodes, NarsilError } from '../errors'
import { BYTES_PER_MIB } from './constants'
import { type FileOutcome, type MergeResult, Merger, type MergeSettings } from './merge'
import type { MergeReply, MergeRequest } from './merge-worker'

export interface MergeInput {
  day: string
  bytes: Uint8Array
}

export interface MergeSession {
  addFile(input: MergeInput): Promise<FileOutcome>
  finish(): Promise<MergeResult>
  abandon(): void
}

function mergeFailed(message: string): NarsilError {
  return new NarsilError(ErrorCodes.WORKER_ACTION_FAILED, `The query suggestions merge failed: ${message}`)
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer
  }
  return bytes.slice().buffer
}

function inThreadSession(settings: MergeSettings): MergeSession {
  const merger = new Merger(settings)
  return {
    addFile: input => merger.addFile(input.bytes, input.day),
    finish: async () => merger.result(),
    abandon() {},
  }
}

function workerSession(worker: NodeWorkerHandle, settings: MergeSettings): MergeSession {
  let nextId = 0
  let failure: NarsilError | null = null
  const waiting = new Map<number, { resolve(outcome: FileOutcome): void; reject(error: Error): void }>()
  let finishing: { resolve(result: MergeResult): void; reject(error: Error): void } | null = null

  function failAll(error: NarsilError): void {
    if (failure !== null) return
    failure = error
    for (const pending of waiting.values()) pending.reject(error)
    waiting.clear()
    finishing?.reject(error)
    finishing = null
    void Promise.resolve(worker.terminate()).catch(() => undefined)
  }

  worker.on('message', (raw: unknown) => {
    const reply = raw as MergeReply
    if (reply.type === 'file') {
      const pending = waiting.get(reply.id)
      waiting.delete(reply.id)
      pending?.resolve(reply.outcome)
    } else if (reply.type === 'result') {
      finishing?.resolve(reply.result)
      finishing = null
      void Promise.resolve(worker.terminate()).catch(() => undefined)
    } else failAll(mergeFailed(reply.message))
  })
  worker.on('error', (error: unknown) => failAll(mergeFailed(error instanceof Error ? error.message : String(error))))
  worker.on('exit', () => failAll(mergeFailed('the merge worker stopped')))
  worker.postMessage({ type: 'start', settings } satisfies MergeRequest)

  return {
    addFile(input) {
      if (failure !== null) return Promise.reject(failure)
      const id = nextId++
      const buffer = ownedBuffer(input.bytes)
      return new Promise<FileOutcome>((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        worker.postMessage({ type: 'file', id, day: input.day, bytes: new Uint8Array(buffer) } satisfies MergeRequest, [
          buffer,
        ])
      })
    },
    finish() {
      if (failure !== null) return Promise.reject(failure)
      return new Promise<MergeResult>((resolve, reject) => {
        finishing = { resolve, reject }
        worker.postMessage({ type: 'finish' } satisfies MergeRequest)
      })
    },
    abandon() {
      failAll(mergeFailed('the build stopped'))
    },
  }
}

export async function startMerge(settings: MergeSettings, memoryBytes: number): Promise<MergeSession> {
  const entry = resolveMergeWorkerEntry()
  if (entry === null) return inThreadSession(settings)
  const worker = await spawnNodeWorker(new URL(entry), {
    maxOldGenerationSizeMb: Math.max(1, Math.floor(memoryBytes / BYTES_PER_MIB)),
  })
  if (worker === null) return inThreadSession(settings)
  worker.unref?.()
  return workerSession(worker, settings)
}
